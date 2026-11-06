# 复杂度/困惑审计（基于 E2 实测，只读）· 2026-11-06

> 触发：用户回到电脑前提出怀疑——"用的是 deepseek-flash（够强），但进展异常缓慢、出现分钟级静止，极大概率是我们某一层造成了困惑或不该有的复杂度"。
> 方法：**只读** E2 run `C:\DSH\icl-wt\mc-lab\.state\lab\e2-20261106-smoke`（commit 9cc6df6，120 分钟、50 轮收尾；未起 lab、未改代码）。所有数字可由 `events.jsonl` / `prompts.jsonl` / `transcript.md` / `status.json` 复算。
> 结论先说：**慢的主因不在 deepseek-flash，而在我们造的运行环境**：57% 墙钟花在工具调用上（其中 49 分钟是模型自己发起的 `wait`、29 分钟是 `tasks` 轮询），17% 是等她"清醒节拍"的静默；上下文里 70% 是重复的 runtime-context（134 条/9.1 万字符，2.5 条/轮，超过 cache 的 ≤1/轮），外加 48 工具/2.9 万字符 schema、33 条脚本化 steer，以及两个真实能力 bug（`attack` 打不死鸡、pause/resume 死锁）。"笨"的表象主要是被环境逼出来的等待与反复确认。

## 0. 一分钟结论

| 问题 | 结论 |
|---|---|
| 为什么慢？ | 120 分钟里：**工具执行 68.7 分钟（57%）**、**静默等待 ≥20.7 分钟（17%）**、其余 ~30 分钟模型/重试。工具时间里 `wait` 104 次约 49.4 分钟、`tasks` 轮询 61 次约 28.9 分钟（重叠），都是"模型自己发起的等待/轮询"。 |
| 为什么像变笨？ | 每轮 **13.5 step / 14.1 次工具调用**；每次请求带 **48 个工具、29,045 字符 schema**、**130,253 字符投递消息**（其中 runtime-context 90,977 字符 = 134 条快照，每条都含 DSH 文件策略等固定样板）；`reasoningEffort=high`；33 条脚本化 steer（13 条死亡脚本、14 条暂停脚本）在替她做决定，并与她自己的计划冲突。 |
| 是模型不行吗？ | 不是主因。她有 760 次工具调用、11 次主动 `remember`、5 次 `mcb_help`、能正确推断"鸡蛋不能吃/需要饱食≥18 回血"；真正的失败是 `attack` 返回 `{"attacked":"chicken"}` 但不掉血（还崩过一次）、pause/resume 死锁、寻路 76 次卡住——这些是基础能力 bug。 |
| 她以为没工具/不会看画面吗？ | **没有**。全文没有"没有工具/看不到画面/没有 recall"的自述；她知道自己有 mcb_* 工具并会用 `mcb_help`。这一轮 build 里没有 `mcb_eyes/mcb_snapshot`（14 工具版是后来的 master），她也没有抱怨过图片。 |
| recall 为什么 0？ | 与记忆复核一致：这轮 42 条真实用户消息 + 38 条 supervisor steer 里**没有"过去指代"场景**；recall 工具在（remember 同插件被调 11 次）、eager-recall 注入 41 次，所以 recall=0 是**场景未触发**，不是工具/教学失败。 |

## 1. 实测数字（只读复算）

### 1.1 墙钟去向（120 分钟）

| 项 | 数值 | 说明 |
|---|---|---|
| 工具执行总时长 | **68.7 分钟（57%）** | 764 次调用；`mcb_do` 435 次占 68.5 分钟 |
| — 含 `wait` 的调用 | **104 次 / 49.4 分钟** | 请求 wait 30–240s，实际每次约 30s 返回（240s 也被截到 30s） |
| — 含 `tasks` 轮询 | **61 次 / 28.9 分钟** | 模型用 `wait + tasks` 轮询长任务，而不是等事件 |
| 静默空档（无任何模型可见事件） | **≥20.7 分钟（17%）**，10 段 ≥60s | 其中 9 段是 120–121s：回合结束后等"清醒节拍" |
| 模型/重试/其他 | ~30 分钟 | `assistant/attempt` 7 次：**6 次是 `Insufficient Balance`**（deepseek 账户余额不足，外部环境问题，造成连续重试等待）+1 次正常 |
| 回合/步/调用 | 54 轮 / 729 step / 764 调用 | **13.5 step/轮、14.1 调用/轮**；turn p50 5.3s、p90 **412s**、max **773s**（turn/start→turn/end 粗配对，含跨轮空档） |

### 1.2 工具调用分布（764 次）

| 工具 | 次数 | 备注 |
|---|---|---|
| `mcb_do` | **435** | 21% 的调用失败（92 个 error，全部来自它） |
| `mcb_status` | **125** | 16% 的调用；同一空参数重复 125 次 |
| `mcb_look` | 69 | 同参数重复 69 次 |
| `mcb_inventory` | 33 | 同参数 33 次 |
| `mcb_map` | 30 | 同一 radius 参数重复 10/9/6 次 |
| `mcb_scan` | 22 | |
| `mcb_join` | 8 | 同参数（survival）重连 8 次（死亡/暂停循环） |
| `remember` | 11 | 记忆写入正常 |
| `time_*` | 16 | time_arrange 4 / status 6 / list 2 / cancel 4 |
| 其它（help/leave/forget/world_status） | 14 | |
| **一次都没调用** | **31 个** | album(7)、focus(4)、editor(3)、lexicon(2)、whois、memory_export、memos(2)、memo(2)、note_status、todo_write、mcb_lan、time_edit/mute/pause/resume/unmute、recall 等 |

`mcb_do` 内部 step 分布：`goto 121 / wait 104 / craft 66 / tasks 61 / chest 59 / place 54 / dig 45 / resume 38 / mine 7–… / attack 18`。

### 1.3 错误（92 个，全部 `mcb_do`；多 step 批里一步失败 → 整批 abort，前面步骤白做）

| 次数 | 错误（节选） | 性质 |
|---|---|---|
| 11 | `dig: 目标位置是空气（坐标可能已过期…）` | 她用旧坐标 dig；提示已给正确做法（用 `mine`），仍重复 |
| 9 | `no-path: 走不过去…` | 寻路失败（body 侧 path_stuck 76 次） |
| 8 | `place: 目标下方没有支撑（air）…autoSupport:true` | 放置语义 |
| 6 | `place: 没有可附着的面…` | 同上 |
| 5 | `mine: no-target` | 目标选择 |
| 5 | `附近没有箱子` | 依赖前置 |
| 5 | `身体已暂停（low-health）；先 resume…` | 暂停死锁（见 §3） |
| 4 | `tool call aborted` | 回合/steer 打断 |
| 1 | `Cannot read properties of null (reading 'entities')` | **attack/pickup 代码崩**（seq 2213） |

### 1.4 上下文与工具面（每次请求都带）

| 项 | 数值 |
|---|---|
| 工具数 / schema 字符 / 描述字符 | **48 / 29,045 / 11,540**（其中 `mcb_*` 仅 11 个；album/focus/time/memory/editor 等与 MC 场景无关的占大半） |
| 投递消息总字符（54 轮） | **130,253 字符** |
| — runtime-context | **90,977 字符 / 134 条**（2.5 条/轮；134 条**全部**含 DSH 文件策略样板，133 条含 `icl:facts` 的“时间：/MC｜”） |
| — plugin:mc（游戏事件） | 20,066 字符 / 134 条 |
| — plugin:icl（eager 记忆） | 8,907 字符 / 41 条 |
| — plugin:time | 5,208 字符 / 45 条 |
| — 真实用户 | 5,095 字符 / 42 条 |
| 模型配置 | `deepseek-flash`, **reasoningEffort=high**, maxTokens=256000 |

> 即：**真正"人说的话"只有 5.1k 字符，环境自己塞了 116k 字符**（其中 91k 是重复 runtime-context）。cache 规则是 facts ≤1 条/轮，这里是 **2.5 条/轮**。

### 1.5 steer / 节拍（"该干什么"被外部脚本接管）

| 来源 | 次数 | 内容 |
|---|---|---|
| night-supervisor（prompts.jsonl） | **38** | 13×死亡脚本（完全相同的 `look→goto→dig→place→wait 到天亮`）、14×暂停脚本（`先做一个动作 resume`）、6×睡前收尾、5×其它 |
| 清醒节拍（time） | **43** | 每约 120s 一条："距上次回合结束 120 秒…可以看 time_status / world_status / focus_status 决定下一步" |
| nudge / playbook | 0 / 0 | 本轮未用 playbook、nudge=0 |

**冲突实例**：死亡脚本在**白天**也说"wait 到天亮、别回原地"；睡前脚本说"到点就睡"，而任务链说"接着做"；任务链开头教"**报错就先 mcb_status**"，节拍又教"看 status 决定下一步"——结果 `mcb_status` 125 次、`look` 69 次、`inventory` 33 次，**34% 的调用是确认状态**。

## 2. Top 5「我们造成的困惑」（seq / 原文 / 推断）

### C1. `attack` 报"打中了"但打不死鸡 → 食物危机 → 整晚被动（真实 bug，不是她笨）
- 证据：seq 1558 `[attack] {"attacked":"chicken"} [attack] {"attacked":"chicken"} [pickup] 捡到 0 个`；seq 2253/2267 同形；seq 2213 `Error: Cannot read properties of null (reading 'entities')`；全文 attack 相关步骤 18 次。
- 她的自述（seq 4882）："打鸡一直打不中（`attack` 总是锁到地上的掉落物，不是鸡）……吃的还是没解决"；seq 2632："出去想打鸡补饥饿，结果 attack 一直盯上地面上掉落的物品，打了两三轮全是空挥"。
- 推断：**工具有两个问题**——①目标解析/伤害没有真正作用到实体，却回 `attacked:chicken`（假成功）；②某次攻击/拾取路径空指针崩溃。她的因果解释（"锁到掉落物"）部分不准，但"打不死"是真的。结果：饥饿 0 → 安全暂停 → 13 次死亡 → 她选择"在基地待着等玩家给吃的"（seq 4903），**整晚最值钱的探索时间被这一个 bug 吃掉**。

### C2. 暂停/恢复死锁："resume 一秒内又被按回去"（安全反射与恢复互相打架）
- 证据：seq 2632 自述"安全反射把动作全按暂停，resume 之后一秒内又被按回去…既不能吃（也没吃的）…血 0/20 饥饿 0/20 死锁"；seq 2489/2504/2516 连续 `Error: 身体已暂停（low-health）；先 resume…`；事件里 `safety_stop 78 / emergency 67 / reflex 32 / watchdog 88 / resume 步骤 38`；`mcb_join` 同参数 8 次（死亡/断线重连）。
- 推断：低血/低饥饿时"安全反射"与模型 `resume` 形成忙等；她在几轮里只做"resume→被暂停→再 resume"，**分钟级不动**。这是设计问题（pause 语义/反射预算），不是模型判断错。

### C3. "清醒节拍"+任务链一起教她轮询 → 2 分钟静止 ×≥10 段
- 证据：seq 2674 等 **43 条**节拍原文："清醒节拍：距上次回合结束 120 秒…可以看 time_status / world_status / focus_status 决定下一步"；任务链第一条："报错就先 mcb_status/换简单动作"；结果 `mcb_status` 125、`look` 69、`inventory` 33、`map` 30（34% 调用）。
- 推断：每轮结束→等 120s 节拍→先查状态→再决定，形成"**2 分钟静止 + 3 次确认**"的固定节奏；10 段 ≥60s 空档共 20.7 分钟。我们不该在节拍文案里教"看 status"，也不该在任务链里教"报错先 mcb_status"。

### C4. 13 条完全相同的死亡脚本，替她做决定并教"等到天亮"
- 证据：prompts.jsonl 13 条 `你刚死了（第 N 次…）。**先保命**：look 看怪→反方向 goto 10 格→往下 dig 3 格→place 封口→wait 到天亮。掉落 5 分钟会消失，别回去捡`；结果 `wait` 104 次（49.4 分钟）、`dig` 45 次（11 次"目标位置是空气"）、`place` 54 次（14 次失败）。
- 推断：外部脚本把"该干什么"细化到动作序列，她照着做；白天也"等到天亮"，于是大量时间埋在坑里/基地里。**外部脚本越细，她越不自己判断**——这正是用户怀疑的"我们造成的复杂度"。

### C5. 每次请求 48 工具/2.9 万字符 + 13 万字符消息（其中 9.1 万是重复 runtime-context）
- 证据：§1.4；另外 **eager 注入 41 次**、**游戏事件 134 条**、`reasoningEffort=high`、maxTokens 256k；turn p90 412s、max 773s。
- 推断：模型每次要在 48 个工具（**37 个非 `mcb_*`**，其中 31 个一次没调用）、节拍/事件/重复上下文里选择；每轮 13.5 step，"慢"首先是**环境给的信息太多、且多数重复**。`runtime-context` 里 134 条全部含 DSH 文件策略样板（91k 字符），完全可以在 MC lab 关掉（`includeRuntimeContext:false`），facts 也应压到 ≤1 条/轮。

## 3. 她的自述 vs 实际状态（不是"以为没工具"）

| 自述（seq） | 实际 | 判定 |
|---|---|---|
| "打不中鸡…attack 锁到掉落物"（4882） | `attacked:chicken` 回了 11 次但无伤害；一次 `entities` 空指针崩（2213） | 结论对、归因部分错；**我们的 bug** |
| "安全反射按住…resume 被按回去，血 0/20 死锁"（2632） | safety_stop 78 / emergency 67 / reflex 32；resume 38 步 | 属实，**我们的设计 bug** |
| "没吃的、回不了血，就在基地待着"（4903） | 饱食 15（<18 不回血）、3 个蛋不可吃、打猎坏 | 属实且理性；被动是 bug 造成 |
| "鸡蛋不能吃"（2632） | 原版 MC 鸡蛋确实不能吃 | 正确 |
| "等 Hahn123_ 有没有多余吃的"（4903） | 玩家一直没回 | 环境/社交假设；她学会了等外部救 |
| "没有工具/看不到画面/没有 recall" | **全文没有这类自述**；remember 11 次、mcb_help 5 次；本轮无 mcb_eyes 但她也未要求看图 | 不存在"不知道自己有工具" |

## 4. 简化清单（可执行，按优先级）

### P0（先修，直接决定"慢/卡"）
1. **修 `attack`**（mc-body/mc-link）：目标解析+实际伤害；成功文本必须带"对实体造成了 N 伤害/目标剩余血量"，没打中要报"没打到目标"而不是 `attacked` 假成功；修 `entities` 空指针。测试：mock 实体 → 断言伤害/击杀/拾取链路。
2. **修暂停/恢复死锁**（mc-body/mc-link）：低血/低饥饿安全反射与 `resume` 的竞态；至少允许"resume 后 3s 内不重复安全暂停"或"安全反射只做一次然后进入可恢复的暂停态"，并在错误里给"现在建议：吃/逃/等"而不是只让你 resume。测试：连续 resume/暂停事件序列。
3. **停止教轮询**：任务链删掉"报错先 mcb_status"；清醒节拍文案删掉"可以看 time_status/world_status/focus_status"，改成一句"继续做你手上的事"或静默；`mcb_status` 只在状态可能变化后由事件驱动。
4. **收紧 wait/tasks**：`wait` 要么真正按请求等待、要么明确"上限 30s 且不推荐"；长任务只回 taskId，完成通过事件推送（现有事件已推），文档/描述里明确"不要 wait+tasks 轮询"。目标：`wait` 104 次→接近 0，释放 **≤49 分钟/2h**。

### P1（收敛复杂度，影响"困惑"与 token 成本）
5. **MC 场景工具子集**：lab MC preset 只暴露 `mcb_*`（11–14 个）+ `time_status/time_arrange` + `remember/recall/memo` + `todo_write`；隐藏 album(7)、focus(4)、editor(2)、lexicon、whois、memory_export/memos、world_status 等（实测它们 0 次调用）。预计工具 48→~20、schema 29k→~13k 字符。
6. **关掉重复 runtime-context**：MC lab preset 里 `dsh-system-prompt.config.includeRuntimeContext:false`（134 条×平均 671 字符、全含 DSH 文件策略样板）；`icl:facts` 压到 **≤1 条/轮**（当前 2.5 条/轮）。预计投递消息 130k→~40k 字符。
7. **steer 降级为策略句**：13 条死亡脚本/14 条暂停脚本→1 句"先保命，自行决定躲/封/等"；"到点睡/继续"不要同时出现；预计 38 条→≤10 条，减少"替她决策"。
8. **`mcb_do` 批语义**：多 step 中一步失败时，把已执行步骤结果一起回（或 `stopOnError:false` 选项），减少"整批白做"；`dig` 失败提示升级为"坐标过期→直接用 mine"，并统计 stale 次数。

### P2（体验/成本微调）
9. **reasoningEffort**：MC 场景试 medium/low（本轮 high + 14 调用/轮 + 13.5 step/轮，模型侧仍有 ~30 分钟）；maxTokens 不必 256k 常开。
10. **游戏事件降噪**：plugin:mc 134 条/20k 字符；`alarm_suppressed 578` 已经挡了很多，但投递到模型的仍是 134 条——按"状态变化+合并"再压（如每轮最多 1 条汇总）。
11. **time 清醒节拍**：43 条/120min，且是 2 分钟静止的来源之一；考虑只在"确实闲太久"时发一条极短"继续"，或把 tick 调到 30–60s 但**不带状态查询建议**。
12. **recall 场景**：E2 脚本加"问过去/旧细节"场景（recall=0 的结论见 §0）；本审计不改代码。

## 5. 预期收益（保守估计）

| 改动 | 预期 |
|---|---|
| P0-1/2 修 attack 与 pause 死锁 | 死亡 13→≤5；食物/进度不再整晚卡死；**这是"她看起来笨"的最大单一原因** |
| P0-4 wait/tasks | 工具时间 68.7→~20–30 分钟；每轮调用 14.1→~8 |
| P1-5/6 工具面+上下文 | schema 29k→~13k、投递消息 130k→~40k；每轮 token 显著下降，p90 回合时长应下降 |
| P1-7 steer | 38→≤10；她需要自己决定"该干什么"（符合用户"别从外部脚本派活"的直觉） |
| P2 | 进一步降噪；但**不要**在 P0/P1 之前就调模型参数，否则会把环境问题误判成模型问题 |

## 6. 复算方式（只读）

```powershell
$run = "C:\DSH\icl-wt\mc-lab\.state\lab\e2-20261106-smoke"
# 事件/工具/错误/等待/上下文：用 node 读 events.jsonl（脚本在本轮临时目录，未入库）
# 关键文件：events.jsonl（tool/call、tool/result、user/message、request/header）、
#           prompts.jsonl（38 条 night-supervisor）、status.json（turns/toolCalls/strategy）、
#           transcript.md（自述原文）、quality.jsonl（dream/recall/eager）
```

> 附：本审计**不改代码**；建议的 P0 里 attack / pause 属 mc-body/mc-link owner，工具子集/steer/上下文属 mc-lab 与我（dsh-icl/bridge）可做；`recall=0` 结论与 `MEMORY-BLOCK-QUALITY §6.3` 一致（场景未触发）。
