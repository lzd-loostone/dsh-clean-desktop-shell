/**
 * dsh-clean-desktop-shell — question hover-card display model (pure).
 *
 * Picks which of a session's pending question batches the card shows: the
 * first, = the request the web composer treats as effective; later batches
 * only count into "+N". Pages/uiOnly/n pass through untouched — the card
 * renderer turns them into pages, and the client half re-validates every
 * echo against the live request before answering.
 */

/**
 * Effective question info for one state-file session row.
 * @param {object|undefined|null} session - {pendingQuestions?, lastChangeAt?}
 * @returns {{n:number, uiOnly:boolean, pages:object[], since:number, more:number}|null}
 *   null when there is no usable detail (older backend without the field).
 */
export function pickQuestionInfo(session) {
  if (!session || !Array.isArray(session.pendingQuestions)) return null
  const list = session.pendingQuestions
  if (list.length === 0) return null
  const first = list[0]
  const base = {
    n: 0,
    uiOnly: true,
    pages: [],
    since: Number.isFinite(session.lastChangeAt) ? session.lastChangeAt : 0,
    more: Math.max(0, list.length - 1),
  }
  if (!first || typeof first !== 'object') return base
  if (Number.isFinite(first.n)) base.n = first.n
  if (typeof first.uiOnly === 'boolean') base.uiOnly = first.uiOnly
  if (Array.isArray(first.pages)) base.pages = first.pages
  if (Number.isFinite(first.since)) base.since = first.since
  return base
}
