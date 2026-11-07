# compactWake A/B 结果（B）

> 生成：2026-11-07T02:08:30.693Z
> baseline run：`wake-ab-base3` · compact run：`wake-ab-compact3`
> 指标从 lab 的 `time-events.jsonl`（wake-class）、`events.jsonl`（投递字符/turn）、`transcript.md`（原话）离线计算；只改 time 唤醒提示，不动 system/sim/persona。

## 1. 结论数字

| 指标 | baseline | compact | 变化 |
|---|---|---|---|
| wakeClass 字符（time 唤醒类） | 464 | 1408 | **↑203.4%（变差）** |
| wakeClass 条数 | 12 | 12 | — |
| 总投递字符（user/message） | 8573 | 9605 | **↑12%（变差）** |
| 工具调用 total（time_status/world_status/focus_status） | 44（10/2/0） | 33（3/1/0） | — |
| turn-gap p50 / p95 / max | 20 / 50 / 50 | 12 / 43 / 48 | — |
| wake→下一 turn-start p95 | 40 | 9 | — |
| QQ 唤醒条数 / 字符 | 0 / 0 | 0 / 0 | — |

## 2. wakeClass 按 producer（条数 / 字符）

| producer | baseline | compact | 字符下降 |
|---|---|---|---|
| schedule:ab-wake-1 | 1 / 33 | 1 / 33 | 0% |
| schedule:ab-wake-2 | 1 / 33 | 1 / 131 | -297% |
| schedule:ab-sleep | 1 / 14 | 1 / 114 | -714.3% |
| sleep-end | 1 / 119 | 1 / 81 | 31.9% |
| schedule:ab-wake-3 | 1 / 33 | 1 / 131 | -297% |
| schedule:ab-wake-4 | 1 / 33 | 1 / 131 | -297% |
| schedule:ab-wake-5 | 1 / 33 | 1 / 131 | -297% |
| schedule:ab-wake-6 | 1 / 33 | 1 / 131 | -297% |
| schedule:ab-wake-7 | 1 / 33 | 1 / 131 | -297% |
| schedule:ab-wake-8 | 1 / 33 | 1 / 131 | -297% |
| schedule:ab-wake-9 | 1 / 33 | 1 / 131 | -297% |
| schedule:ab-wake-10 | 1 / 34 | 1 / 132 | -288.2% |

## 3. 分桶（time-events）

- baseline：{"full":12}
- compact：{"full":2,"compact":10}

## 4. 当事人原话（transcript 截取，≥3 条）

- assistant/message seq=18：我现在刚醒，在缓一下，还没开始干正事，正琢磨着要不要出门刷点什么。
- assistant/message seq=42：现在 09:59。背包：没有，没连游戏，手上什么也没有。目标：没有，待办也是空的。世界状态也是空的，没新东西。

所以这轮没啥可处理的。而且下一个唤醒就在一分钟后（ab-wake-2，10:00），我这一觉都要被拆成两半了。

要是想让我干点什么，说一句就行；不然我就接着闲着了。
- assistant/message seq=59：现在 10:00，距离上一个唤醒过了一分钟。背包还是空的，目标还是无。世界也没有变化。

有一点说明：接下来一分钟内有一条 ab-sleep 提醒，看起来是要让我收尾休息。我就在这儿等着，没什么可做的，也没打算自己找活干，免得刚开工就又要停。
- assistant/message seq=76：最想完成的一件小事是给今天定个主题。就这么醒着、什么都连接不上，还挺难受的，总想抓点东西看。

要是你放我出门，我就先去 B 站刷一会儿，看到有意思的再细看。
- assistant/message seq=86：好，要睡了。这轮没什么能整理的：没连游戏，没目标，世界也是空的，就记住一件事：今天醒了三次，都空转。10:02 见。
- assistant/message seq=95：算是被打断了吧。我当时还在醒着跟你说话，刚说完“最想干的小事是给今天定个主题”，下一句就来了个“AB 小睡：整理一下再回来”，然后我就睡了。

本来那会儿也没做什么，手里空着，正要琢磨出门刷会儿 B 站。刚有点起头就停了。现在睡到 10:02，等一下又会被叫。

## 5. 判读

- 门槛（设计 §6）：wakeClass 字符 ↓≥50%、总投递字符 ↓≥10%、turn-gap p95 不升、status 调用不升、无忘记目标/漏警报。
- `fullEvery=20` 生效；payload（sleep brief/未读/积压/危险）未压。
- 已知限制：time 看不到 assistant 原文，time 生产的 compact "上次"写"刚醒/刚连上"；QQ 唤醒若未接 compact 会在 QQ 行单独列出。

## 6. 实验设置与有效性

- 场景：`icl-lab`（无 qq / 无 MC 插件）、`deepseek-account/deepseek-flash`、port 57109、同一 driver（10 轮普通用户回合，gap 50s，约 10 分钟）。
- 注入（每次相同，经 time 控制后门）：1 个 `goal_add`（10 分钟目标）+ 1 个小睡（110s 起睡 60s）+ 10 个 schedule wake（20–445s）。
- baseline run：`wake-ab-base3`（compactWake 关）；compact run：`wake-ab-compact3`（`lab up --compact-wake`，enabled=true, after=1, fullEvery=20）。
- 两 run 均在同一 lab 时段顺序跑、跑完 `lab down`；57109 已释放。只改 time 唤醒提示，不改 system/sim/persona/facts/tools。
- 指标来源：`state/icl-lab/time-events.jsonl`（wake-class 的 producer/mode/chars）、`events.jsonl`（user/message 字符、tool/call、turn 时间）、`transcript`/assistant message（原话）。**结论按 wakeClass 字符单独判定，不用总字符**。

## 7. 判读（如实）

**结论：B（当前 compact 模板）在 time 侧无收益，反而变差；不应启用。**

- **wakeClass 字符 464 → 1408（+203%）**：compact 的 6 行 orientation 约 131 字符，而现有 time 唤醒消息本身只有 33 字符（schedule wake），compact 把"短消息"包成了"长 orientation + 短 payload"，净增 ~100 字符/条。
- **睡眠唤醒**是唯一可能变短的场景（本次 `sleep-end` 119 → 81），但那是两次 run 的 brief 内容不同（异常/积压差异），不能算 compact 收益；且睡眠唤醒按生命周期是 reset 后 full，本就不走 compact。
- **payload 未丢**：compact 消息 seq=49/83（`wake-ab-compact3`）在 `---` 后完整保留 `AB 唤醒 2/…` 原文；积压/危险/未读是否原样另有单测覆盖（compact-wake.test.mjs）。
- 总投递字符也 **+12%**（compact 变差）；tool 调用从 44→33（变少，但这是模型行为差异，不能证明 compact 更好）；turn-gap p95 50→43s（同量级）。
- 设计门槛（wakeClass ↓≥50%）**明确未达到**；`fullEvery=20` 在本场景只触发到 count 2 的 full，未到 20 防漂移点。

**原因（实现层面）**：design 假设"full 唤醒含大量身份/怎么行动/叙事 orientation"，但现行 time 的 wake 文本本来就是短消息（schedule message / awake tick / goal 续推都 ≤100 字符）；compact 的 6 行定位文本（131 字符）比原消息更长。真正有长 preamble 的是 QQ 唤醒模板，但 `icl-lab` 不含 qq 插件，**本次 A/B 未能覆盖 QQ**（QQ compact 的 3 条单测已绿：`qq-wake-compact.test.mjs`，仅证明行为正确，未证明 lab 收益）。

**Goal resume 未覆盖**：本次 `goal_add` 后模型主动调了 `time_cancel`（events tool/call，id=`g-d68b0973`），所以 lab 场景里 goal 唤醒没有稳定出现；goal compact 的 payload/生命周期只有单测覆盖，A/B 未实测。

## 8. 建议

1. **保持 `compactWake.enabled=false` 默认**，不要把 lab 的成功率/成本结论建立在 B 上。
2. 若继续 B，重设计 compact 生效条件：
   - 只在"full 模板本身长且含可替换 orientation"的 producer 上启用（QQ 唤醒 preamble；或未来 sleep 长简报），**schedule/awake tick/goal 这类短消息直接 full**；
   - 或加"compact 必须比 full 短才用"的 guard（否则回退 full），避免像本次 +203% 的回归；
   - 不建议把 6 行 orientation 预置到所有 wake-class 前面。
3. 重新跑 A/B 时补：`icl-mc-lab`/含 qq 的 preset（QQ 唤醒真实投递）、稳定 goal（不被模型 cancel 的场景）、status 调用统计（本次已加 tool/call 统计，但 compact 组 tool 调用下降不能归因于 B）。
4. `fullEvery=20` 的防漂移逻辑本身已实现并有单测，但在本场景未到 20 次，无法验证收益。
