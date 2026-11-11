# 契约测试重钉：0.2.1-rc.5 → 0.2.2-rc.1

日期：2026-11-10 · 运行时 `@deepseek-ai/dsh@0.2.2-rc.1`（安装于全局 npm 根）
源码锚点：`deepseek-harness` tag `dsh-v0.2.2-rc.1`，commit `66491b05e3`（只读）

本文件只记录「0.2.2 真实改变了什么」，以及测试里每条新断言的依据。测试套件本身的意图（真实运行时、真实 loop/PTC/审批/收据）没有放宽。

## 运行方式

`npm run test:contract`（等价于 `node --test src/host/delegation-contract.test.js`）。

套件现在会在模块加载时调用 fixture 的 `applyContractEnvironment()`，自动解析并导出：

| 变量 | 默认值 |
| --- | --- |
| `DSH_CONTRACT_RUNTIME_ROOT` | `npm root -g` 下的 `@deepseek-ai/dsh`（兜底 `%APPDATA%/npm/node_modules`、`process.execPath` 同级） |
| `DSH_CONTRACT_SCRATCH_ROOT` | `<repo>/.dsh-tmp/contract` |
| `TEMP` / `TMP` / `TMPDIR` | `<scratch>/tmp`（fixture 断言三者必须一致） |
| `NPM_CONFIG_CACHE` | `<scratch>/npm-cache` |
| `DSH_HOME` | `<scratch>/dsh-home`（不碰真实 `~/.dsh`） |
| `DSH_CONTRACT_CLIENT_SOURCE_ROOT` | `<repo>/../deepseek-harness` |
| `DSH_CONTRACT_CLIENT_DEPS` | `<repo>/.dsh-tmp/ptc-brain-delegation/task-1/client-deps/package.json` |

显式设置的同名变量永远优先，CI 仍然掌握控制权。

## 0.2.2 改了什么（测试断言依据）

### 1. `dsh-tools` 删除了 `mode` 选项

- rc.5：`packages/core/tools/src/index.ts:812` `mode: z.union(['native','ptc']).default('native')`，并有 `presentAs(mode)`（同文件 985 行）。
- 0.2.2：`packages/core/tools/src/index.ts:102` `mode: z.never().description('Removed. Mount a native or PTC tool executor instead.')`；`presentAs` 已不存在。
- 于是 `mount('@deepseek-ai/dsh-tools', { mode: 'native' })` 直接 `ValidationError`，18 条全挂在 fixture 初始化。

### 2. 执行方式改由独立 executor 插件选择

- 新增 `@deepseek-ai/dsh-tool-executor-native`（`packages/core/tool-executor-native/src/index.ts:34` `ctx.tools.setExecutor(new NativeToolExecutor(ctx))`）
- 新增 `@deepseek-ai/dsh-tool-executor-ptc`（`packages/core/tool-executor-ptc/src/index.ts:83`）
- 上游测试的 PTC 组合方式就是「在 Agent scope 里挂 PTC executor」：`packages/shell/tool-bash/tests/integration.spec.ts:123`、`packages/fs/tool-fs/tests/integration.spec.ts:626` 均为 `await agent.ctx.plugin(PtcToolExecutor)`。
- 测试改动：fixture 先挂 `dsh-tools` 再挂 native executor；`agent.ctx.tools.presentAs('ptc')` 换成 `presentAgentAsPtc(fixture, agent)`（fixture 内 `agent.ctx.plugin(ptcExecutor, { maxParallelSubCalls: 1 })`）。

### 3. `tools.execute` 从单次调用变成批调用

- rc.5：`packages/core/tools/src/index.ts:1377` `async execute(exec: ToolExecutionInput): Promise<ToolExecutionResult>`。
- 0.2.2：`packages/core/tools/src/index.ts:375` `async execute(input: ToolBatchInput): Promise<ToolBatchResult>`；输入是 `{ calls: [{ type: 'tool-call', id, name, arguments: <JSON 字符串> }], signal, agent }`，输出是 `{ results: [{ callId, result }], additionalContexts, concluded }`（上游用例：`packages/core/tools/tests/tools.spec.ts:2961-2975`）。
- 测试改动：guard parity 里「未受 guard 影响的其他 Agent 仍可调用」改用批调用并取 `batch.results[0].result`，断言（`isError === false`、`mutations === 1`）不变。

### 4. `dsh-tool-subagent` 配置键改名

- rc.5：`modelSelectionSettings`（`packages/subagent/tool-subagent/src/index.ts:83`）。
- 0.2.2：`modelSelection` / `modelDiscovery`，并新增 `agentPreset` / `allowedAgentPresets`；`maxDepth` 额外接受 `'provider-managed'`（`packages/subagent/tool-subagent/src/index.ts:86`）。
- 测试改动：`captureContentActivation` 的 stock 配置由 `modelSelectionSettings: false` 改为 `modelSelection: false`。

### 5. 版本探测与 client gate

- runtime 版本断言从 `0.2.1-rc.5` 提到 `0.2.2-rc.1`；常量更名 `CONTRACT_RUNTIME_VERSION`，旧名 `RC5_VERSION` 保留为别名（`src/host/delegation.test.js` 仍在 import，未改）。
- `packages/client/store/src/index.ts` 的字节在 rc.5 与 0.2.2 完全相同（sha256 `6969ed123830868c44d90b664cd40d81d4f6a8fd18245a695fdc3cca38c9da08`），所以 `CLIENT_STORE_SOURCE_SHA` 保持不变，只把 manifest 版本断言跟着升级。

## 没有变、但值得记住的

- PTC dispatch 事件（`tool/ptc-dispatch`、`tool/ptc-dispatch-start`）、审批审计（`approval/asked` / `approval/decided`）、原生 tool result 收据形状、`tools/post-execute` 的 `decision.content` 通道：在本机 0.2.2 上全部按原断言通过，无改动。
- 跳过的 2 条（`unsupported around-success-meta`）是既有预算关闭（CLOSED 2/2），与本次重钉无关，未重开。
- 兄弟套件 `src/host/delegation.test.js` 在 0.2.2 上仍有 2 条失败（`PRESET_BUILD_FAILED` vs `PRESET_HEALTH_FAILED`、gate-port 首发布等待），属于另一套契约的旧假设，不在本次改动范围内。
