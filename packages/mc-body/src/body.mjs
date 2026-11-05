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

const KINDS = new Set(['mine', 'goto', 'patrol', 'explore', 'follow', 'chat', 'routine'])
const TERMINAL = new Set(['done', 'failed', 'cancelled', 'interrupted', 'unknown'])
const MOVEMENT_KINDS = new Set(['goto', 'patrol', 'explore', 'follow'])
// 暂停时仍然允许的非动作 op（感知/查询/恢复）；写动作一律拒绝。
const SAFE_WHILE_PAUSED = new Set(['look', 'inventory', 'scan', 'map', 'events', 'tasks', 'resume', 'wait'])

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

  function stamp() { return now() }

  function saveLedger() {
    if (!stateFile) return
    try {
      const rows = [...tasks.values()].map(({ controller, timer, ...task }) => task)
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
    const event = { seq, at: stamp(), type, data }
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
      // adapter 可能无视 abort 直接返回：先按中断/超时/断线归类，再谈成功。
      if (next.cancelReason) setTask(next, 'cancelled', { error: next.cancelReason })
      else if (next.interruptReason) setTask(next, 'interrupted', { error: next.interruptReason })
      else if (next.pausedByDisconnect) setTask(next, 'paused', { pausedReason: 'disconnect' })
      else if (next.timedOut) setTask(next, 'unknown', { error: 'timeout', outcomeUnknown: true })
      else setTask(next, 'done', { result: result ?? null })
    } catch (error) {
      if (next.cancelReason) setTask(next, 'cancelled', { error: next.cancelReason })
      else if (next.interruptReason) setTask(next, 'interrupted', { error: next.interruptReason })
      else if (next.pausedByDisconnect) setTask(next, 'paused', { pausedReason: 'disconnect' })
      else if (next.timedOut) setTask(next, 'unknown', { error: 'timeout', outcomeUnknown: true })
      else if (error?.name === 'AbortError') setTask(next, 'cancelled', { error: 'aborted' })
      else setTask(next, 'failed', { error: String(error?.message ?? error), result: error?.result ?? null })
    } finally {
      clearTaskTimers(next)
      next.controller = null
      current = null
      pumping = false
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
  function pauseCurrentTask(reason) {
    const task = current
    if (!task || TERMINAL.has(task.state) || task.state === 'paused') return null
    task.pausedByDisconnect = true
    task.remainingMs = Math.max(1000, (Number(task.deadlineAt) || stamp()) - stamp())
    clearTaskTimers(task)
    task.controller?.abort(abortError(reason))
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
    if (paused) {
      // 已经停了就别每 500ms 再发一条 safety_stop；只有更严重的 death/quarantine 更新原因。
      if (next === 'death' || next === 'quarantine') {
        if (next === 'death' && pausedReason !== 'death' && pausedReason !== 'quarantine') {
          pausedReason = next
          push('safety_stop', { reason: pausedReason })
        } else if (next === 'quarantine' && pausedReason !== 'quarantine') {
          pausedReason = next
          push('safety_stop', { reason: pausedReason })
        }
      }
      return { paused, reason: pausedReason }
    }
    paused = true
    pausedReason = next
    push('safety_stop', { reason: pausedReason })
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
      }, Number(pausedDisconnectMs))
      if (typeof pausedTimer.unref === 'function') pausedTimer.unref()
    }
    return { paused, reason: pausedReason }
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
    if (action) {
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
    if (previous != null && value < previous - 1) {
      // 只在“还在正常活动”时把掉血当成独立事件；已暂停/安全停止后不再刷 health_drop，
      // 只计数（suppressed 统计），避免真实局里几百条重复事件。
      if (!paused) push('health_drop', { from: previous, to: value })
      else watchdogStats.healthDropSuppressed = (watchdogStats.healthDropSuppressed ?? 0) + 1
      alertWatchdog('danger', 'health-drop', { from: previous, to: value }, () => safetyStop('health-drop'))
    }
  }

  function checkOxygen(status) {
    const oxygen = Number(status.oxygen)
    if (!Number.isFinite(oxygen)) return
    const submerged = status.submerged === true
    if ((submerged && oxygen <= 5) || oxygen <= 2) {
      alertWatchdog('danger', 'low-oxygen', { oxygen, submerged }, () => safetyStop('low-oxygen'))
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
      // 首次连接/重连后的第一次 spawn：状态栏不许假在线，也不许假离线。
      if (connectionState === false) handleReconnected({ source: 'spawn' })
      else { connectionState = true; everOnline = true; offlineEpisode = false; offlineReason = null }
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

  async function doPlan(steps, params = {}) {
    if (!Array.isArray(steps) || !steps.length) throw httpError('do 需要非空 steps', 400)
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
    return {
      ok: true,
      version: 'mc-body/v1',
      allowTask,
      allowSay,
      connected,
      online: connected,
      paused,
      pausedReason,
      safety: { paused, reason: pausedReason, offline: connected === false, offlineReason, everOnline },
      task: taskView(current),
      queue: queue.map(taskView),
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

  return {
    start, stop, status, eventsSince, createTask, getTask, listTasks, cancelTask, resumeTask,
    safetyStop, resume, ingest, inspect, doPlan, chat, push, watchdogTick,
  }
}
