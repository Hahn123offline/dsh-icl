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

## body 事件 → 会话信号（outcome 对齐 mc-body e6fee4c）

| body 事件 | 信号 | 说明 |
|---|---|---|
| `task_done` | notice | 真正达成；带 mined/arrived/result |
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
