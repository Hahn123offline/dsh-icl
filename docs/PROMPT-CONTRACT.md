# 提示词分层契约（2026-11-05 批准）

> 状态：用户已批准"按提案一次拆到位"。本文是**写提示词时唯一的事实源**；改分层先改这里。
> 背景：`prompts/live.md` 把人格与"怎么用工具"合并，导致同一件事在三处重复（全局提示词、插件 prompt section、工具 description），
> 且动态状态与人格混排，对前缀缓存不友好。

## 1. 三层，各管各的

| 层 | 位置 | 回答什么 | 稳定性 | 禁止 |
|---|---|---|---|---|
| **人格** | `prompts/persona.md`（配置 `personaFile`） | 她是谁、怎么说话、在乎什么、底线 | 全局常量，基本不变 | 出现任何工具名/参数/环境细节 |
| **仿真纪律** | `prompts/sim.md`（配置 `simulationFile`） | 她在这个运行时里怎么生活；**这些工具如何配合着用**（全局层） | 几乎不变；改它要走本文 | 抄工具参数表、教具体按钮；不写"你是 X"式人格 |
| **工具教学** | 每个工具自己的 `description`；深文档在 `skills/*.md` 或 `mcb_help` 之类的按需入口 | 参数、边界、失败怎么办、示例 | 逐工具演化 | 在全局提示词里重复工具步骤 |

另外两类内容**不属于**上面三层：

- **事实状态**（时间、位置、任务进度、待办）：由插件 `prompt.section` 提供，**只陈述，不教导**，
  每段 ≤ 1–2 行，order ≥ 800（排在人格/仿真之后，保持前缀稳定）。
- **每轮上下文**（检索到的记忆、压缩摘要）：走 `prompt.onTurn` → `agent/pre-step` 尾部追加，
  不进系统提示词。

## 2. 判断一条内容该放哪

1. 换一个完全不同的工具集，这句话还成立吗？成立 → 人格或仿真。
2. 这句话在描述"用什么工具、点什么按钮、参数填什么"吗？是 → 工具 description 或 skills。
3. 这句话每轮/每分钟都在变吗？是 → 事实状态 或 每轮上下文，并放到尾部。
4. 同一事实是否已在别处出现？是 → 删掉重复的那份，只留一个家。

## 3. 插件 prompt section 的硬规则

- 只允许"当前事实"：`时间：…`、`位置：…`、`任务：…`、`待办：…`。不允许"你应该…""记得要…"。
- 每段最多 1–2 行、有长度上限（实现里要截断），没有内容时整段消失（`when()` 返回 false），不要留空行。
- 动态段 order 从 800 起；人格 20、仿真 25，中间留给未来全局常量段（30–799）。
- 段文本的**开头**不许放随机量（id、毫秒时间戳、随机摘要）；易变量放段尾。
- 同一事实只能有一个 section；发现重复（如 time 与 world-state 各一行"时间"）由 owner 合并。

## 4. 工具 description 的规则

- 自足：模型不用读别的文档就知道参数、返回什么、失败是什么样、失败后能做什么。
- 不写人格、不写"你是…"；可以写"当你……时用它"。
- 长知识（交易、建造、脱困、下矿）不进 description，放 `skills/*.md`，用 `mcb_help` 按需取。
- 工具名/参数保持稳定；`output.render` 的文本要短、结构化、可直接引用。

## 5. 已落地的拆分（2026-11-05）

- `prompts/persona.md`：小千的身份、语气、在乎的事、底线（无工具名）。
- `prompts/sim.md`：生活节奏、时间/唤醒/睡眠、focus、记忆、MC 怎么来一局、看视频、工具共同规矩。
- `prompts/live.md`：**遗留合并版**，不再被默认配置引用；保留作对照，勿再往里加内容。
- `dsh-icl`：`personaFile` 默认 `prompts/persona.md`；新增 `simulationFile`（默认 `prompts/sim.md`），
  由 `bootstrapHost` 注册为 `icl:simulation`（order 25），与 `persona`（order 20）相邻。
- MC：`mc:play`/`mc:interaction` 两个"教操作"的系统段应删除或收缩为纯事实；
  操作教学移入 `mcb_*` 的 description 与 `mcb_help` skills（owner: mc-link）。

## 6. 验收

- 新建 lab 会话，`system/message` 里顺序为：人格 → 仿真 → 事实状态；人格段逐轮完全一致。
- 工具面里不再有"先 focus 再 join"这类与全局提示词重复整段。
- 新增内容时用 §2 的四问自检；review 清单里检查"是否引入第三处重复"。

## 7. 2026-11-05 追加：DSH 自带身份的覆盖

DSH 全局 `@deepseek-ai/dsh-system-prompt` 默认带 `personaPrefix: You are a coding agent powered by the {{model}} model.`，
它排在 ICL 人格段之前，与"你不是一个助手"直接冲突（misc 审计 P1-14）。ICL 的每个 preset 现在插入一行
scoped `@deepseek-ai/dsh-persona`：

```yaml
- id: tool-persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: ''                                  # 空段会被 DSH 丢弃，等于去掉 coding-agent 身份
    suffix: '' # 产品 preset 不能引用 {{cwd}}：desktop 内置 DSH 只注册 provider/model，引用会让 turn 前直接失败
# 历史/说明：npm DSH 的 agent-loop 注册了 cwd（lab 可用），但产品以 desktop 内置版为准；
# lab preset 仍可保留 cwd suffix（当前 lab 基线含该段），产品必须为空。
```

实测（lab，2026-11-05）：系统提示词首行只剩 `You are an AI agent powered by DeepSeek Harness.`，
第 3 行是人格段；工作目录仍在末尾。改 preset 后**必须重启/新起进程**才生效（DSH 无热重载）。
