import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RUNNING_CAPSULE_LIMIT, projectRunningChildren,
  projectDelegationStatus, projectWorkerCatalogue, projectWorkerEfforts,
  readDelegationResult, createDelegationSettingsController,
} from './delegation-settings.js'
// Namespace import for the locale seam: a missing export is then one failing test, not a
// module-resolution error that hides every assertion in this file.
import * as labels from './delegation-settings.js'

const route = { provider: 'p', model: 'm', reasoningEffort: 'high' }
const status = (overrides = {}) => ({
  settingsNs: 'entry-own', state: 'active', savedRoute: route,
  publishedRoute: { provider: 'old', model: 'old-model' }, generation: 3,
  error: null, ...overrides,
})
const catalogue = (items) => ({ items, total: items.length, truncated: false })
const efforts = { efforts: [{ id: 'high', name: '高' }], defaultEffort: 'high', total: 1, truncated: false }
const ok = (value) => ({ ok: true, value })

// Break caught: a provider/config spread leaks credentials or aliases the saved DTO.
test('status projects public fields into independent immutable saved and published routes', () => {
  const input = status({ token: 'SECRET', savedRoute: { ...route, apiKey: 'SECRET' } })
  const result = projectDelegationStatus(input)
  assert.deepEqual(result, {
    settingsNs: 'entry-own', state: 'active',
    savedRoute: { provider: 'p', model: 'm', reasoningEffort: 'high' },
    publishedRoute: { provider: 'old', model: 'old-model' }, generation: 3, error: null,
    runningCapsule: true,
  })
  input.savedRoute.model = 'changed'
  assert.equal(result.savedRoute.model, 'm')
  assert.ok(Object.isFrozen(result.savedRoute))
  assert.ok(Object.isFrozen(result))
})

// Break caught: malformed status is silently accepted as healthy.
test('status rejects incomplete routes, unknown states, invalid generations and unaddressable namespaces', () => {
  for (const bad of [
    status({ state: 'ready' }), status({ savedRoute: { provider: 'p' } }),
    status({ publishedRoute: { provider: 'p', model: ' ' } }),
    status({ generation: -1 }), status({ generation: 1.5 }),
    status({ settingsNs: ' ' }), status({ error: { token: 'SECRET' } }),
  ]) assert.throws(() => projectDelegationStatus(bad), /DELEGATION_INVALID_DTO/)
  assert.equal(projectDelegationStatus(status({ state: 'failed', error: 'SECRET raw exception' })).error, 'DELEGATION_REMOTE_FAILED')
  assert.equal(projectDelegationStatus(status({ state: 'failed', error: 'API_KEY_SECRET' })).error, 'DELEGATION_REMOTE_FAILED')
  assert.equal(projectDelegationStatus(status({ state: 'failed', error: 'WORKER_ROUTE_UNCONFIGURED' })).error, 'WORKER_ROUTE_UNCONFIGURED')
})

// Break caught: a publisher failure code is collapsed into a generic remote failure.
test('status passes every frozen publisher and gate code through unchanged', () => {
  for (const code of ['INVALID_WORKER_ROUTE', 'WORKER_ROUTE_VALIDATION_FAILED', 'PRESET_BUILD_FAILED',
    'PRESET_RETIRE_FAILED', 'PRESET_REGISTER_FAILED', 'PRESET_HEALTH_FAILED', 'PUBLISHER_STOPPED',
    'WORKER_ROUTE_UNCONFIGURED', 'WORKER_ROUTE_RECOVERY_UNCONFIRMED', 'WORKER_ROUTE_APPROVAL_UNAVAILABLE']) {
    assert.equal(projectDelegationStatus(status({ state: 'failed', error: code })).error, code)
  }
})

// Break caught: a credential-shaped or near-miss string is echoed because it resembles a code.
test('credential-shaped and near-miss errors never pass the public code whitelist', () => {
  for (const error of ['API_KEY_SECRET', 'sk-live-API_KEY_SECRET', 'PRESET_BUILD_FAILED API_KEY=SECRET',
    'WORKER_ROUTE_UNCONFIGURED:x', 'preset_build_failed', ' PUBLISHER_STOPPED']) {
    assert.equal(projectDelegationStatus(status({ state: 'failed', error })).error, 'DELEGATION_REMOTE_FAILED')
  }
})

// Break caught: catalogue projection forwards provider metadata or hides truncation.
test('catalogue retains only id/name and carries honest total and truncated state', () => {
  assert.deepEqual(projectWorkerCatalogue({
    items: [{ id: 'p', name: '提供方', endpoint: 'SECRET' }], total: 900, truncated: true,
  }), { items: [{ id: 'p', name: '提供方' }], total: 900, truncated: true })
})

// Break caught: inconsistent or oversized source-json envelopes become usable options.
test('catalogue rejects duplicate ids, malformed rows, invalid totals and inconsistent truncation', () => {
  for (const bad of [
    { items: [{ id: ' ', name: 'x' }], total: 1, truncated: false },
    { items: [{ id: 'p', name: 'x' }, { id: 'p', name: 'y' }], total: 2, truncated: false },
    { items: [], total: 1, truncated: false }, { items: [], total: 0, truncated: true },
    { items: [], total: -1, truncated: false }, { items: [], total: 1.5, truncated: true },
    { items: [], total: 0, truncated: 'false' },
    { items: Array.from({ length: 4097 }, (_, i) => ({ id: `p${i}`, name: 'x' })), total: 4097, truncated: false },
  ]) assert.throws(() => projectWorkerCatalogue(bad), /DELEGATION_INVALID_DTO/)
})

// Break caught: effort/default metadata gets replaced by a guessed effort enum.
test('efforts preserve metadata ids and permit default outside a truncated retained slice', () => {
  assert.deepEqual(projectWorkerEfforts({
    efforts: [{ id: 'custom', name: '自定义', credential: 'SECRET' }],
    defaultEffort: 'not-retained', total: 2, truncated: true,
  }), { efforts: [{ id: 'custom', name: '自定义' }], defaultEffort: 'not-retained', total: 2, truncated: true })
  assert.deepEqual(projectWorkerEfforts({ efforts: [], defaultEffort: null, total: 0, truncated: false }),
    { efforts: [], defaultEffort: null, total: 0, truncated: false })
  assert.throws(() => projectWorkerEfforts({ ...efforts, defaultEffort: 'missing' }), /DELEGATION_INVALID_DTO/)
})

// Break caught: direct DTO/error envelopes are incorrectly treated as successful RPCs.
test('unary projection requires RemoteResult ok envelope and never exposes raw failure text', () => {
  assert.deepEqual(readDelegationResult(ok(catalogue([])), projectWorkerCatalogue),
    { items: [], total: 0, truncated: false })
  for (const value of [catalogue([]), { ok: 'true', value: catalogue([]) },
    { ok: false, error: { message: 'API_KEY=SECRET', code: 'bad' } }]) {
    assert.throws(() => readDelegationResult(value, projectWorkerCatalogue), /DELEGATION_REMOTE_FAILED/)
  }
})

// Break caught: accessors/class instances execute arbitrary metadata while projecting.
test('DTO readers reject accessors and nonordinary objects without executing getters', () => {
  let calls = 0
  const input = status()
  Object.defineProperty(input, 'state', { get() { calls++; return 'active' } })
  assert.throws(() => projectDelegationStatus(input), /DELEGATION_INVALID_DTO/)
  assert.equal(calls, 0)
  assert.throws(() => projectWorkerCatalogue(new (class { items = []; total = 0; truncated = false })()), /DELEGATION_INVALID_DTO/)
})

function deferred() {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
async function settle() { await new Promise(resolve => setImmediate(resolve)) }
function harness(overrides = {}) {
  const writes = []
  let notify, rejectWatch, cleanupCount = 0
  const read = {
    describeDelegation: async () => ok(status()),
    listWorkerProviders: async () => ok(catalogue([{ id: 'p', name: 'P' }, { id: 'p2', name: 'P2' }])),
    listWorkerModels: async (providerId) => ok(catalogue(providerId === 'p'
      ? [{ id: 'm', name: 'M' }, { id: 'm2', name: 'M2' }] : [{ id: 'other', name: 'Other' }])),
    listWorkerEfforts: async () => ok(efforts),
    ...overrides.read,
  }
  const controller = createDelegationSettingsController({
    read,
    observeDelegation: overrides.observeDelegation || ((onValue, onError, signal) => {
      notify = onValue; rejectWatch = onError
      assert.ok(signal instanceof AbortSignal)
      return async () => { cleanupCount++ }
    }),
    mutateWorkerRoute: overrides.mutateWorkerRoute || (async (settingsNs, ops, expectedRevision) => {
      writes.push({ settingsNs, ops, expectedRevision })
      return true
    }),
  })
  for (const method of ['getSnapshot', 'subscribe', 'connect', 'chooseProvider', 'chooseModel',
    'chooseEffort', 'setFormSnapshot', 'save', 'saveCapsule', 'dispose']) {
    assert.equal(typeof controller[method], 'function', 'controller must expose ' + method)
  }
  return { controller, writes, push: value => notify(value), watchError: () => rejectWatch(new Error('SECRET')),
    cleanupCount: () => cleanupCount }
}
const writable = { ready: true, writable: true, revision: 'rev-7' }

// Break caught: provider/model changes retain an incompatible dependent effort.
test('provider and model changes reset dependent choices; model default omits effort in atomic save', async () => {
  const { controller: c, writes } = harness()
  await c.connect()
  assert.deepEqual(c.getSnapshot().selection, { provider: 'p', model: 'm', reasoningEffort: 'high' })
  await c.chooseModel('m2')
  assert.deepEqual(c.getSnapshot().selection, { provider: 'p', model: 'm2', reasoningEffort: '' })
  assert.equal(c.chooseEffort('high'), true)
  await c.chooseProvider('p2')
  assert.deepEqual(c.getSnapshot().selection, { provider: 'p2', model: '', reasoningEffort: '' })
  assert.equal(await c.save(), false)
  await c.chooseModel('other')
  assert.equal(c.chooseEffort('guessed'), false)
  assert.equal(c.chooseEffort(''), true)
  c.setFormSnapshot(writable)
  assert.equal(await c.save(), true)
  assert.deepEqual(writes, [{ settingsNs: 'entry-own',
    ops: [{ op: 'set', path: ['workerRoute'], value: { provider: 'p2', model: 'other' } }], expectedRevision: 'rev-7' }])
  assert.equal(c.getSnapshot().saveState, 'accepted')
  assert.equal(c.getSnapshot().status.publishedRoute.model, 'old-model')
  await c.dispose()
})

// Break caught: the header-shortcut switch writes its own path, not the route.
test('saveCapsule writes one boolean op against the last known revision', async () => {
  const { controller: c, writes } = harness()
  await c.connect()
  assert.equal(await c.saveCapsule(false), false, 'an unready form cannot be written')
  c.setFormSnapshot(writable)
  assert.equal(await c.saveCapsule(false), true)
  assert.deepEqual(writes, [{ settingsNs: 'entry-own',
    ops: [{ op: 'set', path: ['runningCapsule'], value: false }], expectedRevision: 'rev-7' }])
  assert.equal(c.getSnapshot().saveState, 'accepted')
  await c.dispose()
})

// Break caught: missing callback ports/read-only/loading forms are accepted as writes.
test('missing services, unready or readonly form and absent revision cannot save', async () => {
  const absent = createDelegationSettingsController({})
  assert.ok(absent)
  await absent.connect()
  assert.equal(absent.getSnapshot().connection, 'unavailable')
  assert.equal(await absent.save(), false)
  await absent.dispose()
  const { controller: c, writes } = harness()
  await c.connect()
  for (const form of [
    { ready: false, writable: true, revision: 'r' }, { ready: true, writable: false, revision: 'r' },
    { ready: true, writable: true, revision: null }, { ready: true, writable: true, revision: ' ' },
  ]) { c.setFormSnapshot(form); assert.equal(await c.save(), false) }
  assert.deepEqual(writes, [])
  assert.equal(await c.chooseProvider('missing'), false)
  assert.equal(await c.chooseModel('missing'), false)
  await c.dispose()
})

// Break caught: false/rejected CAS is displayed as save success or exposes transport secrets.
test('mutate false and transport rejection are never successful saves', async () => {
  for (const [mutateWorkerRoute, want] of [
    [async () => false, 'rejected'], [async () => { throw new Error('TOKEN=SECRET') }, 'failed'],
    [async () => ({ ok: true }), 'rejected'],
  ]) {
    const { controller: c } = harness({ mutateWorkerRoute })
    await c.connect(); c.setFormSnapshot(writable)
    assert.equal(await c.save(), false)
    assert.equal(c.getSnapshot().saveState, want)
    assert.ok(!JSON.stringify(c.getSnapshot()).includes('SECRET'))
    await c.dispose()
  }
})

// Break caught: successful write is conflated with healthy publication; watch transitions vanish.
test('watch publishes distinct saved/published states without claiming an actual child model', async () => {
  const h = harness(); const c = h.controller
  const seen = []
  const unsubscribe = c.subscribe(snapshot => seen.push(snapshot))
  assert.equal(seen[0].connection, 'idle')
  await c.connect()
  h.push(status({ state: 'publishing', savedRoute: { provider: 'p2', model: 'other' } }))
  assert.equal(c.getSnapshot().status.state, 'publishing')
  assert.equal(c.getSnapshot().status.savedRoute.model, 'other')
  assert.equal(c.getSnapshot().status.publishedRoute.model, 'old-model')
  h.push(status({ state: 'failed', publishedRoute: null, error: 'WORKER_ROUTE_INVALID' }))
  assert.equal(c.getSnapshot().status.state, 'failed')
  assert.equal(c.getSnapshot().status.publishedRoute, null)
  assert.equal(c.getSnapshot().labels.publishedRoute, '已发布执行配置')
  assert.equal(c.getSnapshot().labels.savedRoute, '已保存配置')
  // The snapshot exposes the frozen status fields and no invented actual-route field.
  assert.deepEqual(Object.keys(c.getSnapshot().status).sort(),
    ['error', 'generation', 'publishedRoute', 'runningCapsule', 'savedRoute', 'settingsNs', 'state'])
  unsubscribe(); const before = seen.length
  h.push(status({ state: 'needs-config', savedRoute: null, publishedRoute: null, generation: null }))
  assert.equal(seen.length, before)
  await c.dispose()
  assert.equal(h.cleanupCount(), 1)
})

// Break caught: truncation disappears in controller state or retained invalid saved model is selected.
test('truncated catalogues remain explicit and unknown saved model stays unselected', async () => {
  const { controller: c } = harness({ read: {
    listWorkerProviders: async () => ok({ items: [{ id: 'p', name: 'P' }], total: 700, truncated: true }),
    listWorkerModels: async () => ok({ items: [{ id: 'different', name: 'D' }], total: 800, truncated: true }),
  } })
  await c.connect()
  assert.equal(c.getSnapshot().providers.truncated, true)
  assert.equal(c.getSnapshot().models.truncated, true)
  assert.deepEqual(c.getSnapshot().selection, { provider: 'p', model: '', reasoningEffort: '' })
  assert.match(c.getSnapshot().labels.truncated, /截断/)
  c.setFormSnapshot(writable)
  assert.equal(await c.save(), false)
  await c.dispose()
})

// Break caught: obsolete model catalogue replaces the current provider's options.
test('out-of-order model responses discard cancelled older provider work', async () => {
  const old = deferred(); const fresh = deferred(); const signals = []
  const { controller: c } = harness({ read: {
    describeDelegation: async () => ok(status({ savedRoute: null })),
    listWorkerModels: (providerId, signal) => { signals.push(signal); return providerId === 'p' ? old.promise : fresh.promise },
  } })
  await c.connect()
  const first = c.chooseProvider('p')
  const second = c.chooseProvider('p2')
  assert.equal(signals[0].aborted, true)
  fresh.resolve(ok(catalogue([{ id: 'other', name: 'Other' }])))
  assert.equal(await second, true)
  old.resolve(ok(catalogue([{ id: 'obsolete', name: 'Old' }])))
  assert.equal(await first, false)
  assert.deepEqual(c.getSnapshot().models.items, [{ id: 'other', name: 'Other' }])
  await c.dispose()
})

// Break caught: obsolete reasoning metadata overwrites the newly chosen model.
test('out-of-order effort responses and old rejection cannot overwrite newer selection', async () => {
  const old = deferred(); const fresh = deferred(); const signals = []
  const { controller: c } = harness({ read: {
    describeDelegation: async () => ok(status({ savedRoute: null })),
    listWorkerEfforts: (providerId, modelId, signal) => {
      signals.push(signal); return modelId === 'm' ? old.promise : fresh.promise
    },
  } })
  await c.connect(); await c.chooseProvider('p')
  const first = c.chooseModel('m'); const second = c.chooseModel('m2')
  assert.equal(signals[0].aborted, true)
  fresh.resolve(ok({ efforts: [{ id: 'custom', name: 'Custom' }], defaultEffort: 'custom', total: 1, truncated: false }))
  await second
  assert.equal(c.chooseEffort('custom'), true)
  old.reject(new Error('SECRET'))
  assert.equal(await first, false)
  assert.deepEqual(c.getSnapshot().selection, { provider: 'p', model: 'm2', reasoningEffort: 'custom' })
  assert.equal(c.getSnapshot().error, null)
  await c.dispose()
})

// Break caught: pending save completion after new revision/change/cancel is reported as successful.
test('pending write cannot become accepted after revision change, selection change or disposal', async () => {
  for (const invalidate of [c => c.setFormSnapshot({ ...writable, revision: 'rev-8' }),
    c => c.chooseEffort(''), c => c.dispose()]) {
    const pending = deferred()
    const { controller: c } = harness({ mutateWorkerRoute: () => pending.promise })
    await c.connect(); c.setFormSnapshot(writable)
    const save = c.save()
    assert.equal(await c.save(), false)
    await invalidate(c)
    pending.resolve(true)
    assert.equal(await save, false)
    assert.notEqual(c.getSnapshot().saveState, 'accepted')
    assert.equal(c.getSnapshot().saving, false)
    await c.dispose()
  }
})

// Break caught: reconnect retains the old watch; stale callbacks mutate the new connection.
test('reconnect awaits owned cleanup and ignores old watch callbacks', async () => {
  const subscriptions = []; const order = []
  const { controller: c } = harness({ observeDelegation: (value, error, signal) => {
    const n = subscriptions.length
    subscriptions.push({ value, error, signal })
    order.push(`watch${n}`)
    return async () => { order.push(`close${n}`) }
  } })
  await c.connect(); await c.connect()
  assert.deepEqual(order, ['watch0', 'close0', 'watch1'])
  assert.equal(subscriptions[0].signal.aborted, true)
  subscriptions[0].value(status({ state: 'failed', error: 'SECRET raw' }))
  assert.equal(c.getSnapshot().status.state, 'active')
  await c.dispose(); await c.dispose()
  assert.deepEqual(order, ['watch0', 'close0', 'watch1', 'close1'])
  subscriptions[1].value(status({ state: 'failed' }))
  assert.equal(c.getSnapshot().connection, 'unavailable')
})

// Break caught: cancelled late observer registration leaks its owned disposer.
test('late watch registration is closed after disposal without reviving state', async () => {
  const registration = deferred(); let disposed = 0; let watchSignal
  const { controller: c } = harness({ observeDelegation: (value, error, signal) => {
    watchSignal = signal; return registration.promise
  } })
  const connecting = c.connect()
  await settle()
  await c.dispose()
  assert.equal(watchSignal.aborted, true)
  registration.resolve(async () => { disposed++ })
  await connecting
  assert.equal(disposed, 1)
  assert.equal(c.getSnapshot().connection, 'unavailable')
})

// Break caught: invalid watch/unary DTO becomes healthy state instead of failing closed.
test('malformed unary or failed watch makes feature unavailable and prevents writes', async () => {
  const bad = harness({ read: { describeDelegation: async () => status() } })
  await bad.controller.connect()
  assert.equal(bad.controller.getSnapshot().connection, 'unavailable')
  await bad.controller.dispose()
  const h = harness(); await h.controller.connect()
  h.watchError(); h.controller.setFormSnapshot(writable)
  assert.equal(h.controller.getSnapshot().connection, 'unavailable')
  assert.equal(await h.controller.save(), false)
  assert.deepEqual(h.writes, [])
  await h.controller.dispose()
})

// Break caught: malformed watch payload or unavailable settings namespace permits a save.
test('malformed watch status and null namespace fail closed without guessed namespace', async () => {
  const h = harness(); await h.controller.connect()
  h.push({ state: 'active' })
  assert.equal(h.controller.getSnapshot().connection, 'unavailable')
  await h.controller.dispose()
  const { controller: c, writes } = harness({ read: {
    describeDelegation: async () => ok(status({ settingsNs: null })),
  } })
  await c.connect(); c.setFormSnapshot(writable)
  assert.equal(await c.save(), false)
  assert.deepEqual(writes, [])
  await c.dispose()
})

// Break caught: the initial saved-route hydration overwrites a newer user selection.
test('initial saved-route hydration never applies old model or effort to a changed provider', async () => {
  const oldModels = deferred()
  const { controller: c } = harness({ read: {
    listWorkerModels: (providerId) => providerId === 'p' ? oldModels.promise
      : Promise.resolve(ok(catalogue([{ id: 'm', name: 'Same id, different provider' }]))),
  } })
  const connecting = c.connect()
  await settle()
  await c.chooseProvider('p2')
  oldModels.resolve(ok(catalogue([{ id: 'm', name: 'Old M' }])))
  await connecting
  assert.deepEqual(c.getSnapshot().selection, { provider: 'p2', model: '', reasoningEffort: '' })
  await c.dispose()
})

// Break caught: disposing twice returns before the owned asynchronous cleanup settles.
test('concurrent disposal callers both await the same owned cleanup', async () => {
  const gate = deferred(); let started = 0, finished = false
  const { controller: c } = harness({ observeDelegation: () => async () => {
    started++; await gate.promise; finished = true
  } })
  await c.connect()
  const first = c.dispose()
  let secondSettled = false
  const second = c.dispose().then(() => { secondSettled = true })
  await settle()
  assert.equal(started, 1)
  assert.equal(secondSettled, false)
  gate.resolve()
  await Promise.all([first, second])
  assert.equal(finished, true)
})

// Break caught: active without a complete published route is incorrectly labelled healthy.
test('active status requires a complete published route', () => {
  assert.throws(() => projectDelegationStatus(status({ publishedRoute: null })), /DELEGATION_INVALID_DTO/)
})

// Break caught: an addressed form revision is reused for a different settings namespace.
test('namespace watch change invalidates form and pending acceptance', async () => {
  const gate = deferred(); const h = harness({ mutateWorkerRoute: () => gate.promise })
  const c = h.controller
  await c.connect(); c.setFormSnapshot(writable)
  const saving = c.save()
  h.push(status({ settingsNs: 'different-entry' }))
  gate.resolve(true)
  assert.equal(await saving, false)
  assert.deepEqual(c.getSnapshot().form, { ready: false, writable: false, revision: null })
  assert.equal(await c.save(), false)
  await c.dispose()
})

// ---------- locale seam and honest status copy (amendment 1 §1 / §5) ----------

// Break caught: the ten frozen public codes collapse into one indistinguishable UI status, or a
// publisher failure is rendered as a healthy publication.
test('label keys keep the ten frozen codes and every state distinct', () => {
  assert.equal(labels.PUBLIC_ERROR_CODES.length, 10)
  const errorKeys = labels.PUBLIC_ERROR_CODES.map(code => labels.errorLabelKey(code))
  assert.equal(new Set(errorKeys).size, 10, 'each frozen code owns a distinct label key')
  for (let index = 0; index < labels.PUBLIC_ERROR_CODES.length; index++) {
    assert.equal(errorKeys[index], 'delegation.error.' + labels.PUBLIC_ERROR_CODES[index])
  }
  // Raw or credential-shaped text never becomes a label key of its own.
  assert.equal(labels.errorLabelKey('PRESET_BUILD_FAILED API_KEY=SECRET'),
    labels.errorLabelKey('DELEGATION_REMOTE_FAILED'))
  assert.notEqual(labels.errorLabelKey('DELEGATION_INVALID_DTO'),
    labels.errorLabelKey('DELEGATION_REMOTE_FAILED'))
  // State copy: publishing is its own status and a retained publication is spelled out.
  assert.equal(labels.statusLabelKey(status({ state: 'publishing', publishedRoute: null })),
    'delegation.status.publishing')
  assert.equal(labels.statusLabelKey(status({ state: 'active' })), 'delegation.status.active')
  assert.equal(labels.statusLabelKey(status({ state: 'needs-config', savedRoute: null, publishedRoute: null })),
    'delegation.status.needsConfig')
  assert.equal(labels.statusLabelKey(status({ state: 'failed', publishedRoute: null })), 'delegation.status.failed')
  assert.equal(labels.statusLabelKey(status({ state: 'failed', publishedRoute: null, error: 'PUBLISHER_STOPPED' })),
    'delegation.status.stopped')
  assert.equal(labels.statusLabelKey(status({ state: 'failed' })), 'delegation.status.failedRetained')
})

// Break caught: the locale dictionary has no key for a status the UI can reach, or the default
// Chinese copy claims something the Host never said.
test('every label key has default copy that never claims an actual child model', () => {
  assert.deepEqual(Object.keys(labels.DEFAULT_LABELS).sort(), Object.keys(labels.LABEL_KEYS).sort())
  assert.equal(labels.DEFAULT_LABELS.publishedRoute, '已发布执行配置')
  for (const field of Object.keys(labels.DEFAULT_LABELS)) {
    assert.ok(labels.DEFAULT_LABELS[field].trim().length > 0, 'copy for ' + field)
  }
  assert.doesNotMatch(labels.DEFAULT_LABELS.publishing, /已发布|已生效/)
  assert.doesNotMatch(labels.DEFAULT_LABELS.failed, /已发布|已生效/)
  assert.doesNotMatch(labels.DEFAULT_LABELS.failedRetained, /已发布|已生效/)
  assert.match(labels.DEFAULT_LABELS.failedRetained, /上一次发布仍然生效/)
})

// Break caught: the controller keeps hardcoded copy and cannot be driven by the locale seam.
test('labels overrides replace copy field by field and ignore unknown or blank values', () => {
  const c = createDelegationSettingsController({ labels: {
    savedRoute: 'Saved configuration', publishedRoute: 'Published execution configuration',
    publishing: 'Publishing', bogus: 'ignored', active: '   ',
  } })
  const copy = c.getSnapshot().labels
  assert.equal(copy.savedRoute, 'Saved configuration')
  assert.equal(copy.publishedRoute, 'Published execution configuration')
  assert.equal(copy.publishing, 'Publishing')
  assert.equal(copy.active, labels.DEFAULT_LABELS.active)
  assert.equal(Object.hasOwn(copy, 'bogus'), false)
  assert.ok(Object.isFrozen(copy))
  // An unusable override object degrades to the default copy instead of breaking the UI.
  const broken = createDelegationSettingsController({ labels: null })
  assert.equal(broken.getSnapshot().labels.publishedRoute, labels.DEFAULT_LABELS.publishedRoute)
})

// Break caught: a locale lookup silently returns the dictionary key as visible copy.
test('labelsFrom resolves every label key through the translate function and fails closed otherwise', () => {
  const resolved = labels.labelsFrom(key => 'RESOLVED ' + key)
  assert.deepEqual(Object.keys(resolved).sort(), Object.keys(labels.LABEL_KEYS).sort())
  for (const field of Object.keys(resolved)) {
    assert.equal(resolved[field], 'RESOLVED ' + labels.LABEL_KEYS[field])
  }
  assert.throws(() => labels.labelsFrom(key => key), /DELEGATION_REMOTE_FAILED/)
  assert.throws(() => labels.labelsFrom(() => '   '), /DELEGATION_REMOTE_FAILED/)
  assert.throws(() => labels.labelsFrom(null), /DELEGATION_REMOTE_FAILED/)
})

// ---------- review follow-ups: catalogue boundary, unavailable provider list, signals, CAS ----------

// Break caught: the exact retained-catalogue boundary is rejected as oversized.
test('the 4096-row retained catalogue boundary is accepted and 4097 is rejected', async () => {
  const rows = Array.from({ length: 4096 }, (_, index) => ({ id: `p${index}`, name: 'x' }))
  assert.equal(projectWorkerCatalogue({ items: rows, total: 4096, truncated: false }).items.length, 4096)
  assert.throws(() => projectWorkerCatalogue({ items: [...rows, { id: 'extra', name: 'x' }], total: 4097, truncated: false }),
    /DELEGATION_INVALID_DTO/)
})

// Break caught: a failed provider read leaves a usable selection behind and still permits a write.
test('provider catalogue failure makes the feature unavailable and blocks every write', async () => {
  const { controller: c, writes } = harness({ read: {
    listWorkerProviders: async () => { throw new Error('API_KEY_SECRET') },
  } })
  await c.connect()
  assert.equal(c.getSnapshot().connection, 'unavailable')
  assert.deepEqual(c.getSnapshot().selection, { provider: '', model: '', reasoningEffort: '' })
  c.setFormSnapshot(writable)
  assert.equal(await c.save(), false)
  assert.deepEqual(writes, [])
  assert.ok(!JSON.stringify(c.getSnapshot()).includes('SECRET'))
  await c.dispose()
})

// Break caught: disposal leaves the root request and the live watch signal uncancelled.
test('dispose aborts the root read signal and the watch signal', async () => {
  const signals = []
  const { controller: c } = harness({
    read: {
      describeDelegation: async (signal) => { signals.push(signal); return ok(status()) },
      listWorkerProviders: async (signal) => { signals.push(signal); return ok(catalogue([{ id: 'p', name: 'P' }])) },
    },
    observeDelegation: (value, error, signal) => {
      signals.push(signal)
      return async () => {}
    },
  })
  await c.connect()
  assert.ok(signals.length >= 3)
  for (const signal of signals) assert.equal(signal.aborted, false)
  await c.dispose()
  for (const signal of signals) assert.equal(signal.aborted, true)
})

// Break caught: a second save reuses the stale revision the adapter already refreshed.
test('a second save after an accepted write fences the refreshed revision', async () => {
  const { controller: c, writes } = harness()
  await c.connect()
  c.setFormSnapshot(writable)
  assert.equal(await c.save(), true)
  c.setFormSnapshot({ ...writable, revision: 'rev-8' })
  assert.equal(await c.save(), true)
  assert.deepEqual(writes.map(write => write.expectedRevision), ['rev-7', 'rev-8'])
  await c.dispose()
})

test('projectRunningChildren lists only running children, newest first', () => {
  const entries = [
    { id: 'a', label: 'A', startedAt: 100 },
    { id: 'b', label: 'B', startedAt: 300 },
    { id: 'c', label: 'C', startedAt: 200 },
  ]
  const running = (id) => id !== 'a'
  const rows = projectRunningChildren(entries, running)
  assert.deepEqual(rows.map((r) => r.id), ['b', 'c'])
  assert.equal(rows[0].label, 'B')
})

test('projectRunningChildren falls back to the id and caps the list', () => {
  const entries = Array.from({ length: 12 }, (_, i) => ({ id: `k${i}`, startedAt: i }))
  const rows = projectRunningChildren(entries, () => true)
  assert.equal(rows.length, RUNNING_CAPSULE_LIMIT)
  assert.equal(rows[0].id, 'k11')
  assert.equal(projectRunningChildren([{ id: 'x' }], () => true)[0].label, 'x')
  assert.deepEqual(projectRunningChildren('nope', () => true), [])
})
