/**
 * Which URL in a spawned backend's output may become the window target.
 *
 * Not "the first loopback URL". Plugins print their own local URLs while they
 * load — billion-context pins its model channel to `http://127.0.0.1:<random
 * port>` and serves its settings panel there — while dsh 0.2.0 announces its
 * own URL only after every plugin has settled. The blanket match this module
 * replaces therefore adopted a plugin's panel as the window target, so the
 * shell showed that page, or went offline once the plugin's ephemeral port
 * died, although dsh was listening on its own port the whole time.
 *
 * Rules, in order:
 *  1. dsh's own ready line wins: `dsh web: <url>`, and only a COMPLETE line,
 *     so a launch token is never adopted half-chunked. The `(LAN: …)` hint on
 *     that line is ignored — the window is local.
 *  2. Otherwise a pre-0.1.2 bare `http://127.0.0.1:<port>` is accepted, but
 *     only on the port this shell supervises: a stray URL on any other port
 *     can never be the local backend.
 *
 * Lives in its own module, free of any `electron` import, so it stays
 * unit-testable with `node --test` (the same reason probe.js does).
 */

/** dsh's own marker — its presence switches the rules below. */
const MARKER = /dsh web:/
/** dsh's own ready line — complete, so a chunked launch token cannot be taken. */
const READY_LINE = /dsh web:[^\r\n]*\r?\n/
/** The local URL on that line; a trailing `(LAN: …)` hint is not the target. */
const READY_URL = /dsh web:\s+(http:\/\/127\.0\.0\.1:\d+(?:\/[^\s)]*)?)/

/**
 * @param {string} text - accumulated stdout + stderr of the spawned backend.
 * @param {number} defaultPort - the port this shell supervises.
 * @returns {string|null} the URL to load, or null while none is trustworthy.
 */
export function parseReadyUrl(text, defaultPort) {
  const src = typeof text === 'string' ? text : ''
  // Once dsh's own marker appears, only its COMPLETE line may answer — the
  // bare fallback must not pick up a launch token that is still arriving.
  if (MARKER.test(src)) {
    const line = src.match(READY_LINE)
    const marked = line && line[0].match(READY_URL)
    return marked ? marked[1] : null
  }
  const port = Number(defaultPort)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  const bare = src.match(new RegExp('http://127\\.0\\.0\\.1:' + port + '(?![\\d])(?:/[^\\s)\"\']*)?'))
  return bare ? bare[0] : null
}
