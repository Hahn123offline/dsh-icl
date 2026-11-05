# 架构

> 读者：第一次接手 ICL 仓库的开发者 / 范围：`packages/core`、`packages/adapters`、`packages/plugins`、`tools` 中实际参与装配与运行的代码，不含 `docs/` / 最后核对：2026-11-03（对照 HEAD `d9b5f84` 之后的代码）

本文是「核心契约与数据形状」的唯一归属地：服务方法签名、装配顺序、预算常量、SQLite 表结构只在这里写一遍。其它文档引用这些事实时只链接到本文对应小节。

> **2026-11-03 晚变更（P0）**：新增 `packages/core/src/dsh-contract.mjs` 与 `packages/dsh-icl/`，这是仓库内唯一的 DSH 接线。`adapter-dsh` 现在也按同一契约补上 `output`。`signals` 删掉未实现的 `to:'focus'` 路由（`focus` 仍是信号字段）；工具注册/注销会触发 `surface.notify()`；prompt/context/raw/slots/surface 的失败经 `core.service-error` 上报。细节见 [CORE-AUDIT.md](CORE-AUDIT.md) 与 [STATUS.md §9](STATUS.md#9-2026-11-03-晚dsh-接线重建p0)。

## 1. 分层

```text
              ┌──────────────────────────────────────────┐
              │ DSH Web / 会话（真正接线的是仓库内 dsh-icl）  │
              └───────────────────┬──────────────────────┘
        DSH 只给两条入口：tools.register / systemPrompt.section
              ┌───────────────────▼──────────────────────┐
              │ 接线  adapter-dsh.mjs(75)                 │
              │       session.mjs(96)                     │
              │       dsh-client.mjs(1008) ← 仓库内无调用方 │
              │       delivery-pump.mjs(56) ← 同上          │
              ├──────────────────────────────────────────┤
              │ 宿主  host.mjs(273)                       │
              │       13 个服务、注册/启停、claimSession    │
              ├──────────────────────────────────────────┤
              │ 服务  services.mjs(655)：8 个工厂           │
              │       model-client(104) signals(132)      │
              │       vision(44)                          │
              ├──────────────────────────────────────────┤
              │ 契约  contracts.mjs(80)：清单校验 + 穿透    │
              ├──────────────────────────────────────────┤
              │ 插件  16 个，只经 ctx 访问核心              │
              └──────────────────────────────────────────┘
```

| 层 | 文件 | 行数 | 职责 |
|---|---|---|---|
| core | `packages/core/src/*.mjs` | 10 个 | 宿主、8 个服务工厂、模型客户端、信号、视觉、清单契约、DSH 契约、DSH 适配器、会话适配器 |
| bridge | `packages/dsh-icl/` | 7 个 `.mjs` | 仓库内唯一的 DSH 接线：工具面、提示词、投递、`session/event`、`agent/pre-step`、单会话、原文来源 |
| adapters | `packages/adapters/*.mjs` | 2 个 / 1064 | DSH Web API 的 Node 客户端（`dsh-client.mjs` 1008 行）与投递泵（`delivery-pump.mjs` 56 行） |
| plugins | `packages/plugins/*/src/index.mjs` | 16 个 / 3766 | 每个插件导出 `apply(ctx)`；`manifest.tools` 声明它占用的工具名 |
| tools | `tools/*.mjs` | 13 个 / 1979 | 评测、回放、验收、运维；不在 `workspaces` 内，不进 `npm test` |
| 合计 | — | 40 个 / 8277 | 行数含空行 |

两件容易看错的事：

- `packages/adapters/` 在仓库内没有调用方。`dsh-client.mjs` 与 `delivery-pump.mjs` 都不被 `packages/` 或 `tools/` 的任何文件 import；唯一使用者在仓库外（`~/.dsh/plugins/icl-live`）。`session.mjs` 同理，除 `tools/time-accept.mjs` 与测试外无调用方。因此这一层在本仓库内没有接线点，正常装配链走不到它。
- `core/src/index.mjs` 只有 9 行，是唯一公共出口，只转出 17 个符号。`createRawSourceRegistry`、`createContextService`、`createToolSurface`、`createPresetService`、`createVisionService`、`composeToolDescription`、`TOOL_TEXT_LIMITS` 必须走深路径 import，测试就是这么做的（见 §8）。

## 2. 一次会话的生命周期

| 步 | 调用 | 同步/异步 | 说明与失败回滚 |
|---|---|---|---|
| 1 | `createHost({ log, now, fetchImpl })` | 同步 | 建 13 个服务；`signals.setDeliver` 在这里接到 `delivery.push`（batchKey `signal:<plugin>:<focus>`） |
| 2 | `registerPlugin(manifest, module, { config })` | 同步 | 校验清单 → 要求 `module.apply` → 查重名。失败抛 `插件清单不合法：<err>` / `<id> 缺少导出的 apply(ctx)` / `插件重复：<id>`。不执行插件代码，无副作用需要回滚 |
| 3 | `enable(id)` | 异步 | 分解见下 |
| 4 | `createSessionAdapter({ sessionId, host, push, toolSink })` | 同步 | 构造时 `host.claimSession(sessionId)`；`sessionId` 或 `push` 缺失直接抛，第二个不同会话抛 `已经指向会话 …` |
| 5 | `attachDshAdapter(host, dsh, { sessionId, order = 30 })` | 同步 | `sync()` 注册工具、订阅 `surface.onChange`、注册 `icl:tools-and-memory` 提示词段 |
| 6 | 每轮三次装配 | 混合 | `systemPrompt()` 同步；`turn()`、`drainOnce()` 异步 |
| 7 | `disable(id)` | 同步 | 逆序调用注销器，单个抛错被吞；`enabled = false`；`surface.notify()` |

`enable` 的六步与回滚点：

1. 已启用 → 直接 `{ enabled: true, already: true }`，无副作用。
2. 检查 `manifest.requires.plugins` 全部已启用；否则抛 `${id} 需要先启用插件：${dep}`，状态未变。只查启用顺序，不自动启用，`disable` 也不检查反向依赖、不级联。
3. `record.enabled = true` → `surface.notify()`。此刻 `apply` 还没跑，已挂上的适配器会 sync 到空工具集；第 6 步的 notify 会再补一次。
4. 逐个 `slots.declare(manifest.slots)`（插槽由宿主代注册，插件自己不 declare）。抛错 → 逆序执行已登记注销器 → `enabled = false` → `notify()` → 抛出。
5. `await record.apply(ctx)`；返回值是函数则登记为注销器。reject → `enabled = false` → 逆序注销 → 抛出，**此路径不 notify**。
6. 成功 → `surface.notify()` → `log({ msg: 'plugin.enabled', disposers })`。

每轮的三次装配：

- `session.systemPrompt()`（同步）= 核心行 `你正在通过 ICL 运行。当前会话：<id>。` + `现在开着的工具：` 与索引（`tools.index({ defs: surface.list() })`）+ `prompt.assemble({ sessionId })`，三段 `filter(Boolean).join('\n\n')`。注意索引用的是 surface 过滤后的定义，不是全量注册表。
- `adapter.turn(message)`（异步）= `Promise.all([prompt.turnText(...), context.assemble(...)])`，两段 `'\n\n'` 连接。`attachDshAdapter` 只注册第 3 段提示词（`prompt.assemble`）到 DSH，没有核心行、没有工具索引；工具索引只在 `session.systemPrompt()` 这条路径上。
- `session.drainOnce()`（异步）= `delivery.drain('session')` → 逐批 `push(batch.text, { images, channel, batch })` → 成功 `ack`，抛错 `nack` 并 `log({ msg: 'delivery.failed' })`；然后 `signals.emit({ kind: 'event', text: 'turn-end', tags: ['turn-end'] })`；最后 `host.shared.get('compaction')?.maybe({ history })`。

## 3. 服务契约

`host.services` 暴露 13 个服务（`host.mjs:175-183`）。插件拿到的 `ctx` 是子集，且没有 `surface`、`presets`、`delivery.drain`、`tools.list`。

| 服务 | 关键方法 | 不变量或默认值 | 谁在用 |
|---|---|---|---|
| `tools` | `register(def)→off` `list()` `names()` `has(name)` `version()` `index({ maxChars = 1200, defs = null })` | 名字 `/^[a-z][a-z0-9_]*$/`，不允许连字符；重名抛 `工具已存在：<name>`；缺 `execute` 抛；`summary` 截 160；`version` 每次注册/注销 +1 | 10 个插件注册 28 个工具（bili/editor/lexicon/memory/note/recall/time/whois/world-state/dsh-raw）；`session`、`surface.list`、`attachDshAdapter` |
| `prompt` | `section({ name, order = 50, text, when })→off` `names()` `onTurn(fn)→off` `turnText({ sessionId, message, now, maxChars = 800 })` `assemble(ctx)` | 段名 `/^[a-z][a-z0-9:_-]*$/i`；重名抛；`text` 必须是 string 或 function；`assemble` 同步 | world-state（`world`/order 10）、persona（`persona`/order 20）、eager-recall（`onTurn`）、`session`、`attachDshAdapter` |
| `focus` | `enter({ label, owner, reason, ttlMs, pierce, visible })→lease` `current()` `canPierce(fromLabel, { mention })` `list()` | `label` 必填；`ttlMs` 下限 1000ms；无 focus 时 `canPierce` 返回 `{ allowed: true, level: 'always', pattern: '(no-focus)' }` | `enter` 只有 `time`（goal 与 sleep）；`current()` 只有 `session.status()`；`canPierce` 无插件调用（只有测试） |
| `delivery` | `push({ to, channel, source, content, batchKey, exactlyOnce })` `drain(to)` `ack(batchId)` `nack(batchId, error)` `watermarkOf(plugin, activity)` `pendingCount()` `inflightCount()` `droppedCount()` | `maxAttempts = 5`；退避 `attempts <= 1 ? 0 : min(60000, 500 * 2 ** (attempts - 2))`；`exactlyOnce` 且 `seq` 为正才去重 | `session.drainOnce`（唯一 drain）；`host` 的 `signals.setDeliver`；**没有任何插件调用** |
| `slots` | `onChange(fn)` `declare({ id, kind, requires, meta, owner })` `registerProvider({ id, kind, shape, call, meta })` `autoBind()` `bind(id, binding)` `resolve(id)` `require(id)` `call(id, request)` `unmatched()` `providers()` `list()` | 未绑定时 `call` 抛 `code = 'SLOT_UNBOUND'`；`autoBind` 每个插槽只取第一个 kind 相同且 `requires` 逐项相等的 provider；provider 注销会解除指向它的绑定 | memory（`embed-text`）、compaction（`compact-chat`）、dream（`dream-chat`）、model-manager（注册/自动绑定） |
| `model` | `bind(next)` `chat({ messages, maxTokens, timeoutMs, temperature })` `pause(reason)` `resume()` `isPaused()` | 默认超时 120000；`pause` 中止在飞请求，之后的请求抛 `code = 'MODEL_PAUSED'`；401 调一次 `onAuthError` 后重试一次 | model-manager（`bind`/`chat`）；其它经插槽。`ctx.model` 只挂 5 个方法，`current`/`inflightCount`/`chatDetailed`/`chatInner` 只在 `host.services.model` 上 |
| `raw` | `register({ id, search, list })` `ids()` `list({ since, until, limit = 500 })` `search({ query, limit = 2 })` | 顺序问每个来源；单源抛错被吞；结果行补 `source`；结果按 `limit` 截断 | dsh-raw 注册；recall / whois / dream 读 |
| `context` | `provideHistory(fn)` `history({ sessionId, limit = 50 })` `onAssemble({ name, order = 50, apply })` `assemble({ sessionId, message, history, maxChars = 1200 })` `onCompact({ id, compact })` `compactors()` `compact(input)` | `compact` 只调第一个注册者，无实现时返回 `{ ok: false, error: 'no-compactor' }`；`compactors()` 无调用方 | compaction（`onCompact` + `onAssemble`）、`attachDshAdapter.turn`、`session.drainOnce` |
| `surface` | `owners()` `list({ preset })` `names(opts)` `summary()` `onChange(fn)` `notify()` | 只输出「`manifest.tools` 声明过 + 插件已启用 + 预设允许」的交集；`owners()` 只认 manifest，未声明的工具静默隐形 | `attachDshAdapter.sync`、`session.*`、测试 |
| `presets` | `list()` `active()` `use(id)` `define({ id, label, allow })` `allowed()` | 初始只有 `default`（`allow: null` = 全部）；`use`/`define` 无产品代码调用方，只在测试里用 | `surface` 构造参数、`attachDshAdapter.sync` |
| `signals` | `offer(signal)` `emit(signal)` `on(filter, fn)` `setGate(fn)` `setDeliver(fn)` `kinds()` `routes()` `stats()` `peekGate()` | kind 固定 5 种 `wake/goal/notice/content/event`；路由 2 种 `model/plugin`；同 id 幂等 24h；`emit` 强制 `to = 'plugin'`；过期信号拒绝；blocked/deliver 失败不占 id | `time`（emit/on）、`dream`（on）、`dsh-plugin`（turn-end emit）；`host` 用 `setDeliver` 接 delivery |
| `vision` | `describe({ path, image, prompt, system, config, maxTokens = 700, timeoutMs = 120000 })` | 默认 base `http://127.0.0.1:8088/v1`、默认模型 `coder390-27b-q3-df2-4x500`，都被 `ICL_VISION_BASE` / `ICL_VISION_MODEL` 覆盖；必须给 `path` 或 `image` | 只有 `bili`（`describeSheet`）。旧技术说明未收录此服务 |
| `clock` | `set(fn)→恢复函数` `reset()` `owns()` | 覆盖 `host` 里的 `now()`；`now()` 有 `Number(value) || systemNow()` 兜底，非数字返回值被忽略 | 只有 `time`。旧技术说明未收录此服务 |

`ctx.services` 是另一套东西：`provide/get/require/list` 走 `host.shared`（插件间能力表），不包含上面 13 个服务。所以 `time` 里 `ctx.services.require('signals')` 的兜底分支必然抛错——`signals` 不是 `shared` 里的能力。

## 4. 装配顺序与预算

五个装配面，排序规则与预算各不相同：

| 装配面 | 排序 | 分隔 | 预算 | 超预算行为 |
|---|---|---|---|---|
| 提示词段 `prompt.assemble` | `order` 升序，同 order 按 `name.localeCompare`；`when(ctx)` 返回假值则跳过 | `'\n\n'` | **无**（不截断） | 无 |
| 上下文策略 `context.assemble` | 同上 | `'\n'` | 1200 | `slice(0, maxChars - 1).trimEnd() + '…'` |
| 每轮提供者 `prompt.turnText` | 注册顺序（数组，不排序） | `'\n'` | 800 | 同上 |
| 工具索引 `tools.index` | `name.localeCompare` | `'\n'` | 1200 | 逐行累加到 `used + row.length + 1 > maxChars` 为止，再追加 `…（还有 N 个工具）` |
| 工具描述 `composeToolDescription` | 固定 head → Use when → Avoid when → Safety | 空格，要点间 `'; '` | 900 | 先 `pop()` 尾部要点，仍超则硬截 |

两种顺序要分清：`tools.list()` 与 `surface.list()` 保持注册顺序（`Map` 插入序），只有 `tools.index()` 按字母序；所以模型看到的索引顺序、和适配器注册工具的顺序不是同一个。

常量表（全部是代码里的实际值）：

| 常量 | 值 | 位置 |
|---|---|---|
| `TOOL_TEXT_LIMITS.perTool` | 900 | `services.mjs:17` |
| `TOOL_TEXT_LIMITS.index` | 1200 | `services.mjs:17` |
| 索引行的 `summary` | 160 | `services.mjs:258,274` |
| `prompt.turnText` 默认 `maxChars` | 800 | `services.mjs:345` |
| `context.assemble` 默认 `maxChars` | 1200 | `services.mjs:118` |
| `delivery` `maxAttempts` | 5 | `services.mjs:436` |
| `delivery` 退避 | `min(60000, 500 * 2 ** (attempts - 2))`，首次 0 | `services.mjs:445` |
| `focus` `ttlMs` 下限 | 1000 | `services.mjs:399` |
| `model` 默认 `timeoutMs` | 120000 | `model-client.mjs:26` |
| `session.start` 间隔 / 下限 | 1000 / 200 | `session.mjs:76-78` |
| `delivery-pump` 间隔 / 下限 | 1500 / 500 | `delivery-pump.mjs:46` |
| `signals` 幂等窗口 | 86400000（24h） | `signals.mjs:59` |
| `context.history` 默认 `limit` | 50 | `services.mjs:107` |
| `raw.list` 默认 `limit` | 500 | `services.mjs:60` |
| `raw.search` 默认 `limit` | 2 | `services.mjs:73` |
| `eager-recall` 每轮 `maxChars` 默认 | 200 | `eager-recall/src/index.mjs:17` |
| `memory.search` 取样窗口 | 每命名空间 500 行 | `memory/src/index.mjs`（`LIMIT 500`） |

冲突时谁赢：

- 同名不覆盖：工具、提示词段、插槽、预设都是重名直接抛。装配面里没有「后者覆盖前者」。
- 预算嵌套：提供者先用自己的上限截断（eager-recall 200），核心再用 800 截；先注册的提供者先占预算，后面的可能整段被截掉。
- `compaction` 的摘要是单段，上限 1200，等于 `context.assemble` 的整个预算——一条摘要就能吃满这一轮，排在它后面的策略会整体被截掉。
- 900 与 1200 不重叠：索引只用 `summary`（≤160），描述 900 不进索引。
- 索引尾部 `…（还有 N 个工具）` 在预算检查之后拼接，总长可以超过 1200。
- 所有 `maxChars` 都是默认参数，不是硬上限：调用方传值优先。

## 5. 数据形状

### 5.1 SQLite（`<root>/state/memory.db`，`node:sqlite` 的 `DatabaseSync`）

| 表 | 列 | 索引 |
|---|---|---|
| `mem_ns` | `id TEXT PRIMARY KEY`、`label TEXT NOT NULL`、`recallable INTEGER DEFAULT 1`、`half_life_days REAL DEFAULT 30`、`retention TEXT`、`schema_version INTEGER DEFAULT 1`、`owner TEXT`、`created_at INTEGER NOT NULL` | 无 |
| `mem_items` | `id INTEGER PRIMARY KEY`、`namespace TEXT NOT NULL`、`kind TEXT NOT NULL`、`key TEXT`、`text TEXT NOT NULL`、`data TEXT`(JSON)、`weight REAL DEFAULT 1`、`recall_count INTEGER DEFAULT 0`、`last_recalled_at INTEGER`、`created_at INTEGER NOT NULL`、`updated_at INTEGER NOT NULL` | `ux_mem_key` UNIQUE `(namespace, key) WHERE key IS NOT NULL`；`ix_mem_ns` `(namespace, created_at)` |
| `mem_vec` | `item_id INTEGER PRIMARY KEY`、`dim INTEGER NOT NULL`、`vec BLOB NOT NULL`（`Float32Array` 字节视图） | 无 |

`key` 允许为 `NULL`（`note` 插件的备忘全走这条），所以同一命名空间可以有大量无 key 行。`memory.put` 走 `(namespace, key)` 唯一索引 upsert，更新分支不改 `created_at`。库路径默认 `<root>/state/memory.db`，可用 `ctx.config.path` 覆盖。

### 5.2 命名空间（11 个）

| id | halfLifeDays | recallable | 用途 / 注册者 |
|---|---|---|---|
| `event` | 30 | true | 事件块与碎片，`recall`（`CATEGORIES`） |
| `person` | 180 | true | 人物档案，`recall` |
| `slang` | 90 | true | 梗，`recall` |
| `resolve` | 1 | false | 纠正反馈队列，不参与回忆检索，`recall` |
| `recall-cursor` | 30（默认） | false | 回忆游标，`recall` |
| `note` | 30（默认） | false | 待办与疑问，`note` |
| `lexicon` | 180 | true | 词条，`lexicon` |
| `persona` | 30（默认） | false | 人格卡与版本，`persona`（id 可被 `config.namespace` 改） |
| `compaction` | 30（默认） | false | 折叠摘要，`compaction` |
| `dream-run` | 30（默认） | false | 做梦幂等记录，`dream` |
| `day` | 30（默认） | false | 当天原话（`kind: 'log'`，key `day:<YYYY-MM-DD>`），`dream` |

`halfLifeDays` 写「默认」的表示注册时没传，落到 `registerNamespace` 的默认 30。注册是幂等的：已存在直接返回 `{ already: true }`，不更新 `label`/`recallable`/`halfLifeDays`。写入未注册命名空间抛 `命名空间没有注册：<ns>`。

`kind` 出现的取值：`note`、`block`、`term`、`run`、`cursor`、`summary`、`log`、`persona-current`、`persona-version`。

`key` 形态：`evt:<day>:<hash>`、`person:<qq>` 或 `person:<kind>:<value>`、`lexicon:<conv>:<term>`、`cursor:<session>`、`run:<day>:<job>`、`sum:<now>`、`v:<stamp>-<seq>`、`day:<day>`、`note:<now>:<rand5>`；`note` 插件写 `key = null`。

### 5.3 `data` JSON 的关键字段

| 字段 | 出现在 | 含义 |
|---|---|---|
| `consolidated` / `consolidatedAt` | event/person 的 note | 已被整理轮吸收；只有 `!== true` 的 note 进候选 |
| `superseded` / `supersededBy` | block | 软删：被合并掉的块仍在库里，检索时按 `superseded !== true` 过滤 |
| `provisional` | block | 证据不足；event 无有效 evidence 时为 true |
| `uncertain` / `mergedFrom` | block | cleanup 之后可能追加 |
| `evidence` | block | `[{ type: 'note', id }]`，最多 20 条 |
| `body` / `profile` / `narrative` | event / person | 长正文，限额 4000 / 2000 / 4000 |
| `subject` / `qq` / `ids` | person | 通用身份 `{ kind, value }`；`qq` 只在 `kind === 'qq'` 时非空；`ids` 新身份 unshift 在最前 |
| `claims` / `facts` / `aliases` | person | 逐句断言与依据；facts ≤50、aliases ≤10、claims[].text ≤200 |
| `status` | note | `open` → `done`（`memo_commit`）→ `archived`（consume 回收）；`resolved` 由 `note.resolve` 写入 |
| `updates` / `result` / `source` / `doneAt` / `answer` / `resolvedAt` | note | 追加的进展与结论 |
| `about` | note | `{ namespace, key }`，consume 按它决定写回哪个命名空间 |
| `term` / `origins` / `status` / `pending` / `usageState` / `decay` | lexicon | `origins[]` 单条含 `conv/url/meaning/status/usageState/seenAt`；`decay = { weight, lastSeen }` |
| `tags` | 多处 | `dream` 归一化为小写，`lexicon` 存原值（同一标签两种大小写会互不命中）；`memory.search` 过滤时两边 `toLowerCase` |
| `consumed` / `consumedAt` | resolve 的 note | 纠正被消化；**不是** `note` 命名空间的状态 |
| `fromNote` | consume 写回的 note | 来源备忘 id |
| `items` | recall-cursor | `[{ id, tokens }]` |
| `dropped` | compaction summary | 被压掉的条数 |

## 6. 失败语义

| 位置 | 吞掉什么 | 调用方看到什么 |
|---|---|---|
| `prompt.assemble` 每段 `try/catch` | 段求值抛错或 `when()` 抛错 | 段消失，**但记 `core.service-error`**（2026-11-03 晚起） |
| `prompt.turnText` 每个 provider | provider 抛错 | 该段消失，其余照常；总长仍按 800 截，错误上报 |
| `context.assemble` 每个策略 | 策略抛错 | 同上，段间连接符也不留，错误上报 |
| `raw.search` / `raw.list` 单源 | 来源抛错 | 少几行结果，`source` 字段缺失；错误上报，调用方仍无法区分「没查到」和「来源坏了」 |
| `surface.notify()` / `slots.changed()` | 监听器抛错 | 适配器漏一次同步；下一次 notify 才补 |
| `host.disable` | 单个注销器抛错 | 只完成部分卸载，其余继续；插件仍标记为已停用 |
| `enable` 的 apply 失败回滚 | 注销器自身的抛错 | 已注册的东西可能残留，异常照常抛给调用方 |
| `enable` 的 apply 失败路径 | — | **不调用 `surface.notify()`**：适配器保留第 3 步那次空工具面的状态 |
| `delivery.nack` 第 5 次 | 条目 `dropped = true` 后不回队列，`droppedCount += 1` | `push` 早已返回 `{ accepted: true }`；条目消失，水位不推进，之后同一个 `(plugin, activity, seq)` 还能被重新 accept |
| `dsh-raw` 的 zstd 解压 | `catch { return '' }` | 该会话文件解出空串，原文层整条失效，无日志 |
| `session.drainOnce` 的 `push` 失败 | — | 不吞：`nack` + `log({ msg: 'delivery.failed' })`，条目留队退避。这是全仓库唯一有日志的投递失败 |
| `session.drainOnce` 的 compaction | `compaction.maybe` 抛错 | 吞掉，本轮投递结果不受影响 |
| `signals.emit` 单个订阅者 | 订阅者抛错 | 其余订阅者照常，`delivered` 计数少 1 |
| `time` 的状态落盘 | `persist` 抛错 | 不吞：`ctx.log({ level: 'warn', msg: 'time.persist' })` |
| `time` 的 inbox / tick | 处理异常 | 写 `state/inbox-error.json` / `state/tick-error.json`，调用方读 outbox 才看得到 |
| `model.chat` | — | 不吞：错误带 `status`；中止包成 `code = 'MODEL_PAUSED'` 或 `'MODEL_ABORTED'` |

可观测性总账：装配期的 `try/catch` 全是空体（只留中文注释），`prompt.assemble` / `context.assemble` / `raw` 的失败对调用方完全不可见；投递侧只有 `droppedCount()` 一个计数出口。

## 7. 并发与锁

进程内只有四个互斥，全部是内存态：

| 互斥 | 位置 | 行为 |
|---|---|---|
| `claimSession(sessionId)` | `host.mjs:186-192` | 核心只指向一个会话；第二个不同 id 抛 `已经指向会话 <old>，不能再指向 <new>`。返回的释放函数在 `session.dispose()` 里调用；`host.disable` 不释放 |
| `delivery.inflight`（`Map`） | `services.mjs:439` | `drain` 把批次移出队列放进 inflight，只有 `ack`/`nack` 才删；同一批次不会被两个消费者同时拿到 |
| `session.drainOnce` 的 `draining` | `session.mjs:15,44` | 重入直接返回 `{ skipped: 'busy', delivered: 0 }` |
| `delivery-pump` 的 `busy` / `stopped` | `delivery-pump.mjs:14,19` | 重入返回 `{ sent: 0 }`；`stop()` 后 `tick` 永久空转 |

文件级锁：**没有**。全仓库无 flock、lockfile、独占打开，`memory.db` 也没有 WAL 或 `busy_timeout` 的配置。多进程共写时：

- `state/memory.db`：两个进程同时写只能靠 SQLite 自身的文件锁，冲突路径没有配置超时，具体报错未核实。`ux_mem_key` 的唯一索引能挡住重复 key，但 `weight` 的读改写会互相覆盖。
- `state/time.json`：全量 `JSON.stringify` + `writeFileSync`，无临时文件、无 rename。后写者覆盖先写者；读到半截 JSON 时走 `catch` 回落空状态，等于静默丢状态。
- `state/rhythm.json`：只在 `rhythm` **单独**启用（旧配置）时存在；默认 nightly 是 `time.json` 里的每日安排，不再写 `rhythm.json`。两者都无文件锁。
- `state/time.inbox.jsonl`：单进程 `offset` 游标；文件被截断时靠 `text.length < inboxOffset` 归零兜底。

结论：设计前提是「一个会话、一个进程」。多进程共写没有任何保证。

## 8. 扩展点

### 加一个服务要改 5 处

1. `services.mjs` 加一个 `create*Service()` 工厂，注册动作一律返回注销器。
2. `host.mjs` 顶部 import，在 `createHost` 里实例化。
3. `host.mjs` 返回对象的 `services` 加键（13 个服务全从这一处暴露）。
4. `host.mjs` 的 `makeContext` 决定是否、以及以什么形状挂到 `ctx`（`ctx.services.*` 是白名单，不是全量转发）。
5. `core/src/index.mjs` 加 export，或接受「只能深路径 import」——目前有 7 个符号就是这个状态。

### 加一个插件要满足

- 目录 `packages/plugins/<id>/src/index.mjs`，导出 `apply(ctx)`；`name` 不是必需的（宿主只读 `module.apply`）。
- 清单必填：`id`（`/^[a-z][a-z0-9-]*$/`）、`version`、`entry`。`entry` 必填但核心从不读取——导入模块是装配方的事。
- `tools` 必须是字符串数组；`slots` 每项必须有 `id` 与 `kind`；`focus.pierce` 的值必须在 `PIERCE_LEVELS`（`always` / `mention` / `never`）内。
- 工具名必须匹配 `/^[a-z][a-z0-9_]*$/`（不允许连字符），且**必须写进 `manifest.tools`**：`ctx.tools.register` 不校验归属，过滤发生在 `surface.list()`，漏声明会静默隐形而不是报错。
- 依赖只有两种表达：`manifest.requires.plugins`（只做启用顺序检查）与 `ctx.services.require(name)`（运行时取 `shared` 能力）。没有 `inject`。
- 停用靠注销器：宿主按注册逆序调用；`apply` 返回函数也会被登记。

### manifest 校验保留与丢弃

`validateManifest` 不是白名单重建，而是 `{ ...manifest, id, version, entry, tools, slots, focus, requires }`：未知字段被**保留**，只有这 7 个键被规范化（`tools`/`slots` 补默认 `[]`、`focus` 补 `{}`、`requires` 补 `{}`、id/version/entry 转字符串）。核心只读这 7 个键加 `presets`。

所以 `presets` 字段能活过校验，但**仍然无效**，原因不是校验丢弃，而是消费方不读它：

- `surface.list()` 只读预设的 `allow`（`presetDef.allow ?? presetDef.plugins`），从不读 `manifest.presets`。
- 唯一读 `manifest.presets` 的是 `presets.list()[].plugins` 与 `presets.allowed()`，两者都无产品代码调用方。
- `presets.use()` / `define()` 同样无调用方，唯一预设有且只有 `default`；16 个插件无一写 `presets` 字段。
- 同类字段 `manifest.preset`（单数）只被 `surface.summary()` 读取，也没有写入方。

### 其它注册点

| 想扩展什么 | 用哪个入口 | 前提 |
|---|---|---|
| 给模型一个工具 | `ctx.tools.register(def)` | 名字写进 `manifest.tools` |
| 注入系统提示词 | `ctx.prompt.section({ name, order, text, when })` | 段名全局唯一 |
| 每轮临时上下文 | `ctx.prompt.onTurn(fn)` | 返回字符串或 null；核心按注册顺序装配 |
| 改写本轮上下文 | `ctx.services.context.onAssemble({ name, order, apply })` | 共享 1200 预算 |
| 压缩历史 | `ctx.services.context.onCompact({ id, compact })` | 只有第一个注册者生效 |
| 提供原文来源 | `ctx.services.raw.register({ id, search, list })` | `search` 必填；失败被吞 |
| 声明模型需求 | `manifest.slots` + `ctx.slots.call(id, req)` | 由 model-manager 提供并 `autoBind` |
| 给别的插件用 | `ctx.services.provide(name, api)` | 重名抛 `能力重复：<key>` |
