# E2-HARNESS §10 补充稿：MC 长跑检测机制（mc-body 提案）

> 状态：**MC 长跑冻结（2026-11-06 16:45 HKT）**；本文只设计，不跑测试、不启服、不加工具。
> 定位：mc-lab 已在 [`E2-HARNESS.md §10`](../../mc-lab/docs/E2-HARNESS.md) 落了 10.1–10.3 的初版；本稿是 **mc-body 视角的可执行增强版**，供 lead/mc-lab 合入/替换原 §10。冻结依据见 mc-lab [`MC-FREEZE-2026-11-06.md`](../../mc-lab/docs/MC-FREEZE-2026-11-06.md)，证据见本仓 [`MC-LOCAL3-FORENSICS.md`](MC-LOCAL3-FORENSICS.md)、研究见 [`MC-RESEARCH.md`](MC-RESEARCH.md)。
> 原则：**先验收指标，再谈工具**；不新增 MC 工具/宏，不把“跑得更久”当目标。

## 10.0 核心判断

local3 的失败证明：24h 盲跑不能回答“她是否会生活/会建房/会记住”。它只能放大三个问题——材料失败循环（shelter 92 次尝试/90 败/0 home）、重复聊天（49+33 次同句）、寻路/长任务在坏状态下继续。恢复 MC 前，必须先有**机器可判的验收 + 可回放的分段检测**；否则只是把同样失败跑更久。

**检测对象**：一次 run 的“能力证据包”，不是“存活时长”。
**验收单位**：一个**任务卡（scenario）** + 一段**可回放 checkpoint**，而不是一整段 24h 的自然语言早报。

## 10.1 验收指标（先固定）

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

## 10.2 检测阶梯：L0 → L3（禁止直接 24h）

| 层级 | 内容 | 时长/成本 | 准入 |
|---|---|---|---|
| **L0 契约单测** | 技能契约/验收函数/失败码字段的单元测试（离线） | 秒级 | 每次改动 |
| **L1 确定性回放** | 用录制的 tool calls/事件 + fake adapter（或 mc-body dry-run）回放；断言 task 终态/verify/home/失败码/事件字段；不启服 | 秒–分钟 | L0 PASS |
| **L2 分段 soak** | 30–120min 一段，带 checkpoint/gate/stop；每段跑任务卡 suite；段间人工/自动 gate | 分钟–小时 | L1 PASS + 场景卡 |
| **L3 24h** | 只有连续 **3 段 L2 PASS** 才允许；仍然分段 gate，不是盲跑 | 24h | lead/用户明确 approval |

> 结论：先做 **L1 回放**，再谈“24h”。local3 的 90min 数据应转成回放素材/期望事件，而不是直接再跑一次。

## 10.3 回放 / checkpoint 设计（mc-body 只读参与）

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

## 10.4 Gate/stop 规则

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

## 10.5 任务卡 suite（最小集）

| 卡 | 输入/初始条件 | 机器验收 |
|---|---|---|
| `shelter-3x3` | 平地、27 dirt/cobble、无怪 | shelter done、verify.ok、entryOk、home_set、重启 home 保留 |
| `night-shelter` | 夜晚邻近、有敌对 | 进入 home/封洞、无死亡；auto_defense/safety_stop 事件合理 |
| `collect-resource` | 有树/石区域 | collect done；资源枯竭时 no-resources + explore/换 item，不连续重试 |
| `combat-defense` | 1–2 敌对 | hunt/defend 成功或 flee 安全；auto_defense 取消非 combat；不死亡 |
| `memory-recall` | 完成事件后重启 | recall 关键事件/家坐标；无幻觉 |

每张卡固定“初始 world/物品/时间/天气”；卡间可 checkpoint 复用，但报告分开。

## 10.6 MC 恢复前的前置条件（P0 checklist）

- [ ] §10.1 指标以机器可读形式落盘（segment-report schema）；
- [ ] L1 回放至少覆盖 `shelter-3x3`、`collect-resource`、`auto_defense` 三条；
- [ ] local3 checkpoint/期望事件固化（见 MC-LOCAL3-FORENSICS）；
- [ ] shelter/collect/auto_defense 的 failure code + result 字段稳定（本仓 `cbb37f8` 已含）；
- [ ] chat 去重/重复动作熔断/shelter 失败冷却有 supervisor 或 head 侧实现（不新增 MC 工具）；
- [ ] path_stuck 事件补 kind/目标类型/失败原因，可归因；
- [ ] 段 gate + hard stop + checkpoint 脚本可跑（不启 MC 也能 dry-run）；
- [ ] lead/用户明确 approval + E2-GATE。

**不满足以上任一项，不恢复 24h。**

## 10.7 与原 §10 的关系

- 原 mc-lab §10.1（验收清单）保留为“人类可读摘要”；
- 本稿把清单**变成可执行 gate/scorecard/schema**，并补 L0–L3 回放/checkpoint/stop 设计；
- 原 §10.2 的 6 条机制（重复熔断/聊天去重/材料诊断/事件驱动/验收驱动/研究计划）作为实现输入，不重复列；
- 原 §10.3 研究问题由 [`MC-RESEARCH.md`](MC-RESEARCH.md) 回答（Voyager 技能库、MineAnyBuild 验收、APT 蓝图、Mindcraft/Cradle 架构）。

## 10.8 开放问题

1. 回放器用“fake adapter”还是“mc-body dry-run”：优先 fake adapter（不依赖 mineflayer）；
2. checkpoint 的世界快照成本：区域快照 vs 全服备份，需 mc-lab 定；
3. 段长：30 vs 60 vs 120min，按模型延迟/成本先 30min；
4. 指标阈值需在 L2 第一轮后校准（当前是研究建议，不是拍板）；
5. 是否允许“从 checkpoint 继续”计入 24h：建议允许，但报告中独立分段。
