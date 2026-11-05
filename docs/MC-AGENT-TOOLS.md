# dsh-mc-agent 的 40 个工具：速查与“值不值得给模型”

> 来源：`dsh-mc-agent/开发说明.md` 的“工具速查（40 个）”。
> 评级只针对“主 ICL 模型是否应该直接看到”，不是工具本身好坏。
>
> - **A**：模型应直接拥有（具身/感知/社交/长期任务）
> - **B**：情境性；按需开放，不宜默认全给
> - **C**：连接/管理/危险/内部工具；由宿主或 body 管，不给模型

## 连接与账户（9）

| 工具 | 干什么 | 评级 |
|---|---|---|
| `mc_status` | 在线/坐标/朝向/血量/饥饿/手持/模式/看门狗/最近聊天 | **A** |
| `mc_lan` | 只听局域网多播公告，返回候选服务器 | C（body 启动时用） |
| `mc_ping` | 已知地址 STATUS ping：版本/人数/MOTD/延迟，不登录 | C（body 启动时用） |
| `mc_connect` | 进服；账户由设置维护，`force:true` 会退服重登 | C（body 生命周期） |
| `mc_accounts` | 列出/搜索/刷新/选定账户；拿不到密码/token | C（设置/宿主） |
| `mc_capabilities` | 支持版本范围、mineflayer 版本、登录方式、上限 | C（诊断） |
| `mc_sessions` | 列出活跃 MC 会话实例 | C（诊断） |
| `mc_disconnect` | 下线，不影响其他会话 | C（body 生命周期） |
| `mc_stop` | 优雅退游戏 + 清后台任务；不中断当前轮 | C（kill switch） |

## 感知（8）

| 工具 | 干什么 | 评级 |
|---|---|---|
| `mc_observe` | 第一人称截图 + 三段式感知（看到/检测到/不确定） | **A**（视觉，成本高） |
| `mc_scan` | 扫描周围方块：按名字找位置/统计 | **A** |
| `mc_map` | 地板层/地表/竖列地形图；竖列看头顶/下方 | **A** |
| `mc_inventory` | 背包、装备、手持 | **A** |
| `mc_events` | 读/消费看门狗事件：聊天、受伤、上线/死亡/重连/断线 | **A** |
| `mc_watch` | 看门狗控制，唯一事件通知通道；唤醒矩阵 | **A**（配置/入口） |
| `mc_config` | 本会话唤醒条件、近距半径、心跳、叫法 | B（宿主/高级） |
| `mc_diag` | 内部诊断：物理/控制位/收包/事件队列/提示词注入 | C（诊断） |

## 动作（13）

| 工具 | 干什么 | 评级 |
|---|---|---|
| `mc_move` | walk/fly/jump/swim；一次 10 秒，未到给 remaining/hint | **A** |
| `mc_act` | look/toward/place/bridge/break/use/useitem/fish/equip/toss/sleep/wake/farm/dismount | B（大而全，可按子动作拆） |
| `mc_attack` | 打实体；按威胁挑目标、盾、放风筝 | B（战斗场景） |
| `mc_shoot` | 射箭/水晶/龙 | B（情境） |
| `mc_station` | 附魔台/铁砧/锻造台 | B（情境） |
| `mc_prep` | 出发前自查（下界/末地缺什么） | B（只读） |
| `mc_fish` | 钓鱼循环 | B（情境） |
| `mc_dig` | 挖方块；按名字/坐标/count；自动换工具；一次 10 秒 | **A** |
| `mc_build` | 批量搭方块/按图施工；一次 10 秒 | B（建造场景） |
| `mc_sequence` | 一串世界交互脚本；整串 10 秒 | B/C（强但复杂，容易变成脚本） |
| `mc_give` | 创造模式协议级给物品/清背包 | C（作弊/测试） |
| `mc_say` | 公屏说话 | **A**（社交） |
| `mc_command` | 以玩家身份执行服务器指令；白名单 | C（最后手段/危险） |

## 长活儿与自主（2）

| 工具 | 干什么 | 评级 |
|---|---|---|
| `mc_task` | 长活儿台账：run/resume/plan/step；掉线重连还在 | **A**（长期目标） |
| `mc_auto` | 自主层：反射（吃/捡/危险叫醒/跟随）+ 空闲决策（叫醒 AI） | **A**（但应由 body 管） |

## 合成 / 熔炼 / 箱子 / 交易（4）

| 工具 | 干什么 | 评级 |
|---|---|---|
| `mc_craft` | 真合成，自动补中间产物；缺料报缺什么；tree 依赖树 | B（生存/建造） |
| `mc_furnace` | 真熔炼，自动挑燃料 | B（生存/建造） |
| `mc_chest` | 箱子存取/全搬 | B（整理/仓库） |
| `mc_trade` | 村民交易，list/buy；附魔书可先看 | B（情境） |

## 宿主能力（3）

| 工具 | 干什么 | 评级 |
|---|---|---|
| `mc_kit_memory` | 长期记忆树：index/record/read/append/put/search/delete | B（长期） |
| `mc_kit_image` | SVG→PNG、拼图、引图、保存 | C（展示用） |
| `mc_kit_express` | 把 `.express/` 文件变成路径/URL | C（发布用） |

## 管理（1）

| 工具 | 干什么 | 评级 |
|---|---|---|
| `mc_admin_config` | 全局配置：指令白名单、MC 模式工具、记忆目录、分享开关 | C（宿主/管理员） |

## 统计

- **A（建议模型直接拥有）**：`mc_status`、`mc_observe`、`mc_scan`、`mc_map`、`mc_inventory`、`mc_events`、`mc_watch`、`mc_move`、`mc_dig`、`mc_say`、`mc_task` = **11**。
- **B（情境开放）**：`mc_act`、`mc_attack`、`mc_shoot`、`mc_station`、`mc_prep`、`mc_fish`、`mc_build`、`mc_sequence`、`mc_craft`、`mc_furnace`、`mc_chest`、`mc_trade`、`mc_config`、`mc_kit_memory` = **14**。
- **C（不给模型）**：连接/账户/诊断/管理/命令/作弊/发布 = **15**。

合计 **40**。

## 对我们的直接结论

- 我们的 `mcb_*` 已经有 `status/events/task/say`；缺的是 **observe/inspect/map/scan/inventory** 这类“看”的工具，以及 `move`/`dig` 这种“亲自做一步”的窄工具。
- 不建议把 40 个全给 ICL；先补：
  - `mcb_look`（observe 文本版/截图）
  - `mcb_scan` / `mcb_map`（地形）
  - `mcb_inventory`
  - `mcb_move`（短距离/让开）
  - `mcb_dig`（单步）
- `mc_command`、`mc_give`、`mc_admin_config`、账户/连接/诊断继续留在 body/宿主。
- `mc_task` 的台账思路值得学：我们的 task 状态机应持久化，而不是只在内存。
