# 时间模块（Time）设计 v2

> 状态：**设计收敛中**。2026-11-03 第二轮，吸收了"wake 是消息类型""goal 与时间联动"
> "时间是纵向拦截、focus 是横向命名空间"三条修正。仍未实现。

## 1. 一句话

时间模块是**会话的唯一时钟、唯一唤醒者、唯一纵向拦截层**，并兼职**与时间联动的 goal**。

## 2. 三种事件，一个通道

时间模块向会话发的东西只有一种形式：**一条消息**。消息带"类型"，类型决定它意味着什么。

| 类型 | 含义 | 是否带持续周期 |
|---|---|---|
| `wake` | "你现在可以动了" | 可以带 |
| `goal` | "你在目标内，继续做" | 可以带 |
| `notice` | 纯通知（积压释放、日程出错等） | 不带 |

**关键修正**：`wake` 不是"瞬发一次"，而是**消息类型**。它可以带一个持续周期：

```
wake(睡眠, 开始) → 告知"你困了，接下来 8 小时没人打扰"
   ↓ 周期内
wake(睡眠, 结束) → 告知"你睡醒了，昨天的记忆整理好了"
```

测试时把周期压到 0：`wake 睡眠 → dream → wake 醒来`，不等真实小时数。

## 3. 睡觉是什么

睡觉**不是特殊类型**，是一个 `wake` 安排：

```json
{
  "id": "night",
  "kind": "wake",
  "at": "23:00",
  "durationMin": 480,
  "message": "你困了。接下来 8 小时不会有人打扰你。",
  "onStart": ["dream"],          // 可选：周期开始时通知的系统事件
  "onEnd": { "message": "你睡醒了，昨天的记忆整理好了。", "call": ["world_status"] }
}
```

- 开始：发 message，触发 `onStart` 事件（dream 订阅它，轻依赖）
- 周期内：穿透消息若被放行，模型按提示词回应（"几点了还在吵"）
- 结束：发 onEnd.message，可要求模型调用 `world_status` 看"睡醒后的状态"
- 模型可以在周期内**自行取消**这次安排（`time.cancel('night')`），等于提前醒来

**没有写死的睡眠时长**：`durationMin` 可选，测试可设 0。

## 4. goal：与时间联动的持续目标

goal 是"让模型持续轮转"的东西，wake 不会。

```json
{
  "id": "g-mc",
  "theme": "玩我的世界",
  "until": "2026-11-03T12:00",     // 或 afterMin
  "focus": "mc",                    // 进入哪个注意力空间（自动 enter/release）
  "resumeEveryMin": 10,             // 忘了继续时，多久后 resume 一次
  "autoResume": true
}
```

规则：

- goal 到点开始 → 发 `goal` 消息（"你在目标内：玩我的世界。退出请卸载目标。"）
- 模型停止动作（回合结束）后，若 goal 仍有效且 `autoResume`，时间模块**立即**（或按 `resumeEveryMin`）再发一条 goal 消息把它拉回来
- **卸载 goal 时自动释放它绑定的 focus**，不需要会话调用两次
- goal 可按日程创建：`"每周日 10:00 启动 goal，主题=玩 2h 我的世界"`
- goal 可绑定 focus：进入 goal 即进入该注意力空间，其它来源按 §6 在时间模块积压

## 5. 两种 resume 模式

时钟不只是"到点发消息"，它有两种 resume：

1. **自定义消息 resume**：发一条任意文本（wake/goal/notice）
2. **系统事件 resume**：触发已注册的系统事件（如 `dream`、`world_status`、自定义事件）

两者都能被其它模块调用：

```js
time.wake({ message, focus, durationMin, onStart, onEnd })
time.resume({ event: 'dream' })          // 触发系统事件
time.arm({ at, message, once: true })    // 外部设计时器
```

## 6. 拦截模型：纵向 vs 横向

```
纵向（time）：按"阶段/日程"全量拦截 —— 睡觉时全部拦下，只放白名单
横向（focus）：按"注意力命名空间"拦截 —— 在 mc 空间时，qq/bili 的消息被拦
```

| 层 | 谁负责 | 拦截依据 |
|---|---|---|
| 时间 | time 模块 | 阶段（awake/sleeping/paused）+ 日程白名单 |
| 注意力 | focus 服务 + time 的判定 | 当前 focus 的 pierce 规则（always/mention/never + glob） |

**只有"拦住"和"放行白名单"两种结果**，不做打分、不做优先级排序（优先级只是队列顺序）：

```json
{
  "phase": "sleeping",
  "allow": [
    { "from": "qq", "keyword": ["醒醒", "着火了"], "level": "always" },
    { "from": "admin", "level": "always" }
  ]
}
```

不在白名单 → 进 time 自己的队列（**不是**核心的跨 Focus 注意力队列）。

## 7. 与 focus 的关系

- focus 是"模型的注意力空间"，可以按需声明：`bilibili`、`mc`、`qq_group=1234`
- 时间模块在睡觉/goal 绑定时会**自己 enter 一个 focus 租约**
- 穿透判定先过 time 的纵向规则，再过 focus 的横向规则；任一层不放行就排队
- **focus 不能删**：它是时间模块的横向拦截器

## 8. 重启语义

```
重启 → 立即释放所有积压 → 大声报错：
  "日程因重启发生错误，已释放所有积压的消息。"
  → 同时把这条写进 world_status
```

不静默、不假装没发生。队列不跨重启保留（释放并告知）。

## 9. 外部控制

不需要 HTTP。外部脚本通过：

- 模型工具（`time_now` / `time_schedule` / `time_arm` / `time_cancel` / `time_goal` / `time_end_turn`？）
- 或本地服务 API（进程内、CLI 调用）

外部脚本以后不直连会话，改为调时间模块的统一 API。

## 10. 时钟唯一来源

`time.now()` 是唯一系统时间；host 的 `ctx.now` 在 time 启用后由它接管，未启用时回落系统时钟。
其它插件不得用系统时间判断"现在是什么时候"（计时/日志可）。

## 11. 单会话

时间模块**只服务一个会话**。核心本身也只有一个会话指针——这是下一节要核实的事。

## 12. 待确认的问题

1. **goal 的 autoResume 频率**：立即 / 固定间隔（如 10 分钟）/ 只在"空闲"时？会不会把会话刷爆？
2. **goal 结束**：到 until 自动卸载并发一条"目标结束"，还是静默？
3. **`time.end_turn` 还要不要**：既然软终止本质是"发一条消息让这一轮结束"，是否只需要 `time.sleep({message})` 这类语义工具，不需要单独的 end_turn？
4. **白名单规则的条件**：只支持 `from + keyword` 够不够？需要正则/发送者/正则组合吗？
5. **取消一个安排**：模型 `time.cancel(id)` 之后，该安排是永久删除还是"仅本次跳过"？
6. **顺序**：睡觉开始时先发"你困了"再触发 dream，还是先 dream 再发？我倾向先发消息、再异步触发 dream（模型先进入睡眠语境）。
