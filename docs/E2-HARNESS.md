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

数据源：`state/icl-mc-lab/state/memory.db`（`mem_ns`/`mem_items`，`node:sqlite` 只读）、`events.jsonl`（tool/call+result、user/message、system/message）、`body.jsonl`（真实事件）、`time.json`、`transcript.md`、dream-run 行。

| 指标 | 定义 | 告警阈值（可配） |
|---|---|---|
| `recall.calls` / `recall.emptyRate` | recall 调用数；结果文本判空（/没有|未找到|空/ 或 ≤8 字符）比例 | 调用≥5 且 emptyRate>0.6 |
| `recall.avgResultChars` / `noiseHits` | 结果平均字符；结果行中不含查询词的块比例（粗噪声代理） | avgChars<40 或 noiseHits>0.5 |
| `remember.calls` / `forget.calls` | 显式记忆写入/删除调用 | — |
| `eager.injections` / `eager.chars` | `<icl-context>` 注入次数/字符 | 有事件但 0 注入（kind 未命中）记 info |
| `dream.jobs[]` | 每 job（wash/events/people/lexicon/consume/cleanup/index）是否记录、`wash{lines,chars,omittedLines}`、`consume{written,archived}`、`index{indexed,missing}` | 缺 job、consume.written=0 连续 2 天、index.missing>indexed |
| `mem.growthPerHour` / `mem.items` / `mem.bytes` | mem_items 总数与增速（按 namespace/kind） | 增长 > 60 条/h 或 byte 增速异常 |
| `mem.dupRate` | 同 (namespace,kind,归一化文本) 重复行占比 | >0.2 |
| `mem.blockChars.p50/p95/p99` | 记忆块字符数分布 | p95 > 1200 或 p50 < 20（太碎） |
| `latency.eventToMemoryMs` | remember 调用 → 随后首个新 memory 行 created_at 的差（p50/p95）；dream consume → 首个 block 行 created_at 差 | p95 > 5min |
| `compaction` | `compaction/summary` 行数与 `data.dropped` 和 | dropped 激增 |
| `events.loss` / `events.dup` | body 事件行数 vs 记忆 event/note 块数（仅启发式）；同 seq 重复数 | 重复 seq >0 或 loss>50%（启发式，标注置信度） |
| `dream.failures` | 预期 job 缺失/报错（data.error）次数 | ≥1 |

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
