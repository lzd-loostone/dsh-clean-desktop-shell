import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { snapshotWorkerRoute } from './delegation-config.js';
import {
  PURE_PRESET_ID,
  ROUTER_PRESET_ID,
  buildDelegationPreset,
  buildDelegationPresets,
  presetList,
} from './delegation-preset.js';

const asset = (name) => new URL(`../../assets/delegation/${name}`, import.meta.url);
const readAsset = (name) => readFileSync(asset(name), 'utf8');
const officialPrefix = 'You are a coding agent powered by the {{model}} model.';
const official = JSON.parse(readAsset('official-ptc.json'));
const stubResolve = (name) => name;
const build = (route = null, platform = 'linux', extra = {}) => buildDelegationPresets(route, platform, { resolve: stubResolve, ...extra });

function entry(entries, id) {
  assert.ok(Array.isArray(entries), `expected an entry list for ${id}`);
  const row = entries.find((candidate) => candidate.id === id);
  assert.ok(row, `expected entry ${id}`);
  return row;
}

function delegation(definition, id) {
  return entry(entry(definition.plugins, 'delegation').config, id);
}

function assertDeepSnapshot(value) {
  if (value === null || typeof value !== 'object') return;
  assert.equal(Object.getPrototypeOf(value), Array.isArray(value) ? Array.prototype : Object.prototype);
  assert.ok(Object.isFrozen(value), 'every snapshot node must be immutable');
  for (const child of Object.values(value)) assertDeepSnapshot(child);
}

function flattenRows(rows) {
  const pairs = [];
  for (const row of rows) {
    pairs.push([row.id, row.name]);
    if (Array.isArray(row.config)) pairs.push(...flattenRows(row.config));
  }
  return pairs;
}

// Break caught: the snapshot quietly drifting from the upgraded official preset again.
test('the official snapshot is pinned to dsh-v0.2.2-rc.1 and carries the 0.2.2 rows', () => {
  assert.deepEqual(official.source, {
    repo: 'deepseek-harness',
    tag: 'dsh-v0.2.2-rc.1',
    commit: '66491b05e3',
    file: 'packages/bundle/web-app/presets/ptc.patch.yml',
    sha256: 'ce02148b1fd575cc93071744180468cd305bdcd50dbfdd3b9b0605c5281d283d',
  });
  const names = official.rows.map((row) => row.name);
  assert.ok(names.includes('@deepseek-ai/dsh-tool-executor-ptc'));
  assert.equal(names.includes('@deepseek-ai/dsh-tool-presentation'), false);
  assert.equal(JSON.stringify(official.rows).includes('tool-subagent-control/list-agents'), false);
  assert.deepEqual(entry(official.rows, 'tool-fs').config, { applyPatch: false });
  assert.deepEqual(entry(entry(official.rows, 'delegation').config, 'tool-subagent').config, {
    provider: 'spawn', toolName: 'subagent', modelSelection: true, modelDiscovery: true,
  });
  for (const row of official.rows) {
    assert.equal(Object.hasOwn(row, 'order'), false, 'the outer preset order is not a row');
  }
});

// Break caught: collapsing the two deliverables into one preset id or losing its display name.
test('both presets exist with stable ids and names', () => {
  const { pure, router, dropped } = build({ provider: 'worker-a', model: 'model-a' });
  assert.deepEqual(dropped, []);
  assert.equal(pure.id, PURE_PRESET_ID);
  assert.equal(PURE_PRESET_ID, 'clean-desktop-shell-ptc');
  assert.equal(pure.name, 'PTC（插件）');
  assert.equal(typeof pure.description, 'string');
  assert.ok(pure.description.trim());
  assert.equal(router.id, ROUTER_PRESET_ID);
  assert.equal(ROUTER_PRESET_ID, 'clean-desktop-shell-ptc-router');
  assert.equal(router.name, 'PTC + 主脑分工');
  assert.equal(typeof router.description, 'string');
  assert.ok(router.description.trim());
});

// Break caught: the pure copy no longer being an official row-for-row transcription.
test('the pure preset mirrors the official snapshot row order and values', () => {
  const { pure } = build(null, 'linux');
  assert.deepEqual(flattenRows(pure.plugins), flattenRows(official.rows));
  for (const row of pure.plugins) {
    assert.equal(Object.hasOwn(row, 'slot'), false, 'slots are filled before publication');
    assert.equal(Object.hasOwn(row, 'disabledWhen'), false, 'platform markers are resolved before publication');
    if (row.group) for (const child of row.config) assert.equal(Object.hasOwn(child, 'slot'), false);
  }
  assert.equal(entry(pure.plugins, 'persona').config.prefix, officialPrefix);
  const section = entry(entry(pure.plugins, 'planning').config, 'plan-mode').config.section;
  assert.ok(section.startsWith('You are in plan mode.'));
  assert.ok(section.includes('exit_plan_mode'));
  assert.ok(section.includes('Make the plan decision-complete'));
  assert.deepEqual(entry(pure.plugins, 'tool-fs').config, { applyPatch: false });
  assert.deepEqual(delegation(pure, 'tool-subagent').config, {
    provider: 'spawn', toolName: 'subagent', modelSelection: true, modelDiscovery: true,
  });
  assert.equal(JSON.stringify(pure).includes('modelSelectionSettings'), false);
});

// Break caught: leaking the plugin's own gate or worker routing into the official-equivalent copy.
test('the pure preset has no gate row and no worker spawn options', () => {
  const { pure } = build({ provider: 'worker-a', model: 'model-a' }, 'linux');
  assert.equal(pure.plugins.some((row) => row.id === 'delegation-gate'), false);
  const spawn = delegation(pure, 'tool-subagent').config;
  assert.equal(Object.hasOwn(spawn, 'agentOptions'), false);
  assert.equal(Object.hasOwn(spawn, 'maxDepth'), false);
  const fork = delegation(pure, 'tool-subagent-fork').config;
  assert.equal(Object.hasOwn(fork, 'agentOptions'), false);
  assert.equal(Object.hasOwn(fork, 'maxDepth'), false);
});

// Break caught: a router copy that no longer routes spawn or omits the gate.
test('the router preset routes spawn and appends exactly one gate row', () => {
  const route = { provider: 'worker-a', model: 'model-a', reasoningEffort: 'high' };
  const { pure, router } = build(route, 'linux');
  const spawn = delegation(router, 'tool-subagent').config;
  assert.deepEqual(spawn.agentOptions, route);
  assert.equal(spawn.maxDepth, 1);
  assert.equal(spawn.modelSelection, true);
  assert.equal(spawn.modelDiscovery, true);
  const fork = delegation(router, 'tool-subagent-fork').config;
  assert.equal(Object.hasOwn(fork, 'agentOptions'), false);
  assert.equal(Object.hasOwn(fork, 'maxDepth'), false);
  const routerDelegation = entry(router.plugins, 'delegation').config;
  assert.equal(routerDelegation.filter((row) => row.id === 'delegation-gate').length, 1);
  assert.equal(routerDelegation.at(-1).id, 'delegation-gate', 'the gate is the last delegation row');
  assert.deepEqual(entry(routerDelegation, 'delegation-gate'), {
    id: 'delegation-gate', name: 'dsh-clean-desktop-shell/delegation-gate', config: { workerRoute: route },
  });
  const routerRows = delegation(router, 'tool-subagent');
  assert.notEqual(routerRows, delegation(pure, 'tool-subagent'), 'each preset owns its own row objects');
  assert.deepEqual(router.plugins.map((row) => row.id), pure.plugins.map((row) => row.id));
});

// Break caught: inventing routing defaults when no worker is configured.
test('the router preset keeps an explicitly unconfigured gate without agent options', () => {
  const { router } = build(null, 'linux');
  const spawn = delegation(router, 'tool-subagent').config;
  assert.equal(Object.hasOwn(spawn, 'agentOptions'), false);
  assert.equal(spawn.maxDepth, 1);
  assert.deepEqual(delegation(router, 'delegation-gate').config, { workerRoute: null });
});

// Break caught: dropping or rewriting the approved persona while splicing it into the router.
test('the router persona appends the shipped persona with the route label filled', () => {
  const template = readAsset('persona.md');
  const route = { provider: 'worker-a', model: 'model-a', reasoningEffort: 'high' };
  const { router } = build(route, 'linux');
  const prefix = entry(router.plugins, 'persona').config.prefix;
  assert.ok(prefix.startsWith(`${officialPrefix}\n\n`));
  assert.equal(prefix, `${officialPrefix}\n\n${template.replaceAll('{{workerRouteLabel}}', 'worker-a / model-a（reasoningEffort: high）')}`);
  assert.ok(prefix.includes('## 顶层主脑分工'));
  assert.equal(prefix.includes('{{workerRouteLabel}}'), false);
  const emptyPrefix = entry(build(null, 'linux').router.plugins, 'persona').config.prefix;
  assert.ok(emptyPrefix.includes('未配置的执行路由'));
  assert.doesNotMatch(emptyPrefix, /worker-a|model-a|new-api|deepseek-v4/);
});

// Break caught: literals from the official !!js platform conditions being swapped.
for (const [platform, bashDisabled, pwshDisabled] of [
  ['win32', true, false], ['linux', false, true], ['darwin', false, true], ['freebsd', false, true],
]) {
  test(`official platform conditions select the right shell on ${platform}`, () => {
    const { pure, router } = build(null, platform);
    for (const definition of [pure, router]) {
      assert.equal(entry(definition.plugins, 'tool-bash').disabled, bashDisabled);
      assert.equal(entry(definition.plugins, 'tool-pwsh').disabled, pwshDisabled);
    }
  });
}

test('default platform matches the current Host platform', () => {
  const { pure, router } = buildDelegationPresets(null, undefined, { resolve: stubResolve });
  for (const definition of [pure, router]) {
    assert.equal(entry(definition.plugins, 'tool-bash').disabled, process.platform === 'win32');
    assert.equal(entry(definition.plugins, 'tool-pwsh').disabled, process.platform !== 'win32');
  }
});

// Break caught: shallow freezing, shared mutable state between calls or frozen caller data.
test('complete definitions are detached deep ordinary snapshots', () => {
  const input = { provider: 'worker-a', model: 'model-a' };
  const first = build(input, 'linux');
  assertDeepSnapshot(first.pure);
  assertDeepSnapshot(first.router);
  assertDeepSnapshot(first.dropped);
  assert.deepEqual(delegation(first.router, 'delegation-gate').config.workerRoute, { provider: 'worker-a', model: 'model-a' });
  assert.notEqual(delegation(first.router, 'delegation-gate').config.workerRoute, input);
  input.provider = 'worker-b';
  assert.equal(delegation(first.router, 'tool-subagent').config.agentOptions.provider, 'worker-a');
  const second = build(input, 'linux');
  assert.notEqual(second, first);
  assert.notEqual(second.pure, first.pure);
  assert.notEqual(second.router.plugins, first.router.plugins);
  assert.notEqual(entry(second.router.plugins, 'compaction').config, entry(first.router.plugins, 'compaction').config);
  assert.equal(delegation(second.router, 'tool-subagent').config.agentOptions.provider, 'worker-b');
  assert.throws(() => { first.router.plugins.push({ id: 'unexpected' }); }, TypeError);
  assert.throws(() => { entry(first.router.plugins, 'compaction').isolate.compaction = false; }, TypeError);
  assert.throws(() => { delegation(first.router, 'delegation-gate').config.workerRoute.model = 'changed'; }, TypeError);
});

// Break caught: bypassing route validation when the publisher, not the settings helper, builds.
test('both presets reject partial or malformed route values', () => {
  for (const invalid of ['', { provider: 'worker-a' }, { provider: 'worker-a', model: 'model-a', extra: true }]) {
    assert.throws(() => build(invalid, 'linux'), TypeError);
  }
});

// Break caught: one vanished package row taking down the whole preset again.
test('a row whose package cannot be resolved is dropped and recorded, not fatal', () => {
  const resolve = (name) => {
    if (name === '@deepseek-ai/dsh-tool-bash') throw new Error('simulated missing package');
    return name;
  };
  const { pure, router, dropped } = build({ provider: 'worker-a', model: 'model-a' }, 'linux', { resolve });
  assert.equal(pure.plugins.some((row) => row.id === 'tool-bash'), false);
  assert.equal(router.plugins.some((row) => row.id === 'tool-bash'), false);
  assert.ok(pure.plugins.some((row) => row.id === 'tool-pwsh'));
  assert.deepEqual(dropped, [
    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', reason: 'simulated missing package' },
  ]);
  assert.ok(Object.isFrozen(dropped));
  assert.ok(Object.isFrozen(dropped[0]));
  assert.equal(delegation(router, 'tool-subagent').config.maxDepth, 1, 'the router still produces its gate');
  assert.equal(delegation(router, 'delegation-gate').config.workerRoute.provider, 'worker-a');
  assert.deepEqual(build(null, 'linux', { resolve: stubResolve }).dropped, [], 'dropped is per build, never shared');
});

// Break caught: an unresolvable nested group row poisoning its parent group.
test('an unresolvable row inside cordis:group config is dropped from that group only', () => {
  const resolve = (name) => {
    if (name === '@deepseek-ai/dsh-plan-mode') throw new Error('simulated missing child');
    return name;
  };
  const { pure, dropped } = build(null, 'linux', { resolve });
  const planning = entry(pure.plugins, 'planning');
  assert.deepEqual(planning.config, []);
  assert.ok(pure.plugins.some((row) => row.id === 'compaction'));
  assert.deepEqual(dropped, [
    { id: 'plan-mode', name: '@deepseek-ai/dsh-plan-mode', reason: 'simulated missing child' },
  ]);
});

// Break caught: keeping the old single-preset export as an independent implementation.
test('buildDelegationPreset stays a compatibility alias for the router preset', () => {
  const route = { provider: 'worker-a', model: 'model-a' };
  const router = buildDelegationPreset(route, 'linux', { resolve: stubResolve });
  assert.deepEqual(router, build(route, 'linux').router);
  assert.equal(router.id, ROUTER_PRESET_ID);
  assert.equal(router.name, 'PTC + 主脑分工');
});

test('source YAML and attribution preserve the complete pinned official bytes', () => {
  assert.ok(existsSync(asset('ptc-rc5.yml')), 'complete official rc.5 YAML asset must exist');
  const bytes = readFileSync(asset('ptc-rc5.yml'));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '9e355c947bf61c3d2fe9bf3214b386f83c0d99d37579ce22576d4b82cb6e1a2c');
  assert.ok(existsSync(asset('provenance.json')), 'provenance and full license notice must exist');
  const provenance = JSON.parse(readAsset('provenance.json'));
  assert.equal(provenance.tag, 'dsh-v0.2.1-rc.5');
  assert.equal(provenance.commit, 'b830ec950faba0a46dda564be3e2d854afed94f1');
  assert.equal(provenance.sha256, '9e355c947bf61c3d2fe9bf3214b386f83c0d99d37579ce22576d4b82cb6e1a2c');
  assert.equal(provenance.license.spdx, 'MIT');
  assert.ok(provenance.license.notice.includes('Copyright (c) 2026 DeepSeek'));
  assert.ok(provenance.license.notice.includes('THE SOFTWARE IS PROVIDED "AS IS"'));
});

test('runtime assets contain no machine paths or personal worker defaults', () => {
  for (const name of ['ptc-rc5.yml', 'provenance.json', 'persona.md', 'official-ptc.json']) {
    assert.ok(existsSync(asset(name)), `required runtime asset ${name}`);
    const text = readAsset(name);
    assert.doesNotMatch(text, /[A-Za-z]:[\\/]Users[\\/]|[A-Za-z]:[\\/]AndroidStudioProjects[\\/]|new-api|deepseek-v4\.1-flash-1017|agent-model-routing-plan/);
  }
  const serialized = JSON.stringify(build(null, 'linux'));
  assert.doesNotMatch(serialized, /__jsExpr|review_agent|allowedAgentPresets|agentPreset|"extends"|"patch"/);
});

test('without a reachable DSH install every row is kept and validation is reported as skipped', () => {
  // In this repository `@deepseek-ai/*` is not installed, so probing packages
  // from here would drop every row and publish a hollow preset. The builder
  // must detect that the DSH install itself is unreachable and trust the
  // loader instead of deleting the definition.
  const built = buildDelegationPresets(null, 'linux');
  assert.equal(built.validationSkipped, true);
  assert.deepEqual(built.dropped, []);
  const ids = built.pure.plugins.map((row) => row.id);
  assert.ok(ids.includes('persona'), 'persona row must survive a skipped validation');
  assert.ok(ids.includes('tool-executor-ptc'), 'every snapshot row must survive');
})

test('presetList publishes only the router preset, as a one-element array', () => {
  // The publisher refuses anything that is not a non-empty array (handing it
  // the {pure, router} object surfaced as PRESET_BUILD_FAILED), and the pure
  // copy is not published: the official PTC already occupies that card.
  const list = presetList(buildDelegationPresets(null, 'linux', { resolve: stubResolve }));
  assert.equal(Array.isArray(list), true);
  assert.deepEqual(list.map((preset) => preset.id), [ROUTER_PRESET_ID]);
})
