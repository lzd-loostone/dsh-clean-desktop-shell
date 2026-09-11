/**
 * Bubble window preload (CJS, sandboxed).
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('bubbleAPI', {
  onState: (cb) => ipcRenderer.on('bubble:state', (_e, v) => cb(v)),
  onHide: (cb) => ipcRenderer.on('bubble:hide', () => cb()),
  onConfig: (cb) => ipcRenderer.on('bubble:config', (_e, v) => cb(v)),
  hover: (v) => ipcRenderer.send('bubble:hover', !!v),
  rowClick: (id) => ipcRenderer.send('bubble:row', id),
  readAll: () => ipcRenderer.send('bubble:read-all'),
  approvalHover: (id) => ipcRenderer.send('bubble:approval-hover', id || null),
  blankClick: () => ipcRenderer.send('bubble:blank'),
  size: (h) => ipcRenderer.send('bubble:size', h),
  ready: () => ipcRenderer.send('bubble:ready'),
})
