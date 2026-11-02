// 时间模块：会话的唯一时钟、唯一唤醒者、唯一纵向拦截层。
//
// 设计见 docs/TIME-MODULE.md 与 docs/MESSAGE-MODEL.md。
// 本文件实现 M2（骨架）：状态机、日程、队列、白名单、时钟、世界状态、工具。
// goal 与"模型停下即 resume"在 M3 接上。
import fs from 'node:fs'
import path from 'node:path'

export const name = 'time'

const DEFAULT_ALLOW = Object.freeze([{ from: 'admin' }])

function dayKey(at) {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function parseAt(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const hm = /^(\d{1,2}):(\d{2})$/.exec(raw)
  if (hm) return { kind: 'daily', hour: Number(hm[1]), minute: Number(hm[2]) }
  const iso = Date.parse(raw)
  if (Number.isFinite(iso)) return { kind: 'once', at: iso }
  throw new Error(`at 格式应为 HH:mm 或 ISO 时间：${raw}`)
}

function pointOf(schedule, now) {
  const parsed = schedule.__parsed ?? parseAt(schedule.at)
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

export function apply(ctx) {
  const stateFile = ctx.config.stateFile
    ? String(ctx.config.stateFile)
    : path.join(String(ctx.config.root ?? '.'), 'state', 'time.json')
  const tickMs = Math.max(1000, Number(ctx.config.tickMs ?? 15_000))
  const signals = ctx.signals ?? ctx.services.require('signals')
  const world = ctx.services.get('world')
  const focus = ctx.services.get('focus')

  let state = { phase: 'awake', since: ctx.now(), schedules: [], queue: [], goals: [], fired: {} }
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    if (saved && typeof saved === 'object') {
      state = {
        phase: ['awake', 'sleeping', 'paused'].includes(saved.phase) ? saved.phase : 'awake',
        since: Number(saved.since) || ctx.now(),
        schedules: Array.isArray(saved.schedules) ? saved.schedules : [],
        queue: Array.isArray(saved.queue) ? saved.queue : [],
        goals: Array.isArray(saved.goals) ? saved.goals : [],
        fired: saved.fired && typeof saved.fired === 'object' ? saved.fired : {},
        sleepUntil: Number(saved.sleepUntil) || null,
      }
    }
  } catch { /* 第一次运行 */ }

  function persist() {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true })
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 1), 'utf8')
    } catch (error) {
      ctx.log({ level: 'warn', msg: 'time.persist', error: String(error?.message ?? error) })
    }
  }

  function send({ kind = 'notice', text, focus: target = null, tags = [] }) {
    return signals.offer({
      from: { plugin: 'time', activity: 'schedule' },
      kind,
      text,
      focus: target,
      tags,
    })
  }

  /** 纵向拦截：放行 / 入队。 */
  function gate(signal) {
    // 时间模块自己的消息永远放行（否则自己的醒来消息会被自己拦下）
    if (signal.from?.plugin === 'time') return { accept: true }
    if (state.phase === 'paused') { enqueue(signal, 'paused'); return { accept: false, reason: 'paused' } }
    if (state.phase === 'sleeping') {
      const schedule = state.schedules.find((s) => s.id === state.sleepingId)
      const allow = schedule?.allow ?? DEFAULT_ALLOW
      if (allowMatch(allow, signal)) return { accept: true }
      enqueue(signal, 'sleeping')
      return { accept: false, reason: 'sleeping' }
    }
    return { accept: true }
  }

  function enqueue(signal, reason) {
    state.queue.push({
      id: `q-${state.queue.length + 1}-${Date.now()}`,
      from: signal.from,
      kind: signal.kind,
      text: signal.text,
      tags: signal.tags ?? [],
      focus: signal.focus ?? null,
      reason,
      at: ctx.now(),
      expiresAt: signal.expiresAt ?? null,
    })
    persist()
  }

  function flushQueue(reason) {
    if (!state.queue.length) return 0
    const now = ctx.now()
    const kept = []
    const fresh = []
    for (const item of state.queue) {
      if (item.expiresAt && item.expiresAt <= now) continue
      fresh.push(item)
    }
    state.queue = kept
    if (!fresh.length) { persist(); return 0 }
    const body = fresh.map((item) => `· [${item.from?.plugin ?? '?'}] ${item.text}`).join('\n')
    send({ kind: 'notice', text: `（${reason}）积压了 ${fresh.length} 条消息：\n${body}`, tags: ['backlog'] })
    persist()
    return fresh.length
  }

  async function startSchedule(schedule) {
    const now = ctx.now()
    const role = schedule.role ?? (schedule.durationMin ? 'activity' : 'reminder')
    if (role === 'sleep') {
      state.phase = 'sleeping'
      state.sleepingId = schedule.id
      state.since = now
      state.sleepUntil = schedule.durationMin ? now + schedule.durationMin * 60_000 : null
      send({ kind: 'wake', text: schedule.message ?? '你困了，接下来不会有人打扰你。', tags: ['sleep'] })
      // 做梦与时间并行，互不阻塞
      try {
        const dream = ctx.services.get('dream')
        if (dream?.run) void dream.run({ now })
      } catch { /* dream 不在也不影响睡觉 */ }
    } else {
      send({ kind: 'wake', text: schedule.message ?? `到点了：${schedule.id}`, tags: ['schedule'] })
    }
    state.fired[`${schedule.id}@${dayKey(now)}`] = now
    persist()
    return { started: schedule.id, role }
  }

  async function endSleep(reason) {
    if (state.phase !== 'sleeping') return { ended: false }
    state.phase = 'awake'
    state.sleepingId = null
    state.sleepUntil = null
    state.since = ctx.now()
    send({ kind: 'wake', text: reason ?? '你睡醒了，昨天的记忆已经整理好了。', tags: ['wake'] })
    const released = flushQueue('你睡觉时')
    persist()
    return { ended: true, released }
  }

  async function tick(at = ctx.now()) {
    if (state.phase === 'sleeping' && state.sleepUntil && at >= state.sleepUntil) {
      await endSleep('你睡醒了，昨天的记忆已经整理好了。')
    }
    for (const schedule of [...state.schedules]) {
      const point = pointOf(schedule, at)
      if (point == null) continue
      const key = `${schedule.id}@${dayKey(point)}`
      const once = parseAt(schedule.at).kind === 'once'
      if (state.fired[key]) continue
      if (once && at >= point) { if (state.phase !== 'sleeping') await startSchedule(schedule) }
      else if (at >= point && at - point < 86_400_000) { await startSchedule(schedule) }
    }
  }

  function addSchedule(input) {
    const parsed = parseAt(input?.at)
    if (!parsed) throw new Error('time_add 需要 at')
    const schedule = {
      id: String(input?.id ?? `s-${state.schedules.length + 1}`),
      at: String(input.at),
      role: String(input?.role ?? (input?.durationMin ? 'activity' : 'reminder')),
      message: String(input?.message ?? ''),
      durationMin: input?.durationMin == null ? null : Math.max(0, Number(input.durationMin)),
      allow: Array.isArray(input?.allow) ? input.allow : null,
      __parsed: parsed,
    }
    state.schedules = state.schedules.filter((s) => s.id !== schedule.id).concat(schedule)
    persist()
    return schedule
  }

  function removeSchedule(id) {
    const before = state.schedules.length
    state.schedules = state.schedules.filter((s) => s.id !== String(id))
    persist()
    return { removed: before !== state.schedules.length }
  }

  // 启动时：如果有积压，明确报错并释放
  if (state.queue.length) {
    flushQueue('日程因重启发生错误')
  }
  if (state.phase === 'sleeping' && !state.sleepingId) state.phase = 'awake'

  signals.setGate(gate)

  // 时钟唯一来源
  const api = {
    now: () => ctx.now(),
    phase: () => state.phase,
    schedules: () => state.schedules.map(({ __parsed, ...s }) => s),
    queue: () => state.queue.map((q) => ({ ...q })),
    add: addSchedule,
    remove: removeSchedule,
    skip(id) {
      const before = state.queue.length
      state.queue = state.queue.filter((q) => q.id !== String(id))
      persist()
      return { skipped: before !== state.queue.length }
    },
    delay(id, minutes) {
      const item = state.queue.find((q) => q.id === String(id))
      if (!item) return { delayed: false }
      item.at = ctx.now() + Math.max(0, Number(minutes) || 0) * 60_000
      persist()
      return { delayed: true }
    },
    async sleep({ message = '你困了，接下来不会有人打扰你。', durationMin = null } = {}) {
      const schedule = addSchedule({ id: `sleep-${Date.now()}`, at: '00:00', role: 'sleep', message, durationMin })
      return startSchedule(schedule)
    },
    async wake() { return endSleep('你醒了。') },
    tick: (at) => tick(at),
    status: () => ({
      phase: state.phase,
      since: state.since,
      sleepUntil: state.sleepUntil ?? null,
      schedules: api.schedules(),
      backlog: state.queue.length,
      goals: state.goals,
    }),
  }

  if (world?.registerSource) {
    world.registerSource({
      id: 'time', owner: 'time', title: '时间', order: 5, cap: 3,
      items: () => {
        const lines = [`现在是 ${new Date(ctx.now()).toLocaleString('zh-CN', { hour12: false }).slice(0, 16)}；阶段：${state.phase}。`]
        const next = state.schedules
          .map((s) => ({ s, at: pointOf(s, ctx.now()) }))
          .filter((x) => x.at > ctx.now())
          .sort((a, b) => a.at - b.at)[0]
        if (next) lines.push(`下一个日程：${next.s.id}（${new Date(next.at).toLocaleString('zh-CN', { hour12: false }).slice(0, 16)}）。`)
        if (state.queue.length) lines.push(`积压：${state.queue.length} 条。`)
        return lines.map((brief, i) => ({ key: `l${i}`, brief }))
      },
    })
  }

  const tool = (def) => ctx.tools.register(def)
  tool({
    name: 'time_now', summary: '现在几点、当前阶段、下一个日程、积压多少。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute() {
      const s = api.status()
      const next = s.schedules.map((x) => ({ x, at: pointOf(x, ctx.now()) })).filter((y) => y.at > ctx.now()).sort((a, b) => a.at - b.at)[0]
      return {
        text: [
          `现在：${new Date(ctx.now()).toLocaleString('zh-CN', { hour12: false }).slice(0, 16)}`,
          `阶段：${s.phase}`,
          next ? `下一个日程：${next.x.id}（${new Date(next.at).toLocaleString('zh-CN', { hour12: false }).slice(0, 16)}）` : '下一个日程：无',
          s.backlog ? `积压：${s.backlog} 条` : '积压：无',
        ].join('\n'),
      }
    },
  })
  tool({
    name: 'time_schedule', summary: '查看全部日程。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute() {
      const list = api.schedules()
      return { text: list.length ? list.map((s) => `· ${s.id} ${s.at}${s.durationMin ? `（持续 ${s.durationMin} 分）` : ''}：${s.message || '(无消息)'}`).join('\n') : '还没有安排。' }
    },
  })
  tool({
    name: 'time_add', summary: '新增一个日程（到点给会话发一条 wake 消息）。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['at'], properties: {
        id: { type: 'string' }, at: { type: 'string', description: 'HH:mm 或 ISO 时间' },
        message: { type: 'string' }, durationMin: { type: 'number' },
        role: { type: 'string', description: 'sleep 表示睡觉' },
      },
    },
    async execute(input = {}) {
      const s = addSchedule(input)
      return { text: `加好了：${s.id}（${s.at}）。` }
    },
  })
  tool({
    name: 'time_remove', summary: '删除一个日程。',
    parameters: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' } } },
    async execute({ id } = {}) {
      const out = removeSchedule(id)
      return { text: out.removed ? `删掉了：${id}` : `没有这个日程：${id}` }
    },
  })
  tool({
    name: 'time_skip', summary: '跳过一条积压消息（仅本次）。',
    parameters: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' } } },
    async execute({ id } = {}) {
      const out = api.skip(id)
      return { text: out.skipped ? `跳过了：${id}` : `没有这条：${id}` }
    },
  })
  tool({
    name: 'time_delay', summary: '把一条积压消息推迟几分钟再放出来。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['id', 'minutes'],
      properties: { id: { type: 'string' }, minutes: { type: 'number' } },
    },
    async execute({ id, minutes } = {}) {
      const out = api.delay(id, minutes)
      return { text: out.delayed ? `推迟了 ${minutes} 分钟。` : `没有这条：${id}` }
    },
  })
  tool({
    name: 'time_sleep', summary: '现在就去睡（进入睡眠阶段，可选持续时间）。',
    parameters: { type: 'object', additionalProperties: false, properties: { message: { type: 'string' }, durationMin: { type: 'number' } } },
    async execute({ message, durationMin } = {}) {
      await api.sleep({ message, durationMin })
      return { text: '好，去睡了。' }
    },
  })
  tool({
    name: 'time_wake', summary: '现在醒来。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute() { await api.wake(); return { text: '醒来了。' } },
  })

  const timer = setInterval(() => { void tick() }, tickMs)
  if (typeof timer.unref === 'function') timer.unref()
  ctx.onDispose(() => clearInterval(timer))
  ctx.onDispose(() => { signals.setGate(null) })

  ctx.services.provide('time', api)
  persist()
  ctx.log({ msg: 'time.ready', phase: state.phase, schedules: state.schedules.length })
  return api
}
