# dsh-icl

ICL 的 DSH 接线插件。仓库内**唯一**知道"怎么和 DSH 说话"的地方。

它把 `packages/core` 的 host 接到一个 DSH 会话上：

| ICL | DSH |
|---|---|
| `surface.list()` | `ctx.tools.register({ name, description, parameters, output, execute })` |
| `prompt.assemble()` | `ctx.systemPrompt.section({ text: () => … })` |
| `delivery` 队列 | `agent.followup(message)` |
| `prompt.turnText()` + `context.assemble()` | `agent/pre-step` waterfall |
| 原文来源 | `ctx.on('session/event', (session, event) => …)` |
| 单会话 | `session/created` 同步 throw（DSH 回滚并显示原因） |

不碰 HTTP、不发现端口、不读 token、不扫 `session_projcache`。

## 安装到 desktop profile

desktop profile 由 Electron 独占管理，`dsh plugin --profile desktop add` 会拒绝。
合法路径是 Desktop shell 自己的 Plugin Manager：

- GUI：侧栏 **Plugins** 页安装本地 bundle；
- 或者用 Host 的 `pluginManager/installBundle` Remote（与 GUI 同一个服务）。

安装时 `target` 填本目录：

```
C:/DSH/icl/packages/dsh-icl
```

安装会把包链接进 profile，并应用 bundle patch（preset `icl`）。新建会话选 **ICL**。

> 这会是 `dsh-icl` 这个名字的第三代实现：安装前 profile 里的旧 `dsh-icl`（focus-core
> 第二代，走 3201 服务）需要先被移除；旧包文件仍在 `~/.dsh/plugins/dsh-icl`，不会删。

## 冒烟（不动用户 profile）

```bash
dsh --profile headless --patch C:/DSH/icl/packages/dsh-icl/cordis.patch.yml "用一句话说你好"
```

`cordis.patch.yml` 把插件作为 Host 行插入，状态写到仓库内 `.state/headless`。

## 配置

preset 里的 `config` 全部可选：

| 键 | 默认 | 说明 |
|---|---|---|
| `stateDir` | `$DSH_HOME/icl/state` | 记忆库、`time.json`、原文 JSONL |
| `personaFile` | 仓库 `prompts/live.md` | 人格卡 |
| `dreamPersonaFile` | 仓库 `prompts/dream.md` | 做梦提示词 |
| `providersFile` | 仓库 `config/icl.local.json` | 只读其中的 `providers` |
| `providers` | 读 `providersFile` | 覆盖 provider 列表 |
| `plugins` | `config.mjs` 的 `DEFAULT_PLUGINS` | 启用的 ICL 插件 id |
| `pluginConfig` | `{}` | 按插件 id 覆盖默认配置，例如 `{ eager-recall: { minScore: 0.1 } }` |
| `presetId` | `null` | 只接管 `session.header.agentPreset` 等于它的会话 |
| `sessionId` | `null` | 只接管指定会话（测试用） |
| `tickMs` | 500 | delivery → followup 的轮询 |
| `timeTickMs` | 15000 | 时间模块的 tick |
| `rawFile` | `<stateDir>/session-events.jsonl` | 原文层落盘 |

调试：`ICL_BRIDGE_DEBUG=<file>` 会把 `agent/pre-step` 的决策与注入长度写到该文件（默认关闭）。

## 失败姿态

- 单个 ICL 插件启用失败：记 `icl.plugin-fail`，其余继续。
- boot 失败：`agent/created` 抛错，DSH 显示创建失败，而不是静默半套。
- 第二个会话：`session/created` 同步抛 `ICL 只允许一个会话`，DSH 回滚。
- 没有 agent 时：delivery 不抽干，消息留在队列里。
