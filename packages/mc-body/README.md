# mc-body

ICL 的 MC 身体进程：mineflayer + 任务队列 + 反射 + 安全 + 看门狗 + 重连。独立进程，无模型、无目标生成；只执行 ICL 下发的任务并上报事件。契约见 `docs/MC-CONTRACT.md`，行为契约见 `docs/MC-LEARNED.md`。

```bash
# 只读（不执行任务、不发言）
node packages/mc-body/src/cli.mjs --host 127.0.0.1 --port 54837 --listen 54836
# 允许任务 + 发言
node packages/mc-body/src/cli.mjs --host 127.0.0.1 --port 54837 --listen 54902 --name ICL-mcbody-1 --allow-task --allow-say \
  --state C:/DSH/icl/.state/lab/mc-body-soak/tasks.json --log C:/DSH/icl/.state/lab/mc-body-soak/body.jsonl
# 单测（零外部依赖）
node --test packages/mc-body/test
```

## 任务 outcome（重要）

`done | failed | cancelled | interrupted | unknown | paused`

- `done`：真正达成（mine 背包净增达标；routine `reason=duration|target`）。
- `failed`：动作失败/未达成，`task.error` 是短原因码（`mine: no-target|no-path|dig-failed|no-effect`、`routine: stuck|no-target|...`、`goto: no-path...`），`task.result` 带进度与建议。
- `unknown`：deadline 超时等**结果未知**（可能已生效），不能当失败也不能当成功；`outcomeUnknown=true`。
- `paused`：断线时正在跑的任务被挂起（`pausedReason='disconnect'`）。重连**不自动续跑**：先 `POST /v1/safety/resume`，再 `POST /v1/tasks/:id/resume`。`status.pausedTasks[]` 可查。
- 身体暂停（`paused=true`）时 **createTask 会 409**（出生不安全/低血/断线后不接任务）。

## HTTP（仅 127.0.0.1）

`GET /health` · `GET /v1/status` · `GET /v1/events?since=` · `GET /v1/tasks?state=` · `GET /v1/tasks/:id` ·
`POST /v1/tasks`（idempotencyKey 幂等）· `POST /v1/tasks/:id/cancel` · `POST /v1/tasks/:id/resume` ·
`POST /v1/do`（组合 steps）· `POST /v1/inspect` · `POST /v1/chat` · `POST /v1/safety/stop` · `POST /v1/safety/resume` ·
`POST /v1/shutdown {reason}`（干净退出，写归因）

`/v1/status` 关键字段：`connected/online`（连接事件为权威，不假在线）、`paused/pausedReason`、`safety{offline,...}`、
`task/queue/pausedTasks`、`watchdog{ticks,alerts,suppressed,suppressedBy,healthDropSuppressed}`、`reconnect{attempts,max,exhausted,...}`、
`adapter.pathfinder`、`adapter.environment{resources,summary}`（进服 preflight 一句话）、`adapter.danger{blocks,inDanger}`、`adapter.pathStats{resets,recoveries,stuck,carves}`。

## 退出归因（crash vs 主动停）

每次退出都写 `<stateDir>/body-exit.json`（以及 `body.jsonl` 的 `body_exit` 事件、stderr 一行 `[mc-body] exit reason=...`）：

- `reason`：`sigterm|sigint|api-shutdown|idle-timeout|reconnect-exhausted|uncaught-exception|unhandled-rejection|exit-code|clean-exit`
- 另有：`exitCode`、`detail`（崩溃时完整 stack）、退出时 status（connected/paused/taskId/eventsSeq/lastError/reconnect）、`recentEvents`（最后 12 条）、`stderrTail`（最后 10 行）
- 运行中每 2s 写 `<stateDir>/body-alive.json`（被硬 kill 时能看出最后状态）。
- 验证归因本身：`--selftest-crash=uncaught|rejection|exit1|exit0`（1.5s 后模拟对应退出；仅本地自检用）。

## 30 分钟 soak（真实服，无人值守）

```bash
node packages/mc-body/tools/soak.mjs --minutes 30 --port 54839 --listen 54902 \
  --name ICL-mcbody-1 --out C:/DSH/icl/.state/lab/mc-body-soak/<run>
```

- 自己 spawn/停 body，dump routine（采集/换点/吃饭），收 status/events/timeline，结束写 `report.md` + `metrics.json`；PASS 判据：0 death / 0 safety_stop / 任务 `done reason=duration|target` / 无 `reconnect_exhausted` / 看门狗有 tick。
- 用独立干净平顶服（`.state/mc-server-body`，端口 54839）；54837/54840 是共享/验收服，别拿来做长期 soak。
- 关注 `pathStats`：`stuck` 是失败重试计数，`recoveries` 是阶梯恢复成功；routine 只在**连续 5 次走不过去**才判 stuck。

## 真实断线 → 重连演练（本地 TCP 代理，不动共享服）

```bash
node packages/mc-body/tools/reconnect-drill.mjs --upstream 54837 --proxy 54940 --listen 54903 \
  --name ICL-mcbody-rc --max-reconnect 3 --reconnect-base-ms 400 \
  --out C:/DSH/icl/.state/lab/mc-body-soak/<run>-reconnect
```

- 代理掐断连接 → 验证：`offline`（状态栏不假在线）→ running 任务 `paused` → 有界重试 → `reconnected` 后**身体仍暂停、任务不自动续跑** → 显式 resume 同一 taskId 继续 → 关代理 → `reconnect_exhausted` 保持离线、createTask 被拒。
- 代理端口别用 54840/54839（分别被 lab 正常服 / soak 占用）。

## 安全/看门狗

- 出生后（chunk 加载完）判脚/头/下方/周围危险方块 + 附近敌对生物：不安全 → `spawn_unsafe` + 暂停 + 不接任务；`spawn_safe` 带 `environment`。
- 看门狗：低血（≤10）/掉血 >1/水下低氧/危险方块/连接假死（>45s 无包）/movement stall（25s 不靠近目标）/心跳；`danger` 与 `idle` 配额分开，`suppressed/suppressedBy/healthDropSuppressed` 有统计；暂停后不再刷 `health_drop`。
- 寻路：progress watcher 按“是否更靠近目标”判卡 → repath→jump→backoff→carve（1×2 通道挖头/挖脚）→ giveup；`path_approximate` 表示目标点被占但已在 range+1 内；任务级走不过去=任务 `failed(no-path)`，**不**暂停身体（物理卡住由 25s movement stall 暂停）。
- `mine` 开始做可达性预检：只有 A* 明确 `noPath` 才快速失败；`unknown` 继续尝试；走不到但已在 4.5 格内 → **原地挖**（`dig_fallback`）；`no-path` 带 distance/detail/suggestion。
- `craft` 后校验产物是否进背包（防“吞材料”假成功）；`kicked` reason 归一为可读文本；`place` 支持多坐标从下往上、返回 placed/skipped 明细与原因、`autoSupport` 先垫一层。
