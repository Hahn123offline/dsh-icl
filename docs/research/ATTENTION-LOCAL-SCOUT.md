# 本机「注意力 / 主动性」实现与设计盘点

> 调查员：local-scout（子代理），时间：2026-11-14 17:55–18:40（Asia/Hong_Kong）。
> 方式：**只读**。未修改任何项目代码；本文件是唯一写入（`.state/` 下）。
> 证据等级：`文件:行` = 亲自读过；「未证实」= 只看到线索、未读到实现或未运行验证。
> 工作目录 `C:\DSH\icl`（master `e7c3979`，2026-11-14）。

---

## 本机项目清单

在 `C:\DSH`、`C:\Users\ai_admin`、`C:\MaiBot`、`C:\scene2` 及桌面/文档/下载目录按目录名
（focus/qq/icl/companion/agent/her/mcp）与内容（`focus-core` 字面量）扫过，命中的相关项目如下。
其它 `C:\DSH\{design,unlock,her,ai_mc,mc,dshVideo,vid2scene,...}`：读目录后判断与注意力层无直接关系
（`her` 只有 `notes`，`unlock` 只有 reports/work，`ai_mc` 是 MC agent harness），**未证实**有主动机制，未深读。

| 路径 | 用途 | 技术栈 | 含注意力机制 | 可读/状态 |
|---|---|---|---|---|
| `C:\DSH\icl` | **当前 ICL 仓库**（master `e7c3979` 2026-11-14，994 commits） | Node ESM monorepo，DSH 宿主 + 插件包（`packages/core`、`packages/plugins/*`、`packages/dsh-icl`） | 是：`focus` `time` `qq` `rhythm` `dream` | 可读；`git status` **干净** |
| `C:\DSH\icl-wt\*` | 同一仓库的 11 个 git worktree（`bili/cache/mc-body/mc-lab/mc-link/misc/paths/qq/redteam/sandbox/time`，`git worktree list`） | 同上 | `wt/time` 有 time 旧版；`wt/qq` 落后 master | 可读；多数分支**落后或已合并**（`git log master..wt/time` 空） |
| `C:\DSH\qwenstuff\focus-core` | **旧 ICL**（项目名 dsh-icl，本文多处引用的 "focus-core"） | Node ESM + HTTP router + SQLite（`apps/dsh-icl/src/{domain,loops,routes}`），`node --test` | **是，且最完整**（focus/policy/attention-window/selfwake/continuation/nudge 雏形） | 可读，**独立 git 仓库** master `3659061`（2026-11-01）。该 commit 同时存在于 `C:\DSH\icl` 历史中 → 本仓库是它的延续/分叉点 |
| `C:\DSH\qwenstuff\dsh-qq` | QQ bridge（`qq-bridge` v1.0.3，DSH 0.2.0-rc.2） | Node（CJS/ESM 混合），`src/bridge.js` **812 KB / 14,279 行**单体 | **是**：`src/{nudge,core-scheduler,attention,core-timers,schedule}.js` + bridge 内 idleHeartbeat / proactiveCheck / 潜水唤醒 | 可读；git `main` `211af49`（2026-10-21）；部署配置 `config.json` 显示 `core.enabled=true`、`socialV2.proactive.enabled=true` |
| `C:\DSH\qwenstuff\icl` | 更早的 ICL 快照（2026-11-03） | 同上 monorepo | 只有 `time`/`rhythm`，**无 `focus`/`qq` 插件** | 可读，被 `docs/MODERNIZATION-CANDIDATES.md:13` 标为已过期 |
| `C:\DSH\qwenstuff\{dsh-qq-mod,qq-workspace,_ref}` | dsh-qq 的补丁/工作区/参考包 | — | 否 | 可读，无关 |
| `C:\DSH\qwenstuff\focus-core\node_modules\@qwenstuff\*` | 旧 monorepo 的 workspace junction（`focus-core`/`memory`/`qq-transport`…） | junction | 目标 `focus-core\packages\*` **已不存在**（悬空链接） | 见 `docs/MODERNIZATION-CANDIDATES.md:12` 同结论 |

运行态（`Get-Process node`，2026-11-14）：只有 SnowLuma（QQ/OneBot 传输，`Downloads\SnowLuma-v2.1.1-win-x64-lite\index.mjs`）
与 `dsh-qq\src\mcp-web-search-safe.js`；**旧 focus-core app 没有在跑**。启动文件夹里也没有 `dsh-icl.lnk`
（`dsh-qq` 的 preflight 会检查它，`packages/plugins/qq/tools/preflight.mjs:250`）。

### 关键血缘事实

- `C:\DSH\qwenstuff\focus-core`（226 commits，HEAD `3659061` 2026-11-01）与 `C:\DSH\icl`（994 commits，
  首个 commit 是 `bb5e7df feat(M0): core adapter skeleton…`）**没有共享 commit**：`git cat-file -t 3659061`
  在本仓库报 `Not a valid object name`（已核实）。两者的关系是 **"旧实现 → 写设计稿 → clean-room 重写"**：
  focus-core 的最后一个 commit message 就是 "assess the ICL.txt clean-room design and propose the new architecture…
  Includes the proposed repo layout, four contract sketches (focus/delivery/slots/prompt), M0-M4 milestones"，
  而 `C:\DSH\icl` 从 M0 骨架重新开始。所以旧实现只能当**语义参考**，不能当可 cherry-pick 的上游。
- 当前仓库代码里仍引用旧路径：`packages/plugins/qq/src/{attention-window,debounce,humanize,normalize,rich}.mjs` 头注释、
  `docs/FOCUS.md:7`（设计原稿指向 `C:/DSH/qwenstuff/focus-core/DESIGN-activity-focus.md`）、
  `config/icl.local.json` 的 `persona` 指向 `C:/DSH/qwenstuff/focus-core/大肥鱼-QQ人格卡.md`。

---

## 旧实现要点

### A. focus-core（旧 ICL，`C:\DSH\qwenstuff\focus-core`）

| # | 机制 | 决策输入 | 调度方式 | 出处 |
|---|---|---|---|---|
| 1 | **Activity/Focus 概念契约**：焦点=租约，"同时最多一个"、"只认显式工具调用"、"别处事件进积压" | 模型 `focus_enter/leave`；管理员强制；停机 | 事件表 `events` 先落库再裁决（`effective/suppress_reason`） | `DESIGN-activity-focus.md:138-146`（硬约束）、`:345-370`（events 表）、`:174-187`（policy 伪码） |
| 2 | **三级投递 note / nudge / push** → 落在三个不同机制（积压 / 动态上下文快照 / `sessions.prompt` 新建 turn）；nudge 带 TTL 30min、超时按 `escalate` 升级或退回 | 事件级别、focus、静音、停机、principal、每日预算 | 无独立定时器：`note` 进表，`nudge` 下次装配可见，`push` 立刻 | `DESIGN-activity-focus.md:44-63`；**当前仓库没有实现这三级**（见「不要照搬」） |
| 3 | **policy.decide 单一裁决点**（75 行纯函数，7 道闸门） | `intent(ambient/pierce)`、source（schedule/timer 视为闹钟）、focusActivity、focusInterruptible、principal.canWake、mute、stop、budgetLeft、mutedGroups、mention | 写库时同步裁决；不投递 | `apps/dsh-icl/src/domain/policy.js:12`（两通道）、`:32-73`（闸门顺序：stop→无 focus→闹钟→群静音→mute→sacred→budget）、`:75`（`DEFAULT_PUSH_BUDGET=12`） |
| 4 | **per-activity 自适应窗口**（"太忙积压、不忙秒回"） | 该活动最近 5s 到达条数 `rate`、本批 `count`、`firstAt`、`force` | 纯函数；由投递循环每 5s 调用 | `domain/attention-window.js:11-16`（`RATE_FAST=5`，ambient 10min/20 条，pierce 60s/5 条）、`:24-51` |
| 5 | **投递循环**（pierce 具体内容 / ambient 摘要 / 成批静默窗口 / 等 `qq_wait` 期间不重复投 / 失败退避 60s） | `turn_active`、`qq_wait:<activity>`、`force_flush`、每 target 最后到达时间 | `setInterval(5_000)` 的 waker；`main.js:166-185` | `domain/wake.js:122-207`（成批 `148-175`）、`loops/qq.js:23-57`、`loops/maintenance.js:7-33`（timer 15s / schedule 30s） |
| 6 | **ambient 改为只拉不推**（2026-10-31 决议） | — | 投递循环直接返回 `skipped: 'ambient_is_pull'`，只在世界状态报数 | `domain/wake.js:204-206` |
| 7 | **目标自持 continuation**：她停下但 goal 未完成时用她自己的话提醒 | `focus.goal/exitCondition/goalUntil`、`lastTurnEnd`、已续推次数、`stalled` | 首次 90s；退避 3/10/30 min；最多 5 次后 `stalled` 不再自动叫 | `domain/store.js:215-248`；`domain/wake.js:264-319`（提示词 `continuationText` 266-282，最后一条说"这是最后一次自动提醒"） |
| 8 | **常驻自醒 selfwake**（"没人叫时自己醒一下"） | **活跃度档位** `off/low/normal/high`（默认 `low`=2–4h）、`hasFocus`、`lastTurnEnd`、每小时上限 | `setInterval(60_000)` 循环；写一条 `pierce` 事件交给投递层 | `domain/selfwake.js:14-31`（档位表）、`:53-65`（闸门：off/focused/not_due/just_spoke<90s/hourly_cap）、`:74-79`（**提示词原文**）；`loops/world-and-self.js:29-96`（去重：已有一条未投递自醒就不再堆 `73-77`） |
| 9 | **静默门 pending_leave**：登记"等安静再走"，安静够了**系统替她离开 focus**（`declaredBy:'system'`） | `qq_last_in:<activity>`、`quietMs`（默认 5min） | 同上 60s 循环 | `loops/world-and-self.js:47-60` |
| 10 | **叫醒预算**：每天 12 次 push，超了降 nudge/ambient 但仍记录 | 当日 push 计数（env `FOCUS_PUSH_BUDGET` > `rhythm.pushBudgetPerDay` > 默认 12） | `store.pushBudget` | `policy.js:67-70`、`:75`、`store.js:290-299`；旧 repo 自己的 commit `34aed46` 记录过"预算误挡了所有投递（`qq.delivery.skipped budget`）"，之后 `qq-delivery.js:85` 只剩 `void pushBudget`（投递层不再看预算）；**当前仓库已完全没有这个预算概念** |
| 11 | **世界状态注入**（每轮唯一数据源）：焦点/目标/闹钟/别处积压/静音/上下文占用/在聊话题/没说出口的话/世界里多久没动手 | focus、timers、backlog、nudges、mute、stop、context_usage、threads/thoughts、mc kv | 每轮装配（`systemPrompt.context`），标注"系统注入，不是对方说的话" | `domain/attention.js:11-36`（buildAttention）、`:149-254`（renderWorld）、`:234-243`（threads/thoughts 两行）、`:278-308`（renderTail 一行） |
| 12 | **节奏参数集中**（batchQuiet 6s / mention 3s / hold 20s / talking 10s / wait 12s+45s / budget 12/day / conversationTtl 5min） | `settings.rhythm` | 纯参数，无调度 | `domain/rhythm.js:10-31`、`:49-61` |

旧项目的"系统要不要说话"提示词（**旧版最值得读的一段**）：

- `plugins/dsh-icl/prompts/qq.md:3-6`：「群聊不是任务队列——不需要把每条未读都看完、都回应…
  **被叫醒只是一个"可以参与"的机会，不是一次必须发言的传唤**。」
- `domain/selfwake.js:74-79`（自醒文案）：「【自醒】你自己醒了一下（不是有人叫你）。看一眼：有没有人在等你…
  想做什么都行；什么都不想做也可以——那就继续沉默，没人会因此觉得你失礼。」
- `domain/wake.js:96` pierce 尾巴：「（你可以继续手上的事，也可以转场；不必立刻回。）」

### B. dsh-qq（旧 QQ 桥，`C:\DSH\qwenstuff\dsh-qq`）

| # | 机制 | 决策输入 | 调度方式 | 出处 |
|---|---|---|---|---|
| 1 | **nudge 积压引擎**（旧版最完整的"轻推"） | 每个会话 `count/mentioned/firstAt/lastText`、等待时长分级 level1-4、`version` 版本号去重、`cooldown`、每小时 6 批预算 | 纯引擎；`batch()` 由桥按 tick 调用，`markDelivered` 记版本 | `src/nudge.js:3-9`（soft 10min / hard 45min / cooldown 10min / 6 per hour / batchWindow 10s）、`:89-109`（due 判定）、`:112-123`（版本去重）、`:145-153`（digest 文案，含"不处理也可以，但优先看被提到的"） |
| 2 | **core-scheduler 租约状态机**（同一时刻只有一活跃会话，lease 30min / max 60min，过期强制收回） | `enter/leave/expire`、queue、urgent、jumps、reminders、statuses | 纯状态机 + `saveState()`；租约**不跨重启** | `src/core-scheduler.js:6-10`（`enabled:false` 默认）、`:89-102`、`:145-165`；部署 `config.json` 里 `core.enabled:true` |
| 3 | **idleHeartbeat 空闲心跳**（"你现在没事做，自己决定做什么"） | `core.enabled`、idle 配置（20–45min 随机、1/h）、busy（lease/queue/reminders）、睡眠、silent、thinking | `setInterval(60_000)`；无空闲才叫 | `src/bridge.js:10180-10202`，唤醒文案在 `:10199`：「你现在没事做。可以翻记忆、看红点、排闹钟、刷内容、写状态，也可以继续发呆。」 |
| 4 | **proactiveCheck 主动机会**（群/私聊安静后掷骰子主动冒泡） | 间隔 30–90min 随机、`idle≥15min`、基础概率 0.3–0.4；**修正链**：夜 23–8 ×0.3、刚回过 <30min ×0.5、1h 内自己发 ≥5 ×0.3、有 pendingThoughts ×1.4；`isConversationBusy` | 每会话 `setTimeout` 自我重排；`enabled:false` 直接不排 | `src/bridge.js:12718-12750`（数值 `12725-12743`）、部署 `config.json` `socialV2.proactive.enabled:true`、间隔 `1800000/5400000`、idle `900000`、概率 `0.3` |
| 5 | **唤醒 reason → 提示词**（每个 reason 一句生活化原因 + 行动前自检） | reason ∈ bootstrap/timeout/replyCheck/proactiveCheck/poke/memberJoin/ownerRelay/… | 拼进唤醒 prompt | `src/bridge.js:12273-12295`；**【积极性】**一行在 `:12226`；**【主动机会】**分支在 `:12282-12283`（"群里已经安静了一段时间，这是一次你可以主动冒泡的机会…只要内容自然，就大胆开口；如果实在没话想说，再安静收尾"）；默认分支 `:12295` 有"【行动前】先判断：群里在聊什么？…你有没有真正想说的？" |
| 6 | **潜水/有限唤醒配置（模型自设）**：`qq_set_wake_config` | model 设 `mode(active/diving)`、时长、triggers（@/名字/关键词/提问/拍一拍/指定人/概率） | 每会话 `sleepTimer` + 触发评估 `evaluateWakeTriggerV2` | `config.json` `socialV2.wake`（`defaultMode:diving`、`recommendedProbability:0.05`、`preSleepWaitMs:300000`、关键词表）；`bridge.js:6195-6300`（写配置）、`:10407-10542`（默认/触发键） |
| 7 | **注意力状态机（纯函数）** | `coreEnabled/lease/sleeping/silent/thinking` | 消息到达时查 `messageDecision`：fast-path / nudge / queue | `src/attention.js:5-12`（5 态）、`:21-30`、`:40-57`（urgent 关键词+owner 私聊+@） |
| 8 | **忙时暂存 + 回合后补发** | 消息类按 unread 里是否还有该 seq 判；定时器类（timeout/replyCheck/proactive/bootstrap/admin）与水位无关，proactive 过期直接跳过不补 | 回合结束回调 | `src/bridge.js:12553`（`TIMER_WAKE_REASONS`）、`:12636-12654` |

旧项目自己的复盘（已经写明这些是反模式，别再抄一遍）：

- `C:\DSH\icl\docs\OLD-QWENSTUFF-QQ-UX.md:102-118`：旧实现有 replyCheck + proactiveCheck + sleepTimer +
  rateLimitRetryTimer + turnSlotRetryTimer + pendingWakeTimer **5–6 个定时器 + 4 个概率乘数**，
  "她自己（和操作者）都无法预测下一句什么时候来"；旧项目 v2 自己把它收敛成**一条 20–45min 空闲心跳 + 一张自由活动清单**。
- `C:\DSH\icl\docs\MODERNIZATION-CANDIDATES.md:36`：「旧 proactive 多定时器 + 概率乘数链…**不搬**」；
  `:33` 明确把「5 态注意力机」列进「不搬」。
- `C:\DSH\icl\docs\QUALITY-INTERFACES.md` 与 `docs/QQ-GAP.md:102-115` 是迁移前的 gap 表（**部分已过期**：表里写"❌ 无"的 replyCheck/proactive/nudge，现在 `qq/src/wake.mjs` 已实现）。

---

## 当前仓库原型要点

### focus（注意力空间 / 租约）

| 项 | 实现 | 出处 |
|---|---|---|
| 服务层租约 | `enter({label,owner,reason,ttlMs,pierce,title,kind,interruptible,goal,exitCondition,expectedMinutes})`；`current()` 取**最新未过期**；`list()`；`release()` | `packages/core/src/services.mjs:521-579` |
| 穿透规则 | `resolvePierce`：`always/mention/never` + 结尾 `*` glob；`canPierce(label,{mention})` | `packages/core/src/contracts.mjs:29-60`；`services.mjs:580-585` |
| **投递裁决 `focus.admit`** | 顺序：①`ambient` 且非 privileged/无 mention → **不投递**（`reason:'ambient'`）②无 focus→全穿 ③privileged（`from==='time'` 或 tags `admin/alarm`）→穿 ④`interruptible:false`→`focus-sacred` ⑤同 label→穿 ⑥pierce 规则 | `services.mjs:586-612` |
| 积压 | 按 `signal.focus` 分桶；每桶 `{count,oldestAt,lastAt,lastText,items≤20}`；item 里保 QQ `(activity,seq)` 供回执 | `services.mjs:613-631`；`drainBacklog(filter)` `:635-643` |
| 持久化 | `snapshot()/restore()`（租约+积压，version 1） | `services.mjs:648-700`；线上文件 `~/.dsh/icl/state/focus.json` |
| 插件的模型工具 | `focus_status / focus_enter / focus_leave / focus_backlog`；enter 内部先 `leave()`（模型侧一次只留一个）；activity 缺省时 MC 在线→`mc`，否则 `auto:act:<slug>` | `packages/plugins/focus/src/index.mjs:66-99`、`:129-176` |
| 提示词段 | `order:875`，上限 200 字符；只给"你现在在：…/别处积压 +N"；分钟数按 5 分钟取整（保护前缀缓存） | `focus/src/index.mjs:14-17`、`:101-120`、`:179-188` |
| 宿主接线 | `signals.setDeliver` 先问 focus，拦下就 `focus.defer` 并回 `{queued:true}`；focus 变化时把 backlog 合成一条摘要 `signals.offer`（进群焦点只回放该群） | `packages/core/src/host.mjs:40-74`、`:78-101`、`:143-147` |
| 语义边界 | `focus` 是信号上的**字段**，不是路由 `to:'focus'`（已删）；拦下的不算 delivered | `packages/core/src/signals.mjs:7-8`、`:189` |

### time（睡眠 / 清醒节拍 / 心跳 / goal）

| 项 | 实现 | 默认 | 出处 |
|---|---|---|---|
| 主 tick | `tickMs` 默认 15s | 15s | `packages/plugins/time/src/index.mjs:629` |
| **awakeTick（清醒节拍）** | 触发条件：`phase==='awake'` 且无 `lock`(mute)；**focus 默认不抑制**（`duringFocus !== false`，即专注时照样自检，`docs/TIME.md:444`）；turn-end 后 idle 再发一条"继续"；`maxPerHour` 软上限→降频 `cappedSec`，前 30min 最多 3 条短提示；immediate 模式 1s 精度 + 20 次后退避 30s | **`enabled === true` 才开，即默认关**（`awakeTickEnabled` = `awakeCfg.enabled === true`） | 配置 `:651-675`（`duringFocus` `:674`）；实现 `:1067-1147`、`:1232-1313`；文案 `:1232-1240`（"清醒节拍：距上次回合结束 N 秒[；积压 N 条][；目标 g-…]。继续。"） |
| **heartbeat（全局兜底心跳 v2）** | 模型只设**频率** `frequency∈[0.01,1]`；间隔 = `uniform(10min,20min)/f`；只在 turn-end 后计时、在飞回合绝不触发；**span/goal 活着时暂停**，mute 不暂停；心跳正文自带 `time_status`+世界+积压预览 | **无开关，永远在**；默认 `f=0.2` → 约 50–100min 一次 | 配置 `:676-699`；`heartbeatInTurn/Suppressed` `:1154-1163`；`heartbeatDelayMs` `:1165-1168`；`maybeHeartbeat` `:1202-1230`；文案 `heartbeatMessage` `:1188-1200`；设计 `docs/TIME-HEARTBEAT.md:5-39` |
| **goal 续推** | `goal` 到 turn-end 用一句"你在目标内：X（第 N 次续推）"拉起下一轮；同一 goal 最小间隔 `goalResumeMinGapSec`（默认 60s）；上限 `goalMaxResumes=50` / `goalMaxAgeMs=8h` / 可选 `turnLimit` | 开（有 goal 才生效） | `:641-644`、`:1648-1782`、`:1788-1804` |
| **投递闸门 `time.gate(signal)`** | 顺序：`to:'plugin'` 放行 → `from.plugin==='time'` 放行（自己的闹钟/续推不受静音影响）→ **静音**（alarm 默认也被拦，`quota` 可 opt-in 放行）→ **睡眠**（`allow` 白名单放行，否则进 time 队列，alarm 最高优先级、醒来第一条呈现）→ **安静安排**（@/管理员放行，其余积压，phase 仍 awake）→ **暂停**（只有 alarm 穿透） | 睡眠/安静/暂停/静音都默认拦 | `packages/plugins/time/src/index.mjs:1530-1587`；delivery 层接线 `:3101-3122`（host 的 `focus.admit` 先跑，这里再判 phase/lock/pause，只判一次） |
| 睡眠 / span / 静音 / 暂停 state | `phase` + `lock`（mute）+ `pausedMode`；睡眠期间外部消息进 time 队列，醒来批量释放（`sleepBrief`）；`sleepGraceSec=120` 允许在飞回合收尾；heartbeat 在 span/goal/非 awake 时暂停 | 由模型用 `time_arrange` 设定 | `:724-779`（state 形状）、`:1158-1163`、`:1950-1952`、`:2116`、`:2214-2288`；设计 `docs/TIME.md` §13/§17 |
| 唤醒分类 | `sendWake(...)` 计入 `wakeCount`→`full/compact`（compactWake 默认关，lab 用） | compactWake 默认关 | `:992-1059`；`docs/PROMPT-WAKE-DESIGN.md:19`（awakeTick 曾 43 条/120min） |

### qq（入站积压 + 唤醒矩阵）

| 项 | 实现 | 默认 | 出处 |
|---|---|---|---|
| 入站防抖（合批） | 同一个人连发合成一批再给模型；per-activity 速率窗口 | 默认 **关**（`inboundDebounce.enabled:false`），产品 preset 显式开 6s/3s/20s | `qq/src/index.mjs:86-87`；preset `:155-164` |
| 群聊 ambient 处理 | 合批 flush 时判定：群 && 非 @ && `peakRate > RATE_FAST(5)` → 打 `ambient` 标签（`debounce.mjs:124-152`），于是 `focus.admit` 把它拦进该群 backlog；安静群的普通消息**不标 ambient、直达**；@ 永远不标 | 群只读/可发由 `groupPolicy/allowGroups/allowGroupSend` 决定 | `qq/src/debounce.mjs:132-140`、`:164-185`；`docs/QQ-GROUP-DESIGN.md:10-22`、`:60-74`；`services.mjs:595-600` |
| **per-activity 自适应延迟**（旧 focus-core 公式，已移植） | 群：`rate` = 该活动最近 5s 到达条数；`quiet = max(base, windowDelayMs(rate, mention?'pierce':'ambient'))` | 仅群走自适应；私聊用固定 quiet | `qq/src/debounce.mjs:173-182`；`qq/src/attention-window.mjs:1-35`（`RATE_FAST=5`、ambient 10min/20 条、pierce 60s/5 条） |
| **唤醒矩阵（规划层，只产 signal）** | `createWakePlanner`：三类提示 `replyCheck`（发出后 30s 查回复）/ `proactive`（空闲+概率+冷却）/ `nudge`（未读>0 且安静够久，未读变化或冷却到期才再提醒）；总预算 `maxWakePerHour=12`；每类另有上限 | `replyCheckEnabled:true`（产品 preset 关）、`proactiveEnabled` **false**、`nudgeEnabled:true`、`nudgeSoftMs 10min`、`nudgeCooldownMs 10min`、`nudgeMaxPerHour 6` | `qq/src/wake.mjs:12-26`、`:132-172`（poll）、`:160-169`（proactive 门槛：idle≥15min+冷却+概率） |
| 矩阵产出的正文 | `[QQ主动检查]` / `[QQ主动提醒]` / `[QQ积压提醒]`，都明确写"这不是对方刚发来的消息"，并内联"醒来第一眼"未读快照（oldest-first、≤12 条/6000 字、partial+readThroughSeq）；投递成功后自动标 read | — | `qq/src/index.mjs:774-786`、`:790-802`；`qq/src/wake-snapshot.mjs` |
| 只有 awake 才发提醒 | `emitWake` 里查 `time.status().phase`，非 awake 直接丢弃（不入 time 积压，避免重复噪声） | — | `qq/src/index.mjs:759-769` |
| 群不生成 nudge | 群消息只走 focus ambient/pierce | — | `qq/src/index.mjs:1377-1378` |

### core / 其它

- `rhythm` 插件：检测到 `time` 服务后**自我禁用**，只留空接口（`packages/plugins/rhythm/src/index.mjs:31-46`）。
- `loop-probe`：lab 专用外部信号注入器，"不要放进默认插件列表"（`packages/plugins/loop-probe/src/index.mjs:1-8`）。
- `dream`：夜间记忆整理，产品 preset `scheduleEnabled:false`（不是注意力机制，但同属"系统自己启动"的一类）。
- `mc-link`/`mc-body`：`heartbeat`/`watchdog` 是**身体/连接健康**事件，会变成 signal 但是反应式的，不是"她想做什么"。

---

## 真实启用情况

### 产品 preset（`packages/dsh-icl/presets/icl.patch.yml`，desktop 用）

| 开关 | 值 | 行 | 说明 |
|---|---|---|---|
| 插件 `focus` / `time` / `qq` | **全部加载** | `:40-57` | 产品工具面 = 这 17 个插件 |
| `time.awakeTick.enabled` | **false（显式写死）** | `:64-68` | 注释：「清醒节拍默认关闭：不外部定时注入"该醒了"；唤醒由模型用 `time_arrange` 闹钟/时间安排自己定。产品显式写死 false，避免未来默认值漂移」 |
| `time.heartbeat` | 未配置 → 默认 `frequency 0.2`、无开关 | — | 即"永远在"的兜底唤醒 |
| `time.goalResumeMinGapSec` | 未配置 → 60s | — | |
| `qq.replyCheckEnabled` | **false（显式）** | `:152-153` | 注释：「不在发送后自动 replyCheck：那会在回合结束后额外叫醒一次」 |
| `qq.proactiveEnabled` | **未出现 → false** | — | 全仓库 grep：只有代码默认值与测试出现过，**没有任何生产配置打开它** |
| `qq.nudgeEnabled` | 未出现 → **true（默认开）** | — | 唯一默认开的 QQ 主动提醒 |
| `qq.wakeMaxPerHour` | 未出现 → 12 | — | |
| `dream.scheduleEnabled` | false | `:83-85` | 夜间整理只在睡眠时按标志触发 |

### lab preset（`presets/lab.patch.yml`）

- `icl-e2`：`time.awakeTick.idleSec: 30`、`goalResumeMinGapSec: 30`（`:405-410`），**但没有写 `enabled:true`**；
  按 master 的 `awakeTickEnabled = awakeCfg.enabled === true`，这里实际仍是**关闭**。
  而 `time/src/index.mjs:654` 的注释写「E2 lab 仍显式开启」——**文档与 preset 不一致（文档漂移，未证实哪个是有意）**。
- `icl-mc-lab`（preset 定义 `:161`）：`awakeTick.mode/idleSec/minIdleSec` 用占位符（`:223-227`），同样没有 `enabled`。
- **四个 lab preset（`icl-lab:57` / `icl-mc-lab:161` / `icl-qq-lab:272` / `icl-e2:366`）都没有写 `awakeTick.enabled:true`** ——
  即按 master 代码，lab 里 awakeTick 也是关的（除测试直接构造 config 之外）。

### 分支漂移（重要）

- `wt/time` worktree（commit `d725efc`，2026-11-07，已包含在 master 历史里）里写的是
  `const awakeTickEnabled = awakeCfg.enabled !== false`（**默认开**，`packages/plugins/time/src/index.mjs:439`）；
  master 现在是 `=== true`（默认关，`:656`）。**同一份代码两个默认值**，worktree 是 11-07 的旧快照。
- 翻转由 master 的 commit **`c7c3364`（2026-11-07 11:46:55）** 做：
  「fix(time): awakeTick is opt-in (default off) and product pins enabled:false — no external 120s wake injection;
  model schedules wake via time_arrange」。
  **时间线自洽**：线上最后一条 awake-tick 是 11-07 11:50（见下），也就是这个 commit 之后 4 分钟就停了。

### 线上实测（`C:\Users\ai_admin\.dsh\icl\state\`，读取时间 2026-11-14 18:00）

| 证据 | 内容 | 含义 |
|---|---|---|
| `time.json` | `heartbeatFrequency:0.2`、`heartbeatStats:{sent:55,suppressed:7,skippedBusy:0}`、`heartbeatLastAt`=2026-11-14 15:45:04、`heartbeatDueAt`=18:18:25、`lastTurnEndAt`=16:53:49 | **心跳是线上真正的主动唤醒源**，跑了 55 次；下一次在最后一次 turn-end + ≈85min |
| `time.json` | `awakeTickDueAt:null`、`awakeTickSentAt` 26 条全在 11-06/11-07、`lastAwakeTickAt:1794023415014`（≈11-07 11:50） | awakeTick **已经停了 7 天** |
| `time.json` | `wakeStats:{sent:104,full:104,compact:0}`、`wakeCount:11`、`turnEnds:274` | wake-class 投递 104 次，compactWake 从未开 |
| `time-events.jsonl` | `awake-tick` 367 条，**全部落在 11-06 23:02 → 11-07 11:50** | 与 commit `c7c3364` 吻合 |
| `time-events.jsonl` | `heartbeat-fire` 55 条（11-07 18:58 → 11-14 15:45）；`wake-class` 104 条同区间 | 心跳是唯一长期运行的主动源 |
| `qq/status.json` | `wake.config = {replyCheckEnabled:false, proactiveEnabled:false, nudgeEnabled:true, nudgeSoftMs:600000, wakeMaxPerHour:12}`；`wake.activities:0`、`emitted:0`、`emittedByKind` 全 0；`ledger.activities:3`、`messages:113`、`delivered:103`、owner 私聊水位 81/81/81、`undelivered:0` | 配置与 preset 一致；**本次进程内** nudge/replyCheck/proactive 都没产出（planner 行只在私聊入站时创建，`index.mjs:1378`；群永不建行 `:1377`）。注意这不等于历史上没触发过，只是当前状态 |
| `focus.json` | `leases:[]`；`backlog` 两个群桶（C4 412 +8、三维方块 +1），item 带 seq 16–24 | 无焦点时群 ambient **持续进 backlog**，等下次 heartbeat 的 statusText 才被告知 |

### 测试覆盖（`packages/core/test/`）

| 能力 | 测试 | 覆盖内容 |
|---|---|---|
| focus 语义 | `focus-semantics.test.mjs`（13 个） | 无 focus 全穿 / 有 focus 别处进积压 / mention 穿透 / `interruptible:false` 只放行闹钟 / 释放时摘要投递 / 快照恢复 / 工具+提示词 / activity 自动推断 / backlog 回执只推 delivered |
| focus 模型 | `focus-model.test.mjs`（8 个） | 穿透规则（私聊总穿、群只 @、别群不穿）、ttl 到期、release |
| QQ 唤醒矩阵 | `qq-wake.test.mjs`（含 `:197-216`「proactive 默认关闭；打开后空闲到点生成 `[QQ主动提醒]`」）、`qq-wake-compact.test.mjs`、`qq-attention-window.test.mjs`、`qq-group-ambient.test.mjs`、`qq-focus-queued.test.mjs`、`qq-watermark.test.mjs`（nudge 仍尝试提醒未交付） | planner 纯函数 + 集成 + 断点 |
| time 节拍/心跳 | `time-lock.test.mjs`（最大，72KB，`:584-884` 清醒节拍与心跳、`:877` "enabled:false 时完全不自检"、`:799-874` 触发/上限/降频、`:596-660` 心跳 span/goal 暂停与 frequency clamp）、`time-goal.test.mjs`、`compact-wake.test.mjs` | 有，且很扎实 |
| 闭环 | `loop.test.mjs`、`loop-probe.test.mjs` | loop preset 外部注入 |

**结论**：三个原型都有测试；`awakeTick.enabled:false` 这个默认值本身也有测试（`time-lock.test.mjs:877-884`），
但**没有测试断言"产品 preset 的开关组合"**（`preset-plugins.test.mjs` 只解析 `plugins:` 列表与个别键如 `toolAllowlist`，
不校验 `pluginConfig` 里的 `awakeTick.enabled` / `proactiveEnabled` 数值）。

---

## 特别回答：现有原型里「系统主动决定做什么」的入口

**先给结论**：现有实现里**没有**"她决定做什么"的机制。所有入口都只做一件事——
**在某个条件下递一段文字 + 状态，把"要不要做、做什么"完全交给模型**。差别只在"谁按的扳机、默认开没开"。

| # | 入口 | 触发条件 | 默认 | 产出 | 关闭/开启有无文档 |
|---|---|---|---|---|---|
| 1 | `time.heartbeat` | turn-end 后 `uniform(10–20min)/f`，无 span/goal | **开**（无开关，f=0.2） | `【心跳】<时间> 没有新回合；当前情况：<statusText> + 世界 + 积压预览` | `docs/TIME-HEARTBEAT.md:21-39`；"模型只能把间隔拉长，不能关到 0"（`:18`） |
| 2 | `time.goal-resume` | 有 goal 且 turn-end，间隔 ≥60s | **开**（需模型建 goal） | "你在目标内：X（第 N 次续推）。id=…，不用时用 time_cancel 取消" | `time/index.mjs:1648-1782`；`docs/TIME.md` §15/§16 |
| 3 | `time` 定时唤醒（schedule/once/daily/weekly/calendar/sleep 结束） | 模型 `time_arrange` 设的时间点 | 开（需模型设） | `【日程】/【闹钟】/醒来简报` | `docs/TIME.md` §12/§14；`time_arrange` 描述 `:2948-2953` |
| 4 | `time.awakeTick` | turn-end 后 `idleSec`，awake+无 mute | **关**（`enabled===true` 才开，产品写死 false） | "清醒节拍：…继续。" | **有，三处**：`time/index.mjs:651-654`、`icl.patch.yml:64-68`、`docs/PROMPT-CONTRACT.md:85`、`docs/TIME.md:473`；原因=外部定时注入会反复打扰空闲回合 + `COMPLEXITY-AUDIT.md:83-100,134,146` 实测 43 条/120min 造成"2 分钟静止" |
| 5 | `qq.replyCheck` | 发出后 30s | **产品关**（代码默认 true） | `[QQ主动检查] …（这不是对方刚发来的消息）` | 有：`icl.patch.yml:152-153`「那会在回合结束后额外叫醒一次」 |
| 6 | `qq.nudge` | 私聊未读>0 且安静 ≥10min，未读变化或冷却到期 | **开**（默认） | `[QQ积压提醒] … + 醒来第一眼快照` | 无专门说明；行为由 `reply.md:91` 交代 |
| 7 | `qq.proactive` | 私聊空闲 ≥15min + 30–90min 随机 + 概率 0.3 + 冷却 30min | **关** | `[QQ主动提醒] … 要不要现在打扰由 time/focus 决定` | **只有一句**：`docs/QQ.md:574`「`proactiveEnabled` 默认 false（不主动打扰，用户可显式开）」+ `QQ.md:645`；`reply.md:30`「不要自己造主动话题：主动机会默认关闭」。**没有更深的决策记录/实验数据（未证实为什么是 0.3/30–90min）** |
| 8 | `focus` backlog 回放 | 模型 `focus_enter/leave` 导致焦点变化 | 开（被动，由模型触发） | "你离开焦点期间，别处积压了 N 条：…" | `docs/FOCUS.md:81-84`、`host.mjs:78-101` |
| 9 | `dream` 夜间整理 | 睡眠 span 的 `dream:true` | 开（需模型安排睡眠） | 记忆整理结果 | `icl.patch.yml:83-85`（不自动排期） |
| 10 | `rhythm` 每晚到点 | 有 `time` 时**自我禁用** | 关 | — | `rhythm/src/index.mjs:31-46` |

**旧项目独有、当前仓库没有对应物的两个入口**（这是"缺口"不是"关闭"）：

- `selfwake`（"她自己偶尔醒一下"，可调 `off/low/normal/high`，默认 low）：`focus-core/domain/selfwake.js`。
  当前仓库 **完全没有**；`docs/QQ-GAP.md:113` 把它列为 P2 未做。
- `continuation`（goal 自持，用她自己的话提醒、5 次后 stalled）：语义被 `time.goal` 覆盖了一部分，
  但**没有 stalled/退避/"最后一次自动提醒"** 这套收尾语义。
- 旧 `idleHeartbeat`（"你现在没事做，可以翻记忆/看红点/排闹钟/刷内容/写状态，也可以继续发呆"）
  是**唯一一条明确给出"自由活动清单"的主动文案**；当前 `heartbeatMessage` 只给状态，不给可做的事。

---

## 可直接借鉴与明确不要照搬的点

### 值得借鉴（每条都能落到具体文件）

1. **"系统主动"的强度由模型自己调，而不是写死频率**：旧 `selfwake` 的 `off/low/normal/high` 四档
   （`selfwake.js:25-31`）+ 每小时上限 + `hasFocus` 不唤 + 刚说完 90s 内不唤（`:53-65`）。
   当前 `heartbeat.frequency` 已是同一思路（`time/index.mjs:676-699`），但**缺"关掉"和"档位语义"**——
   frequency 最小 0.01（≈3–7 小时）不能真正 off，`docs/TIME-HEARTBEAT.md:18` 明确"不能关到 0"。
2. **"被叫醒是机会不是传唤"的文案纪律**：旧 `qq.md:3-6`、`selfwake.js:74-79`、`wake.js:96`。
   当前只有 `reply.md:30-31` 一句"要不要回由你判断"，缺少旧版那种"允许什么都不做"的明说。
3. **nudge 的版本号去重**（`dsh-qq/nudge.js:97-99` + `:112-123`）：同一批未读不重复提醒、新消息改变 version 才再提醒。
   当前 `qq/wake.mjs:149-155` 用"未读数变化 or 冷却"近似，但没有 `deliveredCount/newCount` 的"新增几条"信息；
   旧 digest 会写"（+N 条新）…等了 N 分钟…有人提到你"（`nudge.js:150`）。
4. **成批静默窗口 + 强制 flush**：`attention-window.js` + `wake.js:148-175`（`force_flush` 在焦点切换/结束时置位）。
   当前**已经有同一套**（`debounce.mjs:173-182` 用 `windowDelayMs` 算群的 quiet），所以这条只需补两件事：
   ①`force_flush`（焦点切换/结束时立即交批）当前无对应物；②自适应只对群生效，私聊仍是固定 quiet。
5. **单一裁决点**：`policy.decide`（75 行、2 通道、5 reason）作为"投递裁决"的唯一入口。
   `docs/MODERNIZATION-CANDIDATES.md:22` 把它列为候选 A（"决策点 2→1、reason 9→5"），
   但**当前是双闸门 focus.admit + time gate，doc 建议"先 facade 对拍再切"**——不要直接重写。
6. **给主动唤醒配"自由活动清单"而不是具体要求**：`dsh-qq/bridge.js:10199`。这是最便宜地让"系统主动"不等于
   "系统催活"的办法，可直接改写成 heartbeat 正文的第二行。
7. **醒来第一眼快照**：`bridge.js` 内联快照 + 当前 `qq/src/index.mjs:790-802` 已实现（≤12 条/6000 字/partial）。
   这条**已经搬过来了**，不用再动。
8. **静默一段时间后系统替她收尾**（旧 `pending_leave`，`world-and-self.js:47-60`）：当前没有；
   若要做"她发呆很久后自动离开焦点"，这是现成的语义（`declaredBy:'system'` + 强制 flush）。

### 明确不要照搬

1. **多定时器 + 概率乘数链**（replyCheck/proactiveCheck/sleepTimer/rateLimitRetry/turnSlotRetry/pendingWake +
   4 个乘数）：`docs/MODERNIZATION-CANDIDATES.md:36` 与 `docs/OLD-QWENSTUFF-QQ-UX.md:102-118` 都已判定为反模式；
   旧项目自己的 v2 已收敛成"一条空闲心跳"。
2. **note / nudge / push 三级投递**（`DESIGN-activity-focus.md:44-63`）：当前只有 ambient/pierce 两通道 + focus backlog，
   `docs/QQ-GROUP-DESIGN.md:74` 明确「**不引入 note/nudge/push 三套完整等级**，先保持简单」。
3. **每日 push 预算 12 次**（`policy.js:75`）：当前仓库**没有**预算；旧 repo 自己踩过
   "预算静默挡住所有投递（含私聊）"（commit `34aed46`，`qq-delivery.js:85` 之后只剩 `void pushBudget`）。
   若要重新引入，必须先设计成"只降级、不丢、不挡私聊"。
4. **5 态注意力机**（`dsh-qq/attention.js:5-12`，idle/group/own-time/sleep/silent）：
   `MODERNIZATION-CANDIDATES.md:33` 列入"不搬"；当前 `phase`（awake/sleeping/paused）+ focus 已够。
5. **core-scheduler 租约状态机**（`core-scheduler.js`，独立的 lease/queue/urgent/jumps/reminders）：
   与 `focus` 的租约**重复**（`CORE_DEFAULTS.enabled:false` 是它自己的默认）；不要再造第二套。
6. **awakeTick 式的固定间隔外部注入**（120s/30s）：`c7c3364` 已关，`COMPLEXITY-AUDIT.md:99-100,134,146`
   有实测伤害（43 条/120min、2 分钟静止、教轮询）；`docs/TIME.md:22` 的"底线：醒着不允许静默等待"要保留，
   但实现应走 heartbeat/goal，而不是再开 awakeTick。
7. **把 812 KB `bridge.js` 当参考实现整体移植**：`docs/QQ-GAP.md:265` 已写「**不移植**…移植=把三代教训再来一遍」。
8. **`to:'focus'` 路由枚举**：`docs/FOCUS.md:56,99` 明确不要恢复（与"只有模型能声明 focus"冲突）。

---

## 未证实 / 需要下一轮补的

1. **lab E2 是否真的开过 awakeTick**：`time/index.mjs:654` 注释说"E2 lab 仍显式开启"，但 `lab.patch.yml:405-410`
   没写 `enabled:true`。两者矛盾，未证实哪个是当前事实（怀疑文档漂移）。
2. **`wt/time` 分支的"默认开"是否意味着回滚意图**：该 commit 已在 master 历史里，是否有人打算改回去，未证实。
3. **proactive 的数值（30–90min / 0.3 / 冷却 30min / 15min idle）来源**：只在 `wake.mjs:12-26` 有值，
   找不到拍板记录/实验数据；`QQ.md:574` 只有一句"不主动打扰"。旧 dsh-qq 的乘数链（夜×0.3 等）**没有**被搬过来。
4. **`dsh-qq/config.json` 的 `socialV2.proactive.enabled:true` 是否仍在生效**：那是 2026-10 的部署配置，
   且当前没有 dsh-qq bridge 进程在跑（只有它的 web-search MCP），未证实该配置是否还被当作现状。
5. **`C:\DSH\{her,design,unlock,ai_mc}`** 未深读，仅按目录名判断与注意力层无关；`her` 只有 `notes` 目录。
6. **【已核实并修正】** 群聊"直接回 vs 进 backlog"的阈值：`qq/src/debounce.mjs:132-140`
   （`peakRate > RATE_FAST` 且非 @ 才标 ambient，交给 `focus.admit` 进 backlog；安静群直达），
   自适应延迟在 `:173-182`。即 `docs/QQ-GROUP-DESIGN.md:97-103` 里"缺自适应延迟"的说法**已过期**；
   仍然缺的是它列的另两项：per-activity 的**私聊**测速、以及高繁忙时的硬上限
   （ambient 10min/20 条那组常量目前只用于算 quiet，没用于强制 flush）。
