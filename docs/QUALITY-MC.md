# MC 子系统质量审计（QUALITY-MC）

> 状态：**只读审计**（2026-11-07）。未改代码、未跑测试、未起 lab/服；只读 master 工作树与 mc-lab 证据目录。
> 审计对象：`packages/plugins/mc-link`、`packages/mc-body`、`tools/{mc-e2,mc-night,mc-quality,latency-analysis,mc-replay,death-watch,e2-scenarios,macro-usage,reaction-latency}.mjs`、`docs/MC-*`、`docs/E2-HARNESS.md`、`docs/L2-SOAK-PLAN.md`。
> 代码基线：master `649c8dd`（2026-11-07）。证据基线：mc-lab worktree `C:/DSH/icl-wt/mc-lab`（HEAD `498b339`）下的 `.state/lab/e2-20261106-{smoke,soak,local3}`。
> 口径声明：**本仓 `.state/lab/` 没有 e2 证据**（只有旧 soak 与 qq 证据）；E2 证据随 wt/mc-lab 分支留在该 worktree，本文所有 seq/数字均按"事件类型 + seq"引用，不混用。

## 0. 一句话结论

**工具面（传输/感知/任务提交）已经是 beta：真服多轮跑通、17 个工具齐全、失败回执带下一步。**
**但"自己在一局里活下来并把事做成"仍是 alpha：local3 90 分钟 106 个任务只成 7 个（6.6%），92 次 shelter 0 完成 0 home，12 次死亡，87 次 say 里同一句重复 49 次。**
当前阶段：**自 2026-11-06 16:45 HKT 起冻结，冻结期只做离线机制**（L1 回放器已实现、L2 分段 soak 已设计、未跑）；恢复 24h 需过 `E2-HARNESS §11.6` 的 8 项前置。

## 1. 工具面：实际能做什么，验证到哪一层

### 1.1 17 个 `mcb_*`（`manifest.json` 与 `src/index.mjs` 一致，均 17 个）

| # | 工具 | 能做什么（实现事实） | 真服证据 | 单测 | 判定 |
|---|---|---|---|---|---|
| 1 | `mcb_servers` | 读 `servers.json`（flat 54837 / survival 54838）列服务器 | 静态文件，无网络；E2 调用 5 次 | plugin.test:838 | 可用（无需真服） |
| 2 | `mcb_lan` | UDP 4445 监听 ~2s 发现局域网公告 | **无任何真服/局域网证据** | 仅注册名单 | **未验证** |
| 3 | `mcb_join` | 必要时 spawn body、等到真连上、给可玩判断（`status.playable`） | A/C/E 云端 3 连 PASS；local3 `mcb_join` 1 次（body 侧 join 4 次含重连） | plugin/lifecycle | beta |
| 4 | `mcb_leave` | 安全停止→结束本会话 body→报告残留 focus/goal | A/C/E 3 连 PASS；**E2 两轮均 0 次调用**（收尾走 body_exit/shutdown_requested） | plugin/lifecycle | beta |
| 5 | `mcb_stop` | body `/v1/safety/stop` + time pausedMode；返回任务/身体分开回执 | **整轮只被调 1 次**（soak，reason="E2 验收暂停"→`safety_stop` 同名事件，反应 1.25s）；**未做 stop→resume→pausedMode 断言** | plugin.test | alpha（body 侧另有 54839 pause-smoke 真服） |
| 6 | `mcb_shelter` | 提交 `kind=shelter` 任务，渲染 verify/缺面 | 54839 run10 **done/verify.ok/entryOk/home**；local3 仅 6 次调用、0 成功 | plugin.test:611 | beta（单场景）→ alpha（E2 现场） |
| 7 | `mcb_combat` | hunt/defend/flee/guard 一条 task | soak：hunt chicken **failed**、flee×3 **done**；local3 场景 `combat` **FAIL（no mcb_combat call）**；guard/defend **0 真服** | plugin.test:493-513 | alpha |
| 8 | `mcb_attack` | 单目标攻击（命中/击杀/伤害校验） | 54839 run6：鸡 1/2 下、第 3 下正确报"找不到可攻击目标"；E2 全程 **0 次** | plugin.test | beta（单点） |
| 9 | `mcb_status` | 在线/位置/血/饥饿/背包/任务/暂停/重连/进程 | 所有 run 的主力（local3 44 次） | events/plugin | beta |
| 10 | `mcb_look` | 视角/视线方块/附近实体 | E2 真服（local3、soak 25 次） | plugin | beta |
| 11 | `mcb_inventory` | 背包+快捷栏+每件 `toolFor`/耐久 | 真服（night-1 seq 390/391 有回执） | tools.test | beta |
| 12 | `mcb_scan` | 按名字扫方块位置/距离 | 真服（smoke 11 工具、soak 19 次） | plugin | beta |
| 13 | `mcb_map` | 脚下方块层字符图 | 真服（soak 8 次） | plugin | beta |
| 14 | `mcb_snapshot` | 结构化场景快照（毫秒级） | 真服（soak **17 次**，模型主力感知） | plugin | beta |
| 15 | `mcb_eyes` | Edge headless 截图 PNG + 落盘 | soak 调 1 次（`kind:milestone`），**结果未落档**；54839 小屋截图已能看见结构（负 Y 修复） | plugin/eyes.test | alpha（成本高、无模型侧复验） |
| 16 | `mcb_do` | 单步/长任务/台账/事件/发言；19 种 kind、~20 种 op | 真服最重（local3 95 次、soak 138 次） | 31 条 events + 60 条 plugin | beta（但见 §4） |
| 17 | `mcb_help` | 按需读 15 篇 skills | soak 3 次 | plugin | 可用 |

**真服验证分档**：多轮稳定（1/3/4/9–14/16）、单场景（6/7/8/15）、仅 1 次调用（5）、零证据（2）。

### 1.2 body 任务面（19 种 kind）

`KINDS`（`packages/mc-body/src/body.mjs:16`）：
- 原语 7：`mine|goto|patrol|explore|follow|routine|chat`
- 宏 8：`collect|tunnel|bridge|build|sort|deposit|shelter|farm`
- 战斗 4：`hunt|defend|flee|guard`（`COMBAT_KINDS`，`body.mjs:19`）

| 宏 | 真服证据 | 缺口 |
|---|---|---|
| `collect` | macro-smoke（dirt 3 done）、build-smoke（dirt 20→21）、no-resources 三档半径（`mc-body-fix-poc/run1`） | 无 |
| `tunnel` | macro-smoke 5 格 2 高 done；stairs-smoke 4 格降 2 层 done | **soak 里 `tunnel{stairs,direction:"down",length:16}` failed**（t-22），与 stairs-smoke 结果不一致，未解释 |
| `bridge` | build-smoke 平地 3 格 done（`placed:0`，只验前进/材料校验） | 真实断崖/沟壑未验 |
| `build` | 3×1 dirt 蓝图 done（`already:2,placed:1`） | 旋转、`substitute`、高层脚手架、结构验收均未验 |
| `sort`/`deposit` | 只有"附近没箱子"失败路径 | 真实存取未验 |
| `shelter` | 54839 run10 done（27 placed、verify.ok、entryOk、home 跨重启） | **E2 现场 92 起 90 败 0 done**（§4 P0-1） |
| `farm` | 只有失败路径（需锄/需种子/无水） | 真实水渠+种子完整用例未验 |
| `hunt/defend/flee/guard` | hunt 僵尸 done（5 attacks/6.6s）、flee done（run7）、auto_defense 位移 6 格、creeper→safety_stop | defend/guard 0 真服；local3 场景 `combat` **FAIL（no mcb_combat call）** |

### 1.3 只有单测/离线，没有任何真服证据的能力

| 能力 | 位置 | 说明 |
|---|---|---|
| `say` 去重（同 session 同文本 60s） | `src/index.mjs:1046-1103`，plugin.test:522 | local3 之后才加，**冻结后未再真服跑过** |
| 连续相同 steps 提醒 | 同上 1060 | 同上 |
| 失败码表驱动 + "下一步" | `ad58659`/`152b05d` | 冻结期提交，只有单测 |
| L1 checkpoint 回放（fake adapter） | `tools/mc-replay.mjs`；`docs/examples/mc-local3-examples/{shelter-3x3,collect-resource}` 2 例 PASS | 离线；**没有从 local3 真实 checkpoint 导出过完整包** |
| `path_stuck` v2 字段 | `MC-INSTRUMENTATION §2` | **只有 schema，未实现**（现字段仍只有 target/distance/pathResets/attempts） |
| L2 段 gate / segment-report / hard-stop 脚本 | `L2-SOAK-PLAN §3–§6` | **只有设计**；`mc-e2` 有 gate 校验但没有 segment-report 生成器 |
| `mcb_lan`、`guard`/`defend`、`bridge` 断崖、`build` 旋转、`farm` 成功路径、`trade`/`furnace` 真服 | — | 见 §1.1/§1.2 |

## 2. 当事人体验证据（第一人称优先，先原话后数字）

### 2.1 local3（本地 coder390，body 90min / 对话最后 15min）

| seq（类型） | 时间 | 原话 | 读法 |
|---|---|---|---|
| 34, 39, 44, 57（tool/call, say） | 08:23:07–09 | "重连回来了，16:35 睡觉，先把家收拾一下" | **同一秒到两秒内 4 连发**；不是"每轮一条" |
| 92, 98, 112, 134（tool/call, say） | 08:23:16–24 | "采土中，等够 40 块再盖小屋" | 全场 33 次 |
| 597（tool/call, say）；1468/1494/1520 | 08:26:08；08:33–08:35 | "盖小屋中，等它盖好就进去睡" | 全场 49 次；最后 2 分钟仍每 65s 一条 |
| 670（assistant/message） | 08:26:33 | "掉血了，从 20 掉到 14，现在回血到 17。撤到安全点，重新盖小屋。等它盖好就进去睡。" | 受伤后的反应仍是"继续等" |
| 1121, 1134, 1147, 1160, 1173, 1186, 1199, 1212, 1225, 1238, 1251, 1264（assistant/message） | 08:28:41–08:29:16 | "shelter 盖了但结构不完整，墙缺 9 块、屋顶缺 6 块。**等它补完**。" | **每 ~3s 复读一次，12 轮（seq 1121–1264）**；把 `incomplete` 当成会自动补完的中间态 |

数字（`freeze-forensics.json`）：turns 77、tools 149、task 106（done 7 / failed 90 / interrupted 3 / cancelled 6）、`shelter` 92 起 0 done、`home_set 0`、death 12、`safety_stop 58`、`emergency 96`、`auto_defense 22`、`task_cancelled_for_defense 6`、`alarm_suppressed 187`、`say 87`（`chat_sent 74`）、`path_stuck 65`/`path_approximate 75`/`path_recovered 17`。

### 2.2 S1 smoke 三问（`e2-20261106-smoke/interview.jsonl`，04:52:28–45Z，原文摘录）

> "**`place` 最折磨人**。它先要我给 pos/positions，给了又退回三种错：目标下方没支撑、没有可附着的面、太远（4.5 格）。……我到现在也没搞清'可附着的面'到底认不认侧面。"
> "**`mine` 的 `no-target` 有歧义**。我传 `{name:"oak_log", count:8}`，它回 no-target，但背包其实多了 4 根——目标没够数也报 no-target。于是'失败'和'部分成功'分不清。"
> "**`attack` 不看 target 名字**。我写 `target:"chicken"`，它锁的是最近实体；附近有掉落物时就变成 `{"attacked":"item"}`——我白挥了四五轮，鸡一只没死。整轮食物断线就是从这儿开始的。"
> "**`goto` 会说'到了'但人没动**。回 `{"arrived":true,"distance":0.7}`，位置一点没变，`range:0` 也一样。"
> "**`chest` 的参数位置反直觉**。我一开始把 `items` 塞进 `params` 里，回执是 `done:true` + `container:[]`——看着成功其实什么都没存。"
> "**`shelter` 宏连败三次**，三种不同的失败：材料不够 → 只完成 10/23（13 格被地形占住）→ 又材料不够。按三次就换做法的规矩，我改成自己一块块放。"
> "**那只小屋**。墙、顶、门都是我一块块放的，从里面能走出去，可从外面无论门开着还是拆了门，身体就只肯停在门口那格，死活不往里走。为什么，我现在也不知道。"
> "**血 0.09、饥饿 0 那会儿**。安全反射把动作全按死了，`resume` 完一秒又被按回去，既不能吃、不能走、也不能干脆死掉……那一段是我唯一完全没有主动权的时候。"
> "我排的两个作息（night:main-sleep / night:dawn）中途从 `time_list` 里**凭空消失了**，我只好重排一遍。"

> 这段是**修复前**（11-06 04:52Z）的证词；`attack` 假成功、`resume` 死锁、`place` 缺支撑文案、`mine` 净增、`chest` 参数在当天后续 commit 中已改。保留它是因为它同时是"工具说不清楚"的基线证据。

### 2.3 S2 soak（`e2-20261106-soak/night-notes.md`）

- "屋子封起来了。把临时填的门洞和中间柱子挖掉。……门装上了。小屋总算封顶了。" —— **她手搓 3×3 成功**；同一 run 里 `shelter` 宏 4 次全 fail（t-3/t-5/t-12/t-13）。与 `MC-BUILDING §1` 同结论：**不是不会盖，是宏的建造策略/可达性不行**。
- "没有动物可以打，鱼又差点把我送走。先不动了。" —— soak 里 `hunt chicken` failed、`attack 0`。
- soak 工具面（**跨 9 代 lab，见 P1-13**）：291 calls，`macroShare 6.5%`（19/291），`mcb_do` 138 次里 `goto 30 / place 27 / craft 17 / task 19 / dig 12 / say 4` —— **宏没取代单步**，模型仍逐格挪/放。

### 2.4 体验失败的六类归并

| 类型 | 现场证据 |
|---|---|
| 刷屏 | 87 say / 49 同句 / 同秒 4 连发（seq 34,39,44）；无 loop breaker |
| 建房不成功 | shelter 92/90/0；唯一走到 verify 的一次墙缺 9、屋顶缺 6、`skipped 58`；`home_set 0` |
| 任务无效循环 | 86 次 `needs-material`，参数几乎不变（size 3/dirt），t-4/t-5/t-6 在**同一毫秒**失败；成功后仍 0 转化 |
| 丢任务/中断 | 台账无"无终态"任务（106 全有终态），但 3 interrupted（low-health/health-drop）、6 collect 被 auto_defense 取消；另 `time_list` 两条作息消失（当事人报告，未复现） |
| 延迟 | step→tool p50 2.2s / **p95 31.4s**；turn-gap p50 1s / **p95 30s**（S1 更差：p95 121s、max 154s）；`pickup` 单次 47.1s |
| path_stuck | 65 次：`<2:7 / 2–3:11 / 3–5:14 / 5–8:11 / >=8:22`，attempts 1:29 / 2:28 / 3:8；**只有 target/distance/attempts，缺 kind/原因** |
| 战斗/躲避 | auto_defense 22 次、取消任务 6 次，但 death 12；`attack` 0 次；local3 场景 `combat` FAIL |

## 3. 成熟度（判据 + 判定）

判据（自定，与本轮 gate 对齐）：

| 等级 | 判据 |
|---|---|
| prototype | 有设计/单测；真服无证据或只跑通过一次 |
| alpha | 真服单场景跑通；核心用例有**已知必败**路径；无常驻稳定性数据 |
| beta | 真服多轮（≥3 次/≥2 场景）重复通过；失败有可读原因；限制写进文档 |
| production | 连续 3 段 L2 PASS + L3 分段 + 硬 stop/回放可复现 + 用户批准 |

| 分项 | 判定 | 依据 |
|---|---|---|
| 传输/进程/退出归因（mc-link+body 生命周期） | **beta** | A/C/E 云端 3 连 PASS；body-exit 归因、expected/unexpected、重连 20/20；54839 soak 0 death |
| 工具面（感知/提交/回执） | **beta** | 17 工具真服均有调用；失败回执 100% 带下一步（单测） |
| 自主游玩（一局里活下去并推进） | **alpha** | local3：6.6% 任务成功率、12 死/90min、0 home、刷屏 |
| 宏（collect/tunnel/build） | **alpha→beta** | 单场景真服 done，但 E2 现场采用率 6.5%、shelter/bridge/farm 未闭环 |
| 战斗 | **alpha** | 单点真服（hunt/flee），defend/guard 0 证据，local3 场景 `combat` FAIL，12 死 |
| 看（snapshot/eyes） | **alpha** | snapshot 已进主力；eyes 1 次调用、无结果留档、成本高 |
| 长跑验收机制 | **prototype** | L1 回放可用（2 例）；L2 只设计；path_stuck v2 只 schema |
| **整体 MC 子系统** | **alpha（冻结中，禁止当 beta 用）** | 判据：没有一次 24h/分段 run 达到 ≥80% shelter、≤2 死/h、同句 ≤2/h |

## 4. 不满意清单（按严重度，供以后修复；本轮只记录）

排序依据：**是否让"一局"直接失败 / 是否污染证据 / 是否会让下轮修错方向**。

### P0（一局直接失败，或结论会误导修复）

**P0-1 shelter 在真实现场不可用：92 起、90 败、0 done、0 home。**
- 证据：`local3/freeze-forensics.json`（`shelterStarts 91`/`shelterFails 90`/`homeEvents 0`）、`local3/state/mc-body/tasks.json`（shelter 92：failed 90、interrupted 2）、`MC-LOCAL3-FORENSICS §2`、`body.jsonl` seq 314/316/318（`needs-material`，`deficit:27`）。
- 反例（证明不是能力问题）：54839 run10 done+verify.ok+entryOk+home；soak 里她手搓 3×3 成功。
- 未修。修复方向应指向**宏的可达性/支撑/材料循环**，不是"她不会盖"。

**P0-2 材料诊断是对的，但没有任何一层消费它。**
- 证据（按代际时间顺序）：`have=0 / deficit=27`（`body.jsonl` seq 523，第一代）→ `have=12 / deficit=15`（seq 131）→ `have=23 / deficit=4`（seq 12，最后一代），三条都带 `available{}` 白名单。**即便只差 4 块，仍以 `needs-material` 结束**，并且她仍有 86 次同参重试。
- 结论：`cbb37f8` 的 `needed/have/deficit/alternatives` 已到位，**head 侧没有"缺 4 块就先 collect 4 块"的策略**，也没有失败冷却（`L2-SOAK-PLAN §6` 的 hard stop 未实现）。

**P0-3 say 刷屏没有真正的刹车（去重只是遮挡）。**
- 证据：87 次 say、49+33 同句、seq 34/39/44 同秒 4 连发；`alarm_suppressed 187` 说明告警在压，但聊天出口没压。
- 现状：`say` 60s 同文本去重（`index.mjs:1046`）+ 连续 steps 提醒（`:1060`）**只有单测**，冻结后无真服复验；且它只压"同一句"，**不阻断"每 3s 说一句不同的话"的 turn 循环**。
- 附带：`chatPerMinute`（默认 6）只传给 signal 合并层（`index.mjs:102`），**显式 say 不走这个预算**——"聊天限额"对模型发言形同虚设。

**P0-4 death-watch 从 6 死起"接管"，实际 5 次全部 `stop:"skip"`。**
- 证据：`local3/death-watch.json`：deaths 6/7/8/9/11，全部 `"risky":false,"stop":"skip","prompt":true`；同 run death 12。
- 结论：**"death ≥6 硬 stop"只存在于文档与设计（`E2-HARNESS §11.4`），运行期从未生效**；它只是 prompt，不是 stop。

**P0-5 任务成功率 6.6%，且"取消→重下"没有被度量。**
- 证据：done 7 / 106（shelter 0、collect 5、mine 2）；`task_cancelled_for_defense 6`、`auto_defense 22`；`MC-COMBAT` 声称的 15s hold 在 local3 只有 6 个样本，**没有"取消后 60s 内同 kind 重下"计数**（`§11.1 A` 明确要这个指标，未落盘）。

**P0-6 证据口径混乱，导致"为什么绕开 mcb_shelter"这个结论站不住。**
- 事实（本次核算）：
  - `events.jsonl` 只覆盖 **08:22:50–08:37:59（15min）**；body 覆盖 **07:05–08:35（90min、3 代 lab）**；`lab.json.labStarts=3`、`ledger_loaded=3`。
  - 该 15min 里 `mcb_do=95`（say 87 + 1 个 collect task + 其余查询）、`mcb_shelter=6`，**经 `kind=shelter` 提交的 task = 0**。
- 推论：92 个 shelter task **不可能**来自本段对话的工具调用；冻结报告 §4 "mcb_do task shelter 触发 91 次"与同一文档 §1 的 toolCounts **自相矛盾**，"她优先 mcb_do task 而非 mcb_shelter"的证据不成立。
- 影响：若按该结论去"收敛唯一入口"，会修错地方；真正要查的是**前两代 lab / replay / 其他注入源的任务来源**。
- 未修；需要 `taskId + source(tool/supervisor/replay)` 埋点（`MC-LOCAL3-FORENSICS §2.3` 已列为待查，但报告正文仍按旧结论写）。

### P1（显著拖慢/污染，不直接判死）

**P1-7 `path_stuck` 65 次不可归因。**
- 证据：`MC-LOCAL3-FORENSICS §3` 分布；`body.jsonl` seq 19/31/39/52 等只有 `target/distance/pathResets/attempts`；`path_approximate 75` 比 `path_stuck` 还多，却没有事件语义说明。
- 未修：`MC-INSTRUMENTATION §2` 的 v2 schema（kind/targetType/reason 枚举）仍是设计稿。

**P1-8 `mcb_stop` 端到端未验证。**
- 证据：local3 0 调用 → `e2-scenarios` 判 FAIL（`no mcb_stop call`）；soak 1 次（reason "E2 验收暂停"）只证明了"工具→body 事件"；`stop→resume→time pausedMode 开/关→alarm 补投` 未断言（S1 报告 §4 自己也把它列为待复验）。
- 未修；`L2-SOAK-PLAN §3` 把它算作对话/任务 gate 之外，容易漏。

**P1-9 延迟的主因是"重复动作 + 本地模型 step 尾部"，不是工具。**
- 证据：`freeze-forensics.json` step p95 31.4s、turn-gap p95 30s；S1 `latency.json` turn-gap p95 121s/max 154s、`pickup 47.1s`、`tool→assistant p95 5.1s`；soak 反应时延 p50 1.9s/p95 8.1s。
- 含义：`§11.1 D` 里 **step p95 31.4s 在 ≤60s 内（过），但 turn-gap p95 30s 远超 immediate ≤2s 的 gate（不过）**；S1 的 120s gap 已定位为 awake-tick 节奏，不是模型慢。**现有 gate 把"模型慢"和"调度慢"混在一条上**，按它判 PASS/FAIL 都会得出误导结论。

**P1-10 文档与代码漂移，会误导下一个 agent。**
- `mc-link/README.md` 写"16 个常驻"（实际 17）；`MC-PROGRESSION §0.1` 还写"11 个常驻"；`MC-EYES §10.3` 写"mc-link 工具面（待接）"而 `mcb_eyes` 已上线；`MC-MACRO §7` 同一段里既勾了 `tunnel` 又留着 `- [ ] tunnel`；`MC-FINAL` 仍是 11 工具版本。
- 未修。

**P1-11 证据完整性的硬伤：body 事件 seq 跨代回绕。**
- 证据：`local3/state/mc-body/body.jsonl` 2224 行、**唯一 seq 只有 1081 个（max=1081）、3 次从 1 重开的回绕**（每次 body 重建从 1 开始）；`freeze-forensics`/冻结报告引用的 seq 因此不可全局定位。
- 对照 `E2-HARNESS §11.1 F`（"seq 连续/无丢失"）→ **当前格式不可能 PASS**，须改成 `(generation, seq)` 复合键。

**P1-12 数字自相矛盾，降低报告可信度。**
- `shelter` 91 vs 92（`freeze-forensics` vs `tasks.json`）；`incomplete` 那次 progress `total:27 / placed:14 / skipped:58`（skipped 大于 total）；`toolCounts` 被当成全程但实际只覆盖最后一代（§P0-6）。
- 未修；建议报告生成器直接用 ledger 派生，不允许人工填数。

**P1-13（证据有效性）S2 soak 被"重启风暴"切碎，且同一 run 内每代 commit 不同。**
- 证据：`e2-20261106-soak/supervisor.log` —— 05:40 启动 lab（commit `4a95416`）；06:10:04 "lab 不在运行，尝试重启"→ gen-1 归档；06:10:09 起新会话（commit `9663dba`）；06:12/06:13:25/06:13:51 每隔 1–2 分钟再重启（commit `069d416`），共 **9 代 lab / 35min**，每代新 sessionId。
- 后果：① 模型每代重新"恢复现场"，上下文/策略不连续，`291 calls / macroShare 6.5%` 这类聚合数只能当"碎片总量"，不能当 soak 行为曲线；② **同一 run 跨 3 个 commit**，违反 `E2-HARNESS §11.3` "checkpoint 必须含 body/mc-link commit"的可比性前提；③ 重启原因只写"dsh 进程/端口不可用"，未定位（进程崩？端口互杀？），与 `L2-SOAK-PLAN §6` "崩溃≥2 次先修基础设施"的硬 stop 条件冲突却照跑。
- 未修。**该 run 不应作为 L1/L2 的行为证据**，只能当"重启恢复"的证据。

### P2（能力缺口/局部体验）

**P2-14 `mcb_lan` 零证据；`guard`/`defend` 零真服；`bridge` 断崖、`build` 旋转/替代、`farm` 成功路径全缺。**（`MC-MACRO` 自己标了"待补"）
**P2-15 soak 的 `tunnel{stairs:true,direction:"down",length:16}` failed（t-22），与 stairs-smoke 的 done 冲突，未解释。**
**P2-16 战斗：`attack` 已修真服（run6），但 E2 两轮（local3/soak）`attack` 均 0 次调用，等于"修了没被用"。**
**P2-17 记忆侧：`home 0` → 记忆里没有结构化 home；`recall 0`（S1 复盘定性为"场景缺失"而非工具坏，`e2-addendum §3`）；S1 `event→memory latency p95 1.58e6ms` 是口径伪影，指标未修。**
**P2-18 入口分裂仍在：`mcb_shelter` / `mcb_do task kind=shelter` / `mcb_do` 单步 place 三条路并存，skills 没有"唯一推荐入口"。**

## 5. 恢复前的前置条件（引用 `E2-HARNESS §11.6` / `L2-SOAK-PLAN`）

`E2-HARNESS §11.6` 原文 8 项，逐条对照现状：

| # | 前置条件（§11.6） | 现状 | 差距 |
|---|---|---|---|
| 1 | 指标以机器可读形式落盘（segment-report schema） | ❌ | `MC-INSTRUMENTATION §3.10` 有 schema，**无生成器/无实例**；`mc-quality` 只做记忆质量 |
| 2 | L1 回放覆盖 `shelter-3x3`、`collect-resource`、`auto_defense` 三条 | ⚠️ 2/3 | `tools/mc-replay.mjs` + 两个示例 PASS（`§11.9`）；**auto_defense 无回放卡** |
| 3 | local3 checkpoint/期望事件固化 | ⚠️ 部分 | 有 `docs/examples/mc-local3-examples/`；**没有从 local3 导出 5 文件 checkpoint 包**（meta/scenario/tasks/events/expected） |
| 4 | shelter/collect/auto_defense 的 failure code + result 字段稳定 | ✅ | `cbb37f8` 已含 deficit/alternatives；`local3` 事件可见 |
| 5 | chat 去重/重复动作熔断/shelter 失败冷却（head 侧，不新增 MC 工具） | ❌ | 去重/提醒已写但**未真服复验**；重复动作熔断与 shelter 冷却**没有实现**（`loopBreakers=0` 贯穿 S1/S2） |
| 6 | `path_stuck` 补 kind/目标类型/失败原因，可归因 | ❌ | 只有 schema |
| 7 | 段 gate + hard stop + checkpoint 脚本可跑（不启 MC 也能 dry-run） | ❌ | `L2-SOAK-PLAN §3–§6` 只有表格；`mc-e2` 校验 gate 但**不生成 segment-report、不执行 hard stop**（death-watch 实测 `skip`，见 P0-4） |
| 8 | lead/用户明确 approval + E2-GATE | ⚠️ 陈旧 | `wt/mc-lab/.state/lab/E2-GATE.json` 仍是 `e2-20261106-local3` 的 standing approval（phase=soak），**不能当作 L2/24h 的新批准**；冻结令仍有效 |

`L2-SOAK-PLAN` 的附加硬条件（跑之前）：
- §2 段前 `mc-replay` dry-run 必须 PASS（FAIL/INVALID **不开服**）；每段检查 `meta.commits/world.seed/model` 已填、`tasks.json` 含失败任务、`expected-events` ≥1 条断言；
- §5 段间必须"停 lab → 证据落盘 → checkpoint → replay PASS → verdict PASS"才进下一段；**单 lab、不并行、不拼接成 90min**；
- §6 硬 stop 六条（death>6/30min、say 同句≥5、cancel 失效、崩溃≥2、replay 失败、用户叫停）需**真实执行**；
- §8 L3 24h 条件：**连续 3 段 L2 PASS + 用户明确 approval + E2-GATE(phase=soak)**。

**结论：§11.6 的 8 项当前满足 1 项（#4）、部分满足 3 项（#2/#3/#8 都是陈旧件）、未满足 4 项（#1/#5/#6/#7）。按它自己的话——"不满足以上任一项，不恢复 24h"。**

另：S2 soak 暴露的 **9 代 lab 重启风暴（35min）尚未定位**（P1-13），正落在 `L2-SOAK-PLAN §6` "lab/body 崩溃 ≥2 次 → 先修基础设施"这一条上；恢复前必须先有"为什么 1–2 分钟就'端口不可用'"的结论。

## 6. 未知点（本轮没证明的）

1. 92 个 shelter task 的真实来源（多代 lab？replay？其他注入器？）——需 `taskId+source` 埋点。
2. `needs-material` 86 次里，模型是否读过 `deficit`（prompt 里是否出现、出现在第几轮）——需 diff `prompt` 与 tool result。
3. `tunnel stairs` 在 soak 失败、在 smoke 成功，是否回归。
4. `mcb_eyes` 那次真服调用的产物是否有效（无 result 落档）。
5. death-watch `risky:false` 的判定逻辑为何在 12 死时仍不 risky（`tools/death-watch.mjs` 阈值与 supervisor 口径可能不一致）。
6. S2 soak 每 1–2 分钟"dsh 进程/端口不可用"的真因（崩溃/端口互杀/看门狗误判），以及为何同 run 跨 3 个 commit。
7. `time_list` 两条作息消失是 UI/序列化还是 time 侧丢数据（单条当事人报告，未复现）。

## 7. 证据索引（只读）

| 内容 | 路径 |
|---|---|
| local3 冻结快照 | `C:/DSH/icl-wt/mc-lab/.state/lab/e2-20261106-local3/freeze-forensics.json` |
| local3 台账（106 task） | `…/e2-20261106-local3/state/mc-body/tasks.json` |
| local3 body 事件（seq 回绕） | `…/e2-20261106-local3/state/mc-body/body.jsonl` |
| local3 对话/工具（15min、1547 事件） | `…/e2-20261106-local3/{transcript.md,events.jsonl}` |
| local3 death-watch | `…/e2-20261106-local3/death-watch.json` |
| S1 smoke 三问 | `…/e2-20261106-smoke/interview.jsonl`（04:52:2x–4xZ） |
| S1 latency | `…/e2-20261106-smoke/{latency.json,e2-addendum.md}` |
| S2 soak 宏占比/反应时延/夜间笔记 | `…/e2-20261106-soak/{macro-usage.json,reaction-latency.json,night-notes.md}` |
| E2 gate（陈旧） | `C:/DSH/icl-wt/mc-lab/.state/lab/E2-GATE.json` |
| 设计判据 | [`E2-HARNESS.md`](E2-HARNESS.md) §11、[`L2-SOAK-PLAN.md`](L2-SOAK-PLAN.md)、[`MC-INSTRUMENTATION.md`](MC-INSTRUMENTATION.md) |
| 现场取证 | [`MC-FREEZE-2026-11-06.md`](MC-FREEZE-2026-11-06.md)、[`MC-LOCAL3-FORENSICS.md`](MC-LOCAL3-FORENSICS.md) |
| 能力文档 | [`MC-MACRO.md`](MC-MACRO.md)、[`MC-BUILDING.md`](MC-BUILDING.md)、[`MC-COMBAT.md`](MC-COMBAT.md)、[`MC-EYES.md`](MC-EYES.md) |

> 引用约定（本轮审计新增）：**写 seq 必须带事件类型**（`tool/call` 的 seq 与 `assistant/message` 的 seq 不是同一件事）。冻结报告 §1 引的 seq 34/92/597/641 都是 `tool/call`（say），对应的 assistant 原话是另一批 seq（如 641→670），后续报告请统一。
