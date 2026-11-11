/**
 * Independent Host side of the PTC delegation feature: one profile row owns the saved
 * `workerRoute`, publishes a fresh revision of the frozen preset definition, and exposes a
 * readonly Remote read namespace. It imports no client or Electron code, so an Electron
 * failure or an unstarted desktop shell cannot affect it.
 */
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import z from '@deepseek-ai/schemastery';
import { snapshotWorkerRoute } from './delegation-config.js';
import { ROUTER_PRESET_ID, buildDelegationPresets, presetList } from './delegation-preset.js';
import { createPresetPublisher } from './delegation-publisher.js';

/** Wire namespace of the readonly delegation bridge. */
export const READ_NAMESPACE = 'cleanDesktopDelegationRead';
/** Preset id published by this Host module; one id, one owner. */
export const PRESET_ID = ROUTER_PRESET_ID;
/** Five frozen readonly Remote methods. No save/write RPC is exported here. */
export const READ_METHODS = Object.freeze([
  'describeDelegation', 'listWorkerProviders', 'listWorkerModels', 'listWorkerEfforts', 'watchDelegation',
]);
/** Default bound of retained catalogue options. */
export const DEFAULT_CATALOG_LIMIT = 512;
/** Hard bound of retained catalogue options (the shared 4096 cap). */
export const MAX_CATALOG_LIMIT = 4096;

const BAD_INPUT = 'delegation: invalid named input';
const CANCELLED = 'delegation: request cancelled';
const UNAVAILABLE = 'delegation: worker catalogue is unavailable';
const NO_NAMESPACE = 'delegation/no-settings-namespace: the owning Loader entry is not an addressable profile row';

export const Config = z.object({
  // A stable schemastery Volatile reference: keep the reference, read `.get()` at every use.
  workerRoute: z.object({
    provider: z.string().required(),
    model: z.string().required(),
    reasoningEffort: z.string(),
  }).default(null).volatile(),
  catalogLimit: z.natural().max(MAX_CATALOG_LIMIT).default(DEFAULT_CATALOG_LIMIT),
  // Header shortcut for running subagents. Persisted (not Volatile) so it
  // survives restarts; absent in older configs means enabled.
  runningCapsule: z.boolean().default(true),
});

export const name = 'dsh-clean-desktop-shell/delegation';
export const inject = ['llm', 'agentPresets', 'configEditor', 'settings'];

function boundedCatalogLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1) return DEFAULT_CATALOG_LIMIT;
  return Math.min(value, MAX_CATALOG_LIMIT);
}

function sameRoute(left, right) {
  if (left === null || right === null) return left === right;
  return left.provider === right.provider && left.model === right.model
    && (left.reasoningEffort ?? null) === (right.reasoningEffort ?? null);
}

/**
 * The only correct Host-side self-identification: the same Entry object must be the one
 * addressable profile row, and its raw `options.id` is the settings namespace. Never guess a
 * package, preset or `include:*` id; an unaddressable entry fails loudly instead.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {string}
 */
function ownSettingsNamespace(ctx) {
  const entry = ctx.fiber?.entry;
  const rows = ctx.configEditor.entries();
  if (entry === undefined || !rows.includes(entry)) throw new Error(NO_NAMESPACE);
  const ns = entry.options?.id;
  if (typeof ns !== 'string' || ns.trim().length === 0) throw new Error(NO_NAMESPACE);
  return ns;
}

/**
 * Validate an explicit worker route through the real LLM resolver. A missing adapter rejects
 * with the resolver's own `NO_ADAPTER`; no alias, clamp or default worker is invented.
 * @param {{ resolveCallConfig(config: object, signal?: AbortSignal): Promise<object> }} llm
 * @param {Readonly<{provider: string, model: string, reasoningEffort?: string}>} route
 * @param {AbortSignal} [signal]
 * @returns {Promise<Readonly<{provider: string, model: string, reasoningEffort?: string}>>}
 */
export async function validateWorkerRoute(llm, route, signal) {
  if (route === null || typeof route !== 'object' || Array.isArray(route)) {
    throw new TypeError('delegation: an explicit worker route is required');
  }
  const { provider, model, reasoningEffort } = route;
  if (typeof provider !== 'string' || provider.trim().length === 0
    || typeof model !== 'string' || model.trim().length === 0) {
    throw new TypeError('delegation: the worker route must name a provider and a model');
  }
  const requested = { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) };
  const resolved = await llm.resolveCallConfig(requested, signal);
  signal?.throwIfAborted();
  const validated = snapshotWorkerRoute({
    provider: resolved.provider,
    model: resolved.model,
    ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
  });
  if (validated === null) throw new TypeError('delegation: the resolver returned no worker route');
  return validated;
}

/**
 * `register()` resolving is not health: only the registry's own `broken` diagnostic is.
 * @param {{ resolve(id: string): Promise<{ broken?: string }> }} agentPresets
 * @param {Readonly<{id: string}>} definition
 */
export async function checkPresetHealth(agentPresets, definition) {
  const preset = await agentPresets.resolve(definition.id);
  if (preset.broken !== undefined) throw new Error('delegation: the registered preset is not healthy');
}

/**
 * Serialized adapter over the frozen publisher: validates the next saved route first and skips
 * the enqueue entirely when the effective route (provider, model, resolved effort) is the one
 * already published, so a no-op save never opens the unavoidable retire/register window.
 * @param {{ publisher: ReturnType<typeof createPresetPublisher>, validateWorkerRoute(route: object, signal: AbortSignal): Promise<object> }} ports
 */
export function createRepublisher({ publisher, validateWorkerRoute: validate }) {
  if (!publisher || typeof validate !== 'function') {
    throw new TypeError('delegation: a publisher and a route validator are required');
  }
  const controller = new AbortController();
  let tail = Promise.resolve();
  let stopped = false;

  async function publishIfChanged(value) {
    let candidate;
    try { candidate = snapshotWorkerRoute(value); } catch { return publisher.enqueue(value); }
    const before = publisher.getStatus();
    if (candidate === null) {
      // An established unconfigured declaration is already published; a failed or never
      // published one must still be attempted.
      if (before.state === 'needs-config' && before.publishedRoute === null && before.generation !== null) return before;
      return publisher.enqueue(null);
    }
    let validated;
    // A validation refusal stays the publisher's own WORKER_ROUTE_VALIDATION_FAILED report.
    try { validated = await validate(candidate, controller.signal); } catch { return publisher.enqueue(value); }
    if (stopped) return publisher.getStatus();
    const status = publisher.getStatus();
    if ((status.state === 'active' || status.state === 'needs-config') && sameRoute(validated, status.publishedRoute)) return status;
    return publisher.enqueue(value);
  }

  return {
    /** @param {unknown} value @returns {Promise<object>} the settled status; never rejects */
    request(value) {
      if (stopped) return Promise.resolve(publisher.getStatus());
      const run = tail.then(() => (stopped ? publisher.getStatus() : publishIfChanged(value)));
      tail = run.then(() => undefined, () => undefined);
      return run;
    },
    async stop() {
      stopped = true;
      controller.abort();
      await tail;
    },
  };
}

function requireNamedId(field, value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RemoteError('gateway/bad-request', BAD_INPUT, {
      issues: [{ field, message: 'expected a non-empty string' }],
    });
  }
  return value;
}

function assertLive(signal) {
  if (signal?.aborted) throw new RemoteError('gateway/cancelled', CANCELLED, {});
}

function projectOptions(rows) {
  const seen = new Set();
  const options = [];
  let total = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
    const id = typeof row.id === 'string' ? row.id : '';
    if (id.trim().length === 0 || seen.has(id)) continue;
    seen.add(id);
    total += 1;
    options.push({ id, name: typeof row.name === 'string' && row.name.trim().length > 0 ? row.name : id });
  }
  return { options, total };
}

function projectCatalogue(rows, limit) {
  const { options, total } = projectOptions(rows);
  const items = Object.freeze(options.slice(0, limit).map((row) => Object.freeze(row)));
  return Object.freeze({ items, total, truncated: total > items.length });
}

function projectEfforts(info, limit) {
  const reasoning = info !== null && typeof info === 'object' ? info.reasoning : undefined;
  const { options, total } = projectOptions(reasoning?.efforts);
  const efforts = Object.freeze(options.slice(0, limit).map((row) => Object.freeze(row)));
  const truncated = total > efforts.length;
  const declared = reasoning?.defaultEffort;
  let defaultEffort = typeof declared === 'string' && declared.trim().length > 0 ? declared : null;
  // Never claim a default the retained list cannot show.
  if (defaultEffort !== null && !truncated && !efforts.some((row) => row.id === defaultEffort)) defaultEffort = null;
  return Object.freeze({ efforts, defaultEffort, total, truncated });
}

/**
 * Cancellation-aware status stream: one immediate snapshot, then every publisher transition.
 * No polling, no second bus, no write path.
 * @param {ReturnType<typeof createPresetPublisher>} publisher
 * @param {AbortSignal} [signal]
 */
function watchStatus(publisher, signal) {
  return {
    async *[Symbol.asyncIterator]() {
      if (signal?.aborted) return;
      const queue = [];
      let wake = null;
      let closed = false;
      const resume = () => { const pending = wake; wake = null; if (pending) pending(); };
      const onAbort = () => { closed = true; resume(); };
      signal?.addEventListener('abort', onAbort, { once: true });
      const unsubscribe = publisher.subscribe((status) => {
        if (closed) return;
        queue.push(status);
        resume();
      });
      try {
        for (;;) {
          while (queue.length > 0) {
            const next = queue.shift();
            yield next;
            // The publisher's terminal status is its last report; the stream must not hang on it.
            if (next.error === 'PUBLISHER_STOPPED') return;
          }
          if (closed || signal?.aborted) return;
          await new Promise((resolve) => { wake = resolve; });
        }
      } finally {
        closed = true;
        signal?.removeEventListener('abort', onAbort);
        unsubscribe();
      }
    },
  };
}

/**
 * Readonly DTO source. Every value is projected field by field; no adapter/provider object and
 * no credential field is spread into a wire DTO.
 * @param {{ llm: object, publisher: ReturnType<typeof createPresetPublisher>, catalogLimit?: number }} ports
 */
export function createDelegationReadApi({ llm, publisher, catalogLimit, runningCapsule }) {
  const limit = boundedCatalogLimit(catalogLimit);

  async function catalogue(rows, signal) {
    assertLive(signal);
    return projectCatalogue(rows, limit);
  }

  return {
    describe(signal) {
      assertLive(signal);
      const status = publisher.getStatus();
      const enabled = typeof runningCapsule === 'function' ? runningCapsule() !== false : runningCapsule !== false;
      return { ...status, runningCapsule: enabled };
    },
    providers(signal) {
      assertLive(signal);
      return projectCatalogue(llm.listProviders(), limit);
    },
    async models(providerId, signal) {
      assertLive(signal);
      let rows;
      try { rows = await llm.listModels(providerId); } catch { throw new RemoteError('gateway/internal', UNAVAILABLE, {}); }
      // listModels has no signal of its own: drop the late result instead of claiming IO abort.
      assertLive(signal);
      return catalogue(rows, signal);
    },
    async efforts(providerId, modelId, signal) {
      assertLive(signal);
      let info;
      try { info = await llm.resolveModelInfo(providerId, modelId, signal); } catch {
        assertLive(signal);
        throw new RemoteError('gateway/internal', UNAVAILABLE, {});
      }
      assertLive(signal);
      return projectEfforts(info, limit);
    },
    watch(signal) {
      return watchStatus(publisher, signal);
    },
  };
}

/** Public Typert Remote service; the Gateway discovers the five decorated methods. */
export class DelegationReadService extends TypertRemoteService {
  constructor(ctx, api) {
    super(ctx, READ_NAMESPACE);
    const instance = this;
    this.api = api;
    for (const method of READ_METHODS) {
      const decorator = method === 'watchDelegation' ? Remote({ mode: 'stream' }) : Remote;
      decorator(this[method], {
        kind: 'method', name: method, static: false, private: false,
        access: { has: (object) => method in object, get: (object) => object[method] },
        metadata: {},
        addInitializer(initializer) { initializer.call(instance); },
      });
    }
  }

  describeDelegation(signal) {
    return this.api.describe(signal);
  }

  listWorkerProviders(signal) {
    return this.api.providers(signal);
  }

  listWorkerModels(providerId, signal) {
    const provider = requireNamedId('providerId', providerId);
    return this.api.models(provider, signal);
  }

  listWorkerEfforts(providerId, modelId, signal) {
    const provider = requireNamedId('providerId', providerId);
    const model = requireNamedId('modelId', modelId);
    return this.api.efforts(provider, model, signal);
  }

  watchDelegation(signal) {
    return this.api.watch(signal);
  }
}

export function apply(ctx, config) {
  const settingsNs = ownSettingsNamespace(ctx);
  const catalogLimit = boundedCatalogLimit(config?.catalogLimit);
  // Keep the Volatile reference. Caching `.get()` here would freeze the first route forever.
  const routeRef = config.workerRoute;
  if (typeof routeRef?.get !== 'function') {
    throw new TypeError('delegation: workerRoute must be declared as a volatile config field');
  }
  const publisher = createPresetPublisher({
    settingsNs,
    snapshotWorkerRoute,
    validateWorkerRoute: (route, signal) => validateWorkerRoute(ctx.llm, route, signal),
    buildDelegationPresets: (route) => presetList(buildDelegationPresets(route)),
    register: (definition) => ctx.agentPresets.register(definition),
    healthyCheckpoint: (definition) => checkPresetHealth(ctx.agentPresets, definition),
  });
  const republisher = createRepublisher({
    publisher,
    validateWorkerRoute: (route, signal) => validateWorkerRoute(ctx.llm, route, signal),
  });
  // The custom page owns this namespace; the generated form must not compete with it.
  ctx.effect(() => ctx.settings.configure({ auto: false }));
  ctx.effect(() => () => (async () => {
    await republisher.stop();
    await publisher.stop();
  })());
  ctx.on('loader/volatile-update', (paths) => {
    if (!Array.isArray(paths) || !paths.some((path) => Array.isArray(path) && path.length === 1 && path[0] === 'workerRoute')) return;
    void republisher.request(routeRef.get());
  });
  ctx.plugin(DelegationReadService, createDelegationReadApi({
    llm: ctx.llm, publisher, catalogLimit,
    runningCapsule: () => config?.runningCapsule !== false,
  }));
  // Task 6 integration seam: the published preset's `delegation-gate` row reads the
  // `delegationGatePorts` service declared by the gate-port Host entry. Wait for that service
  // before the first publish. Registering first would retire the candidate as unhealthy
  // (PRESET_HEALTH_FAILED) and leave the preset id unresolvable until the next volatile save,
  // so a profile whose rows are ordered publisher-before-ports must still publish healthily.
  // If the ports never appear nothing is published at all: fail-closed, never an ungated preset.
  const gatePortsReady = new Promise((resolve) => {
    ctx.inject(['delegationGatePorts'], () => resolve());
  });
  // Publish after this fiber settles: never await the apply that creates the row, and never
  // wait for the Loader from inside it. Unload cancels the deferred work through the effect.
  void Promise.resolve()
    .then(() => ctx.fiber.await())
    .then(() => gatePortsReady)
    .then(() => republisher.request(routeRef.get()))
    .catch(() => { /* the publisher reports its own public failure state */ });
}

export const plugin = { name, inject, Config, apply };
export default plugin;
