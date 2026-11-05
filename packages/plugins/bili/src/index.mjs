// B 站接缝：不复制 bili-duty 的代码，只调用它现成的工具。
// 外部应用（bili-duty 的 MCP server）保持独立，我们只做参数转换和结果截断。
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'bili'

const PY = String(process.env.BILI_PYTHON ?? 'C:\\Users\\ai_admin\\.dsh\\bili-duty\\.venv\\Scripts\\python.exe')
// 不能用 cwd：DSH 进程的 cwd 不是我们的仓库
const ICL_ROOT = process.env.ICL_ROOT ?? 'C:/DSH/qwenstuff/icl'
const RUNNER = process.env.BILI_RUNNER ?? path.join(ICL_ROOT, 'tools', 'bili-run.py')
const STORYBOARD_CLI = process.env.STORYBOARD_CLI ?? 'C:\\Users\\ai_admin\\.dsh\\profiles\\desktop\\node_modules\\dsh-video-storyboard\\bin\\storyboard.mjs'
const BILI_DIR = process.env.BILI_DIR ?? 'C:\\Users\\ai_admin\\.dsh\\bili-duty'

/**
 * 依赖预检：换机器时最常见的是"解释器/桥接脚本不在"。
 * 直接抛 execFile 的栈是没法行动的，所以分开说清楚缺哪一个、怎么补。
 * 返回 null = 可用，否则返回给模型看的错误串。
 */
function preflight(kind) {
  if (kind === 'frames') {
    if (!fs.existsSync(STORYBOARD_CLI)) {
      return `看不成画面：找不到 storyboard CLI（${STORYBOARD_CLI}）。用 STORYBOARD_CLI 环境变量指向 dsh-video-storyboard 的 bin/storyboard.mjs。文字类工具（bili_watch / bili_comments）不受影响。`
    }
    return null
  }
  const missing = []
  if (!fs.existsSync(PY)) missing.push(`python 解释器（${PY}）→ 用 BILI_PYTHON 指向 bili-duty 的 .venv\\Scripts\\python.exe`)
  if (!fs.existsSync(RUNNER)) missing.push(`桥接脚本（${RUNNER}）→ 用 BILI_RUNNER 或 ICL_ROOT 指向 bili-run.py 所在仓库`)
  if (!fs.existsSync(BILI_DIR)) missing.push(`bili-duty 目录（${BILI_DIR}）→ 用 BILI_DIR 指过去`)
  if (!missing.length) return null
  return `用不了 bili：缺 ${missing.join('；')}。这是本机接缝，补齐路径后重试（不是视频或网络的问题）。`
}

function callTool(fn, args, { timeout = 60000 } = {}) {
  const blocked = preflight('tools')
  if (blocked) return Promise.resolve({ ok: false, error: blocked, missingDeps: true })
  return new Promise((resolve) => {
    execFile(PY, [RUNNER, fn, JSON.stringify(args)], { timeout, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8', BILI_DIR } }, (error, stdout, stderr) => {
      if (error) return resolve({ ok: false, error: String(error.message || error) })
      const text = String(stdout ?? '').trim()
      if (!text) return resolve({ ok: false, error: String(stderr ?? '').slice(0, 200) || 'empty' })
      resolve({ ok: true, text })
    })
  })
}

async function describeSheet(ctx, sheetPath) {
  const vision = ctx.services?.vision
  if (!vision?.describe) return ''
  try {
    return await vision.describe({
      path: sheetPath,
      config: { ...(ctx.config.vision ?? {}) },
      system: '你在看一张视频关键帧宫格图。用中文逐格描述画面里实际发生的事：人物、动作、字幕文字、场景变化。只描述看到的，不要猜剧情。',
      prompt: '这些格子按时间顺序排列，请逐格说明。',
      maxTokens: 700,
    })
  } catch { return '' }
}

export function apply(ctx) {
  const limit = Number(ctx.config.maxChars ?? 6000)
  const vision = { ...(ctx.config.vision ?? {}) }

  ctx.tools.register({
    name: 'bili_search',
    summary: 'Search Bilibili for videos: titles, uploaders, view counts.',
    when: ['you want to find something to watch or learn from'],
    avoid: ['when you already have a link'],
    parameters: {
      type: 'object', additionalProperties: false, required: ['keyword'],
      properties: {
        keyword: { type: 'string' },
        num: { type: 'number', description: 'How many results, default 8.' },
        order: { type: 'string', description: 'totalrank | click | pubdate | dm' },
      },
    },
    async execute({ keyword, num = 8, order = 'totalrank' } = {}) {
      const out = await callTool('bili_search', { keyword, num, order })
      return { text: out.ok ? String(out.text).slice(0, limit) : `搜不动：${out.error}` }
    },
  })

  ctx.tools.register({
    name: 'bili_watch',
    summary: 'Open a Bilibili video: title, description, stats, and subtitles when available. If it has no subtitles or you need to see what happens, use bili_frames next.',
    when: ['a video looks interesting and you want to know what it actually says'],
    avoid: ['using it as a search tool'],
    parameters: {
      type: 'object', additionalProperties: false, required: ['target'],
      properties: { target: { type: 'string', description: 'A URL or BV id.' } },
    },
    async execute({ target } = {}) {
      const m = String(target).match(/BV[0-9A-Za-z]{8,12}/)
      const bvid = m ? m[0] : String(target).trim()
      const info = await callTool('bili_video_info', { bvid })
      if (!info.ok) return { text: `打不开：${info.error}` }
      let text = String(info.text)
      const sub = await callTool('bili_subtitle', { bvid })
      if (sub.ok && String(sub.text).trim().length > 20) {
        text += `\n\n--- 字幕/摘要 ---\n${String(sub.text).slice(0, limit)}`
      }
      return { text: text.slice(0, limit) }
    },
  })

  ctx.tools.register({
    name: 'bili_comments',
    summary: 'Read the top comments and their top replies on a Bilibili video (read only).',
    when: ['you want to know how people reacted'],
    avoid: ['replying - this tool cannot comment'],
    parameters: {
      type: 'object', additionalProperties: false, required: ['target'],
      properties: { target: { type: 'string' }, num: { type: 'number' } },
    },
    async execute({ target, num = 10 } = {}) {
      const m = String(target).match(/BV[0-9A-Za-z]{8,12}/)
      const bvid = m ? m[0] : String(target).trim()
      const out = await callTool('bili_comments', { bvid, num })
      return { text: out.ok ? String(out.text).slice(0, limit) : `读不到评论：${out.error}` }
    },
  })

  // 看画面：把 B 站视频交给 dsh-video-storyboard 的 CLI，拿回宫格图 + 时间轴
  ctx.tools.register({
    name: 'bili_frames',
    summary: 'Storyboard grid FILE for a video: the picture is NOT attached - you get the timeline and a file path to open with read_file.',
    description: 'Use it when a video has no subtitles or the visual content is the point. It writes the grid to disk and reports the path; read that file to actually look at the frames. For long videos pass from/to to scan one stretch.',
    when: ['a video has no subtitles', 'the title or description is not enough to know what it shows'],
    avoid: ['very long videos - pass from/to to look at one stretch'],
    parameters: {
      type: 'object', additionalProperties: false, required: ['target'],
      properties: {
        target: { type: 'string', description: 'Bilibili URL or BV id.' },
        from: { type: 'number' }, to: { type: 'number' },
        cells: { type: 'number', description: '1-16, default 6. Long videos: pass from/to, otherwise only the first 4 minutes are scanned.' },
      },
    },
    async execute({ target, from = null, to = null, cells = 6 } = {}) {
      const blocked = preflight('frames')
      if (blocked) return { text: blocked }
      const m = String(target).match(/BV[0-9A-Za-z]{8,12}/)
      const bvid = m ? m[0] : String(target).trim()
      const url = bvid.startsWith('http') ? bvid : `https://www.bilibili.com/video/${bvid}`
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-board-'))
      const sheet = path.join(dir, 'sheet.png')
      const manifest = path.join(dir, 'm.json')
      const args = [STORYBOARD_CLI, url, '--cells', String(Math.min(16, Math.max(1, Number(cells) || 6))), '--out', sheet, '--manifest', manifest, '--allow-anonymous']
      const start = Number.isFinite(Number(from)) ? Number(from) : 0
      const end = Number.isFinite(Number(to)) ? Number(to) : start + 240
      args.push('--from', String(start), '--to', String(end), '--scan-height', '240')
      try {
        execFileSync(process.execPath, args, { timeout: 600000, maxBuffer: 8 * 1024 * 1024 })
      } catch (error) {
        return { text: `看不成画面：${String(error?.message ?? error).slice(0, 200)}` }
      }
      let timeline = ''
      try {
        const data = JSON.parse(fs.readFileSync(manifest, 'utf8'))
        const sheets = data.sheets ?? []
        const cellsList = sheets.flatMap((s) => s.cells ?? [])
        const secs = (v) => `${Math.round(Number(v) || 0)}s`
        timeline = cellsList.slice(0, 16).map((c) => `#${c.i ?? ''} ${secs(c.t_start)}–${secs(c.t_end)}`).join(' / ')
        if (data.transcript?.chars) timeline += `\n字幕：${String(data.transcript.chars)} 字`
      } catch { /* manifest 缺失也没关系 */ }
      const described = ctx.config.visionEnabled === false ? '' : await describeSheet(ctx, sheet)
      const lines = [
        `已切好宫格图：${sheet}`,
        // 别让模型以为画面已经在眼前：DSH 只收到这句文本 + 路径。
        '（这张图没有直接发给你；要看画面就用 read_file 读上面这个路径。）',
        timeline,
      ]
      if (described) lines.push('', '画面描述：', described)
      return { text: lines.join('\n').slice(0, limit), imagePath: sheet }
    },
  })

  ctx.log({ msg: 'bili.ready' })
}
