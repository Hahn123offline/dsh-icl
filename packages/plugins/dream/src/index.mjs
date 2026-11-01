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

const DEFAULT_JOBS = ['events', 'people', 'slang']

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
    const notes = consolidated(memory.query({ namespace: 'event', kind: 'note', since: start, until: end, limit: 500 }))
    if (!notes.length) return { job: 'events', skipped: 'no-notes' }

    const payload = notes.map((n, i) => `${i + 1}. ${n.text}`).join('\n')
    let blocks = []
    try {
      const raw = await ask({
        instruction: [
          '把今天的笔记整理成若干"事件块"，不要写成日记或总结报告。',
          '按话题切：同一件事、同一个人、同一段对话放一块；不要按时间顺序切碎。',
          '每块输出一个对象：{"summary": "一行脱敏摘要（不含 QQ 号）", "body": "第一人称正文，保留细节", "people": ["QQ号"], "tags": ["短标签"]}',
          '只输出 JSON 数组，不要解释。没有值得记的就输出 []。',
        ].join('\n'),
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
      const created = memory.put({
        namespace: 'event',
        kind: 'block',
        key,
        text: summary.slice(0, 200),
        data: {
          body: String(block?.body ?? '').slice(0, 4000),
          day,
          people: (block?.people ?? []).map(String),
          tags: (block?.tags ?? []).map(String),
          sources: notes.map((n) => n.key).filter(Boolean),
        },
        now,
      })
      if (typeof memory.index === 'function') void memory.index(created.id, `${summary}\n${block?.body ?? ''}`)
      written.push(created.id)
    }
    markNotes(notes, now)
    recordRun(day, 'events', { blocks: written.length, notes: notes.length }, now)
    return { job: 'events', ok: true, blocks: written.length, notes: notes.length }
  }

  /* ── people：逐人整块重写 ─────────────────────────────────────── */

  async function jobPeople({ now, force = false }) {
    const { start, end } = dayRange(now)
    const day = dayKey(now)
    if (!force && alreadyRan(day, 'people')) return { job: 'people', skipped: 'already-ran' }
    const notes = consolidated(memory.query({ namespace: 'person', kind: 'note', since: start, until: end, limit: 500 }))
    if (!notes.length) return { job: 'people', skipped: 'no-notes' }

    const byQq = new Map()
    for (const note of notes) {
      const qq = String(note.data?.qq ?? '').trim()
      if (!qq) continue
      byQq.set(qq, [...(byQq.get(qq) ?? []), note])
    }
    const written = []
    for (const [qq, list] of byQq) {
      const key = `person:${qq}`
      const existing = memory.query({ namespace: 'person', kind: 'block', limit: 500 }).find((r) => r.key === key)
      // 人物档案要有"全局认识"：把过去提到过这个人的事件块也带上，
      // 否则每天只能拿到一句话，写出来的档案永远认不出是谁。
      const relatedEvents = memory.query({ namespace: 'event', kind: 'block', limit: 500 })
        .filter((b) => Array.isArray(b.data?.people) && b.data.people.map(String).includes(qq))
        .slice(-20)
      const pastNotes = memory.query({ namespace: 'person', kind: 'note', limit: 500 })
        .filter((n) => String(n.data?.qq ?? '') === qq && n.data?.consolidated === true)
        .slice(-20)

      const context = [
        `内部编号（不要写进档案）：${qq}`,
        existing ? `现有档案：\n${existing.text}\n${existing.data?.narrative ?? ''}` : '现有档案：无',
        relatedEvents.length ? `以前提到过 TA 的事：\n${relatedEvents.map((b) => `· ${b.text}`).join('\n')}` : '',
        pastNotes.length ? `以前记下的：\n${pastNotes.map((n) => `· ${n.text}`).join('\n')}` : '',
        `今天记下的：\n${list.map((n) => `· ${n.text}`).join('\n')}`,
      ].filter(Boolean).join('\n\n')

      let out = null
      try {
        out = await ask({
          instruction: [
            '你在写一份人物档案（整块重写）。读者是你自己，下次看到它要能认出这是谁。',
            '',
            'profile 的写法（严格）：',
            '第一句：称呼 + 你们的关系（如："室友、琐友、老板")；',
            '第二句起：一两件具体的事（TA 说过什么、做过什么）；',
            '最后：TA 现在的状态或你对 TA 的直觉。',
            '',
            '绝对不要：',
            '· QQ 号、数字编号；',
            '· "还不了解""没写到""材料不够""还没成型""只露过几次面"这类元叙述；',
            '· 空泛的评价（"很好的人"）；',
            '· 材料里没有的细节。',
            '',
            '材料少就写得短：只写一句也可以，但那一句必须能认人。',
            '',
            '输出一个 JSON 对象：{"profile": "...", "facts": [{"text": "...", "since": "YYYY-MM-DD"}], "aliases": []}。只输出 JSON。',
          ].join('\n'),
          payload: context,
        })
      } catch (error) {
        return { job: 'people', ok: false, qq, error: String(error?.message ?? error) }
      }
      const parsed = parseBlocks(out)[0]
      const profile = String(parsed?.profile ?? parsed?.summary ?? '').trim()
      if (!profile) continue
      const created = memory.put({
        namespace: 'person',
        kind: 'block',
        key,
        text: profile.slice(0, 400),
        data: {
          qq,
          profile,
          narrative: String(parsed?.narrative ?? '').slice(0, 4000),
          facts: Array.isArray(parsed?.facts) ? parsed.facts.slice(0, 50) : [],
          aliases: Array.isArray(parsed?.aliases) ? parsed.aliases.map(String).slice(0, 10) : ((existing?.data?.aliases) ?? []),
          sources: list.map((n) => n.key).filter(Boolean),
          rewrittenAt: now,
        },
        now,
      })
      if (typeof memory.index === 'function') void memory.index(created.id, profile)
      written.push(created.id)
    }
    markNotes(notes, now)
    recordRun(day, 'people', { blocks: written.length, people: byQq.size }, now)
    return { job: 'people', ok: true, blocks: written.length, people: byQq.size }
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
        ].join('\n'),
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

  const JOBS = { events: jobEvents, people: jobPeople, slang: jobSlang }

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
