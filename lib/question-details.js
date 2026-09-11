/**
 * dsh-clean-desktop-shell — pending-question batch registry (host half).
 *
 * Pure helpers behind the `pendingQuestions` array that each state-file
 * session row carries. The 'user-questions/request' waterfall observer holds
 * the live request ({questions, agent, signal}); a serializable batch is
 * tracked on entry and removed by identity when the downstream answerer
 * chain settles.
 *
 * The bubble answers IN-BATCH ONLY when every projected page is a faithful
 * copy of the live request (ids exact, labels exact, whole batch visible),
 * because PendingQuestion.answer() requires one complete answer covering
 * every question. Anything that could produce a partial or mis-echoed
 * answer — oversized batches, too many options, labels/ids we must truncate,
 * malformed shape — flips `uiOnly`, and the card degrades to read + jump.
 *
 * Backward compatibility: older shells ignore the extra key entirely.
 */

/** Display caps (truncation is cosmetic; exceeding a fidelity cap = uiOnly). */
export const Q_TEXT_MAX = 300
export const Q_DETAIL_MAX = 400
export const Q_LABEL_MAX = 80
/** Max questions the card paginates; a bigger batch answers in the UI. */
export const Q_MAX_PAGES = 6
/** Max options rendered per question; more than this answers in the UI. */
export const Q_MAX_OPTIONS = 8

function clip(v, max) {
  const s = typeof v === 'string' ? v : ''
  return s.length > max ? s.slice(0, max) + '…' : s
}

/**
 * Normalize one live request into a serializable batch and append it.
 * @param {Array<object>} list - mutable per-session batch array.
 * @param {{questions?: unknown}} request - the 'user-questions/request'
 *   event object (agent/signal are never projected).
 * @param {number} now - injected timestamp.
 * @returns {object} the appended batch handle (pair to remove), or null
 *   when there is nothing to track.
 */
export function captureQuestionBatch(list, request, now) {
  const req = request && typeof request === 'object' ? request : {}
  const raw = Array.isArray(req.questions) ? req.questions : []
  if (raw.length === 0) return null
  let uiOnly = raw.length > Q_MAX_PAGES
  const pages = []
  for (const item of raw.slice(0, Q_MAX_PAGES)) {
    const q = item && typeof item === 'object' ? item : {}
    const page = {
      id: typeof q.id === 'string' && q.id ? q.id : '',
      q: clip(q.question, Q_TEXT_MAX),
    }
    if (!page.id) uiOnly = true
    if (typeof q.question !== 'string' || !q.question) uiOnly = true
    if (typeof q.header === 'string' && q.header) page.header = clip(q.header, 40)
    if (typeof q.detail === 'string' && q.detail) page.detail = clip(q.detail, Q_DETAIL_MAX)
    if (q.multiSelect === true) page.multi = true
    if (q.intent && q.intent.kind === 'plan-review') page.plan = true
    if (Array.isArray(q.options) && q.options.length > 0) {
      if (q.options.length > Q_MAX_OPTIONS) {
        uiOnly = true
        page.opts = q.options.slice(0, Q_MAX_OPTIONS).map((o) => clip(o && o.label, Q_LABEL_MAX))
      } else {
        const labels = q.options.map((o) => (o && typeof o.label === 'string' ? o.label : ''))
        if (labels.some((l) => !l || l.length > Q_LABEL_MAX)) uiOnly = true
        page.opts = labels.map((l) => clip(l, Q_LABEL_MAX))
      }
    }
    pages.push(page)
  }
  const batch = {
    since: Number.isFinite(now) ? now : Date.now(),
    n: raw.length,
    uiOnly,
    pages,
  }
  list.push(batch)
  return batch
}

/**
 * Remove a previously captured batch (identity match).
 * @param {Array<object>} list - the same array the capture used.
 * @param {object} batch - the exact handle returned by capture.
 * @returns {boolean} whether a slot was removed.
 */
export function removeQuestionBatch(list, batch) {
  const at = list.indexOf(batch)
  if (at === -1) return false
  list.splice(at, 1)
  return true
}

/**
 * JSON-safe copy for the state file (never expose live handles).
 * @param {Array<object>} list - batch array of one session entry.
 * @returns {object[]} ordered copy, first item = effective request.
 */
export function questionBatchesForWrite(list) {
  return list.map((b) => ({
    since: b.since,
    n: b.n,
    uiOnly: b.uiOnly,
    pages: b.pages.map((p) => ({
      id: p.id,
      q: p.q,
      header: p.header,
      detail: p.detail,
      multi: p.multi,
      plan: p.plan,
      opts: p.opts,
    })),
  }))
}
