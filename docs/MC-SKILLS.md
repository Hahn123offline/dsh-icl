# MC 能力分层与按需注入设计

> 目标：**静态小工具面 + 组合操作 + 按需技能文档**。  
> 不按环境动态注册 DSH 工具；不把全部说明书塞进系统提示词。

## 1. 分层

| 层 | 内容 | 是否常驻 | 说明 |
|---|---|---|---|
| **L0 感知/状态** | `mcb_status` `mcb_look` `mcb_scan` `mcb_map` `mcb_inventory` | 是 | 小、常用、无副作用 |
| **L1 统一交互** | `mcb_do` | 是 | 一个工具承载组合步骤、长任务、取消/恢复、聊天 |
| **L2 技能文档** | `mcb_help` + `skills/*.md` | 工具常驻，文档按需 | 世界状态只给一行提示，模型需要时读全文 |
| **L3 生命周期/管理** | 连接、账户、诊断、kill switch | 否 | body/宿主负责，不进模型工具面 |

常驻工具控制在 **7 个**：

`mcb_status` / `mcb_look` / `mcb_scan` / `mcb_map` / `mcb_inventory` / `mcb_do` / `mcb_help`

`mcb_say`、`mcb_task`、`mcb_cancel`、`mcb_resume`、`mcb_events`、`mcb_tasks` 都收进 `mcb_do` 的 op，不再单独注册。

## 2. `mcb_do`：统一交互工具

### 组合步骤

```json
{
  "intent": "打开村民交易面板",
  "steps": [
    { "op": "move", "target": { "entity": "nearest:villager" }, "range": 2 },
    { "op": "use", "target": { "entity": "nearest:villager" } },
    { "op": "wait", "ms": 400 }
  ],
  "safety": { "autoDefense": "fleeOnly", "allowFight": false }
}
```

### 长任务

```json
{ "op": "task", "kind": "routine", "params": { "durationMs": 600000 } }
```

### 控制/查询

```json
{ "op": "cancel", "taskId": "t-1" }
{ "op": "resume", "taskId": "t-1" }
{ "op": "events", "since": 42 }
{ "op": "tasks", "state": "done" }
{ "op": "say", "text": "在" }
```

### 基本 op

- 感知：`look` / `scan` / `map` / `inventory`
- 移动：`move` / `goto` / `patrol` / `explore` / `follow`
- 交互：`use` / `dig` / `place` / `equip` / `toss` / `attack` / `wait`
- 长任务：`task`
- 控制：`cancel` / `resume` / `events` / `tasks`
- 社交：`say`

`mcb_do` 立即返回 taskId/stepId；长步骤通过事件/状态追踪，不阻塞主会话。

## 3. 技能文档

### 注册表

```js
{
  id: 'trade',
  title: '村民交易',
  when: (state) => state.nearby.villager > 0,
  summary: '附近有村民；可以打开交易面板',
  doc: 'skills/trade.md',
  ops: ['move', 'use', 'wait', 'trade'],
}
```

### 注入方式

- `world_status` 只追加 **一行提示**：

```text
可用：交易（村民 4m；mcb_help trade）
```

- 模型需要时调用：

```json
{ "skill": "trade" }
```

- `mcb_help` 返回 `skills/trade.md` 全文，包含：
  - 前置条件；
  - 组合步骤示例；
  - 失败/回退；
  - 不要做什么。

### 为什么不是动态工具

- 动态注册工具会让工具 schema 抖动、缓存失效、模型反复学；
- 静态 7 工具 + 文档按需读取，token 只在需要时花；
- 环境条件只影响 **提示/文档可用性**，不影响工具面。

## 4. 村民交易示例

`world_status`：

```text
可用：交易（村民 4m；mcb_help trade）
```

`mcb_help {skill:"trade"}` 返回：

```text
1. mcb_do steps: move 到 nearest:villager（range 2）
2. use nearest:villager，wait 400ms
3. 面板打开后，mcb_do {op:"trade", action:"list"} 看条目
4. 选 index 后 {op:"trade", action:"buy", index, count}
```

模型即使忘了 API，也能重新读文档；不需要新增 `mcb_trade` 工具。

## 5. 手动脱困

当 pathfinder 报告 `stuck`：

- `mcb_scan` 给周围方块坐标；
- `mcb_map` 给脚下方块层；
- 模型用 `mcb_do` 组合 `dig` / `place` / `move` / `jump` 手动脱困；
- 不依赖寻路器独自解决。

这是 **必须保留** 的能力；只靠自动寻路会卡死。

## 6. 反击与逃跑

默认：

- `autoDefense: 'fleeOnly'`；
- 低血、苦力怕贴脸先撤；
- body 反射可以后撤/挡/吃，不主动开战。

模型可以 override：

```json
{ "safety": { "autoDefense": "allow", "allowFight": true } }
```

- body 仍保留低血/死亡硬停止；
- override 必须显式，且事件留痕；
- 不允许 body 自己生成“开战”目标。

## 7. 技能分组

| 组 | 技能 | 触发 |
|---|---|---|
| 生存 | escape / eat / shelter / sleep | 卡住、饥饿、夜晚、低血 |
| 村民 | trade | 附近村民 |
| 工作台 | craft / furnace | 附近工作台/熔炉或背包材料 |
| 仓库 | chest | 附近箱子/背包满 |
| 建造 | build / bridge | 目标区域、材料 |
| 战斗 | fight / flee | 威胁、低血 |
| 下界/末地 | portal / prep / dragon | 维度/传送门 |
| 社交 | chat / whisper | 玩家说话、点名 |

每个技能只在条件满足时出现在 `world_status` 提示；文档永远可通过 `mcb_help` 显式请求。

## 8. 干净实现边界

- **body**：只提供原始状态 + 原子操作 + 安全反射；不认识“技能”；
- **mc-link**：技能注册表、条件判断、提示、文档读取、`mcb_do` 编排；
- **DSH**：静态 7 工具，不动态注册；
- **文档**：`packages/plugins/mc-link/skills/*.md`，随插件版本走；
- **不把技能文档塞系统提示词**；只在 `mcb_help` 工具结果里返回。

## 9. 测试

- `when` 条件单测：村民/卡住/背包/低血；
- `world_status` 只出现一行提示，不出现全文；
- `mcb_help` 读取文档、未知技能报错；
- `mcb_do` 组合步骤、部分失败、取消、结果未知；
- 真实 flat：`dig/place/move` 手动脱困；
- 真实 ICL：世界提示 + 模型按需读文档。
