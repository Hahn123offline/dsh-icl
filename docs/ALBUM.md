# 相册 / 本地多媒体管理（ALBUM）· 设计与接口 · 2026-11-06

> 用户需求（原话要点）：把获取的图片/视频**保存到本地**；支持**多图拼接查看（类似 storyboard）**；
> 图片**向量化回忆/召回与搜索**；保存为本地文件**能直接发送**；视频同理；尽可能让"她"在本地有强大的多媒体管理能力。
> 不在范围：动画表情生成；但 QQ 表情/图片会作为 album 的 `sticker` 标签统一管理，不再维护独立空表情库。
> 本文是**设计先行**的落点：先最小可用（入库/列表/拼图/按描述搜索），再迭代向量化与发送。

## 0. 一句话

图片/视频进"她自己的相册"：按内容哈希去重、按 `库/年-月` 落盘、sqlite 记元数据（来源/时间/尺寸/哈希/标签/原始消息 id/是否已发）、
能按时间/来源/标签列出来、能 N 张拼一张宫格、能按描述文字搜到；**图片一律走附件/文件路径，不进静态 system/facts**。
向量化（CLIP/视觉模型）放在第二阶段，接口先留好。

## 1. 存储布局与元数据

```
<ICL_ROOT>/album/                       # 媒体根（configFor('album').root；默认 <仓库根>/.state/album）
├── media.db                            # 元数据（node:sqlite，单写者）
├── default/                            # library
│   └── 2026-11/                        # 年月分桶
│       ├── 3f9a…c1.png
│       └── 7b2d…44.mp4
├── collages/                           # 拼图输出（可再入库/可剪）
│   └── grid-2026-11-06T02-11-09.png
└── tmp/                                # 导入中间文件（失败清理）
```

> 旧布局 `<旧 stateDir>/media/` 在 `<ICL_ROOT>/album` 还不存在时仍可读（向后兼容），
> 用 `tools/icl-move.mjs` 搬到新根；见 `docs/PATHS.md`。

**items 表**（`media.db`）：

| 列 | 说明 |
|---|---|
| `id` | 自增，模型可见的稳定短 id |
| `sha256` | **内容哈希，唯一**（去重主键） |
| `library` | 库名（默认 `default`，`[a-zA-Z0-9_-]{1,40}`） |
| `kind` | `image` / `video` |
| `path` | 相对 media 根的路径（不存绝对路径，迁移友好） |
| `ext` / `bytes` | 扩展名、字节数 |
| `width` / `height` / `duration_ms` | 图片尺寸；视频时长（无 ffprobe 时为 null） |
| `source` | `bili` / `qq` / `manual` / `vision` / … |
| `origin` | JSON：`{conv, messageId, sender, url}` 等原始定位（**只存 id/链接，不存隐私正文**） |
| `caption` | 文字描述（最小可用=用户/文件名；二阶段=视觉模型产出） |
| `tags` | JSON 数组 |
| `pinned` | 置顶，保留策略不删 |
| `private` | 0=普通相册，1=隐私相册（物理在 `private/<library>/…`；默认列表/搜索/拼图不可见，发送/展示需显式允许） |
| `sent_at` | 最近一次"被发出去"的时间（null=没发过） |
| `created_at` / `imported_at` | 源时间（若有）/ 入库时间 |
| `deleted_at` | 软删标记（行保留，文件已删；便于"我删过它"可追溯） |

**item_vectors 表**（二阶段，2026-11-06）：`item_id, model, dim, vec BLOB(Float32), source, updated_at`——CLIP 图片向量；与 items 同库、只本地，不进 system/facts（详见 §4）。

**去重**：`sha256` 唯一。重复导入返回**已有 id** + `deduped:true`，不重复占盘；允许顺带补 caption/tags/origin；若该图缺向量且嵌入服务可用，顺带补建。
**写入纪律**：先写 `tmp/`，校验哈希/尺寸后再原子 rename 到 `库/年-月/`；中途失败清 tmp，不留半文件。

**保留策略（用户 2026-11-06 拍板）**：
- **不自动删除**：`retentionDays = 0`（关闭自动过期）；导入不再自动清理；遗留的旧项都保留。
- 单文件 `maxFileBytes = 512 MiB`（用户日常 QQ 传输没见过 >200MB，512MiB 留余量）
- 总量只做**软告警**：默认 `warnBytes = 10 GiB`，超过只在 `album_status` 提示（不自动删）
- `album_prune` 仍是**手动**工具（默认 dryRun 预览；确认后才删）；隐私项默认跳过（`allowPrivate:true` 才可能清到）
- 删除均为"软删 + 删文件"：DB 行留 `deleted_at`，`status` 能报"已清理 N 件"。

**归档策略（2026-11-09 更新）**：QQ 私聊 owner 的图片/表情可自动进 album（`autoAlbum:true`，`source:'qq'`，caption 取原消息文字，表情加 `sticker` 标签）；群图默认不自动收，需 `autoAlbumGroups:true`。仍可显式 `album_import`，也仍不自动外传。
（与 qq 侧对齐：入站下载/缓冲区管理与相册解耦。）

## 2. 工具（10 个：最小可用 + reindex/caption/note）

| 工具 | 作用 | 关键返回 |
|---|---|---|
| `album_import` | 从本地路径导入 1–32 个图片/视频（可带 library/source/caption/tags/private） | 每件 `#id path deduped:true/false`；失败逐条给原因；**不自动清理** |
| `album_list` | 按库/类型/标签/来源/时间窗列（默认 20 条，倒序）；默认不含隐私项 | 一行一件：`#id 时间 类型 尺寸 大小 标签 描述 — 路径（隐私相册）`；空库说"还没导入"；隐私需 `includePrivate:true + allowPrivate:true`（与 search/show 同口径） |
| `album_search` | 语义检索：`query` 文本（CLIP 中文图文空间）/ `image` 本地图片（图-图）+ tags/时间/隐私过滤；嵌入不可用时降级为描述/标签/文件名 | topK + 相似度 + 路径；**没有就说没有**，不凑数；隐私需 `includePrivate:true + allowPrivate:true` |
| `album_collage` | 选 N 张图（id 列表或筛选条件）拼宫格 PNG（复用 storyboard 思路：cols × rows、cell 尺寸、留白）；默认不含隐私项 | `imagePath` + 文本清单（第 i 格=#id）；python/Pillow 缺失时给可操作错误 |
| `album_show` | 单件详情（路径、尺寸、标签、来源、发送记录）；隐私项需 `includePrivate:true + allowPrivate:true` | 一行详情 + `imagePath`；隐私项未授权时只给拒绝理由、不给路径 |
| `album_note` | 手动改 caption/标签/source/pinned（只改 metadata，不碰文件） | 更新后的一行详情；隐私项需双确认 |
| `album_prune` | **手动**清理（默认 dryRun=true；不自动跑）；隐私项默认跳过 | 计划/实际删除清单、释放字节数；`allowPrivate:true` 才可能清隐私 |
| `album_status` | 相册体检：件数/总字节/库/来源/告警阈值/最近导入/向量覆盖 | 一段可读摘要；超 `warnBytes` 只提示"不会自动删"；报"向量：n/m 张图片（512d）" |
| `album_reindex` | 批量为图片建/刷新 CLIP 512d 向量（CPU）；嵌入缺失/延迟导入后用 | 已建/失败数 + 覆盖率；默认跳过隐私，`allowPrivate:true` 才碰 |
| `album_caption` | **手动**让本地 vision 模型给图片写一句中文描述（不自动跑，避免抢 GPU） | 每件"描述：…"；默认只补无 caption 的图，`force:true` 重写 |

**状态行不写进 system/facts**：相册信息只在工具返回里；如果以后要在醒来简报里提"相册新增 N 张"，走 runtime-context facts（与 cache 的 `icl:facts` 同一机制，≤1 条/轮），**绝不进静态段**。

## 3. 拼接（storyboard 思路）

- 选择：`ids` 显式列表，或 `{library?, kind:'image'|'video'?, tag?, source?, since?, until?, limit?}` 过滤后按时间倒序取最前 `collageMax`（默认 16，上限 24）。
- 布局：`planGrid(count, cols)` 纯函数（cols 默认 4，clamp 1–8；cell 默认 320px，clamp 128–1024）；rows=ceil(count/cols)；留白 8px。
- 渲染：**python + Pillow**（与本机 bili 的 venv 同源；`ALBUM_PYTHON` 或 config `python` 指定）。每张图等比缩放进 cell（contain + 居中黑底），右下角小字标 `#id`（可选 `label:false` 关）。
- 输出：`<root>/collages/grid-<ISO>.png`，返回 `{imagePath}`（沿用 bili `bili_frames` 的约定；**图片真正进模型要等 DSH attachment 通道**，现在返回路径 + 明确说明"没有直接发给你"）。
- 失败姿态：没有 Pillow/没有可用图片/图片损坏 → 明确原因 + 下一步（装 Pillow / 换 ALBUM_PYTHON / 先导入）；不产出半张图（先写 tmp 再 rename）。

## 4. 图片记忆 / 语义检索（二阶段，最小可用已落地）

> 2026-11-06 实现（album v0.2）。CLIP 512d 在 8088 上 **CPU** 跑（0 VRAM）；图片向量与模型名**不进 system/facts**。

**存储**：`media.db` 新增 `item_vectors(item_id, model, dim, vec BLOB, source, updated_at)`；向量只在本地相册库。

**配置**（`configFor('album')`，均可选）：
- `embedEnabled`（默认 true）：关掉就不建向量；
- `embedDefer`（默认 false）：入库不建，之后 `album_reindex` 批处理（适合一次导很多图）；
- `embedSlot`（默认 `image-embed`，host 声明 512d embedding 插槽）；`embedDim`（默认 512，**维度断言**）；
- `embedBatchMax`（默认 8）；`caption`（vision 服务 config：baseUrl/model）；`captionPrompt`；`captionMax`（默认 3）。

**provider**：`config/icl.example.json` 已加 `clip-zh` / `clip-en`（dim 512，8088 `/embeddings`）；lab preset 三个会话也配了 `lab-clip-zh`（CPU）。`image-embed` 槽带 `meta.optional:true`——没配 CLIP 时只进 `icl.ready.slots.optionalUnmatched`，**不把必需槽健康行标红**（长跑 `slots.unmatched==[]` 仍成立，语义是"向量检索未配置"）。model-manager 自动接到 album 的 `image-embed` 插槽；文本 query 用同一插槽；图片按 data URL 走 OpenAI 兼容 `/embeddings`（若你的裁剪服务接口不同，改 provider 适配层，不改 album）。

**album_import**：图片入库后若插槽可用 → 立刻嵌入；失败只提示"向量未建：<原因>"，**不阻断入库**；去重命中也会补缺失向量；无 provider 时静默跳过（不污染导入输出）。
**album_search**：`query` 文本 / `image` 本地路径（图-图）+ `tags`/kind/source/时间窗；返回 topK + 相似度 + 路径；隐私默认不返回（需 `includePrivate+allowPrivate`，与列表同口径）；嵌入不可用/无向量时**降级**为 caption/tags/文件名并说明原因；空查询不凑数。
**album_reindex**：批量为图片建/刷向量；默认跳过隐私，`allowPrivate:true` 才可能碰；返回覆盖 `n/m` 与失败明细。
**album_caption**（手动，不自动）：`album_caption {ids?, limit?, force?}` 调 vision 服务生成一句中文描述写入 `caption`；默认只补无 caption 的图，避免自动批处理抢本地 GPU。
**album_status**：报"向量：n/m 张图片（512d×…）"与插槽状态；超 `warnBytes` 仍只软告警。

**验收**：原目标"已知 20 张图、5 查询 top-3 ≥4/5"；本实现用 fake embedding provider 的单元测试覆盖语义命中/图-图/隐私/降级/维度断言，真实 8088 用 `ALBUM_CLIP_SMOKE=1` 的可选集成测试（默认不联网、不占 GPU）。

## 5. 发送（本地文件 → 通道）

- **本地文件是事实源**：`album.list`/`album_show` 给绝对路径；QQ 出站走 `qq_send_media {albumId}`（G4），成功后回写 `sent_at`。
- **QQ 媒体通道（已交付）**：图片/视频/文件/语音走 `qq_send_media`，沿用 QQ 的审批/限额/审计；表情是 album 的 `sticker` 标签，`qq_send_sticker` 保留为别名。`album_send`/`exportFile` 不再需要。
- **DSH 附件**：拼图/单图的 `imagePath` 已按 bili 的既有约定返回；接 DSH attachment 后即可"直接看到图"（届时 qq 图片通道与 DSH attachment 共用同一 attachment 上传器）。
- 隐私与权限：任何"发出去"必须走用户/owner 批准 + 可见审计（谁、何时、哪件、多大）；当前 `exportFile`/`album_send` 均未交付。

## 6. 与其它模块的接口

| 模块 | 接口 | 方向 |
|---|---|---|
| `bili` | `album.importFile({path: bili_frames.imagePath, source:'bili', origin:{url, videoId}, caption:title})` | bili → album（入库） |
| `qq` | 入站图片/表情自动 `autoAlbum`（默认 owner 私聊；群需开关）或显式 `album.importFile`；出站 `qq_send_media {albumId}` + `markSent` | qq ↔ album |
| `dream` | 可选 `media` job：补 caption / 生成年度精选拼图（默认关） | dream → album |
| `recall` | 二阶段 `kind:'image'` → `album.searchByVector`；一阶段先 `album_search`（文本） | recall ↔ album |
| `editor` | 不直接对接：媒体根在 `<ICL_ROOT>/album`，editor 的 `root` 是 `stateDir` → 两个目录分开；写保护不覆盖媒体根 | — |

## 7. 隐私 / 安全

- **隐私分区（用户 2026-11-06 拍板）**：`private` 标记 + 物理目录 `private/<library>/<yyyy-mm>/`；
  默认列表/搜索/拼图**完全不展示**隐私项；`album_list/search/show/collage` 统一要求 `includePrivate:true + allowPrivate:true` 双确认才给文件路径；
  工具描述与 sim 都写了"隐私相册里的东西不能随便发/展示，要发先有明确允许"。
- 媒体根之外不写；导入只读显式给出的路径（不扫描全盘、不自动抓取）。
- `origin` 只存"定位信息"（会话 id、消息 id、发送者 id、URL），不存消息正文/凭据。
- 软删 + 物理删除；`pin` 的东西不会被自动清理；**没有任何自动清理**（除非显式 `album_prune {dryRun:false}`）。
- 发送必须有审批；日志记录 `album.send`（谁/哪件/多大/结果）。
- 不进静态 system/facts（cache 红线）；图片只走 attachment/文件路径。

## 8. 验收（最小可用）

| # | 场景 | 判据 |
|---|---|---|
| A1 | 导入 2 张同图（不同文件名） | 第 2 次 `deduped:true`，盘上只 1 份，id 相同 |
| A2 | `album_list` 按时间/标签/来源过滤 | 只返回命中，倒序，条数对 |
| A3 | `album_search('白鹭')` 命中 caption/tags；无匹配 | 命中给 id/路径；无匹配说"相册 N 件…没有"，不凑数 |
| A4 | `album_collage(ids:[…3])` | 生成 PNG，`planGrid(3,2)` = 2×2；尺寸 = cols×cell；返回 imagePath；Pillow 缺失时错误可操作 |
| A5 | 超过 `maxBytes` 导入 | 自动清理最旧未置顶，`status` 报"已清理 N 件/释放 X" |
| A6 | 软删/prune dryRun | 默认只报告不动手；`dryRun:false` 才删文件 + `deleted_at` |
| A7 | 静态布局 | 无新增 system section/facts；只新增工具（toolsHash 变化属预期，工具数 +7）；图片不进 system |
| A8 | `npm test` | 全绿；拼图渲染用 python/Pillow，缺失则 skip（不红） |

## 9. 分阶段

1. **P0（本轮）**：入库/去重/元数据/列/搜/拼图/状态/prune + 测试 + 本文件。
2. **P1**：QQ 媒体入站落盘（依赖 qq 侧下载）、DSH attachment 通道、发送（审批）。
3. **P2**：caption 视觉模型、图像向量检索、`recall kind:'image'`、dream media job。

## 10. 启用范围与缓存影响（2026-11-06 补）

| 范围 | 状态 | 说明 |
|---|---|---|
| `DEFAULT_PLUGINS`（`packages/dsh-icl/src/config.mjs`） | 已含 `album` | 新装的 ICL 默认会启用相册 |
| **lab preset**（`presets/lab.patch.yml` 的 `icl-lab` / `icl-mc-lab`） | **已显式挂载 `- album`** | lab 面随 video/bili/新插件变化，当前 cache 实测 `icl-lab` **54 工具 / 39,350 字符**（历史"34→41"是 album 刚落地时的口径）；`album` 状态目录 = `<ICL_ROOT>/album` |
| **产品 preset**（`presets/icl.patch.yml`） | **未显式列 `plugins`，按 `DEFAULT_PLUGINS` 装配** | 产品 `icl` 实际已含 `album_*`（本地装配 66 工具，其中 album 7）；"产品未启用 album"是旧文档（34/41 工具时代）。显式白名单与产品工具面预算待用户批准/拍板，见 `docs/PRODUCT-SURFACE.md` |

**为什么 lab 必须显式挂载、产品却是默认生效**：lab preset 的 `plugins:` 是白名单——即使插件在 `DEFAULT_PLUGINS` 里，没列进 lab preset 就不会加载（cache 历史 layout 审计：34 工具、`album_*` 全部不可见，模型只能改用 `list_dir`）。产品 `icl` preset 目前不写 `plugins`，所以继承 `DEFAULT_PLUGINS`（已含 album/video/bili/editor/mc-link），产品侧反而是"默认全量"；产品化要把这份隐式默认改成显式批准清单（见 `PRODUCT-SURFACE.md` §3）。
回归测试：`packages/core/test/preset-plugins.test.mjs`（lab 两个会话都必须挂 album；两 lab 列表并集覆盖 `DEFAULT_PLUGINS`；产品 preset 未挂载项必须是最小的、写进文档的待批准白名单）。

**cache 红线**：album 只新增工具 schema，不注册任何 `prompt.section`/facts 上下文 → 静态 system 与 `icl:facts` 布局零变化；
`toolsHash/toolsChars` 会变、工具数 34→41 属预期（历史 34 指纹不回改）。

**实测基线（cache，master `c7b590d`，run `cache-layout-album`，cloud 5 轮）**：
tools **41 / 23,286 字符 / hash `6a5eee138aab`**（旧 34 / 19,760 / `38dfbee1cd9b`）；7 个 `album_*` 全在，第 2 轮模型实际调用了 `album_list`；
system 1 append/0 replace、2296 字符/5764 字节（与上轮 2300 差 4 字符 = run 目录名长度，cwd 在 system 里，非布局漂移）；
`systemHasDynamicFacts=false`、facts 1 快照/5 轮、sections 含 `icl:facts`、`image/offload=0`。
指纹演进与复核记录见 `docs/CACHE-NIGHT-2026-11-06.md §9.1/§9.2`（历史不回改）。

## 11. 用户拍板记录（2026-11-06）

- **保留策略**：不自动删除；单文件默认 512 MiB；总量 >10 GiB 只软告警（`album_status` 提示），不做自动清理；清理只走手动 `album_prune`（默认 dryRun）。
- **归档策略**：QQ 私聊 owner 图片/表情可自动进 album；群图默认不自动收（需 `autoAlbumGroups`），避免默默收藏群友图片。
- **隐私分区**：`private` 标记 + `private/` 物理子目录；默认列表/搜索/拼图不展示；`album_list/search/show/collage` 统一需 `includePrivate:true + allowPrivate:true`；发送未交付；工具描述与 sim 写明"不能乱发"。
- **路径**：album root 跟随 `stateDir` 推导（当前 `<stateDir>/media`），整体迁移由 paths 子任务统一处理，插件内不硬编码。
- 回归：`packages/core/test/album.test.mjs` 增加 3 条（隐私门槛/不自动清理/手清跳过隐私）；`npm test` 全绿。
- **图片记忆（二阶段，2026-11-06）**：CLIP 512d CPU（0 VRAM）入库建向量；`album_search` 支持文字/图-图语义检索，隐私默认不返回；嵌入缺失降级标签并说明；`album_reindex` 批处理；`album_caption` 手动调本地 vision（不自动跑）。

