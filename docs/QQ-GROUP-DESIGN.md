# QQ 群聊设计草案（基于现有 focus）

> 状态：设计讨论稿，未实现。目标是在不重写 focus 的前提下把 QQ 从"只做 owner 私聊"
> 扩到"多群 + 私聊"的完整 QQ 实现。人格/情绪/精力的动态系统不在本设计里。

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

## 6. 群发送（单独工具，避免误发）

建议新增 `qq_send_group`，而不是让 `qq_send` 接受群目标：

```js
qq_send_group {
  group: '123',
  text?: string,
  messages?: string[],
  replyToMessageId?: string,
  mentionUserIds?: string[]   // 只允许具体成员，禁止 @all
}
```

- 只允许 `allowGroups` 白名单；三把钥匙不变
- 禁止 @all、禁止群管理动作、禁止把私聊内容发到群
- 复用 humanize/短队列/幂等指纹；增加 per-group 限速与全局限速
- 每条群消息同样支持引用；发送后审计只存 hash/长度
- 首版可以先只读群聊 + 手动回复，自动回复策略后置

## 7. 等待 / 戳 / 自动唤醒

- `qq_wait_for_messages` 扩展 `activity`（默认 owner 私聊；群必须显式给 group）
- 群 poke 入站按群消息同类处理；群发送 poke 需白名单 + 频率限制
- **不给每个群配独立 heartbeat/proactive**；群聊唤醒靠 @、focus 与模型主动查询
- 群 nudge 默认关闭；先避免多群同时产生提醒

## 8. 分阶段

### G1：只读多群 + focus（最小可用）

- allowGroups 配置、群 gate/ledger、群信封、@ 标记
- ambient 无 focus 进 focus backlog；focus 进群后摘要回放
- `qq_unread/qq_history` 支持群；world QQ 源显示群未读数
- **不发群消息**；先验证多群不抢话、不刷屏

### G2：群回复

- `qq_send_group` + 白名单 + 引用 + 限速/队列/幂等 + 测试
- 发送策略/频率按真实群调参

### G3：群聊完整体验

- 群 wait、poke、recall/notice、群补课、群未读水位细化
- 可选：focus 切换只回放目标群 backlog、群级静音

## 9. 开放问题（需要拍板）

1. 无 focus 时群 @ 是否直接唤醒，还是也进 backlog？
2. 群发送是否第一版就开放，还是先只读多群？
3. `@all` 永远禁止吗？群管理动作（禁言/踢人）永远不做吗？
4. 群补课回溯窗口/频率；群消息是否默认持久化正文（私聊账本已存正文）。
5. 多群同时 @ 时是否都穿透，还是只保留最高优先级/摘要？
6. 群聊记忆/人物关系是否复用现有 whois/memory，还是单独人物档案（先复用）。
