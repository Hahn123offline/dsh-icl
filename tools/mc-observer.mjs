// 低伤害 MC 接缝：一个只读观察者（默认不发言），把局域网游戏的事件暴露成本地 HTTP。
//
//   node tools/mc-observer.mjs --host 127.0.0.1 --port 54835 --listen 54836
//
// 默认：不移动、不挖、不聊天，只记录 chat/join/leave/death/health。
// 加 --allow-say 才允许 POST /say；仍然拒绝以 / 开头的命令。
//
// 产物：.state/mc-observer/events.jsonl + 内存 ring；GET /status、/events?since=N。
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'

const args = process.argv.slice(2)
const arg = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback }
const flag = (name) => args.includes(name)
const host = String(arg('--host', '127.0.0.1'))
const port = Number(arg('--port', 54835))
const listenPort = Number(arg('--listen', 54836))
const username = String(arg('--name', 'ICL-Observer'))
const allowSay = flag('--allow-say')
const outDir = path.resolve(String(arg('--out', path.join('C:/DSH/icl/.state/mc-observer'))))
fs.mkdirSync(outDir, { recursive: true })
const eventFile = path.join(outDir, 'events.jsonl')

const profileModules = process.env.MC_NODE_MODULES ?? path.join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop', 'node_modules')
const require = createRequire(path.join(profileModules, 'noop.js'))
const mineflayer = require('mineflayer')

const ring = []
let seq = 0
let bot = null
let self = username
const startedAt = Date.now()
let lastHealth = 0

function push(type, data = {}) {
  seq += 1
  const row = { seq, type, at: Date.now(), ...data }
  ring.push(row)
  while (ring.length > 1000) ring.shift()
  try { fs.appendFileSync(eventFile, `${JSON.stringify(row)}\n`, 'utf8') } catch { /* ignore */ }
  return row
}

function status() {
  return {
    connected: Boolean(bot?.player),
    self,
    host,
    port,
    allowSay,
    startedAt,
    position: bot?.entity?.position ?? null,
    health: bot?.health ?? null,
    food: bot?.food ?? null,
    players: Object.keys(bot?.players ?? {}),
    dimension: bot?.game?.dimension ?? null,
    time: bot?.time?.timeOfDay ?? null,
    weather: bot?.weather ?? null,
    events: seq,
  }
}

function connect() {
  bot = mineflayer.createBot({ host, port, username, auth: 'offline', version: false })
  bot.once('login', () => { self = bot.username; push('login', { username: bot.username }); console.log(`[mc] login ${bot.username}`) })
  bot.once('spawn', () => { push('spawn', { position: bot.entity?.position }); console.log(`[mc] spawn ${JSON.stringify(bot.entity?.position)}`) })
  bot.on('chat', (name, message) => {
    if (!message || name === self) return
    push('chat', { username: name, message: String(message).slice(0, 1000) })
  })
  bot.on('playerJoined', (player) => { if (player?.username !== self) push('join', { username: player.username }) })
  bot.on('playerLeft', (player) => push('leave', { username: player?.username }))
  bot.on('death', () => push('death', { position: bot.entity?.position }))
  bot.on('health', () => {
    const now = Date.now()
    if (now - lastHealth < 5000) return
    lastHealth = now
    push('health', { health: bot.health, food: bot.food })
  })
  bot.on('kicked', (reason) => { push('kicked', { reason: typeof reason === 'string' ? reason : JSON.stringify(reason) }); console.error('[mc] kicked', reason) })
  bot.on('error', (error) => { push('error', { message: String(error?.message ?? error) }); console.error('[mc] error', error?.message ?? error) })
  bot.on('end', (reason) => { push('end', { reason: String(reason ?? '') }); console.log('[mc] end', reason) })
}

function json(res, code, body) {
  const text = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${listenPort}`)
  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true })
  if (req.method === 'GET' && url.pathname === '/status') return json(res, 200, status())
  if (req.method === 'GET' && url.pathname === '/events') {
    const since = Number(url.searchParams.get('since') ?? 0)
    return json(res, 200, { events: ring.filter((row) => row.seq > since), seq })
  }
  if (req.method === 'POST' && url.pathname === '/say') {
    if (!allowSay) return json(res, 403, { ok: false, error: 'observer is read-only; start with --allow-say' })
    let body = ''
    req.on('data', (chunk) => { body += chunk; if (body.length > 4096) req.destroy() })
    req.on('end', () => {
      try {
        const text = String(JSON.parse(body)?.text ?? '').replace(/[\r\n]+/g, ' ').trim()
        if (!text || text.startsWith('/')) return json(res, 400, { ok: false, error: 'text required and commands are refused' })
        if (text.length > 200) return json(res, 400, { ok: false, error: 'text too long (<=200)' })
        bot.chat(text)
        push('said', { text })
        return json(res, 200, { ok: true })
      } catch (error) { return json(res, 400, { ok: false, error: String(error?.message ?? error) }) }
    })
    return
  }
  return json(res, 404, { ok: false, error: 'not found' })
})

server.listen(listenPort, '127.0.0.1', () => console.log(`[mc] observer http://127.0.0.1:${listenPort} -> ${host}:${port} (allowSay=${allowSay})`))
connect()

function shutdown() {
  try { bot?.quit('observer shutdown') } catch { /* ignore */ }
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1000).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
