# MC 游戏内 status：独立于全局 world status

> 结论：**MC 状态不放进全局 world-state**。它是 MC 会话自己的、频繁但低噪声的状态段；全局 world 只保留现实时间/待办/人物。

## 1. 为什么不能并进 world status

现在 `world-state` 每轮给全局注入：

```text
时间：...
待办：...
```

如果把 MC 位置、任务、血量也塞进去：

- 非 MC 会话也会看到 MC 信息；
- MC 高频变化会污染全局状态；
- world 的 cap/顺序会被 MC 挤掉；
- 无法按“当前是否在 MC”控制噪声。

所以 **移除 `mc-link` 注册的 `world` source**。MC 状态只属于 MC 会话。

## 2. 三层状态

### 2.1 常驻一行：`mc:status`

由 `mc-link` 注册一个 **MC 专属 prompt section**，只在 `icl-mc` 会话存在：

```text
MC｜在线 · 位置 -12,64,8 · 任务 mine 3/16 · 血18/20 · 饱食17 · 背包 4/36
```

- 最多 1 行，约 120 字符；
- 每轮刷新（它本来就是动态的）；
- 未连接时显示 `MC｜未连接` 或干脆不显示；
- 不包含聊天全文、方块列表、任务历史。

### 2.2 条件提示：`mc:skills`

只在条件命中时出现，最多 2 行：

```text
MC 技能：交易（村民 4m；mcb_help trade）｜脱困（卡住 3s；mcb_help escape）
```

- 只给“有什么、为什么现在可用、去哪读”；
- 不放文档全文；
- 按优先级排序：危险/脱困 > 交易/工作台 > 建造/探索；
- 同一技能不重复刷。

### 2.3 事件通知：steer notice

任务完成/失败/安全停止/聊天：

```text
[MC] 任务 t-3 完成：mine dirt ×8
[MC] 安全停止：low-health
[MC] Hahn123_：在吗
```

- 走 `plugin:mc` steer，不走 system prompt；
- 只发**状态转移**，不发每 500ms 的 health/progress；
- 同类合并/限流；保命事件独立配额。

## 3. 频率与噪声预算

| 内容 | 频率 | 上限 |
|---|---|---|
| `mc:status` | 每轮 | 1 行 / 120 字符 |
| `mc:skills` | 条件变化时 | 2 行 |
| task 事件 | 状态转移 | 每轮最多 1 条普通事件 |
| safety 事件 | 立即 | 可打断，独立配额 |
| chat | 合并后通知 | 每分钟 N 条（默认 3） |
| health/food | 只在阈值/显著变化 | 不逐 tick |

## 4. 状态内容分级

### 常驻

- 在线/离线；
- 位置（取整）；
- 当前任务 kind + 进度；
- 生命/饥饿；
- 背包占用（件数/格数）。

### 条件

- 附近村民/工作台/熔炉/箱子；
- `stuck` 持续秒数；
- 低血/低氧；
- 背包满；
- 时间/天气（夜晚/雷雨）；
- 维度/传送门。

### 按需

- 完整背包列表 → `mcb_inventory`
- 附近方块 → `mcb_scan`
- 地形 → `mcb_map`
- 任务历史 → `mcb_do {op:"tasks"}`
- 事件 → `mcb_do {op:"events"}`

## 5. 实现位置

```text
mc-link 插件
  ├─ prompt section: mc:status（动态函数）
  ├─ prompt section: mc:skills（条件函数）
  └─ signals: task/safety/chat → steer(plugin:mc)

world-state 插件
  └─ 不再注册 mc source
```

- `mc-link` 已经能拿到 `lastStatus`；状态段由它生成；
- `world-state` 完全不知道 MC；
- 非 MC 会话没有 `mc-link`，所以看不到任何 MC 行。

## 6. 动态刷新

- `mc:status` 的 text 是函数，每轮 prompt 装配时读 `lastStatus`；
- `lastStatus` 由 `mc-link` 轮询 `/v1/status` 更新，不必每个事件都更新；
- 任务事件触发一次快速刷新，避免“刚完成还显示 running”；
- 如果 3 秒内没有变化，仍显示同一行，不额外发事件。

## 7. 反例

不要：

- 每 500ms 把 health 写进 world；
- 把聊天全文塞进系统提示词；
- 把 20 条任务历史塞进 status；
- 在非 MC 会话显示 MC 行；
- 用 `world_status` 当 MC 状态查询工具（应使用 `mcb_status`）。
