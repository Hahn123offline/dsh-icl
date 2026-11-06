# L2 分段 soak 设计（MC 冻结期，2026-11-07）

> 状态：**只设计，不跑 MC、不启服、不碰 desktop**。等用户决定是否跑 L2；跑之前先通知用户。
> 依据：`docs/MC-INSTRUMENTATION.md`（checkpoint/回放格式）、`docs/TEST-PRINCIPLES.md`（当事人第一人称优先）、`docs/E2-HARNESS.md §11`（L0–L3 阶梯）、`tools/mc-replay.mjs`（L1 回放器，已实现）。
> 一句话：**L2 = 3 段 × 30min 的分段验收，不是 24h**。每段先 replay dry-run、再开服、段内 gate、段间 gate；3 段全 PASS 才谈 L3 24h。

## 0. 目标 / 非目标

**目标**（可验收）：
1. **能跑**：一段 30min 内任务卡按 `scenario.taskSequence` 推进，不空转、不刷屏；
2. **能停**：段末/硬 stop 能干净停 lab/body/server，证据先落盘；
3. **能回放**：每段 checkpoint 可用 `tools/mc-replay.mjs` 离线复现 PASS/FAIL；
4. **不刷屏**：`say`/聊天 ≤ 阈值、同一句不重复；
5. **shelter verify/entry**：3×3 庇护所走 `mcb_shelter`/`task kind=shelter`，产出 `verify.ok`/`entryOk`/`home_set`；
6. **安全**：deaths/hour、auto_defense 取消危险任务可观测。

**非目标**：24h 连续（L3）；长程记忆/睡眠 dream 全链路（S1 已验，L2 只抽样）；重物理/真实玩家对抗。

## 1. 段规格（默认 3×30min）

| 项 | 值 |
|---|---|
| 段数 | **3 段**（s0001/s0002/s0003），可先用 2 段试跑 |
| 段长 | **30min**（可选 60/120min；首次不超 60） |
| 段间隔 | stop → 证据落盘 → checkpoint → replay PASS → 下一段（不并行 lab） |
| 场景 | 3 段可同场景重复（shelter-3x3 + collect），或 s1=shelter、s2=collect+recall、s3=shelter+中断（auto_defense/cancel） |
| 世界 | survival 服（54838）或独立 dev 服；每段开始记录 seed/time/difficulty；段间可重开世界（checkpoint 记录） |
| 模型 | 本地 coder390（主）或 cloud flash（对照）；**同一次 L2 不混模型**，除非报告单列 |
| 主循环 | time `awakeTick.mode=immediate`（1s）/goal 0；若复测 cloud 可设 30s 对照，但需在同一段规格下另跑 |

## 2. 段前 dry-run（复用 L1 回放器，**不开服**）

每段开始前，对**上一段或预置 checkpoint** 跑：

```powershell
node tools/mc-replay.mjs .state/lab/<run>/checkpoints/s0001 \
  --json --report .state/lab/<run>/replay-s0001.json
```

- **PASS**：checkpoint 的 `expected-events` 能被录制数据满足 → 允许开服进入该段；
- **FAIL**：说明契约/字段/录制数据不一致 → **不开服**，先修 checkpoint 或代码；
- **INVALID**（缺文件/缺字段，回放器抛错）：补齐证据后再跑，不当作 PASS；
- dry-run 同时检查：`meta.commits/world.seed/model` 已填、`tasks.json` 含失败任务、`events.jsonl` 非空、`expected-events` 至少 1 个 taskAssertion；
- **不开服/不启 mineflayer**；`world.json` 仅当要结构重放时需要，L1 断言不需要（见 `E2-HARNESS §11.9`）。

## 3. 段内 gate（每段结束判定）

> 所有 gate 必须先有**当事人原话**证据（见 §7），再列数字；PASS/FAIL 由 lead 复核。

| 类别 | 指标 | PASS 条件（首轮保守值） |
|---|---|---|
| **安全** | deaths/hour；同因连续死亡；auto_defense | ≤2/h；同因连续 3 次=FAIL；威胁时 `task_cancelled_for_defense` 出现且任务终态 cancelled |
| **结构** | shelter 完成率；verify/entry/home | 3×3 shelter ≥1 次 `verify.ok && entryOk`；attempts/completion ≤2；含 `home_set` |
| **任务** | task_success_rate；重复工具；path_stuck | success ≥60%；同 tool+args 连续 ≤2；path_stuck/task ≤1 |
| **对话** | say/聊天条数；同句重复 | MC 聊天 ≤6/h；同一 say 文本 ≤2/h；同句 ≥3=FAIL（刷屏） |
| **延迟** | turn-gap / step / tool | immediate 模式下 turn-gap p95 ≤2s（不含退避）；step p95 记录（本地不追 ≤3s）；tool→assistant p95 ≤2s |
| **证据** | transcript/events/replay | `transcript.md`+`events.jsonl` 落盘；checkpoint 5 文件齐全；replay PASS；包含 ≥3 条当事人原话 |

**段内提前判 FAIL**（不等段末）：deaths 连续 3 次同因、say 同句 5 次、task 连续 3 次相同失败且无新信息、lab/body 崩溃 2 次、replay 无法生成。

## 4. Checkpoint 包（每段）

目录：`.state/lab/<run>/checkpoints/s000N/`（不删；与 lab run 证据分离于 `state/`）。

- **必需**：`meta.json`（含 `commits/world.seed/model/clock/limits`）、`scenario.json`、`tasks.json`（含失败任务）、`events.jsonl`（原始 body 事件）、`expected-events.json`；
- **L2 额外**：`world.json` 或 `world/`（结构验收时）、`tool-calls.jsonl`（可选）、`memory.json`（记忆抽样）、`segment-report.json`（指标+verdict）；
- 段末写：`segment-report.json`（`metrics` + `verdict` + `failures`），由脚本/人工从事件派生；
- **不修改**原始 `state/`；checkpoint 只读导出。

## 5. 段间 gate（通过才继续）

```
s000N 结束 → 停 lab/body（证据落盘）→ 写 checkpoint → replay dry-run PASS
  → segment-report verdict PASS → lead 复核（可自动）→ 允许 s000N+1
```

- 任一段 FAIL：**停止后续段**，报告"第几段/哪类/哪条原话/seq"；修因后重跑该段（不跳段）；
- 段间不并行 lab（单 lab 纪律）；根锁/端口/GPU 串行；
- 段间可选择重开世界（必须在 meta 记 seed/time），但 checkpoint 必须能独立回放；
- 连续 2 段 PASS 才可讨论第 3 段；3 段 PASS + 用户 approval 才谈 L3 24h（见 §8）。

## 6. 硬 stop 条件（立即停，安全优先）

| 条件 | 动作 |
|---|---|
| deaths > 6/30min 或同因连续 3 次 | 停 lab+server；保留证据；报告 death 分类+原话 |
| say 同句 ≥5 或聊天 >20/10min | 停；按刷屏 bug 归类（重复动作/材料循环/重连） |
| auto_defense 连续 3 次未取消任务 / 任务队列 hold 失效 | 停；body/链接口回归 |
| lab/body 崩溃 ≥2 次 / 根锁冲突 / 端口互杀 | 停；先修基础设施 |
| checkpoint/replay 失败（FAIL/INVALID） | 不开下一段 |
| 用户要求停 | 立即停，先保证据 |

停的顺序：**先确保 transcript/events 落盘 → 停 lab → 停 body/server → 清 workspace（不删 run 证据）→ 写报告**。

## 7. 报告模板（TEST-PRINCIPLES 硬性顺序）

```markdown
# L2 segment s000N 报告

## 1. 当事人原话（≥3 条，带 seq/时间）
- seq X（时间）："……"（重复 N 次/在什么情况下说）
- ...

## 2. 结论（PASS/FAIL + 一句话）
- 段 verdict：PASS/FAIL；主要问题：……
- 每条 P0/P1 附 1 条原话或 seq

## 3. Metrics
| 指标 | 本段 | 阈值 | 结果 |
...

## 4. Checkpoint / replay 证据
- checkpoint 路径；`node tools/mc-replay.mjs ...` 输出 PASS/FAIL；segment-report.json

## 5. 未知点 / 下段注意
```

- 没有"当事人原话"节 = 报告不完整，不得作为 PASS；
- 原话优先于 metrics；重复 say/工具参数 ≥3 必须列出并归因；
- 聊天/抱怨/困惑原文保留（不润色），必要处截断但保留 seq。

## 8. 与 L3（24h）的关系

- **L2 不等于 24h**：3 段 × 30min 验收的是"能跑/能停/能回放/不刷屏/shelter verify/entry"；
- L3 24h 的启动条件：**连续 3 段 L2 PASS + 用户明确 approval + E2-GATE(phase=soak)**；
- L2 期间不跑 24h、不把 3×30min 拼成"连续 90min"（段间必须停+回放）；
- L3 仍需分段 checkpoint（30–120min/段），L2 的 checkpoint/回放/报告模板直接复用。

## 9. 运行清单（跑 L2 时用，当前不执行）

1. 用户批 L2 时间窗；单 lab、指定 server/端口/bot；根锁/GPU 检查；
2. 准备 pre-seed checkpoint（或从上一段导出）；**段前 replay PASS**；
3. 开服/开 lab；严格 30min；段内监控 deaths/say/replay；
4. 段末停、导出 checkpoint、写 segment-report、replay PASS；
5. 报告按 §7；P0 立即 ping lead；
6. 3 段后总结；决定是否申请 L3。
