# 投递裁决统一设计（DELIVERY-POLICY）

> 状态：**设计稿 + 2026-11-07 已实施 C1/C6/重放回执**。`decide()` 主体（P0–P3）仍只是设计；已实施部分见 §2.8，并作为未来迁移的 parity 基准。
> 范围：`signals.offer(to:'model')` → 投递到 session 这一条链上的**裁决**。
> 不在范围：QQ 入口的归一化/限流、审批状态机、记忆写入、focus backlog 的存储结构。
> 参考：`docs/OLD-QWENSTUFF-MEMORY.md`（唯一裁决点 / 2 通道 / 5 reason 的 A/B 结论）、
> `docs/OLD-QWENSTUFF-APPROVAL.md`（旧审批状态机**不搬**，见 §3.6）。
> 旧实现原文：`C:\DSH\qwenstuff\focus-core\apps\dsh-icl\src\domain\policy.js:32-73`。

---

## 0. 一句话目标

把现在**两个裁决点**（`focus.admit` + time gate）合并成**一个纯函数**
`decide(input) → {action, channel, suppressReason, wake, holdMs, ...}`：
- 决策点 2 → 1；
- 对外的 suppress reason 9 → **5**（`stop | mute | sleep | sacred | focus`）；
- **只降级、不丢弃**（`pierce → ambient/queue`，drop 只留给去重/过期）；
- 现有行为**逐条对拍不变**，再分阶段删旧分支；每步可回滚。

非目标：不搬旧项目的每日 push budget（`policy.js:75 DEFAULT_PUSH_BUDGET`）、
不搬审批/授权状态机（旧项目最后整代删除，见 `OLD-QWENSTUFF-APPROVAL.md:36-40,82-90`）。

---

## 1. 现状盘点：两个裁决点

### 1.0 实际调用链（先纠正一个事实）

不是"bridge 里调 admit"：`focus.admit` 的**唯一调用点**在 core host 的 signal deliver 回调：

```
插件 signals.offer({to:'model'})
  → signals.offer：遍历 signals gates（time 的 gate 是其中之一）—— 裁决点 B
  → setDeliver(signal)（host.mjs:40-56）
      → focus.admit(signal) —— 裁决点 A（core/services.mjs:468-482）
      → deliver=false：focus.defer(signal) → focus backlog（按 signal.focus 分桶）
      → deliver=true：delivery.push({channel:'signal', ...})
          → delivery push-time gates（time 的 deliveryGate，对 channel!=='signal' 再裁决一次）
  → bridge pump（bridge.mjs:545-556）drain('session') → agent.steer/message → 会话
```

所以：**A 在 B 之后**；A 只在 B 放行后才被调用。bridge 只负责把 drain 出来的批次送进会话
（steer；空闲时等价于唤醒），不自己裁决。

### 1.1 裁决点 A：`focus.admit`（注意力 / 焦点）

| 项 | 内容 |
|---|---|
| 实现 | `packages/core/src/services.mjs:468-482`（`admit`）、`:484-496`（`defer`）、`:448-457`（`current`） |
| 调用 | `packages/core/src/host.mjs:40-46`（`signals.setDeliver`） |
| 输入 | `signal`：`from.plugin / tags[] / focus(label) / text`；焦点状态：当前 lease `{label, interruptible, pierce 规则}`；`tags` 里的 `mention/at` 参与默认 pierce 判断 |
| 输出 | `{deliver:boolean, reason:string, focus?, pattern?}`；`deliver=false` 时由 host 调 `focus.defer` 进 backlog |
| 状态 | `leases:Map`（label/owner/interruptible/pierce/ttl/since）、`backlog:Map<focusLabel,{count,items(≤20),lastText}>`；持久化在 bridge 的 `focus.json`（`bridge.mjs:136`） |
| 队列 | focus backlog，按 `signal.focus ?? '(ambient)'` 分桶；释放时机 = 焦点变化/释放（`focus.onChange` → `signals.offer` 一条 `[focus-backlog]` 摘要，`host.mjs:60-73`） |
| 消费者 | host（`queued:true,reason` 回给 `signals.offer` 调用方）；`focus_status`/`focus_backlog` 工具；bridge 焦点持久化 |

### 1.2 裁决点 B：time gate（时间 / 睡眠 / 静音 / 暂停）

| 项 | 内容 |
|---|---|
| 实现 | `packages/plugins/time/src/index.mjs` 的 `gate(signal)`（`:1024-1069`，当前版本）；delivery 适配器 `deliveryGate`（`:2312-2322`） |
| 调用 | `signals.addGate(gate)`（所有 `to:'model'` 信号）；`delivery.addGate(deliveryGate)`（直接 `delivery.push` 的兜底） |
| 输入 | `signal`：`to/kind/from.plugin/from.activity/text/tags[]/focus/meta/id/createdAt/expiresAt`；time 状态：`phase(awake/sleeping/paused)`、`pausedMode`、`lock{muted,until,allow,emergency{quota,used}}`、活动 sleep span 的 `allow`、`queue`；配置 `emergencyTags/emergencyFrom` |
| 输出 | `{accept:boolean, reason?: 'sleeping'|'muted'|'paused'}`（历史还有 `muted-quota`）；被拦时内容已 `enqueue()+persist()`（有界队列，带 `reason/priority`） |
| 状态 | `phase/since/sleepingId/sleepUntil/spans/sleepBoundary/pausedAt/pauseReason/pausedMode/lock/queue/stats/lastPierce/lastBlockedAlarm`，落 `time.json` |
| 队列 | time `queue`（`maxQueue=500`，`priority:'alarm'|'normal'`，`reason` 四态；释放时机 = 醒来/解除静音/恢复/启动自愈） |
| 消费者 | `signals.offer` 返回 `{blocked,reason}` 给来源插件（mc-link `STORED_BY_TIME`、QQ `blockedReasons`/`lastBlocked`、night-check reason 校验）；`time.status()/time_list`；`deliveryGate` 的 `blocked:true,reason` |

### 1.3 9 种 reason 全量清单（代码事实）

> 口径说明：`OLD-QWENSTUFF-MEMORY.md:75` 的 9 个名字是
> `no-focus / same-focus / sacred / privileged / focus-pierce / paused / sleeping / muted / muted-quota`。
> 当前代码在 focus 侧实际还会把 pierce 放行级别 `always/mention` 作为 `reason` 返回（`services.mjs:478-480`），
> 所以下表多列这一行（代码事实），不影响"9→5"的结论。

"9 种"= 两个裁决点输出 reason 的并集（`OLD-QWENSTUFF-MEMORY.md:75` 的命名）；
但注意其中 5 个 focus reason 里有 4 个是**放行**原因（不是 suppress），真正拦下消息的只有 5 个：

| # | reason | 产出点 | 语义 | 结果 | 代码 | 现有测试/消费者 |
|---|---|---|---|---|---|---|
| 1 | `no-focus` | A `services.mjs:470` | 她不在任何焦点 | 放行 | `admit` | `qq-rich` focus 契约 |
| 2 | `same-focus` | A `:477` | 信号就是当前焦点的事 | 放行 | `admit` | 同上 |
| 3 | `privileged` | A `:474` | `from.plugin==='time'` 或 tags `admin/alarm` | 放行 | `admit` | `qq-rich`（admin/alarm） |
| 4 | `always` / `mention` | A `:478-480`（`verdict.level`） | pierce 规则命中（always 或 mention） | 放行 | `resolvePierce`（`contracts.mjs:65-80`） | `qq-rich` @ 放行 |
| 5 | `focus-sacred` | A `:475` | 焦点 `interruptible:false` | **拦 → focus backlog** | `admit` | `qq-rich` sacred |
| 6 | `focus-pierce` | A `:481` | pierce 规则不允许 | **拦 → focus backlog** | `admit` | `qq-rich` 普通私聊 |
| 7 | `paused` | B gate | `phase==='paused'` 或 `pausedMode.active`，普通消息 | **拦 → time queue**（alarm 会穿透） | `time/index.mjs` gate | `time-lock` |
| 8 | `sleeping` | B gate | 睡眠中且不在 span allow | **拦 → time queue（alarm 最高优先级，醒来简报）** | gate | `time-lock` |
| 9 | `muted` | B gate | 静音锁生效（默认连 alarm 也拦，配额显式才放行） | **拦 → time queue** | gate | `time-lock` |
| — | `muted-quota`（历史） | 旧 gate | 紧急配额用尽 | 拦 | 现**已不再产生**（配额溢出返回 `muted`） | `mc-link STORED_BY_TIME` 仍兼容、night-check 白名单仍列 |

> 结论：9 个名字里只有 **5 个是 suppress**：`focus-sacred / focus-pierce / paused / sleeping / muted`；
> 另 4 个（含 `always/mention`）是放行原因。**"9→5"的本质是把"放行原因"从 reason 里拿掉**，
> 并给 5 个 suppress 统一命名。

### 1.4 现行行为矩阵（必须保持）

| 状态 \ 消息 | 普通 | mention/@ | alarm/safety | 同 focus | admin |
|---|---|---|---|---|---|
| 无焦点 | 投递 | 投递 | 投递 | 投递 | 投递 |
| 焦点可打断 | 进 focus backlog | 投递 | 投递（privileged） | 投递 | 投递 |
| 焦点 sacred | 进 backlog | 进 backlog | 投递 | 投递 | 投递 |
| 睡眠 | 进 time queue | 进 time queue（allow 命中除外） | 进 time queue **最高优先级、不叫醒、醒来简报** | 进 queue | allow 默认 `admin` → 投递 |
| 暂停（phase 或外部 pausedMode） | 进 time queue | 同普通 | **穿透并叫醒** | 同普通 | 同普通 |
| 静音 | 进 time queue | 进 queue | **默认进 queue**（`emergencyQuota` 显式才放行） | 进 queue | `lock.allow` 命中才放行 |

### 1.5 现有问题（为什么值得做）

1. **一条消息为什么没到要看两处**：A 的最后一段与 B 的 4 个分支是两份并列的 if 矩阵；
   B 的 `reason` 与 A 的 `reason` 命名/粒度不同（`sleeping` vs `focus-pierce`），
   但对外都叫 "reason"。
2. **precedence 是隐式的**：`mute > sleeping > paused > focus` 只由代码顺序保证，
   没有一处可读的规则；新插件再装一个 gate 时无法判断自己该在矩阵哪一格。
3. **放行原因污染 suppress 语义**：来源侧（mc-link `STORED_BY_TIME`）要靠枚举判断"是否已落盘"；
   现在枚举里混着 `muted-quota` 这种历史名。
4. **delivery push 盲区**：`deliveryGate` 对 `channel!=='signal'` 的直投用假信号（`tags:[]`）
   重跑 B，丢失 priority/pierce 信息；与 A 的结论不共享输入。
5. **不可穷举测试**：要覆盖"为什么没到"必须同时写 focus 和 time 两套场景；
   旧项目 75 行纯函数可枚举，这边现在是两个对象 + 4×4 分支。

---

## 2. 目标：单一纯函数 `decide`

### 2.1 契约（TypeScript 形状，实现为普通 ESM）

```js
/**
 * 唯一投递裁决点。纯函数：不写状态、不排队、不消费配额（只返回建议）。
 * @param {DecisionInput} input
 * @returns {Decision}
 */
export function decide(input) {}
```

### 2.2 输入

| 字段 | 类型 | 说明 |
|---|---|---|
| `now` | number | 毫秒；纯函数不使用 `Date.now()` |
| `signal.kind` | `wake|goal|notice|content|event` | 固定枚举（`signals.mjs:18`） |
| `signal.from` | `{plugin, activity}` | 来源；`plugin==='time'` 表示她自己的定时器 |
| `signal.tags` | `string[]` | `admin/alarm/safety/emergency/mention/at/...` |
| `signal.priority` | `'alarm'|'normal'|'notice'` | 来源声明的强度（mc-body 带 `meta.priority/pierce`） |
| `signal.pierce` | boolean | 来源显式要求穿透（mc-body `pierce:true`） |
| `signal.focus` | `string|null` | 消息所属注意力空间（不是路由） |
| `target` | `{to:'session'|..., sessionId:string|null}` | 目标会话；null=当前会话 |
| `state.phase` | `'awake'|'sleeping'|'paused'` | time 相位 |
| `state.pausedMode` | `{active:boolean}` | 外部暂停（`mcb_stop`） |
| `state.lock` | `{until, allow[], emergency:{quota,used}}|null` | 静音锁快照 |
| `state.sleep` | `{allow[]}` | 当前 sleep span 白名单 |
| `state.focus` | `{label, interruptible, pierce}|null` | 当前焦点快照（null=无焦点） |
| `config` | `{emergencyTags[], emergencyFrom[]|null}` | 只传入判定所需配置，不传整个 ctx |

> 约束：`decide` **不接受**回调/store；"落盘/排队/配额递减/记录 lastPierce" 都由调用方
> `applyDecision()` 执行（A/B 两个 facade 共用）。

### 2.3 输出

```js
{
  action: 'deliver' | 'queue' | 'drop',
  channel: 'pierce' | 'ambient' | null,   // deliver 时区分直达 vs 摘要
  suppressReason: null | 'stop' | 'mute' | 'sleep' | 'sacred' | 'focus',
  priority: 'alarm' | 'normal',            // alarm 在 sleep/mute 队列里排最前
  wake: boolean,                           // true=允许 bridge steer 立即起一轮
  holdMs: number | null,                   // queue 时的最早再投递时间（null=等条件事件）
  queueKey: string | null,                 // time / focus:<label> / null
  consumeQuota: boolean,                   // mute 危险配额是否要递减（由调用方执行）
  consumeBudget: false,                    // 预留给未来 push budget；本期恒 false
  explain: { rule: string, blocker: string|null, pierceLevel?: string|null, legacyReason: string|null },
  legacy: { reason: string|null }          // 兼容期：旧 reason 字符串（迁移完成后删）
}
```

关键语义：
- `deliver` → `wake:true`、`holdMs:0`；`channel:'pierce'` 表示立即进会话，`'ambient'` 表示进"摘要批"。
- `queue` → `wake:false`；`holdMs`：
  - mute：`lock.until - now`（锁到期可释放）；
  - sleep：`sleepUntil - now`（未知则 null）；
  - stop(paused)：null（等 resume）；
  - sacred/focus：null（等焦点变化/释放）。
- `drop`：只由调用方在"去重/过期"时传 `signal.expired/deduped` 进来；decide 本身**不产生 drop 的
  suppressReason**（旧项目"只降不丢"原则，`OLD-QWENSTUFF-MEMORY.md:50`）。

### 2.4 决策顺序（pseudo-code）

```
decide(input):
  if signal.to === 'plugin'      → deliver(plugin bus, no wake)   // 调用方通常直接跳过
  if from.plugin === 'time'      → deliver(pierce, wake=false?)   // 她自己的闹钟/续推，一律放行
  if phase === 'sleeping':
      if allowMatch(sleep.allow)  → deliver
      return queue(reason=sleep, priority=alarm? , holdMs=sleepUntil-now)
  if lock:
      if allowMatch(lock.allow)   → deliver
      if alarm && quota.used < quota: → deliver(pierce, consumeQuota=true)
      return queue(reason=mute, priority=alarm?, holdMs=lock.until-now)
  if pausedActive:                // phase paused 或 pausedMode.active
      if alarm/pierce             → deliver(pierce, wake=true)
      return queue(reason=stop, holdMs=null)
  // —— 到这里才问 focus（与现顺序一致：time 拦下就不进 focus）——
  if !focus                     → deliver(pierce)
  if privileged(time/admin/alarm) → deliver(pierce)
  if signal.focus === focus.label → deliver(pierce)
  if focus.interruptible === false → queue(reason=sacred, queueKey=focus:<label>)
  if !resolvePierce(focus.pierce, signal.focus, mention).allowed → queue(reason=focus, queueKey=focus:<label>)
  return deliver(pierce)
```

> 注意第 2 条：当前 time 自己的信号 `from.plugin==='time'` 在 B 直接 accept，之后仍会过 A
> （A 也 privileged 放行）；统一后一次判定即可。`wake` 对 time 的 `goal/notice` 仍为 false
> 还是 true 由现有 bridge 行为决定（现在 delivery.push 后由 bridge steer 唤醒）→ 统一时保持
> `wake:true`（等价于现在的 steer）。

### 2.5 5 个 canonical suppressReason 与 9→5 映射

| canonical | 含义 | 旧 reason → 映射 | 队列/释放 |
|---|---|---|---|
| `stop` | 停机/暂停（世界继续，危险可穿透） | `paused` → `stop` | time queue；resume 释放 |
| `mute` | 显式静音 | `muted` / 历史 `muted-quota` → `mute` | time queue；unmute/到期释放 |
| `sleep` | 睡眠（含 alarm 最高优先级、醒来简报） | `sleeping` → `sleep` | time queue；wake 释放 |
| `sacred` | 当前焦点不可打断 | `focus-sacred` → `sacred` | focus backlog；焦点变化释放 |
| `focus` | 焦点穿透规则不允许（"别处的事"） | `focus-pierce` → `focus` | focus backlog；焦点变化释放 |
| —（放行，无 suppress） | 不产生 suppressReason | `no-focus` / `same-focus` / `privileged` / `always` / `mention` → `suppressReason:null`，放行原因进 `explain.rule` | 直接 deliver |

**为什么不照搬旧项目的 `budget` / `dedupe`：**
- `budget`（旧 `policy.js:67-70` + `DEFAULT_PUSH_BUDGET=12`）与 time 的 `awakeTick.maxPerHour`/
  `emergencyQuota`、QQ 的频率限制重叠；`OLD-QWENSTUFF-MEMORY.md:119` 已判"不搬——两处计数必然对不上"。
- `dedupe` 现在是 delivery 的 `exactlyOnce`/`signal.id` 去重（`services.mjs:610-617`），
  是存储层保证，不是裁决层；放进 decide 会让纯函数拿到本不属于它的状态。

**为什么保留 `sleep` 而不是并进 `stop`：** 睡眠有独立语义（不叫醒、alarm 最高优先级、醒来简报、
`sleepBoundary`），合并会丢可观测性；旧项目 5 reason 里没有 sleep 是因为它没有"睡觉"这个产品状态。

### 2.6 与旧项目 `policy.js` 的对照

| 旧项目 | 本设计 | 理由 |
|---|---|---|
| 纯函数 `decide`，75 行，`{channel, suppressReason}`（`policy.js:32-73`） | 纯函数 `decide`，输出 `{action, channel, suppressReason, wake, holdMs}` | 同一思想；多了 `queue/wake/holdMs` 以覆盖现行有界队列与 bridge steer |
| 2 通道 ambient/pierce，只降不丢 | `deliver(pierce|ambient)` / `queue` / `drop`（drop 只在调用方去重/过期） | 保持"分级只在焦点内成立；无焦点一切可唤醒"（`policy.js:48-50`） |
| reason 是**一等输出**（`suppressReason`） | `suppressReason` 也是一等输出 + `explain.rule` | 排障"为什么没到"只看一个字段 |
| 每日 push budget | 不搬（见 §2.5） | `OLD-QWENSTUFF-MEMORY.md:119` |
| 审批/授权（`principal.canWake/canAuthorize`） | **不做** | `OLD-QWENSTUFF-APPROVAL.md`：旧项目 P21 整套删除，明确"审批体系不继承"（`:82-90`）；且旧审批也是"模型无 decide 接口"（`:36-40,78`）——本设计不引入任何授权状态 |

---

## 2.7 两个维度：空间（focus）× 时间（time）

"最终到达"不是一次判定，而是**两个正交维度的合取**。把它们分开写清楚，代码才能只改一个维度而不碰另一个：

| 维度 | 回答的问题 | 状态 | 积压队列 | 队列 key | 释放触发 | 重放方式 |
|---|---|---|---|---|---|---|
| **空间 / 命名空间（focus）** | 这条消息**属于哪个会话/上下文**？现在这个空间该不该收它？ | `focus.current()` 租约（label/interruptible/pierce），与时间无关；跨重启持久化（`focus.json`） | focus backlog（核心是"别处的事先攒着"） | `signal.focus ?? '(ambient)'`（按空间分桶，不是按来源） | 焦点变化/释放（`focus.onChange`） | 摘要走 `signals.offer` **重新进入管道**（不是直接 `delivery.push`），再受 time 裁决 |
| **时间 / 全局锁（time）** | **现在**能不能收？她睡着/静音/暂停时，任何空间的消息都先攒着 | `phase(awake/sleeping/paused)`、`pausedMode`、`lock`、sleep span `allow` | time queue（全局有界队列，`priority:alarm/normal`） | 全局一条队列；条目保留 `reason`（canonical：stop/mute/sleep） | 醒来 / 静音到期或解除 / 暂停恢复 / 启动自愈 | 摘要走 `send()`（`from.plugin==='time'`，仍会过 focus.admit 的 privileged）**重新进入管道** |

**规则：**
1. **到达 = 两个维度都放行**。任一维度拦下 → 进它自己的队列；**不丢**。
2. **队列各自独立**（不统一存储）：focus backlog 按空间分桶、释放条件=焦点变化；time queue 是全局、释放条件=时间状态变化。
3. **重放不直接投递**：两条队列释放时都生成一条**摘要信号重新进入管道**，再走一次双闸门：
   - focus 释放 → `signals.offer({from.plugin:'focus', tags:['focus-backlog']})` → 先 time gate、再 focus.admit；
   - time 释放 → `send()`（time 自己的 notice）→ 先 time gate（time 自身放行）→ focus.admit（privileged 放行）。
4. **顺序**：
   - **signals 路径**：time gate → focus.admit（历史原因：`signals` gates 先于 `setDeliver`；现状不变）。
   - **直投 delivery.push**（C6）：focus.admit → time gate（host 先装 focus 空间闸门，插件的 time 时间闸门后装）。`channel:'signal'` 的投递已在 signals 路径裁决过，**不再二次裁决**。
   - 两个顺序的差别只决定"两个都该拦时先进哪条队列"——本轮不改 signals 顺序（避免行为漂移）；P3 统一时再定一个顺序（建议 focus→time，与直投一致）。\n   - 残留结构洞：插件若调旧 `delivery.setGate` 会**整体替换**（包括 host 的 focus 空间闸门）；P3 建议禁用/收窄该接口，只用 `addGate`。
5. **重复/过期语义**：
   - time queue：`signal.id` 去重（同 id 不重复入队）、`expiresAt` 过期显式丢弃计数、溢出保护（alarm 最高优先级，其次 mention/私聊、再 ambient）；摘要受 `backlogShow/backlogMaxChars` 上限约束。
   - focus backlog：按空间计数，`items` 只留最近 20 条（`lastText` 供摘要），**没有 TTL**（焦点不释放就一直攒；这是"别处的事"的语义，不是收件箱）。
   - 去重/过期是**存储层**职责，不属于 decide；decide 只在输入带上 `expired/deduped` 时给 drop。
6. **重放回执（QQ）**：队列条目保留原信号的账本身份（time queue：`item.qq={activity,seq}`；focus backlog：`item.qq`/`item.signalId`）。真正重放给模型后调用 QQ 的 `noteDeliveredSeqs({activity,seqs,via,at})`：
   - 只推 **delivered**（"已交给投递队列"），**不推 attended/不算已读/不发消息**；幂等，已交付/不存在的 seq 忽略，空洞不跨。
   - `via`：`time-backlog` / `focus-backlog`；QQ 侧统计在 `qq_status.ledger.deliveredVia`。契约见 `docs/QQ.md §7.7`（QQ 实现 commit `83e2b37`；接口返回 `{ok,accepted,skipped,deliveredSeq,attendedSeq,lastSeq,via,at}`，不抛异常）。
   - 若摘要被 time 拦下（睡眠/静音），focus 释放时把 `meta.replayQq` 随摘要带进 time 队列，由 time flush 时统一补推 → 不会丢回执。
   - 失败不抛；没回执的消息在 QQ 侧保持"未交付"（安全侧）。
- **回执顺序无关**：QQ 的 `deliveredSeq` 由"已交付连续段"实时算（`MIN(seq WHERE delivered_at IS NULL)-1`，无空洞则 lastSeq），**单调不回退**；先释放谁就回执谁、后到的 seq 只填洞，不会把水位改小，也不需要我们按 seq 排序。该边界由 QQ `ed851c8`/`3480980` 测试钉住。

### 2.8 本轮已实施（2026-11-07，用户拍板）

| 决定 | 实施内容 | 测试 |
|---|---|---|
| **C1 改** | `delivery.push` 的 gate entry 带 `source.tags/focus/priority/pierce/meta`；time `deliveryGate` 用它们构造真实裁决输入（暂停 alarm 穿透；睡眠/静音按最高优先级进 time 队列，内容不丢） | `time-lock.test.mjs`：C1 直投暂停穿透/睡眠积压/静音拦截 |
| **C6 改（结构性防洞）** | host 在 delivery 上先装 **focus 空间闸门**：直投默认过 `focus.admit`，被拦进 focus backlog；显式 bypass = `from.plugin==='time'`、`tags:admin/alarm`、`source.meta.bypassFocus===true`；`channel:'signal'` 不二次裁决 | `delivery-gate.test.mjs`：C6 拦截/privileged/bypass/sacred |
| **C3 保留 legacy** | 对外 `reason` 仍为 `sleeping/muted/paused/focus-*`；canonical 只进新字段（本文 §2.5），迁移未切 | — |
| **重放回执** | time flush 成功后按 `activity` 分组调 `qq.noteDeliveredSeqs({seqs:number[], via:'time-backlog'})`；focus 释放立即进管道时同理（`focus-backlog`），被 time 拦下则 seqs 随 `meta.replayQq` 进 time 队列、flush 时补推 | `time-lock`（time-backlog 分组）、`focus-semantics`（focus-backlog） |

> 注意：本轮只实施 C1/C6/回执，**没有**把两个 gate 的内部矩阵换成 `decide()`（P0–P3 仍是设计）。迁移时上述行为是 parity 基准。

> 原则：先加 facade（两旧闸门调同一个 `decide`），**行为逐条对拍**，再删旧逻辑。
> 不一次性重写；每个 phase 单独 commit，失败 revert 该 commit 即回到上一状态。

### Phase 0：纯模块 + golden 测试（不改行为）

- 新增 `packages/core/src/policy.mjs`：`decide()` + 常量 `SUPPRESS_REASONS`/`CHANNELS`。
- 新增 `packages/core/test/policy.test.mjs`：§5 的 golden 表（9 reason × 6 状态 × alarm/普通）。
- 不接入任何调用方；现有 499 测试全绿。

### Phase 1：facade（两旧闸门 → decide，输出保持不变）

- 新增两个适配器（放同一个新文件，不散落）：
  - `decideFromTime(stateSnapshot, signal, now)` → 组装 `DecisionInput`；
  - `decideFromFocus(focusSnapshot, signal, now)` → 同上。
  - `applyDecision(decision, callbacks)`：调用方注入 `enqueue/defer/push/consumeQuota/recordPierce` 等副作用。
- `time/src/index.mjs` 的 `gate()` 改为：构建 snapshot → `decide` → 用 `legacy.reason` 返回
  （保持 `sleeping/muted/paused` 字符串、队列字段、priority、lastPierce 全不变）。
- `core/services.mjs` 的 `focus.admit()` 改为：`decide` → 映射回 `deliver/reason`（保持
  `no-focus/same-focus/privileged/focus-sacred/focus-pierce` 字符串与 `focus.defer` 行为）。
- **对拍测试**：新增 `policy-parity.test.mjs`，对同一组 fixture 同时调用
  "旧矩阵函数（本 commit 仍保留为 `legacyAdmit/legacyGate`）"与"facade"，
  断言 `{accept, legacyReason, queueDestination, priority, wake}` 完全一致；
  断言范围覆盖现有 `time-lock`/`qq-rich`/`delivery-gate`/`dsh-bridge` 场景。
- 全部现有测试不改也应绿；若必须改测试，说明行为变了 → 停，先和 lead 对。

### Phase 2：对外加 canonical 字段（双写，不删旧）

- 被拦返回值/队列条目/交付记录增加 `suppressReason`（5 值），`reason` 保留为 legacy。
- 更新消费者读取 canonical（可灰度）：
  - `mc-link` 的 `STORED_BY_TIME` 改为 `suppressReason` 集合（兼容期两者都接）；
  - `tools/time-night-check.mjs` 的 reason 校验改为 canonical；
  - QQ `blockedReasons`/`lastBlocked.reason` 状态文案：先保留旧字符串（用户可见），
    canonical 只进日志/status 的新字段。
- 更新 `time.status().queue[].suppressReason`、`delivery` 的 blocked 计数按 canonical 分桶。

### Phase 3：删旧矩阵

- `time` gate 里 3 段分支（mute/sleep/pause）删掉，只留适配器；
- `focus.admit` 的 4 个 if 删掉，只留适配器；
- `deliveryGate` 复用同一个 `decide`（别再伪造 `tags:[]`——见 §4.2 变更点）；
- 删 `muted-quota` 别名（迁移期已双写 canonical）。
- 更新 `TIME.md §4/§16` 与 `docs/PROMPT-CONTRACT` 的 reason 列表；跑全量测试 + loop-host + lab S2/S4/S5/S6。

### Phase 4（可选，独立决策）：统一释放路径

- 目前 time queue 与 focus backlog 是两条队列（释放条件不同，语义清晰）。
  统一存储不是本设计目标；如要做，另立设计（风险远大于收益）。

### 回滚

| 阶段 | 回滚方式 |
|---|---|
| P0 | 删 `policy.mjs`/测试，无行为变化 |
| P1 | 单 commit revert，旧矩阵仍在 |
| P2 | canonical 字段是新增，消费者读取可回退；`reason` 仍在 |
| P3 | revert 该 commit 恢复旧矩阵（P1 的 facade 仍在则继续可用） |
| 灰度 | 配置 `policy.facade: false` 可强制走旧分支（P1 保留到 P3 验证后） |

---

## 4. 风险与不变式

### 4.1 必须不变（对拍清单）

| 不变量 | 现状证据 | 新设计保证 |
|---|---|---|
| 无焦点 → 一切可唤醒 | `services.mjs:470` | `!focus → deliver` |
| 焦点 sacred → 除 privileged 外全进 backlog | `:475` | `queue(sacred)` |
| focus pierce 规则（always/mention、glob 优先级） | `contracts.mjs:65-80` | 复用 `resolvePierce`，不重写 |
| `time/admin/alarm` privileged | `:473` | `privileged` 判定保持 |
| 顺序 **mute > sleep > paused > focus** | time gate 分支顺序 | decide 伪代码顺序固定 + 测试锁 |
| 睡眠 alarm：不叫醒、最高优先级积压、醒来简报 | `time-lock` + night-1 报告 | `queue(sleep, priority=alarm, wake=false)` |
| 暂停 alarm：穿透并叫醒 | 用户 2026-11-06 拍板 | `deliver(pierce, wake=true)` |
| 静音默认连 alarm 也拦（quota 显式才放行） | `emergencyQuota=0` | `queue(mute, priority=alarm)`；quota 命中 `deliver+consumeQuota` |
| focus backlog 释放后走 `signals.offer`（再受 time 裁决） | `host.mjs:60-73` | 不改变释放路径 |
| `channel:'signal'` 的 delivery 不二次裁决 | time `deliveryGate` | 保持 bypass；facade 只在真源调用 |
| 来源侧无需重试 blocked（内容已落盘） | TIME.md §4.1 | `applyDecision` 保持"先落盘再返回" |

### 4.2 会改变的行为（需要 lead/用户拍板）

| # | 变更 | 影响 | 建议 |
|---|---|---|---|
| C1 | 直投 `delivery.push`（非 signal 通道）现在用假信号 `tags:[]` 再裁决 → 新设计可读取 `source.priority/pierce` | 带 alarm 的直投在暂停时会从"进积压"变"穿透叫醒" | **✅ 用户已拍板改、已实施**：entry 带 tags/focus/priority/pierce/meta；见 §2.8 与 `time-lock` C1 测试 |
| C2 | `muted-quota` 不再出现在对外 reason | mc-link/night-check 已兼容；旧状态文件里的历史队列条目不迁移 | 可接受；迁移期双写 |
| C3 | 对外 reason 字符串若切 canonical（`sleeping→sleep` 等） | QQ `blockedReasons` 显示文案、脚本断言会变 | **✅ 用户已拍板保留 legacy**：对外 `reason` 不变，canonical 只作为新字段（未来迁移用） |
| C4 | `focus.admit` 的放行原因（`always/mention`）不再作为 suppress reason 暴露 | 目前没有消费者依赖；`focus.admit()` 返回值仍保留 legacy | 可接受 |
| C5 | `holdMs` 的语义（mute 到期/sleep 醒来）是新增信息 | 无 | 观察用，不改变投递 |
| C6 | 统一后 delivery push gate 将执行完整 decide（包括 focus） | 直接 push 绕 signals 的路径会开始受 focus 裁决（现在只受 time 裁决） | **✅ 用户已拍板改、已实施**：host 在 delivery 上先装 focus 空间闸门（直投先焦点后 time；bypass=time/admin/alarm/`meta.bypassFocus`）；当前无插件直投调用者，风险低。见 §2.8 与 `delivery-gate` C6 测试 |

### 4.3 失败模式

- `decide` 抛错：facade **fail-open**（与 `signals` gate 的 fail-open 一致，`signals.mjs:144-149`）+ 计数；
  decide 是纯函数且输入校验齐全，正常不应抛。
- 配额递减：decide 只返回 `consumeQuota`，由调用方在"真的要放行"时递减，避免纯函数产生副作用、
  也避免 `deliver` 失败时白扣配额。
- 双重裁决：`channel==='signal'` 的 delivery 不再进 decide；`from.plugin==='time'` 只一次。
- 队列 reason 兼容：升级后旧 `time.json` 里 `reason:'sleeping'` 条目仍在；读取方要能同时识别
  legacy/canonical（迁移期双读）。
- `decide` 与 focus 快照不一致（租约刚释放）：facade 每次从 host 拉最新 snapshot，不缓存。

---

## 5. 测试计划

### 5.1 旧 reason → 新 reason 对拍表

| 输入 | 旧归属 | 旧 reason | 新 action | 新 suppressReason | wake | queueKey |
|---|---|---|---|---|---|---|
| 无焦点普通 | A | `no-focus` | deliver | null | true | — |
| 同焦点 | A | `same-focus` | deliver | null | true | — |
| time 自己 | A/B | `privileged` | deliver | null | true | — |
| admin/alarm @ 焦点 | A | `privileged` | deliver | null | true | — |
| pierce 命中 mention | A | `mention` | deliver | null | true | — |
| pierce 命中 always | A | `always` | deliver | null | true | — |
| 普通私聊 @ 可打断焦点 | A | `focus-pierce` | queue | `focus` | false | focus:<label> |
| @ sacred 焦点 | A | `focus-sacred` | queue | `sacred` | false | focus:<label> |
| 睡眠普通 | B | `sleeping` | queue | `sleep` | false | time |
| 睡眠 alarm | B | `sleeping` | queue | `sleep` | false | time（priority alarm） |
| 暂停普通 | B | `paused` | queue | `stop` | false | time |
| 暂停 alarm | B | `paused` | deliver | null | true | — |
| 静音普通 | B | `muted` | queue | `mute` | false | time |
| 静音 alarm（默认） | B | `muted` | queue | `mute` | false | time（priority alarm） |
| 静音 alarm（quota>0） | B | `muted-quota` | deliver | null | true | —（consumeQuota） |
| 静音 allow 命中 | B | `muted`（放行） | deliver | null | true | — |

### 5.2 golden 决策表（纯函数）

`policy.test.mjs`：遍历
`phase ∈ {awake,sleeping,paused} × pausedMode ∈ {on,off} × lock ∈ {none,active,allow-hit,quota-hit} ×
focus ∈ {none,interruptible,sacred,pierce-deny,mention} × signal ∈ {normal,mention,admin,alarm,time}`，
断言：
- 每种组合都有确定输出（total function，不抛）；
- `suppressReason` 只在 5 值集合内或 null；
- `action==='queue'` ⇒ `wake===false && queueKey!==null && holdMs` 语义正确；
- `action==='deliver'` ⇒ `wake===true`；
- 同一组合重复调用结果深相等（纯函数）。

### 5.3 场景用例

- **pierce/降级/丢弃**：mention 穿 focus；@ sacred 不穿；admin/alarm 特 privileged；
  去重/过期由调用方 drop（decide 不产出 drop）。
- **无焦点**：一切 deliver。
- **睡眠**：普通+alarm 都进 queue；alarm priority；holdMs≈sleepUntil；醒来 release 顺序不变。
- **暂停**：普通 queue；alarm deliver + wake（用户拍板回归）。
- **静音**：普通/ alarm 默认 queue；显式 `emergencyQuota` 放行 + `consumeQuota`；到期释放。
- **focus**：sacred/pierce deny 进 backlog；同焦点/privileged 直达；释放摘要仍走 `signals.offer`。
- **delivery 直投**：`channel:'signal'` 不二次裁决；其它 channel 走 decide（C1/C6 拍板后）。

### 5.4 回归套件

- 现有全部：`node --test packages/core/test packages/mc-body/test`（当前 499）；
- `node tools/loop-host.mjs --long`（24 项）；
- lab：S2/S4/S5/S6 + misc 前缀稳定性（`TIME.md §11`）；
- parity 脚本（P1 起）：`tools/policy-parity.mjs --fixtures` 输出 old/new 差异，必须为空。
- 观测断言：`time.status().queue[].reason/suppressReason`、`signals.stats().blockedReasons`
  （若新增）、`delivery.blockedCount()`、QQ `blockedReasons` 文案兼容。

---

## 6. 工作量与落地清单（预估）

| 阶段 | 文件 | 预估 |
|---|---|---|
| P0 | `packages/core/src/policy.mjs`（~90 行）、`packages/core/test/policy.test.mjs`（~150 行） | 0.5 天 |
| P1 | time gate/focus.admit 改 facade（~40 行 net）、`policy-parity.test.mjs`（~120 行） | 0.5–1 天 |
| P2 | canonical 字段双写 + mc-link/night-check/qq 读取适配（~60 行） | 0.5 天 |
| P3 | 删旧矩阵（−120 行左右）、文档更新、全量回归 | 0.5 天 |
| 合计 | 净代码 ≈ −60~−80 行（矩阵删掉，新增纯函数+适配器） | 2–3 天 |

### commit 计划（每个可独立回滚）

1. `docs(policy): DELIVERY-POLICY-DESIGN`（本文件）
2. `feat(core): pure delivery policy decide() + golden tests`（P0，不接线）
3. `refactor(delivery): facade both gates through decide (behavior identical)`（P1 + parity 测试）
4. `feat(delivery): canonical suppressReason alongside legacy reason`（P2）
5. `refactor(delivery): delete duplicated gate matrices`（P3）
6. `docs `: TIME.md §4/§16 reason 列表同步

---

## 7. 需要 lead / 用户拍板的点

1. **C1**：✅ 已拍板改、已实施（§2.8）。
2. **C6**：✅ 已拍板改、已实施（§2.8；直投无真实插件调用者，属结构性防洞）。
3. **C3**：✅ 已拍板保留 legacy（canonical 只进新字段）。
4. **队列是否统一**：✅ 拍板**不统一**（两个维度，见 §2.7）。
5. **`budget`/`dedupe`**：确认不纳入 decide（分别留在 awakeTick/quota 与 delivery exactlyOnce）。
6. **signals 路径的闸门顺序**（`time→focus`）是否在 P3 统一成 `focus→time`：**待 P3 决定**。

---

## 8. 参考

- `docs/OLD-QWENSTUFF-MEMORY.md:50`（唯一裁决点 75 行/2 通道/5 reason/只降不丢）、`:75`（9→5 的对照）、
  `:92-93`（值得搬的第 1 条）、`:119`（push budget 不搬）、`:123-124`（失败/测试不足证据）。
- `docs/OLD-QWENSTUFF-APPROVAL.md:36-40`（旧审批 A 套代码无触发路径）、`:78`（防自批原则）、
  `:82-90`（P21 整套删除，"审批体系不继承"）。
- 旧实现：`C:\DSH\qwenstuff\focus-core\apps\dsh-icl\src\domain\policy.js:32-73`（decide）、`:75`（预算）。
- 现行实现：`packages/core/src/host.mjs:40-73`（deliver/admit/focus backlog）、
  `packages/core/src/services.mjs:448-496`（focus current/admit/defer/backlog）、
  `packages/core/src/signals.mjs:125-185`（offer/gates/blocked 返回）、
  `packages/core/src/services.mjs:572-646`（delivery push/gates）、
  `packages/dsh-icl/src/bridge.mjs:545-556`（drain→steer 唤醒）、
  `packages/plugins/time/src/index.mjs`（gate/deliveryGate/time queue）、
  `tools/time-night-check.mjs:206`（reason 校验消费者）、`packages/plugins/mc-link/src/index.mjs:166`（STORED_BY_TIME）。
- 现行 reason 测试分布：`packages/core/test/time-lock.test.mjs`、`qq-rich.test.mjs:268-291`、
  `delivery-gate.test.mjs`、`signals.test.mjs`、`dsh-bridge.test.mjs`。
