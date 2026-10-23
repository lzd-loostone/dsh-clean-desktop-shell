/**
 * "Open DSH" — what every old "show the shell window" entry became.
 *
 * With the window gone, the page lives in whatever browser the user has.
 * Prefer the authenticated URL captured from a backend we started ourselves
 * (dsh mints a per-process launch token); otherwise fall back to the
 * configured target, then the local default.
 */
import { shell } from 'electron'
import { DEFAULT_TARGET_URL, loadConfig } from './config.js'
import { getAuthenticatedUrl } from './service.js'

export function dshUrl() {
  return getAuthenticatedUrl() || loadConfig().targetUrl || DEFAULT_TARGET_URL
}

/** Open DSH in the default browser. Returns the URL that was opened. */
export function openDsh() {
  const url = dshUrl()
  shell.openExternal(url).catch(() => {})
  return url
}
