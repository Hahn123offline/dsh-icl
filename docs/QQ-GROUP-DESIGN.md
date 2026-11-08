# QQ 群聊设计草案（基于现有 focus）

> 状态：**G1 只读多群已实现**；G2 群回复尚未开始。目标是在不重写 focus 的前提下把 QQ
> 从"只做 owner 私聊"扩到"多群 + 私聊"的完整 QQ 实现。人格/情绪/精力的动态系统不在本设计里。

## 0. G1 已落地

- 配置：`groupPolicy:'allowlist'` + `allowGroups:[...]`；默认 `ignore`，产品 preset 尚未打开真实群。
- 入站：白名单群 `message_type=group` 进 gate；普通消息 `tags:['qq','group','ambient']`，@ self
  带 `at/mention`；群账本按 `qq:group:<id>`，群信封 `[QQ群·群名]`。
- 注意力：`focus.admit` 无 focus 时把 ambient 群消息 defer 到该群 backlog；@ 直达；
  当前 focus 的群直达，别群 ambient backlog；focus 进入群时回放积压摘要。
- 繁忙度：新增 `attention-window.mjs`（旧 focus-core 公式），群 debounce 用 per-activity
  5s rate 自适应延迟；安静小群 6s/3s，刷屏群按 5s 步长后压，硬上限 60s/20 条。
- 只读工具：`qq_groups`（群水位/未交付）、`qq_group_history`（群账本）；G1 不发群消息。
- 测试：群 gate、无 focus backlog、@ 直达、focus 群直达、别群 backlog、群只读工具、
  attention-window 纯函数。


## 1. 现有接缝

- 入站：`OneBot → gate → ledger → inboundDebounce → signals.offer`
- 时间闸门：`time` 在 delivery 层统一拦睡眠/静音/暂停，进 time 积压
- 注意力：`focus.admit(signal)` 决定是否能进模型；拦下的进 `focus.defer`，按 `signal.focus` 分桶
- 当前 QQ：群消息整类丢弃，`qq_send` 只允许 owner/白名单私聊
- 当前 focus：同一时刻最多一个模型声明的 focus；没有 focus 时所有信号直达
  （这正是群聊需要补的一层）

## 2. Activity 与信号

沿用现有命名空间，不改 focus 的数据结构：

| 来源 | activity / focus | 默认级别 |
|---|---|---|
| 私聊 | `qq:private:<qq>` | direct（无 focus 时直达；@ 可穿 focus） |
| 群聊 | `qq:group:<group_id>` | ambient（无 focus 时进该群 backlog；@ 才可直达/穿透） |

群消息的 signal 至少带：

```js
{
  from: { plugin: 'qq', activity: 'qq:group:123' },
  focus: 'qq:group:123',
  kind: 'notice',
  tags: ['qq', 'group', ...(atSelf ? ['at', 'mention'] : [])],
  meta: { qq: { envelope: {...}, ledger: { activity, seq, messageId, messageSeq } } }
}
```

- `atSelf`：消息段里有 `at` 指向 self，或引用的是 self 的消息（按产品策略决定）。
- `message_seq` 用于群游标/补课；`message_id` 用于引用/详情，两者不能混用。
- 群消息正文带说话人信封：`[QQ群·群名·昵称] ...`；@ 消息明确标出。
- 自己的群消息不入站；群管理事件（禁言/踢人/入群）先只记录，不唤醒。

## 3. 投递裁决（需要补的最小改动）

当前 `focus.admit` 在"没有 focus"时一律 deliver。群聊需要一条 **ambient 默认进 backlog**：

1. 无 focus + `tags` 含 `ambient`（且没有 `at`/`mention`/`admin`/`alarm`）→ `defer`
2. 无 focus + 群 @ → deliver（可选：也可只进 backlog，见开放问题）
3. 有 focus：
   - 当前 focus 的群 → deliver
   - 其他群普通消息 → focus backlog
   - 其他群 @ → 走现有 `pierce` 规则（默认 mention 可穿；sacred 仍拦）
4. 任何 phase 下先过 `time`：睡眠/静音/暂停仍然优先，进 time 积压
5. 私聊保持现状：普通私聊无 focus 直达；@ 可穿 focus

这只需要在 focus 的 `admit` 增加 ambient 分支，或让 core 统一识别 `ambient` tag；
**不引入 note/nudge/push 三套完整等级**，先保持简单。

## 3.1 旧项目的"繁忙度"机制（确认存在，值得借鉴）

旧 `focus-core` / `dsh-qq` 不是用单一数字，而是三层组合：

1. **per-activity 自适应窗口**（`focus-core/apps/dsh-icl/src/domain/attention-window.js`）
   - 5 秒窗口内该活动 ≤5 条 → 立即给；
   - 超过 → 延迟 `5s × ceil((rate-5)/5)`；
   - 硬上限：ambient 10 分钟/20 条，pierce 60 秒/5 条；
   - **按活动分别测速**：热闹的群不会拖慢安静群的单条消息。
2. **ambient / pierce 两通道**（`domain/policy.js`）
   - ambient：普通群消息，攒着；pierce：@/点名/闹钟/管理员，具体内容插话；
   - 群级静音、sacred、每日唤醒预算可把 pierce 降为 ambient；
   - 旧版后期把 ambient 改成**只拉不推**：世界状态报数，模型想看自己拉。
3. **单一活动租约 + 积压提醒**（`core-scheduler.js` / `nudge.js`）
   - 同一时刻只有一个活跃会话；别处按提及/私聊/最近排序；
   - nudge 按批次提醒：soft 10 分钟、hard 45 分钟、cooldown 10 分钟、每小时最多 6 次。

结论：**“太忙积压、不忙秒回”不是全局 poll 频率，而是 per-activity 的速率窗口 +
pierce 优先 + 单租约。** 安静小群的 rate 低，所以 @/戳可以很快进来；大群刷屏时
rate 高，普通消息被压成摘要。

当前 ICL 已有 10s 固定入站防抖，但缺：
- 按活动测速（所有活动同一个固定 quiet 窗口）；
- ambient/pierce 区分；
- 高繁忙时的自适应延迟与硬上限。

建议在群聊 G1 引入一个**纯函数的 attention-window**（放 core 或 qq 均可），
先用现有 `inboundDebounce` 的 per-activity 桶喂 rate，不先搭完整事件表。

## 4. 多群怎么"聚焦"

- 模型用 `focus_enter({ activity: 'qq:group:<id>', title: '群名' })` 主动进入一个群；
  同一时刻仍然只有一个 focus。
- 进入/切换/离开时沿用现有 `focus.onChange`：把积压合成一条摘要（按 activity 分桶），
  不逐条推送；模型需要详情用 `qq_history`/`qq_unread` 查。
- 没有 focus 时群消息进 backlog，不产生 wake；模型通过 world/heartbeat 的
  `QQ：N 个群有 M 条未读` 或 `focus_backlog` 知道有东西可看，再决定聚焦哪个群。
- 可选后续：focus 进入某群时只回放该群的 backlog，而不是全部摘要；先不做。

## 5. Ledger / 未读 / 补课

- 群账本按 `qq:group:<id>` 存 `seq`（优先 message_seq）、messageId、sender、raw segments。
- `qq_unread` 扩成 `scope: private|group|all`（或新增 `qq_group_unread`），每个群单独水位。
- `qq_history` 支持群；`qq_mark_read` 支持群；回执补推要按群 activity + seq。
- 群补课：`get_group_msg_history(group_id, message_seq)`，按群游标；私聊补课逻辑不改。
- 群通知（poke/recall/mute）只做低优先级事实，不默认唤醒。

## 6. 群发送（复用通用 send）

按用户 2026-11-08 决定：**不新增 `qq_send_group`，仍然用通用 `qq_send`**。
让 `qq_send` 支持：

- `to` 可以是 `qq:group:<id>` / `group:<id>` / `qq:private:<qq>`；省略时用**当前 focus**
  的 activity（配合 `focus_enter` 的快捷参数）。
- 群目标必须在 `allowGroups` 白名单；三把钥匙不变。
- `replyToMessageId` 复用；群引用用消息的 messageId。
- `mentionUserIds` 只允许具体成员；`@all` 实现保留但默认关闭。
- 群管理动作（禁言/踢人/改名）实现保留在能力层，默认关闭；将来只在小范围、
  接受度高的群里作为实验性动作开放。
- 复用 humanize/短队列/幂等指纹；增加 per-group 限速与全局限速。
- 发送后审计只存 hash/长度；禁止把私聊内容发到群。
- 首版只读群聊，不自动回复；手动回复在 G2 开放。

待定：`qq_send` 省略 `to` 时用 focus 会不会误把私聊回复发到群？实现时应要求
**focus 是群且工具调用上下文确认是群**，或者显式 `to`；不允许"当前 focus 是群"
就静默发群（防止模型混淆）。

## 7. 等待 / 戳 / 自动唤醒

- `qq_wait_for_messages` 扩展 `activity`（默认 owner 私聊；群必须显式给 group）
- 群 poke 入站按群消息同类处理；群发送 poke 需白名单 + 频率限制
- **不给每个群配独立 heartbeat/proactive**；群聊唤醒靠 @、focus 与模型主动查询
- 群 nudge 默认关闭；先避免多群同时产生提醒

## 8. 分阶段

### G1：只读多群 + focus（最小可用）

- **已实现**：allowGroups 配置、群 gate/ledger、群信封、@ 标记
- **已实现**：ambient 无 focus 进 focus backlog；focus 进群后摘要回放
- **已实现**：`qq_groups/qq_group_history` 支持群；world QQ 源显示群未读数
- **已实现**：per-activity adaptive window（attention-window.mjs）
- **不发群消息**；产品 preset 默认 `groupPolicy:'ignore'`，要真实只读群需显式配 allowGroups

### G2：群回复

- 通用 `qq_send` 支持群目标 + 白名单 + 引用 + 限速/队列/幂等 + 测试
- `@all`/群管理能力实现但默认关闭；只在受控实验群开放
- 发送策略/频率按真实群调参

### G3：群聊完整体验

- 群 wait、poke、recall/notice、群补课、群未读水位细化
- 可选：focus 切换只回放目标群 backlog、群级静音

## 9. 已拍板 / 待定

已拍板（2026-11-08）：

1. 无 focus 时群 @ **直达**；普通群消息按 ambient/繁忙度处理。
2. G1 **只读**，不发群消息；G2 再开通用 send 的群目标。
3. `@all` 和群管理动作**实现保留但默认关闭**；只在小范围、接受度高的群里作为实验性动作。
4. 多群同时 @：按 per-activity rate + 先到/pierce 优先级处理，不要求全局串行抢答。
5. 群发送复用通用 `qq_send`，支持用当前 focus 做快捷目标；不新增单独工具。

仍待定：

1. 群补课回溯窗口/频率；群消息是否默认持久化正文（私聊账本已存正文）。
2. focus 切换时只回放目标群 backlog，还是沿用现有全量摘要。
3. 群级静音/免打扰是否在 G1 就做；建议 G3。
