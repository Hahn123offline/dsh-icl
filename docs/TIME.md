# 时间与信号

> 读者：要改时间/节律逻辑，或要用控制通道手工驱动一轮测试的人 / 范围：`packages/plugins/time/src/index.mjs`（618 行）、`packages/core/src/signals.mjs`、`packages/core/src/session.mjs`、`packages/adapters/delivery-pump.mjs` / 最后核对：2026-11-03
>
> **状态机、`arrange` 语法、inbox 命令、tick 循环只在本文件写**，别处只引用这一份。全部结论对着代码核过。
>
> 本文件合并了五份旧设计稿（`TIME-MODULE` / `TIME-CONTROL` / `IMPL-TIME` / `MESSAGE-MODEL` / `MESSAGE-CHANNELS`，均已删除）。
> 下文凡说"旧文档写 Y"，指的就是这批设计稿：它们记录的是当时的意图，代码从未那样实现。

## 1. 它要解决什么

1. **她需要知道现在几点**——`ctx.now()` 是唯一时间源（`index.mjs:445`），time 启用后由 `clock` 服务接管，其它插件不得自己读系统时间。
2. **什么时候睡、睡多久**——那是一条 `mode:'wake' + kind:'span' + sleep:true` 的安排：到点把 `phase` 切成 `sleeping`、发一句"该睡了"、把结束时刻记进 `spans[].until`；睡眠期间非白名单信号全部进 `queue`。
3. **醒来时积压了什么**——`endSpan` 把 `queue` 一次性成批放出去，正文以"（你睡觉时）积压了 N 条消息"开头，逐行带来源与原文（`index.mjs:174-184`、`291-305`）。

为什么不能靠模型自己记时间：模型只在被投递消息的那一刻存在，两次唤醒之间没有执行体，也没有"到某刻把自己叫醒"的能力；`turn-end` 之后会话就静止了。所以时间必须是**进程外的持久状态 + 定时器**（`state/time.json` + `setInterval(tick, tickMs)`），由插件判定"到没到点"，模型只负责读状态和写安排。

## 2. 状态机与两个轴

```js
const PHASES = ['awake', 'sleeping', 'paused']   // index.mjs:21
```

**没有 `asleep`**。`role:'sleep'` 也不是字段：旧 `IMPL-TIME` 设计稿的 M2 把日程写成 `at/role/message/durationMin/allow[]`，代码里没有 `role`，传进来会被 `normalizeSchedule`（72-97）直接丢掉（`packages/core/test/time.test.mjs:55` 仍在传这个字段）。

| 字段 | 含义 | 代码 |
|---|---|---|
| `phase` | `awake` / `sleeping` / `paused`，启动时非法值回落 `awake` | 21, 113, 118 |
| `since` | 最近一次"阶段意义变化"的时间戳：入睡、醒来、resume 时更新；`pause()` **不**更新 | 263, 297, 345 |
| `schedules` | 全部安排，持久；响过的一次性安排不会自动删除 | 309, 371 |
| `spans` | 进行中的长日程 `{id, until, endMessage, sleep}`；只有 `wake+span` 产生，`goal` 不进这里 | 274-279 |
| `queue` | 被 gate 拦下的积压 `{id, from, kind, text, tags, focus, reason, at, expiresAt}`，`reason` ∈ `paused`/`sleeping` | 153-160 |
| `goals` | `{id, theme, until, turnLimit, focus, resumeOnStop, createdAt}` | 201-208 |
| `fired` | 幂等键 `"<id>@<YYYY-MM-DD>" → ms`，按天，只增不删 | 286, 375 |
| `sleepingId` | 正在生效的睡眠日程 id；gate 用它找回白名单 | 166-167, 259, 293 |
| `sleepUntil` | 睡眠结束时间戳，只用于展示与暂停后移；判定用 `spans[].until` | 264, 342, 355-357 |

安排只有两个正交轴（`index.mjs:5-14`）：`mode = wake | goal`（叫她一声 / 让她持续做），`kind = single | span`（一条消息 / 有始有终）。四种组合的实际行为：

| mode | kind | 代码行为 | 发出几条消息 |
|---|---|---|---|
| `wake` | `single` | 到点 `send({kind:'wake'})`，不记 span | 1 |
| `wake` | `span` | 开始时一条 + 记 `spans`；到点 `endSpan` 再一条 | 2 |
| `goal` | `single` | 建 goal，上限只有 `turnLimit`；每次 `turn-end` 重发一条 | 1 + 每次 turn-end |
| `goal` | `span` | 建 goal 且带 `until`；到期发"目标结束"并卸载 | 1 + 到期 1 条 |

`schedules` 与 `goals` 是两条独立的轴，别混：`schedules` 是**时间轴**，只由 tick 到点推进（`startSchedule`，248-289）；`goals` 是**会话轴**，靠 `turn-end` 续推（`resumeGoals`，228-246）。一条 `mode:'goal'` 的安排到点后会往 `goals` 里多出一条（它自己仍留在 `schedules`）；而 `goal_add` 直接建的 goal 完全不在 `schedules` 里——所以 `time_list` 看不见它，只有 `time_status`/`status` 看得见。同理 `spans` 是"正在跑的那一份副本"：`time_edit` 改 `schedules` 不动它（见 §8）。

状态转移（全部转移点都在 `index.mjs`）：

```
  awake ──①──▶ sleeping          ① 到点触发 arrange{mode:'wake',kind:'span',sleep:true}
    ▲             │
    └──────②──────┘               ② span.until 到点 endSpan()；或 api.wake() / time_cancel(span.id)

  awake ──③──▶ paused            ③ pause() / time_pause 工具 / inbox pause
  sleeping ─③─▶ paused
  paused ──④──▶ sleeping | awake  ④ resume()：看 sleepingId 还在不在（344）
  任意 ───⑤──▶ awake             ⑤ inbox reset（427）／启动读到非法 phase（118）
```

`sleeping` 下 gate 的判定：先看 `from.plugin === 'time'`（自己的消息永远放行，163），否则取 `sleepingId` 对应日程的 `allow`，空则用默认 `[{from:'admin'}]`（20, 167）。拦截结果只有两种：放行，或入队 + `{accept:false, reason}`。

## 3. `time_arrange` 的语法

工具 schema 在 `index.mjs:532-546`（`additionalProperties:false`，`required:['mode']`），落地函数是 `normalizeSchedule`（72-97）。

| 参数 | 类型 | 代码里的真实语义 |
|---|---|---|
| `mode` | `'wake'\|'goal'` | 唯一必填；非 `'goal'` 一律按 `'wake'`（73） |
| `kind` | `'single'\|'span'` | 可省。`sleep:true` 或给了 `duration`/`until` 时**强制** `span`（81） |
| `at` | 字符串 | `HH:mm`（每天）／ISO／`'now'`；解析见 `parseAt`（28-37） |
| `in` | `'10m'`／`'2h'`／分钟数字 | 起点 = now + in（`parseIn` 39-46）。**同时给 `at` 时 `at` 赢**（75） |
| `duration` | `'8h'`／`'30m'` | span 时长，落成 `durationMin`（整数分钟，87） |
| `message` | 字符串 | `wake` 的正文；`goal` 的 theme 兜底（89-90） |
| `theme` | 字符串 | `goal` 主题，缺省回落 `message` |
| `focus` | 字符串 | `goal` 绑定的注意力空间，`addGoal` 里 `focus.enter()`（210-212） |
| `turnLimit` | 数字 | `goal` 轮次上限，每次 resume 减一（239） |
| `sleep` | 布尔 | 睡眠标记：切 `phase`、进白名单模式、发 `sleep-start` 事件（260-282） |
| `allow` | 对象数组 | 睡眠白名单，规则字段 `from`/`kinds`/`tags`/`any`（`allowMatch` 57-69） |

schema 之外、代码支持但**只能走 inbox** 的参数：`until`（ISO，79-80）、`id`（83）、`inMinutes`、`durationMin`。工具面因 `additionalProperties:false` 传不进来。

```bash
# 起床闹钟：每天 07:30 一条消息（HH:mm 即「每天」）
node tools/time.mjs arrange '{"id":"morning","mode":"wake","kind":"single","at":"07:30","message":"早上了，起来吧"}'

# 睡一段：3 分钟后开始，睡 3 分钟；只有 admin 和带关键词的 qq 能穿透
node tools/time.mjs arrange '{"id":"nap","mode":"wake","kind":"span","sleep":true,"in":"3m","duration":"3m","message":"你困了，去睡吧","allow":[{"from":"admin"},{"from":"qq","any":["着火了","醒醒"]}]}'

# 每天 23:00 睡 8 小时：daily + span，endMessage 是醒来那句
node tools/time.mjs arrange '{"id":"night","mode":"wake","kind":"span","sleep":true,"at":"23:00","duration":"8h","message":"你困了。接下来 8 小时不会有人打扰你。"}'
```

模型侧同一个调用是 `time_arrange({mode:'wake', kind:'span', in:'10m', duration:'30m', message:'…'})`。注意 **arrange 只写 `schedules`，不立即发送**：`at:'now'` 也要等下一个 tick（≤ `tickMs`）才真正 `startSchedule`。

## 4. 七个工具

| 工具 | 参数 | 返回 | 副作用 |
|---|---|---|---|
| `time_status` | — | `{text}`：现在／阶段／进行中／目标／积压 | 无（纯读 `api.status()`） |
| `time_arrange` | §3 的参数表 | `{text: '安排好了：<id>（mode/kind，at…）'}` | 写 `schedules` + `persist()`；不发送 |
| `time_list` | — | `{text}`：进行中的 span + 全部安排；空则"还没有安排。" | 无（`schedules()` 会剥掉 `__parsed`） |
| `time_edit` | `id`（必填）, `at`, `in`, `message`, `mode`, `duration` | `{text: '改好了：<id>' / '没有这个安排：<id>'}` | 整条重新 `normalizeSchedule` 后替换；**改不动已开始的 span** |
| `time_cancel` | `id`（必填） | `{text: '结束了／取消了／目标已取消／没有这个安排'}` | 命中 span → `endSpan`（发结束语、释放 sleep 租约、醒来的话 flushQueue）；否则删安排；否则删 goal 并释放它的 focus 租约 |
| `time_pause` | — | `{text:'已暂停计时。'}` | `phase='paused'`、内存记 `pausedAt`、`persist()`；此后 tick 直接 return |
| `time_resume` | — | `{text:'恢复了，释放了 N 条。' / '当前不是暂停状态：<phase>'}` | `spans[].until` 与 `sleepUntil` 整体后移暂停时长，`flushQueue('暂停期间')`、`persist()` |

七个工具名与 `manifest.json` 的 `tools` 完全一致（无多无少）；`goal` 没有独立工具，全部走 `time_arrange {mode:'goal'}`。

## 5. tick 循环与落盘

- **`tickMs` 默认 15000**，下限 1000（`index.mjs:103`）；`setInterval` + `void tick()`，`unref()`（605-610），`onDispose` 时 `clearInterval`。
- **tick 顺序**（351-381）：`processInbox()` → `phase==='paused'` 直接 return → 结束到期 span → 清理到期 goal → 触发到点 schedule → `persist()`。
- **状态文件**：`config.stateFile`，缺省 `<config.root ?? '.'>/state/time.json`（100-102）。仓库里**没有** `state.json` 这个文件——状态文件就叫 `time.json`。
- **inbox / outbox**：与状态文件同目录，`time.inbox.jsonl`（只读）／`time.outbox.jsonl`（只追加）（104-105）。
- **读 inbox**：整文件读入 → `text.length < inboxOffset` 时把游标归零（387）→ 只解析 `slice(inboxOffset)` → 逐行 `JSON.parse`，坏行静默跳过（396）→ 先推进游标再执行（390），所以执行抛错不会重读。**游标只在内存里**（106），重启从 0 开始（后果见 §8）。
- **写 outbox**：每条命令追加一行 `JSON.stringify({id, at, ...runCommand结果})`（404-407），即 `{id,at,ok,result}` 或 `{id,at,ok:false,error}`。
- **persist**：`mkdirSync -p` + `writeFileSync(stateFile, JSON.stringify(state,null,1))`（142-147）；**原地覆盖，无临时文件、无 rename、无锁**。
- **异常落盘**：tick 抛错 → `tick-error.json`（607）；命令执行抛错 → `inbox-error.json`（401）。两个文件都在状态文件同目录、都是 `writeFileSync` 覆盖写（只留最后一次）。注意文件名是 `inbox-error.json`，不带 `time.` 前缀（`code-groundtruth.md` §5.2 写成 `time.inbox-error.json`，与代码不符）。
- 启动时还有一次特殊动作：`if (state.queue.length) flushQueue('日程因重启发生错误')`（439），即重启先把上次的积压当"出错"放掉，再装 gate（441）。

## 6. 控制通道（文件邮箱 + CLI）

CLI 只做三件事：`fs.appendFileSync(inbox, JSON.stringify({id, cmd, args, at}))`（`tools/time.mjs:45`）、轮询 outbox 找同 `id` 的回执、打印。参数：`--state <time.json>`（也认 `ICL_TIME_STATE`，25 行）、`--wait <ms>`（默认 20000）、`--no-wait`。

```bash
node tools/time.mjs status
node tools/time.mjs resume
node tools/time.mjs pause --no-wait
node tools/time.mjs arrange '{"mode":"wake","kind":"single","in":"10m","message":"该出门了"}'
node tools/time.mjs status --state C:/DSH/qwenstuff/icl/state/time.json --wait 5000
```

inbox 命令全集（`runCommand`，`index.mjs:413-437`，未列出的返回 `{ok:false,error:'未知命令：X'}`）：

| cmd | args | 一句话 |
|---|---|---|
| `status` | — | 返回 `api.status()`：phase/since/sleepUntil/spans/schedules/backlog/goals |
| `pause` | — | 暂停计时；此后 tick 只处理 inbox |
| `resume` | — | 进行中的 span 与 `sleepUntil` 后移暂停时长，按 `sleepingId` 回到 sleeping 或 awake，并放出"暂停期间"的积压 |
| `arrange` | 同 `normalizeSchedule`（含 `id`/`until`，不校验字段） | 新建/覆盖一条安排，等 tick 到点才发 |
| `cancel` | `{id}` | 只删 `schedules` 里的安排；进行中的 span 与 goal 都不动 |
| `edit` | `{id, ...patch}` | 用 patch 覆盖旧安排后重新 normalize（`in` 会被旧 `at` 吃掉，见 §8） |
| `skip` | `{id}` | 从 `queue` 里删一条积压（仅本次） |
| `queue` | — | 返回积压数组的副本 |
| `reset` | — | `state = blank()`：phase→awake，清空 schedules/queue/goals/spans/fired |
| `goal_add` | `{theme, until\|durationMin, focus?, turnLimit?, resumeOnStop?}` | 建 goal + 发一条 goal 消息；带 focus 则进入该空间 |
| `goal_remove` | `{id}` | 删 goal 并释放绑定的 focus 租约 |
| `goal_list` | — | 返回 goals 数组副本 |

回执格式（`index.mjs:406`，`tools/time.mjs:51-57` 按 `id` 精确配对）：

```json
{"id":"c-1793772-412","at":1793772400000,"ok":true,"result":{"phase":"awake","backlog":1}}
{"id":"c-1793772-412","at":1793772400000,"ok":false,"error":"未知命令：arm"}
```

**正确顺序：先起会话，再下命令。不要预写 `time.json`。** 因为插件 `apply` 会先读状态文件、对 `schedules` 做一次清理（删掉 10 分钟前的一次性安排，124-134），并在装好 gate 之前把已有 `queue` 当"重启错误"释放（439）；预写进去的内容会被这套启动逻辑改写或丢弃，而 CLI 的 `--state` 若没指向会话真正用的那个文件，命令只会写进另一个目录、永远等不到回执（20 秒后 `exit 1`）。

`tools/time.mjs` 头注释（1-14 行）列的 `arm` / `sleep` / `wake` **不是命令**：`runCommand` 里没有这三个分支，会得到 `未知命令` 与退出码 1。旧 `TIME-CONTROL` 设计稿 §4 的命令表漏了 `reset`，§7 说"`sleep`/`wake` 是异步的，返回 `started/waking`"——代码里没有这两个命令。

## 7. 信号层怎么把 wake 送进会话

全链路（每一步都可单测）：

```
time.send()  index.mjs:149-151
  └─ signals.offer({from:{plugin:'time',activity:'schedule'}, kind, text, focus, tags})
       signals.mjs:91-118
       ├─ validateSignal：from.plugin 必填、kind ∈ wake|goal|notice|content|event、text 或 meta 二选一
       ├─ id 幂等（自动 id s-1、窗口 24h、进程内 Map）
       ├─ gate → time 的 gate（index.mjs:162-172）：放行 / 入队并返回 {accepted:false,blocked:true}
       └─ to==='model' 且 deliver 存在 → deliver(signal)
             host.mjs:36-45
             └─ delivery.push({to:'session', channel:'signal', source:{plugin, activity:'signal', seq:null},
                               content:{text}, batchKey:`signal:<plugin>:<focus>`, exactlyOnce:false})
                   services.mjs:448-471
                   └─ drain('session') 按 `to|batchKey` 合并，text 用 '\n' 拼接（474-499）
                         delivery-pump.mjs:18-42
                         └─ prompt({sessionId, text, urgent}) → 成功 ack / 失败 nack 并 break 本轮
                               外层薄壳（仓库外 icl-live）把它映射成 DSH 的
                               api.sessions.prompt({sessionId, mode:'queue', content:[{type:'text',text}]})
```

- `batchKey` 形如 `signal:time:`（focus 为空时末尾是空串）、`signal:qq:qq:group:123`。同一 `(plugin, focus)` 的多条信号若在同一次 drain 里被取走，会**合并成一条消息**（正文按换行拼接）——所以"结束语 + 积压释放"常常作为一封消息同时到达。
- 信号投递是 `exactlyOnce:false`、`seq:null`，因此不做水位去重；失败按 delivery 的退避重试，5 次后静默丢弃并计入 `droppedCount()`（services.mjs:516-529）。
- 另一条送达路径是 `session.drainOnce()`（`session.mjs:43-73`，drain → push → ack/nack，末尾 `emit turn-end`），只用于测试与 `tools/time-accept.mjs`，产品里不跑。
- `to:'plugin'` 的事件也走 `offer` → 同一个 gate（`emit()` 只是把 `to` 改成 `plugin`，signals.mjs:122）。time 自己发 `sleep-start`/`sleep-end`（281、299），dream 用 `signals.on({kind:'event', tags:['sleep']})` 订阅（`tools/time-accept.mjs:22-24`）。
- gate 只在 time 启用期间存在；没启用时 `gate === null`，全部放行（signals.mjs:100）。卸载时 `ctx.onDispose(() => signals.setGate(null))`（612）。

旧 `MESSAGE-CHANNELS` 设计稿（已删除）的两种模式，与代码的对应关系：

| 模式 | 文档说的用途 | 代码里谁用 |
|---|---|---|
| `mode:'queue'`（不打断，本轮结束后作为下一轮进入，`placement: next-turn`） | 叫起床、到点提醒、例行通知 | 时间模块的**全部**输出（wake/goal/notice）——`delivery-pump` 发出去的就只有这一种 |
| `mode:'steer'`（插话，`placement: next-step`，GUI 显示为"插话"） | 真紧急（着火、断电） | **仓库内没有实现者**：`delivery-pump.mjs:29` 只透传 `urgent: Boolean(batch.urgent ?? batch.content?.urgent)`，而 `createDeliveryService` 从不写 `urgent` 字段（services.mjs:458-468），所以 `urgent` 恒为 `false`；真正的 queue/steer 分支在外层薄壳里 |

## 8. 已知问题

| 严重度 | 代码位置 | 缺陷 |
|---|---|---|
| 高 | `index.mjs:108` | `const signals = ctx.signals ?? ctx.services.require('signals')` 的兜底分支**必然抛错**：`services.require` 只查插件共享能力表（host.mjs:154-158），而 `signals` 只挂在 `ctx.signals`（116-122）与 `host.services.signals`（175-183），不在表里 → 抛"缺少依赖能力：signals"，不是降级。同文件 281/299 行又直接用 `ctx.signals.emit`，两套写法自相矛盾。 |
| 高 | `index.mjs:106, 387-390`；`tools/time.mjs:45` | `inboxOffset` 只在内存里，重启归零 → 整个 inbox 历史被**重放一遍**（`pause`、`arrange`、`reset` 全都再执行一次）；CLI 只 append 从不截断，文件无限增长。 |
| 高 | `index.mjs:497-509`；`world-state:127` | time 注册 `owner:'time'` + `title:'时间'`（order 5, cap 3），world-state 注册 `owner:'clock'` + `title:'时间'`（order 10）→ `renderBrief` 按 owner 分组、用 title 当行首（world-state:83-96），系统提示里出现**两行都以「时间：」开头**，其中一行只有"现在是…"没有阶段与日程。 |
| 高 | `index.mjs:142-147, 115-136` | JSON 状态无文件锁、无原子写：全量 `writeFileSync` 覆盖，两个进程（或 `plan-test.mjs` 这类外部写入者）会互相覆盖；写到一半崩溃后下次启动 `JSON.parse` 抛错被 `catch` 当作"第一次运行"，**schedules/queue 静默全丢**。另外 `setInterval` 里 `void tick()`（605-609）不 await，`tick` 内部有 `await endSpan`（356）→ 两次 tick 可重入，persist 交错。 |
| 中 | `index.mjs:248-289, 286, 371-379` | 一次性安排响过之后**不从 `schedules` 删除**，只写 `fired`；只有重启时那 10 分钟宽限清理（124-134）会删。`fired` 本身只增不删，daily 日程每天一行 → `time.json` 单调变大，每次 persist 全量重写。 |
| 中 | `index.mjs:75, 321-328` | `normalizeSchedule` 里 `input.at != null` 优先于 `in`，而 `editSchedule` 用 `{...current, ...patch}` 展开、`current` 必带 `at` → `time_edit({id, in:'30m'})` 与 inbox `edit {id, in}` **静默无效**，不报错、不延后。 |
| 中 | `index.mjs:48-54, 371-379` | `HH:mm`（daily）日程取的是**今天**那个时刻，没有"下一个未来时刻"逻辑：20:00 建一条 `at:'08:00'` 的日程，下一个 tick 就会先响一次（今天 08:00 已过），然后明天再响。`time.test.mjs:31-33` 正是靠这个行为测试"到点触发"。 |
| 中 | `index.mjs:191-200, 228-246, 186-189, 524` | goal 停不下来：`resumeOnStop !== false && turnLimit == null` 的 goal 在每个 `turn-end` 都重发，没有任何次数或空闲上限；`goalMessage` 提示"若退出，请取消这个安排"，但 `time_status` 只显示 theme、不显示 id → 模型没有 id 可传给 `time_cancel`。另外 `addGoal` 只认 `until`/`durationMin`，**不认 `afterMin`**，而 `tools/time.mjs:10`、`time-accept.mjs:68`、`time-goal.test.mjs:29` 都在传 `afterMin` → goal 实际既无时限也无轮次上限。 |
| 中 | `index.mjs:274-279, 321-328, 355-357` | `time_edit` 只改 `state.schedules`；判定结束读的是 `state.spans[].until` → **已在进行的 span 改 `duration`/`at` 不生效**，只能 cancel 掉重开。 |
| 低 | `signals.mjs:100` | gate 在路由判断（105-115）**之前**执行，所以 `to:'plugin'` 的事件也被拦：睡/暂停期间其它插件的 `event` 会进 time 的 `queue`，醒来被当成"积压的用户消息"发出去。`docs/MESSAGE-MODEL.md` §3 写的是"拦截只作用于 `to:'model'`"。 |
| 低 | `index.mjs:439` | 重启释放的文案与文档不符：实际是「（日程因重启发生错误）积压了 N 条消息：」，`docs/TIME-MODULE.md` §8 写"日程因重启发生错误，已释放所有积压的消息"。 |
| 低 | `index.mjs:174-184` | 积压过期是**静默丢弃**：全部过期时 `flushQueue` 直接清空队列、persist、返回 0，无日志无计数。`docs/MESSAGE-MODEL.md` §5 承诺的 `droppedCount` 是 delivery 重试耗尽那个计数（services.mjs:524），与 time 的 `queue` 无关。 |
| 低 | `index.mjs:579-591` | `time_cancel` 的 summary 承诺"进行中的长日程会立刻结束，绑定的目标与注意力空间一起释放"，但代码只在 id 命中 `spans` 时 `endSpan`（只会释放 sleep 租约）；`goals` 和 goal 绑的 focus 一动不动——只有 id 恰好等于某个 goal 的 id 时才走 `removeGoal`。模型按 summary 理解会以为目标被一起取消了。 |
| 低 | `index.mjs:499-507`；`world-state:90` | world source 声明 `cap:3`，但 `items()` 最多返回 4 行（现在+阶段／下一个安排／进行中的目标／积压），`renderBrief` 按 cap 截断 → 有下一个安排且有 goal 时，「积压：N 条」永远显示不出来。 |
| 低 | `index.mjs:23-26, 48-54` | 时区：`dayKey` 与 `HH:mm` 都按宿主本地时区算，没有配置项（`dream` 的 `timezone` 配置管不到 time）。换机器或改系统时区后，`fired` 的日期键与新时区不对应，同一天可能重复触发或整次漏触发。 |
