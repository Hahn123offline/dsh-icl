# 创建并指向一个 DSH 会话（已验证）

> 2026-11-03 实测通过。结论：**核心可以指哪打哪**——按想要的 preset 建一个新会话，
> 会话里自动跑起对应的插件实例，外部脚本再发第一条消息即可。

## 结论

```
workspace.create({ path })                 建工作目录
sessions.create({ workspaceId, agentPreset })  按预设建会话
sessions.selectModel({ sessionId, ... })    可选：换模型
sessions.prompt({ sessionId, mode, content })  发第一条消息
```

这三步走的就是旧插件 `dsh-qq` 的路径：它用 `NodeApiClient` 访问 DSH 本地 HTTP API，
不是靠插件上下文。

## 实测记录

```bash
node tools/dsh-session.mjs list
node tools/dsh-session.mjs create --preset icl-live \
  --workspace C:/DSH/qwenstuff/icl/state/dsh-agent --title "ICL 测试会话"
# => session-c1f0927f-33eb-462c-8434-50ad3f202ec1
node tools/dsh-session.mjs prompt --session session-c1f0927f-... --text "你好，简单说一句话"
```

结果（读 `~/.dsh/storages/session_projcache/sessions/session-c1f0927f-*.json`）：

```
agentPreset       = "icl-live"
workingDirectory  = "C:\DSH\qwenstuff\icl\state\dsh-agent"
modelSelection    = { provider: "ninfer", model: "coder390-27b-q3-df2-4x500" }
title             = "简单问候"          ← 模型处理过才会生成
time.json 更新时间 = 12:40:14           ← 会话里的 icl-live 插件启动过
```

## 为什么不用 `ctx.sessions`

DSH 的 `@deepseek-ai/dsh-session` 确实提供 `ctx.sessions`（`create / get / list`），
但**预设作用域的插件取不到**：

```
cannot get property "sessions" without inject
```

就算声明 `inject: ['sessions']`，也可能因为服务不在预设作用域里而卡在 waiting。
HTTP API 是旧插件验证过的稳定路径，也不需要把创建逻辑塞进插件。

## 换目标 / 一键启动

```
每个会话独立跑一份 icl-live（preset 里声明的插件）
→ "换掉 DSH 会话" = 用同一个 preset 再建一个，把消息发给新 sessionId
→ 旧会话不管它，进程/插件随会话生命周期存在
```

## 工具

`tools/dsh-session.mjs`：

```
list                                      列会话
create --preset <id> --workspace <dir>    建会话
prompt --session <id> --text <text>       发消息
model --session <id> --provider --model   选模型
```

依赖：`packages/adapters/dsh-client.mjs`（从旧项目 `dsh-qq/src/dsh-client.js` 移植，
MIT 自有代码），以及 `js-yaml`、`@deepseek-ai/dsh-host-apiproxy` 两个包。
本机用 junction 链到 `dsh-qq/node_modules`，**正式版应作为正常依赖安装**。

## 未做

- 删除会话（API 里有，但没接）
- 建会话后自动等待首轮回复（现在只验证了投递）
- 把 preset 的 model 配置真正写进 `selectModel`（现在继承 DSH 当前选择）
