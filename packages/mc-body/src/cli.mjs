// mc-body 启动器：默认只读状态/事件；--allow-task 才执行任务，--allow-say 才发言。
// 常驻进程：连接失败/断线不会退出，按有界退避重连；HTTP 一直可用，状态栏不假在线。
// 退出归因：可控退出/静默掉线/崩溃都会写 `body-exit.json`（reason 分类）与 stderr 一行，
// 并留下 `body-alive.json` 最后心跳，供上层（mc-link/lab）区分 主动停/服务端踢/网络/崩溃。
import fs from 'node:fs'
import path from 'node:path'
import { createBody } from './body.mjs'
import { createHttpServer } from './server.mjs'
import { createMineflayerAdapter } from './mineflayer.mjs'
import { iclPaths } from '../../core/src/icl-paths.mjs'

const args = process.argv.slice(2)
const arg = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback }
const flag = (name) => args.includes(name)
const host = String(arg('--host', '127.0.0.1'))
const port = Number(arg('--port', 54835))
const listenPort = Number(arg('--listen', 54836))
// MC 用户名上限 16：超长不是“连不上”，而是 server 直接 socketClosed——明确截断并警告。
const rawUsername = String(arg('--name', 'ICL-Body'))
const username = rawUsername.slice(0, 16)
if (username !== rawUsername) console.error(`[mc-body] name "${rawUsername}" 超过 16 字符，截断为 "${username}"（MC 用户名上限）`)
const allowTask = flag('--allow-task')
const allowSay = flag('--allow-say')
// 默认落盘位置从 ICL_ROOT 推（ICL_ROOT/state/mc-body）；显式 --log/--state 仍然优先。
const defaultBodyDir = path.join(iclPaths().stateDir, 'mc-body')
const logFile = path.resolve(String(arg('--log', path.join(defaultBodyDir, 'events.jsonl'))))
const stateFile = path.resolve(String(arg('--state', path.join(defaultBodyDir, 'tasks.json'))))
const pausedDisconnectMs = Number(arg('--paused-disconnect-ms', 120_000))
const watchdogMs = Number(arg('--watchdog-ms', 2000))
const heartbeatMs = Number(arg('--heartbeat-ms', 60_000))
const exitOnIdle = !flag('--no-exit-on-idle')
const exitOnReconnectExhausted = flag('--exit-on-reconnect-exhausted')
const stateDir = path.dirname(stateFile)
const exitFile = path.join(stateDir, 'body-exit.json')
const aliveFile = path.join(stateDir, 'body-alive.json')

const IMPORTANT_EVENTS = /^(offline|reconnected|reconnecting|reconnect_exhausted|safety_stop|safety_resume|resume_required|idle_disconnect|quarantine|spawn_unsafe|spawn_safe|task_(paused|unknown|done|failed|cancelled|interrupted)|watchdog_suppressed|body_error|stuck|path_stuck|path_precheck|tunnel_clear|dig_refused|dig_error|env_probe)$/

function logEvent(type, data) {
  if (!IMPORTANT_EVENTS.test(String(type))) return
  const detail = ` ${JSON.stringify(data).slice(0, 400)}`
  console.error(`[mc-body] ${type}${detail}`)
}

let body = null
let http = null
let exiting = false
let exitReason = null
// stderr 环形缓冲：崩溃时连 stderr 一起写进 body-exit.json（不再“只有退出码”）。
const stderrTail = []
const rawConsoleError = console.error.bind(console)
console.error = (...parts) => {
  try {
    const line = parts.map((part) => (part instanceof Error ? `${part.name}: ${part.message}` : String(part))).join(' ')
    stderrTail.push(line.slice(0, 600))
    while (stderrTail.length > 30) stderrTail.shift()
  } catch { /* ignore */ }
  rawConsoleError(...parts)
}

function snapshot() {
  try {
    const status = body?.status?.() ?? {}
    const recent = body?.eventsSince?.(Math.max(0, Number(status.eventsSeq ?? 0) - 12))?.events ?? []
    return {
      pid: process.pid,
      at: Date.now(),
      connected: status.connected ?? null,
      paused: status.paused ?? null,
      pausedReason: status.pausedReason ?? null,
      taskId: status.task?.id ?? null,
      taskState: status.task?.state ?? null,
      queue: (status.queue ?? []).length,
      pausedTasks: (status.pausedTasks ?? []).map((task) => task.id),
      eventsSeq: status.eventsSeq ?? null,
      lastError: status.adapter?.lastError ?? null,
      reconnect: status.reconnect ?? null,
      recentEvents: recent.map((event) => ({ seq: event.seq, type: event.type, data: event.data })).slice(-12),
      stderrTail: stderrTail.slice(-10),
    }
  } catch { return { pid: process.pid, at: Date.now(), snapshotError: true, stderrTail: stderrTail.slice(-10) } }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2), 'utf8')
    fs.renameSync(`${file}.tmp`, file)
    return true
  } catch { return false }
}

// reason 分类（给上层消费）：
//   sigterm / sigint        我们/宿主主动停（干净退出，code 0）
//   api-shutdown            HTTP /v1/shutdown 主动停
//   idle-timeout            暂停超时后身体自己下线（code 0）
//   reconnect-exhausted     自动重连放弃（可选退出，code 0）
//   uncaught-exception / unhandled-rejection  进程崩溃（code 1）
//   startup-error           启动阶段失败（code 1）
function recordExit(reason, detail = null, code = 0) {
  if (exitReason) return
  exitReason = reason
  const entry = { ...snapshot(), reason: String(reason), exitCode: Number(code), detail: detail == null ? null : String(detail).slice(0, 800), endedAt: Date.now() }
  writeJson(exitFile, entry)
  try { body?.push?.('body_exit', entry) } catch { /* ignore */ }
  console.error(`[mc-body] exit reason=${entry.reason} code=${entry.exitCode}${entry.detail ? ` detail=${entry.detail}` : ''}`)
}

async function shutdown(reason, detail = null, code = 0) {
  if (exiting) return
  exiting = true
  recordExit(reason, detail, code)
  // 兜底：body.stop()/http.close() 若因 adapter 卡住不返回，也要在 2.5s 内退出（否则进程永远挂着）。
  const force = setTimeout(() => process.exit(code), 2500)
  try { await body?.stop?.() } catch { /* ignore */ }
  try { await http?.close?.() } catch { /* ignore */ }
  try { fs.unlinkSync(aliveFile) } catch { /* ignore */ }
  clearTimeout(force)
  process.exit(code)
}

// 所有退出路径都归因：SIGTERM/SIGINT/显式 shutdown/依赖或未捕获错误直接退出。
process.on('SIGINT', () => { void shutdown('sigint', null, 0) })
process.on('SIGTERM', () => { void shutdown('sigterm', null, 0) })
process.on('uncaughtException', (error) => { void shutdown('uncaught-exception', error?.stack ?? String(error), 1) })
process.on('unhandledRejection', (reason) => { void shutdown('unhandled-rejection', reason instanceof Error ? reason.stack : String(reason), 1) })
process.on('exit', (code) => {
  // 走到这里还没写过原因 = 依赖/其他代码直接 process.exit：至少留下 panic 归因 + stack 不能有，但 status 在。
  if (!exitReason) recordExit(code === 0 ? 'clean-exit' : 'exit-code', `process exited with code ${code}（非本进程 shutdown 路径）`, code)
})

const adapter = createMineflayerAdapter({
  host, port, username,
  onEvent: (type, data) => {
    logEvent(type, data)
    try { body?.ingest(type, data) } catch (error) { console.error(`[mc-body] ingest ${type} failed: ${error?.message ?? error}`) }
    if (type === 'reconnect_exhausted') {
      console.error(`[mc-body] reconnect_exhausted attempts=${data?.attempts ?? '?'} max=${data?.max ?? '?'}`)
      if (exitOnReconnectExhausted) void shutdown('reconnect-exhausted', data?.reason ?? null, 0)
    }
  },
  log: (message) => console.error(`[mc-body] ${message}`),
  autoReconnect: !flag('--no-reconnect'),
  maxReconnect: Number(arg('--max-reconnect', 5)),
  reconnectBaseMs: Number(arg('--reconnect-base-ms', 2000)),
  reconnectMaxDelayMs: Number(arg('--reconnect-max-delay-ms', 30_000)),
  connectTimeoutMs: Number(arg('--connect-timeout-ms', 15_000)),
  pathStallMs: Number(arg('--path-stall-ms', 3500)),
})

body = createBody({
  adapter, allowTask, allowSay, logFile, stateFile, pausedDisconnectMs, watchdogMs, heartbeatMs,
  movementStallMs: Number(arg('--stuck-ms', 25_000)),
  packetStaleMs: Number(arg('--stale-ms', 45_000)),
  onIdleDisconnect: ({ reason }) => {
    if (!exitOnIdle) return
    console.error(`[mc-body] idle-timeout（暂停 ${reason ?? '?'} 太久）—— 主动下线并退出`)
    void shutdown('idle-timeout', JSON.stringify({ pausedReason: reason }), 0)
  },
  onShutdownRequest: async (reason) => {
    setTimeout(() => { void shutdown('api-shutdown', String(reason ?? ''), 0) }, 50)
    return { ok: true, reason: String(reason ?? 'api'), willExit: true }
  },
})

http = createHttpServer(body, { host: '127.0.0.1', port: listenPort })
await http.listen()
console.log(`[mc-body] http://127.0.0.1:${listenPort} -> ${host}:${port} allowTask=${allowTask} allowSay=${allowSay} autoReconnect=${!flag('--no-reconnect')} exitOnIdle=${exitOnIdle}`)
writeJson(aliveFile, snapshot())

try {
  await body.start()
} catch (error) {
  console.error(`[mc-body] start failed: ${error?.message ?? error}`)
}
const initial = body.status()
console.log(`[mc-body] initial connected=${initial.connected} paused=${initial.paused}${initial.pausedReason ? `(${initial.pausedReason})` : ''} name=${username}`)

// 自检钩子（只给验证归因用）：模拟 crash/静默 exit，检查 body-exit.json 是否带 reason+stack。
const selftestCrash = arg('--selftest-crash', null)
if (selftestCrash) {
  console.error(`[mc-body] selftest-crash=${selftestCrash}（1.5s 后触发，仅验证退出归因）`)
  const timer = setTimeout(() => {
    if (selftestCrash === 'uncaught') throw new Error('selftest: uncaught exception')
    if (selftestCrash === 'rejection') { void Promise.reject(new Error('selftest: unhandled rejection')) ; return }
    if (selftestCrash === 'exit1') { process.exit(1); return }
    if (selftestCrash === 'exit0') { process.exit(0); return }
  }, 1500)
  if (typeof timer.unref === 'function') timer.unref()
}

// 心跳文件：被硬 kill 时，上层至少能从最后一条 alive 判断“进程是在哪个状态下被杀的”。
const aliveTimer = setInterval(() => { if (!exiting) writeJson(aliveFile, snapshot()) }, Math.max(1000, Math.min(10_000, Number(watchdogMs) || 2000)))
if (typeof aliveTimer.unref === 'function') aliveTimer.unref()
