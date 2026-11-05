# 箱子/仓库

## 什么时候用

附近有箱子/木桶，或背包满。

## 怎么做

1. `{"steps":[{"op":"chest","action":"list"}]}` 看内容。
2. 存：`{"steps":[{"op":"chest","action":"put","items":[{"name":"dirt","count":64}]}]}`
3. 取：`{"steps":[{"op":"chest","action":"take","items":[{"name":"coal","count":8}]}]}`
4. 前后用 `mcb_inventory` / `chest list` 对比。

## 注意

`all:true` 全搬会把工具/装备也存进去；先看清单。
