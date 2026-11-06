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

  // in 与 at 同给时 at 优先；但 edit 想用 in 改期时会把 at 显式清掉。
  const inMs = parseIn(input.in ?? input.inMinutes ?? null)
  let startRaw = input.at != null ? String(input.at) : (inMs != null ? new Date(now + inMs).toISOString() : null)
  if (!startRaw) throw new Error('安排需要 at（HH:mm / 周一 HH:mm / ISO / now）或 in（如 10m / 1d）')
  let parsed = parseAt(startRaw, now, timeZone)

  const weekdays = normalizeWeekdays(input.weekdays ?? input.days ?? null)
  if (weekdays) {
    if (parsed.kind !== 'daily') throw new Error('weekdays 需要配合 HH:mm 使用（如 at:"07:30", weekdays:[1,3,5]）')
    parsed = { kind: 'weekly', weekdays, hour: parsed.hour, minute: parsed.minute }
  }

  const durationMs = parseIn(input.duration ?? input.durationMin ?? null)
  let untilAt = null
  if (input.until != null) {
    const parsedUntil = parseUntil(input.until, now, timeZone)
    if (parsedUntil == null) throw new Error(`until 格式应为 ISO、HH:mm 或 in 式时长：${input.until}`)
    untilAt = parsedUntil
  }
  const kind = input.sleep === true || input.kind === 'span' || durationMs != null || untilAt != null ? 'span' : 'single'
  // 睡眠必须有终点；只给 sleep:true 没给时长时默认 3 分钟，和提示词"三分钟后回来"一致。
  const durationMin = durationMs != null
    ? Math.max(1, Math.round(durationMs / 60_000))
    : (input.sleep === true && untilAt == null ? 3 : null)

  const turnLimit = input.turnLimit == null ? null : Math.max(1, Number(input.turnLimit) || 1)
  const resumeLimit = input.resumeLimit == null ? null : Math.max(1, Number(input.resumeLimit) || 1)
  return {
    id: String(input.id ?? nextScheduleId()),
    mode,
    kind,
    at: startRaw,
    weekdays: parsed.kind === 'weekly' ? parsed.weekdays : null,
    durationMin,
    until: untilAt,
    message: String(input.message ?? ''),
    theme: String(input.theme ?? input.message ?? ''),
    sleep: input.sleep === true,
    silent: input.silent === true,
    tags: Array.isArray(input.tags) ? input.tags.map(String).slice(0, 8) : [],
    focus: input.focus == null ? null : String(input.focus),
    allow: Array.isArray(input.allow) ? input.allow : null,
    turnLimit,
    resumeLimit,
    __parsed: parsed,
  }
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
  let parsed = parseAt(schedule.at, now, timeZone)
  if (Array.isArray(schedule.weekdays) && schedule.weekdays.length && parsed.kind === 'daily') {
    parsed = { kind: 'weekly', weekdays: schedule.weekdays.slice().sort((a, b) => a - b), hour: parsed.hour, minute: parsed.minute }
  }
  return parsed
}

/** 已经到达、且是"最近一次"的触发点（用于 tick 的到点判定）。 */
export function occurrenceAt(parsed, now, timeZone = null) {
  if (!parsed) return null
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
  // 清醒节拍（awake heartbeat）：awake 且没有 sleep/mute/pause 时，turn-end 后如果
  // 没有目标续推就安排下一次自检，避免"无事可做就静默等事件"的分钟级假死。
  const awakeCfg = ctx.config.awakeTick && typeof ctx.config.awakeTick === 'object' ? ctx.config.awakeTick : {}
  const awakeTickEnabled = awakeCfg.enabled !== false
  const awakeIdleSec = Math.max(15, Number(awakeCfg.idleSec ?? 120))
  const awakeMaxPerHour = Math.max(1, Number(awakeCfg.maxPerHour ?? 60))
  const awakeRetrySec = Math.max(5, Number(awakeCfg.retrySec ?? 30))
  const awakeDuringFocus = awakeCfg.duringFocus !== false
  const awakeCappedSec = Math.max(60, Number(awakeCfg.cappedSec ?? 600))
  const awakeCappedShortWindowSec = Math.max(0, Number(awakeCfg.cappedShortWindowSec ?? 1800))
  const awakeCappedShortMax = Math.max(0, Number(awakeCfg.cappedShortMax ?? 3))
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
    // 清醒节拍/心跳：最后一次 turn-end、下一次自检、最近一小时的节拍时间戳
    lastTurnEndAt: null,
    lastTurnStartAt: null,
    lastAwakeTickAt: null,
    awakeTickDueAt: null,
    awakeTickSentAt: [],
    awakeTickShortSentAt: [],
    awakeTickCappedAt: null,
    sleepBoundary: null,
    lastSleepBoundary: null,
    sleepBrief: null,
    lastSleepBrief: null,
    lastDreamResult: null,
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
      state.awakeTickSentAt = Array.isArray(saved.awakeTickSentAt) ? saved.awakeTickSentAt.map(Number).filter(Number.isFinite).slice(-120) : []
      state.awakeTickShortSentAt = Array.isArray(saved.awakeTickShortSentAt) ? saved.awakeTickShortSentAt.map(Number).filter(Number.isFinite).slice(-20) : []
      for (const key of ['lastTurnEndAt', 'lastTurnStartAt', 'lastAwakeTickAt', 'awakeTickDueAt', 'awakeTickCappedAt', 'heartbeatOverdueLoggedAt']) {
        state[key] = Number(saved[key]) > 0 ? Number(saved[key]) : null
      }
      state.turnEnds = Number(saved.turnEnds) > 0 ? Number(saved.turnEnds) : 0
      state.sleepBoundary = saved.sleepBoundary && typeof saved.sleepBoundary === 'object' ? saved.sleepBoundary : null
      state.lastSleepBoundary = saved.lastSleepBoundary && typeof saved.lastSleepBoundary === 'object' ? saved.lastSleepBoundary : null
      state.sleepBrief = saved.sleepBrief && typeof saved.sleepBrief === 'object' ? saved.sleepBrief : null
      state.lastSleepBrief = saved.lastSleepBrief && typeof saved.lastSleepBrief === 'object' ? saved.lastSleepBrief : null
      state.lastDreamResult = saved.lastDreamResult && typeof saved.lastDreamResult === 'object' ? saved.lastDreamResult : null
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
  let gateRemover = null
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

  /** 安排/重置一次清醒节拍；delayMs 默认 idleSec。 */
  function armAwakeTick(delayMs = awakeIdleSec * 1000) {
    if (!awakeTickEnabled) { state.awakeTickDueAt = null; return }
    if (awakeSuppressed()) { state.awakeTickDueAt = null; return }
    state.awakeTickDueAt = nowTime() + Math.max(1000, Number(delayMs) || awakeIdleSec * 1000)
  }

  function clearAwakeTick() {
    if (state.awakeTickDueAt != null) { state.awakeTickDueAt = null; dirty = true }
  }

  function awakeTickText(at, { short = false } = {}) {
    const idleSec = state.lastTurnEndAt ? Math.round((at - Number(state.lastTurnEndAt)) / 1000) : null
    if (short) return `清醒节拍：醒着 ${idleSec ?? '?'} 秒没有回合；手上没事的话，看一眼状态再决定。`
    const bits = [`清醒节拍：距上次回合结束 ${idleSec ?? '?'} 秒`]
    bits.push(`现在 ${stampAt(at, timeZone)}，醒着`)
    const focusLease = focusApi?.current?.()
    if (focusLease) bits.push(`专注：${focusLease.title ?? focusLease.label ?? '?'}`)
    if (state.queue.length) bits.push(`积压 ${state.queue.length} 条`)
    // 只给事实 + 可选的下一步，不用命令式措辞，也不催她重复同一个动作。
    return `${bits.join('；')}。可以接着做手上的事，也可以看 time_status / world_status / focus_status 决定下一步。`
  }

  /** tick 里调用：到点就发一次清醒节拍（每轮 turn-end 会重置 dueAt）。 */
  function maybeAwakeTick(at) {
    if (!awakeTickEnabled) return false
    if (awakeSuppressed()) { state.awakeTickDueAt = null; return false }
    if (state.awakeTickDueAt == null) return false
    if (at < Number(state.awakeTickDueAt)) return false
    // 上限：最近一小时的节拍次数
    const hourAgo = at - 3_600_000
    state.awakeTickSentAt = (Array.isArray(state.awakeTickSentAt) ? state.awakeTickSentAt : []).filter((ts) => Number(ts) > hourAgo)
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
          const outcome = send({ kind: 'notice', text: awakeTickText(at, { short: true }), tags: ['awake-tick', 'heartbeat', 'short'] })
          if (outcome && outcome.accepted === false) {
            state.awakeTickDueAt = at + awakeRetrySec * 1000
            return false
          }
          state.awakeTickShortSentAt = [...state.awakeTickShortSentAt, at].slice(-20)
        }
      }
      state.awakeTickDueAt = at + awakeCappedSec * 1000
      dirty = true
      return false
    }
    // 滚动窗口释放后恢复正常节拍
    if (state.awakeTickCappedAt && at - state.awakeTickCappedAt > 3_600_000) state.awakeTickCappedAt = null
    const outcome = send({ kind: 'notice', text: awakeTickText(at), tags: ['awake-tick', 'heartbeat'] })
    if (outcome && outcome.accepted === false) {
      // 投递失败（会话忙）：短重试，不静默放弃
      state.awakeTickDueAt = at + awakeRetrySec * 1000
      log('warn', 'time.awake-tick.failed', { reason: outcome.reason ?? outcome.error ?? 'unknown' })
      return false
    }
    state.lastAwakeTickAt = at
    state.awakeTickSentAt = [...state.awakeTickSentAt, at].slice(-120)
    state.awakeTickDueAt = at + awakeIdleSec * 1000
    dirty = true
    log('info', 'time.awake-tick', { idleSec: state.lastTurnEndAt ? Math.round((at - Number(state.lastTurnEndAt)) / 1000) : null })
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
      at: nowTime(),
      createdAt: signal.createdAt ?? null,
      expiresAt: signal.expiresAt ?? null,
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
    state.queue = []
    persist()
    return fresh.length
  }

  function activeSleepSpan() {
    return state.spans.find((span) => span.sleep && span.id === state.sleepingId) ?? null
  }

  function isEmergency(signal) {
    const plugin = String(signal.from?.plugin ?? '')
    if (emergencyFrom && !emergencyFrom.includes(plugin)) return false
    const tags = Array.isArray(signal.tags) ? signal.tags.map(String) : []
    return tags.some((tag) => emergencyTags.includes(tag))
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
    // 3) 暂停（任务停止、世界继续）：危险必须穿透并把会话叫醒；其余进积压。
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
    send({ kind: 'goal', text: goalMessage(goal, { resume: true }), tags: ['goal', 'resume'], focus: goal.focus })
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
    persist()
    return resumed
  }

  /* ── 安排（时间轴） ── */

  function scheduleSignature(schedule) {
    const parsed = schedule.__parsed ?? parsedOf(schedule, nowTime(), timeZone)
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
      span.endMessage = next.sleep ? '整理完了。今天看到的东西已经记下来了，接着来吧。' : `结束了：${next.id}`
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

  function startSchedule(schedule) {
    const now = nowTime()
    const parsed = schedule.__parsed ?? parsedOf(schedule, now, timeZone)
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
          if (focusApi?.enter && !sleepLease) {
            try {
              sleepLease = focusApi.enter({ label: 'sleep', owner: 'time', reason: 'sleeping', title: '睡眠', kind: 'idle', interruptible: false })
            } catch (error) { log('warn', 'time.sleep.focus', { error: String(error?.message ?? error) }) }
          }
        }
        if (!schedule.silent) {
          const text = schedule.message || (schedule.sleep
            ? '到整理时间了。把今天的经历放下，我要把它们沉淀成记忆；三分钟后回来。'
            : `开始了：${schedule.id}`)
          const sent = send({ kind: 'wake', text, tags: [schedule.sleep ? 'sleep' : 'span'] })
          if (sent && sent.accepted === false) log('warn', 'time.wake.failed', { id: schedule.id, reason: sent.reason ?? sent.error ?? 'unknown' })
        }
        state.spans.push({
          id: schedule.id,
          until: endAt,
          endMessage: schedule.sleep ? '整理完了。今天看到的东西已经记下来了，接着来吧。' : `结束了：${schedule.id}`,
          sleep: Boolean(schedule.sleep),
          silent: Boolean(schedule.silent),
          allow: Array.isArray(schedule.allow) ? schedule.allow : DEFAULT_ALLOW,
        })
        if (schedule.sleep) emitEvent({ from: { plugin: 'time' }, kind: 'event', text: 'sleep-start', tags: ['sleep'] })
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
      const sent = send({ kind: 'wake', text: schedule.message || `到点了：${schedule.id}`, tags: ['wake'] })
      if (sent && sent.accepted === false) log('warn', 'time.wake.failed', { id: schedule.id, reason: sent.reason ?? sent.error ?? 'unknown' })
      outcome = { started: schedule.id, mode: schedule.mode, kind: schedule.kind }
    }
    // fired 的日期用"触发点所在的那一天"，不是"现在"：跨午夜补响（daily 23:55 在
    // 00:05 才跑到）时记到昨天，今晚 23:55 还能正常响。
    const point = occurrenceAt(parsed, now, timeZone) ?? now
    state.fired[`${schedule.id}@${dayKey(point, timeZone)}`] = now
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
      const detail = String(result.text ?? '').slice(0, 60) || (Number(result.ranJobs) ? `${result.ranJobs} 个任务` : '')
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
      if (!span.silent) {
        const text = wakeBrief ? `${span.endMessage}\n${wakeBrief.text}` : span.endMessage
        send({ kind: 'wake', text, tags: wakeBrief ? ['wake', 'wake-brief'] : ['wake'] })
      }
      const released = flushQueue('你睡觉时')
      recordEvent('sleep-end', { sleepingId: span.id, released, boundary: state.lastSleepBoundary ? { inFlight: Boolean(state.lastSleepBoundary.inFlight), turnEndedAfterSec: state.lastSleepBoundary.turnEndedAfterSec ?? null, postSleepTurn: Boolean(state.lastSleepBoundary.postSleepTurn), overrun: Boolean(state.lastSleepBoundary.overrun) } : null })
      if (wakeBrief) recordEvent('wake-brief', { sleepingId: span.id, released, backlog: wakeBrief.backlog, sources: wakeBrief.sources, anomalies: wakeBrief.anomalies, dream: wakeBrief.dream, durationSec: wakeBrief.durationSec })
      // 最后再释放睡眠租约：focus 的积压摘要会走 signals.offer，醒来后再进队，避免顺序打乱。
      if (sleepLease) { try { sleepLease.release?.() } catch { /* 已经释放 */ } sleepLease = null }
      // 醒来后如果没有新的 turn 触发，清醒节拍负责在 idleSec 内叫起一次自检。
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
    if (!sleeping) armAwakeTick()
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
      if (sleepLease) { try { sleepLease.release?.() } catch { /* 已经释放 */ } sleepLease = null }
      send({ kind: 'wake', text: '你醒了。', tags: ['wake'] })
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

  /** 自愈：如果别的插件用旧 setGate 把我们的拦截层整体覆盖了，重新装回去。 */
  function ensureSignalGate() {
    if (typeof signals.gates !== 'function' || typeof signals.addGate !== 'function') return
    if (signals.gates().includes(gate)) return
    log('warn', 'time.gate.missing', { gates: signals.gates().length })
    try {
      gateRemover = signals.addGate(gate) ?? gateRemover
    } catch (error) { log('warn', 'time.gate.reinstall', { error: String(error?.message ?? error) }) }
  }

  function tick(at = nowTime()) {
    if (ticking) return { skipped: 'reentrant' }
    ticking = true
    try {
      ensureSignalGate()
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
        startSchedule(schedule)
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
      maybeAwakeTick(at)
      // 醒着长时间没有 turn 活动 = 可观测异常（自检本该在 idleSec 内把它救回来）。
      if (awakeTickEnabled && !awakeSuppressed() && state.lastTurnEndAt != null) {
        const idleSec = (at - Number(state.lastTurnEndAt)) / 1000
        if (idleSec > awakeIdleSec * 1.5) {
          if (!state.heartbeatOverdueLoggedAt || at - Number(state.heartbeatOverdueLoggedAt) > 10 * 60_000) {
            state.heartbeatOverdueLoggedAt = at
            dirty = true
            log('warn', 'time.heartbeat.overdue', { idleSec: Math.round(idleSec), thresholdSec: awakeIdleSec, queued: state.queue.length })
          }
        }
      }
      if (dirty || state.queue.length || state.spans.length || state.goals.length || state.awakeTickDueAt != null) persist()
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
          if (sleepLease) { try { sleepLease.release?.() } catch { /* 已经释放 */ } sleepLease = null }
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
    else if (idleSec != null && idleSec > awakeIdleSec * 1.5) heartbeatState = 'overdue'
    return {
      enabled: awakeTickEnabled,
      state: heartbeatState,
      thresholdSec: awakeIdleSec,
      lastTurnEndAt,
      lastTurnStartAt: state.lastTurnStartAt ?? null,
      lastModelCallAt: state.lastTurnStartAt ?? lastTurnEndAt,
      idleSec,
      nextTickAt: state.awakeTickDueAt ?? null,
      lastAwakeTickAt: state.lastAwakeTickAt ?? null,
      ticksLastHour: lastHour.length,
      maxPerHour: awakeMaxPerHour,
      capped: Boolean(state.awakeTickCappedAt && now - Number(state.awakeTickCappedAt) < 3_600_000),
      pendingBacklog: state.queue.length,
      turnEnds: Number(state.turnEnds ?? 0),
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

  function statusText() {
    const now = nowTime()
    const lines = [`现在：${stampAt(now, timeZone)}。`]
    // 四个会"压住她"的状态写成一行的中文，别让她去读 JSON 字段名。
    const bits = [phaseText()]
    if (state.phase === 'sleeping' && state.sleepUntil) bits.push(`睡到 ${stampAt(Number(state.sleepUntil), timeZone)}（${fmtRelative(Number(state.sleepUntil), now)}）`)
    if (state.phase === 'paused' && state.pausedAt) bits.push(`暂停自 ${stampAt(state.pausedAt, timeZone)}`)
    if (state.lock) {
      const lock = state.lock
      const left = Math.max(0, Number(lock.emergency?.quota ?? 0) - Number(lock.emergency?.used ?? 0))
      bits.push(`静音到 ${stampAt(Number(lock.until), timeZone)}（${fmtRelative(Number(lock.until), now)}${lock.reason ? `，${lock.reason}` : ''}；紧急剩余 ${left}/${Number(lock.emergency?.quota ?? 0)}）`)
    }
    if (state.queue.length) bits.push(`积压 ${state.queue.length} 条（${reasonCounts()}）`)
    lines.push(`状态：${bits.join('；')}。`)
    // 暂停语义（用户拍板）：任务停止、世界继续、危险会穿透。给 mc-body/mc-link 对齐的口径。
    if (pausedActive()) {
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
    const hb = heartbeatStatus()
    if (hb.enabled && state.phase === 'awake') {
      if (hb.state === 'overdue') {
        lines.push(`⚠ 心跳：醒着 ${hb.idleSec} 秒没有回合（阈值 ${hb.thresholdSec} 秒 ×1.5），清醒节拍本应已介入。`)
      } else if (hb.idleSec != null) {
        const nextAt = hb.nextTickAt ? `${fmtRelative(Number(hb.nextTickAt), now)}自检` : '自检未排'
        lines.push(`心跳：上次回合结束 ${hb.idleSec} 秒前；${nextAt}（近一小时自检 ${hb.ticksLastHour} 次）。`)
      } else {
        lines.push('心跳：还没收到过 turn-end（清醒节拍照常待命）。')
      }
    }
    if (state.phase === 'sleeping' && state.sleepBoundary) {
      const boundary = state.sleepBoundary
      if (boundary.turnEndedAt == null) {
        const age = Math.round((now - Number(boundary.at)) / 1000)
        lines.push(`睡眠边界：入睡时有在飞回合（已 ${age} 秒，grace ${sleepGraceSec} 秒${boundary.overrun ? '，已超时' : ''}）。`)
      } else if (boundary.postSleepTurn) {
        lines.push('⚠ 睡眠边界：入睡后出现新回合（疑似外部直投；session/prompt 不经过 time gate）。')
      }
    }
    const next = nextUpcoming(now)
    if (next) lines.push(`下一个安排：${next.schedule.id}（${describeParsed(next.parsed)}，${fmtRelative(next.point, now)}）。`)
    if (state.spans.length) {
      lines.push(`进行中：${state.spans.map((s) => `${s.id}${s.sleep ? '（睡觉）' : ''} 到 ${stampAt(Number(s.until), timeZone)}`).join('；')}。`)
    }
    if (state.goals.length) {
      lines.push(`目标：${state.goals.map((g) => `${g.id} ${g.theme}${g.turnLimit != null ? `（剩 ${g.turnLimit} 轮）` : ''}${g.until != null ? `（到 ${stampAt(g.until, timeZone)}）` : ''}`).join('；')}。`)
    }
    if (state.stats.missed || state.stats.dropped || state.stats.expired) {
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

  const api = {
    now: () => nowTime(),
    timeZone: () => timeZone,
    phase: () => state.phase,
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
      const schedule = addSchedule({ id: `sleep-${Date.now().toString(36)}`, at: 'now', mode: 'wake', sleep: true, message, durationMin, allow })
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

  // ── 世界状态：只放"日程"事实（"现在几点"已经由 time section 承担，避免两行"时间："） ──
  if (world?.registerSource) {
    try {
      world.registerSource({
        id: 'time',
        owner: 'time',
        title: '日程',
        order: 5,
        cap: 3,
        items: () => {
          // "现在几点/下一个安排/积压"已经由 time prompt section 陈述（同一事实只有一个家）。
          // 世界状态只留"进行中/目标"，并靠注册 owner:'time' 抑制 world-state 的兜底时间行。
          const lines = []
          if (state.spans.length) lines.push({ key: 'span', brief: `进行中：${state.spans.map((s) => `${s.id}${s.sleep ? '（睡觉）' : ''} 到 ${stampAt(Number(s.until), timeZone)}`).join('；')}。` })
          if (state.goals.length) lines.push({ key: 'goals', brief: `目标：${state.goals.map((g) => `${g.id} ${g.theme}`).join('；')}。` })
          return lines
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
    summary: '新建一条安排：一次/每天/每周/倒计时到点唤醒；mode:"goal" 则持续在回合末唤醒，直到取消。',
    description: 'at 支持 "HH:mm"（每天）、"周一 07:30" 或 "mon,wed 07:30"（每周）、ISO 时间、"now"；in 支持 "10m"/"2h"/"1d"/"1h30m"（倒计时，与 at 同给时 at 优先）；duration 是长日程时长。sleep:true 表示睡觉：进入睡眠、外部消息转为积压、醒来批量释放。weekdays:[1..7] 配 HH:mm 表示每周。silent:true 只发事件不发消息（给插件订阅用，tags 决定谁收到）。focus 绑定注意力空间；turnLimit 限制 goal 的回合数；goal 在回合末续推，但同一目标至少间隔 goalResumeMinGapSec（默认 60s）才再唤醒一次，续推会标注"第 N 次"。返回安排 id，之后可用 time_edit 改、time_cancel 取消。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['mode'], properties: {
        mode: { type: 'string', enum: ['wake', 'goal'], description: 'wake=到点发一条唤醒；goal=持续目标' },
        kind: { type: 'string', enum: ['single', 'span'], description: 'single=一次；span=有开始和结束' },
        at: { type: 'string', description: 'HH:mm（每天）、"周一 07:30"（每周）、ISO、now' },
        in: { type: 'string', description: '多久之后，如 10m / 2h / 1d' },
        duration: { type: 'string', description: 'span 持续多久，如 8h / 30m' },
        message: { type: 'string', description: '唤醒时说的话（wake）或目标主题（goal）' },
        theme: { type: 'string', description: 'goal 主题，缺省用 message' },
        tags: { type: 'array', items: { type: 'string' }, description: '给安排打标签；插件按标签订阅 schedule-start 事件' },
        focus: { type: 'string', description: 'goal 绑定的注意力空间' },
        turnLimit: { type: 'number', description: 'goal 的回合上限' },
        sleep: { type: 'boolean', description: 'wake+span 且要进入睡眠时设 true' },
        silent: { type: 'boolean', description: '只发事件、不发消息' },
        allow: { type: 'array', items: { type: 'object' }, description: '睡眠期间的白名单规则 {from,kinds,tags,any}' },
        id: { type: 'string', description: '安排 id（同名会覆盖）' },
        weekdays: { type: 'array', items: { type: 'number' }, description: '每周的星期（1=周一…7=周日），配 at:"HH:mm"' },
      },
    },
    async execute(input = {}) {
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
        message: { type: 'string' }, theme: { type: 'string' },
        mode: { type: 'string', enum: ['wake', 'goal'] }, duration: { type: 'string' },
        silent: { type: 'boolean' }, tags: { type: 'array', items: { type: 'string' } },
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

  // ── 拦截层：signals 的 gate 和 delivery 的 push-time gate 都走组合安装 ──
  // 多槽位：别的插件再装自己的规则也不会静默覆盖我们（setGate 是旧接口，会整体替换）。
  if (typeof signals.addGate === 'function') {
    const off = signals.addGate(gate)
    gateRemover = typeof off === 'function' ? off : null
    ctx.onDispose(() => { try { gateRemover?.() } catch { /* 已经卸下 */ } })
  } else {
    signals.setGate(gate)
    ctx.onDispose(() => { try { signals.setGate(null) } catch { /* 已经卸下 */ } })
  }
  ctx.onDispose(() => clearInterval(timer))

  // delivery 层 gate：堵住插件直接 ctx.delivery.push 绕过 signals 的结构性缺口。
  // core 提供 addGate 时用组合式，卸载只摘自己那层；只有 setGate 时退化为旧接口。
  const deliveryApi = ctx.delivery
  if (deliveryApi && (typeof deliveryApi.addGate === 'function' || typeof deliveryApi.setGate === 'function')) {
    const deliveryGate = (entry = {}) => {
      const source = entry.source ?? entry
      const plugin = String(source?.plugin ?? entry?.plugin ?? '')
      if (plugin === 'time') return { accept: true }
      // signals 已经过 gate 的投递（channel:'signal'）不再拦第二遍，否则紧急配额会被
      // 计数两次、放行的消息又被打回积压。直接 ctx.delivery.push 的其它 channel 才在这里拦。
      if (entry.channel === 'signal') return { accept: true }
      const decision = gate({ from: { plugin }, kind: 'notice', text: String(entry.content?.text ?? entry.text ?? ''), focus: null, tags: [] })
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
      state.lastTurnStartAt = nowTime()
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
        send({ kind: 'notice', text: `记忆整理回执：${ok ? '完成' : '失败'}${detail ? `（${detail.slice(0, 80)}）` : ''}${shard}。`, tags: ['dream', 'dream-result'] })
      } else persist()
    } catch (error) { log('warn', 'time.dream-result', { error: String(error?.message ?? error) }) }
  })

  // 重启后恢复 focus 租约：睡眠租约、目标绑定的 focus（否则状态在、租约丢了）。
  try {
    const span = activeSleepSpan()
    if (span && focusApi?.enter && !sleepLease) {
      sleepLease = focusApi.enter({ label: 'sleep', owner: 'time', reason: 'sleeping', title: '睡眠', kind: 'idle', interruptible: false })
    }
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
