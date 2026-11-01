// 梦境插件（M1）：被动沉淀。
//
// 由节律在夜里触发 → 取当天全部轻量记忆 → 用一个 chat 插槽写成一块总结
// → 投进记忆插件的长期命名空间。它不产生"梦的内容"，只是记忆沉淀器。
export const name = 'dream'

function dayRange(now) {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  const start = d.getTime()
  return { start, end: start + 24 * 3600_000 }
}

export function apply(ctx) {
  const memory = ctx.services.require('memory')
  const rhythm = ctx.services.require('rhythm')
  const slot = ctx.manifest.slots?.[0]?.id ?? 'dream-chat'
  const light = ctx.services.get('light-memory')
  const session = String(ctx.config.sessionId ?? 'default')

  async function run({ now = ctx.now() } = {}) {
    const { start, end } = dayRange(now)
    const notes = light
      ? light.today({ now })
      : memory.query({ namespace: `light:${session}`, kind: 'note', since: start, until: end, limit: 500 })
    if (!notes.length) return { ok: true, skipped: 'no-notes' }

    const body = notes.map((n) => `· ${n.text}`).join('\n')
    let summary = ''
    try {
      summary = await ctx.slots.call(slot, {
        messages: [
          { role: 'system', content: '把今天的笔记压成一小段第一人称的记忆，只保留真会再想起来的事。不要评价，不要总结成报告。' },
          { role: 'user', content: body },
        ],
        maxTokens: 600,
      })
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error), slot }
    }
    const text = String(summary ?? '').trim()
    if (!text) return { ok: false, error: 'empty-summary' }

    const created = memory.put({
      namespace: `dream:${session}`,
      kind: 'summary',
      key: `dream:${start}`,
      text,
      data: { from: start, to: end, notes: notes.length },
      now,
    })
    if (typeof memory.index === 'function') void memory.index(created.id, text)
    return { ok: true, id: created.id, notes: notes.length, chars: text.length }
  }

  const off = rhythm.onNightly((event) => { void run({ now: event?.at ?? ctx.now() }) })
  ctx.onDispose(off)
  // 晚启动时（今天已经过点、还没做梦）自己补一次。
  if (typeof rhythm.isDue === 'function' && rhythm.isDue()) void run()
  ctx.services.provide('dream', { run, slot })
  ctx.log({ msg: 'dream.ready', slot })
}
