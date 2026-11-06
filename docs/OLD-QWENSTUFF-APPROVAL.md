# 旧项目复盘：免对话框的「自然语言审批」

> 范围：只读研究 `C:\DSH\qwenstuff`（2026-10-21 → 10-26 的 dsh-qq 魔改），未改动旧项目任何文件。
> 证据标记：〔代码〕读过源码 ·〔实测〕有运行/测试记录 ·〔文档〕仅文档声称。
>
> **结论先行**：这个设计真实存在过（P5，2026-10-22 定稿），机制完整、有安全考量，也接过线；
> 但它降低的是**界面摩擦**，不是系统复杂度。项目自己的轨迹就是反证：两天内权限模型改了三轮
> （L1–L3 → 闸门 + 开闸 → 零审批 + WSL 盒子），最后把整套审批删掉，第三代明确写「审批体系不继承」。

---

## 0. 一句话机制

危险调用被闸门 **`deny`（不是 `ask`）** → 模型用自己的话说明目的 → 调 `qq_wait_for_messages`
在**同一个 turn 里**等人 → owner 在群里 @ 她说「行，你搞吧」→ 桥接**机械匹配**词表后写一张
180 秒 / 20 次调用的 **grant** → 模型同 turn 重试通过 → 本轮结束 / 超时 / 收闸词关闭。
全程没有 DSH 审批卡片、没有「审批 #n」模板，只有一条回执「（已开闸 · 本轮有效）」。

---

## 1. 旧审批交互的具体机制

### 1.1 先分清两套并存的东西

旧项目里「审批」有两个同名不同物的实现，混在一起看会得出错误结论：

| | A. 编号模板审批（上游 v0.3.0 遗产） | B. 自然语言开闸（P5/P14，本报告主角） |
|---|---|---|
| 入口 | DSH `approval/requested` 事件（桥接侧事件名） | 工具被闸门 `deny` 后模型主动开口 |
| 消息形态 | 「🔐 审批 #n：工具 + 脱敏参数」 | 模型自己的聊天句子 + 一次回执 |
| 回复语法 | `通过 #n` / `拒绝 #n`（单挂起时可裸回） | 任意自然语言 + 开闸词（`行，你搞吧`） |
| 授权粒度 | 一次调用（`allowed-once`） | **会话级时间窗 + 调用预算** |
| 状态 | `approvals.js` 多槽登记表、单调编号、5 分钟超时 | `state/grants.json` 的 `{expiresAt, remainingCalls}` |
| 现状 | 代码仍在，但**无触发路径**（见 §1.5） | P21 已整体删除 |

A 的实现仍在：[approvals.js](../../qwenstuff/dsh-qq/src/admin/approvals.js) 头注释写得很清楚——
编号全局唯一、跨重启不复用、绑定 `callId` 参数、超时自动 `rejected`、**模型没有任何能 `decide()` 的接口**，
「AI 说已经批准了」无效。桥接侧接线在 [bridge.js:13894-13928](../../qwenstuff/dsh-qq/src/bridge.js)。
这套东西其实比 B 更可观测，后来被 P15/P19 判死：群聊审批自动 `rejected`，私聊因 `danger-full-access`
DSH 永不发请求（[dsh-qq-mod/README.md:87,91,104-112](../../qwenstuff/dsh-qq-mod/README.md)）。

### 1.2 B 的完整链路（触发 → 自然语言确认 → 执行 → 审计）

1. **触发**：`tools/pre-execute` 闸门在 `grant`/`locked` 档返回
   `{kind:'deny', reason:'用一句话说明目的 → qq_wait_for_messages(300000) 等他 → 他同意后重试 → 他说不行换个做法'}`。
   关键选择：**不用 `ask`**。`ask` 会走 DSH 审批通道（→ 模板），`deny` 把控制权交回模型，界面才「无感」。
2. **自然语言确认**：模型在群里正常说话，并调 `qq_wait_for_messages`（turn 内长轮询，管理员回复在同一 turn 返回）。
   桥接的 `ownerGrantIntent` 做**纯机械判定**，四条全满足才开：发送者 `== ownerQQ`；正文 @ 了她（或引用她的消息）；
   命中开闸词表；不含否定词。词表含 `开闸/放行/你搞吧/你可以搞/批准本轮/干吧/上吧`。
3. **开闸**：写 `state/grants.json[sessionId] = { expiresAt: +180s, remainingCalls: 20 }`，
   群里回执「（已开闸 · 本轮有效）」。
   **刻意不把「你已获授权」注入模型上下文**——否则她会说「好的老板我这就去」，破坏自然感，还会诱导她主动要权限。
4. **执行**：下一次 `pre-execute` 命中 grant → `allow`，递减 `remainingCalls`，记账到 `state/grants/<key>.calls.jsonl`。
5. **收口**（任一）：本轮 turn 结束 / 180 秒超时 / owner 再 @ 说「停/暂停/别搞了」→ 删 grant 并 `session/cancel` 兜底。
   另有逐会话覆盖 `session-overrides.json`，**必须带 `expiresAt`**（默认 2 小时）才生效。
   判定顺序在 [dsh-qq-魔改设计.md:319-334](../../qwenstuff/dsh-qq-魔改设计.md) 有完整九步，且强调
   「`locked` 必须在 `denyTools` 之前」——否则朋友私聊会收到「开闸也许行」的误导文案，让她一直惦记。

〔文档〕这套在 [dsh-qq-魔改设计.md:47-83,139-176,286-346](../../qwenstuff/dsh-qq-魔改设计.md)；
补丁清单在 [dsh-qq-mod/README.md:74,86,89](../../qwenstuff/dsh-qq-mod/README.md)。

### 1.3 它到底「免」了什么

- **免掉了**：DSH 审批弹窗/卡片；QQ 里的模板化审批消息；`通过 #n` 这种机器语法；控制台的「待审批」队列。
- **没免掉**：机器仍然要一次显式授权；回执仍是格式化文案；owner 仍要读一段解释再回一句；
  审批这个概念没有消失，只是换了载体。
- **私聊更彻底**：[魔改设计.md:163-176](../../qwenstuff/dsh-qq-魔改设计.md) 直接 `mode: open` 全放行，
  只留两条启发式刹车（凭据文件、`format/diskpart/shutdown/rm -rf /` 之类不可逆命令），
  并明确写「这是尽力而为的刹车，不是安全边界（shell 能绕过），真正的边界是管理员本人在场」。

### 1.4 四类风险控制，逐条评估

| 目标 | 旧做法 | 实际强度 |
|---|---|---|
| **防误批** | owner 身份 + 必须 @ + 词表 + 无否定词 + 180s 窗口 + 20 次预算 + 收闸词 + 回执 | **中偏弱**。grant 是**预授权**，不绑定任何 pending 操作：owner 随口一句「行，你搞吧」也会开窗；批准的是「接下来 180 秒最多 20 次调用」，不是她描述的那一件事。词表里 `干吧`/`上吧` 过宽 |
| **防注入** | 决策在桥接侧、消费真实 QQ 消息，注入文本不能直接开闸；窗口期有限；凭据/不可逆命令刹车 | **弱**。两个缺口：(a) 窗口期内注入内容可搭便车；(b) 要批准什么由**模型自己描述**，注入可让它说错。文档承认此风险，一阶段缓解只有「开闸只放读 + 网络」 |
| **防重复** | per-session grant 覆盖写；`remainingCalls` 递减；TTL；turn-end 关闸；收闸词 + `session/cancel` | **中**。对「手滑连点/重复回一句」够用。没有 per-action nonce，同一句话重复回也就是同一张 grant |
| **防自批** | 模型没有 grant 接口，只有真实 owner 消息能触发；`approvals.js` 同一原则：AI 说批准无效 | **强**。这是该设计最扎实的一条 |

**未见验证**：`grants.json` 是落盘的，桥接重启后窗口是否继续有效，文档没写、也没测试。

### 1.5 生命周期：它为什么只是「构思过」

P5（10-22）deny + 自然语言 → P14 owner @ + 词表 grant → P17 三档 + 预算 + 逐会话覆盖 →
P15/P19 群聊永不转 DSH 审批、全系统不再有审批模板 → **P21（10-23 晚）整套闸门/grant/三档删除**，
换 WSL 盒子 + 零审批。最终面向用户的文档写的是「不再有审批」
（[dsh-qq-使用说明.md:8,16-18](../../qwenstuff/dsh-qq-使用说明.md)、
[dsh-qq-沙箱盒子设计.md:17,236](../../qwenstuff/dsh-qq-沙箱盒子设计.md)：审批一栏直接写「取消逐次审批；
只在提示词里保留软闸门」，并承认代价是「危险操作不阻断，靠回滚兜底」）。

---

## 2. 与 DSH 现行 approval / 我们 sandbox 计划的 A/B

现行事实来源：[dsh-user-approval README](../../icl/node_modules/@deepseek-ai/dsh-user-approval/README.md)、
[SANDBOX-PLAN.md:177-222,445-453](./SANDBOX-PLAN.md)。核心：`ask`/`never` 两种 policy；
请求只带 `agent/toolName/callId/reason`；结果是封闭四态 `allowed-once|rejected|cancelled|unavailable`；
只有一次性授权，**没有 allow-always / 记住规则 / 撤销 / grant 存储**；请求只在未结束的 turn 内有效；
`approval/asked` 与 `approval/decided` 成对入审计；没有应答者就 `unavailable` 失败关闭。

| 维度 | 旧：自然语言开闸 | 新：DSH approval + 我们的 sandbox |
|---|---|---|
| 策略源 | 1 个闸门，但叠了 3 档 mode + grant + session override + 组策略 | 2 个正交旋钮：sandbox mode + approval policy |
| 概念数 | ≈10：gate、3 档、词表、否定词、TTL、调用预算、回执、收闸词、override、capability 注入 | ≈6：policy、request 字段、4 结果、answerer waterfall、审计对、`sandbox_permissions`+`justification` |
| 状态数 | `mode{open,grant,locked}` × `grant{none,active(ttl,budget),revoked}` × override 到期，组合爆炸 | `policy{ask,never}` × `outcome{4}`，turn 内一次性，无存储 |
| 授权粒度 | **会话级时间窗 + 次数预算**（她可以拿这张券干 20 件事） | **单次调用**，绑定 `callId`；重试一次就废 |
| 用户操作步骤 | 3–4 步：读她的解释 → @ + 说一句 → 等回执 →（可能反复） | 1 步：点一次 / 回一句「行」 |
| 实现复杂度 | 改 `bridge.js`（1.3 万行）+ 闸门插件 + wait 工具 + 两个状态文件 + 控制台接口 + capability 注入 + debug log；两天三轮重写后全删 | 服务已存在；我们只加一个 answerer（SANDBOX-PLAN 估 2–4h） |
| 失败模式 | 模型不照 deny reason 走、turn 提前结束导致批准丢失、窗口期误执行、反复催权限（实测发生过） | 无应答者 `unavailable`、超时 `cancelled`，有界；不悬挂（前提：自带超时） |
| 可观测性 | `grants.json` + `calls.jsonl` + gate debug log + audit；但**没有「这次批准 ↔ 这次调用」的绑定** | `approval/asked` + `decided` 成对 + `callId`；参数需 join `tool/call`（这点两边都要补） |
| 测试 | 54 项纯逻辑 + 9 项 e2e，**均已删除**；模型行为 0 测试 | service 有契约；SANDBOX-PLAN 有 A3/A4/A8/A13/A14 验收 |

**判断**：把「审批弹窗」换成「聊天里说一句」，用户侧确实更顺；但系统侧多了一整套
**提示词驱动、跨 turn、无绑定的策略机**，还要和 DSH 自己的 approval 并存。**净复杂度是升的，不是降的。**

三个具体代价：

1. **丢掉原子性与绑定**。`ask` 是把**这一次调用、这一组参数**挂起等回答；deny→重试是让模型
   「过一会儿再发一次」，参数可能变、turn 可能结束、同一件事可能被拆成多步绕过描述。
2. **让被审者写审题**。用户看到的是模型自己的话，而模型正是想执行这件事的一方；这是提示注入的天然放大器。
3. **多一个真源**。DSH 已经有 policy + 审计 + 失败关闭，旧设计又造了一份 grant 状态，
   于是「谁说了算」需要靠顺序（⑥ 在 ⑦ 前）和文档来维持——[魔改设计.md:332-334](../../qwenstuff/dsh-qq-魔改设计.md) 自己就在解释这种顺序坑。

---

## 3. 可借鉴的最小设计（不搬整套）

原则：**审批策略仍然只有一套（DSH）；自然语言只做「应答通道」和「呈现方式」，不做第二套 grant。**

### 3.1 一个 answerer，自由文本进、四态出

- 在 `ctx.on('approval/request')` 里组装**一条人话消息**：工具名 + **服务端按 `callId` 取到的原始参数**
  （脱敏、截断）+ 一句影响说明 + 「回『行』执行一次 / 『算了』放弃 / 2 分钟不回自动取消」。
  **不能只转述模型写的 `reason`**——SANDBOX-PLAN §2.5 已点明 justification 不可信。
- 自由文本映射只作用于**回答解析**，不改变授权范围：
  - yes：`行/可以/搞吧/同意/批准/ok/yes` → `allowed-once`
  - no：`算了/别/不行/不要/拒绝/no` → `rejected`
  - 含糊：追问一次；再含糊 → `cancelled`
- 绑定与去重照抄旧项目**做得好的那部分**：单个待审批队列、单调 id、非 owner / 非本会话 / 过期 id 一律拒绝并审计、
  120 秒超时 `cancelled`、无应答者 `unavailable`。这些在 [approvals.js:142-156](../../qwenstuff/dsh-qq/src/admin/approvals.js) 已有现成形状。

### 3.2 怎么做到「不突然弹框」

1. **预告，而不是突袭**：模型在可能越界前先用一句话说「我接下来要在工作区外写 X，可能要你点个头」；
   真正请求到来时用户已有心理准备。
2. **留在会话线程里**：批准请求作为一条普通私聊消息出现，不回 UI、不切窗口、不抢焦点。
3. **渠道互斥而不是抢占**：`approvalChannel: desktop | qq` 显式配置。不要用 `prepend` 去盖过网关——
   SANDBOX-PLAN §2.6 已指出 `prepend` 会让桌面 UI 卡片直接看不到，且 waterfall 顺序未测。
4. **不打断输入**：用户刚发消息/正在打字时，请求先排队，等本轮结束再发；始终只有一个待审批。
5. **结果可回溯**：批准后在原线程回一句「已执行 / 已取消」，并落 `approval/decided` 审计。

### 3.3 明确不搬

- 开闸词表、预授权窗口、调用预算（= 会话级 ambient grant）
- 第二个 policy 源、第二份 `grants` 状态文件
- 让模型自己描述「要批准什么」并作为唯一依据
- 「批准本轮」语义：用户以为批准了一件事，实际批准了 20 次
- 用 deny→重试 替代 ask：失去 callId 绑定，且多步操作可能变形
- 把「防催权限」交给记忆/上下文「自然承载」（旧项目试过，结论是不做，然后实测中真的被催到停桥接）

### 3.4 如果确实嫌打扰

可以在 approval 服务**内部**做一个显式的、按 turn 的 `(agent, toolName, args-hash)` 允许缓存，
由用户主动点「本轮别再问这个」生成，turn 结束即失效。这是一个**新状态**，必须同时给审计与撤销入口；
DSH 当前没有 allow-always，不要假装有。**不要**为此外挂第三个 gate。

### 3.5 最小验收（7 条）

1. `行/同意/ok` → 执行一次；`算了/不行` → 不执行；含糊追问一次后 `cancelled`。
2. 同一请求重复回答只生效一次；旧 id / 跨会话 / 非 owner 一律拒绝并留审计。
3. 120 秒无回答 → `cancelled`，turn 继续，不悬挂。
4. 无应答者 → `unavailable`，工具不执行。
5. 群聊里任何非 owner 的「行」都不能批准；owner 在别的会话说「行」也不能。
6. 展示内容含真实参数（不是只有 justification），且脱敏。
7. 断线/重启后不存在「幽灵窗口」：未决请求一律 `cancelled`/`unavailable`。

---

## 4. 旧项目测试不足的证据与风险

### 4.1 证据

1. **唯一的 gate 测试被删且没有替代**。〔文档〕[dsh-qq-mod/README.md:134-135](../../qwenstuff/dsh-qq-mod/README.md)
   声称 `check-gate.mjs` 54 项 + `test-permissions-e2e.mjs` 9 项；P21 后这两个文件在整棵树里
   **0 命中**（本次 `Get-ChildItem -Recurse` 验证），98 个 `test-*.mjs` 里没有一个覆盖
   `deny → wait → grant → 重试` 这条链。
2. **现存审批测试只测那套已死的模板系统**。〔代码〕`test-audit.mjs:91-94` 讲的是
   「确认码状态机 / 审批编号 / 审批绑定参数」；`test-reply-wait.mjs` 测的是 wait 的静默窗口，不是审批语义。
3. **核心是模型行为，没有确定性测试**。〔文档〕整条链依赖模型：读懂 deny reason → 主动 `wait(300000)` →
   同一 turn 重试。全部证据只有「P5 已落地」和一次「私聊 `pwsh` 两次、无审批弹窗」的手工记录
   （[魔改设计.md:485-493](../../qwenstuff/dsh-qq-魔改设计.md)），**没有一份完整的「她说 → 你回行 → 她重试」记录**。
4. **真实事故**。〔文档〕2026-10-22 22:49「用户手动停掉桥接（避免 AI 反复催权限）」
   （[魔改设计.md:418](../../qwenstuff/dsh-qq-魔改设计.md)）；而 §2.5 明确决定「防催机制不做」，
   理由是应由记忆自然承载——实际结果是打扰到关服务。
5. **UI 死掉**。〔文档〕「挂起的审批与提问」面板永久为空，被列进 B1 一等清理项
   （[dsh-qq-路线图.md:39](../../qwenstuff/dsh-qq-路线图.md)）。
6. **残留规模**。〔代码〕`approval` 66 处、`closed-agent` 98 处、`currentLevel` 28 处引用
   **没有一条可达路径**，仍在编译、仍在测试、仍在文档里解释
   （[dsh-qq-模式地图.md:84-95](../../qwenstuff/dsh-qq-模式地图.md)）；S3 一次性删掉 17 个
   「提权/确认码/TOTP/审批」用例（[模式地图.md:213](../../qwenstuff/dsh-qq-模式地图.md)）。
7. **三代结论**。〔文档〕[HISTORY.md:28-30,59](./HISTORY.md)：权限模型改了三轮，全绕在 1.3 万行的
   `bridge.js` 里；`focus-core` 放弃「审批闸门体系」，`icl` 明确「审批体系不继承」。

### 4.2 如果照搬，风险排序

| 级别 | 风险 |
|---|---|
| **高** | 预授权 > 单次授权：一张 180s/20 次的券，用户以为只批了一件事 |
| **高** | 模型自述作为授权依据：提示注入可让她把危险操作说成小事 |
| **中高** | 宽词表误开（`干吧`/`上吧`）；窗口开启无显著提示，用户不知道「现在她全放行」 |
| **中** | turn 结束/断线导致批准丢失或悬挂；重启后 grant 语义未验证 |
| **中** | 无法回归：多轮模型行为没有 harness，只能靠人肉试 |
| **低** | 回执文案与普通聊天混淆，事后分不清哪句是「已授权」 |

**给 icl 的一句话**：可以借它的「语气」（让审批看起来像对话），不要借它的「制度」（会话级预授权 + 第二套策略）。
真正降低复杂度的方向是：**DSH 一套 policy + 一个会话内 answerer + 四态结果 + per-call 绑定**，
旧项目已经把这条路走反了一次，证据在上面。

---

## 5. 引用索引

| 文件 | 用途 |
|---|---|
| [dsh-qq-魔改设计.md](../../qwenstuff/dsh-qq-魔改设计.md):47-83,139-176,286-346,418,485-493 | 开闸协议、deny 而非 ask、私聊刹车、判定顺序、实测记录 |
| [dsh-qq-沙箱盒子设计.md](../../qwenstuff/dsh-qq-沙箱盒子设计.md):17,236 | 最终选择「取消逐次审批 + 软闸门 + 快照兜底」 |
| [dsh-qq-模式地图.md](../../qwenstuff/dsh-qq-模式地图.md):74,84-95,116,172,205-215 | 审批代码如何变成死路径、测试如何被删 |
| [dsh-qq-审计报告.md](../../qwenstuff/dsh-qq-审计报告.md):22,41,59,160,194 | 零审批上线口径、残留清单、死面板 |
| [dsh-qq-使用说明.md](../../qwenstuff/dsh-qq-使用说明.md):8,16-18,50-52 | 用户可见承诺："不再有审批" |
| [dsh-qq-mod/README.md](../../qwenstuff/dsh-qq-mod/README.md):74,86-92,104-112,134-135,171-172 | P5/P14/P15/P17/P19/P21 补丁与验证口径 |
| [dsh-qq-路线图.md](../../qwenstuff/dsh-qq-路线图.md):39 | 「挂起的审批与提问」死面板 |
| [approvals.js](../../qwenstuff/dsh-qq/src/admin/approvals.js):1-13,142-156,158-171 | 编号模板审批（仍在，但无触发路径） |
| [bridge.js](../../qwenstuff/dsh-qq/src/bridge.js):13894-13928 | 群聊审批自动拒绝 + owner 编号审批接线 |
| [dsh-user-approval README](../node_modules/@deepseek-ai/dsh-user-approval/README.md):5-13,57-62 | 现行四态、一次性、turn 内、无 allow-always |
| [SANDBOX-PLAN.md](./SANDBOX-PLAN.md):177-222,445-453,478-479 | 我们的 ask/answerer 方案与已知坑 |
| [HISTORY.md](./HISTORY.md):28-30,59 | 三代结论：审批体系不继承 |

> 附注：[dsh-qq-模型页交互设计.md](../../qwenstuff/dsh-qq-模型页交互设计.md) 只有删除模型的二次确认，
> 没有审批交互内容，与本主题无关；`_ref/` 是 DSH 官方包解包与 MaiBot 记忆调研，也没有审批交互参考。
