/**
 * dsh-clean-desktop-shell — task orb + bubble overlay (host-of-window half).
 *
 * One always-on-top transparent window morphing between two states:
 *
 *   collapsed  a small orb (whale icon; spinning light ring + count badge
 *              while sessions run; attention dot for approval / question /
 *              unread-done; grey while the backend is stale/missing);
 *   expanded   the orb plus a bubble card listing every active session —
 *              the same rows, flash cues and click-to-jump semantics the
 *              old full-card overlay had.
 *
 * The state file written by the cordis host half (~/.dsh/desktop-shell-state
 * .json) remains the ONLY input — no port, no token, no DSH transport.
 *
 * Interaction contract (renderer drives, this process owns geometry):
 *   overlay:set-expanded  renderer hover/state-change → grow or shrink the
 *                         window around the orb anchor
 *   overlay:orb-drag      manual orb dragging (pointer deltas; the window is
 *                         focusable:false so OS drag regions cannot coexist
 *                         with clicks) — anchor persisted on orb-drag-end
 *   overlay:orb-click     raise + focus the main window, collapse
 *   overlay:row-click     jump to that session, clear its unread mark
 *
 * config.overlay: { enabled, opacity, theme, fontSize, pos, orbSize,
 *                   bubbleTimeout }
 */
import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { existsSync, readFileSync, unwatchFile, watchFile, appendFileSync, statSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadOverlay, saveOverlay } from './config.js'

const PRELOAD = fileURLToPath(new URL('./overlay-preload.js', import.meta.url))
const PAGE = fileURLToPath(new URL('./overlay.html', import.meta.url))
const SETTINGS_PRELOAD = fileURLToPath(new URL('./overlay-settings-preload.js', import.meta.url))
const SETTINGS_PAGE = fileURLToPath(new URL('./overlay-settings.html', import.meta.url))

// A fresh snapshot is rewritten by the backend at least every 5s; past this
// window the writer is gone (backend stopped/crashed) → the orb goes grey.
const STALE_MS = 12000
const ROW_HEIGHT = 44
const HEADER_HEIGHT = 52
const PADDING = 18
const MAX_ROWS = 6
const ORB_MARGIN = 8 // per side: ring glow + badge overhead headroom
const BUBBLE_W = 300 // bubble column width in the expanded window
const BUBBLE_H_MAX = 480
const BUBBLE_H_MIN = 110

let overlayWin = null
let settingsWin = null
let getMainWindow = null
let watching = false
let ipcReady = false
let snap = null
let staleTimer = null
const prevRunning = new Map()
const unread = new Map()
let expanded = false // renderer keeps the authority; this mirrors geometry
let lastSide = 'left' // bubble placed left of the orb
let dragging = false

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi)
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
  rows.sort((a, b) => order[a.kind] - order[b.kind] || b.at - a.at)

  if (mode === 'idle' || mode === 'active') {
    if (runningCount === 0) mode = 'idle'
    else mode = 'active'
  }
  const attention = {
    approval: rows.some((r) => r.kind === 'approval'),
    question: rows.some((r) => r.kind === 'question'),
    unread: rows.some((r) => r.kind === 'done'),
  }
  return { mode, runningCount, rows, attention, now }
}

// ---------- geometry ----------

function orbArea(cfg) {
  return clamp(cfg.orbSize, 40, 96) + ORB_MARGIN * 2
}

function anchorPos(cfg) {
  if (cfg.pos) return { x: cfg.pos.x, y: cfg.pos.y }
  const wa = screen.getPrimaryDisplay().workArea
  return { x: wa.x + wa.width - orbArea(cfg) - 16, y: wa.y + 16 }
}

function clampToVisuals(x, y, cfg) {
  const d = screen.getDisplayNearestPoint({ x, y })
  const wa = d.workArea
  const s = orbArea(cfg)
  return {
    x: Math.min(Math.max(x, wa.x - s + 60), wa.x + wa.width - 60),
    y: Math.min(Math.max(y, wa.y), wa.y + wa.height - 60),
  }
}

/** Bounds of the collapsed orb window at its anchor. */
function collapsedBounds(cfg) {
  const p = anchorPos(cfg)
  const s = orbArea(cfg)
  return { x: p.x, y: p.y, width: s, height: s }
}

/** Current orb anchor (window top-left when collapsed; derived from the
 *  expanded rect otherwise). */
function getAnchor(cfg) {
  if (!overlayWin || overlayWin.isDestroyed()) return anchorPos(cfg)
  const b = overlayWin.getBounds()
  if (!expanded) return { x: b.x, y: b.y }
  const s = orbArea(cfg)
  const x = b.x + (lastSide === 'left' ? BUBBLE_W : 0)
  const y = b.y + Math.round((b.height - s) / 2)
  return { x, y }
}

function computeBounds(cfg, display) {
  const s = orbArea(cfg)
  if (!expanded) return { ...collapsedBounds(cfg), side: lastSide }
  const a = getAnchor(cfg)
  const rows = Math.max(1, Math.min(MAX_ROWS, display.rows.length))
  const bubbleH = clamp(HEADER_HEIGHT + PADDING + rows * ROW_HEIGHT + (display.more ? 22 : 0) + 8, BUBBLE_H_MIN, BUBBLE_H_MAX)
  const H = Math.max(s, bubbleH)
  const wa = screen.getDisplayNearestPoint({ x: a.x + Math.round(s / 2), y: a.y + Math.round(s / 2) }).workArea
  const roomRight = wa.x + wa.width - (a.x + s)
  const roomLeft = a.x - wa.x
  const side = roomRight + 16 >= BUBBLE_W || roomLeft < BUBBLE_W ? 'right' : 'left'
  const x = side === 'right' ? a.x : a.x - BUBBLE_W
  const y = a.y - Math.round((H - s) / 2)
  lastSide = side
  return {
    x: clamp(x, wa.x, wa.x + wa.width - (s + BUBBLE_W)),
    y: clamp(y, wa.y, Math.max(wa.y, wa.y + wa.height - H)),
    width: s + BUBBLE_W,
    height: H,
    side,
  }
}

function sendDisplay() {
  if (!overlayWin || overlayWin.isDestroyed()) return
  const cfg = loadOverlay()
  const full = buildDisplay()
  const display = {
    mode: full.mode,
    runningCount: full.runningCount,
    rows: full.rows.slice(0, MAX_ROWS),
    more: Math.max(0, full.rows.length - MAX_ROWS),
    attention: full.attention,
    expanded,
    side: lastSide,
    orbSize: cfg.orbSize,
    hideMs: cfg.bubbleTimeout,
    now: full.now,
  }
  const want = computeBounds(cfg, display)
  const b = overlayWin.getBounds()
  if (!dragging && (b.x !== want.x || b.y !== want.y || b.width !== want.width || b.height !== want.height)) {
    overlayWin.setBounds({ x: want.x, y: want.y, width: want.width, height: want.height })
  }
  if (!overlayWin.isVisible()) overlayWin.showInactive()
  overlayWin.webContents.send('overlay:state', display)
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

// ---------- window ----------

function createOverlayWindow() {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin
  const cfg = loadOverlay()
  const start = clampToVisuals(
    cfg.pos ? cfg.pos.x : collapsedBounds(cfg).x,
    cfg.pos ? cfg.pos.y : collapsedBounds(cfg).y,
    cfg,
  )
  overlayWin = new BrowserWindow({
    width: orbArea(cfg),
    height: orbArea(cfg),
    x: start.x,
    y: start.y,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false, // never steals the keyboard — it is an OSD, not a dialog
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  overlayWin.setAlwaysOnTop(true, 'screen-saver')
  overlayWin.loadFile(PAGE)
  overlayWin.on('closed', () => {
    overlayWin = null
  })
  overlayWin.showInactive()
  return overlayWin
}

function sendConfig() {
  const cfg = loadOverlay()
  const payload = { opacity: cfg.opacity, theme: cfg.theme, fontSize: cfg.fontSize, orbSize: cfg.orbSize, hideMs: cfg.bubbleTimeout }
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send('overlay:config', payload)
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('overlay:config', cfg)
}

// ---------- ipc ----------

function registerIpc() {
  if (ipcReady) return
  ipcReady = true

  ipcMain.on('overlay:ready', () => {
    dragging = false
    sendConfig()
    sendDisplay()
  })

  ipcMain.on('shell:trace', (_e, msg) => trace(String(msg).slice(0, 300)))

  ipcMain.on('overlay:set-expanded', (_e, v) => {
    expanded = !!v
    sendDisplay()
  })

  ipcMain.on('overlay:orb-drag', (_e, d) => {
    if (!overlayWin || overlayWin.isDestroyed()) return
    const dx = d && Number.isFinite(d.dx) ? d.dx : 0
    const dy = d && Number.isFinite(d.dy) ? d.dy : 0
    if (!dx && !dy) return
    dragging = true
    const b = overlayWin.getBounds()
    const wa = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea
    overlayWin.setPosition(
      clamp(b.x + dx, wa.x - 40, wa.x + wa.width - 40),
      clamp(b.y + dy, wa.y, wa.y + wa.height - 40),
    )
  })

  ipcMain.on('overlay:orb-drag-end', () => {
    if (!overlayWin || overlayWin.isDestroyed()) return
    dragging = false
    const cfg = loadOverlay()
    const a = getAnchor(cfg)
    const p = clampToVisuals(a.x, a.y, cfg)
    saveOverlay({ pos: { x: p.x, y: p.y } })
    sendDisplay()
  })

  ipcMain.on('overlay:orb-click', () => {
    trace('orb-click')
    expanded = false
    focusMain()
    sendDisplay()
  })

  ipcMain.on('overlay:row-click', (_e, id) => {
    trace('row-click ' + JSON.stringify(id))
    if (typeof id === 'string' && unread.has(id)) unread.delete(id)
    focusMain(id)
    sendDisplay()
  })

  ipcMain.handle('overlay:settings-get', () => loadOverlay())

  ipcMain.on('overlay:settings-set', (_e, patch) => {
    saveOverlay(patch && typeof patch === 'object' ? patch : {})
    applyOverlayConfig()
  })

  ipcMain.on('overlay:settings-reset-pos', () => {
    saveOverlay({ pos: null })
    expanded = false
    if (overlayWin && !overlayWin.isDestroyed()) {
      const cfg = loadOverlay()
      const b = collapsedBounds(cfg)
      const p = clampToVisuals(b.x, b.y, cfg)
      overlayWin.setBounds({ x: p.x, y: p.y, width: b.width, height: b.height })
    }
    sendConfig()
    sendDisplay()
  })

  ipcMain.on('overlay:settings-close', () => {
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close()
  })
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
  if (!cfg.enabled) {
    stopWatching()
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.close()
    overlayWin = null
    expanded = false
    return
  }
  createOverlayWindow()
  sendConfig()
  startWatching()
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
  settingsWin.on('closed', () => {
    settingsWin = null
  })
  return settingsWin
}

/** Reset the overlay position to the default corner (tray action). */
export function resetOverlayPosition() {
  expanded = false
  saveOverlay({ pos: null })
  if (overlayWin && !overlayWin.isDestroyed()) {
    const cfg = loadOverlay()
    const b = collapsedBounds(cfg)
    const p = clampToVisuals(b.x, b.y, cfg)
    overlayWin.setBounds({ x: p.x, y: p.y, width: b.width, height: b.height })
  }
  sendDisplay()
}

/** Release watchers (called on app quit). */
export function disposeOverlay() {
  stopWatching()
  unread.clear()
  prevRunning.clear()
}
