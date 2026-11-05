# 缓存模型：插件投递通路 → DSH 请求 → 本地前缀缓存

> 状态：2026-11-05，W2 交付。读者：要往 DSH 会话里投自定义消息、或要改提示词布局的人。
> 基线：`master` 上的 `time`(ee74d28)/`mc-link`(12dbfbb)/`prompt 分层`(4499e8b) 之后；
> 优化实现见 `packages/dsh-icl/src/bridge.mjs`（`icl:core` + `icl:facts`）与本文件 §5。
> 测量工具：`tools/cache-probe.mjs`（引擎侧指标 + lab A/B）、`tools/cache-log.mjs`（DSH 会话日志只读重建）。

---

## 0. 一句话结论

本地模型（llama-swap → NInfer/KVMem，`coder390-27b-q3-df2-4x500`）的前缀缓存**不是"从差异点往后作废"，
而是"会话指纹一变整条作废"**：

- **系统提示词里任何一个字节变化 → 整条 prompt 重新 prefill（`prefix_cache_hit_tokens=0`）**，
  哪怕变的是系统提示词的最后一个字（实测见 §4.2）。
- 真实 ICL 会话（`ninfer` 路由）：每个**新回合** `hit=0`、prefill 7k–24k tokens、**TTFT 10–24s**；
  同一回合内的多步工具循环 `hit≈99%`、prefill 20–300 tokens、**TTFT 0.3–0.5s**。
- 根因是三件事叠加（§4.1）：
  1. ICL 把"时间/世界/focus/MC 状态"这些**每轮可能变**的事实放进了系统提示词；
  2. DSH 对 `ninfer`（`@deepseek-ai/dsh-llm-pi-ai`）没有 `systemPromptUpdate: in-history` 能力，
     系统提示词一变就**替换**首个 system 消息（不是追加）；
  3. NInfer 按前缀/会话指纹保留 KV（`retained_sessions_limit=4`），系统提示词一变就新开会话。
- 修复（方案 B，已落地）：系统提示词只保留**静态段**（人格 + 仿真，整场字节稳定），
  动态事实走 DSH 官方的 **runtime-context 快照消息**（只追加、不替换）。
  after 数字见 §5.3。

---

## 1. 一个请求是怎么拼出来的

### 1.1 位置图（每一步）

```
用户消息 / 投递 / 定时唤醒
        │
        ▼
[DSH]  agent/pre-step（ICL bridge 在这里追加本批消息 + 本轮的 <icl-context>）
        │
        ├─ systemPrompt.assemble()            ← 所有 systemPrompt.section() 的 text()
        │    ├─ renderPrompt(sections)         → 一条 system 消息（消息列表第 0 条）
        │    └─ renderContextSections()        → runtime-context 快照（只在内容变化时追加）
        ├─ tool providers                      → tools 字段（独立 JSON 数组）
        └─ session surface（user/assistant/tool 消息，按 seq）
        ▼
[DSH]  buildRequest → @deepseek-ai/dsh-llm assembler → llm-pi-ai(openai-completions) → POST /v1/chat/completions
        │
        ▼
[llama-swap 8088] → NInfer 引擎（KVMem retained session，按前缀复用 KV）
```

请求体的形状（`openai-completions`，`ninfer` provider）：

```jsonc
{
  "model": "coder390-27b-q3-df2-4x500",
  "messages": [
    { "role": "system", "content": "<全部 systemPrompt sections，按 order 排序>" },
    { "role": "user",    "content": "…" },          // surface 上的消息，按 seq 顺序
    { "role": "assistant", "content": "…" },
    { "role": "user",    "content": "Current runtime context. This snapshot supersedes earlier…" },
    { "role": "user",    "content": "<icl-context>…</icl-context>" }
  ],
  "tools": [ /* 32–42 个 ICL 工具 + DSH 工具，按 name 字典序 */ ],
  "max_tokens": 64000
}
```

### 1.2 系统提示词：谁在里面、什么顺序

DSH 的 `@deepseek-ai/dsh-system-prompt` 把段按 `(order, name)` 排序，用 `\n\n` 连接：

| 位置 | 段 | order | 稳定性 |
|---|---|---|---|
| 1 | `harness:identity`（"You are an AI agent powered by DeepSeek Harness."） | -1000 | 静态 |
| 2 | **ICL 段**（`icl:core`，见下） | 30 | 静态（B 之后） |
| 3 | DSH 运行时说明 / 工具说明（plan、沙箱、文件引用、bash/fs 工具段…） | 500–3100 | 会话内静态 |
| 4 | `icr:facts` → **不在 system 里**（B 之后走 runtime-context） | — | — |
| 5 | DSH checkout 说明 `HARNESS_SOURCE` | 10000 | 静态 |
| 6 | `WEB_SURFACE`（本 run 的 URL/端口） | 10100 | 本 run 静态 |
| 7 | `deployment:persona-suffix`（含 cwd 等） | 10200 | 会话内静态 |

ICL 自己的段（`host.services.prompt.section()`）被 DSH 看成一个整段（旧布局），或拆成两个通道（B 之后）：

| ICL 段 | ICL order | 内容 | 每轮稳定? | B 之后去哪个通道 |
|---|---|---|---|---|
| `persona` | 20 | 人格（`prompts/persona.md`，人写的常量） | 稳定 | **system**（`icl:core`） |
| `icl:simulation` | 25 | 仿真纪律（`prompts/sim.md`） | 稳定 | **system** |
| `focus` | 875 | 当前 focus + 已 N 分钟（5 分钟取整） | 有 focus 时随时间/动作变 | runtime-context（`icl:facts`） |
| `time` | 880 | 日期 + 时段 + 阶段 + 下一个安排 + 积压 | 状态变则变 | runtime-context |
| `world` | 890 | 世界状态 brief（日程/进行中/目标…） | 状态变则变 | runtime-context |
| `mc:status` | 900 | MC 一行事实（在线/位置/血量…） | MC 里每轮都变 | runtime-context |
| `mc:skills` | 901 | 命中时才出现的 MC 技能提示 | 条件变 | runtime-context |

> 契约来源：`docs/PROMPT-CONTRACT.md` §3（动态段 order ≥ 800、事实只陈述、开头不许放随机量）。
> **B 的实现把"契约里的 order 顺序"变成了"请求里的物理位置"**：order < 800 → system；order ≥ 800 → 尾部快照。

### 1.3 工具面

- 来源：`ctx.tools.register()`（ICL 桥在 start 时按 `host.services.surface.list()` 注册），
  DSH 的 systemPrompt tool provider 收集，`orderTools()` **按 name 字典序**排序（无 `toolOrder` 配置时），
  与插件启用顺序无关 → 同一会话内**字节稳定**。
- 位置：请求的 `tools` 字段，不是 system 文本。但引擎 chat template 会把它渲染进 prompt，
  所以它也在前缀里；**只要 tools 变了，同样整条作废**（实测见 §4.2 的 session 指纹语义）。
- 稳定性靠：`sameTool()` 比较（name/description/parameters），插件热启用/禁用才重注册；
  测量时记 `toolsHash`（`tools/cache-probe.mjs` 从 `request/header` 算）作为可追踪输入。

### 1.4 会话历史（surface）怎么重建

DSH 的每条会话事件带 `surfaceOp`：

- `append`：追加一个节点（user/assistant/tool/运行时快照）；
- `replace {startSeq,endSeq}`：**替换**已有节点（系统提示词更新走这条；压缩也走这条）。

模型每步看到的请求 = system 消息 + surface 上所有节点按 seq 展开。因此：

- **append-only 的会话是缓存友好的**（上一请求的 prompt 是新请求的前缀）；
- 任何 `replace`/删除历史都会让"被改写点之后"全部作废；系统消息被 replace 则**整条**作废。

---

## 2. 投递通路表（核心）

> 列含义：**谁写** / **何时写** / **进入请求哪里** / **内容是否每轮稳定** / **稳定性靠什么保证**。

| # | 通路 | 谁写 | 何时写 | 进入请求哪里 | 每轮稳定? | 稳定性靠什么 |
|---|---|---|---|---|---|---|
| 1 | **systemPrompt.section(`icl:core`)** | `bridge.registerPrompt()`（B 后只装 order<800 的段） | 每 step 装配时求值 | system 消息（第 0 条） | **稳定**（B 后：人格+仿真，整场不变） | 段过滤（order<800）+ 文案不放动态量 + `PROMPT-CONTRACT` 规定动态段 order≥800 |
| 2 | **systemPrompt.context(`icl:facts`)** | `bridge.registerPrompt()`（B 后） | 每 step 装配；**内容变化时** DSH 追加一条 | runtime-context 快照 user 消息（尾部） | 变化（时间/世界/focus/MC 状态） | DSH 的 `RuntimeContextProjection` 只在快照文本变化时 append；**append 不 replace** |
| 3 | **agent/pre-step `<icl-context>`** | `bridge.preStep()`（`prompt.turnText` + `context.assemble`：eager-recall、压缩摘要…） | 每条真正的用户消息进入的这一 step | 本批 messages 末尾追加一条 user 消息（`source.kind='plugin:icl'`, `form='notice'`，id `icl-ctx-*`；producer-owned，避免与 DSH 快照投影撞车） | 变化（检索结果/摘要） | append-only；为空则整段不注入；原文层/历史层都按 `source.kind` 过滤 |
| 4 | **delivery → steer/followup notice** | 插件 `delivery.push` → `bridge.tick()` | 每 500ms tick（空闲时起一轮；运行中在下一个 step 边界） | 追加 user 消息（`source.kind='plugin:<plugin>'`, `form='notice'`） | 变化（通知内容） | append-only；`signals`/`delivery` 的 gate 决定"投不投/进不进积压"，不改变消息位置 |
| 5 | **tool result** | DSH 工具执行 | 每个 tool call 之后 | 追加 tool 消息（surface append），下一 step 请求可见 | 变化（内容本身） | append-only；**例外**：DSH `compaction-tool-result-pruner` 超阈值时会改写旧 tool result（§7） |
| 6 | **context.provideHistory** | `bridge.registerHistory()` | 每次 `context.assemble()`（pre-step） | **不进请求**，只作为插件生成 `<icl-context>` 的输入 | 派生自 surface | 只读投影；按 `kind==='user'` 过滤，滤掉 runtime-context/`icl-ctx-*` |
| 7 | **原文层 raw**（`session-events.jsonl`/内存 raw） | `bridge.appendRaw()` | 每个 session 事件 | **不进请求**（给 dream/recall 用） | n/a | 只收 user/assistant/tool；`source.kind!=='user'` 丢弃；`<icl-context>` 前缀丢弃 |
| 8 | **DSH 自身 runtime-context**（sandbox/approval/…） | 各 DSH 插件 `systemPrompt.context()` | 每 step | 与 #2 同一条快照 user 消息 | 稳态不变 | 变化才 append；与 #2 合成一个快照（免得一次变化拆成多条） |
| 9 | **DSH 系统提示词更新** | `SystemPromptProjection` | 每 step 比较 `renderPrompt()` | system/message 事件：`in-history` 路由**追加**一条；`ninfer` 路由 **replace 首节点** | 只有文本变化才发生 | **B 的目标就是让它永不变**；一旦变，ninfer 路由整条作废 |
| 10 | **DSH 会话标题 LLM** | `session-title-first-prompt-llm` | 会话首条消息后一次 | **独立辅助请求**（无工具、短 system） | 一次性 | 不写主会话 surface，不改变主请求；只是多占一次引擎 lane |
| 11 | **DSH 压缩 / checkpoint / tool-result pruner** | `compaction-basic`（阈值 80% context window）、`compaction-tool-result-pruner`（`thresholdChars`） | 超阈值时 | **改写 surface 历史**（replace/remove） | 触发时一次 | 靠上下文预算；长会话的"第二股前缀破坏源"，与 ICL 无关（§7） |
| 12 | **模型/工具面变化** | `session/selectModel`、`ctx.tools.register/off` | 执行时 | 改变 `config`/`tools` 字段 + `startsSeries` → system replace/append | 会话内应保持不变 | 一次会话只选一次模型；工具面在插件启用后固定 |

**一句话记法**：`system` 里的东西必须**整场字节稳定**；会变的东西一律走**追加消息**（#2/#3/#4/#5）——那是缓存友好的。

---

## 3. 本地引擎怎么判"命中"

`/v1/models` 的 args 里能看到引擎是 `NInfer 0.12.0-rtx3090`（llama.cpp 派生），
启动参数含 `--kvmem-sessions 4`、`--derive-session-keys`、`--kvmem-sink-tokens 4096`、
`--request-log-jsonl <path>`。它的行为（实测）：

- **retained session**：最多保留 4 个会话的 KV（`/props` → `kvmem.capabilities.retained_sessions_limit=4`）；
  会话指纹由请求前缀派生（`--derive-session-keys`）。**前缀一变就是新会话**。
- 每个请求在引擎日志里留一条 `request_done`，关键字段：
  - `result.prompt_tokens`：请求总 token；
  - `result.computed_prefill_tokens`：**实际重新 prefill** 的 token；
  - `result.prefix_cache_hit_tokens`：**复用**的 token；
  - `result.prefix_reuse_path`：`root`（新会话/全量）、`private_endpoint`（同会话续写）、`private_response_replay` 等；
  - `timings_seconds.{prefill,ttft,decode,total}`。
- 还有两个只读仪器：
  - `GET 18122/slots`：每个 lane 的 `n_prompt_tokens / n_prompt_tokens_cache / session_digest`；
  - `GET 18122/metrics`：`llamacpp:prompt_tokens_total`（**已排除复用前缀**）、`prompt_seconds_total` 等。

**判定口径（本文件全程使用）**：
`全量失效 = prefix_cache_hit_tokens === 0 && computed_prefill_tokens > 0`。

> llama-swap 的 `GET /logs` 只有进程日志（健康检查/429/流断开），**没有请求体和 token 指标**；
> 真正可用的是引擎自己的 request log 和 /metrics。/v1/models、/metrics 之外的 `/api/*` 端点在这个版本返回 404。

---

## 4. 失效归因

### 4.1 机制三件套（为什么一个字节也会全废）

1. **ICL 的动态事实在系统提示词里**（旧布局）：`world`(890)/`time`(880)/`focus`(875)/`mc:status`(900)
   都拼进 `icl:core` 这一个 DSH section。时间/世界/focus/MC 状态一变，整个 system 文本变。
2. **DSH 对 ninfer 走 replace 分支**：`dsh-llm-pi-ai` 没有 `systemPromptUpdate: in-history`
   （只有 `dsh-llm-deepseek` 有）。所以 `SystemPromptProjection.project()` 的
   `inHistory=false` → `replace(head.seq, rendered)`：system 节点被整条替换。
   会话日志里，`ninfer` 会话的 `system/message` 全是 `surfaceOp: replace`；`deepseek` 会话是 `append`。
3. **引擎按前缀保留会话**：system 变了 → 会话指纹变 → `prefix_reuse_path=root`、`hit=0`、整段 prefill。
   **不是从差异点往后作废** —— 见 §4.2 的 tailclock 实测。

历史证据（用户真实 ICL 会话，今天 15:22–15:41，`session-737ec994`，
preset `icl`，provider `ninfer`，coder390-27b-q3-df2-4x500，MC 场景）：

| 时刻 | 回合内第几步 | prompt | prefill | hit | path | TTFT |
|---|---|---|---|---|---|---|
| 15:23:12 | 新回合 | 20990 | 20990 | 0 | root | 20.05s |
| 15:23:29 | 同回合多步 | 21200 | 18432 | 0 | root | 0.05s（取消） |
| 15:25:56 | 同回合多步 | 23101 | 31 | **23070** | private_endpoint | **0.43s** |
| 15:25:59 | 同回合多步 | 23678 | 23 | **23655** | private_endpoint | **0.45s** |
| 15:26:25 | 新回合 | 23892 | 23892 | 0 | root | 24.10s |

→ 同一回合内的工具循环命中 99%；**换回合就全量重算**。那一晚的原因就是 MC 状态/时间在 system 里每轮变。

### 4.2 真实 payload 的裸 API 对照（绕过 DSH，直接打 8088）

用 **after run 的真实系统提示词全文（4978 字符 / 8408 字节）与 34 个真实工具 schema**，
4 轮、每轮末尾追加一条用户消息、`max_tokens=8`。三种布局：

| 变体 | 系统提示词 | 每轮命中 | prefill/轮 | TTFT |
|---|---|---|---|---|
| `stable`（完全不变） | 不变 | 100% | 25 tok | 0.36s |
| `tailclock`（**ICL 旧布局**：动态行放 system 尾部，每轮变） | +24 字符变 | **0%** | **8008 tok 全量** | **5.0–5.2s** |
| `headclock`（旧 bug：动态行放 system 开头） | 开头变 | **0%** | **8008 tok 全量** | **5.0–5.3s** |
| `facts-tail`（**方案 B**：system 全静态，事实作为尾部 runtime 消息） | 不变 | **99%** | **108 tok** | **0.4s** |

**结论（限定在 ninfer 的复用粒度上）：把动态段从 system 开头挪到 system 尾部（方案 A）收益 = 0**——ninfer 按**整段 system 的 digest** 决定能不能复用，system 有任何差异就整条作废，
和差异出现在第 1 个字节还是最后一个字节无关。唯一有效的是让 system **完全不变**（方案 B）。
真实 8k payload 下 **TTFT 5.1s → 0.4s（12×）、每轮 prefill 8008 → 108 tok（74×）**。

> 限定：这是 **NInfer KVMem** 的行为（按整段 system 的 digest 复用）。按 token 前缀复用的引擎（如 llama.cpp `--cache-reuse` 一类）通常能保住差异点之前的 token，"把动态段后置"在那种引擎上可能仍有一半收益；对外引用请带上引擎限定。


复跑：`node tools/cache-probe.mjs api --from-run cache-af2 --turns 4`。

---

## 5. 优化（方案 B）与语义影响

### 5.1 改了什么

`packages/dsh-icl/src/bridge.mjs`：

- `icl:core`（DSH section, order 30）只装 ICL `order < 800` 的段（当前 `persona` 20 + `icl:simulation` 25）；
- ICL `order ≥ 800` 的段（`focus`/`time`/`world`/`mc:status`/`mc:skills`）注册成**一个**
  `ctx.systemPrompt.context({ name:'icl:facts', order:850, text })`：
  DSH 把它渲染进"Current runtime context. This snapshot supersedes earlier runtime-context snapshots."
  的快照消息，**只在文本变化时追加**；
- 空内容返回 `''`（DSH 跳过空段），所以"没有 focus/MC"时不会多出空行；
- `ctx.systemPrompt.context` 不存在（老宿主/测试假 ctx）→ 自动退回旧的单 section 全量行为，
  并记一次 `icl.prompt-layout` 日志（`layout:'single-section'` + 原因）；
- `packages/core/src/services.mjs`：`prompt.assemble(ctx, { minOrder, maxOrder })`（additive，默认全量）；
  `dsh-contract.mjs` 的 `toDshPromptSection` 支持传 `range`。

### 5.2 语义影响声明（逐条）

| 项 | 影响 | 是否改变语义 |
|---|---|---|
| 动态事实（时间/世界/focus/MC 状态） | 仍然**每一轮**到达模型，位置从"系统提示词尾部"变成"运行时上下文快照消息" | 否（同一事实、同一频率；DSH 自己的 sandbox/approval 本来就走这条通道） |
| 事实的"持久指令"感 | system 里不再有"时间：…"，改为每轮快照；模型按"当前状态"理解（DSH 官方语义） | 否（PROMPT-CONTRACT §3 本来就规定事实段只陈述、不教导） |
| GUI/transcript | 事实显示为 runtime-context 快照，不再是 system 提示词的一部分 | 展示位置变化，内容不变 |
| ICL 原文层 / dream | 桥内按 `source.kind!=='user'` 过滤；`dsh-raw` 另有 `/^(Current runtime context|Time sampled|…)/` 过滤 → 快照不会进原文/dream wash | 否 |
| `<icl-context>` 的 source.kind | `runtime-context` → `plugin:icl`（producer-owned）；内容/位置/频率不变，GUI 从"上下文快照"变"插件通知" | 否（DSH 不再把它当自己的快照 → 少一次重复 append） |
| 旧宿主兼容 | 无 `systemPrompt.context` 时退回全量单段（缓存差但语义完整），有测试 | 否 |
| facts 快照刷新频率 | 同一 turn 内最多 1 次；focus/time 等**事件类事实** dirty 后下一步必刷新（stale ≤ 1 步）；MC 环境事实允许整轮陈旧（以 `mcb_status` 为准） | 是（有明确豁免与护栏，见 §7.7） |
| `ICL_FACTS_IN_SYSTEM=1` | **测量专用**开关，强制旧的"事实进 system"行为，用来做同代码 A/B；生产默认必须是 B（不设该变量）。它不是产品配置、不会出现在 preset 文档里，**release/handover 前应删**。唯一读取点在 `bridge.registerPrompt()` 的短路（`!== '1'`），不设时行为完全由 config 决定；删之前也不会被业务代码误用 | 不是产品路径 |

### 5.3 before / after 数字

> 两轮是**相邻 commit**（before `6f7e88f`、after `ff44c00`）：两 commit 之间只有测量开关（`ICL_FACTS_IN_SYSTEM`）、日志、`factsOff` 清理、探测工具/场景/测试的差异，
> **core/src、plugins、prompts、config.mjs 零变化**（misc §0.4 独立核过）→ 对"布局"这一变量有效；两轮 `toolsHash` 相同（`ea157721d261`）、system 只差 118 字节（事实移出）。
> 要**严格同 commit** 复跑 before：在 master 上设 `ICL_FACTS_IN_SYSTEM=1` + `cache-probe run` 即可（开关正是为此保留到测量结束）。
> 同一 scenario（`tools/scenarios/cache-facts-6.json`：每轮用 `time_arrange` 让"下一个安排"变早，
> 制造真实的事实变化）、`--rounds 6 --gap 65`（每轮跨分钟）、同一引擎（`coder390-27b-q3-df2-4x500`）、
> 同一 lab preset（`icl-lab`，32 个 ICL 工具 + `tool-todo`，**toolsHash 实测 34 个工具 / `ea157721d261`**）；
> before 只多一个 `ICL_FACTS_IN_SYSTEM=1`。
> 证据：`.state/lab/cache-bf2/cache-probe.json`、`.state/lab/cache-af2/cache-probe.json`。

#### before（事实在 system 里，旧布局）

每轮出现两次引擎请求（step1 + 调完 `time_arrange` 的 step2）：

- step1：上一轮最后那次 replace 之后 system 未变 → 命中 99%；
- **step2：`time_arrange` 改了"下一个安排" → 系统提示词 replace → 整条作废（hit=0、prefill 8.3k）**；
- 6/6 轮都至少发生一次全量失效；每轮平均 TTFT 5.3–6.1s（全量那次），跨 6 轮 system 被 replace 6 次。

| 轮 | turnMs | sysB | system 更新 | prompt | prefill | hit | hit% | TTFT | 全量失效 |
|---|---|---|---|---|---|---|---|---|---|
| f1 | 11592 | 8533 | append:5053 | 16150 | 16150 | 0 | 0% | 5.62s | YES |
| f2 | 6567 | 8526 | (上轮末 replace) | 16484 | 8350 | 8134 | 49% | 5.26s | YES |
| f3 | 6881 | 8526 | — | 16814 | 8513 | 8301 | 49% | 5.45s | YES |
| f4 | 7197 | 8526 | — | 17144 | 8680 | 8464 | 49% | 5.75s | YES |
| f5 | 7171 | 8526 | — | 17477 | 8846 | 8631 | 49% | 5.88s | YES |
| f6 | 7482 | 8526 | — | 17805 | 9008 | 8797 | 49% | 6.09s | YES |
| 合计 | — | — | 6 次 replace | 101874 | **59547** | 42327 | 41.5% | 40.4s prefill | **6/6** |

#### after（方案 B：静态 system + facts 走 runtime-context）

- 系统提示词只有 **1 次 append**（4978 字符 / 8408 字节，`hasFacts=false`），**12 个 step 内没有任何 replace**
  （相邻 step `firstDiff=-1`）；
- 事实每轮/每次工具调用变化时，DSH 追加一条 runtime-context 快照（`form:snapshot`，约 458–465 字符），
  只是消息列表变长，不回写任何前缀；
- 每轮 2 次引擎请求（step1 + 调完 `time_arrange` 的 step2），**除首轮冷启动外全部命中**：

| 轮 | turnMs | sysB | system 更新 | prompt | prefill | hit | hit% | TTFT | 全量失效 |
|---|---|---|---|---|---|---|---|---|---|
| f1 | 6906 | 8408 | append:4978（仅此一次） | 16278 | 8209 | 8069 | 50% | 5.52s | YES（冷启动） |
| f2 | 1894 | 8408 | — | 16868 | **242** | 16626 | 99% | 0.58s | - |
| f3 | 1556 | 8408 | — | 17460 | **244** | 17216 | 99% | 0.50s | - |
| f4 | 1868 | 8408 | — | 18052 | **242** | 17810 | 99% | 0.53s | - |
| f5 | 1558 | 8408 | — | 18644 | **244** | 18400 | 99% | 0.48s | - |
| f6 | 1567 | 8408 | — | 19232 | **240** | 18992 | 99% | 0.49s | - |
| 合计 | — | — | **0 次 replace** | 106534 | **9421** | 97113 | **91.2%** | 0.5s/轮 | **1/6（仅冷启动）** |

> 对照：before 每轮 system 被 replace 一次 → 每轮一次 8.3k 全量 prefill；
> after 每轮 prefill ≈240 tok（= 新增的用户消息 + 事实快照 + 助手回复的增量）；注意这 240 tok 里有 ≈130–150 tok 是事实快照（见 §7.7）。

#### 合并后 sanity（`d1574d5` + 云端 deepseek-flash，不占 GPU）

把 B 合到最新 master 后，用 `icl-lab` preset + `deepseek-account/deepseek-flash` 跑了 3 轮
（`cache-sanity-cloud`，端口 57104，无本地模型）：

- `system/message` 全程只有 **1 条 append**（5014 字符，`hasFacts=false`），5 个 step 相邻 `firstDiff=-1`；
- 事实快照消息的 `source.sections = ["sandbox:policy","approval:policy","icl:facts"]` ——
  ICL 事实与 DSH 自身策略合并成**同一条** runtime-context 快照（符合"一次快照包含全部动态事实"的要求）。

### 5.4 数字表

| 指标 | before（事实在 system） | after（事实走 runtime-context） | 变化 |
|---|---|---|---|
| commit | `6f7e88f`（相邻 commit，env 开关切旧布局） | `ff44c00`（相邻 commit，默认布局） | 注入内容面零变化，只切布局 |
| 工具面 | 34 个 / `ea157721d261` | 34 个 / `ea157721d261` | 不变 |
| 系统提示词字节（每轮） | 8526–8533 | **8408（12 步恒定）** | 少 118 B（事实移出） |
| 系统提示词更新方式 | **每轮 `replace`（6/6 轮）** | **1 次 `append`，0 次 replace** | 关键 |
| 相邻两轮首差异位置 | **2263–2269 字符（5721–5727 字节）**，每次 replace | **-1（完全一致）** | 关键 |
| 每轮 prompt tokens | 16150 → 17805 | 16278 → 19232 | +590 tok/轮（含正常对话；快照**线性累积**见 §7.7） |
| 每轮 prefill tokens（合计 6 轮） | **59547** | **9421** | **-84%** |
| 每轮 cache hit tokens（合计 6 轮） | 42327（41.5%） | 97113（**91.2%**） | +120% |
| 每轮 TTFT（全量请求 / 稳态请求） | **5.01–6.09s**（7 条全量请求）/ 0.51–0.57s | **0.42–0.58s**（11 条命中请求） | **≈11×** |
| 全量失效 | **7 条请求 / 6 轮全部命中失效** | **1 条请求（首轮冷启动）/ 6 轮** | 关键 |
| 跨 6 轮 prefill 总秒数 | **40.4s** | **9.64s**（其中 5.5s 是首轮冷启动） | **-76%** |
| 事实快照追加量 | 0（在 system 里 replace） | **7 条 append / 12 步累计 3213 字符**（首条 465，稳态 458；≈130–150 tok/次） | 线性累积，见 §7.7 |
| 单轮 turnMs | 6.6–11.6s | **1.6–1.9s**（不含首轮 6.9s） | ≈4× |


#### 节流开关本地 A/B（2026-11-05 19:16–19:30，同 commit / 同 scenario / 同工具面）

| 项 | 默认（节流开） | `ICL_FACTS_EVERY_STEP=1`（节流关） |
|---|---|---|
| run | `cache-throttle-on` | `cache-throttle-off` |
| commit / tools | `8ea32d6` / 34 `7047e6c4f3e8` | 同 |
| facts 快照条数 / 字符 | **6 / 2705** | **7 / 3163** |
| system append / replace | 1 / 0 | 1 / 0 |
| engine 请求 / 全量失效 | 12 / 1（首轮冷启动） | 12 / 1（首轮冷启动） |
| prompt tokens | 106021 | 106796 |
| prefill tokens | **9312** | **9445（-133，-1.4%）** |
| cache hit tokens / hit% | 96709 / **91.2%** | 97351 / **91.2%** |
| TTFT 均值 / 最大 | 0.89s / 5.55s | 0.86s / 5.31s |

**结论**：节流**不降低 hit%（两者都 91.2%）**，prefill 略降（-1.4%），首轮冷启动后的请求全部 `private_endpoint` 命中。
本 scenario 每轮 facts 只变一次，所以节流只省 1 条快照（2705 vs 3163 字符）；**真正的收益在 step-heavy 场景**
（mc-lab 本地 MC run `L1`：27 个 step / 10 轮，facts 快照**共 5 条**、system **4999 字符 / 8473 字节**常数、0 replace → 节流有效且不破前缀）。
复跑：`node tools/cache-probe.mjs compare --a cache-throttle-on --b cache-throttle-off`。

> 真实会话的绝对数字更大（prompt 7k–24k tokens、TTFT 10–24s），因为会话历史更长；
> 修复后的稳态成本与历史长度无关（只 prefill 新增消息），所以**会话越长，收益越大**。

---

## 6. 测量方法（一键复跑）

### 6.1 仪器

```bash
# 引擎侧：当前 lane / 累计指标
node tools/cache-probe.mjs slots

# 引擎侧：最近的请求（prompt / prefill / hit / ttft / path）
node tools/cache-probe.mjs log --tail 40 --jsonl .state/cache/engine.jsonl

# DSH 会话日志：列出 ICL 会话（只读，zstd 解压）
node tools/cache-log.mjs sessions --preset icl --limit 20

# 从事件流重建每步请求（系统提示词 + 消息序列），算首差异/作废后缀
node tools/cache-probe.mjs diff --run <labRunId>
```

### 6.2 A/B（同一 commit，只切布局）

```bash
# before：旧布局（事实在 system）
$env:ICL_FACTS_IN_SYSTEM='1'
node tools/cache-probe.mjs run --scenario tools/scenarios/cache-facts-6.json \
  --port 57104 --run cache-bf2 --model local --gap 65 --rounds 6

# after：默认布局（事实走 runtime-context）
Remove-Item Env:\ICL_FACTS_IN_SYSTEM
node tools/cache-probe.mjs run --scenario tools/scenarios/cache-facts-6.json \
  --port 57104 --run cache-af2 --model local --gap 65 --rounds 6
```

> **`ICL_FACTS_IN_SYSTEM=1` 仅用于测量**：它不是产品配置、不会出现在 preset 文档或用户可见设置里；
> 同类的测量开关还有 `ICL_FACTS_EVERY_STEP=1`（关闭 facts 按轮节流、退回每步求值），同样仅用于测量、release 前应删。
> 生产默认必须是 B（不设该变量），**release/handover 前应删掉这个 env 分支**（唯一读取点是
> `bridge.registerPrompt()` 的短路；删掉它不需要改任何默认行为）。

`run` 会：记录引擎日志字节偏移 → `lab.mjs up/script/export/down` → 解析新增的 `request_done` →
按轮对齐（时间窗）→ 从事件流重建 system diff / toolsHash → 落 `cache-probe.json` +
`cache-probe-engine.jsonl`。

### 6.3 纪律与坑（都是踩过的）

- **GPU 串行**：根仓库 `C:\DSH\icl\.state\locks\llama.lock`（跨 worktree 共享）里写 owner/用途/ETA；
  `tools/lab.mjs` 的锁在**各自 worktree** `.state/locks/llama.lock`（`REPO_ROOT` 是 worktree）——
  跨 worktree 不互斥，mc-lab 已按 lead 要求统一到根路径。
- **污染窗口**：`retained_sessions_limit=4`，别的会话的本地流量会踢掉你的 retained session。
  记录每轮 `request_done` 的 `server_instance_id` / 时间窗，与第三方窗口重叠就作废重跑。
  已知污染窗口：2026-11-05 18:21:22–18:23:49（mc-lab 的 t3 走了本地 ninfer；本文件的 A/B 均不在此窗口）。
- **锁文件插曲（记录，不隐藏）**：2026-11-05 18:37:31–18:37:5x，mc-lab 自测锁逻辑时把根锁
  `C:\DSH\icl\.state\locks\llama.lock` 误覆盖（owner 从 cache 变成 mc-lab）后又删除，随后已逐字恢复。
  核实该实例只建会话 + `selectModel`、**没有发任何 prompt（无模型请求）**，且落在 before/after 的稳态区间，
  对本文件数据无影响。根因是旧锁实现只在 `pid` 存活时才拒绝；已改成"owner 不是自己就无条件拒绝"。
- `--gap` 单位是**秒**（不是毫秒）；`--model local` 会占 GPU 车道并上锁。
- 跨分钟/跨事实变化必须**显式制造**：`time` 段已经是"日期+时段"（无分钟级），
  纯等待不一定会变；`cache-facts-6` 用 `time_arrange` 让"下一个安排"每轮变早。
- 工具面是稳定的：每轮 `toolsHash` 不变才说明"变化的只有 system/消息"；变了先查插件启用/模型切换。

### 6.4 可复算口径（独立复核用；数字对不上先看这里）

**单位**

- `systemChars` = JS 字符串长度（UTF-16 code unit 数；中文一个字算 1）。
- `systemBytes` / `invalidSuffixB` = **UTF-8 字节**（中文一个字算 3 字节）。
- 本文件表格里"system 字节"用 `systemBytes`；引用 misc/lead 的"字符"时明确标注。

**system 段口径**

- "每轮 system 字节"是**当前生效的那一份 system 文本**（`replace` 之后是替换后的内容），
  **不是跨轮累加**。本文件 before 的 8526 B / after 的 8408 B 都是单份。
- 例外：`deepseek` 路由是 `in-history` 追加模式，会在历史里堆多份 system/message；
  本文件的数字**全部来自 ninfer（replace）**，不要和 deepseek lab 的累加口径混用。
- ICL 段字节数（如"2518 字/6190 B"）是 **host 级 `prompt.assemble()` 的结果**，不含 DSH 自己的段；
  端到端 system（8408 B）包含 DSH 全部段。两者不能直接比，差值 ≈ DSH 基础段 + 工具说明段。

**工具面口径**

- `toolsHash` = 第一次 `request/header` 里 `tools` 数组的**规范化 JSON** 哈希：
  每项只取 `{name, description, parameters}`，按 name 字典序排序，SHA-1 取前 12 位。
- `toolsChars` = 上述规范化 JSON 的字符数；`tools` = 工具个数。
- 工具 schema **不计入**"ICL 段字节"（那是提示词段）；但 **计入**引擎的 `prompt_tokens`
  （chat template 会渲染 tools）。本文件 before/after 的 `promptTokens` 含工具面。

**引擎指标口径**

- `promptTokens` = 引擎日志 `result.prompt_tokens`：请求总 token（system + tools + messages，渲染后）。
- `prefillTokens` = `result.computed_prefill_tokens`：**实际重新 prefill** 的 token。
- `cacheHitTokens` = `result.prefix_cache_hit_tokens`：复用前缀的 token。
- `全量失效` = `cacheHitTokens === 0 && prefillTokens > 0`。
- 每轮聚合：一轮内**所有** `request_done`（含 tool 步）的 prefill/hit/prompt 求和；
  `TTFT` 取该轮最大值；`turnMs` 用 lab observer 的轮次墙钟。
- 时间窗：`rounds.jsonl` 的 `at` 是**轮结束**时间，所以引擎请求窗口取 `[at-turnMs-1s, at+0.5s]`
  （`cache-probe joinRounds` 已内置；改口径后可用 `rebuild` 重算，不重跑 GPU）。

**复算命令**

```bash
# 不跑 GPU，用已落盘的引擎日志切片 + 事件流重算 bf2/af2 的所有表
node tools/cache-probe.mjs rebuild --run cache-bf2
node tools/cache-probe.mjs rebuild --run cache-af2
# 逐 step 的 system diff（首差异/作废后缀/system 更新方式）
node tools/cache-probe.mjs diff --run cache-bf2
```

---

## 7. 已知交互坑与后续选项

1. **`<icl-context>` 的 `source.kind` 已从 `runtime-context` 改为 `plugin:icl`（已修，本 commit）**：
   修前它冒充 DSH 的运行时快照：DSH 的 `RuntimeContextProjection` 用 `isOwned(message) = source.kind === 'runtime-context'`
   判归属，于是 ICL 每注入一次 `<icl-context>`，DSH 下一步就认为"自己的快照被换了"、**额外 append 一份完整快照**
   （≈ **+190 tok 上下文 / +140 prefill tok，每轮一次**）；而 bridge 自己在 `noticeMessage` 里写着"kind 必须 producer-owned"。
   - 修法：`source: { kind: 'plugin:icl', form: 'notice', summary }`（producer-owned，v4 规范允许；GUI 显示为插件通知）。
   - 证据：`dsh-bridge.test.mjs` 断言注入消息 `kind === 'plugin:icl'` 且 `!== 'runtime-context'`；
     raw/原文层与 `sessionHistory` 仍按 `kind !== 'user'` 过滤（改后不进人话/dream）。
   - 语义：`<icl-context>` 仍然是"这一轮的上下文补充"，只是不再被 DSH 误认成"快照"；
     DSH 自己的快照仍由 `systemPrompt.context('icl:facts')` 等正常贡献，两者不再互相触发。
2. **DSH 自己的压缩/剪枝会改写历史**：`compaction-basic`（80% context window 触发）、
   `compaction-tool-result-pruner`（旧 tool result 超阈值改写）。触发时前缀全废；
   这不是 ICL 的问题，但长会话里它是第二股"全量失效"来源。ICL 的 compaction 插件已默认关（避免第三套）。
3. **模型切换/工具面变化**：`selectModel` 或插件热启用会改变 config/tools → `startsSeries` → system replace → 全废。
   一次会话内不要切模型；插件在会话开始后不要再注册/注销工具。
4. **多 lane 竞争**：4 条 lane + retained 4 会话；desktop 用户会话与 lab 同时用本地模型时互相踢。
   要做数字必须独占（根锁）。
5. **`time` 段不再是分钟级**（time owner 的 P1-3 修复）：系统提示词不再每分钟变；剩下的变化是
   "时段/阶段/下一个安排/积压/focus 分钟数（5 分钟取整）/MC 状态"。B 之后它们都不在 system 里了。
6. **`bridge.mjs` 有一处重复的 `debug({where:'pre-step.extra'})`**（原 426–427 行，misc 已报）；无害但冗余，
   本文件不动它以免混入无关改动，后续可清理。
7. **facts 快照累积与节流（Option 1，已实现）**
   - **现状更正（misc §0.5）**：`cache-af2` 12 个 step 只有 **7 条快照 ≈1 条/轮**——DSH 的 `RuntimeContextProjection.project()`
     文本相同就不 append。所以"每步一条"只在**一个 turn 内事实每步都变**时发生（典型是 MC 的 `mc:status`），
     不是所有会话都会按步数线性爆。
   - **累积量**（af2 实测 + misc §0.5 换算）：单条 append ≈ **458 字符 / 510 字节**；有快照的请求 prefill **191–194 tok**、
     无快照 **49–50 tok**（净 **+142 tok**）；prompt 增量 +244 vs +51（净 **+190 tok 上下文**）。
     MC 39 步/轮 ⇒ 不节流约 **+7.2K tok 上下文/轮、+5.4K prefill tok/轮**；节流后 ≈ **+190 / +142**。
   - **实现（turn 级缓存 + 事件 dirty）**：同一 turn 内各 step 复用第一份 facts 文本（≤1 条快照/轮）；
     dirty → **下一步必刷新（stale ≤ 1 步）** 的来源有：
     1. focus enter/leave/换焦点（`focus.onChange`）；
     2. delivery 发出（time 的 sleep/wake 等**通知类**事件走 `tick`）；
     3. **turn 内模型自己改事实的工具**：`tool/result` 名命中白名单 `time_*` / `memo*` / `lexicon_learn`
        （`time_arrange/edit/cancel/pause/resume/mute/unmute`、`memo*`、`lexicon_learn`；白名单见 `bridge.isFactsTool`）。
     **stale 边界**：以上三类 stale ≤ 1 步；**silent schedule（走 `signals.emit` 不走 delivery，如 `dream:nightly`）**
     与非白名单工具不置 dirty，允许陈旧到轮末；**MC 环境事实**按豁免允许整轮陈旧。
   - **豁免（不是 bug）**：MC 环境事实（位置/血量/背包）允许**整轮陈旧**，以 `mcb_status`/`mcb_inventory` 为准；
     换来 MC 回合不再每步追加一条快照。bridge 代码里已写明。
   - **DSH 侧有没有更干净的方式**：本版本 `RuntimeContextProjection.project()` 只产出 append 消息，没有 replace API
     （只有系统提示词投影有 replace 分支），所以只能在 ICL 侧节流；将来 DSH 支持快照 replace 可以去掉节流。
   - **本地 A/B（同一 commit/scenario，2026-11-05 19:16–19:30）**：`cache-throttle-on`（默认）vs `cache-throttle-off`（`ICL_FACTS_EVERY_STEP=1`）：
     facts 快照 **6 vs 7 条**（2705 vs 3163 字符）、prefill **9312 vs 9445 tok（-1.4%）**、**hit% 都是 91.2%**、全量失效都只有首轮冷启动 1 次 →
     **节流不破坏前缀，方向非回归**（本 scenario facts 每轮只变一次，收益小；step-heavy 的收益见 mc-lab `L1`：27 步 5 条快照）。
     复算：`node tools/cache-probe.mjs compare --a cache-throttle-on --b cache-throttle-off`。

   - **测量口径（misc §0.5.5 提醒）**：bridge 单测断言的是 **provider 层 `stats.factsRefreshes`**（facts 文本重算次数），
     **不是 DSH 实际 append 的快照条数**；`stale ≤ 1` 的完整证据 = fake ctx（provider 层）+ lab 冒烟（DSH 层 append/turn）。
     单测清单：同一 turn 5 次求值 = 1 次刷新；focus enter/leave 各 +1 且内容含新焦点；`time_arrange` 工具结果 →
     下一步快照含新安排；只读工具不重置节流；delivery 通知 → +1 次刷新；`factsEveryStep` 关闭节流时每步刷新。
     lab 冒烟：`cache-throttle-smoke` 3 轮 **每轮 1 条快照**、system 零 replace（DSH 层 append/turn ≤ 1）。
   - **hit% 口径**：节流冒烟两组都是云端 `deepseek-account`（没有引擎 `cache-probe-engine.jsonl`），**云端不可测 hit%**；
     本地 hit% 由 `cache-bf2`/`cache-af2` 的本地 A/B 证明，节流只减少 append（方向非回归）。**同场景本地 A/B 已复核**
     （`cache-throttle-on` vs `cache-throttle-off`，同 commit `8ea32d6`）：hit **91.2% vs 91.2%**、prefill **9312 vs 9445（-1.4%）**、
     全量失效各 1（首轮冷启动）；详见 §5.4 与 AUDIT §0.5.5/§0.5.6。
   - **开关**：默认节流；`factsEveryStep: true`（config）或 `ICL_FACTS_EVERY_STEP=1`（env，**仅测量**）可退回每步求值。

---

## 8. 事实层字节基线（与 misc/lead 对表）

| 项 | 数值 | 来源 |
|---|---|---|
| ICL 系统段（旧布局，host 级） | 2518 字 / **6190 字节**（persona 782 + sim 1399 + world 82） | misc `AUDIT-2026-11-05.md` §1 |
| 其中人格 `persona` | 782 字 | 同上 |
| 其中仿真 `icl:simulation` | 1399 字 | 同上 |
| ICL 工具 description 合计（42 个） | 7835 字节 | 同上 |
| ICL 工具 parameters 合计 | 9172 字节 | 同上 |
| 完整工具 schema JSON | **27405 字节** | 同上 |
| lab icl-lab preset（32 工具）toolsChars | 17130 字符 | lead/misc lab run |
| DSH 运行时上下文（sandbox+approval） | 390 字符 | 本文件 lab run |
| 端到端 system（旧布局，lab） | 5117–5139 字符（≈8.6KB UTF-8） | lead/misc + 本文件 |
| 无 focus 时首差异 | 2205/2518 字（尾部 world 段时间行） | misc |
| 有 focus 修复前 | firstDiff=1（focus order 15 在最前） | misc |
| 有 focus 修复后（order 875） | firstDiff=2183/2518 字 | misc |
| B 之后 lab system（静态段） | **4978 字符 / 8408 字节**（无事实） | 本文件 cache-af2 |
| 事实快照消息（变化时追加） | 首条 465 字符，稳态 458 字符；7 条/12 步累计 3213 字符 | 本文件 cache-af2 |
| **B 拆分体积守恒**（host 级，只读复算） | 静态段（order<800）= **2181 字 / 5605 字节**（跨时间/跨 focus 完全不变）；事实段（order≥800）= **73 字 / 123 字节**（有 focus 89 字、5 分钟后 96 字）；两段 + `\n\n` = **2256 字**，与旧单段布局一致 → 无体积回归 | misc §0.4（wt/misc `54b31ff`） |

---

## 附录 A：证据路径

- 本文件：`docs/CACHE-MODEL.md`
- 工具：`tools/cache-probe.mjs`（引擎指标 + lab A/B）、`tools/cache-log.mjs`（DSH 会话日志只读）
- 场景：`tools/scenarios/cache-facts-6.json`（缓存 A/B 专用）
- 引擎请求日志：`C:\DSH\moe_streaming\logs\ninfer-coder390-q3-df2-4x500.requests.jsonl`
- lab 产物：`.state/lab/cache-bf2/`（before）、`.state/lab/cache-af2/`（after）——各含 `cache-probe.json`/`cache-probe-engine.jsonl`/`events.jsonl`/`rounds.jsonl`/`cache-diff.jsonl`
- 真实会话样本：`~/.dsh/sessions/--C-DSH-icl--/session-737ec994-…/session.v4.jsonl.zstd`
- 关键 commit：B 实现 `ff44c00`（wt/cache），文档 `c06ad2c`，合并 master `d1574d5`；对照基线 `fa890ab`（focus 修复前）、`2375080`（focus 875）、`4499e8b`（提示词分层）。
- 合并后 sanity：`.state/lab/cache-sanity-cloud/`（云端 3 轮，system 1 append / facts 快照含 icl:facts）。

## 附录 B：改提示词/layout 的自检清单

1. 这条内容会**每轮/每分钟变**吗？会 → 放 order ≥ 800（facts），或走 `pre-step` 的 `<icl-context>`。
2. 这段文本里有没有随机量/id/毫秒时间戳？有 → 挪到段尾或去掉。
3. 这段是"当前事实"还是"该怎么用工具"？后者 → 工具 description / skills，不进 system。
4. 我新加的段是不是在 order < 800？那它必须**整场不变**，否则缓存全废。
5. 改完跑一次 `node tools/cache-probe.mjs run … --gap 65 --rounds 6`，看 `firstDiff=-1`、`hit≈100%`。
