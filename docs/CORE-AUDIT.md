# 核心、信号与 DSH 接线的审计

> 读者：接手核心层的人。
> 范围：`packages/core`、`packages/adapters`、仓库外的 `icl-live` 接线，以及 `signals → delivery → DSH` 这条通信链。
> 基线：2026-11-03，HEAD `7314168`，`npm test` 193 通过。本文只记"现存事实 + 目标契约"；迁移计划在 §7。
>
> **P0 已落地（2026-11-03 晚）**：§3/C1–C5 与 §4/B1–B7 已修，新增 `packages/dsh-icl` 与 `dsh-contract`，测试 269 通过；真实 headless 会话验证了工具面（27 个）、人格段、原文层、`time_arrange`，以及 wake → `agent.followup` → 新轮（session `1f855bc3`）。现状以 [STATUS.md §9](STATUS.md#9-2026-11-03-晚dsh-接线重建p0) 为准。

---

## 1. 结论

核心的服务契约、测试纪律、数据层是干净的；**不干净的全在"边界"**：

1. 真正的 DSH 接线不在仓库里，而且用了三套互相不知道的通道：`adapter-dsh`（按旧契约）、`delivery-pump + HTTP`（按 Web API）、`icl-live` 自己直接注册（按旧契约）。
2. 三套里没有一套满足 DSH 当前的工具定义契约——**工具注册缺 `output`，真实 DSH 会直接 `TypeError`**。仓库内 193 个测试都测不到，因为 `fakeDsh` 只有 `tools.register` 的形参。
3. 信号层把"事件总线"和"往模型送消息"合成一个服务，但 `focus` 路由没有实现、`expiresAt` 从不生效、投递器缺失/抛错时信号静默消失，且 `kind` 在进入 delivery 时被丢掉，导致"紧急"永远无法变成 steer。
4. 仓库根上有两份同 HEAD 的 clone；`icl-live` 实际从 `C:/DSH/qwenstuff/icl` 加载，而不是当前工作区。bili 与三个 tools 脚本也指向那个 clone。
5. 每轮上下文（`prompt.turnText` / `context.assemble`）在活跃接线里**从未被调用**；eager-recall、compaction 的上下文策略实际上没进过模型。

一句话：**核心不是坏了，是没有一根符合 DSH 规范的线把它接上去。**

---

## 2. DSH 侧的真实契约（已核对安装包与官方 README）

| 能力 | 正确用法 | 依据 |
|---|---|---|
| 注册工具 | `ctx.tools.register({ name, description, parameters, output: { schema, render }, execute })`；**`output` 必填**，缺失抛 `TypeError` | `@deepseek-ai/dsh-tools` `lib/index.js` `register()`；README §Register a tool |
| 工具参数 | `parameters` 是**原始 JSON Schema**（`{ type:'object', properties, required, additionalProperties }`），不是 `defineTool` 的 DSL | `@deepseek-ai/dsh-llm` `ToolSchema.parameters` |
| 工具返回值 | 只返回 `output.schema` 声明的 JSON 值；模型看到的内容由 `output.render(args, value)` 生成 | `dsh-tools` `ToolOutputDefinition` |
| 系统提示词 | `ctx.systemPrompt.section({ name, order, text })`；`text` 可以是**每次装配求值的函数**，不要定时重注册 | `dsh-system-prompt` `PromptSection.text: string \| ((context) => string)` |
| 会话事件 | `ctx.on('session/event', (session, event) => …)`；`turn/end`、`user/message`、`assistant/message`、`tool/result` 都在 `event.type` 上 | `dsh-session` `lib/types/index.d.ts` |
| 会话创建 | `ctx.on('session/created', (session) => …)`；**同步 throw = 否决并回滚** | `dsh-session` 事件声明 |
| 给会话送消息 | `agent.followup(msg)`（下一轮、唤醒）、`agent.steer(msg)`（插当前步）、`agent.inject(msg)`（不唤醒） | `dsh-agent` README §Drive an agent's conversation |
| 构造消息 | `{ id: randomUUID(), role:'user', content:[{type:'text',text}], source:{kind:'user'} }` | `dsh-llm` `createUserMessage()` 实现 |
| 每步上下文 | `agent/pre-step` waterfall，返回 `{ ...decision, messages }` | `dsh-agent` `runtime-types` |
| 日志 | `ctx.logger(name).info/warn/error/debug`；**`ctx.log` 不存在** | `cordis` `context.d.ts` |

**结论**：不需要 HTTP、不需要发现端口、不需要 `DSH_LAUNCH_TOKEN`、不需要扫 `session_projcache`。

---

## 3. 接线层的不干净处

### 3.1 三套并存

| 路径 | 位置 | 现状 |
|---|---|---|
| `attachDshAdapter` | `packages/core/src/adapter-dsh.mjs` | 只传 4 个字段，没有 `output`；真实 DSH 会拒绝 |
| `createDeliveryPump` + `dsh-client.mjs` | `packages/adapters/` | 从 `netstat` 猜端口、读 token、走 HTTP `sessions.prompt`；仓库内零调用方 |
| `icl-live/index.mjs` | `~/.dsh/plugins/icl-live/` | 自己 `syncTools` + 自己注册 section + 自己用 HTTP 观察 turn-end，**不使用**上面两者 |

`adapter-dsh.test.mjs` 的 `fakeDsh()` 只实现 `tools.register(def)` 与 `systemPrompt.section()`，所以缺 `output`、参数形状、作用域都没被验证。

### 3.2 具体缺陷（按后果排序）

| # | 位置 | 事实 | 后果 |
|---|---|---|---|
| A1 | `icl-live/index.mjs:9` | `ICL_ROOT = 'C:/DSH/qwenstuff/icl'` | 当前仓库改了不生效；两个 clone 同 HEAD，全靠人记 |
| A2 | `icl-live/index.mjs:226-254` | 用 `netstat -ano` 找自己的端口，401 正文含 dsh 才认 | 端口/认证一变就全断；启动慢且不可测 |
| A3 | `icl-live/index.mjs:339-373` | 工具定义没有 `output`；`parameters` 从 props 重建 | 真实 DSH `register()` 抛 `TypeError`，工具面为空 |
| A4 | `icl-live/index.mjs:385-399` | 每 5 秒 `sectionOff()` 再 `section()` | 装配竞态；DSH 本来就支持 `text` 函数 |
| A5 | `icl-live/index.mjs:187-217` | 扫 `~/.dsh/storages/session_projcache/sessions/*.json` 按 cwd 猜会话 | 猜错/猜不到；resume、归档、子会话全不覆盖 |
| A6 | `icl-live/index.mjs:44-49` | 模块级 `activeInstances`，第二个会话直接 `return () => {}` | 第二个会话静默没有 ICL；无日志、无 UI 提示 |
| A7 | `icl-live/index.mjs:111-113` | `ctx.log?.(payload)` | cordis 没有 `ctx.log`；所有日志丢弃 |
| A8 | `icl-live/index.mjs:339-374` | `syncTools` 只加不删 | 插件停用后旧工具仍在 |
| A9 | 全仓库 | 没有地方把 `prompt.turnText` / `context.assemble` 接到 DSH 的每一步 | eager-recall、compaction 的上下文段从未进模型 |
| A10 | `dsh-raw` | 读 `~/.dsh/sessions/*.jsonl.zstd`，只解析 user/assistant | 工具结果（视频标题、UP 主）永远进不了记忆；文件格式一变就空 |
| A11 | `icl-live` 的 `wiring` | 只启用 11 个插件 | persona / whois / eager-recall / rhythm / model-manager 没接；没有统一 loader |

### 3.3 单会话

`host.claimSession` 只有 `session.mjs` 调用；活跃接线没有用它。`icl-live` 的锁是模块级 Set，且失败姿态是**静默不加载**。正确做法是在 `session/created` 同步 throw，让 DSH 自己回滚并显示原因。

---

## 4. 信号层的不干净处

`signals` 同时承担"插件事件总线"和"往模型送消息"，但两条语义没有分开。

| # | 事实 | 后果 |
|---|---|---|
| B1 | `SIGNAL_ROUTES` 有 `focus`，`offer` 对 `to:'focus'` 只计数、不投递 | 死路由；文档却把它写成三条之一。focus 的语义缺口见 [FOCUS.md](FOCUS.md) |
| B2 | `expiresAt` 只被 time 插件的积压队列读取，`signals` 自己不检查 | 过期消息照样进入模型 |
| B3 | `to:'model'` 且没有 `deliver` 时，`offer` 仍返回 `accepted:true` | 静默丢消息 |
| B4 | `seen.set` 在 gate/deliver 之前；`deliver` 抛错后 id 已被占用 | 一次瞬时失败永久丢掉这条消息 |
| B5 | gate 抛错直接冒泡；订阅者抛错只少 `delivered` | 一个坏插件可以让全局信号崩/静默失灵 |
| B6 | `signal.kind` 不进入 delivery；`batch.urgent` 无人设置 | `wake/goal/notice` 在 DSH 侧无法区分，`steer` 永远用不上 |
| B7 | `emit` 强制 `to:'plugin'`，但 `accepted`/`emitted` 两套计数混在一起 | 统计无法回答"有多少条真的送达模型" |
| B8 | `session.drainOnce` 自己发 `turn-end` 信号；活跃接线又用 HTTP 发一次 | goal 可能被 resume 两次 |

---

## 5. 核心层的其它不干净处

| # | 位置 | 事实 | 后果 |
|---|---|---|---|
| C1 | `host.mjs:20` | `tools.onChange` 只写日志，不调 `surface.notify()` | 运行中注册/注销工具不通知适配器 |
| C2 | `host.mjs:218` | `enable` 在 `apply` **之前** `notify` | 适配器先看到空工具面；失败路径（第 234-240 行）反而不再 notify |
| C3 | `services.mjs:174` | `preset && preset !== presets.active() ? preset : presets.active()` | 传进来的 preset 基本被忽略 |
| C4 | `prompt.assemble` / `context.assemble` / `raw.*` / `surface.notify` | 空 `catch` | 段消失、来源失效，调用方完全不知道 |
| C5 | `adapter-dsh.mjs:35-40` | 只传 `name/description/parameters/execute`；比较只比 execute/description | 真实 DSH 拒绝；参数变化不重注册 |
| C6 | `session.mjs:27` | `installTools` 用 `surface.list()`，不按预设过滤 | 与 adapter 那条路不一致 |
| C7 | `presets` 服务 | `use/define/allowed` 无产品调用方；唯一预设 `default`；16 个 manifest 无 `presets` | 死机制，文档却写了 |
| C8 | `time/index.mjs:108` | `ctx.signals ?? ctx.services.require('signals')` | 后者必然抛（signals 不在 shared） |
| C9 | `model-client` 挂到 ctx | 只有 5 个方法，`current/inflightCount/chatDetailed/chatInner` 取不到 | 文档与代码不一致 |

---

## 6. 目标架构

```text
DSH Host
  preset icl（agent 作用域）
    └─ dsh-icl（本仓库新增，唯一的 DSH 接线）
         ctx.tools.register(...)        工具面（带 output）
         ctx.systemPrompt.section(...)  提示词段（text 函数）
         session/created                领会话 / 单会话否决
         agent/created                  await ready → 绑定 agent
         session/event                  turn/end、原文缓冲（含 tool/result）
         agent/pre-step                 turnText + context.assemble
         delivery → agent.followup     队列真正送进会话
         session 历史 → context.provideHistory
         agent.session → raw 来源
```

核心保持零 DSH 依赖；DSH 只认识 `dsh-icl` 一个包。

**为什么不用 Host 插件**：preset 作用域天然把工具/提示词隔离给选用该 preset 的 agent；`session/created` 在 preset 作用域可见（`dsh-icl` 第二代已实证）。Host 插件会把工具变成全局，需要额外的 restrict。

**为什么 delivery 还保留**：`delivery` 是 ICL 自己的重试/水位/批量层，信号是它的上游；DSH 只是它的下游。把下游从 HTTP 换成 `agent.followup`，上层语义不变。

---

## 7. 迁移顺序

| 阶段 | 内容 | 判据 |
|---|---|---|
| P0（本轮） | 修信号语义与核心通知；新增 `packages/core/src/dsh-contract.mjs`；新增 `packages/dsh-icl`（本仓库 DSH 桥 + preset）；契约测试 | `npm test` 全绿；假 ctx 能装配出带 `output` 的工具 |
| P1 | 用 `--patch` 在 headless profile 起一个真实 DSH 会话（不改用户 profile） | 会话里能看到 ICL 工具；`session/created` 领到会话；turn-end 到达 signals |
| P2 | 把 preset 装进 desktop profile，开一次真实会话；用 `session/event` 喂原文层，替换 dsh-raw 的文件扫描 | 一条 wake → followup → 新轮；dream 能读到 tool/result |
| P3 | 删除 `adapter-dsh` / `delivery-pump` / `dsh-client` 的活跃路径，文档收敛成一条 | 仓库内只剩一处 DSH 契约 |

**不做的事**（本轮）：不改任何插件的业务逻辑；不接 QQ/MC/B 站新能力；不碰 `presets` 死机制（只在文档标记）；不动 `dream` 的 7 个 job。
