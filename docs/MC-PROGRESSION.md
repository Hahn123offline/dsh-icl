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
- `[11-05 23:xx] 说明不清` · skill chest.md 说 `all:true` 但 body 未实现 · 待实现（见 §2-9）。
- `[11-05 23:xx] 说明不清` · skill furnace.md 说"等待烧炼完成"但 body 固定 waitMs/单次 take · 待实现（见 §2-8）。
- `[11-05 23:xx] 说明不清` · fairy 无昼夜/死亡坐标/背包剩余格，导致"该干什么"信息不足 · 待实现（见 §2-4/1/7）。

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
