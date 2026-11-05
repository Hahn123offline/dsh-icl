# mc-link（MC 头脑侧适配器）

CLI 工具面：11 个常驻 `mcb_*` 工具 + 按需技能文档；只懂 `mc-body/v1` HTTP，不 import mineflayer。
契约见 [`docs/MC-CONTRACT.md`](../../../docs/MC-CONTRACT.md)，验收见 [`docs/MC-ACCEPTANCE.md`](../../../docs/MC-ACCEPTANCE.md)。

## 文件

| 文件 | 职责 |
|---|---|
| `src/index.mjs` | 工具面、提示词事实段（`mc:status`/`mc:skills`）、轮询、signals 投递 |
| `src/lifecycle.mjs` | mc-body 子进程：启动、健康检查、日志捕获、崩溃上报、只杀自己 spawn 的 |
| `src/events.mjs` | body 事件 → 信号的分级/合并/限流（纯函数，可单测） |
| `servers.json` | **已知 MC 服务器的唯一定义**（flat 54837 / survival 54838） |
| `skills/*.md` | 深层操作文档，`mcb_help` 按需读；`play.md` 是开一局主入口 |

## 配置（都由 dsh-icl 的 `configFor('mc-link')` 传入）

| key | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:54836` | body HTTP 地址 |
| `listenPort` | `baseUrl` 的端口 | spawn 时 `--listen`；**body 端口只有这一个定义** |
| `pollMs` | 1200 | 事件轮询间隔 |
| `doTimeoutMs` | 120000 | `mcb_do` 单次请求等待上限（超时返回"先查状态"而不是裸错） |
| `bodyEntry` | `packages/mc-body/src/cli.mjs` | 要 spawn 的 body 入口 |
| `stateDir` | `C:/DSH/icl/.state/mc-live` | body 的 tasks/body.jsonl/stderr 落盘处 |
| `serversFile` | （无） | 可选第二份服务器清单；**不隐式读仓库根 `config/mc-servers.json`**——那个文件是遗留物，已由本插件的 `servers.json` 取代，保留只为避免动别人的路径 |
| `chatPerMinute` | 6 | 游戏内聊天合并后的分钟限额 |

## 提示词分层（docs/PROMPT-CONTRACT.md）

- 只注册两个**事实**段：`mc:status`（≤1 行、≤120 字）、`mc:skills`（条件命中、≤2 行），order 900/901。
- 不再有 `mc:play`/`mc:interaction` 教学段：操作流程在 `mcb_*` 的 description 与 `skills/play.md`，
  全局层（`prompts/sim.md`）只说"这些工具怎么配合"，不写参数。

## 宏操作（docs/MC-MACRO.md，body 73a209d 起）

- 宏 = 一个 body task：`collect`/`tunnel`/`bridge`/`build`/`sort`/`deposit`/`shelter`/`farm`（8 个，全部已进 body；beta，
  真服验收先看 collect/tunnel）。一条调用完成重复劳动，别逐方块 mine/goto/dig。
- progress 限频（每 5–10% 或 10s）；观测事件只记台账不叫醒：`macro_step`/`macro_blocked`/`macro_done`/`macro_tool_auto`/`auto_tool`/`auto_eat`/`needs_tool`/`tunnel_clear`/`path_approximate`/`path_recovered`/`dig_fallback`/`craft_no_product`；
  终态走 `task_done`/`task_failed`/`task_interrupted`/`task_paused`/`task_unknown`；成功文案按宏各自说人话（collect 净增、
  tunnel 通道/火把/向下阶梯、bridge 铺路、build 放置/跳过、shelter 墙顶门、sort/deposit 存/取、farm 开垦/播种）。
- `collect` 的 `task_done.result` 带 `net`（背包净增）优先显示；`tunnel` 的 `stairs:true` 只支持**向下阶梯**（向上走 `unsupported`）；
  `build`/`shelter` 完成度 <80% 会 `failed(partial)`。
- 失败码统一翻成下一步：`no-target|no-path|dig-failed|needs-tool|inventory-full|needs-material|blocked|unsafe|partial`
  （farm 另有 `no-water|no-site`；tunnel 向上 stairs 是 `unsupported`）。
- `pickup`（单步 op）捡附近掉落物：`{radius,max}` → `picked/items/left`；死亡/挖后掉落别用 goto 原地站着。
- **doPlan 单飞锁**：长动作并发会被 body 409 挡回，mcb_do 会把 409 翻成"长动作一律用 task 提交，别并发单步 op"。
- 教学在 `mcb_do` description + `skills/play.md`（"重复劳动用宏"）+ `mcb_help collect/tunnel`。

## body 事件 → 会话信号（outcome 对齐 mc-body e6fee4c）

| body 事件 | 信号 | 说明 |
|---|---|---|
| `task_done` | notice | 真正达成：契约上 `result.reason` 只会是 `net-target\|duration\|target`（白名单=成功）；mine 说"挖了 N 个"、其它说"净增 N" |
| `task_failed` | notice | `error` 原因码（`mine: no-target/no-path/dig-failed/no-effect`、`routine: stuck`…）翻成下一步；带进度 |
| `task_unknown` | notice | 超时/结果未知：**不当失败**，让她先 mcb_status/mcb_inventory 复核 |
| `task_paused` | notice | 断线挂起（state=paused）：重连后要显式 `{"op":"resume"}` + `{"op":"resume","taskId"}` |
| `task_resumed` | notice | 显式继续后的确认 |
| `task_interrupted` / `task_cancelled` | notice | 中断/取消，不自动续跑 |
| `safety_stop` | alarm（仅真危险） | death/low-health/low-oxygen/spawn-unsafe 带 `alarm`；disconnect/stuck 不带 |
| `death` / `quarantine` | alarm | 死亡合并 60s；5 分钟 3 次额外升级提醒；隔离单独一条 |
| `health_drop` | notice（合并 120s） | body 现在暂停后不再逐条发 |
| `offline` / `disconnected` / `reconnecting` / `resume_required` | notice | 同一次断线合并；重连不自动续跑 |
| `reconnect_exhausted` | alarm | 自动重连放弃，状态栏必须显示未连接 |
| `kicked` | alarm | reason 是对象时给真实文本；同名/重复登录提示换 username |
| `task_queued`/`started`/`progress`/`health`/`heartbeat`/`watchdog*` | 不投递 | 状态以 `/v1/status` 为准 |
| `path_stuck` | **单次不投递**；连续 ≥2 次才 notice | 单次只是重算路线，常随后成功；计数在任务开始/终态时重置 |
| `dig_fallback` / `path_approximate` / `path_recovered` / `tunnel_clear` | dig_fallback notice；其余不投递 | 寻路中间过程不叫她 |

## 收工语义（mcb_leave）与显示口径

- `mcb_leave {cleanup:true}` 清 **MC 相关**的模型 focus + time 持续目标：识别不只看 `focus==='mc'` 字符串，
  也看 activity/title/goal/reason/theme 里的 MC 标记与服务器别名（flat/survival…）。
- **回执如实**：默认 leave 会列出**所有**还挂着的 focus/目标（MC 与非 MC 分开报）；只有真的空了才说
  "已完全收工"。cleanup 只清 MC 相关的，非 MC 的会单独列出并提示 focus_leave / time_cancel，不会谎称干净。
- **坐标/血量/背包同口径**：位置统一 `x,y,z`（四舍五入，join/look/status/提示词行/dig 结果一致），
  生命/饥饿取整（17.8333→18）；背包 `N 件` = 物品总数，`（占 K 格）` = 占用背包格子（body inventory.used），
  `mcb_status`/`mcb_look`/`mcb_inventory` 用同一套文案。
- 宏教学总览见 `mcb_help macro`（8 宏/参数/失败码/别逐方块），细节 `mcb_help collect|tunnel`。

## body 进程退出（lifecycle）

- `body-exit.json`（mc-body 新版）优先：`reason`、`exitCode`、`detail`(栈)、`recentEvents`、`stderrTail`、退出时 status；旧 body 退化读 stderr 的 `[mc-body] exit reason=`。
- reason 分类文案：`sigterm`/`sigint`/`api-shutdown`/`clean-exit`（主动停）、`idle-timeout`（暂停超时下线）、`reconnect-exhausted`（服务器/连接）、`uncaught-exception`/`unhandled-rejection`（body 崩溃，带栈首行）、`exit-code`（无栈非正常退出）、`startup-error`。
- crash signal 内容：原因 + 退出码 + 本会话第 N 次退出 + 死时任务/位置/最后错误/栈首行/死前事件 + 下一步；**同因账本**按 `reason+taskId+pausedReason` 计数，第 2 次起标"本会话第 N 次同因退出"并按类给差异化建议。
- `mcb_leave` 对本会话 spawn 的 body 先 `POST /v1/shutdown`（code 0 + 归因），2s 内没退才 SIGTERM；外部 body 只安全停止。
- **expected vs unexpected（退出语义）**：`lifecycle.classifyExit`
  - **expected**（按"正常结束"处理：不发崩溃告警、不触发重连/唤醒、状态行只显示未连接）：
    本会话自己 `stop/leave`；`body-exit.json.reason ∈ {api-shutdown, clean-exit, idle-timeout}` 且 `exitCode=0`；
    无归因、无信号、code 0。
  - **unexpected**（走 crash 账本/告警）：`uncaught-exception`/`unhandled-rejection`/`exit-code`、外部 `sigterm`/`sigint`、
    非零退出码、以及有 reason 但 code 非 0 的"假装干净"。
  - 典型用例：睡眠/离线期管理面 `POST /v1/shutdown {reason:"sleep-safe"}` → expected，body 不会自己再起来；
    醒来后会话 `mcb_join` 显式重连，`mcb_status` 会显示"上次退出：…（预期内，不是崩溃）"。
- **单次 HTTP 失败不报警**：`/v1/status` 连续失败 2 次（≥~2.4s）才发"连不上 body"alarm——外部干净关闭会有 HTTP 先断、
  exit 事件后到的亚秒空窗，第一次失败就报警会把她从睡眠里拽起来。
- 时延埋点：`mc-link.jsonl` 的 `crash-detect {at, exitAt, latencyMs}` 与 `signal {at}`，可直接算 kill→检测→投递。
