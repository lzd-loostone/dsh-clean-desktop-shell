/**
 * Small progress window for backend operations (start / restart / stop).
 * Single instance; reused across calls.
 *
 * States: 'busy' (spinner) | 'ok' | 'error' — the caller decides when to
 * close it on success; the failure and stuck cases are handled here so the
 * card can never sit on top of the screen forever:
 *
 *  - it is NOT always-on-top and it sits in the bottom-right corner of the
 *    work area, so it never covers what the user is reading;
 *  - 'busy' auto-hides after AUTO_HIDE_MS (the operation may still finish
 *    later, its status still reaches the tray);
 *  - 'error' closes itself after ERROR_HIDE_MS.
 *
 * Flash suppression: the happy path is "backend started within a second or
 * two", and showing this window at once means a small window flashes on
 * screen only to vanish again. So 'busy' only becomes visible after a grace
 * delay (SHOW_DELAY_MS); when the operation finishes sooner the window never
 * appears. Terminal 'ok'/'error' states still show immediately because the
 * user must see the outcome of a slow or failed operation.
 */
import { BrowserWindow } from 'electron'
import { fileURLToPath } from 'node:url'

const PRELOAD = fileURLToPath(new URL('./progress-preload.js', import.meta.url))
const PAGE = fileURLToPath(new URL('./progress.html', import.meta.url))
const WIDTH = 420
const HEIGHT = 148
const SHOW_DELAY_MS = 700
const AUTO_HIDE_MS = 20000
const ERROR_HIDE_MS = 3000

let win = null
let pageReady = false
let visible = false
let showTimer = null
let hideTimer = null
/** Supplies the backend's last output line, so the wait is explainable. */
let detailProvider = null
let wantShow = false // terminal state hit before the page was ready

/**
 * Register the detail source (the backend's last output line).
 * @param {(() => string) | null} provider
 */
export function setProgressDetail(provider) {
  detailProvider = provider
}

function readDetail() {
  try {
    const line = detailProvider ? detailProvider() : ''
    return typeof line === 'string' ? line.slice(0, 140) : ''
  } catch {
    return ''
  }
}

function reveal() {
  if (visible || !win || win.isDestroyed() || !pageReady) return
  if (showTimer) {
    clearTimeout(showTimer)
    showTimer = null
  }
  visible = true
  win.show()
}

/** Show now (terminal states) or after the grace delay (busy). */
function scheduleShow(now) {
  if (!win || win.isDestroyed() || visible) return
  if (now) {
    wantShow = true
    reveal()
    return
  }
  if (!showTimer) showTimer = setTimeout(() => { showTimer = null; reveal() }, SHOW_DELAY_MS)
}

/** Arm the auto-dismiss timer for the state that was just sent. */
function armDismiss(state) {
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
  if (state === 'busy') {
    hideTimer = setTimeout(() => {
      hideTimer = null
      if (win && !win.isDestroyed()) {
        visible = false
        win.hide()
      }
    }, AUTO_HIDE_MS)
  } else if (state === 'error') {
    hideTimer = setTimeout(() => {
      hideTimer = null
      closeProgress()
    }, ERROR_HIDE_MS)
  }
}

/** Show (or update) the progress window. */
export function showProgress({ title, message, state = 'busy' }) {
  if (!win || win.isDestroyed()) {
    win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      frame: false,
      resizable: false,
      movable: true,
      alwaysOnTop: false,
      skipTaskbar: true,
      show: false,
      backgroundColor: '#10131A',
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    pageReady = false
    visible = false
    wantShow = false
    // Centred on purpose: the user reads this card as a modal status, and the
    // corner placement read as a stray widget rather than a launch indicator.
    win.loadFile(PAGE)
    win.once('ready-to-show', () => {
      pageReady = true
      if (wantShow) reveal() // terminal state arrived while the page loaded
    })
    win.on('closed', () => {
      if (showTimer) clearTimeout(showTimer)
      if (hideTimer) clearTimeout(hideTimer)
      showTimer = null
      hideTimer = null
      win = null
      pageReady = false
      visible = false
      wantShow = false
    })
  }
  setProgress({ title, message, state })
  scheduleShow(state !== 'busy')
  return win
}

/** Update the progress window (created hidden if none exists yet). */
export function setProgress({ title, message, state }) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('progress:set', { title, message, state, detail: readDetail() })
  }
  armDismiss(state)
}

/** Close the progress window if open. Cancels a pending delayed show. */
export function closeProgress() {
  if (showTimer) {
    clearTimeout(showTimer)
    showTimer = null
  }
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
  if (win && !win.isDestroyed()) win.close()
}
