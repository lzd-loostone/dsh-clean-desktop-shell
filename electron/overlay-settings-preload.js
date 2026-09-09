/**
 * Settings window preload (CJS, sandboxed) for overlay-settings.html.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('settingsAPI', {
  get: () => ipcRenderer.invoke('overlay:settings-get'),
  set: (patch) => ipcRenderer.send('overlay:settings-set', patch),
  resetPos: () => ipcRenderer.send('overlay:settings-reset-pos'),
  close: () => ipcRenderer.send('overlay:settings-close'),
  size: (h) => ipcRenderer.send('overlay:settings-size', h),
  onConfig: (cb) => ipcRenderer.on('overlay:config', (_e, v) => cb(v)),
})
