import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { associateWorkerRouteReceipt, parseWorkerRouteReceiptContent, parseWorkerRouteReceiptText } from './delegation-evidence.js';
import { configureWorkerGatePorts, installWorkerGate, readWorkerRouteEvidence } from './delegation-gate.js';

const prefix = '[dsh-clean-desktop-shell/worker-route-receipt@1] ';
function receipt(overrides = {}) {
  return {
    schema: 'dsh-clean-desktop-shell/worker-route-receipt@1',
    parentSessionId: 'parent-a',
    callId: 'call-a',
    rootCallId: 'root-a',
    toolName: 'subagent',
    childSessionId: 'child-a',
    declared: {
      source: 'bound-stock-agent-options',
      provider: 'worker-provider',
      model: 'worker-model',
      reasoningEffort: 'medium',
    },
    actual: { status: 'not-established-by-receipt' },
    ...overrides,
  };
}
function text(value = receipt()) {
  return prefix + JSON.stringify(value);
}

// Break caught: dropping a valid bound declaration or upgrading it to actual proof.
test('canonical receipt keeps declaration and explicitly unestablished actual route', () => {
  assert.deepEqual(parseWorkerRouteReceiptText(text()), {
    schema: 'dsh-clean-desktop-shell/worker-route-receipt@1',
    parentSessionId: 'parent-a',
    callId: 'call-a',
    rootCallId: 'root-a',
    toolName: 'subagent',
    childSessionId: 'child-a',
    declared: {
      source: 'bound-stock-agent-options',
      provider: 'worker-provider',
      model: 'worker-model',
      reasoningEffort: 'medium',
    },
    actual: { status: 'not-established-by-receipt' },
  });
});

// Break caught: accepting rewritten JSON or duplicate keys as a canonical declaration.
for (const [name, input] of [
  ['leading whitespace', ' ' + text()],
  ['payload whitespace', prefix + ' ' + JSON.stringify(receipt())],
  ['trailing whitespace', text() + '\n'],
  ['duplicate root key', text().replace('"callId":"call-a",', '"callId":"forged","callId":"call-a",')],
  ['duplicate escaped key', text().replace('"callId":"call-a",', '"call\\u0049d":"forged","callId":"call-a",')],
  ['duplicate nested key', text().replace('"model":"worker-model",', '"model":"forged","model":"worker-model",')],
  ['truncated payload', text().slice(0, -1)],
  ['appended envelope', text() + text()],
  ['wrong version', text().replaceAll('receipt@1', 'receipt@2')],
  ['malformed payload', prefix + '{'],
  ['non-string', null],
]) {
  test(`receipt rejects ${name}`, () => {
    assert.equal(parseWorkerRouteReceiptText(input), null);
  });
}

// Break caught: treating structurally invalid or claimed actual routing as evidence.
for (const [name, value] of [
  ['null object', null], ['array object', []], ['primitive', 'receipt'],
  ['schema literal', receipt({ schema: 'other' })],
  ['tool literal', receipt({ toolName: 'run_code' })],
  ['unknown root field', receipt({ extra: true })],
  ['missing root field', (({ callId, ...rest }) => rest)(receipt())],
  ['unknown declared field', receipt({ declared: { ...receipt().declared, actual: true } })],
  ['wrong declared source', receipt({ declared: { ...receipt().declared, source: 'user' } })],
  ['missing provider', receipt({ declared: { source: 'bound-stock-agent-options', model: 'worker-model' } })],
  ['array declared', receipt({ declared: [] })],
  ['null actual', receipt({ actual: null })],
  ['actual route claim', receipt({ actual: { status: 'matched', provider: 'worker-provider' } })],
  ['extra actual field', receipt({ actual: { status: 'not-established-by-receipt', model: 'worker-model' } })],
  ['prototype key', JSON.parse(JSON.stringify(receipt()).replace('"callId":"call-a",', '"__proto__":{},"callId":"call-a",'))],
]) {
  test(`receipt rejects ${name}`, () => {
    assert.equal(parseWorkerRouteReceiptText(text(value)), null);
  });
}

const boundedFields = [
  ['parentSessionId', 256], ['callId', 256], ['rootCallId', 256], ['childSessionId', 256],
  ['provider', 512], ['model', 1024], ['reasoningEffort', 64],
];
function withField(field, value) {
  const valueReceipt = receipt();
  if (Object.hasOwn(valueReceipt.declared, field)) valueReceipt.declared[field] = value;
  else valueReceipt[field] = value;
  return valueReceipt;
}
// Break caught: off-by-one bounds, empty identities, Unicode byte/code-unit confusion.
for (const [field, max] of boundedFields) {
  test(`receipt preserves ${field} at its frozen maximum`, () => {
    const value = withField(field, '界'.repeat(max));
    assert.deepEqual(parseWorkerRouteReceiptText(text(value)), value);
  });
  for (const [name, invalid] of [
    ['empty', ''], ['blank', '\t \n'], ['overlong', 'x'.repeat(max + 1)],
    ['null', null], ['number', 12], ['array', ['worker']], ['object', {}],
  ]) {
    test(`receipt rejects ${field} ${name}`, () => {
      assert.equal(parseWorkerRouteReceiptText(text(withField(field, invalid))), null);
    });
  }
}

test('receipt accepts optional reasoning absence without fabricating a default', () => {
  const value = receipt();
  delete value.declared.reasoningEffort;
  assert.deepEqual(parseWorkerRouteReceiptText(text(value)), value);
});

test('receipt preserves route whitespace and unrestricted reasoning without normalization', () => {
  const value = receipt({ declared: {
    source: 'bound-stock-agent-options', provider: ' provider / 不改 ', model: ' model / 🚀 ', reasoningEffort: 'custom-future-level',
  } });
  assert.deepEqual(parseWorkerRouteReceiptText(text(value)), value);
});

test('receipt accepts maximum escaped fields while preserving their complete original values', () => {
  let value = receipt();
  for (const [field, max] of boundedFields) {
    const fieldValue = '\u0001'.repeat(max);
    if (Object.hasOwn(value.declared, field)) value.declared[field] = fieldValue;
    else value[field] = fieldValue;
  }
  assert.ok(Buffer.byteLength(text(value), 'utf8') <= 16_384);
  assert.deepEqual(parseWorkerRouteReceiptText(text(value)), value);
});

test('receipt rejects a complete marker plus payload beyond the UTF-8 byte cap', () => {
  const oversized = prefix + JSON.stringify({ ...receipt(), extra: '界'.repeat(16_384) });
  assert.ok(Buffer.byteLength(oversized, 'utf8') > 16_384);
  assert.equal(parseWorkerRouteReceiptText(oversized), null);
});

const content = (value = receipt()) => [{ type: 'text', text: text(value) }];

// This DTO is a hypothetical output of a future trusted history adapter, not raw SDK evidence.
function activation(overrides = {}) {
  return {
    sourceKind: 'native-tool-result', trusted: true, complete: true, success: true,
    stock: true, associationsVerified: true, toolName: 'subagent',
    parentSessionId: 'parent-a', callId: 'call-a', rootCallId: 'root-a', childSessionId: 'child-a',
    ...overrides,
  };
}

test('content extracts one canonical block without treating it as trusted actual evidence', () => {
  assert.deepEqual(parseWorkerRouteReceiptContent([
    { type: 'text', text: 'Ordinary successful tool output.' },
    ...content(),
  ]), receipt());
});

// Break caught: picking a preferred receipt from an ambiguous or truncated event.
for (const [name, blocks] of [
  ['no block', []], ['plain user string', text()],
  ['duplicate identical blocks', [...content(), ...content()]],
  ['duplicate conflicting blocks', [...content(), ...content(receipt({ childSessionId: 'other-child' }))]],
  ['valid plus truncated block', [...content(), { type: 'text', text: text().slice(0, -2) }]],
  ['valid plus truncated marker', [...content(), { type: 'text', text: '[dsh-clean-desktop-shell/worker' }]],
  ['valid plus wrong version block', [...content(), { type: 'text', text: text().replaceAll('receipt@1', 'receipt@2') }]],
  ['two envelopes in one block', [{ type: 'text', text: text() + '\n' + text() }]],
  ['wrapped marker', [{ type: 'text', text: 'Printed: ' + text() }]],
  ['non-text receipt block', [{ type: 'image', text: text() }]],
  ['invalid block', [null, ...content()]],
  ['extra candidate field', [{ type: 'text', text: text(), source: 'user' }]],
]) {
  test(`content rejects ${name}`, () => {
    assert.equal(parseWorkerRouteReceiptContent(blocks), null);
  });
}

for (const sourceKind of ['native-tool-result', 'ptc-inner-stock-settle']) {
  test(`associated ${sourceKind} supplies declaration only through the explicit pure port`, () => {
    assert.deepEqual(associateWorkerRouteReceipt(content(), activation({ sourceKind })), {
      status: 'declared-only', receipt: receipt(),
    });
  });
}

// Break caught: upgrading untrusted/user/outer run_code text into stock-child provenance.
for (const [name, context] of [
  ['missing activation', undefined], ['null activation', null], ['array activation', []],
  ['user source', activation({ sourceKind: 'user-message' })],
  ['model source', activation({ sourceKind: 'model-message' })],
  ['outer run_code source', activation({ sourceKind: 'run-code-result' })],
  ['non-stock result', activation({ stock: false })],
  ['untrusted result', activation({ trusted: false })],
  ['incomplete result', activation({ complete: false })],
  ['failed settle', activation({ success: false })],
  ['unverified start-settle linkage', activation({ associationsVerified: false })],
  ['truthy instead of boolean', activation({ trusted: 'true' })],
  ['wrong tool', activation({ toolName: 'run_code' })],
  ['fabricated current route', activation({ provider: 'worker-provider', model: 'worker-model' })],
  ['inherited activation', Object.create(activation())],
]) {
  test(`association leaves ${name} unknown`, () => {
    assert.deepEqual(associateWorkerRouteReceipt(content(), context), { status: 'unknown' });
  });
}

for (const field of ['parentSessionId', 'callId', 'rootCallId', 'childSessionId']) {
  for (const [name, value] of [['mismatched', 'other'], ['missing', undefined], ['blank', ' '], ['overlong', 'x'.repeat(257)]]) {
    test(`association leaves ${field} ${name} unknown without fallback`, () => {
      assert.deepEqual(associateWorkerRouteReceipt(content(), activation({ [field]: value })), { status: 'unknown' });
    });
  }
}

test('verified activation still leaves duplicate receipt content unknown', () => {
  assert.deepEqual(associateWorkerRouteReceipt([...content(), ...content()], activation()), { status: 'unknown' });
});

test('association preserves originals and does not manufacture an actual route', () => {
  const blocks = content();
  const context = activation();
  const before = structuredClone({ blocks, context });
  const result = associateWorkerRouteReceipt(blocks, context);
  assert.equal(result.status, 'declared-only');
  assert.deepEqual(result.receipt.actual, { status: 'not-established-by-receipt' });
  assert.deepEqual({ blocks, context }, before);
});

test('receipt counts reasoning bounds as JavaScript code units, not Unicode code points', () => {
  const accepted = withField('reasoningEffort', '🚀'.repeat(32));
  assert.deepEqual(parseWorkerRouteReceiptText(text(accepted)), accepted);
  assert.equal(parseWorkerRouteReceiptText(text(withField('reasoningEffort', '🚀'.repeat(33)))), null);
});

test('marker text inside an original route string is not a second serialized envelope', () => {
  const value = withField('model', prefix + 'literal-model');
  assert.deepEqual(parseWorkerRouteReceiptText(text(value)), value);
  assert.deepEqual(parseWorkerRouteReceiptContent(content(value)), value);
});

test('association rejects accessor provenance without invoking it', () => {
  const context = activation();
  let reads = 0;
  Object.defineProperty(context, 'trusted', { enumerable: true, get() { reads += 1; return true; } });
  assert.deepEqual(associateWorkerRouteReceipt(content(), context), { status: 'unknown' });
  assert.equal(reads, 0);
});

// ---------------------------------------------------------------------------
// Task 4 gate binding. This harness mirrors the declared rc.5 registry order
// (tools/pre-execute waterfall -> approval mapping -> monotonic guard -> body)
// and the declared scope chain routing. It is adapter-level proof: the real
// rc.5 mount, approval audit events and child request headers are Task 6.
// ---------------------------------------------------------------------------

const WORKER_ROUTE = Object.freeze({ provider: 'worker-provider', model: 'worker-model', reasoningEffort: 'medium' });
const OTHER_ROUTE = Object.freeze({ provider: 'other-provider', model: 'other-model', reasoningEffort: 'low' });

/**
 * Tool layers are keyed by SCOPE KEY, exactly like `ToolRuntime.layers`
 * (`chainLayers(scope)` -> nearest `ScopeKey` last). A lookup addressed with
 * anything that is not a registered scope key sees only the global layer, which
 * is the failure mode a scope-blinded harness used to hide.
 */
function makeScopeWorld() {
  const parents = new Map();
  const layers = new Map();
  const globalTools = new Map();
  const keys = new Set();
  const root = {};
  const otherRoot = {};
  const scopeOf = (ctx) => ctx?.__scopeKey;
  const chainOf = (key) => {
    const chain = [];
    const seen = new Set();
    let current = key;
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      chain.push(current);
      current = parents.get(current);
    }
    return chain;
  };
  const childScope = (parent) => {
    const key = {};
    parents.set(key, parent);
    keys.add(key);
    return key;
  };
  const layerOf = (key) => {
    let layer = layers.get(key);
    if (layer === undefined) {
      layer = new Map();
      layers.set(key, layer);
    }
    return layer;
  };
  const isKey = (value) => keys.has(value);
  keys.add(root);
  keys.add(otherRoot);
  /**
   * The installed runtime's `get(name, scope)`: scoped layers shadow the global
   * one, nearest key wins. An unrecognised scope (an Agent object, say) resolves
   * no scoped layer at all, so only the global layer is visible.
   */
  const getTool = (name, scope) => {
    if (scope === undefined) return globalTools.get(name);
    if (!isKey(scope)) return globalTools.get(name);
    for (const key of chainOf(scope)) {
      const layer = layers.get(key);
      if (layer !== undefined && layer.has(name)) return layer.get(name);
    }
    return globalTools.get(name);
  };
  return { root, otherRoot, scopeOf, chainOf, childScope, layerOf, isKey, globalTools, getTool };
}

function makeContext({ scopeKey, services = {}, world = null } = {}) {
  const listeners = new Map();
  const guards = new Set();
  const definitions = world === null ? new Map() : world.layerOf(scopeKey);
  const getCalls = [];
  const ctx = {
    __scopeKey: scopeKey,
    on(type, listener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
      return () => set.delete(listener);
    },
    emit(type, ...args) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(...args);
    },
    effect(fn) { return fn(); },
    get(name) { return services[name]; },
    tools: {
      guard(listener) { guards.add(listener); return () => guards.delete(listener); },
      get(toolName, scope) {
        getCalls.push({ name: toolName, scope });
        return world === null ? definitions.get(toolName) : world.getTool(toolName, scope);
      },
    },
  };
  return Object.assign(ctx, { listeners, guards, definitions, getCalls, tools: Object.assign(ctx.tools, { getCalls }) });
}

function makeRuntime({ policy = 'ask', outcome = 'allowed-once', resolveFailure = null, defaultEffort = 'medium', sessions = new Map() } = {}) {
  const state = { children: 0, forks: 0, approvals: [], requests: [], decisions: [], reads: 0 };
  const approval = {
    config: { policy },
    overrideOf() { return undefined; },
    async request(request) {
      state.approvals.push(request);
      if (outcome === 'throw') throw new Error('approval channel failed');
      return outcome;
    },
  };
  const llm = {
    async resolveCallConfig(request, signal) {
      state.requests.push({ ...request, aborted: signal?.aborted === true });
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      if (resolveFailure) throw resolveFailure;
      return {
        provider: request.provider,
        model: request.model,
        ...(request.reasoningEffort === undefined
          ? (defaultEffort === undefined ? {} : { reasoningEffort: defaultEffort })
          : { reasoningEffort: request.reasoningEffort }),
      };
    },
  };
  const sessionQuery = {
    async readSession(id) {
      state.reads += 1;
      const snapshot = sessions.get(id);
      if (snapshot instanceof Error) throw snapshot;
      if (snapshot === undefined) throw Object.assign(new Error('session not found'), { code: 'SESSION_NOT_FOUND' });
      return structuredClone(snapshot);
    },
  };
  const foldRequestHeader = (events) => {
    let header;
    for (const event of events ?? []) {
      if (event?.type === 'request/header' && event.data?.header !== undefined) header = event.data.header;
    }
    return header;
  };
  return { state, approval, llm, sessionQuery, foldRequestHeader };
}

async function dispatch(runtime, ctx, exec) {
  // rc.5 order: pre-execute waterfall -> approval mapping -> monotonic guard -> body.
  const listeners = [...(ctx.listeners.get('tools/pre-execute') ?? [])];
  let index = 0;
  const next = async () => (index < listeners.length ? listeners[index++](exec, next) : { kind: 'allow' });
  const decision = await next();
  if (decision.kind === 'deny' || decision.kind === 'cancel') {
    runtime.state.decisions.push(decision);
    return decision;
  }
  if (decision.kind === 'ask') {
    let outcome;
    try {
      outcome = await runtime.approval.request({
        agent: exec.agent, toolName: exec.name, callId: exec.callId, reason: decision.reason, signal: exec.signal,
      });
    } catch {
      outcome = 'unavailable';
    }
    if (outcome !== 'allowed-once') {
      const denied = { kind: 'deny', reason: `approval ${outcome}` };
      runtime.state.decisions.push(denied);
      return denied;
    }
  }
  for (const guard of ctx.guards) {
    const reason = guard(exec);
    if (typeof reason === 'string') {
      const denied = { kind: 'deny', reason };
      runtime.state.decisions.push(denied);
      return denied;
    }
  }
  if (exec.name === 'subagent_fork') runtime.state.forks += 1;
  else if (exec.name === 'subagent') runtime.state.children += 1;
  const allowed = { kind: 'allow' };
  runtime.state.decisions.push(allowed);
  return allowed;
}

async function runPostExecute(ctx, exec, result, downstream = { kind: 'accept' }) {
  const listeners = [...(ctx.listeners.get('tools/post-execute') ?? [])];
  let index = 0;
  const next = async () => (index < listeners.length ? listeners[index++](exec, result, next) : downstream);
  return next();
}

function makeAgent(world, { id, root = world.root, services = {}, firstLiveSeq = 0, scoped = false } = {}) {
  const scopeKey = world.childScope(root);
  return {
    id,
    ctx: scoped
      ? makeContext({ scopeKey, world, services })
      : { __scopeKey: scopeKey, get(name) { return services[name]; } },
    session: { id, seq: firstLiveSeq, firstLiveSeq, firstLifecycleSeq: firstLiveSeq, inheritedEventCount: 0 },
  };
}

function gatePortsFor(world, runtime, ctx, { ports = {}, stockDefinition = null } = {}) {
  return {
    scopeOf: world.scopeOf,
    scopeChainOf: world.chainOf,
    tools: ctx.tools,
    approval: runtime.approval,
    llm: runtime.llm,
    sessionQuery: runtime.sessionQuery,
    foldRequestHeader: runtime.foldRequestHeader,
    ...(stockDefinition === null ? {} : { stockSubagentDefinition: stockDefinition }),
    ...ports,
  };
}

function makeGate(world, runtime, { route = { ...WORKER_ROUTE }, ports = {}, stockDefinition = null, scopeKey = world.root } = {}) {
  const ctx = makeContext({ scopeKey, world });
  if (stockDefinition !== null) ctx.definitions.set('subagent', stockDefinition);
  const gatePorts = gatePortsFor(world, runtime, ctx, { ports, stockDefinition });
  const dispose = installWorkerGate(ctx, route, gatePorts);
  return { ctx, dispose, ports: gatePorts, definitions: ctx.definitions };
}

/** Install the gate on a live Agent (the entry the brief names) instead of a row context. */
function makeAgentGate(world, runtime, agent, { route = { ...WORKER_ROUTE }, ports = {}, stockDefinition = null } = {}) {
  const gatePorts = gatePortsFor(world, runtime, agent.ctx, { ports, stockDefinition });
  return installWorkerGate(agent, route, gatePorts);
}

function receiptFor({ callId = 'call-a', rootCallId = callId, childId = 'child-a', parentId = 'parent-a', declared = WORKER_ROUTE } = {}) {
  return {
    schema: 'dsh-clean-desktop-shell/worker-route-receipt@1',
    parentSessionId: parentId,
    callId,
    rootCallId,
    toolName: 'subagent',
    childSessionId: childId,
    declared: { source: 'bound-stock-agent-options', ...declared },
    actual: { status: 'not-established-by-receipt' },
  };
}

function activationSnapshot({ callId = 'call-a', rootCallId = callId, childId = 'child-a', parentId = 'parent-a', callSeq = 1, resultSeq = 2, receiptValue = receiptFor({ callId, rootCallId, childId, parentId }), content = null, isError = false, surfaceOp = 'append' } = {}) {
  const resultContent = content ?? [
    { type: 'text', text: `started subagent ${childId}` },
    { type: 'text', text: prefix + JSON.stringify(receiptValue) },
  ];
  return {
    session: { id: parentId },
    inheritedEventCount: 0,
    events: [
      { type: 'tool/call', seq: callSeq, data: { callId, name: 'subagent', arguments: '{}' } },
      {
        type: 'tool/result', seq: resultSeq, surfaceOp, sourceEventSeqs: [callSeq],
        data: { message: { source: { kind: 'tool' }, toolCallId: callId, isError, content: resultContent } },
      },
    ],
  };
}

function childSnapshot({ childId = 'child-a', parentId = 'parent-a', origin = 'subagent', routes = [{ ...WORKER_ROUTE }], inherited = 0 } = {}) {
  return {
    session: { id: childId, origin, parentSession: parentId },
    inheritedEventCount: inherited,
    events: routes.map((route, index) => ({
      type: 'request/header',
      seq: index,
      data: { header: { config: { ...route } }, reason: 'initial' },
    })),
  };
}

function resumeBoundary(cutSeq = 10) {
  return { source: 'resume', cutSeq, inheritedEventCount: 0 };
}

test('gate denies an unconfigured worker route before the child exists', async () => {
  const world = makeScopeWorld();
  const runtime = makeRuntime();
  const gate = makeGate(world, runtime, { route: null });
  const agent = makeAgent(world, { id: 'parent-a' });
  gate.ctx.emit('agent/created', { agent, source: 'startup' });
  const decision = await dispatch(runtime, gate.ctx, { name: 'subagent', callId: 'call-a', agent });
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /WORKER_ROUTE_UNCONFIGURED/);
  assert.equal(runtime.state.children, 0);
  assert.equal(runtime.state.approvals.length, 0);
});

test('gate denies a subagent call without a calling agent', async () => {
  const world = makeScopeWorld();
  const runtime = makeRuntime();
  const gate = makeGate(world, runtime);
  const decision = await dispatch(runtime, gate.ctx, { name: 'subagent', callId: 'call-a' });
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /WORKER_ROUTE_UNCONFIGURED/);
  assert.equal(runtime.state.children, 0);
});

test('gate allows a fresh session after the configured route resolves', async () => {
  const world = makeScopeWorld();
  const runtime = makeRuntime();
  const gate = makeGate(world, runtime);
  const agent = makeAgent(world, { id: 'parent-a' });
  gate.ctx.emit('agent/created', { agent, source: 'startup' });
  const decision = await dispatch(runtime, gate.ctx, { name: 'subagent', callId: 'call-a', agent });
  assert.deepEqual(decision, { kind: 'allow' });
  assert.equal(runtime.state.children, 1);
  assert.equal(runtime.state.approvals.length, 0);
  assert.deepEqual(runtime.state.requests.map(({ provider, model, reasoningEffort }) => ({ provider, model, reasoningEffort })), [
    { provider: 'worker-provider', model: 'worker-model', reasoningEffort: 'medium' },
  ]);
});

test('gate leaves subagent_fork, ordinary tools and foreign revisions untouched', async () => {
  const world = makeScopeWorld();
  const runtime = makeRuntime();
  const gate = makeGate(world, runtime, { route: null });
  const agent = makeAgent(world, { id: 'parent-a' });
  const foreign = makeAgent(world, { id: 'foreign-a', root: world.otherRoot });
  gate.ctx.emit('agent/created', { agent, source: 'startup' });
  assert.deepEqual(await dispatch(runtime, gate.ctx, { name: 'subagent_fork', callId: 'fork-a', agent }), { kind: 'allow' });
  assert.deepEqual(await dispatch(runtime, gate.ctx, { name: 'run_code', callId: 'code-a', agent }), { kind: 'allow' });
  assert.deepEqual(await dispatch(runtime, gate.ctx, { name: 'subagent', callId: 'foreign-call', agent: foreign }), { kind: 'allow' });
  assert.equal(runtime.state.forks, 1);
  assert.equal(runtime.state.children, 1);
});

for (const [name, failure] of [
  ['an unregistered provider adapter', Object.assign(new Error('no adapter registered'), { code: 'NO_ADAPTER' })],
  ['an unsupported explicit effort', Object.assign(new Error('unsupported effort'), { code: 'UNSUPPORTED_REASONING_EFFORT' })],
  ['an unreadable llm service', Object.assign(new Error('llm unavailable'), { code: 'LLM_UNAVAILABLE' })],
]) {
  test(`gate fails closed on ${name} before the child exists`, async () => {
    const world = makeScopeWorld();
    const runtime = makeRuntime({ resolveFailure: failure });
    const gate = makeGate(world, runtime);
    const agent = makeAgent(world, { id: 'parent-a' });
    gate.ctx.emit('agent/created', { agent, source: 'startup' });
    const decision = await dispatch(runtime, gate.ctx, { name: 'subagent', callId: 'call-a', agent });
    assert.equal(decision.kind, 'deny');
    assert.match(decision.reason, /WORKER_ROUTE_UNCONFIGURED/);
    assert.equal(runtime.state.children, 0);
  });
}

test('gate refuses PTC inner subagent dispatch under the same unconfigured route', async () => {
  const world = makeScopeWorld();
  const runtime = makeRuntime();
  const gate = makeGate(world, runtime, { route: null });
  const agent = makeAgent(world, { id: 'parent-a' });
  gate.ctx.emit('agent/created', { agent, source: 'startup' });
  const decision = await dispatch(runtime, gate.ctx, { name: 'subagent', callId: 'sub-1', rootCallId: 'outer-1', agent });
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /WORKER_ROUTE_UNCONFIGURED/);
  assert.equal(runtime.state.children, 0);
});

test('gate allows a restored session without asking when the persisted route matches', async () => {
  const world = makeScopeWorld();
  const runtime = makeRuntime({ sessions: new Map([['parent-a', activationSnapshot()], ['child-a', childSnapshot()]]) });
  const gate = makeGate(world, runtime);
  const agent = makeAgent(world, { id: 'parent-a', firstLiveSeq: 10 });
  gate.ctx.emit('agent/created', { agent, source: 'resume' });
  const decision = await dispatch(runtime, gate.ctx, { name: 'subagent', callId: 'call-b', agent });
  assert.deepEqual(decision, { kind: 'allow' });
  assert.equal(runtime.state.children, 1);
  assert.equal(runtime.state.approvals.length, 0);
});

test('a persisted route that differs from the configured one no longer demands a confirmation', async () => {
  const world = makeScopeWorld();
  const runtime = makeRuntime({ sessions: new Map([
    ['parent-a', activationSnapshot()],
    ['child-a', childSnapshot({ routes: [{ ...OTHER_ROUTE }] })],
  ]) });
  const gate = makeGate(world, runtime);
  const agent = makeAgent(world, { id: 'parent-a', firstLiveSeq: 10 });
  gate.ctx.emit('agent/created', { agent, source: 'resume' });
  const decision = await dispatch(runtime, gate.ctx, { name: 'subagent', callId: 'call-b', agent });
  assert.deepEqual(decision, { kind: 'allow' });
  assert.equal(runtime.state.children, 1);
  // Age is no longer a gate input: the configured route governs the spawn.
  assert.equal(runtime.state.approvals.length, 0);
});

test('a restored session spawns even when the approval outcome would be rejection', async () => {
  const world = makeScopeWorld();
  const runtime = makeRuntime({ outcome: 'rejected', sessions: new Map([['parent-a', { session: { id: 'parent-a' }, inheritedEventCount: 0, events: [] }]]) });
  const gate = makeGate(world, runtime);
  const agent = makeAgent(world, { id: 'parent-a', firstLiveSeq: 10 });
  gate.ctx.emit('agent/created', { agent, source: 'resume' });
  const decision = await dispatch(runtime, gate.ctx, { name: 'subagent', callId: 'call-b', agent });
  assert.deepEqual(decision, { kind: 'allow' });
  assert.equal(runtime.state.children, 1);
  assert.equal(runtime.state.approvals.length, 0);
});

test('a restored spawn does not need an approval service at all', async () => {
  const world = makeScopeWorld();
  const runtime = makeRuntime({ sessions: new Map([['parent-a', { session: { id: 'parent-a' }, inheritedEventCount: 0, events: [] }]]) });
  const gate = makeGate(world, runtime, { ports: { approval: undefined } });
  const agent = makeAgent(world, { id: 'parent-a' });
  gate.ctx.emit('agent/created', { agent, source: 'resume' });
  const decision = await dispatch(runtime, gate.ctx, { name: 'subagent', callId: 'call-b', agent });
  assert.deepEqual(decision, { kind: 'allow' });
  assert.equal(runtime.state.children, 1);
});

test('a restored spawn works under a never approval policy', async () => {
  // The reported bug: this exact combination was a hard deny, so the PTC preset
  // produced no workers in any session opened before a restart.
  const world = makeScopeWorld();
  const runtime = makeRuntime({ policy: 'never', sessions: new Map([['parent-a', { session: { id: 'parent-a' }, inheritedEventCount: 0, events: [] }]]) });
  const gate = makeGate(world, runtime);
  const agent = makeAgent(world, { id: 'parent-a', firstLiveSeq: 10 });
  gate.ctx.emit('agent/created', { agent, source: 'resume' });
  const decision = await dispatch(runtime, gate.ctx, { name: 'subagent', callId: 'call-b', agent });
  assert.deepEqual(decision, { kind: 'allow' });
  assert.equal(runtime.state.children, 1);
  assert.equal(runtime.state.approvals.length, 0);
});

test('distinct calls from one restored session are each allowed', async () => {
  const world = makeScopeWorld();
  const runtime = makeRuntime({ sessions: new Map([['parent-a', { session: { id: 'parent-a' }, inheritedEventCount: 0, events: [] }]]) });
  const gate = makeGate(world, runtime);
  const agent = makeAgent(world, { id: 'parent-a', firstLiveSeq: 10 });
  gate.ctx.emit('agent/created', { agent, source: 'resume' });
  const decisions = await Promise.all([
    dispatch(runtime, gate.ctx, { name: 'subagent', callId: 'call-1', agent }),
    dispatch(runtime, gate.ctx, { name: 'subagent', callId: 'call-2', agent }),
  ]);
  assert.deepEqual(decisions, [{ kind: 'allow' }, { kind: 'allow' }]);
  assert.equal(runtime.state.children, 2);
  assert.equal(runtime.state.approvals.length, 0);
});

test('a repeated identical call is allowed twice without a confirmation registry', async () => {
  const world = makeScopeWorld();
  const runtime = makeRuntime({ sessions: new Map([['parent-a', { session: { id: 'parent-a' }, inheritedEventCount: 0, events: [] }]]) });
  const gate = makeGate(world, runtime);
  const agent = makeAgent(world, { id: 'parent-a', firstLiveSeq: 10 });
  gate.ctx.emit('agent/created', { agent, source: 'resume' });
  const first = await dispatch(runtime, gate.ctx, { name: 'subagent', callId: 'call-1', agent });
  const second = await dispatch(runtime, gate.ctx, { name: 'subagent', callId: 'call-1', agent });
  assert.deepEqual(first, { kind: 'allow' });
  assert.deepEqual(second, { kind: 'allow' });
  assert.equal(runtime.state.children, 2);
  assert.equal(runtime.state.approvals.length, 0);
});

test('gate records both lifecycle boundaries and resolves no route during initialization', async () => {
  const world = makeScopeWorld();
  const runtime = makeRuntime();
  const gate = makeGate(world, runtime);
  gate.ctx.emit('agent/created', { agent: makeAgent(world, { id: 'parent-a' }), source: 'resume' });
  gate.ctx.emit('agent/created', { agent: makeAgent(world, { id: 'parent-b' }), source: 'startup' });
  assert.equal(runtime.state.approvals.length, 0);
  assert.equal(runtime.state.requests.length, 0);
  assert.deepEqual([...gate.dispose.diagnostics().boundaries].sort(), ['parent-a', 'parent-b']);
});

test('an owned agent with no readable session is still allowed, not denied', async () => {
  const world = makeScopeWorld();
  const runtime = makeRuntime();
  const agent = makeAgent(world, { id: 'parent-a' });
  agent.session = null;
  const gate = makeGate(world, runtime);
  const decision = await dispatch(runtime, gate.ctx, { name: 'subagent', callId: 'call-a', agent });
  assert.deepEqual(decision, { kind: 'allow' });
  assert.equal(runtime.state.children, 1);
});

test('a session created in this process is a startup boundary without any lifecycle event', async () => {
  const world = makeScopeWorld();
  const runtime = makeRuntime();
  const agent = makeAgent(world, { id: 'parent-a' });
  agent.session.createdAt = Date.now();
  const gate = makeGate(world, runtime);
  const decision = await dispatch(runtime, gate.ctx, { name: 'subagent', callId: 'call-a', agent });
  assert.deepEqual(decision, { kind: 'allow' });
});

test('a session older than this process is not a dead end: it goes to the approval path', async () => {
  // Regression: a session resumed across a restart has no in-process lifecycle
  // event, so the gate used to deny it outright and the preset produced no
  // workers at all. It must fall back to the one-time confirmation instead.
  const world = makeScopeWorld();
  const runtime = makeRuntime();
  const agent = makeAgent(world, { id: 'parent-a' });
  agent.session.createdAt = Date.now() - 3_600_000;
  const gate = makeGate(world, runtime);
  const decision = await dispatch(runtime, gate.ctx, { name: 'subagent', callId: 'call-a', agent });
  assert.doesNotMatch(String(decision.reason ?? ''), /no lifecycle boundary was recorded/);
});

test('install on a live agent allows a spawn whose persisted route differs', async () => {
  const world = makeScopeWorld();
  const runtime = makeRuntime({ sessions: new Map([
    ['parent-a', activationSnapshot()],
    ['child-a', childSnapshot({ routes: [{ ...OTHER_ROUTE }] })],
  ]) });
  const agent = makeAgent(world, { id: 'parent-a', firstLiveSeq: 10, scoped: true });
  const dispose = makeAgentGate(world, runtime, agent);
  assert.deepEqual(dispose.diagnostics().boundaries, ['parent-a']);
  const decision = await dispatch(runtime, agent.ctx, { name: 'subagent', callId: 'call-b', agent });
  assert.deepEqual(decision, { kind: 'allow' });
  assert.equal(runtime.state.approvals.length, 0);
  assert.equal(runtime.state.children, 1);
});

test('install on a live agent allows the spawn without reading recovery evidence', async () => {
  const world = makeScopeWorld();
  const runtime = makeRuntime({ sessions: new Map([
    ['parent-a', activationSnapshot()],
    ['child-a', childSnapshot()],
  ]) });
  const agent = makeAgent(world, { id: 'parent-a', firstLiveSeq: 10, scoped: true });
  makeAgentGate(world, runtime, agent);
  const decision = await dispatch(runtime, agent.ctx, { name: 'subagent', callId: 'call-b', agent });
  assert.deepEqual(decision, { kind: 'allow' });
  assert.equal(runtime.state.approvals.length, 0);
  assert.equal(runtime.state.reads, 0);
  assert.equal(runtime.state.children, 1);
});

test('gate cancels before creating a child when the caller signal is aborted', async () => {
  const world = makeScopeWorld();
  const runtime = makeRuntime();
  const gate = makeGate(world, runtime);
  const agent = makeAgent(world, { id: 'parent-a' });
  gate.ctx.emit('agent/created', { agent, source: 'startup' });
  const controller = new AbortController();
  controller.abort();
  const decision = await dispatch(runtime, gate.ctx, { name: 'subagent', callId: 'call-a', agent, signal: controller.signal });
  assert.deepEqual(decision, { kind: 'cancel' });
  assert.equal(runtime.state.children, 0);
  assert.equal(runtime.state.requests.length, 0);
});

test('gate denies a pending spawn when it is disposed before the child exists', async () => {
  const world = makeScopeWorld();
  const runtime = makeRuntime({ sessions: new Map([['parent-a', activationSnapshot()], ['child-a', childSnapshot()]]) });
  const gate = makeGate(world, runtime);
  const agent = makeAgent(world, { id: 'parent-a', firstLiveSeq: 10 });
  gate.ctx.emit('agent/created', { agent, source: 'resume' });
  let release;
  const deferred = new Promise((resolvePromise) => { release = resolvePromise; });
  const original = runtime.llm.resolveCallConfig;
  runtime.llm.resolveCallConfig = async (request, signal) => { await deferred; return original.call(runtime.llm, request, signal); };
  const pending = dispatch(runtime, gate.ctx, { name: 'subagent', callId: 'call-b', agent });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  gate.dispose();
  release();
  const decision = await pending;
  assert.equal(decision.kind, 'deny');
  assert.equal(runtime.state.children, 0);
});

test('gate disposer removes the guard and pre-execute registrations', async () => {
  const world = makeScopeWorld();
  const runtime = makeRuntime();
  const gate = makeGate(world, runtime, { route: null });
  const agent = makeAgent(world, { id: 'parent-a' });
  gate.ctx.emit('agent/created', { agent, source: 'startup' });
  gate.dispose();
  const decision = await dispatch(runtime, gate.ctx, { name: 'subagent', callId: 'call-a', agent });
  assert.deepEqual(decision, { kind: 'allow' });
  assert.equal(runtime.state.children, 1);
});

async function evidenceFor(runtime, agent, boundary) {
  return readWorkerRouteEvidence(agent, boundary, undefined, {
    sessionQuery: runtime.sessionQuery,
    foldRequestHeader: runtime.foldRequestHeader,
  });
}

test('evidence confirms the first child route when every later request keeps it', async () => {
  const world = makeScopeWorld();
  const runtime = makeRuntime({ sessions: new Map([
    ['parent-a', activationSnapshot()],
    ['child-a', childSnapshot({ routes: [{ ...WORKER_ROUTE }, { ...WORKER_ROUTE }, { ...WORKER_ROUTE }] })],
  ]) });
  const agent = makeAgent(world, { id: 'parent-a' });
  const evidence = await evidenceFor(runtime, agent, resumeBoundary());
  assert.equal(evidence.status, 'confirmed');
  assert.deepEqual(evidence.actual, { ...WORKER_ROUTE });
  assert.equal(evidence.childSessionId, 'child-a');
});

test('evidence refuses a child whose later request changed the route', async () => {
  const world = makeScopeWorld();
  const runtime = makeRuntime({ sessions: new Map([
    ['parent-a', activationSnapshot()],
    ['child-a', childSnapshot({ routes: [{ ...WORKER_ROUTE }, { ...OTHER_ROUTE }] })],
  ]) });
  const agent = makeAgent(world, { id: 'parent-a' });
  const evidence = await evidenceFor(runtime, agent, resumeBoundary());
  assert.equal(evidence.status, 'unconfirmed');
  assert.equal(evidence.reason, 'child-route-conflicting');
  assert.equal(evidence.actual, null);
});

test('evidence refuses a child with no model request', async () => {
  const world = makeScopeWorld();
  const runtime = makeRuntime({ sessions: new Map([
    ['parent-a', activationSnapshot()],
    ['child-a', childSnapshot({ routes: [] })],
  ]) });
  const agent = makeAgent(world, { id: 'parent-a' });
  const evidence = await evidenceFor(runtime, agent, resumeBoundary());
  assert.equal(evidence.status, 'unconfirmed');
  assert.equal(evidence.reason, 'child-route-missing');
});

test('evidence refuses a child header that is not a subagent of this parent', async () => {
  const world = makeScopeWorld();
  const runtime = makeRuntime({ sessions: new Map([
    ['parent-a', activationSnapshot()],
    ['child-a', childSnapshot({ origin: 'fork' })],
  ]) });
  const agent = makeAgent(world, { id: 'parent-a' });
  assert.equal((await evidenceFor(runtime, agent, resumeBoundary())).reason, 'child-header-mismatch');
  runtime.sessionQuery = {
    async readSession(id) {
      if (id === 'parent-a') return structuredClone(activationSnapshot());
      return structuredClone(childSnapshot({ parentId: 'other-parent' }));
    },
  };
  assert.equal((await evidenceFor(runtime, agent, resumeBoundary())).reason, 'child-header-mismatch');
});

test('evidence refuses a missing, oversized or misbound receipt instead of trusting declared', async () => {
  const world = makeScopeWorld();
  const agent = makeAgent(world, { id: 'parent-a' });
  const noReceipt = makeRuntime({ sessions: new Map([
    ['parent-a', activationSnapshot({ content: [{ type: 'text', text: 'started subagent child-a' }] })],
    ['child-a', childSnapshot()],
  ]) });
  const missing = await evidenceFor(noReceipt, agent, resumeBoundary());
  assert.equal(missing.status, 'unconfirmed');
  assert.equal(missing.reason, 'receipt-missing');
  assert.equal(missing.actual, null);

  const oversizedValue = receiptFor();
  oversizedValue.declared.model = '界'.repeat(16_384);
  const oversized = makeRuntime({ sessions: new Map([
    ['parent-a', activationSnapshot({ receiptValue: oversizedValue })],
    ['child-a', childSnapshot()],
  ]) });
  assert.equal((await evidenceFor(oversized, agent, resumeBoundary())).reason, 'receipt-unreadable');

  const misbound = makeRuntime({ sessions: new Map([
    ['parent-a', activationSnapshot({ receiptValue: receiptFor({ parentId: 'other-parent' }) })],
    ['child-a', childSnapshot()],
  ]) });
  assert.equal((await evidenceFor(misbound, agent, resumeBoundary())).reason, 'receipt-mismatch');
});

test('evidence ignores requests inherited from a fork prefix', async () => {
  const world = makeScopeWorld();
  const runtime = makeRuntime({ sessions: new Map([
    ['parent-a', activationSnapshot()],
    ['child-a', childSnapshot({ routes: [{ ...WORKER_ROUTE }], inherited: 1 })],
  ]) });
  const agent = makeAgent(world, { id: 'parent-a' });
  const evidence = await evidenceFor(runtime, agent, resumeBoundary());
  assert.equal(evidence.status, 'unconfirmed');
  assert.equal(evidence.reason, 'child-route-missing');
});

test('evidence reports unreadable reads and invalid boundaries without falling back', async () => {
  const world = makeScopeWorld();
  const agent = makeAgent(world, { id: 'parent-a' });
  const unreadable = makeRuntime({ sessions: new Map([['parent-a', Object.assign(new Error('denied'), { code: 'EACCES' })]]) });
  assert.equal((await evidenceFor(unreadable, agent, resumeBoundary())).reason, 'parent-unreadable');
  const empty = makeRuntime({ sessions: new Map([['parent-a', { session: { id: 'parent-a' }, inheritedEventCount: 0, events: [] }]]) });
  assert.equal((await evidenceFor(empty, agent, resumeBoundary())).reason, 'no-prior-record');
  assert.equal((await evidenceFor(empty, agent, { source: 'unknown', cutSeq: 10 })).reason, 'invalid-boundary');
});

test('receipt writer preserves the activation value and appends one canonical declaration', async () => {
  const world = makeScopeWorld();
  const runtime = makeRuntime();
  const stock = { name: 'subagent' };
  const gate = makeGate(world, runtime, { stockDefinition: stock });
  const agent = makeAgent(world, { id: 'parent-a' });
  const result = {
    value: { kind: 'activation', subagentId: 'child-a' },
    content: [{ type: 'text', text: 'started subagent child-a' }],
    isError: false,
    meta: { keep: true },
  };
  const decision = await runPostExecute(gate.ctx, { name: 'subagent', callId: 'call-a', rootCallId: 'call-a', agent }, result);
  assert.equal(decision.kind, 'accept');
  assert.equal(decision.value, undefined);
  assert.equal(decision.content.length, 2);
  const receiptValue = parseWorkerRouteReceiptText(decision.content[1].text);
  assert.equal(receiptValue.callId, 'call-a');
  assert.equal(receiptValue.rootCallId, 'call-a');
  assert.equal(receiptValue.childSessionId, 'child-a');
  assert.deepEqual(receiptValue.declared, { source: 'bound-stock-agent-options', ...WORKER_ROUTE });
  assert.equal(result.content.length, 1);
  assert.deepEqual(result.value, { kind: 'activation', subagentId: 'child-a' });
});

test('receipt writer leaves non-stock, failed and foreign activations untouched', async () => {
  const world = makeScopeWorld();
  const runtime = makeRuntime();
  const stock = { name: 'subagent' };
  const gate = makeGate(world, runtime, { stockDefinition: stock });
  const agent = makeAgent(world, { id: 'parent-a' });
  const foreign = makeAgent(world, { id: 'foreign-a', root: world.otherRoot });
  const exec = { name: 'subagent', callId: 'call-a', agent };
  const failed = await runPostExecute(gate.ctx, exec, { value: { kind: 'activation', subagentId: 'child-a' }, content: [], isError: true });
  assert.equal(failed.content, undefined);
  const foreignDecision = await runPostExecute(gate.ctx, { name: 'subagent', callId: 'call-a', agent: foreign }, {
    value: { kind: 'activation', subagentId: 'child-a' }, content: [], isError: false,
  });
  assert.equal(foreignDecision.content, undefined);
  gate.definitions.set('subagent', { name: 'replacement' });
  const replaced = await runPostExecute(gate.ctx, exec, { value: { kind: 'activation', subagentId: 'child-a' }, content: [], isError: false });
  assert.equal(replaced.content, undefined);
});

test('receipt writer resolves the stock definition with a ScopeKey, never the Agent object', async () => {
  const world = makeScopeWorld();
  const runtime = makeRuntime();
  const stock = { name: 'subagent' };
  const gate = makeGate(world, runtime, { stockDefinition: stock });
  const agent = makeAgent(world, { id: 'parent-a' });
  const decision = await runPostExecute(gate.ctx, { name: 'subagent', callId: 'call-a', agent }, {
    value: { kind: 'activation', subagentId: 'child-a' }, content: [], isError: false,
  });
  assert.deepEqual(gate.ctx.tools.getCalls.map((call) => call.name), ['subagent']);
  for (const call of gate.ctx.tools.getCalls) {
    assert.notEqual(call.scope, agent, 'the Agent object is not a ScopeKey and must never be passed as one');
    assert.equal(world.isKey(call.scope), true, 'tools.get must receive a registered ScopeKey');
  }
  assert.equal(gate.ctx.tools.getCalls[0].scope, world.scopeOf(agent.ctx));
  assert.equal(decision.content.length, 1);
});

test('receipt writer finds a stock row that exists only in the gate generation layer', async () => {
  const world = makeScopeWorld();
  const runtime = makeRuntime();
  // No stock port and no global row: the shipped preset registers `subagent` inside the
  // generation, and `apply()` has no way to carry that identity as a port.
  const gate = makeGate(world, runtime);
  gate.definitions.set('subagent', { name: 'subagent' });
  const agent = makeAgent(world, { id: 'parent-a' });
  const decision = await runPostExecute(gate.ctx, { name: 'subagent', callId: 'call-a', agent }, {
    value: { kind: 'activation', subagentId: 'child-a' }, content: [], isError: false,
  });
  assert.equal(Array.isArray(decision.content), true, 'the generation-scoped stock row must still receive a receipt');
  assert.equal(decision.content.length, 1);
  assert.equal(parseWorkerRouteReceiptText(decision.content[0].text).childSessionId, 'child-a');
  assert.equal(gate.dispose.diagnostics().receipts, 1);
  assert.equal(gate.dispose.diagnostics().stockSource, 'generation');
});

test('receipt writer records a missing stock identity instead of skipping silently', async () => {
  const world = makeScopeWorld();
  const runtime = makeRuntime();
  const gate = makeGate(world, runtime);
  const agent = makeAgent(world, { id: 'parent-a' });
  const decision = await runPostExecute(gate.ctx, { name: 'subagent', callId: 'call-a', agent }, {
    value: { kind: 'activation', subagentId: 'child-a' }, content: [], isError: false,
  });
  assert.equal(decision.content, undefined);
  assert.equal(gate.dispose.diagnostics().receipts, 0);
  assert.deepEqual(gate.dispose.diagnostics().unknownReceipts, [{ callId: 'call-a', reason: 'generation-stock-missing' }]);
});

test('gate fails closed when scope introspection throws for an owned agent', async () => {
  const world = makeScopeWorld();
  const runtime = makeRuntime();
  let chainCalls = 0;
  const gate = makeGate(world, runtime, {
    ports: {
      scopeChainOf: (key) => {
        chainCalls += 1;
        if (chainCalls > 1) throw new Error('scope introspection failed');
        return world.chainOf(key);
      },
    },
  });
  const agent = makeAgent(world, { id: 'parent-a' });
  gate.ctx.emit('agent/created', { agent, source: 'startup' });
  const decision = await dispatch(runtime, gate.ctx, { name: 'subagent', callId: 'call-a', agent });
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /WORKER_ROUTE_RECOVERY_UNCONFIRMED/);
  assert.match(decision.reason, /could not verify/);
  assert.equal(runtime.state.children, 0);
});

test('a call without an identity is allowed: nothing is bound to a grant any more', async () => {
  const world = makeScopeWorld();
  const runtime = makeRuntime({ sessions: new Map([['parent-a', { session: { id: 'parent-a' }, inheritedEventCount: 0, events: [] }]]) });
  const gate = makeGate(world, runtime);
  const agent = makeAgent(world, { id: 'parent-a', firstLiveSeq: 10 });
  gate.ctx.emit('agent/created', { agent, source: 'resume' });
  const decision = await dispatch(runtime, gate.ctx, { name: 'subagent', agent });
  assert.deepEqual(decision, { kind: 'allow' });
  assert.equal(runtime.state.children, 1);
  assert.equal(runtime.state.approvals.length, 0);
});

test('installation rejects a worker route that cannot be encoded into a receipt', () => {
  const world = makeScopeWorld();
  const runtime = makeRuntime();
  assert.throws(
    () => makeGate(world, runtime, { route: { ...WORKER_ROUTE, reasoningEffort: 'x'.repeat(65) } }),
    /cannot be encoded as a canonical receipt/,
  );
  assert.throws(
    () => makeGate(world, runtime, { route: { provider: 'worker-provider', model: 'm'.repeat(1025) } }),
    /cannot be encoded as a canonical receipt/,
  );
});

// The gate's Host port entry is production code the preset row resolves; it imports two
// runtime packages directly, so they must be declared peers of this package.
test('the gate-port entry is exported and declares its runtime imports as peers', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.exports['./delegation-gate-ports'], './lib/host/delegation-gate-ports.js');
  for (const name of ['@deepseek-ai/dsh-scope', '@deepseek-ai/dsh-session']) {
    assert.ok(Object.hasOwn(manifest.peerDependencies ?? {}, name), `${name} must be a declared peer dependency`);
  }
});

test('module exposes the gate plugin identity and port configuration hook', () => {
  assert.equal(typeof installWorkerGate, 'function');
  assert.equal(typeof readWorkerRouteEvidence, 'function');
  assert.equal(typeof configureWorkerGatePorts, 'function');
  assert.equal(configureWorkerGatePorts(null), undefined);
});

// RED before the fix: a Cordis context proxy throws `cannot get property "ctx" without
// inject` for an undeclared property, and the mounted preset row died on it (real rc.5
// reported `delegation-gate (...): cannot get property "ctx" without inject`, so the whole
// preset stayed broken and never appeared). Reading a handler's context must be guarded.
test('mounting the gate never reads the guarded ctx property of a context', () => {
  const tools = { guard: () => () => {} };
  const context = {
    get(name) { return name === 'tools' ? tools : undefined; },
    on() { return () => {}; },
  };
  Object.defineProperty(context, 'ctx', {
    get() { throw new Error('cannot get property "ctx" without inject'); },
  });
  const ports = {
    scopeOf: () => ({ key: 'scope' }),
    scopeChainOf: () => [],
    foldRequestHeader: () => undefined,
    tools,
    approval: { request: async () => 'denied' },
    llm: {},
    sessionQuery: {},
  };
  const dispose = installWorkerGate(context, null, ports);
  assert.equal(typeof dispose, 'function');
  dispose();
});
