# 目标达成审计（蓝队）· READINESS-MATRIX（2026-11-06）

> 读者：lead / 用户 / 红队之外的接手人。本文回答一句话：**"这一轮声明的设计目标，逻辑上真的达成了吗？"**
> 纪律：只认可判定判据与可复算证据；判据本身有问题的目标单列，不硬判"达成"。
> 红线：本审计**不连夜间 MC 长测（54838/57101）、不占 57101/57104/57107/57108、不用 GPU、不起真实模型**；
> 全部证据来自 host 级虚拟时钟 + 假 DSH ctx + 模型桩 + 落盘 jsonl。
> 与红队完全独立：本文未参考红队结论，也未看其文件。

## 0. 方法与证据等级

| 等级 | 含义 | 本轮用量 |
|---|---|---|
| **E0** | 仓库测试（`npm test`） | **452/452 绿**（core 362 + mc-body 34 + mc-link 56） |
| **E1** | 蓝队 host 级探针（虚拟时钟/假 ctx/模型桩，本轮新写） | 探针 A 35 项 / B 10 项 / C 3 项 → **48/48 PASS**（原始输出见 `docs/quality/2026-11-06T00-13-readiness-blue.md`） |
| **E2** | lab 实测（已落盘，非本轮跑） | `AUDIT §0.2/§0.3/§0.4/§0.5`；`CACHE-MODEL §5.4/§7.7`；`MC-ACCEPTANCE-2026-11-05`；`TIME.md §11` |
| **E3** | 代码不变量（grep/结构断言，探针里已机器化） | MC body 无模型调用、QQ connector 零发送、manifest/bundle 形状等 |
| **E4** | 文档声明（**不算证据**，只用来提取目标） | HANDOVER/OVERVIEW/ARCHITECTURE/TIME/MEMORY/FOCUS/PLUGINS/MC-CONTRACT/QQ/PROMPT-CONTRACT |

判据写法：每条目标先转成"可被脚本/测试判定的句子"，再给证据。判定四档：**达成 / 部分 / 未达成 / 判据有问题**。

## 1. 证据基线

- `npm test` → **452 passed / 0 failed**（2026-11-06 00:1x，HEAD `e3fd594`）。
- 蓝队探针三组：**48/48 PASS**（明细见证据文件；每项都带 `domain/id/evidence`）。
- 已落盘的端到端证据（复用，不重跑）：缓存本地 A/B（hit 91.2% vs 91.2%、prefill 9312 vs 9445）、
  MC 真实场景引擎侧（27 请求、hit 96.2%、prefill 13012、冷启动 1 次）、time 的 S2/S4/S5/S6、MC 云端 A/C/E。

## 2. 目标 → 判据 → 证据 → 结论（13 个域）

### 2.1 记忆与召回

| # | 目标（来源） | 可判定判据 | 证据 | 结论 |
|---|---|---|---|---|
| MM-1 | 记忆是"上下文之外唯一真实源"，重启不丢（MEMORY §1） | 新 host 同 db 文件能读回写入项；未注册命名空间写入必须报错 | 探针 M1/M4 | **达成** |
| MM-2 | 主动记/召回/遗忘可用，游标不重复给同一批（MEMORY §3） | `remember`→`recall` 命中；第二次同 query 不复述已给条目；`forget` 后计数减一 | 探针 M2；`recall.test.mjs` | **达成** |
| MM-3 | 无嵌入时检索退化但不崩（MEMORY §3） | 无 embed 槽位时 `search` 有结果、`index()` 返回 false 不抛 | 探针 M3 | **达成** |
| MM-4 | 人物档案按身份精确查、按名字给候选（MEMORY §7） | `whois{qq}` 精确命中、`whois{name}` 返回候选 | 探针 M5；`whois-tags/route-person` | **达成** |
| MM-5 | 衰减/加权数学正确（MEMORY §3） | 60 天前同文条目分数 < 新条目 | 探针 B6（1.000 vs 0.135） | **达成** |
| MM-6 | 每轮检索成本有界（性能目标，MEMORY §8 隐含） | `search` 扫描上限存在；单条消息延迟不随库无界增长 | 代码 `scanLimit=5000`（E3）+ AUDIT P1-12（已做单次解析） | **部分**（有硬上界，但 5000 行/消息是线性成本；P2，见 G-8） |

### 2.2 时间与作息（wake / sleep / dream / 积压）

| # | 目标（TIME §0/§1/§4/§5） | 可判定判据 | 证据 | 结论 |
|---|---|---|---|---|
| TM-1 | 到点唤醒只发生一次（不重复投递） | `add(at:'now')` + 多次 `tick()` → 只投一条 | 探针 T1；`time.test.mjs` | **达成** |
| TM-2 | 睡眠拦截外部消息、醒来合并释放（TIME §4） | 睡眠中 offer → 不投递；wake+tick → 一条积压摘要 | 探针 T2；`time-lock.test.mjs`；lab S4 | **达成** |
| TM-3 | 静音只关外部、不关事件总线（TIME §4.1） | 睡中 `turn-end` 事件被接受且不进积压 | 探针 T3（backlog 0→0）；AUDIT §0.3 | **达成** |
| TM-4 | 积压有界且保重要消息（TIME §4.1） | 200 条洪水 + maxQueue=50 → 队列 ≤50 且 mention 保留 | 探针 T4（queue=50） | **达成** |
| TM-5 | 同一 signalId 不重复入队 | 同 id 连发 3 次 → 队列 1 条 | 探针 T5 | **达成** |
| TM-6 | 静音到期自动解除 | mute 1 分钟 + 虚拟时钟 61s + tick → 锁空 | 探针 T6 | **达成** |
| TM-7 | 目标（会话轴）turn-end 续推、轮次/到期收尾 | `addGoal(turnLimit)` + turn-end → 目标消息；上限后结束 | 探针 T7；`time-goal.test.mjs` | **达成** |
| TM-8 | 睡中重启不丢状态（phase/backlog 落盘） | 落盘含 phase=sleeping+queue；重启到 sleepUntil 后 tick → awake 并释放积压 | 探针 C1 | **达成** |
| TM-9 | 长期日程（跨天/每周）真实验收 | 有单测覆盖，但端到端只验收过 S6（跨 4h22m 两份 system 快照） | `time.test.mjs`（E0）+ TIME §11（E2） | **部分**（长周期无 lab 验收；P2，G-7） |
| TM-10 | dream 由 arrangement 触发、不写死在 time 分支 | `dream:nightly` 注册为 silent 安排 + dream 订阅 tags dream | E3（`dream/add`）+ `dream-jobs.test` | **达成** |

### 2.3 focus

| # | 目标（FOCUS §1/§6） | 判据 | 证据 | 结论 |
|---|---|---|---|---|
| FC-1 | 别处的普通消息进积压、mention 按 pierce 穿透、勿扰全拦 | 三组投递断言 | 探针 F1；`focus-semantics.test` | **达成** |
| FC-2 | 离开焦点只给一条合并摘要（且走 signals，能被 time 静音拦） | 3 条积压 → 释放后 1 批摘要 | 探针 F2；AUDIT §0.3/§5 | **达成** |
| FC-3 | 过期租约不复活、快照恢复丢过期 | ttl 过期后 current=null；恢复后仍 null | 探针 F3 | **达成** |
| FC-4 | 焦点事实在人格之后（前缀缓存） | 提示词顺序 persona < focus；有租约 firstDiff 只在尾部 | 探针 P2 + AUDIT §0.2（2183/2518） | **达成** |
| FC-5 | "紧急"优先级可信（不可伪造） | 同进程内 `from.plugin`/`alarm` 可被任意插件伪造 | TIME §9（E4 承认）+ 代码（E3） | **判据有问题**（G-6：不是安全边界，只是同进程信任假设） |

### 2.4 人格与提示词分层

| # | 目标（PROMPT-CONTRACT §1–§3） | 判据 | 证据 | 结论 |
|---|---|---|---|---|
| PR-1 | 三层各有唯一家：人格/仿真静态、事实动态、工具教学进 description | `persona`(20)→`icl:simulation`(25)→事实(≥800) 顺序；persona 不含工具名 | 探针 P1 | **达成** |
| PR-2 | 事实段 ≤1–2 行、无内容消失、段首不放随机量 | 无焦点时 focus 段整段消失；有焦点出现 | 探针 P2 | **达成** |
| PR-3 | 静态 system 整场字节稳定（前缀缓存前提） | 时钟推进/加 focus 时 `icl:core` 零字节变化；facts 走 `systemPrompt.context` | 探针 C1/C2；lab §0.2（跨分钟 1 条 system/message） | **达成** |
| PR-4 | 工具 description 自足（教得会，不用全局提示词） | 无评分标准；只能人工/模型评测 | AUDIT §6、mc-link 重写、PLUGINS 未更新 | **判据有问题**（G-5：需要固定评分量表，建议 3 轮新会话按 agent-experience 打分） |

### 2.5 投递与信号

| # | 目标（MESSAGES / SURVIVAL §1） | 判据 | 证据 | 结论 |
|---|---|---|---|---|
| DL-1 | 幂等去重：重复 id 只收一次；被拦不占 id | 同 id 二次 dedupe；gate 拦下后重试成功 | 探针 D1 | **达成** |
| DL-2 | gate 坏掉不能静音一切（fail-open + 计数） | gate 抛错 → 放行且 `gateErrors=1` | 探针 D2 | **达成** |
| DL-3 | 插件直接 push 也受静音/睡眠约束（push-time gate） | `addGate` 拒绝后 `blocked:true` | 探针 D3；AUDIT §0.3 | **达成** |
| DL-4 | 重试耗尽不静默消失 | 8 次 nack → `droppedCount≥1` | 探针 D4 | **达成** |
| DL-5 | 过期信号不投递 | `expiresAt` 过去 → `expired:true`、不投递 | 探针 B5 | **达成** |
| DL-6 | 会话忙（steer 抛错）自动重试、不丢消息 | 首次失败 pending 保留、第二次成功 | 探针 C2 | **达成** |
| DL-7 | 进程崩溃后待投递消息不丢 | 投递队列只在内存，无持久化 | 代码（E3）：`createDeliveryService` 无落盘 | **未达成**（设计取舍；P2，G-4。需要的话可把 queue 写 `.state/delivery.jsonl` 并在启动时重放） |

### 2.6 单会话锁

| # | 目标（ARCHITECTURE §7 / plugin 单会话） | 判据 | 证据 | 结论 |
|---|---|---|---|---|
| SL-1 | 第二个会话必须被拒绝（同步抛错，DSH 可回滚） | 二次 claim 抛"已经指向会话" | 探针 S1 | **达成** |
| SL-2 | 插件层否决 + agent dispose 释放锁 | 第二 session 抛"只允许一个会话"；dispose 后同 id resume 放行 | 探针 S2；`dsh-bridge.test`（dispose/resume 两条） | **达成** |

### 2.7 缓存（方案 B + 节流）

| # | 目标（CACHE-MODEL §5/§7） | 判据 | 证据 | 结论 |
|---|---|---|---|---|
| CA-1 | system 里不放会变的字节 | `icl:core` 只含 order<800；时钟/focus 变化 0 字节 | 探针 C1；AUDIT §0.2 | **达成** |
| CA-2 | 事实作为 runtime-context 快照、按 turn 节流（≤1 条/轮） | 同 turn 复用；focus/白名单工具/投递 → 下一步刷新（stale≤1） | 探针 C2；`dsh-bridge.test` 28/28；AUDIT §0.5.5 | **达成** |
| CA-3 | ICL 注入不冒充 DSH 快照 | `<icl-context>` kind=`plugin:icl` | 探针 C3；实测修前 5 条/修后 1 条 runtime-context（AUDIT §0.5.5） | **达成** |
| CA-4 | 前缀命中不劣化 | 本地 A/B：hit 91.2% vs 91.2%、prefill -1.4%；MC 真实场景 96.2% | CACHE-MODEL §5.4/§7.7（E2） | **达成**（在测过的场景内） |
| CA-5 | "任何场景都不劣化" | 只有 2 个场景的基线，无法全称证明 | E2 范围 | **判据有问题**（G-3：应写成"分场景基线"，新增场景要补测） |

### 2.8 MC

| # | 目标（MC-CONTRACT §1/§9） | 判据 | 证据 | 结论 |
|---|---|---|---|---|
| MC-1 | 只有一个决策者（body 不含模型/目标生成） | body 源码无模型调用；契约含不变量条 | 探针 B7（E3） | **达成** |
| MC-2 | 任务有 ID、事件可追溯，任务状态以 body 为事实源 | link 事件带 taskId；`mc-link.test` 56/56 | E0（mc-link 56）+ B7 | **达成** |
| MC-3 | 失败模式可读（连不上/崩/低血/断线/任务失败） | 事件分级、safety stop、resume、exit 归因 | `mc-body.test` 34/34 + MC-ACCEPTANCE | **达成** |
| MC-4 | 云端 A/C/E + body 30 分钟 soak | 已记录 PASS | MC-ACCEPTANCE（E2） | **达成** |
| MC-5 | **本地模型** 3 连验收 | 未跑（GPU 串行/时间窗） | HANDOVER §4.3/§5 | **未达成**（已知 TODO；P2，G-2） |

### 2.9 QQ（phase1 / phase2 边界）

| # | 目标（QQ §0/§11） | 判据 | 证据 | 结论 |
|---|---|---|---|---|
| QQ-1 | 入站只读：连接器零发送 | connector 源码无 `send`；单测断言 framesSent=0；qq 测试 46/46 | 探针 B8（E3）+ E0 | **达成** |
| QQ-2 | 默认关闭：不显式启用不建连接、不出站 | 默认 config 下 `qq_status` 显示 enabled=false/出站关闭；`qq_send` 未注册（**故意**只在三钥匙齐时注册，manifest 是上限） | 探针（qq 默认探测）+ 代码（E3） | **达成**（判据需注明 manifest≠必然注册） |
| QQ-3 | phase1 私聊出站受三钥匙+审批+限速+审计约束；无群发 | outbound 仅 `sendPrivate`；`qq_send` 测试 46 项 | E0（qq-send.test）+ 代码 | **达成** |
| QQ-4 | phase2（群/自动回复）未启用 | 明确列为下一阶段、无代码路径 | QQ.md §11 | **达成**（按边界定义） |

### 2.10 DSH 接线

| # | 目标（DSH-INTEGRATION / bridge） | 判据 | 证据 | 结论 |
|---|---|---|---|---|
| DS-1 | 默认插件清单全部启用、工具面齐全且稳定 | bootstrapHost failed=[]、tools≥40、连续两次 hash 一致 | 探针 W1；`dsh-bundle.test` | **达成** |
| DS-2 | 工具/提示词/投递/回合/原文/每轮上下文六通路 | bridge 测试 28/28；pre-step 注入 kind 正确；turn-end→goal 续推 | 探针 W2 + E0 | **达成** |
| DS-3 | preset 分层配置正确（persona/simulation/facts） | preset 指向 `persona.md`/`sim.md`；bundle patch 声明 | 探针 B9（E3） | **达成** |
| DS-4 | 宿主无 `systemPrompt.context` 时降级不丢事实 | 单 section 全量回退（有测试） | E0 `dsh-bridge.test` | **达成** |

### 2.11 静默失败

| # | 目标（SURVIVAL §2 / 全仓纪律） | 判据 | 证据 | 结论 |
|---|---|---|---|---|
| SF-1 | 后台任务失败必须留证据（dream 结果进日志） | 桩：slot 未绑 → `dream.run ok:false` 带 job 失败原因 | 探针 X1；AUDIT P0-4 | **达成** |
| SF-2 | 压缩不默认开启"只加不减" | `DEFAULT_PLUGINS` 不含 compaction；100 条历史 assemble=0 字 | 探针 X2/B10 | **达成** |
| SF-3 | 工具错误可操作（不是"失败"两字） | editor 读失败带 code、截断有标记 | 探针 X3 | **达成** |
| SF-4 | 投递丢弃可观测 | `droppedCount` 暴露 | 探针 D4 | **达成** |
| SF-5 | 全仓残留静默吞异常有清单 | 仍有 60+ 处 `catch {}`（多为"可选依赖/日志坏了不影响"），其中少数属于"能说清但没说" | AUDIT §3 P2 + 代码抽样 | **部分**（P2，G-9：建议 CI 规则：新 catch 必须带 comment 或 rethrow） |

### 2.12 重启恢复

| # | 目标（TIME §1 / bridge focusFile / memory） | 判据 | 证据 | 结论 |
|---|---|---|---|---|
| RC-1 | time 状态恢复（schedules/goals/mute） | 新 host 同 stateFile 恢复三类状态 | 探针 R1 | **达成** |
| RC-2 | focus 租约+积压恢复 | focus.json 恢复到新 host | 探针 R2 | **达成** |
| RC-3 | 坏状态文件不崩（降级干净状态） | 写非法 JSON 后 enable/start 不抛 | 探针 R3 | **达成** |
| RC-4 | 睡中重启（见 TM-8） | phase/backlog 落盘并恢复 | 探针 C1 | **达成** |

### 2.13 长会话压缩 vs dream

| # | 目标（HANDOVER §4.4 / MEMORY §5） | 判据 | 证据 | 结论 |
|---|---|---|---|---|
| LC-1 | ICL 不引入第三套压缩 | `DEFAULT_PLUGINS` 无 compaction；assemble 不改历史 | 探针 X2/B10 | **达成** |
| LC-2 | dream 输入与压缩解耦：只从 raw 事件流取，且过滤系统上下文 | runtime-context/`<icl-context>` 不进 raw；真实消息/工具结果进 | 探针 C3 | **达成** |
| LC-3 | **dream 输入规模有上界** | 繁忙一天（2000 行×500 字）→ 修复前单请求 1,009,812 字符；修复后 wash 单行截断+总量预算、events 分片，实测**单请求 40,253 字符**（≤200k 预算） | 探针 G1（修复后复跑）+ 新测试 2 条（`dream-jobs.test`） | **达成（本轮修复，见 §4 G-1）** |
| LC-4 | DSH 自带 80% checkpoint 与 dream 原文不冲突 | 仓库内无法判定（DSH 外部行为；且是否启用取决于宿主配置） | HANDOVER §4.4 已列为风险 | **判据有问题**（G-10：需真实长会话 + DSH 配置快照才能判） |

## 3. 故障注入 / 模型桩推演（本轮实际跑过的）

| 注入 | 观察 | 结论 |
|---|---|---|
| 重复 signal id 连发 3 次 | 只入队 1 条；dedupe 计数 | 安全 |
| 被 gate 拦下后同 id 重试 | 不占 id，重试成功 | 安全 |
| gate 函数抛异常 | fail-open 放行 + `gateErrors` 计数 | 安全（不静音一切） |
| 投递连续 nack 8 次 | `droppedCount=1` 可观测 | 可观测（但消息确实丢，符合"重试耗尽"语义） |
| steer 抛错（会话忙） | 首次 pending 保留，第二次送达 | 安全 |
| 睡眠期 200 条洪水（maxQueue=50） | 队列截到 50，mention 保留 | 有界 |
| 睡中 `turn-end` 事件 | 接受、不进积压 | 安全（不把事件当消息攒） |
| 静音到期 | 虚拟时钟 +61s 自动解锁 | 安全 |
| 过期 focus 租约 + 快照恢复 | 过期丢弃不复活 | 安全 |
| time.json/focus.json 写成非法 JSON | 插件正常起、状态回落干净 | 安全 |
| 睡中进程重启 | phase/backlog 恢复，睡够后 tick 醒来释放 | 安全 |
| dream 模型桩返回垃圾/空串 | job 不崩、0 块、账本已跑（同日重跑跳过） | 安全（幂等） |
| recall cursor 传垃圾 | 安全降级、不复述 | 安全 |
| persona 空卡/越界回滚 | 明确错误信息 | 安全 |
| **繁忙一天喂 dream** | **单请求 1.0MB payload** | **不安全（P1，G-1）** |

## 4. 未达成 / 部分 / 判据有问题 —— 清单与优先级

| 编号 | 级别 | 目标 | 现状与证据 | 最小复现 / 测试草案 |
|---|---|---|---|---|
| **G-1** | **P1 → 已修** | LC-3：dream 输入规模有上界 | 探针 G1：2000 行×500 字 → payload 1,009,812 字符（≈30 万 token 级）；本地 131K 窗口会失败、512K 窗口也很吃紧。夜间整理可能整晚白跑（现在至少会 logger 记 fail，不静默） | 复现：探针 A 的 `dream/G1`（脚本见证据文件）。**测试草案**：`dream-jobs.test` 构造 2000 行大 raw，绑定捕获 slot，断言 `payload ≤ 200_000` 且分片合并后块数正确。**修法建议**：wash 以"每片 ≤80k 字符/≤300 行"分片，events/people/lexicon 按片摘要再合并（或对单行截断+总预算），保留 evidence 行号映射 |
| **G-2** | P2 | MC-5：本地模型 3 连 | 云端 A/C/E PASS，body soak PASS；本地模型未跑（已知 TODO） | 不在本轮（夜间长测占用 GPU）；验收脚本已存在（`tools/lab.mjs` + `mc-A/C/E`），跑完补 MC-ACCEPTANCE |
| **G-3** | P2 | CA-5：缓存"任何场景不劣化" | 只有 cache-10 与 MC L1 两个场景；全称不可证 | 判据改成"分场景基线 + 新场景必须登记"；新增场景模板：跑一次 cache-probe compare，填 CACHE-MODEL §5.4 |
| **G-4** | P2 | DL-7：崩溃后待投递不丢 | delivery 纯内存；进程崩溃丢队列（消息可被上游重发，但 ICL 自身无持久队列） | 若需要：`.state/delivery.jsonl` 追加+启动重放；测试草案：restart 后 pending 数量恢复 |
| **G-5** | P2 | PR-4：工具 description 自足 | 无评分量表，纯定性 | 判据：新会话仅凭 description 完成 5 个任务（world/recall/time/memo/mcb_status）+ 人工 1–5 分；纳入 `docs/quality` 固定脚本 |
| **G-6** | P2 | FC-5：紧急优先级可信 | 同进程 `from.plugin`/`alarm` 可伪造（TIME §9 已声明） | 判据改成"信任边界=同进程插件，非安全隔离"；若要多进程，需 principal 白名单（HANDOVER §5.5） |
| **G-7** | P2 | TM-9：长期日程验收 | 单测覆盖周/跨天解析，端到端只有 4h22m | 用 `loop-host --long` 虚拟时钟跑 7 天场景（time 已有 `tools/time-accept` 9/9；扩一档 S7=跨周） |
| **G-8** | P2 | MM-6：检索成本 | `scanLimit=5000` 硬上界，但每消息线性扫描（已做单次 JSON 解析） | 加"命中即停/按 namespace 计数短路"；基准脚本：10k 条库 × 1000 次 search 计时 |
| **G-9** | P2 | SF-5：静默吞异常残留 | 60+ `catch {}`（多为合理兜底），少数可改进 | CI 规则（eslint `no-empty` + 自定义检查"新 catch 必须带 comment/report"）；先列出 top 10 需改 |
| **G-10** | P2·判据 | LC-4：DSH checkpoint vs dream | 仓库内不可判定 | 判据改为"ICL 侧不引入压缩 + 记录 DSH 配置快照"；等有长会话样本再判 |

**P0 结论：本轮未发现 P0。** 13 个域里除 G-1 外的未达成项是已知外部验收（本地 MC）或设计取舍（投递不持久化）。**G-1（dream 输入无上界，P1）已在本轮修复**：wash 单行截断+总量预算（头 40%/尾 60%，保留原话绝对行号）、events 按片（≤80k 字/片、≤400 行/片）摘要后合并、people/lexicon/cleanup 材料预算 + 最后一道 `clipPayload` 保险；单片失败只记 `dream.shard-fail` 并继续，已完成块保留。证据：新测试 2 条（大 raw 分片≤200k / 单片失败不拖垮）+ 全仓 **454/454** + 探针 G1 复跑 payload **40,253 字符**。

## 5. 达成度汇总

| 结论 | 条数 | 说明 |
|---|---|---|
| **达成** | **56 条判据**（覆盖全部 13 个域；含本轮修复的 LC-3） | 其中 4 个域的**全部**判据达成：单会话锁(2)、QQ phase 边界(4)、DSH 接线(4)、重启恢复(4) |
| **部分** | 3 条 | TM-9 长周期日程验收、MM-6 检索成本（有硬上界但线性）、SF-5 静默 catch 残留 |
| **未达成** | 2 条 | MC-5 本地模型 3 连（P2 已知 TODO）、DL-7 崩溃丢待投递（P2 设计取舍）；原 LC-3（dream 输入无上界，P1/G-1）**本轮已修** |
| **判据有问题** | 4 条 | CA-5 缓存全称、PR-4 描述自足性、FC-5 紧急优先级可信、LC-4 DSH checkpoint vs dream |
| 合计 | 65 条判据 | 13 个域（56 达成 / 3 部分 / 2 未达成 / 4 判据有问题） |

## 6. 复现与测试草案（可交给下一轮）

1. **G-1 dream 输入上界**：`node <探针A> <repo>`，看 `dream/G1` 的 `payload=...`；期望修复后 ≤200_000。测试骨架：
   `dream-jobs.test` 新增「大 raw 分片」用例（2000 行、每行 500 字；捕获 slot 请求；断言 payload 上界 + `degraded:true` 标记）。
2. **G-4 投递持久化**：新增 `.state/delivery.jsonl` 落盘/重放；`delivery` 测试：push → 模拟重启 → 未 ack 条目仍在。
3. **G-7 长期日程**：`tools/loop-host.mjs --long` 场景扩 S7（跨 7 天、每周安排 + 静音跨天），断言 system 快照数 ≤ 天数×1。
4. **G-5 描述自足性**：`tools/` 下加固定脚本：新会话只读工具描述完成 5 个任务，输出评分表到 `docs/quality/`。
5. **G-8 检索成本**：基准脚本 10k 条 × 1000 query 计时，登记到 `docs/quality`（已有 host 级探针可直接复用）。

## 7. 方法论边界（诚实声明）

- 本审计是**逻辑/结构可达性**证明：host 级探针 + 已有 lab 落盘证据；**没有**重新跑真实模型/真实 MC/真实 QQ。
  所以"模型行为类"目标（描述自足、人格像不像）只能标"判据有问题"，不能判达成。
- 全称结论（"任何场景"）一律降级为"已测场景内成立"，除非有穷举/形式化证据。
- 夜间 MC 长测（54838/57101）与本地模型全程未触碰。
