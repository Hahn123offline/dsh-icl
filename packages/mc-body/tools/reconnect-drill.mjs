// 真实断线/重连演练：本地 TCP 代理把 body 连到真实 MC 服，代理可以掐断/拒绝，
// 用来验证：offline → 有界重试 → reconnected → 身体仍暂停（不自动续跑）→ 显式 resume
// → 显式 resumeTask；以及重连耗尽（reconnect_exhausted）时状态栏保持离线。
// 不重启服务器、不碰用户客户端；只在 127.0.0.1 上代理。
//
// 用法：node packages/mc-body/tools/reconnect-drill.mjs --upstream 54837 --proxy 54840 --listen 54903 \
//   --name ICL-mcbody-rc --out <ICL_ROOT>/lab/mc-body-soak/<run>-reconnect
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { iclPaths } from '../../core/src/icl-paths.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const bodyCli = path.resolve(here, '..', 'src', 'cli.mjs')
const args = process.argv.slice(2)
const arg = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback }
const host = String(arg('--host', '127.0.0.1'))
const upstreamPort = Number(arg('--upstream', 54837))
const proxyPort = Number(arg('--proxy', 54840))
const listen = Number(arg('--listen', 54903))
const name = String(arg('--name', 'ICL-mcbody-rc'))
const maxReconnect = Number(arg('--max-reconnect', 3))
const reconnectBaseMs = Number(arg('--reconnect-base-ms', 400))
const out = path.resolve(String(arg('--out', path.join(iclPaths().root, 'lab', 'mc-body-soak', `${new Date().toISOString().replace(/[:.]/g, '-')}-reconnect`))))
fs.mkdirSync(out, { recursive: true })
const base = `http://127.0.0.1:${listen}`
const logStream = fs.createWriteStream(path.join(out, 'body.log'), { flags: 'a' })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function get(pathname) {
  const response = await fetch(`${base}${pathname}`, { signal: AbortSignal.timeout(3000) })
  return response.json()
}
async function getTask(id) {
  const data = await get(`/v1/tasks/${encodeURIComponent(String(id))}`).catch(() => null)
  return data?.task ?? null
}
async function post(pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(5000),
  })
  return response.json()
}
async function waitFor(fn, timeoutMs, label) {
  const start = Date.now()
  let lastError = null
  while (Date.now() - start < timeoutMs) {
    try { const value = await fn(); if (value) return value } catch (error) { lastError = error }
    await sleep(200)
  }
  throw new Error(`wait timeout: ${label}${lastError ? ` (${lastError.message})` : ''}`)
}

// ---- 可掐断的 TCP 代理 -------------------------------------------------------
const sockets = new Set()
let proxyOpen = true
const proxy = net.createServer((client) => {
  sockets.add(client)
  client.on('close', () => sockets.delete(client))
  client.on('error', () => { sockets.delete(client); try { client.destroy() } catch { /* ignore */ } })
  if (!proxyOpen) { try { client.destroy() } catch { /* ignore */ } return }
  const upstream = net.connect(upstreamPort, host)
  sockets.add(upstream)
  upstream.on('close', () => sockets.delete(upstream))
  upstream.on('error', () => { sockets.delete(upstream); try { client.destroy() } catch { /* ignore */ } })
  client.pipe(upstream)
  upstream.pipe(client)
  client.on('close', () => { try { upstream.destroy() } catch { /* ignore */ } })
  upstream.on('close', () => { try { client.destroy() } catch { /* ignore */ } })
})
await new Promise((resolve) => proxy.listen(proxyPort, '127.0.0.1', resolve))

function dropAll() {
  for (const socket of sockets) { try { socket.destroy() } catch { /* ignore */ } }
  sockets.clear()
}
function closeProxy() {
  proxyOpen = false
  dropAll()
  return new Promise((resolve) => proxy.close(() => resolve()))
}

const checks = {}
const events = []
let cursor = 0
const child = spawn(process.execPath, [
  bodyCli,
  '--host', host, '--port', String(proxyPort), '--listen', String(listen),
  '--name', name, '--allow-task', '--paused-disconnect-ms', '60000',
  '--max-reconnect', String(maxReconnect), '--reconnect-base-ms', String(reconnectBaseMs),
  '--reconnect-max-delay-ms', String(reconnectBaseMs * 4),
  '--state', path.join(out, 'tasks.json'),
  '--log', path.join(out, 'body-events.jsonl'),
], { stdio: ['ignore', 'pipe', 'pipe'], cwd: path.resolve(here, '..', '..', '..') })
child.stdout.pipe(logStream)
child.stderr.pipe(logStream)

async function collectEvents() {
  const response = await get(`/v1/events?since=${cursor}`).catch(() => null)
  for (const event of response?.events ?? []) {
    cursor = Math.max(cursor, Number(event.seq) || cursor)
    events.push(event)
    fs.appendFileSync(path.join(out, 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf8')
  }
  return events
}

try {
  // 1. 正常连上（经代理）
  const connected = await waitFor(async () => {
    const status = await get('/v1/status')
    return status?.connected && status?.adapter?.spawnSafety ? status : null
  }, 60_000, 'connect via proxy')
  checks.connectedViaProxy = Boolean(connected.connected)
  await collectEvents()

  const task = await post('/v1/tasks', {
    idempotencyKey: `reconnect-${Date.now()}`,
    kind: 'routine',
    params: { durationMs: 5 * 60_000, tripEvery: 6, radius: 10, blocks: ['dirt', 'stone', 'oak_log'] },
    deadlineMs: 6 * 60_000,
  })
  if (!task?.ok) throw new Error(`task rejected: ${JSON.stringify(task)}`)
  const taskId = task.task.id
  await waitFor(async () => (await get('/v1/status')).task?.state === 'running', 20_000, 'task running')

  // 2. 掐断所有连接：必须 offline + 任务 paused（不是 failed/done），状态栏不假在线
  dropAll()
  const offline = await waitFor(async () => {
    const status = await get('/v1/status')
    return status.connected === false ? status : null
  }, 15_000, 'offline')
  checks.offlineDetected = true
  checks.statusNotFakeOnline = offline.connected === false
  // status.task 是“当前正在跑的任务”，断线后 current 会被摘掉；paused 状态在任务台账里查。
  const pausedTask = await waitFor(async () => {
    const row = await getTask(taskId)
    return row?.state === 'paused' ? row : null
  }, 10_000, 'task paused after disconnect')
  checks.runningTaskPaused = pausedTask.state === 'paused'
  checks.pausedReasonDisconnect = pausedTask.pausedReason === 'disconnect'
  const statusPaused = await get('/v1/status')
  checks.statusPausedTasksShowsIt = (statusPaused.pausedTasks ?? []).some((row) => row.id === taskId)

  // 3. 代理恢复（还在监听，新连接可进）：必须 reconnected，但身体仍暂停、任务不自动续跑
  const reconnected = await waitFor(async () => {
    const status = await get('/v1/status')
    return status.connected === true ? status : null
  }, 30_000, 'reconnected')
  checks.reconnected = true
  await sleep(2500)
  const afterReconnect = await get('/v1/status')
  checks.stillPausedAfterReconnect = afterReconnect.paused === true
  checks.taskNotAutoResumed = (await getTask(taskId))?.state === 'paused'
  await collectEvents()
  checks.sawOfflineEvent = events.some((event) => event.type === 'offline')
  checks.sawReconnectedEvent = events.some((event) => event.type === 'reconnected')
  checks.sawResumeRequiredEvent = events.some((event) => event.type === 'resume_required')

  // 4. 显式 resume：身体先恢复，再 resumeTask，任务继续（同一 taskId）
  await post('/v1/safety/resume')
  const resumed = await waitFor(async () => {
    const status = await get('/v1/status')
    return status.paused === false ? status : null
  }, 10_000, 'body resumed')
  checks.bodyResumed = resumed.paused === false
  await post(`/v1/tasks/${taskId}/resume`)
  const taskRunning = await waitFor(async () => {
    const status = await get('/v1/status')
    return status.task?.id === taskId && status.task.state === 'running' ? status : null
  }, 20_000, 'task resumed running')
  checks.taskResumedSameId = taskRunning.task?.id === taskId
  await sleep(3000)
  const progress = (await get('/v1/status')).task?.progress
  checks.taskProgressAfterResume = Number(progress?.collected ?? 0) >= 0
  await collectEvents()
  await post(`/v1/tasks/${taskId}/cancel`, { reason: 'drill done' })
  await waitFor(async () => (await get('/v1/status')).task == null, 15_000, 'task cancelled')

  // 5. 重连耗尽：代理彻底关闭，重试 maxReconnect 次后必须 reconnect_exhausted 且保持离线
  dropAll()
  await closeProxy()
  await waitFor(async () => {
    const status = await get('/v1/status')
    return status?.safety?.reason === 'reconnect-exhausted' || status?.pausedReason === 'reconnect-exhausted'
  }, 30_000, 'reconnect exhausted')
  const exhausted = await get('/v1/status')
  checks.reconnectExhausted = true
  checks.offlineAfterExhausted = exhausted.connected === false
  checks.pausedAfterExhausted = exhausted.paused === true
  await collectEvents()
  checks.sawReconnectExhaustedEvent = events.some((event) => event.type === 'reconnect_exhausted')
  checks.createTaskRejectedWhenOffline = false
  try {
    const rejected = await post('/v1/tasks', { kind: 'mine', params: { count: 1 } })
    checks.createTaskRejectedWhenOffline = rejected.ok === false
  } catch { checks.createTaskRejectedWhenOffline = true }
} catch (error) {
  checks.error = String(error?.message ?? error)
} finally {
  try { await post('/v1/safety/stop', { reason: 'drill done' }) } catch { /* ignore */ }
  try { child.kill('SIGTERM') } catch { /* ignore */ }
  await sleep(1200)
  try { if (child.exitCode == null) child.kill('SIGKILL') } catch { /* ignore */ }
  try { await closeProxy() } catch { /* ignore */ }
  logStream.end()
}

const pass = Object.entries(checks).filter(([key]) => key !== 'error').every(([, value]) => value === true) && !checks.error
const summary = [
  '# MC body reconnect drill（真实 TCP 断线，本地代理）',
  '',
  `- run: ${out}`,
  `- upstream: ${host}:${upstreamPort} · proxy: 127.0.0.1:${proxyPort} · body http: ${base}`,
  `- bot: ${name} · maxReconnect=${maxReconnect} · base=${reconnectBaseMs}ms`,
  `- checks: ${JSON.stringify(checks, null, 2)}`,
  `- events: offline=${checks.sawOfflineEvent} reconnected=${checks.sawReconnectedEvent} reconnect_exhausted=${checks.sawReconnectExhaustedEvent}`,
  `- result: ${pass ? 'PASS' : 'FAIL'}`,
].join('\n')
fs.writeFileSync(path.join(out, 'report.md'), `${summary}\n`, 'utf8')
fs.writeFileSync(path.join(out, 'metrics.json'), JSON.stringify({ checks, events: events.length, at: new Date().toISOString() }, null, 2), 'utf8')
console.log(summary)
process.exit(pass ? 0 : 1)
