# 第一屏净化（红队 P0-1）· 改前 / 改后 · 2026-11-06

> 读者：lead / 用户 / cache（复核方）。目标：ICL 会话的**静态 system prompt** 从工程脚手架占多的
> "coding-agent 首屏"变成"她自己的生活说明"，且不破坏工具调用、缓存布局与 facts 语义。
> 范围：只改 **lab preset**（产品 preset 未动，产品化需用户批准）。证据：两次真实 lab run（云端 deepseek-flash，57109）。

## 0. 一句话

`system prompt 5011 → 2294 字符（-54%），persona+sim 占比 43.5% → 96.3%，首行从
"You are an AI agent powered by DeepSeek Harness." 变成 "你是小千。"；工具面 34 个/toolsHash 不变，
5 轮里 8 次工具调用 0 错误；facts 仍全部走 runtime-context 快照（3 条，415/450/415 字符）。`

## 1. 改前：静态 system 里有什么（r5 / `firstscreen-base`）

| # | 段名（DSH scope 名） | 字符数 | 占比 | 归属 | 处置 |
|---|---|---|---|---|---|
| 1 | `harness:identity` | 50 | 1.0% | `@deepseek-ai/dsh-system-prompt` 全局 | **shadow 掉** |
| 2 | `icl:core`（persona 782 + sim 1399 + 分隔） | 2208 | 44.1% | ICL 自己的静态段 | 保留（**本体**） |
| 3 | `ui:deliverable-file-references` | 1335 | 26.6% | `dsh-client-ui-deliverables`（Markdown/Office/present/file-link 规范） | **shadow 掉** |
| 4 | `harness:source` | 368 | 7.3% | `dsh-app-boot`（仓库 checkout 路径与规则） | **shadow 掉** |
| 5 | `app:web-surface` | 994 | 19.8% | web app（GUI URL/HMR/`pnpm run dev:web` 等） | **shadow 掉** |
| 6 | `deployment:persona-suffix` | 83 | 1.7% | 宿主部署（cwd） | 保留（事实） |
| | **合计** | **5011** | 100% | | |

首行：`You are an AI agent powered by DeepSeek Harness.`；persona+sim 只占 43.5%，与红队观察一致。

## 2. 改后：`firstscreen-after`（同一 5 轮场景、同模型、同 preset 结构）

| 段名 | 字符数 | 占比 |
|---|---|---|
| `icl:core`（persona+sim） | **2208** | **96.3%** |
| `deployment:persona-suffix`（cwd） | 84 | 3.7% |
| ~~harness:identity / deliverable refs / harness:source / app:web-surface~~ | **0** | 0% |
| **合计** | **2294** | 100%（-54.2%） |

首行：`你是小千。`；`persona` 在 0，`cwd` 在 2210；**四段工程脚手架在文本中完全消失**。
字节：8485 → **5762**（-32.1%，中文字符 3 字节压缩比低于字符数压缩比）。

## 3. 机制（方案 A：同名空段 shadow，不用 complete:true）

DSH 安装包里 `SystemPrompt.section()` 的契约原文：
> *"A scoped section shadows a global section with the same name; duplicates within one layer throw."*

所以只要在**更深的 scope**（agent preset 的插件 ctx；失败则退到 `agent.ctx`）注册一个**同名、空文本**的 section，
全局那一段就被覆盖成空；渲染层跳过空段。我们只 shadow 这 4 个 DSH 段：

```js
// src/purify.mjs
export const PURIFY_CATALOG = {
  'harness:identity': -1000,
  'ui:deliverable-file-references': 9000,
  'harness:source': 10000,
  'app:web-surface': 10100,
}
```

- **没有**用 `complete:true`（会整段替换、丢掉工具调用指引）——代码与测试都断言影子段 `text===''` 且 `complete!==true`。
- **没有**碰 `icl:core` / `icl:facts` 的名字与 order：facts 仍由 `systemPrompt.context('icl:facts', order=850)` 提供，
  实测 run 里 runtime-context 快照 3 条（415/450/415 字符），与改前同量级。
- 不依赖宿主配置：`harness:identity` 也可以用 `dsh-system-prompt.config.includeHarnessIdentity:false` 关掉（等价、更"官方"），
  但那要改产品宿主配置（需用户批准）；本方案放在 preset 里，只影响显式配置的 preset。

## 4. 为什么安全（与 cache 的布局契约逐条对齐）

| 契约 | 证据 |
|---|---|
| 静态 system 仍然"整场不变" | 两次 run 都只有 **1 条 system/message**（seq 8），5 轮 0 重发 |
| 工具面不变 | 改前/改后 `tools=34`、`toolsHash=7047e6c4f3e8` 完全一致；`request/header` 各只 1 次 |
| 工具仍可用 | 5 轮：`time_status`、`focus_enter`+`write_file`(+`list_dir`)、`focus_status`、`world_status`、`focus_leave`；**toolErrors=0**（改前也 0） |
| facts 仍在 runtime-context | `runtimeContextSnapshots=3`（415/450/415 字符），改前 3 条（415/449/415） |
| 不 shadow ICL 段 | `first-screen.test.mjs` 断言目录只有 4 个 DSH 段、且产品 preset 不含 `purifySections` |
| 失败可见 | preset ctx 注册失败 → `icl.purify` 日志列出 failed → 切到 `agent.ctx` 重试；仍失败则留 pending（不静默） |

## 5. 代码与配置（全部在 `packages/dsh-icl/`）

| 文件 | 改动 |
|---|---|
| `src/purify.mjs`（新） | `PURIFY_CATALOG` + `resolvePurifySections()` + `registerPurifyShadows()`；只注册空段，失败按段记录 |
| `src/config.mjs` | `purifySections`（数组，默认 `[]`；产品行为不变） |
| `src/plugin.mjs` | boot 里注册影子（preset scope）；`agent/created` 对失败段用 `agent.ctx` 重试；dispose 时撤销；`icl.purify` 日志 |
| `presets/lab.patch.yml` | **仅 icl-lab preset** 加 `purifySections: [4 个段]` |
| `packages/core/test/first-screen.test.mjs`（新） | 6 条：目录/解析/空段/不静默/preset 边界/插件两段式重试 |

`npm test` → **522/522 绿**（含既有 dsh-bridge 28 条、audit-regressions 等）。

## 6. 产品化（desktop）需要用户批准的点

1. 把 `purifySections` 加进**产品 preset**（`presets/icl.patch.yml` 的 `preset-icl`；mc/loop 是否同步看用途）——
   这会让真实桌面会话也少了那 4 段（工作区/仓库/GUI 说明）。当前**只开了 lab**，产品 preset 一行没动。
2. 另一种等价做法：宿主 `dsh-system-prompt` 配 `includeHarnessIdentity:false`（只去掉首行身份），
   其余 3 段仍需 preset shadow。两者都建议由用户先确认"她要的是生活，不是 coding-agent 首屏"。
3. 风险：去掉 `ui:deliverable-file-references` 后，如果她确实要交付 Office/图片文件，模型不再有那套
   "present/文件链接"指引；她的生活场景（聊天/刷 B 站/玩 MC）不需要它。若未来保留"做文件"能力，可只 shadow
   其余 3 段、保留 deliverable 段（配置里删一行即可）。

## 7. 回滚

- 最快：删掉 `presets/lab.patch.yml` 里 `purifySections` 的 4 行 → 下次 lab 启动即恢复 5011 字符首屏。
- 代码级：`purifySections: []`（config 默认）即可整体关闭，不需要回滚代码。
- 运行时：若某段 shadow 失败，`icl.purify` 日志有 failed 列表；把该段名从配置移除或等 DSH 改名跟进。

## 8. 复现命令

```powershell
cd C:\DSH\icl-wt\misc
# 改前基线（如果还没有）：git stash 或 checkout 旧 commit 后
node tools/lab.mjs up --preset icl-lab --port 57109 --provider deepseek-account --model deepseek-flash --run firstscreen-base
node tools/lab.mjs script --file %TEMP%\firstscreen-5.json --gap 0
node tools/lab.mjs down
# 改后：同上，run 名换成 firstscreen-after
# 分析：看 .state/lab/<run>/context/system-*.txt 的字符数/首行/四段是否还在；
#       rounds.jsonl 看 tools/toolsHash/turnMs；events.jsonl 数 tool/result isError。
```

## 9. 给 cache 的复核清单（三场景，CACHE-MODEL §7 附录 B）

我的验收 run 是**云端**（`firstscreen-base/after`，deepseek-flash），所以我能给到：
①**firstDiff**：两 run 都是 1 条 system/message（seq 8），相邻 turn system 恒定 → 预期 `-1`；
②**体积**：system 5011→2294 字符 / 8485→5762 字节（-54.2%/-32.1%），tools=34、toolsHash 不变；
③**facts 仍在 runtime-context**：快照 3 条（415/450/415），`systemHasDynamicFacts` 应为 false；
④**hit%**：云端无引擎日志，只能定性（静态段更小、且零重发，方向非回归）。若需要 hit%/prefill/TTFT 硬数字，
需要一次**本地** run（GPU 根锁，非我 scope）——按 night-1 同法按窗口切片即可。

## 10. cache 复核结果（cache，2026-11-06，只读，不占 GPU）

复核对象：misc 的云端 A/B run `C:/DSH/icl-wt/misc/.state/lab/firstscreen-{base,after}`（同 5 轮场景）。
复核工具（只读 `events.jsonl` / `context/system-*.txt`）：

```powershell
node tools/cache-layout-audit.mjs `
  --run C:/DSH/icl-wt/misc/.state/lab/firstscreen-base `
  --run C:/DSH/icl-wt/misc/.state/lab/firstscreen-after
```

| 场景（CACHE-MODEL §7 附录 B） | 改前 | 改后 | 判定 |
|---|---|---|---|
| ① 相邻 turn firstDiff | system 1 次 append、0 次 replace，system 文本恒等 | 同左（1/0、恒等） | ✅ **firstDiff=-1**（5 轮内 system 一个字节都没变） |
| ② 体积 | system **5011 字符 / 8485 字节**；tools 34 / `7047e6c4f3e8` / 18910 字符 | system **2294 字符 / 5762 字节**（-54.2% / -32.1%）；tools **34 / `7047e6c4f3e8` / 18910** | ✅ 静态段变短、工具面完全不变 |
| ③ facts 布局 | `systemHasDynamicFacts=false`；快照 3 条（415/449/415），sections=[sandbox:policy, approval:policy, **icl:facts**] | `false`；快照 3 条（415/450/415），sections 完全一致 | ✅ `icl:facts` 仍在 runtime-context（order 850 未动，`bridge.mjs:209` 核对）；≤1 条/轮（3/5=0.6）；`icl:core` persona+sim 保留 |
| ④ 命中（hit%/prefill/TTFT） | — | 云端 run 无引擎日志，**不可直接测** | ⚠️ 方向非回归（见下）；硬数字需本地 run + GPU 根锁 |

**实现核对（只读代码）**：`PURIFY_CATALOG` 只含 4 个**非 ICL** 段（`harness:identity` / `ui:deliverable-file-references` / `harness:source` / `app:web-surface`），
未 shadow `icl:core` / `icl:facts`，未用 `complete:true`；`purifySections` 只在 `presets/lab.patch.yml` 的 icl-lab 出现，`config.mjs` 默认 `[]`（产品 preset 未开）。

**命中为什么判"方向非回归"（定性）**：本次改动只缩短**静态前缀**，run 内 system 0 次重发、facts 快照条数/位置/sections 完全一致、toolsHash 不变；
也就是说每步请求的"append-only 增量"与改前同构，前缀稳定性没有变化，唯一变化是冷启动/每个请求的前缀更短（只会降低 prefill）。
**预期收益**：冷启动静态前缀少 2723 字节（-32.1% bytes），冷启动 prefill 同比减少（具体 token 数需本地实测）。
**待办**：要 hit%/prefill/TTFT 硬数字时，lead 排 GPU 根锁、用本地 `--model local` 跑同 5 轮场景，然后按 night-1 方法切片引擎日志（`tools/cache-longrun.mjs`）。
