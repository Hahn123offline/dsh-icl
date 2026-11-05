# 现状与缺陷台账

> 读者：要判断"这个能不能信"、或准备修东西的人。
> 口径：本文所有结论基于 2026-11-03 的 HEAD `7314168` 与工作区改动，一次实跑（`node --test packages/core/test packages/mc-body/test` → 269 通过）。
> 证据等级见 [OVERVIEW.md §4](OVERVIEW.md#4-资产盘点)。旧审计的 11-02 状态列已由 [MEMORY.md §8](MEMORY.md) 与本文 §9.5 取代。

---

## 1. 基线

| 项 | 实测值 |
|---|---|
| 测试 | **269 通过 / 0 失败**，49 个文件，约 4.0 秒 |
| 源码 | 旧口径 40 个 `.mjs` / 8,277 行；2026-11-03 晚新增 `packages/dsh-icl`（7 个 `.mjs`）与 `core/dsh-contract.mjs`，未逐行重算 |
| 服务 | 13 个（`tools prompt focus delivery slots model raw context surface presets signals vision clock`） |
| 插件 | 19 个 / **39 个工具**（manifest 与代码完全一致，无多无少） |
| 数据 | SQLite 3 表 / 11 个命名空间 / 向量 1024 维 |
| 做梦 | 7 个 job（`wash → events → people → lexicon → consume → cleanup → index`） |
| 依赖 | 核心零依赖；适配器需要 `js-yaml`、`@deepseek-ai/dsh-host-apiproxy`（**未在 package.json 声明**） |

## 2. 能力状态

| 能力 | 状态 | 证据 | 说明 |
|---|---|---|---|
| 插件宿主 / 生命周期 / 工具面 | 可用 | E1 | 启停、预设过滤、注销链都有测试 |
| 记忆存取 / 混合检索 / 四类召回 | 可用 | E1 | 全仓库测试最厚的地方 |
| 原文兜底（raw） | 可用但残缺 | E1 + E3 | 只解析两类事件，工具结果进不来 |
| 做梦七步 | 可用但产物质量待调 | E1 + 真模型固定素材 | 幂等、跳过、失败语义都有测试；块的粒度与人物合并靠模型 |
| 词汇层 | 可用但噪声大 | E1 + E3 | 5 分钟会话抽出 16 条，多数是单字噪声 |
| 时间 / 日程 / 唤醒 / 积压 | 可用 | E1 + E3 | 真实会话里通过一次（5 分钟） |
| 信号路由 | 可用 | E1 | 三条路由（model / plugin / focus） |
| 人格注入 | 可用 | E1 + E3 | 每 5 秒求值，不再是一加载就冻结 |
| 世界状态 | 可用（基础版） | E1 | 只读总线；`time` 与 `world-state` 各注册一个「时间」来源，提示词会出现两行 |
| 投递 | 部分空转 | E1 | `delivery.push` 在插件里**零调用**，只有信号层在用 |
| 压缩 | 未验证 | E0 | 只过单测；真实会话到不了 12000 字符阈值 |
| B 站工具链 | 临时接缝 | E3（人工跑过） | 4 个工具；`bili_frames` 阻塞可达 600 秒 |
| DSH 接线 | 半断 | E3（两次 5 分钟） | 见 [DSH-INTEGRATION.md](DSH-INTEGRATION.md) |
| 单会话约束 | 未强制 | — | 仓库内没有任何东西阻止两个实例同跑 |

## 3. 缺陷台账（HEAD 上复核仍存在）

编号沿用原审计（`C` 核心 / `M` 记忆 / `D` 做梦 / `T` 工具），便于和归档对账。
原 80 条已归档到 [archive/2026-11-02-audit-findings.md](archive/2026-11-02-audit-findings.md)。

### 3.1 核心

| ID | 问题 | 后果 |
|---|---|---|
| C-16 | 装配期所有 `try/catch` 是空体 | **已修（晚）**：prompt / context / raw / slots / surface 的失败现在经 `core.service-error` 上报 |
| C-12 | 三条注入路径互不知情：`session.installTools`、`attachDshAdapter`、`surface` | 仍在：新桥已经只走 `surface`，旧路径待删 |
| C-13 | `session.start()` 的定时器不被 `host.disable` 回收 | 仍在（`session.mjs` 只被 tools/测试使用） |
| — | `model` 服务只把 5 个方法挂上 ctx | `chatDetailed` / `current` / `inflightCount` 在 `ctx.model` 上取不到，想拿 reasoning 得绕路 |
| — | `presets` 机制整体空转 | 唯一预设有且只有 `default`；`use/define` 无调用方；`manifest.presets` 没有读方 |

### 3.2 死代码（不是风格问题，是会误导后来人）

| 符号 | 事实 |
|---|---|
| `ctx.delivery.push` | **没有任何插件调用过**。"投递是唯一出口"在代码里只有信号层一个使用者 |
| `services.presets.use/define` | 无调用方；唯一预设有且只有 `default`；16 个 manifest 都没写 `presets` |
| `focus` 服务 | 只有 `time` 一个真实使用者（进入 / 释放注意力空间），`session.mjs` 另有一处读取 |
| `memory.archiveSearch` | 无调用方，与 `raw` 功能重叠 |
| `context.compactors()`、`signals.peekGate()` | 无调用方 |
| `session.mjs` | 仅被 `tools/time-accept.mjs` 与测试使用 |
| `packages/adapters/*` | 仓库内零调用方，真实使用者是仓库外的 `icl-live` |
| `dream.jobSlang` | 在 `JOBS` 表里但不在默认序列（`slang` 已并入 `lexicon`） |
| `time` 的 `ctx.services.require('signals')` 兜底 | 该分支**必然抛错**（`signals` 不在 `shared` 能力表里） |

### 3.3 记忆与做梦

记忆侧的 12 条缺陷归 [MEMORY.md §8](MEMORY.md#8-已知缺陷记忆侧) 所有（5 条高危），这里不重复。
只留最影响"她记不住 / 记错"的四条，加一条跨域：

| 现象 | 详见 | 后果 |
|---|---|---|
| 窗口全是"最老 N 条"：`query` 500、`events` 回查 200、`consume` 200、`lexicon` 500 | MEMORY §8-4 | 库长大以后新行进不了窗口，表现为"记不住最近的事" |
| `raw.list` 只返回 `{text,time,role}`，`wash` 却读 `r.sender` | MEMORY §8-5 | 原话层丢掉"谁说的"，是"记错人"的主因 |
| `cleanup` 三次 `patch` 都基于改写前的 `existing.data` | MEMORY §8-2 | 块越改越薄，正文与证据不匹配 |
| 日界三套实现（本机时区 / `+08:00` 写死 / `config.timezone`） | MEMORY §8-12 | 改时区后同一天跑两遍 wash，幂等键记两份 |
| `model-manager` 只 bind 第一个 chat provider | PLUGINS §5 | 配置里有两个 chat 时，第二个永远拿不到模型 |

### 3.4 时间与信号

同样不重复：[TIME.md §8](TIME.md#8-已知问题) 有 15 条带行号的清单，其中三条高危：

| 现象 | 后果 |
|---|---|
| `ctx.services.require('signals')` 的兜底分支必然抛错 | 没有 `ctx.signals` 的场合不是降级而是崩 |
| `inboxOffset` 只在内存里，重启归零 | 重启把历史 inbox 命令全部重放一遍（`pause` / `arrange` / `reset` 各再执行一次） |
| `time` 与 `world-state` 各注册一个「时间」来源 | 系统提示里出现两行「时间：」，其中一行没有阶段与日程 |

### 3.5 接缝与工程

| ID | 问题 | 后果 |
|---|---|---|
| — | `time` 的 `inboxOffset` 不持久化 | 重启后游标归零，**历史 inbox 命令会被全部重放**（重跑一遍 arrange/cancel） |
| T-8 | `icl-live` 曾在 `host.services.get('rhythm')` 上抛 TypeError 被吞 | 已改为 `host.shared.get`，但**"到点自动整理"没有在真实会话里复验** |
| — | `js-yaml`、`@deepseek-ai/dsh-host-apiproxy` 三个 `package.json` 都没声明 | 只在本机靠 junction 指到 `dsh-qq/node_modules`；换机器即断 |
| — | 没有任何文件锁 | `memory.db` 与 `time.json` 多进程共写无保护 |
| — | 4 处 `C:\Users\ai_admin\...` 绝对路径 | 见 [PLUGINS.md §6](PLUGINS.md) |
| — | 仓库根三个评测 JSON（`recall-bench/diagnose`、`replay-report`）未 gitignore | 报告产物混进源码树（整理时已移走） |

## 4. 静默失败清单

这一节单独列，因为它是**系统性问题**，不是某一条 bug。对一个记忆系统来说，这是最危险的失败形态：
记忆变薄、人格段消失、工具没注册，**都不会报错**，只表现为"她想不起来"或"她不说话"。

| 位置 | 失败表现 | 调用方能知道吗 |
|---|---|---|
| 装配期全部 `try/catch` | 段消失、策略消失、raw 源失效 | ❌ |
| `delivery` 第 5 次 `nack` | 条目丢弃、水位不推进 | 只能查 `droppedCount()` |
| `dsh-raw` `.zstd` 解压失败 | 返回空串 → 当天原文为空 | ❌ |
| `dsh-raw` 只解析 `user/assistant` | 工具结果从不进原文层 | ❌（表现为人物记忆里没有 UP 主） |
| DSH 插件未挂进 profile | 工具面 / 人格都不出现 | ❌（插件根本没被加载） |
| 模型 provider 缺 key | 跳过该 provider 并 warn | 需看日志 |

## 5. 测试覆盖与盲区

覆盖是**不均匀**的，方向恰好与风险相反：

| 区域 | 覆盖 | 备注 |
|---|---|---|
| 记忆 / 做梦 / 召回 | 厚（约 24 个文件、2000 行） | 数据流水线质量高 |
| 核心服务 | 直接覆盖 8/10，`contracts` 与 `session` 仅间接 | — |
| `vision.mjs`（44 行） | **零** | 视觉描述无任何测试 |
| `adapters/dsh-client.mjs`（1008 行） | **零** | 全仓库最大文件，也是最不可替代的一块 |
| `tools/*.mjs`（13 个、1979 行） | **零** | 它们自己就是断言脚本，但不进 `npm test` |
| `bili` 子进程分支 | 零 | 只测了工具面形状与路径逃逸 |
| 真实 DSH / 真实模型 / 真实网络 | **全部没有** | 所有测试跑在 `os.tmpdir()` 的临时库上 |

## 6. 真实会话证据（唯一）

2026-11-03，两轮各约 5 分钟，preset `icl-live`，模型 `coder390-27b`：

| 项 | 结果 |
|---|---|
| 建会话 / 指定工作区 / 发消息 | ✅ |
| 定时器（`arrange in 1m, duration 3m`）→ 到点 → 醒来 | ✅ |
| 睡觉触发做梦 | ✅ 触发；❌ 产物只有 1 条词、无块 |
| 做梦产物不全的原因 | `dsh-raw` 把 v4 消息读成空（已修，有 `dsh-raw-v4.test.mjs`） |
| 修好后用同一天重放 | wash 11 行 · events 1 块 · people **0** · lexicon 16 条（多为噪声） |
| `people 0` 的原因 | 工具结果不进 raw，视频作者永远不在原文里 |
| 内容质量 | 她自己写了 10 条笔记，细节可读——这是唯一"效果"证据 |
| 作废的一轮 | 两个会话共用一份 `time.json`，预写状态被启动时的 `persist()` 覆盖 |

## 7. 下一步（按证据优先级，不按功能优先级）

现在的瓶颈不再是"缺接线"，而是"接线还没在 desktop 与长会话里跑过"。所以顺序是：

1. ~~把 `icl-live` 搬进仓库~~ **已完成（P0）**：`packages/dsh-icl`，headless 实测。
2. **装进 desktop profile 并开一次真实会话**：已通过 `pluginManager/removeBundle` + `installBundle`
   完成旧包移除与新包安装（`application: applied`）；**重启 DSH 一次**让新模块代际加载，
   然后选 preset `ICL`（id `icl`），验证真实 wake → `agent.followup` → 新轮。
3. **恢复 focus 的注意力语义**：第一切片（policy + 积压 + 工具 + 提示词）已落地并通过测试；
   待 desktop 重启后复验，然后做 focus 持久化 / Activity 注册表 / watermark / nudge。
4. **跑一次 ≥30 分钟闭环**：醒来 → 做事 → 睡觉 → 做梦 → 醒来，全程一个会话，
   结束固定导出 `memory_export` + `raw_export`。
4. **让 dream 用桥的原文层**：`tool/result` 已经进 `session-events.jsonl`，但 dream 还只认
   `raw` 服务的查询；需要确认它读到的就是这份（而不是 `dsh-raw` 的文件扫描）。
5. **删旧路径**：`packages/adapters/*` 与 `adapter-dsh` 的活跃使用；`vision.mjs` 补测试。
6. **然后才谈**：压缩联调、`focus`/`presets` 的去留（要么接进真实路径，要么删）、
   B 站工具深度、QQ/MC 连接器。

## 8. 已修复的历史缺陷（不要重复报告）

11-02 晚的 `7643262`、`bc2a709` 等提交修掉了一批审计结论（当时记了 23 条对照表）。
以下主题**已有回归测试**，不要当作新发现：`ICL_TOOL_TIME` 死代码、enable 后不推送新工具、
`sync()` 非增量、`validateManifest` 丢字段、非 `default` 预设清空工具面、
`systemPrompt/installTools` 不按预设过滤、截断超预算、投递丢弃无计数、`binding.timeoutMs` 被忽略、
provider 注销不解除绑定、dream 提示词字面 `
`、人物笔记永不 `consolidated`、
`alreadyRan` 只看 200 行、跨天上下文 `qq:42` vs `42`、重跑降级 evidence、
world-state 的 `order` 与 `。；`、compaction 取最旧 20 条里的最新、`marathon.cfg.plugins` 死配置。

**仍然开着的**：同一会话两个 chat provider（`model-manager` 只 bind 第一个，即 D-20）。

---

## 9. 2026-11-03 晚：DSH 接线重建（P0）

这一步只做核心/信号/DSH 边界，不碰插件业务。审计与目标契约见 [CORE-AUDIT.md](CORE-AUDIT.md)。

### 9.1 新增

| 位置 | 内容 |
|---|---|
| `packages/core/src/dsh-contract.mjs` | ICL 形状 → DSH 契约：`{output}` 工具定义、`toDshUserMessage`、`toDshPromptSection`、原文文本提取 |
| `packages/dsh-icl/` | 本仓库唯一的 DSH 插件与 preset：工具面、提示词、投递、`session/event`、`agent/pre-step`、单会话、原文来源 |
| `packages/core/test/dsh-bridge.test.mjs` | 15 个契约测试（假 ctx 按真实签名：`output`、`(session,event)`、`text` 函数） |
| `packages/core/test/dsh-bundle.test.mjs` | 5 个可安装性测试（bundle 清单、preset patch、headless patch、locale/icon、files） |
| `docs/CORE-AUDIT.md` | 现状审计 + 真实 DSH 契约 + 迁移顺序 |

### 9.2 修掉的核心缺陷

| ID | 修复 |
|---|---|
| C1 | `ctx.tools.register` / 注销都触发 `surface.notify()`，运行中工具面会推给适配器 |
| C2 | `enable` 不再在 `apply` 前发空通知；apply 失败会回滚并通知 |
| C3 | `surface.list` 真正使用传入的 `preset` |
| C-16 | prompt / context / raw / slots / surface 的空 catch 改为 `onError`，host 记为 `core.service-error` |
| C5 | `adapter-dsh` 改用 `toDshToolDefinition`，补上 DSH 必填的 `output`，参数变化会重注册 |
| B1–B7 | `signals`：删掉未实现的 `focus` 路由；`expiresAt` 生效；无 deliver 时报错；deliver 抛错不占 id；blocked 不占 id；gate 抛错 fail-open 并计数；订阅者错误计数；统计拆开 `delivered` / `failed` / `expired` / `gateErrors` / `listenerErrors` |
| C8 | `time` 的 `ctx.services.require('signals')` 回退分支（必然抛）改成显式要求 `ctx.signals` |

### 9.3 实测证据（headless + desktop）

```bash
dsh --profile headless --patch C:/DSH/icl/packages/dsh-icl/cordis.patch.yml "只回复两个字：ok"
```

| 项 | 结果 |
|---|---|
| 插件挂载 | ✅ 15 个默认 ICL 插件全部启用（rhythm 已移出默认），`failed: []` |
| 工具面 | ✅ `request/header` 里 55 个工具，其中 31 个来自 ICL（focus 后；focus 前 27） |
| 提示词 | ✅ `system/message` 含人格卡（`你是小千`） |
| 原文层 | ✅ `session-events.jsonl` 记录 user / assistant / tool 三类；`runtime-context` / `skill-catalog` 被过滤 |
| 记忆库 | ✅ `memory.db` 11 个命名空间全部注册 |
| 时间 | ✅ `time.json` 生成；`time_arrange` 真实调用成功，`fired` 记录到点 |
| 投递 | ✅ session `1f855bc3`：wake → delivery → `agent.followup` → DSH turn 2（user `醒醒`）→ assistant 回复 |
| 每轮上下文 | ✅ session `4de2a564`：`agent/pre-step` 把 eager-recall 结果作为 `<icl-context>`（runtime-context）追加进本轮，模型引用了它 |
| desktop preset | ✅ session `cdd5c239`（`agentPreset=icl`）：27 个 ICL 工具、人格段、原文层；`time_arrange` → wake → 第 3 轮（user `醒醒`） |
| focus 工具 | ✅ headless 会话 55 个工具，`focus_enter` 真实调用成功；`focus-semantics.test.mjs` 7 个测试 |
| focus desktop | ✅ session `f8f5f631`：31 个 ICL 工具；`focus_enter` → `focus.json` 落盘 → `focus_status`（勿扰）→ `focus_leave` 清空 |
| focus 恢复 | ✅ headless 预写 `focus.json` 后启动，`focus_status` 直接返回"重启前的事"与 `qq:group:1 +2` |
| 单会话否决 | ✅ desktop 第二个 ICL 会话被拒绝：`ICL 只允许一个会话：已占用…` |
| 记忆 desktop | ✅ session `0659851f`：31 个 ICL 工具、人格段；`remember` 同 key 重写后权重仍 `1.7`（`recall_count=1`） |
| 检索窗口 | ✅ desktop 里种入 600 条事件块，`recall(query=蓝色风筝)` 仍找到最老那条 |
| note 计数 | ✅ desktop 里种入 501 条 open note，`note_status` 返回"待办 501 条" |
| 老词重学 | ✅ desktop 里 500 条外的老词重学后，`tags` / `decay.weight=2` 保留，新 origin 追加 |
| recall 类别 | ✅ desktop 工具 schema：`recall.kind` 只有 `event/person/slang`，`remember.kind` 仍有 `resolve` |

### 9.4 仍然断着

1. `packages/adapters/*`（HTTP 客户端、delivery-pump）还在，但已不在活跃路径；应在 P3 删除。
2. `packages/plugins/bili` 与 3 个 tools 脚本仍写死 `C:/DSH/qwenstuff/...`。
3. **desktop preset 已验证**：重启后 `preset icl` 正常；session `cdd5c239`（focus 前）与
   `9a69e92f`（focus 后，31 个 ICL 工具）都以 `agentPreset=icl` 创建，人格段、原文层、
   wake 第 3 轮都实测。旧第二代 `dsh-icl` 已通过 `pluginManager/removeBundle` 移除，
   新包通过 `installBundle` 安装。
4. **focus 第一切片已在 desktop 验证**：session `9a69e92f` 里 `focus_enter` / `focus_status` /
   `focus_leave` 真实调用；提示词出现"你现在在：写测试（勿扰）"，离开后消失。
5. **focus 持久化已在 desktop 验证**：`session-f8f5f631` 的 `focus_enter` 写出 `focus.json`，
   `focus_leave` 清空；headless 预写 `focus.json` 后启动能恢复租约与积压。
6. **记忆链审计**见 §9.5；主要缺陷已修；仍剩 `memory.query` 单次 500 行上限（有意），以及长会话/dream 产物质量未验证。
7. 长会话（≥30 分钟）闭环、dream 读 tool/result 后的产物质量仍未验证。

### 9.5 记忆链审计（2026-11-03 晚）

范围：`memory` / `recall` / `note` / `lexicon` / `whois` / `eager-recall` / `dream` / `compaction` / `dsh-raw`。

**已修并补测试**：

| 修复 | 证据 |
|---|---|
| `recall` 在 cursor 深入时不再搜到 `resolve`（纠正队列） | `recall.test` 新增用例 |
| `memory.query` 支持 `order:'desc'` / `id` 精确查；recall/dream/note/lexicon/whois/compaction 改取最新 | `memory-window.test`（600 行窗口） |
| `remember` 重写不再把 boost 权重打回 1.5；只有 `reweight` 覆盖 | `memory-window.test` |
| `patch`/`remove` 删除 `mem_vec`，改写文本不再留旧向量 | 代码审查（memory） |
| `cleanup` 的 rewrites 一次算完整 `nextData`/`nextText`，body 与 evidence 不再被旧值覆盖 | `dream-jobs.test` 新增用例 |
| `events` 的 day 证据带 `line` 正文快照与 `at`，重洗 log 不再只靠行号 | `dream-jobs.test` 新增用例 |
| `events` 同 summary 重跑：新证据优先，旧 evidence 合并保留 | `dream-jobs.test` 新增用例 |
| `dream-run` 只保留 90 天，账本不再无界增长 | `dream-jobs.test` 新增用例 |
| `dayKey`/`dayRange`/`dayStartOf` 统一走 `config.timezone` | `dream-jobs.test`（HK/UTC 日界） |
| `lexicon.upsert` 按 key 精确找旧词，老词不再丢 origins/tags/decay | `lexicon.test`（500 条外） |
| `lexicon` 的 `conv=web` 与存储的 `conv:null` 对齐 | `lexicon.test` |
| 同一个未知词只留一条待办 | `lexicon.test` |
| `memory.search` 扫描窗口从 500 提到 `config.scanLimit`（默认 5000），老块不再搜不到 | `memory-window.test` |
| `memory.count` + `note_status`：计数不再受 500 行读取窗口限制 | `note.test`（501 条 open） |
| `whois.recentEventsFor` 取最新而不是最老 | `whois.test` 仍通过 |
| `dsh-raw.list` 取最新、解析 `tool/result`、补 `sender` | 代码审查 + 全量测试 |
| `note`/`whois`/`dream` 按 id 找旧行不再受 200/500 窗口限制 | 代码审查 |

**实测**：headless 会话 `remember(key=audit:1)` → `recall(query=梧桐)` 返回
`[今天] 梧桐树下有只猫`；DB 里权重 `1.7`（1.5 + boost 0.2），cursor 只写一次。
另一个 headless 会话先 `remember(kind=resolve)` 再 `recall(kind=resolve)`，返回
"没有想起什么。（也没记过。）"——纠正没有混进回忆。
desktop 会话 `0659851f`（重启后）：31 个 ICL 工具；同 key 重写后权重 `1.7`；600 条事件块里
最老一条仍被 `recall` 找到；501 条 open note 计数准确；500 条外老词的 tags/decay 保留。

**未修**：`memory.query` 单次仍硬顶 500（有意控制单次上下文；`count`/`search` 已不受此限）；
长会话与 dream 真实产物质量仍未验证。

### 9.6 时间/作息/压缩审计（2026-11-04）

**结论：作息没有真正合并干净。** `time` 拥有睡眠 span（`sleep:true`），但每晚触发做梦仍是独立的 `rhythm` 插件：
它有自己的 `setInterval`、`rhythm.json`、世界状态 source，且 `DEFAULT_PLUGINS` 仍启用它；`TIME.md` 却写
“唯一时钟、唯一唤醒者”。这是代码与文档同时存在的残留。

已做（按“dream 是 time 里的一条安排，而不是 time 的硬编码分支”重做）：

| 项 | 结果 |
|---|---|
| 通用日历事件 | `time.startSchedule` 对每条安排都发 `schedule-start`，tags 带安排自己的 tags；`silent` 安排不发模型消息 |
| dream 作为安排 | `dream` 在 `time` 里注册 `dream:nightly`（daily、silent、tags `['dream']`），订阅 `tags:['dream']` 后并行跑流水线；`time` 完全没有 dream 分支 |
| rhythm 退役 | 从 `DEFAULT_PLUGINS` 移除；同时启用 time 时直接停用（`fire` 返回 `legacy-disabled`），不起第二个 timer、不写 `rhythm.json` |
| 睡眠默认时长 | `sleep:true` 但没给 duration 时默认 3 分钟，和提示词一致 |
| 同 id 改期/重加 | `addSchedule`/`editSchedule`/`removeSchedule` 清 `fired`，今天能再响 |
| compaction | `latest` 已按最新摘要取；补了 501 条摘要的测试，未发现新缺陷 |
| 文档 | [TIME.md](TIME.md) 改为“通用日历 + schedule-start”；[PLUGINS.md](PLUGINS.md) rhythm 标“遗留兼容”；[MEMORY.md](MEMORY.md) 触发源改为 `dream:nightly` 安排 |

**实测**：`time.test` 覆盖 silent 安排的 tags 事件、跨重启 `fired`、睡眠 3 分钟、同 id 重加；
`dream-jobs.test` 断言 `time.schedules()` 里有 `dream:nightly`；headless `time_list` 返回 `dream:nightly wake/single 23:00`。
desktop 重启后 session `0daf2f51`（31 个 ICL 工具）也返回同一行；`rhythm.json` 的 mtime 停在旧进程，证明默认不再写它。
**269 个测试 / 49 文件通过。**

**剩余**：`time.json` 多进程无文件锁；daily 安排晚启动最多错过当天；`sleep:true` 的真实睡眠拦截仍待完整闭环验证。

### 9.7 persona / world-state / model-manager 审计（2026-11-04）

**world-state 确实在给别的插件提供展示服务，但之前有两条线没接上：**

1. `note` 在 `DEFAULT_PLUGINS` 里排在 `world-state` 之前，`note.apply` 里 `get('world')` 时服务还不存在 → **“待办”来源从未注册**。time 排在后面，所以只有时间线。
2. world-state 自带一条默认 `clock` 源，time 又注册 `time` 源，两者都叫“时间” → 真实输出出现两行重复时间。

已修：

| 项 | 结果 |
|---|---|
| 启用顺序 | `DEFAULT_PLUGINS` 改为 `memory, world-state, recall, note, ...`，note 的待办来源能注册 |
| 默认 clock | 有 `time` 源时 `clock` 返回空，不再重复；没有 time 时仍兜底 |
| source 排序 | `itemsOf` 按 source `order` 排，同 owner 多 source 时标题/cap 取先注册的那条，不再按 id 乱序 |
| 时间格式 | time/world 的时间戳统一 `YYYY/MM/DD HH:mm`，去掉尾随冒号；阶段显示“醒着/睡着/暂停” |
| 展示 | headless 实测：`待办：还有 1 件事没了结。` + `时间：现在是 …；阶段：醒着；下一个安排：dream:nightly…`，不再重复 |
| persona | `versions()` 最新在前；`maxVersions` 按最新保留；版本键加随机后缀，跨进程同秒不再覆盖 |
| model-manager | `slots.onChange` 监听器随插件 dispose；仍只 bind 第一个 chat provider（已知限制） |

**实测**：headless `memo` → `world_status` 输出两行（待办 + 时间）；`m1b-persona-world.test` 新增“time 在时不重复 clock”和“同 owner 按 source order”用例；persona 新增 maxVersions/rollback 用例。**269 个测试 / 49 文件通过。**

desktop 重启后 session `61a4b16a`（31 个 ICL 工具）实测 `world_status`：

```text
时间：现在是 2026/11/04 00:51；阶段：醒着；下一个安排：dream:nightly（wake/single，2026/11/04 23:00）。
待办：还有 1 件事没了结。
```

**剩余**：world 同 owner 多 source 仍共用一个 cap（取第一源）；model-manager 多个 chat provider 只有第一个能拿到 `ctx.model`。

### 9.8 闭环首轮（2026-11-04）

新闭环 `tools/loop.mjs` + `icl-loop` preset 的首轮结果：

| 场景 | 结果 |
|---|---|
| S0 smoke + world/info | ✅ PASS：2 turns，6/6 断言；system 含 `时间：`/`待办：`，`memo`/`world_status` 都调用 |
| S3 focus | ✅ PASS：`focus_enter` → `loop-probe` 注入 `qq` 信号 → `focus_backlog` 显示 `qq:group:1 +1` → `focus_leave` |
| S1 外部直投 | ❌ FAIL：`loop-probe` 发出的普通信号没有变成新 turn |
| S2 time wake +1m | ❌ FAIL：`time.json` 显示 `fired`，但会话没有收到 wake |

**根因（第一层）**：`icl-loop` preset 错配了 `sessionId: loop`。`dsh-icl` 的 `isOurSession()` 会拿真实 DSH session id 与 `cfg.sessionId` 比较；实际 id 是 `session-...`，于是插件从未 claim/绑定这条会话。工具和提示词仍然可见（它们是 host 级注册），但 `state.agent` 一直为空，投递 `tick` 全部跳过——所以 S0/S3（只测工具/焦点）通过，S1/S2（要投递）静默失败。

**根因（第二层，顺带修）**：`workspace/archiveSession` 只 dispose agent，不发 `session/disposed`；`onAgentDisposed` 原来只清 `state.agent`，不释放单会话 claim。归档后开新会话会被 claim 挡住，或 bridge 留在旧 session。

已修：
- preset 删除 `sessionId: loop`；
- `agent/disposed` 调用 `onSessionDisposed`，释放 claim 并解绑 bridge；
- driver 的 workspace 固定为 `.state/loop/workspace`，不再每轮在 `runs/<ts>/workspace` 下新建；已清理旧 run 留下的 7 个空 workspace。

**第二轮暴露（更隐蔽）**：preset 修好后 S1 表面上 PASS，但事件里出现重复的 `别处来的一条消息
别处来的一条消息`、旧的 `loop-wake-1`、上一次的 `闭环待办`。原因是：
- `loop-probe` 启动时 `offset=0`，把历史 `loop.inbox.jsonl` 全部重放；
- `time` 的 inbox 同样在启动时重放旧 `arrange`；
- 旧信号已经进入 delivery 队列，新会话会收到。

已修：
- `loop-probe` 启动时把 offset 设到文件末尾，不重放历史命令；并在 apply 时做一次 startup reset；
- 新增 `loop-probe` 的 `reset` 命令：清 delivery、focus/backlog、time、测试 memory；
- driver 每轮建会话后先发 reset；
- `bridge.bindSession` 清 delivery（新会话不继承旧队列）；`unbindSession` 也清；
- core 增加 `delivery.clear()`、`ctx.focus.clear()`；
- 已把旧 `time/loop` inbox/outbox 截断，避免下次启动再重放。

**combined short（58010）**：10 turns / 10 断言通过，但事件显示第一轮之前还有一条旧的“外部直投测试”——它是在 reset 之前由 host delivery 队列漏进来的。已用 `bindSession` 清队列修掉，补了 `dsh-bridge.test` 回归。

**combined short（52374，清队列后）**：9 turns / 10 断言全过；第一条 user 是 `只回复 ok`，外部直投/wake/离开摘要各只出现一次，无旧消息。

**模型反应观察**：
- 外部直投被当成“用户发来的测试消息”，这是 DSH 的 user 角色表现；
- 离开 focus 后模型去查 `world_status`/`focus_backlog`，发现 qq 没有内容——积压已在摘要里取走，解释正确；
- 唤醒后模型想 `memo_commit`，但 `memos` 不显示 id，只能猜 `id=1`。已修：`memos` 输出 `#<id>`；
- 复用同一会话跑 S4 时，bridge 内存 raw 仍被 dream wash 读到。已加 `icl.resetRaw`，由 `loop-probe reset` 清内存 raw + 文件。

**S4（sleep+dream）**：70 秒睡眠 + 期间外部信号，wake 后“整理完了”和积压消息都到；断言通过。但 dream 的 day log 仍含旧 01:38 消息——bridge 内存 raw 没被文件截断影响。已加 `icl.resetRaw`（`loop-probe reset` 调用）。

**单会话锁**：app 重启可能恢复上一条 loop 会话并占 claim；driver 新建前写 `control.json`，`dsh-icl` 只在 `presetId=icl-loop` 时挂 release 控制面。

**测试消息是占位符**：`外部直投测试`/`别处来的一条消息` 只验证投递/gate，不是产品文案；闭环稳定后再单独设计消息呈现。

**269 个测试 / 49 文件通过。** 需要重启后重跑 S4/combined；这也是闭环第一次直接暴露“旧项目总是在真实会话里失败”的接缝。

### 9.9 闭环内层改为 host（2026-11-04）

问题不是 bug 太多，而是**内层回路选错**：把 desktop 重启当热重载，每次换模块代际，旧会话/旧 delivery/旧 raw/旧 inbox 混入，导致逐层穷举。

新内层 `tools/loop-host.mjs`：`createHost` + 真实插件 + 虚拟时钟，8/8 通过：

- world/prompt 含时间/待办；
- 外部信号投递；
- focus 期间别处消息进 backlog，离开出摘要；
- time wake；
- sleep 期间积压、醒来释放；
- dream 触发不抛。

`--long` 用虚拟时钟跑 30 分钟，**11/11** 通过：9 条外部消息无重复、focus backlog 记录、睡眠积压醒来释放。

它立刻抓到一个真 bug：`time.normalizeSchedule` 的 `in`/`now` 用 `Date.now()`，不跟随传入时钟，虚拟时钟下 wake 不响。已改为接收 `now`，补 `time.test`。

desktop 只保留最终 combined short；不再每改一行重启。

**最终 desktop combined short（63660）**：9 turns / 10 断言通过；第一条 user 是 `只回复 ok`，外部直投/`闭环唤醒`/离开摘要各只出现一次，无旧消息。**269 个测试 / 49 文件通过。**

**真实输入限制**：当前信号是占位一句话，只能证明投递/gate/prompt 装配，不能证明真实 QQ/B 站消息的形态、来源元数据、重试与频率。真实 connector 接上后，应把它作为新的 `raw` 来源跑同一套 loop，而不是继续用占位文案冒充“100% 正常”。

**MC 低伤害接缝（新增）**：
- `packages/mc-body`：独立 mineflayer 身体，按 `docs/MC-CONTRACT.md` 的 v1 契约实现；任务状态机、幂等、deadline、取消、安全停止、事件 seq、HTTP `/v1`；`mine` 实测成功。
- `packages/plugins/mc-link`：只懂 `mc-body/v1`，工具 `mcb_look/inventory/scan/map/status/task/cancel/resume/events/say`；任务完成/失败/安全停止进 signals；world 有 MC 状态。
- 实测：第一次在 `57.5,114,26.5` 出生即低血并死亡，body 正确 `safety_stop`、任务不执行；重连到 `53.5,111,20.5` 后 `mine dirt ×2` 成功；`goto` 接 pathfinder 后 2 格移动成功。
- **269 个测试 / 49 文件通过**（新增 mc-body 12 项、mc-link 契约测试）。
- **30 分钟 soak**：`routine` 超时（collected 78/200，trips 0，eaten 0）；task_failed 后 ICL 会话自行 follow/explore，body 约 80 次死亡/541 条 safety_stop。已加 `safety_stop` 去重、暂停拒新任务、低血拒 resume、`adapter.emergency`（吃/回安全点/后退）、连续 3 次死亡隔离。
- **10 分钟 soak2（body-only）**：`routine` 超时 39/60，trips 0/eaten 0；任务结束后约 4 分钟 health-drop → emergency → 单次死亡，随后 paused，没有再次自动续跑；body 在线但空闲，已手动停。新增任务结束回安全点。
- **flat5（本地 flat/peaceful server，54837）**：routine 30/30 目标完成，trips 3，eaten 0，safety_stop/death/emergency 均为 0；body 回安全点。`tools/mc-soak.mjs` 自动起停，报告在 `.state/mc-soak/flat5`。
- **flat30-true（实际 10 分钟，harness 漏传 deadlineMs）**：collected **472**、trips **59**；safety_stop/death/emergency 均为 **0**；已修 harness，真实 30 分钟在 `flat30-real` 重跑。
- **任务台账**：body 默认 `.state/mc-body/tasks.json`；重启保留历史，running/queued 变 `interrupted(body-restart)`，不自动续跑。10 个 mc-body 测试。
- **flat30-final（真实 30 分钟 body-only）**：collected **743**、trips **92**；safety_stop/death/emergency 均为 **0**；routine 以 `task_done(reason:duration)` 正常结束，未出现进程崩溃或残留。报告 `.state/mc-soak/flat30-final`。
- **normal 生存长测（54838）**：新 normal 世界，ICL-Survival 5 分钟 20 turns/158 tool events，0 错误；已做出木镐/石镐/石剑/熔炉/火把，拿到 coal/raw_iron，iron_ore 任务运行中；Hahn123_ 在线。抓到一个真实 bug：mine 未先走到方块旁，11 格外硬 dig 会假计数且不掉落；已修成 goto→dig→验证方块变化→pickup。
- **claim audit**：`tools/mc-claim-audit.mjs` 把 assistant 的 MC 声明与同 run 的 tool/body task 事件对齐；有证据标 ✓，无证据标 ?，只做审计不判断语义。
- **real mc-link smoke**：`tools/mc-link-real-smoke.mjs` 用真实 body + 真实 `mc-link`（无 DSH）跑通 `mcb_status/look/inventory/map/scan` 与 `mcb_do`（task/tasks）；`mcb_help trade` 读取技能文档。
- **dig by name 实测**：`goto 22,68,-26` → `dig {name:"oak_log"}` 成功，body 对准方块并得到 `oak_log ×1`；修复 `blockAtTarget` 不认 `name/kind`。\n- **前缀缓存**：`world/focus/mc:status` 等动态段从 order 10/15/20 移到 890–903，稳定内容留在前缀；旧 MC 段在 `icl:core` 之前导致全量破坏。\n- **主 ICL join 实测（旧自动 goal 行为）**：`mcb_servers` → `mcb_join {server:"local-survival"}` → body 连接 127.0.0.1:54838。现已解耦：join 只连接，goal/focus 由模型手动建，leave 只停 body。\n- **工具面收敛**：`mc-link` 已改为 11 个常驻工具（含 join/leave） `mcb_servers/lan/join/leave/status/look/scan/map/inventory/do/help`；`task/cancel/resume/events/tasks/say` 收进 `mcb_do` op；MC 状态不再注册到全局 world-state，改由 `mc:status` + `mc:skills` prompt section 提供。
- **latest2（2 分钟、最新代码）**：routine 12/12 done，trips 1，picked 3；inventory 有 dirt，0 safety/death；验证了 pickup/inspect/returnToSafe。
- **命名冲突**：`dsh-mc-agent` 的 guard 把任何 `mc_*` 工具都当成它的，非 MC 模式直接拒绝；我们的 `mc_body_*` 被误伤。已改名为 `mcb_*`，不改第三方代码。
- **ICL MC short（54832，7 工具）**：7 turns / 3 断言通过；`mcb_status`、`mcb_do` 可用；body `mine dirt ×1` 完成（t-2 done），任务事件以 `source.kind=plugin:mc` notice 进入会话。旧 session 历史里仍有早期 `mcb_do` 失败事件，但本轮工具调用/断言通过。
- 新 preset `icl-mc`：状态目录 `.state/mc-state`，不启用 loop-probe；需要重启后出现。
- **测试环境**：本地部署 Minecraft 1.21.4 flat/peaceful 服务器（`.state/mc-server`，端口 54837，online-mode=false）；body 已连上并通过 `tools/mc-soak.mjs` 做 body-only soak，不再依赖用户 LAN 世界的 mob/地形。

**消息注入通道（重要）**：ICL bridge 的 delivery 从 `agent.followup`（user 来源）改为优先 `agent.steer`，source=`plugin:<producer>`、`form:'notice'`、带 `summary`；时间/MC/focus/外部信号都不再伪装成用户。老宿主无 `steer` 才回退 followup，并统计 `steered`/`followupFallback`；补了 steer 回归。详见 [MESSAGES.md](MESSAGES.md)。
