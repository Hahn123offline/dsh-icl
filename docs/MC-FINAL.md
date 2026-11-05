# MC 最终接入设计（待用户拍板）

> 状态：body-only 已验证；ICL 核心接缝已跑通过一次；以下是把 MC 正式接入 ICL 的建议，不是已定方案。

## 1. 已验证的事实

- `mc-body` 独立进程，mineflayer；不 import ICL。
- 1.21.4 flat/peaceful 测试服（54837）可重复跑。
- `flat30-final`：30 分钟、743 块、92 trips、0 safety_stop / 0 death / 0 emergency，routine 以 `done(duration)` 正常结束。
- `latest2`：12/12 目标、picked 3、背包有 dirt。
- ICL MC short：`mcb_status` / `mcb_task` / `mcb_events` 通过；任务事件以 `plugin:mc` notice 进入 DSH，不是 user。
- real mc-link smoke：真实 body + 真实插件跑通 11 工具中的 look/inventory/map/scan/status/task/tasks。
- **266 个测试 / 49 文件通过。**

## 2. 建议的最终形状

```text
ICL 主会话（唯一 brain / 唯一发言者）
  └─ mc-link 插件
       ├─ 11 个常驻 mcb_* 工具
       ├─ 事件 → signals → steer(plugin:mc)
       └─ mc:status / mc:guide / mc:play
            │ mc-body/v1 HTTP
            ▼
mc-body（无模型、无 token）
  ├─ 任务队列 / 台账 / deadline / 幂等
  ├─ 技能：mine/goto/patrol/explore/follow/routine/chat
  ├─ 反射：低血/掉氧/危险/卡住/死亡/断线
  └─ 安全：暂停、隔离、回安全点
```

**不把 40 个 mc_* 工具给 ICL**；需要时按 A/B 档逐步开放。

## 3. 当前 mcb_* 工具（11）

- `mcb_servers`、`mcb_lan`、`mcb_join`、`mcb_leave`
- `mcb_status`、`mcb_look`、`mcb_scan`、`mcb_map`、`mcb_inventory`
- `mcb_do`（组合/长任务/控制/事件/发言）
- `mcb_help`（按需技能文档）

## 4. 需要用户拍板的点

### 4.1 工具面

推荐保留当前 7 个基础工具（另加连接/退出的 4 个），先不开放：

- `mcb_move` / `mcb_dig` 这种单步动作；
- 战斗/建造/交易/箱子等 B 档能力。

理由：任务抽象更省 token、更适合本地模型、更安全。若实测“身体感不足”，再按 [MC-AGENT-TOOLS.md](MC-AGENT-TOOLS.md) 的 A/B 档补 1–3 个，而不是全开。

### 4.2 反射默认

建议：

- `autoEscape` / `autoEat` / `autoTool` 默认开；
- `autoDefense` 先 `fleeOnly`，稳定后再允许反击；
- 低血拒绝 resume、连续 3 次死亡隔离；
- 反射必须报告，不静默续跑。

### 4.3 本地模型

- 本地模型只替换 ICL 的 model route，不放进 body；
- GPU 恢复后单独 `icl-mc-local` profile；
- body 不依赖模型，模型失败时 body 仍能安全停止。

### 4.4 第三方 MC agent

`dsh-mc-agent` 继续作为行为参考/独立 actor，不 import、不复制。若以后需要它完整能力，作为黑盒独立会话接，不和 ICL 抢同一个 bot。

## 5. 还缺的验证

- 一次 desktop 重启后，用新 11 工具跑 ICL MC short（验证 manifest/工具面）；
- 一次 ICL 失败/暂停/恢复场景（验证 epoch/lease 与 claim audit）；
- 本地模型恢复后的 `icl-mc-local` 测试。

## 6. 证据位置

- `.state/mc-soak/flat30-final/`：30 分钟 body-only；
- `.state/mc-soak/latest2/`：pickup/inspect；
- `.state/mc-soak/flat5/`：目标完成；
- `.state/loop/runs/...`：ICL MC short；
- [MC-CONTRACT.md](MC-CONTRACT.md)、[MC-CONTROL.md](MC-CONTROL.md)、[MESSAGES.md](MESSAGES.md)。
