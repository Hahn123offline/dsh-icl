#!/usr/bin/env node
// 假 OneBot v11 WS 服务：给 qq 只读插件做回环验证，**不需要 SnowLuma、不连真 QQ**。
//
// 用法（lab / 手动）：
//   node packages/plugins/qq/tools/fake-onebot.mjs --port 3301 --token test-token --after 800
//   然后在 lab 的 qq 配置里写 url: ws://127.0.0.1:3301/, token: test-token, allowPrivate: ['10001']
//
// 它是"服务器"：推事件；同时能读客户端发来的 OneBot 动作帧并回 echo 回执，
// 用来验证 phase 1 的出站（send_private_msg）——但**不会真的连 QQ**。
// 也导出 createFakeOneBot() 给 node --test 直接用（监听 127.0.0.1:0 随机端口）。
//
// 发的内容刻意覆盖入站闸门：私聊白名单内 1 条 + 同 id 重复 1 条 + 白名单外 1 条 + 群消息 1 条。
// 动作模式（setActionMode）：ok=正常回执 / reject=retcode 100 / drop=不回（触发客户端超时 unknown）。
import http from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

// 1x1 透明 PNG（给 get_image 契约用；不是真实 QQ 图片，只验字节路径）。
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const fakeImageBase64 = () => TINY_PNG_BASE64

function frame(text, opcode = 0x1) {
  const payload = Buffer.from(String(text), 'utf8')
  const len = payload.length
  let head
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, len])
  } else if (len < 65536) {
    head = Buffer.alloc(4)
    head[0] = 0x80 | opcode
    head[1] = 126
    head.writeUInt16BE(len, 2)
  } else {
    head = Buffer.alloc(10)
    head[0] = 0x80 | opcode
    head[1] = 127
    head.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([head, payload])
}

/** 解析客户端帧（客户端帧必带 mask）。返回 { frames, rest }，只处理完整的文本/ping/close。 */
function decodeClientFrames(buffer) {
  const frames = []
  let rest = buffer
  while (rest.length >= 2) {
    const b0 = rest[0]
    const b1 = rest[1]
    const opcode = b0 & 0x0f
    const masked = (b1 & 0x80) !== 0
    let len = b1 & 0x7f
    let offset = 2
    if (len === 126) {
      if (rest.length < 4) break
      len = rest.readUInt16BE(2)
      offset = 4
    } else if (len === 127) {
      if (rest.length < 10) break
      len = Number(rest.readBigUInt64BE(2))
      offset = 10
    }
    const maskLen = masked ? 4 : 0
    if (rest.length < offset + maskLen + len) break
    const mask = masked ? rest.subarray(offset, offset + 4) : null
    const payload = Buffer.from(rest.subarray(offset + maskLen, offset + maskLen + len))
    if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4]
    frames.push({ opcode, text: opcode === 0x1 ? payload.toString('utf8') : null })
    rest = rest.subarray(offset + maskLen + len)
  }
  return { frames, rest }
}

/**
 * 创建假 OneBot 服务（不自动发消息，由调用方触发）。
 * @returns {Promise<{port:number, token:string, framesSent:()=>number, privateMessage:Function, groupMessage:Function, sendJson:Function, close:Function, sockets:Set}>}
 */
export function createFakeOneBot({ port = 0, host = '127.0.0.1', token = '', actionMode = 'ok' } = {}) {
  const sockets = new Set()
  let frames = 0
  let clientChunks = 0
  let mode = actionMode
  let messageSeq = 7000
  const actions = []
  const history = []
  const messageStore = new Map() // message_id -> 消息对象（给 get_msg 用）
  const forwardStore = new Map() // forward id -> get_forward_msg 的 data
  const remember = (item) => {
    if (item?.message_id != null) messageStore.set(String(item.message_id), item)
    return item
  }
  const jsonResponse = (res, obj) => {
    try {
      const body = JSON.stringify(obj)
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
      res.end(body)
    } catch { try { res.destroy() } catch { /* 已断 */ } }
  }
  const server = http.createServer((req, res) => {
    // OneBot v11 HTTP 动作端（fake）：给补课/已读契约用；不查 token（测试用）。
    if (req.method === 'POST') {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        let payload = {}
        try { payload = JSON.parse(body || '{}') } catch { payload = {} }
        // 兼容两种写法：动作名在 URL 路径（OneBot HTTP 惯例）或 body.action（本 fake 的 WS 写法）。
        let pathAction = ''
        try { pathAction = new URL(req.url ?? '/', 'http://fake').pathname.replace(/^\/+/, '') } catch { pathAction = '' }
        const action = String(payload.action ?? pathAction)
        const params = payload.params ?? payload ?? {}
        actions.push({ action, params, echo: payload.echo ?? null, at: Date.now(), via: 'http' })
        if (mode === 'drop') { try { req.destroy() } catch { /* 已断 */ } return }
        if (mode === 'reject') {
          jsonResponse(res, { status: 'failed', retcode: 100, wording: 'fake backend rejected', data: null })
          return
        }
        let data = {}
        if (action === 'get_friend_msg_history') {
          const uid = String(params.user_id ?? '')
          const limit = Math.max(1, Math.min(100, Number(params.count) || 20))
          const matched = history.filter((item) => String(item.user_id ?? item.sender?.user_id ?? '') === uid || String(item.peer_id ?? '') === uid)
          data = { messages: matched.slice(-limit) }
        } else if (action === 'get_group_msg_history') {
          const gid = String(params.group_id ?? '')
          const limit = Math.max(1, Math.min(100, Number(params.count) || 20))
          const matched = history.filter((item) => String(item.group_id ?? item.groupId ?? item.peer_id ?? '') === gid)
          data = { messages: matched.slice(-limit) }
        } else if (action === 'get_msg') {
          const found = messageStore.get(String(params.message_id ?? '')) ?? history.find((item) => String(item.message_id) === String(params.message_id ?? ''))
          if (!found) {
            jsonResponse(res, { status: 'failed', retcode: 104, wording: 'no such message', data: null })
            return
          }
          data = found
        } else if (action === 'get_forward_msg') {
          const found = forwardStore.get(String(params.id ?? ''))
          if (!found) {
            jsonResponse(res, { status: 'failed', retcode: 104, wording: 'no such forward', data: null })
            return
          }
          data = found
        } else if (action === 'get_image') {
          data = { base64: fakeImageBase64() }
        } else if (/mark_.*as_read/.test(action)) {
          data = {}
        }
        jsonResponse(res, { status: 'ok', retcode: 0, data })
      })
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
  server.on('clientError', (error, socket) => { try { socket.destroy() } catch { /* 已断 */ } })

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
    // 收客户端动作帧：phase 1 的 send_private_msg 在这里被记录并按 mode 回执。
    // 入站影子模式（不发动作）时 clientChunks 保持 0，仍可作为"零出站"证据。
    let pending = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      clientChunks += 1
      pending = Buffer.concat([pending, chunk])
      const { frames: decoded, rest } = decodeClientFrames(pending)
      pending = rest
      for (const item of decoded) {
        if (item.opcode === 0x8) { try { socket.end() } catch { /* 已关 */ } continue }
        if (item.opcode === 0x9) { try { socket.write(frame('', 0xA)) } catch { /* 已关 */ } continue }
        if (item.opcode !== 0x1 || !item.text) continue
        let payload
        try { payload = JSON.parse(item.text) } catch { continue }
        if (!payload || typeof payload !== 'object' || payload.action == null) continue
        const record = { action: String(payload.action), params: payload.params ?? {}, echo: payload.echo ?? null, at: Date.now() }
        actions.push(record)
        if (payload.echo == null) continue
        if (mode === 'drop') continue
        if (mode === 'reject') {
          try { socket.write(frame(JSON.stringify({ status: 'failed', retcode: 100, wording: 'fake backend rejected', echo: payload.echo }))) } catch { /* 已关 */ }
          continue
        }
        messageSeq += 1
        const data = /^upload_(?:group|private)_file$/.test(record.action)
          ? { file_id: `fake-file-${messageSeq}` }
          : (/^send_/.test(record.action) ? { message_id: messageSeq } : {})
        try { socket.write(frame(JSON.stringify({ status: 'ok', retcode: 0, data, echo: payload.echo }))) } catch { /* 已关 */ }
      }
    })
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
    const event = {
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
    }
    remember(event)
    sendJson(event)
    return event
  }

  /** 发一条任意段的私聊消息（图片/文件/引用/转发/表情…），用于 P0-2 富内容测试。 */
  function privateRichMessage({ from = 10001, name = '测试', segments = [], messageId = Date.now() % 1e9, time = Math.floor(Date.now() / 1000), selfId = 2593621742 } = {}) {
    const event = {
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      time,
      self_id: selfId,
      user_id: Number(from),
      message_id: messageId,
      message: Array.isArray(segments) ? segments : [],
      raw_message: '',
      sender: { user_id: Number(from), nickname: String(name) },
    }
    remember(event)
    sendJson(event)
    return event
  }

  function groupMessage({ groupId = 601357169, from = 10001, name = '测试', text = '群里说话', messageId = Date.now() % 1e9, selfId = 2593621742 } = {}) {
    const event = {
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
    }
    remember(event)
    sendJson(event)
    return event
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

  /** 模拟"断线但服务还在"：只踢掉当前 WS 客户端，重连后可继续。 */
  function dropConnections() {
    const count = sockets.size
    for (const socket of [...sockets]) { try { socket.destroy() } catch { /* 已断 */ } }
    sockets.clear()
    return count
  }

  /** 往历史里塞一条"断线期间别人发的消息"（不走 WS 推送，等客户端补课来取）。 */
  function pushHistory({ from = 10001, name = '测试', text = '断线期间的消息', messageId = null, time = Math.floor(Date.now() / 1000) } = {}) {
    const id = messageId ?? ((Date.now() % 1e9) + history.length + 1)
    const item = {
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      time,
      self_id: 2593621742,
      user_id: Number(from),
      message_id: Number(id),
      message: [{ type: 'text', data: { text: String(text) } }],
      raw_message: String(text),
      sender: { user_id: Number(from), nickname: String(name) },
    }
    history.push(item)
    remember(item)
    return item
  }

  /** 注册一份 get_forward_msg 的假返回（id -> data）。 */
  function addForward(id, data) {
    forwardStore.set(String(id), data)
    return String(id)
  }

  /** 往历史里塞一条"自己发出去的消息"（补课时应被忽略）。 */
  function pushSelfHistory({ to = 10001, text = '（我自己发的）', messageId = null, time = Math.floor(Date.now() / 1000) } = {}) {
    const item = pushHistory({ from: to, name: '我', text, messageId, time })
    item.user_id = 2593621742
    item.sender = { user_id: 2593621742, nickname: '我' }
    item.peer_id = Number(to)
    return item
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
        actions: () => actions.map((row) => ({ ...row })),
        sendActions: () => actions.filter((row) => /^send_/.test(row.action)).map((row) => ({ ...row })),
        history: () => history.map((row) => ({ ...row })),
        pushHistory,
        pushSelfHistory,
        addForward,
        privateRichMessage,
        messageStore,
        dropConnections,
        httpUrl: `http://${host}:${actual}`,
        setActionMode(next) { mode = String(next) },
        actionMode: () => mode,
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
