# ICL 技术说明（总览）

> 这份文档面向"从没看过这个仓库的人"，按**实际代码**描述当前版本，不写规划。
> 细节分别见 `docs/audit/` 四份审计：核心、记忆插件、做梦与生活插件、工具与测试。

## 1. 它是什么

ICL 是一个**上下文生命运行时**：一个进程内的插件宿主，负责

- 提供工具面（记忆、召回、备忘、词汇、文件、B站…）
- 把人格、世界状态、记忆组织成每轮提示词
- 在"睡觉"时把当天的原话洗成笔记，再凝成事件块、人物档案、词汇条目

它本身**没有界面**，通过适配器对外接线（目前只实现了 DSH 适配器，且只对假 DSH 测过）。

## 2. 分层

```
packages/core/src
  host.mjs        插件宿主：注册、启用/禁用、ctx 组装、日志
  services.mjs    十个服务：tools / prompt / focus / delivery / slots /
                  model / raw / context / surface / presets
  session.mjs     会话装配：系统提示、工具定义、定时 turn
  adapter-dsh.mjs 把工具面与提示词接到 DSH 会话
  model-client.mjs OpenAI 兼容客户端，支持取 reasoning
  contracts.mjs   清单校验、穿透规则
packages/plugins/*  15 个插件，各自 manifest.json + src/index.mjs
tools/*             回放、基准、诊断、马拉松脚手架、B站子进程桥
prompts/*           人格与测试角色
```

## 3. 一次会话里发生什么

1. `createHost()` 建宿主；`registerPlugin(manifest, module, {config})` 校验清单、挂上模块。
2. `enable(id)` 调插件的 `apply(ctx)`；插件在 ctx 上注册工具、提示词段、服务、槽位等，
   每次注册都返回 disposer，宿主按逆序收集。
3. 每轮：
   - 系统提示 = 核心行 + 工具索引 + `prompt.assemble()`（各段按 order 排序）
   - 每轮上下文 = `prompt.turnText()` + `context.assemble()`
   - 模型通过服务调用，工具结果原样返回（核心不改写；`ICL_TOOL_TIME=1` 可附加时间）
4. 睡觉（做梦）时按固定顺序跑：
   `wash → events → people → lexicon → consume → cleanup → index`

## 4. 关键契约

- **插件 `apply` 返回 disposer**；`disable` 逆序撤销；`enable` 失败回滚整套。
- **工具归属只认 `manifest.tools`**：没写进清单的工具不进工具面（但仍留在注册表）。
- **装配顺序与预算是硬编码**：提示词段 `order` 升序、同序按名字；段间 `'\n\n'`；
  工具描述 900 字符、索引 1200、索引行摘要 160、每轮上下文 800、context 装配 1200。
- **投递是唯一出口**：`push` 排队，`ack` 推进水位，`nack` 退避重试，第 5 次静默丢弃。
- **模型只拿四个字段**：`name`、`description`（拼装后）、`parameters`、`execute`。

## 5. 模型实际看到的文本（示例）

系统提示（世界段，实测）：

```
时间：现在是 2026-11-02 19:55。；下一次做梦：23:00（还有 3 小时 4 分）。
待办：还有 1 件事没了结。
```

`world_status` 默认输出与上面相同；按 `owner` 展开：

```
· 现在是 2026-11-02 19:55。
· 下一次做梦：23:00（还有 3 小时 4 分）。
```

工具描述拼装示例（`tool-constraints.test.mjs` 断言）：

```
Look up a person. Use when: someone mentions them; you need their account ids. Avoid when: when you only want an event.
```

## 6. 已知硬矛盾（代码 vs 文档）

| # | 问题 | 现状 |
|---|---|---|
| 1 | `ICL_TOOL_TIME` 是死代码 | **已修**（`5d8c190`），`execute: stamped` 已接上 |
| 2 | 适配器先 attach、后 enable 插件时新工具不推送 | **已修**（enable 成功后 notify） |
| 3 | `sync()` 每次全量重注册，`added` 不是增量 | **已修**（定义没变就跳过） |
| 4 | `validateManifest` 丢字段，`presets` 声明永远不生效 | **已修**（保留原字段） |
| 5 | 非 `default` 预设未写 `plugins` 会清空工具面 | **已修**（allow/plugins 都为空才表示全部） |
| 6 | `session.systemPrompt()` / `installTools()` 不过预设 | **已修**（改走 surface） |
| 7 | 截断下限会让输出超过 `maxChars` | **已修**（≤ 预算） |
| 8 | 投递第 5 次静默丢弃且无观测出口 | **已修**（droppedCount） |
| 9 | `binding.timeoutMs` 被忽略 | **已修** |
| 10 | provider 注销不解除已绑定插槽 | **已修** |
| 11 | dream 四个提示词用字面 `\n` 拼接（单行） | **已修**（`bc2a709`） |
| 12 | 人物笔记永远不被标 `consolidated`，每晚重复进提示词 | **已修**（`bc2a709`） |
| 13 | `alreadyRan` 只查 200 行，约 29 天后幂等失效 | **已修**（按 key 查） |
| 14 | 人物跨天上下文比较 `qq:42` 与 `42`，永远为空 | **已修**（按 subject 比） |
| 15 | 重跑 events 会把已有块降级（evidence 空、provisional） | **已修**（保留旧块） |
| 16 | world-state 的 `order` 是死配置；clock 行渲染出 `。；` | **已修**（按 order 排序、句号归一） |
| 17 | compaction 取"最旧 20 条里最新的一条" | **已修**（查 500 条再取最新） |
| 18 | 同一会话存在两个 chat provider（配置歧义） | 未修 |
| 19 | icl-live 用不存在的 `host.services.get('rhythm')`，到点自动做梦从不触发 | **已修**（改用 `host.shared.get`） |
| 20 | `recall-bench --refresh-person` 覆写所谓"冻结题库" | **已修**（写到 bench-qq.refreshed.json） |
| 21 | `marathon.mjs` 的 `cfg.plugins` 是死配置 | **已修**（按配置启用、apiKeyEnv） |
| 22 | `replay.mjs` 的 `msgs` 存在 TDZ 隐患 | **已修**（声明提前） |
| 23 | bili 接缝、`editor` 路径逃逸无测试 | **部分已修**（新增 sandbox-and-seams；`.zstd` 分支仍无测试） |

## 7. 不成熟、已停用的部分

- **DSH 接线**：`~/.dsh/plugins/icl-live`（已从 profile 移除，文件保留；其中 rhythm 查询 bug 已修）
- **bili 接缝**：子进程调外部 MCP，路径依赖 `~/.dsh/bili-duty`
- **bili_frames**：调 `dsh-video-storyboard` CLI，默认截前 4 分钟
- **马拉松脚手架**：`tools/marathon.mjs`，自建 agent 循环，不是产品路径

## 8. 测试

`node --test packages/core/test` → **154 通过 / 0 失败**（37 个测试文件）。
覆盖核心服务、记忆类插件、审计回归（`audit-regressions`）与边界接缝（`sandbox-and-seams`）。
**没有覆盖**：真实 DSH 适配、DSH 内压缩、`.zstd` 分支、做梦产出的质量。


---

## 9. 确定性修复记录（2026-11-02 晚，`7643262` 及之后）

以下问题不涉及设计取舍，已按审计结论直接修复，并有回归测试：

| 领域 | 修复 |
|---|---|
| 核心 | enable 成功后 `surface.notify()`；会话工具名/索引/定义都走预设过滤后的 surface；截断不超过预算；投递暴露 `droppedCount()`；`binding.timeoutMs` 生效；provider 注销解除绑定；适配器跳过未变化的定义；预设支持 `allow` 与 `plugins` 两种声明 |
| 做梦 | `alreadyRan` 按 key 精确查；人物跨天上下文按 subject 比较；重跑无出处时保留旧块 |
| 记忆 | `put` 保留原权重、文本变更时删除过期向量；eager-recall 标签用真实命名空间；`note_status` 不再指向不存在的工具 |
| 世界 | 按 source order 排序；`。；` 归一为 `；` |
| 压缩 | 取最新摘要（先查 500 条） |
| 召回 | 原文只在不够细节时补；与已给内容重合 ≥60% 的原文不再重复 |
| 工具 | `recall-bench` 不再覆写冻结题库；`marathon` 按 `cfg.plugins` 启用、`apiKeyEnv`；`replay` 声明提前消除 TDZ |

仍留给设计决定的：

- 预设 `default` 与"未写 plugins"的语义差别（已按 allow/plugins 统一，但 default 特例保留）
- 世界状态同一 owner 的 title/cap 取第一个来源
- 节律的补跑、跨进程队列、时区
- 做梦的块粒度（时间优先）、印象阈值、质量评估
- DSH 内压缩联调
- 评论楼中楼
- 会话创建与界面
