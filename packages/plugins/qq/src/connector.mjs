// 只读 OneBot v11 正向 WebSocket 客户端：**只收，永远不发**。
//
// 与 focus-core / dsh-qq 的差异（刻意的）：
//   · 不发任何帧——连 get_login_info / heartbeat 回执都不发。测试直接断言 framesSent === 0。
//     selfId 由配置给，或从事件的 self_id 字段学（只记录，不用于发消息）。
//   · 不抢连接：OneBot WS server 支持多客户端（SnowLuma role=Universal），我们是额外一条只读链路；
//     不启动 SnowLuma、不碰 HTTP 3000/接口平台 3120、不写 SnowLuma 的任何文件。
//   · 端点发现只读 `<SnowLuma>/config/onebot_<uin>.json` 的 networks.wsServers[0]。
//
// 参考实现只读：focus-core domain/qq-ws.js、dsh-qq/interface-platform onebot-v11/connector.mjs。
import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_PATH = '/'
const HEARTBEAT_STALE_MS = 95_000

/** 日志/状态里永远不出现 token：去掉 query 与 hash。 */
export function sanitizeUrl(raw) {
  try {
    const u = new URL(String(raw))
    return `${u.protocol}//${u.host}${u.pathname}`
  } catch { return '(invalid-url)' }
}

/** 把 token 拼进 query（SnowLuma 认 access_token）；已有就不重复。 */
export function withToken(rawUrl, token) {
  if (!token) return String(rawUrl)
  try {
    const u = new URL(String(rawUrl))
    if (!u.searchParams.get('access_token')) u.searchParams.set('access_token', String(token))
    return u.toString()
  } catch { return String(rawUrl) }
}

/**
 * 只读发现 SnowLuma 的 OneBot WS 端点（每个账号一个 config/onebot_<uin>.json）。
 * 不修改任何文件；读不到就返回 ok:false（绝不猜默认 token）。
 */
export function discoverOneBotEndpoint(homeDir, { accountUin = null } = {}) {
  if (!homeDir) return { ok: false, error: '没有配置 snowlumaHomeDir' }
  const configDir = path.join(String(homeDir), 'config')
  let entries
  try { entries = fs.readdirSync(configDir, { withFileTypes: true }) } catch (error) {
    return { ok: false, error: `读不到 SnowLuma config 目录：${error?.message ?? error}` }
  }
  const candidates = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const match = /^onebot_(\d+)\.json$/i.exec(entry.name)
    if (!match) continue
    candidates.push({ uin: match[1], file: path.join(configDir, entry.name) })
  }
  const picked = accountUin == null
    ? candidates
    : candidates.filter((c) => String(c.uin) === String(accountUin))
  if (!picked.length) {
    return { ok: false, error: accountUin == null ? 'SnowLuma config 里没有 onebot_<uin>.json' : `没有账号 ${accountUin} 的 OneBot 配置` }
  }
  const first = picked[0]
  try {
    let text = fs.readFileSync(first.file, 'utf8')
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)
    const cfg = JSON.parse(text)
    const ws = cfg?.networks?.wsServers?.[0]
    if (!ws) return { ok: false, error: `${path.basename(first.file)} 没有 networks.wsServers[0]` }
    const host = !ws.host || ws.host === '0.0.0.0' || ws.host === '::' ? '127.0.0.1' : String(ws.host)
    const port = Number(ws.port) || 3001
    return { ok: true, uin: first.uin, wsUrl: `ws://${host}:${port}${DEFAULT_PATH}`, token: String(ws.accessToken ?? ''), file: first.file }
  } catch (error) {
    return { ok: false, error: `解析 ${path.basename(first.file)} 失败：${error?.message ?? error}` }
  }
}

function bind(ws, type, handler) {
  if (typeof ws.addEventListener === 'function') ws.addEventListener(type, handler)
  else ws[`on${type}`] = handler
}

/**
 * 创建只读入站连接器。
 * @param {object} options
 * @param {string} options.url                OneBot WS 地址（token 会拼进 query，不入日志）
 * @param {string} [options.token]
 * @param {class}  [options.WebSocketImpl]    注入实现（测试用；默认 globalThis.WebSocket）
 * @param {(event:object)=>void} options.onEvent  每收到一个 OneBot 事件调用一次（含 meta_event）
 */
export function createInboundConnector({
  url,
  token = '',
  WebSocketImpl = globalThis.WebSocket,
  now = () => Date.now(),
  log = () => {},
  onEvent = () => {},
  reconnectMinMs = 1000,
  reconnectMaxMs = 30_000,
  handshakeTimeoutMs = 10_000,
  heartbeatStaleMs = HEARTBEAT_STALE_MS,
} = {}) {
  const safeUrl = sanitizeUrl(url)
  const target = withToken(url, token)
  const state = {
    url: safeUrl,
    state: 'idle', // idle | connecting | open | closed | error | stopped
    attempts: 0,
    reconnects: 0,
    lastError: null,
    connectedAt: null,
    lastPacketAt: null,
    lastEventAt: null,
    receivedFrames: 0,
    /** 只读不变量：这个连接器从创建到销毁，客户端发出的帧数恒为 0。 */
    framesSent: 0,
    seenSelfId: null,
  }
  let ws = null
  let started = false
  let stopped = false
  let timer = null
  let handshakeTimer = null

  function scheduleReconnect() {
    if (stopped || !started) return
    const attempt = Math.max(1, state.attempts)
    const base = Math.min(reconnectMaxMs, reconnectMinMs * 2 ** Math.min(10, attempt - 1))
    const delay = Math.round(base + base * 0.2 * Math.random())
    state.reconnects += 1
    clearTimeout(timer)
    timer = setTimeout(connect, delay)
    if (typeof timer.unref === 'function') timer.unref()
  }

  function down(code, error = null) {
    clearTimeout(handshakeTimer)
    if (error) state.lastError = String(error?.message ?? error)
    if (state.state === 'stopped') return
    state.state = 'closed'
    state.connectedAt = null
    log({ msg: 'qq.ws.closed', code: code ?? null, error: state.lastError, url: safeUrl })
    scheduleReconnect()
  }

  function connect() {
    if (stopped || !started) return
    if (!WebSocketImpl) {
      state.state = 'error'
      state.lastError = '当前 Node 没有 WebSocket 实现'
      log({ level: 'error', msg: 'qq.ws.no-impl', error: state.lastError })
      return
    }
    state.state = 'connecting'
    state.attempts += 1
    let socket
    try {
      socket = new WebSocketImpl(target)
    } catch (error) {
      state.state = 'closed'
      state.lastError = String(error?.message ?? error)
      log({ level: 'error', msg: 'qq.ws.connect-fail', error: state.lastError, url: safeUrl })
      scheduleReconnect()
      return
    }
    ws = socket
    let downHandled = false
    const finish = (code, error) => {
      if (downHandled) return
      downHandled = true
      if (ws !== socket) return
      ws = null
      down(code, error)
    }

    // 握手超时：端口开了但不回 101 时，Node 的 WebSocket 会一直挂着
    handshakeTimer = setTimeout(() => {
      if (ws !== socket || state.state === 'open') return
      log({ level: 'warn', msg: 'qq.ws.handshake-timeout', url: safeUrl, timeoutMs: handshakeTimeoutMs })
      try { socket.close() } catch { /* 已断开 */ }
      finish(1006, new Error('握手超时'))
    }, Math.max(1000, handshakeTimeoutMs))
    if (typeof handshakeTimer.unref === 'function') handshakeTimer.unref()

    bind(socket, 'open', () => {
      if (ws !== socket) return
      clearTimeout(handshakeTimer)
      state.state = 'open'
      state.connectedAt = now()
      state.lastPacketAt = now()
      state.lastError = null
      state.attempts = 0
      log({ msg: 'qq.ws.open', url: safeUrl })
    })
    bind(socket, 'message', (frame) => {
      if (ws !== socket) return
      state.receivedFrames += 1
      state.lastPacketAt = now()
      let data
      try { data = JSON.parse(typeof frame?.data === 'string' ? frame.data : String(frame?.data ?? '')) } catch {
        state.lastError = '收到非 JSON 帧'
        log({ level: 'warn', msg: 'qq.ws.bad-frame', url: safeUrl })
        return
      }
      if (!data || typeof data !== 'object') return
      // echo 回执：只读链路从不发动作，正常收不到；收到也只当作心跳，不回应
      if (data.post_type === undefined) return
      if (data.self_id != null && state.seenSelfId == null) state.seenSelfId = String(data.self_id)
      if (data.post_type === 'meta_event') {
        // lifecycle/heartbeat：连接健康，不是消息；onEvent 也可以用来更新状态
        onEvent(data)
        return
      }
      state.lastEventAt = now()
      try { onEvent(data) } catch (error) {
        state.lastError = String(error?.message ?? error)
        log({ level: 'error', msg: 'qq.ws.handler-fail', error: state.lastError })
      }
    })
    bind(socket, 'close', (event) => finish(event?.code, null))
    bind(socket, 'error', (event) => {
      // 已连上之后的 error 通常紧跟 close；还没连上时它可能是唯一信号，必须当失败处理
      const error = event?.message ?? event?.error ?? 'ws error'
      if (state.state !== 'open') finish(1006, error)
      else state.lastError = String(error?.message ?? error)
    })
  }

  return {
    start() {
      if (started) return { started: false, already: true }
      started = true
      stopped = false
      connect()
      return { started: true }
    },
    stop() {
      stopped = true
      started = false
      clearTimeout(timer)
      clearTimeout(handshakeTimer)
      state.state = 'stopped'
      const socket = ws
      ws = null
      try { socket?.close() } catch { /* 已断开 */ }
      return { stopped: true }
    },
    status() {
      const at = now()
      const stale = state.state === 'open' && state.lastPacketAt != null && at - state.lastPacketAt > heartbeatStaleMs
      return {
        url: safeUrl,
        state: state.state,
        connected: state.state === 'open',
        stale,
        attempts: state.attempts,
        reconnects: state.reconnects,
        lastError: state.lastError,
        connectedAt: state.connectedAt,
        lastPacketAt: state.lastPacketAt,
        lastEventAt: state.lastEventAt,
        receivedFrames: state.receivedFrames,
        framesSent: state.framesSent,
        seenSelfId: state.seenSelfId,
      }
    },
    /** 只读不变量：客户端帧数。 */
    framesSent: () => state.framesSent,
    get state() { return { ...state } },
  }
}
