# 开一局 / 操作手册

## 一行宏链（常用组合，直接照抄改参数）

1. 采集→合成→装备：`{"steps":[{"op":"task","kind":"collect","params":{"item":"oak_log","count":8}}]}` → 完成后
   `{"op":"craft","params":{"item":"oak_planks","count":16}}` → `{"op":"equip","params":{"item":"stone_pickaxe"}}`。
2. 挖通道→下矿：`{"op":"task","kind":"tunnel","params":{"direction":"east","length":16,"height":2}}` → `{"op":"task","kind":"collect","params":{"item":"iron_ore","count":8}}`。
3. 打架→捡掉落：`{"op":"task","kind":"hunt","params":{"target":"nearest_hostile"}}`（或直接 `mcb_combat {mode:"hunt"}`）→ 打死后 `{"op":"pickup","params":{"radius":8}}`；逃跑用 `mcb_combat {mode:"flee"}`。

**原则：重复劳动（采集/挖/建/打整场）用宏 task 或战斗宏；单步 op 只做少量/精确动作。**

## 想玩 / 被叫去玩（连接）

1. `mcb_servers` 看已知服务器（flat 测试服、survival）；用户在自己客户端里开了"对局域网开放"时用 `mcb_lan`。
2. `mcb_join {server:"flat"}`（或 `{host:"127.0.0.1", port:54837}`）。它负责启动身体并等到真的连上，**不**替你建专注或目标。
3. 连上先 `mcb_status` 或 `mcb_look`：位置、血量、周围有什么。不要凭印象说"我在挖矿"。
4. 只想随便玩一会儿：直接玩。想认真投入（下矿、建家、长途目标）：先 `focus_enter`，再
   `time_arrange {mode:"goal", focus:"mc", theme:"在 MC 里做什么"}`，让游戏里的事能持续叫醒你。

## 做事（下任务）

- **重复劳动用宏，不要逐方块 mine/goto/dig**（用户看到过"10 分钟逐块挖同一种资源数百方块、没有结构产出"的退化）。
  一条宏调用 = 一个 body task：自动找目标、自动换工具、自动计数、自动拾取，模型只负责"做什么/要不要停"。
  - 批量采集：`{"op":"task","kind":"collect","params":{"item":"oak_log","count":16,"radius":24}}`（详见 `mcb_help collect`）
  - 挖直线隧道：`{"op":"task","kind":"tunnel","params":{"direction":"east","length":8,"height":2}}`
    （向下阶梯：`"stairs":true`；只支持向下，向上要水平挖+垫脚。详见 `mcb_help tunnel`）
  - 同族宏（beta，真服验收先看 collect/tunnel）：`bridge`（向前铺路）、`build`（按 blueprint 搭）、`shelter`（避难所）、
    `sort`/`deposit`（整理/存箱子）、`farm`（开垦播种：需要锄+种子+水边土）
  - 宏的 progress 限频（每 5–10% 或 10s），**提交后不要用 wait 轮询**；`{"op":"tasks"}` 查、`{"op":"cancel","taskId":"t-1"}` 停、`{"op":"resume","taskId":"t-1"}` 续。
- 原语长任务（少量/精确动作时才用）：`mine`（block/count/radius）、`goto`（x/y/z/range）、`patrol`（points）、`explore`（radius）、`follow`（player）、`routine`（durationMs，持续采集/生存）、`chat`（text）
  - 立即返回 taskId，进度/完成/失败会作为事件回来。**同一件事不要连发多个 task**，先查 `{"op":"tasks"}`。
  - **长动作一律用 task 形式**；并发单步长动作会被 body 挡回 409（"上一个 do 动作还在执行"）。
- 单步动作：`dig`/`place`/`use`/`equip`/`toss`/`pickup`/`attack`/`eat`/`face`/`wait`/`craft`/`furnace`/`chest`/`trade`/`move`。
  它们会阻塞到完成（最长约 120 秒）；超时只说明"没及时返回"，先查状态，别原样重试。
  - **打架优先用战斗宏** `mcb_combat {mode:"hunt|defend|flee|guard"}`（自动选武器/走位/低血中断），别逐次手动 attack；
    单只补刀用 `mcb_attack {target}`（结果有 hit/伤害/血 before→after/killed；killed 后用 pickup 捡掉落）。详见 `mcb_help combat`。
  - **捡地上掉落物用 `pickup`**：`{"op":"pickup","params":{"radius":8,"max":8}}` → 返回 `picked/items/left`；
    不要用 `goto` 到自己脚下坐标站着等（尸体掉落/挖后掉落都好用）。
  - 坐标两种写法都行：`{"op":"dig","params":{"pos":{"x":12,"y":-60,"z":14}}}` 或 `{"op":"dig","params":{"pos":[12,-60,14]}}`；
    也可以不给坐标，按名字找最近的：`{"op":"dig","params":{"name":"dirt","radius":4}}`。
  - 放置：`{"op":"place","params":{"pos":{"x":12,"y":-60,"z":14},"item":"dirt"}}`。
  - `wait` 用 `{ms}`（不是 durationMs）；`routine` 用 `{durationMs}`。
- 扫描/地图的硬限制（写错会误判"没有"）：
  - `mcb_scan`：`radius` 默认 16、最大 48；`count` 默认 8、最大 64；结果按距离升序，到上限会附一句"可能还有更多"。
  - `mcb_map`：`radius` 默认 4、最大 8。
- 查台账：`{"op":"tasks"}`；查事件：`{"op":"events"}`（默认只列上次之后的新事件）；取消：`{"op":"cancel","taskId":"t-1"}`。
- 游戏里说话：`{"op":"say","text":"..."}`（≤200 字，不能以 `/` 开头）。做大事前说一句，任务完成或失败也说一句。

## 读懂事件（它们不是用户对你说的话）

- `[MC] 任务完成`：`task_done`，body 判据真的达成（mine 是背包净增达标；routine 是时间到/数量达标）。
- `[MC] 任务失败`：`task_failed`，`error` 里是原因码（`mine: no-target` / `no-path` / `dig-failed` / `no-effect`、
  `routine: stuck`…），消息里已经写了下一步。不要原样重下，先按原因改参数或换目标。
- `[MC] 任务超时，结果未知`：`task_unknown`。动作可能已生效——**不能当失败也不能当成功**，
  先 `mcb_status`/`mcb_inventory` 复核再决定。
- `[MC] 任务暂停（断线）`：`task_paused`。任务没失败，被挂起了；重连后身体仍是暂停状态，
  先 `{"op":"resume"}` 解除暂停，再 `{"op":"resume","taskId":"t-x"}` 继续这个任务（不会自动续跑）。
- `[MC] 任务中断`：`task_interrupted`（死亡/低血/卡住/断线触发安全停止）；任务不会自动续跑。
- `[MC] 安全停止`：身体自己暂停了（death/health-drop/low-health/low-oxygen/stuck/disconnect）。暂停期间大部分动作会被拒绝；
  恢复用 `{"op":"resume"}`。不想硬撑就 `mcb_leave` 收尾。
- `[MC] 掉血/死亡`：同类事件会合并限流，不要因为没收到每一条就以为没发生；以 `mcb_status` 的血量为准。
- `[MC] 身体进程退出了：…`：body 进程没了（不是任务失败）。通知里会带原因分类（崩溃/被外部结束/暂停超时/重连耗尽…）、
  退出码、死时任务与位置、栈首行，以及"本会话第 N 次同因退出"+建议。处理顺序：先 `mcb_status` 看背包/位置 →
  再决定 `mcb_join` 重连（旧任务不会续跑）还是 `mcb_leave` 收尾。同一类死法第 2 次起，别原样重试，换区域/换手动做法。
- `[MC] 身体离线/重连失败/恢复要求`：断线相关。`resume_required` 表示已重连但仍暂停；`reconnect_exhausted` 表示
  自动重连放弃，要 `mcb_join` 才会重新起身体。
- `[MC] Hahn123_：...`：玩家在游戏里说话。叫到你的名字时会穿过普通专注。

## 暂停 vs 离开（别混）

- **`mcb_stop` = 暂停**：停掉当前任务 + 触发 body 安全反射；**身体仍留在世界**（会掉落/受伤/被推），只是不接任务；
  同时 time 进入暂停模式（世界继续、计时不冻结、goal/focus/schedules 都保留）。不需要先 resume，幂等。
- **`mcb_leave` = 离开世界**：结束 body 进程；想保留身体在世界里用 `mcb_stop`，别用 leave。
- **继续**：`time_resume` 或 `{"op":"resume"}`（会自动退出 time 暂停模式）。**离开**：`mcb_leave` / `time_cancel`。
- **危险一定通知**：死亡/低血/安全反射/被踢/断线/隔离是 alarm；暂停/睡眠期间如果被 gate 拦住，mc-link 会暂存并在
  gate 打开后补投（`mcb_status` 里"危险补投：N 条"就是它们）；睡眠中的 alarm 进 time 积压，醒来简报第一条会写
  "⚠ 睡眠期间有 N 条危险/紧急事件"。静音默认连 alarm 也拦，别假设静音里一定能穿。

## 长任务：提交后别用 wait 轮询

- `{"op":"task",...}` 立即返回 taskId；**完成/失败/暂停/结果未知会作为事件自己回来**，不用守着。
- `wait` 单次最多 30 秒，连续 `wait→tasks→wait` 只是空转；真在等的时候可以用
  `mcb_inventory`/`mcb_scan`/`mcb_map` 规划下一步（这些不会催任务，也不会重置进度）。
- 任务中途卡住：body 会发 `[MC] 走不过去…`，但**单次**只是重算路线，常随后就成功；连续多次或真的
  `task_failed` 再换目标（别看到一条就 cancel）。
- 想知道进度就查一次 `{"op":"tasks"}`；不要为了刷进度反复 `wait`，**也不要循环 `mcb_status`/`tasks`**（E2 审计里 wait 104 次/49 分钟、tasks 61 次/29 分钟就是这么来的）。只在需要决策时查一次。

## 暂停了怎么办（别只说 resume）

暂停=停任务/不接活，身体仍在世界；**不处理原因直接 resume 会被再次暂停**。按 pausedReason 处理：

| pausedReason | 先做什么 | 再 |
|---|---|---|
| `low-health` / `health-drop` | `eat` 或 `goto` 掩体/安全点，血回上去 | `{"op":"resume"}` |
| `low-oxygen` | 回水面/离开水下 | resume |
| `spawn-unsafe` | `goto` 到安全位置 | resume |
| `death` / `quarantine` | 复活后 `goto` 安全点 / 等隔离结束 | resume（旧任务不会续跑） |
| `disconnect` | 等 body 重连 | 重连后仍暂停，显式 resume |
| `stuck` | `mcb_map` 看地形 + `goto` 脱困 | resume |
| `user-stop`（mcb_stop） | 直接 resume 继续，或 mcb_leave 离开 | — |

暂停期间仍可用：`look`/`inventory`/`map`/`scan`/`move`/`eat`/`cancel`/`tasks`/`events`/`resume`/`stop`。

## 睡觉（sleep）

- 夜里/雷暴才能睡，附近要有床（或能放床）。`{"op":"sleep"}`；没床/白天会明确报错，别硬试。
- 睡醒或没睡成都不用等：`mcb_status` 会显示时间和位置。
- **睡着时身体会被管理面收起来**（避免夜里被怪反复击杀）：`time` 处于 sleeping 时 `mcb_join` 会被拒绝，
  不要自己重连；醒来后再 `mcb_join`。只有用户明确要求"现在就去玩"时才用 `mcb_join {force:true}`。
- **睡眠期只能收尾**：`mcb_leave` / `mcb_status` / `mcb_look` / `mcb_inventory` / `{"op":"tasks"}` /
  `{"op":"events"}` / `{"op":"cancel"}` / `{"op":"say"}`；新的 `task`、`dig`、`goto` 等动作会被拒绝
  （"醒来再做"）。要睡之前把手里的任务 cancel 掉、说一句晚安、必要时 `mcb_leave`。

## 收尾（离开）

1. 收工想干净：`mcb_leave {"cleanup":true}` —— 停 body + 释放自己的 focus 租约 + 取消 `focus=="mc"` 的 time 持续目标
   （不碰闹钟/积压/时间锁；返回值会报哪些清了、哪些还挂着）。
2. 只离开游戏、想保留专注/目标：默认 `mcb_leave`（只停 body），返回值会列出还挂着哪些 focus/goal。
3. 两条路径都幂等：可以再调一次确认"没有可清的东西"。
4. 之后 `mcb_status` 应显示未连接；下一轮想玩重新 `mcb_join`。

## 失败怎么办

| 现象 | 下一步 |
|---|---|
| `mcb_join` 报进程退出/日志 connect refused | 服务器没开或端口错；确认后重试 join |
| `mcb_join` 报端口上已有未连接的 body | 那是别的会话/手动起的；先手动结束它，或换 listenPort |
| `mc-body 没响应` | `mcb_status` 看进程；`mcb_leave` 后重新 `mcb_join` |
| 任务失败 `no-target` | `mcb_scan` 换块名/调大 radius，或换任务 |
| 任务失败 `no-path`/卡住 | `mcb_map`/`mcb_look` 看地形；goto 到开阔处，或换目标 |
| 一直死 | 别硬拼：暂停→goto 安全点/挖掩体/等天亮，或 `mcb_leave` 收尾 |

## 夜晚与过夜（长测常卡）

- 天黑前：先看 `mcb_status` 的血/饱食/位置；离家远就 `goto` 回出生点/洞。
- 有床：`mcb_do {"steps":[{"op":"place","item":"bed","pos":{...}}]}`（床要 2 格空间+下方实心）→ `{"op":"sleep"}`。
- 没床：找一个 3 格坑/山洞，`dig` 进去用 `place` 堵口；**不要**在开阔地硬站。
- 睡觉只能在夜里/雷暴；`sleep` 报"只能夜里"说明现在是白天（别重复试）。

## 死亡回收

- 死亡事件会带 `lastDeath.position`（status 里也有 `adapter.lastDeath`）。**先别急着重跑**：
  1. `mcb_status` 确认已复活、血/饱食；
  2. 清掉死亡点附近怪（`mcb_look` 看附近），再 `mcb_do {"steps":[{"op":"goto","params":{"x":..,"y":..,"z":..,"range":2}}]}`；
  3. 到点后 `mcb_inventory` 对比，`{"op":"events"}` 看有没有捡到；5 分钟后掉落会消失。
- 死太多次（body 连续 3 次死亡会隔离/断开）：先停下，别硬送。

## 背包满

- `mcb_status` 的 `adapter.inventory.full=true` 或 mine 报 `mine: inventory-full`：先 `{"op":"chest","action":"put","all":true}` 存整包（工具/装备/食物默认不存），或 `toss` 掉没用的。
- 存完 `mcb_inventory` 确认有空格再继续挖。

## 出发前吃

- 长任务（挖矿/跑图）出发前先 `{"op":"eat"}` 吃到饱食 >14；包里常备食物（面包/熟肉/苹果）。
- body 会在 mine/goto 前和 mine 循环里自动吃，但**包里没食物时吃不了**——先补食物。

## 装备/工具（自己拿对工具，2026-11-06）

- 先 `mcb_inventory`：看“手持（快捷栏 N）”“快捷栏：★1 ... ｜ 2 ...”，每件工具标了 `(pickaxe/axe/shovel)` 和耐久。
- 换手持：`mcb_do {"steps":[{"op":"equip","params":{"item":"stone_pickaxe"}}]}`；或直接选中快捷栏：`{"op":"equip","params":{"slot":3}}`。
- 挖之前确认：石头/矿石要**镐**，木头用斧/空手，土用锹。body 会在 mine/dig 前自动换对工具，并在结果里注明；**如果背包没有合适工具，任务会立刻失败并告诉你下一步做什么**（比如“先 craft stone_pickaxe”），不要原地重试。
- 想自己决定用哪把：mine/dig 传 `"autoTool": false`，然后自己 equip。
