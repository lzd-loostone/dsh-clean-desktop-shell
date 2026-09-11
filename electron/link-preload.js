/**
 * Link window toolbar preload (CJS, sandboxed).
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('linkAPI', {
  onOpen: (cb) => ipcRenderer.on('link:open', (_e, url) => cb(String(url))),
  copy: (url) => ipcRenderer.send('link:copy', String(url)),
  openExternal: (url) => ipcRenderer.send('link:open-external', String(url)),
  winCtl: (cmd) => ipcRenderer.send('link:win', String(cmd)),
})
