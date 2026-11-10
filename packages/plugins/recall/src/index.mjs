// 回忆控制器：模型侧只有 remember / recall / forget，
// 它不知道"今天随手记"和"长期块"是两层东西。
//
// 三条设计要点（来自 2026-11-01 的讨论）：
//   1. 混合结果必须带标签：[今天] / [事件 · 3 天前] / [人物 · 阿伟]
//   2. 去重靠**持久化游标**：同一批块不会反复塞给模型；游标按 token 预算滚动，
//      预算满了就解锁最早被召回的块（假定它已经滑出模型窗口）
//   3. 任何一次成功召回都会让记忆"回到新鲜"（权重回升、衰减计时重置）
import { createHash } from 'node:crypto'

export const name = 'recall'

const DEFAULT_BUDGET_TOKENS = 10_000
const DEFAULT_LIMIT = 6

/** 粗暴但稳定的中文友好估算：2 字符 ≈ 1 token。 */
export function estimateTokens(text) {
  const s = String(text ?? '')
  const cjk = (s.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length
  const rest = s.length - cjk
  return Math.max(1, Math.ceil(cjk / 1.5 + rest / 4))
}

function dayStart(now) {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
function dayKey(now) {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const CATEGORIES = Object.freeze({
  event: { label: '事件', halfLifeDays: 30 },
  person: { label: '人物', halfLifeDays: 180 },
  slang: { label: '梗', halfLifeDays: 90 },
  // 主会话对记忆的纠正（"这件事我记错了"）：它是反馈队列，
  // 不是回忆（不参与 recall 检索），由整理轮消化。
  resolve: { label: '纠正', halfLifeDays: 1, recallable: false },
})

export function apply(ctx) {
  const memory = ctx.services.require('memory')
  const session = String(ctx.config.sessionId ?? 'default')
  const budgetTokens = Math.max(500, Number(ctx.config.budgetTokens) || DEFAULT_BUDGET_TOKENS)
  // 相关性下限（红队 D1）：memory.search 只过滤 sim<=0；这里再按"与 query 的相关度"挡掉
  // "字面碰巧共享一两个二字组"的凑数结果。有嵌入时用混合相似度，没嵌入时用二元组覆盖率。
  // cursor/继续翻 时放宽到 0.05（她要"再想想"，不能因为淡了就再也翻不出来）。
  const minSim = Math.max(0.01, Number(ctx.config.minSim ?? 0.35))
  const minSimNoEmbed = Math.max(0.01, Number(ctx.config.minSimNoEmbed ?? 0.2))
  const relevanceFloor = ({ deeper }) => {
    let embedded = false
    try { embedded = Boolean(memory.stats?.()?.embedded) } catch { embedded = false }
    const base = embedded ? minSim : minSimNoEmbed
    return deeper ? Math.min(base, 0.05) : base
  }
  /** 与 query 的二元组覆盖率（0..1）；用于挡"没问它也端上来"的未整理笔记。 */
  const lexicalRelevance = (text, q) => {
    const needle = String(q ?? '').toLowerCase().replace(/\s+/g, '')
    const body = String(text ?? '').toLowerCase().replace(/\s+/g, '')
    if (!needle || !body) return 0
    const grams = new Set()
    for (let i = 0; i < needle.length - 1; i += 1) grams.add(needle.slice(i, i + 2))
    if (!grams.size) return body.includes(needle) ? 1 : 0
    let hit = 0
    for (const g of grams) if (body.includes(g)) hit += 1
    return hit / grams.size
  }

  // 注册分类命名空间（幂等）。它们不是 recall 的私有物：任何插件都能读写。
  for (const [id, meta] of Object.entries(CATEGORIES)) {
    memory.registerNamespace({ id, label: meta.label, recallable: meta.recallable !== false, halfLifeDays: meta.halfLifeDays, owner: 'recall' })
  }
  // 游标自己的命名空间（不参与回忆）
  memory.registerNamespace({ id: 'recall-cursor', label: '回忆游标', recallable: false, owner: 'recall' })

  const cursorNamespace = 'recall-cursor'
  const cursorKey = `cursor:${session}`

  function loadCursor() {
    const row = memory.query({ namespace: cursorNamespace, kind: 'cursor', key: cursorKey, limit: 1 })[0]
    if (!row?.data) return { items: [] }
    try { return { items: Array.isArray(row.data.items) ? row.data.items : [] } } catch { return { items: [] } }
  }

  function saveCursor(cursor) {
    memory.put({
      namespace: cursorNamespace,
      kind: 'cursor',
      key: cursorKey,
      text: `${cursor.items?.length ?? 0} 块在窗口内`,
      data: { items: cursor.items ?? [] },
      now: ctx.now(),
    })
  }

  function totalTokens(items) {
    return (items ?? []).reduce((n, item) => n + (Number(item.tokens) || 0), 0)
  }

  /**
   * 按预算滚动游标：先把要新增的块塞进去；超预算就从**最早**的块开始解锁，
   * 直到装得下。返回"需要跳过的 id 集合"（即仍在窗口内的块）。
   */
  function rollCursor(cursor, additions) {
    const items = [...(cursor.items ?? [])]
    for (const add of additions) {
      if (items.some((it) => it.id === add.id)) continue
      items.push({ id: add.id, tokens: add.tokens })
    }
    while (totalTokens(items) > budgetTokens && items.length > 1) items.shift()
    return { items }
  }

  const tools = {
    remember: {
      name: 'remember',
      summary: 'Write down something you want to keep - a fact, a person, a bit of slang, something that happened.',
      when: ['something is worth keeping for later', 'the user tells you to remember it'],
      avoid: ['long transcripts', 'things you would only need this turn'],
      description: 'It is private and trusted: at night it is given high weight when memories are consolidated. kind: event (default), person, slang, resolve (a correction of an existing memory - pass about.namespace/about.key). Keep it to one or two sentences. Returns a key/id you can later hand to forget (delete) or use as kind=resolve (correct).',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: { type: 'string', description: 'What to keep. One concrete thing.' },
          kind: { type: 'string', enum: Object.keys(CATEGORIES), description: 'Category (default event).' },
          key: { type: 'string', description: 'Optional stable key to update instead of adding.' },
          qq: { type: 'string', description: 'For kind=person: whose note this is (QQ number).' },
          // 对象参数必须显式声明字段：DSH 侧会把 «没有 properties 的对象» 规整成
          // {additionalProperties:false} 的空壳，模型照描述传字段就会被校验挡下来。
          origin: {
            type: 'object',
            description: 'Where this came from.',
            properties: {
              conv: { type: 'string', description: 'Conversation id, e.g. qq:group:123.' },
              sender: { type: 'string', description: 'Who said it.' },
              messageId: { type: 'string', description: 'Message id in that conversation.' },
              platform: { type: 'string', description: 'Where the conversation lives, e.g. qq / bili / web.' },
            },
          },
          subjectKind: { type: 'string', description: 'For kind=person: what kind of identity qq is, e.g. qq / mc / discord. Defaults to qq.' },
          about: {
            type: 'object',
            description: 'For kind=resolve: what this corrects.',
            properties: {
              namespace: { type: 'string', description: 'Namespace of the memory being corrected, e.g. person.' },
              key: { type: 'string', description: 'Exact key of the memory being corrected, e.g. person:42.' },
            },
            required: ['namespace', 'key'],
          },
        },
      },
      async execute({ text, kind = 'event', key = null, qq = null, subjectKind = null, about = null, origin = null } = {}) {
        const ns = CATEGORIES[kind] ? kind : 'event'
        // 显式 key 可能是"新建一条固定 key"也可能是"改写已有"：按落库前是否已存在决定确认语。
        const existed = key != null ? (memory.query({ namespace: ns, key: String(key), limit: 1 })[0] ?? null) : null
        const safeKey = key ?? `note:${ctx.now()}:${Math.random().toString(36).slice(2, 7)}`
        const identity = qq ? { kind: String(subjectKind ?? 'qq'), value: String(qq) } : null
        const data = {
          day: dayKey(ctx.now()),
          session,
          ...(identity ? { subject: identity } : {}),
          // 兼容：qq 身份仍然写 qq 字段
          ...(identity?.kind === 'qq' ? { qq: identity.value } : {}),
          ...(about ? { about } : {}),
          ...(origin ? { origin } : {}),
        }
        const created = memory.put({ namespace: ns, kind: 'note', key: safeKey, text, data, weight: 1.5, now: ctx.now() })
        // 碎片也要向量化：它可能就是主会话主动塞进来的真实信息，
        // 不能因为"没成块"就只能靠字面搜到。
        if (typeof memory.index === 'function') void memory.index(created.id, String(text))
        // 红队 D2：确认语要能区分"新增/改写"，并且给出可用的 key（以前只说"记下了"，forget 却要 key）。
        const target = `key=${created.key ?? safeKey}${created.id != null ? `，id=${created.id}` : ''}`
        if (ns === 'resolve') return { text: `已记下这次纠正（${target}），整理时按它改。` }
        if (existed) return { text: `改掉了（${target}）。` }
        return { text: `记下了（${target}）。以后要删用 forget {key}，要纠正用 kind=resolve。` }
      },
    },

    recall: {
      name: 'recall',
      summary: 'Bring back what you remember about events and things that happened - not for looking up people.',
      when: [
        'someone asks about the past / "上次" / "以前" / "那个事"',
        'you need an old detail that is no longer in the window',
        'before answering something you are not sure about - check memory instead of guessing',
      ],
      avoid: ['looking up who a person is - use whois for identity, accounts and closeness'],
      description: 'With no query this is an overview of the last few days. kind narrows to event / person / slang; pass kind=person together with a QQ number or a name to read that person\'s file. query filters by meaning; tag narrows to a label. If nothing relevant is found it says so explicitly - with the scope searched and a next step - and never pads with unrelated notes. Passing cursor means "keep digging": it searches deeper, including things that have faded, and does not repeat what you already saw.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: Object.keys(CATEGORIES).filter((key) => CATEGORIES[key].recallable !== false), description: 'Only this category.' },
          query: { type: 'string', description: 'What you are trying to remember.' },
          limit: { type: 'number', description: 'How many items (default 6).' },
          cursor: { type: 'string', description: 'Opaque cursor from the previous recall.' },
          conv: { type: 'string', description: 'Only memories that came from this conversation (origin.conv).' },
          tag: { type: 'string', description: 'Only blocks carrying this tag (e.g. \'看海\'). Tags narrow the search; they do not replace it.' },
          days: { type: 'number', description: 'With overview: how many days back. Default 2.' },
          overview: { type: 'boolean', description: 'Set true for a time-ordered summary of the last few days (what happened recently).' },
        },
      },
      async execute({ kind = null, query = '', limit = DEFAULT_LIMIT, cursor = null, tag = null, conv = null, days = 2, overview = false } = {}) {
        const now = ctx.now()

        // 人物是显式参数：kind='person' 才按身份查档案，不做字数猜测。
        if (kind === 'person' && String(query ?? '').trim()) {
          const q = String(query).trim()
          const isId = /^\d{2,12}$/.test(q)
          const found = memory.findPerson(isId ? { qq: q } : { name: q })
          const person = found.people?.[0]
          if (person) {
            const claims = Array.isArray(person.data?.claims) ? person.data.claims.slice(0, 6) : []
            const lines = [`[人物] ${person.text}`]
            if (claims.length) lines.push('依据：', ...claims.map((c) => `· ${c.text}`))
            return { text: lines.join('\n'), cursor: null, more: false }
          }
        }

        // overview=true 才是"最近发生了什么"：按时间窗列块与未整理笔记，不走向量排序
        if (overview === true && !String(query ?? '').trim() && kind !== 'person') {
          const span = Math.max(1, Math.min(30, Number(days) || 2))
          const since = now - span * 86_400_000
          const rows = []
          for (const ns of Object.keys(CATEGORIES)) {
            if (CATEGORIES[ns].recallable === false) continue
            const blocks = memory.query({ namespace: ns, kind: 'block', limit: 200, order: 'desc' })
              .filter((b) => Number(b.createdAt) >= since && b.data?.superseded !== true)
            for (const b of blocks) rows.push({ ns, b, kind: 'block' })
            const notes = memory.query({ namespace: ns, kind: 'note', limit: 200, order: 'desc' })
              .filter((n) => Number(n.createdAt) >= since && n.data?.consolidated !== true)
            for (const n of notes) rows.push({ ns, b: n, kind: 'note' })
          }
          rows.sort((a, b) => b.b.createdAt - a.b.createdAt)
          // 一条都没有就退回普通检索，保持旧行为
          if (rows.length) {
            const picked = rows.slice(0, Math.max(1, Number(limit) || DEFAULT_LIMIT))
            const today = new Date(now).toDateString()
            const text = picked.map(({ ns, b, kind }) => {
              if (kind === 'note') {
                const same = new Date(b.createdAt).toDateString() === today
                return `${same ? '[今天]' : `[未整理 · ${shortDate(b.createdAt)}]`} ${b.text}`
              }
              return `${label(ns, b.createdAt, now)} ${b.text}`
            }).join('\n')
            return { text, cursor: null, more: rows.length > picked.length }
          }
        }

        const namespaces = kind && CATEGORIES[kind] && CATEGORIES[kind].recallable !== false
          ? [kind]
          // resolve 是纠正反馈队列，不是回忆：即使 cursor 走 includeArchive 也不能混进来。
          : Object.keys(CATEGORIES).filter((ns) => CATEGORIES[ns].recallable !== false)
        const seen = new Set()
        const candidates = []
        const deeper = Boolean(cursor)
        const floor = relevanceFloor({ deeper })
        const question = String(query ?? '').trim()
        let rawHitCount = 0
        for (const ns of namespaces) {
          // 带 cursor 就是"继续想"：深度更大，把权重很低的也翻出来（不做硬归档）
          const hits = await memory.search({
            namespace: ns, query, limit: deeper ? 200 : 50, now,
            tags: tag ? [tag] : null, conv, includeArchive: deeper,
          })
          // 未消化的 note 不管哪天都要能被回忆；
          // 已消化的 note 已经变成块了，不能再以 note 身份重复出现。
          for (const hit of hits) {
            if (hit.item.kind === 'note' && hit.item.data?.consolidated === true) continue
            rawHitCount += 1
            // 有 query 时按相关度挡凑数；没有 query（纯"最近"视图）不筛。
            if (question && Number(hit.sim ?? 0) < floor) continue
            candidates.push({ ...hit, namespace: ns })
          }
        }
        candidates.sort((a, b) => b.score - a.score || b.item.createdAt - a.item.createdAt)

        // 今天的 note 永远优先展示（带 [今天] 标签）
        // 已经被梦境消化的 note 不再以"今天"的身份出现：
        // 它们已经变成块了，否则既重复又会把块挤出去。
        // 未消化的 note（任何日期）优先展示，标签用"未整理"
        // 不可回忆的类别（如 resolve 纠正队列）不能以待整理笔记的身份出现在回忆里。
        // 红队 D1/D3：未整理笔记也不能"不管问什么都先塞一半配额"——有 query 时同样要过相关度。
        const pendingNamespaces = namespaces.filter((ns) => CATEGORIES[ns]?.recallable !== false)
        const pendingRaw = tag ? [] : pendingNamespaces.flatMap((ns) => memory.query({ namespace: ns, kind: 'note', limit: 200, order: 'desc' })
          .filter((item) => item.data?.consolidated !== true)
          .map((item) => ({ item, score: 1.15, namespace: ns })))
        const pendingNotes = question
          ? pendingRaw.filter((entry) => lexicalRelevance(entry.item.text, question) >= floor)
          : pendingRaw

        const stored = cursor && typeof cursor === 'string' ? safeParseCursor(cursor) : loadCursor()
        const inWindow = new Set((stored.items ?? []).map((it) => it.id))
        const picked = []
        let tokens = 0
        const additions = []

        function take(entry, tag) {
          if (seen.has(entry.item.id)) return
          seen.add(entry.item.id)
          if (inWindow.has(entry.item.id)) return
          const text = renderEntry(entry, tag)
          const t = estimateTokens(text)
          // 单次回忆不超预算；第一条总归要给（否则会返回空）
          if (picked.length > 0 && tokens + t > budgetTokens) return
          picked.push({ entry, tag, text, tokens: t })
          tokens += t
          additions.push({ id: entry.item.id, tokens: t })
        }

        const noteQuota = Math.max(1, Math.floor(limit / 2))
        for (const entry of pendingNotes.slice(0, noteQuota)) take(entry, '未整理')
        for (const entry of candidates.slice(0, 100)) take(entry, label(entry.namespace, entry.item.createdAt, now))

        const nextCursor = rollCursor(stored, additions)
        // 空召回/全在窗口内时不要写库；游标只在真的变化时落盘。
        if (additions.length || JSON.stringify(nextCursor.items) !== JSON.stringify(stored.items)) saveCursor(nextCursor)

        // 召回成功 → 回到新鲜
        if (picked.length) memory.boost(picked.map((p) => p.entry.item.id), { now })
        const pieces = picked.map((p) => p.text)
        // 第二条路：每次都用原话扫一遍（几百页纯匹配很快），只用来补细节。
        let rawHits = []
        try {
          if (ctx.services.raw?.ids?.().length) rawHits = await ctx.services.raw.search({ query, limit: 2 })
        } catch { /* 原文层失败不影响主结果 */ }

        const pickedNorm = pieces.join('\n').toLowerCase().replace(/\s+/g, '')
        // 原文只用来补细节：一条原文如果和已给内容高度重合，就不再重复
        const gramsOf = (s) => {
          const q = String(s ?? '').toLowerCase().replace(/\s+/g, '')
          const out = []
          for (let i = 0; i < q.length - 1; i++) out.push(q.slice(i, i + 2))
          return out
        }
        const overlaps = (text) => {
          const g = gramsOf(text)
          if (!g.length) return 0
          return g.filter((x) => pickedNorm.includes(x)).length / g.length
        }
        const extra = rawHits
          .filter((r) => r?.text && overlaps(r.text) < 0.6)
          .filter((r) => !pickedNorm.includes(String(r.text).toLowerCase().replace(/\s+/g, '').slice(0, 40)))
          .slice(0, 2)
          .map((r) => `原文（${shortDate(r.time ?? r.createdAt ?? ctx.now())}）：${String(r.text).slice(0, 160)}`)

        // 红队 D1：空结果必须说实话，并且分清三种"没有"：
        //   ① 范围里有候选、但都不够相关（不要端凑数、不要 boost）；
        //   ② 范围过滤后没有、但全局有记忆（不能说"也没记过"——全局假否定）；
        //   ③ 全局真的空（这才是"没记过"）。
        const anyKnown = pendingNotes.length + candidates.length > 0
        const globalItems = (() => { try { return Number(memory.stats?.()?.items ?? 0) } catch { return 0 } })()
        const scopeText = [kind ? `类型=${kind}` : null, tag ? `标签=${tag}` : null, conv ? `会话=${conv}` : null].filter(Boolean).join('、') || '全部类别'
        const searchedCount = rawHitCount + pendingRaw.length
        const emptyText = (() => {
          if (!question) return '最近没有能想起来的（范围内的记忆是空的）。'
          if (anyKnown) return '这几条刚才已经给过你了（就在上面的上下文里）；要找别的，把要找的事说具体一点。'
          if (searchedCount > 0) {
            return `没找到相关记忆：检索了 ${searchedCount} 条（范围：${scopeText}，关键词「${question.slice(0, 40)}」），都不够相关。要不要换个说法、去掉 tag/会话过滤，或用 cursor 继续翻更早的？`
          }
          if (globalItems > 0) {
            return `这个范围里没有相关记忆（全局还有 ${globalItems} 条，可能是 ${scopeText} 过滤太窄；去掉限制再试一次？）`
          }
          return '记得的东西还是空的：一条记忆都没有过。要我现在记点什么吗？'
        })()
        return {
          text: pieces.length
            ? [...pieces, ...extra].join('\n')
            : (extra.length ? extra.join('\n') : emptyText),
          cursor: encodeCursor(nextCursor),
          more: candidates.length > picked.length,
        }
      },
    },

    forget: {
      name: 'forget',
      summary: 'Drop one of your notes by key or id.',
      when: ['you wrote something wrong and want it gone', 'a memory should be corrected: delete it, then remember the right version (or use kind=resolve)'],
      avoid: ['hiding a memory you simply do not like'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          key: { type: 'string', description: 'Key returned by remember (e.g. note:...).' },
          id: { type: 'number', description: 'Or the numeric id returned by remember/recall.' },
          kind: { type: 'string', enum: Object.keys(CATEGORIES), description: 'Category (default event).' },
        },
      },
      async execute({ key = null, id = null, kind = 'event' } = {}) {
        const ns = CATEGORIES[kind] ? kind : 'event'
        if (key == null && id == null) {
          return { text: '要删哪条？给我 key 或 id（remember 的返回里有）。先用 recall 找到它，别凭印象删。' }
        }
        const out = memory.remove({ namespace: ns, key, id })
        const what = key != null ? `key=${key}` : `id=${id}`
        if (out.removed) return { text: `删掉了（${what}，${ns}）。` }
        return {
          text: `没找到要删的：${ns} 里没有 ${what}。先用 recall 找到它再删，别乱猜；如果只是想纠正而不是删，用 remember {kind:'resolve', about:{namespace:'${ns}', key:'...'}}。`,
        }
      },
    },
  }

  function shortDate(ts) {
    const d = new Date(Number(ts))
    return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`
  }

  function renderEntry(entry, tag) {
    const nowOf = () => ctx.now()
    const item = entry.item
    const unsure = entry.clarity?.label ? `[${entry.clarity.label}] ` : ''
    if (tag === '未整理') {
      // 今天的就叫「今天」；跨天的片段才标「未整理 · 日期」。
      if (Number(item.createdAt) >= dayStart(nowOf(entry))) return `[今天] ${item.text}`
      const d = new Date(Number(item.createdAt))
      const day = `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`
      return `[未整理 · ${day}] ${item.text}`
    }
    if (tag === '今天') return `[今天] ${item.text}`
    if (item.kind === 'block') return `[${tag}] ${unsure}${item.text}`
    return `[${tag} · 随手记] ${unsure}${item.text}`
  }

  function label(ns, createdAt, now) {
    const meta = CATEGORIES[ns] ?? { label: ns }
    const days = Math.floor((now - Number(createdAt)) / 86_400_000)
    const when = days <= 0 ? '今天' : days === 1 ? '昨天' : `${days} 天前`
    return `${meta.label} · ${when}`
  }

  function encodeCursor(cursor) {
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
  }
  function safeParseCursor(text) {
    try {
      const parsed = JSON.parse(Buffer.from(String(text), 'base64url').toString('utf8'))
      return { items: Array.isArray(parsed.items) ? parsed.items : [] }
    } catch { return { items: [] } }
  }

  for (const tool of Object.values(tools)) ctx.tools.register(tool)
  ctx.services.provide('recall', { categories: CATEGORIES, budgetTokens, cursorOf: () => loadCursor(), resetCursor: () => { memory.remove({ namespace: cursorNamespace, key: cursorKey }); return { reset: true } } })
  ctx.log({ msg: 'recall.ready', session, budgetTokens })
}
