# ICL 整体质量与阶段评估（2026-11-07 凌晨）

> 依据：4 份只读质量审计（`QUALITY-CORE.md` / `QUALITY-INTERFACES.md` / `QUALITY-MC.md` / `QUALITY-PRODUCT.md`），加上 master 实测（`npm test` 795 tests / 794 pass / 1 skip）与 E2/local3 第一人称证据。
> 判据：**不是"有多少功能"，而是"用户/当事人真正能得到什么、失败时是否可观测、有没有被真实使用验证"**。

## 0. 一句话阶段判断

**可用（Beta，产品化早期）——核心循环与"存"已经能跑，但"取"、真实使用和异常恢复仍未被验证；MC 是 Alpha 且冻结中。**
不是 Demo（时间/睡眠/记忆/投递有真实长跑证据），也远未到"日常可靠"（无真实用户工作区使用、QQ/相册/视频真实使用面为 0、沙箱/审批未上、投递队列纯内存）。

## 1. 模块矩阵（交付功能 / 当事人价值 / 成熟度）

| 模块 | 交付的功能 | 当事人/用户得到什么 | 成熟度 | 关键缺口 |
|---|---|---|---|---|
| core/host/bridge | 服务注册、工具面、投递泵、focus/time 双闸门、facts | 会话能启动、工具可见、消息能送达 | **beta+** | delivery 纯内存；表面错误易静默（QQ manifest 即例） |
| time | 作息/睡眠/暂停/静音/积压/唤醒/goal/时钟 | 会睡会醒、被拦的话不丢、醒来有简报 | **beta+** | 长跑队列持久化/跨崩溃恢复未验 |
| memory | 记忆库、事件/人物/词典、压缩、dream 产物 | 记得发生过的事 | **beta** | "取"未验证（recall 0 调用） |
| recall | 语义/关键词召回、空结果诚实 | 能想起过去 | **beta-** | 真实场景 0/64 轮；噪声/相关性证据少 |
| dream | 睡眠时整理、7 job 三态、成块 | 夜间整理成可回忆块 | **beta-** | 仅 11-07 一次 5 块样本；质量门未自动化 |
| note/lexicon/whois | 备忘/词典/人物档案 | 记待办、认人、学词 | note beta-/lexicon/whois **alpha** | 真实使用 0；16 条 note 全 open、0 结案 |
| eager-recall | 每轮注入上下文 | 不用问也能看到相关记忆 | **beta** | 无嵌入时 0 注入 |
| focus/world-state | 专注/积压/世界状态 | 别处的事先排队、当前在哪 | beta | — |
| qq | 私聊收/发/账本/提醒/表情/媒体 | 和她私聊、被提醒 | **alpha** | **manifest 曾漏 8 工具（已修）**；不在产品 preset；真实 QQ 未验；账本默认内存 |
| album | 导入/列表/搜索/拼图/隐私/向量 | 看图、按语义找图、拼图 | **alpha**（图片记忆 prototype） | 真实库 0 件 0 向量；本地 config 无 clip-zh；export/发送未交付 |
| bili | 搜索/视频/评论/feed/frames | 看 B 站、看封面 | **beta** | 写入未验（只读）；cookies 12-01 到期 |
| video | probe/open/storyboard/zoom/locate/frames | 看任意本地视频 | **beta** | 真实使用 0（无 work/）；ASR 精度限制 |
| editor | 读写 stateDir 文件 | 会写自己的文件 | **alpha** | 写保护漏 time-events/qq-ledger/bili 凭证等 |
| mc-link/body | 17 工具、宏/战斗/建造/眼睛 | 进 MC 生活/打怪/建房 | **alpha（冻结）** | local3 任务成功率 6.6%、shelter 0 done、say 刷屏、证据采集有硬伤 |
| 产品/交付 | 产品 preset（A1）、首屏净化、缓存 | 桌面 ICL 可用 | **beta（早期）** | **A1 live P0（`{{cwd}}`，已修待重启）**；沙箱/审批未上；重启/旧会话 UX |

## 2. 真实使用证据（最刺眼的部分）

- **"存"有证据，"取"没有**：night-1 6h29m 睡眠/积压/dawn/cache 99.50% 都真实；但真实会话里 recall 0/64 轮、whois 0/54、note 0/54，eager 无嵌入时 0 注入。记忆的"想起来/认人"仍是假设。
- **接口真实使用面接近 0**：album 真实库 0 件 0 向量；video `.state/video-tmp` 无 `work/`；QQ inbox/ledger/表情库全空；MC 截图只有离线 demo 1 张。
- **dream 只有一次质量样本**：11-07 凌晨首次成块 5 块（4 好 1 重复，近重复已修）；night-1 整晚 0 块根因是 lab 未配 provider（已补三态记账）。
- **产品会话没有真实用户工作区**：投影里 16 个 icl 会话 cwd 全是 `.state/live*`、`.state/loop/workspace`、`qwenstuff`；无连续日常使用。
- **A1 未 live 验收**：desktop 重启后旧会话恢复，A1 只对新会话生效；且 preset 有 `{{cwd}}` P0（已修，待再重启+新会话）。

## 3. Top 风险（按"离日常使用"排序）

1. **A1 live P0**：`tool-persona.suffix` 引用 `{{cwd}}` → desktop 内置 DSH 每个 ICL turn 请求前失败。修复已进 master，**待用户再重启 + 新建 ICL 会话**；需要 `A1-LIVE-VERIFY` 复测。
2. **工具面静默丢失**：QQ manifest 只声明 2 / 实际注册 10，8 个工具模型永远看不见（已修 + 加 `manifest-tools` 不变量测试）。同类问题可能存在于"surface 按 manifest 过滤"的其他插件，测试已覆盖源码静态扫描。
3. **消息完整性刚补但未真机**：`delivered ≠ attended`、queued≠delivered、focus/time 重放回执都已实现（单测全绿），但真实 QQ 链路未验证；账本在产品装配默认内存模式。
4. **"取"未验证**：recall/whois/note 真实使用 0；没有"她真的想起来/认人"的证据。
5. **delivery 纯内存 + 可观测性只有 stdout**：崩溃丢队列；无持久化/状态查询。
6. **沙箱/审批未上产品**：desktop 仍 danger-full-access + approval never；旧项目审批 A/B 结论是"只借自然语言应答，不搬状态机"（见 `MODERNIZATION-CANDIDATES.md`）。
7. **工具面膨胀**：A1 已把产品 ICL 面压到 51 工具/34k 字符，但仍需守"不轻易加工具"；MC 17 工具且大量 0 调用。
8. **文档漂移**：14 条（QQ.md §12 自相矛盾、ALBUM.md 路径/exportFile、VIDEO-EYES:145、MC-EYES:213、STATUS.md bili 工具数、README/preset 注释 49/31,824 vs 实际 51/34,049…）。
9. **MC 证据硬伤**：local3 events 只覆盖最后 15min、body seq 3 次回绕、S2 9 代 lab 重启跨 3 commit；F2/冻结报告部分结论（"91 次 shelter 任务/绕开 mcb_shelter"）与 toolCounts 矛盾，引用 seq 未带事件类型。**L2 采集已要求修正这几点。**
10. **相册/视频/QQ 真实闭环**：album 真实 0 件；video 从未真实调用；QQ 未真机；发送通道/审批未交付。

## 4. 给用户的下一步优先级建议

1. **P0**：用户再重启 desktop → **新建 ICL 会话**（不要恢复旧会话）→ cache 跑 `cache-live-audit --latest-icl` 回填 A1 live 数字；若仍有异常立即修。
2. **QQ 产品化决定**：qq 不在产品 preset/DEFAULT_PLUGINS；若要在桌面用 QQ，需要批准加入白名单 + 真机验证（SnowLuma 可用时）+ 账本持久化。
3. **真实使用验证**（比加功能重要）：用 20 张真实图片验 album+clip-zh；用真实本地视频跑 video 全套；QQ 私聊闭环（补课/唤醒/表情/已读）。
4. **"取"的验证**：跑一次带"过去指代"的会话，确认 recall 调用与结果质量；note 结案闭环。
5. **B/C 实验结果**：renderTail / compactWake 的 A/B 是否真降状态调用/wakeClass 字符；有收益再考虑产品化。
6. **delivery 持久化 + status**；沙箱/审批按旧项目结论做"自然语言应答 + per-call 绑定"最小版。
7. **MC 保持冻结**：L2 只收集不满意；修复等外部研究/机制设计完成，且不再新增 MC 工具。

## 5. 质量门现状

- `npm test`：**795 tests / 794 pass / 1 skip（ALBUM_CLIP_SMOKE gated）/ 0 fail**（约 12s），已加 manifest-vs-registered、preset-{{cwd}} 兼容等不变量测试。
- Lab：icl-lab **56 工具 / 41,577 字符 / `1ac40db7d8d0`**；icl-mc-lab **27 / 21,459 / `c91bce1e703b`**；产品 A1 离线 **51 / 34,049（Σ）/ 34,101（数组）**。
- 缓存契约：system 1 append/0 replace、无动态 facts、`image/offload=0`；首屏 4 段净化已配置（live 待重启复测）。
- E2/local3 证据可审计性：L1 回放器已实现（示例 PASS）；L2 计划已加"证据完整性 gate"（events 覆盖/seq 回绕/lab 代际/commit）。
