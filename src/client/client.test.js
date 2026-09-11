/**
 * Unit tests: src/client/client.js (node:test, zero deps).
 *
 * Drives the real browser bundle through a fake module loader: reads the
 * shipped client.js, executes it against a mock window/__ModuleLoader__/
 * require/shellAPI/ctx, and asserts the approval-answer bridge behavior.
 * Run: node src/client/client.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BUNDLE = join(dirname(fileURLToPath(import.meta.url)), 'client.js')

/** Execute client.js against fakes; returns the registered exports plus handles. */
function boot({ pendingMap } = {}) {
  const code = readFileSync(BUNDLE, 'utf8')
  let registered = null
  const fakeWindow = {
    __ModuleLoader__: {
      load: (def) => { registered = def },
    },
    shellAPI: undefined,
  }
  new Function('window', code)(fakeWindow)
  assert.ok(registered, 'bundle must call window.__ModuleLoader__.load')
  const fakeRequire = (name) => {
    assert.equal(name, 'react')
    return { createElement: () => null }
  }
  const exports = registered.factory(fakeRequire)
  return { exports, fakeWindow, setShellApi: (api) => { fakeWindow.shellAPI = api } }
}

/** shellAPI fake collecting registered listeners. */
function makeApi() {
  const listeners = {}
  return {
    listeners,
    onGotoSession: (cb) => { listeners.goto = cb },
    onApproveSession: (cb) => { listeners.approve = cb },
    onAnswerQuestion: (cb) => { listeners.answer = cb },
    gotoTrace: () => {},
  }
}

function makeCtx(pendingMap) {
  const opened = []
  return {
    opened,
    ctx: {
      sessions: { open: (id) => opened.push(id) },
      slots: { inject: () => {} },
      uiSession: {
        pendingInteractions: {
          getSnapshot: () => pendingMap,
          subscribe: () => () => {},
        },
      },
    },
  }
}

function mapOf(entries) {
  const m = new Map(entries)
  return m
}

test('bundle contract: id + inject roster', () => {
  const { exports } = boot()
  assert.deepEqual(exports.inject, ['sessions', 'slots', 'uiSession'])
  assert.equal(typeof exports.apply, 'function')
})

test('approve allow → answer(allowed-once) on the effective approval', () => {
  const { exports } = boot()
  const answered = []
  const pending = { kind: 'approval', sessionId: 'S1', answer: (d) => { answered.push(d); return Promise.resolve() } }
  const { ctx, opened } = makeCtx(mapOf([['S1', pending]]))
  const api = makeApi()
  exports.apply(Object.assign({}, ctx)) // window.shellAPI not set yet → no listeners
  assert.equal(api.listeners.approve, undefined) // guard: without shellAPI nothing registers
  assert.deepEqual(opened, [])
  // real boot path
  const boot2 = boot()
  boot2.setShellApi(api)
  boot2.exports.apply(ctx)
  assert.equal(typeof api.listeners.approve, 'function')
  api.listeners.approve({ sessionId: 'S1', decision: 'allow' })
  assert.deepEqual(answered, ['allowed-once'])
})

test('approve reject → answer(rejected)', () => {
  const api = makeApi()
  const b = boot()
  b.setShellApi(api)
  const answered = []
  const pending = { kind: 'approval', sessionId: 'S1', answer: (d) => { answered.push(d); return Promise.resolve() } }
  const { ctx } = makeCtx(mapOf([['S1', pending]]))
  b.exports.apply(ctx)
  api.listeners.approve({ sessionId: 'S1', decision: 'reject' })
  assert.deepEqual(answered, ['rejected'])
})

test('no pending for the session → ignored without throwing', () => {
  const api = makeApi()
  const b = boot()
  b.setShellApi(api)
  const { ctx } = makeCtx(mapOf([]))
  b.exports.apply(ctx)
  assert.doesNotThrow(() => api.listeners.approve({ sessionId: 'missing', decision: 'allow' }))
})

test('pending of another kind (question) → untouched', () => {
  const api = makeApi()
  const b = boot()
  b.setShellApi(api)
  let touched = 0
  const pending = { kind: 'question', sessionId: 'S2', answer: () => { touched++; return Promise.resolve() } }
  const { ctx } = makeCtx(mapOf([['S2', pending]]))
  b.exports.apply(ctx)
  api.listeners.approve({ sessionId: 'S2', decision: 'allow' })
  assert.equal(touched, 0)
})

test('branded-key miss falls back to scanning values by sessionId', () => {
  const api = makeApi()
  const b = boot()
  b.setShellApi(api)
  const answered = []
  const pending = { kind: 'approval', sessionId: 'S3', answer: (d) => { answered.push(d); return Promise.resolve() } }
  const fakeMap = {
    get: () => undefined, // exact key lookup misses, like a branded identity key
    values: () => [pending][Symbol.iterator](),
  }
  const { ctx } = makeCtx(fakeMap)
  b.exports.apply(ctx)
  api.listeners.approve({ sessionId: 'S3', decision: 'allow' })
  assert.deepEqual(answered, ['allowed-once'])
})

test('already-settled answer (rejected promise) does not escape', async () => {
  const api = makeApi()
  const b = boot()
  b.setShellApi(api)
  const pending = { kind: 'approval', sessionId: 'S4', answer: () => Promise.reject(new Error('pending approval approval:1 is already settled')) }
  const { ctx } = makeCtx(mapOf([['S4', pending]]))
  b.exports.apply(ctx)
  assert.doesNotThrow(() => api.listeners.approve({ sessionId: 'S4', decision: 'allow' }))
  await new Promise((r) => setTimeout(r, 0)) // rejection must be swallowed, no unhandled
})

test('malformed payloads are dropped', () => {
  const api = makeApi()
  const b = boot()
  b.setShellApi(api)
  const { ctx } = makeCtx(mapOf([]))
  b.exports.apply(ctx)
  assert.doesNotThrow(() => api.listeners.approve(null))
  assert.doesNotThrow(() => api.listeners.approve({ sessionId: '', decision: 'allow' }))
  assert.doesNotThrow(() => api.listeners.approve({ sessionId: 'x' })) // no decision → allow path with pending lookup
})

test('goto channel still works (regression)', () => {
  const api = makeApi()
  const b = boot()
  b.setShellApi(api)
  const { ctx, opened } = makeCtx(mapOf([]))
  b.exports.apply(ctx)
  api.listeners.goto('S9')
  assert.deepEqual(opened, ['S9'])
})

// ---------- question batch answers ----------

function qBoot(pending) {
  const api = makeApi()
  const b = boot()
  b.setShellApi(api)
  const calls = []
  if (pending) {
    pending.answer = (a) => { calls.push(a); return Promise.resolve() }
  }
  const map = pending ? mapOf([[pending.sessionId, pending]]) : mapOf([])
  const { ctx } = makeCtx(map)
  b.exports.apply(ctx)
  return { api, calls }
}

const TWO_Q = [
  { id: 'q1', question: '选一个', options: [{ label: 'A' }, { label: 'B' }] },
  { id: 'q2', question: '叫什么名字' },
]

test('answer happy batch: label pick + custom text, normalized and submitted', () => {
  const pending = { kind: 'question', sessionId: 'S1', questions: TWO_Q }
  const { api, calls } = qBoot(pending)
  assert.equal(typeof api.listeners.answer, 'function')
  api.listeners.answer({ sessionId: 'S1', answers: [
    { id: 'q1', selected: ['A'] },
    { id: 'q2', selected: [], custom: '  小深  ' },
  ] })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], { answers: [
    { id: 'q1', selected: ['A'] },
    { id: 'q2', selected: [], custom: '小深' },
  ] })
})

test('answer single-select with two labels → refused', () => {
  const pending = { kind: 'question', sessionId: 'S1', questions: TWO_Q }
  const { api, calls } = qBoot(pending)
  api.listeners.answer({ sessionId: 'S1', answers: [
    { id: 'q1', selected: ['A', 'B'] },
    { id: 'q2', selected: [], custom: 'x' },
  ] })
  assert.equal(calls.length, 0)
})

test('answer multiSelect with several labels → accepted', () => {
  const pending = { kind: 'question', sessionId: 'S1', questions: [
    { id: 'm', question: '多选', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] },
  ] }
  const { api, calls } = qBoot(pending)
  api.listeners.answer({ sessionId: 'S1', answers: [{ id: 'm', selected: ['B', 'A'] }] })
  assert.deepEqual(calls, [{ answers: [{ id: 'm', selected: ['B', 'A'] }] }])
})

test('answer unknown option label → refused', () => {
  const pending = { kind: 'question', sessionId: 'S1', questions: [
    { id: 'q1', question: 'x', options: [{ label: 'A' }] },
  ] }
  const { api, calls } = qBoot(pending)
  api.listeners.answer({ sessionId: 'S1', answers: [{ id: 'q1', selected: ['Z'] }] })
  assert.equal(calls.length, 0)
})

test('answer empty pick or empty custom → refused', () => {
  const pending = { kind: 'question', sessionId: 'S1', questions: TWO_Q }
  const { api, calls } = qBoot(pending)
  api.listeners.answer({ sessionId: 'S1', answers: [{ id: 'q1', selected: [] }, { id: 'q2', selected: [], custom: '  ' }] })
  api.listeners.answer({ sessionId: 'S1', answers: [{ id: 'q1', selected: ['A'] }, { id: 'q2', selected: [] }] })
  assert.equal(calls.length, 0)
})

test('answer count/id mismatch → refused', () => {
  const pending = { kind: 'question', sessionId: 'S1', questions: TWO_Q }
  const { api, calls } = qBoot(pending)
  api.listeners.answer({ sessionId: 'S1', answers: [{ id: 'q1', selected: ['A'] }] })
  api.listeners.answer({ sessionId: 'S1', answers: [{ id: 'q1', selected: ['A'] }, { id: 'other', selected: [], custom: 'y' }] })
  assert.equal(calls.length, 0)
})

test('answer when pending is an approval or missing → ignored without throwing', () => {
  const api = makeApi()
  const b = boot()
  b.setShellApi(api)
  let touched = 0
  const pending = { kind: 'approval', sessionId: 'S5', questions: [], answer: () => { touched++; return Promise.resolve() } }
  const { ctx } = makeCtx(mapOf([['S5', pending]]))
  b.exports.apply(ctx)
  assert.doesNotThrow(() => api.listeners.answer({ sessionId: 'S5', answers: [{ id: 'q1', selected: ['A'] }] }))
  assert.doesNotThrow(() => api.listeners.answer({ sessionId: 'nobody', answers: [{ id: 'q1', selected: ['A'] }] }))
  assert.equal(touched, 0)
})

test('plan-review pending accepts the batch', () => {
  const pending = { kind: 'plan-review', sessionId: 'S6', questions: [
    { id: 'p', question: '通过计划吗', options: [{ label: '通过' }, { label: '否决' }] },
  ] }
  const { api, calls } = qBoot(pending)
  api.listeners.answer({ sessionId: 'S6', answers: [{ id: 'p', selected: ['通过'] }] })
  assert.equal(calls.length, 1)
})

test('answer already-settled rejection is swallowed', async () => {
  const api = makeApi()
  const b = boot()
  b.setShellApi(api)
  const pending = {
    kind: 'question', sessionId: 'S7',
    questions: [{ id: 'q1', question: 'x', options: [{ label: 'A' }] }],
    answer: () => Promise.reject(new Error('pending question question:1 is already settled')),
  }
  const { ctx } = makeCtx(mapOf([['S7', pending]]))
  b.exports.apply(ctx)
  assert.doesNotThrow(() => api.listeners.answer({ sessionId: 'S7', answers: [{ id: 'q1', selected: ['A'] }] }))
  await new Promise((r) => setTimeout(r, 0))
})

test('answer branded-key miss falls back to values scan', () => {
  const api = makeApi()
  const b = boot()
  b.setShellApi(api)
  const calls = []
  const pending = {
    kind: 'question', sessionId: 'S8',
    questions: [{ id: 'q1', question: 'x', options: [{ label: 'A' }] }],
    answer: (a) => { calls.push(a); return Promise.resolve() },
  }
  const fakeMap = { get: () => undefined, values: () => [pending][Symbol.iterator]() }
  const { ctx } = makeCtx(fakeMap)
  b.exports.apply(ctx)
  api.listeners.answer({ sessionId: 'S8', answers: [{ id: 'q1', selected: ['A'] }] })
  assert.equal(calls.length, 1)
})

test('answer malformed payloads dropped', () => {
  const pending = { kind: 'question', sessionId: 'S1', questions: TWO_Q }
  const { api, calls } = qBoot(pending)
  assert.doesNotThrow(() => api.listeners.answer(null))
  assert.doesNotThrow(() => api.listeners.answer({ sessionId: '', answers: [] }))
  assert.doesNotThrow(() => api.listeners.answer({ sessionId: 'S1', answers: 'nope' }))
  assert.equal(calls.length, 0)
})
