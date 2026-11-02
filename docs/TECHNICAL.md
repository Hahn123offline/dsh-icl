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
| 2 | 适配器先 attach、后 enable 插件时新工具不推送 | 未修，需在 `ctx.tools.register` 时触发 `surface.notify` |
| 3 | `sync()` 每次全量重注册，`added` 不是增量 | 未修 |
| 4 | `validateManifest` 丢字段，`presets` 声明永远不生效 | **已修**（保留原字段） |
| 5 | 非 `default` 预设未写 `plugins` 会清空工具面 | 未修，属语义决定 |
| 6 | `session.systemPrompt()` / `installTools()` 不过预设 | 未修 |
| 7 | 截断下限会让输出超过 `maxChars` | 未修 |
| 8 | 投递第 5 次静默丢弃且无观测出口 | 未修 |
| 9 | `binding.timeoutMs` 被忽略 | 未修 |
| 10 | provider 注销不解除已绑定插槽 | 未修 |
| 11 | dream 四个提示词用字面 `\n` 拼接（单行） | **已修**（`bc2a709`） |
| 12 | 人物笔记永远不被标 `consolidated`，每晚重复进提示词 | **已修**（`bc2a709`） |
| 13 | `alreadyRan` 只查 200 行，约 29 天后幂等失效 | 未修 |
| 14 | 人物跨天上下文比较 `qq:42` 与 `42`，永远为空 | 未修 |
| 15 | 重跑 events 会把已有块降级（evidence 空、provisional） | 未修 |
| 16 | world-state 的 `order` 是死配置；同 owner 的标题/cap 取第一个来源 | 未修 |
| 17 | compaction 取"最旧 20 条里最新的一条"，第 21 条后注入过期摘要 | 未修 |
| 18 | 同一会话存在两个 chat provider（配置歧义） | 未修 |
| 19 | icl-live 用不存在的 `host.services.get('rhythm')`，到点自动做梦从不触发 | **已修**（改用 `host.shared.get`） |
| 20 | `recall-bench --refresh-person` 覆写所谓"冻结题库" | 未修 |
| 21 | `marathon.mjs` 的 `cfg.plugins` 是死配置，凭据变量名与 config 不一致 | 未修 |
| 22 | `replay.mjs` 的 `msgs` 存在 TDZ 隐患 | 未修 |
| 23 | bili 接缝、`bili_frames`、`editor` 路径逃逸、`dsh-raw` 的 `.zstd` 分支均无测试 | 未修 |

## 7. 不成熟、已停用的部分

- **DSH 接线**：`~/.dsh/plugins/icl-live`（已从 profile 移除，文件保留；其中 rhythm 查询 bug 已修）
- **bili 接缝**：子进程调外部 MCP，路径依赖 `~/.dsh/bili-duty`
- **bili_frames**：调 `dsh-video-storyboard` CLI，默认截前 4 分钟
- **马拉松脚手架**：`tools/marathon.mjs`，自建 agent 循环，不是产品路径

## 8. 测试

`node --test packages/core/test` → **146 通过 / 0 失败**（35 个测试文件）。
覆盖核心服务与全部记忆类插件；**没有覆盖**：真实 DSH 适配、DSH 内压缩、
bili 接缝、做梦产出的质量。
