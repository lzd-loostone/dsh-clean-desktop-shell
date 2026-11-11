/**
 * Build core shared by `scripts/build.mjs` (CLI) and the package regression test.
 *
 * Two jobs, both zero-dependency and Windows-safe (`readFileSync`/`writeFileSync`, never
 * `cpSync`/`rmSync`: Windows copy fails to overwrite an existing file and the sandbox's
 * safe-delete shim intercepts removal):
 *
 * 1. Host modules: the original flat `src/host/*.js` entries stay flat in `lib/`, while the
 *    delegation modules are copied to `lib/host/*.js`. The subdirectory is not cosmetic: it
 *    keeps the same relative depth as `src/host/`, so `delegation-preset.js`'s
 *    `new URL('../../assets/delegation/persona.md', import.meta.url)` resolves to the same
 *    package asset from `src/` and from `lib/`.
 * 2. Client bundle: `src/client/client.js` stays the single registration; the pure helper
 *    `src/client/delegation-settings.js` is inlined verbatim (ESM `export` keywords stripped)
 *    into that same factory under module id
 *    `dsh-clean-desktop-shell/delegation-settings`, so no bare ESM import, network call or
 *    file read reaches the browser. `react` still comes from the loader module table.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Source of the single client registration. */
export const CLIENT_SOURCE = 'src/client/client.js'
/** Source of the pure helper that is inlined into that registration. */
export const HELPER_SOURCE = 'src/client/delegation-settings.js'
/** Module id the inlined helper answers inside the client factory. */
export const HELPER_ID = 'dsh-clean-desktop-shell/delegation-settings'
/** Marker proving an artifact already carries the composition (and never composes twice). */
export const INLINE_MARKER = `    // ---- build-time inline: ${HELPER_ID}`

/**
 * Frozen Task 5 assembly contract: the inlined namespace must expose exactly these names.
 * A mismatch fails the build instead of silently shipping a different surface.
 */
export const HELPER_EXPORTS = Object.freeze([
  'createDelegationSettingsController',
  'projectRunningChildren',
  'RUNNING_CAPSULE_LIMIT',
  'projectDelegationStatus',
  'projectWorkerCatalogue',
  'projectWorkerEfforts',
  'readDelegationResult',
  'PUBLIC_ERROR_CODES',
  'LABEL_KEYS',
  'DEFAULT_LABELS',
  'statusLabelKey',
  'errorLabelKey',
  'labelsFrom',
])

/**
 * Host copy pairs. Flat entries keep their historical `lib/` path (`main` is `lib/index.js`);
 * the delegation modules live under `lib/host/` so the persona asset depth is identical.
 */
/** Host modules that stay flat in `lib/` (their historical location). Everything else in
 * `src/host/` is copied to `lib/host/`, so a newly added module is picked up automatically
 * instead of silently missing from the package. */
const FLAT_HOST_MODULES = new Set([
  'index.js',
  'common.js',
  'runtime.js',
  'icon.js',
  'session-events.js',
  'approval-details.js',
  'bridge.js',
  'question-details.js',
])

/** Enumerate `src/host/*.js`, skipping tests, so no module can be forgotten. */
export const HOST_PAIRS = Object.freeze(
  readdirSync(new URL('../src/host/', import.meta.url))
    .filter((name) => name.endsWith('.js') && !name.endsWith('.test.js'))
    .sort()
    .map((name) => [
      `src/host/${name}`,
      FLAT_HOST_MODULES.has(name) ? `lib/${name}` : `lib/host/${name}`,
    ]),
)

/** The declaration line the inline block is inserted after (at most once in the source). */
const CLIENT_ANCHOR = `    var HELPER_ID = '${HELPER_ID}';`

const EXPORT_LINE = /^export (const|function|async function) ([A-Za-z_$][\w$]*)/
const UNSUPPORTED_EXPORT = /^export\b/

/**
 * Strip top-level ESM export keywords from the helper. Only the two forms the frozen helper
 * uses are accepted; `export default`, `export {}`, `export *` and `export let/var` fail the
 * build loudly rather than changing what the browser receives.
 * @param {string} helperSource
 * @returns {{ body: string, names: string[] }}
 */
export function stripHelperExports(helperSource) {
  const names = []
  const lines = helperSource.split('\n').map((line) => {
    if (!line.startsWith('export')) return line
    const match = EXPORT_LINE.exec(line)
    if (match === null) {
      throw new Error(`build: unsupported helper export form: ${line.slice(0, 60)}`)
    }
    names.push(match[2])
    return line.slice('export '.length)
  })
  return { body: lines.join('\n'), names }
}

/**
 * Compose the single client bundle artifact.
 * @param {string} clientSource
 * @param {string} helperSource
 * @returns {string}
 */
export function composeClient(clientSource, helperSource) {
  if (clientSource.includes(INLINE_MARKER)) {
    throw new Error('build: the client source already contains the inline block')
  }
  const first = clientSource.indexOf(CLIENT_ANCHOR)
  if (first < 0) throw new Error(`build: client anchor not found: ${CLIENT_ANCHOR.trim()}`)
  if (clientSource.indexOf(CLIENT_ANCHOR, first + 1) >= 0) {
    throw new Error('build: the client anchor must occur exactly once')
  }
  const { body, names } = stripHelperExports(helperSource)
  const missing = HELPER_EXPORTS.filter((name) => !names.includes(name))
  const extra = names.filter((name) => !HELPER_EXPORTS.includes(name))
  if (missing.length > 0 || extra.length > 0 || names.length !== new Set(names).size) {
    throw new Error(`build: helper export surface drifted (missing: ${missing.join(',') || '-'}; extra: ${extra.join(',') || '-'})`)
  }
  const block = [
    '',
    INLINE_MARKER + ' ------------------------------------------------',
    `    // Generated verbatim from ${HELPER_SOURCE} by scripts/build-lib.mjs.`,
    '    // No bare ESM import, no network call and no file read reaches the browser.',
    '    var __inlinedDelegationSettings = (function () {',
    body,
    '      return Object.freeze({',
    ...names.map((name) => `        ${name}: ${name},`),
    '      });',
    '    })();',
    '    var __externalRequire = require;',
    '    require = function (id) {',
    '      if (id === HELPER_ID) return __inlinedDelegationSettings;',
    '      return __externalRequire(id);',
    '    };',
  ].join('\n')
  const end = first + CLIENT_ANCHOR.length
  return `${clientSource.slice(0, end)}\n${block}${clientSource.slice(end)}`
}

/** @param {string} text */
export function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Write the whole build output below `root`.
 * @param {{ root: string }} options
 * @returns {{ files: string[], clientSha256: string }}
 */
export function buildLib({ root } = {}) {
  if (typeof root !== 'string' || root.length === 0) throw new TypeError('buildLib: root is required')
  mkdirSync(join(root, 'lib'), { recursive: true })
  for (const [source, dest] of HOST_PAIRS) {
    const target = join(root, dest)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, readFileSync(join(root, source)))
  }
  const client = composeClient(
    readFileSync(join(root, CLIENT_SOURCE), 'utf8'),
    readFileSync(join(root, HELPER_SOURCE), 'utf8'),
  )
  writeFileSync(join(root, 'lib/client.js'), client)
  return { files: [...HOST_PAIRS.map(([, dest]) => dest), 'lib/client.js'], clientSha256: sha256(client) }
}
