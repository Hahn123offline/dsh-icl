// mc-body 真实 soak：起 body 子进程 → routine 采集 → 收事件/状态 → 干净停掉 → report/metrics。
// 用法：
//   node packages/mc-body/tools/soak.mjs --port 54837 --listen 54902 --name ICL-mcbody-1 --minutes 30 \
//     --out C:/DSH/icl/.state/lab/mc-body-soak/<run>
// 产物：body.log / body-events.jsonl / events.jsonl / timeline.jsonl / metrics.json / report.md
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const bodyCli = path.resolve(here, '..', 'src', 'cli.mjs')
const args = process.argv.slice(2)
const arg = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback }
const flag = (name) => args.includes(name)
const minutes = Math.max(1, Number(arg('--minutes', 30)))
const targetCount = Math.max(1, Number(arg('--target', 9999)))
const host = String(arg('--host', '127.0.0.1'))
const port = Number(arg('--port', 54837))
const listen = Number(arg('--listen', 54902))
const name = String(arg('--name', 'ICL-mcbody-1'))
const blocks = String(arg('--blocks', 'oak_log,spruce_log,birch_log,stone,dirt')).split(',').map((value) => value.trim()).filter(Boolean)
const radius = Number(arg('--radius', 12))
const out = path.resolve(String(arg('--out', path.join('C:/DSH/icl/.state/lab/mc-body-soak', new Date().toISOString().replace(/[:.]/g, '-')))))
const stoppedBy = flag('--keep-events') ? 'keep-events' : 'safety-stop-and-sigterm'
fs.mkdirSync(out, { recursive: true })

const base = `http://127.0.0.1:${listen}`
const bodyLog = path.join(out, 'body.log')
const bodyEventFile = path.join(out, 'body-events.jsonl')
const eventFile = path.join(out, 'events.jsonl')
const timelineFile = path.join(out, 'timeline.jsonl')
const reportFile = path.join(out, 'report.md')
const metricsFile = path.join(out, 'metrics.json')
const logStream = fs.createWriteStream(bodyLog, { flags: 'a' })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function get(pathname) {
  const res = await fetch(`${base}${pathname}`, { signal: AbortSignal.timeout(3000) })
  return res.json()
}
async function post(pathname, body) {
  const res = await fetch(`${base}${pathname}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(5000),
  })
  return res.json()
}
async function waitFor(fn, timeoutMs, label) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try { const value = await fn(); if (value) return value } catch { /* not up yet */ }
    await sleep(500)
  }
  throw new Error(`wait timeout: ${label}`)
}

const metrics = {
  startedAt: new Date().toISOString(),
  minutes, out, bodyExit: null, connected: false, reconnectEvents: [], pausedEpisodes: [],
  snapshots: 0, events: 0, safetyStops: 0, deaths: 0, emergencies: 0, watchdogSuppressed: 0,
  taskEvents: [], lastTask: null, initial: null, final: null, error: null,
  checks: { noDeath: null, noSafetyStop: null, taskTerminal: null, noStuckRestart: null, watchdogAlive: null },
}

const child = spawn(process.execPath, [
  bodyCli,
  '--host', String(host), '--port', String(port), '--listen', String(listen),
  '--name', name, '--allow-task', '--paused-disconnect-ms', '60000',
  '--state', path.join(out, 'tasks.json'),
  '--log', path.join(out, 'body-events.jsonl'),
  '--heartbeat-ms', '60000',
], { stdio: ['ignore', 'pipe', 'pipe'], cwd: path.resolve(here, '..', '..', '..') })
child.stdout.pipe(logStream)
child.stderr.pipe(logStream)

let cursor = 0
let stopped = false

try {
  const status0 = await waitFor(async () => {
    const status = await get('/v1/status')
    return status?.connected ? status : null
  }, 90_000, 'body connect')
  metrics.connected = true
  // 出生安全是 chunk 加载后才判的：等判定结果，避免在“还不知道安不安全”时下任务。
  const safeStatus = await waitFor(async () => {
    const status = await get('/v1/status')
    return status?.adapter?.spawnSafety ? status : null
  }, 20_000, 'spawn safety')
  metrics.initial = {
    position: safeStatus.adapter?.position ?? null,
    health: safeStatus.adapter?.health ?? null,
    food: safeStatus.adapter?.food ?? null,
    spawnSafety: safeStatus.adapter?.spawnSafety ?? null,
    paused: safeStatus.paused,
  }
  const spawnUnsafe = Boolean(safeStatus.adapter?.spawnSafety?.unsafe)
  if (safeStatus.paused || spawnUnsafe) {
    throw new Error(`body 启动即暂停/出生不安全：${safeStatus.pausedReason ?? 'spawn-unsafe'}`)
  }
  metrics.spawnUnsafe = spawnUnsafe

  const taskRes = await post('/v1/tasks', {
    idempotencyKey: `soak-${Date.now()}`,
    kind: 'routine',
    params: {
      durationMs: minutes * 60_000,
      targetCount,
      tripEvery: 8,
      radius,
      blocks,
    },
    deadlineMs: minutes * 60_000 + 60_000,
  })
  if (!taskRes?.ok) throw new Error(`task rejected: ${JSON.stringify(taskRes)}`)
  metrics.taskId = taskRes.task.id

  const finishedAt = Date.now() + (minutes + 2) * 60_000
  let terminalAt = 0
  let pausedAt = 0
  let lastPulse = Date.now()
  let lastProgress = null
  while (Date.now() < finishedAt && !stopped) {
    await sleep(5000)
    const status = await get('/v1/status').catch(() => null)
    if (!status) continue
    metrics.snapshots += 1
    const task = status.task
    metrics.lastTask = task
    metrics.watchdogSuppressed = Number(status.watchdog?.suppressed ?? 0)
    metrics.pathStats = status.adapter?.pathStats ?? null
    metrics.reconnecting = status.adapter?.reconnect ?? null
    fs.appendFileSync(timelineFile, `${JSON.stringify({
      at: Date.now(),
      taskState: task?.state ?? null,
      progress: task?.progress ?? null,
      paused: status.paused,
      pausedReason: status.pausedReason,
      connected: status.connected,
      health: status.adapter?.health,
      food: status.adapter?.food,
      position: status.adapter?.position,
      watchdog: {
        ticks: status.watchdog?.ticks, alerts: status.watchdog?.alerts,
        suppressed: status.watchdog?.suppressed, suppressedBy: status.watchdog?.suppressedBy,
        healthDropSuppressed: status.watchdog?.healthDropSuppressed,
      },
      pathStats: status.adapter?.pathStats,
    })}\n`, 'utf8')
    if (task?.progress && JSON.stringify(task.progress) !== JSON.stringify(lastProgress)) lastProgress = task.progress
    // 只在有任务时更新：任务结束后 status.task 是 null，不能把终态覆盖掉。
    if (task) metrics.lastTask = task
    const events = await get(`/v1/events?since=${cursor}`).catch(() => null)
    if (events?.events?.length) {
      for (const event of events.events) {
        cursor = Math.max(cursor, Number(event.seq) || cursor)
        metrics.events += 1
        fs.appendFileSync(eventFile, `${JSON.stringify(event)}\n`, 'utf8')
        if (event.type === 'safety_stop') metrics.safetyStops += 1
        if (event.type === 'death') metrics.deaths += 1
        if (event.type === 'emergency') metrics.emergencies += 1
        if (['offline', 'reconnected', 'reconnect_exhausted', 'reconnecting'].includes(event.type)) metrics.reconnectEvents.push({ type: event.type, seq: event.seq, data: event.data })
        if (String(event.type).startsWith('task_')) {
          metrics.taskEvents.push({ type: event.type, seq: event.seq, state: event.data?.task?.state, error: event.data?.task?.error })
          if (event.data?.task) metrics.lastTask = event.data.task
          if (['task_done', 'task_failed', 'task_cancelled', 'task_interrupted', 'task_unknown'].includes(event.type)) {
            metrics.terminalTask = event.data?.task ?? null
            terminalAt = terminalAt || Date.now()
          }
        }
        if (metrics.taskEvents.length > 200) metrics.taskEvents.splice(0, metrics.taskEvents.length - 200)
      }
    }
    if (task && ['done', 'failed', 'cancelled', 'interrupted', 'unknown'].includes(task.state)) terminalAt = terminalAt || Date.now()
    if (terminalAt && Date.now() - terminalAt > 10_000) break
    if (status.paused) {
      pausedAt = pausedAt || Date.now()
      // 暂停超过 90s 视为卡死/安全异常，结束 soak 但保留证据。
      if (Date.now() - pausedAt > 90_000) {
        metrics.pausedTimeout = true
        break
      }
    } else {
      pausedAt = 0
    }
    if (Date.now() - lastPulse > 120_000) lastPulse = Date.now()
  }
  metrics.final = await get('/v1/status').catch(() => null)
} catch (error) {
  metrics.error = String(error?.message ?? error)
} finally {
  stopped = true
  try { await post('/v1/safety/stop', { reason: 'soak done' }) } catch { /* ignore */ }
  try { child.kill('SIGTERM') } catch { /* ignore */ }
  await sleep(1500)
  try { if (child.exitCode == null) child.kill('SIGKILL') } catch { /* ignore */ }
  metrics.bodyExit = child.exitCode
  logStream.end()
}

const task = metrics.terminalTask ?? metrics.lastTask ?? metrics.final?.task ?? null
const terminalState = task?.state ?? null
const doneReason = task?.state === 'done' ? (task?.result?.reason ?? null) : null
metrics.checks.noDeath = metrics.deaths === 0
metrics.checks.noSafetyStop = metrics.safetyStops === 0 && !metrics.pausedTimeout
metrics.checks.taskTerminal = ['done', 'failed', 'cancelled', 'interrupted', 'unknown'].includes(terminalState)
metrics.checks.noStuckRestart = !(metrics.reconnectEvents ?? []).some((event) => ['reconnect_exhausted'].includes(event.type))
metrics.checks.watchdogAlive = Number(metrics.final?.watchdog?.ticks ?? 0) > 0
const pass = Object.values(metrics.checks).every(Boolean) && !metrics.error && terminalState === 'done' && (doneReason === 'duration' || doneReason === 'target')

const summary = [
  '# MC body soak',
  '',
  `- run: ${out}`,
  `- server: ${host}:${port} · bot: ${name} · body http: ${base}`,
  `- minutes: ${minutes}`,
  `- connected: ${metrics.connected}`,
  `- initial: ${JSON.stringify(metrics.initial)}`,
  `- final task: ${task?.kind ?? '-'} state=${terminalState ?? 'none'} reason=${doneReason ?? '-'} progress=${JSON.stringify(task?.progress ?? null)}`,
  `- snapshots: ${metrics.snapshots} · events: ${metrics.events}`,
  `- safety_stop: ${metrics.safetyStops} · death: ${metrics.deaths} · emergency: ${metrics.emergencies}`,
  `- paused: ${metrics.final?.paused ?? '?'} ${metrics.final?.pausedReason ?? ''}${metrics.pausedTimeout ? '（暂停超时）' : ''}`,
  `- reconnect events: ${JSON.stringify(metrics.reconnectEvents)}`,
  `- pathStats: ${JSON.stringify(metrics.pathStats ?? null)}`,
  `- watchdog suppressed: ${metrics.watchdogSuppressed} by=${JSON.stringify(metrics.final?.watchdog?.suppressedBy ?? {})}`,
  `- error: ${metrics.error ?? 'none'}`,
  `- checks: ${JSON.stringify(metrics.checks)}`,
  `- result: ${pass ? 'PASS' : 'FAIL'}`,
].join('\n')
fs.writeFileSync(reportFile, `${summary}\n`, 'utf8')
fs.writeFileSync(metricsFile, JSON.stringify(metrics, null, 2), 'utf8')
console.log(summary)
process.exit(pass ? 0 : 1)
