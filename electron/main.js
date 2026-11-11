/**
 * dsh-clean-desktop-shell — Electron main process entry.
 *
 * Shell/core decoupling:
 *  - default target: http://127.0.0.1:3080 (existing web profile, zero migration)
 *  - configurable remote target (settings file)
 *  - local backend detection on launch; full manual control from the tray
 *
 * There is no application window here any more. The shell is a tray icon
 * plus the task bubble; DSH itself lives in the user's browser, which is
 * where every "open" action leads (see open-dsh.js).
 */
import { app, Menu, nativeImage } from 'electron'
import { fileURLToPath } from 'node:url'
import { createTray, refreshTrayMenu } from './tray.js'
import { loadConfig, DEFAULT_TARGET_URL } from './config.js'
import { detect } from './service.js'
import { setupAutoUpdater } from './update.js'
import { initOverlay, applyOverlayConfig, disposeOverlay } from './overlay.js'
import { openDsh } from './open-dsh.js'
import { deliverWithRetry } from './bridge.js'
import { watchBackend, timedProbe } from './backend-watch.js'
import { probe } from './probe.js'
import { trace } from './trace.js'
import { APP_USER_MODEL_ID } from './aumid.js'
import { setupCrashGuard } from './crashGuard.js'

const isMac = process.platform === 'darwin'

// Last-resort error capture (userData/shell-crash.log) — install before
// anything else so even early startup failures leave a trace.
setupCrashGuard()

// Windows: pin the AppUserModelId so the taskbar shows our whale icon
// instead of the generic Electron icon. Plugin mode uses a distinct ID
// (see aumid.js) so Windows re-reads the icon instead of serving a
// stale per-AUMID cached one.
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID)
}

// macOS: a bare runtime has no .app bundle (no icon resource), so set the
// Dock icon at runtime. Unlike Windows there is no per-AUMID taskbar cache
// here — app.dock.setIcon applies directly. Packaged builds already carry
// the icon in their bundle, so skip those.
if (isMac && !app.isPackaged) {
  try {
    const dockIcon = nativeImage.createFromPath(
      fileURLToPath(new URL('../build/icon.png', import.meta.url)),
    )
    if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon)
  } catch {
    // non-fatal: keep the default icon
  }
}

// Uniform userData across both distribution branches (installer vs
// plugin-market), so config (target URL, backend path, ...) is shared
// no matter how the shell was launched.
app.setName('DSH Clean Desktop Shell')

/** Single instance: a second launch just reopens DSH in the browser. */
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  let tray = null
  let stopBackendWatch = null

  app.on('second-instance', () => {
    void openDsh()
  })

  /**
   * Launch-time backend detection. Detects whether a local dsh web is
   * already running so the tray reflects the real state, but never
   * auto-starts it — starting is a manual action (tray menu) so it cannot
   * fight an explicit "stop".
   */
  async function bootstrapBackend() {
    const config = loadConfig()
    const target = config.targetUrl || DEFAULT_TARGET_URL
    // Remote targets are the user's own business — never probe local.
    // Origin comparison (not string equality) tolerates trailing slashes
    // and an explicitly written default.
    if (new URL(target).origin !== new URL(DEFAULT_TARGET_URL).origin) return
    await detect()
    // Reflect the post-detect state in the tray menu.
    refreshTrayMenu()
  }

  app.whenReady().then(async () => {
    // No File/Edit/View application menu anywhere (the stock menu was also
    // what popped up over Electron's default child windows). Windows/Linux:
    // gone entirely — clipboard shortcuts keep working because Chromium
    // handles them natively in editable fields and selections. macOS keeps
    // its system menu by convention (the app menu lives outside our windows
    // there and carries the standard roles).
    if (!isMac) Menu.setApplicationMenu(null)

    tray = createTray({
      onOpen: () => void openDsh(),
      onQuit: () => {
        app.isQuitting = true
        app.quit()
      },
    })

    // Task overlay (GPU-monitor style always-on-top session card). Its only
    // input is the host plugin's state file; its three actions travel over
    // the host's loop-back route (bridge.js) — nothing to wire here.
    initOverlay()
    applyOverlayConfig()

    // Backend bootstrap in background (never delays the tray).
    bootstrapBackend().catch(() => {})

    // A restart leaves every open page holding a dead socket. Watch for the
    // new process answering, then ask the pages to re-mount. Local targets
    // only: our backend coming back says nothing about a remote one.
    const target = loadConfig().targetUrl || DEFAULT_TARGET_URL
    if (new URL(target).origin === new URL(DEFAULT_TARGET_URL).origin) {
      stopBackendWatch = watchBackend({
        url: target,
        // Every probe lands in the trace log: a disputed reload can then be
        // explained instead of guessed at.
        probe: timedProbe(probe, trace),
        // Keep the tray and orb labels honest: they offer "启动后端" whenever
        // the cached status says stopped, and the shell is spawned before the
        // backend binds its port.
        onChange: () => {
          void detect().catch(() => {})
        },
        onRestart: () => {
          // Nobody listening → give up quietly rather than launching a window
          // the user did not ask for.
          deliverWithRetry({ type: 'reload' }, { attempts: 30, intervalMs: 500 }).then((n) => {
            trace('backend restart → reload delivered to ' + n + ' page(s)')
          })
        },
      })
    }

    // Windows: wire the auto-updater (downloads new installers silently).
    setupAutoUpdater()

    app.on('activate', () => void openDsh())
  })

  app.on('window-all-closed', () => {
    // Keep the app alive in the tray (like a normal desktop utility).
    if (!isMac && !app.isQuitting) {
      // do not quit — tray keeps running
    }
  })

  app.on('before-quit', () => {
    app.isQuitting = true
    if (stopBackendWatch) stopBackendWatch()
    disposeOverlay()
  })
}
