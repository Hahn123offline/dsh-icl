# 挖隧道（宏 tunnel）

> 直线通道/下矿通道用宏：一条调用让 body 逐格挖、清路、放火把。不要用 `dig` 一块一块刷。

## 什么时候用

- 想从当前位置往前/往下开一条通道（下矿、连两个地方、做走廊）。
- 需要一条有高度（1×2 或更高）、带照明的直隧道。

## 怎么用

```json
{"op":"task","kind":"tunnel","params":{"direction":"east","length":8,"height":2}}
{"op":"task","kind":"tunnel","params":{"dx":0,"dz":1,"length":16,"height":2,"torchEvery":6}}
```

| 参数 | 说明 |
|---|---|
| `direction` | `north/south/east/west`（二选一；也可以给 `dx`/`dz` 一个非零） |
| `length` | 挖多少格（1–128，默认 8） |
| `height` | 通道高度（1–4，默认 2） |
| `stairs` | `true` = 向下阶梯（每步降 1 格）；**只支持向下**，向上会得到 `unsupported`（先水平挖再垫脚） |
| `torchEvery` | 每几格放一支火把（0–32，默认 6；背包里有火把才放） |

- 立即返回 `taskId`；progress 限频（每约 10% 或 10s），`{"op":"tasks"}` 查、`{"op":"cancel","taskId":"t-1"}` 停（≤1s）。
- 成功判据：水平前进 `length` 格、每格高 `height` 的通道打通（stairs 时每步向下 1 格）；`blocked`/`unsafe`/`needs-tool` 是失败。
- 完成结果：“宏完成：tunnel 往east挖了 N 格（高 2）（向下阶梯），放火把 K”。

## 失败怎么办（reason 码）

| reason | 意思 | 下一步 |
|---|---|---|
| `blocked` | 前方是水/岩浆/基岩 | 换方向或绕开；不要硬挖 |
| `unsafe` | 安全护栏拒绝（下挖会灌水/岩浆等） | 换位置/换方向 |
| `needs-tool` | 挖这种方块需要更好的工具（body 已停） | 先做/换镐，别再原样重下 |
| `needs-material` | 需要材料（如火把/支撑）但背包不够 | 先补材料 |
| `dig-failed` / `no-path` | 挖不动/走不过去 | `mcb_map` 看地形，改 `direction` 或先走到开阔处 |
| `unsupported` | 参数组合不支持（例如向上 stairs） | 向下用 `stairs:true`；向上先水平挖再垫脚 |
| `partial` | 挖了一部分就停（有 progress） | 看 progress 位置，续挖或换方向 |

## 不要做

- 不要用 `dig` 一格一格挖隧道；tunnel 内部会先挖头再挖脚、遇流体停、自动放火把。
- 不要一条接一条连发 tunnel：先 `tasks` 看有没有在跑的。
