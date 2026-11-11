/**
 * dsh-clean-desktop-shell — pure display decisions for the orb badge and the
 * bubble's row-end child ring.
 *
 * Deliberately DOM-free and electron-free: the renderer (overlay.html /
 * bubble.html) only paints what these functions return, and the same numbers
 * are unit-tested here instead of being inferred from computed styles.
 *
 * Both surfaces answer one question — "how much work is moving right now" —
 * without adding a click target: the badge counts live SESSIONS, the ring
 * counts running CHILDREN of one session.
 */

/** Ring label cap: ten or more reads as `9+` so the 22px ring never widens. */
export const RING_MAX_LABEL = 9

/**
 * Format a count for a fixed-width slot.
 * @param {unknown} value
 * @returns {string}
 */
export function ringLabel(value) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
  return n >= RING_MAX_LABEL + 1 ? `${RING_MAX_LABEL}+` : String(n)
}

/** A pending request is the only thing that outranks "busy". */
function hasPending(row) {
  if (!row || typeof row !== 'object') return false
  const approvals = typeof row.approvals === 'number' ? row.approvals : 0
  const questions = typeof row.questions === 'number' ? row.questions : 0
  if (approvals + questions > 0) return true
  // Approval/question raised inside a child: the parent row cannot open it,
  // but it is still a human decision waiting under this row.
  if (typeof row.childrenPending === 'number' && row.childrenPending > 0) return true
  // Display rows carry the kind instead of the raw counts.
  return row.kind === 'approval' || row.kind === 'question'
}

/**
 * Row-end ring state for one session.
 * @param {{childrenRunning?: number, approvals?: number, questions?: number, kind?: string}} [row]
 * @param {{reducedMotion?: boolean}} [opts]
 * @returns {{visible: boolean, count: number, label: string, tone: 'busy'|'attention'|'idle', animated: boolean}}
 */
export function ringState(row, opts = {}) {
  const raw = row && typeof row === 'object' ? row.childrenRunning : 0
  const count = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0
  const visible = count > 0
  return {
    visible,
    count,
    label: ringLabel(count),
    tone: hasPending(row) ? 'attention' : visible ? 'busy' : 'idle',
    animated: opts.reducedMotion !== true,
  }
}

/** A row is live when the agent runs, a child runs, or a human is needed. */
function rowLive(row) {
  if (!row || typeof row !== 'object') return false
  if (typeof row.live === 'boolean') return row.live
  if (row.running === true) return true
  if (typeof row.childrenRunning === 'number' && row.childrenRunning > 0) return true
  if (hasPending(row)) return true
  return false
}

/**
 * Orb badge state: how many sessions are doing anything at all.
 * @param {object[]} [rows] display rows (or session rows — both understand `live`)
 * @param {{reducedMotion?: boolean, extraLive?: number}} [opts] `extraLive` folds
 *   in activity that owns no row of its own (children with an unknown parent).
 * @returns {{visible: boolean, count: number, label: string, tone: 'busy'|'attention'|'idle', animated: boolean}}
 */
export function badgeState(rows, opts = {}) {
  const list = Array.isArray(rows) ? rows : []
  let count = 0
  let attention = false
  for (const row of list) {
    if (!rowLive(row)) continue
    count += 1
    if (hasPending(row)) attention = true
  }
  const extra = typeof opts.extraLive === 'number' && Number.isFinite(opts.extraLive) ? Math.max(0, Math.trunc(opts.extraLive)) : 0
  count += extra
  return {
    visible: count > 0,
    count,
    label: ringLabel(count),
    tone: attention ? 'attention' : count > 0 ? 'busy' : 'idle',
    animated: opts.reducedMotion !== true,
  }
}
