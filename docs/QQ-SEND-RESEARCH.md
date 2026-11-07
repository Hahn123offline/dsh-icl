# QQ 发送节奏研究（防抖 / 去重 / 打断 / 延迟等待）

状态：研究报告，未改代码。目标：在动手前把旧项目、前身项目、第三方实现里关于"消息什么时候发、发几条、怎么等、怎么打断"的机制、参数和失败模式摊开，作为接下来 QQ 节奏设计的共同事实源。

## 0. 结论先行

1. **发送节奏不是一层"限速器"，而是四层状态机**：入站成批 → 回合/注意力 → 出站队列 + 发送链 → 回复等待/打断。四层必须共用同一份"这条消息处于什么状态"的账本，否则一定会出现重复回复、抢话、假未读、发一半后继续调用工具等旧项目踩过的坑。
2. **旧项目最值钱的不是某个参数，而是三条硬规则**：
   - 同一批发送严格串行（single-flight send chain），整批发完才返回；
   - 发送内容有幂等指纹（同一会话 + 同样内容，短窗口内重试不再发）；
   - "等对方说完"是独立动作（长轮询 quiet window），不能附在 send 上，否则多气泡发送时永远等不到。
3. **当前项目已经有不错的地基**（outbound 三态、humanize 分条、wake 矩阵、账本水位），但缺四块：**入站防抖、出站队列/幂等重试、等待与打断、全局限流/公平**。直接加参数不够，需要补状态机。
4. **参数建议先保守、后调参**：旧项目实测可用的基线是"条间 1–3s + 20% 概率 5–10s、首条 typing 1.4 字/秒、每会话 8/min、60/h、全局 24/min、单批 1–8 条、单条 ≤500 字"；等待 quiet 10–12s、timeout 30–45s、别处打断 quiet 4s / 最多 20s。先用这些，再按真实聊天数据调。

---

## 1. 调查范围

### 1.1 本项目当前实现

- `packages/plugins/qq/src/send-tool.mjs`：`qq_send`、`qq_send_sticker`、限速/去重/审计
- `packages/plugins/qq/src/outbound.mjs`：OneBot 出站三态（ok / rejected / unknown）
- `packages/plugins/qq/src/humanize.mjs`：分条、typing、gap、markdown
- `packages/plugins/qq/src/wake.mjs`：replyCheck / nudge / proactive 规划
- `packages/plugins/qq/src/index.mjs`：入站闸门、账本、补课、唤醒信号
- `packages/core`：focus/time delivery gates（交付层）

### 1.2 旧项目

- `C:\DSH\qwenstuff\dsh-qq`（桥接 + 调度 v2）：
  - `src/bridge.js`：`sendChain`、`splitLongSegment`、`computeGapsV2`、`sendMessagesV2`、`qq_wait_for_messages`、nudge、reply check、attention/lease
  - `src/nudge.js`、`src/attention.js`、`src/core-scheduler.js`
  - `CHANGELOG.md`、`README.md`、`dsh-qq-调度核心设计-v2.md`
- `C:\DSH\qwenstuff\focus-core\apps\dsh-icl`（更早的重写版）：
  - `src/domain/qq-send.js`（planBurst/typing/rateCheck/runBurst）
  - `src/domain/qq-stream.js`、`wait.js`、`attention-window.js`、`rhythm.js`
  - `src/routes/qq.js`（send / wait / 幂等指纹 / 全局限流 / reply 记账）
  - `test/qq-no-duplicate.test.mjs`

### 1.3 第三方

- QQ 官方机器人文档（被动回复窗口/次数、主动消息频控、`msg_id+msg_seq` 去重）：
  <https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html>
- OpenClaw NapCat 插件（三级限流、长消息三种模式、flush 间隔）：
  <https://docs.clawhub.ai/lynn-521/plugins/napcat>
- Koishi `limit-rate`（指令冷却 / 每日额度 / user/channel/platform 作用域）：
  <https://www.npmjs.com/package/koishi-plugin-limit-rate>
- AstrBot 消息防抖合并插件：
  <https://github.com/ahuai114514/astrbot_plugin_message_merger>
- AstrBot `at_gate`（前置碎句合并、生成期多次 @ 静默收敛）：
  <https://github.com/Meru-tea/astrbot_plugin_at_gate>
- qq-maid-bot 消息聚合设计：
  <https://github.com/kuliantnt/qq-maid-bot/blob/6160de035278ad981d0e2faeb820f2d8a2a6784a/docs/tasks/archive/message-aggregation.md>
- openhuman inbound-debounce：
  <https://github.com/tinyhumansai/openhuman/commit/b8a82f084cf93c5968322395dba9d43e7a8e8afe>
- PenguinHarness agent loop（运行中"打断/插话/排队"）：
  <https://penguin.ooo/docs/agent-loop/>
- Claude Code "requeue if interrupted within ms" 设计：
  <https://github.com/piebald-ai/claude-code-system-prompts/blob/69478d05aafd3f31ddc67308c55fa4d9178b4000/system-prompts/data-sdk-user-message-requeue-if-interrupted-within-ms-field.md>

> 外部资料只作为设计参考；QQ 官方文档的限额只适用于官方 API，不直接约束 NapCat/OneBot 本地网关。

---

## 2. 当前项目的事实（读完代码后的清单）

### 2.1 入站

- 闸门：白名单 / owner、去重（`dedupeWindowMs` 默认 24h、上限 5000）、每分钟 30 条、过期、自消息丢弃。
- 账本：`ledger.db` 每个 activity 单调 seq、QQ message_id 去重、水位（delivered / attended 分离）。
- 入站**没有防抖/成批/合并**：每条消息各自 `signals.offer`，一条消息一次唤醒；只有 focus/time 的积压会合并。
- `wake.mjs` 有 replyCheck（发出后 30s 查回复）、nudge（10m 未读提醒）、proactive（默认关）——但它们只是"生成提醒信号"，不是发送队列，也没有"等对方说完"的长轮询。

### 2.2 出站

- `qq_send` 是唯一文本出口；三条钥匙 + 只 owner/白名单私聊；群不存在。
- 人类化：`messages[]` 1–8 条、单条 500 字、条间 auto 1–3s / 20% 5–10s、typing 1.4 字/秒、fixed/byLength；`splitLongText` 按标点/URL 切。
- 限速：每轮 1 次调用；同 peer 最小 5s；10/min、60/h；同文 60s 去重；**超限直接拒绝**（不是排队）。
- 发送：整批在工具调用里逐条发，逐条 kill-switch 检查；失败/部分成功如实报，unknown 不自动重试。
- 没有：出站队列、跨 peer 全局限流、发一半时的取消/打断、等待回复、typing 指示、发送幂等指纹（除同文窗口）。

### 2.3 现有唤醒矩阵

| 类型 | 默认 | 行为 |
|---|---|---|
| replyCheck | 30s | 回完一条后隔 30s 检查有没有新回复 |
| nudge | 10m 软/10m 冷却/6 次每小时 | 有未读时按批提醒 |
| proactive | 关闭 | 30–90m 随机、15m 空闲、30% 概率、30m 冷却 |
| maxWakePerHour | 12 | 唤醒总预算 |

这些参数都在 `wake.mjs`，但没有和发送/等待共用状态，所以容易出现"回复检查 + 真实新消息"双重唤醒。

---

## 3. 旧项目机制（最有参考价值的部分）

### 3.1 旧 dsh-qq v2 的注意力/租约层

- 同一时刻只允许一个活跃会话持有 `lease`；`IN_GROUP` / `OWN_TIME` / `IDLE` / `SLEEP` / `SILENT` 五态。
- 新消息按当前状态处理：群里只 nudge、自己时间入队、IDLE 快速路径、睡眠按安全词/静默入队。
- 租约 TTL 30m、最长 60m，防止一个会话赖着不走；到期强制收回并写"异常退出"。
- nudge：soft 10m / hard 45m / 冷却 10m / 每小时 6 次 / 10s 批窗口；同一批不重复提醒，版本号 + 已送达水位。
- 这些机制解决的是**公平和防饿死**，不是发送速率；当前项目还没有多会话竞争，但一旦上群就必须补。

### 3.2 旧 dsh-qq v2 的发送链

- 全局 `sendChain` 串行：文本、图片、表情、语音都排在同一条 Promise 链上，保证"先文字后表情"的顺序。
- 分条：`splitLongSegment` 按标点/URL 安全切；`computeGapsV2` 三种模式：
  - auto：普通 1–3s，20% 概率 5–10s 长停顿；
  - byLength：800ms + 20ms/字；
  - fixed；硬夹 100–10000ms。
- 发送循环每批最多 8 条、单条 ≤500 字；频率 8/min、60/h；每条前检查会话是否仍允许发送（kill switch）。
- 失败：`lastSendFailed` 明确标记；不再把失败吞成成功；unknown 不自动重试。
- **整批发完才 resolve**（focus-core 特别强调）：以前"第一条回执后其余丢后台"，模型以为已说完，实际 QQ 还在冒泡，表现为"打完字就跑了"。

### 3.3 旧项目的等待/抢话（最有价值）

`qq_wait_for_messages` 是一个长轮询，不是一个 sleep：

- 参数：`timeoutMs`（默认 30s，5s–600s）、`quietMs`（默认 8–10s，最小 10s）、`minNewMessages`。
- 逻辑：等到新消息后，继续等到"最后一条新消息之后 quietMs 内没有新消息"才返回，避免对方连发时抢话。
- 外部打断：别的会话的新消息按"全局消息速率"算一个打断延迟（10s → 10min 指数），加 15s 冷却，避免刷屏时反复打断。
- 沉睡前观察：`timeoutMs=300000` 且 5 分钟没有新消息，才算完成"潜水前观察"；期间有人说话要把新消息交回，模型决定是否参与。
- 等待有租约（15m），泄漏会让同一会话永久 429；重置/退出必须清租约。
- 发送本身**不内置等待**：focus-core 明确把"发完"和"留在对话里等"拆开；旧 v2 曾经把 settle 附在 send 上，导致多气泡时几乎从不等待。

### 3.4 focus-core 的入站成批（值得直接借用）

- 按 activity 测最近 5 秒到达速率；≤5 条/5s 立即给，超过则延迟 `5s × ceil((r−5)/5)`，上限 10min / 20 条（ambient）。
- 普通消息 quiet 6s，被 @ 的 quiet 3s，最多 hold 20s；她正在一轮里时 quiet 延长到 10s。
- 等待：她说完挂住，quiet 12s、timeout 45s；别处 quiet 4s、最多 20s 打断一次。
- 发送幂等：同一 activity + 同样内容，60s 内视为重试，不再发；指纹在第一条真的发出后才记，避免首次失败被吞。
- 发送速率：每 activity 每分钟 8 条 + **全局 24 条/分钟**；对话 TTL 5 分钟（刚说过话的来信算"接着聊"而不是"叫你"）。
- 数据教训：旧实现"三批重复"就是因为 abort 后模型重发，而工具报告与事实不符；指纹 + 事实回报是修法。

---

## 4. 第三方实现的关键模式

### 4.1 QQ 官方 API

- 被动回复：单聊 60 分钟内每条消息最多回复 4 次；群聊 5 分钟内最多 5 次。
- 主动消息：单聊/群聊按 bot + 单关系维度限频（官方文档表：单聊 20/qpm、群 20/qpm，单关系每日 1000 条；不同认证等级 bot 维度略有差异）；互动召回每周期 1 条，30 天内 4 个周期。
- 去重：相同 `msg_id` 可能重复推送，按 `msg_seq` 去重；同一 `msg_id+msg_seq` 重复回复会失败，要递增 `msg_seq`。
- 启示：**回复窗口/次数是协议级状态**，不能只靠本地限速；OneBot 本地网关虽不照搬，但"每条来信的回复次数"和"幂等键"应进账本。

### 4.2 OpenClaw NapCat 插件

- 三级限流 `maxPerMinute / maxPerHour / maxPerDay`（默认 20 / 500 / 3000）。
- 长消息三模式：normal（每片 160 字、间隔 1200ms，带 `[1/N]` 和 reply 段）、og_image（渲染图片）、forward（合并转发）。
- 还有 allowlist、关键词触发、群事件钩子；没有复杂的"等待/打断"状态机。
- 启示：长消息策略和普通聊天要分开；普通聊天适合短气泡，长内容不要硬拆成十几条。

### 4.3 Koishi limit-rate

- 指令级 `minInterval` + `maxDayUsage`；作用域 user/channel/platform；可静默或提示；支持白名单/黑名单豁免。
- 启示：限流作用域要可配；"限流时不发提示"往往比"发一条被限流提示"更像人。

### 4.4 AstrBot 防抖/合并

- `astrbot_plugin_message_merger`：把短时间内多条消息合并成一次处理。
- `at_gate`：前置碎句智能合并、后置多次 @ 与"生成期催促"静默收敛——全生命周期守节奏。
- 启示：防抖不只是入站合并；生成期间用户连续 @/催促也要收敛，避免模型每被 @ 一次就重开一轮。

### 4.5 PenguinHarness / Claude Code 打断语义

- PenguinHarness 把运行中的发送分成"打断 / 插话 / 排队"三种；不同语义不是同一个按钮。
- Claude Code 的 "requeue if interrupted within ms" 说明：打断后短窗口内重新入队，可以避免丢消息，但要区分"用户改主意"与"同一条消息重发"。
- 启示：打断必须定义清楚是"取消未发气泡"、"把新消息插到当前回复前"还是"等当前回复完再处理"；不能一律 cancel 或一律排队。

---

## 5. 建议的状态机（当前项目可实现的版本）

### 5.1 每个 QQ 会话（activity）状态

```
IDLE
  └─ 收到消息 → COLLECTING（防抖窗口）
        └─ quiet / maxHold → THINKING（模型回合）
              ├─ 模型调 qq_send → COMPOSING → SENDING
              └─ 模型调 qq_wait → WAITING
SENDING
  ├─ 新消息到达 → INTERRUPT_PENDING（记录；按策略处理）
  ├─ 整批发完 → WAITING?/IDLE
  └─ 部分失败 → PARTIAL / COOLDOWN（不自动重试 unknown）
WAITING
  ├─ 新消息 quiet 满足 → THINKING（附新消息）
  ├─ 外部事件满足 → THINKING（带摘要）
  └─ timeout → IDLE
```

关键：**入站防抖、模型回合、出站发送、等待**共享同一份 activity 状态；不能用四个互不相干的定时器。

### 5.2 建议的过渡表

| 事件 | 当前状态 | 动作 |
|---|---|---|
| 新消息 | IDLE | 开始 COLLECTING，启动 quiet timer |
| 新消息 | COLLECTING | 重置 quiet timer；被 @/私聊可缩短 quiet；超过 maxHold 强制 flush |
| quiet 到点 | COLLECTING | 合并成一批 → THINKING（一次模型调用） |
| 模型 send | THINKING | 生成气泡计划 → COMPOSING → SENDING（single-flight） |
| 新消息 | SENDING | 记为 interrupt pending；默认不取消已发气泡，未发气泡可中止/保留；按策略决定是否在发完后立刻 THINKING |
| 发送完成 | SENDING | 如果开了 wait：WAITING；否则 COOLDOWN → IDLE |
| 新消息 | WAITING | 重置 quiet timer；满足后 THINKING |
| 外部事件/闹钟 | WAITING | 按 quiet 窗口返回，带摘要 |
| timeout | WAITING | IDLE（可留一条 replyCheck） |
| 发送失败 | SENDING | PARTIAL/COOLDOWN；unknown 不重试；rejected 可重试但要幂等指纹 |

### 5.3 打断策略（需要用户拍板）

1. **finish-then-handle（推荐默认）**：当前气泡发完，停止剩余气泡；把新消息作为下一轮输入。像人"看到你插话，先把这句发出去，再听你说"。
2. **cancel-unsent**：用户新消息到达时取消未发气泡（已发的不可撤回），新消息优先。更像"立刻停手"，但可能造成半句话。
3. **insert**：把新消息插到当前回复前（需要模型重新组织），实现复杂，容易重复。
4. **queue**：完全不打断，按 FIFO 排队。最安全但显得迟钝。

建议：私聊默认 1，长文/多气泡时允许 2；group 以后再做。

---

## 6. 参数基线（可先照抄，再调）

### 6.1 入站防抖

| 参数 | 建议 | 来源/说明 |
|---|---|---|
| 普通 quiet | 6s | focus-core |
| 被 @/私聊 quiet | 3s | focus-core |
| maxHold | 20s | focus-core；不能无限等 |
| 她正在一轮时的 quiet | 10s | focus-core |
| 5s 内 >5 条才延迟 | rate 5/5s | attention-window |
| 最大延迟 | 10min / 20 条 | attention-window |

### 6.2 发送节奏

| 参数 | 建议 | 来源 |
|---|---|---|
| 单批气泡 | 1–8 | 旧 dsh-qq / 当前 |
| 单条字符 | ≤500 | 旧 dsh-qq / 当前 |
| 条间普通 | 1–3s | 旧 dsh-qq |
| 长停顿 | 20% 概率 5–10s | 旧 dsh-qq |
| typing | 1.4 字/秒，600ms–25s | focus-core/当前 |
| 首条 typing 上限 | 12s | focus-core |
| 每会话 | 8/min、60/h | 旧 |
| 全局 | 24/min（建议） | focus-core |
| 同文指纹 | 60s | focus-core |
| 每轮调用 | 1 次（当前）→ 可评估 2 | 当前 |

### 6.3 等待

| 参数 | 建议 | 来源 |
|---|---|---|
| quietMs | 10–12s | 旧 v2 / focus-core |
| timeoutMs | 30–45s | 旧 v2 / focus-core |
| 外部打断 quiet | 4s | focus-core |
| 外部最多等 | 20s | focus-core |
| 沉睡前观察 | 5min | 旧 v2 |
| 等待租约 | 15min | 旧 v2（防泄漏） |

### 6.4 唤醒

| 参数 | 当前 | 建议 |
|---|---|---|
| replyCheck | 30s | 保留，但必须被真实新消息取消 |
| nudge | 10m soft / 10m 冷却 / 6/h | 保留，按批 |
| proactive | 关闭 | 先关，后续单独实验 |
| maxWakePerHour | 12 | 保留 |

---

## 7. 当前项目的主要缺口（按优先级）

### P0：会导致"重复/抢话/假状态"

1. **没有入站防抖**：对方连发 3 条 → 3 次独立唤醒/回合，容易回三遍或回一半。
2. **没有发送幂等指纹**（只有同文 60s，且是 peer 级，不是完整批次指纹）：模型因 abort/unknown 重试时可能已发过；当前没有"unknown 后核对再重发"的流程。
3. **没有打断/取消**：发送多气泡时新消息到达，当前无处理；模型可能发完再回，也可能下一轮重复。
4. **没有等待**：回完就结束回合；30s 后 replyCheck 可能又把模型叫起来，形成"追问式"双重唤醒。

### P1：体验/稳定性

5. **超限直接拒绝**：用户可见"限流：..."; 更自然的是短队列/延迟（但要有上限，不能无限排队）。
6. **只有每 peer 限流，没有全局**：未来多会话会叠加。
7. **没有出站持久化队列**：进程重启/断线时，未发完的气泡只存在内存；当前工具是同步发送，部分失败后不会补。
8. **没有 conversation TTL**：刚聊过的来信和"被叫醒"没有区分；replyCheck/nudge 容易打扰。
9. **没有入站/发送的 observability 指标**：重复率、抢话率、等待命中率、打断次数都没有。

### P2：多群/公平

10. 没有 lease/注意力公平；未来上群需要旧项目的 nudge/lease，但不要照搬其复杂度。
11. 没有按 peer 的队列优先级（owner/私聊 > 群）。
12. 没有"发送中"状态对外可见（模型/UI 不知道还有几条没发）。

---

## 8. 建议的实现拆分（不一次性重写）

### Phase 0：影子观测（不改行为）

- 在 `qq` 插件记录每次入站/发送决策：消息条数、间隔、是否触发 replyCheck/nudge、是否被限流、发送结果。
- 用真实聊天录一版"如果按旧参数会怎么发"的对照；先有数据再调参，避免把状态机调成玄学。

### Phase 1：入站防抖 + 幂等

- 新增纯函数模块（如 `pacing.mjs`）：`planInboundBatch(messages, now, config)`；所有窗口可配、可测试。
- 每 activity 维护 `collecting` 状态、quiet timer、maxHold；flush 时合成一条"消息批"投递（保留原始 seq/时间）。
- 入站账本已有 seq；`(activity, qqId)` 去重继续用；新增 batch id 供模型引用。
- 出站：在 send-tool 里加"批次指纹 + 已发消息 id"；unknown 不自动重试；返回"已发 k/N + 未发内容"。

### Phase 2：出站队列 + 发送链

- 把 `send-tool` 的逐条 `await` 保留为同步语义，但引入 per-activity 的 `outbox`（内存 + 可选持久化）；限速命中时**排队**而不是直接拒绝，队列有上限（如 20 条）和过期时间（如 5min）。
- 全局单飞发送链（跨 activity 串行或按 activity 串行 + 全局令牌桶）；发送前逐条 kill switch。
- `qq_send` 返回"已发/排队/失败"三态；模型不需要自己算延迟。

### Phase 3：等待/打断

- 新增 `qq_wait_for_messages`（或内部自动 settle，二选一，见决策）：按 quiet/timeout 等，返回新消息/外部事件；等待有租约、可取消、可被新消息提前结束。
- 发送/等待期间收到新消息：默认 finish-then-handle；未发气泡可取消；新消息作为下一轮 batch。
- replyCheck 与 wait 互斥：wait 已覆盖同一 activity 时取消 replyCheck。

### Phase 4：调参与 A/B

- 用 lab + 假时钟测边界（不真实发 QQ）；再用真实私聊小样本 A/B：重复发送率、抢话率、平均响应延迟、等待命中率、用户打断次数。
- 参数集中到 `config`，不要在代码里散落魔法数。

---

## 9. 需要你拍板的设计点

1. **等待是显式工具还是自动 settle？**
   - 显式 `qq_wait_for_messages`（旧项目做法）：模型自己决定等多久，状态机清晰，但多一次工具调用。
   - 自动 settle（send 后自动挂 N 秒）：更少调用，但会阻塞回合，且多气泡时容易误等。
   - 我倾向显式，默认不自动等；replyCheck 作为兜底。

2. **打断策略**：finish-then-handle（推荐默认）/ cancel-unsent / insert / queue。

3. **超限行为**：排队（有上限）还是拒绝（当前）？我建议短队列 + 超时丢弃，避免模型看到"限流"后反复重试。

4. **范围**：当前只私聊；群聊是否在同一版状态机里预留（lease/nudge/公平）？建议先私聊做透，群聊另开。

5. **人类化强度**：是否接受"整批发完才返回"（更真实但工具调用更久）？当前实现已经是；确认是否保留。

---

## 10. 参考索引（本仓库文件）

- 当前：`packages/plugins/qq/src/{send-tool,outbound,humanize,wake,index,debounce}.mjs`
- 旧 dsh-qq：`C:\DSH\qwenstuff\dsh-qq\src\bridge.js` 的 `sendChain` / `computeGapsV2` / `sendMessagesV2` / wait 段
- 旧 focus-core：`C:\DSH\qwenstuff\focus-core\apps\dsh-icl\src\domain\{qq-send,qq-stream,wait,attention-window,rhythm}.js`、`src\routes\qq.js`
- 旧文档：`C:\DSH\qwenstuff\dsh-qq-调度核心设计-v2.md`、`dsh-qq-审计报告.md`

---

## 11. 用户决策与 Phase 1 实现记录（2026-11-07）

用户拍板：
1. 等待用**显式工具**，不做 send 后自动 settle。
2. 打断默认 **finish-then-handle**；给较慢打字的人留足时间，避免抢话。
3. 超限用**短队列**（后续 Phase 2）；群聊暂不做，先把私聊自然回复做透。
4. 接受"整批发完才返回"。
5. 范围：先私聊单人会话，群聊成熟后开放。

Phase 1 已实现（`6f274a3`）：
- `packages/plugins/qq/src/debounce.mjs`：纯防抖器 + `mergeSignals`；默认 quiet **10s**、maxHold **30s**、最多 20 条；关闭时同步直投。
- 产品 preset / QQ lab preset 已启用 `inboundDebounce`；插件库默认仍关闭以免破坏旧测试。
- batch signal 带 `meta.qq.batch.seqs`，QQ/focus 重放回执补推整批 delivered；合并后仍保留每条账本 seq、messageId、图片。
- 测试：`qq-debounce.test.mjs` 纯函数 + `qq.test.mjs` 插件集成（flush 后一条 batch、watermark=2）。
- 未做：Phase 2 出站短队列/全局限流/批次幂等；Phase 3 显式 wait/打断；Phase 4 调参。

**慢打字员的注意点**：10s quiet 是"最后一条之后无人再发"的等待，不是固定回复延迟；如果用户 10s 后继续发，新消息会进入下一批（Phase 3 的 finish-then-handle 会保证不抢话）。这个值需要真实聊天调参，不要一次调得太短。

## 12. Phase 2：出站短队列 / 全局限流 / 批次幂等（已实现）

- **短队列**（`send-tool.mjs`）：限流或前一批未发完时不再直接拒绝，而是入队；最多 20 条、TTL 5 分钟；队列满/过期才拒绝。队列按 FIFO 逐条 worker 发送，发送中仍逐条检查 kill switch。
- **全局限流**：新增 `globalSendMaxPerMinute`（产品/ lab = 24），与每 peer 的 10/min、60/h 同时生效。
- **批次幂等**：`peer + 气泡文本 + replyTo` 指纹，60s 窗口内重复调用返回"刚发过/已排队/结果未知"，不再发第二遍；rejected 删除指纹允许有意识重试，unknown 保留指纹阻止盲目重发。
- **语义**：队列中的发送仍然"整批发完才返回"，但 `qq_send` 在排队时立即返回 `queued`；模型看到排队/重复提示就不应再调用。
- **未做**：队列持久化（进程重启会丢 pending）、显式 wait/打断、全局队列公平（多 peer 时仍简单 FIFO）。
- 测试：`qq-send.test.mjs` 新增排队、幂等、队列满三条；全量测试通过。
- 产品/lab preset 已开 `outboxEnabled:true, outboxMaxPending:20, outboxTtlMs:300000, globalSendMaxPerMinute:24`。

**下一阶段（Phase 3）**：显式 `qq_wait_for_messages` + finish-then-handle 打断；届时再把"整批返回 + 队列 + 等待"三者串成一个 per-activity 状态机。

