# `packages/core` 审计：宿主、服务、适配器

> 范围：`packages/core/src/*`（`index.mjs`、`host.mjs`、`contracts.mjs`、`services.mjs`、`session.mjs`、`adapter-dsh.mjs`、`model-client.mjs`）与 `packages/core/test/*`（35 个 `*.test.mjs`）。Node 26 ESM，无构建。本文只描述现状，不含建议。

## 1. 这一层是什么（5 行）

1. ICL 是"一个机器一个实例、只指向一个指定 DSH 会话"的中间件；`packages/core` 是它的核心层，不含任何业务，只提供契约、宿主与两个适配器。
2. `createHost()` 建一个插件宿主：校验清单、登记插件、启用/停用，并把插件在 `apply(ctx)` 期间注册的一切收集成一串注销器（disposer）。
3. 宿主对外给 10 个服务：`tools`、`prompt`、`focus`、`delivery`、`slots`、`model`、`raw`、`context`、`surface`、`presets`（`host.mjs:134`）；插件只能通过 `apply(ctx)` 拿到它们的子集。
4. 两个适配器负责接线：`attachDshAdapter(host, dsh, …)` 把工具面与提示词段接到真实 DSH；`createSessionAdapter({ sessionId, host, push })` 负责系统提示词装配、工具面安装与投递队列 drain。
5. 公共出口只有 `src/index.mjs`（8 行，12 个符号）；测试全部是 `node:test`，跑法见根 `package.json` 的 `"test": "node --test packages/core/test"`。

## 2. 公共 API

### 2.1 `src/index.mjs` 转出的 12 个符号

**`createHost({ log = () => {}, now = () => Date.now(), fetchImpl = globalThis.fetch } = {})`**
返回 `{ services, registerPlugin, enable, disable, list, has, manifestOf, shared }`；`services` 是 10 键对象（`tools`、`prompt`、`focus`、`delivery`、`slots`、`model`、`raw`、`context`、`surface`、`presets`，见 §3），`shared` 是 `Map`。
测试用法（`host.test.mjs:14-16`）：`const host = createHost({ log: () => {} })`。

**`createSessionAdapter({ sessionId, host, push, toolSink = null, now = () => Date.now(), log = () => {} } = {})`**
`sessionId` 必填、`push(text, opts)` 必填，否则抛 `sessionId 必填` / `push(text, opts) 必填`。返回 `{ sessionId, toolNames, installTools, systemPrompt, toolDefinitions, drainOnce, start, stop, status }`。
测试用法（`host.test.mjs:15-19`）：`createSessionAdapter({ sessionId: 'session-test', host, push: async (text) => { pushes.push(text) } })`。

**`attachDshAdapter(host, dsh, { sessionId = null, order = 30 } = {})`**
返回 `{ sync, names, turn, dispose }`；`dsh` 只要求 `dsh.tools.register(def) -> disposer`，`dsh.systemPrompt.section({name, order, text}) -> disposer` 是可选链（`adapter-dsh.mjs:44`）。
测试用法（`adapter-dsh.test.mjs:39-41`）：`const adapter = attachDshAdapter(host, dsh, { sessionId: 's1' })`。

**`createModelClient({ fetchImpl = globalThis.fetch, now = () => Date.now(), onAuthError = null } = {})`**
返回 `{ bind, current, isPaused, pause, resume, inflightCount, chatDetailed, chat, chatInner }`。
测试用法（`focus-model.test.mjs:76-78`）：`const client = createModelClient({ fetchImpl }); client.bind({ baseUrl: 'http://127.0.0.1:1/v1', model: 'm' })`。

**`createFocusService({ now = () => Date.now() } = {})`**
返回 `{ enter, current, canPierce, list }`。
测试用法（`focus-model.test.mjs:8-9`）：`const focus = createFocusService(); assert.equal(focus.canPierce('qq:private:1').allowed, true)`。

**`createToolRegistry({ onChange = () => {}, stampTime = null } = {})`**
返回 `{ register, list, names, has, version, index }`。没有任何测试直接实例化它；宿主在 `host.mjs:12` 建，测试经 `host.services.tools` 使用（`tool-constraints.test.mjs:73`：`host.services.tools.register({ name: 'tool_${i}', ... })`）。

**`createPromptService()`**
返回 `{ section, names, onTurn, turnText, assemble }`。测试经 `host.services.prompt` 使用（`note.test.mjs:45`：`host.services.prompt.assemble()`）。

**`createDeliveryService({ now = () => Date.now(), maxAttempts = 5 } = {})`**
返回 `{ push, drain, ack, nack, watermarkOf, pendingCount, inflightCount }`。测试经 `host.services.delivery` 使用（`delivery.test.mjs:21-23`）。

**`createSlotRegistry()`**
返回 `{ onChange, declare, registerProvider, autoBind, bind, resolve, require, call, unmatched, providers, list }`。测试经 `host.services.slots` 使用（`focus-model.test.mjs:45-52`）。

**`validateManifest(manifest)`**
返回 `{ ok: true, manifest }` 或 `{ ok: false, error }`；输入非对象时 error 为 `清单不是对象`。没有测试直接 import 它，覆盖是间接的（`host.test.mjs:73-75` 三条 `assert.throws(..., /不合法/ | /version/ | /apply/)`）。

**`resolvePierce(rules = {}, fromLabel, { mention = false } = {})`**
返回 `{ allowed, level, pattern }`；默认 `level = 'mention'`、`pattern = '(default)'`。没有直接测试；间接覆盖在 `focus-model.test.mjs:12-23`（经 `focus.canPierce`）。

**`PIERCE_LEVELS`**
`Object.freeze(['always', 'mention', 'never'])`；无测试直接引用。

### 2.2 `services.mjs` 里导出、但**没有**从 `index.mjs` 转出

| 符号 | 签名 | 返回 |
| --- | --- | --- |
| `TOOL_TEXT_LIMITS` | `Object.freeze({ perTool: 900, index: 1200 })` | 冻结对象 |
| `composeToolDescription` | `(definition, { maxChars = TOOL_TEXT_LIMITS.perTool } = {})` | `string` |
| `createRawSourceRegistry` | `()` | `{ register, ids, list, search }` |
| `createContextService` | `()` | `{ provideHistory, history, onAssemble, assemble, onCompact, compactors, compact }` |
| `createToolSurface` | `({ tools, plugins, presets = null })` | `{ owners, list, names, summary, onChange, notify }` |
| `createPresetService` | `({ plugins } = {})` | `{ list, active, use, define, allowed }` |

`tool-constraints.test.mjs:6` 直接从 `../src/services.mjs` import 前两个：`import { composeToolDescription, TOOL_TEXT_LIMITS } from '../src/services.mjs'`；用法见 `tool-constraints.test.mjs:20-30`。

### 2.3 `createHost()` 返回对象上的方法

| 方法 | 返回 | 备注 |
| --- | --- | --- |
| `registerPlugin(manifestInput, module, { config = {} } = {})` | 校验后的 `manifest` | 清单不合法抛 `插件清单不合法：${error}`；缺 `apply` 抛 `${id} 缺少导出的 apply(ctx)`；重名抛 `插件重复：${id}` |
| `enable(id)`（async） | `{ enabled: true }` 或 `{ enabled: true, already: true }` | 未知 id 抛 `没有这个插件：${id}`；依赖未启用抛 `${id} 需要先启用插件：${dep}` |
| `disable(id)` | `{ enabled: false }` 或 `{ enabled: false, already: true }` | 逆序调用注销器，单个抛错被吞 |
| `list()` | `{ id, version, enabled, tools, slots: string[] }[]` | `slots` 是 id 数组 |
| `has(id)` / `manifestOf(id)` | `boolean` / `manifest \| null` | |
| `shared` | `Map<string, any>` | 插件间共享能力的只读视图（实际可 `get`/`set`） |

## 3. 服务：用途、方法、调用者

所有服务都遵守"注册即返回注销器"；除注册、投递、切换这几类会改状态的方法外，其余都是纯查询。

### `tools`（`services.mjs:245`）
用途：唯一工具注册表，名字全局唯一，描述在注册时被拼装并封顶。
- `register(definition) → () => void`：名字须匹配 `/^[a-z][a-z0-9_]*$/`，重名抛 `工具已存在：${name}`，缺 `execute` 抛 `${name} 缺少 execute`；注销器删条目并触发 `onChange({type:'unregistered'})`。
- `list() → object[]`（存的是**拼装后**的定义，见 §5）。
- `names() → string[]`、`has(name) → boolean`、`version() → number`（每次注册/注销 +1）。
- `index({ maxChars = 1200 } = {}) → string`：按 `name.localeCompare` 排序的 `- ${name}: ${summary}` 行。
调用者：`ctx.tools.register`（recall / note / whois / world-state / editor / bili / lexicon）；`session.toolNames()`、`session.installTools()`、`session.toolDefinitions()`、`session.systemPrompt()`；`createToolSurface.list()`。

### `prompt`（`services.mjs:309`）
用途：系统提示词分段注入 + 每轮临时上下文，两者都由核心统一装配、统一限长。
- `section({ name, order = 50, text, when = null }) → () => void`：`name` 须匹配 `/^[a-z][a-z0-9:_-]*$/i`，重名抛 `提示词段已存在：${key}`；`text` 必须是 `string` 或 `function`。
- `names() → string[]`
- `onTurn(provider) → () => void`：`provider({ sessionId, message, now })` 可返回字符串或 Promise。
- `turnText({ sessionId = null, message = '', now = Date.now(), maxChars = 800 } = {}) → Promise<string>`
- `assemble(ctx = {}) → string`（**同步**）：`order` 升序、同 order 按 `name.localeCompare`，段间用 `'\n\n'`。
调用者：`ctx.prompt.section`（world-state `name: 'world', order: 10`；persona `name: 'persona', order: 20`）；`ctx.prompt.onTurn`（eager-recall）；`attachDshAdapter` 的 `icl:tools-and-memory` 段与 `turn()`；`session.systemPrompt()`。

### `focus`（`services.mjs:375`）
用途：软命名空间——"她现在在哪儿"，以及别处的事能不能打断她。
- `enter({ label, owner = null, reason = '', ttlMs = null, pierce = null, visible = true }) → { id, label, owner, reason, since, expiresAt, pierce, visible, release }`；`label` 空抛 `focus.label 必填`，`id` 形如 `focus-1`，`expiresAt = ttlMs == null ? null : at + Math.max(1000, Number(ttlMs) || 0)`。
- `current() → lease | null`：最新且未过期（`expiresAt == null || expiresAt > now`）。
- `canPierce(fromLabel, opts = {}) → { allowed, level, pattern }`：无 focus 时直接 `{ allowed: true, level: 'always', pattern: '(no-focus)' }`。
- `list() → lease[]`（仅未过期的）。
调用者：宿主 `ctx.focus.enter/canPierce/current`、`session.status()`。**当前没有任何插件调用 `ctx.focus`**（`packages/plugins/*` 里零命中）。

### `delivery`（`services.mjs:432`）
用途：插件**只能**往这里 push，绝不直接对会话说话；exactly-once + ack 水位 + 批次合并 + 退避重试。
- `push({ to = 'session', channel = 'conversation', source = {}, content = {}, batchKey = null, exactlyOnce = true }) → { accepted: true, id } | { accepted: false, deduped: true }`：去重只在 `exactlyOnce` 且 `seq` 是正数时进行（比水位、也比队列/在飞里的同 seq 条目）。
- `drain(to = null) → batch[]`：把 `nextAt <= now` 的条目按 `${to}|${batchKey}` 合并成批，移出队列放进 `inflight`。
- `ack(batchId) → { ok: true, count } | { ok: false, reason: 'unknown-batch' }`：只对 `exactlyOnce` 且 `seq` 有限的条目推进 `${plugin}|${activity}` 水位。
- `nack(batchId, error = null) → { ok: true } | { ok: false, reason: 'unknown-batch' }`：`attempts += 1`；`attempts >= maxAttempts` 时标 `dropped = true` 且不回队列，否则 `nextAt = at + backoff(attempts)`。
- `watermarkOf(plugin, activity) → number`（默认 `0`）、`pendingCount() → number`、`inflightCount() → number`。
调用者：`ctx.delivery.push`、`session.drainOnce()`（唯一 drain 的消费者），其余是测试。**当前没有任何插件调用 `ctx.delivery`**。

### `slots`（`services.mjs:538`）
用途：插件只声明"我要什么形状的模型"，模型管理插件按形状接线；插件不写模型名/地址/key。
- `declare({ id, kind = 'chat', requires = {}, meta = {}, owner = null }) → () => void`：缺 id 抛 `插槽缺少 id`，重名抛 `插槽已存在：${id}`；注销器同时删绑定。
- `registerProvider({ id, kind = 'chat', shape = {}, call, meta = {} }) → () => void`：缺 `call` 抛 `provider ${id} 缺少 call`。
- `autoBind() → [{ slot, provider }]`：每个未绑定插槽取**第一个** `kind` 相同且 `requires` 逐项严格相等的 provider。
- `bind(id, binding) → undefined`：要求插槽存在、`binding.call` 是函数；写入 `{ ...binding, boundAt: Date.now() }`（注意用的是 `Date.now()`，不是注入的 `now`）。
- `resolve(id) → binding | null`；`require(id) → binding`（未绑抛 `插槽 ${id} 还没有绑定模型`）；`call(id, request) → Promise<any>`（未绑抛 `code = 'SLOT_UNBOUND'`）。
- `unmatched() → [{ id, kind, requires }]`、`providers() → [{ id, kind, shape }]`、`list() → (slot & { binding })[]`、`onChange(fn) → off`。
调用者：memory（`embed-text`）、compaction（`compact-chat`）、dream（`dream-chat`）、model-manager（`registerProvider` / `autoBind` / `onChange`）。

### `model`（`model-client.mjs:9`）
用途：集中 baseUrl、密钥、重试、暂停、超时；插件只经 `ctx.model.chat` 或插槽调用。
- `bind(next)`、`current() → object | null`、`isPaused() → boolean`、`resume() → { paused: false }`、`inflightCount() → number`。
- `pause(reason = 'paused by owner') → { paused: true, aborted: number }`：中止所有在飞请求。
- `chat({ messages = [], maxTokens = null, timeoutMs = 120_000, temperature = undefined }) → Promise<string>`
- `chatDetailed(...) → Promise<{ text, reasoning }>`；`chatInner(...)` 同 `chatDetailed`。
调用者：model-manager（`ctx.model.bind`、`ctx.model.chat`）；其余经插槽。

### `raw`（`services.mjs:48`）
用途：原文层不是"再存一份"，而是按需回原始日志里查。
- `register({ id, search, list } = {}) → () => void`：缺 id 抛 `raw source 需要 id`，缺 search 抛 `${key} 缺少 search`。
- `ids() → string[]`；`search({ query, limit = 2 }) → Promise<row[]>`；`list({ since = null, until = null, limit = 500 }) → Promise<row[]>`。
- 行统一补 `source`：`{ ...row, source: source.id }`；单个来源抛错被吞，结果按 `limit` 截断。
调用者：dsh-raw（`register`）、whois / recall / dream（`search` / `list` / `ids`）。

### `context`（`services.mjs:97`）
用途：让插件"看到本轮历史"，并在装配前贡献/改写上下文；压缩实现由适配器或旧实现提供。
- `provideHistory(fn) → () => void`（非函数抛 `history source 需要一个函数`）；`history({ sessionId = null, limit = 50 }) → Promise<array>`（无来源返回 `[]`）。
- `onAssemble({ name, order = 50, apply }) → () => void`；`apply({ sessionId, message, history })` 返回字符串或 `null`。
- `assemble({ sessionId = null, message = '', history = null, maxChars = 1200 }) → Promise<string>`：按 order/name 排序，段间 `'\n'`。
- `onCompact({ id, compact }) → () => void`；`compactors() → string[]`；`compact(input) → Promise<any>`，无实现时返回 `{ ok: false, error: 'no-compactor' }`（只调**第一个**注册的）。
调用者：compaction（`onCompact` / `onAssemble`）、`attachDshAdapter.turn()`、测试。

### `surface`（`services.mjs:156`）
用途：回答"现在应该给模型看哪些工具"，不注册任何东西。
- `owners() → Map<toolName, pluginId>`（**只**来自 `manifest.tools`）。
- `list({ preset = null } = {}) → { ...definition, plugin }[]`：过滤条件 = 属于已启用插件 + 在当前预设允许集合内。
- `names(options = {}) → string[]`、`summary() → [{ plugin, preset, tools }]`、`onChange(fn) → off`、`notify() → void`。
调用者：`attachDshAdapter.sync()`、测试。

### `presets`（`services.mjs:207`）
用途：我们自己的工具面预设，运行中可切，与 DSH 会话创建时绑死的 preset 无关。
- `list() → { id, label, allow, plugins }[]`（`plugins` 对 `allow === null` 的预设是 `null`）。
- `active() → string`（初始 `'default'`）、`use(id) → { active }`（未知抛 `没有这个预设：${id}`）、`define({ id, label = null, allow = null }) → { id }`（缺 id 抛 `预设需要 id`）、`allowed() → string[] | null`。
调用者：`surface` 构造参数、`adapter-dsh.sync()`、测试。

## 4. 契约与不变量

### 4.1 清单（`contracts.mjs:13`）
必填 `id`（`/^[a-z][a-z0-9-]*$/`）、`version`、`entry`；`tools` 必须是字符串数组；`slots` 每项必须有 `id` 与 `kind`；`focus.pierce` 的值必须在 `PIERCE_LEVELS` 内。校验通过后**重建**清单，只保留 `id`、`version`、`entry`、`tools`（默认 `[]`）、`slots`（默认 `[]`）、`focus`（默认 `{}`）、`requires`（默认 `{}`）——其它字段丢弃（实测）。

### 4.2 apply 与注销器
- 插件模块必须导出 `apply`（无则拒绝登记）；`apply(ctx)` 可同步、可异步。
- 同步 `apply` 返回 disposer 会被登记：`host.mjs:174-175` 是 `const extra = await record.apply(ctx); if (typeof extra === 'function') record.dispose.push(extra)`。因此"DSH 要求同步 apply 返回 disposer"与这里兼容——返回值是函数就收，`undefined` 也收。
- `ctx` 上每个注册动作都返回自己的注销器，宿主同时把它推进 `record.dispose`（`host.mjs:41-119`）；`ctx.onDispose(fn)` 可直接追加。
- `disable` 逆序调用，单个抛错只被 `try/catch` 吞掉，不影响其余（`host.mjs:192`）。
- `enable` 失败时把已登记的一律逆序撤销、`enabled = false`、再抛出（`host.mjs:176-182`）；清单里声明的 slots 注册失败走同一套回滚（`host.mjs:165-172`）。

### 4.3 依赖与"inject"
- 核心**没有** `inject` 这个字段或函数（全仓库仅历史文档 `docs/AUDIT.md:44` 提到旧插件名 `*-inject`）。依赖只有两种表达：`manifest.requires.plugins`（启用顺序检查）与 `ctx.services.require(name)`（运行时取共享能力）。
- `enable` 只检查 `requires.plugins` 里每个插件**当前已启用**；`disable` 不检查反向依赖、不级联。
- `ctx.services.provide(name, api)` 重名抛 `能力重复：${key}`；注销器是 `shared.delete(key)`。`get` 返回引用本身，`require` 缺失抛 `缺少依赖能力：${name}`。插件停用后，别处已持有的引用仍然可用（实测）。

### 4.4 顺序规则
- 提示词段：`order` 升序，同 order 按 `name.localeCompare`；`when(ctx)` 返回假值则跳过；段间 `'\n\n'`。
- 上下文策略：同上（order → name），段间 `'\n'`，预算 1200。
- 每轮提供者：**按注册顺序**（数组），不排序，段间 `'\n'`，预算 800。
- 工具索引：`name.localeCompare`。
- 注销：严格逆序（后注册先撤）。
- 事件：`surface.onChange` 与 `slots.onChange` 的监听器按 Set 插入顺序调用，无优先级。

### 4.5 错误处理
- 注册期（清单、重名、缺字段、非法名字）**立即抛**，不留半套。
- 装配期一律"单条失败不影响整体"：`prompt.assemble`、`prompt.turnText`、`context.assemble`、`raw.search`、`raw.list`、`surface.notify`、`slots.onChange` 的每个回调都包在 `try/catch` 里，抛错被静默跳过（连日志都没有）。
- 投递失败不丢：`session.drainOnce()` 捕获 `push` 抛错 → `nack`，条目留队列退避。
- 模型错误带 `status`；401 会调一次 `onAuthError` 并在其返回新绑定后重试一次；中止被包装成 `code = 'MODEL_PAUSED'` 或 `'MODEL_ABORTED'`。

### 4.6 同步 vs 异步
- 同步：`prompt.assemble`、`context`/`raw` 的注册、`surface.list`、`tools.list`/`index`、`slots.resolve`、`presets.*`、`session.systemPrompt`、`session.toolDefinitions`、`adapter.names`/`sync`。
- 异步：`host.enable`、`prompt.turnText`、`context.assemble`/`compact`、`raw.search`/`list`、`slots.call`、`model.chat*`、`session.drainOnce`、`adapter.turn`。
- 工具 `execute` 由插件提供，核心不强制异步（`tools.register` 只检查 `typeof === 'function'`），但测试里全部是 `async`。

## 5. 数据结构（层间流动的确切形状）

```js
// 插件交给 core 的工具定义（whois 为例，world-state 还带 description）
{ name, summary?, description?, when?: string[]|string, avoid?: ..., safety?: ...,
  parameters: JSONSchema, execute(input) -> { text: string, ... } | any }

// tools 存下来的（services.mjs:267-272）：summary 被切成首句并封顶 160，description 被重写
{ ...definition, name, summary: summary.slice(0, 160), description: composeToolDescription(definition) }

// 工具结果：core 不校验，原样交给 DSH。事实上的约定是
{ text: string, ...其它字段（recall 的 cursor、note 的 id 等） }

// 提示词段（prompt.section 入参）
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

`ctx` 本身的形状（`host.mjs:33-131`）固定为 `{ id, manifest, log, now, onDispose, tools, prompt, focus, delivery, slots, services: { raw, context, provide, get, require, list }, model, config, fetch }`。

## 6. 模型实际看到什么

### 6.1 交给 DSH 的四个字段
`adapter-dsh.mjs:30-35` 只传四个：`name`、`description`（拼装后的）、`parameters`、`execute`。`summary`/`when`/`avoid`/`safety` 不进 DSH，只用来生成 `description`。

### 6.2 工具描述怎么拼（`composeToolDescription`）
0. 索引用的 `summary` 在注册时先算：`String(definition.summary ?? definition.description ?? '').trim().split(/(?<=[.!?])\s/)[0]`，再 `.slice(0, 160)`；描述拼装用的是**原始** `definition.summary`，不是这个截断值。
1. `head = [summary, description].map(trim).filter(Boolean).join(' ')` —— 用途在前，细节在后。
2. 三段可选要点，顺序固定 `Use when` → `Avoid when` → `Safety`，格式 `${label}: ${items.join('; ')}.`。
3. `text = [head, ...bullets].filter(Boolean).join(' ')`。
4. 超 `maxChars`（默认 900）：先 `pop()` 尾部要点行，仍超就 `slice(0, Math.max(40, maxChars - 1)).trimEnd() + '…'`。

实测输出（也即测试 `tool-constraints.test.mjs:19-30` 断言的那串）：
`"Look up a person. Use when: someone mentions them; you need their account ids. Avoid when: when you only want an event."`

### 6.3 工具索引（`tools.index()`）
一行一个、按名排序：`- ${t.name}: ${t.summary}`，默认预算 1200 字符。超预算时逐行累加到 `used + row.length + 1 > maxChars` 为止，再追加 `\n…（还有 ${rows.length - lines.length} 个工具）`。实测：

```text
- a_tool: ay
- b_tool: bee
- t_0: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
（t_1…t_6 同样 40 个 x，略）
…（还有 1 个工具）
```

### 6.4 系统提示词（`session.systemPrompt()`，`session.mjs:31-36`）
顺序固定三段，`filter(Boolean).join('\n\n')`：
1. 核心行：`你正在通过 ICL 运行。当前会话：${sessionId}。`
2. 有工具时：`现在开着的工具：\n${index}`。
3. `host.services.prompt.assemble({ sessionId, ...ctx })` 的结果（各段再按 §4.4 排序、`'\n\n'` 连接）。

实测（world order 10、persona order 20）：

```text
你正在通过 ICL 运行。当前会话：s-1。

现在开着的工具：
- wt: world status

现在是 10:00。

我是大肥鱼
```

`attachDshAdapter` 走的是**另一条**路径：它向 DSH 注册 `{ name: 'icl:tools-and-memory', order, text: () => host.services.prompt.assemble({ sessionId }) }`（`adapter-dsh.mjs:44-48`），即只有第 3 段，没有核心行、也没有工具索引。

### 6.5 每轮临时上下文
- `adapter.turn(message)`：`Promise.all([prompt.turnText({sessionId, message}), context.assemble({sessionId, message})])`，两段 `filter(Boolean).join('\n\n')`。
- `prompt.turnText`：提供者按注册顺序，段间 `'\n'`，预算 800。
- `context.assemble`：策略按 order/name，段间 `'\n'`，预算 1200。

### 6.6 预算常量表

| 常量/位置 | 值 | 作用 |
| --- | --- | --- |
| `TOOL_TEXT_LIMITS.perTool` | `900` | 单个工具描述上限 |
| `TOOL_TEXT_LIMITS.index` | `1200` | 工具索引上限 |
| `tools.register` 的 `summary` | `160` | 索引行用的首句上限 |
| `prompt.turnText` `maxChars` | `800` | 每轮上下文默认预算 |
| `context.assemble` `maxChars` | `1200` | 装配预算 |
| 截断后缀 | `'…'` | 三处截断共用 |
| `delivery` `maxAttempts` | `5` | 超过即丢 |
| `delivery` 退避 | `attempts <= 1 ? 0 : min(60_000, 500 * 2 ** (attempts - 2))` | 毫秒 |
| `focus` `ttlMs` 下限 | `1000` | 毫秒 |
| `model` 默认 `timeoutMs` | `120_000` | 单次请求 |
| `session.start` 间隔 | `1000`（下限 `200`） | 毫秒，`unref()` |

### 6.7 工具结果文本
核心**不生成**也不改写结果：`attachDshAdapter` 把 `def.execute` 原样转给 DSH，`session.toolDefinitions()` 返回的也是同一个函数。唯一存在过的改写点是 `services.mjs:258-266` 的 `stamped` 包装（`out.text += \`\n（现在 ${stampTime()} ）\``，注意 `）` 前有一个空格），但 `composed`（`:267-272`）没有引用它，所以 `ICL_TOOL_TIME=1` 今天不产生任何效果（实测返回仍是 `{"text":"done"}`）。实际看到的文本全部由插件写死，例如 note 的 `记下了。`、`没有待办。`、`待办 ${open} 条，已完成待回收 ${done} 条，已归档 ${archived} 条。`，whois 的 `还没有这个人的档案。`，recall 的 `[今天] ` 前缀行。

## 7. 已知缺口与脆弱点（均可由代码证明）

1. **`ICL_TOOL_TIME` 曾经是死代码（已于 5d8c190 修复，本条保留为历史记录）。** `services.mjs:258` 计算了 `stamped`，`:267-272` 的 `composed` 却 `...definition` 展开原始 `execute`，`stamped` 从未被引用；实测 `{ text: 'done' }` 原样返回。`docs/STATUS.md:83` 声称"每次工具结果后追加当前时间"，与代码不符。
2. **启用插件不会把新工具推给已挂上的 DSH 适配器。** `enable()` 在 `apply` **之前**调 `surface.notify()`（`host.mjs:160`），而 `ctx.tools.register` 只触发 `tools` 的 `onChange`（仅写日志，`host.mjs:13`），不触发 `surface.notify`。实测：适配器先 attach、再启用插件，DSH 侧工具集仍是空；必须等下一次 `surface.notify()`（例如另一个插件 enable/disable）才会补上。
3. **`sync()` 每次都会重注册全部工具。** `adapter-dsh.mjs:27-38` 对每个 `want` 都先 dispose 旧的、再 register，并 push 进 `added`，所以 `added` 永远是"当前全量"而不是增量；实测连续两次 `sync()` 的 `added` 都是 `['b_tool']`，注册计数从 3 涨到 5。
4. **`validateManifest` 丢掉未知字段。** 返回对象只含 7 个键（实测），于是 `surface.summary()` 的 `p.manifest?.preset` 永远是 `null`（`services.mjs:191`），`presetService` 里 `p.manifest?.presets` 的过滤分支（`services.mjs:220-222`）永远走 `!declared`——即"插件可以用 `presets` 声明自己属于哪些预设"这条规则实际不可能排除任何插件。
5. **非 `'default'` 且 `allow: null` 的预设会把工具面清空。** `services.mjs:176` 只有 id 字面等于 `'default'` 才把 `allow` 置 `null`，其它预设一律 `new Set(...plugins ?? [])`；而 `pluginIds` 对 `allow === null` 返回 `null`，于是 `new Set([])`。实测 `presets.define({ id: 'empty-allow' }); use('empty-allow')` 后 `surface.names()` 为 `[]`。
6. **工具索引不看预设，`session.toolNames()`/`installTools()` 也不看。** `session.systemPrompt()` 用 `tools.index()`（全量已注册），`installTools()` 用 `tools.list()`；只有 `attachDshAdapter` 走 `surface`。实测在 `allow: ['zzz']` 的预设下 `surface.names()` 为 `[]`，但 `session.systemPrompt()` 仍含 `- at: s`，`session.toolNames()` 仍为 `['at']`。同理，未写进 `manifest.tools` 的工具会进 `tools`/`installTools`，却被 `surface.owners()` 判为无主而过滤掉。
7. **截断的硬下限会让输出超过 `maxChars`。** 工具描述用 `Math.max(40, maxChars - 1)`（`:37`），上下文/每轮用 `Math.max(20, maxChars - 1)`（`:130`、`:352`）。实测 `composeToolDescription({ summary: 'S'.repeat(200) }, { maxChars: 30 })` 返回 41 字符。
8. **索引的尾巴可以超预算。** 追加的 `…（还有 N 个工具）` 在预算检查之后拼接；`tool-constraints.test.mjs:69-78` 自己对 `maxChars: 400` 只断言 `index.length <= 500`，正是这个松动的证据。
9. **投递重试到上限就静默丢弃。** `nack` 在 `attempts >= 5` 时设 `dropped = true` 且不回队列（`:519`），条目随 `inflight` 删除而消失；没有 `droppedCount()` 之类可观测出口，水位也不推进，于是之后同一 `(plugin, activity, seq)` 还能被重新 accept。实测 5 次 nack 后 `pendingCount()` 不含该条、`watermarkOf` 仍为 `0`。
10. **`binding.timeoutMs` 被忽略。** model-manager 把 `timeoutMs` 传给 `ctx.model.bind`（`model-manager/src/index.mjs:65`），但 `configured()`（`model-client.mjs:14-19`）只取 `baseUrl`/`model`/`apiKey`，`request` 的 `timeoutMs` 只来自每次 `chat()` 入参（默认 120000）。
11. **provider 注销不解除已绑定的插槽。** `registerProvider` 的注销器只 `providers.delete(id); changed()`（`:594`），`bindings` 里已绑的 `{ provider, call }` 保留；实测 `off()` 后 `resolve('chat')` 仍返回 `{ provider: 'p1', kind: 'chat' }`，`call('chat')` 仍返回 `'ok'`。
12. **`session.installTools()` 与 `attachDshAdapter` 是两条互不知情的注入路径。** 前者把 `host.services.tools.list()` 逐个交给 `toolSink.register` 并返回一个只在那次调用里有效的批量注销器（`session.mjs:24-28`），不订阅 `surface.onChange`、不按预设过滤、不随插件启停自动同步；后者才是自维护的那条。
13. **`session.start()` 的 `Timer` 未被 `disable` 或适配器回收**——`stop()` 只在外部调用时生效，`host.disable` 不触碰它。
14. **`focus.current()` 的并列 tie-break 未定义。** 条件是 `lease.since >= best.since`（`:408`），同一毫秒内进入的多个租约由 `Map` 插入顺序决定后者胜出，代码与文档都没有说明这是有意的。
15. **`canPierce` 的 glob 只支持 `*`。** `globToRegExp` 转义 `[.+^${}()|[\]\\]` 后把 `*` 换成 `.*`（`:56-57`），`?`、`-`、字符类等都不生效，且是整串锚定匹配。
16. **静默吞错没有出口。** §4.5 列的所有装配期 `try/catch` 都是空体（只留中文注释），`prompt.assemble` / `context.assemble` 的失败对调用方不可见；`raw` 单源失败同样不可见。

### 歧义（明确不做推断）

- **"插件 inject"指什么，代码里没有对应物。** 核心不存在 `inject` 字段、`ctx.inject()` 或 injections 注册表；能对上的只有 `manifest.requires.plugins` 与 `ctx.services.provide/get/require`。历史命名见 `docs/AUDIT.md:44`。
- **`slot.meta`、`provider.meta`、`focus.visible`、`delivery.channel`** 都只被存储/透传，核心不解释；`visible` 除了 `visible !== false` 之外没有任何读取点。
- **`host.list()` 与 `surface.summary()` 的 `preset` 字段**：没有插件清单带 `preset` 键，无法从现有代码判断该字段本来预期写什么。
- **`session.mjs` 的 `log` 参数**只有 `delivery.failed` 一处使用，其余事件（插件启停、工具变更）走 `host` 的 `log`，两者的汇合方式不在本层。
