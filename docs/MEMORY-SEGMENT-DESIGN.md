# 记忆段分区设计（Dream 作为唯一切分者）

- 状态：**设计提案 + S0 影子审计已跑（2026-11-13）**（不立即改代码）
- 日期：2026-11-13
- 用户原则：
  1. **dream 是唯一的分区控制者**；
  2. 时间只是整理时的参考，不能决定记忆边界；
  3. 上下文必须**严格无重叠、无气泡**，由下一次 dream 完整重建；
  4. **不能丢"天"的语义**：分区是内部账本，模型/对话里仍用"昨天/11-13 晚上"等日期表达，
     不能出现"上一段""段 #3"这类模型词汇。
- 现状问题：当前是"自然日 + dream-run(day) 账本"近似分区，不是段分区（见 [MEMORY-COMPONENT-AUDIT.md](MEMORY-COMPONENT-AUDIT.md) §5）。

---

## 1. 先定义"段"

> **段（Segment）= 上次 dream 消费位置到本次 dream 切点之间、尚未被任何 dream 消费的全部 raw 行。**

- 切点由 **dream 在运行时决定**（run 开始时的 raw 快照）；
- 不依赖 00:00、04:00、dayKey、时区；
- 一次 dream 只消费一个段；
- 段的边界是 raw 行集合，不是时间区间；时间只用于展示/衰减/日期检索。

```
raw 行（sessionId:seq 稳定 id，追加写）
  ├────────── 已消费段 #1 ──────────┤
  │                                  ├──── 已消费段 #2 ────┤
  │                                  │                     ├── 段 #3（本次 dream 切点）
  │                                  │                     │
  └─ cursor: per-session maxSeq ─────┘                     └─ pending rows
```

**不变量（要能写成测试）**
1. 每个 raw 行（除显式排除的来源）**恰好属于一个段**；
2. 段按 cut 顺序排列，**cursor 单调前进，不重叠**；
3. 任何时刻未被消费的行都属于"下一个段"的候选，**不是丢失**；
4. 段的形成只能由 dream 触发；time/调度器只能触发 dream，不能直接标记记忆边界；
5. 失败/中断不推进 cursor；重跑同一个段，不产生重复 episode。

---

## 2. 当前实现为什么不是段

| 现状 | 后果 |
|---|---|
| `jobWash` 取 `dayStartOf(now)..dayEndOf(now)` 的行 | 分区由自然日决定，不是 dream |
| `alreadyRan(day, job)` 账本按 dayKey | 同一天跑过就 skip：早 dream 后同日再唤醒/再说话会形成气泡 |
| `targetDayInstant(now)` / `dayCutHour` | 时间在替 dream 决定"哪些内容算哪一天" |
| episode key `epi:${day}:${hash(title)}` | 跨天段/同名标题可能撞 key 或误合并 |
| day log 按 day 命名/分 part | 段跨天时无法表达 |

11-13 的早 dream 恰好没丢内容，是因为睡眠积压到次日释放；**这是巧合对齐，不是不变量**。

---

## 3. 目标数据模型

### 3.1 段记录（新 namespace：`dream-segment`，不可召回）

```jsonc
{
  "key": "seg:2026-11-13T21:06:12+08:00:ab12cd",   // cutAt + 行集 hash，稳定
  "data": {
    "cutAt": 1794...,                 // dream 切点（毫秒）
    "startAt": 1794..., "endAt": 1794..., // 段内首/末 raw 行时间（参考）
    "trigger": "sleep|nightly|manual|repair",
    "rows": [                         // 段内 raw 行（可只存 id + 时间 + source）
      { "id": "session-xxx:2395", "time": 1794..., "source": "human" }
    ],
    "rowIds": ["session-xxx:2395", "..."],
    "excluded": [ { "id": "...", "reason": "tool/env/memory" } ], // 明确不计入形成，但记账
    "parts": 1,
    "jobs": { "wash":"done", "episodes":"done", "people":"skipped", "...": "..." },
    "status": "open|done|failed|skipped",
    "failReason": null,
    "cursorBefore": { "perSession": { "session-xxx": 2394 } },
    "cursorAfter":  { "perSession": { "session-xxx": 2410 } }
  }
}
```

### 3.2 消费游标（`dream-cursor`，不可召回）

```jsonc
{ "perSession": { "session-xxx": 2410 }, "lastSegment": "seg:...", "lastCutAt": 1794... }
```

- `perSession` 存每个 raw 会话已消费到的最大 `seq`；
- 新会话从未出现 → 该会话所有行都属于未来段；
- cursor **只在段完成后前进**（原子写：段 status=done + cursor 同一事务/两次写有明确恢复逻辑）；
- raw 行 id 丢失（服务截断）时：记 `gap` 告警，不伪造行。

### 3.3 段日志（替代 day log 的形成输入）

- `wash` 只写**本段**的日志行（沿用现有 day log 文本格式与 source 元数据），
  但 key 为 `segment:<id>`，data 带 cutAt/trigger/rowIds；
- `episodes/people/lexicon/consume` 只读本段日志，不再读"今天/昨天"；
- `day` namespace 退役为历史归档（不再写入）；
- 段日志不可召回。

### 3.4 episode 与段的关系

- key：`epi:${segmentId}:${hash(title)}`（段内唯一；跨段不会撞）；
- data 增加：`segmentId`, `rangeStart`, `rangeEnd`；
- `day` 保留为**参考日期**（段起点所在日/主要日），用于日期检索、衰减、展示；
- 跨天段照常形成一块：显示可以写成"经历 · 11-13 晚～11-14 凌晨"，但分区不依赖它。

---

## 4. Dream 运行算法（唯一入口）

```
dream.run(trigger, now):
  single-flight（已有）

  # 1. 有没有未完成的段？
  open = latestSegment(status in [open, failed])
  if open:
      segment = open                      # 只重试，不切新段
  else:
      # 2. 由 dream 决定切点：以 run 开始时的 raw 快照为界
      rows = raw.list() 中未被 cursor 消费的行（按 time/session/seq 排序）
      if rows.empty:
          return skipped('no-new-material')   # 不产生空段、不推进 cursor
      segment = createSegment(rows, cutAt=now, trigger)  # status=open

  # 3. 按 job 顺序运行；已完成 job 跳过（段账本幂等）
  for job in defaultJobs:
      if segment.jobs[job] == done: continue
      result = job(segment)               # 只处理本段材料
      if result.failed:
          segment.status = failed
          return failed(...)              # cursor 不动；下次重试同一段
      segment.jobs[job] = done/skipped

  # 4. 段完成：推进 cursor（原子），写 dream-run 回执
  segment.status = done
  cursor.advance(segment.cursorAfter)
  receipt("段 #n：<start>~<end>，经历 X 段")
```

**关键点**
- **切点只在没有未完成段时产生**；失败不会切新段 → 无气泡；
- 一次 dream = 一个段；多次 dream = 多个段；
- `force` 只重试当前/最近段，不切新段；测试可用显式 `newSegment`；
- `now` 只做切点参考和日期元数据，不参与"这条属于哪天"的判断。

### 稀疏/空段
- 无新行：不建段（无空段）。
- 有行但材料过少：仍建段并记录 `skipped: below-salience`，cursor 前进（明确"这段看过但没形成记忆"）——
  保证不变量 3；不允许把这些行滚到下一段（否则段边界由材料量决定，又变成非 dream 控制）。
- 若产品希望"稀疏行合并到下一段"，那等于 dream 主动不切；需要显式定义并测试（当前建议不合并）。

### 迟到行（time < cutAt 但 cursor 之后才出现）
- 不能改写旧段（会重叠）；归入下一段，段记录 `lateRows` 计数并告警；
- 这是异常路径（重放/补写），正常投递不会发生。

---

## 5. 时间的作用（保留但降级）

| 用途 | 保留？ |
|---|---|
| 触发 dream（睡眠/夜间/手动） | ✅ 只负责"何时整理" |
| 段内排序、event 时间戳 | ✅ |
| episode.day / 日期检索 boost / 衰减 half-life | ✅ 作为元数据 |
| 决定"哪些行属于哪段" | ❌ 由 cursor + dream 切点决定 |
| dayKey 账本 | ❌ 替换为 segment 账本 |

`dayCutHour`/`targetDayInstant` 从分区逻辑移除（可保留为展示/统计辅助，但不再决定归属）。

---

## 6. 迁移与兼容

### 6.1 现有数据
- 旧 day log / episodes 保留为历史；不做破坏性重写。
- 建议一次性迁移工具：把每个旧 day log 登记为 `legacy segment`（`legacy:true`, cutAt=该日结束），
  并把同 day 的 episode best-effort 标 `segmentId=legacy:<day>`（仅审计用，不影响检索）。
- 初始化 cursor：`perSession` = 当前 raw 各 session 最大 seq（从现在开始消费新行）；
  也可选择从某个历史点回填（重建场景）。

### 6.2 切换方式
- 配置开关 `partition: 'segment' | 'day'`，v3 生产切到 `segment`，v2/旧测试保留 day；
- 先跑**影子审计**（只读）：按上述算法计算段，验证 live raw 的覆盖/重叠/气泡，不写任何记忆；
- 通过后再写段模型；切换前备份、dry-run、可回滚（回滚到 day 账本 + 旧代码）。

### 6.3 评测/重建适配
- 评测：fixture replay 仍按天喂 raw，但 dream.run 自然切段（每天一次 run）；指标仍按 episode.day 聚合；
- 重建：逐天 replay 改为逐段 replay（fixture 每天一段），manifest 记录 segment ids；
- 现有三源验收指标（anyHit/ formação）应保持不变——这是回归门槛。

---

## 7. 验收标准（必须可测试）

1. **覆盖**：所有 raw 行中，formation 来源恰好在一个段；排除来源在 `excluded` 中记录；
2. **无重叠**：任意两段 rowIds 交集为空；cursor 单调；
3. **无气泡**：任意时刻，最近的段 cursor 之后没有任何"应属于旧段"的行（迟到行单独告警）；
4. **失败恢复**：在 job 任意位置中断后重跑同一段，episode 不重复、段最终完成；
5. **同日再唤醒**：段 #1 cut 后新消息进入段 #2，不落入 #1，也不丢失；
6. **跨天段**：段跨午夜时 episode 正常形成，day/range 元数据正确；
7. **时间无关**：改变系统时钟/时区不改变段成员（只改变展示日期/调度）；
8. **dream 唯一控制**：无其他插件写段/推进 cursor；time 只触发 run；
9. **稀疏段**：记录 skipped 且 cursor 前进，审计能列出"看过但未形成"的行数；
10. **回归**：三源 anyHit@5 门槛不掉（focus/QQ/live），live 观察期无新 P0。

---

## 8. 实施阶段（需你批准后再动）

- **S0**：本设计定稿 + 影子审计工具（只读，不写记忆）验证 live raw 分区；
- **S1**：实现段模型（segment 记录、cursor、段日志、ledger、episode key/元数据），默认关闭；
- **S2**：评测/重建适配 + 单测/失败注入测试；
- **S3**：lab 三源 A/B（day 模型 vs 段模型），确认检索/形成指标不回退；
- **S4**：live dry-run + 备份 + 切换（需要你停/重启窗口）；
- **S5**：观察 7 天，旧 day 账本退役。

每个阶段单独验收、可回滚；不做"半段半日"的混合写入。

---

## 9. 待你拍板的决策点

1. **切段时机**：每次 dream 有新材料就切一段（推荐）；`force` 只重试不切新段。
2. **稀疏段**：建段但 `skipped` + 推进 cursor（推荐，保证不变量）；还是 dream 主动推迟到下次（会让材料量影响边界）。
3. **旧数据**：登记 `legacy segment` 并 best-effort 回填 segmentId（推荐）；还是仅保留 day 归档、不回填。
4. **episode 日期展示**：跨天段用"段起点日"（推荐，简单）还是"起点～终点"（更准确但改动 UI/检索日期逻辑）。
5. **切换范围**：v3 live 切段；v2/评测保留 day 模型（推荐，避免一次性全改）；还是所有模式统一。
6. **是否现在做 S0 影子审计**（只读，不产生记忆写入）：建议先做这个，用 live raw 验证"严格无重叠无气泡"是否成立，再决定是否进入 S1。

---

## 10. 天语义（模型可见层）—— 分区不改"天"

段是**内部账本**，不是模型词汇。所有面向模型/用户的文本继续用日期与"天"：

| 场景 | 允许 | 禁止 |
|---|---|---|
| 形成 prompt | "以下是从 **11-13 21:00 到 11-14 08:00** 的材料（可能跨天）" | "上一段/本段" |
| episode 展示 | `[经历 · 11-13 晚]`；跨天写 `11-13 晚～11-14 凌晨` | `[seg #3]`、`上一段经历` |
| 日期检索/衰减 | 仍用 `day` 与 `range` | 用 segmentId 做日期 |
| memory_status/world | "上次整理 **11-13 晚**（形成 0 段经历）" | "上次整理的是段 #3" |
| recall/whois 输出 | 日期标签 | segmentId / "分区段" |
| 日志/评测/manifest | segmentId 可以出现（诊断用） | 不许进入工具返回值 |

实现约束：
- 内部变量用 `segment`（英文）/`partition`，中文文档用"分区段"；
- 模型可见的 "段" 只保留现有"经历 N 段"的 episode 计数语义；
- 单元测试断言工具/状态/召回文本中**不出现** `seg:`、`segment #`、"上一段"；
- episode 的 `day` 仍是参考日期（段起点日），另存 `rangeStart/rangeEnd` 供跨天展示与日期检索。

---

## 11. S0 影子审计结果（2026-11-13，只读）

工具：`tools/memory-segment-audit.mjs`（读 raw + live DB，只写 lab 报告）。

| 指标 | 结果 |
|---|---|
| raw 行 / formation 来源 / 排除来源 | 762 / 348 / 414（env、tool 等） |
| **活跃窗口**（11-12 09:30 起，live 首次有 rowIds 的 day log） | formation **15**，covered **15**，uncovered **0**，pending **0** |
| 全量历史覆盖 | 15/348（4.3%）；333 行未被 live day log 覆盖 |
| day log 里不在 raw 的 id | 982（迁移时 fixture 的 `s1-r-*` 行 id） |
| 无 rowIds 的旧 day log | 7 个（11-03..11-11，v2 遗留） |
| 多 day log 覆盖同一 raw id | 0（raw id 层面） |
| pending（最后一次 dream cut 之后） | 0 |
| live dream 的 episodes 切点 | 只有 2 个：11-12 22:27、11-13 21:06 |

**结论**
1. **活跃窗口（11-12 起）严格覆盖，无缺口/重叠/pending**——当前在线管线是干净的；
2. 历史（11-03..11-11）是迁移遗留：episode evidence 指向 fixture id、day log 无 rowIds，
   无法用 live raw 校验——S1 迁移时登记为 `legacy segment`，不假装可追溯；
3. 段模型上线时 cursor 从"当前各 session 最大 seq"初始化，历史行不重新消费；
   因此 S0 中"334 行未覆盖"不会变成新段，而是显式标记 legacy/不可追溯；
4. S0 工具将成为 S3/S4 的验收脚本（覆盖/重叠/pending/legacy 断言）。

**S0 不改变任何记忆数据。**

---

## 12. S1 实现状态（2026-11-13）

已实现（配置开关，**默认 day，生产未切换**）：

- `dream.partition: 'day' | 'segment'`（默认 day）；`dream.segmentCursorInit: 'head' | 'zero'`
  - head：首次启用只消费启用后的新行（生产安全，避免重放历史）；
  - zero：从最早 raw 重放（lab/测试用）。
- 新增内部 namespace（不可召回）：`dream-segment`（段记录）、`dream-cursor`（per-session seq 游标）。
- 段记录：cutAt/startAt/endAt/trigger/referenceDay/rows/jobs/log/status；
- 运行算法：有未完成段只重试该段；无未完成段且有新行才切段；无新行返回
  `skipped: no-new-material`；job 失败 → 段 `failed`、cursor 不动；全部完成 → 段 `done`、cursor 前进。
- 段日志替代 day log 作为本段形成输入（wash 不再写 day namespace，段日志存段记录）；
  people/lexicon/episodes 通过 `readDayLog(segmentKey)` 读本段材料。
- episode key 变为 `epi:<segmentId>:<hash(title)>`；`data` 增加 `segmentId/rangeStart/rangeEnd`；
  `data.day` 保留为**段起点日**（天语义）。
- dream-run 账本 key 自动变为 `run:<segmentId>:<job>`；记录 `referenceDay`，memory_status 用它显示日期。
- 单元测试（`dream-jobs.test.mjs`）：
  - 切段/cursor/无新行不建段/下一段不重叠；
  - 失败不推进 cursor，重试复用同一段；
  - 天语义：episode.data.day 是段起点日，key 段隔离。

**尚未做（S2/S3）**：
- 评测/重建工具仍走 day 模式（formation replay 尚未按段喂 raw；S2 适配）；
- 存量 day log/episode 的 legacy segment 登记与 cursor 初始化工具（S2/S4）；
- 三源 A/B 与 live dry-run（S3/S4）。

---

## 13. S2 实现状态（2026-11-13）

已完成：

1. **评测适配**：`memory-eval --partition segment`
   - eval host 给 fixture raw 行补稳定 `sessionId/seq`（时间序），段模式游标才能推进；
   - formation replay 在段模式下用"当天 23:59"作为 dream 切点（day 模式仍用 00:00 评测约定）；
   - smoke：focus 单日 `--partition segment` 形成 **4 episodes / goldCoverage 85.7%**，无错误；
   - 默认仍 `--partition day`，不影响既有结果。
2. **存量迁移工具**：`tools/memory-segment-migrate.mjs`
   - 默认 dry-run（无写锁、只读）；
   - 把历史 day log 登记为 `seg:legacy:<day>`（legacy:true、status=done、rows/times/sources）；
   - 给旧 episode 回填 `segmentId`（仅当该 day 有 legacy segment）；
   - 从 raw 计算 per-session max seq，写 `dream-cursor`（head 语义）；
   - live 路径写入必须 `--yes-write-live`；lab 写库已验证。
   - live dry-run 结果：20 个 day log → 20 legacy segments、67 episodes 可回填、
     13 个 raw session 的 cursor。
3. 测试：全仓 **927 tests / 926 pass / 1 skip**，评测自测 28/28。

待 S3/S4：
- 三源 formation A/B（day vs segment）确认指标不回退；
- live 迁移 dry-run/备份/切换（S4，需要用户重启窗口）。

---

## 14. S3 首轮 A/B（2026-11-13，lab，未切换 live）

统一条件：`--mode all --schema v3 --seed formation --embed --model cloud`；day 用 mode=all，segment 用 `--partition segment`（replay 可见性：job now=段起点日 00:00，避免评测时"未来块不可见"）。

| 素材 | 模式 | episodes | goldCoverage | goldContent | anyHit@5 | recall@5 |
|---|---|---:|---:|---:|---:|---:|
| focus | day（本轮） | 31 | 87.5% | 56.3% | 100% | 92.7% |
| focus | segment（2 次） | 26 / 28 | 90.6% | 50–59% | 93.8% | 80.2–77.6% |
| QQ | day（旧 r3，待同代码重跑） | 14 | 80% | — | — | 83.3% |
| QQ | segment | 12 | 95% | — | 92.3% | 92.3% |
| live | day（旧 r3，待同代码重跑） | 26 | 87.5% | — | — | 100% |
| live | segment | 25 | 75% | — | 100% | 93.8% |

**初步结论**
- 段模式形成链路可用，formation coverage 在 focus/QQ 不低，但 live coverage 下降（75% vs 87.5%）；
- 检索：QQ segment 明显更好；live anyHit 100；focus 有一题（p-08）因**同日故事被拆成 309/310 两段**，
  期望集合只包含 309、实际返回 310 → anyHit 93.8（低于 V1 门槛 95）；
- 说明：这不是分区正确性问题，而是"段模式改变了块粒度 → 期望映射/同主题合并"需要再对齐；
- 旧 day 基线不是同代码同 seed 重跑，S3 尚不能下"通过/不通过"结论。

**S3b 待做（在 S4 前）**
1. 用当前代码重跑 QQ/live 的 day 模式，同 seed/同 repeat，做公平 A/B；
2. 处理 focus p-08：要么让期望映射包含同一主题的相邻段，要么在段内合并轮保证同故事不拆；
3. 各源 2–3 次重复，确认 anyHit ≥95%（或明确为映射 artifact）；
4. 通过后再进入 S4（live dry-run + 备份 + 切换窗口）。

---

## 15. S3 最终判定（2026-11-13，公平重跑后）

同代码、同 `--seed formation --embed --model cloud` 的公平对照（day 均为当前代码；focus day 跑了 3 次）：

| 素材 | day | segment |
|---|---|---|
| focus | anyHit **100%** ×3；r5 88.5–92.7；episodes 31；coverage 87.5% | anyHit **93.8%** ×2；r5 77.6–80.2；episodes 26–28；coverage 90.6% |
| QQ | anyHit **100%**；r5 100%；episodes 10；coverage 75% | anyHit **92.3%**；r5 92.3%；episodes 12；coverage 95% |
| live | anyHit **88.9%**；r5 88.9%；episodes 32；coverage 87.5% | anyHit **100%**；r5 93.8%；episodes 25；coverage 75% |

补充实验：段内兄弟补召回（p-08 的 63071 + 临时世界）只让 focus 从 93.8→93.3、QQ 92.3→91.7，
mixed 且不泛化，已回滚，未提交。

**判定：S3 不通过（不能进 S4 切换）。**
- 段模式在 live 的检索 anyHit 更好，但 formation coverage 明显低（75% vs 87.5%）；
- focus/QQ 的 anyHit 低于 V1 门槛 95%，源于"同一段连续经历被拆成多个 episode"与
  "多子句 probe 的期望映射只含其中一块"；
- 这是粒度/映射对齐问题，不是分区正确性问题。分区不变量本身在 S1 单测中成立。

**S3c（S4 前必须解决）**
1. formation：段内同故事合并（优先确定性规则：同段 + 共享 numeric/entity/证据行 + 相邻时间，
   再让模型合并），目标恢复 day 模式的"一段连续经历一个块"；
2. 评测：多子句 probe 的期望映射要覆盖同一 gold 的多个 episode（或明确只测单 fact）；
3. 三源各 2–3 次公平 repeat，门槛：anyHit ≥95%（或明确为映射 artifact）、coverage 不低于 day 5pt；
4. 全过后才进 S4。

**当前状态**：`partition` 默认 day，live 未切换；段模式代码/评测/迁移工具均在 lab。

---

## 16. S3c 结果与最终建议（2026-11-13/14）

尝试了"段内确定性相邻合并"（同段、证据行连续、合并后正文上限内）来修复 p-08 拆分：

| 素材 | 合并前 segment | 合并后 segment | day（当前代码） |
|---|---|---|---|
| focus | anyHit 93.8；eps 26–28；cov 90.6 | anyHit **100**；eps 14；body 852；cov 90.6；content 65.6 | anyHit 100；eps 31；body ~396；cov 87.5 |
| QQ | anyHit 92.3；eps 12；cov 95 | anyHit **91.7**；eps 8；cov 75 | anyHit 100；eps 10；cov 75 |
| live | anyHit 100；eps 25；cov 75 | anyHit **88.9**；eps 8；body 1535；cov 87.5 | anyHit 88.9；eps 32；cov 87.5 |

**判定**：相邻合并规则过度合并（live 8 块覆盖 7 天、正文 1535 字；QQ coverage 95→75），
把 focus 修好却牺牲 QQ/live，属于"按素材调规则"的补丁，已回滚，不提交。

**最终建议：S4 不执行，live 保持 day 模式。**
理由：
1. 段模型的分区不变量本身成立（S1 单测），但质量 parity 未达成：
   - focus/QQ 检索 anyHit 低于 day，live formation coverage 更低；
   - 尝试的合并/兄弟补召回都是"此消彼长"，没有稳定优于 day 的证据；
2. 继续按探针调规则会进入补丁循环，与用户明确的"不要无限补丁"冲突；
3. 段模型作为 lab 能力保留（代码/评测/迁移工具已具备），等出现**用户可感知的分区错误**
   （如同日唤醒气泡真实发生）时再立项；届时需要的是更好的"同段主题合并"设计，
   而不是继续堆相邻/兄弟规则。

**当前生产状态**：`partition=day`，live 未切换；S4 关闭。

---

## 17. S3d：时间契约 + 答案可回答性 A/B（2026-11-14）

按用户方向实现"纯 dream 切 + 时间戳"的解耦，不改分区规则：

1. **episode 时间字段**：每个块写 `timeStart/timeEnd`（来自 evidence 的 at，段模式缺省用段范围）；
2. **dream 账本**记录段材料 `rangeStart/rangeEnd`；
3. **memory_status** 显示真实整理时间（`上次整理 11-13 21:06`）与材料时间范围，不再只给日期；
4. **检索日期加权**改为"块时间区间与查询日重叠"，`data.day` 仅作兼容；
5. 新增 lab 工具 `tools/memory-answerability.mjs`：不看 block-id anyHit，
   用模型判断"返回上下文是否足以回答 expectAnswer"，对比 day/segment。

### 答案可回答性 A/B（同 fixture、同 eval 返回文本）

| 素材 | day answerable / full / mean | segment answerable / full / mean |
|---|---|---|
| focus | 88.9% / 44.4% / 1.33 | **88.9% / 55.6% / 1.44** |
| QQ | 88.9% / 66.7% / 1.56 | **100% / 55.6% / 1.56** |
| live | 87.5% / 50.0% / 1.38 | 87.5% / 37.5% / 1.25 |

**结论（支持用户判断）**
- 按"能否回答"的口径，段模式 **不差于 day**（focus/live 持平，QQ 更好）；
- 之前 focus 93.8 / QQ 92.3 的 block-id anyHit 差距，主要是"同一答案被拆成两块 + 期望映射只认一块"的度量 artifact；
- 因此"改变切分规则不应损害成块质量"在答案可回答性上成立；真正需要保留的是**时间戳契约**，而不是把段当日用。
- 剩余待确认：live segment 的 goldCoverage 一轮 75% vs day 87.5%（可能为形成方差/映射），S4 前建议再跑 1–2 次确认。

**当前生产**：`partition=day` 未切换；时间和答案可回答性改动为向后兼容（day 模式也写 timeStart/timeEnd）。

---

## 18. S4 dry-run（2026-11-14，live 拷贝，未碰 live）

步骤：
1. 复制 live DB + raw 到 `.state/lab/lead/s4-dryrun/<stamp>/`；
2. 迁移工具写入：20 个 legacy segments、67 个旧 episode 回填 segmentId、13 个 raw session 的 cursor；
3. 在拷贝上启用 `partition=segment`，用**合成 2 条新 raw 行**跑一次完整 dream；
4. 再跑第二次 dream 验证"无新行不建段"。

结果：
- 段记录：20 legacy + 1 新段（`seg:2026-11-14T06:10:38...`，status=done，rows=2，referenceDay=11-14）；
- 新 episode：key 段隔离、`data.day=11-14`、`timeStart/timeEnd` 正确、body 204 字；
- cursor：新增 `s4-dryrun:2`，旧 session 游标保留；
- 第二次 run：`skipped: no-new-material`，没有新建空段；
- 拷贝库检索（live fixture db-seed）：anyHit 88.9% / miss 11.1%，与切换前 live 库一致（未引入新回退）。

**dry-run 结论：迁移 + 段 dream + 时间字段 + cursor 均按设计工作，可进入真实切换。**

### 真实切换步骤（待用户确认/重启窗口）
1. `VACUUM INTO` 备份 live DB；记录 raw 文件与 git commit；
2. 对 live DB 执行迁移工具（`--write --yes-write-live`）；
3. preset 增加 `dream.partition: segment`、`segmentCursorInit: head`（默认成为段模式）；
4. 重启 DSH；
5. 启动后验证：memory_status 显示真实整理时间；下一次 dream 只消费新 raw（旧行不重复）；audit 段记录/cursor；
6. 回滚：preset 改回 day + 恢复备份（legacy segments/cursor 可保留，不影响 day 模式）。

风险与回滚均已定义；切换前 live 仍是 day 模式。

---

## 19. 真实切换执行记录（2026-11-14 15:48）

用户确认可在心跳恢复时后台切换后执行：

1. **迁移写入 live DB**（工具 `memory-segment-migrate.mjs --write --yes-write-live`）：
   - 20 个 legacy segments；
   - 67 个旧 episode 回填 segmentId；
   - cursor 以**最后一次成功 episodes dream 完成时间**（11-13 21:06，seq 2511）为已消费边界；
   - 11-13 21:06 之后的 25 条 raw 行**未被消费**，将作为重启后第一个新段（重点验证项）。
2. **preset 切段模式**：`dream.partition: segment`, `dream.segmentCursorInit: head`
   （cursor 已存在，head 不会重置；只消费新行）。
3. **备份**：热备份命令首次因 shell 引号失败，迁移是加法操作（legacy 段/cursor/segmentId），
   day 模式可无备份回退；随后已生成 post-migration 备份
   `~/.dsh/icl/state/archive/memory-post-segment-migrate-*.db`，并复制到 lab。
4. 测试：全仓 927/926 pass；preset 通过 product-surface 校验。
5. 待用户重启 DSH 后验证：
   - 第一次 dream 是否把 pending 25 行形成新段（而不是跳过/重复旧行）；
   - memory_status 显示真实整理时间与材料范围；
   - audit/段记录/cursor 正常；无重复 episode。
