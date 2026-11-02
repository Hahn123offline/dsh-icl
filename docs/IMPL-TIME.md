# 实现清单：Signal + Time

> 设计已冻结（见 `docs/MESSAGE-MODEL.md`、`docs/TIME-MODULE.md`）。
> 按里程碑推进，每个里程碑自带测试，不跨里程碑并行。

## M1 信号层（`signals` 服务）

- [x] `SIGNAL_KINDS = wake | goal | notice | content | event`（冻结，`signals.mjs`）
- [x] 校验：`from.plugin` 必填、`kind` 合法、`text` 或 `meta` 至少一个、`to` 合法
- [x] 幂等：重复 `id` 丢弃，计数
- [ ] 路由
  - [x] `to:'model'` → 先过 gate，再交给 deliver（默认 deliver = delivery）
  - [x] `to:'plugin'` → 事件总线（`on(filter, fn)`，按 `kind/from/tags` 过滤）
  - [x] `to:'focus'` → 请求交给 gate（时间模块决定；M5 接 focus）
- [x] 计数：`stats() → {accepted, blocked, deduped, emitted, failed}`
- [x] 测试：`signals.test.mjs`（10 条）

## M2 时间模块骨架（`time` 插件）

- [x] 状态机：`awake / sleeping / paused`，状态写 `state/time.json`
- [x] 日程表：`at`、`role`、`message`、`durationMin`、`allow[]`（`time` 插件）
- [ ] 时钟：`time.now()` 已提供；`ctx.now` 接管未做
- [x] 队列：FIFO、保留来源、`expiresAt` 显式才过期、`skip/delay`
- [x] gate 实现：`from/any/tags/kinds`，纵向拦截（`allowMatch`）
- [x] 醒来批释放："你睡觉时积压了 N 条"
- [x] 重启：释放全部并报错（测试覆盖）
- [x] 世界状态：时间 / 日程 / 阶段 / 积压

## M3 goal

- [ ] `goal` 创建：`until`（时间点或 afterMin）、`focus`、`resumeOnStop`
- [ ] 模型停下 → 发"你在目标内，若退出请卸载目标"
- [ ] 卸载 → 自动释放绑定的 focus
- [ ] 按日程创建 goal
- [ ] 到期 → 发"目标结束"，不再唤醒

## M4 工具面

- [x] `time_now` / `time_schedule`（查）
- [x] `time_add` / `time_remove` / `time_skip` / `time_delay`
- [x] `time_sleep` / `time_wake`
- [ ] `goal_add` / `goal_remove`（M3）

## M5 与既有模块对接

- [x] 睡觉时并行调用 dream（缺失不阻塞）
- [ ] 会话：唯一唤醒者 = time（待 M5 接 session）
- [ ] 单会话锁（M5）
- [x] delivery 已是 `to:'model'` 的默认 deliver

## M6 控制面

- [ ] 进程内 API：`time.pause/resume/status/arm/cancel`
- [ ] CLI 入口（外部脚本用）：`tools/time.mjs`
- [ ] 测试脚本：模拟 10 分钟定时器 → 唤醒 → 睡觉 → dream → 醒来

## 验收场景

1. **定时唤醒**：外部 arm 一条 10 分钟后的 wake → 到点会话收到消息
2. **睡觉**：wake(睡眠) → "你困了" → dream 并行 → wake(醒来) → "记忆整理好了"
3. **睡觉期间积压**：sleeping 时 qq 消息入队，醒来批释放，可 skip
4. **白名单**：admin 放行、qq 含"醒醒"放行、其余积压
5. **goal**：创建 goal → 模型停下 → 立即 resume；卸载 → focus 释放
6. **重启**：杀掉进程重启 → 积压释放 + world_status 报错
