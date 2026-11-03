# 现状与缺陷台账

> 读者：要判断"这个能不能信"、或准备修东西的人。
> 口径：本文所有结论基于 2026-11-03 的 HEAD `d9b5f84` 与一次实跑（`node --test packages/core/test` → 193 通过）。
> 证据等级见 [OVERVIEW.md §4](OVERVIEW.md#4-资产盘点)。**旧审计的"未修/已修"状态列是 11-02 快照，不要直接引用。**

---

## 1. 基线

| 项 | 实测值 |
|---|---|
| 测试 | **193 通过 / 0 失败**，43 个文件，约 0.8 秒 |
| 源码 | 40 个 `.mjs` / **8,277 行**（core 9 文件 1468 · plugins 16 目录 3766 · adapters 2 文件 1064 · tools 13 文件 1979） |
| 服务 | 13 个（`tools prompt focus delivery slots model raw context surface presets signals vision clock`） |
| 插件 | 16 个 / **28 个工具**（manifest 与代码完全一致，无多无少） |
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
| C-16 | 装配期所有 `try/catch` 是空体 | 提示词段、上下文策略、raw 单源出错时静默消失，连日志都没有 |
| C-12 | 三条注入路径互不知情：`session.installTools`、`attachDshAdapter`、`surface` | 只有 adapter 那条按预设过滤；另两条会把未声明的工具交出去 |
| C-13 | `session.start()` 的定时器不被 `host.disable` 回收 | 插件停用后仍在跑 |
| — | `model` 服务只把 6 个方法挂上 ctx | `chatDetailed` / `current` / `inflightCount` 在 `ctx.model` 上取不到，想拿 reasoning 得绕路 |
| — | `presets` 机制整体空转 | 唯一预设有且只有 `default`；`use/define` 无调用方；`manifest.presets` 没有读方。改预设不影响任何行为 |

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

现在的瓶颈不是"缺功能"，而是"缺一条走通的线"。所以顺序是：

1. **把 `icl-live` 搬进仓库**，让 profile 接线成为仓库内可复现的两步命令。这一步做完，
   所有接线问题才会进入测试范围。
2. **修 preset 写死工作区**，让会话工作区与插件工作区一致，否则测一次脏一次。
3. **让 `tool/result` 进原文层**（`dsh-raw` 解析第三类事件）。这是 `people 0` 的正解，
   也是"她记住看过什么"的前提。
4. **跑一次 ≥30 分钟闭环**：醒来 → 做事 → 睡觉 → 做梦 → 醒来，全程一个会话，
   结束固定导出 `memory_export` + `raw_export`。判据见 [DSH-INTEGRATION.md §3](DSH-INTEGRATION.md#3-当前实测状态)。
5. **补测试给两块零覆盖**：`dsh-client.mjs` 至少要有契约测试（它一旦漂移，接 DSH 就全断）；
   `vision.mjs` 一次性补完。
6. **然后才谈**：压缩联调、`focus`/`presets` 的去留（要么接进真实路径，要么删）、
   B 站工具深度、QQ/MC 连接器。

## 8. 已修复的历史缺陷（不要重复报告）

11-02 晚的 `7643262`、`bc2a709` 等提交修掉了一批审计结论（当时记了 23 条对照表）。
以下主题**已有回归测试**，不要当作新发现：`ICL_TOOL_TIME` 死代码、enable 后不推送新工具、
`sync()` 非增量、`validateManifest` 丢字段、非 `default` 预设清空工具面、
`systemPrompt/installTools` 不按预设过滤、截断超预算、投递丢弃无计数、`binding.timeoutMs` 被忽略、
provider 注销不解除绑定、dream 提示词字面 `\n`、人物笔记永不 `consolidated`、
`alreadyRan` 只看 200 行、跨天上下文 `qq:42` vs `42`、重跑降级 evidence、
world-state 的 `order` 与 `。；`、compaction 取最旧 20 条里的最新、`marathon.cfg.plugins` 死配置。

**仍然开着的**：同一会话两个 chat provider（`model-manager` 只 bind 第一个，即 D-20）。
