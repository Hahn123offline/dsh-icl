// 通用视频浏览器（"眼睛"）：本地视频的打开/分镜/回看/定位/单帧。
//
// 定位：ICL 的通用能力，不依赖 B 站、不依赖 QQ。输入永远是本地绝对路径
// （QQ 落盘、MC 录屏、用户自己的片都走这里）；网络链接属于 bili_* 或 DSH 原生 video_storyboard。
//
// 图片怎么进模型：工具返回 { text, images: [png 绝对路径] }，由 dsh-icl 的桥接层
// 调 ctx.attachments.saveImage() 换成 attachment，再渲染成 image block。
// 这一层只负责"把图生成在磁盘上 + 说清哪一格是什么"，不碰附件服务。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { probeVideo, formatProbe } from './probe.mjs'
import {
  resolveLocalPath, listVideos, makeWorkDir, pruneWorkDirs, humanBytes,
  DEFAULT_MAX_FILE_BYTES, errorText, videoError,
} from './paths.mjs'
import {
  resolveStoryboardCli, runStoryboard, locateInTranscript, extractTextBlock, TC,
} from './storyboard.mjs'
import { extractFrames } from './frames.mjs'

export const name = 'video'

const DEFAULT_OVERVIEW_SECONDS = 240
const MAX_TEXT = 8000

function configOf(ctx) {
  const config = ctx?.config && typeof ctx.config === 'object' ? ctx.config : {}
  return {
    stateDir: String(config.stateDir ?? path.join(os.tmpdir(), 'icl-video')),
    cli: resolveStoryboardCli(config.storyboardCli),
    cliPath: String(config.storyboardCli ?? process.env.ICL_STORYBOARD_CLI ?? ''),
    ffmpeg: String(config.ffmpeg ?? process.env.ICL_FFMPEG ?? 'ffmpeg'),
    ffprobe: String(config.ffprobe ?? process.env.ICL_FFPROBE ?? 'ffprobe'),
    maxFileBytes: Number(config.maxFileBytes) || DEFAULT_MAX_FILE_BYTES,
    overviewSeconds: Number(config.overviewSeconds) || DEFAULT_OVERVIEW_SECONDS,
    maxTextChars: Number(config.maxTextChars) || MAX_TEXT,
  }
}

function fail(code, message, next) {
  return { text: errorText(videoError(code, message, next)) }
}

function describeError(error, cfg) {
  const code = String(error?.code ?? 'E_VIDEO')
  const raw = String(error?.message ?? error)
  switch (code) {
    case 'E_NO_CLI':
      return fail('E_NO_CLI', '找不到 dsh-video-storyboard 的 CLI。', '安装 dsh-video-storyboard，或用 ICL_STORYBOARD_CLI 指向它的 bin/storyboard.mjs；装好后重启会话。')
    case 'E_NO_FFMPEG':
    case 'E_FFMPEG':
      return fail('E_FFMPEG', raw, '装 ffmpeg/ffprobe 并放进 PATH，或用 ICL_FFMPEG / ICL_FFPROBE 指绝对路径。')
    case 'E_PROBE':
    case 'E_NOT_VIDEO':
      return fail(code, raw, '确认这是一个视频文件（不是压缩包/图片）；ffprobe 要能读它。')
    case 'E_TIMEOUT':
      return fail('E_TIMEOUT', '处理超时了（片太长或文件损坏）。', `用 from/to 只扫一段（默认每次 ≤ ${cfg.overviewSeconds}s）；长片用 video_storyboard 分段看。`)
    case 'E_STORYBOARD':
      return fail('E_STORYBOARD', raw, '先用 video_probe 确认文件可读；还是不行就检查 ffmpeg 与 CLI 版本（CLI 报错原文在 message 里）。')
    case 'E_TOO_BIG':
      return fail('E_TOO_BIG', raw, '先转码/裁一段再看；或把 ICL 的 video.maxFileBytes 配大（默认 8 GiB）。')
    case 'E_BAD_RANGE':
      return fail('E_BAD_RANGE', raw, 'from 要小于 to，且都在片长内；先 video_probe 拿时长。')
    default:
      if (error?.code && String(error.code).startsWith('E_')) return fail(code, raw, '')
      return fail('E_VIDEO', raw, '把这段原文和路径一起报给维护者。')
  }
}

function checkFile(raw, cfg) {
  const resolved = resolveLocalPath(raw)
  if (!resolved.ok) return resolved
  if (resolved.stat.isDirectory()) {
    return { ok: false, error: videoError('E_IS_DIR', `这是目录：${resolved.path}`, '对目录用 video_open（它会列里面的视频），或把 path 指到具体文件。') }
  }
  if (resolved.stat.size > cfg.maxFileBytes) {
    return { ok: false, error: videoError('E_TOO_BIG', `文件 ${humanBytes(resolved.stat.size)} 超过上限 ${humanBytes(cfg.maxFileBytes)}。`, '先截一段/转码，或调大 video.maxFileBytes。') }
  }
  return resolved
}

function requireCli(cfg) {
  if (cfg.cli) return true
  const error = new Error(`找不到 storyboard CLI（配置值：${cfg.cliPath || '(空)'}）`)
  error.code = 'E_NO_CLI'
  throw error
}

function guard(cfg, fn) {
  return async (args = {}) => {
    try {
      return await fn(args)
    } catch (error) {
      return describeError(error, cfg)
    }
  }
}

function ensureRange(from, to, duration) {
  const f = Number(from)
  const t = Number(to)
  if (!Number.isFinite(f) || !Number.isFinite(t) || f < 0 || t <= f) {
    throw Object.assign(new Error(`时间窗不合法：from=${from} to=${to}`), { code: 'E_BAD_RANGE' })
  }
  if (duration > 0 && f >= duration) {
    throw Object.assign(new Error(`from=${f}s 超出片长 ${duration.toFixed(1)}s`), { code: 'E_BAD_RANGE' })
  }
  return { from: f, to: Math.min(t, duration > 0 ? duration : t) }
}

function directoryText(dir, listing) {
  if (!listing.total) {
    return `目录：${dir}\n里面没有认出来的视频文件（${[...['.mp4', '.mkv', '.mov', '.webm', '.avi']].join(' ')} …）。\n下一步：把视频放进这个目录，或直接给 video_open 一个文件的绝对路径。`
  }
  const lines = [
    `目录：${dir}`,
    `找到 ${listing.total} 个视频${listing.total > listing.rows.length ? `（先列 ${listing.rows.length} 个）` : ''}：`,
  ]
  for (const [i, row] of listing.rows.entries()) {
    const when = new Date(row.mtimeMs).toLocaleString('zh-CN', { hour12: false })
    lines.push(`${i + 1}. ${row.name} · ${humanBytes(row.bytes)} · ${when}`)
  }
  lines.push('下一步：对其中一个再调 video_open（path 用上面完整路径），先看封面/概览再决定要不要细看。')
  return lines.join('\n')
}

export function apply(ctx) {
  const cfg = configOf(ctx)
  try {
    fs.mkdirSync(cfg.stateDir, { recursive: true })
    pruneWorkDirs(cfg.stateDir)
  } catch { /* 状态目录不可写时仍可跑（用系统临时目录） */ }

  const tools = []
  const register = (definition) => {
    const off = ctx.tools.register(definition)
    tools.push(off)
  }

  // ① 只读容器头：便宜、不出图
  register({
    name: 'video_probe',
    summary: 'Read a local video\'s container metadata (duration, resolution, fps, audio/subtitle, size) without decoding frames.',
    description: 'Local absolute path only. Use it before reading a long video so you know how much there is and where to slice.',
    when: ['you got a video path and want to know what it is / how long it is'],
    avoid: ['it is a directory - use video_open to list its videos first'],
    parameters: {
      type: 'object', additionalProperties: false, required: ['path'],
      properties: {
        path: { type: 'string', description: 'Absolute path to a local video file.' },
      },
    },
    execute: guard(cfg, async ({ path: raw }) => {
      const file = checkFile(raw, cfg)
      if (!file.ok) return fail(file.error.code, file.error.message, file.error.next)
      const info = await probeVideo(file.path, { ffprobe: cfg.ffprobe })
      return { text: formatProbe(info, { path: file.path }) }
    }),
  })

  // ② 通用入口：文件 → 元数据 + 概览图；目录 → 列视频
  register({
    name: 'video_open',
    summary: 'Open a local video (or a directory of videos): metadata plus a storyboard overview image, so you actually see it instead of guessing.',
    description: 'This is the generic entry for any local video - QQ videos, game recordings, user files. Directory input lists videos. '
      + 'For long videos pass from/to (default overview covers the first 240s). Returns the overview picture plus a citeable cell index.',
    when: ['a video file landed on disk and you need to know what it shows', 'a directory may contain videos'],
    avoid: [' Bilibili/online URLs - use bili_* tools or the DSH video_storyboard tool for links'],
    parameters: {
      type: 'object', additionalProperties: false, required: ['path'],
      properties: {
        path: { type: 'string', description: 'Absolute path to a local video file or a directory containing videos.' },
        overview: { type: 'boolean', description: 'Default true: also generate an overview storyboard (costs ~384 image tokens). Set false for metadata only.' },
        from: { type: 'number', description: 'Overview window start in seconds (default 0).' },
        to: { type: 'number', description: 'Overview window end in seconds (default min(duration, from+240)).' },
        cells: { type: 'number', description: 'Overview cells 1-16 (default 6).' },
      },
    },
    execute: guard(cfg, async ({ path: raw, overview = true, from = 0, to = null, cells = 6 }) => {
      const resolved = resolveLocalPath(raw)
      if (!resolved.ok) return fail(resolved.error.code, resolved.error.message, resolved.error.next)
      if (resolved.stat.isDirectory()) {
        return { text: directoryText(resolved.path, listVideos(resolved.path, { limit: 20 })) }
      }
      if (resolved.stat.size > cfg.maxFileBytes) {
        return fail('E_TOO_BIG', `文件 ${humanBytes(resolved.stat.size)} 超过上限 ${humanBytes(cfg.maxFileBytes)}。`, '先截一段/转码，或调大 video.maxFileBytes。')
      }
      const info = await probeVideo(resolved.path, { ffprobe: cfg.ffprobe })
      let text = formatProbe(info, { path: resolved.path })
      if (overview === false) {
        return { text: `${text}\n下一步：想看画面调 video_open（overview 默认为 true）或 video_storyboard。` }
      }
      requireCli(cfg)
      const window = ensureRange(Number(from) || 0, Number(to) || Math.min(info.duration || cfg.overviewSeconds, (Number(from) || 0) + cfg.overviewSeconds), info.duration)
      try {
        const run = await runStoryboard({
          input: resolved.path, from: window.from, to: window.to,
          cells: Math.min(16, Math.max(1, Number(cells) || 6)), sheets: 1,
          detail: 'med', cli: cfg.cli, workDir: makeWorkDir(cfg.stateDir, 'open'),
          maxTextChars: cfg.maxTextChars,
        })
        const block = run.textBlock || extractTextBlock(run.stderr?.includes('<storyboard') ? run.stderr : '', { maxChars: cfg.maxTextChars })
        text = [text, '', block || '(概览图已生成；CLI 没打印清单)', '', '下一步：想看清某段用 video_zoom；想按台词找用 video_locate；精确某一帧用 video_frames。']
          .filter((line) => line !== undefined).join('\n')
        return { text, images: run.sheets.slice(0, 4) }
      } catch (error) {
        // 出图失败不该把已拿到的元数据一起吞掉：降级成"能看多少算多少"。
        return { text: `${text}\n概览图没生成（${String(error?.message ?? error)}）。下一步：先确认 ffmpeg/CLI 可用，或改用 video_probe/原生 video_storyboard。` }
      }
    }),
  })

  // ③ 分镜总览（窗口可指定、可多张）
  register({
    name: 'video_storyboard',
    summary: 'Storyboard grid(s) for a local video window: numbered cells with times and transcript, one image for several frames.',
    description: 'Use it to actually look at a stretch of video. Pass from/to to keep it cheap; cells 1-16 (auto if omitted); '
      + 'sheets up to 4 for long windows. textOnly=true returns only the citeable index (no image, no frame decode).',
    when: ['you need to know what happens in a stretch of a local video', 'the video has no subtitles and the picture is the point'],
    avoid: ['very long stretches without from/to', 'Bilibili URLs - use the DSH video_storyboard tool for links'],
    parameters: {
      type: 'object', additionalProperties: false, required: ['path'],
      properties: {
        path: { type: 'string', description: 'Absolute path to a local video file.' },
        from: { type: 'number', description: 'Window start seconds (default 0).' },
        to: { type: 'number', description: 'Window end seconds (default end of file).' },
        cells: { type: 'number', description: 'Cells per image 1-16; omit for automatic density-based choice.' },
        sheets: { type: 'number', description: 'How many images 1-4 (default 1).' },
        detail: { type: 'string', description: 'Transcript chars per cell: low 60 / med 120 / high 400 (default med).' },
        textOnly: { type: 'boolean', description: 'Only return the text index, no image (cheap paging).' },
      },
    },
    execute: guard(cfg, async ({ path: raw, from = 0, to = 0, cells = 0, sheets = 1, detail = 'med', textOnly = false }) => {
      requireCli(cfg)
      const file = checkFile(raw, cfg)
      if (!file.ok) return fail(file.error.code, file.error.message, file.error.next)
      const info = await probeVideo(file.path, { ffprobe: cfg.ffprobe })
      const window = {
        from: Math.max(0, Number(from) || 0),
        to: Math.min(Number(to) || info.duration, info.duration || Number(to) || 0),
      }
      if (window.to <= window.from) return fail('E_BAD_RANGE', `窗口 ${window.from}-${window.to}s 不合法`, 'from 要小于 to，且都在片长内。')
      const run = await runStoryboard({
        input: file.path, ...window,
        cells: Math.min(16, Math.max(0, Number(cells) || 0)),
        sheets: Math.min(4, Math.max(1, Number(sheets) || 1)),
        detail: ['low', 'med', 'high'].includes(String(detail)) ? String(detail) : 'med',
        textOnly: textOnly === true,
        cli: cfg.cli, workDir: makeWorkDir(cfg.stateDir, 'storyboard'),
        maxTextChars: cfg.maxTextChars,
      })
      const text = run.textBlock || '（CLI 没有输出清单；可能是空窗口或工具版本差异）'
      return textOnly ? { text } : { text, images: run.sheets.slice(0, 4) }
    }),
  })

  // ④ 近距离回看
  register({
    name: 'video_zoom',
    summary: 'Re-read a short window at higher per-cell resolution: fewer, bigger cells for faces, subtitles, on-screen text.',
    description: 'Use after video_storyboard when one cell needs a closer look. Default cells 6 and minGap 0.4 so half-second shots get a cell.',
    when: ['a storyboard cell looks important but too small to read'],
    avoid: ['covering the whole video - zoom is for a few seconds to about a minute'],
    parameters: {
      type: 'object', additionalProperties: false, required: ['path', 'from', 'to'],
      properties: {
        path: { type: 'string', description: 'Absolute path to a local video file.' },
        from: { type: 'number', description: 'Window start seconds.' },
        to: { type: 'number', description: 'Window end seconds.' },
        cells: { type: 'number', description: 'Cells 1-9 (default 6).' },
        minGap: { type: 'number', description: 'Minimum spacing between cells (default 0.4 for fast cuts).' },
      },
    },
    execute: guard(cfg, async ({ path: raw, from, to, cells = 6, minGap = 0.4 }) => {
      requireCli(cfg)
      const file = checkFile(raw, cfg)
      if (!file.ok) return fail(file.error.code, file.error.message, file.error.next)
      const info = await probeVideo(file.path, { ffprobe: cfg.ffprobe })
      const window = ensureRange(from, to, info.duration)
      if (window.to - window.from > 180) return fail('E_BAD_RANGE', `窗口 ${(window.to - window.from).toFixed(0)}s 太长，zoom 不要超过 3 分钟`, '先用 video_storyboard 定位，再用 video_zoom 看 5–60 秒。')
      const run = await runStoryboard({
        input: file.path, ...window,
        cells: Math.min(9, Math.max(1, Number(cells) || 6)),
        sheets: 1, detail: 'high',
        minGap: Number.isFinite(Number(minGap)) ? Number(minGap) : 0.4,
        adaptive: false,
        cli: cfg.cli, workDir: makeWorkDir(cfg.stateDir, 'zoom'),
        maxTextChars: cfg.maxTextChars,
      })
      return { text: run.textBlock || '（没有清单输出）', images: run.sheets.slice(0, 1) }
    }),
  })

  // ⑤ 纯文本定位：知道说了什么，不知道在第几分钟
  register({
    name: 'video_locate',
    summary: 'Find where a phrase is spoken in a local video: timestamped cells, text only (no frames decoded for you).',
    description: 'Needs a transcript: use a video with a subtitle track, or pass transcriptFile (SRT/JSON). '
      + 'If there is no transcript yet, run video_storyboard first (it builds the cache) or pass transcriptFile.',
    when: ['you remember roughly what was said but not when'],
    avoid: ['silent videos with no transcript - use video_storyboard instead'],
    parameters: {
      type: 'object', additionalProperties: false, required: ['path', 'query'],
      properties: {
        path: { type: 'string', description: 'Absolute path to a local video file.' },
        query: { type: 'string', description: 'Phrase to find (Chinese or English).' },
        from: { type: 'number', description: 'Only search after this second.' },
        to: { type: 'number', description: 'Only search before this second.' },
        max: { type: 'number', description: 'How many matches 1-20 (default 5).' },
        transcriptFile: { type: 'string', description: 'Optional SRT/JSON transcript to use instead of the embedded subtitle track.' },
      },
    },
    execute: guard(cfg, async ({ path: raw, query, from = 0, to = 0, max = 5, transcriptFile = null }) => {
      requireCli(cfg)
      const file = checkFile(raw, cfg)
      if (!file.ok) return fail(file.error.code, file.error.message, file.error.next)
      const result = await locateInTranscript({
        input: file.path, query, from, to, max: Math.min(20, Math.max(1, Number(max) || 5)),
        transcriptFile, cli: cfg.cli, workDir: makeWorkDir(cfg.stateDir, 'locate'),
      })
      if (!result.ok) {
        if (result.reason === 'E_NO_TRANSCRIPT') {
          return { text: '这个文件没有可用台词/转写，定位不了。\n下一步：先 video_storyboard 看画面（有字幕轨会带上台词）；或导出 SRT/JSON 后用 transcriptFile 再调 video_locate；纯音乐/无对白就按画面看。' }
        }
        return fail('E_ARGS', 'query 不能为空', '给一句要找回的原话。')
      }
      if (!result.matches.length) {
        return { text: `没找到「${query}」（共 ${result.cells} 格、有台词的格都查过了）。\n下一步：换一句更短的原话；或先用 video_storyboard 看画面。` }
      }
      const lines = [`「${query}」命中 ${result.total} 处（显示前 ${result.matches.length} 处）：`]
      for (const m of result.matches) {
        lines.push(`- 第 ${m.i} 格 ${TC(m.from)}–${TC(m.to)}：…${m.quote}…`)
      }
      lines.push('下一步：对命中的段用 video_zoom（from/to）看清画面。')
      return { text: lines.join('\n') }
    }),
  })

  // ⑥ 精确单帧/多帧
  register({
    name: 'video_frames',
    summary: 'Exact frame(s) at given seconds of a local video: one frame, or up to 6 tiled into one image.',
    description: 'Use it when you know the moment ("at 37.5s") and need the picture itself. '
      + 'Multiple times are tiled row-first into one image to save tokens; the text lists which tile is which second.',
    when: ['a specific timestamp matters', 'you want to compare a few exact moments'],
    avoid: ['exploring an unknown stretch - use video_storyboard'],
    parameters: {
      type: 'object', additionalProperties: false, required: ['path'],
      properties: {
        path: { type: 'string', description: 'Absolute path to a local video file.' },
        times: { type: 'array', items: { type: 'number' }, description: 'Seconds to capture, 1-6 values (sorted/deduped automatically).' },
        at: { type: 'number', description: 'Single timestamp in seconds (alternative to times).' },
      },
    },
    execute: guard(cfg, async ({ path: raw, times = null, at = null }) => {
      const file = checkFile(raw, cfg)
      if (!file.ok) return fail(file.error.code, file.error.message, file.error.next)
      const list = Array.isArray(times) && times.length ? times : (at == null ? null : [at])
      if (!list) return fail('E_ARGS', '给 times（1–6 个秒数）或 at（单个秒数）', '例如 times:[12.5, 31] 或 at:37.5。')
      const run = await extractFrames({
        input: file.path, times: list, workDir: makeWorkDir(cfg.stateDir, 'frames'),
        ffmpeg: cfg.ffmpeg,
      })
      const lines = [
        run.times.length === 1
          ? `第 ${TC(run.times[0])} 帧`
          : `已抽 ${run.times.length} 帧，拼成一张图（按行优先：${run.times.map((t, i) => `#${i + 1}=${TC(t)}`).join(' / ')}）`,
      ]
      if (run.sheet) lines.push('多帧时每格约 360px 高；要看单帧就只传一个时间。')
      return { text: lines.join('\n'), images: run.sheet ? [run.sheet] : run.frames }
    }),
  })

  ctx.log?.({ msg: 'video.ready', tools: tools.length, stateDir: cfg.stateDir, cli: cfg.cli ? 'ok' : 'missing' })
  return () => { for (const off of tools.reverse()) { try { off?.() } catch { /* 单个注销失败不影响其余 */ } } }
}
