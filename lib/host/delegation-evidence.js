// Pure receipt protocol helpers only. No SDK, lifecycle, approval or actual-route binding.
// A receipt can only declare the worker options bound to one stock subagent activation;
// it never establishes the child's actual route.
import { Buffer } from 'node:buffer';

const SCHEMA = 'dsh-clean-desktop-shell/worker-route-receipt@1';
const MARKER = `[${SCHEMA}] `;

/** Frozen protocol identity, exported for the real receipt writer/reader adapters. */
export const WORKER_ROUTE_RECEIPT_SCHEMA = SCHEMA;
export const WORKER_ROUTE_RECEIPT_PREFIX = MARKER;

const FAMILY = '[dsh-clean-desktop-shell/worker-route-receipt';
const MAX_BYTES = 16_384;
const ID_KEYS = Object.freeze(['parentSessionId', 'callId', 'rootCallId', 'childSessionId']);
const RECEIPT_KEYS = Object.freeze(['schema', ...ID_KEYS, 'toolName', 'declared', 'actual']);
const ACTIVATION_KEYS = Object.freeze([
  'sourceKind', 'trusted', 'complete', 'success', 'stock', 'associationsVerified', 'toolName', ...ID_KEYS,
]);
const ACTIVATION_FLAGS = Object.freeze(['trusted', 'complete', 'success', 'stock', 'associationsVerified']);
const ACTIVATION_SOURCES = Object.freeze(['native-tool-result', 'ptc-inner-stock-settle']);

/** JSON-like plain record: ordinary prototype, string keys, enumerable data properties only. */
function isPlainRecord(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && descriptor.enumerable === true && Object.hasOwn(descriptor, 'value');
  });
}

/** Exact frozen key set at one level; missing, extra or non-data keys are all rejected. */
function hasExactKeys(value, required, optional = []) {
  if (!isPlainRecord(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

/** Frozen code-unit bound; the original string is never trimmed, normalized or truncated. */
function isBoundedString(value, maximum) {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximum && value.trim().length > 0;
}

/** Full frozen receipt shape; `actual` stays explicitly not established. */
function isReceiptShape(value) {
  if (!hasExactKeys(value, RECEIPT_KEYS)) return false;
  if (value.schema !== SCHEMA || value.toolName !== 'subagent') return false;
  if (!ID_KEYS.every((key) => isBoundedString(value[key], 256))) return false;
  const declared = value.declared;
  if (!hasExactKeys(declared, ['source', 'provider', 'model'], ['reasoningEffort'])) return false;
  if (declared.source !== 'bound-stock-agent-options') return false;
  if (!isBoundedString(declared.provider, 512) || !isBoundedString(declared.model, 1024)) return false;
  if (Object.hasOwn(declared, 'reasoningEffort') && !isBoundedString(declared.reasoningEffort, 64)) return false;
  return hasExactKeys(value.actual, ['status']) && value.actual.status === 'not-established-by-receipt';
}

/** Candidate declaration only: a marker never authenticates its source or proves actual routing. */
export function parseWorkerRouteReceiptText(text) {
  // Transport cap first: an oversized or non-string payload is never parsed.
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_BYTES || !text.startsWith(MARKER)) return null;
  const payload = text.slice(MARKER.length);
  try {
    const value = JSON.parse(payload);
    // Exact stock-writer serialization rejects duplicate keys, escaped rewrites, extra whitespace
    // and any appended second envelope instead of picking a best-effort reading.
    if (JSON.stringify(value) !== payload) return null;
    return isReceiptShape(value) ? value : null;
  } catch {
    return null;
  }
}

/** Pure normalized content projection; not a raw Native/PTC event adapter. */
export function parseWorkerRouteReceiptContent(content) {
  if (!Array.isArray(content)) return null;
  try {
    let receiptText = null;
    for (const block of content) {
      if (!isPlainRecord(block)) return null;
      const body = block.text;
      if (block.type === 'text' && typeof body !== 'string') return null;
      if (typeof body !== 'string') continue;
      const markerLike = body.includes(FAMILY) || (body.length > 0 && MARKER.startsWith(body));
      if (!markerLike) continue;
      // Two marker-like blocks are ambiguous; never select one of them.
      if (receiptText !== null) return null;
      if (!hasExactKeys(block, ['type', 'text']) || block.type !== 'text') return null;
      receiptText = body;
    }
    return receiptText === null ? null : parseWorkerRouteReceiptText(receiptText);
  } catch {
    return null;
  }
}

/**
 * Internal pure association port, NOT an SDK schema or public/user-input boundary.
 * A future trusted history adapter must independently establish every flag/identity:
 * Native stock tool-result or PTC inner stock start/settle, complete successful event,
 * and exact parent/call/root/child linkage. Raw user/model/outer run_code text is ineligible.
 * No adapter is implemented here. Even an associated receipt declares options only;
 * the child's OWN header/request actual evidence must still be bound independently.
 */
export function associateWorkerRouteReceipt(content, activation) {
  const unknown = { status: 'unknown' };
  try {
    if (!hasExactKeys(activation, ACTIVATION_KEYS)) return unknown;
    if (!ACTIVATION_SOURCES.includes(activation.sourceKind) || activation.toolName !== 'subagent') return unknown;
    if (!ACTIVATION_FLAGS.every((key) => activation[key] === true)) return unknown;
    if (!ID_KEYS.every((key) => isBoundedString(activation[key], 256))) return unknown;
    const receipt = parseWorkerRouteReceiptContent(content);
    if (receipt === null || !ID_KEYS.every((key) => receipt[key] === activation[key])) return unknown;
    return { status: 'declared-only', receipt };
  } catch {
    return unknown;
  }
}
