/**
 * Small always-on-top progress window for backend operations
 * (start / restart / stop). Single instance; reused across calls.
 *
 * States: 'busy' (spinner) | 'ok' | 'error' — the caller decides when to
 * close it (auto-close timers live in the caller).
 *
 * Flash suppression: the happy path is "backend started within a second or
 * two", and showing this window at once means a small window flashes on
 * screen only to vanish again — the exact artifact the user reported at
 * launch. So 'busy' only becomes visible after a grace delay
 * (SHOW_DELAY_MS); when the operation finishes sooner the window never
 * appears. Terminal 'ok'/'error' states still show immediately because the
 * user must see the outcome of a slow or failed operation.
 */
import { fileURLToPath } from 'node:url'
import { DshWindow } from './link-window.js'

const PRELOAD = fileURLToPath(new URL('./progress-preload.js', import.meta.url))
const PAGE = fileURLToPath(new URL('./progress.html', import.meta.url))
const SHOW_DELAY_MS = 700

let win = null
let pageReady = false
let visible = false
let showTimer = null
let wantShow = false // terminal state hit before the page was ready

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

/** Show (or update) the progress window. */
export function showProgress({ title, message, state = 'busy' }) {
  if (!win || win.isDestroyed()) {
    win = new DshWindow({
      width: 420,
      height: 128,
      frame: false,
      resizable: false,
      movable: true,
      alwaysOnTop: true,
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
    win.loadFile(PAGE)
    win.once('ready-to-show', () => {
      pageReady = true
      if (wantShow) reveal() // terminal state arrived while the page loaded
    })
    win.on('closed', () => {
      if (showTimer) clearTimeout(showTimer)
      showTimer = null
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
    win.webContents.send('progress:set', { title, message, state })
  }
}

/** Close the progress window if open. Cancels a pending delayed show. */
export function closeProgress() {
  if (showTimer) {
    clearTimeout(showTimer)
    showTimer = null
  }
  if (win && !win.isDestroyed()) win.close()
}
