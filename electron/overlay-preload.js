/**
 * Overlay orb preload (CJS, sandboxed). Read/act bridge for overlay.html —
 * state/config flow in; hover-expand, orb drags/clicks and row clicks out.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('overlayAPI', {
  onState: (cb) => ipcRenderer.on('overlay:state', (_e, v) => cb(v)),
  onConfig: (cb) => ipcRenderer.on('overlay:config', (_e, v) => cb(v)),
  rowClick: (id) => ipcRenderer.send('overlay:row-click', id),
  setExpanded: (v) => ipcRenderer.send('overlay:set-expanded', !!v),
  orbDrag: (dx, dy) => ipcRenderer.send('overlay:orb-drag', { dx, dy }),
  orbDragEnd: () => ipcRenderer.send('overlay:orb-drag-end'),
  orbClick: () => ipcRenderer.send('overlay:orb-click'),
  ready: () => ipcRenderer.send('overlay:ready'),
})
