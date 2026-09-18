/**
 * Backend liveness probe — the one HTTP question the shell asks to decide
 * whether the dsh web service is up.
 *
 * Lives in its own module, free of any `electron` import, so it stays
 * unit-testable with `node --test` (every other module under electron/ needs
 * app paths at import time) and is shared by the backend supervisor and the
 * window watchdog instead of each growing its own fetch.
 *
 * What matters is WHY a request failed:
 *  - refused / unreachable → nothing is listening: the backend really is gone;
 *  - timeout / reset / 5xx → something is there but not answering in time.
 *    A machine pinned by an IDE or Gradle build stalls a live process for
 *    seconds, so a late answer says nothing about the process being dead —
 *    callers use `fatal` to avoid tearing down a working page over a hiccup
 *    (see startWatch in window.js).
 *
 * @typedef {object} ProbeResult
 * @property {boolean} alive  Something answered with a usable status code.
 * @property {boolean} fatal  The failure proves no process is listening.
 * @property {string} why     Short reason for the log ('HTTP 401', 'TIMEOUT',
 *                            'ECONNREFUSED', ...).
 */

// Only connection-level "nobody is home" errors. Everything else — including
// a local stack that drops the socket (ECONNABORTED/ECONNRESET) — is treated
// as "not answering right now", which is the safe read on a loaded machine.
const FATAL_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH'])

/** Probe `url` and keep the failure kind. Never throws. */
export async function probeDetail(url, timeoutMs = 1500) {
  try {
    // AbortSignal.timeout is the standard self-cleaning timeout — no manual
    // controller/timer pair to leak when fetch rejects first.
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' })
    // Any answer below 5xx is a live, usable service. A 5xx means the process
    // is up but unhappy: not fatal, and still not something to serve pages
    // from (same call the old probe made).
    return { alive: res.status < 500, fatal: false, why: 'HTTP ' + res.status }
  } catch (err) {
    // fetch reports transport failures as TypeError('fetch failed') with the
    // real code on .cause; an AbortSignal.timeout reports TimeoutError.
    const code = err && err.name === 'TimeoutError'
      ? 'TIMEOUT'
      : String((err && err.cause && err.cause.code) || (err && err.code) || (err && err.name) || err)
    return { alive: false, fatal: FATAL_CODES.has(code), why: code }
  }
}

/** True when the service answers with anything below 5xx. */
export async function probe(url, timeoutMs = 1500) {
  return (await probeDetail(url, timeoutMs)).alive
}
