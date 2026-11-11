# 桌面壳后端韧性优化 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除桌面壳的五类故障：假宕机刷新、不自动启动、首次启动失败、PWA 窗口 401、进度窗口置顶遮挡。

**Architecture:** 把无法单测的 Electron 协作逻辑收敛到两个纯模块（`start-policy.js`、`progress-placement.js`），用 `node --test` 钉住判定规则；`service.js` / `progress.js` / `main.js` / `open-dsh.js` 只做接线。不改 DSH 核心，不新增依赖。

**Tech Stack:** Electron 主进程（ESM）、`node:test`、`node:assert/strict`。

**Spec:** 本计划即规格；根因证据见对话记录 m03814 / m03890 与 `overlay-trace.log`。

## Global Constraints

- 平台仅 Windows 走 PWA 路径；macOS 保持 `shell.openExternal` 兜底。
- 纯模块（无 `electron` 导入）必须能被 `node --test electron/<name>.test.js` 直接运行。
- 不新增运行时依赖；不修改 `deepseek-harness/` 源码。
- 探活默认超时 3000ms；连续 2 次失败才判 down；进度窗口成功即关、失败 3s 关、busy 20s 自动隐藏。
- 坏窗口只记录日志、不自动关闭（用户决策 D2）。

## Review Focus

- 后端慢但未死时（插件页拉 2 MB JSON）：期望零刷新，实际若阈值回退会重现刷新风暴 → T1/T2 的组合测试。
- 端口被上一轮残留进程占用：期望自动清理后启动成功，实际若跳过清理会 bind 失败 → T3 的 `decideStartPlan` 覆盖。
- 端口上有后端但本进程无 token：期望自动重启换 token，实际若静默返回会打开 401 页面 → T3 + T6。
- 进度窗口在失败态长期无人关闭：期望 3s 自关，实际若计时器挂错状态会永久遮挡 → T4。
- 壳退出时后端仍在跑：期望被终止，实际若 before-quit 异步未 await 会留孤儿 → T5。

---

### Task 1: 探活分级与默认超时

**Files:**
- Modify: `electron/probe.js`
- Test: `electron/probe.test.js`

**Interfaces:**
- Produces: `DEFAULT_PROBE_TIMEOUT_MS: number`（3000）；`probeOutcome(url: string, timeoutMs?: number): Promise<{ kind: 'ok' | 'unauthenticated' | 'unhealthy' | 'down', status: number | null }>`；`probe(url, timeoutMs?): Promise<boolean>`（保持布尔语义，`ok` 与 `unauthenticated` 都为 true）。

- [ ] **Step 1: 写失败测试**

在 `electron/probe.test.js` 追加：

```js
test('401 is alive but reported as unauthenticated', async () => {
  const { server, url } = await listen((_req, res) => { res.writeHead(401); res.end() })
  try {
    assert.deepEqual(await probeOutcome(url, 1000), { kind: 'unauthenticated', status: 401 })
    assert.equal(await probe(url, 1000), true)
  } finally { server.close() }
})

test('200 is ok and 502 is unhealthy', async () => {
  const ok = await listen((_req, res) => { res.writeHead(200); res.end() })
  const bad = await listen((_req, res) => { res.writeHead(502); res.end() })
  try {
    assert.equal((await probeOutcome(ok.url, 1000)).kind, 'ok')
    assert.equal((await probeOutcome(bad.url, 1000)).kind, 'unhealthy')
    assert.equal(await probe(bad.url, 1000), false)
  } finally { ok.server.close(); bad.server.close() }
})

test('the default budget is three seconds', () => {
  assert.equal(DEFAULT_PROBE_TIMEOUT_MS, 3000)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test electron/probe.test.js`
Expected: FAIL，`probeOutcome is not a function`。

- [ ] **Step 3: 实现**

`probe.js` 导出 `DEFAULT_PROBE_TIMEOUT_MS = 3000`；`probeOutcome` 用一次 `fetch`，`AbortSignal.timeout(timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS)`，catch 返回 `{ kind: 'down', status: null }`；状态 200–399 → `ok`，401/403 → `unauthenticated`，其余 >=500 → `unhealthy`，400–499 其他 → `ok`（服务活着）。`probe` 改为 `const o = await probeOutcome(...); return o.kind === 'ok' || o.kind === 'unauthenticated'`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test electron/probe.test.js`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add electron/probe.js electron/probe.test.js
git commit -m "[feat] 探活分级并放宽默认超时"
```

---

### Task 2: 连续失败阈值与探活计时

**Files:**
- Modify: `electron/backend-watch.js`
- Test: `electron/backend-watch.test.js`

**Interfaces:**
- Consumes: Task 1 的 `probe`。
- Produces: `FAIL_THRESHOLD = 2`；`watchBackend({ url, probe, onRestart, intervalMs, failThreshold })`（新增 `failThreshold`，默认 2）；`timedProbe(probeImpl: (url?: string) => Promise<boolean>, trace: (line: string) => void): (url?: string) => Promise<boolean>`。

- [ ] **Step 1: 写失败测试**

```js
test('one failed probe is not a down state', async () => {
  const states = [true, true, false, true, true]
  let fired = 0
  const stop = watchBackend({ probe: async () => states.shift() ?? true, onRestart: () => { fired++ }, intervalMs: 1 })
  await new Promise((r) => setTimeout(r, 40)); stop()
  assert.equal(fired, 0)
})

test('two consecutive failures then up fires once', async () => {
  const states = [true, false, false, true]
  let fired = 0
  const stop = watchBackend({ probe: async () => states.shift() ?? true, onRestart: () => { fired++ }, intervalMs: 1 })
  await new Promise((r) => setTimeout(r, 40)); stop()
  assert.equal(fired, 1)
})

test('timedProbe reports duration and result', async () => {
  const lines = []
  const traced = timedProbe(async () => true, (l) => lines.push(l))
  assert.equal(await traced('http://x/'), true)
  assert.match(lines[0], /^probe ok \d+ms http:\/\/x\/$/)
})
```

- [ ] **Step 2: 运行确认失败**（`timedProbe is not a function`，且首条 `fired` 变成 1）

Run: `node --test electron/backend-watch.test.js`

- [ ] **Step 3: 实现**

`tick` 内维护 `failures`：成功清零；失败自增；`down = lastUp === false && failures >= failThreshold` 只在 `lastUp === true` 且失败累计达阈值时置 down；`cameBack = up && lastUp === false`。首拍仍是 baseline。`timedProbe` 包一层计时并调用 `trace('probe ' + (up ? 'ok' : 'fail') + ' ' + ms + 'ms ' + (url ?? ''))`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test electron/backend-watch.test.js`
Expected: PASS（原 3 条 + 新 3 条）。

- [ ] **Step 5: 提交**

```bash
git add electron/backend-watch.js electron/backend-watch.test.js
git commit -m "[fix] 连续失败才判后端宕机"
```

---

### Task 3: 启动决策纯模块

**Files:**
- Create: `electron/start-policy.js`
- Test: `electron/start-policy.test.js`

**Interfaces:**
- Produces: `decideStartPlan({ health: 'ok' | 'unauthenticated' | 'unhealthy' | 'down', hasOwnChild: boolean, hasToken: boolean }): 'reuse' | 'restart-to-mint-token' | 'spawn'`；`shouldRetrySpawn(attempt: number): boolean`（`attempt === 1` 时为 true，即最多重试一次）。

- [ ] **Step 1: 写失败测试**

```js
import { decideStartPlan, shouldRetrySpawn } from './start-policy.js'

test('an unauthenticated backend is restarted to mint a token', () => {
  assert.equal(decideStartPlan({ health: 'unauthenticated', hasOwnChild: false, hasToken: false }), 'restart-to-mint-token')
})

test('our own healthy child with a token is reused', () => {
  assert.equal(decideStartPlan({ health: 'ok', hasOwnChild: true, hasToken: true }), 'reuse')
})

test('a healthy external backend without a token is restarted', () => {
  assert.equal(decideStartPlan({ health: 'ok', hasOwnChild: false, hasToken: false }), 'restart-to-mint-token')
})

test('a dead port spawns, and unhealthy spawns too', () => {
  assert.equal(decideStartPlan({ health: 'down', hasOwnChild: false, hasToken: false }), 'spawn')
  assert.equal(decideStartPlan({ health: 'unhealthy', hasOwnChild: false, hasToken: false }), 'spawn')
})

test('exactly one retry is allowed', () => {
  assert.equal(shouldRetrySpawn(1), true)
  assert.equal(shouldRetrySpawn(2), false)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test electron/start-policy.test.js`

- [ ] **Step 3: 实现**

`decideStartPlan`：`health === 'ok' && hasToken` → `reuse`（`hasOwnChild` 只用于日志，不改变结果）；`health === 'ok' && !hasToken` → `restart-to-mint-token`；`unauthenticated` → `restart-to-mint-token`；其余 `spawn`。`shouldRetrySpawn(attempt)` 返回 `attempt === 1`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test electron/start-policy.test.js`

- [ ] **Step 5: 提交**

```bash
git add electron/start-policy.js electron/start-policy.test.js
git commit -m "[feat] 抽出启动决策规则"
```

---

### Task 4: service.js 接线（清端口、重试、换 token）

**Files:**
- Modify: `electron/service.js:104-218`

**Interfaces:**
- Consumes: Task 1 `probeOutcome`、Task 3 `decideStartPlan` / `shouldRetrySpawn`。

- [ ] **Step 1: 改 `start()` 前置判定**

`const health = await probeOutcome(LOCAL_URL)`；`const plan = decideStartPlan({ health: health.kind, hasOwnChild: child !== null, hasToken: authenticatedUrl !== null })`。`reuse` 时直接返回 `authenticatedUrl`；`restart-to-mint-token` 时先 `await stop()` 再往下；`spawn` 直接往下。

- [ ] **Step 2: spawn 前清端口**

在 `spawn` 之前 `await ensurePortFree(DEFAULT_PORT)`；`ensurePortFree` 已在文件内（`stop()` 使用），确认其不误杀非 node 进程。

- [ ] **Step 3: 失败重试一次**

把 spawn 段包成 `let attempt = 1; for (;;) { try { ... return } catch (err) { if (!shouldRetrySpawn(attempt)) throw err; attempt++; await ensurePortFree(DEFAULT_PORT) } }`。

- [ ] **Step 4: 运行既有测试**

Run: `node --test electron/*.test.js`
Expected: 全绿（service.js 无单测，靠 electron 层验收）。

- [ ] **Step 5: 提交**

```bash
git add electron/service.js
git commit -m "[fix] 启动前清端口并在失败时重试一次"
```

---

### Task 5: 进度窗口位置与生命周期

**Files:**
- Create: `electron/progress-placement.js`
- Modify: `electron/progress.js:51-90`、`electron/backend-actions.js:12-36`
- Test: `electron/progress-placement.test.js`

**Interfaces:**
- Produces: `placeBottomRight({ workArea: { x, y, width, height }, width: number, height: number, margin?: number }): { x: number, y: number }`（`margin` 默认 16）。

- [ ] **Step 1: 写失败测试**

```js
import { placeBottomRight } from './progress-placement.js'

test('sits 16px inside the bottom-right corner', () => {
  assert.deepEqual(
    placeBottomRight({ workArea: { x: 0, y: 0, width: 1920, height: 1040 }, width: 420, height: 128 }),
    { x: 1484, y: 896 },
  )
})

test('respects a work area with a non-zero origin', () => {
  assert.deepEqual(
    placeBottomRight({ workArea: { x: 1920, y: 0, width: 1280, height: 1000 }, width: 420, height: 128 }),
    { x: 2764, y: 856 },
  )
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test electron/progress-placement.test.js`

- [ ] **Step 3: 实现纯模块**

`x = workArea.x + workArea.width - width - margin`，`y = workArea.y + workArea.height - height - margin`。

- [ ] **Step 4: 接到 progress.js**

窗口选项 `alwaysOnTop: false`；创建后 `win.setPosition(x, y)`（用 `screen.getPrimaryDisplay().workArea` 调 `placeBottomRight`）；`showProgress` 内对 `state === 'busy'` 启动 `AUTO_HIDE_MS = 20000` 计时器，到点 `win.hide()`（不 close，后续状态可复用）；`state === 'error'` 启动 `ERROR_HIDE_MS = 3000` 自动 `closeProgress()`；成功路径由调用方 `closeProgress()` 立即执行。

- [ ] **Step 5: backend-actions 去掉停留**

`startBackend`/`restartBackend` 成功分支删掉 `setTimeout(closeProgress, 1200)`，改为立即 `closeProgress()`。

- [ ] **Step 6: 运行全部单测**

Run: `node --test electron/*.test.js`
Expected: 全绿。

- [ ] **Step 7: 提交**

```bash
git add electron/progress-placement.js electron/progress-placement.test.js electron/progress.js electron/backend-actions.js
git commit -m "[fix] 进度窗口移出屏幕中央并自动消失"
```

---

### Task 6: 主进程接线（自动启动、退出停后端、打开前取 token、坏窗口只记录）

**Files:**
- Modify: `electron/main.js:73-152`、`electron/open-dsh.js:32-65`

- [ ] **Step 1: 自动启动**

`bootstrapBackend()` 改为：`detect()` 后若 `status === 'stopped'` 且 `loadConfig().autoStartBackend !== false`，调用 `start({ backendPath: loadConfig().backendPath })` 并捕获错误写入 trace；`config.js` 的默认值补 `autoStartBackend: true`。

- [ ] **Step 2: 退出停后端**

`before-quit` 改为 `event.preventDefault()` 一次，`await stop()`（最多等 5s）后再 `app.quit()`；用 `quitting` 标志避免重入。

- [ ] **Step 3: 打开前确保 token**

`openDsh()` 开头：若 `getAuthenticatedUrl() === null` 且当前目标是本地默认地址，先 `await start(...)`（失败只 trace 不抛），再走 PWA 路径。

- [ ] **Step 4: 坏窗口只记录**

`pickPwaWindow` 命中逻辑不变；在 `openDsh()` 的 `findPwaWindow()` 未命中分支，扫描 `listChromeWindows()`，若存在标题含 `127.0.0.1` 或 `找不到` 的 Chromium 窗口，`trace('open-dsh: orphan error window ' + hwnd + ' ' + title)`，不关闭。

- [ ] **Step 5: 运行全部单测**

Run: `node --test electron/*.test.js`
Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
git add electron/main.js electron/open-dsh.js electron/config.js
git commit -m "[feat] 自动启动后端并在退出时收尾"
```

---

## 验收（人工，Windows 桌面）

1. 冷启动壳 → 后端自动拉起，进度窗口出现在右下角、不遮挡正在看的页面，后端就绪后立即消失。
2. 打开插件页（触发 2 MB JSON 拉取）→ 页面不刷新；`overlay-trace.log` 出现 `probe ok <ms>` 且无 `backend restart → reload`。
3. 手动杀掉后端再点启动 → 首次即成功；重复 3 次无 `EADDRINUSE`。
4. 端口被残留进程占用时启动 → 自动清理后成功。
5. 托盘退出壳 → `netstat -ano | findstr :3080` 无监听。
6. 后端未运行时点悬浮球「打开」→ 自动先启动再开窗，不再是 401。
