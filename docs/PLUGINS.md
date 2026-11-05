# 插件

> 读者：要加一个插件、或要判断某个插件能不能依赖的开发者 / 范围：`packages/plugins/*` 的 19 个插件、它们声明的 43 个工具与全部外部依赖 / 最后核对：2026-11-04

本文是插件事实的唯一归属地：工具名、参数、`ctx.config` 键、成熟度、外部依赖只在这里写。服务契约见 [ARCHITECTURE.md](ARCHITECTURE.md)，记忆的数据形状与检索算法见 [MEMORY.md](MEMORY.md)。

核对方式：逐个读 `manifest.json` 与 `src/index.mjs`，并与 `ctx.tools.register` 调用点比对；行数是文件的 `\n` 计数（含末尾空行）；未读 `node_modules`。

## 1. 总表

| 插件 | 行数 | 工具数 | 工具名 | 成熟度 | 职责 |
|---|---|---|---|---|---|
| `memory` | 480 | 1 | `memory_export` | 成熟 | sqlite 存取原语：命名空间、写入、混合检索、向量 |
| `recall` | 359 | 3 | `remember` `recall` `forget` | 可用待调 | 主会话的主动记与主动回忆 |
| `note` | 167 | 5 | `memo` `memos` `memo_append` `memo_commit` `note_status` | 可用待调 | 模型自己的待办清单 |
| `lexicon` | 147 | 2 | `lexicon` `lexicon_learn` | 可用待调 | 黑话/词条库，带来源与待查标记 |
| `whois` | 99 | 1 | `whois` | 可用待调 | 按身份查人物档案，按名字给候选 |
| `eager-recall` | 39 | 0 | — | 可用待调 | 每轮自动检索一小段注入上下文 |
| `dream` | 995 | 0 | — | 可用待调 | 7 个默认 job 的夜间整理流水线（另有废弃的 `slang`） |
| `rhythm` | 109 | 0 | — | 遗留兼容 | 旧 nightly 时钟；默认不启用，time 接管 |
| `loop-probe` | 90 | 0 | — | 测试接缝 | 闭环外部信号注入；只在 `icl-loop` preset 启用 |
| `mc-link` | 380 | 11 | `mcb_servers` `mcb_lan` `mcb_join` `mcb_leave` `mcb_status` `mcb_look` `mcb_scan` `mcb_map` `mcb_inventory` `mcb_do` `mcb_help` | 实验接缝 | MC body 契约适配器 → 工具面 + signals（不注册 world source）；默认不启用，`icl-mc`/`icl-mc-lab` preset |
| `time` | 618 | 7 | `time_status` `time_arrange` `time_list` `time_edit` `time_cancel` `time_pause` `time_resume` | 可用待调 | 日程、睡眠、目标的时钟 |
| `compaction` | 77 | 0 | — | 可用待调 | 把早前对话压成摘要再注入 |
| `persona` | 85 | 0 | — | 可用待调 | 人格卡与版本历史 |
| `focus` | 124 | 4 | `focus_status` `focus_enter` `focus_leave` `focus_backlog` | 可用待调 | 注意力空间：投递闸门、积压、勿扰、焦点工具 |
| `world-state` | 156 | 1 | `world_status` | 可用待调 | 世界状态总线（只读渲染） |
| `dsh-raw` | 130 | 1 | `raw_export` | 成熟 | DSH 会话原文索引与导出 |
| `model-manager` | 83 | 0 | — | 可用待调 | 供应商 → 插槽绑定 |
| `editor` | 71 | 3 | `read_file` `write_file` `list_dir` | 遗留 | 工作区文件读写，路径逃逸拦截 |
| `bili` | 151 | 4 | `bili_search` `bili_watch` `bili_comments` `bili_frames` | 临时接缝 | B 站搜索 / 视频 / 评论 / 宫格图 |

合计：**19 个插件 / 43 个工具**。manifest 的 `tools` 与 `ctx.tools.register` 的名字 **19/19 完全一致**，没有声明了不注册、也没有注册了不声明。

12 个插件有工具，7 个没有（`dream` `rhythm` `compaction` `persona` `model-manager` `eager-recall` `loop-probe`）——它们注册的是提示词段、上下文策略、插槽、信号监听或共享服务。

成熟度口径：`成熟` = 主路径可直接依赖；`可用待调` = 已知缺陷会改变正常使用下的输出；`临时接缝` = 依赖本机绝对路径或外部进程；`遗留` = 仓库内只有脚手架脚本装配。

另外两条对插件作者有用的事实：全部 19 个 manifest 的 `focus` 都是 `{}`，没有任何插件声明聚焦规则；也没有任何 manifest 写 `presets` 字段——而且即使写了也不生效，因为 `manifest.presets` 没有消费方（见 [ARCHITECTURE.md §8](ARCHITECTURE.md#manifest-校验保留与丢弃)）。

## 2. 记忆侧

### memory

- **工具**：`memory_export`（必填 `path`；`format` = `json`|`md`，默认 `json`；`namespace` 默认 `null`）→ `导出了 <n> 条（<命名空间…>）到 <path>`，写不进去回 `写不进去：<原因>`。
- **配置**：`path`（默认 `<root>/state/memory.db`）、`root`（默认 `.`）。
- **依赖**：manifest **没有** `requires` 键；`node:sqlite` 的 `DatabaseSync`、`slots.resolve/call('embed-text')`（未绑定则 `embed()` 返回 `null`，检索退化不报错）、`provide('memory')`。
- **状态**：成熟 —— 14 个测试文件；短板是 `put` 的更新分支把 `weight` 打回 1、改写文本不失效旧向量。

### recall

- **工具**：`remember`（必填 `text`；`kind` enum `event|person|slang|resolve`、`key`、`qq`、`subjectKind`、`about`、`origin`）→ `记下了。`；`recall`（`kind`、`query`、`limit`、`cursor`、`about`、`conv`、`tag`、`days`、`overview`，无必填）→ `{text, cursor, more}`；`forget`（必填 `key`；`kind`）→ `删掉了。` / `没有这条笔记。`。
- **配置**：`sessionId`（默认 `default`）、`budgetTokens`（默认 `10000`，下限 `500`）。
- **依赖**：`requires.plugins` = `["memory"]`；`memory.findPerson/boost/remove`、软依赖 `services.raw`、`provide('recall')`。
- **状态**：可用待调 —— 游标按 `key` 精确读（此前的"限 1 行读错"已修）；残余是每次 `recall` 无条件写游标，空召回也写一行。

### note

- **工具**：`memo`（必填 `text`）→ `记下了。`；`memos`（`all`、`done`）→ `· <text>` 列表或 `没有待办。`；`memo_append`（必填 `id`:number、`text`）→ `补上了。`；`memo_commit`（必填 `id`；`result`、`source`）→ `完成了。`；`note_status`（无参）→ 计数行。
- **配置**：无。
- **依赖**：`requires.plugins` = `["memory"]`；软依赖 `get('world')`（挂 `待办` source，`cap: 1`）、`provide('note')`。
- **状态**：可用待调 —— 计数与列表都基于 `limit: 500`（`created_at ASC`），超过 500 条后饱和；`resolved` 不进任何计数。

### lexicon

- **工具**：`lexicon`（`term`、`conv`、`platform`、`tag`、`limit` 默认 5）→ 词条文本（`<词>：已确认/待确认` + 逐来源行）；`lexicon_learn`（必填 `term`；`meaning`、`usage`、`conv`、`platform`、`url`、`tags`）→ `记下了「…」。` / `…已经留了待办去查。` / `没记成（缺词）。`。
- **配置**：无。
- **依赖**：`requires.plugins` = `["memory"]`；软依赖 `get('note')`（缺释义时留待办）、`provide('lexicon')`。
- **状态**：可用待调 —— `conv: 'web'` 的过滤恒为空（`web` 在库里存成 `null`）；每次 upsert 把 `fading` 抹回 `active` 并重复留同样的待办。

### whois

- **工具**：`whois`（`qq`、`idKind`、`subjectKind`、`value`、`name`，全部可选）→ 档案正文 + 逐句依据 + 依据笔记 + 原话 + 最近的事，或候选列表，或 `还没有…的档案`。
- **配置**：无。
- **依赖**：`requires.plugins` = `["memory"]`（`memory.findPerson`、`memory.query`）；软依赖 `services.raw`（原话段）。
- **状态**：可用待调 —— 不注册 `person` 命名空间（只读）；非 QQ 身份的人物永远查不到「最近提到 TA 的事」。

### eager-recall

- **工具**：无（注册 `ctx.prompt.onTurn`）。
- **配置**：`enabled`（`!== false` 即开）、`minScore`（`0.5`）、`maxItems`（`2`，下限 1）、`maxChars`（`200`，下限 40）。
- **依赖**：`requires.plugins` = `["memory"]`；`memory.search`。
- **状态**：可用待调 —— 注入行标签取 `item.namespace`（`note` 显示为 `未整理`），此前"恒为 `[记忆]`"的说法已过时；真正的问题是 `minScore 0.5` 没有大样本标定。

## 3. 做梦与生活

### dream

- **工具**：无。
- **配置**：`sessionId`（`default`）、`persona`（默认落回 `personaFile` 的内容）、`personaFile`（默认 `<root>/prompts/dream.md`）、`timezone`（`Asia/Hong_Kong`）、`dreamAt`（默认 `23:00`，注册 daily 安排）、`root`。
- **依赖**：`requires.plugins` = `["memory"]`；`slots.call('dream-chat')`、`ctx.signals.on`（`sleep` 与 `dream` 标签）；软依赖 `get('time')` `get('note')` `get('lexicon')` `services.raw`；`provide('dream')`。
- **状态**：可用 —— 夜间由 `time` 里 `dream:nightly` 的 silent 安排发 `schedule-start` 触发；`sleep-start` 仍可提前触发；`cleanup` 改写与证据保留已修（2026-11-03 晚）。

### rhythm（遗留兼容，默认不启用）

- **工具**：无。
- **默认**：已从 `DEFAULT_PLUGINS` 移除；nightly 不再由它触发。
- **同时启用 time 时**：直接停用（`isDue=false`、`fire` 返回 `legacy-disabled`），不起第二个 timer、不写 `rhythm.json`。
- **配置**：`dreamAt`、`stateFile`（默认 `<root>/state/rhythm.json`），只在单独启用时使用。
- **状态**：遗留兼容；保留给旧配置与旧测试。

### time

- **工具**：`time_status`（无参）→ 现在/阶段/进行中/目标/积压；`time_arrange`（必填 `mode` enum `wake|goal`；`kind` enum `single|span`、`at`、`in`、`duration`、`message`、`theme`、`tags`、`focus`、`turnLimit`、`sleep`、`allow`）→ `安排好了：…`；`time_list`（无参）；`time_edit`（必填 `id`；`at`、`in`、`message`、`mode`、`duration`）；`time_cancel`（必填 `id`）；`time_pause`、`time_resume`（无参）。
- **配置**：`stateFile`（默认 `<root>/state/time.json`）、`tickMs`（`15000`，下限 1000）、`inboxFile` / `outboxFile`（默认与 state 同目录的 `time.inbox.jsonl` / `time.outbox.jsonl`）、`root`。
- **依赖**：无 `requires.plugins`；`ctx.signals`、`get('world')`、`ctx.focus`、`services.clock`（可空，`setClock` 退化为空函数）；`provide('time')`。
- **状态**：可用 —— 通用日历；每条安排到点发 `schedule-start` 事件（tags 带安排 tags），`silent` 安排不发模型消息；睡眠默认 3 分钟；取消/改期会清 `fired`。多进程共写 `time.json` 仍无文件锁。

### compaction

- **工具**：无（注册 `context.onCompact` 与 `context.onAssemble`，`order: 60`）。
- **配置**：`keepRecent`（`12`，下限 2）、`maxChars`（`1200`，下限 200）、`triggerChars`（`12000`，下限 2000）、`persona`（`''`）。
- **依赖**：`requires.plugins` = `["memory"]`；`slots.call('compact-chat')`、`services.context`、`memory.put`（命名空间 `compaction`）、`provide('compaction')`。
- **状态**：可用待调 —— `latest()` 只在前 20 条摘要里取最新；`context.compact` 只调第一个注册的 compactor。

## 4. 人格与世界

### persona

- **工具**：无（注册 `prompt.section`，`name: 'persona'`、`order: 20`）。
- **配置**：`namespace`（默认 `persona`）、`maxVersions`（`50`，下限 1）、`card`（默认 `''`）。
- **依赖**：无 `requires.plugins`；软依赖 `get('memory')`（没有就只在进程内存里）；`provide('persona')`；对外 `current/set/rollback/versions`。
- **状态**：可用 —— `versions()` 最新在前；`maxVersions` 按最新保留；版本键加了随机后缀，跨进程同秒不再覆盖（2026-11-04）。

### world-state

- **工具**：`world_status`（`owner`、`item`、`limit` 默认 20）→ 每 owner/feed 一行 / 展开该 owner 的一项 / `（世界状态是空的）`。
- **配置**：无。
- **依赖**：无 `requires.plugins`；`prompt.section`（`name: 'world'`、`order: 10`）、`provide('world')`；来源注册 API `registerSource({id, owner, title, order, cap, items})`。
- **状态**：可用 —— 2026-11-04 修了展示：默认 `clock` 在 `time` 存在时返回空（不再出现两行“时间”）；同 owner 的多个 source 按 `order` 排序取标题/cap；`world-state` 已在 `DEFAULT_PLUGINS` 里排到 `note`/`time` 之前，`note` 的“待办”来源不会再因为启用顺序而丢失。`rhythm` 旧 source 只在它单独启用时存在。

## 5. 接缝

### loop-probe（只在 `icl-loop` preset）

- **工具**：无。
- **配置**：`inboxFile`（默认 `<stateDir>/loop.inbox.jsonl`）、`outboxFile`（默认同目录 `loop.outbox.jsonl`）、`tickMs`（`200`，下限 100）。
- **依赖**：`ctx.signals.offer`；`provide('loop-probe')`；文件邮箱。
- **状态**：测试接缝。driver 写 `{id,from,kind,text,focus,tags}`，插件把它当成 `qq` 的普通信号走真实 gate；结果写 outbox（accepted/blocked/reason）。不注册工具，模型看不到它。默认不启用，只在 `icl-loop` preset 里。

### mc-link（实验接缝，默认不启用）

- **工具**：11 个 —— `mcb_servers`、`mcb_lan`、`mcb_join`、`mcb_leave`、`mcb_status`、`mcb_look`、`mcb_scan`、`mcb_map`、`mcb_inventory`、`mcb_do`、`mcb_help`。
  `mcb_join` 会 spawn/复用 `mc-body` 子进程并等到真连接；`mcb_leave` 只杀本会话 spawn 的进程。
  长任务/单步动作/任务台账/事件/取消/恢复/发言都走 `mcb_do` 的 steps op（`task`/`dig`/`tasks`/`events`/`cancel`/`resume`/`say`…）；
  深层文档在 `skills/*.md`，用 `mcb_help {skill}` 按需读（`play` 是开一局主入口）。
- **配置**：`baseUrl`（默认 `http://127.0.0.1:54836`）、`listenPort`（默认取 baseUrl 端口 = body 端口，只此一处）、`pollMs`（1200）、`focus`（`mc`）、`doTimeoutMs`（120000）、`bodyEntry`、`stateDir`、`logFile`、`serversFile`（可选）、`chatPerMinute`（6）。
  服务器清单的**唯一定义**是 `packages/plugins/mc-link/servers.json`（flat `54837` / survival `54838`）；仓库根 `config/mc-servers.json` 是遗留文件，不再被读取。
- **依赖**：`packages/mc-body` 的 `mc-body/v1` HTTP；`ctx.signals.offer`；`ctx.tools` / `ctx.prompt`。**不**注册 world source（MC 状态只属于 MC 会话，见 `docs/MC-STATUS.md`）。
- **提示词**：只注册两个事实段 `mc:status`（order 900，≤1 行 ≤120 字）、`mc:skills`（901，条件命中）；操作教学在工具 description 与 `skills/`，不占全局提示词（`docs/PROMPT-CONTRACT.md`）。
- **状态**：只懂契约，不 import mineflayer。任务完成/失败/中断、安全停止、聊天、断线/重连按分级限流后作为 `plugin:mc` 信号进入会话（掉落/死亡刷屏会合并、危险事件带 `alarm`）；不穿透 time 的睡眠 gate。只在 `icl-mc`/`icl-mc-lab` preset 启用。`tools/mc-observer.mjs` 是更早的只读诊断探针，不是最终 body。

### dsh-raw

- **工具**：`raw_export`（必填 `path`；`sessionId`、`since`（ISO）、`limit` 默认 1000）→ `导出了 <n> 条到 <path>`。
- **配置**：`sessionsRoot`（默认 `%USERPROFILE%/.dsh/sessions`）、`days`（`30`）、`maxFiles`（`400`）、`maxMessages`（`20000`）、`cacheMs`（`300000`，下限 10000）。
- **依赖**：无 `requires.plugins`；`services.raw.register({id: 'dsh-sessions'})`、`provide('dsh-raw')`、`zlib.zstdDecompressSync`、fs。
- **状态**：成熟 —— 只读、无状态；短板是 `.zstd` 需要 Node ≥ 22.15（更低版本的 `zstdDecompressSync` 不存在，原文层静默返回空串），且 `list` 不是最近 N 条。

### model-manager

- **工具**：无。
- **配置**：`providers`（数组；元素 `id` / `kind` / `shape` / `baseUrl` / `model` / `apiKeyEnv` / `apiKey` / `timeoutMs` / `disableThinking` / `extraBody`）。
- **依赖**：无 `requires.plugins`；`ctx.model.bind/chat`、`slots.registerProvider/autoBind/onChange`、`ctx.fetch`（唯一允许直接 fetch 的插件）、`provide('model-manager')`。
- **状态**：可用待调 —— 只有**第一个** chat 供应商被 `bind`，其余 chat provider 注册了也拿不到 `ctx.model`；`apiKeyEnv` 为空时该 provider 被跳过并 warn。

### editor

- **工具**：`read_file`（必填 `path`）→ 文本（截到 20000 字）；`write_file`（必填 `path`、`text`；`append`）→ `写好了。` / `追加好了。`；`list_dir`（`path`）→ `d <name>` / `f <name>`（最多 100 项）。
- **配置**：`root`（默认 `process.cwd()`）、`maxBytes`（`262144`，下限 1024）。
- **依赖**：无 `requires.plugins`；fs / path；越界由 `inside()` 拦（`resolve` 后必须等于 root 或以 `root + sep` 开头）。
- **状态**：遗留 —— 仓库内唯一装配者是 `tools/marathon.mjs`，产品侧接线未验证；`maxBytes` 只约束读，写没有上限。

### bili

- **工具**：`bili_search`（必填 `keyword`；`num` 默认 8、`order` 默认 `totalrank`）；`bili_watch`（必填 `target`）；`bili_comments`（必填 `target`；`num` 默认 10）；`bili_frames`（必填 `target`；`from`、`to`、`cells` 默认 6，夹 1..16）→ `{text, imagePath}`，是唯一带非文本出口的工具。
- **配置**：`maxChars`（`6000`）、`vision`（对象，原样透传给 `services.vision`）、`visionEnabled`（`false` 时跳过画面描述）。
- **依赖**：`services.vision`（可选，缺了就不描述画面）、`execFile` / `execFileSync`、4 条绝对路径（§6.1）；manifest 无 `requires` 键。
- **状态**：临时接缝 —— 换机器要重设 `BILI_PYTHON` `ICL_ROOT` `STORYBOARD_CLI` `BILI_DIR` 四条路径，否则 4 个工具全废；子进程分支零测试。工具的使用顺序（画面 → 字幕/信息 → 评论 → 记一句）写在 `prompts/live.md`，不是代码强制的。

## 6. 依赖与硬编码清单

### 6.1 机器相关绝对路径

| 位置 | 值 | 可否覆盖 |
|---|---|---|
| `bili` 的 Python 解释器 | `C:\Users\ai_admin\.dsh\bili-duty\.venv\Scripts\python.exe` | `BILI_PYTHON` |
| `bili` 的仓库根 | `C:/DSH/qwenstuff/icl` | `ICL_ROOT` |
| `bili` 的 storyboard CLI | `C:\Users\ai_admin\.dsh\profiles\desktop\node_modules\dsh-video-storyboard\bin\storyboard.mjs` | `STORYBOARD_CLI` |
| `bili` 的 bili-duty 目录 | `C:\Users\ai_admin\.dsh\bili-duty` | `BILI_DIR` |
| 人格卡（`config/icl.example.json:2`、`config/icl.local.json:2`） | `C:/DSH/qwenstuff/focus-core/大肥鱼-QQ人格卡.md` | 配置项本身 |
| dsh-qq 记忆库（`tools/recall-bench.mjs:33`、`recall-diagnose.mjs:24`、`replay.mjs:38`） | `C:/DSH/qwenstuff/dsh-qq/state/memory.db` | ❌ 写死 |

换一台机器会坏在哪：

- **bili 的 3 个内容工具**（`bili_search` / `bili_watch` / `bili_comments`）依赖 `BILI_PYTHON` 与 `BILI_RUNNER`（默认派生自 `ICL_ROOT`）：解释器或桥接脚本不存在，`callTool` 返回 `{ok: false, error}`，工具回 `搜不动：…` / `打不开：…` / `读不到评论：…`。
- **`bili_frames`** 单独依赖 `STORYBOARD_CLI` 与 `node`：CLI 不存在则回 `看不成画面：…`，与上面 3 个工具互不影响。
- **人格卡**是唯一有正规配置出口的机器相关路径：改 `config/icl.*.json` 的 `persona` 即可，插件本身不读这个路径（`persona` 插件读的是 `card` 正文）。
- **三个脚手架脚本**（`recall-bench` / `recall-diagnose` / `replay`）指向 `dsh-qq` 的库，路径不可覆盖，换机后评测与回放无法复现。

### 6.2 子进程

| 触发 | 命令 | 超时 / 缓冲 |
|---|---|---|
| `bili_search` / `bili_watch` / `bili_comments` | `execFile(python.exe, [tools/bili-run.py, <fn>, <json>])`，env 注入 `PYTHONIOENCODING=utf-8` 与 `BILI_DIR` | 60 000 ms / 4 MB |
| `bili_frames` | `execFileSync(node, [storyboard.mjs, url, --cells, --out, --manifest, --allow-anonymous, --from, --to, --scan-height 240])` | 600 000 ms / 8 MB |

宫格图写进 `os.tmpdir()/icl-board-*`，默认只扫前 240 秒；`packages/` 其余部分没有子进程。

### 6.3 端口与地址

| 地址 | 用途 | 出处 |
|---|---|---|
| `http://127.0.0.1:8088/v1` | 本地模型网关（chat + embedding） | `vision.mjs` 默认、`config/icl.*.json` 的 `llama-swap-chat` 与 `bge-m3`、`config/marathon*.json`、`tools/quality-run.mjs` |
| `http://127.0.0.1:3080` | DSH Web API 默认 | `packages/adapters/dsh-client.mjs:299` |
| `http://127.0.0.1:64874` | DSH 会话工具默认 | `tools/dsh-session.mjs:18` |

`3080` 只被「产品组件但仓库内零调用方」的 `dsh-client.mjs` 使用，`64874` 只在运维脚本里；8088 不在则 chat / embedding 两条插槽都调不通。

### 6.4 写死的模型名

| 模型名 | 出处 |
|---|---|
| `coder390-27b-q3-df2-4x500` | `packages/core/src/vision.mjs:12` 默认、`config/marathon*.json`、`tools/quality-run.mjs:26` |
| `deepseek-chat` | `config/icl.example.json` / `icl.local.json` 的 `deepseek` 供应商 |
| `qwen35-9b` | 同上，`llama-swap-chat` 供应商 |
| `embed-bge-m3`（dim 1024） | 同上，`bge-m3` 供应商；`memory` 的 `embed-text` 插槽要求 `requires.dim = 1024` |

### 6.5 环境变量（23 个）

| 组 | 变量 | 产品路径是否读 |
|---|---|---|
| `ICL_*`（11） | `ICL_TOOL_TIME` `ICL_NO_LITERAL` `ICL_ROOT` `ICL_VISION_BASE` `ICL_VISION_MODEL` `ICL_TIME_STATE` `ICL_LLM_BASE` `ICL_LLM_MODEL` `ICL_EMBED_BASE` `ICL_EMBED_MODEL` `ICL_LEX_DEBUG` | 5 个：`ICL_TOOL_TIME`（`host.mjs:20`）、`ICL_NO_LITERAL`（`memory:11`）、`ICL_VISION_BASE` / `ICL_VISION_MODEL`（`vision.mjs:11-12`）、`ICL_ROOT`（`bili:12`） |
| 接缝与凭据（6） | `BILI_PYTHON` `BILI_RUNNER` `BILI_DIR` `STORYBOARD_CLI` `DEEPSEEK_API_KEY` `DASHSCOPE_API_KEY` | 5 个：四条 `BILI_*`/`STORYBOARD_CLI` 在 `bili`，`DEEPSEEK_API_KEY` 经 `providers[].apiKeyEnv` 由 `model-manager` 读；`DASHSCOPE_API_KEY` 只在 `tools/marathon.mjs:59` |
| DSH 与系统（6） | `DSH_HOME` `DSH_LAUNCH_TOKEN` `DSH_BASE_URL` `DSH_AUTH_TOKEN` `USERPROFILE` `HOME` | 4 个：`DSH_HOME` / `DSH_LAUNCH_TOKEN`（`dsh-client.mjs:20,37`）、`USERPROFILE` / `HOME`（`dsh-raw:42`）；`DSH_BASE_URL` / `DSH_AUTH_TOKEN` 只在 `tools/dsh-session.mjs` |

只在脚手架里读的 9 个：`ICL_TIME_STATE` `ICL_LLM_BASE` `ICL_LLM_MODEL` `ICL_EMBED_BASE` `ICL_EMBED_MODEL` `ICL_LEX_DEBUG` `DASHSCOPE_API_KEY` `DSH_BASE_URL` `DSH_AUTH_TOKEN`。`DEEPSEEK_API_KEY` 两处都读：产品侧经 `providers[].apiKeyEnv` 由 `model-manager` 取（`process.env[keyEnv]`），4 个评测脚本里另有直读。凭据只从环境变量来，没有从配置文件读密钥的分支。

## 7. 哪些不是产品路径

产品路径 = `packages/core/src/*`、`packages/plugins/*`（16 个）、`prompts/live.md`、`prompts/dream.md`、`config/icl.example.json`、`config/icl.local.json`。判定依据三条独立证据：在根 `package.json` 的 `workspaces` 内、走 `createHost` + `registerPlugin` + `enable` 的正常装配链、文件头注释自述的用途。

| 路径 | 是什么 | 为什么不算产品 |
|---|---|---|
| `tools/*.mjs`（13 个） | 评测、诊断、回放、验收、控制后门、自建 agent 循环 | 全部在 `workspaces` 外、无自己的 `package.json`、`npm test` 只跑 `packages/core/test`；头部注释自述「评测 / 诊断 / 回放 / 验收 / 控制后门」 |
| `config/marathon.json`、`config/marathon-30.json` | 马拉松脚手架的配置 | 只被 `tools/marathon.mjs` 读；其中的 `plugins` 是 8 个 id，比脚本内置的 9 个少 `dream`——照这份配置跑时 `dream` 注册了但不会被 `enable` |
| `prompts/marathon.md` | 挂机刷视频的提示词 | 只被 `config/marathon*.json` 的 `personaFile` 指向，`dream` 的默认 `personaFile` 是 `prompts/dream.md` |
| `state/` 下产物 | `marathon-exports/`、`marathon-workspace/`、`test-*`、`*.jsonl`、`probe-early.json` | 运行产物，`.gitignore` 已忽略 `state/`；`marathon-*` 与 `test-*` 只由脚手架生成 |
| 仓库根曾有的 `recall-bench.json`、`recall-diagnose.json`、`replay-report.json` | 评测报告 | 由 `tools/*.mjs` 写出，`npm test` 不读。整理时已移到 `state/reports/`（`state/` 已 gitignore） |

三个「半产品」脚本仍归脚手架：`tools/wire-check.mjs`（部署自检）、`tools/dsh-session.mjs`（运维修桥）、`tools/time.mjs`（人工控制后门）。三者都不在 `packages/` 的任何装配里、也不进 `npm test`：`wire-check` 自建一个临时 host 做自检，`dsh-session` 直接走 DSH API，`time` 只往 `state/time.inbox.jsonl` 追加命令。

`packages/adapters/dsh-client.mjs` 与 `delivery-pump.mjs` 是产品组件却不在上表：仓库内零调用方，真实使用者在仓库外的 `icl-live` 插件，因此不判为脚手架也不判为产品。

`editor` 的处境与上表相关：它的 3 个工具在仓库内唯一的装配者是 `tools/marathon.mjs`，所以总表记为「遗留」；产品侧是否启用未验证。
