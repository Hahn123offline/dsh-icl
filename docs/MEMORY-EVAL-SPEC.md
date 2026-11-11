# 记忆评测规格（Phase 1 交付契约）

> 状态：2026-11-11 定稿。实现者：memory-eval-harness（工具）与 memory-corpus-builder（素材）。
> 依赖决策见 `docs/MEMORY-DIAGNOSIS.md`。本文定义 **fixture 格式、三源素材、runner 行为、指标口径、CLI 契约、验收**。
> 改动本文需 Lead 同意；实现与本文冲突时以本文为准，并回报差异。

## 1. 目标

让"记忆形成质量"和"召回质量"变成**可复现、可对比、可 gate 的数字**，覆盖三种用法：

1. **真实回归**：用旧产品真实对话重建的 fixture，测当前/新实现是否退步。
2. **构造式金标**：合成中文 persona 场景，事实/事件/承诺/别名/矛盾由构造时已知 → 精确 P/R。
3. **A/B 与反事实**：同 fixture 跑不同 profile（raw-all / raw-main）、不同形成参数、不同注入策略，比较净收益。

不追求跑公开基准的绝对分数；公开中文基准（PerLTQA 等）只在 Phase 2 后做检索模块对照，且数据不进仓库。

## 2. 目录与文件约定

```
tools/memory-eval.mjs              # 评测 runner（实现者：eval-harness）
tools/memory-eval/                 # 可选拆分模块（fixture loader / matchers / metrics / reporters）
tools/memory-eval.test.mjs         # 离线自测（echo model，不联网）
tools/memory-corpus.mjs            # 三源导入 + 合成场景生成（实现者：corpus-builder）
tools/fixtures/memory/             # 合成场景（可提交）与 schema
  schemas/fixture.schema.json
  synthetic-<name>/fixture.json
.state/lab/memory-corpus/<id>/     # 真实回归 fixture（**不提交**，含真实聊天）
  fixture.json
  build.json                       # 来源、行数、过滤规则、生成时间
  raw/<day>.jsonl                  # 可选：原始行副本
```

真实聊天数据一律放 `.state/lab/`，不提交 git；提交的合成 fixture 不含真实 QQ 号/人名（用占位身份）。

## 3. Fixture 格式（`fixture.json`，schema=1）

```jsonc
{
  "schema": 1,
  "id": "real-focuscore-2026-10",
  "kind": "real",                         // real | synthetic
  "description": "旧 focus-core 真实对话，2026-10-27..10-31",
  "timezone": "Asia/Hong_Kong",
  "persona": {
    "self":  { "name": "鱼鱼",   "ids": [{ "kind": "qq", "value": "2593621742" }] },
    "owner": { "name": "主人",   "ids": [{ "kind": "qq", "value": "3429502459" }],
               "aliases": ["Hahn123", "周子涵", "离线版"] }
  },
  "days": [
    {
      "day": "2026-10-27",
      "rows": [
        {
          "id": "r-0001",                          // 全 fixture 唯一，稳定，不随生成顺序变
          "at": "2026-10-27T17:45:50+08:00",       // ISO，带时区
          "role": "user",                          // user | assistant | tool | env | memory
          "channel": "web",                        // web | qq:private:<qq> | qq:group:<gid>
          "speaker": { "kind": "owner", "value": "3429502459" }, // owner|self|person|system|unknown
          "text": "鱼鱼，看看你能不能进到 b 站看个视频",
          "source": "human",                       // human | agent_visible | agent_internal | tool | env | memory
          "visible": true                          // assistant 是否真的发出去了；非 assistant 恒 true
        }
      ]
    }
  ],
  "gold": {
    "entities": [
      { "id": "person:3429502459", "kind": "person", "name": "主人",
        "aliases": ["Hahn123", "周子涵", "离线版"],
        "ids": [{ "kind": "qq", "value": "3429502459" }],
        "importance": 5 }
    ],
    "memories": [
      { "id": "m-0001", "type": "fact",          // fact|preference|event|commitment|relationship|concept
        "subject": "person:3429502459",          // entity id | self | group:<gid> | topic:<slug>
        "text": "主人负责维护 dsh-icl，常熬夜调插件",
        "importance": 4,
        "evidence": ["r-0001", "r-0007"],         // 必须能解析到 rows
        "validFrom": "2026-10-27", "invalidatedBy": null,
        "note": "人工/构造 gold" }
    ],
    "noise": [
      { "rowIds": ["r-0002"], "reason": "env|tool-output|agent-plan|jargon|one-off-visual",
        "note": "不应形成可回忆记忆的行" }
    ]
  },
  "probes": [
    { "id": "p-01",
      "rowId": "r-0120",                          // 在这一行（用户消息）发生后施加探针
      "query": "主人最近在折腾什么插件？",
      "kind": "recall",                            // recall | eager | person | overview
      "expectedMemoryIds": ["m-0001"],
      "expectedAny": [],                           // 可选：多个 gold 任一命中即算
      "expectAnswer": "B 站插件 / ICL",            // 可选，给 end2end judge 用
      "mustNotRecall": ["m-9999"],                 // 可选：错误命中扣分
      "note": "" }
  ]
}
```

规则：
- `row.id` 稳定；导入器不能用数据库自增 id 直接做 row.id（无法复现时用 `d<day>-<seq>`）。
- `gold.memories[].evidence` 为空只允许出现在 `kind:"synthetic"` 且 `note:"negative"` 的条目不成立时——真实 gold 必须有证据行。
- `gold` 为空数组时允许，但报告必须写 `goldEmpty:true`，不参与 P/R。
- 身份类 gold 必须给 `entities`；person 块匹配按 ids/aliases，不按文本相似。

## 4. 三源素材（corpus-builder）

### 4.1 `real-focuscore-2026-10`（首选真实回归）
来源（只读，复制到 lab）：`C:/DSH/qwenstuff/focus-core/state/focus.db`
- `messages`（642 行，role user/assistant）：`user` 行 → `source=human`；过滤 runtime-context 注入行（文本以
  `Current runtime context.` / `The following skills are available` / `<…>` 开头的系统快照）作为 `env`，**保留但不进 gold**。
  `assistant` 行：无法可靠区分"发出/内部"，保守标 `agent_visible=true` 但 `source=agent_visible`；
  若文本是英文计划式（heuristic：无 CJK 且含 think/let me/I should 等）标 `agent_internal` 并计入 noise 候选。
- `qq_messages`（118 行）：按 `activity` 映射 `qq:private:<qq>` / `qq:group:<gid>`；`sender` 是 QQ 号或昵称，
  用 `people` 表（18 行，含 `level:owner` / `qq:2593621742 = self`）解析 speaker.kind；时间并入对应天。
- 参考 gold（非真值，供草拟）：`memories` 16 条（kind=summary/person）+ `people` + `people_alias`。
  用 LLM 把"消息行"草拟成 `gold.memories`，证据必须是真实 row id；标 `goldSource:"draft"`，Lead 抽审。
- 已知 owner=QQ 3429502459、self=QQ 2593621742（与旧 `principals` 一致）。

### 4.2 `real-qq-2026-10`
来源：`C:/DSH/qwenstuff/dsh-qq/state/memory.db` `messages`（170 行，10-22..10-26；`is_self`、`sender`、`conv_key`、`text`）。
映射同上；`summaries`/`persons` 只作参考不直接当 gold。

### 4.3 `real-live-2026-11`
来源：`.state/lab/memory-fixture/latest/raw/*.jsonl`（8 天，708 行）+ `current.json`。
行分类用**确定性规则**（见 §5 的 profile）：`user` 直聊→human；`[QQ私聊·…]`/`QQ 还有没看过的消息`→human（QQ 信封，尽量解出 sender）；
`【心跳】`/`[QQ戳一戳]`/`Alarm fired`/time_status JSON→env；assistant→agent_visible（英文计划→agent_internal）；
tool→tool。gold：只标稀疏少量（11-10/11-11 各 ~10 条），由 LLM 草拟 + Lead 抽审；不追求高精度，定位为"回归哨兵"。

### 4.4 `synthetic-*`（构造式金标，提交仓库）
生成器（本地 27b 或云端，**建议与抽取模型不同**以便外推）：读场景 spec JSON →
- spec 含：`persona`（self/owner/其他人）、`facts`（主体/属性/值/生效日/是否被纠正）、`events`（天/参与者/摘要/证据台词）、
  `commitments`、`aliases`（谁叫什么）、`contradictions`（旧值→新值）、`noise`（工具输出/环境通知/她自己的计划/一次性视觉描述）。
- 逐天生成 8–15 天、每天 10–40 条消息，中英混排、群聊/私聊混合；每条消息输出后做**证据校验**：gold 的台词必须逐字出现在生成的 row.text 里。
- probes：在第 N 天某条用户消息后设置 8–15 个探针（直接问/间接问/跨天追问/别名/矛盾后问新值）；`expectedMemoryIds` 指向构造的 gold id。
- 至少 3 个场景：`alias-and-people`、`preference-change`、`commitment-followup`（可各 2 个 seed）。
- 校验：`fixture.schema.json` + 引用完整性（entity/subject/evidence/rowId 全部存在）+ gold 非空。

## 5. 记忆素材 profile（eval 与产品共用）

`--profile` 定义哪些 raw 行进入形成主材料（wash/events/people/lexicon 的 LLM 输入）：

| profile | 主材料 | 仅作证据上下文 | 用途 |
|---|---|---|---|
| `raw-all` | 全部行（现状） | — | 旧基线对照 |
| `raw-main`（推荐默认） | `source=human` 的文本 + `agent_visible` 文本（折叠为短上下文） | tool/env/agent_internal | 产品目标口径 |
| `raw-human` | 只 `source=human`（含 QQ 信封解出的真人话） | 其余全部 | 纯净度对照/消融 |

产品的 wash 需在 day log 行上带 `source` 标记与 `rowId`（见产品改动），评测 profile 直接复用同一分类函数，**禁止两套实现**。

## 6. Runner 行为

### 6.1 公共
- 输入 fixture → 临时 stateDir（`os.tmpdir()/icl-memory-eval-*`），**绝不写 live**。
- 模型适配：`--model cloud|local|echo`。
  - `cloud`：`config/icl.local.json` 第一个 chat provider（deepseek-chat），按 prompt hash 缓存到 `<out>/cache.json`；
  - `local`：同文件里 `llama-swap-chat`（qwen35-9b）或 `--model-id`；质量对照用；
  - `echo`：离线 stub，按 payload 哈希返回预置 JSON（用于 CI 与自测，不联网）。
- 每次运行记录：calls、cacheHits、wallMs、tokens（能拿到就记）、profile、seed。

### 6.2 `formation`
逐天按顺序：注册/启用 memory、note、lexicon、dream（必要时 eager-recall）→ `dream.run({ now: 当天 12:00, jobs: [wash,events,people,lexicon,consume,cleanup,index] })` →
最后 `memory.exportAll()`。然后：
1. 把每个落库的 event/person block 的 evidence 映射回 fixture `rowId`（依赖 wash 写入的 `rowId` 映射；若拿不到则用 `data.day`+`line` 文本在当天 rows 里做唯一子串匹配，匹配不到记 `unresolved`）。
2. 与 gold 做确定性匹配（不调 LLM，默认）：
   - event/fact/commitment：证据行重叠 ≥1 且（规范化文本 bigram Jaccard ≥0.3 或 同 subject/同天）；或 gold 的 evidence 被某条 extracted 覆盖。
   - person：ids/aliases 与 gold entity 交集；文本相似只作 tie-break。
   - 一条 extracted 最多匹配一条 gold；贪心按证据重合度降序。
3. 输出 §7 指标；`--repeat 2` 时用同一 fixture 重跑（清临时库）比较两次产出，算 idempotency 指标。

### 6.3 `retrieval`
先用 `--seed gold`（默认；直接把 gold.memories 写成 event/person block，evidence=rowId）或 `--seed formation`（先跑形成）建库。然后对每个 probe：以 `rowId` 所在时刻为 `now`，执行对应插件路径：
- `kind=recall`：调用真实 `recall` 工具 `execute({query})`（覆盖 cursor 重置）；
- `kind=eager`：走真实 eager-recall 的 `onTurn` 逻辑（若不能直接触发，则在 runner 内用与插件**同参**的 `memory.search` 并在报告中注明"模拟路径"）；
- `kind=person`：`whois`/`recall kind=person` 路径；
- `kind=overview`：无 query 的最近视图。
记录 top-k id、是否命中 expected、期望未命中的错误注入。指标见 §7。

### 6.4 输出
`<out>/eval.json`（完整结构化：fixture、profile、指标、每条样本的 extracted/gold 匹配明细、失败样本）
`<out>/eval.md`（人读：一张指标总表 + Top 失败样本 + 成本）。退出码：0 正常；2 fixture/配置错误；3 指标低于 `--gate` 阈值（可选）。

## 7. 指标口径

### 7.1 formation（按类型分组：fact/preference/event/commitment/person/relationship）
- `extracted`：落库的 event block（非 superseded）+ person block + （可选）lexicon term；note 单列为 `aux`。
- `matched`：按 §6.2 匹配上的 extracted 数。
- **precision = matched / extracted**；**recall = matched / |gold|**；F1。
- `dupRate`：extracted 中与另一条 extracted 近重复（同类型、规范化文本 Jaccard ≥0.6 或证据集合 Jaccard ≥0.8）的比例。
- `noiseRate`：extracted 的证据全部落在 `gold.noise` 行、或 evidence 为空的比例。
- `selfSourceRate`：extracted 证据全部来自 `source in {agent_visible, agent_internal, tool, env}` 的比例。
- `provenanceRate`：extracted 至少 1 条 evidence 成功解析到 fixture row 的比例。
- `identity`：person block 匹配到 gold entity 的比例；**wrongIdRate**：person ids 含 gold 未声明的 id、或含 selfId 错挂到他人、或把群号当 QQ 的比例。
- `idempotency`（`--repeat 2`）：两次 extracted 集合的证据集合差、重复对增量。
- `selfSourceRate ≤ 0.15`、`dupRate` 越低越好、`provenanceRate ≥ 0.95` 是 Phase 1 目标（首次基线只报数，不 gate）。

### 7.2 retrieval
- `recall@k`（k=1/3/5）、`MRR`、`NDCG@10`：以 probe 的 expectedMemoryIds 为相关集，排序取插件返回顺序。
- `injectionPrecision`：returned 中命中 expected 的比例；`missRate`：有 expected 但 top-k 全空/全错的比例；
  `falseInjectionRate`：`expectedMemoryIds` 为空的 probe 仍返回记忆的比例。
- 成本：每次检索 injected tokens/chars、延迟 p50/p95。

### 7.3 报告必须带的对照
- 同一 fixture 的 `--profile raw-all` vs `raw-main`；
- 改动前 commit vs 改动后 HEAD 的 delta 表（脚本支持 `--label`，输出带 label 的 eval.json，由 Lead 汇总）。

## 8. 离线自测（不联网、进 CI 候选）

`node --test tools/memory-eval.test.mjs` 必须覆盖：
1. fixture schema 校验（缺字段/引用断裂/evidence 指向不存在 row 要报错）；
2. metrics 纯函数单元测试（给定 extracted/gold 手算 P/R/dup/identity）；
3. echo model 跑一个 3 天 tiny synthetic fixture 的 formation smoke（断言产出事件块、报告文件生成、退出码 0）；
4. `--profile` 行选择逻辑（raw-main 不把 tool/env 当主材料）；
5. 不写 live：运行前后 live 路径 mtime/immutable 断言（只读检查即可）。

## 9. 验收（Phase 1 完成定义）

- `node tools/memory-eval.mjs --fixture tools/fixtures/memory/synthetic-alias-and-people --mode all --model echo` 可离线跑通并出 eval.md/json。
- `node tools/memory-corpus.mjs import-focus-core --out .state/lab/memory-corpus/real-focuscore-2026-10` 产出通过 schema 的 fixture；
  同样支持 old-qq / live / synthetic。
- 真实 fixture 上一个 `--model cloud` 的 formation 跑完（缓存可复用），产出第一份基线指标。
- 评审通过的标准：指标口径可实现、可复现、失败样本可定位到具体 fixture 行/gold。

## 10. 纪律

- 不碰 live state、不重启 DSH Desktop、不复制第三方代码/prompt/数据。
- 真实聊天的 fixture 只放 `.state/lab/`；提交物用占位身份。
- 所有 LLM 调用走可缓存适配器，`cache.json` 不含密钥。
- 工具代码不注册到产品工具面（只读审计工具，同 `tools/memory-audit.mjs` 定位）。
