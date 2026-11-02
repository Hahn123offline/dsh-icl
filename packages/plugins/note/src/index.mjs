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

  const rows = () => memory.query({ namespace: 'note', kind: 'note', limit: 500 })
  const isOpen = (n) => (n.data?.status ?? 'open') === 'open'
  const openNotes = () => rows().filter(isOpen)

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
    const rows = memory.query({ namespace: 'note', kind: 'note', limit: 200 })
    const row = rows.find((r) => Number(r.id) === Number(id))
    if (!row) return { ok: false, error: 'not-found' }
    memory.patch(row.id, { data: { ...(row.data ?? {}), status: 'resolved', answer, resolvedAt: ctx.now() } })
    return { ok: true, id: row.id }
  }

  function dayKeyOf(row) {
    const d = new Date(Number(row.createdAt))
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
  }

  function count() { return openNotes().length }

  /** 往一条备忘里追加内容：状态不变，问题仍然可见可继续补。 */
  function append(id, text) {
    const body = String(text ?? '').trim()
    if (!body) return { ok: false, error: 'empty' }
    const row = rows().find((r) => Number(r.id) === Number(id))
    if (!row) return { ok: false, error: 'not-found' }
    const updates = [...(row.data?.updates ?? []), { text: body, at: ctx.now() }]
    memory.patch(row.id, { data: { ...(row.data ?? {}), updates } })
    return { ok: true, id: row.id, updates: updates.length }
  }

  /** 标记完成：把追加内容冻成"新消息"，等做梦回收后归档。 */
  function commit(id, { result = null } = {}) {
    const row = rows().find((r) => Number(r.id) === Number(id))
    if (!row) return { ok: false, error: 'not-found' }
    memory.patch(row.id, {
      data: { ...(row.data ?? {}), status: 'done', result: result == null ? null : String(result), doneAt: ctx.now() },
    })
    return { ok: true, id: row.id, status: 'done' }
  }

  // 世界状态里挂一条"还有几件事"（有世界状态插件时才挂，不强制依赖）
  try {
    const world = ctx.services.get('world')
    if (world?.registerSource) {
      world.registerSource({
        id: 'note', owner: 'note', title: '待办', order: 5, cap: 1,
        items: () => {
          const n = count()
          return n > 0 ? [{ key: 'open', brief: `还有 ${n} 件事没了结。` }] : []
        },
      })
    }
  } catch { /* 没有世界状态也不影响备忘录本身 */ }

  ctx.tools.register({
    name: 'memo',
    summary: 'Leave yourself a small note about something you do not want to forget to do.',
    when: ['you want to come back to something later in this session'],
    avoid: ['facts about the past (use remember)'],
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { text: { type: 'string', description: 'The note, one or two sentences.' } },
      required: ['text'],
    },
    async execute({ text } = {}) {
      const out = add({ text, raisedBy: 'session', kind: 'memo' })
      return { text: out.ok ? '记下了。' : '没写成。' }
    },
  })

  ctx.tools.register({
    name: 'memos',
    summary: 'See how many notes you left open, and what they are.',
    when: ['you want to check what you were going to come back to'],
    avoid: ['when you are looking for a memory (use recall)'],
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        all: { type: 'boolean', description: 'Include items from previous days.' },
        done: { type: 'boolean', description: 'Include finished items too.' },
      },
    },
    async execute({ all = false, done = false } = {}) {
      const day = new Date(ctx.now()); const today = `${day.getFullYear()}-${day.getMonth() + 1}-${day.getDate()}`
      const picked = rows().filter((r) => (all || dayKeyOf(r) === today) && (done || isOpen(r)))
      if (!picked.length) return { text: '没有待办。' }
      return { text: picked.map((r) => {
        const upd = (r.data?.updates ?? []).map((u) => `\n  + ${u.text}`).join('')
        return `· ${r.text}${upd}`
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
      properties: { id: { type: 'number' }, result: { type: 'string' } },
    },
    async execute({ id, result = null } = {}) {
      const out = commit(id, { result })
      return { text: out.ok ? '完成了。' : '没找到那条。' }
    },
  })

  ctx.services.provide('note', { add, append, commit, resolve, count, open: openNotes })
  ctx.log({ msg: 'note.ready', open: count() })
}
