// qq：只读入站影子（OneBot / SnowLuma → ICL signals）。
//
// 本轮定位（docs/QQ.md §7 的落地顺序第 1 步）：
//   · **只收私聊、只进 signals、不发任何 QQ 消息**；群消息整类忽略（连只读都不接）。
//   · 默认 `enabled:false`：不显式打开就完全不建连接。
//   · 出站是另一个文件（outbound.mjs），三把钥匙 + 默认关闭；本插件**没有发送调用**：
//     只 import `sendEnabled`/`SEND_APPROVAL_TOKEN` 两个纯判定用于状态展示，不 import `createOutbound`、不调 `sendPrivate`。
//
// 与 ICL 现有接缝的关系：
//   OneBot WS ──connector──► gate(白名单/去重/限流/过期) ──► ctx.signals.offer
//                                                              │
//                                          time gate（睡眠/暂停/静音锁）
//                                                              ▼
//                                          host.setDeliver → focus.admit → delivery
//                                                              ▼
//                                          bridge tick → agent.steer（plugin:qq notice）
//
// 刻意不在这个插件里做的事：读 time 的 phase、绕过 gate 直接 delivery.push、自己维护"未读水位"、
// 下载图片/语音、启动或停止 SnowLuma、读写 SnowLuma 配置。
import fs from 'node:fs'
import path from 'node:path'
import { createInboundConnector, discoverOneBotEndpoint, sanitizeUrl } from './connector.mjs'
import { createDedupeStore, createInboundGate } from './gate.mjs'
import { SEND_APPROVAL_TOKEN, sendEnabled } from './outbound.mjs'

export const name = 'qq'

const DEFAULTS = Object.freeze({
  // 总开关：不显式 true 就完全不连
  enabled: false,
  // 上游：显式 url/token，或只读发现 SnowLuma 目录（snowlumaHomeDir 优先）
  url: '',
  token: '',
  snowlumaHomeDir: '',
  accountUin: null,
  // 自己/收件人
  selfId: null,
  allowPrivate: [],
  allowAllPrivate: false,
  // 准入闸门
  maxPerMinute: 30,
  maxStaleMs: 600_000,
  deliverBackfill: false,
  maxTextChars: 2000,
  // 去重与重试
  dedupeWindowMs: 86_400_000,
  dedupeLimit: 5000,
  dedupeFile: '',
  retryMax: 200,
  retryTickMs: 2000,
  retryMaxAttempts: 5,
  signalTtlMs: 1_800_000,
  // 观测/记录
  recordFile: '',
  statusFile: '',
  statusIntervalMs: 5000,
  promptLine: false,
  // 连接
  reconnectMinMs: 1000,
  reconnectMaxMs: 30_000,
  heartbeatStaleMs: 95_000,
  // 出站（phase 1「只回私聊」；默认全关）
  allowSend: false,
  sendApproval: '',
  ownerQQ: null,
  auditFile: '',
  sendTimeoutMs: 15_000,
  sendMinIntervalMs: 5000,
  sendMaxPerMinute: 10,
  sendSameTextWindowMs: 60_000,
  maxSendsPerTurn: 1,
  maxSendChars: 2000,
  sensitivePatterns: null,
  // 测试/lab 注入点：默认用 globalThis.WebSocket
  webSocketImpl: null,
})

function pickList(value) {
  if (value == null) return []
  return (Array.isArray(value) ? value : [value]).map(String).filter((s) => s.trim() !== '')
}

/** 配置规范化：只接受白名单字段，数字/布尔做兜底。 */
export function normalizeQqConfig(input = {}) {
  const cfg = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    if (input[key] !== undefined) cfg[key] = input[key]
  }
  cfg.enabled = cfg.enabled === true
  cfg.allowAllPrivate = cfg.allowAllPrivate === true
  cfg.deliverBackfill = cfg.deliverBackfill === true
  cfg.promptLine = cfg.promptLine === true
  cfg.allowSend = cfg.allowSend === true
  cfg.allowPrivate = pickList(cfg.allowPrivate)
  for (const key of ['maxPerMinute', 'maxStaleMs', 'maxTextChars', 'dedupeWindowMs', 'dedupeLimit', 'retryMax', 'retryTickMs', 'retryMaxAttempts', 'signalTtlMs', 'reconnectMinMs', 'reconnectMaxMs', 'heartbeatStaleMs', 'statusIntervalMs', 'sendTimeoutMs', 'sendMinIntervalMs', 'sendMaxPerMinute', 'sendSameTextWindowMs', 'maxSendsPerTurn', 'maxSendChars']) {
    const n = Number(cfg[key])
    cfg[key] = Number.isFinite(n) && n >= 0 ? n : DEFAULTS[key]
  }
  cfg.url = String(cfg.url ?? '')
  cfg.token = String(cfg.token ?? '')
  cfg.snowlumaHomeDir = String(cfg.snowlumaHomeDir ?? '')
  cfg.accountUin = cfg.accountUin == null ? null : String(cfg.accountUin)
  cfg.selfId = cfg.selfId == null ? null : String(cfg.selfId)
  cfg.ownerQQ = cfg.ownerQQ == null || String(cfg.ownerQQ).trim() === '' ? null : String(cfg.ownerQQ).trim()
  cfg.auditFile = String(cfg.auditFile ?? '')
  cfg.sensitivePatterns = Array.isArray(input.sensitivePatterns) ? input.sensitivePatterns.map(String) : null
  cfg.dedupeFile = String(cfg.dedupeFile ?? '')
  cfg.recordFile = String(cfg.recordFile ?? '')
  cfg.statusFile = String(cfg.statusFile ?? '')
  cfg.sendApproval = String(cfg.sendApproval ?? '')
  cfg.webSocketImpl = typeof input.webSocketImpl === 'function' ? input.webSocketImpl : null
  return cfg
}

function resolvePath(file) {
  return path.isAbsolute(file) ? file : path.resolve(process.cwd(), file)
}

/** 端点解析：SnowLuma 只读发现优先于显式 url（发现失败再退回 url）。 */
export function resolveEndpoint(cfg, log = () => {}) {
  if (cfg.snowlumaHomeDir) {
    const found = discoverOneBotEndpoint(cfg.snowlumaHomeDir, { accountUin: cfg.accountUin })
    if (found.ok) {
      log({ msg: 'qq.endpoint.discovered', uin: found.uin, url: sanitizeUrl(found.wsUrl), file: path.basename(found.file) })
      return { ok: true, url: found.wsUrl, token: found.token, uin: found.uin, source: 'snowluma' }
    }
    log({ level: 'warn', msg: 'qq.endpoint.discover-fail', error: found.error })
  }
  if (cfg.url) return { ok: true, url: cfg.url, token: cfg.token, uin: cfg.accountUin, source: 'config' }
  return { ok: false, error: '没有可用的上游：配置 url 或 snowlumaHomeDir' }
}

export async function apply(ctx) {
  const cfg = normalizeQqConfig(ctx.config ?? {})
  // 原始 config 引用：kill switch 每次调用重读它（运行中把 allowSend 改成 false 立即生效）
  const liveConfig = ctx.config ?? {}
  const now = () => ctx.now()
  const dedupe = createDedupeStore({
    now,
    windowMs: cfg.dedupeWindowMs,
    limit: cfg.dedupeLimit,
    file: cfg.dedupeFile ? resolvePath(cfg.dedupeFile) : null,
  })
  const dedupeLoad = dedupe.load()
  if (dedupeLoad.error) ctx.log({ level: 'warn', msg: 'qq.dedupe.load', error: dedupeLoad.error })

  const gate = createInboundGate({
    now,
    allowPrivate: cfg.allowPrivate,
    allowAllPrivate: cfg.allowAllPrivate,
    selfId: cfg.selfId,
    maxStaleMs: cfg.maxStaleMs,
    deliverBackfill: cfg.deliverBackfill,
    maxPerMinute: cfg.maxPerMinute,
    maxTextChars: cfg.maxTextChars,
    dedupe,
  })

  // 只有 deliver 失败（会话切换/下游抛错）才进这个短队列；被 time gate 拦下不算失败。
  const retry = []
  const stats = {
    frames: 0,
    meta: 0,
    accepted: 0,
    delivered: 0,
    dedupedAtSignals: 0,
    blocked: 0,
    blockedReasons: {},
    expired: 0,
    retryQueued: 0,
    retryDropped: 0,
    recorded: 0,
    recordErrors: 0,
    // 只读观测：最近一条进来的私聊 / 最近一次丢弃 / 最近一次被 time 锁拦下
    recent: { lastAccepted: null, lastDropped: null, lastBlocked: null },
  }
  let connector = null
  let endpoint = null
  let retryTimer = null
  let disposed = false
  // phase 1 出站：只有三把钥匙打开时才动态装配（index 不静态 import 发送实现）
  let sendHandle = null

  /** 三把钥匙是否打开；每次都重读 live config（kill switch 立即生效）。 */
  function sendKeysNow() {
    return sendEnabled({ enabled: liveConfig.enabled, allowSend: liveConfig.allowSend, sendApproval: liveConfig.sendApproval })
  }

  async function startSend() {
    if (!sendKeysNow()) {
      ctx.log({ msg: 'qq.send.disabled', reason: '三把钥匙未齐（enabled/allowSend/sendApproval）' })
      return
    }
    if (!endpoint?.ok) {
      ctx.log({ level: 'error', msg: 'qq.send.no-upstream', error: endpoint?.error ?? '没有上游端点' })
      return
    }
    try {
      const { registerSendTool } = await import('./send-tool.mjs')
      sendHandle = await registerSendTool({
        ctx,
        cfg,
        liveConfig,
        endpoint,
        now,
        log: (entry) => ctx.log({ plugin: 'qq', ...entry }),
      })
      ctx.log({ msg: 'qq.send.enabled', owner: cfg.ownerQQ ?? null, allowPrivate: cfg.allowPrivate, audit: cfg.auditFile || null })
    } catch (error) {
      // 出站装配失败不拖垮只读入站；必须留痕（不能静默半残）
      ctx.log({ level: 'error', msg: 'qq.send.start-fail', error: String(error?.stack ?? error) })
      sendHandle = null
    }
  }

  const recordFile = cfg.recordFile ? resolvePath(cfg.recordFile) : ''
  const statusFile = cfg.statusFile ? resolvePath(cfg.statusFile) : ''
  let statusTimer = null

  /** 影子状态落盘：给 lab / runbook 一个"不看进程也能判断在不在听"的出口（原子写）。 */
  function writeStatusFile() {
    if (!statusFile) return
    try {
      fs.mkdirSync(path.dirname(statusFile), { recursive: true })
      const tmp = `${statusFile}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ at: now(), ...status() }, null, 1), 'utf8')
      fs.renameSync(tmp, statusFile)
    } catch (error) {
      ctx.log({ level: 'warn', msg: 'qq.status-file', error: String(error?.message ?? error) })
    }
  }

  function record(row) {
    if (!recordFile) return
    try {
      fs.mkdirSync(path.dirname(recordFile), { recursive: true })
      fs.appendFileSync(recordFile, `${JSON.stringify({ at: now(), ...row })}\n`, 'utf8')
      stats.recorded += 1
    } catch (error) {
      // 记录失败不阻塞入站，但必须留痕（影子实验的证据不能静默丢）
      stats.recordErrors += 1
      ctx.log({ level: 'warn', msg: 'qq.record-fail', error: String(error?.message ?? error) })
    }
  }

  function bump(map, key) { map[key] = (map[key] ?? 0) + 1 }

  function enqueueRetry(signal, reason) {
    stats.retryQueued += 1
    if (retry.length >= cfg.retryMax) {
      const dropped = retry.shift()
      stats.retryDropped += 1
      record({ kind: 'retry-dropped', id: dropped?.signal?.id ?? null, reason: 'queue-full' })
    }
    retry.push({ signal, reason: String(reason ?? ''), attempts: 0, nextAt: now() + 500 })
  }

  function offer(signal) {
    let out
    try {
      out = ctx.signals.offer(signal)
    } catch (error) {
      ctx.log({ level: 'error', msg: 'qq.signals.offer-fail', error: String(error?.message ?? error) })
      out = { accepted: false, error: String(error?.message ?? error) }
    }
    if (out?.accepted) { stats.delivered += 1; return 'delivered' }
    if (out?.deduped) { stats.dedupedAtSignals += 1; return 'deduped' }
    // gate 拦下（time 睡眠/暂停/静音锁）：**不重试**。time 的 gate 已把内容抄进它自己
    // 持久化的 backlog（time/src/index.mjs enqueue），醒来/恢复时统一重放；我们重试会双投。
    if (out?.blocked) {
      stats.blocked += 1
      bump(stats.blockedReasons, out.reason ?? 'gate')
      stats.recent.lastBlocked = { at: now(), reason: String(out.reason ?? 'gate'), id: signal.id }
      record({ kind: 'blocked', id: signal.id, reason: out.reason ?? 'gate' })
      return 'blocked'
    }
    if (out?.expired) {
      stats.expired += 1
      record({ kind: 'expired', id: signal.id })
      return 'expired'
    }
    enqueueRetry(signal, out?.error ?? 'deliver-failed')
    return 'retry'
  }

  function handleEvent(raw) {
    if (disposed) return
    stats.frames += 1
    if (raw?.post_type === 'meta_event') {
      stats.meta += 1
      connector?.onMeta?.() // 保留扩展点：当前只更新连接器内部 lastPacketAt
      return
    }
    const decision = gate.admit(raw, { receivedAt: now() })
    if (!decision.accept) {
      stats.recent.lastDropped = { at: decision.receivedAt, code: decision.code }
      // 群消息不落记录（整类忽略，避免把群内容写进影子证据文件）
      if (!['group', 'meta', 'not-message', 'invalid'].includes(decision.code)) {
        record({ kind: 'dropped', code: decision.code, at: decision.receivedAt })
      }
      return
    }
    const signal = decision.signal
    stats.accepted += 1
    stats.recent.lastAccepted = {
      at: decision.messageAt,
      receivedAt: decision.receivedAt,
      peerId: decision.peerId,
      senderName: decision.senderName,
      messageId: decision.messageId,
      text: String(signal.text ?? '').slice(0, 80),
    }
    signal.expiresAt = decision.receivedAt + cfg.signalTtlMs
    record({
      kind: 'accepted',
      id: signal.id,
      text: signal.text,
      messageAt: decision.messageAt,
      receivedAt: decision.receivedAt,
      peerId: decision.peerId,
      messageId: decision.messageId,
      segments: signal.meta.qq.segments,
    })
    offer(signal)
  }

  function retryTick() {
    if (!retry.length || disposed) return
    const at = now()
    for (let i = retry.length - 1; i >= 0; i -= 1) {
      const item = retry[i]
      if (at < item.nextAt) continue
      if (item.signal.expiresAt != null && at >= item.signal.expiresAt) {
        retry.splice(i, 1)
        stats.retryDropped += 1
        record({ kind: 'retry-dropped', id: item.signal.id, reason: 'expired' })
        continue
      }
      let out
      try { out = ctx.signals.offer(item.signal) } catch (error) {
        ctx.log({ level: 'error', msg: 'qq.retry.offer-fail', error: String(error?.message ?? error) })
        out = { accepted: false, error: String(error?.message ?? error) }
      }
      if (out?.accepted) { retry.splice(i, 1); stats.delivered += 1; continue }
      if (out?.deduped) { retry.splice(i, 1); stats.dedupedAtSignals += 1; continue }
      if (out?.blocked) {
        // 重试时才发现时间锁：交给 time 的 backlog，不继续重试
        retry.splice(i, 1)
        stats.blocked += 1
        bump(stats.blockedReasons, out.reason ?? 'gate')
        record({ kind: 'blocked', id: item.signal.id, reason: out.reason ?? 'gate' })
        continue
      }
      if (out?.expired) { retry.splice(i, 1); stats.expired += 1; continue }
      item.attempts += 1
      if (item.attempts >= cfg.retryMaxAttempts) {
        retry.splice(i, 1)
        stats.retryDropped += 1
        record({ kind: 'retry-dropped', id: item.signal.id, reason: 'max-attempts' })
        continue
      }
      item.nextAt = at + Math.min(60_000, 500 * 2 ** (item.attempts - 1))
    }
  }

  function start() {
    if (!cfg.enabled) {
      ctx.log({ msg: 'qq.disabled', reason: 'enabled=false' })
      return
    }
    endpoint = resolveEndpoint(cfg, (entry) => ctx.log(entry))
    if (!endpoint.ok) {
      ctx.log({ level: 'error', msg: 'qq.no-upstream', error: endpoint.error })
      return
    }
    connector = createInboundConnector({
      url: endpoint.url,
      token: endpoint.token,
      WebSocketImpl: cfg.webSocketImpl ?? globalThis.WebSocket,
      now,
      log: (entry) => ctx.log({ plugin: 'qq', ...entry }),
      onEvent: handleEvent,
      reconnectMinMs: cfg.reconnectMinMs,
      reconnectMaxMs: cfg.reconnectMaxMs,
      heartbeatStaleMs: cfg.heartbeatStaleMs,
    })
    connector.start()
    ctx.log({ msg: 'qq.inbound-start', url: sanitizeUrl(endpoint.url), uin: endpoint.uin ?? null, source: endpoint.source, groups: 'ignored', send: sendKeysNow() ? 'enabled(phase1)' : 'disabled' })
    retryTimer = setInterval(retryTick, Math.max(200, cfg.retryTickMs))
    if (typeof retryTimer.unref === 'function') retryTimer.unref()
    if (statusFile) {
      writeStatusFile()
      statusTimer = setInterval(writeStatusFile, Math.max(500, cfg.statusIntervalMs))
      if (typeof statusTimer.unref === 'function') statusTimer.unref()
    }
  }

  function status() {
    const conn = connector?.status() ?? {
      url: null, state: cfg.enabled ? 'not-connected' : 'disabled', connected: false, stale: false,
      attempts: 0, reconnects: 0, lastError: null, connectedAt: null, lastPacketAt: null,
      lastEventAt: null, receivedFrames: 0, framesSent: 0, seenSelfId: null,
    }
    return {
      enabled: cfg.enabled,
      sendEnabled: sendKeysNow(),
      send: sendHandle ? sendHandle.status() : { registered: false, enabled: false },
      url: conn.url ? sanitizeUrl(conn.url) : null,
      connection: conn,
      selfId: cfg.selfId ?? conn.seenSelfId ?? null,
      allowPrivate: [...cfg.allowPrivate],
      allowAllPrivate: cfg.allowAllPrivate,
      groupPolicy: 'ignore',
      gate: gate.counters(),
      stats: { ...stats, blockedReasons: { ...stats.blockedReasons }, retryPending: retry.length, recent: { ...stats.recent } },
      recordFile: recordFile || null,
      statusFile: statusFile || null,
      dedupe: { size: dedupe.size(), file: cfg.dedupeFile || null },
      readOnlyInvariant: { framesSent: conn.framesSent ?? 0, expected: 0 },
    }
  }

  function statusText() {
    const s = status()
    const c = s.connection
    const lines = []
    if (!s.enabled) lines.push('QQ 只读影子：未启用（enabled=false，没有建任何连接）。')
    else if (c.connected) lines.push(`QQ 只读影子：已连接 ${s.url}${c.stale ? '（心跳过期，可能已掉线）' : ''}。`)
    else lines.push(`QQ 只读影子：未连接（state=${c.state}${c.lastError ? `，最近错误：${c.lastError}` : ''}）。`)
    lines.push(`机器人账号：${s.selfId ?? '未知'}；可收私聊：${s.allowAllPrivate ? '全部（显式打开）' : (s.allowPrivate.length ? s.allowPrivate.join('、') : '无（白名单为空）')}；群消息：整类忽略`)
    const g = s.gate
    lines.push(`准入：收到 ${g.received} 条，放行 ${g.accepted} 条；去重 ${g.byCode.duplicate ?? 0}，限流 ${g.byCode.rate ?? 0}，白名单外 ${g.byCode['not-allowlisted'] ?? 0}，过旧 ${g.byCode.stale ?? 0}，群 ${g.byCode.group ?? 0}，自发 ${g.byCode.self ?? 0}，空 ${g.byCode.empty ?? 0}`)
    const blocked = Object.entries(s.stats.blockedReasons).map(([k, v]) => `${k}×${v}`).join('、')
    lines.push(`投递：进 signals/delivery ${s.stats.delivered} 条${s.stats.dedupedAtSignals ? `，signals 去重 ${s.stats.dedupedAtSignals}` : ''}${blocked ? `；被静音/睡眠锁拦下 ${blocked}（已交给 time 的积压，不重试）` : ''}${s.stats.expired ? `；过期 ${s.stats.expired}` : ''}；待重试 ${s.stats.retryPending}`)
    // 最近一条：谁、什么时候、有没有被拦（只读，影子抽查用）
    const stamp = (at) => { try { return new Date(Number(at)).toLocaleTimeString('zh-CN', { hour12: false }) } catch { return '?' } }
    const recent = s.stats.recent ?? {}
    if (recent.lastAccepted) {
      const a = recent.lastAccepted
      lines.push(`最近一条私聊：${stamp(a.at)} ${a.senderName}（${a.peerId}）${a.messageId ? ` #${a.messageId}` : ''}：${a.text}`)
    } else {
      lines.push('最近一条私聊：还没有')
    }
    if (recent.lastBlocked) lines.push(`最近被 time 锁拦下：${stamp(recent.lastBlocked.at)}（${recent.lastBlocked.reason}）`)
    if (recent.lastDropped) lines.push(`最近被本地闸门丢弃：${stamp(recent.lastDropped.at)}（${recent.lastDropped.code}）`)
    if (s.recordFile) lines.push(`影子记录：${s.recordFile}（已写 ${s.stats.recorded} 行${s.stats.recordErrors ? `，写失败 ${s.stats.recordErrors}` : ''}）`)
    const send = s.send ?? {}
    if (send.registered) {
      const recent = send.recent
      const outcomeText = recent ? `最近一次发送：${stamp(recent.at)} → ${recent.peerId}，结果=${recent.outcome}${recent.messageId ? `，messageId=${recent.messageId}` : ''}${recent.error ? `（${recent.error}）` : ''}` : '最近一次发送：还没有'
      const counts = send.counts ?? {}
      lines.push(`出站：已启用（phase 1 只回 owner/白名单私聊；本轮已发 ${send.perTurn?.sent ?? 0}/${send.perTurn?.limit ?? '?'} 条；累计 ok ${counts.ok ?? 0} / rejected ${counts.rejected ?? 0} / unknown ${counts.unknown ?? 0} / 拒绝 ${counts.refused ?? 0}）`)
      lines.push(`${outcomeText}${send.auditFile ? `；审计：${send.auditFile}` : ''}`)
      if (send.transport) lines.push(`出站连接：${send.transport.connected ? '已连接' : send.transport.state}；客户端已发帧 ${send.transport.framesSent ?? 0}；在途 ${send.transport.pending ?? 0}`)
    } else {
      lines.push(`出站：关闭（三把钥匙未齐：enabled+allowSend+sendApproval=${SEND_APPROVAL_TOKEN}）；本插件不含发送工具`)
    }
    lines.push(`只读不变量：入站连接客户端已发帧 ${s.connection.framesSent ?? 0}（应为 0；出站连接单独统计）`)
    return lines.join('\n')
  }

  ctx.tools.register({
    name: 'qq_status',
    summary: sendKeysNow()
      ? 'Check the QQ link: connection, inbound receipt stats, and the last outbound send result (ok / rejected / unknown).'
      : 'Check the read-only QQ link: whether it is connected, what it received, what it dropped and why.',
    when: ['you want to know whether QQ private messages are reaching you', 'a QQ message seemed missing', 'you want to know whether your last QQ reply went out'],
    avoid: ['expecting to send through this tool - sending is a separate qq_send tool'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute() { return { text: statusText() } },
  })

  // 给 driver / 测试读的共享能力（不暴露给模型）
  let offShared = null
  try {
    offShared = ctx.services.provide('qq', {
      status,
      statusText,
      gateCounters: () => gate.counters(),
      sendStatus: () => sendHandle?.status() ?? null,
      killSend: (reason = 'manual') => sendHandle?.killSwitch(reason) ?? { allowSend: liveConfig.allowSend },
    })
  } catch (error) {
    ctx.log({ level: 'warn', msg: 'qq.shared.provide-fail', error: String(error?.message ?? error) })
  }

  if (cfg.promptLine) {
    ctx.prompt.section({
      name: 'qq:shadow',
      order: 40,
      text: () => {
        const s = status()
        if (!s.enabled || !s.connection.connected) return ''
        if (s.send?.registered) return `QQ 已连接：本轮收到 ${s.stats.delivered} 条私聊；可以调用 qq_send 回一条（只能回 owner/白名单私聊，每轮最多 ${s.send.perTurn?.limit ?? 1} 条）。`
        return `QQ 只读影子：已连接，本轮收到 ${s.stats.delivered} 条私聊（不能回复）。`
      },
    })
  }

  start()
  await startSend()

  ctx.onDispose(() => {
    disposed = true
    if (retryTimer) { clearInterval(retryTimer); retryTimer = null }
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null }
    try { sendHandle?.dispose() } catch (error) {
      ctx.log({ level: 'warn', msg: 'qq.send.dispose', error: String(error?.message ?? error) })
    }
    sendHandle = null
    try { connector?.stop() } catch (error) {
      ctx.log({ level: 'warn', msg: 'qq.connector.stop', error: String(error?.message ?? error) })
    }
    connector = null
    writeStatusFile()
    const flushed = gate.flush()
    if (flushed?.error) ctx.log({ level: 'warn', msg: 'qq.dedupe.save', error: flushed.error })
    try { offShared?.() } catch { /* 注销器已执行 */ }
    ctx.log({ msg: 'qq.disposed', delivered: stats.delivered, blocked: stats.blocked, dropped: gate.counters().byCode })
  })

  return { status, statusText, sendStatus: () => sendHandle?.status() ?? null, killSend: (reason) => sendHandle?.killSwitch(reason) ?? null }
}
