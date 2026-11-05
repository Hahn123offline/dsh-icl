// 清醒验收跑（30–60min）：宏 collect/tunnel+cancel、装备 needsTool/inventory/equip、sleep-safe 语义、首屏。
// 用法：node tools/acc-awake.mjs [--run acc-<ts>] [--server lab-normal] [--mc-user ICL-acc-1] [--model flash]
// 证据：<runDir>/acc.log、acc-result.json、acc-report.md；跑完自动 down lab（服务器只有本脚本启动时才停）。
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { apiFor, promptSession, readJson, readJsonl, readRunMeta, runDirOf, sleep, nowIso, tsSlug } from './lab-lib.mjs'

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const runId = String(arg('--run', `acc-${tsSlug()}`))
const serverName = String(arg('--server', 'lab-normal'))
const mcUser = String(arg('--mc-user', 'ICL-acc-1'))
const model = String(arg('--model', 'flash'))
const labPort = Number(arg('--port', 57101))
const mcPort = Number(arg('--mc-port', 54902))
const serverPort = Number(arg('--server-port', 54840))
const serverDir = String(arg('--server-dir', 'C:/DSH/icl/.state/mc-server-lab'))
const runDir = runDirOf(runId)
fs.mkdirSync(runDir, { recursive: true })
const reportFile = path.join(runDir, 'acc-report.md')
const resultFile = path.join(runDir, 'acc-result.json')
const logFile = path.join(runDir, 'acc.log')

function log(message) {
  const line = `${new Date().toISOString()} ${message}`
  console.log(line)
  try { fs.appendFileSync(logFile, `${line}\n`) } catch { /* ignore */ }
}
const results = []
function record(stage, name, status, detail = '', evidence = {}) {
  results.push({ stage, name, status, detail, evidence, at: nowIso() })
  log(`[${status}] ${stage}/${name}: ${detail}`)
}

async function tcpOk(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = (ok) => { try { socket.destroy() } catch { /* ignore */ } resolve(ok) }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}
async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { if (await fn()) return true } catch { /* retry */ }
    await sleep(2000)
  }
  log(`waitFor 超时：${label}`)
  return false
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
  return readJsonl(file)
    .map((envelope) => (envelope?.payload?.type === 'session/event' ? envelope.payload.event : null))
    .filter(Boolean)
}
function textOf(resultEvent) {
  return String(resultEvent?.data?.message?.content?.[0]?.text ?? '')
}
function toolPairs(events, sinceMs = 0) {
  const calls = events.filter((event) => event.type === 'tool/call' && Number(event.time) >= sinceMs)
  const results = events.filter((event) => event.type === 'tool/result')
  return calls.map((call) => {
    const result = results.find((row) => row.data?.toolCallId === call.data?.callId || row.data?.message?.toolCallId === call.data?.callId)
    return { name: String(call.data?.name ?? ''), args: typeof call.data?.arguments === 'string' ? call.data.arguments : JSON.stringify(call.data?.arguments ?? {}), call, result, text: textOf(result) }
  })
}
async function waitTurnEnd(sinceMs, timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const events = readEvents()
    const ends = events.filter((event) => event.type === 'turn/end' && Number(event.time) >= sinceMs)
    if (ends.length) return ends
    await sleep(2500)
  }
  return []
}
async function sendPrompt(text, label) {
  const meta = readRunMeta(runId)
  if (!meta?.sessionId) throw new Error('lab 没有 sessionId')
  const api = apiFor(labPort)
  const since = Date.now()
  log(`发送提示（${label}）：${text.slice(0, 90)}`)
  await promptSession(api, meta.sessionId, text)
  return { api, sessionId: meta.sessionId, since }
}
async function runTurn(promptText, label, timeoutMs = 300000) {
  const { api, sessionId, since } = await sendPrompt(promptText, label)
  const ends = await waitTurnEnd(since, timeoutMs)
  await sleep(3000)
  const events = readEvents()
  const pairs = toolPairs(events, since)
  return { api, sessionId, since, ends, pairs, events }
}

/* ── 生命周期 ───────────────────────────────────────── */
function resolveJava() {
  const candidates = [
    process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java.exe') : null,
    'C:/Users/ai_admin/AppData/Roaming/.minecraft/runtime/java-runtime-epsilon/bin/java.exe',
    'C:/Program Files/Java/jdk-21/bin/java.exe',
  ].filter(Boolean)
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate
  return 'java' // 交给 PATH；找不到会立刻报 ENOENT
}
async function ensureServer() {
  if (await tcpOk(serverPort)) { log(`服务器 ${serverPort} 已在监听`); return false }
  const java = resolveJava()
  log(`启动服务器：${java} -Xms1G -Xmx2G -jar server.jar nogui（cwd ${serverDir}）`)
  const out = fs.openSync(path.join(runDir, 'server.log'), 'a')
  const child = spawn(java, ['-Xms1G', '-Xmx2G', '-jar', 'server.jar', 'nogui'], { cwd: serverDir, detached: true, stdio: ['ignore', out, out], windowsHide: true })
  child.on('error', (error) => log(`server spawn error（java=${java}）：${String(error?.message ?? error)}`))
  child.unref()
  const ok = await waitFor(() => tcpOk(serverPort), 150000, '服务器端口')
  if (!ok) throw new Error('服务器没有起来')
  log('服务器已就绪')
  return true
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
async function startLab() {
  log(`启动 lab（run=${runId} preset=icl-mc-lab model=${model} server=${serverName}:${serverPort} mcUser=${mcUser}）`)
  const up = await labCli(['up', '--run', runId, '--preset', 'icl-mc-lab', '--port', String(labPort), '--mc-port', String(mcPort), '--mc-user', mcUser, '--servers', serverName, '--model', model])
  log(`lab up → code=${up.code} ${up.out.slice(-300)}`)
  const ok = await waitFor(() => {
    const meta = readRunMeta(runId)
    return meta?.status === 'running' && meta?.sessionId
  }, 200000, 'lab running')
  if (!ok) throw new Error('lab 启动失败')
  log('lab 就绪')
}
async function stopAll(startedServer) {
  try { await labCli(['down', '--run', runId]) ; log('lab down 完成') } catch (error) { log(`lab down 失败：${String(error?.message ?? error)}`) }
  await sleep(2000)
  if (startedServer) {
    log('停止本脚本启动的服务器（SIGTERM）')
    try {
      const { execFileSync } = await import('node:child_process')
      const script = 'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match "server\\.jar" } | Select-Object -ExpandProperty ProcessId'
      const pids = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean)
      for (const pid of pids) { try { process.kill(Number(pid), 'SIGTERM') } catch { /* ignore */ } }
    } catch (error) { log(`停服务器失败：${String(error?.message ?? error)}`) }
  }
}

function writeReport() {
  const pass = results.filter((row) => row.status === 'PASS').length
  const fail = results.filter((row) => row.status === 'FAIL').length
  const skip = results.filter((row) => row.status === 'SKIP').length
  const lines = [
    `# 清醒验收跑 — ${runId}`, '',
    `- 时间：${nowIso()} · 服务器 ${serverName} 127.0.0.1:${serverPort} · bot ${mcUser} · model ${model} · lab ${labPort}/body ${mcPort}`,
    `- 结果：**PASS ${pass} / FAIL ${fail} / SKIP ${skip}**（beta 未列 FAIL）`, '',
    '## 明细', '',
  ]
  for (const row of results) lines.push(`- **${row.status}** ${row.stage}/${row.name} — ${row.detail}`)
  lines.push('', '## 证据', '', `- 原始：\`${logFile}\`、\`${path.join(runDir, 'events.jsonl')}\`、\`acc-result.json\``)
  fs.writeFileSync(reportFile, `${lines.join('\n')}\n`)
  fs.writeFileSync(resultFile, JSON.stringify({ runId, startedAt: results[0]?.at ?? null, finishedAt: nowIso(), pass, fail, skip, results }, null, 2))
  log(`报告已写：${reportFile}`)
}

/* ── 主流程 ───────────────────────────────────────── */
async function main() {
  log(`=== 清醒验收跑开始 run=${runId} server=${serverName}:${serverPort} mcUser=${mcUser} model=${model}`)
  const startedServer = await ensureServer()
  await startLab()
  await sleep(15000)

  // 0) join + body 健康
  try {
    const turn = await runTurn(`先 mcb_join {"server":"${serverName}"} 连上验收服，然后 mcb_status 报告位置/血量。只做这两个动作，做完等下一步指令。`, 'join+status', 240000)
    const status = await body('/v1/status')
    const ok = status.json?.adapter?.connected === true
    record('0-join', 'join+status', ok ? 'PASS' : 'FAIL', `connected=${status.json?.adapter?.connected} pos=${JSON.stringify(status.json?.adapter?.position ?? null)} hp=${status.json?.adapter?.health ?? '?'}`, { pairs: turn.pairs.map((pair) => ({ name: pair.name, text: pair.text.slice(0, 160) })) })
  } catch (error) { record('0-join', 'join+status', 'FAIL', String(error?.message ?? error)) }

  // 1) first-screen：systemChars / 首行 / 工具数（transcript 或 request header）
  try {
    const transcript = path.join(runDir, 'transcript.md')
    let systemChars = null
    let firstLine = null
    let toolCount = null
    if (fs.existsSync(transcript)) {
      const head = fs.readFileSync(transcript, 'utf8').split('\n').slice(0, 40)
      for (const line of head) {
        const m = line.match(/system[^\d]*(\d+)[^\d]*chars?|systemChars[=:]\s*(\d+)/i)
        if (m) systemChars = Number(m[1] ?? m[2])
        const t = line.match(/tools?[=:\s]+(\d+)/i)
        if (t && toolCount == null) toolCount = Number(t[1])
        const f = line.match(/首行|first line[:：]\s*(.+)$/i)
        if (f) firstLine = f[1].trim()
      }
    }
    const events = readEvents()
    const header = events.find((event) => /request\/(header|start)/.test(event.type))
    const literal = header?.data?.systemChars ?? header?.data?.system_chars ?? null
    const tools = header?.data?.tools ?? null
    record('1-first-screen', 'systemChars/first-line/tools', (literal || systemChars) ? 'PASS' : 'SKIP', `systemChars(header)=${literal} transcript=${systemChars} tools=${Array.isArray(tools) ? tools.length : (tools ?? toolCount)}`, { firstLine })
  } catch (error) { record('1-first-screen', 'systemChars/first-line/tools', 'SKIP', String(error?.message ?? error)) }

  // 2) 宏 collect oak_log 8
  try {
    const cmd = 'mcb_do {"steps":[{"op":"task","kind":"collect","params":{"item":"oak_log","count":8,"radius":24}}]}'
    const turn = await runTurn(`接下来只做一件事：${cmd} —— 然后 mcb_status 报告任务结果；不要做别的。`, 'macro-collect', 300000)
    const collectText = turn.pairs.map((pair) => pair.text).join('\n')
    const netMatch = collectText.match(/"net"\s*:\s*(\d+)/)
    const doneMatch = /"state"\s*:\s*"done"|"task"\s*:\s*"done"|done/.test(collectText)
    const repeats = countRepeats(turn.pairs)
    const ok = (netMatch ? Number(netMatch[1]) >= 8 : false) && repeats.max <= 3
    record('2-macro', 'collect oak_log 8', ok ? 'PASS' : 'FAIL', `net=${netMatch?.[1] ?? '?'} done=${doneMatch} maxSameOpRepeat=${repeats.max} result=${collectText.slice(-200)}`, { pairs: turn.pairs.slice(-6).map((pair) => ({ name: pair.name, text: pair.text.slice(0, 200) })) })
  } catch (error) { record('2-macro', 'collect oak_log 8', 'FAIL', String(error?.message ?? error)) }

  // 3) 宏 tunnel + cancel（打断 ≤1s）
  try {
    const cmd = 'mcb_do {"steps":[{"op":"task","kind":"tunnel","params":{"direction":"east","length":24,"height":2}}]}'
    const { api, sessionId, since } = await sendPrompt(`只做一件事：${cmd} —— 发完不要等结果，立刻停下。`, 'macro-tunnel-cancel')
    await sleep(6000)
    const cancelAt = Date.now()
    try { await api.callUnary('session/cancel', { sessionId }, undefined, 'long') } catch (error) { log(`cancel 失败：${String(error?.message ?? error)}`) }
    await sleep(8000)
    const events = readEvents()
    const pairs = toolPairs(events, since)
    const last = pairs.at(-1)
    const resultAt = Number(last?.result?.time ?? 0)
    const abortText = last?.text ?? ''
    const latencyMs = resultAt ? resultAt - cancelAt : null
    const ok = /abort|cancel|中断|取消/i.test(abortText) && (latencyMs == null || latencyMs <= 1500)
    record('3-macro', 'tunnel 24 + cancel', ok ? 'PASS' : 'FAIL', `latency=${latencyMs}ms text=${abortText.slice(0, 160)}`, { pairs: pairs.slice(-4).map((pair) => ({ name: pair.name, text: pair.text.slice(0, 160) })) })
  } catch (error) { record('3-macro', 'tunnel 24 + cancel', 'FAIL', String(error?.message ?? error)) }

  // 4) 装备：inventory 新格式 / equip / needsTool 立即失败
  try {
    const inv = await body('/v1/inspect', { kind: 'inventory', params: {} })
    const invText = String(inv.json?.result?.text ?? '')
    const hasFormat = /手持/.test(invText) && /快捷栏/.test(invText)
    const equipped = await body('/v1/do', { steps: [{ op: 'equip', params: { slot: 9 } }] })
    const equipText = String(equipped.json?.result?.steps?.[0]?.result?.text ?? equipped.json?.result?.text ?? '')
    record('4-equipment', 'inventory 新格式', hasFormat ? 'PASS' : 'FAIL', invText.slice(0, 220), {})
    record('4-equipment', 'equip slot 9', equipped.status === 200 ? 'PASS' : 'FAIL', `status=${equipped.status} ${equipText.slice(0, 160)}`)
    // 手持空/非工具时挖石头：应立刻 needsTool（不走路不重试）
    const mine = await body('/v1/do', { steps: [{ op: 'mine', params: { block: 'stone', count: 1 } }] }, 30000)
    const mineText = String(mine.json?.result?.steps?.[0]?.result?.text ?? mine.json?.result?.text ?? JSON.stringify(mine.json ?? mine).slice(0, 200))
    const needsTool = /needsTool|需要镐|需要工具|缺少.*镐|当前手持/.test(mineText)
    record('4-equipment', '空手/非工具挖 stone → needsTool 立即失败', needsTool ? 'PASS' : 'FAIL', mineText.slice(0, 240), {})
  } catch (error) { record('4-equipment', 'equipment group', 'FAIL', String(error?.message ?? error)) }

  // 5) sleep-safe：time sleeping → 外部 shutdown 应 expected、不被当崩溃、不重启
  try {
    const sleepTurn = await runTurn('接下来做个睡眠语义验证：调用 time_arrange {"in":"20s","duration":"90s","sleep":true}，到点你就睡；只需要安排，不用睡。', 'arrange-sleep', 180000)
    const timeFile = path.join(runDir, 'state', 'icl-mc-lab', 'time.json')
    const slept = await waitFor(() => {
      const t = readJson(timeFile, null)
      return t?.phase === 'sleeping'
    }, 150000, 'time phase sleeping')
    record('5-sleep', 'time 进入 sleeping', slept ? 'PASS' : 'FAIL', slept ? 'phase=sleeping' : 'time.json 未见 sleeping')
    if (slept) {
      const before = readJsonl(path.join(runDir, 'state', 'icl-mc-lab', 'mc-link.jsonl')).filter((row) => row.kind === 'lifecycle')
      const shutdown = await body('/v1/shutdown', { reason: 'sleep-safe acceptance' }, 15000)
      await sleep(12000)
      const after = readJsonl(path.join(runDir, 'state', 'icl-mc-lab', 'mc-link.jsonl')).filter((row) => row.kind === 'lifecycle')
      const exitRow = after.filter((row) => row.type === 'body-exit' && !before.some((old) => old.at === row.at)).at(-1)
      const spawnRows = after.filter((row) => row.type === 'body-spawn' && !before.some((old) => old.at === row.at))
      const expected = exitRow?.exitClass?.expected === true || exitRow?.expected === true
      record('5-sleep', '外部 /v1/shutdown', shutdown.status === 200 ? 'PASS' : 'FAIL', `status=${shutdown.status} ${JSON.stringify(shutdown.json).slice(0, 120)}`)
      record('5-sleep', 'exit 归类 expected', expected ? 'PASS' : 'FAIL', JSON.stringify({ exitClass: exitRow?.exitClass ?? null, reason: exitRow?.exitInfo?.reason ?? exitRow?.reason ?? null }))
      record('5-sleep', '不自动重启', spawnRows.length === 0 ? 'PASS' : 'FAIL', `new body-spawn=${spawnRows.length}（${spawnRows.map((row) => row.pid).join(',')}）`)
      // 等醒来（duration 90s），再 mcb_join
      const woke = await waitFor(() => { const t = readJson(timeFile, null); return t?.phase === 'awake' }, 180000, 'phase awake')
      record('5-sleep', 'time 醒来', woke ? 'PASS' : 'FAIL', woke ? 'phase=awake' : 'phase 未回 awake')
      if (woke) {
        const rejoinTurn = await runTurn(`你醒了：mcb_join {"server":"${serverName}"} 重新连上，然后 mcb_status 报告位置。`, 'rejoin', 180000)
        const st = await body('/v1/status')
        record('5-sleep', '醒来 mcb_join 正常', st.json?.adapter?.connected === true ? 'PASS' : 'FAIL', `connected=${st.json?.adapter?.connected} spaw=${rejoinTurn.pairs.length}`)
      }
    }
  } catch (error) { record('5-sleep', 'sleep-safe group', 'FAIL', String(error?.message ?? error)) }

  // 6) awake-tick：turn 结束后空闲 ~150s，观察是否自检 turn/start（beta：未配置则 SKIP）
  try {
    const eventsBefore = readEvents()
    const lastEnd = Math.max(0, ...eventsBefore.filter((event) => event.type === 'turn/end').map((event) => Number(event.time)))
    const start = Date.now()
    await sleep(150000)
    const events = readEvents()
    const newTurns = events.filter((event) => event.type === 'turn/start' && Number(event.time) > Math.max(lastEnd, start))
    record('6-awake-tick', '空闲 150s 自检', newTurns.length ? 'PASS' : 'SKIP', `new turn/start=${newTurns.length}（time bridge awake-tick 若未配置则 SKIP）`)
  } catch (error) { record('6-awake-tick', '空闲 150s 自检', 'SKIP', String(error?.message ?? error)) }

  writeReport()
  await stopAll(startedServer)
  log('=== 验收跑结束')
}
function countRepeats(pairs) {
  let max = 0
  let current = 0
  let last = null
  for (const pair of pairs) {
    const key = `${pair.name}|${pair.args}`
    if (key === last) current += 1
    else { last = key; current = 1 }
    max = Math.max(max, current)
  }
  return { max }
}

main().then(() => process.exit(0)).catch(async (error) => {
  log(`验收跑异常：${String(error?.stack ?? error)}`)
  try { writeReport() } catch { /* ignore */ }
  try { await stopAll(false) } catch { /* ignore */ }
  process.exit(1)
})
