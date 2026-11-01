// 语料层：梗、黑话、说法。一个词一个块，来源放在 origins 里。
//
// 不确定的（没释义、没出处）不进"事实"，而是：
//   1. 写成 status=candidate 的条目（主会话之前能靠它和上下文撑着）
//   2. 同时在 note 里留一条"查一下这个"的待办，等第二天自己搜
export const name = 'lexicon'

export function apply(ctx) {
  const memory = ctx.services.require('memory')
  memory.registerNamespace({ id: 'lexicon', label: '语料', recallable: true, halfLifeDays: 180, owner: 'lexicon' })

  const norm = (s) => String(s ?? '').trim()

  function all() {
    return memory.query({ namespace: 'lexicon', kind: 'term', limit: 500 })
  }

  function find(term, conv) {
    return all().find((x) => x.key === `lexicon:${conv}:${term}`) ?? null
  }

  function originOf({ conv = null, platform = null, url = null, note = null, meaning = null, status = 'candidate', usageState = null } = {}) {
    return {
      ...(conv ? { conv } : {}),
      ...(platform ? { platform } : {}),
      ...(url ? { url } : {}),
      ...(note ? { note } : {}),
      ...(meaning ? { meaning } : {}),
      ...(status ? { status } : {}),
      ...(usageState ? { usageState } : {}),
      seenAt: ctx.now(),
    }
  }

  function upsert({ term, conv = 'web', platform = null, url = null, meaning = '', usage = '', tags = [], evidence = null } = {}) {
    const word = norm(term)
    if (!word) return { ok: false, error: 'empty-term' }
    const key = `lexicon:${conv}:${word}`
    const existing = all().find((x) => x.key === key)
    const origins = [...(existing?.data?.origins ?? [])]
    // 同一来源（conv+url）只更新，不重复追加
    const same = origins.findIndex((o) => (o.conv ?? null) === (conv === 'web' ? null : conv) && (o.url ?? null) === url)
    const fresh = originOf({ conv: conv === 'web' ? null : conv, platform, url, meaning: meaning || null, status: meaning ? 'confirmed' : 'candidate' })
    if (same >= 0) origins[same] = { ...origins[same], ...fresh }
    else origins.push(fresh)

    const confirmed = origins.some((o) => o.status === 'confirmed')
    const data = {
      term: word,
      origins,
      tags: [...new Set([...(existing?.data?.tags ?? []), ...tags.map(String)])].slice(0, 8),
      usage: usage || existing?.data?.usage || '',
      status: confirmed ? 'confirmed' : 'candidate',
      pending: !confirmed && !meaning,
      usageState: origins.some((o) => (o.usageState ?? 'active') === 'active') ? 'active' : 'fading',
      decay: { weight: Number(existing?.data?.decay?.weight ?? 1), lastSeen: ctx.now() },
      evidence: evidence ?? existing?.data?.evidence ?? [],
    }
    memory.put({ namespace: 'lexicon', kind: 'term', key, text: `${word}：${meaning || '（意思还不确定）'}`, data })
    if (typeof memory.index === 'function') {
      const row = all().find((x) => x.key === key)
      if (row) void memory.index(row.id, `${word} ${meaning} ${usage}`)
    }

    // 缺释义 → 进 note 待办，等主会话自己上网查
    if (!confirmed) {
      const noteSvc = ctx.services.get('note')
      noteSvc?.add?.({
        text: `查一下「${word}」是什么意思、从哪来的。`,
        about: { namespace: 'lexicon', key },
        raisedBy: 'lexicon',
        kind: 'question',
      })
    }
    return { ok: true, key, status: data.status, pending: data.pending }
  }

  function lines(row) {
    const origins = row.data?.origins ?? []
    return origins.map((o) => {
      const where = o.conv ? `群 ${o.conv}` : (o.platform ? o.platform : '网上')
      const what = o.meaning ? o.meaning : '意思待确认'
      return `· ${where}：${what}${o.note ? `（${o.note}）` : ''}`
    })
  }

  ctx.tools.register({
    name: 'lexicon',
    summary: 'Look up words and slang: what they mean, where they are used, which group they came from.',
    when: ['a word or phrase you do not recognise appears', 'you want to use the right expression for a place'],
    avoid: ['when you need facts about events (use recall)'],
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        term: { type: 'string', description: 'The word or phrase.' },
        conv: { type: 'string', description: 'Only entries seen in this conversation.' },
        platform: { type: 'string', description: 'Only entries seen on this platform, e.g. bili / web.' },
        tag: { type: 'string', description: 'Only entries with this tag.' },
        limit: { type: 'number', description: 'How many entries (default 5).' },
      },
    },
    async execute({ term = null, conv = null, platform = null, tag = null, limit = 5 } = {}) {
      const rows = all().filter((row) => {
        if (term && !row.data?.term?.includes(String(term))) return false
        const origins = row.data?.origins ?? []
        if (conv && !origins.some((o) => o.conv === conv)) return false
        if (platform && !origins.some((o) => o.platform === platform)) return false
        if (tag && !(row.data?.tags ?? []).includes(String(tag))) return false
        return true
      }).slice(0, Math.max(1, Number(limit) || 5))
      if (!rows.length) return { text: '没有这个说法。要是刚听到，可以先用 lexicon_learn 记下来。' }
      return {
        text: rows.map((row) => {
          const head = `${row.data?.term}：${row.data?.status === 'confirmed' ? '已确认' : '待确认'}${row.data?.usage ? `，${row.data.usage}` : ''}`
          return [head, ...lines(row)].join('\n')
        }).join('\n\n'),
      }
    },
  })

  ctx.tools.register({
    name: 'lexicon_learn',
    summary: 'Record a word or phrase you just met, with where you met it and what it seems to mean.',
    when: ['you hear a new expression and want to remember it', 'someone explains a term to you'],
    avoid: ['recording ordinary facts (use remember)'],
    parameters: {
      type: 'object', additionalProperties: false, required: ['term'],
      properties: {
        term: { type: 'string' },
        meaning: { type: 'string', description: 'What it seems to mean. Leave empty if unsure - it becomes a pending question.' },
        usage: { type: 'string' },
        conv: { type: 'string', description: 'Where it was heard, e.g. group:1057812765. Defaults to web.' },
        platform: { type: 'string' },
        url: { type: 'string', description: 'Source link if any.' },
        tags: { type: 'array', items: { type: 'string' } },
      },
    },
    async execute(input = {}) {
      const out = upsert(input)
      if (!out.ok) return { text: '没记成（缺词）。' }
      return { text: out.pending ? `记下了「${input.term}」，意思还不确定，已经留了待办去查。` : `记下了「${input.term}」。` }
    },
  })

  ctx.services.provide('lexicon', { upsert, query: () => all() })
  ctx.log({ msg: 'lexicon.ready' })
}
