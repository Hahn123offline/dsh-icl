# typed memory v2 · entity 层设计（Phase 3，2026-11-12）

> 用户决策（2026-11-12）：下一阶段优先做**完整 entity 图与迁移**；本地 LLM 抽取等显卡释放后再测。
> 本文只描述增量设计，不改已上线的 add 层/validity 行为；所有迁移必须**幂等、可回滚、评测可见**。

## 1. 目标

把"人物"从单块 person 档案升级为**可被 typed/event 记录引用的实体**：

- 一个规范实体 = 一个现实对象（当前主要是人：QQ 号 / MC 名 / 其它平台 id 的并集），
  有稳定 canonical key、别名集合、档案块引用、证据计数、最后出现时间；
- 所有 typed 记录（事实/偏好/承诺）与事件块都可以带 `subjectEntity`/`entities` 指向实体；
- recall/whois 能在不破坏现有路径的前提下用实体做一致性（当前先只写入 + 评测，不改召回排序）；
- 兼容：旧库没有 entity 行时，read path 行为与现在完全一致（增量迁移，不回填也不阻塞）。

## 2. 数据模型（additive，暂不新建表）

沿用 `mem_items`，新增命名空间 `entity`（`recallable:false`，内部用）：

```jsonc
{
  "namespace": "entity",
  "kind": "entity",
  "key": "entity:qq:3429502459",       // canonical key
  "text": "Hahn123（主人）",             // 展示用，最长 80
  "data": {
    "canonicalId": { "kind": "qq", "value": "3429502459" },
    "ids": [{ "kind": "qq", "value": "3429502459" }, ...],
    "aliases": ["Hahn123", "周子涵", "离线版"],
    "personKeys": ["person:3429502459"], // 档案块 key（可能多个，合并时并集）
    "familiarity": "close|unknown",
    "evidenceCount": 12,
    "firstSeen": 1793000000000,
    "lastSeen": 1793400000000,
    "provisional": false,
    "updatedAt": 1793400000000
  }
}
```

引用字段（增补，不替换旧字段）：

- person block：`data.entityId = "entity:qq:3429502459"`
- typed 记录：`data.subject` 保留（QQ 字符串，兼容）；新增 `data.subjectEntity = "entity:qq:3429502459"`
- event block：`data.entities = ["entity:qq:...", ...]`（来自已有的 `people`）

## 3. 迁移与写入时机（幂等）

1. `dream` 在 **wash 收尾** 与 **people 收尾** 各调一次 `syncEntities(now)`（纯确定性，不调模型）：
   - 扫 person 块（未 superseded）→ 按规范 QQ 聚合，upsert entity 行（merge aliases/ids/personKeys/evidenceCount）；
   - 给 person 块补 `entityId`，给 typed 记录补 `subjectEntity`，给 event 块补 `entities`；
   - 只补缺失字段，不覆盖已有值；重复跑不新增行、不改文本。
2. 迁移不会删除任何旧行；若 entity 层出现异常，删 `entity` 命名空间即可回滚（引用字段即使残留也只是冷数据）。

## 4. 评测口径（formation/audit 可见）

- formation：
  - `entities.count`（entity 行数）；
  - `entity.personCoverage`（带 entityId 的 person 块 / person 块总数）；
  - `entity.typedCoverage`（带 subjectEntity 的 typed 记录 / typed 总数）；
  - `entity.danglingRefs`（引用了不存在的实体 key 的记录数，目标 0）。
- audit：entity 行数、无 person 块的孤立实体、被引用但没有 person 块的实体、alias 重复。
- retrieval 暂不改排序：先确认 entity 层不改变现有三源指标（只加行，不改召回），
  下一步再让 whois/recall 用 entity 做归并。

## 5. 分步落地（每步都有评测/回滚）

1. **本步**：entity 命名空间 + `syncEntities` 幂等迁移 + person/typed/event 引用字段 + formation/audit 指标；
   验证：三源 formation 指标不变、entity dangling=0、typedCoverage≥80%（合成偏好库里已 80% 有 subject）。
2. 下一步：whois/recall 读路径用 entity 归并（同一实体多 id 的档案合并、关系问题用 entity 对）；
   要求三源 retrieval 指标不下降、person probes 提升。
3. 再下一步：relationship 升级为 entity-to-entity 关系记录（带 evidence/validity），替换目前"事件块里写关系"的隐式做法。
