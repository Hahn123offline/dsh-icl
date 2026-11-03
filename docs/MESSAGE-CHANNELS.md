# 往会话里发消息的方式（DSH 实测）

> 结论：DSH 只有两种"发消息"的模式——排队和插话；其余是队列编辑与会话结构操作。

## 1. 排队（queue）——默认

```js
api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text }] })
```

- 不打断当前生成
- 当前这一轮结束后，作为**下一轮**进入
- 适合：叫起床、到点提醒、例行通知

## 2. 插话（steer）

```js
api.sessions.prompt({ sessionId, mode: 'steer', content: [{ type: 'text', text }] })
```

- 在生成过程中插进去，模型下一步就能看到
- 会改变当前这一轮的走向
- 适合：真正的紧急情况（着火了、马上要断电）

## 3. 编辑/删除排队中的消息

```js
api.sessions.updateQueue({ sessionId, itemId, action: { kind: 'edit' | 'remove', ... } })
```

- 只能改已经在队列里的消息
- 适合：计划变了，把还没送出的提醒撤掉

## 4. 会话结构操作（不是发消息）

| 方法 | 作用 |
|---|---|
| `workspace/insertBefore` | 在时间线里插入一条记录（UI 可见） |
| `session/fork` | 从某个点分叉出新会话 |
| `session/cancel` | 取消当前工作 |

## 我们怎么用

```
投递泵：普通消息 → queue
        batch.urgent → steer
```

核心的信号层可以给消息打"紧急"，投递泵据此选模式。

## 没有的东西

- 没有"往系统提示里插一条"的公开 API
- 没有"静默通知"（不进对话历史）的通道
- 想让模型知道某件事，只能作为消息进入对话

## 待做

- 睡觉期间的消息应该**先排队**，醒来一起给（现在是逐条 queue，顺序没保证）
- 闹钟/提醒类消息可以进一次 `updateQueue` 做去重


## 补充：真正的"进回合内部"通道（已查到底）

### 进程内（插件）

DSH 的 agent 有一个 inbox，分两个位置：

```
next-turn   下一轮才处理（就是 queue）
next-step   当前这一步就能看到（steer 走这里）
```

`placement` 由来源决定：

| 来源 | placement | GUI |
|---|---|---|
| 用户消息（steer） | `steering` | 显示为"插话"，不是普通消息 |
| 非用户来源（系统/插件） | `context` | **不显示**，只进模型上下文 |

`agent.inbox.push(target, message)` 能插 `next-step`，这就是"GUI 看不到、模型收得到"的
真正通道——但它只在进程内可用，**HTTP API 没有对应方法**。

### HTTP

只有 `session/prompt` 的两种模式：

- `queue` → `agent.followup` → next-turn
- `steer` → `agent.steer` → next-step（placement `steering`）

`updateQueue` 可以把一条排队消息改成 `steer`（变成插话）。

### 重复消息的坑（老版本吃过的亏）

1. **快照重放**：`session/follow` 首帧带历史事件。如果按事件流重复消费，会把历史
   回合当成新回合再发一遍 → 必须按 `event.seq` 去重，快照只用来重建状态。
2. **queue + steer 双发**：同一条消息既排队又插话，模型会看到两次。
3. **重连重放**：断线重连后 follow 会重放未结束的回合，必须只补"有 start 没 end"的。
4. **ack 时机**：提示被接受后立即 ack；失败 nack，不能两边都留。

我们的实现：投递泵按 batch id ack/nack；turn-end 只按 seq 递增触发；goal 续推走 queue。
