# 时间模块控制协议（维护后门）

> 这是**临时的维护通道**，不是正式对外 API。正式控制面以后可能换。
> 协议本身很薄：CLI 往文件里追加一行 JSON，时间模块在 tick 里读、执行、回写。

## 1. 文件

| 文件 | 作用 | 默认路径 |
|---|---|---|
| `time.json` | 时间模块状态（阶段、日程、队列、目标） | `<state>/time.json` |
| `time.inbox.jsonl` | 命令队列（一行一个 JSON） | 与状态文件同目录 |
| `time.outbox.jsonl` | 命令结果（一行一个 JSON） | 同上 |

路径可用环境变量 `ICL_TIME_STATE` 或插件配置 `stateFile` 改变。

## 2. 命令格式

```json
{"id":"c-1793...","cmd":"arm","args":{"afterMin":10,"message":"该出门了"},"at":1793...}
```

- `id` 必填，用来配对结果
- `cmd` 见下表
- `args` 因命令而异
- `at` 投递时间（可选）

## 3. 结果格式

```json
{"id":"c-1793...","at":1793...,"ok":true,"result":{...}}
{"id":"c-1793...","at":1793...,"ok":false,"error":"未知命令：xxx"}
```

## 4. 命令表

| cmd | args | 作用 |
|---|---|---|
| `status` | — | 阶段、日程、积压、目标 |
| `pause` | — | 暂停：不安排唤醒，消息全部积压 |
| `resume` | — | 恢复并释放暂停期间积压 |
| `sleep` | `{message?, durationMin?}` | 立即进入睡眠（异步执行） |
| `wake` | — | 立即醒来（异步执行） |
| `arm` | `{at \| afterMin, message, durationMin?, role?, allow?}` | 设计时器/日程 |
| `cancel` | `{id}` | 删除日程 |
| `skip` | `{id}` | 跳过一条积压（仅本次） |
| `delay` | `{id, minutes}` | 推迟一条积压 |
| `queue` | — | 列出积压 |
| `goal_add` | `{theme, until\|afterMin, focus?, resumeOnStop?}` | 创建目标 |
| `goal_remove` | `{id}` | 卸载目标（并释放 focus） |
| `goal_list` | — | 列出目标 |

## 5. CLI

```bash
node tools/time.mjs status
node tools/time.mjs arm '{"afterMin":10,"message":"该出门了"}'
node tools/time.mjs sleep '{"message":"去睡吧","durationMin":0}'
node tools/time.mjs goal_add '{"theme":"玩我的世界","afterMin":120}'
node tools/time.mjs status --state C:/path/time.json --wait 5000
node tools/time.mjs pause --no-wait
```

## 6. 执行时机

时间模块在每 15 秒的 tick 里处理一次 inbox；也可以在代码里直接调
`api.processInbox()`（测试与验收脚本就是这么做的）。

## 7. 语义与限制

- 命令**至少一次**：重复投递同一条命令会执行两次（`id` 只用于配对结果，不去重）
- 没有鉴权：凡是能写这个文件的进程都能控制时间模块——它只是本机维护通道
- 不跨机器；不做 HTTP
- 命令执行失败只写 outbox，不重试
- `sleep` / `wake` 是异步的，返回 `started/waking` 表示已发起

## 8. 验收

```bash
node tools/time-accept.mjs
```

覆盖：arm → 到点 wake → 睡觉 → dream 并行 → 期间积压 → 醒来批释放 →
goal resume → 卸载 → inbox 命令回写。当前 9/9 通过。
