// 自动召回：模型不知道自己不清楚，所以每条用户消息进来时，
// 由核心统一做一次轻量检索，够像才注入一小段"你可能记得"。
//
// 三条自我约束：
//   1. 不推消息，只交提示词段（走 ctx.prompt.onTurn，由核心装配）
//   2. 宁缺毋滥：低于阈值一条都不给
//   3. 只给参考：标明这是记忆检索结果，不是事实
export const name = 'eager-recall'

export function apply(ctx) {
  const memory = ctx.services.require('memory')
  // 默认开启，但必须可以一行关掉。
  const enabled = ctx.config.enabled !== false
  // 0.50 是小样本标定出来的；0.55 在我们的混合评分上会漏掉一半该命中的。
  const minScore = Number(ctx.config.minScore ?? 0.5)
  const maxItems = Math.max(1, Number(ctx.config.maxItems ?? 2))
  const maxChars = Math.max(40, Number(ctx.config.maxChars ?? 200))

  ctx.prompt.onTurn(async ({ message }) => {
    if (!enabled) return null
    const query = String(message ?? '').trim()
    if (!query) return null
    const hits = await memory.search({ query, limit: Math.max(4, maxItems * 3), now: ctx.now(), minScore })
    const picked = hits
      .filter((h) => Number(h.score) >= minScore)
      .filter((h) => h.item.kind !== 'cursor')
      .slice(0, maxItems)
    if (!picked.length) return null
    const lines = picked.map((h) => {
      const tag = h.item.kind === 'note' ? '未整理' : (h.namespace ?? '记忆')
      return `· [${tag}] ${String(h.item.text).slice(0, 80)}`
    })
    let text = `你可能记得（检索结果，仅供参考）：\n${lines.join('\n')}`
    if (text.length > maxChars) text = text.slice(0, maxChars - 1).trimEnd() + '…'
    return text
  })

  ctx.log({ msg: 'eager-recall.ready', enabled, minScore, maxItems, maxChars })
}
