# PTC + 主脑分工：插件集成实施计划

日期：2026-10-30  
状态：待用户批准实施；本文件不授权改实现、安装、重启或提交。  
工作目录：`D:/AndroidStudioProjects/dsh/dsh-clean-desktop-shell`

## 1. 目标与批准边界

**Goal：** 安装并启用插件后，在 DSH 既有模式选择器中出现独立的“PTC + 主脑分工（插件）”。主脑和决策 fork 保持父会话有效模型，明确执行由配置的固定模型 spawn 完成。

**Spec：** [完整设计](<D:/AndroidStudioProjects/dsh/dsh-clean-desktop-shell/docs/superpowers/specs/2026-10-30-ptc-brain-delegation-design.md>)。用户已确认方向 B，并于本次会话确认完整设计及第 7 节恢复保护。设计文件中的批准前措辞是历史状态，不构成重新确认设计的要求。本计划仍需单独批准。

**Architecture：** 同包独立 Host entry 拥有设置、发布队列及状态；纯工厂生成完整 PTC definition；预设内的 Agent 作用域 gate 处理空配置与恢复确认；既有 Client factory 增加正式设置 slot。Electron 原入口和 SSE 桥保持独立。

**Tech Stack：** ESM JavaScript、Cordis/DSH 公共扩展 API、现有浏览器 React、Node `node:test`、现有复制式构建。仅验证 DSH `0.2.1-rc.5`；不添加框架、第二 React、运行服务器或自动模型路由依赖。

**执行方式：** 主脑/fork 决策与审查；固定模型 spawn 按本计划实现、测试和机械验证。所有 child 为单层，不再委派。每任务使用执行卡；同文件单写者，同 cwd 构建串行。

**并行波次（按用户加速要求）：**

- 第一波：任务 1 契约验证与任务 2 纯资产/工厂单测分别交给两个执行 child。任务 2 不提前挂载、接入或发布；公开接缝未通过，不启动依赖它的任务。
- 第二波：任务 1/2 通过后，任务 3 Host 发布、任务 4 gate/证据、任务 5 Client UI 可由三个 child 并行。任务 3 独占 Host 发布文件，任务 4 独占 gate/证据及工厂接入，任务 5 独占 Client 文件。共享接口和 fixture 先固定，再只读复用；变更先协调，不能各改一份。
- 实施中加速调整：接缝实际验证继续时，可提前并行开发不依赖 SDK 的纯发布队列、严格收据解析和 UI 状态/DTO逻辑。每个纯模块按原文件单写者/TDD测试，明确仅单元证明；Host/Gate/Client 正式绑定、fixture交接、真实挂载与整体验收仍必须等待任务 1 完整契约和评审通过。不把回调测试说成真实框架证明，不实施尚未证实的接缝。
- 第三波：任务 6 由一个执行 child 汇总包入口、构建、全量测试与产物；安装/现有 GUI/重启验收在授权后串行。主脑或高级 fork 可并行只读审查已冻结的模块，不重复执行 child 正在做的验证。

契约失败时停止所有依赖工作。已经开始的纯资产任务可以安全收尾，但不得据此跳过接缝 gate 或宣称功能可用。

批准实施不等于批准替换运行中的插件或重启 GUI。安装、可能的安装脚本及 restart-required 按第 9 节单独确认。全程不手工修改个人 profile，不覆盖既有 ptc-router，不修改 DSH 源码、凭据、AGENTS 或 Skill，不自动 commit/push。

## 2. 全局约束与 Review Focus

### 全局约束

- 同任务同失败最多尝试 2 次；首次计入，跨主脑、child、重新委派累计。回报带任务/失败标识、已用与剩余次数。耗尽停报，不用重新派发清零。
- 不改变已确认的职责、小改例外、纯构建例外、审批优先级及重启恢复策略。persona 是软协议，不宣称实现了 OS 沙箱、文件锁或全树金额/token 硬预算。
- 不原地改已发布 definition、共享 volatile 对象或仍被 Agent 引用的配置。旧 Agent 及其 child 保留同进程旧 generation；不承诺跨进程还原旧实现。
- 出现新方案取舍、接口不能满足契约、范围扩大或需要新依赖，spawn 只报事实，由主脑/fork 决策。不得弱化验收、猜私有 API 或绕过权限。
- 新临时脚本、日志、pack 与测试目录只放仓库内 `.dsh-tmp/ptc-brain-delegation/`。确认 `.dsh-tmp/.gitignore` 含 `*`，存在时先读，不覆盖他人内容。验证前将 TEMP、TMP、TMPDIR、NPM_CONFIG_CACHE 指向该目录的原生绝对路径，并用 Node 验证 `os.tmpdir()`；不新增外部临时文件。
- 测试运行环境、依赖或 fixture 不能加载时，属于前置条件失败，不算 TDD 的有效 RED。所有有效 RED 必须对应预期行为断言。

### Review Focus：审查问题与对应验证

1. **官方 PTC 是否完整、仅有白名单差异？** 来源 hash、定义结构差异测试、rc.5 挂载测试；特别检查 planning/compaction 隔离、平台条件和 PTC 展示。
2. **角色和实际模型是否正确？** fork/spawn 配置测试、真实 request/header 核对；空配置不创建 child，fork 不被统一降为 executor。
3. **发布是否尊重 generation 与生命周期？** 快速保存、陈旧 revision、失败阶段、旧 root/child、卸载中发布的确定性测试及 rc.5 集成。
4. **恢复证据与审批是否可信且 fail-closed？** 伪造文本、缺失/冲突记录、审批各 outcome、native/PTC 内层及取消测试；不能以工具入参、toast 或未完成结果证明实际路由。
5. **设置、发布包与桌面原能力是否回归？** 表单权限/错误测试、现有 SSE 测试、真实 tarball 文件核验、现有 GUI 与 Electron 独立性检查。

## 3. 文件职责与接口

新增文件均位于插件仓库；以下是建议的最终拆分，不创建空壳占位。允许合并很小的纯 helper，但不得混淆 Host 发布、Agent gate 和 Client 生命周期。

- `src/host/delegation.js`：独立 Host 导出，Config、公共服务适配、设置通知、状态与生命周期组装。
- `src/host/delegation-config.js`：workerRoute 普通快照、字段校验、路由比较；不持有 Agent 或可变 Settings 引用。
- `src/host/delegation-preset.js`：完整 PresetDefinition 工厂与白名单变换。
- `src/host/delegation-publisher.js`：串行发布、诊断状态、失败和停止；不注册全局请求改写器。
- `src/host/delegation-gate.js`：本预设 Agent 作用域的就绪/恢复 gate；不拦截其他模式。
- `src/host/delegation-evidence.js`：从公开持久记录提取既往路由证据；不读原始存储或全库搜索。
- `src/client/delegation-settings.js`：设置组件和状态适配；由现有 factory 装入同一产物，不另注册同包 factory。
- `assets/delegation/ptc-rc5.yml`、`assets/delegation/provenance.json`、`assets/delegation/persona.md`：受版本管理的官方源文本、来源/许可信息、完整分工协议。JS 基线转写由结构测试与真实 Loader 挂载校验，不自写 YAML/!!js 解析器。
- 对应 `src/host/*.test.js`、`src/client/*.test.js`：保持现有 test glob 可发现；fixture 生命周期归测试所有。

现有修改面限定为 [bundle patch](<D:/AndroidStudioProjects/dsh/dsh-clean-desktop-shell/cordis.patch.yml>)、[manifest](<D:/AndroidStudioProjects/dsh/dsh-clean-desktop-shell/package.json>)、[build](<D:/AndroidStudioProjects/dsh/dsh-clean-desktop-shell/scripts/build.mjs>)、[syntax check](<D:/AndroidStudioProjects/dsh/dsh-clean-desktop-shell/scripts/check-syntax.mjs>)、[Client 入口](<D:/AndroidStudioProjects/dsh/dsh-clean-desktop-shell/src/client/client.js>)、[Client 测试](<D:/AndroidStudioProjects/dsh/dsh-clean-desktop-shell/src/client/client.test.js>)及 [README](<D:/AndroidStudioProjects/dsh/dsh-clean-desktop-shell/README.md>)。只有新文件使既有扫描漏检时才改扫描器。不为本功能重构 Electron、bridge 或 runtime selftest。

### 插件内部接口：名称可调整，语义不得调整

```ts
type WorkerRoute = Readonly<{
  provider: string;
  model: string;
  reasoningEffort?: string;
}>;

type PublishStatus = Readonly<{
  settingsNs: string;
  state: 'needs-config' | 'publishing' | 'active' | 'failed';
  savedRoute: WorkerRoute | null;
  publishedRoute: WorkerRoute | null;
  generation: string | null;
  error: string | null;
}>;

snapshotWorkerRoute(value: unknown): WorkerRoute | null;
validateWorkerRoute(llm: LlmService, route: WorkerRoute, signal?: AbortSignal): Promise<WorkerRoute>;
buildDelegationPreset(route: WorkerRoute | null): PresetDefinition;
createPresetPublisher(deps: PublisherDeps): {
  enqueue(route: WorkerRoute | null): Promise<PublishStatus>;
  getStatus(): PublishStatus;
  stop(): Promise<void>;
};
readWorkerRouteEvidence(agent: Agent, boundary: number, signal: AbortSignal): Promise<RecoveryEvidence>;
installWorkerGate(agent: Agent, snapshot: WorkerRoute | null, deps: GateDeps): () => void;
```

字段不完整或类型错误的非空配置应抛可展示的校验错误；不能与合法空配置一起折成 null。省略 effort 表示模型默认，不把父模型 effort 强塞给不同模型。是否 materialize 默认值，依据官方 route resolver 的真实契约统一规范化，不能自行列别名或猜默认。

Client 的只读适配提供 `describeDelegation()`、`listWorkerProviders()`、`listWorkerModels(provider)`、`listWorkerEfforts(provider, model)`；返回有限的选项与 PublishStatus，绝不暴露凭据。修改只走真实 Host namespace 的 Settings/ConfigForm；不新建绕过权限的保存 RPC。只读适配的公开绑定方式必须在任务 1 证实，不假设 `host.call`、slot form 与 ConfigForm 是同一个接口。

### 已核对的宿主契约

- `agentPresets.register(definition: PresetDefinition): Promise<() => Promise<void>>`；同 id 没有原子 replace；dispose 使旧 generation retired，不直接销毁其活跃 Agent。
- `settings.update(ns: string, patch: object, expectedRevision?: number): Promise<void>`；可写字段限定 volatile。通知必须验证 owning-fiber 语义，不能轮询。
- `llm.listProviders()`、`llm.listModels(provider)`、`llm.resolveCallConfig(config, signal?)` 为 Host 能力；模型目录是建议，不是宿主 routing 的硬白名单。思考选项依据官方模型能力的 `reasoning.efforts`，不能由短目录猜出。
- `tools.guard(guard: (execution: Readonly<ToolExecution>) => string | undefined): () => void` 是同步、单调拒绝；异步恢复检查放正式 pre-execute 链，最后仍由 guard 保证无许可不执行。
- `approval.request(req: ApprovalRequest): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>`；仅 allowed-once 授权。必须在 open turn，不在 agent/created 或 idle 初始化时请求。
- `sessionQuery.readSession(sessionId: SessionId): Promise<SessionLogSnapshot>`；`observeSession(...)` 的 lease 由调用者释放。读取范围只含自己的父会话和明确关联的 child。
- rc.5 官方 subagent 成功 value 为 `{ kind: 'activation', subagentId: string }`，不是任意代理文字。该 id 是 child 激活收据，不是 child 已完成或实际请求模型的证明。
- `ConfigForm.getSnapshot()`、`subscribe(fn)`、`mutate(ops, expectedRevision?): Promise<boolean>`；false 是拒绝/跳过，不是保存成功。`configForms.get(entryId)` 需要真实 namespace；不能猜 Loader 短 id。

## 4. 任务 1：先锁定 rc.5 接缝，建立确定性契约测试

**文件：** 新增 `src/host/delegation-contract.test.js`；必要 fixture/helper 放测试范围，临时产物放 `.dsh-tmp/ptc-brain-delegation/`。本任务不接入正式 bundle、不改用户 profile。

**步骤：**

1. 用 Cordis Inspect 获取准确的 Service/Event/Slot schema；按已知路径复核必要公开源码。测试 runtime 根目录只能由显式测试参数提供，核对版本是 rc.5，不能把本机绝对路径写入发布代码。IDE 未打开目标工程时不查询其他工程，也不擅自写 DSH 工程元数据。
2. 建立真正使用 rc.5 registry/tool runtime/公开会话记录的隔离 fixture，使用确定性模型适配，不发付费模型请求、不启动替代 Web 服务器。先证明 fixture 能加载；伪造一个 guard spy 不足以完成本任务。
3. 固定以下契约断言：volatile 通知一次性重读；加载完成后健康检查不等待自身；普通工具与 PTC SDK 内层均经过同一 guard；spawn activation value 与对应持久记录保留可核验关联；正式审批记录可按 call identity 核对；Client 自有包 key、form 写入和只读状态/模型目录适配确实可绑定。
4. 对尚无适配 helper 的行为先写失败断言，再实现最小测试适配，重跑通过。公开 API 本身的能力探测是前置验证，不伪装成产品 RED。命令：`node --test src/host/delegation-contract.test.js`，先保留预期失败，再保留 exit 0 证据。
5. 交付接缝记录：准确方法/签名、调用作用域、日志字段及测试命令。任一能力不能满足设计，任务失败并停在此处；不靠 polling、toast、私有 session.events 或手改 profile 继续。

**完成条件：** 上述接缝由真实 rc.5 fixture 证明；未证实的项明确失败，不以“源码看起来支持”放行后续任务。

**审查点：** Focus 1/3/4/5。主脑/fork 判断接口证据，spawn 不自行替换安全方案。

## 5. 任务 2：规则资产、路由快照与完整 PTC 工厂

**文件：** 新增三个 assets、`delegation-config.js`、`delegation-preset.js`、`delegation-preset.test.js`。

**步骤：**

1. 复制 [官方 rc.5 源文本](<D:/AndroidStudioProjects/dsh/deepseek-harness/packages/bundle/web-app/presets/ptc.patch.yml>)，重验 SHA-256 为 `9e355c947bf61c3d2fe9bf3214b386f83c0d99d37579ce22576d4b82cb6e1a2c`；记录 tag/commit、来源和许可。源 hash 不同先停报。只从已批准规则制作资产，发布代码不读取个人配置。
2. **RED：** 工厂白名单差异、空值与错误配置、深复制、spawn/fork 配置、完整协议锚点、平台条件/隔离/PTC 展示测试。命令：`node --test src/host/delegation-preset.test.js`。缺实现时必须出现对应断言失败，而不是只报 import 错误。
3. **GREEN：** 生成独立 id `clean-desktop-shell-ptc-router`、名称“PTC + 主脑分工（插件）”的完整 definition；不使用 extends 或内部 patch。spawn 固定普通快照，两工具 maxDepth=1/modelSelectionSettings=false，fork 不带 agentOptions，workflow 保持 disabled。空配置保留模式与 fork，执行由 gate 拒绝。
4. 工厂白名单仅允许身份/描述/persona、两派发入口配置、workflow 关闭与自有 gate。personality 资产完整保留 ≤20 行小改、纯构建直做及失败先 fork 后 spawn、真实副作用分类、同失败 2 次跨代理预算、单写者/串行、验收回报和安全回滚等规则；不只拼一段角色摘要。
5. 重跑单测，并用任务 1 已固定的定义校验契约核对结构；完整挂载在任务 4 的真实 gate 实现后进行，禁止临时关闭 gate 以提前通过。审查所有非白名单差异与个人路径/别名泄漏。允许保留 provenance 的公开来源，不发布 new-api 或本机凭据默认值。

**完成条件：** 单测 exit 0，完整定义通过结构校验，官方能力无额外差异；真实挂载在任务 4 实现 gate 后验收。

**审查点：** Focus 1/2。不要把规则文本存在误称为已实现职责硬隔离。

## 6. 任务 3：独立 Host entry、设置与串行发布

**文件：** 新增 `delegation.js`、`delegation-publisher.js`、`delegation-publisher.test.js`；独立 Host 导出稍后由任务 6 接入包。原 Electron Host 入口不依赖该模块。

**步骤：**

1. **RED：** 首次空配置、A→B→C 快速保存、陈旧 expectedRevision、预检失败、拆旧后激活失败、停止中更新和重复注销测试。加入 root/child 持有 A 而新 root 使用 B 的真实 registry fixture。命令：`node --test src/host/delegation-publisher.test.js`。
2. **GREEN：** 声明一个 volatile workerRoute；读 get() 后复制普通快照。用任务 1 已证实的 owning-fiber 通知驱动发布，不轮询，不把可变对象传入 definition。路由预检拒绝无效 provider、model 或显式 effort。
3. 队列串行执行预检→await 旧 disposer→register 新 definition。可合并尚未开始的更新，已开始的更新必须收尾。激活健康检查在 Loader 已完成后做，不在 owning row 的 apply 路径内等自身。
4. 状态严格区分 needs-config/publishing/active/failed，同时保留 savedRoute 与 publishedRoute。预检失败保留旧声明；拆旧后失败不得说可用或已生效。register 返回或 Settings 保存成功不等于健康。
5. stop 禁止新 enqueue，处理自己的取消/收尾，解除自有监听与声明；不 dispose 其他插件、不强切旧 Agent、不删除会话。测试旧 generation 到 users=0 后回收，禁止并行同 id 注册和原地修改。

**完成条件：** 状态与真实 registry 行为一致；空配置模式健康但 worker 不可派发；快速保存和停止均无资源泄漏/未处理 Promise。

**审查点：** Focus 2/3。真实 request 审核留到集成验收，不能用标签替代。

## 7. 任务 4：Agent 就绪 gate、持久证据与恢复确认

**文件：** 新增 `delegation-evidence.js`、`delegation-gate.js`、`delegation-gate.test.js`；更新工厂自有 gate 配置及契约 fixture。

**步骤：**

1. **RED：** 空配置不创建 child；无 exec.agent 不放行；其他模式不受影响；有效新会话放行；恢复 A=A 证据完整放行；A≠B、证据缺失/冲突/读取失败需确认；未授权、取消或审批 unavailable 不创建 child。加入普通工具/PTC 内层、并发审批、调用取消、作用域 dispose 测试。命令：`node --test src/host/delegation-gate.test.js src/host/delegation-contract.test.js`。
2. 在预设所属 Agent 生命周期中安装 scope-local 同步 guard 和异步 pre-execute 处理。只约束本 revision 的 subagent，不改全局 request、不改调用 identity/arguments。fork 不被空 worker 阻断。任何注册都由所属 Cordis/Agent scope 清理。
3. 恢复读取限于恢复边界前的公开父记录、明确 subagentId 关联的 child header/request、以及正式审批链。初始化阶段只记录边界，不问审批；firstLiveSeq、inheritedEventCount 和恢复来源的具体边界按任务 1 fixture 固定，不能把本次刚打印的当前配置当历史。
4. 校验 activation 收据、parentSession/child 关联及实际 route；无 child 实际请求且仅有工具入参时，不将入参标成 actualRoute。需要补充路由快照时，只使用任务 1 证实会持久化的正常工具结果字段，明确 declared/actual 身份。拒绝模型自述、用户粘贴文字、失败/未批准/未完成调用、丢失记录及互相冲突的证据；不新增 session event schema，不扫描原始存储。
5. 有完整一致证据方可免确认；否则在当前 open turn 走 approval.request，理由含当前路由与不能证明历史一致的原因。只接受该 call 的 allowed-once，不缓存成整个会话或全局许可；rejected/cancelled/unavailable/异常均拒绝当前执行。不得把 policy=never 改成 ask，无法批准时指向新会话。
6. 保留 caller signal，等待受管工作收尾；同一 call 去重审批，不同 call 不共享一次性许可。若需要写结果 metadata，先证明正式 tools/execute 返回链支持，不能给 tools/post-execute 发明 meta 替换字段。工具结果与实际 child 请求不匹配时停报，不改路由掩盖冲突。

**完成条件：** 所有拒绝路径 child 创建计数为 0；恢复、审批、取消和 scope dispose 由真实 rc.5 路径验证；同进程旧 Agent 不被错误识别成必须恢复的 Agent。

**审查点：** Focus 2/4。空配置检查与恢复保护是本期 guard 全部范围，不扩张为通用职责/权限系统。

## 8. 任务 5：正式设置 UI 与原 Client 回归

**文件：** 新增 `src/client/delegation-settings.js`、`src/client/delegation-settings.test.js`；修改 [Client 入口](<D:/AndroidStudioProjects/dsh/dsh-clean-desktop-shell/src/client/client.js>)与 [Client 测试](<D:/AndroidStudioProjects/dsh/dsh-clean-desktop-shell/src/client/client.test.js>)。

**步骤：**

1. **RED：** provider 切换清空不兼容 model/effort；模型默认与支持 effort；loading/unavailable/只读表单；mutation false/transport reject/陈旧 revision；保存已成功但发布失败；saved/published 路由不同；组件卸载与重连。命令：`node --test src/client/delegation-settings.test.js src/client/client.test.js`。
2. 使用任务 1 锁定的 Slot/ConfigForm 适配，注册 `plugins.bundle.config` 的自有包名 key。配置页使用真实 Host namespace，不猜 id。只读目录返回有限选项；不输入密码/API Key，不暴露 provider 配置对象。
3. 在现有一个 lazy factory 中载入组件；React 来自浏览器 module table。设置相关可选服务缺失时仅显示本功能 unavailable，不使原 uiSession/uiWorkspace/SSE apply 失败。无同包第二 factory、DOM 注入或替代服务器。
4. 保存走正式 Settings 权限与 expectedRevision；成功只能表示写入接受，发布状态来自 Host。明确呈现待配置、发布中、已生效、失败及实际执行 route；不把一个成功 toast 当健康检查。
5. 保留一页一 SSE、goto/approve/answer/reload/重连与 cleanup；不移除或修改旧测试的有效断言。更新假服务和测试以保留原需求。新增监听/样式/订阅独立清理，文案走 locale，主题走现有 tokens。

**完成条件：** 新旧 Client 测试均 exit 0；缺分工设置服务仍不破坏原桌面桥；mode selector 不被替换。

**审查点：** Focus 3/5。

## 9. 任务 6：发布链、完整回归与有授权的 GUI 验收

**文件：** 修改 [bundle patch](<D:/AndroidStudioProjects/dsh/dsh-clean-desktop-shell/cordis.patch.yml>)、[manifest](<D:/AndroidStudioProjects/dsh/dsh-clean-desktop-shell/package.json>)、[build](<D:/AndroidStudioProjects/dsh/dsh-clean-desktop-shell/scripts/build.mjs>)、必要 [syntax check](<D:/AndroidStudioProjects/dsh/dsh-clean-desktop-shell/scripts/check-syntax.mjs>)、[README](<D:/AndroidStudioProjects/dsh/dsh-clean-desktop-shell/README.md>)；新增 `src/host/delegation-package.test.js` 与所需 locale/icon 资源。

**步骤：**

1. **RED：** 包导出/构建缺模块、缺 assets、重复模式 entry、个人路径/别名、错误 Client factory 数量、缺新增可见元信息的测试。命令：`node --test src/host/delegation-package.test.js`。
2. **GREEN：** 增加独立 Host entry 与 `./delegation`、必要 gate 子路径导出；补齐 lib 的复制映射、资产与 files。客户端 helper 必须构建到原单 factory 产物，不把裸 ESM import 留给浏览器。新增扫描漏检必须补测，不绕过已有语法检查。
3. 对新增插件行提供 en/zh 的 meta.title/meta.description 和可分发 icon，按子路径规则导出 locale/icon；保留 root 合理元信息与原 runtime exports。依赖只声明实际需要的公共包与经核对版本，避免打包另一份 Host core。compatibility 声明不得声称未测版本支持，也不得申请风险豁免。
4. 在已验证临时目录环境内执行：`npm run build`、`npm run check`、`npm test`。每条记录 exit code/首错；Node/Electron 非 Android 项目沿用该流程，不另起 Gradle。任何失败按同失败 2 次预算处理；纯构建成功不等于功能验收通过。
5. 执行 `npm pack --dry-run --ignore-scripts --json` 和实际 `npm pack --ignore-scripts --pack-destination .dsh-tmp/ptc-brain-delegation/pack --json`；对真实 tarball 核对 exports 目标、lib、assets、locale/icon、patch 与许可。源码目录可用不等于发布包完整。
6. **安装检查点：** 先用 plugin_manager 列出准确包/entry 身份与版本，向用户说明实际 tarball、目标运行 profile、是否替换旧包、潜在安装脚本/重启及恢复路径，取得明确安装授权后才 install_bundle。不手改个人 profile；管理器会登记自有 bundle，但不得覆盖其手工 ptc-router 或其他条目。pending build scripts 另得明确授权，restart-required 另得重启授权。
7. 用 browser-skill 验证现有 `http://127.0.0.1:3080`，不启动替代服务。验证只有一个新增插件模式、既有官方/手工模式与默认选择不变；空配置阻断 spawn、fork 可研究；Electron 未启动/启动失败不影响模式；原托盘气泡/SSE 操作回归。
8. 在有范围授权的测试会话中 A→B：旧 root/child 仍 A，新 root B；用真实 request/header 核对主脑、fork、spawn 及 effort，不只看设置标签。验证无效 route/effort、发布失败、取消、停用与重启恢复；重启只能在用户授权后做。不具备真实模型或浏览器/重启授权的项标“未验证”，不能模拟后宣称通过。
9. Client HMR 先确认同一运行 checkout 的 `pnpm run dev:web` watcher；当前 npm 安装包替换通常需要 restart，不能因 slot id 未变就声称更新。需要 refresh/restart 时按运行时返回的 nextStep 操作，不重建另一个 URL。

**完成条件：** 自动测试与真实包检查通过；安装/GUI/真实请求/重启分别有证据，未授权的项明确未验证。确认所有产物只包含自有改动，保留独立卸载与回滚说明；不提交。

**审查点：** 全部 Focus。代码审查由主脑或高级 fork 覆盖全新增模块和修改交界，主脑检查覆盖/冲突，不重复无关全仓库扫描。

## 10. 验收证据、回滚与交付

每任务回报固定包含：任务/失败标识、允许范围、RED 与 GREEN 命令及 exit/status、真实首错或产物、未验证项、风险、已用/剩余失败次数、仅针对自己改动的回滚。高级决策代理发现新取舍时交主脑安排，不自行修实现。

最终证据按层级区分：

- 规则/工厂测试证明配置与结构，不证明真实模型执行。
- registry fixture 证明同进程 generation，不证明重启保持旧实现。
- activation subagentId 证明创建收据，不证明 child 完成、实际 route 或验收。
- Settings mutation 接受不证明 preset 健康；Host 发布诊断与 UI 必须一致。
- 真实 request/header 证明实际路由；功能验收需要相应执行结果。没有证据就报未验证。

回滚只恢复本次明确修改的文件或用户授权的已安装包版本；先核对当前内容与他人改动，禁止全仓库 reset、擅自删除会话/产物、修改凭据或重置旧 preset。更换运行包/重启需权限，不能用文件回滚替代正式安装管理器。

交付内容：源码 diff、自动测试结果、实际 tarball/发布清单、GUI/路由/恢复证据、未验证项、兼容范围、停用与回滚说明。没有新授权不 commit/push。

## 11. 计划自检清单

- [x] 设计第 4–6 节：完整 PTC、独立 Host/Client、固定快照、发布失败和清理均有任务与测试。
- [x] 设计第 7 节：恢复证据、open-turn 一次审批及 unavailable 拒绝已覆盖；未扩大为历史实现库。
- [x] 设计第 8 节：完整协议资产不删减；软规则不冒充硬隔离/全树预算。
- [x] 设计第 9 节：确定性测试、rc.5 集成、真实包与现有 GUI 验收分层；未授权项保留。
- [x] 公共接口/未知接缝分清：任务 1 是失败即停的前置契约验证，不允许“待实现时再猜”。
- [x] 文件职责、单写者、TDD 顺序、失败预算、安装重启许可和不提交边界清楚。

这张清单只检查计划完整性，不表示产品测试、安装或 GUI 验收已经通过。
