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
| 检索 r1/r3/r5 | 30/84/91% | **62.1 / 85.0 / 93.6%** |
| miss | 6.7–11.8% | **0%** |
| falseInjection | 0% | 0% |

### 2.1 三源 episode 级结果（fresh，同口径；v3 已接入 episode 检索）

| 素材 | episodes | 正文均长 | gold 覆盖 | r1 | r3 | r5 | miss |
|---|---:|---:|---:|---:|---:|---:|---:|
| focus-core | 27 | 362 字 | 81.25% | 62.1% | 85.0% | **93.6%** | **0%** |
| old-qq | 11 | — | 60.0% | 80.0% | 80.0% | **80.0%** | 10.0% |
| real-live | 26 | — | 87.5% | 77.8% | 88.9% | **88.9%** | 11.1% |

- 对照 v2 同素材：focus r5 91.1%/miss 6.7%、QQ r5 76.9%/miss 15.4%、live r5 85.7%/miss 14.3%
  → **v3 三源检索均不低于 v2（focus/QQ/live 分别 +2.5/+3.1/+3.2 个点，miss 更低）**。
- episode 检索改动（本轮）：实体对问题直接扫 episode（entity 层 aliases 覆盖所有称呼，解决
  "曾嘉睿和 Hahn123" 这类同人多称呼问题）；episode 正文内容词命中数加分。
- 口径提醒：QQ 的 gold 覆盖 60% 说明部分"原子 gold"没有逐条对应到 episode（粗块按经历合并后
  不再一一列举）；期望映射未解析的 probe 会被排除出 recall 指标，因此 QQ r5 80% 有幸存者偏差，
  下一轮需要补"episode 内容完整性"指标（gold 内容词覆盖率）而不是只报命中率。

## 3. 当前结论与问题

- **成块形态达标**：块大、上下文完整、非配额化；focus gold 覆盖与 v2 formation recall 持平，
  同一段经历自然合并（合并轮）；用户已确认形态"最接近理想记忆块"。
- **episode 检索已达到/超过 v2**：三源 r5 93.6/80.0/88.9，对照 v2 91.1/76.9/85.7，miss 全部更低。
  本轮关键修复：episode 正文内容词命中数加分 + 实体对问题直接扫 episode（用 entity aliases，
  覆盖"曾嘉睿/Hahn123/离线版/周子涵"这类同人多称呼）。
- **仍需补的口径/质量项**：
  - QQ gold 覆盖仅 60%：粗块没有逐条列举"原子 gold"的内容，且期望映射未解析的 probe 被排除；
    需要新增"episode 内容完整性"指标（gold 内容词在 episode 正文中的覆盖率），避免幸存者偏差；
  - QQ 每 5 天只形成 11 个 episode（材料稀疏，符合"没活不硬整"，但需要确认没有漏掉真实经历）；
  - live 负例 raw falseInjection 50%（v2 同），仍需 adequacy judge 口径复核；
  - 三源只跑了一次 fresh，需要重复采样看方差。

## 4. 下一步（本目标内）

1. episode 内容完整性指标 + QQ/live 覆盖缺口抽审（是"没写进去"还是"换一种说法没匹配"）；
2. 重复采样（每源 2–3 次）看 v3 方差，更新 baseline；
3. 重建 runner（raw → v3 逐天幂等、可中断、旧库归档）在 lab 三源跑通；
4. 三源通过后出 live 重建 dry-run 清单，停下来等用户确认。
