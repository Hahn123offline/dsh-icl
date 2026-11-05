// mc-body 启动器：默认只读状态/事件；--allow-task 才执行任务，--allow-say 才发言。
// 常驻进程：连接失败/断线不会退出，按有界退避重连；HTTP 一直可用，状态栏不假在线。
import path from 'node:path'
import { createBody } from './body.mjs'
import { createHttpServer } from './server.mjs'
import { createMineflayerAdapter } from './mineflayer.mjs'

const args = process.argv.slice(2)
const arg = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback }
const flag = (name) => args.includes(name)
const host = String(arg('--host', '127.0.0.1'))
const port = Number(arg('--port', 54835))
const listenPort = Number(arg('--listen', 54836))
const username = String(arg('--name', 'ICL-Body'))
const allowTask = flag('--allow-task')
const allowSay = flag('--allow-say')
const logFile = path.resolve(String(arg('--log', path.join('C:/DSH/icl/.state/mc-body/events.jsonl'))))
const stateFile = path.resolve(String(arg('--state', path.join('C:/DSH/icl/.state/mc-body/tasks.json'))))
const pausedDisconnectMs = Number(arg('--paused-disconnect-ms', 120_000))
const watchdogMs = Number(arg('--watchdog-ms', 2000))
const heartbeatMs = Number(arg('--heartbeat-ms', 60_000))

const IMPORTANT_EVENTS = /^(offline|reconnected|reconnecting|reconnect_exhausted|safety_stop|safety_resume|resume_required|idle_disconnect|quarantine|spawn_unsafe|spawn_safe|task_(paused|unknown|done|failed|cancelled|interrupted)|watchdog_suppressed|body_error|stuck|path_stuck|tunnel_clear)$/

function logEvent(type, data) {
  if (!IMPORTANT_EVENTS.test(String(type))) return
  const detail = ` ${JSON.stringify(data).slice(0, 400)}`
  console.error(`[mc-body] ${type}${detail}`)
}

const adapter = createMineflayerAdapter({
  host, port, username,
  onEvent: (type, data) => {
    logEvent(type, data)
    try { body?.ingest(type, data) } catch (error) { console.error(`[mc-body] ingest ${type} failed: ${error?.message ?? error}`) }
  },
  log: (message) => console.error(`[mc-body] ${message}`),
  autoReconnect: !flag('--no-reconnect'),
  maxReconnect: Number(arg('--max-reconnect', 5)),
  reconnectBaseMs: Number(arg('--reconnect-base-ms', 2000)),
  reconnectMaxDelayMs: Number(arg('--reconnect-max-delay-ms', 30_000)),
  connectTimeoutMs: Number(arg('--connect-timeout-ms', 15_000)),
  pathStallMs: Number(arg('--path-stall-ms', 3500)),
})
const body = createBody({
  adapter, allowTask, allowSay, logFile, stateFile, pausedDisconnectMs, watchdogMs, heartbeatMs,
  movementStallMs: Number(arg('--stuck-ms', 25_000)),
  packetStaleMs: Number(arg('--stale-ms', 45_000)),
})

const http = createHttpServer(body, { host: '127.0.0.1', port: listenPort })
await http.listen()
console.log(`[mc-body] http://127.0.0.1:${listenPort} -> ${host}:${port} allowTask=${allowTask} allowSay=${allowSay} autoReconnect=${!flag('--no-reconnect')}`)

try {
  await body.start()
} catch (error) {
  console.error(`[mc-body] start failed: ${error?.message ?? error}`)
}
const initial = body.status()
console.log(`[mc-body] initial connected=${initial.connected} paused=${initial.paused}${initial.pausedReason ? `(${initial.pausedReason})` : ''} name=${username}`)

async function shutdown() {
  try { await body.stop() } catch { /* ignore */ }
  await http.close().catch(() => {})
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
