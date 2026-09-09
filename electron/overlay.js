/**
 * dsh-clean-desktop-shell — task overlay window.
 *
 * A GPU-monitor style always-on-top card fed by the host half's state file
 * (~/.dsh/desktop-shell-state.json). The file is the ONLY input: no port,
 * no token, no DSH-internal transport. It shows
 *
 *   idle      「DSH 空闲」 when nothing runs;
 *   active    「N 个会话运行中」 + one row per session (名字 + 状态);
 *   approval  需要审批 / 需要回答 highlight while a decision chain is pending;
 *   done      finished tasks flip to unread 「已完成」 until clicked.
 *
 * Clicking a row focuses (and shows) the main window and clears that row's
 * unread mark. Position is remembered after a drag; opacity/theme/font come
 * from config.overlay (tray 「任务悬浮窗」 submenu).
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
// window the writer is gone (backend stopped/crashed) → show offline.
const STALE_MS = 12000
const ROW_HEIGHT = 44
const HEADER_HEIGHT = 52
const PADDING = 18
const MAX_ROWS = 6
const WIDTH = 280 // default width; overlay.size overrides after user resizing
const MIN_W = 220
const MAX_W = 640
const MIN_H = 96
const MAX_H = 720
let resizeActive = false // corner-drag loop owns the height while true

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

let overlayWin = null
let settingsWin = null
let getMainWindow = null
let watching = false
let ipcReady = false
let snap = null // last parsed state file, or null when absent/unparsable
let staleTimer = null
const prevRunning = new Map() // sessionId → running (transition detector)
const unread = new Map() // sessionId → { name, at } — done-until-clicked
let suppressMovedSave = false

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
  // Rows gone from the store still surface their completion via unread;
  // drop unread once the session itself disappears long-term? Keep it —
  // clearing only happens on click, matching 「点开后消失」.
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
  const runningCount = rows.filter((r) => r.kind === 'running' || r.kind === 'approval' || r.kind === 'question').length
  for (const [id, u] of unread) {
    if (seen.has(id) && list.find((s) => s.id === id && (s.running || s.approvals > 0 || s.questions > 0))) continue
    rows.push({ id, name: u.name, kind: 'done', at: u.at })
  }
  const order = { approval: 0, question: 1, running: 2, done: 3 }
  rows.sort((a, b) => order[a.kind] - order[b.kind] || b.at - a.at)

  if (mode === 'idle' || mode === 'active') {
    if (rows.length === 0) mode = 'idle'
    else if (runningCount > 0) mode = 'active'
    // Rows left are purely 'done' (nothing running) → keep the idle count
    // honest but still show the unread completions.
  }
  return { mode, runningCount, rows, now }
}

function sendDisplay() {
  if (!overlayWin || overlayWin.isDestroyed()) return
  const cfg = loadOverlay()
  const userW = cfg.size && cfg.size.w ? clamp(cfg.size.w, MIN_W, MAX_W) : WIDTH
  // A user-tallened window shows more rows instead of empty space.
  const capacity = cfg.size && cfg.size.h
    ? clamp(Math.floor((cfg.size.h - HEADER_HEIGHT - PADDING) / ROW_HEIGHT), 1, 12)
    : MAX_ROWS
  const full = buildDisplay()
  const display = {
    mode: full.mode,
    runningCount: full.runningCount,
    rows: full.rows.slice(0, capacity),
    more: Math.max(0, full.rows.length - capacity),
    now: full.now,
  }
  // Mid-drag the renderer's corner loop owns the bounds — applying the
  // (not yet persisted) config size here is what made the card flicker.
  if (!resizeActive) {
    const b = overlayWin.getBounds()
    const bounds = { x: b.x, y: b.y, width: userW }
    const contentH = HEADER_HEIGHT + PADDING + Math.max(1, display.rows.length) * ROW_HEIGHT + (display.more ? 22 : 0)
    const wantH = Math.max(contentH, cfg.size && cfg.size.h ? cfg.size.h : 0)
    const wa = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea
    bounds.height = clamp(wantH, MIN_H, Math.min(MAX_H, wa.height))
    suppressMovedSave = true
    overlayWin.setBounds(bounds)
    suppressMovedSave = false
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
  if (!watching) return
  watching = false
  unwatchFile(stateFile())
  if (staleTimer) clearInterval(staleTimer)
  staleTimer = null
}

// ---------- window ----------

function defaultPosition() {
  const wa = screen.getPrimaryDisplay().workArea
  return { x: wa.x + wa.width - WIDTH - 16, y: wa.y + 16 }
}

function clampToVisuals(x, y) {
  const d = screen.getDisplayNearestPoint({ x, y })
  const wa = d.workArea
  return {
    x: Math.min(Math.max(x, wa.x - WIDTH + 60), wa.x + wa.width - 60),
    y: Math.min(Math.max(y, wa.y), wa.y + wa.height - 60),
  }
}

function createOverlayWindow() {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin
  overlayWin = new BrowserWindow({
    width: WIDTH,
    height: 120,
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
  overlayWin.on('moved', () => {
    if (suppressMovedSave) return
    const [x, y] = overlayWin.getPosition()
    setTimeout(() => {
      saveOverlay({ pos: { x, y } })
    }, 500)
  })
  overlayWin.on('closed', () => {
    overlayWin = null
  })
  const cfg = loadOverlay()
  const pos = clampToVisuals(cfg.pos ? cfg.pos.x : defaultPosition().x, cfg.pos ? cfg.pos.y : defaultPosition().y)
  overlayWin.setBounds({
    x: pos.x,
    y: pos.y,
    width: cfg.size && cfg.size.w ? clamp(cfg.size.w, MIN_W, MAX_W) : WIDTH,
    height: cfg.size && cfg.size.h ? clamp(cfg.size.h, MIN_H, MAX_H) : 120,
  })
  overlayWin.showInactive()
  return overlayWin
}

function sendConfig() {
  const cfg = loadOverlay()
  const payload = { opacity: cfg.opacity, theme: cfg.theme, fontSize: cfg.fontSize }
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send('overlay:config', payload)
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('overlay:config', cfg)
}

// ---------- ipc ----------

function registerIpc() {
  if (ipcReady) return
  ipcReady = true

  ipcMain.on('overlay:ready', () => {
    resizeActive = false // a reloaded page is not mid-drag
    sendConfig()
    sendDisplay()
  })

  ipcMain.on('shell:trace', (_e, msg) => trace(String(msg).slice(0, 300)))

  ipcMain.on('overlay:row-click', (_e, id) => {
    trace('row-click ' + JSON.stringify(id))
    if (typeof id === 'string' && unread.has(id)) unread.delete(id)
    const main = getMainWindow && getMainWindow()
    if (main && !main.isDestroyed()) {
      if (main.isMinimized()) main.restore()
      main.show()
      main.focus()
      if (typeof id === 'string') {
        // Hand the session id to the page; the client plugin routes it to
        // the documented ctx.sessions.open() command (see src/client.js).
        try { main.webContents.send('shell:goto-session', id); trace('sent goto ' + id) } catch (err) { trace('send failed: ' + (err && err.message)) }
      }
    }
    sendDisplay()
  })

  // Corner-drag resizing: the renderer grip sends incremental deltas; the
  // final size persists as overlay.size (width also raises row capacity).
  ipcMain.on('overlay:resize', (_e, d) => {
    if (!overlayWin || overlayWin.isDestroyed()) return
    const dw = d && Number.isFinite(d.dw) ? d.dw : 0
    const dh = d && Number.isFinite(d.dh) ? d.dh : 0
    resizeActive = true
    const b = overlayWin.getBounds()
    const wa = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea
    overlayWin.setBounds({
      x: b.x,
      y: b.y,
      width: clamp(b.width + dw, MIN_W, MAX_W),
      height: clamp(b.height + dh, MIN_H, Math.min(MAX_H, wa.height)),
    })
  })

  ipcMain.on('overlay:reset-size', () => {
    saveOverlay({ size: null })
    sendDisplay()
  })

  ipcMain.on('overlay:resize-end', () => {
    resizeActive = false
    if (!overlayWin || overlayWin.isDestroyed()) return
    const b = overlayWin.getBounds()
    saveOverlay({ size: { w: b.width, h: b.height } })
    sendDisplay()
  })

  ipcMain.handle('overlay:settings-get', () => loadOverlay())

  ipcMain.on('overlay:settings-set', (_e, patch) => {
    saveOverlay(patch && typeof patch === 'object' ? patch : {})
    applyOverlayConfig()
  })

  ipcMain.on('overlay:settings-reset-pos', () => {
    saveOverlay({ pos: null, size: null })
    if (overlayWin && !overlayWin.isDestroyed()) {
      const p = defaultPosition()
      suppressMovedSave = true
      overlayWin.setBounds({ x: p.x, y: p.y, width: WIDTH, height: 120 })
      suppressMovedSave = false
    }
    sendConfig()
    sendDisplay()
  })

  ipcMain.on('overlay:settings-close', () => {
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close()
  })
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
    height: 430,
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

/** Reset the overlay position AND size to defaults (tray action). */
export function resetOverlayPosition() {
  if (overlayWin && !overlayWin.isDestroyed()) {
    const p = defaultPosition()
    suppressMovedSave = true
    overlayWin.setBounds({ x: p.x, y: p.y, width: WIDTH, height: 120 })
    suppressMovedSave = false
  }
  saveOverlay({ pos: null, size: null })
  sendDisplay()
}

/** Release watchers (called on app quit). */
export function disposeOverlay() {
  stopWatching()
  unread.clear()
  prevRunning.clear()
}
