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
