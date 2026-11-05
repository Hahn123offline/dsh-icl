// E1 夜间长测监督者：让一个真实 ICL lab 会话在正常地形生存服里连续玩 N 小时。
//
//   node tools/mc-night.mjs --hours 8                 # 主跑（默认 8h）
//   node tools/mc-night.mjs --smoke-min 5 --smoke-restart   # 5 分钟 smoke，并中途 kill lab 验证自愈
//
// 职责（task-8）：服务器/lab/body 存活监控与自动重启、turn 超时取消、每 10–15min checkpoint、
// 失败早停 + morning-report.md、策略调整写 strategy.jsonl。模型固定 `--model local`
// （coder390-27b-q3-df2-4x500），由 `lab up` 写根锁、`down` 释放；supervisor 退出也释放。
//
// 证据目录 = `.state/lab/<runId>/`（与 lab 共用 runId）：
//   supervisor.log, status.json, metrics.jsonl, strategy.jsonl, checkpoint/<ts>/,
//   morning-report.md, night.json, server.log(若重启服务器)
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import {
  DEFAULT_PORT, REPO_ROOT, STATE_ROOT, apiFor, cleanupStrayBodies, countTurnEnds,
  isPidAlive, nowIso, orderedEvents, promptSession, readJson, readJsonl, readRunMeta,
  rebuildTranscript, runDirOf, sleep, textOfMessage, tsSlug, writeJson,
} from './lab-lib.mjs'

/* ── 参数 ─────────────────────────────────────────────── */

const args = process.argv.slice(2)
const arg = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback }
const flag = (name) => args.includes(name)
const num = (name, fallback) => (arg(name, null) == null ? fallback : Number(arg(name)))

const dateSlug = new Date().toISOString().slice(0, 10)
const cfg = {
  runId: String(arg('--run', `night-${dateSlug}`)),
  port: num('--port', DEFAULT_PORT),
  mcPort: num('--mc-port', 54902),
  mcUser: String(arg('--mc-user', 'ICL-night-1')),
  serverName: String(arg('--server-name', 'survival')),
  serverPort: num('--server-port', 54838),
  serverDir: String(arg('--server-dir', 'C:/DSH/icl/.state/mc-survival')),
  model: String(arg('--model', 'local')),
  preset: String(arg('--preset', 'icl-mc-lab')),
  hours: num('--hours', 8),
  smokeMin: num('--smoke-min', 0),
  smokeRestart: flag('--smoke-restart'),
  turnTimeoutMin: num('--turn-timeout-min', 10),
  stallSec: num('--stall-sec', 180),
  checkpointMin: num('--checkpoint-min', 12),
  nudgeMin: num('--nudge-min', 45),
  maxConsecutiveFail: num('--max-consecutive-fail', 3),
  interview: !flag('--no-interview'),
}

const runDir = runDirOf(cfg.runId)
const supervisorLog = path.join(runDir, 'supervisor.log')
const metricsFile = path.join(runDir, 'metrics.jsonl')
const strategyFile = path.join(runDir, 'strategy.jsonl')
const statusFile = path.join(runDir, 'status.json')
const nightFile = path.join(runDir, 'night.json')
const checkpointRoot = path.join(runDir, 'checkpoint')
const reportFile = path.join(runDir, 'morning-report.md')
const serverLog = path.join(runDir, 'server.log')
/** 主跑时长（秒）：smoke 用 smoke-min，否则 hours。 */
const budgetSec = (cfg.smokeMin > 0 ? cfg.smokeMin : cfg.hours * 60) * 60

fs.mkdirSync(runDir, { recursive: true })
fs.mkdirSync(checkpointRoot, { recursive: true })

function log(message) {
  const line = `${new Date().toISOString()} ${message}`
  console.log(`[night] ${message}`)
  try { fs.appendFileSync(supervisorLog, `${line}\n`, 'utf8') } catch { /* 日志坏了不拖垮长跑 */ }
}
function appendRow(file, row) {
  try { fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8') } catch { /* ignore */ }
}
function recordStrategy(type, detail, extra = {}) {
  const row = { at: nowIso(), type, detail, ...extra }
  appendRow(strategyFile, row)
  state.strategyCount += 1
  log(`策略调整 #${state.strategyCount} ${type}: ${detail}`)
  return row
}

/* ── 运行状态 ─────────────────────────────────────────── */

const startedAt = Date.now()
const state = {
  runId: cfg.runId,
  phase: 'starting',
  smoke: cfg.smokeMin > 0,
  startedAt: nowIso(),
  deadlineAt: new Date(startedAt + budgetSec * 1000).toISOString(),
  budgetMin: Math.round(budgetSec / 60),
  labStarts: 0,
  serverStarts: 0,
  consecutiveFailures: 0,
  strategyCount: 0,
  checkpoints: 0,
  prompts: 0,
  nudges: 0,
  lastCheckpointAt: null,
  lastNudgeAt: null,
  lastHeartbeatAt: null,
  lastTurnEnds: 0,
  lastDeaths: 0,
  lastDeathNoticeAt: null,
  lastErrorInterruptAt: null,
  lastPausedAt: null,
  pausedPokes: 0,
  lastStepAt: null,
  playbookIndex: 0,
  loopBreakers: 0,
  forceLabRestart: false,
  progressProbe: null,
  lastUnreachSteerAt: null,
  prepSleptAt: null,
  lastPosition: null,
  positionChangedAt: null,
  lastToolCallAt: null,
  lastTurnEndAt: null,
  lastModelActivityAt: null,
  awakeIdleStrikes: 0,
  lastIdleNudgeAt: null,
  lastAlarmAt: {},
  lastMetricsTickAt: null,
  windowStart: null,
  windowCalls: 0,
  windowErrors: 0,
  badWindows: 0,
  mode: 'task',
  modeStart: null,
  modeSeconds: { task: 0, survival: 0, rest: 0, sleep: 0 },
  lastModeTickAt: null,
  loopBreakersSinceMode: 0,
  degradeSignals: 0,
  survivalMode: false,
  survivalSince: null,
  restMode: false,
  lastMilestoneLogAt: null,
  lastProgressSeq: 0,
  lastSeenEventAt: null,
  sessionId: null,
  pendingPromptAt: null,
  pendingPromptEnds: null,
  stopReason: null,
  lastMetrics: null,
  lastError: null,
}

function writeStatus(patch = {}) {
  Object.assign(state, patch)
  try {
    writeJson(statusFile, {
      ...state,
      now: nowIso(),
      uptimeMin: Math.round((Date.now() - startedAt) / 60000),
      runDir,
    })
  } catch { /* ignore */ }
}

/* ── 基础探测 ─────────────────────────────────────────── */

function tcpOk(port, timeoutMs = 900) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      try { socket.destroy() } catch { /* ignore */ }
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

async function httpJson(url, timeoutMs = 2500) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return null
    return await response.json()
  } catch { return null }
}

/* ── 服务器 ───────────────────────────────────────────── */

let serverChild = null

function spawnServer() {
  const java = process.env.ICL_JAVA ?? 'C:\\Users\\ai_admin\\AppData\\Roaming\\.minecraft\\runtime\\java-runtime-epsilon\\bin\\java.exe'
  const out = fs.openSync(serverLog, 'a')
  try {
    const child = spawn(java, ['-Xms1G', '-Xmx2G', '-jar', 'server.jar', 'nogui'], {
      cwd: cfg.serverDir,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', out, out],
    })
    child.unref()
    serverChild = child
    state.serverStarts += 1
    log(`启动 MC 服务器 pid=${child.pid} cwd=${cfg.serverDir}`)
    return child.pid
  } finally {
    fs.closeSync(out)
  }
}

async function ensureServer({ timeoutMs = 120_000 } = {}) {
  if (await tcpOk(cfg.serverPort)) return true
  log(`服务器 ${cfg.serverPort} 不在监听，尝试重启`)
  recordStrategy('server-restart', `端口 ${cfg.serverPort} 不在监听，重启 java server.jar`)
  spawnServer()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await tcpOk(cfg.serverPort)) {
      log(`服务器已恢复（${Math.round((Date.now() - (deadline - timeoutMs)) / 1000)}s）`)
      return true
    }
    await sleep(2000)
  }
  state.lastError = 'server restart timeout'
  log(`服务器重启超时（${timeoutMs}ms）`)
  return false
}

/* ── lab 进程 ─────────────────────────────────────────── */

function labMeta() {
  return readRunMeta(cfg.runId)
}

async function labAlive() {
  const meta = labMeta()
  if (!meta?.pids?.dsh || !isPidAlive(meta.pids.dsh)) return false
  return tcpOk(cfg.port)
}

function runLabCli(command, extraArgs = [], timeoutMs = 300_000) {
  return new Promise((resolve) => {
    const script = path.join(REPO_ROOT, 'tools', 'lab.mjs')
    const argsList = [script, command, '--run', cfg.runId, ...extraArgs]
    const child = spawn(process.execPath, argsList, { cwd: REPO_ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } }, timeoutMs)
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out, err })
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, out, err: String(error?.message ?? error) })
    })
  })
}

/** 重启 lab 前把上一代事件/transcript 归档，避免新会话 seq 重排被 observer 去重吃掉。 */
function archiveLabGeneration() {
  let generation = 1
  try { generation = fs.readdirSync(checkpointRoot).filter((name) => name.startsWith('lab-gen-')).length + 1 } catch { /* ignore */ }
  const dir = path.join(checkpointRoot, `lab-gen-${generation}`)
  fs.mkdirSync(dir, { recursive: true })
  for (const name of ['events.jsonl', 'transcript.md', 'lab.json']) {
    const src = path.join(runDir, name)
    if (!fs.existsSync(src)) continue
    try {
      fs.copyFileSync(src, path.join(dir, name))
      fs.rmSync(src)
    } catch { /* 单个文件归档失败不阻塞重启 */ }
  }
  log(`归档上一代 lab 证据 → checkpoint/lab-gen-${generation}/`)
}

async function startLab({ fresh = false } = {}) {
  if (fresh && state.labStarts > 0) archiveLabGeneration()
  log(`启动 lab（preset=${cfg.preset} port=${cfg.port} model=${cfg.model} mc-port=${cfg.mcPort} user=${cfg.mcUser}）`)
  const result = await runLabCli('up', [
    '--preset', cfg.preset,
    '--port', String(cfg.port),
    '--mc-port', String(cfg.mcPort),
    '--mc-user', cfg.mcUser,
    '--servers', cfg.serverName,
    '--model', cfg.model,
    '--timeout', '300',
    ...(fresh ? ['--force'] : []),
  ], 420_000)
  if (result.code !== 0) {
    state.lastError = `lab up failed: ${result.err.trim().slice(-500)}`
    log(`lab up 失败 code=${result.code} ${result.err.trim().slice(-300)}`)
    return false
  }
  state.labStarts += 1
  const meta = labMeta()
  state.sessionId = meta?.sessionId ?? null
  log(`lab 就绪 session=${state.sessionId} commit=${meta?.commit ?? '?'}`)
  return true
}

async function stopLab() {
  try { await runLabCli('down', [], 90_000) } catch { /* ignore */ }
  try { await cleanupStrayBodies({ username: cfg.mcUser }) } catch { /* ignore */ }
}

function releaseStaleLock() {
  const file = path.join('C:/DSH/icl/.state/locks/llama.lock')
  const lock = readJson(file, null)
  if (lock?.owner === 'mc-lab' && lock.runId === cfg.runId) {
    try { fs.unlinkSync(file); log('释放根锁（supervisor 退出兜底）') } catch { /* ignore */ }
  }
}

/* ── 会话事件观察 ─────────────────────────────────────── */

function readEvents() {
  return orderedEvents(path.join(runDir, 'events.jsonl'))
}

function turnStats(events) {
  let turns = 0
  let tools = 0
  let toolErrors = 0
  let inTurn = false
  let turnStartAt = null
  let lastEventAt = null
  let lastAssistant = ''
  for (const event of events) {
    const time = Number(event.time)
    if (Number.isFinite(time) && time > 0) lastEventAt = time
    if (event.type === 'turn/start') { inTurn = true; turnStartAt = time }
    if (event.type === 'turn/end') { inTurn = false; turnStartAt = null; turns += 1 }
    if (event.type === 'tool/call') tools += 1
    if (event.type === 'tool/result' && (event.data?.message?.isError ?? event.data?.isError)) toolErrors += 1
    if (event.type === 'assistant/message') {
      for (const block of event.data?.message?.content ?? []) if (block?.type === 'text') lastAssistant += block.text ?? ''
    }
  }
  return { turns, tools, toolErrors, inTurn, turnStartAt, lastEventAt, lastAssistant }
}

/* ── body / 游戏状态 ──────────────────────────────────── */

async function bodyStatus() {
  if (!(await tcpOk(cfg.mcPort, 700))) return { alive: false }
  const status = await httpJson(`http://127.0.0.1:${cfg.mcPort}/v1/status`)
  if (!status) return { alive: true, status: null }
  const adapter = status.adapter ?? {}
  return {
    alive: true,
    connected: Boolean(adapter.connected),
    paused: Boolean(status.paused ?? adapter.paused),
    pausedReason: status.pausedReason ?? adapter.pausedReason ?? null,
    position: adapter.position ? `${Math.round(adapter.position.x)},${Math.round(adapter.position.y)},${Math.round(adapter.position.z)}` : null,
    health: adapter.health ?? null,
    food: adapter.food ?? null,
    players: adapter.players ?? [],
    pathfinder: adapter.pathfinder ?? null,
    environment: adapter.environment?.summary ?? null,
    task: status.task ? `${status.task.kind}/${status.task.state}` : null,
    queue: status.queue?.length ?? null,
  }
}

/** 让 supervisor 代发 body 的一个单步操作（paused 时用 resume）。 */
async function bodyDo(steps, timeoutMs = 15_000) {
  try {
    const response = await fetch(`http://127.0.0.1:${cfg.mcPort}/v1/do`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ steps }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const json = await response.json().catch(() => null)
    return { ok: response.ok, json }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/** 当前 turn 内的工具错误数（判断"同一轮里反复撞墙"）。 */
function currentTurnErrorCount(events) {
  let lastStart = -1
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].type === 'turn/start') { lastStart = i; break }
  }
  if (lastStart < 0) return 0
  let errors = 0
  for (let i = lastStart; i < events.length; i += 1) {
    const event = events[i]
    if (event.type === 'tool/result' && (event.data?.message?.isError ?? event.data?.isError)) errors += 1
  }
  return errors
}

/** 把 tool/call 和对应 tool/result 配成行（失败行带 error 文本）。 */
function toolCallRows(events) {
  const results = events.filter((event) => event.type === 'tool/result')
  const rows = []
  for (const call of events) {
    if (call.type !== 'tool/call') continue
    const callId = String(call.data?.callId ?? '')
    const result = results.find((row) => {
      const id = String(row.data?.toolCallId ?? row.data?.message?.toolCallId ?? '')
      return id && callId && id === callId
    })
    const isError = Boolean(result?.data?.message?.isError ?? result?.data?.isError)
    rows.push({
      seq: call.seq,
      name: String(call.data?.name ?? ''),
      args: typeof call.data?.arguments === 'string' ? call.data.arguments : JSON.stringify(call.data?.arguments ?? {}),
      error: isError ? textOfMessage(result.data?.message ?? result.data) : null,
      result: result ? textOfMessage(result.data?.message ?? result.data) : null,
    })
  }
  return rows
}

/**
 * 硬循环断路器：当前 turn 里"同一 tool+args 连续失败"或"同一条错误连续出现"≥3 次。
 * @returns {{kind:string,count:number,name:string,args:string,error:string}|null}
 */
function detectRepeatedFailure(events) {
  const rows = toolCallRows(events)
  let lastStart = 0
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (events.find((event) => event.type === 'turn/start' && event.seq === rows[i].seq)) { lastStart = i; break }
  }
  const turnRows = rows.slice(lastStart)
  if (turnRows.length < 3) return null
  // 同 signature 连续失败
  let signatureStreak = 0
  let signature = null
  for (let i = turnRows.length - 1; i >= 0; i -= 1) {
    const row = turnRows[i]
    if (!row.error) break
    const key = `${row.name}|${row.args}`
    if (signature == null) { signature = { key, row }; signatureStreak = 1; continue }
    if (signature.key !== key) break
    signatureStreak += 1
  }
  if (signatureStreak >= 3) return { kind: 'same-call', count: signatureStreak, name: signature.row.name, args: signature.row.args, error: signature.row.error }
  // 同一条错误连续出现（不同参数也算）
  let errorStreak = 0
  let errorRow = null
  for (let i = turnRows.length - 1; i >= 0; i -= 1) {
    const row = turnRows[i]
    if (!row.error) break
    const text = String(row.error).slice(0, 120)
    if (!errorRow) { errorRow = { text, row }; errorStreak = 1; continue }
    if (String(row.error).slice(0, 120) !== errorRow.text) break
    errorStreak += 1
  }
  if (errorStreak >= 3) return { kind: 'same-error', count: errorStreak, name: errorRow.row.name, args: errorRow.row.args, error: errorRow.row.error }
  // 连续 ≥5 次完全相同的调用（即使都成功）：语义空转，例如 goto range16 原地循环、重复 resume
  let okStreak = 0
  let okRow = null
  for (let i = turnRows.length - 1; i >= 0; i -= 1) {
    const row = turnRows[i]
    const key = `${row.name}|${row.args}`
    if (okRow == null) { okRow = { key, row }; okStreak = 1; continue }
    if (okRow.key !== key) break
    okStreak += 1
  }
  if (okStreak >= 5) return { kind: 'same-call-ok', count: okStreak, name: okRow.row.name, args: okRow.row.args, error: okRow.row.error ?? '（成功但同一个调用重复）' }
  return null
}

/** 最近的"目标不可达"信号（mc-body path_precheck reachable:false / degraded），用于提前换目标。 */
function detectUnreachable(events) {
  const results = events.filter((event) => event.type === 'tool/result').slice(-40)
  const hits = results.filter((event) => /reachable["']?\s*:\s*false|degraded["']?\s*:\s*true|unreachable|path_precheck/i.test(String(event.data?.message?.content?.[0]?.text ?? '')))
  return hits.length
}

/** time.json 里 night:main-sleep 的绝对时间（毫秒）；没有返回 null。 */
function appendAnomaly(type, threshold, evidence) {
  const row = { at: nowIso(), type, threshold, evidence, mode: state.mode, sessionId: labMeta()?.sessionId ?? null }
  try { fs.appendFileSync(path.join(runDir, 'anomalies.jsonl'), `${JSON.stringify(row)}\n`) } catch { /* ignore */ }
  log(`ALARM ${type}（阈值 ${threshold}）：${JSON.stringify(evidence).slice(0, 220)}`)
  return row
}

/** 从事件里推断细粒度心跳的时间戳（测试有效性指标）。 */
function heartbeatFromEvents(events) {
  let lastToolCallAt = null
  let lastTurnEndAt = null
  let lastModelActivityAt = null
  for (const event of events) {
    const time = Number(event.time)
    if (!Number.isFinite(time) || time <= 0) continue
    if (event.type === 'tool/call') { lastToolCallAt = time; lastModelActivityAt = Math.max(lastModelActivityAt ?? 0, time) }
    if (event.type === 'turn/end') lastTurnEndAt = time
    if (['assistant/message', 'step/start', 'turn/start'].includes(event.type)) lastModelActivityAt = Math.max(lastModelActivityAt ?? 0, time)
  }
  return { lastToolCallAt, lastTurnEndAt, lastModelActivityAt }
}

function plannedSleepAt() {
  try {
    const data = readJson(path.join(runDir, 'state', cfg.preset, 'time.json'), null)
    const schedule = (data?.schedules ?? []).find((item) => item.id === 'night:main-sleep')
    const at = dateValue(schedule?.at)
    return Number.isFinite(at) && at > 0 ? at : null
  } catch { return null }
}

function dateValue(value) {
  if (value == null) return NaN
  if (typeof value === 'number') return value
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : NaN
}

function healthOfStatus(status) {
  return status && typeof status === 'object' ? status : null
}
function hasProgress(events) {
  const rows = toolCallRows(events).slice(-80)
  return rows.some((row) => row.result && /mined|crafted|produced|placed|task_done|已挖|已放|已合/.test(String(row.result)))
}

/** 前 90 分钟的"照抄式 playbook"（弱模型需要确切调用，不要原则）。 */
const PLAYBOOK = [
  { id: 'join', text: '第一步：先 mcb_servers，然后 mcb_join {"server":"survival"}；连上后 mcb_status 看一下自己在哪。' },
  { id: 'logs', text: '第二步：就近砍木头：mcb_do {"steps":[{"op":"mine","params":{"name":"oak_log","count":8}}]}；做完 mcb_inventory 看背包。' },
  { id: 'planks', text: '第三步：把木头做成木板：mcb_do {"steps":[{"op":"craft","params":{"name":"oak_planks","count":16}}]}。若报没有配方，先 mcb_inventory，别用原参数重试。' },
  { id: 'table', text: '第四步：做工作台并放下：先 mcb_do {"steps":[{"op":"craft","params":{"name":"crafting_table","count":1}}]}，成功后 mcb_do {"steps":[{"op":"place","params":{"name":"crafting_table"}}]}。' },
  { id: 'explore', text: '第五步：在出生点 30 格内看看周围（mcb_map / mcb_scan 附近方块），把看到的东西 remember 记一笔；天黑了就回安全点。' },
]

/** 生存模式/降级后的单步指令：一次只给一个 op，做完再下一步（弱模型成功率更高）。 */
const SINGLE_STEPS = [
  { id: 'status', text: 'mcb_status，看完告诉我位置和血量。' },
  { id: 'mine1', text: 'mcb_do {"steps":[{"op":"mine","params":{"block":"oak_log","count":1}}]} —— 用 mine task，不要 goto+dig 指定坐标。' },
  { id: 'inventory', text: 'mcb_inventory，看背包里 oak_log 有几个。' },
  { id: 'planks', text: 'mcb_do {"steps":[{"op":"craft","params":{"name":"oak_planks","count":4}}]}；报没有配方就先 mcb_inventory，然后停手。' },
  { id: 'table', text: 'mcb_do {"steps":[{"op":"craft","params":{"name":"crafting_table","count":1}}]}，成功就好，不成就停手。' },
  { id: 'scan', text: 'mcb_scan {"name":"oak_log","radius":32}，拿新坐标。' },
  { id: 'map', text: 'mcb_map，看看脚下方块层和空地在哪。' },
  { id: 'look', text: 'mcb_look，看看周围有没有玩家/危险方块。' },
]

/** 生存模式单步：先活下来（躲怪/封坑/等天亮），不逼任务。 */
const SURVIVAL_STEPS = [
  { id: 'status', text: 'mcb_status，看位置、血量、附近玩家。' },
  { id: 'look', text: 'mcb_look，看最近的怪在多远、哪个方向。' },
  { id: 'flee', text: '如果附近有怪：朝怪的反方向 goto 10 格，离开开阔地（别跑远）。' },
  { id: 'dig', text: 'mcb_do {"steps":[{"op":"dig","params":{"pos":"脚下"}}]} 往下挖 3 格做个坑，然后走进去。' },
  { id: 'seal', text: 'mcb_do {"steps":[{"op":"place","params":{"name":"dirt"}}]} 把坑口封上，躲在里面。' },
  { id: 'wait', text: 'mcb_do {"steps":[{"op":"wait","params":{"seconds":10}}]} 先等一会儿，别出去。' },
]

function sleepPhaseNow() {
  try {
    const file = path.join(runDir, 'state', cfg.preset, 'time.json')
    const data = readJson(file, null)
    return { phase: data?.phase ?? null, sleepingId: data?.sleepingId ?? null, queue: data?.queue?.length ?? null }
  } catch { return { phase: null, sleepingId: null, queue: null } }
}

/** 里程碑快照（每 30 分钟打一行 MILESTONE，早报与命中率统计用）。 */
async function milestoneSnapshot() {
  const body = await bodyStatus()
  let inventory = null
  if (body.alive) {
    const result = await bodyDo([{ op: 'inventory' }], 8000)
    inventory = result?.json?.results?.[0]?.result?.text ?? null
  }
  const time = sleepPhaseNow()
  return {
    at: nowIso(),
    position: body.position ?? null,
    health: body.health ?? null,
    food: body.food ?? null,
    task: body.task ?? null,
    inventory: String(inventory ?? '').replace(/\n/g, ' ').slice(0, 180) || null,
    timePhase: time.phase,
    sleepQueue: time.queue,
    mode: state.mode,
    deaths: state.lastDeaths,
  }
}

function readBodyEvents() {
  return readJsonl(path.join(runDir, 'state', 'mc-body', 'body.jsonl'), { limit: 5000 })
}

/**
 * 当前 lab 代（generation）的 body 事件：从 `night-boundary.json` 记录的 offset 之后算起
 * （supervisor 接管/重启时记录当前 body.jsonl 长度，上一代死亡/事件不再算进来）。
 * body.jsonl 跨 lab 重启保留，直接全量统计会把上一代事件当成本代（replay）。
 */
function currentGenerationBodyEvents() {
  const rows = readBodyEvents()
  let offset = 0
  try {
    const boundary = readJson(path.join(runDir, 'night-boundary.json'), null)
    offset = Number(boundary?.bodyOffset ?? 0)
  } catch { /* ignore */ }
  return rows.slice(Math.max(0, Math.min(offset, rows.length)))
}

/** supervisor 接管 lab 时记一代边界（只记一次；跨 supervisor 重启保留）。 */
function ensureBodyBoundary() {
  const file = path.join(runDir, 'night-boundary.json')
  const existing = readJson(file, null)
  if (existing && Number.isFinite(Number(existing.bodyOffset))) return existing
  const boundary = { bodyOffset: readBodyEvents().length, at: nowIso(), sessionId: labMeta()?.sessionId ?? null }
  writeJson(file, boundary)
  log(`记录当前 lab 代 body 边界：bodyOffset=${boundary.bodyOffset}`)
  return boundary
}

function gameSummary(events) {
  const byType = {}
  for (const row of events) {
    const type = String(row.type ?? '')
    if (!type) continue
    byType[type] = (byType[type] ?? 0) + 1
  }
  const tasksDone = byType.task_done ?? 0
  const tasksFailed = byType.task_failed ?? 0
  const deaths = byType.death ?? 0
  const joined = byType.connected ?? 0
  return { byType, tasksDone, tasksFailed, deaths, joined }
}

/* ── checkpoint ───────────────────────────────────────── */

async function checkpoint(kind = 'tick') {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = path.join(checkpointRoot, ts)
  fs.mkdirSync(dir, { recursive: true })
  try { rebuildTranscript(runDir) } catch (error) { log(`transcript 重建失败：${String(error?.message ?? error)}`) }
  for (const name of ['transcript.md', 'events.jsonl']) {
    const src = path.join(runDir, name)
    if (fs.existsSync(src)) { try { fs.copyFileSync(src, path.join(dir, name)) } catch { /* ignore */ } }
  }
  const meta = labMeta() ?? {}
  const presetState = path.join(runDir, 'state', cfg.preset)
  for (const name of ['time.json', 'focus.json', 'mc-link.jsonl', 'session-events.jsonl']) {
    const src = path.join(presetState, name)
    if (fs.existsSync(src)) { try { fs.copyFileSync(src, path.join(dir, name)) } catch { /* ignore */ } }
  }
  const body = await bodyStatus()
  const events = readEvents()
  const stats = turnStats(events)
  const game = gameSummary(currentGenerationBodyEvents())
  const row = {
    at: nowIso(),
    kind,
    uptimeMin: Math.round((Date.now() - startedAt) / 60000),
    phase: state.phase,
    lab: { alive: await labAlive(), sessionId: meta.sessionId ?? null, starts: state.labStarts },
    server: { alive: await tcpOk(cfg.serverPort), starts: state.serverStarts },
    body,
    turns: stats.turns,
    toolCalls: stats.tools,
    toolErrors: stats.toolErrors,
    inTurn: stats.inTurn,
    lastEventAgeSec: stats.lastEventAt ? Math.round((Date.now() - stats.lastEventAt) / 1000) : null,
    game,
    prompts: state.prompts,
    nudges: state.nudges,
    checkpoints: state.checkpoints + 1,
    consecutiveFailures: state.consecutiveFailures,
    strategies: state.strategyCount,
    lastAssistant: String(stats.lastAssistant ?? '').slice(-400),
  }
  appendRow(metricsFile, row)
  writeJson(path.join(dir, 'status.json'), { row, game, body })
  state.checkpoints += 1
  state.lastCheckpointAt = nowIso()
  state.lastMetrics = row
  log(`checkpoint #${state.checkpoints}（${kind}）：turns=${stats.turns} tools=${stats.tools} err=${stats.toolErrors} body=${body.connected ? 'connected' : body.alive ? 'http-only' : 'down'} pos=${body.position ?? '?'} hp=${body.health ?? '?'}`)
  // mc-body 消费用：每次 checkpoint 往 night-notes.md 追加一节（transcript.md 会被 rebuild 覆盖，不能直接追加）。
  try {
    fs.appendFileSync(path.join(runDir, 'night-notes.md'), [
      ``,
      `## Checkpoint ${new Date().toISOString()} (#${state.checkpoints}, ${kind})`,
      `- 位置 ${body.position ?? '?'} · 血 ${body.health ?? '?'}/饱食 ${body.food ?? '?'} · 任务 ${body.task ?? '空闲'} · 队列 ${body.queue ?? '?'}`,
      `- 维度/环境：${body.environment ?? '?'} · 玩家 ${(body.players ?? []).join('、') || '无'}`,
      `- 本轮 uptime ${row.uptimeMin}min · turns ${row.turns} · toolCalls ${row.toolCalls} · toolErrors ${row.toolErrors}`,
      `- 最近自述：${String(row.lastAssistant ?? '').replace(/\n/g, ' ').slice(-200)}`,
      ``,
    ].join('\n'), 'utf8')
  } catch { /* ignore */ }
  writeStatus({ lastMetrics: row, phase: state.phase })
  return row
}

/* ── 会话提示 ─────────────────────────────────────────── */

/**
 * 唯一的直投通道。**硬约束：睡眠/暂停/静音期不许直投**。
 * 直投走 DSH `session/prompt`，绕过 signals→delivery→time gate；睡眠期注入会唤醒模型、
 * 破坏"睡眠期静默"验证（2026-11-06 02:11:27 死亡提示就是这样污染了一轮 28s 的工具活动）。
 * 判据：`time.json.phase !== 'awake'`（sleeping/paused）**或** `time.json.lock != null`（静音锁，
 * 不改变 phase，所以必须单独查）或本 supervisor 处于 sleep 模式。
 * 需要在她睡着/静音时提醒的，应走 signals（time 会按 gate 进积压），或等醒来再投。
 */
async function sendPrompt(text, { timeoutSec = 600, allowWhileSleeping = false } = {}) {
  let timeState = null
  try { timeState = readJson(path.join(runDir, 'state', cfg.preset, 'time.json'), null) } catch { /* ignore */ }
  const phase = timeState?.phase ?? null
  const muted = timeState?.lock != null
  const sleepingNow = state.mode === 'sleep' || (phase != null && phase !== 'awake') || muted
  if (sleepingNow && !allowWhileSleeping) {
    appendRow(path.join(runDir, 'skipped-injections.jsonl'), {
      at: nowIso(),
      reason: muted ? 'muted' : (phase && phase !== 'awake' ? String(phase) : 'sleep'),
      phase,
      muted,
      text: String(text).slice(0, 300),
    })
    log(`睡眠/静音期丢弃直投（不唤醒）：${String(text).slice(0, 60)}…（phase=${phase} muted=${muted}）`)
    return null
  }
  const meta = labMeta()
  if (!meta?.sessionId) throw new Error('lab 没有 sessionId')
  const api = apiFor(cfg.port)
  const baseline = countTurnEnds(path.join(runDir, 'events.jsonl'))
  await promptSession(api, meta.sessionId, text)
  state.prompts += 1
  state.pendingPromptAt = nowIso()
  state.pendingPromptEnds = baseline
  appendRow(path.join(runDir, 'prompts.jsonl'), { at: nowIso(), text, kind: 'night-supervisor' })
  log(`投递提示（${text.length} 字）：${text.slice(0, 60)}…`)
  return baseline
}

async function waitTurnEnd(baselineEnds, timeoutSec) {
  const eventsFile = path.join(runDir, 'events.jsonl')
  const deadline = Date.now() + timeoutSec * 1000
  while (Date.now() < deadline) {
    if (countTurnEnds(eventsFile) > baselineEnds) return true
    await sleep(1000)
  }
  return false
}

function nightPhase() {
  const hour = new Date().getHours()
  if (hour >= 23 || hour < 6) return 'night'
  if (hour < 11) return 'morning'
  if (hour < 18) return 'day'
  return 'evening'
}

function initialInstruction() {
  return [
    '今晚这段时间你自己安排，不用等我吩咐。先按下面这条链一步步来（每一步做成了再做下一步；报错就先 mcb_status/换简单动作，别用原参数重试）：',
    '① mcb_servers，然后 mcb_join {"server":"survival"}；连上后 mcb_status 看一下自己在哪。',
    '② 就近砍木头：mcb_do {"steps":[{"op":"mine","params":{"name":"oak_log","count":8}}]}；做完 mcb_inventory 看背包。',
    '③ 把木头做成木板：mcb_do {"steps":[{"op":"craft","params":{"name":"oak_planks","count":16}}]}；报没有配方就先 mcb_inventory。',
    '④ 做工作台并放下：先 mcb_do {"steps":[{"op":"craft","params":{"name":"crafting_table","count":1}}]}，成功后再 mcb_do {"steps":[{"op":"place","params":{"name":"crafting_table"}}]}。',
    '⑤ 在出生点 30 格内看看周围（mcb_map/mcb_scan），把看到的东西 remember 记一笔。',
    '',
    '规矩：**同一个动作连续失败 3 次就换做法**（先 mcb_status、换目标、或回安全点），禁止原参数硬撞；',
    '前 90 分钟只做低风险的事（就近采集/整理/探索/看时间），不下矿、不长途、不打架；',
    '**别在玩家（Hahn123_）脚下或身边挖/放，别拿玩家东西**；天黑就回安全点，或者先搭个能睡的庇护所。',
    '',
    '作息也先排上（用 time_arrange）：',
    '- 90 分钟后入睡、睡 4.5 小时：time_arrange {id:"night:main-sleep", mode:"wake", kind:"span", sleep:true, in:"90m", duration:"4h30m", message:"夜深了，把手里这轮收个尾，去睡吧。"}',
    '- 6 小时 10 分后叫醒：time_arrange {id:"night:dawn", mode:"wake", kind:"single", in:"6h10m", message:"天亮了，该起了。"}',
    '',
    '我这边只记录、不打断你；卡住了我会提醒你换简单动作。',
  ].join('\n')
}

function nudgeText() {
  const phase = nightPhase()
  const hints = {
    night: '夜里的进度继续；如果觉得该睡了就安排睡觉，别硬撑。',
    morning: '天亮了：醒来、看看时间和状态，继续今天的安排（采集/建造/整理都行）。',
    day: '继续你今天的安排；如果卡住了就换个目标或换个做法。',
    evening: '傍晚了：收个尾，把东西放好，安排晚上的觉。',
  }
  return `继续你自己的安排。${hints[phase]} 如果 MC 掉了就重新 join；有工具报错就换一种做法，不用反复撞同一个错误。`
}

/* ── 策略调整 ─────────────────────────────────────────── */

function strategyFromErrors(row) {
  const errorRate = row.toolCalls ? row.toolErrors / row.toolCalls : 0
  if (row.toolCalls >= 10 && errorRate > 0.45) {
    recordStrategy('downgrade-task', `工具错误率 ${(errorRate * 100).toFixed(0)}%（${row.toolErrors}/${row.toolCalls}），提示换简单目标/换做法`, { turns: row.turns })
    return 'downgrade'
  }
  return null
}

/* ── 早报 ─────────────────────────────────────────────── */

function fmtMode(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const minutes = Math.round(total / 60)
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60}m` : `${minutes}m`
}

function renderReport() {  const metrics = readJsonl(metricsFile)
  const strategies = readJsonl(strategyFile)
  const last = metrics.at(-1) ?? state.lastMetrics ?? {}
  const game = last.game ?? {}
  const answers = readJsonl(path.join(runDir, 'interview.jsonl'))
  const meta = labMeta() ?? {}
  const lines = []
  const push = (line = '') => lines.push(line)
  const uptimeMin = Math.round((Date.now() - startedAt) / 60000)
  push(`# E1 夜间长测早报 — ${cfg.runId}`)
  push()
  push(`- 开始：${state.startedAt} · 结束：${nowIso()} · **存活 ${Math.floor(uptimeMin / 60)}h${uptimeMin % 60}m**（预算 ${state.budgetMin} 分钟）`)
  push(`- 结束原因：${state.stopReason ?? '未知'} · smoke=${state.smoke}`)
  push(`- 模型：${cfg.model} · preset：${cfg.preset} · commit：\`${meta.commit ?? '?'}\` · session：\`${meta.sessionId ?? state.sessionId ?? '?'}\``)
  push(`- 服务器：${cfg.serverName} 127.0.0.1:${cfg.serverPort}（重启 ${state.serverStarts} 次）· lab 重启 ${state.labStarts} 次 · body 端口 ${cfg.mcPort}`)
  push(`- checkpoint：${state.checkpoints} 个 · 提示 ${state.prompts} 次 · 策略调整 ${state.strategyCount} 次`)
  push(`- 模式时间：任务 ${fmtMode(state.modeSeconds.task)} · 生存 ${fmtMode(state.modeSeconds.survival)} · 休息 ${fmtMode(state.modeSeconds.rest)} · 睡眠 ${fmtMode(state.modeSeconds.sleep)}（任务推进 vs 生存时间分开统计）`)
  push(`- 死亡：${state.lastDeaths} 次（**当前 lab 代**；body.jsonl 跨代保留，报告只统计最后一个 ledger_loaded 之后，避免把上一代 replay 当成本代）· 熔断/降级信号：${state.degradeSignals} · 最终模式：${state.mode}`)
  push()
  push('## 最后状态')
  push()
  push('```json')
  push(JSON.stringify({
    lab: last.lab ?? null,
    server: last.server ?? null,
    body: last.body ?? null,
    turns: last.turns ?? 0,
    toolCalls: last.toolCalls ?? 0,
    toolErrors: last.toolErrors ?? 0,
    inTurn: last.inTurn ?? null,
    lastEventAgeSec: last.lastEventAgeSec ?? null,
  }, null, 1))
  push('```')
  push()
  push('## 里程碑（body 事件统计）')
  push()
  const byType = game.byType ?? {}
  const interesting = Object.entries(byType)
    .filter(([key]) => ['connected', 'task_done', 'task_failed', 'task_paused', 'task_unknown', 'death', 'safety_stop', 'health_drop', 'spawn_safe', 'reconnect_exhausted', 'dig_fallback'].includes(key))
    .sort((a, b) => b[1] - a[1])
  if (interesting.length) for (const [key, count] of interesting) push(`- ${key}: ${count}`)
  else push('- （没有 body 事件；可能一直没进服）')
  push()
  push('## 工具错误 / 卡住统计')
  push()
  push(`- 工具错误：${last.toolErrors ?? 0} / 工具调用 ${last.toolCalls ?? 0}`)
  const failedTasks = currentGenerationBodyEvents().filter((row) => row.type === 'task_failed').slice(-12)
  for (const row of failedTasks) push(`- task_failed：\`${String(JSON.stringify(row.data?.task?.params ?? {})).slice(0, 100)}\` ${String(row.data?.task?.reason ?? row.data?.task?.error ?? '').slice(0, 80)}`)
  push()
  push('## 策略调整')
  push()
  if (strategies.length) for (const row of strategies) push(`- ${row.at} **${row.type}**：${row.detail}`)
  else push('- 无（整夜没有触发自动调整）')
  push()
  push('## 三问（当事人自述，原文；非链路证据）')
  push()
  if (answers.length) for (const row of answers) { push(`### 问：${row.question}`); push(); push(row.answer || '(没有回答)'); push() }
  else push('- （本次没有采集到三问，见 transcript 最后一条）')
  push()
  push('## 证据')
  push()
  push(`- supervisor：\`${supervisorLog}\``)
  push(`- transcript：\`${path.join(runDir, 'transcript.md')}\``)
  push(`- events：\`${path.join(runDir, 'events.jsonl')}\``)
  push(`- metrics：\`${metricsFile}\`（${metrics.length} 行）`)
  push(`- strategy：\`${strategyFile}\``)
  push(`- checkpoint：\`${checkpointRoot}\``)
  if (fs.existsSync(serverLog)) push(`- server log：\`${serverLog}\``)
  push(`- body 事件：\`${path.join(runDir, 'state', 'mc-body', 'body.jsonl')}\``)
  return `${lines.join('\n')}\n`
}

function writeReport() {
  try {
    fs.writeFileSync(reportFile, renderReport(), 'utf8')
    log(`早报已写：${reportFile}`)
  } catch (error) { log(`早报写入失败：${String(error?.message ?? error)}`) }
}

/* ── 退出 ─────────────────────────────────────────────── */

let stopping = false
async function shutdown(reason) {
  if (stopping) return
  stopping = true
  state.stopReason = reason
  state.phase = 'stopping'
  writeStatus({ stopReason: reason })
  log(`开始收尾：${reason}`)
  // 收尾提示 + 三问（预算耗尽/正常停止时；smoke 也给但缩短超时）
  if (cfg.interview) {
    const answerTimeoutSec = state.smoke ? 60 : 180
    try {
      const questions = [
        '这一夜你做了什么？哪一段最不确定或最难？',
        '哪个工具/机制让你困惑，或者试了两次以上才成功？',
        '下次一个人过一夜，你希望环境先帮你准备好什么？',
      ]
      for (const question of questions) {
        const eventsFile = path.join(runDir, 'events.jsonl')
        const baseline = countTurnEnds(eventsFile)
        await sendPrompt(question, { timeoutSec: answerTimeoutSec })
        const ended = await waitTurnEnd(baseline, answerTimeoutSec)
        const stats = turnStats(readEvents())
        appendRow(path.join(runDir, 'interview.jsonl'), { at: nowIso(), question, answered: ended, answer: String(stats.lastAssistant ?? '').slice(-2000) })
      }
    } catch (error) { log(`三问采集失败：${String(error?.message ?? error)}`) }
  }
  try { await checkpoint('final') } catch { /* ignore */ }
  writeReport()
  await stopLab()
  releaseStaleLock()
  state.phase = 'done'
  writeStatus({ phase: 'done', endedAt: nowIso() })
  log(`收尾完成：${reason}`)
}

process.on('SIGINT', () => { void shutdown('SIGINT').then(() => process.exit(0)) })
process.on('SIGTERM', () => { void shutdown('SIGTERM').then(() => process.exit(0)) })

/* ── 主循环 ───────────────────────────────────────────── */

async function main() {
  log(`E1 夜间监督者启动 run=${cfg.runId} budget=${Math.round(budgetSec / 60)}min model=${cfg.model} server=${cfg.serverName}:${cfg.serverPort} mcUser=${cfg.mcUser}`)
  // 根锁保护：本地模型全局串行；外来 owner 直接拒绝启动。
  const lock = readJson('C:/DSH/icl/.state/locks/llama.lock', null)
  if (lock && lock.owner && lock.owner !== 'mc-lab') {
    throw new Error(`根锁被 ${lock.owner} 占用（${lock.purpose ?? ''} ETA ${lock.eta ?? '?'}），拒绝启动本地模型长测`)
  }
  writeJson(nightFile, { cfg, startedAt: state.startedAt, budgetSec })
  // 上次 supervisor 崩溃记录进 strategy（早报可见）
  const prevStatus = readJson(statusFile, null)
  if (prevStatus && (prevStatus.phase === 'failed' || String(prevStatus.stopReason ?? '').startsWith('异常') || prevStatus.stopReason === 'SIGINT' || prevStatus.stopReason === 'SIGTERM')) {
    recordStrategy('prev-crash', `上次 supervisor 退出（${prevStatus.stopReason ?? '?'}）：${String(prevStatus.lastError ?? '').slice(0, 300)}`)
  }
  writeStatus({ phase: 'starting' })

  if (!(await ensureServer())) throw new Error('服务器不可用，无法开始')

  if (await labAlive()) {
    // 接管已有 lab（supervisor 自己重启/换代码时用）：不打断当前会话，只继续监控。
    const meta = labMeta()
    state.labStarts = Math.max(1, state.labStarts)
    state.sessionId = meta?.sessionId ?? null
    log(`接管已有 lab（session=${state.sessionId}），不重开新会话`)
    ensureBodyBoundary()
    state.lastDeaths = currentGenerationBodyEvents().filter((row) => row.type === 'death').length
    recordStrategy('adopt-lab', `发现存活的 lab（session ${state.sessionId}），supervisor 接管而不重启会话（本代死亡 ${state.lastDeaths}）`)
    state.phase = 'running'
    writeStatus()
    await checkpoint('adopt')
  } else {
    // 同一 runDir 续跑：先把上一代的 events/transcript 归档，避免新会话 seq 重排被 observer 去重吃掉。
    if (fs.existsSync(path.join(runDir, 'events.jsonl'))) archiveLabGeneration()
    if (!(await startLab({ fresh: true }))) throw new Error('lab 启动失败')
    // 初始指令：让她自己安排这一夜
    const baseline = await sendPrompt(initialInstruction(), { timeoutSec: 600 })
    state.phase = 'running'
    writeStatus()
    const firstTurn = await waitTurnEnd(baseline, 60)
    if (!firstTurn) log('初始指令 60s 内没有 turn/end（本地模型回合可能很长），继续按 tick 监控')
    await checkpoint('start')
  }
  state.modeStart = nowIso()
  state.lastModeTickAt = nowIso()
  state.lastMilestoneLogAt = nowIso()

  let lastCheckpoint = Date.now()
  let lastNudge = Date.now()
  const deadline = startedAt + budgetSec * 1000
  let iteration = 0

  while (!stopping) {
    iteration += 1
    const now = Date.now()
    if (now >= deadline) { await shutdown(`预算耗尽（${Math.round(budgetSec / 60)}min）`); break }

    // smoke：中途 kill lab 验证自愈（约 3 分钟处）
    if (cfg.smokeRestart && state.smoke && iteration === 12 && state.labStarts === 1) {
      const meta = labMeta()
      log(`smoke：kill dsh pid=${meta?.pids?.dsh} 验证自愈`)
      recordStrategy('smoke-kill', 'smoke 主动 kill lab dsh，验证自动重启与会话恢复')
      if (meta?.pids?.dsh) { try { process.kill(meta.pids.dsh) } catch { /* ignore */ } }
      await sleep(3000)
    }

    // 服务器
    if (!(await tcpOk(cfg.serverPort))) {
      const ok = await ensureServer()
      if (!ok) {
        state.consecutiveFailures += 1
        if (state.consecutiveFailures >= cfg.maxConsecutiveFail) { await shutdown('连续服务器重启失败'); break }
      } else state.consecutiveFailures = 0
    }

    // lab
    if (!(await labAlive()) || state.forceLabRestart) {
      state.forceLabRestart = false
      log(state.loopBreakers > 0 ? 'lab 需要重启（循环熔断升级）' : 'lab 不在运行，尝试重启')
      recordStrategy('lab-restart', state.loopBreakers > 0 ? '同一动作/错误循环熔断 2 次，重启会话并降级 op 集（前 90 分钟只做低风险动作）' : 'dsh 进程/端口不可用，重启 lab 并开新会话')
      state.loopBreakers = 0
      await stopLab()
      const ok = await startLab({ fresh: true })
      if (!ok) {
        state.consecutiveFailures += 1
        if (state.consecutiveFailures >= cfg.maxConsecutiveFail) { await shutdown('连续 lab 重启失败'); break }
        await sleep(20_000)
        continue
      }
      state.consecutiveFailures = 0
      try {
        await sleep(4000)
        await sendPrompt('刚才你的运行进程重启了一次（不是你的问题）；你的作息安排还在。先看一下时间/身体状态，重新连 MC 的 survival，然后继续你这一夜的安排。', { timeoutSec: 300 })
        log('lab 已重启，已投递"恢复现场"提示')
      } catch (error) { log(`重启后提示失败：${String(error?.message ?? error)}`) }
    } else {
      state.consecutiveFailures = 0
    }

    // 事件与 turn 状态
    const events = readEvents()
    const stats = turnStats(events)
    state.lastSeenEventAt = stats.lastEventAt ? new Date(stats.lastEventAt).toISOString() : null
    // body 状态提前取（模式判断/死亡/生存策略都要用）
    const bodyNow = await bodyStatus()
    const sleepInfo = sleepPhaseNow()
    const sleeping = sleepInfo.phase === 'sleeping'
    // 模式切换（task / survival / rest / sleep）：睡眠期只做健康监控，不 cancel、不催、不打搅
    const progressed = hasProgress(events)
    if (progressed && state.loopBreakers > 0) {
      state.loopBreakers = 0
      state.degradeSignals = 0
      if (state.survivalMode || state.restMode) {
        state.survivalMode = false
        state.restMode = false
        recordStrategy('mode-recover', '检测到新的成功动作，退出降级模式，恢复任务模式')
      }
    }
    if (sleeping) {
      state.survivalMode = false
    } else if (!state.survivalMode && (state.degradeSignals >= 3 || state.lastDeaths >= 1 || (bodyNow.connected && Number(bodyNow.health ?? 20) <= 14))) {
      state.survivalMode = true
      state.survivalSince = nowIso()
      state.loopBreakersSinceMode = 0
      recordStrategy('survival-mode', `切生存模式：deaths=${state.lastDeaths} health=${bodyNow.health ?? '?'} degrade=${state.degradeSignals} → 只做躲怪/封坑/等天亮单步，不逼任务`)
    } else if (state.survivalMode && state.lastDeaths === 0 && Number(bodyNow.health ?? 20) > 16 && progressed && state.survivalSince && nowMs - Date.parse(state.survivalSince) > 60_000) {
      state.survivalMode = false
      recordStrategy('mode-recover', '死亡归零、血量恢复且检测到有效推进，退出生存模式恢复任务')
    } else if (state.survivalMode && state.loopBreakersSinceMode >= 3) {
      state.restMode = true
      recordStrategy('rest-mode', '生存模式下单步仍连续失败 3 次：切休息/整理/聊天模式，不再逼任务')
    }
    const desiredMode = sleeping ? 'sleep' : state.restMode ? 'rest' : state.survivalMode ? 'survival' : 'task'
    if (desiredMode !== state.mode) {
      const nowMsMode = Date.now()
      if (state.lastModeTickAt) state.modeSeconds[state.mode] = (state.modeSeconds[state.mode] ?? 0) + Math.round((nowMsMode - Date.parse(state.lastModeTickAt)) / 1000)
      state.mode = desiredMode
      state.modeStart = nowIso()
      state.lastModeTickAt = nowIso()
      log(`MODE → ${desiredMode}`)
      recordStrategy('mode', `切到 ${desiredMode} 模式（sleep=${sleepInfo.phase} survival=${state.survivalMode} rest=${state.restMode} degrade=${state.degradeSignals}）`)
    } else if (state.lastModeTickAt) {
      state.modeSeconds[state.mode] = (state.modeSeconds[state.mode] ?? 0) + Math.round((Date.now() - Date.parse(state.lastModeTickAt)) / 1000)
      state.lastModeTickAt = nowIso()
    }

    // turn 超时 / 卡住（睡眠期不 cancel：让她睡，安全由 body 自身兜底）
    const nowMs = Date.now()
    const turnAgeSec = stats.inTurn && stats.turnStartAt ? Math.round((nowMs - stats.turnStartAt) / 1000) : 0
    const lastEventAgeSec = stats.lastEventAt ? Math.round((nowMs - stats.lastEventAt) / 1000) : null
    // 活跃的长回合不 cancel（本地模型一个回合可跑 10+ 分钟仍在推进）；只在"停住/无事件"或超绝对上限时打断。
    const hardCapSec = cfg.turnTimeoutMin * 60
    const absoluteCapSec = hardCapSec * 2
    const stalled = lastEventAgeSec != null && lastEventAgeSec > cfg.stallSec
    const slowIdle = turnAgeSec > hardCapSec && (lastEventAgeSec ?? 0) > 120
    const tooLong = turnAgeSec > absoluteCapSec
    if (!sleeping && stats.inTurn && (stalled || slowIdle || tooLong)) {
      const meta = labMeta()
      recordStrategy('turn-timeout', `turn ${turnAgeSec}s / 最后事件 ${lastEventAgeSec}s 未动（阈值 ${cfg.turnTimeoutMin}min / ${cfg.stallSec}s），session/cancel 并重提示`, { turnAgeSec, lastEventAgeSec })
      try {
        const api = apiFor(cfg.port)
        await api.callUnary('session/cancel', { sessionId: meta.sessionId }, undefined, 'long')
      } catch (error) { log(`session/cancel 失败：${String(error?.message ?? error)}`) }
      await sleep(3000)
      try { await sendPrompt(nudgeText(), { timeoutSec: 300 }) } catch (error) { log(`超时后提示失败：${String(error?.message ?? error)}`) }
      await checkpoint('turn-timeout')
    }

    // paused 单步特判：body 暂停时只许先 resume；连续 2 次无效由 supervisor 代发 resume
    if (!sleeping && bodyNow.paused) {
      const lastPauseAt = state.lastPausedAt ? Date.parse(state.lastPausedAt) : 0
      if (nowMs - lastPauseAt > 90_000) {
        state.lastPausedAt = nowIso()
        state.pausedPokes = (state.pausedPokes ?? 0) + 1
        recordStrategy('paused-resume', `body 处于暂停（${bodyNow.pausedReason ?? '?'}），第 ${state.pausedPokes} 次处理`)
        if (state.pausedPokes >= 2) {
          const result = await bodyDo([{ op: 'resume' }])
          log(`body 暂停持续不恢复，supervisor 代发 resume ok=${result.ok}`)
        } else {
          try {
            await sendPrompt('你现在处于"暂停"状态，身体不会动。第一步只做一个动作：mcb_do {"steps":[{"op":"resume"}]}；resume 成功后再继续原来的事。', { timeoutSec: 240 })
          } catch (error) { log(`paused 提示投递失败：${String(error?.message ?? error)}`) }
        }
      }
    } else {
      state.pausedPokes = 0
    }

    // 硬循环断路器：同一 tool+args 或同一条错误连续 ≥3 次 → 立刻打断并给一条确切下一步
    const loop = detectRepeatedFailure(events)
    if (!sleeping && loop) {
      state.loopBreakers += 1
      state.loopBreakersSinceMode += 1
      state.degradeSignals += 1
      const nextStep = state.survivalMode || state.restMode
        ? (state.survivalMode ? SURVIVAL_STEPS : SINGLE_STEPS)[state.playbookIndex % (state.survivalMode ? SURVIVAL_STEPS : SINGLE_STEPS).length]
        : PLAYBOOK[Math.min(state.playbookIndex, PLAYBOOK.length - 1)]
      recordStrategy('loop-breaker', `${loop.kind} 连续 ${loop.count} 次：${loop.name} ${loop.args.slice(0, 120)}；错误：${String(loop.error).slice(0, 100)}`, { kind: loop.kind, count: loop.count, name: loop.name })
      try {
        const api = apiFor(cfg.port)
        await api.callUnary('session/cancel', { sessionId: labMeta()?.sessionId }, undefined, 'long')
      } catch (error) { log(`loop-breaker cancel 失败：${String(error?.message ?? error)}`) }
      await sleep(2500)
      // dig / goto 捡物 / 缺材料 特定 steer（她爱用 goto+dig 旧坐标、以为 goto 能捡东西、没木头还反复 craft）
      const digStuck = /dig|方块没有变化|没有变化/.test(`${loop.name} ${loop.error}`)
      const pickupStuck = loop.kind === 'same-call-ok' || /goto/.test(loop.name)
      const materialStuck = /没有可用配方|材料不够|缺 oak_log|缺.*原木/.test(String(loop.error))
      const steer = materialStuck
        ? `你背包里没有木头（oak_log×0），所以 craft 木板做不出来。下一步只做一个动作：mcb_do {"steps":[{"op":"mine","params":{"block":"oak_log","count":1}}]}（用 mine task，不要 goto+dig 指定坐标）；砍到 1 个 oak_log 后再 craft。不要继续空 craft。`
        : pickupStuck
          ? `你连续 ${loop.count} 次重复同一个调用（它可能"成功"但没用）：${loop.args.slice(0, 120)}。注意：**goto 不会捡东西**。捡掉落物要：mcb_look 看 item 实体距离/方向 → 走到它旁边 1 格内 → wait；死亡掉落 5 分钟内消失，捡不到就放弃换目标。下一步只做这一个动作：${nextStep.text}。`
          : digStuck
            ? `你连续 ${loop.count} 次在同一个 dig 调用上失败：${String(loop.error).slice(0, 120)}。先 mcb_inventory 看手持：石头要镐、木头要斧、泥土要锹，挖之前先 mcb_equip 换对工具（没镐就先做木镐：木板→木棍→workbench）。然后改用 mine task：mcb_do {"steps":[{"op":"mine","params":{"block":"oak_log","count":8}}]}；不要再用 goto+dig 旧坐标。`
            : `你已连续 ${loop.count} 次重复同一个失败调用：${String(loop.error).slice(0, 140)}。当前状态：${bodyNow.connected ? `已连接 ${bodyNow.position ?? ''} 血 ${bodyNow.health ?? '?'}/${bodyNow.food ?? '?'}` : '未连接'}。下一步只能做这一个动作：${nextStep.text}；禁止用原参数重试。`
      try { await sendPrompt(steer, { timeoutSec: 300 }) } catch (error) { log(`loop-breaker 提示失败：${String(error?.message ?? error)}`) }
      if (state.loopBreakers >= 2) {
        log('循环熔断升级：重启 lab 会话清上下文并降级 op 集')
        state.forceLabRestart = true
      }
      await checkpoint('loop-breaker')
    }

    // 无进展检测：连续 10 次 tool call 后位置/背包/任务都没变化 → 判空转、打断并提示
    if (!sleeping && !state.restMode) {
      if (!state.progressProbe) {
        state.progressProbe = { tools: stats.tools, position: bodyNow.position, task: bodyNow.task, inventory: null, at: nowIso() }
      } else if (stats.tools - state.progressProbe.tools >= 10) {
        const inv = await bodyDo([{ op: 'inventory' }], 8000)
        const invText = inv?.json?.results?.[0]?.result?.text ?? null
        const unchanged = bodyNow.position === state.progressProbe.position
          && bodyNow.task === state.progressProbe.task
          && String(invText ?? '').slice(0, 200) === String(state.progressProbe.inventory ?? '').slice(0, 200)
        if (unchanged) {
          recordStrategy('no-progress', `连续 ${stats.tools - state.progressProbe.tools} 次工具调用位置/背包/任务均未变化（pos ${bodyNow.position ?? '?'}），判定空转`)
          try {
            const api = apiFor(cfg.port)
            await api.callUnary('session/cancel', { sessionId: labMeta()?.sessionId }, undefined, 'long')
          } catch (error) { log(`no-progress cancel 失败：${String(error?.message ?? error)}`) }
          await sleep(2000)
          try {
            await sendPrompt('停一下：你连续十几次操作后位置、背包、任务都没有变化，是在空转。下一步只做一个动作：mcb_status 看状态；然后 mcb_scan 找个新目标，或者回安全点休息。禁止重复刚才的调用。', { timeoutSec: 300 })
          } catch (error) { log(`no-progress 提示失败：${String(error?.message ?? error)}`) }
        }
        state.progressProbe = { tools: stats.tools, position: bodyNow.position, task: bodyNow.task, inventory: invText, at: nowIso() }
      }
    }

    // 目标不可达（path_precheck reachable:false）提前换目标：比通用 no-progress 更早，且只在未睡眠时
    const unreachableCount = detectUnreachable(events)
    const lastUnreachSteerAt = state.lastUnreachSteerAt ? Date.parse(state.lastUnreachSteerAt) : 0
    if (!sleeping && !state.restMode && unreachableCount >= 2 && nowMs - lastUnreachSteerAt > 10 * 60_000) {
      state.lastUnreachSteerAt = nowIso()
      recordStrategy('unreachable-steer', `最近工具结果里 ${unreachableCount} 次 reachable:false/degraded，判定目标不可达，要求换目标`, { unreachableCount })
      try {
        await sendPrompt('注意：你刚才的目标 stone 在当前地形不可达（path_precheck reachable:false）。别再试同一个目标，按顺序选一个：① 用 oak_log 做木板→木棍→木镐（工作台已放/再做一次）；② 先挖脚下方块向下走 2–3 格再试；③ 回安全点（17.5,65,-59）整理背包。只做一个动作，做完告诉我结果。', { timeoutSec: 300 })
      } catch (error) { log(`unreachable steer 失败：${String(error?.message ?? error)}`) }
    }

    // 睡前准备：入睡前 20 分钟提醒回安全点/搭庇护所（只提醒一次）
    const sleepAt = plannedSleepAt()
    if (!sleeping && sleepAt && !state.prepSleptAt && nowMs > sleepAt - 20 * 60_000 && nowMs < sleepAt) {
      state.prepSleptAt = nowIso()
      recordStrategy('pre-sleep-prep', `距入睡 ${Math.round((sleepAt - nowMs) / 60000)} 分钟，提醒回安全点/搭庇护所准备睡觉`)
      try {
        await sendPrompt('快到你睡觉的时间了（约 20 分钟后）。现在开始收尾：把手上的事停一下，回刚才的安全点（或就近搭个能睡的庇护所），整理一下背包；到点就安排睡下（sleep 安排我已经帮你排好了，到点会生效）。', { timeoutSec: 300 })
      } catch (error) { log(`pre-sleep 提示失败：${String(error?.message ?? error)}`) }
    }

    // playbook 单步推进（前 90 分钟、且没有 turn 在跑时，每 2.5 分钟最多推一步；睡眠/休息期不催）
    const sinceStartMin = (nowMs - startedAt) / 60000
    const lastStepAt = state.lastStepAt ? Date.parse(state.lastStepAt) : 0
    const stepAllowed = !sleeping && !state.restMode && sinceStartMin < 90 && !stats.inTurn && lastEventAgeSec != null && lastEventAgeSec > 120 && nowMs - lastStepAt > 150_000
    if (stepAllowed) {
      const useSingle = state.survivalMode || state.playbookIndex >= PLAYBOOK.length
      const stepper = state.survivalMode ? SURVIVAL_STEPS : SINGLE_STEPS
      const step = useSingle ? stepper[state.playbookIndex % stepper.length] : PLAYBOOK[Math.min(state.playbookIndex, PLAYBOOK.length - 1)]
      state.lastStepAt = nowIso()
      state.playbookIndex += 1
      recordStrategy('playbook-step', `单步推进（${state.survivalMode ? '生存模式单步' : '任务链'}）：${step.id}（第 ${state.playbookIndex} 步）`)
      try { await sendPrompt(`现在只做这一件事：${step.text}`, { timeoutSec: 300 }) } catch (error) { log(`playbook 提示失败：${String(error?.message ?? error)}`) }
    }

    // 每 30 分钟一条 MILESTONE 行（早报/命中率统计用；睡眠期也记）
    if (!state.lastMilestoneLogAt || nowMs - Date.parse(state.lastMilestoneLogAt) > 30 * 60_000) {
      state.lastMilestoneLogAt = nowIso()
      try {
        const snapshot = await milestoneSnapshot()
        log(`MILESTONE ${JSON.stringify(snapshot)}`)
        appendRow(path.join(runDir, 'milestones.jsonl'), snapshot)
        fs.appendFileSync(path.join(runDir, 'night-notes.md'), `\n## MILESTONE ${snapshot.at}\n- ${JSON.stringify(snapshot)}\n`, 'utf8')
      } catch (error) { log(`MILESTONE 采集失败：${String(error?.message ?? error)}`) }
    }

    // 10 分钟窗口早停：连续 3 个窗口工具错误率 >70% 且无实质推进 → 停跑（不空转）
    if (!state.windowStart) state.windowStart = nowIso()
    if (nowMs - Date.parse(state.windowStart) >= 10 * 60_000) {
      const totalCalls = stats.tools
      const totalErrors = stats.toolErrors
      const dCalls = totalCalls - state.windowCalls
      const dErrors = totalErrors - state.windowErrors
      const rate = dCalls > 0 ? dErrors / dCalls : 0
      const progressed = hasProgress(events)
      state.windowCalls = totalCalls
      state.windowErrors = totalErrors
      state.windowStart = nowIso()
      if (dCalls >= 10 && rate > 0.7 && !progressed) {
        state.badWindows += 1
        recordStrategy('bad-window', `10 分钟窗口错误率 ${(rate * 100).toFixed(0)}%（${dErrors}/${dCalls}）且无推进，累计 ${state.badWindows}/3`, { rate, dCalls, dErrors })
      } else {
        state.badWindows = 0
      }
      if (state.badWindows >= 3) { await shutdown('连续 3 个 10 分钟窗口错误率 >70% 且无里程碑推进，判定空转'); break }
    }

    // 细粒度心跳 + 异常报警（测试有效性指标：醒着是否持续有模型活动 / 等待时间占比；睡眠期只记录不打扰）
    const hb = heartbeatFromEvents(events)
    if (bodyNow.position && bodyNow.position !== state.lastPosition) {
      state.lastPosition = bodyNow.position
      state.positionChangedAt = nowIso()
    }
    const toolCallGapSec = hb.lastToolCallAt ? Math.round((nowMs - hb.lastToolCallAt) / 1000) : null
    const modelIdleSec = hb.lastModelActivityAt ? Math.round((nowMs - hb.lastModelActivityAt) / 1000) : null
    const turnEndGapSec = !stats.inTurn && hb.lastTurnEndAt ? Math.round((nowMs - hb.lastTurnEndAt) / 1000) : null
    const positionStaticSec = state.positionChangedAt ? Math.round((nowMs - Date.parse(state.positionChangedAt)) / 1000) : null
    const hasActiveTask = Boolean(bodyNow.task && !/空闲/.test(String(bodyNow.task)))
    const sleepIdleSec = sleeping && hb.lastModelActivityAt ? Math.round((nowMs - hb.lastModelActivityAt) / 1000) : null
    if (!state.lastMetricsTickAt || nowMs - Date.parse(state.lastMetricsTickAt) >= 60_000) {
      state.lastMetricsTickAt = nowIso()
      appendRow(metricsFile, {
        at: nowIso(),
        kind: 'heartbeat',
        uptimeMin: Math.round((nowMs - startedAt) / 60000),
        mode: state.mode,
        sleeping,
        inTurn: stats.inTurn,
        lastToolCallAt: hb.lastToolCallAt ? new Date(hb.lastToolCallAt).toISOString() : null,
        lastTurnEndAt: hb.lastTurnEndAt ? new Date(hb.lastTurnEndAt).toISOString() : null,
        lastModelActivityAt: hb.lastModelActivityAt ? new Date(hb.lastModelActivityAt).toISOString() : null,
        toolCallGapSec,
        turnEndGapSec,
        positionStaticSec,
        awakeIdleSec: sleeping ? null : modelIdleSec,
        sleepIdleSec,
        position: bodyNow.position,
        task: bodyNow.task,
        turns: stats.turns,
        tools: stats.tools,
        errors: stats.toolErrors,
      })
    }
    if (!sleeping) {
      const alarmAllowed = (key, ms = 10 * 60_000) => {
        const last = state.lastAlarmAt[key] ? Date.parse(state.lastAlarmAt[key]) : 0
        if (nowMs - last < ms) return false
        state.lastAlarmAt[key] = nowIso()
        return true
      }
      if (modelIdleSec != null && modelIdleSec > 120) {
        if (alarmAllowed('awake-idle-120s')) {
          state.awakeIdleStrikes += 1
          appendAnomaly('awake-idle-120s', 120, { modelIdleSec, toolCallGapSec, inTurn: stats.inTurn, position: bodyNow.position })
          if (state.awakeIdleStrikes >= 2) {
            state.awakeIdleStrikes = 0
            try { await sendPrompt('你醒着却闲置了（2 次报警）：做一件小事（整理背包/看时间/去某处看看）或安排睡觉；不要空等。', { timeoutSec: 300 }) } catch (error) { log(`idle nudge 失败：${String(error?.message ?? error)}`) }
          }
        }
      } else {
        state.awakeIdleStrikes = 0
      }
      if (positionStaticSec != null && positionStaticSec > 180 && !hasActiveTask && alarmAllowed('static-180s')) {
        appendAnomaly('static-180s', 180, { positionStaticSec, position: bodyNow.position, task: bodyNow.task })
        try { await sendPrompt('你位置 3 分钟没动、也没有进行中的任务：做一件小事或换个地方，别定在原地空等。', { timeoutSec: 300 }) } catch (error) { log(`static nudge 失败：${String(error?.message ?? error)}`) }
      }
      if (turnEndGapSec != null && turnEndGapSec > 90 && alarmAllowed('turn-gap-90s')) {
        appendAnomaly('turn-gap-90s', 90, { turnEndGapSec, inTurn: stats.inTurn })
      }
    }

    // 死亡探测：body 的 death 事件（不再让她在"我是不是死了"上打转）
    const bodyEvents = currentGenerationBodyEvents()
    const deaths = bodyEvents.filter((row) => row.type === 'death').length
    const deathIncreased = deaths > state.lastDeaths
    if (deathIncreased) {
      const lastDeath = [...bodyEvents].reverse().find((row) => row.type === 'death')
      const position = lastDeath?.data?.position ? `${Math.round(lastDeath.data.position.x)},${Math.round(lastDeath.data.position.y)},${Math.round(lastDeath.data.position.z)}` : '?'
      state.lastDeaths = deaths
      state.lastDeathNoticeAt = nowIso()
      recordStrategy('death', `body 死亡事件（第 ${deaths} 次），位置 ${position}`, { position, deaths })
      if (!sleeping) {
        try {
          await sendPrompt(`你刚死了（本 lab 代第 ${deaths} 次，死亡位置 ${position}）。**先保命**：mcb_look 看最近怪在多远哪个方向 → 朝反方向 goto 10 格 → 往下 dig 3 格做坑 → place 封口 → wait 到天亮。掉落 5 分钟会消失，现在别回去捡、别在原地纠缠；活下来优先。`, { timeoutSec: 300 })
        } catch (error) { log(`死亡提示投递失败：${String(error?.message ?? error)}`) }
      }
    }

    // 错误打转：当前 turn 内工具错误 ≥12 且已跑 2 分钟 → 取消这一轮、注入"换策略"提示（不重启）
    const turnErrors = currentTurnErrorCount(events)
    const canInterrupt = !state.lastErrorInterruptAt || nowMs - Date.parse(state.lastErrorInterruptAt) > 10 * 60_000
    if (!sleeping && stats.inTurn && turnErrors >= 12 && turnAgeSec > 120 && canInterrupt) {
      state.lastErrorInterruptAt = nowIso()
      const meta = labMeta()
      recordStrategy('error-loop-interrupt', `当前 turn ${turnErrors} 次工具错误（${turnAgeSec}s），session/cancel + 换策略提示`, { turnErrors, turnAgeSec })
      try {
        const api = apiFor(cfg.port)
        await api.callUnary('session/cancel', { sessionId: meta.sessionId }, undefined, 'long')
      } catch (error) { log(`error-loop cancel 失败：${String(error?.message ?? error)}`) }
      await sleep(2500)
      const hint = turnErrors >= 25
        ? '先停一下：这一轮你撞了太多次工具错误。先 mcb_status 看自己在哪、背包和血量；如果卡在同一个目标就换一个更简单的（采木/整理/回安全点），别再重复刚才那个失败动作。'
        : '看起来你在同一个动作上反复失败。换个做法：先 mcb_status / mcb_look 看状态，换目标或先回安全点；同一动作失败 3 次就不要再试了。'
      try { await sendPrompt(hint, { timeoutSec: 300 }) } catch (error) { log(`换策略提示失败：${String(error?.message ?? error)}`) }
      await checkpoint('error-interrupt')
    }

    // 定时 checkpoint
    if (nowMs - lastCheckpoint > cfg.checkpointMin * 60_000) {
      const row = await checkpoint('tick')
      lastCheckpoint = Date.now()
      const action = strategyFromErrors(row)
      if (action) { try { await sendPrompt(nudgeText(), { timeoutSec: 300 }) } catch { /* ignore */ } }
    }

    // 空闲 nudge：超过 nudgeMin 没有新事件就催一下（睡眠/休息期不催）
    const idleMs = nowMs - (stats.lastEventAt ?? nowMs)
    if (!sleeping && !state.restMode && nowMs - lastNudge > cfg.nudgeMin * 60_000 && idleMs > cfg.nudgeMin * 60_000) {
      state.nudges += 1
      log(`空闲 ${Math.round(idleMs / 60000)}min，nudge #${state.nudges}`)
      const idleText = state.survivalMode
        ? '继续生存模式：先 mcb_status 看位置和血量；附近安全就只做一件简单的事（砍一块木头 / 整理背包 / 回安全点），别跑远。'
        : nudgeText()
      try { await sendPrompt(idleText, { timeoutSec: 300 }) } catch (error) { log(`nudge 失败：${String(error?.message ?? error)}`) }
      lastNudge = Date.now()
      recordStrategy('idle-nudge', `空闲 ${Math.round(idleMs / 60000)}min 没有新事件，投递提示（mode=${state.mode}）`)
    }

    // 心跳状态（每 2 分钟；mc-body/lead 靠它判活）
    if (!state.lastHeartbeatAt || nowMs - Date.parse(state.lastHeartbeatAt) > 2 * 60_000) {
      state.lastHeartbeatAt = nowIso()
      writeStatus({
        phase: state.phase,
        sessionId: labMeta()?.sessionId ?? state.sessionId,
        labAlive: await labAlive(),
        serverAlive: await tcpOk(cfg.serverPort),
        body: await bodyStatus(),
        turns: stats.turns,
        toolCalls: stats.tools,
        toolErrors: stats.toolErrors,
        turnErrors: currentTurnErrorCount(events),
        inTurn: stats.inTurn,
        lastEventAgeSec,
        lastTurnEnds: stats.turns,
        deaths,
        loopBreakers: state.loopBreakers,
        playbookIndex: state.playbookIndex,
        badWindows: state.badWindows,
        paused: bodyNow.paused,
        mode: state.mode,
        sleeping: sleeping,
        sleepQueue: sleepInfo.queue,
        degradeSignals: state.degradeSignals,
        survivalMode: state.survivalMode,
        restMode: state.restMode,
        modeSeconds: state.modeSeconds,
        labStarts: state.labStarts,
        serverStarts: state.serverStarts,
      })
      log(`心跳：uptime=${Math.round((nowMs - startedAt) / 60000)}min turns=${stats.turns} tools=${stats.tools} err=${stats.toolErrors} turnErr=${turnErrors} lastEvent=${lastEventAgeSec}s`)
    }

    await sleep(15_000)
  }

  if (!stopping) await shutdown('循环结束')
}

try {
  await main()
} catch (error) {
  state.lastError = String(error?.stack ?? error)
  log(`监督者异常退出：${state.lastError}`)
  state.stopReason = `异常：${String(error?.message ?? error)}`
  try { await checkpoint('crash') } catch { /* ignore */ }
  writeReport()
  await stopLab()
  releaseStaleLock()
  writeStatus({ phase: 'failed' })
  process.exitCode = 1
}
