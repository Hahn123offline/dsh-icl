# 开一局 / 操作手册

## 想玩 / 被叫去玩（连接）

1. `mcb_servers` 看已知服务器（flat 测试服、survival）；用户在自己客户端里开了"对局域网开放"时用 `mcb_lan`。
2. `mcb_join {server:"flat"}`（或 `{host:"127.0.0.1", port:54837}`）。它负责启动身体并等到真的连上，**不**替你建专注或目标。
3. 连上先 `mcb_status` 或 `mcb_look`：位置、血量、周围有什么。不要凭印象说"我在挖矿"。
4. 只想随便玩一会儿：直接玩。想认真投入（下矿、建家、长途目标）：先 `focus_enter`，再
   `time_arrange {mode:"goal", focus:"mc", theme:"在 MC 里做什么"}`，让游戏里的事能持续叫醒你。

## 做事（下任务）

- 长任务（会自动寻路、持续采集）：`mcb_do {"steps":[{"op":"task","kind":"mine","params":{"block":"oak_log","count":4,"radius":16}}]}`
  - kind：`mine`（block/count/radius）、`goto`（x/y/z/range）、`patrol`（points）、`explore`（radius）、`follow`（player）、`routine`（durationMs，持续采集/生存）、`chat`（text）
  - 立即返回 taskId，进度/完成/失败会作为事件回来。**同一件事不要连发多个 task**，先查 `{"op":"tasks"}`。
- 单步动作：`dig`/`place`/`use`/`equip`/`toss`/`attack`/`eat`/`face`/`wait`/`craft`/`furnace`/`chest`/`trade`/`move`。
  它们会阻塞到完成（最长约 120 秒）；超时只说明"没及时返回"，先查状态，别原样重试。
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
- `[MC] 身体离线/重连失败/恢复要求`：断线相关。`resume_required` 表示已重连但仍暂停；`reconnect_exhausted` 表示
  自动重连放弃，要 `mcb_join` 才会重新起身体。
- `[MC] Hahn123_：...`：玩家在游戏里说话。叫到你的名字时会穿过普通专注。

## 收尾（离开）

1. 不要被持续叫醒：`time_cancel` 取消 goal、`focus_leave` 离开专注——这两件事 `mcb_leave` 不替你做。
2. `mcb_leave`：先安全停止，再结束**本会话启动的** body 进程。之后 `mcb_status` 应显示未连接。
3. 下一轮她再想玩，重新 `mcb_join`。

## 失败怎么办

| 现象 | 下一步 |
|---|---|
| `mcb_join` 报进程退出/日志 connect refused | 服务器没开或端口错；确认后重试 join |
| `mcb_join` 报端口上已有未连接的 body | 那是别的会话/手动起的；先手动结束它，或换 listenPort |
| `mc-body 没响应` | `mcb_status` 看进程；`mcb_leave` 后重新 `mcb_join` |
| 任务失败 `no-target` | `mcb_scan` 换块名/调大 radius，或换任务 |
| 任务失败 `no-path`/卡住 | `mcb_map`/`mcb_look` 看地形；goto 到开阔处，或换目标 |
| 一直死 | 别硬拼：暂停→goto 安全点/挖掩体/等天亮，或 `mcb_leave` 收尾 |
