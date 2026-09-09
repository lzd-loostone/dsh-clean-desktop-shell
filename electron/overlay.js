/**
 * dsh-clean-desktop-shell — task orb + bubble overlay (host-of-window half).
 *
 * One always-on-top transparent window morphing between two states:
 *
 *   collapsed  a small orb (official whale icon; spinning light ring + count
 *              badge while sessions run; attention dot for approval /
 *              question / unread-done; grey while the backend is stale);
 *   expanded   the orb plus a bubble card listing every active session.
 *
 * Geometry model (anchor-pinned): the ORB is the anchor and never moves for
 * expand/collapse. The window's top-left corner is pinned at the anchor when
 * the bubble opens right, and offset left by the bubble column when it opens
 * left; expansion only ever grows the window DOWNWARD (bottom edge). The
 * window width is constant (orb strip + bubble column) so the horizontal
 * edge never jumps mid-animation; the side flips only at drag-end, and then
 * behind a brief hide/show so no ghost jump is visible.
 *
 * The state file written by the cordis host half (~/.dsh/desktop-shell-state
 * .json) remains the ONLY input — no port, no token, no DSH transport.
 *
 * Interaction contract (renderer drives, this process owns geometry):
 *   overlay:set-expanded  renderer hover/state-change → grow/shrink bottom
 *   overlay:orb-drag      pointer deltas in SCREEN coords (clientX would
 *                         feed the window move back into the delta and
 *                         oscillate) — anchor persisted on orb-drag-end
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
const ORB_MARGIN = 8 // per side: ring + badge headroom inside the strip
const BUBBLE_W = 300 // bubble column width (292 card + slack)
const BUBBLE_GAP = 6 // strip edge → bubble edge
const BUBBLE_TOP = 8 // bubble top aligns with the circle's top
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
let orbHovering = false

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
  rows.sort((a, b) => (order[a.kind] - order[b.kind]) || (b.at - a.at))

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

// ---------- geometry (anchor-pinned) ----------

function orbArea(cfg) {
  return clamp(cfg.orbSize, 40, 96) + ORB_MARGIN * 2
}

function windowWidth(cfg) {
  return orbArea(cfg) + BUBBLE_GAP + BUBBLE_W
}

/** Default anchor: top-right corner (strip top-left). */
function anchorPos(cfg) {
  if (cfg.pos) return { x: cfg.pos.x, y: cfg.pos.y }
  const wa = screen.getPrimaryDisplay().workArea
  return { x: wa.x + wa.width - orbArea(cfg) - 16, y: wa.y + 16 }
}

/** The anchor (orb strip top-left) implied by the current window rect. */
function getAnchor(cfg) {
  if (!overlayWin || overlayWin.isDestroyed()) return anchorPos(cfg)
  const b = overlayWin.getBounds()
  const s = orbArea(cfg)
  const W = windowWidth(cfg)
  return { x: b.x + (lastSide === 'left' ? W - s : 0), y: b.y }
}

/** Target rect for the current state. The orb anchor never moves: x is a
 *  pure function of (anchor, side), y is the anchor y, and expansion only
 *  grows the height downward. Clamping is generous (screen bounds, not work
 *  area) so the bubble may hang over the taskbar rather than shove the orb. */
function computeBounds(cfg, display) {
  const s = orbArea(cfg)
  const a = getAnchor(cfg)
  const W = windowWidth(cfg)
  let H = s
  if (expanded) {
    const rows = Math.max(1, Math.min(MAX_ROWS, display && display.rows ? display.rows.length : 1))
    const bubbleH = clamp(HEADER_HEIGHT + PADDING + rows * ROW_HEIGHT + (display && display.more ? 22 : 0) + 8, BUBBLE_H_MIN, BUBBLE_H_MAX)
    H = Math.max(s, BUBBLE_TOP + bubbleH + 6)
  }
  const bb = screen.getDisplayNearestPoint({ x: a.x + Math.round(s / 2), y: a.y + Math.round(s / 2) }).bounds
  const roomRight = bb.x + bb.width - (a.x + s)
  const roomLeft = a.x - bb.x
  const side = roomRight + BUBBLE_GAP >= BUBBLE_W || roomLeft < BUBBLE_W ? 'right' : 'left'
  lastSide = side
  const x = side === 'right' ? a.x : a.x - (W - s)
  return {
    x: clamp(x, bb.x - (W - s) + 60, bb.x + bb.width - 60),
    y: clamp(a.y, bb.y, Math.max(bb.y, bb.y + bb.height - s - 20)),
    width: W,
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
  display.side = want.side // class must match the geometry we just applied
  if (!dragging) {
    const b = overlayWin.getBounds()
    if (b.x !== want.x || b.y !== want.y || b.width !== want.width || b.height !== want.height) {
      overlayWin.setBounds({ x: want.x, y: want.y, width: want.width, height: want.height })
    }
  }
  applyIgnore()
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
  const b0 = computeBounds(cfg, { rows: [], more: 0 })
  overlayWin = new BrowserWindow({
    width: b0.width,
    height: b0.height,
    x: b0.x,
    y: b0.y,
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
  applyIgnore()
  overlayWin.loadFile(PAGE)
  overlayWin.on('closed', () => {
    overlayWin = null
  })
  overlayWin.showInactive()
  return overlayWin
}

/** The window is always strip+bubble wide; the empty bubble column must not
 *  eat desktop clicks. Collapsed + not hovering the orb → ignore the mouse
 *  (forward:true still delivers hover so expand can trigger). Anything the
 *  user can click (orb hover, expanded bubble, drag) captures normally. */
function applyIgnore() {
  if (!overlayWin || overlayWin.isDestroyed()) return
  const shouldIgnore = !expanded && !orbHovering && !dragging
  try { overlayWin.setIgnoreMouseEvents(shouldIgnore, { forward: true }) } catch { /* pre-ready */ }
}

function sendConfig() {
  const cfg = loadOverlay()
  const payload = { opacity: cfg.opacity, theme: cfg.theme, fontSize: cfg.fontSize, orbSize: cfg.orbSize, hideMs: cfg.bubbleTimeout }
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send('overlay:config', payload)
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('overlay:config', cfg)
}

/** Recompute + apply the rect for the current state (reset, orbSize change). */
function applyBoundsNow(cfg) {
  if (!overlayWin || overlayWin.isDestroyed()) return
  const want = computeBounds(cfg, { rows: [], more: 0 })
  overlayWin.setBounds({ x: want.x, y: want.y, width: want.width, height: want.height })
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
    sendDisplay() // grows/shrinks the bottom edge only — orb never moves
  })

  ipcMain.on('overlay:orb-drag', (_e, d) => {
    if (!overlayWin || overlayWin.isDestroyed()) return
    const dx = d && Number.isFinite(d.dx) ? d.dx : 0
    const dy = d && Number.isFinite(d.dy) ? d.dy : 0
    if (!dx && !dy) return
    dragging = true
    const cfg = loadOverlay()
    const s = orbArea(cfg)
    const b = overlayWin.getBounds()
    const bb = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).bounds
    const leftLimit = bb.x - (b.width - s) + 60 // keep 60px of the strip visible
    const rightLimit = bb.x + bb.width - 60
    overlayWin.setPosition(
      clamp(b.x + dx, leftLimit, rightLimit),
      clamp(b.y + dy, bb.y, Math.max(bb.y, bb.y + bb.height - s - 20)),
    )
  })

  ipcMain.on('overlay:orb-drag-end', () => {
    if (!overlayWin || overlayWin.isDestroyed()) return
    dragging = false
    const cfg = loadOverlay()
    const a = getAnchor(cfg)
    saveOverlay({ pos: { x: a.x, y: a.y } })
    const prevSide = lastSide
    const want = computeBounds(cfg, { rows: [], more: 0 })
    if (want.side !== prevSide) {
      // The strip moves to the other window edge — hide while the rect and
      // the renderer class swap so no ghost jump is visible.
      overlayWin.hide()
      overlayWin.setBounds({ x: want.x, y: want.y, width: want.width, height: want.height })
      sendDisplay()
      setTimeout(() => {
        if (overlayWin && !overlayWin.isDestroyed()) overlayWin.showInactive()
      }, 40)
      return
    }
    sendDisplay()
  })

  ipcMain.on('overlay:orb-hover', (_e, v) => {
    orbHovering = !!v
    applyIgnore()
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
    if (overlayWin && !overlayWin.isDestroyed()) applyBoundsNow(loadOverlay())
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
  sendDisplay() // picks up orbSize changes (window width depends on it)
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
  if (overlayWin && !overlayWin.isDestroyed()) applyBoundsNow(loadOverlay())
  sendDisplay()
}

/** Release watchers (called on app quit). */
export function disposeOverlay() {
  stopWatching()
  unread.clear()
  prevRunning.clear()
}
