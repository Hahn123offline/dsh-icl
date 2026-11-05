# 宏操作总览（重复劳动交给 body）

> 一条宏 = 一个 body task：`{"op":"task","kind":"<宏>","params":{...}}`。body 自己寻路/换工具/计数/拾取，
> 模型只负责"做什么/要不要停"。**别用 mine/goto/dig 逐方块刷**（night-1 出现过 10 分钟挖同一资源数百方块、无结构产出）。

## 8 个宏（beta；真服验收先看 collect/tunnel）

| kind | 做什么 | 关键参数 | 完成文案里看 |
|---|---|---|---|
| `collect` | 批量采集一种资源（自动工具/拾取/计数） | `item`、`count`、`radius`、`returnToSafe`、`deposit` | 收集到 N 个（net 背包净增） |
| `tunnel` | 直线通道（可带火把） | `direction`/`dx,dz`、`length`、`height`、`torchEvery`、`stairs:true`（仅向下） | 往某方向 N 格（高 H）（向下阶梯），火把 K |
| `bridge` | 向前铺路 | `direction`、`length`、`width`、`support` | 铺了 N 格，用材料 M |
| `build` | 按 blueprint 搭建筑 | `blueprint`、`origin`、`rotate`、`materialPolicy` | 放了 N 块，跳过 M |
| `shelter` | 3×3×3 避难所 | `size`、`material`、`door` | 墙/顶/门数量 |
| `sort` / `deposit` | 整理或存箱子 | `chest`、`items`、`all` | 存/取 N 件，保留 M |
| `farm` | 开垦+播种 | `crop`、`count` | 开垦 N、播种 M |

## 使用规则

- 提交后**不要用 wait 轮询**：progress 限频（每 5–10% 或 10s），完成/失败/中断会作为事件回来；
  查进度用 `{"op":"tasks"}`，停用 `{"op":"cancel","taskId":"t-1"}`，断线挂起后续跑用 `{"op":"resume","taskId":"t-1"}`。
- 长动作一律用 task 形式；并发单步长动作会被 body 409 挡回（"上一个 do 动作还在执行"）。
- 失败原因码：`no-target`（没资源）/`no-path`（走不过去）/`dig-failed`/`needs-tool`（工具不对，body 已停）/
  `inventory-full`（背包满）/`needs-material`（材料不够）/`blocked`（水/岩浆/基岩）/`unsafe`（安全护栏）/
  `partial`（只完成一部分，build/shelter 完成度 <80%）；farm 还有 `no-water`/`no-site`；tunnel 向上 stairs 是 `unsupported`。
  消息里都会带下一步，别原样重下。
- 捡掉落物用单步 `pickup {radius,max}`（返回 picked/items/left），不要 goto 到自己脚下等。
- 收工：`mcb_leave {cleanup:true}` 会清 MC 相关的 focus/持续目标（按 activity/标签/服务器别名识别）；
  回执会如实列出还挂着的（包括非 MC 的）。
