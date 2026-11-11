// Official PTC rows live in assets/delegation/official-ptc.json,校对自 dsh-v0.2.2-rc.1.
// Copyright (c) 2026 DeepSeek. MIT notice and pinned rc.5 YAML: assets/delegation/provenance.json.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotWorkerRoute } from './delegation-config.js';

/** @typedef {import('./delegation-config.js').WorkerRoute} WorkerRoute */
/** @typedef {Readonly<{id: string, name: string, description: string, order: number, plugins: readonly object[]}>} PresetDefinition */
/** @typedef {Readonly<{id: string, name: string, reason: string}>} DroppedRow */
/** @typedef {{resolve?: (name: string) => string}} BuildOptions */

export const PURE_PRESET_ID = 'clean-desktop-shell-ptc';
export const ROUTER_PRESET_ID = 'clean-desktop-shell-ptc-router';

// Only this installed package's static assets are read; never a profile or a live route.
const officialRows = JSON.parse(readFileSync(new URL('../../assets/delegation/official-ptc.json', import.meta.url), 'utf8')).rows;
const approvedPersona = readFileSync(new URL('../../assets/delegation/persona.md', import.meta.url), 'utf8');
const officialPrefix = 'You are a coding agent powered by the {{model}} model.';
const officialPlanSection = `You are in plan mode. Stay in plan mode until the user approves your plan through exit_plan_mode or switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.

Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.

The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed to keep the tool catalog unchanged. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.

Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.

Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.

When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.
`;

const requireFromHere = createRequire(import.meta.url);

/** The Host's own node_modules directory, or null when this process cannot see it. */
function hostNodeModules() {
  try {
    // <install>/node_modules/@deepseek-ai/dsh/package.json → <install>/node_modules
    return join(dirname(requireFromHere.resolve('@deepseek-ai/dsh/package.json')), 'node_modules');
  } catch {
    return null;
  }
}

/** This plugin's own package root, so its rows validate against its exports. */
const ownPackageRoot = new URL('../../', import.meta.url);
const ownPackageName = 'dsh-clean-desktop-shell';

/**
 * Resolve a row name the way the Host's Loader does: inside the Host's own
 * installation. Node's resolver from this plugin is not an honest oracle — it
 * misses every package the Host carries in its own node_modules (they are not
 * on this plugin's search path) and honours unrelated hoisting the Loader never
 * consults. Our own rows resolve against this package instead.
 * @param {string} name
 * @param {string|null} [installNodeModules]
 */
function installResolve(name, installNodeModules = hostNodeModules()) {
  const parts = name.split('/');
  const scoped = parts[0].startsWith('@');
  const packageName = scoped ? parts.slice(0, 2).join('/') : parts[0];
  const sub = (scoped ? parts.slice(2) : parts.slice(1)).join('/');
  const own = packageName === ownPackageName;
  const pkgDir = own
    ? fileURLToPath(ownPackageRoot)
    : installNodeModules === null
      ? null
      : scoped
        ? join(installNodeModules, parts[0], parts[1])
        : join(installNodeModules, parts[0]);
  if (pkgDir === null) throw new Error('the Host installation is not visible from this plugin');
  const pkgFile = join(pkgDir, 'package.json');
  if (!existsSync(pkgFile)) throw new Error(`not installed with the Host: ${name}`);
  if (!sub) return pkgDir;
  let exportsField;
  try {
    exportsField = JSON.parse(readFileSync(pkgFile, 'utf8')).exports;
  } catch {
    exportsField = undefined;
  }
  const key = `./${sub}`;
  const exported = typeof exportsField === 'object' && exportsField !== null
    && Object.keys(exportsField).some((entry) => entry === key || (entry.endsWith('/*') && key.startsWith(entry.slice(0, -1))));
  if (!exported) throw new Error(`the package does not export ./${sub}: ${name}`);
  return pkgDir;
}

/** 默认按 Host 安装目录查找候选包。 */
const defaultResolve = (name) => installResolve(name);

/** Whether this process can see the Host's own plugin packages at all. */
function dshInstallVisible() {
  return hostNodeModules() !== null;
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** 复制成新的普通对象/数组，切断与快照资产及上次调用的共享引用。 */
function copyValue(value) {
  if (Array.isArray(value)) return value.map(copyValue);
  if (value !== null && typeof value === 'object') {
    const copy = {};
    for (const [key, child] of Object.entries(value)) copy[key] = copyValue(child);
    return copy;
  }
  return value;
}

function reasonOf(error) {
  const message = error instanceof Error ? error.message : String(error);
  // Keep the reported reason to one line: MODULE_NOT_FOUND appends a machine-path require stack.
  const firstLine = message.split(/\r?\n/, 1)[0].trim();
  return firstLine || 'package could not be resolved';
}

/**
 * 每次构建独立的解析记录：同一个 name 只查一次，同一行只记录一次。
 * @param {(name: string) => string} resolve
 * @param {DroppedRow[]} dropped
 */
function createRowValidator(resolve, dropped) {
  const checked = new Map();
  const recorded = new Set();
  return function keep(row) {
    if (!checked.has(row.name)) {
      try {
        resolve(row.name);
        checked.set(row.name, null);
      } catch (error) {
        checked.set(row.name, reasonOf(error));
      }
    }
    const reason = checked.get(row.name);
    if (reason === null) return true;
    if (!recorded.has(row.id)) {
      recorded.add(row.id);
      dropped.push(Object.freeze({ id: row.id, name: row.name, reason }));
    }
    return false;
  };
}

/**
 * 把快照行填充为可注册行：填槽、按平台置 disabled、丢弃不可解析的行。
 * @param {object} row 官方快照中的一行
 * @param {{keep: (row: object) => boolean, platform: string, personaPrefix: string, planSection: string, router: boolean, workerRoute: WorkerRoute|null}} context
 * @returns {object|null}
 */
function materializeRow(row, context) {
  if (row.group === true) {
    const next = {};
    for (const [key, value] of Object.entries(row)) {
      if (key === 'slot' || key === 'disabledWhen') continue;
      next[key] = key === 'config'
        ? row.config.map((child) => materializeRow(child, context)).filter((child) => child !== null)
        : copyValue(value);
    }
    return next;
  }
  if (!context.keep(row)) return null;
  const next = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === 'slot' || key === 'disabledWhen') continue;
    next[key] = copyValue(value);
  }
  if (row.disabledWhen === 'win32') next.disabled = context.platform === 'win32';
  if (row.disabledWhen === 'not-win32') next.disabled = context.platform !== 'win32';
  if (row.slot === 'persona') next.config = { ...(next.config ?? {}), prefix: context.personaPrefix };
  if (row.slot === 'plan-mode') next.config = { ...(next.config ?? {}), section: context.planSection };
  if (row.slot === 'spawn' && context.router) {
    next.config = { ...(next.config ?? {}), maxDepth: 1 };
    if (context.workerRoute) next.config.agentOptions = context.workerRoute;
  }
  return next;
}

/**
 * 从官方快照派生一组行；路由版在 delegation 组末尾追加本插件 gate。
 * @param {{platform: string, personaPrefix: string, workerRoute: WorkerRoute|null, router: boolean, keep: (row: object) => boolean}} context
 */
function buildRows(context) {
  const rows = officialRows.map((row) => materializeRow(row, context)).filter((row) => row !== null);
  if (!context.router) return rows;
  const delegationRow = rows.find((row) => row.id === 'delegation');
  if (!delegationRow) return rows;
  const gate = { id: 'delegation-gate', name: 'dsh-clean-desktop-shell/delegation-gate', config: { workerRoute: context.workerRoute } };
  if (context.keep(gate)) delegationRow.config.push(gate);
  return rows;
}

/**
 * 构建双预设：官方等价副本与主脑分工版。每次调用产生全新普通深快照，不挂载插件。
 * 逐行校验包名；解析失败只丢弃该行并记录，绝不让整份预设失败。
 * @param {WorkerRoute|null} route
 * @param {string} [platform=process.platform] 默认当前 Host 平台；测试可显式传入。
 * @param {BuildOptions} [options]
 * @returns {{pure: PresetDefinition, router: PresetDefinition, dropped: readonly DroppedRow[]}}
 */
export function buildDelegationPresets(route, platform = process.platform, options = {}) {
  const workerRoute = snapshotWorkerRoute(route);
  const explicitResolve = typeof options.resolve === 'function';
  const resolve = explicitResolve ? options.resolve : defaultResolve;
  // Resolution is only a usable oracle when the Host's own installation is
  // visible from here. Running from a source checkout (no @deepseek-ai/*) it
  // would drop every row and publish a hollow preset, so validation backs off
  // and the loader's own health check stays the authority.
  const validationSkipped = !explicitResolve && !dshInstallVisible();
  /** @type {DroppedRow[]} */
  const dropped = [];
  const keep = validationSkipped ? (row) => row : createRowValidator(resolve, dropped);
  const workerRouteLabel = workerRoute
    ? `${workerRoute.provider} / ${workerRoute.model}${workerRoute.reasoningEffort ? `（reasoningEffort: ${workerRoute.reasoningEffort}）` : ''}`
    : '未配置的执行路由';
  const personaPrefix = `${officialPrefix}\n\n${approvedPersona.replaceAll('{{workerRouteLabel}}', () => workerRouteLabel)}`;

  const pure = deepFreeze({
    id: PURE_PRESET_ID,
    name: 'PTC（插件）',
    description: '与官方 PTC 等价的插件副本，行由官方快照派生。',
    order: 2,
    plugins: buildRows({ platform, personaPrefix: officialPrefix, planSection: officialPlanSection, workerRoute, router: false, keep }),
  });
  const router = deepFreeze({
    id: ROUTER_PRESET_ID,
    name: 'PTC + 主脑分工',
    description: '保留官方 PTC。主脑与 fork 负责决策，spawn 使用已配置执行路由。',
    order: 2,
    plugins: buildRows({ platform, personaPrefix, planSection: officialPlanSection, workerRoute, router: true, keep }),
  });
  return { pure, router, dropped: deepFreeze(dropped), validationSkipped };
}

/**
 * 兼容导出：等价于 buildDelegationPresets(...).router。
 * @param {WorkerRoute|null} route
 * @param {string} [platform=process.platform]
 * @param {BuildOptions} [options]
 * @returns {PresetDefinition}
 */
export function buildDelegationPreset(route, platform = process.platform, options = {}) {
  return buildDelegationPresets(route, platform, options).router;
}

/**
 * 发布器要的是数组，且只发布主脑分工版：官方 PTC 已经在预设列表里，
 * 插件再发一份等价副本只是重复卡片。`pure` 保留为构建基线（测试用它
 * 证明 router = 官方行 + 差异），不对外注册。
 * @param {{pure: PresetDefinition, router: PresetDefinition}} built
 * @returns {readonly PresetDefinition[]}
 */
export function presetList(built) {
  return Object.freeze([built.router]);
}
