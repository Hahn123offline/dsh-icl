# MC 完整游戏里程碑矩阵（E1 夜间长测配套）

> Owner：mc-body（mc-lab 运行长测）。范围：回答一个具体问题——**现有 11 个工具 + `mcb_do` 的 op 组合，能不能把 MC 从空手推到"能玩很久"**。
> 本文只写**事实与缺口**：每个里程碑当前靠什么动作推进、缺什么、能怎么绕、风险在哪。不预测、不替模型做决定。
> 关联文档：`docs/MC-CONTRACT.md`（契约）、`docs/MC-LEARNED.md`（行为契约）、`packages/mc-body/README.md`（body 接口/复跑命令）、`packages/plugins/mc-link/skills/*.md`（按需技能）。

## 0. 当前事实面（2026-11-06 核对）

### 0.1 工具面（mc-link，11 个常驻）

`mcb_servers` / `mcb_lan` / `mcb_join` / `mcb_leave` / `mcb_status` / `mcb_look` / `mcb_inventory` / `mcb_scan` / `mcb_map` / `mcb_do` / `mcb_help`

- 感知：`look`（视线/实体/血氧）、`inventory`、`scan`（按方块名找，radius≤48/count≤64）、`map`（脚下方块层，radius≤8）
- 动作（`mcb_do` op）：`move/goto/patrol/explore/follow/mine`（含长任务 `task` 的 kind）、`use/dig/place/equip/toss/attack/wait/eat/face`、`craft/furnace/chest/trade`、`task/cancel/resume/events/tasks/say`
- 任务 kind：`mine | goto | patrol | explore | follow | routine | chat`（同一 body 同时 1 个 running）
- 技能文档（`mcb_help <id>`）：`play/craft/chest/furnace/trade/flee/escape/endgame`（`night/death` 尚无，见 §2 建议）

### 0.2 body 暴露的事实（`GET /v1/status`）

`connected`（事件为权威）/`paused+pausedReason`/`task/queue/pausedTasks`/`watchdog{ticks,alerts,suppressed,suppressedBy,healthDropSuppressed}`/`reconnect{attempts,max,exhausted}`；
`adapter.{connected,position,health,food,oxygen,dimension,players,nearby,nearbyHostiles,inventoryCount,pathfinder,environment{summary,resources},danger{blocks,inDanger},spawnSafety,pathStats,packetSilentMs,lastError}`。

**当前没有**：游戏内时间/昼夜、上次死亡坐标、背包剩余格数/是否满、装备耐久/护甲、经验、是否在睡觉、天气。→ 这些是 §2 里"她无法自己判断该干什么"的主要信息缺口。

## 1. 里程碑矩阵

图例：✅ 直接支持 ｜ ⚠️ 支持但组合繁琐/有已知坑 ｜ ❌ 缺能力/只能手工绕

| # | 里程碑 | 需要的动作链（工具/op） | 当前 | 缺什么 | 可绕过路径 | 主要风险 |
|---|---|---|---|---|---|---|
| M0 | 连接/出生/读状态 | `mcb_join` → `mcb_status`/`mcb_look`/`mcb_inventory` | ✅ | — | — | 出生点危险（body 已 spawn 安全检查 + 暂停拒收任务）；重连不续跑（显式 resume） |
| M1 | 木阶段 | `scan oak_log` → `task:mine` → `craft oak_planks` → `craft crafting_table` → `place 工作台` → `craft wooden_*` | ⚠️ | 需要 3–4 步组合；工作台要先 place 再 craft；掉落入包有延迟（已加 2.5s 轮询） | 工作台就在附近时直接 craft；`craft` 报错已给"背包有表→先 place / 没有→先做表" | 掉落没捡（mine 已按净增判据 + 继续挖/再收）；桦木/橡木名字写错；背包满 |
| M2 | 石阶段 | `task:mine`（`block:"stone"`，产物是 **cobblestone**）→ `craft stone_pickaxe/sword/axe` → `craft furnace`(8 cobble) | ⚠️ | 地面无裸露石头时需下挖；body 无"挖竖井/台阶"专能；`mine` 会找最近石头但可能被埋 | `dig` 手动下挖 1–2 格再 `mine`；`scan stone/cobblestone` 确认 | 挖脚下方块=拆支撑（body 已拒挖自身支撑格）；岩浆/水（digSafety：下挖查水/岩浆） |
| M3 | 食物/饥饿 | `inventory` 看 food → `eat`；生肉需 `furnace` 烧；auto-eat 仅 `routine`/emergency | ⚠️ | `mine/goto` 长任务不自动吃；无打猎/钓鱼 op（只有 `attack` 单次） | `eat` 手动；`routine` 带 `eaten` 计数 | 饿到不能跑；生鸡肉中毒；食物名字匹配（body 用正则找 food 名） |
| M4 | 庇护所/床/夜晚 | `place` 方块搭墙/顶；`craft bed`（羊毛+木板）；睡觉 op 缺 | ❌/⚠️ | **无 time-of-day 状态**、**无 sleep op**、`place` 单次/多点但 4.5 格距离限制；床占 2 格、放置语义未验证 | 挖 3 格坑/山洞过夜；天黑前 `goto` 回出生点 | 夜里怪刷在身后；黑暗迷路；床放不下；无昼夜信息→她不知道"该回家了" |
| M5 | 矿洞/探索 | `explore`（随机走）、`goto`、`dig`、`place` 火把、`scan ore` | ⚠️ | `explore` 是随机点不是洞穴导航；无火把自动保证；无"沿矿洞走"策略 | `scan iron_ore/coal_ore` + `goto` + `dig`；`map` 看脚下层 | 迷路（无 waypoint/回家命令，只有 `returnToSafe` 在队列空时回出生点）；岩浆/水；怪物 |
| M6 | 铁阶段 | `task:mine iron_ore`（需石镐）→ `craft furnace` → `furnace input:"raw_iron" fuel:"coal"` → `craft iron_*` | ⚠️ | 熔炉 op 固定 `waitMs`、单次 `takeOutput`；无"燃料够不够/烧几个"语义；产物没进包校验只在 craft，不在 furnace | 小批量多次 `furnace`；`inventory` 前后对比 | 烧一半取不到；燃料被当木板烧掉；铁镐配方 3 铁锭 |
| M7 | 箱子/仓库 | `chest list/put/take`；skill 说 `all:true` 全搬 | ⚠️ | **实现与文档不一致**：body 只支持按 `items[]` 存取，`all:true` 未实现；无容量/自动收纳 | 逐项 put/take；`inventory` 先看清单 | 背包满没提示（静默失败）；把工具存进箱子；箱子名字/位置找不到 |
| M8 | 熔炉/烧炼 | 同 M6；`furnace` op | ⚠️ | 同上：固定等待、单次取、无 count 循环/输出校验 | 多跑几次；每次 `inventory` 核验 | 燃料不足/产物被漏看 |
| M9 | 村民交易 | `move nearest:villager` → `use` → `trade list` → `trade buy` | ⚠️ | 只有 list/buy，无 sell；无"限购次数/绿宝石够不够"检查；村民睡觉/无职业 | `look` 确认村民状态；换村民 | 面板没打开；材料一次换完；交易物没进包 |
| M10 | 战斗/生存 | `attack`（单次）、`fleeOnly` 默认、低血/掉血 safety_stop | ⚠️ | 无自动战斗/护甲自动穿/盾/远程；任务中只靠 emergency（安全停止时一次性），无持续 autoDefense | `equip` 手动穿甲（destination head/torso/legs/feet）；`attack` 循环；`goto` 逃 | 苦力怕贴脸（默认先退）；多怪围殴；夜间视野 |
| M11 | 下界准备 | 黑曜石（需钻石镐）→ 打火石/弓/箭/金锭 → 建传送门 | ❌ | 无 build/pillar/搭桥专能；`place` 4.5 格限制 + 无"从下往上一次建 4×5"；无 shoot/bow；无打火石语义 | 手工逐步 `place`（每格一次）+ `use` 打火石；`dig` 黑曜石 | 建造耗时/掉岩浆；传送门位置算错；下界出生危险 |
| M12 | 死亡回收 | `death` 事件带位置；`goto` 回死亡点；背包掉落 | ❌ | **status 不暴露 lastDeath 坐标**；无"回死亡点捡装备"的 task/skill；死亡后身体会暂停，需要显式 resume | 从 `[MC] 死亡` 事件文本人工抄坐标再 `goto` | 死亡点太远/怪没清；掉落 5 分钟消失；连续死亡（body 有 3 次隔离） |
| M13 | 末地/打龙 | 远未来：眼/弓/床/药水 | ❌ | 上述全部缺口的叠加；`endgame.md` 只是文本参考 | 不推荐本阶段 | 长线目标拆解能力（她能否自己分阶段） |

## 2. Top 10 阻塞风险 + 规避/提示词改进（按"毁一局"概率排序）

| # | 风险 | 触发场景（真实证据） | 规避（body 侧/已修） | 提示词/技能改进（owner） |
|---|---|---|---|---|
| 1 | **掉落没捡/背包满** | 挖树/挖矿后物品飘在叶子上；背包满再挖静默没收益 | mine 已改"背包净增才 done，未达继续挖/再收（3s 等待）"；**下一步**：状态暴露 `inventoryEmptySlots/full`，mine 开始查满 | mc-link：`mcb_inventory` 行尾给"满/剩 N 格"；skills/mine 提示"挖完先 inventory 核增" |
| 2 | **工作台放置/合成两步组合** | 第一次真服 craft 链断在"没放工作台"；craft 报"没有可用配方" | craft 报错已可操作（有表→先 place；没表→先 craft table）；place 已支持多坐标/支撑原因 | mc-link skill craft.md 加"先 place 表再 craft"的显式 3 步；mcb_help craft 更短更可执行 |
| 3 | **寻路卡住** | 平原上每十几米 path_stuck、树上/坡地到不了 1.5 格 | progress watcher + 近似到达（range+1）+ 降级原地挖 + 任务级 no-path 不暂停身体；挖头/挖脚 carve | skills/escape.md 更新"近似到达/原地挖"；mc-link 事件文案带"最近距离/建议" |
| 4 | **夜晚/黑暗（无昼夜信息）** | 长测夜间会刷怪、迷路、不知道回不回家 | **下一步**：status 暴露 `time{timeOfDay,isNight,day}`；`sleep` op（找床/睡） | mc-link：status 行加"白天/夜里 H 时"；新增 skills/night.md（天黑回家/挖洞/床） |
| 5 | **苦力怕/战斗** | 默认 fleeOnly；任务中只有安全停止时才 emergency 一次 | 已限制不追怪；低血/单次掉血 ≥6 才暂停 | skills/flee.md 加"creeper 先退 8 格；不要对刀"；考虑后续持续 autoDefense |
| 6 | **饥饿** | 长任务/长途跑图不自动吃 | **下一步**：`mine/goto` 开始与循环内 `eat`（food≤14） | mc-link：status 行加饱食；skills/play.md 提示"出发前吃/带食物" |
| 7 | **死亡回收** | 死了不知道死在哪，装备捡不回 | **下一步**：status 暴露 `lastDeath{position,at,dimension}`；skills 给"死亡后先看坐标再 goto" | mc-link：死亡事件文本附"上次死亡坐标 + 建议先清怪再回去"；新增 skills/death.md |
| 8 | **熔炉一次只烧/取一个** | 烧铁锭要多次、燃料量不明 | **下一步**：furnace 支持 `count`、轮询输出直到有/超时、取全部产物并校验 | skills/furnace.md 写清 count/燃料/取产物核验 |
| 9 | **箱子整理（all:true 不存在）** | skill 说"all:true 全搬"，body 只支持 items[] → 文档与实现不符 | **下一步**：实现 chest `all:true`（put/take）+ 排除工具清单 | mc-link skill chest.md 与实现对齐（或我实现后它不用改） |
| 10 | **工具升级链/耐久** | 木镐挖石头失败只报 dig-failed；工具坏了不知道 | mine 自动换最好工具；**下一步**：status 暴露手/装备与耐久，mine 失败原因带"需要更高工具" | mc-link：dig-failed 文案加"可能需要石镐/铁镐"；skills/craft 的升级链 |

**Watchlist（暂不阻塞）**：床占 2 格放置语义、下界建造（需 build/pillar 专能）、交易 sell、钓鱼/打猎、护甲自动穿、经验/附魔。

## 3. 长测实时 issue 日志（三类：`说明不清` / `组合不可行` / `环境卡死`）

> 格式：`[HH:MM] 类型 · 现象（证据路径/seq）· 判断 · 处理（已修 commit / 记矩阵 / 转 owner）`
> 长测 run 目录：`.state/lab/night-<run>/`；每 10–15 分钟读一次 checkpoint 增补。

（待长测开始后填充；以下为 2026-11-05 真实局历史，作为已知基线）

- `[11-05 18:xx] 组合不可行` · 真服 `mine oak_log` 连续 no-path（L1/c3，`wt/mc-lab/.state/lab/L1`、`ct/lab/c3`）· 根因=可达性预检 2s 超时误判 + GoalNear rangeSq 误读 · **已修** f90198e/7f4f6e3。
- `[11-05 18:xx] 组合不可行` · `craft` "吞材料"（B 场景自述）· 根因=count 当合成次数（要 5 木板合成 5 次）+ 无产物校验 · **已修** cde7c1f/0e6c9a/a5c09f7。
- `[11-05 19:xx] 环境卡死` · body 静默 exit 1（c3 三次，`state/mc-body/body.stderr.log` 无栈）· 旧代码 uncaught 路径；新 body 已堵 persistent error/interval/dig-race + 任何退出写 `body-exit.json`（reason+stack+recentEvents）· **已修** f90198e/f416bc9。
- `[11-05 19:xx] 说明不清` · 暂停态 cancel 被 409（当事人预期"撤回消息"）· 已把 cancel 加入暂停安全 op · **已修** e6850e5。
- `[11-05 19:xx] 组合不可行` · mine count=1 背包 6 个还 running 追目标 · 已改"净增达标即 done" · **已修** e6850e5/e53246e。
- `[11-05 20:5x] 环境卡死` · 出生在 jungle_leaves/oak_leaves 顶，mine 掉落慢；health-drop 落树 4 血就暂停 · 已改"净增继续挖/再收"+"掉血 ≥6 才接管" · **已修** e53246e。
- `[11-05 23:xx] 说明不清` · skill chest.md 说 `all:true` 但 body 未实现 · **已实现**（ddb170c 起 chest all:true put/take，工具/装备/食物默认不存）。
- `[11-05 23:xx] 说明不清` · skill furnace.md 说"等待烧炼完成"但 body 固定 waitMs/单次 take · **已实现**（`count/fuelCount/轮询产物/partial`）。
- `[11-05 23:xx] 说明不清` · body 无昼夜/死亡坐标/背包剩余格，导致"该干什么"信息不足 · **已实现**（`adapter.time/lastDeath/inventory/equipment/sleeping` + `sleep` op；mc-link 待加展示/白名单）。

### 2026-11-06 night-smoke（真实 lab，5 分钟 smoke，mc-lab run `night-smoke`）

证据：`C:/DSH/icl-wt/mc-lab/.state/lab/night-smoke/{transcript.md,events.jsonl,status.json,state/mc-body/body.jsonl,state/icl-mc-lab/mc-link.jsonl}`

- `[00:10] 说明不清` · prompt 里 MC 状态行只有 `位置/任务/血/背包`，缺饱食/昼夜/附近敌人（seq=49/60）· 她夜间无法判断"该回家吗" · **已修 body 侧字段**（time/lastDeath/inventory/equipment），mc-link 展示待合。
- `[00:11] 说明不清` · `mcb_status` 里“氧气：0”（陆地上 body 报 null，mc-link 显示 0，seq=32）· 容易误解为憋气 · 转 mc-link：null 显示 `?`（body 语义正确）。
- `[00:11] 组合不可行` · `craft oak_planks` requested=8、craftTimes=2×4 但只记 produced=4；`inputsBefore/After=[]`（mc-link seq=77）· 根因：旧实现只有一次总轮询 + 从 `recipe.requires` 取材料（crafting 配方用 `recipe.delta`，所以为空）· **已修** ddb170c：逐批合成+逐批轮询+delta 材料快照+partial 明确文案。
- `[00:11] 说明不清` · 任务 done 的 `reason=net-target` 被旧 mc-link 翻成“任务结束但没达成”（seq=74/78）· lead 已在 master 修 success reasons 白名单；body 侧成功原因固定为 `net-target|duration|target`（已写 README）。
- `[00:11] 说明不清` · 她在长任务期间连续 `wait 20s → tasks → wait 30s ×3` 等结果（seq=61/66/71/80/85/90）· 没有其它事可做；progress 事件被 gate 合并（suppressed:1，seq=79）· 建议 skills/play.md 教“wait 60s 再看一次，同时 mcb_inventory 规划下一步”，或 mc-link 每 ~60s 主动给一条进度摘要（转 mc-link）。
- `[00:12] 说明不清` · survival 地形 `path_stuck @24,73,-54`（1.4–3.9m）在任务最终成功前就发给她 seq=77（`[MC] 走不过去…`），容易让她以为任务要失败 · 建议：path_stuck 只在**任务最终 failed** 或连续 ≥2 次时升为 signal，否则降为日志（转 mc-link）；body 保留事件不改。
- `[00:12] ✅ 正常` · mine oak_log net 12/12 完成、掉落逐件入包（body net 字段逐条上报），task_done 后背包 16 件 —— mine 净增/掉落修复在真实生存服生效。

## 4. 与 mc-lab 的 checkpoint 约定（早报汇总用）

目录：`.state/lab/night-<run>/`

- `transcript.md`：driver 导出的可读 transcript（按轮：来源、工具、结果、她的回复）
- `events.jsonl`：mc-link/body 事件（seq、type、data）
- `metrics.jsonl`：**每 5 分钟追加一行**：`{at, connected, position, health, food, dimension, task:{id,kind,state,progress}, paused, pausedReason, inventoryCount, nearbyHostiles, pathStats, watchdog:{ticks,suppressed}}`
- `checkpoint-<seq>.json`：**每 10 分钟**：`{seq, at, uptimeMin, status:<上面 metrics 字段>, lastEvents:[最近 20 条 type+摘要], notes:"本段观察", issues:["类型: 描述"]}`
- `issues.md`：mc-lab/我的问题单（三类标签），每段结束追加
- `interview.md`/`feedback.md`：当事人三问自述（不算链路证据，但用于"她能不能自己判断"评估）

我阅读节奏：每 10–15 分钟读 `checkpoint-*` + `events.jsonl` 增量；发现 P0（崩溃/卡死/数据丢失）立即发 lead+mc-lab（附证据路径），能快速修的直接修 body/skills（不影响当前 run），修不了记 §1/§2。

## 5. "她能不能自己判断该干什么"——信息齐备度评估

| 判断需要的信息 | 当前是否可得 | 来源 | 缺口/建议 |
|---|---|---|---|
| 我在哪、血/饱食/氧气 | ✅ | `mcb_status`（缺饱食显示？见下） | status 行当前只显示 血/背包；food 在 detail 里 → mc-link 加饱食 |
| 现在几点/天黑没 | ❌ | — | body 暴露 `time{timeOfDay,isNight}`；mc-link 加"白天/夜里 H 时" |
| 周围有什么（树/矿/怪/村庄） | ⚠️ | `environment.summary`（原木/矿/石/土计数）、`scan` 任意方块、`nearbyHostiles`（未进 status 行） | mc-link status 加"附近敌人 N"；environment 加 surface/biome 摘要 |
| 背包够不够/满没满 | ❌/⚠️ | `inventory` 列表；`inventoryCount` 只给件数 | body 暴露 `inventoryEmptySlots/full` |
| 上次死在哪 | ❌ | 死亡事件文本（需人工抄） | body 暴露 `lastDeath` |
| 当前任务/进度/队列/暂停原因 | ✅ | `mcb_status`/事件 | 好 |
| 我能做什么（工具/op/技能） | ⚠️ | 工具 description + `mcb_help <skill>` | 缺 night/death/mine 技能；`play.md` 偏长，progression 无入口 → mc-link 注册新 skill / 缩短 |
| 风险（怪贴脸/低血/夜晚/岩浆） | ⚠️ | `safety_stop`/watchdog 事件、`danger.blocks` | status 行未汇总"当前危险"；建议一行 alarm |

结论：**"能不能推进"在 body/op 层基本齐了（M1/M2/M6 可走通），差的是一组"环境事实"（时间/背包/死亡/威胁）与几个高频技能文档**——这正是 §2 的 body 快修项 + mc-link 提示词项。本夜长测的判定标准不是"她全通"，而是：她是否**在缺信息时自己去查（status/scan/map/inventory）并调整**，以及哪些缺口让她卡住（记 §3）。

## 6. 本轮 body 侧快修清单（不阻塞当前 run；已 commit）

- [x] `status.adapter.time{timeOfDay,isNight,day,clock}`（昼夜判断）
- [x] `status.adapter.lastDeath{position,at,dimension,inventoryCount}`（death 事件时记录）
- [x] `status.adapter.inventory{emptySlots,full,used}` + `equipment{hand,armor,durability,keeps}` + `sleeping`
- [x] mine 背包满 → `mine: inventory-full`（不再挖半天 no-effect）
- [x] `sleep` op：附近床 → 走过去睡；没床/没床物品/白天 各有明确原因（**mc-link 需把 `sleep` 加进 OPS 才能在 `mcb_do` 用**）
- [x] mine/goto 开始 + mine 循环内 auto-eat（food≤14，有食物才吃，事件 `auto_eat`）
- [x] `chest all:true`（put/take，工具/装备/食物默认不存；返回 moved/kept/container）
- [x] `furnace count/按需燃料/轮询取产物/partial 标记/0 产物报原因`
- [x] skills：`play.md` 增加“夜晚/死亡回收/背包满/出发前吃”四节；`chest.md`/`furnace.md` 与新语义对齐
- [ ] mc-link 侧（不在我 scope，已发建议）：`OPS` 加 `sleep`；status 行加 饱食/时间/附近敌人/背包满；注册 night/death 技能入口

> 维护约定：一个事实只有一个家。里程碑/风险放本文；body 接口细节放 `packages/mc-body/README.md`；技能操作放 `packages/plugins/mc-link/skills/*.md`。

## 7. night-1（E1 第一夜）复盘与 issue 日志（2026-11-06 00:42–02:11）

> runDir `C:/DSH/icl-wt/mc-lab/.state/lab/night-1`（events.jsonl 为权威源；mc-lab 另有 `night-notes.md`/`strategy.jsonl`/`degradation-*.json`/`milestones.jsonl`）。
> 结局：02:09 入睡成功；**02:11 mc-lab 主动 `/v1/shutdown` 收 body（sleep-safe）**：睡前同代 8 次死亡、夜间怪多，避免睡眠期被反复击杀；session 保留，睡到 ~06:49 醒后 rejoin。

### 7.1 三类问题（说明不清 / 组合不可行 / 环境卡死）

- `说明不清` · `crafting_table` 报“没有可用配方（缺材料）”，但背包有 8 原木、0 木板 → 模型不知道“先 craft oak_planks”，**131× 重复同一 craft 调用**（night-smoke2 seq 56–…）。修：craft 无配方报错给“下一步链条”（原木→木板→工作台）+ 当前库存（df2931e）。
- `说明不清` · 长任务期间只能 `wait/tasks` 轮询（night-smoke seq 61/66/71/80/85/90）；progress 被 gate 合并。修：mc-link 文档/描述教“提交后别 wait，用 tasks/inventory”，宏 progress 限频。
- `组合不可行` · **`goto` 到自身坐标“捡掉落”循环 96 次**（错误=0，按错误熔断不响；item 只有距离没有坐标）→ 需 `pickup` op + entity 坐标 + “同 tool+args 连续 ≥5 无论成败”断路器（后者 mc-lab 已加，前者明早 body）。
- `组合不可行` · 手动 `goto+dig` 失效坐标：`dig: 方块没有变化` 22 次（模型不知道是“空气/过期坐标”还是“工具不对”）。修：dig 精确报错（39b232e，pending merge/已合入 master a979a4d）。
- `组合不可行` · 同一长 `mcb_do mine` 连发 → mc-link 120s 超时 + body 无 doPlan 互斥 → `tool call aborted`/`mine: dig-failed`（night-1 seq 370/372→376/378；watch sameCallMax=23）。→ 明早 body 单飞锁 409 + 教“长任务用 task”。
- `环境卡死` · 夜间生存：同代 8 次死亡、血 5 时 supervisor 低血 resume→再被打循环（safety_stop 70/emergency 62/health_drop 38/resume 71）；mc-lab 最终 sleep-safe 收 body。非 body 故障，body 安全反射正常。
- `环境卡死` · supervisor 自身 `sleep is not a function` 崩溃（mc-night.mjs:1125，00:36 前后）→ mc-lab 修好重启；旧 gen 证据在 `checkpoint/lab-gen-2/`。
- `说明不清` · `mcb_status` 氧气显示 0（body null）→ mc-link 改 `?`（本夜已修）。
- `说明不清` · craft 无配方 hint 选到错误配方变体（她有 oak/cobblestone，却提示缺 pale_oak_planks/cobbled_deepslate）→ 明早改：多配方变体选“缺最少”的那个再提示。

### 7.2 设计转向（用户两次明确要求）

1) **装备/工具归模型管**（02:0x 用户要求）：inventory 要给手持/快捷栏/★/toolFor/耐久；equip {item|slot} 自管；mine/dig 前置检查：错工具/空手 → 立即 failed(needsTool/suggestCraft) 不重试；有更好工具→自动换；脚本只在战斗/低血/危险 emergency 兜底。→ **已实现并部署**（b1fa2a8/347040a；night-1 真服证据 seq 390/391 inventory、726/727+773/774 equip、370/372 mine net10；auto_tool 事件 20 次）。
2) **宏操作**（02:3x 用户要求）：重复劳动不要逐方块交给模型；body 自带 collect/tunnel/bridge/build/sort/shelter/farm 宏，模型一条 op + 查进度 + 随时打断；大建筑给蓝图。→ **契约 MC-MACRO.md + collect/tunnel 已实现并真服 smoke 通过**（de1acfe/011e3f2）；其余明早。

### 7.3 退化数据（宏动机）

`[01:20–01:37Z]` 154 calls：`mcb_status 101 / mcb_do 39 / mcb_inventory 8`；**mine/dig 22 次全部 stone**；**assistant 目的表述 0 条**；task 事件 87（progress 79/done1/cancelled1）→ 逐块 progress 循环，不是资源不足。→ 一条宏 + 限频 progress 是正道。

### 7.4 明早待办（按优先级）

1. body：`doPlan` 单飞锁（并发 409，长任务引导 task）；`pickup` op + look/inspect entity 坐标；craft hint 变体选择；`collect` 结果 net（已加 358bd17）。
2. 宏：bridge/build/sort/shelter/farm；`tunnel` stairs/blocked 用例；build 蓝图校验 + 真服。
3. 技能/文案：mcb_help collect/tunnel（mc-link 已写）→ build/shelter 待实现后补；play.md 已有“重复劳动用宏”。
4. 复盘：把本 §7 与 mc-lab 数字表合成早报；MC-LEAVE/sleep-safe 作为验收流程一部分。

- `环境卡死/运维` · **睡眠期 body 被意外复活并连死 3 次**（2026-11-06 02:34）：02:11 mc-lab sleep-safe shutdown 后，02:34 body 又被拉起、无人操作被怪连杀（death #11–13：23,67,-44 / 31,74,-36 / 16,64,-40）→ body 触发 **quarantine（3 死/120s）自行断开**（安全逻辑正确）。02:42 复核 54902 已释放、sleep 期无新 death；已请 mc-lab 查"谁重启 body"并在睡眠模式禁止自动复活。教训：sleep-safe 必须校验"body 进程已死 + 睡眠期禁止 auto-restart"，否则睡眠期会丢掉落/被杀。

### 实现状态更新（03:40 后）

- [x] `collect` / `tunnel` / `bridge` / `build` / `shelter` / `sort` / `deposit` 均已实现（adapter + 真服 smoke 覆盖 collect/tunnel/bridge/build/shelter；sort 在无箱子场景验证可读失败）。
- [ ] `farm`（需锄/水/种子，明早）
- [ ] `build` 旋转/替代材质、`tunnel` stairs、bridge 真实沟壑用例（明早/现场）
- 语义补充：`build`/`shelter` 完成度 <80% → `failed(partial)`（不再误报 done）。

## 8. Top10 卡点状态更新（截至 2026-11-06 03:4x，night-1 第一夜）

| # | 卡点 | 状态 | 证据/动作 |
|---|---|---|---|
| 1 | craft 无配方只说“缺材料”，模型跳过中间步骤 → 131× 重复 | **已修** | craft 报错给下一步链+库存（df2931e）；变体选择（cobblestone vs cobbled_deepslate）待明早修 |
| 2 | 长任务 `mcb_do` 单步长 op（mine/goto）→ 120s 超时 + body 无互斥 → 并发互打 | **待修**（明早） | doPlan 单飞锁 409；今晚 supervisor 用 task 引导规避（seq 370/372→376/378） |
| 3 | `goto` 到自身坐标“捡掉落”成功无用循环 96× | **已拦** | mc-lab 断路器（同 tool+args ≥5 无论成败）；body `pickup` op + entity 坐标明早补 |
| 4 | 手动 `goto+dig` 失效坐标 `方块没有变化` 22× | **已修** | dig 精确报错（空/过期/太远/手持）39b232e，已合 master |
| 5 | 模型不知道工具/装备，空手/泥土挖石头 | **已修+已部署** | 装备设计转向 b1fa2a8/347040a；night-1 seq390/391、726/727、773/774、370/372；auto_tool 20 次；needsTool 真服 smoke 证据 |
| 6 | 逐方块重复劳动（10 分钟 mine/dig 22 次全 stone、task_progress 79、目的表述 0） | **已缓解** | 宏操作契约+实现（collect/tunnel/bridge/build/shelter/sort/deposit，45 测试绿，smoke 过）；mc-link 工具面已接 |
| 7 | 夜间死亡循环（同代 8 死；低血 resume→再被打） | **运维缓解** | body safety 正常；mc-lab sleep-safe 收 body；supervisor 收紧低血 resume（待）；睡眠期临时复活已加 sleep-body-reap |
| 8 | 睡眠期 body 被 in-flight `mcb_join` 复活 → 连死 3 次 | **已修** | mc-lab `sleep-body-reap` 5e2a6d1 + mc-link 睡眠 join 守卫 0a5a25b；body quarantine 自保正确 |
| 9 | supervisor `sleep is not a function` 崩溃 | **已修** | mc-lab 修（sleepInfo 改名）并重启 |
| 10 | 长任务等待只能 wait 轮询 | **教学已改** | mc-link 文档/描述“提交后别 wait”；宏 progress 限频（5–10%/10s） |

未决（明早）：farm、build 旋转/替代材质、bridge 真实沟壑、tunnel stairs、pickup op、doPlan 单飞锁、craft 变体选择、低血 resume 策略。

**§7.4 更新（05:3x 实际完成度）**：
- 宏：`collect/tunnel/bridge/build/shelter/sort/deposit/farm` **全部已实现**；真服 smoke 覆盖 collect/tunnel/bridge/build/shelter + tunnel stairs + sort 失败路径；`build`/`shelter` 加 `<80% → failed(partial)`；剩余：build 旋转/替代材质、bridge 真实沟壑、farm 真实水源/种子（beta，lab 重启后验）。
- body 侧仍未做（明早）：`doPlan` 单飞锁、`pickup` op、craft 变体选择、low-health resume 策略（supervisor 侧）。
- 文档/技能：MC-MACRO.md 契约+证据齐全；mc-link 宏工具面/skills 已接（`ab3c076`/`4a4e003`），lab 重启后生效。

### 补充完成（07:0x，body 侧三项明早任务提前做完）

- `doPlan` **单飞锁**：长 op 执行中再发长 op → 409（“上一个 do 动作还在执行…长任务用 task”）；查询/任务提交/取消不受限；单测覆盖（并发 409 + 查询放行 + 完成后放行）。
- `pickup` op：找最近 item 实体→走过去→统计 picked/items/left（真服 smoke：toss 4 dirt → pickup picked 1 stack，背包恢复 7；`items` 名称解析 cosmetic，待修）。
- craft 无配方 hint **选缺料最少变体**：`chooseRecipeVariant`（oak 工具不再误报缺 pale_oak_planks/cobbled_deepslate），单测覆盖。
- 测试 47/47 mc-body 绿；commits：73a209d + docs。mc-link 需把 `pickup` 加进 OPS（否则 mcb_do 用不到）。

## 9. night-1 终局数字（06:51 结束，supervisor 脚手架 bug，非 body/产品代码）

- 实际窗口 00:22:17→06:51:12（6h29m，预算 480min 未跑满）；原因 supervisor TDZ `nowMs`（mc-lab `6218391` 已修 + tdz-smoke 验证）。lab 代 6、supervisor adopt 11、lab 自愈重启 3、服务器重启 0、根锁已释放、用户客户端未触碰。
- 累计 **64 turns / 1182 tool calls / 281 tool errors（23.8%）**；主要错误：`dig: 方块没有变化`（旧坐标/工具）、`place 被占/无附着面`、`craft 无可用配方`、`tool call aborted`（长 op 并发/取消）。
- 自愈：loop-breaker 20 / no-progress 9 / death 提示 21 / paused-resume 8 / turn-timeout 9 / error-loop 3 / survival-mode 7 / lab-restart 3。
- 死亡：body.jsonl death 19、quarantine 相关 12；body 反射正常，主因夜间怪多 + 低血 resume 策略（已列改进）。
- 睡眠/醒来/dream/dawn 全链路一致（02:09:06→06:39:06→dream wash 1119 行→dawn 06:49 一次）；睡眠期外部直投 9 次全在 02:09:56–02:11:56，之后 0 活动。
- 装备转向已部署真服验证（seq 390/391、726/727、773/774、370/372）；宏转向 body 已实现 8 op、今晚未部署，明早验收只算 collect/tunnel，其余 beta。
- **body 侧三项明早任务已在 07:0x 提前完成**：doPlan 单飞锁（409）、`pickup` op、craft 无配方“缺料最少变体”选择；47/47 测试绿（73a209d）。
