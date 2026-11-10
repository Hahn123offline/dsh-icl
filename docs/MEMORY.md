# 记忆与做梦

> 读者：要改记忆逻辑、或排查"她记不住 / 记错"的开发者。/ 范围：`memory`、`recall`、`note`、`lexicon`、`whois`、`eager-recall`、`dream` 七个插件，加上它们共用的 `state/memory.db` 与原文层 `dsh-raw`。/ 最后核对：2026-11-03（对照 HEAD `d9b5f84`）。

命名空间、打分公式、阈值、做梦七步、词汇层语义只在这份文件里写一遍。`tools` / `prompt` / `slots` / `raw` 的服务契约见 [ARCHITECTURE.md#3-服务契约](ARCHITECTURE.md#3-服务契约)，此处不重复。

## 1. 三层记忆与各自的归属

三层不是三个库，是三条职责。

- **原文层（`dsh-raw`）**：把 DSH 会话日志投影成 `{text, time, role}`。只读、不改写、不总结。真源是磁盘上的 `.jsonl(.zstd)`。
- **结构化层（`memory`）**：`state/memory.db` 三张表，是模型上下文之外的**唯一可写真源**。所有"她记住的东西"最终都落这里。
- **装配层（`recall` + `eager-recall`）**：把库里的行渲染成文本塞进上下文。不拥有事实，只决定"这一轮给她看什么"。

| 层 | 存什么 | 真源 | 谁写 |
|---|---|---|---|
| 原文层 `dsh-raw` | 会话 user/assistant 正文，跳过注入的运行上下文行，压空白后单条 ≤600 字 | `<sessionsRoot>/**/*.jsonl(.zstd)`（默认 `%USERPROFILE%/.dsh/sessions`；30 天 / 400 文件 / 20000 条 / 缓存 300 s） | 外部 DSH；ICL 只读 |
| 结构化层 `memory` | `mem_ns`（命名空间）、`mem_items`（行）、`mem_vec`（向量） | `state/memory.db`，`node:sqlite` | 七个插件经 `memory` 原语写 |
| 装配层 `recall` + `eager-recall` | 无自有存储；唯一落盘是游标行 | 游标也写在结构化层（`recall-cursor`） | `recall` |

结构化层里同一件事有两个形态：碎片 `note` 和沉淀 `block`，所以下面这张对照表是四行。

| 同一件事（周子涵装好 PowerShell） | 长什么样 |
|---|---|
| 原文层 | `{ text: "我把 PowerShell 装上了", time: 1793…, role: "user" }`，一条会话行，没有说话人字段（§8-5） |
| 碎片 `note` | `event/note`，`text: "周子涵装上了 PowerShell"`，`data: { day, session, origin }` |
| 沉淀 `block` | `event/block`，`text` 是 ≤200 字摘要，`data: { body, evidence: [{type:"day",id:1}], from, to, tags, people }` |
| 装配层 | recall：`[事件 · 今天] 周子涵装好 PowerShell…`；eager-recall：`· [event] 周子涵装好 PowerShell…`（单条 ≤80 字） |

已注册命名空间（`registerNamespace` 幂等：已存在时**不更新** label / recallable / halfLifeDays）：

| id | label | recallable | halfLifeDays | 注册者 |
|---|---|---|---|---|
| `event` | 事件 | true | 30 | `recall` |
| `person` | 人物 | true | 180 | `recall` |
| `slang` | 梗 | true | 90 | `recall` |
| `resolve` | 纠正 | false | 1 | `recall` |
| `recall-cursor` | 回忆游标 | false | 30 | `recall` |
| `note` | 备忘 | false | 30 | `note` |
| `lexicon` | 语料 | true | 180 | `lexicon` |
| `persona` | 人格 | false | 30 | `persona` |
| `compaction` | 折叠摘要 | false | 30 | `compaction` |
| `dream-run` | 做梦记录 | false | 30 | `dream` |
| `day` | 当天原话 | false | 30 | `dream` |

`recallable: false` 只挡 `memory.search`（和 `missingVectors` 的向量补建），不挡 `memory.query`。所以 `note`、`day`、`dream-run` 这些"她自己不该回忆"的层只能被插件内部读到。

## 2. 写入：一次对话怎么变成记忆

只有四条写入路径，没有第五条（`note.add` 是 `memo` 的服务入口，同一条路）。

| 路径 | 触发 | namespace + kind | key | 幂等性 |
|---|---|---|---|---|
| `remember` | 主会话调工具 | `event`/`person`/`slang`/`resolve` 取其一 + `note` | 调用方给的 `key`；缺省 `note:<now>:<rand5>`（5 位 base36） | 有 `key` 走唯一索引 upsert；缺省 key 每次新增 |
| `memo` | 主会话调工具（`note.add`） | `note` + `note` | `null` | **不幂等**：同一句话写两次就是两条 |
| `lexicon_learn` | 主会话调工具（`lexicon.upsert`） | `lexicon` + `term` | `lexicon:<conv>:<term>`，`conv` 缺省 `web` | 幂等；同 `(conv,url)` 的 origin 合并而非追加 |
| 做梦写出 | `dream` 的 job | 五组：`day`+`log`、`event`/`person`/`slang`+`block`、`person`/`event`+`note`、`lexicon`+`term`、`dream-run`+`run` | 见 §5 | 靠 key + `run:<day>:<job>` 账本 |

写入口径（`memory.put` 的实际行为，`packages/plugins/memory/src/index.mjs:170-191`）：

- 唯一索引是 `ux_mem_key(namespace, key) WHERE key IS NOT NULL`：只有带 key 的写才是 upsert。`memo`、`consume` 回收的 note、`people` 从当天原话抽的 person note 都是 `key = null`，写几次就有几行。
- 更新分支不改 `created_at`，只改 `updated_at`。`query` 默认 `created_at ASC`，并支持 `order:'desc'` / `id` 精确查；recall/dream/note/lexicon/compaction 的"看最新"调用已改用 DESC。
- 更新时默认**保留**原权重（包括 boost 攒起来的）；只有 `reweight:true` 才覆盖。`remember` 仍以 `1.5` 新建，但重记不会把权重打回 1.5。
- `put` 或 `patch` 改 `text` 都会删掉旧 `mem_vec`，`remove` 也清向量；等 `index` 补。
- 写入不存在的命名空间直接抛 `命名空间没有注册：<ns>`；写空文本且无 `data` 抛 `memory.put 需要 text 或 data`。
- `remember` 写完立刻异步 `memory.index`，不等结果。

四种写入的数据形状：`remember` 的 `data` 是 `{ day, session, subject?, qq?, about?, origin? }`（`qq` 只在 `subject.kind === 'qq'` 时写）；`memo` 的是 `{ status: 'open', raisedBy, kind, about, createdAt }`，正文 `slice(0, 400)`；`lexicon` 的是 `{ term, origins, tags, usage, status, pending, usageState, decay, evidence }`；做梦的块见 §5。

## 3. 检索：混合打分、游标、原文兜底

`memory.search({ namespace, namespaces, query, limit = 8, includeArchive = false, now, minScore = null, tags = null, tagMode = 'any', conv = null })` 的实际算法（`memory/src/index.mjs:244-318`）：

```
sim   = 0.7 * cos(向量) + 0.3 * bigramOverlap(text, query)        // 有嵌入
sim   = min(1, sim + 0.5 * exact / terms.length)                  // 精确串命中
sim   = 命中二元组数 / 查询二元组数                                  // 无嵌入、有 query
sim   = 1                                                          // 无 query（纯按新鲜度/权重排）

ageDays = max(0, (now - anchor) / 86_400_000)   anchor = lastRecalledAt ?? createdAt
decay   = exp(-ageDays / max(1, halfLifeDays))
score   = sim * weight * decay
```

`memory.search()` 还会返回 `decay` 与 `clarity`（`tier/label`）。清晰度不是独立状态，而是从同一个 `decay` 推导的档位；详见 [CLARITY.md](CLARITY.md)。

| 项 | 值 | 备注 |
|---|---|---|
| 取行上限 | 5000 行（`config.scanLimit`） | `WHERE namespace IN (…) ORDER BY created_at DESC LIMIT ?`；多命名空间共享扫描窗口，拿的是**最新** 5000；5000 覆盖个人库数年，不再几个月就丢老记忆 |
| 返回条数 | `max(1, limit \|\| 8)` | 调用方按需传；recall 传 50 / 200，eager-recall 传 `max(4, maxItems*3)` |
| 半衰期 | `event` 30 / `person` 180 / `slang` 90 / `resolve` 1 / `lexicon` 180 / 其余 30 | 取行所属命名空间的 `half_life_days`，不在表里的按 30 |
| 精确串加成 | `+0.5 * exact / terms.length`，封顶 1 | `ICL_NO_LITERAL=1` 关闭；抽 Windows 路径、`txt/md/json/mjs/js/py/log/db/png/jpg` 文件名、带单位数字（元/块/次/天/秒/分钟/小时/%/GB/MB）、≥4 字符英文词 |
| 权重 | `boost` 每次 `+0.2`，封顶 `5` | 同时 `recall_count += 1`、`last_recalled_at = now`，衰减计时一起重置 |
| 软删 | `data.superseded === true` 的行不参与 | 行还在库里，可追溯 |
| 标签 | 只缩小范围，**不参与打分** | 两边 `toLowerCase()`；`tagMode: 'all'` 要全命中，默认 `any` |
| `conv` | 只留 `data.origin.conv === String(conv)` | `data` 为空的行直接丢（手工写的旧行会消失） |
| `minScore` | 默认 `null`（不过滤） | 只有 eager-recall 传 0.5 |

游标（`recall`，`recall/src/index.mjs:55-91`）：

- 语义：**"这一轮已经给过你的块"窗口**，按 token 累计。它不是分页偏移，是去重集合 + 预算。
- 结构：`data = { items: [{ id, tokens }] }`，`text = "<n> 块在窗口内"`，落在 `recall-cursor` 的 `cursor:<sessionId>` 行。
- 预算：`budgetTokens = max(500, config.budgetTokens || 10_000)`；`estimateTokens(text) = max(1, ceil(cjk / 1.5 + rest / 4))`。
- 限额：单条 `tokens + t > budgetTokens` 就跳过，但**第一条永远放行**（否则会返回空）。
- 滚动：本轮新增追加进窗口，然后 `while (总 token > 预算 && 条数 > 1) shift()`——从最早进窗口的块开始解锁，至少留一条。
- 传给模型的是 `base64url(JSON)`；解析失败退化成空窗口，等于把之前给过的全部再给一遍。
- 窗口里的 id 不重复给，也不从游标里删。

原文兜底（`recall/src/index.mjs:261-290`）：**触发条件是"有原文来源"，不是"主结果不够"**。

1. `ctx.services.raw?.ids?.().length` 非 0 就查 `raw.search({ query, limit: 2 })`，每次 `recall` 都查。
2. 命中后过两关：与已给内容的二元组重合度 `< 0.6`；归一化后前 40 字符不出现在主结果里。
3. 最多留 2 条，每条 `原文（M-DD）：前 160 字`；`M` 不补零、`DD` 补零。
4. 抛错被吞掉，不影响主结果；主结果为空但有原文时只回原文。
5. 测试里对 `出处：` 的负向断言恒真——代码里从来没有这个前缀。

`forget` 只能删四类：`namespace = CATEGORIES[kind] ? kind : 'event'`，按 `(namespace, key)` 删一行，回 `删掉了。` / `没有这条笔记。`。删不到 `lexicon` 词条、`note` 备忘、游标、`day` log、`dream-run` 账本；删行也不删 `mem_vec`。

`recall` 另有一条不走打分的路径：`overview: true` 且无 `query` 时，按时间窗（`days` 默认 2，夹 1..30）列出块与未整理 note，按 `createdAt` 倒序，不走向量排序。

## 4. 每轮召回（eager-recall）

无工具，只注册 `ctx.prompt.onTurn`。模型不知道"自己不清楚"，所以在每轮用户消息进来时由核心统一查一次。

| 配置 | 默认 | 实现细节 |
|---|---|---|
| `enabled` | `true` | 关掉用 `enabled: false`，一行生效 |
| `minScore` | `0.5` | 传 `memory.search` 过滤后**再**按 `score >= minScore` 过一遍 |
| `maxItems` | `2` | `max(1, …)`；检索条数取 `max(4, maxItems * 3)` |
| `maxChars` | `200` | `max(40, …)`；超了 `slice(0, maxChars - 1).trimEnd() + '…'` |
| 命名空间 | 全部可回忆的 | 不传 `namespace`：`event` / `person` / `slang` / `lexicon` 四个都会被扫到；`resolve` / `note` / `day` / `dream-run` 被 `recallable: false` 挡掉 |
| 过滤 | — | 丢掉 `kind === 'cursor'`，取前 `maxItems`；无命中返回 `null` |

注入格式（`eager-recall/src/index.mjs:29-35`）：

```
你可能记得（检索结果，仅供参考）：
· [event] 周子涵装好 PowerShell…
```

标签取 `item.kind === 'note' ? '未整理' : item.namespace`，`?? '记忆'` 这个兜底实际走不到（`memory.search` 的行里带 `namespace`），所以模型看到的是 `event` / `person` / `lexicon` 这种英文命名空间名。

**"仅供参考"的作用**：标明这些是检索结果而不是既成事实，模型可以引用也可以不引用；同时给出"这是旧记忆"的元信息，记错时能把责任归到检索而不是人格。

**为什么走 `prompt.onTurn` 而不是 `delivery`**：

- `onTurn` 的返回值只进本轮装配（`prompt.turnText`，默认预算 800 字），是一次性上下文。
- `delivery` 是"她主动往对话里发消息"的出口，带 `exactlyOnce`、水位、重试；语义是"说出去"。
- 检索结果不是她要说的话。说出去就等于把"参考"变成"断言"，还会留在对话历史里被下一轮重新检索到，自我强化。
- 插件头三条自我约束第一条就是"不推消息，只交提示词段"；`eager-recall.test.mjs` 也断言注入后 `delivery.drain('session')` 为空。
- 附带好处：核心对 `onTurn` 的每个 provider 都包 `try/catch`，检索失败不会挡住这一轮。

## 5. 做梦：七步流水线

`DEFAULT_JOBS = ['wash','events','people','lexicon','consume','cleanup','index']`。按数组串行，逐 job 包 `try/catch`，只有一个 job 返回 `ok: false` 整体就不算成功。`slang` 仍在 `JOBS` 表里但**不在默认序列**（已并入 `lexicon`），只能手动 `run({ jobs: ['slang'] })`。

触发三条：`ctx.signals.on({kind:'event', tags:['sleep']})` 收到 `sleep-start`；`time` 里 `dream:nightly` 的 silent 安排到点发 `schedule-start`（tags 含 `dream`）；enable 时没有单独的补跑（daily 安排到点由 tick 触发，晚启动最多错过当天）。三条之间**没有互斥**，手动 `dream.run` 与它们也不互斥；同一天靠各 job 的 `alreadyRan` 去重。`rhythm` 已不是默认插件，也不再被 dream 订阅。

| job | 读 | 写 | 幂等键 | 跳过条件 |
|---|---|---|---|---|
| `wash` | `raw.list({ since: 当天 0 点, until: 当天 24 点, limit: 2000 })` | `day`+`log`，key `day:<YYYY-MM-DD>`，text 是 `[i] HH:MM：正文` 逐行（读到 `sender` 时插在时间后，实际恒空），`data:{day,lines,times}` | `run:<day>:wash` | `already-ran` / `no-raw` / `nothing-clean` |
| `events` | `day`+`log`（`day:<day>`）；没有 log 时读 `event`+`note` 未消化（limit 500） | `event`+`block`，key `evt:<day>:<hash(summary)>`；`text` ≤200、`body` ≤4000、`evidence` ≤20（note 路径）、`from`/`to` 由 evidence 时间算出 | `run:<day>:events`；块 key 按 summary 哈希 | `already-ran` / `no-notes`（笔记与 log 都没有） |
| `people` | 先读 `day`+`log` 抽人（写 `person`+`note`，`key = null`）；再读 `person`+`note` 未消化 500、`person`+`block` 500、`event`+`block` 500（取末 20） | `person`+`block`，key `person:<value>`（QQ）或 `person:<kind>:<value>`；`text` ≤800、`profile` ≤2000、`narrative` ≤4000、`facts` ≤50、`aliases` ≤10、`ids` ≤10 | `run:<day>:people` | `already-ran` / `no-notes` |
| `lexicon` | `day`+`log`（没有就 `raw.list` 400）；`event`/`slang`+`note` 未消化各 200；`lexicon.query()` 500 | `lexicon`+`term` 走 `upsert`（`<message source_id>` 逐条喂模型）；老化 `patch`；缺释义写 `note` 待办 | `run:<day>:lexicon`；进程内 `seenTerms` 去重 | `already-ran` / `no-lexicon-plugin`（无材料时仍做老化并记账） |
| `consume` | `note`+`note` 200 条里 `status === 'done'` | 按 `about.namespace` 三支：`lexicon` 走 `upsert`；`person` / `event` 新建 `（备忘回收）<result>` 的 `note`；原 note 置 `archived` | `run:<day>:consume`；`status: archived` 后不再处理 | `already-ran` / `no-note-plugin` |
| `cleanup` | `resolve`+`note` 100 条未 `consumed`；`event`/`person`/`slang`+`block` 各 500（跳过 `superseded`） | `merged`：keep 块 `put`，drop 块 `superseded + supersededBy`；`rewrites`：`patch` text / body / evidence；`consumed`：resolve note 打 `consumed` | `run:<day>:cleanup` | `already-ran` / `nothing-to-do`（块 <2 且无待处理纠正） |
| `index` | `memory.missingVectors({ limit: 200 })`（只 `recallable = 1` 且 `text` 非空） | `mem_vec`（`memory.index(id, text)`） | `run:<day>:index` | `already-ran` / `nothing-missing` |

每步最容易出错的地方：

- `wash`：`no-raw` / `nothing-clean` 不写 `run` 行，所以同一天会重跑；但当天块已按旧 log 生成。
- `wash`：读的 `raw.list` 不返回 `sender` / `conv`，`r.sender` 恒空，day log 每行都没有说话人（§8-5）。
- `wash`：`day:<day>` 是 upsert，重洗直接覆盖旧 log——行号全变（§8-3）。
- `events`：有 day log 时把行号当 `evidence.id`，并且无差别把全部 event note 标 `consolidated`（不看有没有被引用）。
- `events`：模型给不出证据时**保留旧块**（`previous` 存在就 `continue`），代价是这轮的新正文也不落库。
- `events`：写完后用 `limit: 200` 回查刚写的块来找引用集；块超过 200 个就找不到自己（§8-4）。
- `people`：没有 evidence 且补问失败时块照写，这批笔记此后每晚都会重新进材料（§8-8）。
- `people`：`relatedEvents` 只按 `subject.value` 比 `event.data.people`，而后者存的是 QQ，非 QQ 身份永远匹配不到。
- `lexicon`：标签取决于模型给的 `reason`（缺失就落 `待查`）；每次 `upsert` 都把 `usageState` 算回 `active`。
- `consume`：只扫 200 条 note；`done` 超过 200 条后新条目轮不到，且没有 `about.namespace` 的 `done` 行既不写回也不归档。
- `cleanup`：三次 `patch` 都基于改写前的 `existing.data`，最后一次把 body 写回旧值（§8-2）。
- `cleanup`：只把最后 150 个块喂给模型，更大的库整理不到前面的块。
- `index`：没有嵌入服务时 `indexed: 0` 也记账，当天不再重试。

## 6. 词汇层（lexicon）：为什么它存在

核心问题是：**模型对一个词的默认释义不可信，而且它说得很自信**。所以词汇层不回答"这个词是什么意思"，只回答"**本群 / 本来源实际用的是哪一个意思**"。

真实的 `吃白饭` 案例：

- 字面义是"白吃白喝不干活"（或"白米饭"），模型的默认解释就停在这里。
- 2026 年网络语境下，它特指 AI 模型（主要 DeepSeek）光吃 token 算力不干活，模型自己也顺着自嘲"我是吃白饭的蓝色大肥鱼"。传统贬义已经变成拟人化的调侃。
- 正确读法只有两个来源：**本群有人明说**（"是最近那个梗啊，说 AI 光吃 token 不干活"），或**可核查来源**（`origin.url`）。模型的猜测不算来源。
- 所以 `lexicon_learn` 的 `meaning` 允许留空：留空不是失败，是"记下它在这里出现过，等一个可信释义"。

数据结构：key `lexicon:<conv>:<term>`，`data.origins[]` 每个来源一条 `{ conv?, platform?, url?, note?, meaning?, status, usageState?, seenAt }`（空字段不写，末尾必带 `seenAt`）；同一 `(conv, url)` 的 origin 是浅合并，不追加；`conv === 'web'` 存进 origin 时是 `null`。

三个状态，两个轴：

| 名字 | 轴 | 含义 | 怎么变 |
|---|---|---|---|
| `candidate` | `status` | 记下了来源，但还没有释义 | `meaning` 为空时写入 |
| `confirmed` | `status` | 至少一个 origin 有 `meaning` | `origins.some(o => o.status === 'confirmed')`；块级取"任一确认即确认" |
| `fading` | `usageState` | 这个词在这个来源已经不怎么用了 | 距 `decay.lastSeen` ≥30 天，`dream` 的 `lexicon` job 写 `usageState: 'fading'`、`decay.weight = max(0.1, weight * 0.7)` |

`fading` 不是 `status` 的第三种取值，它和 `candidate`/`confirmed` 正交：一个词可以既 `confirmed` 又 `fading`。`pending = !confirmed && !meaning`；写入口的条件是只要 `!confirmed` 就补一条待办（`查一下「…」是什么意思、从哪来的。`），且不去重。

`tags` 语义：

- `dream` 采集时按模型的 `reason` 映射：`shifted` → `新义`，`in-group` → `本群`，`frequent` → `高频`，其它 → `待查`。合并去重后截 8 个。
- `lexicon_learn` 的 `tags` 原样进（`tags.map(String)`），不规范化、大小写敏感；读侧用 `includes(String(tag))` 精确比较，大写写入、小写查不到。
- 与 `event` 的 `tags` 不是一套：event 的过 `normalizeTags`（小写、去空白/逗号/顿号、>10 字丢弃、最多 5 个）。

工具只有两个：`lexicon`（读，不改任何状态）和 `lexicon_learn`（写，走 `upsert`）。读列表封顶最新 500 条（`order:'desc'`），写入按 `key` 精确找旧词，不受窗口限制。`lexicon.query` 的 `conv=web` 与存储的 `conv:null` 已对齐（2026-11-03 修）。

## 7. 质量控制与固定素材

`tools/quality-run.mjs` 用固定素材跑一轮 `dream.run`，把结果写成 `docs/quality/<ISO 时间戳>.md`，并在 stdout 打一份 JSON。素材是 `tools/fixtures/quality-day.json`：21 条消息，刻意留出三段间隔（上午 10:02–10:10、下午 15:20–15:26、晚上 21:40–21:52），期望 3–5 块、每块正文 60–200 字、块内时间不跨段。

脚本报的指标：

| 指标 | 口径 |
|---|---|
| 块数 | `event`/`block` 的行数（`limit: 200`） |
| 正文平均字数 | `round(mean(String(b.data.body ?? b.text).length))`，同时给 min / max |
| 每块证据数 | `b.data.evidence.length` 逐块列出 |
| 时间跨度 | 每块 `${hhmm(from)}–${hhmm(to)}` |
| 人物 / 词汇 | `person` 块数、`person` 笔记数、`lexicon` 词条数 |
| 耗时 | 整轮秒数（模型是 `--model`，默认 `coder390-27b-q3-df2-4x500` @ `http://127.0.0.1:8088/v1`） |

同一素材的改前 / 改后（数据见 `docs/quality/README.md` 与其中两份快照，模型 `deepseek-chat`）：

| 指标 | 改前：wash 抽笔记，下游只读笔记 | 改后：当天原话完整成 log |
|---|---|---|
| 块数 | 3 | 3（早 / 午 / 晚各一块） |
| 正文平均 | 65 字（57–73） | 130 字（112–144） |
| 每块证据 | 1 条 | 5–9 条 |
| 块时间跨度 | 单点（10:02 / 15:24 / 21:40） | 10:02–10:10 / 15:20–15:26 / 21:40–21:52 |
| 人物 | 1 块 / 1 条笔记（只有曾嘉睿） | 2 块 / 8 条笔记（周子涵、曾嘉睿） |
| 词汇 | 6 条（含「白饭」/「白饭了」重复） | 2–4 条（无这类重复） |

结论：**洗得越少，记得越少**。wash 是抽取型时，它的遗漏就是整条记忆的遗漏（21 条消息只抽出 4 条笔记）。把当天原话完整存成 log，events 从它切块、people 从它找人，块自然变厚、证据自然变多、人不再漏。

再进一步（2026-11-03，wash 只剥结构化 JSON、不再调用模型）：当日 log 21 行完整，块数 3、正文平均 122 字（105–137）、每块证据 5–9 条、同样的三段跨度、人物 2 块 / 8 条笔记、词汇 2 条。质量没有下降反而更稳（不再依赖 wash 恰好抽到谁），还少一次模型调用。代价是 `people` 会产出 8 条近重复笔记（"装好了 PowerShell" / "装上了 PowerShell"），留给整理轮合并。

## 8. 已知缺陷（记忆侧）

| # | 严重度 | 现象（代码实际行为） | 状态（2026-11-03 晚） |
|---|---|---|---|
| 1 | 高 | 传 `cursor` 时 `includeArchive: true`，`resolve`（纠正队列）也被搜到 | **已修**：回忆只走 `recallable !== false` 的命名空间 |
| 2 | 高 | `cleanup` 的 `rewrites` 连打三次 `patch`，后两次基于改写前 `existing.data` | **已修**：一次算出完整 `nextData/nextText`，只 patch 一次 |
| 3 | 高 | `events` 把 log 行号当 `evidence.id`，重洗后行号位移 | **已修**：证据同时存 `line`（正文快照）与 `at`；`from/to` 用 `at` |
| 4 | 高 | 窗口都是"最老 N 条" | **已修**：`memory.query` 支持 `order:'desc'` / `id` / `count`；主要读取改最新；`missingVectors` 改 DESC；`note_status` 用 `count` 不再受窗口限制 |
| 5 | 高 | 原话层没有"谁说的" | **已修**：`dsh-raw` 补 `sender`（role）并解析 `tool/result`；桥的 `dsh-session` 源也补 `sender` |
| 6 | 中高 | `remember` 每次传 `weight:1.5`，更新时覆盖 boost | **已修**：更新默认保留原权重，只有 `reweight:true` 才覆盖 |
| 7 | 中高 | `patch`/`remove` 不删 `mem_vec` | **已修**：改正文或删行都清向量 |
| 8 | 中 | `skippedPeople` 存 `kind:value`，比对用 `person:kind:value` | **已修**：统一存 block key；"只标被引用的 note"仍是有意设计 |
| 9 | 中 | 同 summary 重跑会整块覆盖 text/body/evidence | **已修**：新证据优先，旧 evidence 合并保留（text/body 仍按新结果） |
| 10 | 中 | `dream-run` 每天 7 行，永不清理 | **已修**：每次 `dream.run` 结束清理 90 天前的账本 |
| 11 | 中 | 每次 `recall` 无条件 `saveCursor`，空召回也写 | **已修**：只在游标真的变化时落盘 |
| 12 | 中 | 日界三套：`dayKey`/`dayRange` 本机时区、`dayStartOf` 写死 +08、`ymdInTz` 用配置 | **已修**：三处统一走 `config.timezone`（含 DST 偏移校正） |

### 8.1 2026-11-03 晚补查的缺陷

| # | 严重度 | 现象 | 状态 |
|---|---|---|---|
| 13 | 高 | `lexicon.upsert` 用 `all()`（最新 500）查旧词；老词查不到时 origins/tags/decay 被空数组覆盖 | **已修**：按 `key` 精确取旧行；索引用 `put` 返回的 id |
| 14 | 中 | 同一个未知词每次 `lexicon_learn` 都写一条 note 待办 | **已修**：按 `about.key` 去重 |
| 15 | 中 | `whois.recentEventsFor` 在 DESC 结果上 `slice(-limit)`，拿到的是最老几条 | **已修**：`slice(0, limit)` |
| 16 | 中 | `dsh-raw.list` 取 `slice(0, limit)`（最老）；只解析 user/assistant | **已修**：取最新 `slice(-limit)`；解析 tool/result |
| 17 | 中 | `note`/`whois`/`dream` 按 id 找行时扫 200/500 行窗口，旧行找不到 | **已修**：`memory.query` 支持 `id` 精确查 |
| 18 | 高 | `memory.search` 只扫最新 500 行；事件块几个月后就永远搜不到 | **已修**：扫描窗口 `config.scanLimit` 默认 5000 |
| 19 | 中 | `lexicon` 的 `conv=web` 查不到默认 web 来源（存 `null`，比 `'web'`） | **已修**：`web` 归一到 `null` 比较 |

修复顺序建议见 STATUS.md。
