# 渐进式唤醒提示（B）设计 · 2026-11-07

> 状态：**设计稿，未接线**。用户尚未批准；本文件只写改动点、开关、回滚与验收，不改代码/preset。
> 旧项目依据：`dsh-qq/src/core-runner.js:161` —— `const text = (compact && wakeCount > 0) ? buildCompactPrompt(reason, note) : buildPrompt(reason, note)`；首次唤醒全量，之后 6 行紧凑版。参见 `docs/MODERNIZATION-CANDIDATES.md` §1 B、`docs/OLD-QWENSTUFF-ENGINEERING.md` §"渐进式提示"。
> 缓存红线：**不能按轮缩短静态 system**；能缩的只有**投递消息/唤醒提示**（append-only 的历史消息）。facts 仍走 runtime-context、仍 ≤1 条/轮，本设计不动它。

## 0. 一句话

给"会叫醒模型的消息"加一个**每会话 wakeCount**：第一次（或每次睡醒后第一声）给全量提示；`wakeCount>0` 时只给 **6 行定位提醒**，但**新消息/积压/危险/未读快照原样附在后面，不压缩 payload**。lab-only 开关默认关，产品未批准前不生效。

## 1. 现状盘点：每轮到底有哪些文本进来

E2 实测（`e2-20261106-smoke`，120min/53 轮）投递消息共 **130,253 字符**：

| 来源 | 位置 | 触发 | E2 量 | 是否 B 的目标 |
|---|---|---|---|---|
| **runtime-context 快照** | DSH + bridge `icl:facts` | 事实变化（DSH 追加） | **90,977 字符 / 134 条**（2.5/轮；DSH 样板 ~514/条 + facts） | ❌ 不动：facts 契约/cache；已由 facts dirty 收窄治理 |
| **`<icl-context>` 每轮记忆** | bridge `preStep` → `prompt.turnText` + `context.assemble` | 每轮 | eager 41 条 / 8,907 字符 + memory 检索 | ❌ 不动：这是"记得/上下文"，不是唤醒提示 |
| **time 清醒节拍** | `time/src/index.mjs:awakeTickText` | turn-end 后空闲 | **43 条 / 5,208 字符**（约 107 字符/条） | ✅ 主要目标：首条全量、之后 short |
| **time 睡眠唤醒** | `buildWakeBrief` + `endMessage`（`send({kind:'wake'})`） | 睡醒 | 1 条 / 582 字符（E2） | ✅ 首条全量；`compact` 时压缩**orientation**，睡眠简报/危险样本保留 |
| **time 目标续推** | `goalMessage`（turn-end 续推） | 有 goal 时每轮+gap≥60s | 条数随 goal；每次 ~80–200 字符 | ✅ 首次全量、之后只留"目标 id/剩几轮/到点"两行 |
| **time 积压释放** | `buildBacklogText` | 醒来/静音后 | 每批 ≤N 行、≤backlogMaxChars | ⚠ 只压 preamble；每条积压/危险**原样**（payload） |
| **QQ 唤醒矩阵** | `qq/src/index.mjs:emitWake` | 私聊安静/积压提醒 | 模板长（约 100–200 字符）+ 未读快照 ≤12 条/6000 字符 | ✅ 压模板 preamble；**未读快照不压** |
| **dream-result 回执** | time `send({tags:['dream-result']})` | 睡醒 | 1 条 | ❌ 不是唤醒提示；保留 |
| **lab PLAYBOOK / supervisor** | `tools/mc-night.mjs` `PLAYBOOK`、prompts.jsonl（lab-only） | 定时/事件 | E2 38 条（死亡/暂停脚本） | ⚠ 只作 lab A/B 对照组；可加 compact 版，但不进产品 |
| 其他 plugin notice（MC 事件等） | delivery → `agent.steer` | 事件 | 134 条 / 20,066 字符 | ❌ 不是唤醒；payload 类，不动 |

> 关键观察：当前 E2 的"每轮 130k"主要是 runtime-context（70%）而非唤醒提示。B 的收益不在 130k 大头上，而在**长会话/多次叫醒时的 orientation 重复**；必须用"wake-class 字符"而不是总字符做验收，避免把 B 的效果说大。

## 2. 目标 / 非目标

**目标**
1. wake-class 消息的**重复 orientation**（身份/怎么行动/叙事要求/环境说明）首次全量、之后 6 行内。
2. 压缩后模型仍能定位：时间、焦点、目标/积压、危险、上次在做什么。
3. lab 可 A/B；产品默认关闭；可单开关回滚。

**非目标**
- 不改静态 system/persona/sim；不改 facts 快照条数（仍 ≤1/轮）。
- 不压缩**新内容**：未读消息、积压条目、危险事件、sleep brief 统计、dream 回执。
- 不把"该干什么"写回外部脚本；compact 只做定位，不替她决策。

## 3. wakeCount：定义与生命周期

- 归属：**time 插件状态**（`time` 已有持久化 state；qq 通过共享服务读/自增）。
- 语义：`wakeCount` = 本"清醒周期"内**已发送的 wake-class 唤醒提示次数**（不是 turn 数，也不是所有投递）。
- 计数点（产生 wake-class 时自增）：
  - schedule wake（`kind:'wake'`，含 sleep 唤醒）
  - QQ 唤醒矩阵实际投递（`emitWake` → time gate 放行后）
  - goal resume 投递
  - awake tick 投递（E2 43 条；它是"叫醒"的一种）
- 重置：
  - **睡醒（sleep-end）第一声**：`wakeCount=0` → 新一轮全量（早上/长睡后需要重新定向）。
  - 新会话/新 stateDir：从 0。
  - 进程重启：持久化保留（避免重启就全量刷一遍）。
  - 可选 `fullEvery`（默认 0=只在首次/睡醒后全量；设为 N 时每 N 次 compact 后插一次全量，防长日漂移）。
- 不把普通投递（MC 事件、QQ 新消息本身、dream 回执）计入 wakeCount。

## 4. 模板

### 4.1 首次（wakeCount=0）全量 = 现状文本 + 现有 payload

保持现有 full 模板（含身份/此刻/怎么行动/叙事要求），并保留所有 payload。**不新增身份文本**，避免与 persona/sim 重复。

### 4.2 之后（wakeCount>0）6 行 compact（≤400 字符，建议 300）

```
〔提醒〕你在 ICL（小千）。
现在：<YYYY-MM-DD 周X 时段>，<醒着/睡眠>。
焦点：<focus 名称或"无">；目标：<goal id/主题或"无">。
积压：<N> 条（危险 <M> 条已置顶）。
上次：<上一条 assistant 文本截 80 字；没有就写"刚醒/刚连上">。
继续；下面的新内容优先。
```

- **payload 分隔**：compact 末尾加一行 `---`，后接原样 payload（未读快照/积压/危险/dream brief）。
- 危险优先：有 alarm 时不压缩 alarm 行（保留样本与来源）。
- 不允许在 compact 里出现"看 time_status/mcb_status"之类教轮询的话（E2 已证明会诱发轮询；见 `docs/COMPLEXITY-AUDIT.md C3`）。

## 5. 接入点（设计，不接线）

| 层 | 改动 | 说明 |
|---|---|---|
| 共享计数 | time `ctx.services.provide('time', {...})` 增加 `wake: { count(), bump(), reset() }`；qq/其他产出者通过 `ctx.services.get('time')?.wake` 读/自增 | 不新增 host 服务；time 本来就是唤醒/投递的 gate 所有者 |
| time 自身 | `awakeTickText`、`goalMessage`、`buildWakeBrief`/`endMessage`、`buildBacklogText` 各加 `compact` 分支；full/compact 由 `wakeCount` 选择 | 不改发送通道；`send({kind:'wake'|'notice'|'goal'})` 不变 |
| qq | `emitWake` 模板加 compact 版；`snapshot` 原样 | 只影响提醒 preamble；未读消息本身不压 |
| bridge | **不改**（只做投递；不重写未知来源文本） | 保持"producer 拥有文案、bridge 只搬运"的边界 |
| lab PLAYBOOK | optional：`tools/mc-night.mjs` 的 `PLAYBOOK` 加 compact 短版，`--terse-prompts` 已有先例；仅 A/B 用 | 不进产品；不作为验收主路径 |

配置（lab-only，默认全关；产品 preset 不写）：

```yaml
pluginConfig:
  time:
    compactWake:
      enabled: false        # 开才生效
      after: 1              # wakeCount >= after 用 compact（1=首次全量）
      maxChars: 400
      fullEvery: 0          # 0=仅首次/睡醒后全量；N=每 N 次插一次全量
      allowPayload: true    # false 只用于极端压测；默认 true（不压 payload）
  qq:
    compactWake:
      enabled: false
      maxChars: 200
```

## 6. 观测与验收

**指标（从 `events.jsonl`/`prompts.jsonl` 现有字段即可算，无需新数据库）**
- `wakeClass` 条数与字符：source 为 `plugin:time` 且 tags 含 `wake/goal/awake-tick`（或 `prompts.jsonl` 的 wake/supervisor 分类）；按 full/compact 分桶需新增最小计数（time state `wakeStats`：sent/full/compact/chars）。
- 每轮投递字符：按 source 分类（runtime-context / plugin:ic / plugin:mc / plugin:time / user）。
- turn-gap：`latency.json` 的 p50/p95/max、`turn-gap` >20s 次数。
- 行为副作用：`time_status`/`mcb_status` 调用次数、每轮 step、重复动作保护触发次数。
- 当事人原话：transcript 中她是否仍引用 sleep brief/目标/未读；至少各 1 条 seq。

**A/B 设计（一次 lab run，同模型同场景）**
1. baseline：`compactWake.enabled=false`（现状）。
2. compact：`enabled=true, after=1`；同一 driver 场景/时长。
3. 对比：wakeClass 字符 ↓ ≥50%（payload 不变）、总投递字符 ↓ ≥10%、turn-gap p95 不升、status 调用不升、无"忘记目标/漏警报"事故。
4. 门槛：若 wakeClass 字符下降但 status 调用/回合数上升（说明压缩导致迷失），判失败。

**回滚**
- 配置 `enabled:false`（默认），无代码回滚；若已接线，删除 preset 的 compactWake 块即可。
- 不涉及 system/facts/tools；cache 基线不受影响（消息 append-only）。

## 7. 风险与待决

1. **长日漂移**：连续 compact 后她可能忘记身份细节；`fullEvery` 提供兜底（默认 0 先测收益，再决定是否 20 次一次全量）。
2. **payload 误压**：必须按"orientation vs payload"切分，禁止把未读/积压/危险压成一行；代码评审重点。
3. **计数口径**：QQ wake 由 qq 生成、time 放行，实际投递成功才 bump；失败重试不重复计数（用 delivery ack 后 bump）。
4. **lab PLAYBOOK 不是产品路径**：只用于 A/B 对照组，不能把它的 38 条长脚本当成产品收益。
5. 用户尚未批准：本设计不接线，等批准后再按 §5 落 lab-only 开关。

## 8. 不做

- 不缩短静态 system/persona/sim（缓存契约）。
- 不改 facts runtime-context 条数（cache §7.7）。
- 不压缩 MC/QQ 事件本身（那是 payload；已有事件合并/限流）。
- 不在产品 preset 开任何默认值。

## 9. cache 复核约束（接线前确认，2026-11-07）

cache 已确认：
1. compact 走 **投递消息 / `agent/pre-step <icl-context>`（append-only）** → 缓存安全；若走 `icl:facts` 快照文本变化 → 也只是 ≤1/轮快照文本变，不影响 system。
2. **不得改 `prompts/sim.md` / `prompts/persona.md` 等静态段**；若未来确需改，先给 cache commit，由 cache 重记 system 字符数（1 分钟，不用 lab）。
3. 本设计不新增工具/不改 tools schema → `toolsHash` 不动；若接线出现 tools/system 变化，按 `CACHE-MODEL §7 附录 B` 三场景 + `cache-layout-audit` 复核，**先报异常再改文档**。
