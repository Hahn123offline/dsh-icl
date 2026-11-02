// 梦境插件：被动沉淀，按 job 分批。
//
// 由节律在夜里触发（或手动 dream.run），每个 job 独立：
//   events  —— 今天的 note → 按话题切块 → event 块
//   people  —— 今天的 note(person) → 逐人整块重写 person 档案
//   slang   —— 今天的 note(slang) → 新增/更新梗块
//
// 三条工程约束：
//   1. 幂等：`dream-run` 命名空间里记 (day, job)，重跑跳过
//   2. 可重跑：每个 job 独立输入输出，失败只重跑那个
//   3. 不吞原文：成功后才把 note 标 consolidated；失败原文还在
//
// 摘要器的人格提示词由 config.persona 提供（或走 prompts/dream.md），
// 它是**独立调用**的"她"，不是主会话的她。
import fs from 'node:fs'
import path from 'node:path'

export const name = 'dream'

const DEFAULT_JOBS = ['events', 'people', 'lexicon', 'consume', 'cleanup', 'index']

function dayRange(now) {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  const start = d.getTime()
  return { start, end: start + 24 * 3600_000 }
}
function dayKey(now) {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 从模型输出里抠出 JSON（容忍 ```json 包裹与前后废话）。 */
export function parseBlocks(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return []
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const body = fenced ? fenced[1] : text
  const start = body.indexOf('[')
  const startObj = body.indexOf('{')
  const from = start >= 0 && (startObj < 0 || start < startObj) ? start : startObj
  if (from < 0) return []
  const end = Math.max(body.lastIndexOf(']'), body.lastIndexOf('}'))
  if (end <= from) return []
  try {
    const parsed = JSON.parse(body.slice(from, end + 1))
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch { return [] }
}

/**
 * 标签规范：小写、去重、限长、最多 5 个。
 * 标签只是"缩小范围"的工具，不能变成第二套语义索引。
 */
export function normalizeTags(tags, { max = 5, maxLen = 10 } = {}) {
  const out = []
  for (const raw of Array.isArray(tags) ? tags : []) {
    const tag = String(raw ?? '').trim().toLowerCase().replace(/[\s,\u3001]+/g, '')
    if (!tag || tag.length > maxLen) continue
    if (out.includes(tag)) continue
    out.push(tag)
    if (out.length >= max) break
  }
  return out
}

export function apply(ctx) {
  const memory = ctx.services.require('memory')
  const rhythm = ctx.services.require('rhythm')
  const slot = ctx.manifest.slots?.[0]?.id ?? 'dream-chat'
  const session = String(ctx.config.sessionId ?? 'default')

  memory.registerNamespace({ id: 'dream-run', label: '做梦记录', recallable: false, owner: 'dream' })

  const persona = String(ctx.config.persona ?? loadPersona(ctx) ?? '')

  async function ask({ instruction, payload, maxTokens = 1200 }) {
    const out = await ctx.slots.call(slot, {
      messages: [
        { role: 'system', content: [persona, instruction].filter(Boolean).join('\n\n') },
        { role: 'user', content: payload },
      ],
      maxTokens,
    })
    return String(out ?? '').trim()
  }

  function consolidated(notes) {
    return notes.filter((n) => n.data?.consolidated !== true)
  }

  function markNotes(notes, now) {
    for (const note of notes) {
      const data = { ...(note.data ?? {}), consolidated: true, consolidatedAt: now }
      memory.patch(note.id, { data })
    }
  }

  function runKey(day, job) { return `run:${day}:${job}` }
  function alreadyRan(day, job) {
    const rows = memory.query({ namespace: 'dream-run', kind: 'run', limit: 200 })
    return rows.some((r) => r.key === runKey(day, job))
  }
  function recordRun(day, job, detail, now) {
    memory.put({ namespace: 'dream-run', kind: 'run', key: runKey(day, job), text: `${day} ${job}`, data: detail, now })
  }

  /* ── events：按话题切块 ───────────────────────────────────────── */

  async function jobEvents({ now, force = false }) {
    const { start, end } = dayRange(now)
    const day = dayKey(now)
    if (!force && alreadyRan(day, 'events')) return { job: 'events', skipped: 'already-ran' }
    // 事件笔记也要跨天：太短没写成块的片段，明天要跟新材料一起重试。
    const notes = consolidated(memory.query({ namespace: 'event', kind: 'note', limit: 500 }))
    if (!notes.length) return { job: 'events', skipped: 'no-notes' }

    // 每行带稳定 id：摘要必须能指回原句。
    const payload = notes.map((n) => `[${n.id}] ${n.text}`).join('\n')
    let blocks = []
    try {
      const raw = await ask({
        instruction: [
          '把今天的笔记整理成若干"事件块"，不要写成日记或总结报告。',
          '按话题切：同一件事、同一个人、同一段对话放一块；不要按时间顺序切碎。',
          '每块输出一个对象：{"summary": "一行脱敏摘要（不含 QQ 号）", "body": "第一人称正文", "people": ["QQ号"], "tags": ["短标签"], "evidence": [id]}',
          'evidence 必须是上面真实存在的编号；不能编。没有出处的话不要写进块。',
          '只输出 JSON 数组，不要解释。没有值得记的就输出 []。',
        ].join('\\n'),
        payload,
      })
      blocks = parseBlocks(raw)
    } catch (error) {
      return { job: 'events', ok: false, error: String(error?.message ?? error) }
    }
    const written = []
    for (const block of blocks) {
      const summary = String(block?.summary ?? '').trim()
      if (!summary) continue
      const key = `evt:${day}:${hash(summary)}`
      const evidence = validEvidence(block?.evidence, notes)
      const created = memory.put({
        namespace: 'event',
        kind: 'block',
        key,
        text: summary.slice(0, 200),
        // 没有出处的块不拒写，但降级；证据存下来以后能追。
        ...(evidence.length ? {} : {}),
        data: {
          body: String(block?.body ?? '').slice(0, 4000),
          evidence,
          provisional: evidence.length === 0,
          day,
          people: (block?.people ?? []).map(String),
          tags: normalizeTags(block?.tags),
          sources: notes.map((n) => n.key).filter(Boolean),
        },
        now,
      })
      if (typeof memory.index === 'function') void memory.index(created.id, `${summary}\n${block?.body ?? ''}`)
      if (!evidence.length) {
        raiseQuestion({
          text: `「${summary.slice(0, 40)}」没有出处，以后问一下。`,
          about: { namespace: 'event', key },
          raisedBy: 'events',
        })
      }
      written.push(created.id)
    }
    // 只标"真的被某块引用过"的 note：部分覆盖时，没被引用到的继续待消化。
    const cited = new Set()
    for (const id of written) {
      const block = memory.query({ namespace: 'event', kind: 'block', limit: 200 }).find((b) => Number(b.id) === Number(id))
      for (const e of block?.data?.evidence ?? []) cited.add(Number(e.id))
    }
    const covered = notes.filter((n) => cited.has(Number(n.id)))
    if (covered.length) markNotes(covered, now)
    recordRun(day, 'events', { blocks: written.length, notes: notes.length, deferred: notes.length - covered.length }, now)
    return { job: 'events', ok: true, blocks: written.length, notes: notes.length, deferred: notes.length - covered.length }
  }

  /* ── people：逐人整块重写 ─────────────────────────────────────── */

  async function jobPeople({ now, force = false }) {
    const { start, end } = dayRange(now)
    const day = dayKey(now)
    if (!force && alreadyRan(day, 'people')) return { job: 'people', skipped: 'already-ran' }
    // 人物档案跨天：只要还没被消化，不管哪天的笔记都带上。
    const notes = consolidated(memory.query({ namespace: 'person', kind: 'note', limit: 500 }))
    if (!notes.length) return { job: 'people', skipped: 'no-notes' }

    // 按"通用身份"分组：qq 只是其中一种
    const byQq = new Map()
    for (const note of notes) {
      const subject = note.data?.subject ?? (note.data?.qq ? { kind: 'qq', value: String(note.data.qq) } : null)
      if (!subject?.value) continue
      const key = `${subject.kind}:${subject.value}`
      byQq.set(key, [...(byQq.get(key) ?? []), { ...note, __subject: subject }])
    }
    if (!notes.length) return { job: 'people', skipped: 'no-notes' }
    const written = []
    const skippedPeople = []
    for (const [qq, list] of byQq) {
      const [subjectKind, subjectValue] = (() => { const s = list[0]?.__subject ?? { kind: 'qq', value: qq }; return [s.kind, s.value] })()
      const key = subjectKind === 'qq' ? `person:${subjectValue}` : `person:${subjectKind}:${subjectValue}`
      const existing = memory.query({ namespace: 'person', kind: 'block', limit: 500 }).find((r) => r.key === key)
      // 人物档案要有"全局认识"：把过去提到过这个人的事件块也带上，
      // 否则每天只能拿到一句话，写出来的档案永远认不出是谁。
      const relatedEvents = memory.query({ namespace: 'event', kind: 'block', limit: 500 })
        .filter((b) => Array.isArray(b.data?.people) && b.data.people.map(String).includes(qq))
        .slice(-20)
      const pastNotes = memory.query({ namespace: 'person', kind: 'note', limit: 500 })
        .filter((n) => String(n.data?.qq ?? '') === qq && !list.some((x) => x.id === n.id))
        .slice(-20)

      const context = [
        `内部编号（不要写进档案）：${qq}`,
        existing ? `现有档案：\n${existing.text}\n${existing.data?.narrative ?? ''}` : '现有档案：无',
        relatedEvents.length ? `以前提到过 TA 的事：\n${relatedEvents.map((b) => `· ${b.text}`).join('\n')}` : '',
        pastNotes.length ? `以前记下的：\n${pastNotes.map((n) => `[${n.id}] ${n.text}`).join('\n')}` : '',
        `今天记下的：\n${list.map((n) => `[${n.id}] ${n.text}`).join('\n')}`,
      ].filter(Boolean).join('\n\n')

      let out = null
      try {
        out = await ask({
          instruction: [
            '你在写一份人物档案（整块重写）。读者是你自己，下次看到它要能认出这是谁。',
            '',
                        'profile 是一小段叙事，必须同时包含三部分：',
            '  ① 关系来源（怎么认识的、现在是什么关系）；',
            '  ② 一个具体事件（TA 说过或做过的一件事）；',
            '  ③ 一个当下的判断（你现在怎么看 TA）。',
            '材料少也要写：有几条写几条，但必须能认人。',
            '至少要写清：这个人是谁（称呼/和你的关系）+ 你知道的一件具体的事。',
            '目标是"一个陌生人读完大致能认识 TA"；不清楚的就不写，但不要因为少就不写。',
            '',
            '绝对不要：',
            '· 任何账号、数字编号写进 profile（它们放在结构化字段 ids 里）；',
            '· "还不了解""没写到""材料不够""还没成型""只露过几次面"这类元叙述；',
            '· 空泛的评价（"很好的人"）；',
            '· 材料里没有的细节。',
            '',
            '材料少就写得短：只写一句也可以，但那一句必须能认人。',
            '',
            '{"profile": "...", "facts": [], "aliases": [], "ids": [{"kind": "qq", "value": "..."}], "familiarity": "...", "evidence": [1, 2], "claims": [{"text": "档案里的一句话", "evidence": [1]}]}。只输出 JSON。',
            '',
            '注意：',
            '· 账号（QQ、MC 账号等）写进 ids，不要写进 profile；',
            '· "和 TA 不熟"属于 familiarity，不是元叙述；',
            '· 材料里没有的账号不要猜；不要推断性别，用名字或 TA。',
            '· ids 里的 kind 可以是 qq / mc / discord / 其它；新身份只追加，不覆盖旧的。',
            '· 不要把不同 QQ 的人当成同一个人；昵称/别名必须有明确原话（如「叫我XX」），不能由单个字猜。',
            '· 输出里要带 evidence：你用到的笔记编号数组。',
            '· claims：把 profile 里的每一句具体陈述拆开，各自带自己的 evidence；无法归因的就不要写进去。',
          ].join('\\n'),
          payload: context,
        })
      } catch (error) {
        return { job: 'people', ok: false, qq, error: String(error?.message ?? error) }
      }
      const parsed = parseBlocks(out)[0]
      let profile = String(parsed?.profile ?? '').trim()
      // 模型硬是不写时，用笔记原文拼一份薄档案——
      // 宁可少，不可空；下一次有新材料再整块重写。
      if (!profile) {
        profile = `目前知道的：${list.map((n) => n.text.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 3).join('；')}。`
      }
      if (!profile) { skippedPeople.push(qq); continue }
      const thin = list.length < 3 || profile.length < 60
      let evidence = validEvidence(parsed?.evidence, [...list, ...pastNotes])
      // 模型偶尔会漏掉 evidence：问一次"你用了哪几条"，而不是直接认为没有出处。
      if (!evidence.length && (list.length || pastNotes.length)) {
        try {
          const raw2 = await ask({
            instruction: '只输出 JSON：{"evidence": [编号]}。指出上面材料里支持这份档案的笔记编号，不要解释。',
            payload: [...list, ...pastNotes].map((n) => `[${n.id}] ${n.text}`).join('\n'),
            maxTokens: 200,
          })
          evidence = validEvidence(parseBlocks(raw2)?.[0]?.evidence ?? parseBlocks(raw2)?.[0], [...list, ...pastNotes])
        } catch { /* 补不上就当没有 */ }
      }
      const created = memory.put({
        namespace: 'person',
        kind: 'block',
        key,
        text: profile.slice(0, 800),
        data: {
          // 通用身份：以后 mc/discord/自定义都用同一套字段
          subject: { kind: subjectKind, value: subjectValue },
          qq: subjectKind === 'qq' ? subjectValue : null,
          ids: (() => {
            const ids = Array.isArray(parsed?.ids)
              ? parsed.ids.map((x) => ({ kind: String(x?.kind ?? ''), value: String(x?.value ?? '') })).filter((x) => x.kind && x.value).slice(0, 10)
              : ((existing?.data?.ids) ?? [])
            if (!ids.some((x) => x.kind === subjectKind && x.value === subjectValue)) ids.unshift({ kind: subjectKind, value: subjectValue })
            return ids
          })(),
          familiarity: String(parsed?.familiarity ?? existing?.data?.familiarity ?? 'unknown'),
          provisional: thin || evidence.length === 0,
          evidence,
          claims: (Array.isArray(parsed?.claims) ? parsed.claims : [])
            .map((c) => ({ text: String(c?.text ?? '').slice(0, 200), evidence: validEvidence(c?.evidence, [...list, ...pastNotes]) }))
            .filter((c) => c.text),
          profile: profile.slice(0, 2000),
          narrative: String(parsed?.narrative ?? '').slice(0, 4000),
          facts: Array.isArray(parsed?.facts) ? parsed.facts.slice(0, 50) : [],
          aliases: Array.isArray(parsed?.aliases) ? parsed.aliases.map(String).slice(0, 10) : ((existing?.data?.aliases) ?? []),
          sources: list.map((n) => n.key).filter(Boolean),
          rewrittenAt: now,
        },
        now,
      })
      if (typeof memory.index === 'function') void memory.index(created.id, profile)
      if (!evidence.length) {
        raiseQuestion({
          text: `关于「${profile.slice(0, 20)}」的档案没有出处，有机会核实一下。`,
          about: { namespace: 'person', key },
          raisedBy: 'people',
        })
      }
      written.push(created.id)
    }
    // 只标被档案引用到的 note（claims/evidence 里出现过的）。
    const citedPeople = new Set()
    for (const qq of new Set(notes.map((n) => String(n.data?.qq ?? '')).filter(Boolean))) {
      if (skippedPeople.includes(qq)) continue
      const block = memory.query({ namespace: 'person', kind: 'block', limit: 200 }).find((b) => b.data?.qq === qq)
      if (!block) continue
      for (const e of block.data?.evidence ?? []) citedPeople.add(Number(e.id))
      for (const c of block.data?.claims ?? []) for (const e of c.evidence ?? []) citedPeople.add(Number(e.id))
    }
    const writtenNotes = notes.filter((n) => citedPeople.has(Number(n.id)))
    if (writtenNotes.length) markNotes(writtenNotes, now)
    recordRun(day, 'people', { blocks: written.length, people: byQq.size, skipped: skippedPeople.length }, now)
    return { job: 'people', ok: true, blocks: written.length, people: byQq.size, skipped: skippedPeople.length }
  }

  /* ── slang：新增/更新梗块 ───────────────────────────────────── */

  async function jobSlang({ now, force = false }) {
    const { start, end } = dayRange(now)
    const day = dayKey(now)
    if (!force && alreadyRan(day, 'slang')) return { job: 'slang', skipped: 'already-ran' }
    const notes = consolidated(memory.query({ namespace: 'slang', kind: 'note', since: start, until: end, limit: 500 }))
    if (!notes.length) return { job: 'slang', skipped: 'no-notes' }

    let parsed = []
    try {
      parsed = parseBlocks(await ask({
        instruction: [
          '整理今天遇到的新梗/新用语。',
          '输出 JSON 数组：[{"term": "词", "meaning": "一句话意思", "usage": "什么时候用", "examples": ["例句"]}]',
          '只收今天真的出现过的，不要编。只输出 JSON。',
        ].join('\\n'),
        payload: notes.map((n) => `· ${n.text}`).join('\n'),
      }))
    } catch (error) {
      return { job: 'slang', ok: false, error: String(error?.message ?? error) }
    }
    const written = []
    for (const item of parsed) {
      const term = String(item?.term ?? '').trim()
      if (!term) continue
      const created = memory.put({
        namespace: 'slang',
        kind: 'block',
        key: `slang:${term}`,
        text: `${term}：${String(item?.meaning ?? '').slice(0, 120)}`,
        data: { term, meaning: String(item?.meaning ?? ''), usage: String(item?.usage ?? ''), examples: (item?.examples ?? []).slice(0, 5).map(String), sources: notes.map((n) => n.key).filter(Boolean) },
        now,
      })
      written.push(created.id)
    }
    markNotes(notes, now)
    recordRun(day, 'slang', { blocks: written.length }, now)
    return { job: 'slang', ok: true, blocks: written.length }
  }

  /* ── cleanup：合并、去重、处理纠正（放在最后）────────────── */

  /**
   * 整理轮：不产生新记忆，只把已有的块弄干净。
   *
   * 为什么放在所有 job 之后：
   *   · 它治的是"结果"，不是"输入"；先跑它只会在新块写出来前白忙一场
   *   · 万一整理失败，当天的新记忆已经落库，不会连带丢失
   * 范围：event / person / slang 都管。人物记错了也要改写，只不过改写请求要带着纠正去写。
   */
  /**
   * 提一个疑问到 note。防"为了填待办而填待办"：
   *   · 只在真的碰到矛盾/无证据/歧义时提
   *   · 按怎么写去重（已有未结的同样问题就不重复）
   *   · 每轮上限 5 条
   */
  const askedThisRun = new Set()
  function raiseQuestion({ text, about = null, evidence = [], raisedBy = 'dream' } = {}) {
    const noteSvc = ctx.services.get('note')
    if (!noteSvc?.add) return null
    const body = String(text ?? '').trim()
    if (!body) return null
    if (askedThisRun.size >= 5) return null
    if (askedThisRun.has(body)) return null
    const open = noteSvc.open?.() ?? []
    if (open.some((n) => String(n.text).trim() === body)) return null
    askedThisRun.add(body)
    return noteSvc.add({ text: body, about, raisedBy, kind: 'question' })
  }

  /** 校验模型给的 evidence：只保留真实存在的笔记 id。 */
  function validEvidence(list, notes) {
    const allow = new Set(notes.map((n) => Number(n.id)))
    return (Array.isArray(list) ? list : [])
      .map((x) => Number(x))
      .filter((x) => allow.has(x))
      .slice(0, 20)
      .map((id) => ({ type: 'note', id }))
  }

  /** 跨命名空间按 key 找块（key 前缀不一定等于命名空间）。 */
  function findBlockByKey(key) {
    const wanted = String(key ?? '')
    if (!wanted) return null
    for (const ns of ['event', 'person', 'slang']) {
      const hit = memory.query({ namespace: ns, kind: 'block', limit: 500 }).find((b) => b.key === wanted)
      if (hit) return hit
    }
    return null
  }

  async function jobCleanup({ now, force = false }) {
    const day = dayKey(now)
    if (!force && alreadyRan(day, 'cleanup')) return { job: 'cleanup', skipped: 'already-ran' }

    const pendingResolves = memory.query({ namespace: 'resolve', kind: 'note', limit: 100 })
      .filter((n) => n.data?.consumed !== true)

    const blocks = []
    for (const ns of ['event', 'person', 'slang']) {
      for (const b of memory.query({ namespace: ns, kind: 'block', limit: 60 })) {
        if (b.data?.superseded === true) continue
        blocks.push({ ns, key: b.key, id: b.id, text: b.text, people: (b.data?.people ?? []).map(String), body: String(b.data?.body ?? b.data?.profile ?? b.data?.narrative ?? '').slice(0, 400) })
      }
    }
    if (blocks.length < 2 && !pendingResolves.length) return { job: 'cleanup', skipped: 'nothing-to-do' }

    const payload = [
      '现有记忆块（key | 类型 | 摘要 | 正文）：',
      ...blocks.map((b) => `- ${b.key} | ${b.ns}${b.people.length ? ` | people=${b.people.join(',')}` : ''} | ${b.text} | ${b.body.replace(/\n/g, ' ').slice(0, 200)}`),
      pendingResolves.length
        ? '\n主会话的纠正（必须处理）：\n' + pendingResolves.map((n) => {
          const about = n.data?.about
          return about?.key ? `- [针对 ${about.key}] ${n.text}` : `- ${n.text}`
        }).join('\n')
        : '',
    ].filter(Boolean).join('\n')

    let plan = null
    try {
      plan = parseBlocks(await ask({
        instruction: [
          '你在整理已有的记忆块。不新增事实，只合并/去重/改写。',
          '输出一个 JSON 对象：',
          '{"merges": [{"keep": "key", "drop": ["key"], "text": "合并后的一行摘要", "body": "合并后的正文", "uncertain": false}],',
          ' "rewrites": [{"key": "key", "text": "改写后的摘要", "body": "改写后的正文"}],',
          ' "consumed": ["resolve note key"]}',
          '',
          '规则：',
          '· 只合并真正说的是同一件事/同一个人的块；没把握就不合并。',
          '· 两个块互相矛盾且分不清对错：合并为一块并把 uncertain 设为 true，正文里写明"不确定"。',
          '· 人物块可以用 people 里含该 QQ 的事件块来补充或修正；改写时整块重写，不要丢旧信息。',
          '· 主会话的纠正优,：按它改写对应的块（事件或人物档案），并把对应 resolve note 放进 consumed。',
          '· 合并后的 text 一行、body 一小段；删掉的 key 不要再出现在别的操作里。',
          '· 不要为了“长度差不多”而合并：小块没有矛盾就原样留着。',
          '· 目标是去重与消除矛盾，不是把所有块整理成一个样子。',
          '没什么可整理就输出 {} 。只输出 JSON。',
        ].join('\\n'),
        payload,
        maxTokens: 1500,
      }))
    } catch (error) {
      return { job: 'cleanup', ok: false, error: String(error?.message ?? error) }
    }

    // parseBlocks 对象也会装成数组，先取出那个对象再读字段。
    const root = Array.isArray(plan) ? (plan[0] ?? {}) : (plan ?? {})
    const merged = Array.isArray(root?.merges) ? root.merges : []
    const rewrites = Array.isArray(root?.rewrites) ? root.rewrites : []
    const consumed = Array.isArray(root?.consumed) ? root.consumed.map(String) : []
    let mergedCount = 0
    let rewriteCount = 0

    for (const op of merged) {
      const keepKey = String(op?.keep ?? '').trim()
      if (!keepKey) continue
      const drop = (Array.isArray(op?.drop) ? op.drop : []).map(String).filter((k) => k && k !== keepKey)
      const text = String(op?.text ?? '').trim()
      if (!text) continue
      const existing = findBlockByKey(keepKey)
      if (!existing) continue
      const ns = existing.namespace
      const data = {
        ...(existing.data ?? {}),
        body: String(op?.body ?? existing.data?.body ?? '').slice(0, 4000),
        uncertain: op?.uncertain === true,
        mergedFrom: [...new Set([...(existing.data?.mergedFrom ?? []), ...drop])],
      }
      memory.put({ namespace: ns, kind: 'block', key: keepKey, text: text.slice(0, 400), data, now })
      if (data.uncertain) {
        raiseQuestion({
          text: `这件事记不准：${text.slice(0, 60)}。找合适的时机问一下。`,
          about: { namespace: ns, key: keepKey },
          evidence: data.evidence ?? [],
          raisedBy: 'cleanup',
        })
      }
      for (const dropKey of drop) {
        const target = findBlockByKey(dropKey)
        if (!target) continue
        memory.patch(target.id, { data: { ...(target.data ?? {}), superseded: true, supersededBy: keepKey } })
      }
      mergedCount += 1
    }

    for (const op of rewrites) {
      const key = String(op?.key ?? '').trim()
      if (!key) continue
      const existing = findBlockByKey(key)
      if (!existing) continue
      if (op?.text) memory.patch(existing.id, { text: String(op.text).slice(0, 400) })
      if (op?.body) memory.patch(existing.id, { data: { ...(existing.data ?? {}), body: String(op.body).slice(0, 4000) } })
      if (Array.isArray(op?.evidence) && op.evidence.length) {
        const ev = op.evidence.map((x) => ({ type: 'block', id: Number(x) })).filter((x) => Number.isFinite(x.id))
        if (ev.length) memory.patch(existing.id, { data: { ...(existing.data ?? {}), evidence: [...(existing.data?.evidence ?? []), ...ev] } })
      }
      rewriteCount += 1
    }

    // 纠正处理完后，把它对应的疑问一并关掉（note 就是为这个存在的）。
    const noteSvc = ctx.services.get('note')
    for (const note of pendingResolves) {
      const key = note.data?.about?.key
      if (!key || !noteSvc?.resolve) continue
      for (const q of noteSvc.open?.() ?? []) {
        if (q.data?.about?.key === key) noteSvc.resolve(q.id, { answer: String(note.text).slice(0, 200) })
      }
    }

    for (const noteKey of consumed) {
      const note = pendingResolves.find((n) => n.key === noteKey)
      if (note) memory.patch(note.id, { data: { ...(note.data ?? {}), consumed: true, consumedAt: now } })
    }

    recordRun(day, 'cleanup', { merged: mergedCount, rewrites: rewriteCount, consumed: consumed.length }, now)
    return { job: 'cleanup', ok: true, merged: mergedCount, rewrites: rewriteCount, consumed: consumed.length }
  }

  /* ── index：补建向量索引（最后一步）───────────────── */

  /**
   * 补向量：嵌入服务是后接上的时候，之前写的块没有向量；
   * 它们只能靠字面搜到。这一步把缺的补上。
   * 手动接口：`dream.run({ jobs: ['index'] })`。
   */
  async function jobIndex({ now, force = false }) {
    const day = dayKey(now)
    if (!force && alreadyRan(day, 'index')) return { job: 'index', skipped: 'already-ran' }
    const missing = memory.missingVectors({ limit: 200 })
    if (!missing.length) return { job: 'index', skipped: 'nothing-missing' }
    let indexed = 0
    for (const item of missing) {
      try {
        const ok = await memory.index(item.id, item.text)
        if (ok) indexed += 1
      } catch { /* 单条失败不影响其他 */ }
    }
    recordRun(day, 'index', { indexed, missing: missing.length }, now)
    return { job: 'index', ok: true, indexed, missing: missing.length }
  }

  /* ── lexicon：从对话里发现新词与用法变化 ─────── */

  /** 老化：很久没出现的词，usage 变 fading、权重下降。 */
  function ageLexicon(now) {
    const svc = ctx.services.get('lexicon')
    let faded = 0
    for (const row of svc?.query?.() ?? []) {
      const last = Number(row.data?.decay?.lastSeen ?? row.createdAt ?? 0)
      if ((now - last) / 86_400_000 < 30) continue
      const data = { ...(row.data ?? {}) }
      data.usageState = 'fading'
      data.decay = { weight: Math.max(0.1, Number(data.decay?.weight ?? 1) * 0.7), lastSeen: last }
      memory.patch(row.id, { data })
      faded += 1
    }
    return faded
  }

  // 按配置时区算当天
  function ymdInTz(now) {
    const tz = String(ctx.config.timezone ?? 'Asia/Hong_Kong')
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now))
  }
  function dayStartOf(now) { return Date.parse(`${ymdInTz(now)}T00:00:00+08:00`) }
  function dayEndOf(now) { return dayStartOf(now) + 86400000 }

  async function jobLexicon({ now, force = false }) {
    const day = dayKey(now)
    if (!force && alreadyRan(day, 'lexicon')) return { job: 'lexicon', skipped: 'already-ran' }
    // slang 已并入 lexicon：采集范围包括旧的 slang 笔记
    // 采集要看原话，不是看摘要：短梗（如「6」、「彳亠」）根本不会变成 note
    let sourceLines = []
    try {
      const today = memory.query({ namespace: 'event', kind: 'note', limit: 1 })
      void today
      const rawRows = await ctx.services.raw?.list?.({ since: dayStartOf(now), until: dayEndOf(now), limit: 400 }) ?? []
      sourceLines = rawRows.map((m) => String(m.text ?? '')).filter(Boolean)
    } catch { /* 没有原文来源就退回笔记 */ }
    const notes = ['event', 'slang'].flatMap((ns) => consolidated(memory.query({ namespace: ns, kind: 'note', limit: 200 })))
    const lexicon = ctx.services.get('lexicon')
    if (!lexicon) return { job: 'lexicon', skipped: 'no-lexicon-plugin' }
    // 没有新笔记也要做老化
    if (!notes.length && !sourceLines.length) {
      const faded0 = ageLexicon(now)
      recordRun(day, 'lexicon', { learned: 0, faded: faded0 }, now)
      return { job: 'lexicon', ok: true, learned: 0, faded: faded0 }
    }

    const known = (ctx.services.get('lexicon').query?.() ?? []).map((x) => x.data?.term).filter(Boolean).slice(0, 50)
    let items = []
    try {
      const raw = await ask({
        instruction: [
          '你在给词汇建档案：目的不是考你认不认识，而是记下这里真的怎么用它。',
          '宁可多候选，不要主动猜。下面这几类都要列：',
          '  · 你不确定它在这里是什么意思',
          '  · 你知道它的旧意，但怀疑这里用的是新意',
          '  · 本群特有的说法、缩写、代称',
          '  · 今天反复出现的说法',
          'meaning 只写你有把握且与这里用法一致的解释；没把握就留空，不要猜。',
          `已有词汇：${known.join('、') || '无'}`,
          '输出 [{"term":"词","meaning":"","reason":"unknown|shifted|in-group|frequent"}]；没有就 []。只输出 JSON 数组。',
        ].join('\n'),
        payload: (sourceLines.length ? sourceLines.join('\n') : notes.map((n) => n.text).join('\n')).slice(0, 8000),
        maxTokens: 800,
      })
      if (ctx.config.debugLexicon) console.error('[lexraw]', JSON.stringify(String(raw).slice(0, 400)), 'src=', sourceLines.length, 'payload=', JSON.stringify((sourceLines.length ? sourceLines.join('\n') : notes.map((n) => n.text).join('\n')).slice(0, 120)))
      items = parseBlocks(raw)
    } catch (error) {
      return { job: 'lexicon', ok: false, error: String(error?.message ?? error) }
    }

    let learned = 0
    for (const item of items) {
      const term = String(item?.term ?? '').trim()
      if (!term) continue
      const res = lexicon.upsert({
        term,
        conv: String(item?.conv ?? '').trim() || 'web',
        meaning: String(item?.meaning ?? '').trim(),
        tags: item?.hot ? ['热词'] : ['自动发现'],
      })
      if (res?.ok) learned += 1
    }

    const faded = ageLexicon(now)

    recordRun(day, 'lexicon', { learned, faded }, now)
    return { job: 'lexicon', ok: true, learned, faded }
  }

  /* ── consume：回收已完成的备忘 ──────────────── */

  /**
   * 主会话把一条备忘标成 done 之后，晚上把结论写回它归属的地方。
   *
   * 只做三个明确分支（不上抽象）：lexicon / person / event。
   * 防“为了写而写”：没有 result 且没有追加内容的，不写，也不归档。
   */
  async function jobConsume({ now, force = false }) {
    const day = dayKey(now)
    if (!force && alreadyRan(day, 'consume')) return { job: 'consume', skipped: 'already-ran' }
    const noteSvc = ctx.services.get('note')
    if (!noteSvc) return { job: 'consume', skipped: 'no-note-plugin' }
    const done = memory.query({ namespace: 'note', kind: 'note', limit: 200 })
      .filter((n) => n.data?.status === 'done')

    let written = 0
    let archived = 0
    for (const row of done) {
      const about = row.data?.about
      const result = String(row.data?.result ?? '').trim() || String((row.data?.updates ?? []).at(-1)?.text ?? '').trim()
      if (!about?.namespace || !result) continue
      let ok = false
      try {
        if (about.namespace === 'lexicon') {
          const key = String(about.key ?? '')
          const existing = memory.query({ namespace: 'lexicon', kind: 'term', limit: 200 }).find((x) => x.key === key)
          // about 里已经带了显式字段，不再依赖从键里拆
          const term = about.term ?? existing?.data?.term ?? key.split(':').pop()
          const conv = about.conv ?? existing?.data?.origins?.find((o) => o.conv)?.conv ?? 'web'
          const svc = ctx.services.get('lexicon')
          const source = row.data?.source ?? null
          if (svc?.upsert) { svc.upsert({ term, conv, meaning: result, url: source && source.startsWith('http') ? source : null, platform: source && !source.startsWith('http') ? source : null }); ok = true }
        } else if (about.namespace === 'person') {
          memory.put({ namespace: 'person', kind: 'note', text: `（备忘回收）${result}`, data: { consolidated: false, fromNote: row.id }, now })
          ok = true
        } else if (about.namespace === 'event') {
          memory.put({ namespace: 'event', kind: 'note', text: `（备忘回收）${result}`, data: { consolidated: false, fromNote: row.id }, now })
          ok = true
        }
      } catch { ok = false }
      if (!ok) continue
      memory.patch(row.id, { data: { ...(row.data ?? {}), status: 'archived', consumedAt: now } })
      written += 1
      archived += 1
    }
    recordRun(day, 'consume', { written, archived }, now)
    return { job: 'consume', ok: true, written, archived }
  }

  const JOBS = { events: jobEvents, people: jobPeople, slang: jobSlang, lexicon: jobLexicon, consume: jobConsume, cleanup: jobCleanup, index: jobIndex }

  /**
   * 跑一轮做梦。jobs 可按需指定（默认三个都跑）。
   * @returns {{ok:boolean, day:string, results:object[]}}
   */
  async function run({ now = ctx.now(), jobs = DEFAULT_JOBS, force = false } = {}) {
    const day = dayKey(now)
    const results = []
    for (const name of jobs) {
      const job = JOBS[name]
      if (!job) { results.push({ job: name, ok: false, error: 'unknown-job' }); continue }
      try { results.push(await job({ now, force })) } catch (error) { results.push({ job: name, ok: false, error: String(error?.message ?? error) }) }
    }
    const ok = results.every((r) => r.ok !== false)
    return { ok, day, results }
  }

  const off = rhythm.onNightly((event) => { void run({ now: event?.at ?? ctx.now() }) })
  ctx.onDispose(off)
  if (typeof rhythm.isDue === 'function' && rhythm.isDue()) void run()

  ctx.services.provide('dream', { run, jobs: Object.keys(JOBS), slot, persona })
  ctx.log({ msg: 'dream.ready', slot, jobs: Object.keys(JOBS), hasPersona: Boolean(persona) })
}

function hash(text) {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0
  return h.toString(36)
}

function loadPersona(ctx) {
  const file = ctx.config.personaFile || path.join(String(ctx.config.root ?? '.'), 'prompts', 'dream.md')
  try { return fs.readFileSync(file, 'utf8') } catch { return null }
}
