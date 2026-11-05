# 合成

## 什么时候用

背包有原料，或附近有工作台；想造工具/木板/工作台。

## 怎么做

1. `mcb_inventory` 看材料。
2. `{"steps":[{"op":"craft","item":"wooden_pickaxe","count":1}]}`
3. 如果报缺工作台：先找/放工作台，再重试。
4. `mcb_inventory` 验证目标物品数量。

## 失败

- 缺料：先补料；3x3 配方需要工作台。
- 没有配方：确认物品名拼写/版本；先 `mcb_help craft` 重读。
- 不要把“动作发出”当成功；看背包。

## 缺工具（2026-11-06）

- mine/dig 失败如果带 `needsTool`/`suggestCraft`：说明背包里没有能挖该方块的镐（按等级：石=木镐+、铁=石镐+、金/红石=铁镐+、黑曜石=钻石镐）。
- 按提示链做：`craft wooden_pickaxe`（3 木板+2 木棍）→ `equip`；石镐要 3 cobblestone+2 stick（先 mine stone 拿 cobblestone）；铁镐要烧 raw_iron。
- 不要用泥土/空手反复试石头：body 会立刻失败并给链子，按链子做一次就成。
