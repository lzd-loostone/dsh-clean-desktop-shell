import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bindActivationContentReceipt, bindActivationReceipt, bindApprovalGate, bindOwningVolatileReread, bindScopedGuard,
  CLIENT_GATE_BUNDLES, CLIENT_STORE_SOURCE_SHA, createClientSettingsSurface,
  applyContractEnvironment, createConfigurationOwners, createContractFixture, createNodeRemoteFixture, driveTool,
  presentAgentAsPtc,
  markPublicRemoteMethods, parseRemoteId, proveActivationContentReceipt, readActivationContentReceipt,
  RECEIPT_LIMITS, RECEIPT_PREFIX, RECEIPT_SCHEMA, strictRemoteDescriptor,
  CONTRACT_RUNTIME_VERSION, FIXTURE_MODEL, FIXTURE_PROVIDER, mutationTool,
  schedulePostLoadHealth, textStream,
} from './delegation-contract-fixture.js';

// The fixture refuses guessed paths, so resolve and export the pinned runtime, the confined
// scratch root (TEMP/TMP/TMPDIR/NPM_CONFIG_CACHE/DSH_HOME) and the client-gate inputs here.
// An explicit DSH_CONTRACT_* variable still wins, which keeps CI and the runner in control.
const contractEnvironment = applyContractEnvironment();

const fixtureOptions = {
  runtimeRoot: contractEnvironment.runtimeRoot,
  scratchRoot: contractEnvironment.scratchRoot,
};
const defaultRoute = { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL, reasoningEffort: 'medium' };
const protectedName = 'contract_protected_action';

async function fixtureFor(t) {
  const fixture = await createContractFixture(fixtureOptions);
  t.after(() => fixture.dispose());
  return fixture;
}

async function persistedSnapshot(fixture, agent) {
  await fixture.retireAgent(agent);
  const observation = await fixture.ctx.sessionQuery.observeSession(agent.id);
  try {
    assert.equal(observation.source, 'prepared', 'proof must come from persisted preparation, not a live store alias');
    return await fixture.ctx.sessionQuery.readSession(agent.id);
  } finally {
    observation[Symbol.dispose]();
  }
}

function resultFor(snapshot, callId) {
  const events = snapshot.events.filter((event) => event.type === 'tool/result' && event.data.message.toolCallId === callId);
  assert.equal(events.length, 1, `the real loop must commit exactly one result for ${callId}`);
  return events[0];
}

async function confirmedWithin(promise, label) {
  let timeout;
  try {
    return await Promise.race([promise, new Promise((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`${label}: observation did not arrive`)), 2000);
    })]);
  } finally {
    clearTimeout(timeout);
  }
}

const ptcArguments = {
  description: 'Execute the isolated fixture action through the real generated SDK',
  code: 'return await tools.contract_protected_action({});',
};

test('prerequisite: actual pinned registry, loop, PTC and JSONL persistence initialize in isolated scratch', async (t) => {
  const fixture = await fixtureFor(t);
  assert.equal(fixture.runtime.version, CONTRACT_RUNTIME_VERSION);
  for (const name of ['tools', 'agents', 'sessionQuery', 'approval', 'ptcRuntime', 'subagents']) {
    assert.ok(fixture.ctx.get(name), `${name} must be a real initialized pinned service`);
  }
  assert.equal(fixture.ctx.ptcRuntime.language, 'typescript');
  assert.equal(fixture.ctx.ptcRuntime.isolation, 'process');
  assert.deepEqual(fixture.ctx.llm.listProviders().map((provider) => provider.id), [FIXTURE_PROVIDER]);
  const agent = await fixture.createAgent('contract-fixture-load');
  const snapshot = await fixture.ctx.sessionQuery.readSession(agent.id);
  assert.equal(snapshot.session.id, 'contract-fixture-load');
  assert.equal(snapshot.session.cwd, fixture.workdir);
  assert.deepEqual(fixture.requests, [], 'fixture initialization must make no model request');
});

test('prerequisite: real Include exposes its unique raw settings namespace', async (t) => {
  const fixture = await fixtureFor(t);
  const { owners } = await createConfigurationOwners(fixture, [{ id: 'contract-settings', route: defaultRoute }]);
  const owner = owners.get('contract-settings');
  assert.equal(owner.entry.options.id, 'contract-settings');
  assert.equal(owner.entry.id, 'include:contract-settings');
  const descriptor = fixture.ctx.settings.describe({ redactSecrets: true }).find((row) => row.ns === owner.entry.options.id);
  assert.ok(descriptor);
  assert.deepEqual(descriptor.value.route, defaultRoute);
  assert.ok(!fixture.ctx.settings.describe().some((row) => row.ns === owner.entry.id));
});

for (const mode of ['native', 'ptc']) {
  test(`prerequisite: deterministic real ${mode} dispatch commits a cold-readable result`, async (t) => {
    const fixture = await fixtureFor(t);
    let mutations = 0;
    fixture.ctx.tools.register(mutationTool(() => { mutations += 1; }));
    const agent = await fixture.createAgent(`contract-prerequisite-${mode}`);
    if (mode === 'ptc') await presentAgentAsPtc(fixture, agent);
    const callId = `prerequisite-${mode}`;
    const snapshot = await driveTool(fixture, agent, callId, mode === 'native' ? protectedName : 'run_code', mode === 'native' ? {} : ptcArguments);
    assert.equal(resultFor(snapshot, callId).data.message.isError === true, false);
    assert.equal(mutations, 1, 'the real body must have executed exactly once');
    if (mode === 'ptc') {
      const dispatch = snapshot.events.find((event) => event.type === 'tool/ptc-dispatch');
      assert.ok(dispatch, 'a real SDK call must commit its own dispatch event');
      assert.equal(dispatch.data.subCallId, 'prerequisite-ptc:ptc:1');
      assert.equal(dispatch.data.rootCallId, callId);
      assert.equal(dispatch.data.isError, false);
    }
    const persisted = await persistedSnapshot(fixture, agent);
    assert.deepEqual(persisted.events, snapshot.events);
    assert.equal(fixture.requests.length, 2, 'only deterministic fixture requests may run');
  });
}

test('volatile reread: owning-fiber notification refreshes the cached route without remount or foreign notification', async (t) => {
  const fixture = await fixtureFor(t);
  const { owners } = await createConfigurationOwners(fixture, [
    { id: 'contract-route-owner', route: defaultRoute },
    { id: 'contract-foreign-owner', route: defaultRoute },
  ]);
  const owner = owners.get('contract-route-owner');
  const foreign = owners.get('contract-foreign-owner');
  const notifications = [];
  const foreignNotifications = [];
  owner.ctx.on('loader/volatile-update', (paths) => notifications.push(paths));
  foreign.ctx.on('loader/volatile-update', (paths) => foreignNotifications.push(paths));
  bindOwningVolatileReread(owner.ctx, owner.reread);
  bindOwningVolatileReread(foreign.ctx, foreign.reread);
  const fiber = owner.entry.fiber;
  const revision = fixture.ctx.settings.describe().find((row) => row.ns === owner.entry.options.id).revision;
  const updatedRoute = { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL, reasoningEffort: 'low' };
  await fixture.ctx.settings.update(owner.entry.options.id, { route: updatedRoute }, revision);
  assert.deepEqual(owner.config.route.get(), updatedRoute, 'prerequisite: actual volatile reference committed');
  assert.deepEqual(owner.cachedRoute, updatedRoute, 'VOLATILE_REREAD_MISSING: owner cache must re-read the committed reference');
  assert.equal(owner.entry.fiber, fiber);
  assert.equal(owner.reads, 1);
  assert.deepEqual(notifications, [[['route']]]);
  assert.deepEqual(foreignNotifications, []);
  assert.equal(foreign.reads, 0);
});

test('post-load health: schedules after the owner activates and never waits for its own or an unrelated Loader row', async (t) => {
  const fixture = await fixtureFor(t);
  const checks = [];
  let nextCheck = Promise.withResolvers();
  const { owners } = await createConfigurationOwners(fixture, [{ id: 'contract-health-owner', route: defaultRoute }], (owner) => {
    schedulePostLoadHealth(owner.ctx, () => {
      checks.push({ id: owner.entry.options.id, state: owner.entry.fiber.state });
      nextCheck.resolve();
    });
  });
  await confirmedWithin(nextCheck.promise, 'owner post-load health');
  assert.deepEqual(checks, [{ id: 'contract-health-owner', state: 2 }], 'POST_LOAD_HEALTH_MISSING: health must run after the owner activates');
  checks.length = 0;
  nextCheck = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  fixture.ctx.loader.builtins['contract-blocker'] = {
    name: 'contract-blocker',
    async apply() { entered.resolve(); await release.promise; },
  };
  const creating = fixture.ctx.loader.create({ name: 'cordis:contract-blocker' });
  await entered.promise;
  try {
    await owners.get('contract-health-owner').entry.fiber.restart();
    await confirmedWithin(nextCheck.promise, 'health while unrelated Loader row is blocked');
    assert.deepEqual(checks, [{ id: 'contract-health-owner', state: 2 }], 'health must not await the whole Loader tree');
  } finally {
    release.resolve();
    await creating;
  }
});

for (const mode of ['native', 'ptc']) {
  test(`guard parity: real ${mode} dispatch is denied before the protected body while other Agent scopes remain usable`, async (t) => {
    const fixture = await fixtureFor(t);
    let mutations = 0;
    fixture.ctx.tools.register(mutationTool(() => { mutations += 1; }));
    const agent = await fixture.createAgent(`contract-guard-${mode}`);
    agent.ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }));
    const guarded = [];
    bindScopedGuard(agent, (exec) => {
      if (exec.name !== protectedName) return undefined;
      guarded.push({ callId: exec.callId, rootCallId: exec.rootCallId, parent: typeof exec.parent, agentId: exec.agent.id });
      return 'contract delegation route blocked';
    });
    if (mode === 'ptc') await presentAgentAsPtc(fixture, agent);
    const callId = `guard-${mode}`;
    const snapshot = await driveTool(fixture, agent, callId, mode === 'native' ? protectedName : 'run_code', mode === 'native' ? {} : ptcArguments);
    assert.equal(resultFor(snapshot, callId).data.message.isError, true, `GUARD_${mode.toUpperCase()}_MISSING: the real call must be denied`);
    assert.equal(mutations, 0);
    assert.deepEqual(guarded, [{
      callId: mode === 'native' ? callId : `${callId}:ptc:1`, rootCallId: callId,
      parent: mode === 'native' ? 'undefined' : 'symbol', agentId: agent.id,
    }]);
    if (mode === 'ptc') {
      const dispatch = snapshot.events.find((event) => event.type === 'tool/ptc-dispatch');
      assert.equal(dispatch.data.isError, true);
      assert.equal(dispatch.data.subCallId, 'guard-ptc:ptc:1');
      assert.match(dispatch.data.content[0].text, /contract delegation route blocked/);
    }
    const foreign = await fixture.createAgent(`contract-unguarded-${mode}`);
    // 0.2.2 replaced the single-call execute({name, callId, arguments, agent}) with a raw call
    // batch (packages/core/tools/src/index.ts `execute(input)` returning {results}).
    const foreignBatch = await foreign.ctx.tools.execute({
      calls: [{ type: 'tool-call', id: `foreign-${mode}`, name: protectedName, arguments: '{}' }],
      agent: foreign, signal: new AbortController().signal,
    });
    const foreignResult = foreignBatch.results[0].result;
    assert.equal(foreignResult.isError, false, 'the adapter must not create a global deny');
    assert.equal(mutations, 1);
    const persisted = await persistedSnapshot(fixture, agent);
    assert.deepEqual(persisted.events, snapshot.events);
  });
}

for (const outcome of ['allowed-once', 'rejected', 'cancelled', 'unavailable']) {
  test(`approval audit: real ${outcome} decision is paired with this tool call and grants only allowed-once`, async (t) => {
    const fixture = await fixtureFor(t);
    let mutations = 0;
    fixture.ctx.tools.register(mutationTool(() => { mutations += 1; }));
    const agent = await fixture.createAgent(`contract-approval-${outcome}`);
    agent.ctx.on('approval/request', async () => outcome);
    bindApprovalGate(agent, protectedName, 'contract route needs one-call approval');
    const callId = `approval-${outcome}`;
    const snapshot = await driveTool(fixture, agent, callId, protectedName, {});
    const asked = snapshot.events.filter((event) => event.type === 'approval/asked');
    const decided = snapshot.events.filter((event) => event.type === 'approval/decided');
    assert.equal(asked.length, 1, 'APPROVAL_AUDIT_MISSING: the real approval channel must commit an asked record');
    assert.equal(decided.length, 1);
    assert.equal(asked[0].data.callId, callId);
    assert.equal(asked[0].data.toolName, protectedName);
    assert.equal(asked[0].data.reason, 'contract route needs one-call approval');
    assert.equal(decided[0].data.id, asked[0].data.id);
    assert.equal(decided[0].data.outcome, outcome);
    assert.equal(mutations, outcome === 'allowed-once' ? 1 : 0);
    assert.equal(resultFor(snapshot, callId).data.message.isError === true, outcome !== 'allowed-once');
    assert.ok(asked[0].seq < decided[0].seq);
    assert.ok(decided[0].seq < resultFor(snapshot, callId).seq);
    const persisted = await persistedSnapshot(fixture, agent);
    assert.deepEqual(persisted.events, snapshot.events);
  });
}

test('approval never: fixture-local standing never is not widened or answered by recovery', async (t) => {
  const fixture = await fixtureFor(t);
  let mutations = 0;
  let prompts = 0;
  fixture.ctx.tools.register(mutationTool(() => { mutations += 1; }));
  const approval = await fixture.runtime.load('@deepseek-ai/dsh-user-approval');
  const agent = await fixture.createAgent('contract-approval-never', (_ctx, unpublished) => {
    approval.setApprovalPolicy(unpublished.session, 'never');
  });
  agent.ctx.on('approval/request', async () => { prompts += 1; return 'allowed-once'; });
  bindApprovalGate(agent, protectedName, 'contract route needs one-call approval');
  const snapshot = await driveTool(fixture, agent, 'approval-never', protectedName, {});
  assert.equal(resultFor(snapshot, 'approval-never').data.message.isError, true, 'APPROVAL_NEVER_MISSING: recovery must honor standing never');
  assert.equal(mutations, 0);
  assert.equal(prompts, 0);
  assert.equal(fixture.ctx.approval.overrideOf(agent.session), 'never');
  assert.ok(snapshot.events.every((event) => event.type !== 'approval/decided' || event.data.outcome === 'rejected'));
});

async function publicNodeProbeFor(t) {
  const fixture = await fixtureFor(t);
  const node = await createNodeRemoteFixture(fixture);
  const calls = [];
  class ProbeService extends node.protocol.TypertRemoteService {
    constructor(ctx) {
      super(ctx, 'contractNodeProbe');
      markPublicRemoteMethods(node.protocol, this, ['echo', 'efforts', 'watch'], 'watch');
    }
    echo(value, signal) {
      const id = parseRemoteId(node.protocol, 'value', value);
      calls.push(id);
      return { value: id, hasSignal: signal instanceof AbortSignal };
    }
    efforts(providerId, modelId, signal) {
      const provider = parseRemoteId(node.protocol, 'providerId', providerId);
      const model = parseRemoteId(node.protocol, 'modelId', modelId);
      calls.push({ providerId: provider, modelId: model });
      return { providerId: provider, modelId: model, hasSignal: signal instanceof AbortSignal };
    }
    watch(signal) {
      return (async function* () { yield { hasSignal: signal instanceof AbortSignal }; })();
    }
  }
  const hostFiber = fixture.ctx.plugin(ProbeService);
  await hostFiber.await();
  const contribution = { package: 'dsh-clean-desktop-shell', descriptors: [
    strictRemoteDescriptor('contractNodeProbe', 'echo', ['value']),
    strictRemoteDescriptor('contractNodeProbe', 'efforts', ['providerId', 'modelId']),
    strictRemoteDescriptor('contractNodeProbe', 'watch', [], true),
  ] };
  const binding = await node.mountClient(contribution);
  return { fixture, node, binding, calls, contribution };
}

test('node binding prerequisite: actual Host Gateway and public Client Connection/Remote mount dispatch unary and stream without browser globals', async (t) => {
  const { fixture, node, binding } = await publicNodeProbeFor(t);
  const signal = new AbortController().signal;
  const result = await binding.ctx.remote.contractNodeProbe.echo('fixture-id', signal);
  assert.deepEqual(result, { ok: true, value: { value: 'fixture-id', hasSignal: true } });
  assert.deepEqual(node.traffic[0], { kind: 'call', endpoint: 'contractNodeProbe/echo', args: { value: 'fixture-id' } });
  assert.ok(!Object.hasOwn(node.traffic[0].args, 'signal'));
  const stream = binding.ctx.remote.contractNodeProbe.watch(signal);
  const iterator = stream[Symbol.asyncIterator]();
  assert.deepEqual(await confirmedWithin(iterator.next(), 'public Node stream'), { done: false, value: { hasSignal: true } });
  assert.equal((await iterator.next()).done, true);
  stream.dispose();
  const captured = binding.ctx.remote.contractNodeProbe.echo;
  await binding.fiber.dispose();
  const withdrawn = await captured('late-fixture-id', signal);
  assert.equal(withdrawn.ok, false, 'public unmount withdraws its captured endpoint');
  assert.equal(node.traffic.filter((item) => item.kind === 'call').length, 1);
  assert.deepEqual(fixture.requests, [], 'Remote fixture discovery performs no model stream');
});

test('node binding owner input: explicit Source-Remote guard refuses invalid named ids before business access', async (t) => {
  const { node, binding, calls } = await publicNodeProbeFor(t);
  const remote = binding.ctx.remote.contractNodeProbe;
  for (const invalid of [17, undefined, null, {}, [], '', '   ']) {
    const result = await remote.echo(invalid);
    assert.equal(result.ok, false, 'CLIENT_STRICT_CODEC_NOT_ENFORCED: approved owner guard must now refuse invalid id');
    assert.equal(result.error.code, 'gateway/bad-request');
    assert.deepEqual(result.error.details, { issues: [{ field: 'value', message: 'expected a non-empty string' }] });
    const invalidProvider = await remote.efforts(invalid, 'valid-model');
    const invalidModel = await remote.efforts('valid-provider', invalid);
    assert.equal(invalidProvider.ok, false);
    assert.equal(invalidModel.ok, false);
    assert.equal(invalidProvider.error.code, 'gateway/bad-request');
    assert.equal(invalidModel.error.code, 'gateway/bad-request');
  }
  assert.deepEqual(calls, [], 'all named inputs must parse before any business/catalog access');
  for (const args of [{}, { value: 'valid', extra: 17 }, { value: 'valid', signal: 'wire-forbidden' }]) {
    const reply = await node.clientCtx.connection.rpc.call('/api', 'contractNodeProbe/echo', { args });
    assert.equal(reply.ok, false);
  }
  assert.deepEqual(calls, []);
  await assert.rejects(async () => {
    const stream = await node.gateway.stream({ namespace: 'contractNodeProbe', method: 'watch', args: { extra: 17 }, peer: node.peer });
    await stream[Symbol.asyncIterator]().next();
  });
  assert.ok(node.traffic.filter((item) => item.endpoint === 'contractNodeProbe/efforts').every((item) => !Object.hasOwn(item.args, 'signal')));
  const valid = await remote.efforts('valid-provider', 'valid-model');
  assert.deepEqual(valid, { ok: true, value: { providerId: 'valid-provider', modelId: 'valid-model', hasSignal: true } });
  assert.deepEqual(calls, [{ providerId: 'valid-provider', modelId: 'valid-model' }]);
  const unchanged = await remote.echo('  valid-id  ');
  assert.equal(unchanged.value.value, '  valid-id  ', 'trim only tests emptiness, it never normalizes an id');
});

async function captureContentActivation(fixture, mode, suffix, callId, boundOptions, deny = false) {
  const stock = await fixture.runtime.load('@deepseek-ai/dsh-tool-subagent');
  const parent = await fixture.createAgent(`contract-content-${mode}-${suffix}`, async (ctx, agent) => {
    const config = {
      provider: 'spawn', toolName: 'subagent', maxDepth: 1,
      // 0.2.2 renamed modelSelectionSettings -> modelSelection (packages/subagent/tool-subagent/src/index.ts Config).
      modelSelection: false, agentOptions: boundOptions,
    };
    const stockFiber = ctx.plugin({ name: 'contract-bound-stock', inject: stock.inject, apply(scope) {
      return stock.apply(scope, config, agent.session);
    } });
    await stockFiber.await();
  });
  const definition = parent.ctx.tools.get('subagent', parent);
  assert.ok(definition && definition.name === 'subagent', 'the actual stock definition must exist before the new receipt behavior');
  const children = [];
  const childCreated = Promise.withResolvers();
  fixture.ctx.on('agent/created', ({ agent }) => {
    if (agent.session.header.parentSession !== parent.id) return;
    children.push(agent);
    fixture.queueStream(agent.id, textStream('isolated content receipt child complete'));
    childCreated.resolve(agent);
  }, { global: true });
  const canonicalResults = [];
  parent.ctx.on('tools/result', (exec, result) => {
    if (exec.name === 'subagent') canonicalResults.push({ exec, result });
  });
  bindActivationContentReceipt(parent, definition, boundOptions, RECEIPT_LIMITS);
  if (deny) parent.ctx.tools.guard((exec) => exec.name === 'subagent' ? 'contract receipt guard blocked' : undefined);
  if (mode === 'ptc') await presentAgentAsPtc(fixture, parent);
  const args = { description: 'Isolated normal-content receipt child', prompt: 'Return the fixture completion text only.' };
  const driving = driveTool(fixture, parent, callId, mode === 'native' ? 'subagent' : 'run_code', mode === 'native' ? args : {
    description: 'Start the real stock child through the actual generated SDK',
    code: `return await tools.subagent(${JSON.stringify(args)});`,
  });
  fixture.queueStream(parent.id, textStream('isolated content child notification received'));
  await driving;
  if (!deny) {
    const child = await confirmedWithin(childCreated.promise, 'stock content receipt child');
    await child.whenIdle();
    await parent.whenIdle();
  }
  const snapshot = await fixture.ctx.sessionQuery.readSession(parent.id);
  const event = mode === 'native' ? resultFor(snapshot, callId)
    : snapshot.events.find((item) => item.type === 'tool/ptc-dispatch' && item.data.name === 'subagent');
  assert.ok(event, 'the actual final native or SDK event must exist');
  return { parent, children, canonicalResults, snapshot, event };
}

for (const mode of ['native', 'ptc']) {
  test(`content receipt ${mode}: final ordinary result preserves stock canonical identity and separately proves child request/header`, async (t) => {
    const fixture = await fixtureFor(t);
    const boundOptions = Object.freeze({ provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL, reasoningEffort: 'low' });
    const callId = `content-${mode}`;
    const run = await captureContentActivation(fixture, mode, 'valid', callId, boundOptions);
    assert.equal(run.children.length, 1);
    assert.equal(run.canonicalResults.length, 1);
    const child = run.children[0];
    const canonical = run.canonicalResults[0];
    assert.equal(canonical.result.isError, false);
    assert.deepEqual(canonical.result.value, { kind: 'activation', subagentId: child.id });
    assert.equal(canonical.result.meta, undefined, 'the new public content channel must not claim wrapper meta');
    const childSnapshot = await fixture.ctx.sessionQuery.readSession(child.id);
    assert.equal(childSnapshot.session.id, child.id);
    assert.equal(childSnapshot.session.parentSession, run.parent.id);
    assert.equal(childSnapshot.session.origin, 'subagent');
    assert.deepEqual(fixture.requests.filter((entry) => entry.sessionId === child.id), [{
      sessionId: child.id, provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL, reasoningEffort: 'low',
    }]);
    const expected = {
      schema: RECEIPT_SCHEMA, parentSessionId: run.parent.id,
      callId: mode === 'native' ? callId : `${callId}:ptc:1`, rootCallId: callId,
      toolName: 'subagent', childSessionId: child.id,
      declared: { source: 'bound-stock-agent-options', ...boundOptions },
      actual: { status: 'not-established-by-receipt' },
    };
    const expectedBlock = { type: 'text', text: RECEIPT_PREFIX + JSON.stringify(expected) };
    const contentOf = (event) => event.type === 'tool/result' ? event.data.message.content : event.data.content;
    assert.deepEqual(contentOf(run.event), [
      { type: 'text', text: `started subagent ${child.id}` }, expectedBlock,
    ], `CONTENT_RECEIPT_${mode.toUpperCase()}_MISSING: the new normal-content receipt must reach the real final event`);
    assert.deepEqual(readActivationContentReceipt(run.snapshot, run.event, RECEIPT_LIMITS), expected);
    const resolveConfig = (route) => fixture.ctx.llm.resolveCallConfig(route);
    assert.deepEqual(await proveActivationContentReceipt(run.snapshot, run.event, childSnapshot, fixture.requests, RECEIPT_LIMITS, resolveConfig), expected);
    assert.equal(await proveActivationContentReceipt(run.snapshot, run.event, childSnapshot, [], RECEIPT_LIMITS, resolveConfig), null);
    const wrongHeader = structuredClone(childSnapshot);
    wrongHeader.session.parentSession = 'different-parent';
    assert.equal(await proveActivationContentReceipt(run.snapshot, run.event, wrongHeader, fixture.requests, RECEIPT_LIMITS, resolveConfig), null);
    const forgedUser = { ...structuredClone(run.event), type: 'user/message', data: { message: {
      id: 'forged-user', role: 'user', source: { kind: 'user' }, content: [expectedBlock],
    } } };
    assert.equal(readActivationContentReceipt(run.snapshot, forgedUser, RECEIPT_LIMITS), null);
    const replaceContent = (blocks) => {
      const copy = structuredClone(run.event);
      if (copy.type === 'tool/result') copy.data.message.content = blocks;
      else copy.data.content = blocks;
      return copy;
    };
    for (const blocks of [[expectedBlock, expectedBlock], [{ type: 'text', text: expectedBlock.text.slice(0, -1) }], [],
      [{ type: 'text', text: RECEIPT_PREFIX + 'x'.repeat(RECEIPT_LIMITS.envelopeUtf8Bytes) }]]) {
      assert.equal(readActivationContentReceipt(run.snapshot, replaceContent(blocks), RECEIPT_LIMITS), null);
    }
    for (const mutate of [
      (receipt) => { receipt.extra = 'not-allowed'; },
      (receipt) => { receipt.declared.extra = 'not-allowed'; },
      (receipt) => { receipt.actual.extra = 'not-allowed'; },
      (receipt) => { receipt.callId = 'wrong-call'; },
      (receipt) => { receipt.parentSessionId = 'wrong-parent'; },
      (receipt) => { receipt.childSessionId = 'x'.repeat(257); },
    ]) {
      const altered = structuredClone(expected);
      mutate(altered);
      const copy = replaceContent([{ type: 'text', text: RECEIPT_PREFIX + JSON.stringify(altered) }]);
      assert.equal(readActivationContentReceipt(run.snapshot, copy, RECEIPT_LIMITS), null);
    }
    const wrongChild = { ...structuredClone(expected), childSessionId: 'wrong-child' };
    assert.equal(await proveActivationContentReceipt(run.snapshot, replaceContent([{ type: 'text', text: RECEIPT_PREFIX + JSON.stringify(wrongChild) }]), childSnapshot, fixture.requests, RECEIPT_LIMITS, resolveConfig), null);
    const wrongEffort = structuredClone(expected);
    delete wrongEffort.declared.reasoningEffort;
    assert.equal(await proveActivationContentReceipt(run.snapshot, replaceContent([{ type: 'text', text: RECEIPT_PREFIX + JSON.stringify(wrongEffort) }]), childSnapshot, fixture.requests, RECEIPT_LIMITS, resolveConfig), null, 'omitted effort resolves model default, never a wildcard for low');
    if (mode === 'ptc') {
      const outer = resultFor(run.snapshot, callId);
      const fakeOuter = structuredClone(outer);
      fakeOuter.data.message.content = [expectedBlock];
      assert.equal(readActivationContentReceipt(run.snapshot, fakeOuter, RECEIPT_LIMITS), null, 'run_code printing a receipt is not an inner stock receipt');
    }
    const denied = await captureContentActivation(fixture, mode, 'denied', `content-${mode}-denied`, boundOptions, true);
    assert.equal(denied.children.length, 0, 'real guard denial must precede stock spawn');
    assert.equal(denied.canonicalResults[0].result.isError, true);
    assert.equal(readActivationContentReceipt(denied.snapshot, denied.event, RECEIPT_LIMITS), null);
    assert.ok(contentOf(denied.event).every((block) => block.type !== 'text' || !block.text.startsWith(RECEIPT_PREFIX)));
    const oversized = await captureContentActivation(fixture, mode, 'oversized', 'x'.repeat(257), boundOptions);
    assert.equal(oversized.children.length, 1, 'transport bounds must not undo an already-started stock child');
    assert.equal(oversized.canonicalResults[0].result.isError, false);
    assert.equal(readActivationContentReceipt(oversized.snapshot, oversized.event, RECEIPT_LIMITS), null);
    assert.ok(contentOf(oversized.event).every((block) => block.type !== 'text' || !block.text.startsWith(RECEIPT_PREFIX)));
    await fixture.drainSubagents();
    const persisted = await persistedSnapshot(fixture, run.parent);
    const persistedEvent = mode === 'native' ? resultFor(persisted, callId)
      : persisted.events.find((item) => item.type === 'tool/ptc-dispatch' && item.data.name === 'subagent');
    const childObservation = await fixture.ctx.sessionQuery.observeSession(child.id);
    try {
      assert.equal(childObservation.source, 'prepared');
      const persistedChild = await fixture.ctx.sessionQuery.readSession(child.id);
      assert.deepEqual(contentOf(persistedEvent), contentOf(run.event));
      assert.deepEqual(await proveActivationContentReceipt(persisted, persistedEvent, persistedChild, fixture.requests, RECEIPT_LIMITS, resolveConfig), expected);
    } finally {
      childObservation[Symbol.dispose]();
    }
  });
}

for (const mode of ['native', 'ptc']) {
  test(`unsupported around-success-meta ${mode}: closed budget is retained without rerunning the unsupported seam`, { skip: 'around success meta is normalized away by the actual DSH runtime; original failure budget CLOSED 2/2' }, async (t) => {
    const fixture = await fixtureFor(t);
    const delegateName = 'contract_delegate';
    const declaredRoute = { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL, reasoningEffort: 'low' };
    await fixture.mount('@deepseek-ai/dsh-tool-subagent', {
      provider: 'spawn', toolName: delegateName, maxDepth: 1, agentOptions: declaredRoute,
    });
    const parent = await fixture.createAgent(`contract-activation-${mode}`);
    const childCreated = Promise.withResolvers();
    fixture.ctx.on('agent/created', ({ agent }) => {
      if (agent.session.header.parentSession !== parent.id) return;
      fixture.queueStream(agent.id, textStream('isolated contract child complete'));
      childCreated.resolve(agent);
    }, { global: true });
    const canonicalResults = [];
    parent.ctx.on('tools/result', (exec, result) => {
      if (exec.name === delegateName) canonicalResults.push({ exec, result });
    });
    bindActivationReceipt(parent, delegateName, declaredRoute);
    if (mode === 'ptc') await presentAgentAsPtc(fixture, parent);
    const callId = `activation-${mode}`;
    const args = { description: 'Isolated public contract child', prompt: 'Return the fixture completion text only.' };
    const driving = driveTool(fixture, parent, callId, mode === 'native' ? delegateName : 'run_code', mode === 'native' ? args : {
      description: 'Start the isolated actual spawn child through the generated SDK',
      code: `return await tools.contract_delegate(${JSON.stringify(args)});`,
    });
    fixture.queueStream(parent.id, textStream('isolated child notification received'));
    await driving;
    const child = await confirmedWithin(childCreated.promise, 'real spawn child creation');
    await child.whenIdle();
    await parent.whenIdle();
    const snapshot = await fixture.ctx.sessionQuery.readSession(parent.id);
    assert.equal(canonicalResults.length, 1, 'prerequisite: exactly one real spawn canonical result');
    const canonical = canonicalResults[0];
    assert.equal(canonical.result.isError, false);
    assert.deepEqual(canonical.result.value, { kind: 'activation', subagentId: child.id });
    assert.deepEqual(canonical.result.content, [{ type: 'text', text: `started subagent ${child.id}` }]);
    const childSnapshot = await fixture.ctx.sessionQuery.readSession(child.id);
    assert.equal(childSnapshot.session.parentSession, parent.id);
    assert.equal(childSnapshot.session.origin, 'subagent');
    assert.equal(childSnapshot.session.delegationDepth, 1);
    const request = fixture.requests.find((entry) => entry.sessionId === child.id);
    assert.deepEqual(request, { sessionId: child.id, provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL, reasoningEffort: 'low' });
    const resultEvent = mode === 'native' ? resultFor(snapshot, callId)
      : snapshot.events.find((event) => event.type === 'tool/ptc-dispatch' && event.data.name === delegateName);
    assert.ok(resultEvent, 'prerequisite: trusted real native or SDK result event');
    const expectedReceipt = {
      schema: 'clean-desktop-shell.delegation.activation.v1', kind: 'activation',
      subagentId: child.id, declaredRoute,
      callId: mode === 'native' ? callId : `${callId}:ptc:1`, rootCallId: callId,
    };
    assert.deepEqual(resultEvent.data.meta?.cleanDesktopDelegation, expectedReceipt, `ACTIVATION_${mode.toUpperCase()}_RECEIPT_MISSING: canonical identity must survive the actual persistence path`);
    assert.ok(!Object.hasOwn(expectedReceipt, 'actualRoute'), 'declared configuration must never masquerade as actual execution proof');
    await fixture.drainSubagents();
    const persisted = await persistedSnapshot(fixture, parent);
    const persistedEvent = mode === 'native' ? resultFor(persisted, callId)
      : persisted.events.find((event) => event.type === 'tool/ptc-dispatch' && event.data.name === delegateName);
    assert.deepEqual(persistedEvent.data.meta.cleanDesktopDelegation, expectedReceipt);
    const childObservation = await fixture.ctx.sessionQuery.observeSession(child.id);
    try {
      assert.equal(childObservation.source, 'prepared');
      assert.equal(childObservation.header.parentSession, parent.id);
      assert.equal(childObservation.header.origin, 'subagent');
    } finally {
      childObservation[Symbol.dispose]();
    }
  });
}

const clientGateOptions = {
  sourceRoot: contractEnvironment.sourceRoot,
  clientDepsManifest: contractEnvironment.clientDepsManifest,
};

test('client gate: pinned ClientStore seed, production ConfigForms provision and Settings CAS over the real Client Remote path', async (t) => {
  assert.ok(clientGateOptions.sourceRoot, 'the pinned checker-out source root must be resolved (DSH_CONTRACT_CLIENT_SOURCE_ROOT)');
  assert.ok(clientGateOptions.clientDepsManifest, 'the approved dependency anchor must be resolved (DSH_CONTRACT_CLIENT_DEPS)');
  const fixture = await fixtureFor(t);
  const initialRoute = { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL, reasoningEffort: 'medium' };
  const gate = await createClientSettingsSurface(fixture, {
    id: 'contract-delegation-gate', field: 'workerRoute', initialValue: initialRoute,
    sourceRoot: clientGateOptions.sourceRoot, clientDepsManifest: clientGateOptions.clientDepsManifest,
  });

  // 1. Dependency basis + real source namespace (no fake store, no guessed URLs).
  const seed = gate.moduleSurface.store;
  assert.equal(seed.sha, CLIENT_STORE_SOURCE_SHA);
  assert.equal(seed.manifestVersion, CONTRACT_RUNTIME_VERSION);
  assert.deepEqual(seed.dependencies.map((row) => [row.specifier, row.version]), [
    ['zustand/vanilla', '4.5.7'], ['zustand/middleware', '4.5.7'], ['zustand/shallow', '4.5.7'], ['immer', '10.1.1'],
  ]);
  assert.deepEqual(seed.transitive, [{ name: 'use-sync-external-store', location: seed.transitive[0].location, version: '1.7.0' }]);
  for (const specifier of ['zustand/vanilla', 'zustand/middleware', 'zustand/shallow', 'immer']) {
    assert.match(seed.imported[specifier], /client-deps[\\/]node_modules[\\/]/, `${specifier} must be imported from the approved anchor`);
  }
  assert.match(seed.imported['zustand/vanilla'], /esm[\\/]vanilla\.mjs$/, 'the artifact must take the ESM condition, not the CJS file');
  assert.match(seed.artifactSha, /^[0-9a-f]{64}$/);
  assert.ok(seed.artifact.startsWith(fixture.scratchRoot));

  // 2. Real classic registrations captured from the installed pinned runtime.
  assert.deepEqual(gate.moduleSurface.captures.map((capture) => capture.id),
    [CLIENT_GATE_BUNDLES.modules, CLIENT_GATE_BUNDLES.uiSettings]);
  for (const capture of gate.moduleSurface.captures) {
    assert.equal(capture.firstLine, 'window.__ModuleLoader__.load({');
    assert.match(capture.sha, /^[0-9a-f]{64}$/);
    assert.ok(capture.path.startsWith(fixture.runtime.root));
  }
  assert.equal(gate.moduleSurface.modules.version, 'client');
  assert.equal(gate.moduleSurface.facade.mode, 'live', 'the facade must switch to live registration after boot');
  assert.deepEqual(gate.moduleSurface.pendingQueue, [], 'no leftover pending registration may duplicate the bootstrap factory');

  // 3. Real provider provision, not a captured registration.
  assert.equal(gate.providerFiber.state, 2);
  assert.ok(fixture.ctx.configEditor.entries().includes(gate.owner.entry), 'the outer Host entry id must be the real Include row');
  assert.equal(gate.ns, gate.owner.entry.options.id);
  const mirror = gate.configForms.describe();
  await mirror.ensure();
  const mirrorSnapshot = mirror.getSnapshot();
  assert.equal(mirrorSnapshot.status, 'ready');
  assert.equal(mirrorSnapshot.error, null);
  assert.equal(mirrorSnapshot.view.writable, true);
  const mirrorView = mirrorSnapshot.view.namespaces.find((view) => view.ns === gate.ns);
  assert.ok(mirrorView, 'the Host must serve the real plugin namespace');
  assert.deepEqual(mirrorView.value, { workerRoute: initialRoute });

  // 4. Real CAS through remote.settings -> Host settingsController -> settings.
  const form = gate.configForms.get(gate.ns);
  const before = form.getSnapshot();
  assert.equal(before.status, 'ready');
  assert.equal(before.writable, true);
  assert.equal(before.revision, mirrorView.revision);
  assert.deepEqual(before.value, { workerRoute: initialRoute });
  const completeRoute = { provider: 'contract-gate-provider', model: 'contract-gate-model', reasoningEffort: 'low' };
  assert.equal(await form.mutate([{ op: 'set', path: ['workerRoute'], value: completeRoute }], before.revision), true,
    'CAS at the read revision must be accepted');
  const accepted = gate.traffic.filter((entry) => entry.kind === 'call' && entry.endpoint === 'settings/mutate');
  assert.equal(accepted.length, 1);
  assert.deepEqual(accepted[0].args, {
    ns: gate.ns, ops: [{ op: 'set', path: ['workerRoute'], value: completeRoute }], expectedRevision: before.revision,
  });
  const after = form.getSnapshot();
  assert.equal(after.revision, before.revision + 1, 'an accepted write must bump the real revision');
  assert.deepEqual(after.value, { workerRoute: completeRoute });
  assert.deepEqual(gate.owner.config.workerRoute.get(), completeRoute, 'the owning fiber must hold the committed volatile value');
  assert.equal(fixture.ctx.settings.describe().find((row) => row.ns === gate.ns).revision, after.revision);

  // 5. A stale revision is refused and never presented as saved.
  const staleRoute = { provider: 'stale-provider', model: 'stale-model', reasoningEffort: 'low' };
  assert.equal(await form.mutate([{ op: 'set', path: ['workerRoute'], value: staleRoute }], before.revision), false,
    'a stale expectedRevision must answer false, never success');
  const refused = gate.traffic.filter((entry) => entry.kind === 'call' && entry.endpoint === 'settings/mutate');
  assert.equal(refused.length, 2);
  assert.deepEqual(refused[1].args.expectedRevision, before.revision);
  assert.deepEqual(form.getSnapshot().value, { workerRoute: completeRoute }, 'a refused write must never be treated as saved');
  assert.equal(form.getSnapshot().revision, after.revision);
  assert.deepEqual(gate.owner.config.workerRoute.get(), completeRoute);
  assert.equal(fixture.ctx.settings.describe().find((row) => row.ns === gate.ns).revision, after.revision,
    'a refused write must not bump the revision');

  // 6. The real Host document event reaches the Client mirror without a Client call.
  const updates = [];
  fixture.ctx.on('settings/document-updated', (ns, revision) => updates.push({ ns, revision }));
  const hostRoute = { provider: 'contract-host-provider', model: 'contract-host-model', reasoningEffort: 'low' };
  const advanced = Promise.withResolvers();
  const stop = form.subscribe(() => {
    if (form.getSnapshot().revision > after.revision) advanced.resolve();
  });
  await fixture.ctx.settings.mutate(gate.ns, [{ op: 'set', path: ['workerRoute'], value: hostRoute }], undefined);
  assert.ok(updates.some((entry) => entry.ns === gate.ns), 'the Host must emit its own document update');
  try {
    await confirmedWithin(advanced.promise, 'forwarded settings document update');
  } finally {
    stop();
  }
  assert.deepEqual(form.getSnapshot().value, { workerRoute: hostRoute });
  assert.ok(form.getSnapshot().revision > after.revision);
  assert.ok(gate.traffic.some((entry) => entry.kind === 'stream' && entry.endpoint === '$events'),
    'the mirror refresh must ride the real forwarded-event stream');
  assert.deepEqual(fixture.requests, [], 'the client gate performs no model stream');
});
