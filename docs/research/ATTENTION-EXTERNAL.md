# 陪伴型 / 长期运行 Agent 的注意力与主动性：业界实现调研

> 任务：为 ICL 回答两个问题 —— (a) Agent 什么时候该自己决定"现在去做什么 / 说不说话"？(b) 这套决策怎么接到已有的 focus 租约 / backlog / pierce / time 节拍上？
>
> 调研方式：公开网页与论文（web_search / web_fetch）。**本报告只做研究与映射建议，不改代码。**

## 阅读约定

- **[事实]**：有明确出处，且我打开过该页面 / 读到论文摘要原文，内容可直接对上 URL。
- **[推断]**：我从多条事实推出来的判断，不是任何一家产品的公开说法。
- **[未核实]**：找到线索但没能打开一手页面，或该产品没有公开文档。**不要当结论用。**
- 数值（默认值、上限、阈值）都注明是"产品默认值/调参值"还是"研究结论"。**二者不等价**：绝大多数陪伴产品的数字是产品调参，不是实验结论。

---

## 0. 两句话结论（先回答 a / b）

**（a）什么时候该自决？** 业界的共同答案是：**只在"外部事实"触发时自决，不在"我想说话"时自决。** 合法的触发只有三类：
1. **到期承诺**（我答应过 X 点前做什么 / 定时任务到点）—— Letta `cron`/`Wake`、ChatGPT Tasks、Temporal timer 都属于这一类；
2. **外部可验证的状态变化**（清单里有未完成项、任务失败、未读积压超过阈值）—— Anthropic 长期 agent harness 的"读 progress + feature list，选最高优先级未完成项"是这一类；
3. **情境窗口 + 有料可说**（用户长时间安静 + 存在未读/未回的事 + 处于早上/睡前/饭后这类窗口）—— Marinara Engine 的 check-in 设计是这一类。

三类都不成立时，正确输出是**显式 no-op（什么都不做）**，而且 no-op 应该是"一等结果"，不是失败。

**（b）怎么接 focus/backlog/pierce？** 一句话：**自产主动性只能是"候选信号"（ICL 的 `wake.mjs` 已经是正确形状），不许自己当投递闸门；focus 是它的抑制器，backlog 是它的原料兼闸门，time 是唯一时钟。**
具体地：自产信号在 `interruptible:false` / sleep / pause 时**降级进 backlog，绝不用 pierce 穿透**——pierce 留给外部真实事件（@、alarm）。理由见 §5.3：主动消息穿透自己设的勿扰，是这个系统最贵的一次信任损失。

---

## 1. 机制清单（触发来源 → 决策 → 执行 → 抑制）

### 1.1 总表

| # | 机制 / 产品 | 触发来源 | 决策 | 执行 | 抑制 | 出处 |
|---|---|---|---|---|---|---|
| 1 | Generative Agents 反思-计划循环 | 时间步推进 + 新观察 | 检索记忆 → 是否触发反思 → 重排计划 | 计划分解为具体行动（移动/对话） | 已有计划未失效就不重排；反思按重要性累积触发 | [arXiv:2304.03442](https://arxiv.org/abs/2304.03442) |
| 2 | MemGPT / Letta interrupt | 用户消息、系统消息、agent 自己请求继续 | 让出/取回控制权 | 继续推理步骤 | 没有新输入就 yield | [arXiv:2310.08560](https://arxiv.org/abs/2310.08560) |
| 3 | Letta sleep-time agent | 后台可配置频率 | 后台 agent 决定改哪些 memory block | 异步改写主 agent 的 core memory | 主 agent 没有改 core memory 的工具；anytime 写 | [Letta blog](https://www.letta.com/blog/sleep-time-compute/) / [arXiv:2504.13171](https://arxiv.org/abs/2504.13171) |
| 4 | Letta `cron` / `Wake`（自排程） | 时间（`--every` / `--at` / `--cron`） | 任务表匹配到点 → 给 agent 发一条 prompt | 在指定会话（self / new / 指定 id）跑一轮 | 最小粒度 1 分钟；local runner 不在线 → 记 missed；一次性任务 24h 回收 | [scheduling-tasks SKILL](https://github.com/letta-ai/letta-code/blob/5e45ebb6a36c138cd5efba3c13570d9a8c1bf1b7/src/skills/builtin/scheduling-tasks/SKILL.md) |
| 5 | Letta `Wake` 工具（会话内自排程） | agent 自己设定"过多久再回来" | 自绑定当前会话 | 到点投递 follow-up prompt | 只管当前会话；跨会话/跨机器走 `cron` | [letta-code PR #4704](https://github.com/letta-ai/letta-code/pull/4704) |
| 6 | ChatGPT Tasks | **用户**设定时间/周期 | 到点执行 | 推送结果 | 用户可改可删；主动权在用户 | [help.openai.com 10291617](https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt) |
| 7 | ChatGPT Pulse | **每日一次**（morning） | 汇总 chats + 已连接应用（email/calendar）→ 挑主题 | 一条摘要式 briefing | 每天一次、摘要不是逐条、用户可调关注主题 | [openai.com Pulse](https://openai.com/index/introducing-chatgpt-pulse/) / [CNET](https://www.cnet.com/tech/services-and-software/chatgpt-pulse-gets-you-personalized-morning-briefings-based-on-your-chat-email-and-calendar-data/) |
| 8 | AutoGPT / BabyAGI 式循环 | 上一轮产出 | 任务创建 → 重排优先级 | 继续执行队列里的下一个任务 | 只有"队列看起来空"；没有内建停止条件 | [AutoGPT](https://github.com/Significant-Gravitas/AutoGPT) / [BabyAGI](https://github.com/yoheinakajima/babyagi) / [Anthropic](https://www.anthropic.com/research/building-effective-agents) |
| 9 | Anthropic 长期 agent harness | **新会话开始**（离散 session） | 读 `git log` + `claude-progress.txt` + `feature_list.json` → 选最高优先级未完成项 | 一次只做一个 feature，做完 commit + 写 progress | feature list 的 `passes` 字段是唯一完成判据；"不许删测试"写进 prompt | [Anthropic: Effective harnesses](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents) |
| 10 | LangGraph `interrupt` | 图内节点判断"这里需要人" | 挂起 + checkpoint 落盘 | 等人 resume 并带值继续 | 只能由 resume 继续；不能自己绕过 | [LangChain blog](https://www.langchain.com/blog/making-it-easier-to-build-human-in-the-loop-agents-with-interrupt) / [HumanInterrupt](https://reference.langchain.com/javascript/langchain-langgraph/prebuilt/HumanInterrupt) |
| 11 | Discord 服务器默认通知 | 消息到达 | 平台默认：**只有 @ 才提醒**（`default_message_notifications`） | 推送 | 服务器/用户可改；默认是最不容易打扰的那一档 | [Discord Guild 文档](https://discord.com/developers/docs/resources/guild) |
| 12 | Marinara Engine 主动 check-in | 安静时长 + 日程状态 + 情境窗口 | 是否到 check-in 时机 + 是否还有当日额度 | 角色先发消息 | Offline 永不先发 / Busy 等待×3 / 每日上限 / 最多 3 次 / 用户回复即重置 | [marinara schedules.md](https://github.com/pasta-devs/marinara-engine/blob/fc0333c3fe978cda5e0b919bd6faec985901704e/docs/conversation/schedules.md) |
| 13 | SillyTavern / EchoText 主动消息 | 客户端或服务端定时器 | 到点 → 生成 or 排队 | 角色主动消息 | 浏览器后台定时器被节流 → 需 server plugin；"Default/Connection Profile"源会排队到你回来才生成 | [EchoText-Proactive](https://github.com/mattjaybe/SillyTavern-EchoText-Proactive) |
| 14 | ChatScheduledSender（酒馆插件） | 一次性 / 每日 / 倒计时 | 到点发送 | 可指定发送身份、是否附提示词 | 纯定时，无情境判断 | [ChatScheduledSender](https://github.com/ReallySilverBell/ChatScheduledSender) |
| 15 | 星野（国内） | 长时间未互动 | 主动发起 | 推送 / 甚至**打电话** | 用户可开关；用户会专门找"怎么关" | [百度经验：如何开启](https://jingyan.baidu.com/article/ff42efa98e7a2d809e2202b2.html) / [3DM：如何关闭](https://shouyou.3dmgame.com/gl/589637.html) / [用户帖：突然来电](https://www.xiaohongshu.com/discovery/item/67c97ea900000000290146b0) |
| 16 | ProactiveAgent 的 reward model（评估机制） | 真实人类活动事件流 | 判定"此刻该不该主动"（accept / reject） | — | 被人工标为 reject 的样本当负例 | [arXiv:2410.12361](https://arxiv.org/abs/2410.12361) |

### 1.2 逐条展开（只展开对 ICL 决策有意义的）

**① Generative Agents（Smallville）的"反思-计划"循环** [事实]
25 个 agent 在沙盒里生活：观察 → 记忆流 → 检索（recency / importance / relevance）→ 反思（把记忆综合成更高层判断）→ 计划 → 行动；论文用消融实验说明 observation / planning / reflection 三者**各自都是"可信行为"的必要条件**；涌现结果（一个人想办情人节派对，两天内邀请扩散、陌生人变约会对象、最后一起到场）是这套循环最著名的证据。
实现细节：一天的计划先出成 5–8 个粗块，再递归拆细；反思不是定时跑的，而是**重要性累积到阈值才触发**（[规划递归拆解](https://github.com/curiositech/windags-skills/blob/main/skills/park-2023-generative-agents/references/planning-as-recursive-decomposition.md)；阈值常被复述为 150，见二手实现 [OneAI 文档](https://github.com/Marssssss/OneAI/blob/f79fdbea204dc61df2fa13811a28efde1709ab26/docs/memory-mechanism_EN.md)，**原文页码我未逐字核对，此数字按 [未核实] 处理**）。

**②③ MemGPT / Letta：interrupt + sleep-time** [事实]
MemGPT 摘要原文写的是"utilizes **interrupts** to manage control flow between itself and the user"——控制权是显式交接的，不是自由循环。
Letta 的 sleep-time 更贴近 ICL 的"睡眠"：**创建两个 agent**，主 agent 说话，sleep-time agent 在后台改主 agent 的 core memory；主 agent 干脆**没有**改 core memory 的工具（权限分离）。可配置频率，官方明说"频率越高 token 花得越多"；sleep-time agent 可以用更慢更强的模型，因为不受延迟约束。

**④⑤ Letta cron / Wake：agent 给自己排班** [事实]
- `letta cron add --prompt` 的 prompt 是**到点后发给 agent 自己的消息**，文档明确要求"写成一个将来的你也能看懂的消息"（好例子："The user asked to be reminded to review the PR for the auth refactor. Check if it's still open and nudge them."）。
- 分本地 runner 和 Cloud：**本地排程只在有 Letta 会话运行时才触发，错过会标记 missed**；Cloud 排程无论如何都触发。→ 这条直接对应 ICL 的"进程不在线时的时钟所有权"问题。
- 最小粒度 1 分钟；一次性本地任务触发后 24h 回收。
- 会话内轻量场景用 `Wake`（自绑定当前会话），跨会话/跨机器才用 `cron`。

**⑧ AutoGPT / BabyAGI 的教训** [事实 + 推断]
BabyAGI 的骨架是"任务创建 agent → 优先级 agent → 执行 agent"围着任务队列转；AutoGPT 是"目标 → 思考 → 命令 → 观察"的自主循环。两者都是**目标函数里只有"继续做"，没有"停"**的循环。
[事实] Anthropic 在 *Building effective agents* 里对自主 agent 的判断是：适用于开放式问题，但要"maintain control"、要设**停止条件（例如最大迭代次数）**，并提醒 agent 会带来复合错误与成本。
[推断] 所以"没活硬整"不是模型坏，是**架构缺一个合法的"什么都不做"的出口**。AutoGPT/BabyAGI 式循环把"每 tick 必须产出"写进了骨架，于是它只能编任务。

**⑨ Anthropic 长期 agent harness —— 本报告认为最可迁移的一条** [事实]
问题定义：长任务 agent 必须**分多个离散会话**工作，而每个新会话**不记得**上一个会话做过什么（"像换班的工程师，接班的人没有上一班的记忆"）。
观察到的两个失败模式（原文）：
1. **想一次做完**（one-shot）→ 上下文在实现中途耗尽 → 下一个会话面对半成品，只能猜；
2. **后来的 agent 看一眼，觉得"进展不错"，直接宣布完工**（premature done）。

解法（原文）：
- **initializer agent**：第一个会话专门搭环境——写 `feature_list.json`（claude.ai 克隆例子里有 200+ 条，全部 `passes: false`）、`claude-progress.txt`、`init.sh`、首个 git commit；
- **coding agent**：每个会话开场先"找方向"——`pwd` → 读 git log / progress 文件 → 读 feature list → **选最高优先级的未完成项** → 一次只做一个 feature → 结束时留下干净状态 + commit + 写 progress；
- 完成判定只认 feature list 的 `passes` 字段；用 JSON 而不是 Markdown，因为模型更不容易乱改 JSON；配"删/改测试是不可接受的"这类强措辞。
- 用浏览器自动化做端到端测试，而不是只看单测过没过。

**⑪ Discord 的 mention gating** [事实]
服务器对象上 `default_message_notifications`：0 = 所有消息都通知，1 = **只 @ 提及才通知**。默认档是最安静的那一档。这是"平台替用户做了注意力预算"的典型。

**⑫ Marinara Engine —— 目前找到的最完整的"陪伴产品主动消息"参考设计** [事实]
（开源项目，SillyTavern 生态的替代前端；注意：这是**社区产品**，不是大厂，其数值是产品默认值）
- 默认：你安静 **120 分钟**后角色才可以 check-in（可调 15–360）；
- **check-in moments 是"情境窗口"而不是固定钟点**：Morning / Goodnight / Meal breaks / After busy / Long absence；
- 每日上限由 **talkativeness** 决定：≥80 → 8 次；60–79 → 6；40–59 → 5；20–39 → 3；<20 → 2；另有角色级 Daily safety limit，**两者取更低**；
- **Offline 状态永不先发**；**Busy 状态等待时间 ×3**；Away 状态回复延迟 +1–3 分钟随机；
- **follow-up 升级**：最多再追 2 次（共 3 次），第一次在基础等待的 2 倍后，第二次在 4 倍后；**用户一回复就重置**；
- 多角色同时"想说话"：talkativeness 最高 + timing 最好者先发，Online 优先；
- **群聊共享一个每日上限与一个节奏**；长时间缺席后**只有一个角色** check-in；
- 角色有周计划（Online / Away / Busy / Offline 区块），也可以被 `/status` 或**角色自己**改临时状态（最长 7 天），但**永久计划永不改**。

**⑬ EchoText 的工程教训** [事实]
浏览器会**节流后台标签页的定时器**，所以纯前端的 proactive scheduler 一旦最小化就不可靠 → 需要 server plugin 在服务端 tick（README 打印 "Scheduler started (tick every 60s)"）。并且 README 写清两种投递语义：Ollama/OpenAI 源可以**服务端直接生成**（你不在也送达）；Default / Connection Profile 源则是**排队触发，等你回到标签页再生成**。
[推断] 这个二分和 ICL 的 `pierce`（现在就到）/`backlog`（回来再说）是同一个东西，只是它发生在"生成"层而不是"投递"层。

**⑮ 星野：国内产品的主动强度是反面教材** [事实（二手报道）]
- 有"智能体主动发消息"开关：百度经验在教**怎么开**，3DM 在教**怎么关**；
- 有用户帖记录"很久没聊的星野 AI 突然给我打电话了"。
→ 国内陪伴产品把主动做到**电话/强推送**级别，用户的第一反应是找关闭开关。这不是"更主动更好"，是"打扰成本被转嫁给用户"。

### 1.3 顺带核实的几件事（避免编造）

| 说法 | 结论 |
|---|---|
| Replika 有主动消息 + 可配置通知 | [事实] 帮助中心有独立文章讲通知设置（[链接](https://help.replika.com/hc/en-us/articles/360027515872-How-do-I-set-up-my-app-s-notifications)）；**具体主动频率/上限未见官方文档 → [未核实]** |
| Character.AI 角色会主动发起对话 | [未核实] 只找到社区教程教"如何让角色主动发起话题"（[php.cn](https://www.php.cn/faq/2797191.html)），未见官方机制说明；推断其原生主动性弱于 Replika/星野 |
| Pi（Inflection）的主动 check-in | [未核实] 没找到官方文档，本报告不下结论 |
| Claude 侧有"定时唤醒主动发消息" | [未核实] 没找到官方文档。Anthropic 公开材料集中在**会话内**的长任务连续性（harness），不是"主动打扰用户"。**不要把 harness 当成 proactive messaging 的同义词** |

---

## 2. 三种典型架构对比

| 维度 | 事件驱动 | 定时心跳 | 反思-计划循环 |
|---|---|---|---|
| 触发来源 | 外部事件（消息、告警、webhook） | 时钟 tick / 到点任务 | 重要性累积、状态漂移、"想到一个点子" |
| 决策内容 | 这条事件该不该进来、以什么强度进来 | "现在有没有到点的事"（检查清单） | 反思 → 重计划 → 下一个行动 |
| 执行 | 投递 / 中断 / 入队 | 跑一轮 prompt，或什么都不做 | 自主行动序列 |
| 无输入时的行为 | **完全静止**（这是优点也是缺点） | 空转（必须显式定义 no-op） | 容易自嗨 / 编任务 |
| 成本 | 低（随事件量线性） | 可控（频率 × 单次成本） | 高且不可预测 |
| 可解释性 | 高（有事件就有原因） | 高（有日程就有原因） | 低（"它为什么现在想做这个"很难答） |
| 典型代表 | ICL signals/delivery、Discord/Slack webhook、LangGraph interrupt | Letta cron、ChatGPT Tasks、Temporal timers、EchoText server scheduler、ICL time 清醒节拍 | Generative Agents、BabyAGI、AutoGPT |
| **适用条件** | 有明确的外部事件源；要求低延迟；要求"没消息时绝对安静" | 有明确的到期承诺；需要可预算、可审计；需要"至少定期看一眼" | 有明确的世界状态与可验证清单；或纯角色扮演（允许无外部产出） |
| **不适用** | 长任务续推（没人发消息就永远不推进） | "看了但没事"被误当成"该做事"就会空转 | 陪伴产品直接向用户投递（没有外部锚点 → 假目标 → 打扰） |

**组合才是答案（[推断]，但有业界支撑）**：
- Anthropic 的 harness = **事件驱动（会话启动）+ 清单驱动的决策**，不是自由循环；
- Letta = **定时器（cron/Wake）+ 事件（interrupt）+ 后台低频整理（sleep-time）** 三层，各管一段；
- ICL 现在的形状其实已经接近正确：**time 是时钟，signals 是事件，wake 是候选生成器**。缺的不是架构，是"决定 no-op 的规则"和"自产信号与 focus 的关系"。

---

## 3. 防打扰与预算设计

### 3.1 频率

| 做法 | 出处 | 数值性质 |
|---|---|---|
| 每日上限按"话痨程度"分档：2 / 3 / 5 / 6 / 8 次/天 | Marinara | 产品默认值 |
| 每日上限与角色级安全上限**取更低者** | Marinara | 产品规则 |
| 每天**一次**、摘要式、可调主题 | ChatGPT Pulse | 产品设计 |
| 小时预算 12 次、nudge 每小时 6 次（ICL 现状） | ICL `wake.mjs` | 产品默认值 |
| sleep-time 频率越高 token 越多 | Letta | 官方说明的成本关系 |

[推断] **陪伴场景按"天"预算比按"小时"预算更合适**：小时预算允许"今天密集打扰 12 次"，而人对陪伴的容忍是"一天几次"。ICL 可以考虑在 `maxWakePerHour` 之外加 `maxWakePerDay`，并且**自产信号和外部事件用不同预算**（外部 @ 不该吃掉"我想说话"的额度，反之亦然）。

### 3.2 冷却与递增

- **升级式 follow-up**：Marinara 最多 3 次，间隔为基础等待的 2×、4×；用户一回复就重置。这比"固定每 10 分钟提醒一次"更像人。
- **冷却**：ICL 现有 nudge 冷却 10 分钟、proactive 冷却 30 分钟；Marinara 用"未读数变化或冷却到期才再提醒"——**变化驱动**比**时间驱动**更不容易变成噪音。
- [推断] 冷却应该**按 activity 分桶**，不是全局：全局冷却会让"一个群很吵"把"另一个人的一句重要话"也压掉。

### 3.3 静默期与情境窗口

- **状态化静默**：Offline = 永不先发；Busy = 等待 ×3；DND 存在时角色保持沉默（Marinara）。ICL 对应 `sleep` / `paused` / `interruptible:false`。
- **情境窗口优于固定钟点**：Marinara 的 Morning / Goodnight / Meal breaks / After busy / Long absence。ICL 有真实时钟（time），可以直接把"窗口"定义在 time 的 phase 上。
- **不要用概率代替窗口**：ICL `proactiveProbability: 0.3` 这类随机命中，用户无法归因（"它为什么突然说话"），也不可复现、不可评估。[推断] 概率只适合"同一天有多个等价时机时挑一个"，不该作为"要不要说话"的主判据。

### 3.4 用户反馈闭环

| 机制 | 出处 | 说明 |
|---|---|---|
| 显式开关 | 星野 / Replika / EchoText 的 Proactive Messaging | 用户能找到、能关掉（星野的关闭教程本身就是证据） |
| `mark_read` 推进水位 → nudge 停止 | ICL `qq_mark_read` | 已实现：反馈直接改变触发条件 |
| 用户回复即重置计数 | Marinara | 最自然的"正向反馈" |
| 被忽略/被关闭应降频 | [推断] | 业界未见公开的"负反馈自动降频"文档；但这是最该做的一环 |
| 提醒正文不伪装成用户消息 | ICL wake（"[QQ主动检查]…这不是对方发来的消息"）+ EchoText | 防"模型把提醒当新消息"的低级错误 |

### 3.5 优先级 / 预算的隔离

- ICL 已有 `priority: alarm/normal/notice` + `pierce` + quota：alarm 穿透不占普通预算，这是对的。
- [推断] **自产主动性应该有自己的预算池**，且**永远不享受 alarm 级穿透**。否则"我想说话"会以"提醒"的名义无限接近"外部急事"的权限。

---

## 4. 评估：主动行为怎么算好

**有出处的做法**
- **ProactiveAgent / ProactiveBench**（[arXiv:2410.12361](https://arxiv.org/abs/2410.12361)）[事实]：收集真实人类活动 → 让模型预测"此刻该主动做什么" → **人工标注 accept / reject** → 用这些标签训一个 reward model 当自动评估器 → 数据集 6,790 条事件 → 微调后主动提供协助的 **F1 = 66.47%**，高于所有开源/闭源基线。
  → 关键启示：**"该不该主动"被当成一个二分类问题来做，于是 false positive 是可测的**。而且 66.47% 这个数说明"该不该主动"本身很难——不要假设模型天然会判断。
- **sleep-time compute**（[arXiv:2504.13171](https://arxiv.org/abs/2504.13171)）[事实]：把算力从"用户等待的 test-time"挪到"空闲 sleep-time"，在相同准确率下把 test-time 算力需求降约 5×，并可把准确率再提 13%（GSM）/18%（AIME）；**"用户查询的可预测性"与该方法的收益强相关**。
  → 启示：后台思考只在"能猜到你接下来要什么"时值钱；猜不中就只是烧钱。
- **打断的成本**（Mark, Gudith & Klocke, CHI 2008，[DOI 10.1145/1357054.1357072](https://dlnext.acm.org/doi/abs/10.1145/1357054.1357072)）[事实]：被中断的工作者会用更快的速度补偿，但压力、挫折感、时间压力、努力程度都更高。
- **Mixed-initiative**（Horvitz, CHI 1999，[dblp 记录](https://dblp.org/rec/conf/chi/Horvitz99.html)）[事实/经典]：agent 主动性的正当性来自"这次打断的价值 > 成本"的估算，以及"用户能低成本纠正它"。
- **Pulse 的产品形态**本身就是一个评估结论：**摘要式、低频、可调主题**是被大厂选中的主动形态。

**建议 ICL 采用的指标（[推断]，不是业界标准）**

| 指标 | 定义 | 为什么 |
|---|---|---|
| 打扰率 | 自产主动消息数 / 活跃小时（或 / 天） | 最直观的成本 |
| 回应率 | 主动消息后 N 分钟内用户有回应的比例 | 价值侧 |
| 负反馈率 | 被静音/关闭开关/明确说"别吵"/删除会话的比例 | 最贵的信号，权重要高 |
| false-positive initiative rate | 被忽略或负反馈的主动次数 / 总主动次数 | 对应 ProactiveBench 的 reject 率 |
| 承诺履约率 | 到期承诺（cron/答应的事）按时完成的比例 | 这是主动性最该保证的部分 |
| **no-op 率** | tick 中"明确决定不做"的比例，**作为健康指标** | 见 §5.3：no-op 率过低 = 在空转 |
| 恢复延迟 | 用户长时间静默后，第一次合理主动的时延 | 太早=打扰，太晚=没存在感 |

[推断] 评估的难点不在指标，在**没有 ground truth**：ProactiveBench 用人工标注解决，ICL 可以用"回放 + 人工抽检"起步（仓库里已有 `memory-replay` 之类的基础设施可复用），先标 200–500 条"这个时机该不该说话"，比讨论架构更有用。

---

## 5. 对 ICL 的启示

### 5.1 哪些能直接映射（focus 租约 / backlog / pierce / time）

| 业界机制 | ICL 现有对应物 | 映射建议（推断） |
|---|---|---|
| Letta `cron` / `Wake`：到点给 agent 发 prompt | `time` 的 schedule/timer + `wake.mjs` 的 replyCheck | **已有 80%**。补两点：①自产提醒的 prompt 要"写给未来的自己看"（带上下文与意图），②本地时钟的所有权要说清（进程不在线 = missed，要记账） |
| Anthropic：新会话开场固定例程（读 progress → 读清单 → 选最高优先级未完成项） | `focus_status` + `focus_backlog` + `time` 的 goal | **最该抄的一条**：把"醒来第一件事"固化成例程，最后一格是"若无事 → 明确 no-op" |
| Anthropic：`feature_list.json` 的 `passes` 作为唯一完成判据 | `time` 的 goal | 给 goal 加**外部可验证的完成条件**（`exitCondition` 已有字段），禁止 agent 自评"差不多了" |
| Marinara：安静 120 分钟 + 情境窗口才可 check-in | `wake` 的 `proactiveIdleMs=15min` | 15 分钟太短了（产品默认值对比：Marinara 120 分钟）。**长静默后的第一次主动，间隔应该按小时甚至按天算** |
| Marinara：Offline 永不先发 / Busy ×3 | `time` 的 sleep/paused + `focus.interruptible=false` | 直接映射：**sleep 期间自产信号只进队列**（ICL 已有此语义，要确保自产信号也走这条路） |
| Marinara：每日上限 2–8，取更低者 | `maxWakePerHour=12`、`nudgeMaxPerHour=6` | 加 `maxWakePerDay`，并按"自产 vs 外部"分池 |
| Marinara：升级式 follow-up（2×/4×，最多 3 次，回复即重置） | nudge 冷却 10 分钟 | **直接可抄**：把"固定冷却"换成"递增间隔 + 用户回复重置"，更像人、更少噪音 |
| Marinara：群聊共享上限、只让一个角色 check-in | 多 activity backlog | 多会话/多群场景下**先合并再发言**：一次只代表一个 activity 说话，且共享当日额度 |
| Discord：默认只 @ 才通知 | `pierce:mention` 默认级别 | 已一致。**保持"默认安静"是产品立场，不是技术妥协** |
| LangGraph `interrupt`：挂起等人 | focus 的 defer/backlog | 已有。差别：LangGraph 的挂起是**可恢复的显式状态**；ICL 的 backlog 也该保证"挂起不丢、恢复有摘要"（已实现） |
| ProactiveAgent 的 accept/reject 标注 | 无 | 加一个**"这次主动值不值"的人工抽检**流程 |

### 5.2 接口草案（[推断]，仅供设计讨论，不是业界事实）

```
wake 只产出候选，不投递：
  { kind: 'promise-due' | 'checkin-window' | 'backlog-nudge' | 'reply-check',
    activity, reason, dueAt, evidence,   // evidence 必填：为什么是"现在"
    confidence }                          // 允许"不确定"，让下游降级

决策顺序（建议由 time/focus 现有闸门承担，不新增闸门）：
  1. 有 focus 且 interruptible=false → 自产信号一律进 backlog（不进 pierce）
  2. sleep / paused → 到期承诺进队列，checkin/backlog-nudge 直接抑制
  3. 检查预算（日预算 + per-activity 冷却 + 递增间隔）
  4. 检查情境窗口（time 的 phase 决定允许哪几类）
  5. 仍满足 → 生成 signal；否则 → 记一条 no-op（带 reason，可审计）

no-op 必须是一等结果：
  tick 的合法输出包括 { decision: 'no-op', reason: 'no-commitment' }
  no-op 率进指标，不作为失败告警
```

### 5.3 哪些不该学

1. **AutoGPT / BabyAGI 的"每 tick 必须产出任务"**。没有"什么都不做"出口的循环必然空转、烧钱、编假任务。ICL 现在的 `proactive` 默认关闭是对的，不要为了"感觉更主动"把它打开。
2. **用概率当主判据**（`proactiveProbability`）。随机命中不可归因、不可复现、不可评估。概率只能用于"多个等价时机里挑一个"。
3. **让自产主动性走 pierce**。pierce 的语义是"外部真的有急事"，一旦"我想说话"也能穿透 `interruptible:false`，用户设的勿扰就失效了——**这是整个注意力系统最贵的一次信任损失**，比漏一次主动消息贵得多。
4. **星野式的电话/强推送级主动**。国内产品的打扰强度是反面教材：用户第一反应是找关闭开关。
5. **把 reflection 当"想说话"的借口**。Smallville 的反思是为了更新记忆和计划，不是为了发消息；Letta 的 sleep-time 也是为了改写记忆，不是为了打扰人。后台思考的产物应该是"更好的决定"，不是"更多的话"。
6. **让 agent 自己宣布"做完了"**。Anthropic 明确记录了这个失败模式（后来的 agent 看一眼就宣布完工）。完成判定必须对照外部清单。
7. **把"每分钟都检查一遍"当勤奋**。EchoText 的教训是反过来的：**定时器要可靠，不是要密集**。tick 密集只增加空转成本。

### 5.4 风险与未解问题

- [未核实] 业界**没有**公开的"打扰预算"最优值或"主动性"的通用评价标准；所有数字都是产品调参。ICL 的数值应该靠回放 + 人工抽检自己标定，不能照抄。
- [推断] 最大风险不是"不主动"，而是**"第一次真实启用主动"就出事**：一次在错误时机（用户在睡觉/忙碌）的打扰，可能让用户永久关掉这个能力。建议第一次启用时把额度设得极低（比如每天 1 次、只在明确窗口、只在有到期承诺时），先跑两周看回应率。
- [推断] 第二个风险是**自产信号与外部事件的归因混淆**：用户看到"提醒"，不知道是"她真的记得"还是"定时器响了"。所以正文里必须像 ICL 现在做的那样，明确写清是哪种提醒。
- 未解：群聊里"多个 activity 都想说话"时的公平性（Marinara 用共享额度 + 先到先得，但是否会让某个群永远抢不到？）；长时间静默后的"重新出现"应该多主动才算不惊扰（Marinara 用 1 次，但缺乏研究支撑）。

---

## 6. 参考链接

### 论文 / 研究

1. Generative Agents: Interactive Simulacra of Human Behavior — https://arxiv.org/abs/2304.03442
2. MemGPT: Towards LLMs as Operating Systems — https://arxiv.org/abs/2310.08560
3. Sleep-time Compute: Beyond Inference Scaling at Test-time — https://arxiv.org/abs/2504.13171
4. Proactive Agent: Shifting LLM Agents from Reactive Responses to Active Assistance（ProactiveBench） — https://arxiv.org/abs/2410.12361
5. Behavior Trees in Robotics and AI: An Introduction（背景参考：任务切换结构） — https://arxiv.org/abs/1709.00084
6. The cost of interrupted work: more speed and stress（Mark, Gudith & Klocke, CHI 2008） — https://dlnext.acm.org/doi/abs/10.1145/1357054.1357072
7. Principles of mixed-initiative user interfaces（Horvitz, CHI 1999） — https://dblp.org/rec/conf/chi/Horvitz99.html
8. 三状态与计划：F.E.A.R. 的 GOAP（Orkin, GDC 2006，背景参考：目标选择 + 重规划） — https://alumni.media.mit.edu/~jorkin/gdc2006_orkin_jeff_fear.pdf

### 官方文档 / 工程博客

9. Anthropic — Effective harnesses for long-running agents — https://www.anthropic.com/research/effective-harnesses-for-long-running-agents
10. Anthropic — Building effective agents — https://www.anthropic.com/research/building-effective-agents
11. Letta — Sleep-time Compute（含 MemGPT 2.0 / sleep-time agent 配置） — https://www.letta.com/blog/sleep-time-compute/
12. Letta — MemGPT 概念文档 — https://docs.letta.com/concepts/memgpt/
13. Letta Code — scheduling-tasks SKILL（`letta cron` 用法、本地 vs Cloud runner、missed 语义） — https://github.com/letta-ai/letta-code/blob/5e45ebb6a36c138cd5efba3c13570d9a8c1bf1b7/src/skills/builtin/scheduling-tasks/SKILL.md
14. Letta Code — PR #4704「feat(tools): add Wake for timed follow-ups」 — https://github.com/letta-ai/letta-code/pull/4704
15. OpenAI — Scheduled tasks in ChatGPT — https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt
16. OpenAI — Introducing ChatGPT Pulse — https://openai.com/index/introducing-chatgpt-pulse/
17. CNET — ChatGPT Pulse Gets You Personalized Morning Briefings Based on Your Chat, Email and Calendar Data — https://www.cnet.com/tech/services-and-software/chatgpt-pulse-gets-you-personalized-morning-briefings-based-on-your-chat-email-and-calendar-data/
18. LangChain — Making it easier to build human-in-the-loop agents with interrupt — https://www.langchain.com/blog/making-it-easier-to-build-human-in-the-loop-agents-with-interrupt
19. LangGraph — HumanInterrupt 参考 — https://reference.langchain.com/javascript/langchain-langgraph/prebuilt/HumanInterrupt
20. Discord Developer Docs — Guild Object（`default_message_notifications`） — https://discord.com/developers/docs/resources/guild
21. Temporal — What is durable execution — https://temporal.io/blog/what-is-durable-execution
22. Timers, Timeouts, and the Art of Waiting in Temporal（第三方，讲 timer 语义） — https://temporal.click/blog/timers-timeouts-and-the-art-of-waiting-in-temporal
23. AWS — SQS short and long polling（轮询的延迟/成本权衡，背景参考） — https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-short-and-long-polling.html

### 产品 / 开源实现

24. Replika Help Center — How do I set up my app's notifications? — https://help.replika.com/hc/en-us/articles/360027515872-How-do-I-set-up-my-app-s-notifications
25. SillyTavern EchoText 的 proactive 服务端调度插件 — https://github.com/mattjaybe/SillyTavern-EchoText-Proactive
26. SillyTavern 定时发送插件 ChatScheduledSender — https://github.com/ReallySilverBell/ChatScheduledSender
27. Marinara Engine — Character Schedules and Autonomous Messaging（check-in 上限、情境窗口、follow-up、presence 规则） — https://github.com/pasta-devs/marinara-engine/blob/fc0333c3fe978cda5e0b919bd6faec985901704e/docs/conversation/schedules.md
28. AutoGPT — https://github.com/Significant-Gravitas/AutoGPT
29. BabyAGI — https://github.com/yoheinakajima/babyagi

### 国内产品（二手 / 用户帖，均标 [未核实]）

30. 百度经验 —《星野》如何开启智能体主动发消息 — https://jingyan.baidu.com/article/ff42efa98e7a2d809e2202b2.html
31. 3DM — 星野智能体主动发消息关闭设置 — https://shouyou.3dmgame.com/gl/589637.html
32. 小红书用户帖 — 很久没聊的星野 AI 突然给我打电话了 — https://www.xiaohongshu.com/discovery/item/67c97ea900000000290146b0
33. php.cn — Character AI 如何让角色主动发起话题（社区教程） — https://www.php.cn/faq/2797191.html

### 仓库内对照（非外部来源，用于 §5 的映射）

- `docs/FOCUS.md`（focus 租约、pierce、backlog、nudge 未做项）
- `docs/DELIVERY-POLICY-DESIGN.md`（两通道、9 条 reason、alarm 穿透、预算）
- `docs/QQ.md` §7.9（唤醒矩阵 replyCheck / proactive / nudge 与预算）
- `docs/TIME.md`（sleep/paused/awake 节拍、goal、清醒节拍）
- `packages/plugins/qq/src/wake.mjs`（当前主动机会的默认参数与去重/冷却实现）

---

### 一句话给设计者

**业界没有一家把"主动性"做成"更频繁地自主行动"，成熟的做法都是"把主动性收窄成三类可审计的触发（承诺到期 / 清单未完成 / 情境窗口 + 有料），其余时间明确什么都不做"。** ICL 不缺机制，缺的是这条收窄规则，以及"自产信号永不 pierce"这条边界。
