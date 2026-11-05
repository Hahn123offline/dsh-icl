# 村民交易

## 什么时候用

附近有村民，且你想看/买它的交易。

## 怎么做

1. `mcb_do` 组合走到村民并右键：
   `{"steps":[{"op":"move","target":{"entity":"nearest:villager"},"range":2},{"op":"use","target":{"entity":"nearest:villager"}},{"op":"wait","ms":400}]}`
2. 面板打开后：
   `{"steps":[{"op":"trade","action":"list"}]}`
3. 选择条目：
   `{"steps":[{"op":"trade","action":"buy","index":0,"count":1}]}`

## 成功证据

背包里目标物品增加；`trade list` 的限购次数变化。

## 失败

- 没有面板：村民太远、宝宝、睡觉、没职业；先用 `mcb_look` 确认。
- 买不了：材料不够或已限购；换条目/村民。
- 不要不看 list 直接买，不要把材料一次换完。
