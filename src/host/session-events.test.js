/**
 * session-events collector tests (node:test; run: node --test src/host/session-events.test.js).
 *
 * The collector is exercised through its real public surface: a fake cordis
 * context that only implements the documented events plus `ctx.sessions.get`,
 * and the state file it writes into a throwaway DSH_HOME.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startSessionEvents } from './session-events.js'

/** Fake ctx: events + session store. `sessions` is a plain Map<id, session>. */
function fakeCtx(sessions) {
  const handlers = new Map()
  return {
    sessions: { get: (id) => sessions.get(String(id)) },
    sessionTitle: { get: () => null },
    on(event, fn) {
      handlers.set(event, fn)
      return () => handlers.delete(event)
    },
    /** Fire one event, optionally with a waterfall `next`. */
    emit(event, payload, next) {
      const fn = handlers.get(event)
      if (!fn) return Promise.resolve()
      return fn(payload, next || (() => Promise.resolve()))
    },
  }
}

/** A session header shaped like the DSH source (header.parentSession / origin). */
function session(header) {
  return { header }
}

function agentOf(id) {
  return { id }
}

function stateOf(home) {
  const file = join(home, 'desktop-shell-state.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}

/** Poll the state file until `pred(node)` holds (coalesced writes are async). */
async function waitFor(home, pred, label) {
  const deadline = Date.now() + 2500
  let last = null
  while (Date.now() < deadline) {
    last = stateOf(home)
    if (last && pred(last)) return last
    await new Promise((r) => setTimeout(r, 30))
  }
  assert.fail(`${label}: state never matched, last=${JSON.stringify(last)}`)
}

function withHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-session-events-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    rmSync(home, { recursive: true, force: true })
  })
  return home
}

function rowOf(node, id) {
  return node.sessions.find((s) => s.id === id)
}

test('subagent lifecycle folds into the parent row', async (t) => {
  const home = withHome(t)
  const sessions = new Map([
    ['main', session({ id: 'main', cwd: 'C:/work/app' })],
    ['kid', session({ id: 'kid', origin: 'subagent', parentSession: 'main' })],
  ])
  const ctx = fakeCtx(sessions)
  const stop = startSessionEvents(ctx)
  t.after(stop)

  ctx.emit('agent/created', { agent: agentOf('main') })
  ctx.emit('agent/status', { agent: agentOf('main'), status: 'running' })
  ctx.emit('agent/created', { agent: agentOf('kid') })
  ctx.emit('agent/status', { agent: agentOf('kid'), status: 'running' })

  const node = await waitFor(home, (n) => rowOf(n, 'main') && rowOf(n, 'main').childrenRunning === 1, 'child running')
  assert.equal(rowOf(node, 'main').childrenTotal, 1)
  assert.equal(rowOf(node, 'main').live, true)
  // The child never becomes a row of its own.
  assert.equal(rowOf(node, 'kid'), undefined)
})

test('child status finished and dispose keep childrenTotal, drop running', async (t) => {
  const home = withHome(t)
  const sessions = new Map([
    ['main', session({ id: 'main', cwd: 'C:/work/app' })],
    ['kid', session({ id: 'kid', origin: 'subagent', parentSession: 'main' })],
  ])
  const ctx = fakeCtx(sessions)
  const stop = startSessionEvents(ctx)
  t.after(stop)

  ctx.emit('agent/created', { agent: agentOf('main') })
  ctx.emit('agent/status', { agent: agentOf('main'), status: 'running' })
  ctx.emit('agent/created', { agent: agentOf('kid') })
  ctx.emit('agent/status', { agent: agentOf('kid'), status: 'running' })
  await waitFor(home, (n) => rowOf(n, 'main') && rowOf(n, 'main').childrenRunning === 1, 'child running')

  ctx.emit('agent/status', { agent: agentOf('kid'), status: 'finished' })
  let node = await waitFor(home, (n) => rowOf(n, 'main') && rowOf(n, 'main').childrenRunning === 0, 'child finished')
  assert.equal(rowOf(node, 'main').childrenTotal, 1)

  ctx.emit('agent/disposed', { agent: agentOf('kid') })
  node = await waitFor(home, (n) => rowOf(n, 'main') && rowOf(n, 'main').childrenTotal === 1 && rowOf(n, 'main').childrenRunning === 0, 'child disposed')
  assert.equal(rowOf(node, 'main').live, true) // parent still running
})

test('parentId is the fallback parent pointer', async (t) => {
  const home = withHome(t)
  const sessions = new Map([
    ['main', session({ id: 'main', cwd: 'C:/work/app' })],
    ['kid', session({ id: 'kid', origin: 'subagent', parentId: 'main' })],
  ])
  const ctx = fakeCtx(sessions)
  const stop = startSessionEvents(ctx)
  t.after(stop)

  ctx.emit('agent/created', { agent: agentOf('main') })
  ctx.emit('agent/status', { agent: agentOf('main'), status: 'running' })
  ctx.emit('agent/created', { agent: agentOf('kid') })
  ctx.emit('agent/status', { agent: agentOf('kid'), status: 'running' })

  const node = await waitFor(home, (n) => rowOf(n, 'main') && rowOf(n, 'main').childrenRunning === 1, 'parentId fallback')
  assert.equal(rowOf(node, 'main').childrenTotal, 1)
})

test('a pending approval keeps an otherwise idle row live', async (t) => {
  const home = withHome(t)
  const sessions = new Map([['main', session({ id: 'main', cwd: 'C:/work/app' })]])
  const ctx = fakeCtx(sessions)
  const stop = startSessionEvents(ctx)
  t.after(stop)

  ctx.emit('agent/created', { agent: agentOf('main') })
  let release
  const gate = new Promise((r) => { release = r })
  ctx.emit('approval/request', { agent: agentOf('main'), toolName: 'bash' }, () => gate)

  const node = await waitFor(home, (n) => rowOf(n, 'main') && rowOf(n, 'main').approvals === 1, 'approval pending')
  const row = rowOf(node, 'main')
  assert.equal(row.running, false)
  assert.equal(row.childrenRunning, 0)
  assert.equal(row.live, true)

  release()
  await waitFor(home, (n) => rowOf(n, 'main') && rowOf(n, 'main').approvals === 0, 'approval settled')
})

test('a child without a resolvable parent lands in the orphan bucket', async (t) => {
  const home = withHome(t)
  const sessions = new Map([
    ['main', session({ id: 'main', cwd: 'C:/work/app' })],
    ['lost', session({ id: 'lost', origin: 'subagent', parentSession: 'ghost' })],
  ])
  const ctx = fakeCtx(sessions)
  const stop = startSessionEvents(ctx)
  t.after(stop)

  ctx.emit('agent/created', { agent: agentOf('main') })
  ctx.emit('agent/status', { agent: agentOf('main'), status: 'running' })
  ctx.emit('agent/created', { agent: agentOf('lost') })
  ctx.emit('agent/status', { agent: agentOf('lost'), status: 'running' })

  const node = await waitFor(home, (n) => n.orphanChildren && n.orphanChildren.running === 1, 'orphan running')
  assert.equal(node.orphanChildren.total, 1)
  assert.equal(rowOf(node, 'lost'), undefined)
  assert.equal(rowOf(node, 'main').childrenRunning, 0)
})

test('the state file is v2 and still carries every v1 key', async (t) => {
  const home = withHome(t)
  const sessions = new Map([
    ['main', session({ id: 'main', cwd: 'C:/work/app' })],
    ['kid', session({ id: 'kid', origin: 'subagent', parentSession: 'main' })],
  ])
  const ctx = fakeCtx(sessions)
  const stop = startSessionEvents(ctx)
  t.after(stop)

  ctx.emit('agent/created', { agent: agentOf('main') })
  ctx.emit('agent/status', { agent: agentOf('main'), status: 'running' })
  ctx.emit('agent/created', { agent: agentOf('kid') })
  ctx.emit('agent/status', { agent: agentOf('kid'), status: 'running' })

  const node = await waitFor(home, (n) => n.v === 2 && rowOf(n, 'main') && rowOf(n, 'main').childrenRunning === 1, 'v2 file')
  const row = rowOf(node, 'main')
  // An old shell ignores unknown fields but must keep working: nothing v1
  // relied on may disappear.
  for (const key of [
    'id', 'name', 'running', 'approvals', 'questions', 'pendingApprovals',
    'pendingQuestions', 'startedAt', 'finishedAt', 'lastChangeAt',
  ]) {
    assert.ok(key in row, `v1 key ${key} missing from the v2 row`)
  }
  assert.equal(typeof node.ts, 'number')
  assert.equal(node.disposed, false)
})

test('a child waiting for approval turns the parent ring amber', async (t) => {
  const home = withHome(t)
  const sessions = new Map([
    ['main', session({ id: 'main', cwd: 'C:/work/app' })],
    ['kid', session({ id: 'kid', origin: 'subagent', parentSession: 'main' })],
  ])
  const ctx = fakeCtx(sessions)
  const stop = startSessionEvents(ctx)
  t.after(stop)

  ctx.emit('agent/created', { agent: agentOf('main') })
  ctx.emit('agent/status', { agent: agentOf('main'), status: 'running' })
  ctx.emit('agent/created', { agent: agentOf('kid') })
  ctx.emit('agent/status', { agent: agentOf('kid'), status: 'running' })
  let release
  const gate = new Promise((r) => { release = r })
  ctx.emit('approval/request', { agent: agentOf('kid'), toolName: 'bash' }, () => gate)

  const node = await waitFor(
    home,
    (n) => rowOf(n, 'main') && rowOf(n, 'main').childrenPending === 1,
    'child pending',
  )
  const row = rowOf(node, 'main')
  // The parent row cannot open the child's approval, but it must say so.
  assert.equal(row.approvals, 0)
  assert.equal(row.live, true)
  assert.equal(row.childrenRunning, 1)
  release()
})

test('disposing the parent removes its subtree', async (t) => {
  const home = withHome(t)
  const sessions = new Map([
    ['main', session({ id: 'main', cwd: 'C:/work/app' })],
    ['kid', session({ id: 'kid', origin: 'subagent', parentSession: 'main' })],
  ])
  const ctx = fakeCtx(sessions)
  const stop = startSessionEvents(ctx)
  t.after(stop)

  ctx.emit('agent/created', { agent: agentOf('main') })
  ctx.emit('agent/status', { agent: agentOf('main'), status: 'running' })
  ctx.emit('agent/created', { agent: agentOf('kid') })
  ctx.emit('agent/status', { agent: agentOf('kid'), status: 'running' })
  await waitFor(home, (n) => rowOf(n, 'main') && rowOf(n, 'main').childrenRunning === 1, 'child running')

  ctx.emit('agent/disposed', { agent: agentOf('main') })
  const node = await waitFor(home, (n) => rowOf(n, 'main') === undefined, 'parent gone')
  assert.equal(node.sessions.length, 0)
})
