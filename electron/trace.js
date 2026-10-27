/**
 * Append-only diagnostics for the shell's own actions.
 *
 * A jump or a focus that silently does nothing is the hardest failure to
 * report, so every hop appends a line here. The file caps itself so it cannot
 * grow without bound.
 */
import { app } from 'electron'
import { appendFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MAX_BYTES = 256 * 1024

export function trace(msg) {
  try {
    const file = join(app.getPath('userData'), 'overlay-trace.log')
    try {
      if (statSync(file).size > MAX_BYTES) rmSync(file, { force: true })
    } catch {
      // first write
    }
    appendFileSync(file, new Date().toISOString() + ' ' + msg + '\n', 'utf8')
  } catch {
    // tracing must never break the shell
  }
}
