# QQ 完整性差距：能力矩阵、分级验收与复刻路线

> 读者：lead、接 QQ 后续实现的人、做 cache/time/focus 的协作者。
> 范围：只做**研究与结论固化**，不写实现代码、不连 SnowLuma、不发 QQ 消息（2026-11-05/06）。
> 研究对象：`C:\DSH\qwenstuff\focus-core\apps\dsh-icl\src\domain\qq*.js`（+ `policy.js`/`ws/qq-events.js`/`loops/qq.js` + 12 个 qq 测试）、
> `C:\DSH\qwenstuff\dsh-qq\src`（`bridge.js` 812KB/14,279 行 + 40+ 辅助模块 + `interface-platform/docs/FEATURE_MATRIX.md` 198 个 OneBot 动作）、
> 以及我们现在 `packages/plugins/qq`（phase 0 只读影子 + phase 1 只回 owner 私聊，均已真实验证）。
> 事实核对：2026-11-06 00:xx；本仓库 HEAD = master（含 phase 1 真实验证 `e3fd594`）。

---

## 0. 结论摘要

### 0.1 "我们的发送链路是否完整？"

**分两层回答：**

| 层 | 结论 | 证据 |
|---|---|---|
| **把一条私聊真的发出去并确认结果** | ✅ **完整**（phase 1 范围内） | 真实窗口：`qq_send` → `outcome=ok`、`messageId=294938146`、`ms=269`；SnowLuma 日志 `send_private_msg` 恰 1 次 / `send_group_msg` 0 次；审计 1 行只有 hash/长度无正文（`C:\DSH\icl\.state\lab\qq-send-20261105-2310/report.md`） |
| **"像人一样回话"的完整发送链** | ❌ **不完整** | 缺多气泡与真人节奏、typing 估算、markdown→纯文本、长文安全切分、引用回复、表情包、发送后读回校验、逐条部分成功/失败上报、语音/文件 |

也就是说：**"能发"已经成立（含三态回执、owner-only、限速/去重、审计、kill switch、unknown 不重试）；"像人、抗错、可复刻旧项目体验"还差三块 P0。**

### 0.2 最大 P0 缺口排序（结论）

1. **P0-1 断线重连后的游标补课 + 消息账本/水位** —— **最大缺口**。现在 WS 有退避重连（`connector.mjs:121-139`），但断线期间的消息**静默丢失**：
   没有 gap 计数、没有"漏了几条"的可见性、没有活动水位/未读/回过没。旧项目用 `message_seq` 游标 + `get_group_msg_history` 补群消息、用 `qq_messages` 账本 + `attended` 水位做"一条只看见一次"。
   **可行性**：SnowLuma OneBot 有 `get_group_msg_history`（群，锚点成熟）、**`get_friend_msg_history`**（私聊，无锚点取最新双向记录；锚点语义需真机验证）、`mark_*_msg_as_read`；**私聊事件无重放**是协议事实，能补多少取决于该 API 语义 → 这一点是本轮研究里最大的未知。
2. **P0-2 入站富内容** —— 图片/文件/合并转发/引用回复/语音现在只剩占位符（`normalize.mjs:42-83` 只保留 `[图片]` 等）。旧项目有完整纯函数：`segmentsToText`（含 at→名片、reply→原消息、forward id、markdown）、`extractMedia`、`expandForward`（嵌套≤2 层）、`resolveReplyInfo`（慢取缓存 + 归属校验）、`fetch_ptt_text`（QQ 原生语音转写，重试 3 次）。
   **跨模块点**：DSH 支持 `ImageBlock`（attachment ref），但 ICL 的 `toDshUserMessage`/`bridge.noticeMessage` 目前只传 text（`dsh-contract.mjs:93-106`、`bridge.mjs:352-380`）→ 图片真正进模型必须小改 `packages/dsh-icl`（lead 已原则批准，见 §6.3 约束）。
3. **P0-3 出站人类化** —— 最小、最快见效：多气泡（1–8 条，条间 1–3s，20% 长停顿 5–10s）、按 1.4 字/秒估算 typing、`mdToPlain`（去 Markdown、代理对安全）、`splitForQQ`（4000 字、URL/emoji 不切断）。旧项目有纯函数 + 单测（`qq-send.test.mjs` 9 条），可直接移植。

### 0.3 研究/验证证据

- 旧 focus-core QQ 测试实跑（只读）：`node --test apps/dsh-icl/test/{qq-send,qq-ws,qq-ledger,qq-poller}.test.mjs` → **28 pass / 0 fail**。
- 旧 QQ 测试共 12 个文件（列表见 §8），覆盖鉴权失败不当成功、seq 单调、水位只前进、游标补缺口、单通道不重复、分条节奏、唤醒矩阵。
- 本仓库现有 QQ 测试：`qq.test.mjs` 19 + `qq-send.test.mjs` 11 + `qq-mc-concurrent.test.mjs` 3 + `qq-preflight.test.mjs` 13；phase 0/1 真实窗口各 1 次全过。
- SnowLuma OneBot 能力以 `dsh-qq/interface-platform/docs/FEATURE_MATRIX.md` 为准（198 个动作，含 QZone 9 个动作；事件见 §3.2）。

---

## 1. 能力矩阵

图例：**旧实现要点**给出参考文件:行；**我们现在** = `packages/plugins/qq` 现状；**成本** = 1 人日估；P 级见 §3。
（"旧"= focus-core，除非注明 dsh-qq。）

### 1.1 连接与可靠性

| 能力 | 旧实现要点 | 我们现在 | 缺口/风险 | 成本 | P |
|---|---|---|---|---|---|
| OneBot WS 正向连接 + 心跳/退避 | `focus-core/domain/qq-ws.js:80-250`：退避 2/5/15/30/60s；`normalizeEvent`；echo 配对 | ✅ `connector.mjs:87-267`：退避 1s→30s+抖动、心跳 stale；零出站帧 | 无（比旧更严格） | 0 | — |
| 群消息游标补课 | `qq-poller.js:22-30,52-130`：`message_seq` 游标，WS 先把游标推最新再轮询补缺口；`get_group_msg_history` | ❌ 无（群整类忽略） | 群 phase2 才需要；私聊另有缺口 | 1.5 | P2 |
| 私聊断线补课 | 旧项目也没做（只群轮询；MESSAGING-SUMMARY 明说"私聊没有可靠补课"）；SnowLuma 有 `get_friend_msg_history`（FEATURE_MATRIX:175，仅透传、锚点语义未验证） | ❌ 断线窗口静默丢消息 | **P0 最大风险**：API 能补多少未知；群事件的 notice/撤回断线不可恢复 | 2 | **P0-1** |
| 事件去重（重连/轮询交叠） | `qq-events.js:24-27` 按 message_id；`appendMessage` 同 qq_id 不重复入账（`qq-ledger.js:31-34`） | ✅ 本地 gate 按稳定 signal id 去重 + 24h/持久化（`gate.mjs:22-84`） | 补课重叠要保证同一 id 不双投 | 0.5 | P0-1 |
| 消息账本/水位/未读 | `qq-ledger.js`：`qq_messages(activity,seq,qq_id unique/activity,...,replied_at)`、`attended` 水位、`unreadMessages`、`markDelivered`、`sinceLastSpoke` | ❌ 只有去重表；无历史、无水位、无未读/回过没 | 补课/一次性投递/防重复回复的基础 | 2 | **P0-1** |
| 单通道（同一消息不双喂） | `qq-single-channel.test.mjs`：对话送过的，pierce 队列里的同 seq 一起标掉 | ⚠️ signals id 去重 + delivery 合批，但没有消息级"两条通道" | 补课后若同时走 WS+历史轮询会撞；用 id/seq 保证 | 0.5 | P0-1 |
| 发送串行 + 间隔 | `bridge.js:8954-8979`：`sendChain` 串行、每段 sleep(cfg.sendDelayMs)、记录 `lastSendFailed` | ⚠️ 单工具调用内单条；无全局发送队列/间隔 | 多气泡时需要（P0-3/P1） | 1 | P0-3 |
| 发送回读校验 | 语音：`bridge.js:2009-2043` get_msg 回读 record 段；普通文本只认回执 | ⚠️ 只认 retcode+message_id（旧文本也如此） | 文本足够；voice 阶段再补 | 0 | — |
| 鉴权失败不当成功 | `qq.js:40-42` retcode≠0 抛错；`qq-ws.test.mjs` | ✅ `outbound.mjs:66-76` 三态 | 无 | 0 | — |
| 断线后状态可解释 | 旧：日志 + `bot_status`；成员事件靠 `reconcileGroup` 兜底（dsh-qq `social/group-events.js:11-14`） | ⚠️ `status.json` 有 reconnects/lastError/stale，但无 gap 计数 | P0-1 加 `gapCount/lastGapAt`，并暴露"可能丢了 N 条" | 1 | P0-1 |

### 1.2 入站消息模型

| 能力 | 旧实现要点 | 我们现在 | 缺口/风险 | 成本 | P |
|---|---|---|---|---|---|
| 文本段 / @ / face / 名片 | `bridge.js:1338-1403` 完整映射（at→群名片、mface summary、markdown、reply、forward id） | ✅ text；⚠️ 其它只占位（`normalize.mjs:42-83`） | @ 名称需要成员查询（group 阶段） | 0.5 | P1（群时） |
| 引用回复解析（入站） | `bridge.js:11570-11697`：慢取缓存（120s）、并发去重、归属校验防跨会话、pending 占位、回复引用也当"叫你" | ❌ 只保留 reply id，不解析 | 不理解"在回哪句"；私聊里也常见 | 1 | **P0-2** |
| 合并转发展开（含嵌套） | `qq-forward.js:62-91`（≤2 层、≤12 条、1200 字）；`qq-events.js:53-60` | ❌ `[合并转发]` 占位 | 群/私聊都可能遇到；有总字数上限防撑爆 | 1 | **P0-2** |
| 图片（下载 + 进模型） | `qq.js:150-196` 下载 ≤2 张/≤8MB；`qq-media.js` 落盘；v2 用 `get_image`/CDN 兜底 + `safeFetchBuffer` 安全抓取（`bridge.js:9341-9419`）；模型不能看图时降级文字 | ❌ 只有 `[图片]` 占位与 URL 引用 | **需要 bridge/DSH attachment 小改**；SSRF/大小/类型/超时风险 | 2.5 | **P0-2** |
| 文件段 | `qq.js:82-...` 保留 name/size/fileId；dsh-qq `files.js`/`files-send.js` 支持收发（上传/下载） | ❌ `[文件]` 占位 | 私聊文件会丢上下文；下载要受控路径 | 1 | P0-2（收）/P2（发） |
| 语音（入站转写） | `bridge.js:61-70` 接 ASR；dsh-qq `voice-asr.js`：`fetch_ptt_text` 重试 3 次×3s，空串常见；失败降级 `[语音]`；本地 whisper 端口预留 | ❌ `[语音]` 占位 | QQ 原生转写依赖网关；延迟/失败率未知；P2 | 1.5 | P2 |
| 表情/收藏表情元数据 | `bridge.js:1421-1463` 保留 emoji_id/package/key/url/sub_type/summary（防字段丢失后无法兜底）；dsh-qq `sticker-lib.js` 297 行知识库 | ❌ 只 `[表情]` | P1 表情体系的前置 | 0.5 | P1 |
| 群成员/好友/人物库 | `qq-forward.js:34-55`、focus-core people；dsh-qq `social/people.js`(28KB) 入群/退群/改名片/连续性 | ❌ 无 | 群阶段；P2 | 2 | P2 |
| 群事件（入群/退群/改名片/撤回） | `social/group-events.js`：规整/去重/分类（stranger/knownElsewhere/returning）；断线丢失靠成员名单对账 | ❌ 无 | 群阶段；P2 | 2 | P2 |
| poke / notice / request / upload | `qq-ws.js:31-78` 归一 poke/notice/upload；`qq-events.js:150-165` | ❌ 全部忽略（本轮） | 群/社交阶段再定 | 1 | P2 |
| markdown/json/xml/卡片 | `bridge.js:1387-1398`：markdown 段读 text/content，卡片占位 | ❌ 未知段忽略 | 低风险 | 0.25 | P1 |
| 入站历史查询工具 | focus-core `qq_history/unread/conversations`；dsh-qq `qq_get_*` 系列 | ❌ 模型无法自己查 | 账本 P0-1 顺带提供 `qq_unread/qq_history` | 见 1.1 | P0-1/P1 |
| 消息时间/发送时间分离 | `qq-ledger.js:22-43` sent_at/received_at；`qq-poller.js` | ✅ `normalize.mjs:84-89`+meta | 无 | 0 | — |
| 入站限流/过期 | 旧靠批处理/预算（`attention-window.js`、`policy.js`） | ✅ 本地 gate 限流/过期 | 无 | 0 | — |

### 1.3 出站

| 能力 | 旧实现要点 | 我们现在 | 缺口/风险 | 成本 | P |
|---|---|---|---|---|---|
| 单条私聊文本 + 回执三态 | focus-core `qq-send.js` + `qq.js:70-77`；dsh-qq `sendToQQ` | ✅ `outbound.mjs:87-275`/`send-tool.mjs`；真实窗口验证 | 无（phase 1） | 0 | — |
| 多气泡 + 节奏 | `qq-send.js:9-111`：≤8 条、条间 1–3s、20% 长停顿 5–10s、单条 ≤500 字、频率 8/min 60/h；`typingMs` 1.4 字/秒 + 语气档位；dsh-qq `computeGapsV2`/`sendMessagesV2` | ❌ 只有单条 | 人类感第一来源；P0-3 | 1 | **P0-3** |
| markdown→纯文本 | `md-to-plain.js:1-37`（代码块/链接/粗斜体/标题/列表/表格；O(n²) 防注入） | ❌ 原样发 | 模型输出常带 Markdown；P0-3 | 0.25 | **P0-3** |
| 长文安全切分 | `md-to-plain.js:39-67`：按换行/4000 字、**不切代理对**；dsh-qq `splitLongSegment` 保护 URL | ❌ >2000 字直接拒绝 | 拒绝太粗暴；P0-3 | 0.25 | **P0-3** |
| 引用回复（出站 reply 段） | `qq.js:70-77` 私聊必须用 reply 段（只传 message_id 参数无效）；dsh-qq `resolveReplyTargetV2` 必须确认归属 | ❌ 无 replyTo | P1；P0-2 入站解析是前置 | 1 | P1 |
| @ 提及 | `qq-ws.js` sendGroup at 段；群阶段 | ❌ 无 | 群阶段 | 0.5 | P2 |
| 表情包发送/收藏/备注 | dsh-qq `sticker-lib.js`（297 行知识库）+ `send_custom_face`/`add_custom_face`/`modify_custom_face` 动作 + 收集策略配置 | ❌ 无 | P1；需图片发送能力（与 P0-2 共用） | 3 | P1 |
| 语音发送 | `voice-tts.js`：QQ AI 声聊（群 `send_group_ai_record`，需 get_msg 回读校验）+ 本地 TTS 端口；`voice-core.js` 音色库/预算 1/min 20/day | ❌ 无 | P2；群 AI 声聊仅群；本地 TTS 依赖额外模型 | 2.5 | P2 |
| 文件发送 | `files-send.js`：upload_group_file→send_group_msg(file)；私聊 upload_private_file；类型白名单/≤N MB/每会话 3/小时 | ❌ 无 | P2 | 1.5 | P2 |
| 拍一拍/回应/撤回 | `qq-ws.js` actions；dsh-qq tools | ❌ 无 | P2 | 1 | P2 |
| 发送前敏感信息拦截 | dsh-qq `sensitive.js`（路径/凭据启发式 + 精确 token 名单 `KNOWN_AGENT_TOKENS`；owner 私聊豁免路径） | ✅ 内置启发式（`outbound.mjs:16-22`） | 缺少"已知 token 精确名单"（我们没 agent token，风险低） | 0.25 | P1 |
| 发送审计（不存正文） | dsh-qq 活动日志/审计；旧 bridge 只滚动日志 | ✅ `send-tool.mjs` JSONL hash/长度/结果 | 无 | 0 | — |
| 逐条部分成功上报 | `bridge.js:6768-6779`：返回 sent/failed；异常携带 `error.sent` 回滚额度 | ⚠️ 单条无此问题；多气泡后必须做 | P0-3 验收项 | 0.5 | **P0-3** |
| 发送队列/kill guard | `bridge.js:8959-8979` `captureSendGuard`（发送时重查会话/权限/模式）；`shouldBlockSilentReply` | ⚠️ 每次调用重读 live keys（kill switch），无队列、无逐泡 guard | 多气泡逐泡 guard 放 P0-3 | 0.5 | P0-3 |

### 1.4 注意力 / 唤醒

| 能力 | 旧实现要点 | 我们现在 | 缺口/风险 | 成本 | P |
|---|---|---|---|---|---|
| 全局投递闸门（停机/静音/专注/预算） | focus-core `policy.js:32-73` 7 道闸门；`attention-window.js` 批处理；ICL `time` gate + `focus.admit` | ✅ 已有（`time` 睡眠/暂停持久积压、`focus.admit` pierce/sacred） | 不要再造第二套 | 0 | — |
| 每会话唤醒矩阵（active/diving、@/名字/关键词/提问/拍一拍/指定人/概率） | dsh-qq `bridge.js:10407-10542`（默认配置）+ `12006-12043`（`evaluateWakeTriggerV2`）+ 防永眠 `ensureWakeableV2` | ❌ 只有全局 time/focus；没有 per-conversation 触发配置 | P1；只能作为**是否发 signal** 的策略，不接管投递 | 3 | P1 |
| 唤醒预算/批窗 | `bridge.js:830-834,12570-12628`：`batchWindowMs=8s`、1/min、12/h、noActionLimit、pendingWake 合并 | ⚠️ time/focus 有积压但无 QQ 唤醒预算 | P1；计入 signal 生成侧 | 1 | P1 |
| 沉睡前观察窗口 | `bridge.js:10469-10503`：设置潜水前必须 `qq_wait_for_messages` 观察 5 分钟或已安静足够 | ❌ 无（ICL time 有自己的睡眠语义） | 与 time 语义冲突风险；映射成 time 的"睡前提案"而非桥接定时器 | 1.5 | P1 |
| 回复检查唤醒（replyCheck） | `bridge.js:12467-12485`：发完后 30s 检查；问号×1.5、连发×1.3 | ❌ 无 | P1 | 1 | P1 |
| 主动机会（proactive idle） | `bridge.js:12718-12750`：30–90min 随机、idle≥15min、概率 0.4×（夜×0.3、刚发过×0.5、1h 内自己发≥5×0.3）、pendingThoughts×1.4 | ❌ 无 | P1/P2（取决于"生活感"优先级） | 1.5 | P1 |
| 积压 nudge/digest | dsh-qq `nudge.js`（156 行）：soft 10min/hard 45min、cooldown、6/h、batch digest 文案 | ⚠️ focus backlog 摘要 + time 醒来重放，无"轻推" | P1；可直接移植纯函数接 focus backlog | 1.5 | P1 |
| 自我唤醒（self-wake） | focus-core `selfwake.js`：30–90min、1/h、idle 90s、focus 时不唤 | ⚠️ time 有日程；无"她想主动冒泡" | P1/P2 | 1 | P2 |
| 注意力状态机 | dsh-qq `attention.js`（58 行纯函数）：idle/group/own-time/sleep/silent + messageDecision + urgent 关键词 | ❌ | P1 可移植为 signal 决策纯函数 | 0.5 | P1 |
| 世界状态/摘要注入 | focus-core `attention.js` renderContext/renderWorld；ICL prompt sections | ⚠️ ICL 有 focus/time 段；无 QQ 专属一行 | P1 加 ≤1 行事实段（体积预算） | 0.5 | P1 |

### 1.5 群 / 社交（phase 2，暂缓）

| 能力 | 旧实现要点 | 我们现在 | 缺口/风险 | 成本 | P |
|---|---|---|---|---|---|
| 群消息入站→活动/水位/投递 | `qq-poller.js` + `qq-router.js` + `qq-delivery.js` | ❌ 整类忽略 | 群 phase2 核心 | 3 | P2 |
| 群策略（静音、@、关键词、提问、指定人、概率） | `qq-router.js:88-140`；`qq-poller.js:60-70`；dsh-qq 唤醒矩阵 | ❌ | 与 focus/time 的 pierce/ambient 对齐 | 2 | P2 |
| 群成员/人物库/连续性 | dsh-qq `social/people.js`、`group-events.js` | ❌ | 2 | P2 |
| 管理员跨群规则 | dsh-qq `social/group-rules.js`（每群≤10 条、≤200 字、注入唤醒提示） | ❌ | 权限/审计重 | 1.5 | P2 |
| 管理员托付（私聊让群会话自己说） | `social/owner-relay.js`（限频/内存 TTL/不落盘） | ❌（ICL 单会话无"群会话"概念） | 架构不同，需重设计 | 2 | P2 |
| 受控跨群查询（presence/activity） | `social/cross-group.js`（有向授权、只统计不内容） | ❌ | 2 | P2 |
| 群文件/群相册/公告 | OneBot 动作 + FEATURE_MATRIX 2.6/2.9 | ❌ | 低优先 | 2 | P2 |
| 空间说说（QZone） | **旧产品无实现**；SnowLuma OneBot 有 9 个 qzone 动作可透传（FEATURE_MATRIX:287-299） | ❌ | 无产品参考；协议/隐私/EULA 风险；建议最后/暂不做 | 5-10 | P2 |

### 1.6 其它旧能力（明确不移植）

| 能力 | 旧实现 | 为什么不复刻 |
|---|---|---|
| 多 DSH 会话（一个 QQ 会话一个 agent） | dsh-qq bridge 全量 | 与 ICL"单人格/单焦点/单会话"设计相反；三代教训就是"一人被切成 N 份" |
| 每会话 agent token + 管理模式/审批/TOTP/box/WSL | `admin/`、`box/`、`mode-handover.js`、bridge 模式机 | 权限模型不同；ICL 是单用户本地单会话；`docs/HISTORY.md` 已记录放弃理由 |
| DOM 控制台/GUI/启动器/多后端抽象 | `bridge.js`、`launcher/` | 与本仓库产品形态无关；只借语义 |
| 黑话学习/记忆库/贴纸描述循环 | `slang-learner.js`、focus-core `qq-memory.js` / sticker loop | 可作为 P1/P2 独立小任务，不阻塞 P0 |

---

## 2. 与现有 focus / time / cache 的接口（实现前必须遵守）

1. **唯一投递出口不变**：QQ 插件只 `signals.offer`；不直接 `delivery.push`、不 `setGate`、不绕过 focus/time。
2. **账本/补课不产生第二条投递路径**：
   - 账本（SQLite/JSONL）只解决"消息事实/水位/gap 可见性"；**投递成功后才推进水位**（ICL 的"成功"= `signals.offer` accepted 且未被 gate 拦；被 time 拦时不推进，等 time 重放后按 signal id 去重）。
   - 补课重放必须复用原 `signal.id`（`qq:scope:peer:message_id`），否则 signals 的 24h 幂等和 time backlog 的 signalId 去重都失效。
3. **time 接口**：睡眠/暂停时 blocked→内容进 time 持久积压（带 signalId，已确认）；QQ 不重试 blocked。补课消息若在睡眠中到达，走同一路径；醒来重放文本，媒体/富内容需要 time backlog 保存/引用（见 §5 风险 R2）。
4. **focus 接口**：私聊 `focus='qq:private:<qq>'`、pierce tags 不变；群阶段 `qq:group:<id>` 作为 activity id，进入群 = 显式 focus 工具调用（不自动切）。
5. **cache 接口（P0-2 动 bridge 时）**：
   - 遵守 `CACHE-MODEL §7 附录 B` 自检：静态 system 段 / facts runtime-context / 每轮 ≤1 快照的布局语义不变；
   - 图片进模型走 DSH attachment/`ImageBlock` 正道；不可用时降级为文本提示 + 按需工具取图，**事件不能丢**；
   - 改 `packages/dsh-icl` 前后先 `git merge master`，把语义影响写进 `docs/CACHE-MODEL.md §7` 的"QQ 图片通道"小节（不改 cache 的数字/结论），并给 cache 留言。
6. **人类化（P0-3）不碰 focus/time**：多气泡仍是一次 `qq_send` 调用；用 `turn-end` 信号维护每轮预算；每个气泡发送前重查 kill switch/权限；不得跨轮残留定时器（dispose 清理）。

---

## 3. 分级与验收标准

### P0（必做，按实际落地顺序）

> lead 2026-11-06 拍板：路线优先级 P0-1 > P0-3 > P0-2；实际实施**先 P0-3**（纯函数、零外部依赖）**再 P0-1**（账本/补课），然后 P0-2。GPU/lab 长测期间纯单测 + fake。

**P0-3 出站人类化（预计 1.5–2 人日；✅ 2026-11-06 已落地）**
- ✅ 实现：`packages/plugins/qq/src/humanize.mjs`（mdToPlain / splitForQQ / splitLongText / typingMs / planBurst / rateCheck）
  + `send-tool.mjs` 接入 `messages[]`、`markdownToPlain`、多气泡节奏、长文切分、逐气泡守卫、部分成功 k/N、审计逐气泡。
- ✅ 测试：`qq-humanize.test.mjs` 9 条（纯函数边界）+ `qq-send.test.mjs` 18 条（含 markdown/多气泡/切分/超额/kill switch/部分成功）；
  全量 `npm test` 468 pass。真实窗口（1 次 `messages=[3 条]` + kill switch）等 lead 批准。
- 验收（原计划）：
  - 单测覆盖旧测试同款语义（单条无延迟/间隔区间/长停顿概率/按长度/fixed/上限/频率/语气档位/切分不切 emoji/URL 完整）——fake + 注入 random/sleep。
  - fake OneBot 执行多气泡：恰 N 帧、每帧 ≤500 字、间隔落在配置区间、markdown 已被清理、过频被拒且**不发帧**。
  - 真实窗口（需 lead 批准）：一次 `qq_send(messages=[3 条])` → SnowLuma 日志 3 次 `send_private_msg`、无群、用户收到 3 条；中途 kill switch → 剩余气泡不发且工具返回"已发 k/N"。

**P0-1 断线补课 + 账本/水位（预计 3–4 人日）**
- 账本：插件本地 SQLite（`node:sqlite` 已有先例：memory 插件）或 JSONL+索引；表字段对齐旧项目：`activity,seq,qq_id,at,sent_at,received_at,sender,text(≤1000),media meta,mention,delivered_at,seen_at,replied_at`；每活动单调 `seq`；`attended` 水位。
- 游标：群用 `message_seq`（WS 到达即推进）；私聊**契约先按 fake 定**：用 `get_friend_msg_history` 拉最近双向记录，以 `message_id`/时间过滤 `> 水位`；真机验证锚点语义后再定（若 API 不支持任意锚点 → 降级为"断线 gap 计数 + 可解释丢失"）。
- 断线可见性：`status.json` 增加 `gap: {reconnects, lastDisconnectAt, lastReconnectAt, possibleLost, backfillFilled, backfillFailed}`；reconnect 后立即补课一次。
- 验收：
  - fake：WS 断开 3 条消息→重连→补课后**不丢不重**（按 id/seq），水位只推进到投递成功处；重复补课不双投；消费方可用 `qq_unread(afterSeq)`。
  - 单测：seq 单调、qq_id 去重、水位只进不退、断层不跳号、重启恢复（SQLite）。
  - 真实窗口（需 lead 批准）：连接中 kill SnowLuma WS（或断网模拟不可行时 kill lab 的 WS 连接）→ 恢复后 gap 指标合理、无重复回复；私聊补课能力按真机结论记录（做不到就明确报 gap，不静默）。

**P0-2 入站富内容（预计 4–6 人日，含 bridge/cache 协调）**
- 纯函数移植：`segmentsToText`（at→名片、reply 解析、forward id、markdown、mface summary）、`extractMedia`、`expandForward`（≤2 层/≤12 条/1200 字）、`resolveReplyInfo`（背景慢取 120s +  ingest 等 4s + pending 占位 + 归属校验）、图片安全抓取（https only、≤2 张/≤8MB、media type 校验、`get_image`/CDN 兜底）、文件元数据（name/size/file_id）+ `get_private_file_url`/`get_file` 受控下载、语音 ASR 端口（P2 先留接口）。
- 进模型：优先 DSH attachment/`ImageBlock`；不可用降级"文本明确说明 + `qq_get_message_images` 工具按需取图"。
- 验收：
  - fake：私聊富消息（图片+文件+引用+转发）→ 模型可见：文字 + 图片（或可操作提示）+ 文件 name/size + 引用原文 + 转发展开；获取失败**降级占位并上报**，事件不丢。
  - 安全：非 http(s)/内网/超大/非图片 → 拒绝且不崩；不把本地路径/凭据交给模型。
  - cache：`npm test` 全绿 + CACHE-MODEL §7 自检不变 + cache 留言。
  - 真实窗口（需 lead 批准）：用户发 1 图 → 她能描述/引用；发 1 引用回复 → 她知道在回哪句。

### P1（P0 稳定后）

- 账本工具：`qq_unread/qq_history/qq_recent/replied` + `qq_mark_read`（只到已看水位，防假装已读）；验收同旧 `qq-ledger.test.mjs` 5 条。
- 出站引用回复：reply 段（私聊必须 reply 段）；验收 fake + 真实 1 条。
- 表情包：移植 `sticker-lib.js`（知识库/备注/策略注入）+ 入站收集 + `send_custom_face`/图片发送；预算/大小/上限；验收 fake + 受控真实 1 张。
- 注意力/唤醒矩阵：per-conversation 配置（mode/triggers/budget/batchWindow/睡眠观察）、replyCheck、proactive、nudge digest；**只生成 signal，不接管投递**；验收：配置矩阵单测 + "同一批积压只提醒一次" + 不越权穿透 focus/time。
- 验收通用：`npm test` 全绿、对 focus/time 现有测试无回归、真实窗口按需申请。

### P2（用户明确后再做）

- 语音：入站 `fetch_ptt_text` 重试 + 降级；出站音色库/QQ AI 声聊（群）/本地 TTS；预算 1/min、20/day；P2 验收含失败可解释与不刷屏。
- 群 phase2：群消息→账本→signals（每群 activity、群策略、@/关键词 pierce、静音 ambient）、成员事件/人物库、管理员规则/托付/跨群、群发送人类化；**用户单独批准 + 白名单 + 人工值守**；验收按 focus-core 压测口径（不丢/不重/有序/有界）。
- 空间说说：SnowLuma 9 个 qzone 动作可透传，但无产品设计 → 先做"只读动态/说说"可行性 spike；发布/评论需用户批准 + 隐私/EULA 评估；成本不确定，建议最后。

---

## 4. 推荐路线：自己写 / 移植 / 适配

| 模块 | 路线 | 理由 | 成本 |
|---|---|---|---|
| md-to-plain、planBurst/typing/PACES、splitForQQ | **直接移植（带旧测试）** | 纯函数、无依赖、旧测试覆盖边界（代理对/URL/O(n²)）；dsh-qq 的 `splitLongSegment` 可补 URL 保护 | 0.75 |
| nudge、attention、forward 格式化、sticker-lib | **直接移植** | 纯函数/无 IO（sticker 有文件读写，需要路径适配）；旧代码注释即设计文档 | 1–1.5 |
| qq-ledger（SQLite/水位） | **适配** | 表结构/水位语义可复用；要改造成 ICL 插件本地库 + 与 signals 投递成功对齐（旧项目有 DB 单例全局依赖） | 2 |
| qq-poller 游标/补课 | **适配** | 群逻辑可搬（`message_seq`）；私聊要按 SnowLuma `get_friend_msg_history` 重新定契约（旧项目没做过私聊补课） | 1.5–2 |
| 引用慢取缓存（quote-forward.js） | **适配** | 纯函数可直接移植（`createSlowFetchCache`/`waitAtMost`/`pendingReplyText`）；fetch 换成我们的 OneBot call | 0.5 |
| 图片获取（fetchOneBotImage） | **适配 + 自己写安全层** | 旧实现含 CDN 兜底/大小/类型校验，但有本地路径/依赖；我们要加 SSRF allowlist（仅 http(s)、禁内网） | 1.5 |
| DSH 图片投递（bridge） | **自己写（小改）** | 旧项目不经过 ICL；需按 DSH attachment API + cache 约束实现 | 1–1.5 |
| 群 pipeline / 群策略 | **适配 focus-core**（不搬 bridge） | `qq-poller/router/policy` 的语义成熟且有测试；重新接到 ICL signals/focus | 3–4 |
| 唤醒矩阵 / replyCheck / proactive | **适配 dsh-qq 语义 + 自己写调度** | 旧逻辑与"多 DSH 会话"绑定；只取 triggers/budget/batch 语义，生成 signal | 4–6 |
| 语音（ASR/TTS） | **适配** | `voice-asr/voice-tts` 纯逻辑清楚；网关动作已确认；依赖模型/音色文件 | 3–4 |
| QZone | **自己写（最后）** | 无产品参考，只有透传动作；需要产品/隐私设计 | 5–10（不确定） |
| **dsh-qq bridge.js 主体** | **不移植** | 812KB/14,279 行单 `main`、多会话/模式机/审批/WSL/控制台；与 ICL 架构冲突，移植=把三代教训再来一遍 | — |

**落地顺序（lead 批准）**：P0-3（纯函数，1–2 天）→ P0-1（3–4 天）→ P0-2（4–6 天）→ P1（按账本工具/引用 → 表情 → 唤醒矩阵，约 8–10 天）→ P2（语音 → 群 → 空间，约 15–25 天，按需）。
**每个 P0 完成**：全量 `npm test` 绿（当前 452+）+ fake 场景 + commit 到 `wt/qq` + merge 信号；真实 QQ 验证单独向 lead 申请。

---

## 5. 风险清单（按后果排序）

| # | 风险 | 后果 | 缓解 |
|---|---|---|---|
| R1 | **私聊补课 API 语义未知**：`get_friend_msg_history` 可能不支持任意锚点/只给最新双向记录；OneBot 事件无重放 | 断线窗口仍可能丢私聊；若假装连续，会让她答非所问 | 先 fake 定契约 + 真机小窗验证（需批准）；做不到就显式报 `possibleLost`，绝不静默 |
| R2 | **群 notice/撤回/戳一戳断线不可恢复** | 事件丢失；人物库/上下文偏差 | 成员名单对账（`get_group_member_list`）；gap 指标；群阶段再补 |
| R3 | **图片/文件抓取安全**：SSRF、内网、超大、伪装类型、本地路径 | 泄露/DoS/打到内网 | 仅 http(s) 且禁内网/localhost；大小/数量/类型/超时硬限；不把 URL/路径交给模型；受控目录 |
| R4 | **DSH attachment 形状/可用性** | 图片进不了模型 → 退回工具取图（体验降级） | 先做 attachment spike；不可用即降级文本+工具，事件不丢；告知 cache |
| R5 | **多气泡 vs 回合预算**：8 条×10s 可能超过回合/打扰 | 发送跨轮、消息过期、打断 | 每气泡前重查 kill switch/目标/轮次；总时长上限；`turn-end` 清理；部分成功如实报 |
| R6 | **唤醒矩阵变成第二套 gate** | 与 focus/time 语义冲突、重复拦截 | 只允许"是否 emit signal"的决策；预算/限频在 emit 前；投递仍由 time/focus |
| R7 | **群安全/冒犯风险** | 社交事故/封禁 | 用户单独批准；白名单；静音/@ 语义；人工值守；phase 2 最后 |
| R8 | **QZone EULA/隐私** | 协议/合规风险 | 只做只读 spike；写操作需用户单独批准 + 评估；建议不做 |
| R9 | **账本隐私/体积** | QQ 聊天落盘、增长 | 本地 stateDir、权限收紧、保留上限/清理策略、审计不存正文 |
| R10 | **补课与 WS 交叠双投** | 重复回复 | 统一 `signal.id`/`seq` 双键去重 + 单通道测试（旧 `qq-single-channel/no-duplicate` 用例） |
| R11 | **多会话旧架构诱惑** | 重走"一人切 N 份"老路 | 明确不移植；单人格/单焦点是 ICL 设计前提；QQ 只是活动之一 |

---

## 6. 开放问题（需要真机验证 / lead 拍板）

1. `get_friend_msg_history` 的参数/锚点/返回字段/是否含自己消息（FEATURE_MATRIX 说"无锚点取最新双向记录"）→ 决定 P0-1 私聊补课的上限。
2. `mark_private_msg_as_read`/`mark_group_msg_as_read` 是否影响用户其他客户端已读（是否要同步水位）→ 产品决定。
3. DSH attachment 从插件创建 `ImageBlock` 的官方 API（`dsh-attachment` 暴露面）→ P0-2 spike。
4. deepseek-flash 是否声明 image 输入（`inputModalities` 含 image；dsh-acp 有校验）→ 决定图片是否 inline 还是工具取图。
5. 群 phase2 的用户期望（哪些群、什么语气、谁批准）→ 用户单独决定。
6. QZone 是否在范围内（用户从未提过具体需求）→ 建议最后、只读优先。

---

## 7. 附录：证据与文件索引

### 7.1 旧 focus-core（只读）

- `domain/qq-ws.js`：`normalizeEvent`/`createQqSocket`/动作（send_private/group、history、forward、poke、react、member list、upload）。
- `domain/qq-poller.js`：游标 `message_seq`、群/私聊/notice/poke 分发、`dedupeKeyFor`。
- `domain/qq-ledger.js`：`qq_messages`/`attended`/`unread`/`markDelivered`/`markRead`/`markReplied`/`sinceLastSpoke`。
- `domain/qq-delivery.js`：一次全量 + 水位 + 闸门。
- `domain/qq-send.js`：`BURST`/`TYPING`/`PACES`/`planBurst`/`rateCheck`/`runBurst`。
- `domain/qq-stream.js`：等待/静默判定（`waitDecision`）。
- `domain/qq-events.js`：事件分发、转发展开、ASR、图片落盘、admin ask、upload/poke。
- `domain/qq-media.js`：图片落盘/加载。
- `domain/qq-memory.js`：群维度记忆摘要（15 条/1h）。
- `domain/qq-forward.js`：嵌套转发展开、成员/好友解析。
- `domain/qq.js`：OneBot HTTP 动作、`textOfMessage`、`isMention`、`loadQqCredentials`、图片下载。
- `domain/policy.js`、`attention-window.js`、`rhythm.js`、`wait.js`、`selfwake.js`：闸门/批处理/节奏/等待/自唤醒。
- 测试 12 个：`qq.test / qq-ws / qq-poller / qq-ledger / qq-delivery / qq-send / qq-stream / qq-policy / qq-no-duplicate / qq-replied / qq-single-channel / qq-memory`。

### 7.2 dsh-qq（只读）

- `bridge.js`：14,279 行；工具映射 5952-5989；配置默认 776-899；发送管线 8954-9060+；多气泡 6530-6780；唤醒矩阵 10407-10542/12006-12043；回复检查 12467-12485；主动机会 12718-12750；引用解析 11570-11697；segmentsToText 1338-1403；媒体 1421-1463/9341-9510；投递队列 11171-11292。
- 纯函数模块：`md-to-plain.js`（117）、`quote-forward.js`（108）、`forward.js`（222）、`nudge.js`（156）、`attention.js`（58）、`sticker-lib.js`（297）、`sensitive.js`（15）、`voice-asr.js`（106）、`voice-tts.js`（110）、`files-send.js`（82）、`schedule.js`（19KB）。
- `social/`：`group-events.js`（117）、`group-rules.js`（107）、`owner-relay.js`（135）、`cross-group.js`（64）、`people.js`（28KB）、`memory-policy.js`（10KB）。
- `interface-platform/docs/FEATURE_MATRIX.md`：198 个动作（含 `get_friend_msg_history:175`、`fetch_ptt_text:157`、custom face 170-173、qzone 287-299）；事件 333-372；消息段 389-430；网络 434-444；M4 缺口 523-529。

### 7.3 我们（本仓库）

- `packages/plugins/qq/src/{connector,normalize,gate,outbound,send-tool,index}.mjs`（216/166/223/275/198/523 行）。
- `packages/dsh-icl/src/bridge.mjs:352-380`（notice 仅 text）；`packages/core/src/dsh-contract.mjs:93-106`（`toDshUserMessage` 仅 text）。
- `packages/core/src/services.mjs:572-707`（delivery，可带 content/images 字段，但 bridge 未用）。
- `docs/QQ.md` §7.2/§10.1/§11.1（phase 1 清单与真实窗口）、§0.2/§0.3（真实影子/真实出站验证）。
- 测试：`qq.test.mjs` 19、`qq-send.test.mjs` 11、`qq-mc-concurrent.test.mjs` 3、`qq-preflight.test.mjs` 13。
- 真实验证证据：`C:\DSH\icl\.state\lab\qq-send-20261105-2310/{report.md,qq-shadow/status.json,qq-shadow/send-audit.jsonl}`；`qq-shadow-20261105-2257/report.md`。

### 7.4 本次研究执行的只读验证

- `node --test apps/dsh-icl/test/{qq-send,qq-ws,qq-ledger,qq-poller}.test.mjs`（focus-core）→ 28 pass / 0 fail。
- 未启动 SnowLuma、未发 QQ 消息、未改旧仓库、未起 lab、未占 57101/54838/GPU。
