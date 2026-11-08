// 时间模块：会话的唯一时钟、唯一唤醒者、唯一纵向拦截层。
//
// 契约见 docs/TIME.md（状态机、四问、控制后门、验收场景都在那份文件里）。
// 本文件只回答四件事：
//   1. 我什么时候被唤醒 —— schedules：single（一次性）/ daily（HH:mm）/ weekly（周一 07:30）/
//      倒计时（in），到点发 wake；跨重启用 fired 去重；倒计时与长日程会被 pause 冻结。
//   2. 醒了要干什么 —— 醒来消息、备注、标签、静音；睡眠/暂停/静音期间外部信号进有界积压，
//      醒来按"结束语 + 积压摘要"成批释放，失败不丢、过期有计数。
//   3. 接下来如何行动 —— goals：time_arrange {mode:'goal'} 或 goal_add；turn-end 续推，
//      支持 turnLimit / until / 续推上限；time_cancel 统一收尾并释放 focus 租约。
//   4. 长期日程 —— 每天/每周重复、编辑、取消、清单（相对时间、下次触发、可读 id）。
//
// 拦截：signals 的 gate 是唯一纵向拦截层。放行规则只有三类：
//   · time 自己的信号（闹钟/结束语/目标续推）——静音不关自己的闹钟（FOCUS.md §1.6）；
//   · 睡眠白名单 allow；
//   · 静音锁 lock 的白名单 + 独立紧急配额（tags alarm/safety/emergency）。
// 事件总线（to:'plugin'）不进人门：它不是给模型的消息，不能被积压成"用户消息"。
//
// 不静默失败：坏状态文件先备份再回落、原子写落盘、tick 重入保护、每次丢弃/漏响/积压溢出
// 都有计数与日志；状态里带 lastTickError / lastPersistError 供控制后门查。
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const name = 'time'

const PHASES = Object.freeze(['awake', 'sleeping', 'paused'])
const DEFAULT_ALLOW = Object.freeze([{ from: 'admin' }])
// quiet span 的默认放行：管理员 + 明确 @ 到她的消息。其它普通消息一律积压。
const DEFAULT_QUIET_ALLOW = Object.freeze([{ from: 'admin' }, { tags: ['mention'] }, { tags: ['at'] }])
const WEEKDAYS_ZH = ['一', '二', '三', '四', '五', '六', '日']
const WEEKDAY_ALIASES = Object.freeze({
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7,
  1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7,
  mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7,
})

/* ───────────────────────── 时区与时间解析 ───────────────────────── */

const formatterCache = new Map()

function dateFormatter(timeZone, withWeekday) {
  const key = `${timeZone ?? ''}|${withWeekday ? 1 : 0}`
  let fmt = formatterCache.get(key)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('zh-CN', {
      ...(timeZone ? { timeZone } : {}),
      year: 'numeric', month: '2-digit', day: '2-digit',
      ...(withWeekday ? { weekday: 'short' } : {}),
      hour: '2-digit', minute: '2-digit', hour12: false,
    })
    formatterCache.set(key, fmt)
  }
  return fmt
}

/** 日历字段（在指定时区里）。纯本地时间用 timeZone=null（宿主时区）。 */
function partsOf(at, timeZone = null) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    ...(timeZone ? { timeZone } : {}),
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
  const out = {}
  for (const part of fmt.formatToParts(new Date(at))) if (part.type !== 'literal') out[part.type] = part.value
  const hour = Number(out.hour) === 24 ? 0 : Number(out.hour)
  return { y: Number(out.year), m: Number(out.month), d: Number(out.day), h: hour, min: Number(out.minute), s: Number(out.second) }
}

/** 时区里的日历时间 → epoch 毫秒（两轮迭代覆盖 DST）。 */
function zonedEpoch(fields, timeZone = null) {
  // 无时区配置时按宿主本地时间解释（Date 构造器本来就吃本地字段）。
  if (!timeZone) return new Date(fields.y, fields.m - 1, fields.d, fields.h ?? 0, fields.min ?? 0, fields.s ?? 0).getTime()
  const asUtc = Date.UTC(fields.y, fields.m - 1, fields.d, fields.h ?? 0, fields.min ?? 0, fields.s ?? 0)
  let guess = asUtc
  for (let i = 0; i < 2; i += 1) {
    const p = partsOf(guess, timeZone)
    const local = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s)
    guess = asUtc - (local - guess)
  }
  return guess
}

function pad2(n) { return String(n).padStart(2, '0') }

function dayKey(at, timeZone = null) {
  const p = partsOf(at, timeZone)
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`
}

function stampAt(at, timeZone = null) {
  return dateFormatter(timeZone, true).format(new Date(at))
}

function timeOnly(at, timeZone = null) {
  const p = partsOf(at, timeZone)
  return `${pad2(p.h)}:${pad2(p.min)}`
}

/**
 * 简报/回执里的长文本截断（用户 2026-11-06 实测反馈）：不要切在半词/半句上。
 * 优先在句子/分隔符边界断，再补省略号；找不到合适边界才硬切。
 */
function clipBriefText(value, max = 100) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const boundary = Math.max(
    cut.lastIndexOf('。'), cut.lastIndexOf('；'), cut.lastIndexOf('，'), cut.lastIndexOf('！'), cut.lastIndexOf('？'),
    cut.lastIndexOf(' / '), cut.lastIndexOf('/'), cut.lastIndexOf(' '),
  )
  const head = boundary > Math.floor(max * 0.5) ? cut.slice(0, boundary + 1).trim() : cut.slice(0, max - 1).trimEnd()
  return `${head}…`
}

function addDays(fields, delta) {
  const t = new Date(Date.UTC(fields.y, fields.m - 1, fields.d + delta))
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }
}

/** 指定时区里某天的某个 HH:mm。 */
function pointOnDay(fields, hour, minute, timeZone) {
  return zonedEpoch({ y: fields.y, m: fields.m, d: fields.d, h: hour, min: minute }, timeZone)
}

function isoWeekday(at, timeZone = null) {
  const p = partsOf(at, timeZone)
  const dow = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() // 0=周日
  return dow === 0 ? 7 : dow
}

function weekdayNumber(token) {
  let key = String(token ?? '').trim().toLowerCase()
  while (/^(每|周|星期)/.test(key)) key = key.replace(/^(每|周|星期)/, '')
  return WEEKDAY_ALIASES[key] ?? null
}

function fmtDuration(ms) {
  const totalMin = Math.max(0, Math.round(Number(ms) / 60_000))
  if (totalMin < 60) return `${Math.max(1, totalMin)} 分钟`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`
}

function fmtRelative(at, now) {
  const diff = at - now
  const abs = Math.abs(diff)
  const text = fmtDuration(abs)
  return diff >= 0 ? `还有 ${text}` : `已过 ${text}`
}

function validHourMinute(hour, minute) {
  return Number.isInteger(hour) && Number.isInteger(minute) && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59
}

function parseWeekly(raw) {
  const tokens = String(raw ?? '').trim().split(/\s+/).filter(Boolean)
  if (tokens.length < 2) return null
  const timeToken = tokens[tokens.length - 1]
  const hm = /^(\d{1,2}):(\d{2})$/.exec(timeToken)
  if (!hm) return null
  const weekdays = []
  for (const chunk of tokens.slice(0, -1)) {
    for (const token of chunk.split(/[,，、/]+/).filter(Boolean)) {
      const n = weekdayNumber(token)
      if (!n) return null
      if (!weekdays.includes(n)) weekdays.push(n)
    }
  }
  const hour = Number(hm[1])
  const minute = Number(hm[2])
  if (!weekdays.length || !validHourMinute(hour, minute)) return null
  return { kind: 'weekly', weekdays: weekdays.sort((a, b) => a - b), hour, minute }
}

/**
 * at 语法：
 *   'now'                → 立刻（下一个 tick）
 *   'HH:mm'              → 每天
 *   '周一 07:30' / 'mon,wed 07:30' / '一、三 07:30' → 每周
 *   'YYYY-MM-DD'         → 那一天 00:00（配置时区）
 *   ISO 日期时间          → 一次性
 */
function parseAt(value, now = Date.now(), timeZone = null) {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  if (raw === 'now') return { kind: 'once', at: now }
  const hm = /^(\d{1,2}):(\d{2})$/.exec(raw)
  if (hm) {
    const hour = Number(hm[1])
    const minute = Number(hm[2])
    if (!validHourMinute(hour, minute)) throw new Error(`at 的时刻不合法（HH:mm 里 0–23 / 0–59）：${raw}`)
    return { kind: 'daily', hour, minute }
  }
  const weekly = parseWeekly(raw)
  if (weekly) return weekly
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
  if (dateOnly) {
    const at = zonedEpoch({ y: Number(dateOnly[1]), m: Number(dateOnly[2]), d: Number(dateOnly[3]), h: 0, min: 0 }, timeZone)
    if (!Number.isFinite(at)) throw new Error(`at 的日期不合法：${raw}`)
    return { kind: 'once', at }
  }
  const iso = Date.parse(raw)
  if (Number.isFinite(iso)) return { kind: 'once', at: iso }
  throw new Error(`at 格式应为 HH:mm、周一 HH:mm、ISO 或 now：${raw}`)
}

/* ── 日历层（v1）：date / endDate / allDay / wake / repeat(every,until,count) / skipDates ── */

const CAL_DAY_MS = 86_400_000

function parseCalendarDate(raw, timeZone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw ?? '').trim())
  if (!m) throw new Error(`date 格式应为 YYYY-MM-DD：${raw}`)
  const fields = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }
  const at = zonedEpoch({ ...fields, h: 0, min: 0 }, timeZone)
  if (!Number.isFinite(at)) throw new Error(`date 不合法：${raw}`)
  return { fields, at, key: `${m[1]}-${m[2]}-${m[3]}` }
}

function endOfCalendarDate(key, timeZone) {
  const d = parseCalendarDate(key, timeZone)
  return zonedEpoch({ ...d.fields, h: 23, min: 59, s: 59 }, timeZone)
}

function parseRepeatEvery(raw) {
  const m = /^(\d+)\s*(d|w|mo|y|天|周|月|年)$/i.exec(String(raw ?? '').trim())
  if (!m) throw new Error(`repeat.every 格式应为 2d / 2w / 1mo / 1y：${raw}`)
  const n = Math.max(1, Number(m[1]))
  const unitRaw = m[2].toLowerCase()
  const unit = unitRaw === 'w' || unitRaw === '周' ? 'w'
    : unitRaw === 'mo' || unitRaw === '月' ? 'mo'
      : unitRaw === 'y' || unitRaw === '年' ? 'y' : 'd'
  return { n, unit, intervalMs: unit === 'd' || unit === 'w' ? n * (unit === 'w' ? 7 : 1) * CAL_DAY_MS : 0 }
}

function daysInCalendarMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/** 按月/年推进；不存在的日期（31 号遇到小月、2/29 遇平年）跳过该 occurrence。 */
function addCalendarMonths(fields, months, timeZone) {
  const total = (fields.y * 12 + (fields.m - 1)) + months
  const y = Math.floor(total / 12)
  const m = (total % 12 + 12) % 12 + 1
  if (fields.d > daysInCalendarMonth(y, m)) return null
  return zonedEpoch({ y, m, d: fields.d, h: fields.h ?? 0, min: fields.min ?? 0 }, timeZone)
}

function normalizeRepeatInput(input) {
  if (input == null) return null
  const raw = typeof input === 'string' ? { every: input } : input
  if (!raw || typeof raw !== 'object') throw new Error('repeat 应为 {every,until?,count?}')
  if (raw.every == null) throw new Error('repeat 需要 every（如 "2d" / "2w" / "1mo" / "1y"）')
  return {
    every: String(raw.every),
    until: raw.until == null ? null : String(raw.until),
    count: raw.count == null ? null : Math.max(1, Number(raw.count) || 1),
  }
}

function normalizeSkipDates(input) {
  if (!Array.isArray(input)) return []
  return [...new Set(input.map((x) => String(x).trim()).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)))].sort()
}

function buildCalendarParsed(schedule, timeZone) {
  const date = parseCalendarDate(schedule.date, timeZone)
  const tm = schedule.time == null ? null : /^(\d{1,2}):(\d{2})$/.exec(String(schedule.time))
  const hour = tm ? Number(tm[1]) : 0
  const minute = tm ? Number(tm[2]) : 0
  const startAt = zonedEpoch({ ...date.fields, h: hour, min: minute }, timeZone)
  const repeat = schedule.repeat ? normalizeRepeatInput(schedule.repeat) : null
  if (!repeat) return { kind: 'once', at: startAt, allDay: Boolean(schedule.allDay) }
  const every = parseRepeatEvery(repeat.every)
  const weekdays = every.unit === 'w' && Array.isArray(schedule.weekdays) && schedule.weekdays.length
    ? schedule.weekdays.map(Number).filter((n) => n >= 1 && n <= 7).sort((a, b) => a - b)
    : null
  return {
    kind: 'calendar',
    startAt,
    intervalMs: every.intervalMs,
    everyN: every.n,
    everyUnit: every.unit,
    weekdays,
    hour,
    minute,
    allDay: Boolean(schedule.allDay),
    wake: schedule.wake !== false,
    untilAt: repeat.until ? endOfCalendarDate(/^\d{4}-\d{2}-\d{2}$/.test(repeat.until) ? repeat.until : dayKey(Date.parse(repeat.until), timeZone), timeZone) : null,
    count: repeat.count,
    skipDates: new Set(normalizeSkipDates(schedule.skipDates)),
  }
}

/** 生成 [from,to] 内的日历 occurrence；skipDates/until/count 都在这里处理。 */
function calendarPoints(parsed, from, to, timeZone, { ignoreSkip = false } = {}) {
  const out = []
  const startAt = Number(parsed.startAt)
  const untilAt = parsed.untilAt == null ? Infinity : Number(parsed.untilAt)
  const count = parsed.count == null ? Infinity : Math.max(1, Number(parsed.count))
  const skip = parsed.skipDates ?? new Set()
  const push = (t) => {
    if (!Number.isFinite(t) || t < startAt || t > untilAt) return false
    if (t >= from && t <= to && (ignoreSkip || !skip.has(dayKey(t, timeZone)))) out.push(t)
    return true
  }
  if (parsed.weekdays && parsed.everyUnit === 'w') {
    const start = partsOf(startAt, timeZone)
    const startDay = Date.UTC(start.y, start.m - 1, start.d)
    let produced = 0
    for (let day = startDay; day <= to && produced < count; day += CAL_DAY_MS) {
      const idx = Math.round((day - startDay) / CAL_DAY_MS)
      const week = Math.floor(idx / 7)
      if (week % parsed.everyN !== 0) continue
      const d = new Date(day)
      const fields = { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }
      const dow = new Date(Date.UTC(fields.y, fields.m - 1, fields.d)).getUTCDay() || 7
      if (!parsed.weekdays.includes(dow)) continue
      const t = pointOnDay(fields, parsed.hour, parsed.minute, timeZone)
      produced += 1
      if (!push(t)) break
    }
  } else if (parsed.everyUnit === 'mo' || parsed.everyUnit === 'y') {
    const start = partsOf(startAt, timeZone)
    const stepMonths = parsed.everyUnit === 'y' ? 12 * parsed.everyN : parsed.everyN
    let produced = 0
    for (let k = 0; k < 5000 && produced < count; k += 1) {
      const t = addCalendarMonths(start, k * stepMonths, timeZone)
      if (t == null) continue // 2/29、31 号遇到小月：标准日历跳过，不计 COUNT
      if (t > untilAt) break
      if (t > to) break
      produced += 1
      if (t < from) continue
      push(t)
    }
  } else {
    for (let k = 0; k < count; k += 1) {
      const t = startAt + k * Number(parsed.intervalMs)
      if (t > to) break
      if (!push(t)) break
    }
  }
  return out.sort((a, b) => a - b)
}

function calendarNext(parsed, now, timeZone) {
  const points = calendarPoints(parsed, now + 1, now + 5 * 366 * CAL_DAY_MS, timeZone)
  return points.length ? points[0] : null
}

function calendarLatest(parsed, now, timeZone) {
  const points = calendarPoints(parsed, parsed.startAt, now, timeZone, { ignoreSkip: true })
  return points.length ? points[points.length - 1] : null
}


/** 时长/倒计时语法：'10m' / '2h' / '1d' / '1h30m' / 数字=分钟。返回毫秒或 null。 */
function parseIn(value) {
  if (value == null) return null
  if (typeof value === 'number') return Math.max(0, value) * 60_000
  const raw = String(value).trim().toLowerCase()
  if (!raw) return null
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Math.round(Number(raw) * 60_000)
  const unitMs = { s: 1000, sec: 1000, 秒: 1000, m: 60_000, min: 60_000, 分钟: 60_000, h: 3_600_000, 小时: 3_600_000, d: 86_400_000, 天: 86_400_000, 日: 86_400_000 }
  let total = 0
  let index = 0
  let matched = 0
  const re = /(\d+(?:\.\d+)?)\s*(s|sec|秒|m|min|分钟|h|小时|d|天|日)/g
  let m
  while ((m = re.exec(raw))) {
    total += Number(m[1]) * unitMs[m[2]]
    index = re.lastIndex
    matched += 1
  }
  if (!matched || raw.slice(index).trim()) return null
  return Math.round(total)
}

function normalizeWeekdays(value) {
  if (value == null) return null
  const out = []
  for (const chunk of [].concat(value)) {
    for (const token of String(chunk).split(/[,，、/\s]+/).filter(Boolean)) {
      const n = weekdayNumber(token)
      if (!n) throw new Error(`weekdays 里的星期不合法：${token}（用 1–7 或 周一/一/mon）`)
      if (!out.includes(n)) out.push(n)
    }
  }
  return out.length ? out.sort((a, b) => a - b) : null
}

/* ───────────────────────── 安排规整 ───────────────────────── */

/** 声明式白名单：任一条规则的全部字段匹配即放行。 */
export function allowMatch(allow, signal) {
  const rules = Array.isArray(allow) ? allow : []
  const text = String(signal?.text ?? '').toLowerCase()
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue
    if (rule.from != null && String(rule.from) !== String(signal.from?.plugin)) continue
    if (rule.kinds != null && ![].concat(rule.kinds).includes(String(signal.kind))) continue
    if (rule.tags != null && !rule.tags.some((tag) => signal.tags?.includes(String(tag)))) continue
    if (rule.any != null && !rule.any.some((word) => text.includes(String(word).toLowerCase()))) continue
    return true
  }
  return false
}

let scheduleSeq = 0
function nextScheduleId() {
  scheduleSeq += 1
  return `s-${Date.now().toString(36)}-${scheduleSeq}`
}

/**
 * 把工具/API 的入参规整成一条安排。
 * 返回的对象里 __parsed 只在内存里用，落盘时会剥掉。
 */
export function normalizeSchedule(input = {}, now = Date.now(), options = {}) {
  const timeZone = options?.timeZone ?? null
  const mode = input.mode === 'goal' ? 'goal' : 'wake'

  const date = input.date != null ? parseCalendarDate(input.date, timeZone) : null
  const endDate = input.endDate != null ? parseCalendarDate(input.endDate, timeZone) : null
  const allDay = input.allDay === true || (date != null && input.at == null)
  const timeMatch = input.at != null ? /^(\d{1,2}):(\d{2})$/.exec(String(input.at).trim()) : null
  let startRaw
  let parsed
  let time = null
  if (date) {
    if (!allDay && !timeMatch) throw new Error('date + at 时 at 应为 HH:mm（要 ISO 时间就直接用 at，不用 date）')
    const hour = timeMatch ? Number(timeMatch[1]) : 0
    const minute = timeMatch ? Number(timeMatch[2]) : 0
    if (timeMatch) time = `${pad2(hour)}:${pad2(minute)}`
    const startAt = zonedEpoch({ ...date.fields, h: hour, min: minute }, timeZone)
    startRaw = new Date(startAt).toISOString()
    parsed = { kind: 'once', at: startAt }
  } else {
    // in 与 at 同给时 at 优先；但 edit 想用 in 改期时会把 at 显式清掉。
    const inMs = parseIn(input.in ?? input.inMinutes ?? null)
    startRaw = input.at != null ? String(input.at) : (inMs != null ? new Date(now + inMs).toISOString() : null)
    if (!startRaw) throw new Error('安排需要 at（HH:mm / 周一 HH:mm / ISO / now）或 in（如 10m / 1d）')
    parsed = parseAt(startRaw, now, timeZone)
  }

  const repeat = normalizeRepeatInput(input.repeat ?? null)
  if (repeat && !date) throw new Error('repeat 需要配合 date 使用（如 date:"2026-11-08"）')

  const weekdays = normalizeWeekdays(input.weekdays ?? input.days ?? null)
  if (weekdays) {
    if (parsed.kind === 'daily') {
      parsed = { kind: 'weekly', weekdays, hour: parsed.hour, minute: parsed.minute }
    } else if (!(date && repeat)) {
      throw new Error('weekdays 需要配合 HH:mm 使用（如 at:"07:30", weekdays:[1,3,5]），或 date+repeat 的每周模式')
    }
  }

  let durationMs = parseIn(input.duration ?? input.durationMin ?? null)
  if (endDate) {
    if (!date) throw new Error('endDate 需要配合 date 使用')
    const endAt = endOfCalendarDate(endDate.key, timeZone)
    const startAt = Number(parsed.at)
    durationMs = Math.max(60_000, endAt - startAt)
  }
  let untilAt = null
  if (input.until != null) {
    const parsedUntil = parseUntil(input.until, now, timeZone)
    if (parsedUntil == null) throw new Error(`until 格式应为 ISO、HH:mm 或 in 式时长：${input.until}`)
    untilAt = parsedUntil
  }
  const kind = input.sleep === true || input.quiet === true || input.kind === 'span' || durationMs != null || untilAt != null ? 'span' : 'single'
  // 睡眠必须有终点；只给 sleep:true 没给时长时默认 3 分钟，和提示词"三分钟后回来"一致。
  if (input.quiet === true && durationMs == null && untilAt == null) throw new Error('quiet 安静安排需要 duration 或 until（要明确结束时间）')
  const durationMin = durationMs != null
    ? Math.max(1, Math.round(durationMs / 60_000))
    : (input.sleep === true && untilAt == null ? 3 : null)

  const turnLimit = input.turnLimit == null ? null : Math.max(1, Number(input.turnLimit) || 1)
  const resumeLimit = input.resumeLimit == null ? null : Math.max(1, Number(input.resumeLimit) || 1)
  const schedule = {
    id: String(input.id ?? nextScheduleId()),
    mode,
    kind,
    at: startRaw,
    date: date ? date.key : null,
    time,
    endDate: endDate ? endDate.key : null,
    allDay,
    wake: input.wake === true ? true : input.wake === false ? false : !allDay,
    weekdays: weekdays ?? (parsed.kind === 'weekly' ? parsed.weekdays : null),
    repeat,
    skipDates: normalizeSkipDates(input.skipDates),
    durationMin,
    until: untilAt,
    message: String(input.message ?? ''),
    // 睡眠与普通唤醒分开说：message 是"醒来时说的话"；startMessage 才是入睡时的提示。
    // 旧 sleep() 后门仍把 message 当入睡提示，所以它显式传 startMessage。
    startMessage: String(input.startMessage ?? ''),
    theme: String(input.theme ?? input.message ?? ''),
    sleep: input.sleep === true,
    quiet: input.quiet === true,
    silent: input.silent === true,
    tags: Array.isArray(input.tags) ? input.tags.map(String).slice(0, 8) : [],
    focus: input.focus == null ? null : String(input.focus),
    allow: Array.isArray(input.allow) ? input.allow : null,
    turnLimit,
    resumeLimit,
  }
  schedule.__parsed = date ? buildCalendarParsed(schedule, timeZone) : parsed
  return schedule
}

/** until 语法：ISO / HH:mm（下一个该时刻）/ in 式时长（从 now 起）。 */
function parseUntil(value, now, timeZone) {
  if (value == null) return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    return value > 1e12 ? value : now + value * 60_000
  }
  const raw = String(value).trim()
  if (!raw) return null
  const rel = parseIn(raw)
  if (rel != null && /^\d/.test(raw) && !/^\d{4}-\d{2}-\d{2}/.test(raw)) return now + rel
  try {
    const parsed = parseAt(raw, now, timeZone)
    if (parsed.kind === 'once') return parsed.at
    return nextOccurrence(parsed, now, timeZone)
  } catch { return null }
}

/** 安排里的解析结果（跨重启后从 at/weekdays 重建）。 */
function parsedOf(schedule, now, timeZone) {
  if (schedule.__parsed) return schedule.__parsed
  if (schedule.date) return buildCalendarParsed(schedule, timeZone)
  let parsed = parseAt(schedule.at, now, timeZone)
  if (Array.isArray(schedule.weekdays) && schedule.weekdays.length && parsed.kind === 'daily') {
    parsed = { kind: 'weekly', weekdays: schedule.weekdays.slice().sort((a, b) => a - b), hour: parsed.hour, minute: parsed.minute }
  }
  return parsed
}

/** 已经到达、且是"最近一次"的触发点（用于 tick 的到点判定）。 */
export function occurrenceAt(parsed, now, timeZone = null) {
  if (!parsed) return null
  if (parsed.kind === 'calendar') return calendarLatest(parsed, now, timeZone)
  if (parsed.kind === 'once') return parsed.at
  if (parsed.kind === 'daily') {
    const p = partsOf(now, timeZone)
    return pointOnDay(p, parsed.hour, parsed.minute, timeZone)
  }
  if (parsed.kind === 'weekly') {
    const p = partsOf(now, timeZone)
    const today = isoWeekday(now, timeZone)
    for (let back = 0; back <= 6; back += 1) {
      const day = addDays(p, -back)
      const dow = new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay()
      const weekday = dow === 0 ? 7 : dow
      if (!parsed.weekdays.includes(weekday)) continue
      const point = pointOnDay(day, parsed.hour, parsed.minute, timeZone)
      if (point <= now || back > 0) return point
      // back===0 且今天还没到点：没有更近的过去触发点，直接返回今天这个未来点（调用方会因 at<point 跳过）
      return point
    }
    return null
  }
  return null
}

/** 下一个未来的触发点（用于清单/世界状态展示）。 */
export function nextOccurrence(parsed, now, timeZone = null) {
  if (!parsed) return null
  if (parsed.kind === 'calendar') return calendarNext(parsed, now, timeZone)
  if (parsed.kind === 'once') return parsed.at > now ? parsed.at : null
  const p = partsOf(now, timeZone)
  if (parsed.kind === 'daily') {
    const today = pointOnDay(p, parsed.hour, parsed.minute, timeZone)
    if (today > now) return today
    return pointOnDay(addDays(p, 1), parsed.hour, parsed.minute, timeZone)
  }
  if (parsed.kind === 'weekly') {
    for (let ahead = 0; ahead <= 7; ahead += 1) {
      const day = addDays(p, ahead)
      const dow = new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay()
      const weekday = dow === 0 ? 7 : dow
      if (!parsed.weekdays.includes(weekday)) continue
      const point = pointOnDay(day, parsed.hour, parsed.minute, timeZone)
      if (point > now) return point
    }
  }
  return null
}

/** 人读的时间描述（清单/世界状态用）。 */
export function describeParsed(parsed) {
  if (!parsed) return '(无法解析)'
  if (parsed.kind === 'calendar') {
    const every = parsed.everyUnit === 'w'
      ? `每 ${parsed.everyN} 周`
      : parsed.everyUnit === 'mo'
        ? `每 ${parsed.everyN} 月`
        : parsed.everyUnit === 'y'
          ? `每 ${parsed.everyN} 年`
          : `每 ${parsed.everyN} 天`
    const time = parsed.allDay ? '全天' : `${pad2(parsed.hour)}:${pad2(parsed.minute)}`
    return `${every} ${time}`
  }
  if (parsed.kind === 'once') return '一次'
  if (parsed.kind === 'daily') return `每天 ${pad2(parsed.hour)}:${pad2(parsed.minute)}`
  const days = parsed.weekdays.map((n) => WEEKDAYS_ZH[n - 1]).join('、')
  return `每周${days} ${pad2(parsed.hour)}:${pad2(parsed.minute)}`
}

/* ───────────────────────── 插件主体 ───────────────────────── */

export function apply(ctx) {
  const timeZone = ctx.config.timeZone == null ? null : String(ctx.config.timeZone)
  const stateFile = ctx.config.stateFile
    ? String(ctx.config.stateFile)
    : path.join(String(ctx.config.root ?? '.'), 'state', 'time.json')
  const tickMs = Math.max(1000, Number(ctx.config.tickMs ?? 15_000))
  const inboxFile = ctx.config.inboxFile ? String(ctx.config.inboxFile) : path.join(path.dirname(stateFile), 'time.inbox.jsonl')
  const outboxFile = ctx.config.outboxFile ? String(ctx.config.outboxFile) : path.join(path.dirname(stateFile), 'time.outbox.jsonl')
  // 可观测事件落盘：插件总线（signals.emit）只到进程内订阅者，外部 supervisor 读不到；
  // time-events.jsonl 给 supervisor/早报一个稳定的文件通道。
  const eventsFile = ctx.config.eventsFile ? String(ctx.config.eventsFile) : path.join(path.dirname(stateFile), 'time-events.jsonl')
  const maxQueue = Math.max(1, Number(ctx.config.maxQueue ?? 500))
  const backlogShow = Math.max(1, Number(ctx.config.backlogShow ?? 20))
  const backlogMaxChars = Math.max(200, Number(ctx.config.backlogMaxChars ?? 3000))
  const catchUpMs = Math.max(0, Number(ctx.config.catchUpMs ?? 15 * 60_000))
  const onceCatchUpMs = Math.max(60_000, Number(ctx.config.onceCatchUpMs ?? 24 * 3_600_000))
  const firedRetentionMs = Math.max(1, Number(ctx.config.firedRetentionDays ?? 8)) * 86_400_000
  const goalMaxResumes = Math.max(1, Number(ctx.config.goalMaxResumes ?? 50))
  const goalMaxAgeMs = Math.max(60_000, Number(ctx.config.goalMaxAgeMs ?? 8 * 3_600_000))
  // 红队 C3：turn-end 续推不能"每回合立刻连发"；同一个 goal 至少间隔这么久才再唤醒一次。
  const goalResumeMinGapSec = Math.max(0, Number(ctx.config.goalResumeMinGapSec ?? 60))
  const maxMuteMs = Math.max(60_000, Number(ctx.config.maxMuteMs ?? 8 * 3_600_000))
  const defaultMuteMin = Math.max(1, Number(ctx.config.defaultMuteMin ?? 30))
  const emergencyQuotaDefault = Math.max(0, Number(ctx.config.emergencyQuota ?? 0))
  const emergencyTags = (Array.isArray(ctx.config.emergencyTags) ? ctx.config.emergencyTags : ['alarm', 'safety', 'emergency']).map(String)
  const emergencyFrom = Array.isArray(ctx.config.emergencyFrom) ? ctx.config.emergencyFrom.map(String) : null
  const listLimit = Math.max(1, Number(ctx.config.listLimit ?? 20))
  // 清醒节拍（awake heartbeat）：**默认关闭（opt-in）**。
  // 历史设计用外部定时注入"你醒着，该自检了"，实际会把空闲回合反复打扰；
  // 唤醒频率应由模型自己用闹钟/时间安排（time_arrange）主动设定，而不是外部定时器。
  // 需要长跑实验时显式 awakeTick.enabled=true（E2 lab 仍显式开启）。
  const awakeCfg = ctx.config.awakeTick && typeof ctx.config.awakeTick === 'object' ? ctx.config.awakeTick : {}
  const awakeTickEnabled = awakeCfg.enabled === true
  // immediate：玩游戏的快节奏模式（用户要求"无等待，除非 agent 自愿等待"）。
  // turn-end 后 minIdleSec(~1s) 就自检；连续 N 次没有任何外部信号/任务事件后
  // 退避到 backoffSec，事件一到立刻恢复 immediate。
  const awakeImmediate = String(awakeCfg.mode ?? 'normal').toLowerCase() === 'immediate'
  const awakeMinIdleSec = Math.max(0.2, Number(awakeCfg.minIdleSec ?? 1))
  const awakeIdleSec = awakeImmediate
    ? Math.max(0.2, Number(awakeCfg.idleSec ?? awakeMinIdleSec))
    : Math.max(15, Number(awakeCfg.idleSec ?? 120))
  const awakeArmDelaySec = awakeImmediate ? Math.max(0.2, awakeMinIdleSec) : awakeIdleSec
  const awakeMaxPerHour = awakeImmediate
    ? Math.max(1, Number(awakeCfg.maxPerHour ?? 3600))
    : Math.max(1, Number(awakeCfg.maxPerHour ?? 60))
  const awakeBackoffAfter = Math.max(1, Number(awakeCfg.immediateBackoffAfter ?? 20))
  const awakeBackoffSec = Math.max(5, Number(awakeCfg.backoffSec ?? 30))
  const awakeOverdueSec = awakeImmediate ? Math.max(10, Number(awakeCfg.overdueSec ?? 10)) : awakeIdleSec * 1.5
  const awakeTimerEnabled = awakeImmediate && awakeCfg.timer !== false
  const awakeRetrySec = Math.max(5, Number(awakeCfg.retrySec ?? 30))
  const awakeDuringFocus = awakeCfg.duringFocus !== false
  const awakeCappedSec = Math.max(60, Number(awakeCfg.cappedSec ?? 600))
  // 全局兜底心跳（heartbeat v2）：模型只设"活跃度频率"，不设间隔。
  // 基线 f=1 → 每 10–20 分钟随机跳一次；实际间隔 = uniform(baseMin, baseMax) / f。
  // 频率 clamp 后永远存在（不会完全关掉），模型只能把间隔拉长。
  const heartbeatCfg = ctx.config.heartbeat && typeof ctx.config.heartbeat === 'object' ? ctx.config.heartbeat : {}
  const heartbeatBaseMinSec = Math.max(60, Number(heartbeatCfg.baseMinSec ?? 10 * 60))
  const heartbeatBaseMaxSec = Math.max(heartbeatBaseMinSec, Number(heartbeatCfg.baseMaxSec ?? 20 * 60))
  const heartbeatMinFrequency = Math.max(0.001, Math.min(1, Number(heartbeatCfg.minFrequency ?? 0.01)))
  const heartbeatMaxFrequency = Math.max(heartbeatMinFrequency, Math.min(1, Number(heartbeatCfg.maxFrequency ?? 1)))
  const clampHeartbeatFrequency = (value, fallback = 0.2) => {
    const n = Number(value)
    const base = Number.isFinite(n) ? n : fallback
    return Math.min(heartbeatMaxFrequency, Math.max(heartbeatMinFrequency, base))
  }
  const heartbeatDefaultFrequency = clampHeartbeatFrequency(heartbeatCfg.frequency ?? 0.2)
  const awakeCappedShortWindowSec = Math.max(0, Number(awakeCfg.cappedShortWindowSec ?? 1800))
  const awakeCappedShortMax = Math.max(0, Number(awakeCfg.cappedShortMax ?? 3))
  // B：渐进式唤醒（compactWake）。lab-only，默认关；只压"唤醒提示的 orientation"，
  // payload（未读/积压/危险/sleep brief）原样保留。用户已批 fullEvery=20。
  const compactWakeCfg = ctx.config.compactWake && typeof ctx.config.compactWake === 'object' ? ctx.config.compactWake : {}
  const compactWakeEnabled = compactWakeCfg.enabled === true
  const compactWakeAfter = Math.max(1, Number(compactWakeCfg.after ?? 1))
  const compactWakeMaxChars = Math.max(120, Number(compactWakeCfg.maxChars ?? 400))
  const compactWakeFullEvery = Math.max(0, Number(compactWakeCfg.fullEvery ?? 20))
  const compactWakeAllowPayload = compactWakeCfg.allowPayload !== false
  // 睡眠边界：入睡瞬间可能还有在飞回合（"把手里这轮收个尾"）。允许它自然结束，
  // 超过 sleepGraceSec 仍在跑就发 sleep-boundary-overrun 事件（driver 可订阅后 cancel）。
  const sleepGraceSec = Math.max(0, Number(ctx.config.sleepGraceSec ?? 120))
  const dir = path.dirname(stateFile)

  // 测试时钟（config.testClock:true 时才允许 inbox clock 命令）：只在 time 自己的时间视图上
  // 加偏移，不改宿主时钟——别的插件/DSH 墙钟不受影响，也不会递归。不落盘，重启恢复。
  let clockSkew = 0
  const nowTime = () => ctx.now() + clockSkew

  const signals = ctx.signals
  if (!signals?.offer) throw new Error('time 需要 ctx.signals 服务')
  const world = ctx.services.get('world')
  const focusApi = ctx.focus ?? ctx.services.get('focus') ?? null
  const clock = ctx.services.clock ?? null

  function log(level, msg, extra = {}) {
    try { ctx.log({ level, msg, ...extra }) } catch { /* 日志坏了不影响时间 */ }
  }

  function emitEvent(payload) {
    try { signals.emit(payload) } catch (error) { log('warn', 'time.event-failed', { error: String(error?.message ?? error) }) }
  }

  const blank = () => ({
    phase: 'awake',
    since: nowTime(),
    schedules: [],
    queue: [],
    goals: [],
    spans: [],
    fired: {},
    sleepingId: null,
    sleepUntil: null,
    lock: null,
    pausedAt: null,
    pauseReason: null,
    inboxOffset: 0,
    // 心跳 v2：模型设定的活跃度频率（0.01..1）；下一次随机唤醒与上次触发时间。
    heartbeatFrequency: heartbeatDefaultFrequency,
    heartbeatDueAt: null,
    heartbeatLastAt: null,
    heartbeatStats: { sent: 0, suppressed: 0, skippedBusy: 0 },
    // 清醒节拍/心跳：最后一次 turn-end、下一次自检、最近一小时的节拍时间戳
    lastTurnEndAt: null,
    lastTurnStartAt: null,
    lastAwakeTickAt: null,
    awakeTickDueAt: null,
    awakeTickSentAt: [],
    awakeTickShortSentAt: [],
    awakeTickCappedAt: null,
    // immediate 模式的连续自检计数/退避/最近外部活动
    awakeTickStreak: 0,
    awakeTickBackoff: false,
    awakeTickBackoffAt: null,
    awakeTickLastActivityAt: null,
    // 反应时延指标
    lastDecisionCycleSec: null,
    lastReactionLatencySec: null,
    reactionPendingAt: null,
    reactionPendingFrom: null,
    sleepBoundary: null,
    lastSleepBoundary: null,
    sleepBrief: null,
    lastSleepBrief: null,
    lastDreamResult: null,
    // B compactWake：本清醒周期已发送的 wake-class 次数与分桶统计
    wakeCount: 0,
    wakeStats: { sent: 0, full: 0, compact: 0, chars: 0 },
    lastWakeAt: null,
    // 暂停模式（用户语义：任务停止、世界继续、危险穿透）；phase='paused' 是 time 自己的计时冻结。
    pausedMode: { active: false, reason: null, since: null, source: null },
    lastPierce: null,
    lastBlockedAlarm: null,
    turnEnds: 0,
    heartbeatOverdueLoggedAt: null,
    stats: { dropped: 0, missed: 0, expired: 0, overflow: 0, failed: 0, inboxBad: 0 },
    lastPersistError: null,
    lastTickError: null,
  })
  let state = blank()
  let dirty = false

  function sanitizeState() {
    // __parsed 是内存缓存，不落盘：重启后由 at/weekdays 重建。
    const schedules = state.schedules.map(({ __parsed, ...rest }) => rest)
    return { ...state, schedules }
  }

  // ── 读状态：坏文件先备份，别让下次 persist 把它静默盖掉 ──
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    if (saved && typeof saved === 'object') {
      state = { ...blank(), ...saved }
      state.phase = PHASES.includes(saved.phase) ? saved.phase : 'awake'
      for (const key of ['schedules', 'queue', 'goals', 'spans']) state[key] = Array.isArray(saved[key]) ? saved[key] : []
      state.fired = saved.fired && typeof saved.fired === 'object' ? saved.fired : {}
      state.inboxOffset = Number(saved.inboxOffset) > 0 ? Number(saved.inboxOffset) : 0
      state.stats = { ...blank().stats, ...(saved.stats && typeof saved.stats === 'object' ? saved.stats : {}) }
      state.heartbeatFrequency = clampHeartbeatFrequency(saved.heartbeatFrequency ?? heartbeatDefaultFrequency)
      state.heartbeatDueAt = Number(saved.heartbeatDueAt) > 0 ? Number(saved.heartbeatDueAt) : null
      state.heartbeatLastAt = Number(saved.heartbeatLastAt) > 0 ? Number(saved.heartbeatLastAt) : null
      state.heartbeatStats = { sent: 0, suppressed: 0, skippedBusy: 0, ...(saved.heartbeatStats && typeof saved.heartbeatStats === 'object' ? saved.heartbeatStats : {}) }
      state.awakeTickSentAt = Array.isArray(saved.awakeTickSentAt) ? saved.awakeTickSentAt.map(Number).filter(Number.isFinite).slice(-120) : []
      state.awakeTickShortSentAt = Array.isArray(saved.awakeTickShortSentAt) ? saved.awakeTickShortSentAt.map(Number).filter(Number.isFinite).slice(-20) : []
      for (const key of ['lastTurnEndAt', 'lastTurnStartAt', 'lastAwakeTickAt', 'awakeTickDueAt', 'awakeTickCappedAt', 'heartbeatOverdueLoggedAt', 'awakeTickBackoffAt', 'awakeTickLastActivityAt', 'reactionPendingAt']) {
        state[key] = Number(saved[key]) > 0 ? Number(saved[key]) : null
      }
      state.awakeTickStreak = Number(saved.awakeTickStreak) > 0 ? Number(saved.awakeTickStreak) : 0
      state.awakeTickBackoff = saved.awakeTickBackoff === true
      state.lastDecisionCycleSec = Number(saved.lastDecisionCycleSec) > 0 ? Number(saved.lastDecisionCycleSec) : null
      state.lastReactionLatencySec = Number(saved.lastReactionLatencySec) > 0 ? Number(saved.lastReactionLatencySec) : null
      state.reactionPendingFrom = saved.reactionPendingFrom == null ? null : String(saved.reactionPendingFrom)
      state.turnEnds = Number(saved.turnEnds) > 0 ? Number(saved.turnEnds) : 0
      state.sleepBoundary = saved.sleepBoundary && typeof saved.sleepBoundary === 'object' ? saved.sleepBoundary : null
      state.lastSleepBoundary = saved.lastSleepBoundary && typeof saved.lastSleepBoundary === 'object' ? saved.lastSleepBoundary : null
      state.sleepBrief = saved.sleepBrief && typeof saved.sleepBrief === 'object' ? saved.sleepBrief : null
      state.lastSleepBrief = saved.lastSleepBrief && typeof saved.lastSleepBrief === 'object' ? saved.lastSleepBrief : null
      state.lastDreamResult = saved.lastDreamResult && typeof saved.lastDreamResult === 'object' ? saved.lastDreamResult : null
      state.wakeCount = Number(saved.wakeCount) > 0 ? Number(saved.wakeCount) : 0
      state.wakeStats = saved.wakeStats && typeof saved.wakeStats === 'object' ? { ...blank().wakeStats, ...saved.wakeStats } : blank().wakeStats
      state.lastWakeAt = Number(saved.lastWakeAt) > 0 ? Number(saved.lastWakeAt) : null
      state.pausedMode = saved.pausedMode && typeof saved.pausedMode === 'object' ? { active: false, reason: null, since: null, source: null, ...saved.pausedMode } : { active: false, reason: null, since: null, source: null }
      state.lastPierce = saved.lastPierce && typeof saved.lastPierce === 'object' ? saved.lastPierce : null
      state.lastBlockedAlarm = saved.lastBlockedAlarm && typeof saved.lastBlockedAlarm === 'object' ? saved.lastBlockedAlarm : null
      state.lock = saved.lock && typeof saved.lock === 'object' ? saved.lock : null
      state.pausedAt = Number(saved.pausedAt) > 0 ? Number(saved.pausedAt) : null
      state.pauseReason = saved.pauseReason == null ? null : String(saved.pauseReason)
      state.sleepingId = saved.sleepingId == null ? null : String(saved.sleepingId)
      state.sleepUntil = Number(saved.sleepUntil) > 0 ? Number(saved.sleepUntil) : null
      state.since = Number(saved.since) > 0 ? Number(saved.since) : nowTime()
      if (!state.spans.some((span) => span?.id === state.sleepingId && span.sleep)) {
        // 状态自愈：sleeping 但没有对应 span，回落到 awake（别卡在睡眠里）。
        if (state.phase === 'sleeping') {
          state.phase = 'awake'
          state.since = nowTime()
          state.sleepingId = null
          state.sleepUntil = null
        }
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      const backup = `${stateFile}.corrupt-${Date.now()}`
      try { fs.copyFileSync(stateFile, backup) } catch (copyError) { log('warn', 'time.state.backup-failed', { error: String(copyError?.message ?? copyError) }) }
      log('warn', 'time.state.corrupt', { error: String(error?.message ?? error), backup })
    }
  }

  // 重建 __parsed，清理坏数据/漏掉的安排（显式记录，不静默）
  ;(() => {
    const now = nowTime()
    const kept = []
    for (const schedule of state.schedules) {
      if (!schedule || typeof schedule !== 'object' || !schedule.id) { state.stats.dropped += 1; log('warn', 'time.schedule.invalid', { id: schedule?.id ?? null }); continue }
      try {
        schedule.__parsed = parsedOf(schedule, now, timeZone)
      } catch (error) {
        state.stats.dropped += 1
        log('warn', 'time.schedule.unparsable', { id: schedule.id, at: schedule.at, error: String(error?.message ?? error) })
        continue
      }
      // 一次性安排超过补发窗口就显式丢弃（记录漏响），不要留在表里永远不响。
      if (schedule.__parsed.kind === 'once' && now - schedule.__parsed.at > onceCatchUpMs) {
        state.stats.missed += 1
        log('warn', 'time.schedule.missed', { id: schedule.id, at: stampAt(schedule.__parsed.at, timeZone) })
        continue
      }
      kept.push(schedule)
    }
    state.schedules = kept
    // fired 只保留最近 N 天，避免 time.json 单调膨胀
    for (const [key, at] of Object.entries(state.fired)) {
      if (Number(at) > 0 && now - Number(at) > firedRetentionMs) delete state.fired[key]
    }
    // 睡眠/暂停中但 pausedAt 丢了：从现在开始算暂停（不假装没暂停过）。
    if (state.phase === 'paused' && state.pausedAt == null) state.pausedAt = now
    if (state.lock && !(Number(state.lock.until) > now)) {
      log('warn', 'time.lock.expired-on-boot', { until: state.lock.until })
      state.lock = null
    }
    state.queue = state.queue.filter((item) => item && typeof item === 'object')
  })()

  // 运行时（不落盘）
  const goalLeases = new Map()
  let sleepLease = null

  /** 重启/重复入睡时可能留下多个 owner=time,label=sleep 的租约；统一收敛成一个。 */
  function sleepLeases() {
    try { return (focusApi?.list?.() ?? []).filter((lease) => lease?.owner === 'time' && lease?.label === 'sleep') } catch { return [] }
  }

  function releaseSleepLeases() {
    let released = 0
    for (const lease of sleepLeases()) {
      try { lease.release?.(); released += 1 } catch { /* 已经释放 */ }
    }
    sleepLease = null
    return released
  }

  function ensureSleepLease() {
    const existing = sleepLeases()
    if (existing.length) {
      sleepLease = existing[0]
      for (const extra of existing.slice(1)) { try { extra.release?.() } catch { /* 已经释放 */ } }
      return sleepLease
    }
    if (!focusApi?.enter) return null
    sleepLease = focusApi.enter({ label: 'sleep', owner: 'time', reason: 'sleeping', title: '睡眠', kind: 'idle', interruptible: false })
    return sleepLease
  }

  let ticking = false

  /**
   * 测试/复核用：平移 time 看到的时钟（跨小时/跨时段前缀复核、长夜压缩）。
   * 只在 ctx.config.testClock === true 时开放；时钟仍跟着真实时间走，只是整体偏移。
   */
  function advanceClock(args = {}) {
    if (ctx.config.testClock !== true) throw new Error('clock 命令只在 testClock:true 的测试 preset 里可用')
    if (args.reset === true) {
      clockSkew = 0
      log('info', 'time.clock.test', { reset: true })
      return { reset: true, now: nowTime() }
    }
    let advance = 0
    if (args.advanceMs != null) advance = Number(args.advanceMs)
    else if (args.advanceMinutes != null) advance = Number(args.advanceMinutes) * 60_000
    else if (args.advanceHours != null) advance = Number(args.advanceHours) * 3_600_000
    if (args.nextHour === true) {
      const p = partsOf(nowTime(), timeZone)
      advance += (60 - p.min) * 60_000 + 60_000
    }
    if (args.nextPeriod === true) {
      // 跳到 time 段"时段"的下一个边界（凌晨/上午/下午/晚上/深夜）+1 分钟，
      // 专门用来复核"跨时段时提示词事实变化、其余时间不抖"。
      const p = partsOf(nowTime(), timeZone)
      const boundary = [6, 12, 18, 23].find((hour) => hour > p.h)
      const dayAdd = boundary == null ? 1 : 0
      const targetHour = boundary == null ? 6 : boundary
      advance += ((dayAdd * 24 + targetHour - p.h) * 60 - p.min + 1) * 60_000
    }
    if (!Number.isFinite(advance) || advance <= 0) throw new Error('clock 需要 advanceMs / advanceMinutes / advanceHours / nextHour / nextPeriod')
    clockSkew += Math.round(advance)
    log('info', 'time.clock.test', { advanceMs: Math.round(advance), skewMs: clockSkew })
    return { advancedMs: Math.round(advance), now: nowTime(), skewMs: clockSkew }
  }

  function persist() {
    dirty = false
    try {
      fs.mkdirSync(dir, { recursive: true })
      const body = JSON.stringify(sanitizeState(), null, 1)
      const tmp = `${stateFile}.tmp-${process.pid}`
      fs.writeFileSync(tmp, body, 'utf8')
      try { fs.renameSync(tmp, stateFile) } catch (renameError) {
        // 少数 Windows 场景下 rename 会被占用；退回直接写，并留下记录。
        fs.writeFileSync(stateFile, body, 'utf8')
        try { fs.unlinkSync(tmp) } catch { /* 临时文件清不掉不致命 */ }
        log('warn', 'time.persist.rename-fallback', { error: String(renameError?.message ?? renameError) })
      }
      state.lastPersistError = null
    } catch (error) {
      dirty = true
      state.lastPersistError = { at: nowTime(), error: String(error?.message ?? error) }
      log('warn', 'time.persist', { error: String(error?.message ?? error) })
    }
  }

  function writeSideFile(file, body) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file, body, 'utf8')
    } catch (error) { log('warn', 'time.side-file', { file: path.basename(file), error: String(error?.message ?? error) }) }
  }

  /** 追加一行可观测事件（外部 supervisor/早报用；不依赖 signals 是否被订阅/拦截）。 */
  function recordEvent(type, meta = {}) {
    try {
      const at = nowTime()
      fs.mkdirSync(path.dirname(eventsFile), { recursive: true })
      fs.appendFileSync(eventsFile, `${JSON.stringify({ at, iso: new Date(at).toISOString(), type, ...meta })}\n`, 'utf8')
    } catch (error) { log('warn', 'time.events.write', { type, error: String(error?.message ?? error) }) }
  }

  function send({ kind = 'notice', text, focus: target = null, tags = [] }) {
    return signals.offer({ from: { plugin: 'time', activity: 'schedule' }, kind, text, focus: target, tags })
  }

  /* ── B：渐进式唤醒（compactWake，lab-only） ──
   * wakeCount = 本清醒周期已发送的 wake-class 次数（schedule wake / 睡醒 / goal resume /
   * awake tick / QQ 实际投递由 qq 通过 api.wake.bump() 计入）。
   * wakeCount=0（首次/睡醒后第一声）→ full；之后 compact 6 行；fullEvery=N 时每 N 次插一次 full。
   * 只压 orientation，payload（未读/积压/危险/sleep brief）原样附在 `---` 后。
   */
  function phaseWord() {
    if (state.phase === 'sleeping') return '睡眠中'
    if (state.phase === 'paused') return '暂停'
    return '醒着'
  }

  function compactWakeMode() {
    if (!compactWakeEnabled) return 'full'
    const count = Number(state.wakeCount ?? 0)
    if (count <= 0 || count < compactWakeAfter) return 'full'
    if (compactWakeFullEvery > 0 && count % compactWakeFullEvery === 0) return 'full'
    return 'compact'
  }

  function compactOrientation(at, { lastText = null } = {}) {
    const p = partsOf(at, timeZone)
    const hour = p.h < 6 ? '凌晨' : p.h < 12 ? '上午' : p.h < 18 ? '下午' : p.h < 23 ? '晚上' : '深夜'
    const focusLease = focusApi?.current?.()
    const goal = state.goals[0]
    const alarms = state.queue.filter((item) => item.priority === 'alarm').length
    const last = lastText == null ? '刚醒/刚连上' : String(lastText).replace(/\s+/g, ' ').slice(0, 80)
    const lines = [
      '〔提醒〕你在 ICL（小千）。',
      `现在：${p.y}-${pad2(p.m)}-${pad2(p.d)} 周${WEEKDAYS_ZH[isoWeekday(at, timeZone) - 1]} ${hour}，${phaseWord()}。`,
      `焦点：${focusLease?.title ?? focusLease?.label ?? '无'}；目标：${goal ? `${goal.id}（${goal.theme}）` : '无'}。`,
      `积压：${state.queue.length} 条（危险 ${alarms} 条已置顶）。`,
      `上次：${last}。`,
      '继续；下面的新内容优先。',
    ]
    let text = lines.join('\n')
    if (text.length > compactWakeMaxChars) text = `${text.slice(0, compactWakeMaxChars - 1)}…`
    return text
  }

  function noteWakeSent(mode, chars, producer, at) {
    state.wakeCount = Number(state.wakeCount ?? 0) + 1
    state.lastWakeAt = at
    state.wakeStats.sent = Number(state.wakeStats.sent ?? 0) + 1
    state.wakeStats[mode] = Number(state.wakeStats[mode] ?? 0) + 1
    state.wakeStats.chars = Number(state.wakeStats.chars ?? 0) + chars
    dirty = true
    persist()
    recordEvent('wake-class', { producer, mode, chars, count: state.wakeCount })
  }

  /**
   * 发一条 wake-class 消息：按 wakeCount 选择 full/compact。
   * @param {object} input { text(full), payload(compact 时原样保留), producer, kind, tags, focus, lastText }
   */
  function sendWake({ text, payload = '', producer = 'time', kind = 'wake', tags = ['wake'], focus = null, lastText = null }) {
    const mode = compactWakeMode()
    let body = text
    if (mode === 'compact') {
      const orientation = compactOrientation(nowTime(), { lastText })
      body = payload && compactWakeAllowPayload ? `${orientation}\n---\n${payload}` : orientation
    }
    const outcome = send({ kind, text: body, focus, tags })
    if (!(outcome && outcome.accepted === false)) noteWakeSent(mode, body.length, producer, nowTime())
    return outcome
  }

  /** 睡醒第一声按 full 处理：先 reset，再发（sendWake 会 bump 到 1）。 */
  function resetWakeCount(reason = 'sleep-end') {
    if (state.wakeCount || state.wakeStats.sent) {
      state.wakeCount = 0
      dirty = true
      recordEvent('wake-reset', { reason })
    }
  }

  /* ── 清醒节拍（awake heartbeat） ──
   *
   * 问题：turn-end 之后如果没有任何目标/事件，会话就静止了——模型只在被投递消息时存在，
   * 于是"无事可做"表现为分钟级没有模型调用（像卡死/延迟）。
   * 修法：awake 且没有 sleep/mute/pause 时，turn-end 后若本轮没有目标续推，
   * 就在 idleSec 后发一条"清醒节拍"自检消息，逼出下一次模型调用；每轮 turn-end 重置计时，
   * 所以正常做事时不会叠加。睡眠/静音/暂停是显式静止状态，不发自检。
   */

  function awakeSuppressed() {
    if (state.phase !== 'awake') return true
    if (state.lock) return true
    if (!awakeDuringFocus && focusApi?.current?.()) return true
    return false
  }

  /** 外部信号/任务事件：重置 immediate 退避，并记录反应时延起点。 */
  function noteExternalActivity(at = nowTime(), from = 'signal') {
    state.awakeTickLastActivityAt = at
    if (state.awakeTickStreak || state.awakeTickBackoff) {
      state.awakeTickStreak = 0
      state.awakeTickBackoff = false
      state.awakeTickBackoffAt = null
      recordEvent('awake-recover', { at, from })
      log('info', 'time.awake-tick.recover', { from })
    }
    const inTurn = state.lastTurnStartAt != null && (state.lastTurnEndAt == null || Number(state.lastTurnStartAt) > Number(state.lastTurnEndAt))
    if (!inTurn && state.reactionPendingAt == null) {
      state.reactionPendingAt = at
      state.reactionPendingFrom = String(from ?? 'signal')
    }
    dirty = true
  }

  /** task/信号到达后第一次 turn-start：算出 reactionLatencySec。 */
  function noteReaction(at) {
    if (state.reactionPendingAt == null) return
    const latency = Math.max(0, Math.round((at - Number(state.reactionPendingAt)) / 1000))
    state.lastReactionLatencySec = latency
    recordEvent('reaction-latency', { sec: latency, from: state.reactionPendingFrom ?? 'signal' })
    state.reactionPendingAt = null
    state.reactionPendingFrom = null
    dirty = true
  }

  // immediate 模式需要 ~1s 精度：独立 timer；普通模式仍靠 tick 循环。
  let awakeTimer = null
  function syncAwakeTimer() {
    if (awakeTimer) { clearTimeout(awakeTimer); awakeTimer = null }
    if (!awakeTimerEnabled || !awakeTickEnabled || state.awakeTickDueAt == null) return
    const wait = Math.max(50, Math.min(Number(state.awakeTickDueAt) - nowTime(), 3_600_000))
    awakeTimer = setTimeout(() => {
      awakeTimer = null
      try {
        const at = nowTime()
        if (state.awakeTickDueAt != null && at >= Number(state.awakeTickDueAt)) {
          maybeAwakeTick(at)
          persist()
        }
      } catch (error) { log('warn', 'time.awake-timer', { error: String(error?.message ?? error) }) }
      syncAwakeTimer()
    }, wait)
    if (typeof awakeTimer.unref === 'function') awakeTimer.unref()
  }

  /** 安排/重置一次清醒节拍；immediate 模式默认 minIdleSec（~1s），退避中则 backoffSec。 */
  function armAwakeTick(delayMs = null) {
    if (!awakeTickEnabled) { state.awakeTickDueAt = null; syncAwakeTimer(); return }
    if (awakeSuppressed()) { state.awakeTickDueAt = null; syncAwakeTimer(); return }
    const delay = delayMs != null
      ? Number(delayMs)
      : (state.awakeTickBackoff ? awakeBackoffSec : awakeArmDelaySec) * 1000
    state.awakeTickDueAt = nowTime() + Math.max(100, Number(delay) || awakeArmDelaySec * 1000)
    dirty = true
    syncAwakeTimer()
  }

  function clearAwakeTick() {
    if (state.awakeTickDueAt != null) { state.awakeTickDueAt = null; dirty = true }
    syncAwakeTimer()
  }

  /* ── 全局兜底心跳（heartbeat v2） ──
   * 模型只设频率 f；实际间隔 = uniform(10m,20m) / f，随机。
   * 不检查已有安排；span/goal 活跃时暂停，最后一个 span/goal 结束后恢复。
   * 只在 turn-end 后没有新回合时计时；心跳消息直接带 statusText()，省一次 time_status 调用。
   */
  function heartbeatInTurn() {
    return state.lastTurnStartAt != null && (state.lastTurnEndAt == null || Number(state.lastTurnStartAt) > Number(state.lastTurnEndAt))
  }

  function heartbeatSuppressed() {
    if (state.phase !== 'awake') return true
    if (state.spans.length) return true
    if (state.goals.length) return true
    return false
  }

  function heartbeatDelayMs() {
    const base = heartbeatBaseMinSec * 1000 + Math.random() * (heartbeatBaseMaxSec - heartbeatBaseMinSec) * 1000
    return Math.max(60_000, Math.round(base / clampHeartbeatFrequency(state.heartbeatFrequency)))
  }

  function heartbeatEstimate() {
    const f = clampHeartbeatFrequency(state.heartbeatFrequency)
    const lo = Math.round(heartbeatBaseMinSec * 1000 / f)
    const hi = Math.round(heartbeatBaseMaxSec * 1000 / f)
    return { minMs: lo, maxMs: hi, text: `每 ${fmtDuration(lo)}–${fmtDuration(hi)}` }
  }

  function clearHeartbeat() {
    if (state.heartbeatDueAt != null) { state.heartbeatDueAt = null; dirty = true }
  }

  /** turn-end 后（或 span/goal 释放后）排下一次心跳；被抑制就不排。 */
  function armHeartbeat(delayMs = null) {
    if (heartbeatSuppressed() || heartbeatInTurn() || state.lastTurnEndAt == null) { clearHeartbeat(); return }
    state.heartbeatDueAt = nowTime() + (delayMs != null ? Math.max(60_000, Number(delayMs)) : heartbeatDelayMs())
    dirty = true
  }

  function heartbeatMessage(at) {
    const lines = [`【心跳】${stampAt(at, timeZone)} 没有新回合；当前情况：`]
    lines.push(statusText())
    try {
      const worldText = world?.renderBrief?.()
      if (worldText) lines.push(`世界：\n${worldText}`)
    } catch { /* 世界状态失败不影响心跳 */ }
    if (state.queue.length) {
      const preview = state.queue.slice(-3).map((row) => `- ${row.from?.plugin ?? '?'}：${clipBriefText(row.text, 80)}`)
      lines.push(`积压预览：\n${preview.join('\n')}`)
    }
    return lines.join('\n')
  }

  function maybeHeartbeat(at) {
    if (heartbeatSuppressed()) {
      if (state.heartbeatDueAt != null) { state.heartbeatDueAt = null; dirty = true; state.heartbeatStats.suppressed = Number(state.heartbeatStats.suppressed ?? 0) + 1 }
      return false
    }
    if (heartbeatInTurn()) {
      if (state.heartbeatDueAt != null) { state.heartbeatDueAt = null; dirty = true; state.heartbeatStats.skippedBusy = Number(state.heartbeatStats.skippedBusy ?? 0) + 1 }
      return false
    }
    if (state.heartbeatDueAt == null) {
      if (state.lastTurnEndAt != null) armHeartbeat()
      return false
    }
    if (at < Number(state.heartbeatDueAt)) return false
    const text = heartbeatMessage(at)
    const outcome = sendWake({ text, payload: text, producer: 'heartbeat', kind: 'wake', tags: ['heartbeat'] })
    if (outcome && outcome.accepted === false) {
      state.heartbeatDueAt = at + Math.max(60_000, heartbeatEstimate().minMs / 3)
      dirty = true
      return false
    }
    state.heartbeatDueAt = null
    state.heartbeatLastAt = at
    state.heartbeatStats.sent = Number(state.heartbeatStats.sent ?? 0) + 1
    dirty = true
    recordEvent('heartbeat-fire', { frequency: state.heartbeatFrequency, idleSec: state.lastTurnEndAt ? Math.round((at - Number(state.lastTurnEndAt)) / 1000) : null })
    log('info', 'time.heartbeat.fire', { frequency: state.heartbeatFrequency, idleSec: state.lastTurnEndAt ? Math.round((at - Number(state.lastTurnEndAt)) / 1000) : null })
    return true
  }

  function awakeTickText(at, { short = false } = {}) {
    const idleSec = state.lastTurnEndAt ? Math.round((at - Number(state.lastTurnEndAt)) / 1000) : null
    // 用户明确讨厌"看 status 决定下一步"这种教轮询的文案：只给事实 + 继续。
    if (short) return `清醒节拍：继续（醒着 ${idleSec ?? '?'} 秒，仍在等你）。`
    const bits = [`清醒节拍：距上次回合结束 ${idleSec ?? '?'} 秒`]
    if (state.queue.length) bits.push(`积压 ${state.queue.length} 条`)
    if (state.goals.length) bits.push(`目标 ${state.goals.map((goal) => goal.id).join('、')}`)
    return `${bits.join('；')}。继续。`
  }

  /** tick / timer 里调用：到点就发一次清醒节拍；immediate 的节奏与退避见 §17。 */
  function maybeAwakeTick(at) {
    if (!awakeTickEnabled) return false
    if (awakeSuppressed()) { state.awakeTickDueAt = null; syncAwakeTimer(); return false }
    if (state.awakeTickDueAt == null) return false
    if (at < Number(state.awakeTickDueAt)) return false
    // 上限：最近一小时的节拍次数（immediate 默认 3600/h，等于不限）
    const hourAgo = at - 3_600_000
    const cap = Math.max(120, Math.min(4000, awakeMaxPerHour * 2))
    state.awakeTickSentAt = (Array.isArray(state.awakeTickSentAt) ? state.awakeTickSentAt : []).filter((ts) => Number(ts) > hourAgo).slice(-cap)
    if (state.awakeTickSentAt.length >= awakeMaxPerHour) {
      if (!state.awakeTickCappedAt) {
        state.awakeTickCappedAt = at
        log('warn', 'time.awake-tick.capped', { maxPerHour: awakeMaxPerHour })
      }
      // 命中上限后：降频到 cappedSec 一次；cap 后前 cappedShortWindowSec 分钟内只发短提示
      // （最多 cappedShortMax 条），之后安静等滚动窗口释放，不刷屏。
      if (at - Number(state.awakeTickCappedAt) <= awakeCappedShortWindowSec * 1000) {
        state.awakeTickShortSentAt = (Array.isArray(state.awakeTickShortSentAt) ? state.awakeTickShortSentAt : []).filter((ts) => at - Number(ts) <= awakeCappedShortWindowSec * 1000)
        if (state.awakeTickShortSentAt.length < awakeCappedShortMax) {
          const outcome = sendWake({ text: awakeTickText(at, { short: true }), producer: 'awake-tick', kind: 'notice', tags: ['awake-tick', 'heartbeat', 'short'] })
          if (outcome && outcome.accepted === false) {
            state.awakeTickDueAt = at + awakeRetrySec * 1000
            syncAwakeTimer()
            return false
          }
          state.awakeTickShortSentAt = [...state.awakeTickShortSentAt, at].slice(-20)
        }
      }
      state.awakeTickDueAt = at + awakeCappedSec * 1000
      dirty = true
      syncAwakeTimer()
      return false
    }
    // 滚动窗口释放后恢复正常节拍
    if (state.awakeTickCappedAt && at - state.awakeTickCappedAt > 3_600_000) state.awakeTickCappedAt = null
    const outcome = sendWake({ text: awakeTickText(at), producer: 'awake-tick', kind: 'notice', tags: ['awake-tick', 'heartbeat'] })
    if (outcome && outcome.accepted === false) {
      // 投递失败（会话忙）：短重试，不静默放弃
      state.awakeTickDueAt = at + awakeRetrySec * 1000
      log('warn', 'time.awake-tick.failed', { reason: outcome.reason ?? outcome.error ?? 'unknown' })
      syncAwakeTimer()
      return false
    }
    state.lastAwakeTickAt = at
    state.awakeTickSentAt = [...state.awakeTickSentAt, at].slice(-cap)
    if (awakeImmediate) {
      const streak = Number(state.awakeTickStreak ?? 0) + 1
      state.awakeTickStreak = streak
      if (!state.awakeTickBackoff && streak >= awakeBackoffAfter) {
        // 连续 N 次自检都没有外部信号/任务事件：退避到 backoffSec，事件一到立刻恢复。
        state.awakeTickBackoff = true
        state.awakeTickBackoffAt = at
        state.awakeTickDueAt = at + awakeBackoffSec * 1000
        recordEvent('awake-backoff', { streak, backoffSec: awakeBackoffSec })
        log('warn', 'time.awake-tick.backoff', { streak, backoffSec: awakeBackoffSec })
      } else if (state.awakeTickBackoff) {
        state.awakeTickDueAt = at + awakeBackoffSec * 1000
      } else {
        // 等这一轮 turn-end 再 arm，避免 1s 空转。
        state.awakeTickDueAt = null
      }
    } else {
      state.awakeTickDueAt = at + awakeIdleSec * 1000
    }
    dirty = true
    const idleSec = state.lastTurnEndAt ? Math.round((at - Number(state.lastTurnEndAt)) / 1000) : null
    recordEvent('awake-tick', { idleSec, streak: state.awakeTickStreak, backoff: state.awakeTickBackoff, mode: awakeImmediate ? 'immediate' : 'normal', decisionCycleSec: state.lastDecisionCycleSec })
    log('info', 'time.awake-tick', { idleSec, streak: state.awakeTickStreak, backoff: state.awakeTickBackoff, mode: awakeImmediate ? 'immediate' : 'normal' })
    syncAwakeTimer()
    return true
  }

  /* ── 积压：有界、不丢、过期有计数 ── */

  const protectTags = (Array.isArray(ctx.config.protectTags) ? ctx.config.protectTags : ['mention', 'at', 'private', 'direct', 'admin']).map(String)

  /** 条目优先级：alarm 最高，其次 @/私聊，最后 ambient；溢出时先丢 ambient。 */
  function queuePriority(item) {
    if (item?.priority === 'alarm') return 2
    const tags = Array.isArray(item?.tags) ? item.tags : []
    return tags.some((tag) => protectTags.includes(tag)) ? 1 : 0
  }

  /** 从信号里抽出 QQ 回执需要的 (activity, seq)；只认 qq 自己的 ledger 信息。 */
  function signalQq(signal) {
    const ledger = signal?.meta?.qq?.ledger
    if (!ledger || Number(ledger.seq) <= 0) return null
    return { activity: String(ledger.activity ?? signal?.focus ?? ''), seq: Number(ledger.seq) }
  }

  function signalReplayQq(signal) {
    const rows = Array.isArray(signal?.meta?.replayQq) ? signal.meta.replayQq : []
    return rows.filter((row) => row && Number(row.seq) > 0).map((row) => ({ activity: String(row.activity ?? ''), seq: Number(row.seq) }))
  }

  function enqueue(signal, reason, { priority = 'normal' } = {}) {
    // 同一个信号 id 被重复 offer（blocked 不占 id，调用方可能重试）时不要重复入队。
    if (signal.id != null && state.queue.some((item) => item.signalId === signal.id)) return
    if (state.queue.length >= maxQueue) {
      // 溢出丢"最不重要的最旧一条"：先保 alarm/mention/私聊，再保普通消息。
      let victim = 0
      for (let i = 0; i < state.queue.length; i += 1) {
        if (queuePriority(state.queue[i]) < queuePriority(state.queue[victim])) { victim = i; break }
      }
      const dropped = state.queue.splice(victim, 1)[0]
      state.stats.dropped += 1
      state.stats.overflow += 1
      log('warn', 'time.queue.overflow', { max: maxQueue, dropped: dropped?.id ?? null, from: dropped?.from?.plugin ?? null, priority: queuePriority(dropped) })
    }
    state.queue.push({
      id: `q-${++queueSeq}-${Date.now().toString(36)}`,
      signalId: signal.id == null ? null : String(signal.id),
      from: { plugin: signal.from?.plugin ?? '?', activity: signal.from?.activity ?? null },
      kind: signal.kind ?? 'notice',
      text: String(signal.text ?? '').slice(0, 500),
      tags: Array.isArray(signal.tags) ? signal.tags.slice(0, 8) : [],
      focus: signal.focus ?? null,
      reason,
      priority,
      // 重放回执：QQ 消息按 (activity,seq) 记录；focus backlog 摘要带 replayQq 列表。
      qq: signalQq(signal),
      replayQq: signalReplayQq(signal),
      at: nowTime(),
      createdAt: signal.createdAt ?? null,
      // 睡眠/安静是"故意攒到醒来"的状态：不能沿用信号的 30 分钟 TTL，
      // 否则 6 小时睡眠会把积压全部判过期（2026-11-08 早上的事故）。
      expiresAt: (reason === 'sleeping' || reason === 'quiet') ? null : (signal.expiresAt ?? null),
    })
    persist()
  }
  let queueSeq = 0

  function reasonCounts() {
    const counts = new Map()
    for (const item of state.queue) counts.set(item.from?.plugin ?? '?', (counts.get(item.from?.plugin ?? '?') ?? 0) + 1)
    return [...counts.entries()].map(([plugin, n]) => `${plugin} ${n}`).join('、')
  }

  function buildBacklogText(reason, items, expired = 0) {
    // 危险/紧急条目排最前（睡眠中攒下的 alarm 醒来第一眼看到），其余保持原顺序。
    const ordered = [...items.filter((item) => item.priority === 'alarm'), ...items.filter((item) => item.priority !== 'alarm')]
    const shown = ordered.slice(0, backlogShow)
    const lines = shown.map((item) => {
      const source = item.from?.activity ? `${item.from.plugin}/${item.from.activity}` : (item.from?.plugin ?? '?')
      const mark = item.priority === 'alarm' ? '⚠ ' : ''
      return `· ${mark}[${source}] ${String(item.text ?? '')}`.slice(0, 240)
    })
    let body = lines.join('\n')
    const more = ordered.length - shown.length
    if (more > 0) body += `\n…还有 ${more} 条（${reasonCounts()}）`
    if (body.length > backlogMaxChars) body = `${body.slice(0, backlogMaxChars - 1)}…`
    const expiredNote = expired > 0 ? `；另有 ${expired} 条已过期` : ''
    // compactWake：只压 preamble；每条积压/危险正文原样（payload 不压）。
    if (compactWakeEnabled && compactWakeMode() === 'compact') {
      const alarms = ordered.filter((item) => item.priority === 'alarm').length
      return `（${reason}）积压 ${ordered.length} 条${alarms ? `（危险 ${alarms} 条置顶）` : ''}${expiredNote}：\n${body}`
    }
    return `（${reason}）积压了 ${ordered.length} 条消息${expiredNote}：\n${body}`
  }

  /**
   * 释放积压。只有真的被 signals 接收后才清空；接收失败留在队列里下次再试（不丢）。
   * 只在 awake 时释放；睡眠/暂停中调用是空操作（保持积压）。
   */
  function flushQueue(reason) {
    if (!state.queue.length) return 0
    const now = nowTime()
    let expired = 0
    const fresh = []
    for (const item of state.queue) {
      if (item.expiresAt != null && Number(item.expiresAt) <= now) { expired += 1; continue }
      fresh.push(item)
    }
    if (expired) { state.stats.expired += expired; log('warn', 'time.queue.expired', { count: expired, reason }) }
    if (!fresh.length) { state.queue = []; persist(); return 0 }
    if (state.phase !== 'awake') { persist(); return 0 }
    const outcome = send({ kind: 'notice', text: buildBacklogText(reason, fresh, expired), tags: ['backlog'] })
    if (outcome && outcome.accepted === false) {
      state.stats.failed += 1
      log('warn', 'time.queue.release-failed', { reason: outcome.reason ?? outcome.error ?? 'unknown', count: fresh.length })
      persist()
      return 0
    }
    // 重放回执：这批消息真正重新进入投递管道后，给 QQ 推 delivered（不推 attended）。
    notifyQqReplayed(fresh, 'time-backlog')
    state.queue = []
    persist()
    return fresh.length
  }

  /** 把队列里 QQ 信号的 (activity,seq)（含 focus backlog 摘要携带的 replayQq）按活动通知 QQ。 */
  function notifyQqReplayed(items, via) {
    const byActivity = new Map()
    const add = (row) => {
      if (!row || Number(row.seq) <= 0) return
      const activity = String(row.activity ?? '')
      if (!activity) return
      const set = byActivity.get(activity) ?? new Set()
      set.add(Number(row.seq))
      byActivity.set(activity, set)
    }
    for (const item of items) {
      add(item.qq)
      for (const row of Array.isArray(item.replayQq) ? item.replayQq : []) add(row)
    }
    if (!byActivity.size) return 0
    const qq = ctx.services.get('qq')
    if (!qq || typeof qq.noteDeliveredSeqs !== 'function') return 0
    let accepted = 0
    for (const [activity, seqs] of byActivity) {
      try {
        const out = qq.noteDeliveredSeqs({ activity, seqs: [...seqs], via, at: nowTime() })
        accepted += Number(out?.accepted ?? 0)
      } catch (error) { log('warn', 'time.qq-receipt', { error: String(error?.message ?? error) }) }
    }
    return accepted
  }

  function activeSleepSpan() {
    return state.spans.find((span) => span.sleep && span.id === state.sleepingId) ?? null
  }

  function activeQuietSpan() {
    return state.spans.find((span) => span.quiet === true) ?? null
  }

  /** 明确 @ 到她的信号：不绑定某个插件，tags/meta 里任一处标了 mention 都算。 */
  function isMention(signal) {
    const tags = Array.isArray(signal?.tags) ? signal.tags.map((tag) => String(tag).toLowerCase()) : []
    if (tags.some((tag) => ['mention', 'at', 'at-me', 'at_me', 'atme', 'reply-me'].includes(tag))) return true
    const meta = signal?.meta ?? {}
    if (meta.mention === true || meta.mentioned === true) return true
    if (meta.qq?.envelope?.mentioned === true) return true
    return false
  }

  function isEmergency(signal) {
    const plugin = String(signal.from?.plugin ?? '')
    if (emergencyFrom && !emergencyFrom.includes(plugin)) return false
    const tags = Array.isArray(signal.tags) ? signal.tags.map(String) : []
    if (tags.some((tag) => emergencyTags.includes(tag))) return true
    // mc-body 的事件 payload 带 priority:'alarm' + pierce:true；来源没打 tags 时也按危险处理（契约 §16.4）。
    const meta = signal.meta
    if (meta && typeof meta === 'object') {
      if (meta.pierce === true || String(meta.priority ?? '').toLowerCase() === 'alarm') return true
    }
    return false
  }

  /** 暂停（用户语义：任务停止、世界继续）：time 的 phase=paused 或外部 pause mode 都算。 */
  function pausedActive() {
    return state.phase === 'paused' || state.pausedMode?.active === true
  }

  /** 危险消息穿透时留痕：状态里可查，time-events 可被 supervisor/mc-link 消费。 */
  function recordPierce(signal, context) {
    const at = nowTime()
    state.lastPierce = {
      at,
      plugin: signal.from?.plugin ?? '?',
      activity: signal.from?.activity ?? null,
      tags: Array.isArray(signal.tags) ? signal.tags.slice(0, 6) : [],
      text: String(signal.text ?? '').slice(0, 200),
      context,
    }
    if (state.pausedMode?.active) state.pausedMode.lastPierce = state.lastPierce
    persist()
    recordEvent('pause-pierce', { plugin: state.lastPierce.plugin, tags: state.lastPierce.tags, text: state.lastPierce.text, context })
    log('warn', 'time.pause.pierce', { plugin: state.lastPierce.plugin, tags: state.lastPierce.tags, context })
  }

  /** 危险消息被拦（睡眠/静音）时留痕；醒来简报/状态会优先展示。 */
  function recordBlockedAlarm(signal, reason) {
    state.lastBlockedAlarm = {
      at: nowTime(),
      plugin: signal.from?.plugin ?? '?',
      activity: signal.from?.activity ?? null,
      tags: Array.isArray(signal.tags) ? signal.tags.slice(0, 6) : [],
      text: String(signal.text ?? '').slice(0, 200),
      reason,
    }
    recordEvent('alarm-blocked', { plugin: state.lastBlockedAlarm.plugin, tags: state.lastBlockedAlarm.tags, reason })
    log('warn', 'time.alarm.blocked', { plugin: state.lastBlockedAlarm.plugin, tags: state.lastBlockedAlarm.tags, reason })
  }

  /* ── 唯一拦截层 ── */

  function gate(signal) {
    if (!signal || typeof signal !== 'object') return { accept: true }
    // 事件总线（to:'plugin'）不是"给模型的消息"：不拦、不进积压。
    if (signal.to === 'plugin') return { accept: true }
    // 她自己的闹钟/结束语/目标续推：静音不关自己的闹钟（FOCUS.md §1.6）。
    if (signal.from?.plugin === 'time') return { accept: true }
    const alarm = isEmergency(signal)
    // 外部信号到达 = 有活动：immediate 退避立刻恢复，并给反应时延记起点。
    if (signal.from?.plugin !== 'time' && state.phase === 'awake') noteExternalActivity(nowTime(), `plugin:${signal.from?.plugin ?? '?'}`)
    // 1) 静音（显式沉默）优先：连 alarm 也拦（默认 quota=0），但记录；显式 allow/配额可 opt-in 放行。
    if (state.lock) {
      if (allowMatch(state.lock.allow, signal)) { if (alarm) recordPierce(signal, 'mute-allow'); return { accept: true } }
      if (alarm) {
        const quota = Number(state.lock.emergency?.quota ?? 0)
        const used = Number(state.lock.emergency?.used ?? 0)
        if (used < quota) {
          state.lock.emergency.used = used + 1
          state.lock.emergency.log = [...(state.lock.emergency.log ?? []), { at: nowTime(), plugin: signal.from?.plugin ?? '?', text: String(signal.text ?? '').slice(0, 120) }].slice(-20)
          recordPierce(signal, 'mute-quota')
          log('info', 'time.lock.emergency', { plugin: signal.from?.plugin ?? '?', used: used + 1, quota })
          return { accept: true, emergency: true }
        }
        enqueue(signal, 'muted', { priority: 'alarm' })
        recordBlockedAlarm(signal, 'muted')
        return { accept: false, reason: 'muted', priority: 'alarm' }
      }
      enqueue(signal, 'muted')
      return { accept: false, reason: 'muted' }
    }
    // 2) 睡眠：危险**不叫醒**，但最高优先级进积压，醒来简报第一条呈现。
    if (state.phase === 'sleeping') {
      const span = activeSleepSpan()
      const allow = Array.isArray(span?.allow) ? span.allow : DEFAULT_ALLOW
      if (allowMatch(allow, signal)) { if (alarm) recordPierce(signal, 'sleep-allow'); return { accept: true } }
      enqueue(signal, 'sleeping', { priority: alarm ? 'alarm' : 'normal' })
      if (alarm) recordBlockedAlarm(signal, 'sleeping')
      return { accept: false, reason: 'sleeping', priority: alarm ? 'alarm' : undefined }
    }
    // 3) 安静安排（非睡眠）：普通消息积压；明确 @ 和管理员放行；phase 仍是 awake。
    const quiet = activeQuietSpan()
    if (quiet) {
      const allow = Array.isArray(quiet.allow) ? quiet.allow : DEFAULT_QUIET_ALLOW
      if (isMention(signal) || allowMatch(allow, signal)) {
        if (alarm) recordPierce(signal, 'quiet-allow')
        return { accept: true }
      }
      enqueue(signal, 'quiet', { priority: alarm ? 'alarm' : 'normal' })
      if (alarm) recordBlockedAlarm(signal, 'quiet')
      return { accept: false, reason: 'quiet', priority: alarm ? 'alarm' : undefined }
    }
    // 4) 暂停（任务停止、世界继续）：危险必须穿透并把会话叫醒；其余进积压。
    if (pausedActive()) {
      if (alarm) { recordPierce(signal, 'pause'); return { accept: true, pierce: 'alarm' } }
      enqueue(signal, 'paused')
      return { accept: false, reason: 'paused' }
    }
    return { accept: true }
  }

  /* ── 静音锁 ── */

  function activeLock() {
    if (!state.lock) return null
    if (nowTime() >= Number(state.lock.until)) return null
    return state.lock
  }

  function mute(input = {}) {
    const now = nowTime()
    let until = null
    if (input.until != null) {
      until = parseUntil(input.until, now, timeZone)
      if (until == null) throw new Error(`until 格式应为 ISO、HH:mm 或 in 式时长：${input.until}`)
    }
    const minutes = input.minutes ?? input.min ?? input.durationMin ?? null
    if (until == null) until = now + Math.max(1, Number(minutes ?? defaultMuteMin)) * 60_000
    if (!(until > now)) throw new Error('静音结束时间必须晚于现在')
    const capped = Math.min(until, now + maxMuteMs)
    const before = state.lock
    state.lock = {
      muted: true,
      since: now,
      until: capped,
      reason: String(input.reason ?? '').slice(0, 200),
      allow: Array.isArray(input.allow) ? input.allow : [],
      emergency: {
        quota: Math.max(0, Number(input.emergencyQuota ?? emergencyQuotaDefault) || 0),
        used: 0,
        log: [],
      },
    }
    persist()
    clearAwakeTick()
    emitEvent({ from: { plugin: 'time', activity: 'lock' }, kind: 'event', text: 'mute-start', tags: ['mute'], meta: { until: capped, reason: state.lock.reason, replaced: Boolean(before) } })
    log('info', 'time.mute', { until: stampAt(capped, timeZone), minutes: Math.round((capped - now) / 60_000), reason: state.lock.reason })
    return { muted: true, until: capped, allow: state.lock.allow, emergencyQuota: state.lock.emergency.quota }
  }

  function unmute(reason = 'manual') {
    const before = state.lock
    if (!before) return { muted: false, released: 0 }
    state.lock = null
    persist()
    emitEvent({ from: { plugin: 'time', activity: 'lock' }, kind: 'event', text: 'mute-end', tags: ['mute'], meta: { reason } })
    log('info', 'time.unmute', { reason, durationMin: Math.round((nowTime() - before.since) / 60_000) })
    const released = flushQueue(reason === 'timeout' ? '静音到点' : '静音结束')
    // 恢复出声后，如果接下来没有 turn，清醒节拍负责叫起一次自检。
    armAwakeTick()
    return { muted: false, released, since: before.since, until: before.until }
  }

  function expireLock(at) {
    if (!state.lock) return
    if (at >= Number(state.lock.until)) unmute('timeout')
  }

  /* ── 目标（会话轴） ── */

  function goalMessage(goal, { resume = false } = {}) {
    const bits = []
    if (resume && Number(goal.resumes) > 0) bits.push(`第 ${goal.resumes} 次续推`)
    if (goal.turnLimit != null) bits.push(`还剩 ${goal.turnLimit} 轮`)
    if (goal.until != null) bits.push(`到 ${stampAt(goal.until, timeZone)} 结束`)
    const tail = bits.length ? `（${bits.join('，')}）` : ''
    return `你在目标内：${goal.theme}${tail}。id=${goal.id}，不用时用 time_cancel 取消，别留着空跑。`
  }

  /** compact goal 的 payload：只保留目标定位（不压掉 payload 本身）。 */
  function goalCompactPayload(goal) {
    const bits = [`id=${goal.id}`, String(goal.theme)]
    if (goal.turnLimit != null) bits.push(`还剩 ${goal.turnLimit} 轮`)
    if (goal.until != null) bits.push(`到 ${stampAt(goal.until, timeZone)}`)
    if (goal.resumes != null) bits.push(`第 ${goal.resumes} 次`)
    return `目标续推：${bits.join('，')}`
  }

  function goalExpired(goal, reason) {
    send({ kind: 'goal', text: `目标结束：${goal.theme}（${goal.id}${reason ? `，${reason}` : ''}）。`, tags: ['goal', 'ended'], focus: goal.focus })
    removeGoal(goal.id)
  }

  function addGoal(input = {}) {
    const theme = String(input.theme ?? input.message ?? '').trim()
    if (!theme) throw new Error('目标需要 theme')
    const now = nowTime()
    let until = null
    if (input.until != null) {
      until = parseUntil(input.until, now, timeZone)
      if (until == null) throw new Error(`until 格式应为 ISO、HH:mm 或 in 式时长：${input.until}`)
    } else {
      const relMs = parseIn(input.afterMin != null ? `${input.afterMin}m` : (input.in ?? null))
      const durationMs = parseIn(input.durationMin != null ? `${input.durationMin}m` : (input.duration ?? null))
      const span = relMs ?? durationMs
      if (span != null) until = now + span
    }
    if (until != null && until <= now) throw new Error('目标结束时间必须晚于现在')
    const goal = {
      id: String(input.id ?? `g-${randomUUID().slice(0, 8)}`),
      theme: theme.slice(0, 200),
      until,
      turnLimit: input.turnLimit == null ? null : Math.max(1, Number(input.turnLimit) || 1),
      resumeLimit: input.resumeLimit == null ? goalMaxResumes : Math.max(1, Number(input.resumeLimit) || 1),
      resumes: 0,
      focus: input.focus == null ? null : String(input.focus),
      resumeOnStop: input.resumeOnStop !== false,
      createdAt: now,
      lastResumeAt: null,
    }
    const existing = state.goals.find((g) => g.id === goal.id)
    if (existing) {
      const lease = goalLeases.get(existing.id)
      if (lease) { try { lease.release?.() } catch { /* 已经释放 */ } goalLeases.delete(existing.id) }
    }
    state.goals = state.goals.filter((g) => g.id !== goal.id).concat(goal)
    if (goal.focus && focusApi?.enter) {
      try {
        goalLeases.set(goal.id, focusApi.enter({
          label: goal.focus,
          owner: 'time',
          reason: `goal:${goal.id}`,
          title: goal.theme,
          goal: goal.theme,
          interruptible: true,
          kind: 'goal',
        }))
      } catch (error) { log('warn', 'time.goal.focus', { id: goal.id, error: String(error?.message ?? error) }) }
    }
    send({ kind: 'goal', text: goalMessage(goal), tags: ['goal'], focus: goal.focus })
    persist()
    log('info', 'time.goal.add', { id: goal.id, until, turnLimit: goal.turnLimit, focus: goal.focus })
    return goal
  }

  function removeGoal(id) {
    const key = String(id)
    const before = state.goals.length
    state.goals = state.goals.filter((g) => g.id !== key)
    const lease = goalLeases.get(key)
    if (lease) { try { lease.release?.() } catch { /* 已经释放 */ } goalLeases.delete(key) }
    persist()
    return { removed: before !== state.goals.length }
  }

  /**
   * 尝试给一个 goal 发一次续推：先处理到期/轮次/次数/年龄，再检查最小间隔。
   * 间隔未到 → 记 resumeDueAt（tick 到点再发），返回 false；真的发了返回 true。
   */
  function resumeGoal(goal, at) {
    if (!goal.resumeOnStop) return false
    if (goal.until != null && at >= goal.until) { goalExpired(goal, '时间到'); return false }
    const gapMs = goalResumeMinGapSec * 1000
    if (gapMs > 0 && goal.lastResumeAt != null && at - Number(goal.lastResumeAt) < gapMs) {
      const dueAt = Number(goal.lastResumeAt) + gapMs
      if (goal.resumeDueAt !== dueAt) { goal.resumeDueAt = dueAt; dirty = true }
      return false
    }
    if (goal.turnLimit != null) {
      if (goal.turnLimit <= 0) { goalExpired(goal, '轮次用完'); return false }
      goal.turnLimit -= 1
    }
    goal.resumes = Number(goal.resumes ?? 0) + 1
    const limit = Number(goal.resumeLimit ?? goalMaxResumes)
    if (goal.resumes > limit) { goalExpired(goal, `连续唤醒到上限 ${limit} 次`); return false }
    if (at - Number(goal.createdAt ?? at) > goalMaxAgeMs) { goalExpired(goal, '目标存在时间过久'); return false }
    goal.lastResumeAt = at
    goal.resumeDueAt = null
    sendWake({ text: goalMessage(goal, { resume: true }), payload: goalCompactPayload(goal), producer: 'goal-resume', kind: 'goal', tags: ['goal', 'resume'], focus: goal.focus })
    noteExternalActivity(at, 'goal-resume')
    return true
  }

  /** turn-end 续推：有轮次/时间/续推次数上限，且同一 goal 受 goalResumeMinGapSec 节流。 */
  function resumeGoals() {
    if (state.phase !== 'awake') return 0
    const at = nowTime()
    let sent = 0
    for (const goal of [...state.goals]) if (resumeGoal(goal, at)) sent += 1
    persist()
    return sent
  }

  /** tick 里补发被最小间隔挡住的续推。 */
  function flushDeferredGoalResumes(at = nowTime()) {
    if (state.phase !== 'awake' || !state.goals.length) return 0
    let sent = 0
    for (const goal of [...state.goals]) {
      if (goal.resumeDueAt == null || at < Number(goal.resumeDueAt)) continue
      if (resumeGoal(goal, at)) sent += 1
      else if (goal.resumeDueAt != null && at >= Number(goal.resumeDueAt)) goal.resumeDueAt = at + Math.max(1, goalResumeMinGapSec) * 1000
    }
    if (sent) persist()
    return sent
  }

  /**
   * 每个 turn-end：记心跳、续推目标；本轮没有目标续推时安排清醒节拍。
   * 同时记录睡眠边界：如果入睡时还有在飞回合，它什么时候结束、耗时多少。
   */
  function onTurnEnd(signal) {
    const at = nowTime()
    state.lastTurnEndAt = at
    state.turnEnds = Number(state.turnEnds ?? 0) + 1
    const seq = Number(signal?.meta?.seq)
    if (Number.isFinite(seq)) state.lastTurnSeq = seq
    if (state.phase === 'sleeping' && state.sleepBoundary && state.sleepBoundary.turnEndedAt == null) {
      state.sleepBoundary.turnEndedAt = at
      state.sleepBoundary.turnEndedAfterSec = Math.max(0, Math.round((at - Number(state.sleepBoundary.at)) / 1000))
      state.sleepBoundary.overrun = state.sleepBoundary.turnEndedAfterSec > sleepGraceSec
      log('info', 'time.sleep-boundary.turn-end', { afterSec: state.sleepBoundary.turnEndedAfterSec, graceSec: sleepGraceSec, overrun: state.sleepBoundary.overrun })
      recordEvent('sleep-boundary-turn-end', { afterSec: state.sleepBoundary.turnEndedAfterSec, graceSec: sleepGraceSec, overrun: state.sleepBoundary.overrun })
      if (state.sleepBoundary.overrun) emitEvent({ from: { plugin: 'time', activity: 'sleep-boundary' }, kind: 'event', text: 'sleep-boundary-overrun', tags: ['sleep', 'boundary', 'overrun'], meta: { afterSec: state.sleepBoundary.turnEndedAfterSec, graceSec: sleepGraceSec } })
    }
    let resumed = 0
    try { resumed = resumeGoals() } catch (error) { log('warn', 'time.resume-goals', { error: String(error?.message ?? error) }) }
    if (resumed > 0) {
      // 目标续推本身就是下一次模型调用，不需要叠加清醒节拍。
      state.awakeTickDueAt = null
    } else {
      armAwakeTick()
    }
    // 心跳 v2：不检查已有 wake 安排；span/goal 活跃时 armHeartbeat 自己会清掉。
    armHeartbeat()
    persist()
    return resumed
  }

  /* ── 安排（时间轴） ── */

  function scheduleSignature(schedule) {
    const parsed = schedule.__parsed ?? parsedOf(schedule, nowTime(), timeZone)
    if (parsed.kind === 'calendar') return `calendar|${parsed.startAt}|${parsed.intervalMs}|${(parsed.weekdays ?? []).join(',')}|${parsed.untilAt ?? ''}|${parsed.count ?? ''}|${[...(parsed.skipDates ?? [])].join(',')}`
    if (parsed.kind === 'once') return `once|${parsed.at}`
    if (parsed.kind === 'daily') return `daily|${parsed.hour}:${parsed.minute}`
    return `weekly|${(parsed.weekdays ?? []).join(',')}|${parsed.hour}:${parsed.minute}`
  }

  function clearFired(id) {
    const prefix = `${id}@`
    for (const key of Object.keys(state.fired)) if (key.startsWith(prefix)) delete state.fired[key]
  }

  /** 重复安排新建/改期时：如果今天的触发点已经过去，把它记成"本轮已过"，从下一次开始。 */
  function markPastOccurrence(schedule) {
    const parsed = schedule.__parsed
    if (!parsed || parsed.kind === 'once') return
    const now = nowTime()
    const point = occurrenceAt(parsed, now, timeZone)
    if (point == null) return
    if (now - point > catchUpMs) state.fired[`${schedule.id}@${dayKey(point, timeZone)}`] = -Math.max(1, point)
  }

  function addSchedule(input) {
    const schedule = normalizeSchedule(input, nowTime(), { timeZone })
    state.schedules = state.schedules.filter((s) => s.id !== schedule.id).concat(schedule)
    // 同一个 id 重新安排 = 重新计时；清掉 fired，否则今天不会响。
    clearFired(schedule.id)
    markPastOccurrence(schedule)
    persist()
    log('info', 'time.schedule.add', { id: schedule.id, mode: schedule.mode, kind: schedule.kind, at: schedule.at })
    return schedule
  }

  function dropSchedule(id) {
    const before = state.schedules.length
    state.schedules = state.schedules.filter((s) => s.id !== String(id))
    return { removed: before !== state.schedules.length }
  }

  function removeSchedule(id) {
    const out = dropSchedule(id)
    clearFired(String(id))
    persist()
    return out
  }

  function editSchedule(id, patch = {}) {
    const current = state.schedules.find((s) => s.id === String(id))
    if (!current) return { edited: false }
    const merged = { ...current, ...patch, id: current.id }
    // 旧实现：current 一定带 at，导致 {id, in} 静默无效。这里让 in 显式压过旧 at。
    if (patch.in != null && patch.at == null) merged.at = null
    const next = normalizeSchedule(merged, nowTime(), { timeZone })
    const pointChanged = scheduleSignature(current) !== scheduleSignature(next)
    state.schedules = state.schedules.map((s) => (s.id === current.id ? next : s))
    if (pointChanged) { clearFired(current.id); markPastOccurrence(next) }
    // 进行中的长日程：编辑后同步结束时间（旧实现改不动已经开始的 span）。
    const span = state.spans.find((s) => s.id === current.id)
    if (span && next.durationMin != null) {
      span.until = nowTime() + next.durationMin * 60_000
      span.endMessage = next.sleep
        ? (next.message || '整理完了。今天看到的东西已经记下来了，接着来吧。')
        : `结束了：${next.id}`
      if (span.sleep && state.sleepingId === span.id) {
        state.sleepUntil = span.until
        state.since = nowTime()
      }
    }
    persist()
    log('info', 'time.schedule.edit', { id: current.id, pointChanged, at: next.at })
    return { edited: true, schedule: next }
  }

  /** 统一取消：长日程、安排、目标（同 id 全清），目标绑定的 focus 一起释放。 */
  function cancel(id) {
    const key = String(id)
    const parts = []
    const span = state.spans.find((s) => s.id === key)
    if (span) { endSpan(span); parts.push('长日程') }
    if (removeSchedule(key).removed) parts.push('安排')
    if (removeGoal(key).removed) parts.push('目标')
    if (!parts.length) return { cancelled: false }
    persist()
    log('info', 'time.cancel', { id: key, parts })
    return { cancelled: true, parts }
  }

  function startSchedule(schedule, atPoint = null) {
    const now = nowTime()
    const parsed = schedule.__parsed ?? parsedOf(schedule, now, timeZone)
    const point = atPoint ?? occurrenceAt(parsed, now, timeZone) ?? now
    // 日历层：skipDates 只跳 occurrence；allDay/wake:false 只展示，不产生唤醒。
    if (parsed.kind === 'calendar' && parsed.skipDates?.has(dayKey(point, timeZone))) {
      state.fired[`${schedule.id}@${dayKey(point, timeZone)}`] = now
      persist()
      return { started: false, calendarOnly: true, skipped: true }
    }
    if (schedule.wake === false || (schedule.allDay && schedule.wake !== true)) {
      state.fired[`${schedule.id}@${dayKey(point, timeZone)}`] = now
      noteExternalActivity(now, `schedule:${schedule.id}`)
      persist()
      return { started: false, calendarOnly: true }
    }
    // 通用日历事件：time 不认识消费者，插件按 tags 订阅（dream 的每日安排就是 tags:['dream']）。
    emitEvent({
      from: { plugin: 'time', activity: 'schedule' },
      kind: 'event',
      text: `schedule:${schedule.id}`,
      tags: ['schedule-start', ...(Array.isArray(schedule.tags) ? schedule.tags : [])],
      meta: {
        scheduleId: schedule.id, mode: schedule.mode, kind: schedule.kind,
        sleep: Boolean(schedule.sleep), silent: Boolean(schedule.silent),
        message: schedule.message ?? '', at: now,
      },
    })
    let outcome = { started: true }
    if (schedule.mode === 'goal') {
      addGoal({
        theme: schedule.theme || schedule.message || schedule.id,
        until: schedule.until ?? null,
        durationMin: schedule.until == null ? schedule.durationMin : null,
        turnLimit: schedule.turnLimit,
        resumeLimit: schedule.resumeLimit,
        focus: schedule.focus,
      })
      outcome = { started: schedule.id, mode: schedule.mode, kind: schedule.kind }
    } else if (schedule.kind === 'span') {
      if (schedule.sleep && activeSleepSpan()) {
        // 已经在睡：不叠加第二层睡眠（旧实现里第二层会在旧 span 结束时提前把 phase 切醒）。
        log('warn', 'time.sleep.overlap', { existing: state.sleepingId, ignored: schedule.id })
        outcome = { started: false, reason: 'already-sleeping' }
      } else if (schedule.quiet && (activeQuietSpan() || state.phase === 'sleeping')) {
        log('warn', 'time.quiet.overlap', { ignored: schedule.id, phase: state.phase })
        outcome = { started: false, reason: state.phase === 'sleeping' ? 'sleeping' : 'already-quiet' }
      } else {
        const endAt = schedule.until ?? now + (Number(schedule.durationMin) || 0) * 60_000
        if (schedule.sleep) {
          state.phase = 'sleeping'
          state.sleepingId = schedule.id
          state.since = now
          state.sleepUntil = endAt
          clearAwakeTick()
          // 睡眠边界：入睡时是否还有在飞回合（正常 = 她正在"收尾"）。
          const inFlight = state.lastTurnStartAt != null && (state.lastTurnEndAt == null || Number(state.lastTurnStartAt) > Number(state.lastTurnEndAt))
          state.sleepBoundary = {
            at: now,
            inFlight,
            turnStartAt: inFlight ? Number(state.lastTurnStartAt) : null,
            turnAgeAtEntrySec: inFlight ? Math.max(0, Math.round((now - Number(state.lastTurnStartAt)) / 1000)) : null,
            turnEndedAt: inFlight ? null : now,
            turnEndedAfterSec: inFlight ? null : 0,
            postSleepTurn: false,
            overrun: false,
            overrunLoggedAt: null,
          }
          log('info', 'time.sleep-boundary.entry', { inFlight, turnAgeAtEntrySec: state.sleepBoundary.turnAgeAtEntrySec, graceSec: sleepGraceSec })
          recordEvent('sleep-boundary-entry', { sleepingId: schedule.id, sleepUntil: endAt, inFlight, turnAgeAtEntrySec: state.sleepBoundary.turnAgeAtEntrySec, graceSec: sleepGraceSec })
          recordEvent('sleep-start', { sleepingId: schedule.id, sleepUntil: endAt })
          try {
            ensureSleepLease()
          } catch (error) { log('warn', 'time.sleep.focus', { error: String(error?.message ?? error) }) }
        }
        if (!schedule.silent) {
          // 普通 span 在开始时说 message；睡眠/安静的 message 属于"结束时"，开始时只说 startMessage
          // （默认不说）。否则 at:"now" 的睡眠安排会立刻发一条"睡够了"把自己叫醒。
          const text = (schedule.sleep || schedule.quiet)
            ? (schedule.startMessage || '')
            : (schedule.message || `开始了：${schedule.id}`)
          if (text) {
            const sent = sendWake({ text, payload: text, producer: `schedule:${schedule.id}`, kind: 'wake', tags: [schedule.sleep ? 'sleep' : (schedule.quiet ? 'quiet' : 'span')] })
            if (sent && sent.accepted === false) log('warn', 'time.wake.failed', { id: schedule.id, reason: sent.reason ?? sent.error ?? 'unknown' })
          }
        }
        state.spans.push({
          id: schedule.id,
          until: endAt,
          endMessage: schedule.sleep
            ? (schedule.message || '整理完了。今天看到的东西已经记下来了，接着来吧。')
            : (schedule.quiet ? (schedule.message || '安静结束了。') : `结束了：${schedule.id}`),
          sleep: Boolean(schedule.sleep),
          quiet: Boolean(schedule.quiet),
          silent: Boolean(schedule.silent),
          allow: Array.isArray(schedule.allow) ? schedule.allow : (schedule.quiet ? DEFAULT_QUIET_ALLOW : DEFAULT_ALLOW),
        })
        if (schedule.sleep) emitEvent({ from: { plugin: 'time' }, kind: 'event', text: 'sleep-start', tags: ['sleep'] })
        if (schedule.quiet) emitEvent({ from: { plugin: 'time' }, kind: 'event', text: 'quiet-start', tags: ['quiet'] })
        if (schedule.sleep) {
          // 醒来简报的底账：睡眠开始时间、dream 触发标记、统计基线（tick 在睡眠中不丢这些）。
          state.sleepBrief = {
            startedAt: now,
            sleepingId: schedule.id,
            dreamTriggered: true,
            statsStart: { missed: state.stats.missed, dropped: state.stats.dropped, expired: state.stats.expired },
            boundaryAtEntry: { inFlight: Boolean(state.sleepBoundary?.inFlight), turnAgeAtEntrySec: state.sleepBoundary?.turnAgeAtEntrySec ?? null },
          }
          recordEvent('sleep-brief-start', { sleepingId: schedule.id, inFlight: Boolean(state.sleepBoundary?.inFlight), dreamTriggered: true })
        }
        outcome = { started: schedule.id, mode: schedule.mode, kind: schedule.kind }
      }
    } else if (!schedule.silent) {
      const text = schedule.message || `到点了：${schedule.id}`
      const sent = sendWake({ text, payload: text, producer: `schedule:${schedule.id}`, kind: 'wake', tags: ['wake'] })
      if (sent && sent.accepted === false) log('warn', 'time.wake.failed', { id: schedule.id, reason: sent.reason ?? sent.error ?? 'unknown' })
      outcome = { started: schedule.id, mode: schedule.mode, kind: schedule.kind }
    }
    // fired 的日期用"触发点所在的那一天"，不是"现在"：跨午夜补响（daily 23:55 在
    // 00:05 才跑到）时记到昨天，今晚 23:55 还能正常响。
    state.fired[`${schedule.id}@${dayKey(point, timeZone)}`] = now
    noteExternalActivity(now, `schedule:${schedule.id}`)
    persist()
    return outcome
  }

  /** 醒来简报：睡眠时长 / 积压与来源 / dream / 异常，合并进醒来消息（红队 C4）。 */
  function buildWakeBrief(span, at) {
    const brief = state.sleepBrief ?? {}
    const startedAt = Number(brief.startedAt ?? state.since ?? at)
    const durationSec = Math.max(0, Math.round((at - startedAt) / 1000))
    const queue = state.queue
    const sources = new Map()
    for (const item of queue) {
      const key = item.from?.plugin ?? '?'
      sources.set(key, (sources.get(key) ?? 0) + 1)
    }
    const sourceText = [...sources.entries()].map(([plugin, n]) => `${plugin} ${n}`).join('、')
    const anomalies = []
    const boundary = state.lastSleepBoundary ?? state.sleepBoundary
    if (boundary?.overrun) anomalies.push('边界回合超过 grace')
    if (boundary?.postSleepTurn) anomalies.push('入睡后出现新回合')
    const start = brief.statsStart ?? {}
    const missed = Math.max(0, Number(state.stats.missed ?? 0) - Number(start.missed ?? 0))
    const dropped = Math.max(0, Number(state.stats.dropped ?? 0) - Number(start.dropped ?? 0))
    const expired = Math.max(0, Number(state.stats.expired ?? 0) - Number(start.expired ?? 0))
    if (missed) anomalies.push(`漏响 ${missed}`)
    if (dropped) anomalies.push(`丢弃 ${dropped}`)
    if (expired) anomalies.push(`过期 ${expired}`)
    let dream = '记忆整理：未触发'
    if (state.lastDreamResult) {
      const result = state.lastDreamResult
      const detail = clipBriefText(result.text ?? '', 80) || (Number(result.ranJobs) ? `${result.ranJobs} 个任务` : '')
      const shard = Number(result.degraded) ? `；分片降级${Number(result.failedShards) ? `（${result.failedShards} 片失败）` : ''}` : ''
      dream = `记忆整理：${result.ok ? '完成' : '失败'}${detail ? `（${detail}）` : ''}${shard}`
    } else if (brief.dreamTriggered !== false) {
      dream = '记忆整理：入睡时已触发（dream 回执未回传）'
    }
    const backlogText = queue.length ? `积压 ${queue.length} 条（${sourceText}）` : '没有积压'
    const anomalyText = anomalies.length ? `异常：${anomalies.join('、')}` : '无异常'
    // 睡眠期的危险/紧急消息：不叫醒，但醒来必须第一条看到。
    const alarms = queue.filter((item) => item.priority === 'alarm')
    const alarmSources = [...new Set(alarms.map((item) => item.from?.plugin ?? '?'))].join('、')
    const alarmSamples = alarms.slice(0, 2).map((item) => `[${item.from?.plugin ?? '?'}] ${String(item.text ?? '').slice(0, 60)}`)
    const alarmText = alarms.length
      ? `⚠ 睡眠期间有 ${alarms.length} 条危险/紧急事件（${alarmSources}）${alarmSamples.length ? `：${alarmSamples.join(' / ')}` : ''}`
      : null
    const text = [
      `（睡眠简报：睡了 ${fmtDuration(durationSec * 1000)}；${backlogText}；${dream}；${anomalyText}）`,
      ...(alarmText ? [alarmText] : []),
    ].join('\n')
    if (alarms.length) anomalies.push(`睡眠期危险消息 ${alarms.length} 条`)
    return {
      text,
      durationSec,
      backlog: queue.length,
      sources: sourceText,
      anomalies,
      dream,
      startedAt,
      alarms: alarms.length ? { count: alarms.length, sources: alarmSources, samples: alarmSamples } : null,
    }
  }

  function endSpan(span) {
    const known = state.spans.some((s) => s.id === span.id)
    if (!known) return { ended: false }
    state.spans = state.spans.filter((s) => s.id !== span.id)
    const isActiveSleep = span.sleep && state.sleepingId === span.id
    if (isActiveSleep) {
      // pause 期间被 cancel 时保持 paused（暂停是全局计时模式，不因结束睡眠而解除）。
      state.phase = state.phase === 'paused' ? 'paused' : 'awake'
      state.sleepingId = null
      state.sleepUntil = null
      state.since = nowTime()
      // 归档本次睡眠的边界事实（供报告/validity 用），睡眠中的边界不再活跃。
      if (state.sleepBoundary) {
        state.lastSleepBoundary = { ...state.sleepBoundary, endedAt: nowTime() }
        state.sleepBoundary = null
      }
      // 醒来简报：睡眠时长 / 积压与来源 / dream / 异常，合并进醒来消息（不额外刷屏）。
      let wakeBrief = null
      try { wakeBrief = buildWakeBrief(span, nowTime()) } catch (error) { log('warn', 'time.wake-brief', { error: String(error?.message ?? error) }) }
      if (wakeBrief) state.lastSleepBrief = { ...wakeBrief, endedAt: nowTime() }
      state.sleepBrief = null
      emitEvent({ from: { plugin: 'time' }, kind: 'event', text: 'sleep-end', tags: ['sleep'] })
      // 睡醒第一声：reset 后按 full（compactWake 生命周期）
      resetWakeCount('sleep-end')
      if (!span.silent) {
        const text = wakeBrief ? `${span.endMessage}\n${wakeBrief.text}` : span.endMessage
        const payload = wakeBrief ? wakeBrief.text : span.endMessage
        sendWake({ text, payload, producer: 'sleep-end', kind: 'wake', tags: wakeBrief ? ['wake', 'wake-brief'] : ['wake'] })
      }
      const released = flushQueue('你睡觉时')
      recordEvent('sleep-end', { sleepingId: span.id, released, boundary: state.lastSleepBoundary ? { inFlight: Boolean(state.lastSleepBoundary.inFlight), turnEndedAfterSec: state.lastSleepBoundary.turnEndedAfterSec ?? null, postSleepTurn: Boolean(state.lastSleepBoundary.postSleepTurn), overrun: Boolean(state.lastSleepBoundary.overrun) } : null })
      if (wakeBrief) recordEvent('wake-brief', { sleepingId: span.id, released, backlog: wakeBrief.backlog, sources: wakeBrief.sources, anomalies: wakeBrief.anomalies, dream: wakeBrief.dream, durationSec: wakeBrief.durationSec })
      // 最后再释放睡眠租约：focus 的积压摘要会走 signals.offer，醒来后再进队，避免顺序打乱。
      if (sleepLease) { try { releaseSleepLeases() } catch { /* 已经释放 */ } }
      // 醒来后如果没有新的 turn 触发，清醒节拍负责在 idleSec 内叫起一次自检。
      armAwakeTick()
      persist()
      return { ended: true, released }
    }
    if (span.quiet === true) {
      let released = 0
      if (state.phase === 'awake' && !span.silent) {
        const text = span.endMessage || '安静结束了。'
        sendWake({ text, payload: text, producer: 'quiet-end', kind: 'wake', tags: ['wake', 'quiet-end'] })
      }
      if (state.phase === 'awake') released = flushQueue('你安静时')
      recordEvent('quiet-end', { quietId: span.id, released })
      armAwakeTick()
      persist()
      return { ended: true, released }
    }
    // 非活动 span（例如旧睡眠被新睡眠顶掉之后才到期）：只清理，不再发结束语吵人。
    persist()
    return { ended: true, released: 0, stale: true }
  }

  /* ── 暂停（冻结计时，不只是停 tick） ── */

  function pause(reason = 'time-pause') {
    if (state.phase === 'paused') return { paused: true, already: true, since: state.pausedAt, reason: state.pauseReason }
    state.pausedAt = nowTime()
    state.pauseReason = String(reason ?? 'time-pause').slice(0, 200)
    state.phase = 'paused'
    clearAwakeTick()
    clearHeartbeat()
    persist()
    recordEvent('pause-on', { reason: state.pauseReason, since: state.pausedAt })
    log('info', 'time.pause', { at: state.pausedAt, reason: state.pauseReason })
    return { paused: true, since: state.pausedAt, reason: state.pauseReason }
  }

  /**
   * 外部暂停模式（用户语义：任务停止、世界继续、危险穿透）。
   * mc-body/mc-link 的 mcb_stop 应调用它；不冻结 time 计时（schedule/sleep 照常）。
   */
  function setPausedMode(input = {}) {
    const active = input.active !== false
    const previous = state.pausedMode?.lastPierce ?? null
    state.pausedMode = {
      active,
      reason: active ? String(input.reason ?? 'external-pause').slice(0, 200) : null,
      since: active ? nowTime() : null,
      source: active ? String(input.source ?? 'external') : null,
      lastPierce: active ? previous : null,
    }
    persist()
    recordEvent(active ? 'paused-mode-on' : 'paused-mode-off', { reason: state.pausedMode.reason, source: state.pausedMode.source })
    log('info', 'time.paused-mode', { active, reason: state.pausedMode.reason, source: state.pausedMode.source })
    return { pausedMode: status().pausedMode }
  }

  function resume() {
    if (state.phase !== 'paused') return { resumed: false, phase: state.phase }
    const now = nowTime()
    const delta = state.pausedAt ? Math.max(0, now - state.pausedAt) : 0
    // 冻结的是"计时"：长日程、目标期限、一次性安排、静音锁、睡眠结束都整体后移。
    for (const span of state.spans) span.until = Number(span.until) + delta
    if (state.sleepUntil) state.sleepUntil = Number(state.sleepUntil) + delta
    for (const goal of state.goals) if (goal.until != null) goal.until = Number(goal.until) + delta
    for (const schedule of state.schedules) {
      if (schedule.__parsed?.kind !== 'once') continue
      schedule.__parsed.at = Number(schedule.__parsed.at) + delta
      schedule.at = new Date(schedule.__parsed.at).toISOString()
    }
    if (state.lock) state.lock.until = Number(state.lock.until) + delta
    state.pausedAt = null
    state.pauseReason = null
    const sleeping = Boolean(activeSleepSpan())
    state.phase = sleeping ? 'sleeping' : 'awake'
    state.since = now
    persist()
    // 恢复后如果还在睡眠，积压应该留到醒来一起放；不要在睡着时倒给模型。
    const released = sleeping ? 0 : flushQueue('暂停期间')
    if (!sleeping) { armAwakeTick(); armHeartbeat() }
    log('info', 'time.resume', { deltaMs: delta, phase: state.phase, released })
    return { resumed: true, released, phase: state.phase, deltaMs: delta }
  }

  function wake() {
    const span = state.spans.find((s) => s.sleep)
    if (span) return endSpan(span)
    if (state.phase === 'sleeping') {
      state.phase = 'awake'
      state.sleepingId = null
      state.sleepUntil = null
      state.since = nowTime()
      if (state.sleepBoundary) {
        state.lastSleepBoundary = { ...state.sleepBoundary, endedAt: nowTime() }
        state.sleepBoundary = null
      }
      if (sleepLease) { try { releaseSleepLeases() } catch { /* 已经释放 */ } }
      resetWakeCount('manual-wake')
      sendWake({ text: '你醒了。', payload: '你醒了。', producer: 'manual-wake', kind: 'wake', tags: ['wake'] })
      armAwakeTick()
      return { ended: true, released: flushQueue('你睡觉时') }
    }
    return { ended: false }
  }

  /* ── tick：到点判定、到期、落盘 ── */

  function pruneFired(now) {
    for (const [key, at] of Object.entries(state.fired)) {
      if (Number(at) > 0 && now - Number(at) > firedRetentionMs) delete state.fired[key]
    }
  }

  function missedSchedule(schedule, point, now) {
    state.fired[`${schedule.id}@${dayKey(point, timeZone)}`] = -Math.max(1, now)
    state.stats.missed += 1
    log('warn', 'time.schedule.missed', { id: schedule.id, at: stampAt(point, timeZone), lateMs: now - point })
    if (schedule.__parsed?.kind === 'once') dropSchedule(schedule.id)
  }

  function tick(at = nowTime()) {
    if (ticking) return { skipped: 'reentrant' }
    ticking = true
    try {
      processInbox()
      if (state.phase === 'paused') { if (dirty) persist(); return { skipped: 'paused' } }
      expireLock(at)

      for (const span of [...state.spans]) {
        if (at >= Number(span.until)) endSpan(span)
      }

      const alive = []
      for (const goal of state.goals) {
        if (goal.until != null && at >= Number(goal.until)) { goalExpired(goal, '时间到'); continue }
        alive.push(goal)
      }
      if (alive.length !== state.goals.length) state.goals = alive
      // 被最小间隔挡住的 goal 续推，到点在 tick 里补发。
      if (state.goals.length) flushDeferredGoalResumes(at)

      for (const schedule of [...state.schedules]) {
        let parsed
        try { parsed = parsedOf(schedule, at, timeZone) } catch (error) {
          log('warn', 'time.schedule.unparsable', { id: schedule.id, error: String(error?.message ?? error) })
          dropSchedule(schedule.id)
          continue
        }
        const point = occurrenceAt(parsed, at, timeZone)
        if (point == null || at < point) continue
        const key = `${schedule.id}@${dayKey(point, timeZone)}`
        if (state.fired[key]) continue
        const grace = parsed.kind === 'once' ? onceCatchUpMs : catchUpMs
        if (at - point > grace) { missedSchedule(schedule, point, at); continue }
        startSchedule(schedule, point)
        // 一次性安排响过就删（daily/weekly 保留）；别在 time.json 里堆一次性的残骸。
        if (parsed.kind === 'once') dropSchedule(schedule.id)
      }

      pruneFired(at)
      // 睡眠边界：入睡时的在飞回合超过 grace 还在跑 → 发一次 overrun 事件（driver 订阅后 cancel）。
      if (state.phase === 'sleeping' && state.sleepBoundary && state.sleepBoundary.turnEndedAt == null) {
        const boundaryAgeSec = Math.round((at - Number(state.sleepBoundary.at)) / 1000)
        if (sleepGraceSec > 0 && boundaryAgeSec > sleepGraceSec && !state.sleepBoundary.overrunLoggedAt) {
          state.sleepBoundary.overrunLoggedAt = at
          state.sleepBoundary.overrun = true
          dirty = true
          log('warn', 'time.sleep-boundary.overrun', { afterSec: boundaryAgeSec, graceSec: sleepGraceSec })
          recordEvent('sleep-boundary-overrun', { afterSec: boundaryAgeSec, graceSec: sleepGraceSec, sleepingId: state.sleepingId })
          emitEvent({ from: { plugin: 'time', activity: 'sleep-boundary' }, kind: 'event', text: 'sleep-boundary-overrun', tags: ['sleep', 'boundary', 'overrun'], meta: { afterSec: boundaryAgeSec, graceSec: sleepGraceSec } })
        }
      }
      maybeHeartbeat(at)
      maybeAwakeTick(at)
      // 醒着长时间没有 turn 活动 = 可观测异常（自检本该在 idleSec 内把它救回来）。
      if (awakeTickEnabled && !awakeSuppressed() && state.lastTurnEndAt != null) {
        const idleSec = (at - Number(state.lastTurnEndAt)) / 1000
        if (idleSec > awakeOverdueSec) {
          if (!state.heartbeatOverdueLoggedAt || at - Number(state.heartbeatOverdueLoggedAt) > 10 * 60_000) {
            state.heartbeatOverdueLoggedAt = at
            dirty = true
            log('warn', 'time.heartbeat.overdue', { idleSec: Math.round(idleSec), thresholdSec: awakeOverdueSec, queued: state.queue.length })
          }
        }
      }
      if (dirty || state.queue.length || state.spans.length || state.goals.length || state.awakeTickDueAt != null || state.heartbeatDueAt != null) persist()
      return { at }
    } catch (error) {
      state.lastTickError = { at, error: String(error?.stack ?? error) }
      dirty = true
      writeSideFile(path.join(dir, 'tick-error.json'), String(error?.stack ?? error))
      log('warn', 'time.tick', { error: String(error?.message ?? error) })
      return { error: String(error?.message ?? error) }
    } finally {
      ticking = false
    }
  }

  /* ── 控制后门：文件邮箱 ── */

  let inboxOffset = state.inboxOffset

  function processInbox() {
    let text = ''
    try { text = fs.readFileSync(inboxFile, 'utf8') } catch (error) {
      if (error?.code === 'ENOENT') return { processed: 0 } // 没启用控制后门时文件不存在，正常
      log('warn', 'time.inbox.read', { error: String(error?.message ?? error) })
      return { processed: 0 }
    }
    // 文件被截断/重建时 offset 会比长度大，必须归零，否则永远读不到新命令。
    if (text.length < inboxOffset) { log('warn', 'time.inbox.truncated', { offset: inboxOffset, length: text.length }); inboxOffset = 0 }
    if (text.length <= inboxOffset) return { processed: 0 }
    const chunk = text.slice(inboxOffset)
    inboxOffset = text.length
    let processed = 0
    for (const line of chunk.split('\n')) {
      const raw = line.trim()
      if (!raw) continue
      let request = null
      try { request = JSON.parse(raw) } catch {
        state.stats.inboxBad += 1
        log('warn', 'time.inbox.bad-line', { line: raw.slice(0, 120) })
        continue
      }
      let result
      try {
        result = runCommand(request)
      } catch (error) {
        writeSideFile(path.join(dir, 'inbox-error.json'), String(error?.stack ?? error))
        log('warn', 'time.inbox.command', { cmd: request?.cmd, error: String(error?.message ?? error) })
        result = { ok: false, error: String(error?.message ?? error) }
      }
      try {
        fs.mkdirSync(dir, { recursive: true })
        fs.appendFileSync(outboxFile, `${JSON.stringify({ id: request?.id ?? null, at: nowTime(), ...result })}\n`, 'utf8')
      } catch (error) { log('warn', 'time.outbox.write', { error: String(error?.message ?? error) }) }
      if (result?.ok !== false) noteExternalActivity(nowTime(), `inbox:${request?.cmd}`)
      processed += 1
    }
    state.inboxOffset = inboxOffset
    persist()
    return { processed }
  }

  function runCommand(request) {
    const cmd = String(request?.cmd ?? '')
    const args = request?.args ?? {}
    try {
      switch (cmd) {
        case 'status': return { ok: true, result: api.status() }
        case 'pause': return { ok: true, result: pause(args?.reason ?? 'time-pause') }
        case 'resume': return { ok: true, result: resume() }
        case 'pause_mode':
        case 'paused_mode': return { ok: true, result: setPausedMode(args) }
        case 'arrange': return { ok: true, result: addSchedule(args) }
        case 'cancel': return { ok: true, result: cancel(args.id) }
        case 'edit': return { ok: true, result: editSchedule(args.id, args) }
        case 'skip': return { ok: true, result: api.skip(args.id) }
        case 'queue': return { ok: true, result: api.queue() }
        case 'mute': return { ok: true, result: mute(args) }
        case 'unmute': return { ok: true, result: unmute(args?.reason ?? 'manual') }
        case 'lock': return { ok: true, result: activeLock() }
        case 'wake': return { ok: true, result: wake() }
        case 'clock': return { ok: true, result: advanceClock(args) }
        case 'reset': {
          for (const lease of goalLeases.values()) { try { lease.release?.() } catch { /* 已经释放 */ } }
          goalLeases.clear()
          if (sleepLease) { try { releaseSleepLeases() } catch { /* 已经释放 */ } }
          const offset = state.inboxOffset
          state = blank()
          state.inboxOffset = offset
          persist()
          log('info', 'time.reset', { offset })
          return { ok: true, result: { phase: state.phase } }
        }
        case 'goal_add': return { ok: true, result: addGoal(args) }
        case 'goal_remove': return { ok: true, result: removeGoal(args.id) }
        case 'goal_list': return { ok: true, result: api.goals() }
        default: return { ok: false, error: `未知命令：${cmd}` }
      }
    } catch (error) { return { ok: false, error: String(error?.message ?? error) } }
  }

  /* ── 查询面 ── */

  function phaseText() {
    return ({ awake: '醒着', sleeping: '睡着', paused: '计时暂停' })[state.phase] ?? state.phase
  }

  function nextUpcoming(now = nowTime()) {
    let best = null
    for (const schedule of state.schedules) {
      let parsed
      try { parsed = parsedOf(schedule, now, timeZone) } catch { continue }
      const point = nextOccurrence(parsed, now, timeZone)
      if (point == null) continue
      if (!best || point < best.point) best = { schedule, parsed, point }
    }
    return best
  }

  function describeSchedule(schedule, now = nowTime()) {
    let parsed = null
    try { parsed = parsedOf(schedule, now, timeZone) } catch { /* 坏数据在清单里显示原文 */ }
    const bits = []
    if (parsed) {
      bits.push(describeParsed(parsed))
      const next = nextOccurrence(parsed, now, timeZone)
      if (next != null) bits.push(`${stampAt(next, timeZone)}（${fmtRelative(next, now)}）`)
    } else {
      bits.push(`at=${schedule.at}`)
    }
    bits.push(schedule.mode === 'goal' ? '目标模式' : '唤醒')
    if (schedule.kind === 'span') bits.push(`长日程${schedule.durationMin ? ` ${fmtDuration(schedule.durationMin * 60_000)}` : ''}`)
    if (schedule.sleep) bits.push('睡觉')
    if (schedule.quiet) bits.push('安静')
    if (schedule.silent) bits.push('静默')
    if (Array.isArray(schedule.tags) && schedule.tags.length) bits.push(`tags:${schedule.tags.join('/')}`)
    const label = schedule.message || schedule.theme || ''
    return `${schedule.id}：${bits.join('，')}${label ? ` —— ${label}` : ''}`
  }

  /** 心跳可观测面：给 time_status / status() / 外部监督者用。 */
  function heartbeatStatus() {
    const now = nowTime()
    const suppressed = awakeSuppressed()
    const lastTurnEndAt = state.lastTurnEndAt == null ? null : Number(state.lastTurnEndAt)
    const idleSec = state.phase === 'awake' && lastTurnEndAt != null ? Math.max(0, Math.round((now - lastTurnEndAt) / 1000)) : null
    const lastHour = (Array.isArray(state.awakeTickSentAt) ? state.awakeTickSentAt : []).filter((ts) => now - Number(ts) <= 3_600_000)
    let heartbeatState = 'awake'
    if (state.phase === 'sleeping') heartbeatState = 'sleeping'
    else if (state.phase === 'paused') heartbeatState = 'paused'
    else if (state.lock) heartbeatState = 'muted'
    else if (suppressed) heartbeatState = 'suppressed'
    else if (idleSec != null && idleSec > awakeOverdueSec) heartbeatState = 'overdue'
    return {
      enabled: awakeTickEnabled,
      state: heartbeatState,
      mode: awakeImmediate ? 'immediate' : 'normal',
      thresholdSec: awakeIdleSec,
      overdueSec: awakeOverdueSec,
      idleSec,
      armDelaySec: state.awakeTickBackoff ? awakeBackoffSec : awakeArmDelaySec,
      minIdleSec: awakeImmediate ? awakeMinIdleSec : null,
      streak: Number(state.awakeTickStreak ?? 0),
      backoff: Boolean(state.awakeTickBackoff),
      backoffSec: awakeBackoffSec,
      lastActivityAt: state.awakeTickLastActivityAt ?? null,
      lastTurnEndAt,
      lastTurnStartAt: state.lastTurnStartAt ?? null,
      lastModelCallAt: state.lastTurnStartAt ?? lastTurnEndAt,
      nextTickAt: state.awakeTickDueAt ?? null,
      lastAwakeTickAt: state.lastAwakeTickAt ?? null,
      ticksLastHour: lastHour.length,
      maxPerHour: awakeMaxPerHour,
      capped: Boolean(state.awakeTickCappedAt && now - Number(state.awakeTickCappedAt) < 3_600_000),
      // 反应时延：turn-end→下一 turn/start；task/信号到达→下一 turn/start。
      decisionCycleSec: state.lastDecisionCycleSec ?? null,
      reactionLatencySec: state.lastReactionLatencySec ?? null,
      reactionPendingAt: state.reactionPendingAt ?? null,
      pendingBacklog: state.queue.length,
      turnEnds: Number(state.turnEnds ?? 0),
      // 全局兜底心跳 v2（模型用 frequency 控制，不按间隔）
      globalEnabled: true,
      frequency: clampHeartbeatFrequency(state.heartbeatFrequency),
      estimated: heartbeatEstimate(),
      globalDueAt: state.heartbeatDueAt != null ? Number(state.heartbeatDueAt) : null,
      globalLastAt: state.heartbeatLastAt != null ? Number(state.heartbeatLastAt) : null,
      pausedBy: heartbeatSuppressed()
        ? (state.phase !== 'awake' ? 'phase' : (state.spans.length ? 'span' : (state.goals.length ? 'goal' : 'other')))
        : null,
      globalStats: { ...state.heartbeatStats },
    }
  }

  function status() {
    const now = nowTime()
    return {
      phase: state.phase,
      since: state.since,
      sleepingId: state.sleepingId,
      sleepUntil: state.sleepUntil ?? null,
      pausedAt: state.pausedAt ?? null,
      lock: state.lock ? { muted: Boolean(activeLock()), since: state.lock.since, until: state.lock.until, reason: state.lock.reason, allow: state.lock.allow, emergency: { quota: state.lock.emergency?.quota ?? 0, used: state.lock.emergency?.used ?? 0 } } : null,
      spans: state.spans.map((s) => ({ ...s })),
      schedules: state.schedules.map(({ __parsed, ...rest }) => rest),
      backlog: state.queue.length,
      queueByPlugin: reasonCounts(),
      goals: state.goals.map((g) => ({ ...g })),
      heartbeat: heartbeatStatus(),
      sleepBoundary: state.sleepBoundary ? { ...state.sleepBoundary } : null,
      lastSleepBoundary: state.lastSleepBoundary ? { ...state.lastSleepBoundary } : null,
      lastSleepBrief: state.lastSleepBrief ? { ...state.lastSleepBrief } : null,
      lastDreamResult: state.lastDreamResult ? { ...state.lastDreamResult } : null,
      // 用户语义：暂停 = 任务停止、世界继续、危险穿透。mc-body/mc-link 读它对齐文案。
      pausedMode: {
        active: pausedActive(),
        phasePaused: state.phase === 'paused',
        external: Boolean(state.pausedMode?.active),
        reason: state.pausedMode?.active ? state.pausedMode.reason : (state.phase === 'paused' ? (state.pauseReason ?? 'time-pause') : null),
        since: state.pausedMode?.active ? state.pausedMode.since : (state.phase === 'paused' ? state.pausedAt : null),
        source: state.pausedMode?.active ? state.pausedMode.source : (state.phase === 'paused' ? 'time' : null),
        worldContinues: true,
        alarmsPierce: true,
        lastPierce: state.lastPierce ? { ...state.lastPierce } : null,
        lastBlockedAlarm: state.lastBlockedAlarm ? { ...state.lastBlockedAlarm } : null,
      },
      lastPierce: state.lastPierce ? { ...state.lastPierce } : null,
      lastBlockedAlarm: state.lastBlockedAlarm ? { ...state.lastBlockedAlarm } : null,
      wake: {
        enabled: compactWakeEnabled,
        count: Number(state.wakeCount ?? 0),
        nextMode: compactWakeMode(),
        stats: { ...state.wakeStats },
        lastWakeAt: state.lastWakeAt ?? null,
        config: { after: compactWakeAfter, maxChars: compactWakeMaxChars, fullEvery: compactWakeFullEvery, allowPayload: compactWakeAllowPayload },
      },
      goalResumeMinGapSec,
      missed: state.stats.missed,
      dropped: state.stats.dropped,
      overflow: state.stats.overflow,
      expired: state.stats.expired,
      lastTickError: state.lastTickError,
      lastPersistError: state.lastPersistError,
      now,
    }
  }

  /** 结构化时间视图：模型 status 与未来 GUI 共用同一份数据（只读、无副作用）。 */
  function calendarDayStart(at) {
    const p = partsOf(at, timeZone)
    return zonedEpoch({ y: p.y, m: p.m, d: p.d, h: 0, min: 0 }, timeZone)
  }

  function calendarEventsBetween(from, to) {
    const out = []
    const max = 200
    for (const schedule of state.schedules) {
      let parsed
      try { parsed = parsedOf(schedule, nowTime(), timeZone) } catch { continue }
      let cursor = from - 1
      for (let guard = 0; guard < max; guard += 1) {
        const point = nextOccurrence(parsed, cursor, timeZone)
        if (point == null || point > to) break
        cursor = point
        if (point < from) continue
        const endAt = schedule.endDate
          ? endOfCalendarDate(schedule.endDate, timeZone)
          : (schedule.durationMin != null ? point + Number(schedule.durationMin) * 60_000 : point)
        out.push({
          id: schedule.id,
          title: schedule.theme || schedule.message || schedule.id,
          startAt: point,
          endAt,
          allDay: Boolean(schedule.allDay),
          wake: schedule.wake !== false,
          mode: schedule.mode,
          kind: schedule.kind,
          sleep: Boolean(schedule.sleep),
          silent: Boolean(schedule.silent),
        })
      }
    }
    return out.sort((a, b) => a.startAt - b.startAt)
  }

  function calendarView(now = nowTime()) {
    const today = calendarDayStart(now)
    const tomorrow = today + CAL_DAY_MS
    const week = today + 7 * CAL_DAY_MS
    return {
      today: calendarEventsBetween(today, tomorrow - 1),
      tomorrow: calendarEventsBetween(tomorrow, tomorrow + CAL_DAY_MS - 1),
      week: calendarEventsBetween(today, week - 1),
    }
  }

  function timeView() {
    const now = nowTime()
    const next = nextUpcoming(now)
    const hb = heartbeatStatus()
    const preview = state.queue.slice(-3).map((row) => ({
      source: `${row.from?.plugin ?? '?'}${row.from?.activity ? `/${row.from.activity}` : ''}`,
      text: String(row.text ?? '').slice(0, 160),
      reason: row.reason ?? null,
      at: row.at ?? null,
    }))
    return {
      at: now,
      iso: new Date(now).toISOString(),
      phase: state.phase,
      phaseText: phaseText(),
      next: next ? {
        id: next.schedule.id,
        mode: next.schedule.mode ?? 'wake',
        kind: next.schedule.kind ?? 'single',
        at: next.point,
        relative: fmtRelative(next.point, now),
        label: describeParsed(next.parsed),
      } : null,
      spans: state.spans.map((span) => ({
        id: span.id,
        sleep: Boolean(span.sleep),
        until: Number(span.until),
        relative: fmtRelative(Number(span.until), now),
      })),
      goals: state.goals.map((goal) => ({
        id: goal.id,
        theme: goal.theme,
        turnLimit: goal.turnLimit ?? null,
        until: goal.until ?? null,
        resumes: Number(goal.resumes ?? 0),
      })),
      sleep: state.sleepingId == null ? null : {
        id: state.sleepingId,
        until: state.sleepUntil == null ? null : Number(state.sleepUntil),
      },
      lock: state.lock ? {
        until: Number(state.lock.until),
        relative: fmtRelative(Number(state.lock.until), now),
        reason: state.lock.reason ?? null,
        emergencyQuota: Number(state.lock.emergency?.quota ?? 0),
        emergencyUsed: Number(state.lock.emergency?.used ?? 0),
      } : null,
      paused: pausedActive(),
      backlog: { count: state.queue.length, bySource: reasonCounts(), preview },
      heartbeat: {
        frequency: hb.frequency,
        estimated: hb.estimated.text,
        dueAt: hb.globalDueAt,
        pausedBy: hb.pausedBy,
      },
      calendar: calendarView(now),
      dropped: {
        missed: state.stats.missed,
        overflow: state.stats.overflow,
        expired: state.stats.expired,
        total: state.stats.dropped,
      },
    }
  }

  function statusText() {
    const now = nowTime()
    const lines = ['【现在】']
    lines.push(`现在：${stampAt(now, timeZone)}。`)
    // 四个会"压住她"的状态写成一行的中文，别让她去读 JSON 字段名。
    const bits = [phaseText()]
    if (state.phase === 'sleeping' && state.sleepUntil) bits.push(`睡到 ${stampAt(Number(state.sleepUntil), timeZone)}（${fmtRelative(Number(state.sleepUntil), now)}）`)
    if (state.phase === 'paused' && state.pausedAt) bits.push(`暂停自 ${stampAt(state.pausedAt, timeZone)}`)
    if (state.lock) {
      const lock = state.lock
      const left = Math.max(0, Number(lock.emergency?.quota ?? 0) - Number(lock.emergency?.used ?? 0))
      bits.push(`静音到 ${stampAt(Number(lock.until), timeZone)}（${fmtRelative(Number(lock.until), now)}${lock.reason ? `，${lock.reason}` : ''}；紧急剩余 ${left}/${Number(lock.emergency?.quota ?? 0)}）`)
    }
    const quietSpan = activeQuietSpan()
    if (quietSpan) bits.push(`安静到 ${stampAt(Number(quietSpan.until), timeZone)}（${fmtRelative(Number(quietSpan.until), now)}）`)
    if (state.queue.length) bits.push(`积压 ${state.queue.length} 条（${reasonCounts()}）`)
    lines.push(`状态：${bits.join('；')}。`)
    // 暂停语义（用户拍板）：任务停止、世界继续、危险会穿透。给 mc-body/mc-link 对齐的口径。
    if (pausedActive()) {
      lines.push('【暂停】')
      const mode = state.pausedMode?.active ? `${state.pausedMode.source ?? 'external'}：${state.pausedMode.reason ?? ''}` : `time：${state.pauseReason ?? 'time-pause'}`
      const pierce = state.lastPierce
        ? `；最近穿透：${state.lastPierce.plugin}（${stampAt(Number(state.lastPierce.at), timeZone)}，${(state.lastPierce.tags ?? []).join('/')}）`
        : ''
      lines.push(`暂停（${mode}）：任务停止、世界继续；危险（alarm/safety）会穿透并叫醒你${pierce}。`)
      const preserved = []
      if (state.goals.length) preserved.push(`目标 ${state.goals.map((goal) => goal.id).join('、')}`)
      const focusLease = focusApi?.current?.()
      if (focusLease) preserved.push(`专注 ${focusLease.title ?? focusLease.label}`)
      if (preserved.length) lines.push(`保留：${preserved.join('；')}（继续用 time_resume / focus_leave；离开用 time_cancel）。`)
    }
    if (state.phase === 'sleeping' && state.sleepBoundary) {
      lines.push('【睡眠边界】')
      const boundary = state.sleepBoundary
      if (boundary.turnEndedAt == null) {
        const age = Math.round((now - Number(boundary.at)) / 1000)
        lines.push(`睡眠边界：入睡时有在飞回合（已 ${age} 秒，grace ${sleepGraceSec} 秒${boundary.overrun ? '，已超时' : ''}）。`)
      } else if (boundary.postSleepTurn) {
        lines.push('⚠ 睡眠边界：入睡后出现新回合（疑似外部直投；session/prompt 不经过 time gate）。')
      }
    }
    lines.push('【下一次】')
    const next = nextUpcoming(now)
    if (next) lines.push(`下一个安排：${next.schedule.id}（${describeParsed(next.parsed)}，${fmtRelative(next.point, now)}）。`)
    else lines.push('没有下一个安排。')
    const cal = timeView().calendar
    const calLine = (event) => `· ${event.allDay ? '全天' : timeOnly(event.startAt, timeZone)} ${event.title}（${event.id}${event.wake ? '' : '，仅展示'}）`
    const pushCalBlock = (title, events) => {
      if (!events.length) return
      lines.push(title)
      for (const event of events.slice(0, 8)) lines.push(calLine(event))
      if (events.length > 8) lines.push(`· …还有 ${events.length - 8} 条`)
    }
    pushCalBlock('【今天】', cal.today)
    pushCalBlock('【明天】', cal.tomorrow)
    const rest = cal.week.filter((event) => !cal.today.some((x) => x.id === event.id && x.startAt === event.startAt)
      && !cal.tomorrow.some((x) => x.id === event.id && x.startAt === event.startAt))
    pushCalBlock('【本周】', rest)
    if (state.spans.length) {
      lines.push('【进行中】')
      lines.push(`进行中：${state.spans.map((s) => `${s.id}${s.sleep ? '（睡觉）' : (s.quiet ? '（安静）' : '')} 到 ${stampAt(Number(s.until), timeZone)}`).join('；')}。`)
    }
    if (state.goals.length) {
      lines.push('【目标】')
      lines.push(`目标：${state.goals.map((g) => `${g.id} ${g.theme}${g.turnLimit != null ? `（剩 ${g.turnLimit} 轮）` : ''}${g.until != null ? `（到 ${stampAt(g.until, timeZone)}）` : ''}`).join('；')}。`)
    }
    const hb = heartbeatStatus()
    lines.push('【心跳】')
    if (state.phase === 'awake') {
      const pausedBy = hb.pausedBy === 'span' ? '进行中的长日程' : hb.pausedBy === 'goal' ? '活跃目标' : hb.pausedBy === 'phase' ? '睡眠/暂停' : null
      const nextText = pausedBy
        ? `暂停（${pausedBy}）`
        : (hb.globalDueAt ? `预计 ${fmtRelative(Number(hb.globalDueAt), now)}醒` : '等下一次回合结束后排')
      lines.push(`心跳：活跃度 ${hb.frequency}（约 ${hb.estimated.text} 随机醒一次）；${nextText}。`)
    } else if (state.phase === 'sleeping') {
      lines.push('心跳：睡眠中（长日程会自动暂停心跳，醒来恢复）。')
    } else {
      lines.push('心跳：计时暂停。')
    }
    if (state.stats.missed || state.stats.dropped || state.stats.expired) {
      lines.push('【异常】')
      lines.push(`丢弃：漏响 ${state.stats.missed}、溢出 ${state.stats.overflow}、过期 ${state.stats.expired}（累计丢弃 ${state.stats.dropped}）。`)
    }
    return lines.join('\n')
  }

  function listText() {
    const now = nowTime()
    const lines = []
    const schedules = state.schedules.slice().sort((a, b) => {
      let pa = nextOccurrence(parsedOf(a, now, timeZone), now, timeZone)
      let pb = nextOccurrence(parsedOf(b, now, timeZone), now, timeZone)
      return (pa ?? Infinity) - (pb ?? Infinity) || String(a.id).localeCompare(String(b.id))
    })
    if (schedules.length) {
      lines.push(`安排（${schedules.length}）：`)
      for (const schedule of schedules.slice(0, listLimit)) lines.push(`· ${describeSchedule(schedule, now)}`)
      if (schedules.length > listLimit) lines.push(`· …还有 ${schedules.length - listLimit} 条`)
    } else {
      lines.push('还没有安排。')
    }
    if (state.goals.length) {
      lines.push(`目标（${state.goals.length}）：`)
      for (const goal of state.goals) {
        const bits = [`id=${goal.id}`, goal.theme]
        if (goal.turnLimit != null) bits.push(`剩 ${goal.turnLimit} 轮`)
        if (goal.until != null) bits.push(`到 ${stampAt(goal.until, timeZone)}`)
        bits.push(`已唤醒 ${goal.resumes ?? 0} 次`)
        if (goal.focus) bits.push(`focus:${goal.focus}`)
        lines.push(`· ${bits.join('，')}`)
      }
    }
    if (state.queue.length) {
      lines.push(`积压（${state.queue.length}）：`)
      for (const item of state.queue.slice(0, listLimit)) {
        const source = `${item.from?.plugin ?? '?'}${item.from?.activity ? `/${item.from.activity}` : ''}`
        const sig = item.signalId ? `，sig=${item.signalId}` : ''
        lines.push(`· [${source}] ${String(item.text ?? '')}（${item.reason ?? '?'}，id=${item.id}${sig}）`)
      }
      if (state.queue.length > listLimit) lines.push(`· …还有 ${state.queue.length - listLimit} 条`)
    }
    return lines.join('\n')
  }

  function timeFacts() {
    const now = nowTime()
    const p = partsOf(now, timeZone)
    const phase = phaseText()
    // 精确到分钟会每分钟让提示词前缀失效；DSH 每步已注入精确时间。
    // 这里给"日期 + 时段 + 阶段"，只有状态变化时才变。
    const hourText = p.h < 6 ? '凌晨' : p.h < 12 ? '上午' : p.h < 18 ? '下午' : p.h < 23 ? '晚上' : '深夜'
    let line = `时间：${p.y}-${pad2(p.m)}-${pad2(p.d)} 周${WEEKDAYS_ZH[isoWeekday(now, timeZone) - 1]} ${hourText}；${phase}`
    if (state.phase === 'sleeping' && state.sleepUntil) line += `（睡到 ${timeOnly(Number(state.sleepUntil), timeZone)}）`
    if (state.lock) line += `（静音到 ${timeOnly(Number(state.lock.until), timeZone)}）`
    // 暂停事实：任务停止、世界继续、危险会穿透（不写教导，只陈述）。
    if (pausedActive()) line += `（任务已暂停、世界继续；危险事件会穿透）`
    line += '。'
    const tail = []
    const next = nextUpcoming(now)
    if (next) tail.push(`下一个安排：${next.schedule.id}（${describeParsed(next.parsed)}，${stampAt(next.point, timeZone)}）`)
    if (state.queue.length) tail.push(`积压 ${state.queue.length} 条（${reasonCounts()}）`)
    return tail.length ? `${line}\n${tail.join('；')}。` : line
  }

  /* ── 对外 API ── */

  // 兼容：wake() 仍是"手动结束睡眠"的函数，同时挂 compactWake 共享计数（qq 等生产者用）。
  wake.count = () => Number(state.wakeCount ?? 0)
  wake.bump = () => {
    state.wakeCount = Number(state.wakeCount ?? 0) + 1
    dirty = true
    persist()
    return state.wakeCount
  }
  wake.reset = () => {
    state.wakeCount = 0
    dirty = true
    persist()
    return 0
  }
  wake.stats = () => ({ ...state.wakeStats })
  wake.enabled = () => compactWakeEnabled
  wake.mode = () => compactWakeMode()
  wake.shouldCompact = () => compactWakeMode() === 'compact'
  wake.config = () => ({ after: compactWakeAfter, maxChars: compactWakeMaxChars, fullEvery: compactWakeFullEvery })

  const api = {
    now: () => nowTime(),
    timeZone: () => timeZone,
    phase: () => state.phase,
    view: () => timeView(),
    statusText: () => statusText(),
    schedules: () => state.schedules.map(({ __parsed, ...rest }) => rest),
    queue: () => state.queue.map((q) => ({ ...q })),
    add: addSchedule,
    edit: editSchedule,
    remove: removeSchedule,
    cancel,
    skip(id) {
      const before = state.queue.length
      state.queue = state.queue.filter((q) => q.id !== String(id))
      persist()
      return { skipped: before !== state.queue.length }
    },
    /** 控制后门/测试用：立即尝试释放积压（只在 awake 时真的发送）。 */
    flush(reason = '手动') { return flushQueue(reason) },
    sleep({ message = '到整理时间了。把今天的经历放下，我要把它们沉淀成记忆；三分钟后回来。', durationMin = 3, allow = null } = {}) {
      const schedule = addSchedule({ id: `sleep-${Date.now().toString(36)}`, at: 'now', mode: 'wake', sleep: true, startMessage: message, durationMin, allow })
      return startSchedule(schedule)
    },
    wake,
    tick,
    processInbox,
    runCommand,
    pause,
    resume,
    mute,
    unmute,
    lock: () => (state.lock ? { ...state.lock } : null),
    setClock(fn) { return clock ? clock.set(fn) : () => {} },
    /** 外部暂停模式（mcb_stop 等）：任务停止、世界继续、危险穿透；不冻结 time 计时。 */
    setPausedMode,
    pausedMode: () => status().pausedMode,
    ownsClock: () => Boolean(clock?.owns?.()),
    /** 测试/复核用（需 config.testClock）：平移 time 看到的时钟。 */
    advanceClock,
    addGoal,
    removeGoal,
    goals: () => state.goals.map((g) => ({ ...g })),
    resumeGoals,
    onTurnEnd,
    heartbeat: heartbeatStatus,
    status,
    statusText,
    listText,
  }

  // ── 提示词：只放事实（PROMPT-CONTRACT §3；order ≥800、无内容时整段消失） ──
  try {
    ctx.prompt.section({ name: 'time', order: 880, text: () => timeFacts() })
  } catch (error) { log('warn', 'time.prompt', { error: String(error?.message ?? error) }) }

  // ── 世界状态：只补"进行中的长日程/目标"这类 time section 没展开的事实；
  // 下一个安排/阶段/积压已经在 time section 里，禁止重复（PROMPT-CONTRACT §3 同一事实一个家）。
  if (world?.registerSource) {
    try {
      world.registerSource({
        id: 'time',
        owner: 'time',
        title: '日程',
        order: 5,
        cap: 1,
        empty: false,
        items: () => {
          const view = timeView()
          const parts = []
          for (const span of view.spans) parts.push(`进行中 ${span.id} 到 ${timeOnly(span.until, timeZone)}`)
          for (const goal of view.goals) parts.push(`目标 ${goal.id}`)
          if (!parts.length) return []
          return [{ key: 'calendar', brief: `${parts.join('；')}。`, detail: statusText() }]
        },
      })
    } catch (error) { log('warn', 'time.world', { error: String(error?.message ?? error) }) }
  }

  // ── 工具面：安排、状态、清单、编辑/取消、暂停/恢复、静音锁 ──
  const tool = (def) => ctx.tools.register(def)
  tool({
    name: 'time_status',
    summary: '现在几点、处在什么阶段、睡到/静音到什么时候、下一个安排、进行中的目标、积压了多少。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute() { return { text: statusText() } },
  })
  tool({
    name: 'time_arrange',
    summary: '新建安排：一次/每天/每周/倒计时唤醒、日历日期/跨天/重复、goal 持续目标；mode:"heartbeat" 设置活跃度。',
    description: 'mode:"wake" 到点唤醒；mode:"goal" 持续目标；mode:"heartbeat" 只调全局活跃度（只认 frequency）。at 支持 "HH:mm"（每天）、"周一 07:30"/"mon,wed 07:30"（每周）、ISO、now；日历事件用 date:"YYYY-MM-DD"（配 at:"HH:mm" 或省略=全天）+ endDate 跨天；allDay 默认只展示不叫醒，wake:true 才叫醒；repeat:{every:"2d"|"2w"|"1mo"|"1y",until?,count?} 在 date 上重复（monthly/yearly 遇到不存在的日期会跳过该次）；skipDates:["YYYY-MM-DD"] 跳过某些天（只跳 occurrence，不改事件）。in 支持 "10m"/"2h"/"1d"；duration 是长日程时长。sleep:true 表示睡觉：进入睡眠、外部消息转积压、醒来批量释放；长日程/目标会自动暂停心跳。sleep 的 message 是醒来时说的话（不是入睡提示；要入睡提示用 startMessage）。quiet:true 表示安静安排：phase 保持醒着，拦住非 @ 消息（@/管理员可放行），不触发 dream，到点用 message 提醒；必须配 duration/until。frequency 是随机唤醒器的活跃度（0.01–1，默认 0.2），系统给预估，不需要算间隔。silent:true 只发事件不发消息。返回安排 id，可用 time_edit/time_cancel；time_view 提供结构化日历。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['mode'], properties: {
        mode: { type: 'string', enum: ['wake', 'goal', 'heartbeat'], description: 'wake=到点唤醒；goal=持续目标；heartbeat=设置全局活跃度' },
        frequency: { type: 'number', description: 'heartbeat 用：活跃度 0.01–1（1=最活跃，约 10–20 分钟一次；0.05≈几小时一次）' },
        kind: { type: 'string', enum: ['single', 'span'], description: 'single=一次；span=有开始和结束' },
        at: { type: 'string', description: 'HH:mm（每天）、"周一 07:30"（每周）、ISO、now' },
        in: { type: 'string', description: '多久之后，如 10m / 2h / 1d' },
        date: { type: 'string', description: '日历日期 YYYY-MM-DD；配 at:"HH:mm" 是定时事件，省略 at 是全天事件' },
        endDate: { type: 'string', description: '跨天事件结束日期 YYYY-MM-DD（含当天）' },
        allDay: { type: 'boolean', description: '全天事件（默认只展示，不叫醒；要叫醒配 wake:true）' },
        wake: { type: 'boolean', description: '是否产生唤醒；allDay 默认 false，定时事件默认 true' },
        repeat: { type: 'object', additionalProperties: false, description: '在 date 上重复：{every:"2d"|"2w"|"1mo"|"1y", until?, count?}', properties: {
          every: { type: 'string', description: '2d=每两天，2w=每两周，1mo=每月，1y=每年' },
          until: { type: 'string', description: '结束日期 YYYY-MM-DD 或 ISO' },
          count: { type: 'number', description: '最多发生次数' },
        } },
        skipDates: { type: 'array', items: { type: 'string' }, description: '跳过这些日期 YYYY-MM-DD（只跳过 occurrence）' },
        duration: { type: 'string', description: 'span 持续多久，如 8h / 30m' },
        message: { type: 'string', description: '普通唤醒时说的话；sleep:true 时是醒来时说的话（不是入睡提示）' },
        startMessage: { type: 'string', description: 'sleep:true 时入睡瞬间说的话；默认不说，一般不用' },
        theme: { type: 'string', description: 'goal 主题，缺省用 message' },
        tags: { type: 'array', items: { type: 'string' }, description: '给安排打标签；插件按标签订阅 schedule-start 事件' },
        focus: { type: 'string', description: 'goal 绑定的注意力空间' },
        turnLimit: { type: 'number', description: 'goal 的回合上限' },
        sleep: { type: 'boolean', description: 'wake+span 进入睡眠：外部消息转积压，醒来用 message 作为唤醒语' },
        quiet: { type: 'boolean', description: 'wake+span 进入"安静安排"：非 @ 消息积压、phase 保持醒着、不触发 dream；必须配 duration/until' },
        silent: { type: 'boolean', description: '只发事件、不发消息' },
        allow: { type: 'array', items: { type: 'object' }, description: '睡眠期间的白名单规则 {from,kinds,tags,any}' },
        id: { type: 'string', description: '安排 id（同名会覆盖）' },
        weekdays: { type: 'array', items: { type: 'number' }, description: '每周的星期（1=周一…7=周日），配 at:"HH:mm"' },
      },
    },
    async execute(input = {}) {
      if (String(input.mode) === 'heartbeat') {
        if (input.frequency == null) throw new Error('heartbeat 需要 frequency（0.01–1）')
        const frequency = clampHeartbeatFrequency(input.frequency)
        state.heartbeatFrequency = frequency
        state.heartbeatDueAt = null
        dirty = true
        armHeartbeat()
        persist()
        const est = heartbeatEstimate()
        return { text: `心跳活跃度设为 ${frequency}：约 ${est.text} 随机醒一次（系统会随机化，不按固定间隔）。` }
      }
      const schedule = addSchedule(input)
      const detail = describeSchedule(schedule, nowTime())
      return { text: `安排好了：${detail}` }
    },
  })
  tool({
    name: 'time_list',
    summary: '列出所有安排、目标和积压（按下一次触发排序，带相对时间）。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute() { return { text: listText() } },
  })
  tool({
    name: 'time_edit',
    summary: '修改一条安排：改时间、改消息、改模式、改时长；进行中的长日程会同步改结束时间。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['id'], properties: {
        id: { type: 'string' }, at: { type: 'string' }, in: { type: 'string' },
        message: { type: 'string' }, startMessage: { type: 'string' }, theme: { type: 'string' },
        mode: { type: 'string', enum: ['wake', 'goal'] }, duration: { type: 'string' },
        silent: { type: 'boolean' }, sleep: { type: 'boolean' }, quiet: { type: 'boolean' }, tags: { type: 'array', items: { type: 'string' } },
      },
    },
    async execute({ id, ...patch } = {}) {
      const out = editSchedule(id, patch)
      return { text: out.edited ? `改好了：${describeSchedule(out.schedule, nowTime())}` : `没有这个安排：${id}` }
    },
  })
  tool({
    name: 'time_cancel',
    summary: '取消一条安排/长日程/目标（同一个 id 一次全清），目标绑定的专注空间一起释放。',
    parameters: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' } } },
    async execute({ id } = {}) {
      const out = cancel(id)
      return { text: out.cancelled ? `已取消：${id}（${out.parts.join('、')}）` : `没有这个安排：${id}` }
    },
  })
  tool({
    name: 'time_pause',
    summary: '暂停计时：所有到点、长日程、目标期限一起冻结，普通外部消息转为积压；危险（alarm/safety）仍会穿透叫醒你。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute() { const out = pause(); return { text: out.already ? '已经是暂停状态。' : '已暂停计时（任务停止、世界继续；危险会穿透）。' } },
  })
  tool({
    name: 'time_resume',
    summary: '恢复计时（暂停时长会整体后移所有期限）；不是暂停状态时如实返回。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute() {
      const out = resume()
      if (!out.resumed) return { text: `当前不是暂停状态：${out.phase}` }
      return { text: `恢复了（${fmtDuration(out.deltaMs)}后移），释放了 ${out.released ?? 0} 条${out.phase === 'sleeping' ? '；还在睡眠，积压留到醒来' : ''}。` }
    },
  })
  tool({
    name: 'time_mute',
    summary: '静音：暂时拦下所有外部消息（含危险消息，默认也拦；要放行危险请显式配 emergencyQuota/allow），到点自动恢复；自己的闹钟不受影响。',
    description: 'minutes 默认 30；until 可给 ISO/HH:mm/in 式时长，最长 8 小时（超时自动解除，不会把系统卡死）。默认连 alarm/safety/emergency 也拦下并记录（醒来/恢复时可见）；allow 是白名单规则，emergencyQuota 是显式放行危险的次数（默认 0＝不放行）。静音期间 to:"model" 的外部信号进有界积压。time_status 查剩余，time_unmute 立刻恢复并释放积压摘要。',
    parameters: {
      type: 'object', additionalProperties: false, properties: {
        minutes: { type: 'number', description: '静音多少分钟（默认 30，最长 480）' },
        until: { type: 'string', description: '结束时间：ISO / HH:mm / 如 2h' },
        reason: { type: 'string', description: '为什么安静一会儿（给自己看）' },
        allow: { type: 'array', items: { type: 'object' }, description: '白名单规则 {from,kinds,tags,any}' },
        emergencyQuota: { type: 'number', description: '紧急消息放行上限（默认 2）' },
      },
    },
    async execute(input = {}) {
      const out = mute(input)
      return { text: `静音了：到 ${stampAt(Number(out.until), timeZone)}（${fmtRelative(Number(out.until), nowTime())}），紧急放行 ${out.emergencyQuota} 次。` }
    },
  })
  tool({
    name: 'time_unmute',
    summary: '解除静音，并把静音期间积压的消息按摘要释放。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute() {
      const out = unmute('manual')
      return { text: out.muted === false && out.released === 0 && out.since === undefined ? '当前没有静音。' : `解除静音，释放了 ${out.released ?? 0} 条。` }
    },
  })

  // ── 定时器：重入保护在 tick 里，异常写 tick-error 并留状态 ──
  const timer = setInterval(() => {
    try {
      const out = tick()
      if (out && typeof out.then === 'function') out.catch((error) => log('warn', 'time.tick.async', { error: String(error?.message ?? error) }))
    } catch (error) {
      writeSideFile(path.join(dir, 'tick-error.json'), String(error?.stack ?? error))
      log('warn', 'time.tick', { error: String(error?.message ?? error) })
    }
  }, tickMs)
  if (typeof timer.unref === 'function') timer.unref()

  // ── 启动：重启前没放出去的积压显式释放（原因如实写，不假装是错误） ──
  if (state.queue.length) flushQueue('重启后发现的')

  // ── 拦截层：只在 delivery 层裁决（P3：focus→time，signals 与直投同序） ──
  // 不再安装 signals gate：host 的 focus.admit 先跑，随后 delivery 的 time gate 再判时间。
  // 这样同一条消息只经过一次 time 裁决（配额/记录不会重复计数）。
  ctx.onDispose(() => clearInterval(timer))
  ctx.onDispose(() => { if (awakeTimer) { clearTimeout(awakeTimer); awakeTimer = null } })

  // delivery 层 gate：堵住插件直接 ctx.delivery.push 绕过 signals 的结构性缺口。
  // core 提供 addGate 时用组合式，卸载只摘自己那层；只有 setGate 时退化为旧接口。
  const deliveryApi = ctx.delivery
  if (deliveryApi && (typeof deliveryApi.addGate === 'function' || typeof deliveryApi.setGate === 'function')) {
    const deliveryGate = (entry = {}) => {
      const source = entry.source ?? entry
      const plugin = String(source?.plugin ?? entry?.plugin ?? '')
      if (plugin === 'time') return { accept: true }
      // P3：不再跳过 channel:'signal'。signals 层已没有 time gate，时间裁决只在 delivery 层做一次
      // （host focus.admit 先跑 → 这里再判 phase/lock/pause），配额/记录不会重复计数。
      // C1：直投也带上 source 的 tags/priority/pierce/meta，alarm 的判定与 signal 路径一致
      // （暂停穿透；睡眠/静音按最高优先级进 time 队列，内容不丢）。
      const tags = Array.isArray(source?.tags) ? source.tags.map(String) : []
      const meta = source?.meta && typeof source.meta === 'object' ? { ...source.meta } : {}
      if (source?.priority != null && meta.priority == null) meta.priority = String(source.priority)
      if (source?.pierce === true) meta.pierce = true
      const pseudo = {
        from: { plugin, activity: source?.activity ?? null },
        kind: 'notice',
        text: String(entry.content?.text ?? entry.text ?? ''),
        focus: source?.focus == null ? null : String(source.focus),
        tags,
        meta: Object.keys(meta).length ? meta : null,
        id: source?.signalId == null ? null : String(source.signalId),
        createdAt: Number(source?.createdAt) > 0 ? Number(source.createdAt) : null,
        expiresAt: Number(source?.expiresAt) > 0 ? Number(source.expiresAt) : null,
      }
      const decision = gate(pseudo)
      if (decision.accept) return { accept: true }
      return { accept: false, reason: decision.reason ?? 'blocked' }
    }
    try {
      if (typeof deliveryApi.addGate === 'function') {
        const off = deliveryApi.addGate(deliveryGate)
        ctx.onDispose(typeof off === 'function' ? off : () => {})
      } else {
        deliveryApi.setGate(deliveryGate)
        ctx.onDispose(() => { try { deliveryApi.setGate(null) } catch { /* 已经卸下 */ } })
      }
      log('info', 'time.delivery-gate', { installed: true })
    } catch (error) { log('warn', 'time.delivery-gate', { error: String(error?.message ?? error) }) }
  }

  // turn-start：记录模型活动开始时间（bridge 提供）；没有它时 lastModelCallAt 退化到 turn-end。
  // 睡眠期出现新 turn（边界 turn 已结束后又起来）= 直接注入的嫌疑，记事件供 validity 统计。
  ctx.signals.on({ tags: ['turn-start'] }, (signal) => {
    try {
      const at = nowTime()
      // 决策循环：turn-end → 下一 turn/start（只在 turn-end 后的第一次 start 记一次）。
      const firstStartAfterEnd = state.lastTurnEndAt != null && (state.lastTurnStartAt == null || Number(state.lastTurnStartAt) <= Number(state.lastTurnEndAt))
      if (firstStartAfterEnd) {
        const cycleSec = Math.max(0, Math.round((at - Number(state.lastTurnEndAt)) / 1000))
        state.lastDecisionCycleSec = cycleSec
        recordEvent('decision-cycle', { sec: cycleSec })
      }
      noteReaction(at)
      state.lastTurnStartAt = at
      // 会话又活跃了：取消待触发的心跳；这一轮结束后再重新计时。
      clearHeartbeat()
      const seq = Number(signal?.meta?.seq)
      if (Number.isFinite(seq)) state.lastTurnSeq = seq
      if (state.phase === 'sleeping' && state.sleepBoundary && state.sleepBoundary.turnEndedAt != null && !state.sleepBoundary.postSleepTurn) {
        state.sleepBoundary.postSleepTurn = true
        log('warn', 'time.sleep-boundary.new-turn', { at: nowTime() })
        recordEvent('sleep-boundary-new-turn', { at: nowTime(), sleepingId: state.sleepingId })
        emitEvent({ from: { plugin: 'time', activity: 'sleep-boundary' }, kind: 'event', text: 'sleep-boundary-new-turn', tags: ['sleep', 'boundary', 'injection'], meta: { at: nowTime() } })
      }
      dirty = true
    } catch (error) { log('warn', 'time.turn-start', { error: String(error?.message ?? error) }) }
  })

  // turn-end：目标续推 + 心跳；没有目标时安排清醒节拍（见 onTurnEnd）。
  ctx.signals.on({ tags: ['turn-end'] }, (signal) => {
    try { onTurnEnd(signal) } catch (error) { log('warn', 'time.turn-end', { error: String(error?.message ?? error) }) }
  })

  // dream 完成/失败回执（已实现：dream emit `60d8abe`；契约 TIME.md §15.3）：
  //   {tags:['dream-result'], meta:{ok,jobs,degraded,failedShards,at}, text}，一次 run 一条。
  // time 只记录并放进醒来简报/状态；睡眠中不额外投递，醒着时给一条 notice。
  ctx.signals.on({ tags: ['dream-result'] }, (signal) => {
    try {
      const meta = signal?.meta ?? {}
      const text = String(signal?.text ?? '').slice(0, 200)
      const ok = meta.ok != null ? Boolean(meta.ok) : !/失败|错误|fail/i.test(text)
      const jobs = Array.isArray(meta.jobs) ? meta.jobs : []
      const ranJobs = jobs.filter((row) => !row?.skipped)
      const degraded = Number(meta.degraded ?? 0) || 0
      const failedShards = Number(meta.failedShards ?? 0) || 0
      state.lastDreamResult = {
        at: nowTime(),
        ok,
        text,
        jobs: jobs.length,
        ranJobs: ranJobs.length,
        degraded,
        failedShards,
        dreamAt: Number(meta.at) > 0 ? Number(meta.at) : null,
      }
      dirty = true
      recordEvent('dream-result', { ok, text, jobs: jobs.length, ranJobs: ranJobs.length, degraded, failedShards })
      if (state.phase === 'awake') {
        const detail = text || (ranJobs.length ? `${ranJobs.length} 个任务` : '')
        const shard = degraded ? `；分片降级${failedShards ? `（${failedShards} 片失败）` : ''}` : ''
        send({ kind: 'notice', text: `记忆整理回执：${ok ? '完成' : '失败'}${detail ? `（${clipBriefText(detail, 80)}）` : ''}${shard}。`, tags: ['dream', 'dream-result'] })
      } else persist()
    } catch (error) { log('warn', 'time.dream-result', { error: String(error?.message ?? error) }) }
  })

  // 重启后恢复 focus 租约：睡眠租约、目标绑定的 focus（否则状态在、租约丢了）。
  try {
    const span = activeSleepSpan()
    if (span) ensureSleepLease()
    else releaseSleepLeases()
    for (const goal of state.goals) {
      if (!goal.focus || goalLeases.has(goal.id) || !focusApi?.enter) continue
      goalLeases.set(goal.id, focusApi.enter({ label: goal.focus, owner: 'time', reason: `goal:${goal.id}`, title: goal.theme, goal: goal.theme, interruptible: true, kind: 'goal' }))
    }
  } catch (error) { log('warn', 'time.leases.restore', { error: String(error?.message ?? error) }) }

  // 重启后如果醒着且之前有过回合，恢复清醒节拍（不然会一直等到下一个外部事件）。
  if (awakeTickEnabled && state.phase === 'awake' && state.lastTurnEndAt != null) {
    try { armAwakeTick() } catch { /* 时间视图异常不影响启动 */ }
  }

  ctx.services.provide('time', api)
  persist()
  ctx.log({ msg: 'time.ready', phase: state.phase, schedules: state.schedules.length, goals: state.goals.length, queue: state.queue.length, locked: Boolean(state.lock) })
  return api
}
