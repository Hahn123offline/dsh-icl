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

## 3. 修法方案（先方案，不直接改）

### 3.1 P0：让 dream 真的能跑（R1+R2）

1. **lab 侧配置（1 行级）**：`tools/lab.mjs` 生成 `lab.patch.yml` 时，给 `icl-mc-lab`/`icl-lab` 的 core config 加 `providers:`（指向本次 lab 的模型端点；云端或本地），并把 `model-manager` 的 `pluginConfig` 透传。night-1 的主模型是 `ninfer/coder390`，但 ICL 后台模型可独立选（建议默认复用 lab 的模型端点）。
2. **启动自检（低风险）**：`dsh-icl` boot 后检查 `host.services.slots.unmatched()`；非空时 `ctx.log({level:'error', msg:'icl.slots-unmatched', unmatched})`，并写进 `icl.ready` 日志；质量报告读取它。
3. **失败落账（低风险，2 处）**：dream 每个 job 的失败也写一条 `dream-run`（`ok:false` + `error`）或单独的 `dream-run-fail` 记录；`jobIndex` 增加 `skipped:'no-embed'`；`dream-result` 回执（已实现）会把失败带进醒来简报。
4. **验收**：修后一次 lab 睡眠周期，`dream-run` 应有 wash/events/people/lexicon/consume/cleanup/index 全部条目（或 `skipped` 原因），events `blocks > 0`。

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

## 4. E2 可判定判据（建议写进质量门）

| 判据 | 阈值 | 数据源 |
|---|---|---|
| 事件→记忆覆盖率 | 每个有效会话日 `event blocks ≥ 1`；周覆盖 ≥ 5/7 天 | `memory.db` + `dream-run` |
| 可回忆块大小 p95 | ≤ 1200 字符（p99 ≤ 4000；超长必须 parts 拆分） | `memory.db`（只 event/person/slang block） |
| 原料单条大小 | `day` 段 ≤ 40k 字符；总 items ≤ 200k/天 | memory.db |
| dream job 健康 | 每个 job 有 `ran` 或 `skipped` 记录；`failed` 必须有 error；**不允许"缺行"** | `dream-run` |
| 槽健康 | `slots.unmatched = []`（dream-chat/embed-text 必须在 lab 里绑定） | ICL 日志/质量快照 |
| recall 使用率 | 每 20 轮 ≥1 次 recall（有问过去类消息时 ≥50%） | `tool/call` 事件 |
| recall 空结果率 | ≤ 30%（连续空 ≥3 次要告警） | recall 结果文本 |
| index 覆盖 | 有 embed 时 `vec/recallableItems = 100%`；无 embed 时明确标注"未配置" | memory.db |
| eager 注入可观测 | 每次评估有 hits/injected 计数 | eager-recall 日志 |

## 5. 建议执行顺序（等拍板）

1. **立即（低风险，可先做）**：dream job 失败落 `dream-run` + `jobIndex` 的 `no-embed` 区分 + `slots.unmatched` 启动日志（约 30 行，不改语义）；
2. **lab 配置**：lab patch 注入 providers（夜间长测前必须，否则 dream 永远不会成块）；
3. **E2 指标口径**：原料/块分离 + dream job 三态 + 槽健康（mc-lab 质量工具侧）；
4. **分块策略**：day log 分段 + block 上限/parts（记忆模块改动，需回归 dream/recall/cleanup）；
5. **recall 教学**：sim 2–3 条触发场景 + 指标观测（低成本，可与 4 并行）。

> 蓝队补充：本轮已落地的 `dream-result` 回执（`60d8abe`）会把 dream 失败带进醒来简报——只要 lab 绑定 providers 前，她至少会看到"记忆整理：失败（…）"，不会再以为整理成功。
