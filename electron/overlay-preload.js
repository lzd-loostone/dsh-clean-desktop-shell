/**
 * Overlay window preload (CJS, sandboxed). Exposes the minimal read/act
 * bridge for overlay.html — state/config flow in, row clicks flow out.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('overlayAPI', {
  onState: (cb) => ipcRenderer.on('overlay:state', (_e, v) => cb(v)),
  onConfig: (cb) => ipcRenderer.on('overlay:config', (_e, v) => cb(v)),
  rowClick: (id) => ipcRenderer.send('overlay:row-click', id),
  ready: () => ipcRenderer.send('overlay:ready'),
})
