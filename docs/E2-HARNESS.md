
# E2 — 24h 半生产长测 harness 设计（wt/mc-lab）

> 状态：**设计 + 实现就绪，未启动**。启动前必须走 §2 的 gate（先通知用户/lead 安排）。
> 关联：`docs/LOOP.md`（lab/场景）、`docs/TIME.md`（作息）、`docs/MC-MACRO.md`（宏）、`docs/FIRST-SCREEN.md`（首屏）、night-1 早报（`.state/lab/night-1/morning-report.md`）。

## 1. 目标与非目标

**目标（E2）**
1. 让真实 ICL 受试会话连续 **24h** 在 MC survival 里生活：白天做事/采集/建造，按 `time` 作息睡/醒/dream，偶尔被 QQ 私聊介入；媒体工具（eyes/B站）就绪后加入"看视频/聊天"段。
2. **集成质量**（本轮重点）：观测"真实事件 → 记忆成块"的质量——recall 命中/噪声、dream wash/consume/index、记忆库增长/重复、事件丢失/重复、压缩/裁剪、事件→记忆延迟；发现模块问题**上报**（misc/lead），**不改记忆代码**。
3. 复用 night-1 的 supervisor/心跳/anomalies/validity 与 acc-* 验收脚本；24h 中断可恢复、可早停、早报可读。

**非目标**
- 不是产品 preset 改造；不改 memory/dream 实现（只观测 + 建议）。
- 不替代 acc-* 集成验收（每次集成后先跑 acc-awake/verify/cancel）。

## 2. 阶段与 gate（用户通知）

| 阶段 | 内容 | 时长 | 准入 |
|---|---|---|---|
| S0 集成验收 | `acc-awake --run acc-<ts>` + `acc-verify` + `acc-cancel`（宏/装备/首屏/sleep-safe/cancel） | ~20–40min | 新集成 commit 已合 master |
| S1 2h 冒烟 | `mc-e2 --phase smoke --hours 2`：完整链路 + 记忆质量采样 | 2h | S0 PASS + **用户已通知** |
| S2 24h soak | `mc-e2 --phase soak --hours 24`：官方半生产长测 | 24h | S1 无 P0 + **用户/lead 确认开始时间** |
| S3 媒体/QQ 扩展 | 加入 B站/eyes 段、QQ 私聊偶发介入 | 随 S2 | eyes 可用 + 用户同意 |

**Gate 文件**：`.state/lab/E2-GATE.json`
```json
{ "userNotifiedAt": "2026-11-06T20:00:00+08:00", "approvedBy": "lead", "phase": "soak-24h", "note": "用户已知晓开始时间" }
```
`mc-e2` 在非 `--dry-run` 启动前必须读到该文件且 `userNotifiedAt` 非空、`phase` 匹配；否则**拒绝启动**并打印"先通知用户/lead"。启动后第一行日志/发给 lead 的消息必须带 `started` + gate 时间。

## 3. 环境与资源（一人一份，互不踩）

- 服务器：**survival 54838**（`C:/DSH/icl/.state/mc-survival`，normal 地形；**用户可能以 Hahn123_ 进服观察**，bot 不 OP、不碰用户位置）
- bot：`ICL-e2-1`（新名字，避免与 night-1/验收冲突）；body 54902；lab 57101；model=local（0 成本，串行占根锁）
- 根锁：`C:/DSH/icl/.state/locks/llama.lock`（owner=mc-lab, runId=e2-<date>）
- 证据目录：`.state/lab/e2-<date>/`（events/transcript/metrics/strategy/anomalies/quality/checkpoint/morning-report）
- 资源原则：只在需要时起服/lab；跑完 `down` + 停服 + 释放锁；**不碰 desktop DSH / 用户 MC 客户端 / llama-swap**。

## 4. 组件

| 组件 | 作用 | 复用/新增 |
|---|---|---|
| `tools/mc-night.mjs` | supervisor：起服/lab、健康监控、turn 超时、熔断降级、checkpoint、早报 | 复用（加 `--run/--hours/--model/--mc-user/--server`） |
| `tools/mc-e2.mjs` | **新增**：phase 编排（smoke/soak）、gate 校验、起 supervisor + quality 监控、汇总报告、退出清理 | 新 |
| `tools/mc-quality.mjs` | **新增**：记忆质量监控（memory.db + dream-run + recall/eager/remember 事件 + 延迟/重复/压缩），写 `quality.jsonl` + `quality-summary.json` + 报告节 | 新 |
| `tools/acc-awake.mjs` / `acc-verify.mjs` / `acc-cancel.mjs` | 集成验收（S0），可随时复跑 | 复用 |
| `tools/lab*.mjs` | lab 生命周期/transcript/导出 | 复用 |

## 5. 记忆质量指标（可判据）

数据源：`state/icl-mc-lab/state/memory.db`（`mem_ns`/`mem_items`/`mem_vec`，`node:sqlite` 只读）、`events.jsonl`（tool/call+result、user/message、system/message）、`body.jsonl`（真实事件）、`time.json`、`transcript.md`、dream-run 行。
口径以 [MEMORY-BLOCK-QUALITY.md §4](MEMORY-BLOCK-QUALITY.md) 为准：**原料（day/log）与可回忆块（event/person/slang 的 block）分离**；dream job 按 `run:/fail:/skip:` 三态；consume 只算"备忘回收"；index 无嵌入记 `skipped:no-embed`；槽健康读 `icl.ready.slots.unmatched`（日志不可得时由 dream fail 行/模型 job 成功行推断，字段 `slots.source` 标注来源）。

| 指标 | 定义 | 告警阈值（可配） |
|---|---|---|
| `recall.calls` / `recall.emptyRate` | recall 调用数；结果文本判空（/没有|未找到|空/ 或 ≤8 字符）比例 | 调用≥5 且 emptyRate>0.6 |
| `recall.avgResultChars` / `noiseHits` | 结果平均字符；结果行中不含查询词的块比例（粗噪声代理） | avgChars<40 或 noiseHits>0.5 |
| `remember.calls` / `forget.calls` | 显式记忆写入/删除调用 | — |
| `eager.injections` / `eager.chars` | `<icl-context>` 注入次数/字符 | 有事件但 0 注入（kind 未命中）记 info |
| `dream.jobs[job].ran/skipped/failed` | 每 job 三态（`run:` / `skip:` / `fail:` 行；失败带 error） | 任一实际进入的 job 无三态行、或 `failed>0` |
| `mem.blockChars.p50/p95/p99` | **只统计可回忆块**（event/person/slang 的 `block`）字符分布 | p95 > 1200 或 p50 < 20（太碎） |
| `mem.rawMaterial` | `day/log` 原料条数/字符（**不计入块大小**；目标 ≤40k/条，待用户批分段落盘） | >40k/条 |
| `mem.vectors` / `slots.embedded` | 向量数 / 是否配置嵌入；无 embed 时 index 应 `skipped:no-embed`，不算失败 | 有 embed 但覆盖 <100% |
| `mem.growthPerHour` / `mem.items` / `mem.bytes` | mem_items 总数与增速（按 namespace/kind） | 增长 > 60 条/h 或 byte 增速异常 |
| `mem.dupRate` | 同 (namespace,kind,归一化文本) 重复行占比（全库） | >0.2 |
| `latency.eventToMemoryMs` | remember 调用 → 随后首个新 memory 行 created_at 差（p50/p95）；dream consume → 首个非 dream-run 行差 | p95 > 5min |
| `dream.memoRecycle` | consume 的 `written/archived`（**不计入成块**） | — |
| `dream.failures` / `failRows` / `skipRows` | 失败行数/明细、跳过行明细（三态修后应可见） | failures ≥1 标红 |
| `slots.unmatched` | 槽健康（`icl.ready` 或推断）；期望 `[]` | 非空 = dream 模型 job 会缺席 |
| `events.loss` / `events.dup` | body 事件行数 vs 记忆 event block/note 数（启发式）；同 seq 重复数 | 重复 seq >0 或覆盖率 <1 block/天 |

`quality.jsonl` 每行：
```json
{"at":"...","runId":"e2-...","mode":"live|offline","mem":{"items":N,"bytes":N,"byNs":{...},"growthPerHour":N,"dupRate":0.0,"blockChars":{"p50":..,"p95":..,"p99":..}},
 "dream":{"jobs":{...},"failures":0},"recall":{"calls":0,"emptyRate":null,"avgResultChars":null,"noiseHits":0},"eager":{"injections":0,"chars":0},
 "latency":{"eventToMemoryMs":{"p50":null,"p95":null}},"compaction":{"rows":0,"dropped":0},"events":{"bodyRows":N,"memoryEventBlocks":N,"dupSeq":0},"alarms":[]}
```
报告：先质量摘要（指标表 + 告警 + 3–5 个"记忆成块"样例：块文本截断/来源/时间），再给"模块定位与修法建议"（memory/dream/eager-recall 哪个环节 + 可能原因，附证据行）。

## 6. 集成质量 checklist（S2 早报必含）

1. 夜间/白天 recall 空结果率、命中噪声样例
2. dream 全 job 记录 + wash/consume/index 数字（对比 night-1：wash 1119 行/138779 字符、consume/index=0）
3. 记忆库增长曲线（按 ns/kind）、重复率、块大小分布
4. 真实事件 → 记忆成块的样例与延迟（含 MC 事件、人物、当天原话）
5. 压缩/裁剪（compaction / wash omitted / day log 截断）
6. 事件丢失/重复（含跨重启、跨天、dream 幂等）
7. 模块定位 + 修法建议（不改代码，报 misc/lead）

## 7. 运行手册

```powershell
# S0 集成验收（每次集成后）
node tools/acc-awake.mjs --run acc-<ts>          # 宏/装备/首屏/sleep-safe/awake-tick
node tools/acc-verify.mjs --run acc-verify-<ts>  # collect 等待版/首屏/tunnel cancel
node tools/acc-cancel.mjs --run acc-cancel-<ts>  # 严格 body cancel

# S1 2h 冒烟（gate 文件写好且用户已通知）
node tools/mc-e2.mjs --phase smoke --hours 2 --run e2-<date>-smoke --gate .state/lab/E2-GATE.json

# S2 24h soak
node tools/mc-e2.mjs --phase soak --hours 24 --run e2-<date> --gate .state/lab/E2-GATE.json

# 质量监控单独跑（离线复盘/在线）
node tools/mc-quality.mjs --dir .state/lab/e2-<date> --once
node tools/mc-quality.mjs --run e2-<date> --interval 60
```
中断恢复：`mc-e2` 检测到 runDir 已有 supervisor/存档，允许 `--resume`（adopt 现有 lab）；早停阈值复用 night-1（连续故障/预算/错误率）。退出时写 `e2-report.md`（supervisor 早报 + quality 报告节拼接）。

## 8. 已知风险 / 待集成

- **记忆成块**：night-1 数据显示 dream consume/index 长期 0、6 条记忆里 2 条 event/note；E2 重点观察"真实事件是否成块/是否太碎或重复"。
- eager-recall 在 night-1 0 次注入（kind 未命中）——E2 观察是否有 `<icl-context>` 及命中质量。
- eyes/B站、QQ 私聊尚未接；S3 等设备/工具可用 + 用户同意；QQ 只做偶发私聊介入，不发群。
- 产品 preset 首屏 purify 仍需用户批准（lab preset 已开）。

## 9. S2 24h soak 实施细则（2026-11-06 用户/lead 拍板）

- **主模型**：云端 `deepseek-flash`（用户已批准）；`--model flash`，不占本地 GPU。
- **preset**：`icl-mc-lab`（lab-only）+ 新调参：`time.awakeTick.idleSec=30`、`time.goalResumeMinGapSec=30`、`toolAllowlist`（mcb_* + time_status/time_arrange + remember/recall/forget/memo*）→ 工具面 48→~32。
- **supervisor**：`mc-e2 --phase soak --hours 24`（自动 `--terse-prompts --playbook-min 6 --playbook-idle-sec 90`，steer ≤10 条/2h）；quality 监控同跑。
- **场景（必须注入）**：
  1. 每 ~2h 一次"过去指代"消息（"你还记得昨晚为什么死那么多次？/上次小屋在哪？"）→ KPI：过去指代消息的 recall 调用率、返回块相关度。
  2. `hunt/flee`：夜间怪围攻触发 `mcb_combat {mode:'hunt'|'defend'|'flee'}`，验收击伤/击杀/逃跑、低血撤退、死亡数下降。
  3. `mcb_stop` 复验：surface 含 `mcb_stop`；stop→resume 断言（任务停/身体在世界/time pausedMode 开→关/危险穿透）。
  4. attack 真伤害：`mcb_attack` 对 mob 造成伤害并结算；自动躲避（creeper/hostiles 近身）验证。
  5. 第二轮记忆修复复验：cleanup 近重复合并（block 数减/merged+1）、evidence 去噪、eager 冷却、简报截断、segmented/degraded 语义。
  6. latency 指标：turn-gap p50/p95/max + 来源分类（awake-tick/supervisor/external/idle）；wait/tasks 次数；工具耗时 p50/p95 + >60s 告警。
- **gate**：起跑前写 `.state/lab/E2-GATE.json`（phase=`soak`，userNotifiedAt=通知时间，approvedBy=`user-standing-approval-2026-11-06`）；起跑即刻发 lead `started`（含 54838 地址），由 lead 转用户。
- **资源**：54838（survival）+ lab 57101 + body 54902；结束停服/关 lab/释放锁；coder390 保持不动（S2 主模型 cloud，dream 才短暂用 8088）。

## 10. MC 长跑检测机制（冻结后设计，不跑测试）

> 2026-11-06 用户决定暂停 MC 长跑；先固化验收清单/指标，再恢复。参考项目：Voyager（技能库/自动课程）、MineAnyBuild（分层建造/蓝图）、APT（蓝图规划/长程任务）、Mindcraft（agent 架构/工具接口）。

### 10.1 验收清单（先固定，不看实现）
- **生存**：deaths/hour ≤ 阈值（建议 ≤2/h；连续 3 起同因死亡 = FAIL）；夜间/低血必须进入庇护所或封洞；auto_defense 必须 cancel 非 combat 任务并有事件。
- **建造**：3x3 庇护所任务完成率 ≥80%；attempts/completion ≤2；必须产出 verify/entryOk/home_set；失败必须报缺哪一面/缺多少材料。
- **任务效率**：task_success_rate；path_stuck/task ≤1；repeat-identical-tool-call 连续 ≤2；单任务重试 ≤2。
- **对话**：MC 聊天消息/小时 ≤ 阈值（建议 ≤6/h）；同一 say 文本/小时 ≤2；同一句重复 3 次 = FAIL（进度播报式刷屏）。
- **延迟**：本地 step p95 记录实测（不追 cloud ≤3s）；turn-gap p95（immediate 模式 ≤2s，不含退避）；tool→assistant p95 ≤2s。
- **记忆/睡眠**：dream 7 job 三态、recall 场景命中、wake briefing 完整；shelter/home 坐标写入记忆。

### 10.2 长跑机制（先设计，后实现）
1. **重复动作熔断（supervisor 侧）**：连续 N 次相同 tool+args → 强制换策略/停任务；按"单位时间相同调用数"而不是单 turn 错误计数。
2. **聊天出口去重**：同一 say 文本 TTL 冷却（如 10min 内同句最多 1 次）；刷屏时抑制并记 anomaly，不阻断任务。
3. **庇护所/材料诊断闭环**：needs-material 后模型必须消费 deficit/alternatives；否则 supervisor 注入一次"先 dig 土再 shelter"并冷却。
4. **事件驱动而非轮询**：保留 immediate tick 但加 adaptive：有活跃 task/最近工具调用时 1s，空闲 30s。
5. **验收驱动 agent**：每个场景（shelter/combat/recall）带机器可验 acceptance（verify/entryOk/home、任务终态字段），不靠模型自述。
6. **外部研究计划（1–2 天调研）**：Voyager 技能库/课程、MineAnyBuild 分层蓝图、APT 长程规划、Mindcraft agent 架构；产出对照表：技能表示/验收/失败恢复/长跑监控。

### 10.3 研究问题
- 技能库如何表示/检索/组合（Voyager）→ 映射到 mcb_do 宏 + shelter/combat task；
- 分层建造如何做结构验收（MineAnyBuild）→ 映射到 mc-body building verify；
- 长程任务如何分解与恢复（APT）→ 映射到 goal/时间安排/记忆；
- agent 架构如何避免工具循环（Mindcraft）→ 重复熔断/冷却。


### 10.4 当事人第一人称证据（硬 gate，用户 2026-11-06 拍板）

> 原则全文：`docs/TEST-PRINCIPLES.md`。**受试会话的第一人称回复/抱怨/重复话/困惑是证据，不许只写 metrics。**

- **最低证据**：每个 run 必须保留 `transcript.md` + `events.jsonl`（assistant/message、user/message、tool/call/result），报告与回复都要能引用 seq/时间。
- **报告模板（顺序固定）**：
  1. **当事人原话**：≥3 条第一人称原话（带 seq + 时间），覆盖刷屏/重复、抱怨/困惑、死亡/暂停/卡住时的反应；P0/P1 结论每条至少 1 条原话或 seq。
  2. 结论/状态；
  3. metrics（turns/tools/deaths/turn-gap/shelter/宏占比…）；
  4. 证据路径与回滚/未知点。
- **重复即信号**：同一 say 文本 ≥3、同一工具参数 ≥3、反复问同一句/明显困惑 = 必须人工复核，不得当噪声过滤。
- **验收 gate**：没有"当事人原话"节 = 报告不完整，不得作为 PASS 依据；停止 run 前先确认 transcript/events 已落盘，再清资源（清理 workspace 不删 `.state/lab/<run>/`）。


# E2-HARNESS §10 补充稿：MC 长跑检测机制（mc-body 提案）

> 状态：**MC 长跑冻结（2026-11-06 16:45 HKT）**；本文只设计，不跑测试、不启服、不加工具。
> 定位：mc-lab 已在 [`E2-HARNESS.md §10`](../../mc-lab/docs/E2-HARNESS.md) 落了 10.1–10.3 的初版；本稿是 **mc-body 视角的可执行增强版**，供 lead/mc-lab 合入/替换原 §10。冻结依据见 mc-lab [`MC-FREEZE-2026-11-06.md`](../../mc-lab/docs/MC-FREEZE-2026-11-06.md)，证据见本仓 [`MC-LOCAL3-FORENSICS.md`](MC-LOCAL3-FORENSICS.md)、研究见 [`MC-RESEARCH.md`](MC-RESEARCH.md)。
> 原则：**先验收指标，再谈工具**；不新增 MC 工具/宏，不把“跑得更久”当目标。

## 11.0 核心判断

local3 的失败证明：24h 盲跑不能回答“她是否会生活/会建房/会记住”。它只能放大三个问题——材料失败循环（shelter 92 次尝试/90 败/0 home）、重复聊天（49+33 次同句）、寻路/长任务在坏状态下继续。恢复 MC 前，必须先有**机器可判的验收 + 可回放的分段检测**；否则只是把同样失败跑更久。

**检测对象**：一次 run 的“能力证据包”，不是“存活时长”。
**验收单位**：一个**任务卡（scenario）** + 一段**可回放 checkpoint**，而不是一整段 24h 的自然语言早报。

## 11.1 验收指标（先固定）

每条指标必须有：定义、数据源（事件/ledger/世界读取）、gate（PASS/FAIL）、采样窗口、是否可回放验证。**禁止用模型自述/聊天内容作为唯一证据**。

### A. 安全（硬 gate）

| 指标 | 定义/数据源 | Gate |
|---|---|---|
| 死亡/小时 | `death` 事件 / 运行小时 | ≤2/h；连续 3 起同因死亡 = FAIL |
| 危险规避有效性 | `auto_defense`、`task_cancelled_for_defense`、`safety_stop`、`reflex` | 有敌对威胁时必须产生规避事件；danger 时非 combat 任务必须被取消（`taskCancelled:true`） |
| 取消后重下率 | `task_cancelled_for_defense` → 60s 内同 kind 新 task 数 | ≤1；>1 = FAIL（说明 hold/策略无效） |
| 夜宿/庇护 | `home_set`/`shelter_done` 或安全封洞证据 | 夜间死亡/无庇护 = FAIL（按场景卡） |

### B. 结构/建造（任务卡级）

| 指标 | 定义/数据源 | Gate |
|---|---|---|
| 结构完成率 | `shelter` done / started（按 taskId 去重） | ≥80%（3×3 任务卡） |
| 验收完整性 | 每个 done 必须带 `verify.ok=true` + `entryOk=true` + `home` | 缺一 = FAIL |
| 首次通过率 | 第一次 shelter 尝试即 done 的比例 | 记录；P90 建议 ≥50% |
| 重试预算 | 同参数 shelter 连续失败/重试次数 | ≤2；超过触发 stop/换策略 |
| 失败可诊断率 | needs-material/no-site/incomplete 的 result 含 needed/have/deficit/缺失面 | 100% |
| 手动/宏一致性 | 任务卡成功是否来自宏（taskId/source），不是聊天自述 | 只认 taskId/verify |

### C. 任务/效率

| 指标 | 定义/数据源 | Gate |
|---|---|---|
| task_success_rate | done / started（按 kind 分桶） | 记录；P0 场景各自 gate |
| 重复动作率 | 连续相同 tool+args（跨 turn 聚合） | 连续 ≤2；>2 = FAIL/熔断 |
| path_stuck/task | `path_stuck` / task_started（按 kind 分桶） | ≤1；>1 需定位 kind/目标类型 |
| 失败后转化率 | 失败→下一次不同参数/不同任务的成功率 | 记录；无转化 = 策略 FAIL |
| 资源枯竭处理 | `collect: no-resources` 后是否 explore/换 item | 100% 有下一步，不原地重试 |

### D. 延迟

| 指标 | Gate |
|---|---|
| step→tool p50/p95 | 记录实测；p95 ≤60s（本地 27B 基线，非 cloud）；>120s 告警 |
| tool→assistant p95 | ≤2s |
| turn-gap p95 | immediate 模式 ≤2s；空闲退避不计入 |
| 单段运行时长 | 按“分段窗口”记录，不追 24h 单段 |

### E. 记忆/睡眠

| 指标 | Gate |
|---|---|
| home 记忆 | shelter 成功后 `home_set` 且重启后 `status.home` 仍在 |
| 事件→记忆 | 关键事件（shelter_done/home_set/death/combat）在记忆/recall 中可检索 |
| dream/睡眠 | 三态/唤醒 briefing 完整；不因 MC 失败阻塞睡眠 |
| 幻觉技能 | 记忆中出现未注册技能/未验收 home = FAIL |

### F. 证据完整性（run 可审计）

| 项 | Gate |
|---|---|
| 事件流 | `events.jsonl` + `body.jsonl` 完整，seq 连续/无丢失 |
| 任务台账 | `tasks.json` 含每个 task 的 params/result/error/来源 |
| 回放素材 | 至少一段可回放的 scenario 记录（tool calls + 预期事件） |
| 截图 | 只作辅助；不作为结构验收唯一证据 |

## 11.2 检测阶梯：L0 → L3（禁止直接 24h）

| 层级 | 内容 | 时长/成本 | 准入 |
|---|---|---|---|
| **L0 契约单测** | 技能契约/验收函数/失败码字段的单元测试（离线） | 秒级 | 每次改动 |
| **L1 确定性回放** | 用录制的 tool calls/事件 + fake adapter（或 mc-body dry-run）回放；断言 task 终态/verify/home/失败码/事件字段；不启服 | 秒–分钟 | L0 PASS |
| **L2 分段 soak** | 30–120min 一段，带 checkpoint/gate/stop；每段跑任务卡 suite；段间人工/自动 gate | 分钟–小时 | L1 PASS + 场景卡 |
| **L3 24h** | 只有连续 **3 段 L2 PASS** 才允许；仍然分段 gate，不是盲跑 | 24h | lead/用户明确 approval |

> 结论：先做 **L1 回放**，再谈“24h”。local3 的 90min 数据应转成回放素材/期望事件，而不是直接再跑一次。

## 11.3 回放 / checkpoint 设计（mc-body 只读参与）

**每次 L2 段必须落一个 checkpoint 包：**

```
.state/lab/<run>/checkpoints/<segment>/
  meta.json            # seed/world/time/body code commit/mc-link commit/模型/阶段
  tasks.json           # body ledger（含 home/task 结果）
  events.jsonl         # body events（seq 连续）
  transcript.md        # 对话/工具调用（可裁剪）
  world/               # 世界快照（服务器保存或区域快照；只读复用）
  memory/              # 记忆库/recall 样本（脱敏）
  segment-report.json  # 指标汇总（§10.1 的机器结果）
  expected-events.json # 回放断言（终态/verify/home/failure code）
```

**L1 回放器（未来实现，不加 MC 工具）：**
1. 输入：checkpoint 的 `expected-events.json` + 场景卡；用 fake adapter 按 task/op 回放；
2. 断言：task 终态/verify/entryOk/home/failure code/关键事件字段（如 `taskCancelled`）；
3. 输出：`replay-report.json`（PASS/FAIL + 差异）；不启 MC 服务。
4. 回放失败优先定位 mc-body 契约（不是模型）——避免把回归当“模型不稳定”。

**checkpoint 规则：**
- 每个 gate/stop 前自动 checkpoint（尤其 death≥N、连续 say、连续 shelter 失败）；
- checkpoint 必须包含 body commit + mc-link commit + world seed；否则不可比较；
- 段间允许“从 checkpoint 继续”，但报告中保留“本段起点”。

## 11.4 Gate/stop 规则

**启动 gate（沿用 mc-lab E2-GATE.json）**：`userNotifiedAt` + `phase` + lead approval 缺一不可。

**段 gate（L2）**：
- 安全 gate：deaths/h、连续同因死亡、夜宿；
- 结构 gate：shelter 完成率/verify 完整性；
- 任务 gate：重复动作、失败重试预算；
- 对话 gate：同句/小时、say/小时；
- 延迟 gate：step p95、tool→assistant；
- 证据 gate：checkpoint 完整。

**硬 stop（任一触发，立即 checkpoint + 停任务/停服）**：
1. 连续同因死亡 ≥3 或 death≥6（沿用 supervisor death-watch）；
2. 连续相同 tool+args >2；
3. 同句 say >2/h 或连续 3 次同句；
4. shelter 连续失败 ≥3 且无参数变化；
5. `path_stuck` 连续 ≥5 且无恢复动作；
6. 任何“未注册技能/未验收 home”进入记忆。

## 11.5 任务卡 suite（最小集）

| 卡 | 输入/初始条件 | 机器验收 |
|---|---|---|
| `shelter-3x3` | 平地、27 dirt/cobble、无怪 | shelter done、verify.ok、entryOk、home_set、重启 home 保留 |
| `night-shelter` | 夜晚邻近、有敌对 | 进入 home/封洞、无死亡；auto_defense/safety_stop 事件合理 |
| `collect-resource` | 有树/石区域 | collect done；资源枯竭时 no-resources + explore/换 item，不连续重试 |
| `combat-defense` | 1–2 敌对 | hunt/defend 成功或 flee 安全；auto_defense 取消非 combat；不死亡 |
| `memory-recall` | 完成事件后重启 | recall 关键事件/家坐标；无幻觉 |

每张卡固定“初始 world/物品/时间/天气”；卡间可 checkpoint 复用，但报告分开。

## 11.6 MC 恢复前的前置条件（P0 checklist）

- [ ] §10.1 指标以机器可读形式落盘（segment-report schema）；
- [ ] L1 回放至少覆盖 `shelter-3x3`、`collect-resource`、`auto_defense` 三条；
- [ ] local3 checkpoint/期望事件固化（见 MC-LOCAL3-FORENSICS）；
- [ ] shelter/collect/auto_defense 的 failure code + result 字段稳定（本仓 `cbb37f8` 已含）；
- [ ] chat 去重/重复动作熔断/shelter 失败冷却有 supervisor 或 head 侧实现（不新增 MC 工具）；
- [ ] path_stuck 事件补 kind/目标类型/失败原因，可归因；
- [ ] 段 gate + hard stop + checkpoint 脚本可跑（不启 MC 也能 dry-run）；
- [ ] lead/用户明确 approval + E2-GATE。

**不满足以上任一项，不恢复 24h。**

## 11.7 与原 §10 的关系

- 原 mc-lab §10.1（验收清单）保留为“人类可读摘要”；
- 本稿把清单**变成可执行 gate/scorecard/schema**，并补 L0–L3 回放/checkpoint/stop 设计；
- 原 §10.2 的 6 条机制（重复熔断/聊天去重/材料诊断/事件驱动/验收驱动/研究计划）作为实现输入，不重复列；
- 原 §10.3 研究问题由 [`MC-RESEARCH.md`](MC-RESEARCH.md) 回答（Voyager 技能库、MineAnyBuild 验收、APT 蓝图、Mindcraft/Cradle 架构）。

## 11.8 开放问题

1. 回放器用“fake adapter”还是“mc-body dry-run”：优先 fake adapter（不依赖 mineflayer）；
2. checkpoint 的世界快照成本：区域快照 vs 全服备份，需 mc-lab 定；
3. 段长：30 vs 60 vs 120min，按模型延迟/成本先 30min；
4. 指标阈值需在 L2 第一轮后校准（当前是研究建议，不是拍板）；
5. 是否允许“从 checkpoint 继续”计入 24h：建议允许，但报告中独立分段。

## 10.9 配套格式

- `path_stuck` v2 字段、L1/L2 checkpoint/回放输入 JSON schema：见 [`MC-INSTRUMENTATION.md`](MC-INSTRUMENTATION.md)；
- 研究对照：[`MC-RESEARCH.md`](MC-RESEARCH.md)；local3 数据：[`MC-LOCAL3-FORENSICS.md`](MC-LOCAL3-FORENSICS.md)。

## 11.9 L1 回放器（已实现，2026-11-07，冻结期离线）

- **工具**：`tools/mc-replay.mjs`
  ```powershell
  node tools/mc-replay.mjs docs/examples/mc-local3-examples/shelter-3x3 docs/examples/mc-local3-examples/collect-resource
  node tools/mc-replay.mjs <checkpoint-dir> --json --report .state/lab/<run>/replay-report.json
  ```
- **语义**（按 `MC-INSTRUMENTATION §3.6/§4.1`）：读最小包 `meta/scenario/tasks/events/expected-events`；**fake adapter**（无 mineflayer、无服务器）；`terminal/error` 精确、`result.require` 只查存在、`result.<path>` 精确、任务 `events` 必须出现（不要求顺序）、`eventAssertions where+min`、`forbidden` 命中即 FAIL；输出 PASS/FAIL + 差异（task/event/forbidden 逐项）。
- **示例**（`docs/examples/mc-local3-examples/`）：
  - `shelter-3x3`（t-106 failed `shelter: incomplete`，verify 墙缺 9/屋顶缺 6，24 条 `shelter_place_fail@repair-walls`）→ **PASS**；
  - `collect-resource`（t-1 done，`collected/net=8` oak_log）→ **PASS**。
- **world.json 可选**：当前 L1 断言基于录制的 ledger/events（结构结果已在 `task.result.verify`），不重放方块/物理，因此这两个示例**不需要** `world.json`；若后续要验证"世界实际结构（blockAt）"再补，格式见 `MC-INSTRUMENTATION §3.8`。
- **单测**：`packages/core/test/mc-replay.test.mjs` 覆盖两个 PASS + terminal 不符、缺必须事件、缺 result 字段、eventAssertions min 不足、forbidden 命中、缺文件报错、world 可选、路径/where 匹配语义。
- **限制**：`forbidden.when` 表达式暂不解释（显式 FAIL，不静默忽略）；`tool-replay`（L2/tool-calls）未实现，待 L2。
