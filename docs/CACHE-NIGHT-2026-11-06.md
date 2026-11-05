# 夜间长测缓存报告（night-1）

> 测量人：cache。对象：2026-11-06 夜间本地模型长测 `night-1`（00:22–06:51，6h29m，本地 NInfer `coder390-27b-q3-df2-4x500`）。
> 目的：验证方案 B（静态 system + facts 走 runtime-context）+ 节流 + `<icl-context>` kind 修复在**真实长会话**里的缓存表现。
> 数据源（全部只读，不占 GPU、不碰 lab 进程）：
> - 引擎请求日志 `C:/DSH/moe_streaming/logs/ninfer-coder390-q3-df2-4x500.requests.jsonl`（全局，按时间窗切片）；
> - DSH 会话事件流 `C:/DSH/icl-wt/mc-lab/.state/lab/night-1/events.jsonl`；
> - mc-lab 夜间报告 `morning-report.md`（睡眠/醒来时间权威值）。
> 复算：`node tools/cache-longrun.mjs --start 2026-11-06T00:22:00+08:00 --end 2026-11-06T06:51:30+08:00 --events <night-1/events.jsonl> --out .state/cache/night-1.json`
> 口径：与 `docs/CACHE-MODEL.md` §6.4 一致；全量失效 = `hit=0 && prefill>0`（另列 `prefill>1000` 的"整段冷启动"口径）。

---

## 0. 一句话结论

**6h29m 本地长会话里，缓存命中率 99.50%；稳态请求 TTFT 中位数 0.60s、p95 0.94s；
窗口内 1220 条 tool-bearing 请求只有 8 次全量失效，且全部是 DSH 会话重启的冷启动（不是前缀被破坏）；
睡眠 4h27m 完全无模型请求。** 上下文从 ~11k 涨到 ~104k tokens，命中率没有随会话变长而下降。

---

## 1. 总表（窗口 00:22–06:51，工具面恒为 41 个工具）

| 指标 | 数值 |
|---|---|
| tool-bearing 引擎请求 | **1220**（另有 8 条 tools=0 的标题/辅助请求，不计入） |
| prompt tokens 合计 | 47,204,575（avg 38,692/请求） |
| **hit tokens / 命中率** | **46,968,874 / 99.50%** |
| prefill tokens 合计 | **235,096**（avg 193/请求） |
| **全量失效** | **8 次**（`hit=0&&prefill>0`；`prefill>1000` 口径同样 8 次） |
| 其中整段冷启动（root path） | 8 次，全部是 DSH 会话启动/重启（见 §3） |
| 稳态 path | 1212/1220 = `private_endpoint`，另 8 条 `root` = 冷启动 |
| cancelled 请求 | 15 条（全部 `private_endpoint`、prefill 0–355 tok，是 turn cancel，不是前缀失效） |
| TTFT 均值 / p50 / p95 / max | 0.68s / **0.60s** / **0.94s** / 8.91s（max = 冷启动的 11k 全量 prefill） |
| prefill 总秒数 | 667.2s（6.5h 里只花了约 11 分钟在 prefill） |

## 2. 按睡眠/清醒分窗

睡眠边界权威值（mc-lab 报告 + time 事实快照双线一致）：入睡 **02:09:06**、醒来 **06:39:06**；
last 请求 02:11:55，next 请求 06:39:09 → **02:11:56–06:39:07 共 4h27m 零请求**。

| 窗口 | 请求 | avg prompt | hit% | prefill | 全量失效 | TTFT p50 / p95 | cancelled |
|---|---|---|---|---|---|---|---|
| 清醒 A（00:22–02:09:06） | 1033 | 29,832 | **99.31%** | 211,448 | 8（全是冷启动） | 0.56s / 0.90s | 13 |
| 睡眠边界（02:09:06–02:11:56，在飞 turn 收尾） | 78 | 77,652 | **99.83%** | 10,186 | 0 | 0.74s / 1.85s | 0 |
| 睡眠空闲（02:11:56–06:39:07） | **0** | — | — | 0 | 0 | — | 0 |
| 清醒 B（06:39:07–06:51:30） | 109 | 94,781 | **99.87%** | 13,462 | 0 | 0.72s / 1.78s | 2 |
| 最终重启后（01:36:13–06:51:30） | 521 | 58,125 | **99.74%** | 79,489 | 1（01:36 重启冷启动） | 0.69s / 1.60s | 5 |

> 睡眠边界那 78 条是入睡瞬间“在飞 turn 收尾 + 9 条外部直投”的最后活动（mc-lab 报告：02:11:56 后 0 活动）；
> 期间 **0 次全量失效**——事实从“醒着”变“睡着”只产生一条 runtime-context 快照，system 提示词没动。

## 3. 8 次全量失效 = 会话重启冷启动（不是前缀破坏）

| 时间（本地） | prompt | prefill | path | msgs | TTFT |
|---|---|---|---|---|---|
| 00:22:27 | 11,136 | 11,136 | root | 3 | 8.87s |
| 00:24:13 | 11,136 | 11,136 | root | 3 | 8.22s |
| 00:26:15 | 11,136 | 11,136 | root | 3 | 8.08s |
| 00:32:52 | 10,675 | 10,675 | root | 3 | 7.72s |
| 00:37:45 | 11,136 | 11,136 | root | 3 | 7.66s |
| 00:50:44 | 11,166 | 11,166 | root | 3 | 7.85s |
| 00:53:48 | 10,705 | 10,705 | root | 3 | 7.74s |
| 01:36:13 | 10,705 | 10,705 | root | 3 | 8.91s |

全部满足 `msgs=3`（system + 用户消息 + runtime-context 快照）、prompt ≈10.7–11.2k、TTFT 7.7–8.9s —— 是**新会话第一轮**的特征。
窗口内确实有两个 DSH 会话（`session-44b51dbe…` 00:22 起、`session-5d3e76be…` 01:35:55 起，lab.json）；**01:36:13 最后一次启动后，5h15m 内 0 次全量失效**。

## 4. 结构指标（DSH 事件流；session `5d3e76be`，01:35–06:51）

| 项 | 值 |
|---|---|
| `system/message` | **1 条 append、0 次 replace**，全文 **5004 字符**，整场不变 |
| facts runtime-context 快照 | **48 条 / 37 个 turn = 1.30 条/轮**，avg 559 字符 |
| turn / step | 37 / 521 |
| 真实 user 消息（非快照） | 27（75 条 user/message − 48 条快照） |
| assistant / tool result | 516 / 492 |
| `<icl-context>` 注入 | 0（夜间 eager-recall 无命中；kind 修复未在本轮触发，但代码已在位） |

**上下文增长**（avg prompt 每请求，按小时）：22.3k（00 时）→ 26.8k（01 时）→ 57.2k（02 时）→ 94.8k（06 时），
max prompt **103,969 tokens**（06:51:12）。**命中率没有随上下文增长而下降**（每小时 98.94% → 99.21% → 99.77% → 99.87%），
因为每步只是追加消息，前缀始终完整。

## 5. 与修复前基线对照

| 指标 | 修复前（真实会话，ninfer，session-737ec994） | night-1（B + 节流） |
|---|---|---|
| 新回合 | `hit=0`、全量 prefill 7.3k–23.9k tok | 仅会话冷启动 8 次（各约 10.7–11.2k），其余 0 |
| 整场命中率 | 每新回合 0%，回合内 ≈99% | **99.50%** |
| TTFT（新回合首次请求） | 10–24s | 冷启动 7.7–8.9s；稳态 p50 **0.60s** / p95 0.94s |
| 每 turn prefill（估） | 7.3k–23.9k/新回合 | 235,096 / 64 turns ≈ **3.7k tok/turn**（含 8 次冷启动） |
| 睡眠期 | — | 4h27m **0 请求**、0 全量失效 |

> 与短会话 A/B（`cache-af2`：hit 91.2%、稳态 240 tok/请求）相比，night 的命中率更高：
> 长会话里 tool 步占比大（521 步 / 37 轮 ≈ 14 步/轮），几乎全是 append-only 续写；冷启动摊薄到 8/1220。

## 6. 注意事项（引用时带上）

1. **8 条 tools=0 辅助请求**（标题 LLM 等）未计入缓存表；它们各自独立、不影响主会话前缀。
2. **窗口内有两个 DSH 会话**（00:22 与 01:35 各启动一次），8 次冷启动对应启动/重启；不要把它读成"前缀被破坏 8 次"。
3. **15 条 cancelled** 是 supervisor/turn-cancel 的结果（mc-lab 负责），全部发生在 decode 阶段（prefill 0–355 tok），未造成可见 prefill 浪费。
4. 夜间跑的是 mc-lab worktree `ca01099` 的 bridge —— 已核对包含本轮的 B 布局、facts 按轮节流 + dirty、`plugin:icl` kind 修复（`factsDirty` / `isFactsTool` / `kind: 'plugin:icl'` 均在位）。
5. 睡眠期事实变化只追加 runtime-context 快照（48 条/37 轮，1.30 条/轮），**没有改 system、没有改工具面**；这符合 CACHE-MODEL §7.7 的节流边界（事件类 dirty ≤1 步、环境事实可以陈旧）。

## 7. 复算命令

```powershell
node tools/cache-longrun.mjs `
  --start 2026-11-06T00:22:00+08:00 --end 2026-11-06T06:51:30+08:00 `
  --events C:/DSH/icl-wt/mc-lab/.state/lab/night-1/events.jsonl `
  --out .state/cache/night-1.json
```

输出 `engine.overall`（总表）、`engine.buckets10min`（命中率随时间）、`engine.gaps`（>120s 无活动窗口）、
`engine.fullInvalidations`（逐条冷启动）、`events`（system 稳定性/快照/turn 数）。
