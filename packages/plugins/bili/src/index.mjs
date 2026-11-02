// B 站接缝：不复制 bili-duty 的代码，只调用它现成的工具。
// 外部应用（bili-duty 的 MCP server）保持独立，我们只做参数转换和结果截断。
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'bili'

const PY = String(process.env.BILI_PYTHON ?? 'C:\\Users\\ai_admin\\.dsh\\bili-duty\\.venv\\Scripts\\python.exe')
const RUNNER = path.join(process.cwd(), 'tools', 'bili-run.py')
const STORYBOARD_CLI = process.env.STORYBOARD_CLI ?? 'C:\\Users\\ai_admin\\.dsh\\profiles\\desktop\\node_modules\\dsh-video-storyboard\\bin\\storyboard.mjs'

function callTool(fn, args, { timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    execFile(PY, [RUNNER, fn, JSON.stringify(args)], { timeout, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8', BILI_DIR: process.env.BILI_DIR ?? 'C:\\Users\\ai_admin\\.dsh\\bili-duty' } }, (error, stdout, stderr) => {
      if (error) return resolve({ ok: false, error: String(error.message || error) })
      const text = String(stdout ?? '').trim()
      if (!text) return resolve({ ok: false, error: String(stderr ?? '').slice(0, 200) || 'empty' })
      resolve({ ok: true, text })
    })
  })
}

export function apply(ctx) {
  const limit = Number(ctx.config.maxChars ?? 6000)

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
    summary: 'Open a Bilibili video by link or BV id: title, description, stats, and subtitles if any.',
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
    summary: 'Read comments on a Bilibili video (read only).',
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
    summary: 'Look at the actual frames of a Bilibili video: returns a storyboard image path plus a timeline, so you can see what happens instead of guessing from the title.',
    when: ['a video has no subtitles', 'the title or description is not enough to know what it shows'],
    avoid: ['very long videos - pass from/to to look at one stretch'],
    parameters: {
      type: 'object', additionalProperties: false, required: ['target'],
      properties: {
        target: { type: 'string', description: 'Bilibili URL or BV id.' },
        from: { type: 'number' }, to: { type: 'number' },
        cells: { type: 'number', description: '1-16, default 6.' },
      },
    },
    async execute({ target, from = null, to = null, cells = 6 } = {}) {
      const m = String(target).match(/BV[0-9A-Za-z]{8,12}/)
      const bvid = m ? m[0] : String(target).trim()
      const url = bvid.startsWith('http') ? bvid : `https://www.bilibili.com/video/${bvid}`
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-board-'))
      const sheet = path.join(dir, 'sheet.png')
      const manifest = path.join(dir, 'm.json')
      const args = [STORYBOARD_CLI, url, '--cells', String(Math.min(16, Math.max(1, Number(cells) || 6))), '--out', sheet, '--manifest', manifest, '--allow-anonymous']
      if (Number.isFinite(Number(from))) args.push('--from', String(from))
      if (Number.isFinite(Number(to))) args.push('--to', String(to))
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
      return { text: `已切好宫格图：${sheet}\n${timeline}`, imagePath: sheet }
    },
  })

  ctx.log({ msg: 'bili.ready' })
}
