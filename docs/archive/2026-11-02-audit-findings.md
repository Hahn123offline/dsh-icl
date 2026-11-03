# 归档：2026-11-02 四份审计的事实摘要

> **这是冻结的证据，不是当前事实。** 读它的唯一理由是要查"当时到底发现了什么"。
> 当前状态看 [../STATUS.md](../STATUS.md)。
>
> - 来源：`docs/audit/core.md`、`memory-plugins.md`、`dream-and-life.md`、`tooling-and-tests.md`（四份共 130 KB，已删除，内容已压缩到这里）
> - 基线：HEAD `5d8c190` 与当时未提交的工作区改动；测试 146 通过 / 35 文件
> - 整理时的代码已经是 193 通过 / 43 文件，**多数"未修"在 11-02 晚已被修掉**
> - 表里的"状态"列是 11-02 的判断，不要当作现在的结论

---

# ICL 审计事实摘要（供正式文档引用）

> 本文件只压缩四份审计文档里**已经写明**的事实，不新增推断。任何四份文档都没写的点，标「文档未说明」。
> 数字（行数、条数、阈值、预算、时间）一律照抄原文档，不换算、不四舍五入。
> 来源标注缩写：`core.md` = `docs/audit/core.md`；`memory-plugins.md` = `docs/audit/memory-plugins.md`；`dream-and-life.md` = `docs/audit/dream-and-life.md`；`tooling-and-tests.md` = `docs/audit/tooling-and-tests.md`。
> 四份文档共同基线：Node 26 ESM、无构建；`node --test packages/core/test` 实测 `tests 146 / pass 146 / fail 0`，`duration_ms 908`，Node `v26.12.1`；HEAD `5d8c190`，但工作区有未提交改动（`contracts.mjs`、`memory/src/index.mjs`、`recall/src/index.mjs`），审计以工作区实际代码为准（`tooling-and-tests.md`）。
> 严重度列是本摘要按文档所述影响面分的档（文档自身不给等级）；「依据」列只放文档原文事实。

## 0. 规模基线（跑出来的数）

| 项 | 实测值 | 出处 |
|---|---|---|
| `packages/core/src/*` | `index.mjs`、`host.mjs`、`contracts.mjs`、`services.mjs`、`session.mjs`、`adapter-dsh.mjs`、`model-client.mjs` | `core.md` |
| `src/index.mjs` | 8 行，转出 12 个符号 | `core.md` |
| core 测试 | 35 个 `*.test.mjs`，146 条断言 | `core.md`、`tooling-and-tests.md` |
| 插件目录 | `packages/plugins/` 15 个 | `tooling-and-tests.md` |
| 工具总数 | 18 = recall 3 + note 5 + lexicon 2 + editor 3 + bili 4 + world-state 1 | `tooling-and-tests.md` |
| `tools/` 脚本 | 9 个，全部开发者侧，无一被 `packages/` 产品代码 import，无一进 `npm test`（`package.json:10` 只跑 `node --test packages/core/test`） | `tooling-and-tests.md` |
| `docs/*.md` | 11 个（另有 `docs/audit/` 三份同批产物） | `tooling-and-tests.md` |
| 提交 | `git rev-parse --short HEAD` = `5d8c190`；`STATUS.md:6` 写 `fb4fb5e`，落后 7 个提交 | `tooling-and-tests.md` |

---

## 1. 核心服务契约

### 1.1 宿主与公共出口

`createHost({ log = () => {}, now = () => Date.now(), fetchImpl = globalThis.fetch } = {})` 返回 `{ services, registerPlugin, enable, disable, list, has, manifestOf, shared }`；`services` 是 10 键对象，`shared` 是 `Map`（`core.md`）。
10 个服务在 `host.mjs:134` 装配：`tools`、`prompt`、`focus`、`delivery`、`slots`、`model`、`raw`、`context`、`surface`、`presets`（`core.md`）。插件只能通过 `apply(ctx)` 拿到它们的子集（`core.md`）。

`createSessionAdapter({ sessionId, host, push, toolSink = null, now = () => Date.now(), log = () => {} } = {})`：`sessionId` 必填、`push(text, opts)` 必填，否则抛 `sessionId 必填` / `push(text, opts) 必填`；返回 `{ sessionId, toolNames, installTools, systemPrompt, toolDefinitions, drainOnce, start, stop, status }`（`core.md`）。

`attachDshAdapter(host, dsh, { sessionId = null, order = 30 } = {})` 返回 `{ sync, names, turn, dispose }`；`dsh` 只要求 `dsh.tools.register(def) -> disposer`，`dsh.systemPrompt.section({name, order, text}) -> disposer` 是可选链（`adapter-dsh.mjs:44`）（`core.md`）。

`createModelClient({ fetchImpl = globalThis.fetch, now = () => Date.now(), onAuthError = null } = {})` 返回 `{ bind, current, isPaused, pause, resume, inflightCount, chatDetailed, chat, chatInner }`（`core.md`）。
`createFocusService({ now = () => Date.now() } = {})` 返回 `{ enter, current, canPierce, list }`；`createToolRegistry({ onChange = () => {}, stampTime = null } = {})` 返回 `{ register, list, names, has, version, index }`；`createPromptService()` 返回 `{ section, names, onTurn, turnText, assemble }`；`createDeliveryService({ now = () => Date.now(), maxAttempts = 5 } = {})` 返回 `{ push, drain, ack, nack, watermarkOf, pendingCount, inflightCount }`；`createSlotRegistry()` 返回 `{ onChange, declare, registerProvider, autoBind, bind, resolve, require, call, unmatched, providers, list }`（`core.md`）。
`validateManifest(manifest)` 返回 `{ ok: true, manifest }` 或 `{ ok: false, error }`；非对象时 error 为 `清单不是对象`（`core.md`）。
`resolvePierce(rules = {}, fromLabel, { mention = false } = {})` 返回 `{ allowed, level, pattern }`，默认 `level = 'mention'`、`pattern = '(default)'`（`core.md`）。
`PIERCE_LEVELS = Object.freeze(['always', 'mention', 'never'])`（`core.md`）。

### 1.2 `tools`（`services.mjs:245`）

| 方法 | 签名 / 默认值 | 关键不变量与数字 |
|---|---|---|
| `register` | `register(definition) → () => void` | 名字须匹配 `/^[a-z][a-z0-9_]*$/`；重名抛 `工具已存在：${name}`；缺 `execute` 抛 `${name} 缺少 execute`；注销器删条目并触发 `onChange({type:'unregistered'})`（`core.md`） |
| `list` | `list() → object[]` | 存的是**拼装后**的定义：`{ ...definition, name, summary: summary.slice(0,160), description: composeToolDescription(definition) }`（`core.md`） |
| `names` / `has` / `version` | `names() → string[]`、`has(name) → boolean`、`version() → number` | `version` 每次注册/注销 +1（`core.md`） |
| `index` | `index({ maxChars = 1200 } = {}) → string` | 按 `name.localeCompare` 排序，行格式 `- ${name}: ${summary}`；超预算逐行累加到 `used + row.length + 1 > maxChars` 为止，再追加 `\n…（还有 ${rows.length - lines.length} 个工具）`（`core.md`） |

调用者：`ctx.tools.register`（recall / note / whois / world-state / editor / bili / lexicon）；`session.toolNames()`、`session.installTools()`、`session.toolDefinitions()`、`session.systemPrompt()`；`createToolSurface.list()`（`core.md`）。

### 1.3 `prompt`（`services.mjs:309`）

- `section({ name, order = 50, text, when = null }) → () => void`：`name` 须匹配 `/^[a-z][a-z0-9:_-]*$/i`；重名抛 `提示词段已存在：${key}`；`text` 必须是 `string` 或 `function`（`core.md`）。
- `names() → string[]`（`core.md`）。
- `onTurn(provider) → () => void`：`provider({ sessionId, message, now })` 可返回字符串或 Promise（`core.md`）。
- `turnText({ sessionId = null, message = '', now = Date.now(), maxChars = 800 } = {}) → Promise<string>`（`core.md`）。
- `assemble(ctx = {}) → string`（**同步**）：`order` 升序、同 order 按 `name.localeCompare`，段间 `'\n\n'`（`core.md`）。

调用者：`ctx.prompt.section`（world-state `name:'world', order:10`；persona `name:'persona', order:20`）；`ctx.prompt.onTurn`（eager-recall）；`attachDshAdapter` 的 `icl:tools-and-memory` 段与 `turn()`；`session.systemPrompt()`（`core.md`）。

### 1.4 `focus`（`services.mjs:375`）

- `enter({ label, owner = null, reason = '', ttlMs = null, pierce = null, visible = true }) → { id, label, owner, reason, since, expiresAt, pierce, visible, release }`；`label` 空抛 `focus.label 必填`，`id` 形如 `focus-1`，`expiresAt = ttlMs == null ? null : at + Math.max(1000, Number(ttlMs) || 0)`（`core.md`）。
- `current() → lease | null`：最新且 `expiresAt == null || expiresAt > now`（`core.md`）。
- `canPierce(fromLabel, opts = {}) → { allowed, level, pattern }`：无 focus 时直接 `{ allowed: true, level: 'always', pattern: '(no-focus)' }`（`core.md`）。
- `list() → lease[]`（仅未过期的）（`core.md`）。

**当前没有任何插件调用 `ctx.focus`**（`packages/plugins/*` 里零命中）（`core.md`）。

### 1.5 `delivery`（`services.mjs:432`）

- `push({ to = 'session', channel = 'conversation', source = {}, content = {}, batchKey = null, exactlyOnce = true }) → { accepted: true, id } | { accepted: false, deduped: true }`；去重只在 `exactlyOnce` 且 `seq` 是正数时进行（比水位，也比队列/在飞里的同 seq 条目）（`core.md`）。
- `drain(to = null) → batch[]`：把 `nextAt <= now` 的条目按 `${to}|${batchKey}` 合并成批，移出队列放进 `inflight`（`core.md`）。
- `ack(batchId) → { ok: true, count } | { ok: false, reason: 'unknown-batch' }`：只对 `exactlyOnce` 且 `seq` 有限的条目推进 `${plugin}|${activity}` 水位（`core.md`）。
- `nack(batchId, error = null) → { ok: true } | { ok: false, reason: 'unknown-batch' }`：`attempts += 1`；`attempts >= maxAttempts` 时标 `dropped = true` 且不回队列，否则 `nextAt = at + backoff(attempts)`，`backoff = attempts <= 1 ? 0 : min(60_000, 500 * 2 ** (attempts - 2))`（`core.md`）。
- `watermarkOf(plugin, activity) → number`（默认 `0`）、`pendingCount() → number`、`inflightCount() → number`（`core.md`）。

调用者：`ctx.delivery.push`、`session.drainOnce()`（唯一 drain 的消费者），其余是测试；**当前没有任何插件调用 `ctx.delivery`**（`core.md`）。

### 1.6 `slots`（`services.mjs:538`）

- `declare({ id, kind = 'chat', requires = {}, meta = {}, owner = null }) → () => void`：缺 id 抛 `插槽缺少 id`，重名抛 `插槽已存在：${id}`；注销器同时删绑定（`core.md`）。
- `registerProvider({ id, kind = 'chat', shape = {}, call, meta = {} }) → () => void`：缺 `call` 抛 `provider ${id} 缺少 call`（`core.md`）。
- `autoBind() → [{ slot, provider }]`：每个未绑定插槽取**第一个** `kind` 相同且 `requires` 逐项严格相等的 provider（`core.md`）。
- `bind(id, binding) → undefined`：要求插槽存在、`binding.call` 是函数；写入 `{ ...binding, boundAt: Date.now() }`（用的是 `Date.now()`，不是注入的 `now`）（`core.md`）。
- `resolve(id) → binding | null`；`require(id) → binding`（未绑抛 `插槽 ${id} 还没有绑定模型`）；`call(id, request) → Promise<any>`（未绑抛 `code = 'SLOT_UNBOUND'`）（`core.md`）。
- `unmatched() → [{ id, kind, requires }]`、`providers() → [{ id, kind, shape }]`、`list() → (slot & { binding })[]`、`onChange(fn) → off`（`core.md`）。

调用者：memory（`embed-text`）、compaction（`compact-chat`）、dream（`dream-chat`）、model-manager（`registerProvider` / `autoBind` / `onChange`）（`core.md`）。

### 1.7 `model`（`model-client.mjs:9`）

- `bind(next)`、`current() → object | null`、`isPaused() → boolean`、`resume() → { paused: false }`、`inflightCount() → number`（`core.md`）。
- `pause(reason = 'paused by owner') → { paused: true, aborted: number }`：中止所有在飞请求（`core.md`）。
- `chat({ messages = [], maxTokens = null, timeoutMs = 120_000, temperature = undefined }) → Promise<string>`（`core.md`）。
- `chatDetailed(...) → Promise<{ text, reasoning }>`；`chatInner(...)` 同 `chatDetailed`（`core.md`）。

错误语义：模型错误带 `status`；401 会调一次 `onAuthError` 并在其返回新绑定后重试一次；中止被包装成 `code = 'MODEL_PAUSED'` 或 `'MODEL_ABORTED'`（`core.md`）。
调用者：model-manager（`ctx.model.bind`、`ctx.model.chat`）；其余经插槽（`core.md`）。

### 1.8 `raw`（`services.mjs:48`）

- `register({ id, search, list } = {}) → () => void`：缺 id 抛 `raw source 需要 id`，缺 search 抛 `${key} 缺少 search`（`core.md`）。
- `ids() → string[]`；`search({ query, limit = 2 }) → Promise<row[]>`；`list({ since = null, until = null, limit = 500 }) → Promise<row[]>`（`core.md`）。
- 行统一补 `source`：`{ ...row, source: source.id }`；单个来源抛错被吞，结果按 `limit` 截断（`core.md`）。

调用者：dsh-raw（`register`）、whois / recall / dream（`search` / `list` / `ids`）（`core.md`）。

### 1.9 `context`（`services.mjs:97`）

- `provideHistory(fn) → () => void`（非函数抛 `history source 需要一个函数`）；`history({ sessionId = null, limit = 50 }) → Promise<array>`（无来源返回 `[]`）（`core.md`）。
- `onAssemble({ name, order = 50, apply }) → () => void`；`apply({ sessionId, message, history })` 返回字符串或 `null`（`core.md`）。
- `assemble({ sessionId = null, message = '', history = null, maxChars = 1200 }) → Promise<string>`：按 order/name 排序，段间 `'\n'`（`core.md`）。
- `onCompact({ id, compact }) → () => void`；`compactors() → string[]`；`compact(input) → Promise<any>`，无实现时返回 `{ ok: false, error: 'no-compactor' }`，只调**第一个**注册的（`core.md`）。

调用者：compaction（`onCompact` / `onAssemble`）、`attachDshAdapter.turn()`、测试（`core.md`）。

### 1.10 `surface`（`services.mjs:156`）

- `owners() → Map<toolName, pluginId>`（**只**来自 `manifest.tools`）（`core.md`）。
- `list({ preset = null } = {}) → { ...definition, plugin }[]`：过滤条件 = 属于已启用插件 + 在当前预设允许集合内（`core.md`）。
- `names(options = {}) → string[]`、`summary() → [{ plugin, preset, tools }]`、`onChange(fn) → off`、`notify() → void`（`core.md`）。

调用者：`attachDshAdapter.sync()`、测试（`core.md`）。

### 1.11 `presets`（`services.mjs:207`）

- `list() → { id, label, allow, plugins }[]`（`plugins` 对 `allow === null` 的预设是 `null`）（`core.md`）。
- `active() → string`（初始 `'default'`）、`use(id) → { active }`（未知抛 `没有这个预设：${id}`）、`define({ id, label = null, allow = null }) → { id }`（缺 id 抛 `预设需要 id`）、`allowed() → string[] | null`（`core.md`）。

调用者：`surface` 构造参数、`adapter-dsh.sync()`、测试（`core.md`）。

### 1.12 宿主方法与注销语义

| 方法 | 返回 | 抛错/备注 |
|---|---|---|
| `registerPlugin(manifestInput, module, { config = {} } = {})` | 校验后的 `manifest` | 清单不合法抛 `插件清单不合法：${error}`；缺 `apply` 抛 `${id} 缺少导出的 apply(ctx)`；重名抛 `插件重复：${id}`（`core.md`） |
| `enable(id)`（async） | `{ enabled: true }` 或 `{ enabled: true, already: true }` | 未知 id 抛 `没有这个插件：${id}`；依赖未启用抛 `${id} 需要先启用插件：${dep}`（`core.md`） |
| `disable(id)` | `{ enabled: false }` 或 `{ enabled: false, already: true }` | 逆序调用注销器，单个抛错被吞（`core.md`） |
| `list()` | `{ id, version, enabled, tools, slots: string[] }[]` | `slots` 是 id 数组（`core.md`） |
| `has(id)` / `manifestOf(id)` | `boolean` / `manifest \| null` | —（`core.md`） |
| `shared` | `Map<string, any>` | 实际可 `get`/`set`（`core.md`） |

- 同步 `apply` 返回 disposer 会被登记：`host.mjs:174-175` `const extra = await record.apply(ctx); if (typeof extra === 'function') record.dispose.push(extra)`；返回 `undefined` 也收（`core.md`）。
- `ctx` 上每个注册动作都返回自己的注销器，宿主同时推进 `record.dispose`（`host.mjs:41-119`）；`ctx.onDispose(fn)` 可直接追加（`core.md`）。
- `enable` 失败时把已登记的一律逆序撤销、`enabled = false`、再抛出（`host.mjs:176-182`）；清单里声明的 slots 注册失败走同一套回滚（`host.mjs:165-172`）（`core.md`）。
- `disable` 逆序调用，单个抛错只被 `try/catch` 吞掉，不影响其余（`host.mjs:192`）（`core.md`）。

### 1.13 依赖与「inject」

核心**没有** `inject` 这个字段或函数（全仓库仅历史文档 `docs/AUDIT.md:44` 提到旧插件名 `*-inject`）。依赖只有两种表达：`manifest.requires.plugins`（启用顺序检查）与 `ctx.services.require(name)`（运行时取共享能力）（`core.md`）。
`enable` 只检查 `requires.plugins` 里每个插件**当前已启用**；`disable` 不检查反向依赖、不级联（`core.md`）。
`ctx.services.provide(name, api)` 重名抛 `能力重复：${key}`，注销器是 `shared.delete(key)`；`get` 返回引用本身，`require` 缺失抛 `缺少依赖能力：${name}`；插件停用后别处已持有的引用仍然可用（实测）（`core.md`）。

### 1.14 清单校验（`contracts.mjs:13`）

必填 `id`（`/^[a-z][a-z0-9-]*$/`）、`version`、`entry`；`tools` 必须是字符串数组；`slots` 每项必须有 `id` 与 `kind`；`focus.pierce` 的值必须在 `PIERCE_LEVELS` 内。校验通过后**重建**清单，只保留 `id`、`version`、`entry`、`tools`（默认 `[]`）、`slots`（默认 `[]`）、`focus`（默认 `{}`）、`requires`（默认 `{}`），其它字段丢弃（实测）（`core.md`）。

### 1.15 顺序规则与同步/异步边界

- 提示词段：`order` 升序，同 order 按 `name.localeCompare`；`when(ctx)` 返回假值则跳过；段间 `'\n\n'`（`core.md`）。
- 上下文策略：同上（order → name），段间 `'\n'`，预算 1200（`core.md`）。
- 每轮提供者：**按注册顺序**（数组），不排序，段间 `'\n'`，预算 800（`core.md`）。
- 工具索引：`name.localeCompare`；注销：严格逆序；事件：`surface.onChange` 与 `slots.onChange` 的监听器按 Set 插入顺序调用，无优先级（`core.md`）。
- 同步：`prompt.assemble`、`context`/`raw` 的注册、`surface.list`、`tools.list`/`index`、`slots.resolve`、`presets.*`、`session.systemPrompt`、`session.toolDefinitions`、`adapter.names`/`sync`（`core.md`）。
- 异步：`host.enable`、`prompt.turnText`、`context.assemble`/`compact`、`raw.search`/`list`、`slots.call`、`model.chat*`、`session.drainOnce`、`adapter.turn`（`core.md`）。
- 工具 `execute` 核心不强制异步（`tools.register` 只检查 `typeof === 'function'`），但测试里全部是 `async`（`core.md`）。

### 1.16 装配期错误处理

- 注册期（清单、重名、缺字段、非法名字）**立即抛**，不留半套（`core.md`）。
- 装配期一律「单条失败不影响整体」：`prompt.assemble`、`prompt.turnText`、`context.assemble`、`raw.search`、`raw.list`、`surface.notify`、`slots.onChange` 的每个回调都包在 `try/catch` 里，抛错被静默跳过（连日志都没有）（`core.md`）。
- 投递失败不丢：`session.drainOnce()` 捕获 `push` 抛错 → `nack`，条目留队列退避（`core.md`）。

### 1.17 预算常量表（原文数字）

| 常量/位置 | 值 | 作用 |
|---|---|---|
| `TOOL_TEXT_LIMITS.perTool` | `900` | 单个工具描述上限 |
| `TOOL_TEXT_LIMITS.index` | `1200` | 工具索引上限 |
| `tools.register` 的 `summary` | `160` | 索引行用的首句上限 |
| `prompt.turnText` 的 `maxChars` | `800` | 每轮上下文默认预算 |
| `context.assemble` 的 `maxChars` | `1200` | 装配预算 |
| 截断后缀 | `'…'` | 三处截断共用 |
| `delivery` 的 `maxAttempts` | `5` | 超过即丢 |
| `delivery` 退避 | `attempts <= 1 ? 0 : min(60_000, 500 * 2 ** (attempts - 2))` | 毫秒 |
| `focus` 的 `ttlMs` 下限 | `1000` | 毫秒 |
| `model` 默认 `timeoutMs` | `120_000` | 单次请求 |
| `session.start` 间隔 | `1000`（下限 `200`） | 毫秒，`unref()` |

（以上整表 `core.md`）

### 1.18 工具描述如何拼装（`composeToolDescription`）

0. 索引用的 `summary` 在注册时先算：`String(definition.summary ?? definition.description ?? '').trim().split(/(?<=[.!?])\s/)[0]`，再 `.slice(0, 160)`；描述拼装用的是**原始** `definition.summary`，不是这个截断值（`core.md`）。
1. `head = [summary, description].map(trim).filter(Boolean).join(' ')`（`core.md`）。
2. 三段可选要点，顺序固定 `Use when` → `Avoid when` → `Safety`，格式 `${label}: ${items.join('; ')}.`（`core.md`）。
3. `text = [head, ...bullets].filter(Boolean).join(' ')`（`core.md`）。
4. 超 `maxChars`（默认 `900`）：先 `pop()` 尾部要点行，仍超就 `slice(0, Math.max(40, maxChars - 1)).trimEnd() + '…'`（`core.md`）。

实测输出（`tool-constraints.test.mjs:19-30` 断言的那串）：
`"Look up a person. Use when: someone mentions them; you need their account ids. Avoid when: when you only want an event."`（`core.md`）

### 1.19 `session` 的三段系统提示词（`session.mjs:31-36`）

顺序固定三段，`filter(Boolean).join('\n\n')`（`core.md`）：
1. 核心行：`你正在通过 ICL 运行。当前会话：${sessionId}。`
2. 有工具时：`现在开着的工具：\n${index}`
3. `host.services.prompt.assemble({ sessionId, ...ctx })` 的结果（各段再按 §1.15 排序、`'\n\n'` 连接）

实测（world order 10、persona order 20）：

```text
你正在通过 ICL 运行。当前会话：s-1。

现在开着的工具：
- wt: world status

现在是 10:00。

我是大肥鱼
```

`attachDshAdapter` 走的是**另一条**路径：向 DSH 注册 `{ name: 'icl:tools-and-memory', order, text: () => host.services.prompt.assemble({ sessionId }) }`（`adapter-dsh.mjs:44-48`），即只有第 3 段，没有核心行、也没有工具索引（`core.md`）。
`adapter.turn(message)`：`Promise.all([prompt.turnText({sessionId, message}), context.assemble({sessionId, message})])`，两段 `filter(Boolean).join('\n\n')`（`core.md`）。

### 1.20 模型实际看到什么

`adapter-dsh.mjs:30-35` 只传四个字段：`name`、`description`（拼装后的）、`parameters`、`execute`；`summary`/`when`/`avoid`/`safety` 不进 DSH，只用来生成 `description`（`core.md`）。
核心**不生成**也不改写工具结果：`attachDshAdapter` 把 `def.execute` 原样转给 DSH，`session.toolDefinitions()` 返回同一个函数（`core.md`）。实际文本全部由插件写死，例如 note 的 `记下了。`、`没有待办。`、`待办 ${open} 条，已完成待回收 ${done} 条，已归档 ${archived} 条。`，whois 的 `还没有这个人的档案。`，recall 的 `[今天] ` 前缀行（`core.md`）。

---

## 2. 数据形状

### 2.1 SQLite 结构（`memory/src/index.mjs:23-54`）

- `mem_ns(id TEXT PRIMARY KEY, label TEXT, recallable INTEGER DEFAULT 1, half_life_days REAL DEFAULT 30, retention TEXT, schema_version INTEGER DEFAULT 1, owner TEXT, created_at INTEGER)`（`memory-plugins.md`）。
- `mem_items(id INTEGER PRIMARY KEY, namespace TEXT, kind TEXT, key TEXT, text TEXT NOT NULL, data TEXT, weight REAL DEFAULT 1, recall_count INTEGER DEFAULT 0, last_recalled_at INTEGER, created_at INTEGER, updated_at INTEGER)`（`memory-plugins.md`）。
- 唯一索引 `ux_mem_key ON mem_items(namespace, key) WHERE key IS NOT NULL`；普通索引 `ix_mem_ns(namespace, created_at)`；向量表 `mem_vec(item_id INTEGER PRIMARY KEY, dim INTEGER, vec BLOB)`，`vec` 是 `Float32Array` 的字节视图（`memory-plugins.md`）。
- `key` 允许为 `NULL`：`note` 插件的备忘全部走这条，所以同一命名空间可以有大量无 key 行（`memory-plugins.md`）。
- 库路径：默认 `<root>/state/memory.db`，可用 `ctx.config.path` 覆盖（`memory-plugins.md`）。

### 2.2 命名空间（全部 8 个）

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

（整表 `memory-plugins.md`）
`registerNamespace` 幂等：已存在时直接返回 `{ id, already: true, label, recallable }`，**不更新** `halfLifeDays`/`label`/`recallable`；写入未注册命名空间会抛 `命名空间没有注册：<ns>`（`memory-plugins.md`）。

### 2.3 条目 kind 与 key 格式

`kind` 取值：`note`（未沉淀的原话/碎片）、`block`（沉淀后的块）、`term`（词条）、`cursor`（回忆游标）、`run`（做梦幂等记录）（`memory-plugins.md`）。

| 写入方 | namespace | kind | key |
|---|---|---|---|
| `remember`（默认） | `event` | `note` | `note:<now>:<Math.random().toString(36).slice(2,7)>` |
| `remember`（带 `key`） | 目标命名空间 | `note` | 调用方给的任意串 |
| `dream` 的 `events` job | `event` | `block` | `evt:<YYYY-MM-DD>:<hash(summary)>`（`hash` = `h = h*31 + charCode >>> 0` 后 `toString(36)`） |
| `dream` 的 `slang` job | `slang` | `block` | `slang:<term>` |
| `dream` 的 `people` job | `person` | `block` | `person:<qq>`；非 QQ 身份为 `person:<kind>:<value>` |
| `dream` 的 `wash`/`consume` job | `event` / `person` | `note` | `null`（每次新建） |
| `recall` 游标 | `recall-cursor` | `cursor` | `cursor:<sessionId>`（缺省 `default`） |
| `lexicon.upsert` | `lexicon` | `term` | `lexicon:<conv>:<term>`，`conv` 缺省 `web` |
| `dream` 幂等 | `dream-run` | `run` | `run:<day>:<job>` |
| `note.add` | `note` | `note` | `null` |

（整表 `memory-plugins.md`；`hash` 定义亦见 `dream-and-life.md`：`h*31+charCode` 的 base36）
主会话 note（`recall` 写）`weight:1.5`，`data` 含 `{day, session, subject?, qq?, about?, origin?}`（`dream-and-life.md`，`recall:115-133`）。

### 2.4 `data` 载荷

主会话 note（`remember` 写入 `event`/`person`/`slang`/`resolve`）（`memory-plugins.md`）：

```
{ day: 'YYYY-MM-DD', session: '<sessionId>',
  subject?: { kind, value }, qq?: '<value>', about?: object, origin?: object }
```

`dream` 之后追加 `consolidated: true` 与 `consolidatedAt`；`wash` 另写 `{ day, washed: true, subject?: { kind: 'name', value }, origin?: { conv }, at? }`；`consume` 回收的笔记写 `{ consolidated: false, fromNote: <note id> }`（`memory-plugins.md`）。

`note` 命名空间的备忘（`note.add`）（`memory-plugins.md`）：

```
{ status: 'open', raisedBy: 'session' | 'lexicon' | 'events' | 'people' | 'cleanup' | 'dream',
  kind: 'memo' | 'question', about: object | null, createdAt }
```

后续可能追加：`updates: [{ text, at }]`、`result`、`source`、`doneAt`、`consumedAt`、`answer`、`resolvedAt`（`memory-plugins.md`）。

`event` 块（实测）：

```json
{"key":"evt:2026-11-02:15l8pga","text":"刷到盲人导航视频",
 "data":{"body":"下午刷到一个讲盲人导航的视频。","evidence":[{"type":"note","id":1}],
 "provisional":false,"day":"2026-11-02","people":[],"tags":["视频","ai"],"sources":[]}}
```

字段集合：`{ body, evidence: [{ type: 'note', id }], provisional: bool, day, people: [String], tags: [String], sources: [String], mergedFrom?: [key], uncertain?: bool, superseded?: true, supersededBy?: key }`；`text` ≤200、`body` ≤4000、`tags` 过 `normalizeTags`、`provisional` = 无有效 evidence；`cleanup` 之后可能多出 `uncertain`、`mergedFrom`、`superseded`、`supersededBy`（`memory-plugins.md`、`dream-and-life.md`）。

`person` 块（实测）：

```json
{"key":"person:42","text":"小林，我的同事，平时爱抽烟。","data":{"subject":{"kind":"qq","value":"42"},"qq":"42",
 "ids":[{"kind":"qq","value":"42"}],"familiarity":"coworker","provisional":true,"evidence":[{"type":"note","id":3}],
 "claims":[{"text":"小林是同事","evidence":[{"type":"note","id":3}]}],"profile":"小林，我的同事，平时爱抽烟。",
 "narrative":"","facts":[],"aliases":[],"sources":["note:1793628200000:abcde"],"rewrittenAt":1793630400000}}
```

`subject` 是通用身份；`qq` 只在 `kind === 'qq'` 时有值；`ids` 新身份 unshift 在最前、不覆盖旧的；`profile` 与 `text` 同内容但限额不同（`2000`/`800`）（`dream-and-life.md`）。
`findPerson` 按 `ids`/`subject`/`key`/`qq` 精确匹配（`packages/plugins/memory/src/index.mjs:356-378`）（`dream-and-life.md`）。

`slang` 块：`{ term, meaning, usage, examples: [], sources: [key] }`（`memory-plugins.md`）。

`lexicon` 词条（实测）：

```json
{"key":"lexicon:web:难绷","text":"难绷：（意思还不确定）","data":{"term":"难绷",
 "origins":[{"status":"candidate","seenAt":1793630400000}],"tags":["待查"],"usage":"","status":"candidate",
 "pending":true,"usageState":"active","decay":{"weight":1,"lastSeen":1793630400000},"evidence":[]}}
```

`key = lexicon:<conv>:<term>`（`conv` 默认 `web`）；单 origin 为 `{ conv?, platform?, url?, note?, meaning?, status: 'candidate'|'confirmed', usageState?, seenAt }`，空字段直接不写；末尾必带 `seenAt`；`status = meaning ? 'confirmed' : 'candidate'`；同一 `(conv,url)` 的 origin 合并而非追加；汇总规则：任一 origin confirmed → `status:'confirmed'`，`pending = !confirmed && !meaning`，有 active origin → `usageState:'active'`，否则 `'fading'`（`memory-plugins.md`、`dream-and-life.md`）。

`recall-cursor`：`{ items: [{ id: number, tokens: number }] }`，行 `text` 为 `${n} 块在窗口内`（`memory-plugins.md`）。

### 2.5 向量维度

- `manifest.slots[0]` 声明 `{ "id": "embed-text", "kind": "embedding", "requires": { "dim": 1024 } }`；插槽没接上时 `embed()` 返回 `null`，检索退化成字面/二元组匹配，不报错（`memory-plugins.md`）。
- `DEFAULT_DIM = 1024` 是死常量（`memory/src/index.mjs:17` 定义后从未使用）；维度真正来自 `manifest.slots[0].requires.dim`，由插槽管理器校验（`m1-plugins.test.mjs` 用 768/1024 两种供应商验证）（`memory-plugins.md`）。
- 向量行落在 `mem_vec(item_id, dim, vec BLOB)`，`vec` 是 `Float32Array` 的字节视图（`memory-plugins.md`）。
- embedding provider `POST <baseUrl>/embeddings`，body `{model, input}`，`AbortSignal.timeout(timeoutMs || 20000)`，返回 `data.data[].embedding`（`dream-and-life.md`）。

### 2.6 层间流动的其它形状（`core.md` §5）

```js
// 插件交给 core 的工具定义（whois 为例，world-state 还带 description）
{ name, summary?, description?, when?: string[]|string, avoid?: ..., safety?: ...,
  parameters: JSONSchema, execute(input) -> { text: string, ... } | any }

// tools 存下来的（services.mjs:267-272）：summary 被切成首句并封顶 160，description 被重写
{ ...definition, name, summary: summary.slice(0, 160), description: composeToolDescription(definition) }

// 提示词段
{ name, order: number, text: string | ((ctx) => string), when: ((ctx) => boolean) | null }

// 上下文策略 / 压缩器
{ name, order: number, apply: ({ sessionId, message, history }) => string | null | Promise<string | null> }
{ id, compact: (input) => any }

// 插槽声明 / 供应商 / 绑定
{ id, kind: 'chat'|'embedding'|..., requires: { dim: 1024 }, meta: {}, owner }
{ id, kind, shape: { dim: 1024 }, call: (req) => any, meta: {} }
{ provider, call, kind }                    // autoBind 产生
{ provider, call, ..., boundAt }            // bind() 产生，boundAt 用 Date.now()

// 投递条目 / 批次 / push 结果
{ id: 'd-1', to, channel, source: { plugin, activity, seq|null }, content: { text, images: [] },
  batchKey, exactlyOnce: boolean, attempts: number, nextAt: number, lastError?, dropped? }
{ id: 'b-2', key: 'session|qq:a:conversation', to, channel,
  entries: [{ source, content }], text: '各条 content.text 过滤空值后以 \n 连接', images: [...] }
{ accepted: true, id } | { accepted: false, deduped: true }

// 原文来源与行
{ id, search: async ({ query, limit }) => row[], list: async ({ since, until, limit }) => row[] }
{ ...row, source: 'dsh-sessions' }          // 行至少有 text；dsh-raw 还有 time

// 预设
{ id, label, allow: string[] | null }        // define 入参
{ id, label, allow, plugins: string[] | null } // list 产出

// focus 租约
{ id: 'focus-1', label, owner, reason, since, expiresAt, pierce: {}, visible: true, release() }

// 校验后的清单
{ id, version, entry, tools: string[], slots: [{ id, kind, requires }], focus, requires: { plugins?: string[] } }

// session.status()
{ sessionId, now, focus: { label, owner, since, expiresAt } | null, tools: string[], pending, plugins: [...] }
```

`ctx` 本身的形状（`host.mjs:33-131`）固定为 `{ id, manifest, log, now, onDispose, tools, prompt, focus, delivery, slots, services: { raw, context, provide, get, require, list }, model, config, fetch }`（`core.md`）。

---

## 3. 插件逐条

### 3.0 工具面总表（11 个记忆侧工具 + 其余）

| 插件 | `manifest.tools` | 实际 `ctx.tools.register` | 提供 service | `requires.plugins` |
|---|---|---|---|---|
| `memory` | `[]` | 无 | `memory` | 无 |
| `recall` | `remember`, `recall`, `forget` | 3 个 | `recall` | `memory` |
| `note` | `memo`, `memos`, `memo_append`, `memo_commit`, `note_status` | 5 个 | `note` | `memory` |
| `lexicon` | `lexicon`, `lexicon_learn` | 2 个 | `lexicon` | `memory` |
| `whois` | `whois` | 1 个 | 无 | `memory` |
| `eager-recall` | `[]` | 无（注册的是 `ctx.prompt.onTurn`） | 无 | `memory` |

（整表 `memory-plugins.md`）全部 11 个工具名：`remember`、`recall`、`forget`、`memo`、`memos`、`memo_append`、`memo_commit`、`note_status`、`lexicon`、`lexicon_learn`、`whois`（`memory-plugins.md`）。

注册时的统一处理（`services.mjs:245-272`）：`summary` 截到第一个句号为止再切 160 字符；最终 `description` 是 `composeToolDescription(definition)` 的结果，即 `summary + ' ' + description + ' Use when: … . Avoid when: … . Safety: … .`（有哪个拼哪个，超 `TOOL_TEXT_LIMITS.perTool = 900` 先砍 `when`/`avoid` 行再截正文）（`memory-plugins.md`）。
若设 `ICL_TOOL_TIME=1`，每个工具返回的 `text` 末尾追加 `\n（现在 HH:MM:SS ）`（注意 `）` 前有一个空格）；此条在 `core.md` 中被记为「死代码（已于 5d8c190 修复，保留为历史记录）」，在 `tooling-and-tests.md` 中被记为「现在是真的，`host.mjs:13` 传 `stampTime`、`services.mjs:270` `execute: stamped`」——两文档冲突，见 §7（`memory-plugins.md`、`core.md`、`tooling-and-tests.md`）。

### 3.1 `memory`：唯一的存取插件

**职责**：用 `node:sqlite` 开单文件库，建三张表；不理解业务，只提供原语：注册命名空间、按 `namespace`+`key` 写入或更新、按 `kind`/时间区间原样查询、带评分的混合检索、`boost`、只改 `text`/`data` 的 `patch`、删除、标签频次、缺向量清单、按身份查档（`memory-plugins.md`）。向量能力可选，插槽未接时 `embed()` 返回 `null`，检索退化但不报错（`memory-plugins.md`）。它以 `ctx.services.provide('memory', api)` 把整个 api 交给别的插件（`memory-plugins.md`）。

**方法（文档显式给出名字的）**

| 方法 | 关键行为 |
|---|---|
| `registerNamespace` | 幂等；已存在返回 `{ id, already: true, label, recallable }`，**不更新** `halfLifeDays`/`label`/`recallable`（`memory-plugins.md`） |
| `put({ namespace, kind, key, text, data, weight, now })` | 走 `(namespace,key)` 唯一索引 upsert；更新分支 `SET kind, text, data, weight, updated_at`，`weight` 取默认 `1`；不改 `created_at`（`memory-plugins.md`、`dream-and-life.md`） |
| `query({ namespace, kind, limit, ... })` | `ORDER BY created_at ASC LIMIT ?`（`memory:233`），即返回**最老**的 N 行（`memory-plugins.md`、`dream-and-life.md`） |
| `search({...})` | 混合评分，见下（`memory-plugins.md`） |
| `boost(ids, { now })` | `weight = MIN(5, weight + 0.2)`、`recall_count += 1`、`last_recalled_at = now`（`memory-plugins.md`） |
| `patch(id, { text, data })` | 只改 `text`/`data`（`memory-plugins.md`） |
| 删除 | 文档只写「删除」，方法名未说明（`memory-plugins.md`） |
| `tags` | 标签频次统计；测试 `mem.tags({})` 有「同事」（`memory-plugins.md`、`tooling-and-tests.md`） |
| `index(id, text)` | 建向量写 `mem_vec`；`saveVec` 只在此显式调用时执行（`memory-plugins.md`） |
| `missingVectors({ limit })` | 缺向量清单（`memory-plugins.md`） |
| `findPerson({...})` | 身份路由，见下（`memory-plugins.md`） |
| `archiveSearch(...)` | 只按字面找原话；**当前无调用方**（`memory-plugins.md`） |
| `stats()` | 测试断言 `stats().vectors === 2`（`tooling-and-tests.md`） |

**`memory.search` 算法（签名默认值：`{ namespace = null, namespaces = null, query = '', limit = 8, includeArchive = false, now = ctx.now(), minScore = null, tags = null, tagMode = 'any', conv = null }`）**（`memory-plugins.md`）

1. **命名空间过滤**：给了 `namespaces`/`namespace` 就逐个 `namespaceInfo`，否则全表；`includeArchive === false` 时丢掉 `recallable === false` 的行。
2. **取行**：`SELECT * FROM mem_items WHERE namespace IN (…) ORDER BY created_at DESC LIMIT 500` —— 每个命名空间集合最多 500 行，按新到旧。
3. **软删过滤**：`data.superseded !== true` 才留（被整理轮合并掉的块还在库里）。
4. **`conv` 过滤**：只留 `JSON.parse(data).origin.conv === String(conv)` 的行；`data` 为 `null` 的行直接丢弃（`return false`）。
5. **`tags` 过滤**：两边都 `toLowerCase()`；`tagMode === 'all'` 时要全部命中，否则任一命中。标签只缩小范围，**不参与打分**。
6. **相似度 `sim`**：
   - 有嵌入：`sim = 0.7 * cos + 0.3 * bigramOverlap(text, query)`。
   - 精确串加成（`LITERAL_ON`，即 `process.env.ICL_NO_LITERAL !== '1'`）：`literalTerms(query)` 抽 Windows 路径、文件名（`txt|md|json|mjs|js|py|log|db|png|jpg`）、带单位数字（`元|块|次|天|秒|分钟|小时|%|GB|MB`）、4 字符以上英文词；命中 `exact` 个时 `sim = Math.min(1, sim + 0.5 * (exact / terms.length))`。
   - 无嵌入但有 query：`sim = 查询二元组被文本覆盖的比例`（交集/查询集合大小）。
   - 无 query：`sim = 1`（纯按新鲜度/权重排）。
7. **衰减与总分**：`anchor = lastRecalledAt ?? createdAt`，`ageDays = max(0, (now-anchor)/86_400_000)`，`decay = exp(-ageDays / max(1, halfLifeDays))`，`score = sim * weight * decay`；`minScore != null` 时过滤 `score < minScore`。
8. **排序与截断**：`score` 降序、同分按 `createdAt` 降序，取 `max(1, limit)` 条。

`LITERAL_ON` 只在第 6 步决定是否加精确串分；`literalTerms` 每次调用都在逐行循环里重算（`memory-plugins.md`）。

**`findPerson({ qq, idKind, value, name, subject, limit = 5 })` 路由**：只查 `namespace = 'person' AND kind = 'block'`，匹配顺序固定（`memory-plugins.md`）：
1. 组装 `wanted`，顺序 `qq` → `subject` → `idKind + value`（同一 kind 重复时不去重）。
2. 精确匹配（只在这些 `wanted` 非空时）：`data.ids[]` 同 `kind`+`value`、`data.subject` 同 `kind`+`value`、`wanted.kind === 'qq'` 时 `key === 'person:<value>'`、或 `data.qq === value`。
3. 有精确命中返回 `{ exact: true, people }`（最多 `limit` 条），**不再做名字匹配**。
4. 无精确命中且 `name` 为空：`{ exact: false, people: [] }`。
5. 有 `name`：在 `` `${b.text}\n${b.data?.profile ?? ''}` `` 小写串里 `includes` 子串匹配，返回 `{ exact: false, people }`。

**失败回退**：嵌入缺失 → 字面/二元组；`raw` 单源抛错被吞；未注册命名空间直接抛 `命名空间没有注册：<ns>`（`memory-plugins.md`）。

### 3.2 `recall`

**工具与参数**（`memory-plugins.md`）

| 工具 | 参数（* 必填） | 返回 |
|---|---|---|
| `remember` | `text`*、`kind`（enum `event`/`person`/`slang`/`resolve`）、`key`、`qq`、`origin`、`subjectKind`、`about`；`additionalProperties: false` | `{ text: '记下了。' }` |
| `recall` | `kind`（同 enum）、`query`、`limit`、`cursor`、`about`、`conv`、`tag`；无必填 | `{ text, cursor, more }`，`cursor` 是 base64url 串或 `null` |
| `forget` | `key`*、`kind`（同 enum） | `{ text: '删掉了。' }` 或 `{ text: '没有这条笔记。' }` |

`remember` 默认写 `event`/`note`、`key: note:<now>:<rand5>`、`weight:1.5`（`memory-plugins.md`、`dream-and-life.md`）。

**`recall` 编排 10 步**（`memory-plugins.md`）
1. **候选**：`kind` 命中 `CATEGORIES` 时只搜那一类，否则搜 `event`/`person`/`slang`/`resolve` 四类；每类一次 `memory.search({ namespace, query, limit: 50, now, tags: tag ? [tag] : null, conv })`；`kind='resolve'` 时因该命名空间 `recallable: false` 返回空，但第 2 步仍会从 `resolve` 取到东西；已消化（`data.consolidated === true`）的 note 不作候选；候选按 `score` 降序、同分 `createdAt` 降序。
2. **未整理的 note 单独一队**：`tag` 为空时，`memory.query({ namespace, kind: 'note', limit: 200 })` 里所有 `consolidated !== true` 的条目以固定 `score: 1.15` 入队（今天显示 `[今天]`，跨天显示 `[未整理 · MM-DD]`）；带 `tag` 时这一队直接为空。
3. **配额**：先取 `noteQuota = Math.max(1, Math.floor(limit / 2))` 条未整理 note，再按顺序取候选（最多看 100 条）。
4. **游标去重**：`inWindow` 是游标 `items[].id` 的集合；已在窗口里的条目不重复给，也不从游标里删。
5. **token 预算**：`budgetTokens = Math.max(500, Number(ctx.config.budgetTokens) || 10_000)`；`estimateTokens(text) = Math.max(1, Math.ceil(cjk / 1.5 + rest / 4))`。单条若 `tokens + t > budgetTokens` 就跳过，但**第一条永远放行**（否则会返回空）。
6. **滚动游标**：`rollCursor` 把本轮新增 `{id, tokens}` 追加到旧窗口，然后 `while (totalTokens(items) > budgetTokens && items.length > 1) items.shift()` —— 从最早进窗口的块开始解锁；`while` 保证至少留一条。
7. **持久化**：游标落 `recall-cursor` 的 `cursor:<session>` 行，`text` 为 `${n} 块在窗口内`；返回给模型的是 `Buffer.from(JSON.stringify(cursor)).toString('base64url')`；传入 `cursor` 先经 `safeParseCursor`，解析失败退化成空窗口。
8. **回鲜**：`picked` 非空就 `memory.boost(ids, { now })`。
9. **原文回退**：只要 `ctx.services.raw?.ids?.().length` 非 0，就 `raw.search({ query, limit: 2 })`；过滤掉「归一化后前 40 字符已出现在主结果里」的，最多留 2 条，渲染成 `原文（MM-DD）：前 160 字`；异常被吞掉，不影响主结果。
10. **返回**：`text` = 主结果行 + 原文行用 `\n` 连接；`cursor` = 新游标；`more = candidates.length > picked.length`。

**人物分支**：`kind='person'` 且 `query` 非空时，`/^\d{2,12}$/` 命中就当 QQ 传 `{ qq }`，否则当名字传 `{ name }`；找到第一个人就返回 `[人物] <档案正文>`，有 `claims` 时再附 `依据：` 与 `· <claim.text>`；这条路**不读也不写游标**、**不做 `boost`**、只取 `people[0]`（`memory-plugins.md`）。

**输出行前缀（`renderEntry`，`recall/src/index.mjs:274-287`）**

| 条件 | 输出 |
|---|---|
| 未整理 note，`createdAt >= 今天 0 点` | `[今天] ${item.text}` |
| 未整理 note，跨天 | `[未整理 · ${M}-${DD}] ${item.text}` |
| `kind === 'block'` | `[${tag}] ${item.text}` |
| 其它（未消化 note 走候选路径） | `[${tag} · 随手记] ${item.text}` |

`tag` 由 `label(ns, createdAt, now)` 生成：`days = Math.floor((now - createdAt) / 86_400_000)`；`when` 取 `今天`（`days <= 0`）、`昨天`（`days === 1`）或 `${days} 天前`；`tag` 是 `meta.label` 与 `when` 用 ` · ` 连接（`memory-plugins.md`）。真实样例：

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

`[纠正 · …]` 这个标签**不会出现**（`resolve` 被 `recallable` 挡掉），但 `resolve` 的内容会以 `[今天]`/`[未整理 · MM-DD]` 出现（`memory-plugins.md`）。
单条 `kind='person'` 输出：`[人物] <person.text>` / `依据：` / `· <claim.text>`（`memory-plugins.md`）。
空结果两种兜底（`recall/src/index.mjs:238-240`）：`这几条刚才已经给过你了（就在上面的上下文里）；要找别的，把要找的事说具体一点。`（有候选但全被游标挡住）、`没有想起什么。（也没记过。）`（完全无候选）；多行分隔统一 `\n`（`memory-plugins.md`）。
原文回退行格式：`原文（${M}-${DD}）：${String(r.text).slice(0, 160)}`；`M` 不补零、`DD` 补零；时间取 `r.time ?? r.createdAt ?? ctx.now()`（`memory-plugins.md`）。

### 3.3 `note`

**工具**（`memory-plugins.md`）

| 工具 | 参数（* 必填） | 返回文本 |
|---|---|---|
| `memo` | `text`* | `记下了。` / `没写成。` |
| `memos` | `all`、`done`（boolean） | `没有待办。` 或若干 `· <text>`（每条 `updates` 追加 `\n  + <text>`） |
| `memo_append` | `id`*（number）、`text`* | `补上了。` / `没补上（找不到那条）。` |
| `memo_commit` | `id`*（number）、`result`、`source` | `完成了。` / `没找到那条。` |
| `note_status` | `{}`（无参数） | `待办 ${open} 条，已完成待回收 ${done} 条，已归档 ${archived} 条。` |

**状态机**（`memory-plugins.md`）

```
open --memo_commit--> done --dream consume（有 about.namespace 且有 result/最后一条 update）--> archived
open --note.resolve()（dream cleanup 关疑问时调用）--> resolved
```

- `open`：`note.add` 写入 `data = { status:'open', raisedBy, kind, about, createdAt }`。
- `done`：`memo_commit` 写 `status:'done'` + `result` + `source` + `doneAt`；`memo_append` 只追加 `data.updates`，**不改状态**。
- `archived`：`dream` 的 `consume` 扫 `status === 'done'`，按 `about.namespace` 分三支写回：`lexicon` 调 `lexicon.upsert({ term, conv, meaning: result, … })`；`person`/`event` 写一条 `text` 为 `（备忘回收）${result}` 的 note；写成功才 `status:'archived'` + `consumedAt`；没有 `about.namespace` 或没有结论的 `done` 行既不写回也不归档。
- `resolved`：`note.resolve(id, { answer })` 把整块 `data` 换成 `{ ...旧, status:'resolved', answer, resolvedAt }`；只被 `dream` 的 `cleanup` 调用（纠正处理完后，把所有 `about.key` 相同的未结疑问关掉，`answer` 取纠正原文前 200 字）。
- 另有独立标记：`resolve` 命名空间的纠正 note 被整理轮处理后打 `data.consumed = true` + `consumedAt`；**`consumed` 不是 `note` 命名空间的状态**。

**其它行为**：`note` 命名空间 `recallable: false`，`recall` 永远搜不到；写入口两个（模型调 `memo`、别的插件调 `ctx.services.get('note').add()`）；向 `world` 服务挂标题 `待办`、`cap: 1` 的来源，brief 为 `还有 <n> 件事没了结。`（`n === 0` 返回 `[]`）；自己不往对话推消息（`memory-plugins.md`、`dream-and-life.md`）。
`add()` 把正文 `slice(0, 400)`；`rows()` 是 `memory.query({ namespace:'note', kind:'note', limit: 500 })`，`count()`/`openNotes()`/`note_status` 全基于它（`memory-plugins.md`）。

### 3.4 `lexicon`

**工具**（`memory-plugins.md`）

| 工具 | 参数（* 必填） | 要点 |
|---|---|---|
| `lexicon` | `term`、`conv`、`platform`、`tag`、`limit` | 读路径不改变任何状态；按 `(row.data?.tags ?? []).includes(String(tag))` 精确比较 |
| `lexicon_learn` | `term`*、`meaning`、`usage`、`conv`、`platform`、`url`、`tags`（array\<string\>） | 写路径走 `upsert` |

**`upsert({ term, conv = 'web', platform, url, meaning = '', usage = '', tags = [], evidence })` 7 步**（`memory-plugins.md`）
1. 空词返回 `{ ok: false, error: 'empty-term' }`；`conv` 为 `web` 时存进 origin 的 `conv` 是 `null`。
2. 取同 key 旧行，复制 `origins`；找同来源下标：`(o.conv ?? null) === (conv === 'web' ? null : conv) && (o.url ?? null) === url`；命中 `origins[same] = { ...origins[same], ...fresh }`（**浅合并，旧字段保留**），否则 `push(fresh)`。
3. `fresh = originOf({ conv, platform, url, meaning: meaning || null, status: meaning ? 'confirmed' : 'candidate' })`，`seenAt = ctx.now()`。
4. 聚合：`status = origins.some(o => o.status === 'confirmed') ? 'confirmed' : 'candidate'`；`pending = !confirmed && !meaning`；`tags` 去重后截到 8 个；`usage` 取新值或旧值；`decay = { weight: 旧 weight ?? 1, lastSeen: now }`。
5. `usageState = origins.some(o => (o.usageState ?? 'active') === 'active') ? 'active' : 'fading'` —— 新建 origin 的 `usageState` 是 `null`，此条恒为 `active`。
6. 写库：`text = ${word}：${meaning || '（意思还不确定）'}`，`kind:'term'`，`key = lexicon:<conv>:<word>`，然后异步 `memory.index` 用 `${word} ${meaning} ${usage}` 建向量。
7. `!confirmed` 时追加待办：`noteSvc.add({ text: 查一下「${word}」是什么意思、从哪来的。, about: { namespace:'lexicon', key, term, conv }, raisedBy:'lexicon', kind:'question' })`。

**老化**由 `dream` 的 `ageLexicon` 做：距 `data.decay.lastSeen` 超过 30 天 → `usageState = 'fading'`、`decay.weight = max(0.1, weight * 0.7)`（`memory-plugins.md`、`dream-and-life.md`）。

**输出格式**（单条，多条间空行 `\n\n`）（`memory-plugins.md`）

```
${term}：${status === 'confirmed' ? '已确认' : '待确认'}${usage ? `，${usage}` : ''}
· ${where}：${what}${note ? `（${note}）` : ''}
```

`where`：有 `conv` 写 `群 <conv>`，否则有 `platform` 写该值，否则 `网上`；`what` 取 `o.meaning`，缺省 `意思待确认`。空结果：`没有这个说法。要是刚听到，可以先用 lexicon_learn 记下来。`
`lexicon_learn` 三种返回：`记下了「${term}」，意思还不确定，已经留了待办去查。` / `记下了「${term}」。` / `没记成（缺词）。`（`memory-plugins.md`）
读写都封顶 500 条（`all()` 是 `memory.query({ namespace:'lexicon', kind:'term', limit: 500 })`，`created_at ASC`），所以只覆盖最老的 500 个词条（`memory-plugins.md`）。

### 3.5 `whois`

**工具**：`whois`，参数 `qq`、`idKind`、`subjectKind`、`value`、`name`（全部可选）（`memory-plugins.md`）。

**内部路由**：给 `qq` / `idKind`+`value` / `subjectKind`+`value` 时按账号精确找，给 `name` 时按子串给候选（不硬猜）；自己不注册命名空间，只读 `person` 命名空间的 `kind='block'` 行（`memory-plugins.md`）。
`whois` 传全部五个参数给 `findPerson`（`memory-plugins.md`）。

**输出拼装与上限**（`memory-plugins.md`）

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

`ids` 是把 `data.ids` 逐项写成 `<kind>:<value>` 再用 `、` 连接；`familiarity` 缺省 `'unknown'`；第二行前两个空格；`←` 前两个空格；`逐句依据：` 仅 `claims` 非空时出现（最多 6 条，每条依据取前 60 字）；`依据：` 仅 `data.evidence` 能查到笔记时出现（最多 5 条）；`原话：` 仅有 `raw` 来源且命中时出现；`最近提到 TA 的事：` 仅事件非空时出现（最多 3 条）（`memory-plugins.md`）。
多候选：`按名字找到 ${people.length} 个可能的人：` + 列表；无档案：`还没有 ${qq} 的档案（认识之后、做梦整理过才会有）。` / `还没有这个人的档案。`（`memory-plugins.md`）。
`recentEventsFor` 用 `person.data?.qq ?? qq ?? ''` 与 `event` 块 `data.people` 比对，取 `slice(-limit)`（即创建时间最晚的 3 条，与相关性无关）（`memory-plugins.md`）。
逐句依据查询是 O(claims × 500)：每个 claim 的每条 `evidence` 都重跑一次 `memory.query({ namespace:'person', kind:'note', limit: 500 })`，最多 6 条 claim（`memory-plugins.md`）。

### 3.6 `eager-recall`

无工具，注册 `ctx.prompt.onTurn`（`memory-plugins.md`）。
配置与默认：`enabled = ctx.config.enabled !== false`、`minScore = Number(ctx.config.minScore ?? 0.5)`、`maxItems = max(1, Number(ctx.config.maxItems ?? 2))`、`maxChars = max(40, Number(ctx.config.maxChars ?? 200))`（`memory-plugins.md`）。
每轮：`memory.search({ query, limit: max(4, maxItems * 3), now, minScore })` → 再过一次 `score >= minScore` → 丢掉 `kind === 'cursor'` → 取前 `maxItems` 条；无命中返回 `null`（核心 `prompt.turnText` 变成空串，再叠 800 字上限）；检索不带 `namespace`，`event`/`person`/`slang`/`lexicon` 四个可回忆命名空间都会被扫（`memory-plugins.md`）。
注入格式：

```
你可能记得（检索结果，仅供参考）：
· [${tag}] ${text.slice(0, 80)}
```

`tag = item.kind === 'note' ? '未整理' : (h.namespace ?? '记忆')`；超 `maxChars` 时 `text.slice(0, maxChars - 1).trimEnd() + '…'`（`memory-plugins.md`）。

### 3.7 `dream`（详表见 §4）

`export const name = 'dream'`，唯一入口 `apply(ctx)`（`dream/src/index.mjs:18,67`）；依赖 `ctx.services.require('memory')` 与 `require('rhythm')`（`:68-69`），manifest 写 `"requires": { "plugins": ["memory", "rhythm"] }` 和插槽 `dream-chat`（`dream-and-life.md`）。
`session = String(ctx.config.sessionId ?? 'default')`；`persona = String(ctx.config.persona ?? loadPersona(ctx) ?? '')`，`loadPersona` 读 `ctx.config.personaFile || <root>/prompts/dream.md`（`:851-854`）——因为用 `??`，传 `persona: ''` 会**阻止**回落到文件（`dream-and-life.md`）。
注册 `memory.registerNamespace({ id:'dream-run', label:'做梦记录', recallable:false, owner:'dream' })`（`:73`）（`dream-and-life.md`）。
统一提问入口 `ctx.slots.call(slot, { messages: [system(persona + instruction), user(payload)], maxTokens })`（`:77-86`）（`dream-and-life.md`）。
对外服务：`ctx.services.provide('dream', { run, jobs: Object.keys(JOBS), slot, persona })`（`:841`）（`dream-and-life.md`）。

### 3.8 `persona`

文档给出的可证事实（`tooling-and-tests.md`、`dream-and-life.md`）：
- `set` 后立刻进系统提示；连两次 `set` 后 `versions().length === 2`、`rollback(1)` 回到「第二版」；无 memory 时 `versions()` 为空；持久化命名空间为 `persona` / `persona-current`（`m1b-persona-world.test.mjs`，`tooling-and-tests.md`）。
- 版本键 `v:<stamp>-<++versionSeq>`，时间戳精确到秒，`versionSeq` 是进程内计数（`persona:23,56`）（`dream-and-life.md`）。
- 系统提示段 `name:'persona', order:20`（`core.md`）。
- 其余 API、manifest、工具数与失败分支：**文档未说明**。

### 3.9 `world-state`

**服务**：`registerSource({ id, owner, title, order, cap, items })`（`world-state/src/index.mjs:42-57`）：`id` 必填唯一、`items` 必须函数；`owner` 默认 `id`、`title` 默认 `owner`、`order = Number(order) || 50`、`cap` 默认 `DEFAULT_CAP = 3`（`:16`）（`dream-and-life.md`）。

仓库里全部真实注册（`dream-and-life.md`）：

| id | owner | title | order | cap | brief |
|---|---|---|---|---|---|
| `clock` | `clock` | `时间` | 10 | 未传 → 3 | `现在是 <YYYY-MM-DD HH:mm>。` |
| `rhythm` | `clock` | `作息` | 20 | 1 | `下一次做梦：<HH:mm>（还有 <hh> 小时 <mm> 分）。`（`hh` 为 0 时省略该段） |
| `note` | `note` | `待办` | 5 | 1 | `还有 <n> 件事没了结。`（`n === 0` 返回 `[]`） |

（`world-state:123`、`rhythm:93-102`、`note:71-77`）

**`renderBrief()`（`:82-94`）逐字**：`const source = [...sources.values()].find((s) => s.owner === group.owner)`；`const cap = source?.cap ?? DEFAULT_CAP`；`const shown = group.items.slice(0, cap)`；`const more = group.items.length - shown.length`；`const body = shown.map((item) => item.brief).join('；')`；`lines.push(`${group.title}：${body}${more > 0 ? `（还有 ${more} 项）` : ''}`)`（`dream-and-life.md`）。

可推的硬事实（`dream-and-life.md`）：
- 段**没有标题**（`ctx.prompt.section({ name:'world', order:10, text: () => renderBrief() })`，`:128`；`prompt.assemble` 只 `join('\n\n')` 再 `trim`，`services.mjs:356-369`）。
- `order` 只被存下并出现在 `sources()` 里，**不参与渲染**；`itemsOf` 排序是 `a.source.localeCompare(b.source)`（`:68`）。
- 组标题取该 owner 第一条 item 的 `title`（`owners()` 用 `item.title`，`:74-77`），所以永远显示 `时间`、看不到 `作息`。
- 每个 owner 的 cap 取该 owner **第一个注册** source 的 cap（`find`，`:86`），所以 `rhythm` 的 `cap:1` 不生效。
- brief 自带 `。` 再拼 `；` 会出现 `。；`。

模型实际看到的世界段（`now = 2026-11-02 19:55`，2 条未结备忘）：

```
时间：现在是 2026-11-02 19:55。；下一次做梦：22:30（还有 2 小时 35 分）。
待办：还有 2 件事没了结。
```

没有未结备忘时只剩第一行（`dream-and-life.md`）。
`read()` 三态：`read()` → `{owners:[{owner,title,count}], text: renderBrief()}`；`read({owner})` → `{owner, items:[{key,brief,hasDetail}], text: '· <brief>' 逐行}`，空时 `没有来自「<owner>」的信息。`；`read({owner,item})` → `{owner,item,detail,brief,text}`，`text = detail ?? brief`，缺失 `「<owner>」没有这一项：<item>`；`limit` 只在列 owner 时生效（`Math.max(1, Number(limit) || 20)`）（`dream-and-life.md`）。
`world_status` 的最终 description 409 字符（实测）：

```
Read the world state bus: one line per source, or expand one source or item. No arguments: the global glance. owner: list that source's items. owner + item: expand one item's full detail. Sources are assembled at runtime and may disappear when they have nothing to report. Use when: you want to know what is going on around you; before acting somewhere. Avoid when: when nothing changed since you last looked.
```

参数 `owner`（`Who registered it, e.g. "qq".`）、`item`（`An item key within that owner.`）、`limit`（`Max items when listing an owner (default 20).`）；`execute` 返回 `{text}`，空则 `（世界状态是空的）`（`dream-and-life.md`）。

### 3.10 `rhythm`

配置：`dreamAt` 默认 `'22:30'`，校验 `/^(\d{1,2}):(\d{2})$/` 与 `hour<=23 && minute<=59`，错误文本 `dreamAt 格式应为 HH:mm，收到 <at>` / `dreamAt 不合法：<at>`（`rhythm:20-25`）；`stateFile` 默认 `<root>/state/rhythm.json`，落盘 `{ lastFiredDay, at }`（`:27-45`）（`dream-and-life.md`）。
API：`onNightly(fn)`（返回注销器）、`fire(now,{force})`、`at`、`nextAt(now)`、`lastFiredDay()`、`isDue(now)`（`:76-88`）（`dream-and-life.md`）。

```js
function todayPoint(now) { const d = new Date(now); d.setHours(hour, minute, 0, 0); return d.getTime() }
nextAt(now = ctx.now()) { const today = todayPoint(now); return now < today ? today : today + 24*3600_000 }
isDue(now = ctx.now()) { return now >= todayPoint(now) && lastFiredDay !== dayKey(now) }
```

`nextAt` 不看 `lastFiredDay`：若当天提前手动 `fire()`（如 10:00），11:00 时 `nextAt` 仍指向今天 22:30，而那个时刻 `fire()` 会因 `already-today` 拒绝——世界状态承诺的「下一次做梦」不会发生（`dream-and-life.md`）。
`fire()` 先 `lastFiredDay = day`、`save()`，再同步通知所有 listener（单个抛错只吞掉），最后 `ctx.log({ msg:'rhythm.nightly', at, day })`（`:54-62`）（`dream-and-life.md`）。
计时器：`const timer = setInterval(tick, 20_000)`、`timer.unref?.()`、`ctx.onDispose(() => clearInterval(timer))`，`tick()` 在 `now >= todayPoint(now)` 时 `fire({ now })`（`:65-74`）（`dream-and-life.md`）。
没实现/边界：① 启动**不**补发（靠消费者 enable 时自查 `isDue`）；② 没有跨进程队列——`fire` 先落盘再通知，若那一刻 dream 未 enable，当天信号永久丢失；③ 无 `timezone`/夏令时配置，`dayKey`/`todayPoint` 用进程本地时区，与 dream 的 `config.timezone` 不共享；④ 无 cron、周末规则、抖动、失败重试、积压合并，`fire` 也不回传 job 结果；⑤ 精度 20s 且依赖 `ctx.now()`，`rhythm.test.mjs` 全部直接调 `fire/nextAt/isDue`，从未等真实定时器（`dream-and-life.md`）。

### 3.11 `compaction`

`ctx.services.provide('compaction', { run: (input) => ctx.services.context.compact(input), latest })`（`:57`）；注册 `context.onCompact({ id:'icl-summary', compact })` 与 `context.onAssemble({ name:'compaction-summary', order:60, apply })`（`:35-55`），而 `context.compact` 只取**第一个** compactor（`services.mjs:141-145`）（`dream-and-life.md`）。
config：`keepRecent` 默认 12（`Math.max(2,...)`）、`maxChars` 默认 1200（`Math.max(200,...)`）（`:10-11`）；`compact({history, keepRecent})` 的入参**覆盖**配置值（`:37`）（`dream-and-life.md`）。
摘要 system 逐字：`把这段较早的对话压成一小段第一人称的回忆，保留事实、决定、未完成的事。不要评价。`；user 是 `用户：…`/`我：…` 逐行（每条 `slice(0,200)`）再 `slice(0,12000)`；`maxTokens:600`；结果 `slice(0,maxChars)`（`dream-and-life.md`）。
写入 `memory.put({namespace:'compaction', kind:'summary', key:'sum:<now>', text, data:{dropped}})`（`dream-and-life.md`）。
返回 `{ok:true, summary, dropped, kept}`；历史不足时 `{ok:true, summary: latest()?.text ?? '', dropped:0}`；空摘要 `{ok:false, error:'empty-summary'}`（槽未绑定也走这条）；注入文本逐字 `【早前对话的压缩摘要】\n<row.text>`（`:53`）（`dream-and-life.md`）。

### 3.12 `dsh-raw`

`ctx.services.raw.register({ id:'dsh-sessions', search, list })` + `ctx.services.provide('dsh-raw', { search, size })`（`:99-100`）（`dream-and-life.md`）。
config：`sessionsRoot`（默认 `%USERPROFILE%/.dsh/sessions`）、`days` 30、`maxFiles` 400、`maxMessages` 20000、`cacheMs` 300000（各有下限，`:40-44`）（`dream-and-life.md`）。
算法：递归收 `.jsonl`/`.jsonl.zstd`，按 `mtimeMs >= now - days` 过滤、mtime 降序；`.zstd` 走 `zlib.zstdDecompressSync`；只收 `user/message`/`assistant/message`；正文跳过以 `Current runtime context|Time sampled|This is an automatically generated checkpoint|<system-reminder>` 开头的行；正文 `replace(/\s+/g,' ').trim().slice(0,600)`，输出 `{text,time,role}`（`:19-37`）（`dream-and-life.md`）。
`search({query,limit=2})` 用不含 `[?？。，、\s]` 的二元组按命中数、时间降序取前 N；`list({since,until,limit=500})` 过滤后 `.slice(0,limit)`；`load()` 缓存 `cacheMs`，超 `maxMessages` 时 `slice(-maxMessages)`（`dream-and-life.md`）。

### 3.13 `model-manager`

config `providers`（元素 `{id,kind,shape,baseUrl,model,apiKeyEnv,apiKey,timeoutMs,disableThinking,extraBody}`）（`dream-and-life.md`）。
`id` 缺失跳过；`apiKeyEnv` 存在但环境变量为空 → `skipped.push({ id, reason: '缺环境变量 <keyEnv>' })` 并 warn；非 `apiKeyEnv` 时用 `entry.apiKey`（`:50-59`）（`dream-and-life.md`）。
只有**第一个** chat 供应商 `ctx.model.bind({baseUrl,model,apiKey,timeoutMs,extraBody})`，其中 `extraBody = disableThinking ? { chat_template_kwargs: { enable_thinking: false } } : (entry.extraBody ?? {})`（`:61-67`）（`dream-and-life.md`）。
chat provider 的 `call` = `ctx.model.chat({ messages, maxTokens: request?.maxTokens ?? null })`；embedding provider `POST <baseUrl>/embeddings`，body `{model, input}`，`AbortSignal.timeout(timeoutMs || 20000)`，返回 `data.data[].embedding`；未知 kind 抛 `未知的供应商类型：<kind>`（`dream-and-life.md`）。
对外 `{ providers, skipped, rebind, unmatched }`，`bind()` = `ctx.slots.autoBind()`（`dream-and-life.md`）。

### 3.14 `editor`

config `root`（默认 `process.cwd()`）、`maxBytes`（默认 `256*1024`，≥1024）（`:8-9`）；守卫 `inside(p)`：`resolve` 后必须等于 root 或以 `root + sep` 开头（`:11-14`）（`dream-and-life.md`）。
三条工具的最终 description（实测）（`dream-and-life.md`）：
- `read_file` — `Read a text file inside your workspace. Use when: you want to look at something you or the user wrote. Avoid when: binary or huge files.`
- `write_file` — `Write a text file inside your workspace. Overwrites by default; pass append:true to add to the end instead. Use when: you want to keep notes or draft something; use append:true when adding to a note you already wrote today, otherwise you erase it. Avoid when: editing code you do not understand.`
- `list_dir` — `List files in a workspace directory. Use when: you want to find where something is. Avoid when: listing huge trees.`

行为：越界 `不在工作区里。`；`read_file` 超 `maxBytes` → `文件太大。`，否则读全文再 `.slice(0,20000)`，失败 `读不到这个文件。`；`write_file` 自动建父目录，成功 `写好了。`/`追加好了。`，失败 `写不进去。`；`list_dir` 最多 100 项，格式 `d <name>`/`f <name>`，空目录 `空目录。`，失败 `打不开这个目录。`（`dream-and-life.md`）。

### 3.15 `bili`

硬编码/环境变量：`PY = process.env.BILI_PYTHON ?? 'C:\Users\ai_admin\.dsh\bili-duty\.venv\Scripts\python.exe'`、`ICL_ROOT = process.env.ICL_ROOT ?? 'C:/DSH/qwenstuff/icl'`、`RUNNER = process.env.BILI_RUNNER ?? <ICL_ROOT>/tools/bili-run.py`、`STORYBOARD_CLI = process.env.STORYBOARD_CLI ?? '...\dsh-video-storyboard\bin\storyboard.mjs'`（`:10-14`）；config 只有 `maxChars` 默认 6000（`:28`）（`dream-and-life.md`）。
四条工具（最终 description 实测，见 `dream-and-life.md` §6）：`bili_search`、`bili_watch`、`bili_comments`、`bili_frames`。
行为：`callTool` 用 `execFile(PY,[RUNNER,fn,JSON.stringify(args)],{timeout:60000,maxBuffer:4MiB})`，失败 `{ok:false,error}`，输出整体 `.slice(0,limit)`；`bili_watch` 仅当字幕 `> 20` 字符才追加 `\n\n--- 字幕/摘要 ---\n…`；`bili_frames` 用 `/BV[0-9A-Za-z]{8,12}/` 取 BV 号，`cells` 夹 1..16（默认 6），默认区间 `from=0, to=start+240`，固定 `--scan-height 240`、`--allow-anonymous`，超时 600000ms，返回 `已切好宫格图：<path>\n<timeline>` 并带 `imagePath`（`dream-and-life.md`）。

---

## 4. 做梦流水线

### 4.1 序列与入口

`const DEFAULT_JOBS = ['wash','events','people','lexicon','consume','cleanup','index']`（`:20`）；`const JOBS = { wash, events, people, slang, lexicon, consume, cleanup, index }`（`:819`）——`slang` 在表里但**不在默认序列**；`lexicon` 的注释写明 `slang 已并入 lexicon`（`:695`）（`dream-and-life.md`）。
`run()` 按数组顺序串行，逐 job 包 try/catch，未知 job 产出 `{job:name, ok:false, error:'unknown-job'}`，最后 `const ok = results.every((r) => r.ok !== false)` 并返回 `{ ok, day, results }`（`:825-835`）——只有 `skipped` 字段的结果算成功（`dream-and-life.md`）。
触发两条：`rhythm.onNightly((event) => { void run({ now: event?.at ?? ctx.now() }) })`（`:837`），以及 `if (typeof rhythm.isDue === 'function' && rhythm.isDue()) void run()`（`:839`）——enable 时补跑，fire-and-forget，且与手动 `dream.run` **没有互斥**（`dream-and-life.md`）。
实测（仅 memory+rhythm+dream）：`wash no-raw → events no-notes → people no-notes → lexicon no-lexicon-plugin → consume no-note-plugin → cleanup nothing-to-do → index nothing-missing`，整体仍 `ok:true`；但此时 `memory.put({namespace:'event'})` 抛 `命名空间没有注册：event`（`dream-and-life.md`）。
跳过形态只有 `job` + `skipped`（无 `ok`）：`wash`→`already-ran`/`no-raw`；`events`→`already-ran`/`no-notes`；`people`→`already-ran`/`no-notes`；`lexicon`→`already-ran`/`no-lexicon-plugin`；`consume`→`already-ran`/`no-note-plugin`；`cleanup`→`already-ran`/`nothing-to-do`（`blocks.length < 2 && !pendingResolves.length`）；`index`→`already-ran`/`nothing-missing`；`slang`→`already-ran`/`no-notes`；失败是 `{job, ok:false, error}`（`people` 多带 `qq`，`:345`）（`dream-and-life.md`）。

### 4.2 逐步事实表

| 步骤 | 实际做什么（读 → 写） | 幂等键 / 去重 | 已知缺陷 |
|---|---|---|---|
| **wash** | 读 `raw.list({ since: dayStartOf(now), until: dayEndOf(now), limit: 400 })`，无 namespace；把当天原文按 `[<i>] <text>` 喂模型抽事件/人物碎片；写 `event`/`person` 的 `kind:'note'`、`weight:1.1`；成功返回 `{job:'wash', ok:true, notes}`（`:122`） | `run:<day>:wash`；跳过 `already-ran`/`no-raw` | 写出的 note **没有 key**，`events` 的 `data.sources` 记不到它们；`origin` 实际拿不到（只有原始行有 `conv` 时才写，而 dsh-raw 的 `list` 只返回 `{text,time,role}`）；**不带人格**；`wash` 与 `lexicon` 走 `ctx.slots.call` 而非 `ask()`（`dream-and-life.md`） |
| **events** | 读 `memory.query({namespace:'event', kind:'note', limit:500})` 再滤 `data.consolidated !== true`，**不按天**；`ask()` 出块；写 `event`/`block`，`key: evt:<day>:<hash(summary)>`；返回 `{job:'events', ok:true, blocks, notes, deferred}`（`:199`） | `run:<day>:events`；块 key `evt:<day>:<hash(summary)>`；只有 `evidence` 命中的 note 被 `markNotes` | instruction 用 `.join('\n')` 产出**字面反斜杠+n**；`data.sources` 写的是**全部输入** note 的 key，不是被引用的；重跑会降级已有事件的 evidence（同 summary 再 upsert 时 `validEvidence` 拿不到原 id → `evidence:[]`、`provisional:true`）；`person` note 永不标 `consolidated`（标记循环只看 `data.qq`） |
| **people** | 读 `person`/`note`（500，未消化）+ `person`/`block`（500，现有档案）+ `event`/`block`（500，`slice(-20)`）+ 再查 `person`/`note`（`slice(-20)`）（`:274-299`）；`ask()` 整块重写档案；写 `person`/`block`，`key: person:<value>` 或 `person:<kind>:<value>`；返回 `{job:'people', ok:true, blocks, people, skipped}` | `run:<day>:people`；`person:<qq>` / `person:<kind>:<value>` | 跨天上下文恒为空（`relatedEvents` 用 `b.data.people.includes('qq:42')`，event 存的是 `42`；`pastNotes` 用 `String(n.data?.qq) === 'qq:42'`）；evidence 为空会补问一次（`maxTokens:200`）；`profile` 空时兜底 `目前知道的：<前 3 条 note，用 '；' 连>。` |
| **lexicon** | ① `raw.list({since,until,limit:400})`；② `['event','slang']` 的 `note`（各 200，未消化）；③ `lexicon.query()`（`:697-714`）；模型抽「可能是黑话」的候选，经 `lexicon.upsert` 写 `lexicon`/`term`；老化 `memory.patch`；缺释义经 `note` 服务写待办；返回 `{job:'lexicon', ok:true, learned, faded}` | `run:<day>:lexicon`；词条 key `lexicon:<conv>:<term>`；进程内 `seenTerms` 去重 | `reason` 从不被要求 → tags 恒 `['待查']`；`meaning` 通常空 → `candidate` + 待办；`usageState` 恒被抹回 `active`；即使无新笔记也跑老化并 `recordRun`；**不带人格** |
| **consume** | 读 `memory.query({namespace:'note', kind:'note', limit:200})` 滤 `data.status === 'done'`（`:782-783`）；按 `about.namespace` 三支写回（`lexicon` 走 `upsert`；`person`/`event` 新建 `kind:'note'`，文本 `（备忘回收）<result>`）；再把原 note 置 `status:'archived'`；返回 `{job:'consume', ok:true, written, archived}` | `run:<day>:consume`；`status:'archived'` + `consumedAt` 后续不再处理 | 无 `about.namespace` 或无结论的 `done` 行既不写回也不归档；`note` 服务缺省时 `no-note-plugin` |
| **cleanup** | 读 `resolve`/`note`（100，滤 `consumed !== true`）+ `event`/`person`/`slang` 的 `block`（各 60，跳过 `superseded`）（`:520-529`）；输出 `{"merges":[...],"rewrites":[...],"consumed":[]}`，`maxTokens:1500`；被并块 `superseded:true, supersededBy`；`patch` text/body/evidence；返回 `{job:'cleanup', ok:true, merged, rewrites, consumed}` | `run:<day>:cleanup`；`superseded` 软删；`consumed` 标记；`nothing-to-do` 当 `blocks.length < 2 && !pendingResolves.length` | **改写丢 body**：`:615` 先 `patch({text})`，`:616` 再 `patch({data:{...existing.data, body}})`，`:619` 又用 patch **之前**捕获的 `existing.data` 写 evidence → body 被旧值覆盖（实测 text 变新、body 仍旧）；提示词里有一处错别字 `· 主会话的纠正优,：按它改写对应的块…`（`:557`） |
| **index** | 读 `memory.missingVectors({ limit: 200 })`（`:653`）；写 `memory.index(id, text)` → `mem_vec`；返回 `{job:'index', ok:true, indexed, missing}` | `run:<day>:index`；无缺失时 `nothing-missing` | 无嵌入时也记账（`indexed:0` 仍 `recordRun`），当天不再重试 |

（整表 `dream-and-life.md` §1.3、§2；补充见 `memory-plugins.md`）

### 4.3 `recordRun` / `alreadyRan` / `force`

```js
function runKey(day, job) { return `run:${day}:${job}` }
function alreadyRan(day, job) {
  const rows = memory.query({ namespace: 'dream-run', kind: 'run', limit: 200 })
  return rows.some((r) => r.key === runKey(day, job))
}
function recordRun(day, job, detail, now) {
  memory.put({ namespace: 'dream-run', kind: 'run', key: runKey(day, job), text: `${day} ${job}`, data: detail, now })
}
```

（`:99-106`）`memory.put` 走 `(namespace,key)` 唯一索引 upsert，同一天同一 job 只有一行，重跑是更新；`memory.query` 是 `ORDER BY created_at ASC LIMIT ?`（`memory:233`），即最早 200 行——实测先塞 200 条历史 run 行，再连跑两次 `events`，第二次**没有** `skipped:'already-ran'`。按 7 job/天计，约 **29 天**后当天 run 行落到窗口外，幂等失效（`dream-and-life.md`）。
`force` 只做一件事：跳过每个 job 首行的 `if (!force && alreadyRan(...))`，并原样透传。它**不**清 `dream-run`、**不**复位 job 内部去重（`lexicon` 的 `seenTerms` `:749`、`raiseQuestion` 的 `askedThisRun` `:487-491`）（`dream-and-life.md`）。
成功才 `recordRun`；跳过与失败都不写，所以「失败不吞原文」靠的是 note 没被标 `consolidated`（`dream-core/test/dream-jobs.test.mjs:78-86`）（`dream-and-life.md`）。

### 4.4 共享工具函数与提示词事实

- `parseBlocks(raw)`（`:34-49`）：取 ```` ```(?:json)? … ``` ```` 内第一段否则全文；从第一个 `[` 或 `{`（取更早者）起，到 `lastIndexOf(']')`/`lastIndexOf('}')` 的较大者止；`JSON.parse` 失败返回 `[]`；非数组包成 `[obj]`（`dream-and-life.md`）。
- `normalizeTags(tags,{max=5,maxLen=10})`（`:55-65`）：`trim().toLowerCase()`，去 `[\s,\u3001]+`，长度 > 10 丢弃，去重，最多 5 个（`dream-and-life.md`）。
- `validEvidence(list, notes)`（`:496-503`）：编号映射为 `{type:'note', id}`，只留真实存在 id，最多 20（`dream-and-life.md`）。
- `markNotes(notes, now)`（`:92-97`）：`patch(id, { data: {...note.data, consolidated:true, consolidatedAt:now} })`（`dream-and-life.md`）。
- `findBlockByKey(key)`（`:506-514`）：按 `['event','person','slang']` 各查 `kind:'block'` limit 500（`dream-and-life.md`）。
- `raiseQuestion`（`:482-493`）：每轮最多 5 条、同文本去重、已有同名未结问题去重，走 `note.add({kind:'question'})`（`dream-and-life.md`）。
- 日期：`dayKey`/`dayRange` 用本机时区（`:22-31`）；`ymdInTz` 用 `ctx.config.timezone ?? 'Asia/Hong_Kong'` 出日期串，但 `dayStartOf` 把偏移**写死**为 `+08:00`（`:685-690`）；`hash` = `h*31+charCode` 的 base36（`:845-849`）（`dream-and-life.md`）。
- **只有走 `ask()` 的 `events`/`people`/`cleanup` 会带 `persona`**；`wash` 与 `lexicon` 直接 `ctx.slots.call`，**不带人格**（`dream-and-life.md`）。
- `events`、`people`、`cleanup`、`slang` 的 instruction 用 `.join('\\n')`（`:214,341,440,562`），在 JS 里这是**两字符**（反斜杠 + n），不是换行；只有 `wash`（`:153`）和 `lexicon` 的 `rules`（`:735`）是真换行；实测 `events` 的 system 中出现字面 `…总结报告。\n块里可以…`（`dream-and-life.md`）。
- `wash` 预算：`budget = Math.max(2000, washChars ?? 12000)`（`:127`）、`perLine = Math.max(240, washLineChars ?? 1200)`（`:128`），`used + text.length > budget` 就**整轮 break**；`raw.list` 上限 400 行，`maxTokens: 900`（`dream-and-life.md`）。
- `events` 映射：`summary`→`text`（`slice(0,200)`，空则丢块）；`body`→`data.body`（≤4000）；`evidence`→`validEvidence`（≤20），空则 `data.provisional = true` 并 `raiseQuestion('「<summary 前 40 字>」没有出处，以后问一下。')`；`people` 字符串化；`tags` 过 `normalizeTags`；`data.sources = notes.map(n => n.key).filter(Boolean)`（**全部输入**的 key）；`deferred = notes.length - covered.length`（`dream-and-life.md`）。
- `people` 限额：`text` 800、`data.profile` 2000、`data.narrative` 4000、`facts` ≤50、`aliases` ≤10、`ids` ≤10、`claims[].text` ≤200；`ids`/`aliases` 缺省回落 `existing.data`；`familiarity` 默认 `'unknown'`；`thin = list.length < 3 || profile.length < 60`，`provisional = thin || evidence.length === 0`（`dream-and-life.md`）。
- `lexicon` 提示词：payload 是 `<message source_id="<i+1>"><text></message>` 逐行 `'\n'`，text 先 `[<>]`→空格再 `.slice(0,300)`；行数 `.slice(0,200)`，整段 `.slice(0,8000)`，`maxTokens:900`；schema `[{content, source_id}]`，代码同时接受 `term`/`conv`/`meaning`/`reason`；`conv = item.conv || 'web'`；tags 按 `item.reason` 选 `新义/本群/高频/待查`（`:758`），但 instruction 从不要求 `reason` → 恒为 `待查`（实测）（`dream-and-life.md`）。

---

---

## 5. 缺陷与风险台账

> 编号规则：`C-` 来自 `core.md` §7，`M-` 来自 `memory-plugins.md` §6，`D-` 来自 `dream-and-life.md` §7，`T-` 来自 `tooling-and-tests.md` §二/§四。严重度为本文按文档描述的影响面分档。
> 状态列只写文档明确说过的「已修/仍未修/文档未说明」，不替文档补结论。

### 5.1 核心层（core.md）

| ID | 事实 | 严重度 | 状态与依据 | 来源 |
|---|---|---|---|---|
| C-1 | `ICL_TOOL_TIME` 曾是死代码：`services.mjs:258` 算了 `stamped`，`:267-272` 的 `composed` 展开原始 `execute`，`stamped` 从未被引用；`docs/STATUS.md:83` 声称「每次工具结果后追加当前时间」与当时代码不符 | 低 | **已于 `5d8c190` 修复**，本条保留为历史记录；`tooling-and-tests.md` 说修复后为真 | `core.md` |
| C-2 | 启用插件不会把新工具推给已挂上的 DSH 适配器：`enable()` 在 `apply` **之前**调 `surface.notify()`（`host.mjs:160`），`ctx.tools.register` 只触发 `tools.onChange`（仅写日志，`host.mjs:13`）。实测先 attach 再 enable，DSH 侧工具集仍空，须等下一次 `surface.notify()` | 高 | 未修（文档未说明修复） | `core.md` |
| C-3 | `sync()` 每次都重注册全部工具（`adapter-dsh.mjs:27-38`：先 dispose 旧的再 register，并 push 进 `added`），`added` 永远是当前全量；实测连续两次 `sync()` 的 `added` 都是 `['b_tool']`，注册计数从 3 涨到 5 | 中 | 未修 | `core.md` |
| C-4 | `validateManifest` 丢掉未知字段（只留 7 键），于是 `surface.summary()` 的 `p.manifest?.preset` 永远 `null`（`services.mjs:191`），`presetService` 的 `p.manifest?.presets` 过滤分支（`:220-222`）永远走 `!declared`——「插件可用 `presets` 声明自己属于哪些预设」这条规则实际不可能排除任何插件 | 中 | 未修 | `core.md` |
| C-5 | 非 `'default'` 且 `allow: null` 的预设会把工具面清空：`services.mjs:176` 只有 id 字面等于 `'default'` 才置 `null`，其它预设一律 `new Set(...plugins ?? [])`，而 `pluginIds` 对 `allow === null` 返回 `null` → `new Set([])`。实测 `define({id:'empty-allow'})` 后 `surface.names()` 为 `[]` | 高 | 未修 | `core.md` |
| C-6 | 工具索引不看预设，`session.toolNames()`/`installTools()` 也不看：`systemPrompt()` 用 `tools.index()`（全量），`installTools()` 用 `tools.list()`，只有 `attachDshAdapter` 走 `surface`；实测 `allow:['zzz']` 下 `surface.names()` 为 `[]`，但 `systemPrompt()` 仍含 `- at: s`、`toolNames()` 仍为 `['at']`；未写进 `manifest.tools` 的工具会进 `tools`/`installTools`，却被 `surface.owners()` 判为无主而过滤 | 高 | 未修 | `core.md` |
| C-7 | 截断硬下限会让输出超过 `maxChars`：工具描述用 `Math.max(40, maxChars - 1)`（`:37`），上下文/每轮用 `Math.max(20, maxChars - 1)`（`:130`、`:352`）；实测 `composeToolDescription({summary:'S'.repeat(200)},{maxChars:30})` 返回 **41** 字符 | 低 | 未修 | `core.md` |
| C-8 | 索引的尾巴可以超预算：`…（还有 N 个工具）` 在预算检查之后拼接；`tool-constraints.test.mjs:69-78` 自己对 `maxChars:400` 只断言 `index.length <= 500` | 低 | 未修（测试即松动证据） | `core.md` |
| C-9 | 投递重试到上限就静默丢弃：`nack` 在 `attempts >= 5` 设 `dropped = true` 且不回队列（`:519`），条目随 `inflight` 删除而消失；没有 `droppedCount()` 之类出口，水位也不推进，之后同一 `(plugin, activity, seq)` 还能被重新 accept；实测 5 次 nack 后 `pendingCount()` 不含该条、`watermarkOf` 仍 `0` | 高 | 未修 | `core.md` |
| C-10 | `binding.timeoutMs` 被忽略：model-manager 把 `timeoutMs` 传给 `ctx.model.bind`（`model-manager/src/index.mjs:65`），但 `configured()`（`model-client.mjs:14-19`）只取 `baseUrl`/`model`/`apiKey`，`request` 的 `timeoutMs` 只来自每次 `chat()` 入参（默认 120000） | 中 | 未修 | `core.md` |
| C-11 | provider 注销不解除已绑定插槽：`registerProvider` 注销器只 `providers.delete(id); changed()`（`:594`），`bindings` 里已绑的 `{provider, call}` 保留；实测 `off()` 后 `resolve('chat')` 仍返回 `{provider:'p1', kind:'chat'}`、`call('chat')` 仍返回 `'ok'` | 中 | 未修 | `core.md` |
| C-12 | `session.installTools()` 与 `attachDshAdapter` 是两条互不知情的注入路径：前者把 `tools.list()` 逐个交 `toolSink.register` 并返回只在那次调用有效的批量注销器（`session.mjs:24-28`），不订阅 `surface.onChange`、不按预设过滤、不随启停同步 | 中 | 未修 | `core.md` |
| C-13 | `session.start()` 的 `Timer` 未被 `disable` 或适配器回收——`stop()` 只在外部调用时生效，`host.disable` 不触碰它 | 中 | 未修 | `core.md` |
| C-14 | `focus.current()` 的并列 tie-break 未定义：条件是 `lease.since >= best.since`（`:408`），同一毫秒内进入的多个租约由 `Map` 插入顺序决定后者胜出，代码与文档都没说明这是有意的 | 低 | 未修/文档未说明 | `core.md` |
| C-15 | `canPierce` 的 glob 只支持 `*`：`globToRegExp` 转义 `[.+^${}()\|[\]\\]` 后把 `*` 换成 `.*`（`:56-57`），`?`、`-`、字符类都不生效，且整串锚定匹配 | 低 | 未修 | `core.md` |
| C-16 | 静默吞错没有出口：§1.16 列的所有装配期 `try/catch` 都是空体（只留中文注释），`prompt.assemble`/`context.assemble` 的失败对调用方不可见；`raw` 单源失败同样不可见 | 高 | 未修 | `core.md` |

**歧义（文档明确不做推断）**：`inject` 在核心不存在对应物（只有 `manifest.requires.plugins` 与 `services.provide/get/require`，历史命名见 `docs/AUDIT.md:44`）；`slot.meta`、`provider.meta`、`focus.visible`、`delivery.channel` 只被存储/透传，核心不解释；`host.list()` 与 `surface.summary()` 的 `preset` 字段无插件写过，无法判断预期语义；`session.mjs` 的 `log` 参数只有 `delivery.failed` 一处使用，插件启停/工具变更走 `host` 的 `log`（`core.md`）。

### 5.2 记忆类插件（memory-plugins.md）

| ID | 事实 | 严重度 | 状态与依据 | 来源 |
|---|---|---|---|---|
| M-1 | 原文回退无条件执行：`recall` 只要 `raw` 有来源就查并追加，唯一抑制是「归一化后前 40 字符已出现在主结果里」；因此 `archive-fallback.test.mjs:54,62` 的 `doesNotMatch(/出处：/)` 恒真——代码里根本不存在 `出处：`（只有 `原文（`） | 中 | 未修；该负向断言无法证明「主结果覆盖时不查原文层」 | `memory-plugins.md` |
| M-2 | `memory.archiveSearch` 无调用方：全仓 grep 只命中定义本身（`memory/src/index.mjs:195`），`recall` 用的是 `ctx.services.raw`；与 `raw` 功能重叠的 dead code | 低 | 未修 | `memory-plugins.md` |
| M-3 | 游标可能读不到：`loadCursor` 用 `memory.query({namespace:'recall-cursor', kind:'cursor', limit:1})` 再 `.find(r => r.key === cursorKey)`，而 `query` 是 `created_at ASC`、`limit:1` 只返回最早一行；同一库里存在第二个 `sessionId` 的游标后，后者永远读不到（`memory.put` 更新不改 `created_at`） | 高 | 未修 | `memory-plugins.md` |
| M-4 | `eager-recall` 的标签恒为 `[记忆]`：`memory.search` 返回 `{item, score}` 没有 `namespace` 字段（`recall` 自己补），所以 `h.namespace ?? '记忆'` 永远走兜底 | 低 | 未修 | `memory-plugins.md` |
| M-5 | `note_status` 的 `avoid` 指向不存在的工具：文本是 `when you need the actual text (use memo_list)`，实际工具名是 `memos` | 低 | 未修（文案） | `memory-plugins.md` |
| M-6 | `resolved` 状态不可见：`note.resolve()` 写 `status:'resolved'`，`note_status` 只统计 `open`/`done`/`archived`；`open_notes`/`count()` 也排除它，疑问被关掉后从计数里彻底消失 | 中 | 未修 | `memory-plugins.md` |
| M-7 | `note` 的计数与列表都以 **500** 为界：`rows()` 是 `memory.query({namespace:'note', kind:'note', limit:500})`（`created_at ASC`），`count()`/`openNotes()`/`note_status` 全基于它；超过 500 条后计数饱和，且只数最老的 500 条 | 中 | 未修 | `memory-plugins.md` |
| M-8 | `recall` 的未整理队列取最老的 **200** 条：note 超过 200 条时当天的 `[今天]` 可能根本不在这 200 条里，更老的未整理项会占掉 `noteQuota` | 中 | 未修 | `memory-plugins.md` |
| M-9 | 人物分支不刷新、不提示候选：命中档案后直接 `return { text, cursor: null, more: false }`，不写游标、不 `boost`，读档案不会重置衰减计时；同名多人只取 `people[0]` | 中 | 未修 | `memory-plugins.md` |
| M-10 | `put` 的更新路径把 `weight` 打回 1：更新已存在 key 时 `SET kind, text, data, weight, updated_at`，`weight` 取默认 `1`；`dream` 的 `people` 整块重写、`cleanup` 合并写回、`lexicon.upsert` 都经过它，召回攒的权重被清零（`recall_count`/`last_recalled_at` 保留） | 高 | 未修 | `memory-plugins.md` |
| M-11 | `put` 更新文本不失效旧向量：`saveVec` 只在 `memory.index` 显式调用时执行；更新分支不删 `mem_vec` 旧行，文本改写后检索仍可能用旧向量 | 高 | 未修 | `memory-plugins.md` |
| M-12 | `registerNamespace` 不更新已存在行：只返回 `{already:true}`，`halfLifeDays`/`label`/`recallable` 的后续修改不生效；已有命名空间只能删库或手写 SQL 改 | 中 | 未修 | `memory-plugins.md` |
| M-13 | 精确串加成在循环里重算：`for (const row of rows)` 内每行都执行 `literalTerms(query)`（4 条正则 `matchAll`），500 行就是 500 次；`terms.length` 为 0 时不进该分支 | 低 | 未修 | `memory-plugins.md` |
| M-14 | 标签大小写三处不一致：`memory.search` 过滤两边 `toLowerCase()`；`dream.normalizeTags` 存小写；`lexicon.upsert` 存 `tags.map(String)` 原样，而 `lexicon` 工具按 `includes(String(tag))` 精确比较——大写标签写入后用小写 `tag` 查不到 | 中 | 未修 | `memory-plugins.md` |
| M-15 | `lexicon` 的 `conv` 过滤打不到 `web`：`upsert` 把 `conv === 'web'` 存成 `conv: null`，过滤是 `o.conv === conv`，因此 `lexicon({conv:'web'})` 必然为空 | 中 | 未修 | `memory-plugins.md` |
| M-16 | `lexicon` 每次 `upsert` 都把 `fading` 抹回 `active`，且 `!confirmed` 时每次都 `note.add` 同样的待办（没有去重）；连续两次无释义 `lexicon_learn` 会产生两条 `查一下「…」…` 待办（`dream` 里靠 `seenTerms` 才避免） | 中 | 未修 | `memory-plugins.md` |
| M-17 | `lexicon` 读写都封顶 500 条（`all()` 为 `memory.query({namespace:'lexicon', kind:'term', limit:500})`，`created_at ASC`），新词条查不到；`lexicon.find(term, conv)` 定义了但从未被调用 | 高 | 未修 | `memory-plugins.md` |
| M-18 | `lexicon_learn` 的 `tags` 无类型校验：schema 写 `array`，`upsert` 直接 `tags.map(String)`；调用方传字符串会抛 `TypeError`，被工具层当异常抛出而不是返回 `没记成（缺词）。` | 中 | 未修 | `memory-plugins.md` |
| M-19 | 非 QQ 身份查不到「最近的事」：`recentEventsFor` 用 `person.data?.qq ?? qq ?? ''` 与 `event.data.people` 比对，非 QQ 档案写 `qq: null`、`whois` 的 `qq` 也是 `null`，比较的键是 `''`，永不命中；且取 `slice(-limit)`（`created_at ASC`）即创建最晚的 3 条，与相关性无关 | 中 | 未修 | `memory-plugins.md` |
| M-20 | `whois` 的逐句依据查询是 O(claims × 500)：每个 claim 的每条 `evidence` 都重跑一次 `memory.query({namespace:'person', kind:'note', limit:500})`，最多 6 条 claim | 低 | 未修 | `memory-plugins.md` |
| M-21 | `whois` 不注册 `person` 命名空间：只读不写；单独启用 `whois`（不启用 `recall`/`dream`）时 `person` 不存在，`findPerson` 命中 0 行，`subject.test.mjs` 因此要手动 `registerNamespace({id:'person'})` | 中 | 未修 | `memory-plugins.md` |
| M-22 | `recall` 声明了用不上的参数：`parameters` 里有 `about`，`execute` 解构 `{kind, query, limit, cursor, tag, conv}`，`about` 从未读取；`kind` enum 来自 `Object.keys(CATEGORIES)`，`recall({kind:'resolve'})` 候选为空、只剩未整理队列里的纠正原文 | 低 | 未修 | `memory-plugins.md` |
| M-23 | `forget` 只能删 `event`/`person`/`slang`/`resolve`：固定 `namespace = CATEGORIES[kind] ? kind : 'event'`，删不掉 `lexicon` 词条、`note` 备忘或游标 | 中 | 未修 | `memory-plugins.md` |
| M-24 | 单条超预算会长期占窗：`rollCursor` 的 `items.length > 1` 保证至少留一条，`take()` 又允许第一条超预算；若某条 `tokens > budgetTokens`，它会一直留到被别的块挤到「最早」 | 中 | 未修 | `memory-plugins.md` |
| M-25 | `more` 会低估剩余：`more: candidates.length > picked.length`，而 `picked` 混了未整理 note；候选多于已给但被 note 顶掉时 `more` 仍是 `false` | 低 | 未修 | `memory-plugins.md` |
| M-26 | `memo` 的失败分支实际不可达：`没写成。` 只在 `add()` 返回 `!ok` 时出现，而 `add()` 仅在 `text.trim()` 为空时失败、`memo` 的 `text` 又必填；另外 `add()` 把正文 `slice(0,400)`，超长笔记静默截断 | 低 | 未修 | `memory-plugins.md` |
| M-27 | `estimateTokens` 只是粗估：`Math.ceil(cjk / 1.5 + rest / 4)` 与真实分词无关，10k 预算的实际 token 数随文本类型漂移 | 低 | 未修 | `memory-plugins.md` |
| M-28 | `DEFAULT_DIM = 1024` 是死常量（`memory/src/index.mjs:17` 定义后未使用），维度真正来自 `manifest.slots[0].requires.dim` | 低 | 未修 | `memory-plugins.md` |
| M-29 | `search` 的 `conv` 过滤会丢掉无 `data` 的行：`if (!row.data) return false`，手工写入的旧行按会话过滤时直接消失 | 中 | 未修 | `memory-plugins.md` |
| M-30 | `recall` 每次调用都写库：`saveCursor(nextCursor)` 无条件执行，即使 `picked` 为空也 `memory.put` 一次游标行（`updated_at` 变、`text` 重写） | 低 | 未修 | `memory-plugins.md` |
| M-31 | `recallable: false` 只挡住 `memory.search`，没挡住未整理队列：`pendingNotes` 走 `memory.query({namespace, kind:'note', limit:200})`（`memory:224`），那里没有 `recallable` 判断，而 `namespaces` 在 `kind` 缺省时就是 `Object.keys(CATEGORIES)`（含 `resolve`）——`remember({kind:'resolve'})` 写下的纠正会被 `recall()` 当未整理碎片返回，与 `CATEGORIES` 注释「不参与 recall 检索」相反；带 `tag` 时该队列为空，泄露不发生 | 高 | 未修 | `memory-plugins.md` |

### 5.3 dream 与生活侧（dream-and-life.md）

| ID | 事实 | 严重度 | 状态与依据 | 来源 |
|---|---|---|---|---|
| D-1 | instruction 换行是字面 `\n`：`events`/`people`/`cleanup`/`slang` 用 `.join('\\n')`（`dream:214,341,440,562`），模型收到反斜杠+n；只有 `wash`（`:153`）与 `lexicon` 的 `rules`（`:735`）是真换行 | 高 | 未修 | `dream-and-life.md` |
| D-2 | `wash`/`lexicon` 不带人格：只有 `ask()` 才拼 `persona`（`dream:77-86`），这两个 job 直接 `ctx.slots.call`（`:141-158,736-742`）；文件头「摘要器的人格由 config.persona 提供」只对一半 job 成立 | 中 | 未修 | `dream-and-life.md` |
| D-3 | 幂等约 **29 天**后失效：`alreadyRan` 查 `dream-run` limit 200，而 `memory.query` 是 `created_at ASC LIMIT`（`memory:233`）→ 最早 200 行；实测 200 条历史 run 行后第二次 `events` 不再 `already-ran` | 高 | 未修 | `dream-and-life.md` |
| D-4 | `person` note 永不标 `consolidated`：标记循环只遍历 `String(n.data?.qq ?? '')`（`:411-412`），分组键却是 `${kind}:${value}`（`:282`），`name`/`mc` 主体没有 `data.qq`；实测跑完 `people` 后 note 的 data 仍无 `consolidated` → 每晚重复进提示词、recall 里永远 `[未整理]` | 高 | 未修 | `dream-and-life.md` |
| D-5 | `people` 的跨天上下文恒为空：`relatedEvents` 用 `b.data.people.includes(qq)`，此处 `qq` 是 `qq:42` 形态（`:294-295`），event 块存的是 `42`；`pastNotes` 用 `String(n.data?.qq) === qq`（`:297-298`）同理永不相等；实测 user 消息里只有 `内部编号/现有档案/今天记下的` | 高 | 未修 | `dream-and-life.md` |
| D-6 | `cleanup` 改写丢 body：`:615` 先 `patch({text})`，`:616` 再 `patch({data:{...existing.data, body}})`，`:619` 又用 patch **之前**捕获的 `existing.data` 写 evidence → body 被旧值覆盖；实测 text 变新、body 仍旧 | 高 | 未修 | `dream-and-life.md` |
| D-7 | 重跑会降级已有事件的 evidence：key 固定 `evt:<day>:<hash(summary)>`（`:225`），输入又已滤掉 `consolidated`（`:199`），同一 summary 再 upsert 时 `validEvidence` 拿不到原 id → `evidence:[]`、`provisional:true`（实测 `force` 后证据清空） | 高 | 未修 | `dream-and-life.md` |
| D-8 | `force` ≠ 重来：只跳过 `alreadyRan`；`seenTerms`、`askedThisRun`、已消化 note 都不复位（`:487-491,749`），所以 `force` 重跑 `events` 的可用素材反而更少（同 D-7） | 中 | 未修 | `dream-and-life.md` |
| D-9 | 时区只影响日期字符串：`ymdInTz` 用 `config.timezone`，`dayStartOf` 写死 `+08:00`（`:685-690`）；`dayKey`/`dayRange` 用本机时区（`:22-31`） | 中 | 未修 | `dream-and-life.md` |
| D-10 | `slang` 依赖 recall 注册的命名空间：`event/person/slang/resolve` 由 recall 的 `CATEGORIES` 注册（`recall:34-51`），dream manifest 只要求 memory+rhythm；无 recall 时写 `slang` 抛 `命名空间没有注册：slang`（实测 `event` 同类错） | 高 | 未修 | `dream-and-life.md` |
| D-11 | `lexicon` 的 `reason` 从不被要求：instruction 只出 `content/source_id`，代码按 `item.reason` 选 tag（`:758`）→ 恒 `['待查']`；实测 origins 只有 `{status:'candidate',seenAt}` | 中 | 未修 | `dream-and-life.md` |
| D-12 | 死代码：`events`/`people` 的 `const { start, end } = dayRange(now)` 未使用（`:195,270`）；`lexicon` 的 `const today = memory.query(...); void today`（`:699-700`）、`known` 算完没用（`:714`）；event 块 `...(evidence.length ? {} : {})` 空操作（`:233`）；`people` 重复的 `if (!notes.length)`（`:275,285`） | 低 | 未修 | `dream-and-life.md` |
| D-13 | `wash` 的 `origin` 实际拿不到：只在原始行有 `conv` 时才写（`:173`），而 dsh-raw 的 `list` 只返回 `{text,time,role}`（`dsh-raw:97`） | 中 | 未修 | `dream-and-life.md` |
| D-14 | `data.sources` 语义偏了：写的是本次输入全部 note 的 key（`:241`），不是被块引用那些；wash note 无 key 时为空 | 中 | 未修 | `dream-and-life.md` |
| D-15 | `index` 在无嵌入时也记账：`indexed:0` 仍 `recordRun`（`:662`），当天不再重试 | 中 | 未修 | `dream-and-life.md` |
| D-16 | enable 时可能双跑：`if (rhythm.isDue()) void run()`（`:839`）与手动 `dream.run` 无锁；实测同一天 `events` 跑了两遍 | 中 | 未修 | `dream-and-life.md` |
| D-17 | `world-state` 的 `order` 是死配置，组标题与 cap 都取「第一个」（`:74-77,86-87`）：`rhythm` 的 `title:'作息'`、`cap:1` 均不生效；`clock` 行出现 `。；`；世界段无标题，模型无法从文本判断这是世界状态 | 中 | 未修 | `dream-and-life.md` |
| D-18 | `compaction` 的 `latest()` 越老越准：`memory.query(limit:20)`（ASC）后再按 `createdAt` 降序取第一（`:15-18`），第 21 条摘要之后注入的是「最早 20 条里最新的那条」 | 中 | 未修 | `dream-and-life.md` |
| D-19 | dsh-raw 的 `list` 不是最近 N 条：文件按 mtime 降序、文件内按行序，`list` 直接 `.slice(0,limit)`（`:94-97`），core 的 `raw.list` 还跨 source 合并后再 `.slice(0,limit)`（`services.mjs:69`） | 中 | 未修 | `dream-and-life.md` |
| D-20 | model-manager 只有第一个 chat 生效：只有第一个 chat 供应商 `ctx.model.bind`（`:61-67`），其余 chat provider 的 `call` 仍走同一个 `ctx.model.chat`；`autoBind` 也只绑第一个匹配（`services.mjs:598-609`）——`config/icl.example.json` 的两个 chat（`deepseek`、`llama-swap-chat`）只有先出现的可用 | 高 | 未修 | `dream-and-life.md` |
| D-21 | `editor` 的 `maxBytes` 只管读：`write_file`/`append` 无大小上限（`:42-51`）；`list_dir` 固定 100 项且不递归 | 中 | 未修 | `dream-and-life.md` |
| D-22 | bili 依赖绝对路径：Python 解释器、storyboard CLI、`ICL_ROOT` 默认值全是机器相关绝对路径（`:10-14`）；`bili_frames` 的 `imagePath` 只是本地临时文件路径，未接投递/图片通道（`:128`） | 高 | 未修 | `dream-and-life.md` |
| D-23 | `config.persona` 语义不一致：dream 把 `config.persona` 当正文、`config.personaFile` 当路径（`dream:75,851-854`）；`config/icl.example.json` 的 `persona` 是路径且只被 `tools/wire-check.mjs:38` 读成 persona 卡的 `card`；`tools/marathon.mjs:50` 给 dream 传 `prompts/dream.md` 正文——同一个 key 三种用法 | 中 | 未修 | `dream-and-life.md` |
| D-24 | persona 版本键只含秒级时间：`v:<stamp>-<++versionSeq>` 的时间戳精确到秒、`versionSeq` 是进程内计数（`persona:23,56`），跨进程同秒同序号会撞同一个 key，而 `memory` 的 `(namespace,key)` 唯一索引是 upsert，会覆盖旧版本（`memory:47`） | 高 | 未修 | `dream-and-life.md` |

### 5.4 工具与外部接缝（tooling-and-tests.md）

| ID | 事实 | 严重度 | 状态与依据 | 来源 |
|---|---|---|---|---|
| T-1 | `recall-bench.mjs` 会改写自己的「冻结题库」：`:117` 文件缺失时写一份，`:166` `--refresh-person` 时直接覆盖 `tools/fixtures/bench-qq.json`；「冻结」只对默认路径成立，历史 baseline 不可复现 | 中 | 未修 | `tooling-and-tests.md` |
| T-2 | `marathon.mjs` 的 `cfg.plugins` 是死配置：`config/marathon.json:10` 列了 8 个插件，但 `marathon.mjs:51` 的 enable 列表硬编码 9 个（多一个 `dream`），配置里的 `plugins` 从未被读取 | 低 | 未修 | `tooling-and-tests.md` |
| T-3 | `marathon.mjs` 用 `DASHSCOPE_API_KEY`（`:58`），而 `config/icl.local.json` 的 chat 供应商用 `apiKeyEnv: "DEEPSEEK_API_KEY"`；两套凭据名不一致，`wire-check` 与 `marathon` 不共享 key | 中 | 未修 | `tooling-and-tests.md` |
| T-4 | `replay.mjs` 的 TDZ 隐患：`:235` 注册的 raw 源闭包里用 `msgs`，而 `const msgs` 在 `:258` 才声明；当前调用顺序没触发，但任何在 `:258` 之前调用 `raw.list/search` 的路径都会抛 `ReferenceError` | 中 | 未修（潜在） | `tooling-and-tests.md` |
| T-5 | `replay.mjs` 只读 `.zstd`（`:70`），`dsh-raw` 同时支持 `.jsonl` 与 `.jsonl.zstd`（`dsh-raw:13`）；两个「读 DSH 会话」实现是两套代码、口径不同（replay 只取 `>20` 字的 assistant 文本，dsh-raw 不设字数门槛） | 中 | 未修 | `tooling-and-tests.md` |
| T-6 | `dream-eval.mjs` 的「假模型」路径不验证质量：`fakeModel()`（`:53-75`）按 system 关键词返回写死 JSON，覆盖率必然 100%；不加 `--real` 只证明管线通 | 中 | 未修 | `tooling-and-tests.md` |
| T-7 | 报告产物已生成但不受版本控制约束：`recall-bench.json`(5.2KB)、`recall-diagnose.json`(7.3KB)、`replay-report.json`(3.2KB) 在仓库根；`state/` 被 `.gitignore` 忽略，这三个不在忽略列表里 | 低 | 未修 | `tooling-and-tests.md` |
| T-8 | icl-live 真 bug：`index.mjs:134` `host.services.get('rhythm')`——`createHost()` 返回的 `services` 里**没有 `get`**（`host.mjs:134` 只有 10 个服务），这行抛 `TypeError` 被 `catch` 吞掉 → `rhythm` 恒为 `null` → `:147-151` 的 30 秒 `tick()` 永远算不出 `nextAt` → **「到点自己整理」从来不触发**；`STATUS.md:163` 与 `TECHNICAL.md` 的「到点自动」因此不成立；手动 `dream_now` 工具（`:158-175`）不受影响 | 高 | 未修；插件当前已停用 | `tooling-and-tests.md` |
| T-9 | icl-live `dream_now` 结果字段取 `r.notes ?? r.blocks ?? r.learned ?? r.written`（`:167`），与各 job 实际返回部分对不上（`wash→notes`、`events→blocks`、`cleanup→merged/rewrites/consumed`），所以对 cleanup 会打印空串 | 低 | 未修；插件当前已停用 | `tooling-and-tests.md` |

### 5.5 文档说「已修」但仍有余留风险

1. **`ICL_TOOL_TIME`**：`core.md` 记为 `5d8c190` 已修（原为死代码）；`tooling-and-tests.md` 确认现在为真（`host.mjs:13` 传 `stampTime`、`services.mjs:270` `execute: stamped`）。但 `core.md` 正文仍按「死代码」叙述且未标注修复范围；`memory-plugins.md` §2 直接按「可用」描述；三份文档口径不一致。风险：任何后续文档若直接引用 `core.md` §7 第 1 条，会写出与当前代码相反的结论；`stamped` 对哪些工具返回形状生效，文档未说明（`core.md`、`memory-plugins.md`、`tooling-and-tests.md`）。
2. **`AUDIT.md` 的风险「事件 job 只要有任一块写出就全标已消化」**：已被 `partial-coverage.test.mjs` 推翻（只标被 `evidence` 引用的 note）。但同一缺陷在 `people` 维度**仍在**（D-4：person note 永不标 `consolidated`），所以「已修」只覆盖 `events`，不能推广到 `people`（`tooling-and-tests.md`、`dream-and-life.md`）。
3. **`DIAGNOSIS-THIN-MEMORY.md` 的「原文截断 240 字/200 行」**：代码已改成总预算 `washChars=12000` / 单行 `washLineChars=1200`（`dream/src/index.mjs:127-128`），与文档提的方案一致；`wash` 的「一句话」也改成「两三句」（`:149-151`）。但 job 内仍有硬截断：`events` 的 `summary` 200、`body` 4000、`people` 的 `profile` 2000、`narrative` 4000、`lexicon` 行 200 行/整段 8000（`tooling-and-tests.md`、`dream-and-life.md`）。
4. **`MEMORY-DESIGN.md` 的 `minScore`**：§十七写 0.55、§十八写「已改默认 0.50」，代码是 `0.5`（`eager-recall/src/index.mjs:15`）——已改，但 §十七 那张对比表仍过期（`tooling-and-tests.md`）。
5. **`STATUS.md:83` 的 `ICL_TOOL_TIME` 说法**：现在是真；`core.md` 的「死代码」是旧结论（`tooling-and-tests.md` 明确提示「读时注意」）。

---

## 6. 测试覆盖与空白

### 6.1 基线

35 个文件、146 条断言，全部走 `createHost()` 在 `os.tmpdir()` 建临时库，**没有一个测试碰真实 DSH、真实模型、真实网络**（`tooling-and-tests.md`）。`test()` 调用数逐文件 `Select-String "^test\("` 合计 146，与 `TECHNICAL.md:99` 一致（`tooling-and-tests.md`）。

### 6.2 逐文件覆盖（括号内为该文件断言数，合计 146）

| 测试文件 | 断言证明了什么 | 覆盖模块 |
|---|---|---|
| `adapter-dsh.test.mjs` (4) | 注入后 `dsh.names()` 恰为 8 个工具名；`presets.use('mem-only')` 后只剩 3 个；`dispose()` 后为空；`turn()` 含 `context.onAssemble` 文本。`dsh` 是 `fakeDsh()`（:15-28）手写 stub，只有 `tools.register` 与 `systemPrompt.section` | `adapter-dsh.mjs` + `surface`/`presets` |
| `archive-fallback.test.mjs` (3) | 块不含路径时 `recall` 匹配 `/出处\|原文\|写权限/`；块已含路径时 `doesNotMatch(/出处：/)`（空转，见 M-1）；普通问句不触发原文层 | `recall` 的 raw 回退 |
| `boundary.test.mjs` (4) | 静态扫 `packages/plugins/*/src/*.mjs`：禁 `@deepseek-ai/dsh-tools`、禁 `fetch(`（仅 `model-manager` 放行）、禁 `baseUrl:`/`apiKey:` 字面量；`manifest.slots` 禁 `model`/`baseUrl` | 全部插件源码 + manifest |
| `cleanup-person.test.mjs` (2) | user 提示必须出现 `people=42`，system 必须出现「人物块可以用」；rewrite 后人物块含「养猫」且 `data.evidence` 有 `type:'block'` | `dream.cleanup` |
| `cleanup.test.mjs` (5) | `merges` 保留 keep、drop 标 `superseded:true` 且 `mergedFrom.length===1`；`uncertain:true` 落库；`rewrites`+`consumed` 改写人物块并把 resolve note 标 `consumed`；第二次同 job `skipped:'already-ran'`；只有一块时 `nothing-to-do` | `dream.cleanup` |
| `compaction.test.mjs` (3) | `dropped===2`（keepRecent:2）且装配文本含「压缩摘要」；1 条历史 `dropped===0`；模型返回空串时 `{ok:false,error:'empty-summary'}` | `compaction` + `context.compact` |
| `consume.test.mjs` (2) | `memo_commit({result})` 后词条 `status==='confirmed'`、备忘 `archived`；不传 result 时 `written===0` 且停在 `done` | `dream.consume` + `note` + `lexicon` |
| `context.test.mjs` (5) | `provideHistory` 截 limit；`onAssemble` 只能看到 history 并贡献文本；disposer 后装配变空串；未注册压缩器 `{ok:false,error:'no-compactor'}`；`maxChars:100` 时输出 ≤100 | `services.context` |
| `delivery.test.mjs` (5) | 同 `source` 二次 push 得 `{accepted:false,deduped:true}`；ack 后水位 9 且旧 seq 不再重发；push 抛错时 `pendingCount()===1`、下一轮送达；同 `batchKey` 合成一次 push；`to:'other'` 不归本会话 | `services.delivery` + `session.drainOnce` |
| `dream-jobs.test.mjs` (9) | events 出 2 块、block 带 `people`/`sources`、note 全标 `consolidated`；幂等 `already-ran`；模型抛错 `ok:false` 且 note 无 `consolidated`；people 建档 `person:42` + `ids` + `familiarity` + `facts`；材料少 `provisional:true`；空 profile 用笔记原文兜底；slang 同 term 只 1 块；系统提示含「记忆沉淀器」；` ```json ` 包裹也能解析 | `dream` 全 job + `memory` |
| `dsh-raw.test.mjs` (2) | 注册 raw 源后能搜到会话原文且过滤 `Current runtime context`；`recall` 补一句「原文」并含 `qwenstuff`。写入的是**未压缩** `session.v4.jsonl`（:18），`decode()` 的 `.zstd` 分支未覆盖 | `dsh-raw` + `recall` |
| `eager-recall.test.mjs` (5) | 命中时 `turnText` 含「你可能记得」「仅供参考」；`minScore:0.8` 返回空串；`maxItems:2`/`maxChars:120` 生效；disable 后归零；注入后 `delivery.drain('session')` 为空 | `eager-recall` |
| `focus-model.test.mjs` (8) | 无 focus 全穿；glob 穿透（`qq:private:*` always、`qq:group:11` 需 mention、`qq:group:*` never、`timer` always）；TTL 过期 `current()===null`；`release()` 立刻失效；slots 形状不符 `autoBind()` 返回 `[]`、匹配则绑定；768 维接不上 1024 插槽；`pause()` 中止在飞请求且后续抛 `MODEL_PAUSED`；401 后重试一次成功（`calls===2`） | `services.focus`/`slots` + `model-client` |
| `host.test.mjs` (6) | enable 前 `toolNames()` 空、enable 后 `['world_status']`；disable 后为空；提示词段「现在是 」随启停出现/消失；world(10) 在 persona(20) 前且无 `\n\n\n`；`apply` 抛错时半个工具都不留；非法 id / 缺 version / 缺 apply 三种都抛 | `host.mjs` + `contracts.mjs` |
| `identity-e2e.test.mjs` (1) | `subjectKind:'mc'` 写入 → people job → `block.data.subject.kind==='mc'` → `whois({subjectKind,value})` 打回「一起玩 MC」 | `memory` + `dream` + `whois` |
| `lexicon-dream.test.mjs` (2) | 新词 `learned===1`、进 `note.count()===1`、词条 `status:'candidate'`；老词 `faded===1`、`usageState==='fading'`、`decay.weight<1` | `dream.lexicon` + `lexicon` |
| `lexicon.test.mjs` (4) | 无释义 → 候选 + 待办（`about.namespace==='lexicon'`）；有释义 → 回「已确认」「绷不住了」且待办不重复；一词两来源分行显示 `group:1`/`bili`；`conv`/`platform` 两种查询都命中 | `lexicon` |
| `literal.test.mjs` (4) | 带 Windows 路径、长文件名、带单位数字的查询，命中项必须排第一；无精确串的普通问句不受影响 | `memory.search` 精确串加权 |
| `loop.test.mjs` (2) | resolve → cleanup 改写人物块含「男的」、`note.count()===0`、关闭记录 `status:'resolved'` 且 `answer` 含「男的」；无 `about` 的纠正不关无关疑问 | `dream.cleanup` + `note` |
| `m1-plugins.test.mjs` (8) | 命名空间隔离；`remember` 落 `event`/`note` 且无第二份库；768 维供应商 `unmatched().length===1`、`resolve` 为 null；1024 维自动接上；rhythm 触发 dream 写出含「看海」的块；无笔记 `skipped:'no-notes'`；recall 未先 enable memory 抛「需要先启用插件：memory」；disable 后 `shared.get('memory')` 为 null | `memory`/`dream`/`rhythm`/`model-manager` |
| `m1b-persona-world.test.mjs` (8) | persona `set` 立刻进系统提示；两次 set 后 `versions().length===2`、`rollback(1)` 回到「第二版」；无 memory 时 `versions()` 空；持久化在 `persona`/`persona-current`；world `cap:2` 只露两条且带「（还有 1 项）」；`read({owner,item})` 展开 detail、缺失项回「没有这一项」；来源返回 `[]` 时彻底消失；工具面只有 `world_status` | `persona` + `world-state` |
| `note-updates.test.mjs` (3) | `memo_append` 后 `note.count()===1` 且内容可见；`memo_commit` 后 open 归零、`memos({done:true,all:true})` 仍列原文；默认只列今天，`all:true` 才出现昨天 | `note` |
| `note.test.mjs` (4) | `memo` 建立/`resolve` 结掉后回「没有待办」；世界状态 brief 出现「还有 1 件事没了结」；`recall` 搜不到 memo；无 world-state 也能用 | `note` + `world-state` |
| `origin-tags.test.mjs` (2) | `origin.conv` 过滤：`group:1` 能搜到「爬山」、`private:2` 搜不到；`tag` 检索命中「海边」不命中「加班」；`mem.tags({})` 有「同事」 | `memory` + `recall` |
| `partial-coverage.test.mjs` (1) | 只把被 `evidence:[1]` 引用的那条 note 标 `consolidated`，另一条保持 `undefined`，`deferred===1` | `dream.events` |
| `pending-notes.test.mjs` (3) | 模型回 `[]` 时 `blocks 0 / deferred 1`、note 无 `consolidated`、碎片仍可 `recall`；30 小时前的碎片可召回且带「未整理」；空 profile 用原文兜底并与 `qq:'99'` 建档 | `dream.events`/`people` + `recall` |
| `presets.test.mjs` (3) | 默认 `active()==='default'` 且含 `remember`/`memo`；自定义预设切走后 `memo` 消失、切回恢复；`list()` 里 `plugins===['note']`、`allowed().length===1` | `services.presets` + `surface` |
| `recall.test.mjs` (8) | `[今天]` 前缀；`kind` 只召回一类；默认召回全类；第二次带 cursor 不重复同一行；500 token 预算下反复召回能回到最早那条；召回后 `weight` 上升且 `lastRecalledAt` 非空；未消化旧片段带「未整理」、已消化不再出现；`forget` 只删指定 key | `recall` + `memory` 权重 |
| `rhythm.test.mjs` (5) | 同日第二次 `fire(...).fired===false`；`isDue` 到点前 false、到点 true、发过后 false；跨 host 重启（同 `stateFile`）`lastFiredDay==='2026-11-01'` 且不再触发；次日到点 true 并写 `2026-11-02`；`nextAt(20:00)===22:30` | `rhythm` |
| `route-person.test.mjs` (1) | `kind:'person'` 直接返回 `[人物]` + 档案 + 「依据」，不混入事件块 | `recall` 人物路由 |
| `subject.test.mjs` (3) | 通用 `subject:{kind:'mc'}` 能被 `whois` 查到；只有 `qq` 字段的旧档案仍可查；`findPerson({subject})` 命中 | `whois` + `memory.findPerson` |
| `surface.test.mjs` (4) | 只列已启用插件的工具且 `plugin:'recall'` 归属正确；enable note 后出现 `memo`/`memos`；disable 后立即收缩并触发 `onChange`；`summary()` 里 recall 贡献三个工具 | `services.surface` |
| `tool-constraints.test.mjs` (6) | `composeToolDescription` 拼 `Use when:`/`Avoid when:` 且无 `safety` 时不出现 `Safety`；长描述压到 ≤300 且以 summary 开头；超预算先砍行再截正文、不产生空串；工具索引随 disable 更新；60 个工具时截断并写「还有 N 个工具」；`whois` 最终描述 ≤ `TOOL_TEXT_LIMITS.perTool` | `services.tools` + `session.systemPrompt` |
| `vector-backfill.test.mjs` (4) | 无嵌入时 `missingVectors()` 列出全部带文字条目；`jobs:['index']` 后 `indexed===2`、`stats().vectors===2`、缺失归零；再跑 `skipped:'nothing-missing'`；`dream.run({jobs:['index']})` 可单独调用 | `memory` 向量 + `dream.index` |
| `whois-tags.test.mjs` (7) | 按 QQ 命中并回 `mc:DeepSeekBot` 与 `friend`；按 MC id 命中；同名两人回「2 个可能的人」；`people:['7']` 的事件只带三条；无档案回「还没有」；`tag` 只过滤不参与打分；`normalizeTags` 上限 5、小写、去重、超长丢弃 | `whois` + `recall` + `dream.normalizeTags` |

（整表 `tooling-and-tests.md` §一）

### 6.3 完全没有测试的行为（盲区，逐条）

| 没被测的东西 | 证据 | 文档标注的风险 |
|---|---|---|
| **真实 DSH 适配** | `adapter-dsh.test.mjs:15-28` 的 `fakeDsh()` 只有 `tools.register` 与 `systemPrompt.section`；`ctx.tools.register` 的返回值、参数 schema 校验、`systemPrompt.section` 的真实签名都没验过 | 契约只要有一处不同，注入就静默失败 |
| **`icl-live` 端到端** | 没有任何测试文件提到 `icl-live`；`node --test packages/core/test` 不可能加载它 | 「18 个工具注册成功」只有文档里的 mock 干跑，且 T-8 的 dream tick 已确认是坏的 |
| **DSH 内压缩（compaction）** | `compaction.test.mjs` 只经 `context.compact` 调用插件，没有任何 DSH 侧 `onCompact` 接线测试；`STATUS.md:99` 自认「未联调」 | 真实压缩改写历史后，`dsh-raw` 读到的原文与做梦假设不一致 |
| **bili 接缝** | 35 个测试文件里 0 个 import `plugins/bili`；`bili-run.py` 也没有测试 | 四个工具全靠路径与 venv 正确；坏了只回一句中文 |
| **`bili_frames`** | 同上；`execFileSync` 阻塞 600 秒的行为没有任何超时/取消测试 | 一次坏链接可能卡住一整轮 |
| **做梦产出的质量** | `dream-eval.mjs` 默认走 `fakeModel()`（写死 JSON，必然 100% 覆盖）；只有 `--real` 才量真质量，而它不在 `npm test` 里 | 「做梦好不好」只能人工跑，没有回归闸门 |
| **`dsh-raw` 的 `.zstd` 分支** | `dsh-raw.test.mjs:18` 写的是 `session.v4.jsonl`（未压缩），`decode()` 的 `zstdDecompressSync` 从未执行 | 真实会话日志是 `.jsonl.zstd`，解压失败会被 `catch` 吞成空串 |
| **`editor` 的路径逃逸防护** | `editor/src/index.mjs:11-14` 的 `inside()` 零测试；`packages/plugins/editor` 不被任何测试 import | 这是唯一一处「不让模型写出工作区」的防护 |
| **投递的第 5 次丢弃** | `services.mjs:433` `maxAttempts=5`、`:520` 达上限即 `dropped`；`delivery.test.mjs` 只测失败后能重投 | 静默丢弃且没有观测出口（`TECHNICAL.md` #8 自认） |
| **`marathon.mjs` / `replay.mjs`** | 两个脚本都没有测试；`state/` 里 13 份运行日志是产物不是断言 | 只能靠「跑完看一眼报告」判断 |
| **真实嵌入质量** | `threshold-calib.mjs --real` 需要 `ICL_EMBED_BASE`/`ICL_EMBED_MODEL`；`docs/MEMORY-DESIGN.md:459` 的样本是 10 条消息 | 0.50 这个默认阈值没有大样本支撑 |

（整表 `tooling-and-tests.md` §六）

### 6.4 其它覆盖事实

- `editor` 是灰区：3 个工具 + 路径逃逸防护 `inside()`，但**零测试**，`STATUS.md:56` 自己标「最小可用」（`tooling-and-tests.md`）。
- `adapter-dsh.test.mjs` 的 `dispose()` 后为空数组，证明的是注销器链，不是 DSH 真实行为（`tooling-and-tests.md`）。
- `boundary.test.mjs` 是**静态扫描**（源码与 manifest 文本），不是运行时约束（`tooling-and-tests.md`）。
- `rhythm.test.mjs` 全部直接调 `fire/nextAt/isDue`，从未等真实 20s 定时器（`dream-and-life.md`）。
- `dsh-raw.test.mjs` 与 `replay.mjs` 各写一套「读 DSH 会话」的代码，口径不同（T-5）（`tooling-and-tests.md`）。

---

## 7. 文档准确性：文档说 A、代码是 B

| # | 文档说法 | 代码/实测实际 | 来源 |
|---|---|---|---|
| 1 | `STATUS.md:6` 提交 `fb4fb5e` | `git rev-parse --short HEAD` = `5d8c190`，落后 7 个提交 | `tooling-and-tests.md` |
| 2 | `STATUS.md:83` 「`ICL_TOOL_TIME=1` 时每次工具结果后追加当前时间」 | 该说法曾是假的；`5d8c190` 之后为真（`host.mjs:13` 传 `stampTime`、`services.mjs:270` `execute: stamped`、`:262` 追加 `\n（现在 HH:MM:SS ）`） | `core.md`（旧结论）、`tooling-and-tests.md`（新结论） |
| 3 | `docs/audit/core.md` §7 第 1 条仍写「`ICL_TOOL_TIME` 是死代码」 | 已被 `5d8c190` 推翻，`core.md` 自己也在括号里注明「已于 5d8c190 修复，保留为历史记录」 | `core.md`、`tooling-and-tests.md` |
| 4 | `STATUS.md` §B 说 icl-live「尚未加载成功」，§G 说已接进 profile | 当前 profile 的 `package.json` 已无任何 `icl-live` 字样（从 `dependencies` 与 `dsh.profile.bundles` 移除），三段互相矛盾 | `tooling-and-tests.md` |
| 5 | `STATUS.md:163` 与 `TECHNICAL.md` 的「到点自动整理」 | icl-live `index.mjs:134` 的 `host.services.get('rhythm')` 抛 `TypeError` 被吞 → `rhythm` 恒 `null` → 从不触发（T-8） | `tooling-and-tests.md` |
| 6 | `AUDIT.md` 「109 测试」「核心只有 6 个服务」 | 现在 146 测试、10 个服务（多 `context`/`surface`/`presets`） | `tooling-and-tests.md` |
| 7 | `AUDIT.md` 风险表第一条「事件 job 只要有任一块写出就全标已消化」 | 已被 `partial-coverage.test.mjs` 推翻（只标被 `evidence` 引用的）；但 `people` 维度仍不标（D-4） | `tooling-and-tests.md` |
| 8 | `AUDIT.md:44` 提到的旧插件名 `*-inject` | 核心不存在 `inject` 字段、`ctx.inject()` 或 injections 注册表 | `core.md` |
| 9 | `PLUGINS.md` 「39 条测试」；§三整节讲 `light-memory`；§五说 dream 写 `dream:<session>` 的 `summary` | 现为 146 条测试；`light-memory` 已不存在（能力并入 `recall`）；dream 实际写 `event`/`person`/`slang` 的 `kind=block` | `tooling-and-tests.md` |
| 10 | `DIAGNOSIS-THIN-MEMORY.md` 「原文截断 240 字/200 行 → 未改」 | 已改成总预算 `washChars=12000` / 单行 `washLineChars=1200`（`dream:127-128`）；「一句话」已改「两三句」（`:149-151`） | `tooling-and-tests.md`、`dream-and-life.md` |
| 11 | `MEMORY-DESIGN.md` §十七「阈值 minScore 0.55」 | §十八与代码都是 `0.50`（`eager-recall/src/index.mjs:15` `ctx.config.minScore ?? 0.5`） | `tooling-and-tests.md` |
| 12 | `MEMORY-INTEGRITY-DESIGN.md` §八「下一步：evidence 变成必填」 | 仍未做；`cleanup-person.test.mjs` 是喂模型给 evidence，不是强制 | `tooling-and-tests.md` |
| 13 | `NEXT.md` 把 subject 通用化、工具面、标签与来源写成待办 | 三项均已实现（`subject.test.mjs`/`identity-e2e.test.mjs`、`surface.test.mjs`、`origin-tags.test.mjs`），文档未勾 | `tooling-and-tests.md` |
| 14 | `note_status` 的 `avoid`：「use memo_list」 | 实际工具名是 `memos`，`memo_list` 不存在 | `memory-plugins.md` |
| 15 | dream 文件头「摘要器的人格由 `config.persona` 提供」 | 只对走 `ask()` 的 `events`/`people`/`cleanup` 成立；`wash`/`lexicon` 不带人格 | `dream-and-life.md` |
| 16 | 「插件可以用 `presets` 声明自己属于哪些预设」 | `validateManifest` 丢掉 `presets` 字段，该规则实际不可能排除任何插件（C-4） | `core.md` |
| 17 | `CATEGORIES` 注释「`resolve` 不参与 recall 检索」 | `recallable:false` 只挡 `memory.search`，未整理队列仍会把 `resolve` 的 note 当碎片返回（M-31） | `memory-plugins.md` |
| 18 | `STATUS.md:56` editor「最小可用」 | 与代码一致（3 工具 + `inside()`，零测试），但「最小可用」未说明无防护测试 | `tooling-and-tests.md` |
| 19 | `STATUS.md:99` compaction「未联调」 | 与代码一致：只有 `context.compact` 层测试，无 DSH 侧接线测试 | `tooling-and-tests.md` |
| 20 | `INVENTORY.md` 的 15 插件 / 35 测试 / 146 测试 / icl-live 已移除 | 全部实测一致；`TECHNICAL.md` #1/#3 也与代码一致 | `tooling-and-tests.md` |
| 21 | `SLOTS.md` 的插槽契约 | 对得上（`focus-model.test.mjs` 的 768/1024 用例、`host.mjs:164-172` 由宿主代注册 `manifest.slots`） | `tooling-and-tests.md` |
| 22 | `LEXICON.md` 的字段/aging/`candidate→confirmed` | 对得上（`lexicon.test.mjs`/`lexicon-dream.test.mjs` 兜底），但文档仍是「设计稿」口吻 | `tooling-and-tests.md` |

**文档自身口径冲突（同一事实两说）**：
- `ICL_TOOL_TIME`：`core.md` 说死代码（已修但正文未改）、`memory-plugins.md` §2 说可用、`tooling-and-tests.md` 说现在为真（#2、#3）。
- `dream` 人格：`dream-and-life.md` 文件头说由 `config.persona` 提供，正文 §2 说只有 `ask()` 才拼（#15）。
- `config.persona`：dream 当正文、`icl.example.json` 当路径、`marathon.mjs` 传正文——同一 key 三种用法（D-23）。
- `STATUS.md` §B 与 §G 关于 icl-live 是否接进 profile 互相矛盾（#4）。

---

## 附：四份文档明确「未说明」的点

- `memory` 的删除方法名（文档只写「删除」）；`memory.retention`/`schema_version` 的运行时语义（`memory-plugins.md`）。
- `persona` 的 API 全集、manifest、工具数、失败分支（`tooling-and-tests.md`、`dream-and-life.md` 只给出 `set`/`versions`/`rollback` 与版本键）。
- `host.list()` 与 `surface.summary()` 的 `preset` 字段预期语义；`slot.meta`、`provider.meta`、`focus.visible`、`delivery.channel` 的解释（`core.md`）。
- `session.mjs` 的 `log` 与 `host` 的 `log` 如何汇合（`core.md`）。
- `stamped` 包装覆盖哪些工具返回形状（`core.md`、`memory-plugins.md`）。
- `dream` 的 `slang` job 当前为何保留在 `JOBS` 表却不在默认序列（只有注释「已并入 lexicon」）（`dream-and-life.md`）。
- `icl-live` 之外是否还有其它 DSH 侧加载路径（`tooling-and-tests.md` 只测到 profile 依赖与 bundles 已移除）。


