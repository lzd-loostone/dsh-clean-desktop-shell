/**
 * dsh-clean-desktop-shell — three-window task overlay (container model).
 *
 *   orb     s×s window that NEVER leaves its monitor's work area. The whale
 *           circle slides INSIDE the container (CSS translateX) to hide half
 *           of itself at the docked edge — the window itself stays put, so
 *           display detection never straddles a monitor boundary, a second
 *           screen can never show a clipped half-orb, and the bubble always
 *           anchors to the orb's own monitor.
 *   bubble  session-list card window anchored to the orb container rect.
 *           Height is measured by the renderer and reported back (the main
 *           process formula is only the first-frame estimate).
 *   menu    custom context menu (focusable, blur-closes).
 *
 * Dragging is main-process cursor-driven: the renderer only signals
 * start/tick/up; the main process reads screen.getCursorScreenPoint()
 * (true DIP, same space as setPosition — immune to per-monitor DPI scaling)
 * and clamps against the CURSOR's display, so the orb can be dragged across
 * monitors in both directions.
 *
 * config.overlay: { enabled, opacity, theme, fontSize, side, anchorY, pos,
 *                   orbSize, bubbleTimeout, edgeSnap }
 */
import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { existsSync, readFileSync, unwatchFile, watchFile, appendFileSync, statSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadOverlay, saveOverlay } from './config.js'
import { getStatus } from './service.js'
import { startBackend, restartBackend, stopBackend } from './backend-actions.js'

const PRELOAD = fileURLToPath(new URL('./overlay-preload.js', import.meta.url))
const PAGE = fileURLToPath(new URL('./overlay.html', import.meta.url))
const BUBBLE_PRELOAD = fileURLToPath(new URL('./bubble-preload.js', import.meta.url))
const BUBBLE_PAGE = fileURLToPath(new URL('./bubble.html', import.meta.url))
const MENU_PRELOAD = fileURLToPath(new URL('./menu-preload.js', import.meta.url))
const MENU_PAGE = fileURLToPath(new URL('./menu.html', import.meta.url))
const SETTINGS_PRELOAD = fileURLToPath(new URL('./overlay-settings-preload.js', import.meta.url))
const SETTINGS_PAGE = fileURLToPath(new URL('./overlay-settings.html', import.meta.url))

// A fresh snapshot is rewritten by the backend at least every 5s; past this
// window the writer is gone (backend stopped/crashed) → the orb goes grey.
const STALE_MS = 12000
const MAX_ROWS = 6
const ORB_MARGIN = 8 // ring/badge headroom inside the container
const BUBBLE_CARD_W = 292
const BUB_MARGIN = 10 // transparent ring around the card (rounded corners)
const BUB_GAP = 6 // circle edge → card edge
const BUB_TOP_OFFSET = 8 // card top aligns with circle top
const BUBBLE_H_MAX = 480
const BUBBLE_H_MIN = 96
// First-frame card-height estimate — must track bubble.html's CSS:
// bar 3 + bhead 40; rows 42 each + 2/8 padding; empty block 44+10; more 26.
const EST_HEAD_H = 43
const EST_ROW_H = 42
const EST_ROWS_PAD = 8
const EST_EMPTY_H = 54
const EST_MORE_H = 26
const EST_SLACK = 2
const MENU_W = 208
const MENU_ITEM_H = 36
const MENU_SEP_H = 9
const MENU_PAD = 8
const HOVER_IN_MS = 150
const HOVER_OUT_MS = 350
const UNDOCK_MS = 400
const SNAP_MS = 220
const BUBBLE_OUT_MS = 115

let overlayWin = null
let bubbleWin = null
let menuWin = null
let settingsWin = null
let getMainWindow = null
let watching = false
let ipcReady = false
let snap = null
let staleTimer = null
const prevRunning = new Map()
const unread = new Map()
const lastKind = {}
let firstSnap = true

// interaction state (main process is the single authority)
let side = 'right' // docked edge (edgeSnap mode)
let anchorY = null // orb window top y in snap mode; null → default near top
let pos = null // free {x,y} window origin (edgeSnap=false)
let docked = true // whale currently half-hidden inside the container
let dragging = false
let dragMoved = false
let dragGrab = { gx: 0, gy: 0 }
let dragStartPt = { x: 0, y: 0 }
let bubbleOpen = false
let openReason = null // 'hover' | 'auto'
let menuOpen = false
let hoverOrb = false
let hoverBubble = false
let lastEdgeSnap = null

let slideTimer = null
let hoverInT = null
let closeT = null
let autoT = null
let undockT = null

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi)
}
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3)
const easeOutBack = (t) => {
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
}

function stateFile() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'desktop-shell-state.json')
}

/** Deep-link tracing: every row-click hop (main/preload/client) appends a
 *  line here so a jump failure pinpoints its broken stage. */
function traceFile() {
  return join(app.getPath('userData'), 'overlay-trace.log')
}
function trace(msg) {
  try {
    const f = traceFile()
    try {
      if (statSync(f).size > 256 * 1024) rmSync(f, { force: true }) // rolling cap
    } catch { /* first write */ }
    appendFileSync(f, new Date().toISOString() + ' ' + msg + '\n', 'utf8')
  } catch { /* tracing must never break the overlay */ }
}

// ---------- display derivation ----------

function applySnapshot(next) {
  const list = next && Array.isArray(next.sessions) ? next.sessions : []
  for (const s of list) {
    const was = prevRunning.get(s.id) === true
    if (was && !s.running) {
      unread.set(s.id, { name: s.name, at: s.finishedAt || Date.now() })
    }
    if (unread.has(s.id) && s.name) unread.get(s.id).name = s.name
    if (s.running) prevRunning.set(s.id, true)
    else prevRunning.delete(s.id)
  }
  snap = next
  sendDisplay()
}

function buildDisplay() {
  const now = Date.now()
  let mode = 'idle'
  const list = snap && Array.isArray(snap.sessions) ? snap.sessions : []
  if (!existsSync(stateFile())) mode = 'missing'
  else if (!snap || snap.disposed || now - (snap.ts || 0) > STALE_MS) mode = 'offline'

  const rows = []
  const seen = new Set()
  for (const s of list) {
    seen.add(s.id)
    if (s.approvals > 0) rows.push({ id: s.id, name: s.name, kind: 'approval', at: s.lastChangeAt })
    else if (s.questions > 0) rows.push({ id: s.id, name: s.name, kind: 'question', at: s.lastChangeAt })
    else if (s.running) rows.push({ id: s.id, name: s.name, kind: 'running', at: s.startedAt || s.lastChangeAt })
  }
  const runningCount = rows.length
  for (const [id, u] of unread) {
    if (seen.has(id) && list.find((s) => s.id === id && (s.running || s.approvals > 0 || s.questions > 0))) continue
    rows.push({ id, name: u.name, kind: 'done', at: u.at })
  }
  const order = { approval: 0, question: 1, running: 2, done: 3 }
  rows.sort((a, b) => (order[a.kind] - order[b.kind]) || (b.at - a.at))

  if (mode === 'idle' || mode === 'active') mode = runningCount === 0 ? 'idle' : 'active'
  const attention = {
    approval: rows.some((r) => r.kind === 'approval'),
    question: rows.some((r) => r.kind === 'question'),
    unread: rows.some((r) => r.kind === 'done'),
  }
  return { mode, runningCount, rows, attention, now }
}

/** True when a row entered an attention kind since the last tick. */
function attentionChanged(full) {
  let changed = false
  const flash = { approval: true, question: true, done: true }
  for (const r of full.rows) {
    if (flash[r.kind] && lastKind[r.id] !== r.kind) changed = true
    lastKind[r.id] = r.kind
  }
  return changed
}

// ---------- geometry (window always fully inside its work area) ----------

function orbArea(cfg) {
  return clamp(cfg.orbSize, 40, 96) + ORB_MARGIN * 2
}

function waFor() {
  if (overlayWin && !overlayWin.isDestroyed()) {
    const b = overlayWin.getBounds()
    // The window never straddles a boundary, so its center is always
    // unambiguously inside one display — no adjacent-monitor flip.
    return screen.getDisplayMatching({ x: b.x + Math.round(b.width / 2), y: b.y + Math.round(b.height / 2), width: 1, height: 1 }).workArea
  }
  return screen.getPrimaryDisplay().workArea
}

function orbWinX(cfg, wa) {
  const s = orbArea(cfg)
  if (cfg.edgeSnap) return side === 'right' ? wa.x + wa.width - s : wa.x
  const px = pos && Number.isFinite(pos.x) ? pos.x : wa.x + wa.width - s
  return clamp(Math.round(px), wa.x, Math.max(wa.x, wa.x + wa.width - s))
}

function orbWinY(cfg, wa) {
  const s = orbArea(cfg)
  let y = cfg.edgeSnap ? anchorY : (pos && Number.isFinite(pos.y) ? pos.y : anchorY)
  if (y === null || y === undefined) y = wa.y + 16
  return clamp(Math.round(y), wa.y, Math.max(wa.y, wa.y + wa.height - s))
}

/** Slide the orb WINDOW horizontally (used only when a snap changes the
 *  docked edge — the dock/undock motion itself is pure CSS inside). */
function slideOrb(targetX, dur, easing, done) {
  if (!overlayWin || overlayWin.isDestroyed()) return
  if (slideTimer) clearInterval(slideTimer)
  const cfg = loadOverlay()
  const y = orbWinY(cfg, waFor())
  const startX = overlayWin.getBounds().x
  if (startX === targetX) { overlayWin.setPosition(startX, y); done && done(); return }
  const t0 = Date.now()
  slideTimer = setInterval(() => {
    if (!overlayWin || overlayWin.isDestroyed()) { clearInterval(slideTimer); slideTimer = null; return }
    let t = (Date.now() - t0) / dur
    if (t >= 1) t = 1
    overlayWin.setPosition(Math.round(startX + (targetX - startX) * easing(t)), y)
    if (t >= 1) { clearInterval(slideTimer); slideTimer = null; done && done() }
  }, 16)
}

/** Dock/undock = whale transform inside the container (renderer animates). */
function setDocked(v) {
  const cfg = loadOverlay()
  const want = cfg.edgeSnap ? v : false
  if (docked === want) return
  docked = want
  sendOrbState(buildDisplay())
}

function scheduleUndock() {
  if (!loadOverlay().edgeSnap) return
  if (undockT) clearTimeout(undockT)
  undockT = setTimeout(() => {
    undockT = null
    if (hoverOrb || hoverBubble || bubbleOpen || menuOpen || dragging || docked) return
    setDocked(true)
  }, UNDOCK_MS)
}

// ---------- bubble geometry & height ----------

function contentSig(full) {
  return full.mode + ':' + Math.min(MAX_ROWS, full.rows.length) + (full.rows.length > MAX_ROWS ? '+' : '')
}

function estimateCardH(full) {
  const n = Math.min(MAX_ROWS, full.rows.length)
  const bodyH = n === 0 ? EST_EMPTY_H : n * EST_ROW_H + EST_ROWS_PAD
  const moreH = full.rows.length > MAX_ROWS ? EST_MORE_H : 0
  return clamp(EST_HEAD_H + bodyH + moreH + EST_SLACK, BUBBLE_H_MIN, BUBBLE_H_MAX)
}

let bubSig = ''
let bubMeasuredH = 0 // window height last measured by the renderer

function bubbleHeightFor(full) {
  if (contentSig(full) === bubSig && bubMeasuredH > 0) return bubMeasuredH
  return estimateCardH(full) + BUB_MARGIN * 2
}

/** Which side of the orb the card opens on: docked → inward; free → prefer
 *  right, flip left when the right side cannot fit it. */
function bubbleSideFor(cfg, wa, ox, s) {
  if (cfg.edgeSnap) return side === 'right' ? 'left' : 'right'
  const need = BUBBLE_CARD_W + BUB_MARGIN * 2 + BUB_GAP
  return ox + s + need <= wa.x + wa.width ? 'right' : 'left'
}

function bubbleBounds(cfg, full) {
  const s = orbArea(cfg)
  const wa = waFor()
  const ox = orbWinX(cfg, wa)
  const oy = orbWinY(cfg, wa)
  const w = BUBBLE_CARD_W + BUB_MARGIN * 2
  const h = bubbleHeightFor(full)
  const bside = bubbleSideFor(cfg, wa, ox, s)
  // Card edge sits BUB_GAP from the (fully-out) circle edge; the window adds
  // BUB_MARGIN of transparent padding around the card for the rounded corners.
  const winX = bside === 'left'
    ? ox + ORB_MARGIN - BUB_GAP - BUBBLE_CARD_W - BUB_MARGIN
    : ox + s - ORB_MARGIN + BUB_GAP - BUB_MARGIN
  const winY = oy + BUB_TOP_OFFSET - BUB_MARGIN
  return {
    x: clamp(winX, wa.x, Math.max(wa.x, wa.x + wa.width - w)),
    y: clamp(winY, wa.y, Math.max(wa.y, wa.y + wa.height - h)),
    width: w,
    height: h,
    bside,
  }
}

// ---------- bubble control ----------

function pushBubble(full, cfg) {
  if (!bubbleOpen || !bubbleWin || bubbleWin.isDestroyed()) return
  const b = bubbleBounds(cfg, full)
  bubSig = contentSig(full)
  bubbleWin.setBounds(b)
  bubbleWin.webContents.send('bubble:state', {
    mode: full.mode,
    runningCount: full.runningCount,
    rows: full.rows.slice(0, MAX_ROWS),
    more: Math.max(0, full.rows.length - MAX_ROWS),
    attention: full.attention,
    bubbleSide: b.bside,
    orbSize: cfg.orbSize,
  })
}

function showBubble(reason) {
  if (!bubbleWin || bubbleWin.isDestroyed() || menuOpen || dragging) return
  const cfg = loadOverlay()
  const full = buildDisplay()
  if (!bubbleOpen) {
    bubbleOpen = true
    openReason = reason
    setDocked(false)
  }
  pushBubble(full, cfg)
  bubbleWin.showInactive()
  if (reason === 'auto') {
    if (autoT) clearTimeout(autoT)
    autoT = setTimeout(() => {
      autoT = null
      if (!hoverOrb && !hoverBubble) closeBubble()
    }, cfg.bubbleTimeout)
  }
}

function closeBubble() {
  if (autoT) { clearTimeout(autoT); autoT = null }
  if (closeT) { clearTimeout(closeT); closeT = null }
  if (!bubbleOpen) { scheduleUndock(); return }
  bubbleOpen = false
  openReason = null
  if (bubbleWin && !bubbleWin.isDestroyed()) {
    bubbleWin.webContents.send('bubble:hide')
    setTimeout(() => {
      if (!bubbleOpen && bubbleWin && !bubbleWin.isDestroyed()) bubbleWin.hide()
    }, BUBBLE_OUT_MS)
  }
  scheduleUndock()
}

function setHover(which, v) {
  if (which === 'orb') hoverOrb = v
  else hoverBubble = v
  const any = hoverOrb || hoverBubble
  if (any) {
    if (undockT) { clearTimeout(undockT); undockT = null }
    if (closeT) { clearTimeout(closeT); closeT = null }
    setDocked(false)
    if (!bubbleOpen && !menuOpen && !hoverInT) {
      hoverInT = setTimeout(() => {
        hoverInT = null
        if ((hoverOrb || hoverBubble) && !bubbleOpen && !menuOpen && !dragging) showBubble('hover')
      }, HOVER_IN_MS)
    }
  } else {
    if (hoverInT) { clearTimeout(hoverInT); hoverInT = null }
    if (bubbleOpen && openReason === 'hover') {
      closeT = setTimeout(() => {
        closeT = null
        if (!(hoverOrb || hoverBubble)) closeBubble()
      }, HOVER_OUT_MS)
    }
    scheduleUndock()
  }
}

// ---------- menu control ----------

function backendOnline() {
  const st = getStatus()
  return st.status === 'running' || st.status === 'starting'
}

function openMenu(cx, cy) {
  if (!menuWin || menuWin.isDestroyed()) return
  if (bubbleOpen) closeBubble()
  menuOpen = true
  if (undockT) { clearTimeout(undockT); undockT = null }
  setDocked(false)
  const online = backendOnline()
  const items = online ? 4 : 3
  const h = MENU_PAD * 2 + items * MENU_ITEM_H + 2 * MENU_SEP_H
  const wa = waFor()
  let x = cx + 4
  let y = cy + 4
  if (x + MENU_W > wa.x + wa.width) x = cx - MENU_W - 4
  if (y + h > wa.y + wa.height) y = cy - h - 4
  x = clamp(x, wa.x, wa.x + wa.width - MENU_W)
  y = clamp(y, wa.y, wa.y + wa.height - h)
  menuWin.setBounds({ x: Math.round(x), y: Math.round(y), width: MENU_W, height: h })
  menuWin.webContents.send('menu:state', { online })
  menuWin.show()
  menuWin.focus()
}

function closeMenu() {
  if (!menuOpen) return
  menuOpen = false
  if (menuWin && !menuWin.isDestroyed() && menuWin.isVisible()) menuWin.hide()
  if (!hoverOrb && !hoverBubble) scheduleUndock()
}

// ---------- senders ----------

function sendOrbState(full) {
  if (!overlayWin || overlayWin.isDestroyed()) return
  overlayWin.webContents.send('overlay:state', {
    side,
    docked,
    edgeSnap: loadOverlay().edgeSnap,
    mode: full.mode,
    runningCount: full.runningCount,
    attention: full.attention,
  })
}

function sendDisplay() {
  if (!overlayWin || overlayWin.isDestroyed()) return
  const cfg = loadOverlay()
  const full = buildDisplay()
  const changed = attentionChanged(full)
  if (firstSnap) firstSnap = false
  else if (changed && !menuOpen && !bubbleOpen) showBubble('auto')
  else if (changed && bubbleOpen && openReason === 'auto') showBubble('auto') // reset timer
  sendOrbState(full)
  pushBubble(full, cfg)
}

function sendConfig() {
  const cfg = loadOverlay()
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send('overlay:config', { opacity: cfg.opacity, theme: cfg.theme, fontSize: cfg.fontSize, orbSize: cfg.orbSize })
  }
  if (bubbleWin && !bubbleWin.isDestroyed()) {
    bubbleWin.webContents.send('bubble:config', { opacity: cfg.opacity, theme: cfg.theme, fontSize: cfg.fontSize })
  }
  if (menuWin && !menuWin.isDestroyed()) {
    menuWin.webContents.send('menu:config', { theme: cfg.theme, fontSize: cfg.fontSize })
  }
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('overlay:config', cfg)
}

/** Re-apply the orb rect (after orbSize change / reset / first show). */
function syncOrbBounds() {
  if (!overlayWin || overlayWin.isDestroyed() || dragging || slideTimer) return
  const cfg = loadOverlay()
  const wa = waFor()
  const s = orbArea(cfg)
  overlayWin.setBounds({ x: orbWinX(cfg, wa), y: orbWinY(cfg, wa), width: s, height: s })
}

// ---------- state file watching ----------

function readStateFile() {
  try {
    applySnapshot(JSON.parse(readFileSync(stateFile(), 'utf8')))
  } catch {
    snap = null
    sendDisplay()
  }
}

function startWatching() {
  if (watching) return
  watching = true
  watchFile(stateFile(), { interval: 1000 }, () => readStateFile())
  readStateFile()
  staleTimer = setInterval(sendDisplay, 2000)
}

function stopWatching() {
  if (watching) return
  watching = false
  unwatchFile(stateFile())
  if (staleTimer) clearInterval(staleTimer)
  staleTimer = null
}

// ---------- windows ----------

function winBase() {
  return {
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
  }
}

function createOrbWindow() {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin
  const cfg = loadOverlay()
  side = cfg.side
  anchorY = cfg.anchorY
  pos = cfg.pos && Number.isFinite(cfg.pos.x) ? { x: cfg.pos.x, y: cfg.pos.y } : null
  docked = cfg.edgeSnap
  const wa = waFor()
  const s = orbArea(cfg)
  overlayWin = new BrowserWindow({
    ...winBase(),
    width: s,
    height: s,
    x: orbWinX(cfg, wa),
    y: orbWinY(cfg, wa),
    focusable: false, // never steals the keyboard — it is an OSD, not a dialog
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  overlayWin.setAlwaysOnTop(true, 'screen-saver')
  overlayWin.loadFile(PAGE)
  overlayWin.on('closed', () => { overlayWin = null })
  overlayWin.showInactive()
  return overlayWin
}

function createBubbleWindow() {
  if (bubbleWin && !bubbleWin.isDestroyed()) return bubbleWin
  bubbleWin = new BrowserWindow({
    ...winBase(),
    width: BUBBLE_CARD_W + BUB_MARGIN * 2,
    height: BUBBLE_H_MIN + BUB_MARGIN * 2,
    x: -BUBBLE_CARD_W * 2,
    y: -BUBBLE_H_MIN * 2,
    focusable: false,
    webPreferences: { preload: BUBBLE_PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  bubbleWin.setAlwaysOnTop(true, 'screen-saver')
  bubbleWin.loadFile(BUBBLE_PAGE)
  bubbleWin.on('closed', () => { bubbleWin = null })
  return bubbleWin
}

function createMenuWindow() {
  if (menuWin && !menuWin.isDestroyed()) return menuWin
  menuWin = new BrowserWindow({
    ...winBase(),
    width: MENU_W,
    height: 200,
    x: -2000,
    y: -2000,
    focusable: true, // it is a menu: it must take focus and close on blur
    webPreferences: { preload: MENU_PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  menuWin.setAlwaysOnTop(true, 'screen-saver')
  menuWin.loadFile(MENU_PAGE)
  menuWin.on('blur', () => closeMenu())
  menuWin.on('closed', () => { menuWin = null })
  return menuWin
}

// ---------- ipc ----------

function registerIpc() {
  if (ipcReady) return
  ipcReady = true

  ipcMain.on('overlay:ready', () => { sendConfig(); sendDisplay() })
  ipcMain.on('bubble:ready', () => { sendConfig(); if (bubbleOpen) sendDisplay() })
  ipcMain.on('menu:ready', () => { sendConfig() })
  ipcMain.on('shell:trace', (_e, msg) => trace(String(msg).slice(0, 300)))

  ipcMain.on('overlay:orb-hover', (_e, v) => setHover('orb', !!v))
  ipcMain.on('bubble:hover', (_e, v) => setHover('bubble', !!v))

  // Cursor-driven drag: the renderer sends NO coordinates (per-monitor DPI
  // makes renderer screen coords unreliable); everything is computed from
  // screen.getCursorScreenPoint(), which shares setPosition's DIP space.
  ipcMain.on('overlay:orb-drag-start', () => {
    if (!overlayWin || overlayWin.isDestroyed()) return
    dragging = true
    dragMoved = false
    if (slideTimer) { clearInterval(slideTimer); slideTimer = null }
    if (bubbleOpen) closeBubble()
    setDocked(false) // whale fully visible while being carried
    const p = screen.getCursorScreenPoint()
    const b = overlayWin.getBounds()
    dragGrab = { gx: p.x - b.x, gy: p.y - b.y }
    dragStartPt = p
  })

  ipcMain.on('overlay:orb-drag-tick', () => {
    if (!overlayWin || overlayWin.isDestroyed() || !dragging) return
    const p = screen.getCursorScreenPoint()
    if (!dragMoved && Math.abs(p.x - dragStartPt.x) + Math.abs(p.y - dragStartPt.y) <= 4) return
    dragMoved = true
    const cfg = loadOverlay()
    const s = orbArea(cfg)
    // Clamp against the CURSOR's display → dragging across the boundary
    // carries the whole window onto the neighbouring monitor (both ways).
    const wa = screen.getDisplayNearestPoint(p).workArea
    overlayWin.setPosition(
      clamp(p.x - dragGrab.gx, wa.x, Math.max(wa.x, wa.x + wa.width - s)),
      clamp(p.y - dragGrab.gy, wa.y, Math.max(wa.y, wa.y + wa.height - s)),
    )
  })

  ipcMain.on('overlay:orb-drag-up', () => {
    if (!overlayWin || overlayWin.isDestroyed() || !dragging) return
    dragging = false
    const cfg = loadOverlay()
    const s = orbArea(cfg)
    const b = overlayWin.getBounds()
    if (!dragMoved) {
      trace('orb-click')
      if (bubbleOpen) closeBubble()
      focusMain()
      return
    }
    if (cfg.edgeSnap) {
      const wa = waFor()
      side = b.x + Math.round(s / 2) < wa.x + Math.round(wa.width / 2) ? 'left' : 'right'
      anchorY = b.y
      saveOverlay({ side, anchorY })
      docked = true
      sendOrbState(buildDisplay())
      slideOrb(orbWinX(cfg, wa), SNAP_MS, easeOutBack)
    } else {
      pos = { x: b.x, y: b.y }
      saveOverlay({ pos })
      docked = false
      sendOrbState(buildDisplay())
    }
  })

  ipcMain.on('overlay:orb-context', () => {
    const p = screen.getCursorScreenPoint()
    openMenu(p.x, p.y)
  })

  ipcMain.on('bubble:row', (_e, id) => {
    trace('row-click ' + JSON.stringify(id))
    if (typeof id === 'string' && unread.has(id)) unread.delete(id)
    closeBubble()
    focusMain(id)
  })

  ipcMain.on('bubble:blank', () => {
    closeBubble()
    focusMain()
  })

  // The card page measures its own content and reports the needed height,
  // so the bubble never shows dead space below the list.
  ipcMain.on('bubble:size', (_e, h) => {
    if (!bubbleWin || bubbleWin.isDestroyed() || !Number.isFinite(h)) return
    const want = clamp(Math.round(h) + BUB_MARGIN * 2, BUBBLE_H_MIN, BUBBLE_H_MAX)
    bubMeasuredH = want
    const cur = bubbleWin.getBounds()
    if (Math.abs(cur.height - want) > 1) {
      const wa = waFor()
      bubbleWin.setBounds({ x: cur.x, y: clamp(cur.y, wa.y, Math.max(wa.y, wa.y + wa.height - want)), width: cur.width, height: want })
    }
  })

  ipcMain.handle('overlay:settings-get', () => loadOverlay())

  ipcMain.on('overlay:settings-set', (_e, patch) => {
    saveOverlay(patch && typeof patch === 'object' ? patch : {})
    applyOverlayConfig()
  })

  ipcMain.on('overlay:settings-reset-pos', () => {
    resetOverlayPosition()
  })

  // The page measures its own content and reports the needed height, so
  // the frameless card never shows dead space.
  ipcMain.on('overlay:settings-size', (_e, h) => {
    if (!settingsWin || settingsWin.isDestroyed() || !Number.isFinite(h)) return
    settingsWin.setContentSize(344, clamp(Math.round(h), 360, 720))
  })

  ipcMain.on('overlay:settings-close', () => {
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close()
  })

  ipcMain.on('menu:action', (_e, id) => {
    closeMenu()
    if (id === 'refresh') {
      const main = getMainWindow && getMainWindow()
      if (main && !main.isDestroyed()) main.webContents.reload()
    } else if (id === 'start') startBackend()
    else if (id === 'restart') restartBackend()
    else if (id === 'stop') stopBackend()
    else if (id === 'settings') openOverlaySettings()
  })

  ipcMain.on('menu:close', () => closeMenu())
}

/** Raise and focus the main window; optionally route to a session. */
function focusMain(sessionId) {
  const main = getMainWindow && getMainWindow()
  if (!main || main.isDestroyed()) return
  if (main.isMinimized()) main.restore()
  main.show()
  main.focus()
  if (typeof sessionId === 'string') {
    // Hand the session id to the page; the client plugin routes it to
    // the documented ctx.sessions.open() command (see src/client.js).
    try { main.webContents.send('shell:goto-session', sessionId); trace('sent goto ' + sessionId) } catch (err) { trace('send failed: ' + (err && err.message)) }
  }
}

// ---------- public API ----------

/** Wire the overlay to the app; call once from main after windows exist. */
export function initOverlay({ getMainWindow: provider }) {
  getMainWindow = provider
  registerIpc()
}

/** Reconcile windows/watchers with the persisted config. */
export function applyOverlayConfig() {
  const cfg = loadOverlay()
  side = cfg.side
  anchorY = cfg.anchorY
  pos = cfg.pos && Number.isFinite(cfg.pos.x) ? { x: cfg.pos.x, y: cfg.pos.y } : null
  if (!cfg.enabled) {
    stopWatching()
    closeBubble()
    closeMenu()
    for (const w of [bubbleWin, menuWin, overlayWin]) {
      if (w && !w.isDestroyed()) w.close()
    }
    overlayWin = null
    bubbleWin = null
    menuWin = null
    lastEdgeSnap = null
    return
  }
  // edgeSnap flip: hand the position over between the two models.
  if (lastEdgeSnap !== null && lastEdgeSnap !== cfg.edgeSnap && overlayWin && !overlayWin.isDestroyed()) {
    const b = overlayWin.getBounds()
    if (cfg.edgeSnap) {
      const wa = waFor()
      side = b.x + Math.round(b.width / 2) < wa.x + Math.round(wa.width / 2) ? 'left' : 'right'
      anchorY = b.y
      pos = null
      saveOverlay({ side, anchorY, pos })
      docked = true
    } else {
      pos = { x: b.x, y: b.y }
      saveOverlay({ pos })
      docked = false
    }
  }
  lastEdgeSnap = cfg.edgeSnap
  createOrbWindow()
  createBubbleWindow()
  createMenuWindow()
  sendConfig()
  startWatching()
  syncOrbBounds()
  sendDisplay()
}

/** Open (or focus) the small settings window from the tray. */
export function openOverlaySettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show()
    settingsWin.focus()
    return settingsWin
  }
  settingsWin = new BrowserWindow({
    width: 344,
    height: 480,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    transparent: true,
    skipTaskbar: true,
    hasShadow: false,
    title: '悬浮球设置',
    backgroundColor: '#00000000',
    autoHideMenuBar: true,
    webPreferences: {
      preload: SETTINGS_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  settingsWin.loadFile(SETTINGS_PAGE)
  settingsWin.once('ready-to-show', () => settingsWin.show())
  settingsWin.on('closed', () => { settingsWin = null })
  return settingsWin
}

/** Reset the overlay position to the default corner (tray/settings action). */
export function resetOverlayPosition() {
  closeBubble()
  closeMenu()
  const cfg = loadOverlay()
  side = 'right'
  anchorY = null
  const wa = waFor()
  pos = cfg.edgeSnap ? null : { x: wa.x + wa.width - orbArea(cfg), y: wa.y + 16 }
  docked = cfg.edgeSnap
  saveOverlay({ side, anchorY, pos })
  if (overlayWin && !overlayWin.isDestroyed()) {
    const s = orbArea(cfg)
    overlayWin.setBounds({ x: orbWinX(cfg, wa), y: orbWinY(cfg, wa), width: s, height: s })
  }
  sendDisplay()
}

/** Release watchers (called on app quit). */
export function disposeOverlay() {
  stopWatching()
  if (slideTimer) clearInterval(slideTimer)
  for (const t of [hoverInT, closeT, autoT, undockT]) if (t) clearTimeout(t)
  unread.clear()
  prevRunning.clear()
}
