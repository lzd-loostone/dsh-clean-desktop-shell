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
import { getAuthenticatedUrl } from './service.js'
import { browserDefinitions, chooseBrowser, detectBrowsers, readDefaultBrowserProgId } from './browsers.js'
import { findPwaApp, findPwaWindow, focusWindow, launchPwaApp } from './pwa-window.js'
import { trace } from './trace.js'

export function dshUrl() {
  return getAuthenticatedUrl() || loadConfig().targetUrl || DEFAULT_TARGET_URL
}

/**
 * Show DSH: focus the PWA window, launch it, or fall back to a browser tab.
 *
 * Never rejects — every entry point calls it fire-and-forget, and a click that
 * throws would leave the overlay wedged. Every outcome is traced instead.
 */
export async function openDsh() {
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
