# ICL

一个**会话里的"内里"运行时**：让一个 DSH 会话拥有连续记忆、作息与人格，而不是每轮从零开始。

不是 agent 框架（那是 DSH），不是聊天机器人（那是 `dsh-qq`）。ICL 只做一件事：
**把一段对话变成一个有记忆、会睡觉、会长大的存在。**

## 现状

- 阶段：**能跑，但只跑过 5 分钟**。核心与插件有 193 个测试覆盖；端到端只在真实 DSH 会话里跑过两轮 5 分钟（2026-11-03）。
- 无 GUI、未部署、无远程服务。所有连接器（QQ / MC / B 站）都在仓库外或只有临时接缝。
- 事实基线：2026-11-03，`docs/STATUS.md` 里的测试数与缺陷台账是唯一权威。

## 跑

```bash
npm test        # node --test packages/core/test → 193 通过 / 43 文件
```

无构建步骤、无运行时依赖（核心零依赖；适配器需要 `js-yaml` 与 `@deepseek-ai/dsh-host-apiproxy`）。

## 三条不变量（写进测试，不要改）

1. 插件卸载后，模型在下一轮看不到它的工具。
2. 同一条消息（`plugin|activity|seq`）只会被投递一次。
3. 投递失败不丢，留在队列里重试。

## 目录

```
packages/core        插件宿主 + 13 个服务 + 会话适配器（零依赖）
packages/plugins     16 个插件，各自 manifest.json + src/index.mjs
packages/adapters    DSH Web API 客户端与投递泵（当前不在装配链上）
tools                评测、回放、诊断、运维脚本（13 个，均非产品路径）
prompts              小千的行为提示词、做梦提示词
config               provider 与测试用配置
docs                 见下表
.dsh/skills          从 DSH 官方仓库取来的开发 skill
```

## 文档

| 文件 | 回答什么问题 |
|---|---|
| [docs/OVERVIEW.md](docs/OVERVIEW.md) | 这到底是什么、做到哪一步、卡在哪。**先读这份。** |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 分几层、服务承诺什么、数据存在哪、什么会静默失败 |
| [docs/MEMORY.md](docs/MEMORY.md) | 记忆怎么写入与检索、做梦七步做什么 |
| [docs/TIME.md](docs/TIME.md) | 时间模块的状态机、日程语法、控制后门 |
| [docs/PLUGINS.md](docs/PLUGINS.md) | 16 个插件的工具、配置、依赖、成熟度 |
| [docs/DSH-INTEGRATION.md](docs/DSH-INTEGRATION.md) | 怎么接进 DSH、哪些接线成立、哪些还断着 |
| [docs/STATUS.md](docs/STATUS.md) | 测试基线、缺陷台账、瓶颈、下一步 |
| [docs/HISTORY.md](docs/HISTORY.md) | 三代项目的血脉与教训（dsh-qq → focus-core → icl） |
| [docs/DEVELOPING.md](docs/DEVELOPING.md) | 加插件、跑测试、写文档的约定 |

## 官方 DSH skills

`.dsh/skills/` 下存放从 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 取得的开发 skill，
用于约束后续 agent 的工作方式。来源、提交与更新方式见 [.dsh/skills/README.md](.dsh/skills/README.md)。
