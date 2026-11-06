// B 站接入（C 路线）：只读工具 + ICL 自持运行面。
//
// 边界（重要）：
//   · B 站专用：bili_search / bili_watch / bili_comments / bili_feed / bili_frames（在线页面/接口）。
//   · 通用视频：本地文件/QQ 落盘/MC 录屏走 video 插件的 video_open/video_storyboard。
//   · 登录只写本机凭证，不碰 B 站账号的写接口；评论/私信/上传/收藏一律不注册。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { ensureRuntime, makeCaller, preflight, failText, resolveConfig, readStoryboardAuth } from './runtime.mjs'
import { loginStart, loginPoll, saveCredential, renderQrPng, credentialExpiry } from './login.mjs'

export const name = 'bili'

const MINUTE = (seconds) => {
  const n = Math.max(0, Number(seconds) || 0)
  return `${Math.floor(n / 60)}:${String(Math.round(n % 60)).padStart(2, '0')}`
}
const WAN = (n) => {
  const v = Number(n) || 0
  if (v >= 100_000_000) return `${(v / 100_000_000).toFixed(1)}亿`
  if (v >= 10_000) return `${(v / 10_000).toFixed(1)}万`
  return String(v)
}
const VIDEO_URL = (bvid) => `https://www.bilibili.com/video/${bvid}`
const BV_RE = /BV[0-9A-Za-z]{10}/

function bvidOf(target) {
  const text = String(target ?? '').trim()
  const match = BV_RE.exec(text)
  if (match) return match[0]
  if (/^[0-9A-Za-z]{12}$/.test(text) && text.startsWith('BV')) return text
  return ''
}

function listLines(videos, { withStats = true } = {}) {
  const lines = []
  let index = 0
  for (const video of videos) {
    if (!video?.bvid) continue
    index += 1
    const meta = []
    if (video.author) meta.push(`UP ${video.author}`)
    if (withStats) {
      if (video.play != null) meta.push(`播放 ${WAN(video.play)}`)
      if (video.duration != null && video.duration !== '') {
        meta.push(typeof video.duration === 'number' ? MINUTE(video.duration) : String(video.duration))
      }
    }
    lines.push(`${index}. ${video.title ?? '(无标题)'}${meta.length ? ` — ${meta.join(' · ')}` : ''}\n   ${VIDEO_URL(video.bvid)}`)
  }
  return lines
}

function formatSearch(data, keyword) {
  if (data?.error) return `B 站搜索返回错误：${data.error}`
  const videos = (Array.isArray(data?.videos) ? data.videos : []).filter((v) => v?.bvid)
  if (!videos.length) {
    return `搜「${keyword}」没有结果。下一步：换一个更短/更常见的关键词；或直接用 BV 号 bili_watch。`
  }
  const lines = [`「${keyword}」搜到 ${videos.length} 条：`, ...listLines(videos)]
  lines.push('下一步：对感兴趣的用 bili_watch 看简介/字幕；有画面疑问用原生 video_storyboard（B 站链接可直传）。')
  return lines.join('\n')
}

function formatWatch(info, subtitle) {
  if (!info || info.error) return `打开视频失败：${info?.error ?? '没有返回视频信息'}`
  const stat = info.stat ?? {}
  const lines = [
    info.title ?? '(无标题)',
    `BV ${info.bvid} · UP ${info.author ?? '?'} · 时长 ${info.duration ? MINUTE(info.duration) : '?'}`,
    `播放 ${WAN(stat.view)} · 弹幕 ${WAN(stat.danmaku)} · 评论 ${WAN(stat.reply)} · 收藏 ${WAN(stat.favorite)}`,
  ]
  const desc = String(info.description ?? '').trim()
  if (desc) lines.push('', `简介：${desc.slice(0, 300)}${desc.length > 300 ? '…' : ''}`)
  if (subtitle?.error) {
    lines.push('', `字幕：取不到（${subtitle.error}）`)
  } else if (subtitle?.message) {
    lines.push('', `字幕：${subtitle.message}`)
  } else if (subtitle?.text) {
    lines.push('', `字幕（${subtitle.language ?? '未知语言'}，${subtitle.segments ?? '?'} 段）：`, String(subtitle.text))
  }
  lines.push('', '下一步：想看画面用原生 video_storyboard（B 站链接直传）；想翻评论用 bili_comments。')
  return lines.join('\n')
}

function formatComments(data) {
  if (data?.error) return `读评论失败：${data.error}`
  const comments = Array.isArray(data?.comments) ? data.comments : []
  if (!comments.length) return '这条视频没有返回评论（可能太新/被关闭）。'
  const lines = [`评论区 ${data.count ?? comments.length} 条：`]
  for (const [index, comment] of comments.entries()) {
    const replies = Array.isArray(comment.top_replies) ? comment.top_replies : []
    lines.push(`${index + 1}. [赞 ${comment.like ?? 0} · 回复 ${comment.reply_count ?? 0}] ${comment.user ?? '?'}：${String(comment.content ?? '').slice(0, 200)}`)
    for (const reply of replies.slice(0, 2)) {
      lines.push(`   ↳ ${reply.user ?? '?'}：${String(reply.content ?? '').slice(0, 120)}`)
    }
  }
  return lines.join('\n')
}

function formatFeed(kind, data) {
  if (data?.error) return `拿不到${kind}：${data.error}`
  if (kind === 'buzz') {
    const words = Array.isArray(data?.buzzwords) ? data.buzzwords : (Array.isArray(data?.list) ? data.list : [])
    if (!words.length) return '热搜词是空的（接口可能改了）；换 bili_feed kind=hot 试试。'
    return ['B 站热词：', ...words.slice(0, 20).map((w, i) => `${i + 1}. ${w.name ?? w.keyword ?? w}`)].join('\n')
  }
  if (kind === 'weekly') {
    const videos = Array.isArray(data?.videos) ? data.videos : (Array.isArray(data?.list) ? data.list : [])
    if (videos.length) return ['每周必看：', ...listLines(videos)].join('\n')
    const periods = Array.isArray(data?.periods) ? data.periods : (Array.isArray(data?.list) ? data.list : [])
    if (periods.length) {
      return ['每周必看（期数；再传 week 查某一期）：', ...periods.slice(0, 10).map((p, i) => `${i + 1}. 第 ${p.number ?? p.week ?? '?'} 期 · ${p.subject ?? p.name ?? ''}`)].join('\n')
    }
    return '每周必看返回了空结果；用 bili_feed kind=hot 或 kind=rank。'
  }
  const videos = (Array.isArray(data?.videos) ? data.videos : []).filter((v) => v?.bvid)
  if (!videos.length) return `${kind} 返回空；稍后再试或换 kind。`
  const title = kind === 'rank' ? 'B 站排行榜' : 'B 站热门'
  return [`${title}（${videos.length} 条）：`, ...listLines(videos)].join('\n')
}

function takeText(value, limit) {
  const text = String(value ?? '')
  return text.length > limit ? `${text.slice(0, limit)}\n…（截断到 ${limit} 字）` : text
}

/** bili_frames：把 B 站链接交给 storyboard CLI，图作为附件返回。 */
function framesTarget(target) {
  const text = String(target ?? '').trim()
  if (/^https?:/i.test(text)) return { url: text }
  const bvid = bvidOf(text)
  if (!bvid) return { error: `认不出 BV 号：${text}。给我一个 B 站 URL 或 BV 号。` }
  return { url: VIDEO_URL(bvid) }
}

function callStoryboard(cfg, { url, from, to, cells, workDir, allowAnonymous = true }) {
  return new Promise((resolve) => {
    const sheet = path.join(workDir, 'sheet.png')
    const manifest = path.join(workDir, 'manifest.json')
    const start = Number.isFinite(Number(from)) ? Number(from) : 0
    const end = Number.isFinite(Number(to)) ? Number(to) : start + 240
    const args = [
      cfg.storyboardCli, url,
      '--cells', String(Math.min(16, Math.max(1, Number(cells) || 6))),
      '--out', sheet, '--manifest', manifest,
      '--from', String(Math.max(0, start)), '--to', String(Math.max(start + 1, end)),
      '--scan-height', '240', '--text',
    ]
    // 有 cookies 时不传 --allow-anonymous：让 CLI 自己在降级时把警告打到 stderr；
    // 没有 cookies 时传上，避免它把"匿名"当异常（我们自己的 auth 提示更具体）。
    if (allowAnonymous) args.push('--allow-anonymous')
    execFile(process.execPath, args, { timeout: 600_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      const out = String(stdout ?? '')
      const at = out.indexOf('<storyboard')
      const block = at >= 0 ? out.slice(at).trim() : ''
      const images = []
      try {
        for (const name of fs.readdirSync(workDir).filter((n) => /\.png$/i.test(n) && n.startsWith('sheet')).sort()) {
          images.push(path.join(workDir, name))
        }
      } catch { /* 空目录 */ }
      if (error) {
        resolve({ ok: false, error: String(error?.message ?? error), stderr: String(stderr ?? '') })
        return
      }
      resolve({ ok: true, block, images, manifest, stderr: String(stderr ?? '') })
    })
  })
}

/** B 站格图临时目录的前缀（旧版落在系统临时目录，新版落在 <stateDir>/bili/work）。 */
const LEGACY_BOARD_PREFIX = 'icl-bili-board-'

/**
 * 清掉旧版遗留在系统临时目录里的 `icl-bili-board-*`，并顺手清 `<stateDir>/bili/work` 下超过 24h 的目录。
 * bili_frames 的图在工具返回后还要被桥读成 attachment，所以成功路径用 cleanup 回调删；这里只兜底旧残留。
 */
function pruneBoardDirs(biliDir) {
  let removed = 0
  try {
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (!name.startsWith(LEGACY_BOARD_PREFIX)) continue
      try { fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true }); removed += 1 } catch { /* 跳过 */ }
    }
  } catch { /* 没有 tmpdir 权限就算了 */ }
  try {
    const root = path.join(biliDir, 'work')
    for (const name of fs.readdirSync(root)) {
      const full = path.join(root, name)
      try {
        const stat = fs.statSync(full)
        if (stat.isDirectory() && Date.now() - stat.mtimeMs > 24 * 60 * 60 * 1000) {
          fs.rmSync(full, { recursive: true, force: true }); removed += 1
        }
      } catch { /* 单个目录坏了就跳过 */ }
    }
  } catch { /* 目录还不存在 */ }
  return removed
}

/** 在 ICL 自己的 stateDir 下建一个格图工作目录（不落用户 %TEMP%）。 */
function makeBoardDir(biliDir) {
  const root = path.join(biliDir, 'work')
  fs.mkdirSync(root, { recursive: true })
  return fs.mkdtempSync(path.join(root, 'board-'))
}

export function apply(ctx) {
  const cfg = resolveConfig(ctx)
  const notes = ensureRuntime(cfg)
  const pruned = pruneBoardDirs(cfg.biliDir)
  const call = makeCaller(cfg, { log: (entry) => ctx.log?.(entry) })
  const disposers = []
  ctx.log?.({ msg: 'bili.ready', stateDir: cfg.biliDir, vendor: cfg.vendorDir, notes, prunedBoardDirs: pruned })

  const register = (definition) => {
    const off = ctx.tools.register(definition)
    disposers.push(off)
  }

  const fail = (result) => ({ text: failText(result) })
  const guard = (fn) => async (args = {}) => {
    try {
      return await fn(args)
    } catch (error) {
      return { text: `B 站工具内部错误：${String(error?.message ?? error)}\n下一步：把这条原文和参数报给维护者。` }
    }
  }

  register({
    name: 'bili_search',
    summary: 'Search Bilibili videos by keyword: title, uploader, play count, duration, BV id.',
    description: 'Read-only. Returns cleaned results (cards without a BV id are dropped). '
      + 'Order: totalrank (default) / click / pubdate / dm. Use bili_watch on a result to read it.',
    when: ['you want to find something on Bilibili'],
    avoid: ['opening a known BV id - use bili_watch directly'],
    parameters: {
      type: 'object', additionalProperties: false, required: ['keyword'],
      properties: {
        keyword: { type: 'string', description: 'Search keywords.' },
        num: { type: 'number', description: 'How many results (default 8, max 50).' },
        order: { type: 'string', description: 'totalrank | click | pubdate | dm' },
      },
    },
    execute: guard(async ({ keyword, num = 8, order = 'totalrank' }) => {
      const word = String(keyword ?? '').trim()
      if (!word) return { text: '搜索需要一个关键词。' }
      const allowed = new Set(['totalrank', 'click', 'pubdate', 'dm'])
      const result = await call('bili_search', {
        keyword: word,
        num: Math.min(50, Math.max(1, Number(num) || 8)),
        order: allowed.has(String(order)) ? String(order) : 'totalrank',
      })
      if (!result.ok) return fail(result)
      return { text: formatSearch(result.data, word) }
    }),
  })

  register({
    name: 'bili_watch',
    summary: 'Open a Bilibili video: title, stats, description and subtitle text (read-only).',
    description: 'Takes a URL or BV id. Returns metadata plus the subtitle transcript when the video has one. '
      + 'For the picture use the DSH video_storyboard tool (Bilibili links work directly there).',
    when: ['a video looks interesting and you want to know what it says'],
    avoid: ['using it as a search tool'],
    parameters: {
      type: 'object', additionalProperties: false, required: ['target'],
      properties: { target: { type: 'string', description: 'Bilibili URL or BV id.' } },
    },
    execute: guard(async ({ target }) => {
      const bvid = bvidOf(target)
      if (!bvid) return { text: `认不出 BV 号：${String(target ?? '')}。给我 B 站 URL 或 BV 号。` }
      const info = await call('bili_video_info', { bvid })
      if (!info.ok) return fail(info)
      const subtitle = await call('bili_subtitle', { bvid })
      const sub = subtitle.ok ? subtitle.data : { error: subtitle.error }
      return { text: takeText(formatWatch(info.data, sub), cfg.maxChars) }
    }),
  })

  register({
    name: 'bili_comments',
    summary: 'Read top comments and their top replies on a Bilibili video (read-only).',
    description: 'Read-only. Use it to see how people reacted; it cannot and will not post anything.',
    when: ['you want to know how people reacted'],
    avoid: ['replying - this tool cannot comment'],
    parameters: {
      type: 'object', additionalProperties: false, required: ['target'],
      properties: {
        target: { type: 'string', description: 'Bilibili URL or BV id.' },
        num: { type: 'number', description: 'How many comments (default 10).' },
      },
    },
    execute: guard(async ({ target, num = 10 }) => {
      const bvid = bvidOf(target)
      if (!bvid) return { text: `认不出 BV 号：${String(target ?? '')}。` }
      const result = await call('bili_comments', { bvid, num: Math.min(50, Math.max(1, Number(num) || 10)) })
      if (!result.ok) return fail(result)
      return { text: takeText(formatComments(result.data), cfg.maxChars) }
    }),
  })

  register({
    name: 'bili_feed',
    summary: 'Bilibili front-page feed: hot videos, rank, weekly picks or hot search words (all read-only).',
    description: 'kind=hot (default) | rank | weekly | buzz. num controls how many items (default 10). '
      + 'rank supports category (all/original/rookie/douga/music/dance/game/...) and day 1-7; weekly supports week number.',
    when: ['you want to see what Bilibili is pushing right now, without a keyword'],
    avoid: ['searching a specific topic - use bili_search'],
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        kind: { type: 'string', description: 'hot | rank | weekly | buzz (default hot).' },
        num: { type: 'number', description: 'How many items (default 10, max 50).' },
        category: { type: 'string', description: 'For rank: all/original/rookie/douga/music/dance/game/... (default all).' },
        day: { type: 'number', description: 'For rank: 1-7 days window (default 3).' },
        week: { type: 'number', description: 'For weekly: period number; 0 lists periods.' },
      },
    },
    execute: guard(async ({ kind = 'hot', num = 10, category = 'all', day = 3, week = 0 }) => {
      const type = String(kind || 'hot')
      const count = Math.min(50, Math.max(1, Number(num) || 10))
      if (type === 'hot') {
        const result = await call('bili_hot_videos', { pn: 1, ps: count })
        if (!result.ok) return fail(result)
        return { text: formatFeed('hot', result.data) }
      }
      if (type === 'rank') {
        const result = await call('bili_rank', { category: String(category || 'all'), day: Math.min(7, Math.max(1, Number(day) || 3)) })
        if (!result.ok) return fail(result)
        const data = { ...result.data, videos: Array.isArray(result.data?.videos) ? result.data.videos.slice(0, count) : undefined }
        return { text: formatFeed('rank', data) }
      }
      if (type === 'weekly') {
        const result = await call('bili_weekly_hot', { week: Math.max(0, Number(week) || 0) })
        if (!result.ok) return fail(result)
        return { text: formatFeed('weekly', result.data) }
      }
      if (type === 'buzz') {
        const result = await call('bili_hot_buzzwords', { page_num: 1, page_size: Math.min(20, count) })
        if (!result.ok) return fail(result)
        return { text: formatFeed('buzz', result.data) }
      }
      return { text: `不认识的 kind：${type}。可用：hot / rank / weekly / buzz。` }
    }),
  })

  register({
    name: 'bili_frames',
    summary: 'Storyboard grid for a Bilibili video: the image is attached to the result, plus a citeable cell index.',
    description: 'Fallback for picture when you only have a Bilibili URL (the DSH video_storyboard tool also accepts links). '
      + 'Downloads one low-res copy first; long videos: pass from/to to look at one stretch. The PNG comes back as an image attachment.',
    when: ['a Bilibili video has no subtitles or the visual content is the point'],
    avoid: ['very long videos without from/to', 'local files - use the video plugin instead'],
    parameters: {
      type: 'object', additionalProperties: false, required: ['target'],
      properties: {
        target: { type: 'string', description: 'Bilibili URL or BV id.' },
        from: { type: 'number', description: 'Window start seconds (default 0).' },
        to: { type: 'number', description: 'Window end seconds (default from+240).' },
        cells: { type: 'number', description: 'Cells 1-16 (default 6).' },
      },
    },
    execute: guard(async ({ target, from = 0, to = null, cells = 6 }) => {
      const blocked = preflight(cfg, 'frames')
      if (blocked) return { text: blocked }
      const info = framesTarget(target)
      if (info.error) return { text: info.error }
      const auth = readStoryboardAuth({ videoConfigPath: cfg.videoConfigPath, videoCookies: cfg.videoCookies })
      const workDir = makeBoardDir(cfg.biliDir)
      const cleanup = () => {
        try { fs.rmSync(workDir, { recursive: true, force: true }) } catch { /* 清不掉也不影响结果 */ }
      }
      let handedOff = false
      try {
        const result = await callStoryboard(cfg, {
          url: info.url, from, to, cells, workDir,
          // 没有 cookies 时显式匿名，避免 CLI 的"未配置"噪声；我们自己给更具体的提示。
          allowAnonymous: auth.status !== 'ok',
        })
        if (!result.ok) {
          cleanup()
          return { text: `看不成画面：${result.error}\n下一步：用原生 video_storyboard（B 站链接直传）；或检查 ffmpeg/网络。` }
        }
        // "别再悄悄变糊"：即使 CLI 静默降级成匿名，也把这次的真实来源写进结果。
        const degraded = /auth=anonymous/.test(result.stderr || '')
        const warnings = []
        if (auth.warning) warnings.push(auth.warning)
        if (degraded && !auth.warning) {
          warnings.push('⚠️ 本次实际按匿名拉流（最高 480P，图可能糊）：cookies 缺失或已过期。续期见 docs/VIDEO-EYES.md §10。')
        }
        const body = takeText(result.block || '宫格图已生成（没有清单输出）。', cfg.maxChars)
        const text = warnings.length ? `${warnings.join('\n')}\n\n${body}` : body
        handedOff = true
        // 图还要被 dsh-icl 桥读成 attachment；cleanup 由 normalizeToolResult 在提交附件后调用。
        return { text, images: result.images.slice(0, 2), cleanup }
      } finally {
        if (!handedOff) cleanup()
      }
    }),
  })

  register({
    name: 'bili_login_start',
    summary: 'Start Bilibili QR login: returns a QR image (attachment) and a key to poll with bili_login_poll.',
    description: 'Only writes the credential file under ICL stateDir; it never posts/comments/messages. '
      + 'Open the image, scan with the Bilibili app, confirm with "remember me", then call bili_login_poll {key}.',
    when: ['Bilibili tools report E_AUTH / credential expired'],
    avoid: ['using it when tools already work'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    execute: guard(async () => {
      if (typeof cfg.fetchImpl !== 'function') {
        return { text: '这个会话没有可用的 HTTP 出口（ctx.fetch 缺失），扫码登录做不了。下一步：在真实 ICL 会话里再试，或手工复制一份凭证到 stateDir/bili/。' }
      }
      ensureRuntime(cfg)
      const started = await loginStart({ fetchImpl: cfg.fetchImpl })
      let png = null
      try {
        png = await renderQrPng({ pythonPath: cfg.pythonPath, url: started.url, outFile: path.join(cfg.biliDir, 'qrcode_login.png') })
      } catch { /* 没有 qrcode 模块就只给 URL */ }
      const lines = [
        '二维码已生成（约 180 秒有效）。手机上用 B 站 App 扫码，确认时选「记住我 / 长期」。',
        `key：${started.key}`,
        png ? `二维码图片：${png}` : `没画成 PNG（缺 qrcode 模块）；二维码链接：${started.url}`,
        `扫完调 bili_login_poll，参数 {"key":"${started.key}"}。`,
      ]
      return { text: lines.join('\n'), images: png ? [png] : [] }
    }),
  })

  register({
    name: 'bili_login_poll',
    summary: 'Check Bilibili QR login state; on success save the credential into ICL stateDir.',
    description: 'waiting / scanned / ok / expired. On ok the credential file is written (atomic); the response never contains the cookie values.',
    when: ['after bili_login_start, poll until ok/expired'],
    avoid: ['polling in a tight loop - poll every few seconds at most'],
    parameters: {
      type: 'object', additionalProperties: false, required: ['key'],
      properties: { key: { type: 'string', description: 'The key returned by bili_login_start.' } },
    },
    execute: guard(async ({ key }) => {
      if (typeof cfg.fetchImpl !== 'function') {
        return { text: '这个会话没有可用的 HTTP 出口（ctx.fetch 缺失），查不了扫码结果。' }
      }
      const result = await loginPoll(String(key ?? ''), { fetchImpl: cfg.fetchImpl })
      if (result.state === 'ok') {
        const file = saveCredential(cfg.credentialFile, result.credential)
        const expiresAt = credentialExpiry(result.credential)
        const when = expiresAt ? new Date(expiresAt).toLocaleString('zh-CN', { hour12: false }) : '未知'
        return { text: `登录成功，凭证已写入 ${file}\nSESSDATA 到期：${when}（这是凭证自带的时间，不是推测）\n下一步：用 bili_watch/bili_comments 验证一下。` }
      }
      const text = result.state === 'expired'
        ? '二维码过期了。下一步：重新 bili_login_start。'
        : `扫码状态：${result.state}${result.message ? `（${result.message}）` : ''}。再轮询几次，或重新 bili_login_start。`
      return { text }
    }),
  })

  return () => {
    for (const off of disposers.reverse()) {
      try { off?.() } catch { /* 单个注销失败不影响其余 */ }
    }
  }
}
