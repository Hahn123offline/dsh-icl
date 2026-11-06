# E2 阻塞：lab 里 ICL 工具面整体注册失败（dsh 0.2.0-rc.2 × 新 output schema）

> 发现时间：2026-11-06 10:30–11:20（本机）。状态：**已定位到一行根因，修复待 core/lead 决定**。
> 影响：E2 S1/S2 无法开始（lab 会话没有 ICL 工具，模型看不到 `remember/time_arrange/mcb_*` 等）。

## 1. 现象

- 合并 master（`e51c877`）后，`lab.mjs up --preset icl-lab` 会话的 `request/header` 只有 **8 个工具**：
  `edit, glob, grep, pwsh, read, read_image, todo_write, write`（即 preset 里的原生 fs/pwsh 工具）；
- 系统提示词仍是 ICL 人格（`你是小千。`，3570 字符，purify 生效）→ ICL host 插件已加载，但 **bridge 没有把任何 ICL 工具注册进 DSH**；
- 对照：合并前（`e260752`）同命令 tools=41（含 `remember/recall/time_arrange/mcb_*`），dream 槽验证正常；
- 结果：模型如实回答"`time_arrange` is not in my tool list"，只能调用 `glob` 等文件工具。

## 2. 已排除

| 假设 | 实验 | 结论 |
|---|---|---|
| web profile 被改坏 | `cordis.patch.yml` 与 11-05 备份 hash 完全相同（`9FCA…`） | 排除 |
| 我们注入的 `providers` 破坏 boot | `e2-slot-test2` 已在 providers 下跑通（41 工具 + remember 调用） | 排除 |
| album/video 插件导致 | 去掉 preset 里 `album/video` 后仍只有 8 工具 | 排除 |
| bridge/plugin/config 代码回归 | `packages/dsh-icl/src` 整体回退到 `e260752` 后仍只有 8 工具 | 排除 |
| preset 模板回归 | 用 `e260752` 的 `lab.patch.yml` 仍无 ICL 工具 | 排除 |

## 3. 根因（bisect 结果）

`packages/core/src` 是唯一相关变更：**整体回退 `packages/core/src` 到 `e260752` → tools=54（含 `remember`）**。
进一步最小化：

- 保留新 core、只把 `packages/core/src/dsh-contract.mjs` 的
  `toDshToolDefinition` 里 `output.schema: IMAGE_OUTPUT_SCHEMA` 改为 `TEXT_OUTPUT_SCHEMA`
  → **tools=54，`remember` 出现，lab 恢复正常**。
- 即：**新增的 `IMAGE_OUTPUT_SCHEMA`（`images: {type:'array', items:{type:'json'}}`）被当前安装的 DSH 0.2.0-rc.2 拒绝**，
  而且 `ctx.tools.register` 的失败在 bridge 里只进 `report()`（日志未落盘），所以表现为"所有 ICL 工具静默消失"。

证据：`.state/lab/e2-probe-*/`（每份含 `events.jsonl` request/header 的 tools 列表）与对应 `lab.json.commit`；
实验命令见本文件底部。

## 4. 修法建议（三选一，需 core/lead 拍板）

1. **兼容（推荐，改动小）**：`toDshToolDefinition` 对有图片能力的工具先按 `TEXT_OUTPUT_SCHEMA` 注册（图片仍可通过文本提示/附件另路回传），
   或在 register 失败时**自动回退**到 text-only schema（bridge 层 `syncTools` catch 后重试一次）。
   这样旧 DSH（0.2.0-rc.2）和未来新 DSH 都能跑。
2. **能力探测**：启动时用一次 dummy `ctx.tools.register` 探测是否接受 `type:'json'`，再决定 image schema，失败则 text-only。
3. **升级 DSH 运行时**到支持该 output schema 的版本（涉及用户桌面环境，风险最高，不推荐今晚做）。

## 5. 复现/验证命令（只读式）

```powershell
# 正常（坏）：tools 8
node tools/lab.mjs up --run probe-bad --preset icl-lab --model flash
node tools/lab.mjs say "你好" --run probe-bad --wait --timeout 60
# 看 events.jsonl 的 request/header.tools

# 修复验证：把 packages/core/src/dsh-contract.mjs 中
#   schema: IMAGE_OUTPUT_SCHEMA  ->  schema: TEXT_OUTPUT_SCHEMA
# 再 up/say → request/header.tools 应 54（含 remember）
```

## 6. 对 E2 的影响

- 在修复前，S1 2h / S2 24h **不能开始**（lab 会话无法调用任何 ICL/MC/time 工具；dream 槽即便已绑定也无意义）。
- lab providers（commit `34b450a`）与 mc-quality（`34b450a`/`98cf6bc`）本身已验证；只等本阻塞解除。
