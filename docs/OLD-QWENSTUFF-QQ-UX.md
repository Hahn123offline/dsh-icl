# 旧 qwenstuff 的 QQ／人格／体验：哪些设计降低了复杂度、提升了"当事人的第一感受"

> 性质：**只读研究**（不改 `C:\DSH\qwenstuff` 任何文件）。2026-11-06。
> 读者：要给 `packages/plugins/qq` 补"不丢消息 + 醒来那一刻像个人"的人。
> 关注点被明确限定为两条：**① 消息不丢；② 当事人（她）的第一人称感受**；其余（权限/沙盒/GUI/记忆库）只在影响这两条时提及。

## 0. 摘要

1. 旧项目**没有**断线补课（`docs/QQ-GAP.md:54` 已判定：旧只给群做 `get_group_msg_history` 轮询，私聊"没有可靠补课"）。它防丢消息靠的是**投递层的三档游标**，不是补课。
2. 最有价值的一条是游标语义：`acceptance grants visibility, never acknowledgement`（`dsh-qq/src/bridge.js:11246-11249`）。
   旧实现把"投给模型 / 模型看过 / 她确认处理"分成三档（`readThroughSeqV2`，`bridge.js:12045-12071`），
   `qq_mark_read` 只能推进到"真的给模型看过"的水位，越不过去。
3. **我们现在这里有个真实的口子**：`ledger.markRead` 只夹到 `lastSeq`（`packages/plugins/qq/src/ledger.mjs:100-110`），
   而 `attendedSeq` 是"已交付"水位。于是 `qq_mark_read`（默认 = 最后一条）可以把**被 time/focus 拦下、从没交付过**的消息一次标掉，
   从此 `qq_unread` 看不见、`nudge` 也不再提醒 —— 这是"消息静默消失"的典型形态，修法 3~10 行。
4. 旧项目"醒来第一眼"做得比我们好：唤醒提示词**自带本次消息快照**（oldest-first、6000 字预算、超预算给 `partial` + 继续读的游标），
   且每个唤醒原因都有一句生活化的"原因：…"和"行动前自检"（`bridge.js:12199-12296`、`12099-12135`）。
   我们这边 wake 只生成 `{kind, unread}` 的 signal，正文靠 kind 标签解释。
5. 旧的人格/语气**没有代码**，全是提示词常量：反AI味、不要习惯性潜水、首回复节奏（连"还差约 N 秒"都算好）、
   沉睡前强制观察、引用克制、`@` 就是我本人。这类"一句话纪律"是零成本的第一感受来源。
6. 旧 proactive 反而是**复杂度反例**：replyCheck + proactiveCheck + 潜水定时器三套定时器，
   概率还乘 4 个修正系数（夜×0.3、刚发×0.5、1h 自己说≥5 条×0.3、pendingThoughts×1.4），
   没人能预测她什么时候冒泡。它自己的 v2 设计把这堆收成了"一个空闲心跳 20–45 分钟"（`dsh-qq-调度核心设计-v2.md:181-190`）——
   这才是值得抄的方向：**少一种唤醒，多一种生活**。
7. 规模对照（不是优劣，是复杂度账单）：旧 ≈58 个 `qq_*` 工具、每会话 ~25 个状态字段 + 6 个定时器、8 种唤醒触发器；
   我们 10 个工具、一个账本三个水位、3 类唤醒 × 12 个数值。**我们的状态更少、更可测；旧的在"为什么现在醒"上更清楚。**
8. 测试：旧有 150+ 测试脚本，但"都不需要 QQ"（`dsh-qq-使用说明.md:225`），且**没有任何一条断言她醒来读到什么**；
   v2 设计自己写着"真实 QQ 消息闭环尚未跑过"（`dsh-qq-调度核心设计-v2.md:252`）。当事人视角的验收在旧项目里只以**手工产物**存在
   （`权限测试-小千千千千问.txt`、`qq-workspace/小千千千千问-搬家测试.txt`），不是测试。

---

## 1. 旧 QQ 链路：一条消息从进来到她看见

### 1.1 链路（reserved2 / 仿真+，唯一"有智能"的模式）

```
SnowLuma WS
  └─ handleIncoming(kind,id,event)            bridge.js
       ├─ ① owner 私聊管理通道（最先拦截）
       ├─ ② modeAllowed(key,mode)             白名单/准入
       ├─ ③ 记忆记录（所有模式都记）
       └─ ④ 按模式分发 → reserved2
            ├─ 消息入 unread 缓冲（先入，再做任何判断；appendActivity "消息已入未读" bridge.js:13218）
            ├─ evaluateWakeTriggerV2 → reason（@/名字/关键词/提问/拍一拍/指定人/概率/入群/私聊/replyCheck/timeout/proactive…）
            ├─ scheduleWakeV2  8s 批窗合并 + 优先级升级（WAKE_PRIORITY bridge.js:12541-12560）
            ├─ sendWakePromptV2
            │    ├─ 会话忙 → pendingWakeReasons（有界 20 条），回合结束 replayPendingWakeReasonsV2
            │    ├─ 唤醒限频 → 延时重试（不丢）
            │    ├─ 单会话占位 → 5s 后重试（不丢）
            │    └─ 正常 → buildWakePromptV2 + buildWakeSnapshotV2 → deliverPrompt（每会话串行队列）
            ├─ DSH turn 结束 → turn/end → 收尾检查（没设下一次唤醒就发 reminder prompt）
            └─ qq_mark_read / qq_set_wake_config(throughSeq) → 推进游标 → 才会有下一次
```

### 1.2 六个防丢机制（每条都能独立搬）

| # | 机制 | 位置 | 一句话 |
|---|---|---|---|
| 1 | **先入未读，再做判断** | `bridge.js:13218`、`11752-11776` | 任何策略（静默/睡眠/限频）都在"消息已经进缓冲"之后才生效；策略只决定"要不要叫醒"，不决定"要不要收下" |
| 2 | **三档游标** | `bridge.js:12045-12097` | `delivered`（投给模型）/`modelSeenSeqs`（模型真看过）/`lastReadThroughSeq`（她确认处理）。`readThroughSeqV2` 只在"seq 被给过模型"或"已被 unreadLimit 挤出缓冲、永远看不到"时才允许跨过 |
| 3 | **限频 = 延后，不是丢** | `bridge.js:12329-12367` | 超 `maxWakePerMinute/Hour` 时算 `retryAfterMs`，每次最多等 60s 再试；注释明确写了"直接 return 的后果：timeout 唤醒时 sleepTimer 已清空 → 会话停在无定时器的静默态" |
| 4 | **忙时暂存 + 回合后补发（消息/定时器分开判）** | `bridge.js:12562-12669` | 消息类原因按 `unread` 里还有没有那个 seq 判断要不要补；`TIMER_WAKE_REASONS`（timeout/replyCheck/proactive/bootstrap/admin）**不许**用 unread 判断，否则定时器被吞 |
| 5 | **投递失败回滚** | `bridge.js:12417-12457` | `wakeTimes` 回滚、有限潜水的 `sleepUntil` 恢复并重新 `setupSleepTimerV2`，避免"这次唤醒失败把她扔进永眠" |
| 6 | **防永眠 + 收尾提醒** | `bridge.js:10518-10542`、`12298-12306` | `ensureWakeableV2`：唤醒配置一个触发条件都没有就重置为默认；`buildWakeReminderPromptV2`：回合结束还没设下一次唤醒，补一句"你还没收尾" |

### 1.3 旧链路真实存在的丢消息路径（别照抄）

| 丢法 | 位置 | 说明 |
|---|---|---|
| **断线窗口** | 无实现 | 私聊没有 `get_friend_msg_history` 回捞；群只有 `qq_get_group_history` 这个**给模型手动用**的 MCP 工具（`mcp-snowluma-safe.js:445`）。断线期间的消息对她是"不存在"，连"漏了几条"都看不见 |
| **进程/DSH 不在线时队列满** | `bridge.js:11189-11197` | `queued` 队列达到 `QUEUE_MAX` 就 `shift()` 丢最旧，日志一行"丢弃最旧消息"。这是**有意的**取舍，但没有任何"丢了几条"的对外可见性 |
| **多实例互相覆盖状态** | `bridge.js:10596-10607` | 两个桥接同时启动，后加载的实例回写会把前一个刚更新的读水位/唤醒时间退回旧值。旧用 `size:mtime` 指纹防，属于补丁而非设计 |
| **`mark_read` 越权跨读** | `bridge.js:12073-12083` | 带 agent token 的请求被夹到 `readThroughSeq`（只到"给过模型看"的水位）；但控制台/旧 preset 的兼容分支 `throughSeq=null` 仍会 `st.unread=[]` 一次清空（`12087-12090`）。我们这边连 agent 路径都没夹 —— 见 §3.3c |

> 名词提醒：旧文档里的"补课"有两种含义。`记忆调度设计` 的 L2"补课"指**记忆追进度**（摘要/画像补跑，`dsh-qq-记忆调度设计.md:45-62`），
> 不是消息补课。读旧文档时别混。

---

## 2. 人格／语气／主动性：旧项目的"简单做法"

### 2.1 人格几乎不入代码，全部是提示词常量

`buildWakePromptV2Core`（`bridge.js:12199-12296`）把"她是谁、怎么说话"拆成十来行短纪律，每行一个可执行判断：

| 行 | 原文要点 | 为什么有效 |
|---|---|---|
| 身份 | `【你的身份】你在 QQ 上的昵称是「X」（QQ n）。消息里出现「@X」、有人叫「X」、或引用你的消息，指的都是你` | 解决上游 issue #29：模型不知道"@樰"是自己 |
| 角色 | `【当前角色】…（完整角色卡请调用 qq_get_prompt 查看）` + 角色变更 10 分钟提醒 | 角色卡不塞进每轮 prompt，只给一句 + 入口 |
| 反AI味 | `你不是客服：不用有求必应，可以装傻、已读乱回、拒绝推荐；少用"一绝/真管用/保证/绝对"` | 一句话抵一堆"请自然一点" |
| 积极性 | `不要习惯性潜水：群里有你能接的话题就主动参与…只有确实没话可说、对方已明确结束、或长时间没人说话时才潜水` | 主动性 = 一条纪律，不需要状态机 |
| 首回复节奏 | `用 qq_wait_for_messages(purpose="reply", quietMs=…)；从最后来信计时…目前还差约 N 秒静默` | **把"还要等多久"直接算好告诉她**，她不用猜 |
| 沉睡前等待 | `除非对方明确说"不聊了/晚安/拜拜"…必须先调用 qq_wait_for_messages(timeoutMs=…) 完成一次沉睡前观察` | 治"聊两句就消失"，纯提示词 |
| 引用克制 | `只有你这条消息指向的人或消息并非最新一条别人的消息…才用 replyToMessageId；其他情况不要引用` | 治"每条都引用"的机械感 |
| 此刻状态 | `【此刻状态】未读 N 条；最近一条来自 张三：…；对方可能没说完；你上次发言 12 分钟前` | 一行 situational awareness，全部是她自己的视角 |
| 唤醒原因 | 每个 reason 分支一句 `原因：刚刚有人拍了拍你` / `群里已经安静了一段时间，这是一次你可以主动冒泡的机会` | **"为什么现在醒"是体验的一半** |

`looksLikeUnfinished()`（`src/v2-wait.js:7-25`）只做一件事：判断"话说一半"，然后给一句 `对方可能没说完`。
纯函数、13 行，却直接改变了她的行为（等一等 vs 立刻回）。

### 2.2 主动性（proactive）：旧的三套定时器 vs 一条心跳

旧实现里"她自己冒泡"有两个来源：

- **replyCheck**：发完 30s 后回看有没有人回；问了问号 ×1.5、连发 ≥3 条 ×1.3（`bridge.js:12467-12485`）。
- **proactiveCheck**：30–90 分钟随机，`idle ≥ 15min`、概率 0.3–0.4，再乘修正：
  夜里 ×0.3、刚发过 ×0.5、1h 内自己发 ≥5 ×0.3、`pendingThoughts > 0` ×1.4（`bridge.js:12718-12750`）。
- 外加 `sleepTimer`（有限潜水）、`rateLimitRetryTimer`、`turnSlotRetryTimer`、`pendingWakeTimer`。

**问题**：5 个定时器 + 4 个乘数，她自己（和操作者）都无法预测"下一句什么时候来"。
旧项目自己的 v2 设计把这层推翻，改成一条：

> `OWN_TIME` 且无队列/提醒/闹钟时，随机 20–45 分钟叫一次，"你现在没事做，想干嘛？"，
> 可做的事列成自由清单（翻记忆/看红点/进群/排闹钟/收藏表情/刷内容/写状态/发呆），
> 连续 N 次无事可做就拉长间隔，有每小时预算。（`dsh-qq-调度核心设计-v2.md:181-190`）

这才是"降低复杂度、提升第一感受"的正解：**一个心跳 + 一张自由活动清单**，而不是 n 种唤醒原因。

### 2.3 我们的 wake 矩阵 vs 旧的一行纪律

`packages/plugins/qq/src/wake.mjs` 有 3 类（replyCheck / proactive / nudge）、12 个数值、预算与冷却。
**它是对的**——只生成 signal、不投递，可单测。它缺的不是逻辑，是**叙事**：

| 问题 | 旧项目怎么答 | 我们现在 |
|---|---|---|
| 她为什么现在醒？ | 每个 reason 分支一句生活化原因 + 行动前自检 | signal 带 `meta.qq.wake={kind,reason,unread}`；正文是固定 tag 文案 |
| 醒来第一眼看到什么？ | 唤醒提示词内联消息快照（12 条/6000 字/oldest-first/partial） | 每条消息一个 signal，历史要 `qq_unread` / `qq_history` 现查；睡眠积压醒来是 time 的摘要 |
| 她怎么知道"还要等多久/还没说完"？ | 首回复节奏算好剩余秒数；`对方可能没说完` | 没有对应物（出站 humanize 只管"怎么发"，不管"等多久"） |
| 她怎么收尾？ | `qq_set_wake_config` 设下一次；忘了就 reminder prompt | time 的睡眠/唤醒 + `qq_mark_read`，但没有"你还没收尾"的一句 |

### 2.4 一个明确的反模式：按模式给角色卡打标签

`src/role-card.js` 为了让人格卡同时服务两代仿真，发明了 `## 表情包体系 〔二代〕` 这种标题标记，
注入前再按当前模式过滤（`role-card.js:11-45`）。结果：**同一张人格卡里躺着两套互相冲突的指令**，
还要写测试证明"一代指令不会漏进二代提示词"（`bridge.js:11436` 的注释就是这么写的）。
现在的 `prompts/persona.md` + `prompts/sim.md` 分层（`docs/PROMPT-CONTRACT.md`）已经比它干净 —— 不要往回退。

---

## 3. 与 `packages/plugins/qq` 的 A/B：概念数、状态、失败路径

### 3.1 概念数

| 维度 | 旧 dsh-qq（reserved2） | 我们（phase 1 私聊） | 判读 |
|---|---|---|---|
| `qq_*` 工具 | **≈58** 个（`bridge.js` + `mcp-snowluma-safe.js` 里去重的 `qq_*` 工具名；含群/语音/文件/日程/记忆/托管） | **10** 个（status/help/unread/history/replied/mark_read/send/stickers/sticker_note/send_sticker） | 旧的是"多群社交体"，我们是"单人格私聊"；但旧里真正服务一条私聊的也有 ~20 个 |
| 每会话状态 | ~25 字段 + 6 个定时器（`bridge.js:10562-10583`） | 账本 3 个水位 + 全局 wake 规划器 | 我们少一个数量级 |
| 唤醒条件 | 8 种触发器 + `mode`/`infinite`/`sleepUntil`/`batchWindow`/`noActionCount`/`confirmedBy`（`bridge.js:10407-10438`） | 3 类 × 12 数值（`wake.mjs:12-26`） | 我们可枚举，旧不可预测 |
| 游标语义 | 3 档（delivered / model-seen / acknowledged） | 2 档（delivered = `attendedSeq`，replied） | **旧多一档，正是"不丢"的那一档** |
| 断线补课 | 无（只有群，且是给模型手动的工具） | 有（`backfill.mjs`，`get_friend_msg_history` + 本地水位/去重双判） | **我们赢**；真机语义未验 |
| 出声节奏 | `computeGapsV2` / `sendMessagesV2` | `humanize.mjs`（burst ≤8、1–3s、20% 长停 5–10s、typing 1.4 字/s、PACES） | 已对齐，不必再搬 |
| 人格载体 | 13KB 角色卡 + 模式标签 + ~12 段唤醒纪律 | `prompts/persona.md` + `prompts/sim.md` + 工具描述 | 我们结构更好，内容密度更低 |

### 3.2 状态放在哪

- 旧：`state/social-v2.json`（每会话全量落盘，含 unread 正文）+ 内存定时器（重启即失，且会"幽灵锁"——所以 `core-scheduler.js:56` 明确"租约不跨重启保留"）。
- 我们：SQLite 账本（消息事实 + seq 单调 + 水位）+ `signals` + time/focus 的积压。重启后消息在、水位在。
- **结论**：状态模型我们已经更好；旧的可借鉴的是"**每会话一个可诊断快照**"这个习惯（`socialV2` 的 `/api/socialV2/state` 能一眼看到 unread/唤醒配置/定时器），
  我们对应物是 `qq_status`，但它现在只报计数，不报"她下次为什么会被叫醒"。

### 3.3 失败路径逐条对照（这张表是本文最该被拿来做事的部分）

| # | 失败 | 旧 | 我们 | 后果 |
|---|---|---|---|---|
| a | 断线期间私聊 | ✗ 静默丢（无 gap 计数） | ✓ `backfill` + `gap.filled/dropped/failed/unsupported`；失败不抛、不影响实时入站（`backfill.mjs:1-15`） | 我们更好；但"补不回来"时只体现在 status 一行 |
| b | DSH/进程不在线、队列满 | ✗ `shift()` 丢最旧（`bridge.js:11189-11197`） | 未覆盖（signal TTL + retry 队列，无"超时后去哪"的显式说明） | 两边都不够；我们的 TTL 过期是静默的 |
| c | **`mark_read` 跳过没交付的消息** | ✓ 夹到 `readThroughSeq`（`bridge.js:12073-12083`） | ✗ **夹到 `lastSeq`**（`ledger.mjs:100-110`） | **真丢消息**：她（或操作者）一句"标到最后一条"就把被 time 拦下的消息永久吞掉 |
| d | 会话忙 / 唤醒限频 | ✓ 暂存 20 条 + 回合后补发 + 延时重试 | 部分：`offer` 失败进 retry 队列；被 time/focus 拦下不推水位、等重放去重 | 我们靠"水位不动"兜底，没有"到点补发"的概念（因为 wake 只是 signal） |
| e | 定时器类唤醒被"未读已空"吞掉 | ✓ 显式特判 `TIMER_WAKE_REASONS`（`12562-12568`） | n/a（定时器归 time） | 旧踩过的坑，我们架构上绕开了；但 time 侧是否有等价保护未见文档 |
| f | 长定时器溢出（>2^31ms） | ✓ 100s 续期 + 每次用 `Date.now()` 重算（`12690-12702`） | time 侧未查 | 记录备查 |
| g | 投递失败把她扔进永眠 | ✓ 回滚 `wakeTimes` + 恢复 `sleepUntil` + 重排 timer | `blocked` 不推水位、`expired` 记数 | 我们不会永眠（没人有"睡眠定时器"），但会"静默停在积压里" |
| h | 多实例写同一状态 | ⚠ 指纹补丁 | SQLite 单写 | 我们更好 |
| i | 补课与实时重复投递 | n/a | ✓ 账本 `(activity,qq_id)` 唯一 + signal id 复用 `message_id` | 我们更好 |

### 3.4 一句话结论

**我们的"骨架"（账本/水位/signals/单一出口/可测）比旧项目干净；旧项目赢在"她被叫醒的那 200 个字"。**
所以不要把旧的唤醒矩阵搬回来，只搬 §4 那几段文本与一个游标上限。

---

## 4. 值得搬的最小项（按"第一感受 / 不丢消息"排序）

### P0（不丢消息，改动小、可单测）

1. **`mark_read` 夹到"已交付高水位"**（`ledger.mjs:100-110`，3~10 行）
   `deliveredAt` 已在行上（`ledger.mjs:49,66`），补一个 `deliveredSeq = max(seq where deliveredAt!=null && 连续)`，
   `through = min(requested, lastSeq, deliveredSeq)`，超界时在返回文案里说"还有 N 条没交付，标不动"。
   验收：造 3 条消息、只交付第 1 条，`mark_read` 不带参数 → 水位停在 1，`qq_unread` 仍报 2 条。
2. **`qq_status` 一屏说清三个数**：`lastSeq / deliveredSeq / attendedSeq` + 最近一次被拦下的原因（已有 `lastBlocked`）。
   现在只有"水位/最后/未读约 N 条"，看不出"卡在哪一层"。
3. **契约写明 delivered ≠ seen ≠ attended**，写进 `docs/QQ.md §7.7` 和 `qq_mark_read` 的 description。
   （旧的那句 `acceptance grants visibility, never acknowledgement`，`bridge.js:11246-11249`，可以直接借用措辞。）

### P1（第一感受，几乎全是文本/纯函数）

4. **唤醒正文自带"本次消息快照"**（搬 `buildWakeSnapshotV2` 的形状，`bridge.js:12099-12135`）：
   oldest-first、`wakeMessageLimit`（默认 12）、`wakeMaxChars`（默认 6000）、超预算给 `partial:true` + `readThroughSeq`，
   并写"以上消息已提供，无需重复查询；partial 时用 qq_unread(afterSeq=readThroughSeq) 继续读"。
   我们已有 `ledger.unread` + 信封，工程量主要在"拼一段 prompt 并保证不越过预算"。
5. **每个 wake 正文第一句写"原因"**（纯文案）：replyCheck → "你刚回过一条，回来看看有没有新回复"；
   nudge → "这几条还压着，等了 N 分钟"；proactive → "这边安静了一阵，你可以主动说点什么，也可以继续待着"。
   顺带保留旧的一句"**这不是对方刚发的新消息**"（我们 `docs/QQ.md:539` 已有类似约定，保持）。
6. **首回复静默窗口的"还差 N 秒"**（旧 `bridge.js:12228` 的 `remainingQuietMs`）：我们现在没有"回之前先等一小会儿"的概念，
   若 time/focus 有对应语义，就把剩余秒数算好写进 notice，别让她自己估。
7. **"对方可能没说完"**（`v2-wait.js`，13 行纯函数 + 4 个催话短句）：接在最新一条入站 signal 的正文尾部，作为软提示，不做硬规则。
8. **人格里加两行旧纪律**：反AI味那一句、不要习惯性潜水那一句（进 `prompts/persona.md` / `sim.md`，不进工具描述）。
   （`docs/PROMPT-CONTRACT.md` 的分层已经允许，属于"人格层"内容。）
9. **提示词禁调度词**（旧 v2 设计的禁用词表：核心/工作会话/租约/交回/handoff/上报/agent/子会话，`调度核心设计-v2.md:26`）：
   做成一个 grep 断言（`packages/core/test/*` 里扫 prompt 文本），比口头约定可靠。

### P2（要做，但要拍板）

10. **"收尾提醒"**：回合结束还没设下一步时补一句（旧 `buildWakeReminderPromptV2`）。我们对应 time 的"下一步"，需确认不重复造。
11. **沉睡前观察窗口**（旧 `preSleepWaitMs=5min` + `hasExplicitEndV2` 结束语白名单）：与 time 的睡眠语义会打架，
    应当映射成"睡前提案"而不是桥接定时器（`docs/QQ-GAP.md:109` 已给出这个判断）。
12. **空闲心跳**（旧 v2 的 20–45min + 自由活动清单）：如果要"她自己会找事做"，这是比再加一种 wake kind 更简单的抽象。

### 明确不要搬

- 8 种 per-conversation 唤醒触发器 + 概率修正链（不可预测、不可测）。
- `role-card.js` 的 `〔一代〕/〔二代〕` 模式标签人格卡。
- 58 个工具的面（含群/语音/文件/日程/托管）；需要时按 `docs/QQ-GAP.md` 的 P 级逐个加。
- 3 档以上权限/模式机/审批（旧已自证是死路：`dsh-qq-模式地图.md §4.1`，98 处引用不可达）。

---

## 5. 测试不足的证据（尤其"没有人测过她的感受"）

| 证据 | 出处 | 说明 |
|---|---|---|
| 全部测试"不需要 QQ" | `dsh-qq-使用说明.md:225-240` | 列出的 12 条命令全是离线/假模型；真实 QQ 只靠"实际跑通"这句话 |
| 真实 QQ 闭环未跑过 | `dsh-qq-调度核心设计-v2.md:250-254` | "真实 QQ 消息闭环尚未跑过（需在群里发一条消息验证 nudge→enter→status→reminder）" |
| 单会话限制长期无自动化测试 | `dsh-qq-审计报告.md:88` | 风险 3 自认；后来才抽 `session-slot.js` + 4 条用例 |
| 98 处引用的模式不可达、测试却全绿 | `dsh-qq-模式地图.md §4.1` | "审计 61/61、集成 31/31 全过"的同时，closed-agent 是一个进不去的房间 —— 证明**测试通过 ≠ 有人用过** |
| UI 测试本机跑不了 | `dsh-qq-审计报告.md:174` | `test-console-ui.mjs` 依赖 Playwright，未收录审计套件 |
| 没有任何测试断言唤醒提示词的内容 | 全仓 grep：`test-reply-wait`/`test-v2-wait`/`test-nudge`/`test-attention` 只测窗口与分支 | 没人测"她读到的那 200 字是否清楚、顺序对不对、有没有'原因'" |
| 连续性是人物库测试，不是阅读体验测试 | `scripts/test-continuity.mjs:1-15` | 测"同名不同号不合并"，不测"她看到这群人时是否分得清" |
| 当事人视角的验收只是"手工产物" | `权限测试-小千千千千问.txt`（9 行，她写"如果你看到这份文件…后半夜我在，有活喊我"）、`qq-workspace/小千千千千问-搬家测试.txt` | 这是**最接近"第一感受"的证据**：让她自己写、自己报告状态。有效，但不可重复、不可回归 |
| 我们这边同样缺 | `docs/REPLAY.md:75-93` 定义了 6 条当事人验收，但 `tools/replay.mjs` 是**记忆重建回放**（读 qq memory.db 生成 note），不是 QQ 五日记录 replay；QQ 测试 19+11+3+13 全是 fake；真实窗口只有 phase 0/1 各 1 次 | 也就是说：**我们比旧项目多的只是"fake 覆盖率"，不是"体验证据"** |
| 文档漂移 | `docs/QQ-GAP.md:79` 写"未做 `qq_mark_read`"，但 `index.mjs:1320` 已实现 | 漂移本身说明这条链没被"用"过多少 |

**建议的最小验收（比再加断言更像真实体验）**：按 `REPLAY.md §5`，用 3 段真实私聊（早/午/深夜各一段，脱敏）跑 replay，
产出 `transcript.md`：`时间 | 来源 | focus/time 状态 | 投递正文 | 她回/不回 | 积压数`，
然后只问一句话打分：**"如果我是她，这一刻我知不知道谁在说话、要不要回、错过了什么。"**
旧的教训是——测试全绿的时候，恰恰是没人问过这句话的时候。

---

## 附录：本文引用到的路径

旧（只读）：
`C:\DSH\qwenstuff\dsh-qq\src\bridge.js`（12045-12135 游标/快照、12199-12296 唤醒提示词、12308-12458 投递、
12541-12709 优先级/批窗/补发/潜水定时器、10407-10542 唤醒配置、10562-10583 每会话状态、11189-11197 队列丢最旧）、
`src\attention.js`、`src\nudge.js`、`src\v2-wait.js`、`src\core-scheduler.js`、`src\core-timers.js`、`src\session-slot.js`、
`src\persona.js`、`src\role-card.js`、`src\identity.js`；
文档：`dsh-qq-使用说明.md`、`dsh-qq-模式地图.md`、`dsh-qq-审计报告.md`、`dsh-qq-魔改设计.md`、`dsh-qq-调度核心设计-v2.md`、
`dsh-qq-记忆调度设计.md`、`dsh-qq-模型页交互设计.md`、`dsh-qq-模型中心.md`、`dsh-qq-路线图.md`；
手工产物：`权限测试-小千千千千问.txt`、`qq-workspace\小千千千千问-搬家测试.txt`、`.dsh-mc-agent\版本提示.md`。

现行（本仓库）：
`packages/plugins/qq/src/index.mjs`（工具 1173-1346、status 1102-1152）、`src\wake.mjs`、`src\ledger.mjs`、
`src\backfill.mjs`、`src\gate.mjs`、`src\humanize.mjs`、`src\outbound.mjs`、`src\reply-cache.mjs`；
文档：`docs\QQ-GAP.md`、`docs\QQ.md`（§7.7 水位、§7.9 唤醒矩阵）、`docs\REPLAY.md`、`docs\MESSAGES.md`、`docs\PROMPT-CONTRACT.md`。
