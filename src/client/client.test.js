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
import * as delegationSettings from './delegation-settings.js'

const BUNDLE = join(dirname(fileURLToPath(import.meta.url)), 'client.js')
const EVENTS_PATH = '/dsh-clean-desktop-shell/events'
/**
 * The helper module the Task 6 bundler inlines into the same factory. Until that composition
 * lands, the loader's module table is the honest place to supply it: these tests exercise the
 * real helper, never a stubbed one.
 */
const HELPER_ID = 'dsh-clean-desktop-shell/delegation-settings'
const PACKAGE = 'dsh-clean-desktop-shell'

/** EventSource stand-in: records instances and lets tests push frames. */
function installEventSource() {
  const instances = []
  class FakeEventSource {
    constructor(url) {
      this.url = url
      this.readyState = 0
      this.closed = 0
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
    close() { this.closed++ }
  }
  FakeEventSource.CLOSED = 2
  globalThis.EventSource = FakeEventSource
  return instances
}

/**
 * React stand-in that records the element tree. It deliberately exposes only `createElement`:
 * the shipped component must degrade to a static snapshot when the runtime React has no hooks,
 * and these tests then read the tree instead of a rendered DOM.
 */
function installReact() {
  return {
    createElement: (type, props, ...children) => ({
      type, props: props || {}, children: children.flat(Infinity).filter(child => child !== null && child !== undefined),
    }),
  }
}

/** Execute client.js against fakes; returns the registered exports. */
function boot(overrides = {}) {
  const code = readFileSync(BUNDLE, 'utf8')
  let registered = null
  const fakeWindow = Object.assign({ __ModuleLoader__: { load: (def) => { registered = def } } }, overrides)
  new Function('window', code)(fakeWindow)
  assert.ok(registered, 'bundle must call window.__ModuleLoader__.load')
  const table = new Map([['react', installReact()]])
  // `modules: 'without-helper'` models a bundle that has not been composed with the helper yet.
  if (overrides.modules !== 'without-helper') table.set(HELPER_ID, delegationSettings)
  const fakeRequire = (name) => {
    if (!table.has(name)) throw new Error('module is not in the table: ' + name)
    return table.get(name)
  }
  return { registered, exports: registered.factory(fakeRequire), fakeWindow, table }
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
  assert.equal(b.registered.id, PACKAGE, 'one registration under the package module id')
  assert.deepEqual(b.exports.inject, ['uiSession', 'uiWorkspace', 'sessions'])
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

// ---------------------------------------------------------------------------
// Settings surface: the formal Task 5 binding.
//
// These tests drive the real helper through the real bundle factory. The only
// fakes are the framework surfaces the bundle is supposed to consume: the
// loader module table, the keyed slot registry, ConfigForms, the locale
// service, the Remote namespace and its watch stream.
// ---------------------------------------------------------------------------

const READ_NS = 'cleanDesktopDelegationRead'

async function flush() {
  for (let index = 0; index < 6; index++) await new Promise(resolve => setImmediate(resolve))
}

async function settleFor(h) {
  for (let index = 0; index < 200 && h.calls.registers.length === 0; index++) {
    await new Promise(resolve => setImmediate(resolve))
  }
  await flush()
}

/** Optional services + slot/config/locale/Remote surfaces a real page would provide. */
function featureHarness(options = {}) {
  const calls = {
    inject: [], slotInject: null, registers: [], mounts: [], forms: [], locale: [], mutations: [],
    resets: [], watchDisposals: 0, formUnsubscribes: 0, slotDisposals: 0, registerDisposals: 0,
    localeDisposals: 0, unmounts: 0,
  }
  const opened = []
  const watches = []
  let activeLocale = options.activeLocale || 'zh'
  const baseStatus = (overrides = {}) => ({
    settingsNs: 'entry-own', state: 'active',
    savedRoute: { provider: 'p', model: 'm', reasoningEffort: 'high' },
    publishedRoute: { provider: 'old', model: 'old-model' }, generation: 3, error: null, ...overrides,
  })
  const ok = value => ({ ok: true, value })
  const catalogue = items => ({ items, total: items.length, truncated: false })
  const read = {
    describeDelegation: async () => ok(baseStatus()),
    listWorkerProviders: async () => ok(catalogue([{ id: 'p', name: 'P' }])),
    listWorkerModels: async providerId => ok(catalogue(providerId === 'p'
      ? [{ id: 'm', name: 'M' }, { id: 'm2', name: 'M2' }] : [{ id: 'other', name: 'Other' }])),
    listWorkerEfforts: async () => ok({
      efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high', total: 1, truncated: false,
    }),
    ...options.read,
  }
  const forms = new Map()
  function formFor(ns) {
    let form = forms.get(ns)
    if (form) return form
    let revision = 3
    const subscribers = new Set()
    form = {
      getSnapshot: () => ({
        status: options.formStatus || 'ready', writable: options.writable !== false,
        revision, value: {}, base: undefined, user: undefined,
      }),
      subscribe: (listener) => {
        subscribers.add(listener)
        return () => { calls.formUnsubscribes += 1; subscribers.delete(listener) }
      },
      mutate: async (ops, expectedRevision) => {
        calls.mutations.push({ ns, ops, expectedRevision })
        const accepted = options.mutate ? await options.mutate(expectedRevision) : true
        if (accepted === true) {
          revision += 1
          for (const listener of [...subscribers]) listener()
        }
        return accepted
      },
    }
    forms.set(ns, form)
    return form
  }
  const remote = {
    $mount: async (contribution) => {
      calls.mounts.push(contribution)
      return async () => { calls.unmounts += 1 }
    },
  }
  // Real rc.5 shape (packages/api/gateway/src/client/index.ts:765-767): $mount provides the
  // namespace as a service keyed `remote.<namespace>`; it is NEVER a property of `remote`.
  // The old fixture hung methods on `remote` directly and hid a production bug.
  let mountedNamespace = null
  if (options.withReadNamespace !== false) {
    mountedNamespace = {
      describeDelegation: signal => read.describeDelegation(signal),
      listWorkerProviders: signal => read.listWorkerProviders(signal),
      listWorkerModels: (providerId, signal) => read.listWorkerModels(providerId, signal),
      listWorkerEfforts: (providerId, modelId, signal) => read.listWorkerEfforts(providerId, modelId, signal),
      watchDelegation: (signal) => {
        const queue = []
        let waiting = null
        let done = false
        const handle = {
          [Symbol.asyncIterator]: () => ({
            next: () => {
              if (queue.length) return Promise.resolve({ value: queue.shift(), done: false })
              if (done) return Promise.resolve({ value: undefined, done: true })
              return new Promise((resolve, reject) => { waiting = { resolve, reject } })
            },
            return: () => { done = true; return Promise.resolve({ value: undefined, done: true }) },
          }),
          dispose: () => {
            calls.watchDisposals += 1
            done = true
            const current = waiting
            waiting = null
            current?.resolve({ value: undefined, done: true })
          },
        }
        watches.push({
          signal,
          push: (value) => {
            const current = waiting
            if (current) { waiting = null; current.resolve({ value, done: false }) } else queue.push(value)
          },
          fail: (error) => {
            const current = waiting
            if (current) { waiting = null; current.reject(error) }
          },
        })
        return handle
      },
    }
  }
  const slots = {
    entries: () => (options.occupied ? [{ options: { key: PACKAGE } }] : []),
    inject: (key, callback) => {
      calls.slotInject = key
      const dispose = callback()
      return () => { calls.slotDisposals += 1; if (typeof dispose === 'function') dispose() }
    },
    register: (registerOptions, Component) => {
      calls.registers.push({ options: registerOptions, Component })
      return () => { calls.registerDisposals += 1 }
    },
  }
  const locale = {
    register: (ns, table) => {
      calls.locale.push({ ns, table })
      return () => { calls.localeDisposals += 1 }
    },
    getSnapshot: () => ({ active: activeLocale, locales: [], revision: 0 }),
  }
  const services = {}
  if (!options.withoutRemote) services.remote = remote
  if (mountedNamespace) services['remote.' + READ_NS] = mountedNamespace
  if (!options.withoutSlots) services.slots = slots
  if (!options.withoutConfigForms) {
    services.configForms = { get: (ns) => { calls.forms.push(ns); return formFor(ns) } }
  }
  if (!options.withoutLocale) services.locale = locale
  const ctx = {
    inject: (deps, callback) => {
      calls.inject.push(deps)
      if (deps.some(name => !(name in services))) return { dispose: async () => {} }
      const child = {
        ...services,
        get: name => services[name],
        on: (event, listener) => { calls.resets.push({ event, listener }); return () => {} },
      }
      const result = callback(child)
      return {
        dispose: async () => {
          const disposer = await result
          if (typeof disposer === 'function') await disposer()
        },
      }
    },
    uiWorkspace: { openSession: id => opened.push(id) },
    uiSession: { sessionStatus: { getSnapshot: () => new Map(), subscribe: () => () => {} } },
  }
  const bundle = boot(options)
  const instances = installEventSource()
  const dispose = bundle.exports.apply(ctx)
  return {
    bundle, calls, ctx, opened, instances, status: baseStatus, get es() { return instances[0] },
    push: (value) => { const last = watches[watches.length - 1]; assert.ok(last, 'a watch must be open'); last.push(value) },
    failWatch: (error) => { const last = watches[watches.length - 1]; assert.ok(last, 'a watch must be open'); last.fail(error) },
    watchSignal: () => watches[watches.length - 1]?.signal,
    setLocale: (id) => { activeLocale = id },
    dispose,
  }
}

function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return textOf(node.children)
}

function findNode(node, predicate) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) { const hit = findNode(child, predicate); if (hit) return hit }
    return null
  }
  if (predicate(node)) return node
  return findNode(node.children, predicate)
}

function findNodes(node, predicate) {
  const hits = []
  const walk = (current) => {
    if (!current || typeof current !== 'object') return
    if (Array.isArray(current)) { for (const child of current) walk(child) ; return }
    if (predicate(current)) hits.push(current)
    walk(current.children)
  }
  walk(node)
  return hits
}

/** Render the registered cell with the owner props a real plugin page passes. */
function renderCell(h, extra = {}) {
  const cell = h.calls.registers[0]
  assert.ok(cell, 'the settings cell must be registered')
  const face = cell.options.inject()
  const componentForm = {
    mutate: () => { throw new Error('ConfigPageForm is not the CAS ConfigForm') },
    set: () => { throw new Error('ConfigPageForm is not the CAS ConfigForm') },
  }
  return cell.Component({ ...face, view: 'page', form: componentForm, ...extra })
}

function statusNode(tree) {
  return findNode(tree, node => node.props && node.props['data-delegation-status'] !== undefined)
}

function routeNode(tree, which) {
  return findNode(tree, node => node.props && node.props['data-delegation-route'] === which)
}

function saveButton(tree) {
  return findNode(tree, node => node.type === 'button')
}

test('one module id, one keyed settings cell and five readonly descriptors', async () => {
  const h = featureHarness()
  assert.equal(h.bundle.registered.id, PACKAGE)
  assert.deepEqual(h.bundle.exports.inject, ['uiSession', 'uiWorkspace', 'sessions'])
  await settleFor(h)
  assert.deepEqual(h.calls.inject[0], ['remote', 'slots', 'configForms'])
  assert.equal(h.calls.slotInject, 'plugins.bundle.config')
  assert.equal(h.calls.registers.length, 1, 'exactly one settings cell')
  const cell = h.calls.registers[0]
  assert.equal(cell.options.name, 'plugins.bundle.config')
  assert.equal(cell.options.key, PACKAGE)
  assert.equal(cell.options.locale, PACKAGE)
  assert.equal(typeof cell.Component, 'function')
  assert.equal(h.calls.mounts.length, 1)
  const mounted = h.calls.mounts[0]
  assert.equal(mounted.package, PACKAGE)
  assert.deepEqual(mounted.descriptors.map(descriptor => descriptor.method),
    ['describeDelegation', 'listWorkerProviders', 'listWorkerModels', 'listWorkerEfforts', 'watchDelegation'])
  assert.equal(mounted.descriptors[4].mode, 'stream')
  for (const descriptor of mounted.descriptors) {
    assert.equal(descriptor.namespace, READ_NS)
    assert.equal(descriptor.cancellation.parameter, 'signal')
    assert.equal(descriptor.result.mode, 'src-json')
    for (const parameter of descriptor.parameters) assert.equal(parameter.codec.mode, 'strict')
  }
  assert.deepEqual(mounted.descriptors[2].parameters.map(parameter => parameter.name), ['providerId'])
  assert.deepEqual(mounted.descriptors[3].parameters.map(parameter => parameter.name), ['providerId', 'modelId'])
  assert.equal(h.instances.length, 1, 'the settings cell never opens a second SSE stream')
  await h.dispose()
})

test('the cell renders a saved and a published route without claiming the actual child model', async () => {
  const h = featureHarness()
  await settleFor(h)
  const tree = renderCell(h)
  const text = textOf(tree)
  assert.match(text, /已保存配置/)
  assert.match(text, /已发布执行配置/)
  assert.match(text, /p \/ m \/ high/)
  assert.match(text, /old \/ old-model/)
  assert.doesNotMatch(text, /actual/i)
  assert.match(textOf(routeNode(tree, 'saved')), /p \/ m \/ high/)
  assert.match(textOf(routeNode(tree, 'published')), /old \/ old-model/)
  // The owner prop shape is `{ view, form }`: a summary view is a one-liner.
  const summary = renderCell(h, { view: 'summary' })
  assert.match(textOf(summary), /Subagent worker route|子代理/)
  assert.equal(findNode(summary, node => node.props && node.props['data-delegation-route']), null)
  await h.dispose()
})

test('each frozen code renders its own honest status and never a publication', async () => {
  const h = featureHarness()
  await settleFor(h)
  const seen = new Set()
  for (const code of delegationSettings.PUBLIC_ERROR_CODES) {
    h.push({ ...h.status(), state: 'failed', error: code, publishedRoute: null })
    await flush()
    const tree = renderCell(h)
    const node = statusNode(tree)
    const expectedState = code === 'PUBLISHER_STOPPED' ? 'delegation.status.stopped' : 'delegation.status.failed'
    assert.equal(node.props['data-delegation-status'], expectedState, 'state copy for ' + code)
    assert.equal(node.props['data-delegation-error'], code)
    const copy = textOf(findNode(tree, item => item.props && item.props['data-delegation-error']))
    assert.ok(!seen.has(copy), 'label for ' + code + ' must be distinct, got ' + JSON.stringify(copy))
    seen.add(copy)
    assert.doesNotMatch(copy, /已发布|已生效/, 'a failure must not claim publication: ' + code)
  }
  assert.equal(seen.size, 10)
  // PUBLISHER_STOPPED is a stopped publisher, not an error to retry automatically.
  h.push({ ...h.status(), state: 'failed', error: 'PUBLISHER_STOPPED', publishedRoute: null })
  await flush()
  const stopped = renderCell(h)
  assert.equal(statusNode(stopped).props['data-delegation-status'], 'delegation.status.stopped')
  assert.match(textOf(statusNode(stopped)), /发布已停止/)
  assert.doesNotMatch(textOf(statusNode(stopped)), /已发布|已生效/)
  await h.dispose()
})

test('publishing is never a publication and an unavailable watch stays honest', async () => {
  const h = featureHarness()
  await settleFor(h)
  h.push({ ...h.status(), state: 'publishing', publishedRoute: null })
  await flush()
  const publishing = renderCell(h)
  const node = statusNode(publishing)
  assert.equal(node.props['data-delegation-status'], 'delegation.status.publishing')
  assert.match(textOf(node), /发布中/)
  assert.doesNotMatch(textOf(node), /已发布|已生效/)
  // No healthy declaration exists during the retire/register window, so the published line says so.
  assert.match(textOf(routeNode(publishing, 'published')), /暂不可用，正在发布/)
  // The watch dying inside that window must not freeze the UI on a stale publication claim.
  h.failWatch(new Error('PRESET_REGISTER_FAILED'))
  await flush()
  const degraded = statusNode(renderCell(h))
  assert.equal(degraded.props['data-delegation-status'], 'delegation.status.publishingUnavailable')
  assert.match(textOf(degraded), /暂不可用，正在发布/)
  assert.doesNotMatch(textOf(degraded), /已发布|已生效/)
  await h.dispose()
})

test('a failed republish keeps the last healthy publication visible', async () => {
  const h = featureHarness()
  await settleFor(h)
  h.push({ ...h.status(), state: 'failed', error: 'PRESET_REGISTER_FAILED', publishedRoute: { provider: 'old', model: 'old-model' } })
  await flush()
  const tree = renderCell(h)
  assert.equal(statusNode(tree).props['data-delegation-status'], 'delegation.status.failedRetained')
  assert.match(textOf(statusNode(tree)), /上一次发布仍然生效，本次发布失败/)
  assert.match(textOf(routeNode(tree, 'published')), /old \/ old-model/)
  await h.dispose()
})

test('locale resolution renders Chinese, English and an English fallback', async () => {
  const h = featureHarness()
  await settleFor(h)
  assert.equal(h.calls.locale.length, 1)
  const { ns, table } = h.calls.locale[0]
  assert.equal(ns, PACKAGE)
  assert.deepEqual(Object.keys(table).sort(), ['en', 'zh'])
  h.setLocale('zh')
  assert.match(textOf(renderCell(h)), /已发布执行配置/)
  h.setLocale('en')
  assert.match(textOf(renderCell(h)), /Published execution configuration/)
  h.setLocale('fr')
  assert.match(textOf(renderCell(h)), /Published execution configuration/)
  for (const code of delegationSettings.PUBLIC_ERROR_CODES) {
    const key = 'delegation.error.' + code
    assert.ok(table.zh[key], 'zh copy for ' + key)
    assert.ok(table.en[key], 'en copy for ' + key)
    assert.notEqual(table.zh[key], table.en[key], 'en copy is not a zh copy: ' + key)
  }
  assert.match(table.zh['delegation.error.PUBLISHER_STOPPED'], /已停止发布/)
  assert.notEqual(table.zh['delegation.error.PUBLISHER_STOPPED'], table.zh['delegation.error.PRESET_BUILD_FAILED'])
  await h.dispose()
})

test('a refused write is not a saved publication; accepted writes still trust the watch', async () => {
  const h = featureHarness({ mutate: (expectedRevision) => expectedRevision === 3 })
  await settleFor(h)
  const first = await saveButton(renderCell(h)).props.onClick()
  assert.equal(first, true)
  await flush()
  assert.equal(h.calls.mutations.length, 1)
  assert.equal(h.calls.mutations[0].expectedRevision, 3)
  assert.deepEqual(h.calls.mutations[0].ops, [{ op: 'set', path: ['workerRoute'], value: { provider: 'p', model: 'm', reasoningEffort: 'high' } }])
  const accepted = renderCell(h)
  assert.ok(findNode(accepted, node => node.props && node.props['data-delegation-save'] === 'accepted'))
  // A successful write never rewrites the published status: only the watch may do that.
  assert.match(textOf(routeNode(accepted, 'published')), /old \/ old-model/)
  // The refreshed revision is fenced for the next write, and a refusal is displayed honestly.
  const second = await saveButton(renderCell(h)).props.onClick()
  assert.equal(second, false)
  await flush()
  assert.deepEqual(h.calls.mutations.map(mutation => mutation.expectedRevision), [3, 4])
  const refused = renderCell(h)
  assert.ok(findNode(refused, node => node.props && node.props['data-delegation-save'] === 'rejected'))
  assert.equal(findNode(refused, node => node.props && node.props['data-delegation-save'] === 'accepted'), null)
  assert.match(textOf(routeNode(refused, 'published')), /old \/ old-model/)
  await h.dispose()
})

test('a transport failure never becomes a saved publication', async () => {
  const h = featureHarness({ mutate: async () => { throw new Error('TOKEN=SECRET') } })
  await settleFor(h)
  assert.equal(await saveButton(renderCell(h)).props.onClick(), false)
  await flush()
  const tree = renderCell(h)
  assert.ok(findNode(tree, node => node.props && node.props['data-delegation-save'] === 'failed'))
  assert.equal(findNode(tree, node => node.props && node.props['data-delegation-save'] === 'accepted'), null)
  assert.doesNotMatch(textOf(tree), /SECRET/)
  await h.dispose()
})

test('a read-only form keeps the save control disabled', async () => {
  const h = featureHarness({ writable: false })
  await settleFor(h)
  assert.equal(saveButton(renderCell(h)).props.disabled, true)
  assert.equal(h.calls.mutations.length, 0)
  await h.dispose()
})

test('an absent Host read namespace degrades to unavailable and leaves the bridge working', async () => {
  const h = featureHarness({ withReadNamespace: false })
  await settleFor(h)
  assert.equal(h.calls.registers.length, 1, 'the cell still exists so the page can explain itself')
  const tree = renderCell(h)
  assert.equal(statusNode(tree).props['data-delegation-status'], 'delegation.status.unavailable')
  assert.match(textOf(tree), /不可用/)
  assert.equal(saveButton(tree).props.disabled, true)
  h.es.emit({ type: 'goto', sessionId: 'S9' })
  assert.deepEqual(h.opened, ['S9'])
  await h.dispose()
})

test('missing optional services keep the original bridge and register no cell', async () => {
  for (const variant of [{ withoutRemote: true }, { withoutSlots: true }, { withoutConfigForms: true },
    { modules: 'without-helper' }]) {
    const h = featureHarness(variant)
    await flush()
    assert.equal(h.instances.length, 1, 'one SSE stream per page: ' + JSON.stringify(variant))
    h.es.emit({ type: 'goto', sessionId: 'S1' })
    assert.deepEqual(h.opened, ['S1'])
    assert.equal(h.calls.registers.length, 0)
    assert.equal(typeof h.dispose, 'function')
    await h.dispose()
    assert.equal(h.es.closed, 1)
  }
})

test('a missing locale service still renders English copy and no dictionary', async () => {
  const h = featureHarness({ withoutLocale: true })
  await settleFor(h)
  assert.equal(h.calls.registers.length, 1, 'the cell does not depend on the optional locale service')
  assert.equal(h.calls.locale.length, 0)
  assert.match(textOf(renderCell(h)), /Published execution configuration/)
  await h.dispose()
})

test('an occupied cell key is left to its occupant', async () => {
  const h = featureHarness({ occupied: true })
  await settleFor(h)
  assert.equal(h.calls.registers.length, 0, 'never replaces another occupant')
  assert.equal(h.instances.length, 1)
  await h.dispose()
})

test('apply cleanup removes every owned stream, subscription and registration', async () => {
  const h = featureHarness()
  await settleFor(h)
  assert.equal(h.calls.watchDisposals, 0)
  await h.dispose()
  assert.equal(h.es.closed, 1)
  assert.equal(h.calls.watchDisposals, 1)
  assert.equal(h.calls.formUnsubscribes, 1)
  assert.equal(h.calls.localeDisposals, 1)
  assert.equal(h.calls.slotDisposals, 1)
  assert.equal(h.calls.registerDisposals, 1)
  assert.equal(h.calls.unmounts, 1)
  assert.equal(h.watchSignal().aborted, true)
  // A late frame after disposal cannot revive the surface.
  h.push({ ...h.status(), state: 'failed', error: 'PRESET_HEALTH_FAILED' })
  await flush()
  assert.equal(statusNode(renderCell(h)).props['data-delegation-status'], 'delegation.status.unavailable')
  await h.dispose()
})

test('a disposed page schedules no reconnect', async () => {
  const timers = []
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length }
  try {
    const h = featureHarness()
    await settleFor(h)
    await h.dispose()
    h.es.fail(FakeClosed())
    assert.equal(timers.length, 0, 'no retry timer after disposal')
  } finally {
    globalThis.setTimeout = realSetTimeout
  }
})

test('the page card is styled through dsw theme tokens with plain fallbacks', async () => {
  const h = featureHarness()
  await settleFor(h)
  const tree = renderCell(h)
  const card = findNode(tree, node => node.props && node.props['data-delegation'] === 'page')
  assert.ok(card, 'the page card must render')
  const style = card.props.style
  assert.ok(style, 'the page card must carry inline styling')
  // Theme tokens first: the card follows the shell's light/dark theme. Every value must
  // carry a plain fallback so a Host without the token system stays readable.
  assert.match(style.background, /var\(--dsw-alias-bg-layer-1,/)
  assert.match(style.border, /var\(--dsw-alias-border-l1,/)
  assert.match(style.color, /var\(--dsw-alias-label-primary,/)
  // Save button uses the brand fill with an inverted label.
  const button = saveButton(tree)
  assert.ok(button, 'the save button must render')
  assert.match(button.props.style.background, /var\(--dsw-alias-button-primary-fill,/)
  assert.match(button.props.style.color, /var\(--dsw-alias-label-primary-inverted,/)
  // Selects inherit the shell font and use the soft hover tint on focus-visible.
  const select = findNode(tree, node => node.type === 'select')
  assert.ok(select, 'a select must render')
  assert.match(select.props.style.background, /var\(--dsw-alias-bg-layer-2,/)
  assert.match(select.props.style.border, /var\(--dsw-alias-border-l2,/)
  assert.match(select.props.style.color, /var\(--dsw-alias-label-primary,/)
  await h.dispose()
})
