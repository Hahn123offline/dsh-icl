# renderTail：工具返回附一行状态（C）设计 · 2026-11-07

> 状态：**设计稿，未接线**。用户尚未批准；本文件只写改动点、开关、回滚与验收，不改代码/preset。
> 旧项目依据：`domain/attention.js:274-289`（renderTail 一行状态）；参见 `docs/MODERNIZATION-CANDIDATES.md` §1 C。
> 目标：用 20–40 token 的**工具结果尾巴**替代反复 `time_status`/`mcb_status`；append-only，对缓存安全。

## 0. 一句话

在 bridge 的工具结果包装处，给**动作类工具**的成功返回追加一行 `〔状态｜…〕`：时间/焦点/目标/积压/MC 在线与血食/未读；同一轮同样状态不重复追加，每轮有上限。lab-only flag 默认关；不改 system/facts/tools schema。

## 1. 证据

E2（`e2-20261106-smoke`，120min，764 次工具调用）：
- `mcb_status` **125 次（16.4%）**、`mcb_look` 69、`mcb_inventory` 33、`mcb_map` 30、`mcb_scan` 22、`time_status` 6；
- 状态类调用合计 ≥**200 次**（26%+）；`mcb_status|{}` 同参数重复 125 次（空参数轮询）；
- 这些调用不产生世界动作，只换"我现在在哪/多少血/下一安排"，是典型可被 tail 替代的成本。
- 注意：C 不试图替代 `mcb_look`（视野内容）/`mcb_inventory`（完整背包）这类**payload**，只替代"一行状态"。

## 2. 现状：工具结果从哪过

```
ICL tool def (host.surface)
  → bridge.syncTools() 
  → toDshToolDefinition(def, { saveImage, imageOutput })
  → contract execute(args, exec) { out = definition.execute(...); normalizeToolResult(out) }
  → DSH tool/result（进入历史，append-only）
```

**唯一插入点建议**：`bridge.syncTools()` 里给 `toDshToolDefinition` 传一个 `execute` 包装（contract 已支持 `execute` 覆盖），在 `normalizeToolResult` **之前**给 `out.text` 追加尾巴；这样：
- 不改插件 execute（所有 ICL 工具统一生效）；
- 不碰 DSH 原生工具（read/write/pwsh 等不在 ICL surface，不在本设计范围）；
- 图片结果仍保留 `images`/`imagePath`（只改 text）；
- 工具抛错时不追加（错误本身已有可操作信息，避免尾巴干扰）。

## 3. 状态行内容与来源

格式（目标 30–45 字符 / ~20–30 token，最多 60 字符）：

```
〔状态｜<HH:MM 时段> · 焦点<name|无> · 目标<id|无> · 积压<N> · MC<离线|在线 13/20 饱15>〕
```

| 字段 | 来源（只读现有 API，缺失就省略该字段） | 说明 |
|---|---|---|
| 时间 | `host.shared.get('time')?.status()` / `heartbeat()` 的 phase+now | 只到"HH:MM 时段"，不写日期 |
| 焦点 | `host.services.focus.current()` + `list().length` | 有焦点给名字/剩余；无则"无" |
| 目标 | time api `goals()` | 多个只取第一个 + `+N` |
| 积压 | time api `queue()` 长度；有 alarm 给 `⚠N` | 不展开内容 |
| MC | `host.shared.get('mc-link')?.status()`（在线/血量/饱食/任务） | 未启用/离线省略；不伪造 |
| 未读 | `host.shared.get('qq')` 若提供 unread 计数 | 没有就省略 |

**不放进 tail**：完整背包（用 mcb_inventory）、视野方块（mcb_look）、任务队列明细、任何动态文本/时间戳秒级值（会每调用都变，导致重复膨胀）。

## 4. 追加规则（避免重复/膨胀）

1. **工具选择**：默认 denylist = 状态/枚举类工具（`time_status/time_list/time_wait?/mcb_status/mcb_inventory/mcb_map?/mcb_scan/album_list/album_status/world_status/focus_status/recall/memos/qq_unread/qq_history/...`）；其余动作类（`mcb_do/mcb_look/mcb_join/mcb_leave/mcb_attack/mcb_combat/time_arrange/remember/...`）默认追加。可切 allowlist 配置。
2. **每轮去重**：state 记 `lastTailTurn/lastTailText`；同一 turn 内若 tail 文本与上次**完全相同**则跳过（例如连续 3 次 mcb_do 中间状态没变）。
3. **每轮上限**：默认 `maxPerTurn=6` 条、`maxCharsPerTurn=360`；超过后本轮不再追加（防止 step-heavy 回合每步一条）。
4. **总长度守卫**：若原 result 文本已 > `maxResultChars`（默认 2,000）或本身已含 `〔状态｜`，不追加。
5. **错误/中止**：`out.ok===false` 或抛错不追加（错误文本优先）。
6. **去重语义**：tail 相同但**动作不同**（如两次 mcb_do 结果不同）仍只追加一次；若状态变化（血量/位置/积压变了）则允许追加。
7. **异步/无状态服务**：任何字段读取失败都 omit，不让 tail 抛错影响工具结果（整个 tail 在 try/catch 里）。

## 5. 缓存/上下文安全

- tail 追加在 **tool result 内部**（历史尾部 append-only），不改 system 前缀、不改工具 schema、不改 facts 快照；DSH KV 前缀缓存安全。
- 代价公式：`净 token = Σ tail 字符/4 − 省掉的 status 调用结果字符`。E2 若 200 次状态调用 × ~250 字符 ≈ 50k 字符，tail 若 435 次×45≈20k，净省 ~30k；若只追加 6 次/轮（53 轮×6≈318 条）≈14k，净省 ~36k。实际以 lab 测量为准。
- 不写 system/facts；不影响 cache 的 toolsHash/system 基线。
- 若 tail 字段取自 facts 装配会重复计算，改用**服务直读**（time/mc-link/focus API），不触发 prompt.assemble。

## 6. 开关（lab-only，默认关）

```yaml
# lab preset 的 icl-core.config（bridge config）
renderTail:
  enabled: false            # 开才追加
  maxPerTurn: 6
  maxCharsPerTurn: 360
  maxResultChars: 2000
  tools: []                 # 空=按 denylist；填则=仅这些工具
  deny: ['time_status','time_list','mcb_status','mcb_inventory','mcb_map','mcb_scan','album_list','album_status','world_status','focus_status','qq_unread','qq_history','memos']
  includeErrors: false
```

- 产品 preset 不写；默认 `enabled:false` → 行为完全不变。
- 回滚：删 lab preset 这段或 `enabled:false`；无代码回滚。
- 不新增工具、不改 manifest/tool 描述；不需要 cache 重记 toolsHash（只有历史 tool result 变长）。

## 7. 观测与验收

**指标（现有 events.jsonl 可算）**
- 状态类调用：`mcb_status+time_status+mcb_inventory+look?` 每 100 次工具调用的次数（E2 基线：125/764=16.4% mcb_status；状态类 ≥26%）。
- 工具结果字符：sum/条、每轮；tail 追加率。
- 任务进度：turn 数/step 数、重复动作保护触发次数、错误数。
- turn-gap：p50/p95/max（`latency.json`）。
- 当事人原话：她是否还频繁说"看看状态/查一下"（transcript 引用 seq）。

**A/B（一次 lab run，同场景）**
1. baseline `enabled=false`；2. `enabled=true`（maxPerTurn=6）。
3. 通过标准：
   - 状态类调用 /100 工具调用 **↓ ≥50%**；
   - 工具结果总字符 **↑ ≤10%**（tail 不能把上下文吃回去）；
   - 每轮 step/turn 不升、turn-gap p95 不升；
   - 无"tail 过期导致盲目动作"的事故（对照 transcript/事件）。
4. 若只降 status 调用但 step 反升 → 判失败（等于她改用别的方式确认）。

**回滚**：配置关；不影响已有历史（旧 tool result 无 tail，只是没有该行）。

## 8. 风险/待决

1. **tail 的时效**：time/mc 服务直读是实时的；若读不到就省略，不猜测。
2. **每轮上限与信息完整性**：动作链很长的 turn 可能后段无 tail；靠"状态变化才追加"补，不保证每步都有。
3. **工具结果语义**：某些工具的结果被她当作精确输出解析（如 mcb_do 结构化文本）；tail 用 `\n〔状态｜…〕` 明确分隔，避免破坏前缀解析；必要时只对 `mcb_*` 和 `time_arrange` 开。
4. **和 B 的交互**：B 压 wake prompt、C 加 tool tail，两者独立开关；A/B 必须分开跑，避免把收益混在一起。
5. 用户未批准：不接线；等批准后按 §6 只在 lab 开。

## 9. 不做

- 不改静态 system/facts、不新增工具/schema。
- 不替代 mcb_look/inventory 这类 payload 工具；只替代"一行状态"的重复查询。
- 不在产品 preset 默认开启；不改 cache 基线。
