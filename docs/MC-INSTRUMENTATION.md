# MC 埋点与回放格式（MC-INSTRUMENTATION）

> 状态：**冻结期设计稿（2026-11-06）**；只定字段/格式，不实现、不跑 MC、不启服、不加 MC 工具。
> 服务对象：mc-lab `E2-HARNESS §11`（原 mc-body §10）L1 回放/L2 分段验收；local3 证据见 [`MC-LOCAL3-FORENSICS.md`](MC-LOCAL3-FORENSICS.md)。
> 对齐：mc-lab [`MC-FREEZE-2026-11-06.md`](../../mc-lab/docs/MC-FREEZE-2026-11-06.md)、[`E2-HARNESS.md`](../../mc-lab/docs/E2-HARNESS.md)；本仓 [`MC-RESEARCH.md`](MC-RESEARCH.md)。

## 0. 结论

- **path_stuck 现在只有 target/distance/pathResets/attempts，无法区分“寻路失败”与“任务/材料/目标错误”**；建议升级为 `path_stuck v2`（§2），先补 6 类字段：**任务上下文、目标类型、失败原因、恢复轨迹、环境上下文、结果关联**。
- **回放输入**分 L1（离线、fake adapter、不启服）和 L2（分段真实 run 的 checkpoint）；统一包为 `checkpoint/`（§3），最小必需 5 个文件（meta/scenario/tasks/events/expected-events），L2 再加 world/tool-calls/memory/segment-report。
- 回放**只消费录制数据 + 断言**，不依赖模型/网络/服务器；先做 `shelter-3x3`、`collect-resource`、`auto_defense` 三条 L1。
- 所有字段带 `schemaVersion`；事件保持 `{seq,at,type,data}` 信封，新增字段只加不改。

---

## 1. 现状（local3）

- body 事件信封：`{"seq":1,"at":1793948745254,"type":"join","data":{...}}`；`seq` 单调、`at` epoch ms。
- path 事件当前（`mineflayer.mjs`）：
  - `path_stuck { target:{x,y,z}, distance, pathResets, attempts }`
  - `path_recovered { target, attempts, pathResets, distance }`
  - `path_approximate { target, distance, range, tolerance, pathResets }`
- local3：`path_stuck 65`、`path_approximate 75`、`path_recovered 17`；但**没有 task kind / 目标类型 / 失败原因**，所以不能拆开“shelter 失败导致走位”与“寻路本身失败”（见 forensics §3）。
- task/ledger：`tasks.json`（version 3）含 `id/kind/params/state/result/error/...`、`home`；足够做 L1 的 task 重放。

---

## 2. `path_stuck v2` 埋点建议（不实现）

### 2.1 目标 schema

```json
{
  "schemaVersion": 2,
  "type": "path_stuck",
  "seq": 1234,
  "at": 1793953603367,
  "taskId": "t-104",
  "taskKind": "shelter",
  "taskStage": "repair|walls|roof|goto|return|combat|collect|explore|home",
  "data": {
    "purpose": "shelter:repair|collect:mine|return-to-safe|combat:chase|explore|home",
    "target": { "x": 27, "y": 76, "z": -53 },
    "targetKind": "block|entity|position|home|door|bed",
    "targetName": "dirt|oak_log|zombie|null",
    "goalRange": 1.5,
    "targetDistance": 3.6,
    "bestDistance": 2.8,
    "attempts": 6,
    "pathResets": 2,
    "reason": "no-path-precheck|timeout|stalled-no-progress|blocked-by-wall|blocked-by-liquid|target-in-wall|unreachable-height|target-moved|carve-failed|recovery-exhausted|aborted|cancelled|interrupted|task-timeout|unknown",
    "precheck": { "status": "unknown|reachable|noPath", "ms": 450 },
    "recovery": { "repath": 2, "jump": 1, "backoff": 1, "carve": 0, "giveup": true },
    "timing": { "startedAt": 1793953590000, "durationMs": 12000, "lastProgressAgoMs": 4200 },
    "context": {
      "position": { "x": 21.4, "y": 73, "z": -54.5 },
      "onGround": true,
      "feet": "air", "head": "air", "below": "grass_block",
      "inWater": false, "inLava": false,
      "dangerBlocks": [],
      "health": 19.6, "food": 17,
      "nearbyHostiles": { "count": 0, "nearest": null },
      "paused": false, "defenseActive": false,
      "dimension": "overworld", "timeOfDay": 6000
    },
    "error": { "name": "PathStuckError", "message": "no-path: 走不过去…" }
  }
}
```

### 2.2 字段来源（可直接映射现有代码）

| 字段 | 来源 | 说明 |
|---|---|---|
| `seq/at/taskId/taskKind` | body 事件信封 + `current` | 由 body 侧 enrich（adapter 不知道 task 时也允许 null） |
| `purpose/targetKind/targetName` | 调用点参数 | `gotoWithRecovery` 增加 `context` 参数；collect/mine/shelter/return/combat 分别传 |
| `goalRange` | `params.range` | 目标容差 |
| `targetDistance` | `lastDistance` | final 距离 |
| `bestDistance` | tracker best | 记录最好距离，判断“有没有进展” |
| `attempts/pathResets` | 现有 `gotoWithRecovery` | 保留 |
| `reason` | 代码分支 | 见 §2.3；不在分支处猜 |
| `precheck.status` | `pathCheck` 结果 | 现在 noPath 只发 `path_precheck`；并入 stuck 的 reason |
| `recovery.*` | `recoveryStep` 各阶段计数 | 明确“卡在哪种恢复” |
| `timing.*` | 进入 goto 时间/最后进度 | 区分 timeout vs stalled |
| `context.*` | `currentPosition`/`blockAt`/status | 只读；不引入新依赖 |
| `error.*` | 最终抛错 | 与 `error.result` 对齐 |

### 2.3 `reason` 枚举（必须单选，不要用自由文本）

- `no-path-precheck`：A* 明确无路（`pathCheck.status === 'noPath'`）
- `timeout`：超过 `timeoutMs` 仍未到达
- `stalled-no-progress`：`stallMs` 内 bestDistance 不改善
- `blocked-by-wall`：1×2 通道/墙挡住，carve 也失败
- `blocked-by-liquid`：目标/路径在水/岩浆边，禁止挖
- `target-in-wall`：target 本身是实心块/在方块里（常见于放方块目标传错）
- `unreachable-height`：target 高于/低于可达范围（y 差）
- `target-moved`：entity 目标移动/方块被挖/门被关
- `carve-failed`：`carveStepAhead` 返回 false
- `recovery-exhausted`：recovery 阶梯走完
- `aborted` / `cancelled` / `interrupted` / `task-timeout`：信号/任务级终止
- `unknown`：兜底（必须统计占比，>5% = 埋点不完整）

### 2.4 派生指标（回放/报告直接用）

- `path_stuck/task_started`，按 `taskKind` 分桶（shelter/collect/goto/return/combat/explore）。
- `reason` 分布、`targetKind` 分布、距离桶（`<2/2-3/3-5/5-8/>=8`）。
- `path_recovered / (path_stuck + path_recovered)`：恢复率。
- `time-to-recover`（last sound → recovered）。
- `stuck → task failed/retry` 转化率；`stuck → 人工/自动策略变化`。
- `unknown reason` 比例 gate：≤5%。

### 2.5 埋点验收

- 同一场景 `shelter`：`path_stuck` 的 `taskKind`/`purpose` 100% 非空；
- 任一 stuck 事件 `reason` 非空且属枚举；
- `targetKind`/`goalRange`/`attempts` 100% 存在；
- 回放断言可区分 `reason=target-moved` 与 `blocked-by-wall`（不再只看 distance）。

> 实现建议（后续，不是本任务）：在 `gotoWithRecovery` 增加 `pathContext` 参数（taskId/kind/purpose/targetKind/name），在既有 `path_stuck` emit 处按分支填 `reason`；body 的 `ingest`/事件落盘负责补 taskId。**不改现有字段语义**，只加字段。

---

## 3. 回放/checkpoint 输入格式

### 3.1 目录最小包

```
checkpoint/<segmentId>/
  meta.json              # 必需（L1/L2）
  scenario.json          # 必需（L1/L2）
  tasks.json             # 必需（L1/L2；L2 = body ledger）
  events.jsonl           # 必需（L1 断言/L2 证据）
  expected-events.json   # 必需（L1 断言）
  tool-calls.jsonl       # L2/transcript replay 可选
  world.json             # L1 结构验收/动作模拟必需；L2 可引用 world/ 快照
  memory.json            # L2 记忆验收可选
  segment-report.json    # L2 必需；L1 可选
```

**L1 最小集**：`meta + scenario + tasks + events + expected-events (+ world 若需结构验收)`。
**L2 额外**：`world/` 或 `world.json`、`tool-calls.jsonl`、`memory.json`、`segment-report.json`。

### 3.2 `meta.json`

```json
{
  "schemaVersion": 1,
  "runId": "e2-20261106-local3",
  "segmentId": "s0001",
  "createdAt": "2026-11-06T08:00:00.000Z",
  "phase": "L1|L2",
  "source": "real|replay",
  "commits": { "body": "51c58bc", "mcLink": "...", "mcLab": "..." },
  "versions": { "node": "26", "minecraft": "1.21.4", "body": "mc-body/v1", "mcLink": "..." },
  "model": { "provider": "local|coder390", "name": "...", "temperature": 0 },
  "world": {
    "levelName": "bodyworld",
    "seed": 0,
    "dimension": "overworld",
    "timeOfDay": 6000,
    "weather": "clear",
    "difficulty": "easy",
    "snapshot": "../world/s0001"     // L2 可选
  },
  "clock": { "startAt": 1793948745254, "stopBeforeMs": 1800000 },
  "scenarioIds": ["shelter-3x3"],
  "limits": { "maxDeaths": 6, "maxSteps": 2000, "maxWallMs": 3600000 },
  "freeze": { "name": "MC-FREEZE-2026-11-06", "approvedBy": "lead" }
}
```

### 3.3 `scenario.json`

```json
{
  "schemaVersion": 1,
  "id": "shelter-3x3",
  "description": "平地、给 27 dirt，命令 shelter size3 height3，验收结构+home",
  "setup": {
    "position": { "x": 0, "y": -60, "z": 0 },
    "health": 20, "food": 20,
    "inventory": { "dirt": 27, "oak_door": 1 },
    "inventoryPolicy": "exact|minimum|preserve",
    "timeOfDay": 6000, "weather": "clear", "difficulty": "easy"
  },
  "taskSequence": [
    { "id": "t-1", "kind": "shelter", "params": { "size": 3, "height": 3, "material": "dirt" } }
  ],
  "threats": [
    { "atMs": 5000, "action": "summon", "entity": "zombie", "distance": 4 }
  ],
  "stopRules": {
    "maxDeaths": 1, "maxRepeatToolCalls": 2, "maxSayPerHour": 2,
    "maxShelterFailStreak": 2, "maxPathStuck": 5
  },
  "acceptance": {
    "taskId": "t-1", "terminal": "done",
    "verify.ok": true, "entryOk": true, "home": true
  }
}
```

### 3.4 `tasks.json`（body ledger）

沿用 `tasks.json` v3：

```json
{
  "version": 3, "savedAt": 1793954156498, "home": { "center": {"x":0,"y":-60,"z":0}, "size": 3, "height": 3 },
  "tasks": [
    { "id": "t-1", "kind": "shelter", "params": { "size": 3, "height": 3, "material": "dirt" },
      "state": "done", "result": { "verify": { "ok": true }, "entryOk": true },
      "error": null, "createdAt": 0, "startedAt": 1, "finishedAt": 2 }
  ]
}
```

必需 task 字段：`id/kind/params/state/result/error`；可选：时间戳、progress、cancelReason。L1 必须保留**失败任务**（不能只留 done）。

### 3.5 `events.jsonl`（body 事件）

每行一个事件，保持现有信封：

```json
{"seq": 1, "at": 1793948745254, "type": "join", "data": {}}
{"seq": 2, "at": 1793948745261, "type": "spawn", "data": {"position": {"x": 0, "y": -60, "z": 0}}}
{"seq": 3, "at": 1793948745262, "type": "task_started", "data": {"task": {"id": "t-1", "kind": "shelter", "state": "running"}}}
```

**L1 断言至少覆盖的事件类型**：`task_queued/started/progress/done/failed/cancelled/interrupted`、`shelter_done/shelter_incomplete/shelter_place_fail`、`home_set`、`auto_defense`、`task_cancelled_for_defense`、`path_stuck/path_recovered`、`death`、`health`、`chat_sent`、`macro_done`。
新增字段只能加在 `data` 内；`seq` 单调、`at` 非递减；`type` 用 snake_case。

### 3.6 `expected-events.json`（L1 断言格式）

```json
{
  "schemaVersion": 1,
  "taskAssertions": [
    { "taskId": "t-1", "kind": "shelter", "terminal": "done", "error": null,
      "result": { "require": ["verify", "entryOk", "home"], "verify.ok": true, "entryOk": true },
      "events": ["task_done", "shelter_done", "home_set"] }
  ],
  "eventAssertions": [
    { "type": "auto_defense", "where": { "taskCancelled": true }, "min": 1 },
    { "type": "task_cancelled_for_defense", "where": { "kind": "mine" }, "min": 1 },
    { "type": "path_stuck", "where": { "taskKind": "shelter" }, "min": 0 }
  ],
  "forbidden": [
    { "type": "home_set", "when": "verify.ok != true" }
  ]
}
```

匹配语义：`terminal/error` 精确；`result.require` 只检查存在；`result.<path>` 精确；`events` 为必须出现（不要求顺序）；`min` 默认 1；`forbidden` 命中即 FAIL。拒绝通配/正则（避免回放脆弱）。

### 3.7 `tool-calls.jsonl`（L2/transcript replay）

```json
{"seq": 1, "at": 1793948800000, "callId": "c-1", "tool": "mcb_shelter",
 "args": {"size": 3, "material": "dirt"}, "result": {"ok": true, "taskId": "t-1"}, "isError": false}
{"seq": 2, "at": 1793948810000, "callId": "c-2", "tool": "mcb_status",
 "args": {}, "result": {"text": "...", "data": {"paused": false}}, "isError": false}
```

- `tool` 用 mc-link 工具名；`args` 原样（脱敏）；`result` 可裁剪，但至少 `ok/taskId/error`。
- L1 `task-replay` 不依赖此文件；L1 `tool-replay` 用它驱动 fake adapter/mc-link stub。

### 3.8 `world.json`（L1 结构验收/动作模拟）

```json
{
  "schemaVersion": 1,
  "dimension": "overworld",
  "region": { "min": { "x": -8, "y": -64, "z": -8 }, "max": { "x": 8, "y": -56, "z": 8 } },
  "blocks": [
    { "x": 0, "y": -61, "z": 0, "name": "grass_block" },
    { "x": 1, "y": -60, "z": 0, "name": "air" }
  ],
  "entities": [],
  "note": "稀疏快照：未列出的坐标按 air；L1 verify 用 blockNameAt(local) 读取"
}
```

- 体积控制：只存 region；`air` 可省略；结构验收需要的区域 ≤ 16×16×8。
- L2 用真实世界快照目录；`world.json` 可作为导出/回放输入。

### 3.9 `memory.json`（L2 可选）

```json
{
  "schemaVersion": 1,
  "sampleAt": 1793954156498,
  "recall": [
    { "query": "家在哪", "hits": [{"kind": "home", "center": {"x":0,"y":-60,"z":0}}] }
  ],
  "skills": [
    { "id": "shelter-3x3", "verified": true, "evidence": "home_set+verify.ok" }
  ],
  "forbidden": ["未注册技能", "未验收 home"]
}
```

### 3.10 `segment-report.json`（L2 指标）

```json
{
  "schemaVersion": 1,
  "segmentId": "s0001",
  "metrics": {
    "deathsPerHour": 0,
    "shelterCompletionRate": 1,
    "shelterVerifyCompleteRate": 1,
    "pathStuckPerTask": 0.1,
    "repeatToolCallMax": 1,
    "sayPerHour": 2,
    "stepToToolP95Ms": 8000
  },
  "verdict": "PASS|FAIL",
  "failures": []
}
```

---

## 4. L1 回放执行语义（设计，不实现）

### 4.1 `task-replay`（推荐先做）

1. 读 `meta/scenario/tasks/events/world`；
2. 起 **fake adapter**：`status()`/`blockAt()` 从 `world.json` 读；`runTask()` 按 `expected-events.taskAssertions` 的 terminal/result 返回（不是真跑物理）；
3. 按 `scenario.taskSequence` 逐条 `body.createTask(...)`，每次等终态；
4. 对每条 task 断言 `tasks.json` 中同 id 的 `state/error/result` 与 `expected-events`；
5. 对事件断言：`events.jsonl` 与期望事件的交并；可选“重放 body 事件到 fake sink 回放断言”；
6. 输出 `replay-report.json`（PASS/FAIL/diff），**不启 MC**。

### 4.2 `tool-replay`（L1 进阶）

1. 读 `tool-calls.jsonl`，按 `seq` 逐条调 mc-link 的工具 handler（stub body）；2. 记录工具 result 与 body 事件；3. 对比 `tool-calls` 里录制的 result/event 断言；4. 重点覆盖 `mcb_shelter` 失败回执、`mcb_combat`/`mcb_attack`、`mcb_status` 字段，不验物理。

### 4.3 断言/失败处理

- 回放失败先归因：**契约/字段不一致（代码回归）** vs **录制数据不完整**；前者 FAIL，后者标记 INVALID（不误报）。
- 不比较时间/顺序（除 `seq` 单调）；不比较随机种子未固定的世界。
- 同一 checkpoint 必须可重复跑出同结果（fake adapter 无随机；若需随机，用 `meta.seed`）。

## 5. L2 分段 checkpoint 规则（补充 §11.2）

- 每段开始/结束/硬 stop 前自动 checkpoint（至少 meta/tasks/events/expected-events）；
- 段长 30–120min；每段写 `segment-report.json`，gate 通过才继续；
- checkpoint 必须带 `commits/world.seed/model`，否则不可对比；
- 世界快照优先“区域快照”（16×16×8 或 spawn 周围），全服备份只在大节点；
- 回放只读 checkpoint，不修改原始 `state/`。

## 6. 最小落地顺序（后续，不是本任务）

1. body 事件加 `path_stuck v2` 字段（先加字段，不改判定）；
2. 从 local3 选 1 个 shelter failed + 1 个 collect no-resources + 1 个 auto_defense 场景，手工做 3 个 `checkpoint/` L1 包；
3. 写 `tools/replay-checkpoint.mjs`（仅离线，fake adapter；不新增 MC 工具/不改业务）；
4. 用 L1 包跑门禁：字段缺失/断言失败先修契约；
5. 再做 L2 分段，最后才讨论 24h。

> 以上均为格式/流程设计；冻结期不改 body 功能、不跑 MC、不启服。若 mc-lab 需要，我可以按本格式把 local3 的一个 shelter 场景转成示例 checkpoint 目录（仍不跑 MC）。
