// 最小文件编辑器：够她记笔记、翻自己的东西，不碰系统目录。
import fs from 'node:fs'
import path from 'node:path'

export const name = 'editor'

/**
 * 统一注册表：stateDir 下所有"谁写谁负责"的运行时状态文件。editor 只能读，不能写。
 * 新增插件状态文件时在这里登记（测试会逐类检查），避免再出现漏项。
 * 相对路径统一用 "/"，匹配时也归一化为 "/"。
 */
export const PROTECTED_STATE_FILES = Object.freeze([
  'memory.db', 'state/memory.db',
  'time.json', 'time.inbox.jsonl', 'time.outbox.jsonl', 'time-events.jsonl',
  'eager-recall.jsonl',
  'focus.json', 'rhythm.json',
  'session-events.jsonl', 'mc-link.jsonl',
  'qq-ledger.db', 'state/qq-ledger.db',
  'bili/bili_credential.json', 'state/bili_credential.json',
  'loop.inbox.jsonl', 'loop.outbox.jsonl', 'loop.state.json', 'state/loop.inbox.jsonl', 'state/loop.outbox.jsonl',
  'album/media.db',
])

export function apply(ctx) {
  const root = path.resolve(String(ctx.config.root ?? process.cwd()))
  const maxBytes = Math.max(1024, Number(ctx.config.maxBytes ?? 256 * 1024))

  const inside = (p) => {
    const full = path.resolve(root, p)
    return full === root || full.startsWith(root + path.sep) ? full : null
  }

  /**
   * 工作区就是 ICL 的 stateDir，里面混着她自己的运行时状态。
   * 读没问题（她本来就该能看见"我有多少记忆"），但写会直接毁掉记忆库/日程/focus/原文层，
   * 所以 write_file 对这几个文件明确拒绝，并告诉她这是什么——不是报 EACCES 让她猜。
   */
  const PROTECTED = new Set(PROTECTED_STATE_FILES.map((rel) => path.resolve(root, rel)))
  const relativeKey = (full) => path.relative(root, full).split(path.sep).join('/')
  const protectedHit = (full) => {
    if (PROTECTED.has(full)) return path.basename(full)
    const rel = relativeKey(full)
    return PROTECTED_STATE_FILES.includes(rel) ? path.basename(full) : null
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
      const guarded = protectedHit(full)
      if (guarded) return { text: `${guarded} 是 ICL 自己的状态文件，不能写（写坏了她就失忆/失约）。要记事请写到别的文件名。` }
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
