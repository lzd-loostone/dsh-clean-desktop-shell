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
 *
 * This module also owns the READ side of the host's state file
 * (`normalizeSnapshot`): both files are cross-version handoffs between a
 * backend that may be newer than the shell and vice versa, so defaults live
 * here, next to the read marks, rather than inside the window code.
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

// ---------- state-file read side (desktop-shell-state.json) ----------
//
// The state file is a cross-version handoff: the host half may be newer than
// the shell (old shell reads a v2 file) or older (v2 shell reads a v1 file
// left by a not-yet-restarted backend). Every field below is therefore
// defaulted here instead of trusted, and the shell never branches on `v`:
// a v1 row simply has no child counters, so `live` is derived from what the
// v1 writer did record.

/** Finite number or the fallback. */
function num(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Non-negative integer count. */
function count(value) {
  return Math.max(0, Math.trunc(num(value)))
}

/** Finite timestamp or null (the UI renders "no time" as absence). */
function stamp(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Normalize one parsed state file into the shape the overlay renders.
 * Unknown/corrupt entries are dropped rather than half-filled, so a damaged
 * row cannot crash a send.
 * @param {unknown} raw parsed JSON (any version, possibly garbage)
 * @returns {{v:number, ts:number, disposed:boolean, sessions:object[], orphanChildren:{running:number,total:number}}}
 */
export function normalizeSnapshot(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const list = Array.isArray(src.sessions) ? src.sessions : []
  const sessions = []
  for (const s of list) {
    if (!s || typeof s !== 'object') continue
    const id = typeof s.id === 'string' ? s.id : ''
    if (!id) continue
    const running = s.running === true
    const approvals = count(s.approvals)
    const questions = count(s.questions)
    const childrenRunning = count(s.childrenRunning)
    const childrenPending = count(s.childrenPending)
    const childrenTotal = Math.max(childrenRunning, count(s.childrenTotal))
    sessions.push({
      id,
      name: typeof s.name === 'string' && s.name ? s.name : id,
      running,
      approvals,
      questions,
      pendingApprovals: Array.isArray(s.pendingApprovals) ? s.pendingApprovals : [],
      pendingQuestions: Array.isArray(s.pendingQuestions) ? s.pendingQuestions : [],
      startedAt: stamp(s.startedAt),
      finishedAt: stamp(s.finishedAt),
      lastChangeAt: stamp(s.lastChangeAt),
      // v1 writers had no `live`/child fields: derive rather than default to
      // false, which would hide an idle-looking session that awaits a human.
      live: typeof s.live === 'boolean' ? s.live : running || childrenRunning > 0 || approvals + questions > 0 || childrenPending > 0,
      childrenRunning,
      childrenPending,
      childrenTotal,
    })
  }
  const orphans = src.orphanChildren && typeof src.orphanChildren === 'object' ? src.orphanChildren : {}
  return {
    v: num(src.v, 1),
    ts: num(src.ts, 0),
    disposed: src.disposed === true,
    sessions,
    orphanChildren: { running: count(orphans.running), total: count(orphans.total) },
  }
}

/**
 * File-backed store. `load()` must be called once at startup; every
 * mutation updates the in-memory map and attempts a best-effort save.
 * @param {string} filePath absolute path of the JSON file
 * @param {{now?: () => number}} [opts] injectable clock for tests
 */export function createReadStore(filePath, opts = {}) {
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
