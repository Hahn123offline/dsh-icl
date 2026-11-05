# 时间与信号（契约版）

> 读者：要改时间/节律逻辑、要验证"她什么时候醒、醒来算什么、静音能不能挡住"的人。
> 范围：`packages/plugins/time/src/index.mjs`、`packages/core/src/{signals,services,host}.mjs` 的拦截/投递段、
> `tools/loop-host.mjs`、`tools/scenarios/loop-s2-time.json` / `loop-s4-sleep.json` / `loop-s5-mute.json`。
> 状态机、`arrange` 语法、inbox 命令、静音锁语义**只在本文件写**，别处只引用这一份。
> 最后核对：2026-11-05（与代码同步；上一版 2026-11-03 的"已知问题"大部分已修，见 §10）。

---

## 0. 契约：四个问题

时间模块回答且只回答四件事（用户原话）：

| 问题 | 谁回答 | 事实源 |
|---|---|---|
| **我什么时候被唤醒？** | `schedules`（时间轴）：single / daily / weekly / 倒计时 | `state/time.json` 的 `schedules` + `fired` |
| **醒了要干什么？** | 唤醒消息、备注、标签、silent；睡眠/静音期间的积压 | `queue` + `spans` |
| **接下来如何行动？** | `goals`（会话轴）：到点建目标、turn-end 续推、上限、取消 | `goals` + focus 租约 |
| **更长期的日程？** | 每天/每周重复、编辑、取消、清单可读性 | 同 `schedules` |

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
3. `phase === 'paused'` → 入队 `reason:'paused'`。
4. `lock` 生效（静音）→ `lock.allow` 命中放行；紧急事件在独立配额内放行（每次放行记 `lock.emergency.log`），超配额入队 `reason:'muted-quota'`；其余入队 `reason:'muted'`。**静音优先于睡眠白名单。**
5. `phase === 'sleeping'` → 活动 span 的 `allow` 命中放行；其余入队 `reason:'sleeping'`。白名单默认 `[{from:'admin'}]`（`from/kinds/tags/any` 任一规则全字段匹配即放行）。

补充：
- `allow: []` 表示**没有**白名单（除 time 自己和静音锁规则外全拦）；`allow:null` 才回落默认。
- 积压有界：`maxQueue` 默认 500。溢出时**优先丢最旧的 ambient 消息**（没有 `mention/at/private/direct/admin` 标签的），@/私聊优先保留；全都被保护时丢最旧一条；`stats.dropped/overflow` 计数并 log，`time_status` 可见。
- 同一条信号（`signal.id` 相同）重复 offer 不重复入队；条目保留 `signalId`。
- 释放：`flushQueue` 只在 `awake` 时真的发送；文本有界（前 20 条 + 来源计数，默认上限 3000 字），前缀保持 `[plugin/activity]`；`expiresAt` 过期显式丢弃计数；**发送失败不清队列**。
- 去重：同一天同一安排 `fired` 只响一次；积压条目有 `id` 可 `skip`。

### 4.1 静音锁（新）

`mute({minutes, until, reason, allow, emergencyQuota})`：

- 默认 30 分钟，最长 `maxMuteMs`（默认 8h）——超时到点**自动解除**并释放有界积压摘要，不会把系统永久卡死；解除时发 `mute-end` 事件。
- 紧急事件 = 带 `tags` 里的 `emergencyTags`（默认 `alarm/safety/emergency`）；`emergencyFrom` 配置可把来源收敛成显式插件白名单（默认 null=不限制）。
- 可查：`time_status` / `status().lock` / `inbox lock`；可恢复：`time_unmute` / inbox `unmute`。
- 状态与积压摘要里 **sleep 与 mute 可区分**：`phase` 与 `lock` 分开、积压条目带 `reason`、`time_list` 显示 `（sleeping）/（muted）/（muted-quota）`。
- 对外接口（QQ/MC 等来源）：gate 返回 `{accept:false}` 之前内容已经 `enqueue()` + `persist()`，不存在"offer 说 blocked 但没落盘"的窗口；来源侧**不需要自己兜底暂存，也不要重试被拦信号**（重复 offer 会按 `signalId` 去重）。重放时保留 `[plugin/activity]` 前缀。
- 静音期间 time 自己的闹钟与目标续推照常（"静音只关外部打扰"）；玩家在 DSH GUI 里直接说话不经过 signals，仍能直达。

### 4.2 穿透与伪造：风险边界

- `from.plugin === 'time'` 是**身份字段**，同进程插件理论上可伪造；本轮靠"进程内插件都是自家代码"兜底，不把它当安全边界。
- `tags:['alarm']` 同理：任何插件都能给自己的信号打紧急标签。已做：`emergencyFrom` 显式白名单可收敛来源；`focus.admit` 的 `alarm` 特权是 core 现有行为（本轮不改，见 §9）。
- **已堵的结构洞**：插件直接 `ctx.delivery.push` 会绕过 signals gate。现在 delivery 有 push-time gate（`delivery.setGate`），time 在 delivery 上再装一层：`channel==='signal'` 视为"已过 signals gate"放行，其余按当前相位/静音锁裁决，被拦的进 time 积压（不丢）。focus 的积压摘要也从 `delivery.push` 改为 `signals.offer`（gate + focus.admit 双重裁决）。
- 多 gate：`signals.addGate` / `delivery.addGate` 组合裁决（全部 accept 才放行），卸载只摘自己那层；旧 `setGate` 仍是替换语义。time 在 tick 里自愈：发现自己的 gate 被整体替换会重新安装并 log。

---

## 5. 目标（会话轴）

- 来源：`time_arrange {mode:'goal', ...}`（到点建）、`goal_add`（立即建）。`addGoal` 接受 `until`（ISO/HH:mm/in 式）、`afterMin`、`durationMin`、`in`、`turnLimit`、`resumeLimit`、`focus`、`resumeOnStop`。
- 目标消息带 **id / theme / 剩余轮次 / 到期时间**：`你在目标内：<theme>（还剩 N 轮，到 …）。id=g-xxx，不用时用 time_cancel 取消，别留着空跑。`
- 每个 `turn-end`（`signals.on({tags:['turn-end']})`，只在 awake 时）续推一次；在 `until` 到期、`turnLimit` 用完、`resumeLimit`（默认 50）或 `goalMaxAgeMs`（默认 8h）到上限时发**明确的"目标结束：…（原因）"**并释放 focus——不是静默停止。
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
| `time_status` | 现在/阶段/睡到/静音到/下一个安排/进行中/目标 id/积压/漏响 |
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
