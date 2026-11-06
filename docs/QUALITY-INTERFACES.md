# 接口 / 媒体组质量审计（2026-11-07）

> 范围：`packages/plugins/{qq,album,bili,video,editor,note}` + docs（QQ / QQ-GAP / ALBUM / VIDEO-EYES /
> BILI-FEASIBILITY / MC-EYES 的媒体接口部分）+ 相关真实网络/本地样例证据。
> 只读审计：**没有改任何代码**；没有连 SnowLuma、没有真发 QQ、没有跑 lab、没有起 GUI/DSH 会话。
> 基线：`master` HEAD `649c8dd`（2026-11-07 02:25，qq focus queued fix）。本文件是本次审计唯一新增文件。

## 0. 方法与证据边界

**读了**：6 个插件的 manifest / src 全文或关键段、`packages/core/src/{services,contracts,dsh-contract}.mjs`、
`packages/dsh-icl/src/{bridge,bootstrap,config}.mjs`、`packages/dsh-icl/presets/{icl,lab}.patch.yml`、
6 份 docs、以及 `.state/` 下的真实产物与 DB（只读打开）。

**跑了**（都只读或只写 `%TEMP%`）：

| 动作 | 命令 / 方式 | 结果 |
|---|---|---|
| QQ 全部单测（14 文件） | `node --test packages/core/test/qq*.test.mjs` | **117 pass / 0 fail** |
| album 单测 | `node --test packages/core/test/album.test.mjs` | 22 tests：21 pass / **1 skip**（真 CLIP smoke） |
| note 单测 | `note.test.mjs` + `note-updates` + `pending-notes` | 11 pass |
| video 单测 | `node --test packages/plugins/video/test/` | 6 pass（含真 ffmpeg 8.1.2 样例） |
| bili 单测 | `node --test packages/plugins/bili/test/` | 15 pass |
| MC eyes 单测 | `node --test packages/mc-body/test/eyes.test.mjs` | 3 pass |
| bili 真实只读网络 | `node tools/bili-eval.mjs`（search/feed/watch/comments） | **14/14**（2026-11-07 02:40） |
| bili 真实切帧 | `node tools/bili-eval.mjs --frames BV1dC4y117Rz …` | **15/15**，sheet 365 693 B，1 653 ms；我**看过图**（1010x624，4 格编号 + 时间轴，画面清晰） |
| 工具面探针 | 临时 host + `surface.names()`（不碰网络） | 见 §2/§9：**qq 8/10 工具被过滤** |
| 真实 DB / 产物 | `node:sqlite` 只读开 `.state/album/media.db`、`state/state/memory.db`；列 `.state/` | 见各模块 |

**明确没做**：真机 QQ 窗口、SnowLuma、lab、DSH GUI、任何对外发送、任何仓库内写操作（除本文件）。

---

## 1. 总体判断

| 模块 | 兑现的功能（一句话） | 当事人/用户拿到什么 | 成熟度 | 一句话判据 |
|---|---|---|---|---|
| **qq** | 私聊只读影子 + 窄口径文本回复 + 入站媒体落盘 + 账本/补课 + 表情包 | 能收到/回复主人私聊、看图片、拿到视频/文件路径；**产品会话里还没上** | **alpha** | 真机只跑通过一次窄路径；8/10 工具模型看不见；媒体/账本/表情零真机产物 |
| **album** | 本地相册：去重入库/列表/搜/宫格/隐私/体检/手动清 | 图片视频有"自己的库"、能拼一张、能按描述找 | **alpha**（"图片记忆"仍是 prototype） | 工具面完整且单测好，但真实库 0 件、本机无 CLIP provider、无发送通道 |
| **bili** | 7 个工具：5 只读（search/watch/comments/feed/frames）+ 2 扫码登录 | 会自己刷 B 站、看简介字幕评论、看画面 | **beta** | 今天真网 15/15、真实凭证、真实截图产物；边界（无下载/无互动）测试化 |
| **video** | 本地视频 6 工具：探/开/分镜/近看/定位/抽帧 | 任意本地视频"能看见"，不出网 | **beta** | 真 ffmpeg + 真 CLI 端到端有表；但从未接过真实 QQ/MC 产物 |
| **editor** | read/write/list 三个文件工具 | 能记笔记、翻自己的东西 | **alpha** | 能用，但写保护名单落后于当前 stateDir 布局（可覆盖凭据/事件流） |
| **note** | 5 个备忘工具 + 世界状态一行 + dream 提问沉淀 | "还有 N 件事没了结"；不打扰、不进记忆 | **beta（机制）/ alpha（闭环）** | 单测 11 条；真实库 16 条全 open、0 结案 |
| **MC-EYES 媒体接口** | `mcb_snapshot` 语义快照 + `mcb_eyes` 截图附件 | MC 里"看得见"（便宜的 JSON 眼 + 7-8s 像素眼） | **alpha** | 离线 PoC 有真图；真服/真实会话未跑；album/video 只是"接口建议" |

**三条总体结论**

1. **能力面基本齐，真实使用面很窄。** 本次审计能核实到的真实产物只有：1 次真机 QQ 私聊/回复（11-05）、
   本次 1 次真 B 站切帧、16 条真实备忘（11-03..05）。album 真实库 **0 件**、video 工具调用 **0 次**（无 `work/`）、
   QQ 媒体 inbox **0 个**、MC 截图 **0 张**。
   也就是说多数"已完成"是单测级完成，不是被当事人用过的完成。
2. **最严重的不是缺功能，是"做完了但模型看不见"。** QQ 的 P1 账本工具与 `qq_help` 全部在
   `surface.list()` 被 manifest 过滤掉（§2.5-1）。这是文档里已写明的核心规则（`docs/DEVELOPING.md:35`、
   `docs/ARCHITECTURE.md:257`），没有不变量测试兜底，测试也绕开了 surface，所以 117 条全绿。
3. **跨模块的"媒体网"还没连起来。** album 提供了 `album` 服务，但 **bili / qq / video / mc-link / dream 没有任何一处调用**
   （全仓 grep 只有定义处）。QQ 落盘不自动进相册（用户拍板，合理），但也没有任何"手动一键入库"的链路被实现，
   album 因此是一座孤岛：入库只能靠模型记得调 `album_import`，而它还要先拿到路径。

**能力 → 可见性 → 真实使用** 矩阵（本次审计核心结论）

| 能力 | 代码有 | 模型面可见 | 真机/真实输入验证过 |
|---|---|---|---|
| QQ 私聊入站 | ✅ | ✅ `qq_status` | ✅ 2026-11-05 一次 |
| QQ 文本回复 | ✅ | ✅ `qq_send`（三钥匙） | ✅ 1 条气泡 |
| QQ 账本工具（unread/history/replied/mark_read） | ✅ | ❌ manifest 未声明 | ❌ |
| QQ 聊天策略 `qq_help` | ✅ | ❌ manifest 未声明 | ❌ |
| QQ 入站图片 → attachment | ✅ | （走消息通道） | ❌ 形状"待真机验" |
| QQ 表情包 3 工具 | ✅ | ❌ 且被发送钥匙耦合 | ❌ 库为空 |
| album 入库/列表/拼图/体检 | ✅ | ✅ 9/9 | ❌ 真实库 0 件 |
| album 语义检索 | ✅ | ✅ | ❌ 本机无 provider；真 CLIP smoke 默认 skip |
| bili 7 个工具（5 只读 + 2 扫码登录） | ✅ | ✅ 7/7 | ✅ 2026-11-07 真网 15/15（登录除外） |
| video 6 工具 | ✅ | ✅ 6/6 | ⚠️ 真 ffmpeg/真 CLI 样例，非真实 QQ/MC 文件 |
| MC 结构化快照 | ✅ | ✅ `mcb_snapshot` | ⚠️ 单测 + 离线 |
| MC 截图 | ✅ | ✅ `mcb_eyes` | ⚠️ 只离线 demo 世界 |
| album 发送 / 跨模块入库 | ❌ | — | — |

---

## 2. qq

### 2.1 交付的功能

| # | 功能 | 实现 | 兑现状态 |
|---|---|---|---|
| 1 | 私聊只读入站（OneBot 正向 WS → 规范化 → signals） | `src/{connector,gate,normalize}.mjs`、`src/index.mjs:1058-1173` | ✅ 可用，默认 `enabled:false` |
| 2 | 准入四件套：白名单/去重（24h）/限流/过期；**群整类忽略**；客户端零出站帧 | `gate.mjs`、`connector.mjs` | ✅ |
| 3 | 账本 + 水位（last/delivered/attended 三数）+ 断线补课 | `src/{ledger,backfill,onebot-http}.mjs`、`index.mjs:1068-1101` | ⚠️ 代码在，**默认内存模式**；真机 `get_friend_msg_history` 未验 |
| 4 | 入站富内容：引用解析、合并转发展开 | `src/{reply-cache,forward,rich}.mjs` | ⚠️ 单测覆盖，真机 `get_msg`/`get_forward_msg` 未验 |
| 5 | 入站媒体：图片 → `signal.images` → DSH attachment；视频/文件安全抓取落 `<inbox>/<date>/` + `index.jsonl`，正文附绝对路径 | `src/media.mjs`、`index.mjs:745-841`、`dsh-bridge` | ⚠️ 单测 + fake bridge；**真机产物 0** |
| 6 | 出站唯一入口 `qq_send`：1–8 气泡、markdown→纯文本、节奏（auto/fixed/typing/byLength）、限速、同文去重、审计（只存 hash/长度）、kill switch、引用回复 | `src/{send-tool,humanize,outbound}.mjs` | ✅ 真机 1 次（1 条）；fake 18 条 + 多气泡/切分/限速各 44 条族测试 |
| 7 | 表情包：本地库列表 / 发本地图片 / 知识库（tags/描述/来源/次数） | `src/{send-tool,sticker-store}.mjs` | ❌ 工具被 manifest 过滤；库为空 |
| 8 | 唤醒矩阵：replyCheck / proactive / nudge + "醒来第一眼"快照，只生成 signal | `src/{wake,wake-snapshot}.mjs` | ⚠️ 单测；proactive 默认关 |
| 9 | 账本工具：`qq_unread` / `qq_history` / `qq_replied` / `qq_mark_read` | `index.mjs:1374-1560` | ❌ **模型面不可见** |
| 10 | 聊天策略入口 `qq_help`（`skills/reply.md`） | `index.mjs:1326` | ❌ **模型面不可见** |

### 2.2 对当事人/用户的价值

- **她**：能收到主人的 QQ 私聊、判断该不该回、用接近真人的多气泡节奏回一句；能看见对方发来的图片（走 attachment），
  拿到视频/文件的本地路径后可以用 `video_*`/`read_image` 真的看；不会误发群、不会刷屏、不会在未知结果时重复发。
- **主人**：只有一个 owner/白名单私聊可被回复；每次发送有审计；有 kill switch；群能力**在代码里不存在**。
- **但当前实际价值 = 0**：`packages/dsh-icl/presets/icl.patch.yml:30-46` 的产品插件白名单里**没有 qq**，
  产品会话根本不会装这个插件。全部真机价值只在 `.state/lab/qq-*` 的一次性窗口里成立。
- 聊天本身的质量（人格、何时回、回多长）依赖 `skills/reply.md`，而它的唯一入口 `qq_help` 又是不可见的（§2.5-1）。

### 2.3 证据与测试

- **自动化**：`node --test packages/core/test/qq*.test.mjs` → **117 pass / 0 fail**（14 个文件：qq / qq-send /
  qq-ledger-tools / qq-stickers / qq-media / qq-rich / qq-wake / qq-watermark / qq-focus-queued / qq-backfill /
  qq-envelope / qq-humanize / qq-preflight / qq-mc-concurrent）。
- **真机只读影子**：`.state/lab/qq-shadow-20261105-2257/report.md` → 9/9；私聊以 `plugin:qq` 进会话，`framesSent=0`，
  SnowLuma 日志无 `send_private_msg/send_group_msg`（`docs/QQ.md:1166-1173`）。
- **真机出站**：`.state/lab/qq-send-20261105-2310/report.md` → 13/13；`qq_send` → `outcome=ok`、
  `messageId=294938146`、`269 ms`；服务端 `send_private_msg` 恰 1 次、`send_group_msg` 0 次；审计 1 行只有 hash/长度
  （`docs/QQ.md:1175-1185`）。我核对了 `qq-shadow/send-audit.jsonl`（158 B）与 `inbound.jsonl`（277 B）。
- **真实媒体/账本/表情产物：不存在**。`.state/inbox/qq` 缺、全仓无 `qq-ledger.db`、`.state/media/stickers` 缺
  → 这三块只有 fake 级证据（`docs/QQ.md:1037`、`:1074-1096` 自己也写"假上游/待真机"）。
- **我加的工具面探针**（临时 host，不联网）：注册 6 个，`surface` 只出 `qq_status`（§2.5-1）。

### 2.4 成熟度：**alpha**

判据（满足 alpha、不满足 beta）：① 主路径在真实 SnowLuma 上跑通过（入站 + 单条发送）→ 高于 prototype；
② 但"日常可用"不成立：产品 preset 未挂载、8/10 工具不可见、媒体/账本/表情无真机验证、语音只有占位；
③ 已知失败模式可见（三态回执、kill switch、审计、不自动重试）→ 工程纪律是 beta 级，但**产品面仍是实验态**。

### 2.5 已知缺口 / 不满意点

1. **【P0，本次最重要】manifest 只声明 2 个工具，8 个被 `surface` 静默过滤。**
   `packages/plugins/qq/manifest.json:4` = `["qq_status","qq_send"]`；实际注册 10 个（`index.mjs:1317,1326,1374,1414,
   1443,1471` + `send-tool.mjs:341,413,445,478`）。`packages/core/src/services.mjs:170-195` 只输出"manifest 声明过"的工具，
   `packages/dsh-icl/src/bridge.mjs:157` 只从 `surface.list()` 注册 → 模型永远看不到 `qq_help / qq_unread / qq_history /
   qq_replied / qq_mark_read / qq_stickers / qq_sticker_note / qq_send_sticker`。
   我实测：`registered=6, surface=qq_status`；带 `preset:['qq']` 也只有 `qq_status`；`owners()` 键只有 `qq_status,qq_send`。
   规则本身在 `docs/DEVELOPING.md:35`、`docs/ARCHITECTURE.md:90,257` 写明（"漏声明会静默隐形"），但**没有不变量测试**：
   这些工具的契约测试都从 `host.services.tools.list()` 直接取定义执行（`qq-ledger-tools.test.mjs:90`、
   `qq-send.test.mjs:67`、`qq-stickers.test.mjs:51`），绕开了产品真实入口 `surface`。
   → `docs/QQ.md:32-37` 的 "P1 账本工具 ✅ 已实现"、"P1 表情包 ✅ 已实现"、"F1/F3 qq_help ✅" 均**不可兑现**。
2. **不在产品装配里**：`packages/dsh-icl/presets/icl.patch.yml:30-46`（bili/video/album/editor 在，qq 不在），
   连 `DEFAULT_PLUGINS` 也没有 qq（`packages/dsh-icl/src/config.mjs:9-12`）；qq 只出现在 lab 影子自己生成的 `lab.patch.yml`。
3. **账本默认不落盘**：`index.mjs:1068-1073` 只有给了 `ledgerFile` 或任一 state 文件才开 SQLite；
   产品装配 `packages/dsh-icl/src/bootstrap.mjs:28` 只传 `mediaInboxDir/stickerDir` → 账本是内存模式（重启即失忆），
   `qq_status` 自己会显示"内存模式（重启不保留）"（`index.mjs:1241`）。
4. **表情工具与发送钥匙耦合**：`index.mjs:482-495` 三钥匙不齐就整体不注册 `send-tool`，于是"只读地列一下我的表情库"
   也需要打开出站审批。对一个只读能力来说，权限粒度错了。
5. **没有媒体出站**：图片/语音/文件都发不了（`docs/QQ.md:884`；`send-tool.mjs:350` 明确写"不存在"）。
   与 ALBUM 的"本地文件能直接发送"需求直接冲突（见 §3.5）。
6. **入站语音仍是占位**：`src/rich.mjs:175` `case 'record': parts.push('[语音]')`，没有下载也没有转写；
   旧项目有的 `fetch_ptt_text` 未移植（`docs/QQ-GAP.md` §1.2）。
7. **一次回复会把"到 lastSeq 为止"全部标已回**：`index.mjs:503-513` 用 `onSendStart` 的 `lastKnown.lastSeq` 作为
   `throughSeq`，回一句"嗯"会把此前 10 条（包括没交付/没读的）都标 replied；`qq_replied` 的口径因此偏乐观
   （`docs/QQ.md:901` 自认是"最小版"）。
8. **文档漂移（同一文件自相矛盾）**：`docs/QQ.md:889` "WS 不补课 / 私聊不可靠" ↔ `:392,1037` "补课已实现"；
   `:892` "媒体不落地" ↔ `:442` 媒体已落盘；`:901` "没有 replied 账本" ↔ `:511` 账本工具已实现。
   `docs/QQ-GAP.md:1-20` 的"像人一样回话不完整"也早于 P0-3 落地。

---

## 3. album

### 3.1 交付的功能

| # | 功能 | 实现 | 兑现状态 |
|---|---|---|---|
| 1 | `album_import`：1–32 个本地图片/视频，sha256 去重、`库/年-月` 落盘、sqlite 元数据、可带 caption/tags/source/private | `src/index.mjs:355-402,488-519` | ✅ 单测级 |
| 2 | `album_list`：库/类型/标签/来源/时间窗，隐私默认不可见 | `:404-415,521-548` | ✅ |
| 3 | `album_search`：CLIP 512d 文字/图-图语义检索，不可用时降级 caption/tags/文件名 | `:327-352,550-599` | ⚠️ 本机无 provider → 实际只有降级路径 |
| 4 | `album_collage`：N 张 → 宫格 PNG（python+Pillow，先 tmp 后 rename） | `:444-486,601-624` | ✅ 单测真 Pillow（缺失则 skip） |
| 5 | `album_show` / `album_prune` / `album_status` | `:626-688` | ✅ |
| 6 | `album_reindex` / `album_caption`（手动，不自动跑） | `:690-767` | ⚠️ 向量路径需 provider；caption 需 vision 服务 |
| 7 | 隐私分区：`private/` 物理子目录 + 默认不列/不搜/不拼 | `:312-325,381-393` | ✅（有一处口径不一致，见 3.5） |
| 8 | 进程内 `album` 服务（importFile/list/search/semanticSearch/reindex/vectors/prune/status） | `:770-784` | ⚠️ **无人调用** |

### 3.2 对当事人/用户的价值

- 用户原话需求（`docs/ALBUM.md:3-5`）：图片/视频存本地、多图拼接看、向量化回忆/搜索、本地文件能直接发送。
- **真正兑现**：本地留底（去重、不自动删、软告警）、一次看多张（拼图）、按描述/标签找、隐私相册分区、体检/手动清。
- **没兑现**："图片记忆"（语义回忆）在本机不可用；"能直接发送"完全没有通道（`album_send` 不存在，
  QQ 也发不了图/文件）；"回忆"只能靠模型主动 `album_list`/`album_search`，没有任何自动浮现。

### 3.3 证据与测试

- `node --test packages/core/test/album.test.mjs` → 22 tests / 21 pass / **1 skip**（`真实 8088 clip-zh 集成`
  需 `ALBUM_CLIP_SMOKE=1`，默认不跑；`album.test.mjs:399` 另有 optional 槽测试）。
  覆盖：去重/筛选/隐私门槛/拼图（真 Pillow）/不自动清理/手清跳过隐私/语义命中与图-图/降级/维度断言/caption。
- **真实库是空的**：`.state/album/media.db` → `items=0, item_vectors=0`；`collages/`、`tmp/` 均无产物
  （目录 2026-11-06 10:42 建，DB 0 行）→ **从未用真实内容跑过一次完整闭环**。
- **本机 provider 缺失**：`config/icl.local.json` 只有 deepseek / llama-swap-chat / bge-m3(1024d)，
  没有 `clip-zh`(512d)；而 `config/icl.example.json:22-35` 有、lab preset 有 `lab-clip-zh`（`lab.patch.yml:92`）。
  只读 GET `http://127.0.0.1:8088/v1/models` 确认 8088 上有 `clip-zh`（512d，unloaded，按需加载）
  → 不是模型缺，是**产品配置没接**，"图片记忆"在本机常态不工作。
- 桥接：`album_collage`/`album_show` 返回 `imagePath`，`packages/core/src/dsh-contract.mjs:98` 会转成 attachment
  → 这条通路是通的（与 `docs/ALBUM.md:88` 的"等 DSH attachment 通道"相反，文档过期）。

### 3.4 成熟度：**alpha**（文件管理 alpha；"图片记忆"prototype）

判据：① 9 工具面齐、单测覆盖主路径与失败姿态、隐私/保留策略有用户拍板 → 超过 prototype；
② **真实数据 0 件**、语义检索本机不可用、无发送/无跨模块入库 → 不满足 beta 的"真实输入跑通主路径"。

### 3.5 已知缺口 / 不满意点

1. **文档承诺了不存在的接口**：`docs/ALBUM.md:116` 写 `album` 服务暴露 `exportFile(id)`；实际 `index.mjs:770-784`
   没有 `exportFile`。`docs/ALBUM.md:124-127` 的 bili/qq/dream/recall 四行集成，全仓 grep **0 处调用**。
2. **"发送"没有任何落地**：`album_send` 不存在；QQ 出站无媒体（§2.5-5）；`sent_at` 字段永远为空。
   `docs/ALBUM.md:118` 写"等通道+审批就绪再加"——即**用户四大需求之一未交付**。
3. **隐私口径不一致**：`album_list {includePrivate:true}` 就会列出隐私项（`index.mjs:407`），
   而 `album_search`（`:314`）与 `album_show`（`:635`）要求 `includePrivate+allowPrivate` 双确认。
   少一道确认就能拿到隐私文件的路径。
4. **导入整文件读内存**：`index.mjs:378` `fs.readFileSync(file)` 读完整个文件再 `subarray(0, 64KiB)` 取头；
   单文件上限 512 MiB（`:165`）→ 导入一个大视频会把 512MB 读进堆。
5. **`queryRows` 的 `includeDeleted` 是空实现**：`:405` 两个分支都 `q.all.all()`，参数无效（软删行永远查不到）。
6. **文档与代码互相打脸**：`docs/ALBUM.md:149` A5 验收写"超过 maxBytes 导入 → 自动清理最旧未置顶"，
   与 `:57-62`（用户拍板不自动删）和代码（`retentionDays=0`）矛盾；`:185` 说"album root 当前 `<stateDir>/media`"，
   实际 `bootstrap.mjs:25` 优先 `cfg.albumDir` = `ICL_ROOT/album`（`.state/album`）；`:88` 说图进模型"要等 attachment 通道"。

---

## 4. bili

### 4.1 交付的功能

| # | 工具 | 实现 | 兑现状态 |
|---|---|---|---|
| 1 | `bili_search` 关键词搜索（清洗无 BV 卡片、order 白名单） | `src/index.mjs:195-222` | ✅ 真网 |
| 2 | `bili_watch` 简介/统计/字幕全文 | `:224-244`、`runtime.mjs:198-280` | ✅ 真网（字幕有则给全文） |
| 3 | `bili_comments` 热评 + 楼中楼 | `:246-266` | ✅ 真网 |
| 4 | `bili_feed` hot/rank/weekly/buzz | `:268-311` | ✅ 真网 |
| 5 | `bili_frames` 网络视频切帧（PNG 附件 + 可引用格清单） | `:313-355` | ✅ 真网（我看过图） |
| 6 | `bili_login_start` / `bili_login_poll`（扫码，凭证原子写 stateDir） | `:357-411`、`login.mjs` | ⚠️ 假 fetch 单测；真扫码未验 |
| 7 | 只读边界：Python 侧独立白名单 + 插件侧 7 工具 | `tools/bili-run.py`、`vendor/` | ✅ 单测断言"写函数进不来" |
| 8 | 运行面：限速串行 + 风控/超时指数退避、错误归一化、cookies 到期提示 | `runtime.mjs:186-340` | ✅ 单测（25 次真网长测见 `docs/BILI-FEASIBILITY.md` §11.3） |

### 4.2 对当事人/用户的价值

- **她**：能按关键词找视频、打开看简介和字幕、读评论看大家怎么反应、看热榜/热词、对没有字幕的视频"切一张 storyboard
  自己看"；全程只读，不能评论/私信/上传/收藏（这些工具不存在）。
- **主人**：凭证归 ICL 自己（`<stateDir>/bili/bili_credential.json`），扫码续期不经过第三方；
  风控时不会疯狂重试；画面来源（匿名 480P vs 登录高清）会在结果里明说。
- 局限：**不能把视频存下来**（`bili_frames` 只为扫描拉一份低清副本，不出文件）、不能把看过的片段存进相册，
  也不能"边看边记"到记忆（工具结果不进原文层）。

### 4.3 证据与测试

- 单测 15 pass，其中"真 runner 只读白名单""限速/退避""凭证迁移""扫码假 fetch"都是契约级。
- **真实网络（2026-11-07 02:40，本次审计亲跑）**：`node tools/bili-eval.mjs` → 14/14；
  `bili_search` 3254 ms、`bili_feed hot` 1614 ms、`bili_watch` 2715 ms、`bili_comments` 1855 ms，全部返回可读文本。
- **真实切帧**：`--frames BV1dC4y117Rz --from 0 --to 10 --cells 4` → 15/15，`sheet.png` 365 693 B，1653 ms；
  我打开图确认：1010x624，4 格带编号，画面清晰（不是 480P 糊图），底部有时间轴条。
- **凭证**：`--offline` 打印 SESSDATA 到期 2027-04-20（余 165 天），storyboard cookies 到期 2026-11-30（余 23 天）。
- **未验**：真扫码登录（`login.mjs` 只有 fake fetch 单测）；`bili_frames` 在超长视频上的 600s 阻塞行为。

### 4.4 成熟度：**beta**

判据：① 真实网络 + 真实凭证 + 真实图片产物，今天仍然可用 → 高于 alpha；② 只读边界被测试固化、
错误码可行动、限速/退避有长测；③ 覆盖窄（无下载/无互动）是设计边界不是缺口；④ 少一次"真扫码"与一次长片验证 → 不给 production。

### 4.5 已知缺口 / 不满意点

1. **临时目录泄漏**：`src/index.mjs:335` 每次 `bili_frames` `mkdtempSync(%TEMP%/icl-bili-board-*)`，**没有清理**。
   本机实测 **295 个残留目录 / 0.7 MB**（最早 2026-11-06，最新本次审计）→ 长期跑会无限增长。
2. **同步阻塞可达 600 s**：`callStoryboard` `execFile` timeout 600 000（`:155`），`bili_frames` 在长片上会把一轮会话卡住；
   `docs/STATUS.md:36` 自己也记了这条。
3. **无下载/无入库**：看完就算完，`album` 没有被调用（§1 结论 3）；用户"把这段留下来"做不到。
4. **文档漂移**：`docs/STATUS.md:36` "4 个工具"（实际 7 个）、`:128` "bili 子进程分支：零，只测了工具面形状"
   （实际 15 条真 runner 测试）；`docs/BILI-FEASIBILITY.md:373` 仍要求"工具面 5 个以内"。
5. `bili-eval.mjs` 用临时 stateDir，所以它永远报 `python 来源 legacy-compat`；产品 stateDir 里其实有
   `<stateDir>/bili/.venv`（我确认存在）。这条是**评估脚本的口径问题**，容易被误读成"ICL 还没自持 venv"。

---

## 5. video

### 5.1 交付的功能

| # | 工具 | 实现 | 兑现状态 |
|---|---|---|---|
| 1 | `video_probe` 只读容器头（时长/分辨率/fps/音轨/字幕/大小），不解码 | `src/probe.mjs`、`index.mjs:165-183` | ✅ 真 ffmpeg |
| 2 | `video_open` 文件 → 元数据 + 概览图；目录 → 列视频 | `:186-236` | ✅ 真 CLI |
| 3 | `video_storyboard` 窗口分镜（cells 1–16 / sheets 1–4 / textOnly 只给清单） | `:239-281` | ✅ |
| 4 | `video_zoom` 短窗近看（≤180s，默认 6 格，minGap 0.4） | `:284-319` | ✅ |
| 5 | `video_locate` 按台词定位（字幕轨 / transcriptFile / ASR；无来源时**直接短接**，不偷偷上云） | `:322-374` | ⚠️ 精度受 ASR segments 限制 |
| 6 | `video_frames` 精确 1–6 帧，多帧拼一张 | `:377-409` | ✅ 真 ffmpeg |
| 7 | 边界：只认本地路径（http/www → `E_REMOTE_URL`）、8 GiB 上限、24h 清工作目录 | `paths.mjs:28-112`、`index.mjs:153-156` | ✅ |

### 5.2 对当事人/用户的价值

- 任何"落到磁盘上的视频"她都能看：QQ 发来的、MC 录屏、用户自己的片；先花 60 ms 看元数据，再决定花不花图片 token。
- 一次调用给"几张带编号的格子 + 可引用时间清单"，她能说"第 3 格（00:12.3）里那个东西是什么"，
  而不是泛泛描述；知道台词但不知道时间时用 `video_locate` 找回来。
- 不出网是硬边界：不会因为一段普通视频把音频发到远程——除非**明确配了** ASR。

### 5.3 证据与测试

- `node --test packages/plugins/video/test/` → **6 pass**：工具面 6 个且无下载/上传；目录列举与稳定失败码；
  假 CLI 的图+清单+定位；无字幕且 ASR 关闭时短接（不启动 CLI）；**真 ffmpeg 样例** probe/单帧/多帧；
  带空格/中文路径 + 刚 rename 立刻调用（QQ 落盘场景）。
- 文档侧真机表（`docs/VIDEO-EYES.md:176-192`，2026-11-06，8 s 真样例）：probe 62 ms、open 842 ms（ASR 关）/
  5 472 ms（ASR 首开）、storyboard 641 ms、zoom 698 ms、frames 226 ms，四工具 attachment 契约通过。
- **本机环境**：ffmpeg/ffprobe 8.1.2 在 PATH；`~/.dsh/asr.json` 存在（8088 whisper-asr）→ 本机 `detectAsr()` 为真，
  首次 open/zoom 会带 5–9 s 转写；`~/.dsh/video.json` cookies 指向旧 focus-core 路径（仍有效，余 23 天）。
- **真实使用产物：0**。`.state/video-tmp` 存在（`apply()` 会 mkdir）但**没有 `work/`**，说明插件被装配过、
  工具却从未被真实调用；
  证据全部来自测试与文档。

### 5.4 成熟度：**beta**

判据：① 真 ffmpeg + 真 storyboard CLI + 真 localhost 样例端到端通过，失败码可行动 → 高于 alpha；
② 但"真实输入"只是合成样例，没接过一例真实 QQ 视频/MC 录屏 → 不满足 production。

### 5.5 已知缺口 / 不满意点

1. **没接真实来源**：与 QQ 的接口（`docs/VIDEO-EYES.md:4.1`）只存在于文档；QQ inbox 无文件、MC 无录屏（`VIDEO-EYES.md:201`）。
2. **ASR 精度**：8088 whisper 不返回 `segments`，storyboard 退化成"整段一段"，`video_locate` 只能命中整个窗口、
   **没有秒级时间码**（`docs/VIDEO-EYES.md:302-306` 已写明）。
3. **album 索引仍是"预留"**：`docs/VIDEO-EYES.md:145` 写"仓库里**没有** album 实现"，实际 album 已于 11-06 落地 →
   文档过期，两边也没有接。
4. **相对路径可用但文档写"只绝对路径"**：`paths.mjs:52` 对相对路径做 `path.resolve`；`index.mjs:167` 描述写
   "Local absolute path only"。行为更宽松，但描述与实现不一致。
5. **长片只能手工分段**：CLI 的 `--batch/-timeline.md` 未暴露（`docs/VIDEO-EYES.md:203`）。
6. **清理只在启动时**：`pruneWorkDirs` 只在 `apply()` 调一次（`index.mjs:155`）；长驻进程工作目录会一路涨到下次重启。

---

## 6. editor

### 6.1 交付的功能

| # | 工具 | 行为 | 兑现状态 |
|---|---|---|---|
| 1 | `read_file` | 工作区内读文本，超 `maxBytes` 拒绝，>20 000 字截断并**说明** | ✅ |
| 2 | `write_file` | 覆盖/追加；拒绝写 ICL 自己的状态文件，并解释原因 | ⚠️ 名单不完整 |
| 3 | `list_dir` | 列目录，最多 100 项并说明还有多少 | ✅ |

### 6.2 对当事人/用户的价值

"她能在自己的工作区记点东西、翻自己的文件"——最小可用；不碰系统目录（`inside()` 限根）。

### 6.3 证据与测试

`packages/core/test/audit-regressions.test.mjs:213`（读失败带 code、截断有标记）与 `:227`（写保护 ICL 状态文件、读仍可）。
无独立测试文件、无覆盖率指标。我实测真实 stateDir 里有 `time-events.jsonl` / `session-events.jsonl` / `bili/bili_credential.json`。

### 6.4 成熟度：**alpha**

判据：功能正确、错误可读；但"写保护"这一**唯一安全机制**落后于当前布局，且没有针对新文件的回归测试 → 不敢称 beta。

### 6.5 已知缺口 / 不满意点

1. **保护名单漏了当前实际状态文件**（`packages/plugins/editor/src/index.mjs:21-27`）：只保护
   `memory.db / state/memory.db / time.json / focus.json / rhythm.json / session-events.jsonl / mc-link.jsonl /
   time.inbox/outbox.jsonl`。真实 stateDir 里还有 `time-events.jsonl`（23 KB）、`eager-recall.jsonl`、
   `loop.inbox/outbox.jsonl`、`qq-ledger.db`、以及 **`bili/bili_credential.json`（B 站凭证）** —— 这些都能被
   `write_file` 覆盖。写坏凭证 = 掉登录；写坏事件流 = 记忆/回放断档。
2. **工作区就是 stateDir**：`packages/dsh-icl/src/bootstrap.mjs:17` 把 `root` 设成 `cfg.stateDir`，
   所以"她的工作区"和"ICL 的运行时状态/凭据"是同一个目录；白名单式保护注定追不上新增文件。
3. `write_file` 没有大小/磁盘配额，`append` 可以无限增长。

---

## 7. note

### 7.1 交付的功能

| # | 能力 | 实现 | 兑现状态 |
|---|---|---|---|
| 1 | `memo` 写一条（≤400 字，namespace `note`，**不可召回**） | `src/index.mjs:20-29,82-96` | ✅ |
| 2 | `memos` 看今天未结（`all` 看更早、`done` 含已完成） | `:98-120` | ✅ |
| 3 | `memo_append` 往未结事项补证据/半答案 | `:122-135` | ✅ |
| 4 | `memo_commit` 标完成 + 结论/来源（等做梦回收） | `:137-150` | ✅ |
| 5 | `note_status` 只给三个计数 | `:152-164` | ✅ |
| 6 | 世界状态一行："还有 N 件事没了结"（不推消息、不教她怎么问） | `:69-80` | ✅ |
| 7 | 服务接口 `add/append/commit/resolve/count/open`，dream 用它提问题/结案 | `:166`、`dream/src/index.mjs:943-953,1203-1211` | ⚠️ 闭环未跑通 |

### 7.2 对当事人/用户的价值

被动备忘录：不占对话、不进 recall、不给指令，只在世界状态里放一句计数；dream 发现矛盾/证据不足时提一个"待解问题"
（带上 `about.key`），等人或后续整理来结。对用户而言，是"她记得还有事没弄明白"的轻量载体。

### 7.3 证据与测试

- 11 pass：写/看/结、世界状态一行、**不在 recall 里**、无 world 插件也能用、计数不受 500 行窗口限制、
  追加后仍 open、完成带结论、默认只看今天、跨天碎片不丢。
- **真实库**（`state/state/memory.db` 只读）：`note/note` **16 条，全部 `status=open`**；
  4 条 memo、12 条 question（12 条都带 `about.key`）；时间跨度 2026-11-03 16:51 → 11-05 15:00。
  没有一条 `done`/`resolved`/`archived`。

### 7.4 成熟度：**beta（机制）/ alpha（闭环）**

判据：工具与单测扎实、有真实写入（16 条）→ 机制 beta；但"提问题→结案"这条闭环在真实数据上 0 次成功，
问题的唯一自动结案路径是 dream cleanup 按 `about.key` 命中纠正（`dream/src/index.mjs:1203-1211`），
两天里一次都没命中。

### 7.5 已知缺口 / 不满意点

1. **只进不出**：16 条 open、0 结案。`resolve()` 不是工具（只有 service），`memo_commit` 需要她主动想起来；
   没有任何"过期提醒/自动归档/重问"机制。
2. **默认视图看不到旧账**：`memos` 不带 `all` 只看今天（`index.mjs:110-118`）→ 那 12 条 11-03..05 的问题
   在默认调用里根本不出现，容易被永久遗忘。
3. **没有媒体面**：本组"媒体相关面"实为空——note 只存文本（设计如此），与图片/视频无接口；
   这也意味着"看到的东西"要留痕只能靠模型自己写一句（`docs/VIDEO-EYES.md:147` 的约定）。
4. 计数口径：`count()` 用 `memory.count({status:'open'})`，与 `memos` 的"今天 open"不是同一个集合
   （`note_status` 的 open 含历史），两处数字会对不上，容易让她误判。

---

## 8. MC-EYES（媒体接口部分）

### 8.1 交付的功能

| # | 能力 | 实现 / 端点 | 兑现状态 |
|---|---|---|---|
| 1 | 结构化场景快照（位置/血/饥饿/时间/手持/背包/脚下 map/附近方块/实体/敌对/任务/安全/事件） | body `GET /v1/eyes/snapshot?radius`、`packages/mc-body/src/eyes.mjs`；工具 `mcb_snapshot`（`mc-link/src/index.mjs:1579`） | ✅ 单测 3 条 |
| 2 | 按需像素截图（viewer + Edge CDP，PNG + 同名 meta，quota 1 并发/15s 间隔） | `POST /v1/eyes/screenshot`；工具 `mcb_eyes`（`:1597`） | ⚠️ 只离线 demo |
| 3 | 文件落 `media/mc-eyes/<runId>/<ts>-<kind>.png` + 同名 `.json` meta | `docs/MC-EYES.md:207` | ⚠️ 真实会话 0 张 |
| 4 | 与 album/video 的接口 | `docs/MC-EYES.md:155-161`（仅"建议"） | ❌ 无实现 |

### 8.2 对当事人/用户的价值

MC 里的"眼睛"分两级：毫秒级 JSON 快照（日常看场景、找方块、判断危险，不花图片 token）；7–8 s 的像素截图
（里程碑/告警取证/用户明确要看画面）。截图作为 PNG 附件回给模型，旧宿主降级为路径 + meta。

### 8.3 证据与测试

- `node --test packages/mc-body/test/eyes.test.mjs` → 3 pass（结构化聚合/无 adapter 降级/依赖探测不抛）。
- mc-link 工具面 17/17 全部可见（我跑过 surface 探针，`mcb_snapshot`/`mcb_eyes` 都在）。
- **真产物**：`.state/lab/mc-eyes-poc/p1-tool.png`（267 498 B、998x483、capture 7 106 ms、meta 完整）。
  我打开看过：平坦 demo 世界 + 4 个方块，**无 HUD、无皮肤、第三人称固定中心**——与文档限制一致。
- **未验**：真 MC 服 happy-path、真实会话里的截图（`.state/mc-state` 下无 `media/`）。

### 8.4 成熟度：**alpha**

判据：结构化快照可算 beta（零依赖、真数据源、工具可见），但截图链路"离线 PoC 真、真服未跑"，
且相册/视频联动完全没有 → 整体 alpha。

### 8.5 已知缺口 / 不满意点

1. **文档说"待 mc-link 接"，实际已接**：`docs/MC-EYES.md:213` 的 `mcb_snapshot`/`mcb_eyes` 已经是 17 工具的一部分 →
   文档过期。
2. **画面质量边界明显**：第三人称、固定 center、无 HUD/皮肤/名字；负 Y 世界整体 +64 渲染偏移（`mc-link/src/index.mjs:1599`
   描述里自己写了"截图对结构仅作参考，验收以 body verify 为准"）。
3. **成本**：7–8 s/张、Edge 峰值 ~1.3 GB、quota 1 并发/15 s；不适合当默认眼。
4. **album/video 联动零实现**：截图不自动入库、帧序列不能合成视频；`docs/MC-EYES.md:155-161` 是愿望清单。
5. **真实会话 0 张**：产品 stateDir 里没有任何 `media/mc-eyes` 产物 → 这条能力从未被当事人用过。

---

## 9. 横切问题（接口/媒体层）

### 9.1 工具可见性规则被一个插件打破（详见 §2.5-1）

`manifest.tools` 是"模型能看到什么"的唯一来源（`services.mjs:170-195` + `bridge.mjs:157`），
插件注册表本身不校验归属。QQ 注册了 10 个、声明了 2 个 → 8 个静默消失。
**这是全组唯一一个"功能做了、测试绿了、用户永远拿不到"的缺陷**，也是最值得先修的。

### 9.2 attachment 通路本身是好的

三个入口都验证过：工具结果 `{text, images:[png]}` → `normalizeToolResult` → `saveImage` → image block
（`packages/core/src/dsh-contract.mjs:90-152`）；QQ 消息 `batch.images` → `saveImages`
（`packages/dsh-icl/src/bridge.mjs:463-534`）；`imagePath` 旧字段也兼容（`dsh-contract.mjs:98`）。
唯一没验证的是"真机上 DSH attachment 到底长什么样"（`docs/QQ.md` 自认"attachment 形状真机待验"）。

### 9.3 文档与代码漂移清单（按严重度）

| 文档声明 | 实际 | 证据 |
|---|---|---|
| `docs/QQ.md:32-37,41` P1 账本/表情/qq_help ✅ 已实现 | 模型面不可见 | `qq/manifest.json:4`、`services.mjs:189`、我的探针 |
| `docs/QQ.md:889` WS 不补课、私聊不可靠 | 补课已实现 | `qq/src/index.mjs:470-475`、`backfill.mjs` |
| `docs/QQ.md:892` 媒体不落地 | 图片/视频/文件都落盘 | `index.mjs:745-841` |
| `docs/QQ.md:901` 没有"回过没"账本 | 已实现（markReplied + qq_replied） | `ledger.mjs`、`index.mjs:1374+` |
| `docs/QQ-GAP.md:15-27` 像人回话不完整 | P0-3 已落地（多气泡/节奏/切分） | `humanize.mjs`、44 条 fake 测试 |
| `docs/ALBUM.md:116` `exportFile(id)` 接口 | 不存在 | `album/src/index.mjs:770-784` |
| `docs/ALBUM.md:124-127` bili/qq/dream/recall 集成 | 0 处调用 | 全仓 grep |
| `docs/ALBUM.md:149` A5 自动清理最旧 | 用户拍板 + 代码：不自动删 | `ALBUM.md:57-62`、`index.mjs:166` |
| `docs/ALBUM.md:185` album root = `<stateDir>/media` | 实际 `ICL_ROOT/album`（`.state/album`） | `bootstrap.mjs:25`、`icl-paths.mjs` |
| `docs/ALBUM.md:88` 图进模型要等 attachment 通道 | 已通 | `dsh-contract.mjs:98-113` |
| `docs/VIDEO-EYES.md:145` 仓库里没有 album | 已落地 | `packages/plugins/album` |
| `docs/MC-EYES.md:213` mcb_* 待 mc-link 接 | 已接（17 工具） | `mc-link/src/index.mjs:1579,1597` |
| `docs/STATUS.md:36` bili 4 个工具 | 7 个 | `bili/manifest.json` |
| `docs/STATUS.md:128` bili 子进程分支"零" | 真 runner 15 条测试 | `bili/test/bili.test.mjs` |

### 9.4 测试设计缺口

1. **没有"注册 ⊆ manifest"的不变量测试**（一条 `host.services.tools.list()` vs `surface.names()` 的集合断言就能抓住 §2.5-1；
   `surface.test.mjs` 只测了过滤行为本身）。
2. **契约测试默认走 registry 而不是 surface**：`qq-ledger-tools.test.mjs:90` 用 `tools.list()`，等于在测试里绕过了产品真实入口。
3. **媒体/账本/表情没有真机契约**：全部 fake；`.state` 里 0 个 inbox 文件、0 个 ledger、0 个表情库。
4. **真 CLIP 检索默认 skip**（`album.test.mjs` 的 `ALBUM_CLIP_SMOKE=1`），本机配置又没 provider → "图片记忆"长期无回归。
5. **没有任何真实媒体样本回归**：album/video/mc-eyes 的真实输入都只存在于文档的一次性记录。

---

## 10. 建议的下一步验证顺序（不改代码，仅建议）

1. **修 QQ manifest + 加不变量测试**（1 行数据 + 1 条 surface 断言）。在此之前，`docs/QQ.md` 的 P1 ✅ 应降级为"不可见"。
2. **QQ 真机补三件事**：一条带图片的私聊（验 attachment 真实形状）、一次重启后的 `qq_history`（验 ledger 落盘，
   需要配 `ledgerFile`）、一个真实表情文件（验 `qq_send_sticker`），并决定表情只读工具是否脱离发送钥匙。
3. **把 qq 放进产品 preset 前先过上面的真机验证**；否则产品里只有 `qq_status` 一个"看状态"工具。
4. **album 接 `clip-zh`**（`config/icl.local.json` 加 512d provider，8088 已有模型），做一次真实 20 图
   "导入 → 语义搜 → 宫格 → 隐私"验收；同时决定"发送通道"到底做不做（不做就把 ALBUM.md 的承诺删掉）。
5. **bili 临时目录清理**（一次 `rmSync` in `finally`），并顺手清掉本机 295 个残留。
6. **editor 写保护改为"目录级清单 + 新状态文件注册表"**，至少补上 `time-events.jsonl`、`eager-recall.jsonl`、
   `loop.*.jsonl`、`qq-ledger.db`、`bili/bili_credential.json`。
7. **文档回填 §9.3 表**：这些漂移会直接影响下一个接活的人对"到了什么阶段"的判断。

---

*审计者：接口/媒体组只读审计子代理 · 2026-11-07 · 基线 `649c8dd`。本文件不含任何当事人聊天正文/凭据值；
DB 只读统计、临时目录与真实截图仅用于本次判定。*
