# 记忆子系统代码审计（对照 docs/MEMORY*.md）

> 审计对象：HEAD `cf95485`（2026-11-11）。范围：`memory` / `dream` / `recall` / `eager-recall` / `note` / `lexicon` / `whois` / `dsh-raw` / `persona` / `world-state` 插件 + `packages/core/src/services.mjs` + `dsh-icl` 装配/桥。
> 方法：逐文件读代码；用 `.state/lab/memory-audit/latest/audit.{json,md}`、`.state/lab/memory-fixture/latest/current.json`、`days/*.txt` 做数据核对（只读产物，不碰 live state）；用临时 stateDir 写可复现脚本（`.state/lab/code-audit/*.mjs`）。
> 约束：未读/写 `C:\Users\ai_admin\.dsh\icl\state`；未改产品代码；未重启 DSH；未复制第三方代码。
> 实际跑过：`node --test --test-force-exit packages/core/test/{dream-jobs,pending-notes,memory-blocks}.test.mjs` → **27/27 pass**；3 个复现脚本 + 2 个事实提取脚本（见附录 A）。未跑全量 `npm test`。

---

## 0. 结论摘要（按严重度排）

| # | 级别 | 结论 | 关键证据 |
|---|---|---|---|
| F1 | **P0** | **同一个 day 的 dream 会被执行两次，且账本被 upsert 掩盖**。`alreadyRan` 只在 job 成功后写 `run:<day>:<job>`，没有任何 in-flight 锁；第二次触发在第一次还没写完账本时进入，重跑 `events`/`cleanup`，产出整批近似重复块。`recordRun` 用同一 key upsert，审计只看行数会得出"只跑了一次"。 | 代码：`dream/index.mjs:361-367,1476-1493`；live：`run:2026-11-09:events` created=15:00:12.457 / updated=15:00:27.469（Δ=15012ms，其余 job Δ=0），两批块 #82-92 与 #135-145 分属两个 `now`；5 对近重复正是两批的一一对应（`.state/lab/.../current.json`） |
| F2 | **P0** | **显式 `remember`（event）会被 dream 静默吞掉**。当天只要有 day log，`events` 就只把 day 行当材料，成功后却把**全部**未消化 event note 标 `consolidated`（不看是否被引用）；note 从此被 `recall` 排除（`recall:273`），正文永远进不了块。 | 代码：`dream:523,658-661`；live：`run:2026-11-09:events` data `notes:2, deferred:1`（2 条 note 被吞）；29 个 event block 的 **151/151** 条 evidence 全是 `type:'day'`；复现 B |
| F3 | **P0** | **模型输出不可解析（`[]`/垃圾 JSON）会被当成成功**：`parseBlocks` 返回 `[]` 不抛错 → shard 记 ok、`blocks:0`、仍写成功 run 行；有 day log 时还会把 note 全标已消化 → 当天不能重试。`cleanup`/`lexicon` 同型。 | 代码：`dream:48-63,553-566,658-661`；复现 B（note.consolidated 由 undefined→true，事件 0 块、ok:true） |
| F4 | **P0** | **不同人的 person 块会被确定性去重合并**。`sameExperience` 在 `data.day` 缺失时直接放行（`person` 块没有 day），`mergeNearDuplicateBlocks` 只比规范化正文；薄档案模板句相同 → 两个不同人被合并，一个块被 `superseded` 从检索里消失。文档写的是"同一天/时间重叠"才合并。 | 代码：`dream:990-995,1002-1053`；文档：`MEMORY-BLOCK-QUALITY.md:257`；复现 C：`person:name:甲` 被 `person:name:乙` superseded |
| F5 | **P1** | **身份无稳定主键 → 主人/Hahn123 拆分是必然而非模型偶然**：person 块按显示名做 key，`aliases` 只存不用（`findPerson` 完全不匹配 aliases），抽取 prompt 还明确要求"不要合并不同的人"；raw 层只有 role、没有每条消息的 QQ 身份。 | 代码：`dream:688,731,846`；`memory:396-418`；`bridge.mjs:512`；live：`人 4 块` 见 §6 |
| F6 | **P1** | **raw 层把"模型输出文本 + 工具结果"当成"她说过的话/经历过的事"**：reasoning 已过滤，但 assistant 的英文计划文本仍进 day log；tool/result 整段进 day log。运行状态（水位/积压/连接）被写成 event 块，工具名被收成语料。 | 代码：`bridge:33-52,492-527`；`dream:446-453,541-550`；live：`days/2026-11-09.txt:1-8`、`days/2026-11-10.txt:1-12`；块 #92/#145（"17:06 私聊水位还是 #62"） |
| F7 | **P1** | **dream 的 day 归属 = 运行时刻**：凌晨（如 02:09）触发的 dream 会整理"新的一天"，前一晚的原话永远不沉淀。live 11-07 有 130 条 raw、却没有 `day:2026-11-07`。 | 代码：`dream:428-430,1477`；live：`dream.dayCoverage`（days 只有 11-03/04/05/08/09/10），`rawComposition` 11-07=130 行 |
| F8 | **P1** | **`recall` 工具永远搜不到 `lexicon`**：它只用自己的 `CATEGORIES`（event/person/slang）建 namespace 列表，而 lexicon 注册为 `recallable:true`；空结果文案还会说"可能是过滤太窄"。 | 代码：`recall:34-41,254-257`；复现 D：`memory.search` 命中 lexicon（sim 0.17），`recall` 返回"这个范围里没有相关记忆（全局还有 1 条…）" |
| F9 | **P1** | **无嵌入时"精确串加成"是死代码**：`sim += 0.5*exact/terms` 只在 `if (qvec)` 分支内；`literal.test.mjs` 没有绑定 embed slot 却全绿（靠 bigram），该分支无测试。文档把该公式写成通用算法。 | 代码：`memory:314-341`；测试：`literal.test.mjs:12-20,22` |
| F10 | **P1** | **`provisional` 只写不读**：events/people 都标了低可信块，但 search/recall/eager/whois 都不看这个字段 → 无出处的猜测与有出处的记忆同权。 | 写入：`dream:627,838`；grep `provisional` 全仓仅这两处写，无读取 |
| F11 | **P1** | **day 边界/时区/多来源仍在收尾中**：recall 的 `dayStart/dayKey` 还是本机时区；`wash` 的 `hhmm` 用本机时区；bridge `rawList` 的 `until` 含上界、registry 聚合多来源时按来源顺序截断。 | `recall:24-32`；`dream:445`；`bridge:539-544`；`services:61-71` |
| F12 | **P2** | **账本/指标本身不可信**：审计工具不排除 `superseded`（把软删块继续算成"近重复/块数"），`dream 重复 run 组` 因唯一 key 恒为 0；`recordRun` 的 `deferred` 与 `return` 的 `deferred` 在 day-log 路径下不一致。 | `tools/memory-audit.mjs:87-106,164-172`；`dream:662,665` |

### 0.2 文档失准清单（过时/与代码矛盾）

| 文档 | 说法 | 实际 |
|---|---|---|
| `MEMORY.md:17` | 原文层 `dsh-raw` 扫磁盘会话 30天/400文件/20000条/缓存300s | 产品 preset **没有启用 `dsh-raw`**（`icl.patch.yml:41-57`）；live raw = bridge 的 `dsh-session`（`bridge:475-582`，`session-events.jsonl`，20000 行上限）。`dsh-raw` 只在 `bootstrap.mjs:16` 还留着死配置 |
| `MEMORY.md:117` | forget "删行也不删 mem_vec" | 代码删向量（`memory:420-433`）；同文 `:256` 又写"已修"——自相矛盾 |
| `MEMORY.md:161,172` | wash "读到 sender 时插在时间后，实际恒空" | bridge/bridge-raw 的 sender = role 或工具名（`bridge:512`；`dsh-raw:41`）；live day log 明确有 `assistant：/tool：` 前缀（`days/2026-11-09.txt:1`） |
| `MEMORY.md:74-83,92` | 精确串加成当作通用打分步骤 | 仅 `if (qvec)` 分支（`memory:320-331`） |
| `MEMORY.md:167` | index 无嵌入时 `indexed:0` 也记账 | 已改 `skip:no-embed`（`dream:1233-1238`） |
| `MEMORY.md:162` | block `text≤200 / body≤4000` | 现默认 summary≤100 / body≤1200（`dream:154-155`） |
| `MEMORY.md:157` | dream 三触发包含 `dream:nightly` 自动排程 | 产品 `scheduleEnabled:false` 且启动时取消旧 `dream:nightly`（`dream:1536-1553`；`icl.patch.yml:70-71`） |
| `MEMORY.md:261` | 日界"三处统一走 config.timezone" | recall 的 `dayStart/dayKey` 仍是本机时区（`recall:24-32`） |
| `MEMORY-AUDIT.md:25-34` / `HANDOVER-2026-11-11.md:52` | 5 对近重复"没有清理"/"12 组 run+skip 是重复痕迹" | 5 对已由 11-10 的 cleanup（模型合并，`merged:6`）软删：29 块中 **10 块 superseded**、19 存活，`mergedFrom/supersededBy` 齐备；run+skip 只是第二次触发正常跳过，不能证明重复执行——真正的重复执行证据是 `updated_at` 差值（F1） |
| `MEMORY-FIXES.md:73` | "后续可用 docs/quality 的召回评测脚本标定" | 标定脚本其实存在（`tools/threshold-calib.mjs`、`recall-bench.mjs`、`recall-diagnose.mjs` + `tools/fixtures/{calib-small,bench-qq}.json`），但**没有任何落盘的标定结论**：`docs/quality/` 只有 3 份 dream 质量快照；gold 模板所有日期全空（`.state/lab/memory-fixture/latest/gold.template.json`）；live 只有 3 条 recall 记录 → minSim/eager 阈值仍不可验证 |
| `MEMORY-BLOCK-QUALITY.md:257` | 近似合并要求"同一天/时间重叠" | `sameExperience` 在 day 缺失时放行（`dream:990-995`）→ F4 |
| `MEMORY.md:32-44` | namespace 注册者含 compaction | 产品 preset 不含 compaction（`icl.patch.yml:41-57`）；live 里 compaction namespace 是历史残留 |
| `MEMORY-FIXES.md:69` vs `HANDOVER:9` | 545/545 vs 879/878/1 | 文档互相矛盾；本次只跑定向 3 文件 27/27，未跑全量 |
| `HANDOVER:51` | "bridge 不再把 reasoning 拼进 raw"（已修） | reasoning 确实过滤（`bridge:40-50`），但 **assistant 的可见英文计划仍进 raw**（`days/2026-11-10.txt:2,3,6,8,10,12`）——修复不完整，见 F6 |

---

## 1. 写入与形成质量

### 1.1 四条写入路径的真实状态

| 路径 | 入口 | 代码 | key / 幂等 | 实际能否进入 block |
|---|---|---|---|---|
| `remember` | `recall` 插件工具 | `recall:156-180` | 缺省 `note:<now>:<rand5>`；显式 key 走唯一索引 upsert；weight 1.5；写完异步 `memory.index` | **event 类不能**（F2）；person 类可以（people 读 person note）；我们没观察到 live 里 remember 的 person note 被引用成块 |
| `memo` | `note.add`（`memo` 工具/SVC） | `note:26-35` | `key=null`，写几次几行 | 不进块，只进 purpose 段；`consume` 按 `about.namespace` 三支回收 |
| `lexicon_learn` | `lexicon.upsert` | `lexicon:39-85` | `lexicon:<conv>:<term>`；同 `(conv,url)` origin 合并 | 不进块；独立 namespace |
| dream | wash/events/people/lexicon/consume | 见 §3 | wash `day:<date>[:pN]`（upsert、重洗覆盖）；events `evt:<day>:<hash(summary)>`；people `person:<kind>:<value>`；consume `key=null` 的回收 note | 是唯一真正常态化产出块的路径 |

`memory.put` 的写入口径与文档一致的部分：唯一索引 `ux_mem_key(namespace,key) WHERE key IS NOT NULL`（`memory:47,191-204`）、更新保留 weight/`created_at`（`:195-199`）、改 text 删向量（`:198,371`）、未注册 namespace 抛错（`:187`）。

### 1.2 形成链路的单点：raw → day log → events

- `wash` 是唯一原料入口：`raw.list({since,until,limit:2000})` → `stripStructured` → 单行截断 → `day` log（`dream:428-516`）。**没有 role/来源过滤**（`:446-453`）。
- `events`：有 day log 时材料 = day log 行（`:532-537`），否则才用 note（`:534-537`）；写块 evidence 只从 day 行号取（`:582-587`）。
- `people` 的人名抽取从 day log 走（`:681-712`），`lexicon` 也从 day log 走（`:1279-1288`）。
- 结论：**记忆形成质量 ≈ day log 的质量**。`remember` 的强意图在这条链上没有任何优先级（F2），raw 的噪声在这条链上没有任何闸门（F6）。

### 1.3 静默丢弃/静默降级清单

| # | 触发 | 代码 | 后果 | 级别 |
|---|---|---|---|---|
| S1 | 模型输出非 JSON / `[]` | `parseBlocks` 吞异常返回 []（`dream:48-63`）；shard 仍 ok（`:553-566`） | 0 块 + 当天 run 记成功 + note 全标已消化 → 不能重试 | **P0** |
| S2 | 同 summary 块已存在且本轮无 evidence | `if (!evidence.length && previous) continue`（`dream:590`） | 新正文静默丢弃，旧块保留（有意，但无账） | P1 |
| S3 | 块 summary 为空 | `dream:578-579` | 整块静默丢弃，无计数 | P2 |
| S4 | `people` 对第 N 个人 `ask` 抛错 | `dream:797-799` | 直接 `return ok:false`，第 N+1..M 人本轮不再处理；已写 person note 下次重抽取（去重靠 `includes(fact.slice(0,20))`，易漏） | P1 |
| S5 | `cleanup` 模型输出不可解析 | `dream:1110-1139` | `root={}` → merged/rewrites 0，但 `cleanup` 记成功 → 当天不再整理、纠正也不消费 | P1 |
| S6 | `lexicon` 模型输出不可解析 | `dream:1339-1357` | learned 0、记成功 → 当天不再采集 | P1 |
| S7 | `consume` 的 done 行没有 `about.namespace` | `dream:1386` | 永远停在 done：不写回、不归档、每天被重扫（live 5 条 done 里 4 条属此类：3 条 MC 备忘 + 1 条测试残留，见 §7.2） | P2 |
| S8 | wash `no-raw` / `nothing-clean` | `dream:440,454` | 不写 run 行 → 同日会重跑；但旧 day log 已生成时块不会重算 | P2 |
| S9 | `recordRun` 在写块之后 | `dream:662` vs `:619-648` | 写块后崩溃/中断 → 无成功账本，重跑可能重复写（叠加 F1） | P2 |
| S10 | `index` 单条失败 | `dream:1240-1245` | 静默跳过，无失败计数 | P2 |

---

## 2. 身份 / 去重 / 合并

### 2.1 key 与 hash 语义

- event 块 key = `evt:<day>:<hash(summary)>`，`hash` 是 31 进制 32 位非加密散列（`dream:581,1566-1570`）。
- **key 由"生成当轮 summary 文本"决定**，不是由事实内容决定：同一件事两次独立生成，summary 一定是一次 paraphrase → 不同 key → 新块。live 5 对近重复就是两条独立执行链的产物（F1）。
- 事后 `cleanup` 的模型合并允许 `keep=某 key` 同时把 text 改成另一块的文本（`dream:1150-1161`）→ **块 text 与 key 不再对应**。实证：`#84` 的 key `evt:2026-11-09:1kran59` = hash(它的 text)，`#139` 的 key `evt:2026-11-09:u34jok` ≠ hash(它现在的 text)，而两者 text 完全相同（`.state/lab/.../current.json`；`dedup.mjs`）。
- person 块 key = `person:<qq>` 或 `person:<kind>:<value>`（`dream:731`）；lexicon key = `lexicon:<conv>:<term>`（`lexicon:42`）。

### 2.2 近重复：为什么写时抓不住、清理时也抓不住

- 写时：summary 哈希 + 唯一索引只能挡住"同一次生成被写两遍"，挡不住"同一事实两次生成"。
- 清理时：`mergeNearDuplicateBlocks` 的判据是**规范化 body 包含（≥20 字）或 bigram Jaccard≥0.8**（`dream:990-1053`）。对 live 5 对实测 Jaccard：0.635 / 0.461 / 0.580 / 0.349 / 0.410，包含关系全为 false（`dedup.mjs`）→ **0/5 命中**。11-10 的 `cleanup` 执行时 `nearDuplicates:0`，靠模型 `merges:6` 才把 5 对 + 另外 5 块（共 10 块软删）合并掉（`run:2026-11-10:cleanup` data `merged:6`，被合并块现在 10/29 `superseded`）。
- 因此：**去重机会在写入端（稳定身份）与清理端（语义相似）都被错过**；真正抓住它们的是"下一个成功调用 LLM 的 cleanup"，不可靠、有延迟、有窗口（只喂 150 块，`dream:1095`）。

### 2.3 跨身份合并（P0，复现 C）

`sameExperience(a,b)`：`if (dayA && dayB && dayA!==dayB) return false; return true`（`dream:990-995`）。person 块 data 没有 `day`（`dream:826-849`）→ 永远 true；正文长度 ≥20 且相同/相似即合并。live person 块的薄档案可能来自同一兜底模板（`dream:805`：`目前知道的：…`），风险真实存在。复现 C 结果：

```
cleanup = {"merged":1,...,"nearDuplicates":1}
person:name:甲 superseded:true by person:name:乙
```

文档语义是"同一天/时间重叠"（`MEMORY-BLOCK-QUALITY.md:257`）→ 代码与文档不一致，且这是不可见的身份损坏（检索层直接过滤 superseded，`memory:297`）。

### 2.4 其他去重/幂等洞

- **分块残留**：`body` 超长拆 `:pN`（`dream:610-618`）；若同一 summary 重跑后 body 变短（分块数减少），旧 `:pN` 行没有任何删除逻辑 → 残留块仍在检索池；`cleanup` 也不按 `parts.groupId` 归并。live 目前 0 个多段块（未触发），但路径存在。**P1**
- **`memory.put` 更新省略 `data` 会清空旧 data**（`memory:196-197`；复现 A：`data=null`）。现有调用方大多带 data，风险集中在未来/第三方调用。**P2**
- **memo / consume 回收 note 的 `key=null` 天生不幂等**（`note:29-32`、`dream:1399,1402`）；`consume` 在"写回成功、patch archived 前"崩溃 → 重跑再写一条。**P2**

---

## 3. dream 幂等与失败语义

### 3.1 触发与并发

- 触发只有两条信号路径（`dream:1527-1534` sleep-start；`:1555-1560` tags 含 `dream`）+ 内部 `force`（离线工具用）。时间侧 `tickMs` 默认 **15s**（`time:629`），到点安排由 tick 逐个 `startSchedule`。
- **没有任何 in-flight 互斥**：`run()` 不设 running 标志，`alreadyRan` 是"成功后账本"而不是"执行中租约"（`dream:1476-1493`）。两次触发/重复投递 → 两个 run 并行。
- **live 取证（11-09）**：两个 run 的 `now` 相差 **15.012s**（= 一个 tick）：

| 行 key | created_at | updated_at | 说明 |
|---|---|---|---|
| `run:2026-11-09:wash` | 15:00:12.457 | 15:00:12.457 | 第二次 skip |
| `run:2026-11-09:events` | 15:00:12.457 | **15:00:27.469** | 第二次真的重跑了 events |
| `run:2026-11-09:cleanup` | 15:00:12.457 | **15:00:27.469** | 同上 |
| `run:2026-11-09:people/lexicon/consume/index` | 15:00:12.457 | 15:00:12.457 | 第二次 skip |

  第一轮事件块 #82-92（created 15:00:12），第二轮 #135-145（created 15:00:27）；5 对近重复即跨两批。**`recordRun` 的 upsert 让"两次执行"在账本里只剩一行**——这正是审计/HANDOVER 看不出重复执行的原因（F1）。
- 为什么 events/cleanup 重跑而其他 job 跳过：第二次检查 `alreadyRan` 时，第一轮前 5 个 job 已完成，events/cleanup 尚未落账（events 有 11 个 shard 的模型调用）→ 竞态窗口。具体两个触发源无法从产物区分（sleep-start 与 dream 排程、或同一信号重复投递），但**代码对三者都不设防**。

### 3.2 三态账本语义（现状）

- 成功 `run:<day>:<job>`、失败 `fail:`、跳过 `skip:`（`dream:366-408`）；`alreadyRan` 只认 `run:`（`:362-365`）→ 失败可重试（正确），成功不重试（与并发窗口冲突）。
- 全 skip 不发 dream 回执（`:1443`），回执失败只 log（`:1466-1473`）。
- `pruneRuns` 只清 90 天账本（`:411-417`），`pruneRuns` 在 run 末尾（`:1489`）。
- `recordRun` 的 `deferred` 与 `return` 的 `deferred` 在 day-log 路径不一致（`:662` 记 `notes.length-covered.length`，`:665` 恒 0）→ 质量指标读到的是 1，回执算 0。**P2**

### 3.3 失败语义

- 事件 job：单片失败不拖垮（`:553-566`），全片失败才 `ok:false`（`:567-574`）；部分失败时 `degraded:true`，成功片照写——但没有"哪些片没写进来"的内容级记录，只有片号。
- `people`：任何人失败直接中止整个 job（`:797-799`），alreadyRan 不落 → 次日全量重来；person note 的抽取去重只比 20 字前缀（`:697-699`）。
- `cleanup`/`lexicon` 的模型输出解析失败被当成功（S5/S6）。
- `wash` 的写 day log 在 `recordRun` 之前（`:488-509`）：中途崩溃 → 部分分段写入且无账本。

### 3.4 day 归属（P1，live 有缺口）

`day = dayKey(now, tz)`，`now` = 信号时间/运行时刻（`dream:1477`）。凌晨触发的 dream 会把"新一天"当成整理对象：

- live：`run:2026-11-08:wash` 创建于 11-07 18:09 UTC = **11-08 02:09（+08）**，day=11-08，只洗到 3 行（02:08 的对话）；
- `day:2026-11-07` 从未生成，而 11-07 有 **130 条 raw**（`audit.json rawComposition`）→ 整天的原话没有沉淀。
- `MEMORY-AUDIT.md:152,163` 只记录了"缺口"现象，未定位到"day=运行时刻"这个机制。

### 3.5 重洗与 force

- `wash` 是 upsert + 先删当天旧分段（`:488-491`），force 重洗会把行号重排；evidence 只保留 160 字 `line` 快照与 `at`（`:227-235`），**没有任何"重洗后校验/重映射"**；`from/to` 仍是旧 `at`。块与 log 的对应关系会静默漂移。**P2**（文档 `MEMORY.md:252` 把它标成"已修"，只说对了一半）

---

## 4. 证据与来源

- **evidence 语义**：day 型 = `{type:'day', id:<day log 绝对行号>, line:<正文前160字>, at:<epoch>}`（`dream:227-235`；`line` 是快照，不是完整原文；live `#61.evidence[0].line` 以空格结尾，可证截断）。note 型 = `{type:'note', id:<mem_items id>}`（`dream:957-964`）。
- **上限不一致**：note 路径 `slice(0,20)`（`:962`），day 路径不设上限（`:582-596`）；文档写"evidence ≤20"只对 note 路径成立。
- **cleanup rewrite 的 evidence 是假 id**：模型只看到块的 key（`:1097-1098`），`rewrites.evidence` 却被当成"块 id"编号 → `{type:'block', id:Number(x)}`（`:1190-1193`）；这些 id 既不是 mem_items id 也不是 key，写进去只增噪。`whois` 读 evidence 时按 **person note id** 查（`whois:56-63,71`）→ rewrite 后的块 evidence 会查错/查空。**P2**
- **`provisional` 不参与任何读取**（F10）：低可信块可被 recall/eager/whois 无差别引用；`whois` 输出里也没有"存疑"标记。
- **内容污染（F6）**：
  - day log 含 `tool/result` 全文（`days/2026-11-09.txt:2` 是 time_status 的长状态串；`:76` 是水位工具结果）；
  - 含 assistant 的英文计划（`days/2026-11-10.txt:2,3,6,8,10,12`；`days/2026-11-09.txt:5` "Nothing. Idle. Maybe I could..."）——这些不是她说出口的话；
  - 因此 event 块记录运行状态：#92 "17:06 私聊水位还是 #62"、#145 同题扩写（live）；lexicon 收录工具名（§7）。
  - "tool/system 内容冒充她自己的话"不是理论风险：day log 的每一行在 events 材料里地位相同（`dream:532-537` 不区分 role），模型只能靠编号猜。

---

## 5. 检索 / 召回 / 清晰度

### 5.1 `memory.search`（代码核对）

公式与文档一致：有嵌入 `0.7*cos+0.3*bigram`、精确串 `+0.5*exact/terms`（封顶1）、无嵌入用 bigram 覆盖率、无 query 时 sim=1；`decay=exp(-age/max(1,hl))`，`anchor=lastRecalledAt??createdAt`，`score=sim*weight*decay`（`memory:314-351`）。清晰度由同一 `decay` 分档（`:79-86`），recall/eager 渲染时加标签（`recall:414-428`、`eager-recall:71-73`）——CLARITY.md 的描述属实。

实现层面的可验证问题：

| # | 问题 | 代码 | 级别 |
|---|---|---|---|
| R1 | 精确串加成只在有嵌入分支；无嵌入时 `ICL_NO_LITERAL` 完全无效 | `memory:320-341` | P1（F9） |
| R2 | 扫描窗口 5000 行是**跨 namespace 共享的 created_at DESC**；`superseded` 过滤在 SQL LIMIT 之后 → 软删块仍占窗口 | `memory:284-297` | P2 |
| R3 | `namespace` 不存在时静默返回 `[]`（不报错） | `memory:275-281` | P2 |
| R4 | `conv` 过滤只认 `data.origin.conv` → 所有 dream 块（无 origin）在任何 `conv` 查询下消失 | `memory:301-304` | P2 |
| R5 | 无嵌入 + 单字中文 query → 二元组为空 → sim=0 → 必然空结果 | `memory:331-338` | P2 |
| R6 | 更新 `data` 会清空旧 data（`put`） | `memory:196-197` | P2 |

### 5.2 `recall`（工具层）

- **命名空间固定为 event/person/slang**（`recall:34-41,254-257`）：`recallable:true` 的 `lexicon` 永远搜不到（F8，复现 D）；`overview` 路径同样只遍历 `CATEGORIES`（`:229-237`）。
- 相关度地板按 `embedded` 切换 0.35/0.2（`:50-57`），而 `embedded` 取决于本地 llama-swap 是否在线 → **同一 query 的检索行为会随后台服务状态漂移**；`index` job 一天只跑一次且 `alreadyRan` 后不再补。
- 未整理 note 以固定 `score:1.15` 插队、占半额配额（`:288-316`）；note 查询 `limit:200 desc`，更老的未整理 note 永远轮不到。
- `cursor:<sessionId>` 的 sessionId 来自 `bootstrap.mjs:15`（`cfg.sessionId ?? 'live'`），产品 preset 未覆盖 → **所有会话/群共用 `cursor:live`**：在一个会话里给过的块在另一个会话会被当成"已经给过"。
- cursor 损坏 → 空窗口（`recall:440-445`），文档已承认"全部再给一遍"；`take()` 第一条恒放行、预算按 `ceil(cjk/1.5+rest/4)` 估（`:17-22,302-313`）。
- 原文兜底只要注册了 raw 就每次搜（`:327-330`），但 bridge `rawSearch` 对空 query 返回 []（`bridge:546-548`）；`query` 为空时无意义调用。
- `boost` 只对真正 picked 的条目（`:324`），live 只有 3 条记忆 `recall_count=1`（`audit.json recall`）→ **boost/清晰度回升的长期行为没有数据支撑**，无法验证（不是缺陷，是证据缺口）。

### 5.3 `eager-recall`

- 阈值：有嵌入 0.5 / 无嵌入 0.2（`eager-recall:30-34`），调用 `memory.search` 不传 namespace → 扫全部 recallable（含 lexicon）。分数是 `score`（含 weight/decay），与 recall 的 `sim` 口径不同（文档有说明；两个阈值**没有落盘的标定结论**，见 §5.4）。
- **不排除已 `consolidated` 的 note**（`:57-59` 只过滤 cursor）→ 与 recall 的 `consolidated` 过滤（`recall:273`）不一致：同一条 note 在 recall 里"已整理"，在 eager 里还能反复注入。`MEMORY-BLOCK-QUALITY:205` 用"consolidated 过滤生效"解释现象，代码里没有这个过滤。**P2**
- 冷却只在进程内 `Map`，重启丢失；上限 200 条（`:36-37,77-83`）。
- 注入文案 `[tag]` 用 namespace 英文名（`event/person/lexicon`）+ `[未整理]/[有点模糊]`，与 `MEMORY.md:141` 描述一致。

### 5.4 无法验证 / 需要评测

- minSim 0.35、eager 0.5 的最优性：有离线脚本（`tools/threshold-calib.mjs`、`recall-bench.mjs`、`recall-diagnose.mjs`），但没有落盘的标定结论、没有 gold 标注（`gold.template.json` 全空），也没有进入任何测试/验收断言 → 只能算"有工具没结论"。
- live 只有 3 条记忆被 recall、eager 25 次评估（hits 73 / injected 44 / suppressed 29，`audit.json eager`）→ 无法据此判断排序质量；`injected` 里是否含已消化 note/lexicon 术语也未被分解统计。

---

## 6. person / whois

### 6.1 数据模型与匹配

- person 块：`subject{kind,value}` + `ids[]` + `aliases[]` + `facts/claims/profile/familiarity/provisional`（`dream:821-851`）。
- `memory.findPerson`：精确匹配 `ids`/`subject`/`key`/`qq`；名字只做 `text+profile` 子串（`memory:396-418`）——**`aliases` 完全不参与匹配**，也不会用于块间归并。**P1**
- `whois`：精确账号 → 档案；名字 → 候选（`whois:40-48`）；`recentEventsFor` 用 `person.data.qq ?? qq ?? ''` 去比 `event.data.people`（`whois:12-16,50`）。名字型 person 块 `qq=null` → 传空串 → 永远没有"最近事件"。**P1**
- `dream` 的 `relatedEvents` 用 `subject.value`（名字）去比 `event.data.people`（QQ）→ 名字型 person 块永远匹配不到（`dream:735-742`，文档 `MEMORY.md:178` 已承认）。live 实证：21 个 event 块的 `people` 全是 `["3429502459"]`，而 4 个 person 块没有一个是 `person:3429502459` → **`relatedEvents` 对所有现存 person 块都是空**。
- person 的 `evidence` 是 person note id（`dream:809,821-839`），`whois` 按 person note 查（`whois:56-63,68-78`）——这条链是通的（#109 evidence 9 条可查）。

### 6.2 live 身份取证（为什么 主人/Hahn123 拆分）

配置事实：`qq.selfId='2593621742'`（她自己），`qq.ownerQQ='3429502459'`（主人）（`icl.patch.yml:74-75`）。4 个 person 块（`current.json`）：

| 块 | subject / ids | 判断 |
|---|---|---|
| `person:2593621742` | subject qq=2593621742；aliases ["鱼鱼"] | 她自己（selfId）；text 是自述 |
| `person:name:Hahn123（离线版）` | subject name；ids 含 **qq=2593621742（=selfId！）** | 真人（主人）的档案，但把**她自己的 QQ** 挂到了主人身上 |
| `person:name:主人` | subject name；无 qq | 同一个真人（ownerQQ 3429502459）的第二个块 |
| `person:name:曾嘉睿` | subject name | 群友 |

- `whois {qq:'3429502459'}`（主人）→ 没有任何块的 ids/subject/qq 命中 → "还没有 3429502459 的档案"；而 21 个 event 块 `people` 都写着 3429502459。
- `whois {qq:'2593621742'}`（她自己）→ `findPerson` 精确命中**两个**块（#70 与 #109 的 ids）→ `people[0]` 取 id 更小的 #70，看似正常，但同一账号被两份档案同时声明。
- `whois {name:'主人'}` → 命中 #110，但 `recentEventsFor('')` → 无事件；名字型块有 claims（可追来源），事件线索却缺失。
- 拆分根因链：① raw 每条消息只有 role/tool 名，没有发送者身份（`bridge:512`）；QQ id 只偶然出现在"未读积压摘要"的用户消息文本里（`days/2026-11-10.txt:1`）；② people 抽取只输出 `who` 名字、subject kind=name（`dream:684-709`）；③ 抽取 prompt 明写"不要合并不同的人"（`dream:688`）；④ 块 key 按显示名（`dream:731`）；⑤ aliases 只写不读。→ **不是模型记性差，是身份链路没有主键**。

---

## 7. lexicon / note

### 7.1 lexicon 噪声根因（18/37 工具/框架词）

- 采集输入 = day log（`dream:1279-1288`），而 day log 含工具结果与工具名（§4）；采集器规则全靠 prompt（`dream:1308-1331`），**没有任何程序化闸门**（工具名黑名单/来源过滤/词形长度之外的过滤）。
- 一次采集即 `upsert`，缺释义就 `candidate` + 建"查一下「…」"待办（`dream:1347-1357`、`lexicon:39-85`）；主会话答完后 `consume` 把答案写回、转 `confirmed` 并归档 note（`dream:1389-1398`）——所以 18 条自动 note 现在全部 `archived`（17）或 `done`（1），**open=0**；但 37 条 lexicon 中 18 条是工具/框架词（`audit.json lexicon.toolish`，如 `mcb_servers/time_status/mc-body/body_error/阶段：awake/ICL/水位/睡段/睡眠边界/finish-then-handle/clip-zh 512d/积压/入库/去重命中`），且全部 `recallable:true, halfLifeDays:180`（`lexicon:10`）→ 这些词会长期参与 eager 注入、并在 180 天内不衰退。**P1（质量）**
- 老化脆弱：`usageState` 每次 upsert 都被重算回 `active`（`lexicon:61`），`ageLexicon` 刚写的 `fading` 会被下一次 upsert 覆盖（`dream:1253-1266`）；文档已承认，但 live 没有真正 fading 的词可验证。
- 其他：`origins` 无上限（不同 url 每次追加，`lexicon:48-51`）；`find()`、`dream:1299 的 known` 是死代码/未使用。**P2**
- live 真实待办只剩 1 条 candidate（`随手记`，`pending:true`）。

### 7.2 note

- 结构：`note/note`，`data.status`（open/done/archived/resolved）、`kind`（memo/question/promise）、`about`、`updates[]`、`result`（`note:26-67`）。
- 统计口径：`note_status` 用 SQL `count`（`note:44-46,158-164`），不受 500 行窗口限制；live 0 open / 5 done / 17 archived（`audit.json note`）。
- `raiseQuestion`：按正文字面去重、每次 run 上限 5（`dream:943-954`）；正文含 profile 前 20 字（`dream:855,1164`）→ 重写档案后同一问题会产生新 text → 可能重复提。**P2**
- `consume` 的 done-without-about 永远不归档（S7；live 5 条 done 里 4 条属此类）。
- purpose 契约：`openNotes` 创建时间升序取 3 条（`note:72-82`），`requiresTools:['memos','memo_commit']`（`note:168-174`）；live open=0 → 该段不出现，符合 PURPOSE.md。
- `memo` 确认语仍是"记下了。"，与 remember 的"记下了（key=…）"只差括号（`note:94-97`；`MEMORY-FIXES.md:47` 记录为"下一轮再改"，未做）。**P2**

---

## 8. raw 层

### 8.1 产品实际 raw 源

- **产品 preset 未启用 `dsh-raw` 插件**（`icl.patch.yml:41-57`）；live raw 来自 bridge：`state.raw` 内存 + 可选 `rawFile`（默认 `<stateDir>/session-events.jsonl`，`config.mjs:138`），启动时加载、追加写、上限 20000 行（`bridge:477-527`）。dream 的 skip 账本 `rawSources:['dsh-session']` 可证。
- bridge raw 的过滤：只收 `user/message|assistant/message|tool/result`；user 只认 `source.kind==='user'`（排除 runtime-context/skill-catalog）；跳过自己注入的 `<icl-context>` 前缀（`bridge:492-517`）。
- **reasoning 已过滤**（assistant 只留 `type==='text'`，`bridge:33-52`，commit 3b15e62），但**可见的 assistant 计划文本仍进 raw**（`days/2026-11-10.txt:2-12` 多处英文 plan）——HANDOVER 的"已修"只覆盖 reasoning（F6/失准清单）。
- `sender` 字段 = role 或工具名（`bridge:512`），**不是人名/QQ**；day log 前缀因此是 `user/assistant/tool名`（`days/2026-11-09.txt:1`），文档"恒空"过时。

### 8.2 组成与后果（live）

| 日期 | user | assistant | tool | 备注 |
|---|---:|---:|---:|---|
| 11-07 | 5 | 68 | 57 | 无 day log（F7） |
| 11-09 | 4 | 48 | 35 | day log 81 行 |
| 11-10 | 3 | 41 | 36 | day log 80 行 |
| 11-11 | 2 | 9 | 6 | 未 dream（最后一次 run 11-10 20:54） |

（`audit.json rawComposition`。assistant 行里大量是英文计划与工具调用前的推理式文本；tool 行含路径/ID/状态串。）

### 8.3 顺序 / 分页 / 边界

- bridge `rawList`：按内存/文件顺序（追加即时间序）`filter(since<=t<=until).slice(-max)`（`bridge:539-544`）→ 正常情况下是按时间正序的"当天最后 N 条"。`until` 用 `<=`（含次日 00:00:00 整点），与 `dayRange` 的 `[start,end)` 不一致。**P2**
- `services.raw.list` 聚合多来源时直接 `out.slice(0, limit)`（`services:61-71`）：一旦同时存在 bridge 与 `dsh-raw` 两个来源，顺序会是"来源 A 全部 + 来源 B 被截断"，wash 的时间序被破坏。产品当前只有一个来源，属**潜在**问题。**P2**
- `dsh-raw` 插件（产品未启用）自身有两个隐患：文件按 mtime **降序**拼接（`dsh-raw:73-75`）→ 多会话时消息不是全局时间序；`messages.slice(-maxMessages)` 在"最新在前"的数组上取的是**最老**的 20000 条（`dsh-raw:83`）。**P2（若启用即 P1）**

---

## 9. 测试缺口

### 9.1 已被测试锁住的行为（抽样，全部实跑通过）

| 行为 | 测试 |
|---|---|
| 顺序重跑幂等（already-ran 不重复写块） | `dream-jobs.test.mjs:77` |
| 失败不吞原文（模型抛错的 note 不标已消化） | `dream-jobs.test.mjs:89` |
| 同 summary 重跑 evidence 合并 | `dream-jobs.test.mjs:194` |
| 分片/预算/day log 分段/parts/经历窗口 | `memory-blocks.test.mjs:43-121` |
| cleanup 模型合并/纠错/幂等 | `cleanup.test.mjs:42+` |
| 确定性近似合并（**仅包含关系**） | `memory-blocks.test.mjs:123` |
| 未整理 note 的召回与"模型不肯成块"（**仅无 day log 路径**） | `pending-notes.test.mjs:40` |
| recall 诚实空结果/不 boost/不凑数 | `recall-honesty.test.mjs:71+` |
| cursor 去重、预算、boost | `recall.test.mjs`（10 条） |
| eager 阈值/冷却/截断/不投递 | `eager-recall.test.mjs:44+` |
| person 精确账号/MC 身份/名字候选 | `whois-tags.test.mjs:52`、`identity-e2e.test.mjs:19`、`subject.test.mjs` |
| 精确串（**无嵌入环境**） | `literal.test.mjs:22+` |
| 原文兜底 | `archive-fallback.test.mjs` |
| index 补建/no-embed | `vector-backfill.test.mjs:48+`、`dream-observability.test.mjs` |

### 9.2 关键路径没有测试（逐条）

1. **并发/双触发 dream**：两个 `dream.run` 重叠 → 无锁、重复执行；现有"幂等"用例是顺序第二次（`dream-jobs.test.mjs:77`），永远看不到竞态。
2. **有 day log + 模型输出 `[]`/垃圾**：note 被全量 `consolidated`、0 块仍成功（复现 B）。`pending-notes` 只覆盖无 raw 的 note 路径（`pending-notes.test.mjs:40`）。
3. **跨 person 的确定性合并**（复现 C）：没有任何测试构造"不同人、同模板正文"。
4. **人物 alias/同名多人/错误账号**：没有测试；`whois-tags` 只测"名字给候选"。
5. **`mergeNearDuplicateBlocks` 对 paraphrase 的召回**：只测包含关系（>0.8 Jaccard），live 5 对全部漏网（0.35-0.635）。
6. **`events` 无 evidence + previous 时丢弃新正文**（S2）。
7. **分块残留 `:pN`**（body 变短/重跑）。
8. **`memory.put` 更新省略 data 清空**（复现 A）。
9. **跨午夜 day 归属**（F7）：`dream-jobs` 有"按 config.timezone"用例，没有"凌晨运行该洗前一天"。
10. **`recall` 能否召回 lexicon / 损坏 cursor / `conv` 过滤掉所有块**：无测试。
11. **eager 会不会注入已 consolidated 的 note**：无测试。
12. **`dsh-raw` 排序/上限反转**、bridge `rawList` 的边界/多来源聚合：无测试。
13. **召回质量评测没有进入验收**：有脚本（`tools/{recall-bench,recall-diagnose,threshold-calib}.mjs` + `tools/fixtures/`），但没有 CI/断言、没有把结果写进 `docs/quality/`、`gold.template.json` 全空；live 只有 3 条 recall 记录，无法验证阈值。

### 9.3 本次实际运行的测试

```
node --test --test-force-exit --test-timeout=120000 \
  packages/core/test/dream-jobs.test.mjs \
  packages/core/test/pending-notes.test.mjs \
  packages/core/test/memory-blocks.test.mjs
→ tests 27 / pass 27 / fail 0 / duration 830ms
```

---

## 10. 根因级设计缺陷（不是代码 bug）与给 Lead 的开放问题

### 10.1 根因（按影响排序）

1. **两个写入真源、一个整理通道，且没有仲裁**：`remember`（强意图）与 day log（全量原文）都进 dream，但 `events` 只认 day log，并把 note 当"已覆盖"标掉（F2）。→ "她想记的"不能保证进块；"系统看见的"才是真源。这是产品语义问题，不是 `markNotes` 一行的 bug。
2. **raw 层没有"谁在说、说给谁、是否说出去了"**：只有 role + 文本。assistant 的未发送计划、工具结果、系统状态与"她对人类说的话"同权（F6）。dream 里任何 prompt 修补都只能猜。→ 需要输入 profile（`raw-human`：只 user + 真正 send 出去的 assistant，tool 折叠），这正是 HANDOVER 的下一轮方向，但代码层没有任何开关。
3. **幂等模型选错**：用"成功账本"实现幂等（`run:<day>:<job>`），没有执行租约/attempt id。重复执行在数据上不可见（upsert），只能靠 `updated_at` 差值发现（F1）。→ 应改成"执行状态机 + 单飞锁（lease）"，或至少记录 attempt 列表。
4. **事件身份靠"生成摘要的哈希"**：同一事实两次生成必然 paraphrase（F1 的 5 对），而确定性去重阈值（0.8 Jaccard）接不住 paraphrase（0.35-0.63）。→ 事件块身份应由结构决定（day + evidence 行集合/时间窗 + people），摘要只做展示；去重应从"摘要相等"改为"证据集合重叠"。
5. **person 没有稳定主键**：以显示名做 key，账号写在 ids 里但既不校验也不用于归并，`aliases` 只存不用；selfId/ownerQQ 是产品已知事实却没有进入身份链（§6）。→ 应"账号优先、名字是 alias"，并允许显式 alias 合并（而不是靠模型单轮抽取自己猜）。
6. **质量闸门全在"生成之后"**：lexicon 先收后补、events 先写块后合并、note 先建再说。生成前的门槛（role/来源/是否工具词/是否运行状态）没有落到代码，只有 prompt 里的软规则（§7.1）。→ 记忆预算被"运行状态/工具术语"占用，且它们 `recallable` 长期可注入。
7. **可观测只到 job 级，不到执行级/内容级**：`dream-run` 无法区分同 job 两次执行（upsert），审计工具又把 superseded 算进块数/重复对（F12）→ 基于 live 库得出的结论会系统性低估"重复执行"、高估"重复块"。→ 指标口径与复现脚本应成为交付物的一部分。
8. **读取层在补偿写入层的债**：eager 扫全部 recallable 来"捞" lexicon 工具词、recall 靠 floor 0.35 挡凑数、`pendingNotes score 1.15` 抢配额——这些都是对"写入质量不可控"的补丁；它们各自又引入新不一致（F8/F10/consolidated 过滤不一致）。→ 先修写入/身份，再谈阈值标定。

### 10.2 给 Lead 的开放问题

1. **产品要她记什么**：关系与经历，还是也包含运行状态/操作日志？如果是前者，day log 必须做 role/来源 profile（raw-human），并且要接受"11-07 这类整日丢失"是 day 归属问题而不是稀疏日。
2. **`remember` 的合约**：是否承诺"显式 remember 的 event 一定不会被 dream 静默吞掉"？若承诺，dream events 必须合并 note 材料或把 note 升级为块，而不是 `markNotes` 全标。
3. **person 的唯一键**：是否以 QQ（含 selfId/ownerQQ）为主键、显示名只做 alias？"暂无账号的人物"允许存在吗？允许谁发起 alias 合并（模型/人工/规则）？
4. **dream 触发收敛**：是否只保留一个入口（sleep-start 或 schedule 二选一），并为 `run` 加单飞租约？同一 job 允许跨天重跑几次、失败重试上限？
5. **去重策略**：event 块是否改成"证据集合"身份（day + 行 id 集合）？`cleanup` 的确定性合并是否只允许 event 且要求 evidence 重叠，person 一律禁止算法合并（只允许显式 alias）？
6. **lexicon 门槛**：工具/框架词是"不要收"还是"收但不可回忆/不进 eager"？需要一个可维护的 deny/门禁，还是让 lexicon 完全不读 tool/result 行？
7. **审计口径**：是否把 `superseded` 从块数/重复对里剔除、把 `dream-run` 加 attempt 维度？下一版 MEMORY-AUDIT 是否直接引用本次的复现脚本作为基线？
8. **文档所有权**：`MEMORY.md` 自述"最后核对 2026-11-03（HEAD d9b5f84）"，之后 `git log --since=2026-11-03 -- packages/plugins/{dream,memory,recall,eager-recall,note,lexicon,whois,dsh-raw} docs/MEMORY.md` 有 **13 个 commit** 动过这些文件；是否指定"代码变更必须同步 MEMORY.md 的验收段落"，否则本审计的失准清单会继续扩大。

---

## 附录 A：可复现命令与产物

```powershell
# 1) 数据事实（只读 .state/lab 产物，不碰 live）
node .state/lab/code-audit/dump.mjs            # dream-run/事件块/person/lexicon 明细
node .state/lab/code-audit/dump2.mjs           # run 行 created/updated 差值（F1 取证）
node .state/lab/code-audit/superseded.mjs      # 5 对近重复的 superseded/mergedFrom 状态
node .state/lab/code-audit/final-facts.mjs     # evidence 类型/people/provisional/recall/eager 汇总

# 2) 行为复现（临时 stateDir，不写 live）
node .state/lab/code-audit/repro.mjs           # A: put 清空 data；B: dayLog+[] 吞 note
node .state/lab/code-audit/repro-c.mjs         # C: 不同人的 person 块被算法合并
node .state/lab/code-audit/repro-lexicon-recall.mjs  # D: recall 搜不到 lexicon（空结果文案误导）

# 3) 定向测试（本次实际运行）
node --test --test-force-exit --test-timeout=120000 `
  packages/core/test/dream-jobs.test.mjs packages/core/test/pending-notes.test.mjs packages/core/test/memory-blocks.test.mjs
```

说明：`.state/lab/code-audit/` 下均为本次审计的 scratch 脚本与输出，不属于产品代码；`.state/lab/memory-audit/latest` 与 `.state/lab/memory-fixture/latest` 为既有只读审计/回放产物（本次未重新生成、未读 live DB）。
