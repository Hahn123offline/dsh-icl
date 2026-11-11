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
  // 用户批准（2026-11-06，首次 E2 实测）：同一条记忆短时间内别反复注入（实测 4 条 note 被注入 7–11 次）。
  const cooldownMs = Math.max(0, Number(ctx.config.cooldownMs ?? 180_000))
  const recentInjected = new Map() // item.id -> last injected at
  /** 按句子边界截断（不要把"…别在"这种半句塞给模型）。 */
  function clipLine(value, max) {
    const body = String(value ?? '').replace(/\s+/g, ' ').trim()
    if (body.length <= max) return body
    const cut = body.slice(0, max)
    const boundary = Math.max(
      cut.lastIndexOf('。'), cut.lastIndexOf('；'), cut.lastIndexOf('，'), cut.lastIndexOf('！'), cut.lastIndexOf('？'),
      cut.lastIndexOf('.'), cut.lastIndexOf(' '),
    )
    const head = boundary > Math.floor(max * 0.5) ? cut.slice(0, boundary + 1).trim() : cut.slice(0, max - 1).trimEnd()
    return `${head}…`
  }

  ctx.prompt.onTurn(async ({ message }) => {
    if (!enabled) { recordCount({ enabled: false, queryChars: 0, hits: 0, injected: 0, chars: 0, suppressed: 0 }); return null }
    const query = String(message ?? '').trim()
    if (!query) return null
    const { threshold, embedded } = effectiveThreshold()
    const hits = await memory.search({ query, limit: Math.max(4, maxItems * 3), now: ctx.now(), minScore: threshold })
    const eligible = hits
      .filter((h) => Number(h.score) >= threshold)
      .filter((h) => h.item.kind !== 'cursor')
      // 已消化的 note 已经变成块了，不能再以"未整理"身份重复注入（与 recall 同口径）。
      .filter((h) => !(h.item.kind === 'note' && h.item.data?.consolidated === true))
    const nowMs = ctx.now()
    const picked = eligible
      .filter((h) => {
        const last = recentInjected.get(h.item.id)
        return last == null || nowMs - last >= cooldownMs
      })
      .slice(0, maxItems)
    const suppressed = eligible.length - picked.length
    const base = { queryChars: query.length, hits: hits.length, injected: picked.length, chars: 0, suppressed, threshold, embedded }
    if (!picked.length) { recordCount(base); return null }
    const lines = picked.map((h) => {
      const tag = h.item.kind === 'note' ? '未整理' : (h.item.namespace ?? '记忆')
      const doubt = h.item.data?.provisional === true ? '[存疑] ' : ''
      const unsure = h.clarity?.label ? `[${h.clarity.label}] ` : ''
      return `· [${tag}] ${doubt}${unsure}${clipLine(h.item.text, 80)}`
    })
    let text = `你可能记得（检索结果，仅供参考）：\n${lines.join('\n')}`
    if (text.length > maxChars) text = text.slice(0, maxChars - 1).trimEnd() + '…'
    for (const h of picked) {
      recentInjected.set(h.item.id, nowMs)
      if (recentInjected.size > 200) {
        const oldest = [...recentInjected.entries()].sort((a, b) => a[1] - b[1])[0]
        if (oldest) recentInjected.delete(oldest[0])
      }
    }
    recordCount({ ...base, chars: text.length })
    return text
  })

  ctx.log({ msg: 'eager-recall.ready', enabled, minScore, minScoreNoEmbed, maxItems, maxChars, cooldownMs })
}
