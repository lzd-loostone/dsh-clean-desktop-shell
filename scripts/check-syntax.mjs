/**
 * Syntax gate: `node --check` every JS file that ships in the package
 * (electron/ main-process modules + lib/ host/client bundle). Previously
 * only lib/index.js was checked — a syntax slip in any other file shipped
 * unnoticed.
 *
 * The two sandboxed preloads are CommonJS (require/module.exports) while
 * package.json declares "type": "module", so plain --check on them fails
 * spuriously; they are validated through a temporary .cjs copy instead.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
// CJS files relative to electron/ — parsed as CommonJS despite the ESM package.
const CJS_FILES = new Set(['progress-preload.js', 'overlay-preload.js', 'overlay-settings-preload.js', 'bubble-preload.js', 'menu-preload.js', 'approval-preload.js'])

/**
 * Every .js file below `dir`, recursively, as paths relative to the package root.
 * `lib/` now carries `lib/host/*.js` for the delegation modules, so a flat
 * readdir would silently skip exactly the new files this gate exists for.
 */
function listJs(dir) {
  const out = []
  const walk = (relative) => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const next = `${relative}/${entry.name}`
      if (entry.isDirectory()) walk(next)
      else if (entry.name.endsWith('.js')) out.push(next)
    }
  }
  walk(dir)
  return out.sort()
}

const scratch = mkdtempSync(join(tmpdir(), 'dsh-shell-check-'))
let bad = 0
let checked = 0

try {
  for (const dir of ['electron', 'lib']) {
    for (const f of listJs(dir)) {
      const full = join(root, f)
      if (!statSync(full).isFile()) continue
      const cjs = CJS_FILES.has(basename(f))
      const target = cjs ? join(scratch, `${dir}-${basename(f)}.cjs`) : full
      if (cjs) writeFileSync(target, readFileSync(full))
      const r = spawnSync(process.execPath, ['--check', target], { stdio: 'pipe' })
      const ok = r.status === 0
      checked++
      if (!ok) {
        bad++
        console.log(`  FAIL ${f}${cjs ? ' (checked as CJS)' : ''}`)
        if (r.stderr) console.error(r.stderr.toString().trim())
      } else {
        console.log(`  ok   ${f}${cjs ? ' (checked as CJS)' : ''}`)
      }
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(bad === 0 ? `PASS (${checked} files)` : `FAIL (${bad}/${checked} file(s))`)
process.exit(bad === 0 ? 0 : 1)
