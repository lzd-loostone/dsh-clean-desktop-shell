#!/usr/bin/env node
// Compares the pinned official PTC snapshot with the harness checkout's ptc.patch.yml.
// A stale snapshot is exactly what made the whole preset disappear twice; this gate
// fails loudly instead of waiting for a user to notice a missing preset.
//
// Only (id, name) pairs in appearance order are compared, so cosmetic YAML changes
// do not fail while added/removed/renamed rows always do. No YAML dependency: the
// row list is a simple indented sequence and a line-level scan is enough.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = process.env.HARNESS_PTC_FILE
  ? resolve(process.env.HARNESS_PTC_FILE)
  : join(root, '..', 'deepseek-harness', 'packages', 'bundle', 'web-app', 'presets', 'ptc.patch.yml')
const snapshotPath = join(root, 'assets', 'delegation', 'official-ptc.json')

if (!existsSync(source)) {
  console.log(`[check-preset-snapshot] skip: harness PTC source not found at ${source}`)
  process.exit(0)
}

/** Strip YAML quotes and trailing comments from a scalar value. */
function scalar(text) {
  const value = text.trim()
  if (value.length >= 2 && ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"')))) {
    return value.slice(1, -1)
  }
  return value.replace(/\s+#.*$/, '')
}

/** Extracts [id, name] pairs from the sequence below the preset's `plugins:` key. */
function extractRows(yaml) {
  const rows = []
  let pluginsIndent = -1
  let pending = null
  for (const line of yaml.split(/\r?\n/)) {
    if (pluginsIndent < 0) {
      const start = /^(\s*)plugins:\s*$/.exec(line)
      if (start) pluginsIndent = start[1].length
      continue
    }
    if (!line.trim() || /^\s*#/.test(line)) continue
    const indent = /^\s*/.exec(line)[0].length
    // A non-empty line dedented to or above plugins: ends the preset block.
    if (indent <= pluginsIndent) break
    const item = /^(\s*)-\s+id:\s*(.+)$/.exec(line)
    if (item) {
      if (pending) rows.push([pending.id, pending.name ?? ''])
      pending = { id: scalar(item[2]), indent: item[1].length, name: null }
      continue
    }
    const name = /^(\s*)name:\s*(.+)$/.exec(line)
    if (pending && name && pending.name === null && name[1].length > pending.indent) {
      pending.name = scalar(name[2])
    }
  }
  if (pending) rows.push([pending.id, pending.name ?? ''])
  return rows
}

/** Flattens the snapshot's rows, including nested `cordis:group` config children. */
function flatten(rows) {
  const pairs = []
  for (const row of rows) {
    pairs.push([row.id, row.name])
    if (Array.isArray(row.config)) pairs.push(...flatten(row.config))
  }
  return pairs
}

const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'))
const expected = flatten(snapshot.rows)
const actual = extractRows(readFileSync(source, 'utf8'))
const problems = []
const length = Math.max(expected.length, actual.length)
for (let index = 0; index < length; index += 1) {
  const want = expected[index]
  const got = actual[index]
  if (!want) problems.push(`  + extra in source: ${got[0]} (${got[1]})`)
  else if (!got) problems.push(`  - missing from source: ${want[0]} (${want[1]})`)
  else if (want[0] !== got[0] || want[1] !== got[1]) {
    problems.push(`  ~ index ${index}: snapshot ${want[0]} (${want[1]}) != source ${got[0]} (${got[1]})`)
  }
}

if (problems.length > 0) {
  console.error(`[check-preset-snapshot] FAIL: ${snapshotPath} drifted from ${source}`)
  for (const problem of problems) console.error(problem)
  process.exit(1)
}

console.log(`[check-preset-snapshot] ok: ${expected.length} rows match ${source}`)
