# 向会话注入消息的通道

> 结论先说：**插件产生的结构化消息应走 `agent.steer` + `plugin:<producer>` source；不要伪造 user 消息。**  
> 真正的用户消息、插件通知、上下文快照是三条不同的通道。

## 1. 三类通道

| 通道 | 形态 | 何时用 | 会不会起一轮 |
|---|---|---|---|
| `agent.followup(message)` / `sessionController.prompt` | `role:'user'`，通常 `source.kind:'user'` | **真正的用户发言** | 会，成为独立普通回合 |
| `agent.steer(message)` | `role:'user'` 形状，但 `source.kind:'plugin:<producer>'`、`form:'notice'` | **插件事件/看门狗/外部消息** | 空闲时起一轮；运行中在下一个 step 边界注入 |
| `agent/pre-step` 返回 `runtime-context` 消息 | `source.kind:'runtime-context'`、`form:'snapshot'` | **每轮上下文/记忆/状态** | 不单独起一轮，随当前轮注入 |

另外：

- 系统提示词段（`ctx.systemPrompt.section`）是常驻说明，不是事件；
- 工具结果是模型动作的返回，不是跨插件消息；
- 不要用工具结果偷偷塞“用户说……”的文本。

## 2. 为什么 steer 是插件消息的正路

DSH 文档语义：

> Submit steering for the nearest step. **An idle driver starts a turn**; a running driver consumes it at its next step boundary.

这正好覆盖插件消息的两种场景：

- agent 空闲：事件把会话叫醒；
- agent 运行中：事件在下一步插话，不打断当前工具调用。

而 `agent.followup` 的语义是 **ordinary follow-up turn**，最终会变成“用户发来的消息”；`sessionController.prompt` 的 source 更是写死 `user`。用它们送插件事件，模型会把“系统通知/QQ/MC/时间”误当成“用户对我说话”。

## 3. source 规范

DSH v4 会拒绝裸露的 `kind:'plugin'`。规范形状：

```js
source: {
  kind: 'plugin:<producer>',   // 例：plugin:time / plugin:mc / plugin:qq / plugin:dsh-icl
  form: 'notice',
  summary: 'MC：任务完成 t-3',  // 折叠行，一两句话
}
```

- `kind` 必须是 producer-owned，例如 `plugin:dsh-icl`；
- `summary` 是给 GUI/折叠行的一句话，不要塞长文；
- 正文放 `content:[{type:'text',text}]`；
- 不要把所有插件都伪装成 `plugin:dsh-icl`，否则追溯不到来源。

## 4. ICL 当前规则

`packages/dsh-icl/src/bridge.mjs` 的 delivery tick：

- 从 `batch.entries[0].source.plugin` 取来源；
- 构造 `toDshUserMessage(text, { source: { kind:'plugin:<plugin>', form:'notice', summary } })`；
- 优先 `agent.steer(message)`；
- 老宿主没有 `steer` 才退 `agent.followup(message)`，并计入 `stats.followupFallback`；
- 统计 `steered` / `followupFallback`，便于发现退路。

所以：

- 时间 wake → `plugin:time` notice；
- focus backlog 摘要 → `plugin:focus` notice；
- MC 任务/聊天 → `plugin:mc` notice；
- loop-probe / QQ 外部信号 → 其 `from.plugin` notice；
- 真正的 GUI 用户消息 → 仍走 DSH 用户通道，不经过 ICL delivery。

## 5. 约束

1. 插件不得伪造 `source.kind:'user'`；
2. 插件事件不得走 `sessionController.prompt`；
3. 上下文快照不得用 notice 冒充“用户刚说”；
4. 每条 notice 的 `summary` 要能追溯来源；
5. 同一批消息保留 source，不合并成匿名文本；
6. steer 失败要记原因并重试/nack，不能静默丢。

## 6. 与 MC 看门狗的关系

`dsh-mc-agent` 的 `watchdog.mjs` 早就踩过这条路：

- 首选 `agent.steer(plugin notice)`；
- 兜底才 `sessionController.prompt`，并明确它是 user source、会在对话里冒充用户；
- `user-message.mjs` 用 producer-owned `plugin:dsh-mc-agent`；
- 唤醒矩阵、限流、事件留档都围绕这条通道。

ICL 现在采用同一原则；MC body 的事件通过 `mc-link` → `signals` → delivery → `steer`，不再以 user 消息进入。

## 7. 已验证

`icl-mc` 短会话（56356）里，`mcb_task` 完成 body 任务后，事件进入 DSH 是：

```text
user/message  source.kind = plugin:mc
[MC] task_queued
[MC] task_started
[MC] 任务完成：mine t-1
```

也就是说：**消息形状是 user/message（DSH 的传递形状），但 source 是 plugin:mc**，由 steer 作为插件 notice 注入，不是 `source.kind='user'` 的真人发言。模型侧应据此把它当环境事件，而不是“用户刚说”。
