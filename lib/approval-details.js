/**
 * dsh-clean-desktop-shell — pending-approval detail registry (host half).
 *
 * Pure helpers behind the `pendingApprovals` array that each state-file
 * session row carries. The waterfall observer in session-events.js holds
 * one request object at entry time ({toolName, reason}); it tracks a
 * normalized detail on the way in and removes that exact handle when the
 * downstream answerer chain settles — so add/remove pair by object
 * identity, never by name (concurrent requests may share a toolName).
 *
 * Backward compatibility: older shells ignore the extra key entirely.
 */

/** Cap for the human-readable reason written to the state file (chars). */
export const REASON_MAX = 400

/**
 * Normalize one approval request into a detail and append it to the list.
 * @param {Array<object>} list - mutable per-session detail array.
 * @param {{toolName?: unknown, reason?: unknown}} request - the live
 *   'approval/request' event object (only toolName/reason are projected).
 * @param {number} now - timestamp injected for testability.
 * @returns {object} the appended detail handle (pass it back to remove).
 */
export function pushApprovalDetail(list, request, now) {
  const req = request && typeof request === 'object' ? request : {}
  const toolName = typeof req.toolName === 'string' && req.toolName ? req.toolName : '未知工具'
  let reason = typeof req.reason === 'string' && req.reason ? req.reason : undefined
  if (reason !== undefined && reason.length > REASON_MAX) reason = reason.slice(0, REASON_MAX) + '…'
  const detail = { toolName, reason, since: Number.isFinite(now) ? now : Date.now() }
  list.push(detail)
  return detail
}

/**
 * Remove a previously pushed detail (identity match).
 * @param {Array<object>} list - the same array pushApprovalDetail used.
 * @param {object} detail - the exact handle returned by push.
 * @returns {boolean} whether a slot was removed.
 */
export function removeApprovalDetail(list, detail) {
  const at = list.indexOf(detail)
  if (at === -1) return false
  list.splice(at, 1)
  return true
}

/**
 * JSON-safe copy for the state file snapshot (never expose live handles).
 * @param {Array<object>} list - detail array of one session entry.
 * @returns {{toolName:string, reason?:string, since:number}[]} ordered copy,
 *   first item = the request the web composer shows as effective.
 */
export function approvalDetailsForWrite(list) {
  return list.map((d) => ({
    toolName: d.toolName,
    reason: d.reason,
    since: d.since,
  }))
}
