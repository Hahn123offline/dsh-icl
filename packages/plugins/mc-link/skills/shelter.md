# 盖房 / 回家 / 躲藏（shelter）

用 **`mcb_shelter`** 一条 task 盖一间能住的小屋：body 会四面墙+门洞+屋顶+室内高度验收，
并**真的从门外走进门内**（entryOk）通过后才算成功；成功后把 `home` 写进 body 状态（持久化）。

## 怎么用

```json
{"steps":[{"op":"task","kind":"shelter","params":{"size":3,"height":3,"material":"oak_planks","door":true}}]}
```
或直接 `mcb_shelter {"size":3,"height":3,"material":"oak_planks","door":true}`。

| 参数 | 说明 |
|---|---|
| `size` | 边长 3–9（奇数），默认 3 |
| `height` | 总高 3–6，默认 3（室内高 = height-1） |
| `material` | 方块材料，默认 `dirt`；橡木屋写 `oak_planks`（不够会 needs-material） |
| `door` | true = 背包有门就装上（门洞本身就通，不装也能验收） |

- 完成回执带 `verify.summary`（"结构完整：四面墙+屋顶+门洞+室内2格高+进出通路"）与 `home`（center/门朝向）。
- `mcb_status` 会显示"家：x,y,z（3×3，门在 south）"；**夜里/下雨/被怪追：回 home.center 躲**。
- 结构验收 body 已做，以 `verify` 为准；想看画面可用 `mcb_eyes {kind:"shelter"}`（自动对准家门口、低角度，能看见门洞/墙/屋顶），但**截图仅作参考**，不拿它做验收。注意：shelter 镜头**只在 home 已写入时生效**（没家就回退默认斜上方镜头）；截图前先确认 `mcb_status` 有"家"行。

## 失败怎么办

| 失败码 | 意思 | 下一步 |
|---|---|---|
| `shelter: no-site` | 地形/空间放不下 | 先清平/换位置，或先挖平再重跑 |
| `shelter: needs-material` | 方块不够（回执带 `needed/have/deficit`） | 看 `alternatives`：有够数的替代材料就改 `material` 重试（不用再收集）；否则按 `deficit` dig/collect 补料，别原样重跑 |
| `shelter: incomplete` | 结构差墙/屋顶/门洞 | 按 `verify.summary` 补缺的；缺哪面看 `verify.walls.missingFaces`（例 `south 缺 4/6`），屋顶缺几块看 `roof.missing`；不用重跑整间 |
| `shelter: entry-blocked` | 结构 OK 但进不去 | 清零格门洞/垫平门外通路，或换 doorSide |

（body 回执里的 `failures[]` 是建造过程调试明细，不用管；看 `verify.summary` 就够。）
