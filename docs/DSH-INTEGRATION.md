# 接进 DSH

> 读者：要让 ICL 在真实 DSH 会话里跑起来的人。
> 范围：接线方式、当前哪些成立、哪些断着。核心契约见 [ARCHITECTURE.md](ARCHITECTURE.md)。
> 基线：2026-11-03。

---

## 1. 两条路，不要混用

| 路径 | 怎么走 | 在仓库里吗 | 现状 |
|---|---|---|---|
| **进程内插件** | `icl-live` 作为 DSH 插件，在会话进程里 `createHost()` 并注册工具面、人格段 | ❌ 不在（在 `~/.dsh/plugins/icl-live/`） | 5 分钟会话跑通过；当前**没有**接进 profile |
| **外部 HTTP 客户端** | `packages/adapters/dsh-client.mjs` 调 DSH Web API（`session/prompt` 等） | ✅ 在 | 1 台机器验证过（`tools/dsh-session.mjs`） |

进程内是"她自己在跑"，外部是"脚本在外面推她"。**做梦、时间、压缩必须有进程内在场**，
所以长期形态只能是进程内；外部客户端只用于建会话、投第一条消息、导出。

## 2. 进程内接线由四样东西组成

缺任何一样，会话里都看不到工具面，而且**不会报错**——这是最容易踩的坑。

| # | 位置 | 内容 |
|---|---|---|
| 1 | 插件包 `package.json` | `dsh.bundle.patch` 指向一个 preset yml |
| 2 | 插件包里的 `presets/*.patch.yml` | 声明 preset（id、显示名、`plugins[]`） |
| 3 | `~/.dsh/profiles/desktop/package.json` | `dependencies` 里加 `link:` 指向插件目录 |
| 4 | 同一文件的 `dsh.profile.bundles` | 列出包名，再 `pnpm install` + 重启 DSH |

另外两条硬约束（都踩过）：

- `apply` 必须是**同步**返回 disposer；异步 `apply` 会让 cordis 报 `never started`。异步初始化要放到内部的 `boot()`。
- preset 里的模块名必须写**包名**（`dsh-icl-live/index.mjs`），写目录名解析不到。

## 3. 当前实测状态

| 环节 | 状态 | 证据 |
|---|---|---|
| `tools.register` / `systemPrompt.section` 契约 | ✅ 成立 | `adapter-dsh.test.mjs`（假 DSH）；真实会话里 18 个工具注册成功（干跑记录） |
| 按 preset 建会话、指定工作区、发消息 | ✅ 成立 | `tools/dsh-session.mjs create/prompt` 实测，会话投影里 `agentPreset=icl-live` |
| 会话里插件实例启动 | ✅ 成立 | `time.json` 时间戳在会话启动后更新 |
| 定时器 → 醒来 → 释放积压 | ✅ 成立一次 | 5 分钟测试第二轮：`arrange(in 1m, duration 3m)` → 到点 fired → 醒来 queue 为空 |
| 睡觉触发做梦 | ✅ 触发，❌ 产物不全 | dream 跑了，但 `dsh-raw` 读错位置 → 记忆库只有 1 条词、无块 |
| 人格 / 世界状态每轮刷新 | ⚠️ 部分 | 人格段是 `text` 函数、每 5 秒求值；世界状态仍是加载时快照 |
| `compaction` 在真实会话触发 | ❌ 未验证 | 阈值 12000 字符，5 分钟会话压不到 |
| 单会话锁 | ⚠️ 有代码，未必生效 | `icl-live` 调 `claimSession`，但第一轮测试就是两个会话同跑 |

**关键事实**：本机 DSH profile 当前 `bundles` 里是 **`dsh-icl`（focus-core 的第二代插件，走 3201 本地服务）**，
不是 `icl-live`。也就是说，**当前 DSH 里活跃的是上一代，不是这个仓库**。
`icl-live` 的目录和 preset 都在，只是没挂上去。

## 4. 建会话并指向它

```bash
node tools/dsh-session.mjs list
node tools/dsh-session.mjs create --preset icl-live \
  --workspace C:/DSH/qwenstuff/icl/state/dsh-agent --title "ICL 测试会话"
node tools/dsh-session.mjs prompt --session <id> --text "去刷吧"
node tools/dsh-session.mjs cancel --session <id>
```

三步对应 `workspace.create` → `sessions.create({ workspaceId, agentPreset })` → `sessions.prompt`。

为什么不用 `ctx.sessions`：预设作用域的插件取不到它（`cannot get property "sessions" without inject`），
声明 `inject` 也可能卡在 waiting。HTTP API 是上一代验证过的稳定路径。

**注意 preset 里写死了 `workspace`**（`C:/Users/.../.dsh/icl-live/state`）。这意味着：

- 会话带上来的 `--workspace` 参数与插件实际用的工作区**不是同一个**
- 两个会话会共享同一份 `memory.db` 与 `time.json`，互相踩（第一轮测试作废的直接原因）

## 5. 怎么往会话里发消息

DSH 只有两种模式，其余是队列编辑与会话结构操作：

| 模式 | 行为 | 用在哪 |
|---|---|---|
| `mode:'queue'` | 不打断当前生成，这一轮结束后作为下一轮进入 | 起床、到点提醒、例行通知——**默认用这个** |
| `mode:'steer'` | 插进当前生成，模型下一步就看到 | 真正的紧急情况 |

```js
api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text }] })
api.sessions.updateQueue({ sessionId, itemId, action: { kind: 'edit' | 'remove' } })
```

进程内还有一条上不了 HTTP 的通道：`agent.inbox.push(target, message)`，`target` 是
`next-turn` 或 `next-step`；非用户来源的 placement 是 `context`，**GUI 看不到、模型收得到**。

没有的东西（不要在别处假设它存在）：往系统提示插一条的公开 API、静默通知通道。

**当前投递泵只用了 `queue`**，`batch.urgent → steer` 只在文档里，没有实现。

## 6. 历史从哪来

`dsh-raw` 把 `~/.dsh/sessions` 当原文源，这是做梦的输入。三个坑：

1. **v4 消息在 `data.message.content`**，早期读 `data.content` → 所有消息当空；`sessionId` 要取目录名，
   不是文件名 `session.v4.jsonl`（已修，有 `dsh-raw-v4.test.mjs`）。
2. **只解析 `user/message` 与 `assistant/message`**。`tool/result` 不在里面，所以视频标题、UP 主、评论
   这些"她真正看到的东西"**永远进不了原文层**，做梦也就记不到人。这是 `people 0` 的直接原因。
3. `.jsonl.zstd` 解压依赖 Node 22.15+ 的 `zlib.zstdDecompressSync`；低版本静默返回空串。

## 7. 压缩

`compaction` 通过 `context.onCompact/onAssemble` 挂进装配链，用同一份人格写自己的摘要块，
超过 `triggerChars`（默认 12000）才压。**至今没有在真实会话里触发过**——5 分钟会话到不了阈值。

真正的风险不是"压得好不好"，而是：DSH 自带压缩会改写历史，而做梦读的正是历史原文。
两者同时存在时，做梦读到的东西会变样。现在的对策是"会话控制在 15 分钟内"，属于绕开而不是解决。

## 8. 还断着的地方

| # | 断裂 | 影响 |
|---|---|---|
| 1 | `icl-live` 不在 profile bundles 里 | 现在 DSH 里跑的根本不是这个仓库 |
| 2 | preset 写死 workspace | 多会话共享记忆与时间状态 |
| 3 | 工作区与 `--workspace` 不一致 | 测试产物散落，清理困难 |
| 4 | `tool/result` 不进原文层 | 人物记忆永远缺"从工具里看到的人" |
| 5 | 单会话锁只有一半 | 两个会话同跑时无人阻止 |
| 6 | 没有删除会话的接线 | 每次测试多一个会话，GUI 越堆越多 |
| 7 | 压缩与做梦共用"历史" | 长会话的梦建立在被改写的历史上 |

前三条是"接线"问题，一小时内可修；后四条是设计问题，需要先决定边界再动。
