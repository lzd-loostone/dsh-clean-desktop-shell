/**
 * dsh-clean-desktop-shell — three-window task overlay.
 *
 *   orb     strip-sized always-on-top window docked at the nearest screen
 *           edge (circle center ON the edge line, half hidden). Slides fully
 *           out on hover; draggable; snaps to the nearest edge on release.
 *   bubble  opaque session-list card that opens on the inner side of the
 *           orb. Hover relay (orb ↔ bubble counts as one zone), state-change
 *           auto-pop with timeout collapse; every click inside collapses.
 *   menu    custom focusable context menu (blur closes it) with tray-parity
 *           backend actions; mutually exclusive with the bubble.
 *
 * The state file written by the cordis host half (~/.dsh/desktop-shell-state
 * .json) remains the ONLY input — no port, no token, no DSH transport.
 *
 * Geometry invariant: the orb window is the anchor. Bubble/menu are separate
 * windows positioned from it — expanding anything never moves the orb.
 *
 * config.overlay: { enabled, opacity, theme, fontSize, side, anchorY,
 *                   orbSize, bubbleTimeout }
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
const ROW_HEIGHT = 44
const HEADER_HEIGHT = 52
const PADDING = 18
const MAX_ROWS = 6
const ORB_MARGIN = 8 // ring/badge headroom inside the strip
const BUBBLE_CARD_W = 292
const BUB_MARGIN = 10 // transparent ring around the card (rounded corners)
const BUB_GAP = 6 // circle edge → card edge
const BUB_TOP_OFFSET = 8 // card top aligns with circle top
const BUBBLE_H_MAX = 480
const BUBBLE_H_MIN = 110
const MENU_W = 208
const MENU_ITEM_H = 36
const MENU_SEP_H = 9
const MENU_PAD = 8
const HOVER_IN_MS = 150
const HOVER_OUT_MS = 350
const UNDOCK_MS = 400
const SLIDE_MS = 140
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
let side = 'right' // docked edge
let anchorY = null // orb window top y; null → default near top
let docked = true // orb currently half-hidden
let dragging = false
let bubbleOpen = false
let openReason = null // 'hover' | 'auto'
let menuOpen = false
let hoverOrb = false
let hoverBubble = false

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

// ---------- geometry ----------

function orbArea(cfg) {
  return clamp(cfg.orbSize, 40, 96) + ORB_MARGIN * 2
}

function waFor() {
  if (overlayWin && !overlayWin.isDestroyed()) {
    const b = overlayWin.getBounds()
    return screen.getDisplayMatching({ x: b.x + Math.round(b.width / 2), y: b.y + Math.round(b.height / 2), width: 1, height: 1 }).workArea
  }
  return screen.getPrimaryDisplay().workArea
}

function orbY(cfg) {
  const wa = waFor()
  const s = orbArea(cfg)
  const y = anchorY === null ? wa.y + 16 : anchorY
  return clamp(Math.round(y), wa.y, Math.max(wa.y, wa.y + wa.height - s))
}

function orbOutX(cfg) {
  const wa = waFor()
  const s = orbArea(cfg)
  return side === 'right' ? wa.x + wa.width - s - 8 : wa.x + 8
}

function orbDockX(cfg) {
  const wa = waFor()
  const s = orbArea(cfg)
  // circle center exactly on the edge line → half visible, zero gap
  return side === 'right' ? wa.x + wa.width - Math.round(s / 2) : wa.x - Math.round(s / 2)
}

/** Animate the orb window's x between dock and out positions. */
function slideOrb(targetX, dur, easing, done) {
  if (!overlayWin || overlayWin.isDestroyed()) return
  if (slideTimer) clearInterval(slideTimer)
  const cfg = loadOverlay()
  const y = orbY(cfg)
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

function slideOut() {
  if (!overlayWin || overlayWin.isDestroyed() || dragging) return
  if (!docked && !slideTimer) return
  docked = false
  const cfg = loadOverlay()
  slideOrb(orbOutX(cfg), SLIDE_MS, easeOutCubic)
}

function scheduleUndock() {
  if (undockT) clearTimeout(undockT)
  undockT = setTimeout(() => {
    undockT = null
    if (hoverOrb || hoverBubble || bubbleOpen || menuOpen || dragging || docked) return
    docked = true
    const cfg = loadOverlay()
    slideOrb(orbDockX(cfg), SLIDE_MS, easeOutCubic)
  }, UNDOCK_MS)
}

function bubbleContentSize(full) {
  const rows = Math.max(1, Math.min(MAX_ROWS, full.rows.length))
  const cardH = clamp(HEADER_HEIGHT + PADDING + rows * ROW_HEIGHT + (full.rows.length > MAX_ROWS ? 22 : 0) + 8, BUBBLE_H_MIN, BUBBLE_H_MAX)
  return { w: BUBBLE_CARD_W + BUB_MARGIN * 2, h: cardH + BUB_MARGIN * 2 }
}

function bubbleBounds(cfg, full) {
  const s = orbArea(cfg)
  const { w, h } = bubbleContentSize(full)
  const wa = waFor()
  const outX = orbOutX(cfg)
  // card right/left edge sits BUB_GAP from the circle edge; the window adds
  // BUB_MARGIN of transparent padding around the card for the rounded corners.
  const winX = side === 'right' ? outX + 2 - (BUB_MARGIN + BUBBLE_CARD_W) : outX + s - 2 - BUB_MARGIN
  const winY = orbY(cfg) + BUB_TOP_OFFSET - BUB_MARGIN
  return {
    x: clamp(winX, wa.x, Math.max(wa.x, wa.x + wa.width - w)),
    y: clamp(winY, wa.y, Math.max(wa.y, wa.y + wa.height - h)),
    width: w,
    height: h,
  }
}

// ---------- bubble control ----------

function showBubble(reason) {
  if (!bubbleWin || bubbleWin.isDestroyed() || menuOpen) return
  const cfg = loadOverlay()
  const full = buildDisplay()
  if (!bubbleOpen) {
    bubbleOpen = true
    openReason = reason
    slideOut()
  }
  const b = bubbleBounds(cfg, full)
  bubbleWin.setBounds(b)
  bubbleWin.webContents.send('bubble:state', {
    mode: full.mode,
    runningCount: full.runningCount,
    rows: full.rows.slice(0, MAX_ROWS),
    more: Math.max(0, full.rows.length - MAX_ROWS),
    attention: full.attention,
    side,
    orbSize: cfg.orbSize,
  })
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
    slideOut()
    if (!bubbleOpen && !menuOpen && !hoverInT) {
      hoverInT = setTimeout(() => {
        hoverInT = null
        if ((hoverOrb || hoverBubble) && !bubbleOpen && !menuOpen) showBubble('hover')
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
  slideOut()
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

function sendDisplay() {
  if (!overlayWin || overlayWin.isDestroyed()) return
  const cfg = loadOverlay()
  const full = buildDisplay()
  const changed = attentionChanged(full)
  if (firstSnap) firstSnap = false
  else if (changed && !menuOpen && !bubbleOpen) showBubble('auto')
  else if (changed && bubbleOpen && openReason === 'auto') showBubble('auto') // reset timer
  overlayWin.webContents.send('overlay:state', {
    mode: full.mode,
    runningCount: full.runningCount,
    attention: full.attention,
  })
  if (bubbleOpen && bubbleWin && !bubbleWin.isDestroyed()) {
    bubbleWin.setBounds(bubbleBounds(cfg, full))
    bubbleWin.webContents.send('bubble:state', {
      mode: full.mode,
      runningCount: full.runningCount,
      rows: full.rows.slice(0, MAX_ROWS),
      more: Math.max(0, full.rows.length - MAX_ROWS),
      attention: full.attention,
      side,
      orbSize: cfg.orbSize,
    })
  }
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
  const s = orbArea(cfg)
  overlayWin.setBounds({ x: docked ? orbDockX(cfg) : orbOutX(cfg), y: orbY(cfg), width: s, height: s })
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
  const s = orbArea(cfg)
  overlayWin = new BrowserWindow({
    ...winBase(),
    width: s,
    height: s,
    x: orbDockX(cfg),
    y: orbY(cfg),
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
  const cfg = loadOverlay()
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

  ipcMain.on('overlay:orb-drag', (_e, d) => {
    if (!overlayWin || overlayWin.isDestroyed()) return
    const dx = d && Number.isFinite(d.dx) ? d.dx : 0
    const dy = d && Number.isFinite(d.dy) ? d.dy : 0
    if (!dx && !dy) return
    if (!dragging) {
      dragging = true
      if (slideTimer) { clearInterval(slideTimer); slideTimer = null }
      if (bubbleOpen) closeBubble()
    }
    const cfg = loadOverlay()
    const s = orbArea(cfg)
    const b = overlayWin.getBounds()
    const bb = screen.getDisplayNearestPoint({ x: b.x + Math.round(s / 2), y: b.y + Math.round(s / 2) }).bounds
    overlayWin.setPosition(
      clamp(b.x + dx, bb.x - s + 60, bb.x + bb.width - 60),
      clamp(b.y + dy, bb.y, Math.max(bb.y, bb.y + bb.height - s)),
    )
  })

  ipcMain.on('overlay:orb-drag-end', () => {
    if (!overlayWin || overlayWin.isDestroyed()) return
    dragging = false
    const cfg = loadOverlay()
    const s = orbArea(cfg)
    const b = overlayWin.getBounds()
    const bb = screen.getDisplayNearestPoint({ x: b.x + Math.round(s / 2), y: b.y + Math.round(s / 2) }).bounds
    side = b.x + Math.round(s / 2) < bb.x + Math.round(bb.width / 2) ? 'left' : 'right'
    anchorY = b.y
    saveOverlay({ side, anchorY })
    docked = true
    slideOrb(orbDockX(cfg), SNAP_MS, easeOutBack)
  })

  ipcMain.on('overlay:orb-click', () => {
    trace('orb-click')
    if (bubbleOpen) closeBubble()
    focusMain()
  })

  ipcMain.on('overlay:orb-context', (_e, p) => {
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) openMenu(Math.round(p.x), Math.round(p.y))
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

  ipcMain.handle('overlay:settings-get', () => loadOverlay())

  ipcMain.on('overlay:settings-set', (_e, patch) => {
    saveOverlay(patch && typeof patch === 'object' ? patch : {})
    applyOverlayConfig()
  })

  ipcMain.on('overlay:settings-reset-pos', () => {
    resetOverlayPosition()
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
    return
  }
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
    width: 360,
    height: 560,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: '悬浮窗设置',
    backgroundColor: '#10131A',
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
  side = 'right'
  anchorY = null
  docked = true
  saveOverlay({ side: 'right', anchorY: null })
  if (overlayWin && !overlayWin.isDestroyed()) {
    const cfg = loadOverlay()
    const s = orbArea(cfg)
    overlayWin.setBounds({ x: orbDockX(cfg), y: orbY(cfg), width: s, height: s })
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
