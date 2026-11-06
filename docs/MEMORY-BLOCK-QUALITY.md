# 记忆成块质量：根因 / 证据 / 修法（night-1 质量门）· 2026-11-06

> 触发：E2 质量监控在 night-1 基线发现"记忆成块"异常；用户点名"真实事件记忆成块还没测过，可能引出记忆模块修改"。
> 本文只做**只读定位 + 修法方案**；除注明"低风险"的项外**不改代码**，等用户/lead 拍板。
> 证据窗口：`C:\DSH\icl-wt\mc-lab\.state\lab\night-1`（只读，未启动 lab/未占 GPU）。

## 0. 结论先行

**"真实事件没有成块"不是 memory 的分块算法坏了，而是 dream 的模型插槽在 lab 里根本没绑定**：
night-1 的 3 个 dream 记录全是**不需要模型**的 job（wash / consume / index），所有需要模型的 job（events / people / lexicon / cleanup）
都因 `插槽 dream-chat 还没有绑定模型` 失败；失败只进日志、不进 `dream-run`，所以质量报告显示"failures 0"。
`day/log 138,778 字符` 是**原料**（wash 落盘整天原文），不是"事件块"；E2 把它算进了块大小指标。
`consume 0` 是正常（那晚没有 `status=done` 的备忘）；`index 0` 是因为**没有嵌入模型**，但 job 仍报 `ok:true`（静默 0）。
`recall 0 调用` 是模型没被教会何时用（sim 只有一句"想不起来先查"），eager-recall 0 注入则是没嵌入+命中阈值。

## 1. 证据（night-1，只读）

### 1.1 质量报告（`.state/lab/night-1/quality.jsonl` 第 2 条 + `quality-report.md`）

| 指标 | 值 | 说明 |
|---|---|---|
| 记忆 items | 6 | 2×`event/note` + 1×`day/log` + 3×`dream-run/run` |
| 块大小 p50/p95/p99 | 256 / **138,778** / 138,778 | p95 被 day/log 单条拉爆（E2 阈值 1200） |
| `day/log` | 1 行 / **138,778 字符** | = wash `chars:138779` 的全文 |
| dream runs | 3（jobs: wash 1 / consume 1 / index 1） | **没有 events/people/lexicon** |
| dream failures | 0（报告口径） | 失败不进 `dream-run`，所以看不见 |
| consume | `{written:0, archived:0}` | 无 done 备忘，正常 |
| index | `{indexed:0, missing:2}` | 无嵌入模型，`memory.index()` 返回 false |
| recall | calls 0 / empty n/a / remember 1 / forget 0 | 模型整晚没调用 recall |
| eager-recall | 注入 0 次 / 0 字符 | 无嵌入 + 无字面命中 |
| events | total 2900 / body 2042 / memoryEventBlocks 2 / dupSeq 0 | 事件→记忆覆盖率 ≈ 0.07% |

### 1.2 记忆库直查（`state/icl-mc-lab/state/memory.db`，`readOnly`）

```
id  namespace   kind  key                      chars
3   day         log   day:2026-11-06           138778
4   dream-run   run   run:2026-11-06:wash      15
5   dream-run   run   run:2026-11-06:consume   18
6   dream-run   run   run:2026-11-06:index     16
1   event       note  note:1793896745906:qrp9t 256
2   event       note  note:1793901251229:2pa7w 215
mem_vec: 0 行
```
只有 2 条事件 note（主会话 `remember`），**0 个 event block**。

### 1.3 复现（本机，host 级，未起 lab）

同一套插件、`providers=[]`（与所有 lab patch 一致：26 个 lab run 的 `lab.patch.yml` 都没有 `providers:`）：

```
slots.unmatched = [{"id":"embed-text","kind":"embedding"},{"id":"dream-chat","kind":"chat"}]
dream.run({jobs:['wash','events','consume','index']}) →
  wash: skipped no-raw
  events: ok:false, degraded:true, failedShards:1,
          error:"插槽 dream-chat 还没有绑定模型"      ← 与 night-1 完全同因
  consume: skipped no-note-plugin（night-1 有 note 插件 → 0/0）
  index: ok:true, indexed:0, missing:1              ← 无嵌入时也报 ok
memory.index(id) → false                              ← 静默 0 的原因
```

### 1.4 代码路径

| 事实 | 代码 |
|---|---|
| 只有 `model-manager` 绑 ICL 模型槽；providers 来自 `cfg.providers` | `packages/plugins/model-manager/src/index.mjs:65-79`；`bootstrap.mjs:25` `case 'model-manager': { providers: cfg.providers ?? [] }` |
| lab patch 没有 `providers:`；`config/icl.local.json` 不存在 → providers=[] → 槽不绑 | night-1 `lab.patch.yml`（全文无 providers）；`C:\DSH\icl-wt\mc-lab\config` 只有 `icl.example.json` |
| DSH bridge 不绑 ICL 槽（主会话模型走 DSH 路由，与 ICL 后台模型无关） | `packages/dsh-icl/src/bridge.mjs`（无 slots 绑定） |
| wash 把整天原文写成**一条** `day` 记忆 | `dream/index.mjs jobWash`：`lines.join('\n')` → `memory.put({namespace:'day',kind:'log'})` |
| `day` 命名空间不可回忆（不参与 recall 检索） | `recall/src/index.mjs`：`recallable !== false` 过滤；memory.search 也只查可回忆命名空间 |
| events 的输入是 day log 全文 | `jobEvents`：`material = dayLog.text.split('\n')`（分片是 G-1 之后才有的） |
| `dream-run` 只在 job **成功**后记录；失败不写 | `recordRun()` 调用点：wash/events 成功路径；events 失败早返回不 record |
| index 无嵌入时仍报 ok | `jobIndex`：`const ok = await memory.index(...); if (ok) indexed += 1`，无 embed 时全 false 但 job ok:true |
| recall 无教学场景 | `prompts/sim.md` 记忆段仅 2 行："想不起来就先查，不要用编造填补记忆的空" |
| eager-recall 阈值 + 无嵌入 | `eager-recall/src/index.mjs`：`minScore 0.5 / minScoreNoEmbed 0.2`，命中才注入，无日志计数 |

## 2. 根因（按重要性）

| # | 根因 | 影响 | 级别 |
|---|---|---|---|
| **R1** | **lab 里 ICL 模型槽从未绑定**（所有 lab patch 都无 `providers`，mc-lab 无 `config/icl.local.json`）：dream 的 events/people/lexicon/cleanup 全部失败，wash/consume/index 恰好不需要模型 → 质量报告只看到这 3 个 job，误以为"整理正常" | 整晚 0 事件块；"失败 0"是假象 | **P0** |
| **R2** | **失败不可见**：dream-run 只记成功 job；模型失败只进 `dream.run` 日志（且 lab 日志未落盘到质量数据）；无 `dream-result` 回执（已在本轮 C4 补上失败回执，但 night-1 是旧代码） | 质量门无法区分"没跑"和"跑失败" | **P0** |
| **R3** | **指标把原料当块**：`day/log` 单条 138,778 字符被计入"块大小 p95"，触发 memory-block-too-large 告警；但它 `recallable=false`，不进 recall，也不是事件块 | 误报"记忆成块问题" | P0（指标修） |
| **R4** | **block 大小上限与 E2 阈值不匹配**：events 的 body 上限 4000、summary 200，而 E2 阈值为 1200；即使成块也会被判定过大 | 修好 R1 后仍会触发告警 | P1 |
| **R5** | **index 静默 0**：无嵌入模型时 job 报 `ok:true, indexed:0`，不区分"没能力"与"失败"；E2 的 index 指标无法判断 | 索引覆盖率永远 0 且不可解释 | P1 |
| **R6** | **consume 0 被误读为"成块失败"**：它只处理 `status=done` 的备忘（且要求 `about.namespace/result`），那晚没有；与事件成块无关 | 指标误导 | P2（指标修） |
| **R7** | **recall 0 调用**：模型没有"何时该查记忆"的教学/示例；且 `recall` 与 `remember` 在工具面同时存在，无名场景 | 覆盖率/体验都差 | P1 |
| **R8** | **eager-recall 0 注入且不可观测**：无嵌入时靠字面阈值 0.2，2 条笔记与消息无重叠 → 0；注入次数只存在日志（未进质量数据） | 无法判断是"没有可注入"还是"坏了" | P2 |

## 3. 修法方案（已实施 3 条可观测修复；行为修改待用户批准）

### 3.0 已实施（低风险、只让问题可见；本轮 commit，见 `git log -- docs/MEMORY-BLOCK-QUALITY.md`）

| # | 修复 | 行为 |
|---|---|---|
| 1 | **dream 失败/跳过落 `dream-run`** | 成功仍写 `run:<day>:<job>`（不变）；失败写 `fail:<day>:<job>`（`kind:'run'`，`data:{ok:false,error,job,degraded?,failedShards?}`）；跳过写 `skip:<day>:<job>`（`data:{ok:true,skipped,job,missing?}`）。不占成功 key → 不影响 `alreadyRan`（第二天能重跑）。 |
| 2 | **`jobIndex` 无嵌入明确 skip** | 无 embed 时返回 `skipped:'no-embed', missing:N`（不再 `ok:true/indexed:0`）；有 embed 才走索引与 `indexed/failed`。 |
| 3 | **boot 槽健康自检** | `bootstrapHost` 后读 `slots.unmatched()`；非空时 `icl.slots-unmatched`（level=error，带槽 id），并在 `icl.ready` 里带 `slots.unmatched`。 |

对应测试：`packages/core/test/dream-observability.test.mjs`（4 条：失败行/成功不写 fail/replace 型 skip 行/boot 槽日志）。
**不改**任何记忆/成块/提示词语义；`dream-result` 回执（`60d8abe`）已把失败带进醒来简报。

### 3.1 P0：让 dream 真的能跑（R1+R2）

1. **lab 侧配置（1 行级，待 mc-lab 修）**：`tools/lab.mjs` 生成 `lab.patch.yml` 时，给 `icl-mc-lab`/`icl-lab` 的 core config 加 `providers:`（指向本次 lab 的模型端点；云端或本地），并把 `model-manager` 的 `pluginConfig` 透传。night-1 的主模型是 `ninfer/coder390`，但 ICL 后台模型可独立选（建议默认复用 lab 的模型端点）。
2. **启动自检**：✅ 已实施（见 §3.0 第 3 条）。质量报告读取 `icl.ready.slots.unmatched`（或 `icl.slots-unmatched` 日志）。
3. **失败落账**：✅ 已实施（§3.0 第 1/2 条）。`dream-result` 回执（已实现）会把失败带进醒来简报。
4. **验收**：修后一次 lab 睡眠周期，`dream-run` 应有 wash/events/people/lexicon/consume/cleanup/index 的成功/跳过/失败条目（三态齐全），events `blocks > 0`。

### 3.2 P0：E2 指标口径修正（R3+R6）

- **区分"原料 item"与"可回忆块"**：`day/*`、`dream-run/*` 不计入 blockChars；只统计 `event/person/slang` 的 `kind='block'`（以及 `event/note` 作为待整理原料单列）。
- **新增 dream job 表**：`ran / skipped(reason) / failed(error)` 三态；`failures` 不再只看 dream-run 行数。
- **新增槽健康**：`slots.unmatched` 列表 + `embedded` 布尔。
- **consume 不计入"成块"指标**，改为"备忘回收：written/archived"。
- E2 告警阈值保留（block p95 ≤1200），但只对"可回忆块"生效。

### 3.3 P1：块大小与分块策略（R4）

- **块大小目标**：`event block` 的 `summary ≤ 100 字`、`body ≤ 1200 字`（对齐 E2 阈值）；超长事件拆成多块并带 `data.parts = {groupId, part, total}`（引用同一段经历的 evidence），检索时可按 group 合并展示。
- **按经历的窗口切分**：events job 先按"时间间隔 > 30 分钟"切经历段，再在段内按话题合并；每段产出 1–3 块，避免"一天 1 块"或"每事件 1 块"两个极端。
- **day log 分段落盘**：`day:<yyyy-mm-dd>:p1..pN`（每段 ≤40k 字符；保留绝对行号），events/lexicon 按段顺序读取；避免单条 138k 进入记忆库（R3 的根因），也让"当天原话"可被按段引用。
- **可配置**：`events.maxBlockChars`（默认 1200）、`events.segmentGapMs`（默认 30min）、`wash.maxSegmentChars`（默认 40k）。

### 3.4 P1：recall 触发与教学（R7）

- `prompts/sim.md` 的记忆段补 2–3 条**具体触发场景**（用户问"上次/以前/那个事"、需要旧细节、自己不确定时先查），并给一个"查完说依据"的示例；
- `recall` 工具描述补"when：用户提到过去/需要旧细节/要核对记忆"；
- 质量指标：recall 调用率（每 N 轮 ≥1 次）、空结果率、平均返回条数/字符；不达标就继续调 sim，不调算法。

### 3.5 P2：索引与 eager

- `jobIndex`：无 embed → `skipped:'no-embed'`（不再 ok:true/0）；有 embed → 记 `indexed/failed`；
- E2 指标：`indexCoverage = vec / recallableItems`，无 embed 时显示"未配置嵌入"而不是 0%；
- eager-recall：每次评估记 `hits/injected/chars` 计数（进质量数据），便于区分"没命中"与"坏了"。

### 3.6 用户已批准并已实施（2026-11-06）

1. **day log 分段落盘**：`day:<yyyy-mm-dd>` + `day:<yyyy-mm-dd>:p2..pN`，每段 ≤ `maxSegmentChars`（默认 40k，可配）；保留原话绝对行号；`readDayLog(day)` 按段拼接供 events/people/lexicon 读取（§3.3）。
2. **event block 上限 + parts**：`summary ≤ maxBlockSummary`（默认 100）、`body ≤ maxBlockBody`（默认 1200）；超长正文按句拆块，后续块带 `data.parts={groupId,part,total}`，首块不带 parts；检索可按 groupId 合并（§3.3）。
3. **按经历时间窗切段**：events 先按"相邻行 HH:MM 间隔 > `segmentGapMin`（默认 30min）"切经历段，再段内按请求大小分片（§3.3）。
4. **recall 触发教学**：`prompts/sim.md` 补 3 条触发场景（问过去/要旧细节/不确定先查）+ "没找到就说没找到"；`recall` 工具 `when` 补对应场景（§3.4）。
5. **eager-recall 计数可观测**：每次评估把 `hits/injected/chars/threshold/embedded/queryChars` 追加到 `eager-recall.jsonl`（`configFor('eager-recall')` 默认 `<stateDir>/eager-recall.jsonl`）；E2 可直接读（§3.5）。

测试：`packages/core/test/memory-blocks.test.mjs`（4 条：day 分段/block parts/经历窗口/eager 计数）；回归 `dream-jobs`、`recall-honesty`、`dream-observability`、`eager-recall` 全绿。

> 语义影响：1–3 改变 dream 的输出形状（day 行数、块数、请求数），但 **不改** memory 检索/评分语义，也不改静态 system/facts 结构（cache 红线：`icl:core`/`icl:facts` 布局不变；sim 文案有更新属静态文本演进）。

## 4. E2 判据 ↔ mc-quality 快照字段对齐

mc-lab 的 `tools/mc-quality.mjs` 现状快照字段（night-1 即由它产出）：
`mem.{items,bytes,byNs,dupRows,dupRate,blockChars{p50,p95,p99}}`、
`dream.{runs,jobs,failures,days,dayLogRows}`、`recall.{calls,empty,emptyRate,avgResultChars,noiseHits,remember,forget,samples}`、
`eager.{injections,chars}`、`latency.{samples,p50,p95}`、`events.{total,bodyRows,memoryEventBlocks,dupSeq}`、`anomalies[]`；
默认阈值：`blockChars p95 ≤1200`、`p50 ≥20`、`dupRate ≤0.2`、`recallEmptyRate ≤0.6`（calls≥5）、`latency p95 ≤300000ms`、`growth ≤60/h`。

本修复后，判据全部用现有字段或新增的 `dream-run` 行即可判定（**不需要改 mc-quality 解析器**）：

| 判据 | 判定 | 数据源（字段） | 现状/阈值 |
|---|---|---|---|
| 事件→记忆覆盖率 | 每个有效会话日 `≥1` 个 `event` block；周覆盖 ≥5/7 天 | `events.memoryEventBlocks`（现为 event namespace 行数） | night-1 = 2（全是 note，0 block）→ 不达标；修 lab providers 后应 ≥1 block/天 |
| 可回忆块大小 p95 | `≤1200` 字符 | `mem.blockChars.p95` —— **需按 §3.2 把 `day/*`、`dream-run/*` 排除**（现状把 138k 原料算进来） | night-1 = 138778 → 口径修后看 event/person/slang block |
| 原料单条上限 | `day` 单条 ≤40k（分段后）；总 items ≤200k/天 | `mem.byNs['day/log']`、`mem.items` | night-1 day/log=138778 → 分段后应 ≤40000 |
| dream job 三态 | 每个实际进入 run 的 job 必须有 `run:`/`fail:`/`skip:` 之一；失败必须有 `error` | `dream.jobs`（job 计数）+ `dream.days`（最新 data）+ `dream.failures`（`data.error` 行数）；新增行见 §3.0 | night-1 缺 events/people/lexicon/cleanup 行 → 三态修后应齐全 |
| 槽健康 | `slots.unmatched = []` | `icl.ready.slots.unmatched`（日志）或 quality 额外读 dsh 日志 | night-1 = `["embed-text","dream-chat"]` |
| recall 使用率 | 每 20 轮 ≥1 次；问过去类消息 ≥50% | `recall.calls` / turn 数 | night-1 = 0/64 轮 → 不达标（走 §3.6-4 教学） |
| recall 空结果率 | `≤0.6`（calls≥5 才报警）；连续空 ≥3 次人工看 | `recall.emptyRate`（阈值已内置） | night-1 n/a（0 调用） |
| recall 噪声 | `noiseHits` 不随 calls 线性增长；单次返回 ≤ budget | `recall.noiseHits`、`avgResultChars` | 现状 0 |
| index 覆盖 | 有 embed：`vec/recallableItems=100%`；无 embed：**明确 no-embed**（job skip 行），不算失败 | `mem.byNs` 中可回忆行数 vs `mem_vec`（quality 需补一个 `mem.vectors`）；dream `skip:*:index` 行的 `data.missing` | night-1 无 embed → 应为 `skip:...:index no-embed`，不再 `ok:true/0` |
| dream 失败可见 | 任何 `data.error` 行数 = 实际失败数；`dream.failures` 与 `fail:*` 行数一致 | `dream.failures` + `dream-run` 行 | night-1 报告 0 是假象；修后应 ≥3（events/people/lexicon） |

**给 cache 的"长跑健康对照"字段（同一份 quality.jsonl 就能读，不用新落盘）**：
`dream.jobs`（每 job 次数）、`dream.failures`、`dream.days`（含 `skipped`/`error`）、`dream-run` 里 `fail:`/`skip:` 前缀 key 数；
槽健康读 `icl.ready.slots.unmatched`；索引覆盖读 `dream.days.index`（`indexed/missing` 或 `skipped:no-embed`）。
判定：`dream.failures==0` 且 `dream.jobs` 覆盖当日执行集才算"dream 健康"；`failures>0` 或 job 缺行 → 长跑报告标红。

## 5. 执行顺序与当前状态

1. ✅ **已实施（低风险可观测）**：dream job 失败/跳过落 `dream-run`（`fail:`/`skip:` 行）+ `jobIndex` 的 `no-embed` skip + `slots.unmatched` 启动日志——见 §3.0，测试 `dream-observability.test.mjs`。
2. ✅ **lab 配置**：mc-lab 已在两个 lab preset 注入 8088 chat/embedding providers（commit `34b450a`），槽健康恢复。
3. ✅ **E2 指标口径**：mc-lab 已改为三态统计（ran/skip/fail + 缺行 `dream-job-missing` 告警）与原料/块分离（§4 字段）。
4. ✅ **分块策略（用户 2026-11-06 批准）**：day log 分段 + block 上限/parts + 经历窗口，见 §3.6；测试 `memory-blocks.test.mjs`。
5. ✅ **recall 教学（用户批准）**：sim 3 条触发场景 + recall `when`；eager 计数落 `eager-recall.jsonl`（§3.6）。

> 蓝队补充：`dream-result` 回执（`60d8abe`）会把 dream 失败带进醒来简报；`recordOutcome` 新增兜底：`ok:true` 但 job 没自己写 `run:` 时补 `run:`（`empty:true`），保证三态不因未来新 job 漏记。

---

## 6. 首次实测：E2 11:47 短睡（A 路线，2026-11-06）

> 证据：`C:\DSH\icl-wt\mc-lab\.state\lab\e2-20261106-smoke`（commit 9cc6df6，readOnly；未起 lab）。
> 触发：dream:nightly 被短睡提前触发；provider = A（8088 qwen35-9b / embed-bge-m3）；`slots.unmatched=[]`、`embedded=true`。
> lead 给的口径数字（wash 759 行 / events 5 块 / index 4 / degraded 1）在下表逐项核对一致。

### 6.1 结果总表（dream 回执 + 质量快照）

| 项 | 实测 | 判定 |
|---|---|---|
| dream | `ok:true`；7 job：wash/events/lexicon/consume/cleanup/index ran，people skipped(no-notes) | ✅ 三态齐全（无缺行/无 fail） |
| dream-result text | `wash 759 行 / events 5 块 / lexicon 0 条 / consume 0 / cleanup 1 合并 3 改写 / index 4 条 / 分片降级` | ⚠ "分片降级"见 §6.2 |
| event block | **5 块**；summary p50/p95 = **30/37** 字符；body **97–228** 字符；**无 parts**（未超 1200，符合设计） | ✅ 尺寸合规 |
| day log | **5 段**（39960/39770/39628/39866/29560 字符），行号 1–759 **连续无缺/无重** | ✅ 分段正确 |
| mem_vec | 12 行 = 7 note + 5 block（index 4 条后全部可召回元素都有向量） | ✅ 索引覆盖 |
| recall | **0 次调用**（recall_count 全 0） | 见 §6.3（场景无触发） |
| eager-recall | **20 次 / 9846 字符**；4 条 distinct note 反复注入（7–11 次/条）；睡眠完成后 0 次（consolidated 过滤生效） | ✅ 通路工作，⚠ 重复/截断见 §6.3 |
| 醒来简报 | 睡了 3 分钟 / 积压 3 条（mc）/ 记忆整理完成 / "分片降级" / 1 条危险置顶 | ⚠ 文案问题见 §6.4 |

### 6.2 5 块内容质量（逐块）

| # | summary（≤37 字） | body | evidence | 评价 |
|---|---|---|---|---|
| 14 | 在树屋里反复调试门锁，最后发现 1x1 内部无法进入，改为在户外挖坑躲夜 | 160 | 8（含 3 条 "MC 身体：已连接"） | ✅ 有意义、第一人称、跨 8min |
| 15 | 因为饥饿和攻击机制 bug，差点饿死在野外，不得不放弃狩猎 | 205 | 10（含 2 条连接状态） | ✅ 有意义（死锁/饥饿体验） |
| 16 | 白桦林和橡树采集顺利，存了一大堆木板和原木 | 147 | 9（0 连接噪声） | ✅ 有意义 |
| 17 | 熔炉安置成功，工作台、箱子和熔炉凑在一起形成了小作坊 | 97 | 4 | ⚠ 与 #18 **重复** |
| 18 | 熔炉安置成功，凑成小作坊，但系统因同名冲突多次踢我下线，导致状态重置掉血 | 228 | 3 | ⚠ body **包含 #17 全文**（97 字子串）→ 同一经历写了两块 |

**判定**：5 块里 **4 块质量成立**（可读、有出处、带 from/to/tags），**1 对重复（#17/#18）**。
- 重复根因：events 在**同一 shard 内**对同一经历输出了两块（#17 evidence 559–564；#18 evidence 571/629/630），cleanup 的 1 合并/3 改写**没抓到这对**（summary 不同、body 包含关系）。
- **修法（第二轮，P1）**：cleanup 增加"正文包含/高相似"合并（规范化 body 后 substring 或 Jaccard ≥0.8），合并时保留 `mergedFrom` 与最全 evidence；或 events 输出后按 (day, body 相似) 去重。测试：fixture 两条 body 包含关系 → 合并成一块且 evidence 并集。
- evidence 去噪（P2）：#14 有 3/8 条是重复的"MC 身体：已连接"状态行（id 390/422/444）；建议 events 写块时对 evidence 里"重复状态行"只留最近 1 条（正文快照仍保留在 day log，不丢证据能力）。

### 6.3 recall 0 次：是"场景没有问过去"，不是工具/教学失败

- 180 条 `user/message` 中：真实用户指令 **14 条**（全是 MC 任务链/操作指令），其余是 runtime-context(62)/MC 事件(74)/time(17)/eager 注入(13 前 + 7 梦中)。
- 对 14 条真实指令 + 全部 user 消息做"过去指代"正则（上次/以前/之前/记得/那个事/回忆/曾经/昨天）：**命中 0 条**。
- `remember` 被实际调用 **7 次**（同插件工具已注册）；eager 注入 20 次说明记忆检索通路在跑；所以 recall=0 **不是工具缺失/教学没部署**（sim 教学已在 system 快照里），而是**本轮 E2 脚本没有"问过去/旧细节"场景**。
- 教学有效性本轮**不可判**：需要 E2 增加一个显式场景（例如"你还记得昨晚为什么死那么多次吗/上次搭的小屋在哪"），再记录 recall 调用；KPI 改成条件率（"过去指代消息中 recall 调用率"），否则任务驱动型长测永远是 0。
- 顺带：eager 注入的 4 条 note 有**每条约 7–11 次重复**（同会话未消化前反复注入），且单条在 80 字处**截断到半句**（如"…别在"）。建议（P2）：eager 对同一条记忆做会话内冷却/去重；截断按句读或加"…"。

### 6.4 `degraded:1` 归因：**分段被误标成降级**，不是预算也不是上游错误

- `dream-result meta.degraded=1` 来源是 **wash**：jobWash 返回 `degraded = omittedLines>0 || parts>1`；本轮 wash **parts=5、omittedLines=0** → degraded=true。
- events：`shards:3, failedShards:0, omittedShards:0, payloadChars:188876` → 没有失败/没有截断。
- 所以 `分片降级` 是**新分段机制的标签错误**：用户看到"降级"会以为丢数据/失败，实际是"这次原文分成了 5 段"。
- **修法（第二轮，P1，低风险）**：wash `degraded = omittedLines > 0`（真截断才算降级）；分段单独返回 `segmented: parts`；`emitDreamResult` 文案改为 `分 5 段`（不再叫降级）；E2 质量门把 `degraded` 与 `segmented` 分开统计。

### 6.5 醒来简报的两个小问题（time 侧，P2）

- **截断在半词**：`记忆整理：完成（wash 759 行 / … / cle）` —— time 对 result.text 做 `slice(0,60)`，把 "cleanup" 截成 "cle"；建议按标点/词边界截断或限 120 字。
- **"分片降级"混入简报**：见 §6.4，修 wash 语义后自然消失；另简报里报警样例出现 `掉血：20 → 17（血18/20…）`（合并/限流后的文本与采样不一致），属 time 的 alarm 合并展示问题，建议单独核对。

### 6.6 第二轮结论

| 结论 | 内容 |
|---|---|
| **达成** | 首次真实事件→记忆成块：5 块可读、有 evidence/from-to/tags；day 分段正确；block 尺寸合规；mem_vec 全覆盖；睡眠回执进简报；people 无对象时正确 skip；三态无缺行。 |
| **需小修（P1）** | ① wash 分段不得标 degraded（改文案/指标）；② cleanup 增加 near-duplicate block 合并（本轮 1 对重复）。 |
| **可选（P2）** | evidence 去噪（重复连接状态行）；eager 重复/截断；time 简报截断；recall KPI 场景化。 |
| **不需要** | 分块大小/分段上限/parts 机制本轮未被触发问题（body 97–228，无超长；day 5 段行号连续）；索引通路正常（4/4）。 |

