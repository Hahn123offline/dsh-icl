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
import { inferRawSource, FORMATION_SOURCES, RAW_SOURCES } from '../../../core/src/raw-profile.mjs'

export const name = 'dream'

const DEFAULT_JOBS = ['wash', 'events', 'people', 'lexicon', 'consume', 'cleanup', 'index']

function ymdOf(now, timezone = 'Asia/Hong_Kong') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(now))
}
function offsetMinutes(instant, timezone) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' })
    .formatToParts(new Date(instant))
    .find((part) => part.type === 'timeZoneName')?.value ?? 'GMT+00:00'
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name)
  if (!match) return 0
  const sign = match[1] === '-' ? -1 : 1
  return sign * (Number(match[2]) * 60 + Number(match[3]))
}
function dayRange(now, timezone = 'Asia/Hong_Kong') {
  const date = ymdOf(now, timezone)
  const utcMidnight = Date.parse(`${date}T00:00:00Z`)
  const first = utcMidnight - offsetMinutes(utcMidnight, timezone) * 60_000
  const start = utcMidnight - offsetMinutes(first, timezone) * 60_000
  return { start, end: start + 24 * 3600_000 }
}
function dayKey(now, timezone = 'Asia/Hong_Kong') {
  return ymdOf(now, timezone)
}

/**
 * 从模型输出里抠 JSON，并区分三种结果：
 *   { ok:true, value: [...] }  → 合法输出（`[]` 也是合法的"今天没什么可记"）
 *   { ok:false, error:'empty' } → 空输出：这是失败，不是"没内容"
 *   { ok:false, error:'no-json' | 'bad-json' } → 解析失败：失败，当天应可重试
 *
 * 旧 `parseBlocks` 把失败也变成 `[]`，各 job 于是把"模型挂了/输出垃圾"记成
 * "成功但 0 块"，并顺手把 note 全标已消化——当天再也不会重试（审计 F3/S1）。
 */
export function parseJsonStrict(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return { ok: false, error: 'empty' }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const body = fenced ? fenced[1] : text
  const start = body.indexOf('[')
  const startObj = body.indexOf('{')
  const from = start >= 0 && (startObj < 0 || start < startObj) ? start : startObj
  if (from < 0) return { ok: false, error: 'no-json' }
  const end = Math.max(body.lastIndexOf(']'), body.lastIndexOf('}'))
  if (end <= from) return { ok: false, error: 'no-json' }
  try {
    const parsed = JSON.parse(body.slice(from, end + 1))
    return { ok: true, value: Array.isArray(parsed) ? parsed : [parsed] }
  } catch { return { ok: false, error: 'bad-json' } }
}

/** 宽容版：解析失败返回 []（只给"宁可空也不报错"的旧调用方用）。 */
export function parseBlocks(raw) {
  const out = parseJsonStrict(raw)
  return out.ok ? out.value : []
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

/** 把结构化 JSON 从一段文本里去掉，只留自然语言。 */
export function stripStructured(input) {
  let text = String(input ?? "")
  // 整段就是 JSON：整条丢掉
  const trimmed = text.trim()
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try { JSON.parse(trimmed); return "" } catch { /* 不是合法 JSON，继续处理 */ }
  }
  // 去掉围栏里的 JSON
  text = text.replace(/```[a-zA-Z]*\s*([\s\S]*?)```/g, (whole, body) => {
    const b = String(body).trim()
    if (b.startsWith("{") || b.startsWith("[")) {
      try { JSON.parse(b); return " " } catch { return whole }
    }
    return whole
  })
  // 去掉行内嵌的 JSON 片段（成对的 { } / [ ]，且像 JSON）
  const out = []
  let depth = 0
  let started = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === "\\") escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"' && depth > 0) { inString = true; continue }
    if (c === "{" || c === "[") { if (depth === 0) started = i; depth += 1; continue }
    if ((c === "}" || c === "]") && depth > 0) {
      depth -= 1
      if (depth === 0) {
        const seg = text.slice(started, i + 1)
        let looksJson = false
        try { JSON.parse(seg); looksJson = true } catch { looksJson = seg.includes('":') }
        if (looksJson) { out.push(text.slice(0, started)); text = text.slice(i + 1); i = -1; continue }
        started = -1
      }
    }
  }
  if (out.length === 0) return text.replace(/\s+/g, " ").trim()
  return (out.join("") + text).replace(/\s+/g, " ").trim()
}

export function apply(ctx) {
  const memory = ctx.services.require('memory')
  const slot = ctx.manifest.slots?.[0]?.id ?? 'dream-chat'
  const session = String(ctx.config.sessionId ?? 'default')
  const dreamAt = String(ctx.config.dreamAt ?? '23:00')
  if (!/^\d{1,2}:\d{2}$/.test(dreamAt)) throw new Error(`dreamAt 格式应为 HH:mm：${dreamAt}`)

  memory.registerNamespace({ id: 'dream-run', label: '做梦记录', recallable: false, owner: 'dream' })
  try { memory.registerNamespace({ id: 'day', label: '当天原话', recallable: false, owner: 'dream' }) } catch { /* 已注册 */ }
  // typed memory v2 的 add 层（Phase 2，additive）：事实/偏好/承诺先作为普通可召回命名空间存在，
  // 由 events 的同一次模型调用顺带抽出；v2 再升级为带 validity/entity 的正式记录。
  for (const [id, label, halfLifeDays] of [['fact', '事实', 365], ['preference', '偏好', 180], ['commitment', '承诺', 60]]) {
    try { memory.registerNamespace({ id, label, recallable: true, halfLifeDays, owner: 'dream' }) } catch { /* recall 先注册了也行 */ }
  }
  // typed v2 entity 层（Phase 3，additive，2026-11-12 用户决策）：实体行内部引用，不直接进召回输出。
  try { memory.registerNamespace({ id: 'entity', label: '实体', recallable: false, owner: 'dream' }) } catch { /* 已注册 */ }

  const persona = String(ctx.config.persona ?? loadPersona(ctx) ?? '')
  // 身份链的产品已知事实（审计 F5）：自我的 QQ 与主人的 QQ 由配置给出，
  // 显示名/别名只是 alias。人格块再也不能按显示名各建一份、也不能把 selfQQ 挂到别人身上。
  const selfQQ = String(ctx.config.selfQQ ?? '').trim()
  const ownerQQ = String(ctx.config.ownerQQ ?? '').trim()
  const ownerNames = (Array.isArray(ctx.config.ownerNames) ? ctx.config.ownerNames : [])
    .map((x) => String(x ?? '').trim()).filter(Boolean)
  const ownerNameSet = new Set(ownerNames)
  const selfNames = (Array.isArray(ctx.config.selfNames) ? ctx.config.selfNames : [])
    .map((x) => String(x ?? '').trim()).filter(Boolean)
  // 已知群号：模型常把"群号"误当人物 QQ 写进 ids（live 审计：曾嘉睿的 ids 里挂着群号 1057812765）。
  const groupIds = new Set((Array.isArray(ctx.config.groupIds) ? ctx.config.groupIds : [])
    .map((x) => String(x ?? '').trim()).filter(Boolean))
  // cleanup 整理的块范围：typed v2 的事实/偏好/承诺也交给整理轮（否则旧值永远不失效）。
  const CLEANUP_NAMESPACES = ['event', 'person', 'slang', 'fact', 'preference', 'commitment']
  // 形成材料 profile（评测 A/B 用；默认产品口径）：
  //   raw-main（默认）只吃真人/QQ 转述/她可见的回复；raw-human 再砍掉她自己的回复；
  //   raw-all 是"旧无门控基线"，连工具结果/环境通知都喂进去，只用于对照，不用于产品。
  const formationProfile = String(ctx.config.formationProfile ?? 'raw-main')
  const profileSources = formationProfile === 'raw-all'
    ? RAW_SOURCES
    : formationProfile === 'raw-human'
      ? ['human', 'qq_envelope', 'unknown']
      : FORMATION_SOURCES
  // 人物/语料只该从"人说过的"里长出来（她自己的回复是上下文，不是事实来源）。
  const groundTruthSources = formationProfile === 'raw-all' ? RAW_SOURCES : ['human', 'qq_envelope', 'unknown']

  // ── 输入预算（READINESS G-1：繁忙一天的 dream 输入曾到 1MB，整晚白跑） ──
  // 所有发给模型的 payload 都必须 ≤ maxPayloadChars；wash 的 day log 另受 maxDayLogChars 约束。
  // 分片只影响"一次喂多少"，不影响 evidence 编号（编号始终是原话的绝对序号）。
  const maxPayloadChars = Math.max(20_000, Number(ctx.config.maxPayloadChars ?? 200_000))
  const shardChars = Math.min(maxPayloadChars, Math.max(20_000, Number(ctx.config.shardChars ?? 80_000)))
  const shardLines = Math.max(20, Number(ctx.config.shardLines ?? 400))
  const maxLineChars = Math.max(40, Number(ctx.config.maxLineChars ?? 400))
  const maxDayLogChars = Math.max(shardChars, Number(ctx.config.maxDayLogChars ?? maxPayloadChars))
  const maxShards = Math.max(1, Number(ctx.config.maxShards ?? 24))
  // 用户 2026-11-06 批准的记忆分块参数（红队 D1 / E2 质量门）：
  //   day log 分段落盘（每段 ≤40k，保留绝对行号）；event block 正文 ≤1200 字、摘要 ≤100 字，超长拆 parts；
  //   events 先按"经历窗口"（相邻行时间间隔 >30min）切段，再在段内合并。
  const maxSegmentChars = Math.min(maxDayLogChars, Math.max(500, Number(ctx.config.maxSegmentChars ?? 40_000)))
  const segmentGapMin = Math.max(1, Number(ctx.config.segmentGapMin ?? 30))
  const maxBlockBody = Math.max(200, Number(ctx.config.maxBlockBody ?? 1200))
  const maxBlockSummary = Math.max(40, Number(ctx.config.maxBlockSummary ?? 100))

  function clipText(value, max = maxLineChars) {
    const s = String(value ?? '')
    return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s
  }
  /** 最后一道保险：任何 payload 都不得超预算（正常情况下分片/预算早于这里生效）。 */
  function clipPayload(text, where = 'payload') {
    const body = String(text ?? '')
    if (body.length <= maxPayloadChars) return body
    ctx.log({ level: 'warn', msg: 'dream.payload-clip', where, from: body.length, to: maxPayloadChars })
    return `${body.slice(0, maxPayloadChars - 24)}\n…（已截断：原始 ${body.length} 字超预算）`
  }
  /** 把行数组切成 ≤shardChars/shardsLines 的片（超 maxShards 时保留头尾并标记省略）。 */
  function shardLinesOf(lines) {
    const shards = []
    let current = []
    let size = 0
    const push = () => { if (current.length) { shards.push(current); current = []; size = 0 } }
    for (const line of lines) {
      const text = String(line ?? '')
      const cost = text.length + 1
      if (current.length && (size + cost > shardChars || current.length >= shardLines)) push()
      current.push(text)
      size += cost
    }
    push()
    if (shards.length <= maxShards) return { shards, omitted: 0 }
    // 片太多（极端繁忙日）：保留头 80% / 尾 20% 的片，中间明确省略。
    const head = Math.max(1, Math.floor(maxShards * 0.8))
    const tail = Math.max(0, maxShards - head)
    const kept = [...shards.slice(0, head), ...shards.slice(shards.length - tail)]
    return { shards: kept, omitted: shards.length - kept.length }
  }

  async function ask({ instruction, payload, maxTokens = 1200, where = 'dream' }) {
    const out = await ctx.slots.call(slot, {
      messages: [
        { role: 'system', content: [persona, instruction].filter(Boolean).join('\n\n') },
        { role: 'user', content: clipPayload(payload, where) },
      ],
      maxTokens,
    })
    return String(out ?? '').trim()
  }

  /**
   * 带一次重试的"必须拿到合法 JSON"调用。
   * 审计后的实测：模型偶尔输出坏 JSON（synthetic 基线里 people/cleanup 各中过一次），
   * 直接判失败会让当天人物/整理整块缺失；重试一次成本极低，且失败仍会如实落账。
   */
  async function askJson({ instruction, payload, maxTokens = 1200, where = 'dream', attempts = 2 } = {}) {
    let last = { ok: false, error: 'empty' }
    const tries = Math.max(1, Number(attempts) || 2)
    for (let attempt = 0; attempt < tries; attempt += 1) {
      const nudge = attempt === 0
        ? ''
        : '\n\n上一次输出无法解析为 JSON。只输出合法 JSON，不要解释，不要 Markdown 围栏。'
      let raw = ''
      try {
        raw = await ask({ instruction: `${instruction}${nudge}`, payload, maxTokens, where: `${where}#try${attempt + 1}` })
      } catch (error) {
        // 模型调用本身失败（502/超时）也值得重试一次：旧行为直接让整片/整天失败。
        last = { ok: false, error: String(error?.message ?? error) }
        ctx.log({ level: 'warn', msg: 'dream.call-retry', where, attempt: attempt + 1, error: last.error.slice(0, 160) })
        continue
      }
      last = parseJsonStrict(raw)
      if (last.ok) return last
      ctx.log({ level: 'warn', msg: 'dream.parse-retry', where, attempt: attempt + 1, error: last.error })
    }
    return last
  }

  function consolidated(notes) {
    return notes.filter((n) => n.data?.consolidated !== true)
  }

  /**
   * 把 day log 的 `[i] HH:MM 说话人：正文` 拆成按编号索引的行。
   * 证据里同时存 line/at：重洗 log 后行号会位移，但正文快照仍在。
   */
  function dayLogIndex(dayLog) {
    const times = Array.isArray(dayLog?.data?.times) ? dayLog.data.times : []
    const lines = new Map()
    for (const raw of String(dayLog?.text ?? '').split('\n')) {
      const match = /^\[(\d+)\]\s*(?:(\d{1,2}:\d{2})\s*)?(.*)$/.exec(raw)
      if (!match) continue
      const id = Number(match[1])
      const rest = String(match[3] ?? '')
      const cut = rest.indexOf('：')
      lines.set(id, {
        id,
        at: Number(times[id - 1]) || 0,
        text: (cut >= 0 ? rest.slice(cut + 1) : rest).trim(),
      })
    }
    return lines
  }

  function dayEvidence(lines, id) {
    const line = lines.get(Number(id))
    return {
      type: 'day',
      id: Number(id),
      ...(line?.text ? { line: line.text.slice(0, 160) } : {}),
      ...(line?.at ? { at: line.at } : {}),
    }
  }

  /**
   * evidence 去噪（P2，首次 E2 实测）：模型常把重复的"MC 身体：已连接/状态行"当证据，
   * 一块里引用 3 条同样的连接行没有信息量。同类状态行只保留最近 1 条（按 at/顺序取最后）。
   */
  function dedupeEvidence(list) {
    const evidence = Array.isArray(list) ? list : []
    const noiseRe = /已连接|MC 身体：|MC body|body (?:is )?connected/i
    const noise = evidence.filter((entry) => noiseRe.test(String(entry?.line ?? '')))
    if (noise.length <= 1) return evidence
    const keep = noise.reduce((best, entry) => (Number(entry?.at) || 0) >= (Number(best?.at) || 0) ? entry : best, noise[0])
    return evidence.filter((entry) => entry !== keep ? !noise.includes(entry) : true)
  }

  function markNotes(notes, now) {
    for (const note of notes) {
      const data = { ...(note.data ?? {}), consolidated: true, consolidatedAt: now }
      memory.patch(note.id, { data })
    }
  }

  /** 当天 day log 的合法 key：`day:<date>`（单段/旧数据）与 `day:<date>:p2..pN`（分段）。 */
  function isDayLogKey(day, key) {
    const text = String(key ?? '')
    if (text === `day:${day}`) return true
    return text.startsWith(`day:${day}:p`) && /^\d+$/.test(text.slice(`day:${day}:p`.length))
  }

  /**
   * 读回当天完整 day log（可能被 wash 分成了多段）。
   * 返回与旧单条兼容的视图 { text, data:{times,...} }：行号是绝对编号，拼接不改变 evidence 映射。
   */
  function readDayLog(day) {
    let rows = []
    try { rows = memory.query({ namespace: 'day', kind: 'log', limit: 500 }) } catch { rows = [] }
    const parts = rows.filter((row) => isDayLogKey(day, row.key))
    if (!parts.length) return null
    const orderOf = (row) => {
      const m = /:p(\d+)$/.exec(String(row.key ?? ''))
      return m ? Number(m[1]) : 1
    }
    parts.sort((a, b) => orderOf(a) - orderOf(b))
    const text = parts.map((row) => String(row.text ?? '')).filter(Boolean).join('\n')
    const times = Array.isArray(parts[0]?.data?.times) ? parts[0].data.times : []
    // rowIds/sources 是"绝对行号 → raw 行"的两张表（每段都存了完整数组）；评测做
    // evidence→fixture rowId provenance 校验、形成阶段做来源门控都要用。
    const rowIds = Array.isArray(parts[0]?.data?.rowIds) ? parts[0].data.rowIds : []
    const sources = Array.isArray(parts[0]?.data?.sources) ? parts[0].data.sources : []
    const speakers = Array.isArray(parts[0]?.data?.speakers) ? parts[0].data.speakers : []
    const channels = Array.isArray(parts[0]?.data?.channels) ? parts[0].data.channels : []
    return { text, data: { times, rowIds, sources, speakers, channels, parts: parts.length, day, omittedLines: Number(parts[0]?.data?.omittedLines ?? 0), totalLines: Number(parts[0]?.data?.totalLines ?? 0) } }
  }

  /** 行首 `[id]` 是 day log 的绝对行号；没有编号时退回拼接顺序。 */
  function dayLineIdOf(line, index) {
    const match = /^\[(\d+)\]/.exec(String(line ?? ''))
    return match ? Number(match[1]) : index + 1
  }

  /**
   * 形成阶段真正能进模型材料的 day log 行（审计 R2/F6）：
   * 只保留 human / qq_envelope / agent_visible（视角文本），tool/env/agent_internal 全部剔除；
   * 行文本与行号保持原样（evidence 的绝对行号映射不丢）。
   */
  function formationLines(dayLog, allowed = profileSources) {
    const allow = new Set(allowed)
    const lines = String(dayLog?.text ?? '').split('\n')
    const sources = Array.isArray(dayLog?.data?.sources) ? dayLog.data.sources : []
    const out = []
    for (let index = 0; index < lines.length; index += 1) {
      const id = dayLineIdOf(lines[index], index)
      const source = String(sources[id - 1] ?? sources[index] ?? 'unknown')
      if (!allow.has(source)) continue
      out.push(lines[index])
    }
    return out
  }

  /** 形成材料行 → {id, line, source, at, speaker, channel}；id 是 day log 的绝对行号。 */
  function formationEntries(dayLog, allowed = profileSources) {
    const allow = new Set(allowed)
    const lines = String(dayLog?.text ?? '').split('\n')
    const data = dayLog?.data ?? {}
    const sources = Array.isArray(data.sources) ? data.sources : []
    const times = Array.isArray(data.times) ? data.times : []
    const speakers = Array.isArray(data.speakers) ? data.speakers : []
    const channels = Array.isArray(data.channels) ? data.channels : []
    const out = []
    for (let index = 0; index < lines.length; index += 1) {
      const id = dayLineIdOf(lines[index], index)
      const source = String(sources[id - 1] ?? sources[index] ?? 'unknown')
      if (!allow.has(source)) continue
      out.push({
        id,
        line: lines[index],
        source,
        at: Number(times[id - 1]) || 0,
        speaker: speakers[id - 1] ?? null,
        channel: channels[id - 1] ?? null,
      })
    }
    return out
  }

  /* ── 身份解析：账号优先、显示名是 alias（审计 F5） ───────────── */

  /** 显示名 → 产品已知身份（主人/自己）。匹配不到返回 null。 */
  function knownIdentityByName(name) {
    const value = String(name ?? '').trim()
    if (!value) return null
    if (ownerQQ && (ownerNameSet.has(value) || ownerNames.some((alias) => value.startsWith(alias)))) {
      return { kind: 'qq', value: ownerQQ, role: 'owner' }
    }
    return null
  }

  /** 把抽取出来的 subject 规范化：主人/别名归到 ownerQQ；selfQQ 归到自我；其余保留原样。 */
  function canonicalSubject(subject) {
    const kind = String(subject?.kind ?? '').trim()
    const value = String(subject?.value ?? '').trim()
    if (!kind || !value) return null
    if (kind === 'qq') {
      if (selfQQ && value === selfQQ) return { kind: 'qq', value, role: 'self' }
      if (ownerQQ && value === ownerQQ) return { kind: 'qq', value, role: 'owner' }
      return { kind: 'qq', value, role: 'other' }
    }
    if (kind === 'name') {
      const known = knownIdentityByName(value)
      if (known) return known
      // 已有档案的 ids/aliases 也是身份证据：同一个称呼再来时归到已有账号主体，不靠模型猜。
      try {
        const found = memory.findPerson({ name: value })
        const person = found.people?.[0]
        const subject = person?.data?.subject
        if (found.exact && subject?.kind === 'qq' && subject.value && String(subject.value) !== value) {
          if (selfQQ && String(subject.value) === selfQQ) return { kind, value, role: 'other' }
          return canonicalSubject({ kind: 'qq', value: String(subject.value) })
        }
      } catch { /* 读取失败按未知名处理 */ }
    }
    return { kind, value, role: 'other' }
  }

  function personKeyOf(subject) {
    if (!subject?.value) return null
    return subject.kind === 'qq' ? `person:${subject.value}` : `person:${subject.kind}:${subject.value}`
  }

  /**
   * 校验模型给的 ids：不能把 selfQQ 挂到别人档案上；QQ 值必须是 5–12 位数字。
   * 旧实现让 live 出现"Hahn123 的 ids 里挂着她自己的 QQ"（审计 §6.2）。
   */
  function sanitizeIds(ids, subject) {
    const out = []
    for (const entry of Array.isArray(ids) ? ids : []) {
      const kind = String(entry?.kind ?? '').trim()
      const value = String(entry?.value ?? '').trim()
      if (!kind || !value) continue
      if (kind === 'qq') {
        if (!/^\d{5,12}$/.test(value)) continue
        // 群号不是人的 QQ：不能挂到人物档案 ids 上（审计 §6.2 的曾嘉睿案例）。
        if (groupIds.has(value)) continue
        const isSelfSubject = subject?.kind === 'qq' && subject.value === selfQQ
        if (selfQQ && value === selfQQ && !isSelfSubject) continue
      }
      if (!out.some((x) => x.kind === kind && x.value === value)) out.push({ kind, value })
    }
    if (subject) {
      const exists = out.some((x) => x.kind === subject.kind && x.value === subject.value)
      if (!exists) out.unshift({ kind: subject.kind, value: subject.value })
    }
    return out.slice(0, 10)
  }

  /** event.data.people 里常见的是显示名；能解析成账号的写成 QQ，方便 whois/relatedEvents 对齐。 */
  function normalizePeople(list) {
    const out = []
    for (const raw of Array.isArray(list) ? list : []) {
      const value = String(raw ?? '').trim()
      if (!value) continue
      let resolved = value
      if (!/^\d{5,12}$/.test(value)) {
        const known = knownIdentityByName(value)
        if (known) resolved = known.value
        else {
          const found = memory.findPerson({ name: value })
          const person = found.people?.[0]
          const id = person?.data?.ids?.find((x) => x?.kind === 'qq')?.value
          if (id) resolved = String(id)
        }
      }
      if (!out.includes(resolved)) out.push(resolved)
    }
    return out.slice(0, 20)
  }

  /**
   * typed v2 entity 层（Phase 3，additive，2026-11-12 用户拍板）：
   * 把 person 档案聚合成实体行，并给 person / typed / event 记录补引用字段。
   * 纯确定性、幂等：重复跑只补缺失字段，不新增行、不改 entity 文本；删 entity 命名空间即可回滚。
   * @returns {{entities:number, personPatched:number, typedPatched:number, eventPatched:number}}
   */
  function syncEntities(now = ctx.now()) {
    const stats = { entities: 0, personPatched: 0, typedPatched: 0, eventPatched: 0 }
    const personBlocks = memory.query({ namespace: 'person', kind: 'block', limit: 500, order: 'desc' })
      .filter((block) => block.data?.superseded !== true)
    const grouped = new Map()
    for (const block of personBlocks) {
      const data = block.data ?? {}
      const ids = (Array.isArray(data.ids) ? data.ids : [])
        .filter((id) => id && id.kind && id.value)
        .map((id) => ({ kind: String(id.kind), value: String(id.value) }))
      const qq = String(data.qq ?? '').trim()
      if (qq && !ids.some((id) => id.kind === 'qq' && id.value === qq)) ids.unshift({ kind: 'qq', value: qq })
      const canonical = ids.find((id) => id.kind === 'qq') ?? ids[0] ?? null
      if (!canonical) continue
      const entityKey = `entity:${canonical.kind}:${canonical.value}`
      const entry = grouped.get(entityKey) ?? {
        ids: new Map(), aliases: new Set(), personKeys: new Set(),
        evidenceCount: 0, familiarity: 'unknown', firstSeen: null, lastSeen: null, provisional: false,
      }
      for (const id of ids) entry.ids.set(`${id.kind}:${id.value}`, id)
      for (const alias of (Array.isArray(data.aliases) ? data.aliases : [])) {
        const text = String(alias ?? '').trim()
        if (text) entry.aliases.add(text)
      }
      if (block.key) entry.personKeys.add(String(block.key))
      grouped.set(entityKey, entry)
      entry.evidenceCount += Array.isArray(data.evidence) ? data.evidence.length : 1
      if (String(data.familiarity ?? '') === 'close') entry.familiarity = 'close'
      if (data.provisional === true) entry.provisional = true
      const createdAt = Number(block.createdAt ?? 0) || null
      if (createdAt && (entry.firstSeen == null || createdAt < entry.firstSeen)) entry.firstSeen = createdAt
      if (createdAt && (entry.lastSeen == null || createdAt > entry.lastSeen)) entry.lastSeen = createdAt
    }
    for (const [entityKey, entry] of grouped) {
      const canonical = [...entry.ids.values()].find((id) => id.kind === 'qq') ?? [...entry.ids.values()][0]
      const display = ([...entry.aliases].find((alias) => !/^\d+$/.test(alias)) ?? String(canonical.value)).slice(0, 80)
      const nextData = {
        canonicalId: canonical,
        ids: [...entry.ids.values()].slice(0, 10),
        aliases: [...entry.aliases].slice(0, 20),
        personKeys: [...entry.personKeys].slice(0, 20),
        familiarity: entry.familiarity,
        evidenceCount: entry.evidenceCount,
        firstSeen: entry.firstSeen,
        lastSeen: entry.lastSeen,
        provisional: entry.provisional,
        updatedAt: Number(now),
      }
      const existing = memory.query({ namespace: 'entity', kind: 'entity', key: entityKey, limit: 1 })[0]
      const before = existing?.data ?? null
      const same = before != null
        && JSON.stringify(before.ids ?? []) === JSON.stringify(nextData.ids)
        && JSON.stringify(before.aliases ?? []) === JSON.stringify(nextData.aliases)
        && JSON.stringify(before.personKeys ?? []) === JSON.stringify(nextData.personKeys)
        && String(before.familiarity ?? '') === nextData.familiarity
        && Number(before.evidenceCount ?? 0) === nextData.evidenceCount
        && existing?.text === display
      if (!same) memory.put({ namespace: 'entity', kind: 'entity', key: entityKey, text: display, data: nextData, now })
      stats.entities += 1
      // 给 person 块补 entityId（只补缺失，不改已有值）。
      for (const personKey of entry.personKeys) {
        const block = memory.query({ namespace: 'person', kind: 'block', key: personKey, limit: 1 })[0]
        if (!block || block.data?.entityId) continue
        memory.put({ namespace: 'person', kind: 'block', key: personKey, text: block.text, data: { ...(block.data ?? {}), entityId: entityKey }, now })
        stats.personPatched += 1
      }
    }
    // typed 记录补 subjectEntity（subject 是旧兼容字段，可能是 QQ 字符串）。
    for (const namespace of ['fact', 'preference', 'commitment']) {
      for (const row of memory.query({ namespace, kind: 'block', limit: 1000, order: 'desc' })) {
        if (row.data?.superseded === true) continue
        if (row.data?.subjectEntity) continue
        const subject = String(row.data?.subject ?? '').trim()
        if (!subject) continue
        const entityKey = /^\d{5,12}$/.test(subject) ? `entity:qq:${subject}` : `entity:person:${subject}`
        memory.put({ namespace, kind: 'block', key: row.key, text: row.text, data: { ...(row.data ?? {}), subjectEntity: entityKey }, now })
        stats.typedPatched += 1
      }
    }
    // event 块补 entities（来自已有的 people，多值）。
    for (const row of memory.query({ namespace: 'event', kind: 'block', limit: 1000, order: 'desc' })) {
      if (row.data?.superseded === true || Array.isArray(row.data?.entities)) continue
      const people = normalizePeople(row.data?.people)
      if (!people.length) continue
      const entities = people.map((value) => (/^\d{5,12}$/.test(value) ? `entity:qq:${value}` : `entity:person:${value}`))
      memory.put({ namespace: 'event', kind: 'block', key: row.key, text: row.text, data: { ...(row.data ?? {}), entities: [...new Set(entities)].slice(0, 10) }, now })
      stats.eventPatched += 1
    }
    // 悬空引用补 stub 实体（例如 event.people 里只有显示名、没有 person 档案）：让图闭合；
    // stub 标 provisional/stub，后续人物档案建起来时会被正式实体覆盖合并。
    const knownEntityKeys = new Set(memory.query({ namespace: 'entity', kind: 'entity', limit: 2000 }).map((row) => row.key))
    const referencedKeys = new Set()
    for (const block of memory.query({ namespace: 'person', kind: 'block', limit: 1000 })) {
      if (block.data?.entityId) referencedKeys.add(String(block.data.entityId))
    }
    for (const namespace of ['fact', 'preference', 'commitment']) {
      for (const row of memory.query({ namespace, kind: 'block', limit: 1000 })) {
        if (row.data?.subjectEntity) referencedKeys.add(String(row.data.subjectEntity))
      }
    }
    for (const row of memory.query({ namespace: 'event', kind: 'block', limit: 1000 })) {
      for (const key of Array.isArray(row.data?.entities) ? row.data.entities : []) referencedKeys.add(String(key))
    }
    for (const key of referencedKeys) {
      if (!key || knownEntityKeys.has(key)) continue
      const match = /^entity:(qq|person):(.+)$/.exec(key)
      if (!match) continue
      const kind = match[1]
      const value = match[2]
      memory.put({
        namespace: 'entity', kind: 'entity', key, text: (kind === 'qq' ? value : value).slice(0, 80),
        data: {
          canonicalId: { kind, value }, ids: [{ kind, value }], aliases: kind === 'person' ? [value] : [],
          personKeys: [], familiarity: 'unknown', evidenceCount: 0,
          firstSeen: null, lastSeen: null, provisional: true, stub: true, updatedAt: Number(now),
        },
        now,
      })
      stats.stubs = (stats.stubs ?? 0) + 1
      knownEntityKeys.add(key)
    }
    return stats
  }

  /** 把渲染好的 day log 行按字符预算切成多段（每段 ≤ maxSegmentChars，行边界切）。 */
  function splitLinesByBudget(lines, budget) {
    const parts = []
    let current = []
    let size = 0
    for (const line of lines) {
      const cost = String(line).length + 1
      if (current.length && size + cost > budget) { parts.push(current); current = []; size = 0 }
      current.push(line)
      size += cost
    }
    if (current.length) parts.push(current)
    return parts.length ? parts : [[]]
  }

  /** 解析 material 行里的 HH:MM；解析不到返回 null（归到当前经历段）。 */
  function lineMinuteOf(line) {
    const match = /^\s*\[(\d+)\]\s*(?:(\d{1,2}):(\d{2}))?/.exec(String(line ?? ''))
    if (!match || match[2] == null) return null
    return Number(match[2]) * 60 + Number(match[3])
  }

  /** 按"经历窗口"分组：相邻行时间间隔 > gapMin 分钟就切一段（同一天内；跨午夜按同日处理）。 */
  function groupByExperience(lines, gapMin = 30) {
    const gapMs = Math.max(1, Number(gapMin) || 30) * 60_000
    const groups = []
    let current = []
    let prevMin = null
    for (const line of lines) {
      const minute = lineMinuteOf(line)
      if (minute != null && prevMin != null && current.length) {
        let gap = minute - prevMin
        if (gap < 0) gap += 24 * 60
        if (gap * 60_000 > gapMs) { groups.push(current); current = [] }
      }
      current.push(line)
      if (minute != null) prevMin = minute
    }
    if (current.length) groups.push(current)
    return groups.length ? groups : [lines]
  }

  /** 先按经历段切，再按单请求大小分片；总量超 maxShards 时保留头 80%/尾 20% 并记省略。 */
  function shardByExperience(material, { gapMin = 30 } = {}) {
    const segments = groupByExperience(material, gapMin)
    const shards = []
    let omitted = 0
    for (const segment of segments) {
      const out = shardLinesOf(segment)
      shards.push(...out.shards)
      omitted += Number(out.omitted) || 0
    }
    if (shards.length <= maxShards) return { shards, omitted, segments: segments.length }
    const head = Math.max(1, Math.floor(maxShards * 0.8))
    const tail = Math.max(0, maxShards - head)
    const kept = [...shards.slice(0, head), ...shards.slice(shards.length - tail)]
    return { shards: kept, omitted: omitted + (shards.length - kept.length), segments: segments.length }
  }

  /** 把长正文按句子边界切成 ≤ max 字的块（没有句读就硬切），用于 block parts。 */
  function splitBodyChunks(body, max) {
    const text = String(body ?? '').trim()
    if (!text) return ['']
    if (text.length <= max) return [text]
    const chunks = []
    let current = ''
    for (const piece of text.split(/(?<=[。！？!?\n])/)) {
      if (!piece) continue
      if (current.length + piece.length <= max) { current += piece; continue }
      if (current) { chunks.push(current); current = '' }
      let rest = piece
      while (rest.length > max) { chunks.push(rest.slice(0, max)); rest = rest.slice(max) }
      current = rest
    }
    if (current) chunks.push(current)
    return chunks.length ? chunks : [text.slice(0, max)]
  }

  /* ── 执行账本：单飞 + 租约 + attempt ─────────────────────────────
   * 旧实现只用"成功 key 是否存在"表示幂等。并发双触发时，第二次在第一次写完账本前
   * 进来，看不到成功行，于是同一 job 真的跑两遍（live 11-09：events/cleanup 15s 内
   * 各跑两次，产出 11 对近似重复块）。而 `recordRun` 的 upsert 又把两次执行压成一行，
   * 审计据此得出"只跑了一次"。
   *
   * 现在：job 开始先 claim（写 running 租约），结束写终态 success/failed/skipped；
   * running 超过 staleRunMs 视为上次进程崩溃、允许重新领取；attempts 保留每次执行。
   */
  const staleRunMs = Math.max(60_000, Number(ctx.config.staleRunMs ?? 30 * 60_000))
  const dayCutHour = Math.max(0, Math.min(12, Number(ctx.config.dayCutHour ?? 4)))
  let inFlight = null

  /**
   * dream 的"整理对象是哪一天"不能等于"运行时刻"（审计 F7）：
   * 凌晨 02:09 触发时 `dayKey(now)` 已经是"新的一天"，前一晚的原话永远不沉淀
   * （live 11-07 有 130 行 raw 却没有 day log）。规则：本地时间 < dayCutHour（默认 4 点）
   * 视为在整理"刚结束的那天"，回拨 24 小时；23:00 的睡眠/排程仍整理当天。
   */
  function targetDayInstant(now) {
    const instant = Number(now)
    if (!Number.isFinite(instant)) return Date.now()
    const localHour = new Date(instant + offsetMinutes(new Date(instant), tzOf()) * 60_000).getUTCHours()
    return localHour < dayCutHour ? instant - 24 * 3600_000 : instant
  }

  function runKey(day, job) { return `run:${day}:${job}` }
  function readRun(day, job) {
    return memory.query({ namespace: 'dream-run', kind: 'run', key: runKey(day, job), limit: 1 })[0] ?? null
  }
  function runStatusOf(row) {
    // 旧账本没有 status：一律视为成功（兼容已有库）；没有行 = 从未跑过。
    if (!row) return 'none'
    return String(row?.data?.status ?? 'success')
  }
  function alreadyRan(day, job) {
    const row = readRun(day, job)
    return Boolean(row) && runStatusOf(row) === 'success'
  }
  /** 成功 job 自己写细节时保留 claim 的 startedAt/attempts，并补 status:success。 */
  function recordRun(day, job, detail, now) {
    const row = readRun(day, job)
    const prev = row?.data ?? {}
    memory.put({
      namespace: 'dream-run', kind: 'run', key: runKey(day, job),
      text: row?.text ?? `${day} ${job}`,
      data: { ...prev, ...detail, job, day, status: 'success', ...(prev.startedAt ? { startedAt: Number(prev.startedAt) } : {}), finishedAt: Number(now) },
      now,
    })
  }
  /** job 开始前领租约；返回 {skip} 或 {attempt, attemptId}。 */
  function beginRun(day, job, now, force) {
    const row = readRun(day, job)
    const status = runStatusOf(row)
    if (!force && status === 'success') return { skip: 'already-ran' }
    if (!force && status === 'running') {
      const startedAt = Number(row?.data?.startedAt ?? row?.updatedAt ?? 0)
      const age = Number(now) - startedAt
      if (Number.isFinite(age) && age >= 0 && age < staleRunMs) return { skip: 'in-flight' }
      // 过期 running：视为崩溃遗留，允许重新领取。
    }
    const attemptId = `${Number(now).toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const attempts = Array.isArray(row?.data?.attempts) ? row.data.attempts.slice(-9) : []
    attempts.push({ id: attemptId, status: 'running', startedAt: Number(now) })
    memory.put({
      namespace: 'dream-run', kind: 'run', key: runKey(day, job),
      text: `${day} ${job}${force ? ' (force)' : ''}`,
      data: {
        job, day, status: 'running', attemptId, attempt: attempts.length, startedAt: Number(now),
        attempts, ...(force ? { force: true } : {}),
      },
      now,
    })
    return { attempt: attempts.length, attemptId }
  }
  /** job 结束后落终态；attempts 里同一条记录一并更新。 */
  function settleRun(day, job, result, now, claim) {
    const row = readRun(day, job)
    if (!row) return
    const prev = row.data ?? {}
    const attempts = Array.isArray(prev.attempts) ? prev.attempts.slice() : []
    const index = attempts.length - 1
    const status = result?.ok === false ? 'failed' : result?.skipped ? 'skipped' : 'success'
    const entry = {
      id: claim?.attemptId ?? prev.attemptId, status, finishedAt: Number(now),
      ...(result?.skipped ? { skipped: String(result.skipped) } : {}),
      ...(result?.error ? { error: String(result.error).slice(0, 300) } : {}),
    }
    if (index >= 0) attempts[index] = { ...attempts[index], ...entry }
    memory.put({
      namespace: 'dream-run', kind: 'run', key: runKey(day, job), text: row.text,
      data: {
        ...prev, status, attempts, finishedAt: Number(now),
        ...(result?.skipped ? { skipped: String(result.skipped) } : {}),
        ...(result?.error ? { error: String(result.error).slice(0, 300) } : {}),
      },
      now,
    })
  }
  /**
   * 可观测修复（E2 质量门）：失败/跳过也落 dream-run，让"没跑"和"跑失败"可区分。
   * 仍用 kind:'run'（mc-quality 的现状解析器按 `:(\w+)$` 取 job、按 data.error 计 failures），
   * 但 key 用 `fail:`/`skip:` 前缀，不占用 alreadyRan 的成功 key（不会阻止第二天重跑）。
   * 判定口径（写进 docs/MEMORY-BLOCK-QUALITY.md §4）：
   *   run:<day>:<job>  → 成功（既有；data.status=success）
   *   fail:<day>:<job> → 失败，data:{ok:false,error,job}
   *   skip:<day>:<job> → 跳过，data:{ok:true,skipped,job,missing?}
   */
  function recordOutcome(day, result, now) {
    const job = String(result?.job ?? 'run')
    if (result?.ok === false) {
      memory.put({
        namespace: 'dream-run', kind: 'run', key: `fail:${day}:${job}`, text: `${day} ${job} fail`,
        data: { ok: false, job, error: String(result.error ?? 'unknown'), ...(result.degraded ? { degraded: true } : {}), ...(result.failedShards ? { failedShards: result.failedShards } : {}) },
        now,
      })
      return
    }
    if (result?.skipped) {
      memory.put({
        namespace: 'dream-run', kind: 'run', key: `skip:${day}:${job}`, text: `${day} ${job} skip`,
        data: { ok: true, job, skipped: String(result.skipped), ...(result.rawSources ? { rawSources: result.rawSources } : {}), ...(Number(result.missing) ? { missing: Number(result.missing) } : {}) },
        now,
      })
      return
    }
    // 兜底（mc-lab E2 发现）：ok:true 但既没 skipped、也没自己 recordRun 的 job 会三态全缺。
    // 用"成功 key 是否已存在"判断，不依赖各 job 是否自觉记录；补一行 run:（empty:true），不改语义。
    if (result?.ok !== false) {
      const existing = memory.query({ namespace: 'dream-run', kind: 'run', key: runKey(day, job), limit: 1 })
      if (!existing.length) {
        memory.put({
          namespace: 'dream-run', kind: 'run', key: runKey(day, job), text: `${day} ${job}`,
          data: { ok: true, job, empty: true },
          now,
        })
      }
    }
  }

  /** 只保留最近 90 天的做梦账本；否则每天 5–7 行会无界增长。 */
  function pruneRuns(now, keepDays = 90) {
    const cutoff = Number(now) - Math.max(1, keepDays) * 86_400_000
    const old = memory.query({ namespace: 'dream-run', kind: 'run', limit: 500, order: 'asc' })
      .filter((row) => Number(row.createdAt) < cutoff)
    for (const row of old) memory.remove({ namespace: 'dream-run', id: row.id })
    return old.length
  }

  /* ── events：按话题切块 ───────────────────────────────────────── */

  /* ── wash：从当天原话里先洗出笔记 ───────── */

  /**
   * 作梦不能只靠主会话自己记：每天先把原话过一遍，
   * 把值得记的事与人洗成 note，后面的 events/people 才有原料。
   * remember 仍然是"主观想记住"的强参考，但不是唯一入口。
   */
  async function jobWash({ now, force = false }) {
    const day = dayKey(now, tzOf())
    if (!force && alreadyRan(day, 'wash')) return { job: 'wash', skipped: 'already-ran' }
    // 没有原料时要能分清"今天真没说话"和"原文层没接上"：把来源清单一起带回去。
    let rawSources = []
    try { rawSources = ctx.services.raw?.ids?.() ?? [] } catch { rawSources = [] }
    let rows = []
    try {
      rows = await ctx.services.raw?.list?.({ since: dayStartOf(now), until: dayEndOf(now), limit: 2000 }) ?? []
    } catch (error) {
      return { job: 'wash', skipped: 'no-raw', rawSources, error: String(error?.message ?? error) }
    }
    if (!rows.length) return { job: 'wash', skipped: 'no-raw', rawSources }

    const startMs = dayStartOf(now)
    const endMs = dayEndOf(now)
    const timeOfRow = (r) => Number(r.time ?? r.createdAt ?? 0)
    const hhmm = (at) => new Date(at).toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5)
    /**
     * raw 行来源分类：与评测工具共用 `core/src/raw-profile.mjs` 的实现（只有一份口径）。
     * 注意 raw 注册服务会把来源 id 放进 sourceId，不再覆盖行自带的 source/sourceKind。
     */
    const inferSource = inferRawSource
    const cleaned = []
    for (const r of rows) {
      const at = timeOfRow(r)
      if (at && (at < startMs || at >= endMs)) continue
      const source = inferSource(r)
      const speaker = r.speaker && typeof r.speaker === 'object'
        ? { kind: String(r.speaker.kind ?? 'qq'), value: r.speaker.value == null ? '' : String(r.speaker.value), ...(r.speaker.name ? { name: String(r.speaker.name) } : {}) }
        : null
      let text = stripStructured(r.text)
      // 有结构化 speaker 时剥掉 QQ 文本信封前缀：行首已经有"名字(QQ)"，正文里再带一遍是噪声。
      if (source === 'qq_envelope' && speaker && (speaker.value || speaker.name)) {
        text = text.replace(/^\[QQ[^\]]*\]\s*[^：:\n]{0,32}[：:]\s*/, '')
      }
      if (!text) continue
      cleaned.push({
        at,
        sender: String(r.sender ?? '').slice(0, 24),
        source,
        // 每个 raw 行一个稳定 id：评测要拿 evidence → fixture rowId 做 provenance 校验。
        rowId: r.id ?? r.rowId ?? (r.sessionId != null && r.seq != null ? `${r.sessionId}:${r.seq}` : null),
        // bridge 采集到的会话/说话人元数据（QQ 通知带 envelope 时）：形成阶段用来把话挂到身份上。
        channel: r.channel == null ? null : String(r.channel),
        speaker,
        text,
      })
    }
    if (!cleaned.length) return { job: 'wash', skipped: 'nothing-clean' }

    // day log 是后续 events/people/lexicon 的原材料：单行截断 + 总量预算，
    // 超预算时保留头尾、中间显式省略；**编号仍是原话的绝对序号**（evidence 映射不丢）。
    // 有 speaker 元数据时把"名字(QQ)"写进行首，形成阶段才能把人话挂到身份上。
    const speakerLabelOf = (x) => {
      const speaker = x.speaker
      const value = String(speaker?.value ?? '').trim()
      const name = String(speaker?.name ?? '').trim()
      // 她自己：别把她的话标成 QQ 号，模型会把它当成第三个人。
      if (value && selfQQ && value === selfQQ) return '我'
      if (value && ownerQQ && value === ownerQQ) return `主人(${value})`
      if (name || value) return `${name || 'QQ'}${value && value !== name ? `(${value})` : ''}`
      return x.sender === 'assistant' ? '我' : x.sender
    }
    const renderLine = (x, i) => `[${i + 1}] ${hhmm(x.at || now)}${speakerLabelOf(x) ? ` ${speakerLabelOf(x)}` : ''}：${clipText(x.text)}`
    let lines = cleaned.map(renderLine)
    let total = lines.reduce((n, line) => n + line.length + 1, 0)
    let omittedLines = 0
    if (total > maxDayLogChars) {
      const kept = []
      const head = []
      const tail = []
      let budget = maxDayLogChars
      // 头部 40% 预算、尾部 60% 预算（晚上的事更重要，但不能丢早上）
      const headBudget = Math.floor(budget * 0.4)
      const tailBudget = budget - headBudget
      let used = 0
      for (const line of lines) { if (used + line.length + 1 > headBudget) break; head.push(line); used += line.length + 1 }
      used = 0
      const tailLines = []
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i]
        if (used + line.length + 1 > tailBudget) break
        tailLines.unshift(line); used += line.length + 1
      }
      omittedLines = lines.length - head.length - tailLines.length
      kept.push(...head)
      if (omittedLines > 0) kept.push(`[--] …（中间省略 ${omittedLines} 行原话：输入预算 ${maxDayLogChars} 字）`)
      kept.push(...tailLines)
      lines = kept
      total = lines.reduce((n, line) => n + line.length + 1, 0)
    }
    // 用户批准（2026-11-06）：day log 分段落盘，每段 ≤ maxSegmentChars（默认 40k），行号仍是绝对编号；
    // events/lexicon 通过 readDayLog(day) 按段拼接读取。先清掉当天旧分段，force 重跑不留过期部分。
    try {
      const stale = memory.query({ namespace: 'day', kind: 'log', limit: 500 }).filter((row) => isDayLogKey(day, row.key))
      for (const row of stale) memory.remove({ namespace: 'day', id: row.id })
    } catch { /* 清理失败不影响主流程 */ }
    const segments = splitLinesByBudget(lines, maxSegmentChars)
    segments.forEach((partLines, index) => {
      const partText = partLines.join('\n')
      memory.put({
        namespace: 'day',
        kind: 'log',
        key: index === 0 ? `day:${day}` : `day:${day}:p${index + 1}`,
        text: partText,
        data: {
          day, part: index + 1, parts: segments.length, lines: partLines.length,
          totalLines: cleaned.length, omittedLines, chars: partText.length,
          // times/rowIds/sources/speakers/channels 用完整数组（绝对行号 id-1 索引），每段都存一份，
          // 拼接后 evidence / speaker 映射不变。
          times: cleaned.map((x) => x.at),
          rowIds: cleaned.map((x) => x.rowId ?? null),
          sources: cleaned.map((x) => x.source),
          speakers: cleaned.map((x) => x.speaker ?? null),
          channels: cleaned.map((x) => x.channel ?? null),
        },
        now,
      })
    })
    recordRun(day, 'wash', { lines: lines.length, totalLines: cleaned.length, omittedLines, chars: total, parts: segments.length, segmented: segments.length > 1 }, now)
    return {
      job: 'wash', ok: true, lines: lines.length, totalLines: cleaned.length,
      // 用户批准（2026-11-06，首次 E2 实测后）：分段是正常设计，不算"降级"；只有真截断（omittedLines>0）才是 degraded。
      omittedLines, chars: total, parts: segments.length, segmented: segments.length,
      degraded: omittedLines > 0,
    }
  }

  async function jobEvents({ now, force = false }) {
    const { start, end } = dayRange(now, tzOf())
    const day = dayKey(now, tzOf())
    if (!force && alreadyRan(day, 'events')) return { job: 'events', skipped: 'already-ran' }
    // 事件笔记也要跨天：太短没写成块的片段，明天要跟新材料一起重试。
    const notes = consolidated(memory.query({ namespace: 'event', kind: 'note', limit: 500, order: 'desc' }))
    // day log 可能被 wash 分成了多段：按段拼接读取（行号是绝对编号，evidence 映射不变）。
    const dayLog = readDayLog(day)
    if (!notes.length && !dayLog) return { job: 'events', skipped: 'no-notes' }

    // 每行带稳定 id：摘要必须能指回原句。
    const timeOf = (n) => Number(n.data?.at ?? n.createdAt ?? 0)
    const hhmm = (at) => new Date(at).toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5)
    // 材料行：dayLog（wash 已按预算截断/分段）优先，否则 notes。先按经历窗口切段，再按请求大小分片。
    // 形成阶段只吃真人/可见视角的行：工具结果与环境通知在 wash 已有 source 标记，这里被剔除（审计 F6）。
    const material = dayLog
      ? formationLines(dayLog)
      : notes
        .slice()
        .sort((a, b) => timeOf(a) - timeOf(b))
        .map((n) => `[${n.id}] ${hhmm(timeOf(n))} ${clipText(n.text)}`)
    // 旧值失效上下文：把近期 typed 陈述给模型看，明确取代时用 invalidates 抄旧原文。
    // 注意：只在"明确取代"时写；没有就不写——避免模型把只是相关的新旧当成无效化。
    const knownTyped = ['fact', 'preference', 'commitment']
      .flatMap((ns) => memory.query({ namespace: ns, kind: 'block', limit: 40, order: 'desc' }))
      .filter((row) => row.data?.superseded !== true)
      .slice(0, 24)
    const typedHint = knownTyped.length
      ? `【已有的事实/偏好/承诺】（如果这次的新陈述明确取代其中一条，就在该条目对象里加 "invalidates": ["旧陈述原文片段"]；没有明确取代就别写）\n${knownTyped.map((row) => `- [${row.namespace}] ${row.text}`).join('\n')}\n\n【今天的对话】\n`
      : ''
    const hint = dayLog ? '\n\n（上面每行开头的编号就是 evidence 要用的编号）' : ''
    const { shards, omitted: omittedShards, segments: experienceSegments } = shardByExperience(material, { gapMin: segmentGapMin })
    // 显式 remember 的 event note 不能因为"当天有 day log"就被排除在材料外（审计 F2）：
    // 作为额外一片喂进去，证据写成 n<id>（与 day 行号是两套编号空间）。
    if (dayLog && notes.length) {
      shards.push(notes.slice(0, 40).map((note) => `n${note.id}｜${clipText(note.text, 240)}`))
    }
    if (omittedShards) ctx.log({ level: 'warn', msg: 'dream.events-shards-capped', omittedShards, kept: shards.length })
    const instruction = [
      '把今天的笔记整理成若干"事件块"，不要写成日记或总结报告。',
      '块里可以是你做过的事，也可以是你今天看到/刷到/学到的东西（写成“我刷到一个讲…”）。',
      '只记真实发生过的对话与经历：你自己未发出去的计划、工具操作细节、系统状态都不算经历，不要写进块。',
      '时间优先：先按"一段经历"分组——时间挨得很近、连续发生的笔记算同一次经历；',
      '再在这一次经历内部按话题合并。同一次连续经历里的碎片要放进同一块，不要拆开。',
      '不同时间段的事不要硬并成一块；确实只是同一件事的，才跨时间合并并写成一块。',
      '每块输出一个对象：{"summary": "一行脱敏摘要（不含 QQ 号）", "body": "第一人称正文", "people": ["QQ号"], "tags": ["短标签"], "evidence": [id],',
      '  "facts": ["这次对话里出现的稳定事实（关于谁/关系/世界的陈述）"], "preferences": ["偏好、习惯、口味、雷点"], "commitments": ["答应过/还没了结的事（谁答应谁的、还没做的）"]}',
      'facts/preferences/commitments 都是可选的：只有块里明确出现才写，每条一句话、能被同一批 evidence 支持，没有就省略这三个字段。',
      '元素可以是字符串，也可以是 {"text":"…","invalidates":["旧陈述原文片段"]}；只有这次的新陈述明确取代了「已有的事实/偏好/承诺」里某一条时才写 invalidates（抄旧原文，不要改写），否则不要写。',
      '如果新材料表明已有列表里的偏好/承诺已经变了（口味变了、计划改了、旧承诺作废），必须写 invalidates：漏掉会让旧值一直活着，比漏记一条新事实更糟。',
      'evidence 必须是上面真实存在的编号；不能编。没有出处的话不要写进块。',
      '如果材料里出现 n<数字> 开头的行，那是她主动记下的笔记，证据要写成对应的 n<数字>（例如 n12）；它们优先归入最相关的一块。',
      '只输出 JSON 数组，不要解释。没有值得记的就输出 []。',
    ].join('\n')
    const blocks = []
    const shardResults = []
    /**
     * 跑一片；坏 JSON 时把该片对半拆开再各试一次（繁忙日单片输出可能超 token 被截断，
     * 拆半是失败路径的兜底，不增加正常日的成本）。
     */
    async function runEventShard(lines, label, depth = 0) {
      const payload = `${typedHint}${lines.join('\n')}${hint}`
      const out = await askJson({ instruction, payload, where: `events#${label}`, maxTokens: 3500 })
      if (!out.ok) {
        if (depth < 1 && lines.length >= 8) {
          const middle = Math.floor(lines.length / 2)
          const partial = []
          for (const [partLabel, part] of [[`${label}a`, lines.slice(0, middle)], [`${label}b`, lines.slice(middle)]]) {
            try { partial.push(await runEventShard(part, partLabel, depth + 1)) } catch { /* 半边失败也保留另一半 */ }
          }
          if (partial.length) {
            ctx.log({ level: 'warn', msg: 'dream.shard-split', job: 'events', shard: label, half: partial.length })
            return { ok: true, blocks: partial.flatMap((entry) => entry.blocks), chars: payload.length, split: true, partial: partial.length < 2 }
          }
        }
        throw new Error(`模型输出不可解析：${out.error}`)
      }
      return { ok: true, blocks: out.value, chars: payload.length }
    }
    for (let i = 0; i < shards.length; i += 1) {
      try {
        const result = await runEventShard(shards[i], String(i + 1))
        blocks.push(...result.blocks)
        shardResults.push({ index: i + 1, ok: true, blocks: result.blocks.length, chars: result.chars, ...(result.split ? { split: true } : {}) })
      } catch (error) {
        // 某片失败不拖垮整夜：记录、继续下一片，已成功片的块照常落库。
        const reason = String(error?.message ?? error)
        shardResults.push({ index: i + 1, ok: false, error: reason })
        ctx.log({ level: 'warn', msg: 'dream.shard-fail', job: 'events', shard: i + 1, shards: shards.length, error: reason })
      }
    }
    if (!shardResults.some((row) => row.ok)) {
      return {
        job: 'events', ok: false, blocks: 0, shards: shards.length,
        failedShards: shardResults.length,
        degraded: true,
        error: shardResults.map((row) => row.error).filter(Boolean).slice(0, 3).join('；'),
      }
    }
    const written = []
    let typedWritten = 0
    let typedMerged = 0
    let typedInvalidated = 0
    const newTypedStatements = []
    const dayLines = dayLog ? dayLogIndex(dayLog) : null
    for (const block of blocks) {
      const summaryRaw = String(block?.summary ?? '').trim()
      if (!summaryRaw) continue
      const summary = summaryRaw.slice(0, maxBlockSummary)
      const baseKey = `evt:${day}:${hash(summary)}`
      // 证据：原话行号是数字；她主动记下的笔记用 n<id>（与行号不同空间，避免撞号）。
      const evidence = []
      for (const rawId of (Array.isArray(block?.evidence) ? block.evidence : [])) {
        const token = String(rawId ?? '').trim()
        const noteHit = /^n(\d+)$/i.exec(token)
        if (noteHit) {
          const note = notes.find((n) => Number(n.id) === Number(noteHit[1]))
          if (note) evidence.push({ type: 'note', id: Number(note.id), line: clipText(note.text, 160), at: Number(note.data?.at ?? note.createdAt ?? now) })
          continue
        }
        const id = Number(token)
        if (dayLines && dayLines.has(id)) evidence.push(dayEvidence(dayLines, id))
        else if (!dayLines && Number.isFinite(id)) evidence.push(...validEvidence([id], notes))
      }
      const previous = memory.query({ namespace: 'event', kind: 'block', key: baseKey, limit: 1 })[0]
      // 重跑时模型偶尔给不出出处：宁可保留旧块，也不要把已有证据覆盖成空
      if (!evidence.length && previous) continue
      // 同一 summary 重跑：新证据优先，但旧证据不丢（旧行号/正文快照仍可追）。
      const mergedEvidence = dedupeEvidence([...evidence])
      for (const old of previous?.data?.evidence ?? []) {
        if (!mergedEvidence.some((e) => e.type === old.type && Number(e.id) === Number(old.id))) mergedEvidence.push(old)
      }
      const evidenceFinal = dedupeEvidence(mergedEvidence)
      const times = (() => {
        if (dayLines) {
          return evidenceFinal
            .map((e) => Number(e.at) || Number(dayLines.get(Number(e.id))?.at) || 0)
            .filter(Boolean)
        }
        return evidenceFinal
          .map((e) => notes.find((n) => Number(n.id) === Number(e.id)))
          .filter(Boolean)
          .map((n) => Number(n.data?.at ?? n.createdAt ?? 0))
          .filter(Boolean)
      })()
      const span = times.length ? { from: Math.min(...times), to: Math.max(...times) } : {}
      // 用户批准（2026-11-06）：body ≤1200 字；超长按句子拆成 parts（同一 groupId，检索可合并）。
      const bodyChunks = splitBodyChunks(String(block?.body ?? ''), maxBlockBody)
      const total = bodyChunks.length
      const groupId = hash(summary)
      for (let index = 0; index < bodyChunks.length; index += 1) {
        const part = index + 1
        const key = index === 0 ? baseKey : `${baseKey}:p${part}`
        const previousPart = index === 0 ? previous : memory.query({ namespace: 'event', kind: 'block', key, limit: 1 })[0]
        const partEvidence = index === 0 ? evidenceFinal : dedupeEvidence(previousPart?.data?.evidence ?? evidenceFinal)
        const created = memory.put({
          namespace: 'event',
          kind: 'block',
          key,
          text: index === 0 ? summary : `${summary}（${part}/${total}）`.slice(0, maxBlockSummary + 8),
          data: {
            body: bodyChunks[index],
            evidence: partEvidence,
            provisional: partEvidence.length === 0,
            day,
            ...(total > 1 && index > 0 ? { parts: { groupId, part, total } } : {}),
            people: normalizePeople(block?.people),
            tags: normalizeTags(block?.tags),
            sources: [...new Set([
              ...notes.map((n) => n.key).filter(Boolean),
              ...(previous?.data?.sources ?? []),
            ])],
            ...span,
          },
          now,
        })
        if (typeof memory.index === 'function') void memory.index(created.id, `${summary}\n${bodyChunks[index]}`)
        if (index === 0) {
          // typed memory v2 的 add 层：同一次模型调用顺带抽出的稳定事实/偏好/承诺。
          // 每条独立落库（可召回、有证据），v2 再升级 validity/entity；先保证"事实不被事件块吞掉"。
          for (const [field, namespace] of [['facts', 'fact'], ['preferences', 'preference'], ['commitments', 'commitment']]) {
            const statements = Array.isArray(block?.[field]) ? block[field] : []
            for (const rawStatement of statements.slice(0, 8)) {
              // 兼容两种元素：字符串，或 {"text": "...", "invalidates": ["旧陈述片段"]}。
              const invalidates = rawStatement && typeof rawStatement === 'object' && Array.isArray(rawStatement.invalidates)
                ? rawStatement.invalidates.map((x) => String(x ?? '').trim()).filter((x) => x.length >= 4).slice(0, 4)
                : []
              const statement = String(
                rawStatement && typeof rawStatement === 'object' ? rawStatement.text ?? '' : rawStatement ?? '',
              ).trim().slice(0, 200)
              if (statement.length < 4 || !evidenceFinal.length) continue
              const similar = findSimilarTyped(namespace, statement)
              let currentKey = null
              if (similar) {
                const mergedEvidence = dedupeEvidence([...(similar.data?.evidence ?? []), ...evidenceFinal])
                const seenDays = [...new Set([...(Array.isArray(similar.data?.days) ? similar.data.days : [similar.data?.day]).filter(Boolean), day])]
                memory.put({
                  namespace, kind: 'block', key: similar.key, text: similar.text,
                  data: { ...(similar.data ?? {}), evidence: mergedEvidence, days: seenDays, lastSeenDay: day, updatedAt: now },
                  now,
                })
                typedMerged += 1
                currentKey = similar.key
              } else {
                const typedKey = `${namespace}:${day}:${hash(statement)}`
                const typed = memory.put({
                  namespace,
                  kind: 'block',
                  key: typedKey,
                  text: statement,
                  data: {
                    body: statement,
                    evidence: evidenceFinal,
                    day,
                    days: [day],
                    sourceEvent: baseKey,
                    people: normalizePeople(block?.people),
                    // typed v2 的 entity add 层第一刀：块明确指向一个人时，把规范化主体（qq）写进记录，
                    // 供后续"按实体召回/人物一致性"使用；多人或没写人就留空，不猜。
                    subject: (() => {
                      const people = normalizePeople(block?.people)
                      return people.length === 1 ? people[0] : null
                    })(),
                    tags: normalizeTags(block?.tags),
                    provisional: partEvidence.length === 0,
                  },
                  now,
                })
                if (typeof memory.index === 'function') void memory.index(typed.id, statement)
                typedWritten += 1
                currentKey = typedKey
              }
              // 旧值失效：模型在"新陈述明确取代旧陈述"时给出旧原文片段 → 确定性软失效旧记录。
              // 只按文本匹配，不猜语义；找不到就留一条 warn（可见，不静默）。
              for (const oldSnippet of invalidates) {
                const old = findTypedBySnippet(namespace, oldSnippet)
                if (!old || old.key === currentKey || old.data?.superseded === true) continue
                memory.put({
                  namespace,
                  kind: 'block',
                  key: old.key,
                  text: old.text,
                  data: { ...(old.data ?? {}), superseded: true, supersededBy: currentKey, invalidatedAt: now },
                  now,
                })
                typedInvalidated += 1
              }
              newTypedStatements.push({ ns: namespace, key: currentKey, text: statement })
            }
          }
        }
        if (index === 0 && !evidenceFinal.length) {
          raiseQuestion({
            text: `「${summary.slice(0, 40)}」没有出处，以后问一下。`,
            about: { namespace: 'event', key: baseKey },
            raisedBy: 'events',
          })
        }
        written.push(created.id)
      }
    }
    // 旧值失效（独立小调用）：events 主调用里模型常常只写字符串、不写 invalidates；
    // 这里把"今天之前已有的 typed 记录"与"今天新落库的 typed"对照一次，只做取代判定（不生成新记忆）。
    // 候选只取"和今天材料有内容词交集"的旧记录：否则模型会跨话题乱配（实测一天能失效十几条无关记录）。
    const todayTexts = [
      ...newTypedStatements.map((row) => row.text),
      ...blocks.map((block) => `${block?.summary ?? ''} ${block?.body ?? ''}`),
    ].join('\n')
    const todayNormalized = normalizeBodyText(todayTexts)
    const oldCandidates = todayNormalized && newTypedStatements.length
      ? knownTyped.filter((row) => {
          const other = normalizeBodyText(row.text)
          if (other.length < 2) return false
          for (let i = 0; i + 1 < other.length; i += 1) {
            const gram = other.slice(i, i + 2)
            if (/^[\u4e00-\u9fff]{2}$/.test(gram) && todayNormalized.includes(gram)) return true
          }
          return false
        }).slice(0, 30)
      : []
    if (newTypedStatements.length && oldCandidates.length) {
      try {
        const payload = JSON.stringify({
          old: oldCandidates.map((row, index) => ({ index, namespace: row.namespace, text: row.text })),
          new: newTypedStatements.slice(0, 12).map((row, index) => ({ index, namespace: row.ns, text: row.text })),
        })
        const verdict = await askJson({
          instruction: '判断"旧的事实/偏好/承诺"里有没有被"今天的新陈述"明确取代或推翻的（口味变了、计划改了、旧承诺作废）。只输出 JSON：{"invalidates":[{"old":旧序号,"new":新序号}]}；没有就 {"invalidates":[]}。宁少勿多：只有今天的对话明确说旧的那条不再成立才算，并存/只是相关的不算取代。',
          payload, where: 'validity', maxTokens: 1200,
        })
        // parseJsonStrict 把对象也包成单元素数组（事件块/人物都是数组根），这里取第一项。
        const verdictBody = Array.isArray(verdict.value) ? (verdict.value[0] ?? {}) : (verdict.value ?? {})
        if (verdict.ok && Array.isArray(verdictBody?.invalidates)) {
          ctx.log({
            level: 'info', msg: 'dream.validity-check', where: 'validity',
            oldCount: oldCandidates.length, newCount: newTypedStatements.length, pairs: verdictBody.invalidates.length,
          })
          // 置信/上限：每天最多软失效 4 条；且只允许同类型（偏好不由承诺来失效），避免模型过度取代。
          const MAX_DAILY_INVALIDATIONS = 4
          let appliedInvalidations = 0
          for (const pair of verdictBody.invalidates.slice(0, 12)) {
            const oldRow = oldCandidates[Number(pair?.old)]
            const newRow = newTypedStatements[Number(pair?.new)]
            if (!oldRow || !newRow || oldRow.key === newRow.key) continue
            if (oldRow.namespace !== newRow.ns) continue
            if (oldRow.data?.superseded === true) continue
            // 单日例外不推翻长期习惯（"这几天改喝豆浆"不该被"今早喝了一小杯美式"取代）。
            if (isSingleDayException(oldRow.text, newRow.text)) {
              ctx.log({ level: 'info', msg: 'dream.validity-skip-single-day', oldKey: oldRow.key, newKey: newRow.key })
              continue
            }
            if (appliedInvalidations >= MAX_DAILY_INVALIDATIONS) break
            memory.put({
              namespace: oldRow.namespace, kind: 'block', key: oldRow.key, text: oldRow.text,
              data: { ...(oldRow.data ?? {}), superseded: true, supersededBy: newRow.key, invalidatedAt: now }, now,
            })
            typedInvalidated += 1
            appliedInvalidations += 1
            ctx.log({ level: 'info', msg: 'dream.validity-invalidated', oldKey: oldRow.key, newKey: newRow.key })
          }
          if (verdictBody.invalidates.length > appliedInvalidations) {
            ctx.log({
              level: 'info', msg: 'dream.validity-capped', proposed: verdictBody.invalidates.length,
              applied: appliedInvalidations, cap: MAX_DAILY_INVALIDATIONS,
            })
          }
        }
      } catch (error) {
        ctx.log({ level: 'warn', msg: 'dream.validity-fail', error: String(error?.message ?? error).slice(0, 160) })
      }
    }
    // 确定性旧值失效兜底（2026-11-12）：模型会漏掉"旧偏好被新偏好否定"的情况（实测咖啡→豆浆漏失效）。
    // 规则保守：同类型、旧记录在更早的日子、新陈述含否定词（不/没/不再/戒/停/别）、且与新陈述共享
    // 至少一个非通用内容 bigram → 软失效旧记录（每天最多 2 条，日志可审计）。
    if (newTypedStatements.length && knownTyped.length) {
      const GENERIC_BIGRAMS = new Set(['主人', '今天', '明天', '昨天', '早上', '晚上', '中午', '周末', '现在', '以前', '时候', '自己', '一个', '不能', '可以', '没有', '什么', '怎么', '还是'])
      const bigramSet = (text) => {
        const normalized = normalizeBodyText(text)
        const set = new Set()
        for (let i = 0; i + 1 < normalized.length; i += 1) {
          const gram = normalized.slice(i, i + 2)
          if (/^[\u4e00-\u9fff]{2}$/.test(gram) && !GENERIC_BIGRAMS.has(gram)) set.add(gram)
        }
        return set
      }
      let deterministicApplied = 0
      for (const fresh of newTypedStatements) {
        if (deterministicApplied >= 2) break
        if (!/(不|没|不再|戒|停|别)/.test(fresh.text)) continue
        const freshGrams = bigramSet(fresh.text)
        if (!freshGrams.size) continue
        const oldRow = knownTyped
          .filter((row) => row.namespace === fresh.ns && row.data?.superseded !== true)
          .filter((row) => String(row.data?.day ?? '') < day)
          .find((row) => {
            const oldGrams = bigramSet(row.text)
            return [...freshGrams].some((gram) => oldGrams.has(gram))
          })
        if (!oldRow) continue
        if (isSingleDayException(oldRow.text, fresh.text)) continue
        memory.put({
          namespace: oldRow.namespace, kind: 'block', key: oldRow.key, text: oldRow.text,
          data: { ...(oldRow.data ?? {}), superseded: true, supersededBy: fresh.key, invalidatedAt: now }, now,
        })
        typedInvalidated += 1
        deterministicApplied += 1
        ctx.log({ level: 'info', msg: 'dream.validity-invalidated-deterministic', oldKey: oldRow.key, newKey: fresh.key })
      }
    }
    // 只标"真的被某块引用过"的 note：部分覆盖时，没被引用到的继续待消化。
    // 注意 day 行号与 note id 是两套编号空间，必须分开收集，否则 #12 行会和 #12 note 撞号。
    const citedNotes = new Set()
    const blockTexts = []
    for (const id of written) {
      const block = memory.query({ namespace: 'event', kind: 'block', id, limit: 1 })[0]
      if (!block) continue
      blockTexts.push(`${block.text}\n${block.data?.body ?? ''}`)
      for (const e of block.data?.evidence ?? []) if (e.type === 'note') citedNotes.add(Number(e.id))
    }
    // 覆盖判定：note 正文被新块正文覆盖，说明模型已经把同一件事并进去了（只是没引用 note 编号）。
    const noteCoveredByBlock = (note) => {
      const body = normalizeBodyText(note.text)
      if (body.length < 8) return false
      return blockTexts.some((text) => {
        const normalized = normalizeBodyText(text)
        return normalized.includes(body) || bigramJaccard(normalized, body) >= 0.5
      })
    }
    const uncovered = []
    for (const note of notes) {
      if (note.data?.consolidated === true) continue
      if (citedNotes.has(Number(note.id)) || noteCoveredByBlock(note)) { markNotes([note], now); continue }
      uncovered.push(note)
    }
    // 没被引用/覆盖的 note 保持未消化：下一轮继续作为材料（可召回、可跨天重试），
    // 绝不因为"当天有 day log"就被整批标成已消化（审计 F2）。
    const deferred = uncovered.length
    recordRun(day, 'events', {
      blocks: written.length, notes: notes.length, deferred, promoted: 0, uncovered: uncovered.length,
      typedWritten, typedMerged, typedInvalidated,
      shards: shards.length, failedShards: shardResults.filter((row) => !row.ok).length, omittedShards,
      payloadChars: shardResults.reduce((n, row) => n + row.chars, 0),
      empty: written.length === 0 && shardResults.length > 0 && shardResults.every((row) => row.ok && row.blocks === 0),
    }, now)
    return {
      job: 'events', ok: true, blocks: written.length, notes: notes.length,
      deferred, promoted: 0, typedWritten, typedMerged, typedInvalidated,
      shards: shards.length,
      failedShards: shardResults.filter((row) => !row.ok).length,
      omittedShards,
      empty: written.length === 0 && shardResults.length > 0 && shardResults.every((row) => row.ok && row.blocks === 0),
      payloadChars: shardResults.reduce((n, row) => n + row.chars, 0),
      degraded: shardResults.some((row) => !row.ok) || omittedShards > 0,
    }
  }

  /* ── people：逐人整块重写 ─────────────────────────────────────── */

  async function jobPeople({ now, force = false }) {
    const { start, end } = dayRange(now, tzOf())
    const day = dayKey(now, tzOf())
    if (!force && alreadyRan(day, 'people')) return { job: 'people', skipped: 'already-ran' }
    // 先看当天原话：人物不应该依赖 wash 恰好抽到了谁。day log 可能被分成多段，按段拼接读取。
    const dayLog = readDayLog(day)
    if (dayLog) {
      try {
        const raw = await ask({
          instruction: [
            '从当天原话里找出被提到的人，只记"这个人做了什么/说过什么"。',
            '输出 JSON 数组：[{"who":"名字","fact":"一句具体事实","source_id":1}]',
            'who 优先用行首“名字(QQ号)”括号里的 QQ 号；行首没有账号时才用称呼。',
            '不要合并不同的人；没有就输出 []。只输出 JSON。',
          ].join('\n'),
          payload: dayLog ? `${formationLines(dayLog, groundTruthSources).join('\n')}\n\n（source_id 用上面每行开头的编号）` : '',
          maxTokens: 900,
        })
        for (const item of parseBlocks(raw)) {
          const who = String(item?.who ?? '').trim()
          const fact = String(item?.fact ?? '').trim()
          if (!who || !fact) continue
          const dup = memory.query({ namespace: 'person', kind: 'note', limit: 500, order: 'desc' })
            .some((n) => String(n.data?.subject?.value ?? '') === who && String(n.text).includes(fact.slice(0, 20)))
          if (dup) continue
          const idx = Number(item?.source_id)
          const lines = dayLogIndex(dayLog)
          memory.put({
            namespace: 'person', kind: 'note', text: fact, now,
            data: {
              subject: { kind: 'name', value: who },
              evidence: Number.isFinite(idx) && lines.has(idx) ? [dayEvidence(lines, idx)] : [],
              at: Number(dayLog.createdAt) || now,
            },
          })
        }
      } catch { /* 抽取失败就退回笔记路径 */ }

      // 确定性说话人证据（Phase 2）：raw 行带 QQ envelope 的 speaker 元数据时，
      // "谁说了什么"直接用元数据落 person note，不再依赖模型从文本猜人名。
      try {
        const index = dayLogIndex(dayLog)
        for (const entry of formationEntries(dayLog, groundTruthSources)) {
          const speakerValue = String(entry.speaker?.value ?? '').trim()
          if (!/^\d{5,12}$/.test(speakerValue)) continue
          const line = index.get(Number(entry.id))
          const fact = String(line?.text ?? '').trim().slice(0, 160)
          if (!fact) continue
          const dup = memory.query({ namespace: 'person', kind: 'note', limit: 500, order: 'desc' })
            .some((n) => String(n.data?.subject?.value ?? '') === speakerValue && String(n.text).includes(fact.slice(0, 20)))
          if (dup) continue
          memory.put({
            namespace: 'person', kind: 'note', text: fact, now,
            data: {
              subject: { kind: 'qq', value: speakerValue },
              evidence: [dayEvidence(index, Number(entry.id))],
              at: Number(line?.at ?? now),
            },
          })
        }
      } catch { /* speaker 证据失败不拖垮人物 job */ }
    }
    // 人物档案跨天：只要还没被消化，不管哪天的笔记都带上。
    const notes = consolidated(memory.query({ namespace: 'person', kind: 'note', limit: 500, order: 'desc' }))
    if (!notes.length) return { job: 'people', skipped: 'no-notes' }

    // 按"通用身份"分组：qq 只是其中一种。显示名先用产品已知身份（主人/别名）归一，
    // 同一主人的多个称呼落进同一个 key（审计 F5：旧实现按显示名各建一块）。
    const bySubject = new Map()
    for (const note of notes) {
      const rawSubject = note.data?.subject ?? (note.data?.qq ? { kind: 'qq', value: String(note.data.qq) } : null)
      const subject = canonicalSubject(rawSubject)
      const key = personKeyOf(subject)
      if (!key) continue
      bySubject.set(key, [...(bySubject.get(key) ?? []), { ...note, __subject: subject }])
    }
    const written = []
    const skippedPeople = []
    let degradedPeople = false
    for (const [personKey, list] of bySubject) {
      const subject = list[0]?.__subject ?? { kind: 'qq', value: '' }
      const subjectKind = subject.kind
      const subjectValue = subject.value
      const key = personKey
      const existing = memory.query({ namespace: 'person', kind: 'block', key, limit: 1 })[0]
      // 人物档案要有"全局认识"：把过去提到过这个人的事件块也带上，
      // 否则每天只能拿到一句话，写出来的档案永远认不出是谁。
      const matchesSubject = (entry) => {
        const canonical = canonicalSubject(entry?.subject ?? (entry?.qq ? { kind: 'qq', value: String(entry.qq) } : null))
        return Boolean(canonical?.value) && String(canonical.value) === String(subjectValue)
          && String(canonical.kind) === String(subjectKind)
      }
      const aliasesOfSubject = new Set([
        subjectValue,
        ...(existing?.data?.aliases ?? []).map(String),
        ...(existing?.data?.ids ?? []).map((x) => String(x?.value ?? '')),
        ...(subject.role === 'owner' ? ownerNames : []),
        ...(subject.role === 'self' ? ['鱼鱼'] : []),
      ].filter(Boolean))
      const relatedEvents = memory.query({ namespace: 'event', kind: 'block', limit: 500, order: 'desc' })
        .filter((b) => Array.isArray(b.data?.people) && b.data.people.some((p) => aliasesOfSubject.has(String(p))))
        .slice(-20)
      const pastNotes = memory.query({ namespace: 'person', kind: 'note', limit: 500, order: 'desc' })
        .filter((n) => matchesSubject(n.data) && !list.some((x) => x.id === n.id))
        .slice(-20)

      // 材料预算：单行截断 + 总量上限（READINESS G-1）。超出时显式省略而不是把请求撑爆。
      const renderNotes = (rows, label, max = 60) => {
        const kept = rows.slice(-max)
        const omitted = rows.length - kept.length
        return `${label}：\n${kept.map((n) => `[${n.id}] ${clipText(n.text)}`).join('\n')}${omitted > 0 ? `\n…（省略更早 ${omitted} 条）` : ''}`
      }
      const identityLabel = subject.role === 'owner' ? `${subjectKind}:${subjectValue}（主人）`
        : subject.role === 'self' ? `${subjectKind}:${subjectValue}（她自己）`
          : `${subjectKind}:${subjectValue}`
      const context = clipPayload([
        `内部编号（不要写进档案）：${identityLabel}`,
        existing ? `现有档案：\n${clipText(existing.text, 1200)}\n${clipText(existing.data?.narrative ?? '', 1200)}` : '现有档案：无',
        relatedEvents.length ? `以前提到过 TA 的事：\n${relatedEvents.map((b) => `· ${clipText(b.text, 200)}`).join('\n')}` : '',
        pastNotes.length ? renderNotes(pastNotes, '以前记下的') : '',
        renderNotes(list, '今天记下的', 120),
      ].filter(Boolean).join('\n\n'), 'people-materials')
      if (context.length >= maxPayloadChars - 32) degradedPeople = true

      let parsedOut = null
      try {
        parsedOut = await askJson({
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
          ].join('\n'),
          payload: context,
          where: 'people',
          maxTokens: 1800,
        })
      } catch (error) {
        return { job: 'people', ok: false, qq: identityLabel, error: String(error?.message ?? error) }
      }
      // 空输出/垃圾 JSON 不再当成"模型没写"：按失败计，让人物档案下次重试；
      // 只有合法 `{}`（value 为空对象）才走薄档案兜底。
      if (!parsedOut.ok) throw new Error(`模型输出不可解析：${parsedOut.error}`)
      const parsed = parsedOut.value[0]
      let profile = String(parsed?.profile ?? '').trim()
      // 模型硬是不写时，用笔记原文拼一份薄档案——
      // 宁可少，不可空；下一次有新材料再整块重写。
      if (!profile) {
        profile = `目前知道的：${list.map((n) => n.text.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 3).join('；')}。`
      }
      if (!profile) { skippedPeople.push(key); continue }
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
          // 通用身份：以后 mc/discord/自定义都用同一套字段。subject 已归一（主人/别名 → ownerQQ）。
          subject: { kind: subjectKind, value: subjectValue },
          ...(subject.role === 'owner' ? { owner: true } : {}),
          ...(subject.role === 'self' ? { self: true } : {}),
          qq: subjectKind === 'qq' ? subjectValue : null,
          ids: sanitizeIds(
            Array.isArray(parsed?.ids) ? parsed.ids : (existing?.data?.ids ?? []),
            { kind: subjectKind, value: subjectValue },
          ),
          familiarity: String(parsed?.familiarity ?? existing?.data?.familiarity ?? 'unknown'),
          provisional: thin || evidence.length === 0,
          evidence,
          claims: (Array.isArray(parsed?.claims) ? parsed.claims : [])
            .map((c) => ({ text: String(c?.text ?? '').slice(0, 200), evidence: validEvidence(c?.evidence, [...list, ...pastNotes]) }))
            .filter((c) => c.text),
          profile: profile.slice(0, 2000),
          narrative: String(parsed?.narrative ?? '').slice(0, 4000),
          facts: Array.isArray(parsed?.facts) ? parsed.facts.slice(0, 50) : [],
          aliases: [...new Set([
            ...(Array.isArray(parsed?.aliases) ? parsed.aliases.map(String) : []),
            ...(existing?.data?.aliases ?? []).map(String),
            ...(subject.role === 'owner' ? ownerNames : []),
          ].filter(Boolean))].slice(0, 10),
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
    const subjectsOf = (n) => {
      const subject = n.data?.subject ?? (n.data?.qq ? { kind: 'qq', value: String(n.data.qq) } : null)
      return subject?.value ? subject : null
    }
    const blockKeys = new Set(
      notes.map((n) => personKeyOf(canonicalSubject(n.data?.subject ?? (n.data?.qq ? { kind: 'qq', value: String(n.data.qq) } : null)))).filter(Boolean),
    )
    for (const key of blockKeys) {
      if (skippedPeople.includes(key)) continue
      const block = memory.query({ namespace: 'person', kind: 'block', key, limit: 1 })[0]
      if (!block) continue
      for (const e of block.data?.evidence ?? []) citedPeople.add(Number(e.id))
      for (const c of block.data?.claims ?? []) for (const e of c.evidence ?? []) citedPeople.add(Number(e.id))
    }
    const writtenNotes = notes.filter((n) => citedPeople.has(Number(n.id)))
    if (writtenNotes.length) markNotes(writtenNotes, now)
    recordRun(day, 'people', { blocks: written.length, people: bySubject.size, skipped: skippedPeople.length, degraded: degradedPeople }, now)
    return { job: 'people', ok: true, blocks: written.length, people: bySubject.size, skipped: skippedPeople.length, degraded: degradedPeople }
  }

  /* ── slang：新增/更新梗块 ───────────────────────────────────── */

  async function jobSlang({ now, force = false }) {
    const { start, end } = dayRange(now, tzOf())
    const day = dayKey(now, tzOf())
    if (!force && alreadyRan(day, 'slang')) return { job: 'slang', skipped: 'already-ran' }
    const notes = consolidated(memory.query({ namespace: 'slang', kind: 'note', since: start, until: end, limit: 500, order: 'desc' }))
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
      const term = String(item?.term ?? item?.content ?? '').trim()
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
    for (const ns of CLEANUP_NAMESPACES) {
      const hit = memory.query({ namespace: ns, kind: 'block', key: wanted, limit: 1 })[0]
      if (hit) return hit
    }
    return null
  }

  /** 规范化正文：去空白/标点/大小写，便于判断两条块是不是同一段经历。 */
  function normalizeBodyText(value) {
    return String(value ?? '').toLowerCase().replace(/\s+/g, '').replace(/[。！？!?，,；;：:、"'“”‘’（）()【】\[\]…—\-]/g, '')
  }
  /**
   * typed 记录（事实/偏好/承诺）跨天去重：同一条事实反复被抽出时合并证据，
   * 而不是每天新增一条（Phase 2 实测：5 天抽出 53 条 fact，其中 32.8% 是近重复）。
   */
  function findSimilarTyped(namespace, statement) {
    const normalized = normalizeBodyText(statement)
    if (normalized.length < 6) return null
    for (const row of memory.query({ namespace, kind: 'block', limit: 200, order: 'desc' })) {
      if (row.data?.superseded === true) continue
      const other = normalizeBodyText(row.text)
      if (other.length < 6) continue
      if (other.includes(normalized) || normalized.includes(other) || bigramJaccard(normalized, other) >= 0.78) return row
    }
    return null
  }
  /** 按"旧陈述片段"找一条已存在的 typed 记录（用于 invalidates 的确定性失效）。 */
  function findTypedBySnippet(namespace, snippet) {
    const normalized = normalizeBodyText(snippet)
    if (normalized.length < 4) return null
    for (const row of memory.query({ namespace, kind: 'block', limit: 200, order: 'desc' })) {
      if (row.data?.superseded === true) continue
      const other = normalizeBodyText(row.text)
      if (!other.length) continue
      if (other.includes(normalized) || normalized.includes(other) || bigramJaccard(normalized, other) >= 0.55) return row
    }
    return null
  }
  /**
   * 单日例外不推翻长期习惯（validity 误失效防护）：
   * "这几天早上改喝豆浆" 不该被 "今早喝了一小杯美式" 取代；"每天/习惯/一直" 的旧陈述
   * 遇到 "今天/今早/昨晚/有一次" 这种单日新陈述时保持旧记录。
   */
  function isSingleDayException(oldText, newText) {
    const oldHabit = /(习惯|每天|这几天|一直|总是|每周|平时|从来)/.test(String(oldText ?? ''))
    const singleDay = /(今天|今早|今晚|昨晚|当时|那天|有一次|这回|这次|刚才)/.test(String(newText ?? ''))
    return oldHabit && singleDay
  }
  function bigramJaccard(a, b) {
    const grams = (text) => { const out = new Set(); for (let i = 0; i < text.length - 1; i += 1) out.add(text.slice(i, i + 2)); return out }
    const left = grams(a)
    const right = grams(b)
    if (!left.size || !right.size) return 0
    let overlap = 0
    for (const gram of left) if (right.has(gram)) overlap += 1
    return overlap / (left.size + right.size - overlap)
  }
  function sameExperience(a, b) {
    // 身份合并只能走显式 alias（人不是"相似经历"）：审计 F4 复现过不同人的
    // person 块因同一句薄档案模板被算法合并、一方 superseded 直接消失。
    const nsA = String(a?.namespace ?? '')
    const nsB = String(b?.namespace ?? '')
    if (nsA !== nsB) return false
    if (nsA === 'person') return false
    const dayA = a?.data?.day
    const dayB = b?.data?.day
    // 没有 day 的块不参与确定性合并：判据必须是可证的同一天，而不是"都没写"。
    if (!dayA || !dayB) return false
    return String(dayA) === String(dayB)
  }
  /** 证据 key 集合（type+id），用于要求"同一段经历"有共同的原始出处。 */
  function evidenceKeysOf(block) {
    return new Set((block?.data?.evidence ?? [])
      .map((entry) => `${String(entry?.type ?? '')}:${Number(entry?.id)}`)
      .filter((key) => !key.endsWith(':NaN')))
  }
  function evidenceOverlap(a, b) {
    const left = evidenceKeysOf(a)
    const right = evidenceKeysOf(b)
    if (!left.size || !right.size) return 0
    let hit = 0
    for (const key of left) if (right.has(key)) hit += 1
    return hit / Math.min(left.size, right.size)
  }

  /**
   * 确定性近似重复合并（P1，首次 E2 实测）：模型 plan 漏掉的同经历双块。
   * 判据：同一天/时间重叠 + 规范化 body 包含（≥20 字）或 bigram Jaccard≥0.8。
   * 保留"正文更全"的块 key；evidence 并集、mergedFrom 记录被吞并的 key；被吞并块标 superseded。
   */
  function mergeNearDuplicateBlocks(now) {
    let merged = 0
    const pairs = []
    for (const ns of ['event', 'slang']) {
      const blocks = memory.query({ namespace: ns, kind: 'block', limit: 500, order: 'desc' })
        .filter((row) => row.data?.superseded !== true)
      const dropped = new Set()
      for (let i = 0; i < blocks.length; i += 1) {
        const keeper = blocks[i]
        if (dropped.has(keeper.id)) continue
        const keeperBody = normalizeBodyText(keeper.data?.body ?? keeper.text)
        if (keeperBody.length < 20) continue
        for (let j = i + 1; j < blocks.length; j += 1) {
          const other = blocks[j]
          if (dropped.has(other.id)) continue
          if (!sameExperience(keeper, other)) continue
          const otherBody = normalizeBodyText(other.data?.body ?? other.text)
          if (otherBody.length < 20) continue
          const contained = keeperBody.includes(otherBody) || otherBody.includes(keeperBody)
          if (!contained && bigramJaccard(keeperBody, otherBody) < 0.8) continue
          // 非包含关系的"相似"必须共享原始出处：模板句/同主题不同事件不会被误吞。
          if (!contained && evidenceOverlap(keeper, other) < 0.5) continue
          // 正文更全的一方胜出；若对方更长，则把正文搬到 keeper 上（key 不变，避免 key 引用失效）。
          const longest = otherBody.length > keeperBody.length ? otherBody : keeperBody
          const unionEvidence = dedupeEvidence([
            ...(keeper.data?.evidence ?? []),
            ...(other.data?.evidence ?? []),
          ].filter((entry, index, arr) => arr.findIndex((row) => row?.type === entry?.type && Number(row?.id) === Number(entry?.id)) === index))
          const froms = [Number(keeper.data?.from ?? 0), Number(other.data?.from ?? 0)].filter(Boolean)
          const tos = [Number(keeper.data?.to ?? 0), Number(other.data?.to ?? 0)].filter(Boolean)
          memory.put({
            namespace: ns,
            kind: 'block',
            key: keeper.key,
            text: keeper.text,
            data: {
              ...(keeper.data ?? {}),
              body: String(longest === keeperBody ? (keeper.data?.body ?? '') : (other.data?.body ?? '')).slice(0, maxBlockBody),
              evidence: unionEvidence,
              mergedFrom: [...new Set([...(keeper.data?.mergedFrom ?? []), other.key, ...(other.data?.mergedFrom ?? [])])],
              ...(froms.length ? { from: Math.min(...froms) } : {}),
              ...(tos.length ? { to: Math.max(...tos) } : {}),
            },
            now,
          })
          memory.patch(other.id, { data: { ...(other.data ?? {}), superseded: true, supersededBy: keeper.key, invalidatedAt: now } })
          dropped.add(other.id)
          merged += 1
          pairs.push(`${other.key}->${keeper.key}`)
        }
      }
    }
    return { merged, pairs }
  }

  /**
   * 已知身份归并（审计 F5，确定性、零模型调用）：
   * 旧数据里 主人/Hahn123（离线版）各有一份档案，甚至把 selfQQ 挂到主人档案上。
   * 只合并"能由产品配置证明是同一身份"的块（ownerQQ/selfQQ/ownerNames/selfNames），
   * 未知显示名一律不动——宁可留两份，也不能把两个真人合成一个。
   */
  function ownerNameMatches(names) {
    return names.some((name) => ownerNameSet.has(name) || ownerNames.some((alias) => name.startsWith(alias)))
  }
  function mergeKnownIdentityBlocks(now) {
    const canonicalOf = (block) => {
      const subject = block?.data?.subject ?? {}
      const aliases = (block?.data?.aliases ?? []).map(String)
      const nameCandidates = [String(subject.value ?? ''), ...aliases].filter(Boolean)
      if (subject.kind === 'qq' && selfQQ && String(subject.value) === selfQQ) return `person:${selfQQ}`
      if (subject.kind === 'qq' && ownerQQ && String(subject.value) === ownerQQ) return `person:${ownerQQ}`
      if (ownerQQ && ownerNameMatches(nameCandidates)) return `person:${ownerQQ}`
      if (selfQQ && selfNames.length && nameCandidates.some((name) => selfNames.includes(name))) return `person:${selfQQ}`
      // 只有账号证据、没有显示名证据时不做归并（防群号/共享号误合并）。
      return null
    }
    const groups = new Map()
    for (const block of memory.query({ namespace: 'person', kind: 'block', limit: 500, order: 'desc' })) {
      if (block.data?.superseded === true) continue
      const canonical = canonicalOf(block)
      if (!canonical) continue
      groups.set(canonical, [...(groups.get(canonical) ?? []), block])
    }
    let merged = 0
    for (const [key, blocks] of groups) {
      if (blocks.length < 2) continue
      // 保留证据/正文最全的一块做 keeper；key 统一成 canonical。
      const scoreOf = (row) => (Number(row.data?.evidence?.length ?? 0) * 1000) + String(row.data?.profile ?? row.text ?? '').length
      const sorted = blocks.slice().sort((a, b) => scoreOf(b) - scoreOf(a) || Number(a.id) - Number(b.id))
      const keeper = sorted[0]
      const unionById = new Map()
      for (const row of sorted) for (const entry of row.data?.ids ?? []) unionById.set(`${entry.kind}:${entry.value}`, entry)
      const unionIds = [...unionById.values()].slice(0, 10)
      const unionAliases = [...new Set(sorted.flatMap((row) => row.data?.aliases ?? []).map(String))].slice(0, 10)
      const unionEvidence = sorted.flatMap((row) => row.data?.evidence ?? [])
        .filter((entry, index, arr) => arr.findIndex((x) => x?.type === entry?.type && Number(x?.id) === Number(entry?.id)) === index)
        .slice(0, 30)
      const canonicalSubjectValue = key.slice('person:'.length)
      const supersedeKeys = sorted.filter((row) => row.key !== key)
      memory.put({
        namespace: 'person', kind: 'block', key,
        text: keeper.text,
        data: {
          ...(keeper.data ?? {}),
          subject: { kind: 'qq', value: canonicalSubjectValue },
          qq: canonicalSubjectValue,
          ids: unionIds,
          aliases: [...new Set([...unionAliases, canonicalSubjectValue])].slice(0, 10),
          evidence: unionEvidence,
          mergedFrom: [...new Set([...(keeper.data?.mergedFrom ?? []), ...supersedeKeys.map((row) => row.key)])],
          identityMergedAt: now,
        },
        now,
      })
      for (const row of supersedeKeys) {
        memory.patch(row.id, { data: { ...(row.data ?? {}), superseded: true, supersededBy: key, invalidatedAt: now } })
        merged += 1
      }
    }
    return { merged }
  }

  async function jobCleanup({ now, force = false }) {
    const day = dayKey(now, tzOf())
    if (!force && alreadyRan(day, 'cleanup')) return { job: 'cleanup', skipped: 'already-ran' }
    // 先做确定性身份归并（0 模型）：同一主人的多个显示名档案合成一份，再把结果交给模型整理。
    const identity = mergeKnownIdentityBlocks(now)

    const pendingResolves = memory.query({ namespace: 'resolve', kind: 'note', limit: 100, order: 'desc' })
      .filter((n) => n.data?.consumed !== true)

    const blocks = []
    for (const ns of CLEANUP_NAMESPACES) {
      for (const b of memory.query({ namespace: ns, kind: 'block', limit: 500, order: 'desc' })) {
        if (b.data?.superseded === true) continue
        blocks.push({ ns, key: b.key, id: b.id, text: b.text, people: (b.data?.people ?? []).map(String), body: String(b.data?.body ?? b.data?.profile ?? b.data?.narrative ?? '').slice(0, 400) })
      }
    }
    if (blocks.length < 2 && !pendingResolves.length && identity.merged === 0) return { job: 'cleanup', skipped: 'nothing-to-do' }

    // 跨天近似重复只做"报告"，合不合由模型决定（不做算法合并）
    const grams = (text) => {
      const q = String(text ?? '').replace(/\s+/g, '')
      const out = new Set()
      for (let i = 0; i < q.length - 1; i++) out.add(q.slice(i, i + 2))
      return out
    }
    const similar = (a, b) => {
      const A = grams(a), B = grams(b)
      if (!A.size || !B.size) return 0
      let hit = 0
      for (const g of A) if (B.has(g)) hit += 1
      return hit / Math.min(A.size, B.size)
    }
    const pairs = []
    for (let i = 0; i < blocks.length; i++) {
      for (let j = i + 1; j < blocks.length; j++) {
        const score = similar(blocks[i].text + blocks[i].body, blocks[j].text + blocks[j].body)
        if (score >= 0.5) pairs.push({ a: blocks[i].key, b: blocks[j].key, score: Number(score.toFixed(2)), aText: blocks[i].text, bText: blocks[j].text })
      }
    }
    pairs.sort((x, y) => y.score - x.score)
    const nearPairs = pairs.slice(0, 10)

    const shownBlocks = blocks.slice(-150)
    const payload = [
      '现有记忆块（key | 类型 | 摘要 | 正文）：',
      ...shownBlocks.map((b) => `- ${b.key} | ${b.ns}${b.people.length ? ` | people=${b.people.join(',')}` : ''} | ${b.text} | ${b.body.replace(/\n/g, ' ').slice(0, 200)}`),
      nearPairs.length
        ? '\n内容可能重复的块（只是候选，是否合并你自己判断）：\n' + nearPairs.map((p) => `- ${p.a}（${p.aText}）≈ ${p.b}（${p.bText}） 相似度 ${p.score}`).join('\n')
        : '',
      pendingResolves.length
        ? '\n主会话的纠正（必须处理）：\n' + pendingResolves.map((n) => {
          const about = n.data?.about
          return about?.key ? `- [针对 ${about.key}] ${n.text}` : `- ${n.text}`
        }).join('\n')
        : '',
    ].filter(Boolean).join('\n')

    let plan = null
    try {
      const out = await askJson({
        where: 'cleanup',
        instruction: [
          '你在整理已有的记忆块。不新增事实，只合并/去重/改写。',
          '输出一个 JSON 对象：',
          '{"merges": [{"keep": "key", "drop": ["key"], "text": "合并后的一行摘要", "body": "合并后的正文", "uncertain": false}],',
          ' "rewrites": [{"key": "key", "text": "改写后的摘要", "body": "改写后的正文"}],',
          ' "consumed": ["resolve note key"]}',
          '',
          '规则：',
          '· 只合并真正说的是同一件事/同一个人的块；没把握就不合并。',
          '· 事实/偏好/承诺块出现新旧矛盾时（例如旧偏好已被新偏好替代、旧端口/旧承诺已过时）：保留新的块，把旧的 key 放进 drop（软删保留历史，不丢证据）；分不清新旧就设 uncertain。',
          '· 事实/偏好/承诺块只在同类型之间合并；不要把它们并进事件块/人物块（结构化层要保留，旧值失效由夜间 validity 判定处理）。',
          '· 同一事实的多个块可以合并成一条，保留更完整的措辞与双方 evidence。',
          '· 两个块互相矛盾且分不清对错：合并为一块并把 uncertain 设为 true，正文里写明"不确定"。',
          '· 人物块可以用 people 里含该 QQ 的事件块来补充或修正；改写时整块重写，不要丢旧信息。',
          '· 主会话的纠正优,：按它改写对应的块（事件或人物档案），并把对应 resolve note 放进 consumed。',
          '· 合并后的 text 一行、body 一小段；删掉的 key 不要再出现在别的操作里。',
          '· 不要为了“长度差不多”而合并：小块没有矛盾就原样留着。',
          '· 允许跨天合并：两个块讲的是同一件事（哪怕隔了几天），合并成一块，保留双方细节。',
          '· 目标是去重与消除矛盾，不是把所有块整理成一个样子。',
          '没什么可整理就输出 {} 。只输出 JSON。',
        ].join('\n'),
        payload,
        maxTokens: 2400,
      })
      // 空输出/垃圾 JSON = 失败（当天可重试），不能记成"整理成功但 0 操作"。
      if (!out.ok) throw new Error(`模型输出不可解析：${out.error}`)
      plan = out.value
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
        // 结构化层保护：fact/preference/commitment 不能被并进 event/人物/梗块，
        // 也不能跨 typed 类型合并（否则"旧偏好"会被事件正文吞掉，validity 就失去对象）。
        const TYPED_NS = ['fact', 'preference', 'commitment']
        const keepTyped = TYPED_NS.includes(ns)
        const targetTyped = TYPED_NS.includes(target.namespace)
        if ((keepTyped || targetTyped) && target.namespace !== ns) continue
        memory.patch(target.id, { data: { ...(target.data ?? {}), superseded: true, supersededBy: keepKey, invalidatedAt: now } })
      }
      mergedCount += 1
    }

    for (const op of rewrites) {
      const key = String(op?.key ?? '').trim()
      if (!key) continue
      const existing = findBlockByKey(key)
      if (!existing) continue
      // 一次算出完整的 nextData / nextText，再只 patch 一次。
      // 旧写法连打三次 patch，后两次都基于改写前的 existing.data，会把 body 写回旧值。
      const nextData = { ...(existing.data ?? {}) }
      let changed = false
      const nextText = op?.text ? String(op.text).slice(0, 400) : null
      if (nextText != null) changed = true
      if (op?.body) { nextData.body = String(op.body).slice(0, 4000); changed = true }
      if (Array.isArray(op?.evidence) && op.evidence.length) {
        const ev = op.evidence.map((x) => ({ type: 'block', id: Number(x) })).filter((x) => Number.isFinite(x.id))
        if (ev.length) { nextData.evidence = [...(nextData.evidence ?? []), ...ev]; changed = true }
      }
      if (changed) memory.patch(existing.id, { ...(nextText == null ? {} : { text: nextText }), data: nextData })
      rewriteCount += 1
    }

    // 确定性近似重复合并（首次 E2 实测 P1：#17/#18 同经历重复，模型 plan 没抓到）。
    // 只同一天/时间重叠的块参与；规范化 body 后"包含"或 bigram Jaccard≥0.8 视为同一段经历。
    const near = mergeNearDuplicateBlocks(now)
    mergedCount += near.merged

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

    recordRun(day, 'cleanup', { merged: mergedCount, rewrites: rewriteCount, consumed: consumed.length, nearDuplicates: near.merged, identityMerged: identity.merged }, now)
    return { job: 'cleanup', ok: true, merged: mergedCount, rewrites: rewriteCount, consumed: consumed.length, nearDuplicates: near.merged, identityMerged: identity.merged }
  }

  /* ── index：补建向量索引（最后一步）───────────────── */

  /**
   * 补向量：嵌入服务是后接上的时候，之前写的块没有向量；
   * 它们只能靠字面搜到。这一步把缺的补上。
   * 手动接口：`dream.run({ jobs: ['index'] })`。
   */
  async function jobIndex({ now, force = false }) {
    const day = dayKey(now, tzOf())
    if (!force && alreadyRan(day, 'index')) return { job: 'index', skipped: 'already-ran' }
    const missing = memory.missingVectors({ limit: 200 })
    if (!missing.length) return { job: 'index', skipped: 'nothing-missing' }
    // 没有嵌入模型时，memory.index() 一律返回 false——旧实现仍报 ok:true/indexed:0，
    // 看起来像"跑过了、索引了 0 条"，其实是"根本没能力索引"。明确回报，不假装。
    let embedded = false
    try { embedded = memory.stats?.()?.embedded === true } catch { embedded = false }
    if (!embedded) return { job: 'index', skipped: 'no-embed', missing: missing.length }
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

  function tzOf() { return String(ctx.config.timezone ?? 'Asia/Hong_Kong') }
  // 按配置时区算当天；dayRange/dayKey 是同一套算法，不再各用各的。
  function ymdInTz(now) { return ymdOf(now, tzOf()) }
  function dayStartOf(now) { return dayRange(now, tzOf()).start }
  function dayEndOf(now) { return dayRange(now, tzOf()).end }

  /**
   * 语料采集的确定性闸门（审计 §7.1）：工具名/框架标识符不该进"语料"。
   * 它们既不帮助理解群里的话，又会占 180 天半衰期、长期参与 eager 注入。
   * 只挡"形式明显是标识符/状态字段"的；中文词仍交给模型判断。
   */
  function isLikelyJargon(term) {
    const word = String(term ?? '').trim()
    if (!word) return true
    if (word.length > 16) return true
    if (/^(?:mcb|time|body|qq|mc|icl|dsh|clip)[:_-]/i.test(word)) return true
    if (/^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)+$/i.test(word)) return true // mcb_join / finish-then-handle / clip-zh
    if (/^[a-z0-9]+\.[a-z0-9]+$/i.test(word)) return true // 文件名 / 域名
    if (/^[a-z0-9_ -]*\d+[a-z0-9_ -]*$/i.test(word) && !/[\u4e00-\u9fff]/.test(word)) return true // 纯 ASCII 带数字
    if (/^(?:status|body|event|note|block|namespace|recall|dream|memory|prompt|token|session|cursor|finish|handle)$/i.test(word)) return true
    return false
  }

  async function jobLexicon({ now, force = false }) {
    const day = dayKey(now, tzOf())
    if (!force && alreadyRan(day, 'lexicon')) return { job: 'lexicon', skipped: 'already-ran' }
    // slang 已并入 lexicon：采集范围包括旧的 slang 笔记
    // 采集要看原话，不是看摘要：短梗（如「6」、「彳亠」）根本不会变成 note
    let sourceLines = []
    let sourceEntries = []
    let dayLog = null
    try {
      // 优先用当天洗好的干净原话（可能分多段）；没有才退回原文来源。
      // 语料只从**真人/QQ 转述**里采集：工具结果、系统状态、她自己转述的话都不是"群里的说法"（审计 7.1）。
      dayLog = readDayLog(day)
      if (dayLog?.text) {
        sourceEntries = formationEntries(dayLog, groundTruthSources)
        sourceLines = sourceEntries.map((entry) => entry.line)
      } else {
        const rawRows = await ctx.services.raw?.list?.({ since: dayStartOf(now), until: dayEndOf(now), limit: 400 }) ?? []
        sourceLines = rawRows.map((m) => stripStructured(m.text)).filter(Boolean)
      }
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

    // 材料条目：原文路径用 day log 的绝对行号做 source_id；笔记路径用 note id。
    const chatSource = sourceEntries.length
      ? sourceEntries.map((entry) => ({ id: entry.id, text: entry.line }))
      : notes.map((note) => ({ id: Number(note.id), text: note.text }))
    let items = []
    try {
      // 参考旧实现：逐条 <message> 包裹 + 明确规则 + source_id
      const chatLines = chatSource
        .slice(0, 200)
        .map((entry) => `<message source_id="${entry.id}">${String(entry.text).replace(/[<>]/g, ' ').slice(0, 300)}</message>`)
        .join('\n')
      // 采集器不带人格：它只是机械地记下候选，人格在主会话里选用
      const rules = [
        '你是群聊/弹幕/评论里的"说法采集器"。你的任务不是解释，而是挑出**值得建档**的说法。',
        '',
        '判断标准（全部满足才挑）：',
        '1. 它在这段材料里真实出现过；',
        '2. 它要么是群体内部才懂的说法，要么你怀疑它在这里的用法和常见用法不同；',
        '3. 挑出来是为了以后能查"这个群里它到底怎么用"，不是为了给字典补词。',
        '',
        '该挑（正确示例）：',
        '- 「白饭」：我第一反应是白米饭，但这里明显指别的东西（AI 光吃 token 不干活）',
        '- 「查寝码」：本群特有的说法，具体指什么需要确认',
        '- 「彳亍」：把"行"拆开写，只有在这个圈子里才这么用',
        '- 「yyds」「xswl」这类拼音缩写，如果我不知道具体指谁/什么',
        '',
        '不该挑（错误示例）：',
        '- 「玩梗」「考古」「上头」「刷」「双马尾」——我明确知道它们的意思，也不是本群特有',
        '- 「今天」「因为」「所以」这类普通词',
        '- 人名、@、表情、单个标点、纯数字',
        '- 只出现一次、又没有任何上下文线索的碎片',
        '',
        '每条输出：',
        '[{"term":"词","meaning":"只有在你完全确定时才写，否则留空","reason":"unknown|shifted|in-group|frequent","source_id":消息编号}]',
        'source_id 必须是你判断所依据的那条 <message> 的 source_id（整数），不能编。',
        'meaning 绝不能猜。没有就输出 []。只输出 JSON。',
            ].join('\n')
      let lastError = 'empty'
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const nudge = attempt === 0 ? '' : '\n\n上一次输出无法解析为 JSON。只输出合法 JSON，不要解释。'
        const raw = await ctx.slots.call(slot, {
          messages: [
            { role: 'system', content: `${rules}${nudge}` },
            { role: 'user', content: chatLines.slice(0, 8000) },
          ],
          maxTokens: 900,
        })
        const out = parseJsonStrict(raw)
        if (out.ok) { items = out.value; lastError = null; break }
        lastError = out.error
        ctx.log({ level: 'warn', msg: 'dream.parse-retry', where: 'lexicon', attempt: attempt + 1, error: out.error })
      }
      // 空输出/垃圾 JSON 是失败：当天不记"成功但没学到词"，留待下一次触发重试。
      if (lastError) throw new Error(`模型输出不可解析：${lastError}`)
    } catch (error) {
      return { job: 'lexicon', ok: false, error: String(error?.message ?? error) }
    }

    // 去重：同一个词只建一次档，也只提一次待办
    const seenTerms = new Set((lexicon.query?.() ?? []).map((r) => String(r.data?.term ?? '')))
    let learned = 0
    let skippedJargon = 0
    for (const item of items) {
      const term = String(item?.term ?? item?.content ?? '').trim()
      if (!term || seenTerms.has(term)) continue
      // 确定性闸门：工具名/框架标识符/状态字段不进语料（审计 §7.1 的 18/37 噪声）。
      if (isLikelyJargon(term)) { skippedJargon += 1; continue }
      // 语料也要有出处：source_id → day 行证据（原文路径）或 note 证据（笔记路径）。
      const evidence = []
      const sourceId = Number(item?.source_id)
      if (Number.isFinite(sourceId)) {
        if (dayLog) {
          const lines = dayLogIndex(dayLog)
          if (lines.has(sourceId)) evidence.push(dayEvidence(lines, sourceId))
        } else {
          const note = notes.find((row) => Number(row.id) === sourceId)
          if (note) evidence.push({ type: 'note', id: Number(note.id), line: clipText(note.text, 160), at: Number(note.data?.at ?? note.createdAt ?? now) })
        }
      }
      const res = lexicon.upsert({
        term,
        conv: String(item?.conv ?? '').trim() || 'web',
        meaning: String(item?.meaning ?? '').trim(),
        tags: [item?.reason === 'shifted' ? '新义' : item?.reason === 'in-group' ? '本群' : item?.reason === 'frequent' ? '高频' : '待查'],
        evidence,
      })
      if (res?.ok) { learned += 1; seenTerms.add(term) }
    }

    const faded = ageLexicon(now)

    recordRun(day, 'lexicon', { learned, faded, skippedJargon }, now)
    return { job: 'lexicon', ok: true, learned, faded, skippedJargon }
  }

  /* ── consume：回收已完成的备忘 ──────────────── */

  /**
   * 主会话把一条备忘标成 done 之后，晚上把结论写回它归属的地方。
   *
   * 只做三个明确分支（不上抽象）：lexicon / person / event。
   * 防“为了写而写”：没有 result 且没有追加内容的，不写，也不归档。
   */
  async function jobConsume({ now, force = false }) {
    const day = dayKey(now, tzOf())
    if (!force && alreadyRan(day, 'consume')) return { job: 'consume', skipped: 'already-ran' }
    const noteSvc = ctx.services.get('note')
    if (!noteSvc) return { job: 'consume', skipped: 'no-note-plugin' }
    const done = memory.query({ namespace: 'note', kind: 'note', limit: 200, order: 'desc' })
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
          const existing = memory.query({ namespace: 'lexicon', kind: 'term', key, limit: 1 })[0]
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

  const JOBS = { wash: jobWash, events: jobEvents, people: jobPeople, slang: jobSlang, lexicon: jobLexicon, consume: jobConsume, cleanup: jobCleanup, index: jobIndex }

  /**
   * 跑一轮做梦。jobs 可按需指定（默认三个都跑）。
   * @returns {{ok:boolean, day:string, results:object[]}}
   */
  /**
   * dream 完成/失败的回执（红队 C4 / TIME.md §15.3 契约）：
   *   signals.emit({from:{plugin:'dream'}, kind:'event', text, tags:['dream-result'], meta:{ok,jobs,degraded,failedShards,at}})
   * time 侧：睡眠中并入醒来简报；醒着发一条 notice；没收到回执时简报写"未回传"（不假装成功）。
   * 全是 skip（already-ran/no-raw/…）时不发——没有真干活就别发"完成"。
   * text 只放载荷（time 自己会包"完成/失败"），例如 "wash 1119 行 / events 3 块"。
   */
  function jobDetail(row) {
    if (row.job === 'wash') return `${row.lines ?? 0} 行${row.omittedLines ? `（省略 ${row.omittedLines} 行）` : ''}`
    if (row.job === 'events') return `${row.blocks ?? 0} 块`
    if (row.job === 'people') return `${row.blocks ?? 0} 人`
    if (row.job === 'slang') return `${row.blocks ?? 0} 条`
    if (row.job === 'cleanup') return `${row.merged ?? 0} 合并/${row.rewrites ?? 0} 改写`
    if (row.job === 'index') return `${row.indexed ?? 0} 条`
    if (row.job === 'lexicon') return `${row.learned ?? 0} 条`
    if (row.job === 'consume') return `${row.written ?? 0} 条写待办`
    return 'ok'
  }

  function emitDreamResult({ now, results }) {
    const executed = results.filter((row) => row.ok !== false && !row.skipped)
    const failed = results.filter((row) => row.ok === false)
    if (!executed.length && !failed.length) return null // 全 skip：没有真干活，不发假回执
    const degraded = results.some((row) => row.degraded === true)
    const failedShards = results.reduce((n, row) => n + (Number(row.failedShards) || 0), 0)
    // 分段（segmented>1）是正常设计，不叫"降级"；回执写成"分 N 段"，只有真截断/片失败才说降级。
    const segmentedJobs = results
      .filter((row) => Number(row.segmented) > 1)
      .map((row) => `${row.job} 分 ${Number(row.segmented)} 段`)
    const ok = failed.length === 0
    const parts = [
      ...executed.map((row) => `${row.job} ${jobDetail(row)}`),
      ...failed.map((row) => `${row.job} 失败（${String(row.error ?? 'unknown').slice(0, 80)}）`),
      ...segmentedJobs,
    ]
    if (degraded) parts.push(`降级${failedShards ? `（${failedShards} 片失败）` : ''}`)
    const text = parts.join(' / ')
    const meta = {
      ok,
      jobs: results.map((row) => ({ job: row.job, ok: row.ok !== false, ...(row.skipped ? { skipped: row.skipped } : {}) })),
      degraded,
      failedShards,
      segmented: results.reduce((n, row) => n + (Number(row.segmented) > 1 ? 1 : 0), 0),
      at: now,
    }
    try {
      ctx.signals?.emit?.({ from: { plugin: 'dream' }, kind: 'event', text, tags: ['dream-result'], meta })
    } catch (error) {
      // 回执发不出去不能拖垮整轮整理；但必须留痕。
      ctx.log({ level: 'warn', msg: 'dream.result-emit-fail', error: String(error?.message ?? error) })
      return null
    }
    return { ok, text, meta }
  }

  /**
   * 跑一轮 dream。
   * 单飞（inFlight）修 live 11-09 的并发双执行：sleep-start 与 dream 排程可同时到达，
   * 旧实现各自检查 alreadyRan 都看不到对方，于是 events/cleanup 各跑两遍。
   * 信号触发撞上在飞回合直接返回 skipped:'in-flight'；手动/强制跑则等上一轮结束再走
   * （那时成功账本已在，自然会跳过已完成的 job）。
   */
  async function run({ now = ctx.now(), jobs = DEFAULT_JOBS, force = false, trigger = 'manual' } = {}) {
    const entryDay = dayKey(now, tzOf())
    if (inFlight) {
      if (trigger !== 'manual' && !force) {
        ctx.log({ level: 'info', msg: 'dream.run-skip', reason: 'in-flight', day: entryDay, trigger })
        return { ok: true, day: entryDay, results: [{ job: 'run', ok: true, skipped: 'in-flight' }], skipped: 'in-flight', pruned: 0, receipt: null }
      }
      try { await inFlight } catch { /* 上一轮失败不挡这一轮 */ }
    }
    const task = (async () => {
      // 先按"凌晨算前一天"把运行时刻换成整理对象的时刻；后续所有 job 的 dayKey/dayRange 都跟它走。
      const dreamNow = targetDayInstant(now)
      const day = dayKey(dreamNow, tzOf())
      const results = []
      // 每轮重新计"提过几个疑问"：旧实现从进程启动起累计，5 条之后整晚不再提任何问题。
      askedThisRun.clear()
      for (const name of jobs) {
        const job = JOBS[name]
        if (!job) { results.push({ job: name, ok: false, error: 'unknown-job' }); continue }
        const claim = beginRun(day, name, dreamNow, force)
        if (claim.skip) { results.push({ job: name, ok: true, skipped: claim.skip }); continue }
        try {
          const result = await job({ now: dreamNow, force, attempt: claim.attempt })
          settleRun(day, name, result, dreamNow, claim)
          results.push(result)
        } catch (error) {
          const failed = { job: name, ok: false, error: String(error?.message ?? error) }
          settleRun(day, name, failed, dreamNow, claim)
          results.push(failed)
        }
      }
      const ok = results.every((r) => r.ok !== false)
      // Phase 3 entity 层：每晚 job 结束后做一次幂等同步（纯确定性、不调模型；失败不影响 job 结果）。
      let entitySync = null
      try { entitySync = syncEntities(dreamNow) } catch (error) {
        ctx.log({ level: 'warn', msg: 'dream.entity-sync-fail', error: String(error?.message ?? error).slice(0, 200) })
      }
      // 失败/跳过也落账（成功 job 已各自 recordRun；这里补齐三态，E2 才不会"缺行"）。
      for (const result of results) recordOutcome(day, result, dreamNow)
      const pruned = pruneRuns(dreamNow)
      // 回执只发一次（全 skip 时不发）；runFromSignal 的异常路径在 catch 里补失败回执。
      const receipt = emitDreamResult({ now: dreamNow, results })
      return { ok, day, results, pruned, receipt, targetNow: dreamNow, entitySync }
    })()
    inFlight = task
    try { return await task } finally { if (inFlight === task) inFlight = null }
  }

  /**
   * 由信号触发的跑法：结果必须落日志。
   * 旧实现是 `void run(...)`——job 失败（例如模型插槽没绑）连一行字都不留，
   * 于是"昨晚上没整理"永远查不到原因；promise 被拒时还会变成未处理拒绝。
   */
  function runFromSignal({ now = ctx.now(), reason = 'signal' } = {}) {
    return run({ now, trigger: 'signal' })
      .then((result) => {
        const failed = result.results.filter((row) => row.ok === false)
        ctx.log({
          level: failed.length ? 'warn' : 'info',
          msg: 'dream.run',
          reason,
          day: result.day,
          ok: result.ok,
          jobs: result.results.map((row) => `${row.job}:${row.ok === false ? `fail(${row.error ?? ''})` : row.skipped ? `skip(${row.skipped}${row.rawSources ? ` raw=${row.rawSources.join('|') || '(空)'}` : ''})` : `ok${row.shards ? `(${row.blocks ?? 0}块/${row.shards}片${row.failedShards ? `,${row.failedShards}片失败` : ''})` : ''}${row.degraded ? '!degraded' : ''}`}`).join(','),
        })
        return result
      })
      .catch((error) => {
        const reasonText = String(error?.message ?? error)
        ctx.log({ level: 'warn', msg: 'dream.run-fail', reason, error: reasonText })
        // 整轮异常也要留账：失败行 + time 的失败回执（否则简报只能写"未回传"）。
        const failed = { job: 'run', ok: false, error: reasonText }
        try { recordOutcome(dayKey(now, tzOf()), failed, now) } catch { /* 记账失败不拖垮 */ }
        emitDreamResult({ now, results: [failed] })
        return { ok: false, day: null, results: [failed], error: reasonText }
      })
  }

  // 与时间模块的轻耦合：睡觉开始时收到事件就跑一轮（rhythm 是旧兼容，可以没有）。
  // sleep 的 dream:false 只休息，不整理记忆。
  try {
    const off = ctx.signals.on({ kind: 'event', tags: ['sleep'] }, (signal) => {
      if (signal.text !== 'sleep-start') return
      if (signal.meta?.dream === false) return
      runFromSignal({ now: signal.createdAt ?? ctx.now(), reason: 'sleep-start' })
    })
    ctx.onDispose(off)
  } catch { /* 没有信号服务时退化为纯手动 */ }

  // 产品默认不再自动排“每晚 23:00 必做”的 dream；只有显式 scheduleEnabled:true 才重建旧行为。
  // 已有旧的 dream:nightly 在 scheduleEnabled=false 时取消，避免机械任务继续跑。
  try {
    const time = ctx.services.get('time')
    if (time?.add) {
      const existing = time.schedules?.().find((s) => s.id === 'dream:nightly')
      if (ctx.config.scheduleEnabled === true) {
        if (!existing) {
          time.add({ id: 'dream:nightly', at: dreamAt, mode: 'wake', kind: 'single', silent: true, tags: ['dream'], message: '' })
        } else if (existing.at !== dreamAt) {
          time.edit('dream:nightly', { at: dreamAt })
        }
      } else if (existing && typeof time.cancel === 'function') {
        time.cancel('dream:nightly')
        ctx.log({ msg: 'dream.schedule.disabled', id: 'dream:nightly' })
      }
    }
  } catch (error) { ctx.log({ level: 'warn', msg: 'dream.schedule', error: String(error?.message ?? error) }) }

  try {
    const off = ctx.signals.on({ kind: 'event', tags: ['dream'] }, (signal) => {
      runFromSignal({ now: signal.createdAt ?? ctx.now(), reason: 'dream-schedule' })
    })
    ctx.onDispose(off)
  } catch { /* 没有信号服务时退化为纯手动 */ }

  ctx.services.provide('dream', { run, runFromSignal, jobs: Object.keys(JOBS), slot, persona })
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








