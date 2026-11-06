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

  const persona = String(ctx.config.persona ?? loadPersona(ctx) ?? '')

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
    return { text, data: { times, parts: parts.length, day, omittedLines: Number(parts[0]?.data?.omittedLines ?? 0), totalLines: Number(parts[0]?.data?.totalLines ?? 0) } }
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

  function runKey(day, job) { return `run:${day}:${job}` }
  function alreadyRan(day, job) {
    const rows = memory.query({ namespace: 'dream-run', kind: 'run', key: runKey(day, job), limit: 1 })
    return rows.length > 0
  }
  function recordRun(day, job, detail, now) {
    memory.put({ namespace: 'dream-run', kind: 'run', key: runKey(day, job), text: `${day} ${job}`, data: detail, now })
  }
  /**
   * 可观测修复（E2 质量门）：失败/跳过也落 dream-run，让"没跑"和"跑失败"可区分。
   * 仍用 kind:'run'（mc-quality 的现状解析器按 `:(\w+)$` 取 job、按 data.error 计 failures），
   * 但 key 用 `fail:`/`skip:` 前缀，不占用 alreadyRan 的成功 key（不会阻止第二天重跑）。
   * 判定口径（写进 docs/MEMORY-BLOCK-QUALITY.md §4）：
   *   run:<day>:<job>  → 成功（既有）
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
    const cleaned = []
    for (const r of rows) {
      const at = timeOfRow(r)
      if (at && (at < startMs || at >= endMs)) continue
      const text = stripStructured(r.text)
      if (!text) continue
      cleaned.push({ at, sender: String(r.sender ?? '').slice(0, 24), text })
    }
    if (!cleaned.length) return { job: 'wash', skipped: 'nothing-clean' }

    // day log 是后续 events/people/lexicon 的原材料：单行截断 + 总量预算，
    // 超预算时保留头尾、中间显式省略；**编号仍是原话的绝对序号**（evidence 映射不丢）。
    const renderLine = (x, i) => `[${i + 1}] ${hhmm(x.at || now)}${x.sender ? ` ${x.sender}` : ''}：${clipText(x.text)}`
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
          // times 用完整数组（绝对行号 id-1 索引），每段都存一份，拼接后 evidence 映射不变。
          times: cleaned.map((x) => x.at),
        },
        now,
      })
    })
    recordRun(day, 'wash', { lines: lines.length, totalLines: cleaned.length, omittedLines, chars: total, parts: segments.length }, now)
    return {
      job: 'wash', ok: true, lines: lines.length, totalLines: cleaned.length,
      omittedLines, chars: total, parts: segments.length, degraded: omittedLines > 0 || segments.length > 1,
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
    const material = dayLog
      ? dayLog.text.split('\n')
      : notes
        .slice()
        .sort((a, b) => timeOf(a) - timeOf(b))
        .map((n) => `[${n.id}] ${hhmm(timeOf(n))} ${clipText(n.text)}`)
    const hint = dayLog ? '\n\n（上面每行开头的编号就是 evidence 要用的编号）' : ''
    const { shards, omitted: omittedShards, segments: experienceSegments } = shardByExperience(material, { gapMin: segmentGapMin })
    if (omittedShards) ctx.log({ level: 'warn', msg: 'dream.events-shards-capped', omittedShards, kept: shards.length })
    const instruction = [
      '把今天的笔记整理成若干"事件块"，不要写成日记或总结报告。',
      '块里可以是你做过的事，也可以是你今天看到/刷到/学到的东西（写成“我刷到一个讲…”）。',
      '时间优先：先按"一段经历"分组——时间挨得很近、连续发生的笔记算同一次经历；',
      '再在这一次经历内部按话题合并。同一次连续经历里的碎片要放进同一块，不要拆开。',
      '不同时间段的事不要硬并成一块；确实只是同一件事的，才跨时间合并并写成一块。',
      '每块输出一个对象：{"summary": "一行脱敏摘要（不含 QQ 号）", "body": "第一人称正文", "people": ["QQ号"], "tags": ["短标签"], "evidence": [id]}',
      'evidence 必须是上面真实存在的编号；不能编。没有出处的话不要写进块。',
      '只输出 JSON 数组，不要解释。没有值得记的就输出 []。',
    ].join('\n')
    const blocks = []
    const shardResults = []
    for (let i = 0; i < shards.length; i += 1) {
      const payload = `${shards[i].join('\n')}${hint}`
      try {
        const raw = await ask({ instruction, payload, where: `events#${i + 1}` })
        const parsed = parseBlocks(raw)
        blocks.push(...parsed)
        shardResults.push({ index: i + 1, ok: true, blocks: parsed.length, chars: payload.length })
      } catch (error) {
        // 某片失败不拖垮整夜：记录、继续下一片，已成功片的块照常落库。
        const reason = String(error?.message ?? error)
        shardResults.push({ index: i + 1, ok: false, error: reason, chars: payload.length })
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
    const dayLines = dayLog ? dayLogIndex(dayLog) : null
    for (const block of blocks) {
      const summaryRaw = String(block?.summary ?? '').trim()
      if (!summaryRaw) continue
      const summary = summaryRaw.slice(0, maxBlockSummary)
      const baseKey = `evt:${day}:${hash(summary)}`
      const evidence = dayLog
        ? (Array.isArray(block?.evidence) ? block.evidence : [])
          .map((id) => Number(id))
          .filter((id) => Number.isFinite(id) && dayLines.has(id))
          .map((id) => dayEvidence(dayLines, id))
        : validEvidence(block?.evidence, notes)
      const previous = memory.query({ namespace: 'event', kind: 'block', key: baseKey, limit: 1 })[0]
      // 重跑时模型偶尔给不出出处：宁可保留旧块，也不要把已有证据覆盖成空
      if (!evidence.length && previous) continue
      // 同一 summary 重跑：新证据优先，但旧证据不丢（旧行号/正文快照仍可追）。
      const mergedEvidence = [...evidence]
      for (const old of previous?.data?.evidence ?? []) {
        if (!mergedEvidence.some((e) => e.type === old.type && Number(e.id) === Number(old.id))) mergedEvidence.push(old)
      }
      const times = (() => {
        if (dayLines) {
          return mergedEvidence
            .map((e) => Number(e.at) || Number(dayLines.get(Number(e.id))?.at) || 0)
            .filter(Boolean)
        }
        return mergedEvidence
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
        const partEvidence = index === 0 ? mergedEvidence : (previousPart?.data?.evidence ?? mergedEvidence)
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
            people: (block?.people ?? []).map(String),
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
        if (index === 0 && !mergedEvidence.length) {
          raiseQuestion({
            text: `「${summary.slice(0, 40)}」没有出处，以后问一下。`,
            about: { namespace: 'event', key: baseKey },
            raisedBy: 'events',
          })
        }
        written.push(created.id)
      }
    }
    // 只标"真的被某块引用过"的 note：部分覆盖时，没被引用到的继续待消化。
    const cited = new Set()
    for (const id of written) {
      const block = memory.query({ namespace: 'event', kind: 'block', id, limit: 1 })[0]
      for (const e of block?.data?.evidence ?? []) cited.add(Number(e.id))
    }
    const covered = notes.filter((n) => cited.has(Number(n.id)))
    if (dayLog) {
      // 用当天原话成块后，wash 的笔记已被原话覆盖，不再作为待整理项
      markNotes(notes.filter((n) => n.data?.consolidated !== true), now)
    } else if (covered.length) markNotes(covered, now)
    recordRun(day, 'events', { blocks: written.length, notes: notes.length, deferred: notes.length - covered.length, shards: shards.length, failedShards: shardResults.filter((row) => !row.ok).length, omittedShards, payloadChars: shardResults.reduce((n, row) => n + row.chars, 0) }, now)
    return {
      job: 'events', ok: true, blocks: written.length, notes: notes.length,
      deferred: dayLog ? 0 : notes.length - covered.length,
      shards: shards.length,
      failedShards: shardResults.filter((row) => !row.ok).length,
      omittedShards,
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
            'who 用原话里的称呼，不要合并不同的人；没有就输出 []。只输出 JSON。',
          ].join('\n'),
          payload: `${dayLog.text}\n\n（source_id 用上面每行开头的编号）`,
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
    }
    // 人物档案跨天：只要还没被消化，不管哪天的笔记都带上。
    const notes = consolidated(memory.query({ namespace: 'person', kind: 'note', limit: 500, order: 'desc' }))
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
    let degradedPeople = false
    for (const [qq, list] of byQq) {
      const [subjectKind, subjectValue] = (() => { const s = list[0]?.__subject ?? { kind: 'qq', value: qq }; return [s.kind, s.value] })()
      const key = subjectKind === 'qq' ? `person:${subjectValue}` : `person:${subjectKind}:${subjectValue}`
      const existing = memory.query({ namespace: 'person', kind: 'block', key, limit: 1 })[0]
      // 人物档案要有"全局认识"：把过去提到过这个人的事件块也带上，
      // 否则每天只能拿到一句话，写出来的档案永远认不出是谁。
      const matchesSubject = (entry) => {
        const subject = entry?.subject ?? (entry?.qq ? { kind: 'qq', value: String(entry.qq) } : null)
        return Boolean(subject?.value) && String(subject.value) === String(subjectValue)
          && String(subject.kind ?? 'qq') === String(subjectKind)
      }
      const relatedEvents = memory.query({ namespace: 'event', kind: 'block', limit: 500, order: 'desc' })
        .filter((b) => Array.isArray(b.data?.people) && b.data.people.some((p) => String(p) === String(subjectValue)))
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
      const context = clipPayload([
        `内部编号（不要写进档案）：${qq}`,
        existing ? `现有档案：\n${clipText(existing.text, 1200)}\n${clipText(existing.data?.narrative ?? '', 1200)}` : '现有档案：无',
        relatedEvents.length ? `以前提到过 TA 的事：\n${relatedEvents.map((b) => `· ${clipText(b.text, 200)}`).join('\n')}` : '',
        pastNotes.length ? renderNotes(pastNotes, '以前记下的') : '',
        renderNotes(list, '今天记下的', 120),
      ].filter(Boolean).join('\n\n'), 'people-materials')
      if (context.length >= maxPayloadChars - 32) degradedPeople = true

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
          ].join('\n'),
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
    const subjectsOf = (n) => {
      const subject = n.data?.subject ?? (n.data?.qq ? { kind: 'qq', value: String(n.data.qq) } : null)
      return subject?.value ? subject : null
    }
    const blockKeys = new Set(
      notes.map(subjectsOf).filter(Boolean)
        .map((s) => (s.kind === 'qq' ? `person:${s.value}` : `person:${s.kind}:${s.value}`)),
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
    recordRun(day, 'people', { blocks: written.length, people: byQq.size, skipped: skippedPeople.length, degraded: degradedPeople }, now)
    return { job: 'people', ok: true, blocks: written.length, people: byQq.size, skipped: skippedPeople.length, degraded: degradedPeople }
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
    for (const ns of ['event', 'person', 'slang']) {
      const hit = memory.query({ namespace: ns, kind: 'block', key: wanted, limit: 1 })[0]
      if (hit) return hit
    }
    return null
  }

  async function jobCleanup({ now, force = false }) {
    const day = dayKey(now, tzOf())
    if (!force && alreadyRan(day, 'cleanup')) return { job: 'cleanup', skipped: 'already-ran' }

    const pendingResolves = memory.query({ namespace: 'resolve', kind: 'note', limit: 100, order: 'desc' })
      .filter((n) => n.data?.consumed !== true)

    const blocks = []
    for (const ns of ['event', 'person', 'slang']) {
      for (const b of memory.query({ namespace: ns, kind: 'block', limit: 500, order: 'desc' })) {
        if (b.data?.superseded === true) continue
        blocks.push({ ns, key: b.key, id: b.id, text: b.text, people: (b.data?.people ?? []).map(String), body: String(b.data?.body ?? b.data?.profile ?? b.data?.narrative ?? '').slice(0, 400) })
      }
    }
    if (blocks.length < 2 && !pendingResolves.length) return { job: 'cleanup', skipped: 'nothing-to-do' }

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
          '· 允许跨天合并：两个块讲的是同一件事（哪怕隔了几天），合并成一块，保留双方细节。',
          '· 目标是去重与消除矛盾，不是把所有块整理成一个样子。',
          '没什么可整理就输出 {} 。只输出 JSON。',
        ].join('\n'),
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

  async function jobLexicon({ now, force = false }) {
    const day = dayKey(now, tzOf())
    if (!force && alreadyRan(day, 'lexicon')) return { job: 'lexicon', skipped: 'already-ran' }
    // slang 已并入 lexicon：采集范围包括旧的 slang 笔记
    // 采集要看原话，不是看摘要：短梗（如「6」、「彳亠」）根本不会变成 note
    let sourceLines = []
    try {
      // 优先用当天洗好的干净原话（可能分多段）；没有才退回原文来源
      const dayLog = readDayLog(dayKey(now, tzOf()))
      if (dayLog?.text) sourceLines = dayLog.text.split('\n')
      else {
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

    const known = (ctx.services.get('lexicon').query?.() ?? []).map((x) => x.data?.term).filter(Boolean).slice(0, 50)
    let items = []
    try {
      // 参考旧实现：逐条 <message> 包裹 + 明确规则 + source_id
      const chatLines = (sourceLines.length ? sourceLines : notes.map((n) => n.text))
        .slice(0, 200)
        .map((line, i) => `<message source_id="${i + 1}">${String(line).replace(/[<>]/g, ' ').slice(0, 300)}</message>`)
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
        '[{"term":"词","meaning":"只有在你完全确定时才写，否则留空","reason":"unknown|shifted|in-group|frequent"}]',
        'meaning 绝不能猜。没有就输出 []。只输出 JSON。',
            ].join('\n')
      const raw = await ctx.slots.call(slot, {
        messages: [
          { role: 'system', content: rules },
          { role: 'user', content: chatLines.slice(0, 8000) },
        ],
        maxTokens: 900,
      })
      items = parseBlocks(raw)
    } catch (error) {
      return { job: 'lexicon', ok: false, error: String(error?.message ?? error) }
    }

    // 去重：同一个词只建一次档，也只提一次待办
    const seenTerms = new Set((lexicon.query?.() ?? []).map((r) => String(r.data?.term ?? '')))
    let learned = 0
    for (const item of items) {
      const term = String(item?.term ?? item?.content ?? '').trim()
      if (!term || seenTerms.has(term)) continue
      const res = lexicon.upsert({
        term,
        conv: String(item?.conv ?? '').trim() || 'web',
        meaning: String(item?.meaning ?? '').trim(),
        tags: [item?.reason === 'shifted' ? '新义' : item?.reason === 'in-group' ? '本群' : item?.reason === 'frequent' ? '高频' : '待查'],
      })
      if (res?.ok) { learned += 1; seenTerms.add(term) }
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
    const ok = failed.length === 0
    const parts = [
      ...executed.map((row) => `${row.job} ${jobDetail(row)}`),
      ...failed.map((row) => `${row.job} 失败（${String(row.error ?? 'unknown').slice(0, 80)}）`),
    ]
    if (degraded) parts.push(`分片降级${failedShards ? `（${failedShards} 片失败）` : ''}`)
    const text = parts.join(' / ')
    const meta = {
      ok,
      jobs: results.map((row) => ({ job: row.job, ok: row.ok !== false, ...(row.skipped ? { skipped: row.skipped } : {}) })),
      degraded,
      failedShards,
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

  async function run({ now = ctx.now(), jobs = DEFAULT_JOBS, force = false } = {}) {
    const day = dayKey(now, tzOf())
    const results = []
    // 每轮重新计"提过几个疑问"：旧实现从进程启动起累计，5 条之后整晚不再提任何问题。
    askedThisRun.clear()
    for (const name of jobs) {
      const job = JOBS[name]
      if (!job) { results.push({ job: name, ok: false, error: 'unknown-job' }); continue }
      try { results.push(await job({ now, force })) } catch (error) { results.push({ job: name, ok: false, error: String(error?.message ?? error) }) }
    }
    const ok = results.every((r) => r.ok !== false)
    // 失败/跳过也落账（成功 job 已各自 recordRun；这里补齐三态，E2 才不会"缺行"）。
    for (const result of results) recordOutcome(day, result, now)
    const pruned = pruneRuns(now)
    // 回执只发一次（全 skip 时不发）；runFromSignal 的异常路径在 catch 里补失败回执。
    const receipt = emitDreamResult({ now, results })
    return { ok, day, results, pruned, receipt }
  }

  /**
   * 由信号触发的跑法：结果必须落日志。
   * 旧实现是 `void run(...)`——job 失败（例如模型插槽没绑）连一行字都不留，
   * 于是"昨晚上没整理"永远查不到原因；promise 被拒时还会变成未处理拒绝。
   */
  function runFromSignal({ now = ctx.now(), reason = 'signal' } = {}) {
    return run({ now })
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

  // 与时间模块的轻耦合：睡觉开始时收到事件就跑一轮（rhythm 是旧兼容，可以没有）
  try {
    const off = ctx.signals.on({ kind: 'event', tags: ['sleep'] }, (signal) => {
      if (signal.text === 'sleep-start') runFromSignal({ now: signal.createdAt ?? ctx.now(), reason: 'sleep-start' })
    })
    ctx.onDispose(off)
  } catch { /* 没有信号服务时退化为纯手动 */ }

  // 每晚做梦不是 time 里的硬编码分支：它只是 time 日历里的一条 silent 安排，
  // 到点由 time 发 schedule-start（tags 含 dream），dream 订阅后并行跑自己的流水线。
  try {
    const time = ctx.services.get('time')
    if (time?.add) {
      const existing = time.schedules?.().find((s) => s.id === 'dream:nightly')
      if (!existing) {
        time.add({ id: 'dream:nightly', at: dreamAt, mode: 'wake', kind: 'single', silent: true, tags: ['dream'], message: '' })
      } else if (existing.at !== dreamAt) {
        time.edit('dream:nightly', { at: dreamAt })
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
