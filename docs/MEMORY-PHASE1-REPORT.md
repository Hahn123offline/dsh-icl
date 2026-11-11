# 记忆 Phase 1 报告：根因修复 + 评测地基（2026-11-11）

> 对应：`docs/MEMORY-DIAGNOSIS.md` 的 Phase 1。本文记录**改了什么、用什么证明、基线数字、还没做什么**。
> 所有数字来自本会话工作区（`.state/lab/**`，不进 live），可复跑命令见 §7。

## 0. 一句话

写入侧的正确性先修：**dream 不再并发重跑、垃圾输出不再冒充成功、显式 remember 不再被吞、人物身份按账号归一、
形成材料剔除工具/环境/内部计划、凌晨 dream 归到"刚结束的那天"**；同时把评测工具与三源素材立起来，
可以量化 raws-all → raw-main 的收益（11-10：lexicon 7→0、precision 21.4%→50%）。

## 1. 产品代码改动（commits `43e72ef`、`f4c2e03`、`e289aed`、`ac39105`、`a1c742b` + 本提交）

| 主题 | 行为 | 文件 |
|---|---|---|
| dream 单飞 + 租约 | 并发信号双触发只有一个 run 执行；job 有 running/success/failed/skipped 与 attempts；崩溃遗留 running 可过期重领；信号撞车直接 `skipped:in-flight` | `packages/plugins/dream/src/index.mjs` |
| 严格模型输出 | `parseJsonStrict` 区分空/无 JSON/坏 JSON 与合法 `[]`；events 分片失败、cleanup/lexicon/people 解析失败 = job 失败可重试，不再"成功但 0 块" | 同上 |
| 显式 remember 不被吞 | 有 day log 时 note 作为独立材料片（证据 `n<id>`）；只标被引用/被正文覆盖的 note；其余待消化可重试 | 同上 |
| 来源门控（形成材料） | wash 给每行打 `source`+`rowIds`；events 只吃 human+qq_envelope+agent_visible；people/lexicon 只吃 human+qq_envelope；`formationProfile` 支持 raw-main/raw-human/raw-all A/B | 同上 + `packages/core/src/raw-profile.mjs` |
| 身份链 | subject 按 selfQQ/ownerQQ/ownerNames 归一；selfQQ/群号不进别人 ids；aliases 参与 findPerson；cleanup 先做已知身份确定性归并；event.people 显示名归一成 QQ | 同上 + `memory`/`whois` |
| day 归属 | 本地 <4 点触发的 dream 整理前一天；`dream.dayCutHour` 可配 | `dream` |
| 语料闸门 + 出处 | 工具名/标识符确定性拒绝（skippedJargon）；lexicon 条目带 day/note 证据 | `dream` |
| 读取链 | recall 可召回 lexicon；无嵌入时精确串加成生效；provisional 标"存疑"；eager 不注入已消化 note；eager 记录 candidateIds/injectedIds 供影子审计 | `recall`/`eager-recall`/`memory` |
| raw 服务 | registry 不覆盖行自带 `source`，来源 id 放 `sourceId` | `packages/core/src/services.mjs` |
| 审计口径 | 排除 superseded；新增 human-backed/self-source/provenance、dream attempt/失败/滞留统计 | `tools/memory-audit.mjs` |
| 产品配置 | dream 获得 selfQQ/ownerQQ/ownerNames/selfNames/groupIds | `packages/dsh-icl/presets/icl.patch.yml` |

**测试**：全仓 895 tests / 894 pass / 1 skip；新增 `packages/core/test/memory-p0.test.mjs`（12 条，覆盖 F1–F7 + 群号/selfQQ 身份校验、语料闸门）与 `memory-readpath.test.mjs`（4 条，F5/F8/F9/F10）。

## 2. 评测基础设施（由子代理交付，本会话验证）

- `tools/memory-eval.mjs` + `tools/memory-eval/`：fixture 校验 → formation（产品 dream 跑在临时 stateDir）→
  evidence→rowId provenance 映射 → 确定性 gold 匹配 → formation/retrieval 指标 → eval.json/eval.md；
  支持 `--model echo|cloud|local`、prompt-hash 缓存、`--cache-only`、`--profile`、`--days`、`--repeat`、`--gate`、`--embed`。
- `tools/fixtures/memory/schemas/fixture.schema.json` + 24 条自测（`node --test tools/memory-eval.test.mjs`）。
- `tools/memory-corpus.mjs` + 三源素材：真实 focus-core/old-qq/live 导入（λ `.state/lab/memory-corpus/`，不提交）
  与 3 个提交仓库的合成场景（`tools/fixtures/memory/synthetic-{alias-and-people,preference-change,commitment-followup}`，
  10 天/212–218 行/gold 11–14/probes 12–13）。

## 3. 基线数字：raw-all（旧无门控）vs raw-main（新口径）

### 3.1 live raw 2026-11-10（1 天，cloud deepseek-chat，gold 3 稀疏哨兵）

| 指标 | raw-all | raw-main | 说明 |
|---|---:|---:|---|
| extracted | 14 | 6 | 少了 8 条 |
| event / person / lexicon | 5 / 2 / 7 | 6 / 0 / 0 | **7 条工具/环境词（水位/积压/跑鸡…）全部消失** |
| formation precision | 21.4% | **50.0%** | 分母里的噪声砍掉 |
| recall（gold） | 100% | 100% | 没丢该记的 |
| noiseRate | 14.3% | **0%** | |
| provenanceRate | 100% | 100% | 每条块都能追回 raw 行 |
| dupRate | 0% | 0% | |
| selfSourceRate | 71.4% | 83.3% | 当天真人行少，见 §4 已知缺口 |
| person wrongIdRate | 50% | — | raw-all 里曾嘉睿被挂了群号（groupIds 已修，待重跑） |

### 3.2 live raw 2026-11-09（1 天，cloud）

- raw-main：extracted 10（event 9 / person 1 / lexicon 0），self-source 90%，dup 0，provenance 100%；
- raw-all：extracted 23（event 10 / lexicon 12 / person 1），self-source 91.3%；
- 说明：11-09 素材里真人直聊很少（3 条 QQ 信封/45 条她自己的可见回复），所以 self-source 高是**素材事实**，
  不是块乱引；要降低它需要 §4 的 bridge 来源元数据。

### 3.3 live 记忆库审计（只读，182 条）

- 29 个 event 块中 **10 个已 superseded**，存活 19 个，近重复对 **0**。
  → 修正了 HANDOVER 的"5 对近重复未清理"：旧审计把软删块算进去了；真正的重复执行证据在 dream 账本 attempts/updated_at。
- 历史 day log 无 `sources` 表（provenance 0/101），新数据开始有；这是口径迁移问题，不是块没证据。
- 37 条 lexicon 中 18 条工具/框架味（历史遗留，新采集已被闸门挡住，旧数据不清理）。

### 3.4 合成场景云基线（10 天/场景，raw-main，seed=formation；构造式 gold）

| fixture | extracted | gold | matched | P | R | dup | noise | selfSource | prov | identity | wrongId |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| alias-and-people | 52 | 14 | 11 | 21.2% | 78.6% | 0% | 1.9% | 1.9% | 100% | 100% | 0% |
| preference-change | 34 | 14 | 10 | 29.4% | 71.4% | 0 | 2.9% | 2.9% | 100% | 100% | 0% |
| commitment-followup | 29 | 12 | 9 | 31.0% | 75.0% | 0 | 3.4% | 3.4% | 100% | 66.7% | 33.3% |

- **门控对照（alias，raw-all）**：extracted 74（lexicon 41 vs 19）、selfSource 31.1% vs 1.9%、noise 9.5% vs 1.9%，
  recall 不变（71.4%）→ 与 live 基线同向。
- **retrieval（seed=formation，no-embed）**：recall@1 0–13.6%、recall@5 11.1–31.8%，miss 64–89%，falseInjection 50–67%；
  alias 加 `--embed`（本地 bge-m3）后 r1 18.2%/r5 27.3%——有提升但仍差，**瓶颈在检索层而非嵌入**。
- **promise/preference 失效**：preference 咖啡旧值已失效（superseded），爬山旧值未失效（staleOldSurvives 1/3）；
  commitment 3 条 invalidatedBy 链旧值全部与新值同时存活 → **v1 没有 validity，旧值只能靠 cleanup 碰运气**。
- **身份**：alias 场景别名/小号归并正常；commitment 场景出现 `person:name:白哥` 拆分（模型给的 name 未解析回已有账号主体）。
  已修：canonicalSubject 现在会查已有 person 档案的 aliases/ids 归并；坏 JSON 现在自动重试一次（askJson）。
- **解析失败**：alias 03-07 cleanup / 03-10 people、raw-all 03-10/11 people 曾坏 JSON（现已重试；仍坏则如实失败可重试）。

### 3.5 retrieval 低分的已知原因（Phase 2 输入）

1. block 摘要与探针措辞不同（"杭州出差三天" vs "主人下周要去杭州出差"），无嵌入时二元组退化更差；
2. person 探针走 whois/recall person，formation 产出的 person 块覆盖不足（seed=formation 时 3-person 场景）；
3. recall 返回多条、injectionPrecision 低（工具默认 limit 6 + 未整理 note 插队）；
4. 1:1 gold 匹配口径会把"一块覆盖多条 gold"记成漏（alias block137 同时覆盖 trip/catfeed），评估口径要在 Phase 2 改为集合匹配。


## 4. 已知缺口（Phase 2 输入）

1. **raw 层仍缺"谁在说、说给谁"**：QQ 真人消息现在以"未读摘要信封"或插件通知进入 raw，
   形成时只能靠文本推断；block 证据常落在她自己的可见回复上（selfSource 高）。→ bridge 侧补 sourceKind/channel/speaker 元数据。
2. **person 形成在 raw-main 下为 0**（11-10）：人物材料要求 human/qq_envelope，而当天真人行几乎没有；
   需要 bridge 元数据把 QQ 私聊/群消息稳定送进 raw。
3. **写入端去重仍弱**：事件 key 仍是 summary 哈希；11 个 shard 可能产出同主题多块。Phase 2 做"证据集合身份"与写时 ADD/UPDATE/NOOP。
4. **衰减/importance 未动**：`anchor=lastRecalledAt??createdAt` 的慢性失忆问题在 v2 处理（见 `MEMORY-V2-DESIGN.md`）。
5. **gold 仍薄**：11-10 只有 3 条稀疏哨兵；synthetic 已跑 cloud 基线（§3.4），但 gold 为 `draft` 待抽审。
6. **阈值标定未做**：eager 0.5 / recall minSim 0.35 还没有用基线数据重新标定。
7. **检索层是当前最大瓶颈**：seed=formation 的 synthetic retrieval recall@5 只有 11–32%，加 bge-m3 也只到 27%；
   Phase 2 需要 block 摘要/探针措辞对齐、查询扩展、person 检索路径、MMR 与注入预算重做。
8. **validity/旧值失效缺失**：commitment 3/3、preference 1/3 旧值仍与新值并存；v1 没有 `invalidatedAt` 机制。
9. **过度抽取**：synthetic formation extracted 29–52 条 vs gold 12–14，precision 21–31%；
   一部分是 gold 1:1 口径问题，但事件块仍偏多，需要"值得记"的 salience 门（Phase 2）。

## 5. 结论

- **写入侧门控的收益已经可量化**：同一天 raw-all → raw-main，lexicon 噪声 7→0，precision 翻倍，召回不变。
- **P0 竞态/吞数据/跨人合并三类事故都有回归测试锁定**，不会再静默发生。
- 下一步优先级：bridge 来源元数据（身份链）→ synthetic cloud 基线 → 去重/写时决策 → v2 shadow。

## 6. 复跑命令

```powershell
# 全仓测试
npm test

# 评测自测（离线）
node --test tools/memory-eval.test.mjs

# 真实 live 11-10 两天对照（需 DEEPSEEK_API_KEY；缓存后可 --cache-only）
$env:DEEPSEEK_API_KEY=[Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY','User')
node tools/memory-eval.mjs --fixture .state/lab/corpus-build/test-live --days 2026-11-10 `
  --mode formation --model cloud --profile raw-main --label baseline-11-10-raw-main
node tools/memory-eval.mjs --fixture .state/lab/corpus-build/test-live --days 2026-11-10 `
  --mode formation --model cloud --profile raw-all --label baseline-11-10-raw-all

# 合成场景（echo 链路 / cloud 基线）
node tools/memory-eval.mjs --fixture tools/fixtures/memory/synthetic-alias-and-people --mode all --model echo

# live 记忆只读审计（新口径）
node tools/memory-audit.mjs --out .state/lab/memory-audit/latest
```

## 7. 文档

- 根因/路线：`docs/MEMORY-DIAGNOSIS.md`
- 代码审计：`docs/MEMORY-CODE-AUDIT.md`
- 外部研究：`docs/MEMORY-EXTERNAL.md`
- 评测规格：`docs/MEMORY-EVAL-SPEC.md`
- v2 设计草案：`docs/MEMORY-V2-DESIGN.md`
- 数据审计：`docs/MEMORY-AUDIT.md`（其"5 对未清理/run+skip=重复执行"结论已被 `MEMORY-CODE-AUDIT.md §0.2` 修正）
