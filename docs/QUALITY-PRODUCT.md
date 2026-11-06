# 产品/交付面质量审计（只读）· 2026-11-07

> 审计对象：`C:\DSH\icl` master HEAD `649c8dd`（工作区干净），桌面 DSH 已于 02:28 重启。审计时刻 2026-11-07 02:36–02:47（Asia/Shanghai）。
> 范围：产品 preset / core 产品面 / 9 份产品文档 / `package.json` 测试门 / 安装与重启 runbook。
> 证据等级：E0=`npm test` 实跑；E1=只读代码/只读装配复算；E2=桌面进程与 `~/.dsh` 只读状态；E3=文档声明（只作线索）。
> 红线：**未改代码、未改 profile、未重启 desktop、未起 lab**。已知另一路 `mc-night --run l2-20261107-s1` 在 `C:\DSH\icl-wt\mc-lab` 跑（非本审计启动），本文未占用其端口/GPU。

---

## 0. 一句话结论

**产品已经“能用”，但还不到“可靠日常使用”。**

产品 preset 已是 A1：16 个显式插件、ICL 面 **51 工具 / 34,049 字符**、4 段首屏净化、无 `mc-link`。桌面 profile 确实指向本仓库并已重启，但**重启后还没有新的 ICL 会话**；现有最后一次 `icl` 会话是 11-05 创建、11-07 02:26 最后活动的旧会话，仍是旧首屏（4,249 字符、59 工具、11 个 `mcb_*`），且它的 cwd 是 `.state\loop\workspace`（测试工作区，不是用户工作区）。因此 A1 的“进程内效果”尚未被真实会话验收，只能算配置就位。

成熟度判断：**可用（Beta，产品化早期）**。判据见 §3：功能面齐全、单测/宿主级证据强，但真实产品使用只有 16 个会话、无连续日常使用；沙箱/审批未上产品；投递队列不持久化；安装升级仍需人工 Plugin Manager + 重启，旧会话不迁移。

---

## 1. 产品 preset 当前实际装了什么

### 1.1 结论数字（本地只读装配复算，2026-11-07）

| 项 | 实测 | 证据 |
|---|---|---|
| 产品 `icl` 插件 | **16 个**（`memory/world-state/recall/note/lexicon/whois/persona/focus/eager-recall/model-manager/time/dream/editor/bili/video/album`） | `packages/dsh-icl/presets/icl.patch.yml` `preset-icl` |
| ICL 工具面 | **51 个 / 34,049 字符**（Σ 每工具 JSON；cache 数组口径 34,101，差 52=分隔符） | `node tools/calc-product-surface.mjs`；`product-surface.test.mjs` 断言同值 |
| 首屏净化 | **4 段**：`harness:identity` / `ui:deliverable-file-references` / `harness:source` / `app:web-surface` | 同上；机制见 `src/purify.mjs`、`FIRST-SCREEN.md` |
| MC | **0 个 `mcb_*`**；`mc-link` 只在 `icl-mc` 场景 preset | 复算 names 无 `mcb_` |
| QQ | **不在产品 preset**（16 插件里没有 `qq`） | preset 文件；`DEFAULT_PLUGINS` 也没有 qq |
| editor | **仍在**（`read_file/write_file/list_dir`，3 个 / 1,125 字符） | 同上；A2（换原生 fs）未执行 |
| DSH 原生工具 | 产品 preset 只额外挂 `tool-todo`（工具）与 `tool-persona`（身份覆盖）；**没有** `tool-fs` / `tool-fs-search` / `tool-pwsh` | `icl.patch.yml` |

分插件预算（复算）：

| 插件 | 工具数 | 字符 | 说明 |
|---|---:|---:|---|
| album | 9 | 6,619 | 含二阶段 `album_reindex/album_caption` |
| video | 6 | 6,006 | 本地视频“眼睛” |
| bili | 7 | 4,778 | 只读；登录需用户扫码 |
| recall | 3 | 4,315 | 记住/想起/忘掉 |
| time | 9 | 3,842 | 作息/安排/静音/睡眠 |
| focus | 4 | 1,973 | 专注与积压 |
| note | 5 | 1,960 | 备忘/待办 |
| lexicon | 2 | 1,526 | 词典 |
| editor | 3 | 1,125 | 与原生 fs 重复，沙箱未上所以暂留 |
| whois | 1 | 848 | 认人 |
| world-state | 1 | 780 | 世界状态 |
| memory | 1 | 277 | `memory_export` |
| **合计** | **51** | **34,049** | 不含 DSH/其它 bundle 的工具 |

> 51 是 **ICL 面**。真实会话的 `request/header` 还会叠加 DSH 与 profile 里其它 bundle 的工具；旧 ICL 会话 header 是 59 个，但当时工具集不同，不能直接相减。不要把 51 当成用户看到的全部工具数。

### 1.2 与 lab 的差异

| 维度 | 产品 `icl` | lab `icl-lab` | 影响 |
|---|---|---|---|
| 插件 | 16，含 editor，无 mc-link/loop-probe | 15，含 loop-probe、无 editor；原生 fs 三件套 | lab 更接近“沙箱后形态”，产品不是 |
| 工具 | 51 / 34,049（ICL） | 56 / 41,577（含原生 fs；`1ac40db7d8d0`） | lab 工具更多但受 workspace 限制 |
| 沙箱 | **未上**（desktop profile 只有 `danger-full-access` + `approval: never`） | `workspace-write` + `workspaceRoot` + 审批 `ask` | 产品无写边界；lab 已试点 |
| providers | 不写在 preset；读 `config/icl.local.json`（deepseek + llama-swap + bge-m3） | preset 显式写 `qwen35-9b/embed-bge-m3/clip-zh` | 产品依赖仓库文件与环境变量 |
| 首屏 | 4 段 shadow（配置已就位，**未在新会话实测**） | 4 段 shadow，实测 5,011→2,294 字符 | lab 有硬数字，产品待验收 |
| 工具白名单 | 无（生活面全量） | MC preset 有 `toolAllowlist` | 产品面仍靠 preset 插件清单收敛 |

### 1.3 文档数字漂移（需要修，不影响运行）

- `icl.patch.yml` 注释与 `product-surface.test.mjs` 头注释写 **“66/44,316 → 49/31,824”**；实际是 **51/34,049**（测试断言也是 51/34,049）。49/31,824 找不到对应实现。
- `PRODUCT-SURFACE.md` 写“方案，未应用”，但 A1 已应用；A1 数字 51/34,101（数组口径）是对的，容易被误读成“还没做”。
- `DEVELOPING.md` 仍写 “`npm test` 只跑 core”“`js-yaml` 没写进 package.json”“presets 是空转的”，三处都已过期。
- `CACHE-NIGHT` 的产品离线审计是 51/34,101，与本次 34,049 的差只是口径，不是回归。

---

## 2. 用户旅程：安装 → 重启 → 会话 → 能做什么

### 2.1 实际路径（当前机器已验证到哪一步）

| 步 | 操作 | 谁做 | 当前状态 | 证据 |
|---|---|---|---|---|
| 1 | `dsh-icl` 安装进 desktop profile | 用户/lead，**只能走 Desktop Plugin Manager**（`dsh plugin --profile desktop add` 会被 Electron 拒绝） | 已安装：profile `node_modules/dsh-icl` 是指向 `C:\DSH\icl\packages\dsh-icl` 的 junction | `profiles/desktop/package.json`、`node_modules` |
| 2 | 应用 bundle patch（preset `icl`） | 安装器自动 | 已应用；profile 里的 preset 文件就是本仓库 A1 | `packages/dsh-icl/package.json` `dsh.bundle.patch` |
| 3 | 重启 desktop | 用户手动 | 已完成（02:28 启动，进程 8268 等） | `Get-Process` / 启动时间 |
| 4 | 新建 ICL 会话（选 preset **ICL**） | 用户 | **未做**：重启后没有新的 `agentPreset=icl` 会话 | `~/.dsh/storages/session_projcache` 计数 16，最后一次 11-07 02:26 |
| 5 | 首屏/工具/facts 验收 | cache/lead | **未做** | 无新会话可查 |

> 关键：**A1 只对新会话生效**。旧会话不会因为重启而换首屏/工具面；产品当前最后一次 `icl` 会话（`session-737ec994`，11-05 15:36 创建，11-07 02:26 最后活动）仍是 4,249 字符 system、59 工具、11 个 `mcb_*`。如果用户直接恢复这个会话，会以为 A1 没生效。

### 2.2 新会话里用户真正能得到什么（按 preset 能力）

| 能力 | 工具/行为 | 用户可见结果 | 仍需人工/开发者 |
|---|---|---|---|
| 人格与生活说明 | `persona.md` + `sim.md` 静态段；首屏净化后应只剩“她是小千” | 首行人格而非 coding-agent；4 段工程脚手架消失（预期 2.3–2.9k 字符，待实测） | 需新建会话；旧会话不迁移 |
| 记忆 | `remember/recall/forget` + `memory_export` | 记住、想起、忘掉；重启后仍在（SQLite） | 导出是手动；无自动备份 |
| 备忘/待办 | `memo/memos/memo_append/memo_commit/note_status` | 便签、待办、未结事项进世界状态 | 无 GUI 面板，全靠对话 |
| 时间/作息 | `time_*` 9 个 + awake tick | 安排、提醒、睡眠、静音、暂停、醒来简报 | 时区/长周期日程只有单测与 4h22m 证据；`time_edit` 仍在 |
| 专注 | `focus_*` 4 个 + 积压 | 进/出专注，别处消息进积压，释放时合并摘要 | 无用户可见的“她正在忙”提示（只有 facts 段） |
| 认人/词典 | `whois`、`lexicon*` | 按 QQ/MC/名字认人，学新词 | 人物档案依赖 dream 与 QQ 入站；产品无 QQ |
| 相册 | `album_*` 9 个 | 导入、搜索、拼图、隐私项默认不展示、不自动删 | 图片语义检索需要 512d CLIP；当前 `config/icl.local.json` 只有 bge-m3(1024)，`image-embed` 会 optional 未绑定 → 图片向量检索降级 |
| 视频“眼睛” | `video_*` 6 个 | 看本地视频、分镜、定位台词 | 需本机 ffmpeg/storyboard CLI；不下载 URL |
| B 站 | `bili_*` 7 个 | 搜索/看视频/评论/首页/切帧 | 登录要用户扫码；凭证 2026-12-01 过期；只读 |
| 文件 | `read_file/write_file/list_dir`（editor） | 读写 `stateDir` 内文件 | 与原生 fs 重复；沙箱未上，暂不能换 |
| 主动醒来 | time awake tick（默认 idle 120s + 135s 节拍） | 没人说话时她也会自检/续推 | 无会话时也在跑定时器（见 §4-3） |
| QQ | **无** | 桌面 ICL 收不到 QQ、也不能回 | QQ 只在 lab/headless；产品要另加 `qq` 插件并做真机验收 |
| MC | **无**（产品面） | 玩 MC 要另选 `icl-mc` preset | `icl-mc` 不是产品默认；且当前常驻进程在轮询不存在的 body（见 §4-3） |

### 2.3 用户旅程里的“人工/开发者”清单

1. 安装：只能 GUI Plugin Manager（或同一 Remote），没有 CLI；没有版本号/升级 diff/一键回滚。
2. 重启：必须整应用重启，不能只刷新页面；重启前要关掉旧 ICL 会话（单会话锁），否则新会话被拒。
3. 旧会话：不会自动迁移到新 preset；需要用户自己新建会话。
4. 沙箱/审批：桌面 profile 仍是 `danger-full-access` + `approval: never`，没有 `ask` 路径；不在场时无法批准升权（QQ 应答器未就绪）。
5. 配置：providers/路径来自仓库 `config/icl.local.json` 与环境变量；换机要按 `PATHS.md` 迁移，且必须停机。
6. 观测：`icl.ready/icl.tools/icl.bootstrap` 只写进程日志；本机没有落盘日志文件，出问题要开发者抓 stdout/会话事件。

---

## 3. 成熟度分阶段判断

### 3.1 判据与结论

| 判据 | 现状 | 判定 |
|---|---|---|
| **测试门（E0）** | `npm test` = **780 tests / 779 pass / 1 skip / 0 fail**（12.4s，exit 0）；skip 是真实 clip-zh 集成（需 `ALBUM_CLIP_SMOKE=1`） | ✅ 强；但以 host/单元为主 |
| **真实产品使用** | 投影里 `agentPreset=icl` 共 **16 个会话**，最近一次 11-07 02:26；重启后 0 个新 ICL 会话；**16 个的 cwd 全是 `.state/live*`、`.state/loop/workspace` 或 `C:\DSH\qwenstuff`，没有真实用户工作区**；没有“连续 N 天日常使用”样本 | ⚠️ 不足 |
| **真实长跑** | night-1：6h29m、64 turns/1182 calls/281 err、hit 99.50%、8 次全量失效全是会话重启；但这是 lab + 本地模型，不是产品桌面 | ⚠️ 参考，不等于产品 |
| **失败恢复** | time/focus/memory 重启恢复有测试；单会话锁/agent dispose 放行有测试；**delivery 队列纯内存**，进程崩溃丢待投递（DL-7 未达成） | ⚠️ 部分 |
| **安全边界** | 产品 `danger-full-access`、`approval: never`；沙箱只在 lab；editor 仍是 raw fs；无审批 UI/QQ 应答器 | ❌ 未达日常可靠 |
| **可观测性** | 有 `icl.ready`（plugins/failed/tools/slots/stateDir）、`icl.tools`、delivery `blocked/dropped` 计数；无落盘日志、无 UI 面板、无产品工具数/首屏字符自动记录 | ⚠️ 开发者可查，用户不可见 |
| **安装/升级** | Plugin Manager + 重启；旧会话不迁移；无版本化升级/回滚；A1 只能靠新建会话生效 | ⚠️ 人工 |
| **文档** | 9 份产品文档齐全，但多处数字/状态漂移（§1.3）；`DEVELOPING/DSH-INTEGRATION` 有过期章节 | ⚠️ 需收敛 |
| **平台覆盖** | 只验证 Windows + 本机 desktop；QQ/MC 真机只在 lab/独立进程 | ⚠️ 单机 |

### 3.2 阶段定义与当前位置

| 阶段 | 定义 | 当前 |
|---|---|---|
| 原型 | 功能可演示，主要靠 mock/单测；真实路径未打通 | 已过 |
| **可用（Beta）** | 真实产品路径能完成核心任务（聊天/记忆/时间/相册/视频/B站），但需要开发者/人工兜底，失败后要手动恢复 | **← 这里** |
| 日常可靠 | 连续 1–2 周真实使用；重启/崩溃不丢唤醒与消息；审批/沙箱可用；问题能从 UI/日志定位；不需要每次找开发者 | 未到 |
| 生产 | 多用户/权限隔离/备份恢复/版本升级/审计；有 SLA 与回滚演练 | 未到 |

**判断：可用（Beta，0.2.x 产品化早期）。** 不是“原型”（真实会话、真实模型、真实记忆都跑过），也不是“日常可靠”（缺沙箱/审批、投递不持久、旧会话不迁移、产品使用样本太少）。

### 3.3 支持“可用”的证据

- `READINESS-MATRIX`：13 域 65 条判据，**56 达成 / 3 部分 / 2 未达成 / 4 判据有问题**，无 P0；未达成是“本地 MC 3 连”和“投递崩溃恢复”，都是已知取舍。
- 缓存：night-1 6h29m `hit=99.50%`，8 次全量失效全部是会话重启；5 轮 A/B 首屏净化冷启动 -568 tok（-7.1%）、稳态零回归。
- 工具面真实调用：firstscreen 5 轮 8 次工具调用 0 错误；album/video/bili/time/focus 都有单元/集成测试。
- E0：780 条测试覆盖 memory/time/focus/delivery/signals/bridge/QQ/MC/album/video/bili；`node --test` 12.4s 可重复。

### 3.4 不支持“日常可靠”的证据

- 产品首屏/工具数**没有 live 新会话数字**；旧会话仍是旧布局（4,249 字符 / 59 工具）。
- 产品使用只有 16 个 `icl` 会话（cwd 全是测试/历史目录，无真实用户工作区），且重启后没有新会话（最后一次在重启前 2 分钟）；无法证明“每天用”。
- delivery 纯内存，崩溃即丢；重启后靠上游重发，ICL 自己没有持久队列。
- 沙箱/审批未上产品；`danger-full-access` + `never` 意味着没有“危险操作先问一声”的路径。
- 安装/升级/回滚全靠人；旧会话不迁移；单会话锁会让“新会话”直接被拒。

---

## 4. 主要风险/缺口（按“离日常使用”排序）

### R1（P0，最近）A1 尚未在真实新会话验收；旧会话会误导

- 重启后没有新的 `agentPreset=icl` 会话。最后一次产品会话仍是 11-05 的旧布局：system 4,249 字符、header 59 工具、11 个 `mcb_*`。
- 用户若恢复旧会话，会看到旧首屏/旧工具面，并可能以为 A1 没生效。
- 单会话锁使“先关旧会话再开新会话”成为硬步骤；错误文案只说“已占用”，没有一键归档/迁移。
- **判据**：新建会话首行 `你是小千。`、静态 system ≈2.3–2.9k、4 段脚手架消失、51 个 ICL 工具、0 个 `mcb_*`、facts 仍走 runtime-context。未做 = 不能宣称 A1 交付。

### R2（P1）沙箱/审批未上产品，且没有“问一声”的路径

- desktop profile 只有 `danger-full-access` + `approval: never`，没有 `workspace-write`/`ask`；product preset 也没换原生 fs，editor 仍用 raw fs。
- `SANDBOX-PLAN §7.7` 明确：产品化要 `defaultPreset: workspace-write` + `workspaceRoot` + 审批应答者；QQ 应答器未就绪，不在场时升权会 `unavailable`。
- 风险不是“她现在会删库”，而是**边界不存在**：一旦以后加原生 pwsh/fs，或 B 站/QQ 内容触发注入，没有可依赖的写边界/审批链。
- 另有实测坑：pwsh 越界 `isError=false`（§7.8-1）会骗过按 `isError` 判断的消费方；ACL 会残留 `Everyone:(CI)(DENY)`/Low 标签。

### R3（P1）三个 preset 在启动时全部 boot，测试/场景 preset 产生真实副作用

- 证据：02:28 桌面启动后，`.state/loop-state/session-events.jsonl` 被清空（`icl-loop` 的 boot 会写空 raw）；`.state/mc-state/mc-link.jsonl` 在 02:39 仍每 ~30s 记一条“连不上 body（54836）”的 safety alarm；`~/.dsh/icl/state/time.json` 在无会话时仍每 ~135s 写 awake tick。
- 原因：`plugin.mjs` 在 apply 末尾无条件 `ensureBoot()`，preset 在 DSH 启动时就挂载；boot 会启用 time/mc-link/loop-probe 等插件。
- 影响：无会话时也有定时器、MC 轮询、日志/状态增长；产品 profile 里带着 test-only `icl-loop`。好消息是 `bindSession` 会清空 delivery 队列，旧通知不会投给新会话；坏消息是 time.json/日志已被写入噪声，且这些副作用每天都在发生。
- 建议：boot 改为“匹配 preset 的 session/created 后再装配”，或至少让 mc-link/loop-probe 在无会话时不启动。

### R4（P1）投递不持久化，重启/崩溃会丢唤醒与消息

- `createDeliveryService` 的 queue/inflight/watermark 全在内存；`nack` 5 次后 `droppedCount++` 丢弃；没有落盘/启动重放（READINESS DL-7 未达成）。
- 日常使用必然重启 desktop；睡眠/静音积压在 time 侧有状态，但 delivery 层的待投、focus backlog 的释放、QQ 回执在崩溃窗口内会丢。
- 现有缓解：上游可重发、`droppedCount` 可观测、time backlog 有落盘；但“ICL 自己保证不丢”不成立。

### R5（P1）产品可观测性不足：出问题只能找开发者

- 日志走 `ctx.logger('icl')`/stdout，本机没找到落盘 ICL 日志；`icl.ready` 有 tools/slots，但用户看不到。
- 没有 UI 面板显示：当前 preset、工具数、system 字符、facts 快照、delivery 队列、最近失败。
- 真出问题时只能：读 session 事件、grep `~/.dsh`、跑 `tools/cache-layout-audit.mjs`；这不是日常用户能做的。

### R6（P2）工具面仍偏大，且“51”不是用户看到的全部

- 51 个 ICL 工具 / 34k 字符是固定前缀成本；真实 header 还叠加 DSH/profile 其它 bundle（旧会话 59）。
- E2 实测 48 个工具里 31 个 120 分钟 0 调用；`time` 9 个、`memo` 5 个、`album` 9 个都有低频项。
- `MODERNIZATION-CANDIDATES` 建议守“不轻易加工具”；A2+O 可到 45/31,923，但未获批。
- 影响：模型选工具更慢、描述预算更紧、用户更难看懂“她到底会什么”。

### R7（P2）QQ 不在产品面，真机闭环没有产品入口

- 产品 16 插件里没有 `qq`；`DEFAULT_PLUGINS` 也没有。QQ phase1（只读影子 + 私聊回）只在 lab/headless 验证。
- 如果用户期望“她能在 QQ 里找我”，当前桌面 ICL 做不到；如果产品不做 QQ，应在 UI/文档明确，而不是留在 `QQ.md` 的 110KB 设计里。
- 相关风险：QQ 私聊默认 ambient、focus pierce 语义已改；但产品没有真机 QQ 验收，不能把 lab 结论当产品结论。

### R8（P2）dream/embed 依赖外部 provider，缺省会静默降级

- 产品不显式写 providers，读 `config/icl.local.json`；dream-chat/embed-text 必须在启动时绑定，否则 `icl.slots-unmatched` 报 error，dream 的 events/people/lexicon/cleanup 会整段缺席（night-1 就发生过“只跑 wash/consume/index”）。
- `image-embed`（512d）是 optional；当前配置只有 bge-m3(1024)，没有 clip-zh → 图片向量检索降级，`album_search` 退回文字标签。
- 这些都有日志/status，但用户不会看；表现为“她昨晚没做梦/相册搜不到图”。

### R9（P2）安装/升级/回滚仍是开发者流程

- 只能 Plugin Manager 安装；模块要重启才加载；旧会话不迁移；没有版本号 diff、没有一键回滚 UI。
- 回滚路径是“改 preset/删 profile patch → 再重启”，没有演练记录（`PRODUCTIZATION-KICKOFF §4` 仍把“回滚演练”列为可选）。
- 换机要按 `PATHS.md` 停机迁移；`ICL_ROOT` 在 Electron 里不继承 PowerShell env，必须用户级环境变量或 preset config。

### R10（P2）文档漂移会误导下一位接手人

- 见 §1.3：preset/test 注释 49/31,824、DEVELOPING 的测试/js-yaml/presets 描述、PRODUCT-SURFACE 的“未应用”。
- `DSH-INTEGRATION.md` 的 §1–§8 是旧 `icl-live` 历史，虽然开头说“不要照它接线”，但 176 行里 120 行是旧路径，容易被误读。
- 建议：把“当前产品事实”收敛到一份 `STATUS`/本文件，历史文档加“仅历史”标记或归档。

### 其他已确认但优先级较低

- **缓存**：night-1 99.5%，但产品未测；DSH 的 `compaction-basic`/`tool-result-pruner`/`image-offload` 是第二股历史改写源，长会话会一次性全量失效（CACHE-MODEL §7.2/§7.9）。
- **A1 净化去掉 deliverable 段**：如果以后要交付 Office/图片文件，模型不再有 present/file-link 指引；需要按 FIRST-SCREEN §6 只保留该段。
- **editor 与沙箱冲突**：`SANDBOX-PLAN §4.2` 已判 editor 是洞（raw fs 绕过 workspace），产品仍带着它；一旦启用 workspace-write，必须同批下线。
- **单会话锁**：对“一个她”是正确设计，但对用户体验是硬约束；归档/dispose 已能释放，但没有 UI 提示。
- **`time` 的 135s 清醒节拍**：无会话时也在写；有会话时是特性，没会话时是噪声（并入 R3）。

---

## 5. 给 lead 的下一步优先级（3–5 条）

### P0-1 先做一次“新会话 A1 验收”，拿到产品 live 数字

- 新建一个 ICL 会话（不要复用旧会话），记录：首行、静态 system 字符、4 段是否消失、ICL 工具数/字符/hash、`mcb_*`=0、facts 快照 ≤1/轮、`systemHasDynamicFacts=false`、第一次工具调用成功。
- 同时让 cache 记产品基线（toolsChars/toolsHash/system 字符）；没有这组数字，A1 只能算“配置就位”。
- 验收后把结果写回 `CACHE-NIGHT` 的指纹表和本文件 §1。

### P0-2 处理“旧会话/单会话锁”的产品 UX

- 在文档/安装 runbook 里写死：升级 preset 后必须**新建** ICL 会话；旧会话不会变。
- 单会话锁的错误文案补“如何关旧会话/归档”；若 DSH 支持，提供“归档旧会话并新建”的一步操作。
- 否则用户重启后恢复旧会话，会得到“A1 没生效”的错误结论。

### P1-1 让 preset 启动惰性化，清掉测试/场景 preset 的常驻副作用

- 只在匹配 `presetId` 的 `session/created` 后 boot；或让 `mc-link`/`loop-probe`/`time` 在无会话时不启动。
- 产品 bundle 不应把 test-only `icl-loop` 装进桌面；至少不要让它在启动时清 raw/写 outbox。
- 验收：重启后无 ICL 会话时，`mc-state/mc-link.jsonl` 不再每 30s 增长，loop raw 不被清空，time 不空转。

### P1-2 投递持久化 + 产品可观测性最小集

- delivery 队列落盘（`.state/delivery.jsonl` + 启动重放），或明确改为依赖 DSH inbox 并在文档写清“崩溃会丢什么”。
- 加一个用户/lead 可读的 status：当前 preset、ICL 工具数、system 字符、facts 快照数、delivery pending/dropped、最近错误；至少写一个轮转日志文件。

### P1-3 沙箱/审批作为“日常可靠”的下一道门（与 editor 下线同批）

- 按 `SANDBOX-PLAN §7.7`：desktop profile 改 `workspace-write` + `workspaceRoot`，product preset 去 `editor`、加原生 `tool-fs/tool-fs-search/tool-pwsh`，保留 `danger-full-access` 回滚。
- 审批先做“桌面在场可 ask”；QQ 应答器作为不在场的前置，未就绪前不要让 `ask` 变成静默拒绝。
- 验收：写 workspace 成功、写外部拒绝、`FS_SANDBOX_DENIED` 可见、pwsh 越界不再 `isError=false`、回滚演练一次。

> 如果只能做两件：**P0-1（新会话验收）+ P1-1（启动惰性化）**。前者决定“A1 是否真的交付”，后者决定“产品进程是否干净、可观测”。

---

## 附录 A：本次复算命令与证据

```powershell
# 1) 产品工具面（只读装配，临时 stateDir）
node tools/calc-product-surface.mjs
# → {"tools":51,"chars":34049,...}

# 2) 全量测试（E0）
npm test
# → tests 780 / pass 779 / fail 0 / skipped 1；exit 0

# 3) 产品 preset / profile
Get-Content packages/dsh-icl/presets/icl.patch.yml
Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\package.json"
Get-Item "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-icl"   # junction → C:\DSH\icl\packages\dsh-icl

# 4) 旧产品会话（只读解压，不写 profile）
#    system 4,249 字符；header 59 工具；11 个 mcb_*
#    session-737ec994（--C-DSH-icl-.state-loop-workspace--）

# 5) 会话 preset 统计（~/.dsh/storages/session_projcache）
#    icl=16、icl-mc=4、icl-loop=19、icl-lab=2、icl-mc-lab=1；icl 最近 2026-11-07 02:26
#    16 个 icl 的 cwd：.state/live*、.state/loop/workspace、C:\DSH\qwenstuff；无真实用户工作区

# 6) 启动副作用
Get-Content .state/mc-state/mc-link.jsonl -Tail 3   # 54836 连不上，每 ~30s
Get-Item .state/loop-state/session-events.jsonl    # 02:28:20 被清空
Get-Content "$env:USERPROFILE\.dsh\icl\state\time.json"  # lastAwakeTickAt 02:38
```

## 附录 B：本次未做 / 不能下结论的事

1. **未新建 ICL 会话**（任务只读），所以 A1 的首屏/工具数/facts 没有产品 live 数字；§1 的 51/34,049 是 host 级只读装配，不是 header。
2. **未改 desktop profile、未重启**；§2 的“已完成”只到 02:28 重启，不含新会话验收。
3. **未跑 lab**；night-1/E2 数字来自既有文档与落盘证据，不是本次复跑。
4. **未验证 QQ 真机**；QQ 结论只到“产品 preset 没有 qq、lab/headless 有代码与测试”。
5. **另一路 lab 正在跑**（`mc-night --run l2-20261107-s1`，57101/54838），本文未触碰其进程与 GPU；如果它的状态与本文件的时间点冲突，以该 run 的 `events.jsonl` 为准。
