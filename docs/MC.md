# MC 接缝（身体 / 头脑分层）

`docs/MC-CONTRACT.md` 是 v1 契约；本文是使用说明。

## 1. 组成

| 组件 | 作用 |
|---|---|
| `packages/mc-body` | 独立 MC 身体：mineflayer、任务状态机、事件、安全停止；不依赖 ICL |
| `packages/plugins/mc-link` | ICL 适配器：只懂 `mc-body/v1` HTTP；工具/信号/world |
| `icl-mc` preset | ICL + mc-link；状态目录 `.state/mc-state` |
| `tools/mc-observer.mjs` | 更早的只读诊断探针；不是最终 body |

不是 `dsh-mc-agent`。第三方 agent 不修改、不嵌入。

## 2. 起 body

```powershell
# 默认只读状态/事件，不执行任务、不发言
node packages/mc-body/src/cli.mjs --host 127.0.0.1 --port 54835 --listen 54836

# 允许任务（仍然不能发言、不能执行命令）
node packages/mc-body/src/cli.mjs --host 127.0.0.1 --port 54835 --listen 54836 --allow-task

# 允许任务 + 限速发言
node packages/mc-body/src/cli.mjs --host 127.0.0.1 --port 54835 --listen 54836 --allow-task --allow-say
```

检查：

```bash
curl http://127.0.0.1:54836/v1/status
curl http://127.0.0.1:54836/v1/events?since=0
```

## 3. 下任务

```bash
curl -X POST http://127.0.0.1:54836/v1/tasks \
  -H 'content-type: application/json' \
  -d '{"idempotencyKey":"mine-1","kind":"mine","params":{"block":"dirt","count":2,"radius":6},"deadlineMs":20000}'
```

返回立即；进度/完成看 `/v1/events` 或 `/v1/status`。

任务：`mine` / `goto` / `patrol` / `explore` / `follow` / `chat` / `routine`。`routine` 是可持续收集/生存：每 `tripEvery` 个方块换点、没目标时换点、饥饿时吃东西，带 collected/trips/eaten 进度。`goto` 已接 `mineflayer-pathfinder`（GoalNear），实测从 `53.5,111,20.5` 走到 `55.5,111,20.5` 成功；`patrol` 复用 `goto`。复杂地形仍可能 `stuck`，会安全停止。

## 4. 安全

- 只监听 `127.0.0.1`；
- 无 OP、无命令、拒绝 `/`；
- 出生脚/头/下方是岩浆/火/仙人掌/岩浆块/细雪 → `spawn_unsafe` + `safety_stop`；
- 低血/掉血/死亡/卡住/断线 → `safety_stop`，当前任务 `interrupted`，排队任务也中断；
- body 内置 watchdog（2s，可配）：低血、低氧也会安全停止；
- 任务结束队列空时回最近安全点；暂停超过 `pausedDisconnectMs`（默认 120s）自动下线，避免站立挨打；
- 安全停止时 adapter 做有界急救：吃东西、回最近安全点、后退/上浮；连续 3 次死亡隔离（断开连接、拒绝 resume）；
- adapter 有界自动重连（默认 3 次，退避 3s/6s/12s），发 `reconnecting/reconnected/reconnect_exhausted`；重连后仍保持暂停，要显式 `resume`。
- `POST /v1/safety/resume` 恢复（队列已清空，要重新下任务）；
- 任务 deadline、取消、幂等；
- `chat` 1 秒限速、≤200 字。

## 5. ICL 侧

`icl-mc` preset 需要重启 DSH 后出现。启动：

1. 起 body；
2. 开 ICL MC 会话；
3. 工具：`mcb_servers` / `mcb_lan` / `mcb_join` / `mcb_leave` / `mcb_status` / `mcb_look` / `mcb_scan` / `mcb_map` / `mcb_inventory` / `mcb_do` / `mcb_help`；组合/长任务/事件/发言都走 `mcb_do` op。
4. 游戏里聊天/任务完成/安全停止以 signals 进入 ICL，受 focus/sleep 门控。

任务不阻塞主会话：`mcb_do` 的 task op 立即返回 taskId，外部消息可以在任务运行期间处理。任务台账默认写到 `.state/mc-body/tasks.json`；重启时 running/queued 标成 `interrupted(body-restart)`，不自动续跑。

## 6. 测试服务器

本地 1.21.4 flat/peaceful 服务器：

```bash
cd C:/DSH/icl/.state/mc-server
java -Xms1G -Xmx2G -jar server.jar nogui
```

- 端口 `54837`，`online-mode=false`、`difficulty=peaceful`、`level-type=minecraft:flat`；
- 只用于 body 测试，不对外开放；
- `tools/mc-soak.mjs --port 54837` 自动起 body、下 routine、收集报告。

## 7. 实测记录（2026-11-04）

- body 第一次连 54835 时在 `57.5,114,26.5` 出生，出生即低血，5 秒内死亡；body 正确进入 `safety_stop`，任务没有执行。
- 重连后在 `53.5,111,20.5` 安全出生，`mine dirt ×2` 成功，进度/完成事件正常。
- ICL MC short：`mcb_status` → `mcb_task(mine dirt 1)` → `mcb_events` 通过；任务事件以 `plugin:mc` notice 进入 DSH，不是 user 伪造。
- flat30-final：743 块 / 92 trips / 0 死亡 / 0 safety_stop，routine 以 duration 正常结束。
- 结论：**世界出生点本身可能是危险的**；body 的安全停止有效，但长期运行前应把世界出生点放到安全平台，或使用独立测试世界。

## 8. 下一步

1. ICL 主会话 + `icl-mc` 短会话（真实 steer 验证）；
2. 本地模型测试 profile；
3. 外部消息与 MC 任务并发；
4. 30 分钟无人值守 body soak。
