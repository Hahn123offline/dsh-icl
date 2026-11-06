# 旧项目 qwenstuff 的工程复杂度笔记（只读研究）

> 读者：要把"少层、少概念"的旧做法搬进 ICL 的人。
> 范围：**agent 主循环 / 事件 / 工具面 / 进程与部署**；不列功能清单。
> 方法：读 `C:\DSH\qwenstuff` 的 7 份 `dsh-qq-*.md` 设计/审计文档 + `findings*.txt` / `audit-out.txt` + `dsh-qq/src`、`dsh-qq/interface-platform`、`icl/`、`focus-core/` 的入口与关键模块，未跑代码、未改旧仓库。
> 证据标记：〔码〕读过源码 ·〔测〕测试/审计输出 ·〔档〕仅文档声称。路径前缀约定：`q/` = `C:\DSH\qwenstuff\`。

---

## 0. 摘要

旧项目在**协议边界**上比第三代（ICL）更简单，在**产品表面**上比第三代复杂得多；两者错位的地方恰好是 ICL 现在的痛点。

- 它的核心机制几乎都是 **50–220 行的纯函数模块 + 注入时钟 + 可选落盘**：注意力状态机 58 行、会话占位 50 行、核心租约 219 行、积压提醒 156 行、错误分类 68 行、健康判定 62 行。没有服务容器、没有事件总线、没有依赖注入，测试是 4–8 个 `assert.equal`。
- 它把 "**运行态**" 收敛成 **6 个可哈希的文件**（`memory.db` / `social-v2.json` / `sessions.json` / `schedule.json` / `core-state.json` / `config.json`），所以能写"全假通道"仿真器，跑前跑后哈希校验、自动还原〔码〕`q/dsh-qq/scripts/sim-scheduler.mjs`、〔档〕`q/dsh-qq-调度核心设计-v2.md:279`。
- 它的失败方式也很清楚：一个 **794 KB / 1.4 万行的 `bridge.js`**、**176 个 `/api/*` 端点**、**98 个散装测试脚本却没有 `npm test`**、**4 个运行模式里有一个是"永远进不去的房间"**、**3 份 24 KB 近乎平行的 preset YAML**、**"补丁层"计划零落地**。

对 ICL 最有用的五件事，按性价比排序：**① 唤醒前拒绝（决策纯函数）**、**② 渐进式提示（首次全量、之后 6 行）**、**③ 单一 JSON 存储原语（版本+迁移+原子写+损坏留证）**、**④ 错误分类表驱动三处渲染**、**⑤ 连续失败计数 + 单文件进程 supervisor**。**不搬**：GUI/176 端点、4 模式、preset 三胞胎、interface-platform、WSL 盒子、98 脚本的测试组织。

---

## 1. 旧项目的运行拓扑与数据流

### 1.1 拓扑（2026-10-26 实测部署态）

```
                    ┌──────────────┐
   手机/群友 ───────▶│  QQ（服务器） │
                    └──────┬───────┘
                           │
              ┌────────────▼─────────────┐   :5099 WebUI
              │ SnowLuma / NapCat（外部）│   :3000 HTTP  :3001 WS(OneBot v11)
              └────────────┬─────────────┘
                           │ OneBot WS
              ┌────────────▼─────────────┐   :3120
              │ interface-platform（可选）│  1873 行 + 689 测试行，抽象 2 个 QQ 后端
              └────────────┬─────────────┘   桥接与平台互不 import〔测〕test-platform ⑥
                           │ WS + HTTP
   ┌───────────────────────▼────────────────────────────────┐
   │ bridge.js（单进程、单实例、:3100 控制台 + 176 个 /api） │  794 KB / 14,279 行
   │  access 准入 → 提及/唤醒判定 → 租约/队列 → 拼唤醒提示   │
   └───────┬───────────────────────────────▲────────────────┘
           │ session.prompt (mode=queue)   │ $events mux（一次订阅，follow 会话）
   ┌───────▼───────────────────────────────┴────────────────┐
   │ DSH 桌面版（profile=desktop，随机端口）                 │
   │ 每 QQ 会话 = 一个 DSH 会话；+1 个"核心会话"（自己的时间）│
   │ 每会话 spawn 3 个 stdio MCP：snowluma(58 工具)/host/搜索│
   └───────┬────────────────────────────────────────────────┘
           │ preset 里的 pwsh/read/write 全部路由进 WSL2
   ┌───────▼──────────┐   ┌──────────────────────────────────┐
   │ WSL2 盒子（8.6GB）│   │ control-center.mjs :3099（launcher）│
   └──────────────────┘   │  spawn/stop/killTree/日志/退避重启  │
                          └──────────────────────────────────┘
```

进程数 5、端口 6（3000/3001/3099/3100/3120/5099）、另有 DSH 侧 3 个 MCP 子进程。**没有**消息队列、没有 RPC 框架、没有数据库服务：进程间只有 HTTP、文件、stdio 三种通道〔码〕`q/dsh-qq/interface-platform/README.md:21`。

### 1.2 入站数据流（一条群消息）

```
OneBot WS 事件
  → 去重 / seq
  → access.js 准入（approved/blocked/pending 三表 + 冷却）
  → attentionState() 判定"现在谁在活"（silent > sleep > group > own-time > idle，5 行 switch）
  → messageDecision() 给出动作：fast-path / nudge / queue
  → noteMessage() 入队（Map，含 mentioned/count/lastText）
  → （需要叫醒时）buildWakePromptV2() 拼提示：身份 + 此刻 + 积压 + 紧急 + "你刚才留下的状态"
  → api.sessions.prompt({mode:'queue'})     ← 唤醒 = 往 DSH 自己的队列投一条
```

关键点：**唤醒与说话是两件事**。唤醒只投一条 prompt；真正发 QQ 由工具调用完成，`onebotSend()` 是唯一出口，`auditAndSend()` 是唯一审计出口〔码〕`q/dsh-qq/src/bridge.js:9136`、`:9696`。

### 1.3 出站

```
$events mux（一条 WebSocket，所有会话共用）→ createTurnCollector（按 turn 聚合）
  → mdToPlain / splitForQQ → auditAndSend（敏感词+审计）→ onebotSend → 平台/SnowLuma → QQ
```

### 1.4 运行态

全部在 `state/` 下：`sessions.json`（会话映射+策略指纹+休眠会话）、`core-state.json`（租约/队列/紧急/跳转/状态更新/提醒/历史）、`schedule.json`、`social-v2.json`、`people.json`、`access.json`、`mode.json`、`memory.db`（sqlite）+ 按天日志 + 令牌〔码〕实读 `q/dsh-qq/state/*.json`。

**其中 6 个就是整套运行时**：`memory.db` / `social-v2.json` / `sessions.json` / `schedule.json` / `core-state.json` / `config.json`——仿真器对它们"跑前跑后哈希校验、被改了就还原"〔档〕`q/dsh-qq-调度核心设计-v2.md:279`。这是 ICL 目前没有的性质：我们的运行态还包含内存里的 delivery 队列与会话绑定，无法枚举。

---

## 2. 它在哪里用更少的概念/更少的层解决了问题

以下 10 条是**模式**，不是功能。每条给行数、给证据、给"它替代了什么"。

### P1 纯函数状态机 + 注入时钟 + 可选落盘（替代"调度服务"）

- `attention.js` **58 行**：`attentionState()` 5 行 if 链定状态，`messageDecision()` 5 行 switch 定动作，`matchWakeWords()`/`detectUrgent()` 纯函数。测试 4 个 case〔码〕`q/dsh-qq/src/attention.js:5-57`、`q/dsh-qq/scripts/test-attention.mjs`。
- `core-scheduler.js` **219 行**：租约 + 队列 + 紧急 + 跳转 + 状态更新 + 提醒，一个闭包，`now` 可注入，`file` 可选。
- `session-slot.js` **50 行**：`acquire/release/current`，租约兜底，`now` 可注入。
- `nudge.js` **156 行**、`dsh-health.js` **62 行**、`ws-watchdog.mjs` **69 行**、`agent-errors.mjs` **68 行** 同理。

替代掉的东西：服务容器、`ctx.service.require`、启动顺序、注册表、生命周期、dispose 协议。代价是"每次调用自己把 `now` 传进去"。

**一个值得抄的细节**：租约**故意不跨重启**——`core-scheduler.js:56-57`「租约不跨重启保留：重启时一律回到"没人活跃"，避免幽灵锁」。ICL 的 `claimSession` + 单实例锁走的是相反方向（HISTORY L1 说三代都栽在这）。

### P2 一个存储原语，所有小状态共用（替代"状态层"）

`lib/json-store.js` **223 行**干完 6 件事：版本号 + 逐版本 `migrations[n]` 函数 + 原子写（临时文件→fsync→rename，Windows `EPERM/EBUSY` 退避）+ 滚动备份（默认 7 份 / 6 小时间隔）+ **损坏文件改名留证再回退备份**（`:154-171`）+ **新版本文件被旧程序读到就拒绝启动**（`:119-124`）。

文件头注释直接写了"为什么不用 SQLite"（原生模块会让 Windows 部署多一个编译环节 / `node:sqlite` 当年是实验特性 / 数据量是"几个群×几百人"）〔码〕`:1-10`。同一原语被 `people.json`、`control.json`、`schedule.json`、`sessions.json`、`access.json` 共用。

### P3 一个出口 + 一个审计点（替代"发送框架"）

- `onebotSend(kind, id, message, replyTo, atUser)`：唯一传输函数。
- `auditAndSend(key, text)`：唯一审计/敏感词入口；MCP 侧**明确不重复实现**（`mcp-snowluma-safe.js:19-24`「出站文本的敏感信息拦截统一由桥接负责…在 MCP 里拦会连"安全拒绝理由"都拿不到」）。
- 桥接的注释把这个当规矩写：`bridge-extensions.js:21`「bridge.js 只 import 这一个模块（入口越少越不容易漂移）」。

对照：敏感词正则 `SENSITIVE_RE` 在 `bridge.js` 里仍出现 19 次〔码〕——**一个出口并不能消灭重复调用点**，这是它的天花板。

### P4 事件优先，push 摘要，绝不让模型轮询（替代"心跳 + status 工具"）

- DSH 侧只有**一条** `$events` mux 订阅（`self-test.js:80` 先订阅、等 open 再 prompt，注释说明"否则 turn 事件可能在连接建立前产生"）。
- 积压不靠定时轮询，靠 `nudge.batch()`：`softMs=10min` / `hardMs=45min` / `cooldownMs=10min` / `maxPerHour=6` / `batchWindowMs=10s`，用 **version 戳**保证"同一批不重复提醒"，预算用滑动一小时窗口，最后 `digest()` 在一个地方生成人话摘要〔码〕`q/dsh-qq/src/nudge.js:89-153`。
- **决策在唤醒之前**：`messageDecision('silent') → 'queue'`，所以静默期根本不会叫醒模型。

这条正是 `findings2.txt:15` 那个真实 bug 的修复方向：「静默模式下…模型会反复被自己的定时器/概率门唤醒，再被静默模式拒绝说话！目前已看到多次无意义烧 token」。**旧项目的答案不是加一层开关，而是把"该不该醒"挪到唤醒动作的上游。**

### P5 错误分类表驱动三处渲染（替代"错误处理规范"）

`agent-errors.mjs` 68 行：5 类正则（credential/quota/rate/model/network）→ `{code, kind, hint, detail, logText}`，然后**一个分类、三个出口**：

- 日志：`[CODE] ` + 脱敏后的前 200 字（抹凭据、抹本机路径、抹会话令牌）
- 群聊（audited）：只给错误码 + "已记录"，不给原文
- owner 私聊：错误码 + 通俗 hint，且 `isConfigError()` 决定要不要限频通知

配套 `dsh-health.js`：**连续 2 次失败才算不可用**（避免 DSH 忙时一次超时刷误报）+ 6 类原因分类〔码〕`q/dsh-qq/src/lib/dsh-health.js:43-61`。

### P6 一个进程原语 supervise 所有子进程（替代 3 套启停）

`launcher/managed-process.mjs` **164 行**：`start/stop`、`killTree`（Windows `taskkill /T /F`，注释说明"只杀外层会留下孤儿"）、stdout/stderr 行缓冲（3000 行环形）、按天落盘、**固定退避重启**（5s×n，上限 60s）、`snapshot()` 给 UI。桥接/平台/SnowLuma 三个都复用它〔码〕`q/dsh-qq/src/launcher/control-center.mjs:29`。

### P7 配置就是文件，谁用谁读（替代"配置服务"）

`mcp-snowluma-safe.js` 每次工具调用都 `loadConfig()` 重新读 `config.json`〔码〕`:29-35`——所以"改配置生效"不需要热重载机制、不需要 IPC、不需要订阅。代价被明确写进运维文档：「改配置 → 重启桥接」〔档〕`q/dsh-qq-部署笔记.md:70`。24 个顶层键 / 9.9 KB，一个 GUI 页面能覆盖。

### P8 提示词的"层"是位置，不是概念（替代"提示词装配框架"）

旧项目只有 4 个 builder 函数，都返回**字符串**：`buildWakePromptV2`、`buildWakePromptV2Core`、`buildWakeReminderPromptV2`（`bridge.js:12149/12199/12298`）、`buildPrompt`（`core-runner.js:68`）。注入点只有 `session.prompt`。没有 order、没有 when、没有预算、没有 maxChars 嵌套。

**其中最好的一条是渐进式提示**：`core-runner.js:161`

```js
const text = (compact && wakeCount > 0) ? buildCompactPrompt(reason, note) : buildPrompt(reason, note)
```

第一次唤醒给全量（身份/此刻/闹钟/积压/紧急/状态更新/怎么动/叙事要求），之后给 5 行紧凑版（时间 + 你在哪 + 令牌 + 一句"要进哪个会话，或者继续等"）。**这正是 E2 里 9.1 万字符重复 runtime-context 的相反做法**〔码〕`q/dsh-qq/src/core-runner.js:144-156`。

### P9 运行态可枚举 → 可哈希 → 可回放（替代 e2e）

`scripts/sim-scheduler.mjs` + `scripts/rehearse-core.mjs`：全假通道（不连 QQ、不连 DSH、不写真实 state），8 个场景（burst/interrupt/private/sleep/silent/stuck/reminder/budget），跑前跑后对 6 个状态文件做哈希校验，被改就还原并报数量〔档〕`q/dsh-qq-调度核心设计-v2.md:256-293`。

这是"没有 e2e 也要有证据"的一个可行替代——前提是**运行态小到可以枚举**（见 §1.4）。

### P10 单进程 + 单实例，把"并发"降级成"租约"

桥接是单进程单实例（第二个实例立刻退出并提示"已有实例在运行"，`部署笔记:38`）；同一时刻只有**一个** DSH 会话持租约说话（`maxConcurrentTurns=1` + 30 分钟兜底，`审计报告:27`）；租约 TTL 30 分钟、最长 60 分钟、到期强制收回并标 `abnormal`。

所以整个系统里**没有锁、没有事务、没有并发数据结构**：所有"同时"都被降级成"先到先得 + 到期回收"。旧项目为此付的代价是"别的群会饿死"（须靠 nudge / 预算 / 防饿死补，`调度核心设计.md:128`）。

---

## 3. 与现行 ICL 对照：哪些复杂度是我们自造的，哪些是 DSH 约束

ICL 现状（实读，非文档）：`packages/core` 2117 行 / `services.mjs` 797 行 / **13 个服务** / **22 个插件**（`ARCHITECTURE.md:31` 仍写 16 个，实际 `packages/plugins` 下 22 个目录、22 份 manifest、16050 行）/ manifest 合计声明 **71 个工具** / **5 个装配面** / `packages/` 里 **10 处 `setInterval`（8 个文件）**。

### 3.0 先量一下"一代比一代小"这个说法

三代生产代码（不含测试、不含 `node_modules`、不含 `tools/`）：

| | 文件 | 行 | 测试 | 备注 |
|---|---|---|---|---|
| dsh-qq（`src`） | 81 | **29,428** | 98 个 `scripts/test-*.mjs` / 13,580 行 | 其中 `bridge.js` 一个文件 14,279 行（占 48%） |
| focus-core（`apps`+`plugins`） | 174 | **20,299** | 50 个 `*.test.mjs` | 形态是 Web 应用：`routes/` + `domain/` + `state/` + `ui/views`，最大文件 43.7 KB 的 `routes/core.js` |
| icl（`packages`） | 90 | **28,558** | 88 个 `*.test.mjs` / 14,236 行 | 另加 `tools/` 47 个脚本、`packages/plugins` 22 个插件 / 16,050 行 |

**ICL 并不比旧桥接小**：28.5k 行 vs 29.4k 行，测试/生产比也接近（0.50 vs 0.46）。差别在**形状**：旧的是一个 14k 行文件 + 80 个小文件；我们是 22 个插件 + 13 个服务 + 5 个装配面。**"拆得更整齐 ≠ 更少"**（HISTORY L2 已经说过一次，这里是数字）。

> 注意两棵树的差异：`C:\DSH\qwenstuff\icl` 是 **2026-10 的旧快照**（9 个 core 文件 / 16 个插件 / `services.mjs` 609 行 / 无 `dsh-icl` 包），`docs/ARCHITECTURE.md:31`「16 个插件」正是那份快照的描述；本节的数字取自 `C:\DSH\icl` 当前代码。**文档比代码落后一整代**——这本身是第 5 节那条"文档必腐"的证据。

### 3.1 自造的（旧项目证明可以不这样）

| # | ICL 现在的做法 | 旧项目的做法 | 判断 |
|---|---|---|---|
| 1 | `delivery` 服务：内存队列 + ack/nack + 5 次退避 + watermark + exactly-once + `pendingCount/inflightCount/droppedCount`，由 **500ms tick**（`dsh-icl/src/bridge.mjs:585`）和 **1000ms 泵**（`core/src/session.mjs:78`）推进 | 直接把一批文本 `sessions.prompt({mode:'queue'})` 交给 DSH 自己的队列，只在外部记"待唤醒原因"并 replay | **自造了一个队列去喂另一个队列**。DSH 有 inbox 队列（`session/updateQueue` 可移除，见 `q/dsh-qq/src/dsh-client.js:456-486`） |
| 2 | 5 个装配面（prompt / context / turnText / tools.index / 工具描述），5 套排序 + 5 套预算 + 截断规则（`ARCHITECTURE.md:100-141`） | 4 个 builder 函数返回字符串，注入点 1 个 | 大部分是自造；只有"工具描述要拼 Use when/Avoid when"是产品需要 |
| 3 | 13 个服务 / 44 导出，其中 `focus`、`presets`、`delivery.drain` 无第二使用者（HISTORY L2 自己承认） | 纯函数模块，没有服务注册 | 自造。判据应是"有没有第二个使用者" |
| 4 | 两套能力表：`host.services`（13 个）与 `ctx.services`（`host.shared`），`ARCHITECTURE.md:96` 记录"`time` 里 `require('signals')` 的兜底分支必然抛错" | 只有一种：函数参数 | 自造，而且已经在骗人 |
| 5 | 工具面三张表：`manifest.tools` 声明 / `tools` 注册表 / `presets.allow` 过滤 | 工具定义在 MCP server 里（58 个），preset 用 `denyTools` 做减法 | 各有代价；旧的更笨但更少机关 |
| 6 | 每会话一份实例 + `claimSession` + 单实例锁（HISTORY L1） | 单进程 + 单实例 + 租约，"并发"被降级 | 自造（三代重复的病） |
| 7 | `tools/` 47 个评测脚本 + lab preset 白名单（27 工具 / 21,459 字符 `c91bce1e703b`）组成**第二套运行配置** | `sim-scheduler` 只有一个：显式 `--scenario`，状态文件哈希校验 | 一半自造：lab 的复杂度没有折算回产品 |

### 3.2 DSH 的约束（不该当成我们的设计错误）

- **提示词/工具只能经 `ctx`**：`tools.register` / `systemPrompt.section` / `agent/pre-step` / `session/event`。没有"直接发一条 user 消息"的官方口子；等价物是 `agent.steer`（plugin-source notice）。旧项目用 `sessions.prompt` 伪造 user 消息，代价是模型分不清"人说的"和"环境说的"——E2 里真人 5.1k 字符 vs 环境 116k 字符就是这个后果。**我们选 steer 是对的。**
- **runtime-context 的 DSH 样板无法按 context 关闭**：`includeRuntimeContext:false` 是全局 suppress，会把 `icl:facts` 一起抹掉；context 注册项没有 `required`/豁免机制（实测 ≈514 字符/快照）〔码〕`docs/COMPLEXITY-AUDIT.md:193`。
- **preset / bundle patch 在 profile 层**，改完必须重启 DSH〔档〕`q/dsh-qq-部署笔记.md:84`、`q/dsh-qq-路线图.md:147`。这也是旧项目把 15 条工具协议塞进 24 KB YAML 的原因（它没有别的注入点）。
- **Web API 的形状会漂**：0.1.7 的 `value.queues[]` → 0.2.0 的 `session/projections`，旧项目为此付过一次"队列清不掉、旧任务继续烧 token"的事故〔码〕`q/dsh-qq/src/dsh-client.js:498-501`。我们在 bridge 里迟早也会遇到同类漂移。
- **一个会话同一时刻只有一个 turn**：所以真正的并发问题 DSH 已经解决；我们的 slot/lease 只是补"多入口/多会话共用一份运行时"。
- **鉴权**：launch token 只能进 URL query、只能发回环；minted cookie 是纯本地 HMAC（`dsh-client.js:391-446`）。这些是硬约束，抄进注释比抄进代码更有用。

---

## 4. 可搬的最小改动清单（按 成本/收益 排序）

> 判据：改动 ≤ 1 个文件 / ≤ 100 行能落地；能在一个 lab run 里被观测到。收益主要引 E2 实测数字（`docs/COMPLEXITY-AUDIT.md`）。

### A. 唤醒前拒绝：把"该不该醒"收成一个纯函数 ★★★★★

- **搬什么**：`attention.js` 的形态——一个 `attentionState(inputs) → 状态`（if 链，优先级写死）+ 一个 `messageDecision(state) → 动作`（switch），5 个状态、4 个动作。所有 `sleep / silent / budget / cooldown / urgent` 判定在**叫醒动作之前**完成，返回"队列/丢弃/叫醒"三选一。
- **放哪**：`packages/plugins/time` 的 tick 之前，或 `dsh-icl/src/bridge.mjs` 的 `notice()` 入口。
- **收益**：直接命中 C3（43 条"清醒节拍"→ 2 分钟静止 ×≥10 段、20.7 分钟）与 findings2 的静默期烧 token。旧项目用 58 行替代了整个"唤醒策略"。
- **成本**：1 个新文件 + 3 处调用点 + 4 个 case 的测试（旧 `test-attention.mjs` 38 行，可直接照抄结构）。

### B. 渐进式提示：首次全量，之后 ≤6 行 ★★★★★

- **搬什么**：`(compact && wakeCount > 0) ? buildCompactPrompt() : buildPrompt()`（`core-runner.js:161`）。ICL 对应物是 facts 快照 + eager-recall + time/mc 事件三条注入路径；给每条路径一个"本轮已注入过 → 只给变化行"的开关。
- **收益**：E2 实测 runtime-context 90,977 字符 / 134 条（2.5 条/轮，cache 规则 ≤1）；B 方案不动 DSH 样板也能砍掉重复主体。
- **成本**：每路径一个 `wakeCount` 计数 + 一个 5 行文本函数。**这是本清单里唯一"纯加法、不改契约"的项。**

### C. 单一 JSON 存储原语（版本+迁移+原子写+损坏留证） ★★★★

- **搬什么**：`lib/json-store.js` 的 6 件事，尤其"**损坏文件改名留证、绝不覆盖**"和"**旧程序读到新版本文件就拒绝启动**"这两条。ICL 现在有 `state/` 里多份 JSON（cache 指纹、freeze、lab run meta、产品面快照）各自 `JSON.parse/stringify`。
- **为什么值得**：E2 与几次长跑都出现过"状态文件半截/字段漂"的问题；旧项目把这一类 bug 变成 223 行不可能写错的代码。
- **成本**：拷 1 个文件 + 逐个存储点换 3 行。**注意**：内存态（delivery 队列、session 绑定）不要搬进来——旧项目的教训正是"持久化的东西越少越好"。

### D. 错误分类表 + 三处渲染 ★★★★

- **搬什么**：`agent-errors.mjs` 的表驱动（kind → hint）+ 三个出口（日志脱敏 / 面向用户 / 面向 owner）。ICL 对应面是 **mcb_do 的 92 个错误**：`mine: no-target` 只有 22 字符、无下一步，而 `no-path`/`place` 有提示——**同一层的错误文本质量参差**（`COMPLEXITY-AUDIT.md:56`、`:113`）。
- **收益**：把"错误散文"变成"kind + 下一步"，同表产出报告分类计数（现在要 grep 日志手数）。
- **成本**：1 个表 + 3 个渲染函数；`mcb_*` 所有 error 构造点改调 `describeToolError()`。

### E. 连续失败计数 + 单文件进程 supervisor ★★★

- **搬什么**：`dsh-health.js`（连续 2 次才判死 + 6 类原因）与 `managed-process.mjs`（killTree / 环形日志 / 按天落盘 / 固定退避重启 / snapshot）。
- **为什么**：lab 长夜跑 MC 时，`watchdogTimer`（`mc-link/body.mjs:1322`）与 lab 自己的 alive 文件是**两套**存活判断；旧项目只有一套。
- **成本**：若要动 lab 的进程管理，200 行；若只搬健康判定，62 行。

### F. 具名回归断言写在具名导出上 ★★★

- **搬什么**：不是测试框架，是习惯——"把解析逻辑抽成具名导出，让测试直接钉住"（`dsh-client.js:488-501` 的注释把这条写成了规矩，并记了违反它的那次事故）。ICL 的 `contracts.mjs` / `composeToolDescription` 已经是这个形状，继续即可；**新代码里凡是 `JSON.parse` DSH 响应的地方都应该有具名导出 + 一条回归**。

### 明确不搬（及理由）

| 不搬 | 理由 |
|---|---|
| 176 个 `/api/*` + 6444 行单页控制台 + 3099/3100 两个 UI | ICL 故意无 GUI；且旧 GUI 只能靠 Playwright 断言（本机跑不了），是"不可测表面"。要做也应是只读投影，不是控制面。 |
| 4 个运行模式 / L0–L3 / 审批 / TOTP | `模式地图 §4.1` 证明 `closed-agent` 是"永远进不去的房间"；98 处 `closed-agent`、66 处 `approval` 引用全部不可达却仍在编译与测试。这是**净负债**的教科书案例。 |
| 3 份 24 KB 近平行 preset YAML + 生成器 + 契约测试 | 那是"DSH 只认 profile 层 patch"逼出来的。ICL 的 22 份 manifest 已经更细；再叠一层 preset 会多一个装配面。 |
| interface-platform（1873 行 + 689 测试行） | 只有 1 个 QQ 后端时是纯成本；它的收益（NapCat）我们不需要。若将来要第二个后端，宁可**在 qq 插件内部**做一个 50 行的 connector 表。 |
| WSL2 盒子 | 8.6 GB + 一次 ACL 事故（`部署笔记 §6.5`：`icacls /inheritance:r` 先把继承 ACE 摘光、再删子项 → 目录变成谁都进不去）。 |
| 98 个 `test-*.mjs` 的组织方式 | 见 §5。要搬的是"每个事故一条具名回归"，不是"每个功能一个散装脚本"。 |
| `bridge-extensions.js` 式聚合门面 | 它确实减少 import 漂移，但它变成了 360 行的杂物间；ICL 的 `contracts.mjs` 已在做同样的事且更窄。 |

---

## 5. 旧项目测试不足 / 乱麻的证据

**规模**：`dsh-qq/src`+`scripts`+`plugins` 227 个文件 / 49,681 行；其中 `test-*.mjs` **98 个 / 13,580 行**，另有 11 个 `probe-*.mjs`〔码，实点〕。

1. **没有 `npm test`**。`package.json` 有 59 条脚本，其中名字以 `test` 开头的 32 条（`test:` / `test-xxx` / `test-voice:gui`…命名三套混用），其余是 `verify:*` / `probe:*` / `sim:*`；98 个测试文件里只有一部分在审计套件里〔码〕`q/dsh-qq/package.json`。
2. **审计套件是手写清单**：`scripts/test-audit.mjs` 末尾是一个数组，`spawnSync` 逐个跑、`timeout: 60000`、靠退出码计数。清单会腐烂——审计报告自己记着"`test-audit.mjs` 仍登记着已删除的 `test-agent-readonly-guard.mjs`"（`审计报告:64`，标 ✅ 已修，但机制还在）。
3. **断言风格三套并存**：54 个文件 `import test from 'node:test'`、4 个自带 `function assert`、其余直接 `console.log` + 看输出〔码，按 import 统计〕。
4. **不 hermetic**：`audit-out.txt` 151 PASS / 0 FAIL，结尾却是 `57/60 scripts passed`〔测〕；3 个"失败"是环境的——控制中心测试撞上本机真 SnowLuma（端口 5099）、`test-platform` 写死 Node 老版 TAP 格式（Node 26 改 spec）、`test-mac-app` 断言 LF 但仓库是 CRLF〔档〕`q/dsh-qq-部署笔记.md:153-159`。**测试结论依赖本机在跑什么、Node 哪个版本、git 检出时换行符是什么。**
5. **端到端从未成立**：调度核心 v2 标 79/79 全绿，同时写「真实 QQ 消息闭环尚未跑过（需在群里发一条消息验证 nudge→enter→status→reminder）」〔档〕`q/dsh-qq-调度核心设计-v2.md:252`。全绿与"没验过"同时存在，是"单测替代 e2e"的典型症状。
6. **替代品做得不错，但也说明 e2e 缺位**：`sim-scheduler`（8 场景 + 哈希回滚）与 `rehearse-core`（只调模型 API、不建 DSH 会话）是**好办法**——值得搬到 ICL 的 lab；它们的存在本身是"没有真链路"的补丁。
7. **静默失败 103 处**：`bridge.js` 271 个 `try`，其中 103 处是空 `catch {}`（含 `catch { /* ignore */ }`）。"不炸"的策略换来"不知道坏了"——旧项目的日志文化是"出错就 `log()`"，但 103 个空 catch 绕过了它。
8. **不可 review 的工件**：`bridge.js` 794 KB / 14,279 行；审计只能靠"grep 残留关键词"（`审计报告` 反复用 `git diff --stat` + 全文 grep 证明"无引用"）。一个 24 KB 的 YAML 里塞着 15 条工具协议（`qq-chat-tools.patch.yml`），任何 diff 都不可读。
9. **UI 无自动化**：`console.html` 6444 行、120 个 `api()` 调用点、`setInterval(..., 3000)` 轮询刷新；`test-console-ui.mjs` 依赖 Playwright，"本机跑不了（启动即失败），审计套件未收录"（`审计报告:174`）。
10. **"补丁层"零落地**：`魔改设计 §3` 规划了 `dsh-qq-mod/`（presets + gate 插件 + 3 个 bridge-patch + memory 实现）以保持上游可 `git pull`；实际 `dsh-qq-mod/` 只剩 `README.md` + `tools/*.mjs`，所有改动直接落在 fork 里（33 文件 +948/−993 + 12 新目录，`审计报告:11`）。**计划一层、落地零层**——这是"为可维护性设计的层，最后没人维护"的实例。

### 对 ICL 的直接含义

- ICL 有 `npm test` 和 22 份 manifest，**基础比旧项目好**；但连基线都过期了——README 仍写"193 通过 / 43 文件"，而 `packages/` 下现在有 **88 个 `*.test.mjs` / 14,236 行**。另外 47 个 `tools/*.mjs` 正在长成旧项目那 98 个 script 的形状（"每个疑问一个脚本"）。建议只保留 `lab.mjs` / `replay.mjs` / `wire-check.mjs` 这类**有明确入口和失败语义**的，其余并入测试。
- ICL 的缺口不是"测试少"，而是**没有一条能自动跑完的真链路**（README 自己写：端到端只有两轮 5 分钟）。旧项目至少把"6 个状态文件 + 8 个场景 + 哈希回滚"做成了可重复的证据——这是本清单里最该先搬的东西之一。

---

## 6. 证据索引（一处一条，可复核）

| 结论 | 证据 |
|---|---|
| 单进程 / 5 进程 6 端口 / 无中间件 | `q/dsh-qq-部署笔记.md:10-24`；`q/dsh-qq/interface-platform/README.md:21` |
| 176 端点 / 271 try / 103 空 catch / 14,279 行 | 实测 grep `q/dsh-qq/src/bridge.js` |
| 会话映射 + 策略指纹落盘 | 实读 `q/dsh-qq/state/sessions.json` |
| 租约/队列/紧急/跳转/状态更新 | 实读 `q/dsh-qq/state/core-state.json`；`q/dsh-qq/src/core-scheduler.js:56-57` |
| 唤醒决策纯函数 | `q/dsh-qq/src/attention.js:5-30`；`q/dsh-qq/scripts/test-attention.mjs` |
| 积压批处理 + version + 预算 | `q/dsh-qq/src/nudge.js:89-153` |
| 渐进式提示 | `q/dsh-qq/src/core-runner.js:144-166` |
| 单一存储原语 | `q/dsh-qq/src/lib/json-store.js:1-223` |
| 错误分类三出口 | `q/dsh-qq/src/lib/agent-errors.mjs:17-68` |
| 连续失败判定 | `q/dsh-qq/src/lib/dsh-health.js:43-61` |
| 进程 supervisor | `q/dsh-qq/src/launcher/managed-process.mjs` |
| 唯一发送 / 唯一审计 | `q/dsh-qq/src/bridge.js:9136`、`:9696`；`q/dsh-qq/src/mcp-snowluma-safe.js:19-24` |
| DSH 形状漂移事故 | `q/dsh-qq/src/dsh-client.js:488-501` |
| 仿真器 + 哈希回滚 | `q/dsh-qq-调度核心设计-v2.md:256-293` |
| 死模式 / 死引用计数 | `q/dsh-qq-模式地图.md:67-99` |
| 补丁层计划 vs 现实 | `q/dsh-qq-魔改设计.md:191-211`；`q/dsh-qq/审计报告.md:11` |
| 测试不 hermetic | `q/audit-out.txt`（151 PASS / `57/60 scripts passed`）；`q/dsh-qq-部署笔记.md:153-159` |
| 静默期烧 token | `q/findings2.txt:15` |
| ICL 5 装配面 / 13 服务 / 双能力表 | `docs/ARCHITECTURE.md:76-141` |
| ICL 自造复杂度 / 自造队列 | `docs/COMPLEXITY-AUDIT.md`；`packages/dsh-icl/src/bridge.mjs:585`；`packages/core/src/session.mjs:78` |
