// 回忆控制器：模型侧只有 remember / recall / forget，
// 它不知道"今天随手记"和"长期块"是两层东西。
//
// 三条设计要点（来自 2026-11-01 的讨论）：
//   1. 混合结果必须带标签：[今天] / [事件 · 3 天前] / [人物 · 阿伟]
//   2. 去重靠**持久化游标**：同一批块不会反复塞给模型；游标按 token 预算滚动，
//      预算满了就解锁最早被召回的块（假定它已经滑出模型窗口）
//   3. 任何一次成功召回都会让记忆"回到新鲜"（权重回升、衰减计时重置）
import { createHash } from 'node:crypto'
import { memoryCapabilities } from '../../../core/src/memory-capabilities.mjs'

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
  // v3（2026-11-12）：经历块是召回主单位——一次回忆尽量给一整段有上下文的经历。
  episode: { label: '经历', halfLifeDays: 120 },
  person: { label: '人物', halfLifeDays: 180 },
  slang: { label: '梗', halfLifeDays: 90 },
  // typed memory v2（Phase 2 起，additive）：稳定事实/偏好/承诺各一层，
  // 由 dream 的 events 同一次模型调用顺带抽出；先作为普通可召回命名空间存在，v2 再升级存储。
  fact: { label: '事实', halfLifeDays: 365 },
  preference: { label: '偏好', halfLifeDays: 180 },
  commitment: { label: '承诺', halfLifeDays: 60 },
  // 语料（lexicon）：memory 里注册为 recallable:true，但旧 recall 的 CATEGORIES 没列它，
  // 于是"她永远搜不到自己学过的词"（审计 F8）。这里纳入检索；是否值得注入由相关性门槛决定。
  lexicon: { label: '语料', halfLifeDays: 180 },
  // 主会话对记忆的纠正（"这件事我记错了"）：它是反馈队列，
  // 不是回忆（不参与 recall 检索），由整理轮消化。
  resolve: { label: '纠正', halfLifeDays: 1, recallable: false },
})

export function apply(ctx) {
  const memory = ctx.services.require('memory')
  const session = String(ctx.config.sessionId ?? 'default')
  const budgetTokens = Math.max(500, Number(ctx.config.budgetTokens) || DEFAULT_BUDGET_TOKENS)
  // 一次回忆默认返回几条：产品默认 6；粗粒度 episode 下多目标问题常需要 8 条才能覆盖，
  // 允许配置在评测里做 A/B（2026-11-13 第 10 轮）。
  const defaultLimit = Math.max(1, Math.min(20, Number(ctx.config.limit) || DEFAULT_LIMIT))
  // 相关性下限：memory.search 只过滤 sim<=0；这里再按"与 query 的相关度"挡掉
  // "字面碰巧共享一两个二字组"的凑数结果。有嵌入时用混合相似度，没嵌入时用二元组覆盖率。
  // cursor/继续翻 时放宽到 0.05（她要"再想想"，不能因为淡了就再也翻不出来）。
  // 2026-11-11 两轮标定（seed=gold 4 份 fixture + 真实 focus-core 端到端）：
  //   有嵌入 minSim 0.35→0.45：seed=gold 上 falseInjection 100%→0、r5 不降；
  //     end-to-end（formation→retrieval）r3/r5 50%→66.7%、miss 50%→33%；
  //   0.5 更保守（falseInjection 更低、r3 50%），但会漏掉"措辞差距大"的长问句；
  //   无嵌入保持 0.2：0.3 起 recall@3 明显下滑（alias 41.7%→25%），且无嵌入本来 falseInjection=0。
  const minSim = Math.max(0.01, Number(ctx.config.minSim ?? 0.45))
  const minSimNoEmbed = Math.max(0.01, Number(ctx.config.minSimNoEmbed ?? 0.2))
  // v3：episode 是唯一事件/经历记忆，v2 的 event/fact/preference/commitment 旧块只归档不召回。
  const memorySchema = String(ctx.config.schema ?? 'v2') === 'v3' ? 'v3' : 'v2'
  // 统一能力表：kind 枚举、默认检索范围、自知计数都以它为准，不在各处另写词表。
  const capabilities = memoryCapabilities(memorySchema)
  const kindIds = Object.keys(capabilities.kinds)
  // v3 可选：对 top 候选做一次 LLM 重排（默认关；lab A/B 验证用，线上需要显式打开）。
  // 复用 dream-chat 槽位（生产里已绑定）；槽位不可用时自动跳过，不影响召回。
  const rerankMode = String(ctx.config.rerank ?? 'off')
  const rerankTop = Math.max(4, Number(ctx.config.rerankTop ?? 8))
  const rerankSlot = String(ctx.config.rerankSlot ?? 'dream-chat')
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

  /**
   * 查询内容词门槛（2026-11-11 第 5 轮）：去掉"主人/今天/什么"这类高频功能词后，
   * 查询还剩哪些内容 2-gram？如果这些内容词在候选库里**一个都没出现**，那这次命中
   * 只是泛词面相似（"主人…"），不能当答案端给模型。
   * 例：「主人今天穿的什么颜色的衣服？」→ 内容词「颜色/衣服」库里 df=0 → 返回"没找到"，
   * 而不是把"主人说以后一起看直播"当答案。强语义命中（sim≥0.55）不受此限。
   */
  const QUERY_STOPWORDS = [
    '主人', '鱼鱼', '小千', '今天', '昨天', '刚才', '之前', '现在', '什么时候', '什么', '怎么', '为什么',
    '如何', '一下', '有没有', '有没', '那个', '这个', '我们', '他们', '可以', '已经', '还是', '就是',
    '事情', '结果', '记得', '上次', '以前', '第一次', '多久', '多少',
  ]
  function contentBigramsOf(query) {
    const raw = String(query ?? '').toLowerCase().replace(/\s+/g, '')
    let text = raw
    for (const word of QUERY_STOPWORDS) text = text.split(word).join('，')
    const grams = new Set()
    for (const run of (text.match(/[\u4e00-\u9fff]{2,}/g) ?? [])) {
      for (let i = 0; i + 1 < run.length; i += 1) grams.add(run.slice(i, i + 2))
    }
    for (const word of (raw.match(/[a-z][a-z0-9_]{1,}/g) ?? [])) grams.add(word)
    // 端口号/日期/群号这类 3 位以上数字是强内容词（"63071 端口为什么失败"靠它定位块）。
    for (const number of (raw.match(/\d{3,}/g) ?? [])) grams.add(number)
    return [...grams]
  }
  function hasContentSignal(question, texts) {
    const grams = contentBigramsOf(question)
    if (!grams.length) return true
    const bodies = (texts ?? []).map((text) => String(text ?? '').toLowerCase().replace(/\s+/g, ''))
    return grams.some((gram) => bodies.some((body) => body.includes(gram)))
  }
  /** 噪声笔记：纯表情/单字/空白笔记不参与回忆（QQ 实测 😭 笔记会挤掉真正的人物档案）。 */
  function isNoiseNoteItem(item) {
    if (!item || item.kind !== 'note') return false
    const text = String(item.text ?? '').replace(/\s+/g, '')
    if (!text) return true
    const meaningful = text.match(/[\u4e00-\u9fffA-Za-z0-9]/g) ?? []
    return meaningful.length < 2
  }

  /**
   * 复合问句拆查询（2026-11-11 第 6 轮）：真实用户常一句话问好几件事
   * （"最近在复习哪些科目？他觉得自己复习吃力的原因是什么？"）。
   * recall 是单查询检索器，整句的向量/字面会被稀释 → 拆成子句各搜一遍再合并。
   * 只在问句确实多子句时启用（最多 3 个），整句永远保留作第一优先级。
   */
  function expandQueries(question) {
    const text = String(question ?? '').trim()
    if (!text) return []
    const pieces = text
      .split(/[？?；;]+|(?:以及|还有|另外|同时|顺便)/)
      .map((part) => part.trim().replace(/[。！!？?，,]+$/, ''))
      .filter((part) => part.length >= 5)
    return [...new Set([text, ...pieces])].slice(0, 3)
  }

  /**
   * 指代消解（2026-11-11 第 13 轮）：问句里有"他/她/TA"时，用会话里**最近一个真人发言者**
   * 的称呼替换代词再搜一遍（"他凌晨说的新东西"→"Hahn123 凌晨说的新东西"）。
   * 只依赖 raw 层的 speaker 元数据；拿不到就不加变体，不猜。
   */
  async function pronounQueryVariants(question, { now = ctx.now(), conv = null } = {}) {
    const text = String(question ?? '').trim()
    if (!text || !/他|她|TA|ta/.test(text)) return []
    let rows = []
    try {
      rows = await Promise.resolve(ctx.services.raw?.list?.({ since: Number(now) - 12 * 3_600_000, until: Number(now) + 1, limit: 60 })) ?? []
    } catch { rows = [] }
    if (!Array.isArray(rows) || !rows.length) return []
    if (conv) {
      const scoped = rows.filter((row) => String(row?.conv ?? row?.origin?.conv ?? '') === String(conv))
      if (scoped.length) rows = scoped
    }
    const speakers = rows
      .map((row) => row?.speaker)
      .filter((speaker) => speaker && String(speaker.kind ?? '') === 'qq' && String(speaker.value ?? '').trim())
    const last = speakers[speakers.length - 1]
    if (!last) return []
    const name = String(last.name ?? '').trim()
    const value = String(last.value ?? '').trim()
    const form = name && name !== value ? name : value
    if (!form || form.length < 2) return []
    const replaced = text.replace(/他|她|TA|ta/g, form)
    return replaced !== text ? [replaced] : []
  }

  /**
   * 查询里的日期词 → 目标日历日（本地时区）。
   * 用户问"10月25日下午…"时，同一天的记忆应优先于别的日子；只做加分不硬过滤，
   * 因为块可能跨天合并、data.day 只记了开始日（硬过滤会误删）。
   */
  function parseQueryDay(question, now) {
    const text = String(question ?? '')
    const shiftDay = (days) => dayKey(dayStart(now) - days * 86_400_000)
    if (/前天/.test(text)) return shiftDay(2)
    if (/昨天|昨日/.test(text)) return shiftDay(1)
    if (/今天|今日/.test(text)) return shiftDay(0)
    const relative = /(\d{1,3})\s*天前/.exec(text)
    if (relative) return shiftDay(Number(relative[1]))
    const monthDay = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/.exec(text)
    if (monthDay) {
      const year = new Date(now).getFullYear()
      return `${year}-${String(Number(monthDay[1])).padStart(2, '0')}-${String(Number(monthDay[2])).padStart(2, '0')}`
    }
    return null
  }

  /**
   * 查询意图 → 优先的块形态（2026-11-11 第 11 轮）。
   * 同一天、同主题的候选分数往往很接近：问"她看到了什么"时事件块才是答案，
   * 问"答应/承诺了什么"时 typed commitment 才是答案。只做温和加分（≤1.3×），
   * 不改变候选集合，避免压掉别的正确形态。
   */
  function queryIntent(question) {
    const text = String(question ?? '')
    if (/(?:谁|是谁|什么关系|关系|怎么认识|认识谁|叫什么|名字|身份|昵称|别名|舍友|朋友|主人是)/i.test(text)) return 'person'
    if (/(?:答应|承诺|说好|保证|还没|未了|打算|计划|以后要|什么时候给)/.test(text)) return 'commitment'
    if (/(?:喜欢|讨厌|偏好|习惯|口味|怕什么|雷点|愿意|更想|宁可)/.test(text)) return 'preference'
    if (/(?:说过什么|说了什么|提过|提到过|事实|是不是|真的|有没有说过|知道什么)/.test(text)) return 'fact'
    if (/(?:发生了什么|做过|去过|看到|遇见|遇到|经历|那天|昨晚|上次|后来|结果|怎么[\u4e00-\u9fff]|做了什么)/.test(text)) return 'event'
    return 'mixed'
  }

  /** 意图加分表：key 是意图，value 是 namespace → 倍率。 */
  const INTENT_BOOST = {
    event: { event: 1.25, episode: 1.1, lexicon: 1.05 },
    commitment: { commitment: 1.3, episode: 1.15, fact: 1.1 },
    preference: { preference: 1.3, episode: 1.15, fact: 1.1 },
    fact: { fact: 1.2, episode: 1.15, commitment: 1.05 },
    person: { person: 1.3, episode: 1.05 },
    mixed: {},
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
      description: `With no query this is an overview of the last few days. kind narrows to ${kindIds.join(' / ')}; pass kind=person together with a QQ number or a name to read that person's file. query filters by meaning; tag narrows to a label. If nothing relevant is found it says so explicitly - with the scope searched and a next step - and never pads with unrelated notes. Passing cursor means "keep digging": it searches deeper, including things that have faded, and does not repeat what you already saw.`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: kindIds, description: 'Only this category.' },
          query: { type: 'string', description: 'What you are trying to remember.' },
          limit: { type: 'number', description: 'How many items (default 6).' },
          cursor: { type: 'string', description: 'Opaque cursor from the previous recall.' },
          conv: { type: 'string', description: 'Only memories that came from this conversation (origin.conv).' },
          tag: { type: 'string', description: 'Only blocks carrying this tag (e.g. \'看海\'). Tags narrow the search; they do not replace it.' },
          days: { type: 'number', description: 'With overview: how many days back. Default 2.' },
          overview: { type: 'boolean', description: 'Set true for a time-ordered summary of the last few days (what happened recently).' },
        },
      },
      async execute({ kind = null, query = '', limit = defaultLimit, cursor = null, tag = null, conv = null, days = 2, overview = false } = {}) {
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

        const question = String(query ?? '').trim()
        // 统一能力表：不认识的 kind 直接说清楚可用分类，不再回退到任何旧 namespace。
        if (kind && !Object.hasOwn(capabilities.kinds, kind)) {
          return { text: `没有这个记忆分类：${kind}。可用：${kindIds.join(' / ')}。`, cursor: null, more: false }
        }
        // 人物档案又长又"人味重"，容易占满召回配额；默认仍检索所有类别，
        // 但在挑选阶段给 person 最多 1 条配额（见下方 personQuota），既保留"是谁"的能力，
        // 又不让它把事件/fact 的位次全部挤掉（端到端实测 person profile 单条约 1500 tokens）。
        const namespaces = kind
          ? [kind]
          // resolve 是纠正反馈队列，不是回忆：即使 cursor 走 includeArchive 也不能混进来。
          : kindIds.filter((ns) => CATEGORIES[ns]?.recallable !== false)
        const seen = new Set()
        const deeper = Boolean(cursor)
        const floor = relevanceFloor({ deeper })
        let rawHitCount = 0
        const rawHitKeys = new Set()
        const bestById = new Map()
        // 复合问句拆查询只在"整句搜不够"时兜底：先按整句搜（精度最好），
        // 候选太少才拆子句补搜（召回兜底），避免拆句把精确结果挤下去（focus-core 实测 r5 80%→60%）。
        const collectHits = async (subQuery, minSim = floor, relaxed = false) => {
          for (const ns of namespaces) {
            // 带 cursor 就是"继续想"：深度更大，把权重很低的也翻出来（不做硬归档）
            const hits = await memory.search({
              namespace: ns, query: subQuery, limit: deeper ? 200 : 50, now,
              tags: tag ? [tag] : null, conv, includeArchive: deeper,
            })
            // 未消化的 note 不管哪天都要能被回忆；
            // 已消化的 note 已经变成块了，不能再以 note 身份重复出现。
            for (const hit of hits) {
              if (hit.item.kind === 'note' && hit.item.data?.consolidated === true) continue
              const hitKey = `${ns}:${hit.item.id}`
              if (!rawHitKeys.has(hitKey)) { rawHitKeys.add(hitKey); rawHitCount += 1 }
              // 有 query 时按相关度挡凑数；没有 query（纯"最近"视图）不筛。
              if (question && Number(hit.sim ?? 0) < minSim) continue
              const previous = bestById.get(hitKey)
              if (previous && Number(previous.score) >= Number(hit.score)) continue
              // 主动回忆是"被问到了"：低置信命中可以给，但要显式承认不确定（渲染时加 [记得不太清]）。
              const uncertain = relaxed || Number(hit.sim ?? 0) < 0.5
              bestById.set(hitKey, { ...hit, namespace: ns, uncertain, matchedQuery: subQuery })
            }
          }
        }
        const searchQueries = expandQueries(question)
        await collectHits(searchQueries[0] ?? '')
        if (question && searchQueries.length > 1 && bestById.size < Math.max(2, Math.floor(limit / 2))) {
          for (const subQuery of searchQueries.slice(1)) await collectHits(subQuery)
        }
        // 指代变体：整句/子句都不足 3 条时，用最近一个真人发言者的称呼替换"他/她/TA"再搜一遍。
        const pronounVariants = question ? await pronounQueryVariants(question, { now, conv }) : []
        if (question && pronounVariants.length && bestById.size < 3) {
          for (const variant of pronounVariants) await collectHits(variant, floor, false)
        }
        // entity 别名扩展：问句用了某实体的别名时，用同实体的另一个称呼/规范名再搜一遍
        // （"周子涵" 与 "Hahn123" 是同一个人，旧档案/事件可能只写了其中一个）。
        const entityVariants = (() => {
          if (!question) return []
          const entities = memory.query({ namespace: 'entity', kind: 'entity', limit: 500, order: 'desc' })
          for (const entity of entities) {
            if (entity.data?.stub === true) continue
            const forms = [...new Set([
              String(entity.text ?? '').trim(),
              ...(entity.data?.aliases ?? []).map((alias) => String(alias ?? '').trim()),
              ...(entity.data?.ids ?? []).map((id) => String(id?.value ?? '').trim()),
            ].filter((form) => form.length >= 2))]
            const matched = forms.find((form) => question.includes(form))
            if (!matched) continue
            const preferred = forms.find((form) => form !== matched && /[\u4e00-\u9fff]/.test(form)) ?? forms.find((form) => form !== matched)
            if (!preferred || preferred === matched || question.replace(matched, preferred) === question) continue
            return [question.replace(matched, preferred)]
          }
          return []
        })()
        if (question && entityVariants.length && bestById.size < 3) {
          for (const variant of entityVariants) await collectHits(variant, floor, false)
        }
        // 模糊兜底：严格 floor 一条都没命中时，用放宽的 floor 再找一轮（标 [记得不太清]）。
        // 没有这一步，"10月25日下午…升级…效果如何"这类转述问句会因为 sim 0.42-0.44 < 0.45 直接空手；
        // 有这一步，内容词门槛仍会挡住"完全没问到的属性"（如"穿什么颜色衣服"）。
        let relaxedPass = false
        const relaxedFloor = Math.max(0.3, floor - 0.12)
        if (question && bestById.size < 2) {
          relaxedPass = true
          for (const subQuery of (searchQueries.length ? searchQueries : [''])) {
            await collectHits(subQuery, relaxedFloor, true)
          }
        }
        // v3 分段索引：先匹配 episode 正文的"段"，再把命中段回映射到整个 episode。
        // 粗块整体向量会把问句细节稀释；段级向量能定位"哪一段在讲这件事"，返回仍是完整经历块。
        if (question && searchQueries.length) {
          const segmentFloor = Math.max(0.28, Math.min(floor, 0.45) - 0.1)
          for (const subQuery of searchQueries.slice(0, 2)) {
            const hits = await memory.search({ namespace: 'episode-seg', query: subQuery, limit: 80, now })
            for (const hit of hits) {
              if (Number(hit.sim ?? 0) < segmentFloor) continue
              const parentKey = String(hit.item.data?.parentKey ?? '')
              if (!parentKey) continue
              const parent = memory.query({ namespace: 'episode', kind: 'block', key: parentKey, limit: 1 })[0]
              if (!parent || parent.data?.superseded === true) continue
              const key = `episode:${parent.id}`
              const score = Number(hit.score ?? 0) * 0.9
              const previous = bestById.get(key)
              const segmentTexts = [...new Set([...(previous?.segmentTexts ?? []), String(hit.item.text ?? '')])].slice(0, 3)
              if (previous && Number(previous.score) >= score) {
                previous.segmentTexts = segmentTexts
                continue
              }
              bestById.set(key, {
                item: { id: parent.id, namespace: 'episode', kind: 'block', text: parent.text, data: parent.data, createdAt: parent.createdAt },
                namespace: 'episode', score, sim: Number(hit.sim ?? 0), segmentTexts,
                uncertain: Number(hit.sim ?? 0) < 0.5, matchedQuery: subQuery, segment: true,
              })
            }
          }
        }
        // v3：episode 单独放宽一轮。粗块正文长、embedding 相似度普遍低于原子块，
        // 严格 floor 会把正确块直接筛掉（实测期望块常落在 0.3–0.45）；这里只补 episode 候选，
        // 分数打折、标记低置信，后续仍有内容词门槛与 IDF/实体排序把关。
        if (question && searchQueries.length) {
          const episodeFloor = Math.max(0.22, Math.min(floor, 0.45) - 0.15)
          for (const subQuery of searchQueries.slice(0, 2)) {
            const hits = await memory.search({ namespace: 'episode', query: subQuery, limit: 60, now })
            for (const hit of hits) {
              if (Number(hit.sim ?? 0) < episodeFloor) continue
              const key = `episode:${hit.item.id}`
              const score = Number(hit.score ?? 0) * 0.75
              const previous = bestById.get(key)
              if (previous && Number(previous.score) >= score) continue
              bestById.set(key, { ...hit, namespace: 'episode', uncertain: Number(hit.sim ?? 0) < 0.5, matchedQuery: subQuery, widened: true })
            }
          }
        }
        // 关系问题（A 和 B 是什么关系）：先认出问句里的实体，再用"实体对 + 关系"补搜一遍。
        // 关系澄清经常写在不带双方名字的事件块里（"主人澄清曾嘉睿是舍友，周子涵和离线版都是他自己"），
        // 单靠整句相似度会被"同一个人/网关"这类高相似事实挤掉。
        const relationshipEntities = []
        const intent = question ? queryIntent(question) : 'mixed'
        if (question && intent === 'person') {
          const lowerQuestion = question.toLowerCase()
          const personRows = memory.query({ namespace: 'person', kind: 'block', limit: 200 })
          const seenEntities = new Set()
          for (const row of personRows) {
            const data = row.data ?? {}
            const forms = [...new Set([
              String(data.qq ?? '').trim(),
              ...(Array.isArray(data.aliases) ? data.aliases.map((alias) => String(alias ?? '').trim()) : []),
              ...(Array.isArray(data.ids) ? data.ids.map((id) => String(id?.value ?? '').trim()) : []),
            ].filter((form) => form.length >= 2))]
            if (!forms.some((form) => lowerQuestion.includes(form.toLowerCase()))) continue
            const canonical = String(data.qq ?? forms[0] ?? row.id)
            if (seenEntities.has(canonical)) continue
            seenEntities.add(canonical)
            relationshipEntities.push({ canonical, forms })
          }
          if (relationshipEntities.length >= 2) {
            const nameOf = (entity) => entity.forms.find((form) => /[\u4e00-\u9fff]/.test(form)) ?? entity.forms[0]
            const entityQuery = `${relationshipEntities.map(nameOf).join(' ')} 关系`
            await collectHits(entityQuery, relaxedFloor, true)
          }
        }
        // v3：实体对关系问题直接扫 episode。粗块正文可能只写"离线版/周子涵"等别名，
        // 单靠整句检索召不回；这里按"同时提到双方"直接把 episode 加进候选（后续仍有内容词门槛）。
        // 先补充 entity 层的实体（它的 aliases 覆盖所有称呼，比 person 档案的行更全）。
        if (question) {
          const lowerQ = question.toLowerCase()
          for (const row of memory.query({ namespace: 'entity', kind: 'entity', limit: 500 })) {
            if (row.data?.stub === true) continue
            const forms = [...new Set([
              String(row.text ?? '').trim(),
              ...(row.data?.aliases ?? []).map((alias) => String(alias ?? '').trim()),
              ...(row.data?.ids ?? []).map((id) => String(id?.value ?? '').trim()),
            ].filter((form) => form.length >= 2))]
            if (!forms.some((form) => lowerQ.includes(form.toLowerCase()))) continue
            if (relationshipEntities.some((entity) => entity.canonical === row.key)) continue
            relationshipEntities.push({ canonical: row.key, forms })
          }
        }
        if (relationshipEntities.length >= 2) {
          const episodeRows = memory.query({ namespace: 'episode', kind: 'block', limit: 500, order: 'desc' })
          const questionGrams = question ? contentBigramsOf(question) : []
          const matched = []
          for (const row of episodeRows) {
            if (row.data?.superseded === true || Number(row.data?.parts?.part) > 1) continue
            const haystack = `${row.text ?? ''} ${String(row.data?.body ?? '')} ${JSON.stringify(row.data?.people ?? [])} ${JSON.stringify(row.data?.entities ?? [])}`.toLowerCase()
            const mentioned = relationshipEntities.filter((entity) => entity.forms.some((form) => haystack.includes(form.toLowerCase()))).length
            if (mentioned < 2) continue
            const contentHits = questionGrams.filter((gram) => haystack.includes(gram)).length
            matched.push({ row, contentHits })
          }
          // 只补最相关的 3 块，分数按"问题内容词命中数"排序、略高于当前最好候选，
          // 避免实体对扫描用硬编码高分淹没真正的答案（p-03 实测被 6 块关系邻居挤出 top5）。
          matched.sort((a, b) => b.contentHits - a.contentHits || Number(b.row.createdAt ?? 0) - Number(a.row.createdAt ?? 0))
          const bestScore = [...bestById.values()].reduce((max, entry) => Math.max(max, Number(entry.score) || 0), 0)
          for (const [index, entry] of matched.slice(0, 3).entries()) {
            const key = `episode:${entry.row.id}`
            if (bestById.has(key)) continue
            bestById.set(key, {
              item: { id: entry.row.id, namespace: 'episode', kind: 'block', text: entry.row.text, data: entry.row.data, createdAt: entry.row.createdAt },
              namespace: 'episode',
              score: (bestScore + 0.6) * (1 - index * 0.04),
              sim: 0.6, uncertain: false, matchedQuery: 'entity-pair', boosted: true,
            })
          }
        }
        let candidates = [...bestById.values()].filter((entry) => !isNoiseNoteItem(entry.item))
        candidates.sort((a, b) => b.score - a.score || b.item.createdAt - a.item.createdAt)
        // 意图路由补召回（2026-11-13）：注释字段直接扫 episode。向量/字面索引只覆盖标题+正文，
        // 承诺/偏好/事实常常只存在于 episode.annotations 里，不扫就永远召不回。
        const annotationField = { commitment: 'commitments', preference: 'preferences', fact: 'facts' }[intent]
        if (question && annotationField) {
          const grams = contentBigramsOf(question)
          if (grams.length) {
            let addedByAnnotation = 0
            for (const row of memory.query({ namespace: 'episode', kind: 'block', limit: 500 })) {
              if (row.data?.superseded === true || Number(row.data?.parts?.part) > 1) continue
              const values = (row.data?.annotations?.[annotationField] ?? []).map(String).filter(Boolean)
              if (!values.length) continue
              const hits = values.filter((value) => {
                const plain = value.toLowerCase().replace(/\s+/g, '')
                return grams.some((gram) => plain.includes(gram))
              })
              if (!hits.length) continue
              const key = `episode:${row.id}`
              if (bestById.has(key)) continue
              bestById.set(key, {
                item: { id: row.id, namespace: 'episode', kind: 'block', text: row.text, data: row.data, createdAt: row.createdAt },
                namespace: 'episode',
                score: 0.6 + Math.min(0.15, hits.length * 0.05),
                sim: 0.6, uncertain: false, matchedQuery: 'annotation', boosted: true,
              })
              addedByAnnotation += 1
              if (addedByAnnotation >= 3) break
            }
            if (addedByAnnotation) {
              candidates = [...bestById.values()].filter((entry) => !isNoiseNoteItem(entry.item))
              candidates.sort((a, b) => b.score - a.score || b.item.createdAt - a.item.createdAt)
            }
          }
        }
        // 内容词门槛的取样要按"加分前"的纯相关度排序：日期/意图加分后 top8 可能全是事件块，
        // 把写着内容词的 fact 挤出采样区，导致明明有相关词却被判"没找到"（QQ p-05 实测）。
        // v3 经历块：内容词门槛要看"标题 + 正文开头"，否则创意标题不含问句用词会被误判"没找到"。
        const gateCandidateTexts = candidates.slice(0, 100).map((entry) => entry.item.namespace === 'episode'
          ? `${entry.item.text} ${String(entry.item.data?.body ?? '').slice(0, 400)} ${Object.values(entry.item.data?.annotations ?? {}).flat().join(' ').slice(0, 300)}`
          : entry.item.text)
        // 日期加分：问句带了"昨天/10月25日"这类日期时，同一天落库的记忆优先（只加分不硬过滤）。
        const queryDay = question ? parseQueryDay(question, now) : null
        if (queryDay && candidates.length) {
          let boostedByDay = false
          // 时间契约：日期命中优先看块的真实时间区间；day 只是没有时间戳时的兼容字段。
          const dayStart = Date.parse(`${queryDay}T00:00:00`)
          const dayEnd = dayStart + 86_400_000
          for (const entry of candidates) {
            const data = entry.item.data ?? {}
            const timeStart = Number(data.timeStart ?? 0)
            const timeEnd = Number(data.timeEnd ?? 0)
            const timeOverlap = Number.isFinite(timeStart) && Number.isFinite(timeEnd) && timeStart < dayEnd && timeEnd >= dayStart
            if (String(data.day ?? '') === queryDay || timeOverlap) {
              entry.score = Number(entry.score) * 1.35
              boostedByDay = true
            }
          }
          if (boostedByDay) candidates.sort((a, b) => b.score - a.score || b.item.createdAt - a.item.createdAt)
        }
        // 意图加分：问经历→事件块、问答应→commitment、问偏好→preference、问人→person。
        const intentWeights = INTENT_BOOST[intent] ?? {}
        if (Object.keys(intentWeights).length && candidates.length) {
          let boostedByIntent = false
          for (const entry of candidates) {
            const weight = intentWeights[entry.namespace]
            if (!weight) continue
            entry.score = Number(entry.score) * weight
            boostedByIntent = true
          }
          if (boostedByIntent) candidates.sort((a, b) => b.score - a.score || b.item.createdAt - a.item.createdAt)
        }
        // 实体对加分：问句里出现≥2 个已知实体时，同时提到双方（含别名）的块优先——
        // 关系澄清常常写在"曾嘉睿是舍友，周子涵和离线版都是他"这种块里，正文里同时有两边。
        if (relationshipEntities.length >= 2 && candidates.length) {
          const RELATION_CUE = /(舍友|室友|同一个人|一个人|朋友|主人|关系|是.{0,6}的|不是)/
          const entityProfileOf = (entry) => {
            const haystack = `${entry.item.text ?? ''}\n${String(entry.item.data?.body ?? entry.item.data?.profile ?? '')}`.toLowerCase()
            const mentioned = relationshipEntities.filter((entity) => entity.forms.some((form) => haystack.includes(form.toLowerCase()))).length
            return { mentioned, relationCue: RELATION_CUE.test(haystack) }
          }
          for (const entry of candidates) {
            const { mentioned, relationCue } = entityProfileOf(entry)
            // 关系陈述加分：同时提到双方、且正文在说关系（舍友/同一个人/朋友/主人…）的块最该是答案。
            if (mentioned >= 2) entry.score = Number(entry.score) * (relationCue ? 3.2 : 2.2)
            else if (mentioned === 1) entry.score = Number(entry.score) * (relationCue ? 1.2 : 1.1)
          }
          // 关系陈述块（非人物档案）直接排到前面：这类问题问的是"关系是什么"，
          // 人物档案只是佐证；只靠分数时低 base 的关系事件块永远进不了 top5。
          const relationRank = (entry) => {
            if (entry.namespace === 'person') return 0
            const { mentioned, relationCue } = entityProfileOf(entry)
            return mentioned >= 2 && relationCue ? 2 : mentioned >= 1 ? 1 : 0
          }
          candidates.sort((a, b) => relationRank(b) - relationRank(a) || b.score - a.score || b.item.createdAt - a.item.createdAt)
        }

        // v3 经历块内容词覆盖加分：标题通常是创意概括，问句用词更多落在正文里；
        // 按命中数量小幅加分，把"正文确实在讲这件事"的块提上来（不改变 v2 事件块排序）。
        // 用 IDF 权重：稀有词（弱爆了/盲人/端口号）比"舍友/主人"这类高频词更能定位答案。
        if (question && candidates.length) {
          const contentGrams = contentBigramsOf(question)
          if (contentGrams.length) {
            const normalize = (text) => String(text ?? '').toLowerCase().replace(/\s+/g, '')
            const episodeDocs = memory.query({ namespace: 'episode', kind: 'block', limit: 500 })
              .filter((row) => row.data?.superseded !== true && !(Number(row.data?.parts?.part) > 1))
              .map((row) => normalize(`${row.text ?? ''} ${String(row.data?.body ?? '')} ${Object.values(row.data?.annotations ?? {}).flat().join(' ')}`))
            const docCount = Math.max(1, episodeDocs.length)
            const df = new Map()
            for (const gram of contentGrams) {
              let count = 0
              for (const doc of episodeDocs) if (doc.includes(gram)) count += 1
              df.set(gram, count)
            }
            let boosted = false
            for (const entry of candidates) {
              if (entry.namespace !== 'episode') continue
              const annotationText = Object.values(entry.item.data?.annotations ?? {}).flat().join(' ')
              const haystacks = [
                normalize(`${entry.item.text ?? ''} ${String(entry.item.data?.body ?? '')} ${annotationText}`),
                ...(Array.isArray(entry.segmentTexts) ? entry.segmentTexts.map(normalize) : []),
              ]
              let bestWeight = 0
              for (const haystack of haystacks) {
                let weightSum = 0
                for (const gram of contentGrams) {
                  if (!haystack.includes(gram)) continue
                  let weight = Math.log(1 + docCount / ((df.get(gram) ?? 0) + 1))
                  // 端口号/群号这类数字内容词几乎唯一标识一段经历，权重加倍。
                  if (/^\d{3,}$/.test(gram)) weight *= 2.5
                  weightSum += weight
                }
                bestWeight = Math.max(bestWeight, weightSum)
              }
              if (!bestWeight) continue
              entry.score = Number(entry.score) * (1 + Math.min(1.2, bestWeight * 0.35))
              boosted = true
            }
            if (boosted) candidates.sort((a, b) => b.score - a.score || b.item.createdAt - a.item.createdAt)
          }
        }

        // 意图路由（v3，2026-11-13）：问承诺/偏好/事实时，答案常常只在 episode 的块内注释里
        // （正文没复述）。按注释字段做内容词匹配 → 温和加分，并把命中的注释挂到 entry 上供渲染。
        const ANNOTATION_FIELD = { commitment: ['commitments', '承诺'], preference: ['preferences', '偏好'], fact: ['facts', '事实'] }[intent]
        if (question && ANNOTATION_FIELD && candidates.length) {
          const [field, label] = ANNOTATION_FIELD
          const grams = contentBigramsOf(question)
          if (grams.length) {
            let boostedByAnnotation = false
            for (const entry of candidates) {
              if (entry.namespace !== 'episode') continue
              const values = (entry.item.data?.annotations?.[field] ?? []).map(String).filter(Boolean)
              if (!values.length) continue
              const matched = values.filter((value) => {
                const plain = value.toLowerCase().replace(/\s+/g, '')
                return grams.some((gram) => plain.includes(gram))
              })
              if (!matched.length) continue
              entry.score = Number(entry.score) * 1.4
              entry.intentAnnotations = matched.slice(0, 2)
              entry.annotationLabel = label
              boostedByAnnotation = true
            }
            if (boostedByAnnotation) candidates.sort((a, b) => b.score - a.score || b.item.createdAt - a.item.createdAt)
          }
        }

        // v3 可选 LLM 重排：只在显式开启时跑一次；失败/没槽位就保持原排序。
        if (question && rerankMode !== 'off' && candidates.length > 4) {
          try {
            const pool = candidates.slice(0, rerankTop)
            const catalog = pool.map((entry, index) => `[${index}] ${entry.item.text}｜${String(entry.item.data?.body ?? entry.item.data?.profile ?? '').slice(0, 320).replace(/\n/g, ' ')}`).join('\n')
            const raw = await ctx.slots.call(rerankSlot, {
              messages: [
                { role: 'system', content: '你是记忆检索重排器。根据用户问题，从候选记忆中挑出最能回答问题的 1–3 条（按相关程度排序）；没有相关的输出空数组。只输出 JSON：{"picks":[编号,...]}，不要解释。' },
                { role: 'user', content: `问题：${question}\n\n候选：\n${catalog}` },
              ],
              maxTokens: 240,
            })
            const match = /\{[\s\S]*\}/.exec(String(raw ?? ''))
            const parsed = match ? JSON.parse(match[0]) : {}
            const picks = (Array.isArray(parsed?.picks) ? parsed.picks : [])
              .map((value) => Number(value))
              .filter((value) => Number.isInteger(value) && value >= 0 && value < pool.length)
            if (picks.length) {
              const reordered = [...new Set(picks)].map((index) => pool[index])
              const rest = candidates.filter((entry) => !reordered.includes(entry))
              candidates = [...reordered, ...rest]
              ctx.log({ level: 'info', msg: 'recall.rerank', picks: picks.length, pool: pool.length })
            }
          } catch (error) {
            ctx.log({ level: 'warn', msg: 'recall.rerank-fail', error: String(error?.message ?? error).slice(0, 120) })
          }
        }

        // 今天的 note 永远优先展示（带 [今天] 标签）
        // 已经被梦境消化的 note 不再以"今天"的身份出现：
        // 它们已经变成块了，否则既重复又会把块挤出去。
        // 未消化的 note（任何日期）优先展示，标签用"未整理"
        // 不可回忆的类别（如 resolve 纠正队列）不能以待整理笔记的身份出现在回忆里。
        // 红队 D1/D3：未整理笔记也不能"不管问什么都先塞一半配额"——有 query 时同样要过相关度。
        // 未整理笔记：显式 kind 时只看该类别；默认视图看所有类别（碎片不该被路由规则吞掉）。
        const pendingNamespaces = kind && CATEGORIES[kind] && CATEGORIES[kind].recallable !== false
          ? [kind]
          : kindIds.filter((ns) => CATEGORIES[ns]?.recallable !== false)
        const pendingRaw = tag ? [] : pendingNamespaces.flatMap((ns) => memory.query({ namespace: ns, kind: 'note', limit: 200, order: 'desc' })
          .filter((item) => item.data?.consolidated !== true)
          .filter((item) => !isNoiseNoteItem(item))
          // 未整理笔记也要服从会话过滤，否则 "只搜这个会话" 会被别的会话的碎片污染。
          .filter((item) => !conv || String(item.data?.origin?.conv ?? '') === String(conv))
          .map((item) => ({ item, score: 1.15, namespace: ns })))
        const pendingNotes = question
          ? pendingRaw.filter((entry) => lexicalRelevance(entry.item.text, question) >= floor)
          : pendingRaw

        // 内容词门槛：只拦"弱相似 + 内容词完全没出现"的情况（强语义命中 sim≥0.55 不受限）。
        // 没有这道门槛时，「主人今天穿的什么颜色衣服」会因为"主人"高频词面把不相关记忆当答案。
        // 例外：top1 明显领先 top2（≥1.3×）说明确实有一条更像的，即使措辞换过（颜色 vs 蓝色）也放行。
        // 放宽二轮（relaxedPass）时只看最靠前的 3 条：低置信候选里混进一条含内容词的泛记忆，
        // 不能反过来替整组"凑数"（live 的"午饭吃了什么"实测过）。
        const topSim = Number(candidates[0]?.sim ?? 0)
        const secondSim = Number(candidates[1]?.sim ?? 0)
        // 单条"领先者"的放行规则：无嵌入时字面相似度天然偏低，单条命中即可信（颜色→蓝色的换措辞）；
        // 有嵌入时只有"放宽二轮"的单条才放行，严格轮的单条仍要过内容词门槛
        // （否则正文泛词会把"午饭吃了什么"这类没答案的问题凑上）。
        let embeddedIndex = false
        try { embeddedIndex = Boolean(memory.stats?.()?.embedded) } catch { embeddedIndex = false }
        const clearLeader = topSim >= 0.3 && secondSim === 0 && (!embeddedIndex || relaxedPass)
        const gateSample = gateCandidateTexts.length
        const contentOk = !question || topSim >= 0.55 || clearLeader
          || hasContentSignal(question, [
            // 门槛只看摘要（text）：正文更啰嗦，几乎总能蹭到一两个内容词（live"午饭吃了什么"
            // 实测被正文里的"吃了"放进来）；正文只参与排序，不参与"算不算相关"。
            ...gateCandidateTexts,
            ...pendingNotes.slice(0, gateSample).map((entry) => entry.item.text),
          ])
        const usableCandidates = contentOk ? candidates : []
        const usableNotes = contentOk ? pendingNotes : []
        if (!contentOk) {
          ctx.log({
            level: 'info', msg: 'recall.content-gate', query: question.slice(0, 60),
            topSim, secondSim, bigrams: contentBigramsOf(question).slice(0, 12), candidates: candidates.length,
          })
        }

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
        for (const entry of usableNotes.slice(0, noteQuota)) take(entry, '未整理')
        // person 配额：默认 1 条（人物档案很长，不能挤掉事件/fact 位次）；
        // 明确问"谁/关系/名字"时放宽到 2 条，关系类问题常常需要两边的人物块。
        const personQuota = intent === 'person' ? 2 : 1
        let personTaken = 0
        for (const entry of usableCandidates.slice(0, 100)) {
          // 人物配额只限制长档案（person block）：人物 note 是短事实，不该占档案配额，
          // 否则一条"😭"笔记就会把真正的复习/身份事实挤出结果（QQ p-01 实测）。
          if (entry.namespace === 'person' && entry.item.kind === 'block') {
            if (personTaken >= personQuota) continue
            personTaken += 1
          }
          take(entry, label(entry.namespace, entry.item.createdAt, now))
        }

        // 意图路由兜底（2026-11-13）：明确问"谁/关系/名字"时，人物档案常被更长的经历块压过；
        // 若候选里有 person 块却没被选中，强制补一条放在最前（关系类问题本来就需要档案佐证）。
        if (intent === 'person' && personTaken === 0) {
          const personCandidate = usableCandidates.find((entry) => entry.namespace === 'person')
          if (personCandidate && !seen.has(personCandidate.item.id) && !inWindow.has(personCandidate.item.id)) {
            const personText = renderEntry(personCandidate, label('person', personCandidate.item.createdAt, now))
            const cost = estimateTokens(personText)
            while (picked.length && tokens + cost > budgetTokens) {
              const removed = picked.pop()
              tokens -= removed.tokens
              const index = additions.findIndex((add) => add.id === removed.entry.item.id)
              if (index >= 0) additions.splice(index, 1)
            }
            if (picked.length === 0 || tokens + cost <= budgetTokens) {
              picked.unshift({ entry: personCandidate, tag: label('person', personCandidate.item.createdAt, now), text: personText, tokens: cost })
              additions.unshift({ id: personCandidate.item.id, tokens: cost })
              tokens += cost
              seen.add(personCandidate.item.id)
              ctx.log({ level: 'info', msg: 'recall.person-routing', query: question.slice(0, 40) })
            }
          }
        }

        const nextCursor = rollCursor(stored, additions)
        // 空召回/全在窗口内时不要写库；游标只在真的变化时落盘。
        if (additions.length || JSON.stringify(nextCursor.items) !== JSON.stringify(stored.items)) saveCursor(nextCursor)

        // 召回成功 → 回到新鲜
        if (picked.length) memory.boost(picked.map((p) => p.entry.item.id), { now })
        const pieces = picked.map((p) => p.text)
        // 可观测性：有候选却一条都没返回时，把过滤链路计数写进日志（排查"为什么空"用）。
        if (!pieces.length && (candidates.length || pendingNotes.length)) {
          ctx.log({
            level: 'info', msg: 'recall.empty-after-filter', query: question.slice(0, 60),
            kind: kind ?? 'all', candidates: candidates.length,
            usableCandidates: usableCandidates.length, pendingNotes: pendingNotes.length,
            usableNotes: usableNotes.length, contentOk, topSim, floor, relaxedPass, deeper,
          })
        }
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
          // 原文补细节也必须和查询有内容词交集：否则"午饭吃了什么"会把
          // raw 里的内部计划/环境文本当"原文"端出来（live 实测）。
          .filter((r) => !question || hasContentSignal(question, [String(r.text ?? '')]))
          .filter((r) => !pickedNorm.includes(String(r.text).toLowerCase().replace(/\s+/g, '').slice(0, 40)))
          .slice(0, 2)
          .map((r) => `原文（${shortDate(r.time ?? r.createdAt ?? ctx.now())}）：${String(r.text).slice(0, 160)}`)

        // 红队 D1：空结果必须说实话，并且分清三种"没有"：
        //   ① 范围里有候选、但都不够相关（不要端凑数、不要 boost）；
        //   ② 范围过滤后没有、但全局有记忆（不能说"也没记过"——全局假否定）；
        //   ③ 全局真的空（这才是"没记过"）。
        const anyKnown = usableNotes.length + usableCandidates.length > 0
        const globalItems = (() => { try { return Number(memory.stats?.()?.items ?? 0) } catch { return 0 } })()
        const scopeText = [kind ? `类型=${kind}` : null, tag ? `标签=${tag}` : null, conv ? `会话=${conv}` : null].filter(Boolean).join('、') || '全部类别'
        const searchedCount = rawHitCount + pendingRaw.length
        const emptyText = (() => {
          if (!question) return `最近没有能想起来的（范围内的记忆是空的）。${memoryCoverageHint()}`
          if (anyKnown) return '这几条刚才已经给过你了（就在上面的上下文里）；要找别的，把要找的事说具体一点。'
          if (searchedCount > 0) {
            // 不回显用户原话：一来没必要，二来"只搜这个会话"时别的会话的关键词会误导她以为搜到过。
            return `没找到相关记忆：检索了 ${searchedCount} 条（范围：${scopeText}），都不够相关。要不要换个说法、去掉 tag/会话过滤，或用 cursor 继续翻更早的？${memoryCoverageHint()}`
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
    // 主动回忆里低于"比较确定"阈值的命中：显式标"记得不太清"，不假装清晰。
    const lowConfidence = entry.uncertain === true ? '[记得不太清] ' : ''
    // 无出处/证据未核实的块（data.provisional）：不能和"有出处的事实"一样口气。
    const doubt = item.data?.provisional === true ? '[存疑] ' : ''
    if (tag === '未整理') {
      // 今天的就叫「今天」；跨天的片段才标「未整理 · 日期」。
      if (Number(item.createdAt) >= dayStart(nowOf(entry))) return `[今天] ${item.text}`
      const d = new Date(Number(item.createdAt))
      const day = `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`
      return `[未整理 · ${day}] ${item.text}`
    }
    if (tag === '今天') return `[今天] ${item.text}`
    // v3 经历块：标题 + 完整正文（长文本是刻意的——一次回忆给足上下文，不再只给一行原子摘要）。
    if (item.namespace === 'episode' && item.kind === 'block') {
      const body = String(item.data?.body ?? '').trim()
      const head = `[${tag}] ${doubt}${lowConfidence}${unsure}${item.text}`
      // 意图路由命中块内注释时，把答案直接附在正文后（否则承诺/偏好类问题只能看到正文）。
      const annotationLines = Array.isArray(entry.intentAnnotations) && entry.intentAnnotations.length
        ? `\n（块内${entry.annotationLabel ?? '注释'}：${entry.intentAnnotations.join('；')}）`
        : ''
      return body ? `${head}\n${body}${annotationLines}` : `${head}${annotationLines}`
    }
    // 人物档案：问"是谁/关系"时需要档案正文，不能只给一行标题（whois 仍是首选，但 recall
    // 作为兜底也得答得出来）。只截一段，避免把整份长档案塞进预算。
    if (item.namespace === 'person' && item.kind === 'block' && item.data?.profile) {
      const head = `[${tag}] ${doubt}${lowConfidence}${unsure}${item.text}`
      return `${head}\n${String(item.data.profile).trim().slice(0, 400)}`
    }
    if (item.kind === 'block') return `[${tag}] ${doubt}${lowConfidence}${unsure}${item.text}`
    return `[${tag} · 随手记] ${doubt}${lowConfidence}${unsure}${item.text}`
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

  /**
   * 记忆自知（v3）：给模型一个便宜、确定性的"我记忆里有什么"快照。
   * 走现有 world 状态总线（world_status 工具可展开 owner=memory），不另起一套提示词机制。
   */
  let memoryStateCache = { at: 0, value: null }
  function memoryState() {
    const now = ctx.now()
    if (memoryStateCache.value && now - memoryStateCache.at < 30_000) return memoryStateCache.value
    const live = (row) => row?.data?.superseded !== true && !(Number(row?.data?.parts?.part) > 1)
    const episodes = memorySchema === 'v3'
      ? memory.query({ namespace: 'episode', kind: 'block', limit: 800, order: 'desc' }).filter(live)
      : []
    const legacyEvents = memorySchema !== 'v3'
      ? memory.query({ namespace: 'event', kind: 'block', limit: 800, order: 'desc' }).filter(live)
      : []
    const mainRows = episodes.length ? episodes : legacyEvents
    const days = mainRows.map((row) => String(row.data?.day ?? '')).filter(Boolean).sort()
    const firstDay = days[0] ?? null
    const lastDay = days[days.length - 1] ?? null
    // 最近一次 episodes job 的结果（形成了几段/是否失败）
    let lastDream = null
    for (const row of memory.query({ namespace: 'dream-run', kind: 'run', limit: 120, order: 'desc' })) {
      if (!String(row.key ?? '').endsWith(':episodes')) continue
      const data = row.data ?? {}
      const finishedAt = Number(data.finishedAt ?? data.startedAt ?? row.createdAt ?? 0)
      lastDream = {
        day: String(data.referenceDay ?? data.day ?? String(row.key ?? '').split(':')[2] ?? ''),
        at: finishedAt || null,
        rngStart: Number(data.rangeStart ?? 0) || null,
        rngEnd: Number(data.rangeEnd ?? 0) || null,
        episodes: Number(data.episodes ?? 0),
        ok: data.status !== 'failed' && data.ok !== false,
        empty: data.empty === true,
      }
      break
    }
    const openCommitments = []
    for (const row of mainRows) {
      for (const text of row.data?.annotations?.commitments ?? []) {
        const value = String(text ?? '').trim()
        if (value.length >= 2 && !openCommitments.includes(value)) openCommitments.push(value)
      }
    }
    const recent = mainRows
      .slice()
      .sort((a, b) => String(b.data?.day ?? '').localeCompare(String(a.data?.day ?? '')))
      .slice(0, 5)
      .map((row) => `· ${String(row.data?.day ?? '').slice(5)} ${String(row.text ?? '').slice(0, 42)}`)
    const peopleBlocks = memory.query({ namespace: 'person', kind: 'block', limit: 500 }).filter(live)
    const lexiconCount = memory.query({ namespace: 'lexicon', kind: 'term', limit: 500 }).length
    const pendingNotes = memory.query({ namespace: 'note', kind: 'note', limit: 500 })
      .filter((row) => row.data?.status !== 'done' && row.data?.status !== 'archived').length
    const episodeCount = mainRows.length
    const hhmmOf = (value) => (value ? new Date(Number(value)).toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5) : '')
    const briefParts = [
      `${memorySchema === 'v3' ? '经历' : '事件'} ${episodeCount} 段${firstDay ? `（${firstDay.slice(5)}..${lastDay.slice(5)}）` : ''}`,
      lastDream ? `上次整理 ${lastDream.day ? lastDream.day.slice(5) : '—'}${lastDream.at ? ` ${hhmmOf(lastDream.at)}` : ''} 形成 ${lastDream.episodes} 段${lastDream.ok ? '' : '（失败）'}` : null,
      `人物 ${peopleBlocks.length}`,
      `语料 ${lexiconCount}`,
    ].filter(Boolean)
    const materialRange = lastDream?.rngStart && lastDream?.rngEnd
      ? `材料时间 ${new Date(lastDream.rngStart).toLocaleString('zh-CN', { hour12: false })}～${new Date(lastDream.rngEnd).toLocaleString('zh-CN', { hour12: false })}`
      : null
    const detailLines = [
      `记忆状态：${briefParts.join('；')}。`,
      lastDream ? `最近整理：${lastDream.day || '—'}${lastDream.at ? ` ${hhmmOf(lastDream.at)}` : ''}${lastDream.ok ? '' : '（失败，可能需要重跑）'}，形成 ${lastDream.episodes} 段${lastDream.empty ? '（当天没有值得留下的新经历）' : ''}${materialRange ? `；${materialRange}` : ''}。` : '还没有过记忆整理记录。',
      recent.length ? `最近 5 段：\n${recent.join('\n')}` : null,
      openCommitments.length ? `块内承诺注释（历史记录，不跟踪完成状态；可用 recall 搜索相关经历查看）：\n${openCommitments.slice(0, 8).map((text) => `· ${text.slice(0, 90)}`).join('\n')}` : null,
      `未消化笔记 ${pendingNotes} 条。记忆只覆盖整理过的内容；问过去细节先 recall（不确定就先查再答），问人用 whois。`,
    ].filter(Boolean)
    const value = { episodes: episodeCount, firstDay, lastDay, openCommitments, lastDream, brief: briefParts.join('；'), detail: detailLines.join('\n') }
    memoryStateCache = { at: now, value }
    return value
  }
  function memoryCoverageHint() {
    try {
      const state = memoryState()
      if (!state.episodes) return ''
      return `（当前记忆覆盖 ${state.firstDay ?? '—'}..${state.lastDay ?? '—'}，共 ${state.episodes} 段经历）`
    } catch { return '' }
  }
  // 世界状态总线：一行"记忆状态"，细节由 world_status owner=memory 展开（复用既有提示词装配）。
  try {
    const world = ctx.services.get?.('world') ?? null
    if (world?.registerSource) {
      world.registerSource({
        id: 'memory',
        owner: 'memory',
        title: '记忆',
        order: 70,
        cap: 1,
        empty: () => {
          const state = memoryState()
          return state.episodes ? '无新变化' : '还没有整理过记忆'
        },
        items: () => {
          const state = memoryState()
          if (!state.episodes) return []
          return [{ key: 'state', brief: state.brief, detail: state.detail }]
        },
      })
    }
  } catch (error) {
    ctx.log({ level: 'warn', msg: 'recall.world-source-fail', error: String(error?.message ?? error).slice(0, 120) })
  }
  tools.memory_status = {
    name: 'memory_status',
    summary: 'Check what my memory currently covers: episode count/date range, last dream, open commitments, people and lexicon totals.',
    when: ['before telling someone you do not remember something', 'when unsure how much memory you actually have', 'after a dream/nightly run to see what got formed'],
    avoid: ['looking up a specific past event - use recall', 'looking up a person - use whois'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute() {
      try { return { text: memoryState().detail } } catch (error) { return { text: `记忆状态读取失败：${String(error?.message ?? error).slice(0, 120)}` } }
    },
  }

  for (const tool of Object.values(tools)) ctx.tools.register(tool)
  ctx.services.provide('recall', { categories: CATEGORIES, budgetTokens, cursorOf: () => loadCursor(), resetCursor: () => { memory.remove({ namespace: cursorNamespace, key: cursorKey }); return { reset: true } } })
  ctx.log({ msg: 'recall.ready', session, budgetTokens })
}











