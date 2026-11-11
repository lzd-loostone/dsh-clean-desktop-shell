/**
 * Backend liveness probe — the one HTTP question the shell asks to decide
 * whether the dsh web service is up.
 *
 * Lives in its own module, free of any `electron` import, so it stays
 * unit-testable with `node --test` (every other module under electron/ needs
 * app paths at import time).
 *
 * A late answer from a starved process is not a death: only "nothing is
 * listening" matters for liveness, so the default budget is generous (3s).
 * The answer is graded, not collapsed to a boolean, because a token-gated
 * root answering 401 is alive but unusable for a window we did not mint a
 * token for.
 */

/**
 * Default probe budget. A plugin page load can starve the backend for well
 * over a second (the market page pulls multi-megabyte JSON); 1.5s read that
 * as death and reloaded every open page.
 */
export const DEFAULT_PROBE_TIMEOUT_MS = 3000

/**
 * Ask the service one HTTP question and grade the answer.
 *
 * @param {string} url
 * @param {number} [timeoutMs]
 * @returns {Promise<{ kind: 'ok' | 'unauthenticated' | 'unhealthy' | 'down' | 'timeout', status: number | null }>}
 *   `ok` — a usable answer; `unauthenticated` — alive but this caller has no
 *   session (401/403), which a window without a token would hit; `unhealthy`
 *   — the process answers 5xx; `down` — nothing answered inside the budget.
 */
export async function probeOutcome(url, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
  try {
    // AbortSignal.timeout is the standard self-cleaning timeout — no manual
    // controller/timer pair to leak when fetch rejects first.
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' })
    const status = res.status
    if (status === 401 || status === 403) return { kind: 'unauthenticated', status }
    if (status >= 500) return { kind: 'unhealthy', status }
    return { kind: 'ok', status }
  } catch (err) {
    // A timeout is NOT proof of death. A busy backend (a big projection, an
    // LLM turn) can answer slower than the budget while still serving the
    // open page; treating that as down made the orb flash 后端未连接 and then
    // recover. Only an immediate failure (refused/reset) means down.
    const name = err && err.name ? String(err.name) : ''
    if (name === 'TimeoutError' || name === 'AbortError') return { kind: 'timeout', status: null }
    return { kind: 'down', status: null }
  }
}

/** True when the service answers with anything below 5xx. Never throws. */
export async function probe(url, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
  const outcome = await probeOutcome(url, timeoutMs)
  // `timeout` counts as alive: the process answered nothing in time, but it
  // was not proven dead, and the previous state is the honest one to keep.
  return outcome.kind === 'ok' || outcome.kind === 'unauthenticated' || outcome.kind === 'timeout'
}
