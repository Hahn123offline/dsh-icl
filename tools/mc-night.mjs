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
  const generation = state.labStarts
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

function readBodyEvents() {
  return readJsonl(path.join(runDir, 'state', 'mc-body', 'body.jsonl'), { limit: 5000 })
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
  const game = gameSummary(readBodyEvents())
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

async function sendPrompt(text, { timeoutSec = 600 } = {}) {
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
    '今晚这段时间你自己安排，不用等我吩咐。',
    '像平常一样过这一夜就行：先在出生点附近做低风险的事——采点木头、造工作台、整理背包、看看周围；',
    '天黑了就回安全的地方，或者先搭个能睡的庇护所。下矿、长途、打架这些等白天或你手上有家伙了再说。',
    '',
    '开跑后先排一下作息（用 time_arrange）：',
    '- 90 分钟后入睡、睡 4.5 小时：time_arrange {id:"night:main-sleep", mode:"wake", kind:"span", sleep:true, in:"90m", duration:"4h30m", message:"夜深了，把手里这轮收个尾，去睡吧。"}',
    '- 6 小时 10 分后叫醒：time_arrange {id:"night:dawn", mode:"wake", kind:"single", in:"6h10m", message:"天亮了，该起了。"}',
    '',
    '然后进 MC 生存服（mcb_servers 里的 survival），进去后自己决定今晚做什么。',
    '有个规矩：**同一个动作连续失败 3 次就换做法**（先 mcb_status 看状态、换目标、或先回安全点），别硬撞。',
    '做完一段可以 remember 记一笔（写具体细节）。我这边只记录，不打断你。',
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

function renderReport() {
  const metrics = readJsonl(metricsFile)
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
  const failedTasks = readBodyEvents().filter((row) => row.type === 'task_failed').slice(-12)
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
  writeStatus({ phase: 'starting' })

  if (!(await ensureServer())) throw new Error('服务器不可用，无法开始')

  if (await labAlive()) {
    log('发现已有 lab 在跑，先停掉以保证干净起点')
    await stopLab()
  }
  if (!(await startLab({ fresh: true }))) throw new Error('lab 启动失败')

  // 初始指令：让她自己安排这一夜
  const baseline = await sendPrompt(initialInstruction(), { timeoutSec: 600 })
  state.phase = 'running'
  writeStatus()
  const firstTurn = await waitTurnEnd(baseline, 60)
  if (!firstTurn) log('初始指令 60s 内没有 turn/end（本地模型回合可能很长），继续按 tick 监控')
  await checkpoint('start')

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
    if (!(await labAlive())) {
      log('lab 不在运行，尝试重启')
      recordStrategy('lab-restart', 'dsh 进程/端口不可用，重启 lab 并开新会话')
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

    // turn 超时 / 卡住
    const nowMs = Date.now()
    const turnAgeSec = stats.inTurn && stats.turnStartAt ? Math.round((nowMs - stats.turnStartAt) / 1000) : 0
    const lastEventAgeSec = stats.lastEventAt ? Math.round((nowMs - stats.lastEventAt) / 1000) : null
    if (stats.inTurn && (turnAgeSec > cfg.turnTimeoutMin * 60 || (lastEventAgeSec != null && lastEventAgeSec > cfg.stallSec))) {
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

    // 死亡探测：body 的 death 事件（不再让她在"我是不是死了"上打转）
    const bodyEvents = readBodyEvents()
    const deaths = bodyEvents.filter((row) => row.type === 'death').length
    if (deaths > state.lastDeaths) {
      const lastDeath = [...bodyEvents].reverse().find((row) => row.type === 'death')
      const position = lastDeath?.data?.position ? `${Math.round(lastDeath.data.position.x)},${Math.round(lastDeath.data.position.y)},${Math.round(lastDeath.data.position.z)}` : '?'
      state.lastDeaths = deaths
      state.lastDeathNoticeAt = nowIso()
      recordStrategy('death', `body 死亡事件（第 ${deaths} 次），位置 ${position}`, { position, deaths })
      try {
        await sendPrompt(`你刚死了一次（死亡位置 ${position}）。先 mcb_status 看现在在哪、能不能回去捡掉落；捡不到就别硬找，换个安全的目标继续。别在同一个危险点反复送死。`, { timeoutSec: 300 })
      } catch (error) { log(`死亡提示投递失败：${String(error?.message ?? error)}`) }
    }

    // 错误打转：当前 turn 内工具错误 ≥12 且已跑 2 分钟 → 取消这一轮、注入"换策略"提示（不重启）
    const turnErrors = currentTurnErrorCount(events)
    const canInterrupt = !state.lastErrorInterruptAt || nowMs - Date.parse(state.lastErrorInterruptAt) > 10 * 60_000
    if (stats.inTurn && turnErrors >= 12 && turnAgeSec > 120 && canInterrupt) {
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

    // 空闲 nudge：超过 nudgeMin 没有新 turn/end 就催一下
    const idleMs = nowMs - (stats.lastEventAt ?? nowMs)
    if (nowMs - lastNudge > cfg.nudgeMin * 60_000 && idleMs > cfg.nudgeMin * 60_000) {
      state.nudges += 1
      log(`空闲 ${Math.round(idleMs / 60000)}min，nudge #${state.nudges}`)
      try { await sendPrompt(nudgeText(), { timeoutSec: 300 }) } catch (error) { log(`nudge 失败：${String(error?.message ?? error)}`) }
      lastNudge = Date.now()
      recordStrategy('idle-nudge', `空闲 ${Math.round(idleMs / 60000)}min 没有新事件，投递"继续安排"提示`)
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
