# 晨间报告：E1 夜间长测 + 夜间交付（2026-11-06）

> 读者：用户。长测 `night-1` **00:22–06:51（6h29m）**，本地 coder390，54838 survival，bot ICL-night-1；预算 8h，**因 supervisor 测试脚手架 TDZ bug 在 06:51 提前退出**（核心睡眠/醒来/dream/dawn 全链路已覆盖）。细节证据：`.state/lab/night-1/`（morning-report.md / metrics.jsonl / anomalies.jsonl / checkpoint/ / strategy.jsonl / final-summary.json）。

## 1. 一句话

**她活过了一整夜的核心段**：02:09 按时入睡、睡眠期零打扰、06:39 按时醒、积压 17 条**一条合并消息**释放、06:49 dawn 只响一次、dream 在入睡瞬间跑完（wash 1119 行/138779 字符）；醒后自动重连继续活动。期间暴露并修复 4 类真问题 + 2 个测试脚手架 bug，并完成你提的两个设计转向（装备归模型、宏操作）+ 连续思考/心跳基础设施。

## 2. 时间线（本地时间）

| 时刻 | 事件 |
|---|---|
| 00:22 | night-1 起跑（8h 预算，本地模型，54838 survival） |
| 00:35–00:50 | 两次 lab 自愈重启（breaker 触发）；`resetOnStart:false` 后 time 状态跨重启保留 |
| 00:53 | 装备设计转向部署（body 自动换工具/needsTool，真服验证 inventory/equip/mine） |
| 01:20–01:37 | 退化统计窗口：154 calls / `mcb_status` 101（65%）/ mine·dig 22 全 stone / 目的表述 0 |
| 01:56–02:08 | 睡前收兵偏晚 + 夜间怪 → 连续死亡（本代 8–10 次） |
| **02:09:05** | **按时入睡**（`phase=sleeping`、sleepUntil 06:39:06、queue 开始积压） |
| 02:09:56–02:11:27 | 睡眠边界直投 **9 次**（醒着时投递、被会话队列攒到边界送达）；02:11:56 后静默 |
| 02:22 | supervisor `sendPrompt` 硬短路（phase/mode/lock），`skipped=0` |
| 02:34 | body 被在飞 turn 的 `mcb_join` 复活、被怪连杀 3 次 → quarantine；02:42 收尸 + `sleep-body-reap` |
| **02:09:06** | **dream 在入睡瞬间跑完**：wash 1119 行/138779 字符；consume/index 0（无内容可消费，非失败） |
| **06:39:07** | **醒来**：一条合并消息"整理完了…"+"（你睡觉时）积压了 17 条消息…"；`spans=[]`、`queue=0` |
| **06:49:06** | **dawn 只响一次**（"天亮了，该起了。"），`fired` 增 dawn 键 |
| 06:51 | supervisor 崩溃（`Cannot access 'nowMs' before initialization`，测试脚手架 TDZ bug），自动写报告后退出；修复 `6218391` + `tdz-smoke` 1min 真跑验证通过 |

## 3. 关键数字

### 运行
- 窗口 **00:22:17–06:51:12（6h29m）**；lab 代 **6**；supervisor adopt **11**；lab 自愈/熔断重启 **3**；服务器重启 **0**
- **64 turns / 1182 tool calls / 281 errors（23.8%）**
- 自愈动作：loop-breaker **20** · no-progress **9** · death 提示 **21** · paused-resume **8** · turn-timeout **9** · error-loop-interrupt **3** · survival-mode **7** · rest-mode 0
- body death 事件 **19**、quarantine 12（body 反射正常）

### validity（清醒期，阈值 120s）
- 清醒跨度 **6984s**：有模型活动 **5688s = 81.4%**，等待/静止 **1351s = 19.3%**
- >120s 空档 **9 次**，最长 **224s**
- anomalies **6 条**（turn-gap 2 / awake-idle 2 / static 2，均清醒期）；**睡眠期 0 告警**
- 睡眠 16201s 内活动事件 194 个全在入睡边界（02:09:56–02:11:56），之后 0

### 睡眠/醒来
- 睡眠时长 **4h30m**（02:09:06–06:39:06），睡眠期 **0 直投泄漏**（02:11:56 后）、`skipped=0`
- 积压 **17 条**（全 mc/sleeping），醒来**一次合并释放**、顺序正确
- dawn 只响 1 次；`fired` 去重正确

### 代码
- master **516 测试绿**；夜间合并 40+ 提交（各子任务分支全部并入/内容已入 master）
- 新文档：`MC-MACRO.md`、`MC-PROGRESSION §7/§8`、`QQ-GAP.md`、`BILI-FEASIBILITY.md`、`SANDBOX-PLAN.md`、`READINESS-MATRIX.md`、`REDTEAM-REVIEW.md`、`TIME-NIGHT-REPORT.md`、`NEXT-2026-11-06.md`

## 4. 夜间暴露并修复的问题

1. **睡眠期直投 9 次**（supervisor death/pre-sleep/playbook 在 phase 过渡期直投 + 队列残余）：`sendPrompt` 硬短路（phase/mode/lock）、停 playbook、120s grace 后 cancel、清队列、`skipped-injections` 记录；02:22 后为 0。
2. **睡眠期 body 复活**：在飞 turn 的 `mcb_join`（旧代码无守卫）复活 body 被怪击杀 → quarantine；`sleep-body-reap` 规则（睡眠期发现 body 存活先 shutdown 再 kill）。
3. **survival 模式永不恢复**：原判据要求 `deaths==0`（只增）→ 整代卡 survival；改为"最近 10 分钟无死亡+回血+有推进"（`84f1a74`）。
4. **循环断路器实战有效**：同 tool+args（成败都算）≥3/≥5、同错误、no-progress 10 calls、错误率窗口；共拦截数十次重复（含 96× goto 自捡、131× craft、32× 空 craft）。
5. **测试脚手架两个 bug**：00:36 `sleep is not a function`（局部变量遮蔽）、06:51 `nowMs` TDZ（survival 判据）；均已修 + smoke 验证，属脚手架非产品。
6. **旧代码洞（已修未部署）**：`api-shutdown` 被当 expected:false 自动重启、睡眠期 `mcb_join` 无守卫、单次 status 失败报警——`bfd78a0`/`0a5a25b`/`8693dac`/`e2aca1f` 已在 master，唤醒后 lab 重启生效。

## 5. 两个设计转向（你提的）

- **装备归模型**：`mcb_inventory` 显示手持/快捷栏/★/toolFor/耐久；`mcb_equip {item|slot}`；mine/dig 前置工具判定，错工具立即 failed+needsTool+craft 链；有更好工具 autoTool 自动换（可关）；只有战斗/低血/危险才 reflex 自动切换。真服证据：inventory seq 390/391、equip seq 726/727+773/774、mine net10 seq 370/372、auto_tool 20 次、空手挖石立即失败。
- **宏操作**：契约 `MC-MACRO.md`；**8 个宏已实现**：`collect/tunnel（含向下 stairs）/bridge/build/shelter/sort/deposit/farm`；真服 smoke：collect dirt3 6s、tunnel east5 4.4s、bridge/build 见 `mc-body-soak/macro-*`；progress 限频 5–10%/10s、可 cancel/resume、失败码可行动；`doPlan` 单飞锁（并发长 op 409）、`pickup` op、craft hint 变体选择已补。
- **连续思考/心跳（你睡前要求）**：`awake-tick`（无 goal 时 120s 自检，默认开、capped 降频）、`turn-start` 信号、`time_status.heartbeat`（lastTurnEndAt/lastModelCallAt/awakeIdleSec/nextTickAt）、supervisor 细粒度心跳与 anomalies；替代"无 goal 即静默"。

## 6. 明早部署/验收清单（建议）

1. mc-lab lab 重启一次（合并 master）：上线 mc-link 睡眠守卫/退出语义/pickup、time awake-tick/turn-start/time-events、mc-body 宏全套/doPlan/pickup、mc-lab 修复。
2. 复验顺序：`verify.mjs --mc-host 127.0.0.1 --mc-port 54840`（含 external-shutdown S 场景）→ MC 宏 `collect/tunnel` 真服 → 装备回归（空手挖石立即失败）→ awake-tick 观察（清醒 gap 应显著低于 19.3%）。
3. cache：night-1 6.5h cache 数字（清醒/睡眠分窗，双口径 hit）+ 第一屏净化后三场景回归。
4. 需要你拍板：B 站 C 路线、沙箱试点、红队 P0（第一屏净化/暂停语义/QQ 私聊穿 focus）、E2 24h 长测、是否补一次 30–60min"清醒宏/装备验收"小跑。

## 7. 长测提前退出说明（06:51）

- 原因：supervisor `tools/mc-night.mjs` TDZ（`nowMs` 未初始化），已修（`6218391`）+ `tdz-smoke` 验证；属**测试脚手架 bug，非产品代码**（body/mc-link/time/bridge 未崩溃）。
- 影响：原 8h 预算只跑 **6h29m**；但目标验证段（02:09 入睡 → 06:39 醒 → 06:49 dawn → dream）全部在退出前完成并有独立证据；错过的只是"醒来后继续玩"的 ~1.5h 观察窗。
- 决定：**未自动补跑**，等用户决定是否另开一次"清醒宏/装备验收"短跑（mc-lab 可控制在 1h 内）。

## 8. 遗留（不阻塞）

- 本地模型在 MC 长任务上的退化重复：宏已能兜住重复劳动，但"何时用宏/何时自己动手"的提示词教学还需真服 A/B 调；`autoTool` 默认 true 可改。
- 睡前收兵策略：提前 20–30 分钟、`hp≤8` 不再 resume、MC 侧 leave（supervisor 明早改）。
- 睡眠期 body 复活：新代码部署后复验（join 守卫 + api-shutdown expected + sleep-body-reap）。
- `time-events.jsonl` 旧构建缺失（预期），新构建部署后验证。
- dream consume/index 0 需一次"有内容可消费"的梦境验证（下次长测）。
- 三问未采集（06:51 崩溃在访谈前），下轮补。
- 第一屏净化（红队 P0-1）尚未实施；等用户拍板。
