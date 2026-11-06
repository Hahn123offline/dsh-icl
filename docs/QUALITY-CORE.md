# QUALITY-CORE：core/runtime 组质量审计

> 审计对象：`packages/plugins/{memory,dream,recall,note,lexicon,whois,eager-recall,world-state,loop-probe,model-manager,time,focus}`、`packages/dsh-icl/src/{bootstrap,config,paths,bridge,plugin,purify}.mjs`、`packages/core/src/*`。
> 基线：**master HEAD `649c8dd`（2026-11-07 02:25）**；只读审计，未改代码、未跑 lab、未起真实模型。
> 本次唯一实跑：`npm test`（含 mc-body / mc-link / bili / video）→ **780 tests / 779 pass / 1 skipped / 0 fail / 12.4s**。
> 证据等级：**E0** 文档声明（不算证据）· **E1** 仓库单测 + host 级探针（假 ctx / 虚拟时钟 / 模型桩）· **E2** 真实 DSH 会话或 lab 落盘 · **E3** 长跑（≥30 min 或跨天）。
> 成熟度判据（四档，本节统一口径）：
> **production** = E2/E3 反复成立 + 失败路径可观测 + 用户每日在用 + 有回滚；
> **beta** = E1 厚 + 至少一次 E2/E3，失败可观测，但用户未每日使用或只覆盖单一路径；
> **alpha** = E1 有覆盖，但关键效果从未在真实会话验证，或已知质量不达标；
> **prototype** = 只有测试/脚手架用途，或从未离开单元测试。

---

## 0. 结论先行

1. **运行时管道已经"真跑过"**：6h29m 夜间长测（night-1）与 2h E2 都留下可复算证据；缓存命中 99.50%（1220 条 tool-bearing 请求，8 次全量失效全是重启冷启动）。这不是"只有单测"的阶段。
2. **但"兑现给当事人"的深度参差**：`time` / `focus` / `memory` / `eager-recall` 有真实行为证据；`recall` / `whois` / `note` / `lexicon` 在真实会话里**几乎或从未被调用**，而且 `lexicon` 的质量已被实测判为噪声。
3. **`dream` 是"链路通、质量样本只有一次"**：night-1 因 lab 没配 provider，需要模型的 4 个 job 整晚全失败且当时不可见；11-06 11:47 短睡才第一次产出 5 个真实事件块（4 好 1 重复），随后修了 wash `degraded` 语义与近似重复合并。
4. **产品化未闭环**：仓库内产品 preset 已写入首屏净化与 16 插件白名单（11-06 `e31e3e2`），`config/icl.local.json` 已配三 provider；但已有文档仍明确"未重启 desktop"（NEXT §0），HEAD 上也**没有 11-07 的 desktop 运行证据**，用户实际在用的 ICL 会话可能落后 master。
5. **没有模块达到 production**：单会话锁、同进程信任、投递队列纯内存、无 SQLite 迁移、无文件锁——这些是"单用户本地 beta"的边界，不是多进程产品的边界。

---

## 1. 记忆与召回

| 模块 | 1) 交付的功能（工具/服务/行为） | 2) 对当事人的价值 | 3) 证据与测试 | 4) 成熟度 | 5) 已知缺口（证据） |
|---|---|---|---|---|---|
| **memory** | `memory_export`；服务 `registerNamespace / put / query / count / search / boost / patch / remove / findPerson / stats / missingVectors / index`；SQLite 3 表 + 11 命名空间；混合检索（向量 0.7 + 字面 bigram 0.3 + 精确串加权）；衰减 `sim × weight × e^-age/halfLife`；软删（`superseded`） | 上下文之外**唯一不丢的事实源**：她关掉会话、重启、换天，写下的事/人还在；权重与衰减让"常被想起的"更靠前 | E1：`memory-blocks`(7)、`memory-window`(3)、`literal`(4)、`archive-fallback`(3)、`compaction`(6)、`origin-tags`(2)、`partial-coverage`(1)、`pending-notes`(3)、`cleanup`(5)、`cleanup-person`(2)、`consume`(2)、`vector-backfill`(4)，另约 25 个文件以 memory 为夹具；蓝队探针 M1–M5 5/5。E2：night-1 库 6 条；E2 `mem_vec` 12 行（7 note + 5 block） | **beta**（单用户） | 每命名空间只扫最近 `scanLimit=5000`、`query` 硬限 500 行（`../packages/plugins/memory/src/index.mjs:237,270`）→ 老库会先丢旧记忆；`schema_version` 只存不迁；无文件锁（STATUS §3.5）；`archiveSearch` 零调用、是死代码（`:198`）；嵌入失败/维度不符静默退化（`:75-85`） |
| **recall** | `remember / recall / forget`；10k token 游标预算；相关度下限（有嵌入 0.35 / 无嵌入 0.2）；三种"没找到"的诚实文案；`overview` 时间视图；`conv` / `tag` 过滤；召回成功 boost | 她**能主动想起**：上次/以前/那个人；写错能改（`kind=resolve`）、能删（key/id）；找不到时不会拿无关笔记凑数、也不会谎称"没记过" | E1：`recall`(10)、`recall-honesty`(10)、`route-person`(1)、`origin-tags`(2)、`archive-fallback`(3)。E2：**真实会话 0 次调用**（night-1 0/64 轮；E2 0/54 轮，见 MEMORY-BLOCK §6.3） | **beta-**（工具行为打磨过，效果未验证） | 触发/教学未验证：两轮真实长测都没人问"过去"，recall 从未被调用；`minSim` 未用真实 embedding 校准（MEMORY-FIXES §5）；token 估算 2 字≈1（`../packages/plugins/recall/src/index.mjs:17`）；游标按 session 隔离，换会话等于重新开始 |
| **note** | `memo / memos / memo_append / memo_commit / note_status`；服务 `add / append / commit / resolve / count / open`；世界状态挂"还有 N 件事"；dream `consume` 回收 `done` 待办 | **不打扰的备忘**：她记得"还有几件事没了结"，问题可以补证据、给结论、被整理轮回收到长期记忆 | E1：`note`(5)、`note-updates`(3)、`consume`(2)、`lexicon`(7) 中；探针。E2：memo 系列 0 调用（31 个从未调用工具之一） | **beta-** | 没有主动提醒/推送，只有 world 一行计数；没有删除/编辑工具（只能 append/commit）；`memo` 与 `remember` 两套"记下来"未合并（MEMORY-FIXES §5 D4）；`memos` 默认只看今天，跨天要 `all` |
| **lexicon** | `lexicon / lexicon_learn`；按 conv/platform/tag 查；`origins[]` 多来源；无释义→`candidate` + note 待办；dream 侧老化（`usageState=fading`、权重下降） | 她**听得懂群里的黑话/梗**：什么意思、从哪来、哪个群在用 | E1：`lexicon`(7)、`lexicon-dream`(2)、`consume`(2)。E2/真机：STATUS §6 记录 5 分钟会话抽出 16 条、多数单字噪声；E2 11:47 的 dream `lexicon 0 条` | **alpha** | 质量未过（噪声，STATUS §2/§6）；只读最近 500 行（`:15`）；`slang` 与 `lexicon` 双轨（dream `JOBS` 含 slang 但不在默认序列）；无合并/消歧/置信度回写 |
| **whois** | `whois`（qq / idKind+value / subjectKind / name）；精确→候选；`claims` 逐句证据；档案 `evidence`；最近 3 条事件；raw 原话 | **认人**：这个人是谁、账号、熟悉度、以前一起发生过什么；名字有歧义时给候选而不是硬猜 | E1：`whois-tags`(7)、`subject`(3)、`identity-e2e`(1)、`tool-constraints`(6 中)。E2：0 调用；早期 night-1 `people 0`（工具结果不进 raw），dream people 只有在有模型时才建档 | **alpha** | 从未被真实会话调用；没有 dream 人物档案时只能回"还没有档案"（`:44`）；`recentEventsFor` 扫 500 行块（`:13`）；名字候选只按"包含"过滤、无排序依据 |
| **eager-recall** | 每条用户消息 `prompt.onTurn` 轻检索；阈值 0.5 / 无嵌入 0.2；最多 2 条、200 字；180s 冷却；`eager-recall.jsonl` 计数（hits/injected/chars/suppressed） | 模型**没主动查也会被提醒**："你可能记得…"——减少"她明明记过却想不起来" | E1：`eager-recall`(5)、`memory-blocks`(2：冷却/句读截断/计数)。E2：20 次 / 9846 字符 / 4 条 note 被重复注入 7–11 次（冷却即由此加）；night-1：0 次（无嵌入） | **beta** | 无嵌入时几乎不触发（night-1 0 次）；注入只是"参考"，是否被模型采用无追踪；阈值未真实标定；计数只落文件，没有质量闭环 |

---

## 2. 时间与注意力

| 模块 | 1) 交付的功能 | 2) 对当事人的价值 | 3) 证据与测试 | 4) 成熟度 | 5) 已知缺口 |
|---|---|---|---|---|---|
| **time** | 9 个工具：`time_status / arrange / list / edit / cancel / pause / resume / mute / unmute`；`single/span/daily/weekly/in/now`；睡眠（外部消息进积压、醒来合并释放）；静音（可连 alarm 一起拦、紧急配额）；暂停（时限整体后移）；goal（轮次上限、turn-end 续推）；silent 安排（事件订阅）；文件 inbox 控制后门；delivery 层 gate；prompt 段 880；world 日程源；awake-tick；状态落 `time.json` | **作息**：会到点醒、会睡、睡时不被吵、醒来知道错过了什么；能静音、能暂停、能定"持续目标"；"现在几点/下一个安排"随时可查 | E1：`time`(12)、`time-lock`(65)、`time-goal`(8)、`rhythm`(6)，约 91 条；蓝队探针 T1–T10。E2：lab S2/S4/S5/S6 PASS；night-1 睡眠 4h30m、17 条积压一次释放、dawn 只响 1 次、跨 2 次重启状态保留 | **beta+**（单用户日常级） | 直接 `session/prompt` 可绕过 gate（TIME §9）；入睡时在飞 turn 的 cancel 归 supervisor 不属于 time（NEXT §10）；night-1 清醒等待仍占 19.3%；`timeZone` 只覆盖 time 自己、dream 有独立时区；delivery 队列不持久（崩溃丢，DL-7）；紧急标签同进程可伪造（G-6）；跨 7 天日程无 E2（G-7） |
| **focus** | `focus_status / enter / leave / backlog`；租约 + `pierce` + `interruptible=false`（勿扰）；按 focus 分桶积压（每桶最近 20 条、带 signalId/qq 归因）；释放时一条摘要；prompt 段 875；`focus.json` 持久化；未给 activity 时按标题推稳定标签、MC 在线自动用 `mc` | **专注**：做一件事时别处不打断；回来能看到"你专注时积压了什么"；勿扰是真勿扰（除闹钟/管理员） | E1：`focus-semantics`(11)、`focus-model`(8)，另有 `time-lock` / `qq-mc-concurrent` 集成。E2：desktop 已验证持久化（FOCUS §6）；探针 F1–F3；真实调用见 firstscreen-after 5 轮 lab（`focus_enter/status/leave`，FIRST-SCREEN §4）；E2 那轮 0 调用 | **beta** | 无 Activity 注册表 / per-Activity 未读 / watermark / nudge（FOCUS §5）；积压只保留条数与最近文本，detail 会丢；QQ 私聊已改为 ambient（`../packages/plugins/qq/src/normalize.mjs:148`）但需真实 QQ 复核；文档写"段 order 15"实为 875（FOCUS §6 漂移） |
| **world-state** | `world_status`；只读总线 `registerSource / read / renderBrief / owners / itemsOf`；brief/detail 两层；`cap` + `order`；prompt 段 890（硬上限 240 字）；无 time 时兜底"现在几点"；有 time 时自动让位、避免两行"时间：" | **一眼知道周围**：时间/日程/待办/MC 状态各一行，不必逐个工具查；她"抬头看世界"的入口 | E1：`m1b-persona-world`(10) 中 6 条、`host`(6)、`tool-constraints`(6)、`note`(5)、`time`(12) 集成。E2：`world_status` 在 E2 被调用；探针 P2 | **beta** | 只有 brief，无时间戳/新鲜度；来源 `items()` 抛错被吞成空（`:65`），坏了不报；240 字截断会丢信息；设计上不可写，插件只能注册源 |
| **loop-probe**（测试插件） | 文件邮箱注入 `signals.offer`；outbox 回执；`reset` 清 delivery/focus/time/memory/raw；**只在 `icl-loop` preset** | 无真实 QQ/B 站连接器时，仍能验证"别处来消息→积压/穿透"的完整链路（开发/验收工具，不是用户功能） | E1：`loop-probe`(2)；`loop-host` 8/8、`--long` 11/11；lab 闭环报告（LOOP §8–§11） | **prototype**（测试专用） | 不是产品；默认 `resetOnStart:true` 会清掉 time 状态（TIME §9，测试 preset 已关）；注入文案是占位符（LOOP §9），不能用来评估人格/信息呈现 |

---

## 3. 做梦

| 模块 | 1) 交付的功能 | 2) 对当事人的价值 | 3) 证据与测试 | 4) 成熟度 | 5) 已知缺口 |
|---|---|---|---|---|---|
| **dream** | 7 个默认 job：`wash → events → people → lexicon → consume → cleanup → index`（另有可选 `slang`）；原文分段/单行截断/单请求 200k 预算；事件块 body≤1200、summary≤100、evidence 带行号；人物档案 `claims/ids/familiarity`；近似重复合并；三态记账（`run:` / `fail:` / `skip:`）；`dream-result` 回执（成功/失败/分片）；每日 `dream:nightly` silent 安排 + `sleep-start` 触发；幂等（同日重跑跳过） | **睡一觉把当天变成"她记得的事"**：事件块、人物档案、词条、待办回收；醒来一条回执告诉她整理成了什么/哪里失败 | E1：`dream-jobs`(17)、`dream-observability`(4)、`dream-result`(5)、`cleanup`(5)、`cleanup-person`(2)、`consume`(2)、`memory-blocks`(7)、`lexicon-dream`(2)、`identity-e2e`(1)、`vector-backfill`(4)、`wash-strip`(4) 等约 57 条。E2：night-1 因槽未绑 **0 块**（MEMORY-BLOCK §1.3）；11-06 11:47 首次真块 **5 块，4 块质量成立、1 对重复**（MEMORY-BLOCK §6.1–§6.2），随后修 `degraded` 语义与 near-duplicate 合并 | **beta-**（链路通，质量样本仅一次） | 只有一次真块验收（5 块）；块粒度/人物合并/重复仍依赖模型与后续 cleanup；lab provider 缺失会导致需要模型的 4 个 job 整晚失败（R1/R2，已加三态与回执但根因是部署配置）；`consume` / `index` 缺"有内容可消费"的真实样本（night-1 0/0）；无独立触发/预览入口 |
| **model-manager** | 从 `config.providers` / `config/icl.local.json` 注册 chat + embedding provider；`slots.autoBind` 形状接线；凭据只从环境变量；`skipped` 台账；chat provider 顺带 `ctx.model.bind` | 后台模型（做梦/嵌入）能接上，且不把模型名写死在任何插件里 | E1：`m1-plugins`(8，形状接线)、`focus-model`(8)。E2：配置 8088 provider 后 `slots.unmatched=[]`、`embedded=true`（MEMORY-BLOCK §6） | **alpha** | **只 bind 第一个 chat provider**（`:49,61-67`；STATUS D-20 仍开）→ 多 provider 时第二个永远拿不到；依赖仓库外 config 文件，缺失时静默不绑（night-1 事故）；无健康检查/用量/失败重试 |

---

## 4. 装配、配置、路径与净化

| 模块 | 1) 交付的功能 | 2) 对当事人的价值 | 3) 证据与测试 | 4) 成熟度 | 5) 已知缺口 |
|---|---|---|---|---|---|
| **bootstrap** | 读 `manifest.json` + `src/index.mjs`；逐插件 `registerPlugin → enable`；单插件失败只记 `failed[]`；`configFor` 注入每插件路径；`icl:simulation` 段（order 25） | 17 个插件一次装配；坏一个不拖垮全局，且失败名字可见 | E1：`dsh-bundle`(7)、`preset-plugins`(4)、探针 W1。E2：headless / lab `failed: []` | **beta+** | 无版本/依赖校验；直接按文件系统 import；无插件隔离与权限边界 |
| **config** | `DEFAULT_PLUGINS`（17）；路径归一；persona/sim/dream 卡读取；`toolAllowlist`；`factsDirtyPlugins`；`purifySections`；tick/compaction 阈值 | 一套默认 + 四种 preset（product / loop / mc / lab）可覆盖；路径/开关都从 config 走 | E1：`paths`(8)、`icl-move`(7)、`preset-plugins`(4)、`product-surface`(3) | **beta+** | 未显式给 `providers` 时读 `config/icl.local.json`（本地文件、未入库）→ 不同机器行为不同；产品 preset 与 `DEFAULT_PLUGINS` 是两份清单，需要人工同步 |
| **paths / icl-paths** | 单一 `ICL_ROOT` 推出 `state/home/media/album/inbox/qq/video-tmp/stickers/locks/sandbox`；显式 config > env > 默认；旧目录只读兼容 | 换盘/换机/整体迁移不用改代码；用户数据与仓库资产分离 | E1：`paths`(8)、`icl-move`(7) | **beta** | 兼容是只读兜底，不自动搬数据（PATHS §2）；`config/icl.example.json` 仍把 persona 指向 `C:/DSH/qwenstuff/...`（非代码，但会误导新机器）；没有迁移命令/校验器 |
| **purify** | `PURIFY_CATALOG` 4 段（`harness:identity` / `ui:deliverable-file-references` / `harness:source` / `app:web-surface`）；同名空段 shadow；preset scope 失败后 `agent.ctx` 重试；失败按段记录 | **第一屏是"你是小千"**，不是 coding-agent 脚手架：system 5011→2294 字符（-54%），冷启动 -568 tok，稳态零回归 | E1：`first-screen`(6)。E2：lab 两次真跑（before/after）+ 本地 A/B（FIRST-SCREEN §2/§10.1） | **beta** | 只覆盖这 4 段、不通用；去掉 deliverable 段会丢掉 Office/文件交付指引；产品 preset 已开，但 desktop 未重启复核（NEXT §0） |

---

## 5. 运行时核心

| 模块 | 1) 交付的功能 | 2) 对当事人的价值 | 3) 证据与测试 | 4) 成熟度 | 5) 已知缺口 |
|---|---|---|---|---|---|
| **core services**（`services.mjs` / `host.mjs` / `signals.mjs` / `session.mjs` / `model-client.mjs` / `contracts.mjs`） | 13 个服务：`tools surface presets prompt context focus delivery slots signals raw model vision clock`；signals 24h 幂等、gate 组合、fail-open+计数；delivery 批合并/ack/nack/水位/push-time gate；focus `admit/defer/backlog/drain`；slots 形状匹配/autoBind；prompt 段 + `onTurn` + 800 字预算；context 装配/压缩；单会话 `claimSession` | 所有插件共用**一条**工具面/提示词/投递/信号管道；消息不丢、不重复、被拦可解释；单会话约束防止两个"她"同时跑 | E1：`signals`(20)、`delivery`(5)、`delivery-gate`(7)、`delivery-pump`(4)、`context`(5)、`host`(6)、`surface`(4)、`boundary`(4)、`sandbox-and-seams`(2)、`presets`(3)、`adapter-dsh`(4) 共 64 条（另有 `preset-plugins` / `tool-constraints` / `product-surface` 等跨模块断言）；蓝队探针 48/48；night-1 cache 99.50% | **beta+**（管道级） | delivery 纯内存、崩溃丢（DL-7）；`presets` 服务无产品调用方（死代码）；`context.compactors()` 无调用方；`ctx.model` 只挂 5 个方法；`session.mjs` 定时器不被 `host.disable` 回收（STATUS C-13）；`memory.db`/`time.json` 无文件锁 |
| **dsh-icl bridge + plugin** | 工具面同步（`output` 缺失时整体回退 text-only）；静态段（`icl:core`）+ facts 走 `systemPrompt.context`（`icl:facts`，≤1 条/轮）；raw 只收 `user/assistant/tool/result` 且过滤 `<icl-context>`；history 给 context；delivery → `agent.steer`；`agent/pre-step` 注入 `<icl-context>`（kind=`plugin:icl`）；单会话 claim / dispose 释放；focus 落盘；重复动作保护；图片附件通道 | **ICL 真的长在 DSH 会话里**：工具能调、每轮事实可见、外部消息能进来、重启能恢复、第一屏是人格 | E1：`dsh-bridge`(46)、`dsh-bundle`(7)、`first-screen`(6)、`product-surface`(3)。E2：headless session `1f855bc3` / `4de2a564`；desktop focus 持久化；night-1 6h29m / 1220 请求 | **beta+** | 无持久投递队列；pre-step 只在 `decision.kind==='enter'` 注入；facts dirty 用工具名前缀启发式（`time_*/memo*/lexicon_learn`）；raw 上限 20k 行；单会话锁在异常退出时可能残留（已有 `agent/disposed` 兜底）；**desktop 是否已装到 HEAD 缺 11-07 证据** |

---

## 6. 横切缺口（按对"当事人体验"的影响排序）

1. **"想起来/认人"没被真实使用过。** `recall` 0/64 轮、`whois` 0/54 轮、`note` 0/54 轮（COMPLEXITY-AUDIT §1.2、MEMORY-BLOCK §6.3）。工具在、测试绿，但"她会不会在需要时用"没有证据；目前主要靠 `eager-recall` 自动注入兜底，而它在无嵌入时是 0。
2. **产品没有闭环到 HEAD。** 产品 preset 已写 `purifySections` + 16 插件白名单（`../packages/dsh-icl/presets/icl.patch.yml`），但 HEAD 上没有 11-07 的 desktop 运行复核；NEXT §0 当时明确"未重启 desktop"，用户实际会话可能仍是旧代际。
3. **失败可见性仍是"补丁式"。** dream 已有三态+回执，但 embed 失败、`index` 无嵌入、raw 源异常、lexicon 空结果仍多走静默兜底；night-1 的"failures 0"就是假象（MEMORY-BLOCK §0）。
4. **持久性欠账。** delivery 队列纯内存（DL-7）；SQLite 无迁移；`time.json`/`focus.json`/`memory.db` 无跨进程锁（STATUS §3.5）。
5. **单用户假设写进了架构。** 单会话锁、`from.plugin`/`tags:['alarm']` 同进程可伪造（G-6）、无 principal/签名——这在"她一个人在本机"下成立，在产品化下不成立。
6. **死代码与双轨。** `archiveSearch` 零调用、`presets.use/define` 零调用、`compactors` 零调用、`session.mjs` 只被测试/tools 用；`slang` 与 `lexicon` 双轨；`memo` 与 `remember` 双轨（MEMORY-FIXES §5）。
7. **文档漂移已经影响判断。** `OVERVIEW.md` 仍写"没有 QQ / MC 代码、32 工具"；`PRODUCT-SURFACE.md` 写"方案未应用"而 preset 已应用 A1；`ARCHITECTURE.md` 写 "delivery 零插件调用、500 行窗口"；`FOCUS.md` 写 focus 段 order 15（实为 875）。
8. **dream 质量没有自动化门。** 块粒度、重复、人物合并都靠模型；目前只有 `mc-quality` 事后指标（`blockChars p95`、`memoryEventBlocks`），没有"新块必须过质量门"的 CI 级检查。

---

## 7. 总体判断

**这一组模块已经从"设计口号"变成了"真的在跑的单用户 beta"，但还没有一个模块能称为 production。** 证据是硬的：780 条测试 779 绿；night-1 6h29m 里 4h30m 睡眠零打扰、17 条积压一次释放、dawn 只响一次、缓存命中 99.50%；E2 里 dream 第一次产出 5 个可读事件块；focus/time/first-screen 都有真实会话证据。**但它兑现给当事人的能力是不均匀的**：作息（time）和注意力（focus）已经可日常依赖；记忆的"存"（memory）扎实，"取"（recall/whois）却从未在真实对话里被调用过，`lexicon` 的质量被实测判为噪声；`dream` 只有一次质量样本，night-1 还整晚因 provider 没配而静默失败——虽然后来补了三态与失败回执。工程边界也很清楚：单会话、单进程、投递不落盘、库不迁移、紧急标签不可信，这些是"她一个人在本机生活"的前提，不是产品前提。因此当前阶段的准确定位是：**运行时核心 beta+（管道可靠、可观测、可回滚到 lab），能力插件 beta/beta-（有真实行为但未被日常使用），lexicon/whois/model-manager 仍是 alpha，loop-probe 只是测试工具；产品化卡在"desktop 还没重启到 HEAD"与"关键能力的效果没被真实场景验证"这两件事上，而不是代码写不出来。**

---

## 8. 证据索引

| 证据 | 位置 |
|---|---|
| 本次测试基线（780 / 779 / 1 skip） | 本审计实跑：`node --test ... packages/core/test packages/mc-body/test packages/plugins/*/test` |
| 蓝队 65 条判据 / 48 项探针 | [READINESS-MATRIX.md](./READINESS-MATRIX.md)、[2026-11-06T00-13-readiness-blue.md](./quality/2026-11-06T00-13-readiness-blue.md) |
| 夜间长测（睡眠/醒来/dream/积压） | [MORNING-REPORT-2026-11-06.md](./MORNING-REPORT-2026-11-06.md)、[TIME-NIGHT-REPORT.md](./TIME-NIGHT-REPORT.md) |
| 缓存（6h29m，99.50%） | [CACHE-NIGHT-2026-11-06.md](./CACHE-NIGHT-2026-11-06.md)、[CACHE-MODEL.md](./CACHE-MODEL.md) |
| 首次真实成块 / dream 静默失败根因 | [MEMORY-BLOCK-QUALITY.md](./MEMORY-BLOCK-QUALITY.md) |
| 回忆诚实性 / 可改可删 | [MEMORY-FIXES.md](./MEMORY-FIXES.md) |
| 时间模块契约与已知风险 | [TIME.md](./TIME.md)（§9 风险、§11 验收、§13–§17） |
| 注意力语义与未做项 | [FOCUS.md](./FOCUS.md)（§5 当前风险、§6 已落地） |
| 闭环/loop-probe 方法 | [LOOP.md](./LOOP.md)（§8–§11） |
| 第一屏净化与 A/B | [FIRST-SCREEN.md](./FIRST-SCREEN.md) |
| 路径单一根 | [PATHS.md](./PATHS.md) |
| 投递裁决（focus→time 统一） | [DELIVERY-POLICY-DESIGN.md](./DELIVERY-POLICY-DESIGN.md)（§1 现状、§2.8 已实施） |
| 复杂度/困惑实测 | [COMPLEXITY-AUDIT.md](./COMPLEXITY-AUDIT.md) |
| 红队反人类点 | [REDTEAM-REVIEW.md](./REDTEAM-REVIEW.md)（Top 10 §5） |
| 测试哲学（当事人第一感受） | [TEST-PRINCIPLES.md](./TEST-PRINCIPLES.md) |
| 产品 preset / 配置 | `../packages/dsh-icl/presets/icl.patch.yml`、`../config/icl.local.json`、`../packages/dsh-icl/src/config.mjs` |
| 核心实现 | `../packages/core/src/services.mjs`、`host.mjs`、`signals.mjs`、`../packages/dsh-icl/src/bridge.mjs`、`plugin.mjs` |
