# 做梦质量快照

> 这不是规格，是**证据**。用来回答"改完之后做梦变好了吗"。
> 相关说明：[../MEMORY.md §7](../MEMORY.md)。

## 怎么产生

```bash
node tools/quality-run.mjs        # 固定素材 + 真模型，写本目录 <时间戳>.md
```

- 素材：`tools/fixtures/quality-day.json`（21 条消息，上午/下午/晚上三段）
- 模型：`deepseek-chat`
- 每次跑一次完整的做梦流水线，输出块数、正文长度、人物块、词汇条数

## 保留的两份

| 文件 | 时间 | 块 | 正文平均 | 人物 | 词汇 | 说明 |
|---|---|---|---|---|---|---|
| `2026-11-03T03-15-39-477Z.md` | 11-03 03:15 | 3 | 65 字 | 1 块 / 1 条笔记 | 6 | 早期基线：wash 先抽笔记、下游只读笔记 |
| `2026-11-03T04-27-38-279Z.md` | 11-03 04:27 | 3 | 122 字 | 2 块 / 8 条笔记 | 2 | 改后：当天原话整段进 log，各 job 自己提取 |

## 已丢弃的五份（可一键重跑，不再保留）

| 时间 | 块 | 正文平均 | 人物 | 词汇 | 备注 |
|---|---|---|---|---|---|
| 03:15:15 | 0 | 0 | 0 | 3 | 失败：模型返回空 |
| 03:15:30 | 2 | 89 字 | 2 / 2 | 4 | 中间态 |
| 03:29:13 | 3 | 127 字 | 2 / 7 | 4 | 接近最终态 |
| 03:29:35 | 3 | 130 字 | 2 / 8 | 2 | 接近最终态 |
| 04:27:20 | 0 | 0 | 2 / 5 | 5 | 失败：块为空但人物有产出 |

## 怎么读

- **块数与正文长度**反映"有没有把一天压缩成几件完整的事"。65 → 122 字是实质提升：早期每块只有一句提纲。
- **人物条数**反映工具结果有没有进原文层。8 条明显好于 1 条，但仍受限于 `dsh-raw` 只解析两类事件
  （见 [../STATUS.md §4](../STATUS.md)）。
- **词汇条数下降不是退步**：早期 6 条里含 `白饭`/`白饭了` 这种重复与单字噪声，现在只有 2 条有释义的。
- 这份数据**只有 21 条固定素材**，不能代表长会话；样本量小，别据此调参。

## E2 记忆质量监控（mc-quality）

> E2 长测用 `tools/mc-quality.mjs` 观测真实会话的"事件→记忆成块"质量；口径与判据见 [../MEMORY-BLOCK-QUALITY.md §4](../MEMORY-BLOCK-QUALITY.md)，产物为 `<runDir>/quality.jsonl` / `quality-report.md`。

- 可回忆块 = `event/person/slang` 的 `kind=block`；`day/log` 是 wash 原料、`dream-run` 是运行记录、`consume` 是备忘回收，三者都**不计入块大小**（旧口径把 138,778 字符的 day 原料误算成 p95 的教训）。
- dream job 按 `run:/fail:/skip:` 三态统计（master 已让失败/跳过落 `dream-run`）；`index` 无嵌入时记 `skipped:no-embed`，不算失败。
- 槽健康：`slots.unmatched` 期望 `[]`（`icl.ready` 日志不可得时由 dream 模型 job 成功行/fail 行推断，`slots.source` 标注来源）。
- 2026-11-06 lab 侧已给 `icl-lab` / `icl-mc-lab` 注入 `providers`（8088 llama-swap chat/embedding）；验证：dream `events` job `ran`、`blocks=1`、`event/block` 与 4 条 `mem_vec` 落库、无 `fail:` 行、eager-recall 注入 2 次。
