# 箱子/仓库

## 什么时候用

附近有箱子/木桶，或背包满。

## 怎么做

1. `{"steps":[{"op":"chest","action":"list"}]}` 看内容。
2. 存：`{"steps":[{"op":"chest","action":"put","items":[{"name":"dirt","count":64}]}]}`
3. 取：`{"steps":[{"op":"chest","action":"take","items":[{"name":"coal","count":8}]}]}`
4. 前后用 `mcb_inventory` / `chest list` 对比。

## 注意

`all:true` 会搬走所有材料（工具/装备/食物默认保留）；先看清单，想留种/留木板就单件存。

## 新版 body（2026-11-06）

- `chest {action:"put", all:true}` / `{action:"take", all:true}` 现在真的支持整包存取（工具/装备/食物默认不存）；返回 `moved/kept/container`。单件仍用 `items[]`。
- 前后 `mcb_inventory` 对比；`all:true` 不会把工具存走，但**会存走所有材料**，想留种/留木板就先单件存。
