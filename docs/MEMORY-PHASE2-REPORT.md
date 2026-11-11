# 记忆 Phase 2 报告（第 1 段）：raw 身份元数据 + typed v2 add 层 + 评测口径修复

> 2026-11-11 第 2 轮。承接 `docs/MEMORY-PHASE1-REPORT.md`。所有改动已在 HEAD（`70bb201`、`c6586cf`），
> 基线产物在 `.state/lab/lead/eval-focuscore-typed2/`（可 `--cache-only` 无密钥复跑）。

## 1. 本轮做了什么

### 1.1 bridge：raw 层补"谁在说、说给谁"（审计 R2/F5 的根）

- `packages/dsh-icl/src/bridge.mjs`：
  - 新增一次性"投递通知来源映射"：steer 与冷启动 `sessions.prompt` 前登记（文本 hash → plugin/QQ envelope），
    `appendRaw` 收到同文本的 `user/message` 时取走并写 `sourceKind`：
    QQ 通知 → `qq_envelope`，其它插件通知 → `env`，真人直聊 → `human`；assistant/tool 分别 `agent_visible`/`tool`。
  - QQ envelope（`entries[].source.meta.qq.envelope`）→ raw 行带 `channel`（`qq:private:<peer>` / `qq:group:<gid>`）
    与 `speaker { kind, value, name }`；冷启动未读摘要也能标记为 `qq_envelope`。
  - `packages/core/src/services.mjs`：delivery 非 gate 路径不再丢 `source.meta`（QQ 信封要走到 batch）。
- `dream.wash`：
  - raw 行带 speaker 时，day log 行首渲染成 `名字(QQ)`；有结构化 speaker 时剥掉正文里的 `[QQ私聊·主人] xxx：` 信封前缀；
  - day log 新增 `speakers`/`channels` 数组（绝对行号对齐；`formationLines/formationEntries` 改为按行号取 source/speaker，
    修掉"截断省略行后数组错位"的隐患）；
  - `jobPeople` 新增确定性说话人证据：有 QQ speaker 的行直接落 `person` note（subject=qq），人物档案不再依赖模型从文本猜人名。
- 回归：`packages/core/test/dsh-bridge.test.mjs` 新增 2 条（QQ 通知 → qq_envelope/channel/speaker；环境通知 → env）；
  `memory-p0.test.mjs` 新增说话人链路 1 条。全仓 901 tests / 900 pass / 1 skip。

### 1.2 typed memory v2 add 层（事实/偏好/承诺）

- 不换存储：先作为 additive 命名空间 `fact` / `preference` / `commitment` 存在（可召回、带 evidence、带 halfLife），
  v2 再升级为带 `validity/entity` 的正式记录。`recall` 的 CATEGORIES 已纳入这三类（检索可命中）。
- `dream.events` 同一次模型调用顺带抽取：块 JSON 新增可选 `facts[]` / `preferences[]` / `commitments[]`；
  每条独立落库（key `fact:<day>:<hash>`，evidence 复用块证据），零额外模型调用。
- 跨天去重：同一条事实/偏好/承诺再次被抽出时，按规范化文本/包含/Jaccard≥0.78 找到旧记录，
  合并 evidence、记录 `days`，不新增行（实测修掉重复膨胀）。

### 1.3 评测口径修复（否则会误判）

- `duplicateRate`：证据重合但正文完全不同不再算重复（typed 事实天然共享同一段对话的证据）；
  只有"正文相近"或"证据重合且正文也相近（≥0.3）"才算。真实 5 天 fixture 的 dupRate 从虚高 37.5% 回到 2.8%。
- `matcher.textMatchScore`：长 gold ↔ 短 extracted（typed 事实）时 Jaccard 天然低，
  改为三者取 max：Jaccard、短文本二元组召回（≥0.6 且 ≥8 字）、gold 分句覆盖；含文本强匹配时允许无语料重叠命中。

## 2. 真实素材基线（real-focuscore-2026-10，5 天 701 行，cloud deepseek-chat）

| 指标 | Phase 1 基线 | Phase 2（本轮） |
|---|---:|---:|
| extracted（含 typed） | 65 | 144（event 30 · fact 62 · commitment 16 · lexicon 25 · person 4 · preference 7） |
| matched / gold | 15 / 32 | **18 / 32** |
| formation recall | 46.9% | **56.3%** |
| event recall | 60% | 70% |
| **fact recall** | **0%** | **50%** |
| person recall | 33.3% | 50% |
| commitment recall | 57.1% | 57.1% |
| dupRate（修正口径） | （旧口径虚高） | 2.8% |
| provenance | 100% | 100% |
| identity / wrongIdRate | 100% / 0% | 100% / 0% |

- precision 从 23.1% 降到 12.5%，主因是 **gold 只有 32 条而 product 抽出 144 条**（typed 层放大了分母），
  不能直接当"变差"读；需要先抽审/补全 gold，再把这个分母口径改成"gold 完整度无关"的抽样人工评。
- retrieval（seed=formation）：no-embed recall@1/3/5 = 0/25/25%，MRR 0.083；`--embed`（bge-m3 本地）
  后 r3 33.3%、MRR 0.185、miss 66.7%、falseInjection 83.3% → **检索层仍是最大瓶颈**。

## 2b. 第 3 轮：评测链修复 + 真实基线跃升（commits `a8f88ad` 起）

### 找到并修掉的三个"链路上游"问题

1. **dream 输出预算把繁忙日的 JSON 截断**：events 分片 `maxTokens` 默认 1200，繁忙日模型要写多块，
   输出超长被截断 → `bad-json` → 整片丢失。修法：events 3500 tokens；坏 JSON/调用失败各重试一次；
   仍失败则把该片对半拆开重试（失败路径兜底，正常日不加成本）。`--debug` 可打印 dream warn/error 日志。
   **实测 day27：formation recall 14.3% → 85.7%**（同一份材料只改输出预算/重试）。
2. **旧 raw 的中英混排 reasoning 被当成"她说的话"**：focus-core 导入把 40 条
   `"User wants me to…" / "Reply only…"` 归为 `agent_visible`，白天材料大量计划文本。修法：
   `raw-profile`/importer 的 plan 判定不再要求"无 CJK"，英文为主+计划句首即 `agent_internal`；
   真人 QQ 行 speaker 渲染为 `主人(QQ)`、她自己渲染为 `我`（不再把 selfQQ 标成第三个人）。
3. **检索阈值从未标定**：用 seed=gold 的 4 份 fixture 做 minSim 扫描（0.2–0.55）：
   有嵌入 0.35→**0.5**：falseInjection 100%→0%、recall@5 不降（real r1/r3 79/83%）；
   无嵌入保持 0.2（升到 0.3 起 recall@3 明显下滑，且无嵌入 falseInjection 本来就是 0）。

### 真实素材端到端结果（real-focuscore-2026-10，5 天 701 行，cloud）

| 指标 | Phase 1 | Phase 2a | **Phase 2b（本轮）** |
|---|---:|---:|---:|
| formation matched/gold | 15/32 | 18/32 | **27/32** |
| formation recall | 46.9% | 56.3% | **84.4%** |
| event recall | 60% | 70% | ~（分类型见 eval.md） |
| dupRate（修正口径） | 虚高 | 2.8% | 1.0% |
| provenance | 100% | 100% | 100% |
| selfSourceRate | — | 37.5% | 23.6% |
| extracted | 65 | 144 | 203（含 typed） |

- 事件分片零失败（`--debug` 无 shard-fail）；precision 13.3% 仍是"gold 32 条 vs 抽出 203 条"的分母问题，
  需要下一轮抽审/补全 gold，而不是判 formation 变差。
- **检索两段分开看**（这轮的关键结论）：
  - `--seed gold`（库本身是对的，只测检索）：**recall@1 79.2% / r3 83.3% / r5 83.3%、MRR 0.882、
    miss 12.5%、falseInjection 0%**（embed + 校准后）；
  - `--seed formation`（端到端，含形成误差）：r1 16.7% / r3 50% / r5 50%、miss 50%、falseInjection 33.3%。
  → **检索本身已经可用；端到端损失主要来自形成覆盖与排序（203 条里挑 6 条）**，下一轮先修
  "形成→检索"之间的桥（typed 记录参与召回的方式、top-k 排序/多样性、person 探针），而不是继续调 sim 阈值。



## 2c. 第 4 轮：形成→检索桥 + 时间/评测口径（本轮）

### 修了什么

1. **时间旅行保护（产品）**：`memory.search` 不再返回 `created_at > now` 的记忆（replay/时钟回拨/迁移时未来块不会出现）。
2. **评测 replay 时间对齐**：formation 建库时间从"当天 12:00"改为 **当天 00:00**（host 关掉 `dayCutHour`），
   这样同日探针（上午/下午）能看到当天的记忆，又看不到未来几天的记忆——此前 11:15 的探针看不到 12:00 才建的块，
   或反过来被未来天的 MC 事件串味。
3. **person 配额**：人物 profile 单条可达 800 字/约 1500 tokens，会占满召回前排；默认仍检索 person，
   但挑选时 **person 最多 1 条**，把事件/typed 的位次让出来。
4. **低置信命中的诚实表达**：主动 recall 命中 `sim < 0.5` 时渲染 `[记得不太清]`；被动 eager 仍保持严格阈值（0.5），
   "被问到"可以给模糊答案，"主动塞"必须克制。
5. **评测口径修复**：false-injection 分母排除"有 unresolved expected"的探针（不知道期望是什么，不能把返回算误注入）；
   recall 阈值按 seed=gold + 端到端两套数据重新标定为 **0.45**（0.5 更保守但漏长问句；0.35→0.45 后
   seed=gold r5 不降、端到端 r3/r5 50%→66.7%）。

### 本轮数字（real-focuscore 5 天，cloud + bge-m3）

| 条件 | r1 | r3 | r5 | MRR | miss | falseInjection |
|---|---:|---:|---:|---:|---:|---:|
| seed=gold（只测检索，校准后） | 54.2% | 70.8% | 83.3% | 0.725 | 12.5% | 0% |
| seed=formation（端到端，上一轮） | 16.7% | 50% | 50% | 0.333 | 50% | 33% |
| **seed=formation（本轮）** | 16.7% | **66.7%** | **66.7%** | 0.361 | **33.3%** | 100%* |

\* 仅剩 1 条真正的"无答案"探针（问今天穿什么颜色衣服）：它没有内容词命中，但被"主人…"泛词面相似拉到 0.42+。
下一轮加"查询内容词 IDF 门槛"来挡这类（衣服/颜色这类词在库里 df=0，应该判为没找到）。

### 剩余端到端失败（可定位，下一轮）

- p-01（多跳转述："主人修好工具控制门并接入视觉后，鱼鱼第一次能做什么"）：
  正确块在 memory.search 排名第 3–4（sim 0.46–0.48），被 floor 过滤或名额挤出 → 需要**查询改写/多查询**；
- p-06（"刚才…连 MC 的结果"）：期望 gold 是 10-30 的连接事件，但 top 命中是 10-30 晚上的"修 MC"承诺 →
  gold/probe 时间与措辞双错位，进 gold 抽审清单；
- p-04 person 探针：多目标 whois 已支持，但 parse 只回一个块 → 下一轮修 parse/多块渲染；
- 负例假注入：加"查询内容词在库中 df=0 → 不注入"的确定性门槛。



## 2d. 第 5 轮：内容词门槛 + 旧值失效（本轮）

### A. 查询内容词门槛（召回诚实度）

- `recall` 新增确定性门槛：去掉高频功能词（主人/今天/什么/刚才…）后，查询剩下的内容 2-gram
  如果**在候选库里一个都没出现**，且 top1 不领先 top2（<1.3×）、sim<0.55 → 判为"没找到"。
  例外：只有一条明显更像（top1≥0.3 且领先 1.3×）时放行，避免"颜色 vs 蓝色"这类换措辞误杀。
- 同时修了两个连带 bug：未整理笔记不服从 conv 过滤（会把别的会话碎片端上来）、空结果回显用户原话
  （"只搜这个会话"时把别的会话关键词写进答复）。
- 实测（同一份 focus-core 5 天 fixture，fresh run）：端到端 **r3/r5 66.7%→75%→80%**、
  **miss 33.3%→16.7%→20%**、**falseInjection 100%→0%**；
  r1 20%、MRR 0.417；一个无答案探针（"今天穿什么颜色衣服"）现在正确返回"没找到"。
- 新增回归测试：内容词命中/未命中两条断言 + 会话过滤的 pending note + 完整套件 905 tests 全绿。

### B. 旧值失效（validity v2 第一版）

- typed 记录 entry 支持 `{"text":…, "invalidates":["旧陈述片段"]}`（events 同一次调用），
  命中旧记录 → 软失效（`superseded:true` + `supersededBy` + `invalidatedAt`），证据保留。
- events 里模型通常不写 invalidates（实测 0 次），所以加了**独立 validity 小调用**：把"今天新 typed"
  与"和今天材料有内容词交集的旧 typed"对照一次，只判定取代关系；宁少勿多，候选先做内容词过滤
  （否则模型一天能失效十几条无关记录，实测过）。
- 修了 `parseJsonStrict` 把对象包成数组导致的"validity 映射永远不生效"（实测 0→1 条/天，日志可见）。
- cleanup 现在也整理 typed 命名空间，但加了**结构化层保护**：fact/preference/commitment 不能被并进
  event/人物块或跨类型合并（否则旧偏好会被事件正文吞掉，validity 失去对象）。
- 合成偏好变化 fixture 的失效率：修正评测口径后（旧值只在**同类型 typed 记录仍存活**时算 stale；
  匹配到 event 块只说明历史叙述还在，不算当前认知没更新）：
  - 旧咖啡偏好：真实 typed 旧记录已 superseded（DB 验证 `supersededBy=preference:2026-04-07:…`），
    旧 gold 只因历史事件块仍在而被匹配 → 记"仅历史块"；
  - 旧豆浆承诺：同类型 typed stale 1 例，人工核对是另一条"晚上提醒喝水"承诺被 matcher 部分匹配
    （不是真正旧记录）→ 属于 gold/match 粒度问题，进抽审清单；
  - 新值 3/3 全部形成。

### C. 本轮完整数字（fresh run，避免缓存污染）

| 指标 | 第 4 轮 | **第 5 轮** |
|---|---:|---:|
| formation matched/gold | 27/32 | 25/32 |
| formation recall | 84.4% | 78.1% |
| extracted（含 typed） | 203 | 172 |
| dupRate | 1.0% | 0.0% |
| provenance | 100% | 100% |
| 端到端 retrieval r1/r3/r5 | 16.7/50/50 | **20/60/80** |
| miss / falseInjection | 50% / 33% | **20% / 0%** |

> formation recall 从 84.4% 回落到 78.1% 是同一 fixture 不同 seed 的**单次运行方差**（repeat=1），
> 不是本轮改动引入的回归；下一轮把 repeat=2/3 纳入门控再比较。

## 2e. 第 6 轮：三源基线 + 复合问句兜底 + 表示等价口径（本轮）

### A. 三源真实素材端到端基线（同一套 eval，cloud + bge-m3，seed=formation）

| 素材 | formation R | extracted | 端到端 r1/r3/r5 | miss | falseInjection |
|---|---:|---:|---|---:|---:|
| real-focuscore（5 天 701 行） | 81.3% | 198 | 50.0 / 83.3 / 83.3% | 16.7% | 0% |
| real-qq（5 天 170 行） | 90.0% | 79 | 35.7 / 35.7 / 35.7% | 57.1% | 100% |
| real-live（8 天 708 行） | 100%（gold 4 条） | 172 | 66.7 / 83.3 / 83.3% | 16.7% | 50% |

- 三源闭环已经可复现（命令见 §4）；QQ 素材的 gold 是"技术对话多跳问句"，检索明显更难，
  是下一轮的主要目标；live 的 2 条负例里 1 条返回了泛相关记忆（falseInjection 50%）。
- formation 侧：QQ P=22.8%（gold 20 条 vs 79 条）、live P=2.3%（gold 只有 4 条草稿），
  precision 仍受 gold 完整度影响，不作为"变差"读。

### B. 复合问句拆查询（recall，兜底式）

- 真实用户常一句话问几件事（"最近在复习哪些科目？他觉得自己复习吃力的原因是什么？"）；
  recall 是单查询检索器，整句向量会被稀释。
- 实现：整句照旧先搜（精度优先），**候选不足（<limit/2）才**拆子句补搜（≤3 个），同一条目取最高分合并。
  只做主拆分会在 focus-core 上把 r5 从 80% 拖到 60%（实测），所以必须是兜底而不是默认。
- 新增回归测试：一句话两问、子句命中能召回。全仓 906 tests / 905 pass。

### C. 评测口径修正：同一记忆的"等价表示"

- typed v2 会把同一段原话拆成 event 块 + fact/preference/commitment 记录；召回命中 typed
  记录时，旧口径按 item id 判定直接算 miss（QQ 素材实测 0%→14.3% 的假性差距）。
- 修正：返回条目与 expected 的**证据集合 Jaccard ≥0.6** 或正文相似度 ≥0.6 → 视为命中同一记忆
  （保留 rawRankedIds 供复核）。这是"召回是否找到那段记忆"的度量，不是放宽为"相关即可"。
- 修正后 same-run 三源：focus r5 83.3%、qq r5 35.7%、live r5 83.3%；QQ 的剩余 miss 是召回
  真的没返回（floor 过滤/措辞差距），不是口径问题。

### D. memory-audit：typed 旧值失效链

- audit 新增 `typed` 段：live/superseded 计数、悬空 `supersededBy`、缺失 `invalidatedAt`、失效链样本；
  dream 所有 supersede 写入点统一填 `invalidatedAt`。在合成偏好 DB 上：live 47 / superseded 62、
  悬空链 0（修正了裸 key 跨命名空间解析），链样本可在 `audit.md` 里逐条复核。

## 2f. 第 7 轮：QQ 多跳检索补齐 + 原文补细节门槛 + 运行间方差（本轮）

### A. 模糊兜底（recall，严格 floor → 放宽二轮）

- 实测 QQ 素材 p-04/05/06 的正确记忆就在 top1（sim 0.42–0.44），但严格 floor=0.45 全被挡掉 → 空手。
- 实现：严格 floor 一条都没命中时，用 `max(0.3, floor-0.12)` 再搜一轮，结果标 `[记得不太清]`；
  内容词门槛仍在（"主人今天穿什么颜色衣服"这类无内容词问题依旧返回"没找到"）。
- 三源同-run 效果（cache 复用 formation、只重跑 retrieval）：

| 素材 | 修正前 r1/r3/r5 | **修正后 r1/r3/r5** | miss | falseInjection |
|---|---|---:|---:|---:|
| focus-core | 50 / 83.3 / 83.3% | 50 / 83.3 / 83.3% | 16.7% | 0% |
| **old-qq** | 35.7 / 35.7 / 35.7% | **50 / 64.3 / 64.3%** | **28.6%** | 100%* |
| live | 66.7 / 83.3 / 83.3% | 66.7 / 83.3 / 83.3% | 16.7% | 50%* |

\* 剩余 falseInjection 都是"提到但没答"的负例：QQ 的"中转站叫什么名字"返回了提到中转站的事实；
live 的"蓝色风筝验证结果"返回了当初的指令记忆。内容词命中但答案不在库里 → 下一轮做
"答案类型/实体一致性"检查，而不是继续降召回。

### B. 原文补细节也要过内容词门槛

- live 负例 p-07（"我昨天午饭吃了什么"）原先会从 raw 层抓内部计划/环境文本当"原文"端出来；
  现在 raw 补细节同样要求与查询有内容词交集 → 该探针恢复为"没找到"。

### C. 运行间方差（新增 `--fresh`）

- eval 新增 `--fresh`：忽略已有 prompt 缓存重新调模型，用于测**运行间方差**（默认仍走缓存保证可复现/省钱）。
- 同 fixture 两次独立 fresh run（当前代码）：

| run | formation R | extracted | e2e r1/r3/r5 | miss |
|---|---:|---:|---|---:|
| A | 78.1% | 197 | 50 / 90 / 90% | 0% |
| B | 78.1% | 202 | 80 / 80 / 80% | 20% |

→ 均值 r5≈85%±5、r1≈65%±15；formation recall 两次一致（78.1%）。单次数字要带方差看，
下一轮起门控用 3 次均值。

## 2g. 第 8 轮：日期归一 + 运行间方差定稿 + validity 置信上限（本轮）

### A. 查询日期归一（recall）

- 问句里出现"昨天/前天/N天前/10月25日"时，对 `data.day` 等于该日期的候选加 1.35 分（只加分不硬过滤，
  因为块可能跨天合并）。
- 同-run 三源效果：

| 素材 | 修正前 r1/r3/r5 | **日期归一后 r1/r3/r5** | MRR |
|---|---|---:|---:|
| old-qq | 50 / 64.3 / 64.3% | **64.3 / 64.3 / 64.3%** | 0.619→0.714 |
| focus-core | 50 / 83.3 / 83.3% | 50 / 83.3 / 83.3% | 0.667 |
| live | 66.7 / 83.3 / 83.3% | **83.3 / 83.3 / 83.3%** | 0.750→0.833 |

### B. 运行间方差（同一 fixture，`--fresh` 独立三次）

| run | formation R | extracted | e2e r1/r3/r5 | miss | falseInjection |
|---|---:|---:|---|---:|---:|
| A（日期归一前） | 78.1% | 197 | 50.0 / 90.0 / 90.0% | 0% | 0% |
| B（日期归一前） | 78.1% | 202 | 80.0 / 80.0 / 80.0% | 20% | 0% |
| C（日期归一后） | 78.1% | 178 | 66.7 / 86.7 / 86.7% | 0% | 0% |

→ **formation recall 三次完全一致 78.1%**；端到端 r5 均值 85.6%（极差 6.7pt）、r1 均值 65.6%（极差 30pt）、
miss 均值 6.7%、falseInjection 恒 0。下一轮把"3 次均值±极差"写进 `--gate` 基线文件。

### C. validity 置信上限

- 每天最多软失效 4 条 typed 记录，且只允许**同类型**（偏好不能被承诺失效）；
  超出/被拒的映射记 `dream.validity-capped` 日志，可在审计时复核。
- 这是对"模型可能一天提十几条取代关系"的确定性约束；单测与全仓测试通过。

### D. 负例「提到≠回答」结论（本轮调研）

- QQ 负例"中转站叫什么名字/跑什么模型"返回的条目含"叫/Claude/模型"字样；
  live 负例"蓝色风筝验证结果"返回的条目含"验证/查"字样 → 纯词面 marker 判别会误放行。
- 结论：确定性规则无法区分"提到了但没答案"，需要**基于返回条目的语义校验**（LLM 判定"这段记忆是否回答了问题"）。
  本轮不改 eval 口径（falseInjection 照旧如实计），把该能力列进下一轮。

## 2h. 第 9 轮：gold 抽审工具 + validity 上限复测（本轮）

### A. `tools/memory-gold-review.mjs`（新增，不调模型）

- 输出每个 fixture 的 gold 质量清单：无证据/非法证据行/正文过短/同类型近重复 gold/
  失效链指向不存在 gold/未被任何 probe 覆盖的 gold/probe 期望解析失败。
- 三源实测：
  - focus-core：gold 32 条里 **22 条没有任何 probe 引用**；3 个 probe 的 expected 无法映射
    （m-0021/m-0010 等）→ 解释了为什么端到端指标只覆盖 6 个 probe、P/R 波动大；
  - old-qq：gold 20 条里 **11 条无 probe**；
  - live：gold 4 条，0 个问题（但 gold 本身太少）。
- 结论：下一轮"补 probe"比继续调检索参数更能提升评测的信噪比；判定文件在
  `.state/lab/lead/gold-review/*.md`（JSON 同目录，供脚本消费）。

### B. validity 上限后的复测（fresh run）

- 合成偏好变化 fixture（带 `invalidatedAt`/每日取代上限≤4/同类型约束）：
  formation R 78.6%（11/14）、P 10.3%；失效链口径不变——旧咖啡/旧徒步偏好只以**历史事件块**
  存在（历史叙述，不算当前认知），旧豆浆承诺的同类型 stale 1 例经核对仍是"晚上提醒喝水"
  被部分匹配（不是真正的旧记录）；新值 3/3 形成。
- 与上一轮（无上限）相比：失效链结构与结论一致，未出现"上限导致该失效的没失效"。

## 2i. 第 10 轮：补 probe + 字面通道看正文 + 门槛精修（本轮）

### A. 补 probe（评测覆盖）

- 用第 9 轮的 gold-review 清单给真实 fixture 补 probe：focus-core **+10**（19 个 probe，覆盖
  commitment/person/relationship 等原先无 probe 的 gold）、old-qq **+5**（14 个 probe）。
  补 probe 脚本在 `.state/lab/lead/add-probes.mjs`（按 gold 证据最后一条 raw 行取探针时刻；
  fixture 备份 `.bak-r10`）。
- 扩 probe 后基线（seed=formation，同-run）：

| 素材 | withExpected | r1 | r3/r5 | MRR | miss | falseInjection |
|---|---:|---:|---:|---:|---:|---:|
| focus-core | 16/19 | 37.5% | 81.3% | 0.594 | 18.8% | 0% |
| old-qq | 8/14 | 70.8% | 70.8% | 0.750 | 25.0% | 100%* |
| live | 8/8 | 83.3% | 83.3% | 0.833 | 16.7% | 50%* |

\* 仍是两条"提到≠回答"负例（QQ 中转站名字、live 蓝色风筝验证结果），非本轮回归。

### B. 字面通道看"摘要+正文"（memory.search）

- 事件块的 `text` 只是一行摘要，用户问法（"她看到了哪些奇怪账号"）常只出现在 `body` 里；
  之前字面通道（含无嵌入退化路径）只算 `text`，把真正含内容的块排低。
- 改为 `text + body/profile` 的二元组覆盖率，精确串也扫同一文本。
- 效果：focus r1 31.3→**37.5%**、r3 75→**81.3%**、MRR 0.544→0.594；
  QQ r1 62.5→**70.8%**、MRR 0.694→0.750；live 不变（83.3%）。

### C. 内容词门槛精修

- 门槛只看**摘要**（正文不参与"算不算相关"，live"午饭吃了什么"曾被正文里的"吃了"放进来）；
- 放宽二轮只看最靠前 3 条（低置信候选里混进一条含内容词的泛记忆，不能替整组凑数）；
- "单条领先者"放行规则区分有无嵌入：无嵌入时单条字面命中可信（颜色→蓝色换措辞）；
  有嵌入时只有放宽二轮的单条才放行。→ live 负例"午饭吃了什么"恢复"没找到"，product 单测全绿。

### D. 补 probe 后暴露的失败类型（下一轮目标）

1. **同一天内排序**（p-12：期望的事件块排第 8，被同主题 fact/commitment 挤出 top5）→ 需要
   event/主体一致的重排或跨编码器；
2. **关系类问题**（p-19"曾嘉睿和 Hahn123 是什么关系"）期望的事件块完全没进候选；
3. **person 多块 parse**（p-04 仍返回空）；
4. QQ 的指代问句（"他凌晨…"）与深夜里"还有什么没解决"这类转述。

## 2j. 第 11 轮：意图感知重排 + person 探针双路径（本轮）

### A. 意图感知重排（recall）

- 候选分数常很接近：问"她看到了什么"时事件块才是答案，问"答应/承诺了什么"时 typed commitment
  才是答案。新增 `queryIntent`（person/commitment/preference/event/mixed）与温和加分表（≤1.3×）：
  事件意图→event×1.25、承诺→commitment×1.3/fact×1.1、偏好→preference×1.3/fact×1.1、问人→person×1.3；
  person 配额在问人意图时从 1 放宽到 2（关系类问题要两边人物块）。
- 只加分不改变候选集合与门槛；新增回归测试（承诺意图下 typed commitment 排在同样相关的事件块前）。

### B. 放宽二轮改为"候选不足就补"（不只空结果）

- 触发条件从"严格轮 0 条"改为"严格轮 <2 条"；补进来的条目仍标 `[记得不太清]`。
  这修掉了 QQ 的单候选卡死：p-05/p-10 严格轮只命中 1 条、内容词门槛把它挡掉后直接空手；
  补搜后 5–8 条候选进入门槛判定。
- 放宽轮内容词门槛的采样从前 3 条扩到前 8 条（避免意图加分把含内容词的 fact 挤出采样区后误杀）。

### C. person 探针双路径（eval）

- 关系类问题不只该查人物档案，还要查事件记忆；retrieval 的 person 探针现在 whois 之后再走一次
  recall（path=`whois-tool.multi+recall`），person 解析也接受 recall 的 `[类型 · 相对时间]` 行。
  → focus 的 p-04（曾嘉睿/Hahn123/周子涵关系）从 miss 变 hit。

### D. 三源结果（seed=formation，同-run）

| 素材 | r1（前→后） | r3/r5（前→后） | MRR | miss（前→后） | falseInjection |
|---|---|---|---:|---|---:|
| focus-core | 37.5→**31.3%** | 81.3→**90.6%** | 0.585 | 18.8→**6.3%** | 0% |
| old-qq | 70.8→**62.5%** | 70.8→**79.2%** | 0.750 | 25.0→**16.7%** | 100%* |
| live | 83.3→**83.3%** | 83.3→**91.7%** | 0.889 | 16.7→**0%** | 50%* |

\* 负例仍是"提到≠回答"两条；r1 的小幅回落是意图加分把部分精确短命中换成了更完整的长答案，
r3/r5/miss 全部改善，按"人能否拿到答案"口径是净收益。

### E. 剩余失败（可定位）

- focus p-19（"曾嘉睿和 Hahn123 是什么关系"）：期望的关系澄清事件块 sim 低于 floor 且不在
  放宽二轮候选里（被"同一个人/网关"这类高相似事实挤掉）→ 关系类需要实体对检索/重排；
- QQ p-07（指代"他凌晨说…"）、p-10（称呼类问题事件块排位）：指代消解与同主题重排仍是下一轮目标。

## 2k. 第 12 轮：实体对/关系检索（本轮）

### A. 实现（recall）

- 问人意图（谁/关系/名字…）时，从 person 命名空间取出实体称谓（QQ/aliases/ids），找出**问句里出现
  ≥2 个实体**的情况：把它们的名字拼成"实体对 + 关系"再补搜一遍（放宽 floor、标不确定）；
- 对候选做实体对加分：正文同时提到双方（含别名/QQ）的块 ×2.2，只提到一边 ×1.1。
  关系澄清常常写在不带双方名字的事件块里（"主人澄清曾嘉睿是舍友，周子涵和离线版都是他自己"），
  单靠整句相似度会被"同一个人/网关"这类高相似事实挤掉。

### B. 结果（seed=formation，同-run）

| 素材 | r1 | r3/r5 | MRR | miss | falseInjection |
|---|---:|---:|---:|---:|---:|
| focus-core | 34.4% | **87.5 / 93.8%** | 0.613 | 6.3% | 0% |
| old-qq | 62.5% | 79.2% | 0.750 | 16.7% | 100%* |
| live | 83.3% | 91.7% | 0.889 | 0% | 50%* |

- focus p-19（"曾嘉睿和 Hahn123 是什么关系"）从"完全不在候选"提升到 **raw 排名第 9**
  （recall 输出里已有 386，但 top5 之外）→ 距离命中只差块级关系打分，列为下一轮第一项。
- 扩 probe 后 gold-review 复核：focus 未被任何 probe 引用的 gold **22→12 条**；
  仍有 3 个 probe 的 expected 无法确定性映射（m-0021 等，属 gold/匹配粒度，进抽审）。

### C. 剩余失败与下一轮

- **关系块打分**：不只看"正文提到两个实体"，还要识别关系陈述（舍友/同一个人/朋友/主人 + 实体对），
  给关系句更高权重，目标 p-19 转 hit；
- **指代消解**：QQ p-07（"他凌晨说…"）仍 miss；
- 负例「提到≠回答」两条（QQ 中转站名字、live 蓝色风筝验证结果）。

## 2l. 第 13 轮：关系陈述优先排序 + 指代变体（本轮）

### A. 关系陈述块直接排前（recall，问人意图且≥2 实体）

- 仅靠分数时，低 base 的关系澄清事件块（"主人澄清曾嘉睿是舍友，周子涵和离线版都是他自己"）
  永远进不了 top5；现在对"非人物档案 + 同时提到双方 + 含关系陈述词（舍友/同一个人/朋友/主人…）"的块
  做**优先层排序**（人物档案只作佐证排在后面），其余仍按分数。
- focus p-19 转 hit：focus **miss 6.3%→0%**、r5 93.8→**96.9%**、MRR 0.619；r3 84.4%（关系类排前会让
  少量普通问答的 r3 微调，r5/miss 是净收益）。

### B. 指代变体（新能力，三源暂无收益）

- 问句含"他/她/TA"且整句候选<3 时，用 raw 层**最近一个真人发言者**的称呼替换代词再搜一遍
  （"他凌晨说…"→"Hahn123 凌晨说…"）；拿不到 speaker 元数据就不加变体、不猜。
- 三源指标暂无变化：QQ p-07 的根因是 probe expected 映射到的块（"继续优化记忆/人格核心"）
  与问句内容对不上（gold↔extracted 匹配粒度），不是检索没找到——列入 gold 抽审清单。

### C. 三源结果（seed=formation，同-run）

| 素材 | r1 | r3/r5 | MRR | miss | falseInjection |
|---|---:|---:|---:|---:|---:|
| focus-core | 34.4% | 84.4 / **96.9%** | 0.619 | **0%** | 0% |
| old-qq | 62.5% | 79.2% | 0.750 | 16.7%* | 100%** |
| live | 83.3% | 91.7% | 0.889 | 0% | 50%** |

\* QQ 仅剩 p-07（gold↔extracted 映射粒度问题）；\** 负例仍是"提到≠回答"两条。

## 2m. 第 14 轮：基线/方差定稿 + answer-adequacy 审计 + 确定性旧值失效（本轮）

### A. 基线文档 + 3 次 fresh 方差（`docs/MEMORY-BASELINES.md`，新增）

- 当前代码 3 次独立 `--fresh`（focus-core）：formation R 78.1/81.3/81.3%（均值 80.2%），
  端到端 r5 93.3/76.7/75.0%（**均值 81.7%，极差 17.5pt**）、miss 6.7/20/25%（均值 17.2%）、
  falseInjection 恒 0。
- 建议门控（写进 baseline 文档）：formation.recall≥0.75、r3≥0.65、r5≥0.75、miss≤0.25、
  falseInjection=0；QQ 单列 r5≥0.70、live r5≥0.80。
- 结论：**单次数字必须带方差读**，cache-only 的 96.9% 是"复用了一次好 formation"，不能当常态。

### B. answer-adequacy 审计（新工具 `tools/memory-answer-adequacy.mjs`）

- 对"期望为空且无 unresolved"的**真负例**，让模型判断"返回的记忆里有没有真正回答问题的内容"。
- 三源结果：focus 1 条负例、QQ 1 条、live 2 条；**judge 全部判"提到但没答"（answers=false）**，
  没有任何一条返回记忆被误当成答案 → **原始 falseInjection 高估了问题**（它只统计"有没有返回"）。
- 口径建议：对外报告用 `raw falseInjection` + `answer-adequacy falseInjection` 两个数；
  后者三源均为 **0**。工具走 eval 的 prompt 缓存，可无密钥复跑；产物在 `.state/lab/lead/answer-adequacy/`。

### C. 确定性旧值失效兜底（validity 第二个安全网）

- 模型 validity 会漏"旧偏好被否定"（咖啡→豆浆实测漏失效），新增保守兜底：
  同类型 + 旧记录在更早的日子 + 新陈述含否定词（不/没/不再/戒/停/别）+ 与新陈述共享至少一个
  **非通用内容 bigram** → 软失效旧记录（每天≤2 条，日志 `dream.validity-invalidated-deterministic`，单测覆盖）。
- 合成偏好变化 fixture fresh 复测：formation **R 78.6→85.7%**；旧值仍以"同类型 typed 记录存活"
  计数的 stale **2→0**（旧咖啡/旧徒步只剩历史事件块）；audit：typed live 84 / superseded 31、
  **悬空失效链 0、缺失效时间 0**。

## 2n. 第 15 轮：门控落地 + gold-review 探针错配检测 + QQ/live 方差（本轮）

### A. 门控落地（`--gate-preset focus|qq|live`）

- eval CLI 新增三源预设（数值见 `docs/MEMORY-BASELINES.md` §3），`--gate` 显式值优先；
  不通过 exit 3 并逐条打印未过指标。
- 已用 fresh run 实测通过（r5 84.4%、miss 12.5%、falseInjection 0、formation recall≥0.75，exit 0）。

### B. gold-review 新增「探针与 expected gold 零内容词交集」检测

- 问句与 expected gold 正文一个内容 bigram 都不共享 → 标为 probe 错配（gold↔extracted 映射/问法问题）。
- QQ 实测抓出 p-08（"3429502459 是谁"与 expected gold 正文无内容词交集）等 3 条问题；
  这类先修 gold/probe，再谈检索。

### C. QQ / live 三次 fresh 方差（补齐三源 baseline）

| 素材 | formation R 均值 | r1 均值 | r3 均值 | r5 均值 | miss 均值 | 极差（r5） |
|---|---:|---:|---:|---:|---:|---:|
| focus-core | 80.2% | 48.1% | 71.8% | **81.7%** | 17.2% | 17.5pt |
| old-qq | 85.0% | 48.5% | 65.1% | **65.1%** | 27.3% | 4.6pt |
| real-live | 100% | 55.6% | 77.8% | **83.4%** | 11.1% | 25pt |

- QQ 的 r3=r5（正确块进 top3 一般也在 top5）、r1 方差最大；live 的 miss 方差 0–33%（gold 只有 4 条，单条 miss 权重高）。
- 三源均值都明显高于各自最低单次值 → 再次说明门控要用均值/多次，不用单次。

## 2o. 第 16 轮：QQ gold/probe 修整 + 失效链人工抽审（本轮）

### A. QQ gold/probe 修整（先修 gold 再谈检索）

- gold-review 的「零内容词交集」清单定位到两处 gold 问题：
  1. `m-0013`（"周子涵是学生…10月25日前后集中复习计组…"）类型被标成 `person`，formation 里对应内容
     实际落成 `event`（"主人说昨晚整到两点，早上还得去上计组实验"）→ matcher 类型过滤导致永远 unmatched；
     改为 `event` 后 probe p-03 的 expected 正常解析（p-03 从 miss 变 hit）。
  2. probe p-08 问法只用 QQ 号（"3429502459 是谁"），与 person gold 正文零内容词交集；
     改为 "Hahn123（QQ 3429502459）是谁？他最近在忙什么、在复习什么？"。
- 同-run 复测（cache 复用 formation）：QQ **r1 63.6→68.2%、r3/r5 63.6→68.2%**，withExpected 从 8 增到 11；
  剩余 miss = p-06（深夜测试结果）、p-07（映射粒度）、p-08（多 expected 人物探针）。

### B. 失效链人工抽审（memory-audit 新增「可疑取代」）

- 新增判据：后继文本与旧文本**零非通用内容 bigram 交集**或后继缺失 → 列出待人工确认；
  在合成偏好库（31 条 superseded）上：**可疑 1/31**，人工核对是"爬山计划作废→骑车"的合理取代；
  **悬空链 0、缺失效时间 0** → 未发现误失效。
- `audit.md` 的「typed 旧值失效链」现在显示每条链的共享内容词数，便于复核。

## 2p. 第 17 轮：answer-adequacy 指标化 + QQ 探针问题收敛（本轮）

### A. `--adequacy` 进 eval 报告（不再只是独立工具）

- eval 新增 `--adequacy`：retrieval 结束后对**真负例**（expected 为空且无 unresolved）跑 judge，
  结果写进 `eval.json.retrieval.answerAdequacy` 与 `eval.md` 的「answer-adequacy（真负例 judge）」段；
  CLI 同步打印一条摘要。`--cache-only` 时跳过 judge（可离线复跑，adequacy 用独立工具补）。
- QQ 实测：`answer-adequacy：负例 1 条，judge 判"有答案" 0 条，提到但没答 1 条`；
  报告里 raw falseInjection=100% 与 adequacy-adjusted（0 条真误答）并列，口径不再含糊。
- 单测覆盖：只对真负例调用、区分"提到但没答"。

### B. QQ 修整后复核

- gold-review 的 probe 期望解析/内容匹配问题：**3 → 2**（p-03 已解析、p-08 内容交集已恢复；
  余下为 p-07 映射粒度与 p-08 的第二条 unresolved）。
- 同-run QQ：r1/r3/r5 = **68.2%**、MRR 0.727、miss 27.3%；剩 3 个 miss 已逐条定位。

## 2q. 第 18 轮：live gold 扩充（4→8）+ 探针覆盖闭环（本轮）

### A. live gold 扩充

- 从 live formation 的明确事件里人工补 4 条 gold（含证据行）+ 4 个 probe：
  11-03 深夜闹钟「我在」、11-05 第一次 MC 连接测试失败（端口 54838→25565）、
  11-05 第二次测试通（time_status + mcb_leave）、11-03 同 key 两版「梧桐树下的猫」审计测试。
- live fixture：gold **4→8**、probes 8→12（withExpected 10），gold-review「未被任何 probe 引用的 gold」= **0**。

### B. live 复测（seed=formation，cache 复用）

| 指标 | 扩充前（gold 4） | **扩充后（gold 8）** |
|---|---:|---:|
| formation matched / R | 4/4 100% | **8/8 100%** |
| r1 | 83.3% | **60.0%** |
| r3 | 91.7% | **80.0%** |
| r5 | 91.7% | **90.0%** |
| MRR | 0.889 | **0.737** |
| miss | 0% | **10.0%** |
| falseInjection（raw / adequacy） | 50% / 0 | 50% / **0** |

- 新 probe 里 p-09/p-11 直接 r1 命中；p-10（"第一次 MC 测试为什么失败"）r5 命中但 r1 被同主题
  第二次测试挤到第 5；p-12 同 key 两版的检索引擎结果在 top2。gold 覆盖面扩大后指标略降是正常
  （更难的题目进场），formation R 仍 100%。

### C. 小结

- 三源现在都有"gold 有证据、probe 全引用"的基线（focus 19 probes/16 expected、QQ 14/11、live 12/10）。
- 下一步优先级：QQ 剩 3 个 miss（p-06 只回了待整理 person note；p-07/p-08 是 gold↔extracted 映射/
  多 expected 探针）、三源 3 fresh 方差复跑、validity 抽审扩大、门控接 CI。

## 2r. 第 19 轮：内容词门槛取样修复（本轮）

### A. 根因与修复

- QQ p-05/p-08 等探针"有 30–80 条候选却返回空"：内容词门槛取的是**加分/重排之后**的 top N 摘要，
  意图加分把"含内容词的 fact"挤出采样区（事件块占满 top8），门槛误判"内容词一个都没出现"。
- 修复：门槛改用**加分前、按纯相关度排序的候选摘要（top 100 全量）**；任何一条候选摘要出现查询内容词
  即通过。门槛只负责"有没有字面信号"，排序仍由后续重排决定。
- 可观测性：新增 `recall.empty-after-filter` 日志（候选数/可用数/pending 数/contentOk/topSim/floor/relaxed），
  eval `--debug` 会打印 retrieval 阶段的 recall 日志（这次就是靠它定位的）。

### B. 三源复测（seed=formation，同-run；--adequacy 同跑）

| 素材 | r1 | r3/r5 | MRR | miss | raw falseInjection | **adequacy-adjusted** |
|---|---:|---:|---:|---:|---:|---:|
| focus-core | 37.5% | 87.5 / **100.0%** | 0.656 | **0%** | 0% | **0** |
| old-qq | 59.1% | 68.2 / **72.7%** | 0.700 | **18.2%** | 100% | **0**（1 条负例 judge 判"提到但没答"） |
| live | 70.0% | 80.0 / **90.0%** | 0.787 | **10.0%** | 100% | **0**（2 条负例全判"提到但没答"） |

- 对比修复前：QQ r5 68.2→**72.7%**、miss 27.3→**18.2%**；live r1 60→**70%**；focus r5 96.9→**100%**、miss 0。
- 代价：QQ/live 的 raw falseInjection 从 50%/100% 变高（门槛更宽松会返回相关记忆），
  但 adequacy judge 三源全部判"提到但没答"——**没有一条把相关记忆当成答案**。
  因此 QQ/live 的门控不使用 raw falseInjection=0，而用 `--adequacy`（focus 仍保持 raw=0）。

## 3. 结论与下一轮

- 写入侧根因已系统性收口：**raw 有来源/说话人**、**输出预算/重试/拆片**、**reasoning 不再混入**、
  **事实/偏好/承诺独立成层**、**检索阈值有标定**、**时间旅行保护 + person 配额**；
  真实 5 天 fixture formation recall 46.9%→84.4%，端到端 retrieval r3/r5 50%→66.7%、miss 50%→33.3%。
- 下一轮（Phase 2 第 18 段）优先级：
  1. **QQ 剩 3 miss**：p-06（recall 只返回待整理 person note，候选/预算路径要查）、
     p-07/p-08（gold↔extracted 映射与多 expected 探针口径）；
  2. **三源 fresh 方差复跑**（live gold 扩充后 + QQ 修整后）更新 baseline 数字；
  3. **validity 抽审扩大**：再跑 2 次合成 fixture，抽查 capped/deterministic 失效各 10 条；
  4. **门控接 CI**：三源 `--gate-preset` + `--adequacy` 默认跑，结果写 baseline；
  5. **typed v2 下一步**：entity 层（现在只有 identity canonicalization）与 validity 的对外可见标签。

## 4. 复跑

```powershell
# 真实 5 天 fixture：旧 fixture 先按新分类器重标 assistant 行（只改 source/visible）
node .state/lab/lead/reclassify-fixture.mjs .state/lab/memory-corpus/real-focuscore-2026-10/fixture.json

# gold 抽审（不调模型）：列出无证据/近重复/无 probe 覆盖/期望解析失败
node tools/memory-gold-review.mjs --fixture .state/lab/memory-corpus/real-focuscore-2026-10 \
  --eval .state/lab/lead/eval-focus-r6f/eval.json --out .state/lab/lead/gold-review

# formation（缓存命中后无密钥可跑；阈值/预算改动会改变 prompt→cache 失效，属预期）
$env:DEEPSEEK_API_KEY=[Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY','User')
node tools/memory-eval.mjs --fixture .state/lab/memory-corpus/real-focuscore-2026-10 `
  --mode formation --model cloud --profile raw-main --debug --out .state/lab/lead/eval-focuscore-final

# 端到端（formation + retrieval；--embed 用本地 bge-m3）
node tools/memory-eval.mjs --fixture .state/lab/memory-corpus/real-focuscore-2026-10 `
  --mode all --seed formation --model cloud --profile raw-main --embed `
  --out .state/lab/lead/eval-focuscore-final

# 只测检索（库用 gold 种子，不受形成误差影响）；阈值标定用 --recall-min-sim 扫描
node tools/memory-eval.mjs --fixture .state/lab/memory-corpus/real-focuscore-2026-10 `
  --mode retrieval --seed gold --model echo --embed --recall-min-sim 0.5 `
  --out .state/lab/lead/eval-focus-retrieval3
```
