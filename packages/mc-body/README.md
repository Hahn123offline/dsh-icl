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

- `done`：真正达成。**成功原因固定写在 `task.result.reason`：`net-target`（mine 背包净增达标）/ `duration` / `target`（routine 时间到/数量到）**；`task_done` 里不会出现 failed 类原因。
- `failed`：动作失败/未达成，`task.error` 是短原因码（`mine: no-target|no-path|dig-failed|no-effect|drops-missing|inventory-full`、`routine: stuck|no-target|...`、`goto: no-path...`、`craft: ...`），`task.result` 带进度/材料快照与建议；失败原因只出现在 `task_failed`。
- `unknown`：deadline 超时等**结果未知**（可能已生效），不能当失败也不能当成功；`outcomeUnknown=true`。
- `paused`：断线时正在跑的任务被挂起（`pausedReason='disconnect'`）。重连**不自动续跑**：先 `POST /v1/safety/resume`，再 `POST /v1/tasks/:id/resume`。`status.pausedTasks[]` 可查。
- 身体暂停（`paused=true`）时 **createTask 会 409**（出生不安全/低血/断线后不接任务）。
- **暂停 ≠ 冻结世界**：暂停只是停止接任务并中断当前任务；物理仍存在（会掉落/受伤/被推），所以暂停时**允许** `look/inventory/scan/map/events/tasks/resume/cancel/say/wait`（`cancel` 是安全动作，不需要先 resume），暂停超时会 `idle_disconnect`。`status.safety.note` 会明确这句话。

## HTTP（仅 127.0.0.1）

`GET /health` · `GET /v1/status` · `GET /v1/events?since=` · `GET /v1/tasks?state=` · `GET /v1/tasks/:id` ·
`POST /v1/tasks`（idempotencyKey 幂等）· `POST /v1/tasks/:id/cancel` · `POST /v1/tasks/:id/resume` ·
`POST /v1/do`（组合 steps）· `POST /v1/inspect` · `POST /v1/chat` · `POST /v1/safety/stop` · `POST /v1/safety/resume` ·
`POST /v1/shutdown {reason}`（干净退出，写归因）

`/v1/status` 关键字段：`connected/online`（连接事件为权威，不假在线）、`paused/pausedReason`、`safety{offline,...}`、
`task/queue/pausedTasks`、`watchdog{ticks,alerts,suppressed,suppressedBy,healthDropSuppressed}`、`reconnect{attempts,max,exhausted,...}`、
`adapter.pathfinder`、`adapter.environment{resources,summary}`（进服 preflight 一句话）、`adapter.danger{blocks,inDanger}`、`adapter.pathStats{resets,recoveries,stuck,carves}`、
`adapter.inventory{emptySlots,full,used}`、`adapter.equipment{hand,armor{head,torso,legs,feet},keeps}`（含耐久 used/max/left）、
`adapter.time{timeOfDay,day,isNight,clock,isDay}`（昼夜判断）、`adapter.lastDeath{position,at,dimension,inventoryCount}`（死亡回收线索）、`adapter.sleeping`。

### 任务 op / 组合补充（2026-11-06）

- `furnace`：`{input, fuel, count, fuelCount?, waitMs?}` —— `count` 个产物、按需放燃料（默认 `ceil(count/8)`），轮询取产物并在 `total<count` 时返回 `partial:true`；0 产物报明确原因（燃料不足/输入错）。
- `chest`：`{action:"put"|"take"|"list", all:true}` 整包存取（工具/装备/食物默认不存，返回 `moved/kept/container`）；单件仍用 `items[]`。
- `sleep`：`{}` —— 找附近床走过去睡；附近没床但背包有床 → 报“先 place 床”；夜里/雷暴以外会报明确原因。**注意 mc-link 的 `OPS` 白名单要加 `sleep` 才能在 `mcb_do` 里用**。
- `mine`：背包满返回 `mine: inventory-full`（不再挖半天 no-effect）；开始/循环内 `food<=14` 自动吃；掉落未进包继续挖/再收。


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
- `craft`：**`count` = 想要多少个成品**（不是合成次数）——一次产 4 的木板/木棍会按 `ceil(count/4)` 合成；合成后校验产物是否真的进背包（防“吞材料”假成功，失败带材料前后快照）。`kicked` reason 归一为可读文本；`place` 支持多坐标从下往上、返回 placed/skipped 明细与原因、`autoSupport` 先垫一层。

## 装备与工具（2026-11-06，用户要求）

- `mcb_inventory` 现在给：**手持物品（快捷栏槽位）+ 9 格快捷栏（★=当前选中）+ 每件物品的 `toolFor`（pickaxe/axe/shovel/shears）+ 工具等级 + 耐久**；数据里还有 `data.hotbar/selectedSlot`。
- `mcb_do {"steps":[{"op":"equip","params":{"item":"stone_pickaxe"}}]}` 换成手持；`{"op":"equip","params":{"slot":3}}` 直接选中快捷栏第 3 格。
- `mine` / `dig` **开始前会检查工具**：
  - 手持合适 → 直接用；不合适但背包有更好的 → **自动换上**（结果/progress 里 `autoTool:true`、事件 `auto_tool`）；
  - 没有可用工具/等级不够 → **立即失败**，`task.error`/result 带 `needsTool`、`suggestCraft`、以及可执行步骤（如“先 craft stone_pickaxe（3 cobblestone+2 stick）”），**不会原地重试**；
  - `mine`/`dig` 参数传 `autoTool:false` 可关闭自动换工具（模型自己用 equip 管）。
- 自动反应（战斗/低血/危险）仍由 body 自己切武器/食物；普通挖掘/采集默认尊重模型的装备选择。

### 设计转向与真服证据（2026-11-06 夜间用户要求）

转向：**装备/工具归模型管**（能看快捷栏、自己 equip），脚本只在战斗/危险/紧急等自动反应里兜底；**普通挖掘不再靠脚本替模型决定目标**。

真服证据（night-1，body pid 29116，部署后 session 保留；events seq）：
- `seq 390/391 mcb_inventory` → `手持（快捷栏 8）：stone_pickaxe×1（pickaxe·石） 耐久 79/131 ｜ 快捷栏：… ★8 stone_pickaxe×1(pickaxe) …`（新格式生效；她当时已有 cobblestone×64/3 把石镐）。
- `seq 370/372 mine stone count=10`（手持已是 pickaxe）→ `{"mined":10,"net":10,"requested":10,"item":"cobblestone","reason":"net-target"}`（body 未多此一举换手，符合“模型已有对工具就不打扰”）。
- 回归证据（空手/dirt 挖 stone 必须立即失败，不走路不重试）：`packages/mc-body/src/tools.mjs` 规则 + `test/tools.test.mjs` 单测 + 真服 smoke `C:/DSH/icl/.state/lab/mc-body-soak/tool-smoke2/`；报错含 `needsTool/suggestCraft` 与 3 步链（详见 §装备与工具）。
- `equip` 真服回执：`{selectedSlot, held, toolFor}`（54839 smoke）；night-1 里她尚未调用 equip（手持已对）——待她下次换手补 seq。
- 已知遗留（非本功能）：同一长 `mcb_do`（mine）连发会触发 mc-link 120s 超时/`tool call aborted`（seq 376/378），body 后续会加 doPlan 单飞锁。

### 暂停语义（方案 B + danger pierce，2026-11-06 用户拍板）

用户原话：“将游戏在线时的危险作为穿透消息唤醒会话并自动规避危险，模型能选择暂停去干别的，但是一出事一定会被通知。”

- **暂停 = 停任务/停控制，但世界继续**：`paused=true` 只是不接新任务、中断当前任务；身体仍在世界（会掉落/受伤/被推）。
- **安全反射继续（方案 B）**：暂停期 watchdog 仍检测低血/危险方块/近身怪/水下低氧，并直接调用 `adapter.emergency` 做有界保命（默认 ≤10s/次、≤2 次/分；测试可调 `reflexMaxDurationMs/reflexMaxPerMinute/reflexEnabled`）；反射不生成新目标、不自动 resume。
  - 事件 `reflex {reason, danger, action, durationMs, timedOut, windowCount}`；被限频时 `reflex_suppressed`；`status.safety.reflex`/`lastReflex` 暴露是否开启与最近一次自动规避。
- **危险一定穿透**：`safety_stop/death/spawn_unsafe/kicked/reconnect_exhausted/quarantine/idle_disconnect/emergency/reflex` 事件带 `priority:"alarm"` + `pierce:true`；危险 watchdog 告警（`watchdog` + severity=danger，如 low-health/danger-block/low-oxygen/stuck）也带 pierce，不受 danger 配额静默。
  - 15s 去重（`alarmDedupeMs`）：被去重时记 `alarm_suppressed`（含 redeliverInMs），窗口到点由 watchdogTick **补投**（`redelivered:true`），`status.safety.alarms` 有 delivered/suppressed/redelivered/pending 计数。
  - 暂停中发生更严重事件（death/quarantine/spawn-unsafe/danger-block/low-oxygen/stuck/health-drop/connection-stale/low-health）即使不改变 paused 状态也 pushAlarm。静音策略由 mc-link 决定（time 侧默认连 alarm 一起拦是用户拍板；body 只保证事件可穿透，不假设一定穿）。
- **`mcb_stop` 对应 body 行为**：`POST /v1/safety/stop` 或 `{"op":"stop"}` → **cancel 当前+队列任务、进入暂停（reason `user-stop`）、保持反射、返回分开的回执**：
  - `task: {cancelled:[...], note:"任务已停（取消 N 个）"}`；
  - `body: {online, position, health, food, note:"身体仍在世界…安全反射保持开启" / "身体不在世界…"}`；
  - `reflex`/`safety`（alarm/pierce 标记）。暂停中可直接调用 stop，不需要先 resume；stop 属于安全 op（不受单飞锁/暂停写动作限制）。
- **恢复**：`/v1/safety/resume`（或 `{"op":"resume"}`）解暂停后可继续下任务；被 stop 取消的任务需要重新下；断线 `paused` 的任务在 body resume 后用任务级 `resume` 显式继续。
- **E6/E7**：`status.playable {ok, blockers}`（join 后可玩布尔：offline/paused/spawn-unsafe/reconnecting/dead）；`status.spawnLog`（最近 10 次 spawn：位置/维度/来源/安全判定细节）。

### 与 time / mc-link 的接口对齐（2026-11-06，time `fd81f56` 语义）

- **mcb_stop** → body `pausedReason="user-stop"` 且返回任务/身体分开的回执；mc-link 负责调 `time.setPausedMode({active:true,reason:'mcb_stop',source:'mc-link'})` 和恢复 `{active:false}`；body 不改 time 协议，只是“任务停止、世界继续”。
- **alarm 穿透**：body 只保证事件带 `priority:"alarm"`+`pierce:true` 且不因 pause 而丢（去重记账+窗口补投），并在 `status.safety.alarms` 记 delivered/suppressed/redelivered/pending；**是否被静音/睡眠拦截由 mc-link/time 决定**（time 默认连 alarm 一起拦：body 不假设“静音里 alarm 一定穿”；上层若拦了，用 body 的 alarm_suppressed/redelivered 计数对账）。
- **睡眠期**：body 的 safety_stop 照旧独立执行（不等模型）；alarm 事件在 mc-link/time 侧进 `priority:'alarm'` 积压，醒来简报第一条呈现。
- **E6/E7**：`status.playable {ok,blockers}` 给 mc-link join 后可玩判断；`status.spawnLog` 给 spawn 排查。

- **alarm 标记三层**（给 mc-link/time 任一层识别，避免只透传一层就漏）：事件对象顶层 `priority:"alarm"`+`pierce:true`、`data.priority/pierce`、`data.meta.priority/pierce`；覆盖 ALARM 类型与危险 watchdog（`watchdog` + severity=danger：low-health/danger-block/low-oxygen/stuck/health-drop/connection-stale）。`status.safety.alarms{delivered,suppressed,redelivered,pending}` 口径：**body suppressed>0 是 body 内部 15s 去重/待补投，不代表 time/mc-link 漏收**。
- 字段名稳定不改：`pausedReason:"user-stop"` ↔ time `pausedMode.source/reason`；`safety.reflex/lastReflex`、`playable`、`spawnLog` 只读对齐。

- **pausedReason 规范值**：`mcb_stop` 不管调用方传 `reason:"mcb_stop"|"manual"|"api"|"stop"`，body 一律把 `pausedReason` 置为 **`user-stop`**（便于与 time `pausedMode.source/reason` 对账），原始原因保留在 `requestedReason` / `safety.requestedReason`。真服 smoke（54839，`.state/lab/mc-body-soak/pause-smoke/`）已验证：stop 回执任务/身体分开、`safety_stop` 事件顶层+data+meta 三层 alarm/pierce、暂停中 stop 幂等/查询可用/写动作 409、resume 后新任务 done（net 3）。

## 看屏幕（MC-EYES）

MC body 本身无渲染；“能不能真看屏幕”的三方案对比、推荐、PoC 与实测数据见 [`docs/MC-EYES.md`](../../docs/MC-EYES.md)。
PoC：`node packages/mc-body/tools/eyes-poc.mjs --viewer-root <prismarine-viewer 安装目录> --out <png>`（离线区块 → viewer → Edge headless 截图；不占 GPU 模型锁）。

## 战斗与自动躲避（MC-COMBAT）

有敌对生物时的追杀/防守/逃跑任务与自动躲避（未暂停也生效）见 [`docs/MC-COMBAT.md`](../../docs/MC-COMBAT.md)。
body task kind：`hunt / defend / flee / guard`；自动躲避事件 `auto_defense`、威胁暂停 `safety_stop(reason=threat)`；参数/失败码/验收在文档。
