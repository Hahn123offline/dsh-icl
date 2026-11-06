# 旧项目（qwenstuff）记忆 / 调度 / 长期状态 · A/B 对照

> 只读研究。判据不是"功能更多"，而是**概念更少 / 状态更少 / 提示词更短 / 失败路径更清晰 / 可观测性更好**。
> 范围：`C:\DSH\qwenstuff` 下的设计稿与 memory/schedule 实现；对照 `C:\DSH\icl` 的 `packages/plugins/{memory,dream,recall,note,lexicon,focus,compaction}` 与 `packages/core`。
> 全文用 `路径:行号` 引用，不贴原文。

## 0. 先划定证据边界（很关键）

旧项目里"记忆/调度"有**三代互不兼容的实现**，而且最新一代的代码已经不在树里：

| 代 | 位置 | 形态 | 现状 |
|---|---|---|---|
| G1 | `dsh-qq/src/memory/*` | 5→6 张表（summaries+cues/facts/persons/media），docs 写得最全 | **实现已删**：`dsh-qq/src/memory/index.js:1-2` 等 7 个文件都只有 147–151 字节，是 re-export shim，指向 `focus-core/packages/memory/src/*` |
| G2 | `focus-core/apps/dsh-icl/src/{domain,loops,state}` | 收敛成 1 张 `memories` 表 + 事件表 + 焦点表 | 代码在，`focus-core/packages/` 目录**不存在**（全仓无 `class MemoryStore`），所以 G1 的测试 import 不到 |
| G3 | `qwenstuff/icl` | 现 ICL 的快照（≈2026-10-30） | 与 `C:\DSH\icl` 同源，可用于量增长曲线 |

含义：**G1 的设计细节只能从文档读，行为无法验证**；凡是依赖 G1 行为的主张，本文一律降级为"设计意图"，不当作已验证结论。

## 1. 旧设计的核心概念（能压到多短）

### 1.1 G1 记忆（`dsh-qq-记忆层设计.md`）

- 四层：短期窗口 / 中期"聊天回想"（summary + 召回线索 cues）/ 长期（facts+persons）/ 画像（`记忆层设计.md:15-20`）。
- 5 张表 + FTS：`summaries`、`summary_cues`、`facts`、`persons`、`assets`（`:87-176`）；向量存 BLOB、线性扫、不做 ANN（`:179`）。
- 写入：条数 ≥36 或空闲 30 分钟触发摘要；摘要提示词只要 `{summary, cues[], facts[], entities[], relations[]}` + 8 条规则（`:189-213`）。
- 检索四路：最近 / 回想 / 事实 / 画像（`:235-242`），RRF 融合，硬预算 1400/800/900 字符，余弦 <0.55 不注入（`:244-248`）。
- 明确不做：启发式自动召回（`:267-270`）、PPR 图传播、Episode、生命周期（`:39-46`）。
- 隐私：每表 `conv_key` + 三档"记忆完整"（off/shared/all，管理员私聊永远全通）（`:475-491`）。

### 1.2 G1 记忆调度（`dsh-qq-记忆调度设计.md`）

- 四层节奏 L0 吸收（无 LLM）/ L1 压缩（10 分钟扫、8 条且最老 6h 或 36 条）/ L2 追进度（30 分钟补课、每轮 ≤6 次 LLM）/ L3 做梦（深整理）/ L4 维护（`:28-77`）。
- 水位：`memory_jobs(id,type,scope_key,cursor,status,attempts,next_run_at,last_error)`，重启从 cursor 继续（`:79-93`）。**这一层从未落地**（全仓 grep 无 `memory_jobs`）。
- 自陈的四个问题：摘要靠消息量推动、画像挂在"3 条事实"上链路太长、没有追进度作业、做梦与追进度职责不清（`:19-24`）。

### 1.3 G1 调度核心（`dsh-qq-调度核心设计*.md` + `src/{attention,core-scheduler,nudge}.js`）

- 注意力 5 态 **派生**（不落盘）：`silent > sleep > group(有 lease) > own-time(核心在想) > idle`（`dsh-qq/src/attention.js:5-12`），新消息 → 4 种动作 `fast-path / nudge / queue / none`（`:21-30`）。整台状态机 = 58 行纯函数。
- lease 是唯一说话凭证；TTL 30 分钟、最长 60 分钟强制收回；**租约不跨重启**（`core-scheduler.js:6-10,56-57`）。
- 一个 state 对象装 7 个集合：`lease / queue / urgent / jumps / statuses / reminders / history`（`:13-24`），原子写单个 JSON（`:27-45`）。
- 离开不写 todo，写一份 **status**：`{summary, changes[], reminders[], pending[], recent}`（`调度核心设计-v2.md:119-141`），注入时改写成第一人称叙事（`:143-150`）。
- 迟到要求：**调度层给代码看，叙事层给角色看，两层永不混用词汇**，并给了禁用词表（核心/工作会话/租约/handoff/agent）（`:8-29`）。
- nudge = 全局批次提醒，5 个数字（soft 10m / hard 45m / cooldown 10m / maxPerHour 6 / batch 10s）（`dsh-qq/src/nudge.js:2-8`）。
- 人物记忆共享：3 档 none/identity/shared，两群取较严者，**唯一可见性判定函数** `noteVisibleIn`（`dsh-qq/src/social/memory-policy.js:1-23,63-70`）。

### 1.4 G2 的收敛版（`focus-core/apps/dsh-icl`）——本文认为最值得读的一代

- **1 张表** `memories`（kind/activity/subject/text/cues/pinned/from_ts/to_ts/origin/safe_text/sensitivity/weight/use_count/last_used/archived）+ `memory_vectors`，FTS 由 trigger 维护（`state/db.js:264-301`，注释在 `domain/memory.js:3-6`）。
- **1 个衰减函数** `strengthOf` 同时服务排序与 UI 档位（清晰/记得/有点模糊/几乎想不起来）（`domain/memory.js:385-403`），口径"**永不删除**，衰减只影响想起来的难易"（`:379-383`）。
- **2 个通道**取代原来的 note/nudge/push：`ambient`（攒窗、给模糊摘要）/ `pierce`（立刻给内容）；**一个 75 行纯函数**决定，输出 `{channel, suppressReason}`，只降级不丢弃（`domain/policy.js:1-11,32-73`）。核心规则一句话："分级只在她在某个活动里时成立——不在任何活动里时一切都能唤醒她"（`:48-50`）。
- 投递一律**先落一行 events 再裁决**：`level ∈ ambient|pierce`、`effective`、`suppress_reason ∈ stop|mute|sacred|budget|dedupe`、`dedupe_key` 唯一索引（`state/db.js:67-87`）。
- 焦点：`focus_leases` 用 `CREATE UNIQUE INDEX ... WHERE until IS NULL` 在 DB 层保证"同时只有一个进行中"（`db.js:56-65`）。
- 单会话占用：心跳 30s / 90s 判陈旧 / 同 session resume 直通 / 陈旧可抢占（`domain/session-claim.js:1-10,48-95`），只占 1 个 kv 键。
- 记忆整理：**60 秒 tick，一轮只处理一个活动**；失败按 scope 记 `{at,count}` 指数退避（上限 90 分钟）；模型超时给 600s（"中途 abort 会让本地服务卸载重载"）（`loops/summary.js:1-60`）。
- `shouldSummarize` 返回 `{due, reason}`，reason ∈ `too_few|nothing_new|too_soon|not_idle|idle`（`domain/memory.js:59-86`）——**"为什么没摘"本身是一等输出**。
- 长期状态只占世界块 2 行：`还在聊：「…」`（≤3 条）+ `你还想着要说：「…」`（≤2 条）（`domain/attention.js:234-243`），背后是 `threads` / `thoughts` 两张小表。
- 世界块收尾三行是**提示词纪律**，不是状态：`刚才放下了一些旧的东西（约 X token）`、`今天还能叫醒你 N 次`、`（这些是事实，可以自然引用…不用把这块的格式念出来。）`（`attention.js:247-252`）。
- `renderTail`：20–40 token 一行状态，**每条工具返回都可带**（`attention.js:274-289`），不需要模型额外调 status 工具。

## 2. A/B 对照表

"旧更少?" 一列：✅ 旧更少 / ❌ 旧更多 / ≈ 持平。

| # | 旧概念 | 现行概念 | 旧解决的问题 | 旧更少? |
|---|---|---|---|---|
| 1 | `memories` 单表 + kind（G2 `db.js:264-283`） | `mem_ns`+`mem_items`+`mem_vec` 三表、11 个命名空间、`registerNamespace`（`docs/MEMORY.md:30-46`） | 想加一种记忆不用改表 | ✅ 概念少（无命名空间注册表、无 recallable/halfLife 注册、无 owner）；但扩展靠插值 kind，质量靠约定 |
| 2 | 5–6 张表 + 独立 `summary_cues` 表（G1 `记忆层设计.md:114-134`） | 三表；线索概念消失，靠 `body/evidence` | cues 提高召回命中率 | ❌ 旧更多（一个概念一张表）。G2 已把 cues 降级成**同一行的文本字段**（`memory.js:129,228-244`）——这才是省状态的做法 |
| 3 | 召回三路并行：FTS(trigram) + 2 字滑窗 LIKE + 向量（`memory.js:214-244`） | 一路打分：`0.7cos+0.3bigram+0.5·exact`（`MEMORY.md:74-83`） | 中文专名/口头禅打不中 | ❌ 旧更多。**现行更好，本条不要搬** |
| 4 | 一个 `strengthOf` + 4 档中文标签（`memory.js:385-403`） | `decay×weight×sim` + boost +0.2 封顶 5（`MEMORY.md:80-92`） | 把"记得多清楚"变成可解释、可看 | ✅ 公式一样，旧多的是一个**只读投影**（label），不新增状态 |
| 5 | 永不删 + `pinned` + 手动归档（`memory.js:379-408`） | `archived` + `superseded` + 保留期清理 + `boost` | 衰减/遗忘不靠定时任务 | ≈ 布尔数一样；旧少一个"为什么要删"的策略面 |
| 6 | 可见性 4 概念：`origin`+`safe_text`+`sensitivity`+`memory_release`（`memory.js:260-287`、`db.js:163-169`） | `conv` 精确过滤 + `recallable` 白名单（`MEMORY.md:46,94`） | 跨场景只给脱敏版、临时放行 | ❌ 旧多 4 个状态换现行没提的需求。**不要搬**；但 G1 的 3 档 + `stricter()`（`memory-policy.js:24-58`）解决的是"跨群还是同一个人"，现行 `conv` 硬隔离答不了 |
| 7 | 每轮**一次**注入、阈值 0.55、预算 1400/800/900（`记忆层设计.md:233-248`），且明确"启发式召回不做"（`:267-270`） | `eager-recall` 每轮 `onTurn` 检索一次（minScore .5 / 2 条 / 200 字，`MEMORY.md:119-141`） | 不打扰、不撑爆 prompt | ✅ 旧把"每轮"收敛成"每次唤醒"，且没有第二个注入点 |
| 8 | 1 个工具 `memory_search`（auto/time/recent）+ 1 段 8 行提示词（`dsh-qq/plugins/qq-agent-presets/memory-tools.mjs:30-40`） | 记忆族 17 个工具（`remember/recall/forget/memo×4/note_status/lexicon×2/whois/focus×5/memory_export`，各插件 `src/index.mjs`） | 主动翻旧账 | ✅ 工具面小一个数量级；代价是旧**没有写入口**（写入全自动），现行必须有 `remember` |
| 9 | 注意力 5 态全部**派生**、0 个存储字段（`dsh-qq/src/attention.js:5-12`） | `time.json` 落 `phase/lock/spans/sleepingId/sleepUntil/pausedAt/inboxOffset/stats` 等 11 字段（`docs/TIME.md:55-71`） | 一眼看出"谁在活" | ✅ 旧把状态压成纯函数；现行 3 相位 + 正交锁 + 5 个 span 字段 |
| 10 | **唯一裁决点** `decide()`：2 通道、5 条降级理由、只降不丢（`policy.js:32-73`） | **两个闸门**：`focus.admit`（`packages/core/src/services.mjs:468-482`）+ time gate（`TIME.md:127-163`），理由分散成 `no-focus/same-focus/sacred/privileged/focus-pierce` 与 `paused/sleeping/muted/muted-quota` | "这条消息以什么强度进来"只有一个答案 | ✅ 本文最重要的一条：决策点 2→1，理由 9→5，75 行可穷举测试 |
| 11 | 离开写 `status{summary,changes,reminders,pending}` + 叙事化注入（`调度核心设计-v2.md:119-150`） | `time` 的 `goals{theme,until,turnLimit,resumeLimit,resumes,focus,...}` + `wake` 简报（`TIME.md:64,15.3`） | 跨回合"我刚才在干什么" | ❌/✅ 混合：旧 4 字段 1 个结构；现行 goals 有 9 字段。但现行 goals 是"持续目标"，旧没有等价物（旧用 reminders 拼） |
| 12 | nudge 引擎 5 个数字 + 批次窗口（`nudge.js:2-8`） | `awakeTick` 心跳 + `focus.backlog` + `time_status`（`TIME.md:410-530`） | 积压不重复提醒、不刷屏 | ≈ 数字差不多；旧多一个"按批次去重"（`lastDeliveredVersion`），现行靠 focus 释放时一次性投递 |
| 13 | 单会话 claim：1 个 kv 键 + 30s 心跳 + 90s 陈旧抢占（`session-claim.js:1-95`） | 无（靠 DSH 单会话 + delivery 队列） | 两个会话同时活着 | ✅ 旧 1 键 3 规则；但现行没有这个需求面，**不建议照搬**，可参考"陈旧即让位"的兜底 |
| 14 | dream 三任务（合并/冲突存疑/画像重写）+ dry-run + `batch_id` + `memory_history` 整批回滚（`B5设计:88-120`） | dream 7 job 串行 + `run:<day>:<job>` 账本 + `force`（`MEMORY.md:152-165`；`dream/src/index.mjs:362,430`），**无 dry-run / 无回滚 / 无冲突** | 自动整理敢开、错了能退 | ❌ 旧多 2 张表 + 2 个参数；现行 7 job 里前 4 个是"抽取"，回滚价值低于旧（旧是合并/删除型写） |
| 15 | 做梦**不设开关/时间**，触发归日程表（`审计报告.md:245`） | dream 同时订阅 `signals sleep-start` + time 的 `dream:nightly`，文档自承"三条触发之间没有互斥"（`MEMORY.md:155`） | 少一个调度面 | ✅ 旧把触发收在 1 处；现行 2 处 |
| 16 | 梦按 `(会话,日期)` 水位注入一次、中午过期、默认关（`调度核心设计.md:101-107`） | dream 只写库不注入（回执另行） | 梦被看见一次、不重放 | ≈ 状态数一样（1 水位）；旧多"过期"这条规则 |
| 17 | `threads` + `thoughts` → 2 行世界块（`attention.js:234-243`；`domain/threads.js` 23 处引用） | 无对应物 | 跨回合不断线的"还在聊/想说没说" | ✅ 2 张表 + 2 行 + **0 次 LLM** |
| 18 | `renderTail` 一行状态，附在每次工具返回（`attention.js:274-289`） | 需要调 `time_status`（`TIME.md:205`） | 模型永远知道"现在几点、我在干什么" | ✅ 省掉一整类状态轮询调用（实测同参数 `mcb_status` 125 次，`COMPLEXITY-AUDIT.md:35`） |
| 19 | 60s tick、一轮一个活动、per-scope 失败退避、600s 超时（`loops/summary.js:1-60`） | dream 由 sleep 信号触发、7 job 串行、整体 try/catch、晚启动"最多错过当天"（`MEMORY.md:155`） | 记忆整理不依赖"她今晚睡不睡" | ✅ 追进度语义只值一个循环；退化路径有 `count` 可查 |
| 20 | `memory_jobs` 作业表 + cursor（`记忆调度设计.md:79-93`） | `recall-cursor` 行 + `dream-run` 账本 | 重启不重烧模型 | ❌ 设计稿纸面概念，从未实现；现行两种水位已够 |
| 21 | 旧记忆族代码 ≈86.6 KB（`focus-core/apps/dsh-icl/src/{domain,loops}` 中 8 个文件 + summary loop） | 现行记忆族 ≈169.7 KB（9 个插件 `src/index.mjs`） | — | ❌ 现行是旧的 2 倍；且 `time` 从快照 27 KB 涨到 126.7 KB（`qwenstuff/icl` → 现仓） |

## 3. 值得搬 / 不值得搬

### 3.1 值得搬（按性价比排序）

1. **唯一裁决点**（`policy.js:32-73`）。
   理由：现行两个 gate（`focus.admit` + time gate）意味着"一条消息为什么没到"要在两处查、两套 reason 拼。旧的 `decide()` 是纯函数、2 个输出、5 条 reason，可以写穷举测试；降级不丢弃（pierce→ambient）天然保证"消息不会消失"。**概念 −1、失败路径 −1 层。**
2. **`renderTail` 一行状态**（`attention.js:274-289`）。
   理由：把"我现在在哪、还剩多久"从**工具**降级成**每轮可见的字节**，省掉一整类 status 轮询（实测 `mcb_status` 125 次/同参数）。20–40 token，不新增状态。
3. **`shouldSummarize` 返回 `{due, reason}`**（`memory.js:59-86`）。
   理由：现行 dream 的 skip 只有 `already-ran/no-raw/…`，没有"为什么今天没整理"的第一等答案。加一个 reason 枚举 = 加可观测性、不加状态。配合 60s tick + 一轮一目标（`loops/summary.js`），把"记忆整理"从"睡不睡"里解耦。
4. **`strengthOf` 一个函数 + 4 档中文标签**（`memory.js:385-403`）。
   理由：现行有 `decay` 但只有数字；旧多的是给人看的投影（清晰/记得/有点模糊/几乎想不起来），对排查"她为什么想不起来"极有用。**零新增存储**。
5. **`threads` + `thoughts` 两行**（`attention.js:234-243`）。
   理由：现行长期状态只有 `time`（日程）和 dream 产物；"上次聊到哪 / 有句话还没说"完全靠 recall 撞运气。2 张表 + 2 行 + 0 LLM 是这件事的最便宜实现。
6. **叙事层 / 调度层 词汇隔离 + 禁用词表**（`调度核心设计-v2.md:8-29`）。
   理由：这是**缩短提示词**的手段（禁用词 + 允许词是 2 行契约），而不是增加段。现行 focus 已用"专注空间"叙事，但 `time` 仍以 `goal/span/schedule` 直接见模型。
7. **一个 tick 一个目标 + per-scope 退避**（`loops/summary.js:22-60`）。
   理由：现行 dream 7 job 一轮跑完，任一 job 抛错整轮不算成功（`MEMORY.md:153`），没有"这一轮只修一个"的预算观。旧的做法让失败可局部重试。
8. **（条件性）dream 的 dry-run**（`B5设计:115-120`）。
   理由：只值得做"返回将写多少行"的只读 dry-run；**整批回滚不建议**——现行 dream 是抽取型写入（新增为主），回滚价值低而 `memory_history` 表成本高。

### 3.2 不值得搬

| 项 | 理由（复杂度判据） |
|---|---|
| `facts` 表 | **旧自己删了**：上线 2 天后判定"不参与召回/聊天，产出多为碎片，冗余"，DB v3 `DROP TABLE facts`（`审计报告.md:248-253`）。现行把 facts 放进 person 块 `data.facts` 已是同一结论的更低成本形态 |
| `memory_release` / `safe_text` / `sensitivity` | 3 个概念换 1 个"跨场景脱敏"需求；现行没有这个需求，`conv` 硬过滤状态更少（`MEMORY.md:94`） |
| `memory_jobs` 作业表 | 纸面概念，从未落地；现行 `recall-cursor` + `dream-run:<day>:<job>` 两种水位已覆盖"重启不重跑" |
| L0–L4 四层节奏 | 只是给一个循环起了四个名字。真正有效的部分（一个 tick、一次一个、有预算、有退避）可以压进 1 个循环（见 §3.1-7） |
| 5–6 张表 + 独立 cues 表 | 现行三表 + `evidence` 更少；G2 已证明 cues 可以只是同一行的一个文本字段 |
| 三路召回（FTS + 2 字滑窗 + 向量） | 现行一路打分公式已把 bigram/exact 吸收进去；三路并行是 3 套阈值与 3 种"为什么没召回" |
| 每日叫醒预算（`DEFAULT_PUSH_BUDGET=12`，`policy.js:75`） | 与 `time` 的 heartbeat/quota 语义重叠，两处计数必然对不上 |
| 单会话 claim（`session-claim.js`） | 现行没有"两个会话同时活"的需求面；只有"陈旧即让位"这一条兜底值得抄 |
| dream 整批回滚 + `memory_history` | 2 张表 + batch 语义，换现行抽取型写入的低价值回滚（见 §3.1-8） |
| 5 态注意力状态机 | 5 个态里 `group/own-time` 由 lease 有无推出，实际只有 3 个独立态；现行 `phase(3) × focus(有无)` 已等价 |

## 4. 旧项目里明确的失败 / 测试不足证据

1. **审计门禁完全不含记忆与调度**：`audit-out.txt` 的 `Running …` 列表共 60 个脚本，逐个看——`test-memory-decay / test-memory-dream / test-memory-light / test-attention / test-core-scheduler / test-schedule / test-nudge` **一个都没有**。而 `dsh-qq/scripts/` 下这些文件真实存在（98 个 `test-*.mjs`）。结论：记忆/调度层从未进过回归门禁。
2. **这些测试也跑不起来**：它们 import `../src/memory/store.js`（如 `scripts/test-memory-decay.mjs:1-8`），而该文件是 147 字节 shim，re-export 自 `focus-core/packages/memory/src/store.js` —— 该路径不存在（`Test-Path focus-core\packages` = False；全仓无 `class MemoryStore`）。**现存记忆测试是死文件。**
3. **覆盖率陈述与门禁不符**：`审计报告.md:234` 与 `:254` 写"审计套件 70/70"，而 `audit-out.txt` 结尾是 `Audit suite: 57/60 scripts passed.`，其中 1 个真实失败是 `test-control-center.mjs`（迁移前必须先停 SnowLuma）。数字对不上，且 70 个里也没有记忆脚本。
4. **结构反复被自我否决**：G1 从 6 张表 → 5 张 → DB v2 加 `weight/use_count/archived/pinned/conflict_group` → **DB v3 直接 DROP facts**（`审计报告.md:229-253`）。三轮迁移、两套矛盾（B5 §7 一次列了 5 个"需要你拍板"，`B5设计:160-168`）。
5. **实现被删但文档留着**：`记忆层设计.md:369-430` 详述 P1/P2 的 6 个文件职责与 `13/13`、`9/9` 测试；这些文件已不存在。**文档可信度是最贵的隐性成本**。
6. **模型侧失败（真实踩坑，值得当验收用例）**：加 `max_tokens` 后推理型模型把预算烧在 reasoning 上、`content` 返回空；高负载时画像重复同一句；画像要跑几分钟（`记忆层设计.md:425-427`）。CLIP 服务"假活"挂 60 秒；QQ 图 URL 带 rkey 过期不可补向量（`:602-604`）。历史回填时日志里**没有 conv_key**，只能靠工具参数里出现最多的 `group:*` 猜（`:508-512`）。
7. **调度层自陈的四个结构性毛病**（`记忆调度设计.md:19-24`）：摘要靠消息量推动、低流量会话等 6 小时、画像链路"事实→摘要→画像"太长、做梦与追进度混在一起。这四个问题在现行 ICL 里换了形状但没消失：`MEMORY.md:155` 承认 dream 只在 sleep 时跑、晚启动就漏当天。
8. **旧项目的死代码规模**（旁证，非本范围）：`closed-agent` 98 处引用但"没有任何路径能进去"，`approval` 66 处死分支；`mode-control.js` 从 545 行删到 170 行（`模式地图.md:69-96,203-206`）。说明这个项目最大的成本不是缺功能，而是**留着的概念**。
9. **现行侧的对照读数**（用来防止"越搬越多"）：`COMPLEXITY-AUDIT.md:12` —— 一轮 48 个工具、29,045 字符 schema；`:44` —— 31 个工具 120 分钟内 **0 调用**（含 `memo/memos/note_status/memory_export/focus` 全族）。搬任何东西之前先问：**它会让这 31 个里多一个吗？**

## 5. 一句话结论

旧项目真正"降低复杂度"的东西只有三类，且都不在它的记忆表结构里，而在**裁决层**（`policy.js` 75 行 / 2 通道 / 唯一裁决点）、**可见层**（`renderTail` 一行、`threads`+`thoughts` 两行、`strength` 四档标签）、**循环层**（60s tick、一轮一个、`{due, reason}`、per-scope 退避）。它的表结构（5→6→v3）和被删掉的 `facts`、`memory_jobs`、三路召回、三档共享，都是"功能更多"而不是"概念更少"，不要搬。
