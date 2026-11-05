# MC 接缝契约 v1（身体 / 头脑分层）

> 目的：MC 是一个**成熟的域插件**，不是 ICL 里的临时脚本。ICL 只通过稳定契约下抽象任务，不碰 mineflayer，也不改第三方 `dsh-mc-agent`。

## 1. 先纠正一个误解

不是“ICL 最小只读、只下抽象任务”。

而是：

- **ICL 层**：一个 brain，负责目标、外部消息、注意力、任务选择；
- **MC body 层**：完整成熟的身体插件，负责 mineflayer、寻路、任务执行、反射、重连、安全；
- 两层之间是**版本化契约**，不是“先做最小脚手架，以后再拆”。

分的是**职责**，不是成熟度。MC body 本身要按成熟插件做：生命周期、任务状态机、错误、重连、权限、可观测性、测试都要有。

### 硬不变量（防止“两个脑”）

1. **只有一个决策者**：ICL 的模型。身体没有模型、没有目标生成器；它只执行任务、做非语言安全反射。
2. **只有一个发言者**：ICL。身体默认不能说话；只有 `mcb_say`（ICL 下发的工具）或 ICL 下发的 `chat` 任务能让它开口。身体不能自己评论、汇报、聊天。
3. **任务有 ID**：ICL 每次下任务拿到 `taskId`；完成/失败/中断 signal 必须带同一个 ID。她说的“我在挖/挖完了/卡住了”必须能追到 taskId 和 body 事件。
4. **状态以 body 为事实源**：位置、血量、背包、任务状态由 body 返回；ICL 的叙述不能覆盖它。prompt 每轮带 world/status，失败后先看状态再说话。
5. **本地模型是同一个决策者的替代后端**，不是第二个 brain。它只替换 ICL 的模型路由；不能同时跑一个“body 本地模型”再和 ICL 对话。
6. **身体不自主生成新目标**：队列里的任务只能来自 ICL；安全反射只会停止/中断，不会自己开始新目标。

这六条是“言行一致”的硬约束，不是提示词建议。

## 2. 角色与边界

```text
ICL 主会话（packages/plugins/mc-link）
   │  mc-body/v1 JSON over 127.0.0.1
   ▼
MC body（packages/mc-body，独立进程）
   │  mineflayer
   ▼
Minecraft 私服 / 局域网
```

- `mc-body` **不 import ICL**；
- `mc-link` **不 import mineflayer**，只懂契约；
- `dsh-mc-agent` 是第三方：不修改、不复制、不深度嵌入；可作为独立 actor 或参考实现，通过契约/进程边界接。
- body 崩了，ICL 还能处理外部消息；ICL 崩了，body 继续执行当前任务或安全停止。

## 3. 传输

- HTTP/JSON，仅 `127.0.0.1`；
- 版本前缀 `/v1`；
- 事件用游标轮询（`since`），后续可加 SSE；不依赖 WebSocket 才能工作；
- 所有请求带 `requestId`，任务创建带 `idempotencyKey`；
- 时间戳用 Unix ms，另带 `serverTime` 便于诊断漂移。

## 4. 状态快照

`GET /v1/status`：

```json
{
  "ok": true,
  "version": "mc-body/v1",
  "connected": true,
  "server": { "host": "127.0.0.1", "port": 54835, "version": "26.1" },
  "self": { "username": "ICL", "health": 20, "food": 20, "position": {"x":1,"y":64,"z":1}, "dimension": "overworld" },
  "players": ["Hahn123_", "ICL"],
  "task": { "id": "t-1", "kind": "mine", "state": "running", "progress": {"done": 3, "total": 16}, "startedAt": 0 },
  "queue": [],
  "eventsSeq": 42,
  "safety": { "paused": false, "reason": null }
}
```

## 5. 任务

### 创建

`POST /v1/tasks`

```json
{
  "idempotencyKey": "uuid",
  "kind": "mine",
  "params": { "block": "oak_log", "count": 16, "radius": 24 },
  "deadlineMs": 600000
}
```

返回：

```json
{ "ok": true, "task": { "id": "t-1", "kind": "mine", "state": "queued" } }
```

**立即返回**，不阻塞请求；执行通过事件和 `GET /v1/tasks/:id` 追踪。

### v1 任务类型

| kind | 参数 | 成功条件 |
|---|---|---|
| `mine` | `block`, `count`, `radius` | 背包中该物品净增 ≥ count；`no-target` / `no-effect` / `no-path` / `dig-failed` 记 `failed`（带 reason，不伪装成功） |
| `goto` | `x`,`y`,`z`,`range` | 到达 range 内 |
| `patrol` | `points[]` 或 `radius` | 走完点/时间，未卡死 |
| `explore` | `radius`,`durationMs` | 探索时间到，位置有变化 |
| `follow` | `player`,`range` | 跟随到超时/取消 |
| `chat` | `text` | 已发送（受限） |\n| `routine` | `blocks`,`targetCount`,`durationMs`,`radius` | 持续采集/生存，带 collected/trips/eaten |

v1 不开放：任意命令、OP、PvP、大范围破坏、公共服务器。

### 状态机

`queued → running → done | failed | cancelled | interrupted | paused | unknown`

- `done`：目标真的达成（背包净增 / 到达 / 时限内正常结束）；
- `failed`：明确失败（no-target / no-effect / no-path / dig-failed / timeout），带 reason；
- `interrupted`：被安全停止/取消/外部事件打断，保留原因与进度；
- `paused`：断线/会话断开导致暂停；重连后**不自动续跑**，要显式 resume；
- `unknown`：超时或断线时结果不可知（可能已生效），不能当失败也不能当成功，先复核；
- 同一 body 同时最多 1 个 running，其余 queued；
- `cancel` 必须让 mineflayer 停止当前动作（停止寻路/挖掘/控制状态）；
- 同一 `idempotencyKey` 重复提交返回原 task，不重复执行。

### 查询/取消/恢复

- `GET /v1/tasks/:id`
- `GET /v1/tasks?state=running`
- `POST /v1/tasks/:id/cancel`
- `POST /v1/tasks/:id/resume`（只用于 `paused`；断线重连后由 ICL 显式决定要不要继续）

## 6. 事件

`GET /v1/events?since=42`

```json
{
  "ok": true,
  "events": [
    { "seq": 43, "at": 0, "type": "chat", "data": { "username": "Hahn123_", "message": "在吗" } },
    { "seq": 44, "at": 0, "type": "task_progress", "data": { "taskId": "t-1", "done": 4, "total": 16 } },
    { "seq": 45, "at": 0, "type": "task_done", "data": { "taskId": "t-1", "result": { "mined": 16 } } },
    { "seq": 46, "at": 0, "type": "safety_stop", "data": { "reason": "low-health", "health": 5 } }
  ]
}
```

事件类型：

- `chat` / `join` / `leave` / `death`
- `task_queued` / `task_started` / `task_progress` / `task_done` / `task_failed` / `task_paused` / `task_unknown` / `task_cancelled` / `task_interrupted`
- `stuck` / `disconnected` / `reconnected` / `reconnect_exhausted` / `safety_stop`
- `body_error`（mineflayer 异常，带可读原因）

事件只追加，有 seq；body 启动时 ICL 不重放旧历史（`since=latest`），恢复会话时显式 replay。

## 7. 安全

默认：

- 只连私服/局域网；
- 无 OP、无 `/command`、无 `allowAllCommands`；
- 任务白名单；
- 低血（≤6）立即暂停当前任务并 `safety_stop`；
- 死亡/断线/卡死（N 秒无位置变化）暂停；
- `chat` 限速（1 秒 1 条、≤200 字），拒绝 `/`；
- 任务 deadline；
- kill switch：`POST /v1/safety/stop` 立即停止所有动作，任务置 `interrupted`。

## 8. ICL 侧映射

`packages/plugins/mc-link`（v1）：

| ICL 工具 | body 调用 |
|---|---|
| `mcb_status` | `GET /v1/status` |
| `mcb_task` | `POST /v1/tasks` |
| `mcb_cancel` | `POST /v1/tasks/:id/cancel` |
| `mcb_events` | `GET /v1/events?since=` |
| `mcb_say` | `POST /v1/chat` |

信号：

- `chat` → `kind:'content'`, `focus:'mc'`
- `task_done/failed/interrupted` → `kind:'event'`
- `safety_stop` → `kind:'event'`, tags `['alarm']`（可穿透 focus）
- `join/leave/death` → `kind:'event'`

world source：

- 一行连接/位置/生命；
- 一行当前任务/进度；
- 一行在线玩家。

外部消息仍走 ICL 的 focus/time；MC 任务不阻塞外部消息。

## 9. 成熟插件的验收

body 独立测试：

- 契约测试：假 mineflayer，任务状态机、幂等、取消、超时、事件 seq；
- 真实私服：mine/goto/patrol 各 1 次，低血/死亡/断线/卡死注入；
- 30 分钟无人值守：任务队列、重连、安全停止、无卡死；
- 日志/指标：任务耗时、失败原因、位置变化、事件延迟。

ICL 集成测试：

- 假 body 契约测试（不连 MC）；
- 真实 body 短会话；
- 本地模型主脑（文本优先，vision 后加）；
- 外部消息与任务并发。

## 10. 非目标

- 不把 40 个 `mc_*` 工具暴露给 ICL；
- 不把 mineflayer 放进 ICL 进程；
- 不修改 `dsh-mc-agent`；
- 不在公开服务器/大群做第一次运行；
- 不先做“最小 mine N 然后拆掉”的临时工具面。

### 工具与装备（v1.1，2026-11-06 用户要求）

- **装备归模型管**：`mcb_inventory` 返回手持、9 格快捷栏（当前选中槽）、每件物品的 `toolFor`（pickaxe/axe/shovel/shears）、工具等级与耐久；`mcb_do` 的 `equip {item}` / `equip {slot:1-9}` 由模型自由换装备。
- **动作前置判定**：`mine`/`dig` 开始前检查方块所需工具与手持；手持不合适但背包有更合适 → body **自动换上**并在 `progress`/结果标 `autoTool:true`（事件 `auto_tool`）；**没有可用工具/等级不够 → 立即 `failed`**，`task.result` 带 `needsTool`/`suggestCraft` 与可执行步骤，禁止原地重试。`autoTool:false` 可让模型完全自己决定。
- **脚本兜底仅限自动反应**：战斗/低血/危险/掉落时 body 自动切武器/食物（emergency）；普通挖掘/采集不替模型做目标决策。
- `mcb_do` 单步长动作（mine/goto/explore）建议改用 `{"op":"task"}` 提交（body 有台账/事件/取消，且不阻塞请求）。

### 设计转向：装备归模型，脚本只兜底自动反应（2026-11-06 用户要求，v1.1）

- **可见/可控**：`mcb_inventory` 必须给手持、9 格快捷栏（★=当前选中）、`toolFor`（pickaxe/axe/shovel/shears）、等级与耐久；`equip {item}` / `equip {slot:1-9}` 由模型自由使用。
- **动作前置判定**：mine/dig 前检查方块所需工具；手持不合适但背包有更合适 → 自动换上（`autoTool:true` 事件/结果标注）；**没有/等级不足 → 立即 failed，result 带 needsTool/suggestCraft/held/block/requiredTier 与可执行步骤，禁止原地重试**（真服回归：空手/dirt 挖 stone → 立即失败 + “先 craft wooden_pickaxe…”）。
- **兜底边界**：只有战斗/低血/危险/掉落等自动反应由 body 切武器/食物；普通采集不替模型做目标决策。`autoTool:false` 可让模型完全自管。
- 真服证据：night-1 deploy 后 seq 390/391（inventory 新格式）、370/372（mine 用已有镐成功、net 10）；空手拦截图见 `.state/lab/mc-body-soak/tool-smoke2/`。
