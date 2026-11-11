# 悬浮球可见子 Agent（A1）实现计划

日期：2026-11-10 · 状态：待实施 · 范围：只做计数与视觉，不做二级气泡、不做跳转

## 目标

悬浮球与任务卡片能回答两个问题：**现在有几个会话在动**（球体角标）、**这个会话有几个子 Agent 在跑**（行末圆环数字）。信息足够"瞄一眼"，不增加任何交互层级。

## 已核实的事实（本次只读验证）

| 问题 | 结论 | 证据 |
|---|---|---|
| `agent/status` 是否覆盖子 Agent？ | 覆盖。事件由 Agent 基类自身派发，子 Agent 也是 Agent 实例 | `packages/core/agent-loop/src/agent.ts:166` `this.dispatch.emit('agent/status', { status })` |
| 能否直接列出活动子 Agent？ | **不能**。`ctx.subagents.list()` 返回的是 provider 名（spawn/fork），不是子代理 | `packages/subagent/subagent/src/index.ts:583` |
| 子会话能否直接打开？ | 工作区树隐藏子会话；session-controller 可按 parent 加载，但 UI 无入口 | `packages/client/ui-workspace/src/client/tree.ts:235`、`packages/api/session-controller/src/archived-session-gate.ts:50` |
| 父指针字段 | `header.parentSession`（另有 summary 上的 `parentId`） | `archived-session-gate.ts:50`、`packages/api/session-controller/src/history.ts:73-80` |

结论：子 Agent 只能靠事件追踪（现有 `agent/created|status|disposed` 已经覆盖），不需要也不存在"查询接口"。

## 状态模型

现有 `src/host/session-events.js:95` 用 `if (isSubagent(id)) continue` 直接丢弃子代理。改为保留条目并归组：

```
sessions[]: {
  id, name, running, approvals, questions,
  pendingApprovals[], pendingQuestions[], startedAt, finishedAt, lastChangeAt,
  // 新增
  live: boolean,            // 见下方定义
  childrenRunning: number,  // 运行中的子代理数
  childrenTotal: number     // 本次会话期间创建过的子代理总数
}
```

**live 判定（角标口径）**

```
live = running(主) || childrenRunning > 0 || (approvals + questions) > 0
```

理由：只数「正在跑」会让等待审批/提问的会话从角标里消失，而那正是唯一需要人处理的时刻。

**完成态**：`running=false && childrenRunning=0 && 待处理=0` → 行尾圆环消失，显示完成标记。

## 界面规格

| 元素 | 规则 |
|---|---|
| 悬浮球角标 | `count(live)`，上限显示 `9+`；无 live 时不渲染角标 |
| 球体 | 主会话运行 → 实心高亮；无主会话运行但有子代理 → 低频呼吸 |
| 行末圆环 | `childrenRunning > 0` 时渲染：22px 环 + 居中数字；=0 不渲染 |
| 环色 | 仅忙 → 主色；该会话有待处理 → 琥珀色（数字不变） |
| 动画 | 1.8s ease-in-out，环旋转 + 透明度 0.5→1；`prefers-reduced-motion: reduce` 时降级为静态环 |
| 宽度预算 | 行末固定预留 28px，标题 `text-overflow: ellipsis` |
| 数字 | 子代理数 `9+` |

**明确不做**：二级气泡、跳转子会话、子代理任务名、逐个子代理行。

## 实施任务（TDD，RED→GREEN）

1. **T1 采集**（`src/host/session-events.js`）
   - 去掉丢弃，改为 `parentOf(id)` 归组；父指针优先 `session.header.parentSession`，缺失则用 `header.parentId`，都缺失时归到 `root` 兜底桶
   - `snapshot()` 输出 `childrenRunning / childrenTotal / live`
   - 主子树清理：父 `agent disposed` 时移除其子树
   - 测试：子代理 created/status/disposed 三步后，父行计数正确；等待审批时 `live=true` 且 `childrenRunning=0`；未知父指针进兜底桶

2. **T2 兼容**（`src/host/session-events.js` 写文件 + `electron/read-store.js` 读文件）
   - 文件 `v` 升 2；读取端对缺失字段做默认值（旧壳读新文件、旧文件被新壳读都要不炸）
   - 测试：v1 样例文件能被新读取端解析出 `live`（按 `running` 推导）

3. **T3 行末圆环**（`electron/overlay.js` + `electron/overlay.html`）
   - 纯函数 `ringState(row)` → `{ visible, count, tone: 'busy'|'attention'|'idle' }` 单独放 `electron/overlay-ring.js` 便于测试
   - 测试：0 不渲染；3 → `'3'`；12 → `'9+'`；有 pending → `attention`；`prefers-reduced-motion` 走静态分支

4. **T4 角标**（`electron/overlay.js`）
   - 纯函数 `badgeState(rows)` → `{ visible, count, tone }`；测试：0/3/12、含 pending 的会话计为 live

5. **T5 收尾**
   - `npm run build` + `node --test electron/*.test.js src/host/*.test.js`
   - 现场验证：一个会话派 2 个子代理 → 角标 1、该行圆环 2；子代理全结束后圆环消失、角标归零

## 风险与对策

| 风险 | 对策 |
|---|---|
| 子代理的 `agent/created` 不带 session 头 → 归不到父 | 兜底桶 + trace 一行 `overlay: orphan child <id>`，首次出现即可定位 |
| 事件风暴（20 子代理并发） | 现有 150ms 合并写已足够；children 只存计数，不存明细 |
| 长会话下计数漂移（漏 disposed） | 父 `agent/status` 转 `finished` 时把子树计数清零 |
| 圆环动画在低端机掉帧 | 只用 transform/opacity；`prefers-reduced-motion` 降级 |

## 验收标准

1. 主会话空闲 + 2 个子代理运行 → 球体呼吸、角标 `1`、该行圆环 `2`
2. 主会话运行 + 2 个子代理 → 球体实心、角标 `1`、圆环 `2`
3. 有子代理等待审批 → 角标仍计入，该行圆环变琥珀色
4. 子代理全部结束、主会话也结束 → 角标消失、圆环消失、行尾显示完成时间
5. 10 个以上子代理 → 圆环显示 `9+`，行不变形
