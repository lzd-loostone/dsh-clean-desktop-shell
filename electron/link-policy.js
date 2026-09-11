/**
 * dsh-clean-desktop-shell — link-window URL policy (pure, unit-tested).
 *
 * Decides what happens when the main window tries to open a new window
 * (target=_blank links, window.open): a self-drawn in-shell link window,
 * the system handler, or nothing at all.
 */

const LINK_WINDOW_PROTOCOLS = new Set(['http:', 'https:'])
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:', 'sms:', 'webcal:', 'file:'])

/**
 * @param {string} raw candidate URL from setWindowOpenHandler
 * @returns {{action: 'link-window'|'external'|'deny', url?: string}}
 */
export function classifyUrl(raw) {
  if (typeof raw !== 'string' || !raw) return { action: 'deny' }
  let u
  try {
    u = new URL(raw)
  } catch {
    return { action: 'deny' } // relative garbage — nothing sane to open
  }
  if (LINK_WINDOW_PROTOCOLS.has(u.protocol)) return { action: 'link-window', url: u.href }
  if (EXTERNAL_PROTOCOLS.has(u.protocol)) return { action: 'external', url: u.href }
  // javascript:, data:, blob:, unknown custom schemes: never open anywhere.
  return { action: 'deny' }
}

/**
 * Allowlist for shell.openExternal (defense in depth: preload IPC messages
 * are validated again before reaching the OS handler).
 * @param {string} raw
 * @returns {boolean}
 */
export function canOpenExternally(raw) {
  if (typeof raw !== 'string' || !raw) return false
  try {
    return EXTERNAL_PROTOCOLS.has(new URL(raw).protocol)
  } catch {
    return false
  }
}
