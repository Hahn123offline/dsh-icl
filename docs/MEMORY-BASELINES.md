# 记忆评测基线（2026-11-12，第 14 轮）

> 目的：给"每次改动是否有净收益"一个可复现的对照面。所有数字都来自仓库里的 eval harness
> + `.state/lab/memory-corpus/` 里的三源真实 fixture（真实对话，不入库）；命令见本文件末尾与
> `docs/MEMORY-PHASE2-REPORT.md` §4。

## 1. 三源同-run 基线（cache 复用 formation，只重跑 retrieval）

| 素材 | probes(withExpected) | r1 | r3 | r5 | MRR | miss | falseInjection | raw falseInjection |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| real-focuscore-2026-10 | 19 (16) | 34.4% | 84.4% | **96.9%** | 0.619 | **0%** | 0% | 0% |
| real-qq-2026-10 | 14 (8) | 62.5% | 79.2% | 79.2% | 0.750 | 16.7% | 100% | **0%**（judge 判"提到但没答"） |
| real-live-2026-11 | 8 (8) | 83.3% | 91.7% | 91.7% | 0.889 | 0% | 50% | **0%**（judge 判"提到但没答"） |

- formation（同一批缓存）：focus extracted 198 / matched 26 (R 81.3%)；QQ 79 / 18 (R 90%)；live 172 / 4 (R 100%，gold 只有 4 条)。
- `raw falseInjection` 是 `tools/memory-answer-adequacy.mjs` 的结论：三源所有"负例返回"被 judge 判为
  「只提到相关话题、没有回答」→ 记忆系统没有把相关记忆当成答案宣称，原始 falseInjection 高估了问题。

## 2. 运行间方差（当前代码 3 次 `--fresh` 独立运行）

### focus-core

| run | formation R | e2e r1 | r3 | r5 | miss | falseInjection |
|---|---:|---:|---:|---:|---:|---:|
| A | 78.1% | 56.7% | 83.3% | 93.3% | 6.7% | 0% |
| B | 81.3% | 50.0% | 63.3% | 76.7% | 20.0% | 0% |
| C | 81.3% | 37.5% | 68.8% | 75.0% | 25.0% | 0% |
| D（gate 验证 run） | ≥75% | 28.1% | 84.4% | 84.4% | 12.5% | 0% |
| **均值（A–C）** | **80.2%** | **48.1%** | **71.8%** | **81.7%** | **17.2%** | **0%** |
| 极差 | 3.2pt | 19.2pt | 20.0pt | 17.5pt | 18.3pt | 0 |

> 结论：formation 稳定（78–81%）；端到端 r5 均值 81.7%、极差 17.5pt。**单次数字必须带方差读**，
> 门控用 3 次均值，不拿一次 cache-only 的 96.9% 当常态。

### old-qq

| run | formation R | r1 | r3 | r5 | MRR | miss |
|---|---:|---:|---:|---:|---:|---:|
| A | 85.0% | 63.6% | 63.6% | 63.6% | 0.727 | 27.3% |
| B | 85.0% | 31.8% | 63.6% | 63.6% | 0.558 | 27.3% |
| C | 85.0% | 50.0% | 68.2% | 68.2% | 0.636 | 27.3% |
| **均值** | **85.0%** | **48.5%** | **65.1%** | **65.1%** | 0.640 | **27.3%** |
| 极差 | 0pt | 31.8pt | 4.6pt | 4.6pt | — | 0pt |

### real-live

| run | formation R | r1 | r3 | r5 | MRR | miss |
|---|---:|---:|---:|---:|---:|---:|
| A | 100% | 50.0% | 66.7% | 66.7% | 0.604 | 33.3% |
| B | 100% | 50.0% | 83.3% | 91.7% | 0.672 | 0% |
| C | 100% | 66.7% | 83.3% | 91.7% | 0.792 | 0% |
| **均值** | **100%** | **55.6%** | **77.8%** | **83.4%** | 0.689 | **11.1%** |
| 极差 | 0pt | 16.7pt | 16.6pt | 25pt | — | 33.3pt |

- QQ 的 r3=r5（正确块进 top3 一般也在 top5）、r1 方差最大；live 的 miss 方差大（0–33%），
  与 gold 只有 4 条、单条 miss 权重高有关。

> 第 16 轮 gold/probe 修整后（m-0013 类型修正 + p-08 问法），QQ 同-run（cache 复用同一次 formation）
> 变为 r1 68.2% / r3 68.2% / r5 68.2%、withExpected 11；上表 3 次 fresh 是修整前的值，修整后 fresh 待重跑。


## 3. 门控（已落地为 `--gate-preset`）

```
formation.recall>=0.75
retrieval.recallAt3>=0.65
retrieval.recallAt5>=0.75
retrieval.missRate<=0.25
retrieval.falseInjectionRate<=0
```

用法：

```powershell
node tools/memory-eval.mjs --fixture <fixture> --mode all --seed formation --model cloud --profile raw-main --embed `
  --fresh --gate-preset focus        # focus / qq / live 三套预设；--gate 显式值优先
```

- `--gate-preset focus|qq|live` 对应上面的三源阈值，不通过 exit 3 并逐条打印未过指标。
- 已实测：fresh run（r5 84.4%、miss 12.5%、falseInjection 0、formation recall≥0.75）通过，exit 0。
- QQ 预设：`formation.recall>=0.75,retrieval.recallAt5>=0.70,retrieval.missRate<=0.35`；
  live 预设：`formation.recall>=0.75,retrieval.recallAt5>=0.80,retrieval.missRate<=0.25`。

## 4. 有效性与失效链（合成偏好变化 fixture，fresh run）

- typed：live **104** / superseded **24**；悬空 `supersededBy` **0**、缺失 `invalidatedAt` **0**
  （`tools/memory-audit.mjs --db <tmp>/state/memory.db`）。
- 失效链样本可在 `audit.md` 的「typed 旧值失效链」逐条复核（后继均存在）。
- 模型 validity 会漏掉部分"旧偏好被否定"（咖啡→豆浆实测漏一次），第 14 轮新增
  **确定性兜底**：同类型 + 旧记录更早 + 新陈述含否定词（不/没/不再/戒/停/别）+ 共享非通用内容 bigram
  → 软失效旧记录（每天≤2 条，日志 `dream.validity-invalidated-deterministic`，单测覆盖）。

## 5. 复跑命令

```powershell
$env:DEEPSEEK_API_KEY=[Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY','User')

# 同-run 三源（复用已有 formation 缓存；--fresh 则重算）
node tools/memory-eval.mjs --fixture .state/lab/memory-corpus/real-focuscore-2026-10 `
  --mode all --seed formation --model cloud --profile raw-main --embed --out .state/lab/lead/eval-focus-r6f

# 3 次方差
node tools/memory-eval.mjs --fixture .state/lab/memory-corpus/real-focuscore-2026-10 `
  --mode all --seed formation --model cloud --profile raw-main --embed --fresh --max-calls 320 `
  --out .state/lab/lead/eval-focus-r14varA

# 负例 answer-adequacy（judge）
node tools/memory-answer-adequacy.mjs --eval .state/lab/lead/eval-focus-r6f/eval.json `
  --out .state/lab/lead/answer-adequacy

# 失效链审计（对一次 keep-temp 的 formation 临时库）
node tools/memory-audit.mjs --db <temp>/state/memory.db --out .state/lab/lead/audit-pref-r14
```
