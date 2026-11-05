# QQ 接入：连接器形态、只读影子与落地顺序

> 读者：接 QQ 的人、做 time 静音锁的人、跑 shadow 时间窗的人。
> 结论先说：**QQ 不进核心，只做一个"只读入站插件"**——接 OneBot WS，把私聊规范化成 ICL signal，交给现有的
> `signals → time gate → focus.admit → delivery → bridge.steer` 链路。**本轮不发任何 QQ 消息**（连 `get_login_info`
> 这种动作都不发），群消息整类忽略。真实 SnowLuma 影子要用户批准时间窗后再跑，清单见 [§10](#10-shadow-runbook可执行清单)。
>
> 代码：`packages/plugins/qq/`（默认 `enabled:false`）；测试：`packages/core/test/qq.test.mjs`（18 条）；
> 演练：`packages/plugins/qq/tools/{fake-onebot,qq-shadow-host,lab-shadow}.mjs`。
> 事实核对时间：2026-11-05；基线 `7bebecd` + master `fa890ab`（lab 工具）。

## 0. 状态与不变量

| 项 | 状态 | 证据 |
|---|---|---|
| 三份参考研究 | ✅ | 本文 §1 |
| 连接器/消息模型/focus 张力设计 | ✅ | §3–§7 |
| 只读入站实现（OneBot WS → signals） | ✅ | `packages/plugins/qq/src/` |
| 单测（规范化/去重/gate/限流/不发送） | ✅ 18 条 | `node --test packages/core/test/qq.test.mjs` |
| QQ × MC 并发接缝（T1–T3，纯 fake） | ✅ 3 条 | `packages/core/test/qq-mc-concurrent.test.mjs` |
| shadow preflight（谁可能抢连接，一条命令出结论） | ✅ 8 条判定单测 + 真机 BLOCK 证据 | `packages/plugins/qq/tools/preflight.mjs` |
| 全量测试 | ✅ 340 pass | `node --test packages/core/test packages/mc-body/test` |
| 进程内演练（含 time 睡眠锁） | ✅ 12/12 | `.state/qq-shadow/fake-2026-11-05T10-14-11-098Z/report.md` |
| 真实 lab 验证（假上游，端口 57108） | ✅ 10/10；模型显式 `selectModel(deepseek-account/deepseek-flash)`，不继承 profile 默认 | `.state/lab/qq-6/report.md` |
| 真实 SnowLuma 影子 | ⏸ 未跑，等用户时间窗 | §10 runbook |

三条不变量（任何后续改动都不能破坏）：

1. **零出站帧**：qq 客户端从建立连接到销毁，`framesSent === 0`（`connector.mjs` 里没有任何 `ws.send`；单测断言 `FakeWebSocket.sent.length === 0`，回环测试断言假服务器 `clientDataChunks() === 0`）。
2. **群整类忽略**：`message_type === 'group'` 在准入闸门第一层就被拒绝并计数，**不解析、不记录文本**。
3. **默认关闭**：`enabled:false` 时完全不建连接；私聊白名单为空时一条都不收。

## 1. 三份参考读到了什么（只读，不复制代码）

### 1.1 `C:\DSH\qwenstuff\focus-core`（最新，优先）

它是"QQ 即架构"的完整教训集，能直接搬的是**形状**，不能搬的是**三份状态**。

| 文件 | 事实 | 对我们的取舍 |
|---|---|---|
| `apps/dsh-icl/src/transports/contract.js` | 最小传输契约：`name/capabilities/normalize/send`；活动 id = `transport:scope:id`（`qq:group:<id>` / `qq:private:<id>`）；不支持的能力抛 `NotImplemented` | 采纳：活动 id 与 `focus` 命名空间直接用 `qq:private:<qq>`；**不采纳**"一个对象同时管收发"——本轮收发分开 |
| `apps/dsh-icl/src/domain/qq-ws.js` | OneBot v11 正向 WS；`normalizeEvent` 把 message/notice/poke/upload 归一；echo 配对回执；重连退避 `[2s,5s,15s,30s,60s]`；`ev.time` 是秒 → `*1000` | 采纳：WS 正向连接、心跳、`time*1000`、退避；**不采纳** echo/动作（我们不发送，所以没有 pending） |
| `apps/dsh-icl/src/domain/qq-poller.js` | 群游标用 `message_seq`（`message_id` 会变负数）；私聊默认 `pierce`，群普通 `ambient`、@ 才 `pierce`；`appendMessage` 记 `sent_at`/`received_at` 两个时间 | 采纳：私聊=pierce 的语义、消息时间与收到时间分开（我们的 `createdAt` vs `meta.qq.receivedAt`）；**不采纳** HTTP 轮询——私聊历史在 OneBot v11 没有可靠的补课接口 |
| `apps/dsh-icl/src/domain/qq-ledger.js` + `qq-delivery.js` | 一个账本 + 每个活动一个"看到过哪"水位；投递成功才推进；一次投全量；**三份状态（DB/内存 coalescer/events）是假未读与丢消息的根因** | 采纳教训：ICL 已经有唯一的 `signals + delivery` 出口，插件**不另建账本**；去重只做"入站幂等"这一件事 |
| `apps/dsh-icl/src/domain/policy.js` | ambient/pierce 两级；停机→全静；不再任何活动→全穿；闹钟/admin 永穿；群静音把 pierce 降 ambient 但**@ 仍穿**；`sacred`（不可打断）把 pierce 降 ambient；预算用尽降 ambient | 采纳两级语义与"特权穿透"；ICL 的对齐点见 §6 |
| `apps/dsh-icl/docs/MESSAGING-SUMMARY.md` | 压测数字与"未读不是债务，一次全量 + 一个水位"的决议；send 与 wait 的演化 | 采纳：不在 QQ 插件里做"未读逐条确认"；告警/摘要交给 time/focus 的积压 |

### 1.2 `C:\DSH\qwenstuff\dsh-qq`（第三方，稳定的 OneBot/SnowLuma 接法）

真正可复用的"厂商事实"都在 `interface-platform/src/connectors/onebot-v11/`：

| 事实 | 位置 | 是否采纳 |
|---|---|---|
| 端点只读发现：`<SnowLuma>/config/onebot_<uin>.json` 的 `networks.wsServers[0]`，换账号端口/token 都会变，所以每次重连前重读 | `qq-snowluma/discovery.mjs` | ✅ 我们的 `discoverOneBotEndpoint()` 就是它的最小版 |
| token 走 URL `access_token`；握手 10s 超时；断线退避 + 抖动 | `onebot-v11/connector.mjs` | ✅ |
| 在线判定看 `meta_event/heartbeat` 的 `status.online/good`；`notice/bot_status` 也算 | 同上 | ✅ 记录 heartbeat/stale（`heartbeatStaleMs`），但**不据此发任何动作** |
| 鉴权失败两种形态：握手被拒 / 先接受再 `retcode 1403` 断开 | 同上 | 📌 我们的连接器只记录错误，不重试鉴权（因为 token 来自发现，不会手填错） |
| 消息段映射：text/at/reply/image/record/video/file；临时会话 `sub_type === 'group'` 是第三类 | `onebot-v11/mapping.mjs` | ✅ 私聊只认 `message_type === 'private'`；临时会话拒绝 |
| 明确不程序化启停 SnowLuma（EULA §5.4）| `dsh-qq/src/mcp-host-server.js` 顶部注释 | ✅ 我们也不启动它，见 §10 |

### 1.3 `C:\DSH\qwenstuff\icl`（本仓库前身）

**没有 QQ 代码**。`docs/HISTORY.md` 自己写："QQ 连接器 ❌，集成层，工作量最大"；并记录三代（dsh-qq / focus-core / icl）都栽在同一处：
**"一个机器一个实例"最终变成"每个宿主各起一份，再用锁去补"**。

结论：QQ 只能以**插件**身份出现，不能塞进 `packages/core` 或 `packages/dsh-icl`；否则又会造出第二条投递路径。

### 1.4 本仓库已有的接缝（为什么不需要重写）

| 接缝 | 事实 | 位置 |
|---|---|---|
| signal 契约 | `kind` 五选一、`from.plugin` 必填、`id` 幂等（24h）、gate 拦下的**不占 id**、过期拒绝、没有 deliver 时明确报错 | `packages/core/src/signals.mjs:114-168` |
| 投递闸门 | `host` 的 `setDeliver` 先问 `focus.admit`，被拦进 `focus.defer`，放行才 `delivery.push` | `packages/core/src/host.mjs:40-56` |
| 投递队列 | `batchKey` 合批、`ack` 推进水位、`nack` 退避重试 | `packages/core/src/services.mjs:557-667` |
| 进会话 | `delivery tick` 把 batch 变成 `plugin:<producer>` 的 notice，优先 `agent.steer`（空闲起一轮，运行中下个 step 注入） | `packages/dsh-icl/src/bridge.mjs:269-311` |
| focus 穿透 | `focus.admit`：同 focus 穿、privileged（time/admin/alarm）穿、`interruptible:false` 全拦、其余按 `resolvePierce`（默认级别 `mention`，`tags` 含 `mention` 才穿） | `packages/core/src/services.mjs:456-469`、`contracts.mjs:65-79` |
| time 静音锁 | `signals.setGate(gate)`：sleeping/paused 时把非 time 信号抄进自己的持久积压并拒绝，醒来 `flushQueue` 一次性重放 | `packages/plugins/time/src/index.mjs:167-198,495` |

QQ 插件只做两件事：**把 OneBot 事件变成 signal**、**offer 给 signals**。其余全部复用。

## 2. 本机 QQ 现状（账号、配置、消费者）

### 2.1 记录

| 项 | 值 | 出处 |
|---|---|---|
| 机器人 QQ | **2593621742** | SnowLuma 配置文件名 `onebot_2593621742.json`、日志前缀 `[2593621742]` |
| owner（人类）QQ | **3429502459** | `dsh-qq/config.json` 的 `ownerQQ`；唯一私聊白名单 |
| 白名单群（本轮不接、永不发） | 601357169、1057812765 | `dsh-qq/config.json` `allow.groups` |
| SnowLuma | v2.1.1 lite，`C:\Users\ai_admin\Downloads\SnowLuma-v2.1.1-win-x64-lite` | 目录 + 部署笔记 |
| OneBot WS | `127.0.0.1:3001/`，`role=Universal`、`messageFormat=array`、`reportSelfMessage=false` | `config/onebot_2593621742.json` `networks.wsServers[0]` |
| OneBot HTTP | `127.0.0.1:3000/`（与 WS **不同 token**） | 同上 `httpServers[0]` |
| token | 存在上述配置文件的 `accessToken` 字段；**本文不记录其值** | 同上 |
| SnowLuma WebUI | `127.0.0.1:5099`（手动运维用） | `config/runtime.json` |
| dsh-qq 旧桥接 | `ws://127.0.0.1:3120/onebot/v11/ws`（接口平台代理，**当前未运行**）；控制台 3100、控制中心 3099 | `dsh-qq/config.json`、部署笔记 |
| SnowLuma 最后活动 | **2026-11-01 04:07**；`02:32:10` 有一条 `ws-default socket error: read ECONNRESET` | `logs/snowluma-2026-11-01.log` |
| 真实聊天数据 | `dsh-qq/state/`（人物/会话/审计）；`focus-core/state/focus.db`（QQ 消息账本，MESSAGING-SUMMARY 记 110 条 ≈ 936 tokens） | 目录存在 |
| 日志 | `<SnowLuma>/logs/snowluma-YYYY-MM-DD*.log`；旧桥接 `dsh-qq/state/logs/` | 同上 |

### 2.2 现在有多少人在连 QQ

**结论：当前没有任何活连接**（2026-11-05 18:00 实测）：

- `3000/3001`（SnowLuma）、`3120`（接口平台）、`3100/3099`（dsh-qq 控制台）、`5099`（SnowLuma WebUI）**都没有监听**；
- 无 `QQ.exe` / `SnowLuma` / `NapCat` 进程；
- 唯一相关进程是 `node apps\dsh-icl\src\main.js`（pid 12232，2026-11-04 00:33 启动，占 3201，**无任何出站连接**）——它是 focus-core 旧应用，见下。

### 2.3 谁可能抢连接（shadow 前必须逐个核对）

| 消费者 | 位置/触发 | 现在 | 启动 SnowLuma 后 | 会不会发消息 | 处置 |
|---|---|---|---|---|---|
| **focus-core 旧应用** | pid 12232，`focus-core/apps/dsh-icl/src/main.js`；启动文件夹有 `dsh-icl.lnk` | 在跑（3201），无出站 | **会**：源码是无条件模块级块——`loadQqCredentials()` 扫 `~/Downloads/SnowLuma-\*/config/onebot_*.json` → `createOneBot`（HTTP 3000）+ `createQqSocket().start()`（WS 3001），并每 10s 检查连接、连上就 HTTP 补课群消息 | **会**：`main.js:145` 在"会话指针坏了"时给 owner 发私聊；`routes/qq.js` 还有发送端点；它用**旧人格** | **时间窗前必须停掉（需用户知情）**；它的 auto-start 快捷方式还在启动文件夹，重启登录会回来 |
| desktop DSH（用户 GUI） | `~/.dsh/profiles/desktop/cordis.patch.yml` | 在跑 | **不会**：`mcp-snowluma` / `mcp-snowluma-host` 已于 2026-10-28 移除（patch 里只剩注释）；`qq-mode-console`/`qq-agent-presets` 只是设置页和 preset，不含连接器 | 不会 | 不用动，但**绝不重启 desktop** |
| dsh-qq 控制中心 / 桥接 | `dsh-qq/control-center-hidden.vbs`，3100/3120 | 未运行 | 如果用户手动启动，会经接口平台连 SnowLuma | **会**（它本来就是聊天桥） | 时间窗内不启动 |
| 接口平台 | `dsh-qq/interface-platform`，3120 | 未运行 | 若被上面拉起，会连接并代理收发 | 会 | 同上 |
| 本仓库新 ICL（desktop junction 或 lab） | `~/.dsh/plugins/dsh-icl` → 本仓库；`packages/plugins/qq` | qq 插件默认 `enabled:false`，**没启用** | 只有显式配置 `enabled:true` 才会连（我们自己的只读影子） | 不会（本轮零出站） | 时间窗内只开**一个**只读实例 |
| `~/.dsh/plugins/icl-live`（旧 ICL） | 旧插件 | 在（目录） | 不会：ICL 前身无 QQ 代码 | 不会 | 不用动 |
| SnowLuma 自身 | 用户手动启动 | 未运行 | — | 不会自己发 | 时间窗内由**用户**启动（我们不程序化启动，EULA §5.4） |
| 计划任务 / 其它自启 | `Get-ScheduledTask` 无匹配；启动文件夹只有 `dsh-icl.lnk`、`SakuraLauncher` | — | 只有 12232 会被拉起 | — | 见上 |

> **lead 要的结论（pid 12232 会不会自动连）**：会。它的 QQ 装配在模块顶层，不依赖任何命令/会话；
> credential 发现路径正好指向本机 SnowLuma 配置。它还会在多处主动发消息（`main.js:145` 的 owner 通知、`routes/qq.js`
> 的发送端点）。所以"启动 SnowLuma" = "把旧人格请回来"，这是 §10 第 2 步必须先处理它的原因。

这张表现在有可执行版本：`node packages/plugins/qq/tools/preflight.mjs`（或 `lab-shadow.mjs --preflight`）
一条命令枚举进程/端口/3001 已建立连接/desktop profile/启动项/端点发现/历史 send 痕迹，输出
`CLEAR | WARN | BLOCK` 与逐项处置建议，报告落在 `.state/qq-shadow/preflight/preflight-latest.{md,json}`。
当前真机结论：**BLOCK**（唯一阻断项 = pid 12232 旧应用；warn = 启动文件夹 `dsh-icl.lnk`）。

## 3. 连接器形态：进程内插件，不是外部进程

### 3.1 两种形态对比

| 维度 | 外部进程（dsh-qq 接口平台 / 3120） | 进程内插件（本方案） |
|---|---|---|
| 谁持有连接 | 独立进程，DSH 侧再经 HTTP/MCP 转发 | ICL 插件自己持有一条 OneBot WS |
| 投递出口 | 又一套 HTTP API + 映射层 | 直接 `ctx.signals.offer`，复用唯一出口 |
| 去重 | 靠平台层 | `signal.id` + signals 24h + 可选持久 dedupe 表 |
| 失败语义 | 两个进程之间还要区分"发出去没有" | 在本进程内，`offer` 返回 blocked/deduped/error 直接可见 |
| 新增端口 | 要（3120/控制台） | 不要（出站 WS 客户端） |
| 启停/Rollback | 进程管理 | 插件 `enable/disable` 逆序注销，宿主统一回收 |
| 风险 | 多一个长期进程、多一套权限 | 连接跑在 DSH 进程内，坏代码可能影响会话（所以默认关闭、无发送、群不接） |

**选插件**：本轮只需要"入站 + 交给 signals"，插件形态最短；出站等用户批准后再决定是否仍留在插件内
（`outbound.mjs` 已把这条路径隔离出去）。

### 3.2 模块与职责

```text
packages/plugins/qq/
  manifest.json           id=qq, tools=["qq_status"]（只读，无发送工具）
  src/normalize.mjs       纯函数：OneBot 事件 → 私聊消息 → signal 形状
  src/gate.mjs            本地准入：私聊/白名单/自发/过期/去重/限流（含持久去重表）
  src/connector.mjs       只读 OneBot WS：发现端点、握手超时、心跳、退避；**无 ws.send**
  src/outbound.mjs        出站最小实现：三把钥匙全开才可能工作；index.mjs 不 import
  src/index.mjs           插件装配：gate → signals.offer；重试队列；qq_status；影子记录/状态文件
  tools/fake-onebot.mjs   假 SnowLuma（RFC6455 服务端，只推事件），给测试与 lab 用
  tools/preflight.mjs     shadow 前一条命令取证：谁可能抢连接 / 端口 / 已有连接 / desktop 配置
  tools/qq-shadow-host.mjs 进程内演练（真实 focus+time 插件 + 假上游，含睡眠锁）
  tools/lab-shadow.mjs    真实 lab（DSH web 实例，57108）验证；--real 模式留给用户时间窗；--preflight 委派
```

### 3.3 契约（QQ 与 ICL 的唯一接口）

```js
// 入站：OneBot 事件 → signal（只此一条）
{
  id: 'qq:private:3429502459:<message_id>',   // 幂等键
  from: { plugin: 'qq', activity: 'qq:private:3429502459' },
  kind: 'notice',
  to: 'model',
  text: '主人：在吗',
  focus: 'qq:private:3429502459',             // 注意力空间 = 会话
  tags: ['qq', 'private', 'mention'],         // mention → focus 按 pierce 处理
  createdAt: <消息自己的时间>,
  expiresAt: <receivedAt + signalTtlMs>,
  meta: { qq: { scope:'private', peerId, senderId, senderName, messageId,
                at, receivedAt, selfId, segments } }
}
```

**不做**：不 direct `delivery.push`、不 `setGate`、不 import time/focus 插件、不读写 SnowLuma 文件、
不启动/停止 SnowLuma、不下载媒体、不发群、不发任何 OneBot 动作。

## 4. 消息模型

| 维度 | 本轮取值 | 说明 |
|---|---|---|
| 来源 | `from.plugin='qq'` | bridge 会变成 `source.kind='plugin:qq'`，summary 前缀"外部消息" |
| 会话 | `qq:private:<peer>`；`focus` 字段同值 | 与 focus 命名空间一致；群 id 保留 `activityIdForGroup` 但本轮不用 |
| 去重 | 本地按 `signal.id`（`message_id`）；可选 `dedupeFile` 持久化 | signals 层同一 id 24h 幂等；delivery 的 `exactlyOnce=false`（signals 投递的 `seq:null`），所以**不要指望第三层** |
| 幂等 | 同一 `message_id` → 同一 id；没有 `message_id` 时用 `t:<消息时间>:<文本哈希>` 兜底 | 重启 + `dedupeFile` 后仍不重投（单测覆盖） |
| 时间 | `createdAt = ev.time*1000`（消息自己的时间）；`meta.qq.receivedAt` 是我们收到的时间 | 超过 `maxStaleMs`（默认 10 分钟）默认丢弃；`deliverBackfill:true` 才放行补课 |
| 优先级 | 私聊 = **pierce**（`tags:['qq','private','mention']`）；群 = 不接；本轮不产生 ambient | @ 的穿透要等接群（§6） |
| 是否需要回复 | **没有** reply-required 字段；影子不能回（没有发送工具） | 下一阶段再加"回过没"水位；当前不要让模型以为已回 |
| 富媒体 | 只留占位 `[图片]/[语音]/[视频]/[文件]/[表情]` + 来源引用 | 不下载、不展开合并转发 |
| 文本 | `maxTextChars` 默认 2000；`${senderName}：${text}` | bridge summary 会再截 100 字 |
| 通知类 | heartbeat/lifecycle 只计入 `meta` 计数，不生成 signal | `notice/request/poke` 本轮全部不接（未来另行设计） |

一条消息的完整路径：

```text
SnowLuma WS(3001) ─► connector.onEvent ─► gate.admit
                                             ├─ 拒绝（群/白名单/自发/过旧/重复/限流）→ 计数 + 影子记录
                                             └─ 接受 → ctx.signals.offer(signal)
                                                           ▼
                              time gate（sleeping/paused 拦截并抄进自己的积压）
                                                           ▼
                              host.setDeliver → focus.admit（pierce/sacred）
                                                           ▼
                              delivery.push(batchKey=`signal:qq:<focus>`)
                                                           ▼
                              bridge tick → agent.steer(plugin:qq notice)
                                                           ▼
                              DSH session/event: user/message(source.kind=plugin:qq)
```

## 5. focus 张力

### 5.1 拦截发生在哪四层（顺序固定）

| 层 | 位置 | 拦下后消息在哪 | QQ 侧动作 |
|---|---|---|---|
| 1. 本地准入闸门 | `packages/plugins/qq/src/gate.mjs` | **丢弃**（群/白名单/过旧/重复/限流） | 计数；影子记录 `dropped`（群不记录文本） |
| 2. time 静音锁 | `packages/plugins/time` 的 `signals.setGate` | time 自己的**持久积压**（`time.json` 的 queue），醒来一次性重放 | 计 `blockedReasons[reason]`，**不重试**（重试会双投） |
| 3. focus 穿透裁决 | `host.setDeliver → focus.admit` | `focus.defer` 的**按命名空间积压**，focus 释放/切换时由 host 合成一条 `plugin:focus` 摘要投递 | **插件不可感知**：`host.setDeliver` 接住了这条 signal 并返回 `queued`，`signals.offer` 仍回 `accepted`；QQ 的 `blocked` 计数**只反映 time gate**。要看 focus 拦截请查 `focus_backlog`/`focus.json` |
| 4. 投递瞬时失败 | delivery `nack`（会话切换/下游抛错） | 有界重试队列（200 条 / 5 次 / TTL） | 重试；耗尽计 `retryDropped` |

### 5.2 focus 语义对照

| 情形 | 私聊会怎样 | 依据 |
|---|---|---|
| 她空闲（无 focus） | 直接投递，起一轮 | `focus.admit` 无 current → `deliver:true` |
| 普通 focus（`interruptible:true`，`pierce:{}`） | **穿透**：`resolvePierce` 默认级别 `mention`，而私聊 tags 带 `mention` | `contracts.mjs:77-79` |
| 她的 focus 显式 `pierce:{ 'qq:*':'never' }` | 进 focus 积压，离开时摘要 | `admit` → `defer` |
| `interruptible:false`（sacred；例如 time 的睡眠租约） | 进 focus 积压，离开时摘要 | `admit` 的 `focus-sacred` |
| time 正在睡/暂停 | **在到达 focus 之前**就被 time gate 拦下，进 time 的持久积压；醒来重放 | §6 |
| time 睡眠的 schedule 配了 `allow` 命中 | 例外：允许穿透睡眠（用户显式配置） | time `allowMatch` |

### 5.3 积压、摘要与"紧急穿透"

| 机制 | 谁拥有 | 形态 | 已知代价 |
|---|---|---|---|
| time 积压 | time 插件 | 持久（`time.json`）；醒来一条 `plugin:time` notice，正文按 `· [qq/qq:private:<qq>] 主人：…` 拼接（time 已保留 `from.plugin` + `from.activity`） | **重放不保留 signal id**：能归因到 QQ/哪个会话，但无法与 QQ 本地去重表对账；一次重放后不可再重放 |
| focus 积压 | core | 内存 + `focus.json`；按 `focus` 命名空间 `count/lastText/items(≤20)`；focus 释放时一条摘要 | `items` 只存最近 20 条、截 200 字；QQ 插件看不到这一层 |
| QQ 重试队列 | qq 插件 | 内存，200 条上限，`deliver` 失败专用 | 进程重启即丢（影子阶段可接受，因为账本在 SnowLuma/后续补课另议） |

紧急穿透的既有规则（core 层）：`from==='time'`、`tags` 含 `admin`/`alarm` 的信号 privileged → 一定穿透 focus。
**私聊不是 privileged**，但因为有 `mention` tag，能穿普通 focus、不能穿 sacred/sleep。
如果用户明确希望"私聊在半梦半醒也能把我叫起来"，正确做法是给睡眠 schedule 配 `allow`（例如 `[{ from: 'qq' }]`），
**不要**去改 focus/time 的全局特权列表。

## 6. 与 time 静音锁的接口（给 time owner 的对接点）

**接口面只有 `signals` 的 `from/kind/tags` 三个字段。** QQ 不读 time 的 phase、不调用 time API、不抢 gate。

### 6.1 两级语义如何映射

| 级别 | 本轮由谁产生 | signal 形状 | time 醒着 | time 睡着/暂停 |
|---|---|---|---|---|
| **pierce**（该叫醒） | 私聊 | `kind:'notice'`, `from.plugin:'qq'`, `tags:['qq','private','mention']` | 放行 → focus 再裁决 | 默认**拦**（进 time 积压）；若 schedule `allow` 命中则穿 |
| **ambient**（可攒着） | 本轮不产生（群整类忽略） | 未来接群时：`tags:['qq','group']`；@ 时加 `'at','mention'` | 放行 | 默认拦；`allow` 可配 |
| 闹钟/特权 | time 自己 | `from.plugin:'time'`、`tags` 含 `alarm`/`admin` | 放行 | 放行（time 自己始终 accept） |

### 6.2 具体问答（lead 点名）

- **@ 是否穿透？** 本轮**不适用**：群消息整类忽略，@ 不会被收到。未来接群时，@ 消息打 `tags:['qq','group','at','mention']`；
  time 睡着时仍需 schedule 的 `allow` 命中才穿（默认 `allow=[{from:'admin'}]`）；普通群消息保持 ambient。
- **私聊是否穿透？** 醒着：穿透普通 focus；睡着/暂停：**不穿透**（time 拦下、进它自己的积压，醒来重放）；
  `interruptible:false` 的 sacred focus：不穿透（进 focus 积压）。这就是本轮实测的行为（见 §13 演练第 6–9 项）。
- **QQ 怎么知道被拦了？** `signals.offer` 返回 `{blocked:true, reason}`；QQ 只计数（`blockedReasons`），**不重试**，
  把重放权留给 time。`qq_status` 会显示"被静音/睡眠锁拦下 N（已交给 time 的积压，不重试）"。
- **两侧如何对账？** time `time_status` 看 `phase/backlog`；QQ `qq_status` 看 `blockedReasons` + 最近一条私聊/最近一次被拦
  + 影子记录 `blocked` 行；time 醒来后投递的正文里有 `[qq/qq:private:<qq>]` 前缀，能和 QQ 侧计数对上。

### 6.3 给 time owner 的三条建议（不改你实现，只是接口建议）

> 已按 lead 决策把本节结论直接发给 time；合并 master 后已看到 time 先做了第 2 条的一半（保留 `from.plugin`/`from.activity`，正文前缀变成 `[qq/qq:private:<qq>]`）。下面保留完整口径。

1. `time.json` 的积压条目现在存 `{from:{plugin,activity}, kind, text, tags, focus, reason, at, expiresAt}`；**建议再存 `signalId`**
   （QQ 的 signal id 是稳定的 `qq:private:<qq>:<message_id>`），否则重放后的消息能归因、但仍不能去重。
2. `flushQueue` 的正文前缀保留 `[plugin/activity]`（已实现）；一次性重放所有来源合并成一条 `plugin:time` notice 是有意的，QQ 不反对。
3. 若产品上要"私聊能穿睡眠"，用 schedule 的 `allow` 规则表达（`allow: [{ from: 'qq' }]` 或 `[{ tags: ['mention'] }]`），
   并在 `time_status` 里能查到当前 active schedule 的 `allow`（现在 schedule 字段里有，够了）。

## 7. 私聊收发路径

### 7.1 入站（已实现、已验证）

```text
SnowLuma OneBot WS 127.0.0.1:3001
  └─ qq 插件（默认关闭；显式配置 enabled:true 才连）
       ├─ 端点：url+token 或 snowlumaHomeDir 只读发现（token 只在内存，不落日志/状态文件）
       ├─ 零出站帧；心跳过期只标记 stale，不重连风暴（指数退避 1s→30s + 抖动）
       └─ gate → signals.offer → time gate → focus.admit → delivery → bridge.steer → 会话
```

### 7.2 出站（代码已隔离，默认 disabled，需 lead 明确批准）

- `src/outbound.mjs`：只有 `sendPrivate(peerId, text)`；三把钥匙 **同时**满足才可能工作：
  `enabled === true && allowSend === true && sendApproval === 'lead-approved'`（字面量，防止误填 true）。
  即便三把都开，还要求目标在 `allowPrivate` 白名单里。**群发送代码不存在。**
- `index.mjs` **不 import** `outbound.mjs`，也没有任何发送工具；单测验证默认拒绝。
- 为什么不现在就写完整发送：出站会改变"她能不能真的回话"这个产品事实，必须和用户确认话术、限速、
  "回过没"水位、敏感信息拦截一起设计；先写一个双钥匙的空壳，是为了固定接缝、避免以后把连接和发送再次搅在一起。

真实 shadow 的"只收"边界（用户批准后才做）：
不启动 SnowLuma、不连接 3000/3120、不调 OneBot 动作（因此没有 `get_login_info`）、不写 SnowLuma 文件，
收到私聊只落 `.state/lab/<run>/qq-shadow/inbound.jsonl` 并进 signals。

## 8. 权限与开关

插件全部配置（`host.registerPlugin(... config)` / preset 的 `pluginConfig.qq`）：

| 字段 | 默认 | 作用 | 打开/变化的后果 |
|---|---|---|---|
| `enabled` | `false` | 总开关 | 不 true 就**完全不建连接** |
| `url` / `token` | `''` | 显式上游 | token 只进内存；日志/状态文件里 url 已去掉 query |
| `snowlumaHomeDir` | `''` | 只读发现 `config/onebot_<uin>.json` | 优先于显式 url；发现失败退回 url 并 warn |
| `accountUin` | `null` | 发现时选账号 | 多账号仓库里避免连错 |
| `selfId` | `null` | 过滤自发 | 事件里的 `self_id` 也会被记录 |
| `allowPrivate` | `[]` | 私聊白名单 | **空 = 一条都不收**（默认安全） |
| `allowAllPrivate` | `false` | 显式收所有私聊 | 仅测试/受控环境 |
| `maxPerMinute` | `30` | 每 peer 每分钟上限 | 超出丢弃并计数（不排队） |
| `maxStaleMs` | `600000` | 消息时间超过多久算旧 | 0/负数 = 不判旧 |
| `deliverBackfill` | `false` | 允许补课旧消息进模型 | 打开后旧消息会以"当时时间"进入 |
| `maxTextChars` | `2000` | 单条文本上限 | 超出加 `…` |
| `dedupeFile` | `''` | 去重表落盘 | 重启后仍不重投；建议影子时打开 |
| `retryMax` / `retryMaxAttempts` / `retryTickMs` / `signalTtlMs` | `200` / `5` / `2000` / `1800000` | deliver 失败重试 | 与 time/focus 积压相互独立 |
| `recordFile` | `''` | 影子 JSONL（accepted/blocked/dropped/retry-dropped） | 影子时间窗的证据；群不落文本 |
| `statusFile` / `statusIntervalMs` | `''` / `5000` | 原子写状态（连接/计数/零出站） | runbook 用；1000ms 便于观察 |
| `promptLine` | `false` | 往系统提示词加一行"QQ 只读影子" | 默认不加，避免噪声 |
| `reconnectMinMs` / `reconnectMaxMs` / `heartbeatStaleMs` | `1000` / `30000` / `95000` | 连接策略 | — |
| `allowSend` / `sendApproval` | `false` / `''` | 出站双钥匙 | 本轮**没接工具**，改配置也没路径能发 |
| `webSocketImpl` | `null` | 测试注入 | 生产不填 |

在 lab 里打开的写法（`tools/lab.mjs` 物化的 patch，或直接 `dsh --patch`）：

```yaml
plugins:
  - memory
  # ...
  - bili
  - qq                      # 只加这一行
pluginConfig:
  qq:
    enabled: true
    snowlumaHomeDir: 'C:/Users/ai_admin/Downloads/SnowLuma-v2.1.1-win-x64-lite'
    accountUin: '2593621742'
    selfId: '2593621742'
    allowPrivate: ['3429502459']
    recordFile: '<runDir>/qq-shadow/inbound.jsonl'
    statusFile: '<runDir>/qq-shadow/status.json'
    dedupeFile: '<runDir>/qq-shadow/dedupe.json'
```

不想改任何 preset 文件时，直接用 `packages/plugins/qq/tools/lab-shadow.mjs`——它会把上面这段注入到物化后的 patch。

安全默认值组合：`enabled:false` + `allowPrivate:[]` + `allowAllPrivate:false` + `allowSend:false`。四项都不用手动关。

## 9. 与 MC 的并发测试点

QQ 与 mc-link 是同一 host 里的两个插件，共享：`signals` 唯一 gate 链、`delivery` 队列、`bridge` 的 steer。
各自的 batchKey 不同（QQ：`signal:qq:qq:private:<peer>`；MC：`signal:mc:<focus>` / mc-link 自己的 key），不会互相合批。

| 测试点 | 怎么做 | 期望 | 状态 |
|---|---|---|---|
| T1 双源同时到达 | 假 OneBot 私聊 + 假 body 触发 task 完成，一次 `delivery.drain('session')` | 两个 batch，来源可区分，不丢不重 | ✅ `qq-mc-concurrent.test.mjs` |
| T2 focus 拦截一致性 | 设 `focus.enter({interruptible:false})` 后各来一条 | 两者都不投递；core `focus.backlog` 里出现两个命名空间（QQ 插件看不到这一层，属正常） | ✅ 同上 |
| T3 time 睡眠一致性 | `time.sleep()` 后双源各来一条，再 `time.wake()` | 都在 time 积压；醒来一条 `plugin:time` notice 同时重放，正文带 `[qq/…]`/`[mc/…]` | ✅ 同上 |
| T4 双限流独立 | QQ `maxPerMinute=2`、MC 自己的限流；各自超发 | QQ drop 不消耗 MC 配额，反之亦然 | ⏳ 待补 |
| T5 重启/会话切换 | 换会话（`delivery.clear()` + 新 claim）时 QQ 继续来消息 | QQ 重试队列把 deliver 失败的那条补投；`dedupeFile` 不重复 | ⏳ 待补 |
| T6 顺序/归属 | 两条 QQ 连发 + 一条 MC 事件交错 | 同一 batch 不混来源；`entries[].source.plugin` 正确 | T1 已覆盖"不混来源"；交错顺序待补 |

资源与端口：QQ 是**出站 WS 客户端，不占监听端口**；假 OneBot 用随机端口；lab 用 57108（TEAM-PLAN §3）；
mc-body 用 549xx；模型：lab 默认 `deepseek-flash`（远程，可与 MC 的本地模型实验并行）；
真要用本地模型，走 lead 的 `.state/locks/llama.lock`，QQ 本身不碰模型。

**未做**：T4–T6；真实 mc-body + 真实 QQ 同时跑。等私聊回到位、且用户批准群之前再做（群是最后一步）。

## 10. Shadow runbook（可执行清单）

> 目标：在**用户知情**的一个短时间窗里，只收一条真实私聊，证明"能进 signals/delivery、零出站、群没被接进来"。
> 前提：SnowLuma 与旧消费者默认不在跑；我们**不**启动 SnowLuma（EULA §5.4 + 会叫醒旧消费者）。

### 第 0 步：开工前取证（一条命令，只读）

```powershell
cd C:\DSH\icl-wt\qq
node packages/plugins/qq/tools/preflight.mjs          # 结论 CLEAR / WARN / BLOCK + 逐项处置
# 等价写法：node packages/plugins/qq/tools/lab-shadow.mjs --preflight
```

它枚举/核对：进程（旧应用/dsh-qq 桥/接口平台/SnowLuma/已有 shadow）、端口 3000/3001/3120/3100/3099/5099、
3001 上已建立的连接、desktop profile 里是否还有启用的 snowluma 行、启动文件夹/计划任务、
SnowLuma 端点只读发现、最近日志尾部的 send 痕迹、已有 shadow 的状态文件（只认进程还活着的）。
报告：`.state/qq-shadow/preflight/preflight-latest.md` / `.json`（每次另存带时间戳的一份）。

**当前真机结论（2026-11-05）：BLOCK** —— 唯一阻断项是 pid 12232（focus-core 旧应用，会连会发）；
warn 项是启动文件夹里的 `dsh-icl.lnk`。其余全 ok。需要人工兜底时再看：

```powershell
Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in 3000,3001,3120,3100,3099,5099 }
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'apps\\dsh-icl\\src\\main.js|dsh-qq|SnowLuma' } |
  Select-Object ProcessId, CreationDate, CommandLine
Get-ChildItem 'C:\Users\ai_admin\Downloads\SnowLuma-v2.1.1-win-x64-lite\logs' |
  Sort-Object LastWriteTime -Descending | Select-Object -First 3 Name, LastWriteTime
```

### 第 1 步：零风险假演练（必须先过）

```powershell
cd C:\DSH\icl-wt\qq
node packages/plugins/qq/tools/qq-shadow-host.mjs        # 进程内：focus+time+qq + 假 OneBot
node packages/plugins/qq/tools/lab-shadow.mjs --port 57108 --run qq-drill   # 真实 lab + 假 OneBot
```

期望：两条都 exit 0；报告分别落 `.state/qq-shadow/` 与 `.state/lab/qq-drill/report.md`；
其中包含"睡眠锁拦下私聊 → time 醒来重放""零出站帧""群被忽略"。

### 第 2 步：处理会抢连接的旧消费者（需用户/lead 知情）

> 这一步是用户进程（focus-core 旧应用），**不要静默 kill**。请用户确认后执行：

```powershell
# 确认真的是它
Get-CimInstance Win32_Process -Filter "ProcessId=12232" | Select-Object ProcessId, CommandLine
# 用户同意后停掉
Stop-Process -Id 12232
# 确认 3201 不再监听、也没有别的 node 在跑 apps\dsh-icl\src\main.js
Get-NetTCPConnection -LocalPort 3201 -State Listen -ErrorAction SilentlyContinue
```

注意：启动文件夹里的 `dsh-icl.lnk` 会在下次登录时把它拉起来；时间窗内别注销/重启。
**不批准停它也可以继续**，但必须接受：SnowLuma 一起来它就会连上，可能用旧人格回复，且可能给 owner 发私聊
（`main.js:145`）。这种情况下**不要**把这次窗口当"干净影子"。

### 第 3 步：请用户手动启动 SnowLuma（我们不代劳）

```powershell
# 用户启动后确认监听（应看到 3000/3001/5099）
Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in 3000,3001,5099 }
# 看账号是否上线（日志尾部）
$log = Get-ChildItem 'C:\Users\ai_admin\Downloads\SnowLuma-v2.1.1-win-x64-lite\logs' |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
Get-Content $log.FullName -Tail 40 | Select-String 'OneBot|ws-default|online|login'
```

### 第 4 步：起只读影子（我们这边唯一的连接）

```powershell
cd C:\DSH\icl-wt\qq
node packages/plugins/qq/tools/lab-shadow.mjs --real --approval lead-approved `
  --port 57108 --run qq-shadow-<日期> --wait-ms 900000 --peer 3429502459
```

它做的事：物化 lab patch（只给 `icl-lab` 加 `qq` 插件、`enabled:true`、`snowlumaHomeDir` 只读发现、
`allowPrivate:['3429502459']`）→ 起独立 DSH web 实例（57108）→ **显式 `selectModel(deepseek-account/deepseek-flash)`**
（不继承 profile 的 `agent-default-model`；本地模型实验必须走 lead 的 llama 锁）→ 等 **owner 发一条私聊** → 抓
`user/message(source.kind=plugin:qq)` → 写报告 → 自动停 lab。

### 第 5 步：前 5 分钟看什么

| 检查 | 命令 / 位置 | 期望 |
|---|---|---|
| 我们在听、且零出站 | `<runDir>/qq-shadow/status.json` | `connection.connected:true`、`readOnlyInvariant.framesSent:0`、`sendEnabled:false` |
| 只有我们一条连接 | `Get-NetTCPConnection -RemotePort 3001 -State Established \| Select-Object OwningProcess` | 只有 lab 的 dsh pid；**出现第二个 pid 立即停** |
| 旧消费者没被叫醒 | 上面结果 + `Get-Process -Id 12232 -ErrorAction SilentlyContinue` | 12232 不存在/没有到 3001 的连接 |
| 没有任何发送 | SnowLuma 当天日志尾部搜 `send_private_msg`/`send_group_msg`；看用户 QQ 有没有新消息 | 无 |
| 群没被接 | `status.json` 的 `gate.byCode.group` 在涨（只计数）、`inbound.jsonl` 无群文本 | 只有计数，无内容 |
| 私聊进来了 | `status.json` 的 `stats.delivered` / `gate.byCode`；`inbound.jsonl` 的 `kind:"accepted"` | 1 条（owner 那条） |
| 最近一条/有没有被拦 | `qq_status` 工具文案（或 `host.shared.get('qq').status().stats.recent`）：`最近一条私聊：HH:MM:SS 名称（QQ） #id：…`、`最近被 time 锁拦下…`、`最近被本地闸门丢弃…` | 与记录文件一致；被拦时能看到 reason |
| 进了会话 | `<runDir>/events.jsonl` 搜 `plugin:qq`；`transcript.md` 的"插件消息 来源=插件(qq)" | 有 user/message，summary 以"外部消息"开头 |
| 她能不能回 | 事实：没有发送工具；`outbound.mjs` 未被 index.mjs import | 她只能看到，不能回 |

### 第 6 步：停止与留证

```powershell
node tools/lab.mjs down --run <runId>       # 停 lab（脚本正常结束会自动做）
# SnowLuma 由用户手动关；旧消费者是否重启由用户决定
# 证据保留：.state/lab/<runId>/（report.md / events.jsonl / transcript.md / qq-shadow/）
```

### 失败即停阈值（任一命中立即 `down` + 关 SnowLuma + 通知 lead）

1. `status.json` 的 `readOnlyInvariant.framesSent > 0`（代码不变量被破坏）；
2. `inbound.jsonl` 出现 `group`/`not-allowlisted`/群文本；
3. SnowLuma 日志出现任何 `send_*` 动作，或用户 QQ 收到机器人新消息；
4. 3001 上出现**第二个** Established 连接（旧消费者被叫醒）；
5. 旧应用/旧桥接日志出现回复、或 `pid 12232` 复活并连上；
6. `recordErrors > 0` 或 `connection.state` 反复 disconnected / `stale:true`；
7. 任意非白名单私聊进入 `accepted`。

回滚：停我们的进程 → 停 SnowLuma → 恢复旧消费者（用户决定）→ 保留 runDir 与 SnowLuma 当天日志。

## 11. 落地顺序建议

| 阶段 | 内容 | 前置/权限 | 完成判据 |
|---|---|---|---|
| **0. 只读 shadow（本轮）** | 私聊 → signals → 会话；群整类忽略；零出站；影子记录/状态文件 | 只需 lead 批准 lab；真实 SnowLuma 需用户时间窗（§10） | 本文 §0/§13 全部证据；真实 shadow 至少 1 个 15 分钟窗口无 §10 失败项 |
| **1. 私聊回（出站）** | 只回 owner 私聊、纯文本、限速、人工 kill switch、回过没水位 | **lead 明确批准 + 用户单独批准**（两把钥匙之外再加一次口头/工单确认） | 出站单测（白名单/限速/敏感信息/失败可见）+ 一次受控对话；群仍然 0 发送 |
| **2. 群（永远最后）** | 先只读群 + @ 检测（只入 signals、不回），再评估回复 | **用户单独批准且只针对白名单群**；默认 `enabled:false`、默认只读 | 群只读 shadow 先跑；每次群发都必须另有一把钥匙；限流 + 静默 + 人工值守 |
| 附：多平台 | 微信/B站等 | — | 复用同一 signal 形状；**不要**在接第二个平台前做"插件框架"（focus-core TRANSPORT-ARCH 的教训） |

每条都是独立开关：阶段 0 的代码不会因为阶段 1/2 的配置变化而自动获得发送能力。

## 12. 已知限制 / 没做

1. **WS 不补课**：OneBot 正向 WS 不重放断线期间的事件；私聊没有可靠的 `get_friend_msg_history`（SnowLuma 未验证）。影子期间丢线 = 丢那几条，`recordFile` 里没有就是没有。将来要做补课，先验证动作是否存在，再按 `message_seq` 游标做（群路径已有先例）。
2. **`message_id` 的稳定性**：SnowLuma 实测是数字且稳定；换后端要重新验证。没有 id 时用时间+文本哈希兜底（可能误合并同秒同文）。
3. **去重窗口**：本地 24h；超过窗口后同 id 会再投（现实不会发生，但写在这里）。
4. **媒体不落地**：图片/语音/文件只有占位与引用；要看图需要另设计受控下载（不要让模型自己 fetch 任意 URL）。
5. **群/@/poke/notice/request 未接**：本轮的"@ 穿透"只存在于设计里（§6.2）。
6. **time 重放丢 id**：见 §6.3 建议；当前靠"QQ 不重试 blocked"避免双投。
7. **影子会起一轮**：lab 实测私聊在空闲时会 `turn/start`（她看到了、会思考怎么回，但没有回复工具）。`promptLine` 默认关闭，下一轮建议打开一句"QQ 只读影子不能回复"，避免她误以为自己已经回了。
8. **并发只验证到 T1–T3（fake）**：T4–T6（双限流独立、会话切换/重试、交错顺序）还没做；真实 mc-body + 真实 QQ 未同跑。
9. **旧消费者风险**：见 §2.3 / §10 第 2 步；不处理就没有干净影子。

## 13. 测试与证据

### 13.1 自动化测试

```powershell
node --test packages/core/test packages/mc-body/test   # 340 pass / 0 fail
node --test packages/core/test/qq.test.mjs             # 18 pass
node --test packages/core/test/qq-mc-concurrent.test.mjs  # 3 pass（T1–T3）
node --test packages/core/test/qq-preflight.test.mjs   # 8 pass（判定 + 陈旧 shadow 文件不误报）
```

`packages/core/test/qq.test.mjs` 覆盖：

| # | 用例 | 证据点 |
|---|---|---|
| 1-2 | 私聊规范化 / 富媒体占位 | `qq:private:<id>`、tags、`createdAt=消息时间` |
| 3 | 群/临时会话/自发拒绝 | `group` / `unsupported-message-type` / `self` |
| 4 | 白名单为空 = 不收 | 默认安全 |
| 5 | 同消息第二次 duplicate、id 稳定 | 幂等 |
| 6 | 过旧消息默认丢 / `deliverBackfill` 才放 | 时间语义 |
| 7 | 每分钟限流 | 有界 |
| 8 | 去重表落盘、重启仍认 | `dedupeFile` |
| 9 | 只读发现 SnowLuma 端点 | 不猜 token |
| 10 | 出站三钥匙默认拒绝 | 默认 disabled |
| 11 | 插件默认不开、不建连接 | 安全默认 |
| 12 | 私聊进 delivery；群/陌生人/重复被挡；**客户端零帧** | host 集成 + 影子记录 |
| 13 | time 静音锁拦下 → 不重试、不双投 | §6 语义 |
| 14 | deliver 瞬时失败 → 重试队列 → 补投 | 失败可见 |
| 15 | 去重跨重启 | 重启不双投 |
| 16 | `qq_status` 文案（只读、不能发） | 工具面 |
| 17 | 状态文件（连接态 + 零出站） | runbook 观测 |
| 18 | 真 WebSocket 回环 + 假 OneBot（`clientDataChunks()===0`） | 真连接、零出站 |

另两个测试文件：

- `qq-mc-concurrent.test.mjs`（3 条）：T1 双源两个 batch/不混来源/不重；T2 sacred focus 下双源都进 core 积压且不投递；
  T3 time 睡眠下双源都进 time 积压、醒来一条 `plugin:time` notice 同时重放（正文 `[qq/qq:private:10001]`、`[mc/event]`）。
- `qq-preflight.test.mjs`（8 条）：干净=CLEAR；旧应用/dsh-qq 桥/端口占用/desktop 启用行/已有 shadow=BLOCK；
  拿不到进程列表=WARN（不报 CLEAR）；被 kill 的 lab 留下的 `connected:true` 状态文件不算"正在跑"。

### 13.2 进程内演练（含 time 睡眠锁）

`node packages/plugins/qq/tools/qq-shadow-host.mjs` → `.state/qq-shadow/fake-2026-11-05T10-14-11-098Z/report.md`：

```text
✓ 连接假 OneBot      ✓ 私聊进了 delivery      ✓ 重复被去重
✓ 群消息整类忽略      ✓ 白名单外被拒          ✓ 睡眠锁拦下私聊 {"sleeping":1}
✓ 被拦下时不进 delivery  ✓ time 侧记了积压    ✓ 醒来重放（正文含 [qq] 主人：睡着时来的）
✓ qq 客户端零出站帧   ✓ 假服务器没收到客户端字节 chunks=0   ✓ 影子记录不含群文本
```

### 13.3 真实 lab 验证（假上游，57108）

`node packages/plugins/qq/tools/lab-shadow.mjs --port 57108 --run qq-5` →
`.state/lab/qq-5/report.md`（10/10）：

```text
✓ lab 会话建立（session-…, port=57108）
✓ qq 插件完成装配并上报状态（qq-shadow/status.json）
✓ qq 上游连接已打开（state=open）
✓ 零出站帧（插件自报）framesSent=0；出站=关闭
✓ QQ 消息以 plugin:qq user/message 进入 DSH 会话（seq=8）
✓ notice 的 summary 可追溯来源（外部消息：主人：lab 里的第一条 QQ 私聊）
✓ 影子记录：accepted 只有 1 条（重复被去重）
✓ 影子记录不含群文本
✓ 客户端零出站字节 chunks=0
✓ transcript 能看到这条插件消息
```

对应 `events.jsonl` 的形状（这是"进入 signals/delivery/会话"的权威证据）：

```text
seq=3  agent/inbox/spliced  inserted[0].content=[{type:'text',text:'主人：lab 里的第一条 QQ 私聊'}]
                            source={kind:'plugin:qq', form:'notice', summary:'外部消息：主人：lab 里的第一条 QQ 私聊'}
seq=8  user/message         source.kind='plugin:qq'（同一份内容）
```

### 13.4 preflight 真机结论（2026-11-05）

`node packages/plugins/qq/tools/preflight.mjs` → `.state/qq-shadow/preflight/preflight-latest.md`：

```text
结论：BLOCK（block 1 / warn 1）
⛔ 有会抢 QQ 连接的进程在跑 — pid 12232 focus-core 旧应用（会连=true，会发=true）
✅ QQ 相关端口都空闲 — 3000/3001/3120/3100/3099/5099
✅ 3001 上没有 Established 连接 — 干净
✅ desktop profile 没有启用的 snowluma 行
✅ 没有正在运行的真实 shadow
⚠️ 启动文件夹里有 dsh-icl.lnk — 下次登录会自动拉起 focus-core 旧应用
✅ 没有相关计划任务
✅ SnowLuma 端点可只读发现 — uin=2593621742 ws://127.0.0.1:3001/（token 存在）
✅ 最近日志尾部没有 send_* 痕迹 — snowluma-2026-11-01.log @ 2026-10-31T20:07:07Z
```

### 13.5 真实 SnowLuma 影子

⏸ 未跑（lead 决策：暂不启动 SnowLuma，避免叫醒旧消费者）。runbook 见 §10；`lab-shadow.mjs --real` 已备好，
`--real` 必须带 `--approval lead-approved`（不带直接 exit 2，单测/手工验证过）。

## 14. 参考文件（只读；**不修改旧仓库**）

| 仓库 | 路径 | 用途 |
|---|---|---|
| focus-core | `apps/dsh-icl/src/{transports/contract.js,domain/qq-ws.js,domain/qq-poller.js,domain/qq-ledger.js,domain/qq-delivery.js,domain/policy.js,ws/qq-events.js,main.js}` | 传输契约、OneBot 归一、poller/ledger 教训、两级 policy、旧消费者行为 |
| focus-core | `docs/{TRANSPORT-ARCH.md,MESSAGING-SUMMARY.md}`、`DESIGN-activity-focus.md`、`docs/focus-architecture.md` | 接缝设计、压测与投递决议、focus 语义基准 |
| dsh-qq | `interface-platform/src/connectors/{onebot-v11/*,qq-snowluma/discovery.mjs}`、`config.json`、`docs/FOLDER_MAP.md`、工作区 `dsh-qq-部署笔记.md` | OneBot/SnowLuma 稳定接法、账号与白名单、EULA 约束 |
| icl 前身 | `docs/HISTORY.md` | "QQ 连接器是最大缺口""一机多会话"的教训 |
| 本仓库 | `packages/core/src/{signals,services,host,contracts}.mjs`、`packages/dsh-icl/src/bridge.mjs`、`packages/plugins/time/src/index.mjs`、`docs/{FOCUS,MESSAGES,SURVIVAL,TEAM-PLAN-2026-11-05}.md` | 既有的信号/投递/focus/time 接缝 |

## 附录：常用命令

```powershell
# preflight（shadow 前一条命令：谁可能抢连接 / 端口 / 已有连接 / 配置）
node packages/plugins/qq/tools/preflight.mjs            # 或 lab-shadow.mjs --preflight
# 假 OneBot（手动演示；随机/指定端口均可）
node packages/plugins/qq/tools/fake-onebot.mjs --port 3301 --token test-token --after 800 --group --duplicate
# 进程内演练（不碰 DSH、不碰真 QQ）
node packages/plugins/qq/tools/qq-shadow-host.mjs
# 真实 lab 验证（假上游）
node packages/plugins/qq/tools/lab-shadow.mjs --port 57108 --run qq-1
# 真实影子（仅用户批准的时间窗；前置条件见 §10）
node packages/plugins/qq/tools/lab-shadow.mjs --real --approval lead-approved --port 57108 --wait-ms 900000
# 看影子状态 / 记录
Get-Content .state/lab/<runId>/qq-shadow/status.json
Get-Content .state/lab/<runId>/qq-shadow/inbound.jsonl
# 停 lab
node tools/lab.mjs down --run <runId>
```
