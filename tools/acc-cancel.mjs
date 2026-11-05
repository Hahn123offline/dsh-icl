// 严格 cancel 测试：直接给 body 下 tunnel task → 等 running → POST /v1/tasks/:id/cancel → 断言 ≤1s 停止推进。
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { readJsonl, readRunMeta, runDirOf, sleep, nowIso, tsSlug } from './lab-lib.mjs'

function arg(name, fallback = null) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback }
const runId = String(arg('--run', `acc-cancel-${tsSlug()}`))
const serverName = 'lab-normal'
const mcUser = 'ICL-acc-1'
const labPort = 57101
const mcPort = 54902
const serverPort = 54840
const serverDir = 'C:/DSH/icl/.state/mc-server-lab'
const runDir = runDirOf(runId)
fs.mkdirSync(runDir, { recursive: true })
const logFile = path.join(runDir, 'cancel.log')
function log(message) { const line = `${new Date().toISOString()} ${message}`; console.log(line); try { fs.appendFileSync(logFile, `${line}\n`) } catch { /* ignore */ } }
async function tcpOk(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = (ok) => { try { socket.destroy() } catch { /* ignore */ } resolve(ok) }
    socket.setTimeout(700, () => done(false)); socket.once('connect', () => done(true)); socket.once('error', () => done(false))
  })
}
async function body(pathname, payload, timeoutMs = 15000) {
  try {
    const res = await fetch(`http://127.0.0.1:${mcPort}${pathname}`, { method: payload === undefined ? 'GET' : 'POST', headers: payload === undefined ? undefined : { 'content-type': 'application/json' }, body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs) })
    return { status: res.status, json: await res.json().catch(() => null) }
  } catch (error) { return { status: -1, error: String(error?.message ?? error) } }
}
function labCli(sub) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join('tools', 'lab.mjs'), ...sub], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''; child.stdout.on('data', (chunk) => { out += chunk }); child.stderr.on('data', (chunk) => { out += chunk })
    child.on('close', (code) => resolve({ code, out }))
  })
}
function resolveJava() {
  const candidates = [process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java.exe') : null, 'C:/Users/ai_admin/AppData/Roaming/.minecraft/runtime/java-runtime-epsilon/bin/java.exe'].filter(Boolean)
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate
  return 'java'
}
async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { try { if (await fn()) return true } catch { /* retry */ } await sleep(500) }
  log(`waitFor 超时：${label}`); return false
}
async function main() {
  log(`=== cancel 测试开始 run=${runId}`)
  const startedServer = !(await tcpOk(serverPort))
  if (startedServer) {
    const out = fs.openSync(path.join(runDir, 'server.log'), 'a')
    const child = spawn(resolveJava(), ['-Xms1G', '-Xmx2G', '-jar', 'server.jar', 'nogui'], { cwd: serverDir, detached: true, stdio: ['ignore', out, out], windowsHide: true })
    child.on('error', (error) => log(`server spawn error: ${String(error?.message ?? error)}`))
    child.unref()
    if (!(await waitFor(() => tcpOk(serverPort), 150000, 'server'))) throw new Error('服务器起不来')
  }
  const up = await labCli(['up', '--run', runId, '--preset', 'icl-mc-lab', '--port', String(labPort), '--mc-port', String(mcPort), '--mc-user', mcUser, '--servers', serverName, '--model', 'flash'])
  log(`lab up → ${up.code}`)
  if (!(await waitFor(() => readRunMeta(runId)?.status === 'running', 200000, 'lab'))) throw new Error('lab 起不来')
  await sleep(8000)
  // body 需要 join；直接 mcb_join 由 model 做太慢，这里用 prompt 极简 join
  const meta = readRunMeta(runId)
  const { apiFor, promptSession } = await import('./lab-lib.mjs')
  await promptSession(apiFor(labPort), meta.sessionId, `先 mcb_join {"server":"${serverName}"}，连上后只回“ok”。`)
  await waitFor(async () => (await body('/v1/status')).json?.adapter?.connected === true, 120000, 'body connected')
  // 下 tunnel task
  const created = await body('/v1/do', { steps: [{ op: 'task', kind: 'tunnel', params: { direction: 'south', length: 24, height: 2 } }] }, 20000)
  const taskText = JSON.stringify(created.json ?? created)
  const taskId = taskText.match(/"(t-\d+)"/)?.[1] ?? null
  if (!taskId) throw new Error(`没拿到 taskId: ${taskText.slice(0, 200)}`)
  log(`tunnel task=${taskId}, 等 running`)
  const running = await waitFor(async () => {
    const row = readJsonl(path.join(runDir, 'state', 'mc-body', 'body.jsonl')).filter((r) => r.type === 'task_started' && JSON.stringify(r).includes(taskId)).at(-1)
    return Boolean(row)
  }, 60000, 'tunnel running')
  await sleep(1500)
  const before = readJsonl(path.join(runDir, 'state', 'mc-body', 'body.jsonl'))
  const progressBefore = before.filter((r) => r.type === 'task_progress' && JSON.stringify(r).includes(taskId)).length
  const cancelAt = Date.now()
  const cancel = await body(`/v1/tasks/${taskId}/cancel`, { reason: 'acceptance strict cancel' }, 15000)
  let stopAt = null
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const rows = readJsonl(path.join(runDir, 'state', 'mc-body', 'body.jsonl')).filter((r) => /task_cancelled|task_interrupted|task_done|task_failed/.test(r.type) && JSON.stringify(r).includes(taskId)).at(-1)
    if (rows) { stopAt = Number(rows.at); break }
    await sleep(100)
  }
  const latency = stopAt ? stopAt - cancelAt : null
  const progressAfterRows = readJsonl(path.join(runDir, 'state', 'mc-body', 'body.jsonl')).filter((r) => r.type === 'task_progress' && JSON.stringify(r).includes(taskId) && Number(r.at) > cancelAt)
  const pass = running && cancel.status === 200 && latency != null && latency <= 1000 && progressAfterRows.length === 0
  log(`[${pass ? 'PASS' : 'FAIL'}] tunnel cancel: task=${taskId} running=${running} http=${cancel.status} latency=${latency}ms progressAfterCancel=${progressAfterRows.length}`)
  fs.writeFileSync(path.join(runDir, 'cancel-result.json'), JSON.stringify({ runId, at: nowIso(), taskId, running, http: cancel.status, latency, progressBefore, progressAfterCancel: progressAfterRows.length, pass, cancelResponse: cancel.json?.task ?? cancel.json ?? null }, null, 2))
  await labCli(['down', '--run', runId]); await sleep(2000)
  if (startedServer) {
    try {
      const { execFileSync } = await import('node:child_process')
      const script = 'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match "server\\.jar" } | Select-Object -ExpandProperty ProcessId'
      const pids = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean)
      for (const pid of pids) { try { process.kill(Number(pid), 'SIGTERM') } catch { /* ignore */ } }
      log(`已停服务器 pid=${pids.join(',')}`)
    } catch (error) { log(`停服务器失败：${String(error?.message ?? error)}`) }
  }
}
main().then(() => process.exit(0)).catch((error) => { log(`cancel 测试异常：${String(error?.stack ?? error)}`); process.exit(1) })
