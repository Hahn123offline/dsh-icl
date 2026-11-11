# 记忆审计与回放准备（2026-11-11）

## 范围

- 只读 live `memory.db` 与 `session-events.jsonl` / `eager-recall.jsonl`；
- 不修改 live 记忆、不触发 dream、不写 live 库；
- 产物在 `.state/lab/memory-audit/latest/` 与 `.state/lab/memory-fixture/latest/`。

## 当前数据快照

```text
总条目 182
event block 29
person block 4
lexicon 37
note 22
day log 6
dream-run 53
```

## 已确认的问题

### 1. event block 存在近重复

审计启发式至少发现 **5 对**同一天近重复：

- #82 ↔ #135（证据重合 0.83）
- #84 ↔ #139（文本/证据 1）
- #85 ↔ #140（文本 0.66 / 证据 1）
- #89 ↔ #142（证据 0.5）
- #92 ↔ #145（文本 0.53 / 证据 1）

同时 dream-run 里有 **12 组 run + skip**，是重复触发/重放留下的痕迹。  
近重复块还会占用记忆预算，并让“同一件事被记成两次”。

### 2. lexicon 噪声高

37 条 lexicon 中，审计标出 **18 条工具/框架味**：

`mcb_*`、`time_status`、`body_error`、`ICL`、`水位`、`睡段`、`睡眠边界`、`finish-then-handle`、`clip-zh 512d`、`积压`、`入库`、`去重命中` 等。

其中 `飞机拉线`、`跑鸡 gif`、`白米饭`、`随手记` 等一次性/视觉描述也被当成词条，并自动生成“查一下……”的 note。  
当前 22 条 note 中，**18 条是自动查词 note**，不是真正的待办。

### 3. person 身份没有归并

4 个 person block：

- `person:2593621742` 鱼鱼自己；
- `person:name:Hahn123（离线版）` 完整的鱼鱼；
- `person:name:主人` 只有“会戳我”；
- `person:name:曾嘉睿` 群里发图的人。

`主人` 和 `Hahn123` 实际很可能是同一个人，但被拆成两个块。  
这是 alias/显示名问题，不是模型“记性差”。

### 4. 读路径几乎没有真实使用

- live session 只有 **1 次 `recall`**；
- 有 recall 记录的记忆只有 **3 条**，最高 `recall_count` 为 **1**；
- `eager-recall` 有 25 次记录，命中 73、注入 44，但它是被动注入，不 boost；
- 因此 boost、清晰度回升、真正遗忘曲线，**没有长期使用证据**。

### 5. dream 使用云端

当前 `config/icl.local.json` 第一个 chat provider 是云端 `deepseek-chat`，本地 `llama-swap-chat` 排第二；`dream-chat` 通过 `autoBind` 取第一个，所以 **dream 当前走云端**。  
主会话是 `deepseek-flash`，两者不是同一个模型。

## 已完成的工具

### 只读审计

```text
node tools/memory-audit.mjs --out .state/lab/memory-audit/latest
```

输出：

- `audit.md`：人读摘要；
- `audit.json`：完整机器可读结果。

### Fixture 导出

```text
node tools/memory-fixture-export.mjs --out .state/lab/memory-fixture/latest
```

产物：

- `days/<date>.txt`：dream wash 后的当天原话；
- `raw/<date>.jsonl`：bridge 原文层分日副本；
- `current.json`：当前 event/person/note/lexicon 快照；
- `gold.template.json`：人工 gold 标注模板；
- `manifest.json`：来源、计数、文件说明。

## 云端 replay 第一轮

已用云端 `deepseek-chat` 在临时库跑了 4 天；没有写 live。

| fixture | raw 行 | user | assistant | tool | user 字 | event | lexicon | note |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 2026-11-07 | 130 | 5 | 68 | 57 | 279 | 2 | 30 | 30 |
| 2026-11-09 | 87 | 4 | 48 | 35 | 786 | 12 | 18 | 16 |
| 2026-11-10 | 80 | 3 | 41 | 36 | 1088 | 8 | 12 | 12 |
| 2026-11-11 | 15 | 2 | 7 | 6 | 220 | 1 | 0 | 0 |

结论：

- **80 行不等于 80 条消息**；11-10 的 80 行里只有 3 条 user 消息，41 条 assistant、36 条 tool；
- lexicon/note 的噪声主要来自 **assistant 计划、工具结果、系统状态**，不是来自人类事件密度；
- 11-07 的 130 行里有 68 条 assistant、57 条 tool，只有 5 条 user，结果产出 30 个 lexicon、30 个 note，几乎没有真实人物事件；
- 11-11 只有 15 行、2 条 user，产出 1 个 event、0 个 lexicon/note，反而是最干净的；
- 11-10 的 8 个 event 里仍有同一次“醒来/清积压”的重复块，说明重复不只来自双 dream，单次 events 切块也可能重复。

### 已修输入污染源

bridge 的原文层原来会把 assistant 的 `reasoning` 块也拼进 raw，导致 dream 把内部计划（很多英文）当成她说过的话。  
已改为 assistant 只保留 `type === 'text'` 的可见消息；reasoning 不进 raw。  
这会影响**之后**的 raw；已有 fixture 仍是旧数据，正好作为“污染基线”保留。

## 下一轮：不是继续跑同一基线

1. 给 replay 增加 `raw-all` / `raw-human` 两种输入 profile；
2. 对同一份 fixture 比较两种 profile 的 event/lexicon/note/重复率；
3. 人工填 `gold.template.json`，至少覆盖 11-10 和 11-11；
4. 再把这批 raw 转成 soul 的提取输入，比较“选择记什么”；
5. 根据结果决定先修：dream 幂等、lexicon 门槛、person alias 或 raw 过滤。

### replay 工具

```text
node tools/memory-replay.mjs --fixture .state/lab/memory-fixture/latest --days 2026-11-09
node tools/memory-replay.mjs --fixture ... --days all --max-calls 80
node tools/memory-replay.mjs --fixture ... --days 2026-11-09 --cache-only
```

输出到 `.state/lab/memory-replay/<timestamp>/`；`cache.json` 按 prompt hash 缓存云端响应；不修改 live memory.db。

### 凭据

`DEEPSEEK_API_KEY` 在 **Windows 用户变量**里存在，但当前 pwsh 进程不一定继承。  
运行前用：

```powershell
$env:DEEPSEEK_API_KEY=[Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY','User')
```

不要把密钥写进仓库、日志或 `cache.json`（cache 只保存模型输出）。

### 稀疏日测试

fixture 里 2026-11-07 有约 139KB raw，但没有对应 day log；2026-11-11 只有少量 raw。  
这两个日期优先做低事件量测试。

## 结论

当前 live 数据不足以证明“记忆系统稳定有效”：

- 块重复；
- lexicon 噪声；
- person alias；
- 主动召回和 boost 几乎未发生；
- day log 有缺口（11-07 raw 未沉淀）。

但这也正是 fixture 的价值：不用继续污染 live 记忆，就能在云端重放同一批 raw，先测稀疏日/空闲日，再测密集日。


