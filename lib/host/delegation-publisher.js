/** @typedef {import('./delegation-config.js').WorkerRoute} WorkerRoute */
/** @typedef {Readonly<{settingsNs: string|null, state: 'needs-config'|'publishing'|'active'|'failed', savedRoute: WorkerRoute|null, publishedRoute: WorkerRoute|null, generation: number|null, error: string|null}>} PublishStatus */
/**
 * Application ports only. An AbortSignal guards late work; this does not assert SDK IO cancellation.
 * @typedef {object} PublisherDependencies
 * @property {string} settingsNs Non-empty; trimmed non-empty, original value kept.
 * @property {(value: unknown) => WorkerRoute|null} snapshotWorkerRoute Frozen Task2 shape/copy function.
 * @property {(route: WorkerRoute, signal: AbortSignal) => Promise<WorkerRoute>} validateWorkerRoute Returns the resolved route, including any model default effort.
 * @property {(route: WorkerRoute|null) => readonly Readonly<object>[]} buildDelegationPresets Frozen multi-preset factory; always called, including null.
 * @property {(definition: Readonly<object>, signal: AbortSignal) => Promise<() => void|Promise<void>>} register Own declaration disposer, not live Agent disposal.
 * @property {(definition: Readonly<object>, signal: AbortSignal) => Promise<void>} healthyCheckpoint Resolves only after the adapter's health checkpoint.
 */

/**
 * Serial declaration publisher, independent of Registry/Loader/Settings SDK bindings.
 * @param {PublisherDependencies} deps
 * @returns {{enqueue(route: unknown): Promise<PublishStatus>, getStatus(): PublishStatus, subscribe(listener: (status: PublishStatus) => void): () => void, stop(): Promise<void>}}
 */
export function createPresetPublisher(deps) {
  const settingsNs = deps?.settingsNs;
  if (typeof settingsNs !== 'string' || !settingsNs.trim()) throw new TypeError('settingsNs must be a non-empty string');
  let status = Object.freeze({ settingsNs, state: 'needs-config', savedRoute: null, publishedRoute: null, generation: null, error: null });
  let sequence = 0;
  let disposers = [];
  let retiringDisposers = [];
  const settledRejections = new Set();
  let controller = null;
  let running = null;
  let stopped = false;
  let stopPromise = null;
  const queue = [];
  const listeners = new Set();

  function notify(listener) {
    try { listener(status); } catch { /* An observer cannot break publication or another observer. */ }
  }

  function update(patch) {
    status = Object.freeze({ ...status, ...patch });
    for (const listener of [...listeners]) notify(listener);
    return status;
  }

  function failed(code) {
    return stopped ? status : update({ state: 'failed', error: code });
  }

  async function retire({ skipSettled = false } = {}) {
    const candidates = disposers.filter((dispose) => !skipSettled || !settledRejections.has(dispose));
    if (candidates.length === 0) return;
    // Dispose in reverse registration order; keep rejected handles for the next publication.
    const batch = candidates.slice().reverse();
    retiringDisposers = batch;
    let failure = null;
    try {
      for (const dispose of batch) {
        try {
          await dispose();
          disposers = disposers.filter((candidate) => candidate !== dispose);
          settledRejections.delete(dispose);
        } catch (error) {
          // A disposer that already settled with a rejection is never retried by stop.
          settledRejections.add(dispose);
          failure ??= error;
        }
      }
    } finally {
      retiringDisposers = [];
    }
    if (failure) throw failure;
  }

  async function publish(request) {
    if (request.shapeError) return failed('INVALID_WORKER_ROUTE');
    let failureCode = 'WORKER_ROUTE_VALIDATION_FAILED';
    try {
      update({ state: 'publishing', error: null });
      if (stopped) return status;
      const signal = controller.signal;
      let route = null;
      if (request.route !== null) {
        const resolved = await deps.validateWorkerRoute(request.route, signal);
        if (stopped) return status;
        route = deps.snapshotWorkerRoute(resolved);
        if (route === null) return failed(failureCode);
      }
      failureCode = 'PRESET_BUILD_FAILED';
      const definitions = deps.buildDelegationPresets(route);
      if (!Array.isArray(definitions) || definitions.length === 0) {
        throw new TypeError('buildDelegationPresets must return a non-empty array of presets');
      }
      if (stopped) return status;
      failureCode = 'PRESET_RETIRE_FAILED';
      update({ publishedRoute: null });
      if (stopped) return status;
      await retire();
      if (stopped) return status;
      for (const definition of definitions) {
        failureCode = 'PRESET_REGISTER_FAILED';
        const dispose = await deps.register(definition, signal);
        // A fresh declaration's disposer has not run yet, even if a port reuses a function identity.
        disposers.push(dispose);
        settledRejections.delete(dispose);
        if (stopped) return status;
        failureCode = 'PRESET_HEALTH_FAILED';
        await deps.healthyCheckpoint(definition, signal);
        if (stopped) return status;
      }
      sequence += 1;
      return update({ state: route === null ? 'needs-config' : 'active', publishedRoute: route, generation: sequence, error: null });
    } catch {
      if (stopped) return status;
      if (failureCode === 'PRESET_HEALTH_FAILED' || failureCode === 'PRESET_REGISTER_FAILED') {
        // Retire a failed candidate batch before settling. Rejected cleanup retains its handle.
        try { await retire(); } catch { /* Public health error remains sanitized; health is already unknown. */ }
      }
      return failed(failureCode);
    }
  }

  function start() {
    if (running) return;
    running = Promise.resolve().then(async () => {
      while (queue.length) {
        const request = queue.shift();
        controller = new AbortController();
        request.resolve(stopped ? status : await publish(request));
        controller = null;
      }
    }).finally(() => {
      running = null;
      // A completion observer may enqueue after the drain exits but before this finally runs.
      if (queue.length) start();
    });
  }

  function enqueue(value) {
    if (stopped) return Promise.resolve(status);
    let route = null;
    let shapeError = false;
    try { route = deps.snapshotWorkerRoute(value); } catch { shapeError = true; }
    const completion = new Promise((resolve) => { queue.push({ route, shapeError, resolve }); });
    start();
    // A shape-rejected save keeps the last shape-valid saved snapshot; it never clears it.
    update(shapeError ? { state: 'publishing', error: null } : { savedRoute: route, state: 'publishing', error: null });
    return completion;
  }

  function subscribe(listener) {
    if (!stopped) listeners.add(listener);
    notify(listener);
    return () => { listeners.delete(listener); };
  }

  function stop() {
    if (stopPromise) return stopPromise;
    // Install the shared promise before notifications so stop remains idempotent under observer reentry.
    const alreadyRetiring = retiringDisposers;
    stopPromise = Promise.resolve().then(async () => {
      while (running) await running;
      const pending = disposers.some((dispose) => !alreadyRetiring.includes(dispose) && !settledRejections.has(dispose));
      if (pending) {
        try { await retire({ skipSettled: true }); } catch { /* stop is terminal and does not retry or expose cleanup diagnostics. */ }
      }
      // The terminal status was delivered synchronously below; a second notify would duplicate it.
      listeners.clear();
    });
    stopped = true;
    controller?.abort();
    update({ state: 'failed', publishedRoute: null, error: 'PUBLISHER_STOPPED' });
    return stopPromise;
  }

  return { enqueue, getStatus: () => status, subscribe, stop };
}
