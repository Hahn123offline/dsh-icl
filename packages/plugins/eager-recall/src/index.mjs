// 自动召回：模型不知道自己不清楚，所以每条用户消息进来时，
// 由核心统一做一次轻量检索，够像才注入一小段"你可能记得"。
//
// 三条自我约束：
//   1. 不推消息，只交提示词段（走 ctx.prompt.onTurn，由核心装配）
//   2. 宁缺毋滥：低于阈值一条都不给
//   3. 只给参考：标明这是记忆检索结果，不是事实
import fs from 'node:fs'

export const name = 'eager-recall'

export function apply(ctx) {
  const memory = ctx.services.require('memory')
  // 默认开启，但必须可以一行关掉。
  const enabled = ctx.config.enabled !== false
  // 0.50 是小样本标定出来的；0.55 在我们的混合评分上会漏掉一半该命中的。
  const minScore = Number(ctx.config.minScore ?? 0.5)
  // 没有绑定嵌入时，memory.search 退化成二元组重叠度，分数整体低一档（实测同义句 0.25），
  // 0.5 会让这个插件永远 0 注入。所以退化路径单独用一个更低、且明确写出来的阈值。
  const minScoreNoEmbed = Number(ctx.config.minScoreNoEmbed ?? 0.2)
  const maxItems = Math.max(1, Number(ctx.config.maxItems ?? 2))
  const maxChars = Math.max(40, Number(ctx.config.maxChars ?? 200))

  // 用户批准（2026-11-06）：每次评估记 hits/injected/chars，进质量数据（E2 可判定）。
  const counterFile = ctx.config.counterFile ? String(ctx.config.counterFile) : null
  function recordCount(entry) {
    if (!counterFile) return
    try { fs.appendFileSync(counterFile, `${JSON.stringify({ at: Date.now(), ...entry })}\n`, 'utf8') } catch { /* 计数失败不影响召回 */ }
  }
  function effectiveThreshold() {
    let embedded = false
    try { embedded = Boolean(memory.stats?.()?.embedded) } catch { embedded = false }
    return { threshold: embedded ? minScore : Math.min(minScore, minScoreNoEmbed), embedded }
  }

  ctx.prompt.onTurn(async ({ message }) => {
    if (!enabled) { recordCount({ enabled: false, queryChars: 0, hits: 0, injected: 0, chars: 0 }); return null }
    const query = String(message ?? '').trim()
    if (!query) return null
    const { threshold, embedded } = effectiveThreshold()
    const hits = await memory.search({ query, limit: Math.max(4, maxItems * 3), now: ctx.now(), minScore: threshold })
    const picked = hits
      .filter((h) => Number(h.score) >= threshold)
      .filter((h) => h.item.kind !== 'cursor')
      .slice(0, maxItems)
    const base = { queryChars: query.length, hits: hits.length, injected: picked.length, chars: 0, threshold, embedded }
    if (!picked.length) { recordCount(base); return null }
    const lines = picked.map((h) => {
      const tag = h.item.kind === 'note' ? '未整理' : (h.item.namespace ?? '记忆')
      return `· [${tag}] ${String(h.item.text).slice(0, 80)}`
    })
    let text = `你可能记得（检索结果，仅供参考）：\n${lines.join('\n')}`
    if (text.length > maxChars) text = text.slice(0, maxChars - 1).trimEnd() + '…'
    recordCount({ ...base, chars: text.length })
    return text
  })

  ctx.log({ msg: 'eager-recall.ready', enabled, minScore, minScoreNoEmbed, maxItems, maxChars })
}
