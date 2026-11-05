# 闭环：在真实 DSH 会话里验证整体设计

> 读者：要跑长时闭环、或判断某次闭环证据能不能信的人。
> 结论先说：**旧的 `tools/marathon.mjs` 不是闭环**，它是一个独立的最小 agent 循环，工具协议是提示词里的文本 JSON，不经过 DSH 的 `ctx.tools`、`session/event`、真实投递与 focus gate。它跑出来的“稳定”不能证明应用环境稳定。

## 1. 目标与非目标

闭环要回答的不是“模型能不能聊 30 分钟”，而是四件事在同一场真实会话里是否成立：

1. **信息是否充分**：每轮 `system/message` 里是否真的带了时间、世界状态、待办、人格；模型是否能在不额外查库的情况下回答“现在是什么时候、我在做什么、有什么没了结”。
2. **时间是否稳定**：一条安排是否只响一次；睡眠期间消息是否被拦截并在醒来时成批释放；`daily` 安排跨重启是否去重；暂停是否只暂停计时。
3. **focus 是否简单有效**：进入/查看/离开是否只需 1–2 次工具调用；焦点期间别处信号是否进积压而不是打断；离开时摘要是否出现；`focus` 是否真的减少了插话。
4. **哪里“不好用但能优化”**：工具调用次数、失败重试、上下文体积、无意义轮次、诊断信息缺失，都要在报告里逐条列出来，而不是靠人回看聊天记录。

非目标：不替代单元测试；不追求“模型说它很好”；不在闭环里跑 `marathon` 那种假工具协议。

## 2. 为什么旧闭环不可信

| 旧东西 | 实际是什么 | 问题 |
|---|---|---|
| `tools/marathon.mjs` | 独立 `createHost` + 文本 JSON 工具协议 | 没有 DSH 会话、没有真实 `ctx.tools`、没有 `session/event`、没有 focus/time gate；模型输出 JSON 的稳定性与 DSH function calling 无关 |
| `tools/time-accept.mjs` | host 级时间验收 | 只测 `time` 自己，不测真实投递、DSH 轮次、会话日志 |
| `tools/dsh-session.mjs` | 建会话/发 prompt | 没有事件观察、没有场景、没有断言、没有报告 |
| `tools/replay.mjs` | 离线读旧记录重跑 dream | 不是实时闭环 |
| `tools/quality-run.mjs` | 固定素材跑 dream | 只测做梦产物，不测会话 |

所以闭环必须**以 DSH 为执行环境**，外部脚本只做驱动与观测。

## 3. 架构

```
scenario.json
   │
   ▼
driver.mjs ── session/prompt / cancel / selectModel ──▶ DSH desktop
   │                         ▲
   │                         │ session/follow (remote.mux)
   │                         │
   ├────────── events.jsonl ─┘   (snapshot + 每个 session/event)
   │
   ├── control/time.inbox.jsonl ──▶ ICL time（仅测试 preset）
   ├── control/loop.inbox.jsonl ──▶ loop-probe（仅测试 preset，注入外部 signal）
   │
   └── artifacts/
         run.json          # 参数、preset、session、时间线
         events.jsonl      # 原始 DSH 事件（seq/time/type/data）
         context/*.txt     # 每轮 system/message 快照
         state/*.json      # time.json / focus.json / world 快照
         memory/*.json     # 导出（不读二进制）
         report.md         # 人看的结论 + 摩擦点
         verdict.json      # 机器断言结果
```

### 3.1 Driver

`tools/loop.mjs`：

- 连接 `http://127.0.0.1:<GUI 端口>`，`session/create` 一个专用 preset，`session/follow` 打开事件流。
- 每个 scenario 步骤是数据，不是硬编码：
  ```json
  { "id": "world-after-memo", "action": "prompt", "text": "调用 memo ... 再 world_status", "timeoutSec": 90 }
  { "id": "wake-plus-1m", "action": "time", "cmd": "arrange", "args": { "id": "wake-1", "in": "1m", "message": "醒醒" } }
  { "id": "focus-signal", "action": "signal", "from": "qq", "focus": "group:1", "text": "别处消息" }
  { "id": "assert-world", "action": "assert", "expect": { "systemContains": ["时间：", "待办："] } }
  ```
- 每步有**独立超时**；失败只让这一步失败，不把整个进程卡死。
- 断点：每步完成后写 `checkpoint.json`；重跑从最后一步继续（或 `--fresh`）。

### 3.2 Observer

不靠模型自述，也不靠聊天截图：

- `session/follow` 的 `session/snapshot` + `session/event` 是权威源。
- 记录 `turn/start`、`step/start`、`system/message`、`tool/call`、`tool/result`、`assistant/message`、`turn/end`。
- 从 `system/message` 抽每轮上下文；从 `tool/call`/`tool/result` 抽工具名、参数、结果、耗时；从 `turn/end` 算轮次与停等。
- ICL 的 `session-events.jsonl`、`time.json`、`focus.json` 作为**状态侧证**；不把模型的话当状态。

### 3.3 Control

- **时间**：复用 `time.inbox.jsonl` 的 `status/arrange/pause/resume/sleep/wake/cancel`；测试 preset 的 `timeTickMs` 调小（1s），控制命令不需要等 15s。
- **外部信号**：新增一个只在测试 preset 启用的 `loop-probe` 插件，读 `loop.inbox.jsonl`，用 `ctx.signals.offer` 注入 `from:{plugin:'qq'}` 的普通信号。这样 focus 的“别处积压”是**真的走 gate**，不是测试里直接调服务。
- **做梦**：测试场景用 `time` 的 `arrange` 创建一条 `tags:['dream']` 的 silent 安排（或直接 `sleep` 触发 `sleep-start`），不依赖等到 23:00。
- **时钟**：默认用真实时钟（后台跑，用户不用等）；需要压缩长夜时，测试 preset 可开 `testClock`，通过 `time` 控制命令 `clock`/`advance` 推进虚拟时间。两种模式在 `run.json` 里标明，报告不混用。

### 3.4 Isolation

不能拿用户正在用的 `~/.dsh/icl/state` 做长跑。推荐在 desktop profile 里增加一个只用于测试的 preset：

- `icl-loop` preset，`stateDir` 指向 `C:/DSH/icl/.state/loop/<runId>`（或固定 `loop-state`，每轮清空）。
- 与 `icl` 用同一套插件代码，但**没有用户记忆、人格、time/focus 状态**。
- `loop-probe` 只在该 preset 的 `plugins` 列表里。
- 需要在 profile 的 `presets/icl.patch.yml` 增加 `preset-icl-loop`；安装/重启一次，之后每轮只建会话。

如果暂时不想加 preset，退路是现有 `icl` preset + 运行前备份 `state/`、运行后恢复；但这会污染用户的 focus/time，不推荐作为默认。

## 4. 场景：先短后长

### S0 smoke（≤2 分钟）

- 建会话、收到 snapshot、一次 `time_status`/`world_status`、一次普通回复、正常 `turn/end`。
- 断言：31 个 ICL 工具、`agentPreset` 正确、system prompt 含人格/world、无工具错误、无 plugin-fail。

### S1 信息充分性（≤3 分钟）

- 先 `memo` 一条待办；再问“不调用工具，说出你现在知道的时间、待办、下一个安排”。
- 同时断言：
  - `system/message` 含 `时间：`、`待办：`、`dream:nightly`；
  - 助手回答包含同一时间/待办关键片段（rubric，允许措辞差异）；
  - 若缺少任一项，记录为“信息不足”，不靠模型自评。

### S2 时间稳定性（≤8 分钟）

- `arrange` 一条 +1 分钟的 wake；等待 `turn/end`，断言正文出现一次、`turn` 只多一轮。
- 再 `arrange` 一条同 id 的改期/重加，断言今天能再响（fired 清理）。
- `pause` 后注入一条普通消息，`resume` 后断言积压批次出现且只出现一次。

### S3 focus 可用性（≤5 分钟）

- 显式 `focus_enter(title='写测试', interruptible=false)`。
- `loop-probe` 注入 `qq` 普通消息两次（不同 focus / 同 focus），断言：
  - 不同 focus 不产生新 turn，只增加 backlog；
  - `focus_status` 能看到计数；
  - `focus_leave` 后出现一条摘要，且随后才出现积压内容。
- 统计进入/查看/离开用了几个工具调用（目标 ≤3）。

### S4 睡眠 + 做梦（≤8 分钟）

- `sleep`（测试时长 1 分钟）→ 断言 `phase=sleeping`，普通信号被拦截；
- `sleep-start` 触发 dream（或安排 `tags:['dream']` 到点）→ 断言 `dream-run` 行、至少一个 `event` 块或明确的 `no-notes`；
- `wake` → 断言积压释放；检查 dream 块的 evidence 是否带 `line`/`at`。

### S5 长跑（30 分钟，后台）

- 每 2–3 分钟一个“做事”prompt（刷 B 站 / 写文件 / 记一条），间插一次 focus 和一次 sleep+dream。
- 每步写 checkpoint；进程可以随时中断，重启后从 `checkpoint.json` 续跑。
- 报告只给**可量化**结论：轮次数、工具调用成功率、平均每轮上下文体积、focus 拦截次数、time 重复/漏发次数、dream 产出、错误清单。

## 5. 报告与“不好用但能优化”的判定

`report.md` 每项都要带证据行号/事件 seq，不写“感觉”：

- **信息充分性**：system prompt 是否含 required 片段；模型回答的关键词覆盖率；缺失项。
- **时间**：安排触发次数 / 期望次数；重复 id；漏发；暂停积压释放次数。
- **focus**：进入/查看/离开工具调用数；焦点期间被拦下的信号数；离开摘要是否出现；误投递数。
- **接缝**：工具错误、插件启用失败、投递失败、raw 行缺失、`dream` slot 未绑定。
- **摩擦点**：每轮工具调用数、上下文 token 估算、重试、空 turn、模型 reasoning 长度；标为 `optimizable`，不自动当失败。

## 6. 实施顺序

1. `tools/loop.mjs` + `session/follow` 事件采集 + `run.json`/`report.md`（S0）。
2. `icl-loop` preset + `loop-probe`（S2/S3）。
3. S1/S4 断言与报告。
4. S5 长跑与 checkpoint/续跑。
5. 跑一次 5 分钟 S0–S4，再跑 30 分钟 S5；把暴露的问题按“接缝/设计/提示词”分类修。

## 7. 需要先决定的一件事

默认用**独立 `icl-loop` preset**（推荐，不污染用户状态），代价是 profile 多一个 preset、需要重启一次；另一个选择是现有 `icl` preset + 运行前备份/运行后恢复 `state/`，不用改 profile，但风险高。

在确认这一点后，再写 driver；不要先跑 30 分钟，先用 S0–S4 把接缝暴露出来。

## 8. 首轮结果（2026-11-04）

`tools/loop.mjs` 已能：

- 建 `icl-loop` 会话，`session/follow` 落 `events.jsonl`；
- 等 `turn/end`，从 `system/message` 抽上下文、从 `tool/call`/`tool/result` 抽工具；
- 写 `report.md`/`verdict.json`，进程正常退出（不再被 WebSocket 挂住）；
- time 走 `time.inbox`，focus 走 `loop-probe` 文件邮箱。

首轮先暴露了配置层接缝：`icl-loop` preset 错配 `sessionId: loop`，而 `dsh-icl` 用真实 DSH session id 做 `isOurSession` 过滤，于是插件从未绑定 agent。工具和提示词是 host 级，仍然可见，所以 S0/S3 通过；但 `state.agent` 为空，S1/S2 的投递全部跳过。这解释了“为什么看起来一切正常，但真实会话里消息不进来”。

修掉后又暴露第二层：`loop-probe` / `time` 的文件邮箱在进程启动时从 offset 0 重放历史命令，旧信号进入 delivery 队列，新会话收到重复的“别处消息”“闭环待办”。现在 loop-probe 启动时跳过历史，driver 每轮先发 `reset`（清 delivery/focus/time/memory），bridge 解绑时清 delivery；workspace 也固定为 `.state/loop/workspace`，不再每轮新建（旧 run 留下的 7 个空 workspace 已清掉）。

这不是 driver 的假阳性，而是旧项目“真实会话里总有些东西不工作”的典型来源。

**运行约束**：ICL 是单会话锁；`icl-loop` 每个 app 进程只应建一条会话。driver 默认不 archive，避免“归档不释放 claim”的坑；连续场景请用同一会话（`--session <id>`）或一条 combined scenario，不要每步新建会话。需要全新状态时重启 DSH，不要试图在插件运行中删 `loop-state`（memory.db 被打开，EPERM）。

## 9. 模型反应：只记录，不当作证据

闭环会保留 assistant 的原文与 reasoning，但**断言不能建立在模型的自述上**。例如模型说“收到一条 QQ 消息”可能来自：

- 真实的 `loop-probe` 投递（`loop.outbox.jsonl` 有回执）；
- 重复投递（同一 user/message 文本出现多次）；
- 上下文里的旧消息；
- 模型自己把两条相似消息合并/改写。

所以报告里的每条“模型说 X”必须能追到 `events.jsonl` 的 `user/message` / `tool/result` / `signal` 回执；追不到就标为 `model-claim-unverified`，不算通过。测试会话的模型反应只用于发现“她理解成什么”，不用于证明投递正确。

首轮观察到的真实反应：

- 外部直投被模型当成“用户发来的测试消息”，这是 DSH 的 user 角色表现，不是投递错误；
- focus 离开摘要到达后，模型去查 `world_status`/`focus_backlog`，发现 qq 没有内容——因为积压已经在摘要里取走，这个解释是对的；
- 唤醒后模型想关掉 memo，但 `memos` 只显示正文、不显示 id，它只能猜 `memo_commit(id=1)`。已修：`memos` 现在输出 `#<id>`；
- 复用同一会话跑 dream 时，bridge 内存里的旧 raw 仍会被 wash 读到（即使文件被截断）。已加 `icl.resetRaw`，由 `loop-probe reset` 调用，清空内存 raw + 文件。

**测试消息是占位符**：当前 `loop-probe`/scenario 注入的是“外部直投测试”“别处来的一条消息”这类一句话，目的只是验证投递与 gate，不是产品文案。它会让模型反应显得很“测试腔”，不能用来评价人格或真实信息呈现；等闭环稳定后，再单独做消息注入的文案/来源/时间/上下文设计。

**单会话锁**：`icl-loop` 可能在 app 启动时恢复上一条会话并占锁；driver 在新建前写 `control.json`，plugin 只对 `presetId=icl-loop` 挂控制面，收到 `release` 才释放 claim/解绑 bridge。非 loop preset 没有这个后门。

## 10. 为什么之前一直在重启：内层方法错了

把 desktop 当内层开发回路，是本轮最大的时间浪费：

- DSH 服务端插件没有热重载；改一行 `bridge/plugin/loop-probe` 就必须重启整个 desktop。
- 每次重启换模块代际，旧会话/旧 delivery/旧 raw/旧 inbox 又混进来；于是把“测试脚手架残留”误判成产品 bug。
- 单会话锁 + 没有公开的 session dispose API，使“每场景新建会话”本身不可行。
- 状态分散在 delivery、raw 内存、raw 文件、time/focus、memory DB、inbox offset 六层；逐层 reset 是穷举，不是设计。

现在改为两层：

1. **`tools/loop-host.mjs`（内层，秒级）**  
   `createHost` + 真实插件 + 虚拟时钟，直接测 world/prompt、外部投递、focus backlog、time wake、sleep/backlog、dream 触发。
2. **desktop combined short（外层，最终确认）**  
   一批改动完成后只重启一次，跑一条 combined scenario；不在 desktop 上逐层 reset、反复建会话。

首轮 host loop **8/8** 通过，并立刻抓到一个真 bug：`normalizeSchedule` 的 `in`/`now` 用了 `Date.now()`，不跟随传入时钟；虚拟时钟下 wake 不会响。已改为接收 `now`，补了 `time.test`。

`--long` 用虚拟时钟跑 30 分钟：**11/11** 通过（9 条外部消息、focus backlog、睡眠积压醒来释放）。

**结论**：不是“bug 太多只能穷举”，而是内层回路选错了。Host loop 才是自动迭代的地方，desktop 只用于最终验收。
