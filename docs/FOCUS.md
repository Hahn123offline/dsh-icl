# focus：它应该是什么，现在还剩什么

> 读者：接手注意力层的人。
> 结论：**命名空间与租约骨架还在；行为语义（闸门、积压、勿扰、工具面）在 ICL 这一代已经丢了。**
> 2026-11-03 晚已恢复第一切片：`admit` 闸门、积压、focus 工具、提示词快照、`focus.json` 持久化（见 §6）。
> 证据：`packages/core/src/services.mjs`、`signals.mjs`、`host.mjs`、`packages/plugins/time`；
> 设计原稿：`C:/DSH/qwenstuff/focus-core/DESIGN-activity-focus.md`、`docs/focus-architecture.md`。

---

## 1. 它本来是什么（第二代的设计，仍应作为语义基准）

一句话：**焦点不是会话，是"一件事"**。

| 概念 | 含义 |
|---|---|
| Activity | 任何可以专注的对象：QQ 群/私聊、DSH 会话、刷 B 站、写模块、发呆。有 `id`、`kind`、`interruptible`、积压。 |
| Focus | 她在某一时刻**只占有一个** Activity 的租约；只有她自己能声明（显式工具调用），系统不替她切。 |
| Event | 所有来源（QQ、日程、计时器、B站、管理员、系统）走同一条通道，声明"属于哪个 Activity、多紧急"。 |
| Policy | 唯一裁决点：`event + focus + mute/stop + principal` → `deliver / degrade / suppress`。 |

硬约束（原设计里写明要写进测试）：

1. 同一时刻最多一个 focus；换 focus = 主动进入另一个 Activity。
2. focus 跨 turn / 跨 sleep 存活；回合结束不自动离开。
3. 进入 focus 只认显式工具调用；口头说"我去刷 B 站"不算。
4. 离开只有三条路：模型 `focus_leave`、管理员强制、停机。
5. 没有 focus = 自己的时间（idle）；这时 `push` 可直达，`note` 继续进积压。
6. 静音只关外部提醒，不关她自己设的闹钟；停机全停。

## 2. 现在还剩什么（ICL 仓库内）

| 东西 | 状态 | 位置 |
|---|---|---|
| `focus.enter/current/list/canPierce` | 有；租约在内存，重启即失 | `packages/core/src/services.mjs` |
| 投递闸门 `focus.admit` | **有（2026-11-03 晚）**；`host` 的 signal deliver 先问 focus | `services.mjs`、`host.mjs` |
| pierce 规则解析 | 有；`always/mention/never` glob | `packages/core/src/contracts.mjs` |
| 信号上的 `focus` 字段 | 有；namespace 与 delivery 的 `batchKey` | `signals.mjs`、`host.mjs` |
| 信号路由 `to:'focus'` | **从未实现**；2026-11-03 晚已删除（无任何调用方） | 旧 `signals.mjs` |
| `time` 的 goal 绑 focus | 有；`addGoal` 时 `focus.enter()`，删除时释放 | `packages/plugins/time/src/index.mjs` |
| `time` 的 sleep 绑 `sleep` 租约 | 有；sleep 拦截仍由 time gate 做 | `time/index.mjs` |
| `canPierce` 被投递层调用 | **有（2026-11-03 晚）**，经 `focus.admit` | `host.mjs` |
| Activity 注册表 / interruptible / goal / exitCondition | 部分：lease 有 `title/kind/interruptible/goal`，还没有独立 Activity 注册表 | `services.mjs` |
| 每 Activity 积压 / 未读 / watermark | 有积压计数与最近文本；没有 watermark/未读 | `services.mjs` |
| 焦点工具（`focus_status/enter/leave/backlog`） | **有（2026-11-03 晚）**，`packages/plugins/focus` | — |
| focus 持久化 | **有（2026-11-03 晚，desktop 已验证）**：`state/focus.json` 原子写；启动恢复 | `dsh-icl/src/bridge.mjs` |
| 提示词里的焦点快照 / 别处积压 | **有（2026-11-03 晚）**，`focus` 段 order 15 | `plugins/focus` |

## 3. 结论：哪一部分"彻底丢了"

**（2026-11-03 晚之前）行为语义丢了，数据结构没丢；现在第一切片已恢复。**

- `focus` 仍然是一个"注意力空间"的租约表，也能回答"谁能穿透"；
- 恢复前**没有任何投递路径问它**；现在 `host` 的 signal deliver 会先过 `focus.admit`；
- 恢复前没有 Activity、积压、勿扰、工具面；现在有积压、`interruptible`、focus 工具与提示词快照；
- `to:'focus'` 不是这套语义的入口：原设计明确"只有模型能声明 focus"，而路由是给外部来源的"入座请求"，从未实现。删它是为了避免假装；**真正的修复是 policy + 积压 + 工具，而不是这个枚举**。

## 4. 恢复建议（最小忠实版）

按依赖顺序，不先做 UI/多连接器：

1. **租约扩展与持久化**
   - lease 增加 `activity`（id）、`title`、`kind`、`interruptible`、`goal`、`exitCondition`、`expectedMinutes`；
   - `state/focus.json` 原子写；启动恢复；过期/损坏回退 idle。

2. **Activity 注册**
   - 插件用 `ctx.focus.registerActivity({id, kind, title, interruptible})` 登记；id 由来源命名（`qq:` / `dsh:` / `act:`）。
   - `focus.enter` 只接受已注册的 activity id。

3. **投递 policy（核心）**
   - 在 `host` 的 `signals.setDeliver` 之前加一层 `focus.policy(signal)`：
     - 当前无 focus → 原级别；
     - `signal.focus === current.activity` → 原级别；
     - 否则查 `canPierce(signal.focus, {mention})`：
       - `always` → 投递；
       - `mention` 且 `signal.tags` 含 `mention` → 投递；
       - 否则 → 进该 focus 的 backlog（不投递）。
   - current focus `interruptible === false` 时，非 admin/闹钟的 push 降级为 backlog。
   - 闹钟（time 自己发的 schedule/timer）永远投递。

4. **积压与 nudge**
   - backlog 按 focus namespace 存 `{count, oldestAt, lastText}`；
   - focus 释放/切换时一次性把摘要投递给模型（"你在 X 时，别处积压了 …"）；
   - 可选：空闲超过阈值发一条极短 nudge（不产生决策压力）。

5. **工具与提示词（插件层）**
   - 新 `focus` 插件注册 `focus_status/enter/leave/backlog`；
   - 每轮上下文注入"你现在在：`<title>`（勿扰）+ 别处 +N"；
   - 工具描述写明"只有显式调用才算进入"。

6. **测试**
   - 无 focus 全穿；mention 才穿；sacred 时 push 降级；backlog 在 leave 时释放；重启恢复；同毫秒 tie-break 明确。

## 5. 当前风险

- **已解除**：多来源消息不再无条件打断——有 focus 时先过 `admit`，进不去的进积压。
- **已做**：focus 持久化（`state/focus.json`），租约与积压跨重启恢复；desktop 已验证。
- **仍未做**：Activity 注册表、per-Activity 未读与 watermark、nudge（空闲轻推）、外部连接器。
- 不要恢复 `to:'focus'` 枚举：它和"只有模型能声明 focus"冲突。

## 6. 已落地（2026-11-03 晚，第一切片）

| 项 | 实现 |
|---|---|
| 租约字段 | `title / kind / interruptible / goal / exitCondition / expectedMinutes`；`list/current` 都带 `release()` |
| 投递裁决 | `focus.admit(signal)`：无 focus 全穿；同 focus 穿；`interruptible=false` 只放行 time/admin/alarm；其余按 `canPierce`，不穿就 `defer` |
| 积压 | 按 `signal.focus` 计数；`backlog()` / `drainBacklog()`；focus 释放/切换时由 host 合成一条摘要投递 |
| 工具 | `packages/plugins/focus`：`focus_status` / `focus_enter` / `focus_leave` / `focus_backlog` |
| 提示词 | `focus` 段 order 15：当前焦点 + 勿扰 + 别处积压 |
| 测试 | `focus-semantics.test.mjs`（7 个）+ bridge 落盘恢复测试 |
| 持久化 | `state/focus.json`（租约 + 积压，原子写）；启动恢复；desktop 已验证 |
| 未做 | Activity 注册表、watermark/未读、nudge、外部连接器 |
