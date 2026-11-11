/**
 * What a `start` request should do, decided without touching Electron.
 *
 * Two rules were learned the hard way and live here so they are testable:
 *
 *  - A backend that answers but was not started by this process carries a
 *    launch token we never saw, so a window opened against it lands on the
 *    401 page. The only way to obtain a token is to restart the backend.
 *  - A failed spawn is usually a port still held by the previous process, so
 *    one retry after the port is cleared is worth it; more than one would turn
 *    a real failure into a slow one.
 */

/**
 * @param {{ health: 'ok' | 'unauthenticated' | 'unhealthy' | 'down',
 *   hasOwnChild: boolean, hasToken: boolean }} input
 *   `health` is the graded probe answer; `hasOwnChild` records whether the
 *   listening process is the one this shell spawned; `hasToken` whether that
 *   process's authenticated URL is already known.
 * @returns {'reuse' | 'spawn'}
 */
export function decideStartPlan({ health, hasOwnChild, hasToken }) {
  // Anything that answers is left alone, token or not. An earlier revision
  // restarted a running-but-tokenless backend to mint a launch token, and one
  // orb click then killed the backend hosting the user's live sessions — the
  // browser's persistent cookie authenticates a plain URL on its own, and a
  // restart is never worth a user's session.
  if (health === 'ok' || health === 'unauthenticated') return 'reuse'
  return 'spawn'
}

/**
 * @param {number} attempt — 1-based attempt number that just failed.
 * @returns {boolean} whether one more attempt is allowed.
 */
export function shouldRetrySpawn(attempt) {
  return attempt === 1
}

/**
 * Whether an occupied port should stop the start instead of racing it.
 *
 * `dsh web` does not refuse a taken port: it brings up a second backend on
 * another one, which the shell then reports as a successful start while the
 * page the user wanted still answers from the first process. Aborting with a
 * clear error is the only honest outcome.
 *
 * @param {boolean} portFree — result of clearing the supervised port.
 * @returns {boolean} true when the spawn must not run.
 */
export function shouldAbortSpawn(portFree) {
  return !portFree
}
