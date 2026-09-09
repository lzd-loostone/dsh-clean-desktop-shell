/**
 * Context-menu window preload (CJS, sandboxed).
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('menuAPI', {
  onState: (cb) => ipcRenderer.on('menu:state', (_e, v) => cb(v)),
  onConfig: (cb) => ipcRenderer.on('menu:config', (_e, v) => cb(v)),
  action: (id) => ipcRenderer.send('menu:action', id),
  close: () => ipcRenderer.send('menu:close'),
  ready: () => ipcRenderer.send('menu:ready'),
})
