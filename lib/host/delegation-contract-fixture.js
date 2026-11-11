import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire, registerHooks, stripTypeScriptTypes } from 'node:module';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Pinned DSH runtime version this suite contracts against (repinned 2026-11-10 from 0.2.1-rc.5). */
export const CONTRACT_RUNTIME_VERSION = '0.2.2-rc.1';
/** @deprecated Historic name kept for the sibling host suite; always equals CONTRACT_RUNTIME_VERSION. */
export const RC5_VERSION = CONTRACT_RUNTIME_VERSION;
export const FIXTURE_PROVIDER = 'contract-deterministic';
export const FIXTURE_MODEL = 'contract-model';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Resolve the inputs the contract suite cannot guess: the installed runtime, a task-local
 * scratch root, the harness checkout, and the approved client dependency anchor. An explicit
 * `DSH_CONTRACT_*` environment variable always wins; the defaults below only save the caller
 * from spelling them out (see scripts/run-contract-tests.mjs and `npm run test:contract`).
 * @param env - environment to read (defaults to process.env).
 * @returns absolute paths for the fixture and the client gate.
 */
export function resolveContractEnvironment(env = process.env) {
  const runtimeRoot = env.DSH_CONTRACT_RUNTIME_ROOT ?? detectInstalledRuntime(env);
  if (runtimeRoot === undefined) {
    throw new Error('contract suite: cannot locate the installed @deepseek-ai/dsh — set DSH_CONTRACT_RUNTIME_ROOT');
  }
  const scratchRoot = resolve(env.DSH_CONTRACT_SCRATCH_ROOT ?? join(REPO_ROOT, '.dsh-tmp', 'contract'));
  const sourceRoot = resolve(env.DSH_CONTRACT_CLIENT_SOURCE_ROOT ?? join(REPO_ROOT, '..', 'deepseek-harness'));
  if (!existsSync(join(sourceRoot, 'packages', 'client', 'store', 'src', 'index.ts'))) {
    throw new Error(`contract suite: client store source not found under ${sourceRoot} — set DSH_CONTRACT_CLIENT_SOURCE_ROOT`);
  }
  const clientDepsManifest = resolve(env.DSH_CONTRACT_CLIENT_DEPS
    ?? join(REPO_ROOT, '.dsh-tmp', 'ptc-brain-delegation', 'task-1', 'client-deps', 'package.json'));
  if (!existsSync(join(dirname(clientDepsManifest), 'node_modules', 'zustand'))) {
    throw new Error(`contract suite: client dependency anchor not found at ${clientDepsManifest} — set DSH_CONTRACT_CLIENT_DEPS`);
  }
  return { runtimeRoot, scratchRoot, tempRoot: join(scratchRoot, 'tmp'), sourceRoot, clientDepsManifest };
}

function detectInstalledRuntime(env) {
  const candidates = [];
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    candidates.push(join(globalRoot, '@deepseek-ai', 'dsh'));
  } catch {
    // npm is unavailable in this shell; the well-known installation locations still apply.
  }
  if (env.APPDATA) candidates.push(join(env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh'));
  candidates.push(join(dirname(process.execPath), 'node_modules', '@deepseek-ai', 'dsh'));
  return candidates.find((candidate) => existsSync(join(candidate, 'package.json')));
}

/**
 * Export the resolved contract environment into `env` and create its confined directories.
 * The fixture asserts TEMP/TMP/TMPDIR already equal `<scratch>/tmp`, so this must run before
 * any fixture is created (the suite calls it at module load).
 * @param env - environment to mutate (defaults to process.env).
 * @returns the resolved absolute paths.
 */
export function applyContractEnvironment(env = process.env) {
  const resolved = resolveContractEnvironment(env);
  const npmCacheRoot = join(resolved.scratchRoot, 'npm-cache');
  for (const directory of [resolved.tempRoot, npmCacheRoot, join(resolved.scratchRoot, 'dsh-home')]) {
    mkdirSync(directory, { recursive: true });
  }
  Object.assign(env, {
    TEMP: resolved.tempRoot, TMP: resolved.tempRoot, TMPDIR: resolved.tempRoot,
    NPM_CONFIG_CACHE: npmCacheRoot, DSH_HOME: join(resolved.scratchRoot, 'dsh-home'),
    DSH_CONTRACT_RUNTIME_ROOT: resolved.runtimeRoot, DSH_CONTRACT_SCRATCH_ROOT: resolved.scratchRoot,
    DSH_CONTRACT_CLIENT_SOURCE_ROOT: resolved.sourceRoot, DSH_CONTRACT_CLIENT_DEPS: resolved.clientDepsManifest,
  });
  return resolved;
}

/** Resolve only declared package exports under an explicitly supplied pinned installation. */
export async function loadContractRuntime(runtimeRoot) {
  assert.ok(typeof runtimeRoot === 'string' && isAbsolute(runtimeRoot), 'runtimeRoot must explicitly name an absolute pinned installation');
  const root = await realpath(runtimeRoot);
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@deepseek-ai/dsh');
  assert.equal(manifest.version, CONTRACT_RUNTIME_VERSION, `contract fixture requires the actual ${CONTRACT_RUNTIME_VERSION} runtime`);
  const require = createRequire(join(root, 'package.json'));
  const imported = new Map();
  async function load(name, subpath = '.') {
    const key = `${name}#${subpath}`;
    if (!imported.has(key)) {
      const pkg = JSON.parse(await readFile(require.resolve(`${name}/package.json`), 'utf8'));
      if (name.startsWith('@deepseek-ai/dsh-')) assert.equal(pkg.version, CONTRACT_RUNTIME_VERSION, `${name} must match ${CONTRACT_RUNTIME_VERSION}`);
      assert.ok(subpath === '.' || Object.hasOwn(pkg.exports ?? {}, subpath), `${name} must declare public export ${subpath}`);
      const specifier = subpath === '.' ? name : `${name}/${subpath.slice(2)}`;
      imported.set(key, await import(pathToFileURL(require.resolve(specifier)).href));
    }
    return imported.get(key);
  }
  return { version: manifest.version, root, load };
}

function assertConfined(root, path) {
  const rel = relative(root, path);
  assert.ok(rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), `fixture path must remain under scratchRoot: ${path}`);
}

/** Select PTC execution in one Agent's scope (0.2.2 replaced `tools.presentAs('ptc')`). */
export async function presentAgentAsPtc(fixture, agent) {
  const mod = await fixture.runtime.load('@deepseek-ai/dsh-tool-executor-ptc');
  const fiber = agent.ctx.plugin(mod.default ?? mod, { maxParallelSubCalls: 1 });
  await fiber.await();
  assert.equal(fiber.state, 2, 'the PTC tool executor must activate in the agent scope');
  return fiber;
}

/** Real registry, loop, tool bridge, PTC provider and JSONL session persistence; no live profile. */
export async function createContractFixture({ runtimeRoot, scratchRoot }) {
  assert.ok(typeof scratchRoot === 'string' && isAbsolute(scratchRoot), 'scratchRoot must be an explicit absolute directory');
  const scratch = resolve(scratchRoot);
  const temp = resolve(join(scratch, 'tmp'));
  assert.equal(resolve(tmpdir()), temp, 'set TEMP/TMP/TMPDIR before starting the contract process');
  for (const key of ['TEMP', 'TMP', 'TMPDIR']) assert.equal(resolve(process.env[key]), temp, `${key} must be task-local`);
  assert.equal(resolve(process.env.NPM_CONFIG_CACHE), resolve(join(scratch, 'npm-cache')));
  await mkdir(temp, { recursive: true });
  const workdir = await mkdtemp(join(temp, 'contract-'));
  assertConfined(scratch, workdir);
  const runtime = await loadContractRuntime(runtimeRoot);
  const cordis = await runtime.load('@deepseek-ai/cordis');
  const llm = await runtime.load('@deepseek-ai/dsh-llm');
  const ctx = new cordis.Context();
  const fibers = [];
  const handles = [];
  let disposed = false;
  const requests = [];
  const scripts = new Map();

  class DeterministicAdapter extends llm.LlmAdapter {
    providerInfo(provider) { return { id: provider, name: 'Contract deterministic adapter' }; }
    async listModels(provider) { return [{ provider, id: FIXTURE_MODEL, name: 'Contract model' }]; }
    async resolveModel(provider, model) {
      assert.equal(provider, FIXTURE_PROVIDER);
      assert.equal(model, FIXTURE_MODEL);
      return {
        provider, id: model, name: 'Contract model', inputModalities: ['text'],
        context: { contextWindow: 4096 }, defaultMaxTokens: 128,
        reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }], defaultEffort: 'medium' },
      };
    }
    async *stream(options) {
      requests.push(structuredClone({ provider: options.provider, model: options.model, sessionId: options.sessionId, reasoningEffort: options.reasoningEffort }));
      assert.equal(options.provider, FIXTURE_PROVIDER, 'no other provider may be called');
      const pending = scripts.get(options.sessionId) ?? [];
      const chunks = pending.shift();
      assert.ok(chunks, `no deterministic stream queued for ${options.sessionId}`);
      for (const chunk of chunks) yield chunk;
    }
  }
  const adapter = new DeterministicAdapter();

  async function mount(name, config) {
    const mod = await runtime.load(name);
    const fiber = ctx.plugin(mod.default ?? mod, config);
    fibers.push(fiber);
    await fiber.await();
    assert.equal(fiber.state, 2, `${name} must become ACTIVE`);
    return fiber;
  }
  async function dispose() {
    if (disposed) return;
    disposed = true;
    const errors = [];
    for (const handle of handles.toReversed()) {
      try { await handle.dispose(); } catch (error) { errors.push(error); }
    }
    for (const fiber of fibers.toReversed()) {
      try { await fiber.dispose(); } catch (error) { errors.push(error); }
    }
    try { await ctx.fiber.dispose(); } catch (error) { errors.push(error); }
    await rm(workdir, { recursive: true, force: true });
    if (errors.length) throw new AggregateError(errors, 'contract fixture teardown failed');
  }

  try {
    await mount('@deepseek-ai/dsh-llm');
    ctx.llm.registerAdapter([FIXTURE_PROVIDER], adapter);
    await mount('@deepseek-ai/dsh-system-prompt');
    await mount('@deepseek-ai/dsh-session');
    await mount('@deepseek-ai/dsh-session-projection');
    await mount('@deepseek-ai/dsh-agent');
    // 0.2.2 removed the `mode` registry option; execution is selected by a dedicated executor
    // plugin (packages/core/tools/src/index.ts: `mode: z.never()`).
    await mount('@deepseek-ai/dsh-tools');
    await mount('@deepseek-ai/dsh-tool-executor-native');
    await mount('@deepseek-ai/dsh-user-approval', { policy: 'ask' });
    await mount('@deepseek-ai/dsh-fs-local');
    await mount('@deepseek-ai/dsh-subprocess-local');
    await mount('@deepseek-ai/dsh-sandbox-local');
    await mount('@deepseek-ai/dsh-sandbox-policy', { mode: 'workspace-write', workspaceRoot: workdir });
    await mount('@deepseek-ai/dsh-working-directory', { defaultDirectory: workdir });
    await mount('@deepseek-ai/dsh-ptc-runtime-node', { executionMode: 'per-call', timeoutMs: 10000, maxTimeoutMs: 10000 });
    await mount('@deepseek-ai/dsh-session-persistence-jsonl', { root: join(workdir, 'sessions') });
    await mount('@deepseek-ai/dsh-session-query');
    await mount('@deepseek-ai/dsh-agent-loop', { agents: [], maxParallelToolCalls: 1 });
    const subagentFiber = await mount('@deepseek-ai/dsh-subagent', { maxDepth: 1, maxActiveSubagents: 8 });
    await mount('@deepseek-ai/dsh-subagent-spawn-in-process', { providerName: 'spawn' });
    return {
      ctx, runtime, workdir, scratchRoot: scratch, adapter, requests, mount, dispose,
      async drainSubagents() { await subagentFiber.dispose(); },
      queueStream(sessionId, chunks) {
        const queue = scripts.get(sessionId) ?? [];
        queue.push(chunks);
        scripts.set(sessionId, queue);
      },
      async createAgent(sessionId, setup) {
        const handle = await ctx.agents.create({
          sessionId,
          meta: { cwd: workdir },
          agentOptions: { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL },
          setup,
        });
        handles.push(handle);
        return handle.agent;
      },
      async retireAgent(agent) {
        const handle = handles.find((owned) => owned.agent === agent);
        assert.ok(handle, 'only a fixture-owned Agent handle may be retired');
        await handle.dispose();
      },
    };
  } catch (error) {
    try { await dispose(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'fixture prerequisite and cleanup failed'); }
    throw error;
  }
}

export function textStream(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
}

export function toolStream(callId, name, args) {
  const argumentsText = JSON.stringify(args);
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: argumentsText },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: argumentsText } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ];
}

/** Test-only Include composition: the real ConfigEditor/Settings namespace stays authoritative. */
export async function createConfigurationOwners(fixture, configurations, onApply) {
  const { ctx, runtime, workdir } = fixture;
  const profileDir = join(workdir, 'profile');
  const home = join(workdir, 'home');
  assertConfined(fixture.scratchRoot, profileDir);
  assertConfined(fixture.scratchRoot, home);
  await mkdir(profileDir, { recursive: true });
  await mkdir(home, { recursive: true });
  const appBoot = await runtime.load('@deepseek-ai/dsh-app-boot');
  const baseConfigPath = join(profileDir, 'contract-base.json');
  const patchPath = join(profileDir, appBoot.PROFILE_PATCH_FILENAME);
  const patches = [{ insert: configurations.map(({ id, route }) => ({
    id, name: 'cordis:contract-owner', config: { route },
  })) }];
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: [] } } }), 'utf8');
  await writeFile(baseConfigPath, '[]\n', 'utf8');
  await writeFile(patchPath, JSON.stringify(patches), 'utf8');
  ctx.provide('profileContext', {
    name: 'contract-profile', dir: profileDir, patchPath,
    installAnchor: join(runtime.root, 'package.json'), cwd: workdir, home,
    startedBundles: [], overlays: [], telemetryDisabledEnv: '1',
  });
  await fixture.mount('@deepseek-ai/cordis-plugin-loader', { baseUrl: `${pathToFileURL(workdir).href}/` });
  await fixture.mount('@deepseek-ai/dsh-config-editor');
  await fixture.mount('@deepseek-ai/dsh-settings');
  const { default: z } = await runtime.load('@deepseek-ai/schemastery');
  const owners = new Map();
  ctx.loader.builtins['contract-owner'] = {
    name: 'contract-owner',
    inject: ['loader', 'settings'],
    Config: z.object({ route: z.object({
      provider: z.string().required(), model: z.string().required(), reasoningEffort: z.string().required(),
    }).volatile() }),
    apply(ownerCtx, config) {
      const entry = ownerCtx.fiber.entry;
      assert.ok(entry, 'a contract owner must be a real Loader entry');
      const owner = { ctx: ownerCtx, entry, config, cachedRoute: config.route.get(), reads: 0 };
      owner.reread = () => {
        owner.cachedRoute = config.route.get();
        owner.reads += 1;
      };
      owners.set(entry.options.id, owner);
      ownerCtx.effect(() => ownerCtx.settings.configure({ auto: false }));
      onApply?.(owner);
    },
  };
  const include = await appBoot.mountRootInclude(ctx, baseConfigPath, patches);
  assert.ok(include, 'the real app-boot root Include must load');
  await include.fiber.await();
  for (const { id } of configurations) {
    const owner = owners.get(id);
    assert.ok(owner, `real Include owner ${id} must initialize`);
    assert.equal(owner.entry.fiber.state, 2);
    assert.ok(ctx.configEditor.entries().includes(owner.entry), 'ConfigEditor must locate the actual unique Include row');
    assert.ok(ctx.settings.describe().some((row) => row.ns === owner.entry.options.id));
  }
  return { owners, include, profileDir };
}

/** Re-read only the owning fiber's committed volatile references. */
export function bindOwningVolatileReread(ownerCtx, reread) {
  return ownerCtx.on('loader/volatile-update', () => reread());
}

/** Defer health past apply, await only the owner lifecycle, and cancel on unload. */
export function schedulePostLoadHealth(ownerCtx, check) {
  return ownerCtx.effect(() => {
    let canceled = false;
    void Promise.resolve().then(() => ownerCtx.fiber.await()).then(() => {
      if (!canceled) return check();
    });
    return () => { canceled = true; };
  });
}

/** Native calls and generated SDK dispatches share this real scoped guard. */
export function bindScopedGuard(agent, guard) {
  return agent.ctx.tools.guard(guard);
}

/** The real pipeline owns approval prompting, call identity, audit and never policy. */
export function bindApprovalGate(agent, toolName, reason) {
  return agent.ctx.on('tools/pre-execute', (exec, next) => {
    if (exec.name !== toolName) return next();
    return { kind: 'ask', reason };
  });
}

/** Preserve the real canonical activation and append only the controller-approved receipt. */
export function bindActivationReceipt(agent, toolName, declaredRoute) {
  const route = {
    provider: declaredRoute.provider, model: declaredRoute.model,
    ...(declaredRoute.reasoningEffort === undefined ? {} : { reasoningEffort: declaredRoute.reasoningEffort }),
  };
  return agent.ctx.on('tools/execute', async (exec, next) => {
    const result = await next();
    if (exec.name !== toolName || result.isError || result.value?.kind !== 'activation'
      || typeof result.value.subagentId !== 'string' || result.value.subagentId.length === 0) return result;
    if (result.meta !== undefined && (result.meta === null || typeof result.meta !== 'object' || Array.isArray(result.meta))) return result;
    if (result.meta !== undefined && Object.hasOwn(result.meta, 'cleanDesktopDelegation')) return result;
    return {
      ...result,
      meta: {
        ...result.meta,
        cleanDesktopDelegation: {
          schema: 'clean-desktop-shell.delegation.activation.v1', kind: 'activation',
          subagentId: result.value.subagentId, declaredRoute: route,
          callId: exec.callId, rootCallId: exec.rootCallId ?? exec.callId,
        },
      },
    };
  });
}

export function mutationTool(onExecute) {
  return {
    name: 'contract_protected_action', description: 'Run the isolated fixture action',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', properties: { performed: { type: 'boolean' } }, required: ['performed'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute() { onExecute(); return { performed: true }; },
  };
}

/** Drive an identified fixture message through the real loop, then read only that Session. */
export const RECEIPT_SCHEMA = 'dsh-clean-desktop-shell/worker-route-receipt@1';
export const RECEIPT_PREFIX = `[${RECEIPT_SCHEMA}] `;
export const RECEIPT_LIMITS = Object.freeze({
  idCodeUnits: 256, providerCodeUnits: 512, modelCodeUnits: 1024,
  effortCodeUnits: 64, envelopeUtf8Bytes: 16384,
});

function plainStrictObject(value, required, optional = []) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function boundedText(value, maxCodeUnits) {
  return typeof value === 'string' && value.length >= 1 && value.length <= maxCodeUnits;
}

function validDeclaredReceipt(receipt, limits) {
  if (!limits || !plainStrictObject(receipt, ['schema', 'parentSessionId', 'callId', 'rootCallId', 'toolName', 'childSessionId', 'declared', 'actual'])) return false;
  if (receipt.schema !== RECEIPT_SCHEMA || receipt.toolName !== 'subagent') return false;
  if (!['parentSessionId', 'callId', 'rootCallId', 'childSessionId'].every((key) => boundedText(receipt[key], limits.idCodeUnits))) return false;
  if (!plainStrictObject(receipt.declared, ['source', 'provider', 'model'], ['reasoningEffort'])
    || receipt.declared.source !== 'bound-stock-agent-options'
    || !boundedText(receipt.declared.provider, limits.providerCodeUnits)
    || !boundedText(receipt.declared.model, limits.modelCodeUnits)) return false;
  if (Object.hasOwn(receipt.declared, 'reasoningEffort') && !boundedText(receipt.declared.reasoningEffort, limits.effortCodeUnits)) return false;
  return plainStrictObject(receipt.actual, ['status']) && receipt.actual.status === 'not-established-by-receipt';
}

/** Only the approved post-decision content field changes; Core retains value/isError/meta. */
export function bindActivationContentReceipt(agent, stockDefinition, agentOptionsSnapshot, limits) {
  const ordinaryFrozenSnapshot = agentOptionsSnapshot !== null && typeof agentOptionsSnapshot === 'object'
    && !Array.isArray(agentOptionsSnapshot) && Object.isFrozen(agentOptionsSnapshot);
  const declared = Object.freeze({
    source: 'bound-stock-agent-options', provider: agentOptionsSnapshot?.provider, model: agentOptionsSnapshot?.model,
    ...(agentOptionsSnapshot?.reasoningEffort === undefined ? {} : { reasoningEffort: agentOptionsSnapshot.reasoningEffort }),
  });
  return agent.ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next();
    if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value') || result.isError
      || !ordinaryFrozenSnapshot || !exec.agent || exec.agent.id !== agent.id || exec.name !== 'subagent'
      || stockDefinition?.name !== 'subagent' || agent.ctx.tools.get(exec.name, exec.agent) !== stockDefinition
      || !plainStrictObject(result.value, ['kind', 'subagentId']) || result.value.kind !== 'activation') return decision;
    const receipt = {
      schema: RECEIPT_SCHEMA, parentSessionId: exec.agent.id, callId: exec.callId,
      rootCallId: exec.rootCallId, toolName: 'subagent', childSessionId: result.value.subagentId,
      declared, actual: { status: 'not-established-by-receipt' },
    };
    if (!validDeclaredReceipt(receipt, limits)) return decision;
    const text = RECEIPT_PREFIX + JSON.stringify(receipt);
    if (Buffer.byteLength(text, 'utf8') > limits.envelopeUtf8Bytes) return decision;
    const kept = decision.content ?? result.content;
    if (!Array.isArray(kept)) return decision;
    return { ...decision, content: [...kept, { type: 'text', text }] };
  });
}

/** Parse only a unique final successful stock event, never user text or outer program output. */
export function readActivationContentReceipt(snapshot, event, limits) {
  if (!snapshot?.session || !Array.isArray(snapshot.events) || !event?.data || !limits) return null;
  let content;
  let callId;
  let rootCallId;
  if (event.type === 'tool/result') {
    const message = event.data.message;
    if (event.surfaceOp !== 'append' || message?.source?.kind !== 'tool' || message.isError !== false
      || !Array.isArray(event.sourceEventSeqs)) return null;
    const calls = snapshot.events.filter((item) => item.type === 'tool/call' && item.data.callId === message.toolCallId
      && event.sourceEventSeqs.includes(item.seq) && item.seq < event.seq);
    if (calls.length !== 1 || calls[0].data.name !== 'subagent') return null;
    callId = calls[0].data.callId;
    rootCallId = callId;
    content = message.content;
  } else if (event.type === 'tool/ptc-dispatch') {
    const data = event.data;
    if (data.isError !== false || data.name !== 'subagent' || event.surfaceOp !== undefined) return null;
    const starts = snapshot.events.filter((item) => item.type === 'tool/ptc-dispatch-start'
      && item.data.subCallId === data.subCallId && item.seq < event.seq);
    if (starts.length !== 1 || !['rootCallId', 'parentCallId', 'subCallId', 'name'].every((key) => starts[0].data[key] === data[key])
      || JSON.stringify(starts[0].data.arguments) !== JSON.stringify(data.arguments)) return null;
    const outer = snapshot.events.filter((item) => item.type === 'tool/call' && item.data.name === 'run_code'
      && item.data.callId === data.parentCallId && item.seq < starts[0].seq);
    if (outer.length !== 1 || outer[0].data.callId !== data.rootCallId) return null;
    callId = data.subCallId;
    rootCallId = data.rootCallId;
    content = data.content;
  } else return null;
  if (!Array.isArray(content)) return null;
  const envelopes = content.filter((block) => block?.type === 'text' && typeof block.text === 'string' && block.text.startsWith(RECEIPT_PREFIX));
  if (envelopes.length !== 1 || Buffer.byteLength(envelopes[0].text, 'utf8') > limits.envelopeUtf8Bytes) return null;
  let receipt;
  try { receipt = JSON.parse(envelopes[0].text.slice(RECEIPT_PREFIX.length)); } catch { return null; }
  if (!validDeclaredReceipt(receipt, limits) || envelopes[0].text !== RECEIPT_PREFIX + JSON.stringify(receipt)
    || receipt.parentSessionId !== snapshot.session.id || receipt.callId !== callId || receipt.rootCallId !== rootCallId) return null;
  return receipt;
}

/** Actual evidence is independent; a declaration alone never establishes a child route. */
export async function proveActivationContentReceipt(snapshot, event, childSnapshot, requests, limits, resolveCallConfig) {
  const receipt = readActivationContentReceipt(snapshot, event, limits);
  const header = childSnapshot?.session;
  if (!receipt || !header || header.id !== receipt.childSessionId || header.parentSession !== receipt.parentSessionId
    || header.origin !== 'subagent' || !Array.isArray(requests)) return null;
  const actual = requests.filter((request) => request.sessionId === receipt.childSessionId);
  if (actual.length !== 1) return null;
  let resolved;
  try {
    resolved = await resolveCallConfig({
      provider: receipt.declared.provider, model: receipt.declared.model,
      ...(receipt.declared.reasoningEffort === undefined ? {} : { reasoningEffort: receipt.declared.reasoningEffort }),
    });
  } catch { return null; }
  if (resolved.provider !== receipt.declared.provider || resolved.model !== receipt.declared.model
    || actual[0].provider !== resolved.provider || actual[0].model !== resolved.model
    || actual[0].reasoningEffort !== resolved.reasoningEffort) return null;
  return receipt;
}

export function parseRemoteId(protocol, field, value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new protocol.RemoteError('gateway/bad-request', 'delegation: invalid named input', {
      issues: [{ field, message: 'expected a non-empty string' }],
    });
  }
  return value;
}

/** Exact standard-decorator context from the controller's public SRC binding. */
export function markPublicRemoteMethods(protocol, instance, methods, streamMethod) {
  for (const name of methods) {
    const decorator = name === streamMethod ? protocol.Remote({ mode: 'stream' }) : protocol.Remote;
    decorator(instance[name], {
      kind: 'method', name, static: false, private: false,
      access: { has: (object) => name in object, get: (object) => object[name] },
      metadata: {}, addInitializer(initializer) { initializer.call(instance); },
    });
  }
}

/** Public structural descriptor only; no fabricated compiler metadata. */
export function strictRemoteDescriptor(namespace, method, fields = [], stream = false) {
  const packageName = 'dsh-clean-desktop-shell';
  const codec = {
    mode: 'strict', typeSymbol: 'dsh-clean-desktop-shell:nonempty-string:v1',
    create: () => ({ parse(value) {
      if (typeof value !== 'string' || value.length === 0) throw new TypeError('delegation: expected a non-empty id');
      return value;
    } }),
    jsonSchema: { type: 'string', minLength: 1 },
  };
  return {
    id: `${packageName}#${namespace}/${method}`, service: namespace, namespace, method,
    invocation: { kind: 'direct' },
    parameters: fields.map((name) => ({ name, wire: name, source: 'json', codec })),
    cancellation: { parameter: 'signal' }, result: { mode: 'src-json' },
    ...(stream ? { mode: 'stream' } : {}),
  };
}

/** Real Host Gateway, Peer, Client Registry/Connection/Remote; only carrier I/O is in-process. */
export async function createNodeRemoteFixture(fixture) {
  const { runtime } = fixture;
  const cordis = await runtime.load('@deepseek-ai/cordis');
  const protocol = await runtime.load('@deepseek-ai/dsh-typert-protocol');
  const peerModule = await runtime.load('@deepseek-ai/dsh-client-connection');
  const connectionClient = await runtime.load('@deepseek-ai/dsh-client-connection', './client');
  await fixture.mount('@deepseek-ai/dsh-typert-registry');
  await fixture.mount('@deepseek-ai/dsh-api-remote-access');
  await fixture.mount('@deepseek-ai/dsh-api-gateway', {});
  const gateway = fixture.ctx.typertGateway;
  const peer = new peerModule.Peer(fixture.ctx, { principal: { kind: 'owner' }, interactions: 'none' });
  const clientCtx = new cordis.Context();
  fixture.ctx.effect(() => async () => { await clientCtx.fiber.dispose(); await peer.dispose(); });
  const traffic = [];
  const rpc = {
    async call(channel, endpoint, payload, signal) {
      assert.equal(channel, '/api');
      const [namespace, method] = endpoint.split('/');
      const args = JSON.parse(JSON.stringify(payload.args));
      traffic.push({ kind: 'call', endpoint, args });
      try {
        const value = await gateway.invoke({ namespace, method, args, peer, signal });
        return { ok: true, value: JSON.parse(JSON.stringify(value)) };
      } catch (error) {
        return { ok: false, error: gateway.wireStream.failure(error) };
      }
    },
    async *open(channel, endpoint, payload, signal, uplink) {
      assert.equal(channel, '/api');
      traffic.push({ kind: 'stream', endpoint, args: JSON.parse(JSON.stringify(payload.args)) });
      yield* await gateway.wireStream.open(endpoint, payload, uplink ?? (async function* () {})(), peer, signal);
    },
  };
  const registryFiber = clientCtx.plugin(await runtime.load('@deepseek-ai/dsh-typert-registry', './client'));
  await registryFiber.await();
  const connectionFiber = clientCtx.plugin({ name: 'contract-node-connection', apply(ctx) {
    connectionClient.installConnection(ctx, { interactions: 'none', transport: { rpc } });
  } });
  await connectionFiber.await();
  const remoteFiber = clientCtx.plugin(await runtime.load('@deepseek-ai/dsh-api-gateway', './client'));
  await remoteFiber.await();
  assert.equal(registryFiber.state, 2);
  assert.equal(connectionFiber.state, 2);
  assert.equal(remoteFiber.state, 2);
  return {
    protocol, gateway, peer, clientCtx, traffic,
    async mountClient(contribution) {
      const fiber = clientCtx.plugin({ name: 'contract-node-remote-producer', inject: ['remote'], async apply(ctx) {
        await ctx.remote.$mount(contribution);
      } });
      await fiber.await();
      let scope;
      const namespaces = [...new Set(contribution.descriptors.map((descriptor) => `remote.${descriptor.namespace}`))];
      const consumerFiber = clientCtx.plugin({
        name: 'contract-node-remote-consumer', inject: ['remote', ...namespaces],
        apply(ctx) { scope = ctx; },
      });
      await consumerFiber.await();
      return { ctx: scope, fiber, consumerFiber };
    },
  };
}

export async function driveTool(fixture, agent, callId, name, args) {
  fixture.queueStream(agent.id, toolStream(callId, name, args));
  fixture.queueStream(agent.id, textStream('contract turn complete'));
  agent.followup({
    id: `${callId}:input`, role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: 'Run the isolated contract action.' }],
  });
  await agent.whenIdle();
  return fixture.ctx.sessionQuery.readSession(agent.id);
}

// ---------------------------------------------------------------------------
// Client gate (append-only): pinned public ClientStore source seed, real browser
// bundle registration capture, real production ConfigForms provision, and real
// Settings CAS through the actual Client Remote -> Host settingsController path.
//
// The frozen Host ports above are untouched. Everything here takes explicit
// absolute parameters (installed runtime, checker-out source root, the approved
// .dsh-tmp dependency anchor) and writes only under scratchRoot.
// ---------------------------------------------------------------------------

/** Pinned public client-store entry bytes (unchanged between dsh-v0.2.1-rc.5 and dsh-v0.2.2-rc.1 / 66491b05e3). */
export const CLIENT_STORE_SOURCE_SHA = '6969ed123830868c44d90b664cd40d81d4f6a8fd18245a695fdc3cca38c9da08';
/** Browser packages captured from the installed pinned runtime. */
export const CLIENT_GATE_BUNDLES = Object.freeze({
  modules: '@deepseek-ai/dsh-client-modules',
  uiSettings: '@deepseek-ai/dsh-client-ui-settings',
});

function confine(root, path) {
  const rel = relative(root, path);
  assert.ok(rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), `client gate path must stay under scratchRoot: ${path}`);
  return path;
}

/**
 * Resolve the four real externals under one explicit package anchor, then strip
 * ONLY types from the full pinned public entry and import its real namespace.
 * The artifact is written under scratchRoot and never rewrites store behavior.
 */
export async function loadPinnedClientStore({ sourceRoot, clientDepsManifest, scratchRoot }) {
  assert.ok([sourceRoot, clientDepsManifest, scratchRoot].every((value) => typeof value === 'string' && isAbsolute(value)),
    'client store seed needs explicit absolute sourceRoot, clientDepsManifest and scratchRoot');
  const scratch = resolve(scratchRoot);
  const entry = resolve(join(sourceRoot, 'packages/client/store/src/index.ts'));
  const sourceManifest = resolve(join(sourceRoot, 'packages/client/store/package.json'));
  const source = await readFile(entry, 'utf8');
  const sha = createHash('sha256').update(source).digest('hex');
  assert.equal(sha, CLIENT_STORE_SOURCE_SHA, 'the pinned public client-store source bytes must match');
  const manifest = JSON.parse(await readFile(sourceManifest, 'utf8'));
  assert.equal(manifest.name, '@deepseek-ai/dsh-client-store');
  assert.equal(manifest.version, CONTRACT_RUNTIME_VERSION);
  assert.ok(Object.hasOwn(manifest.exports, './src/*'), 'the public /src/* export must stay declared');
  assert.equal(manifest.devDependencies.zustand, '~4.5.7');
  assert.equal(manifest.devDependencies.immer, '^10.1.1');

  const anchor = JSON.parse(await readFile(clientDepsManifest, 'utf8'));
  const anchorRoot = resolve(clientDepsManifest, '..');
  const anchorVersions = anchor.dependencies ?? {};
  assert.equal(anchorVersions.zustand, '4.5.7');
  assert.equal(anchorVersions.immer, '10.1.1');
  const require = createRequire(clientDepsManifest);
  const resolved = new Map();
  const dependencies = [];
  for (const specifier of ['zustand/vanilla', 'zustand/middleware', 'zustand/shallow', 'immer']) {
    const packageName = specifier.split('/')[0];
    const location = require.resolve(specifier);
    assert.ok(resolve(location).startsWith(anchorRoot), `${specifier} must resolve inside the approved anchor`);
    const packageJson = require.resolve(`${packageName}/package.json`);
    const pkg = JSON.parse(await readFile(packageJson, 'utf8'));
    const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(pkg.version);
    assert.ok(parts, `${packageName}: unsupported version format`);
    const [, major, minor, patch] = parts.map(Number);
    if (packageName === 'zustand') assert.ok(major === 4 && minor === 5 && patch >= 7, 'zustand must satisfy ~4.5.7');
    else assert.ok(major === 10 && (minor > 1 || (minor === 1 && patch >= 1)), 'immer must satisfy ^10.1.1');
    resolved.set(specifier, location);
    dependencies.push({ specifier, location, version: pkg.version });
  }
  const zustandPkg = JSON.parse(await readFile(require.resolve('zustand/package.json'), 'utf8'));
  const transitive = [];
  for (const name of Object.keys(zustandPkg.dependencies ?? {})) {
    const location = require.resolve(`${name}/package.json`);
    transitive.push({ name, location, version: JSON.parse(await readFile(location, 'utf8')).version });
  }
  assert.deepEqual(transitive.map((row) => row.name), ['use-sync-external-store']);

  const artifact = confine(scratch, resolve(join(scratch, 'client-store-seed.mjs')));
  await mkdir(scratch, { recursive: true });
  const stripped = stripTypeScriptTypes(source, { mode: 'strip' });
  await writeFile(artifact, stripped, 'utf8');
  const artifactSha = createHash('sha256').update(stripped).digest('hex');
  for (const needle of ["from 'zustand/vanilla'", "from 'zustand/middleware'", "from 'zustand/shallow'", "from 'immer'",
    'export function createSnapshotStore', 'api.setState(produce(', 'export function defineStore']) {
    assert.ok(stripped.includes(needle), `type erasure must preserve ${needle}`);
  }

  const artifactUrl = pathToFileURL(artifact).href;
  const anchorUrl = pathToFileURL(resolve(clientDepsManifest)).href;
  const imported = new Map();
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL === artifactUrl && resolved.has(specifier)) {
        const resolution = nextResolve(specifier, { ...context, parentURL: anchorUrl });
        imported.set(specifier, resolution.url);
        return resolution;
      }
      return nextResolve(specifier, context);
    },
  });
  let namespace;
  try {
    namespace = await import(artifactUrl);
  } finally {
    hook.deregister();
  }
  for (const name of ['createSnapshotStore', 'defineStore', 'notifySubscribers', 'shallowEqual']) {
    assert.equal(typeof namespace[name], 'function', `${name} must be a real public export`);
  }
  // Real zustand + immer behind the namespace: produce/freeze, subscribe, raf fallback.
  const store = namespace.createSnapshotStore({ value: 0, nested: { shard: 'a' } });
  let notifications = 0;
  const unsubscribe = store.subscribe(() => { notifications += 1; });
  store.update((draft) => { draft.value = 1; draft.nested.shard = 'b'; });
  assert.deepEqual(store.getSnapshot(), { value: 1, nested: { shard: 'b' } });
  assert.equal(notifications, 1);
  assert.ok(Object.isFrozen(store.getSnapshot()), 'immer produce must actually freeze the committed state');
  unsubscribe();
  store.set({ value: 2, nested: { shard: 'c' } });
  assert.equal(store.getSnapshot().value, 2);
  assert.equal(notifications, 1);
  assert.ok(Object.isFrozen(store.getSnapshot()), 'set() must freeze through the real immer freeze');
  return { namespace, entry, sha, manifestVersion: manifest.version, dependencies, transitive, imported: Object.fromEntries(imported), artifact, artifactSha };
}

/** Execute one browser bundle's raw bytes against a LOCAL window facade (never a global). */
async function captureClientBundle(bundlePath, facade) {
  const code = await readFile(bundlePath, 'utf8');
  const sha = createHash('sha256').update(code).digest('hex');
  const firstLine = code.split('\n', 1)[0];
  assert.equal(firstLine, 'window.__ModuleLoader__.load({', `${bundlePath} must be a classic ModuleLoader registration`);
  const id = /\n\tid: "([^"]+)",/.exec(code)?.[1];
  assert.ok(typeof id === 'string' && id.length > 0, `${bundlePath} must declare its registration id`);
  // The closure factory runs later with the module-table require; only the
  // registration statement executes here.
  new Function('window', code)(facade);
  return { id, path: bundlePath, sha, bytes: Buffer.byteLength(code, 'utf8'), firstLine };
}

/**
 * Capture the installed production classic registrations and build the real
 * module system. The facade mirrors the served HTML bootstrap exactly; only the
 * pending queue is live, and bundle transport refuses every implicit load.
 */
export async function createClientModuleSurface({ runtime, sourceRoot, clientDepsManifest, scratchRoot }) {
  const store = await loadPinnedClientStore({ sourceRoot, clientDepsManifest, scratchRoot });
  const cordis = await runtime.load('@deepseek-ai/cordis');
  const packageRoot = join(runtime.root, 'node_modules');
  const bundlePath = (name) => join(packageRoot, name, 'lib/client.js');
  const pendingQueue = [];
  const facade = {
    mode: 'queue',
    pendingQueue,
    load(registration) { pendingQueue.push(registration); },    create(options) {
      if (this.mode !== 'queue') throw new Error('client gate: create() called after module-system boot');
      const bootstrapId = CLIENT_GATE_BUNDLES.modules;
      const index = pendingQueue.findIndex((registration) => registration.id === bootstrapId);
      const registration = pendingQueue[index];
      if (registration === undefined) throw new Error(`client gate: no preloaded ${bootstrapId} registration`);
      pendingQueue.splice(index, 1);
      const exports = registration.factory((specifier) => {
        throw new Error(`client gate: bootstrap requested external ${specifier} before the module system existed`);
      });
      if (typeof exports?.createClientModuleSystem !== 'function' || typeof exports.apply !== 'function') {
        throw new Error('client gate: bootstrap bundle did not export the bootstrap module face');
      }
      return exports.createClientModuleSystem(this, { id: registration.id, exports }, options);
    },
  };
  // LOCAL window only: the classic registration must never see or need a global.
  const windowFacade = { __ModuleLoader__: facade };
  assert.equal(globalThis.window, undefined, 'the client gate must not install a global window');
  assert.equal(globalThis.__ModuleLoader__, undefined, 'the client gate must not install a global module loader');
  const captures = [await captureClientBundle(bundlePath(CLIENT_GATE_BUNDLES.modules), windowFacade)];
  captures.push(await captureClientBundle(bundlePath(CLIENT_GATE_BUNDLES.uiSettings), windowFacade));
  const staticModules = {
    '@deepseek-ai/cordis': cordis,
    '@deepseek-ai/dsh-client-store': store.namespace,
  };
  const modules = windowFacade.__ModuleLoader__.create({
    // Library-level composition only: this row set is not a profile roster.
    boot: { rev: 'contract-client-gate', release: { version: CONTRACT_RUNTIME_VERSION }, entries: [], batches: [] },
    staticModules,
    loadBundle: async (url) => { throw new Error(`client gate forbids implicit bundle load: ${url}`); },
  });
  const uiSettings = await modules.import(CLIENT_GATE_BUNDLES.uiSettings);
  assert.equal(typeof uiSettings.apply, 'function', 'the materialized ui-settings bundle must expose apply');
  assert.deepEqual(uiSettings.inject, ['remote', 'remote.settings']);
  assert.equal(uiSettings.apply.name, 'apply');
  return { modules, facade, store, uiSettings, captures, staticModules, pendingQueue };
}

/** Test-only Include composition with the product field shape (default `workerRoute`). */
export async function createSettingsNamespaceOwner(fixture, { id, field = 'workerRoute', value }) {
  const { ctx, runtime, workdir } = fixture;
  const profileDir = join(workdir, 'gate-profile');
  const home = join(workdir, 'gate-home');
  assertConfined(fixture.scratchRoot, profileDir);
  assertConfined(fixture.scratchRoot, home);
  await mkdir(profileDir, { recursive: true });
  await mkdir(home, { recursive: true });
  const appBoot = await runtime.load('@deepseek-ai/dsh-app-boot');
  const baseConfigPath = join(profileDir, 'gate-base.json');
  const patchPath = join(profileDir, appBoot.PROFILE_PATCH_FILENAME);
  const patches = [{ insert: [{ id, name: 'cordis:contract-gate-owner', config: { [field]: value } }] }];
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: [] } } }), 'utf8');
  await writeFile(baseConfigPath, '[]\n', 'utf8');
  await writeFile(patchPath, JSON.stringify(patches), 'utf8');
  ctx.provide('profileContext', {
    name: 'contract-gate-profile', dir: profileDir, patchPath,
    installAnchor: join(runtime.root, 'package.json'), cwd: workdir, home,
    startedBundles: [], overlays: [], telemetryDisabledEnv: '1',
  });
  await fixture.mount('@deepseek-ai/cordis-plugin-loader', { baseUrl: `${pathToFileURL(workdir).href}/` });
  await fixture.mount('@deepseek-ai/dsh-config-editor');
  await fixture.mount('@deepseek-ai/dsh-settings');
  const { default: z } = await runtime.load('@deepseek-ai/schemastery');
  const owners = new Map();
  ctx.loader.builtins['contract-gate-owner'] = {
    name: 'contract-gate-owner',
    inject: ['loader', 'settings'],
    Config: z.object({ [field]: z.object({
      provider: z.string().required(), model: z.string().required(), reasoningEffort: z.string().required(),
    }).volatile() }),
    apply(ownerCtx, config) {
      const entry = ownerCtx.fiber.entry;
      assert.ok(entry, 'a gate owner must be a real Loader entry');
      owners.set(entry.options.id, { ctx: ownerCtx, entry, config, field });
      ownerCtx.effect(() => ownerCtx.settings.configure({ auto: false }));
    },
  };
  const include = await appBoot.mountRootInclude(ctx, baseConfigPath, patches);
  assert.ok(include, 'the real app-boot root Include must load');
  await include.fiber.await();
  const owner = owners.get(id);
  assert.ok(owner, `real Include owner ${id} must initialize`);
  assert.equal(owner.entry.fiber.state, 2);
  assert.ok(ctx.configEditor.entries().includes(owner.entry), 'ConfigEditor must locate the actual unique Include row');
  return { owner, include, profileDir };
}

/**
 * Real Client Remote -> Host settingsController carrier. Same Gateway/Peer/
 * Registry/Connection/Remote classes as the frozen Node carrier, but the peer
 * and client declare `interactions: 'answer'` because forwarded Remote events
 * (which the real ui-settings provider subscribes to) are only legal on answer
 * peers. Only the in-process rpc I/O is test-owned.
 */
export async function createClientSettingsSurface(fixture, { id, field = 'workerRoute', initialValue, sourceRoot, clientDepsManifest }) {
  const { runtime } = fixture;
  const { owner } = await createSettingsNamespaceOwner(fixture, { id, field, value: initialValue });
  const ns = owner.entry.options.id;
  await fixture.mount('@deepseek-ai/dsh-typert-registry');
  await fixture.mount('@deepseek-ai/dsh-api-remote-access');
  await fixture.mount('@deepseek-ai/dsh-api-gateway', {});

  const controllerModule = await runtime.load('@deepseek-ai/dsh-api-settings-controller');
  const controllerFiber = fixture.ctx.plugin(controllerModule.default ?? controllerModule);
  await controllerFiber.await();
  assert.equal(controllerFiber.state, 2, 'the real Host settingsController must activate');
  const typert = await runtime.load('@deepseek-ai/dsh-api-settings-controller', './typert');
  const disposeTypert = fixture.ctx.typert.register(typert.TYPERT);
  fixture.ctx.effect(() => disposeTypert);
  await fixture.mount('@deepseek-ai/dsh-api-remotes');

  const gateway = fixture.ctx.typertGateway;
  const peerModule = await runtime.load('@deepseek-ai/dsh-client-connection');
  const connectionClient = await runtime.load('@deepseek-ai/dsh-client-connection', './client');
  const cordis = await runtime.load('@deepseek-ai/cordis');
  const peer = new peerModule.Peer(fixture.ctx, { principal: { kind: 'owner' }, interactions: 'answer' });
  const clientCtx = new cordis.Context();
  fixture.ctx.effect(() => async () => { await clientCtx.fiber.dispose(); await peer.dispose(); });

  const traffic = [];
  const rpc = {
    async call(channel, endpoint, payload, signal) {
      assert.equal(channel, '/api');
      const [namespace, method] = endpoint.split('/');
      const args = JSON.parse(JSON.stringify(payload.args));
      traffic.push({ kind: 'call', endpoint, args });
      try {
        const value = await gateway.invoke({ namespace, method, args, peer, signal });
        return { ok: true, value: JSON.parse(JSON.stringify(value)) };
      } catch (error) {
        return { ok: false, error: gateway.wireStream.failure(error) };
      }
    },
    async *open(channel, endpoint, payload, signal, uplink) {
      assert.equal(channel, '/api');
      traffic.push({ kind: 'stream', endpoint, args: JSON.parse(JSON.stringify(payload.args)) });
      yield* await gateway.wireStream.open(endpoint, payload, uplink ?? (async function* () {})(), peer, signal);
    },
  };
  const registryFiber = clientCtx.plugin(await runtime.load('@deepseek-ai/dsh-typert-registry', './client'));
  await registryFiber.await();
  const connectionFiber = clientCtx.plugin({ name: 'contract-gate-connection', apply(ctx) {
    connectionClient.installConnection(ctx, { interactions: 'answer', transport: { rpc } });
  } });
  await connectionFiber.await();
  const remoteFiber = clientCtx.plugin(await runtime.load('@deepseek-ai/dsh-api-gateway', './client'));
  await remoteFiber.await();
  assert.equal(registryFiber.state, 2);
  assert.equal(connectionFiber.state, 2);
  assert.equal(remoteFiber.state, 2);

  // The real generated settings client contribution, mounted through $mount.
  const remoteContribution = (await runtime.load('@deepseek-ai/dsh-api-settings-controller', './remote')).TYPERT_REMOTE;
  const mountFiber = clientCtx.plugin({ name: 'contract-gate-settings-remote', inject: ['remote'], async apply(ctx) {
    await ctx.remote.$mount(remoteContribution);
  } });
  await mountFiber.await();
  assert.equal(mountFiber.state, 2, 'the real generated settings Remote contribution must mount');

  const surface = await createClientModuleSurface({ runtime, sourceRoot, clientDepsManifest, scratchRoot: fixture.scratchRoot });
  const providerFiber = clientCtx.plugin({
    name: 'contract-gate-ui-settings', inject: surface.uiSettings.inject,
    apply: surface.uiSettings.apply,
  });
  await providerFiber.await();
  assert.equal(providerFiber.state, 2, 'the real ui-settings provider must activate');
  const configForms = clientCtx.get('configForms');
  assert.ok(configForms, 'the provider must expose its real ConfigForms service');
  assert.ok(clientCtx.get('settingsSchema'), 'the provider must expose its real schema service');
  return { owner, ns, gateway, peer, clientCtx, configForms, providerFiber, mountFiber, traffic, moduleSurface: surface };
}

// Historic export names retained for the sibling host suite (src/host/delegation.test.js);
// the contract suite uses the version-neutral names above.
/** @deprecated Use loadContractRuntime. */
export const loadRc5Runtime = loadContractRuntime;
/** @deprecated Use createContractFixture. */
export const createRc5Fixture = createContractFixture;
