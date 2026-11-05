# TIME 夜间长测报告（night-1）

> 读者：判断时间模块在真实 8h 生存长测里是否按契约工作的人。
> 数据源：只读 `time.json` / `transcript.md` / `events.jsonl` / `memory.db`（拷贝扫描）+ mc-lab supervisor metrics；
> time 侧独立巡检脚本 `tools/time-night-check.mjs`（OS watcher，每 5 分钟）。
> 核对时间：2026-11-06 06:55。**实际 06:51 提前结束**（supervisor 脚手架 TDZ，已修 `6218391`；8h 未跑满，实际 00:26–06:51 ≈ 6h25m），睡眠/醒来/dawn 窗口完整覆盖；本文按实际结束定稿。

## 0. 长测元信息

| 项 | 值 |
|---|---|
| run | `C:\DSH\icl-wt\mc-lab\.state\lab\night-1` |
| 端口 / preset | 57101 / `icl-mc-lab`（含 loop-probe） |
| 模型 | 本地 `ninfer/coder390-27b-q3-df-4x500` |
| 会话 | 起跑 00:26:02；两次重启后 `session-5d3e76be`（01:35:55，commit ca01099） |
| time 文件 | `state/icl-mc-lab/time.json`；控制后门 inbox/outbox 同目录；旧构建无 `time-events.jsonl` |
| 期望窗口 | 02:09:05 入睡 → 06:39:06 醒 → 06:49:05 dawn（全部按时发生） |
| mc-lab 终稿 | `night-1/morning-report.md`（+ `final-summary.json`/`validity-awake.json`）；醒着 validity：活跃 81.4% / 等待 19.3% |
| 实际结束 | **06:51 提前结束**（supervisor 脚手架 TDZ，mc-lab 修 `6218391`；8h 未跑满 ≈6h25m）。资源已收：lab/observer/body 停、57101/54902 无监听；用户 Fabric 客户端未触碰 |

## 1. 四问结论（全部通过）

| 问题 | 证据 | 结论 |
|---|---|---|
| **我什么时候被唤醒** | `night:main-sleep` once @02:09:05 触发一次、`fired["night:main-sleep@2026-11-06"]` 写入；`night:dawn` @06:49:05 只响一次（seq 2698，"天亮了，该起了。"），`fired` 两个键、dawn 从 schedules 消费 | ✅ 到点一次、跨重启不重复 |
| **醒了要干什么** | 睡眠期 17 条外部消息全部 `mc / reason=sleeping` 进积压；06:39:06 醒来 `queue=[]`，同一条投递（seq 2298）按"整理完了。… →（你睡觉时）积压了 17 条消息：…"顺序释放，N 与 queue 一致 | ✅ 拦截/积压/批量释放顺序正确 |
| **接下来如何行动** | 醒来后 `phase=awake`、`spans=[]`、`since=06:39:06`；dawn 独立唤醒；无 goal（本测未建 goal，goal 路径由单测覆盖） | ✅ 状态机正确 |
| **长期日程** | 一次性安排响后从 `schedules` 消费，`dream:nightly` 每日安排保留未误触发；`fired` 只含当天键 | ✅ |

## 2. 睡眠与积压明细（本次长测核心）

- 入睡：02:09:05 `phase=sleeping`、`sleepingId=night:main-sleep`、`sleepUntil=span.until=1793918346268`（06:39:06）；`since=02:09:06`。
- 睡眠期队列：17 条，**全部 `from.plugin=mc`、`reason=sleeping`**；`plugin:mc` 投递 0 条、`plugin:time` 仅入睡消息 1 条 → signals gate 正常；`turn-end` 事件没有进积压（事件路由不拦）。
- 醒来：06:39:06 `phase=awake`、`spans=[]`、`queue=[]`；06:39:07 一条合并投递（结束语+积压摘要），transcript 只出现 1 次"整理完了"、1 次"积压了 17 条"。
- 健康：全程 `stats={dropped:0,missed:0,expired:0,overflow:0,failed:0,inboxBad:0}`；无 `tick-error.json`/`inbox-error.json`/`*.corrupt-*`；`lastTickError/lastPersistError=null`。
- 巡检：OS watcher 从 02:09 到 06:25 共 **51+ tick，全部 `phase=sleeping`、errors=0**；queue 10→17 单调增长（body 死亡/安全停止事件持续入队）。

## 3. dream

入睡瞬间 `sleep-start` 事件触发 dream（time 只发事件，不实现 dream）。memory.db（只读拷贝扫描）确认 **2026-11-06 dream-run 在 02:09:06.272 跑完**：
`wash {lines:1119,totalLines:1119,omittedLines:0,chars:138779}`、`consume {written:0,archived:0}`、`index {indexed:0,missing:2}`。
mc-lab 侧同源确认。结论：**睡眠触发 dream 的接缝正常**；consume/index 为 0 是因为当晚没有待消费内容，不是失败。

## 4. 跨重启恢复

- 00:33 第一次重启：`loop-probe.resetOnStart` 默认 true 调了 time reset → `time.json` 清空（watcher 抓到 `schedules=[]`）。**测试脚手架吞噬 time state**，不是 time 恢复失败（已在 `TIME.md §9` 记风险）。
- 修复：`icl-mc-lab` 设 `pluginConfig.loop-probe.resetOnStart:false`（mc-lab commit）；00:50:22 / 01:35:55 两次重启后：
  `night:main-sleep@02:09:05`、`night:dawn@06:49:05`、`dream:nightly` **原样保留、未平移**，queue/fired 连续；最终 02:09 入睡、06:39 醒、06:49 dawn 全部按原计划。
- 结论：time 的落盘+恢复语义成立，前提是测试 reset 不能误清。

## 5. 事故与边界问题（均非 time 拦截逻辑错误，但影响 validity）

1. **睡眠期 9 条 supervisor 直投**（02:09:56–02:11:27，events `source.kind='user'`）：这些是 supervisor 醒着时投递、被 DSH 会话队列攒到睡眠边界才送达；期间模型在 `phase=sleeping` 下跑了工具。最后 `turn/end=02:11:56`，之后 0 条。mc-lab 02:22 加 phase/lock 守卫、02:32 加睡眠边界处理（stop playbook → 120s grace → 在飞 turn 一次 cancel → 清队列），skipped=0、sleep-guard=0、`sleep-delivery-leak` 0。
   - **属于"直接 session/prompt 绕过 signals gate"**：time 只能拦 `signals.offer(to:'model')`/delivery.push。已写入 `TIME.md §9`，外部注入方应先读 `phase+lock` 或改走 signals。
2. **睡眠边界 in-flight turn**：入睡时有一轮在飞（"收个尾"）是设计允许的；产品语义定为 **B+有界兜底**（grace 120s 内结束=合法收尾；超 grace 由 supervisor 一次 cancel；入睡后新 turn=violation）。time 侧 `sleepBoundary/lastSleepBoundary` + `time-events.jsonl` 已实现（commit `275ba83`/`c36c769`，本次未部署），supervisor 已实现消费（`4ea7a2b`）。
3. **旧构建无 `time-events.jsonl`**：早报按"无数据≠无边界事件"标注；合并后首个睡眠周期起生效。

## 6. 时间侧验收项

| 项 | 结果 |
|---|---|
| 到点唤醒一次、跨重启去重 | ✅ |
| 睡眠 gate：外部消息进积压、事件不进积压、time 自己消息放行 | ✅ |
| 醒来批量释放（顺序+计数一致、有界摘要） | ✅ |
| daily/once 安排响后消费、fired 按天 | ✅ |
| 无静默失败：tick/inbox/persist/corrupt/stats | ✅ 全 0 |
| 队列有界/无溢出 | ✅ max 17 << 500 |
| dream 接缝 | ✅ 入睡即跑 |
| 日志可诊断 | ✅ 无 error 文件；watcher 51+ tick |

## 7. 待办（测试已结束 / 部署后）

- **8h 未跑满**：00:26–06:51 提前结束（supervisor 脚手架 TDZ，非 time 问题）。睡眠/醒来/dawn 核心窗口已完整覆盖；若需要完整 8h soak，在 mc-lab 修复后补跑一次即可，time 侧无改动需求（部署后顺带验证 awake-tick 连续循环）。
- **部署**（mc-lab 醒来后一次性重启合并）：awake-tick（清醒节拍）、`turn-start` bridge 事件、`sleepBoundary` + `time-events.jsonl`、`sleepGraceSec=120` —— 然后在真实会话验证"醒着连续调用/无静默等待"与边界事件消费。
- 产品化建议：所有外部注入方直投前读 `time.status().phase` + `lock`；supervisor 消费 `sleep-boundary-overrun` 只记 anomalies、cancel 由本地 grace 触发一次。

## 8. 证据路径

- `night-1/state/icl-mc-lab/time.json`、`transcript.md`、`events.jsonl`、`state/memory.db`
- `night-1/sleep-direct-injections.json`（9 次直投明细）、`skipped-injections.jsonl`（size=0）、`strategy.jsonl`、`anomalies.jsonl`
- time 侧：`.state/night-watch.jsonl`（5 分钟一行）、`.state/wake-snapshots/{wake-064030,dawn-065030}.json`（06:40/06:50 独立快照）
- 巡检工具：`tools/time-night-check.mjs --run <runDir>`；`--loop --night-only` 每 5 分钟落盘
