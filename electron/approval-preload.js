/**
 * Approval hover-card window preload (CJS, sandboxed).
 * Same channel shape as bubble-preload; act() carries {id, action}.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('approvalAPI', {
  onState: (cb) => ipcRenderer.on('approval:state', (_e, v) => cb(v)),
  onHide: (cb) => ipcRenderer.on('approval:hide', () => cb()),
  onConfig: (cb) => ipcRenderer.on('approval:config', (_e, v) => cb(v)),
  hover: (v) => ipcRenderer.send('approval:hover', !!v),
  act: (payload) => ipcRenderer.send('approval:act', payload),
  size: (h) => ipcRenderer.send('approval:size', h),
  ready: () => ipcRenderer.send('approval:ready'),
})
