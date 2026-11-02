// B 站接缝：不复制 bili-duty 的代码，只调用它现成的工具。
// 外部应用（bili-duty 的 MCP server）保持独立，我们只做参数转换和结果截断。
import { execFile } from 'node:child_process'
import path from 'node:path'

export const name = 'bili'

const PY = String(process.env.BILI_PYTHON ?? 'C:\\Users\\ai_admin\\.dsh\\bili-duty\\.venv\\Scripts\\python.exe')
const RUNNER = path.join(process.cwd(), 'tools', 'bili-run.py')

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

  ctx.log({ msg: 'bili.ready' })
}
