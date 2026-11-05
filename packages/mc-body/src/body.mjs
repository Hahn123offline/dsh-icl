// MC body 的领域核心：任务状态机、事件、幂等、取消、安全停止。
// 不依赖 mineflayer；真实执行由 adapter 注入，测试用 fake adapter。
import fs from 'node:fs'
import path from 'node:path'

const KINDS = new Set(['mine', 'goto', 'patrol', 'explore', 'follow', 'chat', 'routine'])
const TERMINAL = new Set(['done', 'failed', 'cancelled', 'interrupted'])

function abortError(message = 'aborted') {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

export function createBody({ adapter, allowTask = true, allowSay = true, logFile = null, stateFile = null, now = () => Date.now(), eventLimit = 2000, watchdogMs = 2000, pausedDisconnectMs = 120_000 } = {}) {
  if (!adapter) throw new Error('body 需要 adapter')
  const events = []
  const tasks = new Map()
  const queue = []
  const idempotency = new Map()
  let seq = 0
  let taskSeq = 0
  let current = null
  let paused = false
  let pausedReason = null
  let closed = false
  let pumping = false
  let lastHealth = null
  let watchdogTimer = null
  const deaths = []
  let returning = false
  let pausedTimer = null

  function stamp() { return now() }

  function saveLedger() {
    if (!stateFile) return
    try {
      const rows = [...tasks.values()].map(({ controller, ...task }) => task)
      fs.mkdirSync(path.dirname(stateFile), { recursive: true })
      const tmp = `${stateFile}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: stamp(), tasks: rows }, null, 2), 'utf8')
      fs.renameSync(tmp, stateFile)
    } catch { /* 台账失败不影响身体 */ }
  }

  function loadLedger() {
    if (!stateFile) return
    try {
      const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      for (const raw of Array.isArray(data?.tasks) ? data.tasks : []) {
        if (!raw?.id) continue
        const task = { ...raw, controller: null }
        if (!TERMINAL.has(task.state)) {
          task.state = 'interrupted'
          task.error = 'body-restart'
          task.finishedAt = task.finishedAt ?? stamp()
        }
        tasks.set(task.id, task)
        if (task.idempotencyKey) idempotency.set(task.idempotencyKey, task.id)
        const num = Number(String(task.id).replace(/^t-/, ''))
        if (Number.isFinite(num)) taskSeq = Math.max(taskSeq, num)
      }
    } catch { /* 第一次运行 */ }
  }

  function push(type, data = {}) {
    seq += 1
    const event = { seq, at: stamp(), type, data }
    events.push(event)
    while (events.length > eventLimit) events.shift()
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
      progress: task.progress, createdAt: task.createdAt, startedAt: task.startedAt,
      finishedAt: task.finishedAt, deadlineAt: task.deadlineAt,
      result: task.result ?? null, error: task.error ?? null,
    }
  }

  function setTask(task, state, extra = {}) {
    task.state = state
    Object.assign(task, extra)
    if (TERMINAL.has(state)) {
      task.finishedAt = stamp()
      push(`task_${state}`, { task: taskView(task) })
    }
    saveLedger()
  }

  async function pump() {
    if (pumping || returning || closed || current) return
    const next = queue.shift()
    if (!next) return
    pumping = true
    current = next
    next.state = 'running'
    next.startedAt = stamp()
    const controller = new AbortController()
    next.controller = controller
    const timeout = setTimeout(() => {
      next.timedOut = true
      controller.abort(abortError('timeout'))
    }, Math.max(1000, Number(next.deadlineMs) || 600_000))
    if (typeof timeout.unref === 'function') timeout.unref()
    push('task_started', { task: taskView(next) })
    try {
      const result = await adapter.runTask(next, {
        signal: controller.signal,
        progress: (progress) => { next.progress = progress; push('task_progress', { taskId: next.id, progress }) },
      })
      if (controller.signal.aborted) throw controller.signal.reason ?? abortError()
      setTask(next, 'done', { result: result ?? null })
    } catch (error) {
      if (next.cancelReason) setTask(next, 'cancelled', { error: next.cancelReason })
      else if (next.interruptReason) setTask(next, 'interrupted', { error: next.interruptReason })
      else if (next.timedOut) setTask(next, 'failed', { error: 'timeout' })
      else if (error?.name === 'AbortError') setTask(next, 'cancelled', { error: 'aborted' })
      else setTask(next, 'failed', { error: String(error?.message ?? error) })
    } finally {
      clearTimeout(timeout)
      next.controller = null
      current = null
      pumping = false
      if (!paused && queue.length === 0 && !returning && typeof adapter.returnToSafe === 'function') {
        returning = true
        Promise.resolve(adapter.returnToSafe())
          .catch(() => {})
          .finally(() => { returning = false; void pump() })
      }
      void pump()
    }
  }

  function createTask({ idempotencyKey = null, kind, params = {}, deadlineMs = null } = {}) {
    if (!allowTask) throw Object.assign(new Error('body 未允许任务'), { statusCode: 403 })
    if (!KINDS.has(String(kind))) throw Object.assign(new Error(`未知任务：${kind}`), { statusCode: 400 })
    if (idempotencyKey != null) {
      const existing = idempotency.get(String(idempotencyKey))
      if (existing) return taskView(tasks.get(existing))
    }
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
      result: null,
      error: null,
      cancelReason: null,
      interruptReason: null,
      timedOut: false,
      controller: null,
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
    if (task.state === 'queued') {
      const index = queue.indexOf(task)
      if (index >= 0) queue.splice(index, 1)
      setTask(task, 'cancelled', { error: task.cancelReason })
    } else {
      task.controller?.abort(abortError('cancelled'))
    }
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
      if (!TERMINAL.has(task.state)) setTask(task, 'interrupted', { error: pausedReason })
    }
    if (current) {
      current.interruptReason = pausedReason
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
    paused = false
    pausedReason = null
    if (pausedTimer) { clearTimeout(pausedTimer); pausedTimer = null }
    push('safety_resume', {})
    void pump()
    return { paused }
  }

  function ingest(type, data = {}) {
    const event = push(String(type), data)
    if (type === 'health') {
      const health = Number(data.health)
      if (Number.isFinite(health)) {
        // 真实世界里“持续掉血”比“血量低”更早出现；先停，再让头脑决定。
        if (lastHealth != null && health < lastHealth - 1) {
          push('health_drop', { from: lastHealth, to: health })
          safetyStop('health-drop')
        } else if (health <= 10) safetyStop('low-health')
        lastHealth = health
      }
    }
    if (type === 'death') {
      const at = stamp()
      deaths.push(at)
      while (deaths.length && at - deaths[0] > 120_000) deaths.shift()
      safetyStop('death')
      if (deaths.length >= 3) {
        safetyStop('quarantine')
        try { void Promise.resolve(adapter.disconnect?.()).catch(() => {}) } catch { /* ignore */ }
      }
    }
    if (type === 'stuck') safetyStop('stuck')
    if (type === 'spawn_unsafe') safetyStop('spawn-unsafe')
    if (type === 'disconnected') safetyStop('disconnect')
    return event
  }

  async function inspect(kind, params = {}) {
    if (typeof adapter.inspect !== 'function') throw Object.assign(new Error('body 不支持 inspect'), { statusCode: 501 })
    const allowed = new Set(['look', 'inventory', 'scan', 'map'])
    if (!allowed.has(String(kind))) throw Object.assign(new Error(`未知 inspect：${kind}`), { statusCode: 400 })
    return adapter.inspect(String(kind), params)
  }

  async function doPlan(steps, params = {}) {
    if (!Array.isArray(steps) || !steps.length) throw Object.assign(new Error('do 需要非空 steps'), { statusCode: 400 })
    const safeWhenPaused = new Set(['look', 'inventory', 'scan', 'map', 'say', 'events', 'tasks', 'resume', 'move', 'goto', 'use', 'eat', 'equip', 'attack', 'wait'])
    const results = []
    for (const [index, step] of steps.entries()) {
      const op = String(step?.op ?? '')
      if (!op) throw Object.assign(new Error(`第 ${index + 1} 步缺少 op`), { statusCode: 400 })
      if (paused && !safeWhenPaused.has(op)) {
        throw Object.assign(new Error(`身体已暂停（${pausedReason ?? 'safety'}）；先 resume，或只用 ${[...safeWhenPaused].join('/')}`), { statusCode: 409 })
      }
      if (op === 'task') {
        const taskParams = step.params?.params ?? step.params ?? {}
        const kind = step.kind ?? step.params?.kind
        if (!kind) throw Object.assign(new Error('task op 需要 kind（如 kind:"mine"）'), { statusCode: 400 })
        const task = createTask({ ...step, kind, params: taskParams })
        return { ok: true, results, task }
      }
      if (op === 'cancel') { results.push({ index, op, result: cancelTask(step.taskId, step.reason) }); continue }
      if (op === 'resume') { results.push({ index, op, result: resume({ force: Boolean(step.force) }) }); continue }
      if (op === 'events') { results.push({ index, op, result: eventsSince(step.since ?? 0) }); continue }
      if (op === 'tasks') { results.push({ index, op, result: listTasks(step.state ?? null) }); continue }
      if (op === 'say') { results.push({ index, op, result: await chat(step.text) }); continue }
      if (['look', 'inventory', 'scan', 'map'].includes(op)) {
        results.push({ index, op, result: await inspect(op, step.params ?? step) })
        continue
      }
      if (typeof adapter.runOp !== 'function') throw Object.assign(new Error('body adapter 不支持组合 op'), { statusCode: 501 })
      results.push({ index, op, result: await adapter.runOp(op, step.params ?? step) })
    }
    return { ok: true, results }
  }

  async function chat(text) {
    if (!allowSay) throw Object.assign(new Error('body 未允许发言'), { statusCode: 403 })
    const clean = String(text ?? '').replace(/[\r\n]+/g, ' ').trim()
    if (!clean) throw Object.assign(new Error('text 必填'), { statusCode: 400 })
    if (clean.startsWith('/')) throw Object.assign(new Error('不允许执行命令'), { statusCode: 400 })
    if (clean.length > 200) throw Object.assign(new Error('text 太长（<=200）'), { statusCode: 400 })
    await adapter.chat(clean)
    push('chat_sent', { text: clean })
    return { ok: true }
  }

  async function start() {
    loadLedger()
    await adapter.connect()
    push('connected', {})
    watchdogTimer = setInterval(() => {
      if (paused || closed) return
      try {
        const s = adapter.status?.() ?? {}
        if (Number.isFinite(s.health) && s.health <= 10) { ingest('health', { health: s.health, food: s.food }); return }
        if (s.submerged && Number.isFinite(s.oxygen) && s.oxygen <= 5) safetyStop('low-oxygen')
      } catch { /* 看门狗自己坏了不能拖垮身体 */ }
    }, Math.max(500, Number(watchdogMs) || 2000))
    if (typeof watchdogTimer.unref === 'function') watchdogTimer.unref()
    return status()
  }

  async function stop() {
    closed = true
    if (pausedTimer) { clearTimeout(pausedTimer); pausedTimer = null }
    if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null }
    if (current) current.controller?.abort(abortError('body stopped'))
    try { await adapter.disconnect?.() } catch { /* ignore */ }
    push('stopped', {})
  }

  function status() {
    return {
      ok: true,
      version: 'mc-body/v1',
      allowTask,
      allowSay,
      paused,
      pausedReason,
      task: taskView(current),
      queue: queue.map(taskView),
      eventsSeq: seq,
      adapter: adapter.status?.() ?? {},
    }
  }

  function eventsSince(since = 0) {
    const from = Math.max(0, Number(since) || 0)
    return { events: events.filter((e) => e.seq > from), seq }
  }

  return { start, stop, status, eventsSince, createTask, getTask, listTasks, cancelTask, safetyStop, resume, ingest, inspect, doPlan, chat, push }
}
