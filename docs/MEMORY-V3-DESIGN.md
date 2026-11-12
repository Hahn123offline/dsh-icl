# 记忆 v3 设计：经历块（episode）为主 + typed 注释（2026-11-12）

> 用户口径（2026-11-12）：①召回主单位为"经历块"，**不限制块数量、不硬性规定每块长度**，没活不硬整；
> ②typed（事实/偏好/承诺）**不再独立召回**，降级为块内注释/承诺清单；③重建后旧记忆归档，
> **所有记忆按新系统逻辑重建**；④先 lab 用真实旧素材验证，再谈 live 切换。

## 1. 目标形态

- **episode（经历块）**：一段连续经历/一个话题的来龙去脉，1 块 = 一次可被完整回忆的经历；
  标题 1 行 + 完整第一人称叙述（长度由内容决定，200–1500+ 字都正常），带证据行、人物、块内注释。
- **不设配额**：一天可以 0 块（没活不硬整），也可以多块（真的发生了很多事）；不按"每件事一块"切。
- **同日合并**：模型判断同一天里属于同一段经历/同一主题的块应合并时，合并为更完整的块（保留全部细节与证据），
  不为了减少数量强行合并。
- **typed 注释**：facts/preferences/commitments 写在 episode.data.annotations；
  relations 写在 episode.data.relations；它们用于回答/实体/关系、承诺跟踪，但**不作为独立召回单位**。
- **召回**：一次 recall 返回 1–3 个 episode（标题+正文），给足上下文；人物问题仍走 whois/entity。

## 2. 数据模型（additive，旧命名空间归档而非迁移）

```jsonc
// namespace=episode, kind=block, key=epi:<day>:<hash(title)>
{
  "text": "一行标题",
  "data": {
    "body": "完整叙述（可分段：parts={groupId,part,total}）",
    "evidence": [{ "type": "day|note", "id": ..., "line": "...", "at": ... }],
    "provisional": false,
    "day": "2026-10-30",
    "people": ["3429502459"],
    "entities": ["entity:qq:3429502459"],       // syncEntities 回填
    "tags": ["B站"],
    "annotations": { "facts": [...], "preferences": [...], "commitments": [...] },
    "relations": [{ "from": "曾嘉睿", "to": "主人", "label": "舍友" }],
    "mergedFrom": ["epi:...", "epi:..."]          // 合并轮记录
  }
}
```

- 命名空间：`episode`（召回主单位，label 经历）、`entity`/`relation` 沿用；
  v2 的 `event/fact/preference/commitment` 在 v3 下不再写入，重建完成后归档（不可召回）。
- 开关：`dream.memorySchema = 'v2' | 'v3'`（默认 v2，安全回退；v3 默认作业改为 wash → episodes → people → lexicon → consume → cleanup → index）。

## 3. 夜间流水线（v3）

1. `wash`：原料清洗、day log（不变）。
2. `episodes`：按经历窗口分片 → 每片一次模型调用产出 episode（标题/正文/证据/人物/注释/关系）；
   同日写入后，**合并轮**再调一次模型判断哪些块应合并（不设数量目标）；没有值的内容输出 `[]`。
3. `people`：人物 synopsis（不变，供 whois）。
4. `cleanup`：块范围改为 `episode/person/slang`，提示词改为"合并同一段经历/同一主题的块，
   保留完整细节、不压缩成摘要；没得合并原样保留"。
5. `syncEntities`（每晚末尾，确定性）：给 episode 补 entities；合并 people→entity；
   从 episode 的 relations/正文抽 entity-to-entity 关系边；关系边随来源失效。
6. `index`：episode 标题+正文入向量索引。

## 4. 召回

- recall 的类别增加 `episode`（label 经历）；episode 命中时渲染**标题 + 完整正文**（受总 token 预算约束）。
- eager-recall 注入 episode 标题（一行），需要细节时由主动 recall 拉正文。
- 旧 v2 块不再写入；重建/归档后 v2 残留不会进入召回。

## 5. 重建与评测

1. **lab 重建**：三源 fixture（focus-core / QQ / live raw）都是 raw 回放，可直接用 v3 流水线重建，
   对比 v2 的成块形态、粒度、gold 证据覆盖、检索命中。
2. **episode 级评测口径**：gold 记忆按证据行映射到 episode（证据覆盖 ≥60% 或文本相近），
   统计 gold 覆盖率、块数/天、正文长度、证据覆盖、provenance、关系/注释质量。
3. **live 重建**：待 lab 验证通过后，从 raw 全量重跑（逐天、可中断、幂等），旧库归档备份；
   生产当前几乎没有新活动，是安全窗口。

## 6. 首跑原型（focus-core，5 天，fresh）

- episodes **36** 块（合并轮前 44），7.2 块/天（分布 4–14；busy 日仍多，但每块是完整叙述）；
- 正文平均 **267 字**、P50 231、P90 459；证据行平均 10；带人物 94%；
- gold 证据覆盖 **87.5%**（28/32；event 10/10、fact 4/4、relationship 2/2、person 5/6、commitment 5/7）；
- v2 对照：同素材 199 条原子块（事件块正文均 148 字，typed 记录 16–22 字），v3 块数约为 v2 的 1/5.5。

## 7. 待办

1. episode 级检索评测（r1/r3/r5 + 上下文可回答性），确认粗粒度召回是否真的更好；
2. QQ / live 素材重建对比；gold 映射与出现"合并后证据覆盖"的口径校准；
3. 合并轮 prompt 再校准（busy 日仍偏多；目标"自然合并"而非配额）；
4. live 重建脚本与切换流程（备份、归档、回滚、逐天幂等）；
5. 27B 在 episode 形成/合并上的 A/B（GPU 可用后）。
