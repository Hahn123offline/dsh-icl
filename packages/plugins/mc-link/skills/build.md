# 蓝图建造（build，beta）

`{"op":"task","kind":"build","params":{"blueprint":{...},"origin":{x,y,z},"rotate":0,"materialPolicy":"strict"}}`
按蓝图逐层放方块；材料不够/放不上会失败或 partial。**简单小屋优先用 `mcb_shelter`**（自带结构+入口验收和 home）。

## 蓝图格式

```json
{
  "version": 1,
  "name": "small_hut",
  "size": { "x": 5, "y": 3, "z": 5 },
  "palette": { "#": "oak_planks", "C": "cobblestone", " ": null },
  "layers": [
    ["#####","#####","#####","#####","#####"],
    ["#   #","    ","    ","    ","#   #"],
    ["#####","#####","#####","#####","#####"]
  ]
}
```
- `palette` 的 `null` / `" "` = 空气（跳过）。
- `layers[y][z][x]` 从下往上；`origin` 默认脚下，`rotate` 0/90/180/270。
- `materialPolicy`：`strict`（默认，缺料直接失败并列出缺口）/ `substitute`（明早支持）。

## 失败与进度

- 失败码：`needs-material`（缺料，回执列缺口）、`partial`（完成度 <80%：先垫脚/换低层/清占位）、`blocked/unsafe`（位置危险）。
- progress：`{layer,totalLayers,placed,skipped}`；done 回执带 `placed/skipped/总块数`。
- 材料不足先 `collect`/`craft`；大建筑分次 build（每次一块区域），别一次几千块。
