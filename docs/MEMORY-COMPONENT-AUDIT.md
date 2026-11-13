# 记忆组件审计（端到端契约 / 生产 / 查询 / 污染）

- 日期：2026-11-13（观察期第 1 天）
- 目的：在做"收缩 vs 增强"决定前，逐组件搞清：
  **谁生产 → 存成什么 → 谁查询 → 怎样进入主会话 → 当前是否成熟、是否在污染。**
- 方法：代码走读 + live DB 只读统计 + raw/day-log 对比 + 现有审计/评测数据。
- 结论先行：**不是"分类太多"这么简单；是同一份记忆存在三套词表（存储/工具/自知），且至少有两条读取路径仍按 v2 读数据。**
  在契约统一之前收缩或增强都会继续长补丁。

---

## 1. 端到端数据流

```
raw 行（session-events.jsonl / QQ 送达）
  │  inferRawSource: human / qq_envelope / agent_visible / agent_internal / tool / env / memory
  ▼
wash（dream job）
  │  产 day log：namespace=day kind=log
  │  data: day, part(s), lines, rowIds[], times[], sources[], speakers[], channels[]
  ▼
形成（nightly / 睡眠触发）
  ├─ episodes   → episode/block：body, evidence[], day, people[], tags[], annotations{facts,preferences,commitments}, relations[], sources[], entities[], parts, days, mergedAcrossDays
  ├─ people     → person/block（档案）；person/note 由 note 插件产生、people job 消费后标 consolidated
  ├─ lexicon    → lexicon/term（词汇/梗采集）
  ├─ consume    → 把 note（done）写回目标 namespace
  ├─ cleanup    → 合并/改写 episode/person/slang，标 superseded；身份归并
  ├─ index      → mem_vec 向量
  └─ 确定性同步 → entity/entity、relation/relation、episode-seg/segment
  ▼
memory.db（SQLite：mem_ns / mem_items / mem_vec）
  ▼
读取面
  ├─ recall 工具（主动）：episode/person/lexicon/slang + 未整理 note；schema=v3 隐藏旧 namespace
  ├─ eager-recall（被动）：memory.search 全库→按 schema 过滤→top2/200 字注入
  ├─ whois 工具：person/entity/relation +（仍读）event/typed(v2)
  ├─ memory_status / world 状态行：episode/dream-run/person/lexicon/note
  └─ memory_export：全量导出
  ▼
主会话 prompt
  persona 段（persona 插件，不是记忆内容）
  world 段（含「记忆：…」一行）
  eager 注入（命中才注入，≤2 条/200 字）
  recall/whois 仅在模型调用时进入上下文
```

---

## 2. 组件清单与成熟度

| 组件 | 生产 | 存储 shape | 查询消费者 | 主会话暴露 | 成熟度/污染 |
|---|---|---|---|---|---|
| **raw** | bridge / QQ / 工具事件 | jsonl 行（role/time/text/sourceKind） | wash、recall raw 补细节 | 间接（经 day log） | ✅ 稳定；source 分类有规则 |
| **day log** | wash | day/log，text 行 + rowIds/times/sources | episodes/people/lexicon/评测 | 否 | 🟡 当前 11-12/13 完整；**11-03..11-11 旧 day log 的 rowIds=0**（v2 遗留），10-30 两个 part 共享同一 350 个 rowIds（重复记账） |
| **episode** | episodes job + cleanup/跨天合并 | episode/block（字段见上） | recall、eager、memory_status、world、评测 | recall/eager 结果 | ✅ 主单位成熟；🟡 生成含 agent_visible 运维自述（7/67 条含系统/工具语），🟡 evidence 对旧导入日是 fixture id（s1-r），对不上 live raw |
| **episode-seg** | syncEpisodeSegments | episode-seg/segment（parentKey/parentId/day/ordinal） | 仅 recall 内部评分 | 否 | ✅ 内部索引；🔴 `mem_ns.recallable=1` 但 recall/eager 都主动隐藏——任何**未经过滤的 memory.search 消费者**都可能读到它 |
| **person block** | people job + cleanup | person/block（profile/narrative/facts/ids/aliases/claims/evidence…） | recall（person 配额）、whois、memory_status | recall/whois | ✅ 档案可用；🟡 whois 的"最近事件/实体事实"仍读 legacy event/typed → v3 下为空 |
| **person note** | note 插件（remember kind=person） | person/note（subject/qq/consolidated/evidence） | recall 未整理笔记（仅未合并） | recall 结果 | ✅ live 24 条全部 consolidated=1，不参与检索 |
| **event（v2）** | 旧 events job | event/block（23 live + 10 superseded） | **whois** 仍直接读；recall 默认隐藏 | whois 可能展示旧事件 | 🔴 历史遗留 + 查询污染：whois 会拿旧 v2 事件当"最近事件" |
| **fact/preference/commitment（v2）** | 旧 events job | 无行（live 0） | whois 仍读；recall 显式 kind 曾直接搜（P0） | 无内容 | 🔴 空分类仍在工具 enum/自负状态里出现（本次 P0 根因之一） |
| **lexicon** | lexicon job | lexicon/term（term/usage/tags/status/pending/evidence） | recall、eager、memory_status | recall 结果 | 🟡 37 条中 18 条工具/框架味（mcb_servers、time_status、ICL、水位…）→ 生成污染，可能进召回 |
| **slang** | 旧 slang job（v3 默认不再跑） | slang/note（1 条） | recall（若未隐藏） | 潜在 | 🔴 近死分类：v3 由 lexicon 采集替代，namespace 未清理 |
| **entity** | syncEntities | entity/entity（stub 9/16） | whois、关系 | 否（间接） | ✅ 支撑用；🟡 一半是 stub |
| **relation** | syncEntities | relation/relation（18 条，悬空 0） | whois | whois | 🟡 有用但不在 recall CATEGORIES；`recallable=1` 属标记不一致 |
| **note 队列** | note 插件 / 自动查词 | note/note（status open/done/archived/resolved） | consume；无直接 recall | 否 | 🟡 22 条中 18 条是自动"查词"问题、全部 archived；是工具队列不是记忆内容，长期可能是过度设计 |
| **dream-run** | dream | dream-run/run（账本） | memory_status、排查 | 否 | ✅ 可靠账本 |
| **recall-cursor** | recall | recall-cursor/cursor | recall 游标 | 否 | ✅ |
| **persona / compaction** | persona / compaction 插件 | persona、compaction namespace | persona 注入 / 上下文折叠 | 是（persona 段、折叠摘要） | ✅ 但它们只是**共用 memory 数据库**，不是"记忆内容"；不要混入记忆审计结论 |

---

## 3. 契约不一致（按严重度）

### C1（P0，本次事故）typed 分类 ↔ episode 注释
- 工具 enum 有 `fact/preference/commitment`，后端 v3 里它们只是 `episode.annotations` 的字符串数组；
- 旧 namespace 无行 → `kind=commitment` 返回空；自知层却按注释计数并标「未结承诺 25」；
- 本次已加"kind→annotations"映射（**临时翻译层，不是契约修复**）。

### C2（P1，新发现）whois 仍按 v2 读
- `whois` 的"最近事件"读 `namespace=event`，"实体事实"读 `fact/preference/commitment`
  （[whois/src/index.mjs:52-75](../packages/plugins/whois/src/index.mjs)）；
- v3 下这些数据已归档/空 → whois 档案本身的 profile 还能用，但"最近发生的事/事实摘要"实际为空或旧数据。

### C3 能力标记与实际可查询性不一致
- live `mem_ns` 中 `event/fact/preference/commitment/episode-seg/relation` 都 `recallable=1`，
  但 recall/eager 通过内存里的 hidden 集合过滤，而不是按 `mem_ns` 标记；
- 任何新的直接 `memory.search` 消费者都会看到"可召回"的旧数据/内部片段。
- **单一事实源缺失**：工具 enum、eager 可见集、memory_status 计数三处各写一份词表。

### C4 "未结承诺"是没有生命周期的措辞
- live 25 条 commitment 注释全为历史字符串，无 status/due/id/完成更新；
- 其中已有兑现/过时（"主人说会充 Token"、"调好了会喊我一声"）；
- 把它们叫"未结"是过度承诺；由此产生的 25 会诱导 Agent 查询，而查询结果又为空。

### C5 旧分类的别名与死分类
- `kind=event` 实际查 episode（我已加映射），但仍以旧名称暴露；
- `slang` job 在 v3 默认不再运行，namespace 仍注册；
- `fact/preference/commitment` namespace 0 行，但工具 enum/文档仍列出。

### C6 分区语义不是"段"，而是"自然日 + 账本"
- 当前 dream 以 `dayKey` 为单位、以 `dream-run` 账本防重；**不是**用户期望的"两次 dream 之间为一个无重叠段"；
- 睡眠积压会在醒来时作为通知释放到**第二天** raw（今天 11-13 的 sleep 即如此），所以今天这例没有气泡；
- 但若她在同一自然日被唤醒并产生新消息，这些消息会落到已跑过的 day（账本 skip）→ 真实气泡风险存在，只是尚未发生。

### C7 历史导入的 provenance 断裂
- 11-03..11-11 的旧 day log `rowIds=0`；导入的 episode evidence 使用 fixture 行 id（`s1-r-*`），
  在 live raw 中不存在；
- 10-30 两个 day log part 共享同一批 350 个 rowIds（重复记账）；
- 结论：**"raw 行恰好属于一个 day log、episode evidence 可回溯到 raw"这个不变量在 live 只对 11-12 以后成立**。

---

## 4. 污染面盘点

### 4.1 生成污染（进记忆的内容）
| 来源 | 观察 | 影响 |
|---|---|---|
| `agent_visible` 包含她的运维/界面自述 | 67 个 episode 中 7 个含"清醒节拍/工具/环境/GUI"等运行语（例："这一轮只需要给 GUI 一个最短输出"） | 记忆混入过程噪音；与"共同经历"目标不符 |
| lexicon 采集 | 37 条里 18 条是工具/框架词（mcb_servers/time_status/ICL/水位…） | 召回时可能返回无意义词条 |
| annotations 无生命周期 | 193 facts / 13 prefs / 25 commitments，均无状态 | 无法回答"哪些还作数"，只能当历史记录 |
| 心灵/自我指涉 | 11-13 10:52 她写下"「未结承诺 25」这个数看着有点扎眼，哪天翻一下" | 这类元记忆自述可能在下一次 dream 进入 episode，形成自指污染 |
| 安静日 | 11-13 材料 328 字（全是 env/agent_visible 短句），episodes job 仍调了 1 次模型（输出 0） | 已有稀疏守卫，但"低价值自述日"仍存在浪费/风险 |

### 4.2 查询污染（读出来的东西）
- recall 默认路径：隐藏 legacy + seg + relation，干净；
- eager：隐藏 legacy + seg + relation，干净；
- **whois：仍读 legacy event/typed → 会展示旧 v2 事件或空事实**；
- memory_status/world：注释计数与工具能力不一致（C1/C4）；
- 直接 `memory.search` 的其他调用方：note/lexicon/persona/compaction 各查自己 namespace，不搜全库；目前没有第二个"全库搜索"消费者，但接口没有护栏。

### 4.3 主会话/人格污染
- 主会话只通过 world 状态行、eager 注入、recall/whois 结果接触记忆；没有整块记忆注入；
- 当前最脏的是 world 的「未结承诺 25」：它本身是错误信息，还会诱发模型去查、查空、留下"记忆是空的"错误结论；
- 她关于该数字的自述又回到 raw，存在二次污染路径。

---

## 5. 分区审计（回答"是否严格无重叠无气泡"）

live 实测（只读）：

| 检查 | 结果 |
|---|---|
| raw 行总数 | 762（其中 formation 来源 348） |
| 11-12 起 day log | rowIds 与 raw 行一一对应，覆盖完整 |
| 11-03..11-11 旧 day log | `rowIds=0`，无法与 raw 对齐（v2 迁移遗留） |
| day log 重复 | 10-30 两个 part 共享 350 个 rowIds（bookkeeping 重复） |
| 睡眠期消息 | 11-13 21:06 后 raw 无新行；睡眠积压按设计在醒来（次日）释放，故本次无气泡 |
| 早 dream 账本 | 11-13 21:06 episodes 已置位；若当天再醒来说话会形成气泡（当前未发生） |

**结论**：当前不是"段级严格分区"，而是"自然日 + 睡眠投递时间"碰巧对齐。
要做到你期望的不变量，需要把"两次 dream 之间"作为显式段（segment id / 未消费游标），
而不是用 dayKey 账本近似。

---

## 6. 组件裁决（审计后，而非拍脑袋）

| 裁决 | 组件 |
|---|---|
| **成熟，保留** | raw/source 分类、wash/day log（当前日）、episode 形成与检索、person block、entity/relation 支撑、eager、eval、rebuild/migration、dream-run |
| **必须修契约，不能靠补丁** | typed categories ↔ annotations；whois 的 v2 读取；memory_status/world 的自知口径；mem_ns recallable 标记与真实可见性统一 |
| **待观察后再决定是否收缩** | env/agent_visible 运维自述是否进入 episode；lexicon 工具词门槛；note 自动查词队列；slang 死分类；episode-seg/relation 的 recallable 标记 |
| **明确需新设计（非收缩）** | 段级分区（dream 之间无重叠无气泡）；承诺生命周期（若要"未结承诺"真实可用） |
| **历史遗留，暂不动** | event v2 blocks（whois 修好后再统一处理）；旧 day log 无 rowIds（历史 provenance 无法补，只能标注不可追溯） |

**重要**：以上"待观察/收缩"项，都先不删除。理由：
- 目前没有使用量数据证明它们无价值；
- 删除会改变已上线行为（用户明确不喜欢"降级"）；
- 先修契约，再让观察期数据决定去留，才是可辩护的收缩。

---

## 7. 建议的下一步（待你拍板，不在本轮改代码）

优先级按"污染面 × 修复成本"：

1. **统一能力表（契约修复）**：一个 `capabilities` 定义同时驱动 recall enum、eager 可见集、memory_status 计数、whois 可读集；废止三处各自维护的 hidden 集合。  
2. **whois 改读 v3**：最近事件改读 episode（按 people/entities），事实摘要改读 episode.annotations（临时只读，不引入生命周期）。  
3. **自知说真话**：world/memory_status 不再输出「未结承诺」；改为"经历 N 段；其中 M 段含承诺注释（历史，不单独可查）"或干脆只报可回答的事实。  
4. **段级分区设计**（独立议题）：dream 段 = 上次成功 dream 到本次 dream 的未消费 raw；解决"同日唤醒气泡"与"严格无重叠无气泡"。  
5. **清理候选**（观察期后）：slang 死分类、note 自动查词、lexicon 工具词、episode-seg recallable 标记——先量化使用/污染再动。  
6. **承诺生命周期**（可选新功能）：只有确认"承诺跟踪"是产品需求才立项，不在 V1。

> 本轮不改这些，是因为它们需要你确认契约方向；继续打补丁只会加深三套词表的漂移。
