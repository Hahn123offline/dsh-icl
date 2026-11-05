# MC 宏操作契约（草案 v0.1，2026-11-06 用户设计转向）

> 用户第二次设计转向：**重复劳动不要交给模型逐方块执行**。机器人自带"收集资源 / 搭桥 / 挖隧道 / 建简单结构"等脚本级技能；模型只负责**下宏指令、查进度、随时打断**。大型建筑必须给**可格式化的蓝图工具**，否则重复劳动会逼出退化循环，也几乎失去建造复杂结构的能力。
>
> 本文先定契约（op / 参数 / 事件 / 取消暂停 / 失败原因 / 验收），实现分批进行。宏统一**走 body task**（有 taskId / progress / outcome），模型一条 op 调用，不阻塞。

## 0. Motivation（真服证据：为什么必须做宏）

同一晚 night-1（runDir `C:/DSH/icl-wt/mc-lab/.state/lab/night-1`，events.jsonl 为权威源）：

- `[~00:36]` **96 次**同一"成功但无用"调用：`mcb_do {"intent":"捡附近掉落物（半径16）","steps":[{"op":"goto","params":{"x":29,"y":70,"z":-69,"range":16}}]}` —— 她站在该点、range 16，goto 秒成功，错误计数=0，按"错误循环"设计的熔断不响；真实需求"捡死亡掉落"没有对应 op。
- `[~00:29]` **22 次** `dig: 方块没有变化`（同一失效坐标 goto+dig 组合）；`craft` 无工作台/缺中间步骤被重复 13–131 次（`craft crafting_table` 131 次那次：有 8 原木但跳过"原木→木板"）。
- `[~01:20–01:34]` 同 `mine stone count=10` 长 op 反复提交（mc-link 120s 超时后她又发，body 无 doPlan 单飞锁 → `tool call aborted` / `mine: dig-failed`；watch 统计 sameCallMax=23）。
- 结果：**10 分钟内用 mine/goto 原语反复挖同一资源数百方块，却没有"盖出/挖出/整理出"任何结构**；模型不停在"下一步点哪个方块"上退化，而不是"我要完成什么"。

结论：**原语级工具面不适合长任务**。宏操作把"怎么做"下沉到 body（脚本），模型只保留"做什么/是否继续"。

## 1. 设计原则

1. **一条宏 = 一个 body task**：有 `taskId`、`state`、`progress`、`result`、`deadline`；`mcb_do {"op":"task","kind":"collect",...}` 立即返回，不阻塞请求。
2. **不生成目标**：宏只执行参数给出的目标；不会自己决定"再去挖点别的"。
3. **可取消/可暂停/可检查**：cancel 必须让 mineflayer 停止（停止寻路/挖掘/控制状态）；安全暂停（低血/死亡/断线）中断宏并保留进度；`tasks`/`events` 可查。
4. **进度限频**：progress 事件每 **5–10%** 或每 **10s** 一次（两者取先到），避免刷屏/唤醒风暴。
5. **安全护栏内建**：下挖查水/岩浆、不拆自己支撑、卡住阶梯脱困、工具前置判定（错工具立即 failed+needsTool，不重试）、背包满即失败并给下一步。
6. **有界**：长度/数量/材料都有上限（单次 collect ≤ 256、tunnel ≤ 128 格、build ≤ 蓝图层数上限）；超界直接 400。
7. **幂等**：`idempotencyKey` 重复提交返回原 task。
8. **复用原语**：宏内部复用 mine/goto/dig/place/equip/chest 逻辑，不另写一套 mineflayer 操作。

## 2. 第一批 op（今晚最小可用 + 明早扩展）

| op | 参数 | 成功判据 | progress 字段 | 备注 |
|---|---|---|---|---|
| `collect` | `{item, count, radius=16, returnToSafe?, deposit?{chest?}}` | 背包内该物品净增 ≥ count，或明确 `no-target`/`no-path` failed | `{collected, target, net, trips, tool}` | 对 mine 包一层：item→方块映射（iron_ingot→iron_ore、coal→coal_ore、cobblestone→stone、oak_log→*_log…）、净增判据、自动工具、掉落继续收；`returnToSafe` 回安全点、`deposit` 存附近箱子 |
| `tunnel` | `{direction:"north|south|east|west|dx,dz", length, height=2, stairs=false, torchEvery=6}` | 前进 length 格且每格高 ≥height 的通道打通；中途遇水/岩浆/基岩停止并 failed(reason) | `{done,total,position,direction,tool,torches}` | 直线 1×2（或 height 高）隧道；先挖头再挖脚；每 torchEvery 格放火把（有才放）；卡住用阶梯脱困；不挖基岩/流体 |
| `bridge` | `{direction, length, width=1, support="cobblestone", rail?}` | 从当前位置向前铺 length 格（宽度按 width），脚下连续有支撑 | `{done,total,materialsUsed}` | 先看背包材料够不够，不够立即 failed(needs-material)；后退铺/前铺策略明早定 |
| `build` | `{blueprint, origin?, rotate?, materialPolicy="strict|substitute"}` | 蓝图每层按 palette 放置完成，材料充足/替代策略满足 | `{layer,totalLayers,placed,skipped}` | 蓝图 JSON（见 §4）；先校验材料与站位可达，再逐层从下往上放；放不下（悬空/超距）记 skipped 并有上限 |
| `sort` / `deposit` | `{chest?, items?[], all?}` | 目标物品进箱子；`all` 时工具/装备/食物默认保留 | `{moved,kept}` | 复用 chest put/take；容量不足要报告"箱子满" |
| `shelter` | `{size=3, material?, door?}` | 3×3×3 内封顶+围墙+入口，玩家有安全空间 | `{walls,roof,door,placed}` | 建简单避难所（夜里用）；材料不够 failed(needs-material) |
| `farm` | `{crop,count,materials?}` | 开垦/播种 count 格，水/光照满足 | `{tilled,planted,total}` | 明早做 |

**今晚最小实现**：`collect` + `tunnel`（如时间不够只做 collect；tunnel 契约先定，明早实现）。

## 3. 统一语义

### 3.1 调用

```json
mcb_do {"steps":[{"op":"task","kind":"collect","params":{"item":"oak_log","count":32,"radius":24}}]}
```
→ 立即返回 `{taskId}`；之后进度/完成通过 `task_progress`/`task_done`/`task_failed` 事件。

### 3.2 状态机

`queued → running → done | failed | cancelled | interrupted | unknown | paused`
- 安全暂停（低血/死亡/断线）→ 当前宏 `interrupted`（保留 progress/result），身体 paused；恢复需显式 resume。
- 宏内部小失败（某格挖不动）→ 重试/跳过（有上限），不直接 failed；超过上限 → failed(reason)。
- deadline → `unknown`（结果未知，不重试、先核状态）。

### 3.3 取消/暂停/检查
- `POST /v1/tasks/:id/cancel`：宏必须在 ≤1s 内停止当前动作（setGoal(null)、清控制状态、清队列），progress 保留。
- 暂停态 cancel 允许（安全动作）；暂停态不能下新宏（409）。
- `tasks`/`events` 随时可查；宏 progress 限频（§1.4）。

### 3.4 失败原因码（result.reason，供 mc-link 翻译）
`no-target` / `no-path` / `dig-failed` / `needs-tool` / `inventory-full` / `needs-material` / `blocked`（前方水/岩浆/基岩）/ `unsafe`（下挖查水等安全护栏拒绝）/ `timeout`（= unknown，不重试）/ `partial`（有进展但没完成，例如材料只够一半）。

## 4. 蓝图格式（build）

```json
{
  "version": 1,
  "name": "small_hut",
  "size": { "x": 5, "y": 3, "z": 5 },
  "palette": { "#": "oak_planks", "C": "cobblestone", " ": null },
  "originOffset": { "x": 0, "y": 0, "z": 0 },
  "layers": [
    ["#####","#####","#####","#####","#####"],
    ["#   #","    ","    ","    ","#   #"],
    ["#####","#####","#####","#####","#####"]
  ]
}
```
- `palette` 的 `null`/`" "` = 空气/跳过；`layers[y][z][x]` 从下往上。
- 材料校验：先统计 palette 需求 vs 背包；`materialPolicy:"strict"` 不足即 failed(needs-material) 并列出缺料；`"substitute"` 可按同类替代（明早，默认 strict 更安全）。
- 站位：无脚手架/飞行能力，只能放到 reach 4.5 内；超过 → skipped（有上限），完成后 result 报 `skipped` 数量与位置。

## 5. 事件（新增）

- `task_progress`：`{taskId, progress:{...限频字段}}`
- 宏专属信息事件（不叫醒）：`macro_step`（例如 tunnel 每格/每 5%）、`macro_blocked`（前方流体/基岩）、`macro_tool_auto`（自动换工具）
- 终态复用 `task_done/task_failed/task_interrupted/task_paused/task_unknown`。

## 6. 验收标准

1. **单测**：参数校验/边界/方向解析/蓝图解析/材料统计/进度限频；失败原因码正确。
2. **真服（flat 54839 或 normal 54840）**：
   - `collect {item:"oak_log",count:8}`：一次调用挖到 ≥8，progress 有 net/tool，done 带 result；中途 cancel 能 ≤1s 停。
   - `tunnel {direction:"east",length:8,height:2}`：8 格 2 高通道贯通；遇水/岩浆 blocked 且报告位置；0 死亡。
   - `build`（明早）：5×3×5 hut 蓝图在小屋场景完成，材料不足时 failed(needs-material) 且不缺料误报。
3. **模型侧**：一条宏调用 + 每 10s 查 progress，不再出现"逐方块 goto/dig 几十次"；transcript 中同 op 重复 ≤3。
4. **安全**：宏执行中低血/死亡/断线按现有 safety 语义中断，deaths=0（测试场景）。

## 7. 实现状态

- [x] 契约草案（本文）
- [x] `collect`（已实现 + 真服 smoke 通过，见上）；- [x] `tunnel`（已实现 + 真服 smoke 通过，见上）
- [ ] `tunnel`（今晚若时间允许；否则明早）
- [ ] `bridge` / `build` / `sort` / `shelter` / `farm`（明早）

> 维护约定：宏的**行为契约**在本文；body 实现细节在 `packages/mc-body/README.md`；模型教学放 `packages/plugins/mc-link/skills/*.md`（macro 技能明早加）。

### 真服 smoke 证据（2026-11-06 01:5x，54839 干净平顶；产物 `C:/DSH/icl/.state/lab/mc-body-soak/macro-smoke/`）

- `collect {item:"dirt",count:3,radius:8}` → `t-1 done`（6.0s）：`result {collected:3,item:"dirt",block:"dirt",source:{mined:3,net:3,reason:"net-target"}}`，progress 带 `done/total/net/tool`。
- `tunnel {direction:"east",length:5,height:2}` → `t-2 done`（4.4s）：`result {done:5,total:5,direction:"east",height:2,torches:0}`，位置从 x≈-6.5 前进到 x=-1.5（5 格），血 20、body 未暂停。
- 未拿到证据：`blocked`（前方水/岩浆）与 torch 放置（flat 无流体/无火把）——明早在 normal 地形补；`bridge/build/sort/shelter/farm` 未实现。


补充（mc-lab 退化统计 2026-11-06 01:20–01:37Z，night-1，154 calls；证据 `.state/lab/night-1/degradation-*.json`）：
- 工具调用分布：`mcb_status 101 / mcb_do 39 / mcb_inventory 8`；`mine/dig 22 次全部 stone`；**assistant 目的表述 0 条**。
- task 事件 87 条：`task_progress 79 / done 1 / cancelled 1` —— 同一任务逐块 progress 循环，不是资源不足。
- 结论：模型把时间花在"反复查状态+逐块挖同一资源"上，没有任何结构/目标推进；这正是宏操作要消灭的退化模式（一条宏 + 限频 progress 代替 79 条 progress/s 数十次原语）。

### 第二波契约细化（2026-11-06 03:1x，纯逻辑+单测就绪，adapter 明早实现）

- `bridge`：`bridgePlan(params)` 已给出每步要铺的格子（沿方向 step=1..length，宽度沿垂直方向展开，`yOffset:-1` 即支撑放在前进格脚下）；adapter 实现要点：先 `checkBlueprintMaterials`/库存核对 `length*width` 个 support，不足立即 `failed(needs-material)` 并给需补数量；每步“放支撑→走到支撑上→下一步”，掉落/被挡算 `blocked`。
- `build`：`parseBlueprint(blueprint)` 校验 size/layers/palette 尺寸并展开 placements（相对坐标，从下往上 y）；`checkBlueprintMaterials(blueprint, counts)` 给 `{ok,missing[]}`；adapter 明早做：origin（默认玩家脚下方块）、可选 rotate、逐层放、超出 reach 4.5 记 skipped（有上限）、`strict` 材料不足立即 failed(needs-material)。
- `shelter`：`shelterPlan({size,height})` 给出墙/顶/门占位（门在 z=0 中间、y0–1）；adapter 明早用 place 逐格放，材料不足 failed(needs-material)。
- 单测：`test/macro.test.mjs` 已覆盖 bridgePlan/parseBlueprint/checkBlueprintMaterials/shelterPlan（45/45 mc-body 测试绿）。

### 第二波 adapter 实现（2026-11-06 03:4x，比计划提前）

- [x] `bridge`：已实现（`bridgePlan` + 逐格放支撑→前进；材料先按 `length*width` 校验，不足 `failed(needs-material)` 带需补数量；脚下已有实心则跳过）。
- [x] `build`：已实现（`parseBlueprint` 校验 + `checkBlueprintMaterials` 预检；origin 默认脚下，也可传；逐层从下往上、超出 4.5 格先 goto 再放；同方块已在位计 `already`；放不上计 `skipped`；完成 progress `{done,total,placed,skipped,already}`）。
- 真服 smoke（54839 干净平顶，产物 `.state/lab/mc-body-soak/build-smoke{,2}/`）：
  - `collect dirt 20` → done 21（net 21）；
  - `build` 3×1 dirt 蓝图 → done `{placed:1, skipped:0, already:2, total:3}`（2 格与地面重合计 already，1 格真实放置）；
  - `bridge {direction:"east",length:3,support:"dirt"}` → done `{done:3,total:3,placed:0}`（平地已有支撑→跳过，只验证前进/材料校验路径）。
- 未验/待补：bridge 真实断崖（需 normal 地形挖坑/沟）、build 旋转/`materialPolicy:"substitute"`、build 高层脚手架、sort/shelter/farm（明天实现）。
