// mc-body 启动器：默认只读状态/事件；--allow-task 才执行任务，--allow-say 才发言。
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
const pausedDisconnectMs = Number(arg('--paused-disconnect-ms', 120_000))
const stateFile = path.resolve(String(arg('--state', path.join('C:/DSH/icl/.state/mc-body/tasks.json'))))

const adapter = createMineflayerAdapter({
  host, port, username,
  onEvent: (type, data) => body?.ingest(type, data),
  log: (msg) => console.error(`[mc-body] ${msg}`),
})
const body = createBody({ adapter, allowTask, allowSay, logFile, stateFile, pausedDisconnectMs })

const http = createHttpServer(body, { host: '127.0.0.1', port: listenPort })
await http.listen()
console.log(`[mc-body] http://127.0.0.1:${listenPort} -> ${host}:${port} allowTask=${allowTask} allowSay=${allowSay}`)
try {
  await body.start()
  console.log(`[mc-body] connected as ${username}`)
} catch (error) {
  console.error(`[mc-body] connect failed: ${error?.message ?? error}`)
}

async function shutdown() {
  try { await body.stop() } catch { /* ignore */ }
  await http.close().catch(() => {})
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
