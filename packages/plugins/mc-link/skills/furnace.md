# 熔炼

## 什么时候用

有矿石/食物和燃料，附近或背包有熔炉。

## 怎么做

1. 找/放熔炉。
2. `{"steps":[{"op":"furnace","input":"raw_iron","fuel":"coal","count":1}]}`
3. 等待烧炼完成；`mcb_inventory` 验证产物。

## 失败

- 没熔炉：先放熔炉；没有就报告缺。
- 没燃料：先找煤/木炭；木板只作最后手段。
- 不要把合成用的木板当燃料烧掉。

## 新版 body（2026-11-06）

- `furnace {input, fuel, count, fuelCount?, waitMs?}`：`count` 个产物、燃料默认按 `ceil(count/8)` 放（煤 1 个烧 8 个），body 轮询取产物。
- 返回 `outputs/taken/requested/partial`；`partial:true` 表示只烧出一部分（燃料/时间不够），**别当全部成功**，`mcb_inventory` 核数后再决定补烧。
- 0 产物会报明确原因（燃料不足/输入错），不是静默成功。
