# 蓝队 READINESS 探针原始输出（2026-11-05T16-13-04）

- 仓库：`C:\DSH\icl-wt\misc`（已 merge master；本次审计 HEAD = (missing)）
- 方法：host 级虚拟时钟 + 假 DSH ctx + 模型桩；**未起 lab、未连 MC、未占用 57101/57104/54838、未用 GPU**
- 测试基线：`npm test` → 452/452（core 362 + mc-body 34 + mc-link 56）；证据见 READINESS-MATRIX.md §1

## 探针 A（35 项：memory / time / focus / delivery / session / recovery / prompt / cache / silent / dream / wiring）

```json
{
 "summary": {
  "total": 35,
  "pass": 35,
  "fail": 0,
  "byDomain": {
   "memory": {
    "pass": 5,
    "fail": 0
   },
   "time": {
    "pass": 7,
    "fail": 0
   },
   "focus": {
    "pass": 3,
    "fail": 0
   },
   "delivery": {
    "pass": 4,
    "fail": 0
   },
   "session": {
    "pass": 2,
    "fail": 0
   },
   "recovery": {
    "pass": 3,
    "fail": 0
   },
   "prompt": {
    "pass": 2,
    "fail": 0
   },
   "cache": {
    "pass": 3,
    "fail": 0
   },
   "silent": {
    "pass": 3,
    "fail": 0
   },
   "dream": {
    "pass": 1,
    "fail": 0
   },
   "wiring": {
    "pass": 2,
    "fail": 0
   }
  }
 },
 "checks": [
  {
   "domain": "memory",
   "id": "M1",
   "verdict": "PASS",
   "criterion": "未注册命名空间写入必须显式报错（不静默丢数据）",
   "evidence": "命名空间没有注册：nope"
  },
  {
   "domain": "memory",
   "id": "M2",
   "verdict": "PASS",
   "criterion": "写入→检索→游标去重→遗忘 全链路",
   "evidence": "first=[今天] 晚上吃了酸菜鱼。\n[事件 · 今天 · 随手记]  / second=这几条刚才已经给过你了（就在上面的上下文里）；要找别的，把要"
  },
  {
   "domain": "memory",
   "id": "M3",
   "verdict": "PASS",
   "criterion": "没有绑定嵌入时检索仍可用（退化不报错），且 index() 返回 false 不抛",
   "evidence": "hits=1, indexed=false, embedded=false"
  },
  {
   "domain": "memory",
   "id": "M4",
   "verdict": "PASS",
   "criterion": "重启后记忆库仍在（同 db 文件、新 host）",
   "evidence": "rows=1"
  },
  {
   "domain": "memory",
   "id": "M5",
   "verdict": "PASS",
   "criterion": "whois 按身份查档案 / 按名字给候选",
   "evidence": "exact+candidate 均返回"
  },
  {
   "domain": "time",
   "id": "T1",
   "verdict": "PASS",
   "criterion": "单次唤醒：到点只发一次，重复 tick 不重复投递",
   "evidence": "first=到点了"
  },
  {
   "domain": "time",
   "id": "T2",
   "verdict": "PASS",
   "criterion": "睡眠：外部消息进积压不投递；醒来合并摘要只发一次",
   "evidence": "backlog=0 afterWake=1 批"
  },
  {
   "domain": "time",
   "id": "T3",
   "verdict": "PASS",
   "criterion": "睡眠中 turn-end 事件不进积压（事件总线不被静音）",
   "evidence": "accepted=true backlog 0→0"
  },
  {
   "domain": "time",
   "id": "T4",
   "verdict": "PASS",
   "criterion": "积压有界：洪水不撑爆（≤ maxQueue，且保 mention/private）",
   "evidence": "queue=50（≤50），mention 保留"
  },
  {
   "domain": "time",
   "id": "T5",
   "verdict": "PASS",
   "criterion": "同一 signalId 不重复入队",
   "evidence": "queue=1"
  },
  {
   "domain": "time",
   "id": "T6",
   "verdict": "PASS",
   "criterion": "静音锁：到期自动解除（无需人工）",
   "evidence": "expired ok"
  },
  {
   "domain": "time",
   "id": "T7",
   "verdict": "PASS",
   "criterion": "目标：turn-end 续推、轮次上限后结束、睡眠时不续推",
   "evidence": "goals=1 step1=你在目标内：下矿挖铁（还剩 1 轮）。id=g-6292eda3，不用时用 ti"
  },
  {
   "domain": "focus",
   "id": "F1",
   "verdict": "PASS",
   "criterion": "闸门：普通消息进积压、mention 按 pierce 穿透、interruptible:false 全拦",
   "evidence": "pierce + sacred ok"
  },
  {
   "domain": "focus",
   "id": "F2",
   "verdict": "PASS",
   "criterion": "焦点释放：积压合成一条摘要，且走 signals（被 time 静音也能拦）",
   "evidence": "你离开焦点期间，别处积压了 3 条：\n· [qq:group:0] +1：别处0"
  },
  {
   "domain": "focus",
   "id": "F3",
   "verdict": "PASS",
   "criterion": "过期租约不复活 / 快照恢复丢弃过期",
   "evidence": "expired ok"
  },
  {
   "domain": "delivery",
   "id": "D1",
   "verdict": "PASS",
   "criterion": "幂等去重：重复 id 只收一次；被拦不占 id（放行后可重试）",
   "evidence": "dedupe+retry ok（blocked=test）"
  },
  {
   "domain": "delivery",
   "id": "D2",
   "verdict": "PASS",
   "criterion": "gate 抛错 fail-open 并计数（坏 gate 不能静音一切）",
   "evidence": "fail-open ok"
  },
  {
   "domain": "delivery",
   "id": "D3",
   "verdict": "PASS",
   "criterion": "运行期投递 gate（addGate）：睡眠/静音能拦插件直接 push",
   "evidence": "push-time gate ok"
  },
  {
   "domain": "delivery",
   "id": "D4",
   "verdict": "PASS",
   "criterion": "nack 重试耗尽计入 droppedCount（不静默消失）",
   "evidence": "dropped=1"
  },
  {
   "domain": "session",
   "id": "S1",
   "verdict": "PASS",
   "criterion": "单会话：第二次 claim 必须抛错；释放后可换会话",
   "evidence": "已经指向会话 s1，不能再指向 s2"
  },
  {
   "domain": "session",
   "id": "S2",
   "verdict": "PASS",
   "criterion": "DSH 插件层：第二个会话同步拒绝（isOurSession/claim）",
   "evidence": "ICL 只允许一个会话：已占用「C:/tmp」，拒绝新会话 b。请回到原会话，或先关闭它。"
  },
  {
   "domain": "recovery",
   "id": "R1",
   "verdict": "PASS",
   "criterion": "time.json 重启后恢复 schedules/goals/静音锁",
   "evidence": "schedules=1 goals=1 muted=true"
  },
  {
   "domain": "recovery",
   "id": "R2",
   "verdict": "PASS",
   "criterion": "focus.json 恢复（桥 loadFocus）：租约与积压都在",
   "evidence": "current=持久化的事 backlog=1"
  },
  {
   "domain": "recovery",
   "id": "R3",
   "verdict": "PASS",
   "criterion": "坏状态文件不崩：time.json/focus.json 内容非法时插件仍能起",
   "evidence": "phase=awake"
  },
  {
   "domain": "prompt",
   "id": "P1",
   "verdict": "PASS",
   "criterion": "人格（20）→ 仿真（25）→ 事实（≥800）顺序稳定；persona 无工具名",
   "evidence": "pluginFailures=0 sections=icl:simulation,world,persona,focus,time,mc:status,mc:skills"
  },
  {
   "domain": "prompt",
   "id": "P2",
   "verdict": "PASS",
   "criterion": "事实段无内容时消失（不占空行/不占前缀）",
   "evidence": "empty→消失 / 有内容→出现"
  },
  {
   "domain": "cache",
   "id": "C1",
   "verdict": "PASS",
   "criterion": "静态 system 段不含事实；事实走 systemPrompt.context(order 850)",
   "evidence": "static=你是小千。 facts=时间：08:01"
  },
  {
   "domain": "cache",
   "id": "C2",
   "verdict": "PASS",
   "criterion": "facts 节流：同一 turn 只刷新一次；focus 变更下一步刷新（stale≤1）",
   "evidence": "refreshes=3 first=时间：08:00；焦点：无 afterFocus=时间：08:01；焦点：下矿"
  },
  {
   "domain": "cache",
   "id": "C3",
   "verdict": "PASS",
   "criterion": "<icl-context> 注入用 producer-owned kind（plugin:icl），不冒充 DSH runtime-context",
   "evidence": "kind=plugin:icl form=notice"
  },
  {
   "domain": "silent",
   "id": "X1",
   "verdict": "PASS",
   "criterion": "dream 由信号触发时结果写日志（失败带原因，不丢）",
   "evidence": "ok=false jobs=wash:skip(no-raw raw=(空)),events:fail(插槽 dream-chat 还没有绑定模型),people:skip(no-note"
  },
  {
   "domain": "silent",
   "id": "X2",
   "verdict": "PASS",
   "criterion": "compaction 默认不在 DEFAULT_PLUGINS（不再\"只加不减\"）",
   "evidence": "plugins=15，compaction 不在其中"
  },
  {
   "domain": "silent",
   "id": "X3",
   "verdict": "PASS",
   "criterion": "工具错误可操作：editor 读不到带原因、截断有标记",
   "evidence": "errors actionable"
  },
  {
   "domain": "dream",
   "id": "G1",
   "verdict": "PASS",
   "criterion": "繁忙一天：dream 请求体积有上界（目前未必达成，记录实测）",
   "evidence": "dream 单次请求 payload=1009812 字符（判定上界 200k：超界）；原文=2000 行"
  },
  {
   "domain": "wiring",
   "id": "W1",
   "verdict": "PASS",
   "criterion": "默认装配全部启用、工具面数量稳定、重复装配无变化",
   "evidence": "enabled=15 tools=44 stable=true"
  },
  {
   "domain": "wiring",
   "id": "W2",
   "verdict": "PASS",
   "criterion": "bridge：turn-end 触发 resumeGoals（事件→目标续推链路）",
   "evidence": "你在目标内：写记忆层（还剩 4 轮）。id=g-43ef3dce，不用时用 time_cancel 取消，别留着空跑。"
  }
 ]
}

```

## 探针 B（10 项：模型桩 / 坏输入 / 幂等 / MC / QQ / DSH / 长会话）

```json
{
 "summary": {
  "total": 10,
  "pass": 10,
  "fail": 0
 },
 "checks": [
  {
   "domain": "dream",
   "id": "B1",
   "verdict": "PASS",
   "criterion": "模型桩返回非 JSON 垃圾 → dream job 不崩、按 0 块收尾并记账",
   "evidence": "events={\"job\":\"events\",\"ok\":true,\"blocks\":0,\"notes\":1,\"deferred\":1}"
  },
  {
   "domain": "dream",
   "id": "B2",
   "verdict": "PASS",
   "criterion": "模型桩返回空串 → 不写块、不抛、job 账本记为已跑（同日重跑跳过）",
   "evidence": "first={\"job\":\"events\",\"ok\":true,\"blocks\":0,\"notes\":1,\"deferred\":1} second={\"job\":\"events\",\"skipped\":\"already-ran\"}"
  },
  {
   "domain": "recall",
   "id": "B3",
   "verdict": "PASS",
   "criterion": "坏 cursor / 不存在 key：安全降级不抛",
   "evidence": "cursor 垃圾可用、forget 缺 key 有明确回执"
  },
  {
   "domain": "persona",
   "id": "B4",
   "verdict": "PASS",
   "criterion": "人格卡：空值拒绝、越界回滚有明确错误（不是静默）",
   "evidence": "empty=人格卡不能是空的 rollback=没有可回滚的版本"
  },
  {
   "domain": "signals",
   "id": "B5",
   "verdict": "PASS",
   "criterion": "过期信号直接拒绝、不投递；stats.expired 计数",
   "evidence": "{\"accepted\":false,\"expired\":true,\"id\":\"e1\"}"
  },
  {
   "domain": "memory",
   "id": "B6",
   "verdict": "PASS",
   "criterion": "衰减：旧条目分数低于新条目（虚拟时钟推 60 天）",
   "evidence": "new=1.000 > old=0.135"
  },
  {
   "domain": "mc",
   "id": "B7",
   "verdict": "PASS",
   "criterion": "MC 不变量：body 不含模型/目标生成（只执行任务），link 侧任务事件带 taskId",
   "evidence": "body 无模型调用；link 事件带 taskId；契约含唯一决策者"
  },
  {
   "domain": "qq",
   "id": "B8",
   "verdict": "PASS",
   "criterion": "QQ 入站只读不变量：connector 无 ws.send；phase1 出站独立文件 + 三把钥匙",
   "evidence": "connector 零发送；outbound 仅私聊+审批；index 不连接出站"
  },
  {
   "domain": "dsh",
   "id": "B9",
   "verdict": "PASS",
   "criterion": "DSH bundle：preset 声明合法、dsh-icl README/bundle 断言由测试覆盖",
   "evidence": "bundle={\"patch\":[\"./presets/icl.patch.yml\"]}"
  },
  {
   "domain": "long",
   "id": "B10",
   "verdict": "PASS",
   "criterion": "长会话：ICL 默认不压缩（100 条历史 assemble 仍只返回注入段），不重写历史",
   "evidence": "assemble=0 字；history 未被改写（只读）"
  }
 ]
}

```

## 探针 C（3 项：睡中重启 / steer 失败重试 / raw 输入卫生）

```json
{
 "summary": {
  "total": 3,
  "pass": 3,
  "fail": 0
 },
 "checks": [
  {
   "domain": "recovery",
   "id": "C1",
   "verdict": "PASS",
   "criterion": "睡中重启：phase/backlog 落盘，重启后在 sleepUntil 之后 tick 能醒来并释放积压",
   "evidence": "persisted phase=sleeping queue=1 → 重启后 phase=awake、投递 1 批"
  },
  {
   "domain": "delivery",
   "id": "C2",
   "verdict": "PASS",
   "criterion": "steer 抛错（会话忙）：nack → 重试后仍能送达，不丢消息",
   "evidence": "首次失败(sent=0, pending=1) → 重试成功(sent=1)"
  },
  {
   "domain": "dream",
   "id": "C3",
   "verdict": "PASS",
   "criterion": "raw 输入卫生：runtime-context / <icl-context> 不进原文；真实消息与工具结果进",
   "evidence": "raw rows=2（过滤 2 条系统上下文）"
  }
 ]
}

```

## 复跑

探针脚本在本轮临时目录（未入库）；要点与期望值见 `docs/READINESS-MATRIX.md` §6「复现与测试草案」。
所有探针都只写系统临时目录，跑完自清理。

## 修复后复跑（G-1：dream 输入预算，本轮修复）

- `npm test` → **454/454**（新增 2 条：大 raw 分片 ≤200k / 单片失败不拖垮）。
- 探针 A 复跑：35/35 PASS；`dream/G1` 证据变为 **单请求 payload = 40,253 字符**（修复前 1,009,812）。
- 修复内容：wash 单行截断（默认 400 字）+ day log 总量预算（默认 200k，头 40%/尾 60%，保留原话绝对行号）；
  events 分片（默认 ≤80k 字/片、≤400 行/片，最多 24 片，超出保留头尾）；people/lexicon/cleanup 材料预算；
  `ask()` 最后一道 `clipPayload` 保险；片失败只记 `dream.shard-fail`，已完成块保留。
