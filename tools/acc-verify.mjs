// 清醒验收复验（最小）：first-screen（purify 后 2294±50、首行 你是小千、tools=41）+ collect 等待版 + tunnel body-task cancel ≤1s。
// 用法：node tools/acc-verify.mjs [--run acc-verify-<ts>] [--base-report <acc-0705/acc-report.md>]
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { apiFor, promptSession, readJson, readJsonl, readRunMeta, runDirOf, sleep, nowIso, tsSlug } from './lab-lib.mjs'

function arg(name, fallback = null) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback }
const runId = String(arg('--run', `acc-verify-${tsSlug()}`))
const baseReport = arg('--base-report', null)
const serverName = 'lab-normal'
const mcUser = 'ICL-acc-1'
const labPort = 57101
const mcPort = 54902
const serverPort = 54840
const serverDir = 'C:/DSH/icl/.state/mc-server-lab'
const runDir = runDirOf(runId)
fs.mkdirSync(runDir, { recursive: true })
const logFile = path.join(runDir, 'verify.log')
const reportFile = path.join(runDir, 'verify-report.md')
const results = []
function log(message) { const line = `${new Date().toISOString()} ${message}`; console.log(line); try { fs.appendFileSync(logFile, `${line}\n`) } catch { /* ignore */ } }
function record(stage, name, status, detail, evidence = {}) { results.push({ stage, name, status, detail, evidence, at: nowIso() }); log(`[${status}] ${stage}/${name}: ${detail}`) }

async function tcpOk(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = (ok) => { try { socket.destroy() } catch { /* ignore */ } resolve(ok) }
    socket.setTimeout(700, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}
async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { try { if (await fn()) return true } catch { /* retry */ } await sleep(1500) }
  log(`waitFor 超时：${label}`); return false
}
async function body(pathname, payload, timeoutMs = 20000) {
  try {
    const res = await fetch(`http://127.0.0.1:${mcPort}${pathname}`, {
      method: payload === undefined ? 'GET' : 'POST',
      headers: payload === undefined ? undefined : { 'content-type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })
    return { status: res.status, json: await res.json().catch(() => null) }
  } catch (error) { return { status: -1, error: String(error?.message ?? error) } }
}
function readEvents() {
  const file = path.join(runDir, 'events.jsonl')
  if (!fs.existsSync(file)) return []
  return readJsonl(file).map((envelope) => (envelope?.payload?.type === 'session/event' ? envelope.payload.event : null)).filter(Boolean)
}
function readBodyRows() {
  const file = path.join(runDir, 'state', 'mc-body', 'body.jsonl')
  return fs.existsSync(file) ? readJsonl(file) : []
}
function latestSystemFile() {
  const dir = path.join(runDir, 'context')
  if (!fs.existsSync(dir)) return null
  const files = fs.readdirSync(dir).filter((name) => /^system-\d+\.txt$/.test(name)).map((name) => ({ name, at: fs.statSync(path.join(dir, name)).mtimeMs })).sort((a, b) => b.at - a.at)
  return files[0] ? path.join(dir, files[0].name) : null
}
function resolveJava() {
  const candidates = [
    process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java.exe') : null,
    'C:/Users/ai_admin/AppData/Roaming/.minecraft/runtime/java-runtime-epsilon/bin/java.exe',
  ].filter(Boolean)
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate
  return 'java'
}
function labCli(sub) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join('tools', 'lab.mjs'), ...sub], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { out += chunk })
    child.on('close', (code) => resolve({ code, out }))
  })
}
async function waitTurnEnd(sinceMs, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ends = readEvents().filter((event) => event.type === 'turn/end' && Number(event.time) >= sinceMs)
    if (ends.length) return ends
    await sleep(2000)
  }
  return []
}
async function runTurn(text, label, timeoutMs = 240000) {
  const meta = readRunMeta(runId)
  const api = apiFor(labPort)
  const since = Date.now()
  log(`发送提示（${label}）：${text.slice(0, 100)}`)
  await promptSession(api, meta.sessionId, text)
  await waitTurnEnd(since, timeoutMs)
  await sleep(1500)
  return { api, sessionId: meta.sessionId, since }
}

async function main() {
  log(`=== 复验开始 run=${runId}`)
  const startedServer = !(await tcpOk(serverPort))
  if (startedServer) {
    const out = fs.openSync(path.join(runDir, 'server.log'), 'a')
    const child = spawn(resolveJava(), ['-Xms1G', '-Xmx2G', '-jar', 'server.jar', 'nogui'], { cwd: serverDir, detached: true, stdio: ['ignore', out, out], windowsHide: true })
    child.on('error', (error) => log(`server spawn error: ${String(error?.message ?? error)}`))
    child.unref()
    if (!(await waitFor(() => tcpOk(serverPort), 150000, 'server'))) throw new Error('服务器起不来')
  }
  const up = await labCli(['up', '--run', runId, '--preset', 'icl-mc-lab', '--port', String(labPort), '--mc-port', String(mcPort), '--mc-user', mcUser, '--servers', serverName, '--model', 'flash'])
  log(`lab up → ${up.code} ${up.out.slice(-200)}`)
  if (!(await waitFor(() => readRunMeta(runId)?.status === 'running', 200000, 'lab'))) throw new Error('lab 起不来')
  await sleep(12000)

  // 1) 首屏净化
  try {
    await runTurn(`先 mcb_join {"server":"${serverName}"}，然后只回一句“连上了”。`, 'join', 240000)
    const file = latestSystemFile()
    const text = file ? fs.readFileSync(file, 'utf8') : ''
    const chars = text.length
    const firstLine = text.split(/\r?\n/)[0]?.trim() ?? ''
    const header = readEvents().find((event) => event.type === 'request/header')
    const toolCount = header?.data?.header?.tools?.length ?? null
    const ok = chars >= 2244 && chars <= 2344 && /^你是小千。/.test(firstLine) && toolCount === 41
    record('1-first-screen', 'purify 后 2294±50 / 首行 你是小千。/ tools=41', ok ? 'PASS' : 'FAIL', `chars=${chars} firstLine=${JSON.stringify(firstLine.slice(0, 30))} tools=${toolCount} file=${file ? path.basename(file) : 'none'}`, { file })
  } catch (error) { record('1-first-screen', 'purify', 'FAIL', String(error?.message ?? error)) }

  // 2) collect 等待版（等 task_done / progress done=total 再断言 net）
  try {
    const cmd = 'mcb_do {"steps":[{"op":"task","kind":"collect","params":{"item":"oak_log","count":8,"radius":24}}]}'
    await runTurn(`只做一件事：${cmd} —— 发完等任务完成，不要做别的；完成后用 mcb_status 报告任务结果。`, 'collect-wait', 300000)
    const deadline = Date.now() + 180000
    let doneEvent = null
    while (Date.now() < deadline) {
      const rows = readBodyRows().filter((row) => row.type === 'task_done' || row.type === 'task_failed' || row.type === 'task_cancelled')
      doneEvent = rows.filter((row) => JSON.stringify(row).includes('"kind":"collect"') || /collect/.test(JSON.stringify(row))).at(-1) ?? null
      if (doneEvent) break
      await sleep(2500)
    }
    const text = JSON.stringify(doneEvent?.data ?? doneEvent ?? {})
    const net = text.match(/"net"\s*:\s*(\d+)/)?.[1] ?? null
    const state = doneEvent?.type ?? 'none'
    const progressRows = readBodyRows().filter((row) => row.type === 'task_progress').length
    const ok = state === 'task_done' && net != null && Number(net) >= 8
    record('2-macro', 'collect oak_log 8（等 done）', ok ? 'PASS' : 'FAIL', `state=${state} net=${net} progressEvents=${progressRows} result=${text.slice(-220)}`, { doneEvent })
  } catch (error) { record('2-macro', 'collect oak_log 8（等 done）', 'FAIL', String(error?.message ?? error)) }

  // 3) tunnel body task cancel（POST /v1/tasks/:id/cancel，断言 ≤1s 停止）
  try {
    const cmd = 'mcb_do {"steps":[{"op":"task","kind":"tunnel","params":{"direction":"south","length":24,"height":2}}]}'
    await runTurn(`只做一件事：${cmd} —— 发完不要等结果，立刻停下。`, 'tunnel-start', 120000)
    // 从 task_queued/task_started 里找 tunnel 任务（不能取"最后一条 task_progress"——那可能是已完成的 collect）
    const taskRows = readBodyRows().filter((row) => /task_queued|task_started/.test(row.type) && /"kind":"tunnel"/.test(JSON.stringify(row)))
    const taskId = taskRows.map((row) => row.data?.taskId ?? row.data?.task?.id).filter(Boolean).at(-1)
    if (!taskId) throw new Error('没有拿到 tunnel taskId')
    // 等 running 再 cancel（queued 状态 cancel 测不出 running 停止语义）
    await waitFor(() => readBodyRows().some((row) => row.type === 'task_started' && JSON.stringify(row).includes(taskId)), 60000, 'tunnel running')
    await sleep(2000)
    const beforeRows = readBodyRows()
    const cancelAt = Date.now()
    const cancelled = await body(`/v1/tasks/${taskId}/cancel`, { reason: 'acceptance strict cancel' }, 10000)
    let stopAt = null
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const stopRow = readBodyRows().filter((row) => /task_cancelled|task_interrupted/.test(row.type)).filter((row) => JSON.stringify(row).includes(taskId)).at(-1)
      if (stopRow) { stopAt = Number(stopRow.at); break }
      await sleep(100)
    }
    const latency = stopAt ? stopAt - cancelAt : null
    const ok = cancelled.status === 200 && latency != null && latency <= 1000
    record('3-macro', 'tunnel body cancel ≤1s', ok ? 'PASS' : 'FAIL', `taskId=${taskId} cancelHttp=${cancelled.status} latency=${latency}ms`, { cancelled: cancelled.json?.task ?? cancelled.json ?? null })
  } catch (error) { record('3-macro', 'tunnel body cancel ≤1s', 'FAIL', String(error?.message ?? error)) }

  // 报告 + 追加到 base report
  const pass = results.filter((row) => row.status === 'PASS').length
  const fail = results.filter((row) => row.status === 'FAIL').length
  const lines = [`# 清醒验收复验 — ${runId}`, '', `- 时间：${nowIso()} · preset icl-mc-lab（purifySections 已补）· tools=41`, `- 结果：**PASS ${pass} / FAIL ${fail}**`, '', '## 明细', ...results.map((row) => `- **${row.status}** ${row.stage}/${row.name} — ${row.detail}`), '', `原始：\`${logFile}\``]
  fs.writeFileSync(reportFile, `${lines.join('\n')}\n`)
  fs.writeFileSync(path.join(runDir, 'verify-result.json'), JSON.stringify({ runId, finishedAt: nowIso(), pass, fail, results }, null, 2))
  if (baseReport && fs.existsSync(baseReport)) {
    const section = ['', '## 复验（' + runId + '，' + nowIso() + '）', '', `preset icl-mc-lab 已补 purifySections（4 段）后复验：`, ...results.map((row) => `- **${row.status}** ${row.stage}/${row.name} — ${row.detail}`), '', `原始：\`${path.relative(process.cwd(), reportFile)}\``, '']
    fs.appendFileSync(baseReport, section.join('\n'))
    log(`已追加复验节到 ${baseReport}`)
  }
  log(`复验完成 PASS=${pass} FAIL=${fail}`)

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
main().then(() => process.exit(0)).catch(async (error) => {
  log(`复验异常：${String(error?.stack ?? error)}`)
  try { if (baseReport && fs.existsSync(baseReport)) fs.appendFileSync(baseReport, `\n## 复验（${runId}）异常\n\n\`\`\`\n${String(error?.stack ?? error)}\n\`\`\`\n`) } catch { /* ignore */ }
  try { await labCli(['down', '--run', runId]) } catch { /* ignore */ }
  process.exit(1)
})
