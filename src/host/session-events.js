/**
 * dsh-clean-desktop-shell — session event collector (host half).
 *
 * Subscribes ONLY to the documented plugin surface (the cordis-surface
 * catalogs in the official docs/subsystems pages):
 *   - 'agent/created' / 'agent/status' / 'agent/disposed'  (core page)
 *   - 'approval/request'        waterfall observer (approval page)
 *   - 'user-questions/request'  waterfall observer (user-questions page)
 *   - ctx.sessions.get(id) + ctx.sessionTitle.get(session) (session / session-title pages)
 *
 * It maintains one JSON snapshot file consumed by the shell's overlay
 * window. The observer never answers, never vetoes: it counts the request
 * as pending for the whole downstream answerer chain (registered with
 * prepend so its window covers the human's thinking time too), then
 * forwards the next() result untouched — a waterfall listener that did not
 * call next() would short-circuit the chain and break approvals.
 */
import { writeFileSync, renameSync, rmSync, mkdirSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { stateFilePath } from './common.js'
import {
  pushApprovalDetail,
  removeApprovalDetail,
  approvalDetailsForWrite,
} from './approval-details.js'
import {
  captureQuestionBatch,
  removeQuestionBatch,
  questionBatchesForWrite,
} from './question-details.js'

// Refresh the timestamp even when nothing changed, so the shell can tell
// "backend alive but idle" apart from "backend gone" (file goes stale).
const HEARTBEAT_MS = 5000
// Collapse event bursts (prompt submit fires several transitions at once).
const COALESCE_MS = 150

export function startSessionEvents(ctx) {
  /** @type {Map<string, {running:boolean, approvals:number, questions:number, approvalDetails:object[], questionDetails:object[], startedAt:number|null, finishedAt:number|null, lastChangeAt:number}>} */
  const entries = new Map()
  let heartbeat = null
  let flushTimer = null
  let stopped = false

  function entryOf(id) {
    let e = entries.get(id)
    if (!e) {
      e = { running: false, approvals: 0, questions: 0, approvalDetails: [], questionDetails: [], startedAt: null, finishedAt: null, lastChangeAt: Date.now() }
      entries.set(id, e)
    }
    return e
  }

  /** Live session id -> Session from the store, or undefined. */
  function sessionOf(id) {
    try {
      return ctx.sessions.get(id)
    } catch {
      return undefined
    }
  }

  /**
   * Display name: the durable session title when one exists, else the
   * workspace folder name, else the session id tail. Recomputed per write
   * so an LLM-generated title that lands later shows up automatically.
   */
  function nameFor(id) {
    try {
      const session = sessionOf(id)
      if (!session) return `会话 ${String(id).slice(-6)}`
      const snapshot = ctx.sessionTitle.get(session)
      if (snapshot && snapshot.title) return snapshot.title
      const cwd = session.header && session.header.cwd
      if (cwd) return basename(cwd) || cwd
    } catch {
      // Title/service lookups must never take down the collector.
    }
    return `会话 ${String(id).slice(-6)}`
  }

  /** Subagent children fold into their parent row; they are not sessions. */
  function isSubagent(id) {
    try {
      const session = sessionOf(id)
      return !!(session && session.header && session.header.origin === 'subagent')
    } catch {
      return false
    }
  }

  function snapshot() {
    const sessions = []
    for (const [id, e] of entries) {
      if (isSubagent(id)) continue
      sessions.push({
        id,
        name: nameFor(id),
        running: e.running,
        approvals: e.approvals,
        questions: e.questions,
        // Ordered detail rows for the bubble's approval hover card; first
        // entry is what the web composer shows as effective. Empty array is
        // always written so the shell never guesses at a missing key.
        pendingApprovals: approvalDetailsForWrite(e.approvalDetails),
        // Ordered question batches (first = effective); pages carry the
        // exact ids/labels the bubble needs to echo a complete answer.
        pendingQuestions: questionBatchesForWrite(e.questionDetails),
        startedAt: e.startedAt,
        finishedAt: e.finishedAt,
        lastChangeAt: e.lastChangeAt,
      })
    }
    return { v: 1, ts: Date.now(), disposed: false, sessions }
  }

  function writeNow() {
    if (stopped) return
    writeStateFile(snapshot())
  }

  function schedule() {
    if (flushTimer || stopped) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      writeNow()
    }, COALESCE_MS)
  }

  // --- documented agent lifecycle events ---------------------------------
  ctx.on('agent/created', ({ agent }) => {
    if (!agent) return
    entryOf(String(agent.id))
    schedule()
  })

  ctx.on('agent/status', ({ agent, status }) => {
    if (!agent) return
    const e = entryOf(String(agent.id))
    const running = status === 'running'
    if (e.running !== running) {
      e.running = running
      e.lastChangeAt = Date.now()
      if (running) e.startedAt = Date.now()
      else e.finishedAt = Date.now()
      schedule()
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    if (agent) entries.delete(String(agent.id))
    schedule()
  })

  // --- waterfall observers (count only; always forward) -------------------
  // Third argument optionally tracks per-request details alongside the count
  // (approvals show toolName/reason in the bubble; questions stay count-only
  // this round). The handle pairs add/remove by object identity.
  function observeWaterfall(event, field, detailHooks) {
    ctx.on(
      event,
      (request, next) => {
        const id = request && request.agent ? String(request.agent.id) : null
        if (!id) return next()
        const e = entryOf(id)
        e[field] += 1
        e.lastChangeAt = Date.now()
        const handle = detailHooks ? detailHooks.track(e, request) : null
        schedule()
        const settle = () => {
          e[field] = Math.max(0, e[field] - 1)
          if (handle) detailHooks.untrack(e, handle)
          e.lastChangeAt = Date.now()
          schedule()
        }
        return next().then(
          (value) => {
            settle()
            return value
          },
          (err) => {
            settle()
            throw err
          },
        )
      },
      true, // prepend: the pending window also covers answerers upstream
    )
  }

  observeWaterfall('approval/request', 'approvals', {
    track: (e, request) => pushApprovalDetail(e.approvalDetails, request, Date.now()),
    untrack: (e, handle) => removeApprovalDetail(e.approvalDetails, handle),
  })
  observeWaterfall('user-questions/request', 'questions', {
    track: (e, request) => captureQuestionBatch(e.questionDetails, request, Date.now()),
    untrack: (e, handle) => removeQuestionBatch(e.questionDetails, handle),
  })

  heartbeat = setInterval(writeNow, HEARTBEAT_MS)
  if (typeof heartbeat.unref === 'function') heartbeat.unref()
  writeNow()

  return () => {
    stopped = true
    if (heartbeat) clearInterval(heartbeat)
    if (flushTimer) clearTimeout(flushTimer)
    // Final state: empty + disposed flag, so the overlay flips to idle and
    // then to "stale/offline" as the timestamp ages out — never a fake busy.
    writeStateFile({ v: 1, ts: Date.now(), disposed: true, sessions: [] })
  }
}

/** Atomic JSON write (tmp + rename; Windows EPERM retry, same as config.js). */
function writeStateFile(value) {
  const file = stateFilePath()
  const tmp = `${file}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, JSON.stringify(value), 'utf8')
    try {
      renameSync(tmp, file)
    } catch {
      rmSync(file, { force: true })
      renameSync(tmp, file)
    }
  } catch {
    // A failed write self-heals on the next heartbeat.
  }
}
