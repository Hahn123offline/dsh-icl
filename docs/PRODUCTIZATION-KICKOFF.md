# 产品化启动草案（首屏 / album / video / sandbox）· 2026-11-06

> 状态：**草案，未应用**。本文件只写"如果用户批准，改哪里、怎么验、怎么回滚"；**没有修改产品 preset、没有修改 desktop profile、没有重启 desktop**。
> 读者：用户 / lead / cache（复核基线）/ desktop 负责人。所有 patch 片段需用户逐项批准后才由 lead（preset）或用户/lead（desktop profile）执行。
> 关联：`docs/FIRST-SCREEN.md`、`docs/ALBUM.md`、`docs/VIDEO-EYES.md`、`docs/SANDBOX-PLAN.md`、`docs/COMPLEXITY-AUDIT.md`、`docs/CACHE-NIGHT-2026-11-06.md`。

## 0. 一句话

产品 preset 现在**既没有首屏净化，也没有显式插件白名单**；而 `DEFAULT_PLUGINS` 已含 album/video/editor/bili/mc-link——本地按仓库默认装配是 **66 个 ICL 工具**。所以"album/video 产品未启用"的旧文档已过期。产品化要做的不是"再加插件"，而是**把隐式默认变成显式批准清单 + 首屏净化 + 沙箱边界**，然后一次性重启桌面验证。

## 1. 当前事实（仓库，2026-11-06，master `6d2c518` 之后）

| 项 | 现状 | 证据 |
|---|---|---|
| 产品 preset `packages/dsh-icl/presets/icl.patch.yml` | 三个 preset（`icl` / `icl-loop` / `icl-mc`）；`icl-core` 只配 `presetId: icl`，**无 `plugins:`、无 `purifySections`** | 文件本身 |
| 产品 preset 实际插件 | 继承 `DEFAULT_PLUGINS`（17 个）：memory/world-state/recall/note/lexicon/whois/persona/focus/eager-recall/model-manager/time/dream/editor/bili/video/mc-link/album | 本地 `bootstrapHost` 装配模拟 |
| 产品实际 ICL 工具数 | **66 / 44,316 字符**（含 7 个 `album_*`、6 个 `video_*`、7 个 `bili_*`、17 个 `mcb_*`、editor 3 等） | 同上（`normalizeConfig({presetId:'icl'})` + bootstrap）；分项见 `PRODUCT-SURFACE.md` §1 |
| 首屏净化 | 只在 lab preset 开（4 段 shadow）；产品未开 | `docs/FIRST-SCREEN.md` §2/§6 |
| sandbox | 只在 lab 进程 `workspace-write`；产品仍按 desktop profile（未改） | `docs/SANDBOX-PLAN.md` §7/§7.7 |
| 工具/静态体积（cache） | icl-lab（有 video/新插件）**54 工具 / 39,350 字符 / `c1df0e849a9f`**；system **4,195 字符**；icl-mc-lab（allowlist）**27 / 21,459 / `c91bce1e703b`** | cache sanctioned 审计（`6d2c518`），`CACHE-NIGHT §9.1/§9.2` |
| 旧文档漂移 | `ALBUM.md §10`、`PLUGINS.md`、`VIDEO-EYES.md` 曾写"产品 preset 未挂 album/video（34/41 工具）"——**已在本轮修正为当前事实**（产品按默认装配含 album/video，66 工具） | 见三份文档 §启用范围 |

> **结论**：产品化的第一步是"确认 66 工具 / 44,316 字符的固定前缀成本是否可接受"（cache 的 icl-lab 54/39,350 可作量级参考）。**方案见 `docs/PRODUCT-SURFACE.md`**：把 mc-link(17/12,492) 从产品 `icl` 移到已有的 `icl-mc` 场景 → **49/31,824**（A1）；sandbox 后再下线 editor(3/1,125) → **46/30,699**（A2），正好 45–50 工具 / 28–32k 字符目标。

## 2. 草案 A：产品 preset patch（`presets/icl.patch.yml`，**不直接应用**）

### A1. 首屏净化（最小改动，推荐先做）

在 `preset-icl` 的 `icl-core.config` 里加：

```yaml
purifySections:
  - 'harness:identity'
  - 'ui:deliverable-file-references'
  - 'harness:source'
  - 'app:web-surface'
```

- 预期（lab 实测）：静态 system **5011 → 2294 字符（-54%）**，首行 `You are an AI agent…` → `你是小千。`；persona+sim 占比 43.5% → 96.3%。
- 产品需在重启后复核实际数字（产品会话可能带额外段）。
- 回滚：删这 4 行（`purifySections: []` 即整体关闭）。
- 风险：`ui:deliverable-file-references` 是 Office/图片文件交付指引；她日常生活（聊天/刷视频/玩 MC）不需要。若未来保留"做文件"，只保留这一段、删其余 3 行。

### A2. 显式插件白名单（把"隐式默认"变成"批准清单"）

当前 `icl-core` 无 `plugins` → 默认全量；建议显式写死**今天实际生效的 17 个**（行为不变，只锁面）：

```yaml
plugins:
  - memory
  - world-state
  - recall
  - note
  - lexicon
  - whois
  - persona
  - focus
  - eager-recall
  - model-manager
  - time
  - dream
  - editor
  - bili
  - video
  - mc-link
  - album
```

- 这是**无行为变化**的加固：以后 `DEFAULT_PLUGINS` 加了新插件，产品不会被动多出工具（要显式批准）。
- 若用户决定"产品先不上 album/video/bili/editor"，则从清单删掉对应行（**行为变化**，需单独批准；工具数按插件递减：album -7、video -6、bili -7、editor -3）。
- 回归：`preset-plugins.test` 目前断言"产品 preset 未挂载项是最小待批准白名单"；改成"产品 preset 的 plugins 必须显式且 ⊆ 已批准清单"。

### A3. album / video 产品启用

代码上它们**已经随默认装配在产品生效**；所以产品化的实质是：
1. 用户明确批准"产品会话可用 album/video"（含 album 隐私/发送边界：`album_send` 不存在、私密默认不展示、发送需审批）。
2. 文档/测试改成"产品 preset 显式列出 `- album` / `- video`"。
3. 不额外改代码（插件本身 lab 已验证）；cache 需在重启后记新的 product toolsHash/toolsChars（历史 lab 指纹不回改）。

### A4. editor → DSH 原生 fs 工具（与 sandbox 同批，需批准）

`SANDBOX-PLAN §7.7-1`：产品 preset 把 editor 换成原生 `read/write/edit/glob/grep/pwsh`，`DEFAULT_PLUGINS` 去 `editor`。这属于 sandbox 产品化的一部分，建议与 A5 同批做、同批验。

## 3. 草案 B：sandbox（desktop profile，用户/lead 执行；**本任务不碰**）

> 来源 `docs/SANDBOX-PLAN.md §7.7`。产品 preset 本身不写 sandbox（permission 是进程/宿主层），所以这是 **desktop profile** 的 patch，不是仓库 preset。

建议 profile patch（`~/.dsh/profiles/desktop/cordis.patch.yml` 追加/覆盖）：

```yaml
- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
  config:
    mode: workspace-write
    workspaceRoot: 'C:\DSH\her'   # 用户批准的具体目录；先 icacls 授 (OI)(CI)F
- id: permission
  name: '@deepseek-ai/dsh-permission-presets'
  config:
    presets:
      read-only: { sandbox: read-only, approval: ask }
      workspace-write: { sandbox: workspace-write, approval: ask }
      danger-full-access: { sandbox: danger-full-access, approval: never }
    defaultPreset: workspace-write
```

前置/风险（来自 sandbox 试点）：
- Windows ACL：`icacls <workspace> /grant '<user>:(OI)(CI)F'`，否则 SetNamedSecurityInfoW Win32 5。
- `approval: ask` 需要应答者：桌面在场用 Web UI；不在场需要 **QQ 私聊应答器（QQ P1）**，否则升权 fail-closed（`unavailable`）。
- 只限制"写"，**不限制读/网络/进程可见性**；若"不能读用户文件"是硬要求，需专用 Windows 用户/WSL（Phase 2）。
- 保留 `danger-full-access` preset 作为回滚路径，不要删。

## 4. 桌面重启审批清单（只列清单，不执行）

> desktop 归用户所有；本任务不重启、不装插件、不建会话。以下由用户/lead 在批准后执行。

| # | 步骤 | 执行者 | 前置批准 | 验证 |
|---|---|---|---|---|
| 1 | 合并待发布 commit 到 master（`287e785` 重复动作保护、`9bc48ac` P1 上下文/白名单、本草案文档） | lead | 用户批准发布范围 | `git log` + 全绿测试（除已知 hang 的 `mc-link.test`） |
| 2 | 应用产品 preset patch（A1 + 选定的 A2/A3/A4） | lead | 用户逐项批准 | `git diff` 只含 `presets/icl.patch.yml` + 测试/文档 |
| 3 | 应用 desktop profile patch（B） | 用户/lead | 用户批准 sandbox + workspace 目录 | profile diff；`danger-full-access` 仍在 |
| 4 | 重启 desktop（用户手动） | 用户 | 用户批准时间窗口 | 新进程启动无报错 |
| 5 | 新建一个 ICL 会话（不要复用旧会话） | 用户 | — | 见下方验收 |
| 6 | cache 复核新基线 | cache | — | system/tools/facts 数字与 hash 记录；`CACHE-NIGHT §9.3` |
| 7 | 观察 24h（工具面/审批/首屏） | lead | — | 无回归；旧会话不受影响 |
| 8 | 回滚演练（可选但建议） | 用户/lead | — | 删 profile patch → 重启 → 确认恢复原状 |

**重启后验收（新会话）**：
- [ ] 首行 `你是小千。`；静态 system ≈ 2.3k 字符（产品实测为准），4 段工程脚手架消失。
- [ ] tools 数/字符/hash 与 cache 记录一致（若做 A2/A3/A4，记新指纹；历史不回改）。
- [ ] facts 快照 ≤1 条/轮、`icl:facts` 在、`systemHasDynamicFacts=false`、system 1 append/0 replace。
- [ ] album/video 工具可见（若批准）；album 的 `private` 标记默认不展示、无 `album_send`。
- [ ] sandbox：`permission/preset=workspace-write`；写 `C:\DSH\her` 成功、写外部拒绝；`danger-full-access` 可回滚。
- [ ] 审批：桌面在场能弹卡；不在场路径（QQ P1）未就绪前不要依赖。
- [ ] 旧会话/旧 state 的 mtime/哈希未变（workspace 与 ICL state 分离）。

**回滚**：
1. 删产品 preset 的 `purifySections`/改回插件清单 → 重启；2. 删 desktop profile 的 sandbox/permission patch → 重启；3. `purifySections: []` 即可关首屏，不需要回滚代码。

## 5. 需要用户拍板的清单（按顺序）

1. **工具面预算**：产品接受 66 工具 / **44,316 字符**的固定前缀吗？若不接受，按 `PRODUCT-SURFACE.md` 推荐：A1 = 产品 `icl` 去掉 `mc-link`（→ **49/31,824**，MC 只走 `icl-mc`）；A2 = sandbox 同批下线 `editor`（→ **46/30,699**）。A1/A2 都落在 45–50 工具 / 28–32k 字符目标内，且不动 memory/time/album/video 等生活功能。
2. **首屏净化**：产品开 4 段 shadow？（推荐先开；仅风险是 deliverable 指引消失。）
3. **显式插件白名单**：产品写死 15 个（A2：去掉 mc-link/editor，其余同默认）？还是保留 17 个默认全集（无行为变化，66 工具）？
4. **album 产品启用**：批准隐私边界（私密默认不展示、无自动删、发送需审批）后，产品显式列 `album`（当前默认已生效，显式化不改行为）。
5. **video 产品启用**：本地视频工具（无 URL 下载）产品可用。
6. **sandbox**：`workspace-write` + `workspaceRoot` 具体目录 + 审批通道（QQ P1）是否就绪；只限制写、不限制读是否接受。
7. **重启窗口**：用户定时间；desktop 由用户重启。

## 6. 不在本草案内

- QQ P1（唤醒矩阵/mark_read/表情库）：lead 单独给 qq；本文件不设计。
- QQ 媒体发送/DSH attachment：album §2 已留接口，需通道+审批，另行批准。
- MC 长跑/`attack`/pause 死锁：P0 归 mc-body/mc-link（`COMPLEXITY-AUDIT §4`）。
- desktop 进程/插件安装/重启：本任务一律不碰；本文件只是清单。
