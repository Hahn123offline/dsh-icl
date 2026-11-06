# local3 示例 checkpoint（只读摘录）

来源：mc-lab `e2-20261106-local3/state/mc-body/`（tasks.json + body.jsonl），只读导出，不跑 MC/不启服。

| 目录 | 来源 task | 预期 |
|---|---|---|
| `shelter-3x3/` | t-106（shelter，failed） | `shelter: incomplete`；verify 墙缺 9/屋顶缺 6；含 37 个 shelter_place_fail |
| `collect-resource/` | t-1（collect，done） | oak_log 8；macro_done + task_done |

说明：
- 最小包仅 meta/scenario/tasks/events/expected-events；**world 快照省略**（失败/成功断言不依赖方块重放；完整 L1 结构重放需补 world.json）。
- 事件保留原始 body `seq`（可能不连续）；`meta` 的 commits 里 body 记为 `cbb37f8`（依据 local3 出现 `task_cancelled_for_defense`），mcLink/mcLab 未知。
- `scenario.setup.inventory` 为推断值（任务通过材料 gate → dirt≥27）；精确背包未在事件中逐项记录。

## L1 回放
- 用 `tools/mc-replay.mjs <dir>` 离线跑（fake adapter，不启 MC/服务器）；两个示例均 PASS。
- **world.json 可选**：断言基于录制的 tasks/events（verify 结果已在 task.result），L1 不需要方块/物理重放；若验证世界实际结构再补（MC-INSTRUMENTATION §3.8）。
