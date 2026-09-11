/**
 * dsh-clean-desktop-shell — self-drawn tabbed link window (WeChat-reader
 * style: one window, bookmark strip + icon toolbar on the SAME row).
 *
 * Electron's default behaviour for target=_blank is a bare child window
 * carrying the stock File/Edit application menu — a jarring artifact in an
 * otherwise clean shell. Instead we intercept every new-window request and
 * route it into a single frameless link window whose tab strip holds one
 * sandboxed <webview> per link (isolated partition, so no site ever gets
 * our preload and nothing shares the dsh session cookies).
 *
 * Two interception paths (the local Electron runtime in the wild may ship a
 * stripped BrowserWindow binding WITHOUT setWindowOpenHandler, and its
 * legacy 'new-window' event never fires — proven by probes on
 * electron-v33.4.11):
 *   1. setWindowOpenHandler when the API exists (official builds) — the
 *      popup never gets created;
 *   2. app-level 'browser-window-created' — always installed as the safety
 *      net (also catches <webview> guest popups). Ownership is decided
 *      SYNCHRONOUSLY inside the event via `instanceof DshWindow`: the
 *      event fires from within the window's constructor at a point where
 *      shell windows already carry the subclass prototype (verified), so
 *      external popups can be hidden the instant they are born — before
 *      Electron's trailing show() lets even one frame reach the
 *      compositor, eliminating the visible flash of the default window.
 */
import { app, BrowserWindow, clipboard, ipcMain, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import { classifyUrl, canOpenExternally } from './link-policy.js'

const LINK_PRELOAD = fileURLToPath(new URL('./link-preload.js', import.meta.url))
const LINK_PAGE = fileURLToPath(new URL('./link.html', import.meta.url))

/**
 * Base class for EVERY shell-owned window. Being a DshWindow is the whole
 * ownership contract: 'browser-window-created' is emitted synchronously
 * inside the BrowserWindow constructor, and at that moment the instance is
 * already bound to the subclass prototype, so `child instanceof DshWindow`
 * inside the fallback identifies ours with zero registration races — no
 * WeakSet bookkeeping and no "wait a tick to see who appears" guessing.
 */
export class DshWindow extends BrowserWindow {}

/** The single link window (created on first need). */
let linkWin = null
let ipcReady = false
let fallbackReady = false

function ensureLinkIpc() {
  if (ipcReady) return
  ipcReady = true

  ipcMain.on('link:copy', (_e, url) => {
    if (typeof url === 'string' && canOpenExternally(url)) clipboard.writeText(url)
  })
  ipcMain.on('link:open-external', (_e, url) => {
    if (typeof url === 'string' && canOpenExternally(url)) shell.openExternal(url).catch(() => {})
  })
  ipcMain.on('link:win', (e, cmd) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || win.isDestroyed()) return
    if (cmd === 'min') win.minimize()
    else if (cmd === 'max') { if (win.isMaximized()) win.unmaximize(); else win.maximize() }
    else if (cmd === 'close') win.close()
  })
}

/** Route every new-window request from this window through the policy. */
export function attachLinkWindows(win) {
  if (typeof win.setWindowOpenHandler === 'function') {
    win.setWindowOpenHandler(({ url }) => {
      const verdict = classifyUrl(url)
      if (verdict.action === 'link-window') openLinkWindow(verdict.url)
      else if (verdict.action === 'external') shell.openExternal(verdict.url).catch(() => {})
      return { action: 'deny' }
    })
  }
  // The app-level net is installed unconditionally: even on official
  // builds it catches <webview> guest popups (allowpopups), which no
  // per-window handler covers.
  installFallback()
}

function installFallback() {
  if (fallbackReady) return
  fallbackReady = true
  ensureLinkIpc()
  app.on('browser-window-created', (_e, child) => {
    // Shell windows (probe-verified): this event fires mid-constructor and
    // `instanceof` already sees the subclass → leave them entirely alone.
    if (child instanceof DshWindow) return
    // External popup. Electron calls show() a few statements AFTER this
    // event, so hide early, re-hide on 'show' (same synchronous turn as
    // the native SW_SHOW, still before any frame is composited), and hide
    // again whenever we learn more. Every path below is defensive: the
    // window can vanish at any moment.
    // Triple suppression: transparent, off-screen, hidden — every beat
    // re-applies all three, so whichever native show wins the race there
    // is still nothing for the compositor to draw.
    const hide = () => {
      try { child.setOpacity(0) } catch { /* gone */ }
      try { child.setPosition(-32000, -32000) } catch { /* gone */ }
      try { child.hide() } catch { /* gone */ }
    }
    let firstUrl = null
    let settled = false
    let watcher = null
    const finish = (url) => {
      if (settled) return
      settled = true
      if (watcher) { try { child.webContents.removeListener('did-start-navigation', watcher) } catch { /* gone */ } }
      hide()
      try { child.destroy() } catch { /* already gone */ }
      if (!url) return
      const verdict = classifyUrl(url)
      if (verdict.action === 'link-window') openLinkWindow(verdict.url)
      else if (verdict.action === 'external') shell.openExternal(verdict.url).catch(() => {})
    }
    try {
      child.once('show', hide)
      hide()
      watcher = (_ev, url, _ip, isMainFrame) => {
        if (!isMainFrame || firstUrl) return
        if (url && url !== 'about:blank' && !url.startsWith('chrome-error')) {
          firstUrl = url
          finish(url) // act on the nav IPC directly — no extra tick
        }
      }
      child.webContents.on('did-start-navigation', watcher)
    } catch { hide(); return }
    child.once('closed', () => { settled = true })
    setTimeout(() => hide(), 0)                 // beat the first vsync frame
    setTimeout(() => finish(firstUrl), 1000)    // never navigated → dispose
    setTimeout(() => finish(firstUrl), 5000)    // final safety net
  })
}

/** Open (or focus + new tab in) THE link window. */
export function openLinkWindow(url) {
  ensureLinkIpc()
  if (linkWin && !linkWin.isDestroyed()) {
    if (linkWin.isMinimized()) linkWin.restore()
    linkWin.show()
    linkWin.focus()
    if (!linkWin.webContents.isLoadingMainFrame()) linkWin.webContents.send('link:open', url)
    else linkWin.webContents.once('did-finish-load', () => linkWin && !linkWin.isDestroyed() && linkWin.webContents.send('link:open', url))
    return linkWin
  }
  linkWin = new DshWindow({
    width: 1000,
    height: 720,
    minWidth: 420,
    minHeight: 360,
    frame: false,
    show: false,
    backgroundColor: '#f5f6f8',
    title: 'DSH 链接',
    webPreferences: {
      preload: LINK_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true, // tabs host guest pages in sandboxed <webview>s
    },
  })
  linkWin.setMenuBarVisibility(false)
  linkWin.webContents.once('did-finish-load', () => {
    if (linkWin && !linkWin.isDestroyed()) linkWin.webContents.send('link:open', url)
  })
  linkWin.once('ready-to-show', () => { if (linkWin && !linkWin.isDestroyed()) linkWin.show() })
  linkWin.on('closed', () => { linkWin = null })
  linkWin.loadFile(LINK_PAGE)
  return linkWin
}
