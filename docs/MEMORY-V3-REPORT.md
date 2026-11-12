# 记忆 v3 报告：episode 形态与 episode 级评测（2026-11-12，进行中）

> 用户口径：episode 为主单位（不设数量/长度硬指标、没活不硬整）；typed 降级为块内注释；
> 重建后旧记忆归档。设计见 `docs/MEMORY-V3-DESIGN.md`。

## 1. 已落地

- `dream.memorySchema = 'v3'`：默认作业 wash → episodes → people → lexicon → consume → cleanup → index；
- `episodes` 作业：按经历窗口产出 episode（标题 + 完整第一人称正文 + 证据 + 人物 + 注释 + 关系），
  加一次**同日合并/改写轮**（只合并同一段经历/主题，保留全部细节；没有可合并就 []）；
- `episode` 命名空间（label 经历）纳入 recall，命中时返回**标题 + 完整正文**；
- cleanup 的块范围改为 episode/person/slang，合并时**并集证据/注释/关系**（v2 时合并会丢证据）；
- entity/relation 同步覆盖 episode（people→entities、relations→关系边、正文关系词兜底）；
- eval harness 新增 `--schema v3`：episode 级 formation 指标（块数/天、正文长度、证据覆盖、注释数）
  与 gold→episode 证据映射（多对一：一个 episode 可同时是多条 gold 的答案；person gold 同时挂
  person 档案与覆盖它的 episode，两种读路径都能命中）。

## 2. 首轮 A/B（focus-core 5 天，fresh；episode 级口径）

| 指标 | v2（原子事件块） | v3（episode） |
|---|---:|---:|
| 记忆块数 | 199 条 | **27 块**（5.4/天；分布 4/7/5/9/2） |
| 正文均长 | 148–177 字 | **362 字**（P50 380 / P90 616；单次探针最高 442 均） |
| 证据行/块 | 少而碎 | **11 行** |
| 带人物块 | — | 92.6% |
| gold 覆盖 | formation R 81.3% | **81.25%**（person 6/6、fact 4/4、relationship 2/2、event 7/10、commitment 5/7、preference 2/3） |
| 检索 r1/r3/r5 | 30/84/91% | 44.3 / 65.0 / **73.6%** |
| miss | 6.7–11.8% | **21.4%**（3/14） |
| falseInjection | 0% | 0% |

## 3. 当前结论与问题

- **成块形态达标**：块大、上下文完整、非配额化；gold 覆盖与 v2 formation recall 持平，
  同一段经历自然合并（合并轮）；用户已确认形态"最接近理想记忆块"。
- **检索还没跟上**：v3 只积累 27 个 episode，但 r5 73.6% 低于 v2 的 91%。
  剩余 3 个 miss 都是"语义/多跳"问题，不是字面缺失：
  - p-06「刚才测试连 MC 的结果」→ 期望 episode 排名靠后被挤出 top5；
  - p-16「答应补什么能力 / 为什么看不到图片」→ 问句与 episode 正文措辞差异大；
  - p-19「曾嘉睿和 Hahn123 是什么关系」→ 需要 entity/关系对检索，目前只靠整句相似度。
- 这说明 v3 的下一步不是改形成，而是**给 episode 设计检索**：
  ① 标题/正文分段多向量或正文关键段索引；② 查询-块 LLM 重排（top10 里选 1–3 块）；
  ③ 关系/实体对问题直接走 relation/entity 通道；④ 日期/指代改写迁移到 episode 口径。
- 评测口径注意：v3 的 r5 是"episode 级命中"，与 v2 的 atomic 命中不完全等价；
  但同 probes/gold 下仍可直接比较，差距是真实的。

## 4. 下一步（本目标内）

1. episode 检索方案 A/B（多向量 vs LLM rerank vs 关系通道），把 r5 拉回 ≥90%；
2. QQ / live raw 重建跑 v3 评测，确认非 focus 素材同样成立；
3. 重建 runner（raw → v3 逐天幂等、可中断、旧库归档）在 lab 跑通；
4. 三源通过后出 live 重建 dry-run 清单，停下来等用户确认。
