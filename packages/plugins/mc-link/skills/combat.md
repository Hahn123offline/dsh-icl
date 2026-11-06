
# 战斗 / 逃跑 / 中断（MC combat）

## 什么时候用

- 有怪挡路/威胁你、需要清掉 → `hunt`；守一个点/保护建筑 → `guard`；在附近持续清怪 → `defend`。
- 打不过/血少/苦力怕贴脸/多只怪 → `flee`（先保命，别硬拼）。
- **普通移动/采集时如果附近有怪，body 会自动躲避（不用你下任务）**；`mcb_status` 的敌对列表 + `auto_defense` 事件能看出它做了什么。

## 下任务

```json
{"op":"task","kind":"hunt","params":{"target":"nearest_hostile","maxDurationMs":60000}}
{"op":"task","kind":"hunt","params":{"target":"zombie","radius":16,"lostTargetMs":10000}}
{"op":"task","kind":"defend","params":{"radius":12,"maxDurationMs":60000}}
{"op":"task","kind":"guard","params":{"radius":8,"maxDurationMs":120000}}
{"op":"task","kind":"flee","params":{"safeDistance":24,"maxDurationMs":30000}}
```

- 下完立刻返回 taskId，**不要 wait 轮询**；用 `tasks` 查进度：`progress` = `{mode,state,target,targetHealth,distance,attacks,health,hostiles}`。
- 可随时 `cancel`；跑的时候 **不要**同时发 mine/goto 长任务（会抢动作）。
- 自动装备：剑优先（按材质）、没剑用斧、有盾自动上 off-hand；低饥饿自动吃。

## 危机中断（很重要）

- 低血（默认 ≤10）、3 只以上敌对、苦力怕 ≤5 格 → 任务会 **自己中断**：先做一次保命 emergency，然后 `task_failed: combat: low-health|creeper-near|too-many`。
- 收到这个失败：**别立刻原样重下**；先 `mcb_eat`/补血、跑远、或改用 `flee`；然后换个落单目标。
- 苦力怕近身不要贴脸打：先垫高/跑开/用弓；`hunt creeper` 只有在它离你 >5 格时才安全。

## 自动躲避（不用你下任务）

- 敌对近身（≤6）时 body 会自动做一次有界规避（吃/后退/逃离），事件 `auto_defense`（含原因/动作/距离）；不会打断你的普通任务。
- 苦力怕贴脸或残血 → 会进入安全暂停（`safety_stop: threat`，alarm 会穿透叫你），之后你先 `mcb_status` 看状态，必要时 `mcb_do {"steps":[{"op":"resume"}]}`。
- 暂停期间附近有怪：reflex 会 `threat-near` 保命（`status.safety.lastReflex` 可查）。

## 失败码

- `combat: no-target`：附近没目标（15s）→ 换 target/换地方/`mcb_scan`。
- `combat: target-lost`：目标跑了/消失 → 重新 hunt 或换目标。
- `combat: aborted-danger`：低血/苦力怕/多敌 → 先保命（已自动做一次）。
- `combat: timeout`：没打死 → 换武器/找落单/补给。
- `flee: cornered` / `flee: timeout`：逃不掉/没跑到安全距离 → 垫高/挖坑/换方向。
