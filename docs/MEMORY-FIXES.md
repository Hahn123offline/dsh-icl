# 记忆/检索修复（红队 D1 + D2 + D4）· 语义与验收 · 2026-11-06

> 对应：`REDTEAM-REVIEW.md` D1（回忆没有"没找到"）、D2（记忆可改可删/确认语）、D4（remember 与 memo 同句）。
> 范围：`packages/plugins/recall`、`packages/plugins/memory`（**未改 core、未改 dsh-icl bridge**）。
> 约束：不影响 cache 的静态 system / facts 布局（只改工具行为与 description；`toolsHash` 会变，属预期）。

## 0. 一句话

回忆现在**会说"没找到"**（并说清检索了多少条/什么范围/下一步），不再拿未整理笔记凑数、不再对空结果 boost；
`remember` 返回**可用的 key/id**，`forget` 能用 key 或 id 删，确认语区分"记下了 / 改掉了 / 删掉了 / 没找到要删的"，
纠正走 `kind=resolve`（在 remember/forget 的返回里可发现）。

## 1. D1：回忆的"没有"必须是诚实的

### 1.1 改法

| 问题（评审时） | 现在 |
|---|---|
| `memory.search` 不过滤相关度 → "总能找到六条" | `memory.search` 本来就丢 `sim<=0`；本次**额外返回 `sim`**，recall 再按相关度下限过滤：有嵌入 `minSim=0.35`（混合相似度），无嵌入 `minSimNoEmbed=0.2`（query 二元组覆盖率）；`cursor` 继续翻时放宽到 0.05（"再想想"不能因为淡了就翻不出） |
| **未整理笔记不管问什么都先塞一半配额**（红队 D3 同源） | 有 query 时，未整理笔记也必须过同一相关度下限（无 query 的"最近"视图不筛） |
| 零相关也 `boost`（"回忆成功"回鲜） | 只对真正 `picked`（过滤后）的条目 boost；空召回/全不相关不 boost（测试断言 `lastRecalledAt` 不变） |
| 过滤全空 → "没有想起什么。（也没记过。）"（全局假否定） | 分三种"没有"，见下表 |

### 1.2 三种"没有"的文案（可判定）

| 情形 | 判据 | 文案骨架 |
|---|---|---|
| 范围里有候选但都不够相关 | `searchedCount > 0` 且无 picked | `没找到相关记忆：检索了 N 条（范围：…，关键词「…」），都不够相关。要不要换个说法、去掉 tag/会话过滤，或用 cursor 继续翻更早的？` |
| 范围过滤后为空、但全局有记忆 | `searchedCount==0` 且 `memory.stats().items>0` | `这个范围里没有相关记忆（全局还有 M 条，可能是 … 过滤太窄；去掉限制再试一次？）` |
| 全局真的空 | `stats().items==0` | `记得的东西还是空的：一条记忆都没有过。要我现在记点什么吗？` |
| 相关候选都在 cursor 窗口里 | `anyKnown` 且 picked 空 | 保留原文："这几条刚才已经给过你了……" |

`searchedCount` = 候选检索条数 + 未整理笔记条数（**诚实口径**：是"这次翻到的候选"，不是 DB 全表行数）。

### 1.3 可配置

`recall.config.minSim`（默认 0.35，有嵌入时用）、`recall.config.minSimNoEmbed`（默认 0.2）。与 `eager-recall` 的
`minScore/minScoreNoEmbed` 是两套：eager-recall 在**注入层**用 score 阈值，recall 在**工具层**用 sim 阈值（语义更稳，不受权重/衰减影响）。

## 2. D2：记忆要能改、能删、能纠正

| 操作 | 现在 |
|---|---|
| `remember` | 返回 `记下了（key=…，id=…）。以后要删用 forget {key}，要纠正用 kind=resolve。`；带已有 key 重写 → `改掉了（key=…）。`；`kind=resolve` → `已记下这次纠正（key=…），整理时按它改。` |
| `forget` | 接受 `key` 或 `id`（或两者）；成功 → `删掉了（key=…/id=…，类别）。`；没找到 → `没找到要删的：… 里没有 …。先用 recall 找到它再删，别乱猜；如果只是想纠正而不是删，用 remember {kind:'resolve', about:{namespace, key}}。`；两者都没给 → 可操作提示（不是静默/抛错） |
| 纠错通道可发现 | `remember.description` 写明 `kind=resolve` + `about.namespace/about.key`；`forget` 的 miss 文案直接给出 resolve 示例；`forget.when` 增加"纠正"场景 |
| `memo`（note 插件，D4 另一半） | **本轮未改**（不在 recall/memory scope）：`memo` 仍回"记下了"，与记忆的"记下了（key=…）"已能区分（带 key）；建议下一轮把 note 的确认语改成"记在待办里了"（note 插件单独小改） |

## 3. 对 cache 布局的影响（已按 lead 要求先声明）

- **静态 system / facts：零变化**。没有新增/删除 system section、没有改 facts 快照、没有改 bridge。
- **工具面**：`remember`/`forget`/`recall` 的 **description** 有改动 → `toolsChars`/`toolsHash` 会变（预期，不是回归）；**工具数不变**（仍 34）。
- 记忆检索文本只出现在工具返回里，不进 runtime-context facts。

## 4. 测试

新增 `packages/core/test/recall-honesty.test.mjs`（10 条）：
1. remember 返 key → forget(key) 删掉 → 再删给"没找到+下一步"
2. remember 带 key 改写 → "改掉了"
3. forget 按 id 删除
4. forget 缺 key/id → 可操作提示
5. 无关 query 不凑数、不 boost（`lastRecalledAt` 不变）
6. 未整理笔记不再无条件塞配额
7. 范围过滤为空但全局有记忆 → 不说"也没记过"、说"全局还有 1 条"
8. 全局真空 → "一条记忆都没有过"
9. 相关 query 仍能召回（回归）
10. cursor 第二次 → "已经给过"，不重复不假装没找到

既有套件：`recall.test.mjs` + `eager-recall.test.mjs` 15/15 通过；全仓 `npm test` → **545/545**。

## 5. 已知限制 / 下一轮

- `minSim` 阈值在**有嵌入**环境下的最优值未做真实 embedding 校准（本轮无 GPU/lab）；当前值偏保守（宁缺毋滥），后续可用 `docs/quality` 的召回评测脚本标定。
- "检索了 N 条"是候选条数，不是 SQL 扫描行数；如果要精确扫描数，需要 memory.search 返回 `scanned`（改动更大，暂不做）。
- `recall` 的 `overview=true` 路径（按时间列最近）不走向量/相关度，保留原语义（那时 query 为空）。
- `memo`/`remember` 两套"记下来"的**命名合并**仍未做（红队 D4 的结构部分），属产品决策。
