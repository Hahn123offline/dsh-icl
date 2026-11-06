# 产品工具面预算（PRODUCT SURFACE）· 2026-11-06

> 状态：**方案，未应用**。不改产品 preset、不改 desktop/profile、不重启。所有数字可复算（见 §6）。
> 读者：用户 / lead / cache。关联：`docs/PRODUCTIZATION-KICKOFF.md`、`docs/ALBUM.md §10`、`docs/PLUGINS.md`、`docs/VIDEO-EYES.md`、`docs/CACHE-NIGHT-2026-11-06.md §9.1/§9.2`。
> 一句话：产品 preset 现在按 `DEFAULT_PLUGINS` 装配 **68 个 ICL 工具 / 46,766 字符**（album 二阶段新增 2 个工具）；把 **mc-link（17 / 12,492）从产品 `icl` 移到已有的 `icl-mc` 场景 preset** 是 **51 / 34,274**（略超 50）；sandbox 后再下线 editor（3 / 1,125）是 **48 / 33,149**（字符略超 32k）；再顺手裁 `memory_export`(277) + `time_edit`(447) 到 **45 / 31,662**——正好落在 45–50 工具、28–32k 目标内，且不动生活核心（memory/time/album/video/bili/focus…）。

## 0. 结论先行

| 方案 | 工具数 | 字符 | 行为变化 | 需批准 | 回滚 |
|---|---|---|---|---|---|
| **A1**：产品 `icl` 去掉 `mc-link`（MC 只走 `icl-mc`） | **51** | **34,326**（cache 数组 JSON 口径）/ **34,274**（Σ 每工具 JSON，product-surface 口径；差 52=数组分隔符） | desktop ICL 不再有 `mcb_*`；玩 MC 用 `icl-mc` preset | 用户（MC 入口变化） | 加回 `- mc-link` 一行 → 68/46,766 |
| **A2（sandbox 产品化同批）**：A1 + 下线 `editor`（换 DSH 原生 fs 工具） | **48** | **33,149**（Σ 口径；cache 数组口径 33,198，差 52） | 产品 ICL 无 `read_file/write_file/list_dir`，改用原生 `read/write/edit/glob/grep/pwsh` | 用户（与 sandbox 同批） | 加回 `- editor` → 51/34,274 |
| **A2+O（推荐达标）**：A2 + 下线 `memory_export`(277) + `time_edit`(447) + `time_mute`(763) | **45** | **31,662**（Σ；数组口径 31,709，达标） | 少一个手动导出、少一个日程编辑工具、少一个静音工具（其余日程工具保留） | 用户（P2 裁剪） | 加回三行 → 48/33,149 |
| B（可选更低）**A2+O + bili 移场景** | 38 | 26,884 | 刷 B 站要进 `icl-bili` 场景 | 用户 | 加回 `- bili` |
| C（保守）**只加显式白名单，不删** | 68 | 46,766 | 无（只是锁面） | 用户（确认预算） | 删白名单行 |

> 目标 45–50 / 28–32k：**A1 略超工具上限**（51）、**A2 字符略超**（48/33,149）、**A2+O 精确达标**（45/31,662）。cache 2026-11-07 sanctioned 离线 A1 = **51/34,326（数组 JSON 口径）** / 本地 Σ 口径 **34,274**（差 52=数组分隔符；不影响 A2+O 达标结论）。代价只有"MC 不再出现在生活会话"（MC 本来就有独立 `icl-mc`）+ 两个低频工具下线，不动生活核心。

## 1. 当前产品面（实测）

复算方式见 §6。产品 `icl` 未显式写 `plugins` → 继承 `DEFAULT_PLUGINS`（17 个插件），ICL 工具共 **68** 个 / **46,766 字符**（JSON schema+description；不含 DSH 原生工具；album 二阶段 +2 工具）。

| 分组 | 工具数 | 字符 | 工具 | 建议层级 |
|---|---|---|---|---|
| **mc-link** | **17** | **12,492** | `mcb_servers/lan/join/leave/stop/shelter/combat/attack/status/look/inventory/scan/map/snapshot/eyes/do/help` | **P1 场景**（只进 `icl-mc`/`icl-mc-lab`） |
| video | 6 | 6,006 | `video_probe/open/storyboard/zoom/locate/frames` | P0 生活（"眼睛"；产品化待批准） |
| bili | 7 | 4,778 | `bili_search/watch/comments/feed/frames/login_start/login_poll` | P0/P1（默认保留；预算紧再移场景） |
| album | **9** | **6,619** | `album_import/list/search/collage/show/prune/status` + `album_reindex`/`album_caption`（二阶段） | P0 生活（产品化待批准） |
| recall | 3 | 4,315 | `remember/recall/forget` | **P0 必留** |
| time | 9 | 3,842 | `time_status/arrange/list/edit/cancel/pause/resume/mute/unmute` | P0 必留（P2 可裁 5 个低频） |
| note | 6 | 2,237 | `memory_export/memo/memos/memo_append/memo_commit/note_status` | P0 必留（`memory_export` P2 可裁） |
| focus | 4 | 1,973 | `focus_status/enter/leave/backlog` | P0 必留 |
| lexicon | 2 | 1,526 | `lexicon/lexicon_learn` | P0 必留 |
| whois | 1 | 848 | `whois` | P0 必留 |
| world-state | 1 | 780 | `world_status` | P0 必留 |
| editor | 3 | 1,125 | `read_file/write_file/list_dir` | **P2**（sandbox 后换原生 fs） |
| 合计 | **68** | **46,766** | | |

## 2. 分级建议（逐项：行为变化 / 需批准 / 回滚）

### P0 必留（生活核心，不删）

| 插件 | 工具 | 理由 | 行为变化 | 需批准 | 回滚 |
|---|---|---|---|---|---|
| memory（note 里的 `memory_export`） | 1 | 记忆导出/备份 | 无 | 无需（保留） | — |
| recall | 3 | 记得/想起/忘掉 是她的人格核心 | 无 | 无需 | — |
| note | 6 | 便签/待办/待办计数 | 无 | 无需 | — |
| lexicon | 2 | 她自己的词典/学新词 | 无 | 无需 | — |
| whois | 1 | 认人 | 无 | 无需 | — |
| world-state | 1 | 世界状态（时间/睡眠/会话） | 无 | 无需 | — |
| focus | 4 | 专注/分心/积压 | 无 | 无需 | — |
| time | 9 | 作息/安排/静音/睡觉（生活节奏） | 无 | 无需 | — |
| album | 7 | 相册（隐私/保留策略已单独拍板；产品启用待批准） | 若产品启用=**新增能力**（现默认已生效，显式化不改行为） | 用户（产品启用确认） | 从 `plugins` 删 `album` |
| video | 6 | 本地视频"眼睛"（产品启用待批准） | 同上 | 用户 | 删 `video` |
| bili | 7 | 刷 B 站（只读；登录须用户操作） | 同上 | 用户 | 删 `bili`（或移 `icl-bili`） |

### P1 按场景挂载（不进生活默认面）

| 插件 | 工具 | 去向 | 行为变化 | 需批准 | 回滚 |
|---|---|---|---|---|---|
| mc-link | 17 | `icl-mc`（产品已有）/`icl-mc-lab`；生活 `icl` 不挂 | **是**：desktop ICL 生活会话看不到 `mcb_*`；MC 要选 `icl-mc` | 用户（入口变化） | `icl` 白名单加回 `- mc-link` |
| bili | 7（可选 B 方案） | 新 `icl-bili` 场景（或按需 allowlist） | 是：生活会话看不到 `bili_*` | 用户 | 加回 `- bili` |

> `icl-mc` 已有显式插件列表（`memory/world-state/recall/note/lexicon/whois/persona/focus/eager-recall/model-manager/time/dream/mc-link`），但不是 allowlist：它还有 editor 等非 MC 工具；若 MC 产品化，建议同时用 bridge `toolAllowlist`（已在 lab 验证）收敛到 `mcb_* + time_status/time_arrange + remember/recall/forget + memo*`。

### P2 可下线 / 可裁（省得不多，优先级低）

| 项 | 工具 | 字符 | 说明 | 行为变化 | 需批准 | 回滚 |
|---|---|---|---|---|---|---|
| editor | 3 | 1,125 | 与 DSH 原生 `read/write/edit/glob/grep/pwsh` 重复；sandbox 产品化后换原生 | 是 | 用户（与 sandbox 同批） | 加回 `- editor` |
| `memory_export` | 1 | ~300 | 手动导出，低频；需要时用 CLI/工具入口 | 是（少一个工具） | 用户 | 加回插件行 |
| time 低频 5 个（`edit/pause/resume/mute/unmute`） | 5 | ~1.6k | 生活里少用；先保留观察，别为省字符砍掉主动静音能力 | 是 | 用户 | 加回 |
| note 的 `memo/memos/memo_append/memo_commit` 四件套 | 4 | ~1.2k | 可合并成 1–2 个工具（代码改动，非 preset） | 是 | 用户 + 开发 | 保留旧工具 |

> 不建议为了"到 28k"砍 P0 生活工具；A1/A2 已达标。`album`/`video` 保留是产品定位（生活感）的一部分。

## 3. 建议的显式白名单（产品 `icl`，A2 版）

`presets/icl.patch.yml` 的 `preset-icl` → `icl-core.config`：

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
  - bili
  - video
  - album
```

- 相比"默认 17 个"：去掉 `mc-link`、`editor`；其余不变。预期 **48 工具 / 33,149 字符**（A2）；若再裁 `memory_export`+`time_edit`+`time_mute` 是 **45 / 31,662**（A2+O，推荐达标）；只去 `mc-link` 是 **51 / 34,274**（A1）。
- 产品 `icl-mc`：保留 `mc-link`（17 `mcb_*`），建议删 `editor`（若原生 fs 已上）并加 `toolAllowlist` 收敛；`icl-loop` 是内部夹具，不动。
- 显式白名单的额外好处：`DEFAULT_PLUGINS` 将来新增插件不会被动进入产品；每个新工具都要一次批准。

## 4. 执行顺序（不依赖 desktop 重启的部分）

1. 用户先拍板 **A1/A2** 与 album/video 产品启用（见 `PRODUCTIZATION-KICKOFF §5`）。
2. lead 改 `presets/icl.patch.yml`（+ `preset-icl-mc` 的 editor/allowlist），同步 `preset-plugins.test` 断言（当前测试要求"产品未挂载项是待批准白名单"，要改成"产品显式列表 ⊆ 已批准清单"）。
3. cache 在下次 sanctioned run 记产品预设的新 `tools.count/toolsChars/toolsHash`（cache 已离线记 A1=51/34,326；A2≈48/33,149、A2+O≈45/31,662 本地口径。产品 DSH 层 live 未跑（lab.mjs 白名单不含产品 preset），header 工具数会更高，按 cache 口径）。
4. 与 `PRODUCTIZATION-KICKOFF` 的桌面重启清单合并执行（首屏/purify + 显式白名单 + sandbox profile 同批，减少重启次数）。

## 5. 测试建议（先写不应用）

> 这些测试等 preset 改动落地时再启用；现在只写进文档，避免红测试。

```js
// preset-plugins.test.mjs（未来）
test('产品 icl：显式插件列表 = 已批准生活面（无 mc-link/editor）', () => {
  const prod = read('packages/dsh-icl/presets/icl.patch.yml')
  assert.match(prod, /id: icl-core/)
  assert.doesNotMatch(prod, /^\s*- mc-link$/m, 'MC 只走 icl-mc')
  assert.doesNotMatch(prod, /^\s*- editor$/m, 'editor 由原生 fs 替代（A2）')
})

// 工具面预算（host 级，不起 lab）
test('产品 icl 工具面在预算内（A2+O: 45 tools / 31,662 chars）', async () => {
  const host = createHost({ log: () => {} })
  await bootstrapHost(host, normalizeConfig({ stateDir: mkdtemp(), providers: [], presetId: 'icl' }), { log: () => {} })
  const defs = host.services.tools.list()
  const chars = defs.reduce((n, t) => n + JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }).length, 0)
  assert.equal(defs.length, 45)
  assert.ok(chars >= 28_000 && chars <= 32_000)
})

// 首屏净化（未来产品 patch 后）
test('产品 preset 声明了 4 段 purifySections，且只 shadow 工程脚手架', () => {
  const prod = read('packages/dsh-icl/presets/icl.patch.yml')
  for (const section of ['harness:identity', 'ui:deliverable-file-references', 'harness:source', 'app:web-surface']) {
    assert.match(prod, new RegExp(`- '${section}'`))
  }
})
```

## 6. 复算方式（只读，不起 lab）

```powershell
cd C:\DSH\icl-wt\misc
node -e "
import('./packages/core/src/index.mjs').then(async ({createHost}) => {
  const {bootstrapHost} = await import('./packages/dsh-icl/src/bootstrap.mjs')
  const {normalizeConfig} = await import('./packages/dsh-icl/src/config.mjs')
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path')
  const host = createHost({log:()=>{}})
  await bootstrapHost(host, normalizeConfig({stateDir: fs.mkdtempSync(path.join(os.tmpdir(),'surface-')), providers:[], presetId:'icl'}), {log:()=>{}})
  const defs = host.services.tools.list()
  console.log('tools', defs.length, 'chars', defs.reduce((n,t)=>n+JSON.stringify({name:t.name,description:t.description,parameters:t.parameters}).length,0))
})
"
```

当前输出：`tools 68 chars 46766`（ICL 面；DSH 原生工具另计；album 二阶段 +2）。cache 2026-11-07 离线 A1（去 mc-link）= 51/34,326（数组 JSON 口径）/ 本地 Σ = 34,274（差 52=数组分隔符）；icl-lab sanctioned = 56/41,577/`1ac40db7d8d0`、icl-mc-lab = 27/21,459/`c91bce1e703b`（两轮不变）。历史 lab 指纹：icl-lab 54/39,350/`c1df0e849a9f`、icl-mc-lab 27/21,459/`c91bce1e703b`（cache `6d2c518` sanctioned）。

## 7. 不做什么

- 不改产品 preset / desktop profile / 不重启（本文件只是方案）。
- 不为了字符数砍生活核心（memory/time/album/video/focus…）；目标靠"MC 场景化 + editor 下线"达成。
- 不把 `mcb_*` 默认塞回生活会话；MC 是独立场景。
- 不重复做 `includeRuntimeContext:false`（cache 已证 DSH 0.2 会把 `icl:facts` 一起清掉；hold）。
