# B 站接入可行性研究（A 适配旧插件 / B 移植进 ICL / C 混合）

> 状态：**研究结论，待 lead/用户拍板**。本轮不写产品代码；改动只有这份文档 + `tools/bili-eval.mjs`（评估脚本）。
> 基线：`wt/bili` @ `e3fd594`；所有"实测"都在本 worktree 上只读执行。
> 读者：lead、用户。先读 §0，再按需跳读。

---

## 0. 结论先行

**推荐 C（vendored MIT MCP + ICL 自有适配层），现在 1–2 人日可固化；B 是终点不是第一步；A 只适合"保留旧插件作为另一个独立产品"。**

三条硬事实（后面的分析都从这里出发）：

1. **"两个刷 B 站插件"其实是两件不同的事**：`dsh-bili-scroll` 才是"刷 B 站"产品（搜索/字幕/评论/日报/@/私信）；`dsh-video-storyboard` 是**通用**视频分镜工具，B 站链接只是它的一等输入。所以不存在"二选一"——storyboard 在三条路线里都建议保留，它是目前**唯一能让模型真正看到画面**的能力。
2. **"刷热门"现在其实没有人接出来**：`bili_hot_videos` / `bili_rank` / `bili_weekly_hot` / `bili_hot_buzzwords` 都在 vendored MCP 里（`vendor/bilibili-mcp/mcp_server.py:1029-1150`，实测可用），但旧插件的工具白名单只有 4 个只读工具（`index.js:1036-1044`），旧插件对外 11 个工具里也没有热门；我们 ICL 的 4 个工具同样没有。**无论选哪条路线，热门都得补一个新工具**（临时结论：`bili_feed`）。
3. **账号写操作是 A 的死穴，也是本轮最容易被忽略的风险**：旧插件会拿用户账号发评论/私信（`bili_reply`、`bili_send_message`、`dmWatch`），默认值还比较激进（本机 profile 里 `autoComment: true`、`dmMode: only`、`mentionName` 已填，`~/.dsh/profiles/desktop/cordis.patch.yml:201-214`；`dmWatch` 默认就是 true，`index.js:86-89`，`~/.dsh/bili-duty/config.json` 里也是 true）。它和 ICL 的"她只读不互动"（`prompts/sim.md:48-51`）是相反的。做长期测试前必须把这条钉死。

**在什么条件下 A 更优**：目标不是"接进 ICL"，而是**保留旧插件那套完整的自主值班产品**——每天自动挑视频、写日报、挑一条 @ 用户、私信投递、收藏、本地转写、设置页；时间只有半天；接受它是**第二个 agent 进程**（自己的 headless 会话、自己的提示词、自己的状态），不要求它跟 ICL 的人格/记忆/focus/time 融为一体；且用户愿意让"它"继续拿账号做写操作。

**在什么条件下 B 更优**：长期不接受 Python/uv 依赖（要么零安装、要么受限环境跑不了 Python）；只需要**只读**能力（搜索/热门/播放页/字幕/评论/切帧）；愿意用 3–6 人日重写并长期维护 B 站协议（WBI 签名、风控、字幕接口变更）；并且希望整个工具面完全由 ICL 的 `manifest + ctx.tools.register` 管住，提示词/`focus`/时间模块只有一套语义。

**为什么现在推荐 C**：旧插件已经踩过的坑（登录、字幕接口、评论区风控 `-412`、私信 `-509`、限流、依赖版本）是**资产**，vendored MCP 是 MIT（`README.md:138-141`），可以合法搬进 ICL 仓库；我们现有的 4 个工具今天就在用这条路（只读实测 11/11 通过），但**接缝是"偷偷依赖旧插件在用户机器上的安装"**（§3.3），必须收进仓库才能长期测。C 同时给 B 留了同一条工具接口，将来把 vendor 换成 JS 不用改模型面。

---

## 1. 研究范围与方法

- 只读阅读：`C:\Users\ai_admin\.dsh\profiles\desktop\node_modules\dsh-bili-scroll`（host 137 KB + client 53 KB + `lib/` + `vendor/bilibili-mcp` + `prompts/duty.md` + `selfcheck.mjs`）、`dsh-video-storyboard`（`src/`、`bin/`、`docs/`、README）。
- 只读阅读我们的：`packages/plugins/bili/**`、`docs/PLUGINS.md`、`docs/PROMPT-CONTRACT.md`、`docs/FOCUS.md`、`prompts/{sim,live}.md`、`packages/core/src/{host,services,dsh-contract}.mjs`、`packages/dsh-icl/**`、`packages/dsh-icl/presets/*.yml`。
- 只读实测：`bili_search` / `bili_video_info` / `bili_subtitle` / `bili_comments` / `bili_hot_videos` / `bili_rank` / `bili_hot_buzzwords`，以及一次短片的 `bili_frames` 端到端（10 秒窗口、4 格；**没有**开启任何刷视频循环，也没有任何写操作）。
- 最小评估脚本：`tools/bili-eval.mjs`（**仅评估，不被产品路径 import**）。
- 测试基线：`node --test packages/core/test packages/mc-body/test packages/plugins/mc-link/test` = **452 pass**（只跑任务里给的两个目录是 **396**：core 362 + mc-body 34；452 需要加上 mc-link/test，见 §9 注）。

---

## 2. 两个旧插件是什么

### 2.1 `dsh-bili-scroll`（"刷 B 站"）——纯 DSH 插件 + vendored Python MCP + 自带 headless 调度

**形态**：标准 DSH bundle 插件（不是浏览器扩展、不是 Chrome 插件、不是外部服务）。

| 组成 | 事实 | 证据 |
|---|---|---|
| bundle 挂载 | 包自己带 `dsh.bundle.patch`，profile 的 `bundles` 里列包名即生效 | `package.json:57-69`、`cordis.patch.yml:15-19` |
| host 半端 | `export name='bili-scroll'`、`inject=['webServer','tools','settings']`；`apply()` 注册 11 个 DSH 工具 + 60 s 定时器 + `/api/bili-duty/*` 路由 | `index.js:38-39`、`index.js:512-695`、`index.js:2222-2230` |
| 浏览器半端 | `client.js` 往 `settings.section` 注入"刷B站"设置页，另试 `conversation.view`（"刷过的视频"tab） | `client.js:796-826` |
| 外部进程 | 插件内部起 Python MCP（stdio JSON-RPC），通过自带迷你 MCP 客户端调用；**不是**用宿主 `dsh-mcp-client` 常驻 | `lib/mcp.mjs:18-119`、`index.js:1046-1099` |
| Python 依赖 | `bilibili-api-python>=17.4.1,<18` / `aiohttp` / `mcp<2` / `qrcode[pil]`；独立 venv 在插件家目录 | `vendor/bilibili-mcp/requirements.txt:1-8`、`index.js:163-166` |
| 登录态 | JS 走 B 站 passport 扫码接口，把 4 个字段写 `$DSH_HOME/bili-duty/bili_credential.json`；MCP 只读这个文件 | `lib/login.mjs:53-88`、`vendor/.../mcp_server.py:56-75` |
| 状态/家目录 | `$DSH_HOME/bili-duty/`：config、credential、mcp_server.py、duty.md、out/、seen.md、state、duty.log | `lib/state.mjs:35-49`、`lib/state.mjs:60-75` |
| 自动跑 | 60 s tick，命中 12–14 点 / 18–09 点窗口就 `spawn('dsh --profile headless --patch overlay <prompt>')`——**起一轮独立的 headless DSH 会话** | `index.js:1157-1237`、`index.js:1245-1274`、`lib/state.mjs:24-27` |
| 提示词注入 | `prompts/duty.md`（178 行）只在**那一轮 headless 会话**里作为 prompt 使用；不是 ICL 的 persona/sim 层 | `prompts/duty.md`、`index.js:1036-1044`（overlay 白名单） |

**它的 11 个 DSH 工具**（`index.js:518-694`）：`bili_whoami` / `bili_search` / `bili_subtitle` / `bili_comments` / `bili_reply` / `bili_status` / `bili_run` / `bili_login_start` / `bili_login_poll` / `bili_setup` / `bili_config`。

**它一轮能看到的工具**（headless overlay 白名单，`index.js:1036-1044`）：`bili_search`、`bili_subtitle`、`bili_comments`、`bili_video_info`；开自动评论/回复才加 `bili_reply`；`dmMode != off` 才加 `bili_send_message`。上传、发动态、抓全站这些**不注册**（`README.md:115-117`）。

**能否 headless 复用**：
- **vendored MCP（`mcp_server.py`）可以**：它是标准 stdio MCP，`python mcp_server.py` 即可被任意 MCP 客户端接；我们的 `tools/bili-run.py` 甚至直接 import 它调函数（`tools/bili-run.py:31-43`），今天就是这么跑的。
- **host 半端不行/不划算**：它依赖真实 DSH 的 `ctx.get('dshHomePath')`、`webServer`、`settings`、`slots`（`selfcheck.mjs:34-43` 用假 ctx 才跑得起来），而且自动跑会再 spawn 一个 dsh 进程——在 ICL 里用等于**两个 agent 抢同一份用户注意力**。

**能力清单**（"有"指旧插件真的暴露/真的跑）：

| 能力 | 旧插件 | 证据 |
|---|---|---|
| 搜索（关键词/排序） | ✅ 工具 | `index.js:531-547` |
| 播放页信息 | ✅ 工具 | `index.js:549-555`、`vendor/...:474-511` |
| 字幕（AI 字幕全文） | ✅ 工具 | `index.js:549-555`、`vendor/...:385-444` |
| 评论（含楼中楼） | ✅ 工具 | `index.js:557-567`、`vendor/...:313-383` |
| 弹幕 | ⚠️ vendor 有，插件未暴露 | `vendor/...:446-472` |
| **热门/排行榜/每周必看/热搜词** | ⚠️ **vendor 有，旧插件未暴露** | `vendor/...:1029-1150`、白名单 `index.js:1036-1044` |
| 批量采集 `bili_crawl` | ⚠️ vendor 有，插件未暴露 | `vendor/...:571-642` |
| 发评论/回复（写） | ✅ 工具但有闸（默认配置下可被 `force` 越过） | `index.js:569-598` |
| 发私信/私信监听（写） | ⚠️ 通过 overlay 白名单 + 宿主私信监听 | `index.js:1036-1044`、`lib/dm.mjs` |
| 上传视频/发动态/发专栏（写） | ⚠️ vendor 有，插件明确不暴露 | `vendor/...:677-1010`、`README.md:115-117` |
| 收藏夹操作 | ✅ 宿主侧（模型拿不到这只手） | `index.js` 的 `favops.py` 调用、`lib/favops.py` |
| 本地转写（Whisper） | ✅ 可选（要另装 ~1 GB） | `lib/asr.py:1-50`、`README.md:72-73` |
| 评论发出后复核 | ✅ 宿主侧只读复核 | `lib/verify.mjs:1-60` |
| 限速 | ❌ 没有全局限速；vendor 里只有两处固定 sleep（评论翻页 0.5 s、批量采集 1 s） | `vendor/...:369`、`vendor/...:629` |
| 反爬 | ⚠️ 只做了错误可见（`-412` 不再伪装 0 评论）与固定 sleep；没有退避/重试；实测撞过 `-509 请求过于频繁` | `vendor/...:371-375`、`duty.log` 2026-10-29T13:43:55 |
| UI/提示词注入 | 设置页 1 个 + 会话 tab 1 个；duty.md 只进它自己的 headless 轮 | `client.js:796-826`、`README.md:108-121` |

### 2.2 `dsh-video-storyboard`（"切帧看图"）——纯 JS DSH 插件 + ffmpeg/yt-dlp

| 事实 | 证据 |
|---|---|
| 纯 JS DSH 插件，`inject=['tools','attachments']`；无 Python | `dsh.plugin.json:5-10`、`src/index.js:24` |
| 4 个工具：`video_probe` / `video_storyboard` / `video_zoom` / `video_locate`；工具描述自带参数、边界、失败指引 | `src/tool-spec.js:14-18`、`src/index.js:196-199` |
| B 站链接一等输入；扫描用 360P 全片，`video_zoom` 回原流取 1080P | `README.zh.md:22-36`、`src/fetch.js` |
| 外部依赖：ffmpeg + ffprobe（必须）、yt-dlp（贴链接才需要）、cookies.txt（登录态；没有就匿名，1080P 可能不在格式列表里） | `README.md:41-47`、`src/fetch.js:25`、`src/fetch.js:271-291` |
| 图片**真的进模型**：`ctx.attachments.saveImage()` → `output.render` 返回 image content block | `src/index.js:7-12`、`src/index.js:46-61`、`src/index.js:135-143` |
| 可命令行复用：`bin/storyboard.mjs`（我们 `bili_frames` 现在就是调它） | `package.json:38-41`、`bin/storyboard.mjs` |

### 2.3 两个插件的登录态是两套（必须分别处理）

| 用途 | 位置 | 谁来维护 |
|---|---|---|
| bilibili-api-python（搜索/字幕/评论/私信/写操作） | `$DSH_HOME/bili-duty/bili_credential.json`（4 字段，`lib/login.mjs:78-88`） | 旧插件设置页"扫码登录" |
| yt-dlp（storyboard 拉流/高清） | `~/.dsh/video.json` 的 `cookies` 字段指向的一份 Netscape `cookies.txt`（`src/fetch.js:249-291`） | 用户手动导出/更新，插件不管 |

**实测**：凭证今天有效（只打印了 `logged_in=true` 与脱敏 uid；**没有打印 cookie/token**）；storyboard 拉流日志显示 `auth=cookies, source max 1080p`，即那份 cookies.txt 也在生效。两套都**没有在 ICL 里管理**——这是 §3.3 的 P0 缺口。

---

## 3. 我们现有 `bili` 插件的真实可用性

### 3.1 工具面与实现

`packages/plugins/bili`：manifest 4 个工具（`manifest.json:5`），`src/index.mjs` 182 行。

| 工具 | 实现 | 关键事实 |
|---|---|---|
| `bili_search` | `execFile(python, [bili-run.py, 'bili_search', json])` | 结果截到 `maxChars=6000`；没有字段清洗 |
| `bili_watch` | 先 `bili_video_info`，再 `bili_subtitle`，拼起来截断 | 两次 Python 进程；字幕为空时只返回信息 |
| `bili_comments` | `bili-run.py bili_comments` | 只读 |
| `bili_frames` | `execFileSync(node, [storyboard.mjs, url, --cells, --out, --manifest, --allow-anonymous, --from, --to, --scan-height 240])` | 默认只扫前 240 s；`imagePath` 只变成一句文本 |

依赖的 4 条绝对路径写在文件头（`index.mjs:10-15`）：`BILI_PYTHON`、`ICL_ROOT`（默认 `C:/DSH/qwenstuff/icl`！）、`BILI_RUNNER`、`STORYBOARD_CLI`、`BILI_DIR`。`preflight()` 分开报缺哪个（`index.mjs:22-35`）——这一点做得对。

### 3.2 只读实测（`tools/bili-eval.mjs`，本机）

| 检查 | 结果 |
|---|---|
| 4 条接缝路径 | ✓ python / runner / bili-duty 家 / storyboard CLI 都在 |
| 工具面 | ✓ 正好 4 个：`bili_comments` `bili_frames` `bili_search` `bili_watch`；无写工具 |
| `bili_search`（"DeepSeek Harness"，3 条） | ✓ 2.1 s，返回 3 条，含标题/UP/播放/时长 |
| `bili_watch`（BV1L7xm64EHP） | ✓ 3.6 s，6000 字（信息 + 字幕全文） |
| `bili_comments`（同视频，3 条） | ✓ 2.2 s，含楼中楼 |
| `bili_frames`（BV1dC4y117Rz，0–10 s，4 格） | ✓ 28.6 s（命中缓存），出 365 KB 宫格图 + 时间线 |
| 登录态（`bili_check_credential`） | ✓ 凭证有效（账号信息脱敏） |
| 汇总 | **11/11 通过**（`node tools/bili-eval.mjs --credential`） |

单测侧已有两条保护：缺依赖时 4 个工具给可操作错误（`packages/core/test/audit-regressions.test.mjs:248-273`）；工具面形状固定、无发言类工具（`packages/core/test/sandbox-and-seams.test.mjs:36-44`）。**子进程分支零测试**（`docs/PLUGINS.md:179`）。

### 3.3 已确认的缺陷 / 长期测试会踩的坑

按后果排序：

1. **接缝依赖用户机器上旧插件的安装，且路径默认指错仓库**：`ICL_ROOT` 默认 `C:/DSH/qwenstuff/icl`，而 live `dsh-icl` 链接的是 `C:/DSH/icl`（`~/.dsh/profiles/desktop/package.json`）。实测 `bili-run.py` 实际解析到 `C:/DSH/qwenstuff/icl/tools/bili-run.py`（与仓库内副本只差 CRLF）。换机/旧仓库被清理即全废，且没人会发现用的是哪一份。
2. **可执行代码从用户可写目录加载**：`bili-run.py` 把 `BILI_DIR` 塞进 `sys.path` 再 `importlib.import_module('mcp_server')`（`tools/bili-run.py:31-33`）；`$DSH_HOME/bili-duty/mcp_server.py` 是旧插件铺的——任何能写这个目录的进程都能改我们执行的代码。同时它**没有只读白名单**：`getattr(mod, fn_name)` 可调 vendor 里任何协程（含 `bili_reply`/`bili_upload_video`），只是当前调用方没这么调（`tools/bili-run.py:37-43`）。
3. **没有登录/续期路径**：旧插件在 desktop profile 里 `disabled: true`（`~/.dsh/profiles/desktop/cordis.patch.yml:201-206`），它的设置页/扫码登录随之不可用；我们自己的插件只有 4 个只读工具，没有 `bili_login_*`。凭证一旦过期，`bili_search/watch/comments` 全部报错，**长期夜间测试会在某天突然死掉**。
4. **"看画面"在 ICL 里是断的**：`bili_frames` 返回 `{text, imagePath}`，但 ICL 的 DSH 契约只把 `imagePath` 追加成一句文本（`packages/core/src/dsh-contract.mjs:59-68`），且描述让模型用 `read_file`（ICL editor 的文本读，`index.mjs:173`）——**模型读不到图**。ICL 会话里其实有 DSH 的全局 `read_image`（`dsh-base` 的 `tool-fs`，`dsh-base/cordis.patch.yml:281-282`），描述应写 `read_image`，或干脆用原生 `video_storyboard`（它把图作为 attachment 直接返回，`dsh-video-storyboard/src/index.js:46-61`）。
5. **没有"热门"**：见 §0 硬事实 2。
6. **搜索返回里会出现空 `bvid` 卡片**（实测第三条 `bvid: ""`）：`bili_watch` 会把空串直接传给 `bili_video_info`，报错信息对模型不可操作；需要清洗/跳过。
7. **每次调用冷启动 Python（约 1.5–2 s）**：`bili_search` 2.1 s 里大半是 import；`bili_watch` 要起两次进程（3.6 s）。夜间看 10 条视频，光冷启动就 20 s+。
8. **没有限速/退避**：`execFile` 60 s 超时、无重试。B 站 `-412`/`-509` 一旦出现，模型会看到一次失败；旧插件实测过 `-509`（`duty.log` 2026-10-29T13:43:55）。
9. **文档与配置漂移**：desktop profile 的注释写"已由 dsh-icl 的纯 HTTP 实现取代（bili_feed / bili_search / bili_watch / bili_reply）"（`cordis.patch.yml:203`），但仓库里**不存在** `bili_feed`/`bili_reply`；这是上一轮设想的残留，会误导后来人。

---

## 4. 三条路线

### 4.1 路线 A：适配旧插件（启用/收编 `dsh-bili-scroll`）

**形态**：把 desktop profile 里的 `disabled: true` 改成 `false`（或复制它的 host 半端做薄封装），让旧插件自己注册工具、自己起调度。

```
DSH desktop profile
├── bili-scroll（host 半端，全局工具）
│   ├── 11 个 bili_* 工具（含 bili_reply、bili_config、bili_run…）
│   ├── 60s 定时器 → spawn dsh --profile headless（第二个 agent）
│   ├── 设置页 / "刷过的视频" tab
│   └── Python MCP（bili_credential.json）
└── dsh-icl（preset icl）
    ├── ICL 工具面：bili_search / bili_watch / bili_comments / bili_frames
    └── 人格 / sim / focus / time / memory / dream
```

**A 的细节（哪些成立、哪些不成立）**：
- 工具不会命名冲突崩掉：DSH 工具分层是"per-agent 注册遮蔽全局"（`@deepseek-ai/dsh-tools/lib/index.js:2633-2634`、`:2659-2662`）。ICL 的 `bili_search`/`bili_comments` 会**遮蔽**旧插件同名的全局工具，不会注册失败。但旧插件其余 **9 个全局工具**（`bili_whoami`、`bili_subtitle`、`bili_reply`、`bili_status`、`bili_run`、`bili_login_start/poll`、`bili_setup`、`bili_config`）会**原样出现在 ICL 会话的工具面里**——模型看得到，提示词管不住，其中 `bili_reply` 还带 `force: true` 参数（`index.js:569-598`）。
- 调度是第二套时间语义：旧插件自带 noon/night 窗口与 60 s tick（`lib/state.mjs:24-27`、`index.js:1245-1274`）；ICL 有 `time` 模块与 `focus`。两套同时跑，她会在"自己的节奏"之外被另一个进程叫出去刷。
- 提示词也是第二套：duty.md 只对那个 headless 轮生效；ICL 的 persona/sim 管不到它。日报/判重表/归档进旧插件家目录，**不进 ICL 的 memory / 原文层**，做梦读不到。
- **写操作**：`bili_reply` 的闸是 `autoComment && mentionName && dmMode !== 'only'`（`index.js:582-591`），本机配置正好是 `autoComment: true` + `mentionName` 已填 + `dmMode: only` ⇒ 公开评论被挡；但模型可以传 `force: true` 越过（`index.js:578`、`index.js:583`）。私信监听 `dmWatch: true` 会每分钟查私信（`lib/dm.mjs`），`dmReplyPerDay` 为 0 时只读；一旦有人把它调大，就是拿用户账号说话。
- 本轮**不能验证 A**：改 profile 的 `disabled` 需要重启 desktop（任务纪律禁止）；而且 `bili-scroll` 的 bundle 层重启才组装（`README.md:61-62`）。

**工作量**：0.5–1 人日（改 `disabled`、按需改名/隐藏 9 个工具、关掉调度与写操作、验证）。**但每次旧插件升级都要重做**，且无法把它的工具纳入 ICL 的 focus/提示词体系。

**风险**：
- 🔴 账号写操作（即使默认挡住了公开评论，`force` 参数 + 私信监听仍是悬着的）。
- 🔴 工具面污染：9 个带中文长描述的工具 + 与 ICL 同名的 2 个被遮蔽的工具，token 成本与"该用哪只"的困惑都是实打实的（与 `docs/PROMPT-CONTRACT.md:31-35` 的工具 description 预算方向相反）。
- 🟠 两个 agent/两套时间/两套状态，长期测试的观测与归因会分裂。
- 🟢 好处：0 重写，登录/设置页/日报/私信/复核/本地转写全部现成。

**A 更优的条件**（再列一次，给拍板用）：保留旧插件作为**独立产品**；不打算把她的人格/记忆/focus 接进去；接受第二个 headless 会话；接受账号写操作由旧插件自己管；半天内要能用。

### 4.2 路线 B：移植进 ICL

有两个子方案，别混：

- **B1（先落地）**：把 vendored MCP **源码**搬进 ICL 仓库（`packages/plugins/bili/vendor/bilibili-mcp/`），保留 Python 子进程，但**登录态、venv、家目录、白名单、版本、测试全归 ICL**；工具面按 ICL 的 4+1 个工具重写（加 `bili_feed`）。
- **B2（终态）**：用 JS 重写只读能力（search / video_info / subtitle / comments / hot / rank / weekly），不再需要 Python/uv；登录复用现有凭证或扫码头；WBI 签名、限速、退避自己实现。

```
ICL（packages/plugins/bili）
├── manifest：tools = [bili_search, bili_watch, bili_comments, bili_feed, bili_frames?]
├── src/
│   ├── index.mjs          ← ctx.tools.register（同今天）
│   ├── http.mjs           ← B1: bili-run.py；B2: fetch + WBI + cookie
│   ├── auth.mjs           ← credential / cookie 解析（不打印）
│   └── feed.mjs           ← hot / rank / weekly / buzzwords（新增）
├── vendor/bilibili-mcp/   ← 仅 B1；MIT + NOTICE + 5 处本地补丁清单
└── test/                  ← 契约测试（mock 子进程/fetch，不打真网络）
```

**工作量**：
- B1：**1–2 人日**（vendor 拷贝 + NOTICE/许可证 + 家目录/venv 自举 + credential 迁移 + `bili_feed` + 只读白名单 + mock 测试）。
- B2：**3–6 人日**（只读核心）+ 长期维护。主要成本在：WBI 签名与 `buvid`/cookie 拼装、字幕接口（`/x/player/wbi/v2`，需要登录 + wbi）、评论接口（`/x/v2/reply/main`，无 wbi 但风控 `-412`）、热门/排行/每周（多接口）、错误归一、限速退避、离线 fixture 测试。
- 写能力（评论/私信/上传）**不移植**；ICL 的定位是只读（`prompts/sim.md:48-51`）。

**风险**：
- 🟠 WBI/接口变更无官方 JS SDK，需要持续维护；测试依赖网络或录制 fixture。
- 🟠 纯 JS 重写意味着重踩旧插件踩过的坑（字幕空、`-412`、`-509`、DASH 清晰度、`buvid3`）。
- 🟢 终态最干净：零 Python、零外部插件、`manifest.tools` 与 ICL 提示词/focus/time 完全一套。

**B 更优的条件**：不允许 Python；只读范围就够；愿意支付 3–6 人日 + 维护；要求 ICL 工具面完全自持。

### 4.3 路线 C：混合——抓 vendor + 自有适配层（**推荐**）

**形态**：把 MIT 的 `mcp_server.py` 与 `lib/login.mjs` 搬进 ICL 仓库（保留出处与本地补丁清单），配自己的 venv/家目录/凭证目录与只读白名单；工具面仍是 ICL 的 `ctx.tools.register`；切帧交给已安装的 `dsh-video-storyboard`（它已能把图直接给模型）或保留 `bili_frames` 作为无 storyboard 环境的兜底。

```
packages/plugins/bili/
├── manifest.json           tools: bili_search / bili_watch / bili_comments / bili_feed / bili_frames?
├── src/index.mjs           参数转换、截断、错误可操作化、只读白名单
├── vendor/bilibili-mcp/    mcp_server.py（MIT）+ NOTICE + PATCHES.md（5 处本地修改）
├── vendor/login.mjs        扫码登录（从旧插件 lib/login.mjs 移植，写 ICL 自己的凭证文件）
├── tools? / runtime/
│   ├── bili-run.py         只读白名单（ALLOWED = {...}），从仓库内 vendor 导入
│   └── ensure-venv?        首次自举 venv（可用机器现有 python；不强制 uv）
└── test/                   契约测试：mock runner 输出 / 缺依赖 / 空 bvid / 只读白名单
```

```
DSH / ICL 会话
├── ICL 工具面：bili_*（per-agent 注册，遮蔽任何同名全局工具）
├── 原生 video_probe / video_storyboard / video_zoom / video_locate（host 级，已能看 B 站链接）
├── 提示词：persona / sim（"看视频"4 行）/ 工具 description
└── focus / time / memory / dream：一套语义（不再有第二个 headless agent）
```

**范围（C 的 P0）**：
1. 收编运行面：vendor 进仓库、**只读白名单**、ICL 自己的 `stateDir/bili`（credential + log），不再 import 用户机器上旧插件的 `mcp_server.py`。
2. 补 `bili_feed`：热门/排行/每周必看/热搜词（vendor 现成，实测可用，见 §附录 B）。
3. 登录：移植 `lib/login.mjs` 的扫码流程（约 100 行，纯 fetch），或第一阶段先"复制现有 credential + 文档说明过期后怎么重扫"。**必须有恢复路径**。
4. 切帧：优先用原生 `video_storyboard`（图直接进模型）；`bili_frames` 保留但描述改 `read_image` 并标记"无 storyboard 时的兜底"。
5. 提示词/接缝：`prompts/sim.md` 的"看视频和内容"保持 4 行（它已经在正确层）；不新增 bili 专属系统段；如需状态，只加 order ≥ 800 的一行事实（如"正在刷：BV…"）。
6. 观测：把每次调用的 `{tool, ms, ok, bytes, bvid}` 写 ICL state 里（评测/夜间长测用），不写 B 站账号侧。

**工作量**：**1–2 人日**（含测试与迁移文档）；登录移植 +0.5 人日；切帧改描述/去重 +0.5 人日。

**风险**：
- 🟠 Python/venv 安装面仍在（比 B2 多一个运行时依赖；可用机器现有 Python，不强制 uv）。
- 🟠 vendor 升级要重新合 5 处本地补丁（`vendor/bilibili-mcp/mcp_server.py:10-16` 自己列了清单：白名单、凭证容错、原子写、评论异常透传、reply 回执字段）——写进 `PATCHES.md` 就不容易漏。
- 🟠 仍要自己加限速/退避（建议 ≥1 req/s、`-412`/`-509` 指数退避、单轮上限）。
- 🟢 不引入第二个 agent、不引入账号写工具、工具面 5 个以内、与 focus/time/memory 天然一套。

---

## 5. 三路线对照表

| 维度 | A 适配旧插件 | B 移植进 ICL（B2 终态） | C 混合（推荐） |
|---|---|---|---|
| 跑在哪里 | 旧插件 host 半端（全局工具）+ 它自己 spawn 的 headless | ICL 插件（per-agent 工具） | ICL 插件（per-agent 工具） |
| 工具面 | 11 个全局 + 4 个 ICL（2 个被遮蔽） | 4–5 个 ICL | 4–5 个 ICL |
| 提示词 | duty.md 一套 + ICL persona/sim 一套（互不相干） | ICL 一套 | ICL 一套 |
| 时间/节奏 | 旧插件 noon/night tick + ICL time（两套） | ICL time/focus | ICL time/focus |
| 记忆/做梦 | 日报/判重/归档在旧插件家目录，进不了 ICL raw/memory | ICL memory（工具结果需自己记 memo） | 同 B |
| 账号写操作 | 有（`bili_reply` force、dmWatch、可开自动评论） | 无（只读） | 无（只读白名单） |
| 热门 | ❌（旧插件没暴露） | ✅ 要新写 | ✅ 从 vendor 接出 |
| 切帧看图 | ✅（storyboard 插件，非 bili-scroll） | ✅ 原生 storyboard | ✅ 原生 storyboard / bili_frames 兜底 |
| 登录 | 旧插件设置页 | 自己实现/复用凭证 | 移植扫码 + ICL 凭证 |
| Python 依赖 | 有（旧插件 venv） | B2 无；B1 有 | 有（可只用现有 python） |
| 安装/换机 | 依赖旧插件与其家目录 | 只装 ICL 包 | 只装 ICL 包 + `python -m venv` |
| 开发量 | 0.5–1 人日，但每次旧插件升级重做 | 3–6 人日 + 持续维护 | 1–2 人日（+0.5 登录） |
| 长期夜间测试适配 | 差（两个 agent/两套状态） | 好 | 好 |
| 主要风险 | 账号写操作、工具面污染、两套时间 | WBI/风控维护、重踩坑 | Python 安装面、vendor 补丁合并 |

---

## 6. 与 ICL 提示词分层 / focus / 时间模块的接缝

| 接缝 | 现状 | 路线 C 的处置 |
|---|---|---|
| **提示词三层** | 人格 20 / 仿真 25 / 事实 ≥800（`docs/PROMPT-CONTRACT.md:7-20`、`packages/dsh-icl/src/bootstrap.mjs:44-52`）。B 站"怎么看"已在仿真层：`prompts/sim.md:48-51`（先看画面 → 简介/字幕 → 评论；只读不互动）。 | **不新增系统段**。工具用法进 description，深文档进 skills；若要状态，只加 order ≥ 800 的一行事实。 |
| **工具 description** | `summary + description + when/avoid` 拼装，硬上限 900 字（`packages/core/src/services.mjs:17-39`、`:255-292`）。现有 4 个工具描述已经在预算内。 | 保持自足；`bili_feed` 描述要写清"热门/排行/每周/热词"四个入口与返回形状。 |
| **focus** | `focus` 语义把"刷 B 站"当一等 Activity 举例（`docs/FOCUS.md:17-19`）；但当前 bili 插件**没有**调用 focus（grep 为零）。 | 不写代码耦合；在 sim/操作层约定：她说"去刷吧"时 `focus_enter({kind:'bili', title:'刷B站', interruptible:false?})`，结束 `focus_leave`。可选，不阻塞。 |
| **时间模块** | `time` 的 goal 会绑 focus（`docs/FOCUS.md:40-41`）；旧插件的 noon/night tick 是另一套。 | **不要导入旧调度**；夜间要定时，用 `time_arrange`/唤醒消息，而不是 60 s tick + spawn。 |
| **memory / dream** | 工具结果**不进** ICL 原文层（`docs/DSH-INTEGRATION.md:146-154`），dream 读不到"她看过什么"；旧插件的报告/归档在它自己家目录，同样进不了。 | 约定：看完一条写一句 `memo_append`/`remember`；夜间长测的"看过什么"以 ICL memory 为事实源。 |
| **图像** | `bili_frames` 的 `imagePath` 只变成文本（`packages/core/src/dsh-contract.mjs:59-68`）；ICL 会话有 DSH 全局 `read_image`（`dsh-base/cordis.patch.yml:281-282`）。原生 `video_storyboard` 直接把图作为 attachment 返回（`src/index.js:46-61`）。 | 优先原生 `video_storyboard`（B 站链接直接传）；`bili_frames` 保留但描述改 `read_image`，并说明"图不会自动出现，要读路径"。 |
| **工具面一致性** | ICL 的 per-agent 工具会遮蔽同名全局工具（`dsh-tools/lib/index.js:2633-2634`、`:2659-2662`）；ICL 的工具面本身只含 `manifest.tools`。 | C 下 bili 的 4–5 个工具全在 ICL 插件里，不存在"全局旧工具混进来"。 |

---

## 7. "她晚上刷 B 站"长期测试的适配

这是用户真正的验收场景，不是"四个工具能跑"。

**可行的形态（C）**：
1. 傍晚收到"去刷吧"（可以是用户消息，也可以是 `time` 到点的唤醒）→ `focus_enter(kind:'bili')`。
2. 循环：`bili_feed` 拿热门/排行 → `bili_watch` 看标题/简介/字幕 → 值得的用原生 `video_storyboard`/`video_zoom` 看画面 → `bili_comments` 翻评论 → `memo_append` 记一条。
3. 结束：`focus_leave`，可见的"看过什么"留在 ICL memory（dream 可用）。
4. 夜间长测的观测：ICL transcript + `bili-eval` 的调用记录 + ICL memory；**不依赖旧插件的 duty.log/report**。

**必须提前解决的适配点**：
- **凭证过期**：当前账号凭证有效，但没有任何续期路径（§3.3-3）。C 的登录移植是长期测试的 P0，否则某天所有 B 站工具同时失效。
- **限速**：一次夜间刷 10–20 条 + 评论/字幕，B 站会开始 `-412`/`-509`。C 需要全局 ≥1 req/s + 指数退避 + 单轮上限；A 没有；B2 自己写。
- **耗时**：文字工具 2–4 s/次；宫格图首次 30–60 s（含下载/ffmpeg/ASR），缓存后 30 s 级。夜间"随便看看"可以用 `from/to` 限制窗口；不要默认全片。
- **空白/失败要可读**：搜索空 `bvid`、无字幕、`-412`、凭证失效——都要在工具文本里说清"发生了什么、下一步能做什么"，而不是把异常栈丢给模型。
- **别把"看视频"变成任务清单**：`prompts/sim.md` 已经写了"没有画面依据时不要假装看过"；C 不要再往全局提示词里加 B 站操作步骤（会与 `PROMPT-CONTRACT` 的"工具教学归 description"冲突）。

### 7.1 本机体检一页（2026-11-06，`--offline` / `--credential` + 失败模式实测）

> 本页只记录**结论和元数据**：没有打印、复制任何 cookie/token；cookies 文件只解析了到期列。用途：明早拍板时判断"这套接缝还能撑多久、先修哪一段"。

#### 7.1.1 凭证有效期（两套登录态，差 5 个多月）

| 登录态 | 签发/写入 | 到期 | 剩余 | 备注 |
|---|---|---|---|---|
| bilibili-api（搜索/字幕/评论；`$DSH_HOME/bili-duty/bili_credential.json`） | 2026-10-22 19:57 | **2027-04-20 19:57**（SESSDATA 内嵌时间戳） | ≈166 天 | 4 字段齐全（只记长度 222/32/46/16）；`--credential` 实测 `logged_in=true`（uid 脱敏） |
| yt-dlp / storyboard（切帧拉流；`~/.dsh/video.json` 的 `cookies` 指向的 cookies.txt） | 文件最后写入 2026-11-06 00:11（早于本次 frames 测试；本评估全程只读，未写入） | **2026-12-01**（SESSDATA / bili_jct / buvid3 / DedeUserID 四条同到期） | ≈25 天 | `b_nut` 到 2027-11-02（非鉴权）；`sid` 是会话 cookie |

- **结论 1**：文字类工具（search/watch/comments）按内嵌到期时间还能用约 5 个月；**切帧的登录态只剩约 25 天**。
- **结论 2**：2026-12-01 之后 storyboard 会转匿名——匿名最高 480P、1080P 可能根本不在格式列表里，而 `--allow-anonymous` 会把警告也吞掉（`src/fetch.js:271-291`）⇒ 夜里切帧会变糊。这件事独立于 ICL 凭证，必须在 12-01 前重新导出 cookies（或明确接受降级）。
  **已实现**：`bili_frames` 现在读 cookies 到期列并在缺失/过期/7 天内到期时把"会糊 + 本次匿名拉流"写进工具文本；**续期步骤见 `docs/VIDEO-EYES.md §10`**（含验证命令与安全注意）。
- **结论 3（重要）**：`bili_check_credential` **不能证明会话有效**。用伪造凭证（`sessdata` 乱写、`dedeuserid=1`）实测也返回 `logged_in=true`（uid=1 的公开用户信息本来就不需要登录），见 §7.3。真正的有效期信号只有 SESSDATA 内嵌时间戳 + 真实工具调用。

#### 7.1.2 依赖路径（`node tools/bili-eval.mjs --offline` = 5/5 通过）

| 检查 | 本机值 | 谁维护 | 备注 |
|---|---|---|---|
| python 解释器 `BILI_PYTHON` | `$DSH_HOME/bili-duty/.venv/Scripts/python.exe`（274 424 B） | **旧插件** | C 应改成 ICL 自己的 venv/解释器 |
| 桥接脚本 `BILI_RUNNER` | `C:/DSH/qwenstuff/icl/tools/bili-run.py`（1 661 B） | 旧仓库副本 | **默认 `ICL_ROOT` 指旧仓库**，实测加载的就是这一份；与 `C:/DSH/icl` 的副本只差 CRLF |
| bili-duty 家目录 `BILI_DIR` | `$DSH_HOME/bili-duty`（680+ 个文件） | **旧插件** | 里面是 `mcp_server.py` + `bili_credential.json` + duty.log/out/seen.md |
| storyboard CLI `STORYBOARD_CLI` | `.../node_modules/dsh-video-storyboard/bin/storyboard.mjs`（8 899 B） | desktop profile 的第三方插件 | C 打算"原生入口 + 兜底"，仍需此路径 |
| 凭证文件 | `bili-duty/bili_credential.json`（390 B，存在） | 旧插件登录页 | 内容未打印 |

坏路径对照（把 4 条 env 指到不存在路径）：`--offline` 0/5，逐条报"缺 `X` → 用 `Y` 指过去"；工具调用侧同样返回可操作文本（`packages/core/test/audit-regressions.test.mjs:248-273` 已锁）。

#### 7.1.3 失败模式（实测，除标注外均为本机只读复现）

| # | 场景 | 实测表现 | 对"夜里刷 B 站"的影响 | C 的处置 |
|---|---|---|---|---|
| 1 | 缺依赖路径 | `preflight()` 逐条说清缺哪个；`--offline` 0/5；工具回"缺 …" | 可诊断，不会静默 | 保留；换成 ICL 自己的配置项 |
| 2 | **无凭证**（temp BILI_DIR 只放 `mcp_server.py`） | `bili_search` **仍可用**（匿名，2.0 s 出结果）；`bili_watch`/`bili_comments` 失败，但插件层只回 `打不开：Command failed: <python> <runner> …` —— **真实原因（"未登录"）丢了** | 模型看到一条没有信息量的命令串，无法自救 | 错误归一化（解析 runner 的 `{"ok":false}` / stderr），给出"去登录/复制凭证"的下一步 |
| 3 | **凭证无效/过期** | `bili_check_credential` **假阳性** `logged_in=true`（伪造 sessdata + uid=1 → 返回 "bishi"）；`bili_subtitle` 回 `{"message":"该视频没有字幕"}`（实际可能是鉴权失败）；`bili_video_info` 可能照常成功 | "看起来还活着，字幕/评论突然没了"；长期测试会误判为"视频没字幕" | 不信 `logged_in`；用 SESSDATA 到期 + 真实调用探针；subtitle 的失败与空结果分开上报 |
| 4 | **storyboard cookies 过期/缺失** | 按代码语义是**匿名降级**而非报错（`src/fetch.js:271-291`）；`allowAnonymous` 只关警告 | 画面变糊且无信号；2026-12-01 后必现 | ✅ 已实现：`bili_frames` 读到期列并显式提示"会糊/本次匿名"；runbook 见 `docs/VIDEO-EYES.md §10` |
| 5 | **B 站风控 `-412`/`-509`** | 旧插件 `duty.log` 有 `-509 请求过于频繁` 实例（2026-10-29T13:43:55）；本次**没有主动触发**（不骚扰 B 站） | 无退避时一次失败就结束；夜间连续 10–20 次调用会踩 | ✅ 已实现：同一插件实例调用串行 + 最小间隔 1.2 s；`E_RATE_LIMIT`/`E_TIMEOUT`/`E_NETWORK` 指数退避重试 2 次（1.5→3 s，抖动）；`E_AUTH` 不重试 |
| 6 | **空 bvid / 无字幕** | `bili_search` 第 3 条 `bvid:""`（实测）；subtitle 空结果回"该视频没有字幕" | 空 bvid 传给 watch 会变成无意义报错 | search 清洗空卡片；watch 对空 bvid 直接给可操作错误；区分"无语音"与"鉴权失败" |
| 7 | **路径漂移** | 默认 `ICL_ROOT` 指向旧仓库（§7.1.2），换机/清理旧仓库即坏 | 夜间长测可能在某次重启后全废 | 配置化 + 启动自检（`--offline` 语义） |

#### 7.1.4 对明早拍板的意义（三行）

1. C 的 §8 顺序不变，但**"登录/续期"是 P0**；另外切帧 cookies 要在 **2026-12-01 前**重新导出（或明确接受匿名 480P）。
2. "凭证是否有效"不能再看 `bili_check_credential.logged_in`（假阳性）；用 SESSDATA 到期 + 真实调用。
3. 失败模式 #2/#3 不是美化问题——**当前接缝坏掉时给的是误导性文本**，C 的错误归一化是长期测试的必要条件，不是锦上添花。

---

## 8. 路线 C 迁移步骤草案（不写实现）

> 目标：今天能跑的接缝 → 1–2 人日后"仓库自持、只读、可长期测"的接缝。

1. **冻结现状**（0.5 h）：跑 `node tools/bili-eval.mjs --credential`，把 §3.2 的结果贴进 PR；跑 452 测试。
2. **vendor 收编**（0.5 人日）：
   - 从旧插件复制 `vendor/bilibili-mcp/mcp_server.py`（MIT）与 `LICENSE` 到 `packages/plugins/bili/vendor/bilibili-mcp/`，加 `NOTICE` 与 `PATCHES.md`（抄 `mcp_server.py:10-16` 的 5 处本地修改清单，逐条标明来源）；
   - `tools/bili-run.py` 改为从**仓库内** vendor 路径导入，并加 `ALLOWED = {'bili_search','bili_video_info','bili_subtitle','bili_comments','bili_hot_videos','bili_rank','bili_weekly_hot','bili_hot_buzzwords'}`；不在名单里的函数直接拒绝（返回结构化错误）；
   - 凭证目录改为 ICL 自己的 `<stateDir>/bili/`；首次迁移时复制现有 `bili_credential.json`（只复制文件，不打印内容）。
3. **工具面**（0.5 人日）：
   - 新增 `bili_feed`（热门/排行/每周/热词，参数 `kind` + `num`），描述写清返回字段；
   - `bili_frames` 描述把 `read_file` 改成 `read_image`，并加一句"图不会自动出现在消息里"；在 storyboard 可用的环境优先用原生 `video_storyboard`；
   - `bili_search` 清洗空 `bvid`，`bili_watch` 对空 bvid 直接给可操作错误；
   - 保持 `manifest.tools` 精确（工具面 = 5 个以内，`when/avoid` 自足）。
4. **登录与恢复**（0.5 人日）：移植 `lib/login.mjs`（passport QR + Set-Cookie 解析 + 原子写），放到 ICL 自己的凭证文件；加一个只读 `bili_login_state` 工具（或让 `bili-eval --credential` 常查）。第一阶段也可以先不移植，只在文档给出"凭证过期后如何重扫"的命令，但这会卡住无人值守长测。
5. **测试与文档**（0.5 人日）：
   - 契约测试：mock `bili-run.py` 输出（成功/空 bvid/无字幕/-412/凭证失效/白名单拒绝），**不打真网络**；
   - 保留 `tools/bili-eval.mjs` 作为手动/夜间冒烟；
   - 更新 `docs/PLUGINS.md` 的 bili 节（路径/工具/状态/环境变量），把 desktop profile 那条过期注释单独记录为"待用户侧清理"（不改用户 profile）。

**不建议在 C 里做**：启用旧插件、搬它的调度器、搬它的 duty.md、注册任何写工具。

---

## 9. 验收标准

**通用（A/B/C 都要）**：
1. `node --test packages/core/test packages/mc-body/test packages/plugins/mc-link/test` = 452 pass（本 worktree 基线；lead 合并到 master 后为 474 绿。注：任务里写的两个目录实测是 396；452 需加 `packages/plugins/mc-link/test`）。
2. `node tools/bili-eval.mjs --credential` = 11/11 通过（只读；不产生任何 B 站写操作）。
3. ICL 会话的工具面里 `bili_*` 数量 ≤ 6，且没有 `reply|upload|send|dynamic` 命名的工具（`sandbox-and-seams.test.mjs` 同款断言）。
4. 换机/换仓库路径时，只改 `pluginConfig.bili`（或 4 个 env）就能跑；失败信息指出"缺哪一条、怎么补"（沿用现有 `preflight` 风格）。
5. 任意一次 B 站工具失败都不会泄露 cookie/token/账号昵称到工具结果。

**C 特有**：
6. `bili-run.py` 的只读白名单有单测：调 `bili_reply`/`bili_upload_video` 会被拒绝，且错误可读。
7. `bili_feed` 打真网能返回 ≥1 条热门 + 排行榜；无凭证时也能工作（或明确报"需要登录"）。
8. 凭证失效时，`bili_search`/`bili_watch` 返回"凭证失效，下一步重扫/复制"的可操作文本，而不是异常栈。
9. 夜间长测场景（C）：`focus_enter(kind:'bili')` → 3 条视频（feed+watch+comments）→ memo 一条 → `focus_leave`，全程 ≤ 10 min、无写操作；transcript 可读。
10. `docs/PLUGINS.md` 的 bili 节与代码一致（工具数、路径、env、状态）。

**A 特有**（若选 A）：启用后 ICL 会话工具面不出现 `bili_reply`/`bili_send_message` 一类写工具；旧插件调度器与 `dmWatch` 关闭；否则不通过。

**B 特有**（若选 B2）：断网时全部工具给可操作错误；WBI 签名有 fixture 测试；无 Python 时安装流程零外部运行时。

---

## 10. 需要拍板的点（给 lead / 用户）

1. **走 C 吗？** 如果同意，下一步是"第 8 节步骤 1–5"，1–2 人日；我先做研究收尾，等指令再动产品代码。
2. **"刷热门"的语义**：是"B 站首页热门/排行榜"（`bili_hot_videos`/`bili_rank`，vendor 现成），还是"按她的兴趣推荐流"（需要自己算，vendor 里没有）？前者 C 直接做；后者要另设计。
3. **登录续期的责任**：凭证过期后谁去扫？给 ICL 一个扫码工具（C 的步骤 4），还是继续用旧插件设置页（需要重新启用旧插件，会引入 A 的副作用）？
4. **切帧的归属**：用已安装的 `dsh-video-storyboard`（宿主级工具、图直接进模型）作为唯一入口，还是保留 `bili_frames` 作为兜底（多一条 CLI 路径与一个硬编码项）？我倾向"原生优先，bili_frames 兜底"。
5. **旧插件的去留**：desktop profile 里它现在 `disabled: true` 且注释是过期的（提到不存在的 `bili_feed/bili_reply`）；是否由用户侧清理那条注释/是否保留安装（不影响 C，但会误导后来人）。

### 10.1 lead 技术判断（2026-11-06，**待用户最终确认**，不是产品决策）

1. 路线 C 认可为推荐项，但**今晚不开工**，等用户确认 A/B/C。
2. "刷热门"第一版 = **现成的首页热门/排行榜**（vendor 已有、行为可预期）；"按兴趣推荐流"作为后续，不做。
3. 登录续期倾向**给 ICL 自己的扫码/续期工具**（不启用旧插件设置页，避免把旧插件的自动化写路径带回来）；凭证放 ICL `stateDir`。
4. 切帧：**原生 `dsh-video-storyboard` 为唯一入口**，`bili_frames` 保留为兜底（描述改成 `read_image`/正确的读图方式）。
5. desktop profile 的旧注释**不动用户 profile**，等用户自己决定。

> 以上是技术判断；§10 的 5 个问题仍以用户明早的最终决定为准。若用户批准 C，按 §8 开工（其中登录/续期与错误归一化是 P0，见 §7.1.4）。

---

## 11. 实施状态（2026-11-06：C 路线最小可跑已落地）

用户 2026-11-06 批准 C 路线。本节记录**已经做了什么**（与 §8 草案对应），别把"计划"当成"现状"。

**已落地**

| 项 | 落点 | 验证 |
|---|---|---|
| vendored MCP 收编（MIT + NOTICE + PATCHES） | `packages/plugins/bili/vendor/bilibili-mcp/`（含 `LICENSE`、`NOTICE.md`、`PATCHES.md`、`mcp_server.py`、`requirements.txt`） | `npm test` 的 bili 单测 + `bili-eval` 真网络 |
| 只读白名单 | `tools/bili-run.py` 的 `ALLOWED`（8 个读函数）；写函数（reply/send/upload/dynamic/opus/favorite/login…）一律 `E_READ_ONLY` | `packages/plugins/bili/test/bili.test.mjs` 用真 Python 跑 `--list` 与拒绝路径 |
| 凭证归 ICL | `<stateDir>/bili/bili_credential.json`，首次从旧家目录**复制一次**（只复制文件、不读内容） | 单测 `凭证迁移`；`bili-eval` 在临时 stateDir 实测 |
| `bili_feed`（热门/排行/每周/热词） | `packages/plugins/bili/src/index.mjs`，接 vendor 的 `bili_hot_videos`/`bili_rank`/`bili_weekly_hot`/`bili_hot_buzzwords` | 单测 + 真网络（1.4 s 拿到 3 条热门） |
| 扫码登录/续期 | `src/login.mjs`（passport QR + Set-Cookie + 原子写）；走 host 的 `ctx.fetch`（插件不直接发 HTTP） | 单测用假 fetch 验证 key/poll/写盘/到期解析 |
| 错误归一化 | `src/runtime.mjs`：`E_AUTH` / `E_RATE_LIMIT` / `E_TIMEOUT` / `E_NETWORK` / `E_TOOL` / `E_PREFLIGHT` / `E_EMPTY`，每种带"下一步" | 单测 + `bili-eval` |
| `bili_frames` 图进模型 | 返回 `{text, images:[png]}`，由 `dsh-icl` 桥接层 `ctx.attachments.saveImage()` 变成 image block | 单测（假 CLI）+ 桥接层单测 |
| 搜索空 bvid 清洗 | `formatSearch` 丢掉无 `bvid` 卡片 | 单测 |
| **解释器归 ICL**（2026-11-06 收尾） | 默认 `<stateDir>/bili/.venv`（Windows `Scripts/python.exe`），不存在时**兼容回退**旧插件 venv；`BILI_PYTHON`/`config.pythonPath` 仍可覆盖；`pythonSource` 会写进日志/eval | **已实建**（2026-11-06）：`--check` 显示 `pythonSource=icl`；`bili-eval --offline` 10/10；另有单测 `venv 解析` |
| **限速/退避**（2026-11-06 收尾） | 同一插件实例的只读调用**串行**、最小间隔默认 1.2 s；`E_RATE_LIMIT`/`E_TIMEOUT`/`E_NETWORK` 指数退避重试 2 次（1.5→3 s，带抖动）；`E_AUTH`/`E_READ_ONLY` 等**不重试** | 单测 `限速/退避`、`串行且至少间隔` |
| **切帧降级提示**（2026-11-06 收尾） | `bili_frames` 读 `~/.dsh/video.json` + cookies 的**到期列**（不打印值）；缺失/过期/7 天内到期时文本明确写"会糊"，并识别 CLI 的 `auth=anonymous` 再补一条降级说明 | 单测 `storyboard cookies`、`bili_frames` 匿名降级 |
| 通用视频浏览器（另开） | `packages/plugins/video` + `docs/VIDEO-EYES.md`；本地路径/QQ 落盘/MC 录屏都走 `video_open` | `packages/plugins/video/test` |

**还没做（顺序即优先级）**

1. **venv 已建到 ICL stateDir**（2026-11-06 实建成功，见 §11.1）；旧 venv 保留可回退。live desktop 需要合并/重启后才会真正用到新 venv。
2. **限速/退避的线上观察**：代码与单测有了，还没在真实夜间连刷里量化（建议第一次长测记录重试次数/耗时）。
3. **storyboard cookies 续期**：runbook 写在 `docs/VIDEO-EYES.md §11`；`bili_frames` 现在会把"匿名降级/即将到期"明说，但 cookie 本身仍要用户/运维重新导出。
4. **ASR 配置入口**：只在 `docs/VIDEO-EYES.md §12` 做了可行性设计（8088 的 `whisper-asr` + storyboard 的 OpenAI `/audio/transcriptions` 契约）；**没有写用户 `asr.json`，也没有调用推理**。
5. **desktop profile 旧注释**：按 lead 判断不动用户 profile；需要用户自己决定是否清理。
6. **DSH 桌面加载新版本**：本 worktree 的改动要合并/安装并重启 desktop 才会在真实 ICL 会话里生效（本轮没重启）。

### 11.1 venv 迁移步骤（可回退）

```bash
# 1) 看当前解析到哪（不写任何东西）
node tools/bili-venv.mjs --check
#    -> 现在应为：ICL python ✗（还没建）· 旧 venv ✓ · 来源 legacy-compat

# 2) 建 ICL 自己的 venv（默认 <ICL stateDir>/bili/.venv；会联网装 4 个依赖）
node tools/bili-venv.mjs --create
#    指定 base python：node tools/bili-venv.mjs --create --python C:\Python312\python.exe

# 3) 重启 ICL 会话后再看一次：python 来源应变成 icl
node tools/bili-venv.mjs --check
node tools/bili-eval.mjs --offline
```

- 旧 venv **不删**；新 venv 建好后默认优先用它。要回退：删 `<stateDir>/bili/.venv`（或临时设 `BILI_PYTHON=<旧 venv python>`）。
- venv 不可重定位，所以是"新建 + 重装依赖"，不是 move；`--create --force` 会删掉 ICL venv 重建（不碰旧 venv）。
- 凭证 (`<stateDir>/bili/bili_credential.json`) 和代码（repo vendor）与 venv 解耦，迁移期间不需要重新扫码。

**实建结果（2026-11-06）**

```text
$ node tools/bili-venv.mjs --create
== venv 已存在 ==   C:\Users\ai_admin\.dsh\icl\state\bili\.venv
依赖不全（上次可能失败过），继续装依赖。
== 装依赖：uv + 清华镜像（C:\Users\ai_admin\.dsh\bili-duty\bin\uv.exe） ==
...  (bilibili-api-python / aiohttp / mcp<2 / qrcode[pil] 及其依赖)
完成：C:\Users\ai_admin\.dsh\icl\state\bili\.venv\Scripts\python.exe
deps ok

$ node tools/bili-venv.mjs --check
ICL python  C:\Users\ai_admin\.dsh\icl\state\bili\.venv\Scripts\python.exe ✓
当前解析    ...（来源 icl）
```

**踩到的坑（已修进脚本）**：直接用 `pip install -r vendor/.../requirements.txt` 会因文件带中文注释、Windows 下被 pip 按
cp1252 解码而 `UnicodeDecodeError`（本次第一次 `--create` 就是这样失败的）。脚本现在先把 requirements 剥成纯 ASCII
临时文件，并优先用 `uv`（旧插件家目录那份）+ 清华镜像；失败再退 pip 镜像、默认 PyPI。以后换机同样适用。

**证据命令**

```bash
npm test                 # 见文末 §11.2 的最新计数
node tools/bili-eval.mjs --credential   # 只读；不打印 cookie/token
node tools/bili-eval.mjs --offline      # 路径/工具面/解释器来源/cookies 到期，不联网
```

### 11.2 本轮收尾的验证结果（2026-11-06）

- `npm test`：**672 pass / 0 fail**（master 合并后全量；含 bili 15 + video 5 + 桥接图片用例）。
- `node tools/bili-venv.mjs --check`：**已实建**，`pythonSource=icl`（`<ICL stateDir>/bili/.venv`）；旧 venv 仍保留可回退。
- `node tools/bili-eval.mjs --offline`：路径/工具面/解释器来源/cookies 到期 **10/10**（`python 解释器（来源 icl）`）。
- `node tools/bili-eval.mjs --credential`：真网络只读 **14/14**；`--frames` 追加一次为 **15/15**（cookies 有效、走 `auth=cookies`）。
- 未做任何 B 站写操作；未启动 lab/GUI/desktop；未调用 ASR 推理（只读 endpoint 契约与模型列表）。

#### 限速实测（2026-11-06，只读 search/feed；默认 `minIntervalMs=1200, maxRetries=2`，`pythonSource=icl`）

连续 8 次交替调用 `bili_search` / `bili_feed`（真实网络、只读；未制造 `-412/-509`，所以**没有触发退避重试**）：

| # | 工具 | 本次耗时 ms | 距上次开始 ms |
|---|---|---|---|
| 1 | `bili_search` | 2376 | 0 |
| 2 | `bili_feed` | 1402 | 2376 |
| 3 | `bili_search` | 1737 | 1402 |
| 4 | `bili_feed` | 1250 | 1737 |
| 5 | `bili_search` | 2234 | 1250 |
| 6 | `bili_feed` | 1272 | 2234 |
| 7 | `bili_search` | 2444 | 1272 |
| 8 | `bili_feed` | 1496 | 2444 |

汇总：耗时 **1250–2444 ms**，开始间隔 **1250–2444 ms（avg 1816 ms）**，8 次全部 ok；总墙钟约 **15.7 s**。

解读（对桌面/长测有用的结论）：
- 调用**严格串行**，没有并发重叠；单条接口本身就要 1.2–2.4 s，所以 1.2 s 的"最小间隔"这次没有额外加等待
  （间隔≈上一条的耗时）；如果 B 站响应变快（<1.2 s），节流才会成为下限。
- 没有触发退避（未主动打 `-412/-509`）。退避路径由单测覆盖：失败 2 次→第 3 次成功、等待递增；`E_AUTH` 只调 1 次。
- 按这个节奏，一轮"3 条视频（search + watch + comments ≈ 7 s）+ 滑动"约 10–15 s，远低于风控区；
  夜间长测不需要额外降速，但**不要**并发调用或跳过 caller 直接刷 runner。

### 11.3 限速/退避长测（2026-11-06，25 次只读 search/feed）

配置：默认 caller（`minIntervalMs=1200`、`maxRetries=2`、`retryBase 1.5s`、`pythonSource=icl`），**单会话串行**。
序列：25 次交替 `bili_search` / `bili_feed`（只读，不写、不互动；没有主动制造 429）。

| 指标 | 结果 |
|---|---|
| 调用数 / 失败 / 重试 | **25 / 0 / 0** |
| 单次耗时 | min **1301 ms** · max **2818 ms** · avg **1875 ms** |
| 开始间隔 | min **1301 ms** · max **2818 ms** · avg **1880 ms** |
| 总墙钟 | ≈ **92 s**（25 次，含 24 个间隔） |
| 触发过的错误码 | 无（没有 `-412/-509`，没有 timeout/network） |

间隔明细（ms）：1745, 1301, 1617, 1905, 2543, 1480, 1961, 1863, 2818, 1714, 1740, 2390, 2359, 1423, 1823,
1553, 1727, 1412, 1836, 1772, 2469, 2243, 1924, 1491。

**结论（写进长测纪律）**：
1. 这个速率（≈0.53 req/s）连续 25 次无风控。**夜间不要并发**：并发/多会话会把实际速率成倍放大，且 caller 的串行只在
   **单个插件实例**内成立；ICL 设计上单会话，别在外部再起第二个去刷同一片。
2. `-412/-509` 一旦出现，caller 会按 1.5→3 s 退避重试 2 次；仍失败就停这一轮，把 `E_RATE_LIMIT` 的可操作文本交给模型
   ——不要在同一轮里继续硬刷。长测第一晚建议记录 retry 次数（`bili.retry` 日志）。
3. B 站响应本身 ≥1.2 s，所以"最小间隔"当前不是瓶颈；**不要为了省时间把 `minIntervalMs` 调到 0**（响应变快时就没有下限了）。
4. 搜索/热门是匿名也可用的接口，重试不会放大账号风险；但仍按上面的节奏走，别用重试掩盖真正的网络/风控问题。

---

## 附录 A：证据索引（文件:行）

**旧插件 `dsh-bili-scroll`**（`%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-bili-scroll`）：
- `package.json:57-69`（bundle patch + client inject）、`cordis.patch.yml:15-19`
- `index.js:38-39`（name/inject）、`index.js:49-103`（Config schema）、`index.js:512-694`（11 个工具）、`index.js:1036-1044`（headless 白名单）、`index.js:1046-1099`（overlay 写 MCP 配置）、`index.js:1157-1237`（spawn headless）、`index.js:1245-1274`（60 s tick）
- `lib/mcp.mjs:18-119`（迷你 MCP 客户端）、`lib/login.mjs:53-88`（扫码登录/凭证）、`lib/state.mjs:24-27`（窗口）、`:35-49`（家目录）、`:60-75`（铺文件）、`:98-130`（章程升级）、`lib/verify.mjs`、`lib/dm.mjs`、`lib/asr.py`
- `vendor/bilibili-mcp/mcp_server.py:10-16`（本地补丁清单）、`:40-53`（工具白名单）、`:265-311`（search）、`:313-383`（comments）、`:385-444`（subtitle）、`:474-511`（video_info）、`:513-569`（reply）、`:677-1010`（dynamic/upload/opus）、`:1029-1150`（hot/rank/weekly/buzzwords）
- `vendor/bilibili-mcp/requirements.txt:1-8`
- `prompts/duty.md`（178 行）、`client.js:796-826`、`selfcheck.mjs:34-119`、`README.md:108-121`（怎么跑）、`:138-141`（依赖/致谢）

**`dsh-video-storyboard`**（同目录）：
- `dsh.plugin.json:5-10`、`package.json:27-41`、`src/index.js:7-12,24,46-61,135-143,196-199`、`src/tool-spec.js:14-37`、`src/fetch.js:25,249-291`、`README.md:20-47`、`README.zh.md:22-36`

**我们的仓库**：
- `packages/plugins/bili/src/index.mjs:10-15`（4 条硬编码路径）、`:22-35`（preflight）、`:37-48`（callTool）、`:68-179`（4 工具）、`:150-158`（frames CLI 参数）、`:169-177`（vision + imagePath）
- `packages/plugins/bili/manifest.json:5`；`tools/bili-run.py:31-43`；`tools/bili-eval.mjs`（新增，仅评估）
- `packages/core/src/dsh-contract.mjs:59-68`（imagePath → 文本）、`:81-84`（output schema 只有 text）
- `packages/core/src/services.mjs:17-39`（description 拼装/预算）、`:255-292`（工具注册）、`:161-206`（surface）
- `packages/dsh-icl/src/bootstrap.mjs:42-74`（插件装配）、`packages/dsh-icl/src/config.mjs:9-12`（默认插件清单）、`packages/dsh-icl/presets/icl.patch.yml:15-18`（preset 只挂 icl-core/tool-todo/tool-persona）
- `prompts/sim.md:48-51`（看视频纪律）；`docs/PROMPT-CONTRACT.md:7-20`、`:31-35`；`docs/FOCUS.md:17-19`、`:40-41`；`docs/DSH-INTEGRATION.md:146-154`
- `docs/PLUGINS.md:174-179`（bili 节）、`:187-190`（4 条路径）、`:196-208`（子进程/失败）
- 测试：`packages/core/test/sandbox-and-seams.test.mjs:36-44`、`packages/core/test/audit-regressions.test.mjs:248-273`、`packages/core/test/dsh-bridge.test.mjs:620-630`
- 用户 profile（只读引用）：`~/.dsh/profiles/desktop/cordis.patch.yml:199-214`（storyboard + bili-scroll disabled 及过期注释）、`~/.dsh/profiles/desktop/package.json`（dsh-icl link 到 `C:/DSH/icl`）
- DSH 安装包（只读引用）：`@deepseek-ai/dsh-base/cordis.patch.yml:281-282`（tool-fs 全局）、`@deepseek-ai/dsh-web-app/presets/standard.patch.yml:26-27`（tool-fs 在 standard preset 的重复声明）、`@deepseek-ai/dsh-tools/lib/index.js:2633-2634,2659-2662`（per-agent 遮蔽全局）

## 附录 B：实测记录（2026-11-06，只读）

| 调用 | 结果 |
|---|---|
| `bili_check_credential` | `logged_in=true`（uid 脱敏；未打印任何 cookie/token） |
| `bili_search {"keyword":"DeepSeek Harness","num":3}` | 2.0 s；3 条；第 3 条 `bvid:""`（空卡片） |
| `bili_video_info BV1L7xm64EHP` | 1.4 s；标题/UP/时长 1537 s/stat 齐全 |
| `bili_subtitle BV1L7xm64EHP` | 1.8 s；837 段、中文；全文可读 |
| `bili_comments BV1L7xm64EHP num=3` | 2.1 s；3 条含楼中楼 |
| `bili_hot_videos ps=3` | 1.6 s；3 条热门（含 bvid/title/author/play） |
| `bili_rank all day=3` | 1.6 s；100 条排行榜 |
| `bili_hot_buzzwords page_size=5` | 2.4 s；热搜词可用 |
| `bili_frames BV1dC4y117Rz from=0 to=10 cells=4` | 28.6 s（缓存命中）；360P 0.9 MB；4 格 + 时间线；sheet 365 KB |
| `tools/bili-eval.mjs --credential` | 11/11 通过 |
| 测试 | core 362 + mc-body 34 + mc-link 56 = **452 pass**（本 worktree；lead 合并后 master 474 绿） |
| 无凭证（temp `BILI_DIR` 只有 `mcp_server.py`） | `bili_search` 仍可用（匿名 2.0 s）；`bili_watch`/`bili_comments` 失败，插件层只回 `打不开：Command failed: <python> <runner> …`（真实原因丢失） |
| 伪造凭证（temp，`sessdata` 乱写、`dedeuserid=1`） | `bili_check_credential` **假阳性** `logged_in=true`；`bili_subtitle` 回 `{"message":"该视频没有字幕"}` |
| 坏路径（4 条 env 指向不存在路径） | `--offline` **0/5**，逐条报缺哪个、怎么补 |

## 附录 C：登录态与安全（只记录位置与处理方式，不记录内容）

- **bilibili-api 凭证**：`$DSH_HOME/bili-duty/bili_credential.json`（4 字段：sessdata / bili_jct / buvid3 / dedeuserid；`lib/login.mjs:78-88`）。**本文不复制、不打印其内容**；C 迁移时只做文件级复制到 ICL 自己的 stateDir。
- **yt-dlp cookies**：由 `~/.dsh/video.json` 的 `cookies` 字段指向一份 Netscape `cookies.txt`（storyboard 读它拉流）。本次**只解析了它的到期列**（cookie 名 + 到期时间戳，见 §7.1.1），**没有读取/打印任何 cookie 值**。
- **写操作红线**：本轮没有调用任何 B 站写接口（评论/私信/上传/动态/收藏），也没有开启旧插件的调度或私信监听。
- **C 的约束**：`bili-run.py` 只读白名单 + 不注册任何写工具；迁移时若发现 `BILI_DIR` 指向用户旧插件目录，直接报"请迁移到 ICL 自己的状态目录"。
