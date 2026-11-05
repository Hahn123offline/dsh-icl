// 压缩：旧实现的等价物，挂在新的上下文契约上。
//
// 旧版继承官方 BasicCompactionEngine 只覆盖 summarize()；
// 新版不需要继承任何东西——注册一个 onCompact，再用 onAssemble 把摘要注回去。
export const name = 'compaction'

export function apply(ctx) {
  const memory = ctx.services.require('memory')
  const slot = ctx.manifest.slots?.[0]?.id ?? 'compact-chat'
  const keepRecent = Math.max(2, Number(ctx.config.keepRecent ?? 12))
  const maxChars = Math.max(200, Number(ctx.config.maxChars ?? 1200))
  const triggerChars = Math.max(2000, Number(ctx.config.triggerChars ?? 12_000))
  const persona = String(ctx.config.persona ?? '')

  memory.registerNamespace({ id: 'compaction', label: '折叠摘要', recallable: false, owner: 'compaction' })

  function latest() {
    return memory.query({ namespace: 'compaction', kind: 'summary', limit: 1, order: 'desc' })[0] ?? null
  }

  async function summarize(older) {
    const text = older.map((m) => `${m.role === 'user' ? '用户' : '我'}：${String(m.text ?? '').slice(0, 200)}`).join('\n')
    try {
      const out = await ctx.slots.call(slot, {
        messages: [
          {
            role: 'system',
            content: [
              persona,
              '',
              '把上面这段较早的对话，用你自己的口吻写成一小段回忆。',
              '保留事实、决定、没做完的事；不要评价，不要总结成报告。',
            ].filter(Boolean).join('\n'),
          },
          { role: 'user', content: text.slice(0, 12000) },
        ],
        maxTokens: 600,
      })
      return String(out ?? '').trim().slice(0, maxChars)
    } catch { return '' }
  }

  // 压缩实现：切掉最近 keepRecent 条，把更早的压成摘要
  ctx.services.context.onCompact({
    id: 'icl-summary',
    async compact({ history = [], keepRecent: keep = keepRecent } = {}) {
      const list = Array.isArray(history) ? history : []
      if (list.length <= keep) return { ok: true, summary: latest()?.text ?? '', dropped: 0 }
      const older = list.slice(0, list.length - keep)
      const summary = await summarize(older)
      if (!summary) return { ok: false, error: 'empty-summary' }
      memory.put({ namespace: 'compaction', kind: 'summary', key: `sum:${ctx.now()}`, text: summary, data: { dropped: older.length } })
      return { ok: true, summary, dropped: older.length, kept: keep }
    },
  })

  // 装配前：把最近一次摘要注入
  ctx.services.context.onAssemble({
    name: 'compaction-summary', order: 60,
    apply: () => {
      const row = latest()
      return row ? `【早前对话的压缩摘要】\n${row.text}` : null
    },
  })

  /** 上下文超过阈值就自动压一次（调用方每轮把历史递进来）。 */
  async function maybe({ history = [], force = false } = {}) {
    const list = Array.isArray(history) ? history : []
    const chars = list.reduce((n, m) => n + String(m?.text ?? '').length, 0)
    if (!force && chars < triggerChars) return { ok: true, skipped: 'under-threshold', chars }
    return ctx.services.context.compact({ history: list })
  }

  ctx.services.provide('compaction', { run: (input) => ctx.services.context.compact(input), maybe, latest, triggerChars })
  ctx.log({ msg: 'compaction.ready', keepRecent, maxChars })
}
