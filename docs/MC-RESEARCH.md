# MC 外部成功项目研究（MC-RESEARCH）

> 状态：**MC 长跑已冻结（2026-11-06 16:45 HKT）**；本文只做研究/设计，不跑 MC 测试、不启服、不加工具。
> 对齐：mc-lab [`MC-FREEZE-2026-11-06.md`](../../mc-lab/docs/MC-FREEZE-2026-11-06.md)、mc-lab [`E2-HARNESS.md §10`](../../mc-lab/docs/E2-HARNESS.md)；本仓 [`MC-LOCAL3-FORENSICS.md`](MC-LOCAL3-FORENSICS.md)、[`E2-HARNESS.md`](E2-HARNESS.md)。
> 研究时间：2026-11-06；资料来自公开论文/项目页（引用见 §6），外部指标是论文自报，不当作我们的验收基线。

## 0. TL;DR（先给结论）

外部项目真正解决的不是“工具不够多”，而是三件事：

1. **技能表示 + 可复用**：Voyager 把“可执行代码 + 环境反馈 + 自验证”沉淀成技能库；Cradle 把“语义技能 → 可执行控制”沉淀成程序记忆。我们缺的是**经过验收、可检索的宏契约**，不是再加一个工具。
2. **结构化任务/蓝图 + 分层执行**：MineAnyBuild 把空间规划拆成可评测维度；APT 把“文字/图片 → 蓝图（方块+坐标）→ 逐步执行”做成显式管线；我们的 `shelter` 已有蓝图/验收雏形，但没有把“验证过的结构”作为技能产物沉淀。
3. **验收/反思驱动的控制环**：Voyager 的 iterative prompting 用执行错误+自验证改代码；APT 有 visual reflection；Cradle 有 self-reflection/task inference。本地 24h 的根因不是模型不会“再试”，而是**没有机器可判的验收与失败驱动策略**——local3 92 个 shelter task、90 次失败、0 个 `home_set`，模型靠 say 播报“等它盖好”。

**建议**：MC 恢复前先固化“验收指标 + 回放/分段检测 + 技能契约”，不新增工具；详见 [`E2-HARNESS.md §10`](E2-HARNESS.md)。本文 §3 给映射表，§4 给不适用边界，§5 给优先级。

## 1. 研究方法与边界

- 读取公开论文摘要/项目页/代码说明；只采用摘要/正文明确陈述的机制与指标，不推断未公开实现。
- “可搬到我们”按我们现有资产判断：`packages/mc-body`（body/head 分离、macro/task、shell 验收、eyes）、`packages/plugins/mc-link`（工具面）、mc-lab（E2 harness/supervisor/记忆）。
- “不适用”不等于项目不好，而是成本/约束不匹配（本地 27B、无训练预算、已有 head/body 架构、用户要求不加工具）。
- 外部指标只作方向参考；我们的验收以 `docs/E2-HARNESS.md §10` 的机器可判指标为准。

## 2. 逐项目分析

### 2.1 Voyager（LLM 终身学习 agent，Minecraft）

- 核心机制（论文摘要）：**自动课程**最大化探索；**不断增长的技能库**（可执行代码，存/取复杂行为）；**iterative prompting** 把环境反馈、执行错误、自验证纳入程序改进；GPT-4 黑盒调用、不微调；技能时序扩展、可解释、可组合，缓解灾难性遗忘。
- 可搬到我们的机制：
  - **技能契约化**：把 `shelter/collect/combat` 宏变成“参数 + 前置条件 + 后置验收（verify/entryOk/home/failure code）+ 证据”的 registry；复用现有 body 宏，不新增工具。
  - **迭代反思的“可执行”部分**：失败结果（如 `verify.summary`、`deficit/alternatives`、`collect: no-resources`）直接驱动下一次参数变化（改 material/扩半径/换区域），而不是让模型自由重试。
  - **自动课程的离线版**：用“技能前置条件”生成下一个可做任务（有木头→做工作台；有 27 dirt→shelter），先做**确定性任务选择器**，不做在线探索课程。
- 不适用/边界：Voyager 依赖强模型生成/修复代码、长上下文与在线试错；我们的技能是**预置宏**，且本地 27B 代码生成/修复不稳定；直接搬“代码库”会扩大行动面，与“不加工具”冲突。可搬**契约和验收**，不搬**任意代码生成**。
- 验收指标：技能复用率（同一技能被不同任务重复调用且成功率不降）；技能成功率（按 kind+params 桶）；从失败到成功的**重试次数 ≤2**；tech-tree/物品多样性仅作参考，不作 gate。

### 2.2 MineAnyBuild（空间规划 benchmark）

- 核心机制（论文摘要）：面向开放世界 agent 的**空间规划 benchmark**；4,000 个多模态指令任务；评测四维：**空间理解、空间推理、创造力、空间常识**；提供可扩展数据收集范式（玩家内容）。
- 可搬到我们的机制：
  - 把“造一个能用的 3×3 小屋”拆成可判维度：**结构正确（墙/顶/门/内部）**、**可用（entryOk/内部可站）**、**常识（门不堵、地面可站、材料足够）**、**可复现（verify JSON）**；直接对应我们已有 `verifyShelter` 字段。
  - 用 benchmark 的“任务卡”形式固化测试场景（输入材料/位置/目标结构/验收 JSON），而不是自然语言“盖个房子”让模型自由发挥。
- 不适用/边界：它是 benchmark/数据生成，不是 agent 框架；不提供长跑控制/记忆/安全机制；不能直接搬来当产品能力。4,000 任务规模也远超当前冻结期预算。
- 验收指标：结构维度分项通过率（walls/roof/door/interior/floor/entry）；**首次通过率**与**2 次内通过率**；同参数重复失败率；不接受截图/模型自述作为唯一证据。

### 2.3 APT（LLM blueprint / text-to-blueprint 建造）

- 核心机制（论文/项目页）：LLM 做**建筑规划**；CoT 先产 **layout synopsis**（组件/位置、尺寸、描述/施工顺序），再产**可执行蓝图**（方块类型 + 3D 坐标的 Python 列表）；RAG 记忆 + **visual reflection**（多角度 first-person 截图检查后修蓝图）；执行用 mineflayer primitive actions；VLM 评估 correctness/complexity/creativity/functionality；论文报告 memory 带来显著提升，reflection 单独收益有限，并出现自发“脚手架”行为。
- 可搬到我们的机制：
  - **蓝图即一等产物**：`makeShelterSpec` 已有局部坐标/层/门位；下一步把蓝图 JSON 作为 `build`/`shelter` 的输入/输出契约（可回放、可 diff），模型只填意图，不逐方块算坐标。
  - **施工顺序显式化**：地面/墙/临时支撑/屋顶/拆支撑的顺序我们已在 body 做；应把顺序写进蓝图/技能契约的“可验收步骤”，而不是藏在执行器里。
  - **反思用现成证据**：visual reflection 在我们这里可先换成 **verify JSON + eyes 截图**（截图只作辅助），失败时用 `verify.summary`/缺失面/缺材料驱动重试，不依赖强视觉模型。
  - **脚手架**：我们的临时支撑/中心柱就是工程化版本；可把“支撑/拆支撑”作为蓝图元数据，验收时检查临时块已清空。
- 不适用/边界：APT 依赖 GPT-4o 级空间推理/视觉；本地 27B 生成复杂蓝图不可靠；VLM 评分不能当唯一验收；我们不引入图像扩散/自动建房器。
- 验收指标：蓝图可执行率（生成→执行无语法/坐标错误）；结构分项通过率；**memory 命中后重试次数下降**；visual reflection 只作 P2 辅助，不进 P0 gate。

### 2.4 MineDojo（开放世界 agent 环境 + 互联网知识）

- 核心机制（论文摘要）：trinity——多任务环境（数千 open-ended 任务）、互联网规模多模态知识库（视频/教程/wiki/论坛）、可扩展 agent 架构；用预训练视频-语言模型做学习奖励，解决自由文本任务。
- 可搬到我们的机制：
  - **任务=自由文本 + 可判 goal**：把“她说的目标”转成机器可判 acceptance（结构/物品/位置/状态）；这与我们 phase A 验收一致。
  - **知识库分层**：我们的 `docs/MC-*.md` + skills 是“知识”，但缺**按任务检索的入口/版本**；可把技能契约/失败案例索引做成离线检索（不新增工具，先文档化）。
- 不适用/边界：MineDojo 是仿真+训练框架，依赖 RL/视频预训练与大规模数据；我们没有训练预算、也不训练新模型；不搬“奖励模型/RL”。
- 验收指标：任务成功率；自由文本→验收映射覆盖率；失败分类覆盖率（环境/技能/材料/规划）；不追 MineDojo 的分数。

### 2.5 Cradle（通用电脑控制 / 六模块 agent）

- 核心机制（论文摘要）：GCC 设定（截图输入、键鼠输出）；六个模块：information gathering、self-reflection、task inference、skill curation、action planning、memory（episodic + procedural）；用 LMM 生成代码级技能并执行；在 RDR2 完成 40 分钟任务、多软件/游戏评测；记忆/技能可组合。
- 可搬到我们的机制：
  - **self-reflection + task inference**：我们的 supervisor/body 已有部分（watchdog/auto_defense/暂停），但缺“**任务级反思**”：任务失败后先判断“继续/换参数/换任务/停”，并把结论写回记忆；可用现有 task failure fields 驱动，不新增工具。
  - **episodic/procedural memory 分离**：我们记忆目前偏对话/事件；可把“**技能契约+验收结果**”作为 procedural memory（文档/registry），把“这次 run 的证据”作为 episodic（checkpoint/forensics）。
  - **task inference**：按危险/时间/材料/健康在“继续当前任务/回家/找材料/睡觉”之间切换；先做确定性规则，不依赖 LMM。
- 不适用/边界：Cradle 的像素级键鼠控制/通用软件目标与 MC 专有 API（mineflayer）不同；本地模型延迟高，不适合高频截图控制；不搬“任何软件”抽象层。
- 验收指标：长任务分段成功率（每段有 checkpoint）；task switch 的**错误切换率/切换延迟**；反思后重试成功率；记忆命中率。

### 2.6 Mindcraft（LLM + Mineflayer 多 agent 框架）

- 核心机制（项目页）：开源框架，把 LLM 与 **Mineflayer** 结合做可编程 Minecraft bot；多模型后端；**profile 配置 + task suite + evaluation**；JS/Node 为主，Docker；支持多 agent 协作与任务评测。
- 可搬到我们的机制：
  - **profile/task suite 的可复现配置**：我们已有 body/head 分离与 skills；可补“**场景 profile（world/seed/初始物品/时间/任务卡）**”和“**任务 suite + 结果表**”，使每次 run 可复现/可对比。
  - **多 agent/多 bot 编排**：我们暂时单身体；可保留接口设计，不现在实现。
  - **工具面收口**：Mindcraft 的 profile 化说明“工具多不等于能力”；我们应冻结行动面，靠任务卡/验收提升，不再加工具。
- 不适用/边界：Mindcraft 是工程框架/评测套件，不提供结构验收/长跑 gate；其模型与提示词策略不直接适配本地 27B；不引入其运行时依赖。
- 验收指标：同 profile 重跑结果一致性；任务 suite 通过率；配置变更的回归差异；启动/资源开销。

### 2.7 其它相关（只作参考）

- **Plan4MC / Skill RL & Planning**（arXiv 2303.16563）：技能图 + RL/规划解决长程任务；可借鉴“技能依赖图/前置条件”，但不搬 RL。
- **Odyssey**（开放世界技能）：技能课程/组合思路与 Voyager 类似；本地模型不适用。
- **JARVIS-1/Optimus-1**：多模态记忆/长程任务；记忆分层可参考，成本高，暂不纳入 P0。

## 3. 外部机制 → 我们组件 → 验收映射

| 外部机制 | 我们已有/可复用 | 需要补的“契约” | 机器验收指标 |
|---|---|---|---|
| Voyager 技能库 | `mcb_do` 宏 + body `task kind` | 技能 registry：前置/参数/后置/failure code/证据 | 技能成功率、复用率、失败后 ≤2 次重试 |
| Voyager 自动课程 | `time`/`status`/记忆 | 离线“可做任务”选择器（按前置条件） | 任务选择有效率；无效任务率 |
| Voyager iterative prompting | task failure result 字段（verify/deficit/no-resources） | 失败→参数变化的规则（改材料/扩半径/换区域） | 失败后成功转化率；重复同参失败率 |
| MineAnyBuild 四维 | `verifyShelter` 分项 | 任务卡：场景+材料+目标+验收 JSON | 结构分项通过率、首次/2 次内通过率 |
| APT 蓝图 | `makeShelterSpec`/`shelterBuildOrder` | 蓝图 JSON 一等产物、可回放/diff | 蓝图可执行率、结构通过率 |
| APT visual reflection | eyes 截图 + verify | 先 verify 后截图；截图仅辅助 | 反思后修复成功率；不使用截图当唯一证据 |
| MineDojo 自由文本 goal | 自然语言任务 | 文本→验收映射模板 | 映射覆盖率/失败分类覆盖率 |
| Cradle 反思/task inference | watchdog/auto_defense/failure events | 任务级“继续/换参/换任务/停”规则 | 错误切换率、切换延迟、反思后成功率 |
| Cradle 记忆分层 | events/ledger/memory | procedural（技能契约）+ episodic（run 证据） | 记忆命中率；hallucinated skill 率 |
| Mindcraft profile/suite | mc-lab E2/scenario | 场景 profile + task suite + 结果表 | 同 profile 一致性、suite 通过率 |

## 4. 明确不搬的（防止“加工具/加复杂度”）

1. **不搬像素级键鼠控制**（Cradle）：MC 已有 mineflayer API；截图只作辅助证据。
2. **不搬在线 RL/视频预训练**（MineDojo/Plan4MC）：没有训练预算，且冻结期目标是验收机制。
3. **不搬任意代码生成技能库**（Voyager）：本地 27B 生成/修复代码不稳定，行动面失控；只搬“技能契约+验收”。
4. **不搬 4,000 任务 benchmark**（MineAnyBuild）：冻结期先做少量可判任务卡，规模 later。
5. **不新增 MC 工具/宏**：用户明确“一直在加工具”；本阶段只做契约、验收、回放、监控。
6. **不以模型自述/聊天播报作为验收**：local3 的 49+33 次重复 say 就是反例；验收只认事件/方块/物品/坐标/verify。

## 5. 研究结论与优先级（不含实现）

**P0（MC 恢复前必须）：**
- 写死验收指标与 gate（`E2-HARNESS §10`），按 **回放/分段** 跑，不做 24h 盲跑；
- 技能契约：至少 `shelter` 的“前置材料/结构验收/home”与 `collect` 的“资源枯竭 fallback”以 task result/failure code 固化；
- 失败驱动控制：needs-material/deficit、no-resources、auto_defense 取消任务、chat dedupe、重复动作熔断；
- local3 证据包 + 回放脚本/期望事件断言（只做离线 replay，不启服）。

**P1（恢复后第一轮）：**
- 技能 registry（注册表 + 版本 + 证据字段），按成功率/复用率评估；
- 蓝图 JSON 作为 `shelter/build` 一等产物，支持 checkpoint/回放；
- 任务 suite（3×3 小屋、夜宿、collect、威胁规避、记忆 recall）每场景有机器验收；
- 对话/任务/延迟的每段报告（不再是 24h 早报一次）。

**P2（稳定后）：**
- 离线任务选择器（前置条件驱动）、受限技能组合；
- 场景 profile 与多 bot 接口；
- 外部 benchmark 适配（MineAnyBuild/APT 任务卡）只做选择性对照。

## 6. 参考资料

- Voyager: Wang et al., *Voyager: An Open-Ended Embodied Agent with Large Language Models*, arXiv:2305.16291 — https://arxiv.org/abs/2305.16291 （项目页 https://voyager.minedojo.org/）
- MineAnyBuild: Wei et al., *MineAnyBuild: Benchmarking Spatial Planning for Open-world AI Agents*, arXiv:2505.20148（NeurIPS 2025 D&B） — https://arxiv.org/abs/2505.20148
- APT: Chen & Gao, *APT: Architectural Planning and Text-to-Blueprint Construction Using Large Language Models for Open-World Agents*, arXiv:2411.17255 — https://arxiv.org/abs/2411.17255 （代码 https://github.com/spearsheep/APT-Architectural-Planning-LLM-Agent）
- MineDojo: Fan et al., *MineDojo: Building Open-Ended Embodied Agents with Internet-Scale Knowledge*, arXiv:2206.08853 — https://arxiv.org/abs/2206.08853 （https://minedojo.org）
- Cradle: Tan et al., *Cradle: Empowering Foundation Agents Towards General Computer Control*, arXiv:2403.03186 — https://arxiv.org/abs/2403.03186 （https://baai-agents.github.io/Cradle/）
- Mindcraft: mindcraft-bots, *Mindcraft*（LLM + Mineflayer 多 agent 框架） — https://github.com/mindcraft-bots/mindcraft ；生态页 https://landscape.jimmysong.io/projects/mindcraft/
- Plan4MC / Skill RL & Planning: Yuan et al., arXiv:2303.16563 — https://arxiv.org/abs/2303.16563
- 本仓证据：[`MC-LOCAL3-FORENSICS.md`](MC-LOCAL3-FORENSICS.md)；mc-lab 冻结：[`MC-FREEZE-2026-11-06.md`](../../mc-lab/docs/MC-FREEZE-2026-11-06.md)
