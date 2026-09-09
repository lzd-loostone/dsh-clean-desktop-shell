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
import { existsSync, readFileSync, unwatchFile, watchFile } from 'node:fs'
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
const WIDTH = 280

function stateFile() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'desktop-shell-state.json')
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
  const shown = rows.slice(0, MAX_ROWS)
  return { mode, runningCount, rows: shown, more: Math.max(0, rows.length - shown.length), now }
}

function sendDisplay() {
  if (!overlayWin || overlayWin.isDestroyed()) return
  const display = buildDisplay()
  const height = Math.min(480, HEADER_HEIGHT + PADDING + Math.max(1, display.rows.length) * ROW_HEIGHT + (display.more ? 22 : 0))
  suppressMovedSave = true
  overlayWin.setBounds({ width: WIDTH, height, x: overlayWin.getBounds().x, y: overlayWin.getBounds().y })
  suppressMovedSave = false
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
  overlayWin.setPosition(pos.x, pos.y)
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
    sendConfig()
    sendDisplay()
  })

  ipcMain.on('overlay:row-click', (_e, id) => {
    if (typeof id === 'string' && unread.has(id)) unread.delete(id)
    const main = getMainWindow && getMainWindow()
    if (main && !main.isDestroyed()) {
      if (main.isMinimized()) main.restore()
      main.show()
      main.focus()
    }
    sendDisplay()
  })

  ipcMain.handle('overlay:settings-get', () => loadOverlay())

  ipcMain.on('overlay:settings-set', (_e, patch) => {
    saveOverlay(patch && typeof patch === 'object' ? patch : {})
    applyOverlayConfig()
  })

  ipcMain.on('overlay:settings-reset-pos', () => {
    saveOverlay({ pos: null })
    if (overlayWin && !overlayWin.isDestroyed()) {
      const p = defaultPosition()
      suppressMovedSave = true
      overlayWin.setPosition(p.x, p.y)
      suppressMovedSave = false
    }
    sendConfig()
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

/** Reset the overlay position to the default corner (tray action). */
export function resetOverlayPosition() {
  if (overlayWin && !overlayWin.isDestroyed()) {
    const p = defaultPosition()
    suppressMovedSave = true
    overlayWin.setPosition(p.x, p.y)
    suppressMovedSave = false
  }
  saveOverlay({ pos: null })
}

/** Release watchers (called on app quit). */
export function disposeOverlay() {
  stopWatching()
  unread.clear()
  prevRunning.clear()
}
