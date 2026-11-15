# 研究材料索引（注意力 / 主动性 / 人格）

> 来源：本地 ICL 仓库的 `.state/lab/lead/attention-research/` 与 `.state/lab/lead/persona/`，
> 2026-11-15 整理进仓库，方便在另一台电脑继续。
> 仓库是 private；材料里仍包含本机路径、QQ 号和群号等运行事实，不要公开转发。

## 文件

| 文件 | 内容 | 原始位置 |
|---|---|---|
| `ATTENTION-EXTERNAL.md` | 外部调研：陪伴/主动 Agent 的注意力调度、主动发起、防打扰（33 个链接，逐条标 事实/推断/未核实） | `.state/lab/lead/attention-research/external.md` |
| `ATTENTION-LOCAL-SCOUT.md` | 本机旧实现盘点：focus-core / dsh-qq 的 selfwake、continuation、policy、attention-window、proactive 乘数链；文件:行 级出处 | `.state/lab/lead/attention-research/local-scout.md` |
| `ATTENTION-DAILY-2026-11-15.json` | 2026-11-15 注意力日报：5 次心跳（2 attend / 3 long-silence）、1 次 skip-empty、各 turn 的工具/动作分类 | 日报脚本生成 |
| `ATTENTION-HEARTBEAT-TURNS-2026-11-15.json` | 心跳回合原始分类（更早基线：25 次心跳、17 次无工具） | `.state/lab/lead/attention-research/heartbeat-turns.json` |
| `ATTENTION-CLEAN-VERIFY-2026-11-15.json` | 干净上下文 lab 验证：静态策略存在、空状态不叫醒、有积压发决策简报、长静默关闭后不产生 turn | `verify-clean-context.mjs` 输出 |

相关设计/决策文档（在 `docs/`）：

- `ATTENTION-RESEARCH.md` — 现状诊断、外部研究、Attention V1 设计、实施记录（含 18:18 事故 caveat）
- `PERSONA-PORT.md` / `PERSONA-DRAFT.md` / `PERSONA-DRAFT.diff` — 小千 → 大肥鱼的移植方案、草案与 diff
- `FOCUS.md`、`TIME-HEARTBEAT.md`、`QQ.md`、`QQ-GAP.md` — 对应模块契约

## 可复跑脚本（`tools/research/`）

从仓库根目录运行；读取 live state：`~/.dsh/icl/state`（Windows：`%USERPROFILE%\.dsh\icl\state`），输出到 `.state/lab/attention-research/`。

```bash
# 某一天的注意力日报
node tools/research/attention-daily-report.mjs 2026-11-15

# 心跳回合分类（读 session-events）
node tools/research/attention-analyze-heartbeat.mjs

# 盯下一次心跳，醒来 90 秒内做了什么
node tools/research/attention-watch-heartbeat.mjs 40

# 不调模型的干净上下文验证（静态 persona/sim 策略 + 条件心跳）
node tools/research/attention-verify-clean-context.mjs
```

## 关键结论（读材料前先知道）

1. **三类合法触发**：到期承诺、清单未完成、情境窗口且有料；其余时间显式 no-op。
   自产主动性永远不能 pierce（不能穿透自己设的勿扰）。
2. **线上教训**：focus 在真实对话几乎没用过；心跳曾 68% 空转；「看过但不回」需要显式 ack + seen 水位；
   睡眠中曾因冷恢复未读摘要被叫醒（已修）。
3. **18:18 的「不回」是被用户口头指令污染的**，不能作为注意力机制生效的证据；
   真正干净的观察要等上下文里那条指令消退，或另开干净会话。
4. **人格是 L3 的动机来源**：旧卡 01–06 讲「她是谁、怎么说话、在乎什么」，07–09 讲社交行为；
   当前产品人格已换成大肥鱼（3,924 字符），群聊/工具行为留在 sim/tools。
5. **L3 v1 不是自动推送**：心跳时她看 backlog，按人格挑合理的话接住；没有由头不主动开新话题。
