# 记忆清晰度（P1，2026-11-11）

## 一句话

清晰度不是第二套衰减状态，而是从现有检索衰减 `decay` **推导出来的表达**。

```text
ageDays = now - (lastRecalledAt ?? createdAt)
decay   = exp(-ageDays / halfLifeDays)
score   = sim × weight × decay
```

同一份 `decay` 既参与排序，也决定召回时的措辞；没有新增字段、没有每日 job、没有额外模型调用。

## 档位

| decay | tier | 注入标签 |
|---|---|---|
| ≥ 0.75 | vivid | 不标 |
| ≥ 0.50 | clear | 不标 |
| ≥ 0.30 | fuzzy | `[有点模糊]` |
| ≥ 0.12 | trace | `[只剩印象]` |
| < 0.12 | forgotten | `[几乎想不起来了]` |

实际例子（`event` 半衰期 30 天）：

- 第 30 天 ≈ 0.37 → 模糊
- 第 60 天 ≈ 0.14 → 只剩印象
- 第 90 天 ≈ 0.05 → 几乎想不起来了

`person` 半衰期 180 天，所以人物事实不会按 30 天快速变模糊。

## 回升

只有**主动 `recall`** 会走 `memory.boost()`：

- `weight += 0.2`；
- `lastRecalledAt = now`；
- 下一轮同一个 `decay` 直接回到 vivid/clear。

`eager-recall` 是被动注入，不 boost，避免同一段记忆因每轮自动塞入而被无限强化。

## 边界

这版只做“表达诚实”，不做真正遗忘：

- 低 `decay` 仍可被 `recall` 翻出来；
- 不按年龄归档；
- `data.superseded` 仍是另一条软删路径；
- `lexicon` 的 aging 与 event/person 清晰度无关。

真正归档/停止主动注入是后续策略，不和本版混在一起。

## 实现位置

- `packages/plugins/memory/src/index.mjs`
  - `clarityOf(decay)`；
  - `memory.search()` 返回 `decay` 与 `clarity`；
- `packages/plugins/recall/src/index.mjs`
  - `renderEntry()` 加低清晰度标签；
- `packages/plugins/eager-recall/src/index.mjs`
  - 自动召回行加同样标签。

## 验收

- event 5/20/35/45/80 天分档正确；
- 主动 `boost` 后回到 vivid；
- recall / eager 都能出现低清晰度标签，新记忆不出现多余标签。
