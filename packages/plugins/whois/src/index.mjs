// whois：身份解析工具。它不是 recall 的别名。
//
// 分工：
//   · 做梦产出"核心人物摘要"（person:<qq> 的 profile/ids/familiarity）
//   · whois 只做"这个人是谁"：精确按账号找，找名字时给候选
//   · 最近提到这个人的事件，由 whois 自己拼（memory 只提供查询原语）
export const name = 'whois'

import { memoryCapabilities } from '../../../core/src/memory-capabilities.mjs'

export function apply(ctx) {
  const memory = ctx.services.require('memory')
  // schema 由 preset 显式声明：v3 只读 episode/annotations，v2 保留旧路径；
  // 两种 schema 的读取分支互斥，不做"v3 读不到再回退 v2"的混合读取。
  const memorySchema = String(ctx.config.schema ?? 'v2') === 'v3' ? 'v3' : 'v2'
  const capabilities = memoryCapabilities(memorySchema)

  /**
   * 最近提到这个人的事件：用档案里的**全部身份入口**（qq/id/别名/显示名）去比
   * event.data.people。旧实现只拿 person.data.qq，名字型档案 qq=null → 永远空（审计 F5）。
   */
  /**
   * Phase 3：entity 层归并。同一个现实对象可能有多个 person 块（显示名/别名各建过一份）；
   * 先按 qq/id/名字找 entity 行，再取它引用的全部 personKeys 合并成一份档案。
   */
  function resolveEntity({ qq = null, idKind = null, value = null, name = null, subjectKind = null } = {}) {
    const wanted = []
    if (qq) wanted.push({ kind: 'qq', value: String(qq) })
    if (idKind && value) wanted.push({ kind: String(idKind), value: String(value) })
    if (subjectKind && value) wanted.push({ kind: String(subjectKind), value: String(value) })
    const nameText = String(name ?? '').trim()
    const entities = memory.query({ namespace: 'entity', kind: 'entity', limit: 1000, order: 'desc' })
      .filter((row) => row.data?.stub !== true)
    if (wanted.length) {
      const hit = entities.find((row) => (row.data?.ids ?? []).some((id) => wanted.some((w) => String(id.kind) === w.kind && String(id.value) === w.value)))
      if (hit) return hit
    }
    if (nameText) {
      return entities.find((row) => {
        const aliases = (row.data?.aliases ?? []).map(String)
        const ids = (row.data?.ids ?? []).map((id) => String(id.value))
        return aliases.includes(nameText) || ids.includes(nameText) || String(row.text ?? '') === nameText
      }) ?? null
    }
    return null
  }

  function personBlocksOfEntity(entity) {
    const keys = Array.isArray(entity?.data?.personKeys) ? entity.data.personKeys : []
    const blocks = []
    for (const key of keys) {
      const block = memory.query({ namespace: 'person', kind: 'block', key, limit: 1 })[0]
      if (block && block.data?.superseded !== true) blocks.push(block)
    }
    return blocks
  }

  function liveEpisodes(limit = 500) {
    return memory.query({ namespace: 'episode', kind: 'block', limit, order: 'desc' })
      .filter((row) => row.data?.superseded !== true && !(Number(row.data?.parts?.part) > 1))
  }

  function entityFactsOf(entity, limit = 4) {
    if (!entity?.key) return []
    if (memorySchema === 'v3') {
      // v3 没有独立 typed 条目：事实/偏好/承诺是 episode 的块内注释。
      // 只看"提到这个人"的经历，把其注释当历史摘要展示；不回退任何 v2 namespace。
      const rows = liveEpisodes()
        .filter((row) => (row.data?.entities ?? []).includes(entity.key))
      const out = []
      for (const row of rows) {
        for (const field of ['facts', 'preferences', 'commitments']) {
          for (const text of row.data?.annotations?.[field] ?? []) {
            const value = String(text ?? '').trim()
            if (value && !out.some((x) => x.text === value)) out.push({ text: value, data: { from: row.key } })
            if (out.length >= limit) return out
          }
        }
      }
      return out
    }
    const out = []
    for (const namespace of ['preference', 'commitment', 'fact']) {
      const rows = memory.query({ namespace, kind: 'block', limit: 500, order: 'desc' })
        .filter((row) => row.data?.superseded !== true && String(row.data?.subjectEntity ?? '') === entity.key)
      for (const row of rows) if (!out.some((x) => x.text === row.text)) out.push(row)
      if (out.length >= limit) break
    }
    return out.slice(0, limit)
  }

  function recentEventsFor(person, fallbackQq = null, limit = 3) {
    const wanted = new Set([
      String(fallbackQq ?? ''),
      String(person?.data?.subject?.value ?? ''),
      ...(person?.data?.ids ?? []).map((x) => String(x?.value ?? '')),
      ...(person?.data?.aliases ?? []).map(String),
    ].map((x) => x.trim()).filter(Boolean))
    if (!wanted.size) return []
    if (memorySchema === 'v3') {
      // v3：最近发生的事在 episode，不在归档的 event。
      return liveEpisodes()
        .filter((row) => {
          const people = (row.data?.people ?? []).map(String)
          if (people.some((value) => wanted.has(value))) return true
          const text = `${row.text ?? ''} ${String(row.data?.body ?? '')}`.toLowerCase()
          return [...wanted].some((form) => form.length >= 2 && text.includes(form.toLowerCase()))
        })
        .slice(0, Math.max(1, Number(limit) || 3))
    }
    return memory.query({ namespace: 'event', kind: 'block', limit: 500, order: 'desc' })
      .filter((b) => Array.isArray(b.data?.people) && b.data.people.some((p) => wanted.has(String(p))))
      .slice(0, Math.max(1, Number(limit) || 3))
  }

  function line(person) {
    const ids = (person.data?.ids ?? []).map((x) => `${x.kind}:${x.value}`).join('、')
    const fam = person.data?.familiarity ?? 'unknown'
    const doubt = person.data?.provisional === true ? ' [存疑：证据不足]' : ''
    return `· ${person.text}${doubt}\n  （${fam}${ids ? ` · ${ids}` : ''}）`
  }

  ctx.tools.register({
    name: 'whois',
    summary: 'Look up a person by exact account (QQ number) or name; the same QQ is one person across private chat and groups.',
    when: ['someone mentions a person and you need to know who they are', 'the same QQ appears in another group/private chat and you want their file', 'you need their account ids or how close you are'],
    avoid: ['when you just want to remember something that happened (use recall)', 'when the name is ambiguous - pick from the candidates instead of guessing', 'treating a group card/nickname as identity; use the QQ number'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        qq: { type: 'string', description: 'QQ number (exact; same account across groups and private chat).' },
        idKind: { type: 'string', description: 'Other account kind, e.g. mc / steam.' },
        subjectKind: { type: 'string', description: 'Generic identity kind, e.g. qq / mc / discord.' },
        value: { type: 'string', description: 'Account value for idKind.' },
        name: { type: 'string', description: 'A name or nickname; returns candidates.' },
      },
    },
    async execute({ qq = null, idKind = null, value = null, name = null, subjectKind = null } = {}) {
      const found = memory.findPerson({ qq, idKind, value, name, subject: subjectKind && value ? { kind: subjectKind, value } : null })
      const entity = resolveEntity({ qq, idKind, value, name, subjectKind })
      const entityPersons = personBlocksOfEntity(entity)
      let people = found.people ?? []
      if (entityPersons.length) {
        const seen = new Set(entityPersons.map((block) => block.key))
        people = [...entityPersons, ...people.filter((person) => !seen.has(person.key))]
      }
      if (!people.length) {
        return { text: qq ? `还没有 ${qq} 的档案（认识之后、做梦整理过才会有）。` : '还没有这个人的档案。' }
      }
      if (!entityPersons.length && !found.exact && people.length > 1) {
        return { text: [`按名字找到 ${people.length} 个可能的人：`, ...people.map(line)].join('\n') }
      }
      const person = people[0]
      const events = recentEventsFor(person, qq ?? null, 3)
      const entityEvents = entity
        ? (memorySchema === 'v3'
          ? liveEpisodes().filter((block) => Array.isArray(block.data?.entities) && block.data.entities.includes(entity.key)).slice(0, 2)
          : memory.query({ namespace: 'event', kind: 'block', limit: 500, order: 'desc' })
            .filter((block) => block.data?.superseded !== true && Array.isArray(block.data?.entities) && block.data.entities.includes(entity.key))
            .slice(0, 2))
        : []
      const parts = [line(person)]
      // 档案正文才是"这个人是谁"的主体；旧实现只给一行标题+熟悉度，profile 从没输出过。
      const profile = String(person.data?.profile ?? person.data?.narrative ?? '').trim()
      if (profile) parts.push(`档案：${profile.slice(0, 600)}`)
      // entity 归并：同一实体多份档案/别名一起给出（把"显示名各建一份"的旧问题在读取侧兜住）。
      if (entity) {
        const aliases = [...new Set([...(entity.data?.aliases ?? []).map(String), ...people.flatMap((p) => (p.data?.aliases ?? []).map(String))])]
          .filter((alias) => alias && alias !== person.text)
        const ids = [...new Set((entity.data?.ids ?? []).map((id) => `${id.kind}:${id.value}`))]
        if (aliases.length) parts.push(`别名／其他称呼：${aliases.slice(0, 12).join('、')}`)
        if (ids.length > 1) parts.push(`同一实体的身份：${ids.slice(0, 10).join('、')}`)
        if (people.length > 1) parts.push(`（合并了 ${people.length} 份人物档案）`)
        const facts = entityFactsOf(entity, 4)
        if (facts.length) {
          parts.push('实体事实／承诺：')
          for (const row of facts) parts.push(`· ${String(row.text).slice(0, 120)}`)
        }
        // Phase 3 关系边：entity-to-entity（带证据），关系类问题直接给出"谁是 TA 的谁"。
        const relations = memory.query({ namespace: 'relation', kind: 'relation', limit: 500, order: 'desc' })
          .filter((row) => row.data?.superseded !== true && (row.data?.from === entity.key || row.data?.to === entity.key))
        if (relations.length) {
          parts.push('关系：')
          for (const relation of relations.slice(0, 6)) {
            const otherKey = relation.data?.from === entity.key ? relation.data?.to : relation.data?.from
            const other = memory.query({ namespace: 'entity', kind: 'entity', key: otherKey, limit: 1 })[0]
            parts.push(`· ${String(relation.data?.label ?? '相关')}：${other?.text ?? otherKey}`)
          }
        }
      }

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
      const mergedEvents = [...events, ...entityEvents.filter((block) => !events.some((event) => event.id === block.id))].slice(0, 4)
      if (mergedEvents.length) {
        parts.push('最近提到 TA 的事：')
        parts.push(...mergedEvents.map((e) => `· ${e.text}${e.data?.day ? `（${String(e.data.day).slice(5)}）` : ''}`))
      }
      return { text: parts.join('\n') }
    },
  })
  ctx.log({ msg: 'whois.ready' })
}
