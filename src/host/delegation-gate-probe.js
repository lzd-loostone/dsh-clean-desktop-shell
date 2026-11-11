// 诊断探针：只写 JSONL 到本地文件，不参与任何判定。
// **默认关闭**：常驻写盘会让每次 spawn 都产生磁盘 IO，也会把一个调试文件写进用户主目录。
// 排查时显式打开：DSH_GATE_PROBE=1（可另用 DSH_GATE_PROBE_LOG 指定路径）。
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ENABLED = process.env.DSH_GATE_PROBE === '1';
const FILE = process.env.DSH_GATE_PROBE_LOG || join(homedir(), '.dsh', 'delegation-gate-probe.jsonl');

/** @param {string} event @param {Record<string, unknown>} [data] */
export function probe(event, data = {}) {
  if (!ENABLED) return;
  try {
    appendFileSync(FILE, `${JSON.stringify({ t: Date.now(), pid: process.pid, event, ...data })}\n`);
  } catch {
    // 探针失败绝不影响 gate
  }
}

/** @param {unknown} value @returns {string|null} */
export function idOf(value) {
  try {
    return value && typeof value === 'object' && typeof value.id === 'string' ? value.id : null;
  } catch {
    return null;
  }
}
