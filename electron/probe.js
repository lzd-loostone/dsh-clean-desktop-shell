/**
 * Backend liveness probe — the one HTTP question the shell asks to decide
 * whether the dsh web service is up.
 *
 * Lives in its own module, free of any `electron` import, so it stays
 * unit-testable with `node --test` (every other module under electron/ needs
 * app paths at import time).
 *
 * A late answer from a starved process is not a death: only "nothing is
 * listening" matters here, and the caller reads that as one boolean.
 */

/** True when the service answers with anything below 5xx. Never throws. */
export async function probe(url, timeoutMs = 1500) {
  try {
    // AbortSignal.timeout is the standard self-cleaning timeout — no manual
    // controller/timer pair to leak when fetch rejects first.
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' })
    // Any answer below 5xx is a live, usable service. A 5xx means the process
    // is up but unhappy: not something to serve pages from, but not a death
    // the supervisor should act on either.
    return res.status < 500
  } catch {
    return false
  }
}
