// 轻量记忆插件：当天可以直接记/查原文，跨天就交给梦境沉淀。
//
// 它不建自己的库——全部落在记忆插件的命名空间里（架构决定：不许有第二份）。
export const name = 'light-memory'

function nsOf(ctx) {
  const session = String(ctx.config.sessionId ?? 'default')
  return `light:${session}`
}

function dayStart(now) {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function apply(ctx) {
  const memory = ctx.services.require('memory')
  const namespace = nsOf(ctx)
  let seq = 0

  ctx.tools.register({
    name: 'remember',
    description: 'Keep a short note for yourself (things to do, a person, a running bit). Notes are private to today; at night they become long-term memory.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: { type: 'string', description: 'One concrete thing, one or two sentences.' },
        key: { type: 'string', description: 'Optional stable key to update instead of adding a new note.' },
      },
    },
    async execute({ text, key }) {
      const created = memory.put({ namespace, kind: 'note', key: key ?? `n:${ctx.now()}:${++seq}`, text, now: ctx.now() })
      return { text: created.updated ? '更新了那条笔记。' : '记下了。' }
    },
  })

  ctx.tools.register({
    name: 'recall',
    description: "Read back today's notes, optionally filtered by a word.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Optional keyword.' },
        limit: { type: 'number', description: 'How many notes (default 10).' },
      },
    },
    async execute({ query = '', limit = 10 } = {}) {
      const since = dayStart(ctx.now())
      const rows = memory.query({ namespace, limit: 200, since })
      const hits = query
        ? rows.filter((row) => row.text.toLowerCase().includes(String(query).toLowerCase()))
        : rows
      const picked = hits.slice(-Math.max(1, Number(limit) || 10))
      if (!picked.length) return { text: '今天还没有记过什么。' }
      return { text: picked.map((row) => `· ${row.text}`).join('\n') }
    },
  })

  ctx.tools.register({
    name: 'forget',
    description: 'Drop one of your notes (by key).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['key'],
      properties: { key: { type: 'string' } },
    },
    async execute({ key }) {
      const out = memory.remove({ namespace, key })
      return { text: out.removed ? '删掉了。' : '没有这条笔记。' }
    },
  })

  ctx.services.provide('light-memory', {
    namespace,
    /** 梦境用：取今天（或指定时间之后）的全部笔记。 */
    today({ now = ctx.now() } = {}) { return memory.query({ namespace, kind: 'note', since: dayStart(now), limit: 500 }) },
  })
  ctx.log({ msg: 'light-memory.ready', namespace })
}
