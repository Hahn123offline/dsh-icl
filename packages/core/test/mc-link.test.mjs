// mc-link：7 个常驻工具 + mcb_do 组合 + mcb_help 文档。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost, createSessionAdapter } from '../src/index.mjs'
import * as mcLink from '../../plugins/mc-link/src/index.mjs'
import manifest from '../../plugins/mc-link/manifest.json' with { type: 'json' }

function fakeBody() {
  let seq = 1
  const events = []
  const tasks = []
  const chats = []
  const sockets = new Set()
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/v1/status') {
      res.end(JSON.stringify({ ok: true, version: 'mc-body/v1', paused: false, task: null, queue: [], eventsSeq: seq, adapter: { connected: true, host: '127.0.0.1', port: 54835, self: 'ICL-Body', players: ['ICL-Body'], position: { x: 1, y: 2, z: 3 }, health: 20, food: 20, nearby: { villager: 1 }, inventoryCount: 4 } }))
      return
    }
    if (url.pathname === '/v1/events') {
      const since = Number(url.searchParams.get('since') ?? 0)
      res.end(JSON.stringify({ ok: true, seq, events: events.filter((e) => e.seq > since) }))
      return
    }
    if (url.pathname === '/v1/inspect' && req.method === 'POST') {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => { const input = JSON.parse(raw); res.end(JSON.stringify({ ok: true, result: { text: `inspect:${input.kind}` } })) })
      return
    }
    if (url.pathname === '/v1/do' && req.method === 'POST') {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => { const input = JSON.parse(raw); if (input.steps?.[0]?.op === 'task') { const task = { id: 't-1', kind: 'mine', state: 'queued' }; tasks.push(input); res.end(JSON.stringify({ ok: true, task })) } else { chats.push(input.steps?.[0]?.op); res.end(JSON.stringify({ ok: true, results: input.steps })) } })
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
  // 显式记录并销毁连接：否则 fake server 的 socket 会让 `node --test` 的子进程跑完不退出。
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  const close = () => new Promise((resolve) => {
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    server.closeAllConnections?.()
    server.close(() => resolve())
    server.unref()
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, push: (event) => { seq += 1; events.push({ seq, ...event }) }, tasks, chats, close })))
}

test('mc-link：7 工具、组合 op、help 模糊匹配、事件 signal', async () => {
  const body = await fakeBody()
  const { port, push, tasks, close } = body
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-mc-link-'))
  // 不共用 keep-alive 连接：每个请求 Connection: close，避免 undici 全局连接池把测试子进程钉住。
  const fetchImpl = (url, init = {}) => fetch(url, { ...init, headers: { ...(init.headers ?? {}), connection: 'close' } })
  const host = createHost({ log: () => {}, fetchImpl })
  host.registerPlugin(manifest, mcLink, { config: { baseUrl: `http://127.0.0.1:${port}`, pollMs: 60_000, logFile: path.join(root, 'events.jsonl') } })
  await host.enable('mc-link')
  const pushed = []
  const adapter = createSessionAdapter({ sessionId: 'mc-link-test', host, push: async (text) => { pushed.push(String(text)) } })
  const link = host.shared.get('mc-link')
  await link.poll()
  push({ type: 'chat', data: { username: 'Hahn123_', message: '你好' } })
  await link.poll()
  await adapter.drainOnce()
  assert.equal(pushed.length, 1)
  assert.match(pushed[0], /\[MC\] Hahn123_：你好/)

  const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))
  assert.deepEqual(Object.keys(tools).sort(), ['mcb_attack', 'mcb_combat', 'mcb_do', 'mcb_eyes', 'mcb_help', 'mcb_inventory', 'mcb_join', 'mcb_lan', 'mcb_leave', 'mcb_look', 'mcb_map', 'mcb_scan', 'mcb_servers', 'mcb_shelter', 'mcb_snapshot', 'mcb_status', 'mcb_stop'])
  assert.match((await tools.mcb_servers.execute()).text, /127\.0\.0\.1:54838/)
  assert.equal((await tools.mcb_look.execute()).text, 'inspect:look')
  assert.equal((await tools.mcb_scan.execute({ name: 'dirt' })).text, 'inspect:scan')
  await tools.mcb_do.execute({ steps: [{ op: 'task', kind: 'mine', params: { block: 'dirt', count: 1 } }] })
  assert.equal(tasks.length, 1)
  await assert.rejects(() => tools.mcb_do.execute({ steps: [{ op: 'mineee' }] }), /你是不是要 mine/)
  assert.match((await tools.mcb_help.execute({ skill: 'trade' })).text, /村民交易/)
  assert.match((await tools.mcb_help.execute({ skill: 'trad' })).text, /村民交易/)
  adapter.dispose()
  host.disable('mc-link')
  await close()
})
