# 记忆 Phase 3 报告（第 1 步）：entity 层与幂等迁移（2026-11-12）

> 用户决策（第 21 轮）：下一阶段优先 **A. 完整 entity 图与迁移**；本地 LLM 抽取等显卡释放后再测。
> 设计见 `docs/MEMORY-V2-ENTITY-DESIGN.md`；本文记录第 1 步落地与评测。

## 1. 做了什么（additive，可回滚）

- 新增内部命名空间 `entity`（`recallable:false`）：一个现实对象一行，key = `entity:<kind>:<canonical value>`，
  数据里含 canonicalId、ids、aliases、personKeys、familiarity、evidenceCount、firstSeen/lastSeen、provisional。
- 新增 `dream` 的确定性 `syncEntities(now)`，在**每次 `dream.run` 结束时**跑一次（不调模型）：
  - person 块 → 聚合 upsert entity 行（alias/ids/personKeys 并集），并给 person 块补 `data.entityId`；
  - typed 记录（fact/preference/commitment）补 `data.subjectEntity`；
  - event 块按已有 `data.people` 补 `data.entities`；
  - 悬空引用补 `stub` 实体（仅显示名、无档案的 people），让图闭合，后续正式档案会覆盖合并。
- 幂等：重复跑只补缺失字段，不新增行、不改已有 entity 文本；删 `entity` 命名空间即可回滚。
- 单测：person/typed/event 引用回填、重复同步不新增行、已回填不再变更。

## 2. 评测口径（formation 新增，不参与 P/R）

| 指标 | 含义 |
|---|---|
| `entity.entities` | entity 行数 |
| `entity.personCoverage` | 带 entityId 的 person 块占比 |
| `entity.typedCoverage` | 带 subjectEntity 的 typed 记录占比 |
| `entity.eventCoverage` | 带 entities 的 event 块占比 |
| `entity.danglingRefs` | 指向不存在实体 key 的引用数（目标 0） |
| `entity.stubs` | stub 实体行数（只有显示名、无人物档案） |

## 3. 首跑结果（focus-core，fresh，串行）

- formation：extracted 199 / matched 26 / **R 81.3%**、provenance 100%（与 entity 前一致，未回归）。
- 端到端 retrieval：r1 59.4% / r3 84.4% / **r5 100%**、miss 0%、falseInjection 0%。
- entity：entities 3、personCoverage **100%**、typedCoverage **78.3%**、eventCoverage **84.9%**；
  首跑 dangling 1（stub 补齐逻辑上线前），stub 逻辑上线后的 smoke 验证 dangling 0。
- 合成 alias-and-people smoke（echo）：entities 9、personCoverage 100%、dangling 0。

## 4. 第 2 步：entity 读路径 + 关系检索接线（2026-11-12 本轮）

### A. whois：按 entity 归并档案

- 先按 QQ/id/名字找 `entity` 行，再取 `data.personKeys` 的全部 person 档合并输出：
  主档案行保持第一条（兼容旧输出/评测解析）、追加「别名／其他称呼」「同一实体的身份」
  「（合并了 N 份人物档案）」以及该实体的 typed 事实/承诺（subjectEntity 命中）；
- 最近事件同时按 `event.entities` 命中合并（不再只看 people）；
- 单测：两份不同显示名的 person 档 + 一个 entity 行 → 按别名 whois 能拿到合并结果。

### B. recall：entity 别名扩展

- 问句里出现某实体的别名时，用同实体的另一个称呼替换再搜一遍（"周子涵"↔"Hahn123"），
  只在前几路候选不足 3 条时启用，不改变既有排序/门槛。

### C. audit：entity 段

- `memory-audit` 新增：entity 行数、stub 行数、孤立 stub、**alias 冲突**（同一别名挂在多个实体）、
  person→entity / typed→entity 覆盖率；与 formation 的 entity 指标互补（一个看生成，一个看存量）。

### D. 回归结果

- 全仓 **912 tests / 911 pass / 1 skip**；评测自测 28/28。
- focus fresh（含 entity 读路径）：formation R **81.3%**、端到端 r1 35.3 / r3 78.4 / **r5 86.3%**、
  miss 11.8%、falseInjection 0 —— 与 entity 前同量级（71–94% 波动区间），无回归。
- QQ fresh：formation R 90%，r5 54.2%（同配置历史在 45–73% 间波动，entity 读路径未改变
  "硬多跳问句"的难度；剩余 miss 仍是 p-01/p-04/p-06/p-07/p-10 这类问题，下一轮继续 gold/问法修整）。
- 说明：`--cache-only` 重放 formation 会因 nightly 行为差异出现偏差，**结论只用 fresh run**。

### E. 下一步

1. 关系行（entity-to-entity，带 evidence/validity），替换"事件里写关系"；
2. QQ 硬多跳：问法/日期归一继续修，且验证 entity alias 扩展对 p-01/p-10 的实际收益；
3. 三源 fresh 方差在 entity 稳定后重跑，更新 baseline。

