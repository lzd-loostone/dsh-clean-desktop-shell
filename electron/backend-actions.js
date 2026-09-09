/**
 * Backend lifecycle actions shared by the tray menu and the orb context
 * menu. Progress-window UX mirrors what the tray has always done; the tray
 * menu itself refreshes via service.onStatusChange, so callers here need no
 * extra wiring.
 */
import { dialog } from 'electron'
import { loadConfig } from './config.js'
import { start, stop, restart } from './service.js'
import { showProgress, setProgress, closeProgress } from './progress.js'

export async function startBackend() {
  showProgress({ title: '启动后端', message: '正在启动 dsh 后端…' })
  try {
    await start({ backendPath: loadConfig().backendPath })
    setProgress({ title: '启动后端', message: '后端已启动', state: 'ok' })
    setTimeout(closeProgress, 1200)
    return true
  } catch (err) {
    closeProgress()
    dialog.showErrorBox('后端启动失败', err.message)
    return false
  }
}

export async function restartBackend() {
  showProgress({ title: '重启后端', message: '正在重启 dsh 后端…' })
  try {
    await restart({ backendPath: loadConfig().backendPath })
    setProgress({ title: '重启后端', message: '后端已重启', state: 'ok' })
    setTimeout(closeProgress, 1200)
  } catch (err) {
    closeProgress()
    dialog.showErrorBox('后端重启失败', err.message)
  }
}

export async function stopBackend() {
  showProgress({ title: '关闭后端', message: '正在关闭 dsh 后端…' })
  try {
    await stop()
    setProgress({ title: '关闭后端', message: '后端已关闭', state: 'ok' })
    setTimeout(closeProgress, 1200)
  } catch (err) {
    closeProgress()
    dialog.showErrorBox('后端关闭失败', err.message)
  }
}
