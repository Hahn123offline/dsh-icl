# 时间与信号（契约版）

> 读者：要改时间/节律逻辑、要验证"她什么时候醒、醒来算什么、静音能不能挡住"的人。
> 范围：`packages/plugins/time/src/index.mjs`、`packages/core/src/{signals,services,host}.mjs` 的拦截/投递段、
> `tools/loop-host.mjs`、`tools/scenarios/loop-s2-time.json` / `loop-s4-sleep.json` / `loop-s5-mute.json`。
> 状态机、`arrange` 语法、inbox 命令、静音锁语义**只在本文件写**，别处只引用这一份。
> 最后核对：2026-11-05（与代码同步；上一版 2026-11-03 的"已知问题"大部分已修，见 §10）。
> 2026-11-07 追加：全局兜底心跳 v2（模型设 frequency、后台随机 10–20m/f、span/goal/phase 暂停、心跳消息自带 status）见 `docs/TIME-HEARTBEAT.md`；awakeTick 默认关闭。

---

## 0. 契约：四个问题 + 一个底线

时间模块回答且只回答四件事（用户原话），外加一条底线：

| 问题 | 谁回答 | 事实源 |
|---|---|---|
| **我什么时候被唤醒？** | `schedules`（时间轴）：single / daily / weekly / 倒计时 | `state/time.json` 的 `schedules` + `fired` |
| **醒了要干什么？** | 唤醒消息、备注、标签、silent；睡眠/静音期间的积压 | `queue` + `spans` |
| **接下来如何行动？** | `goals`（会话轴）：到点建目标、turn-end 续推、上限、取消 | `goals` + focus 租约 |
| **更长期的日程？** | 每天/每周重复、编辑、取消、清单可读性 | 同 `schedules` |
| **底线：醒着不允许静默等待** | `awakeTick` 清醒节拍：没有 goal/事件时，turn-end 后自检一次（normal `idleSec`；fast-play `mode:'immediate'` ~1s，§17）；sleep/mute/pause 是显式静止 | `heartbeat`（§13/§17） |

时间必须是**进程外持久状态 + 定时器**：模型只在被投递消息时存在，两次唤醒之间没有执行体。

不变式（可机器判定，对应 `docs/SURVIVAL.md` §1）：

1. 同一条安排在同一个触发日只响一次，跨重启也不重复（`fired` 落盘）。
2. 被拦下的消息最终是 `delivered | backlogged | dropped(explicit)` 之一；`queue` 有界（默认 500，超出丢最旧并计数）。
3. 积压释放失败（会话忙）时**不清空**队列，下个 tick/下次释放再试。
4. 状态文件坏掉先备份 `.corrupt-<ts>` 再回落空状态；落盘是临时文件 + rename。
5. tick 有重入保护；每次漏响/丢弃/过期/溢出都有计数与 `ctx.log`。
6. 静音/睡眠不能把系统卡死：静音有硬上限（默认 8h）且到点自动解除。

---

## 1. 状态机

```js
const PHASES = ['awake', 'sleeping', 'paused']
```

三个相位，外加一个**正交的静音锁**（`lock`，不改变相位）：

```
  awake ──①──▶ sleeping          ① 到点触发 arrange{mode:'wake',kind:'span',sleep:true}
    ▲             │
    └──────②──────┘               ② span.until 到点 endSpan()；或 api.wake() / time_cancel(span.id)

  awake ──③──▶ paused            ③ pause() / time_pause / inbox pause
  sleeping ─③─▶ paused
  paused ──④──▶ sleeping | awake  ④ resume()：看 sleepingId 还在不在
  任意 ───⑤──▶ awake             ⑤ inbox reset / 启动读到非法 phase（自愈）
```

`state` 字段（`state/time.json`，键名即契约）：

| 字段 | 含义 |
|---|---|
| `phase` | `awake` / `sleeping` / `paused`；启动时非法值回落 `awake` |
| `since` | 最近一次阶段意义变化的时间戳（入睡/醒来/resume） |
| `schedules` | 全部安排，持久；一次性安排响过即删，daily/weekly 保留 |
| `spans` | 进行中的长日程 `{id, until, endMessage, sleep, silent, allow}` |
| `queue` | 被拦下的积压 `{id, signalId, from:{plugin,activity}, kind, text, tags, focus, reason, at, createdAt, expiresAt}`，`reason ∈ paused/sleeping/muted/muted-quota`；`signalId` 保留原信号 id 供来源侧（QQ/MC）对账/去重，同 id 重复 offer 不重复入队 |
| `goals` | `{id, theme, until, turnLimit, resumeLimit, resumes, focus, resumeOnStop, createdAt, lastResumeAt}` |
| `fired` | 幂等键 `"<id>@<YYYY-MM-DD>" → ms`；负值表示"这天已处理但漏响" |
| `sleepingId` / `sleepUntil` | 当前睡眠安排 id / 结束时刻（展示与后移用；判定读 `spans[].until`） |
| `lock` | 静音锁 `{muted, since, until, reason, allow, emergency:{quota, used, log}}`，可为 null |
| `pausedAt` | 暂停开始时刻；落盘，重启后 resume 仍能正确后移 |
| `inboxOffset` | 控制后门游标；落盘，**重启不重放历史命令** |
| `stats` | `{dropped, missed, expired, overflow, failed, inboxBad}` 可观测计数 |
| `lastTickError` / `lastPersistError` | 最近一次失败，控制后门可查 |

安排只有两个正交轴：`mode = wake | goal`（叫她一声 / 让她持续做），`kind = single | span`（一条消息 / 有始有终）。

| mode | kind | 行为 |
|---|---|---|
| `wake` | `single` | 到点发一条 `wake`；一次性安排响后删除 |
| `wake` | `span` | 开始一条 + 记 `spans`；结束时一条（`silent:true` 时两条都不发，只发事件） |
| `goal` | `single` | 到点建 goal；之后每个 `turn-end` 续推，直到 until/turnLimit/resumeLimit |
| `goal` | `span` | 同上，带时间上限（`until` 或 `duration`） |

`schedules` 是时间轴（tick 推进），`goals` 是会话轴（turn-end 推进）。一条 `mode:'goal'` 的安排到点后往 `goals` 里多一条，它自己仍留在 `schedules`（daily/weekly 会再次建目标）；`goal_add` 直接建的 goal 不在 `schedules` 里——`time_list` 现在**两部分都列**。

---

## 2. `time_arrange` 语法与语义

`normalizeSchedule(input, now, {timeZone})` 是唯一落地函数；工具 schema `additionalProperties:false`。

| 参数 | 真实语义 |
|---|---|
| `mode` | 必填；只有 `'goal'` 是 goal，其余一律 wake |
| `kind` | `single/span`；`sleep:true` 或给 `duration`/`until` 时强制 span |
| `at` | `HH:mm`（每天）／`周一 07:30`、`mon,wed 07:30`、`一、三 07:30`（每周）／`YYYY-MM-DD`（那天 00:00）／ISO／`now` |
| `in` | 倒计时：`10m`/`2h`/`1d`/`1h30m`/纯数字=分钟；与 `at` 同给时 **at 优先** |
| `duration` | span 时长（同上语法）；`sleep:true` 无时长默认 3 分钟 |
| `weekdays` | `[1..7]`（1=周一）配 `HH:mm`，等价于 `at:'周一 07:30'` 多天写法 |
| `message` / `theme` | wake 正文 / goal 主题（缺省回落 message） |
| `silent` | 只发 `schedule-start` 事件、不发消息；span 的结束语也不发 |
| `tags` | 打进 `schedule-start` 事件，插件按标签订阅（dream 的 `tags:['dream']`） |
| `focus` | goal 绑定的注意力空间（`addGoal` 时 `focus.enter`，结束/取消释放） |
| `turnLimit` / `resumeLimit` | goal 的回合上限 / 连续唤醒上限（默认 50） |
| `sleep` / `allow` | 进入睡眠 / 睡眠白名单规则 `{from,kinds,tags,any}`（默认 `[{from:'admin'}]`） |
| `id` | 同名覆盖并重新计时（fired 清理） |

**daily/weekly 的"下一次"语义（本轮改）**：重复安排的新建/改期，如果**今天的触发点已经过去超过补发窗口**，把它记成"本轮已过"，从下一次开始——20:00 建 `at:'07:30'` 不会再立刻响一次。补发窗口：

- 重复安排 `catchUpMs` 默认 **15 分钟**：事件循环卡住 ≤15 分钟仍会补响，超过记 `missed`（计数 + log，不补响）。
- 一次性安排 `onceCatchUpMs` 默认 **24 小时**：超过显式丢弃并 log（不再永久留在表里）。
- `fired` 键用**触发点所在日**，跨午夜补响不会吃掉第二天的触发。

**编辑**：`time_edit({id, ...})` 重新 normalize；给 `in` 时不再被旧 `at` 吃掉；只有触发点真变了才清 `fired`（改 message 不会造成同一天重复响）；进行中的 span 会同步改结束时间（含睡眠的 `sleepUntil`）。

**取消**：`time_cancel(id)` 统一收尾——命中长日程就结束、命中安排就删、命中目标就删并释放 focus，同 id 一次全清；返回命中了哪几类。

---

## 3. pause / resume 语义（只停计时）

- `pause()`：`phase='paused'`，记 `pausedAt`（落盘）。tick 除处理 inbox 外不推进任何计时。
- `resume()`：把**暂停时长**整体后移 `spans[].until`、`sleepUntil`、`goals[].until`、一次性 `schedules[].parsed.at`、`lock.until`；daily/weekly 的墙钟时刻不后移（它们不是倒计时）。
- 恢复后如果仍在 sleeping，**不释放积压**（留到醒来一起放，避免睡着时把消息倒给模型）。
- 暂停只冻结时间，不冻结相位；重启后 `pausedAt` 仍有效。

---

## 4. 拦截层：sleep / mute / 事件

`time` 是 `signals` 的唯一纵向拦截层（`signals.addGate`），并在 delivery 上再装一层 push-time gate。判定顺序：

1. `to === 'plugin'`（事件总线）→ **放行**，不进积压。`emit()` 就是 `offer({to:'plugin'})`；core 现在只对 `to:'model'` 调用 gate，time 的 gate 也做同样防御。睡眠时 `turn-end` 之类的事件不会再变成"积压的用户消息"。
2. `from.plugin === 'time'` → 放行（自己的闹钟/结束语/目标续推；FOCUS.md §1.6：静音不关自己的闹钟）。
3. `lock` 生效（显式静音）→ `lock.allow` 命中放行；危险消息（`emergencyTags`：默认 `alarm/safety/emergency`）**默认也拦**（`emergencyQuota` 默认 0，显式配置才 opt-in 放行）→ 入队 `reason:'muted'`、`priority:'alarm'`，记 `lastBlockedAlarm`；普通消息入队 `reason:'muted'`。**静音优先于睡眠白名单。**
4. `phase === 'sleeping'` → 活动 span 的 `allow` 命中放行；**危险消息不叫醒**，入队 `reason:'sleeping'`、`priority:'alarm'`（醒来简报第一条呈现），普通消息入队 `reason:'sleeping'`；白名单默认 `[{from:'admin'}]`。
5. `phase === 'paused'` **或外部 pausedMode.active** → **危险消息穿透并叫醒会话**（记 `lastPierce` + `time-events pause-pierce`）；普通消息入队 `reason:'paused'`。暂停 = 任务停止、世界继续（见 §16）。

补充：
- `allow: []` 表示**没有**白名单（除 time 自己和静音锁规则外全拦）；`allow:null` 才回落默认。
- 积压有界：`maxQueue` 默认 500。溢出时**优先丢最旧的 ambient 消息**（`priority:'alarm'` 最高，其次 `mention/at/private/direct/admin`，最后 ambient）；全都被保护时丢最旧一条；`stats.dropped/overflow` 计数并 log，`time_status` 可见。
- 同一条信号（`signal.id` 相同）重复 offer 不重复入队；条目保留 `signalId` 与 `priority`（`alarm|normal`）。
- 释放：`flushQueue` 只在 `awake` 时真的发送；文本有界（前 20 条 + 来源计数，默认上限 3000 字），**危险条目排最前**（`⚠ ` 前缀），前缀保持 `[plugin/activity]`；`expiresAt` 过期显式丢弃计数；**发送失败不清队列**。
- 去重：同一天同一安排 `fired` 只响一次；积压条目有 `id` 可 `skip`。

### 4.1 静音锁（新）

`mute({minutes, until, reason, allow, emergencyQuota})`：

- 默认 30 分钟，最长 `maxMuteMs`（默认 8h）——超时到点**自动解除**并释放有界积压摘要，不会把系统永久卡死；解除时发 `mute-end` 事件。
- **用户 2026-11-06 拍板：静音默认连危险消息也拦**（`emergencyQuota` 默认 0），但会记录（`lastBlockedAlarm` + `time-events alarm-blocked`），恢复/醒来时可见。危险消息 = 带 `emergencyTags`（默认 `alarm/safety/emergency`）；`emergencyFrom` 可把来源收敛成显式插件白名单。要 opt-in 放行危险：`emergencyQuota:N` 或 `allow:[{tags:['alarm']}]`。
- 可查：`time_status` / `status().lock` / `status().lastBlockedAlarm` / `inbox lock`；可恢复：`time_unmute` / inbox `unmute`。
- 状态与积压摘要里 **sleep 与 mute 可区分**：`phase` 与 `lock` 分开、积压条目带 `reason` 与 `priority`、`time_list` 显示 `（sleeping）/（muted）`。
- 对外接口（QQ/MC 等来源）：gate 返回 `{accept:false}` 之前内容已经 `enqueue()` + `persist()`，不存在"offer 说 blocked 但没落盘"的窗口；来源侧**不需要自己兜底暂存，也不要重试被拦信号**（重复 offer 会按 `signalId` 去重）。重放时保留 `[plugin/activity]` 前缀。**判定规则**：`offer` 返回 `blocked:true` 且 `reason` 为 `sleeping/muted/paused` → 内容已在 time 积压里，等醒来/恢复统一释放，**来源不得再补投**（否则醒来重复一条）；只有 `offer` 抛异常/进程重启丢信号才需要来源侧重试。mc-link 的 `pendingAlarms` 只应覆盖后者，不能把 gate-blocked 的 alarm 再投一次。
- 静音期间 time 自己的闹钟与目标续推照常（"静音只关外部打扰"）；玩家在 DSH GUI 里直接说话不经过 signals，仍能直达。
- **两个维度**：focus = 空间/命名空间（哪条会话/上下文该不该收），time = 时间/全局锁（现在能不能收）；到达 = 两者都放行，任一门可积压，释放后摘要**重新进入管道**再走双闸门（详见 `docs/DELIVERY-POLICY-DESIGN.md §2.7`）。
- **两条路径统一 focus→time（P3）**：signals 层**不再安装 time gate**；time 只在 delivery 层裁决（host 的 focus 空间闸门先、time 时间闸门后），所以同一条消息只被时间 gate 计一次（配额/记录不重复）。`deliveryGate` 读取 `source.tags/focus/priority/pierce/meta/id/expiresAt`，直投与信号路径同一语义（暂停 alarm 穿透；睡眠/静音按最高优先级进 time 队列）。**sleep 租约例外**：owner=time/kind=idle/label=sleep 是时间锁标记，host `focusDecision` 跳过空间闸门，睡眠积压仍归 time queue。
- **重放回执（QQ）**：time `flushQueue` 真正投递成功后，按 `activity` 分组调 `ctx.services.get('qq').noteDeliveredSeqs({activity, seqs, via:'time-backlog', at})`；只推 delivered（不推 attended/不算已读），幂等。队列条目在 `enqueue` 时保留 `meta.qq.ledger={activity,seq}`；focus backlog 摘要若被 time 拦下，`meta.replayQq` 随摘要入队，由 time flush 时统一补推。QQ 侧统计在 `qq_status.ledger.deliveredVia.time-backlog`。

### 4.2 穿透与伪造：风险边界

- `from.plugin === 'time'` 是**身份字段**，同进程插件理论上可伪造；本轮靠"进程内插件都是自家代码"兜底，不把它当安全边界。
- `tags:['alarm']` 同理：任何插件都能给自己的信号打紧急标签。已做：`emergencyFrom` 显式白名单可收敛来源；`focus.admit` 的 `alarm` 特权是 core 现有行为（本轮不改，见 §9）。
- **已堵的结构洞**：插件直接 `ctx.delivery.push` 会绕过 signals gate。现在 delivery 有 push-time gate（`delivery.setGate`），time 在 delivery 上再装一层：`channel==='signal'` 视为"已过 signals gate"放行，其余按当前相位/静音锁裁决，被拦的进 time 积压（不丢）。focus 的积压摘要也从 `delivery.push` 改为 `signals.offer`（gate + focus.admit 双重裁决）。
- 多 gate：`signals.addGate` / `delivery.addGate` 组合裁决（全部 accept 才放行），卸载只摘自己那层；旧 `setGate` 仍是替换语义。time 在 tick 里自愈：发现自己的 gate 被整体替换会重新安装并 log。

---

## 5. 目标（会话轴）

- 来源：`time_arrange {mode:'goal', ...}`（到点建）、`goal_add`（立即建）。`addGoal` 接受 `until`（ISO/HH:mm/in 式）、`afterMin`、`durationMin`、`in`、`turnLimit`、`resumeLimit`、`focus`、`resumeOnStop`。
- 目标消息带 **id / theme / 剩余轮次 / 到期时间**：`你在目标内：<theme>（还剩 N 轮，到 …）。id=g-xxx，不用时用 time_cancel 取消，别留着空跑。`
- 每个 `turn-end`（`signals.on({tags:['turn-end']})`，只在 awake 时）续推一次，**但同一目标有最小间隔**：`config.goalResumeMinGapSec`（默认 **60s**）内不重复唤醒，被节流的续推记 `resumeDueAt`，由 tick 到点补发；消息带"第 N 次续推"。这样"持续目标"是节奏，不是每回合紧循环（红队 C3）。间隔设 0 可恢复旧行为（测试/特殊场景）。
- 在 `until` 到期、`turnLimit` 用完、`resumeLimit`（默认 50）或 `goalMaxAgeMs`（默认 8h）到上限时发**明确的"目标结束：…（原因）"**并释放 focus——不是静默停止。
- `time_cancel(id)` 取消目标、释放绑定 focus；`time_list`/`time_status` 都能看到 id（旧版看不到 id 导致无法取消）。
- 与 focus 的配合：goal 用 `owner:'time'` 的租约进入 `focus`（`interruptible:true`），换目标/结束/取消都会释放；模型自己的 `focus_leave` 不会替她取消 goal（由 `time_cancel` 或上限收尾）；time 发的目标消息在 `focus.admit` 里因 `from.plugin==='time'` 始终可达，并带 `focus` 字段以便归并到同一个 batchKey。

---

## 6. 提示词与世界状态（cache 契约）

- 提示词段 `time`（order **880**）：`时间：YYYY-MM-DD 周X 时段；相位[（睡到 HH:mm）][（静音到 HH:mm）]。` 第二行仅在有内容时出现：`下一个安排：<id>（每天 07:30，<绝对时间>）；积压 N 条（来源）`。
- **不写精确到分钟的时间**：DSH 每步已注入精确时间；分钟级抖动会每 60 秒作废一次前缀。时段 + 日期只在跨小时/跨天时变。
- 每段 ≤2 行，无内容整段消失；`order ≥800` 放动态段尾部（`docs/PROMPT-CONTRACT.md`）。
- world source：`owner:'time', title:'日程'`，只列"进行中/目标"（"现在几点/下一个安排/积压"的唯一家是 time 段）；它的存在同时抑制 world-state 的兜底"时间"行，系统提示里只有一处 `时间：`。

---

## 7. 控制后门：文件邮箱

CLI：`node tools/time.mjs <命令> [JSON] [--state <time.json>] [--no-wait]`。协议：CLI 往 `time.inbox.jsonl` 追加一行 JSON，time 在 tick 里读、写 `time.outbox.jsonl` 回执（CLI 按 `id` 配对）。

命令全集（`runCommand`）：`status/pause/resume/arrange/cancel/edit/skip/queue/mute/unmute/lock/wake/clock/reset/goal_add/goal_remove/goal_list`。未列出的返回 `{ok:false,error:'未知命令：X'}`。

- `cancel` 是 §2 的统一收尾（不再只删 schedules）。
- `clock` **只在 `config.testClock:true` 的测试 preset 可用**（lab 的 `icl-lab` 已开）：平移 time 看到的时钟，用于跨小时/跨时段前缀复核、长夜压缩。参数 `{advanceMs|advanceMinutes|advanceHours}`、`{nextHour:true}`（跳到下一个整点+1 分钟）、`{nextPeriod:true}`（跳到时段边界 6/12/18/23 点+1 分钟）、`{reset:true}`；只影响 time 自己的时间视图（不改宿主墙钟），不落盘，重启恢复。
- `reset`：释放全部 focus 租约、清空 schedules/queue/goals/spans/fired/lock/pausedAt，**保留 inboxOffset**（重启不重放旧命令）。
- 回执：`{"id":..., "at":..., "ok":true, "result":{...}}` 或 `{"ok":false,"error":"..."}`。
- 游标落盘（`state.inboxOffset`），文件被截断时自动归零并 log。
- 启动时若 `queue` 非空，按"（重启后发现的）积压了 N 条消息"显式释放（失败会保留）。

**正确顺序：先起会话，再下命令；不要预写 `time.json`**（启动会清理过期一次性安排并释放已有积压）。

---

## 8. 工具面（9 个）

| 工具 | 一句话 |
|---|---|
| `time_status` | 现在/阶段/睡到/静音到/暂停语义（任务停止、世界继续、危险穿透 + 最近穿透）/下一个安排/进行中/目标 id/积压/漏响；以及心跳（§13） |
| `time_arrange` | 新建安排（§2 语法；工具 description 是参数契约的家） |
| `time_list` | 安排（按下一次触发排序）+ 目标 + 积压，带相对时间 |
| `time_edit` | 改时间/消息/模式/时长/silent/tags；进行中 span 同步结束时间 |
| `time_cancel` | 同 id 一次收尾（长日程/安排/目标），释放 focus |
| `time_pause` / `time_resume` | 冻结/恢复全部计时（§3） |
| `time_mute` / `time_unmute` | 静音锁（§4.1）：可查/可恢复/自动到期/紧急配额 |

七个旧工具名不变；新增两个静音工具后 `manifest.json` 的 `tools` 同步（9 个），tool index 字节变化属预期（cache 需要知道）。

---

## 9. 已知风险（本轮不修，写清楚不装死）

| 风险 | 后果 | 现状/缓解 |
|---|---|---|
| `from.plugin` / `tags:['alarm']` 可被同进程插件伪造 | 伪造者可绕过睡眠/静音 | 进程内信任模型；`emergencyFrom` 可收敛来源；真正的安全边界要 principal/签名，未做 |
| `focus.admit` 把 `tags:['alarm']` 与 `from.plugin==='time'` 当特权 | 任意插件可给自己发通行证 | 本轮不改 core 语义（focus owner 是 misc）；已把时间侧放行收敛成显式 allow + 配额 |
| 多 gate 只有 time 在用 | 其它插件若用旧 `setGate` 会整体替换 | `addGate` 组合 + time tick 自愈重装 + log |
| 时区 | `timeZone` 配置当前只影响 time 自己的 HH:mm/daily/weekly/dayKey；dream 有独立时区配置 | 默认宿主时区；换机器/改时区后 `fired` 日期键会错一天，需 reset 或等自然跨天 |
| delivery 重试与 signal 幂等 | signals 的 `exactlyOnce:false`；批 ack 丢失时同一批可能重发 | delivery 层 nack 退避；时间侧 `fired` 保证"安排不重复响"，但已投递文本的重复由 delivery 决定 |
| **测试脚手架的 startupReset 会吞掉 time state** | lab/test preset 里 `loop-probe` 默认 `resetOnStart:true`，每次 dsh 新进程 apply 时调 `time.runCommand({cmd:'reset'})` → `time.json` 的 `phase/spans/queue/fired` 全清。长测/supervisor 自愈重启后"继续睡、积压保留、不重复释放"都不可测，且会误判成 time 恢复失败 | 测试 preset 显式 `pluginConfig.loop-probe.resetOnStart:false`（driver 的显式 `reset` 步骤仍可用）；产品装配不含 loop-probe；2026-11-06 night-1 长测踩到过，已单独记入 `docs/TIME-NIGHT-REPORT.md` |
| **直接 session/prompt 绕过拦截层** | time 只拦 `signals.offer(to:'model')` 与 delivery.push；driver/supervisor/用户在 DSH 里直接 `session/prompt` 的 user 消息不经过 signals → 睡眠/静音期间也能把模型叫起来（night-1 02:11:27 睡眠中有一条 supervisor 死亡提示直投，模型跑了 28 秒工具）。这不是 time 拦截失败，但会让"睡眠期静默"验证失真 | 外部注入方必须先读 `time.status().phase`（sleeping/paused/locked 时不要直投），或改走 `signals.offer`（会被 gate 拦进积压）；time 侧无法拦截直接 prompt，已写进长测报告与巡检脚本告警 |
| `time-accept.mjs` 是旧 host 验收脚本 | 仍可跑，但不是契约验收（见 §11） | 契约验收走单测 + `loop-host.mjs` |

---

## 10. 本轮修掉的（对照 2026-11-03 版"已知问题"）

- 空 `catch` 吞错 → persist/state/inbox/outbox/tick 都有 log + side file + `last*Error`；状态文件坏先 `.corrupt-` 备份；原子写（tmp + rename，失败退回直写并 log）。
- `inboxOffset` 重启归零 → 游标落盘，不再重放；坏行计数。
- daily "今天"语义 → 下一次触发 + 补发窗口 + `missed` 计数；once 漏 >24h 显式丢弃；一次性安排响后删除；`fired` 只保留 8 天。
- `time_edit({id,in})` 静默无效 → 修好；只在触发点真变时清 fired；进行中 span 同步结束时间。
- goal 停不下来 / `afterMin` 不生效 / 状态无 id → 续推上限 + `afterMin` 支持 + 状态带 id + 明确结束消息 + 取消释放 focus。
- 嵌套 sleep 提前醒 / 重启后 sleeping 无租约 / 编辑取消丢失睡眠白名单 → 单层睡眠守卫、启动恢复租约、白名单存进 span。
- pause 只冻结 span → 一次性时刻、goal.until、lock.until 一起后移；resume 到 sleeping 不释放积压。
- 事件总线被当用户消息积压、`to:'plugin'` 进 queue → gate 只作用于 `to:'model'`。
- `delivery.push` 绕过 gate → core push-time gate + focus 摘要改走 signals。
- 积压静默丢失（先清队列后发送）→ 发送成功才清；有界摘要；溢出/过期计数。
- 静默失败 → tick 重入保护、`stats`/`lastTickError`、失焦 gate 自愈。
- 提示词两行"时间："、world source 分钟级抖动 → `time` 段（order 880）+ world `日程` 段；时间只到日期+时段。

---

## 11. 验收场景

### 单测（`node --test packages/core/test packages/mc-body/test`）

| 文件 | 覆盖 |
|---|---|
| `time.test.mjs` | 基本触发/睡眠拦截/白名单/醒来释放/暂停积压/inbox/silent 日历/fired 幂等/默认睡眠时长 |
| `time-goal.test.mjs` | goal 创建、释放 focus、到期、turn-end 续推、turnLimit、时钟接管、取消睡眠 |
| `time-lock.test.mjs` | **静音锁**（拦截/紧急配额/自动到期/手动解除/与 sleep 区分）、**防穿透**（delivery 直投/事件总线/focus 摘要）、积压有界/失败不丢/过期/溢出保私聊、signalId 归因、一次性删除、daily 下一次、weekly、倒计时语法、pause 冻结、漏响计数、silent span、嵌套睡眠、goal 上限、统一取消、坏状态备份、inbox 游标、暂停中重启、四态可读状态行、测试时钟跨小时 |
| `signals.test.mjs` | gate 只拦 to:model、addGate 组合、setGate 替换语义 |
| `delivery-gate.test.mjs` | delivery push-time gate：拦/放/fail-open/卸载恢复/组合 |
| `focus-semantics.test.mjs` | focus 闸门与积压摘要（本轮改走 signals.offer 后仍绿） |

### 虚拟时钟闭环（`node tools/loop-host.mjs --long`，24/24）

S0 工具面/系统提示、S1 外部投递、S2 focus 积压与摘要、S3 time wake、S4 睡眠积压释放，外加本轮 S5：

- 静音：外部消息不投递、自己的闹钟照常响、紧急配额（1 条放行/1 条积压）、解除后积压一次释放
- 防穿透：睡眠中 `host.services.delivery.push` 直投被拦且醒来释放
- 暂停：倒计时冻结、恢复后按剩余时间响
- goal：续推到上限后明确结束、id 可查
- 提示词：只有一处 `时间：`、时间不精确到分钟

### 真实会话（lab，最终手感确认；不重启 desktop）

```bash
# 注意：显式钉住 provider/model，不依赖 profile 默认（2026-11-05 曾有人误改 web profile 默认模型）
node tools/lab.mjs up --preset icl-lab --port 57107 --run time-1
node tools/loop.mjs --base http://127.0.0.1:57107 \
  --state-dir <runDir>/state/icl-lab --session <sessionId> \
  --scenario tools/scenarios/loop-s2-time.json --out <runDir>/loop-s2
# s4 / s5 同理；loop.mjs 的 --session 复用同一条 lab 会话
node tools/lab.mjs down --run time-1
```

S2 = 到点唤醒一次且多一轮（minTurns=2）；S4 = 睡眠拦截 + 醒来释放；S5 = 静音拦截 + 闹钟穿透 + 解除释放。断言只认 `events.jsonl`/`time.outbox.jsonl`/状态快照，不拿模型自述当证据。

**2026-11-05 结果（port 57107，deepseek-account/deepseek-flash）：**

| 场景 | 结果 | 断言 |
|---|---|---|
| S2 time | PASS | 2/2（userContains 闭环唤醒 + minTurns 2），errors 0 |
| S4 sleep | PASS | 2/2（醒来结束语 + 积压释放），turns 4，errors 0 |
| S5 mute | PASS | 3/3（signalBlocked / 闹钟穿透 / 解除释放），turns 3，errors 0 |

S6 hour（`loop-s6-hour.json`）用测试时钟跳到"下一个整点+1 分钟"，专门复核跨小时时 `时间：…时段` 的事实变化与前缀稳定性（2026-11-05 在 lab 跑通，见 §12.3）。

产物：`.state/lab/time-3/loop-s2|loop-s4|loop-s5/{report.md,verdict.json,events.jsonl}`（worktree 内，不提交）。

### 夜间生存长测（night-1，2026-11-06 00:26–06:51，8h 未跑满/提前结束）

完整证据与结论见 **[TIME-NIGHT-REPORT.md](TIME-NIGHT-REPORT.md)**。摘要：入睡/醒来/dawn 均按计划（02:09:05 → 06:39:06 → 06:49:05，dawn 只响一次）；睡眠期 17 条外部消息全部进积压（reason=sleeping），醒来一条合并消息按"结束语→积压摘要"释放且计数一致；dream 在入睡瞬间跑完（wash 1119 行）；两次 lab 重启后 schedules/fired/queue 原样保留（`loop-probe.resetOnStart:false` 后）。事故三条：测试脚手架 startupReset 清 time state（已修）、睡眠期 9 条 supervisor 直投（DSH 队列残余，修复后 0）、睡眠边界 in-flight turn（语义 B+有界兜底，time/supervisor 均已实现，待合并部署）。

### 前缀稳定性（misc 对表，2026-11-05）

同一 lab 流程 + `tools/scenarios/cache-10.json`（cloud deepseek-flash，显式 provider/model）：

| 跑次 | 代码 | 轮数/跨度 | system 字数 | `system/message` 条数 | 首差异 |
|---|---|---|---|---|---|
| misc-1 | 旧（分钟级时间行） | 11 轮 / 130s | 5117 | 2 | **2316** |
| misc-minute-check | 本契约版，故意跨分钟（gap 32s） | 4 轮 / 102s | 5060 | **1** | 无（只有一份） |

结论：`时间：日期+周几+时段` 后，跨分钟不再产生新的 `system/message`，也不再每轮 append 一整段系统提示词。工具面：34 个工具、`toolsChars` 18910（+inspect 时注意 `time_mute/time_unmute` 是新增变量）。

### 独立复核（misc，真实装配 `createHost` + time + 虚拟时钟，2026-11-05）

| 断言 | 实测 |
|---|---|
| 睡着时 `emit({from:dsh,kind:event,text:'turn-end'})` | `accepted:true`，time backlog 0→0（旧版会 +1，醒来变成 `[dsh] turn-end`） |
| 睡着时外部消息（qq, to:model） | `blocked:true, reason:'sleeping'`，backlog 0→1 |
| 睡着时释放 focus 租约 | 摘要走 signals → 被拦；delivery 里没有 focus 批次（旧版 `delivery.push` 会直塞） |
| 醒来 | 只释放 1 批合并摘要：`（你睡觉时）积压了 2 条消息：· [qq]… · [focus/backlog]…`，backlog 清 0 |
| 静音锁 | `time_mute` 后 qq `blocked:'muted'` → backlog 1；`tags:['safety','alarm']` 紧急 `accepted:true`；`time_unmute` 释放 |
| 工具面 | 9 个 time 工具，manifest 与注册一致 |

注：睡眠期 `delivery.pendingCount()` 可能为 1——那是"要睡了"唤醒通知本身，不是 turn-end 漏入；turn-end 前后 backlog/pending 都不变。


---

## 12. 怎么跑（下一任维护者的一键复跑）

全部命令在 `C:\DSH\icl-wt\time`（或合并后的仓库根）执行；**不需要桌面 DSH、不需要重启任何用户进程**。
依赖：Node ≥ 24（仓库用 `node --test`）；真实 lab 需要已安装的 `dsh`（`tools/lab.mjs` 会自动发现）和 web profile。

### 12.1 纯单测（秒级，CI 用这个）

```bash
node --test packages/core/test packages/mc-body/test
# 只跑 time 的契约测试：
node --test packages/core/test/time.test.mjs packages/core/test/time-goal.test.mjs packages/core/test/time-lock.test.mjs
# 只看信号/投递拦截：
node --test packages/core/test/signals.test.mjs packages/core/test/delivery-gate.test.mjs packages/core/test/focus-semantics.test.mjs
```

期望：全绿。time-lock 覆盖静音锁/防穿透/积压可靠性/日程语义/测试时钟（33 条）。

### 12.2 虚拟时钟闭环（不启 DSH，30 秒）

```bash
node tools/loop-host.mjs            # 基础 8 项
node tools/loop-host.mjs --long     # 24 项：+30 分钟长跑 + 静音/防穿透/暂停/goal/提示词稳定性
```

期望：`checks: 24/24`，退出码 0；产物在 `.state/loop/host-runs/<ts>/{report.md,verdict.json}`。
输入：`packages/plugins/time/src/index.mjs`、`tools/loop-host.mjs`（S5 段直接调 time API）。

### 12.3 真实会话（lab，最终手感确认）

```bash
RUN=time-check
node tools/lab.mjs up --preset icl-lab --port 57107 --run "$RUN"
# 取 sessionId（loop 用 --session 复用同一条会话，不要每次新建）
SID=$(node -e "console.log(require('./.state/lab/'+process.argv[1]+'/lab.json').sessionId)" "$RUN")
STATE="C:/DSH/icl-wt/time/.state/lab/$RUN/state/icl-lab"

for S in loop-s2-time loop-s4-sleep loop-s5-mute loop-s6-hour; do
  node tools/loop.mjs --base http://127.0.0.1:57107 --state-dir "$STATE" \
    --session "$SID" --scenario "tools/scenarios/$S.json" --out ".state/lab/$RUN/$S"
done

node tools/lab.mjs down --run "$RUN"
```

期望（2026-11-05 实测）：S2 PASS 2/2、S4 PASS 2/2、S5 PASS 3/3、S6 PASS（minTurns 3），`errors: 0`。
- **模型必须显式钉住**：`tools/lab.mjs up` 默认 `deepseek-account/deepseek-flash`（`session/selectModel`）；不要依赖 `~/.dsh/profiles/**` 的默认模型（曾有事故）。
- 端口按 TEAM-PLAN：time=57107；跑完必须 `lab.mjs down`，别留后台实例。
- lab preset 已含 `loop-probe`（`tools/loop.mjs` 的 `reset`/`signal` 步骤依赖它）与 `pluginConfig.time.testClock: true`（S6/跨小时复核依赖）。

### 12.4 输入文件（改行为时只需要看这几处）

| 文件 | 作用 |
|---|---|
| `packages/plugins/time/src/index.mjs` | 全部时间逻辑（唯一实现） |
| `packages/plugins/time/manifest.json` | 工具名清单（9 个，必须与注册一致） |
| `packages/core/src/{signals,services,host}.mjs` | 拦截层/投递层接缝（gate 只拦 `to:'model'`、`addGate` 组合） |
| `tools/scenarios/loop-s2-time.json` / `loop-s4-sleep.json` / `loop-s5-mute.json` / `loop-s6-hour.json` | 真实 lab 场景（数据，不是代码） |
| `tools/loop-host.mjs` | 虚拟时钟闭环驱动 |
| `packages/dsh-icl/presets/lab.patch.yml` | lab preset（`icl-lab` 含 loop-probe + testClock；`icl-mc-lab` 供 MC 场景） |

状态文件：`<stateDir>/time.json`；控制后门：同目录 `time.inbox.jsonl` / `time.outbox.jsonl`；异常：`*.corrupt-<ts>` / `tick-error.json` / `inbox-error.json`。

### 12.5 判读证据（不拿模型自述当证据）

- `report.md` / `verdict.json`：断言与退出码。
- `events.jsonl`：`turn/start|turn/end`、`user/message`（唤醒/积压到达）、`system/message`（提示词快照）。
- `time.json`：`phase / spans / queue[].reason / lock / fired / stats`。
- `context/turn-*.txt`：每轮系统提示词；跨小时复核（S6）看 `时间：…时段` 是否只在跨小时变化、`system/message` 是否只有一份（前缀稳定性）。

### 12.6 快速排障

| 现象 | 看哪里 |
|---|---|
| lab 场景 `等不到 loop.outbox 回执` | preset 里是否启用了 `loop-probe`；`stateDir` 是否指对 |
| time 没响 | `time.json.fired` 是否已有当天键；`stats.missed`；`tick-error.json` |
| 消息没到 | `signals.stats()`（blocked/gates）、`delivery.pendingCount()/blockedCount()`、`queue[].reason` |
| 状态不对/卡住 | `time_status` 的"状态："行；`lastTickError`/`lastPersistError`；`phase` 是否 paused |
| 前缀每轮变 | `time` 段是否又混进分钟级时间；world「日程」段是否相对时间抖动 |

---

## 13. 清醒节拍（awake heartbeat，2026-11-06 新增）

### 13.1 问题

模型没有连续时间体验：它只在被投递消息时存在。旧实现的 `turn-end` 处理**只对 goal 生效**
（`resumeGoals()`；没有 goal 时返回 0，会话就静止），于是"她在醒着但没事做"表现为
**分钟级没有模型调用**——用户视角是卡死/延迟，而不是"在休息"。

底线：**醒着不允许静默等待**。静止必须是显式状态（sleep / mute / pause），不是默认。

### 13.2 规则

每个 `turn-end`（`signals.on({tags:['turn-end']})`，bridge 在真实 DSH 的 `turn/end` 发出）：

1. 记录 `lastTurnEndAt`、`turnEnds`；
2. 先跑 `resumeGoals()`（原有行为）；**如果本轮有目标续推，清醒节拍不叠加**（goal 本身就会拉起下一轮）；
3. 否则 `armAwakeTick()`：若 `phase==='awake'` 且没有 `lock`（静音），把 `awakeTickDueAt = now + armDelay`（normal = `idleSec`；immediate = `minIdleSec`，默认 1s；immediate 另用独立 timer 保证 ~1s 精度，不依赖 15s tick 循环）；
4. tick（默认 15s 一次）里 `maybeAwakeTick()`：到点且仍然醒着、仍不抑制时，发一条 `awake-tick` notice：
   - 正文只给**事实 + 继续**，不教轮询：`清醒节拍：距上次回合结束 N 秒[；积压 N 条][；目标 g-…]。继续。`
     capped 后发短提示：`清醒节拍：继续（醒着 N 秒，仍在等你）。`
   - 发送成功 → 记 `lastAwakeTickAt`、`awakeTickSentAt`；normal 模式 due = 再 `idleSec`；immediate 模式把 due 置空、等这轮 turn-end 再 arm（避免 1s 空转）；
   - 发送失败（会话忙）→ `retrySec` 后重试，不静默放弃；
   - 超过 `maxPerHour`（软上限）→ **降频**到 `cappedSec` 检查一次；cap 后前 `cappedShortWindowSec` 分钟内最多发 `cappedShortMax` 条短提示，之后安静等滚动窗口释放，不刷屏；`awakeTickCappedAt` 留痕 + log warn。
5. 抑制条件（不发自检）：`phase !== 'awake'`（sleeping/paused）、`lock`（静音）；
   focus 默认**不**抑制（专注是"正在做事"，不是沉默；`awakeTick.duringFocus:false` 可改）。
   注意：focus 中 `awake-tick` 仍可能被 **focus gate** 拦成 focus backlog（例如当前 focus 不可打断）——
   那是 focus 的裁决结果，不是 time 的静默；`signals.stats().blocked` / `focus_backlog` 里能看到去向。
6. 状态切换会重新 `armAwakeTick()`：醒来、`resume`（且已醒）、`unmute`、重启后若睡着已恢复。
   `pause`/`mute`/入睡会清掉 due。
7. 可观测异常：醒着但 `now - lastTurnEndAt > overdueSec`（normal=`idleSec*1.5`，immediate 默认 10s）时 `heartbeat.state='overdue'`，
   `time_status` 显示 `⚠ 心跳：…`，log warn 每 10 分钟最多一次。
8. `turn-start`（bridge 在 `turn/start` 也 emit，tags:['turn-start']）只用于记录 `lastTurnStartAt`/
   `lastModelCallAt`：不进 prompt、不进历史、不改变缓存。

### 13.3 配置（`config.awakeTick`）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | **true** | 关掉则完全回到旧行为（长跑/成本敏感场景可关） |
| `idleSec` | **120** | normal 模式 turn-end 后多久没有新回合就自检；下限 15 |
| `mode` | `normal` | `normal` 或 **`immediate`**：fast-play/游戏模式，turn-end 后 `minIdleSec`(~1s) 自检（§17） |
| `minIdleSec` | **1** | immediate 模式的 arm 延迟（秒），下限 0.2 |
| `immediateBackoffAfter` | **20** | immediate 连续 N 次自检都没有外部信号/任务事件 → 退避到 `backoffSec` |
| `backoffSec` | **30** | 退避后的自检间隔；事件/任务一到达立刻恢复 immediate（`awake-recover`） |
| `overdueSec` | normal=`idleSec*1.5` / immediate=**10** | 超过多久算 heartbeat overdue（immediate 不能用 1.5s 判） |
| `timer` | **true**（immediate） | immediate 用独立 timer 保证 ~1s 精度；测试可 `false` 走 `api.tick()` |
| `maxPerHour` | normal=**60** / immediate=**3600** | 每小时自检上限（软上限；immediate 默认等于不限） |
| `retrySec` | **30** | 自检投递失败后的重试间隔 |
| `cappedSec` | **600** | 命中 `maxPerHour` 后的降频检查间隔（10 分钟一次） |
| `cappedShortWindowSec` | **1800** | cap 后允许发短提示的窗口（30 分钟） |
| `cappedShortMax` | **3** | cap 窗口内最多几条短提示（之后安静等滚动窗口释放） |
| `duringFocus` | **true** | 有 focus 租约时是否也自检（焦点≠静止；改 false 则专注时不打扰；被 focus gate 拦下不算 time 静默） |

测试/长跑 preset 可以显式 `awakeTick: { enabled: false }`（`tools/loop-host.mjs` 已关，保持确定性）。

### 13.4 可观测（`status().heartbeat` 与 `time_status`）

```json
"heartbeat": {
  "enabled": true, "state": "awake|overdue|sleeping|paused|muted|suppressed",
  "mode": "normal|immediate", "thresholdSec": 120, "idleSec": 37,
  "armDelaySec": 1, "minIdleSec": 1, "streak": 0, "backoff": false, "backoffSec": 30,
  "lastActivityAt": 1793…,
  "lastTurnEndAt": 1793…, "lastTurnStartAt": 1793…, "lastModelCallAt": 1793…,
  "nextTickAt": 1793…, "lastAwakeTickAt": null,
  "ticksLastHour": 0, "maxPerHour": 3600, "capped": false,
  "decisionCycleSec": 2, "reactionLatencySec": 1, "reactionPendingAt": null,
  "pendingBacklog": 0, "turnEnds": 12
}
```

- **名词口径（与 mc-lab supervisor 对齐）**：`heartbeat.idleSec` = `now - lastTurnEndAt`
  （"最后一次模型活动结束/最后一次 turn-end"到现在的秒数）；`awakeIdleSec` 是同一个量。
  不要用"最后一次投递"或"最后一次工具调用"另起口径——那两件事在 time 里不可见。
- `lastModelCallAt` = `lastTurnStartAt ?? lastTurnEndAt`（bridge 现在同时 emit `turn-start`/`turn-end`）；
  `turn-start` 只是插件总线信号，不进系统提示词/历史，不影响缓存（cache 可复核）。
- `time_status` 文本在醒着时多一行：`心跳：上次回合结束 N 秒前；还有 M 秒自检（近一小时自检 K 次）。`
  超时则显示 `⚠ 心跳：…`。

### 13.5 与 driver / 报警的分工

- **time 负责节奏**：turn-end 后 ≤ `idleSec`+tick 粒度（默认 ≤135s）必有一次自检；自检走
  `signals.offer → delivery → bridge.steer`（bridge pump 默认 500ms），空闲时自检约 1s 内变成新回合——
  所以"长时间没有模型调用"应等价于异常，而不是正常等待。
- **静止/重复工具调用报警属于 observer 层**（time 看不到 tool/call）：
  - `tools/loop.mjs`（driver）：断言相邻 `turn/end` 间隔 ≤ `idleSec*1.5+tick`；连续两次同名同参
    `tool/call` 记为 `stuck-repeat`，连续空 turn 计数；
  - `dsh-icl/bridge.mjs` 已把 `turn/start` 也 emit 给插件（13.4；只进插件总线，不影响 prompt/缓存）；
  - lab 的 supervisor 在 `phase=sleeping` 时应静默（night-1 已按此执行），清醒时才做健康监控。
- **部署时机**：不要在睡眠期重启 lab；等 06:39 醒、06:49 dawn 验证完，再由 mc-lab 一次性重启部署
  （宏/装备/awake-tick 一起）。night-1 跑的是旧构建，所以长测报告里会标"awake-tick 未启用"。
- **不要**用 driver 的 sleep/轮询等 turn 来替代节拍：等待在成功/失败时都浪费时间；节拍让"没有事件"
  也产生可预期的工作循环。

### 13.6 测试

`packages/core/test/time-lock.test.mjs`：

- 无 goal：turn-end 后 59s 不自检、61s 自检一次，正文含 `time_status`，`heartbeat` 字段正确；
- 有 goal：只发 goal 续推，不叠加自检（`nextTickAt=null`）；
- 睡眠/静音：期间不自检，醒来/解除后恢复；暂停同样抑制；
- 每小时上限：`maxPerHour:2` 时只发 2 次，`heartbeat.capped=true`；
- capped 降频：超过上限后按 `cappedSec` 检查、`cappedShortWindowSec` 内最多 `cappedShortMax` 条短提示，之后安静；
- `enabled:false` 完全不自检（长跑/测试确定性）；
- `turn-start`：记录 `lastTurnStartAt`，`heartbeat.lastModelCallAt` 取它；bridge 测试覆盖 emit/幂等。

### 13.7 风险与边界

- **成本**：`enabled:true`（默认）意味着醒着时至少每 2 分钟一次模型调用；桌面/lab 用默认，
  本地模型长跑会持续占 GPU——这是用户要的"一直在思考"，但仍由 `maxPerHour`（软上限+capped 降频）兜底。
  night-1 跑的是旧构建（没有 awake-tick）；部署后长测保持开启，正好验证清醒连续。
- **自检循环**：`maxPerHour` 是软上限；如果模型每轮都秒回，turn-end 会不断重置，实际调用频率由模型速度决定，
  不再有节拍叠加。
- **投递失败**：自检依赖 delivery；bridge 不在线时信号会 nack 重试，time 每 `retrySec` 再排一次（不会丢，
  但也意味着没有模型调用时日志会持续出现 retry）。
- **lastModelCallAt**：由 bridge 的 `turn-start`/`turn-end` 共同提供；如果 bridge 未升级（旧宿主），退化为 `lastTurnEndAt`。


---

## 14. 睡眠边界（in-flight turn，2026-11-06 设计/最小实现）

### 14.1 问题与语义

`phase→sleeping` 的瞬间可能还有一轮在飞（她正在"把手里这轮收个尾"）。这条消息（"该睡了"）
本身要靠**在飞 turn 的下一个 step 边界**才被看到，所以：

- **不立即 cancel**：立即 `session/cancel` 会丢掉"收尾"语义，还会产生 tool aborted 噪声；
- **允许边界 turn 自然结束，但有界**：`sleepGraceSec`（默认 120s，从进入 sleeping 起算）。
  grace 内结束 = 合法收尾；超过 grace 仍在跑 → time 发 `sleep-boundary-overrun` 事件
  （driver/supervisor 订阅后可发一次 `session/cancel`，记 `sleep-boundary-cancel`）；
  入睡后出现**新 turn**（边界 turn 已结束后又起来）= 直投/注入嫌疑 → `sleep-boundary-new-turn`。
- 工具层守卫（mc-link）配合：sleeping 时拒绝新 `mcb_join`/新任务，但允许 `mcb_leave`/`mcb_status`/取消当前任务（收尾动作）。

### 14.2 状态与可观测

`state.sleepBoundary`（睡眠中）由入睡瞬间写入：

```json
{"at": 1793…, "inFlight": true, "turnStartAt": 1793…, "turnAgeAtEntrySec": 12,
 "turnEndedAt": null, "turnEndedAfterSec": null, "postSleepTurn": false,
 "overrun": false, "overrunLoggedAt": null}
```

- 边界 turn 的 `turn-end` 到达 → 写 `turnEndedAt/turnEndedAfterSec`；
- `> sleepGraceSec` 仍未结束 → tick 里写 `overrun=true` + log warn + emit `sleep-boundary-overrun`（只发一次）；
- sleeping 期间收到 `turn-start` 且边界 turn 已结束 → `postSleepTurn=true` + emit `sleep-boundary-new-turn`；
- 醒来时归档到 `state.lastSleepBoundary`（带 `endedAt`），`status().sleepBoundary/lastSleepBoundary` 可查；
  `time_status` 在 sleeping 时多一行「睡眠边界：入睡时有在飞回合（已 N 秒，grace M 秒）」或 ⚠ 注入提示。
- 配置：`config.sleepGraceSec`（默认 120，0 表示不报 overrun）。

### 14.3 与 supervisor/driver 的契约

| 事件 | 谁处理 | 动作 |
|---|---|---|
| `sleep-boundary-overrun`（tags: sleep/boundary/overrun） | supervisor/driver | 发**一次** `session/cancel`，记 `sleep-boundary-cancel`；之后不再 nudge |
| `sleep-boundary-new-turn`（tags: sleep/boundary/injection） | supervisor/driver/观测 | 记 violation；检查直投来源（session/prompt 不经过 time gate） |
| 边界 turn 正常结束 | 无 | 计"合法收尾"，validity 里单独列，不算睡眠期模型活动 |

- 名词：`awakeIdleSec/heartbeat.idleSec = now - lastTurnEndAt`；睡眠边界用 `turnEndedAfterSec = 边界 turn 的 turn-end - 入睡时刻`。
- 外部注入方（supervisor/driver/未来连接器）直投前必须读 `time.json` 的 `phase` **和 `lock`**（静音不改 phase），
  或改走 `signals.offer` 让 gate 拦进积压。night-1 2026-11-06 实测：睡眠期 9 条 supervisor 直投（02:09:56–02:11:27），
  不是 time 拦截失败；修复后 0。
- **事件形状（supervisor 消费用）**：`sleep-boundary-overrun` 的 `meta = {afterSec, graceSec}`、
  `sleep-boundary-new-turn` 的 `meta = {at}`；两者都 `from.plugin='time'`, `kind:'event'`,
  `tags` 见上表。睡眠中 `status().sleepBoundary` 与醒来后 `status().lastSleepBoundary`（多一个 `endedAt`）
  字段一致：`inFlight / turnAgeAtEntrySec / turnEndedAfterSec / postSleepTurn / overrun`。
- **grace 口径（2026-11-06 定稿）**：time 默认 `sleepGraceSec=120`，**与 mc-lab supervisor / DSH 适配层同口径**
  （supervisor 可用 `--sleep-grace-sec`/`ICL_SLEEP_GRACE_SEC` 调整；当前双方都是 120s，无需改代码）。
  supervisor 消费 `sleep-boundary-overrun` 只入 anomalies、不重复 cancel（cancel 由 supervisor 本地 grace 触发一次）。
- **文件通道（外部 supervisor 可直接消费）**：signals.emit 只在进程内，不写 `session-events.jsonl`；
  time 额外把可观测事件追加到 `<stateDir>/time-events.jsonl`（一行一个 JSON，`fs.appendFileSync`，不依赖 gate）：
  ```json
  {"at":1793…,"iso":"2026-11-06T…Z","type":"sleep-boundary-overrun","afterSec":125,"graceSec":120,"sleepingId":"night:main-sleep"}
  {"at":1793…,"iso":"…","type":"sleep-boundary-new-turn","at":1793…,"sleepingId":"night:main-sleep"}
  {"at":1793…,"iso":"…","type":"sleep-boundary-turn-end","afterSec":18,"graceSec":120,"overrun":false}
  {"at":1793…,"iso":"…","type":"sleep-boundary-entry","inFlight":true,"turnAgeAtEntrySec":12,"graceSec":120,"sleepingId":"…","sleepUntil":1793…}
  {"at":1793…,"iso":"…","type":"sleep-start","sleepingId":"…","sleepUntil":1793…}
  {"at":1793…,"iso":"…","type":"sleep-end","sleepingId":"…","released":3,"boundary":{...}}
  ```
  配置 `config.eventsFile` 可改路径；文件只追加（事件稀疏，不做轮转）。supervisor 读它做 anomalies 双证据即可——night-1 supervisor 已实现增量消费（commit `4ea7a2b`：offset 落 `time-events.offset`、已消费行另存 `time-events-consumed.jsonl`，映射进 anomalies/strategy）。

### 14.4 测试

`time-lock.test.mjs`：入睡时在飞回合被记录（`inFlight/turnAgeAtEntrySec`）、grace 内结束归档为合法收尾、
超过 grace 只发一次 `sleep-boundary-overrun`、入睡后新 turn 标 `postSleepTurn` 并发事件、醒后 `lastSleepBoundary` 可查。


---

## 15. 红队整改（C2 / C3 / C4，2026-11-06）

> 来源：`docs/REDTEAM-REVIEW.md` C2/C3/C4 + `docs/AUDIT-2026-11-05.md §12` 对照。
> 只改 time/focus 插件；不改 focus gate 裁决语义、不改 bridge。

### 15.1 C2：`focus_enter` 不带 `activity` 不再静默随机

- 旧行为：`activity ?? act:<random>` → 同一件事每轮标签都不同，MC 事件（`focus:'mc'`）永远对不上，全进"别处"积压。
- 新行为（`packages/plugins/focus`）：
  1. 显式 `activity` → 原样使用；
  2. 未给且 **检测到 MC 在线**（`ctx.services.get('mc-link').status().connected`）→ 自动用 `mc`，回执明说"检测到 MC 已连接，已自动设为 mc"；
  3. 否则按标题推**稳定标签** `auto:act:<slug>`（同一标题每次相同），回执带 ⚠ 提示，建议重新 `focus_enter` 并显式给 `activity`；
  4. `focus_status` 对自动标签显示"（标签自动生成，不是显式 activity）"。
- 测试：显式/自动（无 MC）/自动（MC 在线）三种回执与 label 断言（`focus-semantics.test.mjs`）。

### 15.2 C3：持续目标的最小间隔

- 旧行为：每个 turn-end 立刻续推，云端 2 秒一轮 → 50 轮约 2 分钟烧完。
- 新行为：`config.goalResumeMinGapSec` 默认 **60s**；同一 goal 在间隔内只记 `resumeDueAt`，由 tick 到点补发；续推消息带"第 N 次续推"；`turnLimit`/`resumeLimit`/`goalMaxAgeMs` 仍照旧收尾。`0` 可恢复旧行为。
- 与清醒节拍的关系：被节流时本轮没有 goal 续推，turn-end 会照常 arm 清醒节拍；goal 的 due 通常先到，二者不会叠加发消息（同一批 drain 也会合并）。
- 测试：连发两个 turn-end 只发第 1 次、tick 到 gap 补第 2 次；`gap=0` 保持旧行为（`time-lock.test.mjs`）。`time_arrange` description 已写明节奏。

### 15.3 C4：醒来简报 + dream 回执（已实现）

- 醒来消息现在 = `endMessage` + 一行 **睡眠简报**（同一批投递，顺序：结束语→简报→积压摘要）：
  `（睡眠简报：睡了 4 小时 30 分；积压 17 条（mc 17）；记忆整理：入睡时已触发（dream 回执未回传）；无异常）`
  - 时长来自入睡时刻；积压条数与来源来自 `queue`（按 plugin 计数）；异常 = 边界超时/入睡后新回合 + 睡眠期间新增的漏响/丢弃/过期。
- `status().lastSleepBrief` 可查（`{text,durationSec,backlog,sources,anomalies,dream,startedAt,endedAt}`）；`time-events.jsonl` 落 `sleep-brief-start` / `wake-brief`。
- **dream 回执（已实现：dream emit，commit `60d8abe`）**：一次 run 一条
  `signals.emit({from:{plugin:'dream'},kind:'event',text:'wash 1119 行 / …',tags:['dream-result'],meta:{ok,jobs,degraded,failedShards,at}})`；
  全 skip 不发、失败 `ok:false`。time 已订阅并消费：
  - 睡眠中收到 → 记 `status().lastDreamResult`（`{ok,text,jobs,ranJobs,degraded,failedShards,dreamAt,at}`），**并入醒来简报**：
    `记忆整理：完成（wash 1119 行 / events 3 块；分片降级（1 片失败））` 或 `记忆整理：失败（原因）`；
  - 醒着收到 → 直接发一条可读 notice（`记忆整理回执：完成/失败（detail；分片降级…）`）；
  - 一直没收到回执时简报显示"入睡时已触发（dream 回执未回传）"，不假装成功。
- `time-events.jsonl` 也会落 `dream-result {ok,text,jobs,ranJobs,degraded,failedShards}`，supervisor/早报可直接消费。
- 测试：正常醒来简报内容/顺序/计数；dream 回执（含 degraded/失败分片）+ 边界超时进简报；醒着收到失败回执发 notice（`time-lock.test.mjs`）。

---

## 16. 暂停 / 危险穿透语义（用户 2026-11-06 拍板）

> 用户原话："将游戏在线时的危险作为穿透消息唤醒会话并自动规避危险，模型能选择暂停去干别的，但是一出事一定会被通知。"
> 结论：**暂停不能吞 alarm**；只有显式静音（mute）与睡眠（sleep）可以拦，且都必须留痕。

### 16.1 四态 × 两类消息（time gate 的实际行为）

| 状态 | 普通消息 | 危险消息（tags 命中 `emergencyTags`） |
|---|---|---|
| `awake` | 投递 | 投递 |
| `paused`（phase）或外部 `pausedMode.active` | 进积压 `reason:'paused'` | **穿透并叫醒会话**；记 `lastPierce`、`time-events pause-pierce` |
| `sleeping` | 进积压 `reason:'sleeping'` | **不叫醒**；进积压 `priority:'alarm'`，记 `lastBlockedAlarm`/`sleep-alarm-buffered`，醒来简报**第一条**呈现（`⚠ 睡眠期间有 N 条危险/紧急事件…`），积压摘要里排最前 |
| `lock`（mute，显式静音） | 进积压 `reason:'muted'` | **默认也拦**（`emergencyQuota=0`），记 `lastBlockedAlarm`/`alarm-blocked`；显式 `emergencyQuota`/`allow` 才 opt-in 放行 |

优先级：`mute > sleeping > paused`（显式静音最硬；mute 在 sleep 期间也压过睡眠白名单）。

### 16.2 两种"暂停"（别混）

- **`phase='paused'`（time 自己的 pause，测试/维护后门）**：冻结 time 计时（spans/goal.until/一次性安排/lock 后移），普通消息积压；**危险仍穿透**。
- **外部 `pausedMode.active`（用户语义：任务停止、世界继续）**：**不冻结 time 计时**（schedule/sleep 照常跑），只改变投递裁决；由 mc-body/mc-link 在 `mcb_stop` / 危险暂停时调用。
  - API：`ctx.services.get('time').setPausedMode({active, reason, source})`；控制后门 `inbox {cmd:'pause_mode', args:{active:true,reason:'mcb_stop',source:'mc-link'}}`。
  - 状态：`status().pausedMode = {active, phasePaused, external, reason, since, source, worldContinues:true, alarmsPierce:true, lastPierce, lastBlockedAlarm}`；`time_status` 输出"暂停（来源：原因）：任务停止、世界继续；危险（alarm/safety）会穿透并叫醒你；最近穿透：…"。
  - `time` 事实段在暂停时补一句事实：`…（任务已暂停、世界继续；危险事件会穿透）`。

### 16.3 与 `mcb_stop` 协同（语义保留，不静默清空）

- time 侧**不会**因为暂停/stop 清空 `goals`、`focus`、`schedules`、`queue`；`time_status` 在暂停时列出"保留：目标 id/专注标题"，并提示"继续用 `time_resume`/`focus_leave`；离开用 `time_cancel`"。
- `mcb_stop`（mc-body/mc-link）应当：停任务 → 调 `time.setPausedMode({active:true, reason:'mcb_stop', source:'mc-link'})` → 之后危险事件仍会被 time 放行并叫醒；恢复时 `setPausedMode({active:false})`。不要替 she 取消 goal/focus（那是 `time_cancel`/`focus_leave` 的显式选择）。

### 16.4 可观测

- `status().lastPierce`：最近一次危险穿透（`{at, plugin, activity, tags, text, context: pause|mute-quota|sleep-allow|mute-allow}`）——mc-body/mc-link 文案可引用"最近一次穿透：xx"。
- `status().lastBlockedAlarm`：最近一次危险被拦（`reason: sleeping|muted`）。
- `time-events.jsonl` 新类型：`pause-on` / `paused-mode-on|off` / `pause-pierce` / `alarm-blocked` / `sleep-alarm-buffered` / `wake-brief`（含 alarms 计数）。
- `time_status` 暂停行、`lastSleepBrief.alarms = {count, sources, samples}` 可查。
- **识别口径（与 mc-body 对齐）**：危险 = tags 命中 `emergencyTags` **或** `meta.pierce === true` **或** `meta.priority === 'alarm'`。mc-body 的事件 payload 带 `priority:'alarm'`/`pierce:true`，即使来源没打 alarm tags，暂停也会穿透、睡眠也会进最高优先级积压。
- **补投边界（与 mc-link `pendingAlarms` 对齐）**：time 对 blocked 的 alarm 已持久化（sleep 进最高优先级积压、mute 记录 lastBlockedAlarm），来源侧**不要**把被 time gate 拦下的 alarm 再补投一次；`mcb_status` 的"危险补投：N 条"只应反映 offer 异常/重启丢信号，否则醒来会出现"积压一条 + 补投一条"两份。\n- **与 mc-body 对账字段**：body `status.safety.alarms = {delivered,suppressed,redelivered,pending}` ↔ time `lastPierce`/`lastBlockedAlarm`。body 对危险事件有 15s 去重：被拦会在 `alarm_suppressed` 计数并在窗口后补投（`redelivered:true`）——所以 body `suppressed > 0` 不等于 time 漏收，以补投后的 `delivered` 为准。
- body 暂停时 `pausedReason:'user-stop'` ↔ time `pausedMode.source/reason`；body 的 `status.safety.reflex`、`status.playable`、`status.spawnLog` 是只读对齐字段，time 不复制它们，避免两套口径。

### 16.5 测试

`time-lock.test.mjs`：
- pause 下 alarm/safety 穿透并记录 `lastPierce`，普通消息 `reason:'paused'`；
- 外部 `pausedMode` 不冻结 time 计时（暂停中安排照常响），alarm 穿透；
- 睡眠中 alarm 不叫醒、`priority:'alarm'`、醒来简报第一条且积压排序最前；
- mute 默认连 alarm 也拦并记录；显式 `emergencyQuota` 才放行；
- 暂停时保留 goal/focus 并输出"继续/离开"选项。

---

## 17. fast-play：immediate 清醒节拍（2026-11-06，用户最高优先级"慢"）

> 用户要求："**玩游戏不该刻意等待；无等待，除非 agent 自愿等待**；操作结束或被异常打断后要立刻反应。"
> 旧实现的问题：`awakeIdleSec` 下限 15s、`awakeMaxPerHour=60`、且只在 15s 一次的 tick 里检查 due
> → 最快反应也是 15–135s，做不到"操作结束 ≤10s 决策"。

### 17.1 设计

- **模式**：`config.awakeTick.mode: 'normal' | 'immediate'`（默认 normal，不影响现有部署）。
- **immediate 触发**：每个 `turn-end` 后 `armAwakeTick()` 的延迟 = `minIdleSec`（默认 **1s**，下限 0.2s）；
  独立 `setTimeout`（`awakeTimer`，unref + dispose 清理）负责 ~1s 精度，不再依赖 15s tick 循环。
- **一次自检=一次机会，不空转**：immediate 下发完 `awake-tick` 后把 `awakeTickDueAt=null`，等这轮
  turn-start→turn-end 再 arm；若 bridge 没把 notice 变成回合，则没有后续自检（`heartbeat.state='overdue'` 可见）。
- **安全退避**：连续 `immediateBackoffAfter`（默认 **20**）次 immediate 自检，期间没有任何
  "外部信号 / 任务事件" → `awakeTick.backoff=true`，之后按 `backoffSec`（默认 **30s**）节拍；
  记 `awake-backoff` 事件 + `warn` log，`heartbeat.backoff/streak/backoffSec` 可查。
- **恢复 immediate**：以下任一发生即 `noteExternalActivity()` → streak 清零、backoff=false、记 `awake-recover`：
  - gate 收到非 time 来源的信号（mc/qq/delivery 等，不论 accept 还是进积压）；
  - goal 续推发出（`goal-resume`）；
  - 安排到点触发（`schedule:<id>`）；
  - 控制后门命令（`inbox:<cmd>`）。
- **上限**：immediate 默认 `maxPerHour=3600`（≈不限）；normal 仍是 60。命中时保留原 capped 降频逻辑。
- **overdue 口径**：immediate 下 `overdueSec` 默认 10s（不能用 `idleSec*1.5=1.5s` 判，会一直误报）。
- **文案**：去掉"看 status 决定下一步"的教学；长文本 `清醒节拍：距上次回合结束 N 秒[；积压 N 条][；目标 g-…]。继续。`
  短提示 `清醒节拍：继续（醒着 N 秒，仍在等你）。`
- **反应时延可观测**：
  - `heartbeat.decisionCycleSec` = 最近一次 `turn-end → 下一 turn/start` 的秒数（每次 turn-end 后第一次 start 记一次，写 `decision-cycle` 事件）；
  - `heartbeat.reactionLatencySec` = 外部信号/task 到达（gate 层）→ 下一 turn/start 的秒数（写 `reaction-latency` 事件）；
  - `heartbeat.reactionPendingAt` 表示"有信号到达但还没起回合"。
  - `time-events.jsonl` 新增：`awake-tick`（含 mode/streak/backoff/decisionCycleSec）、`awake-backoff`、
    `awake-recover`、`decision-cycle`、`reaction-latency`。

### 17.2 preset（mc-lab 配，time 侧不改 preset）

`icl-e2-fast` / `icl-e2-local` 用：
```yaml
pluginConfig:
  time:
    goalResumeMinGapSec: 0
    awakeTick: { enabled: true, mode: immediate, minIdleSec: 1, immediateBackoffAfter: 20, backoffSec: 30, timer: true }
```
（`timer` 生产默认 true；测试/loop 脚本可 `timer:false` 用 `api.tick()` 得确定性。）

### 17.3 测试

`time-lock.test.mjs`：
- immediate turn-end 后 ~1s 触发（500ms 不触发、1.2s 触发）、`maxPerHour` 默认 3600、文案含"继续"且不含 `time_status`/`决定下一步`；
- 连续 20 次无事件 → `heartbeat.backoff=true`、due 推到 ~30s、退避期 1s 不自检；外部信号到达 → backoff=false、恢复 ~1s；
- `decisionCycleSec`（turn-end→下一 start）与 `reactionLatencySec`（信号→下一 start）数值正确，且 `time-events` 有 `decision-cycle`/`reaction-latency`。

### 17.4 风险与边界

- immediate 会显著提高模型调用频率（本地模型可接受；云端注意成本）——退避 + 可 `enabled:false` 兜底。
- `awake-tick` 仍可能被 focus gate 拦成 focus backlog（focus 语义，不是 time 静默）；`duringFocus:false` 可关专注期自检。
- bridge 若没把 notice 变成回合，immediate 不会自我重试（等下一次真实 turn-end）；`heartbeat.overdue` 会暴露。
- 计时精度依赖进程 event loop；timer `unref` 不影响宿主退出。

---

## 18. 渐进式唤醒（compactWake，lab-only，2026-11-07）

> 用户批准 B（含 QQ 唤醒纳入、`fullEvery=20`）；设计细节 `docs/PROMPT-WAKE-DESIGN.md`。
> lab-only、默认关闭；只压"唤醒提示 orientation"，**payload 一律原样保留**（未读/积压/危险/sleep brief）。

- 配置：`time.compactWake = { enabled:false, after:1, maxChars:400, fullEvery:20, allowPayload:true }`。
- `wakeCount`（time state）：schedule wake（含睡醒）、goal resume、awake tick、manual wake 实际投递后自增；QQ 唤醒由 qq 通过 `ctx.services.get('time').wake.bump()` 计入。
- 模式：`wakeCount=0`（首次/睡醒后第一声）→ **full**；之后 → **compact**；`fullEvery>0` 时 `wakeCount % fullEvery === 0` 再插一次 full（默认 20，防漂移）。
- 睡醒：`endSpan` 先 `resetWakeCount()`，第一声 full（重置语义与"早上重新定向"一致）。
- compact 模板（6 行 ≤`maxChars`）：`〔提醒〕你在 ICL（小千）。/ 现在：…，… / 焦点：…；目标：… / 积压：N 条（危险 M 条已置顶）/ 上次：… / 继续；下面的新内容优先。`，末尾 `\n---\n` + 原样 payload。
- 积压释放只压 preamble（`（reason）积压 N 条（危险 M 条置顶）：`），条目正文与 ⚠ 置顶不变。
- 可观测：`status().wake={enabled,count,nextMode,stats,lastWakeAt,config}`；`time-events` 的 `wake-class {producer,mode,chars,count}` / `wake-reset`。
- 共享 API：`time.wake.count/bump/reset/stats/enabled/mode/shouldCompact/config`；`time.wake()` 仍是手动结束睡眠的函数（兼容）。
- 测试：`packages/core/test/compact-wake.test.mjs`（默认关、首次 full、6 行 ≤400、payload 原样、fullEvery=20、睡醒 reset、goal payload、backlog preamble、事件/API）。
- 已知限制：time 看不到 assistant 原文，time 生产的 compact 里"上次"只能写"刚醒/刚连上"；真实 assistant 摘要需 bridge/qq 传入（A/B 结果里标注）。
