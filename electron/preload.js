/**
 * Preload: makes the frameless window draggable + exposes the minimal
 * shell API to the loaded page (sandbox-safe contextBridge).
 *
 * A frameless window has no title bar, so dragging is provided by a
 * `-webkit-app-region: drag` strip along the top of the loaded page.
 * The right side is left for the native window-controls overlay.
 *
 * The overlay (caption buttons + drag band) floats over the page and
 * shares no layout with it — so the page must keep the top band free
 * itself. We inject a caption-safe padding onto <body>: DSH's shell is
 * an unbroken `height: 100%` chain (html/body/#root → AppFrame grid),
 * and with `box-sizing: border-box` on body the padding *shrinks* the
 * app instead of overflowing it — every column (sidebar, header,
 * conversation, rightbar) starts below the band. The band height comes
 * from Electron's own `env(titlebar-area-height)` (kept in sync with
 * WINDOWS_TITLEBAR_HEIGHT by the platform, not by us); the px fallback
 * covers the offline error page where no overlay metric is exposed.
 * This replaces the old 148px spacer that the client plugin injected
 * into DSH's header utility slot — that only masked the missing
 * vertical inset and died with the 0.1.5 slot rework.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('shellAPI', {
  // Ask the main process to (re)load the real target URL. Used by the
  // offline screen's retry button.
  reload: () => ipcRenderer.send('shell:reload'),
  // Offline-screen quick actions (mirror the tray backend controls).
  startBackend: () => ipcRenderer.send('shell:start-backend'),
  detectBackend: () => ipcRenderer.send('shell:detect-backend'),
  chooseBackendFolder: () => ipcRenderer.send('shell:choose-backend-folder'),
  // Overlay row clicks arrive as 'shell:goto-session'; the page's client
  // plugin (dsh-clean-desktop-shell client half) listens here and routes
  // the id to the documented ctx.sessions.open() command.
  onGotoSession: (cb) => {
    try { ipcRenderer.send('shell:trace', 'preload listener armed') } catch (e) {}
    ipcRenderer.on('shell:goto-session', (_e, id) => {
      try { ipcRenderer.send('shell:trace', 'preload recv ' + id) } catch (e) {}
      cb(id)
    })
  },
  // The bubble's approval card asks for a decision; the page's client
  // plugin answers the live PendingApproval (see src/client/client.js).
  onApproveSession: (cb) => {
    ipcRenderer.on('shell:approve-session', (_e, v) => {
      try { ipcRenderer.send('shell:trace', 'preload recv approve ' + (v && v.decision) + ' ' + (v && v.sessionId)) } catch (e) {}
      cb(v)
    })
  },
  // The bubble's question card submits a whole batch of answers; the page's
  // client plugin validates them against the live PendingQuestion (see
  // src/client/client.js) before calling answer().
  onAnswerQuestion: (cb) => {
    ipcRenderer.on('shell:answer-question', (_e, v) => {
      try { ipcRenderer.send('shell:trace', 'preload recv answer x' + (v && v.answers && v.answers.length) + ' ' + (v && v.sessionId)) } catch (e) {}
      cb(v)
    })
  },
  // Echo channel for the client plugin's deep-link tracing.
  gotoTrace: (msg) => { try { ipcRenderer.send('shell:trace', 'client ' + msg) } catch (e) {} },
})

window.addEventListener('DOMContentLoaded', () => {
  const platform = process.platform
  const isWin = platform === 'win32'
  const dragHeight = isWin ? 32 : 28
  // Width reserved for native window controls (Win caption buttons / mac
  // traffic lights live at the top-right / top-left).
  const rightReserve = isWin ? 138 : 80
  const leftReserve = isWin ? 0 : 80

  // Caption-safe band: push the page content below the window overlay.
  // See the header comment for why border-box padding on <body> is the
  // only stable, DSH-internal-structure-free anchor for this.
  const safe = document.createElement('style')
  safe.id = 'dsh-clean-shell-caption-safe'
  safe.textContent = `
    html { --dsh-caption-h: env(titlebar-area-height, ${dragHeight}px); }
    body { box-sizing: border-box; padding-top: var(--dsh-caption-h); }
  `
  document.head.appendChild(safe)

  const strip = document.createElement('div')
  strip.id = 'dsh-clean-shell-drag'
  strip.style.cssText = `
    position: fixed;
    top: 0;
    left: ${leftReserve}px;
    right: ${rightReserve}px;
    height: ${dragHeight}px;
    -webkit-app-region: drag;
    z-index: 2147483647;
  `
  document.body.appendChild(strip)
})
