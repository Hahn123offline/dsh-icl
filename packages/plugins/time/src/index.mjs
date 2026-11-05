// 时间模块：会话的唯一时钟、唯一唤醒者、唯一纵向拦截层。
//
// 设计见 docs/TIME-MODULE.md。
//
// 安排（schedule）只有两个正交维度：
//   mode = wake | goal    —— 这次唤醒是"叫她一声"还是"让她持续做一件事"
//   kind = single | span  —— 单发（一次消息）还是长日程（有开始和结束）
// 起点：at（HH:mm / ISO / now）或 in（如 10m / 2h）
//
// 四种组合：
//   wake+single  = 到点发一条消息
//   wake+span    = 开始时一条、结束时一条（睡觉就是它，多带 sleep 标记）
//   goal+single  = 自动化任务，只有轮次上限（等价 DSH goal）
//   goal+span    = 带时间上限的目标
import fs from 'node:fs'
import path from 'node:path'

export const name = 'time'

const DEFAULT_ALLOW = Object.freeze([{ from: 'admin' }])
const PHASES = ['awake', 'sleeping', 'paused']

function dayKey(at) {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function stampAt(at) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(at))
}

function parseAt(value, now = Date.now()) {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  if (raw === 'now') return { kind: 'once', at: now }
  const hm = /^(\d{1,2}):(\d{2})$/.exec(raw)
  if (hm) return { kind: 'daily', hour: Number(hm[1]), minute: Number(hm[2]) }
  const iso = Date.parse(raw)
  if (Number.isFinite(iso)) return { kind: 'once', at: iso }
  throw new Error(`at 格式应为 HH:mm、ISO 或 now：${raw}`)
}

function parseIn(value) {
  if (value == null) return null
  if (typeof value === 'number') return Math.max(0, value) * 60_000
  const m = /^(\d+(?:\.\d+)?)\s*(m|min|分钟|h|小时)?$/.exec(String(value).trim())
  if (!m) return null
  const n = Number(m[1])
  return (m[2] === 'h' || m[2] === '小时' ? n * 60 : n) * 60_000
}

function pointOf(schedule, now) {
  const parsed = schedule.__parsed ?? parseAt(schedule.at, now)
  if (parsed.kind === 'once') return parsed.at
  const d = new Date(now)
  d.setHours(parsed.hour, parsed.minute, 0, 0)
  return d.getTime()
}

/** 声明式白名单：任一条规则的全部字段匹配即放行。 */
export function allowMatch(allow, signal) {
  const rules = Array.isArray(allow) ? allow : []
  const text = String(signal?.text ?? '').toLowerCase()
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue
    if (rule.from != null && String(rule.from) !== String(signal.from?.plugin)) continue
    if (rule.kinds != null && ![].concat(rule.kinds).includes(String(signal.kind))) continue
    if (rule.tags != null && !rule.tags.some((t) => signal.tags?.includes(String(t)))) continue
    if (rule.any != null && !rule.any.some((word) => text.includes(String(word).toLowerCase()))) continue
    return true
  }
  return false
}

/** 把工具/API 的入参规整成一条安排。 */
export function normalizeSchedule(input = {}, now = Date.now()) {
  const mode = input.mode === 'goal' ? 'goal' : 'wake'
  const inMs = parseIn(input.in ?? input.inMinutes ?? null)
  const startAt = input.at != null ? String(input.at) : (inMs != null ? new Date(now + inMs).toISOString() : null)
  if (!startAt) throw new Error('安排需要 at（HH:mm / ISO / now）或 in（如 10m）')
  const parsed = parseAt(startAt, now)
  const endMs = parseIn(input.duration ?? input.durationMin ?? null)
  const untilRaw = input.until ?? null
  const untilAt = untilRaw != null && Number.isFinite(Date.parse(String(untilRaw))) ? Date.parse(String(untilRaw)) : null
  const kind = input.sleep === true || input.kind === 'span' || endMs != null || untilAt != null ? 'span' : 'single'
  // 睡眠必须有终点；只给 sleep:true 没给时长时默认 3 分钟，和提示词"三分钟后回来"一致。
  const durationMin = endMs != null
    ? Math.round(endMs / 60_000)
    : (input.sleep === true && untilAt == null ? 3 : null)
  return {
    id: String(input.id ?? `s-${Date.now().toString(36)}`),
    mode,
    kind,
    at: startAt,
    durationMin,
    until: untilAt,
    message: String(input.message ?? ''),
    theme: String(input.theme ?? input.message ?? ''),
    sleep: input.sleep === true,
    silent: input.silent === true,
    tags: Array.isArray(input.tags) ? input.tags.map(String).slice(0, 8) : [],
    focus: input.focus == null ? null : String(input.focus),
    allow: Array.isArray(input.allow) ? input.allow : null,
    turnLimit: input.turnLimit == null ? null : Math.max(1, Number(input.turnLimit) || 1),
    __parsed: parsed,
  }
}

export function apply(ctx) {
  const stateFile = ctx.config.stateFile
    ? String(ctx.config.stateFile)
    : path.join(String(ctx.config.root ?? '.'), 'state', 'time.json')
  const tickMs = Math.max(1000, Number(ctx.config.tickMs ?? 15_000))
  const inboxFile = ctx.config.inboxFile ? String(ctx.config.inboxFile) : path.join(path.dirname(stateFile), 'time.inbox.jsonl')
  const outboxFile = ctx.config.outboxFile ? String(ctx.config.outboxFile) : path.join(path.dirname(stateFile), 'time.outbox.jsonl')
  let inboxOffset = 0

  // signals 是宿主 ctx 上的服务，不在 shared 能力表里；旧代码的回退分支必然抛错。
  const signals = ctx.signals
  if (!signals?.offer) throw new Error('time 需要 ctx.signals 服务')
  const world = ctx.services.get('world')
  const focusApi = ctx.focus ?? ctx.services.get('focus') ?? null
  const clock = ctx.services.clock ?? null

  const blank = () => ({ phase: 'awake', since: ctx.now(), schedules: [], queue: [], goals: [], spans: [], fired: {}, sleepingId: null, sleepUntil: null })
  let state = blank()
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    if (saved && typeof saved === 'object') {
      state = { ...blank(), ...saved, phase: PHASES.includes(saved.phase) ? saved.phase : 'awake' }
      state.schedules = Array.isArray(saved.schedules) ? saved.schedules : []
      state.queue = Array.isArray(saved.queue) ? saved.queue : []
      state.goals = Array.isArray(saved.goals) ? saved.goals : []
      state.spans = Array.isArray(saved.spans) ? saved.spans : []
      for (const schedule of state.schedules) { try { schedule.__parsed = parseAt(schedule.at, ctx.now()) } catch { /* 坏数据跳过 */ } }
      // 清理：过期的 one-time 日程、以及完全重复的日程（重启/多次测试最容易堆出来）
      const nowMs = ctx.now()
      const seen = new Set()
      state.schedules = state.schedules.filter((schedule) => {
        const parsed = schedule.__parsed
        if (parsed?.kind === 'once' && parsed.at != null && parsed.at < nowMs - 10 * 60_000) return false
        const key = `${schedule.mode}|${schedule.kind}|${parsed?.at ?? schedule.at}|${schedule.message ?? ''}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
    }
  } catch { /* 第一次运行 */ }

  const goalLeases = new Map()
  let sleepLease = null
  let pausedAt = null

  function persist() {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true })
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 1), 'utf8')
    } catch (error) { ctx.log({ level: 'warn', msg: 'time.persist', error: String(error?.message ?? error) }) }
  }

  function send({ kind = 'notice', text, focus: target = null, tags = [] }) {
    return signals.offer({ from: { plugin: 'time', activity: 'schedule' }, kind, text, focus: target, tags })
  }

  function enqueue(signal, reason) {
    state.queue.push({
      id: `q-${state.queue.length + 1}-${Date.now()}`,
      from: signal.from, kind: signal.kind, text: signal.text, tags: signal.tags ?? [],
      focus: signal.focus ?? null, reason, at: ctx.now(), expiresAt: signal.expiresAt ?? null,
    })
    persist()
  }

  function gate(signal) {
    if (signal.from?.plugin === 'time') return { accept: true }
    if (state.phase === 'paused') { enqueue(signal, 'paused'); return { accept: false, reason: 'paused' } }
    if (state.phase === 'sleeping') {
      const schedule = state.schedules.find((s) => s.id === state.sleepingId)
      if (allowMatch(schedule?.allow ?? DEFAULT_ALLOW, signal)) return { accept: true }
      enqueue(signal, 'sleeping')
      return { accept: false, reason: 'sleeping' }
    }
    return { accept: true }
  }

  function flushQueue(reason) {
    if (!state.queue.length) return 0
    const now = ctx.now()
    const fresh = state.queue.filter((item) => !item.expiresAt || item.expiresAt > now)
    state.queue = []
    if (!fresh.length) { persist(); return 0 }
    const body = fresh.map((item) => `· [${item.from?.plugin ?? '?'}] ${item.text}`).join('\n')
    send({ kind: 'notice', text: `（${reason}）积压了 ${fresh.length} 条消息：\n${body}`, tags: ['backlog'] })
    persist()
    return fresh.length
  }

  function goalMessage(goal) {
    const left = goal.turnLimit == null ? '' : `（还剩 ${goal.turnLimit} 轮）`
    return `你在目标内：${goal.theme}${left}。若退出，请取消这个安排。`
  }

  function addGoal(input = {}) {
    const theme = String(input.theme ?? input.message ?? '').trim()
    if (!theme) throw new Error('目标需要 theme')
    let until = null
    if (input.until != null) {
      const parsed = Date.parse(String(input.until))
      if (Number.isFinite(parsed)) until = parsed
    } else if (input.durationMin != null) {
      until = ctx.now() + Math.max(1, Number(input.durationMin)) * 60_000
    }
    const goal = {
      id: String(input.id ?? `g-${state.goals.length + 1}`),
      theme, until,
      turnLimit: input.turnLimit == null ? null : Math.max(1, Number(input.turnLimit) || 1),
      focus: input.focus == null ? null : String(input.focus),
      resumeOnStop: input.resumeOnStop !== false,
      createdAt: ctx.now(),
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
        }))
      } catch { /* ignore */ }
    }
    send({ kind: 'goal', text: goalMessage(goal), tags: ['goal'], focus: goal.focus })
    persist()
    return goal
  }

  function removeGoal(id) {
    const key = String(id)
    const before = state.goals.length
    state.goals = state.goals.filter((g) => g.id !== key)
    const lease = goalLeases.get(key)
    if (lease) { try { lease.release?.() } catch { /* ignore */ } goalLeases.delete(key) }
    persist()
    return { removed: before !== state.goals.length }
  }

  function resumeGoals() {
    if (state.phase !== 'awake') return 0
    let n = 0
    for (const goal of [...state.goals]) {
      if (!goal.resumeOnStop) continue
      if (goal.turnLimit != null) {
        if (goal.turnLimit <= 0) {
          send({ kind: 'goal', text: `目标结束：${goal.theme}。`, tags: ['goal', 'ended'] })
          removeGoal(goal.id)
          continue
        }
        goal.turnLimit -= 1
      }
      send({ kind: 'goal', text: goalMessage(goal), tags: ['goal', 'resume'] })
      n += 1
    }
    persist()
    return n
  }

  async function startSchedule(schedule) {
    const now = ctx.now()
    // 通用日历事件：time 不认识 dream/任何消费者，只把"哪条安排响了"发出去；
    // 插件按 tags 订阅（dream 的每日安排就是 tags:['dream']）。
    try {
      ctx.signals.emit({
        from: { plugin: 'time', activity: 'schedule' },
        kind: 'event',
        text: `schedule:${schedule.id}`,
        tags: ['schedule-start', ...(Array.isArray(schedule.tags) ? schedule.tags : [])],
        meta: {
          scheduleId: schedule.id,
          mode: schedule.mode,
          kind: schedule.kind,
          sleep: Boolean(schedule.sleep),
          message: schedule.message ?? '',
          at: now,
        },
      })
    } catch { /* 没有信号服务时仍按本安排原有行为走 */ }
    if (schedule.mode === 'goal') {
      addGoal({
        theme: schedule.theme || schedule.message || schedule.id,
        until: schedule.until ?? null,
        durationMin: schedule.durationMin,
        turnLimit: schedule.turnLimit,
        focus: schedule.focus,
      })
    } else if (schedule.kind === 'span') {
      const endAt = schedule.until ?? now + (Number(schedule.durationMin) || 0) * 60_000
      if (schedule.sleep) {
        state.phase = 'sleeping'
        state.sleepingId = schedule.id
        state.since = now
        state.sleepUntil = endAt
        if (focusApi?.enter) { try { sleepLease = focusApi.enter({ label: 'sleep', owner: 'time', reason: 'sleeping', title: '睡眠', kind: 'idle', interruptible: false }) } catch { sleepLease = null } }
      }
      if (!schedule.silent) {
        send({
          kind: 'wake',
          text: schedule.message || (schedule.sleep
          ? '到整理时间了。把今天的经历放下，我要把它们沉淀成记忆；三分钟后回来。'
          : `开始了：${schedule.id}`),
          tags: [schedule.sleep ? 'sleep' : 'span'],
        })
      }
      state.spans.push({
        id: schedule.id,
        until: endAt,
        endMessage: schedule.sleep ? '整理完了。今天看到的东西已经记下来了，接着来吧。' : `结束了：${schedule.id}`,
        sleep: Boolean(schedule.sleep),
      })
      if (schedule.sleep) {
        try { ctx.signals.emit({ from: { plugin: 'time' }, kind: 'event', text: 'sleep-start', tags: ['sleep'] }) } catch { /* ignore */ }
      }
    } else {
      if (!schedule.silent) send({ kind: 'wake', text: schedule.message || `到点了：${schedule.id}`, tags: ['wake'] })
    }
    state.fired[`${schedule.id}@${dayKey(now)}`] = now
    persist()
    return { started: schedule.id, mode: schedule.mode, kind: schedule.kind }
  }

  async function endSpan(span) {
    state.spans = state.spans.filter((s) => s.id !== span.id)
    if (span.sleep && state.phase === 'sleeping') {
      state.phase = 'awake'
      state.sleepingId = null
      state.sleepUntil = null
      state.since = ctx.now()
      if (sleepLease) { try { sleepLease.release?.() } catch { /* ignore */ } sleepLease = null }
      try { ctx.signals.emit({ from: { plugin: 'time' }, kind: 'event', text: 'sleep-end', tags: ['sleep'] }) } catch { /* ignore */ }
      send({ kind: 'wake', text: span.endMessage, tags: ['wake'] })
      return { ended: true, released: flushQueue('你睡觉时') }
    }
    send({ kind: 'wake', text: span.endMessage, tags: ['span'] })
    return { ended: true, released: 0 }
  }

  function clearFired(id) {
    const prefix = `${id}@`
    for (const key of Object.keys(state.fired)) {
      if (key.startsWith(prefix)) delete state.fired[key]
    }
  }

  function addSchedule(input) {
    const schedule = normalizeSchedule(input, ctx.now())
    state.schedules = state.schedules.filter((s) => s.id !== schedule.id).concat(schedule)
    // 同一个 id 取消/改期后今天还能再响；否则 fired 会把它永久挡在今天之外。
    clearFired(schedule.id)
    persist()
    return schedule
  }

  function removeSchedule(id) {
    const before = state.schedules.length
    state.schedules = state.schedules.filter((s) => s.id !== String(id))
    clearFired(String(id))
    persist()
    return { removed: before !== state.schedules.length }
  }

  function editSchedule(id, patch = {}) {
    const current = state.schedules.find((s) => s.id === String(id))
    if (!current) return { edited: false }
    const next = normalizeSchedule({ ...current, ...patch, id: current.id }, ctx.now())
    state.schedules = state.schedules.map((s) => (s.id === current.id ? next : s))
    clearFired(current.id)
    persist()
    return { edited: true, schedule: next }
  }

  function pause() {
    if (state.phase !== 'paused') pausedAt = ctx.now()
    state.phase = 'paused'
    persist()
    return { paused: true }
  }

  function resume() {
    if (state.phase !== 'paused') return { resumed: false, phase: state.phase }
    const delta = pausedAt ? ctx.now() - pausedAt : 0
    // 暂停的是计时：进行中的 span 整体后移
    for (const span of state.spans) span.until += delta
    if (state.sleepUntil) state.sleepUntil += delta
    pausedAt = null
    state.phase = state.sleepingId ? 'sleeping' : 'awake'
    state.since = ctx.now()
    persist()
    const released = flushQueue('暂停期间')
    return { resumed: true, released }
  }

  async function tick(at = ctx.now()) {
    try { processInbox() } catch { /* 控制通道失败不影响主流程 */ }
    if (state.phase === 'paused') return

    for (const span of [...state.spans]) {
      if (at >= span.until) await endSpan(span)
    }

    const alive = []
    for (const goal of state.goals) {
      if (goal.until && at >= goal.until) {
        send({ kind: 'goal', text: `目标结束：${goal.theme}。`, tags: ['goal', 'ended'] })
        const lease = goalLeases.get(goal.id)
        if (lease) { try { lease.release?.() } catch { /* ignore */ } goalLeases.delete(goal.id) }
        continue
      }
      alive.push(goal)
    }
    if (alive.length !== state.goals.length) state.goals = alive

    for (const schedule of [...state.schedules]) {
      const point = pointOf(schedule, at)
      if (point == null) continue
      const key = `${schedule.id}@${dayKey(point)}`
      if (state.fired[key]) continue
      if (at < point) continue
      if (schedule.__parsed?.kind === 'once' && at - point > 86_400_000) continue
      await startSchedule(schedule)
    }
    persist()
  }

  function processInbox() {
    let text = ''
    try { text = fs.readFileSync(inboxFile, 'utf8') } catch { return { processed: 0 } }
    // 文件被截断/重建时 offset 会比长度大，必须归零，否则永远读不到新命令
    if (text.length < inboxOffset) inboxOffset = 0
    if (text.length <= inboxOffset) return { processed: 0 }
    const chunk = text.slice(inboxOffset)
    inboxOffset = text.length
    let processed = 0
    for (const line of chunk.split('\n')) {
      const raw = line.trim()
      if (!raw) continue
      let request = null
      try { request = JSON.parse(raw) } catch { continue }
      let result
      try {
        result = runCommand(request)
      } catch (error) {
        try { fs.writeFileSync(path.join(path.dirname(stateFile), 'inbox-error.json'), String(error?.stack ?? error), 'utf8') } catch { /* ignore */ }
        result = { ok: false, error: String(error?.message ?? error) }
      }
      try {
        fs.mkdirSync(path.dirname(outboxFile), { recursive: true })
        fs.appendFileSync(outboxFile, `${JSON.stringify({ id: request?.id ?? null, at: ctx.now(), ...result })}\n`, 'utf8')
      } catch { /* ignore */ }
      processed += 1
    }
    return { processed }
  }

  function runCommand(request) {
    const cmd = String(request?.cmd ?? '')
    const args = request?.args ?? {}
    try {
      switch (cmd) {
        case 'status': return { ok: true, result: api.status() }
        case 'pause': return { ok: true, result: pause() }
        case 'resume': return { ok: true, result: resume() }
        case 'arrange': return { ok: true, result: addSchedule(args) }
        case 'cancel': return { ok: true, result: removeSchedule(args.id) }
        case 'edit': return { ok: true, result: editSchedule(args.id, args) }
        case 'skip': return { ok: true, result: api.skip(args.id) }
        case 'queue': return { ok: true, result: api.queue() }
        case 'reset': {
          state = blank()
          persist()
          return { ok: true, result: { phase: state.phase } }
        }
        case 'goal_add': return { ok: true, result: addGoal(args) }
        case 'goal_remove': return { ok: true, result: removeGoal(args.id) }
        case 'goal_list': return { ok: true, result: api.goals() }
        default: return { ok: false, error: `未知命令：${cmd}` }
      }
    } catch (error) { return { ok: false, error: String(error?.message ?? error) } }
  }

  if (state.queue.length) flushQueue('日程因重启发生错误')

  signals.setGate(gate)
  try { ctx.signals.on({ tags: ['turn-end'] }, () => { resumeGoals() }) } catch { /* ignore */ }

  const api = {
    now: () => ctx.now(),
    phase: () => state.phase,
    schedules: () => state.schedules.map(({ __parsed, ...s }) => s),
    queue: () => state.queue.map((q) => ({ ...q })),
    add: addSchedule,
    edit: editSchedule,
    remove: removeSchedule,
    skip(id) {
      const before = state.queue.length
      state.queue = state.queue.filter((q) => q.id !== String(id))
      persist()
      return { skipped: before !== state.queue.length }
    },
    async sleep({ message = '到整理时间了。把今天的经历放下，我要把它们沉淀成记忆；三分钟后回来。', durationMin = 3 } = {}) {
      const schedule = addSchedule({ id: `sleep-${Date.now()}`, at: 'now', mode: 'wake', sleep: true, message, durationMin })
      return startSchedule(schedule)
    },
    async wake() {
      const span = state.spans.find((s) => s.sleep)
      if (span) return endSpan(span)
      if (state.phase === 'sleeping') {
        state.phase = 'awake'
        state.sleepingId = null
        state.sleepUntil = null
        if (sleepLease) { try { sleepLease.release?.() } catch { /* ignore */ } sleepLease = null }
        send({ kind: 'wake', text: '你醒了。', tags: ['wake'] })
        return { ended: true, released: flushQueue('你睡觉时') }
      }
      return { ended: false }
    },
    tick,
    processInbox,
    runCommand,
    pause,
    resume,
    setClock(fn) { return clock ? clock.set(fn) : () => {} },
    ownsClock: () => Boolean(clock?.owns?.()),
    addGoal,
    removeGoal,
    goals: () => state.goals.map((g) => ({ ...g })),
    resumeGoals,
    status: () => ({
      phase: state.phase,
      since: state.since,
      sleepUntil: state.sleepUntil ?? null,
      spans: state.spans.map((s) => ({ ...s })),
      schedules: api.schedules(),
      backlog: state.queue.length,
      goals: api.goals(),
    }),
  }

  if (world?.registerSource) {
    world.registerSource({
      id: 'time', owner: 'time', title: '时间', order: 1, cap: 3,
      items: () => {
        const phaseText = ({ awake: '醒着', sleeping: '睡着', paused: '暂停' })[state.phase] ?? state.phase
        const lines = [`现在是 ${stampAt(ctx.now())}；阶段：${phaseText}。`]
        const next = state.schedules.map((s) => ({ s, at: pointOf(s, ctx.now()) })).filter((x) => x.at > ctx.now()).sort((a, b) => a.at - b.at)[0]
        if (next) lines.push(`下一个安排：${next.s.id}（${next.s.mode}/${next.s.kind}，${stampAt(next.at)}）。`)
        if (state.goals.length) lines.push(`进行中的目标：${state.goals.map((g) => g.theme).join('、')}。`)
        if (state.queue.length) lines.push(`积压：${state.queue.length} 条。`)
        return lines.map((brief, i) => ({ key: `l${i}`, brief }))
      },
    })
  }

  // ── 工具面：只围绕"安排"与"时间状态" ───────────────────────────
  const tool = (def) => ctx.tools.register(def)
  tool({
    name: 'time_status',
    summary: '现在几点、处在什么阶段、有哪些安排在进行、积压了多少。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute() {
      const s = api.status()
      const lines = [
        `现在：${stampAt(ctx.now())}`,
        `阶段：${s.phase}`,
      ]
      if (s.spans.length) lines.push(`进行中：${s.spans.map((x) => `${x.id}${x.sleep ? '（睡觉）' : ''} 到 ${stampAt(x.until)}`).join('；')}`)
      if (s.goals.length) lines.push(`目标：${s.goals.map((g) => `${g.theme}${g.turnLimit == null ? '' : `（剩 ${g.turnLimit} 轮）`}`).join('；')}`)
      if (s.backlog) lines.push(`积压：${s.backlog} 条`)
      return { text: lines.join('\n') }
    },
  })
  tool({
    name: 'time_arrange',
    summary: '新建一条安排。mode 决定这次唤醒是"叫她一声"(wake)还是"让她持续做"(goal)；kind 决定单发(single)还是长日程(span)。goal 会持续在 turn 末保底唤醒；不需要被持续唤醒时用 time_cancel 取消，别留着空跑。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['mode'], properties: {
        mode: { type: 'string', enum: ['wake', 'goal'], description: 'wake=发消息；goal=持续目标' },
        kind: { type: 'string', enum: ['single', 'span'], description: 'single=一次；span=有开始和结束' },
        at: { type: 'string', description: 'HH:mm、ISO 或 now' },
        in: { type: 'string', description: '多久之后，如 10m / 2h' },
        duration: { type: 'string', description: 'span 持续多久，如 8h / 30m' },
        message: { type: 'string', description: '唤醒时说的话（wake）或目标主题（goal）' },
        theme: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' }, description: '给安排打标签；插件可按标签订阅 schedule-start 事件' },
        focus: { type: 'string', description: 'goal 绑定的注意力空间' },
        turnLimit: { type: 'number', description: 'goal+single 的轮次上限' },
        sleep: { type: 'boolean', description: 'wake+span 且要进入睡眠时设 true' },
        allow: { type: 'array', items: { type: 'object' }, description: '睡眠期间的白名单' },
      },
    },
    async execute(input = {}) {
      const schedule = addSchedule(input)
      return { text: `安排好了：${schedule.id}（${schedule.mode}/${schedule.kind}，${schedule.at}${schedule.durationMin ? `，持续 ${schedule.durationMin} 分钟` : ''}）。` }
    },
  })
  tool({
    name: 'time_list',
    summary: '列出所有安排（包括还没到的、正在进行的）。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute() {
      const list = api.schedules()
      const spans = api.status().spans
      const lines = []
      if (spans.length) lines.push(...spans.map((s) => `· 进行中 ${s.id}${s.sleep ? '（睡觉）' : ''} 到 ${stampAt(s.until)}`))
      lines.push(...list.map((s) => `· ${s.id} ${s.mode}/${s.kind} ${s.at}${s.durationMin ? ` 持续 ${s.durationMin} 分` : ''}${s.sleep ? '（睡觉）' : ''}：${s.message || s.theme || ''}`))
      return { text: lines.length ? lines.join('\n') : '还没有安排。' }
    },
  })
  tool({
    name: 'time_edit',
    summary: '修改一条安排：改时间、改消息、改模式都可以。想把安排往后推，就改它的 at/in。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['id'], properties: {
        id: { type: 'string' }, at: { type: 'string' }, in: { type: 'string' },
        message: { type: 'string' }, mode: { type: 'string', enum: ['wake', 'goal'] }, duration: { type: 'string' },
      },
    },
    async execute({ id, ...patch } = {}) {
      const out = editSchedule(id, patch)
      return { text: out.edited ? `改好了：${id}` : `没有这个安排：${id}` }
    },
  })
  tool({
    name: 'time_cancel',
    summary: '取消一条安排（进行中的长日程会立刻结束，绑定的目标与注意力空间一起释放）。',
    parameters: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' } } },
    async execute({ id } = {}) {
      const span = state.spans.find((s) => s.id === String(id))
      if (span) { await endSpan(span); return { text: `结束了：${id}` } }
      const removed = removeSchedule(id)
      if (removed.removed) return { text: `取消了：${id}` }
      const goalRemoved = removeGoal(id)
      return { text: goalRemoved.removed ? `目标已取消：${id}` : `没有这个安排：${id}` }
    },
  })
  tool({
    name: 'time_pause',
    summary: '暂停计时：进行中的安排不再推进，消息全部积压。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute() { pause(); return { text: '已暂停计时。' } },
  })
  tool({
    name: 'time_resume',
    summary: '恢复计时，并把暂停期间积压的消息放出来。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute() { const out = resume(); return { text: out.resumed ? `恢复了，释放了 ${out.released ?? 0} 条。` : `当前不是暂停状态：${out.phase}` } },
  })

  const timer = setInterval(() => {
    void tick().catch((error) => {
      try { fs.writeFileSync(path.join(path.dirname(stateFile), 'tick-error.json'), String(error?.stack ?? error), 'utf8') } catch { /* ignore */ }
    })
  }, tickMs)
  if (typeof timer.unref === 'function') timer.unref()
  ctx.onDispose(() => clearInterval(timer))
  ctx.onDispose(() => { signals.setGate(null) })

  ctx.services.provide('time', api)
  persist()
  ctx.log({ msg: 'time.ready', phase: state.phase, schedules: state.schedules.length })
  return api
}
