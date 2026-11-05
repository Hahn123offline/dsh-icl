#!/usr/bin/env node
// 假 OneBot v11 WS 服务：给 qq 只读插件做回环验证，**不需要 SnowLuma、不连真 QQ**。
//
// 用法（lab / 手动）：
//   node packages/plugins/qq/tools/fake-onebot.mjs --port 3301 --token test-token --after 800
//   然后在 lab 的 qq 配置里写 url: ws://127.0.0.1:3301/, token: test-token, allowPrivate: ['10001']
//
// 它是"服务器"，只推事件；客户端（插件）从不发帧，所以这里连读帧都不需要实现。
// 也导出 createFakeOneBot() 给 node --test 直接用（监听 127.0.0.1:0 随机端口）。
//
// 发的内容刻意覆盖闸门：私聊白名单内 1 条 + 同 id 重复 1 条 + 白名单外 1 条 + 群消息 1 条。
import http from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function frame(text) {
  const payload = Buffer.from(String(text), 'utf8')
  const len = payload.length
  let head
  if (len < 126) {
    head = Buffer.from([0x81, len])
  } else if (len < 65536) {
    head = Buffer.alloc(4)
    head[0] = 0x81
    head[1] = 126
    head.writeUInt16BE(len, 2)
  } else {
    head = Buffer.alloc(10)
    head[0] = 0x81
    head[1] = 127
    head.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([head, payload])
}

/**
 * 创建假 OneBot 服务（不自动发消息，由调用方触发）。
 * @returns {Promise<{port:number, token:string, framesSent:()=>number, privateMessage:Function, groupMessage:Function, sendJson:Function, close:Function, sockets:Set}>}
 */
export function createFakeOneBot({ port = 0, host = '127.0.0.1', token = '' } = {}) {
  const sockets = new Set()
  let frames = 0
  let clientChunks = 0
  const server = http.createServer((req, res) => { res.statusCode = 404; res.end('{}') })

  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
    if (token && url.searchParams.get('access_token') !== token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    const key = req.headers['sec-websocket-key']
    if (!key) { socket.destroy(); return }
    const accept = createHash('sha1').update(String(key) + WS_GUID).digest('base64')
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n',
    ].join('\r\n'))
    socket.setNoDelay(true)
    // 客户端按设计零出站帧；仍然把收到的数据排掉，避免缓冲区反压。
    // clientChunks 是"只读不变量"的证据：连接期间客户端一个字节都不该发（close 帧除外，
    // 测试在 stop 之前断言它仍是 0）。
    socket.on('data', () => { clientChunks += 1 })
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    sockets.add(socket)
  })

  function sendJson(obj) {
    const text = JSON.stringify(obj)
    for (const socket of sockets) {
      if (socket.destroyed) { sockets.delete(socket); continue }
      try { socket.write(frame(text)); frames += 1 } catch { sockets.delete(socket) }
    }
    return sockets.size
  }

  function privateMessage({ from = 10001, name = '测试', text = '在吗', messageId = Date.now() % 1e9, time = Math.floor(Date.now() / 1000), selfId = 2593621742 } = {}) {
    return sendJson({
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      time,
      self_id: selfId,
      user_id: Number(from),
      message_id: messageId,
      message: [{ type: 'text', data: { text: String(text) } }],
      raw_message: String(text),
      sender: { user_id: Number(from), nickname: String(name) },
    })
  }

  function groupMessage({ groupId = 601357169, from = 10001, name = '测试', text = '群里说话', messageId = Date.now() % 1e9, selfId = 2593621742 } = {}) {
    return sendJson({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      time: Math.floor(Date.now() / 1000),
      self_id: selfId,
      group_id: Number(groupId),
      user_id: Number(from),
      message_id: messageId,
      message: [{ type: 'text', data: { text: String(text) } }],
      raw_message: String(text),
      sender: { user_id: Number(from), nickname: String(name) },
    })
  }

  function heartbeat({ selfId = 2593621742, online = true, good = true } = {}) {
    return sendJson({
      post_type: 'meta_event',
      meta_event_type: 'heartbeat',
      time: Math.floor(Date.now() / 1000),
      self_id: selfId,
      interval: 30000,
      status: { online, good },
    })
  }

  function lifecycle() {
    return sendJson({
      post_type: 'meta_event',
      meta_event_type: 'lifecycle',
      sub_type: 'connect',
      time: Math.floor(Date.now() / 1000),
      self_id: 2593621742,
    })
  }

  function close() {
    for (const socket of sockets) { try { socket.destroy() } catch { /* 已断 */ } }
    sockets.clear()
    return new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(() => resolve())
      setTimeout(resolve, 200).unref?.()
    })
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const actual = server.address().port
      resolve({
        port: actual,
        host,
        token,
        sockets,
        framesSent: () => frames,
        clientDataChunks: () => clientChunks,
        sendJson,
        privateMessage,
        groupMessage,
        heartbeat,
        lifecycle,
        close,
        url: `ws://${host}:${actual}/?access_token=${encodeURIComponent(token)}`,
      })
    })
  })
}

/* ── CLI：手动演示 / lab 用 ────────────────────────────── */

function argOf(argv, name, fallback = null) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : fallback
}

async function main() {
  const argv = process.argv.slice(2)
  const port = Number(argOf(argv, 'port', 3301))
  const token = argOf(argv, 'token', 'test-token')
  const from = Number(argOf(argv, 'from', 10001))
  const name = argOf(argv, 'name', '测试')
  const text = argOf(argv, 'text', '在吗')
  const after = Number(argOf(argv, 'after', 800))
  const runMs = Number(argOf(argv, 'run-ms', 15000))
  const withGroup = argv.includes('--group')
  const withDuplicate = argv.includes('--duplicate')
  const fake = await createFakeOneBot({ port, token: String(token) })
  const log = (row) => console.log(JSON.stringify({ t: new Date().toISOString(), ...row }))
  log({ event: 'fake-onebot.listen', port: fake.port, token: token ? '<set>' : '' })
  setTimeout(() => {
    fake.lifecycle()
    fake.heartbeat()
    log({ event: 'sent', kind: 'lifecycle+heartbeat' })
  }, 50)
  setTimeout(() => {
    const messageId = Date.now() % 1e9
    const n = fake.privateMessage({ from, name, text, messageId })
    log({ event: 'sent', kind: 'private', clients: n, from, messageId })
    if (withDuplicate) {
      fake.privateMessage({ from, name, text, messageId })
      log({ event: 'sent', kind: 'private-duplicate', from, messageId })
    }
    fake.privateMessage({ from: 999999, name: '陌生人', text: '（不在白名单）', messageId: (messageId + 1) % 1e9 })
    log({ event: 'sent', kind: 'private-stranger' })
    if (withGroup) {
      fake.groupMessage({ from, name, text: '（群消息应被整类忽略）' })
      log({ event: 'sent', kind: 'group' })
    }
  }, Math.max(100, after))
  const stop = async () => { await fake.close(); process.exit(0) }
  setTimeout(stop, Math.max(500, runMs))
  process.on('SIGINT', stop)
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isCli) main().catch((error) => { console.error(error); process.exit(1) })
