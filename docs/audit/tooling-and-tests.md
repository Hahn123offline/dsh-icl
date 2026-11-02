# 工具与测试审计（tooling & tests）

> 范围：`tools/`（9 个脚本）、`packages/core/test/*`（35 个文件）、`config/`、`docs/*.md`（11 个），
> 外加 `C:\Users\ai_admin\.dsh\plugins\icl-live`（已停用的 DSH 插件：`index.mjs`、`package.json`、`presets/icl-live.patch.yml`）。
> 方法：逐文件读源码与断言，不按文件名猜；测试实跑一遍。
> 快照：HEAD 为 `5d8c190`，但工作区有未提交改动（`packages/core/src/contracts.mjs`、
> `packages/plugins/memory/src/index.mjs`、`packages/plugins/recall/src/index.mjs`），本文以**工作区实际代码**为准。

## 0. 复核基线（下列数字都是跑出来的，不是抄文档）

| 项 | 实测 | 对应文档说法 |
|---|---|---|
| `node --test packages/core/test` | `tests 146 / pass 146 / fail 0`，`duration_ms 908`，Node `v26.12.1` | `STATUS.md:6`「146 通过」一致 |
| 提交 | `git rev-parse --short HEAD` = `5d8c190` | `STATUS.md:6` 写 `fb4fb5e`，落后 7 个提交 |
| `test()` 调用数 | 逐文件 `Select-String "^test\("` 合计 146 | `TECHNICAL.md:99` 一致 |
| 插件数 | `packages/plugins/` 15 个目录 | `INVENTORY.md:22` 一致 |
| 工具数 | recall 3 + note 5 + lexicon 2 + editor 3 + bili 4 + world-state 1 = 18 | `STATUS.md:149`「18 个工具」一致 |

## 一、测试清单

35 个文件、146 条断言，全部走 `createHost()` 在 `os.tmpdir()` 建临时库，**没有一个测试碰真实 DSH、真实模型、真实网络**。

| 测试文件 | 断言证明了什么（读断言得出） | 覆盖模块 |
|---|---|---|
| `adapter-dsh.test.mjs` (4) | 注入后 `dsh.names()` 恰为 8 个工具名；`presets.use('mem-only')` 后只剩 3 个；`adapter.dispose()` 后为空数组；`turn()` 返回里含 `context.onAssemble` 的文本。`dsh` 是 `fakeDsh()`（:15-28）手写 stub，只有 `tools.register` 与 `systemPrompt.section` | `adapter-dsh.mjs` + `surface`/`presets` |
| `archive-fallback.test.mjs` (3) | 块不含路径时 `recall` 输出匹配 `/出处\|原文\|写权限/`；块已含路径时 `assert.doesNotMatch(/出处：/)`；普通问句不触发原文层 | `recall` 的 raw 回退 + `services.raw` |
| `boundary.test.mjs` (4) | 静态扫 `packages/plugins/*/src/*.mjs`：禁 `@deepseek-ai/dsh-tools`、禁 `fetch(`（仅 `model-manager` 放行）、禁 `baseUrl:` 与 `apiKey:` 字面量；`manifest.slots` 禁 `model`/`baseUrl` | 全部插件源码 + manifest |
| `cleanup-person.test.mjs` (2) | 发给模型的 user 提示里必须出现 `people=42`，system 里必须出现「人物块可以用」；rewrite 后人物块含「养猫」且 `data.evidence` 里有 `type:'block'` | `dream` 的 `cleanup` job |
| `cleanup.test.mjs` (5) | `merges` 保留 keep、drop 标 `superseded:true` 且 `mergedFrom.length===1`；`uncertain:true` 落库；`rewrites`+`consumed` 改写人物块并把 resolve note 标 `consumed`；第二次同 job 返回 `skipped:'already-ran'`；只有一块时 `nothing-to-do` | `dream.cleanup` |
| `compaction.test.mjs` (3) | `dropped===2`（keepRecent:2）且装配文本含「压缩摘要」；1 条历史 `dropped===0`；模型返回空串时 `{ok:false,error:'empty-summary'}` | `compaction` + `context.compact` |
| `consume.test.mjs` (2) | `memo_commit({result})` 后词条 `data.status==='confirmed'`、备忘 `archived`；不传 result 时 `written===0` 且状态停在 `done` | `dream.consume` + `note` + `lexicon` |
| `context.test.mjs` (5) | `provideHistory` 截 limit；`onAssemble` 只能看到 history 并贡献文本；disposer 后装配变空串；未注册压缩器返回 `{ok:false,error:'no-compactor'}`；`maxChars:100` 时输出 ≤100 | `services.context` |
| `delivery.test.mjs` (5) | 同 `source` 二次 push 得 `{accepted:false,deduped:true}`；ack 后水位 9 且旧 seq 不再重发；push 抛错时 `pendingCount()===1`，下一轮送达；同 `batchKey` 合成一次 push；`to:'other'` 不归本会话 | `services.delivery` + `session.drainOnce` |
| `dream-jobs.test.mjs` (9) | events 出 2 块、block 带 `people`/`sources`、note 全标 `consolidated`；幂等 `already-ran`；模型抛错时 `ok:false` 且 note 无 `consolidated`；people 建档 `person:42` + `ids` + `familiarity` + `facts`；材料少时 `provisional:true`；模型给空 profile 时用笔记原文兜底；slang 同 term 只 1 块；dream 系统提示含「记忆沉淀器」；` ```json ` 包裹也能解析 | `dream` 全 job + `memory` |
| `dsh-raw.test.mjs` (2) | 注册 raw 源后能搜到会话原文且过滤掉 `Current runtime context`；`recall` 从 DSH 日志补一句「原文」并含 `qwenstuff`。写入的是**未压缩** `session.v4.jsonl`（:18），`decode()` 的 `.zstd` 分支未被覆盖 | `dsh-raw` + `recall` |
| `eager-recall.test.mjs` (5) | 命中时 `turnText` 含「你可能记得」「仅供参考」；`minScore:0.8` 时返回空串；`maxItems:2`/`maxChars:120` 生效；`host.disable('eager-recall')` 后归零；注入后 `delivery.drain('session')` 为空 | `eager-recall` |
| `focus-model.test.mjs` (8) | 无 focus 则全穿；glob 穿透（`qq:private:*` always、`qq:group:11` 需 mention、`qq:group:*` never、`timer` always）；TTL 过期 `current()===null`；`release()` 立刻失效；slots 形状不符 `autoBind()` 返回 `[]`、匹配则绑定；768 维接不上 1024 插槽；`client.pause()` 中止在飞请求且后续抛 `MODEL_PAUSED`；401 后重试一次成功（`calls===2`） | `services.focus`/`slots` + `model-client` |
| `host.test.mjs` (6) | enable 前 `toolNames()` 为空、enable 后 `['world_status']`；disable 后为空；提示词段「现在是 」随启停出现/消失；world(order 10) 排在 persona(order 20) 前且无 `\n\n\n`；`apply` 抛错时半个工具都不留；manifest 非法 id / 缺 version / 缺 apply 三种都抛 | `host.mjs` + `contracts.mjs` |
| `identity-e2e.test.mjs` (1) | `subjectKind:'mc'` 写入 → people job → `block.data.subject.kind==='mc'` → `whois({subjectKind,value})` 打回「一起玩 MC」 | `memory` + `dream` + `whois` |
| `lexicon-dream.test.mjs` (2) | 新词 `learned===1`、进 `note.count()===1`、词条 `status:'candidate'`；老词 `faded===1`、`usageState==='fading'`、`decay.weight<1` | `dream.lexicon` + `lexicon` |
| `lexicon.test.mjs` (4) | 无释义 → 候选 + 待办（`about.namespace==='lexicon'`）；有释义 → `lexicon` 回「已确认」「绷不住了」且待办不重复；一个词两来源分行显示 `group:1`/`bili`；`conv`/`platform` 两种查询都能命中 | `lexicon` |
| `literal.test.mjs` (4) | 带 Windows 路径、长文件名、带单位数字的查询，命中项必须排第一；无精确串的普通问句不受影响 | `memory.search` 的精确串加权 |
| `loop.test.mjs` (2) | resolve → cleanup 改写人物块含「男的」、`note.count()===0`、关闭记录 `status:'resolved'` 且 `answer` 含「男的」；无 `about` 的纠正不关无关疑问 | `dream.cleanup` + `note` + `dream` 的疑问关闭 |
| `m1-plugins.test.mjs` (8) | 命名空间隔离；`remember` 落 `event`/`note` 且无第二份库；768 维供应商 `unmatched().length===1`、`resolve` 为 null；1024 维自动接上；rhythm 触发 dream 写出含「看海」的块；无笔记 `skipped:'no-notes'`；recall 未先 enable memory 时抛「需要先启用插件：memory」；disable 后 `shared.get('memory')` 为 null | `memory`/`dream`/`rhythm`/`model-manager` |
| `m1b-persona-world.test.mjs` (8) | persona `set` 立刻进系统提示；两次 set 后 `versions().length===2`、`rollback(1)` 回到「第二版」；无 memory 时 `versions()` 为空；持久化在 `persona`/`persona-current`；world `cap:2` 只露两条且带「（还有 1 项）」；`read({owner,item})` 展开 detail、查不存在的项回「没有这一项」；来源返回 `[]` 时彻底消失；工具面只有 `world_status` | `persona` + `world-state` |
| `note-updates.test.mjs` (3) | `memo_append` 后 `note.count()===1` 且内容可见；`memo_commit` 后 open 归零、`memos({done:true,all:true})` 仍列原文；默认只列今天，`all:true` 才出现昨天 | `note` |
| `note.test.mjs` (4) | `memo` 建立/`resolve` 结掉后回「没有待办」；世界状态 brief 出现「还有 1 件事没了结」；`recall` 搜不到 memo；无 world-state 也能用 | `note` + `world-state` |
| `origin-tags.test.mjs` (2) | `origin.conv` 过滤：`group:1` 能搜到「爬山」、`private:2` 搜不到；`tag` 检索命中「海边」不命中「加班」；`mem.tags({})` 有「同事」 | `memory` + `recall` |
| `partial-coverage.test.mjs` (1) | 只把被 `evidence:[1]` 引用的那条 note 标 `consolidated`，另一条保持 `undefined`，`deferred===1` | `dream.events` |
| `pending-notes.test.mjs` (3) | 模型回 `[]` 时 `blocks 0 / deferred 1`、note 无 `consolidated`、碎片仍可 `recall`；30 小时前的碎片可召回且带「未整理」；空 profile 时用原文兜底并与 `qq:'99'` 建档 | `dream.events`/`people` + `recall` |
| `presets.test.mjs` (3) | 默认 `active()==='default'` 且含 `remember`/`memo`；自定义预设切走后 `memo` 消失、切回恢复；`list()` 里 `plugins===['note']`、`allowed().length===1` | `services.presets` + `surface` |
| `recall.test.mjs` (8) | `[今天]` 前缀；`kind` 只召回一类；默认召回全类；第二次带 cursor 不重复同一行；500 token 预算下反复召回能回到最早那条；召回后 `weight` 上升且 `lastRecalledAt` 非空；未消化旧片段带「未整理」、已消化不再出现；`forget` 只删指定 key | `recall` + `memory` 权重 |
| `rhythm.test.mjs` (5) | 同日第二次 `fire(...).fired===false`；`isDue` 到点前 false、到点 true、发过后 false；跨 host 重启（同 `stateFile`）`lastFiredDay==='2026-11-01'` 且不再触发；次日到点 true 并写 `2026-11-02`；`nextAt(20:00)===22:30` | `rhythm` |
| `route-person.test.mjs` (1) | `kind:'person'` 直接返回 `[人物]` + 档案 + 「依据」，不混入事件块 | `recall` 人物路由 |
| `subject.test.mjs` (3) | 通用 `subject:{kind:'mc'}` 能被 `whois` 查到；只有 `qq` 字段的旧档案仍可查；`findPerson({subject})` 命中 | `whois` + `memory.findPerson` |
| `surface.test.mjs` (4) | 只列已启用插件的工具且 `plugin:'recall'` 归属正确；enable note 后出现 `memo`/`memos`；disable 后立即收缩并触发 `onChange`；`summary()` 里 recall 贡献三个工具 | `services.surface` |
| `tool-constraints.test.mjs` (6) | `composeToolDescription` 拼 `Use when:`/`Avoid when:` 且无 `safety` 时不出现 `Safety`；长描述被压到 ≤300 且以 summary 开头；超预算先砍行再截正文、不产生空串；工具索引随 disable 更新、其他工具还在；60 个工具时截断并写「还有 N 个工具」；`whois` 最终描述 ≤ `TOOL_TEXT_LIMITS.perTool` | `services.tools` + `session.systemPrompt` |
| `vector-backfill.test.mjs` (4) | 无嵌入时 `missingVectors()` 列出全部带文字条目；`jobs:['index']` 后 `indexed===2`、`stats().vectors===2`、缺失归零；再跑 `skipped:'nothing-missing'`；`dream.run({jobs:['index']})` 可单独调用 | `memory` 向量 + `dream.index` |
| `whois-tags.test.mjs` (7) | 按 QQ 命中并回 `mc:DeepSeekBot` 与 `friend`；按 MC id 命中；同名两人回「2 个可能的人」；`people:['7']` 的事件只带三条；无档案回「还没有」；`tag` 只过滤不参与打分；`normalizeTags` 上限 5、小写、去重、超长丢弃 | `whois` + `recall` + `dream.normalizeTags` |

## 二、工具清单

9 个脚本，全部是「开发者侧」的：没有一个被 `packages/` 下的产品代码 import，
没有一个进 `npm test`（`package.json:10` 只跑 `node --test packages/core/test`）。

| 脚本 | 入口 / 用法 | 读的 flags 与环境变量 | 做什么 | 写盘 | 性质 |
|---|---|---|---|---|---|
| `tools/replay.mjs` | `node tools/replay.mjs [--source qq\|dsh] [--session <id>] [--real] [--debug]` | `args`：`--source`(默认 `qq`)、`--session`、`--real`、`--debug`；env：`USERPROFILE`、`ICL_LLM_BASE`、`ICL_LLM_MODEL`、`DEEPSEEK_API_KEY`、`ICL_EMBED_BASE`、`ICL_EMBED_MODEL`、`ICL_LEX_DEBUG` | 读 `dsh-qq` 的 `messages` 表或 `~/.dsh/sessions/<root>/<session>/*.zstd`，按 `Asia/Hong_Kong` 切天，逐天调模型抽 item → `mem.put` → `dream.run`；全库跑完后用块自动出 8 道题考 `recall` | `replay-report.json`（仓库根，:349）+ `os.tmpdir()/icl-replay-*` 里的 SQLite | 脚手架 |
| `tools/marathon.mjs` | `node tools/marathon.mjs [--config <json>] [--seconds N] [--keep]` | `--config`(默认 `config/marathon.json`)、`--seconds`、`--keep`；env：`DASHSCOPE_API_KEY`（:58） | 自建最小 agent 循环：文本协议 `{"tool","args"}`，最多 `cfg.maxSteps` 步，工具结果中 `write_file`/`remember` 的文本进 raw 层，结束时跑一次 `dream.run` 并导出 | `state/marathon-<ISO>.jsonl`（:118）、`state/marathon-exports/<ISO>/{memory.md,transcript.md}`（:237-267）、工作区 `state/marathon-workspace/`（默认先 `rm -rf`，:37） | 脚手架（不是产品路径） |
| `tools/recall-bench.mjs` | `node tools/recall-bench.mjs [--db <dir>] [--n N] [--k K] [--refresh-person]` | `--db`、`--n`(默认 3)、`--k`(默认 4)、`--refresh-person`；env：`ICL_LLM_BASE`、`ICL_LLM_MODEL`、`DEEPSEEK_API_KEY` | 从 `dsh-qq` 原文出四粒度题（detail/event/person/overall），对每题的 `expect` 分别算 `coverage`（块里有没有）与 `recalled`（recall/whois 前 k 条有没有）；人物题走 `whois` 逐档案扫 | `recall-bench.json`（:225）；**没有** `tools/fixtures/bench-qq.json` 时写一份（:117），带 `--refresh-person` 时**重写**这份「冻结题库」（:166） | 脚手架 |
| `tools/recall-diagnose.mjs` | `node tools/recall-diagnose.mjs`（无参数） | 无 flags；env 无。硬编码 `K=4`（:26） | 沿 `raw → note → block → candidate(前 50) → ranked(<4) → recall` 六层逐题定位，第一个 false 即「责任层」 | `recall-diagnose.json`（:95）；需要 `tools/fixtures/bench-qq.json` 与最近的 `os.tmpdir()/icl-replay-*` 库 | 脚手架 |
| `tools/cleanup-eval.mjs` | `node tools/cleanup-eval.mjs [--real] [--json]` | `--real`、`--json`；env：`ICL_LLM_BASE`、`ICL_LLM_MODEL`、`DEEPSEEK_API_KEY`、`ICL_EMBED_BASE`、`ICL_EMBED_MODEL` | 造 4 个事件块 + 1 个人物档案 + 1 条 resolve，只跑 `jobs:['cleanup']`，检查四件事：合并/软删、uncertain、纠正被消费、短块不被强行合并 | 无（只有 `os.tmpdir()/icl-cleanup-eval-*`）；退出码表达 pass/fail（:156-162） | 脚手架 |
| `tools/dream-eval.mjs` | `node tools/dream-eval.mjs [--real] [--json]` | `--real`、`--json`；env：`ICL_LLM_BASE`、`ICL_LLM_MODEL`、`DEEPSEEK_API_KEY`、`ICL_EMBED_BASE`、`ICL_EMBED_MODEL` | 固定一天 8 条 note 喂 `remember` → `dream.run` → 量块数/平均字数/块间二元组 Jaccard 重复率/7 条事实的覆盖率/3 个探针的 recall@3（无嵌入时如实跳过） | 无（`os.tmpdir()/icl-eval-*`）；`coverage<0.6 \|\| recall@3<0.6 \|\| dup>0.5` → 退出码 1（:221） | 脚手架（但它是唯一量「做梦质量」的入口） |
| `tools/threshold-calib.mjs` | `node tools/threshold-calib.mjs [--real] [--sample <json>]` | `--real`、`--sample`(默认 `tools/fixtures/calib-small.json`)；env：`ICL_EMBED_BASE`、`ICL_EMBED_MODEL` | 对 9 个阈值逐个算 `injectRate`/`hitRate`/`falseInject`，用 `hitRate - 0.5*falseInject - 0.2*injectRate` 推荐一个阈值 | 无 | 脚手架 |
| `tools/wire-check.mjs` | `node tools/wire-check.mjs [<config.json>]` | 位置参数 config（默认 `config/icl.local.json`，:28）；间接读该文件里的 `apiKeyEnv` → 环境变量 | 按配置注册供应商并打印 `providers()`/`skipped()`/`slots.list()`/人格字数，真调一次 `dream-chat` 与 `embed-text`，`chatOk` 时才跑 `dream.run` | 无（`os.tmpdir()/icl-wire-*`）；退出码 0/2（:98） | 脚手架（但它是唯一验证「接线」的入口） |
| `tools/bili-run.py` | `python tools/bili-run.py <function> '<json-args>'` | env：`BILI_DIR`（默认 `~/.dsh/bili-duty`，:14）；位置参数 `fn_name`、`kwargs` | 把 `BILI_DIR` 插到 `sys.path` → `importlib.import_module('mcp_server')` → 取同名 async 函数 → `asyncio.run` → stdout 打一行结果 | 无（只打 stdout）；退出码 2=用法错、1=import/调用失败 | 脚手架，**但是 bili 插件的生产依赖** |

### 工具侧的具体发现

1. **`recall-bench.mjs` 会改写自己的「冻结题库」**：`:117` 在文件缺失时写一份，`:166` 在 `--refresh-person` 时直接覆盖 `tools/fixtures/bench-qq.json`。所以「冻结」只对默认路径成立，带参数跑一次题库就变了，历史 baseline 不可复现。
2. **`marathon.mjs` 的 `cfg.plugins` 是死配置**：`config/marathon.json:10` 列了 8 个插件，但 `marathon.mjs:51` 的 enable 列表是硬编码的 9 个（多一个 `dream`），配置文件里的 `plugins` 从未被读取。
3. **`marathon.mjs` 用 `DASHSCOPE_API_KEY`（:58）**，而 `config/icl.local.json` 的 chat 供应商用 `apiKeyEnv: "DEEPSEEK_API_KEY"`；两套凭据名不一致，`wire-check` 与 `marathon` 不会共享同一把 key。
4. **`replay.mjs` 有 TDZ 隐患**：`:235` 注册的 raw 源闭包里用 `msgs`，而 `const msgs` 在 `:258` 才声明。当前调用顺序（`dream.run` 晚于 `:258`）没触发，但任何在 `:258` 之前调用 `raw.list/search` 的路径都会抛 `ReferenceError`。
5. **`replay.mjs` 只读 `.zstd`**（`:70`），`dsh-raw` 插件同时支持 `.jsonl` 与 `.jsonl.zstd`（`packages/plugins/dsh-raw/src/index.mjs:13`）；两个「读 DSH 会话」的实现是两套代码，口径不同（replay 只取 `>20` 字的 assistant 文本，dsh-raw 不设字数门槛）。
6. **`dream-eval.mjs` 的「假模型」路径不验证质量**：`fakeModel()`（:53-75）按 system 关键词返回写死的 JSON，覆盖率必然 100%。不加 `--real` 时它只证明管线通。
7. **报告产物已生成但不在版本控制里被约束**：`recall-bench.json`(5.2KB)、`recall-diagnose.json`(7.3KB)、`replay-report.json`(3.2KB) 在仓库根；`state/` 被 `.gitignore` 忽略，这三个不在忽略列表里。

## 三、脚手架 vs 产品

| 产品（有测试或属于运行时） | 脚手架（可删，不影响产品） |
|---|---|
| `packages/core/src/{host,services,session,contracts,model-client,adapter-dsh}.mjs` | `tools/replay.mjs`（历史回放，只验证管线） |
| `packages/plugins/{memory,recall,note,lexicon,dream,whois,rhythm,eager-recall,compaction,dsh-raw,persona,world-state,model-manager}/src/index.mjs` | `tools/marathon.mjs` + `config/marathon.json` + `config/marathon-30.json` + `prompts/marathon.md` |
| `packages/plugins/*/manifest.json` | `tools/recall-bench.mjs`、`tools/recall-diagnose.mjs`（依赖冻结题库） |
| `packages/core/test/*`（146 条断言，是回归闸门） | `tools/cleanup-eval.mjs`、`tools/dream-eval.mjs`、`tools/threshold-calib.mjs` |
| `prompts/dream.md`（`dream` 的 `personaFile`，`dream-eval.mjs:101` 与 `replay.mjs:175` 都指向它） | `tools/wire-check.mjs`（一次性接线自检） |
| `prompts/live.md`（`icl-live/index.mjs:35` 的默认人格文件） | `tools/bili-run.py`（桥；产品依赖的是它，但它是脚手架写法） |
| `config/icl.example.json`（唯一入库的配置样例） | `config/icl.local.json`（被 `.gitignore` 忽略，含真实模型地址） |
| `packages/plugins/bili`（在仓库里，但属「临时接缝」） | `tools/fixtures/bench-qq.json`(20 题)、`tools/fixtures/calib-small.json`(10 消息/4 记忆) |
|  | `state/*`：13 个 `marathon-*.jsonl`、`marathon-workspace/`、`marathon-exports/` |
|  | `replay-report.json`、`recall-bench.json`、`recall-diagnose.json` |
|  | `C:\Users\ai_admin\.dsh\plugins\icl-live\**`（DSH 插件，见 §4） |

`packages/plugins/editor` 是灰区：有 3 个工具（`read_file`/`write_file`/`list_dir`，含路径逃逸防护 `inside()`），
但**零测试**，`STATUS.md:56` 自己标「最小可用」。

## 四、外部接缝与硬编码路径

### 4.1 bili 插件 → `bili-run.py` 子进程

`packages/plugins/bili/src/index.mjs` 里四处写死（全部可用环境变量覆盖）：

| 代码 | 默认值 | 覆盖用 |
|---|---|---|
| `:10` `PY` | `C:\Users\ai_admin\.dsh\bili-duty\.venv\Scripts\python.exe` | `BILI_PYTHON` |
| `:12` `ICL_ROOT` | `C:/DSH/qwenstuff/icl` | `ICL_ROOT` |
| `:13` `RUNNER` | `<ICL_ROOT>/tools/bili-run.py` | `BILI_RUNNER` |
| `:14` `STORYBOARD_CLI` | `C:\Users\ai_admin\.dsh\profiles\desktop\node_modules\dsh-video-storyboard\bin\storyboard.mjs` | `STORYBOARD_CLI` |
| `:18` 子进程 `env.BILI_DIR` | `C:\Users\ai_admin\.dsh\bili-duty` | `BILI_DIR` |

调用链：`execFile(PY, [RUNNER, fn, JSON.stringify(args)], {timeout:60000, maxBuffer:4MB})` →
`bili-run.py:31` `sys.path.insert(0, BILI_DIR)` → `:33` `importlib.import_module('mcp_server')` →
`:38` 要求目标函数是 `iscoroutinefunction`（否则报 `no such tool`）。

依赖（本机实测存在）：

- Python `3.12.8`（`.venv\Scripts\python.exe -V`）。
- `bili-duty\.venv\Lib\site-packages` 里：`mcp 1.30.0`（`mcp.server.fastmcp`）、
  `bilibili_api_python 17.4.2`、`pillow 13.0.0`、`httpx 0.28.1`、`aiohttp 3.14.5`、`cryptography 50.0.2`。
- `bili-duty\mcp_server.py` 顶部 `from bilibili_api import video, search, comment, Credential, ...`（:26-32）。
- 用到的四个函数确实存在且都是 `async def`：`bili_search:265`、`bili_comments:313`、
  `bili_subtitle:385`、`bili_video_info:474`；签名与插件传参一致（`keyword/num/order`、`bvid/num`、`bvid`、`bvid`）。

**移动即坏**：

- 删/改 `.venv`（重装成 3.13、或换 `python.exe` 位置）→ `execFile` ENOENT 或 `import mcp_server` 失败，
  `bili_*` 全部只回一句「搜不动：…」，不会抛错（`:19` 把 error 转成 `{ok:false}`）。
- `bilibili_api` 大版本变更（`Credential`/`comment` 接口改名）→ 四个函数内部抛，
  被 `bili-run.py:45` 兜成 `{"ok":false,"error":...}`；插件侧看不出是哪一层坏。
- `bili-duty\bili_credential.json`（390 B）缺失 → `bili_subtitle`/`bili_comments` 走未登录路径，
  返回空或错误字符串（`load_credential:56`）。
- 移动仓库 → `ICL_ROOT` 默认值失效 → `RUNNER` 指向不存在的 `tools/bili-run.py`。

### 4.2 `bili_frames` → `dsh-video-storyboard` CLI

`bili/src/index.mjs:103-129`：

- 参数：`[STORYBOARD_CLI, url, '--cells', ≤16, '--out', <tmp>/sheet.png, '--manifest', <tmp>/m.json, '--allow-anonymous', '--from', start, '--to', start+240, '--scan-height', '240']`。
- 用 `execFileSync(process.execPath, args, {timeout:600000, maxBuffer:8MB})`（:115）——
  **同步阻塞**，最长 10 分钟，且跑在 DSH/插件的事件循环里。
- 读回的 manifest 只用 `sheets[].cells[].t_start/t_end` 与 `transcript.chars`（:120-127）。

依赖（本机实测）：

- `dsh-video-storyboard 0.4.2`（`package.json` 的 `bin` → `./bin/storyboard.mjs`，194 行）。
- 该 CLI 支持 `--allow-anonymous`（`bin/storyboard.mjs:26,38`）与 `--scan-height`（:39），
  但**这两个 flag 没写进它自己打印的 usage（:31）**，属于未文档化契约，升级即可能消失。
- `ffmpeg.exe` / `ffprobe.exe` 在 `C:\DevTools\ffmpeg-8.1.2-full_build\...\bin\`（PATH 上）；
  storyboard 需要它们做探测与抽帧，`probeVideo` 失败即 `process.exit(1)`（:57-60）。
- 联网取流：URL 走 `resolveInput`（`src/fetch.js`），B 站链接需要匿名或 cookies；`--allow-anonymous` 是硬编码传的。

**移动即坏**：profile 目录换名（`profiles\desktop` → 别的 profile）或 `pnpm install` 换版本 → `STORYBOARD_CLI` 路径失效，
`execFileSync` 抛错被 `:116` 兜成「看不成画面：…」，`bili_frames` 静默降级。ffmpeg 移出 PATH → CLI 退出码 1，同样表现。

### 4.3 `icl-live`（DSH 插件，当前停用）

文件在 `C:\Users\ai_admin\.dsh\plugins\icl-live\`，**已不在** `C:\Users\ai_admin\.dsh\profiles\desktop\package.json`
的 `dependencies` 与 `dsh.profile.bundles` 里（实测该文件已无任何 `icl-live` 字样），所以现在不会被加载。

- `index.mjs:9` `ICL_ROOT = process.env.ICL_ROOT ?? 'C:/DSH/qwenstuff/icl'`；`:34` workspace 默认 `~/.dsh/icl-live/state`；
  `:35` persona 默认 `<ICL_ROOT>/prompts/live.md`；`:36` dream persona 默认 `<ICL_ROOT>/prompts/dream.md`。
- `:49-53` 用 `import('file:///' + ICL_ROOT + ...)` 动态加载 core 与 10 个插件
  （memory/recall/note/lexicon/editor/bili/dsh-raw/world-state/rhythm/dream），每个都读 `manifest.json`。
- `:81` `try { ({ defineTool } = await import('@deepseek-ai/dsh-tools')) } catch {}`——
  该包声明在 `package.json` 的 `dependencies`（`0.2.0-rc.2`），但插件目录**没有 node_modules**，
  profile 的 node_modules 里只有 `@deepseek-ai/{cosmokit,schemastery}`。实际走「裸定义」分支。
- `presets/icl-live.patch.yml` 里还引用了三个外部包：`@deepseek-ai/dsh-agent-preset`、`@deepseek-ai/dsh-persona`、
  `@deepseek-ai/dsh-tool-todo`、以及 `dsh-video-storyboard`；模块名写的是 `dsh-icl-live/index.mjs`。

**实跑痕迹与一处真 bug**：

- `~\.dsh\icl-live\state\state\memory.db`（28 KB，2026-11-02 18:48）证明它确实跑起来过；
  注意路径里 `state` 出现了两次——插件把 `root` 传成 `~/.dsh/icl-live/state`，而 memory 插件在 `root` 下再建 `state/memory.db`。
- `index.mjs:134` `host.services.get('rhythm')`：`createHost()` 返回的 `services` 里**没有 `get`**
  （`host.mjs:134` 只有 tools/prompt/focus/delivery/slots/model/raw/context/surface/presets），
  这行抛 `TypeError` 被 `catch` 吞掉 → `rhythm` 恒为 `null` → `:147-151` 的 30 秒 `tick()`
  永远算不出 `nextAt` → **「到点自己整理」从来不触发**（`STATUS.md:163` 与 `TECHNICAL.md` 的「到点自动」描述因此不成立）。
  手动 `dream_now` 工具（`:158-175`）不受影响。
- `:167` 的 job 结果字段取 `r.notes ?? r.blocks ?? r.learned ?? r.written`，与 `dream` 各 job 的实际返回字段
  部分对不上（`wash` 返回 `notes`、`events` 返回 `blocks`、`cleanup` 返回 `merged/rewrites/consumed`），
  所以 `dream_now` 对 cleanup 会打印空串。

## 五、文档清点（`docs/*.md`，11 个）

| 文件 | 讲什么 | 与代码是否还对得上 |
|---|---|---|
| `AUDIT.md`（2026-11-01） | 复盘：已闭环的链路、6 个服务、与旧 ICL 的差距 | **过期**。写「109 测试」「核心只有 6 个服务」；现在 146 测试、10 个服务（多 context/surface/presets）。风险表第一条「事件 job 只要有任一块写出就全标已消化」**已被 `partial-coverage.test.mjs` 推翻**（只标被引用的）。 |
| `DIAGNOSIS-THIN-MEMORY.md`（11-02） | 记忆为什么薄：四条原因 + 思维链 | **部分过期**。「原文截断 240 字/200 行 → 未改（需要讨论）」：代码已改成总预算 `washChars=12000` / 单行 `washLineChars=1200`（`dream/src/index.mjs:127-128`），正是文档里提的方案。「wash 要求一句话」已改「两三句」（:149-151），与文档一致。 |
| `STATUS.md`（11-02 19:25） | 冻结快照：A 已实现 / B 脚手架 / C 临时 / D 没做 / E-G DSH 接线 / H 触发 / I 压缩 | **三处需修**：① 头部「提交 `fb4fb5e`」落后 7 个提交（HEAD `5d8c190`）；② `:83`「`ICL_TOOL_TIME=1` 时在每次工具结果后追加当前时间」——**现在是真的**（`host.mjs:13` 传 `stampTime`、`services.mjs:270` `execute: stamped`，`:262` 追加 `\n（现在 HH:MM:SS ）`，注意 `）` 前有一个空格），这条在 `5d8c190` 之前是假的（`docs/audit/core.md` 至今仍按「死代码」写，那是旧结论）；③ §B 说 icl-live「尚未加载成功」、§G 说已接进 profile，而当前 profile **已移除**——三段互相矛盾。 |
| `INVENTORY.md`（11-02 19:56） | 盘点：规模、15 插件、关掉的接缝、世界状态实测输出 | **对得上**。15 插件、35 测试文件、146 测试、「icl-live 已从 profile 依赖与 bundles 移除」均实测一致（`profile/package.json` 确无 icl-live）。 |
| `TECHNICAL.md`（11-02 20:01，未入库） | 总览：分层、一次会话、契约、已知硬矛盾 10 条、测试 | **基本对得上**。#1 ICL_TOOL_TIME 标「已修（5d8c190）」与代码一致；#3「`sync()` 每次全量重注册」与 `adapter-dsh.mjs:27-38` 一致（先 `prev()` 再 re-register）。 |
| `PLUGINS.md`（11-01） | M0-M1 插件实现报告（persona/memory/light-memory/rhythm/dream/world-state/model-manager） | **明显过期**。「39 条测试」；§三整节讲 `light-memory` 插件（**该插件已不存在**，`packages/plugins/` 无此目录，能力并入 `recall`）；§五说 dream 写 `dream:<session>` 的 `summary`，实际写 `event/person/slang` 的 `kind=block`。 |
| `MEMORY-DESIGN.md`（11-01） | 记忆分层评审 + 已定决定 + 做梦流水线 + 评测 + 整理轮 + 碎片 + 阈值标定 + 回放 | **主体对得上**：三 job 幂等（`cleanup.test.mjs`、`dream-jobs.test.mjs`）、软删 `superseded`、`deferred`、`[未整理]` 标签、`dream-eval` 阈值（0.6/0.5）都与代码一致。§十七写「阈值 minScore 0.55」、§十八写「已改默认 0.50」——代码是后者（`eager-recall/src/index.mjs:15` `ctx.config.minScore ?? 0.5`），所以 §十七那张对比表里的 0.55 已过期。 |
| `MEMORY-INTEGRITY-DESIGN.md`（11-01） | 证据链、疑问区、人物更新策略（设计稿 + 实现状态） | **大体落地**：`note` 插件、`memos` 世界状态一行、`consume` job、`claims`（`dream` 人物 job 输出含 `claims`，`whois-tags`/`route-person` 测试用到）都在。§八「下一步：evidence 变成必填」仍未做——`cleanup-person.test.mjs` 是喂模型给 evidence，不是强制。 |
| `LEXICON.md`（11-02） | 语料层设计：桶/字段/采集/aging/不做的事 | **对得上**：`packages/plugins/lexicon` 的 `lexicon`/`lexicon_learn`、`origins` 多来源、`status: candidate→confirmed`、`usageState: fading`、`decay.weight` 都有 `lexicon.test.mjs`/`lexicon-dream.test.mjs` 兜。文档里仍是「设计稿」口吻，但 §十/§十一 的实现约定已落地。 |
| `NEXT.md`（11-01） | 待办：subject 通用化、工具面、标签与来源、slang 改造 | **已完成项未勾**：§1 subject（`subject.test.mjs`/`identity-e2e.test.mjs` 已过）、§2 工具面（`surface.test.mjs`）、§3 标签与来源（`origin-tags.test.mjs`）都实现了，文档仍写成待办；文末「审计遗留」表倒是对的。 |
| `SLOTS.md`（11-01） | 插槽契约：只声明形状、管理器按形状接线 | **对得上**（`focus-model.test.mjs` 的 768/1024 用例、`host.mjs:164-172` 由宿主代注册 manifest.slots）。 |

`docs/audit/` 下另有三份同批产物（`core.md`、`dream-and-life.md`、`memory-plugins.md`），
其中 `core.md` 关于 `ICL_TOOL_TIME` 的「死代码」结论已被 `5d8c190` 推翻，读时注意。

## 六、完全没有测试的行为

| 没被测的东西 | 证据 | 风险 |
|---|---|---|
| **真实 DSH 适配** | `adapter-dsh.test.mjs:15-28` 的 `fakeDsh()` 只有 `tools.register` 与 `systemPrompt.section`；`ctx.tools.register` 的返回值、参数 schema 校验、`systemPrompt.section` 的真实签名都没验过 | 契约只要有一处不同，注入就静默失败 |
| **`icl-live` 端到端** | 没有任何测试文件提到 `icl-live`；`node --test packages/core/test` 不可能加载它 | 「18 个工具注册成功」只有文档里的 mock 干跑，且 §4.3 的 dream tick 已确认是坏的 |
| **DSH 内压缩（compaction）** | `compaction.test.mjs` 只经 `context.compact` 调用插件，没有任何 DSH 侧 `onCompact` 接线测试；`STATUS.md:99` 自认「未联调」 | 真实压缩改写历史后，`dsh-raw` 读到的原文与做梦假设不一致 |
| **bili 接缝** | 35 个测试文件里 0 个 import `plugins/bili`；`bili-run.py` 也没有任何测试 | 四个工具全部靠路径与 venv 正确才能工作；坏了只回一句中文 |
| **`bili_frames`** | 同上；`execFileSync` 阻塞 600 秒的行为没有任何超时/取消测试 | 一次坏链接可能卡住一整轮 |
| **做梦产出的质量** | `dream-eval.mjs` 默认走 `fakeModel()`（写死 JSON，必然 100% 覆盖）；只有 `--real` 才量真质量，而它不在 `npm test` 里 | 「做梦好不好」只能人工跑，没有回归闸门 |
| **`dsh-raw` 的 `.zstd` 分支** | `dsh-raw.test.mjs:18` 写的是 `session.v4.jsonl`（未压缩），`decode()` 的 `zstdDecompressSync` 从未执行 | 真实会话日志是 `.jsonl.zstd`，解压失败会被 `catch` 吞成空串 |
| **`editor` 的路径逃逸防护** | `editor/src/index.mjs:11-14` 的 `inside()` 零测试；`packages/plugins/editor` 不被任何测试 import | 这是唯一一处「不让模型写出工作区」的防护 |
| **投递的第 5 次丢弃** | `services.mjs:433` `maxAttempts=5`、`:520` 达上限即 `dropped`；`delivery.test.mjs` 只测了失败后能重投 | 静默丢弃且没有观测出口（`TECHNICAL.md` #8 自认） |
| **`marathon.mjs` / `replay.mjs`** | 两个脚本都没有测试；`state/` 里有 13 份运行日志，但那是产物不是断言 | 只能靠「跑完看一眼报告」判断 |
| **真实嵌入质量** | `threshold-calib.mjs --real` 需要 `ICL_EMBED_BASE`/`ICL_EMBED_MODEL`；`docs/MEMORY-DESIGN.md:459` 的样本是 10 条消息 | 0.50 这个默认阈值没有大样本支撑 |
