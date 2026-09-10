/**
 * Orb window preload (CJS, sandboxed): state/config in, hover/drag/click/
 * context out. The drag signals carry NO coordinates — the main process
 * drives the window from its own DIP cursor position (per-monitor-DPI safe).
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('overlayAPI', {
  onState: (cb) => ipcRenderer.on('overlay:state', (_e, v) => cb(v)),
  onConfig: (cb) => ipcRenderer.on('overlay:config', (_e, v) => cb(v)),
  hover: (v) => ipcRenderer.send('overlay:orb-hover', !!v),
  dragStart: () => ipcRenderer.send('overlay:orb-drag-start'),
  dragTick: () => ipcRenderer.send('overlay:orb-drag-tick'),
  dragUp: () => ipcRenderer.send('overlay:orb-drag-up'),
  context: () => ipcRenderer.send('overlay:orb-context'),
  ready: () => ipcRenderer.send('overlay:ready'),
})
