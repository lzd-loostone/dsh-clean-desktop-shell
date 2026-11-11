import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire, registerHooks } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  createNodeRemoteFixture, createRc5Fixture, FIXTURE_MODEL, FIXTURE_PROVIDER, strictRemoteDescriptor,
} from './delegation-contract-fixture.js';
import { snapshotWorkerRoute } from './delegation-config.js';
import { createPresetPublisher } from './delegation-publisher.js';

const runtimeRoot = process.env.DSH_CONTRACT_RUNTIME_ROOT;
const scratchRoot = process.env.DSH_CONTRACT_SCRATCH_ROOT;
const enabled = typeof runtimeRoot === 'string' && runtimeRoot.length > 0
  && typeof scratchRoot === 'string' && scratchRoot.length > 0;
const skip = enabled ? false : 'requires DSH_CONTRACT_RUNTIME_ROOT and DSH_CONTRACT_SCRATCH_ROOT (run .dsh-tmp/ptc-brain-delegation/task-3/run-host-tests.sh)';

// The product module imports its Host SDK peers by bare package name, exactly like every
// installed dsh plugin. This harness supplies that resolution explicitly from the same rc.5
// installation the Task 1 fixture already requires; it maps to the fixture's own module URLs.
if (enabled) {
  const anchor = join(realpathSync(runtimeRoot), 'package.json');
  const requireFromRuntime = createRequire(anchor);
  const mapped = new Map([
    ['@deepseek-ai/schemastery', requireFromRuntime.resolve('@deepseek-ai/schemastery')],
    ['@deepseek-ai/dsh-typert-protocol', requireFromRuntime.resolve('@deepseek-ai/dsh-typert-protocol')],
  ]);
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const target = mapped.get(specifier);
      if (target !== undefined) return { url: pathToFileURL(target).href, shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });
}
const host = enabled ? await import('./delegation.js') : null;

const ROW_ID = 'delegation-host';
/**
 * Inert gate ports for the fixture. The packaged gate module is not installed in this
 * scratch profile, so these are consumed only by the delegation row's ordering wait; the
 * gate's real use of scopeOf/scopeChainOf/foldRequestHeader needs the package install
 * (Task 6b). They must still be callable so a future gate mount fails loudly, not silently.
 */
const FIXTURE_GATE_PORTS = Object.freeze({
  scopeOf: () => undefined,
  scopeChainOf: () => [],
  foldRequestHeader: () => null,
});

async function hostFixture(t, { gatePorts = true } = {}) {
  const fixture = await createRc5Fixture({ runtimeRoot, scratchRoot });
  t.after(() => fixture.dispose());
  // Task 6: the delegation row publishes only after `delegationGatePorts` exists. Existing
  // tests exercise the publish paths, so the fixture declares the ports before mounting.
  if (gatePorts) fixture.ctx.provide('delegationGatePorts', FIXTURE_GATE_PORTS);
  return fixture;
}

/** Mount the product's own include row in the real rc.5 Loader, Config and Settings namespace. */
async function mountHostRow(fixture, config) {
  const { ctx, runtime, workdir } = fixture;
  const profileDir = join(workdir, 'delegation-profile');
  const home = join(workdir, 'delegation-home');
  await mkdir(profileDir, { recursive: true });
  await mkdir(home, { recursive: true });
  const appBoot = await runtime.load('@deepseek-ai/dsh-app-boot');
  const baseConfigPath = join(profileDir, 'delegation-base.json');
  const patchPath = join(profileDir, appBoot.PROFILE_PATCH_FILENAME);
  const patches = [{ insert: [{ id: ROW_ID, name: 'cordis:delegation-host', config }] }];
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: [] } } }), 'utf8');
  await writeFile(baseConfigPath, '[]\n', 'utf8');
  await writeFile(patchPath, JSON.stringify(patches), 'utf8');
  ctx.provide('profileContext', {
    name: 'delegation-profile', dir: profileDir, patchPath,
    installAnchor: join(runtime.root, 'package.json'), cwd: workdir, home,
    startedBundles: [], overlays: [], telemetryDisabledEnv: '1',
  });
  await fixture.mount('@deepseek-ai/cordis-plugin-loader', { baseUrl: `${pathToFileURL(workdir).href}/` });
  await fixture.mount('@deepseek-ai/dsh-config-editor');
  await fixture.mount('@deepseek-ai/dsh-settings');
  await fixture.mount('@deepseek-ai/dsh-agent-preset-registry', { default: 'ptc' });
  ctx.loader.builtins['delegation-host'] = host.plugin;
  const include = await appBoot.mountRootInclude(ctx, baseConfigPath, patches);
  assert.ok(include, 'the real app-boot root Include must load');
  await include.fiber.await();
  const rows = [...ctx.loader.entries()].filter((item) => item.options.id === ROW_ID);
  assert.equal(rows.length, 1, 'exactly one real Loader row must own the namespace');
  return { entry: rows[0], include };
}

async function waitFor(predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function settingsRevision(fixture, ns) {
  const descriptor = fixture.ctx.settings.describe().find((item) => item.ns === ns);
  assert.ok(descriptor, `the settings descriptor for ${ns} must exist`);
  return descriptor.revision;
}

test('host row owns its real profile namespace and republishes a committed volatile edit in place', { skip }, async (t) => {
  const fixture = await hostFixture(t);
  const { entry } = await mountHostRow(fixture, {
    workerRoute: { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL },
    catalogLimit: 4,
  });
  assert.equal(entry.fiber.state, 2, 'the independent Host row must activate');
  assert.ok(fixture.ctx.configEditor.entries().includes(entry), 'the same Entry object must be the addressable profile row');
  const ns = entry.options.id;
  assert.equal(ns, ROW_ID);

  const descriptor = fixture.ctx.settings.describe().find((item) => item.ns === ns);
  assert.ok(descriptor, 'a real settings descriptor must exist for the owned namespace');
  assert.equal(descriptor.applies, 'live');
  assert.ok(descriptor.schema && descriptor.schema.refs, 'the descriptor must expose the real Config schema');
  const refs = Object.values(descriptor.schema.refs);
  const routeRef = refs.find((ref) => ref?.type === 'object' && ref.dict
    && ['provider', 'model', 'reasoningEffort'].every((key) => Object.hasOwn(ref.dict, key)));
  assert.ok(routeRef, 'the live form must be built from the real workerRoute fields');
  const formRef = refs.find((ref) => ref?.dict && Object.hasOwn(ref.dict, 'workerRoute'));
  assert.ok(formRef, 'workerRoute must be the live (volatile) form field');
  assert.equal(Object.hasOwn(formRef.dict, 'catalogLimit'), false,
    'an ordinary field must not be presented as a live-editable field');

  const service = fixture.ctx.get(host.READ_NAMESPACE);
  assert.ok(service, 'the read namespace must be provided by the real plugin');
  const status = () => service.describeDelegation();

  const failed = await waitFor(() => (status().state === 'failed' ? status() : null), 'the first honest publish attempt');
  assert.equal(failed.settingsNs, ns);
  assert.equal(failed.error, 'PRESET_HEALTH_FAILED', 'register() success is not health; the absent gate row must fail health honestly');
  assert.equal(failed.publishedRoute, null);
  assert.equal(failed.generation, null);
  assert.deepEqual(failed.savedRoute, { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL });
  // A candidate that failed health was retired: nothing may stay registered as if it were live.
  await assert.rejects(fixture.ctx.agentPresets.resolve(host.PRESET_ID),
    (error) => error.code === 'agent-preset/not-found', 'the unhealthy candidate must not remain registered');

  const controller = new AbortController();
  const seen = [];
  const reader = (async () => {
    for await (const item of service.watchDelegation(controller.signal)) seen.push(item);
  })();
  await waitFor(() => seen.length > 0, 'the immediate watch snapshot');
  assert.equal(seen[0].settingsNs, ns);
  assert.equal(seen[0].state, 'failed');

  const fiberBefore = entry.fiber;
  await fixture.ctx.settings.update(ns, {
    workerRoute: { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL, reasoningEffort: 'low' },
  }, settingsRevision(fixture, ns));
  await waitFor(() => seen.some((item) => item.state === 'publishing' && item.savedRoute?.reasoningEffort === 'low'),
    'a volatile republish without a remount');
  const settled = await waitFor(() => (status().savedRoute?.reasoningEffort === 'low' && status().state === 'failed' ? status() : null),
    'the settled republish');
  assert.equal(settled.error, 'PRESET_HEALTH_FAILED');
  assert.equal(entry.fiber, fiberBefore, 'a committed volatile edit must not remount the owning fiber');
  assert.equal(entry.fiber.state, 2);

  controller.abort();
  await reader;
});

test('host row reports resolver and effort refusals and publishes nothing for a refused CAS write', { skip }, async (t) => {
  const fixture = await hostFixture(t);
  const { entry } = await mountHostRow(fixture, { workerRoute: null });
  const ns = entry.options.id;
  const service = fixture.ctx.get(host.READ_NAMESPACE);
  assert.ok(service, 'the read namespace must be provided by the real plugin');
  const status = () => service.describeDelegation();
  await waitFor(() => status().state === 'failed', 'the unconfigured publish attempt');

  const silent = { provider: 'no-such-provider', model: 'no-such-model' };
  await fixture.ctx.settings.update(ns, { workerRoute: silent }, settingsRevision(fixture, ns));
  const refused = await waitFor(() => {
    const value = status();
    return value.error === 'WORKER_ROUTE_VALIDATION_FAILED' && value.savedRoute?.provider === silent.provider ? value : null;
  }, 'the real llm resolver refusal');
  assert.deepEqual(refused.savedRoute, silent);
  assert.equal(refused.publishedRoute, null);
  assert.equal(refused.state, 'failed');

  await fixture.ctx.settings.update(ns, {
    workerRoute: { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL, reasoningEffort: 'ultra' },
  }, settingsRevision(fixture, ns));
  const unsupported = await waitFor(() => {
    const value = status();
    return value.error === 'WORKER_ROUTE_VALIDATION_FAILED' && value.savedRoute?.reasoningEffort === 'ultra' ? value : null;
  }, 'the unsupported explicit effort refusal');
  assert.equal(unsupported.publishedRoute, null);

  const before = status();
  await assert.rejects(
    fixture.ctx.settings.update(ns, { workerRoute: { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL } }, 0),
    (error) => error.code === 'SETTINGS_CONFLICT',
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(status(), before, 'a refused CAS write must not publish anything');
});

test('read namespace exposes five readonly Remote methods over the real Gateway carrier', { skip }, async (t) => {
  const fixture = await hostFixture(t);
  const { entry } = await mountHostRow(fixture, {
    workerRoute: { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL },
    catalogLimit: 1,
  });
  const ns = entry.options.id;
  const service = fixture.ctx.get(host.READ_NAMESPACE);
  assert.ok(service, 'the read namespace must be provided by the real plugin');
  await waitFor(() => service.describeDelegation().state === 'failed', 'the first publish attempt');

  const adapter = fixture.adapter;
  const original = { listModels: adapter.listModels, resolveModel: adapter.resolveModel };
  let adapterReads = 0;
  adapter.listModels = function (...args) { adapterReads += 1; return original.listModels.apply(this, args); };
  adapter.resolveModel = function (...args) { adapterReads += 1; return original.resolveModel.apply(this, args); };
  t.after(() => { adapter.listModels = original.listModels; adapter.resolveModel = original.resolveModel; });

  const node = await createNodeRemoteFixture(fixture);
  const binding = await node.mountClient({
    package: 'dsh-clean-desktop-shell',
    descriptors: [
      strictRemoteDescriptor(host.READ_NAMESPACE, 'describeDelegation'),
      strictRemoteDescriptor(host.READ_NAMESPACE, 'listWorkerProviders'),
      strictRemoteDescriptor(host.READ_NAMESPACE, 'listWorkerModels', ['providerId']),
      strictRemoteDescriptor(host.READ_NAMESPACE, 'listWorkerEfforts', ['providerId', 'modelId']),
      strictRemoteDescriptor(host.READ_NAMESPACE, 'watchDelegation', [], true),
    ],
  });
  const remote = binding.ctx.remote[host.READ_NAMESPACE];
  assert.ok(remote, 'the public Client Remote face must expose the namespace');
  const signal = new AbortController().signal;

  const described = await remote.describeDelegation(signal);
  assert.equal(described.ok, true);
  assert.equal(described.value.settingsNs, ns);
  assert.equal(described.value.state, 'failed');
  assert.deepEqual(described.value.savedRoute, { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL });
  assert.deepEqual(described.value.publishedRoute, null);

  const providers = await remote.listWorkerProviders(signal);
  assert.deepEqual(providers, {
    ok: true,
    value: { items: [{ id: FIXTURE_PROVIDER, name: 'Contract deterministic adapter' }], total: 1, truncated: false },
  });
  const models = await remote.listWorkerModels(FIXTURE_PROVIDER, signal);
  assert.deepEqual(models, { ok: true, value: { items: [{ id: FIXTURE_MODEL, name: 'Contract model' }], total: 1, truncated: false } });
  const efforts = await remote.listWorkerEfforts(FIXTURE_PROVIDER, FIXTURE_MODEL, signal);
  assert.deepEqual(efforts, {
    ok: true,
    value: {
      efforts: [{ id: 'low', name: 'Low' }],
      defaultEffort: 'medium', total: 2, truncated: true,
    },
  }, 'the retained options are bounded and the catalogue declares its own truncation');
  assert.ok(adapterReads >= 2, 'the catalogue reads must come from the registered adapter');

  for (const invalid of [17, undefined, null, {}, [], '', '   ']) {
    const badProvider = await remote.listWorkerModels(invalid);
    const badModel = await remote.listWorkerEfforts(FIXTURE_PROVIDER, invalid);
    const badFirst = await remote.listWorkerEfforts(invalid, FIXTURE_MODEL);
    for (const [reply, field] of [[badProvider, 'providerId'], [badModel, 'modelId'], [badFirst, 'providerId']]) {
      assert.equal(reply.ok, false, 'the owner-side guard must refuse an invalid named id');
      assert.equal(reply.error.code, 'gateway/bad-request');
      assert.deepEqual(reply.error.details, { issues: [{ field, message: 'expected a non-empty string' }] });
    }
  }
  assert.equal(adapterReads, 2, 'no business/catalog read may happen before every named input parses');
  assert.deepEqual(node.traffic.filter((item) => item.kind === 'call').every((item) => !Object.hasOwn(item.args, 'signal')), true,
    'a cancellation signal is framework-injected, never a wire argument');

  for (const args of [{}, { providerId: 'x', extra: 17 }, { providerId: 'x', signal: 'wire-forbidden' }]) {
    const reply = await node.clientCtx.connection.rpc.call('/api', `${host.READ_NAMESPACE}/listWorkerModels`, { args });
    assert.equal(reply.ok, false, 'the exact wire argument guard must refuse unknown or extra arguments');
  }

  const controller = new AbortController();
  const stream = remote.watchDelegation(controller.signal);
  const iterator = stream[Symbol.asyncIterator]();
  const snapshot = await iterator.next();
  assert.equal(snapshot.done, false);
  assert.equal(snapshot.value.settingsNs, ns);
  await fixture.ctx.settings.update(ns, {
    workerRoute: { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL, reasoningEffort: 'low' },
  }, settingsRevision(fixture, ns));
  const transition = await iterator.next();
  assert.equal(transition.done, false);
  assert.equal(transition.value.state, 'publishing');
  stream.dispose();
  assert.equal((await iterator.next()).done, true, 'disposing the handle must end the owned stream');
  assert.ok(node.traffic.filter((item) => item.kind === 'stream').every((item) => !Object.hasOwn(item.args, 'signal')));
  assert.deepEqual(await remote.describeDelegation(signal), { ok: true, value: service.describeDelegation() });
});

test('publisher adapter: real registry lifecycle, honest republish window and a no-op skip', { skip }, async (t) => {
  const fixture = await hostFixture(t);
  await fixture.mount('@deepseek-ai/cordis-plugin-loader', { baseUrl: `${pathToFileURL(fixture.workdir).href}/` });
  fixture.ctx.loader.builtins['delegation-adapter-leaf'] = { name: 'delegation-adapter-leaf', apply() {} };
  await fixture.mount('@deepseek-ai/dsh-agent-preset-registry', { default: 'ptc' });

  const definition = { id: host.PRESET_ID, name: 'adapter level definition', plugins: [{ id: 'leaf', name: 'cordis:delegation-adapter-leaf' }] };
  const notifications = [];
  const publisher = createPresetPublisher({
    settingsNs: ROW_ID,
    snapshotWorkerRoute,
    validateWorkerRoute: (route, incomingSignal) => host.validateWorkerRoute(fixture.ctx.llm, route, incomingSignal),
    buildDelegationPresets: () => [definition],
    register: (candidate) => fixture.ctx.agentPresets.register(candidate),
    healthyCheckpoint: (candidate) => host.checkPresetHealth(fixture.ctx.agentPresets, candidate),
  });
  t.after(() => publisher.stop());
  publisher.subscribe((status) => notifications.push(status));
  const republisher = host.createRepublisher({ publisher, validateWorkerRoute: (route, incomingSignal) => host.validateWorkerRoute(fixture.ctx.llm, route, incomingSignal) });
  t.after(() => republisher.stop());

  const first = await republisher.request({ provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL });
  assert.equal(first.state, 'active');
  assert.equal(first.generation, 1);
  assert.deepEqual(first.savedRoute, { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL });
  assert.deepEqual(first.publishedRoute, { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL, reasoningEffort: 'medium' });
  assert.equal((await fixture.ctx.agentPresets.resolve(host.PRESET_ID)).broken, undefined, 'the real registry must be healthy here');

  const before = notifications.length;
  const skipped = await republisher.request({ provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL, reasoningEffort: 'medium' });
  assert.equal(skipped.generation, 1);
  assert.equal(skipped.state, 'active');
  assert.equal(notifications.length, before, 'an unchanged effective route must not enqueue a republish');

  const second = await republisher.request({ provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL, reasoningEffort: 'low' });
  assert.equal(second.state, 'active');
  assert.equal(second.generation, 2);
  assert.deepEqual(second.publishedRoute, { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL, reasoningEffort: 'low' });
  assert.ok(notifications.some((item) => item.state === 'publishing' && item.publishedRoute === null),
    'the retired window must be visible as publishing with no published route');
  assert.ok(notifications.every((item) => item.state !== 'active' || item.publishedRoute !== null));
  assert.equal((await fixture.ctx.agentPresets.resolve(host.PRESET_ID)).broken, undefined);

  await publisher.stop();
  assert.equal(notifications.filter((item) => item.error === 'PUBLISHER_STOPPED').length, 1,
    'the terminal status is delivered exactly once');
});

test('the first publish waits for the gate-port service instead of racing it', { skip }, async (t) => {
  // Row ordering is not guaranteed: the ports row may be applied after the publisher row.
  const fixture = await hostFixture(t, { gatePorts: false });
  const { entry } = await mountHostRow(fixture, { workerRoute: { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL } });
  assert.equal(entry.fiber.state, 2, 'the publisher row itself must still activate');
  const service = fixture.ctx.get(host.READ_NAMESPACE);
  assert.ok(service, 'the readonly namespace must exist even while the publish is parked');
  const status = () => service.describeDelegation();

  // Without the service the publisher must not open a generation at all: no build, no
  // register, no health failure, nothing to retire. A bounded wait is enough to prove the
  // attempt is blocked on the port rather than merely slow.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const parked = status();
  assert.equal(parked.state, 'needs-config');
  assert.equal(parked.generation, null);
  assert.equal(parked.error, null, 'no failed attempt may be recorded before the ports exist');
  assert.equal(parked.savedRoute, null, 'nothing has been attempted yet');

  // The ports appear later (a profile whose rows are ordered publisher-before-ports): the
  // publish is released immediately. This scratch profile has no installed copy of the
  // package, so the preset's gate row is unresolvable and the honest outcome is a health
  // failure; the release itself — plus the absence of any earlier attempt — is what this
  // test proves. A healthy publish with the real gate row is the Task 6b mount proof.
  fixture.ctx.provide('delegationGatePorts', FIXTURE_GATE_PORTS);
  const released = await waitFor(() => (status().error === null ? null : status()), 'the publish released by the gate ports');
  assert.equal(released.error, 'PRESET_HEALTH_FAILED');
  assert.equal(released.generation, null);
  assert.deepEqual(released.savedRoute, { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL });
});
