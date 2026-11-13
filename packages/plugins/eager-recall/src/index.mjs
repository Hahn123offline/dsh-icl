// 自动召回：模型不知道自己不清楚，所以每条用户消息进来时，
// 由核心统一做一次轻量检索，够像才注入一小段"你可能记得"。
//
// 三条自我约束：
//   1. 不推消息，只交提示词段（走 ctx.prompt.onTurn，由核心装配）
//   2. 宁缺毋滥：低于阈值一条都不给
//   3. 只给参考：标明这是记忆检索结果，不是事实
import fs from 'node:fs'
import { memoryCapabilities } from '../../../core/src/memory-capabilities.mjs'

export const name = 'eager-recall'

export function apply(ctx) {
  const memory = ctx.services.require('memory')
  // 默认开启，但必须可以一行关掉。
  const enabled = ctx.config.enabled !== false
  // 0.50 是小样本标定出来的；0.55 在我们的混合评分上会漏掉一半该命中的。
  const minScore = Number(ctx.config.minScore ?? 0.5)
  // 语义阈值：场景是"旧但语义完全对得上"的记忆（QQ p-07：正确答案 sim 0.51，但衰减后 score 掉到
  // 0.5 以下，按 score 阈值会被整体过滤掉）。语义优先时允许 sim 达标但 score 未达标的候选进入。
  const minSim = Number(ctx.config.minSim ?? 0.5)
  // 没有绑定嵌入时，memory.search 退化成二元组重叠度，分数整体低一档（实测同义句 0.25），
  // 0.5 会让这个插件永远 0 注入。所以退化路径单独用一个更低、且明确写出来的阈值。
  const minScoreNoEmbed = Number(ctx.config.minScoreNoEmbed ?? 0.2)
  const maxItems = Math.max(1, Number(ctx.config.maxItems ?? 2))
  const maxChars = Math.max(40, Number(ctx.config.maxChars ?? 200))
  // v3：自动召回也不能注入旧 v2 事件/事实块或内部片段（episode 才是经历记忆）。
  const memorySchema = String(ctx.config.schema ?? 'v2') === 'v3' ? 'v3' : 'v2'
  // 统一能力表：只有当前 schema 声明的记忆类型能进入自动召回；归档/内部 namespace 一律不读。
  const capabilities = memoryCapabilities(memorySchema)

  /** 与 recall 的 schema 同口径：旧命名空间只归档，不注入。 */
  function visibleHit(hit) { return Object.hasOwn(capabilities.kinds, String(hit?.item?.namespace ?? '')) }

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
  // 低于注入阈值但有相关的记忆：只给一行"可能记得"提示，不注入内容。
  const hintThreshold = Math.max(0.2, Number(ctx.config.hintThreshold ?? 0.33))
  const hintCooldownMs = Math.max(60_000, Number(ctx.config.hintCooldownMs ?? 300_000))
  let lastHintAt = 0
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
    // 取更宽的候选池再按语义重排：要注入的只有 2 条，但候选池太小、且 score 含衰减，
    // 会把"语义最像但较旧"的经历挡在池外（QQ p-07 实测）。
    // limit 要足够宽：eval 里前面的 recall 会 boost 命中块、把旧块按 score 挤出 top-k（QQ p-07 实测）；
    // memory.search 本来就把全库打分完，宽 limit 只是多回传几十条，开销可忽略。
    const hits = await memory.search({ query, limit: Math.max(40, maxItems * 20), now: ctx.now(), minScore: threshold * 0.6 })
    const rankedHits = [...hits].sort((a, b) => Number(b.sim ?? 0) - Number(a.sim ?? 0) || Number(b.score ?? 0) - Number(a.score ?? 0))
    const eligible = rankedHits
      .filter(visibleHit)
      // 语义达标 OR 混合分达标：保留旧口径，同时允许"语义很像、但衰减把分数压下去"的旧记忆。
      .filter((h) => Number(h.score) >= threshold || Number(h.sim ?? 0) >= minSim)
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
    // 影子召回审计（docs/MEMORY-EVAL-SPEC.md §3.3）：只记 id/分数，供离线判断
    // "注入的是不是该注入的、gold 是否被漏掉"。不改变注入行为，不写 live 之外的库。
    const summarize = (list) => list.slice(0, 8).map((h) => ({
      id: h.item.id,
      ns: h.item.namespace,
      kind: h.item.kind,
      score: Math.round(Number(h.score) * 1000) / 1000,
      ...(h.clarity?.tier ? { tier: h.clarity.tier } : {}),
    }))
    const base = {
      queryChars: query.length, hits: hits.length, injected: picked.length, chars: 0, suppressed, threshold, embedded,
      candidateIds: summarize(rankedHits),
    }
    if (!picked.length) {
      // 低置信提示（不自作主张注入内容）：有相关但不够确定的记忆时，只提示"可能有"，
      // 让模型自己决定要不要 recall。这弥补"检索失败/低于阈值时 Agent 完全不知道自己记不记得"。
      try {
        const weakHits = await memory.search({ query, limit: 6, now: ctx.now() })
        const weak = weakHits
          .slice()
          .sort((a, b) => Number(b.sim ?? 0) - Number(a.sim ?? 0) || Number(b.score ?? 0) - Number(a.score ?? 0))
          .filter(visibleHit)
          .filter((h) => h.item.kind !== 'cursor')
          .filter((h) => !(h.item.kind === 'note' && h.item.data?.consolidated === true))
          .filter((h) => Number(h.score) >= hintThreshold && Number(h.score) < threshold)
        if (weak.length && nowMs - lastHintAt >= hintCooldownMs) {
          lastHintAt = nowMs
          const first = weak[0]
          const tag = first.item.namespace === 'episode' ? '经历' : (first.item.kind === 'note' ? '未整理' : (first.item.namespace ?? '记忆'))
          let hint = `你可能对「[${tag}] ${clipLine(first.item.text, 36)}」有相关记忆（不确定，仅供参考）；需要的话可以调 recall 查一下。`
          if (hint.length > maxChars) hint = `${hint.slice(0, maxChars - 1).trimEnd()}…`
          recordCount({ ...base, hint: true, hintIds: summarize(weak), chars: hint.length })
          return hint
        }
      } catch { /* 提示失败就当没有 */ }
      recordCount(base)
      return null
    }
    const lines = picked.map((h) => {
      const tag = h.item.kind === 'note' ? '未整理' : h.item.namespace === 'episode' ? '经历' : (h.item.namespace ?? '记忆')
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
    recordCount({ ...base, injectedIds: summarize(picked), chars: text.length })
    return text
  })

  ctx.log({ msg: 'eager-recall.ready', enabled, minScore, minScoreNoEmbed, maxItems, maxChars, cooldownMs })
}





