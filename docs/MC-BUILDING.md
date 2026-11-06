# MC 建房 / 空间理解（MC-BUILDING）

> 用户反馈：她反复尝试造小房子，造不出可用结构、造好也不会进去躲。本文分析现有 shelter 的失败点、给出蓝图→分步建造→结构验收→home 记忆方案，并记录 54839 dev 服验证结果。

## 0. 结论（TL;DR）

- **现有 shelter 失败不是“材料不够”，而是建造策略/验收缺失**：旧实现按平面格子逐个 `place`，屋顶/远端墙常因“够不到/下方无支撑”被跳过，完成度阈值 80% 就报 partial，**没有门/屋顶/室内可站/可进入验收，也不记忆 home**。S2 里 4 次 shelter 全部 failed（partial/needs-material），但她**手动**用“中心立柱托屋顶→铺顶→抽柱”方法成功盖出 3×3 木屋并走进去。
- 已重写 shelter：**蓝图规格（墙/门洞/屋顶/内部/地面/入口点）→ 建造顺序（墙→临时支撑→屋顶→拆支撑）→ 结构验收（四面墙/屋顶/门洞/室内 2 格高/地面/门外可站）→ 实际走入门内 → 写 home**；失败按“缺哪一面/屋顶几块/门堵/室内被占”给可操作原因。
- 真服 dev 验证（54839，独立服）：3×3（内部 2 格高）木屋 **done**，`verify.ok=true`（墙 14/14、屋顶 9/9、门洞、室内、地面、入口全过），`entryOk=true`，`status.home` 已写入并跨重启保留。
- **截图验证已修复（2026-11-06）**：根因是 prismarine-viewer 的 worldrenderer 只对 `y=0..256` 的 section 建网格，超平坦负 Y 世界（y=-60）的 section 永远不渲染；viewer server 现对负 Y 世界做“渲染时整体 +64（chunk minY + 相机同步）+ 页面相机补丁 + 门口方向镜头”，真服 3×3 小屋截图已能看见完整结构（门洞/墙/屋顶）；结构验收仍由 verify 完成，截图仅作证据。

## 1. 现有 shelter 为什么失败（S2 证据）

S2 run `.state/lab/e2-20261106-soak`：

- shelter 调用 4 次（`size:3, material:dirt/dark_oak_planks, door:true`）：
  - `placed 6 / skipped 17`、`16 / 7`、`12 / 11` → `shelter: partial`（旧 80% 阈值）；
  - 一次 `needs-material`（dark_oak_planks 只有 1，需 23）。
- 失败原因（旧实现）：没有找平地/垫底，没有“从够得到的位置放”的走位，屋顶中间/门上方没有支撑，门洞/屋顶/室内没有验收；`door:true` 参数被忽略（旧 shelterPlan 固定门位）。
- 她随后**手动成功**：记忆里清楚写了“先砌两层墙留门位→中心立柱→铺 9 块屋顶→抽柱→装门”，`remember` 记录“门能进；这屋子算合格”。说明问题在**宏的建造策略与验收**，不在模型能力。
- 旧成功判据仅 `placed+already >= 80%`，**“80% 的墙”也可能四面漏风**；没有“人在里面能站/能从门外走进”的语义。

## 2. 方案：蓝图 → 分步 → 验收 → home

### 2.1 蓝图 JSON（`src/building.mjs`）

```json
{
  "version": 1, "name": "shelter",
  "size": {"x": 3, "y": 3, "z": 3},
  "palette": {"W": "oak_planks", "R": "oak_planks", ".": null},
  "door": {"side": "south", "height": 2},
  "layers": [
    ["WWW", "W.W", "W.W"],   // 墙层 1（门洞在 south 中间两格）
    ["WRW", "W.W", "W.W"],
    ["RRR", "RRR", "RRR"]    // 屋顶层
  ]
}
```

- 生成器 `makeShelterSpec({size,height,doorSide,material})`：size 奇数 3–7，内部高 `height-1`（≥2），门洞在指定面的墙中间、高 min(2, interiorHeight)。
- 布局：四面墙 + 门洞（两格空气）+ 平屋顶（height-1 层全铺）+ 地面（内部下方实心）+ 门外 2 格站位 + 室内中心站位。

### 2.2 建造顺序（复用现有 place/dig，不新增 op）

1. 找 3×3 平地（内部地面实心、上方 2–3 格空气、门外可站）→ 找不到 `shelter: no-site`（提示先挖平/换地方）。
2. **站到门洞里**（3×3 从门洞到任意墙/屋顶 ≤4.5 格），按 `y` 从低到高砌墙；墙放不上的格在“补建”轮里走近再补。
3. 站到门外；对**屋顶下方无支撑的格**（中心 + 门洞上方）从地面垒**临时支撑柱**。
4. 铺全部屋顶（此时中心/门上方都有支撑）。
5. **补建轮**：按 verify 缺失的墙/屋顶格逐个走近再放（最多 3 轮；支撑柱此时仍保留，缺屋顶格可借支撑补）。
6. 拆临时支撑（从屋顶往下拆；够不到就走到门内/门外再拆）。
7. **验收**（见 2.3）；失败 → `shelter: incomplete` + 具体缺面/块数。
8. **实际走进去**：从门外站位走到室内中心，`entryOk`；失败 → `shelter: entry-blocked`。
9. 可选装门（`door:true` 且有门物品）：验收/入门在装门前完成；装门后需要交互开门（`use`）。
10. 写 `home = {origin, center, door, outside, size, height, interiorHeight, material, doorSide, builtAt}`。

### 2.3 结构验收（`verifyShelter`）

| 检查 | 判据 | 失败原因 |
|---|---|---|
| 四面墙 | 每个墙格是实心方块（按面统计 north/south/east/west） | `墙缺 N 块（south:4…）` |
| 屋顶 | 9 块全实心 | `屋顶缺 N 块` |
| 门洞 | 2 格空气（不堵） | `门洞被堵 N 格` |
| 室内 | 内部 2 格高全空气、地面实心 | `室内被占 N 格 / 地面缺支撑` |
| 入口 | 门外站位 2 高空气、门洞空气、室内站位空气 | `门外/门内没有可站立空间` |
| 实际进入 | 从门外走到室内中心（pathfinder） | `shelter: entry-blocked` |

`verify.summary` 直接给“结构完整：四面墙 + 屋顶 + 门洞 + 室内 2 格高 + 进出通路”或“墙缺 6 块（north:2、south:4）；屋顶缺 6 块”。

### 2.4 home 记忆

- body 任务 done 时若 `result.home` → `home = result.home`，事件 `home_set`，写 ledger（`tasks.json` 的 `home` 字段），`status.home` 暴露；重启后保留。
- 建完小屋**不再自动 `returnToSafe`** 把她带走（shelter 任务完成时跳过 returnToSafe），她留在屋里。
- mc-link 可在 `mcb_status`/`memory` 里显示“家：x,y,z（3×3，门在 south）”；后续“回家/躲雨/过夜”可 `goto home.center`。

## 3. 真服验证（54839 dev 服；E2 期间未碰 54838）

| 项 | 结果 |
|---|---|
| 建造 | `shelter {size:3,height:3,material:oak_planks,door:true}` → **done**；placed 27 / skipped 0 |
| 结构验收 | `verify.ok=true`：墙 14/14、屋顶 9/9、门洞 2 格、室内 2 格高、地面、入口全过 |
| 进门 | `entryOk=true`（从门外实际走进去） |
| home | `status.home={origin(-28,-60,-12), center(-27,-60,-11), door(-27,-60,-10), outside…}`，重启后保留 |
| 截图 | `/v1/eyes/screenshot` 已修复：3×3 小屋截图可见完整结构（墙/门洞/屋顶），见 `media/.../shelter.png` 与 [`docs/assets/mc-shelter.png`](assets/mc-shelter.png)。 |
| 证据 | `.state/lab/mc-building-poc/run10/result.json`、`media/.../*.png`（空白，作为遗留证据） |

## 4. 为什么她会“造好也不会进去躲”

- 旧宏没有“入口/内部可站”验收，也没有 home 记录；造完任务结束后她可能被 `returnToSafe` 带走，空间记忆只靠 `remember` 文本（S2 里她确实记了坐标）。
- 新实现：**door/entryOk/home** 三项一起返回；`status.home` + `home_set` 事件让 mc-link/记忆有结构化入口；后续可加“天黑回 home”策略（mc-link/playbook 侧）。

## 5. 截图/像素验证（MC-EYES 联动）

- 结构验收已用方块读取完成，**不依赖截图**；截图是“人看得见”的额外证据。
- live bot world 截图已修复（见 §5.3）：负 Y 世界现在渲染时整体 +64，页面相机补丁 + 可配置镜头；`kind:"shelter"` 会自动把镜头放在门口一侧（低角度看门洞/墙/屋顶）。
- 修复后仍建议：结构验收结论以 `verify/entryOk` 为准；截图只作为“人看得见”的辅助证据；超平坦以外世界（y≥0）不受影响。

## 6. 与现有 build/shelter 宏关系 / 后续

- `shelter` 已重写（本文）；`build` 仍是通用蓝图放置（无结构验收），后续可复用 `makeShelterSpec`/`verifyShelter` 的同一套验收。
- 待做：
  1. 可选：把“负 Y 渲染偏移”做成显式参数（当前自动 +64，仅渲染层）；
  2. 支持 3×3×2 以外的 size/门向/材料（当前支持 3–7、方向可选）；
  3. 山坡地形自动挖/垫平（当前 `no-site` 让模型先挖平）；
  4. 门安装后自动“开门进入”（`use` door）；
  5. mc-link：`mcb_shelter`/`mcb_build` 工具 + `mcb_status.home`/`nearbyHostiles` 展示 + skills 写“盖房/回家/躲藏”。

### 3.1 真服 result 里的 verify 示例（mc-link 渲染可直接取）

成功（run10，3×3 橡木屋 done）：

```json
{
  "ok": true,
  "walls": { "ok": true, "missing": 0, "total": 14,
    "faces": { "north": {"missing":[],"total":6}, "south": {"missing":[],"total":4}, "east": {"missing":[],"total":2}, "west": {"missing":[],"total":2} },
    "missingFaces": [] },
  "roof": { "ok": true, "missing": 0, "total": 9, "cells": [] },
  "door": { "ok": true, "openCells": 2, "missing": 0 },
  "interior": { "ok": true, "blocked": 0, "cells": [] },
  "floor": { "ok": true, "missing": 0 },
  "entry": { "ok": true, "outsideClear": true, "doorOutClear": true, "insideClear": true },
  "summary": "结构完整：四面墙 + 屋顶 + 门洞 + 室内 2 格高 + 进出通路"
}
```

失败（run5，屋顶缺 1 块）：

```json
{
  "ok": false,
  "walls": { "ok": true, "missing": 0, "total": 14, "missingFaces": [] },
  "roof": { "ok": false, "missing": 1, "total": 9, "cells": [ { "x": 1, "y": 2, "z": 1 } ] },
  "door": { "ok": true, "openCells": 2, "missing": 0 },
  "interior": { "ok": true, "blocked": 0, "cells": [] },
  "floor": { "ok": true, "missing": 0 },
  "entry": { "ok": true, "outsideClear": true, "doorOutClear": true, "insideClear": true },
  "summary": "屋顶缺 1 块"
}
```

- “缺哪面”已在 `walls.missingFaces`（如 `[{face:"south",missing:4,total:6}]`）与 `summary` 里；需要更细可用 `walls.faces[face].missing` 的坐标列表、`roof.cells`、`interior.cells`。
- `failures` 是建造过程失败明细（stage/x/y/z/reason），用于调试，不建议直接给模型看；给模型用 `verify.summary` 即可。

### 5.1 排查进展（2026-11-06）

- 已加 viewer 诊断计数（`startViewerServer().stats = {chunksSent, chunkErrors, sampleError}`，body screenshot meta 里带 `viewer.stats`）。
- 真服 dev 实测：**49 个区块全部发送、0 错误**（`chunksSent:49`），说明 body → viewer 的 chunk 数据通道正常；但浏览器画面仍是天空（PNG ~2KB）。
- 已排除/试过：
  - mineflayer 的 `chunk.toJson()` 在 1.21.4 返回**字符串**，viewer 服务已改为 parse 后再发（原先字符串可能不被 worker 接受）；
  - prismarine-viewer 页面只在 `position.pos.y > 0` 时初始化相机（超平坦世界 y=-60 会永远不回相机）→ 尝试把负 Y 世界整体 +64（chunk `minY` 与相机 position 同步），仍未渲染。
- 结论：**chunk 已到浏览器，问题在 viewer 页面/worker 对 1.21.4 超平坦负 Y 世界的渲染/相机初始化**，不是 body 没发数据。下一步可：给 viewer bundle 打 patch（负 Y 相机/超平坦）或用离线 world 快照渲染（把 body 世界导出成 prismarine-world 后离线截图）。

### 5.2 进一步结论（2026-11-06 下午）

- 找到并修掉了“负 Y 不初始化相机”的直接原因：prismarine-viewer 页面里 `if (pos.y > 0 && firstPositionUpdate) { controls.target...; camera... }`。现在在静态路由前挂一个**只去掉 `pos.y > 0` 条件的 `/index.js` 补丁**（不动 node_modules），世界坐标保持真实、不再做 y 偏移。
- 但真服 dev 截图**仍然只有天空**（chunksSent 49/49、0 错误；页面已连上并收到 version/position）。说明卡点不在“相机初始化条件”、也不在 chunk 传输，而在 **1.21.4 超平坦 live world 的 chunk JSON → viewer worker 解析/渲染**（或 headless WebGL 对 63MB worker 的处理）。
- 下一步：用 CDP 抓页面 console/worker 异常（`Runtime.exceptionThrown` / `Log.entryAdded`），对比离线 1.16.4 世界（同一 viewer 能出图）与 live 1.21.4 的 chunk JSON 差异；定位后再决定是否换离线快照渲染。

### 5.3 live-world 截图修复（2026-11-06，已真服验证）

根因是**两层**，不是 chunk 没发：
1. viewer 页面相机初始化被 `if (pos.y > 0 && firstPositionUpdate)` 限制（负 Y 世界永不初始化相机）；
2. 更关键：`prismarine-viewer` 的 worldrenderer 只对 `y=0..256` 的 section 建网格（源码循环写死 16 个 section），超平坦负 Y（y=-60）的 section 永远不渲染 → 只有天空。

修复（`packages/mc-body/src/eyes.mjs`，不改 node_modules、不影响业务坐标）：
- **负 Y 渲染偏移**：`center.y < 0` 时 viewer 渲染层整体 +64（chunk JSON `minY` 与相机 target 同步 +64），让 y=0..256 的渲染循环覆盖到；截图视觉坐标整体上移 64，业务/验收坐标不变。
- **页面相机补丁**：在静态路由前挂一个打过补丁的 `/index.js`，去掉 `pos.y > 0` 相机守卫；并支持 `cameraOffset`（相对 target 的镜头偏移）。
- **chunk 必须发字符串**：worker 内部 `JSON.parse(chunk)`；mineflayer 1.21.4 的 `toJson()` 返回字符串（对象则 stringify）。
- **小屋截图镜头**：`kind:"shelter"` 时 body 自动把中心设为 `home.center`、镜头放到**门口一侧**（低角度，distance 6.5 / height 3），能看见门洞 + 墙 + 屋顶。

真服证据（54839 独立 dev 服）：
- `.state/lab/mc-building-poc/run15/result.json`：`shelter done`、`verify.ok=true`、`entryOk=true`、`home` 写入；截图 125KB。
- 截图存档：[`docs/assets/mc-shelter.png`](assets/mc-shelter.png)（3×3 木屋正面，门洞/墙/屋顶清晰可见）。
- 之前的空白 PNG（run10）保留作为排查对照；run12/13/14 为逐步修镜头过程。

### 2.5 材料不足诊断（needs-material）

- `shelter: needs-material` 的 result 现在带：`material`、`needed`（需要）、`have`（现有）、`deficit`（还差）、`available`（常见建材逐项数量）、`alternatives[{material,have,enough}]`、`suggestion`。
- 建议会优先给“背包已有足够替代材料 → 直接改 material 重试”，否则给“先 dig 脚边 dirt/stone 补 N 块”的**可执行 op**，并提示“别原样重试”。
- 真服证据：`.state/lab/mc-body-fix-poc/run1/result.json`（dirt 0/27 → `deficit:27`、suggestion 带 dig 27 dirt/改 material）。
