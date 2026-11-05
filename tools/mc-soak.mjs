// Body-only soak：自己起 body、下 routine、收集事件/状态、干净停掉。
// 不接 ICL 会话，避免上层任务污染数据。
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const args = process.argv.slice(2)
const arg = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback }
const flag = (name) => args.includes(name)
const minutes = Math.max(1, Number(arg('--minutes', 10)))
const targetCount = Math.max(1, Number(arg('--target', minutes * 6)))
const host = String(arg('--host', '127.0.0.1'))
const port = Number(arg('--port', 54835))
const listen = Number(arg('--listen', 54836))
const name = String(arg('--name', 'ICL-Soak'))
const out = path.resolve(String(arg('--out', path.join('C:/DSH/icl/.state/mc-soak', new Date().toISOString().replace(/[:.]/g, '-')))))
fs.mkdirSync(out, { recursive: true })
const base = `http://127.0.0.1:${listen}`
const bodyLog = path.join(out, 'body.log')
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
  const res = await fetch(`${base}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) })
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

const child = spawn(process.execPath, [
  path.join('C:/DSH/icl/packages/mc-body/src/cli.mjs'),
  '--host', String(host), '--port', String(port), '--listen', String(listen),
  '--name', name, '--allow-task', '--paused-disconnect-ms', '60000',
  '--state', path.join(out, 'tasks.json'),
  '--log', path.join(out, 'body-events.jsonl'),
], { stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout.pipe(logStream)
child.stderr.pipe(logStream)

const metrics = { startedAt: new Date().toISOString(), minutes, out, bodyExit: null, task: null, snapshots: 0, events: 0, taskEvents: [], safetyStops: 0, deaths: 0, emergencies: 0, paused: false, pausedReason: null }
let cursor = 0
let stopped = false

try {
  const status0 = await waitFor(async () => {
    const s = await get('/v1/status')
    return s?.adapter?.connected ? s : null
  }, 30_000, 'body connect')
  metrics.connected = true
  metrics.initial = { position: status0.adapter.position, health: status0.adapter.health, food: status0.adapter.food }

  const taskRes = await post('/v1/tasks', {
    idempotencyKey: `soak-${Date.now()}`,
    kind: 'routine',
    params: {
      durationMs: minutes * 60_000,
      targetCount,
      tripEvery: 8,
      radius: 12,
      blocks: ['oak_log', 'spruce_log', 'birch_log', 'stone', 'dirt'],
    },
    deadlineMs: minutes * 60_000 + 30_000,
  })
  if (!taskRes?.ok) throw new Error(`task rejected: ${JSON.stringify(taskRes)}`)
  metrics.taskId = taskRes.task.id

  const deadline = Date.now() + (minutes + 2) * 60_000
  let terminalAt = 0
  let pausedAt = 0
  while (Date.now() < deadline && !stopped) {
    await sleep(5000)
    const status = await get('/v1/status').catch(() => null)
    if (!status) continue
    metrics.snapshots += 1
    metrics.paused = Boolean(status.paused)
    metrics.pausedReason = status.pausedReason ?? null
    fs.appendFileSync(timelineFile, `${JSON.stringify({ at: Date.now(), task: status.task, paused: status.paused, pausedReason: status.pausedReason, health: status.adapter?.health, food: status.adapter?.food, position: status.adapter?.position })}\n`, 'utf8')
    const ev = await get(`/v1/events?since=${cursor}`).catch(() => null)
    if (ev?.events?.length) {
      for (const event of ev.events) {
        cursor = Math.max(cursor, Number(event.seq) || cursor)
        metrics.events += 1
        fs.appendFileSync(eventFile, `${JSON.stringify(event)}\n`, 'utf8')
        if (event.type === 'safety_stop') metrics.safetyStops += 1
        if (event.type === 'death') metrics.deaths += 1
        if (event.type === 'emergency') metrics.emergencies += 1
        if (String(event.type).startsWith('task_')) {
          metrics.taskEvents.push({ type: event.type, seq: event.seq, state: event.data?.task?.state, error: event.data?.task?.error, progress: event.data?.task?.progress })
          if (event.data?.task) metrics.lastTask = event.data.task
          if (['task_done', 'task_failed', 'task_cancelled', 'task_interrupted'].includes(event.type)) terminalAt = terminalAt || Date.now()
        }
      }
    }
    const task = status.task
    metrics.task = task
    if (task && ['done', 'failed', 'cancelled', 'interrupted'].includes(task.state)) {
      terminalAt = terminalAt || Date.now()
    }
    if (terminalAt && Date.now() - terminalAt > 8000) break
    if (status.paused) {
      pausedAt = pausedAt || Date.now()
      if (Date.now() - pausedAt > 30_000) break
    } else {
      pausedAt = 0
    }
  }
} catch (error) {
  metrics.error = String(error?.message ?? error)
} finally {
  stopped = true
  try { await post('/v1/safety/stop', { reason: 'soak done' }) } catch { /* ignore */ }
  try { child.kill('SIGTERM') } catch { /* ignore */ }
  await sleep(1000)
  try { if (child.exitCode == null) child.kill('SIGKILL') } catch { /* ignore */ }
  metrics.bodyExit = child.exitCode
  logStream.end()
}

const summary = [
  '# MC body soak',
  '',
  `- out: ${out}`,
  `- minutes: ${minutes}`,
  `- connected: ${Boolean(metrics.connected)}`,
  `- task: ${(metrics.lastTask ?? metrics.task)?.kind ?? '-'} ${(metrics.lastTask ?? metrics.task)?.state ?? 'none'}`,
  `- progress: ${JSON.stringify(metrics.task?.progress ?? null)}`,
  `- snapshots: ${metrics.snapshots}`,
  `- events: ${metrics.events}`,
  `- safety_stop: ${metrics.safetyStops}`,
  `- death: ${metrics.deaths}`,
  `- emergency: ${metrics.emergencies}`,
  `- paused: ${metrics.paused} ${metrics.pausedReason ?? ''}`,
  `- error: ${metrics.error ?? 'none'}`,
].join('\n')
fs.writeFileSync(reportFile, summary, 'utf8')
fs.writeFileSync(metricsFile, JSON.stringify(metrics, null, 2), 'utf8')
console.log(summary)
process.exit(metrics.error ? 1 : 0)
