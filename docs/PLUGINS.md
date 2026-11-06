# 插件

> 读者：要加一个插件、或要判断某个插件能不能依赖的开发者 / 范围：`packages/plugins/*` 的 22 个插件、它们声明的 60+ 个工具与全部外部依赖 / 最后核对：2026-11-06（B 站 C 路线 + 通用视频插件 + album 落地后）
> **⚠️ 数字/成熟度可能滞后**：以 [ALBUM.md](ALBUM.md)、[AUDIT-2026-11-05](AUDIT-2026-11-05.md) §6.2 与代码为准。**当前事实（2026-11-06 实测）：产品 `icl` preset 未显式写 `plugins`，按 `DEFAULT_PLUGINS` 装配 68 个 ICL 工具（album 9（二阶段 reindex/caption）/ video 6 / bili 7 / mcb 17 / editor 3），album/video 已在产品默认生效**；旧文档"产品未启用 album/video（34/41 工具）"已过期。产品工具面预算与显式白名单待拍板，见 [PRODUCT-SURFACE.md](PRODUCT-SURFACE.md) 与 [PRODUCTIZATION-KICKOFF.md](PRODUCTIZATION-KICKOFF.md)。

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
| `mc-link` | 380 | 17 | `mcb_servers` `mcb_lan` `mcb_join` `mcb_leave` `mcb_stop` `mcb_status` `mcb_look` `mcb_scan` `mcb_map` `mcb_snapshot` `mcb_eyes` `mcb_attack` `mcb_combat` `mcb_shelter` `mcb_inventory` `mcb_do` `mcb_help` | 实验接缝 | MC body 契约适配器 → 工具面 + signals（不注册 world source）；默认不启用，`icl-mc`/`icl-mc-lab` preset |
| `time` | 618 | 7 | `time_status` `time_arrange` `time_list` `time_edit` `time_cancel` `time_pause` `time_resume` | 可用待调 | 日程、睡眠、目标的时钟 |
| `compaction` | 77 | 0 | — | 可用待调 | 把早前对话压成摘要再注入 |
| `persona` | 85 | 0 | — | 可用待调 | 人格卡与版本历史 |
| `focus` | 124 | 4 | `focus_status` `focus_enter` `focus_leave` `focus_backlog` | 可用待调 | 注意力空间：投递闸门、积压、勿扰、焦点工具 |
| `world-state` | 156 | 1 | `world_status` | 可用待调 | 世界状态总线（只读渲染） |
| `dsh-raw` | 130 | 1 | `raw_export` | 成熟 | DSH 会话原文索引与导出 |
| `model-manager` | 83 | 0 | — | 可用待调 | 供应商 → 插槽绑定 |
| `editor` | 71 | 3 | `read_file` `write_file` `list_dir` | 遗留 | 工作区文件读写，路径逃逸拦截 |
| `qq` | — | 2 | `qq_status` `qq_send` | 实验接缝 | 腾讯 QQ 连接器（OneBot）；入站只读、出站默认关 |
| `bili` | 403（+`runtime` 180 / `login` 122） | 7 | `bili_search` `bili_watch` `bili_comments` `bili_feed` `bili_frames` `bili_login_start` `bili_login_poll` | 可用待调 | B 站只读接入（C 路线：repo 内 vendor + 只读白名单 + ICL stateDir 凭证） |
| `video` | 377 | 6 | `video_probe` `video_open` `video_storyboard` `video_zoom` `video_locate` `video_frames` | 可用待调 | 通用视频浏览器（本地路径）：分镜/回看/定位/单帧，图进 DSH attachment |

合计：**21 个插件 / 56 个工具**。manifest 的 `tools` 与 `ctx.tools.register` 的名字逐个比对一致，没有声明了不注册、也没有注册了不声明（`qq` 随 master 合入，未参与本次逐行复核）。

14 个插件有工具，7 个没有（`dream` `rhythm` `compaction` `persona` `model-manager` `eager-recall` `loop-probe`）——它们注册的是提示词段、上下文策略、插槽、信号监听或共享服务。

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

- **工具**：17 个 —— `mcb_servers`、`mcb_lan`、`mcb_join`、`mcb_leave`、`mcb_stop`、`mcb_status`、`mcb_look`、`mcb_scan`、`mcb_map`、`mcb_snapshot`、`mcb_eyes`、`mcb_attack`、`mcb_combat`、`mcb_shelter`、`mcb_inventory`、`mcb_do`、`mcb_help`。
  `mcb_combat` = 战斗宏（hunt/defend/flee/guard；自动选武器/走位/低血中断）；`mcb_attack` = 单目标攻击（hit/伤害/血 before→after/killed）；
  `mcb_shelter` = 盖房（结构+入口验收，成功后写 home，夜里/下雨回家躲）。
  `mcb_snapshot` = 结构化场景快照（毫秒级，日常先看它）；`mcb_eyes` = 按需截图（Edge headless，约 7–8s/1.3GB，
  quota 15s；PNG 通过 `{images:[路径]}` 作为图片附件，501=body 未配置 viewer）。
  `mcb_join` 会 spawn/复用 `mc-body` 子进程并等到真连接；`mcb_leave` 只杀本会话 spawn 的进程。
  `mcb_stop` = 停任务+安全反射但**不离开世界**（同步 time 暂停模式；暂停≠离开），`mcb_leave` 才是结束 body；
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

- **工具**（7 个，全部只读）：
  - `bili_search`（必填 `keyword`；`num` 默认 8、`order` 默认 `totalrank`）→ 清洗过的清单（空 `bvid` 卡片被丢掉）；
  - `bili_watch`（必填 `target`：URL/BV）→ 标题/统计/简介/字幕全文；
  - `bili_comments`（必填 `target`；`num` 默认 10）→ 热门评论 + 前 2 条楼中楼；
  - `bili_feed`（`kind` = `hot`|`rank`|`weekly`|`buzz`，`num` 默认 10；`rank` 另收 `category`/`day`，`weekly` 收 `week`）→ 首页热门/排行榜/每周必看/热搜词；
  - `bili_frames`（必填 `target`；`from`/`to`/`cells`）→ 宫格图 **作为 attachment** + 可引用清单；
  - `bili_login_start` → 二维码 PNG（attachment）+ `key`；`bili_login_poll`（必填 `key`）→ 成功后原子写凭证。
- **配置**：`stateDir`（由 `bootstrap.configFor('bili')` 注入 ICL 的 stateDir）、`maxChars`（`6000`）、`timeoutMs`（`90_000`），以及路径覆盖 `pythonPath` / `runnerPath` / `vendorDir` / `storyboardCli` / `legacyBiliDir` / `credentialFile`（测试用 `fetchImpl`）。
- **依赖**：repo 内 `vendor/bilibili-mcp/`（MIT，见 `NOTICE.md` / `PATCHES.md`）、`tools/bili-run.py` 只读桥、`execFile`、storyboard CLI（仅 `bili_frames`）、Python venv（bilibili-api-python / aiohttp / mcp<2 / qrcode）。插件**不直接发 HTTP**：扫码登录走 host 的 `ctx.fetch`。
- **状态**：可用待调 —— C 路线最小可跑已落地（2026-11-06，含收尾）：repo 自持 vendor、只读白名单、凭证从旧家目录一次性迁移到 `<stateDir>/bili/`、热门/排行接出、错误归一化（`E_AUTH`/`E_RATE_LIMIT`/`E_NETWORK`/`E_TOOL`…）、**解释器优先 ICL 自己的 venv（旧 venv 兼容回退；2026-11-06 已实建，`pythonSource=icl`；`tools/bili-venv.mjs` 迁移）**、**只读调用串行 + 最小间隔 + 指数退避重试**、**切帧 cookies 到期/匿名降级的显式提示**、**临时格图在 `<stateDir>/bili/work` 且附件提交后清理（2026-11-07 审计修）**。已知待办：storyboard cookies 需在 12-01 前重新导出（runbook 见 `docs/VIDEO-EYES.md §10`）；ASR 只有设计（§11，不落桌面配置）；album 不自动归档。

### video

- **工具**（6 个，全部本地路径、不出网）：
  - `video_probe`（必填 `path`）→ 时长/分辨率/fps/音轨/字幕轨/大小；
  - `video_open`（必填 `path`；`overview` 默认 true，`from`/`to`/`cells`）→ 目录：视频清单；文件：元数据 + 概览宫格图 + 清单；
  - `video_storyboard`（必填 `path`；`from`/`to`/`cells`/`sheets`/`detail`/`textOnly`）→ 宫格图（最多 4 张）+ 可引用清单；
  - `video_zoom`（必填 `path`+`from`+`to`；`cells`/`minGap`）→ 更少更大的格子（窗口 ≤180s）；
  - `video_locate`（必填 `path`+`query`；`from`/`to`/`max`/`transcriptFile`）→ 命中格位/时间码/台词（不出图）；
  - `video_frames`（必填 `path`；`times` 1–6 个秒数或 `at` 单个秒数）→ 单帧/多帧拼图。
- **配置**：`stateDir`（`bootstrap.configFor('video')`）、`storyboardCli`、`ffmpeg`/`ffprobe`、`maxFileBytes`（默认 8 GiB）、`overviewSeconds`（240）、`maxTextChars`、`asr`（`false` 强制关闭转写；`true`/`asrBaseUrl` 标记已配置）。
- **依赖**：`dsh-video-storyboard` 的 `bin/storyboard.mjs`（分镜/切点/选帧/ASR/缓存）、ffmpeg/ffprobe；图片经桥接层 `ctx.attachments.saveImage()` 进模型（与 qq 图片通道同一机制）。本地工具不出网；**只有显式配置了 ASR**（`DSH_ASR_BASE_URL` / `$DSH_HOME/asr.json` / `config.asrBaseUrl`）时才会转写，否则 `video_locate` 直接短接、不碰远程默认 ASR。
- **状态**：可用待调 —— 最小实现 + 契约测试已落地；ASR 经 8088 `whisper-asr` 验证（冷 9.0 s / 热 0.25 s；本机 `asr.json` 是既有的，本轮未写）；端到端耗时/尺寸见 `docs/VIDEO-EYES.md §8.1/§11.2`。已知缺口：MC 录屏落盘约定、album 索引、长片 `--batch` 暴露；whisper-asr 返回无 `segments`，locate 只有整段精度（用 `transcriptFile` 补）。

## 6. 依赖与硬编码清单

### 6.1 机器相关绝对路径

| 位置 | 值 | 可否覆盖 |
|---|---|---|
| `bili` 的 Python 解释器 | 默认 `<ICL stateDir>/bili/.venv/Scripts/python.exe`（POSIX `bin/python`）；不存在时**兼容回退**旧插件 venv `C:\Users\ai_admin\.dsh\bili-duty\.venv\Scripts\python.exe` | `BILI_PYTHON` / 插件 config `pythonPath`；迁移用 `node tools/bili-venv.mjs --create` |
| `bili` 的只读桥 | 仓库内 `tools/bili-run.py` | `BILI_RUNNER` / `runnerPath` |
| `bili` 的 vendored MCP | 仓库内 `packages/plugins/bili/vendor/bilibili-mcp/` | `BILI_VENDOR` / `vendorDir` |
| `bili` 的旧家目录（仅一次性迁移凭证） | `C:\Users\ai_admin\.dsh\bili-duty` | `BILI_DIR` / `legacyBiliDir` |
| `bili` / `video` 的 storyboard CLI | `C:\Users\ai_admin\.dsh\profiles\desktop\node_modules\dsh-video-storyboard\bin\storyboard.mjs` | `STORYBOARD_CLI` / `ICL_STORYBOARD_CLI` / 插件 config `storyboardCli` |
| `video` 的 ffmpeg/ffprobe | `ffmpeg` / `ffprobe`（PATH） | `ICL_FFMPEG` / `ICL_FFPROBE` |
| 人格卡（`config/icl.example.json:2`、`config/icl.local.json:2`） | `C:/DSH/qwenstuff/focus-core/大肥鱼-QQ人格卡.md` | 配置项本身 |
| dsh-qq 记忆库（`tools/recall-bench.mjs:33`、`recall-diagnose.mjs:24`、`replay.mjs:38`） | `C:/DSH/qwenstuff/dsh-qq/state/memory.db` | ❌ 写死 |

换一台机器会坏在哪：

- **bili 的 5 个在线工具**（`bili_search` / `bili_watch` / `bili_comments` / `bili_feed` / `bili_frames`）走 `tools/bili-run.py` → `BILI_PYTHON` + `BILI_VENDOR`；缺任何一项时 `preflight` 会**逐条**说清缺哪个、怎么补（并明确"不是视频/网络的问题"）。
- **`bili_frames`** 另需 `STORYBOARD_CLI` 与 `node`；`video_*` 另需 ffmpeg/ffprobe（`video_probe`/`video_frames`）与 `STORYBOARD_CLI`（`video_open`/`video_storyboard`/`video_zoom`/`video_locate`）。
- **凭证**：bili 的 `<stateDir>/bili/bili_credential.json` 若缺失，会从旧家目录**复制一次**（只复制文件，不读内容）；源码里没有任何 cookie/token 字面量。
- **人格卡**是唯一有正规配置出口的机器相关路径：改 `config/icl.*.json` 的 `persona` 即可（`persona` 插件读的是 `card` 正文）。
- **三个脚手架脚本**（`recall-bench` / `recall-diagnose` / `replay`）指向 `dsh-qq` 的库，路径不可覆盖，换机后评测与回放无法复现。

### 6.2 子进程

| 触发 | 命令 | 超时 / 缓冲 |
|---|---|---|
| `bili_search` / `bili_watch` / `bili_comments` / `bili_feed` | `execFile(python, [tools/bili-run.py, <fn>, <json>])`，env 注入 `PYTHONIOENCODING=utf-8`、`BILI_CREDENTIAL`、`BILI_VENDOR`、`BILI_HOME` | 90 000 ms / 8 MB |
| `bili_frames` | `execFile(node, [storyboard.mjs, url, --cells, --out, --manifest, --allow-anonymous, --from, --to, --scan-height 240, --text])` | 600 000 ms / 32 MB |
| `video_storyboard` / `video_zoom` / `video_locate` / `video_open` | `execFile(node, [storyboard.mjs, path, --cells, --from, --to, --sheets, --pick, --burn, --min-gap, --transcript, --detail, --out, --manifest, --text])` | 900 000 ms / 64 MB |
| `video_probe` | `execFile(ffprobe, [-v error -print_format json -show_format -show_streams path])` | 45 000 ms / 32 MB |
| `video_frames` | `execFile(ffmpeg, [-ss t -i path -frames:v 1 …])`，多帧再拼一张 `tile` | 120 000 ms / 32 MB |

宫格图/帧图写进 `<ICL_ROOT>/video-tmp/work/` 或 `os.tmpdir()/icl-bili-board-*`（24h 清理）；图片在工具返回后才被桥读取，所以不会提前删。

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

### 6.5 环境变量（27 个）

| 组 | 变量 | 产品路径是否读 |
|---|---|---|
| `ICL_*`（11） | `ICL_TOOL_TIME` `ICL_NO_LITERAL` `ICL_ROOT` `ICL_VISION_BASE` `ICL_VISION_MODEL` `ICL_TIME_STATE` `ICL_LLM_BASE` `ICL_LLM_MODEL` `ICL_EMBED_BASE` `ICL_EMBED_MODEL` `ICL_LEX_DEBUG` | 4 个：`ICL_TOOL_TIME`（`host.mjs:20`）、`ICL_NO_LITERAL`（`memory:11`）、`ICL_VISION_BASE` / `ICL_VISION_MODEL`（`vision.mjs:11-12`）。`ICL_ROOT` 自 B 站 C 路线后**不再被产品路径读**（旧接缝用它找 `bili-run.py`） |
| 接缝与凭据（7） | `BILI_PYTHON` `BILI_RUNNER` `BILI_VENDOR` `BILI_DIR` `STORYBOARD_CLI` `DEEPSEEK_API_KEY` `DASHSCOPE_API_KEY` | 5 个：`BILI_PYTHON`/`BILI_RUNNER`/`BILI_VENDOR` 在 `bili`（`BILI_DIR` 只用于旧凭证一次性迁移）、`STORYBOARD_CLI` 在 `bili`；`DEEPSEEK_API_KEY` 经 `providers[].apiKeyEnv` 由 `model-manager` 读；`DASHSCOPE_API_KEY` 只在 `tools/marathon.mjs:59` |
| 视频（3） | `ICL_STORYBOARD_CLI` `ICL_FFMPEG` `ICL_FFPROBE` | 3 个，全在 `video`（`storyboardCli` / `ffmpeg` / `ffprobe` 的默认值） |
| DSH 与系统（6） | `DSH_HOME` `DSH_LAUNCH_TOKEN` `DSH_BASE_URL` `DSH_AUTH_TOKEN` `USERPROFILE` `HOME` | 4 个：`DSH_HOME` / `DSH_LAUNCH_TOKEN`（`dsh-client.mjs:20,37`）、`USERPROFILE` / `HOME`（`dsh-raw:42`）；`DSH_BASE_URL` / `DSH_AUTH_TOKEN` 只在 `tools/dsh-session.mjs` |

只在脚手架/历史里读的 11 个：`ICL_ROOT` `ICL_TIME_STATE` `ICL_LLM_BASE` `ICL_LLM_MODEL` `ICL_EMBED_BASE` `ICL_EMBED_MODEL` `ICL_LEX_DEBUG` `DASHSCOPE_API_KEY` `DSH_BASE_URL` `DSH_AUTH_TOKEN`（以及 `BILI_CREDENTIAL`/`BILI_HOME` 这两个由插件内部注入、不是用户配置面）。`DEEPSEEK_API_KEY` 两处都读：产品侧经 `providers[].apiKeyEnv` 由 `model-manager` 取（`process.env[keyEnv]`），4 个评测脚本里另有直读。凭据只从环境变量来，没有从配置文件读密钥的分支。

## 7. 哪些不是产品路径

产品路径 = `packages/core/src/*`、`packages/plugins/*`（21 个，含 `bili/vendor/*` 与 `video`）、`prompts/persona.md`、`prompts/sim.md`、`prompts/dream.md`、`config/icl.example.json`、`config/icl.local.json`。判定依据三条独立证据：在根 `package.json` 的 `workspaces` 内、走 `createHost` + `registerPlugin` + `enable` 的正常装配链、文件头注释自述的用途。

| 路径 | 是什么 | 为什么不算产品 |
|---|---|---|
| `tools/*.mjs` | 评测、诊断、回放、验收、控制后门、自建 agent 循环、B 站/视频体检（`bili-eval.mjs`、`bili-venv.mjs`） | 全部在 `workspaces` 外、无自己的 `package.json`；`npm test` 只跑各插件的 `test/` 目录，不含 `tools/`；头部注释自述「评测 / 诊断 / 回放 / 验收 / 迁移」 |
| `config/marathon.json`、`config/marathon-30.json` | 马拉松脚手架的配置 | 只被 `tools/marathon.mjs` 读；其中的 `plugins` 是 8 个 id，比脚本内置的 9 个少 `dream`——照这份配置跑时 `dream` 注册了但不会被 `enable` |
| `prompts/marathon.md` | 挂机刷视频的提示词 | 只被 `config/marathon*.json` 的 `personaFile` 指向，`dream` 的默认 `personaFile` 是 `prompts/dream.md` |
| `state/` 下产物 | `marathon-exports/`、`marathon-workspace/`、`test-*`、`*.jsonl`、`probe-early.json` | 运行产物，`.gitignore` 已忽略 `state/`；`marathon-*` 与 `test-*` 只由脚手架生成 |
| 仓库根曾有的 `recall-bench.json`、`recall-diagnose.json`、`replay-report.json` | 评测报告 | 由 `tools/*.mjs` 写出，`npm test` 不读。整理时已移到 `state/reports/`（`state/` 已 gitignore） |

三个「半产品」脚本仍归脚手架：`tools/wire-check.mjs`（部署自检）、`tools/dsh-session.mjs`（运维修桥）、`tools/time.mjs`（人工控制后门）。三者都不在 `packages/` 的任何装配里、也不进 `npm test`：`wire-check` 自建一个临时 host 做自检，`dsh-session` 直接走 DSH API，`time` 只往 `state/time.inbox.jsonl` 追加命令。

`packages/adapters/dsh-client.mjs` 与 `delivery-pump.mjs` 是产品组件却不在上表：仓库内零调用方，真实使用者在仓库外的 `icl-live` 插件，因此不判为脚手架也不判为产品。

`editor` 的处境与上表相关：它的 3 个工具在仓库内唯一的装配者是 `tools/marathon.mjs`，所以总表记为「遗留」；产品侧是否启用未验证。
