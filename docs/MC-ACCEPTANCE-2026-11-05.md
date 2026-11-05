# MC 验收记录（2026-11-05）

> 判据见 [MC-ACCEPTANCE.md](MC-ACCEPTANCE.md)；机器断言=链路证据，三问=当事人反馈不算证据。
> 环境：lab（`dsh --profile web --patch`，不碰 desktop）；正常地形服 `127.0.0.1:54840`（bot `ICL-mclab-1`）；模型先云端 `deepseek-flash`，再本地 `coder390-27b-q3-df2-4x500`。

## 1. 最终结果

| run | 模型 | commit | 场景 | 结果 | 关键点 |
|---|---|---|---|---|---|
| t5 | deepseek-flash | 4207fbf | A/C/E | PASS/PASS/PASS | B 之前基线（flat 54837，旧 body） |
| c3 | deepseek-flash | da20af6 | A / E | PASS / PASS | 54840 normal；B 生效（system 4999 常数） |
| c3 | deepseek-flash | da20af6 | C | FAIL（真问题） | body 在 mine oak_log 连崩 3 次（exit 1，无栈）→ 已转 mc-body，后修复 |
| r3 | deepseek-flash | 66820a5 | A/C/E | **PASS / PASS / PASS** | 54840；A 6/7（软 noToolError）、C 9/9、E 6/6 |
| r4 | deepseek-flash | 73494e9 | A/C/E | **PASS / PASS / PASS** | A 7/7、C 8/9（软 crash-notice）、E 6/6 |
| r5 | deepseek-flash | 73494e9 | A/C/E | **PASS / PASS / PASS** | A 7/7、C 9/9、E 6/6 —— **云端 3 连达成** |
| L1 | ninfer/coder390 | 3b96864 | A | FAIL（产品+M 型） | join✓ body✓ 下任务✓；mine 全 `no-path`（A* 2s 超时误判，已修）；本地慢（430s session/cancel） |
| LA | **ninfer/coder390** | 1b4d923 | A | **PASS 8/8** | 本地 A：join→scan→mine 一棵 oak_log→自己 leave；22.1s；无工具错误（中途掉血 18→11 被 safety pause 是设计内） |

**验收结论**：云端 3 连 A/C/E PASS；本地模型 A PASS；soak/断线演练 PASS。C 的会话内 crash notice 是软断言（真信号在 mc-link 台账必过；会话内时延见下）。

## 2. 已确认的产品缺陷与修复（本轮）

| # | 缺陷 | 证据 | 修复 |
|---|---|---|---|
| 1 | body 在 `mine oak_log` 时静默 exit code 1 | c3 `mc-link.jsonl` body-exit: code 1, expected false；stderr 无栈 | persistent `bot.on('error')`、interval try/catch、dig race catch、`process.on('exit')` 兜底；`body-exit.json` 带 reason/stack/recentEvents（selftest 4/4） |
| 2 | `mine oak_log` 在正常地形恒 `no-path` | L1 A（radius 缩到 1 仍 no-path） | `pathCheck` 三态（ok/noPath/unknown）；unknown 继续；降级"最近候选→4.5 格内原地挖"；`walkOnce` 用 `rangeSq`；`name/kind/block` 都认 |
| 3 | 任务结束没有终态/退出码没理由（当事人反馈） | c3/C interview | outcome `paused/unknown/failed`；body-exit 归因；同因崩溃计数（mc-link） |
| 4 | `mcb_scan` count/radius 不符、`dig pos` 格式不清、`mcb_leave` 不报 safety | t5 interview | mc-link 四修（scan 截断+排序、dig 两种坐标、leave 结论先行、cleanup:true） |

## 3. 当事人反馈（原文摘要，详见各 run `interview.md`）

- "想要退出归因：idle_timeout / conn_reset / process_crash / server_kick"；"三次同一种死法，直接告诉我'本会话第 N 次同因崩溃'就好" → body-exit.json + mc-link 计数。
- "place 悬空报错没解释；支持多坐标排序" → place 多坐标 + 可读原因 + autoSupport。
- "pathfinder 不可用只能原地挖放" → pathcheck 三态 + dig fallback。
- "flat 超平坦没有树/矿，没有真活干" → 最终验收换 normal 地形 54840。
- "mcp_leave 不报 safety/stop 成没成" / "一键收工希望 body+focus+goal 一起清" → leave 结论先行 + cleanup:true。

## 4. Soak / 故障演练

- body 30 分钟 soak（54839 平顶）：**PASS** — 615 块 / 76 trips / 0 death / 0 safety_stop / 0 emergency / 0 reconnect / 0 watchdog suppressed；routine done(duration)；pathStats resets 0 / recoveries 14 / stuck 3（routine 换点，被吞并继续）。
- 断线演练（本地 TCP 代理）：**20/20** — offline 不假在线 → 有界重试 → reconnected → 仍 paused、不自动续跑 → 显式 resume → 耗尽后保持离线且拒收任务。

## 5. 证据索引

- `wt/mc-lab/.state/lab/v1/`：最终 A/C/E（transcript/events/scenes/verdict/interview）
- `wt/mc-lab/.state/lab/c3/`：暴露 body 崩溃与 C 断言问题的 run
- `wt/mc-lab/.state/lab/L1/`：本地模型 run（mine no-path 证据）
- `.state/lab/mc-body-soak/2026-11-05-30min-w1b/`：soak report
- `.state/lab/mc-body-soak/2026-11-05-reconnect-drill-final/`：断线演练
- `.state/lab/mc-body-soak/exit-selftest-*/`：退出归因自证
- `wt/mc-link/.state/mc-link-evidence/2026-11-05-w1a.md`：mc-link A/C/E + 20/20 verify

## 6. 结论边界

- "随时来一局"在**云端 flash + 正常地形**下已 A/C/E 全 PASS；本地模型还差一次 A（mine 修复后待跑）。
- 已知遗留：C 的会话内 crash notice 投递有延迟（软断言）；本地模型单轮可能很慢（430s 被 cancel）；54837 世界已脏、survival 54838 未使用。

## 7. 最终验收后的遗留（诚实记录）

1. **健康阈值与"正常游玩"的张力**：LA 本地 A 里她从树上掉下、单次掉 7 血（18→11）触发 safetyStop（阈值"单次≥6 暂停"）。设计上这是 danger 接管，但"砍树摔一次就暂停"会打断正常游玩；mc-body 在评估"区分坠落/战斗伤害或调高阈值"。
2. **craft/place 真服链路证据只拿到部分**：`craft-place-real3`（54840）里 scan/goto 成功、mine oak_log 因 drop 没捡到 + 掉血暂停而失败，导致 craft 缺木板、place 被暂停拒绝。已验证的只是"mine 4 logs→craft oak_planks×12→crafting_table→stick"（real 那次），缺 `craft wooden_pickaxe` 与 `place`（有支撑成功/悬空 skipped）两行。
3. **C 的会话内 crash notice 时延**：mc-link 实测 kill→会话消息 ≈166ms（tick 200ms），但若她正在 turn 内，要等下一个 step 边界才注入（DSH steer 语义）；场景把"signalLogged 查台账"作必过、会话内 notice 作软断言。
4. **本地模型稳定性**：L1 曾出现单次 430s 的 turn 被 session/cancel；LA 22–35s 正常。云端 flash 也出现过一次 >7 分钟挂起（mc-link 循环），重启即可，不当产品失败。

## 8. craft/place 真服链路（19:44 复查）

`craft-place-final`（54840）：scan/goto/mine oak_log ×4 ✓，但：
- `craft oak_planks` 报"产物没进背包（想要 +12，实际 +0，合成 3 次×4）"，而 final inventory 实际有 `oak_planks×13 / stick×4` → **产物校验的 inventory 时序问题**（合成后立即读背包早于更新），不是合成失败。
- `craft wooden_pickaxe` 报"没有可用配方"（缺已放置的工作台/材料链）。
- `place` 因背包无 dirt 失败。
→ 记为下轮 P0（craft 后置校验加等待/重读；需要工作台时先放置；place 材料预检），本轮不再追。已有可复现证据路径。

**19:46 更新（mc-body 结论 + 修复）**：craft `+0` 是 **inventory 更新延迟导致的校验时序 bug**（最终背包 `oak_planks×13/stick×4` 可自证），已修（`a5c09f7`：craft 后轮询最多 2.5s）；`wooden_pickaxe` 缺配方是因为工作台从未放置（前序被误判打断；body 不自动放工作台），报错已改成可操作建议（`b0b2150`）。`mine` 的 `task_done.result` 已带 `{mined,net,requested,item,reason}`，mc-link 下轮可直接显示"净增 N/M"。木镐/place 两行真服证据仍待补（需要 3 分钟 normal 服窗口），原因已闭合。

## 9. craft/place 真服证据（已补齐，2026-11-05 23:0x）

- **`craft wooden_pickaxe` ✓**：`craft-place-proof-2026-11-05/report.md` → `{"crafted":"wooden_pickaxe","requested":1,"craftTimes":1,"perCraft":1,"produced":1,"inInventory":1}`，结束 inventory 有 `wooden_pickaxe×1`。
- **`place` ✓**：`place-proof-2026-11-05`（有支撑 `placedCount:2`，skipped 7 条各带原因）＋ `place-proof3-2026-11-05`（悬空 skipped reason="目标下方没有支撑（下方是 air）；先放一块垫底、传 autoSupport:true，或换位置" / "没有可附着的面（悬空/目标格被自己挡住）"，同 run placedCount:1）。
- 两次 run body 全程未崩、退出 `reason=api-shutdown`；这也真服验证了本轮 mine 净增继续挖、craft 产物轮询 2.5s、可操作报错三项修复。第 8 节的"待补"结论作废（保留为问题发现记录）。
