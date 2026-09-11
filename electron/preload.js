/**
 * Preload: makes the frameless window draggable + exposes the minimal
 * shell API to the loaded page (sandbox-safe contextBridge).
 *
 * A frameless window has no title bar, so dragging is provided by a
 * `-webkit-app-region: drag` strip along the top of the loaded page.
 * The right side is left for the native window-controls overlay.
 *
 * The strip is a transparent overlay, so it never changes page layout —
 * but it sits above the page top edge, so page top-bar buttons can be
 * reached by the strip being only 1px tall at the very edge... Instead we
 * use a pragmatic height and rely on the page's own top padding for the
 * DSH top bar area. Overlap is acceptable: the strip is click-through for
 * everything except dragging (app-region drag areas swallow mouse events).
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
