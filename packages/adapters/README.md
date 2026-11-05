# 旧适配器（不在产品路径）

这两个文件是 2026-11-02 的 DSH Web API 客户端与投递泵：

- `dsh-client.mjs`：调 DSH Web API（`sessions.create/prompt`、mux 流），需要端口发现与 launch token。
- `delivery-pump.mjs`：轮询 `delivery` 队列，通过上面的 HTTP 客户端把消息推进会话。

**现行接线是 `packages/dsh-icl`**：进程内 `ctx.tools` / `ctx.systemPrompt` / `session/event` /
`agent.followup`，不需要 HTTP、端口或 token。本目录保留只因为：

1. `tools/dsh-session.mjs` 仍用它从外部建会话；
2. `delivery-pump.test.mjs` 覆盖那段队列语义。

不要在 `packages/plugins` 或新接线里 import 它们。删除计划见 `docs/STATUS.md §7`。
