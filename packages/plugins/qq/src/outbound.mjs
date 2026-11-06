// 出站（发 QQ 私聊）：phase 1「只回私聊」的最小实现。
//
// 三层边界，缺一不可：
//   1. 三把钥匙（本文件 `sendEnabled`）：enabled + allowSend + sendApproval==='lead-approved'
//   2. 目标白名单 + owner（`checkSendTarget`）：**只允许私聊、只允许 owner/白名单**；群永远拒绝
//   3. 内容边界（`checkSendContent`）：空/超长/敏感信息直接拒绝
//
// 传输只用 OneBot v11 正向 WS 的 `send_private_msg` 动作（echo 配对）：
//   · retcode===0 且有 message_id → `{ok:true, outcome:'ok'}`
//   · 后端明确拒绝 → `{ok:false, outcome:'rejected'}`
//   · 超时/连接断/没有回执 → `{ok:false, outcome:'unknown'}`（**不自动重试**：OneBot 没有幂等键，盲重试会双发）
//
// 本文件只被 `send-tool.mjs` 使用；`index.mjs` 不 import 它（静态安全测试守着）。
import { createHash } from 'node:crypto'
import { withToken } from './connector.mjs'

export const SEND_APPROVAL_TOKEN = 'lead-approved'

/** phase 1 的默认敏感信息模式（可用 cfg.sensitivePatterns 覆盖为字符串数组）。 */
export const DEFAULT_SENSITIVE_PATTERNS = Object.freeze([
  /\b(?:api[_-]?key|access[_-]?token|secret|password|passwd)\s*[:=：]/i,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /-----BEGIN[^-]*PRIVATE KEY-----/,
])

/** 三把钥匙是否都打开了（纯判定；参数既可以是原始 config，也可以是规范化后的 cfg）。 */
export function sendEnabled(cfg = {}) {
  return cfg.enabled === true && cfg.allowSend === true && cfg.sendApproval === SEND_APPROVAL_TOKEN
}

/** 目标校验：只私聊、只白名单/owner；群永远拒绝。 */
export function checkSendTarget(cfg = {}, peerId) {
  if (!sendEnabled(cfg)) return { ok: false, error: '出站未启用（需要 enabled + allowSend + sendApproval=lead-approved）' }
  const peer = String(peerId ?? '').trim()
  if (!peer) return { ok: false, error: '没有私聊目标' }
  if (!/^\d+$/.test(peer)) return { ok: false, error: `目标必须是 QQ 号（私聊），不能是「${peer}」` }
  const allow = new Set((Array.isArray(cfg.allowPrivate) ? cfg.allowPrivate : []).map(String))
  if (!allow.has(peer)) return { ok: false, error: `目标 ${peer} 不在私聊白名单里` }
  if (cfg.ownerQQ != null && String(cfg.ownerQQ) !== peer) {
    return { ok: false, error: `phase 1 只允许回 owner（${cfg.ownerQQ}）` }
  }
  return { ok: true, peer }
}

/** 内容边界：纯文本、非空、不超长、无敏感信息。 */
export function checkSendContent(cfg = {}, text) {
  const body = String(text ?? '').trim()
  if (!body) return { ok: false, error: '空消息不发送' }
  const max = Number(cfg.maxSendChars)
  const limit = Number.isFinite(max) && max > 0 ? max : 2000
  if (body.length > limit) return { ok: false, error: `内容过长（${body.length} > ${limit} 字），未发送` }
  const patterns = Array.isArray(cfg.sensitivePatterns) && cfg.sensitivePatterns.length
    ? cfg.sensitivePatterns.map((p) => (p instanceof RegExp ? p : new RegExp(String(p), 'i')))
    : DEFAULT_SENSITIVE_PATTERNS
  for (const pattern of patterns) {
    if (pattern.test(body)) return { ok: false, error: '内容含敏感信息，未发送' }
  }
  return { ok: true, text: body }
}

export function textHash(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 16)
}

/** 把 OneBot 动作回执归一成三态（供 send-tool 写审计/回话）。 */
export function classifyReply(reply) {
  if (!reply || typeof reply !== 'object') return { ok: false, outcome: 'unknown', error: '没有回执' }
  const retcode = reply.retcode
  const failed = reply.status === 'failed' || (retcode != null && Number(retcode) !== 0)
  if (failed) {
    return { ok: false, outcome: 'rejected', error: `后端拒绝：retcode=${retcode ?? '?'} ${reply.wording ?? reply.msg ?? ''}`.trim() }
  }
  const messageId = reply.data?.message_id ?? null
  if (messageId == null) return { ok: false, outcome: 'unknown', error: '回执没有 message_id（不知道是否送达）' }
  return { ok: true, outcome: 'ok', messageId: String(messageId) }
}

function bind(ws, type, handler) {
  if (typeof ws.addEventListener === 'function') ws.addEventListener(type, handler)
  else ws[`on${type}`] = handler
}

/**
 * 出站连接器：只用于动作（echo 配对），与只读入站连接互相独立（SnowLuma 支持多客户端）。
 * 不读事件、不入账；不启动/停止后端。
 */
export function createOutbound({
  url,
  token = '',
  cfg = {},
  WebSocketImpl = globalThis.WebSocket,
  now = () => Date.now(),
  log = () => {},
  requestTimeoutMs = 15_000,
  reconnectMinMs = 1000,
  reconnectMaxMs = 30_000,
} = {}) {
  const target = withToken(url, token)
  const state = {
    state: 'idle',
    attempts: 0,
    reconnects: 0,
    connectedAt: null,
    lastError: null,
    lastActionAt: null,
    framesSent: 0,
    lastSent: null,
  }
  let ws = null
  let started = false
  let stopped = false
  let timer = null
  let echoSeq = 0
  const pending = new Map()

  function failPending(reason, outcome = 'unknown') {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(Object.assign(new Error(reason), { code: 'disconnected', outcome }))
    }
    pending.clear()
  }

  function scheduleReconnect() {
    if (!started || stopped) return
    const base = Math.min(reconnectMaxMs, reconnectMinMs * 2 ** Math.min(10, Math.max(0, state.attempts - 1)))
    const delay = Math.round(base + base * 0.2 * Math.random())
    state.reconnects += 1
    clearTimeout(timer)
    timer = setTimeout(connect, delay)
    if (typeof timer.unref === 'function') timer.unref()
  }

  function connect() {
    if (!started || stopped) return
    if (!WebSocketImpl) {
      state.state = 'error'
      state.lastError = '当前 Node 没有 WebSocket 实现'
      log({ level: 'error', msg: 'qq.outbound.no-impl', error: state.lastError })
      return
    }
    state.state = 'connecting'
    state.attempts += 1
    let socket
    try { socket = new WebSocketImpl(target) } catch (error) {
      state.state = 'closed'
      state.lastError = String(error?.message ?? error)
      log({ level: 'error', msg: 'qq.outbound.connect-fail', error: state.lastError })
      scheduleReconnect()
      return
    }
    ws = socket
    bind(socket, 'open', () => {
      if (ws !== socket) return
      state.state = 'open'
      state.connectedAt = now()
      state.lastError = null
      state.attempts = 0
      log({ msg: 'qq.outbound.open' })
    })
    bind(socket, 'message', (frame) => {
      if (ws !== socket) return
      let data = null
      try { data = JSON.parse(typeof frame?.data === 'string' ? frame.data : String(frame?.data ?? '')) } catch { return }
      if (!data || data.echo == null) return
      const entry = pending.get(String(data.echo))
      if (!entry) return
      pending.delete(String(data.echo))
      clearTimeout(entry.timer)
      entry.resolve(data)
    })
    bind(socket, 'close', (event) => {
      if (ws !== socket) return
      ws = null
      state.state = 'closed'
      state.connectedAt = null
      failPending('出站连接已断开')
      log({ msg: 'qq.outbound.closed', code: event?.code ?? null })
      scheduleReconnect()
    })
    bind(socket, 'error', (event) => {
      state.lastError = String(event?.message ?? event?.error ?? 'ws error')
      if (state.state !== 'open') {
        if (ws === socket) ws = null
        state.state = 'closed'
        failPending('出站连接失败')
        scheduleReconnect()
      }
    })
  }

  function call(action, params = {}) {
    return new Promise((resolve, reject) => {
      if (!ws || state.state !== 'open') {
        reject(Object.assign(new Error('出站连接未就绪'), { code: 'not-connected', outcome: 'unknown' }))
        return
      }
      echoSeq += 1
      const echo = `qqs-${echoSeq}-${Math.random().toString(36).slice(2, 7)}`
      const timer2 = setTimeout(() => {
        pending.delete(echo)
        reject(Object.assign(new Error(`OneBot ${action} 超时（${Math.round(requestTimeoutMs / 1000)}s），结果未知`), { code: 'timeout', outcome: 'unknown' }))
      }, Math.max(100, requestTimeoutMs))
      if (typeof timer2.unref === 'function') timer2.unref()
      pending.set(echo, { resolve, reject, timer: timer2, action })
      try {
        ws.send(JSON.stringify({ action, params, echo }))
        state.framesSent += 1
        state.lastActionAt = now()
      } catch (error) {
        pending.delete(echo)
        clearTimeout(timer2)
        reject(Object.assign(new Error(String(error?.message ?? error)), { code: 'send-failed', outcome: 'unknown' }))
      }
    })
  }

  /** 单条私聊文本（可选 reply 段）。传输与三态归一；目标/内容/限速由 send-tool 上层判定。 */
  async function sendPrivate(peerId, text, { replyToMessageId = null } = {}) {
    const startedAt = now()
    const body = String(text ?? '').trim()
    let message = body
    if (replyToMessageId != null && String(replyToMessageId).trim() !== '') {
      // OneBot 私聊的引用必须用 reply 段（只传 message_id 参数无效）。
      message = [
        { type: 'reply', data: { id: String(replyToMessageId).trim() } },
        { type: 'text', data: { text: body } },
      ]
    }
    log({ msg: 'qq.outbound.attempt', peerId: String(peerId), chars: body.length, replyTo: replyToMessageId == null ? null : String(replyToMessageId) })
    try {
      const reply = await call('send_private_msg', { user_id: Number(peerId), message })
      const verdict = classifyReply(reply)
      const result = { ...verdict, ms: now() - startedAt, at: now(), replyToMessageId: replyToMessageId == null ? null : String(replyToMessageId) }
      state.lastSent = { at: result.at, peerId: String(peerId), outcome: result.outcome, messageId: result.messageId ?? null, ms: result.ms }
      return result
    } catch (error) {
      const outcome = error?.outcome === 'unknown' || error?.code === 'timeout' || error?.code === 'disconnected' ? 'unknown' : 'unknown'
      const result = { ok: false, outcome, error: String(error?.message ?? error), ms: now() - startedAt, at: now() }
      state.lastSent = { at: result.at, peerId: String(peerId), outcome, messageId: null, ms: result.ms }
      return result
    }
  }

  /** 单条私聊图片（表情包）：本地字节 → base64:// 段；不发远程 URL。 */
  async function sendPrivateImage(peerId, { data, mimeType = 'image/png', name = null } = {}) {
    const startedAt = now()
    if (!data || !data.byteLength) return { ok: false, outcome: 'rejected', error: '图片字节为空', ms: 0, at: now() }
    const base64 = Buffer.from(data).toString('base64')
    const message = [{ type: 'image', data: { file: `base64://${base64}`, ...(name ? { name: String(name) } : {}) } }]
    log({ msg: 'qq.outbound.attempt', peerId: String(peerId), kind: 'sticker', bytes: data.byteLength, mimeType })
    try {
      const reply = await call('send_private_msg', { user_id: Number(peerId), message })
      const verdict = classifyReply(reply)
      const result = { ...verdict, ms: now() - startedAt, at: now(), bytes: data.byteLength }
      state.lastSent = { at: result.at, peerId: String(peerId), outcome: result.outcome, messageId: result.messageId ?? null, ms: result.ms }
      return result
    } catch (error) {
      const result = { ok: false, outcome: 'unknown', error: String(error?.message ?? error), ms: now() - startedAt, at: now() }
      state.lastSent = { at: result.at, peerId: String(peerId), outcome: 'unknown', messageId: null, ms: result.ms }
      return result
    }
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
      state.state = 'stopped'
      failPending('出站已停止', 'unknown')
      const socket = ws
      ws = null
      try { socket?.close() } catch { /* 已断 */ }
      return { stopped: true }
    },
    call,
    sendPrivate,
    sendPrivateImage,
    status() {
      return {
        state: state.state,
        connected: state.state === 'open',
        attempts: state.attempts,
        reconnects: state.reconnects,
        lastError: state.lastError,
        connectedAt: state.connectedAt,
        framesSent: state.framesSent,
        lastActionAt: state.lastActionAt,
        lastSent: state.lastSent ? { ...state.lastSent } : null,
        pending: pending.size,
      }
    },
  }
}

export { withToken }
