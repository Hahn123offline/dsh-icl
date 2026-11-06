# 夜间长测缓存报告（night-1）

> 测量人：cache。对象：2026-11-06 夜间本地模型长测 `night-1`（00:22–06:51，6h29m，本地 NInfer `coder390-27b-q3-df2-4x500`）。
> 目的：验证方案 B（静态 system + facts 走 runtime-context）+ 节流 + `<icl-context>` kind 修复在**真实长会话**里的缓存表现。
> 数据源（全部只读，不占 GPU、不碰 lab 进程）：
> - 引擎请求日志 `C:/DSH/moe_streaming/logs/ninfer-coder390-q3-df2-4x500.requests.jsonl`（全局，按时间窗切片）；
> - DSH 会话事件流 `C:/DSH/icl-wt/mc-lab/.state/lab/night-1/events.jsonl`；
> - mc-lab 夜间报告 `morning-report.md`（睡眠/醒来时间权威值）与 `final-summary.json`（全夜 64 turns/1182 calls/281 err）、`checkpoint/lab-gen-*/events.jsonl`（各代事件）、`validity-awake.json`（醒着活跃 81.4%/等待 19.3%）、`sleep-direct-injections.json`（睡眠期 9 次直投）。
> 复算：`node tools/cache-longrun.mjs --start 2026-11-06T00:22:00+08:00 --end 2026-11-06T06:51:30+08:00 --events <night-1/events.jsonl> --out .state/cache/night-1.json`
> 口径：与 `docs/CACHE-MODEL.md` §6.4 一致；全量失效 = `hit=0 && prefill>0`（另列 `prefill>1000` 的"整段冷启动"口径）。

---

## 0. 一句话结论

**6h29m 本地长会话里，缓存命中率 99.50%；稳态请求 TTFT 中位数 0.60s、p95 0.94s；
窗口内 1220 条 tool-bearing 请求（全夜 6 代合计 64 turns / 1182 tool calls）只有 8 次全量失效，且全部是 DSH 会话/代际重启的冷启动（不是前缀被破坏）；
睡眠 4h27m 完全无模型请求。** 上下文从 ~11k 涨到 ~104k tokens，命中率没有随会话变长而下降。

---

## 1. 总表（窗口 00:22–06:51，工具面恒为 41 个工具）

| 指标 | 数值 |
|---|---|
| tool-bearing 引擎请求 | **1220**（请求级：携带 41 个工具定义。全夜 **1182 tool calls** 是 `tool/call` 事件级，两者不可相减——请求可以带工具但某 step 不产生调用）；另有 8 条 tools=0 的标题/辅助请求不计入 |
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
窗口内实际是 **6 个 lab 代**（gen-1…gen-5 + 01:35:55 起的 current 会话 `session-5d3e76be…`；mc-lab `final-summary.json` 口径：全夜 64 turns/1182 calls）；
**01:36:13 最后一次启动后，5h15m 内 0 次全量失效**。

## 4. 结构指标（DSH 事件流；session `5d3e76be`，01:35–06:51）

| 项 | 值 |
|---|---|
| `system/message` | **1 条 append、0 次 replace**，全文 **5004 字符**，整场不变 |
| facts runtime-context 快照 | **48 条 / 37 个 turn = 1.30 条/轮**，avg 559 字符 |
| turn / step（current 会话） | 37（`turn/start`）/ 521 |
| 全夜 turn / tool call（6 代汇总，mc-lab 口径） | **64（`turn/end`）/ 1182（`tool/call`）** |
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
2. **口径差异（与 mc-lab 对过账）**：turns——§4 的 **37** 是 current 会话的 `turn/start`；全夜 **64** 是 6 代 `turn/end` 汇总（gen-1…gen-5 + current），两者都对但定义不同。
   requests——**1220** 是请求级（携带工具定义），**1182** 是 `tool/call` 事件级，不可相减。
   8 次冷启动对应 6 代的启动/重启（00:22–00:53 七次 + 01:36 一次），**不要读成"前缀被破坏 8 次"**。
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

## 8. 长跑健康附加指标（下期报告固定两行）

缓存指标之外，长跑报告固定带两行健康对照，避免"只有缓存好看"：

| 指标 | 读法 | 说明 |
|---|---|---|
| **槽健康 `slots.unmatched`（必需）** | `icl.ready.slots.unmatched`（新格式 `{unmatched:[必需], optionalUnmatched:[可选]}`）；或 `host.services.slots.unmatched()`（返回项带 `optional` 布尔） | **必需槽**未绑定 = 问题（例如 dream-chat 未绑定 → 整晚 0 事件块）。判定仍用 **`slots.unmatched==[]`**；正常应无必需槽缺失 |
| **槽健康 `slots.optionalUnmatched`（可选）** | 同上 | `image-embed`（album 向量，dim=512）已标 `meta.optional=true`：缺 CLIP 时它出现在这里、**不算红**（语义 = "向量检索未配置"）。lab preset 已接 `lab-clip-zh`（embedding 512d，CPU）；注意**绑定只看 shape**：若 8088 的 `clip-zh` 别名没加载，绑定仍绿但 album import 会报"向量未建" → 健康行同时看 `album.vectors` / import 输出，别只看 slots |
| **dream job 三态** | memory 命名空间 `dream-run`（`kind='run'`，`key=runKey(day,job)`，`data` 里含 ok/skipped 原因）；或 mc-lab morning-report 的 dream 节 | 三态 = **success / skipped（already-ran、no-raw、nothing-clean…）/ failed**；某天某 job 缺失也记 skipped 以外的一类，单独标红 |

> **口径（misc `109c894` 正式版）**：
> - 槽健康：`icl.ready` 日志带 `slots.unmatched` 数组；未绑定时另有 `icl.slots-unmatched`（error）。**`slots.unmatched==[]` 才算绑定 OK**；night-1 预期 `["embed-text","dream-chat"]`（lab patch 无 providers）。
> - dream 三态：`dream-run` 里成功 `run:<day>:<job>`、跳过 `skip:<day>:<job>`（`data.skipped`）、失败 `fail:<day>:<job>`（`data.ok=false,error`）；`mc-quality` 按 key 尾段取 job、按 `data.error` 计 `dream.failures`，无需改解析器。另有 `dream.jobs` / `dream.days[job]`（含 `skipped`/`error`）。
> - 判定：`dream.failures==0` 且当日实际进入 run 的 job 都有 `run:`/`skip:` 行 → 健康；有 `fail:` 行或缺行 → 标红。index 覆盖：有 embed 看 `dream.days.index.indexed/missing`，无 embed 应见 `skip:...:index` 且 `data.skipped='no-embed'`。

night-1 已知：dream 槽从未绑定（lab patch 无 providers）→ 整晚 0 事件块，`dream-run` 无 success 记录——这是要报的异常，不是缓存问题。

## 9. layout 审计新基线（2026-11-06）

### 9.1 当前基线（master `6d2c518`，cloud 双 preset 审计）

**A. `icl-lab`（默认基线，无 toolAllowlist）** — run `cache-baseline-20261106`（5 轮，含 `album_list`/`video_probe`/`time_status`）：

| 项 | 值 | 判定 |
|---|---|---|
| system | 1 次 append / **0 replace**、`firstDiff=-1`；**4195 字符 / 8256 字节**；首行 `你是小千。`；无身份/脚手架；`systemHasDynamicFacts=false` | ✅ |
| 工具数 | **54** | 新基线 |
| toolsChars / toolsHash | **39350 字符 / `c1df0e849a9f`** | 新基线 |
| facts 布局 | 1 条快照 / 5 轮（0.2/轮，537 字符）；sections = `[sandbox:policy, approval:policy, icl:facts]` | ✅ |
| `image/offload` / image block | 0 / 0 | ✅ |

**B. `icl-mc-lab`（MC 场景，toolAllowlist 生效）** — run `cache-baseline-mc-20261106`（3 轮，尝试 `mcb_snapshot`/`mcb_status`，未连 MC 服）：

| 项 | 值 | 判定 |
|---|---|---|
| system | 1 次 append / **0 replace**；**2920 字符 / 6969 字节**；`systemHasDynamicFacts=false` | ✅ |
| 工具数 | **27**（`mcb_*` 17 个全在：attack/combat/do/eyes/help/inventory/join/lan/leave/look/map/scan/servers/shelter/snapshot/status/stop；其余按 allowlist 收窄） | ✅ 与预期一致 |
| toolsChars / toolsHash | **21459 字符 / `c91bce1e703b`** | 新基线 |
| facts 布局 | 1 条快照 / 3 轮（0.33/轮，590 字符）；sections 含 `icl:facts` | ✅ |
| `image/offload` / image block | 0 / 0（无 body，`mcb_snapshot` 返回未连接） | ✅ |

### 9.2 指纹演进（历史不回改）

| 时间/阶段 | preset | 工具数 | toolsChars | toolsHash | system 字符 | 说明 |
|---|---|---|---|---|---|---|
| firstscreen 时代 | icl-lab | 34 | 18910 | `7047e6c4f3e8` | 2296 | 首屏净化后、memory/recall 改前 |
| memory/recall D1–D4 | icl-lab | 34 | 19760 | `38dfbee1cd9b` | 2300 | 描述更新；album 未挂载（当时异常） |
| album 挂载 | icl-lab | 41 | 23286 | `6a5eee138aab` | 2296 | `misc 88570f2` |
| **2026-11-06 16:45（当前）** | **icl-lab** | **54** | **39350** | **`c1df0e849a9f`** | **4195** | video +6、DSH 原生工具（fs/pwsh/persona/todo 等）替换 editor、sim seed MC 4 行 |
| **2026-11-06 16:45（当前）** | **icl-mc-lab** | **27** | **21459** | **`c91bce1e703b`** | 2920 | `toolAllowlist`（mcb_* 17 + 白名单 ICL）；P1 上下文瘦身生效 |

> **体积上涨说明（非 cache 回归，但要知会）**：icl-lab 的 system 2296→4195 字符、tools 23286→39350 字符，
> 来自"新挂载的插件"（video 6 工具、DSH 原生 fs/pwsh/persona/todo 工具说明段、sim seed MC 4 行），全部为**静态**内容；
> 缓存语义不变（1 append/0 replace、无动态事实），但**每请求固定前缀变大了**（tools 多 16KB、system 多约 1.9KB），
> 冷启动 prefill 会同比增加（云端无引擎日志，**prefill 具体 token 需本地 run 实测**）。若在意固定成本，建议单独审"ICL 会话工具面预算"。
> `album`/`video` 只加 schema 与工具 description，无 `prompt.section`；`mcb_eyes` 的截图输出只有在真连 body 时才是 image attachment（本轮无 body → 无 image block）。
