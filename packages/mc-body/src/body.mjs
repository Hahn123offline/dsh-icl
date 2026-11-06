// MC body 的领域核心：任务状态机、事件、幂等、取消、安全停止、看门狗、断线语义。
// 不依赖 mineflayer；真实执行由 adapter 注入，测试用 fake adapter。
//
// 行为契约（docs/MC-LEARNED.md）：
// - 任务 outcome：done / failed / cancelled / interrupted / unknown；断线时 running → paused；
// - unknown = 结果未知（超时/动作可能已生效），既不能当失败也不能当成功；
// - 断线暂停 running 任务；重连不自动续跑，必须显式 resume（body + task 两级）；
// - 看门狗：低血/掉血/低氧/危险方块/卡住/连接假死/心跳；idle 与 danger 配额分开；suppressed 有统计；
// - 出生点不安全 → 暂停 + 报警 + 不接任务。
import fs from 'node:fs'
import path from 'node:path'
import { createHeartbeat, createProgressTracker, createRateLimiter } from './recovery.mjs'
import { buildStructuredSnapshot, captureScreenshot } from './eyes.mjs'

const KINDS = new Set(['mine', 'goto', 'patrol', 'explore', 'follow', 'chat', 'routine', 'collect', 'tunnel', 'bridge', 'build', 'sort', 'deposit', 'shelter', 'farm'])
const TERMINAL = new Set(['done', 'failed', 'cancelled', 'interrupted', 'unknown'])
const MOVEMENT_KINDS = new Set(['goto', 'patrol', 'explore', 'follow'])
// 暂停时仍然允许的 op：感知/查询/恢复/取消/停止，以及**停止**（cancel+反射+报告，不需要先 resume）。
// 写动作（move/dig/place/task…）一律拒绝。
const SAFE_WHILE_PAUSED = new Set(['look', 'inventory', 'scan', 'map', 'events', 'tasks', 'resume', 'cancel', 'stop', 'say', 'wait'])
// alarm 级事件：必须能穿透 pause/focus 把会话叫醒（mc-link 不拦；body 这里打 priority/pierce 标记）。
const ALARM_TYPES = new Set(['safety_stop', 'death', 'spawn_unsafe', 'kicked', 'reconnect_exhausted', 'quarantine', 'idle_disconnect', 'emergency', 'reflex'])
// 暂停时的“安全反射”：不停世界，继续有界保命动作；防止脚本暂停 = 站桩挨打。
const REFLEX_MAX_DURATION_MS = 10_000
const REFLEX_MAX_PER_MINUTE = 2
// 暂停中仍必须穿透的“更严重事件”（不改变已暂停状态，但 alarm 一定要到）。
const ALARM_WHILE_PAUSED = new Set(['death', 'quarantine', 'spawn-unsafe', 'danger-block', 'low-oxygen', 'stuck', 'health-drop', 'connection-stale', 'low-health'])

function abortError(message = 'aborted') {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function httpError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode })
}

function posDistance(a, b) {
  if (!a || !b) return null
  const dx = Number(a.x) - Number(b.x)
  const dy = Number(a.y) - Number(b.y)
  const dz = Number(a.z) - Number(b.z)
  if (![dx, dy, dz].every(Number.isFinite)) return null
  return Math.hypot(dx, dy, dz)
}

function round1(value) {
  return Number.isFinite(Number(value)) ? Math.round(Number(value) * 10) / 10 : null
}

export function createBody({
  adapter,
  allowTask = true,
  allowSay = true,
  logFile = null,
  stateFile = null,
  now = () => Date.now(),
  eventLimit = 2000,
  watchdogMs = 2000,
  heartbeatMs = 60_000,
  alertWindowMs = 60_000,
  idleAlertPerMinute = 3,
  dangerAlertPerMinute = 12,
  movementStallMs = 25_000,
  packetStaleMs = 45_000,
  maxQueue = 32,
  chatRateMs = 1000,
  lowHealth = 10,
  pausedDisconnectMs = 120_000,
  // 暂停期安全反射（方案 B）：暂停只停任务/控制，不停物理世界；反射有界（默认 ≤10s/次、≤2 次/分）。
  reflexEnabled = true,
  reflexMaxDurationMs = REFLEX_MAX_DURATION_MS,
  reflexMaxPerMinute = REFLEX_MAX_PER_MINUTE,
  reflexMinIntervalMs = 500,
  alarmDedupeMs = 15_000,
  // 眼睛：结构化快照零依赖；截图需要 adapter viewer + Edge，按需、限频、用完即关。
  mediaDir = null,
  runId = null,
  eyesPortStart = 3998,
  eyesMinIntervalMs = 15_000,
  // 退出归因钩子：身体不知道“进程为什么退出”，但把这些可判定的时机交给宿主记录。
  onIdleDisconnect = null,
  onShutdownRequest = null,
} = {}) {
  if (!adapter) throw new Error('body 需要 adapter')

  const events = []
  const tasks = new Map()
  const queue = []
  const idempotency = new Map()
  const deaths = []
  const rate = createRateLimiter({
    now,
    windowMs: alertWindowMs,
    perWindow: { danger: dangerAlertPerMinute, idle: idleAlertPerMinute },
  })
  const heartbeat = createHeartbeat({ now, intervalMs: heartbeatMs })
  const movement = createProgressTracker({ now, stallMs: movementStallMs })
  const watchdogStats = { ticks: 0, alerts: 0, lastAlertAt: null, lastTickAt: null, startedAt: null }

  let seq = 0
  let taskSeq = 0
  let current = null
  let paused = false
  let pausedReason = null
  let activeDo = null
  let eyesBusy = false
  let lastEyesAt = 0
  let closed = false
  let started = false
  let pumping = false
  let returning = false
  let lastHealth = null
  let lastPulseAt = now()
  let lastChatAt = 0
  let watchdogTimer = null
  let pausedTimer = null
  // null = 还没判断过；true/false = 最近一次已知连接状态。
  let connectionState = null
  let everOnline = false
  let offlineEpisode = false
  let offlineReason = null
  let movementTaskId = null
  const suppressedNotified = {}
  const spawnLog = []
  const reflexState = {
    times: [], count: 0, active: false, lastAt: null, lastReason: null, lastAction: null,
    lastDurationMs: null, lastTimedOut: false, lastEventSeq: null, lastSuppressedAt: null,
  }
  const alarmState = {
    delivered: new Map(), pending: new Map(),
    deliveredCount: 0, suppressedCount: 0, redeliveredCount: 0, lastAt: null,
  }
  let lastSafetyStopAt = null

  function stamp() { return now() }

  function saveLedger() {
    if (!stateFile) return
    try {
      const rows = [...tasks.values()].map(({ controller, timer, abandonTimer, ...task }) => task)
      fs.mkdirSync(path.dirname(stateFile), { recursive: true })
      const tmp = `${stateFile}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ version: 2, savedAt: stamp(), tasks: rows }, null, 2), 'utf8')
      fs.renameSync(tmp, stateFile)
    } catch { /* 台账失败不影响身体；事件里有 body_error 兜底 */ }
  }

  function loadLedger() {
    if (!stateFile) return 0
    let loaded = 0
    try {
      const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      for (const raw of Array.isArray(data?.tasks) ? data.tasks : []) {
        if (!raw?.id) continue
        const task = { ...raw, controller: null, timer: null }
        // 重启后 mineflayer 的现场已经没了：没结束的任务一律 interrupted(body-restart)。
        if (!TERMINAL.has(task.state)) {
          task.state = 'interrupted'
          task.error = 'body-restart'
          task.finishedAt = task.finishedAt ?? stamp()
          task.pausedReason = null
        }
        tasks.set(task.id, task)
        if (task.idempotencyKey) idempotency.set(task.idempotencyKey, task.id)
        const num = Number(String(task.id).replace(/^t-/, ''))
        if (Number.isFinite(num)) taskSeq = Math.max(taskSeq, num)
        loaded += 1
      }
    } catch { /* 第一次运行 */ }
    return loaded
  }

  function push(type, data = {}) {
    seq += 1
    // alarm 事件三轮标记，方便 mc-link/time 任意一层识别：
    // 顶层 priority/pierce、data.priority/pierce、data.meta.priority/pierce。
    const isAlarm = ALARM_TYPES.has(type) || data?.priority === 'alarm' || data?.pierce === true
    const payload = isAlarm
      ? { ...data, priority: 'alarm', pierce: true, meta: { ...(data?.meta ?? {}), priority: 'alarm', pierce: true } }
      : data
    const event = { seq, at: stamp(), type, data: payload }
    if (isAlarm) { event.priority = 'alarm'; event.pierce = true }
    events.push(event)
    while (events.length > eventLimit) events.shift()
    if (type !== 'heartbeat') lastPulseAt = event.at
    if (logFile) {
      try {
        fs.mkdirSync(path.dirname(logFile), { recursive: true })
        fs.appendFileSync(logFile, `${JSON.stringify(event)}\n`, 'utf8')
      } catch { /* 日志失败不影响身体 */ }
    }
    return event
  }

  // alarm 投递：穿透 pause/focus（priority/pierce 标记），带 15s 去重；被去重拦截时记账并补投一次。
  function alarmKey(type, data = {}) {
    return `${type}:${String(data?.reason ?? data?.kind ?? '')}`
  }

  function pushAlarm(type, data = {}, { retry = false } = {}) {
    const key = alarmKey(type, data)
    const at = stamp()
    const last = alarmState.delivered.get(key)
    if (last != null && at - last < alarmDedupeMs) {
      alarmState.suppressedCount += 1
      const entry = alarmState.pending.get(key) ?? { type, data, attempts: 0, firstAt: at, lastAt: at }
      entry.attempts += 1
      entry.lastAt = at
      alarmState.pending.set(key, entry)
      push('alarm_suppressed', {
        type, key, reason: 'dedupe', windowMs: alarmDedupeMs,
        attempts: entry.attempts, redeliverInMs: Math.max(0, alarmDedupeMs - (at - last)),
      })
      return null
    }
    alarmState.delivered.set(key, at)
    alarmState.deliveredCount += 1
    alarmState.lastAt = at
    if (alarmState.pending.has(key)) { alarmState.pending.delete(key); alarmState.redeliveredCount += 1 }
    // 不管事件类型是什么，alarm 投递都显式带 priority/pierce（push 会再补顶层/meta 标记），mc-link/time 据此穿透 pause/focus。
    return push(type, { ...data, priority: 'alarm', pierce: true, ...(retry ? { redelivered: true } : {}) })
  }

  function retryPendingAlarms(at) {
    if (!alarmState.pending.size) return 0
    let retried = 0
    for (const [key, entry] of [...alarmState.pending.entries()]) {
      if (at - entry.lastAt < alarmDedupeMs) continue
      // 不先删 pending：交给 pushAlarm 删并计 redelivered（否则补投计数会丢）。
      const event = pushAlarm(entry.type, { ...entry.data, redeliveryOf: key }, { retry: true })
      if (event) retried += 1
    }
    return retried
  }

  function taskView(task) {
    if (!task) return null
    return {
      id: task.id, kind: task.kind, params: task.params, state: task.state,
      idempotencyKey: task.idempotencyKey ?? null,
      progress: task.progress ?? null,
      createdAt: task.createdAt, startedAt: task.startedAt ?? null, finishedAt: task.finishedAt ?? null,
      deadlineAt: task.deadlineAt ?? null, deadlineMs: task.deadlineMs ?? null,
      pausedReason: task.pausedReason ?? null, pausedAt: task.pausedAt ?? null,
      outcomeUnknown: task.outcomeUnknown === true,
      result: task.result ?? null, error: task.error ?? null,
    }
  }

  function setTask(task, state, extra = {}) {
    task.state = state
    Object.assign(task, extra)
    if (TERMINAL.has(state)) {
      task.finishedAt = stamp()
      push(`task_${state}`, { task: taskView(task) })
    } else if (state === 'paused') {
      task.pausedAt = task.pausedAt ?? stamp()
      push('task_paused', { task: taskView(task), reason: task.pausedReason ?? 'paused' })
    }
    saveLedger()
  }

  function armDeadline(task, ms) {
    if (task.timer) clearTimeout(task.timer)
    const delay = Math.max(1000, Number(ms) || 600_000)
    task.deadlineMs = delay
    task.deadlineAt = stamp() + delay
    task.timer = setTimeout(() => {
      task.timedOut = true
      // 超时 = 结果未知：动作可能已经生效，不能当失败也不能当成功。
      task.controller?.abort(abortError('timeout'))
    }, delay)
    if (typeof task.timer.unref === 'function') task.timer.unref()
  }

  function clearTaskTimers(task) {
    if (task?.timer) { clearTimeout(task.timer); task.timer = null }
  }

  async function pump() {
    if (pumping || returning || closed || current) return
    if (paused || connectionState === false) return
    const next = queue.shift()
    if (!next) return
    pumping = true
    current = next
    next.state = 'running'
    next.startedAt = stamp()
    next.pausedByDisconnect = false
    const controller = new AbortController()
    next.controller = controller
    armDeadline(next, next.remainingMs ?? next.deadlineMs)
    next.remainingMs = null
    movementTaskId = next.id
    movement.reset()
    push('task_started', { task: taskView(next) })
    try {
      const result = await adapter.runTask(next, {
        signal: controller.signal,
        progress: (progress) => {
          next.progress = progress
          push('task_progress', { taskId: next.id, progress })
        },
      })
      // 断线/取消已经同步改写过状态：这里只清现场，不回写结果。
      if (TERMINAL.has(next.state) || (next.state === 'paused' && next.pausedByDisconnect)) {
        // nothing
      // adapter 可能无视 abort 直接返回：先按中断/超时/断线归类，再谈成功。
      } else if (next.cancelReason) setTask(next, 'cancelled', { error: next.cancelReason })
      else if (next.interruptReason) setTask(next, 'interrupted', { error: next.interruptReason })
      else if (next.pausedByDisconnect) setTask(next, 'paused', { pausedReason: 'disconnect' })
      else if (next.timedOut) setTask(next, 'unknown', { error: 'timeout', outcomeUnknown: true })
      else setTask(next, 'done', { result: result ?? null })
    } catch (error) {
      if (TERMINAL.has(next.state) || (next.state === 'paused' && next.pausedByDisconnect)) {
        push('task_settle_ignored', { taskId: next.id, message: String(error?.message ?? error) })
      } else if (next.cancelReason) setTask(next, 'cancelled', { error: next.cancelReason })
      else if (next.interruptReason) setTask(next, 'interrupted', { error: next.interruptReason })
      else if (next.pausedByDisconnect) setTask(next, 'paused', { pausedReason: 'disconnect' })
      else if (next.timedOut) setTask(next, 'unknown', { error: 'timeout', outcomeUnknown: true })
      else if (error?.name === 'AbortError') setTask(next, 'cancelled', { error: 'aborted' })
      else setTask(next, 'failed', { error: String(error?.message ?? error), result: error?.result ?? null })
    } finally {
      clearTaskTimers(next)
      if (next.abandonTimer) { clearTimeout(next.abandonTimer); next.abandonTimer = null }
      next.controller = null
      // 只在仍是当前任务时清现场：被断线兜底摘掉后，新任务可能已经接管。
      if (current === next) {
        current = null
        pumping = false
      }
      if (movementTaskId === next.id) { movementTaskId = null; movement.reset() }
      if (!paused && connectionState !== false && queue.length === 0 && !returning && !closed && typeof adapter.returnToSafe === 'function') {
        returning = true
        Promise.resolve(adapter.returnToSafe())
          .catch(() => {})
          .finally(() => { returning = false; void pump() })
      }
      void pump()
    }
  }

  function createTask({ idempotencyKey = null, kind, params = {}, deadlineMs = null } = {}) {
    if (!allowTask) throw httpError('body 未允许任务', 403)
    if (!KINDS.has(String(kind))) throw httpError(`未知任务：${kind}`, 400)
    if (idempotencyKey != null) {
      const existing = idempotency.get(String(idempotencyKey))
      if (existing) {
        push('task_idempotent_hit', { idempotencyKey: String(idempotencyKey), taskId: existing })
        return taskView(tasks.get(existing))
      }
    }
    if (paused) throw httpError(`身体已暂停（${pausedReason ?? 'safety'}）；先 resume 或 /v1/safety/resume，安全后再下任务`, 409)
    if (connectionState === false) throw httpError('身体未连接（offline）；等重连或显式 resume 后再下任务', 409)
    if (queue.length >= maxQueue) throw httpError(`任务队列已满（${maxQueue}）`, 429)
    const durationMs = kind === 'routine' ? Math.max(10_000, Number(params.durationMs) || 0) : 0
    const effectiveDeadline = Math.max(1000, Number(deadlineMs) || (durationMs ? durationMs + 30_000 : 600_000))
    taskSeq += 1
    const task = {
      id: `t-${taskSeq}`,
      idempotencyKey: idempotencyKey == null ? null : String(idempotencyKey),
      kind: String(kind),
      params: { ...params },
      state: 'queued',
      progress: null,
      createdAt: stamp(),
      startedAt: null,
      finishedAt: null,
      deadlineAt: stamp() + effectiveDeadline,
      deadlineMs: effectiveDeadline,
      remainingMs: null,
      result: null,
      error: null,
      outcomeUnknown: false,
      pausedReason: null,
      pausedAt: null,
      cancelReason: null,
      interruptReason: null,
      timedOut: false,
      pausedByDisconnect: false,
      controller: null,
      timer: null,
    }
    tasks.set(task.id, task)
    if (idempotencyKey != null) idempotency.set(String(idempotencyKey), task.id)
    queue.push(task)
    push('task_queued', { task: taskView(task) })
    saveLedger()
    queueMicrotask(() => { void pump() })
    return taskView(task)
  }

  function getTask(id) { return taskView(tasks.get(String(id))) }
  function listTasks(state = null) {
    return [...tasks.values()].filter((t) => !state || t.state === state).map(taskView)
  }

  function cancelTask(id, reason = 'cancelled') {
    const task = tasks.get(String(id))
    if (!task || TERMINAL.has(task.state)) return taskView(task)
    task.cancelReason = String(reason)
    if (task.state === 'queued' || task.state === 'paused') {
      const index = queue.indexOf(task)
      if (index >= 0) queue.splice(index, 1)
      clearTaskTimers(task)
      setTask(task, 'cancelled', { error: task.cancelReason })
    } else {
      task.controller?.abort(abortError('cancelled'))
    }
    return taskView(task)
  }

  // 把当前 running 任务挂起（断线用）：保留进度/剩余 deadline，等显式 resumeTask。
  // 立刻置 paused（不能等 adapter 从 bot.dig 等挂起调用里退出来——断线时它可能永远不退）。
  function pauseCurrentTask(reason) {
    const task = current
    if (!task || TERMINAL.has(task.state) || task.state === 'paused') return null
    task.pausedByDisconnect = true
    task.remainingMs = Math.max(1000, (Number(task.deadlineAt) || stamp()) - stamp())
    clearTaskTimers(task)
    setTask(task, 'paused', { pausedReason: 'disconnect' })
    task.controller?.abort(abortError(reason))
    // 兜底：adapter 无视 abort 吊死时，把 current 摘掉，别让身体永远发不出下一条任务。
    if (task.abandonTimer) clearTimeout(task.abandonTimer)
    task.abandonTimer = setTimeout(() => {
      if (current !== task || task.state !== 'paused') return
      current = null
      pumping = false
      push('task_detached', { taskId: task.id, reason: 'adapter-did-not-unwind' })
      void pump()
    }, 8000)
    if (typeof task.abandonTimer.unref === 'function') task.abandonTimer.unref()
    return task
  }

  function resumeTask(id) {
    const task = tasks.get(String(id))
    if (!task) throw httpError('没有这个任务', 404)
    if (task.state === 'running' || task.state === 'queued') return taskView(task)
    if (TERMINAL.has(task.state)) throw httpError(`任务已结束（${task.state}），不能 resume；需要就重新下任务`, 409)
    if (task.state !== 'paused') throw httpError(`任务当前是 ${task.state}，不能 resume`, 409)
    if (paused) throw httpError(`身体仍暂停（${pausedReason ?? 'safety'}）；先 /v1/safety/resume`, 409)
    if (connectionState !== true) throw httpError('身体未连接（offline）；先等重连', 409)
    task.state = 'queued'
    task.pausedReason = null
    task.pausedAt = null
    task.pausedByDisconnect = false
    task.startedAt = null
    queue.push(task)
    push('task_resumed', { task: taskView(task) })
    saveLedger()
    queueMicrotask(() => { void pump() })
    return taskView(task)
  }

  function safetyStop(reason = 'safety') {
    const next = String(reason)
    lastSafetyStopAt = stamp()
    if (paused) {
      // 已经停了就别每 500ms 再发一条 safety_stop；但更严重的事件必须穿透报警。
      if (next === 'death' || next === 'quarantine') {
        if (next === 'death' && pausedReason !== 'death' && pausedReason !== 'quarantine') {
          pausedReason = next
          pushAlarm('safety_stop', { reason: pausedReason })
        } else if (next === 'quarantine' && pausedReason !== 'quarantine') {
          pausedReason = next
          pushAlarm('safety_stop', { reason: pausedReason })
        } else {
          // 同一原因重复：不改变状态，但保证 alarm 可见（去重后仍会记账/补投）。
          pushAlarm('safety_stop', { reason: next, repeated: true })
        }
      } else if (ALARM_WHILE_PAUSED.has(next)) {
        // 暂停中又发生危险（spawn_unsafe/danger-block/low-oxygen…）：状态不变，alarm 必须到。
        pushAlarm('safety_stop', { reason: pausedReason, event: next, repeated: next === pausedReason })
      }
      return { paused, reason: pausedReason, bodyOnline: connectionState !== false, reflex: reflexView() }
    }
    paused = true
    pausedReason = next
    pushAlarm('safety_stop', { reason: pausedReason })
    // 已排队但没跑的任务也不该在恢复后自动冲向同一个危险点。
    for (const task of queue.splice(0)) {
      if (!TERMINAL.has(task.state)) {
        clearTaskTimers(task)
        setTask(task, 'interrupted', { error: pausedReason })
      }
    }
    if (current) {
      current.interruptReason = pausedReason
      clearTaskTimers(current)
      current.controller?.abort(abortError(pausedReason))
    }
    // 身体先做一个有界保命动作（吃/后退/回安全点），再等上层。
    try { void Promise.resolve(adapter.emergency?.(pausedReason)).catch(() => {}) } catch { /* ignore */ }
    if (Number(pausedDisconnectMs) > 0) {
      if (pausedTimer) clearTimeout(pausedTimer)
      pausedTimer = setTimeout(() => {
        if (!paused || closed) return
        push('idle_disconnect', { reason: pausedReason, afterMs: pausedDisconnectMs })
        try { void Promise.resolve(adapter.disconnect?.()).catch(() => {}) } catch { /* ignore */ }
        try { onIdleDisconnect?.({ reason: pausedReason, afterMs: Number(pausedDisconnectMs) }) } catch { /* 宿主钩子失败不影响身体 */ }
      }, Number(pausedDisconnectMs))
      if (typeof pausedTimer.unref === 'function') pausedTimer.unref()
    }
    return { paused, reason: pausedReason, bodyOnline: connectionState !== false, reflex: reflexView() }
  }

  // mcb_stop：cancel + 反射 + 报告（不需要先 resume）；任务与身体状态分开说清。
  function stopAll(reason = 'user-stop') {
    // pausedReason 用规范值 `user-stop`（与 time pausedMode 对账）；调用方原始原因放 requestedReason。
    const requestedReason = String(reason || 'user-stop')
    const stopReason = ['mcb_stop', 'manual', 'api', 'stop'].includes(requestedReason) ? 'user-stop' : requestedReason
    const cancelled = []
    for (const task of queue.splice(0)) {
      if (TERMINAL.has(task.state)) continue
      clearTaskTimers(task)
      task.cancelReason = stopReason
      setTask(task, 'cancelled', { error: stopReason })
      cancelled.push({ id: task.id, kind: task.kind, state: 'cancelled' })
    }
    if (current && !TERMINAL.has(current.state)) {
      cancelled.push({ id: current.id, kind: current.kind, state: 'cancelling' })
      current.cancelReason = stopReason
      current.controller?.abort(abortError(stopReason))
    }
    // stop 是一种暂停：停任务/停控制，但安全反射继续（方案 B）。
    if (!paused) safetyStop(stopReason)
    else if (pausedReason !== stopReason) {
      pausedReason = stopReason
      pushAlarm('safety_stop', { reason: pausedReason, via: 'mcb_stop', requestedReason })
    }
    const adapterState = adapterStatus()
    const connected = adapterState.connected === undefined ? connectionState !== false : Boolean(adapterState.connected)
    const bodyOnline = connected === true
    return {
      ok: true,
      paused: true,
      pausedReason,
      requestedReason,
      task: {
        cancelled,
        note: cancelled.length ? `任务已停（取消 ${cancelled.length} 个）` : '任务已停（没有在跑/排队的任务）',
      },
      body: {
        online: bodyOnline,
        position: adapterState.position ?? null,
        health: adapterState.health ?? null,
        food: adapterState.food ?? null,
        note: bodyOnline
          ? '身体仍在世界（会掉落/受伤/被推）；安全反射保持开启，可 cancel/tasks/look 等安全 op，resume 后再下任务'
          : '身体不在世界（离线/已退出）；恢复需先让 body 上线',
      },
      reflex: reflexView(),
      safety: { reason: pausedReason, requestedReason, alarm: true, priority: 'alarm', pierce: true },
    }
  }

  function resume({ force = false } = {}) {
    if (connectionState === false) throw httpError('身体未连接（offline）；等重连后才能 resume', 409)
    const previousReason = pausedReason
    const wasPaused = paused
    paused = false
    pausedReason = null
    if (pausedTimer) { clearTimeout(pausedTimer); pausedTimer = null }
    push('safety_resume', { wasPaused, previousReason, forced: Boolean(force), queued: queue.length })
    void pump()
    return { paused, wasPaused, previousReason }
  }

  // ---- 连接状态（单一事实源，状态栏据此显示在线/离线） -------------------------
  function handleOffline(data = {}) {
    const reason = String(data.reason ?? data.message ?? 'disconnect')
    const firstNotice = !offlineEpisode
    connectionState = false
    offlineEpisode = true
    offlineReason = reason
    if (firstNotice) push('offline', { reason, willReconnect: data.willReconnect ?? null, at: stamp() })
    const keepReason = pausedReason === 'death' || pausedReason === 'quarantine'
    const wasRunning = current && current.state === 'running'
    if (!paused) {
      paused = true
      pausedReason = keepReason ? pausedReason : 'disconnect'
    }
    if (pausedTimer) { clearTimeout(pausedTimer); pausedTimer = null } // 已经离线，不需要再“暂停超时下线”
    if (wasRunning) pauseCurrentTask('disconnect')
    if (!keepReason) push('resume_required', { reason: 'disconnect', detail: offlineReason, hint: '重连后身体仍暂停；显式 resume 后才接任务；断线时在跑的任务状态是 paused（结果未定）' })
    return { online: false, paused, pausedReason }
  }

  function handleReconnected(data = {}) {
    const wasOffline = offlineEpisode || connectionState === false
    connectionState = true
    everOnline = true
    offlineEpisode = false
    offlineReason = null
    if (!wasOffline) return null
    const event = push('reconnected', { ...data, at: stamp() })
    if (paused) {
      push('resume_required', { reason: 'reconnect', detail: 'reconnected', hint: '已重连但身体仍暂停；显式 resume 复核后再继续' })
    }
    return event
  }

  function handleReconnectExhausted(data = {}) {
    connectionState = false
    offlineEpisode = true
    offlineReason = 'reconnect-exhausted'
    const event = push('reconnect_exhausted', { ...data, at: stamp() })
    push('offline', { reason: 'reconnect-exhausted', willReconnect: false, at: stamp() })
    const keepReason = pausedReason === 'death' || pausedReason === 'quarantine'
    if (!paused) { paused = true; pausedReason = keepReason ? pausedReason : 'reconnect-exhausted' }
    // 已经不自动重连是比“断线”更坏的状态：暂停原因要升级，别让状态栏一直说普通断线。
    else if (!keepReason && pausedReason !== 'reconnect-exhausted') pausedReason = 'reconnect-exhausted'
    if (current && current.state === 'running') pauseCurrentTask('disconnect')
    return event
  }

  // ---- 看门狗 -----------------------------------------------------------------
  function adapterStatus() {
    try {
      const value = adapter.status?.()
      return value && typeof value === 'object' ? value : {}
    } catch (error) {
      push('body_error', { message: `status: ${error?.message ?? error}` })
      return { connected: false, statusError: String(error?.message ?? error) }
    }
  }

  function alertWatchdog(severity, kind, data = {}, action = null) {
    const at = stamp()
    watchdogStats.alerts += 1
    watchdogStats.lastAlertAt = at
    const payload = { severity, kind, at, ...data }
    if (severity === 'danger') {
      // 危险告警必须穿透：不走配额（只做 15s 去重），被去重也记账并在窗口后补投。
      pushAlarm('watchdog', { ...payload, reason: kind })
    } else {
      const admitted = rate.admit(severity, kind)
      if (admitted) {
        push('watchdog', payload)
      } else {
        // 限流只压“重复提醒”的注入，绝不压安全动作；同时不能静默：每次窗口报一次抑制统计。
        const last = suppressedNotified[kind] ?? 0
        if (at - last >= alertWindowMs) {
          suppressedNotified[kind] = at
          push('watchdog_suppressed', { kind, suppressed: rate.stats().suppressed, windowMs: alertWindowMs })
        }
      }
    }
    if (action) {
      // 安全动作不受 pause/限流影响：暂停时 reflex 也会独立跑（见 checkReflex）。
      try { action(payload) } catch (error) { push('body_error', { message: `watchdog-action: ${error?.message ?? error}` }) }
    }
    return payload
  }

  function checkHealth(health, food) {
    const value = Number(health)
    if (!Number.isFinite(value)) return
    const previous = lastHealth
    lastHealth = value
    if (value <= lowHealth) {
      alertWatchdog('danger', 'low-health', { health: value, food: food ?? null }, () => safetyStop('low-health'))
      return
    }
    if (previous != null && value < previous) {
      const drop = previous - value
      // 掉血分级：1–5 点（摔一下/挖树/走路蹭伤）是正常玩法，只记录不暂停；
      // 单次 >=6 或已到低血线才接管。避免“挖树落地掉 4 血 → 身体暂停 → 整条合成链 409”。
      if (!paused) push('health_drop', { from: previous, to: value, drop })
      else watchdogStats.healthDropSuppressed = (watchdogStats.healthDropSuppressed ?? 0) + 1
      if (drop >= 6) {
        alertWatchdog('danger', 'health-drop', { from: previous, to: value, drop }, () => safetyStop('health-drop'))
      } else {
        alertWatchdog('idle', 'health-drop-minor', { from: previous, to: value, drop })
      }
    }
  }

  function checkOxygen(status) {
    const oxygen = Number(status.oxygen)
    if (!Number.isFinite(oxygen)) return
    // 只有真的在水下才把氧值当危险：陆地/未初始化时 mineflayer 也可能给 0，不能因此误停。
    const underwater = status.submerged === true
    if (underwater && oxygen <= 5) {
      alertWatchdog('danger', 'low-oxygen', { oxygen, submerged: underwater }, () => safetyStop('low-oxygen'))
    }
  }

  function checkDangerBlocks(status) {
    const blocks = Array.isArray(status?.danger?.blocks) ? status.danger.blocks : []
    if (!blocks.length) return
    alertWatchdog('danger', 'danger-block', { blocks: blocks.slice(0, 6) }, () => safetyStop('danger-block'))
  }

  function checkConnectionStale(status) {
    const silent = Number(status.packetSilentMs)
    if (!Number.isFinite(silent) || silent <= packetStaleMs) return
    alertWatchdog('danger', 'connection-stale', { packetSilentMs: Math.round(silent), thresholdMs: packetStaleMs }, () => safetyStop('connection-stale'))
  }

  function targetOf(task) {
    const params = task?.params ?? {}
    if ([params.x, params.y, params.z].every((n) => Number.isFinite(Number(n)))) {
      return { x: Number(params.x), y: Number(params.y), z: Number(params.z) }
    }
    const progressTarget = task?.progress?.target
    if (progressTarget && [progressTarget.x, progressTarget.y, progressTarget.z].every((n) => Number.isFinite(Number(n)))) {
      return progressTarget
    }
    return null
  }

  function checkMovementStall(status, at) {
    const task = current
    if (!task || task.state !== 'running' || !MOVEMENT_KINDS.has(task.kind)) { movement.reset(); return }
    if (movementTaskId !== task.id) { movement.reset(); movementTaskId = task.id }
    const target = targetOf(task)
    if (!target || !status.position) { movement.reset(); return }
    const distance = posDistance(status.position, target)
    if (!Number.isFinite(distance)) { movement.reset(); return }
    const result = movement.update(distance, at)
    if (!result.stalled) return
    alertWatchdog('danger', 'stuck', {
      taskId: task.id,
      distance: round1(result.distance),
      best: round1(result.best),
      sinceBestMs: result.sinceBestMs,
    }, () => safetyStop('stuck'))
    movement.reset()
  }

  function reflexView() {
    return {
      enabled: Boolean(reflexEnabled),
      active: reflexState.active,
      count: reflexState.count,
      times: reflexState.times.length,
      maxPerMinute: reflexMaxPerMinute,
      maxDurationMs: reflexMaxDurationMs,
      lastAt: reflexState.lastAt,
      lastReason: reflexState.lastReason,
      lastAction: reflexState.lastAction,
      lastDurationMs: reflexState.lastDurationMs,
      lastTimedOut: reflexState.lastTimedOut,
      lastEventSeq: reflexState.lastEventSeq,
      suppressedCount: reflexState.suppressedCount ?? 0,
    }
  }

  // 暂停中判断“现在是否危险到需要反射”：低血/危险方块/近身怪/水下低氧。
  function reflexDanger(status) {
    const health = Number(status?.health)
    if (Number.isFinite(health) && health > 0 && health <= lowHealth) return { reason: 'low-health', health }
    const blocks = Array.isArray(status?.danger?.blocks) ? status.danger.blocks : []
    if (blocks.length) return { reason: 'danger-block', blocks: blocks.slice(0, 3) }
    const hostiles = Array.isArray(status?.nearbyHostiles) ? status.nearbyHostiles : []
    const threat = hostiles.find((entry) => Number(entry?.distance) <= 6)
    if (threat) return { reason: 'threat-near', threat: threat.name ?? 'hostile', distance: threat.distance }
    if (status?.submerged === true && Number(status?.oxygen) <= 5) return { reason: 'low-oxygen', oxygen: Number(status.oxygen) }
    return null
  }

  // 方案 B：暂停只停任务/控制，不停安全反射；有界（≤10s/次、≤2 次/分），不生成新目标。
  function checkReflex(status, at) {
    if (!reflexEnabled || !paused || closed) return null
    if (connectionState === false) return null
    if (reflexState.active) return null
    const danger = reflexDanger(status)
    if (!danger) return null
    reflexState.times = reflexState.times.filter((time) => at - time < 60_000)
    if (reflexState.times.length >= reflexMaxPerMinute) {
      if (!reflexState.lastSuppressedAt || at - reflexState.lastSuppressedAt >= alertWindowMs) {
        reflexState.lastSuppressedAt = at
        reflexState.suppressedCount = (reflexState.suppressedCount ?? 0) + 1
        push('reflex_suppressed', { reason: danger.reason, count: reflexState.times.length, windowMs: 60_000, maxPerMinute: reflexMaxPerMinute })
      }
      return null
    }
    reflexState.times.push(at)
    reflexState.count = reflexState.times.length
    reflexState.active = true
    reflexState.lastAt = at
    reflexState.lastReason = danger.reason
    const started = stamp()
    const emergencyFn = typeof adapter.emergency === 'function' ? adapter.emergency : null
    if (!emergencyFn) { reflexState.active = false; return null }
    let timer = null
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), Math.max(500, Number(reflexMaxDurationMs) || REFLEX_MAX_DURATION_MS))
      if (typeof timer.unref === 'function') timer.unref()
    })
    Promise.race([
      Promise.resolve().then(() => emergencyFn(danger.reason)).catch((error) => ({ error: String(error?.message ?? error) })),
      timeout,
    ]).then((result) => {
      if (timer) clearTimeout(timer)
      const durationMs = stamp() - started
      reflexState.active = false
      reflexState.lastDurationMs = durationMs
      reflexState.lastTimedOut = result?.timedOut === true
      reflexState.lastAction = result?.action ?? (result?.error ? 'error' : (result?.ok === false ? 'offline' : 'no-op'))
      const event = push('reflex', {
        reason: danger.reason,
        danger,
        action: reflexState.lastAction,
        durationMs,
        timedOut: reflexState.lastTimedOut,
        windowCount: reflexState.times.length,
        error: result?.error ?? null,
      })
      reflexState.lastEventSeq = event.seq
    }).catch(() => { reflexState.active = false })
    return danger
  }

  function watchdogTick(at = stamp()) {
    if (closed) return { ticks: watchdogStats.ticks }
    watchdogStats.ticks += 1
    watchdogStats.lastTickAt = at
    const status = adapterStatus()
    const connected = status.connected === undefined ? null : Boolean(status.connected)
    if (connected === false && connectionState !== false) {
      handleOffline({ reason: status.lastError ?? status.statusError ?? 'not-connected', willReconnect: Boolean(status.reconnecting) })
    } else if (connected === true && connectionState === false) {
      handleReconnected({ source: 'watchdog' })
    }
    checkHealth(status.health, status.food)
    checkOxygen(status)
    checkDangerBlocks(status)
    checkConnectionStale(status)
    checkMovementStall(status, at)
    // 暂停期的安全反射（方案 B）与 alarm 补投：pause 不冻结保命动作，也不静默危险。
    checkReflex(status, at)
    retryPendingAlarms(at)
    if (heartbeat.due(at)) {
      const payload = {
        at,
        silentMs: Math.max(0, at - lastPulseAt),
        online: connectionState,
        paused,
        pausedReason,
        health: Number.isFinite(Number(status.health)) ? Number(status.health) : null,
        position: status.position ?? null,
        taskId: current?.id ?? null,
      }
      if (rate.admit('idle', 'heartbeat')) push('heartbeat', payload)
      else {
        const last = suppressedNotified.heartbeat ?? 0
        if (at - last >= alertWindowMs) {
          suppressedNotified.heartbeat = at
          push('watchdog_suppressed', { kind: 'heartbeat', suppressed: rate.stats().suppressed, windowMs: alertWindowMs })
        }
      }
    }
    return watchdogSummary()
  }

  function watchdogSummary() {
    const rateStats = rate.stats()
    return {
      ticks: watchdogStats.ticks,
      alerts: watchdogStats.alerts,
      lastAlertAt: watchdogStats.lastAlertAt,
      lastTickAt: watchdogStats.lastTickAt,
      lastEventAt: lastPulseAt,
      heartbeat: heartbeat.stats(),
      limits: rateStats.limits,
      quotaUsed: rateStats.used,
      fired: rateStats.fired,
      suppressed: rateStats.suppressed,
      suppressedBy: rateStats.suppressedBy,
      healthDropSuppressed: watchdogStats.healthDropSuppressed ?? 0,
    }
  }

  function onDeath(data = {}) {
    const at = stamp()
    deaths.push(at)
    while (deaths.length && at - deaths[0] > 120_000) deaths.shift()
    safetyStop('death')
    if (deaths.length >= 3) {
      safetyStop('quarantine')
      push('quarantine', { deaths: deaths.length, windowMs: 120_000, position: data.position ?? null })
      try { void Promise.resolve(adapter.disconnect?.()).catch(() => {}) } catch { /* ignore */ }
    }
  }

  function ingest(type, data = {}) {
    const kind = String(type ?? '')
    if (!kind) return null
    if (kind === 'disconnected' || kind === 'offline') return handleOffline(data)
    if (kind === 'reconnected' || kind === 'reconnect' || kind === 'spawn' && connectionState === false) {
      return handleReconnected({ ...data, source: kind })
    }
    if (kind === 'reconnect_exhausted') return handleReconnectExhausted(data)
    const event = push(kind, data)
    if (kind === 'spawn') {
      // E7：spawn 日志（位置/维度/来源），排查“出生点在哪、是否安全、重连了几次”。
      spawnLog.push({
        at: stamp(),
        position: data.position ?? null,
        dimension: data.dimension ?? null,
        source: data.source ?? null,
        safe: data.safe ?? null,
      })
      while (spawnLog.length > 20) spawnLog.shift()
      // 首次连接/重连后的第一次 spawn：状态栏不许假在线，也不许假离线。
      if (connectionState === false) handleReconnected({ source: 'spawn' })
      else { connectionState = true; everOnline = true; offlineEpisode = false; offlineReason = null }
    } else if (kind === 'spawn_safe' || kind === 'spawn_unsafe') {
      const last = spawnLog.at(-1)
      if (last) {
        last.safe = kind === 'spawn_safe'
        last.safety = { position: data.position ?? last.position, feet: data.feet ?? null, head: data.head ?? null, below: data.below ?? null, threats: Array.isArray(data.threats) ? data.threats.slice(0, 4) : null, dangerBlocks: Array.isArray(data.dangerBlocks) ? data.dangerBlocks.slice(0, 4) : null }
      }
      if (kind === 'spawn_unsafe') safetyStop('spawn-unsafe')
    } else if (kind === 'health') {
      checkHealth(data.health, data.food)
    } else if (kind === 'death') {
      onDeath(data)
    } else if (kind === 'stuck') {
      safetyStop('stuck')
    } else if (kind === 'spawn_unsafe') {
      safetyStop('spawn-unsafe')
    } else if (kind === 'danger_block') {
      safetyStop('danger-block')
    } else if (kind === 'low_oxygen') {
      safetyStop('low-oxygen')
    } else if (kind === 'kicked') {
      handleOffline({ reason: `kicked: ${String(data.reason ?? '').slice(0, 200)}`, willReconnect: null })
    }
    return event
  }

  async function inspect(kind, params = {}) {
    if (typeof adapter.inspect !== 'function') throw httpError('body 不支持 inspect', 501)
    const allowed = new Set(['look', 'inventory', 'scan', 'map'])
    if (!allowed.has(String(kind))) throw httpError(`未知 inspect：${kind}`, 400)
    return adapter.inspect(String(kind), params)
  }

  // P0：结构化场景快照（零依赖、毫秒级；日常先看它，不要一上来截图）。
  async function eyesSnapshot(params = {}) {
    const started = stamp()
    const radius = Math.max(3, Math.min(16, Number(params.radius) || 8))
    let adapterSnapshot = null
    if (typeof adapter.snapshot === 'function' && connectionState !== false) {
      try { adapterSnapshot = await adapter.snapshot({ radius }) } catch { /* 降级到 status/inspect */ }
    }
    let mapInspect = null
    if (typeof adapter.inspect === 'function') {
      try { mapInspect = await adapter.inspect('map', { radius }) } catch { /* ignore */ }
    }
    const snapshot = buildStructuredSnapshot({
      status: status(),
      adapterSnapshot,
      inspect: { map: mapInspect },
      task: taskView(current),
      events: events.slice(-10),
      radius,
    })
    return { ok: true, snapshot, captureMs: stamp() - started }
  }

  // P1：按需截图（adapter 起 viewer → Edge headless CDP 截图 → 关 viewer / kill Edge 进程树）。
  async function eyesScreenshot(params = {}) {
    if (typeof adapter.startScreenshotViewer !== 'function') {
      throw httpError('body 未配置截图能力（需要 adapter viewer + Edge；见 docs/MC-EYES.md）', 501)
    }
    if (eyesBusy) throw httpError('已有截图在进行，稍后再试', 429)
    const minGap = Math.max(0, Number(eyesMinIntervalMs) || 0)
    if (lastEyesAt && stamp() - lastEyesAt < minGap) {
      throw httpError(`截图限频：距上次 ${Math.round((stamp() - lastEyesAt) / 1000)}s；至少 ${Math.round(minGap / 1000)}s 一次（成本高，仅里程碑/告警/明确要求时用）`, 429)
    }
    const width = Math.max(640, Math.min(1600, Number(params.width) || 1280))
    const height = Math.max(360, Math.min(900, Number(params.height) || 720))
    const waitMs = Math.max(3000, Math.min(10_000, Number(params.waitMs) || 7000))
    const frames = Math.max(1, Math.min(8, Number(params.frames) || 1))
    const intervalMs = Math.max(1000, Math.min(5000, Number(params.intervalMs) || 1000))
    const kind = String(params.kind ?? 'manual').replace(/[^\w.-]/g, '_').slice(0, 40) || 'manual'
    eyesBusy = true
    try {
      const viewer = await adapter.startScreenshotViewer({ portStart: Number(params.portStart) || eyesPortStart })
      const root = path.resolve(String(mediaDir || path.join(process.cwd(), 'media', 'mc-eyes')))
      const run = String(runId || process.env.MC_RUN_ID || 'body').replace(/[^\w.-]/g, '_')
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      const outBase = path.join(root, run, `${ts}-${kind}`)
      const captured = await captureScreenshot({
        url: `http://127.0.0.1:${viewer.port}/`, outBase, width, height, waitMs, frames, intervalMs,
        debugPort: Number(params.debugPort) || 9333,
        profileDir: path.join(root, '.edge-profile'),
      })
      const meta = {
        version: 1,
        kind: 'screenshot',
        ts: new Date().toISOString(),
        runId: run,
        requestedKind: kind,
        viewer: { port: viewer.port, version: viewer.version, center: viewer.center },
        viewport: { width, height },
        waitMs,
        frames,
        intervalMs,
        captureMs: captured.elapsedMs,
        sanity: captured.sanity,
        files: captured.files,
        position: viewer.center,
        task: taskView(current),
        safety: { paused, pausedReason, reflex: reflexView() },
        note: '按需截图：Edge headless 软件渲染（无 GPU 模型锁）；截完 kill Edge 进程树、关闭 viewer。',
      }
      fs.writeFileSync(`${outBase}.json`, JSON.stringify(meta, null, 2), 'utf8')
      return { ok: true, outBase, files: captured.files, meta, captureMs: captured.elapsedMs }
    } catch (error) {
      throw httpError(`截图失败：${String(error?.message ?? error)}`, 500)
    } finally {
      lastEyesAt = stamp()
      eyesBusy = false
      try { await adapter.stopScreenshotViewer?.() } catch { /* ignore */ }
    }
  }

  async function doPlan(steps, params = {}) {
    if (!Array.isArray(steps) || !steps.length) throw httpError('do 需要非空 steps', 400)
    // 单飞锁：长 op（mine/goto/dig/place/chest/...）执行期间不接第二个长 plan。
    // 背景：mc-link 120s 超时后仍会再发，旧 body 无互斥 → 两个长 op 并发争 pathfinder/dig。
    const NONBLOCKING = new Set(['task', 'cancel', 'stop', 'resume', 'events', 'tasks', 'say', 'look', 'inventory', 'scan', 'map'])
    const heavy = steps.some((step) => !NONBLOCKING.has(String(step?.op ?? '')))
    if (heavy && activeDo) {
      throw httpError(`上一个 do 动作还在执行（${activeDo.ops.join('/')}，已 ${Math.round((stamp() - activeDo.at) / 1000)}s）；先 mcb_status / tasks 查状态，长任务请用 {"op":"task"} 提交；不要并发发长动作`, 409)
    }
    if (heavy) activeDo = { at: stamp(), ops: steps.map((step) => String(step?.op ?? '?')) }
    try {
      const results = []
      for (const [index, step] of steps.entries()) {
        const op = String(step?.op ?? '')
        if (!op) throw httpError(`第 ${index + 1} 步缺少 op`, 400)
        if (paused && !SAFE_WHILE_PAUSED.has(op)) {
          throw httpError(`身体已暂停（${pausedReason ?? 'safety'}）；先 /v1/safety/resume，或只用 ${[...SAFE_WHILE_PAUSED].join('/')}`, 409)
        }
        if (op === 'task') {
          const taskParams = step.params?.params ?? step.params ?? {}
          const kind = step.kind ?? step.params?.kind
          if (!kind) throw httpError('task op 需要 kind（如 kind:"mine"）', 400)
          const task = createTask({ ...step, kind, params: taskParams })
          return { ok: true, results, task }
        }
        if (op === 'stop') {
          // mcb_stop 的 body 行为：cancel+反射+报告；暂停中也可直接调用，不需要先 resume。
          results.push({ index, op, result: stopAll(step.reason ?? step.params?.reason ?? 'user-stop') })
          continue
        }
        if (op === 'cancel') { results.push({ index, op, result: cancelTask(step.taskId, step.reason) }); continue }
        if (op === 'resume') {
          const result = step.taskId ? resumeTask(step.taskId) : resume({ force: Boolean(step.force) })
          results.push({ index, op, result })
          continue
        }
        if (op === 'events') { results.push({ index, op, result: eventsSince(step.since ?? 0) }); continue }
        if (op === 'tasks') { results.push({ index, op, result: listTasks(step.state ?? null) }); continue }
        if (op === 'say') { results.push({ index, op, result: await chat(step.text) }); continue }
        if (['look', 'inventory', 'scan', 'map'].includes(op)) {
          results.push({ index, op, result: await inspect(op, step.params ?? step) })
          continue
        }
        if (typeof adapter.runOp !== 'function') throw httpError('body adapter 不支持组合 op', 501)
        results.push({ index, op, result: await adapter.runOp(op, step.params ?? step) })
      }
      return { ok: true, results }
    } finally {
      if (heavy) activeDo = null
    }
  }

  async function chat(text) {
    if (!allowSay) throw httpError('body 未允许发言', 403)
    const clean = String(text ?? '').replace(/[\r\n]+/g, ' ').trim()
    if (!clean) throw httpError('text 必填', 400)
    if (clean.startsWith('/')) throw httpError('不允许执行命令', 400)
    if (clean.length > 200) throw httpError('text 太长（<=200）', 400)
    if (connectionState === false) throw httpError('身体未连接（offline）', 409)
    const at = stamp()
    if (at - lastChatAt < Number(chatRateMs)) throw httpError('发言太快（1 秒最多 1 条）', 429)
    await adapter.chat(clean)
    lastChatAt = stamp()
    push('chat_sent', { text: clean })
    return { ok: true }
  }

  async function start() {
    if (started) return status()
    started = true
    const loaded = loadLedger()
    if (loaded) push('ledger_loaded', { tasks: loaded })
    watchdogStats.startedAt = stamp()
    try {
      await adapter.connect()
    } catch (error) {
      push('body_error', { message: `connect: ${error?.message ?? error}` })
    }
    const adapterState = adapterStatus()
    const connected = adapterState.connected === undefined ? null : Boolean(adapterState.connected)
    if (connected === false) {
      connectionState = false
      offlineEpisode = true
      offlineReason = String(adapterState.lastError ?? 'not-connected')
      push('offline', { reason: offlineReason, willReconnect: Boolean(adapterState.reconnecting), at: stamp() })
    } else {
      // connect() 已经 resolve；adapter 没报状态就按在线处理，报了就按它报的。
      connectionState = connected === null ? true : connected
      if (connectionState) { everOnline = true; offlineEpisode = false }
      push('connected', {})
    }
    watchdogTimer = setInterval(() => {
      try { watchdogTick() } catch (error) { push('body_error', { message: `watchdog: ${error?.message ?? error}` }) }
    }, Math.max(500, Number(watchdogMs) || 2000))
    if (typeof watchdogTimer.unref === 'function') watchdogTimer.unref()
    return status()
  }

  async function stop() {
    if (closed) return { ok: true }
    closed = true
    started = false
    if (pausedTimer) { clearTimeout(pausedTimer); pausedTimer = null }
    if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null }
    if (current) {
      current.interruptReason = 'body-stopped'
      clearTaskTimers(current)
      if (current.abandonTimer) { clearTimeout(current.abandonTimer); current.abandonTimer = null }
      current.controller?.abort(abortError('body stopped'))
    }
    try { await adapter.disconnect?.() } catch { /* ignore */ }
    push('stopped', {})
    saveLedger()
    return { ok: true }
  }

  function status() {
    const adapterState = adapterStatus()
    // 断线事件是权威的：adapter 还没来得及更新状态时，状态栏也不能假在线。
    let connected
    if (connectionState === false) connected = false
    else if (adapterState.connected === undefined) connected = connectionState
    else connected = Boolean(adapterState.connected)
    // E6：join 之后“现在能不能玩”的布尔 + 阻塞原因（给 mc-link 直接展示/判断）。
    const playableBlockers = []
    if (connected !== true) playableBlockers.push('offline')
    if (paused) playableBlockers.push(`paused:${pausedReason ?? 'safety'}`)
    if (adapterState?.spawnSafety?.unsafe) playableBlockers.push('spawn-unsafe')
    if (adapterState?.reconnecting) playableBlockers.push('reconnecting')
    if (Number(adapterState?.health) <= 0) playableBlockers.push('dead')
    const reflex = reflexView()
    return {
      ok: true,
      version: 'mc-body/v1',
      allowTask,
      allowSay,
      connected,
      online: connected,
      paused,
      pausedReason,
      playable: { ok: playableBlockers.length === 0, blockers: playableBlockers },
      eyes: {
        structured: true,
        screenshot: typeof adapter.startScreenshotViewer === 'function',
        mediaDir: mediaDir ? path.resolve(String(mediaDir)) : null,
        runId: runId ?? null,
      },
      safety: {
        paused,
        reason: pausedReason,
        offline: connected === false,
        offlineReason,
        everOnline,
        bodyOnline: connected === true,
        // 说清语义：paused 不是“冻结世界”，只是不接任务/中断当前任务；方案 B：反射继续。
        note: paused
          ? `paused = 停任务/停控制，但身体仍在世界（会掉落/受伤/被推）；安全反射${reflexEnabled ? '开启' : '关闭'}（≤${reflexMaxDurationMs / 1000}s/次、≤${reflexMaxPerMinute} 次/分），可 cancel/tasks/look/stop 等安全 op；恢复用 /v1/safety/resume，暂停超时会 idle_disconnect`
          : null,
        reflex,
        lastReflex: reflexState.lastAt ? {
          at: reflexState.lastAt,
          reason: reflexState.lastReason,
          action: reflexState.lastAction,
          durationMs: reflexState.lastDurationMs,
          timedOut: reflexState.lastTimedOut,
          eventSeq: reflexState.lastEventSeq,
        } : null,
        alarms: {
          delivered: alarmState.deliveredCount,
          suppressed: alarmState.suppressedCount,
          redelivered: alarmState.redeliveredCount,
          pending: alarmState.pending.size,
          lastAt: alarmState.lastAt,
        },
        lastSafetyStopAt,
      },
      task: taskView(current),
      queue: queue.map(taskView),
      pausedTasks: [...tasks.values()].filter((task) => task.state === 'paused').map(taskView),
      spawnLog: spawnLog.slice(-10),
      eventsSeq: seq,
      reconnect: adapterState.reconnect ?? null,
      watchdog: watchdogSummary(),
      adapter: adapterState,
    }
  }

  function eventsSince(since = 0) {
    const from = Math.max(0, Number(since) || 0)
    return { events: events.filter((e) => e.seq > from), seq }
  }

  // 上层要求进程退出（而非硬杀）：交给宿主的钩子记录归因，再优雅收尾。
  async function shutdownRequest(reason = 'requested') {
    push('shutdown_requested', { reason: String(reason) })
    if (typeof onShutdownRequest === 'function') {
      try { return await onShutdownRequest(String(reason)) } catch (error) { return { ok: false, error: String(error?.message ?? error) } }
    }
    return { ok: true, note: 'body 无宿主退出钩子，仅记录事件' }
  }

  return {
    start, stop, status, eventsSince, createTask, getTask, listTasks, cancelTask, resumeTask,
    safetyStop, stopAll, resume, ingest, inspect, eyesSnapshot, eyesScreenshot, doPlan, chat, push, watchdogTick, shutdownRequest,
  }
}







