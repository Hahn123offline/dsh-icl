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
