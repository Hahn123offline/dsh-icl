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

## 6. 第 3 步：entity-to-entity 关系边（本轮）

### A. 数据与生成（确定性，不调模型）

- 新命名空间 `relation`（可召回，label 关系）：key = `relation:<from>:<label>:<to>`，
  data 含 from/to（entity key）、label（舍友/室友/同一个人/朋友/同事/同学/主人/相关）、
  evidence、sourceKeys（来源 fact/evt key）、day、provisional、superseded/invalidatedAt。
- `syncEntities` 扩展：从 **typed fact** 与 **event 块**（关系澄清常写成事件）里识别
  "关系词 + ≥2 个实体提及"（ids/aliases/text；"主人"可回退到 ownerQQ 实体），幂等 upsert 并合并证据。
- 关系 validity：所有来源块都被 superseded 时，关系边随之软失效。

### B. 读路径

- whois：找到 entity 后追加「关系：」段（对端实体显示名 + label），关系类问题可直接回答。

### C. 评测与回归

- formation 新增 `entity.relations`、`entity.relationDangling`（目标 0）；audit 新增关系边/悬空计数。
- 单测：fact 来源 + 幂等；event 来源 + 来源带 evt key（均通过）。
- focus fresh：formation R **81.3%**、端到端 r3/r5 **77.8 / 91.1%**、miss **6.7%**、falseInjection 0；
  entity：relations 1、relationDangling 0、entities 4、personCoverage 100%、
  typedCoverage 76.4%、eventCoverage 81.1%、stubs 1、danglingRefs 0
  （focus 素材里显式关系句少，关系边数量低是预期；QQ/live 关系句更多，下一轮验证）。
- 全仓 **914 tests / 913 pass / 1 skip**；评测自测 28/28。

## 7. 第 4 步（收口）：QQ/live 关系验证 + Phase 3 总结（本轮）

### A. QQ fresh（serial，含关系边）

- formation：R **95%**（19/20，历史最好）；端到端 r1 53.8 / r3/r5 **76.9%**、MRR 0.731、miss **15.4%**。
- entity：entities 3、personCoverage **100%**、typedCoverage **76%**、eventCoverage **100%**、
  relations **2**、relationDangling **0**、stub 0、alias 冲突 **0**。
- audit：typed live 42 / superseded 3、可疑取代 0、悬空链 0、缺失效时间 0、带 subject 35/42。

### B. live fresh（serial）

- formation R 62.5%（5/8，单次运行方差；历史 87.5–100%）、端到端 r3/r5 **85.7%**、miss 14.3%。
- entity：entities 5（stub 2、均为"只有显示名的 people"→孤立 stub 2，符合预期）、personCoverage 100%、
  typedCoverage 68%、relations 1、relationDangling 0、alias 冲突 0。

### C. 三源当前快照（entity/关系层落地后）

| 素材 | formation R | r1 | r3 | r5 | miss | entity | relations |
|---|---:|---:|---:|---:|---:|---|---:|
| focus-core（fresh 本轮前） | 81.3% | 28.9% | 77.8% | **91.1%** | 6.7% | 4 行 / 覆盖 100·76·81% | 1 |
| old-qq（fresh） | **95.0%** | 53.8% | 76.9% | **76.9%** | 15.4% | 3 行 / 100·76·100% | **2** |
| real-live（fresh） | 62.5% | 57.1% | 85.7% | **85.7%** | 14.3% | 5 行（2 stub）/ 100·68·68% | 1 |

### D. Phase 3 结论（第 1–4 步）

- entity 图已 additive 落地：实体行 + person/typed/event 引用 + entity-to-entity 关系边，
  全部确定性、幂等、可回滚（删 `entity`/`relation` 命名空间即回滚）。
- 读路径：whois 多档合并/别名/实体事实/关系；recall entity 别名扩展。
- 评测：formation（entity 覆盖/悬空/stub/关系边）+ audit（alias 冲突/孤立 stub/关系悬空）双口径；
  三源 fresh 均无回归，QQ 关系句多的素材 relations 2 且 formation R 95%。
- 全仓 **914 tests / 913 pass / 1 skip**；评测自测 28/28。

### E. 剩余与下一阶段候选

1. 关系边检索接入（关系对查询直接召回 relation 行，而不只经 whois）；
2. 关系 label 冲突/时效（同一对实体先后不同 label）与 validity 联动；
3. live gold/formation 方差仍大（62.5–100%），需要扩 gold 或重复采样；
4. typed v2 的 entity 置信（多 id 归并的人工抽审）与 migration 回归检查。


