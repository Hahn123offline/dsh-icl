# Time 心跳 v2（全局兜底唤醒）

状态：已实现（2026-11-07）。设计由用户拍板；人格层偏好留待后续，仿真与工具先确定性落地。

## 1. 为什么不再用"时间间隔"

模型不应该把精力花在算"下次几点醒"上。Time 只给模型一个**活跃度频率** `frequency`，后台把它映射成**随机唤醒节奏**，并在工具结果/状态里给出人话预估。模型只要知道自己大概想多活跃。

## 2. 频率 → 随机间隔

- 基线：`f=1` 时，每次间隔在 **10–20 分钟**之间均匀随机（不是固定 15 分钟）
- 实际间隔：`uniform(10m, 20m) / f`
- 示例：
  - `f=1` → 约 10–20 分钟
  - `f=0.5` → 约 20–40 分钟
  - `f=0.2` → 约 50–100 分钟（默认）
  - `f=0.05` → 约 3.3–6.7 小时
- clamp：`f ∈ [0.01, 1]`；**不能关到 0**，兜底永远存在，只能把间隔拉长
- 默认：`0.2`

## 3. 何时心跳

- 只在**没有新回合**时计时：`turn-end` 后开始，下一次 `turn-start` 取消并重排
- 有回合正在跑：绝不触发
- 会话有外部消息/新回合：心跳自然被取消；本轮结束后重新计时
- 心跳触发后：发一条唤醒消息；本轮结束后再排下一次

## 4. 谁能让心跳暂停

**通用规则：Time 内的长日程/目标自己暂停心跳；wake 型安排不暂停。**

- 任意 active `span`（含 `sleep:true` 的睡眠 span）→ 暂停
- active `goal` → 暂停
- 最后一个 span/goal 结束/取消 → 恢复
- `time_pause`（phase=paused）→ 暂停；`time_resume` 恢复
- `time_mute`（对外静音）→ **不暂停心跳**（心跳是自己的活动，不是外部消息）
- 普通 wake 安排（单发/每天/每周/随机）→ 不暂停心跳

因此 sleep 不需要单独判断，它就是 span 型 wake；这是通用解。

## 5. 心跳消息

心跳不是空唤醒：消息里直接带 `time_status` 的当前状态，省一次工具调用：

```
【心跳】2026-11-07 15:30 没有新回合；当前情况：
现在：…
状态：…
心跳：…
下一个安排：…
积压 3 条（qq 2、…）
积压预览：
- qq：主人：在吗
```

- 积压（如静音期间的消息）会带前 3 条预览，模型醒来即可看到
- 消息是**通知，不是任务**；Simulation 只客观描述醒来后"可以"做什么，不规定必须做什么
- 人格层以后写"她喜欢怎么活跃"；Simulation 写"环境怎么运作"；工具描述写参数/边界

## 6. 工具入口（扩展现有工具）

`time_arrange`：

```json
{ "mode": "heartbeat", "frequency": 0.2 }
```

- 只改全局心跳频率；不需要 at/in
- 返回人话预估，例如："心跳活跃度设为 0.2：约每 50 分钟–1 小时 40 分钟随机醒一次"
- `time_status` 显示：`心跳：活跃度 0.2（约 … 随机醒一次）；预计 … 醒 / 暂停（…）`

## 7. 实现位置与测试

- `packages/plugins/time/src/index.mjs`
  - 配置：`heartbeat.{baseMinSec,baseMaxSec,frequency,minFrequency,maxFrequency}`
  - 状态：`heartbeatFrequency/heartbeatDueAt/heartbeatLastAt/heartbeatStats`
  - 定时：tick 内 `maybeHeartbeat`；turn-end `armHeartbeat`；turn-start `clearHeartbeat`
  - 暂停：`heartbeatSuppressed()`（phase、spans、goals）
- `packages/core/test/time-lock.test.mjs`：心跳触发、span 暂停/恢复、goal 暂停、frequency clamp、静音积压预览
- `prompts/sim.md` `## 时间、安排与心跳`：客观契约（不含人格偏好）

## 8. 未做 / 后续

- 人格层"她喜欢怎么活跃"（用户后续研究）
- GUI 时间视图（当前先 statusText；后续可共用结构化 status）
- 随机间隔是否要可复现 seed（测试用固定 base 覆盖，生产用 `Math.random`）
- 心跳历史/频率调整的长期观测（可作为质量数据）
