# 记忆外部研究：框架、基准与评估方法（2026-11-11）

> 作者：memory-researcher（外部研究，clean-room）。范围：persona/companion agent 的长期记忆。
> 方法：只读 web（arXiv、官方文档、厂商博客、GitHub/PyPI 元信息）；GitHub/HuggingFace 直连在本会话被解析到非公网地址而不可用，仓库细节以文档站/论文/搜索快照为准，标「待核实」。
> **许可声明：本文只写设计结论，不包含任何第三方代码或 prompt 原文。** 论文多为 arXiv 非独占/CC BY-NC-SA，代码多为 Apache-2.0/MIT，引用/再分发前必须逐个核对 LICENSE 与 NOTICE。
> 与 `docs/MEMORY-CODE-AUDIT.md`（代码审计）、`docs/MEMORY-AUDIT.md`（live 数据审计）互补，不重复其内容。

## 0. 结论先行

1. **外部证据并不支持「换一个记忆库就能变好」**：在短对话（LoCoMo 级）上 full-context 常与专用记忆系统打平甚至更好；只有上下文长到 10 万 token 级，记忆系统才有稳定大幅收益（Zep 的 LongMemEval 表：55.4%→63.8%、60.2%→71.2%，上下文 115k→1.6k token）[R2][R3]。
2. **2026 年的新证据更冷**：Memory Tax 大规模评测发现「很多专用记忆系统在不少情况下不如朴素 RAG」，并把记忆的净价值拆成 benefit 与 tax（tax 来自证据被删除/遮蔽）[R22]。
3. **最大的质量杠杆在写入侧，不在检索侧**：抽取门控错误会被下游放大。MIST 实验显示记忆系统把谄媚率最多抬高 40%，主因正是「抽取只保留用户误解片段、丢掉纠正上下文」[R21]。
4. **ICL 已确认的问题（块近重复、lexicon/note 噪声、person 未归并、召回几乎不用）与业界失效模式一一对应**，不需要换存储/上图和向量库；优先修「写入门控 + 去重 + alias + 评估闭环」。
5. **persona agent 最贴合的公开材料是中文的**：PerLTQA（中文个人长期记忆 QA）[R19]、MemBench（多场景多层级、选择题+读写成本）[R17]、ZH-4O/MOOM（中文超长角色扮演+人工记忆标注）[R27]、PAL-Set/PAL-Bench（中文多会话个性化）[R28]。英文 LoCoMo/LongMemEval 适合做方法对照和回归，不宜直接当 ICL 目标。
6. **评估要拆成「形成质量 / 召回质量 / 端到端净收益」三层**；live 中主动 recall 几乎不用不是 bug 而是结构现象，应改用「影子召回 + 强制注入反事实」来验证（§3.3）。
7. **成本结论**：逐回合 LLM 抽取不适配 ICL；dream 批量整合方向正确，但必须用金标 gate 证明每一轮 LLM 调用净收益为正（MemBench 里 MemoryBank 写入 8–18 秒/次、GenerativeAgent ~6 秒/次）[R17]。
8. **不要引入 Neo4j 图数据库**：当前库 182 条、增长慢；Mem0 图上变体相对 base 只高约 2%（厂商自报）[R1]，收益与运维成本不匹配。

---

## 1. 框架/架构对比

### 1.1 总表（写入门控 → 存储 → 去重/矛盾 → 检索 → 遗忘 → 评测）

| 框架（代码许可，需核对） | 写入路径与提取门控 | 存储模型 | 去重/合并/矛盾 | 检索与打分 | 遗忘/衰减 | 评测与报告结果 | 主要失效点 |
|---|---|---|---|---|---|---|---|
| **Mem0**（Apache-2.0¹） | 每次 add 调用时由 LLM 抽取候选事实，再与相似旧记忆比对做 **ADD/UPDATE/DELETE/NOOP** 决策；2026 v3 改为「累积而非覆盖」[R1][R1-v3] | 扁平事实记忆（文本+向量）；可选 graph 变体（实体/关系） | 写入时用 LLM 判定更新/删除；v3 前是覆盖式，v3 起累积+混合检索 | 向量相似 + 元数据过滤；v3 起 hybrid[R1-v3] | 无显式时间衰减，靠更新/删除 | LoCoMo LLM-as-Judge（J 分）：比 OpenAI Memory +26% relative；graph 比 base +~2%；比 full-context p95 −91%、token −90%[R1] | 自家结果中 full-context 基线更高（~72.9% vs ~66.9/68.4%，Zep 引用 Mem0 数据）[R2]；基准缺陷争议[R2] |
| **Zep / Graphiti**（Apache-2.0¹） | episode 摄入后抽取实体（带前后文 reflection）→ 实体解析 → 事实抽取 → 时间抽取与**边失效**；LLM 多次调用[R3] | 三层图：episode（原文）/ 语义实体+事实 / 社区摘要；**双时间轴**（事件时间 T、入库时间 T'），边上 4 个时间戳 | 实体解析（向量+全文+LLM 去重）；事实去重限制在「同一实体对」之间；新事实与旧边矛盾时把旧边 `t_invalid` 置为新边 `t_valid`（不删除历史）[R3] | 余弦 + BM25 + BFS 三路召回；rerank 支持 RRF/MMR/提及频率/图距离/cross-encoder；构造器输出 facts+valid 区间[R3] | 不遗忘，靠时间失效与历史保留 | DMR 94.8% vs MemGPT 93.4%（gpt-4-turbo）；LongMemEval +15.2%（4o-mini）/ +18.5%（4o），延迟 3.2s/2.6s vs 31s/29s，avg context 1.6k vs 115k[R3] | 同表 full-context 94.4%/98.0%，短对话优势≈0[R3]；Graphiti 每次摄入 LLM 调用多、成本高；Zep 对 Mem0 的批评本身是竞品立场[R2] |
| **Letta / MemGPT**（Apache-2.0¹） | agent 通过工具/中断主动管理记忆；核心记忆由模型自己改；另有 sleep-time 离线计算[R4][R5] | OS 式分层：core memory（常驻上下文、可编辑）+ recall（消息历史）+ archival（外部存储/向量）[R4] | 由 agent 自主决定（无固定策略） | core 常驻不进检索；archival 语义检索；上下文溢出时中断换页 | 无自动衰减（依赖 agent 改写/归档） | DMR 93.4%（MemGPT 自报）；sleep-time compute：同等准确率 test-time 计算 −5x，scale 后 +13%/+18%，多查询摊销 2.5x[R5] | DMR 被后续工作指出规模小、单跳事实题、full-context 即可 94.4%[R3]；记忆管理质量强依赖模型自身能力 |
| **LangMem / LangGraph**（MIT¹） | 记忆管理器从对话抽取事实并「对照已有记忆做更新」（create_memory_manager，enable_inserts）；另外用 prompt optimizer 把经验写回指令[R6] | 三类：semantic（事实，profile/collection）、episodic（过往交互 few-shot）、procedural（prompt 规则）；LangGraph 长时记忆层 + namespace 隔离[R6] | 更新由 LLM 对照 existing memories 决策；无语义冲突图 | 按 namespace + 语义相似度召回；procedural/core 常驻[R6] | 无内建衰减 | 无公开学术 benchmark；以 SDK 设计说明为主（此为 2025-02 发布文）[R6] | 「hot path vs background」实现细节待核实；把 prompt 当记忆有回归/漂移风险；无评测数据 |
| **Cognee**（Apache-2.0¹） | 文档/对话 add 后做 KG 构建（cognify）再检索；具体抽取门控细节**待核实** | 知识图谱 + 向量混合 | 细节**待核实** | 图 + 向量检索；论文只报告超参调优实验 | 无显式衰减**待核实** | HotPotQA/TwoWikiMultiHop/MuSiQue 上系统调 chunking/graph/retrieval/prompt，EM/F1/LLM correctness；收益一致但不均匀[R7] | 论文为初步版；无对话记忆 benchmark；超参敏感 |
| **A-MEM**（MIT¹） | 每条新记忆生成结构化 note（上下文描述、关键词、标签），再检索历史记忆建链；新记忆可回写更新旧记忆的上下文（memory evolution）[R8] | Zettelkasten 式关联笔记网络（非图数据库也可） | 靠链接与演化，而非显式去重 | 按链接+语义找相关历史记忆 | 无显式衰减 | NeurIPS 2025；六种基础模型上优于 SOTA（数据集细节未在摘要给出，**待核实**）[R8] | 写一条要多轮 LLM（生成+找链接）；链接质量难评；对噪声输入敏感 |
| **Memobase**（Apache-2.0¹） | 消息进 **buffer**，flush 时批量集成进用户画像；可自动/手动触发[R9] | **结构化用户档案**：topic/subtopic 槽位（如 interests/movies）+ 事件 blob；中/英/日多语言 prompt[R9] | 档案演化式更新（细节**待核实**） | 提供「取记忆 prompt」API（细节**待核实**） | 无显式衰减 | 官网有 performance/cost 页，未见独立论文 benchmark（**待核实**）[R9] | 面向「用户画像」而非双方关系；槽位需产品自定义；无公开评测 |
| **MemOS**（Apache-2.0¹） | Memory API/MemReader 摄入 → MemOperator 多视角结构化 → MemScheduler 调度 → MemLifecycle 生命周期（生成/激活/融合/归档/过期）[R10] | **MemCube** 为基本单元（内容+来源+版本），三类记忆：明文 / 激活(KV) / 参数；三层架构 Interface/Operation/Infrastructure[R10] | 版本化 + 融合（fusion）；具体冲突策略**待核实** | 混合检索 + 动态调度 + 缓存 + 任务对齐路由[R10] | 显式生命周期管理（过期/归档）[R10] | LoCoMo LLM-Judge 四类任务均第一（对比 Mem0/LangMem/Zep/OpenAI-Memory），multi-hop/temporal 优势大[R10] | 系统极重（OS 级抽象），落地需要大量工程；自报结果，无独立复现；2026 生态仍在演进 |
| **Memary**（MIT，已验证） | 每次交互后把 agent 回复/工具结果写入 Neo4j 图；实体抽取形成 memory stream[R11] | Neo4j 知识图谱 + memory stream（实体+时间）+ entity knowledge store（频次+新近度排序）[R11] | 无显式去重策略（**待核实**） | 递归检索：抽查询关键实体→建深度 2 子图→多实体多跳合并；另有路由 ReAct agent 与查询分解[R11] | 无显式遗忘；用频次+新近度决定注入哪些实体[R11] | 无学术 benchmark；工程 demo 为主[R11] | 写路径贵、图数据库重；无评测；依赖 Ollama/Neo4j |
| **MemoryBank**（许可**待核实**） | 对话后更新记忆；按**艾宾浩斯遗忘曲线**与「重要性」选择性保留/强化[R12] | 记忆条目（事件/用户画像）+ 检索 | 更新=按时间+意义强化/遗忘（细节**待核实**） | 时间+相关记忆检索[R12] | **遗忘曲线衰减**（本项目 half-life/decay 的经典先例）[R12] | 定性真实用户对话 + 模拟对话；15 用户/194 探针问题（LongMemEval 统计）；SiliconFriend 应用[R12][R15] | 规模小、指标主观；「双语」说法来自 PerLTQA 论文转述，**待核实** |
| **Generative Agents**（Apache-2.0¹） | 观察流全量记录，定期 reflection 生成高层记忆[R13] | memory stream（自然语言记录）+ reflection 树 | 无去重/矛盾处理（全量保留） | 检索分数 = 新近度 + 重要性 + 相关性（LLM 打重要性分）[R13] | 新近度衰减但不删除 | 消融实验证明 observation/planning/reflection 各自贡献可信度[R13] | 无记忆质量指标；规模小；全量记录不可扩展 |

¹ 代码许可来自公开仓库常见声明，落地前必须核对仓库 LICENSE/NOTICE；未核对者标「待核实」。
[R9] Memobase 文档 https://docs.memobase.io/introduction 、/features ；[R10] MemOS 论文 https://arxiv.org/abs/2507.03724 ；[R11] memary PyPI（MIT 已验证）https://pypi.org/project/memary/ ；[R12] MemoryBank https://arxiv.org/abs/2305.10250 ；[R13] Generative Agents https://arxiv.org/abs/2304.03442 。
[R] 编号见 §6。

### 1.2 各框架补充判断

- **Mem0**：真正值得学的是「抽取 → 与旧记忆比对 → 决定增删改」这条写路径，以及「记忆不是聊天记录、要压缩成事实」的定位；不是它的向量库。2026 v3 明确承认旧算法会覆盖/丢信息，改成累积 + 混合检索 + 捕获 agent 生成事实[R1-v3]，这反证了「覆盖式 UPDATE」在长期关系里不可靠。
- **Zep/Graphiti**：双时间轴 + 边失效是「知识更新/矛盾」最完整的工程答案，但复杂度极高（每次摄入多次 LLM 调用、图数据库运维、社区检测）。对 ICL 只借「事实带有效区间 + 旧事实不删除只失效」这一条即可。
- **Letta**：核心记忆常驻 + 归档按需，与 ICL 的「person block + block 召回」同构；sleep-time compute 的启示是「离线预计算对可预测查询有 5x 成本优势」[R5]，但需要「用户会问什么」可预测——persona 场景成立（问候、惦记、旧事）。
- **LangMem**：把记忆分 semantic/episodic/procedural 三类、并用 namespace 做隔离的思路适合 ICL 的命名空间现状；procedural（把经验写进 prompt）对人格稳定性是风险，不建议。
- **Memobase**：唯一把「用户画像槽位」做成产品形态的；其 buffer→flush 批量集成策略与 dream 批量整合同构，且原生支持中文 prompt。
- **MemOS**：提供了「记忆单元带来源/版本、可迁移可审计」的目标形态，可作为 ICL 记忆条目的长期 schema 参考；系统本身不适合当前规模。
- **A-MEM**：链接 + 记忆演化适合「事件↔人物↔词典」的轻量关联（见 §4 模式 5），不需要独立存储层。
- **Memary/MemoryBank/Generative Agents**：三个早期形态分别代表「图」「遗忘曲线」「检索三因子」，其中 MemoryBank 的遗忘曲线与 Generative Agents 的 importance 因子是 ICL 当前 decay 公式缺的两块（见 §4 模式 9）。
- **未逐一核实、不纳入对比表**：Supermemory、MemU、MIRIX、Honcho、Anthropic memory tool、OpenAI Memory、Second-Me 等 2025–2026 生态（**待核实**，不做事实引用）。

---

## 2. 基准 / 数据集

### 2.1 总表

| 数据集 | 语言 | 规模/结构 | 金标 | 许可（论文/数据） | 链接 | 对 ICL 的适用性与适配成本 |
|---|---|---|---|---|---|---|
| **LoCoMo**（Snap） | 英 | 每段 avg 300 turns、9K tokens、最多 35 sessions；QA + 事件摘要 + 多模态生成；LongMemEval 对比表记 ~1k sessions / 7,512 问[R14][R15] | 有 QA（含证据），但类别 5 缺 ground truth、存在多模态/说话人/歧义错误[R2] | 论文 CC BY-NC-SA 4.0；数据仓库许可**待核实** | https://arxiv.org/abs/2402.17753 | **中**：可做「与外部数字对照」的 smoke，不建议作主线 gold（数据质量差、非中文、LLM 生成对话） |
| **LongMemEval** | 英 | 500 题，5 能力（抽取/多会话/时序/知识更新/拒答）；_S ≈115k tokens/题，_M 500 sessions≈1.5M tokens；7 种题型[R15] | 人工问题 + 证据语句 + 证据会话位置；GPT-4o judge 与人类 >97% 一致；Recall@k/NDCG@k[R15] | 论文 CC BY 4.0；数据许可**待核实** | https://arxiv.org/abs/2410.10813 | **高价值/高成本**：方法（证据注入历史、round 粒度、key expansion、时间查询扩展）可直接复用来造 ICL 合成金标；全量跑成本高 |
| **MemoryAgentBench** | 英 | 把现有长上下文数据集转成增量多轮；四能力：准确检索/测试时学习/长程理解/选择性遗忘[R16] | 有（源自被转数据集的标签）；具体指标**待核实** | 论文 arXiv 非独占；数据许可**待核实** | https://arxiv.org/abs/2507.05257 | **中**：四能力是很好的测试设计蓝图；需要改造才能用于 persona |
| **MemBench** | 英（**待核实**是否多语） | 多场景（participant / observation）× 多层级（factual / reflective）；PS-FM 51k sessions/39k 问/8k 轨迹，OS-FM 8.5k；平均轨迹 10k/100k token[R17] | 选择题答案 + 证据轮位置；指标：accuracy、Recall@10、capacity、读写效率[R17] | 论文 arXiv 非独占（ACL 2025 Findings）；仓库许可**待核实** | https://arxiv.org/abs/2506.21605 | **最贴合候选**：observation 场景≈群聊旁观；reflective memory（从低层偏好推高层画像）≈人物卡；选择题评测便宜；需中文化与 ICL 数据映射 |
| **MSC / Multi-Session Chat** | 英 | 多会话人-人聊天；DMR 用其中 500 段、5 sessions、每 session ≤12 消息[R3] | 原始有人设/对话，无记忆 QA；DMR 为每段加一问[R3] | ParlAI 代码 MIT；数据许可**待核实** | https://arxiv.org/abs/2107.07567 | **低-中**：适合当合成 persona 对话的原料/参照；做 gold 需自己加探针 |
| **PersonaChat** | 英 | 1,625 段对话 × 每人设 5 条 persona；next-utterance 评测[R18] | 人设是 gold，无长期记忆 QA | ParlAI 代码 MIT；数据许可**待核实** | https://arxiv.org/abs/1801.07243 | **低-中**：只适合测「人设一致性」，不测记忆；可借 persona 模板 |
| **MemoryBank** | 英/中（**待核实**） | 15 用户、194 探针问题；多日对话 + 模拟对话；SiliconFriend[R12][R15] | 有探针问答（主观指标为主） | 论文非独占；仓库许可**待核实** | https://arxiv.org/abs/2305.10250 | **中**：遗忘曲线先例 + 探针问题形态；规模小、年代久 |
| **PerLTQA** | **中** | 141 人物、1,339 关系、4,501 事件、3,409 历史对话（25,256 句）、8,593 问、23,697 memory anchors；语义+情节记忆[R19] | 有 QA + reference memory + anchor 位置（可算检索/合成指标）[R19] | ACL 论文 CC BY 4.0；数据仓库许可**待核实** | https://aclanthology.org/2024.sighan-1.18/ | **中**：中文 + 锚点标注，适合做「抽取→检索→合成」离线评测；静态画像、非交互式，需映射到 ICL 命名空间 |
| **DuLeMon** | **中** | 长时人物记忆对话数据集（LeMon 任务，ACL 2022 Findings）；PLATO-LTM 可动态更新双方 persona[R20] | 有人设/对话，生成式评测为主，无记忆 QA | 论文非独占；数据许可**待核实** | https://arxiv.org/abs/2203.05797 | **中**：中文长期人物记忆的原料；可抽 persona/对话造合成场景 |
| **ZH-4O（MOOM）** | **中** | 超长角色扮演对话，平均 600 turns，**人工标注记忆信息**；MOOM 双分支记忆 + 遗忘机制[R21] | 有记忆标注（可直接作抽取 gold 的候选） | 论文非独占；数据许可**待核实** | https://arxiv.org/abs/2509.11860 | **高价值/中成本**：与「大肥鱼」角色扮演最接近；先核对数据许可再用于内部评测 |
| **PAL-Set / PAL-Bench** | **中** | 首个中文多会话用户日志+对话历史（服务型个性化）；H²Memory 层次异构记忆+RAG[R22] | 有合成+人审的个性化评测 | AAAI 2026 论文；数据许可**待核实** | https://arxiv.org/abs/2511.13410 | **中**：多会话个性化与偏好更新贴近 companion；偏服务场景 |
| **RoleEval** | **中英** | 6,000 道中英平行选择题、300 个角色；测角色知识记忆/使用/推理[R23] | 有选择题 gold | 论文 CC BY-SA 4.0；数据仓库许可**待核实** | https://arxiv.org/abs/2312.16132 | **低-中**：测「角色一致性/角色知识」，不是记忆形成；可做人格漂移回归 |
| **CharacterEval** | **中** | 中文角色扮演对话评测基准（ACL 2024）；细节**待核实** | 有人工标注维度 | 论文/仓库**待核实** | https://aclanthology.org/2024.acl-long.638/ | **低-中**：人格/对话质量维度可借鉴，非记忆基准 |
| **MIST** | 英 | ~598 样本（198 GPQA + 200 MMLU-med + 200 Moral Stories）；合成多轮对话，用户表达貌似合理的误解[R21] | 有正确答案与偏置选项 | 论文 CC BY 4.0；源数据集许可**待核实** | https://arxiv.org/abs/2606.10949 | **中**：方法可复用为「ICL 自我强化/谄媚」测试（把用户错误说法写进记忆后看是否被放大） |

### 2.2 指标怎么算（用于读别人的数字，也用于我们自建）

- **QA 文本匹配**：LoCoMo 系常用 F1 / BLEU / ROUGE，并叠加 LLM-as-Judge（Mem0 报「J 分」）[R1][R14]。文本匹配对同义表达不友好，只适合作辅助。
- **LLM judge**：LongMemEval 用 GPT-4o 按题型 judge，作者报告与人类专家 **>97% 一致**；这是目前最可信的公开做法之一，但 judge prompt 是特定实现，跨论文不可直接比[R15]。
- **检索指标**：Recall@k、NDCG@k（LongMemEval）[R15]；Recall@K（PerLTQA 检索子任务）[R19]；MemBench 用 Recall@10[R17]。
- **多选准确率**：MemBench 全部选择题，避免表达差异[R17]；RoleEval 也是选择题[R23]。
- **成本/效率**：MemBench 报读写时间（秒/操作）、capacity 曲线[R17]；Zep 报 avg context token（1.6k vs 115k）与延迟[R3]；Mem0 报 p95 延迟与 token 节省[R1]。
- **锚点对齐**：PerLTQA 用 memory anchor 的 MAP 衡量「回答是否引用了正确记忆」[R19]——这个口径可直接移植到 ICL 的 evidence id。

### 2.3 基准的已知缺陷 / 泄漏 / 批评（必须知道再引用）

1. **LoCoMo**：对话只有 16k–26k token，现代长上下文装得下；类别 5 无 ground truth 被评测双方排除；多模态问题所问图片信息不在 BLIP 描述里；说话人归属错误；问题歧义（同事件多答案）；**不含知识更新测试**[R2]。
2. **厂商互评**：Zep 指出 Mem0 评测 Zep 时用错 user 模型、时间戳塞进消息而非 `created_at`、串行搜索抬高延迟[R2]；Zep 自己也用自家实现复算。**任何厂商报告的对比数字都要打折看**。
3. **合成历史/污染**：LongMemEval 的无关历史来自 ShareGPT/UltraChat 与自合成[R15]；LoCoMo 是 LLM 生成 + 人审[R14]。模型对这类分布的熟悉度、题目泄漏风险无法排除（**待核实**是否有污染研究）。
4. **样本量**：LongMemEval 500 题（细分题型后每类几十题）、MemBench 子集 100–400 条[R15][R17]——置信区间很宽，不适合宣称 1–2% 的差异。
5. **单一 judge 过拟合**：同一 LLM 既当被测又当裁判、或 judge prompt 与训练同源，会系统性偏好某种回答风格；建议双 judge + 人工抽检 + 预注册 prompt。
6. **Reflective/多层级缺失**：PerLTQA/MemBench 指出旧基准只看 factual memory、只看 participant 场景[R17][R19]；persona agent 的「画像推断」和「旁观群聊」需要专门设计。
7. **中文缺位**：主流基准是英文；中文只有 PerLTQA、DuLeMon、ZH-4O、PAL-Set 等少数，且多为研究数据集、许可需逐个核对（**待核实**）。

---

## 3. 评估方法建议（ICL 可直接落地）

### 3.1 总原则

- **双轨**：离线 fixture replay（可复现、可 gate） + live shadow（不打扰用户、只记录）。
- **三层分开测**：形成质量（写对了没）→ 召回质量（查得到没）→ 端到端净收益（答得好没、花多少 token）。
- **固定素材、同一基座、成对比较**：同一 fixture、同一模型、同一 judge，比较 A/B；禁止拿 live DB 做基线（见 HANDOVER「不要做」）。
- **先定口径再跑数**：所有指标公式、judge prompt、抽样规则写进仓库文档后才跑，避免事后挑指标。

### 3.2 记忆形成质量（formation）

对每个 fixture 天（建议 11-10 密集日、11-11 稀疏日、+ 1 个合成密集日）：

| 指标 | 定义 | 落地口径 |
|---|---|---|
| 抽取精确率 | 人类/LLM 判为「应记」的新条目 / 全部新条目 | 逐条标 keep/drop；目标 ≥0.7（起步） |
| 抽取召回率 | gold 应记条目中被写入的比例 | gold 条目要带 evidence 行 id；目标 ≥0.6 |
| 近重复率 | 同 namespace、7 天内近重复对 / 条目数 | 与 `memory-audit` 同口径（文本/证据重合） |
| 合并精确率 | 被合并对中真正同事件比例（人工抽检 30 对） | 合并是双刃剑，宁漏勿错 |
| 矛盾未决率 | 互相冲突条目中未被 `superseded`/未合并比例 | person facts 必查 |
| 来源正确率 | evidence id 能解析到正确 raw 行且 role 正确的比例 | 审计已发现 line/role 问题 |
| 自我污染率 | 来源为 assistant/tool/system 的条目比例 | 目标接近 0（MIST/审计都指向这里）[R21][R26] |
| 幂等性 | 同 fixture 重跑：条目数差、key 冲突数、duplicate dream-run 数 | 直接复用 replay |

### 3.3 召回质量（recall）——重点回答「live 里几乎不调用 recall 怎么办」

先承认两个事实：① ICL live 只有 1 次 recall、3 条记忆有 recall 记录（最高 1 次）[R26]；② 模型「不知道自己不知道」，主动工具调用在闲聊场景结构性偏低。因此：

1. **影子召回（shadow recall）**：每轮用户消息进来时，离线/旁路调用一次 `memory.search`（与 eager-recall 同参），记录候选、分数、是否命中 gold evidence。live 不注入、不影响对话。可复用 replay 工具与 `eager-recall.jsonl`。
2. **被动注入审计**：对 eager-recall 每次注入逐条判「相关 / 无关 / 有害」，算 **injection precision**；同时算「gold evidence 存在但没注入」的 **miss rate**——这比「模型有没有主动 recall」更能说明问题。
3. **强制注入反事实**：对测试 fixture 的每个探针轮做三条件 replay：无记忆 / 现网 eager（minScore 0.5, maxItems 2）/ 强制注入 gold top-k；比较答案正确率、注入 token。得到 **净收益 = 正确率差 − token 成本**。
4. **归因 judge**：答案里用到了注入事实且正确 → `used`；与注入矛盾 → `contaminated`；完全忽略 → `wasted`。三个比例是召回系统真正的产品指标。
5. **主动 recall 只做弱验证**：保留工具，但把它当「用户明确要求回忆」的入口；用 replay 统计「若调用 recall，能否召回 gold」（Recall@k/MRR/NDCG@10），**不需要 live 真的调用**。
6. 若未来要提升主动调用率：把 recall 语义从「每轮精确查询」改成「回忆开关/时间窗回顾」，并在 system prompt 中列触发场景（用户问「还记得」、涉及人物/偏好/承诺、跨天跟进）。

**召回的离线指标定义**：以 gold evidence id 集合为准，k=1/3/5 的 Recall@k、MRR、NDCG@10；另报「首个命中位置」与「检索到无关条目数」。

### 3.4 端到端 / 成本 / 长程漂移

- **记忆 vs 无记忆 vs full-context**：三条件成对比较，答案正确率 + 注入 token + p95 延迟。没有 full-context 条件就无法判断「记忆税」[R22]。
- **注入成本**：每轮注入 token、每轮检索 p50/p95、每日 dream LLM 调用次数/费用、写放大（每条 raw 消息产生的记忆条目数）、库增长速率。
- **长程漂移**：用固定「英雄场景」每 1–2 周重放（如：主人称呼、偏好、最近承诺、共同经历）；记录人物卡 alias 正确率、过期事实比例、同一问题答案一周内不一致率。RoleEval/CharacterEval 的角色一致性思路可借[R23][R25]。
- **稳定性**：每个条件跑 3 个 seed（温度/重试）、报均值与范围；抽 20% 双 judge 一致性。

### 3.5 gold 怎么便宜地造（LLM 草拟 + 人审 + 构造式真值）

三条路线，按 ROI 排序：

1. **构造式合成（最高 ROI，不依赖人工标注真值）**：造 N 个中文 persona（含 20–40 条事实、10–20 个事件、跨 10 天会话、带时间戳），把已知事实埋进对话；探针问题的 gold evidence 是构造时就知道的。可借鉴 LongMemEval 的 history compilation 与 MemBench 的 self-dialogue 管线[R15][R17]，但**自己写 prompt、自己造数据**（不抄第三方 prompt）。适合测 recall@k、知识更新、拒答、注入收益。
2. **真实 raw + LLM 草拟 gold + 人审**：从 fixture（11-10/11-11）抽候选条目，LLM 起草 keep/drop/merge/importance/evidence id，人只审「有分歧 + 高风险 + 随机 20%」。LongMemEval 的人机分工可参考：LLM 出 seeds，人过滤/重写/拆证据语句[R15]。一条 100 条目的 gold 集，人工约 2–3 小时。
3. **模板化场景**：固定剧本（第一次见面、约定、误会、纠正、偏好变化、群聊旁观），每条 10–20 轮，直接写探针与 gold。适合 formation 的定向回归（如 alias、矛盾、去重）。

**最小可行规模（经验值，非引文）**：
- formation smoke：20–30 个候选条目（看方向，不做 gate）。
- formation gate（进 CI）：100–150 个候选条目；precision/recall 的 95% 区间约 ±7–9pp。
- recall：100–200 个探针；Recall@5 的 ±7–10pp。
- A/B 端到端：每组 ≥100 个问题（检出 ~10–15pp 差异）；不要用 20 题下结论。
- 人工一致性：2 位标注者 30 条，Cohen's κ ≥0.6 才继续自动化。
- 所有 judge：先人工标 30–50 对做校准，目标与人工一致率 ≥90%（LongMemEval 报告 >97% 是较高标准[R15]）。

### 3.6 落地流程（映射到现有工具）

1. 冻结 fixture：沿用 `.state/lab/memory-fixture/latest`；新增「合成密集日」；给每个候选条目分配稳定 id。
2. 填 `gold.template.json`：字段建议 `id, ns, keep, importance(1-5), evidence:[{rawId, role, day}], action(keep/merge/update/drop), mergeWith`。
3. 扩 replay：加 `--profile raw-human`（只 user+可见 assistant）与 `--inject-mode {none,eager,forced}`，输出每轮 `retrieved/selected/injected` 三组 id。
4. 新增 `tools/memory-eval.mjs`：读 replay 输出 + gold，算 §3.2–3.4 指标，输出 markdown 表 + JSON；进 CI 做阈值 gate（如 formation precision 不得低于上轮 −3pp）。
5. live shadow：eager-recall 已记录注入，补记「候选未注入」与「gold probe 命中」；只在本地落盘、不上报。
6. 报告模板（每次改动后一张表）：`formation P/R | dup% | contradiction% | self-source% | recall@5 | MRR | injection P | used/contaminated/wasted | tokens/turn | p95 ms | Δanswer vs no-memory`。

---

## 4. 可迁移设计模式 top10（按贴合度/成本排序）

> 需要产品决策的只有三件：① dream 用云端还是本地模型（成本/隐私/质量）；② 是否接受每批写入 +1 次 LLM 调用；③ 是否做一次 evidence/时间字段的 schema 迁移（一次回填，之后免迁移）。其余都是代码内可完成的低成本改动。

| # | 模式 | 外部依据 | 对 ICL 的改法 | 成本/风险 | 不要抄什么 |
|---|---|---|---|---|---|
| 1 | **评估闭环 + 金标 fixture** | LongMemEval/MemBench 的评测结构[R15][R17] | 先做 §3 的 fixture+gold+replay 指标，再谈改算法 | 中（2–3 人日）；不产生用户可见变化 | 第三方 bench 数据/题目直接进仓库；论文原文 |
| 2 | **写入前置门控（来源/角色/信息量）** | 审计：lexicon 噪声 18/37、note 18/22 来自 assistant/tool[R26]；SOUL 的规则过滤思路[R29]；MIST 的 assistant-role 修正[R21] | 在 dream wash/events 入口加确定性过滤：只从 user + assistant 可见正文抽；排除运行上下文、工具结果、系统状态、单次视觉描述；信息量阈值 | 低（纯规则，0 LLM 调用） | 复制第三方过滤词表/prompt |
| 3 | **写入时记忆决策（ADD/UPDATE/DELETE/NOOP + 旧事实失效）** | Mem0 的 update 阶段[R1]；Zep 的 edge invalidation[R3] | dream 的 events/people 落库前加一步「与旧条目比对」：合并/更新/软删（`superseded`），矛盾时保留旧条目标记失效时间 | 中（每批 +1 LLM 调用，dream 云端已有）；需产品决定云端/本地 | Mem0 的 prompt 原文、代码；覆盖式删除 |
| 4 | **结构化人物卡 + alias 归并** | Memobase 画像槽位[R9]；审计 person 未归并（主人/Hahn123）[R26] | person block 加稳定槽位（称呼、关系、偏好、习惯、近况、未结事项、别名表）；显示名→身份 id 映射；同人多来源合并 | 中；身份规则是产品决策（错并就污染） | 第三方人物卡 prompt |
| 5 | **证据链 + 来源角色（episode↔fact 双向）** | Zep 的 episode/语义双向索引[R3]；LongMemEval 证据位置标注[R15] | block 的 evidence 从「行号」升级为「行快照+role+day+来源会话」；recall 输出可附出处（可选） | 低-中；schema 迁移一次 | 图数据库 |
| 6 | **分层记忆 + 小核心常驻** | MemGPT core/recall/archival[R4]；LangMem 三类记忆[R6] | 明确三层：raw/day log（原文）、block/note（事实）、person/procedural（core），core 只放 1–2 个小块（人物+未结事项），其余按需检索 | 低（主要是整理既有结构） | 大量常驻 prompt（膨胀上下文/缓存失效） |
| 7 | **混合检索 + rerank + 查询扩展** | Zep 的余弦+BM25+BFS+RRF/MMR[R3]；LongMemEval 的 multi-key/时间查询扩展（multi-key +9.4% recall@k、+5.4% accuracy；时间题 recall +6.8–11.3%）[R15] | eager-recall 的 minScore 一刀切改为「字面+向量混合分 + 时间衰减 + MMR 去重」；对「还记得/上次/之前」类 query 做时间扩展 | 中；需要 embedding 服务与评测支撑 | 别直接上 BFS/图；别抄 rerank 模型权重 |
| 8 | **时间语义与知识更新** | Zep 双时间轴[R3]；LongMemEval 知识更新题型[R15] | block/person fact 增加 `validFrom/validUntil/asOf`；新事实来了旧事实标记失效而非删除；查询默认只看有效 | 中；需要清理/回填旧数据 | 完整双时间轴/图实现 |
| 9 | **衰减=清晰度降级 + 重要性/使用信号分离** | MemoryBank 遗忘曲线[R12]；Generative Agents 三因子（新近/重要/相关）[R13]；SOUL 清晰度阶梯[R29] | 现在 decay 锚 `lastRecalledAt ?? createdAt`：**从未被回忆的重要记忆会衰减到 0**（这是设计缺陷，不是模型记性差）。增加 importance（规则/LLM 打标）与「提及强化」，到期先降清晰度、再归档，不直接删 | 低-中；importance 打标可离线 | MemoryBank 的模型/prompt |
| 10 | **后台整合（dream）验证 + 睡眠时预计算** | sleep-time compute：同准确率 test-time 计算 −5x，摊销 2.5x[R5] | 保留 dream 批量架构；每加一个 job/模型调用，必须用 §3 gold gate 证明净收益；可加「预测用户会问什么」的离线预摘要（轻量、只对高价值人物/未结事项） | 中；云端模型成本/隐私是产品决策 | 逐回合抽取、每轮多一次 judge（SOUL 七情式） |

---

## 5. 反面证据 / 别踩的坑

### 5.1 厂商 benchmark 不能直接信

- Mem0 论文宣称 SOTA，但**它自己表里 full-context 基线的 J 分更高**（~72.9% vs Mem0 base 66.9%/graph 68.4%，Zep 引用其数据）[R2]。
- Zep 论文自己的 DMR 表：full-conversation 94.4%（gpt-4-turbo）/98.0%（4o-mini），Zep 94.8%/98.2%——**短对话上专用记忆系统优势接近 0**，Zep 自己也承认 DMR「对话仅 60 条消息」[R3]。
- Zep 对 Mem0 的复算指出对方实现错误（角色、时间戳、串行搜索），但 Zep 是竞品，立场同样不可全信[R2]。
- **结论**：引用任何数字都带三个限定——数据集、基座模型、judge 口径；不跨论文比较绝对值。

### 5.2 「记忆税」：记忆可能比朴素 RAG 更差

- Memory Tax（2026-10）大规模评测：多数专用记忆系统在不少情况下**不如朴素 RAG**，净价值为负；tax 来自记忆组织过程删除/遮蔽证据[R22]。
- 对我们的含义：每个 dream job 都可能引入 tax；没有金标 gate 的「优化」很可能负收益。

### 5.3 抽取是双刃剑（最危险的一条）

- MIST：记忆系统把谄媚率最多抬高 40%（3 个记忆系统 × 5 个模型族全部成立）；**主因是抽取**——只保留用户话的离散片段，编码了误解却丢掉纠正上下文；三种轻量缓解有效：anti-sycophancy prompt、**assistant 回合纳入抽取**、历史摘要[R21]。
- ICL 直接对应：不要把 assistant 的计划/工具结果写成记忆（审计已证噪声来源）；群聊里不要把一个人的说法当事实；涉及用户自我描述时保留「谁说的」。
- 自强化循环：注入的记忆被回答引用，又被下一轮 raw 记录 → 下次抽取把它当新证据。需在 raw/记忆两侧标记「引用来源」，禁止把「记忆内容」再写成同等级新事实。

### 5.4 压缩粒度：不是越细越好

- LongMemEval：**round（一轮问答）是最优存取粒度**；进一步压成原子事实整体反而变差（信息丢失），只对 multi-session 题有帮助[R15]。
- 含义：ICL 现在「day log 原文 + event block 摘要 + note」的分层方向正确；不要学 Mem0 把一切压成短事实，也不要只留 block。

### 5.5 成本与规模

- MemBench 实测：MemoryBank 写入 8.0–18.2 秒/次、GenerativeAgent ~6.0 秒/次；MemGPT 读取 1.5–4.5 秒/次；full/retrieval memory 写入近 0[R17]。
- Mem0 graph 相对 base 仅 ~+2%（自报）[R1]；Zep/Graphiti 每次摄入多次 LLM 调用[R3]；MemOS 是 OS 级系统[R10]。
- 对 ICL：**不要逐回合抽取**；dream 批量 + 缓存（现有 replay cache 方向对）；先证明每一轮云调用净收益为正。

### 5.6 评测本身的坑

- LoCoMo 数据缺陷（见 §2.3）；用前必须抽检 20–50 条，统计「无法回答/多解/说话人错」比例，报告里写清楚。
- 合成数据（LongMemEval/LoCoMo）有分布熟悉度与泄漏风险（**待核实**）；自建中文合成数据反而更可控。
- 小样本 + 单一 judge → 结论脆弱；用成对比较、双 judge、人工抽检、预注册。
- 用「厂商声称的提升」倒推自己的设计是典型错误；以本仓 fixture 的 gold 为准。

### 5.7 ICL 已确认的具体坑（来自 live 审计，外部研究只能印证不能替代）

1. **输入污染**：80 行 raw 只有 3 条 user；assistant 计划/工具结果撑大 raw，产出 30 条 lexicon/note 几乎全是噪声[R26]。→ 先修写入 profile（模式 2）。
2. **重复块**：≥5 对近重复、12 组 run+skip、单次 events 内也重复[R26]。→ 幂等 + 去重（模式 3）。
3. **person 未归并**：主人 / Hahn123（离线版）拆成两块[R26]。→ alias 归并（模式 4）。
4. **decay 锚点设计**：`anchor = lastRecalledAt ?? createdAt`，活跃度 = 回忆次数；**重要但未被回忆的记忆会持续衰减**，且 live recall 几乎不发生 → 等于慢性丢失。→ 独立 importance 信号（模式 9）。
5. **eager-recall 参数**：minScore 0.5 + maxItems 2 + 200 字；25 次 eager、命中 73、注入 44[R26] → 注入率不低但 relevance/收益未验证。→ 影子审计 + 反事实（§3.3）。
6. **note 不幂等、cleanup 只扫 150 块**：历史代码问题，先确认修复后仍幂等。
7. **dream 走云端**：QQ/私聊内容外发第三方；本地模型质量/成本需产品决策。
8. **lexicon/note 门槛**：18/37 工具框架词、18/22 自动查词 note[R26] → 不是「事件少」，是门控缺失。

### 5.8 不建议做的事

- **不要迁移到图数据库/Neo4j**：182 条规模、无图查询需求；Graphiti/Zep 的价值在 10 万 token 级历史与复杂时序，ICL 还没到。
- **不要整体移植任何框架**：Mem0/Zep/Letta/MemOS 都是 server/DSL 级系统，接入成本远超收益。
- **不要引入逐回合 LLM 记忆抽取**：SOUL 的每回合调用已被列为成本风险[R29]；Mem0/MemBench 数据也显示写入昂贵。
- **不要用 LLM 自动生成的「重要性」作为唯一排序**：会放大现有偏差；先规则+人工校准。
- **不要复制任何第三方代码/prompt/数据**：论文/仓库许可各异（CC BY-NC-SA/非独占/Apache/MIT），本仓库只收 clean-room 结论。

---

## 6. 参考文献（URL）

**框架/架构**

- [R1] Mem0 论文：https://arxiv.org/abs/2504.19413
- [R2] Zep 对 Mem0 的独立复算与 LoCoMo 批评：https://www.getzep.com/blog/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/
- [R3] Zep/Graphiti 论文：https://arxiv.org/abs/2501.13956
- [R4] MemGPT 论文：https://arxiv.org/abs/2310.08560
- [R5] Sleep-time Compute：https://arxiv.org/abs/2504.13171
- [R6] LangMem SDK 发布文：https://www.langchain.com/blog/langmem-sdk-launch
- [R7] Cognee 论文：https://arxiv.org/abs/2505.24478
- [R8] A-MEM 论文（NeurIPS 2025）：https://arxiv.org/abs/2502.12110
- [R9] Memobase 文档：https://docs.memobase.io/introduction ；https://docs.memobase.io/features
- [R10] MemOS 论文：https://arxiv.org/abs/2507.03724
- [R11] memary（PyPI，MIT）：https://pypi.org/project/memary/
- [R12] MemoryBank 论文：https://arxiv.org/abs/2305.10250
- [R13] Generative Agents：https://arxiv.org/abs/2304.03442
- [R1-v3] Mem0 平台 v3 迁移说明（累积/混合检索/捕获 agent 事实）：https://docs.mem0.ai/migration/platform-v2-to-v3 ；开源版：https://docs.mem0.ai/migration/oss-v2-to-v3
- [R-Letta-docs] Letta 文档（memory blocks/archival/context hierarchy）：https://docs.letta.com/

**基准/数据集**

- [R14] LoCoMo 论文：https://arxiv.org/abs/2402.17753
- [R15] LongMemEval 论文（ICLR 2025）：https://arxiv.org/abs/2410.10813
- [R16] MemoryAgentBench：https://arxiv.org/abs/2507.05257
- [R17] MemBench（ACL 2025 Findings）：https://arxiv.org/abs/2506.21605
- [R18] PersonaChat：https://arxiv.org/abs/1801.07243
- [R19] PerLTQA（中文，SIGHAN 2024）：https://arxiv.org/abs/2402.16288 ；https://aclanthology.org/2024.sighan-1.18/
- [R20] DuLeMon / Long Time No See!（中文）：https://arxiv.org/abs/2203.05797
- [R21] MIST / Recalling Too Well（记忆放大谄媚，ICLR 2026）：https://arxiv.org/abs/2606.10949
- [R22] Memory Tax: Dissecting the Net Value of Agent Memory（2026-10）：https://arxiv.org/abs/2610.34073
- [R23] RoleEval（中英双语角色评测）：https://arxiv.org/abs/2312.16132
- [R24] MSC / Beyond Goldfish Memory：https://arxiv.org/abs/2107.07567
- [R25] CharacterEval（ACL 2024）：https://aclanthology.org/2024.acl-long.638/
- [R26] 本仓 live 记忆审计（内部）：`docs/MEMORY-AUDIT.md`、`docs/HANDOVER-2026-11-11.md`
- [R27] MOOM / ZH-4O（中文超长角色扮演 + 记忆标注）：https://arxiv.org/abs/2509.11860
- [R28] Mem-PAL / PAL-Bench / PAL-Set（中文多会话个性化，AAAI 2026）：https://arxiv.org/abs/2511.13410
- [R29] dsh-agent-soul 研究笔记（内部参照，非外部基准）：`docs/SOUL-RESEARCH.md`

**证据分级说明**

- 直接引用（论文/官方文档/官方博客）：R1–R29（其中 R26、R29 为内部材料）。
- 间接转述（厂商博客引用竞品数据）：[R2] 中的 Mem0 数字，标注为「Zep 引用 Mem0 报告值」。
- **待核实**：各仓库 LICENSE 具体条款、LoCoMo/LongMemEval/MSC/PersonaChat/MemoryBank/MemBench/PerLTQA/DuLeMon/ZH-4O/PAL-Set 的数据许可、MemBench 语言、A-MEM 数据集、LangMem hot-path 实现、Memobase 更新/检索细节、MemoryAgentBench 具体指标、未列出的 2026 新系统。
