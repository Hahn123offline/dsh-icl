# 记忆 Phase 2 报告（第 1 段）：raw 身份元数据 + typed v2 add 层 + 评测口径修复

> 2026-11-11 第 2 轮。承接 `docs/MEMORY-PHASE1-REPORT.md`。所有改动已在 HEAD（`70bb201`、`c6586cf`），
> 基线产物在 `.state/lab/lead/eval-focuscore-typed2/`（可 `--cache-only` 无密钥复跑）。

## 1. 本轮做了什么

### 1.1 bridge：raw 层补"谁在说、说给谁"（审计 R2/F5 的根）

- `packages/dsh-icl/src/bridge.mjs`：
  - 新增一次性"投递通知来源映射"：steer 与冷启动 `sessions.prompt` 前登记（文本 hash → plugin/QQ envelope），
    `appendRaw` 收到同文本的 `user/message` 时取走并写 `sourceKind`：
    QQ 通知 → `qq_envelope`，其它插件通知 → `env`，真人直聊 → `human`；assistant/tool 分别 `agent_visible`/`tool`。
  - QQ envelope（`entries[].source.meta.qq.envelope`）→ raw 行带 `channel`（`qq:private:<peer>` / `qq:group:<gid>`）
    与 `speaker { kind, value, name }`；冷启动未读摘要也能标记为 `qq_envelope`。
  - `packages/core/src/services.mjs`：delivery 非 gate 路径不再丢 `source.meta`（QQ 信封要走到 batch）。
- `dream.wash`：
  - raw 行带 speaker 时，day log 行首渲染成 `名字(QQ)`；有结构化 speaker 时剥掉正文里的 `[QQ私聊·主人] xxx：` 信封前缀；
  - day log 新增 `speakers`/`channels` 数组（绝对行号对齐；`formationLines/formationEntries` 改为按行号取 source/speaker，
    修掉"截断省略行后数组错位"的隐患）；
  - `jobPeople` 新增确定性说话人证据：有 QQ speaker 的行直接落 `person` note（subject=qq），人物档案不再依赖模型从文本猜人名。
- 回归：`packages/core/test/dsh-bridge.test.mjs` 新增 2 条（QQ 通知 → qq_envelope/channel/speaker；环境通知 → env）；
  `memory-p0.test.mjs` 新增说话人链路 1 条。全仓 901 tests / 900 pass / 1 skip。

### 1.2 typed memory v2 add 层（事实/偏好/承诺）

- 不换存储：先作为 additive 命名空间 `fact` / `preference` / `commitment` 存在（可召回、带 evidence、带 halfLife），
  v2 再升级为带 `validity/entity` 的正式记录。`recall` 的 CATEGORIES 已纳入这三类（检索可命中）。
- `dream.events` 同一次模型调用顺带抽取：块 JSON 新增可选 `facts[]` / `preferences[]` / `commitments[]`；
  每条独立落库（key `fact:<day>:<hash>`，evidence 复用块证据），零额外模型调用。
- 跨天去重：同一条事实/偏好/承诺再次被抽出时，按规范化文本/包含/Jaccard≥0.78 找到旧记录，
  合并 evidence、记录 `days`，不新增行（实测修掉重复膨胀）。

### 1.3 评测口径修复（否则会误判）

- `duplicateRate`：证据重合但正文完全不同不再算重复（typed 事实天然共享同一段对话的证据）；
  只有"正文相近"或"证据重合且正文也相近（≥0.3）"才算。真实 5 天 fixture 的 dupRate 从虚高 37.5% 回到 2.8%。
- `matcher.textMatchScore`：长 gold ↔ 短 extracted（typed 事实）时 Jaccard 天然低，
  改为三者取 max：Jaccard、短文本二元组召回（≥0.6 且 ≥8 字）、gold 分句覆盖；含文本强匹配时允许无语料重叠命中。

## 2. 真实素材基线（real-focuscore-2026-10，5 天 701 行，cloud deepseek-chat）

| 指标 | Phase 1 基线 | Phase 2（本轮） |
|---|---:|---:|
| extracted（含 typed） | 65 | 144（event 30 · fact 62 · commitment 16 · lexicon 25 · person 4 · preference 7） |
| matched / gold | 15 / 32 | **18 / 32** |
| formation recall | 46.9% | **56.3%** |
| event recall | 60% | 70% |
| **fact recall** | **0%** | **50%** |
| person recall | 33.3% | 50% |
| commitment recall | 57.1% | 57.1% |
| dupRate（修正口径） | （旧口径虚高） | 2.8% |
| provenance | 100% | 100% |
| identity / wrongIdRate | 100% / 0% | 100% / 0% |

- precision 从 23.1% 降到 12.5%，主因是 **gold 只有 32 条而 product 抽出 144 条**（typed 层放大了分母），
  不能直接当"变差"读；需要先抽审/补全 gold，再把这个分母口径改成"gold 完整度无关"的抽样人工评。
- retrieval（seed=formation）：no-embed recall@1/3/5 = 0/25/25%，MRR 0.083；`--embed`（bge-m3 本地）
  后 r3 33.3%、MRR 0.185、miss 66.7%、falseInjection 83.3% → **检索层仍是最大瓶颈**。

## 3. 结论与下一轮

- 写入侧两类根因已落地：**raw 有来源/说话人**、**事实/偏好/承诺不再被事件块吞掉**；真实 5 天 fixture 的
  fact recall 0→50%、event 60→70%，无回归。
- 下一轮（Phase 2 第 2 段）优先级：
  1. **检索层重做**：block/typed 摘要与探针措辞对齐、查询扩展（称呼/别名/时间词）、person 检索路径、
     MMR/注入预算；用同一 fixture 的 retrieval 指标 + `--embed`/无 embed 两种条件证明收益。
  2. **validity/旧值失效**：commitment 旧值 3/3、preference 旧值 1/3 仍并存；v2 加 `invalidatedBy` 检测与软失效。
  3. **gold 抽审/补全**（尤其 fact/commitment），把 precision 口径改成不依赖 gold 完整度的抽样评。
  4. bridge 侧再补：live QQ 消息在"有 live agent"路径下的 `conv/sender` 元数据回归测试（当前覆盖 steer 与冷启动）。

## 4. 复跑

```powershell
# 真实 5 天 fixture formation（缓存命中后无密钥可跑）
$env:DEEPSEEK_API_KEY=[Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY','User')
node tools/memory-eval.mjs --fixture .state/lab/memory-corpus/real-focuscore-2026-10 `
  --mode formation --model cloud --profile raw-main --out .state/lab/lead/eval-focuscore-typed2

# 加检索（复用 formation 缓存；再加 --embed 用本地 bge-m3）
node tools/memory-eval.mjs --fixture .state/lab/memory-corpus/real-focuscore-2026-10 `
  --mode all --seed formation --model cloud --profile raw-main --cache-only `
  --out .state/lab/lead/eval-focuscore-typed2
```
