/**
 * Which browser owns the installed DSH app, and how to launch it.
 *
 * Chrome was the only target until the user ran ego lite, which is a Chromium
 * fork: same window class, same chrome_proxy.exe launcher, its own User Data
 * directory. Rather than hard-code Chrome, every known Chromium browser is
 * described here and the choice is: the Windows default browser when it has the
 * DSH app installed, otherwise the first browser that does.
 *
 * Nothing in this file touches the filesystem or the registry by default; both
 * are injected, so the selection rule is testable without a browser present.
 */
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const USER_CHOICE_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice'

/**
 * Every Chromium browser we can drive, resolved against an environment.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Array<{ id: string, name: string, progIds: string[], proxy: string, userData: string, tabSuffix: RegExp }>}
 */
export function browserDefinitions(env = process.env) {
  const local = env.LOCALAPPDATA || ''
  const pf = env.ProgramFiles || ''
  const pf86 = env['ProgramFiles(x86)'] || ''
  return [
    {
      id: 'chrome',
      name: 'Chrome',
      progIds: ['ChromeHTML'],
      proxy: join(pf, 'Google', 'Chrome', 'Application', 'chrome_proxy.exe'),
      userData: join(local, 'Google', 'Chrome', 'User Data'),
      tabSuffix: / - Google Chrome$/,
    },
    {
      id: 'edge',
      name: 'Edge',
      progIds: ['MSEdgeHTM'],
      proxy: join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge_proxy.exe'),
      userData: join(local, 'Microsoft', 'Edge', 'User Data'),
      tabSuffix: / - Microsoft Edge$/,
    },
    {
      id: 'brave',
      name: 'Brave',
      progIds: ['BraveHTML'],
      proxy: join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave_proxy.exe'),
      userData: join(local, 'BraveSoftware', 'Brave-Browser', 'User Data'),
      tabSuffix: / - Brave$/,
    },
    {
      id: 'vivaldi',
      name: 'Vivaldi',
      progIds: ['VivaldiHTM'],
      proxy: join(local, 'Vivaldi', 'Application', 'vivaldi_proxy.exe'),
      userData: join(local, 'Vivaldi', 'User Data'),
      tabSuffix: / - Vivaldi$/,
    },
    {
      id: 'ego',
      name: 'ego lite',
      progIds: [],
      proxy: join(pf, 'Citro Labs', 'ego lite', 'Application', 'chrome_proxy.exe'),
      userData: join(local, 'Citro Labs', 'ego lite', 'User Data'),
      tabSuffix: / - ego$/,
    },
  ]
}

/**
 * @param {ReturnType<typeof browserDefinitions>} definitions
 * @param {(path: string) => boolean} [exists]
 */
export function detectBrowsers(definitions, exists = existsSync) {
  return definitions.filter((b) => {
    try {
      return exists(b.proxy)
    } catch {
      return false
    }
  })
}

/**
 * @param {string} output — `reg query` stdout
 * @returns {string | null} e.g. 'ChromeHTML'
 */
export function parseDefaultProgId(output) {
  if (!output) return null
  const m = /ProgId\s+REG_SZ\s+(\S+)/i.exec(output)
  return m ? m[1] : null
}

/** The Windows default browser's ProgId, or null when it cannot be read. */
export function readDefaultBrowserProgId(run = execFileSync) {
  try {
    const out = run('reg', ['query', USER_CHOICE_KEY], { encoding: 'utf8' })
    return parseDefaultProgId(String(out))
  } catch {
    return null
  }
}

/**
 * The default browser when it knows our ProgId, else the first candidate.
 *
 * @param {Array<{ id: string, progIds?: string[] }>} browsers
 * @param {string | null} progId
 */
export function chooseBrowser(browsers, progId) {
  if (!browsers || browsers.length === 0) return null
  if (progId) {
    const hit = browsers.find((b) => (b.progIds || []).includes(progId))
    if (hit) return hit
  }
  return browsers[0]
}
