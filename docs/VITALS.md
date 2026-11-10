# 客观负荷与睡眠/做梦（2026-11-10 v1）

## 目标

给模型和用户一组**可管理的系统指标**，不是情绪角色扮演：

- 上下文压力高 → 整理/压缩/收束；
- 繁忙度高 → 减少并行、先收尾；
- 睡眠压力高 → 休息/睡眠。

不做七情，不做每回合 LLM judge。

## 指标

### contextPressure（当前会话）

数据来源：最近一次模型请求的 `usage.inputTokens + cacheReadTokens + cacheWriteTokens` 与 DSH `request/context` 事件里的 `contextWindow`（当前 deepseek-flash 为 1,048,576）；只有没收到 `request/context` 时才退回 dsh-icl 配置的 `contextWindow`（默认 256000）。按 45/70/90 分档。只在 ≥45 时才出现在 facts 里，措辞是：

```text
负荷：上下文 78%（建议整理/压缩）（客观指标，不是情绪）
```

它是**会话局部**的；不代表困，也不直接驱动睡眠。

### workload（繁忙度）

数据来源：最近 15 分钟的 user/assistant 消息数、tool result 数、delivery 积压。
0–100，≥55 才出现在 facts 里。含义是“最近事情多”，不是“心情不好”。

### sleepPressure（睡眠压力）

来自 time 插件，纯规则：

```text
awakeMin / 16h * 75
+ (480 - 上次睡眠分钟) / 480 * 20
+ 夜间时段 5
```

0–100。它只看清醒时长、上次睡眠不足和夜间时段；**contextPressure 不进入这个公式**。
`time_status` 的 `sleepMetrics` 会给出数；`time` facts 也会写“清醒 xh；睡眠压力 n”。

## 睡眠与 dream

- `time_arrange {sleep:true, duration, dream:true|false}`；
- 睡眠和短睡是同一语义：外部普通消息进积压，一般信息不叫醒；admin/alarm 按现有 allow；
- `dream:true` 才在 sleep-start 触发 dream；
- `dream:false` 只休息；
- 产品不再自动创建 `dream:nightly`；只有显式 `dream.scheduleEnabled:true` 才恢复旧机械排程；
- dream 仍按天幂等：一天最多一次记忆整理，第一次带 dream:true 的睡眠生效；
- 当天没有材料时，模型应使用 `dream:false`，或 dream jobs 自然 skip。

## 上下文压缩：独立通道，但已有延迟工具

**sleep + dream 不会缩小 DSH 的模型上下文。**  
Dream 是记忆沉淀；上下文压缩是 DSH 的 compaction。  
现在 bridge 注册了模型工具 `compact_context`（仅在宿主提供原生 `ctx.compaction.compactNow` 时出现）：

- 本轮内不能替换历史，工具只登记；
- `turn/end` 后异步调用原生 `compactNow`，下一轮看到压缩后的历史；
- 没有原生 compaction 服务时明确拒绝，不用 ICL 的摘要插件假装压缩；
- 仍保留 DSH 自带自动 compaction / `/compact` 作为兜底。

如果宿主只有 ICL 的 `compaction` 插件、没有原生 service，`compact_context` 不会注册。

## 配置

- dsh-icl `contextWindow`：产品 256000；
- `dream.scheduleEnabled:false`：产品不排机械 nightly；
- `time_arrange` 的 `dream` 字段：默认 true 兼容旧 sleep；
- `time` facts / `time_status` 会展示 sleepMetrics；
- bridge facts 会展示 contextPressure/workload（仅高阈值时）。

## 验收

- 测试：`time-lock` 的 sleep dream:false；dream-jobs 默认不排 nightly；dsh-bridge 的 token 高时 facts 出现上下文压力；
- 全量 `npm test` 通过。
