# 记忆类插件审计：memory / recall / note / lexicon / whois / eager-recall

> 范围：`packages/plugins/{memory,recall,note,lexicon,whois,eager-recall}` 的 `manifest.json` 与 `src/index.mjs`，以及 `packages/core/test/` 里与它们相关的测试。
> 方法：只读代码，逐条对照实现与测试。本文只记录代码里能证明的行为，不给建议。
> 约定：中文叙述；工具名、字段名、格式串、命名空间一律照抄原文（英文/中文原样）。

## 0. 一览

| 插件 | `manifest.tools` | 代码里实际 `ctx.tools.register` | 提供的 service | `requires.plugins` |
|---|---|---|---|---|
| `memory` | `[]` | 无 | `memory` | 无 |
| `recall` | `remember`, `recall`, `forget` | 3 个 | `recall` | `memory` |
| `note` | `memo`, `memos`, `memo_append`, `memo_commit`, `note_status` | 5 个 | `note` | `memory` |
| `lexicon` | `lexicon`, `lexicon_learn` | 2 个 | `lexicon` | `memory` |
| `whois` | `whois` | 1 个 | 无 | `memory` |
| `eager-recall` | `[]` | 无（注册的是 `ctx.prompt.onTurn`） | 无 | `memory` |

全部 11 个工具名：`remember`、`recall`、`forget`、`memo`、`memos`、`memo_append`、`memo_commit`、`note_status`、`lexicon`、`lexicon_learn`、`whois`。

## 1. 每个插件负责什么

**memory** —— 唯一真正存东西的插件。它用 `node:sqlite` 开一个单文件库（默认 `<root>/state/memory.db`，可用 `ctx.config.path` 覆盖），建三张表：命名空间表、条目表、向量表。它不理解"事件/人物/梗"这类业务，只提供原语：注册命名空间（带 `label`、`recallable`、`halfLifeDays`、`retention`、`schemaVersion`、`owner`）、按 `namespace`+`key` 写入或更新条目、按 `kind`/时间区间原样查询、带评分的混合检索（可选的向量插槽 + 字面重叠 + 精确串加成 + 半衰期衰减）、召回成功后的加权 `boost`、只改 `text`/`data` 的 `patch`、删除、标签频次统计、缺向量清单、按身份查人物档案。向量能力是可选的：`manifest.slots[0]` 声明 `{ "id": "embed-text", "kind": "embedding", "requires": { "dim": 1024 } }`，插槽没接上时 `embed()` 返回 `null`，检索退化成字面/二元组匹配，不报错。它以 `ctx.services.provide('memory', api)` 把整个 api 交给别的插件。

**recall** —— 模型侧唯一的"记 / 想起来 / 删掉"入口，也是命名空间 `event`/`person`/`slang`/`resolve`/`recall-cursor` 的注册者。它把两层东西合成一个结果：已经沉淀的 `block`，和还没被做梦消化的 `note`；每条结果前面加一个人造标签（`[今天]`、`[事件 · 3 天前]`、`[人物 · 昨天 · 随手记]`）。去重不靠服务端记忆，而靠一个持久化游标：游标里只放 `{id, tokens}` 列表，按 token 预算滚动，超预算就从最早进窗口的块开始解锁。任何一次成功召回都会 `memory.boost` 这些条目，让它们"回到新鲜"。`kind='person'` 且 `query` 非空时它不走向量检索，而是直接 `memory.findPerson` 读档案。它还会在结果末尾附最多两条"原文"（来自 `ctx.services.raw` 这个可选原文层）。

**note** —— 被动的备忘录，不是记忆：`note` 命名空间 `recallable: false`，所以 `recall` 永远搜不到它。它只回答"还有几件事没了"。写入口有两个：模型调 `memo`，或者别的插件调 `ctx.services.get('note').add()`（`lexicon` 发现新词没释义、`dream` 发现块/档案没出处时都会写）。它同时向 `world` 服务挂一个标题为 `待办`、`cap: 1` 的来源，把计数交给世界状态，自己不往对话里推任何消息。

**lexicon** —— 语料层，一个词一个 `term` 块，词义按"来源"累积在 `data.origins` 里。写入叫 `upsert`：同一个 `lexicon:<conv>:<term>` 只更新不重复新增；带 `meaning` 的来源记 `status: 'confirmed'`，不带的记 `candidate`。不确定的词不只进库，还会在 `note` 里留一条待办（`查一下「<term>」是什么意思、从哪来的。`），等主会话自己上网查——`dream` 的 `consume` job 会在待办被 `memo_commit` 之后把结论写回词条。

**whois** —— 身份解析，不是 `recall` 的别名。它只回答"这个人是谁"：给 `qq` / `idKind`+`value` / `subjectKind`+`value` 时按账号精确找，给 `name` 时按子串给候选（不硬猜）。命中单个人时把档案、账号列表、熟悉度、逐句依据（`claims` + 每条 claim 的 `evidence` 对应的笔记原文）、档案级 `evidence`、原文层里的一两句原话、以及"最近提到 TA 的事"拼成一段文本。它自己不注册命名空间，只读 `person` 命名空间里 `kind='block'` 的行。

**eager-recall** —— 自动召回。每条用户消息进来时由核心调 `prompt.turnText`，它用消息文本当 query 做一次 `memory.search`，只取 `score >= minScore` 的前 `maxItems` 条，拼成一段以 `你可能记得（检索结果，仅供参考）：` 开头的提示词段。三条自我约束写在代码里：只交提示词段不推消息、低于阈值一条都不给、总字数超 `maxChars` 就截断。可以 `enabled: false` 一行关掉。

## 2. 工具面

注册时的统一处理（`packages/core/src/services.mjs:245-272`）：`summary` 会被截到第一个句号为止再切 160 字符；最终给模型看的 `description` 是 `composeToolDescription(definition)` 的结果，即 `summary + ' ' + description + ' Use when: … . Avoid when: … . Safety: … .`（有哪个拼哪个，超 `TOOL_TEXT_LIMITS.perTool = 900` 字先砍 `when`/`avoid` 行再截正文）。若设了环境变量 `ICL_TOOL_TIME=1`，每个工具返回的 `text` 末尾会被追加 `\n（现在 HH:MM:SS ）`（注意 `）` 前有一个空格）。

| 工具 | 插件 | `summary`（原文） | `parameters`（名称: 类型，*必填*） | `execute` 返回 | 模型看到的 `text` 形状 |
|---|---|---|---|---|---|
| `remember` | `recall` | `Write down something you want to keep - a fact, a person, a bit of slang, something that happened.` | `text`: string*、`kind`: string（enum `event`/`person`/`slang`/`resolve`）、`key`: string、`qq`: string、`origin`: object、`subjectKind`: string、`about`: object；`additionalProperties: false` | `{ text: '记下了。' }` | 只有 `记下了。` |
| `recall` | `recall` | `Bring back what you remember about events and things that happened - not for looking up people.` | `kind`: string（同一 enum）、`query`: string、`limit`: number、`cursor`: string、`about`: object、`conv`: string、`tag`: string；无必填，`additionalProperties: false` | `{ text, cursor, more }`（`cursor` 是 base64url 串或 `null`） | 见 §5.1，多行、每行一个条目 |
| `forget` | `recall` | `Drop one of your notes by key.` | `key`: string*、`kind`: string（同一 enum） | `{ text: '删掉了。' }` 或 `{ text: '没有这条笔记。' }` | 同上两串之一 |
| `memo` | `note` | `Leave yourself a small note about something you do not want to forget to do.` | `text`: string* | `{ text: '记下了。' }` 或 `{ text: '没写成。' }` | 同上 |
| `memos` | `note` | `See how many notes you left open, and what they are.` | `all`: boolean、`done`: boolean | `{ text }` | `没有待办。` 或若干行 `· <text>`（每条 `updates` 追加 `\n  + <text>`） |
| `memo_append` | `note` | `Add a line to an existing note - new evidence, a partial answer, something you learned.` | `id`: number*、`text`: string* | `{ text: '补上了。' }` 或 `{ text: '没补上（找不到那条）。' }` | 同上 |
| `memo_commit` | `note` | `Mark a note finished, with what you concluded.` | `id`: number*、`result`: string、`source`: string | `{ text: '完成了。' }` 或 `{ text: '没找到那条。' }` | 同上 |
| `note_status` | `note` | `How many notes are open, done, or archived - just counts, no content.` | `{}`（`properties: {}`，无参数） | `{ text }` | `待办 ${open} 条，已完成待回收 ${done} 条，已归档 ${archived} 条。` |
| `lexicon` | `lexicon` | `Look up words and slang: what they mean, where they are used, which group they came from.` | `term`: string、`conv`: string、`platform`: string、`tag`: string、`limit`: number | `{ text }` | 见 §5.4 |
| `lexicon_learn` | `lexicon` | `Record a word or phrase you just met, with where you met it and what it seems to mean.` | `term`: string*、`meaning`: string、`usage`: string、`conv`: string、`platform`: string、`url`: string、`tags`: array<string> | `{ text }` | 见 §5.4 |
| `whois` | `whois` | `Look up a person you already have a file on: exact by account, candidates by name.` | `qq`: string、`idKind`: string、`subjectKind`: string、`value`: string、`name`: string | `{ text }` | 见 §5.5（多行） |

`memory` 与 `eager-recall` 没有工具：前者只提供 service，后者只提供提示词段。

带 `when`/`avoid` 的工具，拼装后的 `description` 逐字如下（`head` 是 `summary` 与可选 `description` 用空格连接）：

- `remember`：`Write down something you want to keep - a fact, a person, a bit of slang, something that happened. It is private and trusted: at night it is given high weight when memories are consolidated. kind: event (default), person, slang. Keep it to one or two sentences. Use when: something is worth keeping for later; the user tells you to remember it. Avoid when: long transcripts; things you would only need this turn.`
- `recall`：`Bring back what you remember about events and things that happened - not for looking up people. kind narrows to event / person / slang; pass kind=person together with a QQ number or a name to read that person's file. query filters by meaning; tag narrows to a label. Pass the returned cursor to continue without being shown the same blocks again; the budget is about 10k tokens. Use when: someone asks about the past; you need context that is no longer in the window. Avoid when: looking up who a person is - use whois for identity, accounts and closeness.`（`forget` 无 `when`/`avoid`，`description` 就等于 `summary`。）
- `memo`：`… Use when: you want to come back to something later in this session. Avoid when: facts about the past (use remember).`
- `memos`：`… Use when: you want to check what you were going to come back to. Avoid when: when you are looking for a memory (use recall).`
- `memo_append`：`… Use when: you found part of the answer and the note is still open. Avoid when: writing a brand new note (use memo).`
- `memo_commit`：`… Use when: the question is answered or no longer matters. Avoid when: marking something done that you only partly answered (append instead).`
- `note_status`：`… Use when: you want a quick sense of how much is pending. Avoid when: when you need the actual text (use memo_list).`
- `lexicon`：`… Use when: a word or phrase you do not recognise appears; you want to use the right expression for a place. Avoid when: when you need facts about events (use recall).`
- `lexicon_learn`：`… Use when: you hear a new expression and want to remember it; someone explains a term to you. Avoid when: recording ordinary facts (use remember).`
- `whois`：`Look up a person you already have a file on: exact by account, candidates by name. Use when: someone mentions a person and you need to know who they are; you need their account ids or how close you are. Avoid when: when you just want to remember something that happened (use recall); when the name is ambiguous - pick from the candidates instead of guessing.`

## 3. 数据模型

### 3.1 SQLite 结构（`memory/src/index.mjs:23-54`）

- `mem_ns(id TEXT PRIMARY KEY, label TEXT, recallable INTEGER DEFAULT 1, half_life_days REAL DEFAULT 30, retention TEXT, schema_version INTEGER DEFAULT 1, owner TEXT, created_at INTEGER)`
- `mem_items(id INTEGER PRIMARY KEY, namespace TEXT, kind TEXT, key TEXT, text TEXT NOT NULL, data TEXT, weight REAL DEFAULT 1, recall_count INTEGER DEFAULT 0, last_recalled_at INTEGER, created_at INTEGER, updated_at INTEGER)`
- 唯一索引 `ux_mem_key ON mem_items(namespace, key) WHERE key IS NOT NULL`；普通索引 `ix_mem_ns(namespace, created_at)`；向量表 `mem_vec(item_id INTEGER PRIMARY KEY, dim INTEGER, vec BLOB)`，`vec` 是 `Float32Array` 的字节视图。
- `key` 允许为 `NULL`：`note` 插件的备忘全部走这条，所以同一命名空间可以有大量无 key 行。

### 3.2 注册的命名空间

| id | label | recallable | halfLifeDays | 注册者 |
|---|---|---|---|---|
| `event` | `事件` | `true` | `30` | `recall`（`CATEGORIES.event`） |
| `person` | `人物` | `true` | `180` | `recall`（`CATEGORIES.person`） |
| `slang` | `梗` | `true` | `90` | `recall`（`CATEGORIES.slang`） |
| `resolve` | `纠正` | `false` | `1` | `recall`（`CATEGORIES.resolve`） |
| `recall-cursor` | `回忆游标` | `false` | 默认 `30` | `recall` |
| `note` | `备忘` | `false` | 默认 `30` | `note` |
| `lexicon` | `语料` | `true` | `180` | `lexicon` |
| `dream-run` | `做梦记录` | `false` | 默认 `30` | `dream`（本审计范围外，但被这几者读写） |

`registerNamespace` 幂等：已存在时直接返回 `{ id, already: true, label, recallable }`，**不更新** `halfLifeDays`/`label`/`recallable`；写入未注册命名空间会抛 `命名空间没有注册：<ns>`。

### 3.3 条目 kind 与 key 格式

`kind` 取值：`note`（未沉淀的原话/碎片）、`block`（沉淀后的块）、`term`（词条）、`cursor`（回忆游标）、`run`（做梦幂等记录）。

| 写入方 | namespace | kind | key |
|---|---|---|---|
| `remember`（默认） | `event` | `note` | `note:<now>:<Math.random().toString(36).slice(2,7)>` |
| `remember`（带 `key`） | 目标命名空间 | `note` | 调用方给的任意串 |
| `dream` `events` job | `event` | `block` | `evt:<YYYY-MM-DD>:<hash(summary)>`（`hash` = `h = h*31 + charCode >>> 0` 后 `toString(36)`） |
| `dream` `slang` job | `slang` | `block` | `slang:<term>` |
| `dream` `people` job | `person` | `block` | `person:<qq>`；非 QQ 身份为 `person:<kind>:<value>` |
| `dream` `wash`/`consume` job | `event` / `person` | `note` | `null`（每次新建） |
| `recall` 游标 | `recall-cursor` | `cursor` | `cursor:<sessionId>`（缺省 `default`） |
| `lexicon.upsert` | `lexicon` | `term` | `lexicon:<conv>:<term>`，`conv` 缺省 `web` |
| `dream` 幂等 | `dream-run` | `run` | `run:<day>:<job>` |
| `note.add` | `note` | `note` | `null` |

### 3.4 各类 `data` 载荷

`note`（`remember` 写入 `event`/`person`/`slang`/`resolve`）：

```
{ day: 'YYYY-MM-DD', session: '<sessionId>',
  subject?: { kind, value }, qq?: '<value>', about?: object, origin?: object }
```

`dream` 之后追加 `consolidated: true` 与 `consolidatedAt`；`wash` 另写 `{ day, washed: true, subject?: { kind: 'name', value }, origin?: { conv }, at? }`；`consume` 回收的笔记写 `{ consolidated: false, fromNote: <note id> }`。

`note` 命名空间的备忘（`note.add`）：

```
{ status: 'open', raisedBy: 'session' | 'lexicon' | 'events' | 'people' | 'cleanup' | 'dream',
  kind: 'memo' | 'question', about: object | null, createdAt }
```

后续可能追加：`updates: [{ text, at }]`、`result`、`source`、`doneAt`、`consumedAt`、`answer`、`resolvedAt`。

`event` 块：`{ body, evidence: [{ type: 'note', id }], provisional: bool, day, people: [String], tags: [String], sources: [String], mergedFrom?: [key], uncertain?: bool, superseded?: true, supersededBy?: key }`。

`person` 块：`{ subject: { kind, value }, qq, ids: [{ kind, value }], familiarity, provisional: bool, evidence: [{ type: 'note', id }], claims: [{ text, evidence: [{ type: 'note', id }] }], profile, narrative, facts: [], aliases: [], sources: [key], rewrittenAt }`。

`slang` 块：`{ term, meaning, usage, examples: [], sources: [key] }`。

`lexicon` 词条：`{ term, origins: [...], tags: [String], usage, status: 'confirmed' | 'candidate', pending: bool, usageState: 'active' | 'fading', decay: { weight, lastSeen }, evidence }`；单个 origin 为 `{ conv?, platform?, url?, note?, meaning?, status: 'candidate' | 'confirmed', usageState?, seenAt }`（空字段直接不写，所以是可选键）。

`recall-cursor`：`{ items: [{ id: number, tokens: number }] }`，行 `text` 为 `${n} 块在窗口内`。

## 4. 算法

### 4.1 `memory.search` 的混合评分

签名默认值：`{ namespace = null, namespaces = null, query = '', limit = 8, includeArchive = false, now = ctx.now(), minScore = null, tags = null, tagMode = 'any', conv = null }`。

1. **命名空间过滤**：给了 `namespaces`/`namespace` 就逐个 `namespaceInfo`，否则全表；`includeArchive === false` 时丢掉 `recallable === false` 的行。
2. **取行**：`SELECT * FROM mem_items WHERE namespace IN (…) ORDER BY created_at DESC LIMIT 500` —— 每个命名空间集合最多 500 行，按新到旧。
3. **软删过滤**：`data.superseded !== true` 才留（被整理轮合并掉的块还在库里）。
4. **`conv` 过滤**：只留 `JSON.parse(data).origin.conv === String(conv)` 的行；`data` 为 `null` 的行直接丢弃（`return false`）。
5. **`tags` 过滤**：两边都 `toLowerCase()`；`tagMode === 'all'` 时要全部命中，否则任一命中。标签只缩小范围，**不参与打分**。
6. **相似度 `sim`**：
   - 有嵌入：`sim = 0.7 * cos + 0.3 * bigramOverlap(text, query)`；`cos` 是查询向量与 `mem_vec` 里该行向量的余弦。
   - 精确串加成（`LITERAL_ON`，即 `process.env.ICL_NO_LITERAL !== '1'`）：`literalTerms(query)` 抽 Windows 路径、文件名（`txt|md|json|mjs|js|py|log|db|png|jpg`）、带单位数字（`元|块|次|天|秒|分钟|小时|%|GB|MB`）、4 字符以上英文词；命中数 `exact` 时 `sim = Math.min(1, sim + 0.5 * (exact / terms.length))`。
   - 无嵌入但有 query：`sim = 查询二元组被文本覆盖的比例`（交集/查询集合大小）。
   - 无 query：`sim = 1`（纯按新鲜度/权重排）。
7. **衰减与总分**：`anchor = lastRecalledAt ?? createdAt`，`ageDays = max(0, (now-anchor)/86_400_000)`，`decay = exp(-ageDays / max(1, halfLifeDays))`，`score = sim * weight * decay`；`minScore != null` 时过滤 `score < minScore`。
8. **排序与截断**：`score` 降序、同分按 `createdAt` 降序，取 `max(1, limit)` 条。

`LITERAL_ON` 只在第 6 步决定是否加精确串分；`literalTerms` 每次调用都在逐行循环里重算（见 §6）。

`archiveSearch`（`memory/src/index.mjs:195`）是另一条"只按字面找原话"的路：先用 `literalTerms`，抽不到就退回查询的前 12 个二元组（滤掉含 `?？。，、` 的）；只在 `recallable = 1` 的命名空间里、只对 `kind === 'note'` 的行命中计数，按命中数降序、同分按 `createdAt` 降序取 `limit`。这条路径目前没有调用方。

### 4.2 `recall` 的编排

1. **候选**：`kind` 命中 `CATEGORIES` 时只搜那一类，否则搜 `event`/`person`/`slang`/`resolve` 四类；每类调一次 `memory.search({ namespace, query, limit: 50, now, tags: tag ? [tag] : null, conv })`。`kind='resolve'` 时 `memory.search` 因该命名空间 `recallable: false` 返回空，但第 2 步的未整理队列仍会从 `resolve` 里取到东西。已被消化的 note（`data.consolidated === true`）不作为候选。候选按 `score` 降序、同分按 `createdAt` 降序。
2. **未整理的 note 单独一队**：`tag` 为空时，`memory.query({ namespace, kind: 'note', limit: 200 })` 里所有 `consolidated !== true` 的条目以固定 `score: 1.15` 入队（今天的显示为 `[今天]`，跨天的显示为 `[未整理 · MM-DD]`）。带 `tag` 时这一队直接为空。
3. **配额**：先取 `noteQuota = Math.max(1, Math.floor(limit / 2))` 条未整理 note，再按顺序取候选（最多看 100 条）。
4. **游标去重**：`inWindow` 是游标里 `items[].id` 的集合；已在窗口里的条目不重复给，但也不从游标里删。
5. **token 预算**：`budgetTokens = Math.max(500, Number(ctx.config.budgetTokens) || 10_000)`；`estimateTokens(text) = Math.max(1, Math.ceil(cjk / 1.5 + rest / 4))`。单条如果让 `tokens + t > budgetTokens` 就跳过，但**第一条永远放行**（否则会返回空）。
6. **滚动游标**：`rollCursor` 把本轮新增的 `{id, tokens}` 追加到旧窗口，然后 `while (totalTokens(items) > budgetTokens && items.length > 1) items.shift()` —— 从最早进窗口的块开始解锁。`while` 保证至少留一条。
7. **持久化**：游标落在 `recall-cursor` 命名空间的 `cursor:<session>` 行，`text` 为 `${n} 块在窗口内`；返回给模型的是 `Buffer.from(JSON.stringify(cursor)).toString('base64url')`。传进来的 `cursor` 先经 `safeParseCursor`，解析失败退化成空窗口。
8. **回鲜**：`picked` 非空就 `memory.boost(ids, { now })` → `weight = MIN(5, weight + 0.2)`、`recall_count += 1`、`last_recalled_at = now`。
9. **原文回退**：只要 `ctx.services.raw?.ids?.().length` 非 0，就 `raw.search({ query, limit: 2 })`；结果过滤掉"归一化后前 40 字符已出现在主结果里"的，最多留 2 条，渲染成 `原文（MM-DD）：前 160 字`。异常被吞掉，不影响主结果。
10. **返回**：`text` = 主结果行 + 原文行用 `\n` 连接；`cursor` = 新游标；`more` = `candidates.length > picked.length`。

`kind='person'` 且 `query` 非空时走另一条路（§4.3 的调用方）：`/^\d{2,12}$/` 命中就当 QQ 传 `{ qq }`，否则当名字传 `{ name }`；找到第一个人就返回 `[人物] <档案正文>`，有 `claims` 时再附 `依据：` 与 `· <claim.text>`。这条路**不读也不写游标**，**不做 `boost`**，且只取 `people[0]`。

### 4.3 `findPerson` 路由

`findPerson({ qq, idKind, value, name, subject, limit = 5 })` 只查 `namespace = 'person' AND kind = 'block'` 的行，匹配顺序固定：

1. 组装 `wanted`，顺序是 `qq` → `subject` → `idKind + value`（同一 kind 重复时不去重）。
2. 精确匹配（只在这些 `wanted` 非空时）：一条档案命中任意一个条件即算精确 —— `data.ids[]` 里有同 `kind`+`value`、`data.subject` 同 `kind`+`value`、`wanted.kind === 'qq'` 时 `key === 'person:<value>'`、或 `data.qq === value`。
3. 有精确命中就返回 `{ exact: true, people }`（最多 `limit` 条），**不再做名字匹配**。
4. 没有精确命中、且 `name` 为空：返回 `{ exact: false, people: [] }`。
5. 有 `name`：在 `` `${b.text}\n${b.data?.profile ?? ''}` `` 的小写串里做 `includes` 子串匹配，返回 `{ exact: false, people }`。

`whois` 传入全部五个参数；`recall` 只传 `{ qq }` 或 `{ name }`。

### 4.4 `note` 的生命周期

状态都在 `data.status` 上，缺省视为 `open`（`isOpen = (n.data?.status ?? 'open') === 'open'`）：

```
open --memo_commit--> done --dream consume（有 about.namespace 且有 result/最后一条 update）--> archived
open --note.resolve()（dream cleanup 关疑问时调用）--> resolved
```

- `open`：`note.add` 写入，`data = { status: 'open', raisedBy, kind, about, createdAt }`。
- `done`：`memo_commit` 写 `status: 'done'` + `result` + `source` + `doneAt`；`memo_append` 只往 `data.updates` 追加，**不改状态**。
- `archived`：`dream` 的 `consume` job 扫 `status === 'done'` 的行，按 `about.namespace` 分三支写回：`lexicon` 调 `lexicon.upsert({ term, conv, meaning: result, … })`；`person` / `event` 写一条 `text` 为 `（备忘回收）${result}` 的 note；写成功才 `status: 'archived'` + `consumedAt`。没有 `about.namespace` 或没有结论的 `done` 行既不写回也不归档。
- `resolved`：`note.resolve(id, { answer })` 直接把整块 `data` 换成 `{ ...旧, status: 'resolved', answer, resolvedAt }`；它只被 `dream` 的 `cleanup` job 调用——纠正（`resolve` 命名空间的 note）处理完后，把所有 `about.key` 相同的未结疑问关掉，`answer` 取纠正原文前 200 字。
- 另一条独立的标记：`resolve` 命名空间里的纠正 note 被整理轮处理后会打 `data.consumed = true` + `consumedAt`，这样下一轮不再重复处理。**`consumed` 不是 `note` 命名空间的状态**。

### 4.5 `lexicon` 的 origins 合并与状态迁移

`upsert({ term, conv = 'web', platform, url, meaning = '', usage = '', tags = [], evidence })`：

1. 空词直接返回 `{ ok: false, error: 'empty-term' }`；`conv` 为 `web` 时存进 origin 的 `conv` 是 `null`。
2. 取同 key 的旧行，复制 `origins`；找"同来源"下标：`(o.conv ?? null) === (conv === 'web' ? null : conv) && (o.url ?? null) === url`。命中就 `origins[same] = { ...origins[same], ...fresh }`（**浅合并，旧字段保留**），否则 `push(fresh)`。
3. `fresh = originOf({ conv, platform, url, meaning: meaning || null, status: meaning ? 'confirmed' : 'candidate' })`，其中 `seenAt = ctx.now()`。
4. 聚合字段：`status = origins.some(o => o.status === 'confirmed') ? 'confirmed' : 'candidate'`；`pending = !confirmed && !meaning`；`tags` 去重后截到 8 个；`usage` 取新值或旧值；`decay = { weight: 旧 weight ?? 1, lastSeen: now }`。
5. `usageState = origins.some(o => (o.usageState ?? 'active') === 'active') ? 'active' : 'fading'` —— 因为新建 origin 的 `usageState` 是 `null`，这条恒为 `active`。
6. 写库：`text = `${word}：${meaning || '（意思还不确定）'}``，`kind: 'term'`，`key = lexicon:<conv>:<word>`，然后异步 `memory.index` 用 `${word} ${meaning} ${usage}` 建向量。
7. `!confirmed` 时追加待办：`noteSvc.add({ text: `查一下「${word}」是什么意思、从哪来的。`, about: { namespace: 'lexicon', key, term: word, conv }, raisedBy: 'lexicon', kind: 'question' })`。

老化由 `dream` 的 `ageLexicon` 做（本审计范围外、但直接改这些行）：距 `data.decay.lastSeen` 超过 30 天 → `usageState = 'fading'`、`decay.weight = max(0.1, weight * 0.7)`。`lexicon` 自己的读路径（`lexicon` 工具）不改变任何状态。

### 4.6 `eager-recall` 的注入

`enabled = ctx.config.enabled !== false`，`minScore = Number(ctx.config.minScore ?? 0.5)`，`maxItems = max(1, Number(ctx.config.maxItems ?? 2))`，`maxChars = max(40, Number(ctx.config.maxChars ?? 200))`。每轮：`memory.search({ query, limit: max(4, maxItems * 3), now, minScore })` → 再过一次 `score >= minScore` → 丢掉 `kind === 'cursor'` → 取前 `maxItems` 条。没有命中返回 `null`（核心的 `prompt.turnText` 会把它变成空串，再叠一个 800 字的全局上限）。检索不带 `namespace` 参数，所以 `event`/`person`/`slang`/`lexicon` 四个可回忆命名空间都会被扫。

## 5. 精确字符串

### 5.1 `recall` 的输出行

条目渲染（`renderEntry`，`recall/src/index.mjs:274-287`）：

| 条件 | 输出 |
|---|---|
| 未整理 note，`createdAt >= 今天 0 点` | `[今天] ${item.text}` |
| 未整理 note，跨天 | `[未整理 · ${M}-${DD}] ${item.text}` |
| `kind === 'block'` | `[${tag}] ${item.text}` |
| 其它（未消化的 note 走候选路径） | `[${tag} · 随手记] ${item.text}` |

`tag` 由 `label(ns, createdAt, now)` 生成：`days = Math.floor((now - createdAt) / 86_400_000)`；`when` 取 `今天`（`days <= 0`）、`昨天`（`days === 1`）或 `${days} 天前`；`tag` 是 `meta.label` 与 `when` 用 ` · ` 连接。所以真实的前缀是：

```
[今天] 他说周末可能去看海
[事件 · 今天] 那天我测了写权限
[事件 · 昨天] …
[事件 · 3 天前] …
[人物 · 今天] …
[梗 · 2 天前] …
[事件 · 昨天 · 随手记] …
[未整理 · 10-31] …
```

`[纠正 · …]` 这个**标签**不会出现（`resolve` 在候选路径里被 `memory.search` 的 `recallable` 过滤挡掉），但 `resolve` 的**内容**会以 `[今天]`/`[未整理 · MM-DD]` 的形式出现——见 §6.31。

单条 `kind='person'` 分支：

```
[人物] <person.text>
依据：
· <claim.text>
· <claim.text>
```

空结果的两种兜底（`recall/src/index.mjs:238-240`）：

```
这几条刚才已经给过你了（就在上面的上下文里）；要找别的，把要找的事说具体一点。
没有想起什么。（也没记过。）
```

前者在"有候选但全被游标挡住"时出现，后者只在"完全没有任何候选/未整理 note"时出现。多行之间的分隔符统一是 `\n`。

### 5.2 原文回退行（archive fallback）

```
原文（${M}-${DD}）：${String(r.text).slice(0, 160)}
```

`M` 不补零、`DD` 补零（`shortDate`），时间取 `r.time ?? r.createdAt ?? ctx.now()`。整行没有 `出处：` 这个字样——`出处` 只出现在 `dream` 的提示词/待办文本里（`「${summary.slice(0, 40)}」没有出处，以后问一下。`、`关于「${profile.slice(0, 20)}」的档案没有出处，有机会核实一下。`）。

### 5.3 `note` 的状态计数

```
待办 ${open} 条，已完成待回收 ${done} 条，已归档 ${archived} 条。
```

`open` 用 `isOpen`（缺省算 open），`done`/`archived` 用 `data?.status` 严格相等。`resolved` 不进任何一栏。

`memos` 的空结果：`没有待办。`；每条：`· ${r.text}`，`updates` 逐条追加 `\n  + ${u.text}`。

### 5.4 `lexicon` 的输出

单条词条（多条之间用空行 `\n\n` 连接）：

```
${term}：${status === 'confirmed' ? '已确认' : '待确认'}${usage ? `，${usage}` : ''}
· ${where}：${what}${note ? `（${note}）` : ''}
```

`where` 由 origin 决定：有 `conv` 写 `群 <conv>`，否则有 `platform` 写该值，否则 `网上`；`what` 取 `o.meaning`，缺省 `意思待确认`。空结果：

```
没有这个说法。要是刚听到，可以先用 lexicon_learn 记下来。
```

`lexicon_learn` 的三种返回：

```
记下了「${term}」，意思还不确定，已经留了待办去查。
记下了「${term}」。
没记成（缺词）。
```

### 5.5 `whois` 的输出

单个人档案：

```
· ${person.text}
  （${familiarity}${ids ? ` · ${ids}` : ''}）
逐句依据：
· ${claim.text}  ← ${src1}；${src2}
依据：
· ${note.text.slice(0, 100)}
原话：
· ${raw.text.slice(0, 120)}
最近提到 TA 的事：
· ${event.text}
```

`ids` 是把 `data.ids` 逐项写成 `<kind>:<value>` 再用 `、` 连接；`familiarity` 缺省 `'unknown'`；第二行前是两个空格；`←` 前有两个空格。`逐句依据：` 只有在 `claims` 非空时出现（最多 6 条），`依据：` 在 `data.evidence` 能查到笔记时出现（最多 5 条），`原话：` 只有在 `ctx.services.raw` 有来源且有命中时出现，`最近提到 TA 的事：` 只在事件非空时出现（最多 3 条）。

多个候选：

```
按名字找到 ${people.length} 个可能的人：
· …
```

没有档案：

```
还没有 ${qq} 的档案（认识之后、做梦整理过才会有）。
还没有这个人的档案。
```

### 5.6 `eager-recall` 注入段

```
你可能记得（检索结果，仅供参考）：
· [${tag}] ${text.slice(0, 80)}
```

`tag = item.kind === 'note' ? '未整理' : (h.namespace ?? '记忆')`。超过 `maxChars` 时 `text.slice(0, maxChars - 1).trimEnd() + '…'`。

## 6. 已知缺口与脆弱点（均可由代码证明）

1. **原文回退无条件执行。** `recall` 只要发现 `raw` 有来源就会查并追加，没有"块已覆盖就不查"的分支；唯一的抑制是"前 40 字符已出现在主结果里"的去重。因此 `archive-fallback.test.mjs:54,62` 的 `doesNotMatch(/出处：/)` 恒真——代码里根本不存在 `出处：` 这个串（只有 `原文（`），这两个负向断言无法证明"主结果覆盖时不查原文层"。
2. **`memory.archiveSearch` 无调用方。** 全仓 `grep archiveSearch` 只命中定义本身（`memory/src/index.mjs:195`）；`recall` 用的是 `ctx.services.raw`。这是一段与 `raw` 功能重叠的 dead code。
3. **游标可能读不到。** `loadCursor` 用 `memory.query({ namespace: 'recall-cursor', kind: 'cursor', limit: 1 })` 再 `.find(r => r.key === cursorKey)`：`memory.query` 是 `created_at ASC`，`limit: 1` 只返回最早的那一行。同一库里存在第二个 `sessionId` 的游标后，后者的游标永远读不到（`memory.put` 的更新不改 `created_at`，写入顺序一旦固定就固定）。
4. **`eager-recall` 的标签恒为 `[记忆]`。** `memory.search` 返回的元素形状是 `{ item, score }`，没有 `namespace` 字段（`recall` 是自己 `{ ...hit, namespace: ns }` 补的）。所以 `h.namespace ?? '记忆'` 永远走兜底，注入段里不会出现 `[事件]`/`[人物]`/`[梗]`。
5. **`note_status` 的 `avoid` 指向不存在的工具。** 文本是 `when you need the actual text (use memo_list)`，实际工具名是 `memos`。
6. **`resolved` 状态不可见。** `note.resolve()` 写 `status: 'resolved'`，而 `note_status` 只统计 `open`/`done`/`archived`；`open_notes`/`count()` 也把它排除。疑问被关掉后从计数里彻底消失。
7. **`note` 的计数与列表都以 500 为界。** `rows()` 是 `memory.query({ namespace: 'note', kind: 'note', limit: 500 })`（`created_at ASC`），`count()`、`openNotes()`、`note_status` 全都基于它：超过 500 条后计数饱和，且只数到最老的 500 条。
8. **`recall` 的未整理队列取的是最老的 200 条。** `memory.query({ …, kind: 'note', limit: 200 })` 同样是 `created_at ASC`；note 超过 200 条时，今天的 `[今天]` 可能根本不在这 200 条里，而更老的未整理项会占掉 `noteQuota`。
9. **人物分支不刷新、不提示候选。** `kind='person'` 命中档案后直接 `return { text, cursor: null, more: false }`：不写游标、不 `memory.boost`，读档案不会重置衰减计时；多人同名时也只取 `people[0]`，不给候选（`whois` 才给）。
10. **`put` 的更新路径把 `weight` 打回 1。** `memory.put` 更新已存在 key 时执行 `SET kind, text, data, weight, updated_at`，`weight` 取参数默认值 `1`。`dream` 的 `people` 整块重写、`cleanup` 的合并写回、`lexicon.upsert` 都会经过它，被召回攒起来的权重因此被清零（`recall_count`/`last_recalled_at` 反而保留）。
11. **`put` 更新文本不失效旧向量。** `saveVec` 只在 `memory.index` 被显式调用时执行；`memory.put` 的更新分支不删 `mem_vec` 里的旧行。文本被改写后，检索仍可能用旧文本算出的向量。
12. **`registerNamespace` 不更新已存在行。** 已存在时只返回 `{ already: true }`，`halfLifeDays`/`label`/`recallable` 的后续修改不会生效；`memory.db` 里已有的命名空间只能靠删库或手写 SQL 改。
13. **精确串加成在循环里重算。** `for (const row of rows)` 内部每行都执行 `literalTerms(query)`（4 条正则 `matchAll`）；500 行就是 500 次。`sim` 的加成被 `Math.min(1, …)` 夹住，`terms.length` 为 0 时不会进入该分支。
14. **标签大小写三处不一致。** `memory.search` 过滤时两边 `toLowerCase()`；`dream.normalizeTags` 存的是小写；`lexicon.upsert` 存的是 `tags.map(String)` 原样，而 `lexicon` 工具按 `(row.data?.tags ?? []).includes(String(tag))` 精确比较。同一个词条用大写标签写入后，用小写 `tag` 查不到。
15. **`lexicon` 的 `conv` 过滤打不到 `web`。** `upsert` 把 `conv === 'web'` 存成 origin 的 `conv: null`，而过滤是 `o.conv === conv`；因此 `lexicon({ conv: 'web' })` 必然为空，`platform: 'web'` 也只有调用方显式传过该值才命中（`originOf` 只在 `platform` 非空时写这个键）。
16. **`lexicon` 每次 `upsert` 都会把 `fading` 抹回 `active`**（§4.5 第 5 步），并且 `!confirmed` 时每次都 `note.add` 一条同样的待办——`note.add` 没有去重，连续两次无释义的 `lexicon_learn` 会产生两条 `查一下「…」…` 待办（`dream` 里靠 `seenTerms` 才避免）。
17. **`lexicon` 的读写都封顶 500 条。** `all()` 是 `memory.query({ namespace: 'lexicon', kind: 'term', limit: 500 })`（`created_at ASC`），所以两者只覆盖最老的 500 个词条，新词条查不到；`lexicon.find(term, conv)` 定义了但从未被调用。
18. **`lexicon_learn` 的 `tags` 无类型校验。** schema 写 `array`，但 `upsert` 直接 `tags.map(String)`；调用方传字符串会抛 `TypeError`，被工具层当异常抛出而不是返回 `没记成（缺词）。`。
19. **非 QQ 身份查不到"最近的事"。** `whois.recentEventsFor` 用 `person.data?.qq ?? qq ?? ''` 去和 `event` 块的 `data.people` 比对；`dream` 给非 QQ 档案写的是 `qq: null`，`whois` 的 `qq` 参数也是 `null`，于是比较的键是 `''`，永远命不中。另外它取的是 `slice(-limit)`（`memory.query` 为 `created_at ASC`），即创建时间最晚的 3 条，与相关性无关。
20. **`whois` 的逐句依据查询是 O(claims × 500)。** 每个 claim 的每条 `evidence` 都重新执行一次 `memory.query({ namespace: 'person', kind: 'note', limit: 500 })`（`noteText`），最多 6 条 claim。
21. **`whois` 不注册 `person` 命名空间。** 它只读不写；单独启用 `whois`（不启用 `recall` 或 `dream`）时 `person` 不存在，`findPerson` 的查询会命中 0 行，`subject.test.mjs` 因此要手动 `registerNamespace({ id: 'person' })`。
22. **`recall` 声明了用不上的参数。** 工具的 `parameters` 里有 `about`，但 `execute` 的解构是 `{ kind, query, limit, cursor, tag, conv }`，`about` 从未被读取；`kind` 的 enum 来自 `Object.keys(CATEGORIES)`，所以 `resolve` 是合法值，而 `recall({ kind: 'resolve' })` 的候选为空、只剩未整理队列里的纠正原文。
23. **`forget` 只能删 `event`/`person`/`slang`/`resolve`。** 它固定 `namespace = CATEGORIES[kind] ? kind : 'event'`，删不掉 `lexicon` 词条、`note` 备忘或游标。
24. **单条超预算会长期占窗。** `rollCursor` 的 `items.length > 1` 保证至少留一条；`take()` 又允许第一条超预算。若某条 `tokens > budgetTokens`，它会一直留在窗口里直到有别的块把它挤到"最早"。
25. **`more` 会低估剩余。** `more: candidates.length > picked.length`，而 `picked` 里混了未整理 note；候选多于已给但被 note 顶掉时，`more` 仍然是 `false`。
26. **`memo` 的失败分支实际不可达。** `没写成。` 只在 `add()` 返回 `!ok` 时出现，而 `add()` 仅在 `text.trim()` 为空时失败，`memo` 的 `text` 又是必填；正常调用不会走到。另外 `add()` 把正文 `slice(0, 400)`，超长笔记被静默截断。
27. **`estimateTokens` 只是粗估。** `Math.ceil(cjk / 1.5 + rest / 4)` 与真实分词无关，10k 预算的实际 token 数会随文本类型漂移。
28. **`DEFAULT_DIM = 1024` 是死常量。** `memory/src/index.mjs:17` 定义后从未使用；维度真正来自 `manifest.slots[0].requires.dim`，由插槽管理器校验（`m1-plugins.test.mjs` 用 768/1024 两种供应商验证）。
29. **`search` 的 `conv` 过滤会丢掉无 `data` 的行。** `if (!row.data) return false`：手工写入、没有 `data` 的旧行在按会话过滤时直接消失。
30. **`recall` 每次调用都写库。** `saveCursor(nextCursor)` 无条件执行，即使 `picked` 为空也会 `memory.put` 一次游标行（`updated_at` 变化，`text` 重写）。
31. **`recallable: false` 只挡住了 `memory.search`，没挡住未整理队列。** `pendingNotes` 走的是 `memory.query({ namespace: ns, kind: 'note', limit: 200 })`（`memory/src/index.mjs:224`），那里没有任何 `recallable` 判断；而 `namespaces` 在 `kind` 缺省时就是 `Object.keys(CATEGORIES)`，包含 `resolve`。所以 `remember({ kind: 'resolve' })` 写下的纠正会被 `recall()` 当成未整理碎片返回（`[今天] …` 或 `[未整理 · MM-DD] …`），与 `CATEGORIES` 注释里"不参与 recall 检索"相反；带 `tag` 时队列为空，这个泄露才不发生。

## 7. 测试对照

| 测试文件 | 覆盖的行为 |
|---|---|
| `recall.test.mjs` | `[今天]` 标签、按 `kind` 收窄、游标不重复、token 预算解锁、召回后权重上升、未消化/已消化 note 的区分、`forget` 只删一条 |
| `archive-fallback.test.mjs` | 有 `raw` 来源时附 `原文（…）`；两个负向断言是空转的（见 §6.1） |
| `dsh-raw.test.mjs` | `dsh-raw` 注册为原文来源、`recall` 从 DSH 日志补一句原文 |
| `eager-recall.test.mjs` | `你可能记得` + `仅供参考`、阈值过滤、条数/字数上限、停用后不再注入、投递队列保持为空 |
| `note.test.mjs` / `note-updates.test.mjs` | 备忘可写/可列/可关、世界状态 `还有 N 件事没了结。`、备忘不是记忆、追加不改状态、`done` 后 `all+done` 可见、默认只看今天 |
| `lexicon.test.mjs` / `lexicon-dream.test.mjs` | 无释义进待办、补上释义后转 `confirmed` 且不重复提待办、多来源分行、按 `conv`/`platform` 查询、`fading` 老化 |
| `whois-tags.test.mjs` / `subject.test.mjs` / `route-person.test.mjs` / `identity-e2e.test.mjs` | 按 QQ/MC 精确命中、按名字给候选、3 条最近事件、无档案的提示、`tag` 只收窄不打分、`subject` 通用身份、`kind='person'` 直接返回档案并附 `依据`、`remember(subjectKind='mc')` → `people` job 建档 → `whois` 查回 |
| `pending-notes.test.mjs` / `partial-coverage.test.mjs` | 碎片可召回、跨天仍标 `未整理`、只标被引用的 note 为 `consolidated` |
| `consume.test.mjs` / `loop.test.mjs` / `cleanup.test.mjs` / `cleanup-person.test.mjs` | `done` 回收写回词条并归档、无结论不归档、纠正被 `consumed`、疑问被 `resolved`、合并的软删除 `superseded`、`uncertain`、事件块并入人物档案 |
| `origin-tags.test.mjs` | `origin.conv` 过滤、任意命名空间可带标签、`memory.tags` 频次 |
| `m1-plugins.test.mjs` / `surface.test.mjs` / `tool-constraints.test.mjs` | 命名空间隔离、`remember` 无第二份库、插槽形状连线、工具面启停、描述拼装与预算 |
| `vector-backfill.test.mjs` | `missingVectors` 与 `dream` 的 `index` job（补向量、幂等） |
