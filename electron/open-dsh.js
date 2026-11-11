/**
 * "Open DSH" — what every old "show the shell window" entry became.
 *
 * The page lives in its own app window when the user installed the PWA, because
 * that is the only form a Chromium browser renders full screen. The app belongs
 * to one browser profile, and the user may have several: the Windows default
 * browser wins when it has the app, otherwise the first browser that does. So
 * the rule is: bring the window forward, start it when it is missing, and only
 * fall back to a browser tab when no browser has the app installed.
 *
 * The URL still matters for the fallback: prefer the authenticated one captured
 * from a backend we started ourselves (dsh mints a per-process launch token);
 * otherwise the configured target, then the local default.
 */
import { shell } from 'electron'
import { DEFAULT_TARGET_URL, loadConfig } from './config.js'
import { getAuthenticatedUrl, start } from './service.js'
import { browserDefinitions, chooseBrowser, detectBrowsers, readDefaultBrowserProgId } from './browsers.js'
import { findPwaApp, findPwaWindow, focusWindow, launchPwaApp, listChromeWindows } from './pwa-window.js'
import { trace } from './trace.js'

export function dshUrl() {
  return getAuthenticatedUrl() || loadConfig().targetUrl || DEFAULT_TARGET_URL
}

/**
 * Make sure a launch token exists before a window is opened.
 *
 * The PWA window loads the app's installed start_url, which never carries the
 * per-process token. Without a token this process minted itself, the window
 * lands on "dsh web authentication required". Starting the backend here is
 * what turns that 401 page into a working session.
 */
async function ensureLocalBackendReady() {
  const target = loadConfig().targetUrl || DEFAULT_TARGET_URL
  if (new URL(target).origin !== new URL(DEFAULT_TARGET_URL).origin) return
  if (getAuthenticatedUrl() !== null) return
  try {
    await start({ backendPath: loadConfig().backendPath })
    trace('open-dsh: started backend to obtain a launch token')
  } catch (err) {
    trace('open-dsh: could not start backend: ' + (err && err.message))
  }
}

/**
 * Record windows that look like a DSH page that failed to load. They are not
 * closed (closing a window the user owns is worse than a stale one), but the
 * trace explains why the next click opens yet another window: such a window's
 * title no longer contains "DeepSeek Harness", so `findPwaWindow` cannot see
 * it and `launchPwaApp` starts a fresh one beside it.
 */
function noteUnreachableWindows() {
  try {
    for (const w of listChromeWindows()) {
      if (w.className !== 'Chrome_WidgetWin_1') continue
      if (!/127\.0\.0\.1|找不到|can.t reach|This site can/i.test(w.title)) continue
      trace('open-dsh: unreachable DSH window ' + w.hwnd + ' title=' + JSON.stringify(w.title).slice(0, 120))
    }
  } catch {
    // diagnostics must never break opening DSH
  }
}

/**
 * Show DSH: focus the PWA window, launch it, or fall back to a browser tab.
 *
 * Never rejects — every entry point calls it fire-and-forget, and a click that
 * throws would leave the overlay wedged. Every outcome is traced instead.
 */
export async function openDsh() {
  await ensureLocalBackendReady()
  if (process.platform === 'win32') {
    try {
      const live = findPwaWindow()
      if (live) {
        if (await focusWindow(live.hwnd)) {
          trace('open-dsh: focused pwa window ' + live.hwnd)
          return
        }
        // The window exists but Windows refused the foreground handoff; opening
        // a second one would leave the user with duplicates to tidy up.
        trace('open-dsh: pwa window ' + live.hwnd + ' exists but would not come forward')
        return
      }
      noteUnreachableWindows()
      const installed = detectBrowsers(browserDefinitions()).filter((b) => findPwaApp(b.userData))
      const browser = chooseBrowser(installed, readDefaultBrowserProgId())
      if (browser) {
        const opened = await launchPwaApp(browser)
        if (opened) {
          trace('open-dsh: launched pwa window ' + opened + ' in ' + browser.name)
          await focusWindow(opened)
          return
        }
        trace('open-dsh: ' + browser.name + ' has the app but would not start it')
      }
      trace('open-dsh: no pwa app available, falling back to the browser')
    } catch (err) {
      trace('open-dsh: pwa path failed: ' + (err && err.message))
    }
  }
  shell.openExternal(dshUrl()).catch((err) => {
    trace('open-dsh: openExternal failed: ' + (err && err.message))
  })
}
