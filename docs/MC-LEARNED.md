# 从 dsh-mc-agent 学到的 MC 身体设计

不是移植代码，是抄它的**行为契约**和踩坑结论。第三方插件不修改、不嵌入。

## 1. 快慢脑是对的

- 慢脑：ICL 会话，决定目标、处理外部消息、说话；
- 快脑/身体：mineflayer + 反射 + 任务执行，不生成目标、不聊天。

这和 `dsh-mc-agent` 的“AI-led + 看门狗”是同一分工。差别是它的快脑更成熟：有危险检测、唤醒矩阵、限流、重连、任务 outcome。

## 2. 必须学的行为

### 2.1 看门狗不是“消息转发器”

`src/watchdog.mjs` 的关键不是 chat 事件，而是：

- **唤醒矩阵**：mention / nearbySpeech / anyChat / damage / death / disconnect / heartbeat / followUp；
- **限流**：`maxWakePerMinute`，且空闲叫醒与保命叫醒**分开配额**（踩坑档案第 4243 条：最危险时最安静）；
- **事件留档**：`log` / `stats`（fired/injected/dropped/suppressed），不是静默吞掉；
- **注入方式**：`agent.steer` 的 plugin-originated message，不是伪造 user 消息（`watchdog.mjs` 注释里明确）；
- **心跳**：`heartbeatSec`，长时间没事件也能推一下；
- **follow-up**：叫醒后对方没反应，超时提醒一次。

我们的 `mc-body` 现在只有任务事件 + 低血停止，缺看门狗矩阵、限流、心跳、suppressed 统计。

### 2.2 出生/危险是正常使用能力

`src/auto` / `danger` / 踩坑档案里反复出现：

- 低血、溺水、岩浆、火、窒息、苦力怕贴脸、卡住、死亡；
- 死亡不是“任务失败”这么简单：要保留死亡坐标、暂停任务、等重连/复活，不能盲跑；
- 出生点本身可能危险（我们实测直接死），body 必须先判“现在能不能活”，再谈任务。

### 2.3 断线/重连

`src/connection.mjs`：

- 自动重连有**上限和退避**，不是无限重试；
- 断线时把 running 任务标成 **paused（断线了）**，不是失败、不是继续 running；
- 重连成功不自动重跑，先让模型 `resume`/复核；
- 明确 `offline`/`reconnected` 事件，状态栏不能显示“在线”骗人；
- **不要用 force reconnect 解决方块失步**（踩坑档案第 100 条：模型会照文案学，反复退服）。

### 2.4 任务 outcome

`src/task-runner.mjs` 区分：

- 成功；
- 动作失败；
- **结果未知**（断线/超时，可能已经生效）；
- 取消/中断/暂停。

“结果未知”不能当失败，也不能当成功；要复核。我们目前只有 done/failed/cancelled/interrupted，缺 paused/unknown。

### 2.5 寻路不是简单步行

`mineflayer-pathfinder` 也有坑：

- `resetPath('stuck')` 只重算同一条路，不换策略；
- `bot.pathfinder.stop()` 要 `setGoal(null)` 才真停；
- 卡住判据要看“有没有靠近目标”，不是“有没有动”；
- 需要重试/脱困阶梯（repath → jump → backoff），并报告 `pathResets`；
- 1×2 隧道上台阶要挖头/挖脚，不能只靠 A*。

我们现在的 `goto` 是简单 forward，不能算成熟。

## 3. 我们的修改清单

1. **body watchdog**：健康/氧气/危险方块/卡住/死亡/断线/心跳；事件带优先级和 suppressed 统计。
2. **任务 outcome**：加 `paused` / `unknown`；断线暂停，重连后显式 resume。
3. **重连**：有界退避；不再让任务保持 running；offline/reconnected 事件。
4. **出生安全**：spawn 后先检查脚/头/下方/附近危险；不安全就暂停+报警，不接任务。
5. **看门狗限流**：idle 与 danger 分开配额；事件合并，避免 MC 聊天刷屏。
6. **注入语义**：MC 事件是 plugin-originated context，不是“用户对她说的话”；ICL 侧要能区分。
7. **pathfinder**：装依赖，采用 progress watcher + 脱困阶梯，不用简单 forward。
8. **本地模型**：只替换 ICL 的模型路由；body 无模型。本地模型弱时，用 taskId/result/claim audit 保证言行一致。

## 4. 不做什么

- 不 import/copy `dsh-mc-agent` 代码；
- 不把它的 40 个工具直接暴露给 ICL；
- 不在 ICL 进程里跑 mineflayer；
- 不让 body 自己生成目标或聊天。
