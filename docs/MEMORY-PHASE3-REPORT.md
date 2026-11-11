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

## 4. 下一步（Phase 3 第 2 步）

1. **读路径**：whois/recall 用 entity 归并（同实体多 id 的档案合并、关系问题用 entity 对），
   要求三源 retrieval 指标不下降、person probes 提升；
2. **关系记录**：把"事件块里写关系"升级为 entity-to-entity 关系行（带 evidence/validity），
   替换隐式关系；用 focus p-19 / live p-02 这类关系探针验证；
3. **audit**：entity 行数、孤立实体、stub 比例、alias 冲突进 `tools/memory-audit.mjs`；
4. 三源 fresh 方差在 entity 层稳定后重跑并更新 baseline。
