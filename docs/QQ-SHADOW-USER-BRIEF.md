# QQ 只读影子：给用户看的一页说明（申请时间窗时直接贴）

> 用途：lead 向用户申请一次真实 SnowLuma 只读影子前，把这一页贴给用户。
> 内容由 `node packages/plugins/qq/tools/preflight.mjs --brief` 按**当时的真实检查结果**生成；
> 完整证据在 `.state/qq-shadow/preflight/preflight-latest.md`。下面这份是 **2026-11-05 18:32 的本机快照**（含当时的 BLOCK 结论）。
> 重新生成：`cd C:\DSH\icl-wt\qq; node packages/plugins/qq/tools/preflight.mjs --brief`
>
> ⏸ **当前状态（2026-11-05）：用户选择 B——本轮不做真实影子**（不在电脑前，无法启动 SnowLuma）。
> 本页留作**下一轮**申请时使用；届时请先重跑 `preflight --brief` 取最新结论，再按 `docs/QQ.md §10` runbook 执行。

---

<!-- BEGIN GENERATED: preflight --brief @ 2026-11-05T10:32:45Z -->

# 申请一次 QQ 只读影子（给用户看的一页说明）

> 这是 ICL 的"只读影子"：15 分钟窗口里，她**只收你的 QQ 私聊**，不发送任何 QQ 消息、不接群。
> 生成时间：2026-11-05T10:32:45.153Z；`preflight` 结论：**BLOCK**。

## 这是什么、为什么值得做

验证 ICL 能"接收到真实的你"，同时保证不打扰任何人：她能看到你发的一条私聊并进入她的上下文，但没有回复工具，群消息整类忽略。

## 现在为什么不能直接开始

preflight 发现**会抢 QQ 连接的旧消费者**，必须先处理：

- ⛔ 有会抢 QQ 连接的进程在跑：pid 12232 focus-core 旧应用（会连=true，会发=true）

**其中 focus-core 旧应用（下面这些进程）具体会做什么：**

- pid 12232：`node  apps\dsh-icl\src\main.js`
- 它一旦发现 SnowLuma 在跑，会**自动连上**，用**旧人格**处理消息，并且它的代码里存在主动给你发私聊的路径。
- 也就是说：如果不先停它，这次窗口就不是"干净影子"——你可能会收到旧人格的意外消息，我们的观测也会被污染。

其它需要你知道的：

- ⚠️ 启动文件夹里有 dsh-icl.lnk：下次登录会自动拉起 focus-core 旧应用

## 需要你做的三件事

1. **同意一次短窗口**（建议 15 分钟）——只在窗口内运行，结束立即停。
2. **同意停掉上面的旧消费者**（不是我们静默 kill：停之前会再确认一次；不批准也能跑，但那就不是干净影子，见上）。
3. **由你手动启动 SnowLuma**（我们不程序化启停它），然后在窗口内**给机器人发一条私聊**（随便一句即可）。

## 窗口内会发生什么（以及不会发生什么）

- 她**只收不发**：客户端零出站帧（连 `get_login_info` 这类动作都不发）；没有发送工具。
- 群消息**整类忽略**：连只读都不接，不解析、不记录文本（只计一个数字）。
- 她会看到你那一条私聊并进入她的上下文；可能"想回"，但没有能力回——这是设计，不是故障。
- 如果她正在睡觉/静音：消息会进她自己的积压，醒来后作为摘要看到（不会丢）。

## 出问题怎么办 / 怎么回滚（三步）

1. 停掉只读影子实例（lab 自动停或 `lab.mjs down`）；2. 你手动关闭 SnowLuma；3. 需要的话重新启动旧消费者（启动文件夹里有快捷方式）。
全程证据留在 `.state/lab/<runId>/`（报告、原始事件、私聊记录），可复盘。

## 我们不会做的事

- 不启动/停止 SnowLuma 进程，不写它的任何文件；不连接 3000/3120；不发任何 QQ 消息；不接群；不改 desktop profile。

> 说明由 `node packages/plugins/qq/tools/preflight.mjs --brief` 生成；同一份结论的完整证据见 `preflight-latest.md`。

<!-- END GENERATED -->

---

## 附：lead 的内部核对点（不贴给用户）

- 若用户**不同意停 pid 12232**：仍可跑，但这次只能记为"非干净影子"——旧应用会连 SnowLuma 并可能用旧人格发私聊；观测里出现异常发送/回复时不算我们的 bug。
- 若用户**不同意手动启动 SnowLuma**：影子无法开始（我们不代启动，EULA §5.4）。
- 停 pid 12232 前再核对一次命令：`Get-CimInstance Win32_Process -Filter "ProcessId=12232" | Select-Object ProcessId, CommandLine`；
  停止后确认 3201 不再监听：`Get-NetTCPConnection -LocalPort 3201 -State Listen -ErrorAction SilentlyContinue`。
- 回滚/恢复旧应用：用户从启动文件夹 `dsh-icl.lnk` 双击即可（它会按原逻辑发现 SnowLuma 并连接）。
- 完整 runbook（含前 5 分钟检查清单、失败即停阈值）：[QQ.md §10](QQ.md#10-shadow-runbook可执行清单)。
