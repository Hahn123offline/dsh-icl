# local3 取证（MC-LOCAL3-FORENSICS）

> 目的：冻结本地 24h `e2-20261106-local3` 的 **body 侧证据**，回答“建了多间 3×3 但没一次成功/记住”“path_stuck 分布/触发”“分钟级延迟”三个问题。
> 状态：**MC 长跑冻结（2026-11-06 16:45 HKT）**；本文只读已有证据，不跑测试、不启服。
> 数据：`.state/lab/e2-20261106-local3/`（mc-lab worktree），对应 mc-lab [`MC-FREEZE-2026-11-06.md`](../../mc-lab/docs/MC-FREEZE-2026-11-06.md) 与 `freeze-forensics.json`。
> 说明：部分工具调用计数来自 `freeze-forensics.json` 的“最近 gen + body 全程”快照；与 body ledger 的全量 task 数存在口径差，本文按“原始 body 事件/ledger 优先”标注。

## 1. Run 形状

| 项 | 值 | 来源 |
|---|---|---|
| run | `e2-20261106-local3`，本地 coder390 27B，24h 计划 | lab.json/e2.log |
| 本次冻结样本 | body 事件约 **90 min**（first→last event） | `state/mc-body/body.jsonl` |
| 事件/轮次 | events **1547**，turns **77**，assistants 230，userMessages 181 | freeze-forensics |
| body 事件 | task_queued 106 / task_started 104 / task_failed 90 / task_done 7 / interrupted 3 | freeze-forensics |
| 安全 | death **12**，safety_stop 58，emergency 96，reflex 23，health_drop 34，auto_defense **22**，task_cancelled_for_defense **6** | freeze-forensics/body |
| 聊天 | 显式 say 调用 **87**；chat_sent 74；top 文案：“盖小屋中，等它盖好就进去睡” **49**、“采土中，等够 40 块再盖小屋” **33** | freeze-forensics |
| 工具 | mcb_status 44、mcb_do 95、mcb_shelter **6**、mcb_look 1、mcb_join 1（快照口径） | freeze-forensics |

> 口径注意：`freeze-forensics` 的 toolCounts 与 body 全量 task 数不一致（见 §2.3）；本报告以 body ledger/事件明细为准，并保留该差异作为待查项，不用“工具调用数”推断“任务尝试数”。

## 2. 建房：92 个 shelter task、90 次失败、0 成功、0 home

### 2.1 任务级数据（body ledger/事件）

| 指标 | 值 |
|---|---|
| shelter task 唯一 id | **92**（t-4 … t-106） |
| task_queued / started | 92 / **91** |
| 终态 | failed **90**、interrupted **2**、done **0** |
| 失败码 | `shelter: needs-material` **86**、`shelter: no-site` **3**、`shelter: incomplete` **1** |
| `home_set` | **0** |
| `shelter_done` | **0** |
| `shelter_incomplete` | **1** |
| `shelter_place_fail` | **37** |
| `entryOk` | 未出现（没有任务走到 done） |
| 任务时间跨度 | 79 min（createdAt t-4→t-106） |

### 2.2 那次“最接近成功”的结构（incomplete）

唯一一次进入 verify 的任务（`shelter: incomplete`）：

```json
{"verify":{"ok":false,
 "walls":{"ok":false,"missing":9,"total":14,
   "faces":{"north":{"missing":6,"total":6},"south":{"missing":1,"total":6},"east":{"missing":0,"total":0},"west":{"missing":2,"total":2}}},
 "roof":{"ok":false,"missing":6,"total":9},
 "door":{"ok":true,"openCells":2,"missing":0},
 "interior":{"ok":true,"blocked":0},"floor":{"ok":true,"missing":0},
 "entry":{"ok":true,"outsideClear":true,"doorOutClear":true,"insideClear":true},
 "summary":"墙缺 9 块（north:6、south:1、west:2）；屋顶缺 6 块"}}
```

- 失败原因：**北面墙几乎全缺 + 屋顶缺 6 块**，说明“从门口/地面放远端/高处”的可达性与支撑策略仍不足；verify 已经能精确指出缺哪面，但**模型/上层没有消费这份诊断去补齐**（随后继续重试新 shelter）。
- 这是 92 次尝试里唯一有 verify 明细的一次；其余 86 次在材料 gate 直接失败，3 次 no-site，根本没进入建造。

### 2.3 “6 次 mcb_shelter” vs “92 个 shelter task”的口径差（未解释，需下一轮埋点）

- 冻结快照 toolCounts：`mcb_shelter` 仅 **6** 次；body ledger 却有 **92** 个 shelter task（t-4…t-106）。
- 可能来源（按当前证据无法唯一判定，列出待查）：
  1. toolCounts 是**最近 gen 快照**，未覆盖全 90min；
  2. supervisor/ledger **replay/重连**重复入队（bodyCounts join 4、ledger_loaded 3）；
  3. mc-link 其他入口/批量 steps 创建任务（本次 mcb_do 的 95 次里 87 次是 say，仅 1 次 collect task，无法解释 92 个 shelter）。
- 结论：**不能把“6 次 mcb_shelter”当成“6 次建房尝试”**；下一轮需按 `taskId + 来源（tool/supervisor/replay）` 埋点，否则会低估重复劳动。

### 2.4 手动盖 vs 宏

- 事件/转录里未发现“手动逐方块 place/dig 把 3×3 完整搭起来”的成功路径；主要输出是：提交 shelter task → 等待 → 失败 → 发同句 say → 再提交。
- 转录里反复出现“shelter 盖了但结构不完整，墙缺 9 块、屋顶缺 6 块。等它补完。”——她把 `incomplete` 当成“会自动补完”的中间态，但没有补齐动作/验收循环。
- 因此“建了多间 3×3”更准确说法是：**发起过 92 次 3×3 任务，只有 1 次到结构验收且不完整；没有一次完成，也没有 home**。不是“建好了但没记住”。

### 2.5 为什么没记住 home

- `home_set` 只由 shelter **done** 且 result.home 触发；local3 **0 done** → `home: null`（ledger 也确认 `home: null`）。
- 没有 done 就没有 `entryOk`，也没有 verify.ok；记忆里只有 say 文本/聊天，不是结构化 home。
- 结论：**记忆写入依赖成功验收**，而验收链在材料/建造阶段就断了；不是记忆模块丢数据。

## 3. path_stuck 分布/触发

- 全程 `path_stuck` **65**；`path_approximate` 75、`path_recovered` 17；task_started 104 / failed 90。
- 距离分布（stuck 时 target 距离）：`<2: 7`、`2–3: 11`、`3–5: 14`、`5–8: 11`、`>=8: 22`。
- `attempts` 分布：1 次 **29**、2 次 **28**、3 次 **8**（说明多数在 1–2 次重试内放弃）。
- 热点区域（按 target 16×16 区块近似）：`(-16,-80):16`、`(0,-96):10`、`(-16,-64):8`、`(0,-48):7`、`(0,-80):5`；集中在地表/已有小屋附近，不是单一矿洞。
- 典型样本：target 距离从 2.5 到 23.4 都有（含 y 高于脚/头顶、目标在墙后/树后）；当前 `path_stuck` 事件只有 target/distance/pathResets/attempts，**缺少任务 kind、目标类型、失败原因（A* noPath/超时/被方块挡）**，所以无法把“寻路问题”和“材料/建造问题”拆开。
- 判断：local3 的失败被 `shelter: needs-material` 主导（90/97 失败），**path_stuck 的独立影响目前不可量化**；下一轮需按 task kind/目标类型/恢复动作分桶，否则会误把 shelter 失败归因于寻路。

## 4. 分钟级延迟（本地 27B 实测）

`freeze-forensics.json`（本地 coder390，非 cloud 指标）：

| 指标 | p50 | p95 | max | 说明 |
|---|---|---|---|---|
| turn-gap | 1 s | 30 s | 30 s | immediate tick + 空闲退避；>60s 0 次 |
| step→tool（assistant→下一次 tool） | 2.2 s | **31.4 s** | — | 本地模型单步尾部很慢 |
| tool→assistant | 0.88 s | 1.2 s | — | 工具执行本身不慢 |
| turn 长度 | 3 s | 4 s | **73 s** | 不是“单回合 10min”；长回合是局部 |
| 本次样本 turns | 77（约 15min 的 gen） | | | 与 body 90min 分开看 |

- 结论：延迟主因是**本地模型 step 的 p95 31s** + **重复任务/刷屏**，不是工具执行（tool→assistant p95 1.2s）。
- 观测到的最长 turn 73s 不是主要模式；local2 的“单回合 21min/219 tools”是旧 body/模型组合，不应拿来当 local3 常态。
- 待查：step p95 31s 是否与上下文长度/任务类型（shelter 失败重试）相关；需要按 turn 记录 prompt tokens/tool kind，否则无法区分“模型慢”与“上下文被失败/聊天撑大”。

## 5. 安全与新增机制的现场表现

- death **12**（均在 mob/环境伤害；冻结 doc 记录 death-watch 从 death≥6 起接管）；safety_stop 58、emergency 96、reflex 23。
- `auto_defense` 22 次、`task_cancelled_for_defense` **6** 次：说明 `cbb37f8` 的“danger 取消非战斗任务 + hold 队列”在 local3 现场**有触发**；但 shelter 材料失败/刷屏仍然盖过了它，需下轮按“取消后是否停止重试”验证有效性。
- 聊天 87 次 say、同句 49/33 次：是模型自发的进度播报循环（mc-body/mc-link 无自动转发），属于 supervisior/loop 侧需要处理的“重复 say”问题（冻结 doc §1）。

## 6. 这份证据证明了什么/没证明什么

**证明：**
1. 建房失败主因是**材料 gate（86/90）**与**建造可达性/支撑（唯一 incomplete：北墙 6/屋顶 6）**，不是“模型不会说/不会等”。
2. **0 home_set 是结果不是原因**：没有 done → 没有 verify.ok/entryOk/home；记忆层不背锅。
3. path_stuck 存在（65 次）但被 shelter 失败淹没；当前事件字段不足以单独归因。
4. 延迟主因是本地模型 step p95 31s 与重复任务/刷屏，不是工具执行。

**没证明/待查：**
1. 6 次 mcb_shelter vs 92 个 shelter task 的来源（tool 快照/重放/supervisor）；
2. path_stuck 在不同 task kind 下的独立影响（缺 kind/原因字段）；
3. 73s 长 turn 的上下文/任务关联（缺 token/kind 记录）；
4. auto_defense 取消任务后是否真的减少“取消→立刻重下”循环（local3 仅有 6 次，样本小）；
5. 是否有人工/玩家介入建房（转录未发现，但未逐条核 world diff）。

## 7. 复现/核对

- 原始数据：`.state/lab/e2-20261106-local3/state/mc-body/body.jsonl`、`tasks.json`（ledger，`home:null`）、`events.jsonl`、`transcript.md`、`freeze-forensics.json`。
- 冻结报告：mc-lab [`MC-FREEZE-2026-11-06.md`](../../mc-lab/docs/MC-FREEZE-2026-11-06.md)。
- 研究对照：本仓 [`MC-RESEARCH.md`](MC-RESEARCH.md)；长跑检测设计：[`E2-HARNESS.md §10`](E2-HARNESS.md)。
