# QQ 接入：连接器形态、私聊收/回与落地顺序

> 读者：接 QQ 的人、做 time 静音锁的人、跑 shadow 时间窗的人。
> 结论先说：**QQ 不进核心，只做一个入站插件**——接 OneBot WS，把私聊规范化成 ICL signal，交给现有的
> `signals → time gate → focus.admit → delivery → bridge.steer` 链路。入站默认只读：`enabled:false`、群消息整类忽略、
> 不发任何动作。**phase 1（用户 2026-11-05 批准）新增唯一出站入口 `qq_send`**：只有三把钥匙全开时注册，只回 owner 私聊、
> 纯文本（可多气泡）、每轮≤1 次发送调用、限速/去重/敏感拦截/回执三态/审计；群发送代码不存在。真实 SnowLuma 验证按 [§10](#10-shadow-runbook可执行清单)。
>
> 代码：`packages/plugins/qq/`（默认 `enabled:false`）；测试：`packages/core/test/qq*.test.mjs`（19 + 3 + 10 + 11 条）；
> 演练/取证：`packages/plugins/qq/tools/{fake-onebot,qq-shadow-host,lab-shadow,preflight}.mjs`。
> 事实核对时间：2026-11-05；基线 `7bebecd`；已合并 master（含 lab 工具 `fa890ab`、time `05c4d19`）。

## 0. 状态与不变量

| 项 | 状态 | 证据 |
|---|---|---|
| 三份参考研究 | ✅ | 本文 §1 |
| 连接器/消息模型/focus 张力设计 | ✅ | §3–§7 |
| 只读入站实现（OneBot WS → signals） | ✅ | `packages/plugins/qq/src/` |
| 单测（规范化/去重/gate/限流/不发送/静态安全） | ✅ 19 条 | `node --test packages/core/test/qq.test.mjs` |
| **phase 1 出站（qq_send，只回 owner 私聊）** | ✅ 实现 + fake 11 条；真实窗口已验证（1 条私聊、0 群） | `src/send-tool.mjs`、`packages/core/test/qq-send.test.mjs`、§0.3 |
| QQ × MC 并发接缝（T1–T3，纯 fake） | ✅ 3 条 | `packages/core/test/qq-mc-concurrent.test.mjs` |
| 与 time 静音锁接口对齐（三条建议全采纳，已合并 master） | ✅ time `05c4d19`；drill 严格断言 `signalId` | §6.3 / drill |
| shadow preflight（谁可能抢连接/phase1 就绪，一条命令出结论） | ✅ 13 条判定单测 + 真机 CLEAR/BLOCK 证据 | `packages/plugins/qq/tools/preflight.mjs` |
| 给用户的一页说明（申请时间窗直接贴） | ✅ `preflight --brief` + 静态快照 | `docs/QQ-SHADOW-USER-BRIEF.md` |
| 全量测试 | ✅ 540 pass | `npm test` |
| **P0-3 出站人类化（markdown/多气泡/节奏/切分）** | ✅ 已实现（fake 9 纯函数 + 7 集成测试） | `src/humanize.mjs`、`packages/core/test/qq-humanize.test.mjs` |
| **P0-1 账本/水位 + 断线补课** | ✅ 已实现（fake 契约 6 条）；真机 `get_friend_msg_history` 待用户在场 | `src/{ledger,backfill,onebot-http}.mjs`、`packages/core/test/qq-backfill.test.mjs` |
| **P0-2 入站富内容（纯函数层）** | ✅ 已实现（fake 11 条）；图片真正进模型待 DSH attachment（单独申请） | `src/{rich,reply-cache,forward,media}.mjs`、`packages/core/test/qq-rich.test.mjs` |
| **红队修复：私聊默认 ambient（不再自动 mention/pierce）** | ✅ 已修复；@ 才穿；admin/alarm 由其它来源显式授予 | `src/normalize.mjs`、`qq-rich.test.mjs`、本文 §3.3/§5/§6 |
| **F1/F3 QQ 策略进 sim（按需，不进静态 system）** | ✅ `qq_help` 工具 + `skills/reply.md`；qq_status/qq_send 描述承载边界 | §7.5、`src/index.mjs`、`skills/reply.md` |
| **A2/B1/B2 说话人信封（QQ 部分）** | ✅ 正文前缀 + `meta.qq.envelope`；bridge 侧剩余项见 §7.5 | `src/index.mjs`、`qq-envelope.test.mjs` |
| **完整性差距研究（旧项目 vs 我们，P0/P1/P2 路线）** | ✅ 已完成 | [QQ-GAP.md](QQ-GAP.md) |
| 进程内演练（含 time 睡眠锁 + signalId 归因） | ✅ 14/14 | `.state/qq-shadow/fake-2026-11-05T10-30-35-913Z/report.md` |
| 真实 lab 验证（假上游，端口 57108） | ✅ 10/10；模型显式 `selectModel(deepseek-account/deepseek-flash)`，不继承 profile 默认 | `.state/lab/qq-6/report.md` |
| 真实 SnowLuma 影子 | ⏸ 用户 2026-11-05 选 B 暂缓（不在电脑前）；**phase 1 真实窗口待 lead 指令**（旧消费者已停、SnowLuma 已在跑） | §0.1 / §10 / §13.5 |

### 0.1 时间线（2026-11-05）

- **phase 0 只读影子**：✅ 实现 + fake/lab 验证完成；真实 SnowLuma 影子因用户不在电脑前选 B 暂缓（当时唯一阻断 pid 12232）。
- **phase 1 私聊回**：用户回来后**批准**；lead 已把旧启动项 `dsh-icl.lnk` 移到 `.state/backup-startup/`（可回滚），旧 focus-core 应用已停/退役不再恢复，SnowLuma 目前由用户手动开着。代码 + fake 测试已完成（`qq_send`、三把钥匙、限速/去重/内容边界/三态回执/审计/kill switch）；**真实 QQ 验证等 lead 给窗口**（只发 owner 私聊、每轮≤1 次调用；P0-3 起一次调用内可拆 1–8 个气泡）。
- **保持不变**：产品默认仍 `enabled:false` 且三把钥匙全关；真实发送只在 lab/受控窗口打开；群发送代码不存在。
- 已经验证过的替代证据：假上游进程内演练 14/14、真实 lab（57108，假 OneBot）10/10、QQ×MC 并发 T1–T3、preflight 单测 13 条、phase 1 出站 fake 11 条。

三条入站不变量（任何后续改动都不能破坏）：

1. **入站只读不变量**：只读连接器从建立到销毁 `framesSent === 0`（`connector.mjs` 里没有 `ws.send`；单测断言 `FakeWebSocket.sent.length === 0`、回环测试断言假服务器 `clientDataChunks() === 0`）。phase 1 的发送走**另一条** outbound 连接，单独计数，不污染入站连接。
2. **群整类忽略**：`message_type === 'group'` 在入站准入闸门第一层就被拒绝并计数，**不解析、不记录文本**。
3. **默认关闭**：`enabled:false` 时完全不建连接；私聊白名单为空时一条都不收。

phase 1 出站不变量（新增，见 §11.1）：

4. **唯一入口 + 三把钥匙**：只有 `enabled && allowSend && sendApproval==='lead-approved'` 时动态装配并注册 `qq_send`；`index.mjs` 不 import 发送实现；只回 owner/白名单私聊；**群发送动作不存在**；unknown 结果不自动重试；审计 JSONL 只存 hash/长度、不存正文。

## 1. 三份参考读到了什么（只读，不复制代码）

### 1.1 `C:\DSH\qwenstuff\focus-core`（最新，优先）

它是"QQ 即架构"的完整教训集，能直接搬的是**形状**，不能搬的是**三份状态**。

| 文件 | 事实 | 对我们的取舍 |
|---|---|---|
| `apps/dsh-icl/src/transports/contract.js` | 最小传输契约：`name/capabilities/normalize/send`；活动 id = `transport:scope:id`（`qq:group:<id>` / `qq:private:<id>`）；不支持的能力抛 `NotImplemented` | 采纳：活动 id 与 `focus` 命名空间直接用 `qq:private:<qq>`；**不采纳**"一个对象同时管收发"——本轮收发分开 |
| `apps/dsh-icl/src/domain/qq-ws.js` | OneBot v11 正向 WS；`normalizeEvent` 把 message/notice/poke/upload 归一；echo 配对回执；重连退避 `[2s,5s,15s,30s,60s]`；`ev.time` 是秒 → `*1000` | 采纳：WS 正向连接、心跳、`time*1000`、退避；**不采纳** echo/动作（我们不发送，所以没有 pending） |
| `apps/dsh-icl/src/domain/qq-poller.js` | 群游标用 `message_seq`（`message_id` 会变负数）；私聊默认 `pierce`，群普通 `ambient`、@ 才 `pierce`；`appendMessage` 记 `sent_at`/`received_at` 两个时间 | 采纳：两级语义、消息时间与收到时间分开（我们的 `createdAt` vs `meta.qq.receivedAt`）；**不采纳**"私聊=pierce"（红队修复后私聊默认 ambient，@ 才穿）、**不采纳** HTTP 轮询——补课改用 `get_friend_msg_history`（见 §7.3） |
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
  manifest.json           id=qq, tools=["qq_status","qq_send"]（qq_send 只在三钥匙打开时注册）
  src/normalize.mjs       纯函数：OneBot 事件 → 私聊消息 → signal 形状
  src/gate.mjs            本地准入：私聊/白名单/自发/过期/去重/限流（含持久去重表）
  src/connector.mjs       只读 OneBot WS：发现端点、握手超时、心跳、退避；**无 ws.send**
  src/outbound.mjs        出站实现（被 send-tool 使用）：send_private_msg + echo 配对 + 三态回执；**index 不 import**
  src/send-tool.mjs       phase 1 唯一入口：注册 qq_send；目标/内容/限速/去重/每轮上限/审计/kill switch
  src/index.mjs           插件装配：gate → signals.offer；三钥匙打开时动态 import send-tool；qq_status；记录/状态文件
  tools/fake-onebot.mjs   假 SnowLuma（RFC6455 服务端）：推事件 + 读动作帧回 echo（ok/reject/drop 三种模式）
  tools/preflight.mjs     shadow 前一条命令取证：谁可能抢连接 / 端口 / 已有连接 / desktop 配置
  tools/qq-shadow-host.mjs 进程内演练（真实 focus+time 插件 + 假上游，含睡眠锁）
  tools/lab-shadow.mjs    真实 lab（DSH web 实例，57108）：--real 影子 / --send phase 1；--preflight 委派
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
  tags: ['qq', 'private'],                    // 默认 ambient：不自动 mention/at
  createdAt: <消息自己的时间>,
  expiresAt: <receivedAt + signalTtlMs>,
  meta: { qq: { scope:'private', peerId, senderId, senderName, messageId,
                at, receivedAt, selfId, segments,
                media, files, forwardIds, replyId, atSelf } }
}
```

**焦点语义（2026-11-06 红队修复）**：私聊默认是 **ambient**（`tags:['qq','private']`），
普通 focus 会把它拦进积压；只有**显式 @ 到自己**才加 `at` tag（按默认 `pierce:mention` 穿透）。
`admin`/`alarm`/`safety` 是**其它来源的显式特权标签**（管理通道/紧急事件），QQ 不会自己授予；
需要"私聊也叫醒"时用 time schedule 的 `allow` 表达，不要在 QQ 侧自造特权。

**不做**：不 direct `delivery.push`、不 `setGate`、不 import time/focus 插件、不读写 SnowLuma 文件、
不启动/停止 SnowLuma、不下载媒体、不发群、不发任何 OneBot 动作。

## 4. 消息模型

| 维度 | 本轮取值 | 说明 |
|---|---|---|
| 来源 | `from.plugin='qq'` | bridge 会变成 `source.kind='plugin:qq'`，summary 前缀"外部消息" |
| 会话 | `qq:private:<peer>`；`focus` 字段同值 | 与 focus 命名空间一致；群 id 保留 `activityIdForGroup` 但本轮不用 |
| 去重 | 本地按 `signal.id`（`message_id`）；可选 `dedupeFile` 持久化 | signals 层同一 id 24h 幂等；delivery 的 `exactlyOnce=false`（signals 投递的 `seq:null`），所以**不要指望第三层** |
| 幂等 | 同一 `message_id` → 同一 id；没有 `message_id` 时用 `t:<消息时间>:<文本哈希>` 兜底 | 重启 + `dedupeFile` 后仍不重投（单测覆盖） |
| 时间 | `createdAt = ev.time*1000`（消息自己的时间）；`meta.qq.receivedAt` 是我们收到的时间 | 实时超过 `maxStaleMs`（默认 10 分钟）默认丢弃；补课消息按 `maxBackfillAgeMs`（默认 6h）单独判 |
| 优先级 | 私聊 = **ambient**（`tags:['qq','private']`）；显式 @ 到自己才加 `at`（pierce）；群 = 不接 | 管理员/告警只能由其它来源显式打 `admin`/`alarm`；QQ 不自动授予（红队修复 2026-11-06） |
| 是否需要回复 | **没有** reply-required 字段；影子不能回（没有发送工具） | 下一阶段再加"回过没"水位；当前不要让模型以为已回 |
| 富媒体 | 文本用可读占位：`[图片]`、`[语音]`、`[视频]`、`[文件：name（size）]`、`[合并转发 id=…]`、`[表情]`；引用解析后 `[引用 某人：原文]` | 媒体字节不下载进模型（P0-2 只做定位 meta）；图片真正进模型等 DSH attachment 通道 |
| 文本 | `maxTextChars` 默认 2000；`${senderName}：${text}` | bridge summary 会再截 100 字 |
| 通知类 | heartbeat/lifecycle 只计入 `meta` 计数，不生成 signal | `notice/request/poke` 本轮全部不接（未来另行设计） |

一条消息的完整路径：

```text
SnowLuma WS(3001) ─► connector.onEvent ─► （P0-2）引用解析/转发展开（HTTP get_msg/get_forward_msg，慢取缓存）
                                             ─► gate.admit（富段→可读文本 + meta.qq 媒体/文件/转发/引用）
                                             ├─ 拒绝（群/白名单/自发/过旧/重复/限流）→ 计数 + 影子记录
                                             └─ 接受 → 账本 append → ctx.signals.offer(signal)
                                                           ▼
                              time gate（sleeping/paused 拦截并抄进自己的积压）
                                                           ▼
                              host.setDeliver → focus.admit（默认 ambient；@ 才 pierce）
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
| 2. time 静音锁 | `packages/plugins/time` 的 `signals.setGate` | time 自己的**持久积压**（`time.json` 的 queue；条目带 `signalId`，同一 signal id 不重复入队；溢出优先丢最旧 ambient、保护 `mention/at/private/direct/admin`），醒来一次性重放 | 计 `blockedReasons[reason]`，**不重试**（重试会双投；time 侧也按 signalId 去重） |
| 3. focus 穿透裁决 | `host.setDeliver → focus.admit` | `focus.defer` 的**按命名空间积压**，focus 释放/切换时由 host 合成一条 `plugin:focus` 摘要投递 | **插件不可感知**：`host.setDeliver` 接住了这条 signal 并返回 `queued`，`signals.offer` 仍回 `accepted`；QQ 的 `blocked` 计数**只反映 time gate**。要看 focus 拦截请查 `focus_backlog`/`focus.json` |
| 4. 投递瞬时失败 | delivery `nack`（会话切换/下游抛错） | 有界重试队列（200 条 / 5 次 / TTL） | 重试；耗尽计 `retryDropped` |

### 5.2 focus 语义对照

| 情形 | 私聊会怎样 | 依据 |
|---|---|---|
| 她空闲（无 focus） | 直接投递，起一轮 | `focus.admit` 无 current → `deliver:true` |
| 普通 focus（`interruptible:true`，`pierce:{}`） | **被拦**（进 focus 积压）：私聊默认 ambient，不再自动带 `mention` | 红队修复 2026-11-06；`focus.admit` 默认 pierce 级别 `mention` |
| 显式 @ 到自己（`tags` 带 `at`） | **穿透**普通 focus；sacred 仍拦 | `tags:['qq','private','at']` |
| 她的 focus 显式 `pierce:{ 'qq:*':'never' }` | 进 focus 积压，离开时摘要 | `admit` → `defer` |
| `interruptible:false`（sacred；例如 time 的睡眠租约） | 进 focus 积压，离开时摘要 | `admit` 的 `focus-sacred` |
| time 正在睡/暂停 | **在到达 focus 之前**就被 time gate 拦下，进 time 的持久积压；醒来重放 | §6 |
| time 睡眠的 schedule 配了 `allow` 命中 | 例外：允许穿透睡眠（用户显式配置） | time `allowMatch` |

### 5.3 积压、摘要与"紧急穿透"

| 机制 | 谁拥有 | 形态 | 已知代价 |
|---|---|---|---|
| time 积压 | time 插件 | 持久（`time.json`）；条目 `{id, signalId, createdAt, from:{plugin,activity}, kind, text, tags, focus, reason, at, expiresAt}`（time W3 已收尾，**形状冻结**）；同一 `signal.id` 重复 offer **不重复入队**；醒来一条 `plugin:time` notice，正文 `· [qq/qq:private:<qq>] …`；溢出优先丢最旧 **ambient**，保护 `at/private/direct/admin/...`（QQ 私聊有 `private`，显式 @ 时另有 `at`）；`time_status` 暴露"丢弃：漏响/溢出/过期" | 一次重放后不可再重放；QQ 不该也不会重试 blocked |
| focus 积压 | core | 内存 + `focus.json`；按 `focus` 命名空间 `count/lastText/items(≤20)`；focus 释放时一条摘要 | `items` 只存最近 20 条、截 200 字；QQ 插件看不到这一层 |
| QQ 重试队列 | qq 插件 | 内存，200 条上限，`deliver` 失败专用 | 进程重启即丢（影子阶段可接受，因为账本在 SnowLuma/后续补课另议） |

紧急穿透的既有规则（core 层）：`from==='time'`、`tags` 含 `admin`/`alarm` 的信号 privileged → 一定穿透 focus。
**私聊不是 privileged**，且默认 ambient → 普通 focus 会拦下；只有显式 @ 才按 `mention` 规则穿透，sacred/sleep 仍拦。
如果用户明确希望"私聊在半梦半醒也能把我叫起来"，正确做法是给睡眠 schedule 配 `allow`，**不要**去改 focus/time 的全局特权列表：
`time_arrange {sleep:true, allow:[{from:'qq'}]}`（或 `[{tags:['at']}]`）。
⚠️ `tags:alarm` 的全局特权按 time 的 `docs/TIME.md §9` 是**已知风险，不是安全边界**——QQ/其它来源不要依赖它做"紧急穿透"；
QQ 私聊不自动带 `alarm`/`safety`。time 静音锁的紧急配额按 `alarm/safety/emergency` 标签放行，那些标签只能由真正的紧急来源提供。

### 5.4 最终语义（冻结，2026-11-06）

这些是 QQ 入站/唤醒的**最终口径**，模拟/提示词/工具描述都以它为准（不要在不同文档里另立一套）：

1. **私聊默认 ambient**：signal `tags:['qq','private']`，**不自动带 `mention`/`at`**。
   普通 focus 会把它拦进积压；time 睡眠/暂停也会拦下并重放。不要期待私聊一定打断当前工作。
2. **只有显式 @ 才穿**：私聊消息里出现 @ 到自己（`rich.atSelf`）→ `tags` 加 `at`，
   普通 focus 按默认 `pierce:mention` 放行；`interruptible:false`（sacred）仍拦。
3. **admin/alarm 不自动授予**：`tags:['admin']` / `['alarm']` 的 privileged 只属于真正来源
   （管理通道/紧急事件）。QQ 私聊（包括 owner 私聊）不会自造这些标签；需要"叫醒"用 time schedule 的 `allow`。
4. **群不接**：本轮群消息整类丢弃（连只读都不收），不存在"看过群"；群阶段另立设计。
5. **策略入口按需**：`qq_help`（skill=`reply`）承载"何时回/不回/优先级/信封"；不要把这些文本写进 system 静态段，
   也不要每轮注入。`qq_status`/`qq_send` 的 tool description 只放当前动作的关键边界。
6. **说话人信封**：正文前缀 `[QQ私聊·主人]` / `[QQ私聊]`，`meta.qq.envelope` 存结构化来源；
   补课加 `[补课]`；睡觉重放由 time 加"你睡觉时"前缀。详见 §7.5。

## 6. 与 time 静音锁的接口（给 time owner 的对接点）

**接口面只有 `signals` 的 `from/kind/tags` 三个字段。** QQ 不读 time 的 phase、不调用 time API、不抢 gate。

### 6.1 两级语义如何映射

| 级别 | 本轮由谁产生 | signal 形状 | time 醒着 | time 睡着/暂停 |
|---|---|---|---|---|
| **pierce**（该叫醒） | 显式 @ 到自己；管理员/告警由其它来源 | `tags:['qq','private','at']`；或 `tags:[...,'admin'/'alarm']` | 放行 → focus 再裁决 | 默认**拦**（进 time 积压）；若 schedule `allow` 命中则穿 |
| **ambient**（可攒着） | 普通私聊（默认）；未来普通群消息 | `tags:['qq','private']` | 放行 → focus 默认拦 | 默认拦；`allow` 可配 |
| 闹钟/特权 | time 自己 | `from.plugin:'time'`、`tags` 含 `alarm`/`admin` | 放行 | 放行（time 自己始终 accept） |

### 6.2 具体问答（lead 点名）

- **@ 是否穿透？** 私聊里出现显式 @ 到自己时，`tags` 加 `at` → 普通 focus 按默认 `pierce:mention` 穿透；sacred 仍拦。
  群消息本轮整类忽略；未来接群时，@ 消息打 `tags:['qq','group','at','mention']`（群 @ 才用 `mention`），
  time 睡着时仍需 schedule 的 `allow` 命中才穿。
- **私聊是否穿透？** 默认**不穿透**：普通私聊是 ambient，醒着也会进 focus 积压（红队修复 2026-11-06）；
  显式 @ 才穿普通 focus；睡着/暂停一律由 time 拦下、进它自己的积压，醒来重放；`interruptible:false` 的 sacred focus 连 @ 也不穿。
  要显式允许"私聊穿睡眠"，由 sleep schedule 的 `allow` 表达：`time_arrange {sleep:true, allow:[{from:'qq'}]}`（精确调用口径由 time 提供）。
- **QQ 怎么知道被拦了？** `signals.offer` 返回 `{blocked:true, reason}`；QQ 只计数（`blockedReasons`），**不重试**，
  把重放权留给 time。`qq_status` 会显示"被静音/睡眠锁拦下 N（已交给 time 的积压，不重试）"。
- **两侧如何对账？** time `time_status` 看 `phase/backlog/丢弃（漏响/溢出/过期）`；QQ `qq_status` 看 `blockedReasons` + 最近一条私聊/最近一次被拦
  + 影子记录 `blocked` 行；time 醒来后投递的正文里有 `[qq/qq:private:<qq>]` 前缀，能和 QQ 侧计数对上。
  time 的积压条目带 `signalId`（`qq:private:<qq>:<message_id>`），必要时可用 `time_list` 的 `sig=` 与 QQ 影子的 `id` 精确对账。

### 6.3 给 time owner 的三条建议（已全部采纳、合并并冻结契约：time W3 收尾）

> 按 lead 决策已直接发给 time。time 实现了全部三条并确认 **backlog 形状冻结**（2026-11-05，W3/task-5 completed）：
> 最终形状 `{id, signalId, from:{plugin,activity}, kind, text, tags, focus, reason, at, createdAt, expiresAt}`，
> 重放前缀固定 `[plugin/activity]`，溢出"优先丢 ambient、保 `at/private/direct/admin` 等"；本次只把 QQ 私聊从 pierce 降为 ambient（带 `private` 仍受保护）。
> `time_status` 暴露 `丢弃/溢出`，`time_list` 显示 `sig=`。来源侧不需要兜底暂存——gate 返回 blocked 前已 `enqueue()+persist()`。
> 若 lead 合并 review 要求调整，time 会先通知 QQ 并同步 `docs/TIME.md §4/§11`；QQ 侧对应改本文 §6 与 drill 断言。

1. **`signalId` 已落地**：`time.json` 的积压条目现在存 `{signalId, createdAt, from:{plugin,activity}, …}`；同一 `signal.id` 重复 offer
   不重复入队。QQ 的 signal id 稳定为 `qq:private:<qq>:<message_id>`，drill 已严格断言 `queue()[0].signalId === 'qq:private:10001:1003'`。
2. **重放前缀已保持 `[plugin/activity]`**：`buildBacklogText` 输出 `· [qq/qq:private:10001] 正文`，不会改；一次性合并成一条
   `plugin:time` notice 是有意的，QQ 不反对。
3. **溢出策略已采纳**：满 `maxQueue` 时优先丢最旧 **ambient**（无 `at/private/direct/admin` 等保护标签的），全都受保护时才丢最旧；
   QQ 私聊有 `private`，仍受保护；显式 @ 另有 `at`。
4. 若将来要"私聊穿睡眠"：用 sleep schedule 的 `allow` 表达——`time_arrange {sleep:true, allow:[{from:'qq'}]}`（或 `[{tags:['at']}]`），
   不要改全局特权列表。⚠️ `tags:alarm` 的全局特权按 `docs/TIME.md §9` 是已知风险、不是安全边界，QQ 不依赖它。

## 7. 私聊收发路径

### 7.1 入站（已实现、已验证）

```text
SnowLuma OneBot WS 127.0.0.1:3001
  └─ qq 插件（默认关闭；显式配置 enabled:true 才连）
       ├─ 端点：url+token 或 snowlumaHomeDir 只读发现（token 只在内存，不落日志/状态文件）
       ├─ 零出站帧；心跳过期只标记 stale，不重连风暴（指数退避 1s→30s + 抖动）
       └─ gate → signals.offer → time gate → focus.admit → delivery → bridge.steer → 会话
```

### 7.2 出站（phase 1「只回私聊」：已实现，产品默认关闭）

**唯一入口**是工具 `qq_send`（`src/send-tool.mjs` 注册）；它只在三把钥匙同时打开时才有：

```
enabled === true && allowSend === true && sendApproval === 'lead-approved'
```

- `index.mjs` **不 import 发送实现**：keys 打开时才 `await import('./send-tool.mjs')`；`send-tool` 才 import `outbound.mjs` 的 `createOutbound`。
- **目标**：只接受私聊 QQ 号，且必须在 `allowPrivate` 里；phase 1 再要求等于 `ownerQQ`（默认配置 3429502459）。群/富媒体/多目标广播的代码不存在（静态安全测试守着 `send_group_msg` 不出现）。
- **内容**：纯文本、非空、≤`maxSendChars`（默认 2000）、敏感信息拦截（`api_key/token/password/sk-…/PRIVATE KEY` 等默认 pattern，可配置）。发送前 Markdown 会转纯文本（`markdownToPlain` 可关）。
- **人类化（P0-3）**：一段回复可拆成 **1–8 条气泡**；条间默认 1–3s、20% 概率 5–10s 长停顿（`gapMode: auto|fixed|typing|byLength`，typing 按 1.4 字/秒估算）；单条超 `maxMessageChars`（默认 500）自动切分，**URL 整条保留、emoji 不被切开**；一条输入被拆成过多气泡时整体拒绝（不发半截）。
- **限速**：同 peer 最小间隔 5s、每分钟最多 10、每小时最多 60（按气泡数预留）、同文 60s 去重、每轮最多 1 次调用（`turn-end` 重置）。
- **回执三态**：`ok`（retcode=0 且有 message_id）/ `rejected`（后端明确拒绝）/ `unknown`（超时/连接断/无回执）。**unknown 不自动重试**（OneBot 无幂等键，盲重试会双发）。
- **失败不冒充成功**：工具文本明确写"没发出去：原因"；多气泡时如实报"已发 k/N，其余未发送"（失败即停、不重试）；`qq_status` 暴露 `send.recent`（时间/peer/outcome/sent/total/messageId/ms）与计数。
- **kill switch**：每次调用**和每条气泡前**重读 live config；运行中把 `allowSend` 改成 false，下一次/下一气泡立即拒绝。
- **审计**：`auditFile` JSONL **每条气泡一行** `{at,kind:'send',peerId,chars,textHash,outcome,messageId,ms,batch:{index,total},error?}`，**不存正文全文**。
- 传输走**独立的出站 WS 连接**（与只读入站分开）：入站连接仍保持 `framesSent===0`；出站连接单独统计帧数。

真实 shadow 的"只收"边界（只读模式仍适用）：
不启动 SnowLuma、不连接 3000/3120、不调 OneBot 动作、不写 SnowLuma 文件，收到私聊只落 `.state/lab/<run>/qq-shadow/inbound.jsonl` 并进 signals。

### 7.3 账本与断线补课（P0-1，已实现；契约 fake 已验证、真机待验证）

```text
WS 断线（connector 记下 disconnectedAt/downtime）
  └─ 重连 open ──► onOpen（first? start : reconnect）
        ├─ 账本：SQLite（node:sqlite；未配置 ledgerFile 且无 state 文件时退化内存并明确标出）
        ├─ 补课：HTTP OneBot（独立于入站 WS；入站仍 framesSent=0）
        │     get_friend_msg_history {user_id, count}  ← fake 已定契约，真机待验
        │     过滤：账本已有 qq_id / 自己发的 / 早于水位 2s 以上 / 超 maxBackfillAgeMs
        │     命中 → 同一 signal.id 走 gate（backfilled:true）→ signals.offer
        ├─ 水位：只在 signals.offer 被接受（或 signals 幂等去重）后前进；
        │         被 time/focus 拦下不前进（等重放，signal id 复用）
        └─ gap 可见：reconnects / lastDowntimeMs / backfillRuns / filled / dropped / failed / unsupported
             qq_status 文本 + status.json 的 `gap`、`ledger` 字段
```

关键约定：

- **账本字段**（`src/ledger.mjs`）：`activity,seq,qq_id,signal_id,at,sent_at,received_at,sender,text(≤1000),mention,media,delivered_at`；`(activity,seq)` 主键、`(activity,qq_id)` 唯一；每活动 `next_seq/attended_seq/last_qq_id/last_at`。
- **seq 是插件内部单调序号**（不是 QQ `message_seq`；私聊历史接口不一定给 `message_seq`）。signal id 仍由 `message_id` 决定：`qq:private:<qq>:<message_id>`。
- **水位边界**：插件能看到的"投递成功" = `signals.offer` 接受（进入 delivery 队列且未被 time/focus 拦下）。bridge 的 ack 在 `dsh-icl`，插件拿不到回调；因此 `ledger.delivered` 不能说成"用户已看到"。
- **补课标记**：signal 的 `tags` 加 `backfill`、`meta.qq.backfilled=true`、正文前缀 `[补课] `，模型能知道"这条不是刚发生的"。
- **已读策略**：P0 **不调用** `mark_msg_as_read` / `mark_private_msg_as_read`（会把已读同步到用户自己的 QQ，属产品决定）；P1 的 `qq_mark_read` 再显式做。
- **私聊历史语义待真机**：SnowLuma 文档只说 `get_friend_msg_history` "无锚点时从服务器获取最新双向记录"，不一定支持任意锚点；实现用本地水位 + id 双判兜底，真机若确认不支持 → 只保留 gap 可见性，不假装连续。
- **群**：本轮仍不补（phase 2）；群游标用 `message_seq` 的接口在旧项目已成熟，届时复用。
- 配置：`ledgerFile`、`httpUrl`/`httpToken`（不填则用 SnowLuma 发现的 `httpServers[0]`）、`backfillEnabled`、`backfillCount`、`maxBackfillAgeMs`、`backfillMaxPeers`。

### 7.4 入站富内容（P0-2 纯函数层，已实现；图片真正进模型待 DSH attachment）

```text
OneBot 段 ──► rich.mjs（纯格式化）
   ├─ text/at/face/mface/image/record/video/file/reply/forward/json/markdown
   ├─ 文本：图片/语音/视频占位；文件带 name（size）；转发带 id；表情带 summary
   ├─ meta.qq: media[] / files[] / forwardIds[] / replyId / atSelf
   └─ 进闸门前（受配置控制，失败不阻塞消息）：
        ├─ reply-cache.mjs：get_msg 慢取（后台 120s、收消息最多等 replyIngestWaitMs）
        │     归属校验：私聊必须有 sender∈{peer,self} 且无 group_id；等不到放占位
        ├─ forward.mjs：get_forward_msg 展开（≤2 层、≤12 条、≤1200 字；嵌套 id 递归）
        └─ media.mjs：仅提供安全抓取/类型/大小校验（本轮**不投给模型**，也不落地）
```

**能力边界（写清，避免被当成"她能看图了"）**：
- 现在模型看到的是**文本占位 + 结构 meta**，不是图片字节；图片/文件"真正进上下文"要等 DSH `ImageBlock`/attachment 通道（单独申请，按 CACHE-MODEL §7 约束）。
- `media.mjs` 已具备：只允许 http(s)、拒绝 localhost/私网/带凭据 URL、8MB 上限、魔数嗅探 png/jpeg/gif/webp、`get_image` base64 兜底；后续接图片通道时直接复用。
- 引用解析失败/慢：消息本身不丢，正文里是 `[引用消息 id=…（原消息加载较慢…）]`。
- 转发展开失败：保留 `[合并转发 id=…]` 占位，不影响正文。
- 富内容也在账本/补课路径里生效：补课消息同样走 `enrichInbound`（`backfilled:true`）。

配置：`richEnabled`、`replyResolveEnabled`/`replyIngestWaitMs`/`replyResolveTtlMs`、`forwardExpandEnabled`/`forwardExpandMax`/`forwardExpandMaxChars`。

### 7.5 说话人信封与策略入口（F1/F3、A2/B1/B2 的 QQ 部分）

**插件侧已完成（不碰 dsh-icl）：**

- **正文信封**：入站 signal 的 `text` 前缀
  - `[QQ私聊·主人]`：`peerId === ownerQQ`
  - `[QQ私聊]`：白名单里的其他人（含 `allowAllPrivate` 下的陌生人；gate 仍按白名单裁决）
  - 补课消息：`[QQ私聊·主人] [补课] …`（gate 的 `[补课]` 在信封之后）
  - time 睡眠重放：time 会在前面再加“（你睡觉时）”；因为 envelope 已写进 `signal.text`，time backlog 的 text 会原样保留。
- **结构化信封**：`signal.meta.qq.envelope = { channel:'qq', scope:'private', senderKind:'owner'|'allowlisted'|'stranger',
  peerId, senderId, senderName, activity, backfilled, at, receivedAt, messageId }`（`qq_status` 的 `stats.recent.lastAccepted.envelope` 可查）。
- **配置**：`senderEnvelope`（默认 true）可关；关掉后正文回到裸 `${senderName}：${text}`。
- **策略入口（F1/F3）**：`qq_help` 工具按需读 `packages/plugins/qq/skills/reply.md`（何时回/不回、私聊优先级、
  群不接、信封含义、发送三态）。**不进 system 静态段**：默认不注册任何 `qq:*` prompt section；
  `qq_status`/`qq_send` 的 tool description 只写当前动作的边界（每轮都会随工具表出现，但只是短描述，不是策略全文）。
  如果将来想在每轮加一句“QQ 有积压”的提示，应该走 **runtime-context（facts）**，并先与 cache 对表；不要塞静态段。

**跨模块剩余项（写给 bridge/ICL owner；不要现在改 dsh-icl）：**

1. **结构化信封过桥**：`packages/dsh-icl/src/bridge.mjs` 的 notice 目前只用 `batch.text` + 固定 summary“外部消息”。
   建议 bridge 从 delivery batch 条目里读 `meta.qq.envelope`（需要 delivery/signals 透传 signal.meta，或在 batch entry 上带 `meta`），
   渲染成 `[外部消息 · QQ私聊 · owner]` 或独立 summary 行；**不要**在 bridge 里重复判断 owner（以 `envelope.senderKind` 为准）。
   若暂时不改 bridge，正文前缀已能让模型分清来源。
2. **“被拦过”的可见性**：QQ 插件只能看到 `signals.offer` 被接受；focus deferral 发生在 `host.setDeliver`（信号已 accepted），
   time 拦截会进 time backlog。所以 QQ 侧**不伪造**“被 focus 拦过”的字段。
   现有可依赖事实：time 重放带“（你睡觉时）”；focus 释放摘要来自 text（信封保留）。
   若要在正文里显式标“这条曾在专注时被拦”，需要 bridge/focus 在重放/摘要时补标记（跨模块项）。
3. **状态提示**：`qq_status` 已经有最近一条/回执/gap；若要在提示词里给“有人找你”一行，属于 runtime-context 改动（同上）。

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
| `allowSend` / `sendApproval` | `false` / `''` | 出站两把钥匙（第三把是 `enabled`） | 默认全关；三把齐才注册 `qq_send`，产品默认保持关闭 |
| `ownerQQ` | `null` | phase 1 唯一允许回复的私聊对象 | 非 null 时发送目标必须等于它；lab 设 `3429502459` |
| `auditFile` | `''` | 发送审计 JSONL | 只存 `textHash/chars/outcome/messageId/ms`，不存正文 |
| `sendTimeoutMs` | `15000` | 动作回执超时 | 超时 → `unknown`（不自动重试） |
| `sendMinIntervalMs` / `sendMaxPerMinute` / `sendMaxPerHour` / `sendSameTextWindowMs` | `5000` / `10` / `60` / `60000` | 发送限速/防抖 | 按气泡数预留；超限 → "没发出去：限流/重复内容" |
| `maxSendsPerTurn` | `1` | 每轮最多几次发送调用 | 默认 1；`turn-end` 后重置（一次调用内可有多条气泡） |
| `maxSendChars` | `2000` | 单条输入文本上限 | 超出直接拒绝（不自动截断） |
| `markdownToPlain` | `true` | 发送前 Markdown→纯文本 | 关掉则原样发送（不推荐） |
| `burstEnabled` / `burstMaxMessages` / `maxMessageChars` | `true` / `8` / `500` | 多气泡开关/单次上限/每条长度 | 超过气泡上限整体拒绝；单条超长按 URL/emoji 安全切分 |
| `burstIntervalMinMs` / `burstIntervalMaxMs` / `longGapProbability` / `longGapMinMs` / `longGapMaxMs` | `1000` / `3000` / `0.2` / `5000` / `10000` | 气泡间隔与长停顿 | `gapMode=auto` 时生效；fixed/typing/byLength 另有参数 |
| `gapMode` | `auto` | 间隔模式 | `auto｜fixed｜typing｜byLength`；typing 用 1.4 字/秒 |
| `sleepImpl` / `randomImpl` | `null` | 测试注入 | 生产不填 |
| `ledgerFile` | `''` | 入站账本（SQLite） | 空：有 state 文件时用同目录 `qq-ledger.db`；否则内存模式（重启不保留，状态里会写明） |
| `httpUrl` / `httpToken` | `''` / `''` | OneBot HTTP 动作端（补课/已读） | 空：用 SnowLuma 发现的 `httpServers[0]`；补课不可用时 gap 记 `unsupported` |
| `backfillEnabled` / `backfillCount` / `maxBackfillAgeMs` / `backfillMaxPeers` | `true` / `50` / `21600000` / `5` | 补课开关/条数/最大年龄/会话数 | 补课失败只让 gap 可见，不影响实时入站；`mark_*_as_read` 不在 P0 调用 |
| `richEnabled` | `true` | 入站富内容总开关 | 关：回到纯占位文本；开：引用/转发在闸门前慢取 |
| `replyResolveEnabled` / `replyIngestWaitMs` / `replyResolveTtlMs` | `true` / `2000` / `1800000` | 引用解析开关/收消息等待/缓存 TTL | 等不到放占位，不阻塞；归属不符返回 null |
| `forwardExpandEnabled` / `forwardExpandMax` / `forwardExpandMaxChars` | `true` / `2` / `1200` | 合并转发展开 | 深度/条数/字数都有上限；失败保留 id 占位 |
| `senderEnvelope` | `true` | 说话人信封（正文前缀 + `meta.qq.envelope`） | 关掉后正文回到裸 `${senderName}：${text}`；结构化字段也随之不写 |
| `sensitivePatterns` | `null`（用内置 pattern） | 发送前敏感信息拦截 | 命中 → "没发出去：内容含敏感信息" |
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
node packages/plugins/qq/tools/preflight.mjs --brief  # 给用户看的一页说明（申请时间窗时直接贴）
# 等价写法：node packages/plugins/qq/tools/lab-shadow.mjs --preflight
```

给用户的一页说明同时存到 `.state/qq-shadow/preflight/user-brief-latest.md`；
本仓库里有一份带当前快照的可读版本：[QQ-SHADOW-USER-BRIEF.md](QQ-SHADOW-USER-BRIEF.md)（含可粘贴全文 + lead 内部核对点）。

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
| 她能不能回 | 事实：没有发送工具；`index.mjs` 无任何发送调用（只 import `sendEnabled` 纯判定做状态展示） | 她只能看到，不能回 |

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

### 10.1 phase 1 真实窗口（只回 owner 私聊；等 lead 指令后执行）

> 前提（lead 已完成/确认）：旧 focus-core 应用已停且不再恢复；启动项 `dsh-icl.lnk` 已移到 `.state/backup-startup/`（可回滚）；
> SnowLuma 由用户手动启动；本次窗口**只允许 owner 3429502459 的私聊**。产品默认仍关闭，本窗口只靠 lab patch 打开三把钥匙。

```powershell
cd C:\DSH\icl-wt\qq
node packages/plugins/qq/tools/preflight.mjs --snowluma-up   # phase 1 就绪检查：SnowLuma 在跑/无旧消费者/3001 无其它连接
node packages/plugins/qq/tools/lab-shadow.mjs --real --approval lead-approved --send `
  --peer 3429502459 --owner 3429502459 --port 57108 --wait-ms 900000
```

`--send` 会把三把钥匙（`enabled/allowSend/sendApproval=lead-approved`）+ `ownerQQ` + `auditFile` 注入 lab patch，
并设 `maxSendsPerTurn:1` 等限速；脚本等用户发一条私聊、她调用 `qq_send` 回一条后落证据。

窗口内检查：

| 检查 | 位置/命令 | 期望 |
|---|---|---|
| 她只回 owner、每轮 1 条 | `<runDir>/qq-shadow/status.json` 的 `send.recent` / `send.counts` / `send.perTurn` | `recent.outcome=ok`、`peerId=3429502459`、`perTurn.sent=1` |
| 审计只存 hash/长度 | `<runDir>/qq-shadow/send-audit.jsonl` | 1 行、`outcome=ok`、无 `text`、有 `textHash/chars` |
| 真实动作只有一条私聊 | SnowLuma 当天日志尾部搜 `send_private_msg` / `send_group_msg` | `send_private_msg` 恰好 1 次/轮、`send_group_msg` **0 次** |
| 用户侧收到 | 用户 QQ 私聊 | 只收到 1 条，内容是她回的那句 |
| 入站仍只读 | `status.json` 的 `connection.framesSent` | 0（出站帧在 `send.transport.framesSent`，单独统计） |
| 她若再发 | 同一轮第二次 `qq_send` | 返回"没发出去：本轮最多 1 条"，不产生动作帧 |

失败即停（任一命中立即 `down` + 请用户关 SnowLuma + 通知 lead）：出现 `send_group_msg`、任何非 owner 目标、
`unknown` 后她继续重试、单轮 >1 条、审计出现正文、SnowLuma 日志出现非预期发送。

```powershell
# SnowLuma 当天日志的动作核对（只读）
$log = Get-ChildItem 'C:\Users\ai_admin\Downloads\SnowLuma-v2.1.1-win-x64-lite\logs' |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
Select-String -Path $log.FullName -Pattern 'send_private_msg|send_group_msg' | Select-Object -Last 20
```

## 11. 落地顺序建议

| 阶段 | 内容 | 前置/权限 | 完成判据 |
|---|---|---|---|
| **0. 只读 shadow（本轮）** | 私聊 → signals → 会话；群整类忽略；零出站；影子记录/状态文件 | 只需 lead 批准 lab；真实 SnowLuma 需用户时间窗（§10） | 本文 §0/§13 全部证据；真实 shadow 至少 1 个 15 分钟窗口无 §10 失败项 |
| **1. 私聊回（出站）** | 只回 owner 私聊、纯文本、限速、人工 kill switch、回过没水位 | **lead 明确批准 + 用户单独批准**（已获批准；产品默认仍关） | ✅ 实现 + fake 11 条全过；真实窗口按 §10.1 等 lead 指令；群仍然 0 发送 |
| **2. 群（永远最后）** | 先只读群 + @ 检测（只入 signals、不回），再评估回复 | **用户单独批准且只针对白名单群**；默认 `enabled:false`、默认只读 | 群只读 shadow 先跑；每次群发都必须另有一把钥匙；限流 + 静默 + 人工值守 |
| 附：多平台 | 微信/B站等 | — | 复用同一 signal 形状；**不要**在接第二个平台前做"插件框架"（focus-core TRANSPORT-ARCH 的教训） |

每条都是独立开关：阶段 0 的代码不会因为阶段 1/2 的配置变化而自动获得发送能力。

### 11.1 阶段 1（私聊回）最小改动清单与验收标准

> **状态（2026-11-05）：10 项全部落地**，证据 = `src/{send-tool,outbound}.mjs` + `packages/core/test/qq-send.test.mjs`（11 条 fake 全过）+
> 静态安全测试；真实 QQ 窗口按 §10.1 等 lead 指令。下表保留原始验收口径，实现位置以"位置"列为准。
>
> 前置：**lead 明确批准 + 用户单独批准**（均已获得；产品默认仍关闭）；群发送代码仍然不存在。
> 出站是**独立新模式**，不破坏阶段 0 的不变量：影子模式仍要求入站连接 `framesSent===0`；出站连接单独统计。

| # | 改动 | 位置 | 最小实现 | 验收（可检查） |
|---|---|---|---|---|
| 1 | **出站通道 + 三把钥匙** | `src/outbound.mjs`（已隔离、未接线）、`src/index.mjs` | 接通 OneBot `send_private_msg`：给只读连接器加 `call()`（echo 配对、超时）；只有 `enabled && allowSend && sendApproval==='lead-approved'` 且目标在 `allowPrivate` 才发 | 单测：三钥匙缺任一把 → 零帧；配置不合法 → 明确报错而不是静默 |
| 2 | **工具面（唯一发放入口）** | `src/index.mjs` + `manifest.json` | 新增 `qq_send`（**只接受私聊目标 + 单条文本**；无 `group` 参数、无富媒体、无多目标广播）；description 写清参数/失败/不能发群 | `surface` 只多 1 个工具；`qq_send` 拒绝非白名单/群目标；影子配置下不注册该工具 |
| 3 | **内容边界** | `src/outbound.mjs` | 纯文本；空/超长（按 QQ 单条上限切分或直接拒绝，建议先拒绝并返回原因）；发送前敏感信息拦截（可复用 dsh-qq 的 `SENSITIVE_RE` 思路，命中拒绝并回显理由） | 单测：空、超长、含敏感串 → 不发送、返回可读原因 |
| 4 | **限速/防抖** | `src/outbound.mjs` / `src/index.mjs` | 每 peer 最小间隔（默认 5s）、每分钟上限（默认 10）、60s 内相同文本去重；超限返回"限流，未发送" | 单测：连发第 2 条被限流；同文本被去重；返回文本可区分"限流"与"网络失败" |
| 5 | **确认回执（三态）** | `src/outbound.mjs` | 只有 `retcode===0` 且拿到 `message_id` 才算 `{ok:true}`；超时/连接断 = `{ok:false,outcome:'unknown'}`；后端拒绝 = `{ok:false,outcome:'rejected'}` | 单测 + 假 OneBot 回环：成功/retcode 失败/无回执超时三种帧与结果一一对应 |
| 6 | **失败不冒充成功** | `src/index.mjs` | 工具返回三态给模型；失败写 `core.service-error`/日志（目标、文本哈希、耗时、错误），**不自动重发**（OneBot 无幂等键，盲重试会双发） | 单测：失败时工具文本含"没发出去：原因"；日志有记录；不会第二次写 socket |
| 7 | **"回过没"水位** | `src/index.mjs` + 影子记录 | 发送成功后记 `peerId -> lastSentAt` 与最近发送结果；`qq_status` 增加"最近一次发送：时间/结果/是否 unknown"；可选把该 peer 此前收到消息标 `replied`（最小版存 `recordFile`/状态文件，跨重启可接受） | 单测：发送成功后 `qq_status` 显示时间与结果；失败后显示失败原因而不是"已回" |
| 8 | **Kill switch** | `src/index.mjs` | `allowSend=false` 时**下一次调用立即拒绝**（不重启即生效）；更高优先级的进程级开关（env 或 control 文件）可选 | 单测：运行中把配置改成 false → 下一次 `qq_send` 拒绝且零帧 |
| 9 | **审计与证据** | `recordFile` / `statusFile` | 每次发送写 JSONL：`{kind:'sent', peerId, chars, messageId, outcome, ms, at}`；正文只存 hash + 前 N 字 | 发送窗口结束后，记录条数 = 实际发送次数，可与 QQ 客户端对账 |
| 10 | **人工受控窗口** | runbook（§10 扩展一节） | 先只回 owner 私聊、只文本、人工值守；建议每次会话 ≤3 条、失败即关；观测到任何非白名单发送立刻停 | 一次受控对话通过 + 结束后 QQ 客户端/日志与审计一致 |

**明确不做（阶段 1）**：群发送、富媒体（图片/语音/文件）、广播/多目标、自动重试、定时主动发起、修改群设置/撤回/戳一戳。
**阶段 2（群）仍然最后**：先只读群 + @ 检测（只入 signals、不回），再单独评估；任何时候群发都需要用户单独批准和额外开关。

## 12. 已知限制 / 没做

1. **WS 不补课**：OneBot 正向 WS 不重放断线期间的事件；私聊没有可靠的 `get_friend_msg_history`（SnowLuma 未验证）。影子期间丢线 = 丢那几条，`recordFile` 里没有就是没有。将来要做补课，先验证动作是否存在，再按 `message_seq` 游标做（群路径已有先例）。
2. **`message_id` 的稳定性**：SnowLuma 实测是数字且稳定；换后端要重新验证。没有 id 时用时间+文本哈希兜底（可能误合并同秒同文）。
3. **去重窗口**：本地 24h；超过窗口后同 id 会再投（现实不会发生，但写在这里）。
4. **媒体不落地**：图片/语音/文件只有占位与引用；要看图需要另设计受控下载（不要让模型自己 fetch 任意 URL）。
5. **群/@/poke/notice/request 未接**：本轮的"@ 穿透"只存在于设计里（§6.2）。
6. **time 重放归因/去重（已解决）**：time `05c4d19`（已合并 master）起积压带 `signalId`、同 id 不重复入队、溢出保护私聊；drill 已严格断言通过。更旧版本的 time 只能归因到 `[plugin/activity]`。
7. **影子会起一轮**：lab 实测私聊在空闲时会 `turn/start`（她看到了、会思考怎么回，但没有回复工具）。`promptLine` 默认关闭，下一轮建议打开一句"QQ 只读影子不能回复"，避免她误以为自己已经回了。
8. **并发只验证到 T1–T3（fake）**：T4–T6（双限流独立、会话切换/重试、交错顺序）还没做；真实 mc-body + 真实 QQ 未同跑。
9. **旧消费者风险**：见 §2.3 / §10 第 2 步；不处理就没有干净影子。
10. **phase 1 出站的限制（刻意）**：只回 owner/白名单私聊、纯文本、单条、每轮≤1、无自动重试、无富媒体、无广播；
    出站是**独立 WS 连接**（SnowLuma 会看到 2 条客户端连接：1 只读 + 1 出站）；`unknown` 结果可能确实已送达，
    所以工具文本明确要求"不要盲目重发"，人工窗口里也不要替它重试。
11. **"回过没"水位是最小版**：只记 `send.recent`（内存 + 状态文件/审计），没有做"发送成功后把该 peer 此前收到消息标 replied"的账本；
    阶段 2 需要时再加。

## 13. 测试与证据

### 13.1 自动化测试

```powershell
node --test packages/core/test packages/mc-body/test   # 540 pass / 0 fail
node --test packages/core/test/qq.test.mjs             # 19 pass
node --test packages/core/test/qq-send.test.mjs        # 18 pass（phase 1 出站 + P0-3 人类化集成）
node --test packages/core/test/qq-humanize.test.mjs    # 9 pass（纯函数：md/切分/节奏/计划）
node --test packages/core/test/qq-backfill.test.mjs    # 6 pass（账本/补课契约/断线补回/gap）
node --test packages/core/test/qq-rich.test.mjs        # 11 pass（富段/引用/转发/媒体安全/focus 语义）
node --test packages/core/test/qq-envelope.test.mjs    # 5 pass（说话人信封/qq_help/工具描述边界）
node --test packages/core/test/qq-mc-concurrent.test.mjs  # 3 pass（T1–T3）
node --test packages/core/test/qq-preflight.test.mjs   # 13 pass（判定 + 陈旧 shadow 文件不误报 + 用户一页说明 + phase1 模式）
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
| 19 | 静态安全：index.mjs 无 `send_*` 动作、不 `createOutbound`/`sendPrivate`；connector 无 `ws.send`；发送代码只在 outbound.mjs | "无发送路径"有代码级不变量 |

另两个测试文件：

- `qq-send.test.mjs`（11 条，phase 1 出站）：三钥匙关闭不注册 `qq_send`；成功只发 1 帧 `send_private_msg`（user_id/message 正确）、
  审计 ok 且不存正文、`qq_status` 显示三态；每轮上限 + turn-end 重置；后端拒绝→rejected；无回执超时→unknown 且**不自动重试**；
  群/非白名单/非 QQ 号拒绝；空/超长/敏感拒绝；5s 限速；60s 同文去重；kill switch（运行中关 allowSend 立即拒绝）；审计四种结果。
- `qq-mc-concurrent.test.mjs`（3 条）：T1 双源两个 batch/不混来源/不重；T2 sacred focus 下双源都进 core 积压且不投递；
  T3 time 睡眠下双源都进 time 积压、醒来一条 `plugin:time` notice 同时重放（正文 `[qq/qq:private:10001]`、`[mc/event]`）。
- `qq-preflight.test.mjs`（13 条）：shadow 干净=CLEAR；旧应用/dsh-qq 桥/端口占用/desktop 启用行/已有 shadow=BLOCK；
  用户自己的 QQ.exe 只提示不阻断；**phase 1 模式**（`--snowluma-up`）SnowLuma 在跑+CLEAR、没起来/有旧消费者=BLOCK；
  拿不到进程列表=WARN（不报 CLEAR）；被 kill 的 lab 留下的 `connected:true` 状态文件/已结束 run 不算"正在跑"；
  `renderUserBrief` 在 BLOCK 时讲清 pid/旧人格/回滚、CLEAR 时给可开始结论。

### 13.2 进程内演练（含 time 睡眠锁）

`node packages/plugins/qq/tools/qq-shadow-host.mjs` → `.state/qq-shadow/fake-2026-11-05T10-30-35-913Z/report.md`：

```text
✓ 连接假 OneBot      ✓ 私聊进了 delivery      ✓ 重复被去重
✓ 群消息整类忽略      ✓ 白名单外被拒          ✓ 睡眠锁拦下私聊 {"sleeping":1}
✓ 被拦下时不进 delivery  ✓ time 侧记了积压    ✓ time 积压保留 signalId（signalId=qq:private:10001:1003）
✓ 醒来重放（正文含 [qq/qq:private:10001] 主人：睡着时来的）  ✓ 重放文本带来源前缀
✓ qq 客户端零出站帧   ✓ 假服务器没收到客户端字节 chunks=0   ✓ 影子记录不含群文本
```

### 13.3 真实 lab 验证（假上游，57108）

`node packages/plugins/qq/tools/lab-shadow.mjs --port 57108 --run qq-6` →
`.state/lab/qq-6/report.md`（10/10；显式 selectModel 后 `request/header` = `deepseek-account/deepseek-flash`）：

```text
✓ lab 会话建立（session-…, port=57108）
✓ qq 插件完成装配并上报状态（qq-shadow/status.json）
✓ qq 上游连接已打开（state=open）
✓ 零出站帧（插件自报）framesSent=0；出站=关闭
✓ QQ 消息以 plugin:qq user/message 进入 DSH 会话（seq=9）
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

给用户的一页说明：`node packages/plugins/qq/tools/preflight.mjs --brief`（同内容存 `.state/qq-shadow/preflight/user-brief-latest.md`；
仓库里带当前快照的版本：[QQ-SHADOW-USER-BRIEF.md](QQ-SHADOW-USER-BRIEF.md)）。

### 13.5 真实 SnowLuma 影子（phase 0）

⏸ 用户 2026-11-05 曾选 B 暂缓（当时不在电脑前、唯一阻断 pid 12232）；**之后用户回来了并批准 phase 1**，
lead 已停旧应用/移走启动项、SnowLuma 由用户手动开着。phase 0 真实只读窗口不再单独补跑（phase 1 窗口覆盖同样的入站链路）；
`lab-shadow.mjs --real` 已备好，`--real` 必须带 `--approval lead-approved`（不带直接 exit 2）。
"能收到私聊并进入 signals"由假上游进程内演练（14/14）与真实 lab（10/10）覆盖。

### 13.6 phase 1 出站（fake 已验证；真实窗口待 lead 指令）

`node --test packages/core/test/qq-send.test.mjs` → **18 pass**，覆盖：三钥匙关闭不注册 `qq_send`；成功只发 1 帧
`send_private_msg`（`user_id`/`message` 正确、审计 ok 且不存正文、`qq_status` 显示三态）；每轮上限 + turn-end 重置；
后端拒绝→`rejected`；无回执超时→`unknown` 且不自动重试；群/非白名单/非 QQ 号拒绝；空/超长/敏感拒绝；限速；
同文去重；kill switch；审计四种结果；**P0-3 新增**：markdown→纯文本、`messages[]` 多气泡、长文切分不丢内容、
气泡超额拒绝、部分成功 k/N、多气泡中途 kill switch、按气泡数预留每分钟上限。假后端动作记录里只有
`send_private_msg`、没有 `send_group_msg`。
`node --test packages/core/test/qq-humanize.test.mjs` → **9 pass**（mdToPlain 边界、代理对/URL 安全切分、
typing 档位、planBurst 各模式与上限、frequency gate）。
真实 QQ 窗口按 §10.1 等 lead 指令，证据要求：SnowLuma 日志 `send_private_msg` 次数=气泡数、`send_group_msg` 0 次、
用户收到对应条数、`status.json` 的 `send.recent.outcome=ok` 且 sent/total 正确、审计行数=气泡数且无正文。

### 13.7 P0-1 账本/断线补课（fake 契约已验证；真机待验证）

`node --test packages/core/test/qq-backfill.test.mjs` → **6 pass**：
- 账本（SQLite）：活动内 seq 单调、同 qq_id 不重复、水位只进不退、未知 seq 不推进、重开文件后消息/水位仍在。
- 闸门补课：窗口内收（`[补课]` 前缀 + `backfill` tag + `meta.qq.backfilled`）；超 `maxBackfillAgeMs` 记
  `stale-backfill`；实时消息仍按 `maxStaleMs` 判，不混用。
- 补课器：只补未见过的；跳过自己发的/超龄的；fetch 失败只记 `failed`、不抛。
- **插件集成**：先收一条实时消息 → `dropConnections()` 模拟断线 → 历史里塞两条（`get_friend_msg_history`
  契约）→ 重连后补回、delivery 里带 `[补课]`、账本 3 条、不重复、gap 的 `reconnects/backfillRuns/filled` 可见；
  **没有调用 `mark_*_as_read`**；再断一次不会重复补。
- HTTP 失败：补课 `failed` 计数、连接与实时入站不受影响。
- HTTP 客户端：返回 data 解析正确；retcode 非 0 抛错。
- 真机验证（用户在场时）：`get_friend_msg_history` 的锚点/返回字段/是否含自己消息/双向语义；
  `mark_private_msg_as_read` 对用户其它客户端已读的影响（P0 不调用，只记录契约）。

### 13.8 P0-2 入站富内容 + focus 语义（fake 已验证）

`node --test packages/core/test/qq-rich.test.mjs` → **11 pass**：
- 段→文本：图片/文件（name+size）/引用/转发 id/表情/@/markdown；提取 media/files/forwardIds/replyId；
  转发 id 只留安全字符；`meta.qq` 富字段进闸门 signal。
- 引用慢取：`get_msg` 命中与缓存；归属校验（群消息/他人消息 → null）；超时 → `pending` 占位，后台完成后可再取；
  并发去重与负缓存 TTL。
- 转发展开：节点形状兼容、嵌套递归（depth 2）、条数/字数上限/截断标记。
- 图片安全抓取：file:// / localhost / 私网 / 带凭据 URL 拒绝；8MB 上限；魔数嗅探；`get_image` base64 兜底。
- 插件集成：富消息（图片+文件+引用+转发）进 delivery，正文含 `[引用 测试：原话在这]` 与 `【转发展开 …】`。
- **focus 语义（红队修复）**：纯函数断言私聊 tags 只有 `['qq','private']`，不自动 mention/admin/alarm/safety；
  显式 @ 才加 `at`。集成断言普通私聊在 focus 下进积压、@ 才穿；admin/alarm 仍 privileged；sacred 连 @ 也不穿。

### 13.9 说话人信封 + 策略入口（F1/F3、A2/B1/B2 QQ 部分）

`node --test packages/core/test/qq-envelope.test.mjs` → **5 pass**：
- owner 私聊：正文 `[QQ私聊·主人] 主人：…`；`stats.recent.lastAccepted.envelope` 有 channel/scope/senderKind/peerId/senderName/backfilled/messageId。
- 白名单非 owner：`[QQ私聊]`，不冒充主人；`senderEnvelope:false` 回到裸正文。
- `qq_help`：列表/全文/未知条目；`skills()` 暴露 reply；默认 `prompt.names()` 没有 `qq*`（策略不占静态 system 段）。
- 工具描述边界：qq_status 的 avoid 明确“群、不要每轮查、发消息用 qq_send”；qq_help 指向 qq_status/qq_send。
- 补课信封在 `qq-backfill` 集成里断言：`[QQ私聊·主人] [补课] …`。

## 14. 参考文件（只读；**不修改旧仓库**）

| 仓库 | 路径 | 用途 |
|---|---|---|
| focus-core | `apps/dsh-icl/src/{transports/contract.js,domain/qq-ws.js,domain/qq-poller.js,domain/qq-ledger.js,domain/qq-delivery.js,domain/policy.js,ws/qq-events.js,main.js}` | 传输契约、OneBot 归一、poller/ledger 教训、两级 policy、旧消费者行为 |
| focus-core | `docs/{TRANSPORT-ARCH.md,MESSAGING-SUMMARY.md}`、`DESIGN-activity-focus.md`、`docs/focus-architecture.md` | 接缝设计、压测与投递决议、focus 语义基准 |
| dsh-qq | `interface-platform/src/connectors/{onebot-v11/*,qq-snowluma/discovery.mjs}`、`config.json`、`docs/FOLDER_MAP.md`、工作区 `dsh-qq-部署笔记.md` | OneBot/SnowLuma 稳定接法、账号与白名单、EULA 约束 |
| icl 前身 | `docs/HISTORY.md` | "QQ 连接器是最大缺口""一机多会话"的教训 |
| time（本仓库 W3） | `wt/time` HEAD `6a8809f`、core gate 语义 `93a67cb`/`5fa5051`、`docs/TIME.md §4/§9/§11` | 静音锁/backlog 契约、`allow` 语义、`tags:alarm` 已知风险 |
| 本仓库 | `packages/core/src/{signals,services,host,contracts}.mjs`、`packages/dsh-icl/src/bridge.mjs`、`packages/plugins/time/src/index.mjs`、`docs/{FOCUS,MESSAGES,SURVIVAL,TEAM-PLAN-2026-11-05}.md` | 既有的信号/投递/focus/time 接缝 |

## 附录：常用命令

```powershell
# preflight（shadow 前一条命令：谁可能抢连接 / 端口 / 已有连接 / 配置）
node packages/plugins/qq/tools/preflight.mjs            # 或 lab-shadow.mjs --preflight
node packages/plugins/qq/tools/preflight.mjs --snowluma-up   # phase 1 就绪模式：SnowLuma 应在跑、无旧消费者
# 假 OneBot（手动演示；随机/指定端口均可）
node packages/plugins/qq/tools/fake-onebot.mjs --port 3301 --token test-token --after 800 --group --duplicate
# 进程内演练（不碰 DSH、不碰真 QQ）
node packages/plugins/qq/tools/qq-shadow-host.mjs
# 真实 lab 验证（假上游）
node packages/plugins/qq/tools/lab-shadow.mjs --port 57108 --run qq-1
# 真实影子/phase 1 窗口（仅用户批准的时间窗；前置条件见 §10 / §10.1）
node packages/plugins/qq/tools/lab-shadow.mjs --real --approval lead-approved --port 57108 --wait-ms 900000
node packages/plugins/qq/tools/lab-shadow.mjs --real --approval lead-approved --send --peer 3429502459 --owner 3429502459 --port 57108 --wait-ms 900000
# 看影子状态 / 记录 / 发送审计
Get-Content .state/lab/<runId>/qq-shadow/status.json
Get-Content .state/lab/<runId>/qq-shadow/send-audit.jsonl
Get-Content .state/lab/<runId>/qq-shadow/inbound.jsonl
# 停 lab
node tools/lab.mjs down --run <runId>
```


## 0.2 真实影子执行结果（2026-11-05 22:57）

用户回到电脑前、手动启动 SnowLuma 后，旧消费者（focus-core pid 12232）已确认并停止；随后按 runbook 执行了一次真实只读影子：

- 命令：`node packages/plugins/qq/tools/lab-shadow.mjs --real --approval lead-approved --port 57108 --run qq-shadow-20261105-2257 --peer 3429502459`
- 结果：**9/9 全过**。QQ 私聊（`720385456`，"👋你好，这是测试消息"）以 `source.kind='plugin:qq'` 的 user/message 进入 DSH 会话；**零出站帧**（插件自报 framesSent=0，SnowLuma 日志同期无 `send_private_msg/send_group_msg`）；影子记录只有白名单私聊、无群文本；transcript 可见。
- 证据：`.state/lab/qq-shadow-20261105-2257/{report.md, events.jsonl, qq-shadow/inbound.jsonl, transcript.md}`；影子已自动停止，57108 无监听。
- 遗留：启动文件夹 `dsh-icl.lnk` 仍会在下次登录拉起旧 focus-core 应用（建议用户确认后改名/移走）；出站（私聊回）仍默认关闭，等用户单独批准后再实现 phase 1（10 项清单见 §11.1）。

## 0.3 Phase 1（只回私聊）真实出站验证结果（2026-11-05 23:18）

在用户手动启动 SnowLuma、旧消费者已停的前提下，按 §11.1 的 10 项实现完成后做了一次真实回执验证：

- 命令：`node packages/plugins/qq/tools/lab-shadow.mjs --real --approval lead-approved --send --peer 3429502459 --owner 3429502459 --port 57108 --run qq-send-20261105-2310`
- 入站：用户私聊"你好在吗"以 `plugin:qq` 进入会话（seq=9）。
- **她真的回了**：`qq_send` → `outcome=ok`、`framesSent=1`、`messageId=294938146`、`ms=269`。
- 服务端核对：SnowLuma 日志 `send_private_msg` **恰 1 次**（"在。这么晚还没睡？"，user_id=3429502459）、`send_group_msg` **0 次**。
- 审计：`send-audit.jsonl` 1 行，只有 `textHash/chars/outcome/messageId`，**不存正文**。
- 结果报告：`.state/lab/qq-send-20261105-2310/report.md`（13/13 全过）；影子已自动停止，57108 无监听。
- 产品默认仍关闭：只有 lab patch 打开三钥匙；phase 1 只允许 owner 私聊、每轮最多 1 次发送调用（一次调用内 P0-3 可拆 1–8 气泡）、失败不自动重试。
