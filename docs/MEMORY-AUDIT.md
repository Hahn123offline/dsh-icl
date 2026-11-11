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

## 下一步：云端 replay

1. 用 fixture 在临时 stateDir 建空 memory.db；
2. 注册固定 raw source，按日跑 dream（云端模型）；
3. 输出 blocks/persons/lexicon/notes；
4. 与 `current.json` 和 gold 对比；
5. 再把这批 raw 转成 soul 的提取输入，比较“选择记什么”；
6. 根据重复率、噪声率、人物正确率、召回命中、boost 结果，决定先修 dream 幂等、lexicon 门槛还是 person alias。

replay 不写 live 库；云端输出可缓存，避免每次重复付费。
