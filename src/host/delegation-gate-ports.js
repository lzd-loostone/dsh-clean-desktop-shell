// Host port declaration for the preset-subtree delegation gate.
//
// The published preset is a plain YAML/JSON declaration, so its row `delegation-gate` cannot
// carry function references. This Host entry declares the stateless ports the gate needs as a
// service named `delegationGatePorts` before the publisher registers a preset generation
// (see .dsh-tmp/ptc-brain-delegation/sdd/task-4-report.md §6). The gate reads that service
// from its own preset-subtree context; the remaining ports (tools, approval, llm,
// sessionQuery) are hydrated from the same context, so they are deliberately NOT shadowed here.
//
// scopeOf/scopeChainOf and foldRequestHeader come from the installed DSH runtime, exactly as
// the stock subagent tool imports them. No package is bundled a second time.
import { scopeChainOf, scopeOf } from '@deepseek-ai/dsh-scope';
import { foldRequestHeader } from '@deepseek-ai/dsh-session';

/** Service name the preset gate looks up. Frozen by the Task 4 integration seam. */
export const GATE_PORTS_SERVICE = 'delegationGatePorts';

export const name = 'dsh-clean-desktop-shell/delegation-gate-ports';

export const inject = [];

/**
 * The stateless ports, frozen so a gate cannot mutate the shared declaration.
 * @returns {Readonly<{ scopeOf: Function, scopeChainOf: Function, foldRequestHeader: Function }>}
 */
export function createWorkerGatePorts() {
  return Object.freeze({ scopeOf, scopeChainOf, foldRequestHeader });
}

/**
 * Cordis plugin entry for the profile row `dsh-clean-desktop-shell/delegation-gate-ports`.
 * `ctx.provide` is itself a fiber effect, so unload removes the service with this row.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  if (typeof ctx?.provide !== 'function') {
    throw new TypeError('delegation gate ports: ctx.provide is required');
  }
  return ctx.provide(GATE_PORTS_SERVICE, createWorkerGatePorts());
}

export default { name, inject, apply };
