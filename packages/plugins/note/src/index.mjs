// note：被动的备忘录。
//
// 它不是记忆（不进 recall），只是"还有几件事没了"。
// 两个来源：
//   1. 主会话自己写的小纸条（memo）
//   2. 做梦/整理发现的不确定项（直接写服务）
//
// 对外只暴露两件事：写一条、看还剩几条；提醒方式是把计数交给世界状态，
// 不往对话里推消息，也不在这里教她怎么问——怎么问属于人格层。
export const name = 'note'

export function apply(ctx) {
  const memory = ctx.services.require('memory')
  memory.registerNamespace({ id: 'note', label: '备忘', recallable: false, owner: 'note' })

  const rows = () => memory.query({ namespace: 'note', kind: 'note', limit: 500, order: 'desc' })
  const isOpen = (n) => (n.data?.status ?? 'open') === 'open'
  const openNotes = () => rows().filter(isOpen)
  const KIND_LABEL = { memo: '待办', question: '待查', promise: '答应过的' }
  const kindLabel = (row) => KIND_LABEL[String(row?.data?.kind ?? '')] ?? '惦记'
  const dayOf = (value) => {
    const d = new Date(Number(value))
    return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`
  }

  function add({ text, about = null, raisedBy = 'session', kind = 'memo' } = {}) {
    const body = String(text ?? '').trim()
    if (!body) return { ok: false, error: 'empty' }
    const created = memory.put({
      namespace: 'note', kind: 'note', text: body.slice(0, 400),
      data: { status: 'open', raisedBy, kind, about, createdAt: ctx.now() },
    })
    ctx.log({ msg: 'note.added', id: created.id, raisedBy, kind })
    return { ok: true, id: created.id }
  }

  function resolve(id, { answer = null } = {}) {
    const row = memory.query({ namespace: 'note', kind: 'note', id, limit: 1 })[0]
    if (!row) return { ok: false, error: 'not-found' }
    memory.patch(row.id, { data: { ...(row.data ?? {}), status: 'resolved', answer, resolvedAt: ctx.now() } })
    return { ok: true, id: row.id }
  }

  function count() {
    return memory.count({ namespace: 'note', kind: 'note', status: 'open' })
  }

  /** 往一条备忘里追加内容：状态不变，问题仍然可见可继续补。 */
  function append(id, text) {
    const body = String(text ?? '').trim()
    if (!body) return { ok: false, error: 'empty' }
    const row = memory.query({ namespace: 'note', kind: 'note', id, limit: 1 })[0]
    if (!row) return { ok: false, error: 'not-found' }
    const updates = [...(row.data?.updates ?? []), { text: body, at: ctx.now() }]
    memory.patch(row.id, { data: { ...(row.data ?? {}), updates } })
    return { ok: true, id: row.id, updates: updates.length }
  }

  /** 标记完成：把追加内容冻成"新消息"，等做梦回收后归档。 */
  function commit(id, { result = null, source = null } = {}) {
    const row = memory.query({ namespace: 'note', kind: 'note', id, limit: 1 })[0]
    if (!row) return { ok: false, error: 'not-found' }
    memory.patch(row.id, {
      data: { ...(row.data ?? {}), status: 'done', result: result == null ? null : String(result), source: source == null ? null : String(source), doneAt: ctx.now() },
    })
    return { ok: true, id: row.id, status: 'done' }
  }

  // 未闭合的事由 note 自己的 purpose 契约段呈现（见下方），
  // 世界状态只保留“还有几件”的旧来源会制造第二套口径，已移除。

  function purposeText() {
    const items = openNotes().sort((a, b) => Number(a.createdAt) - Number(b.createdAt)).slice(0, 3)
    if (!items.length) return ''
    const lines = [
      '【心里惦记的事】',
      '（这些不是任务清单，是你自己没放下的事：合适的时候自己提，不需要每轮都提，也不要为了提而提。）',
      ...items.map((row) => `- （${kindLabel(row)} · ${dayOf(row.createdAt)}）#${row.id} ${String(row.text ?? '').slice(0, 100)}`),
      '（想看全部用 memos；有结论用 memo_commit，补充用 memo_append。）',
    ]
    return lines.join('\n')
  }

  ctx.tools.register({
    name: 'memo',
    summary: '给自己留一条待办/惦记的事，之后可以回来处理。',
    when: ['你想晚点再处理一件事', '你想记住一个还没解决的问题'],
    avoid: ['过去发生过的事实（用 remember）'],
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { text: { type: 'string', description: '一两句话的小纸条。' } },
      required: ['text'],
    },
    async execute({ text } = {}) {
      const out = add({ text, raisedBy: 'session', kind: 'memo' })
      return { text: out.ok ? '记下了。' : '没写成。' }
    },
  })

  ctx.tools.register({
    name: 'memos',
    summary: '查看所有还没了结的备忘/待查；默认不按日期过滤。',
    when: ['你想看看自己还惦记着什么', '事实里出现“心里惦记”时'],
    avoid: ['找过去的记忆（用 recall）'],
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        all: { type: 'boolean', description: '兼容旧参数，默认已经返回全部 open 项。' },
        done: { type: 'boolean', description: '是否连已完成的项一起列出。' },
      },
    },
    async execute({ done = false } = {}) {
      const picked = rows().filter((row) => done || isOpen(row))
      if (!picked.length) return { text: '没有待办。' }
      return { text: picked.map((row) => {
        const upd = (row.data?.updates ?? []).map((u) => `\n  + ${u.text}`).join('')
        return `· #${row.id} [${kindLabel(row)} · ${dayOf(row.createdAt)}] ${row.text}${upd}`
      }).join('\n') }
    },
  })

  ctx.tools.register({
    name: 'memo_append',
    summary: 'Add a line to an existing note - new evidence, a partial answer, something you learned.',
    when: ['you found part of the answer and the note is still open'],
    avoid: ['writing a brand new note (use memo)'],
    parameters: {
      type: 'object', additionalProperties: false, required: ['id', 'text'],
      properties: { id: { type: 'number' }, text: { type: 'string' } },
    },
    async execute({ id, text } = {}) {
      const out = append(id, text)
      return { text: out.ok ? '补上了。' : '没补上（找不到那条）。' }
    },
  })

  ctx.tools.register({
    name: 'memo_commit',
    summary: 'Mark a note finished, with what you concluded.',
    when: ['the question is answered or no longer matters'],
    avoid: ['marking something done that you only partly answered (append instead)'],
    parameters: {
      type: 'object', additionalProperties: false, required: ['id'],
      properties: { id: { type: 'number' }, result: { type: 'string' }, source: { type: 'string', description: 'Where the answer came from, e.g. a URL.' } },
    },
    async execute({ id, result = null, source = null } = {}) {
      const out = commit(id, { result, source })
      return { text: out.ok ? '完成了。' : '没找到那条。' }
    },
  })

  ctx.tools.register({
    name: 'note_status',
    summary: 'How many notes are open, done, or archived - just counts, no content.',
    when: ['you want a quick sense of how much is pending'],
    avoid: ['when you need the actual text (use memos)'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute() {
      const open = memory.count({ namespace: 'note', kind: 'note', status: 'open' })
      const done = memory.count({ namespace: 'note', kind: 'note', status: 'done' })
      const archived = memory.count({ namespace: 'note', kind: 'note', status: 'archived' })
      return { text: `待办 ${open} 条，已完成待回收 ${done} 条，已归档 ${archived} 条。` }
    },
  })

  // 未闭合事项的“惦记”契约：只有 note 的读取/收尾工具都在时才出现。
  // 工具说明负责“怎么用”；这里只负责“什么时候、以什么语气出现”。
  try {
    ctx.contracts?.registerFeature({
      id: 'purpose',
      order: 879,
      prompt: purposeText,
      requiresTools: ['memos', 'memo_commit'],
    })
  } catch (error) {
    ctx.log({ level: 'warn', msg: 'note.purpose-contract', error: String(error?.message ?? error) })
  }

  ctx.services.provide('note', { add, append, commit, resolve, count, open: openNotes })
  ctx.log({ msg: 'note.ready', open: count() })
}
