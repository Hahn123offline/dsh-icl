# 消息模型 v2：Signal（统一信号）

> 2026-11-03 第三轮。按"统一、不留债"的要求收敛。
> 需要你审的是 §4 的约束语法、§5 的 TTL 语义、§7 的迁移顺序。

## 1. 一句话

**所有跨边界的"消息"统一成一个 Signal 信封；三种路由：给模型、给插件、给注意力空间。**
提示词片段（prompt.section 等）**不是消息**，它们是装配材料，不进总线。

## 2. Signal

```js
{
  id: 's-123',
  from: { plugin: 'qq', activity: 'group:123' },   // 谁发的，必填
  kind: 'wake' | 'goal' | 'notice' | 'content' | 'event',
  text: '群里有人 @ 你',                            // 正文
  to: 'model' | 'plugin' | 'focus',                // 路由
  focus: 'qq:group:123',                            // 期望进入的注意力空间（可空）
  tags: ['direct', 'sleep'],                        // 路由/白名单用的标签
  createdAt: 1793...,
  expiresAt: null,                                  // 默认不过期；见 §5
  meta: {}                                          // 通道私有字段
}
```

规则：

- `kind` 是**固定枚举**，由 API/系统给出，**模型不能自己写**（模型只写正文和安排）
- `from` 必填，不允许匿名信号
- 顺序：**同一来源保序**；跨来源按 `createdAt` 先进先出；**不引入优先级**
- 幂等：`id` 由发送方生成，重复 `id` 丢弃

## 3. 三种路由

| 路由 | 谁消费 | 拦截 | 现有对应物 |
|---|---|---|---|
| `to: 'model'` | 会话 | 时间（纵向）→ focus（横向） | `delivery.push` |
| `to: 'plugin'` | 订阅了 `kind/from/tags` 的插件 | 订阅者自己 | **新建事件总线** |
| `to: 'focus'` | focus 服务 | 入/出规则 | `focus.enter/release` |

- `to:'model'` **只能由时间模块放行**；其它插件一律 `time.offer(signal)`
- `to:'plugin'` 是**事件**，不排队、不持久化、失败只记日志（`ctx.events.emit` / `ctx.events.on(filter, fn)`）
- `to:'focus'` 不是消息流，是请求：`focus.request(signal)` → 时间模块决定是否允许入座

## 4. 约束与白名单（我的方案，待审）

**不复用 focus 的 pierce**。时间模块用一张**声明式白名单**，只有"拦住"和"放行"：

```js
// 挂在阶段/日程上
allow: [
  { from: 'admin' },                              // 这个人/来源一律放行
  { from: 'qq', any: ['醒醒', '着火了'] },          // 正文包含任一关键词
  { from: 'qq', tags: ['direct'] },                // 带 direct 标签
  { from: 'system', kinds: ['notice'] }            // 特定类型
]
```

判定：**任一条规则全部字段匹配**即放行。字段：

| 字段 | 含义 |
|---|---|
| `from` | 来源插件名（也允许 `'admin'` 这种伪来源） |
| `any` | 正文包含任一子串（不区分大小写） |
| `tags` | 信号的 tags 包含任一值 |
| `kinds` | 信号的 kind 属于列表 |

**不做正则**（避免注入与性能问题），需要复杂匹配就加标签。

## 5. TTL（我的方案，待审）

**默认永不过期**。TTL 只在发送方显式设置时生效：

- `expiresAt` 由发送方给（比如"10 分钟后的提醒"，过了就没意义）
- 过期只对 `notice` / `content` 有意义；`wake` / `goal` 永不过期
- 排队中过期 → 丢弃并计数（`droppedCount`），在 `world_status` 里可见
- **睡眠 8 小时不影响积压**：默认无 TTL，醒来照常释放

## 6. 睡觉期间的队列

- `phase === 'sleeping'`：不在白名单的全部入队，保留原顺序与 `from`
- 醒来时：**一次性成批释放**，前缀说明"你睡觉时积压了 N 条"，逐条列出来源与正文
- 模型可以 `time.skip(id)` 跳过某一条（仅本次）

## 7. 迁移顺序（不留债，但分三步落地）

1. **引入 `signals` 服务 + `to:'plugin'` 事件总线**，先把 `delivery` 包成一条路由，行为不变
2. **时间模块接管 `to:'model'`**：所有插件不再直接 `delivery.push`，改 `time.offer`
3. **`to:'focus'`**：时间模块调用 focus，睡觉/goal 自动入座；`focus.request` 走同一条判定

旧 API 保留一个适配层（`delivery.push(text)` → `Signal{kind:'content'}`），迁移完再删。

## 8. world_status 与队列

时间模块注册一个 world source：`owner: 'time'`，brief 形如：

```
时间：现在是 2026-11-03 01:12。
日程：23:00 睡觉（还有 22 小时）；当前阶段：awake。
积压：2 条（来自 qq 1 条，来自 bili 1 条）。
```

`world_status` 展开 `time` 时列出积压的来源与正文摘要——**醒来时模型一条 `world_status` 就能看到全部**。

## 9. 待你审的三点

1. §4 的约束语法（`from/any/tags/kinds`，无正则）是否可以
2. §5 的"默认永不过期、TTL 由发送方显式设置"是否可以
3. §7 的三步迁移顺序是否可以
