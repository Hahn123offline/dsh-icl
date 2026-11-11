# 记忆子系统诊断与改造路线（2026-11-11）

> 读者：用户 + 后续会话。依据：`docs/MEMORY-AUDIT.md`（live 数据）、`docs/MEMORY-CODE-AUDIT.md`（代码逐行审计）、
> `docs/MEMORY-EXTERNAL.md`（外部框架/基准）、本会话对旧 `focus-core`/`dsh-qq` 真实数据的直接核对。
> 本文是决策后的总纲；具体实现设计与验收写进 `docs/MEMORY-EVAL-SPEC.md` 与各阶段文档。

## 0. 一句话

**当前记忆质量低的主因不在"模型记性"，而在写入侧：素材里 92% 是她自己的工具活动与环境通知，
身份没有主键，幂等靠"成功账本"而不是执行租约，去重发生在生成之后且只认字面相似。**
先把写入、身份、幂等和评测闭环修好，再谈 schema v2 与检索调参。

## 1. 已实证的根因（按影响排序）

| # | 根因 | 证据 |
|---|---|---|
| R1 | **两个写入真源、一个整理通道，无仲裁**：`remember`（强意图）与 day log（全量原文）都进 dream，但 events 只认 day log，并把全部未消化 note 标已消化。她想记的会被静默吞掉。 | 代码审计 F2；live `run:2026-11-09:events` notes:2/deferred:1；29 块 151 条 evidence 全为 day 型 |
| R2 | **raw 层没有"谁在说、说给谁、是否说出去了"**：708 行 raw 中 360 assistant + 291 tool = 92%；真正人类消息 39 行 + 12 条 QQ 信封。assistant 的未发送计划、工具结果、系统状态与"她对人类说的话"同权。 | live raw 组成统计（本会话）；审计 F6/§8；`days/2026-11-09.txt` 前 8 行 |
| R3 | **幂等模型选错**：`alreadyRan` 是"成功账本"而非"执行租约"。11-09 两个 trigger 相差 15.012s（一个 time tick）并行执行，events/cleanup 各跑两遍，产出 11 对重复块；`recordRun` upsert 把两次执行压成一行，审计看不见。 | 审计 F1（created/updated 差值取证）；`run:2026-11-09:events` |
| R4 | **事件身份靠"生成摘要的哈希"**：同一件事两次生成必然 paraphrase；确定性去重要求 Jaccard≥0.8，live 5 对实测 0.35–0.64，0/5 命中；真正修复它们的是下一次 LLM cleanup（不可靠、有窗口）。 | 审计 §2.2 + dedup.mjs 实测 |
| R5 | **person 没有稳定主键且已污染**：按显示名做 key；`aliases` 只存不用；`sameExperience` 对无 day 的 person 块直接放行 → 不同人可被算法合并。live：主人/Hahn123/周子涵 拆块；Hahn123 档案 ids 里挂着她自己的 QQ 2593621742；主人真实 QQ 3429502459 反而查不到档案；曾嘉睿 ids 里 QQ 写成群号。 | 审计 F4/F5/§6.2 |
| R6 | **质量闸门全在"生成之后"**：lexicon 从含工具结果的 day log 采集、靠 prompt 软规则，18/37 是工具/框架词且 recallable 180 天；note 先建再说；events 先写块后合并。生成前没有 role/来源/词表/状态机闸门。 | 审计 §7.1 + live audit |
| R7 | **衰减锚点与信号错**：`anchor = lastRecalledAt ?? createdAt`，只有主动 recall 才 boost；重要但从未被回忆的记忆慢性衰减到 0，而 live 主动 recall 只有 1 次。缺少独立的 importance / 提及信号。 | 审计 §5.1 + CLARITY.md；外部研究 §4 模式 9 |
| R8 | **可观测只到 job 级、评测闭环缺失**：dream-run 无法区分同 job 两次执行；审计工具把 superseded 算进块数；无金标、无指标、无 A/B，阈值（0.35/0.5）没有落盘标定结论。所以"召回无法验证"是基础设施缺失，不是模型不调用工具。 | 审计 §5.4/§9/§10；HANDOVER 优先事项 5/6 |

## 2. 用户已拍板的方向（2026-11-11）

| 决策 | 结论 |
|---|---|
| 测试素材 | **三源合流**：旧 focus-core 真实对话（642 条 messages 含 195 条用户发言 + 118 条 QQ 消息，10/27–10/31）、旧 dsh-qq 库（170 条，10/22–10/26）、当前 live raw 8 天（开发味重，作真实回归）；再自建中文合成场景做构造式金标；公开中文基准只做检索模块对照，不直接进仓库。 |
| 架构路线 | **分阶段演进**：先修输入源分类 / 幂等 / 去重 / 身份 / 评测闭环；再设计 typed schema v2（事实/事件/人物/承诺 + entity + provenance + validity）在 lab shadow 验证，达标后一次性迁移。 |
| 形成时机 | **夜间批量 + 规则候选捕获**：保留 dream 夜间批量（云端 deepseek-chat）；白天用 0 LLM 规则把用户话里的偏好/承诺/事实指针捕获为候选，防"当天没 dream 就全丢"。27b 本地模型保留作以后 LLM 抽取实验，不现在上。 |
| 记什么 | ① 用户/主人：事实、偏好、关系、近况；② 共同经历与事件；③ 她自己的承诺与未结事项；④ 群聊人物与社会关系（别名、群规则）。视觉/媒体暂以文本为主（已有图片嵌入模型，后续再扩）。开发/工具上下文不专门做门控，但也不应占据记忆主位。 |
| 工作方式 | Lead 自主迭代 + 关键决策停；只改仓库与 `.state/lab`，不碰 live state、不重启用户手动管理的 DSH Desktop；产品代码改动按 commit 交付，用户自行决定重启时机。 |

## 3. 目标形态（v2 设计约束，供后续设计文档落细）

不是换数据库，而是给现有 SQLite 加"身份 + 类型 + 证据 + 时效"四件套：

1. **source-aware raw**：每行 raw 带 `source.kind`（human / agent_visible / tool / env / memory_injected）、`channel`、`speaker`（QQ/群/自己/主人）。
   形成只读 human + agent_visible；tool/env 只作证据上下文。桥的冷启动投递路径补一次性 source 映射，不再丢来源。
2. **typed records**：`episode`（共同经历，证据=消息 id 集合）、`fact`（主体+属性/值+有效区间）、`person`（entity 档案）、`commitment`（承诺/未结）。
   事件身份由结构决定（day + 证据集合 + 主体），摘要只做展示。
3. **entity + alias**：账号优先、显示名是 alias；`selfId`/`ownerQQ` 是产品已知事实，进入身份链；允许显式 alias 合并与撤销，
   模型不能凭单轮猜测合并身份；不同人的块禁止算法合并。
4. **provenance + confidence**：每条事实/事件必须有可解析到 raw 行的 quote 证据；无出处标 `provisional`，读取层显示"不确定"，不静默当事实。
5. **validity**：新事实与旧事实冲突时旧事实标 `invalidatedAt`（不删），查询默认只看有效；保留历史与"她以前以为是"的叙事。
6. **importance**：1–5，规则初值 + 形成时打分（以后可用 LLM），参与衰减与注入排序；衰减不再只看"是否被主动回忆"。
7. **两段式写入**：白天规则候选（0 LLM，权威数据是 raw 指针）→ 夜间 dream 整合（意图合并、去重、身份解析、证据校验）。
8. **单飞与状态机**：`run()` 有单飞锁；job 有 `queued/running/success/failed/skipped` 执行记录与 attempt id，
   重复执行可见、可恢复、可重试；账本不再用 upsert 压掉事实。
9. **评测闭环**：gold fixture + 指标 + A/B + CI gate。任何"优化"必须用同一 fixture 证明净收益（外部研究：记忆可能产生负税）。

## 4. 分阶段路线与验收

### Phase 1（本轮）：写入正确性与评测地基

| 工作 | 验收 |
|---|---|
| dream 单飞锁 + 执行状态机 + attempt 账本 | 并发双 `run()` 不产生重复块；账本可区分两次执行；单测覆盖 |
| 修 F2/F3/F4：remember 不被吞、空输出不冒充成功、person 不跨人合并 | 三条复现脚本转成回归测试并变绿 |
| raw 来源分类 + 记忆素材 profile | wash/events/people/lexicon 只把 human/可见 agent 文本当主材料；工具/环境行只作证据；指标：self-source 条目占比显著下降 |
| day 归属：凌晨 dream 整理"刚结束的那天" + 一天补洗 | 构造 02:09 触发用例，day 应指向前一天 |
| recall/whois/记忆读取链修复（lexicon 可召回、alias 参与匹配、provisional 显性化、精确串分支） | 定向单测 + 复现脚本 |
| 评测工具与三源素材落地 | `node tools/memory-eval.mjs` 可对 fixture 出 formation/retrieval 指标；CI 可跑 deterministic 子集 |

### Phase 2：数据与阈值

用 Phase 1 的评测跑三源 fixture，得到基线指标；标定 eager/recall 阈值；修 lexicon 门控、note 生命周期、
去重阈值；输出第一份"改前/改后"对照报告。验收：formation P/R、dup%、self-source%、recall@5/MRR 有基线数字。

### Phase 3：typed schema v2 shadow

在 lab 用同一 raw 并行跑 v1/v2 两套形成与检索，比较指标与成本；v2 胜出且迁移脚本可逆才切 live。
验收：v2 shadow 在 formation/recall 上不劣于 v1，重复率与身份错误率显著更低，迁移可回滚。

### Phase 4：长期运行验证

live 只做影子记录（不打扰用户）；每周重放"英雄场景"（称呼、偏好、承诺、共同经历、别名）测漂移；
把 live 指标接进同一条评测口径。

## 5. 明确不做（本轮）

- 不迁图数据库/Neo4j；不整包移植 Mem0/Zep/Letta/MemOS；不复制第三方代码或 prompt。
- 不引入每轮 LLM 抽取/judge（成本与外部证据都不支持）；不做七情式动态人格。
- 不直接改 live memory.db；不重启 DSH Desktop；不在当前 live 库上做算法基线。
- 视觉/媒体记忆 v2 之前不专门扩展，先以文本为主。

## 6. Phase 1 进展（2026-11-11 晚，本会话）

已完成并进 `master`（commit `43e72ef` / `f4c2e03` 之后）：

| 项 | 结果 |
|---|---|
| dream 单飞 + 租约/attempt 账本 | 信号双触发第二个返回 `skipped:in-flight`；job 有 running/success/failed/skipped 终态与 attempts 记录；崩溃遗留 running 可过期重领。回归：`packages/core/test/memory-p0.test.mjs` F1/F3 |
| 显式 remember 不被吞（F2） | 有 day log 时 note 也作为独立材料片（证据 `n<id>`）；只标被引用/被正文覆盖的 note，其余保持待消化可重试 |
| 垃圾/空输出不当成功（F3） | `parseJsonStrict` 区分 empty/no-json/bad-json 与合法 `[]`；events/cleanup/lexicon/people 解析失败 = job 失败可重试 |
| 跨人合并（F4） | 确定性去重只允许 event/slang 且要求同 day + 证据重叠；person 一律不参与算法合并（身份合并只走显式 alias） |
| 身份链（F5） | 人物 subject 按 selfQQ/ownerQQ/ownerNames 归一；selfQQ 不允许挂到别人 ids；`aliases` 参与 findPerson；cleanup 先做**已知身份确定性归并**（主人/Hahn123 → person:3429502459）；event.people 显示名归一成 QQ |
| 形成材料来源门控（F6） | wash 给每行打 `source`（human/qq_envelope/agent_visible/agent_internal/tool/env）+ `rowIds`；events/people/lexicon 只吃 human+qq_envelope+agent_visible，工具/环境/内部计划不进入形成材料 |
| day 归属（F7） | 凌晨（默认 <4 点）触发自动整理"刚结束的那天"（`dream.dayCutHour`），修 11-07 整日丢失机制 |
| 读取链（F8/F9/F10） | recall 可召回 lexicon；精确串加成在无嵌入时也生效；provisional 块在 recall/eager/whois 里显式标"存疑"；whois 用全部 ids/aliases 找最近事件；eager 不再注入已消化 note |
| 语料闸门（R6） | 工具名/标识符（mcb_* / kebab-case / 带数字 ASCII 等）确定性拒绝，`skippedJargon` 入账 |
| 审计口径（F12） | `tools/memory-audit.mjs` 排除 superseded 算块数/近重复，新增形成来源（human-backed/self-source/provenance）与 dream 执行级（attempt/失败/滞留 running）统计 |

**live 复测（新增审计口径）**：29 个 event 块中 10 个已 superseded，存活 19 个，近重复对 **0**——
旧结论"5 对未清理"是审计工具把软删块算进去导致的；真正的重复执行证据是账本 attempt/updated_at。
provenance 0/101 是因为历史 day log 没有 `sources` 表（新数据开始有），不是块本身没证据。

**测试**：全仓 897 tests / 896 pass / 1 skip（skip 为 ffmpeg 依赖样例）。

**下一步（Phase 1 收尾 → Phase 2）**：
1. 三源 fixture 与评测工具已落地（docs/MEMORY-PHASE1-REPORT.md §3）：live raw-all→raw-main 门控收益已量化；synthetic 云基线已跑（formation recall 71–79%，retrieval recall@5 仅 11–32%）；
2. Phase 2 优先修检索层（block 摘要/探针措辞、查询扩展、person 路径、MMR/注入预算）并用 synthetic retrieval 指标证明收益；再标定 eager/recall 阈值；
3. bridge 侧补 raw 的 sourceKind/channel/speaker 元数据（现在靠 dream 侧文本/角色推断），让"谁在说、说给谁"成为一等公民；
4. 开始 typed schema v2 设计（`docs/MEMORY-V2-DESIGN.md`），先在 lab shadow。

**Phase 2 第 1 段（2026-11-11 第 2 轮，commits `70bb201`/`c6586cf`，详见 `docs/MEMORY-PHASE2-REPORT.md`）**：
- bridge raw 层补 `sourceKind/channel/speaker`（QQ 信封→qq_envelope、环境通知→env；day log 行首带 `名字(QQ)`），
  people 用确定性说话人证据落 person note；
- typed v2 add 层：`fact`/`preference`/`commitment` 作为独立可召回记录，由 events 同一次调用顺带抽取、跨天去重；
- 评测口径修两处：dupRate 不再把"共享证据的 typed 事实"算重复；matcher 支持长 gold↔短事实的二元组召回/分句覆盖。
- 真实 5 天 focus-core fixture：matched 15→18，recall 46.9%→56.3%，fact recall 0%→50%，event 60%→70%，provenance 100%；
  retrieval 仍差（no-embed r5 25% / embed r3 33%，miss 67%）→ 下一轮主攻检索层。

**Phase 2 第 2 段（第 3 轮，commit `a8f88ad`）**：评测链修复后真实 5 天 focus-core 基线跃升——
formation matched 18→27/32、recall 56.3%→**84.4%**、dup 1.0%、provenance 100%、selfSource 23.6%；
根因是 dream 输出 token 预算截断繁忙日 JSON（修：3500 tokens + 调用/解析重试 + 坏片对半拆）、
旧 raw 中英混排 reasoning 误标为她说的话（修分类器）、recall minSim 无标定（标定为 0.5，falseInjection 100%→0）。
检索两段验证：seed=gold（只测检索）r1 79%/r3 83%/MRR 0.882/falseInjection 0；
seed=formation（端到端）r3 50%——下一轮修"形成→检索"的排序/多样性/person 路径。

**Phase 2 第 3 段（第 4 轮，本轮）**：形成→检索桥——`memory.search` 加时间旅行保护（不返回未来记忆）、
评测 replay 时间对齐（当天 00:00 建库，同日探针可见）、person 画像最多占 1 条召回配额、低置信命中标 `[记得不太清]`、
recall minSim 按两套数据重标定为 0.45（seed=gold r5 83.3%/falseInjection 0；端到端 r3/r5 50%→66.7%、miss 50%→33.3%）。
剩余失败可定位：多跳长问句需查询改写、1 条 gold/probe 时间错位、person 多块 parse、负例内容词门槛 → 下一轮。

**Phase 2 第 4 段（第 5 轮，本轮）**：检索诚实度 + validity 第一版——查询内容词门槛（泛词面相似但
内容词 df=0 → 判"没找到"；修未整理笔记不服从 conv 过滤、空结果回显用户原话）；端到端 retrieval
r3/r5 **60%/80%**、miss **20%**、falseInjection **0%**（同一 focus-core 5 天 fixture，fresh run）；
typed 旧值失效：`invalidates` 字段 + 独立 validity 对照调用 + cleanup 结构化层保护，修掉
parseJsonStrict 对象包裹导致映射不生效的 bug；合成偏好变化 fixture 的旧咖啡偏好已确认软失效
（DB 链 supersededBy=preference:2026-04-07:…），评测口径区分"历史事件块"与"同类型 typed 仍存活"。
下一轮：评测 repeat=3 稳定性 + validity 抽审 + 查询改写/person 多块 parse。

**Phase 2 第 5 段（第 6 轮，本轮）**：三源闭环首次同时跑通（focus-core / old-qq / live raw）：
端到端 r5 分别 83.3% / 35.7% / 83.3%，formation recall 81.3% / 90.0% / 100%（live gold 仅 4 条）；
recall 增加"复合问句拆查询兜底"（整句优先、候选不足才拆子句）；评测口径把"同一段证据派生的
event 块与 typed 记录"视为等价表示（修掉 QQ 素材 0%→14.3% 的假性 miss）；
memory-audit 新增 typed 失效链审计（live 47 / superseded 62、悬空链 0）。下一轮攻 QQ 多跳检索与负例注入。

**Phase 2 第 6 段（第 7 轮，本轮）**：QQ 多跳检索补齐——严格 floor 没命中时用放宽 floor 二轮搜
（结果标"记得不太清"），QQ 端到端 r5 35.7%→64.3%、miss 57.1%→28.6%，focus/live 不变
（83.3% / 83.3%，focus falseInjection 0）；raw 原文补细节加内容词门槛（live 负例恢复"没找到"）；
eval 新增 `--fresh` 测运行间方差：两次独立 fresh run 的 e2e r5 90%/80%、formation recall 均 78.1%，
门控将用 3 次均值。剩余 falseInjection 为"提到但没答"负例，下一轮加答案类型/实体一致性检查。

**Phase 2 第 7 段（第 8 轮，本轮）**：检索日期归一（问句"昨天/10月25日"→同日记忆加分）：
QQ r1 50→64.3%（MRR 0.714）、live r1 66.7→83.3%，focus 保持 83.3% r5；
同 fixture 三次 fresh run 定稿方差：formation recall 三次均 78.1%，e2e r5 均值 85.6%（极差 6.7pt）、
miss 均值 6.7%、falseInjection 恒 0；validity 加置信上限（每天≤4 条、仅同类型、可审计）。
负例「提到≠回答」调研结论：纯词面 marker 无法区分，需下一轮做返回条目的语义校验。

**Phase 2 第 8 段（第 9 轮，本轮）**：新增 `tools/memory-gold-review.mjs`（不调模型）抽审 gold：
focus-core 32 条 gold 里 22 条无 probe 引用、3 个 probe expected 无法映射；QQ 20 条里 11 条无 probe；
live 4 条无问题——评测信噪比瓶颈在"probe 覆盖/gold 完整性"，下一轮优先补 probe 再调参。
validity 每日上限（≤4 条、同类型）fresh 复测：合成偏好 fixture R 78.6%、失效链结论不变
（旧偏好仅历史块、旧承诺同类型 stale 1 例为部分匹配误判），未出现"该失效没失效"。

**Phase 2 第 9 段（第 10 轮，本轮）**：按 gold-review 清单补 probe（focus 19 个、QQ 14 个）；
memory.search 字面通道改看"摘要+正文"（事件块 body 才有用户问法）→ focus r1 31.3→37.5%、r3 75→81.3%，
QQ r1 62.5→70.8%；内容词门槛精修（只看摘要、放宽轮只看前 3 条、单条领先者规则区分有无嵌入），
live 负例"午饭吃了什么"恢复"没找到"。补 probe 后暴露下一轮目标：同一天同主题重排、关系类召回、
person 多块 parse、answer-adequacy。

**Phase 2 第 10 段（第 11 轮，本轮）**：意图感知重排（问经历→事件、问承诺/偏好→typed、问人→person，
person 配额 2）+ 放宽二轮改为"候选<2 就补"（修 QQ 单候选卡死）+ person 探针 whois+recall 双路径
（focus p-04 转 hit）。三源 r3/r5：focus 90.6%、QQ 79.2%、live 91.7%；miss 6.3%/16.7%/0%；r1 小幅回落
（31.3/62.5/83.3）。剩余：关系实体对检索（focus p-19）、指代消解（QQ p-07）、answer-adequacy。

**Phase 2 第 11 段（第 12 轮，本轮）**：实体对/关系检索——问人意图且问句含≥2 个已知实体时，
用"实体对 + 关系"补搜并按正文同时提到双方加分（×2.2/×1.1）。三源 r3/r5：focus 87.5/93.8%、
QQ 79.2%、live 91.7%；miss 6.3%/16.7%/0%。focus p-19 已进入候选（raw 第 9），距命中只差关系句打分。
扩 probe 后 gold 未覆盖从 22 降到 12 条。下一轮：关系陈述打分、指代消解、answer-adequacy、方差门控。

**Phase 2 第 12 段（第 13 轮，本轮）**：关系陈述优先排序（问人意图且≥2 实体时，非人物档案的
"同时提到双方+关系词"块排前）→ focus p-19 转 hit，focus **miss 6.3%→0%、r5→96.9%**；
新增指代变体（raw 最近发言人替换他/她/TA，三源暂无收益，QQ p-07 根因是 gold↔extracted 映射粒度）。
三源：focus r5 96.9/miss 0、QQ r5 79.2/miss 16.7、live r5 91.7/miss 0。下一轮：answer-adequacy、
3-run 方差门控基线、QQ gold 映射抽审、validity 抽审。

**Phase 2 第 13 段（第 14 轮，本轮）**：新增 `docs/MEMORY-BASELINES.md`——3 次 fresh 方差定稿
（focus formation R 均值 80.2%、端到端 r5 均值 81.7%/极差 17.5pt、falseInjection 恒 0）与建议门控；
新增 `tools/memory-answer-adequacy.mjs`：三源真负例 judge 全判"提到但没答"→ adequacy-adjusted
falseInjection **0**（原始 falseInjection 高估）；validity 加确定性否定词兜底：合成偏好 fixture
stale 2→0、R 78.6→85.7%，audit 失效链 dangling 0/缺失时间 0。下一轮：门控落地、adequacy 指标化、
QQ gold 映射抽审、validity 人工抽审。

## 7. 文档索引

- `docs/MEMORY-CODE-AUDIT.md`：代码级问题清单（P0/P1/P2 + file:line + 复现命令）
- `docs/MEMORY-AUDIT.md`：live 数据审计（注意其"5 对重复未清理/12 组 run+skip"结论已被审计员修正，见 CODE-AUDIT §0.2）
- `docs/MEMORY-EXTERNAL.md`：外部框架/基准/评估方法（29 条文献）
- `docs/MEMORY-EVAL-SPEC.md`：fixture 格式、指标、runner 契约（Phase 1 交付）
- `docs/MEMORY.md`：旧算法说明（**已过时**，Phase 1 结束后按代码重写或加显著失效声明）

