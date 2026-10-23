# 删除主窗口壳 + 浏览器回连通道 实施计划

> **For agentic workers:** 用 executing-plans 逐任务执行；步骤用 `- [ ]` 跟踪。

**Goal:** 删掉整个主窗口壳，让鲸鱼气泡的「跳会话 / 同意·拒绝 / 作答」改为经宿主插件内嵌的 SSE 路由与浏览器页面通信。

**Architecture:** 宿主半区在 `ctx.webServer` 上注册两条 exact 路由：`GET /dsh-clean-desktop-shell/events`（SSE 广播）与 `POST /dsh-clean-desktop-shell/decide`（带 token 的决策投递）。浏览器里的客户端半区用 EventSource 连回同源路由，收到决策后调用现有官方 API（`uiWorkspace.openSession` / `PendingApproval.answer` / `PendingQuestion.answer`）。Electron 侧不再向任何页面 `webContents.send`，改为 POST 决策；无页面在线时回退 `shell.openExternal` 打开浏览器。

**Tech Stack:** Node ESM、Electron 33、cordis 插件面、node:http、EventSource。

**Spec:** 会话内口头设计（2026-10-23，用户选「方案 2」）。

## Global Constraints

- 不新增任何依赖；只用 Node 标准库与 Electron 内置 API。
- 宿主半区只能读 cordis 公开面：`ctx.webServer`、事件、`ctx.sessions`、`ctx.sessionTitle`。
- 通道仅限本机：token 文件写入 `$DSH_HOME/desktop-shell-bridge.json`，内容 `{ url, token }`。
- 删除后仓库内不得残留主窗口引用（`window.js` / `preload.js` / `error.html` / `link-*` / `DshWindow` / `shellAPI`）。
- 中文 UI 文案维持现有风格，不新造术语。
- 不提交 git（用户未授权）。

## Review Focus

1. 后端重启后浏览器页的 SSE 必须自行重连（EventSource 对 HTTP 错误状态不重试，需 onerror 兜底）。
2. 多标签页同时在线：`goto` 会广播给所有页（各自切换，可接受）；approve/answer 只能生效一次。
3. 无页面在线时点任务行必须回退为打开浏览器，不能静默无反应。
4. 缺失/错误 token 的 POST 必须 403 且不得广播。
5. SSE 连接泄漏：页面断开、插件卸载时必须从广播集合移除并 close。

---

### Task 1: 宿主回连通道

**Files:**
- Create: `src/host/bridge.js`, `src/host/bridge.test.js`
- Modify: `src/host/index.js`, `scripts/build.mjs`

**Interfaces:**
- `EVENTS_PATH = '/dsh-clean-desktop-shell/events'`、`DECIDE_PATH = '/dsh-clean-desktop-shell/decide'`
- `startBridge(webServer, { home } = {}) -> () => void`（返回卸载函数）
- `bridgeFilePath() -> string`
- SSE 帧：`data: {type:'goto',sessionId}` / `{type:'approve',sessionId,decision}` / `{type:'answer',sessionId,answers}`
- POST 响应体：`{ delivered: number }`；鉴权头 `x-shell-token`

- [ ] 测试：注册两条 exact 路由、SSE 收到 decide 广播、错误 token 403、非 POST 405、坏 JSON 400、delivered 计数、卸载时 close 客户端
- [ ] 实现 `startBridge`；`index.js` 用 `ctx.inject(['webServer'], ...)` 挂载（headless 无 webServer 时不启动）

### Task 2: 客户端半区改用 EventSource

**Files:**
- Modify: `src/client/client.js`, `src/client/client.test.js`

**Interfaces:**
- 连接 `/dsh-clean-desktop-shell/events`；`onmessage` 解析后按 type 分派到既有 `answerApproval` / `answerQuestion` / `openSession`
- 保留 `exports.inject = ['uiSession','uiWorkspace']`

- [ ] 测试：连接路径正确；goto 调 openSession；approve 调 pending.answer('allowed-once')；无 pending 时不抛
- [ ] 实现；HTTP 错误状态导致 CLOSED 时 5s 后重建 EventSource

### Task 3: Electron 侧改投递

**Files:**
- Create: `electron/bridge.js`
- Modify: `electron/overlay.js`, `electron/tray.js`, `electron/menu.html`, `electron/main.js`, `electron/config.js`

- [ ] `sendDecision({type,...}) -> Promise<number>`（读 token 文件，POST，1.5s 超时，失败返回 0）
- [ ] `openDsh()`：`getAuthenticatedUrl() || config.targetUrl || DEFAULT_TARGET_URL` → `shell.openExternal`
- [ ] overlay：三条 send 改 `sendDecision`；goto 且 `delivered === 0` 或投递失败 → `openDsh()`；`focusMain`/getMainWindow 全删
- [ ] tray：首项改「打开 DSH 网页」，去掉「刷新窗口」与「创建桌面快捷方式」
- [ ] menu.html：`refresh` → `open`（在浏览器中打开）
- [ ] config：删 `closeToTray` / `shortcutAsked`（保留 targetUrl、backendPath、overlay）

### Task 4: 删除主窗链路

**Files:** 删除 `electron/window.js`、`electron/preload.js`、`electron/error.html`、`electron/link-window.js`、`electron/link.html`、`electron/link-preload.js`、`electron/link-policy.js`、`electron/link-policy.test.js`、`electron/shortcut.js`；`electron/probe.js` 删 `probeDetail`；重写 `electron/main.js`

- [ ] `DshWindow` 全部改 `BrowserWindow`（overlay.js / progress.js）
- [ ] main.js：无窗口创建、无单实例聚焦（保留锁与托盘）、`activate` 改打开浏览器
- [ ] `rg "window\.js|preload\.js|error\.html|link-|DshWindow|shellAPI|shortcut" electron src package.json` 为空或仅剩合法提及

### Task 5: 构建与验证

- [ ] `npm run build`（src→lib）
- [ ] `npm test`（node --test）
- [ ] `npm run check`（语法 + runtime 自检）
- [ ] `node --check` 覆盖到的文件全绿；README/package 版本更新到 0.4.0
