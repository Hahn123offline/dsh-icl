# renderTail A/B 结果（C）· 2026-11-07

> 结论先行：**本场景（非 MC 生活场景）收益不明显，不达验收线，不建议产品启用**。实现保留 lab-only、默认关；C 是否只在 MC 场景有效，本轮**无法验证**（lead 明确不跑 MC）。
> 实验：icl-lab（非 MC）14 轮固定场景，baseline（`ICL_RENDERTAIL=0`）vs tail-on，端口 57109；同模型 deepseek-flash；lab-in/out 全程由 mc-lab 协调，未跑 MC、未碰 desktop。证据在 `.state/lab/tail-ab2-base`、`.state/lab/tail-ab3-on`（gitignored）。
> 场景：`tools/scenarios/render-tail-ab.json` 前 14 轮（安排/查看/修改提醒、remember、album_status）；审计：`tools/render-tail-audit.mjs`。

## 1. 主结果（同一轮 14 轮，04:28–04:35）

| 指标 | baseline | tail-on | 变化 |
|---|---|---|---|
| 工具调用总数 | 19 | 18 | -1（-5.3%） |
| **状态类调用**（status/list/inventory） | **10** | **9** | **-1（-10%）** |
| 状态类/100 工具 | **52.6** | **50.0** | **-2.6pt（相对 -4.9%）** |
| 工具结果字符总数 / 平均 | 1,567 / 82.5 | 1,644 / 91.3 | **+77（+4.9%）** |
| turn-gap p50 / p95 | 10,264 / 10,338 ms | 10,146 / 10,314 ms | 基本不变 |
| 投递消息字符 | 2,698 | 2,690 | -0.3% |
| assistant 消息数 | 19 | 19 | 不变 |

**验收线（设计 §7）**：状态类调用/100 工具 **↓≥50%** → 实际 **↓4.9%**，**不达标**；结果字符 **↑≤10%** → +4.9%（达标）；step/turn-gap 不升 → 通过。

## 2. 早期探索轮（03:10–03:16，tail 只有时间/醒着）

| 指标 | baseline | tail-on |
|---|---|---|
| 工具/状态 | 23 / 14（60.9 per100） | 19 / 10（52.6 per100） |
| 结果字符 | 2,321 / 100.9 avg | 1,642 / 86.4 avg |
| tail 条数 | 0 | 9（仅 `〔状态｜03:13 · 醒着〕`） |

早期轮看似状态调用 -28.6%，但 tail 内容只有"时间+醒着"，且样本小；补强"下一安排"后（§1）差异缩小到 -10%，说明**大部分差异是轮次/模型波动，不是 tail 的稳定效果**。

## 3. tail 实际内容与去向（tail-on 9 条，全部时间/下一安排）

```
〔状态｜04:32 · 醒着 · 下一04:37〕
〔状态｜04:33 · 醒着 · 下一04:37〕
...
```

- 本场景 time 只有 schedule，没有 focus/goal/backlog（均为空）；icl-lab 无 MC → tail 没有 `MC` 字段。
- 9 条只 append 在 `time_arrange/remember/memo` 等动作结果（denylist 把 time_status/time_list 挡掉），所以：
  - `time_list` baseline 5 → tail 3（少了 2 次）；
  - 但 `album_list` +1、`time_status` 3 不变、`focus_status` 1 不变；
  - **模型仍然每次要清单细节时调 `time_list`**（tail 只有"下一 04:37"，不含完整清单）。
- 引文（transcript seq，见 run events）：
  - baseline turn 9：`"刚好 4 条，没超过 4 条，所以没动。04:30 喝水、04:41 休息…"`（来自 time_list 明细）
  - tail-on turn 12：`"4 items, not more than 4. So no cancellation. 正好 4 条，不超过 4，所以没动。- 04:37 喝水…"`（仍在读 list 结果）
  - tail-on turn 14：`"建好了：pause-test，05:05。现在五条了——04:37 喝水…"`（继续依赖 list 明细）
  - 3 条原话都说明：**tail 没提供她当时需要的信息（完整清单/目标/焦点）**，所以查询照旧。

## 4. 为什么没效果（根因）

1. **tail 信息维度不匹配**：她的状态查询主要在问"完整清单/细节"，tail 只有"时间+下一安排"；`mcb_status` 类需求（位置/血/任务）本轮根本没有 MC。
2. **append 位置在动作结果后面**：她要先决定"查状态"才会调 `time_list`；tail 只在动作之后出现，无法阻止"先查再动"。
3. **场景显式要求看清单**（"列出安排/看看几条"），这不是"缺状态"而是任务本身；tail 不能替代任务要求的输出。
4. **样本小**：14 轮、状态调用 10 次；-1 次在噪声范围内；早期 -28.6% 与补强后 -10% 的摆动也说明不稳定。
5. 缓存安全通过：只 append tool result，未改 system/facts/tools schema（cache 侧仅记 tool result 平均长度变化）。

## 5. 适用/不适用结论

| 场景 | 结论 |
|---|---|
| **非 MC 生活场景（本轮）** | **不适用/收益不明显**：状态查询 ↓10%，未达 ≥50%；tool result chars +4.9%；turn-gap 不变。 |
| **MC 场景（未测）** | 理论上更有希望：E2 里 `mcb_status` 125/764=16.4%，`mcb_do` 435 次会带 tail；若 tail 含"位置/血/任务"可能减少 `mcb_status`。但本轮 lead 明确不跑 MC，**不能下结论**。 |
| 产品化 | **不启用**；实现保持 lab-only 默认关。若未来在 MC lab 复测，需同时满足：tail 含 MC 状态、动作类工具占比高、状态调用基线 ≥20%。 |

## 6. 建议

1. **C 暂不产品化**；保留 `renderTail` lab 开关作为实验能力（默认关，产品 preset 不写）。
2. 若 MC 恢复长跑，用同样场景/审计在 **icl-mc-lab** 复测，tail 增加 `MC 位置/血/任务` 后再看 `mcb_status` 是否 ↓；本轮不跑 MC，避免与 L2 冲突。
3. 若目标只是"少查状态"，更有效的可能是 **B（渐进式唤醒/提示）** 或直接教她"动作后再查"（提示词/教学），而不是塞 tail；tail 的边际收益在信息劣势场景为负（增加结果字符）。
4. 当前实验代码/开关保留，回滚=lab preset `renderTail.enabled:false`（产品本来就没有）。

## 7. 复现

```powershell
cd C:\DSH\icl-wt\misc
$env:ICL_RENDERTAIL='0'
node tools/lab.mjs up --preset icl-lab --port 57109 --run tail-ab-base --model flash
node tools/lab.mjs script --file tools/scenarios/render-tail-ab.json --rounds 14 --gap 10 --timeout 180
node tools/lab.mjs down
Remove-Item Env:\ICL_RENDERTAIL
node tools/lab.mjs up --preset icl-lab --port 57109 --run tail-ab-on --model flash
node tools/lab.mjs script --file tools/scenarios/render-tail-ab.json --rounds 14 --gap 10 --timeout 180
node tools/lab.mjs down
node tools/render-tail-audit.mjs --run .state/lab/tail-ab-base
node tools/render-tail-audit.mjs --run .state/lab/tail-ab-on
```
