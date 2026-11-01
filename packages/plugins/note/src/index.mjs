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

  const openNotes = () => memory.query({ namespace: 'note', kind: 'note', limit: 200 })
    .filter((n) => (n.data?.status ?? 'open') === 'open')

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

  function count() { return openNotes().length }

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
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute() {
      const rows = openNotes()
      if (!rows.length) return { text: '没有待办。' }
      return { text: rows.map((r) => `· ${r.text}`).join('\n') }
    },
  })

  ctx.services.provide('note', { add, resolve, count, open: openNotes })
  ctx.log({ msg: 'note.ready', open: count() })
}
