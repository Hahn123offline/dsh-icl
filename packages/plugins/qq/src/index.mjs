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
import { createLedger } from './ledger.mjs'
import { createOneBotHttp } from './onebot-http.mjs'
import { createBackfill } from './backfill.mjs'
import { createReplyResolver, pendingReplyText, replyContextText } from './reply-cache.mjs'
import { expandForwardIds } from './forward.mjs'
import { extractForwardIds, extractReplyId } from './rich.mjs'
import { senderIdOf } from './normalize.mjs'

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
  sendMaxPerHour: 60,
  sendSameTextWindowMs: 60_000,
  maxSendsPerTurn: 1,
  maxSendChars: 2000,
  sensitivePatterns: null,
  // P0-1 账本 / 断线补课（默认开：补课失败只是 gap 可见，不影响实时入站）
  ledgerFile: '',
  httpUrl: '',
  httpToken: '',
  backfillEnabled: true,
  backfillCount: 50,
  maxBackfillAgeMs: 6 * 3600_000,
  backfillMaxPeers: 5,
  // P0-2 富内容（纯格式化/慢取；图片真正进模型要等 DSH attachment，本轮不接）
  richEnabled: true,
  replyResolveEnabled: true,
  replyIngestWaitMs: 2000,
  replyResolveTtlMs: 30 * 60_000,
  forwardExpandEnabled: true,
  forwardExpandMax: 2,
  forwardExpandMaxChars: 1200,
  // 人类化出站（P0-3）：多气泡 + 节奏 + markdown + 长文切分
  burstEnabled: true,
  burstMaxMessages: 8,
  burstIntervalMinMs: 1000,
  burstIntervalMaxMs: 3000,
  longGapProbability: 0.2,
  longGapMinMs: 5000,
  longGapMaxMs: 10_000,
  maxMessageChars: 500,
  gapMode: 'auto',
  markdownToPlain: true,
  // 测试注入（生产不填）：sleep / random
  sleepImpl: null,
  randomImpl: null,
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
  cfg.burstEnabled = cfg.burstEnabled !== false
  cfg.markdownToPlain = cfg.markdownToPlain !== false
  cfg.backfillEnabled = cfg.backfillEnabled !== false
  cfg.richEnabled = cfg.richEnabled !== false
  cfg.replyResolveEnabled = cfg.replyResolveEnabled !== false
  cfg.forwardExpandEnabled = cfg.forwardExpandEnabled !== false
  cfg.allowPrivate = pickList(cfg.allowPrivate)
  for (const key of ['maxPerMinute', 'maxStaleMs', 'maxTextChars', 'dedupeWindowMs', 'dedupeLimit', 'retryMax', 'retryTickMs', 'retryMaxAttempts', 'signalTtlMs', 'reconnectMinMs', 'reconnectMaxMs', 'heartbeatStaleMs', 'statusIntervalMs', 'sendTimeoutMs', 'sendMinIntervalMs', 'sendMaxPerMinute', 'sendMaxPerHour', 'sendSameTextWindowMs', 'maxSendsPerTurn', 'maxSendChars', 'burstMaxMessages', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapProbability', 'longGapMinMs', 'longGapMaxMs', 'maxMessageChars', 'backfillCount', 'maxBackfillAgeMs', 'backfillMaxPeers', 'replyIngestWaitMs', 'replyResolveTtlMs', 'forwardExpandMax', 'forwardExpandMaxChars']) {
    const n = Number(cfg[key])
    cfg[key] = Number.isFinite(n) && n >= 0 ? n : DEFAULTS[key]
  }
  cfg.gapMode = ['auto', 'fixed', 'typing', 'byLength'].includes(String(cfg.gapMode)) ? String(cfg.gapMode) : 'auto'
  cfg.sleepImpl = typeof input.sleepImpl === 'function' ? input.sleepImpl : null
  cfg.randomImpl = typeof input.randomImpl === 'function' ? input.randomImpl : null
  cfg.url = String(cfg.url ?? '')
  cfg.token = String(cfg.token ?? '')
  cfg.snowlumaHomeDir = String(cfg.snowlumaHomeDir ?? '')
  cfg.accountUin = cfg.accountUin == null ? null : String(cfg.accountUin)
  cfg.selfId = cfg.selfId == null ? null : String(cfg.selfId)
  cfg.ownerQQ = cfg.ownerQQ == null || String(cfg.ownerQQ).trim() === '' ? null : String(cfg.ownerQQ).trim()
  cfg.auditFile = String(cfg.auditFile ?? '')
  cfg.ledgerFile = String(cfg.ledgerFile ?? '')
  cfg.httpUrl = String(cfg.httpUrl ?? '')
  cfg.httpToken = String(cfg.httpToken ?? '')
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
      log({ msg: 'qq.endpoint.discovered', uin: found.uin, url: sanitizeUrl(found.wsUrl), file: path.basename(found.file), http: found.httpUrl ? sanitizeUrl(found.httpUrl) : null })
      return {
        ok: true, url: found.wsUrl, token: found.token, uin: found.uin, source: 'snowluma',
        httpUrl: found.httpUrl ?? '', httpToken: found.httpToken ?? '',
      }
    }
    log({ level: 'warn', msg: 'qq.endpoint.discover-fail', error: found.error })
  }
  if (cfg.url) return { ok: true, url: cfg.url, token: cfg.token, uin: cfg.accountUin, source: 'config', httpUrl: '', httpToken: '' }
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
  // P0-1：账本 + 补课（http 只做 get_friend_msg_history，不参与发送）
  let ledger = null
  let http = null
  let backfill = null
  let replyResolver = null
  const gap = {
    reconnects: 0,
    lastDowntimeMs: null,
    backfillRuns: 0,
    filled: 0,
    dropped: 0,
    failed: 0,
    unsupported: 0,
    lastBackfillAt: null,
    lastError: null,
  }
  // phase 1 出站：只有三把钥匙打开时才动态装配（index 不静态 import 发送实现）
  let sendHandle = null

  function peerList() {
    const list = new Set(cfg.allowPrivate.map(String))
    if (ledger) {
      for (const row of ledger.activities()) {
        const match = /^qq:private:(\d+)$/.exec(String(row.activity ?? ''))
        if (match) list.add(match[1])
      }
    }
    return [...list].slice(0, Math.max(1, cfg.backfillMaxPeers))
  }

  /** 补课只认"已进投递队列"：signals 接受（或幂等去重）后推进账本水位；被 time/focus 拦下的不推进。 */
  function markLedgerDelivered(signal) {
    const info = signal?.meta?.qq?.ledger
    if (!info || !ledger) return
    try { ledger.markDelivered(info.activity, info.seq) } catch (error) {
      ctx.log({ level: 'warn', msg: 'qq.ledger.mark-delivered', error: String(error?.message ?? error) })
    }
  }

  function gapFromBackfill() {
    const s = backfill?.status()
    if (!s) return
    gap.backfillRuns = s.runs
    gap.filled = s.filled
    gap.dropped = s.dropped
    gap.failed = s.failed
    gap.unsupported = s.unsupported
    gap.lastBackfillAt = s.lastRunAt
    gap.lastError = s.lastError
  }

  function runBackfill(reason) {
    if (!cfg.backfillEnabled || !backfill) return
    if (!backfill.busy) {
      ctx.log({ msg: 'qq.backfill.start', reason, peers: peerList().length, http: Boolean(http?.ok) })
    }
    void backfill.run({ reason }).then((result) => {
      gapFromBackfill()
      if (result?.filled || result?.failed || result?.dropped) {
        ctx.log({ msg: 'qq.backfill.summary', reason, filled: result.filled ?? 0, dropped: result.dropped ?? 0, failed: result.failed ?? 0 })
      }
      writeStatusFile()
    }).catch((error) => {
      gap.lastError = String(error?.message ?? error)
      ctx.log({ level: 'warn', msg: 'qq.backfill.run-fail', error: gap.lastError })
    })
  }

  function onConnectorOpen(info = {}) {
    gap.reconnects = Math.max(0, Number(info.openCount ?? 1) - 1)
    if (info.first !== true && info.downtimeMs != null) gap.lastDowntimeMs = Number(info.downtimeMs) || 0
    // 每次都尝试补课：首次启动补"进程不在时"的消息；重连补断线窗口。没有 peer 就跳过。
    if (peerList().length) runBackfill(info.first === true ? 'start' : 'reconnect')
  }

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
    if (out?.accepted) { stats.delivered += 1; markLedgerDelivered(signal); return 'delivered' }
    if (out?.deduped) { stats.dedupedAtSignals += 1; markLedgerDelivered(signal); return 'deduped' }
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

  /**
   * P0-2 入站富内容：进闸门前做两件"慢但必要"的事（都受配置控制、失败不阻塞消息）：
   *   1) 引用解析：`get_msg` 慢取缓存；等不到就放占位文字，不丢原消息；
   *   2) 合并转发展开：`get_forward_msg` 取一层/两层，拼成可读文本（有深度/字数上限）。
   * 图片/文件这里**不下载**：只保留 meta 定位信息，真正看图片等 DSH attachment 通道。
   */
  async function enrichInbound(raw) {
    if (!cfg.richEnabled || !Array.isArray(raw?.message)) return raw
    let message = raw.message
    let enriched = null
    const replyId = extractReplyId(message)
    if (replyId && cfg.replyResolveEnabled && replyResolver) {
      const peerId = senderIdOf(raw)
      let info = null
      try {
        info = await replyResolver.resolve(replyId, {
          peerId,
          selfId: cfg.selfId ?? raw.self_id,
          waitMs: cfg.replyIngestWaitMs,
        })
      } catch (error) {
        ctx.log({ level: 'info', msg: 'qq.reply.enrich-fail', id: replyId, error: String(error?.message ?? error) })
      }
      const context = info?.pending ? pendingReplyText(replyId) : (info ? replyContextText(info) : null)
      if (context) {
        // 把 reply 段换成不可伪造的文本段，同时保留原始 id 供 meta 使用。
        message = message.map((seg) => (seg?.type === 'reply' ? { type: 'text', data: { text: context } } : seg))
        enriched = { ...raw, __qqReplyId: replyId }
      }
    }
    const forwardIds = extractForwardIds(message)
    if (cfg.forwardExpandEnabled && forwardIds.length && http?.ok) {
      try {
        const expanded = await expandForwardIds(forwardIds, {
          fetchForward: (id) => http.call('get_forward_msg', { id }),
          maxIds: cfg.forwardExpandMax,
          maxChars: cfg.forwardExpandMaxChars,
        })
        if (expanded) message = [...message, { type: 'text', data: { text: `\n[转发展开]\n${expanded}` } }]
      } catch (error) {
        ctx.log({ level: 'info', msg: 'qq.forward.expand-fail', error: String(error?.message ?? error) })
      }
    }
    return message === raw.message && !enriched ? raw : { ...(enriched ?? raw), message }
  }

  function handleEvent(raw, { backfilled = false } = {}) {
    if (disposed) return { accept: false, code: 'disposed' }
    stats.frames += 1
    if (raw?.post_type === 'meta_event') {
      stats.meta += 1
      connector?.onMeta?.() // 保留扩展点：当前只更新连接器内部 lastPacketAt
      return { accept: false, code: 'meta' }
    }
    // 只有带引用/转发的消息才需要异步慢取；普通文本保持同步路径（现有调用方/测试语义不变）。
    const needsEnrich = cfg.richEnabled && raw?.post_type === 'message' && Array.isArray(raw.message)
      && (extractReplyId(raw.message) != null || extractForwardIds(raw.message).length > 0)
    if (needsEnrich) return enrichInbound(raw).then((event) => ingestEvent(event, { backfilled }))
    return ingestEvent(raw, { backfilled })
  }

  function ingestEvent(event, { backfilled = false } = {}) {
    const decision = gate.admit(event, { receivedAt: now(), backfilled, maxBackfillAgeMs: cfg.maxBackfillAgeMs })
    if (!decision.accept) {
      stats.recent.lastDropped = { at: now(), code: decision.code }
      // 群消息不落记录（整类忽略，避免把群内容写进影子证据文件）
      if (!['group', 'meta', 'not-message', 'invalid'].includes(decision.code)) {
        record({ kind: 'dropped', code: decision.code, at: now() })
      }
      return decision
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
      backfilled: decision.backfilled === true,
    }
    signal.expiresAt = decision.receivedAt + cfg.signalTtlMs
    // 先入账（拿到活动内单调 seq），再投递；水位在 offer 被接受后推进（见 markLedgerDelivered）。
    if (ledger) {
      try {
        const appended = ledger.append({
          activity: signal.from.activity,
          qqId: decision.messageId,
          signalId: signal.id,
          at: decision.messageAt,
          sentAt: decision.messageAt,
          receivedAt: decision.receivedAt,
          sender: decision.senderName,
          text: decision.text ?? '',
          mention: true,
          media: null,
        })
        signal.meta.qq.ledger = { activity: signal.from.activity, seq: appended.seq }
        if (appended.duplicate) stats.ledgerDuplicates = (stats.ledgerDuplicates ?? 0) + 1
      } catch (error) {
        ctx.log({ level: 'warn', msg: 'qq.ledger.append', error: String(error?.message ?? error) })
      }
    }
    record({
      kind: 'accepted',
      id: signal.id,
      text: signal.text,
      messageAt: decision.messageAt,
      receivedAt: decision.receivedAt,
      peerId: decision.peerId,
      messageId: decision.messageId,
      backfilled: decision.backfilled === true,
      segments: signal.meta.qq.segments,
    })
    offer(signal)
    return decision
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
      if (out?.accepted) { retry.splice(i, 1); stats.delivered += 1; markLedgerDelivered(item.signal); continue }
      if (out?.deduped) { retry.splice(i, 1); stats.dedupedAtSignals += 1; markLedgerDelivered(item.signal); continue }
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
    // P0-1：账本（默认内存；给了 ledgerFile 或任一 state 文件时落 SQLite）+ 补课 HTTP 客户端。
    let ledgerFile = cfg.ledgerFile ? resolvePath(cfg.ledgerFile) : ''
    if (!ledgerFile) {
      const anchor = cfg.dedupeFile || cfg.recordFile || cfg.statusFile
      if (anchor) ledgerFile = path.join(path.dirname(resolvePath(anchor)), 'qq-ledger.db')
    }
    ledger = createLedger({ file: ledgerFile || null, log: (entry) => ctx.log({ plugin: 'qq', ...entry }) })
    http = createOneBotHttp({
      endpointUrl: cfg.httpUrl || endpoint.httpUrl || '',
      token: cfg.httpToken || endpoint.httpToken || '',
      fetchImpl: cfg.fetchImpl ?? globalThis.fetch,
      timeoutMs: 15_000,
    })
    backfill = createBackfill({
      http,
      ledger,
      now,
      selfId: cfg.selfId,
      count: cfg.backfillCount,
      maxAgeMs: cfg.maxBackfillAgeMs,
      maxPeers: cfg.backfillMaxPeers,
      peers: peerList,
      ingest: (event, opts) => handleEvent(event, opts),
      log: (entry) => ctx.log({ plugin: 'qq', ...entry }),
    })
    replyResolver = createReplyResolver({
      http,
      now,
      ttlMs: cfg.replyResolveTtlMs,
      log: (entry) => ctx.log({ plugin: 'qq', ...entry }),
    })
    ctx.log({
      msg: 'qq.ledger.ready',
      mode: ledger.stats().mode,
      file: ledger.stats().file,
      messages: ledger.stats().messages,
      backfill: cfg.backfillEnabled,
      http: Boolean(http.ok),
      httpUrl: http.ok ? sanitizeUrl(http.endpointUrl) : null,
    })
    connector = createInboundConnector({
      url: endpoint.url,
      token: endpoint.token,
      WebSocketImpl: cfg.webSocketImpl ?? globalThis.WebSocket,
      now,
      log: (entry) => ctx.log({ plugin: 'qq', ...entry }),
      onEvent: handleEvent,
      onOpen: onConnectorOpen,
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
      gap: { ...gap, backfill: backfill?.status() ?? null, peers: peerList() },
      ledger: ledger?.stats() ?? { mode: 'off', file: null, activities: 0, messages: 0, delivered: 0 },
      http: { ok: Boolean(http?.ok), url: http?.ok ? sanitizeUrl(http.endpointUrl) : null },
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
    if (s.enabled) {
      const gp = s.gap ?? {}
      const bk = gp.backfill ?? {}
      lines.push(`账本：${s.ledger?.mode ?? 'off'}（${s.ledger?.messages ?? 0} 条消息，已交付 ${s.ledger?.delivered ?? 0}）${s.ledger?.file ? `；文件：${s.ledger.file}` : '；内存模式（重启不保留）'}`)
      lines.push(`断线补课：重连 ${gp.reconnects ?? 0} 次${gp.lastDowntimeMs != null ? `（最近断开 ${Math.round(gp.lastDowntimeMs / 1000)}s）` : ''}；补课 ${gp.backfillRuns ?? 0} 次，补回 ${gp.filled ?? 0} 条，过期跳过 ${gp.dropped ?? 0}，失败 ${gp.failed ?? 0}${gp.unsupported ? `，无 HTTP 端点 ${gp.unsupported} 次` : ''}${s.http?.ok ? '' : '（补课不可用）'}${gp.lastError ? `；最近错误：${gp.lastError}` : ''}`)
    }
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
      const outcomeText = recent ? `最近一次发送：${stamp(recent.at)} → ${recent.peerId}，结果=${recent.outcome}${Number.isFinite(Number(recent.total)) ? `（${recent.sent ?? 0}/${recent.total} 条）` : ''}${recent.messageId ? `，messageId=${recent.messageId}` : ''}${recent.error ? `（${recent.error}）` : ''}` : '最近一次发送：还没有'
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
    try { ledger?.close() } catch (error) {
      ctx.log({ level: 'warn', msg: 'qq.ledger.close', error: String(error?.message ?? error) })
    }
    ledger = null
    writeStatusFile()
    const flushed = gate.flush()
    if (flushed?.error) ctx.log({ level: 'warn', msg: 'qq.dedupe.save', error: flushed.error })
    try { offShared?.() } catch { /* 注销器已执行 */ }
    ctx.log({ msg: 'qq.disposed', delivered: stats.delivered, blocked: stats.blocked, dropped: gate.counters().byCode })
  })

  return { status, statusText, sendStatus: () => sendHandle?.status() ?? null, killSend: (reason) => sendHandle?.killSwitch(reason) ?? null }
}
