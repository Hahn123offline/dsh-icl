# MC 技能目录：提示词与操作组合（设计稿，待检查）

> 目的：在写实现前，把“世界提示 → 技能文档 → 组合操作”写成 MC 玩家能检查的规格。  
> 参考 `dsh-mc-agent` 的工具语义（mc_act/mc_craft/mc_furnace/mc_chest/mc_trade/mc_sequence），不复制代码。

## 1. 常驻工具提示（只到这里短）

### `mcb_status`
> 查看 MC 身体：连接、位置、生命/饥饿、当前任务、队列、最近事件。只读。

### `mcb_look`
> 看当前视角：朝向、视线方块、附近实体、手持。文本，不截图。

### `mcb_scan`
> 扫描附近指定方块：`name` 必填，`radius`/`count` 可选；返回坐标和距离。

### `mcb_map`
> 看脚下方块层小地图：`#` 实心、`.` 空、`~` 水、`≈` 岩浆、`?` 未加载。

### `mcb_inventory`
> 看背包、手持、装备数量。只读。

### `mcb_do`
> 统一交互工具：按顺序执行组合步骤，或下长任务/取消/恢复/查事件/说话。  
> 详细 op 与示例见 `mcb_help`；不确定时先读技能文档。

### `mcb_help`
> 读技能说明：`{skill:"trade"}`；不带参数列出当前环境可用的技能提示。

## 2. 组合操作 op

| op | 参数 | 语义 | 证据 |
|---|---|---|---|
| `look` | `target` | 看坐标/实体/方块 | 视线方块 |
| `move` | `target`,`range` | 走到坐标或实体附近 | 到达距离 |
| `goto` | `x,y,z,range` | 走到坐标 | 到达 |
| `use` | `target` | 右键方块/实体/使用手持 | 窗口/效果 |
| `dig` | `pos`/`name`,`count` | 挖方块 | 方块消失/掉落 |
| `place` | `pos`,`item` | 放方块 | 方块出现 |
| `equip` | `item` | 装备/手持 | 手持变化 |
| `toss` | `item`,`count` | 丢弃 | 背包减少 |
| `attack` | `target` | 攻击实体 | 掉血/死亡 |
| `wait` | `ms` | 等待 | 时间 |
| `craft` | `item`,`count` | 合成（API） | 背包增加 |
| `furnace` | `input`,`fuel`,`count` | 熔炼（API） | 产物 |
| `chest` | `action`,`items` | 箱子存取（API） | 箱子/背包 |
| `trade` | `action`,`index`,`count` | 村民交易（API） | 交易结果 |
| `task` | `kind`,`params` | 长任务 | taskId |
| `cancel`/`resume` | `taskId` | 控制长任务 | 状态 |
| `events`/`tasks` | `since`/`state` | 查询 | 事件/台账 |
| `say` | `text` | 公屏说话 | 已发送 |

**原则**：能用 `move → use → wait → craft/trade` 组合的，不新增工具；只有真正需要服务端窗口/配方的，做 API op。

## 3. 技能：村民交易（trade）

**提示条件**：附近有村民（≤16 格）且能看到/接近。
**world 提示**：`可用：交易（村民 4m；mcb_help trade）`

**文档正文：**

```text
用途：打开村民交易面板，查看条目，按序号买。
前置：附近有村民；不是宝宝/睡觉；有足够绿宝石/交换物。
步骤：
1) mcb_do steps:
   - move target={entity:"nearest:villager"} range=2
   - use target={entity:"nearest:villager"}
   - wait 400
2) 面板打开后：
   mcb_do {op:"trade", action:"list"}
   返回每条：index / 要什么 / 给什么 / 本轮已换次数。
3) 选条目：
   mcb_do {op:"trade", action:"buy", index:N, count:1}
4) 验证：背包里目标物品增加；否则读 trade list 看是否被限购。
失败：
- 没面板：村民太远/没职业/宝宝/睡觉；先 look 确认。
- 买不了：材料不够/已限购；换条目或换村民。
不要：不看 list 直接买；把全部绿宝石一次换完。
```

**组合示例：**

```json
[
  { "op": "move", "target": { "entity": "nearest:villager" }, "range": 2 },
  { "op": "use", "target": { "entity": "nearest:villager" } },
  { "op": "wait", "ms": 400 },
  { "op": "trade", "action": "list" }
]
```

## 4. 技能：合成（craft）

**提示条件**：背包有原料，或附近有工作台，或需要工具/木板。
**world 提示**：`可用：合成（有木头/工作台；mcb_help craft）`

**文档正文：**

```text
用途：按配方合成，自动补中间产物（木板→木棍→木镐）。
前置：知道目标物品名；材料够；3x3 配方需要工作台。
步骤：
1) mcb_inventory 看现有材料。
2) mcb_do {op:"craft", item:"wooden_pickaxe", count:1}
3) 若报缺工作台：先 place 工作台（若背包有）或找附近工作台，再重试。
4) 验证：mcb_inventory 看目标物品数量；不要把“动作发出”当成功。
失败：
- 缺料：返回缺什么/缺几个，先补料。
- 无工作台：3x3 配方需要；2x2 可在背包合成。
不要：反复点同一配方；不看缺料就硬试。
```

## 5. 技能：熔炼（furnace）

**提示条件**：背包有矿石/食物 + 燃料，或附近熔炉。
**world 提示**：`可用：熔炼（有粗铁/煤；mcb_help furnace）`

**文档正文：**

```text
用途：把矿石/食物烧成产物。
前置：熔炉（附近或背包）、输入物、燃料（煤/木炭优先）。
步骤：
1) mcb_do {op:"furnace", input:"raw_iron", fuel:"coal", count:3}
2) 等待烧炼完成（API 返回或 poll）。
3) mcb_inventory 验证铁锭数量。
失败：
- 没熔炉：先 place 熔炉；没有就报缺。
- 没燃料：先找煤/木炭；木棍/木板只作最后手段。
不要：把要合成用的木板当燃料烧掉。
```

## 6. 技能：箱子（chest）

**提示条件**：附近箱子/木桶，或背包满。
**world 提示**：`可用：仓库（箱子 3m；mcb_help chest）`

**文档正文：**

```text
用途：存取物品，整理背包。
步骤：
1) mcb_do {op:"chest", action:"list"} 看箱子内容。
2) 存：{op:"chest", action:"put", items:[{name:"dirt",count:64}]}
3) 取：{op:"chest", action:"take", items:[...]}
4) 验证：mcb_inventory / chest list 前后对比。
不要：all:true 全搬把工具/装备也存进去；先看清单。
```

## 7. 技能：脱困（escape）

**提示条件**：pathfinder `stuck`、位置长时间不变、掉进坑/水里。
**world 提示**：`可用：脱困（卡住 3s；mcb_help escape）`

**文档正文：**

```text
用途：寻路器卡住时手动脱困。
步骤：
1) mcb_scan 周围方块；mcb_map 看脚下方块层。
2) 若是 1 格台阶：dig 脚上方/头顶挡路方块，再 move。
3) 若是坑：place 方块垫脚，jump/move。
4) 若是水：上浮/游向岸边；不要在水下挖。
5) 每次只做一个动作，看结果再决定。
不要：盲目重复同一个 goto；不要在岩浆边上垫脚。
```

## 8. 技能：逃跑/战斗（flee/fight）

**默认**：`autoDefense:"fleeOnly"`；苦力怕贴脸先退。
**world 提示**：`威胁：僵尸 3m（默认撤退；mcb_help flee）`

**文档正文：**

```text
默认：先撤到安全距离/掩体，低血先吃。
模型可显式 override：
  mcb_do {op:"task", ... safety:{autoDefense:"allow", allowFight:true}}
但低血/死亡仍硬停止。
不要：为了做任务硬顶；不要在苦力怕旁边对刀。
```

## 9. 技能：睡觉/吃饭（sleep/eat）

- 夜晚/雷雨且有床：`use` 床；白天会报“白跑”。
- 饥饿/低血：先在背包找食物，`use`/`eat`；没有就报告。
- 不把“有床”当“已睡”；看时间/天气变化。

## 10. 待补技能

- 建造/搭桥（材料、支撑、防摔）
- 下界/末地准备
- 钓鱼/种田
- 村民繁殖/刷铁机等高级玩法

这些先不写成常驻工具；条件满足时给提示，文档按需读。

## 11. 不做什么

- 不新增 `mcb_trade` / `mcb_craft` 工具；用 `mcb_do` op。
- 不把整份文档放系统提示词。
- 不在没有证据时说“成功”。
- 不让 body 自己选技能/生成目标；body 只执行 op。
