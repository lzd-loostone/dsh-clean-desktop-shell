# PTC + 主脑分工：桌面插件集成设计

日期：2026-10-30  
状态：设计草案，待用户最终确认；不是实现、安装或提交授权。

## 1. 意图与已确认方向

安装 `dsh-clean-desktop-shell` 后，在 DSH 已有模式选择器中看到“PTC + 主脑分工”，不再手工复制个人 profile。核心是设计决策与明确执行的职责、模型分工，不是自动挑选便宜模型。

用户已确认方向 B：独立 PTC 预设 + 执行模型设置模块。工作规模是一次中等规模的插件扩展，不重做桌面壳、不改 DSH 本体。本设计尚未获最终批准。

### 已考虑的方向

- A，仅打包当前预设：入口最小，但执行模型仍需手工改配置，个人 provider 别名不可移植。
- B，预设与设置模块：安装出现入口，执行路由可配置，复用官方 PTC 和模式选择器。用户已选择。
- C，完整 Agent Teams：增加持久队伍、依赖和审批，但范围更大，不等于现有 fork/spawn 分工；不采用。

## 2. 基线与硬约束

- 验证目标：DSH `0.2.1-rc.5`，tag `dsh-v0.2.1-rc.5`，commit `b830ec950faba0a46dda564be3e2d854afed94f1`。本机安装包也是该版本；不因其他版本较新就认定兼容。
- 分工基线是[当前预设](<C:/Users/Loostone/.dsh/profiles/web/cordis.patch.yml#L205-L437>)及用户提供的最终决策。它只用于制作受版本管理的规则资产；运行时不读取个人绝对路径。
- [原始文档](<C:/Users/Loostone/.dsh/docs/agent-model-routing-plan.md>)中禁 fork、纯构建一律委派等旧规则不沿用。
- 官方 PTC 来源是[rc.5 组合](<D:/AndroidStudioProjects/dsh/deepseek-harness/packages/bundle/web-app/presets/ptc.patch.yml>)；记录的 SHA-256 为 `9e355c947bf61c3d2fe9bf3214b386f83c0d99d37579ce22576d4b82cb6e1a2c`。实施时重验字节；源变化先停报，不自动覆盖用户规则。
- [PresetDefinition](<D:/AndroidStudioProjects/dsh/deepseek-harness/packages/preset/agent-preset-registry/src/definition.ts#L5-L10>)无 extends/base；[patch](<D:/AndroidStudioProjects/dsh/deepseek-harness/vendor/include/src/index.ts#L65-L122>)不进入预设的 config.plugins，config 整体替换。不使用“继承 ptc 后局部 patch 内部条目”的未经支持语法。
- 沿用仓库 JavaScript、动态 Client 模块与[复制式构建](<D:/AndroidStudioProjects/dsh/dsh-clean-desktop-shell/scripts/build.mjs#L1-L28>)；新增模块须进入构建、exports 和发布清单。新构建器或依赖若确有必要，先报依据。
- 不修改个人 profile、凭据、AGENTS 或 Skill；不自动切默认模式，不覆盖旧预设，不自动 commit/push。

## 3. 目标、非目标与失败条件

### 目标

1. 安装并启用插件后，已有模式选择器展示一个独立、健康的插件预设。
2. 主脑与决策 fork 保持父会话当前有效模型；spawn 使用配置的固定执行路由。
3. 设置页选择执行 provider、模型及可选思考档位，不收集凭据、不复制个人 provider 别名。
4. 保存设置发布新 revision；同进程已绑定会话及其 child 保留旧 revision。
5. 未配置、能力不支持、激活失败与不兼容均有明确反馈，不静默使用主脑或其他模型执行。
6. 分工模块与 Electron 启动独立，原有托盘、气泡和桥接不退化。

### 非目标

完整 Agent Teams、持久任务板、自动难度分类、价格分档、故障转移、自动换执行模型、review_agent、native 子预设、workflow、OS 沙箱、文件硬隔离、职责权限守卫、持久任务锁、全树硬金额/token 预算，以及跨进程保存旧预设实现。

### 失败条件

未配置 worker 却继承主脑模型；fork 被一刀切降为 executor；UI 只说保存成功却隐瞒未生效；同进程旧会话被改路由；关闭 Electron 就失去模式；新模块异常拖垮桌面原有能力；只看工具参数就宣称真实路由或验收通过。

## 4. 模块组成

### Host 设置与发布

同一个 npm 包增加独立 Host 导出与 Loader entry，不挂在 Electron 自动启动分支。该模块拥有 workerRoute 设置、纯定义工厂、发布状态与串行队列，使用已核对的 agentPresets/settings/llm 公共 Service。监听、disposer 和停止队列由 Cordis 生命周期托管，不轮询。

建议 id=`clean-desktop-shell-ptc-router`，名称=`PTC + 主脑分工（插件）`。这是设计建议，不是用户指定命名。官方 ptc、手工 ptc-router 与默认选择均保留。

### PTC 与规则资产

包内保存官方 rc.5 PTC 组合与来源信息，工厂生成完整 PresetDefinition。只改预设身份、描述、persona、两派发入口、关闭 workflow 及执行路由就绪检查；保留官方 planning/compaction 隔离与 PTC 展示。

persona 的个人 worker 名称改成该 revision 的执行路由描述，职责规则保持不变。不得运行时抓 GitHub、读取用户 profile 或反解析 viewing-only readDocument 作为继承 API。

### 最小路由就绪检查

这是落实“未配置 worker 不得静默回退”，不是完整权限守卫。对使用本预设的 Agent，通过 agent.ctx 的 tools.guard 检查 subagent 派发。条件绑定本 revision 的普通配置快照；未配置则返回模型可见错误与设置指引，不创建 child。fork 的设计/研究能力不因此被阻止。

必须覆盖官方工具执行和 PTC SDK 内层调用，不改全局工具，不绕过审批，不声称拦住所有主脑写入或 shell 副作用。

### Client 设置

在 plugins.bundle.config 的包名 key `dsh-clean-desktop-shell` 下显示表单，复用 DSH 的 settings 写入、权限与主题。包含 provider、模型、思考档位、保存及发布状态。既有模式选择器继续负责模式选择，不替换 conversation.hero.agentPreset，不做 DOM/iframe 注入，不另起 UI 服务器。

## 5. 配置与分流

- Host 拥有一个 .volatile() 的 workerRoute 对象，内容是 provider/model/可选 reasoningEffort。空配置合法，模式可以出现，但 spawn 不能执行。
- 选项来自已配置 provider 与模型目录；不内置 new-api，不创建 provider，不收集 API Key。
- 思考档位提供“模型默认”及该执行模型支持值。显式不支持的档位拒绝生效，不钳制、别名改写或自动降级。
- settings 更新携带 expectedRevision；陈旧客户端不能覆盖新保存。
- 状态区分待配置、发布中、已生效、发布失败。保存的路由与实际发布路由不同，必须明确显示。
- subagent：provider=spawn、modelSelectionSettings=false、maxDepth=1，agentOptions 来自该 revision 的普通快照，不每次动态读 settings。
- subagent_fork：provider=fork、modelSelectionSettings=false、maxDepth=1，不设置 agentOptions，宿主继承父最近有效请求的 provider/model/reasoning。spawn/fork 是子代理后端，不是 LLM provider。
- 两类 child 保留父准确 PTC revision，不再委派。fork 只继承已完成轮次，派发必须补写当前在途要求、新事实、范围与交付。
- [宿主路由解析](<D:/AndroidStudioProjects/dsh/deepseek-harness/packages/subagent/subagent/src/child-agent.ts#L68-L118>)在路由改变且未显式指定 effort 时清除父 effort；不把主脑档位强塞给不同模型。

## 6. 发布、失败与卸载

[registry](<D:/AndroidStudioProjects/dsh/deepseek-harness/packages/preset/agent-preset-registry/src/index.ts#L77-L151>) 的签名为 `async register(definition: PresetDefinition): Promise<() => Promise<void>>`。同 id 并行注册报重复，没有原子 replace。

1. 初次或 settings 通知到达后，读 workerRoute.get() 并复制快照；预检字段、路由、模型能力与完整定义。无 worker 生成待配置定义。
2. 队列串行发布；可合并尚未开始的更新，但已开始发布必须收尾。显式 await 旧 disposer，再 register 新完整定义。
3. 不原地修改旧 definition、共享配置或仍被引用的 generation。旧 generation 只有 retired 且 users=0 才回收。
4. 激活诊断健康后才说已生效，settings 保存或 register 返回均不足以证明健康。
5. 预检失败不拆除旧声明；明确新保存尚未生效，并展示当前实际路由。拆旧后激活失败，新入口标失败，后续会话不称可用，已绑定旧 generation 不强切。
6. 不无限重试或悄悄换模型。用户修正问题或恢复有效配置后才重新发布。
7. 停用/卸载先停止新发布，取消或等待自己的工作，再注销自有声明、监听、guard 与 UI；不重启 Host、不改其他插件、不删会话。

设置优先使用经验证的 owning-fiber volatile 通知；settings/document-updated 可按 namespace 提示重读。loader/volatile-update 有源码证据但 Inspect 未收录，实施时验证，不能假设可用或换成轮询。

健康诊断内部可能 loader.await()；不能在 owning Host row 激活路径内同步等待会等回自身的诊断，须加载完成后检查。生命周期接缝若不能满足上述契约，实施者先停报，不猜测重试。

## 7. 旧会话与重启：待确认的保守建议

旧会话冻结只对同一进程仍持有旧 generation 的 Agent 成立。rc.5 重启只保留 preset id，不保存旧插件实现，不能承诺重建历史 revision。

建议本期不做历史预设快照库。重启恢复会话时，首次 spawn 前核对持久记录中的既往执行路由与当前路由；无法证明一致则拒绝该次派发，明确展示当前路由，请用户确认或改用新会话。审批支持缺失时保持拒绝，不静默放行。fork 和只读分析仍按权限工作。

仅使用既有公开会话记录/日志与明确工具结果，不读未经授权的原始存储，不新增不可恢复的模型可见事实，也不新增自定义 session event schema。公开通道若不能可靠实现检查/确认，先停报；不能弱化成一个 toast。

该恢复确认策略是设计建议，尚未被用户单独确认。如果用户要求跨重启自动保持旧 worker，需改为持久路由快照设计，范围增加。

## 8. 保留的执行协议

- 主脑默认澄清、设计、阅读、review、拆解和只读；按真实副作用而非命令名分类。设计、取舍、风险与问题定级由主脑或 fork；明确执行/机械收集由固定模型 spawn。新取舍停报，决策代理不自行实现。
- 小改直做必须全部满足：同任务单文件累计增删≤20 行，不需构建/测试/多方案比较，不操作设备且用户未要求产物，不涉权限/凭据/依赖/构建配置/数据迁移/公共接口。不拆任务绕限，注明未跑构建/测试。
- 纯编译/构建/安装无源码修改且无后续测试/启动验收/功能验证时主脑直做，可交付产物。失败需处理先 fork 决策，再 spawn 修复验证；首次失败计预算，主脑不自行排错反复重试，成功不称测试通过。
- adb pull、bugreport 非只读；用户明确授权的产物采集可由主脑在范围内完成。卸载、push、删除、重启、启动验收非纯安装例外。
- 执行卡包含目标/非目标/验收、cwd/文件函数范围/禁项、测试构建路径/产物证据、预算/升级/回报/回滚。研究卡明确问题与交付。
- 同任务同失败最多尝试 2 次，首次计入，跨主脑/child/重新委派累计；卡与回报带任务/失败标识、已用和剩余。耗尽停报，不重新派发重置。
- 改方案/文件范围/模型/预算先报主脑。不可用工具或权限拒绝不绕过，用户权限与 plan mode 优先。
- 文件单写者、同 cwd 构建串行、同设备操作串行；独立只读可并行，不重复 child 正在验证的工作。只回滚自己，不全仓库 reset，不擅自提交/推送/删他人产物。
- 回报区分通过/失败/未验证，含真实命令或 IDE 目标、退出码/状态、证据/产物或首错、风险/回滚。主脑检查覆盖和冲突，不把 child 自述当证明，也不重复全扫已委派高级模块。
- Android/KMP 先用 android-build-via-ide，不自行降级 CLI Gradle；其他项目沿用自身流程。child 继承 PTC；native 与成本比较必须有实际失败/请求/重试/耗时/计费证据。persona 不是硬隔离。

## 9. 验收

### 确定性测试

- 组合工厂只改变白名单差异，检测来源变化，不发布个人路径、凭据或默认 provider。
- 空 worker、provider 缺失、模型/effort 不支持：失败明确，PTC/普通工具路径均不创建执行 child。
- fork 不覆盖 agentOptions，spawn 固定快照，入口 maxDepth=1/modelSelectionSettings=false，workflow 关闭。
- 快速连续保存与过期 revision：串行、无重 id、无原地修改；预检/激活失败和卸载中发布清理正确。
- 同进程 root/child 的旧 revision 保留，新根会话用新快照；恢复无法证明路由一致时不静默执行。

### rc.5 集成与发布测试

- 从真实发布产物安装后只出现一个插件模式，官方/手工模式和默认选择不变。未启动或启动失败的 Electron 不影响分工，原功能无退化。
- 对照真实 request/header 与模型响应，核验主脑/fork/spawn；不能只看入参或设置标签。fork 的当前在途要求须补写。
- 设置 A→B：已有会话仍 A，新会话 B；UI 显示生效或具体失败。验证重启恢复、待配置、不支持档位和激活失败。
- 停用/卸载只清理自身，不删会话或他人的 settings 字段。
- 新测试按 TDD 先失败再通过，运行现有检查/测试，验证 exports/构建/发布清单和干净安装。
- 验证现有 GUI http://127.0.0.1:3080，不另起替代服务器；HMR 先核对 watcher，不能验证的项标未验证。

## 10. 借鉴与许可

仅借机制，不整包嵌入第三方插件。候选 manifest/README 声明 MIT；实际复用仍核对并保留许可与出处。

- [thedeveloper256/dsh-model-router](https://github.com/thedeveloper256/dsh-model-router/blob/d5205b3829f1301a8ff8b18da3bec71bd75d9e17/src/policy.ts)：纯策略与测试；不采用所有 fork 降执行模型。
- [specify-subagent-suite](https://github.com/Cho-Geer/dsh-specify-subagent-suite/blob/3d8107fa0df6dbefd039d33d35b65e372fcf1411/lib/host/subpro.js)：快照与真实模型审计；不把填派发参数当硬锁。
- [delegate-router](https://github.com/penguin-oo/dsh-delegate-router/blob/33db3b0d393e48f3d62d1f44cced4b579fae2306/lib/index.js)：配置来源；不采用自动难度或超预算只降模型。
- [AgentTeams](https://github.com/NanmiCoder/dsh-agent-teams/blob/3331b903f0e954d59ac69be1a75fd4fd7e1de20e/src/quality-gates.ts)：契约与内容绑定复审；不把全 passed 报告当执行证明。

## 11. 留给实施者与批准门槛

实施者可决定文件拆分、函数名、表单细节、测试桩和队列去重，但不能改变职责、更新与安全语义。

须先验证的接缝：设置通知、激活后健康检查、PTC 内层 guard、公开恢复记录与确认、Client 导出和发布资产。不满足则带证据停报，不能删验收或扩展成更大系统。

第 7 节恢复策略需用户确认。最终设计批准后才进入实施计划；本设计不授权改实现代码、安装、修改 profile、运行构建或提交。

## 12. 设计检查记录

2026-10-30：同模型 fork 完成只读可规划性检查，结论为 `nothing important left`。没有新增需求缺口；第 7 节恢复策略仍需用户确认，第 11 节接缝仍需实施前验证。此检查不是代码评审、运行验证或实现完成证明。
