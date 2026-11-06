# 旧项目 A/B 合并结论：只搬"降低复杂度"的部分（2026-11-06）

> 输入：4 份只读研究报告（临时子代理，`old` 项目 = `C:\DSH\qwenstuff`，未改动）
> - [`OLD-QWENSTUFF-MEMORY.md`](OLD-QWENSTUFF-MEMORY.md) 记忆/调度/长期状态
> - [`OLD-QWENSTUFF-APPROVAL.md`](OLD-QWENSTUFF-APPROVAL.md) 审批/权限交互
> - [`OLD-QWENSTUFF-ENGINEERING.md`](OLD-QWENSTUFF-ENGINEERING.md) 运行拓扑/工程模式
> - [`OLD-QWENSTUFF-QQ-UX.md`](OLD-QWENSTUFF-QQ-UX.md) QQ/唤醒/第一感受
> 判据（用户拍板）：**不是"旧项目多了什么"，而是哪些真的降低复杂度**——概念更少/状态更少/提示词更短/失败路径更清晰/可观测性更好。

## 0. 证据边界（先看，防止被旧文档骗）

- **旧记忆 G1（dsh-qq 5–6 表）实现已删**：`src/memory/*.js` 是 147 字节 shim，指向不存在的 `focus-core/packages/memory`；全仓无 `MemoryStore`。**G1 只能当设计意图读**。
- `qwenstuff\icl` 是 2026-10 旧快照（16 插件/609 行 services）；现 `C:\DSH\icl` 已 22 插件/797 行。旧 `ARCHITECTURE/README` 的"16 插件/193 通过"已过期。
- 旧项目**无 `npm test`**：98 个散装 `test-*.mjs`（13,580 行）；手写审计清单（曾登记已删除的测试）；`audit-out` 151 PASS 但结尾 57/60；"79/79 全绿"同时"真实 QQ 闭环未跑过"；103 处空 `catch`。
- 旧审批设计真实存在，但项目自己 2 天改 3 轮后**整体删除**，HISTORY 写"审批体系不继承"。
- 量级：现 ICL 生产 28,558 行 vs 旧 29,428 行；测试/生产比 0.50 vs 0.46——**"一代更小"不成立，只是形状变整齐了**。

## 1. 值得搬（按收益/风险排序）

| # | 候选 | 旧项目依据 | 降复杂度表现 | 改动量 | 风险 | 验收 |
|---|---|---|---|---|---|---|
| A | **单一投递/唤醒裁决点** `policy.decide` | `focus-core/apps/dsh-icl/src/domain/policy.js:32-73`（75 行纯函数，2 通道 ambient/pierce，只降级不丢弃，5 种 reason） | 决策点 **2→1**、reason **9→5**、状态组合变少；现行 focus.admit + time gate 双闸门 | 中（先 facade 对拍） | 中（sleep/pause/mute/alarm 语义） | 旧 reason→新 reason 对拍 + 现有 time-lock/bridge 测试全绿 |
| B | **渐进式提示**（wakeCount>0 → 6 行提醒，首次才全量） | `dsh-qq/src/core-runner.js:161` | 直接压缩每轮重复投递（E2 实测 9.1 万字符/134 条 runtime-context；每轮 130k） | 小（纯加法） | 低（不改契约） | lab 单次 run：投递字符/轮次、turn-gap、当事人原话 |
| C | **renderTail 一行状态** | `domain/attention.js:274-289` | 用 20–40 token 工具返回尾巴替代反复 `time_status/mcb_status`（实测 mcb_status 125 次） | 小 | 低（append-only tool result） | 状态查询次数下降 ≥50%、工具结果字符不爆 |
| D | **threads + thoughts 两行世界块** | `attention.js:234-243` | 2 张表 + 2 行 + 0 次 LLM，补"上次聊到哪/有句话没说完"；补长期状态空白 | 中 | 低 | 世界块字符 <300；当事人醒来能引用上一话题 |
| E | **记忆整理与睡眠解耦**（`{due,reason}` + 60s tick + per-scope 退避） | `domain/memory.js:59-86`、`loops/summary.js` | 不再"她今晚不睡就漏当天"；调度逻辑从 sleep 分支移出 | 中 | 中（dream 语义） | dream 三态/成块率；白天总结可观测 |
| F | **表驱动错误分类 + 下一步** | `agent-errors`（68 行） | 治 `mine: no-target` 22 字符无下一步、92 个错误只有分类不行动 | 小 | 低 | 错误回执 100% 带下一步；重复同错下降 |
| G | **唤醒前拒绝（attention 式纯函数）** | `attention.js` | 静默期/无意义提醒在入队前被拒绝，少烧 token | 小 | 低（与 A 重叠） | 静默期空转发=0；不丢 alarm |
| H | **单一 JSON 存储原语（版本+迁移+原子写+损坏留证）** | `lib/json-store.js`（223 行） | 多个插件各自写 JSON 的重复逻辑收敛 | 中 | 低 | 每插件状态文件版本化/原子写/损坏可恢复 |

## 2. 明确不搬

- facts 表（旧项目自己 2 天后 DROP）；`memory_release/safe_text/sensitivity`（4 概念换 1 需求）；`memory_jobs` 水位表（纸面未落地）；L0–L4 四层节奏（只是四个名字）；三路召回；5 态注意力机；三档 share policy。
- 旧审批状态机（预授权窗口/词表/预算/grant）：概念 ≈10 vs DSH ≈6，防误批/防注入弱，项目已删。**只借"会话内自然语言应答 + per-call 绑定"**，不搬机制。
- 176 个 `/api` + 6444 行单页控制台 + 双 UI、4 运行模式（closed-agent 98 处死引用）、3 份 24KB preset 三胞胎、interface-platform（1873 行只抽象 2 个后端）、WSL 盒子。
- 旧 proactive 多定时器 + 概率乘数链（旧 v2 自己收成"一个空闲心跳 20–45min"）；我们 wake 矩阵 3 类×12 数值保留，缺的是**叙事**不是策略。

## 3. 我们自造的复杂度（值得单独审）

1. **自建 delivery 队列**（ack/nack/退避/watermark/exactly-once + 500ms tick/1000ms 泵）去喂 DSH 自己的 inbox 队列；旧项目直接 `sessions.prompt(mode:'queue')`。先验证 DSH 队列是否够用，再决定是否削。
2. **工具面膨胀**：一轮 48 工具/29,045 字符 schema，31 个工具 120 分钟 0 调用（memo/focus 全族）；记忆族 17 个工具 vs 旧 1 个；time 插件 27KB→126.7KB。A1 已把产品面从 66 压到 51，仍应守"不轻易加工具"。
3. **两个投递闸门 + 9 种 reason**（=候选 A）。
4. **runtime-context 重复**：9.1 万字符/134 条（DSH 样板 514 字符/快照 + facts；`includeRuntimeContext:false` 在 DSH 0.2 不可行，hold）。
5. **bug 性丢消息**：`qq_mark_read` 能跨过未交付消息（已开 P0 修复，`ledger.markRead` 夹到已交付高水位）。

## 4. 建议下一步（最小、可验收）

1. **先做 B（渐进式提示）**：纯加法、不改契约，一次 lab run 验证"每轮投递字符/turn-gap/当事人原话"。
2. **A 设计先行**：`docs/DELIVERY-POLICY-DESIGN.md`（time 已接），facade 对拍旧行为，再决定是否切。
3. **C/F 小实验**：renderTail 一行状态 + 错误分类带下一步，均 append-only、可回滚。
4. **D/E 等产品级批准**：threads/thoughts 与整理解耦涉及记忆语义，先出设计、不直接改。
5. **不再新增 MC 工具**；MC 恢复前先完成回放/分段验收（见 `E2-HARNESS §10/§11`）。

## 5. 原则

- 任何"搬"必须写清：**替换了什么旧概念、少了几个状态/几个 reason/几行提示词**；只增加了代码没减少概念的不搬。
- 当事人第一感受优先（[`TEST-PRINCIPLES.md`](TEST-PRINCIPLES.md)）：结论/验收必须含受试原话与 seq。
