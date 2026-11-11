import test from 'node:test';
import assert from 'node:assert/strict';
import { createPresetPublisher } from './delegation-publisher.js';
import { snapshotWorkerRoute } from './delegation-config.js';

const A = Object.freeze({ provider: 'provider-a', model: 'model-a' });
const B = Object.freeze({ provider: 'provider-b', model: 'model-b' });
const C = Object.freeze({ provider: 'provider-c', model: 'model-c' });
const resolvedA = Object.freeze({ provider: 'provider-a', model: 'model-a', reasoningEffort: 'medium' });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// These are explicit application ports, not Registry, Loader, Config or live Agent fixtures.
function ports(overrides = {}) {
  return {
    settingsNs: 'settings-entry',
    snapshotWorkerRoute,
    validateWorkerRoute: async (route) => route,
    buildDelegationPresets: (route) => [Object.freeze({ id: 'test-preset', route })],
    register: async () => async () => {},
    healthyCheckpoint: async () => {},
    ...overrides,
  };
}

// Mutation: default or guess the settings namespace instead of rejecting construction immediately.
test('construction requires a non-empty trimmed settings namespace and keeps its original value', async () => {
  for (const settingsNs of [undefined, null, '', '   ', 42, {}, ['entry']]) {
    assert.throws(() => createPresetPublisher(ports({ settingsNs })), TypeError);
  }
  const publisher = createPresetPublisher(ports({ settingsNs: '  entry-own  ' }));
  assert.equal(publisher.getStatus().settingsNs, '  entry-own  ');
  await publisher.stop();
});

// Mutation: count a saved route or register acknowledgement as healthy publication.
test('empty mode registers and becomes needs-config only after health', async () => {
  const health = deferred();
  const entered = deferred();
  const seen = [];
  const publisher = createPresetPublisher(ports({
    validateWorkerRoute: async () => { throw new Error('null must skip validation'); },
    buildDelegationPresets: (route) => { seen.push(route); return [Object.freeze({ id: 'test-preset', route })]; },
    healthyCheckpoint: async () => { entered.resolve(); await health.promise; },
  }));
  assert.deepEqual(publisher.getStatus(), {
    settingsNs: 'settings-entry', state: 'needs-config', savedRoute: null,
    publishedRoute: null, generation: null, error: null,
  });
  const completion = publisher.enqueue(null);
  assert.equal(await Promise.race([entered.promise.then(() => 'health-entered'), completion.then(() => 'completed-before-health')]), 'health-entered');
  assert.equal(publisher.getStatus().state, 'publishing');
  assert.equal(publisher.getStatus().generation, null);
  health.resolve();
  assert.deepEqual(await completion, {
    settingsNs: 'settings-entry', state: 'needs-config', savedRoute: null,
    publishedRoute: null, generation: 1, error: null,
  });
  assert.deepEqual(seen, [null]);
  await publisher.stop();
});

// Mutation: publishing only the first built preset or skipping its health/cleanup.
test('every built preset is registered, health-checked and disposed once', async () => {
  const events = [];
  const publisher = createPresetPublisher(ports({
    buildDelegationPresets: (route) => [
      Object.freeze({ id: 'pure-preset', route }),
      Object.freeze({ id: 'router-preset', route }),
    ],
    register: async (definition) => {
      events.push(`register:${definition.id}`);
      return async () => { events.push(`dispose:${definition.id}`); };
    },
    healthyCheckpoint: async (definition) => { events.push(`health:${definition.id}`); },
  }));
  const first = await publisher.enqueue(A);
  assert.equal(first.state, 'active');
  assert.deepEqual(events, [
    'register:pure-preset', 'health:pure-preset',
    'register:router-preset', 'health:router-preset',
  ]);
  const second = await publisher.enqueue(B);
  assert.equal(second.generation, 2);
  assert.deepEqual(events.slice(4), [
    'dispose:router-preset', 'dispose:pure-preset',
    'register:pure-preset', 'health:pure-preset',
    'register:router-preset', 'health:router-preset',
  ]);
  await publisher.stop();
  assert.deepEqual(events.slice(10), ['dispose:router-preset', 'dispose:pure-preset']);
});

// Mutation: leaking the first declaration when the second preset fails to register.
test('a failed second registration retires the presets that already registered', async () => {
  const events = [];
  const publisher = createPresetPublisher(ports({
    buildDelegationPresets: (route) => [
      Object.freeze({ id: 'pure-preset', route }),
      Object.freeze({ id: 'router-preset', route }),
    ],
    register: async (definition) => {
      events.push(`register:${definition.id}`);
      if (definition.id === 'router-preset') throw new Error('private-register-marker');
      return async () => { events.push(`dispose:${definition.id}`); };
    },
  }));
  const result = await publisher.enqueue(A);
  assert.equal(result.state, 'failed');
  assert.equal(result.error, 'PRESET_REGISTER_FAILED');
  assert.deepEqual(events, ['register:pure-preset', 'register:router-preset', 'dispose:pure-preset']);
  await publisher.stop();
});

// Mutation: build with the saved route instead of the validated default-effort result.
test('saved snapshot and resolved published route remain distinct and immutable', async () => {
  let definition;
  let validationInput;
  const input = { provider: 'provider-a', model: 'model-a' };
  const resolved = { provider: 'provider-a', model: 'model-a', reasoningEffort: 'medium' };
  const publisher = createPresetPublisher(ports({
    validateWorkerRoute: async (route) => { validationInput = route; return resolved; },
    register: async (value) => { definition = value; return async () => {}; },
  }));
  const completion = publisher.enqueue(input);
  input.model = 'caller-mutated';
  const result = await completion;
  resolved.reasoningEffort = 'caller-mutated';
  assert.deepEqual(validationInput, { provider: 'provider-a', model: 'model-a' });
  assert.deepEqual(result.savedRoute, { provider: 'provider-a', model: 'model-a' });
  assert.deepEqual(result.publishedRoute, { provider: 'provider-a', model: 'model-a', reasoningEffort: 'medium' });
  assert.deepEqual(definition.route, { provider: 'provider-a', model: 'model-a', reasoningEffort: 'medium' });
  assert.equal(result.state, 'active');
  assert.equal(result.generation, 1);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.savedRoute));
  assert.ok(Object.isFrozen(result.publishedRoute));
  assert.throws(() => { result.publishedRoute.model = 'observer-mutated'; }, TypeError);
  await publisher.stop();
});

// Mutation: start B/C while A retirement is pending, or coalesce an unstarted B save.
test('A/B/C publishes FIFO and awaits old disposer before fresh registration', async () => {
  const retiringA = deferred();
  const enteredRetirement = deferred();
  const events = [];
  const definitions = [];
  const publisher = createPresetPublisher(ports({
    register: async (definition) => {
      definitions.push(definition);
      events.push(`register:${definition.route.model}`);
      return async () => {
        events.push(`retire:${definition.route.model}`);
        if (definition.route.model === 'model-a') {
          enteredRetirement.resolve();
          await retiringA.promise;
        }
        events.push(`retired:${definition.route.model}`);
      };
    },
    healthyCheckpoint: async (definition) => { events.push(`healthy:${definition.route.model}`); },
  }));
  await publisher.enqueue(A);
  const oldLiveAgentDefinition = definitions[0];
  const pendingB = publisher.enqueue(B);
  const pendingC = publisher.enqueue(C);
  assert.equal(await Promise.race([enteredRetirement.promise.then(() => 'retirement-entered'), Promise.all([pendingB, pendingC]).then(() => 'completed-before-retirement')]), 'retirement-entered');
  assert.deepEqual(events, ['register:model-a', 'healthy:model-a', 'retire:model-a']);
  assert.deepEqual(publisher.getStatus().savedRoute, { provider: 'provider-c', model: 'model-c' });
  assert.equal(publisher.getStatus().publishedRoute, null);
  retiringA.resolve();
  const resultB = await pendingB;
  const resultC = await pendingC;
  assert.deepEqual(events, [
    'register:model-a', 'healthy:model-a', 'retire:model-a', 'retired:model-a',
    'register:model-b', 'healthy:model-b', 'retire:model-b', 'retired:model-b',
    'register:model-c', 'healthy:model-c',
  ]);
  assert.equal(resultB.generation, 2);
  assert.deepEqual(resultB.savedRoute, { provider: 'provider-c', model: 'model-c' });
  assert.deepEqual(resultB.publishedRoute, { provider: 'provider-b', model: 'model-b' });
  assert.equal(resultC.generation, 3);
  assert.deepEqual(resultC.publishedRoute, { provider: 'provider-c', model: 'model-c' });
  assert.deepEqual(oldLiveAgentDefinition.route, { provider: 'provider-a', model: 'model-a' });
  assert.notEqual(definitions[0], definitions[1]);
  await publisher.stop();
});

// Mutation: erase the previous healthy route before asynchronous validation finishes.
test('preflight keeps the previous healthy declaration while latest save waits', async () => {
  const validation = deferred();
  const entered = deferred();
  const publisher = createPresetPublisher(ports({
    validateWorkerRoute: async (route) => {
      if (route.model === 'model-b') { entered.resolve(); await validation.promise; }
      return route;
    },
  }));
  await publisher.enqueue(A);
  const completion = publisher.enqueue(B);
  assert.equal(await Promise.race([entered.promise.then(() => 'validation-entered'), completion.then(() => 'completed-before-validation')]), 'validation-entered');
  assert.deepEqual(publisher.getStatus(), {
    settingsNs: 'settings-entry', state: 'publishing', savedRoute: { provider: 'provider-b', model: 'model-b' },
    publishedRoute: { provider: 'provider-a', model: 'model-a' }, generation: 1, error: null,
  });
  validation.resolve();
  assert.equal((await completion).generation, 2);
  await publisher.stop();
});

// Mutation: throw from enqueue on an invalid save, or silently replace healthy mode with null.
test('invalid save resolves a sanitized failed status and preserves healthy mode', async () => {
  let retired = 0;
  const publisher = createPresetPublisher(ports({ register: async () => async () => { retired += 1; } }));
  await publisher.enqueue(A);
  const result = await publisher.enqueue({ ...B, unknown: 'private-input-marker' });
  assert.deepEqual(result, { settingsNs: 'settings-entry', state: 'failed', savedRoute: { provider: 'provider-a', model: 'model-a' }, publishedRoute: { provider: 'provider-a', model: 'model-a' }, generation: 1, error: 'INVALID_WORKER_ROUTE' });
  assert.equal(retired, 0);
  assert.equal(JSON.stringify(result).includes('private-input-marker'), false);
  assert.equal((await publisher.enqueue(C)).generation, 2);
  await publisher.stop();
});

for (const [label, resolveB, buildB, expected] of [
  ['resolver rejection', async () => { throw new Error('private-resolver-marker'); }, false, 'WORKER_ROUTE_VALIDATION_FAILED'],
  ['null resolved route', async () => null, false, 'WORKER_ROUTE_VALIDATION_FAILED'],
  ['extra resolved field', async () => ({ ...B, unknown: 'private-result-marker' }), false, 'WORKER_ROUTE_VALIDATION_FAILED'],
  ['factory rejection', async () => B, true, 'PRESET_BUILD_FAILED'],
]) {
  // Mutation: erase healthy A before preflight succeeds, retain invalid resolved data, or leak raw errors.
  test(`preflight preserves A and sanitizes ${label}`, async () => {
    let retired = 0;
    const publisher = createPresetPublisher(ports({
      validateWorkerRoute: async (route) => route.model === 'model-b' ? resolveB() : route,
      buildDelegationPresets: (route) => { if (buildB && route?.model === 'model-b') throw new Error('private-factory-marker'); return [Object.freeze({ id: 'test-preset', route })]; },
      register: async () => async () => { retired += 1; },
    }));
    await publisher.enqueue(A);
    const result = await publisher.enqueue(B);
    assert.deepEqual(result, { settingsNs: 'settings-entry', state: 'failed', savedRoute: { provider: 'provider-b', model: 'model-b' }, publishedRoute: { provider: 'provider-a', model: 'model-a' }, generation: 1, error: expected });
    assert.equal(retired, 0);
    assert.equal(JSON.stringify(result).includes('private-'), false);
    assert.equal((await publisher.enqueue(C)).generation, 2);
    await publisher.stop();
  });
}

// Mutation: discard the last shape-valid saved snapshot when a later save fails shape validation.
test('invalid save retains the last shape-valid saved route until a later save replaces it', async () => {
  const seen = [];
  const publisher = createPresetPublisher(ports());
  await publisher.enqueue(A);
  publisher.subscribe((value) => { seen.push(value); });
  const result = await publisher.enqueue({ provider: 'provider-b', model: 'model-b', effort: 'high' });
  assert.equal(result.state, 'failed');
  assert.equal(result.error, 'INVALID_WORKER_ROUTE');
  assert.deepEqual(result.savedRoute, { provider: 'provider-a', model: 'model-a' });
  assert.deepEqual(result.publishedRoute, { provider: 'provider-a', model: 'model-a' });
  assert.equal(result.generation, 1);
  assert.equal(seen.some((value) => value.savedRoute === null), false);
  assert.deepEqual((await publisher.enqueue(C)).savedRoute, { provider: 'provider-c', model: 'model-c' });
  await publisher.stop();
});

// Mutation: register despite failed retirement, or forget the still-owned old declaration.
test('retirement rejection prevents fresh registration and a later save must retire again', async () => {
  let attempts = 0;
  const registered = [];
  const publisher = createPresetPublisher(ports({ register: async (definition) => {
    registered.push(definition.route.model);
    return async () => { if (definition.route.model === 'model-a' && ++attempts === 1) throw new Error('private-retirement-marker'); };
  } }));
  await publisher.enqueue(A);
  const result = await publisher.enqueue(B);
  assert.equal(result.state, 'failed');
  assert.equal(result.error, 'PRESET_RETIRE_FAILED');
  assert.equal(result.publishedRoute, null);
  assert.equal(result.generation, 1);
  assert.deepEqual(registered, ['model-a']);
  assert.equal((await publisher.enqueue(C)).generation, 2);
  assert.deepEqual(registered, ['model-a', 'model-c']);
  assert.equal(attempts, 2);
  await publisher.stop();
});

// Mutation: label a retired route healthy after register rejection, or permanently break the queue.
test('registration rejection reports no healthy route and later save recovers', async () => {
  const publisher = createPresetPublisher(ports({ register: async (definition) => {
    if (definition.route.model === 'model-b') throw new Error('private-register-marker');
    return async () => {};
  } }));
  await publisher.enqueue(A);
  const result = await publisher.enqueue(B);
  assert.equal(result.state, 'failed');
  assert.equal(result.error, 'PRESET_REGISTER_FAILED');
  assert.equal(result.publishedRoute, null);
  assert.equal(result.generation, 1);
  assert.equal((await publisher.enqueue(C)).generation, 2);
  await publisher.stop();
});

// Mutation: count rejected health as success or leak the failed candidate before following registration.
test('health rejection retires candidate before a later registration', async () => {
  const events = [];
  const publisher = createPresetPublisher(ports({
    register: async (definition) => { events.push(`register:${definition.route.model}`); return async () => { events.push(`retire:${definition.route.model}`); }; },
    healthyCheckpoint: async (definition) => { if (definition.route.model === 'model-b') throw new Error('private-health-marker'); },
  }));
  await publisher.enqueue(A);
  const result = await publisher.enqueue(B);
  assert.equal(result.state, 'failed');
  assert.equal(result.error, 'PRESET_HEALTH_FAILED');
  assert.equal(result.publishedRoute, null);
  assert.equal(result.generation, 1);
  assert.deepEqual(events, ['register:model-a', 'retire:model-a', 'register:model-b', 'retire:model-b']);
  assert.equal((await publisher.enqueue(C)).generation, 2);
  assert.deepEqual(events, ['register:model-a', 'retire:model-a', 'register:model-b', 'retire:model-b', 'register:model-c']);
  await publisher.stop();
});

// Mutation: clear the route by deleting the mode rather than building its empty rejecting declaration.
test('clearing A still registers and health-checks a new null declaration', async () => {
  const events = [];
  const publisher = createPresetPublisher(ports({
    register: async (definition) => { events.push(['register', definition.route]); return async () => { events.push(['retire', definition.route]); }; },
    healthyCheckpoint: async (definition) => { events.push(['healthy', definition.route]); },
  }));
  await publisher.enqueue(A);
  assert.deepEqual(await publisher.enqueue(null), { settingsNs: 'settings-entry', state: 'needs-config', savedRoute: null, publishedRoute: null, generation: 2, error: null });
  assert.deepEqual(events, [['register', { provider: 'provider-a', model: 'model-a' }], ['healthy', { provider: 'provider-a', model: 'model-a' }], ['retire', { provider: 'provider-a', model: 'model-a' }], ['register', null], ['healthy', null]]);
  await publisher.stop();
});

// Mutation: omit immediate state, retain cancelled observers or let their errors stop publication.
test('subscription supplies frozen current and transitions with idempotent cleanup', async () => {
  const seen = [];
  const publisher = createPresetPublisher(ports({ settingsNs: 'entry-other' }));
  const cancel = publisher.subscribe((value) => { seen.push(value); });
  publisher.subscribe(() => { throw new Error('observer failure'); });
  assert.equal(seen[0].state, 'needs-config');
  assert.equal(Object.getPrototypeOf(seen[0]), Object.prototype);
  assert.ok(Object.isFrozen(seen[0]));
  await publisher.enqueue(A);
  assert.equal(seen.at(-1).state, 'active');
  assert.equal(seen.at(-1).settingsNs, 'entry-other');
  assert.ok(seen.some((value) => value.state === 'publishing'));
  cancel(); cancel();
  const count = seen.length;
  await publisher.enqueue(B);
  await publisher.stop();
  assert.equal(seen.length, count);
});

// Mutation: notify the terminal stopped transition twice, or once per queued item.
test('stop delivers the terminal PUBLISHER_STOPPED notification exactly once with queued work', async () => {
  const retirement = deferred(); const entered = deferred();
  const publisher = createPresetPublisher(ports({ register: async () => async () => { entered.resolve(); await retirement.promise; } }));
  const seen = [];
  await publisher.enqueue(A);
  publisher.subscribe((value) => { seen.push(value); });
  const queued = publisher.enqueue(B);
  await entered.promise;
  const stopping = publisher.stop();
  retirement.resolve();
  await stopping;
  await queued;
  assert.equal(seen.filter((value) => value.error === 'PUBLISHER_STOPPED').length, 1);
  assert.equal(seen.at(-1).error, 'PUBLISHER_STOPPED');
});

// Mutation: start callbacks after stop wins before the drain microtask, or start new saves after stop.
test('stop before drain settles queued and future saves without starting any ports', async () => {
  let calls = 0;
  const publisher = createPresetPublisher(ports({ validateWorkerRoute: async (route) => { calls += 1; return route; }, register: async () => { calls += 1; return async () => {}; } }));
  const pending = [publisher.enqueue(A), publisher.enqueue(B)];
  await publisher.stop();
  for (const result of await Promise.all(pending)) {
    assert.equal(result.state, 'failed'); assert.equal(result.error, 'PUBLISHER_STOPPED');
    assert.equal(result.publishedRoute, null); assert.equal(result.generation, null);
  }
  assert.equal((await publisher.enqueue(C)).error, 'PUBLISHER_STOPPED');
  assert.equal(calls, 0);
});

// Mutation: resolve stop before a running validator quiesces, or reject enqueue on late cancellation.
test('stop aborts pending validation and waits its late rejection, settling A/B/C as stopped', async () => {
  const validation = deferred(); const entered = deferred();
  let signal; let registered = 0;
  const publisher = createPresetPublisher(ports({
    validateWorkerRoute: async (route, value) => { signal = value; entered.resolve(); return validation.promise; },
    register: async () => { registered += 1; return async () => {}; },
  }));
  const pending = [publisher.enqueue(A), publisher.enqueue(B), publisher.enqueue(C)];
  await entered.promise;
  let stopped = false;
  const stopping = publisher.stop().then(() => { stopped = true; });
  assert.equal(signal.aborted, true);
  await Promise.resolve(); assert.equal(stopped, false);
  validation.reject(new Error('private-late-validation-marker'));
  await stopping;
  for (const result of await Promise.all(pending)) assert.deepEqual(result, { settingsNs: 'settings-entry', state: 'failed', savedRoute: { provider: 'provider-c', model: 'model-c' }, publishedRoute: null, generation: null, error: 'PUBLISHER_STOPPED' });
  assert.equal(registered, 0);
});

// Mutation: ignore a late registration disposer or stop before asynchronous cleanup finishes.
test('stop waits pending registration and late disposer without invoking health', async () => {
  const registration = deferred(); const cleanup = deferred(); const entered = deferred(); const cleanupEntered = deferred();
  let signal; let healthCalls = 0; let cleanupCalls = 0;
  const publisher = createPresetPublisher(ports({
    register: async (definition, value) => { signal = value; entered.resolve(); return registration.promise; },
    healthyCheckpoint: async () => { healthCalls += 1; },
  }));
  const completion = publisher.enqueue(A);
  await entered.promise;
  let stopped = false;
  const firstStop = publisher.stop(); assert.equal(publisher.stop(), firstStop);
  const stopping = firstStop.then(() => { stopped = true; });
  assert.equal(signal.aborted, true);
  registration.resolve(async () => { cleanupCalls += 1; cleanupEntered.resolve(); await cleanup.promise; });
  await cleanupEntered.promise; assert.equal(stopped, false);
  cleanup.resolve(); await stopping;
  assert.equal(cleanupCalls, 1); assert.equal(healthCalls, 0);
  assert.equal((await completion).error, 'PUBLISHER_STOPPED'); assert.equal(publisher.getStatus().generation, null);
});

// Mutation: publish late health success after stop, or retain terminal observers for future updates.
test('stop during health keeps generation unchanged and clears listeners after terminal status', async () => {
  const health = deferred(); const entered = deferred();
  let cleanups = 0; let signal; const seen = [];
  const publisher = createPresetPublisher(ports({
    register: async () => async () => { cleanups += 1; },
    healthyCheckpoint: async (definition, value) => { signal = value; entered.resolve(); await health.promise; },
  }));
  publisher.subscribe((value) => { seen.push(value); });
  const completion = publisher.enqueue(A); await entered.promise;
  const stopping = publisher.stop(); assert.equal(signal.aborted, true);
  health.resolve(); await stopping;
  assert.equal(cleanups, 1); assert.equal((await completion).error, 'PUBLISHER_STOPPED');
  assert.equal(seen.at(-1).error, 'PUBLISHER_STOPPED'); assert.equal(seen.some((value) => value.state === 'active'), false);
  const count = seen.length; await publisher.enqueue(B); await publisher.stop(); assert.equal(seen.length, count);
  const afterStop = []; publisher.subscribe((value) => { afterStop.push(value); });
  assert.equal(afterStop.length, 1); assert.equal(afterStop[0].generation, null);
});

// Mutation: dispose the same old declaration twice when stop races its pending retirement.
test('stop during old retirement waits once and never registers the replacement', async () => {
  const retirement = deferred(); const entered = deferred(); let registered = 0; let retired = 0;
  const publisher = createPresetPublisher(ports({ register: async () => {
    registered += 1; return async () => { retired += 1; entered.resolve(); await retirement.promise; };
  } }));
  await publisher.enqueue(A); const completion = publisher.enqueue(B); await entered.promise;
  const stopping = publisher.stop(); retirement.resolve(); await stopping;
  assert.equal(registered, 1); assert.equal(retired, 1); assert.equal((await completion).error, 'PUBLISHER_STOPPED');
});

// Mutation: reject stop, leak raw cleanup diagnostics or repeat cleanup on subsequent stop calls.
test('stop contains cleanup rejection and remains idempotent with a sanitized status', async () => {
  let retired = 0;
  const publisher = createPresetPublisher(ports({ register: async () => async () => { retired += 1; throw new Error('private-stop-marker'); } }));
  await publisher.enqueue(A); await publisher.stop(); await publisher.stop();
  assert.equal(retired, 1);
  assert.deepEqual(publisher.getStatus(), { settingsNs: 'settings-entry', state: 'failed', savedRoute: { provider: 'provider-a', model: 'model-a' }, publishedRoute: null, generation: 1, error: 'PUBLISHER_STOPPED' });
});

// Mutation: retry the same failed retirement after stop raced its already-started callback.
test('stop does not retry an already-started disposer when that disposer rejects late', async () => {
  const retirement = deferred(); const entered = deferred(); let retired = 0;
  const publisher = createPresetPublisher(ports({ register: async () => async () => {
    retired += 1; entered.resolve(); await retirement.promise;
  } }));
  await publisher.enqueue(A); const completion = publisher.enqueue(B); await entered.promise;
  const stopping = publisher.stop(); retirement.reject(new Error('private-late-retirement-marker'));
  await stopping;
  assert.equal(retired, 1);
  assert.equal((await completion).error, 'PUBLISHER_STOPPED');
});

// Mutation: retry a disposer that already settled with a rejection when stop later runs.
test('stop never retries a disposer that already settled with a rejection', async () => {
  let cleanups = 0;
  const publisher = createPresetPublisher(ports({ register: async (definition) => async () => {
    if (definition.route.model === 'model-a') { cleanups += 1; throw new Error('private-settled-retirement-marker'); }
  } }));
  await publisher.enqueue(A);
  const result = await publisher.enqueue(B);
  assert.equal(result.error, 'PRESET_RETIRE_FAILED');
  assert.equal(cleanups, 1);
  await publisher.stop();
  assert.equal(cleanups, 1);
});

// Mutation: retry failed-candidate cleanup after stop already waited for that same cleanup.
test('stop does not retry failed-candidate cleanup that was already running', async () => {
  const cleanup = deferred(); const entered = deferred(); let retired = 0;
  const publisher = createPresetPublisher(ports({
    register: async () => async () => { retired += 1; entered.resolve(); await cleanup.promise; },
    healthyCheckpoint: async () => { throw new Error('private-health-marker'); },
  }));
  const completion = publisher.enqueue(A); await entered.promise;
  const stopping = publisher.stop(); cleanup.reject(new Error('private-late-cleanup-marker'));
  await stopping;
  assert.equal(retired, 1);
  assert.equal((await completion).error, 'PUBLISHER_STOPPED');
});

// Mutation: consume a validator's late result after stop instead of checking cancellation first.
test('stop ignores late validation success without invoking the snapshot or build ports again', async () => {
  const validation = deferred(); const entered = deferred(); let snapshots = 0; let builds = 0;
  const publisher = createPresetPublisher(ports({
    snapshotWorkerRoute: (value) => { snapshots += 1; return snapshotWorkerRoute(value); },
    validateWorkerRoute: async () => { entered.resolve(); return validation.promise; },
    buildDelegationPresets: (route) => { builds += 1; return [Object.freeze({ id: 'test-preset', route })]; },
  }));
  const completion = publisher.enqueue(A); await entered.promise;
  const stopping = publisher.stop(); validation.resolve(resolvedA); await stopping;
  assert.equal(snapshots, 1); assert.equal(builds, 0);
  assert.equal((await completion).error, 'PUBLISHER_STOPPED');
});
