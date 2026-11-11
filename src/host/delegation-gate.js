// Agent-scope delegation gate for the clean-desktop-shell PTC preset.
//
// One installed gate is bound to the preset generation scope it was mounted from. It
// guards ONLY this revision's stock `subagent` spawn: null route / unprovable route /
// unconfirmable recovery deny before the child exists; `subagent_fork`, ordinary tools
// and every other revision stay untouched. Recovery is proven only from public,
// replay-validated reads of the parent's own prefix and the child's own request headers.
//
// The Host ports required by this module (scope chain, header folding, services) are
// injected by the integration entry; this file imports no @deepseek-ai/* package.
import { snapshotWorkerRoute } from './delegation-config.js';
import { idOf, probe } from './delegation-gate-probe.js';
import {
  WORKER_ROUTE_RECEIPT_PREFIX,
  WORKER_ROUTE_RECEIPT_SCHEMA,
  parseWorkerRouteReceiptContent,
  parseWorkerRouteReceiptText,
} from './delegation-evidence.js';

export const name = 'delegation-gate';
export const inject = [];

export const WORKER_ROUTE_DENIAL = Object.freeze({
  UNCONFIGURED: 'WORKER_ROUTE_UNCONFIGURED',
  RECOVERY_UNCONFIRMED: 'WORKER_ROUTE_RECOVERY_UNCONFIRMED',
  APPROVAL_UNAVAILABLE: 'WORKER_ROUTE_APPROVAL_UNAVAILABLE',
});

const GATED_TOOL = 'subagent';
const BOUNDARY_SOURCES = new Set(['startup', 'resume', 'clear', 'compact']);

/** 探针用：本进程里 gate 挂载的时刻。 */
const GATE_INSTALLED_AT = Date.now();

/** 本进程启动时刻（ms）：早于它的会话是跨重启恢复的，晚于它的只是普通新会话。 */
const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);

/**
 * 探针用：会话创建时间（ms），拿不到返回 null。
 * @param {any} agent
 * @returns {number|null}
 */
function createdAtOf(agent) {
  try {
    const session = agent?.session;
    const raw = session?.header?.createdAt ?? session?.createdAt;
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (raw instanceof Date) return raw.getTime();
    if (typeof raw === 'string') {
      const parsed = Date.parse(raw);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  } catch {
    return null;
  }
}
const REASON_PREFIX = 'delegation gate';
const RECEIPT_FAMILY = '[dsh-clean-desktop-shell/worker-route-receipt';
// One-time ask keys are per agent+call; a new lifecycle retires them, and the hard cap
// fails closed instead of growing without bound in a very long session.
const MAX_TRACKED_ASKS = 256;
const ASK_KEY_SEPARATOR = '\u0000';
const MAX_RECORDED_UNKNOWNS = 32;

let configuredPorts = null;

/**
 * Declare the Host ports once for an installation whose preset rows cannot carry
 * service references. Ports are stateless functions/services; the gate keeps no
 * cross-agent permission state. Passing null clears the declaration.
 */
export function configureWorkerGatePorts(ports) {
  if (ports === null || ports === undefined) {
    configuredPorts = null;
    return undefined;
  }
  if (typeof ports !== 'object' || Array.isArray(ports)) {
    throw new TypeError('delegation gate: ports must be a plain object');
  }
  if (typeof ports.scopeOf !== 'function' || typeof ports.scopeChainOf !== 'function') {
    throw new TypeError('delegation gate: scopeOf/scopeChainOf ports are required');
  }
  configuredPorts = { ...ports };
  return undefined;
}

function safeGet(ctx, name) {
  try {
    return ctx?.get?.(name);
  } catch {
    return undefined;
  }
}

/**
 * Read a handler's own context without touching the guarded `ctx` property of a Cordis
 * context: the context proxy throws `cannot get property "ctx" without inject` because a
 * context has no such own property, and a mounted preset row must not die on that.
 * Only a non-context handler (an Agent) carries its context as `ctx`.
 * @param {unknown} target
 * @returns {object | undefined}
 */
function contextOf(target) {
  if (target === null || typeof target !== 'object') return undefined;
  if (typeof target.get === 'function' && typeof target.on === 'function') return target;
  try {
    const own = target.ctx;
    return own !== null && typeof own === 'object' ? own : undefined;
  } catch {
    return undefined;
  }
}

function declaredPorts(target) {
  return safeGet(contextOf(target), 'delegationGatePorts') ?? configuredPorts;
}

/**
 * Resolve a service from a context without tripping the proxy guard. A plain fixture or a
 * real context both answer through `ctx.get(name)`; a real context proxy throws when a
 * service is read as a bare property before it is injected, so that read is guarded.
 * @param {object | undefined} ctx
 * @param {string} name
 */
function resolveService(ctx, name) {
  if (ctx === null || typeof ctx !== 'object') return undefined;
  try {
    const direct = ctx[name];
    if (direct !== null && direct !== undefined) return direct;
  } catch {
    // An undeclared service property is exactly what the proxy rejects.
  }
  return safeGet(ctx, name);
}

function hydratePorts(ports, registrationCtx) {
  return {
    ...ports,
    tools: ports.tools ?? resolveService(registrationCtx, 'tools'),
    approval: ports.approval ?? safeGet(registrationCtx, 'approval'),
    llm: ports.llm ?? safeGet(registrationCtx, 'llm'),
    sessionQuery: ports.sessionQuery ?? safeGet(registrationCtx, 'sessionQuery'),
  };
}

/**
 * Fail at mount, not silently at every post-execute: a route whose provider/model/effort
 * exceeds the frozen receipt bounds can never yield a canonical receipt, so the persisted
 * recovery evidence would be missing for every spawn while the gate looked healthy.
 * @param {Readonly<{provider: string, model: string, reasoningEffort?: string}>} route
 */
function assertEncodableRoute(route) {
  const probe = WORKER_ROUTE_RECEIPT_PREFIX + JSON.stringify({
    schema: WORKER_ROUTE_RECEIPT_SCHEMA,
    parentSessionId: 'probe',
    callId: 'probe',
    rootCallId: 'probe',
    toolName: GATED_TOOL,
    childSessionId: 'probe',
    declared: {
      source: 'bound-stock-agent-options',
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
    },
    actual: { status: 'not-established-by-receipt' },
  });
  if (parseWorkerRouteReceiptText(probe) === null) {
    throw new TypeError('delegation gate: the configured worker route cannot be encoded as a canonical receipt; provider, model or reasoningEffort exceeds its frozen protocol bound, so the persisted recovery receipt would be silently skipped');
  }
}

function denial(code, detail) {
  return {
    kind: 'deny',
    reason: `${code}: ${detail}`,
    info: { name: 'DelegationGate', code, reason: detail },
  };
}

function cancelled(signal) {
  return signal?.aborted === true;
}

function formatRoute(route) {
  if (route === null || route === undefined) return 'no route';
  const effort = route.reasoningEffort === undefined ? '' : ` (reasoningEffort: ${route.reasoningEffort})`;
  return `${route.provider} / ${route.model}${effort}`;
}

function sameRoute(left, right) {
  return left !== null && left !== undefined && right !== null && right !== undefined
    && left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort;
}

function routeRequest(route) {
  return {
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
  };
}

function normalizeRoute(config) {
  if (config === null || typeof config !== 'object') return null;
  if (typeof config.provider !== 'string' || config.provider.length === 0) return null;
  if (typeof config.model !== 'string' || config.model.length === 0) return null;
  if (config.reasoningEffort !== undefined
    && (typeof config.reasoningEffort !== 'string' || config.reasoningEffort.length === 0)) return null;
  return Object.freeze({
    provider: config.provider,
    model: config.model,
    ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
  });
}

function truthyArray(value) {
  return Array.isArray(value);
}

function markerLike(content) {
  return Array.isArray(content) && content.some((block) => block !== null && typeof block === 'object'
    && block.type === 'text' && typeof block.text === 'string' && block.text.includes(RECEIPT_FAMILY));
}

function nativeActivation(events, event) {
  const message = event?.data?.message;
  if (event?.surfaceOp !== 'append') return null;
  if (message?.source?.kind !== 'tool' || message.isError !== false) return null;
  if (typeof message.toolCallId !== 'string' || message.toolCallId.length === 0) return null;
  if (!truthyArray(event.sourceEventSeqs) || !truthyArray(message.content)) return null;
  const calls = events.filter((item) => item?.type === 'tool/call'
    && item.data?.callId === message.toolCallId
    && event.sourceEventSeqs.includes(item.seq)
    && item.seq < event.seq);
  if (calls.length !== 1 || calls[0].data?.name !== GATED_TOOL) return null;
  return { callId: calls[0].data.callId, rootCallId: calls[0].data.callId, content: message.content };
}

function ptcActivation(events, event) {
  const data = event?.data;
  if (event?.surfaceOp !== undefined) return null;
  if (data?.isError !== false || data?.name !== GATED_TOOL) return null;
  if (typeof data.subCallId !== 'string' || data.subCallId.length === 0) return null;
  if (!truthyArray(data.content)) return null;
  const starts = events.filter((item) => item?.type === 'tool/ptc-dispatch-start'
    && item.data?.subCallId === data.subCallId
    && item.seq < event.seq);
  if (starts.length !== 1) return null;
  const start = starts[0].data;
  for (const key of ['rootCallId', 'parentCallId', 'subCallId', 'name']) {
    if (start?.[key] !== data[key]) return null;
  }
  if (JSON.stringify(start.arguments) !== JSON.stringify(data.arguments)) return null;
  const outer = events.filter((item) => item?.type === 'tool/call'
    && item.data?.name === 'run_code'
    && item.data?.callId === data.parentCallId
    && item.seq < starts[0].seq);
  if (outer.length !== 1 || outer[0].data?.callId !== data.rootCallId) return null;
  return { callId: data.subCallId, rootCallId: data.rootCallId, content: data.content };
}

function lastActivation(events) {
  let found = null;
  for (const event of events) {
    const activation = event?.type === 'tool/result'
      ? nativeActivation(events, event)
      : event?.type === 'tool/ptc-dispatch' ? ptcActivation(events, event) : null;
    if (activation === null) continue;
    if (found === null || event.seq > found.seq) found = { ...activation, seq: event.seq };
  }
  return found;
}

function unconfirmed(reason, extra = {}) {
  return { status: 'unconfirmed', reason, actual: null, declared: null, receipt: null, ...extra };
}

/**
 * Public recovery read. Evidence is the PARENT's own prior normal successful stock
 * `subagent` activation plus its receipt and the child's OWN `request/header` route.
 * The first child request defines the actual route; every later request must carry the
 * identical provider/model/effort or the evidence is conflicting. Any unreadable,
 * missing, inherited-only or conflicting source is unconfirmed; the receipt's
 * `declared` block alone is never actual.
 */
export async function readWorkerRouteEvidence(agent, boundary, signal, ports) {
  try {
    if (signal?.aborted === true) return unconfirmed('aborted');
    if (agent === null || typeof agent !== 'object' || typeof agent.id !== 'string' || agent.id.length === 0) {
      return unconfirmed('invalid-agent');
    }
    const resolved = ports ?? declaredPorts(agent);
    if (resolved === null || resolved === undefined) return unconfirmed('no-session-query');
    const query = resolved.sessionQuery ?? safeGet(agent.ctx, 'sessionQuery');
    const foldRequestHeader = resolved.foldRequestHeader;
    if (query === null || typeof query !== 'object' || typeof query.readSession !== 'function') {
      return unconfirmed('no-session-query');
    }
    if (typeof foldRequestHeader !== 'function') return unconfirmed('no-header-folder');
    if (boundary === null || typeof boundary !== 'object'
      || !BOUNDARY_SOURCES.has(boundary.source)
      || !Number.isSafeInteger(boundary.cutSeq) || boundary.cutSeq < 0) {
      return unconfirmed('invalid-boundary');
    }
    let parent;
    try {
      parent = await query.readSession(agent.id);
    } catch {
      return unconfirmed('parent-unreadable');
    }
    if (parent === null || typeof parent !== 'object' || parent.session === null || typeof parent.session !== 'object'
      || parent.session.id !== agent.id || !truthyArray(parent.events)) {
      return unconfirmed('parent-mismatch');
    }
    const inheritedParent = Number.isSafeInteger(parent.inheritedEventCount) ? parent.inheritedEventCount : 0;
    const prefix = parent.events.filter((event) => Number.isSafeInteger(event?.seq)
      && event.seq >= inheritedParent && event.seq < boundary.cutSeq);
    if (prefix.length === 0) return unconfirmed('no-prior-record');
    if (signal?.aborted === true) return unconfirmed('aborted');
    const activation = lastActivation(prefix);
    if (activation === null) return unconfirmed('no-prior-stock-activation');
    const receipt = parseWorkerRouteReceiptContent(activation.content);
    if (receipt === null) {
      return unconfirmed(markerLike(activation.content) ? 'receipt-unreadable' : 'receipt-missing');
    }
    if (receipt.parentSessionId !== parent.session.id
      || receipt.callId !== activation.callId
      || receipt.rootCallId !== activation.rootCallId) {
      return unconfirmed('receipt-mismatch');
    }
    let child;
    try {
      child = await query.readSession(receipt.childSessionId);
    } catch {
      return unconfirmed('child-unreadable');
    }
    const header = child?.session;
    if (header === null || typeof header !== 'object'
      || header.id !== receipt.childSessionId
      || header.origin !== 'subagent'
      || header.parentSession !== parent.session.id) {
      return unconfirmed('child-header-mismatch');
    }
    if (!truthyArray(child.events)) return unconfirmed('child-unreadable');
    const inheritedChild = Number.isSafeInteger(child.inheritedEventCount) ? child.inheritedEventCount : 0;
    const own = child.events.filter((event) => Number.isSafeInteger(event?.seq) && event.seq >= inheritedChild);
    const headers = own.filter((event) => event?.type === 'request/header');
    if (headers.length === 0) return unconfirmed('child-route-missing');
    const routes = [];
    for (let index = 0; index < headers.length; index += 1) {
      if (signal?.aborted === true) return unconfirmed('aborted');
      const folded = foldRequestHeader(headers.slice(0, index + 1));
      const route = normalizeRoute(folded?.config);
      if (route === null) return unconfirmed('child-route-incomplete');
      routes.push(route);
    }
    const actual = routes[0];
    for (const route of routes.slice(1)) {
      if (!sameRoute(actual, route)) return unconfirmed('child-route-conflicting');
    }
    return {
      status: 'confirmed',
      reason: 'confirmed',
      actual,
      declared: {
        source: 'bound-stock-agent-options',
        provider: receipt.declared.provider,
        model: receipt.declared.model,
        ...(receipt.declared.reasoningEffort === undefined ? {} : { reasoningEffort: receipt.declared.reasoningEffort }),
      },
      receipt,
      parentSessionId: parent.session.id,
      callId: activation.callId,
      rootCallId: activation.rootCallId,
      childSessionId: receipt.childSessionId,
    };
  } catch {
    return unconfirmed('evidence-failed');
  }
}

async function resolveConfiguredRoute(route, llm, signal) {
  if (llm === null || llm === undefined || typeof llm.resolveCallConfig !== 'function') {
    return { ok: false, detail: 'the host llm service cannot resolve the configured worker route' };
  }
  if (cancelled(signal)) return { ok: false, cancel: true };
  try {
    const resolved = await llm.resolveCallConfig(routeRequest(route), signal);
    if (cancelled(signal)) return { ok: false, cancel: true };
    const normalized = normalizeRoute(resolved);
    if (normalized === null || normalized.provider !== route.provider || normalized.model !== route.model) {
      return { ok: false, detail: `the configured worker route ${formatRoute(route)} did not resolve to the same provider and model` };
    }
    if (route.reasoningEffort !== undefined && normalized.reasoningEffort !== route.reasoningEffort) {
      return {
        ok: false,
        detail: `the provider does not support reasoning effort "${route.reasoningEffort}" for ${formatRoute(route)}`,
      };
    }
    return { ok: true, route: normalized };
  } catch (error) {
    const code = typeof error?.code === 'string' && error.code.length > 0 ? ` (${error.code})` : '';
    return { ok: false, detail: `the configured worker route ${formatRoute(route)} cannot be resolved on this host${code}` };
  }
}

/**
 * Install the guard and pre-execute gate for ONE preset revision. `target` is the
 * Agent or the scoped Cordis context the gate row was mounted on; `deps` carries the
 * public ports. Returns the exact disposer for ordered unload.
 */
export function installWorkerGate(target, snapshot, deps) {
  const registrationCtx = contextOf(target);
  if (registrationCtx === null || typeof registrationCtx !== 'object' || typeof registrationCtx.on !== 'function') {
    throw new TypeError('delegation gate: installation requires a Cordis context or an Agent');
  }
  const tools = resolveService(registrationCtx, 'tools');
  if (tools === null || typeof tools !== 'object'
    || typeof tools.guard !== 'function') {
    throw new TypeError('delegation gate: the tools service is required');
  }
  const basePorts = deps ?? declaredPorts(target);
  if (basePorts === null || typeof basePorts !== 'object') {
    throw new TypeError('delegation gate: host ports are not configured');
  }
  const ports = hydratePorts(basePorts, registrationCtx);
  if (typeof ports.scopeOf !== 'function' || typeof ports.scopeChainOf !== 'function') {
    throw new TypeError('delegation gate: scopeOf/scopeChainOf ports are required');
  }
  const route = snapshotWorkerRoute(snapshot);
  if (route !== null) assertEncodableRoute(route);
  // Captured ONCE: the mounted generation key, not a per-call recomputation.
  const gateScope = ports.scopeOf(registrationCtx);
  if (gateScope === undefined) {
    throw new TypeError('delegation gate: installation requires a scoped context');
  }
  /**
   * Three-state ownership. A failed scope introspection is NOT "not mine": it is
   * unknown, and every decision path refuses instead of silently un-gating.
   * @returns {'owned' | 'foreign' | 'unknown'}
   */
  const ownershipOf = (agent) => {
    try {
      if (agent === null || typeof agent !== 'object' || agent.ctx === null || typeof agent.ctx !== 'object') return 'foreign';
      const key = ports.scopeOf(agent.ctx);
      if (key === undefined) return 'foreign';
      const chain = ports.scopeChainOf(key);
      if (!Array.isArray(chain)) return 'unknown';
      return chain.includes(gateScope) ? 'owned' : 'foreign';
    } catch {
      return 'unknown';
    }
  };
  const owns = (agent) => ownershipOf(agent) === 'owned';

  const boundaries = new Map();
  const askedCalls = new Set();
  const unknownReceipts = [];
  const disposers = [];
  let receiptsWritten = 0;
  /** Lazily captured stock definition identity; undefined until the first observation. */
  let frozenStock;
  /** How that identity was established: 'port' | 'generation' | null. */
  let frozenStockSource = null;

  const pruneAsks = (agentId) => {
    const prefix = `${agentId}${ASK_KEY_SEPARATOR}`;
    for (const key of askedCalls) if (key.startsWith(prefix)) askedCalls.delete(key);
  };

  /**
   * The boundary a live Agent's own `agent/created` would have recorded. Used only when
   * the gate is installed on an Agent that already exists, so recovery evidence still
   * runs instead of the state being indistinguishable from a missed lifecycle event.
   * @returns {Readonly<{source: string, cutSeq: number, inheritedEventCount: number}>|null}
   */
  const liveBoundary = (agent) => {
    try {
      const session = agent?.session;
      if (session === null || typeof session !== 'object') return null;
      return Object.freeze({
        source: 'resume',
        cutSeq: Number.isSafeInteger(session.firstLiveSeq) ? session.firstLiveSeq : 0,
        inheritedEventCount: Number.isSafeInteger(session.inheritedEventCount) ? session.inheritedEventCount : 0,
      });
    } catch {
      return null;
    }
  };

  /**
   * The boundary a missed `agent/created` should have recorded. A session created
   * in THIS process is a plain startup; an older one is a resume and still has to
   * prove its route (approval), rather than being denied outright. Before this,
   * any session whose creation event did not reach the gate was a dead end —
   * including the session that opened this very preset, because the gate installs
   * after its Agent already exists.
   */
  const synthesizedBoundary = (agent) => {
    const live = liveBoundary(agent);
    if (live === null) return undefined;
    const createdAt = createdAtOf(agent);
    const source = createdAt !== null && createdAt >= PROCESS_STARTED_AT ? 'startup' : 'resume';
    const boundary = Object.freeze({ ...live, source });
    try {
      if (typeof agent?.id === 'string') boundaries.set(agent.id, boundary);
    } catch {
      // boundary bookkeeping never blocks a decision
    }
    probe('boundary-synthesized', {
      agentId: idOf(agent), source, createdAt, processStartedAt: PROCESS_STARTED_AT,
    });
    return boundary;
  };

  const recordBoundary = ({ agent, source } = {}) => {
    try {
      probe('agent/created', { agentId: idOf(agent), source: String(source), owned: owns(agent) });
      if (!owns(agent) || typeof agent.id !== 'string' || agent.id.length === 0) return;
      if (!BOUNDARY_SOURCES.has(source)) return;
      const session = agent.session;
      // A new lifecycle for this agent retires one-time asks bound to its old call ids.
      pruneAsks(agent.id);
      boundaries.set(agent.id, Object.freeze({
        source,
        cutSeq: Number.isSafeInteger(session?.firstLiveSeq) ? session.firstLiveSeq : 0,
        inheritedEventCount: Number.isSafeInteger(session?.inheritedEventCount) ? session.inheritedEventCount : 0,
      }));
    } catch {
      // Boundary bookkeeping never blocks or crashes the Agent lifecycle.
    }
  };

  // Install-on-live-Agent: its `agent/created` has already been delivered, so seed the
  // boundary that event would have recorded. A later real event may replace it.
  if (target !== registrationCtx && typeof target?.id === 'string' && target.id.length > 0
    && target.ctx === registrationCtx && owns(target)) {
    const seeded = liveBoundary(target);
    if (seeded !== null) boundaries.set(target.id, seeded);
    probe('install', {
      targetId: idOf(target), gateScope: String(gateScope), installedAt: GATE_INSTALLED_AT,
      known: boundaries.size, seeded: seeded !== null,
    });
  }

  const confirmSpawn = (exec, approvedRoute, detail) => {
    const approval = ports.approval ?? safeGet(registrationCtx, 'approval');
    if (approval === null || typeof approval !== 'object' || typeof approval.request !== 'function') {
      return denial(WORKER_ROUTE_DENIAL.APPROVAL_UNAVAILABLE, 'the configured worker route needs a one-time spawn confirmation, but no approval service is composed');
    }
    const session = exec.agent?.session;
    if (session === null || typeof session !== 'object') {
      return denial(WORKER_ROUTE_DENIAL.APPROVAL_UNAVAILABLE, 'the subagent call has no session to audit the confirmation against');
    }
    let policy = 'ask';
    try {
      policy = approval.overrideOf?.(session) ?? approval.config?.policy ?? 'ask';
    } catch {
      policy = 'never';
    }
    if (policy === 'never') {
      return denial(WORKER_ROUTE_DENIAL.APPROVAL_UNAVAILABLE, `the configured worker route ${formatRoute(approvedRoute)} needs a one-time spawn confirmation, but this session approval policy is "never"; start a new session or switch the policy before spawning`);
    }
    if (typeof exec.callId !== 'string' || exec.callId.length === 0) {
      return denial(WORKER_ROUTE_DENIAL.APPROVAL_UNAVAILABLE, 'the subagent call has no call identity, so a one-time grant could not be bound to exactly this call');
    }
    const key = `${exec.agent.id}${ASK_KEY_SEPARATOR}${exec.callId}`;
    if (askedCalls.has(key)) {
      return denial(WORKER_ROUTE_DENIAL.APPROVAL_UNAVAILABLE, 'spawn confirmation for this exact call was already requested once; a repeated ask is not a second grant');
    }
    if (askedCalls.size >= MAX_TRACKED_ASKS) {
      return denial(WORKER_ROUTE_DENIAL.APPROVAL_UNAVAILABLE, 'the one-time confirmation registry is full; this call is denied rather than reusing or dropping an earlier grant');
    }
    askedCalls.add(key);
    return {
      kind: 'ask',
      reason: `${REASON_PREFIX}: ${detail}. Confirm one spawn under the configured worker route ${formatRoute(approvedRoute)}; the grant applies to this call only.`,
      displayReason: {
        en: `Delegation gate: ${detail}. Allow this one subagent spawn under ${formatRoute(approvedRoute)}?`,
        'zh-CN': `委派 gate：${detail}。是否允许本次子代理以「${formatRoute(approvedRoute)}」派发一次？`,
      },
    };
  };

  const guardReason = (exec) => {
    try {
      if (exec?.name !== GATED_TOOL) return undefined;
      if (exec.agent === null || exec.agent === undefined) {
        return `${WORKER_ROUTE_DENIAL.UNCONFIGURED}: the subagent call has no calling agent, so no preset revision can own it`;
      }
      const owner = ownershipOf(exec.agent);
      if (owner === 'foreign') return undefined;
      if (owner === 'unknown') {
        return `${WORKER_ROUTE_DENIAL.RECOVERY_UNCONFIRMED}: the delegation gate could not verify whether this subagent call belongs to its preset revision`;
      }
      if (route === null) {
        return `${WORKER_ROUTE_DENIAL.UNCONFIGURED}: no worker route is configured for this preset; the subagent was not started`;
      }
      if (ports.llm === null || ports.llm === undefined || typeof ports.llm.resolveCallConfig !== 'function') {
        return `${WORKER_ROUTE_DENIAL.UNCONFIGURED}: the host llm service cannot resolve the configured worker route ${formatRoute(route)}`;
      }
      return undefined;
    } catch {
      return `${WORKER_ROUTE_DENIAL.UNCONFIGURED}: the delegation gate could not verify this subagent call identity`;
    }
  };

  const preExecute = async (exec, next) => {
    if (exec?.name !== GATED_TOOL) return next();
    if (exec.agent === null || exec.agent === undefined) {
      return denial(WORKER_ROUTE_DENIAL.UNCONFIGURED, 'the subagent call has no calling agent, so no preset revision can own it');
    }
    const owner = ownershipOf(exec.agent);
    probe('dispatch', {
      agentId: idOf(exec.agent), callId: typeof exec.callId === 'string' ? exec.callId : null,
      owner, known: boundaries.size, hasBoundary: boundaries.has(String(exec.agent?.id)),
      createdAt: createdAtOf(exec.agent), installedAt: GATE_INSTALLED_AT,
    });
    if (owner === 'foreign') return next();
    if (owner === 'unknown') {
      return denial(WORKER_ROUTE_DENIAL.RECOVERY_UNCONFIRMED, 'the delegation gate could not verify whether this subagent call belongs to its preset revision, so the previous execution route cannot be checked');
    }
    if (cancelled(exec.signal)) return { kind: 'cancel' };
    if (route === null) {
      return denial(WORKER_ROUTE_DENIAL.UNCONFIGURED, 'no worker route is configured for this preset; the subagent was not started');
    }
    const gone = () => denial(WORKER_ROUTE_DENIAL.UNCONFIGURED, 'the delegation gate scope was disposed before a child was created');
    const resolved = await resolveConfiguredRoute(route, ports.llm, exec.signal);
    if (resolved.cancel === true) return { kind: 'cancel' };
    if (resolved.ok !== true) {
      return denial(WORKER_ROUTE_DENIAL.UNCONFIGURED, resolved.detail);
    }
    if (cancelled(exec.signal)) return { kind: 'cancel' };
    if (disposed) return gone();
    const boundary = boundaries.get(exec.agent.id) ?? synthesizedBoundary(exec.agent);
    if (boundary === undefined) {
      probe('boundary-missing', {
        agentId: idOf(exec.agent),
        callId: typeof exec.callId === 'string' ? exec.callId : null,
        known: boundaries.size,
        createdAt: createdAtOf(exec.agent),
        installedAt: GATE_INSTALLED_AT,
      });
      return denial(WORKER_ROUTE_DENIAL.RECOVERY_UNCONFIRMED, 'no lifecycle boundary was recorded for this agent, so the previous execution route cannot be checked; the gate was installed after this agent started or the lifecycle event never reached it');
    }
    if (boundary.source !== 'startup') {
      const evidence = await readWorkerRouteEvidence(exec.agent, boundary, exec.signal, ports);
      if (disposed) return gone();
      if (evidence.status !== 'confirmed') {
        return confirmSpawn(exec, resolved.route,
          `${WORKER_ROUTE_DENIAL.RECOVERY_UNCONFIRMED}: the previous execution route cannot be proven (${evidence.reason})`);
      }
      if (!sameRoute(evidence.actual, resolved.route)) {
        return confirmSpawn(exec, resolved.route,
          `the persisted ${formatRoute(evidence.actual)} differs from the configured worker route`);
      }
    }
    if (cancelled(exec.signal)) return { kind: 'cancel' };
    if (disposed) return gone();
    return next();
  };

  const noteUnknownReceipt = (callId, reason) => {
    if (unknownReceipts.length >= MAX_RECORDED_UNKNOWNS) return;
    unknownReceipts.push(Object.freeze({
      callId: typeof callId === 'string' && callId.length > 0 ? callId : null,
      reason,
    }));
  };

  /**
   * Resolve the stock `subagent` definition identity lazily. The gate's own row context
   * is the anchor inside the generation; the agent-scoped view must resolve to the SAME
   * object, so a global shadow or a replaced row can never receive a receipt. An explicit
   * `stockSubagentDefinition` port, when a generation-scoped integration entry supplies
   * one, is authoritative and must match on every call.
   * @returns {{status: 'confirmed'|'unknown', reason?: string, stock?: object, source?: string}}
   */
  const stockIdentity = (exec) => {
    try {
      if (typeof ports.tools?.get !== 'function') return { status: 'unknown', reason: 'tools-get-unavailable' };
      const agentScope = ports.scopeOf(exec.agent.ctx);
      if (agentScope === undefined) return { status: 'unknown', reason: 'agent-scope-unavailable' };
      const seen = ports.tools.get(GATED_TOOL, agentScope);
      if (frozenStock === undefined) {
        const declared = ports.stockSubagentDefinition;
        if (declared !== null && declared !== undefined) {
          frozenStock = declared;
          frozenStockSource = 'port';
        } else {
          const generationStock = ports.tools.get(GATED_TOOL, gateScope);
          if (generationStock === null || generationStock === undefined) {
            return { status: 'unknown', reason: 'generation-stock-missing' };
          }
          if (seen !== generationStock) return { status: 'unknown', reason: 'agent-view-differs-from-generation-stock' };
          frozenStock = generationStock;
          frozenStockSource = 'generation';
        }
      }
      if (seen !== frozenStock) return { status: 'unknown', reason: 'stock-definition-identity-changed' };
      return { status: 'confirmed', stock: frozenStock, source: frozenStockSource };
    } catch {
      return { status: 'unknown', reason: 'identity-check-threw' };
    }
  };

  const postExecute = async (exec, result, next) => {
    const decision = await next();
    try {
      if (exec?.name !== GATED_TOOL) return decision;
      if (ownershipOf(exec.agent) !== 'owned') return decision;
      // Resolve the stock definition by SCOPE KEY, lazily, from inside this generation.
      // Never by the Agent object: `tools.get(name, scope?)` takes a ScopeKey, and the
      // generation row only appears through that key's chain.
      const identity = stockIdentity(exec);
      if (identity.status !== 'confirmed') {
        noteUnknownReceipt(exec.callId, identity.reason);
        return decision;
      }
      if (result?.isError === true) return decision;
      if (decision === null || typeof decision !== 'object' || decision.kind !== 'accept') return decision;
      if (Object.hasOwn(decision, 'value')) return decision;
      if (route === null) return decision;
      const value = result.value;
      if (value === null || typeof value !== 'object' || value.kind !== 'activation'
        || typeof value.subagentId !== 'string' || value.subagentId.length === 0) return decision;
      const kept = decision.content ?? result.content;
      if (!Array.isArray(kept)) return decision;
      const receipt = {
        schema: WORKER_ROUTE_RECEIPT_SCHEMA,
        parentSessionId: exec.agent.id,
        callId: exec.callId,
        rootCallId: exec.rootCallId ?? exec.callId,
        toolName: GATED_TOOL,
        childSessionId: value.subagentId,
        declared: {
          source: 'bound-stock-agent-options',
          provider: route.provider,
          model: route.model,
          ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
        },
        actual: { status: 'not-established-by-receipt' },
      };
      const text = WORKER_ROUTE_RECEIPT_PREFIX + JSON.stringify(receipt);
      if (parseWorkerRouteReceiptText(text) === null) {
        noteUnknownReceipt(exec.callId, 'receipt-encoding-rejected');
        return decision;
      }
      receiptsWritten += 1;
      return { ...decision, content: [...kept, { type: 'text', text }] };
    } catch {
      noteUnknownReceipt(exec?.callId, 'writer-threw');
      return decision;
    }
  };

  disposers.push(tools.guard(guardReason));
  disposers.push(registrationCtx.on('tools/pre-execute', preExecute));
  disposers.push(registrationCtx.on('agent/created', recordBoundary));
  // Always registered: the stock definition identity is captured lazily at post-execute
  // time from this generation, so the shipped `apply()` entry can write receipts too.
  disposers.push(registrationCtx.on('tools/post-execute', postExecute));

  let disposed = false;
  /**
   * Read-only decision record for tests and diagnostics. The receipt writer never
   * silently skips: every unwritten receipt is recorded here with its reason.
   */
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    boundaries.clear();
    askedCalls.clear();
    frozenStock = undefined;
    for (const unwire of disposers.reverse()) {
      try {
        const result = unwire();
        if (result !== null && typeof result === 'object' && typeof result.then === 'function') void result;
      } catch {
        // An unload failure must not reopen the gate; the scope disposal still runs.
      }
    }
  };
  dispose.diagnostics = () => Object.freeze({
    receipts: receiptsWritten,
    stockSource: frozenStockSource,
    unknownReceipts: Object.freeze(unknownReceipts.slice()),
    boundaries: Object.freeze([...boundaries.keys()]),
  });
  return dispose;
}

/**
 * Cordis plugin entry for the preset row `delegation-gate` with `{ workerRoute }`.
 * The route comes from the row config only; a preset-subtree plugin has no settings
 * namespace. The host ports are declared by the integration entry.
 */
export function apply(ctx, config) {
  const ports = declaredPorts(ctx);
  if (ports === null || ports === undefined) {
    throw new TypeError('delegation gate: host ports are not configured; the preset gate cannot be mounted ungated');
  }
  ctx.effect(() => installWorkerGate(ctx, config?.workerRoute ?? null, ports));
}

export default { name, inject, apply };
