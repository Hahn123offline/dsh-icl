# 注意力与主动性：现状、外部研究、最小设计（2026-11-14）

> 读者：决定 ICL「注意力下一阶段做什么」的人。
> 背景：用户提出——已有注意力原型在跑、被动测试逻辑正确，但**从未在真实场景启用**；
> 要回答两个问题：**（a）什么时候决定自己要干什么？（b）现有 focus 系统怎么接？**
> 范围还包括「主动性」。
>
> 证据来源：
> - 本仓库代码与文档（`packages/plugins/{focus,time,qq,note,world-state}`、`packages/core/src/{services,host,signals}.mjs`）
> - 本机旧实现：`C:\DSH\qwenstuff\focus-core`（旧 ICL）、`C:\DSH\qwenstuff\dsh-qq`（旧 QQ 桥）
> - 外部调研：`.state/lab/lead/attention-research/external.md`（33 个链接，逐条标 [事实]/[推断]/[未核实]）
> - 本机盘点：`.state/lab/lead/attention-research/local-scout.md`（299 行，文件:行 级出处）
> - 线上实测：`~/.dsh/icl/state/{time.json,focus.json,qq/status.json,session-events.jsonl}`，分析脚本
>   `.state/lab/lead/attention-research/analyze-heartbeat.mjs`

---

## 0. 结论先行

1. **机制已经齐了，缺的是「决策」**。筛选（`focus.admit`）、聚焦（focus 租约）、发起（time heartbeat）、
   收束（sleep/goal/focus_leave）都在；但没有一个地方规定「这次醒来要判断什么、允许做什么、
   什么都不做怎么算」。心跳现在只是**状态广播**，不是**决策 tick**。
2. **focus 在真实对话里从未启用**。`session-events.jsonl` 里 `focus_enter` 只出现过 2 次，都是
   11-03 的 loop 测试；当前 `focus.json` leases 为空；time goals/spans 为空；记忆库 open memo 为 0。
   也就是说：**除了心跳，所有「主动性入口」的输入都是空的**。
3. **心跳大部分是空转**。25 次心跳里 17 次（68%）没有调用任何工具，只回一句状态播报
   （「快四点，43。」「下午一点多，没事。」）；8 次有工具动作，5 次真的发了 QQ。
   但 11-14 18:18 的第一次「群消息进 backlog + 心跳」真实 tick 成功了：世界状态报 18 条未交付，
   她查了其中一个群，判断是刷屏、决定不回。**最小 L1 不需要新机制，只需要把简报和收尾补齐。**
4. **业界的共同答案是「收窄触发 + 明确 no-op」**，不是「更频繁地自主行动」：只有三类合法触发——
   到期承诺、清单未完成、情境窗口且有料；其余时间显式什么都不做（external.md §0）。
   自产主动性**永远不能 pierce**（不能穿透自己设的勿扰）。
5. **建议不新增「attention 模块」**。用现有四件套（time 时钟 / focus 做事状态 / note 议程 / qq 候选）
   补五个语义：**条件唤醒、决策简报、focus 默认穿透与卫生、可测量的 no-op、
   「看过但不回」的收尾**。第一真实场景选「**等你的消息（L1 attend）**」：
   群积压主动查看、按需回复，不发无由头的消息。
6. 需要用户拍板的点见 §7；在拍板前不改 live 行为。

---

## 1. 现状：有什么、真实跑了什么

### 1.1 四个功能

| 功能 | 实现 | 状态 |
|---|---|---|
| 筛选 | `focus.admit`：ambient→backlog；无 focus 全穿；有 focus 按 pierce；sacred 只放行闹钟/admin | 有，刚在 11-14 紧急修过群消息穿透 |
| 聚焦 | focus 租约：同一时刻一个；跨 turn/重启存活；`title/reason/goal/exitCondition/expectedMinutes`；离开时回放积压摘要 | 有，**真实场景 0 次使用** |
| 发起 | time heartbeat（无开关，f=0.2，约 50–100min）；time goal 续推；time 闹钟；qq wake planner（replyCheck/proactive/nudge） | 心跳在跑；其余默认关或无输入 |
| 收束 | sleep/quiet/pause（time）；focus_leave；goal 完成/取消 | 有 |

### 1.2 线上证据（2026-11-14 18:00）

| 证据 | 数值 | 含义 |
|---|---|---|
| `time.json` | `heartbeatFrequency:0.2`、`sent:55`、`dueAt` 18:18、`goals:[]`、`spans:[]` | 心跳是唯一长期运行的主动源；没有目标/长日程 |
| `session-events.jsonl` | 25 次心跳唤醒：**17 次 0 工具**（68%）、8 次有工具、5 次发 QQ | 心跳多数只换来一句状态播报 |
| 同上 | `focus_enter` 结果仅 2 条（11-03 23:32/23:36，loop 测试） | **真实对话从未进入 focus** |
| `focus.json` | `leases:[]`；backlog：C4 412 群 +8、三维方块 +1 | 紧急修复后群消息改为「只进 backlog」，等心跳/主动查看 |
| 记忆库 note | open 0（22 条：18 archived、4 done） | 「心里惦记的事」议程为空 |
| `qq/status.json` | `proactiveEnabled:false`、`replyCheck:false`、`nudge:true` 但本进程 0 次 | 对外主动全关 |
| time awakeTick | 11-07 11:46 commit 改为 opt-in，产品写死 false；最后一条事件 11-07 11:50 | 曾 43 条/120min，实测造成「2 分钟静止 + 教轮询」，被关闭 |

心跳无工具回合的典型输出（原文）：

```
- 2026-11-13T05:21 下午一点多，没事。
- 2026-11-13T08:18 四点一刻，39。一天又这么过去了。
- 2026-11-14T07:45 快四点，43。
```

**这不是「没活硬整」，是「没事硬报」**：模型被叫醒，没有可判断的事，只能复述状态。

### 1.3 为什么被动测试都对、真实场景却没启用

1. **心跳是状态播报，不是决策简报**。`heartbeatMessage()`（`time/index.mjs:1188`）= `statusText()` + 世界状态 +
   time 队列预览；没有「谁在等你」「你惦记什么」「今天还能不能主动」「可以什么都不做」。
2. **唤醒只看时间，不看状态**。`maybeHeartbeat()` 到点就发（`time/index.mjs:1202`），空状态也发；
   没有「没有可处理的事就不叫醒」的条件。
3. **议程没有燃料**。note 是现成的「没放下的事」（`note` 插件，purpose 契约 order 879），但线上 0 open；
   v3 记忆把承诺降级成 episode 注释（历史记录，不跟踪完成状态），所以「承诺到期」没有可信来源。
4. **产品提示词明确禁止自己开跑**。`prompts/sim.md:9-10`：「没人叫你的时候，正常聊天、待着，不要自己开跑。
   收到『出门』『开始』『去刷吧』这类话，再出去做事。」——研究主动性之前，必须先决定是否改这条产品立场。
5. **focus 现在贸然进入会出事**。`focus_enter` 默认 `pierce:{}`（`focus/src/index.mjs:12,94`），
   而 `resolvePierce` 的默认级别是 `mention`（`contracts.mjs:77`）；一旦进入 focus，
   **主人私聊会被拦进积压**（不只是群）。另外没有任何卫生机制（stale focus、退出提醒）。
   所以「原型没启用」某种程度是保护：它当时不可日常使用。
6. **没有度量**。没有决策日志、no-op 率、打扰预算；「她这次醒来做了/没做什么」只能人工翻会话。

### 1.4 首次真实注意力 tick（2026-11-14 18:18，紧急修复后的第一次心跳）

- 心跳正文世界行：`QQ：消息未交付：2 个群 18 条`（C4 412 群 +16、三维方块 +2）。
- 她调用 1 次 `qq_unread` 查看 C4 412 的 16 条，然后结束回合，没有回复：
  「按说的，刷屏这波我没接——他们自己也把事解决了」。
- 没有进入 focus（这类单步查看不需要）。
- **结论：最小 L1 已经在真实场景成立**——闸门把群消息攒起来、世界状态报数、心跳把她叫醒，
  她自己决定看不看、回不回。不需要先造新机制。
- 同时暴露两个缺口：
  1. 18 条里她只看了 16 条那个群，另一个群 +2 没看：简报只有「2 个群 18 条」，
     没有按群 + 最近文本，她自然挑大的。
  2. **「看过但不回」没有出口**：`qq_unread` 不推进任何水位，这 16 条仍是「未交付」；
     focus backlog 也还在。下次心跳世界状态还会报「2 个群 18 条」，逼她重复看、重复判。
     旧实现有三档水位（delivered / model-seen / acknowledged），当前只有两档（delivered / attended），
     缺的正是「她看过了，但决定不回」这一档。

> **重要 caveat（用户 2026-11-15 指出）**：18:18 这次「不回」很可能受用户此前在 QQ 里说过
> 「群里刷屏不用回」影响——这是**上下文/提示词**的作用，不足以证明注意力机制本身生效。
> 因此策略必须写进静态 `prompts/sim.md`，并在**干净上下文**（不依赖聊天里的口头指令）里验证；
> 18:18 只作为「提示词影响很大」的旁证，不计入验收。

---

## 2. 外部研究结论（详见 external.md）

### 2.1 三类合法触发

| 触发 | 例子 | ICL 对应物 |
|---|---|---|
| 到期承诺 | Letta `cron`/`Wake`、ChatGPT Tasks、Temporal timer | time 闹钟/goal、note 里答应过的事 |
| 清单未完成 | Anthropic 长期 agent：读 `progress` + `feature_list.json`，选最高优先级未完成项 | note open 项、time goal、focus backlog |
| 情境窗口 + 有料 | Marinara：安静 120min、Morning/Goodnight/Meal、每日 2–8 次 | 长静默 + 积压/新发现 |

三类都不成立 → **no-op 是一等结果**，不是失败。

### 2.2 三种架构

- **事件驱动**（ICL signals/delivery）：没消息时绝对安静；不推进长任务。
- **定时心跳**（Letta cron、ICL time）：可预算、可审计；空转会变噪音。
- **反思-计划循环**（Generative Agents、BabyAGI）：适合有可验证清单/纯扮演；陪伴场景容易自嗨、编任务。

组合才是答案：**事件驱动 + 定时器 + 清单驱动决策**，不是自由循环。

### 2.3 防打扰

- Marinara：安静 120min 才可 check-in；Offline 永不先发、Busy 等待 ×3；每日上限 2–8（按 talkativeness，
  与角色安全上限取更低）；follow-up 最多 3 次，间隔 2×/4×，用户一回复就重置；群聊共享额度、只让一个角色 check-in。
- Discord 服务器默认 **只 @ 才通知**——「默认安静」是产品立场。
- ChatGPT Pulse：每天一次、摘要式、可调主题。
- 反面：星野式电话/强推送，用户第一反应是找关闭开关。
- ICL 现状：`maxWakePerHour:12` 是小时预算，缺「天预算」；`proactiveProbability:0.3` 是随机命中，
  不可归因、不可复现、不可评估——**概率只能用于多个等价时机里挑一个，不能当「要不要说话」的主判据**。

### 2.4 评估

- ProactiveBench（arXiv:2410.12361）：把「此刻该不该主动」做成 accept/reject 二分类，
  微调后 F1 仅 **66.47%**——判断本身很难，别假设模型天然会。
- 建议指标：打扰率、回应率、负反馈率、false-positive initiative rate、承诺履约率、
  **no-op 率（健康指标，过低=空转）**、恢复延迟。

### 2.5 不该学

AutoGPT/BabyAGI 的「每 tick 必产出」；概率当主判据；自产信号走 pierce；
星野式强打扰；把 reflection 当「想说话」的借口；让 agent 自评完工；把「密集检查」当勤奋。

---

## 3. 本机旧实现（详见 local-scout.md）

### 3.1 focus-core（旧 ICL，语义参考）

| 机制 | 值得借 | 注意 |
|---|---|---|
| `selfwake` 四档 off/low/normal/high（默认 low=2–4h） | 让模型用「活跃度」而不是间隔 | 当前 heartbeat 只有 frequency，不能真正 off |
| 自醒文案：「你自己醒了一下（不是有人叫你）…想做什么都行；什么都不想做也可以——那就继续沉默，没人会因此觉得你失礼。」 | **允许 no-op 的措辞纪律** | 当前 heartbeat 没有这句 |
| `continuation`：goal 未完成时 90s→3/10/30min 退避，最多 5 次后 `stalled`，最后一次明说 | 长任务收尾语义 | 当前 time goal 只有续推，没有 stalled/最后一次 |
| `pending_leave`：安静 5min 后系统替她离开 focus（`declaredBy:'system'`） | 防止 stale focus | 与「系统不替她离开」有张力，需产品决定 |
| `renderWorld` 每轮世界状态：在做什么/目标/闹钟/别处积压/能说话的地方/静音/预算 | **决策简报的现成形状** | 字段多，需按 ICL 现状裁剪 |
| `policy.decide` 单一纯函数七道闸 | 裁决点收敛 | 当前是 focus.admit + time gate 双闸，doc 建议先 facade 对拍，不直接重写 |
| push 预算 12/天 | 预算概念 | 旧 repo 自己踩过「预算静默挡住所有投递」，且已弃用；要重新引入必须「只降级、不丢、不挡私聊」 |

### 3.2 dsh-qq（旧 QQ 桥）

- `idleHeartbeat`（20–45min）是唯一明确给出**自由活动清单**的文案：
  「你现在没事做。可以翻记忆、看红点、排闹钟、刷内容、写状态，也可以继续发呆。」
- `proactiveCheck` 是 30–90min 随机 + idle≥15min + 概率 0.3 + 4 个乘数（夜×0.3 等）——旧项目自己的 v2
  已判定为反模式（5–6 个定时器，她自己和操作者都无法预测下一句什么时候来）。
- 结论：**借文案与语义，不搬调度**。

---

## 4. 诊断：注意力缺的是「一次决策」

把注意力拆成五个部件，ICL 现状：

| 部件 | 现状 | 缺口 |
|---|---|---|
| 时钟 | time tick + heartbeat + 闹钟 + goal | 唤醒只看时间，不看「有没有事」 |
| 候选 | qq wake planner（只产 signal）；note 议程；focus backlog | 候选没有汇总到一次决策里；议程常年为空 |
| 决策 | 模型的自由判断 | 没有 brief、没有 no-op 定义、没有预算、没有记录 |
| 执行 | 工具调用；发消息 | 自主动作没有「归属」，无法和回复区分 |
| 抑制 | focus/time gate | 自产信号没有「永不 pierce」的显式规则 |

**一句话**：focus 是**接收侧的闸门**（别处的事能不能进来），但系统没有**发送侧的做事状态**
（我现在在做什么、为什么、做到哪、什么时候收）。注意力不是「一个开关」，是「**在做什么 + 什么可以打断 + 什么在等 + 什么时候该换**」。

---

## 5. 设计提案：Attention V1（不新增模块）

### 5.1 原则

1. **time 是唯一时钟**；不新增 scheduler。
2. **focus 是唯一「正在做的事」**；不新增 activity 注册表。
3. **note 是唯一议程**（memo/待查/答应过的事）；不新增记忆层。
4. **qq/signals 只产候选**，不直接投递；不新增 wake 类型。
5. **自产主动性永不 pierce**；pierce 只留给外部真实事件（@、私聊、闹钟）。
6. **no-op 合法且可记录**；不为了「显得主动」硬发。
7. 先做**被动可观测**（记录她每次醒来怎么判断），再做对外主动。

### 5.2 不做什么（边界）

- 不新建「attention 插件/服务」、不加第二套调度器；
- 不引入 note/nudge/push 三级投递（`QQ-GROUP-DESIGN.md:74` 已明确「先保持简单」）；
- 不用随机概率作为「要不要说话」的主判据；
- 不让自产信号走 pierce；
- 不新增记忆层、意图分类器、每轮 mood judge；
- 不自动归档 memo（先观测 2 周再决定）。

### 5.3 三层主动性（先定义边界）

| 层 | 含义 | 对外可见 | 默认 |
|---|---|---|---|
| **L1 处理（attend）** | 看在等她的消息/积压、继续 goal、结掉 memo | 回复等待中的消息 | **建议开**（本次第一场景） |
| **L2 自己的时间（own-time）** | 刷内容、查资料、整理记忆、想事 | 不发消息；最多之后分享真实发现 | 可选（长静默 tick） |
| **L3 主动联系（reach out）** | 没人在等，也主动发消息 | 私聊/群冒泡 | **默认关**，需单独拍板 + 预算 |

这三层分开后，「什么时候决定自己要干什么」就有了可执行答案：
**L1 由「有人在等」触发；L2 由「长静默 + 有想做的事」触发；L3 只在有具体事由 + 预算内触发。**
其余时间不做。

### 5.4 条件唤醒（改 time，不改架构）

现在的 `maybeHeartbeat` 到点必发。改成：

```
pending = focus.backlog总数 + note.open数 + (活跃 goal 且到续推点 ? 1 : 0)

到点后：
  if pending > 0 且 idle ≥ minIdle        → 发「决策简报」心跳
  else if 静默 ≥ longSilence（默认 3h）    → 发「长静默」心跳（L2 机会）
  else                                    → 不唤醒，15min 后再看；记 heartbeat-skip-empty
```

要点：
- 没有可处理的事就不叫醒（直接消掉 68% 的空转）。
- 长静默兜底仍在，避免「永远不醒」；但它是低频的，不是每 50 分钟一次。
- 不改 heartbeat 的 `frequency` 语义（模型仍可调活跃度），只是在「到点」之上加状态条件。
- `longSilence` / `minIdle` / `skipCheckSec` 进 time 配置，可回滚。

### 5.5 决策简报（改 heartbeat 文案）

唤醒时正文从「状态转储」改成「决策简报」：

```
【自醒】周六 15:45 —— 这是你自己醒的，不是有人叫你。
你在：自己的时间（没有专注）。
等你：C4 412 群 +8（最早 26 分钟前，最近：「哦不，买雪糕买到残次品了」）；
      三维方块 +1；私聊 0。
对外主动：关（只能回复在等你的消息；你惦记的事见「心里惦记的事」）。
下一次安排：无。
可以：看积压 / 继续手上的事 / 做点自己的事；也可以什么都不做——不回也不失礼。
（要做一件事就先 focus_enter；做完 focus_leave，我会把期间积压摘要给你。）
```

- 内容来自 `focus.backlog()`、`note` service、`time` 的 goals/schedules、世界状态；
- 每项最多 3 条、每条 ≤80 字；不做语义判断，只给事实；
- 结尾明确 no-op 合法 + focus 用法（这是「focus 怎么接」的入口提示）。

### 5.6 focus 接入（双向）

**接收侧（已有，补默认规则）**

- ambient（群普通消息）**永远是只拉不推**：进 backlog；@ 才 pierce。
  这与 11-14 紧急修复一致，也是旧 focus-core 2026-10-31 的决议（ambient is pull）。
- `focus_enter` 默认穿透改为**产品级默认**：
  `{'qq:private:*':'always', 'qq:group:*':'mention'}`。
  理由：现在默认 `{}` 会把主人私聊也拦掉（`contracts.mjs:77` 默认 mention，私聊没 mention 标签）。
  进入 focus 不等于失联。
- 进入某群 focus 时只回放该群 backlog（已有，`host.mjs:78-101`）。

**发送侧（新增语义，不加代码）**

- `focus_enter({title, reason, activity, goal, exitCondition, minutes})` = 声明「我现在在做这件事」；
- 期间：外部普通消息进 backlog；@/私聊/闹钟按 pierce 进来；
- 做完/放弃：`focus_leave` → 回放积压摘要 → 下一次决策；
- prompt 的 focus 段已经显示「你在做：X（已 N 分钟）」，把 elapsed 和 goal 用起来即可；
- stale 卫生：focus 超过 `expectedMinutes` 或 4h 没动静时，**由心跳简报提一句**
  「你在这个专注里已经 X 小时，还要继续吗？」——系统不替她离开（保持硬约束），但给她收尾机会。

**为什么这样接**：focus 不是「勿扰开关」，是「我正在做一件事」的显式状态。
只有先有做事状态，才有「什么时候该进入/离开」；否则 focus 只是被遗忘的租约。

### 5.7 议程（不新增存储）

- 用现有 `note`：`memo`（自己留的）、`question`（dream 提出）、`promise`（答应过的事，已预留 kind）。
- 燃料来源：
  1. 对话里答应/承诺 → 应写 `memo`（提示词纪律，不是语义 judge）；
  2. dream 发现不确定项 → 已有 `note` 写入路径；
  3. 长期未结 → 心跳简报里露出最旧 1–2 条。
- 收尾：`memo_commit`；`note_status` 计数。**不新增 purpose 存储、不做四驱动衰减。**
- 已知问题：note「只进不出」（历史 16 open / 0 结案）。V1 先观测，不强行加自动归档；
  如果 2 周后仍只进不出，再讨论「过期重问/降级」——那是另一个决策，不在本轮。

### 5.8 预算与归属（L3 才需要）

V1（L1/L2）**不允许无由头对外发消息**，因此不需要预算代码。若将来开 L3：

- 每日上限（建议 1–2 次起），按「自产 vs 外部」分池；外部 @ 不占自产额度。
- 安静时段（sleep/paused/sacred）只进 backlog，**不 pierce**。
- 每条自产消息必须能被归属：日志记 `trigger/evidence/budgetLeft`，正文明确不是对方刚发的。
- 先人工抽检 100–200 条「此刻该不该说」再谈自动化（对标 ProactiveBench 的 accept/reject）。

### 5.9 观测（不改产品也能做）

从现有 `session-events.jsonl` 就能算：

| 指标 | 定义 | 目标（Stage A） |
|---|---|---|
| 空转率 | 心跳回合无工具/无动作 / 心跳回合 | 从 68% 降到 ≤20% |
| 积压年龄 | backlog 最早消息 → 首次被查看 | 醒着时 p90 ≤ 3h |
| 主动查看率 | 有 backlog 的心跳里，实际查看/回应的比例 | ≥60% |
| focus 使用 | 真实会话 focus_enter/leave 次数、持续时间 | ≥1 次/天，stale 0 |
| 私聊被拦 | 进入 focus 后 owner 私聊进 backlog 的次数 | 0（默认穿透修好后） |
| 打扰 | 自产对外消息数 | 0（Stage A/B） |

脚本已有：`.state/lab/lead/attention-research/analyze-heartbeat.mjs`（心跳回合分类）。

### 5.10 缺口：「看过但不回」要有出口

任何注意力系统都必须允许「我看到了，现在不回」。否则会出现两条坏路：
- 消息永远算「未交付」，每次心跳都重报 → 她重复看、重复判，最后学会忽略（habituation）；
- 或者为了清红点而敷衍回复——正是用户最讨厌的「事事必回」。

最小实现（Stage A 范围内）：

- 给 QQ 账本补一档 **seen/ack 水位**（只表示「她看过了」，不表示「已回复」），
  与 delivered / attended 分开；
- 查看 backlog（`qq_unread` / `focus_backlog` / 进入群 focus）时**不自动**推进；
  由她显式调用一次「这批我看过了，不回」的动作推进（工具名待定，`qq_ack` / `qq_mark_read{seenOnly}`）；
- 世界状态/心跳简报的「等你」只算 **seen 之后**的增量；旧账仍可用 `qq_unread` 翻；
- 与 focus backlog 的配合：ack 某个 activity 时，把该 activity 对应的 focus backlog 一并结掉
  （否则 focus.json 里会永久残留）。

---

## 6. 真实场景启用：分阶段

### Stage A（建议现在做，1 周）

**场景：等你的消息（L1）**
- 条件唤醒 + 决策简报（按群给 +N 和最近一条，不再只给总数）+ no-op 合法；
- 「看过但不回」出口（§5.10）：看了就 ack，不让同一批永远重报；
- focus 默认穿透修复 + 只在「确实要做一件事」时进入；
- 允许她主动查看积压并按需回复（回复等待中的消息不算打扰）；
- **禁止无由头私聊/群冒泡**（L3 关）。

验收：空转率 ≤20%；有 backlog 的唤醒 ≥60% 会查看；积压 p90 ≤3h；focus 私聊拦截 0；
ack 后下一 tick 不再重报同一批；无自产对外消息；测试全绿。
回滚：time 配置关条件唤醒 + 恢复旧 heartbeat 文案（一次提交可回滚）。

### Stage B（可选，Stage A 稳定后）

**场景：自己的时间（L2）**
- 长静默（≥3h）心跳里给「自由活动清单」：翻记忆/看群/查资料/整理/发呆；
- 她可以 `focus_enter` 做一件自己的事，不发对外消息；
- 产出只留在会话/记忆，之后有真实新发现才分享（符合 persona「有真实新发现才分享」）。

验收：每次长静默 tick 要么有具体动作要么 no-op；不产生对外消息；不发生「出门」式长时间自嗨。

### Stage C（需用户单独拍板）

**场景：主动联系（L3）**
- 只在有具体事由（到期 memo、未回的问题、真实新发现）且预算内；
- 每日 1–2 次起，安静时段不 pierce，正文明确归属；
- 先跑 2 周 + 人工抽检，再决定是否扩大。

**不建议**现在直接开 qq `proactiveEnabled`：它是 30–90min 随机 + 概率 0.3 + 冷却，
不可归因、不可评估，且没有「有料」判据；应被上面的决策 brief 取代，而不是打开旧开关。

### 6.5 若拍板：改动清单（Stage A 预估）

| 文件 | 改动 | 规模 |
|---|---|---|
| `packages/plugins/time/src/index.mjs` | 条件唤醒（pending 计算 / skip / 长静默兜底）；heartbeat 文案换成决策简报；配置项 `heartbeat.conditional/longSilenceSec/minIdleSec/skipCheckSec` | ~60–80 行 |
| `packages/plugins/focus/src/index.mjs` | `focus_enter` 默认 pierce 改为私聊 always + 群 mention | ~3 行 |
| `packages/plugins/qq/src/{ledger,index}.mjs` | seen 水位 + 显式 ack 动作（§5.10）；ack 时结掉对应 focus backlog | ~40–60 行 |
| `prompts/sim.md` | 补「醒来时」：L1/L2/L3 边界、no-op 合法、focus 用法；修正群聊「安静时可以直接到」的过期描述 | ~10 行 |
| `packages/core/test/time-lock.test.mjs` | 条件唤醒：有积压触发 / 空状态跳过 / 长静默触发 / 配置关回退 | ~4 用例 |
| `packages/core/test/focus-*.test.mjs` | 默认 pierce 下私聊穿透、群 @ 穿透、群普通消息仍进 backlog | ~2 用例 |
| `packages/core/test/qq-*.test.mjs` | ack 后世界状态不再报同一批；未 ack 仍可见 | ~2 用例 |
| 不动 | `core/services.mjs` 闸门、qq 发送、memory、dream | — |

---

## 7. 需要拍板的点

| # | 决定 | 选项 | 建议 |
|---|---|---|---|
| 1 | 首启哪一层 | A 只 L1 / A+B / 直接 L3 | **A 只 L1**（真实场景、零对外打扰） |
| 2 | sim.md 的「不要自己开跑」 | 保持 / 改为允许 L1+L2 / 只允许 L1 | **允许 L1+L2，禁止 L3**（L2 不发消息） |
| 3 | focus 默认穿透 | 保持 `{}` / 私聊 always + 群 @ | **私聊 always + 群 mention**（否则 focus 会拦主人私聊） |
| 4 | 条件唤醒 | 到点必发 / 无事跳过 + 3h 长静默兜底 | **无事跳过 + 3h 兜底**（消掉空转） |
| 5 | 预算/no-op 工具 | 现在就加 / Stage C 再加 | **Stage C 再加**；V1 用提示词 + 日志即可 |
| 6 | 「看过但不回」出口 | 不做 / 加 seen 水位+ack 动作 / 只在 qq_unread 时自动 ack | **显式 ack（§5.10）**，否则同一批会永远重报 |
| 7 | 第一真实场景 | 群积压查看 / 自己的时间 / 私聊 check-in | **群积压查看（L1）**，已由 18:18 心跳自然验证 |

拍板后我可以先做 lab 验证（假时钟 + focus/time/note 单测 + 一次真实心跳回放），
再改 live 配置；不会未经确认直接启用对外主动。

---

## 8. 参考

- 外部调研全文：`.state/lab/lead/attention-research/external.md`
- 本机盘点全文：`.state/lab/lead/attention-research/local-scout.md`
- 关键外部链接：
  - Anthropic, Effective harnesses for long-running agents — https://www.anthropic.com/research/effective-harnesses-for-long-running-agents
  - Letta scheduling-tasks（cron/Wake、missed 语义）— https://github.com/letta-ai/letta-code/blob/5e45ebb6a36c138cd5efba3c13570d9a8c1bf1b7/src/skills/builtin/scheduling-tasks/SKILL.md
  - Marinara Engine character schedules（check-in 上限/情境窗口/follow-up）— https://github.com/pasta-devs/marinara-engine/blob/fc0333c3fe978cda5e0b919bd6faec985901704e/docs/conversation/schedules.md
  - ProactiveBench（arXiv:2410.12361）— https://arxiv.org/abs/2410.12361
  - Generative Agents（arXiv:2304.03442）— https://arxiv.org/abs/2304.03442
  - Discord Guild `default_message_notifications` — https://discord.com/developers/docs/resources/guild
- 仓库内：`docs/FOCUS.md`、`docs/TIME-HEARTBEAT.md`、`docs/DELIVERY-POLICY-DESIGN.md`、
  `docs/SOUL-RESEARCH.md`（主动性 vs 发送权分离）、`docs/PURPOSE.md`

---

## 9. 验证记录（2026-11-14）

- **测试全绿**：18:21 跑 `npm test` → `tests 929 / pass 928 / fail 0 / skipped 1`
  （与注意力相关的 focus/time/qq 用例均通过；本轮未改代码，只新增文档与 `.state/lab` 脚本）。
- **live 未改行为**：只提交了本文档（`docs(attention)`），没有动 preset、state 或插件代码。
- **18:18 首次真实 tick 的后续**：18:21 查 QQ 账本仍是 121 条 / 已交付 103 条，
  那 16 条群消息并未因为「看过」而推进；下一次心跳（19:20）会再次报同一批。
  这实证了 §5.10 的缺口：没有 ack，就会「同一批永远重报」。


---

## 10. 实施记录（2026-11-15，L1+L2 已落仓库，重启后生效）

用户拍板：L1+L2 先；focus 默认穿透按建议；条件/自适应心跳按建议；Stage C 再加预算工具；
显式 ack + 「在某个聊天回复即自动已读」；sim.md 的「不要自己开跑」改为允许 L1+L2、禁止 L3。

已改（**仅仓库，live 未重启前不生效**）：

| 层 | 改动 |
|---|---|
| `time` | 条件/自适应心跳：有 pending 才叫醒；无事跳过并按 `backoffFactor` 拉长（`maxBackoffMul` 封顶），外部活动重置；封顶后触发「长静默」tick（L2 自由活动清单）；`heartbeat.conditional:false` 可回滚旧行为；简报取代状态播报 |
| `qq` | 账本新增 `seen_seq`（未读 = lastSeq - seen）；`qq_mark_read` 改为显式 ack（可跨未交付，内容仍在账本）；**回复某聊天即自动 seen**（发送前 lastSeq 快照，发送后新到的不算）；ack/回复时清对应 focus backlog |
| `focus` | 默认 pierce = 私聊 always + 群 mention（旧默认会让 focus 拦掉主人私聊） |
| `prompts/sim.md` | 写清 L1/L2/L3、no-op 合法、focus 用法、群 backlog/@/ack/回复即已读 |
| 文档 | `docs/QQ.md`、`docs/QQ-GAP.md` 水位语义同步 |

验证：

- `npm test`：**937 tests / 936 pass / 0 fail / 1 skip**。
- live 账本副本迁移验证：旧库 `attended_seq` 自动回填 `seen_seq`（私聊 81/81/81 → seen 81、未读 0；群 16+2 未读保持不变）。
- 干净上下文 lab（不读聊天历史）：`.state/lab/lead/attention-research/verify-clean-context.mjs`
  → **16/16 checks**（静态 sim.md 策略存在；空状态跳过后退避；有积压发决策简报；简报含群名/条数/
  no-op/focus 用法/对外主动关；长静默封顶醒一次并给自由活动清单）。
- 结论：行为不依赖 live 聊天里那句「刷屏不用回」；18:18 的旁证已标 caveat。

### 10.1 重启后首夜事故：冷恢复未读摘要把睡着的她叫醒了（已修）

重启后 2026-11-15 00:20（睡眠 span 内），bridge 的「冷启动未读摘要」路径
（`promptUnreadWithoutAgent`）绕过 signals/delivery，直接用 `session.prompt` 把 QQ 未读摘要投进会话，
产生了 turn 和一条 assistant 消息。这是**结构性旁路**，不是心跳。

修复：

- bridge 的冷恢复前先问 time：睡眠/静音/暂停/安静安排/**时间队列已有积压**时一律不冷恢复；
  醒来后再走正常投递。
- time 的条件心跳 pending 增加 **QQ 账本未读**（`qq.unreadTotal`，seen 口径）：
  即使 focus backlog 被清空，账本里的未读也不会从「等你」里消失。
- 冷路径不再调用 `markUnreadDigest` 二次补标（上一版会把**没展示**的下一窗口也标成 seen；本次事故里 #21–#24 就是这样被误标的，内容仍在账本）。
- 新增测试：冷恢复被睡眠/队列挡住、醒来后恢复；QQ 未读会计入心跳 pending。
- 注意：这次修复仍需**再次重启 DSH** 才生效。

### 10.2 2026-11-15 晚：先做 A（关长静默），再做人格移植

- 用户拍板：`heartbeat.longSilenceSec: 0` —— 关掉「长静默」turn。无事只按 `idleCheckMaxSec`（默认 1h）检查，
  不产生 turn、不调模型；只有 pending（积压/未读/惦记）才叫醒。今天 3 次「安静了三个小时」这种空 turn 应当消失。
- 观察一周（不再给"刷屏不用回"这类口头指令），用 `.state/lab/lead/attention-research/daily-report.mjs` 出日报，
  看 attend 次数、动作、ack、backlog 年龄；一周后再判断有效性。
- 人格移植（下一步）：旧卡 01–06 节约 6.5k 字（人格/情绪/关系/语言），07–09 节约 9.4k 字
  （QQ 群聊/私聊/主动聊天）。按用户 2026-11-15 决定：**转回大肥鱼，但不强调"群友"**——
  人格只负责「她是谁、怎么说话、在乎什么」；群聊/工具行为留在 sim/tools。旧卡 16 节工具附录、
  旧 wake 配置、概率数值全部丢弃。
- 2026-11-15 晚用户确认草案：已应用到 `prompts/persona.md`（3,924 字符），与 A 一起重启生效。

生效方式：**需要重启 DSH Desktop**（插件代码从仓库软链加载；preset 不需要改）。
回滚：把 `time.heartbeat.conditional` 设为 `false` 即回到旧心跳；QQ seen 是新增列，旧数据自动为 0。
