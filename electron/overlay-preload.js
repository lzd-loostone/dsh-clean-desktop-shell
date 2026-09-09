/**
 * Orb window preload (CJS, sandboxed): state/config in, hover/drag/click/
 * context out. Geometry & interaction policy live in the main process.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('overlayAPI', {
  onState: (cb) => ipcRenderer.on('overlay:state', (_e, v) => cb(v)),
  onConfig: (cb) => ipcRenderer.on('overlay:config', (_e, v) => cb(v)),
  hover: (v) => ipcRenderer.send('overlay:orb-hover', !!v),
  drag: (dx, dy) => ipcRenderer.send('overlay:orb-drag', { dx, dy }),
  dragEnd: () => ipcRenderer.send('overlay:orb-drag-end'),
  click: () => ipcRenderer.send('overlay:orb-click'),
  context: (x, y) => ipcRenderer.send('overlay:orb-context', { x, y }),
  ready: () => ipcRenderer.send('overlay:ready'),
})
