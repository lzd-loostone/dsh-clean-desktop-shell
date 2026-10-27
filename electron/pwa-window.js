/**
 * The DSH PWA window — find it, bring it forward, start it if it is gone.
 *
 * Chrome's "open in app" window is an ordinary top-level Chrome window: same
 * process, same window class, no API that says "this one is the installed
 * app". Two signals are left, and both are used below:
 *
 *  - the window class (Chrome_WidgetWin_1) narrows the field to Chromium
 *    windows — including our own Electron ones, which the pid check drops;
 *  - the title. A tabbed browser window always ends in " - <browser name>",
 *    an app window has no tab strip and shows the page title alone. The page
 *    title itself tracks the open session, so the check is a substring, not
 *    an equality: "DeepSeek Harness - <session> — DeepSeek Harness" must match.
 *    Every Chromium browser ends tabs the same way, so the suffix list covers
 *    all of them — Chrome, Edge, Brave, Vivaldi, ego lite — not just Chrome.
 *
 * Win32 calls go through koffi. Handles are declared uintptr_t rather than
 * void*: koffi will not build a pointer from a JS number, but it passes
 * integers of pointer width straight through, which is all an HWND is.
 *
 * Everything here degrades to null/false when the platform is not Windows or
 * koffi cannot load, so every caller has exactly one fallback to write.
 */
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const CHROME_WINDOW_CLASS = 'Chrome_WidgetWin_1'
const PWA_TITLE = 'DeepSeek Harness'
const BROWSER_TITLE_SUFFIX = / - (Google Chrome|Microsoft Edge|Brave|Vivaldi|Opera|ego|Mozilla Firefox)( \d+)?$/i

const SW_MINIMIZE = 6
const SW_RESTORE = 9
// Windows grants foreground only to the process that owns the current one, or
// that just received input. The call can report success and still leave the
// window behind, so the result is read back from the system instead of trusted.
const SETTLE_MS = 60
const RESTORE_SETTLE_MS = 120

/** undefined = not tried yet, null = unsupported/unavailable, object = ready. */
let api

function loadWin32() {
  if (api !== undefined) return api
  if (process.platform !== 'win32') {
    api = null
    return api
  }
  try {
    const require = createRequire(import.meta.url)
    const koffi = require('koffi')
    const user32 = koffi.load('user32.dll')
    const EnumWindowsProc = koffi.proto('bool __stdcall EnumWindowsProc(uintptr_t hwnd, intptr_t lParam)')
    api = {
      koffi,
      EnumWindowsProc,
      EnumWindows: user32.func('bool __stdcall EnumWindows(EnumWindowsProc* cb, intptr_t lParam)'),
      GetWindowTextW: user32.func('int __stdcall GetWindowTextW(uintptr_t hwnd, void* buf, int maxCount)'),
      GetClassNameW: user32.func('int __stdcall GetClassNameW(uintptr_t hwnd, void* buf, int maxCount)'),
      IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(uintptr_t hwnd)'),
      GetWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(uintptr_t hwnd, void* pidOut)'),
      GetForegroundWindow: user32.func('uintptr_t __stdcall GetForegroundWindow()'),
      SetForegroundWindow: user32.func('bool __stdcall SetForegroundWindow(uintptr_t hwnd)'),
      ShowWindow: user32.func('bool __stdcall ShowWindow(uintptr_t hwnd, int cmd)'),
      IsIconic: user32.func('bool __stdcall IsIconic(uintptr_t hwnd)'),
      GetWindowRect: user32.func('bool __stdcall GetWindowRect(uintptr_t hwnd, _Out_ int* rect)'),
    }
  } catch {
    api = null
  }
  return api
}

function readWide(fn, hwnd, chars) {
  const buf = Buffer.alloc(chars * 2)
  fn(hwnd, buf, chars)
  return buf.toString('utf16le').split('\u0000')[0]
}

/**
 * Pick the DSH app window out of a window list.
 *
 * @param {Array<{ hwnd: number, pid: number, title: string, className: string }>} windows
 * @param {number} selfPid — our own process, whose Electron windows share the class
 * @returns {{ hwnd: number, pid: number } | null}
 */
export function pickPwaWindow(windows, selfPid) {
  for (const w of windows) {
    if (w.className !== CHROME_WINDOW_CLASS) continue
    if (w.pid === selfPid) continue
    if (!w.title.includes(PWA_TITLE)) continue
    if (BROWSER_TITLE_SUFFIX.test(w.title)) continue
    return { hwnd: w.hwnd, pid: w.pid }
  }
  return null
}

/**
 * Every visible, titled top-level window. Cheap enough to poll (~1ms), and the
 * only way to notice a window we did not start ourselves.
 *
 * @returns {Array<{ hwnd: number, pid: number, title: string, className: string }>}
 */
export function listChromeWindows() {
  const a = loadWin32()
  if (!a) return []
  const rows = []
  let cb
  try {
    cb = a.koffi.register((hwnd) => {
      if (!a.IsWindowVisible(hwnd)) return true
      const title = readWide(a.GetWindowTextW, hwnd, 512)
      if (!title) return true
      const className = readWide(a.GetClassNameW, hwnd, 256)
      const pbuf = Buffer.alloc(4)
      a.GetWindowThreadProcessId(hwnd, pbuf)
      rows.push({ hwnd: Number(hwnd), pid: pbuf.readUInt32LE(0), title, className })
      return true
    }, a.koffi.pointer(a.EnumWindowsProc))
    a.EnumWindows(cb, 0)
  } catch {
    return rows
  } finally {
    if (cb) a.koffi.unregister(cb)
  }
  return rows
}

/** Command line for the installed app: same flags Chrome's own shortcut uses. */
export function buildAppLaunchArgs(appId, profileDir) {
  return ['--profile-directory=' + profileDir, '--app-id=' + appId]
}

/**
 * Find the installed DSH app id and the profile that owns it.
 *
 * Chrome keeps installed apps under <profile>/Web Applications/_crx_<id>/ and
 * drops the app's icon next to it; the icon name carries the app's display
 * name, which is the only readable identity in that directory.
 *
 * @param {string} userDataDir — Chrome's "User Data" directory
 * @returns {{ appId: string, profileDir: string } | null}
 */
export function findPwaApp(userDataDir) {
  if (!userDataDir) return null
  let profiles
  try {
    profiles = readdirSync(userDataDir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const p of profiles) {
    if (!p.isDirectory()) continue
    const appsDir = join(userDataDir, p.name, 'Web Applications')
    let apps
    try {
      apps = readdirSync(appsDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const app of apps) {
      if (!app.isDirectory() || !app.name.startsWith('_crx_')) continue
      let files
      try {
        files = readdirSync(join(appsDir, app.name))
      } catch {
        continue
      }
      if (!files.some((n) => n.toLowerCase().endsWith('.ico') && /deepseek/i.test(n))) continue
      return { appId: app.name.slice('_crx_'.length), profileDir: p.name }
    }
  }
  return null
}

// A cold PWA start is a process launch plus a page load; Chrome shows the
// window long before the page is usable, so the deadline only has to cover
// the window appearing.
const LAUNCH_TIMEOUT_MS = 8000
const LAUNCH_POLL_MS = 120

/**
 * Poll until a PWA window that was not in `before` shows up.
 *
 * @param {Set<number>} before — known window handles
 * @param {number} deadlineMs
 * @param {{ intervalMs?: number, scan?: () => ({ hwnd: number, pid: number } | null) }} [options]
 * @returns {Promise<number | null>} the new handle, or null on timeout
 */
export async function waitForNewPwaWindow(before, deadlineMs, { intervalMs = LAUNCH_POLL_MS, scan = findPwaWindow } = {}) {
  const stopAt = Date.now() + deadlineMs
  for (;;) {
    const hit = scan()
    if (hit && !before.has(hit.hwnd)) return hit.hwnd
    if (Date.now() >= stopAt) return null
    await sleep(intervalMs)
  }
}

/**
 * Start the installed DSH app in one browser and wait for its window.
 *
 * The launcher reuses nothing: every launch of this command opens a new window,
 * which is why callers must look for an existing one first.
 *
 * @param {{ proxy: string, userData: string }} browser — from browsers.js
 * @returns {Promise<number | null>} the new window handle, or null when the app
 *   is not installed / the launcher cannot be started / the window never appears
 */
export async function launchPwaApp(browser) {
  if (!browser || !browser.proxy) return null
  const app = findPwaApp(browser.userData)
  if (!app) return null
  const before = new Set(listChromeWindows().map((w) => w.hwnd))
  try {
    const child = spawn(browser.proxy, buildAppLaunchArgs(app.appId, app.profileDir), { detached: true, stdio: 'ignore' })
    child.unref()
  } catch {
    return null
  }
  return waitForNewPwaWindow(before, LAUNCH_TIMEOUT_MS)
}

/** The live DSH PWA window, or null when it is closed. */
export function findPwaWindow() {
  return pickPwaWindow(listChromeWindows(), process.pid)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Bring a window to the foreground, restoring it first when minimised.
 *
 * @param {number} hwnd
 * @returns {Promise<boolean>} true only when the system agrees it is in front
 */
export async function focusWindow(hwnd) {
  if (!Number.isInteger(hwnd) || hwnd <= 0) return false
  const a = loadWin32()
  if (!a) return false
  const target = BigInt(hwnd)
  const isFront = async () => Number(a.GetForegroundWindow()) === hwnd
  // A browser that starts its app window without focus parks it far off-screen
  // (x = -16000 or -32000) instead of minimising it. IsIconic() is false there,
  // so the window is "visible" to the enum and still invisible to the user; a
  // restore is what brings it back. Real windows never sit that far out, even
  // on a multi-monitor setup, so the bound is safe.
  const isParked = () => {
    const rect = Buffer.alloc(16)
    return a.GetWindowRect(target, rect) && rect.readInt32LE(0) <= -10000
  }
  try {
    if (a.IsIconic(target) || isParked()) a.ShowWindow(target, SW_RESTORE)
    a.SetForegroundWindow(target)
    await sleep(SETTLE_MS)
    if (await isFront()) return true
    // Second try: a minimize/restore pair makes Windows treat this as a fresh
    // activation, which is what defeats the foreground lock when the call
    // above is refused on behalf of another process.
    a.ShowWindow(target, SW_MINIMIZE)
    a.ShowWindow(target, SW_RESTORE)
    a.SetForegroundWindow(target)
    await sleep(RESTORE_SETTLE_MS)
    return await isFront()
  } catch {
    return false
  }
}
