# 批量采集（宏 collect）

> 重复劳动交给宏：**一条调用**让 body 自己挖/砍/收，不要用 `mine`/`goto`/`dig` 逐方块刷。
> 用户看到过的退化现场：10 分钟逐块挖同一资源数百方块、没有任何结构产出。

## 什么时候用

- 需要一批同种资源（木头/石头/煤/铁…），数量 > 4，或需要走到外面找资源时。
- 死了要回收掉落物、背包被同类东西塞满时。
- 不想让模型把"下一步挖哪块"当成任务本身。

## 怎么用

```json
{"op":"task","kind":"collect","params":{"item":"oak_log","count":16,"radius":24}}
```

| 参数 | 说明 |
|---|---|
| `item` | 方块名或常见掉落名：`oak_log`、`stone`、`cobblestone`（→stone）、`coal`（→coal_ore）、`raw_iron`/`iron_ingot`（→iron_ore）、`dirt`、`sand`、`gravel`… |
| `count` | 要收集的净增数量（1–256） |
| `radius` | 搜索半径（2–48，默认 16） |
| `returnToSafe` | `true` 时收完回最近安全点 |
| `deposit` | 收完把东西存进附近箱子（`{}` 或 `{"chest":true}`） |

- 立即返回 `taskId`；**提交后不要用 wait 轮询**。progress 限频（每 5–10% 或 10s 一条），完成/失败会作为事件回来。
- 想查进度：`{"op":"tasks"}` 或 `{"op":"events"}`；想停：`{"op":"cancel","taskId":"t-1"}`（≤1s 内停）。
- 结果：`task_done` → “宏完成：collect 收集到 N 个 item（目标 M）”，`result` 里有 collected/requested/returned/deposited。

## 失败怎么办（reason 码）

| reason | 意思 | 下一步 |
|---|---|---|
| `no-target` | 附近没有这种资源 | 换 `item`（用方块名更准）、调大 `radius`，或先 goto 到有资源的地方 |
| `no-path` | 走不过去 | `mcb_map`/`mcb_look` 看地形，换个方向再下宏 |
| `dig-failed` / `no-effect` | 挖不动/方块没变化 | 看工具够不够（`mcb_inventory`）、换位置 |
| `needs-tool` | 工具不对/不够好（body 已停） | 先做/换对应工具（石镐、斧头…），别再原样重下 |
| `inventory-full` | 背包满 | 先存箱子或丢掉杂物 |
| `partial` | 只完成一部分 | 看背包和 progress，续做（重新下宏）或换目标 |
| `timeout`（unknown） | 结果未知 | 先 `mcb_inventory`/`mcb_status` 复核，再决定 |

## 不要做

- 不要 `task mine` 一个方块一个方块地凑数量；`collect` 内部就是自动找+自动工具+自动计数+捡掉落。
- 不要连发好几个 collect 同一物品：先 `tasks` 看有没有在跑的。
