# MC 战斗 / 自动躲避（MC-COMBAT）

> 用户反馈（2026-11-06）：“她无法杀死任何生物” + “实测完全没有遇到危险生物时的自动躲避”。本文定义战斗任务与自动躲避语义，并给出 E2 里为什么没躲避的证据。

## 0. 结论（TL;DR）

- **之前的问题不是“反射坏了”，而是“没有主动敌对检测/没有战斗能力”**：body 的 watchdog 只在**低血/危险方块/低氧**时触发 `safetyStop`→`emergency`，暂停期 `reflex` 才会检测附近敌对；**未暂停时没有任何“敌对近身就规避”的 watchdog 路径**，也没有追杀/防守任务。E2 证据见 §4。
- 本次新增：
  1. **战斗任务** `task kind: hunt|defend|flee|guard`（可取消、有 progress、危机自动中断保命）；
  2. **自动躲避** `checkHostiles`（未暂停也生效；敌对近身→有界 `emergency`；贴脸苦力怕/残血→升级为安全暂停 + alarm）；
  3. 战斗/躲避的纯逻辑（`src/combat.mjs`）+ 单测；mc-link 侧工具/技能由 mc-link 接。
- **真服战斗验证待 E2 结束**（不在 54838 上测）：起独立 dev 服 + summon 怪 → 验证 hunt 一只怪、苦力怕接近时 flee。

## 1. 战斗任务（body task kind）

| 模式 | 语义 | 成功判据 | 失败码 |
|---|---|---|---|
| `hunt` | 追最近敌对（或指定 target）直到击杀 | 目标实体消失且攻击次数≥1 | `no-target` / `target-lost` / `timeout` / `aborted-danger` |
| `defend` | 在半径内清怪；没怪时原地扫描到 duration | duration 结束（无怪）或击杀 | 同上 |
| `guard` | 守点：怪进入半径就打，不追远 | duration 结束（可攻击不中断打断） | `no-target`? guard 不因没怪失败；`timeout` 只在 duration 结束（按成功） |
| `flee` | 远离最近威胁到安全距离 | 威胁距离 ≥ safeDistance 或附近无威胁 | `cornered`（被卡住）/`timeout`/`aborted-danger` |

### 参数（均可选）

```json
{
  "target": "nearest_hostile | zombie | skeleton | creeper | …",
  "radius": 16,             // 搜索半径（4–32）
  "attackRange": 3,         // 2–4
  "lostTargetMs": 10000,    // 目标消失多久算丢（1–60s）
  "maxDurationMs": 60000,   // 5–300s（guard 默认 120s，flee 30s）
  "lowHealth": 10,          // ≤ 此血自动中断保命
  "maxHostiles": 3,         // 附近敌数 ≥ 此值自动中断
  "creeperDistance": 5,     // 苦力怕 ≤ 此距离自动中断
  "safeDistance": 24,       // flee 的安全距离（8–48）
  "autoTool": true          // 自动换武器（剑>斧，按材质等级）/盾（off-hand）
}
```

### progress / 结果 / 事件

- progress：`{mode, state:'acquired|chase|attack|flee|scanning', target, targetHealth, distance, attacks, health, hostiles, durationMs}`。
- done result：`{mode, killed, target, attacks, durationMs}`（flee：`{fled, reason:'safe'|'no-threat', distance}`；guard/defend：`{attacks, reason:'duration'}`）。
- 事件：`combat_abort {mode,target,reason,hostiles,health}`、`combat_done {...}`。
- 取消：任务级 cancel（body 状态机已有）；低血/多敌/苦力怕近身由任务自己 `abort` 并先跑一次 `emergency`。

### 危机中断优先级

`low-health` > `creeper-near` > `too-many`。中断时：`combat_abort` 事件 → `emergency('combat-<reason>')`（有界保命）→ `task_failed('combat: <reason>')`，附 `suggestion`（先吃/躲/垫高/改用 flee）。**hunt 不会硬拼到死**。

## 2. 自动躲避（body watchdog，未暂停也生效）

- 每个 watchdog tick（默认 2s）调 `checkHostiles(status)`：
  - 来源：`adapter.status().nearbyHostiles`（zombie/skeleton/creeper/spider/witch/phantom/slime/… 等，半径 8）。
  - 评估（`threatAssessment`）：
    - 苦力怕 ≤ `defenseCreeperDistance`（默认 6）→ `creeper-near`（critical）
    - 任一敌对 ≤ `defenseThreatDistance`（默认 6）→ `threat-near`
    - 该范围内敌数 ≥ `defenseMaxHostiles`（默认 3）→ `too-many`
    - 血量 ≤ `lowHealth`（默认 10）→ `low-health`
  - 行为：
    - **critical（苦力怕贴脸 ≤4 或残血）** → `safetyStop('threat')`：暂停 + alarm 穿透通知 + reflex 保命（之后由 reflex 持续处理）；
    - **非 critical** → `runAutoDefense`：有界调用 `adapter.emergency('auto-defense')`（吃/后退/逃离威胁/回安全点），**不打断当前任务**；事件 `auto_defense {reason,assessment,action,durationMs}`。
  - 限频：`defenseCooldownMs=8s`、`defenseMaxPerMinute=3`；被限频记 `defense_suppressed`。
- 暂停期间：`checkReflex`（已有）检测 `nearbyHostiles` 并调用 `emergency`（reason `threat-near`），不重复跑 autoDefense。
- 战斗任务运行中：跳过 autoDefense（任务自己负责危机中断）。
- `status.safety.autoDefense` / `lastDefense` 暴露开关、次数、最近一次动作；结构化快照也带。

## 3. 配置（body）

| 选项 | 默认 | 说明 |
|---|---|---|
| `autoDefense` | `true` | 关掉就只剩暂停期 reflex |
| `defenseThreatDistance` | 6 | 敌对近身阈值 |
| `defenseCreeperDistance` | 6 | 苦力怕阈值（critical 判定用更小 4） |
| `defenseMaxHostiles` | 3 | 多敌阈值 |
| `defenseCooldownMs` | 8000 | 两次自动躲避最小间隔 |
| `defenseMaxPerMinute` | 3 | 每分钟上限 |
| `reflex*` | 见暂停语义 | 暂停期反射（低血/威胁/危险方块/低氧） |

## 4. E2 证据：为什么 12+ 次死亡没有躲避

E2 run：`.state/lab/e2-20261106-smoke`（phase=stopping 时读取；13 death）。

- body 事件计数（body.jsonl）：`safety_stop 84`（low-health 53、death 13、leave 6、low-oxygen 5、disconnect 2、health-drop 5）、`emergency 76`（low-health 62、threat-near **4**、low-oxygen 5、leave 2、health-drop 3）、`reflex 35`（low-health 29、threat-near **4**、low-oxygen 2）、`death 13`、`alarm_suppressed 664`。
- **没有 `auto_defense`/主动 threat watchdog**（此前不存在该路径）。
- 最后一次死亡前后（body.jsonl）：
  - `health 1.47` → 约 3s 后 `health 0` → `death @ 32.9,68,-43`；
  - 死亡前后只有 `health`/`alarm_suppressed`（低血告警 15s 去重）事件；**`emergency threat-near` 与 `reflex threat-near` 出现在死亡之后**（phantom 5.6m）。
- 结论：
  1. **未暂停时没有敌对检测**：只有低血才 `safetyStop`→`emergency`，那时已来不及；
  2. **暂停期 reflex 有 threat-near**（4 次），但只在被打到低血/暂停后才触发；一次有界 emergency 后任务/身体恢复，不会持续逃离/反击；
  3. **没有战斗能力**：无法主动清除威胁，creeper 近身也无法处理；
  4. alarm 去重（15s）会让重复低血告警合并（设计如此，不是根因；根因是检测缺失/太晚）。
- 修复后：同样的“怪靠近”会先触发 `auto_defense`（远早于低血）；贴脸苦力怕直接 safetyStop+alarm+reflex；模型可下 `hunt/flee` 任务主动处理。

## 5. 失败码（task_failed.error）

| 码 | 含义 | 下一步 |
|---|---|---|
| `combat: no-target` | 半径内没目标（15s） | 换 target/换地方/scan |
| `combat: target-lost` | 目标消失超过 lostTargetMs 且未攻击 | 重新 hunt 或 scan |
| `combat: aborted-danger` | 低血/苦力怕/多敌 | 已自动保命；先补血/换 flee/清落单 |
| `combat: timeout` | duration 到没打死 | 换武器/找落单/补给 |
| `flee: cornered` | 被地形/围住逃不掉 | 垫高/挖坑/先清路 |
| `flee: timeout` | 没跑到 safeDistance | 继续跑/换方向 |

## 6. 验收标准

1. **单测**（已过）：敌对识别/威胁评估/中断判据/武器选择；body auto-defense 触发、冷却、暂停时走 reflex、战斗任务不抢自动躲避、hunt KINDS 接受。
2. **真服（E2 结束后独立 dev 服）**：
   - 下 `hunt {target:'nearest_hostile'}`：追到并击杀一只怪；progress 有目标/距离/攻击数；cancel 能中断；
   - 故意低血/引 3 只怪/苦力怕近身：任务 `aborted-danger` 且先做 emergency；
   - 不放任务、站怪旁：未暂停时出现 `auto_defense` 且位置明显远离威胁；苦力怕贴脸 → `safety_stop(reason=threat)` + alarm；
   - 暂停时敌对近身：reflex `threat-near` 触发（E2 已证 4 次）；
   - 0 新增“站着被打到死且无任何 auto_defense/reflex”的场景。
3. **模型侧**：mc-link 暴露 `mcb_combat`/`mcb_attack`，`mcb_status` 显示敌对列表；skills 写“打架/逃跑/中断”。
4. **风控**：自动躲避不连续追击/不生成新目标；限频 ≤3/min；不打断普通任务除非 critical；暂停语义（alarm 穿透）不变。

## 7. 状态

- [x] `src/combat.mjs` 纯逻辑 + 单测
- [x] adapter `hunt/defend/flee/guard` 实现（剑/斧/盾/吃、追击、危机中断、progress、cancel）
- [x] body `checkHostiles` 自动躲避 + critical 升级 + 限频 + status/快照
- [x] 单测（65/65 mc-body 绿）
- [ ] 真服战斗验证（E2 结束后独立 dev 服；需 summon 怪/夜晚/苦力怕场景）
- [ ] mc-link 工具 `mcb_combat`/`mcb_attack`、`mcb_status` 敌对列表、`skills/combat.md` 注册

## 8. P0 修复：attack 假成功 / 暂停死锁 / 长动作（2026-11-06 用户现场）

### 8.1 attack 假成功（已修，真服验证）

- **根因**：`resolveEntity` 收到字符串 target 时被当成 `nearest`，把地上 `item` 当目标；`bot.attack` 之后不校验是否真的受伤 → `{"attacked":"chicken"}` 假成功；另有 `bot.entities` 为 null 时未防护。
- **修**：
  - target 支持字符串：`chicken` / `nearest` / `nearest_hostile` / `nearest:villager`；攻击路径**排除掉落物/投射物/载具/展示框**（`NON_ATTACKABLE`）；
  - 攻击前检查距离（>maxRange 4.5 直接报“太远”）；攻击后监听 `entityHurt`（adapter 持久记录）**验证真实受伤**；没受伤 → `attack: 没打中 …`（不再假成功）；目标消失 → `killed:true`；
  - 结果带 `hit/killed/damage/healthBefore/healthAfter`；`bot.entities` null 有可读错误。
- **真服证据**（`.state/lab/mc-combat-poc/run6/result.json`）：
  - 攻击鸡：第 1 下 `{hit:true,killed:false}`；第 2 下 `{hit:true,killed:true}`；第 3 下 `attack: 找不到可攻击目标（已排除掉落物/投射物）`（不再空挥/锁掉落物）；pickup 正常。
  - `hunt` 僵尸：**done `{killed:true, attacks:5, durationMs:6628}`**，结束血 11。

### 8.2 暂停/恢复死锁（已修，真服验证）

- **根因**：低血 `safetyStop('low-health')` 后 resume，健康仍 ≤10 → 下一 watchdog tick 立刻再次暂停；无宽限/冷却/恢复动作 → resume→pause 忙等（E2 里 38 次 resume、5 连 `身体已暂停(low-health)`；血 0/20 饥饿 0/20）。
- **修**：
  - **resume 宽限 3s**（`resumeGraceMs`）：resume 后 3s 内低血不再次暂停（除非 ≤ criticalHealth=4）；
  - **低血暂停冷却 8s**（`lowHealthPauseCooldownMs`）：暂停后 8s 内低血只记 `recover_grace`，不反复暂停；
  - **暂停中允许 `eat`**（SAFE_WHILE_PAUSED）：能自己吃回来；`stop/cancel/look/tasks` 也可用；
  - 状态暴露 `safety.recovery{resumeGraceMs,lowHealthPauseCooldownMs,criticalHealth,resumeGraceUntil,lowHealthPauseCooldownUntil,pausedRecoverable}`；错误文案提示“低血可先 eat/等回血，resume 后有 3s 宽限”。
- **真服证据**（run4）：`damage 12` → paused(low-health, health 9.5)；resume 后 700ms **paused=false**、health 回升 10.33（未立刻被按回去）；recovery 字段正确。

### 8.3 战斗任务低血阈值

- 战斗任务自带 `params.lowHealth`（默认 10）；body 全局低血暂停阈值对战斗任务改为 **任务阈值-1**，让任务先自行 `combat_abort`（带原因/保命）而不是被 body 直接 interrupt。
- 真服：`hunt lowHealth=5` 僵尸在 6.6s 内击杀（血 11），未触发暂停。

### 8.4 长动作预算（pickup/craft）

- `pickup`：总预算 `maxMs`（默认 20s，可调 3–60s），超时返回 `partial:true` + `durationMs`，不再一次阻塞 45s+。
- `craft`：总预算 `maxMs`（默认 30s，3–120s），超时置 `craftError` 并走 `partial` 文案（带已完成批次数），不吞材料/不无限等。
- 两者都是 `mcb_do` 单步；长任务仍建议走 `task`（不阻塞请求）。

### 8.5 自动躲避真服验证（run4）

- 空闲 + 僵尸 4 格：`auto_defense {reason:'threat-near', action:'flee-threat', durationMs:1215}`，位置移动 **6 格**，未暂停任务。
- 暂停中低血 + 苦力怕近身：`safety_stop {reason:'threat'}` + `reflex low-health`（alarm/pierce）。
- 静止被围仍可能死亡（无法保证 100%），但现在会先规避/报警/可逃跑反击，不会“站着被打到死且无事件”。

### 8.6 真服验证汇总（54839 独立 dev 服；E2 已结束）

| 场景 | 结果 | 证据 |
|---|---|---|
| attack 鸡（真服） | 第 1 下 `{hit:true,killed:false}`；第 2 下 `{hit:true,killed:true}`；第 3 下正确报 `找不到可攻击目标（已排除掉落物/投射物）`；pickup 正常 | `run6/result.json` |
| hunt 僵尸（铁剑） | **done `{killed:true, attacks:5, durationMs:6628}`**，结束血 11 | `run6/result.json` |
| flee 僵尸（safeDistance 24） | **done `{fled:true, reason:'no-threat', flees:3, durationMs:21119}`**，威胁曾接近 2.8 格但逃开 | `run7/result.json` |
| 自动躲避（空闲+僵尸 4 格） | `auto_defense {reason:'threat-near', action:'flee-threat', durationMs:1215}`，位移 **6 格**，未暂停 | `run4/result.json` |
| 苦力怕近身 | `safety_stop {reason:'threat'}` + reflex（alarm/pierce） | `run4/result.json` |
| 低血暂停→resume | resume 后 700ms 仍 `paused=false`、health 9.5→10.33；`recovery` 字段正确 | `run4/result.json` |

所有真服测试用 54839 独立 dev 服（server.jar 本地、停止后无监听）；未碰 54838（E2）与用户客户端；54841 有他人服务器未触碰。

## 自动躲避与任务取消（2026-11-06，本地 24h 修复）

- **danger 时不再“只逃不取消任务”**：`checkHostiles` 在非 critical 的 danger 判定下：
  - 当前任务若不是 `hunt/defend/flee/guard` → `cancelTask('auto-defense: threat')`，任务以 `cancelled` 结束、`error="auto-defense: threat"`；
  - 事件 `task_cancelled_for_defense {taskId, kind, reason, threats}`；
  - `auto_defense` 事件带 `taskCancelled:true / taskId / taskKind / taskCancelReason`；
  - **hold 队列 15s**（威胁持续时每次 tick 续 hold）：规避/冷却结束前不启动排队任务，避免“取消一个又立刻接下一个继续送”。
- 战斗任务自身的中断（combat_abort/危机）保留；critical（苦力怕贴脸/残血）仍升级 `safetyStop('threat')`。
- 真服证据：`.state/lab/mc-body-fix-poc/run2/result.json` —— `mine` 长任务 + 僵尸 3 格 → 任务 `cancelled/error=auto-defense: threat`，事件 `task_cancelled_for_defense` + `auto_defense.taskCancelled=true/taskKind=mine`。
