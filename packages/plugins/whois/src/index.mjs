// whois：身份解析工具。它不是 recall 的别名。
//
// 分工：
//   · 做梦产出"核心人物摘要"（person:<qq> 的 profile/ids/familiarity）
//   · whois 只做"这个人是谁"：精确按账号找，找名字时给候选
//   · 最近提到这个人的事件，由 whois 自己拼（memory 只提供查询原语）
export const name = 'whois'

export function apply(ctx) {
  const memory = ctx.services.require('memory')

  function recentEventsFor(qq, limit = 3) {
    return memory.query({ namespace: 'event', kind: 'block', limit: 500, order: 'desc' })
      .filter((b) => Array.isArray(b.data?.people) && b.data.people.map(String).includes(String(qq)))
      .slice(0, Math.max(1, Number(limit) || 3))
  }

  function line(person) {
    const ids = (person.data?.ids ?? []).map((x) => `${x.kind}:${x.value}`).join('、')
    const fam = person.data?.familiarity ?? 'unknown'
    return `· ${person.text}\n  （${fam}${ids ? ` · ${ids}` : ''}）`
  }

  ctx.tools.register({
    name: 'whois',
    summary: 'Look up a person you already have a file on: exact by account, candidates by name.',
    when: ['someone mentions a person and you need to know who they are', 'you need their account ids or how close you are'],
    avoid: ['when you just want to remember something that happened (use recall)', 'when the name is ambiguous - pick from the candidates instead of guessing'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        qq: { type: 'string', description: 'QQ number (exact).' },
        idKind: { type: 'string', description: 'Other account kind, e.g. mc / steam.' },
        subjectKind: { type: 'string', description: 'Generic identity kind, e.g. qq / mc / discord.' },
        value: { type: 'string', description: 'Account value for idKind.' },
        name: { type: 'string', description: 'A name or nickname; returns candidates.' },
      },
    },
    async execute({ qq = null, idKind = null, value = null, name = null, subjectKind = null } = {}) {
      const found = memory.findPerson({ qq, idKind, value, name, subject: subjectKind && value ? { kind: subjectKind, value } : null })
      const people = found.people ?? []
      if (!people.length) {
        return { text: qq ? `还没有 ${qq} 的档案（认识之后、做梦整理过才会有）。` : '还没有这个人的档案。' }
      }
      if (!found.exact && people.length > 1) {
        return { text: [`按名字找到 ${people.length} 个可能的人：`, ...people.map(line)].join('\n') }
      }
      const person = people[0]
      const events = recentEventsFor(person.data?.qq ?? qq ?? '', 3)
      const parts = [line(person)]

      // 逐句引用：档案里的每一句都能追到当时的笔记
      const claims = Array.isArray(person.data?.claims) ? person.data.claims : []
      if (claims.length) {
        const noteText = (id) => {
          const n = memory.query({ namespace: 'person', kind: 'note', id, limit: 1 })[0]
          return n ? String(n.text).slice(0, 60) : null
        }
        parts.push('逐句依据：')
        for (const claim of claims.slice(0, 6)) {
          const src = (claim.evidence ?? []).map((e) => noteText(e.id)).filter(Boolean)
          parts.push(`· ${claim.text}${src.length ? `  ← ${src.join('；')}` : ''}`)
        }
      }

      // 这份档案是从哪些笔记来的（成块时记下的引用）
      const evidenceIds = (person.data?.evidence ?? []).map((e) => Number(e.id)).filter(Boolean)
      if (evidenceIds.length) {
        const notes = evidenceIds
          .map((id) => memory.query({ namespace: 'person', kind: 'note', id, limit: 1 })[0])
          .filter(Boolean)
          .slice(0, 5)
        if (notes.length) {
          parts.push('依据：')
          for (const n of notes) parts.push(`· ${String(n.text).slice(0, 100)}`)
        }
      }

      // 原文层：按名字/账号再要两句当时的话
      try {
        const raw = ctx.services.raw
        if (raw?.ids?.().length) {
          const hits = await raw.search({ query: person.data?.qq ?? qq ?? person.text.slice(0, 12), limit: 2 })
          if (hits.length) {
            parts.push('原话：')
            for (const h of hits) parts.push(`· ${String(h.text).slice(0, 120)}`)
          }
        }
      } catch { /* 原文层可选 */ }
      if (events.length) {
        parts.push('最近提到 TA 的事：')
        parts.push(...events.map((e) => `· ${e.text}`))
      }
      return { text: parts.join('\n') }
    },
  })
  ctx.log({ msg: 'whois.ready' })
}
