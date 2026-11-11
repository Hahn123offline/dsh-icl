# 记忆 v2 设计草案（typed memory，2026-11-11）

> 状态：**草案，待用户拍板后实施**。依据：`docs/MEMORY-DIAGNOSIS.md` 已确认的 R1–R8 根因、
> `docs/MEMORY-EXTERNAL.md` 的外部结论、Phase 1 在 commit `43e72ef..e289aed` 落的修复。
> 本文只写设计，不写迁移代码；实施顺序按 §7 分步、每步过评测门。

## 0. 目标与硬约束

目标：让"她记住的东西"有**类型、身份、出处、时效、重要度**，从而能：
1. 记住该记的（用户事实/偏好/关系、共同经历、承诺、群聊人物）；
2. 不重复、不矛盾、不张冠李戴；
3. 召回可解释、可验证（每条都能追到 raw 行）；
4. 长期增长不退化（遗忘是表达，不是丢失）。

硬约束：个人库规模（数年 <10 万条）；单机 SQLite；不引图数据库/外部服务；dream 夜间批量为主，
白天只做 0 LLM 规则候选；每轮注入预算受限（当前 eager ≤200 字）；旧数据可迁可回滚。

## 1. 信息模型（五类记录 + 两个支撑实体）

| 类型 | 回答的问题 | 例子 | 当前对应 |
|---|---|---|---|
| `episode` | 那天发生了什么（一次经历） | "11-09 晚上他发操场照片，我问他白卫衣是不是他" | event block |
| `fact` | 关于世界的稳定陈述（带主体/有效期） | "主人负责维护 dsh-icl"；"他怕水" | 现在混在 event/person body 里 |
| `person` | 某个人是谁（身份+关系+画像） | 主人/Hahn123/周子涵，owner，QQ 3429502459 | person block |
| `commitment` | 她答应过/想做的未结事项 | "答应下次给他看海边的照片" | note kind=promise（弱） |
| `concept` | 本群/本来源的用词（不解释语义） | "白米饭 = 大肥鱼爱吃白米饭的梗" | lexicon term |

支撑实体：
- `entity`：有稳定 id 的对象（人/自己/群/主题/地点）。人的 entity 必须有 `ids[]`（qq/mc/...)，
  **显示名只是 alias**；self/owner 是产品已知 entity。
- `evidence`：指向 raw 行的引用 `{rowId, day, role, source, quote, at}`；quote 必须能在 raw 行里逐字找到
  （校验失败 → provisional）。

每条记录统一字段（可存 JSON data，也可拆列；实现时按查询需要拆 `namespace/kind` + `data`）：
`id, type, subject(entityId|null), text, data, importance(1-5), confidence(0-1),
validFrom, validUntil, invalidatedAt, supersedes[], supersededBy, evidence[], sources[], origin,
provisional, createdAt, updatedAt, lastUsedAt, useCount`。

## 2. 身份模型（解决 R5，最高优先）

- `entity` 表：`id TEXT PK`（`person:3429502459` / `self` / `group:1057812765` / `topic:xxx`）、
  `kind`, `canonical_name`, `ids JSON[]`, `aliases JSON[]`, `flags JSON`（owner/self/blocked）、`created_at`。
- 解析顺序：**账号精确 → 产品配置（self/owner）→ alias 精确 → 显式 alias 合并 → 名字候选（不自动合并）**。
- 允许来源：配置（selfQQ/ownerQQ/ownerNames）、主会话显式命令、dream 的"明确原话"证据（"叫我XX"）。
  模型不能凭单轮猜测合并两个人；不确定时保留候选并提问。
- 人的记录挂在 entity 上，event 的 `people` 存 entity id；whois/relatedEvents 都按 entity 查。
- 群：`group:<gid>` entity，记录群规则/称呼/白名单等；群友与私聊同人靠 QQ id 合并。
- **迁移**：现有 person block 用 `knownIdentityBlocks`（Phase 1 已实现）先归并；
  含 qq id 的 → entity；纯 name 的 → entity(kind=person, canonical_name=name, ids=[])，
  显示名进 aliases，等账号证据到了再合并。

## 3. 写入：两段式（解决 R1/R3/R6）

### 3.1 Capture（白天，0 LLM）
- source-aware raw 已经是第一阶段（Phase 1：sourceKind/rowIds/sources）。
- 规则候选队列：从 `human` 行里抽取**指针级**候选（不做语义改写）：
  - 用户自述/偏好句式（"我…""我喜欢…""我不吃…"）、承诺句式（"下次…""答应…"）、
    人物引入（"这是我朋友 X""叫我 X"）、纠正（"不是…是…"）；
  - 只存 `{rawRowId, kindHint, at}`，不产生记忆条目；dream 消费后标记。
- 可选（Phase 3+）：本地 27b 做低置信候选抽取，必须过评测门再开。

### 3.2 Consolidate（夜间 dream）
1. wash：按 source 生成 day log（Phase 1 已完成）；
2. segment：按 channel + 时间窗切 episode 候选（现在按时间 gap；v2 增加 channel/conv 维度）；
3. extract：模型按类型输出，**每条必须带 evidence quote**；prompt 明确"不记计划/工具/状态"；
4. arbitrate（新）：对每个候选，先取相似旧记录（embedding + 关键词 + entity 匹配，取 top-5），
   一次模型调用做 ADD / UPDATE / INVALIDATE / MERGE / NOOP 决策（Mem0/Zep 的写时决策，clean-room 设计）；
5. verify（确定性）：evidence quote 在 raw 行中存在、entity 解析无冲突、validity 不早于证据时间；
6. commit：写新记录/更新旧记录（旧记录 `invalidatedAt`，不删除）；记账 attempt（Phase 1 已实现）。
7. cleanup：只做确定性合并（同 entity 的重复 fact、同证据集的 episode）；模型整理作为可选增量。

成本控制：extract 按天分片（当前已分片），arbitrate 只对"候选与旧记录相似"的条目调用；
每加一次 LLM 调用必须用评测 fixture 证明净收益（见 §6）。

## 4. 读取（解决 R7 与注入质量）

- **检索**：hybrid = 向量 + 字面 + entity 过滤 + importance + 时效；查询扩展只做确定性
  （时间词、称呼表）；rerank 用轻量规则（MMR 去重 + provisional 降权 + 清晰度标签），不引 cross-encoder。
- **注入策略**：
  - eager 每轮 ≤2 条/≤200 字（保持），但改为"候选打分 + 多样性 + 冷却 + 已注入不重复"；
    provisional/低清晰度降权并显式标"存疑/有点模糊"；
  - active recall 保持工具，做"回忆模式"（overview/某人/某段时间/继续翻），不要求 live 高频调用；
  - 影子召回日志（Phase 1 已加 candidateIds）进评测。
- **衰减/清晰度**：`decay` 的 anchor 不再只看 `lastRecalledAt`；改为
  `anchor = max(lastRecalledAt, lastMentionedAt, updatedAt)` 与独立 importance 一起参与；
  到期先降清晰度（CLARITY 已有档位）、再停止主动注入，最后归档（可 recall 翻出），**不删除**。
- **矛盾**：查询默认只看有效记录；被 invalidated 的旧事实保留，回答里可用"以前以为…后来…"叙事。

## 5. 存储与迁移（additive，可回滚）

- 不改 `mem_items/mem_vec` 基本结构；新增：
  - `mem_entities(id, kind, canonical_name, ids, aliases, flags, created_at, updated_at)`
  - `mem_evidence(item_id, row_id, day, role, source, quote, at)`（或继续 JSON data.evidence，先轻后重）
  - `mem_items` 加列：`type, subject_entity, importance, confidence, valid_from, valid_until, invalidated_at, superseded_by`
- 迁移分三步：
  1. **shadow 写**：v1 继续服务 live；v2 在 lab/影子库用同一 raw 生成，评测对比；
  2. **双读对比**：同一批 probe 比较 v1/v2 的 recall/injection 指标与成本；
  3. **切换**：v2 达标后一次性迁移（episode←event block、person←block+entity、concept←lexicon、
     commitment←note promise），迁移脚本幂等、可回滚（保留 v1 命名空间只读）。
- 兼容：旧 API `memory.search/put/query` 不变；v2 通过新 namespace/服务暴露，逐步替换调用方。

## 6. 验收（评测门，全部用 `tools/memory-eval.mjs`）

| 阶段 | 必须达到 |
|---|---|
| v2 shadow 形成 | formation P/R 不低于 v1；self-source 条目占比 ≤ v1；dupRate ≤ v1/2；provenance ≥0.95；identity wrongIdRate ≤0.05 |
| v2 shadow 召回 | recall@5 ≥ v1；injectionPrecision ≥ v1；missRate 下降；注入 token ≤ 现网 110% |
| 长程 | 三源 fixture 上跨 8–15 天 replay：承诺兑现、偏好更新后旧值失效、别名合并正确 |
| 成本 | 每 fixture 天 LLM 调用 ≤ v1 +1；缓存命中可复跑；无新增常驻 prompt 段 |

任何一步不达标就回滚到 v1，并把失败样本写进 fixture。

## 7. 实施顺序（每步独立可验证）

1. **entity 表 + 身份解析**（无 LLM）：迁移现有 person 块；`whois/recall person` 改走 entity；评测 identity 指标。
2. **evidence 表 + provisional 校验**：形成时逐条校验 quote，失败标 provisional；评测 provenance。
3. **typed extract prompt**：事件块拆 episode/fact/commitment，带 evidence；先用 v1 存储跑影子，比较 formation。
4. **write-time arbitration**：相似旧记录检索 + ADD/UPDATE/INVALIDATE/NOOP；先只在 lab 开。
5. **检索/注入 v2**：importance/validity 参与打分，MMR/多样性注入；标定 eager/recall 阈值。
6. **迁移 + 切换**：一次回填 + 可回滚；live 只做影子，用户决定重启时机。

## 8. 需要用户拍板的点（实施到对应步骤前再问）

1. `fact` 的粒度：原子事实（一个属性一条）vs 段落式（一段话多条）？影响 arbiter 复杂度与成本。
2. 承诺（commitment）是否允许她**主动**在合适时机提起/推送？还是只注入提醒、由她决定说没说？
3. 群聊第三方信息：哪些可入长期记忆（人物/群规则/梗），哪些不应记（他人隐私细节）？
4. v2 切换是否接受一次性 DB 迁移 + 旧 live 状态只读保留（推荐），还是要求完全双写？
5. 本地 27b 参与形成（抽取/仲裁）的接受度：隐私更好但质量需先评测；默认仍走云端 deepseek-chat。

## 9. 不做

- 不引图数据库/Neo4j；不整包移植第三方框架；不逐轮 LLM 抽取/judge；
- 不做七情式动态人格；不把 v2 变成"第二套工具体系"（仍由现有插件暴露能力）；
- 不在没评测数据时切 live；不删除用户数据（只失效/归档）。
