# MC 主会话方案：身体自动，头脑在 ICL

目标：**主 ICL 会话自己玩 MC，同时处理外部消息**，不依赖用户在游戏里发消息，也不把完整 MC agent 塞进同一会话。

## 1. 为什么不直接用完整 MC agent

`dsh-mc-agent` 是“另一个玩家 + 另一个看门狗 + 另一套记忆”。和 ICL 同会话会：

- 两个 brain 抢同一个角色；
- 两套“该不该叫醒”；
- 工具/提示词重复；
- 失败时无法归因。

它适合做**独立 actor**，不适合做主会话的身体。

## 2. 推荐结构：`mc-body` 进程 + `mc-body` 插件

```text
ICL 主会话（一个 brain）
  ├─ mc-body 插件：高层工具 + 事件 signal + world 状态
  └─ 外部消息（QQ/B站/loop-probe）→ signals → focus/time
        │
        ▼
mc-body 进程（无模型、无 token）
  ├─ 底层反射：吃、逃、卡住重试、停止
  ├─ 任务队列：mine / build / patrol / explore / follow
  └─ 真实事件：chat / damage / task progress / stuck / death
```

关键：**身体自己跑，模型只决定“下一件事做什么”**。这样：

- 不需要用户一直在 MC 里发消息；
- 任务运行期间模型可以处理外部消息；
- token 消耗只在“决策/总结”，不在每个 tick；
- 失败可以定位在 body（mineflayer/任务）或 mind（ICL/prompt）。

## 3. 插件工具面（不要 40 个）

只暴露少量高层工具，降低模型和小模型的理解负担：

| 工具 | 作用 |
|---|---|
| `mcb_status` | 位置、生命、饥饿、当前任务、队列、最近事件 |
| `mcb_task` | 开始一个任务：`mine` / `build` / `patrol` / `explore` / `follow`；返回 taskId，不阻塞 |
| `mcb_cancel` | 取消当前任务 |
| `mcb_say` | 纯文本、限速；可选 |
| `mcb_events` | 最近事件（chat/damage/stuck/completed） |

`mcb_task` 必须**立即返回**，不能等挖完；任务完成/失败通过 signal 通知。

## 4. 自主持续

- body 有**任务队列**和 idle 策略：当前任务完成 → 取下一条；队列空 → 待机/巡逻。
- 任务由 ICL 下，不由用户发；用户在不在游戏里都不影响。
- `time` 每 10–15 分钟发一次 `wake`（只在 idle 时），让主会话看看外部消息和任务状态；不是每 tick 叫。
- 外部消息走 focus/sleep；任务进行中默认 focus `mc`，外部消息进 backlog 或按优先级穿透。
- 安全反射在 body：低血/怪贴脸/卡住/掉线 → 暂停任务 + signal；模型决定继续/撤/换任务。

## 5. 本地模型

适合，但要定位清楚：

- **身体不需要模型**：mineflayer 任务跑 30 分钟不花 token。
- **本地模型只做 mind**：决定任务、读事件、回外部消息。
- 低性能模型会更快暴露：
  - 工具 schema 是否太长/太绕；
  - prompt 是否把“当前任务/外部消息”混在一起；
  - 事件是否太多、没有摘要；
  - 模型不调用工具时，系统是否还能靠 body 继续。
- 本地模型通常没有视觉：不要用 `mc_observe` 图片；先用 `mcb_status`/文本事件。
- 用 `model-manager` 配一个本地 OpenAI-compatible provider，单独 `icl-mc-local` preset；不要污染主会话。

本地模型跑不好 MC 不代表设计错；它跑不好**工具选择/事件处理**才是设计问题。

## 6. 分阶段

1. **body 单独跑 30 分钟**（无模型）：真实任务、卡住、低血、聊天事件；验证 body 不会把角色玩死/卡死。
2. **主会话 + 本地模型**：30 分钟，任务 + 外部消息注入；看工具调用、事件摘要、token、是否被 MC 拖死。
3. **主会话 + 生产模型**：短时间确认体验。
4. 再谈 QQ/B 站真实消息；不要在 MC 还没稳时接高流量。

## 7. 与现有 `mc-observer` 的关系

`mc-observer` 是只读最小探针，已经验证能连上 54835。`mc-body` 是它的下一步：保留 observer 的事件/状态，增加**有界的动作任务**。

低伤害约束继续：

- 只连局域网/私服；
- 无 OP、无命令；
- 任务白名单（mine/build/patrol/explore），不做破坏性大范围操作；
- 随时 `mcb_cancel` / kill switch；
- 失败只影响本地世界。
