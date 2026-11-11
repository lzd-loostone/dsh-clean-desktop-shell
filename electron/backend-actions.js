/**
 * Backend lifecycle actions shared by the tray menu and the orb context
 * menu. Progress-window UX mirrors what the tray has always done; the tray
 * menu itself refreshes via service.onStatusChange, so callers here need no
 * extra wiring.
 *
 * The card shows the backend's last output line while it waits, and it is
 * dismissed the moment the operation settles: a successful start used to keep
 * it on screen for another 1.2s, which read as "still working" after the work
 * was done.
 */
import { dialog } from 'electron'
import { loadConfig } from './config.js'
import { start, stop, restart, getLastOutputLine } from './service.js'
import { showProgress, setProgress, closeProgress, setProgressDetail } from './progress.js'

// The progress card explains a long wait with the backend's own last line.
setProgressDetail(getLastOutputLine)

export async function startBackend() {
  showProgress({ title: '启动后端', message: '正在启动 dsh 后端…' })
  try {
    await start({ backendPath: loadConfig().backendPath })
    closeProgress()
    return true
  } catch (err) {
    setProgress({ title: '启动后端', message: err.message, state: 'error' })
    dialog.showErrorBox('后端启动失败', err.message)
    return false
  }
}

export async function restartBackend() {
  showProgress({ title: '重启后端', message: '正在重启 dsh 后端…' })
  try {
    await restart({ backendPath: loadConfig().backendPath })
    closeProgress()
  } catch (err) {
    setProgress({ title: '重启后端', message: err.message, state: 'error' })
    dialog.showErrorBox('后端重启失败', err.message)
  }
}

export async function stopBackend() {
  showProgress({ title: '关闭后端', message: '正在关闭 dsh 后端…' })
  try {
    await stop()
    closeProgress()
  } catch (err) {
    setProgress({ title: '关闭后端', message: err.message, state: 'error' })
    dialog.showErrorBox('后端关闭失败', err.message)
  }
}
