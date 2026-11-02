# 消息模型：我们到底在用什么传信号

> 2026-11-03。回答"白名单条件之前，先搞清消息是什么"。
> 结论：现在有 **七条并行通道**，它们共享的只有"一段文本"，其余元数据各写各的。

## 1. 现状盘点

| 通道 | 形状 | 方向 | 排序 | 去重 | 谁读 |
|---|---|---|---|---|---|
| `delivery.push` | `{to, channel, source:{plugin,activity,seq}, content:{text,images}, batchKey, exactlyOnce}` | 插件 → 会话 | 队列顺序 + `nextAt` 退避 | 按 `plugin\|activity` 水位 | session 适配器 `drain` |
| `prompt.section` | `{name, order, text}` | 插件 → 模型（每轮） | `order` 升序 | 无 | `prompt.assemble` |
| `prompt.onTurn` / `turnText` | `({message}) => text` | 插件 → 模型（仅当轮） | 注册顺序 | 无 | 每轮装配 |
| `context.onAssemble` | `{name, order, apply}` | 插件 → 模型（每轮） | `order` | 无 | 上下文装配 |
| `world-state` | `{id, owner, title, order, cap, items(): [{key, brief, detail}]}` | 插件 → 模型（brief）/ 工具（detail） | `order` | 无 | `renderBrief` / `world_status` |
| `slots` provider | `{id, kind, shape, call({messages, maxTokens})}` | 插件 → 模型（调用） | — | — | 绑定者 |
| `raw` | `{id, search(), list()}` → `{text, time, sender, ...}` | 插件 → 检索 | — | — | `raw.search/list` |
| `focus` | `{label, owner, pierce, ttl}` | 插件 → 拦截规则 | `since` 最新 | — | `canPierce` |
| 工具 | `{name, description, parameters, execute}` | 插件 → 模型（可调用） | 注册表 | — | `tools` |

## 2. 共同点与差异

**共同点**：核心都是"一段文本 + 一点元数据"。

**差异**：

- 只有 `delivery` 有 **来源、顺序号、恰好一次**；其它通道没有身份，也没有去重
- 只有 `prompt`/`context`/`world` 有 **order**；`delivery` 是队列顺序
- **没有一条通道有"类型"**：`wake`、`goal`、`notice`、普通内容，现在都只能靠文本自己表达
- **没有一条通道有约束/白名单**：拦截只发生在 `focus`，而且只认标签
- **没有优先级、没有 TTL**：积压永远积压，除非手工清
- `to` 只有 `'session'` 一个值；`channel` 只有 `'conversation'`

## 3. 这意味着什么

时间模块要做的"纵向拦截 + 白名单 + 队列 + TTL + 类型"，**在现有任何通道上都没有对应物**。

如果直接往 `delivery` 上加字段，会把"投递"变成"信号总线"，影响所有现有使用者；
如果每条通道各自加一套，又会出现七套语义。

## 4. 建议：一个信号信封（Signal），三条路由

```
Signal {
  id, from, kind, text,        // kind: wake | goal | notice | content | event
  focus, constraints, ttl,     // 约束与生命周期
  priority, createdAt, once,   // 队列行为
  meta                          // 通道私有字段
}
```

三条路由，语义不同：

| 路由 | 去哪 | 谁判定 | 现有对应物 |
|---|---|---|---|
| `toModel` | 会话/模型 | 时间模块（纵向）+ focus（横向） | `delivery` |
| `toPlugin` | 插件事件总线 | 订阅者自己 | 目前**没有**统一事件总线 |
| `toFocus` | 进入/离开注意力空间 | focus 服务 | `focus.enter/release` |

关键取舍：**先把 `toModel` 收敛到 Signal**，`toPlugin`/`toFocus` 先维持现状，等时间模块跑起来再统一。否则一次改七个通道，风险大于收益。

## 5. 与 DSH goal 的对照

DSH 的 goal（本会话可用的 `create_goal`/`update_goal`）：

- 目标持久化，跨回合继续
- 模型停下时，系统以"继续当前目标"的消息把它拉回来
- 人要求继续/恢复时才重新武装；`complete`/`blocked` 由模型判定

我们要做的 goal 是它的 **时间联动版**：

- 带 `until`（10 分钟后 / 23:00）
- 可按日程创建（每周日 10:00 起，2 小时）
- 卸载即释放绑定的 focus
- resume 消息由时间模块发出（"你在目标内，若退出请卸载目标"）

## 6. 待确认的问题

1. **Signal 的落地范围**：只做 `toModel`（delivery 升级），还是同时新建 `toPlugin` 事件总线？
2. **谁有权发 Signal**：所有插件都可以 `time.offer()`，还是只有白名单插件可以？
3. **`kind` 的取值**：`wake/goal/notice/content/event` 够吗？要不要允许插件自定义 kind？
4. **约束的表达**：`{from, keyword[], level}` 还是直接复用 focus 的 `pierce` glob？
5. **TTL 默认值**：积压消息多久算过期？（比如 1 小时）
6. **顺序**：同一来源保序即可，还是需要全局顺序（`priority` + `createdAt`）？
7. **插件间事件**：现在没有事件总线，插件之间靠 `services.provide/get` 直接调用；要不要借这次统一？
