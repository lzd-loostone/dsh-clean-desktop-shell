# 悬浮球接入 PWA 全屏窗口 实施计划

> **For agentic workers:** 用 executing-plans 逐任务执行；步骤用 `- [ ]` 跟踪。

**Goal:** 点悬浮球不再新开浏览器标签页，而是把已存在的 DSH PWA 全屏窗口拉到前台；气泡里点会话行时置前并跳到该会话；后端重启后窗口自动刷新。

**Architecture:** 新增 `electron/pwa-window.js` 用 koffi 调 user32 做三件事——枚举窗口、按标题启发式认出 DSH 的 PWA 窗口、把它置前；`open-dsh.js` 从「一律 openExternal」改为「置前优先 → 没窗口就启动 PWA → 都没有才退回浏览器」。桥接通道加第四种帧 `reload`，由后端探活的 down→up 翻转触发；投递失败时开窗并重试，把 `goto` 补发给刚连上的页面。

**Tech Stack:** Electron 33、koffi 3.3.4、node:test、Node ESM。

**Spec:** 会话内口头设计（2026-10-26 brainstorming）。关键实测事实：`chrome_proxy.exe --profile-directory=Default --app-id=hgiemfgfjhalibdoboikeiepnnjapnpc` 打开的是 `-7,-7 1453x873` 全屏无边框窗口；`chrome.exe --app=<url> --start-fullscreen` 只得到普通窗口 1050x840，所以装出来的 PWA 是唯一能满足「全屏」的入口；PWA 窗口标题形如 `DeepSeek Harness - <会话名> — DeepSeek Harness`，随会话变化。

## Global Constraints

- 只在 Windows 走 Win32 路径；`process.platform !== 'win32'` 时 `openDsh()` 保持现状（`shell.openExternal`）。mac 分支不改。
- 不改 DSH 的 manifest，`display: fullscreen` 原样保留。
- 除 `koffi` 外不新增依赖；上一份计划里「不新增任何依赖」的约束在此被用户明确批准覆盖。
- 现有 SSE 协议不破坏：`goto` / `approve` / `answer` 帧结构、token 校验、`{delivered}` 返回全部保持。
- 测试只用 `node:test` + `node:assert/strict`，零测试框架；样式对齐 `src/host/bridge.test.js`。
- 不提交 git（用户未授权）。

## Review Focus

1. Chrome 没装 PWA / 已卸载时点悬浮球必须有反应——退回浏览器，不能静默。
2. 窗口最小化或被别的全屏应用遮挡时，「置前」必须真的到前台；只看 `SetForegroundWindow` 的返回值不够，要回读 `GetForegroundWindow` 校验。
3. 后端重启期间点气泡会话行，帧不能丢；页面重连需要几秒，靠重试覆盖。
4. PWA 窗口标题随会话变化，识别不能依赖固定标题串。
5. 多显示器/高 DPI：置前只用 hwnd，不使用任何坐标计算。

---

### Task 1: 窗口识别纯函数

**Files:**
- Create: `electron/pwa-window.js`
- Test: `electron/pwa-window.test.js`

**Interfaces:**
- `pickPwaWindow(windows: Array<{ hwnd: number, pid: number, title: string, className: string }>, selfPid: number) -> { hwnd: number, pid: number } | null`
- 判据：`className === 'Chrome_WidgetWin_1'`、`pid !== selfPid`、`title.includes('DeepSeek Harness')`、`!/ - Google Chrome$/.test(title)`；多个命中取第一个。

- [ ] **Step 1: 写失败测试**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickPwaWindow } from './pwa-window.js'

const win = (hwnd, title, extra = {}) => ({ hwnd, pid: 100, title, className: 'Chrome_WidgetWin_1', ...extra })

test('recognises the fullscreen PWA window by its title', () => {
  const got = pickPwaWindow([win(7, 'DeepSeek Harness - 拉取插件最新代码 — DeepSeek Harness')], 1)
  assert.deepEqual(got, { hwnd: 7, pid: 100 })
})

test('ignores a normal browser tab that happens to show DSH', () => {
  assert.equal(pickPwaWindow([win(8, 'DeepSeek Harness - 拉取插件最新代码 - Google Chrome')], 1), null)
})

test('ignores our own Electron windows', () => {
  assert.equal(pickPwaWindow([win(9, 'DSH 气泡窗', { pid: 1 })], 1), null)
})

test('ignores non-Chromium window classes', () => {
  assert.equal(pickPwaWindow([win(10, 'DeepSeek Harness', { className: 'Notepad' })], 1), null)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node electron/pwa-window.test.js`
Expected: FAIL — `pickPwaWindow` 未导出。

- [ ] **Step 3: 实现 `pickPwaWindow`**

文件顶部写明它为什么靠标题而不是窗口句柄：PWA 窗口没有可查询的应用身份，标题是唯一稳定的跨会话信号。

- [ ] **Step 4: 跑测试确认通过**

Run: `node electron/pwa-window.test.js`
Expected: PASS（4 个用例）。

- [ ] **Step 5: 提交**

```bash
git add electron/pwa-window.js electron/pwa-window.test.js
git commit -m "feat: recognise the DSH PWA window among Chrome windows"
```

---

### Task 2: Win32 枚举与置前

**Files:**
- Modify: `electron/pwa-window.js`
- Test: `electron/pwa-window.test.js`

**Interfaces:**
- `listChromeWindows() -> Array<{ hwnd: number, pid: number, title: string, className: string }>`（只返回可见且有标题的窗口）
- `findPwaWindow() -> { hwnd: number, pid: number } | null`（`listChromeWindows` + `pickPwaWindow`，selfPid 取 `process.pid`）
- `focusWindow(hwnd: number) -> boolean`：`IsIconic` 时先 `ShowWindow(SW_RESTORE)`，再 `SetForegroundWindow`，等 60ms 后用 `GetForegroundWindow()` 回读校验；失败则 `ShowWindow(SW_MINIMIZE)` + `ShowWindow(SW_RESTORE)` 再试一次，仍失败返回 false。

- [ ] **Step 1: 写失败测试**

```js
test('focusWindow rejects a bogus handle instead of throwing', () => {
  assert.equal(focusWindow(0), false)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node electron/pwa-window.test.js`
Expected: FAIL — `focusWindow` 未导出。

- [ ] **Step 3: 实现 koffi 绑定**

用 `createRequire(import.meta.url)` 载入 `koffi`（项目是 ESM，koffi 是 CJS 原生模块）。句柄一律声明成 `uintptr_t`，不要用 `void*`——koffi 不接受把 JS 数字包成指针，`uintptr_t` 能直接收发 BigInt，配合 `Number()` 转换。枚举回调通过 `koffi.register(fn, koffi.pointer(EnumWindowsProc))` 注册，用完 `koffi.unregister`。koffi 载入失败时 `listChromeWindows()` 返回 `[]`、`focusWindow()` 返回 false，让上层自然退回浏览器。

- [ ] **Step 4: 手工验证（必须真跑，不进测试套件）**

Run: `node -e "import('./electron/pwa-window.js').then(m => console.log(m.findPwaWindow()))"`（先手动打开 DSH PWA 窗口）
Expected: 打印出 `{ hwnd, pid }`，hwnd 非 0。

再在窗口最小化时跑 `focusWindow(<hwnd>)`，Expected: 返回 true 且窗口到前台。

- [ ] **Step 5: 跑测试确认通过**

Run: `node electron/pwa-window.test.js`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add electron/pwa-window.js electron/pwa-window.test.js
git commit -m "feat: enumerate and foreground the PWA window through user32"
```

---

### Task 3: 定位 Chrome 与 PWA app-id

**Files:**
- Modify: `electron/pwa-window.js`
- Test: `electron/pwa-window.test.js`

**Interfaces:**
- `buildAppLaunchArgs(appId: string, profileDir: string) -> string[]` → `['--profile-directory=<profileDir>', '--app-id=<appId>']`
- `findPwaApp(userDataDir: string) -> { appId: string, profileDir: string } | null`：遍历 `<userDataDir>/*/`，找 `Web Applications/_crx_<id>` 目录内存在名字匹配 `/deepseek/i` 的 `.ico` 文件，返回去掉 `_crx_` 前缀的 id 与该 profile 目录名。
- `locateChrome() -> string | null`：依次试 `%ProgramFiles%\Google\Chrome\Application\chrome_proxy.exe`、`%ProgramFiles(x86)%`、`%LOCALAPPDATA%\Google\Chrome\Application\chrome_proxy.exe`，返回第一个存在的。
- `chromeUserDataDir() -> string`：`%LOCALAPPDATA%\Google\Chrome\User Data`。

- [ ] **Step 1: 写失败测试**

```js
test('buildAppLaunchArgs pins profile and app id', () => {
  assert.deepEqual(buildAppLaunchArgs('abc123', 'Default'), ['--profile-directory=Default', '--app-id=abc123'])
})

test('findPwaApp scans Web Applications for the DSH icon', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pwa-'))
  const dir = join(root, 'Default', 'Web Applications', '_crx_hgiemfgfjhalibdoboikeiepnnjapnpc')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'DeepSeek Harness.ico'), '')
  assert.deepEqual(findPwaApp(root), { appId: 'hgiemfgfjhalibdoboikeiepnnjapnpc', profileDir: 'Default' })
})

test('findPwaApp returns null when the PWA is not installed', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pwa-empty-'))
  assert.equal(findPwaApp(root), null)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node electron/pwa-window.test.js`
Expected: FAIL — 两个函数未导出。

- [ ] **Step 3: 实现三个函数**

`findPwaApp` 用 `readdirSync(dir, { withFileTypes: true })`，任何读取失败都返回 null，绝不抛。

- [ ] **Step 4: 跑测试确认通过**

Run: `node electron/pwa-window.test.js`
Expected: PASS。

- [ ] **Step 5: 提交**

`git commit -m "feat: locate Chrome and the installed DSH PWA app id"`

---

### Task 4: 启动 PWA 并等待它的窗口

**Files:**
- Modify: `electron/pwa-window.js`
- Test: `electron/pwa-window.test.js`

**Interfaces:**
- `launchPwaApp() -> Promise<number | null>`：取现有 hwnd 集合 → `spawn(locateChrome(), buildAppLaunchArgs(appId, profileDir), { detached: true, stdio: 'ignore' }).unref()` → 每 120ms 重新枚举，最多 8 秒，返回新出现的 PWA 窗口 hwnd；任何一步缺失（没装 PWA、没找到 Chrome、超时）返回 null。
- `waitForNewPwaWindow(before: Set<number>, deadlineMs: number) -> Promise<number | null>`（纯轮询，注入 sleep 便于测试）

- [ ] **Step 1: 写失败测试**

```js
test('waitForNewPwaWindow gives up after the deadline', async () => {
  const got = await waitForNewPwaWindow(new Set([1]), 50, { intervalMs: 10, scan: () => ({ hwnd: 1, pid: 9 }) })
  assert.equal(got, null)
})

test('waitForNewPwaWindow returns a handle that was not there before', async () => {
  let n = 0
  const scan = () => (++n > 2 ? { hwnd: 42, pid: 9 } : null)
  assert.equal(await waitForNewPwaWindow(new Set(), 500, { intervalMs: 10, scan }), 42)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node electron/pwa-window.test.js`
Expected: FAIL — 未导出。

- [ ] **Step 3: 实现**

```js
export async function waitForNewPwaWindow(before, deadlineMs, { intervalMs = 120, scan = findPwaWindow } = {})
```
循环 `scan()`，命中且 `!before.has(hwnd)` 就返回；超时返回 null。

- [ ] **Step 4: 手工验证**

在 PWA 窗口已关闭的情况下跑 `launchPwaApp()`。
Expected: 屏幕上出现全屏窗口，返回新 hwnd（非 null）。

- [ ] **Step 5: 跑测试确认通过**

Run: `node electron/pwa-window.test.js`
Expected: PASS。

- [ ] **Step 6: 提交**

`git commit -m "feat: launch the installed PWA and wait for its window"`

---

### Task 5: openDsh 改为置前优先

**Files:**
- Modify: `electron/open-dsh.js`
- Modify: `electron/overlay.js`（3 处调用点改 `void openDsh()`）
- Modify: `electron/main.js`（second-instance / activate / tray onOpen 无需改签名，`openDsh` 变成 async 后返回 Promise 仍可忽略；确认 3 处调用。）

**Interfaces:**
- `openDsh() -> Promise<void>`：win32 → `findPwaWindow()` 命中则 `focusWindow`，否则 `launchPwaApp()`；两者都失败才 `shell.openExternal(dshUrl())`。非 win32 直接 `shell.openExternal`。
- 内部吞掉所有异常，**永不 reject**——调用点（main.js:66 second-instance、main.js:97 tray onOpen、main.js:116 activate、overlay.js:850/937/1047、tray.js:44 / :62）都不 await 它。
- 保留 `dshUrl()` 导出不变。

- [ ] **Step 1: 改实现**

不要在 `open-dsh.js` 里 try/catch 吞掉异常就完；每个失败分支都要 `trace`/留痕，否则「点了没反应」无法排查。

- [ ] **Step 2: 手工验证四种状态**

1. PWA 窗口已开且在前台 → 点悬浮球，窗口不动（不闪、不重开）。
2. PWA 窗口开着但被别的窗口盖住 → 点悬浮球，PWA 到前台。
3. PWA 窗口关掉 → 点悬浮球，出现全屏 PWA 窗口（只有一个，不是两个）。
4. 把 PWA 卸载/改名后再点 → 浏览器标签页打开（回退路径生效）。

- [ ] **Step 3: 跑全套测试**

Run: `node --test "electron/*.test.js" "src/host/*.test.js" "src/client/*.test.js"`
Expected: 全绿。

- [ ] **Step 4: 提交**

`git commit -m "feat: route every open action to the PWA window"`

---

### Task 6: 投递失败时开窗并重试

**Files:**
- Modify: `electron/bridge.js`
- Test: `electron/bridge.test.js`
- Modify: `electron/overlay.js`（`deliver()` 调用新函数）

**Interfaces:**
- `deliverWithRetry(payload, { open, send = sendDecision, attempts = 20, intervalMs = 500, sleep } = {}) -> Promise<number>`：先 `send`；`> 0` 立即返回；否则 `await open()` 后每次 `sleep(intervalMs)` 再 `send`，直到 `attempts` 用完，返回最后一次的计数。

- [ ] **Step 1: 写失败测试**

```js
test('deliverWithRetry opens the app once and retries until a page answers', async () => {
  let opened = 0
  const counts = [0, 0, 1]
  const send = async () => counts.shift() ?? 0
  const got = await deliverWithRetry({ type: 'goto', sessionId: 'S1' }, {
    open: async () => { opened++ }, send, intervalMs: 0, sleep: async () => {},
  })
  assert.equal(got, 1)
  assert.equal(opened, 1)
})

test('deliverWithRetry gives up after the attempt budget', async () => {
  let sent = 0
  const got = await deliverWithRetry({ type: 'goto', sessionId: 'S1' }, {
    open: async () => {}, send: async () => { sent++; return 0 }, attempts: 3, sleep: async () => {},
  })
  assert.equal(got, 0)
  assert.equal(sent, 3)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node electron/bridge.test.js`
Expected: FAIL — `deliverWithRetry` 未导出。

- [ ] **Step 3: 实现并接线**

`overlay.js` 的 `deliver(payload)` 改成调 `deliverWithRetry(payload, { open: openDsh })`，并在 finally 里 `trace` 最终计数。`approve`/`answer` 重复投递是安全的——页面侧拿不到 pending 就静默忽略。

- [ ] **Step 4: 跑测试确认通过**

Run: `node electron/bridge.test.js`
Expected: PASS。

- [ ] **Step 5: 提交**

`git commit -m "feat: retry a decision after opening the PWA window"`

---

### Task 7: reload 帧

**Files:**
- Modify: `src/host/bridge.js`
- Modify: `src/host/bridge.test.js`
- Modify: `src/client/client.js`
- Modify: `src/client/client.test.js`

**Interfaces:**
- `TYPES` 加入 `'reload'`；校验改为 `const needsSession = msg.type !== 'reload'`，`needsSession` 时才要求 `sessionId` 是非空字符串。帧格式 `{"type":"reload"}`。
- `client.js` 的 `handle(msg)` 增加分支：`if (msg.type === 'reload') { say('reload'); try { location.reload(); } catch (e) {} return; }`

- [ ] **Step 1: 写失败测试**

```js
test('reload is accepted without a session id and broadcast', async () => {
  const home = tmpHome()
  const server = fakeServer()
  const dispose = startBridge(server, { home })
  const token = JSON.parse(readFileSync(bridgeFilePath(home), 'utf8')).token
  const a = await connect(server)
  const res = fakeRes()
  server.handler('exact', DECIDE_PATH)(
    fakeReq({ method: 'POST', headers: { 'x-shell-token': token }, body: JSON.stringify({ type: 'reload' }) }),
    res,
  )
  await settle()
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { delivered: 1 })
  assert.ok(a.body.includes('data: {"type":"reload"}'))
  dispose()
})
```

现有用例 `non-POST and malformed payloads are rejected` 里的 `{ type: 'goto' }` 断言必须继续为 400——它就是「放宽只针对 reload」的守卫。

- [ ] **Step 2: 跑测试确认失败**

Run: `node src/host/bridge.test.js`
Expected: FAIL — reload 返回 400。

- [ ] **Step 3: 实现校验放宽 + 页面侧处理**

- [ ] **Step 4: 跑测试确认通过**

Run: `node src/host/bridge.test.js && node src/client/client.test.js`
Expected: PASS。

- [ ] **Step 5: 提交**

`git commit -m "feat: add a reload frame for backend restarts"`

---

### Task 8: 后端重启触发刷新

**Files:**
- Create: `electron/backend-watch.js`
- Test: `electron/backend-watch.test.js`
- Modify: `electron/main.js`

**Interfaces:**
- `watchBackend({ url, probe = defaultProbe, onRestart, intervalMs = 3000 }) -> () => void`：用 `setInterval` 轮询 `probe(url)`；第一次探测只记录基线（不触发）；之后出现 `up && !lastUp` 就调 `onRestart()`。返回停止函数。
- `main.js`：`app.whenReady` 里启动，`onRestart` 调 `deliverWithRetry({ type: 'reload' }, { open: async () => {}, attempts: 30, intervalMs: 500 })`——没人听就放弃，不许为刷新而开窗。

- [ ] **Step 1: 写失败测试**

```js
test('fires onRestart only on a down → up transition', async () => {
  const states = [true, false, false, true]
  let fired = 0
  const stop = watchBackend({ probe: async () => states.shift() ?? false, onRestart: () => { fired++ }, intervalMs: 1 })
  await new Promise((r) => setTimeout(r, 40))
  stop()
  assert.equal(fired, 1)
})

test('a backend that was already up at start never fires', async () => {
  let fired = 0
  const stop = watchBackend({ probe: async () => true, onRestart: () => { fired++ }, intervalMs: 1 })
  await new Promise((r) => setTimeout(r, 30))
  stop()
  assert.equal(fired, 0)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node electron/backend-watch.test.js`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现并接线**

注意 `probe` 已被 `electron/probe.js` 导出且把 401 当活（`status < 500`），直接复用，不要另写一个 HTTP 检查。

- [ ] **Step 4: 跑测试确认通过**

Run: `node electron/backend-watch.test.js`
Expected: PASS。

- [ ] **Step 5: 手工验证**

开着一个 PWA 窗口，托盘「重启后端」。Expected: 后端起来后约 1 秒内页面刷新一次，回到可交互状态。

- [ ] **Step 6: 提交**

`git commit -m "feat: reload the page when the backend comes back"`

---

### Task 9: 打包与依赖收尾

**Files:**
- Modify: `package.json`

**Interfaces:**
- `dependencies` 增加 `"koffi": "^3.3.4"`。
- `build.asarUnpack` 增加 `"node_modules/koffi/**"`（原生模块不能压进 asar）。
- 确认 `build.files` 不排除 `electron/pwa-window.js` 与 `electron/backend-watch.js`（现在只排除 `*.test.js`，无需改动）。

- [ ] **Step 1: 装依赖**

Run: `pnpm i`（或 `npm i`，与仓库当前用法一致）
Expected: `node_modules/koffi` 存在，`pnpm-lock.yaml` / `package-lock.json` 更新。

- [ ] **Step 2: 验证 Electron 内能加载 koffi**

Run: `pnpm run dev`，观察启动日志无 `Cannot find module 'koffi'`，并点一次悬浮球确认置前路径生效。

- [ ] **Step 3: 跑全套检查**

Run: `pnpm run check && pnpm test`
Expected: 全绿。

- [ ] **Step 4: 打包验证**

Run: `pnpm run build && pnpm run pack`
Expected: 产物内 `app.asar.unpacked/node_modules/koffi` 存在；安装后点悬浮球能置前。

- [ ] **Step 5: 提交**

`git commit -m "build: bundle koffi and unpack it from asar"`

---

## 不在本计划内

- mac 的等价实现（`openDsh` 在 darwin 上保持 `shell.openExternal`）。
- 消除 Chrome 的「翻译此页？」气泡（那是 Chrome 的用户设置，插件不该越权改）。
- 已安装 PWA 之外的应用窗口方案（`chrome --app` 实测得不到全屏）。
