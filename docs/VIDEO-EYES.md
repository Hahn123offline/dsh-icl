# 通用视频浏览器（eyes）—— 她的"眼睛"

> 状态：**最小实现已落地**（2026-11-06，wt/bili）。工具在 `packages/plugins/video`，桥接层的图片通道在
> `packages/core/src/dsh-contract.mjs` + `packages/dsh-icl/src/bridge.mjs`。
> 定位：**本地视频的通用入口**，不依赖 B 站、不依赖 QQ；B 站专用能力仍在 `packages/plugins/bili`。
> **启用范围**：lab preset 已挂载（`icl-lab`/`icl-mc-lab`）；**产品 preset 待用户批准**（当前只在 lab 可用，desktop 未启用）。

---

## 0. 一句话

给她一个"打开任何本地视频就能真看到画面"的工具层：**输入永远是本地绝对路径**（QQ 落盘、MC 录屏、用户自己的片），
输出是**图片附件**（DSH `ImageAttachmentRef`）+ 一份可引用的时间/格位清单；网络链接不在这里下载。

---

## 1. 边界：通用 vs B 站专用 vs DSH 原生

| 能力 | 归属 | 说明 |
|---|---|---|
| 本地文件/目录的视频浏览（打开、分镜、回看、定位、单帧） | **本插件 `video_*`** | 输入本地绝对路径；QQ 落盘/MC 录屏都走这里 |
| B 站在线数据（搜索/播放页/字幕/评论/热门/排行） | `packages/plugins/bili` | 只读；见 `docs/BILI-FEASIBILITY.md` |
| B 站 URL 的画面（兜底） | `bili_frames` 或 DSH 原生的 `video_storyboard` | 原生工具支持 `input: "https://www.bilibili.com/video/BV…"`，图直接进模型 |
| 任意网络视频 | DSH 原生 `video_storyboard`/`video_zoom` | 本插件**不**处理 http(s)，避免造一个隐形的下载器 |

**为什么分家**：通用入口如果接受 URL，等于给模型一个"任意 URL 下载 + ffmpeg 解码"的入口（安全/成本/审计都不可控）；
B 站有专门的凭证、限速与错误语言（`E_AUTH`/`E_RATE_LIMIT`），混在一起会让两边的失败都说不清。

---

## 2. 架构

```
QQ 入站（qq 插件） / MC 录屏 / 用户文件
        │  本地绝对路径（或目录）
        ▼
video_open / video_storyboard / video_zoom / video_locate / video_frames / video_probe   （ICL 工具层）
        │  execFile(node, [storyboard CLI, …]) / execFile(ffmpeg, …)
        ▼
dsh-video-storyboard 的 CLI（分镜/切点/选帧/ASR/缓存） + ffmpeg/ffprobe
        │  产出 PNG（+ manifest.json / 文本清单）
        ▼
工具返回 { text, images: [png 绝对路径] }
        │  dsh-icl 桥：ctx.attachments.saveImage({ data, mediaType, name })
        ▼
DSH ImageAttachmentRef → 模型收到 image content block（和 qq 图片通道同一机制）
```

要点：

- **视频字节永不进正文**：模型只拿到路径摘要（时长/分辨率/大小）+ 图片附件 + 文本清单。
- **图片由桥接层统一提交**：插件只写 PNG 到 workDir，桥读文件 → `ctx.attachments.saveImage()` →
  `output.render` 返回 `{type:'image', attachment}`。没有附件服务时**降级成文本路径**（测试/老宿主），
  不会假装"图已经在上下文里"。
- 图片在工具返回后还要被桥读取，所以 workDir 里的 PNG **不立刻删**；`stateDir/video/work/` 下超过 24h 的目录在下次启动时清理。

---

## 3. 工具清单

所有工具都只读本地文件、不出网。参数里 `path` 是**绝对路径**（Windows 例 `C:\videos\a.mp4`）。

| 工具 | 参数 | 返回 | 何时用 |
|---|---|---|---|
| `video_probe` | `path` | 时长/分辨率/fps/编码/音轨/字幕轨/大小 | 第一次拿到视频，先知道多长、值不值得看 |
| `video_open` | `path` + `overview`(默认 true) `from` `to` `cells` | 目录：视频清单；文件：元数据 + 概览宫格图 + 清单 | **通用入口**：QQ 视频落盘、MC 录屏、用户丢来的片 |
| `video_storyboard` | `path` + `from` `to` `cells`(1-16) `sheets`(1-4) `detail` `textOnly` | 宫格图（最多 4 张）+ 可引用格位清单 | 看一段时间里"发生了什么" |
| `video_zoom` | `path` + `from` `to` `cells`(1-9) `minGap` | 更少、更大的格子 | 清单里某一格要看清楚（脸/字幕/画面里的字） |
| `video_locate` | `path` + `query` + `from` `to` `max` `transcriptFile` | 命中格位 + 时间码 + 台词片段（**不出图**） | 知道说了什么、不知道在第几分钟 |
| `video_frames` | `path` + `times`(1-6 个秒数) 或 `at`(单个秒数) | 单帧图 / 多帧拼成一张（行优先）+ 时间映射 | 精确某一帧、或对比几个时间点 |

**推荐用法**（写进工具 description，不写进全局提示词）：

1. 拿到路径 → `video_open`（元数据 + 概览图）。
2. 有关键段 → `video_zoom`。
3. 知道台词 → `video_locate`（先用 `video_storyboard` 建缓存，或传 `transcriptFile`）。
4. 精确时刻 → `video_frames`。

---

## 4. 输入来源与约定

| 来源 | 传入什么 | 谁负责落盘 | 现状 |
|---|---|---|---|
| 本地文件 | 绝对路径（文件） | 用户/其他工具 | ✅ |
| 本地目录 | 绝对路径（目录）→ 列视频（按 mtime 新→旧，最多 20）+ 下一步 | 用户 | ✅ |
| **QQ 入站** | **绝对路径**（QQ 把文件落盘后把 `[视频已保存：<绝对路径>]` 追加进正文） | qq 插件 | ✅ 已对齐（见 §4.1） |
| MC 录屏/截图（后续） | 绝对路径 | mc-link / body 录制（未实现） | 📋 预留同一入口 |
| B 站下载 | **不传 URL**；用 `bili_frames` / DSH 原生 `video_storyboard` | bili 插件 | ✅ 分家 |

### 4.1 与 QQ 的接口（2026-11-06 qq 确认）

- 根目录：QQ 的 `mediaInboxDir`，推荐 `.state/media/inbox/qq`（实际取 state 文件同级 `media/inbox/qq`）。
- 单文件：`<root>/<YYYY-MM-DD>/<messageId>-<sender>-<ISO时间戳>-<index>.mp4|webm`
  （魔数嗅探 mp4/webm；默认 ≤50 MB/个、≤1 个/条；仅 http(s)，拒私网/凭据 URL）。
- 索引：`<root>/index.jsonl`，一行一个 `{at, kind, path, bytes, mime, messageId, peerId, sender, originalName}`。
- **视频浏览器不读索引**：模型正文里已经有绝对路径，`video_open {path}` 直接接住即可。
- 保留：默认 7 天（**不自动删**，只记 `mediaRetentionDays`）。视频浏览器**不复制原视频**，
  只在自己的 `stateDir/video/work/` 写 PNG/manifest 并 24h 清理；原文件删不删由 QQ 保留策略决定。
  风险：如果 7 天后原文件被删，再 `video_open` 会得到 `E_NOT_FOUND`（可操作，不会静默）。
- **临时目录约定**：QQ 不需要为视频浏览器做特殊清理；两边都按"路径可能失效"处理即可。

---

## 5. 大小/时间限制（默认值，可配）

| 限制 | 默认 | 位置 |
|---|---|---|
| 单文件大小 | 8 GiB（`E_TOO_BIG`） | `video.maxFileBytes` |
| 目录列举 | 20 个/次 | 工具内部 |
| 宫格图 | 每张 ≤16 格、≤4 张 | 参数校验 |
| 抽帧 | 每次 ≤6 帧，多帧拼一张（每格约 360px 高） | `times` 校验 |
| 单次 CLI/ffmpeg | 15 分钟（超时 `E_TIMEOUT`） | `runStoryboard` / `extractFrames` |
| 图片附件 | DSH 默认：单图 20 MB、单批 20 张/200 MB、8192px | DSH `attachment-local` 默认配置（不由本插件放大） |
| 临时产物 | `stateDir/video/work/` 24h 清理 | `pruneWorkDirs` |
| 网络 | **不出网** | 工具层拒绝 http(s) 路径 |

---

## 6. 失败码（工具文本里出现，模型可据此决定下一步）

| code | 触发 | 下一步 |
|---|---|---|
| `E_NOT_FOUND` | 路径不存在（QQ 可能还没落完/已过期） | 确认路径；等下载完成；重新向发送方要 |
| `E_REMOTE_URL` | 传了 http(s)/www | B 站用 `bili_*`；其他网络视频用 DSH 原生 `video_storyboard` |
| `E_IS_DIR` | 该用 `video_open`（目录）却用了别的工具 | 改 `video_open`，或指到具体文件 |
| `E_TOO_BIG` | 超过 8 GiB | 截一段/转码，或调大 `video.maxFileBytes` |
| `E_NOT_VIDEO` / `E_PROBE` | ffprobe 读不出视频流 | 确认是视频文件；不是就换文件 |
| `E_NO_CLI` | 没有 storyboard CLI | 装 `dsh-video-storyboard`，或 `ICL_STORYBOARD_CLI` 指 `bin/storyboard.mjs` |
| `E_FFMPEG` / `E_NO_FFMPEG` | ffmpeg/ffprobe 缺失或失败 | 装 ffmpeg 并进 PATH，或 `ICL_FFMPEG`/`ICL_FFPROBE` 指绝对路径 |
| `E_FRAME` | 某时间点抽不到帧（超出片长/损坏） | 先 `video_probe` 拿时长，再传合法时间 |
| `E_BAD_RANGE` | from>=to / 超出片长 / zoom 窗口>180s | 修正窗口；先 probe |
| `E_STORYBOARD` | CLI 报错（文件损坏/编码怪/参数越界） | 先 probe；原文在 message 里 |
| `E_TIMEOUT` | 大文件/损坏文件卡住 | 用 from/to 限制窗口，长片分段 |
| `E_NO_TRANSCRIPT` | locate 没有字幕/转写 | 先 `video_storyboard`（有字幕轨会带台词）或传 `transcriptFile`；纯音乐按画面看 |

---

## 7. 与 ICL 其它模块的接缝

| 模块 | 接缝 | 现状 |
|---|---|---|
| **focus** | 看视频是一种可专注的 Activity（`docs/FOCUS.md:17-19` 已把"刷 B 站"当例子）。视频工具**不自动** enter/leave focus；操作层约定：用户说"一起看/看这个"时可 `focus_enter({kind:'video', title:'看视频'})`，看完 `focus_leave`。 | 设计约定，无代码耦合 |
| **time** | 本插件不排程、不唤醒、不发信号；只是被调用时干活。夜间长测要看视频，由 `time` 的唤醒/目标或用户消息触发。 | 无耦合 |
| **album（媒体库）** | 仓库里**没有** album 实现（QQ 侧只有"群相册"概念，未做）。约定：本插件**只登记路径与元数据**，不复制视频字节；未来 album 若要索引，读 `video_open` 的同一路径即可，不要另存一份。 | 📋 预留 |
| **qq 图片通道** | qq 侧已走 DSH attachment：入站图片字节 → bridge → `ctx.attachments.saveImages` → ImageBlock（正文无 URL/base64，失败降级文字）。本插件的图片是**工具结果**入口（`{text, images:[png 路径]}` → `saveImage`），两条入口互不冲突、不重复设计。 | ✅ 机制一致 |
| **记忆/做梦** | 工具结果不进 ICL 原文层（`docs/DSH-INTEGRATION.md:146-154`）；看完要留痕，由模型自己 `memo_append`/`remember` 写一句。 | 约定 |
| **提示词分层** | 工具用法只在 description；`prompts/sim.md` 的"看视频"纪律保持 4 行不变（`docs/PROMPT-CONTRACT.md:7-20`）。 | ✅ 不改提示词 |

---

## 8. 验证

```bash
# 单元/契约（假 CLI + 现场生成的 2 秒样例；缺 ffmpeg 自动 skip）
node --test packages/plugins/video/test

# 全量（含 bili/qq/mc）
npm test

# 真实 storyboard CLI 的端到端（评估脚本，非产品路径）
node tools/bili-eval.mjs --offline
```

测试覆盖：工具面 6 个且无下载/上传；目录列举；`E_NOT_FOUND`/`E_REMOTE_URL`；假 CLI 的图 + 清单 + 定位；
真 ffmpeg 的 probe/单帧/多帧拼图；桥接层图片从路径 → attachment → image block（`packages/core/test/dsh-bridge.test.mjs`）。

实机手测（2026-11-06，8 秒 testsrc 样例 + 真 CLI + 真 ffmpeg）：

- `video_storyboard` 4.4 s（4 格 + 清单；ASR 空时明确说"无对白"）
- `video_locate` 0.15 s（命中 1 处；用临时 JSON transcript）
- `video_zoom` 4.5 s（3 秒窗口 4 格）
- `video_frames` 0.2 s（3 帧拼 1 张）
- `video_open overview:false` 元数据 0.1 s 级

---

## 9. 还没做（按优先级）

1. **ASR 配置入口**：设计见 §11（8088 的 `whisper-asr` 可行），但**还没接线**；现在靠字幕轨或 `transcriptFile`，
   没有字幕的本地视频 `video_locate` 会返回 `E_NO_TRANSCRIPT`。
2. **MC 录屏/截图落盘约定**：接口已按"绝对路径"预留，录制端还没实现。
3. **album 元数据索引**：见 §7。
4. **批量/长片**：storyboard CLI 有 `--batch`（按窗口切、写 `-timeline.md`），ICL 工具层暂未暴露；
   长片现在靠 `from/to` 分段调用。
5. ~~**QQ 入站图片**~~：qq 侧已接 `ctx.attachments.saveImages → ImageBlock`，和本插件的工具结果入口独立共存（见 §7）。

---

## 10. storyboard cookies 续期 runbook（2026-12-01 前）

> 适用：`bili_frames`（B 站切帧兜底）与 DSH 原生 `video_storyboard`/`video_zoom` 拉网络链接时。
> 本地文件（`video_*`）不需要 cookies。整份 runbook 只读写本机文件，**不碰 B 站账号写接口**。

**现在是什么状态**
- storyboard 的登录态来自 `~/.dsh/video.json` 的 `cookies` 字段 → 一份 Netscape 格式的 `cookies.txt`
  （由用户/浏览器扩展导出，不是任何插件生成/续期的）。
- 实测四条鉴权 cookie（SESSDATA / bili_jct / buvid3 / DedeUserID）到期 **2026-12-01 前后**；
  `node tools/bili-eval.mjs --offline` 会打印到期日（只读到到期列，**不打印任何 cookie 值**）。

**续期步骤**
1. 浏览器登录 `bilibili.com`（要登录态），用 cookie 导出扩展（如 "Get cookies.txt LOCALLY"）导出
   **Netscape 格式**的 `cookies.txt`，覆盖 `~/.dsh/video.json` 里 `cookies` 指向的那个文件。
   - 不要用 `--cookies-from-browser`：Chromium 127+ 的 App-Bound 加密 yt-dlp 读不到
     （storyboard `src/fetch.js` 的注释里写了同样的结论）。
2. 确认 `~/.dsh/video.json` 形如 `{ "cookies": "<cookies.txt 的绝对路径>" }`。
   - 桌面版 DSH 读不到用户 `setx` 的环境变量，所以要用**文件**而不是 `DSH_VIDEO_COOKIES`（storyboard 的设计注释）。
3. 验证（不花图片 token）：
   ```bash
   node "C:\Users\<you>\.dsh\profiles\desktop\node_modules\dsh-video-storyboard\bin\storyboard.mjs" \
     "https://www.bilibili.com/video/BV1dC4y117Rz" --from 0 --to 5 --out tmp.png --manifest tmp.json
   ```
   看 stderr：`auth=cookies, source max 1080p` = 成功；`auth=anonymous` = 没读到 cookies。
4. 每月/大版本前重复 3；`bili-eval --offline` 的 `storyboard cookies（切帧画质）` 行会给出到期日。

**过期/缺失时会发生什么（现在会明说，不再悄悄变糊）**
- storyboard 会**匿名降级**：最高 480P，1080P 可能根本不在格式列表里；`--allow-anonymous` 会把它的警告也吞掉。
- `bili_frames` 已做两层提示：① 调用前读 cookie 到期列，缺失/已过期/7 天内到期 → 文本顶部写
  "⚠️ …会糊…续期见 docs/VIDEO-EYES.md §11"；② 从 CLI stderr 识别 `auth=anonymous` 再补一条"本次实际匿名拉流"。
- 原生 `video_storyboard` 不经过 ICL 包装，仍以它自己的 `auth=anonymous` 警告/manifest 为准。

**安全**：cookies.txt 是账号凭证；不要提交进仓库、不要贴日志、不要在工具输出里打印值（这条的代码实现见
`packages/plugins/bili/src/runtime.mjs` 的 `readStoryboardAuth`，只返回到期时间）。

---

## 11. ASR（whisper-asr @ 8088）接 `video_locate` 的可行性设计

> 只做可行性评估与设计；**没有写 `asr.json`、没有发起推理**（避免占 GPU）。lead 2026-11-06：不落桌面配置，等用户批准/产品化。

**现状（2026-11-06 只读探测）**
- `http://127.0.0.1:8088/v1/models` 列出 `whisper-asr`（llama-swap 网关）。
- `GET /health` → 200；`OPTIONS /v1/audio/transcriptions` → 204 ⇒ OpenAI 转写路由存在。
- `dsh-video-storyboard` 的 ASR 客户端是 **OpenAI `/audio/transcriptions` 方言**
  （`docs/asr-contract.md`）：请求 `multipart/form-data`（16 kHz mono WAV + model + verbose_json），
  客户端按 ≤45 s、静音中点切片；配置优先级 `DSH_ASR_* env > $DSH_HOME/asr.json > 内置默认`；
  loopback 服务不要求 key；只有 `asr.json` 写 `manage.start` 时插件才托管启动服务（我们不需要它托管）。

**结论：可行性高，且很可能零代码**
- 只要把 storyboard 的 ASR 指向 8088，`video_locate` 就能用：它内部会跑一次 `video_storyboard --text-only`
  （`--transcript auto` 触发 ASR），解析出每格台词；转写结果由 storyboard 缓存，第二次很快。
- **现在不写 `$DSH_HOME/asr.json`**（lead 2026-11-06 决定：宿主/桌面配置需用户批准，等产品化一起做）。
  下面只是接线方案，不是已执行的操作；要验证只能在**临时 env / lab 侧**，不落桌面配置。
- 方案 A（配置面，需用户批准）：
  ```json
  // %USERPROFILE%\.dsh\asr.json   ← 示意，未写入
  { "baseUrl": "http://127.0.0.1:8088/v1", "model": "whisper-asr", "language": "zh" }
  ```
  （loopback 可不要 key；llama-swap 若要求占位 key，加 `"key": "local"`。）
- 方案 B（ICL 自持，后续可做）：`video` 插件加 `asrBaseUrl/asrModel/asrLang` 配置，调用 CLI 时注入
  `DSH_ASR_BASE_URL/DSH_ASR_MODEL/DSH_ASR_LANG`（env 优先级高于 `asr.json`），这样 ICL 不依赖用户全局文件；
  临时验证也可以直接用这组 env，不碰 `asr.json`。

**接进 `video_locate` 的流程（设计）**
1. `video_locate {path, query}` → 若没有缓存转写，先 `storyboard --text-only --text --detail high`（这步触发 ASR）。
2. CLI 用 ffmpeg 抽 16k mono WAV → 分片 POST `/v1/audio/transcriptions` → 合并 segments（相对分片的时间由客户端加偏移）。
3. 清单里的 cell 文本被解析后做关键词匹配 → 返回命中格位/时间码（现有 `parseCells` 已能读这份文本）。
4. 失败/关闭 ASR：返回 `E_NO_TRANSCRIPT`（已有文案），不重试到天荒地老。

**风险与边界**
- 首次调用要加载 whisper 模型（几秒到几十秒），且可能占 GPU；只在 `video_locate` 缺字幕时触发，`video_storyboard` 可用 `transcript: off` 关。
- 音乐/纯 BGM 会产生幻觉段；storyboard 有 `filterSuspectSegments`（会报告丢弃，不静默）。
- 时间戳是"相对分片"的，必须由客户端加偏移（storyboard 已处理；自己实现时最容易错）。
- 8088 是共享网关：llama-swap 会按需换模型，长测时避免和本地模型实验抢同一时间窗。

**未来验收**：`node bin/asr-check.mjs <本地视频> --from 0 --seconds 12` 出中文文本；`video_locate` 能命中；
关闭 ASR 时明确 `E_NO_TRANSCRIPT`；`video_storyboard transcript:off` 确实不调服务。

---

## 12. 与 B 站插件的分界（速查）

- 本地路径 → `video_*`（本插件）。
- `https://www.bilibili.com/video/…` → `bili_watch`/`bili_comments`/`bili_feed`，看画面用 `bili_frames` 或 DSH 原生 `video_storyboard`。
- 其它 URL → DSH 原生 `video_storyboard`（它自带 yt-dlp + cookies 解析；ICL 不重复实现）。
