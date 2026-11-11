/**
 * Package-level regression tests (Task 6a): build composition, real preset row, manifest,
 * bundle patch and the gate-port entry.
 *
 * These tests build `lib/` with the same production composition (`scripts/build-lib.mjs`)
 * and then load the artifact, so a green run proves the shipped bundle — not a parallel
 * test-only implementation. Running this file alone is enough to (re)generate `lib/`.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import test, { before } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildLib, HELPER_ID, HELPER_EXPORTS, INLINE_MARKER } from '../../scripts/build-lib.mjs'
import * as sourceHelper from '../client/delegation-settings.js'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const PACKAGE = 'dsh-clean-desktop-shell'
const EVENTS_PATH = '/dsh-clean-desktop-shell/events'
const READ_NS = 'cleanDesktopDelegationRead'
const GATE_MODULE = 'dsh-clean-desktop-shell/delegation-gate'

before(() => {
  buildLib({ root: ROOT })
})

/**
 * Evaluate the built bundle against a fake loader, exactly like a browser would: one
 * `window.__ModuleLoader__.load` call, a module table that only carries `react`.
 */
function bootBuiltBundle() {
  const code = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')
  const registrations = []
  const streams = []
  const required = []
  class FakeEventSource {
    constructor(url) {
      this.url = url
      this.readyState = 0
      streams.push(this)
    }
    close() {}
  }
  FakeEventSource.CLOSED = 2
  // Installed for the rest of this process: `apply` opens the stream lazily, and a test may
  // keep the fake alive after boot. Every boot replaces the previous fake on purpose.
  globalThis.EventSource = FakeEventSource
  new Function('window', code)({ __ModuleLoader__: { load: (definition) => registrations.push(definition) } })
  const table = new Map([
    ['react', { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }) }],
  ])
  const externalRequire = (id) => {
    required.push(id)
    if (!table.has(id)) throw new Error('module is not in the loader table: ' + id)
    return table.get(id)
  }
  return { code, registrations, streams, required, externalRequire }
}

/** Minimal services the optional settings surface asks the child scope for. */
function settingsContext() {
  const calls = { inject: [], mounts: [], registers: [], components: [] }
  const status = {
    settingsNs: 'clean-desktop-shell', state: 'needs-config', savedRoute: null,
    publishedRoute: null, generation: null, error: null,
  }
  const child = {
    remote: {
      $mount: async (contribution) => { calls.mounts.push(contribution); return async () => {} },
    },
    slots: {
      entries: () => [],
      inject: (key, callback) => { const dispose = callback(); return () => { if (typeof dispose === 'function') dispose() } },
      register: (options, Component) => { calls.registers.push({ options, Component }); return () => {} },
    },
    configForms: {
      get: () => ({
        getSnapshot: () => ({ status: 'ready', writable: true, revision: 1 }),
        subscribe: () => () => {},
        mutate: async () => true,
      }),
    },
    get: () => null,
    on: () => () => {},
  }
  child.remote[READ_NS] = {
    describeDelegation: () => status,
    listWorkerProviders: () => ({ items: [], total: 0, truncated: false }),
    listWorkerModels: () => ({ items: [], total: 0, truncated: false }),
    listWorkerEfforts: () => ({ efforts: [], defaultEffort: null, total: 0, truncated: false }),
    watchDelegation: () => ({
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
      dispose: () => {},
    }),
  }
  const ctx = {
    inject: (deps, callback) => {
      calls.inject.push(deps)
      if (deps.some((name) => !(name in child))) return { dispose: async () => {} }
      callback(child)
      return { dispose: async () => {} }
    },
    uiWorkspace: { openSession: () => {} },
    uiSession: { sessionStatus: { getSnapshot: () => new Map(), subscribe: () => () => {} } },
  }
  return { ctx, calls }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test('the built bundle carries one registration with the helper inlined, never imported', () => {
  const bundle = bootBuiltBundle()
  assert.equal(bundle.registrations.length, 1, 'the artifact must register exactly one module')
  assert.equal(bundle.registrations[0].id, PACKAGE)
  assert.equal(typeof bundle.registrations[0].factory, 'function')
  assert.ok(bundle.code.includes(INLINE_MARKER), 'the composition marker must be in lib/client.js')
  const exports = bundle.registrations[0].factory(bundle.externalRequire)
  assert.ok(!bundle.required.includes(HELPER_ID),
    'the loader module table must never be asked for the helper: it is inlined')
  assert.deepEqual(bundle.required, ['react'], 'react stays the only external from the module table')
  assert.equal(typeof exports.apply, 'function')
})

test('the built bundle keeps the original inject roster and the one SSE route', () => {
  const bundle = bootBuiltBundle()
  const exports = bundle.registrations[0].factory(bundle.externalRequire)
  assert.deepEqual(exports.inject, ['uiSession', 'uiWorkspace', 'sessions'])
  const { ctx } = settingsContext()
  exports.apply(ctx)
  assert.equal(bundle.streams.length, 1, 'one SSE stream per page')
  assert.equal(bundle.streams[0].url, EVENTS_PATH)
})

test('the inlined helper namespace really resolves and registers the keyed settings cell', async () => {
  const bundle = bootBuiltBundle()
  const exports = bundle.registrations[0].factory(bundle.externalRequire)
  const { ctx, calls } = settingsContext()
  exports.apply(ctx)
  await tick()
  assert.deepEqual(calls.inject[0], ['remote', 'slots', 'configForms'],
    'the cell is declared on a child scope, exactly like Task 5')
  assert.equal(calls.registers.length, 1, 'composition must reach the slot registration')
  const [{ options, Component }] = calls.registers
  assert.equal(options.name, 'plugins.bundle.config')
  assert.equal(options.key, PACKAGE)
  assert.equal(typeof Component, 'function')
  const face = options.inject().delegation
  const status = {
    settingsNs: 'clean-desktop-shell', state: 'active', savedRoute: { provider: 'p', model: 'm' },
    publishedRoute: { provider: 'p', model: 'm' }, generation: 1, error: null,
  }
  assert.deepEqual(face.keys, sourceHelper.LABEL_KEYS, 'the inlined namespace is the frozen helper')
  assert.equal(face.statusKey(status), sourceHelper.statusLabelKey(status))
  assert.equal(face.errorKey('PRESET_HEALTH_FAILED'), sourceHelper.errorLabelKey('PRESET_HEALTH_FAILED'))
  assert.equal(typeof face.controller.save, 'function')
  for (const name of HELPER_EXPORTS) {
    assert.ok(name in sourceHelper, `the frozen helper must expose ${name}`)
  }
})

test('the built preset definitions expose one pure copy and one gated router copy', async () => {
  const preset = await import(pathToFileURL(join(ROOT, 'lib/host/delegation-preset.js')).href)
  const route = { provider: 'contract-deterministic', model: 'contract-model', reasoningEffort: 'medium' }
  const { pure, router, dropped } = preset.buildDelegationPresets(route, 'win32', { resolve: (name) => name })
  assert.deepEqual(dropped, [])
  assert.equal(pure.id, 'clean-desktop-shell-ptc')
  assert.equal(router.id, 'clean-desktop-shell-ptc-router')
  assert.equal(pure.plugins.some((plugin) => plugin.id === 'delegation-gate'), false)
  const delegation = router.plugins.find((plugin) => plugin.id === 'delegation')
  const gateRows = delegation.config.filter((plugin) => plugin.id === 'delegation-gate')
  assert.equal(gateRows.length, 1, 'exactly one gate row, never zero and never duplicated')
  assert.equal(gateRows.at(-1), delegation.config.at(-1), 'the gate closes the delegation group')
  assert.equal(gateRows[0].name, GATE_MODULE)
  assert.deepEqual(gateRows[0].config, { workerRoute: route })
  assert.equal(router.plugins.filter((plugin) => plugin.name === GATE_MODULE).length, 0)
  assert.deepEqual(delegation.config.find((plugin) => plugin.id === 'tool-subagent').config.agentOptions, route)
  assert.equal(delegation.config.find((plugin) => plugin.id === 'tool-subagent').config.maxDepth, 1)
  const persona = readFileSync(join(ROOT, 'assets/delegation/persona.md'), 'utf8')
  const prefix = router.plugins.find((plugin) => plugin.id === 'persona').config.prefix
  assert.ok(prefix.includes('## 顶层主脑分工'), 'the built preset must carry the shipped persona asset')
  assert.ok(prefix.includes('contract-deterministic / contract-model（reasoningEffort: medium）'),
    'the persona placeholder is filled with the configured route')
  assert.ok(!persona.includes('contract-deterministic'), 'the asset itself stays route-free')
  assert.equal(pure.plugins.find((plugin) => plugin.id === 'persona').config.prefix,
    'You are a coding agent powered by the {{model}} model.')
})

test('the built host layout keeps ../../assets/delegation resolvable from lib/host', () => {
  const built = pathToFileURL(join(ROOT, 'lib/host/delegation-preset.js'))
  const resolved = fileURLToPath(new URL('../../assets/delegation/persona.md', built))
  assert.equal(resolved, join(ROOT, 'assets/delegation/persona.md'))
  for (const asset of ['persona.md', 'provenance.json', 'ptc-rc5.yml']) {
    assert.ok(existsSync(join(ROOT, 'assets/delegation', asset)), `missing asset: ${asset}`)
  }
})

test('the manifest exports and files ship every host entry, the bundle and the preset assets', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.main, 'lib/index.js')
  for (const [subpath, target] of Object.entries(pkg.exports)) {
    assert.ok(target.startsWith('./'), `${subpath} must stay inside the package`)
    assert.ok(existsSync(join(ROOT, target)), `exports target is missing after build: ${subpath} -> ${target}`)
  }
  for (const subpath of ['.', './client', './delegation', './delegation-gate', './delegation-gate-ports']) {
    assert.ok(subpath in pkg.exports, `exports is missing ${subpath}`)
  }
  assert.ok(pkg.files.includes('lib/'), 'lib/ must ship recursively')
  assert.ok(pkg.files.includes('assets/delegation/**'), 'the preset assets must ship')
  assert.ok(!pkg.files.some((entry) => entry.includes('.dsh-tmp')), 'scratch must never ship')
  for (const group of ['dependencies', 'devDependencies', 'peerDependencies']) {
    for (const name of Object.keys(pkg[group] || {})) {
      assert.ok(!/zustand|immer/.test(name), `${group} must not carry a test-only package: ${name}`)
      if (group === 'dependencies') assert.ok(!name.startsWith('@deepseek-ai/'), `no bundled Host core: ${name}`)
    }
  }
})

test('the bundle patch mounts the gate-port entry before the publishing entry', () => {
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  const rows = [...patch.matchAll(/-\s+id:\s*([A-Za-z0-9_-]+)\s*\n\s+name:\s*'([^']+)'/g)]
    .map((match) => ({ id: match[1], name: match[2] }))
  const ports = rows.findIndex((row) => row.id === 'clean-desktop-shell-delegation-ports')
  const publisher = rows.findIndex((row) => row.id === 'clean-desktop-shell-delegation')
  assert.ok(rows.some((row) => row.id === 'clean-desktop-shell' && row.name === PACKAGE),
    'the original plugin row stays in the patch')
  assert.ok(ports >= 0, 'the gate-port row must be in the patch')
  assert.ok(publisher >= 0, 'the delegation publisher row must be in the patch')
  assert.ok(ports < publisher, 'ports must be declared before the publisher registers a preset')
  assert.equal(rows[ports].name, 'dsh-clean-desktop-shell/delegation-gate-ports')
  assert.equal(rows[publisher].name, 'dsh-clean-desktop-shell/delegation')
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.exports['./delegation-gate-ports'], './lib/host/delegation-gate-ports.js',
    'the patch row must be resolvable through the manifest')
})

test('the gate-port entry declares the three stateless ports under the frozen service name', async () => {
  const runtimeRoot = process.env.DSH_CONTRACT_RUNTIME_ROOT
  const built = join(ROOT, 'lib/host/delegation-gate-ports.js')
  const source = readFileSync(built, 'utf8')
  assert.match(source, /GATE_PORTS_SERVICE = 'delegationGatePorts'/, 'the gate reads this exact name')
  assert.match(source, /scopeOf/, 'scopeOf port')
  assert.match(source, /scopeChainOf/, 'scopeChainOf port')
  assert.match(source, /foldRequestHeader/, 'foldRequestHeader port')
  if (typeof runtimeRoot !== 'string' || runtimeRoot.length === 0) {
    assert.match(source, /from '@deepseek-ai\/dsh-scope'/)
    assert.match(source, /from '@deepseek-ai\/dsh-session'/)
    return
  }
  const requireFromRuntime = createRequire(join(realpathSync(runtimeRoot), 'package.json'))
  const mapped = new Map([
    ['@deepseek-ai/dsh-scope', requireFromRuntime.resolve('@deepseek-ai/dsh-scope')],
    ['@deepseek-ai/dsh-session', requireFromRuntime.resolve('@deepseek-ai/dsh-session')],
  ])
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const target = mapped.get(specifier)
      if (target !== undefined) return { url: pathToFileURL(target).href, shortCircuit: true }
      return nextResolve(specifier, context)
    },
  })
  const ports = await import(pathToFileURL(built).href)
  assert.equal(ports.name, 'dsh-clean-desktop-shell/delegation-gate-ports')
  const declaration = ports.createWorkerGatePorts()
  for (const key of ['scopeOf', 'scopeChainOf', 'foldRequestHeader']) {
    assert.equal(typeof declaration[key], 'function', `${key} must be a real runtime function`)
  }
  assert.ok(Object.isFrozen(declaration), 'the declaration is frozen')
  assert.equal(declaration.scopeOf({}), undefined,
    'the real scopeOf reports an unscoped plain object as undefined')
  const provided = []
  const disposer = ports.apply({ provide: (name, value) => { provided.push({ name, value }); return () => {} } })
  assert.equal(typeof disposer, 'function')
  assert.deepEqual(provided.map((entry) => entry.name), ['delegationGatePorts'])
  assert.throws(() => ports.apply({}), /ctx\.provide is required/)
})
