/**
 * dsh-clean-desktop-shell — durable "read" marks for finished sessions.
 *
 * The overlay's white dot badge is transition-driven (a session goes
 * running → finished while the shell is alive). This store records, per
 * session id, the wall-clock moment the user acknowledged it — either by
 * clicking its bubble row or by the bubble's 「一键清除」 button. A completion
 * whose `finishedAt` is not strictly later than the mark stays silent, so
 * re-observed transitions (duplicate snapshots, host state churn) cannot
 * re-light a badge the user already cleared. A genuinely new later run of
 * the same session still re-lights: `finishedAt > readAt`.
 *
 * Persistence is a best-effort tiny JSON file next to the state file
 * (`$DSH_HOME/desktop-shell-read.json`), written atomically (tmp + rename).
 * Every failure path is swallowed — losing read marks degrades to the old
 * in-memory behaviour, it must never break the overlay.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

/** Safety cap: drop the oldest marks beyond this many ids. */
export const MAX_READ_ENTRIES = 500

/**
 * Parse the file body into an id → readAt map. Corrupt or non-object JSON
 * yields an empty map (the next successful save rewrites a healthy file).
 * @param {string} text raw file content
 * @returns {Map<string, number>}
 */
export function parseReadData(text) {
  const map = new Map()
  try {
    const data = JSON.parse(text)
    if (data && typeof data === 'object' && data.read && typeof data.read === 'object') {
      for (const [id, at] of Object.entries(data.read)) {
        if (typeof at === 'number' && Number.isFinite(at)) map.set(id, at)
      }
    }
  } catch {
    // corrupt file — start clean
  }
  return map
}

/** Serialize the map back to the file format. @param {Map<string, number>} map @returns {string} */
export function serializeReadData(map) {
  return JSON.stringify({ read: Object.fromEntries(map), updatedAt: Date.now() })
}

/**
 * Decide whether a finished observation deserves a badge.
 * True when the id was never read, or the completion happened STRICTLY
 * after the read mark (a new run re-lights; a re-observed old one does not).
 * @param {Map<string, number>} map read marks
 * @param {string} id session id
 * @param {number|undefined} finishedAt completion time reported by the state file (may be absent)
 * @param {number} now shell's current time (fallback when finishedAt is absent)
 * @returns {boolean}
 */
export function shouldMarkUnread(map, id, finishedAt, now) {
  const readAt = map.get(id)
  if (readAt === undefined) return true
  const at = Number.isFinite(finishedAt) ? finishedAt : now
  return at > readAt
}

/**
 * Trim the map: keep only ids present in `activeIds`, then cap the size by
 * dropping the oldest readAt entries. Mutates and returns the map.
 * @param {Map<string, number>} map
 * @param {Iterable<string>} activeIds ids currently present in the state file
 * @param {number} [max]
 * @returns {Map<string, number>}
 */
export function pruneReadMap(map, activeIds, max = MAX_READ_ENTRIES) {
  const active = new Set(activeIds)
  for (const id of [...map.keys()]) if (!active.has(id)) map.delete(id)
  if (map.size > max) {
    const byAge = [...map.entries()].sort((a, b) => a[1] - b[1])
    for (const [id] of byAge.slice(0, map.size - max)) map.delete(id)
  }
  return map
}

/**
 * File-backed store. `load()` must be called once at startup; every
 * mutation updates the in-memory map and attempts a best-effort save.
 * @param {string} filePath absolute path of the JSON file
 * @param {{now?: () => number}} [opts] injectable clock for tests
 */
export function createReadStore(filePath, opts = {}) {
  const now = opts.now ?? (() => Date.now())
  /** @type {Map<string, number>} */
  let marks = new Map()
  let dirty = false

  return {
    /** Read the persisted marks from disk (call once at startup). */
    load() {
      try {
        if (existsSync(filePath)) marks = parseReadData(readFileSync(filePath, 'utf8'))
      } catch {
        marks = new Map()
      }
      return marks
    },
    /** Live view of the map (read-only use). */
    marks: () => marks,
    /** Acknowledge one session (row click). Persists immediately. */
    markRead(id) {
      if (typeof id !== 'string' || !id) return
      marks.set(id, now())
      dirty = true
      this.save()
    },
    /** Acknowledge many sessions at once (一键清除). Persists once. */
    markAll(ids) {
      const at = now()
      let changed = false
      for (const id of ids) {
        if (typeof id === 'string' && id) { marks.set(id, at); changed = true }
      }
      if (changed) { dirty = true; this.save() }
    },
    /** Badge gate consulted by applySnapshot on each running→done edge. */
    isRead(id, finishedAt) {
      return !shouldMarkUnread(marks, id, finishedAt, now())
    },
    /** Drop marks for sessions gone from the state file, then save if changed. */
    prune(activeIds) {
      const before = marks.size
      pruneReadMap(marks, activeIds)
      if (marks.size !== before) { dirty = true; this.save() }
    },
    /** Atomic best-effort write. Never throws. */
    save() {
      if (!dirty) return
      try {
        writeFileSync(filePath + '.tmp', serializeReadData(marks), 'utf8')
        renameSync(filePath + '.tmp', filePath)
        dirty = false
      } catch {
        // next mutation retries; the overlay must survive a dead store
      }
    },
  }
}
