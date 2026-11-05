// 最小文件编辑器：够她记笔记、翻自己的东西，不碰系统目录。
import fs from 'node:fs'
import path from 'node:path'

export const name = 'editor'

export function apply(ctx) {
  const root = path.resolve(String(ctx.config.root ?? process.cwd()))
  const maxBytes = Math.max(1024, Number(ctx.config.maxBytes ?? 256 * 1024))

  const inside = (p) => {
    const full = path.resolve(root, p)
    return full === root || full.startsWith(root + path.sep) ? full : null
  }

  ctx.tools.register({
    name: 'read_file',
    summary: 'Read a text file inside your workspace.',
    when: ['you want to look at something you or the user wrote'],
    avoid: ['binary or huge files'],
    parameters: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string' } } },
    async execute({ path: p } = {}) {
      const full = inside(p)
      if (!full) return { text: '不在工作区里。' }
      try {
        const st = fs.statSync(full)
        if (st.size > maxBytes) return { text: `文件太大（${st.size} 字节 > ${maxBytes}）。` }
        const body = fs.readFileSync(full, 'utf8')
        // 截断必须说出来，否则模型会以为读到了全文。
        if (body.length > 20000) return { text: `${body.slice(0, 20000)}\n…（已截断：文件还有 ${body.length - 20000} 字）` }
        return { text: body }
      } catch (error) { return { text: `读不到这个文件：${String(error?.code ?? error?.message ?? error)}` } }
    },
  })

  ctx.tools.register({
    name: 'write_file',
    summary: 'Write a text file inside your workspace. Overwrites by default; pass append:true to add to the end instead.',
    when: ['you want to keep notes or draft something', 'use append:true when adding to a note you already wrote today, otherwise you erase it'],
    avoid: ['editing code you do not understand'],
    parameters: {
      type: 'object', additionalProperties: false, required: ['path', 'text'],
      properties: { path: { type: 'string' }, text: { type: 'string' }, append: { type: 'boolean', description: 'true = add to the end instead of replacing the file' } },
    },
    async execute({ path: p, text, append = false } = {}) {
      const full = inside(p)
      if (!full) return { text: '不在工作区里。' }
      try {
        fs.mkdirSync(path.dirname(full), { recursive: true })
        if (append) fs.appendFileSync(full, String(text ?? ''), 'utf8')
        else fs.writeFileSync(full, String(text ?? ''), 'utf8')
        return { text: append ? '追加好了。' : '写好了。' }
      } catch (error) { return { text: `写不进去：${String(error?.code ?? error?.message ?? error)}` } }
    },
  })

  ctx.tools.register({
    name: 'list_dir',
    summary: 'List files in a workspace directory.',
    when: ['you want to find where something is'],
    avoid: ['listing huge trees'],
    parameters: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' } } },
    async execute({ path: p = '.' } = {}) {
      const full = inside(p)
      if (!full) return { text: '不在工作区里。' }
      try {
        const all = fs.readdirSync(full, { withFileTypes: true })
        const entries = all.slice(0, 100)
        const lines = entries.map((e) => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`).join('\n')
        if (!lines) return { text: '空目录。' }
        return { text: all.length > entries.length ? `${lines}\n…（还有 ${all.length - entries.length} 项没列）` : lines }
      } catch (error) { return { text: `打不开这个目录：${String(error?.code ?? error?.message ?? error)}` } }
    },
  })

  ctx.log({ msg: 'editor.ready', root })
}
