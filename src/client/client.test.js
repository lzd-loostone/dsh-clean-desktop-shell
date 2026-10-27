/**
 * Unit tests: src/client/client.js (node:test, zero deps).
 *
 * Drives the real browser bundle through a fake module loader: reads the
 * shipped client.js, executes it against a mock window/__ModuleLoader__/
 * EventSource/ctx, and asserts the overlay-decision behavior. The page half
 * now listens on the SSE route instead of window.shellAPI — these tests pin
 * that contract, including the reconnect after a dropped stream.
 *
 * Run: node src/client/client.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BUNDLE = join(dirname(fileURLToPath(import.meta.url)), 'client.js')
const EVENTS_PATH = '/dsh-clean-desktop-shell/events'

/** EventSource stand-in: records instances and lets tests push frames. */
function installEventSource() {
  const instances = []
  class FakeEventSource {
    constructor(url) {
      this.url = url
      this.readyState = 0
      this.onmessage = null
      this.onerror = null
      instances.push(this)
    }
    emit(payload) {
      this.onmessage && this.onmessage({ data: JSON.stringify(payload) })
    }
    emitRaw(data) {
      this.onmessage && this.onmessage({ data })
    }
    fail(readyState) {
      this.readyState = readyState
      this.onerror && this.onerror({})
    }
  }
  FakeEventSource.CLOSED = 2
  globalThis.EventSource = FakeEventSource
  return instances
}

/** Execute client.js against fakes; returns the registered exports. */
function boot(overrides) {
  const code = readFileSync(BUNDLE, 'utf8')
  let registered = null
  const fakeWindow = Object.assign({ __ModuleLoader__: { load: (def) => { registered = def } } }, overrides)
  new Function('window', code)(fakeWindow)
  assert.ok(registered, 'bundle must call window.__ModuleLoader__.load')
  const fakeRequire = (name) => {
    assert.equal(name, 'react')
    return { createElement: () => null }
  }
  return { exports: registered.factory(fakeRequire), fakeWindow }
}

/** DSH 0.1.7 projection shape: sid → { pendingInteraction }. */
function statusesOf(pendingMap) {
  const m = new Map()
  for (const [id, pending] of pendingMap) m.set(id, { pendingInteraction: pending })
  return m
}

function makeCtx(pendingMap, statusMap) {
  const opened = []
  return {
    opened,
    ctx: {
      uiWorkspace: { openSession: (id) => opened.push(id) },
      uiSession: {
        sessionStatus: {
          getSnapshot: () => statusMap || statusesOf(pendingMap),
          subscribe: () => () => {},
        },
      },
    },
  }
}

function bootWith(pendingMap, statusMap, overrides) {
  const instances = installEventSource()
  const b = boot(overrides)
  const { ctx, opened } = makeCtx(pendingMap, statusMap)
  b.exports.apply(ctx)
  assert.equal(instances.length, 1, 'one SSE stream per page')
  return { es: instances[0], instances, opened, ctx }
}

const mapOf = (entries) => new Map(entries)

test('bundle contract: id + inject roster', () => {
  const b = boot()
  assert.deepEqual(b.exports.inject, ['uiSession', 'uiWorkspace'])
  assert.equal(typeof b.exports.apply, 'function')
})

test('apply opens one stream on the loop-back route', () => {
  const { es } = bootWith(mapOf([]))
  assert.equal(es.url, EVENTS_PATH)
})

test('goto frame → uiWorkspace.openSession', () => {
  const { es, opened } = bootWith(mapOf([]))
  es.emit({ type: 'goto', sessionId: 'S9' })
  assert.deepEqual(opened, ['S9'])
})

test('reload frame → location.reload', () => {
  let reloaded = 0
  const { es } = bootWith(mapOf([]), undefined, { location: { reload: () => { reloaded++ } } })
  es.emit({ type: 'reload' })
  assert.equal(reloaded, 1)
})

test('approve allow → answer(allowed-once); reject → answer(rejected)', () => {
  const answered = []
  const pending = { kind: 'approval', sessionId: 'S1', answer: (d) => { answered.push(d); return Promise.resolve() } }
  const { es } = bootWith(mapOf([['S1', pending]]))
  es.emit({ type: 'approve', sessionId: 'S1', decision: 'allow' })
  es.emit({ type: 'approve', sessionId: 'S1', decision: 'reject' })
  assert.deepEqual(answered, ['allowed-once', 'rejected'])
})

test('no pending for the session → ignored without throwing', () => {
  const { es } = bootWith(mapOf([]))
  assert.doesNotThrow(() => es.emit({ type: 'approve', sessionId: 'missing', decision: 'allow' }))
})

test('pending of another kind (question) is not settled by an approval', () => {
  let touched = 0
  const pending = { kind: 'question', sessionId: 'S2', answer: () => { touched++; return Promise.resolve() } }
  const { es } = bootWith(mapOf([['S2', pending]]))
  es.emit({ type: 'approve', sessionId: 'S2', decision: 'allow' })
  assert.equal(touched, 0)
})

test('branded-key miss falls back to scanning values by sessionId', () => {
  const answered = []
  const pending = { kind: 'approval', sessionId: 'S3', answer: (d) => { answered.push(d); return Promise.resolve() } }
  const fakeMap = {
    get: () => undefined,
    values: () => [{ pendingInteraction: pending }][Symbol.iterator](),
  }
  const { es } = bootWith(null, fakeMap)
  es.emit({ type: 'approve', sessionId: 'S3', decision: 'allow' })
  assert.deepEqual(answered, ['allowed-once'])
})

test('already-settled answer (rejected promise) does not escape', async () => {
  const pending = { kind: 'approval', sessionId: 'S4', answer: () => Promise.reject(new Error('already settled')) }
  const { es } = bootWith(mapOf([['S4', pending]]))
  assert.doesNotThrow(() => es.emit({ type: 'approve', sessionId: 'S4', decision: 'allow' }))
  await new Promise((r) => setTimeout(r, 0))
})

test('malformed frames are dropped', () => {
  const { es, opened } = bootWith(mapOf([]))
  assert.doesNotThrow(() => es.emitRaw('not json'))
  assert.doesNotThrow(() => es.emit({ type: 'bogus' }))
  assert.doesNotThrow(() => es.emit(null))
  assert.deepEqual(opened, [])
})

// ---------- question batch answers ----------

const TWO_Q = [
  { id: 'q1', question: '选一个', options: [{ label: 'A' }, { label: 'B' }] },
  { id: 'q2', question: '叫什么名字' },
]

function qBoot(pending) {
  const calls = []
  if (pending) pending.answer = (a) => { calls.push(a); return Promise.resolve() }
  const map = pending ? mapOf([[pending.sessionId, pending]]) : mapOf([])
  const { es } = bootWith(map)
  return { es, calls }
}

test('answer happy batch: label pick + custom text, normalized and submitted', () => {
  const { es, calls } = qBoot({ kind: 'question', sessionId: 'S1', questions: TWO_Q })
  es.emit({ type: 'answer', sessionId: 'S1', answers: [
    { id: 'q1', selected: ['A'] },
    { id: 'q2', selected: [], custom: '  小深  ' },
  ] })
  assert.deepEqual(calls[0], { answers: [
    { id: 'q1', selected: ['A'] },
    { id: 'q2', selected: [], custom: '小深' },
  ] })
})

test('answer single-select with two labels → refused', () => {
  const { es, calls } = qBoot({ kind: 'question', sessionId: 'S1', questions: TWO_Q })
  es.emit({ type: 'answer', sessionId: 'S1', answers: [
    { id: 'q1', selected: ['A', 'B'] },
    { id: 'q2', selected: [], custom: 'x' },
  ] })
  assert.equal(calls.length, 0)
})

test('answer unknown option label or empty custom → refused', () => {
  const { es, calls } = qBoot({ kind: 'question', sessionId: 'S1', questions: TWO_Q })
  es.emit({ type: 'answer', sessionId: 'S1', answers: [{ id: 'q1', selected: ['Z'] }, { id: 'q2', selected: [], custom: 'x' }] })
  es.emit({ type: 'answer', sessionId: 'S1', answers: [{ id: 'q1', selected: ['A'] }, { id: 'q2', selected: [], custom: '  ' }] })
  assert.equal(calls.length, 0)
})

test('answer count/id mismatch → refused', () => {
  const { es, calls } = qBoot({ kind: 'question', sessionId: 'S1', questions: TWO_Q })
  es.emit({ type: 'answer', sessionId: 'S1', answers: [{ id: 'q1', selected: ['A'] }] })
  es.emit({ type: 'answer', sessionId: 'S1', answers: [{ id: 'q1', selected: ['A'] }, { id: 'other', selected: [], custom: 'y' }] })
  assert.equal(calls.length, 0)
})

test('plan-review pending accepts the batch', () => {
  const { es, calls } = qBoot({ kind: 'plan-review', sessionId: 'S6', questions: [
    { id: 'p', question: '通过计划吗', options: [{ label: '通过' }, { label: '否决' }] },
  ] })
  es.emit({ type: 'answer', sessionId: 'S6', answers: [{ id: 'p', selected: ['通过'] }] })
  assert.equal(calls.length, 1)
})

test('a permanently closed stream is rebuilt after the retry delay', () => {
  const timers = []
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length }
  try {
    const { es, instances } = bootWith(mapOf([]))
    es.fail(FakeClosed())
    assert.equal(timers.length, 1, 'schedules exactly one retry')
    timers.shift().fn()
    assert.equal(instances.length, 2, 'a fresh stream takes over')
  } finally {
    globalThis.setTimeout = realSetTimeout
  }
})

function FakeClosed() {
  return 2
}
