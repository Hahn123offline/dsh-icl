// qq：只读入站影子（OneBot / SnowLuma → ICL signals）。
//
// 本轮定位（docs/QQ.md §7 的落地顺序第 1 步）：
//   · **私聊默认只读；群聊 G1 只读白名单群**（groupPolicy:'allowlist' + allowGroups）；
//     群普通消息进 focus backlog，@ 才直达；G1 不发任何群消息。
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
import os from 'node:os'
import path from 'node:path'
import { createInboundConnector, discoverOneBotEndpoint, sanitizeUrl } from './connector.mjs'
import { createDedupeStore, createInboundGate } from './gate.mjs'
import { SEND_APPROVAL_TOKEN, sendEnabled } from './outbound.mjs'
import { createLedger } from './ledger.mjs'
import { createOneBotHttp } from './onebot-http.mjs'
import { createBackfill } from './backfill.mjs'
import { createReplyResolver, pendingReplyText, replyContextText } from './reply-cache.mjs'
import { expandForwardIds } from './forward.mjs'
import { extractForwardIds, extractReplyId, extractMedia } from './rich.mjs'
import { senderIdOf, activityIdForPrivate, activityIdForGroup } from './normalize.mjs'
import { MEDIA_DEFAULTS, acceptVideoBuffer, fetchImageMedia, formatBytes, safeFetchBuffer, saveInboxMedia } from './media.mjs'
import { createWakePlanner } from './wake.mjs'
import { createInboundDebouncer, mergeSignals, normalizeDebounceConfig } from './debounce.mjs'
import { RATE_FAST, RATE_WINDOW_MS } from './attention-window.mjs'
import { buildWakeSnapshot } from './wake-snapshot.mjs'
import { iclPaths } from '../../../core/src/icl-paths.mjs'

export const name = 'qq'

// 按需读的聊天策略（不进静态 system 段；通过 qq_help 工具按需读，避免 cache/第一屏成本）。
const PLUGIN_DIR = path.join(import.meta.dirname, '..')
const SKILL_DIR = path.join(PLUGIN_DIR, 'skills')
const SKILLS = Object.freeze([
  { id: 'reply', file: 'reply.md', title: 'QQ 聊天策略：何时回/不回、私聊优先级、群聊 G1 边界、谁在说话' },
])

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
  // 群聊只读：默认整类忽略；显式 groupPolicy:'allowlist' + allowGroups 才接。
  allowGroups: [],
  groupPolicy: 'ignore',
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
  // 入站防抖：同一个人连发时合成一批再给模型。默认关；产品 preset 显式开启。
  inboundDebounce: { enabled: false, quietMs: 10_000, mentionQuietMs: 4_000, maxHoldMs: 30_000, maxBatchMessages: 20 },
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
  // Phase 2 出站短队列：限流时排队而不是直接拒绝；默认关，产品 preset 开。
  outboxEnabled: false,
  outboxMaxPending: 20,
  outboxTtlMs: 5 * 60_000,
  globalSendMaxPerMinute: 0,
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
  // 说话人信封：正文前缀 + meta.qq.envelope；只影响 QQ 自己的可读性，不碰 bridge
  senderEnvelope: true,
  // 入站媒体（图片走 DSH attachment，视频/文件落本地统一媒体目录）
  mediaEnabled: true,
  mediaInboxDir: '',
  mediaFetchImpl: null,
  maxImages: MEDIA_DEFAULTS.maxImages,
  maxImageBytes: MEDIA_DEFAULTS.maxImageBytes,
  maxVideoBytes: MEDIA_DEFAULTS.maxVideoBytes,
  maxFileBytes: MEDIA_DEFAULTS.maxFileBytes,
  mediaRetentionDays: MEDIA_DEFAULTS.retentionDays,
  mediaSoftLimitBytes: MEDIA_DEFAULTS.softLimitBytes,
  // 表情包本地库（只读列表/发送本地文件；不下载远程、不执行文件）
  stickerDir: '',
  stickerLibraryFile: '',
  maxStickerBytes: 10 * 1024 * 1024,
  stickerListLimit: 100,
  // 唤醒矩阵（只生成 signal，不投递；time/focus 仍决定）：
  wakeEnabled: true,
  wakeTickMs: 5000,
  replyCheckEnabled: true,
  replyCheckDelayMs: 30_000,
  proactiveEnabled: false,
  proactiveMinMs: 30 * 60_000,
  proactiveMaxMs: 90 * 60_000,
  proactiveIdleMs: 15 * 60_000,
  proactiveProbability: 0.3,
  proactiveCooldownMs: 30 * 60_000,
  nudgeEnabled: true,
  nudgeSoftMs: 10 * 60_000,
  nudgeCooldownMs: 10 * 60_000,
  nudgeMaxPerHour: 6,
  wakeMaxPerHour: 12,
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
  cfg.inboundDebounce = normalizeDebounceConfig(cfg.inboundDebounce)
  cfg.allowAllPrivate = cfg.allowAllPrivate === true
  cfg.deliverBackfill = cfg.deliverBackfill === true
  cfg.promptLine = cfg.promptLine === true
  cfg.allowSend = cfg.allowSend === true
  cfg.outboxEnabled = cfg.outboxEnabled === true
  cfg.burstEnabled = cfg.burstEnabled !== false
  cfg.markdownToPlain = cfg.markdownToPlain !== false
  cfg.backfillEnabled = cfg.backfillEnabled !== false
  cfg.richEnabled = cfg.richEnabled !== false
  cfg.replyResolveEnabled = cfg.replyResolveEnabled !== false
  cfg.forwardExpandEnabled = cfg.forwardExpandEnabled !== false
  cfg.senderEnvelope = cfg.senderEnvelope !== false
  cfg.wakeEnabled = cfg.wakeEnabled !== false
  cfg.replyCheckEnabled = cfg.replyCheckEnabled !== false
  cfg.proactiveEnabled = cfg.proactiveEnabled === true
  cfg.nudgeEnabled = cfg.nudgeEnabled !== false
  cfg.mediaEnabled = cfg.mediaEnabled !== false
  cfg.mediaFetchImpl = typeof input.mediaFetchImpl === 'function' ? input.mediaFetchImpl : null
  cfg.mediaInboxDir = String(cfg.mediaInboxDir ?? '')
  cfg.stickerDir = String(cfg.stickerDir ?? '')
  cfg.stickerLibraryFile = String(cfg.stickerLibraryFile ?? '')
  cfg.allowPrivate = pickList(cfg.allowPrivate)
  cfg.allowGroups = pickList(cfg.allowGroups)
  cfg.groupPolicy = cfg.groupPolicy === 'allowlist' ? 'allowlist' : 'ignore'
  for (const key of ['maxPerMinute', 'maxStaleMs', 'maxTextChars', 'dedupeWindowMs', 'dedupeLimit', 'retryMax', 'retryTickMs', 'retryMaxAttempts', 'signalTtlMs', 'reconnectMinMs', 'reconnectMaxMs', 'heartbeatStaleMs', 'statusIntervalMs', 'sendTimeoutMs', 'sendMinIntervalMs', 'sendMaxPerMinute', 'sendMaxPerHour', 'sendSameTextWindowMs', 'maxSendsPerTurn', 'maxSendChars', 'outboxMaxPending', 'outboxTtlMs', 'globalSendMaxPerMinute', 'burstMaxMessages', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapProbability', 'longGapMinMs', 'longGapMaxMs', 'maxMessageChars', 'backfillCount', 'maxBackfillAgeMs', 'backfillMaxPeers', 'replyIngestWaitMs', 'replyResolveTtlMs', 'forwardExpandMax', 'forwardExpandMaxChars', 'maxImages', 'maxImageBytes', 'maxVideoBytes', 'maxFileBytes', 'mediaRetentionDays', 'mediaSoftLimitBytes', 'maxStickerBytes', 'stickerListLimit', 'wakeTickMs', 'replyCheckDelayMs', 'proactiveMinMs', 'proactiveMaxMs', 'proactiveIdleMs', 'proactiveCooldownMs', 'nudgeSoftMs', 'nudgeCooldownMs', 'nudgeMaxPerHour', 'wakeMaxPerHour']) {
    const n = Number(cfg[key])
    cfg[key] = Number.isFinite(n) && n >= 0 ? n : DEFAULTS[key]
  }
  cfg.gapMode = ['auto', 'fixed', 'typing', 'byLength'].includes(String(cfg.gapMode)) ? String(cfg.gapMode) : 'auto'
  cfg.proactiveProbability = Math.max(0, Math.min(1, Number(cfg.proactiveProbability) || 0))
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

/** 默认 SnowLuma 安装目录：env 优先，否则 ~/Downloads 下最新的 SnowLuma-*（不写死用户名/盘符）。 */
export function defaultSnowlumaHome() {
  if (process.env.SNOWLUMA_HOME) return path.resolve(String(process.env.SNOWLUMA_HOME))
  try {
    const base = path.join(os.homedir(), 'Downloads')
    const dirs = fs.readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('SnowLuma-'))
      .map((entry) => entry.name)
      .sort()
    if (dirs.length) return path.join(base, dirs[dirs.length - 1])
  } catch { /* 没有 Downloads 就用显式配置 */ }
  return null
}

/** 端点解析：snowlumaHomeDir='auto' 时自动发现（env SNOWLUMA_HOME 优先），
 *  显式路径优先于显式 url；没有 snowlumaHomeDir 时只用 url（避免测试/无 QQ 环境误连本机 SnowLuma）。 */
export function resolveEndpoint(cfg, log = () => {}) {
  const home = cfg.snowlumaHomeDir === 'auto' ? defaultSnowlumaHome() : (cfg.snowlumaHomeDir || null)
  if (home) {
    const found = discoverOneBotEndpoint(home, { accountUin: cfg.accountUin })
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
  return { ok: false, error: '没有可用的上游：配置 url 或 snowlumaHomeDir（也找不到默认 SnowLuma 安装）' }
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
    allowGroups: cfg.allowGroups,
    groupPolicy: cfg.groupPolicy,
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
    // P3：focus 积压（accepted+queued+delivered:false）只是进了 focus backlog，不算已交付；
    // 等 focus/time 重放后的 noteDeliveredSeqs 回执再推 delivered。
    queued: 0,
    queuedReasons: {},
    expired: 0,
    retryQueued: 0,
    retryDropped: 0,
    recorded: 0,
    recordErrors: 0,
    mediaSaved: 0,
    mediaFailed: 0,
    mediaBytes: 0,
    mediaSoftWarned: false,
    // time/focus 重放回执的补推统计：via -> {accepted,skipped,calls,lastAt}
    deliveredVia: {},
    // 只读观测：最近一条进来的私聊 / 最近一次丢弃 / 最近一次被 time 锁拦下
    recent: { lastAccepted: null, lastDropped: null, lastBlocked: null, lastQueued: null },
  }
  let connector = null
  let endpoint = null
  let retryTimer = null
  let disposed = false
  let mediaDir = ''
  // P0-1：账本 + 补课（http 只做 get_friend_msg_history，不参与发送）
  let ledger = null
  let http = null
  let backfill = null
  let replyResolver = null
  let wakePlanner = null
  let wakeTimer = null
  let inboundDebouncer = null
  const waiters = new Map() // activity -> waiter
  const groupArrivals = new Map() // activity -> timestamps（无 debounce 时的 busyness）
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

  /** 媒体目录当前占用（启动时算一次；之后按新增累加，只做软告警，不删除）。 */
  function dirBytes(dir) {
    if (!dir) return 0
    let total = 0
    const walk = (current) => {
      let entries
      try { entries = fs.readdirSync(current, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        const file = path.join(current, entry.name)
        try {
          if (entry.isDirectory()) walk(file)
          else if (entry.isFile()) total += fs.statSync(file).size
        } catch { /* 单个文件读不到不影响总量估算 */ }
      }
    }
    walk(dir)
    return total
  }

  function maybeWarnMediaSize() {
    const limit = Number(cfg.mediaSoftLimitBytes) || 0
    if (limit <= 0 || stats.mediaBytes <= limit || stats.mediaSoftWarned) return
    stats.mediaSoftWarned = true
    ctx.log({
      level: 'warn',
      msg: 'qq.media.soft-limit',
      bytes: stats.mediaBytes,
      limitBytes: limit,
      dir: mediaDir,
      hint: '媒体目录超过软上限：只告警不删除；清理由人决定（album/prune 手动）',
    })
  }

  /**
   * time/focus 重放回执（跨模块契约）：只把"确实已经重放给模型"的账本 seq 标记为 delivered，
   * **不推 attended/不算已读/不发消息**。幂等；不存在/已交付的 seq 忽略；任何异常都只返回 ok:false，
   * 绝不 throw，避免影响调用方的投递流程。
   */
  function noteDeliveredSeqs({ activity = null, peer = null, seqs = [], via = 'unknown', at = null } = {}) {
    const empty = { ok: false, accepted: 0, skipped: 0, via: String(via || 'unknown').slice(0, 40) || 'unknown' }
    if (!ledger) return { ...empty, error: 'ledger-off' }
    const target = activity != null && String(activity).trim()
      ? String(activity).trim()
      : (peer != null && String(peer).trim() ? activityIdForPrivate(String(peer).trim()) : null)
    if (!target) return { ...empty, error: 'activity-required（或传 peer）' }
    const list = [...new Set((Array.isArray(seqs) ? seqs : [seqs]).map(Number).filter((n) => Number.isInteger(n) && n > 0))]
    try {
      const result = ledger.markDeliveredSeqs(target, list)
      const key = String(via || 'unknown').trim().slice(0, 40) || 'unknown'
      const stamp = Number(at) || now()
      const bucket = stats.deliveredVia[key] ?? { accepted: 0, skipped: 0, calls: 0, lastAt: null }
      bucket.accepted += result.accepted
      bucket.skipped += result.skipped
      bucket.calls += 1
      bucket.lastAt = stamp
      stats.deliveredVia[key] = bucket
      // 只有真的补推了才让交付水位前进；不碰 attended。
      const watermark = ledger.watermarks(target)
      return {
        ok: true,
        activity: target,
        via: key,
        accepted: result.accepted,
        skipped: result.skipped,
        lastSeq: watermark.lastSeq,
        deliveredSeq: watermark.deliveredSeq,
        attendedSeq: watermark.attendedSeq,
        at: stamp,
      }
    } catch (error) {
      ctx.log({ level: 'warn', msg: 'qq.note-delivered-seqs', error: String(error?.message ?? error), activity: target })
      return { ...empty, error: String(error?.message ?? error) }
    }
  }

  function ledgerWatermarks() {
    if (!ledger) return []
    return (ledger.activities() ?? [])
      .filter((row) => ledgerPeerOf(row.activity))
      .map((row) => {
        const known = ledger.lastKnown(row.activity) ?? {}
        return {
          peer: ledgerPeerOf(row.activity),
          lastSeq: known.lastSeq ?? row.total ?? 0,
          deliveredSeq: known.deliveredSeq ?? row.deliveredSeq ?? 0,
          attendedSeq: known.attendedSeq ?? row.attendedSeq ?? 0,
          undelivered: Math.max(0, (known.lastSeq ?? 0) - (known.deliveredSeq ?? 0)),
        }
      })
  }

  function groupWatermarks() {
    if (!ledger) return []
    return (ledger.activities() ?? [])
      .filter((row) => /^qq:group:\d+$/.test(String(row.activity ?? '')))
      .map((row) => {
        const known = ledger.lastKnown(row.activity) ?? {}
        return {
          activity: String(row.activity),
          groupId: String(row.activity).slice('qq:group:'.length),
          lastSeq: known.lastSeq ?? row.total ?? 0,
          deliveredSeq: known.deliveredSeq ?? 0,
          attendedSeq: known.attendedSeq ?? 0,
          undelivered: Math.max(0, (known.lastSeq ?? 0) - (known.deliveredSeq ?? 0)),
        }
      })
      .filter((row) => row.undelivered > 0)
  }

  /**
   * 模型进入任何一轮前都能看到的未读摘要。只列还没交付的行，不重复当前刚投递的消息；
   * 目的在于“说话前先看到旧消息”，而不是等下一次主动检查。
   */
  function unreadDigest(maxChars = 700, { markDelivered = false } = {}) {
    if (!ledger) return ''
    const blocks = []
    const marks = new Map()
    const collect = (activity, msgs) => {
      if (!marks.has(activity)) marks.set(activity, [])
      for (const msg of msgs) marks.get(activity).push(msg.seq)
    }
    const privateRows = ledgerWatermarks().filter((row) => Number(row.undelivered) > 0)
    for (const row of privateRows.slice(0, 4)) {
      const activity = activityIdForPrivate(row.peer)
      const msgs = (ledger.undelivered(activity, { limit: 4 }) ?? []).slice(0, 4)
      collect(activity, msgs)
      const lines = msgs.map((msg) => `· #${msg.seq} ${msg.sender ? `${msg.sender}：` : ''}${String(msg.text ?? '').slice(0, 120)}`)
      blocks.push(`私聊 ${row.peer}（${row.undelivered} 条未交付）${lines.length ? `\n${lines.join('\n')}` : ''}`)
    }
    const groupRows = groupWatermarks()
    for (const row of groupRows.slice(0, 4)) {
      const msgs = (ledger.undelivered(row.activity, { limit: 4 }) ?? []).slice(0, 4)
      collect(row.activity, msgs)
      const lines = msgs.map((msg) => `· #${msg.seq} ${msg.sender ? `${msg.sender}：` : ''}${String(msg.text ?? '').slice(0, 120)}`)
      blocks.push(`群 ${row.groupId}（${row.undelivered} 条未交付）${lines.length ? `\n${lines.join('\n')}` : ''}`)
    }
    if (!blocks.length) return ''
    if (markDelivered) {
      // 摘要已经进了本轮上下文：标 delivered，并把 attended 推到看过的最后一条；
      // 未展示的后续未交付留给下一轮。
      for (const [activity, seqs] of marks) {
        try {
          ledger.markDeliveredSeqs(activity, seqs)
          const through = Math.max(...seqs)
          if (Number.isFinite(through)) ledger.markRead(activity, { throughSeq: through })
        } catch { /* 水位失败不影响摘要 */ }
      }
    }
    const text = `QQ 还有没看过的消息（回之前先确认，不要假装没看见）：\n${blocks.join('\n')}`
    return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text
  }

  let lastPendingNoticeKey = null
  function notifyPending(reason = 'session-bind') {
    const digest = unreadDigest(500)
    if (!digest) { lastPendingNoticeKey = null; return false }
    const key = digest.slice(0, 300)
    if (key === lastPendingNoticeKey) return false
    lastPendingNoticeKey = key
    try {
      const out = ctx.signals.offer({
        from: { plugin: 'qq', activity: 'unread' },
        kind: 'notice',
        to: 'model',
        text: `[QQ未读] ${reason === 'session-bind' ? '你回来时' : ''}还有没处理的消息：\n${digest}`,
        tags: ['qq', 'unread'],
      })
      // 只有真正进管道（未排队）才把摘要里的行标 delivered；排队/睡眠拦下时留给下一轮。
      if (out?.delivered === true || (out?.accepted === true && out?.queued !== true)) unreadDigest(500, { markDelivered: true })
      return Boolean(out?.accepted || out?.delivered)
    } catch (error) {
      ctx.log({ level: 'warn', msg: 'qq.unread.notify-fail', error: String(error?.message ?? error) })
      return false
    }
  }

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
  function ledgerSeqsOf(signal) {
    const batch = signal?.meta?.qq?.batch
    if (Array.isArray(batch?.seqs) && batch.seqs.length) return batch.seqs
    const info = signal?.meta?.qq?.ledger
    return info?.seq != null ? [info.seq] : []
  }

  function markLedgerDelivered(signal) {
    const info = signal?.meta?.qq?.ledger
    if (!info || !ledger) return
    try {
      for (const seq of ledgerSeqsOf(signal)) ledger.markDelivered(info.activity, seq)
    } catch (error) {
      ctx.log({ level: 'warn', msg: 'qq.ledger.mark-delivered', error: String(error?.message ?? error) })
    }
  }

  /** 被 time/focus 拦下的行记下原因（可见、可解释，但**不**推进交付水位）。 */
  function markLedgerBlocked(signal, reason) {
    const info = signal?.meta?.qq?.ledger
    if (!info || !ledger) return
    try {
      for (const seq of ledgerSeqsOf(signal)) ledger.markBlocked(info.activity, seq, reason)
    } catch (error) {
      ctx.log({ level: 'warn', msg: 'qq.ledger.mark-blocked', error: String(error?.message ?? error) })
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
      const activityFor = (peerId) => activityIdForPrivate(String(peerId))
      sendHandle = await registerSendTool({
        ctx,
        cfg,
        liveConfig,
        endpoint,
        now,
        log: (entry) => ctx.log({ plugin: 'qq', ...entry }),
        validateReply: ({ peerId, messageId }) => Boolean(ledger?.hasMessage(activityFor(peerId), messageId)),
        onSendStart: ({ peerId }) => ledger?.lastKnown(activityFor(peerId))?.lastSeq ?? 0,
        onSent: ({ peerId, replyToMessageId, throughSeq, at }) => {
          if (!ledger) return
          const activity = activityFor(peerId)
          let through = Number(throughSeq) || 0
          if (replyToMessageId) {
            const target = ledger.replyState(activity, { messageId: replyToMessageId })
            if (target?.found) through = Math.max(through, Number(target.seq) || 0)
          }
          if (through > 0) ledger.markReplied(activity, { throughSeq: through, at })
          noteWakeOutbound(activity)
        },
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

  function peerLabelOf(activity) {
    const peer = ledgerPeerOf(activity)
    if (!peer) return 'QQ私聊'
    return cfg.ownerQQ != null && String(peer) === String(cfg.ownerQQ) ? `主人（${peer}）` : `QQ ${peer}`
  }

  /** time.compactWake 服务（可选）：旧版 time 没有 wake 属性时安全降级为全量、不 bump。 */
  function timeWakeApi() {
    try { return ctx.services?.get?.('time')?.wake ?? null } catch { return null }
  }

  function timeWakeCompact(wake) {
    try { return Boolean(wake && typeof wake.enabled === 'function' && wake.enabled() && typeof wake.shouldCompact === 'function' && wake.shouldCompact()) } catch { return false }
  }

  /** 唤醒矩阵的提醒只生成 signal（给 time 决定投递），不直接碰 delivery/focus。 */
  function emitWake(emission) {
    if (!emission?.activity) return false
    // 睡眠/暂停/静音时，唤醒矩阵的“主动检查/积压提醒”不是外部消息，不能塞进 time 积压；
    // 原始消息已经在积压里，醒来简报会统一呈现，提醒再次入队只会造成重复噪声。
    try {
      const phase = ctx.services?.get?.('time')?.status?.()?.phase
      if (phase && phase !== 'awake') {
        stats.wakeSuppressedNonAwake = (stats.wakeSuppressedNonAwake ?? 0) + 1
        return false
      }
    } catch { /* time 不可用时保持旧行为 */ }
    const peer = peerLabelOf(emission.activity)
    const wakeApi = timeWakeApi()
    const compact = timeWakeCompact(wakeApi)
    let text
    if (emission.kind === 'replyCheck') {
      text = compact
        ? `[QQ主动检查·紧凑] ${peer} · 私聊\n你刚回过，确认一下有没有新回复。\n这不是对方刚发来的消息。`
        : `[QQ主动检查] 你刚回过 ${peer} 的私聊，过了一小会儿了；想确认对方接没接话，所以来看看。（这不是对方刚发来的消息）`
    } else if (emission.kind === 'proactive') {
      const minutes = Math.max(1, Math.round((Number(emission.idleMs) || 0) / 60000))
      text = compact
        ? `[QQ主动提醒·紧凑] ${peer} · 私聊\n安静约 ${minutes} 分钟，刚好有空。\n这不是对方发来的消息（是否打扰由 time/focus 决定）。`
        : `[QQ主动提醒] 你和 ${peer} 的私聊已经安静约 ${minutes} 分钟，你刚好有点空，可以想想有没有想分享的、或顺着上次的话题冒个泡。（这不是对方发来的消息；要不要现在打扰由 time/focus 决定）`
    } else if (emission.kind === 'nudge') {
      text = compact
        ? `[QQ积压提醒·紧凑] ${peer} · 私聊\n${emission.unread ?? '几'} 条未处理（账本水位之后）。\n这是提醒，不是新推送。`
        : `[QQ积压提醒] 你离开这会儿，${peer} 那边又攒了 ${emission.unread ?? '几'} 条还没处理的私聊；怕你忘了，先把最该看的一小段列在下面。（这是提醒，不是新推送）`
    } else {
      return false
    }
    // "醒来第一眼"快照：oldest-first、≤12 条/6000 字；超预算标 partial + readThroughSeq。
    let snapshot = { text: '', count: 0, included: 0, partial: false, readThroughSeq: null }
    let snapshotSeqs = []
    try {
      const rows = ledger?.unread(emission.activity, { limit: 12 })?.messages ?? []
      snapshot = buildWakeSnapshot(rows)
      snapshotSeqs = rows.map((row) => Number(row.seq)).filter((seq) => Number.isFinite(seq))
    } catch { /* 快照失败不影响提醒本身 */ }
    if (snapshot.text) {
      text += `\n\n醒来第一眼（未读 ${snapshot.count} 条，从旧到新）：\n${snapshot.text}`
      if (snapshot.partial) text += `\n（先看到 #${snapshot.readThroughSeq}；后面还有，用 qq_unread/qq_history 继续看）`
      text += '\n（处理完可以 qq_mark_read 推进已读水位；它不会替你回复。）'
    }
    const signal = {
      id: emission.id,
      from: { plugin: 'qq', activity: emission.activity },
      kind: 'notice',
      to: 'model',
      text,
      focus: emission.activity,
      tags: emission.tags,
      createdAt: emission.at,
      expiresAt: emission.at + cfg.signalTtlMs,
      meta: {
        qq: {
          wake: {
            kind: emission.kind,
            compact,
            reason: emission.reason ?? null,
            unread: emission.unread ?? null,
            snapshot: { included: snapshot.included, partial: snapshot.partial, readThroughSeq: snapshot.readThroughSeq },
          },
        },
      },
    }
    try {
      const out = ctx.signals.offer(signal)
      // compactWake：只有真正进管道（accepted 且未 queued）才计一次 wake；blocked/queued 不计。
      if (out?.accepted && out?.queued !== true) {
        try { wakeApi?.bump?.() } catch (error) {
          ctx.log({ level: 'warn', msg: 'qq.wake.bump-fail', error: String(error?.message ?? error) })
        }
      }
      if (out?.accepted && (out.queued === true || out.delivered === false)) { stats.wakeQueued = (stats.wakeQueued ?? 0) + 1; return false }
      if (out?.accepted) {
        // 快照已经真正进入本轮上下文：把其中展示到的行自动标已读，
        // 避免回完消息后 nudge 再把同一批旧消息提醒一遍。
        if (snapshot.readThroughSeq != null && ledger) {
          try {
            const shown = snapshotSeqs.filter((seq) => seq <= snapshot.readThroughSeq)
            if (shown.length) ledger.markDeliveredSeqs(emission.activity, shown)
            ledger.markRead(emission.activity, { throughSeq: snapshot.readThroughSeq })
          } catch { /* 水位失败不影响唤醒 */ }
        }
        stats.wakeDelivered = (stats.wakeDelivered ?? 0) + 1
        return true
      }
      if (out?.blocked) { stats.wakeBlocked = (stats.wakeBlocked ?? 0) + 1; return false }
      if (out?.deduped) { stats.wakeDeduped = (stats.wakeDeduped ?? 0) + 1; return false }
      if (out?.expired) { stats.wakeExpired = (stats.wakeExpired ?? 0) + 1; return false }
      return false
    } catch (error) {
      ctx.log({ level: 'warn', msg: 'qq.wake.offer-fail', error: String(error?.message ?? error) })
      return false
    }
  }

  function pollWake() {
    if (!wakePlanner || disposed) return
    let emissions = []
    try { emissions = wakePlanner.poll() } catch (error) {
      ctx.log({ level: 'warn', msg: 'qq.wake.poll-fail', error: String(error?.message ?? error) })
      return
    }
    for (const emission of emissions) emitWake(emission)
  }

  /** 入站消息到达：取消未发出的回复检查，并重排主动机会。 */
  function noteWakeInbound(activity) {
    try { wakePlanner?.noteInbound(activity) } catch { /* 唤醒矩阵坏了不影响入站 */ }
  }

  function noteWakeOutbound(activity) {
    try { wakePlanner?.noteOutbound(activity) } catch { /* 唤醒矩阵坏了不影响出站 */ }
  }

  /** 统一判定 signals.offer 结果：queued ≠ delivered（focus backlog 还没进模型）。 */
  function classifyOfferOutcome(out) {
    if (!out || typeof out !== 'object') return 'retry'
    if (out.delivered === true) return 'delivered'
    if (out.accepted === true) {
      if (out.queued === true || out.delivered === false) return 'queued'
      return 'delivered'
    }
    if (out.deduped) return 'deduped'
    if (out.blocked) return 'blocked'
    if (out.expired) return 'expired'
    return 'retry'
  }

  function recordQueued(signal, out) {
    const reason = String(out?.reason ?? 'focus-backlog')
    stats.queued += 1
    bump(stats.queuedReasons, reason)
    stats.recent.lastQueued = { at: now(), reason, id: signal.id }
    record({ kind: 'queued', id: signal.id, reason })
    // 只是进 focus backlog，仍未交付；行上留原因，等重放回执 noteDeliveredSeqs 推进 delivered。
    markLedgerBlocked(signal, reason)
  }

  function offer(signal) {
    let out
    try {
      out = ctx.signals.offer(signal)
    } catch (error) {
      ctx.log({ level: 'error', msg: 'qq.signals.offer-fail', error: String(error?.message ?? error) })
      out = { accepted: false, error: String(error?.message ?? error) }
    }
    const verdict = classifyOfferOutcome(out)
    if (verdict === 'delivered') { stats.delivered += 1; markLedgerDelivered(signal); return 'delivered' }
    // focus 积压：accepted/queued/delivered:false —— 内容还在 focus backlog，不能记已交付。
    if (verdict === 'queued') { recordQueued(signal, out); return 'queued' }
    // 幂等去重：原 offer 的处理已经决定过（可能 delivered，也可能 queued）；
    // 这里不能凭 deduped 就补 delivered。
    if (verdict === 'deduped') { stats.dedupedAtSignals += 1; return 'deduped' }
    // gate 拦下（time 睡眠/暂停/静音锁）：**不重试**。time 的 gate 已把内容抄进它自己
    // 持久化的 backlog（time/src/index.mjs enqueue），醒来/恢复时统一重放；我们重试会双投。
    if (verdict === 'blocked') {
      stats.blocked += 1
      bump(stats.blockedReasons, out.reason ?? 'gate')
      stats.recent.lastBlocked = { at: now(), reason: String(out.reason ?? 'gate'), id: signal.id }
      record({ kind: 'blocked', id: signal.id, reason: out.reason ?? 'gate' })
      markLedgerBlocked(signal, out.reason ?? 'gate')
      return 'blocked'
    }
    if (verdict === 'expired') {
      stats.expired += 1
      record({ kind: 'expired', id: signal.id })
      return 'expired'
    }
    enqueueRetry(signal, out?.error ?? 'deliver-failed')
    return 'retry'
  }

  inboundDebouncer = createInboundDebouncer({
    config: cfg.inboundDebounce,
    now,
    onFlush: (signal) => offer(signal),
    log: (row) => { try { ctx.log(row) } catch { /* 日志失败不影响投递 */ } },
  })

  /* ── 显式等待（Phase 3）：模型主动留在对话里等下一批新消息 ────────────────
   * 等待是独立动作，不附在 send 上；等待期间到达的消息由 waiter 消费，
   * 不进正常 debounce/delivery，避免"工具返回了、下一回合又收到一遍"。
   */
  function waitForMessages({ peer, timeoutMs = 45_000, quietMs = 10_000 } = {}) {
    const activity = activityIdForPrivate(peer)
    if (waiters.has(activity)) return Promise.resolve({ text: `已经在等 ${peer} 的新消息了，不要重复 wait。`, outcome: 'busy' })
    const seed = inboundDebouncer?.take(activity) ?? []
    const timeout = Math.max(5_000, Math.min(600_000, Number(timeoutMs) || 45_000))
    const quiet = Math.max(1_000, Math.min(30_000, Number(quietMs) || 10_000))
    const startedAt = now()
    return new Promise((resolve) => {
      const waiter = { activity, peer, signals: seed.slice(), quietMs: quiet, timeoutMs: timeout, startedAt, timers: {}, done: false, resolve }
      waiters.set(activity, waiter)
      const clear = () => {
        for (const timer of Object.values(waiter.timers)) { try { clearTimeout(timer) } catch { /* 已触发 */ } }
        waiter.timers = {}
      }
      const finish = (reason = 'timeout') => {
        if (waiter.done) return
        waiter.done = true
        clear()
        waiters.delete(activity)
        const signals = waiter.signals
        if (!signals.length) {
          resolve({ text: `等了 ${Math.round((now() - startedAt) / 1000)} 秒，没有新消息。`, outcome: 'timeout', waitedMs: now() - startedAt })
          return
        }
        const merged = mergeSignals(signals)
        markLedgerDelivered(merged)
        resolve({
          text: `收到 ${signals.length} 条新消息：\n${merged.text}`,
          outcome: 'messages',
          count: signals.length,
          messageIds: signals.map((signal) => signal.meta?.qq?.envelope?.messageId).filter(Boolean),
          waitedMs: now() - startedAt,
          quiet: reason === 'quiet',
        })
      }
      waiter.finish = finish
      waiter.armQuiet = () => {
        if (waiter.timers.quiet) { try { clearTimeout(waiter.timers.quiet) } catch { /* 已触发 */ } }
        waiter.timers.quiet = setTimeout(() => finish('quiet'), quiet)
      }
      waiter.timers.timeout = setTimeout(() => finish('timeout'), timeout)
      if (seed.length) waiter.armQuiet()
    })
  }

  function takeWaiterSignal(signal) {
    const waiter = waiters.get(String(signal?.from?.activity ?? ''))
    if (!waiter || waiter.done) return false
    waiter.signals.push(signal)
    waiter.armQuiet()
    return true
  }

  function disposeWaiters(reason = 'dispose') {
    for (const waiter of [...waiters.values()]) {
      try { waiter.finish(reason) } catch { /* 已清理 */ }
    }
    waiters.clear()
  }

  /**
   * 入站媒体（图片/视频/文件）：
   *   · 图片：安全抓取 → 字节随 signal.images 交给 bridge 换 DSH attachment（图片正文不写 URL/base64）；
   *   · 视频/文件：安全抓取 → 存 `<mediaInboxDir>/<date>/` + index.jsonl，正文追加本地绝对路径
   *     （供通用视频浏览器/read_image 使用）；
   *   · 任何失败都只降级为文字提示，不丢消息。
   */
  function inboundAt(raw) {
    const sec = Number(raw?.time)
    if (!Number.isFinite(sec) || sec <= 0) return now()
    return sec > 1e12 ? Math.round(sec) : Math.round(sec * 1000)
  }

  function directMediaUrl(seg) {
    const data = seg?.data && typeof seg.data === 'object' ? seg.data : {}
    for (const value of [data.url, data.file]) {
      if (/^https?:\/\//i.test(String(value ?? ''))) return String(value)
    }
    return null
  }

  async function mediaUrlFor(seg) {
    const direct = directMediaUrl(seg)
    if (direct) return direct
    const data = seg?.data && typeof seg.data === 'object' ? seg.data : {}
    const fileId = data.file_id ?? data.fileId ?? data.file
    if (fileId != null && http?.ok) {
      try {
        const res = await http.call('get_private_file_url', { file_id: String(fileId) })
        const url = res?.url ?? res?.data?.url ?? null
        if (url) return String(url)
      } catch { /* 取不到就按失败处理 */ }
    }
    return null
  }

  async function collectInboundMedia(raw) {
    if (!cfg.mediaEnabled || !Array.isArray(raw?.message)) return null
    const peerId = senderIdOf(raw)
    const sender = String(raw.sender?.card || raw.sender?.nickname || peerId || '')
    const messageId = raw.message_id ?? null
    const at = inboundAt(raw)
    const fetchImpl = cfg.mediaFetchImpl ?? globalThis.fetch
    const images = []
    const mediaFiles = []
    const errors = []
    const appended = []
    let imageFailures = 0
    let imageOversize = false

    const imageSegs = raw.message.filter((seg) => seg?.type === 'image' || seg?.type === 'mface').slice(0, Math.max(0, cfg.maxImages))
    for (let i = 0; i < imageSegs.length; i += 1) {
      const item = extractMedia([imageSegs[i]])[0]
      if (!item) continue
      try {
        const fetched = await fetchImageMedia(item, {
          fetchImpl,
          getImage: http?.ok ? (file) => http.call('get_image', { file }) : null,
          maxBytes: cfg.maxImageBytes,
        })
        if (fetched.error) throw new Error(fetched.error)
        const saved = saveInboxMedia({
          dir: mediaDir, kind: 'image', buffer: fetched.buffer, mimeType: fetched.mimeType,
          at, messageId, peerId, sender, index: i + 1, originalName: item.file || '',
        })
        images.push({ data: fetched.buffer, mediaType: fetched.mimeType, name: path.basename(saved.path), path: saved.path })
        mediaFiles.push({ kind: 'image', path: saved.path, bytes: saved.bytes, mime: saved.mime })
        // 图片附件不可用时的兜底：正文也写本地路径（像视频一样），否则模型只看到 "[图片]"，
        // 既不知道文件在哪，也无法用 read_image / album_import 继续处理。
        appended.push(`\n[图片已保存：${saved.path}]`)
        stats.mediaSaved += 1
        stats.mediaBytes += saved.bytes
        maybeWarnMediaSize()
      } catch (error) {
        imageFailures += 1
        stats.mediaFailed += 1
        const message = String(error?.message ?? error)
        if (/超限/.test(message)) imageOversize = true
        errors.push(`image: ${message.slice(0, 120)}`)
      }
    }
    if (imageFailures > 0) appended.push(`\n（图片未能获取${imageOversize ? '：超限' : ''}）`)

    const videoSegs = raw.message.filter((seg) => seg?.type === 'video').slice(0, 1)
    for (const seg of videoSegs) {
      try {
        const url = await mediaUrlFor(seg)
        if (!url) throw new Error('没有可用的视频地址')
        const fetched = await safeFetchBuffer(url, { fetchImpl, maxBytes: cfg.maxVideoBytes, label: '视频' })
        const accepted = acceptVideoBuffer(fetched.buffer, { maxBytes: cfg.maxVideoBytes })
        const saved = saveInboxMedia({
          dir: mediaDir, kind: 'video', buffer: accepted.buffer, mimeType: accepted.mimeType,
          at, messageId, peerId, sender, index: 1, originalName: seg?.data?.name ?? '',
        })
        mediaFiles.push({ kind: 'video', path: saved.path, bytes: saved.bytes, mime: saved.mime })
        stats.mediaSaved += 1
        stats.mediaBytes += saved.bytes
        maybeWarnMediaSize()
        appended.push(`\n[视频已保存：${saved.path}]`)
      } catch (error) {
        stats.mediaFailed += 1
        const reason = String(error?.message ?? error).replace(/https?:\/\/[^\s]+/g, '(链接)').slice(0, 80)
        errors.push(`video: ${reason}`)
        appended.push(`\n[视频获取失败：${reason}]`)
      }
    }

    const fileSegs = raw.message.filter((seg) => seg?.type === 'file').slice(0, Math.max(0, MEDIA_DEFAULTS.maxFiles))
    for (let i = 0; i < fileSegs.length; i += 1) {
      const seg = fileSegs[i]
      const data = seg?.data && typeof seg.data === 'object' ? seg.data : {}
      const originalName = String(data.name ?? data.file_name ?? '')
      try {
        const url = await mediaUrlFor(seg)
        if (!url) throw new Error('没有可用的文件地址')
        const fetched = await safeFetchBuffer(url, { fetchImpl, maxBytes: cfg.maxFileBytes, label: '文件' })
        const saved = saveInboxMedia({
          dir: mediaDir, kind: 'file', buffer: fetched.buffer, mimeType: String(data.mime ?? ''),
          at, messageId, peerId, sender, index: i + 1, originalName,
        })
        mediaFiles.push({ kind: 'file', path: saved.path, bytes: saved.bytes, mime: saved.mime })
        stats.mediaSaved += 1
        stats.mediaBytes += saved.bytes
        maybeWarnMediaSize()
        appended.push(`\n[文件已保存：${saved.path}]`)
      } catch (error) {
        stats.mediaFailed += 1
        const reason = String(error?.message ?? error).replace(/https?:\/\/[^\s]+/g, '(链接)').slice(0, 80)
        errors.push(`file: ${reason}`)
        appended.push(`\n[文件获取失败：${reason}]`)
      }
    }

    if (errors.length) ctx.log({ level: 'info', msg: 'qq.media.partial', messageId, errors: errors.slice(0, 3) })
    return { images, mediaFiles, errors, appended: appended.join('') }
  }

  /**
   * P0-2 入站富内容：进闸门前做三件"慢但必要"的事（都受配置控制、失败不阻塞消息）：
   *   1) 引用解析：`get_msg` 慢取缓存；等不到就放占位文字，不丢原消息；
   *   2) 合并转发展开：`get_forward_msg` 取一层/两层，拼成可读文本（有深度/字数上限）；
   *   3) 媒体：图片抓取字节（bridge 换 attachment）；视频/文件落本地媒体目录。
   */
  async function enrichInbound(raw) {
    if ((!cfg.richEnabled && !cfg.mediaEnabled) || !Array.isArray(raw?.message)) return raw
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
    const media = await collectInboundMedia({ ...raw, message })
    if (media) {
      if (media.appended) message = [...message, { type: 'text', data: { text: media.appended } }]
      enriched = { ...(enriched ?? raw), __qqMedia: media }
    }
    return message === raw.message && !enriched ? raw : { ...(enriched ?? raw), message }
  }

  function handleEvent(raw, { backfilled = false } = {}) {
    if (disposed) return { accept: false, code: 'disposed' }
    stats.frames += 1
    // 戳一戳（OneBot notice: notice_type=notify / sub_type=poke，或直接 notice_type=poke）：
    // 不是消息，之前的 gate 当 not-message 丢掉；这里单独入口，只接受 owner/白名单，
    // 目标必须是机器人自己（群戳忽略），给模型一条"有人戳你"的信号，而不是伪造用户消息。
    const isPoke = raw?.post_type === 'notice'
      && (raw?.sub_type === 'poke' || raw?.notice_type === 'poke'
        || (raw?.notice_type === 'notify' && String(raw?.sub_type ?? '') === 'poke'))
    if (isPoke) {
      const fromId = String(raw?.user_id ?? raw?.sender_id ?? '')
      const targetId = raw?.target_id == null ? null : String(raw.target_id)
      const selfId = raw?.self_id == null ? null : String(raw.self_id)
      const allowed = (cfg.ownerQQ != null && fromId === String(cfg.ownerQQ))
        || cfg.allowAllPrivate === true
        || cfg.allowPrivate.map(String).includes(fromId)
      if (!allowed) return { accept: false, code: 'not-allowlisted' }
      if (targetId != null && selfId != null && targetId !== selfId) return { accept: false, code: 'poke-not-me' }
      const at = now()
      const name = senderKindOf(fromId) === 'owner' ? '主人' : `QQ ${fromId}`
      stats.poke = (stats.poke ?? 0) + 1
      ctx.signals.offer({
        from: { plugin: 'qq', activity: `qq:private:${fromId}` },
        kind: 'notice',
        text: `[QQ戳一戳] ${name} 戳了戳你（这不是对方发来的消息；可以回应，也可以发回一个戳一戳）`,
        tags: ['qq', 'private', 'poke'],
        meta: {
          qq: {
            poke: { from: fromId, target: targetId, at, fromSelf: fromId === String(raw?.self_id ?? '') },
            envelope: { channel: 'qq', scope: 'private', senderKind: senderKindOf(fromId), peerId: fromId, activity: `qq:private:${fromId}`, at },
          },
        },
      })
      return { accept: true, code: 'poke' }
    }
    if (raw?.post_type === 'meta_event') {
      stats.meta += 1
      connector?.onMeta?.() // 保留扩展点：当前只更新连接器内部 lastPacketAt
      return { accept: false, code: 'meta' }
    }
    // 带引用/转发/媒体的消息才需要异步慢取；普通文本保持同步路径（现有调用方/测试语义不变）。
    const hasMediaSegments = cfg.mediaEnabled && raw?.post_type === 'message' && Array.isArray(raw.message)
      && raw.message.some((seg) => ['image', 'mface', 'video', 'file'].includes(seg?.type))
    const needsEnrich = raw?.post_type === 'message' && Array.isArray(raw.message)
      && (hasMediaSegments || (cfg.richEnabled && (extractReplyId(raw.message) != null || extractForwardIds(raw.message).length > 0)))
    if (needsEnrich) return enrichInbound(raw).then((event) => ingestEvent(event, { backfilled }))
    return ingestEvent(raw, { backfilled })
  }

  function senderKindOf(peerId) {
    const peer = String(peerId ?? '')
    if (cfg.ownerQQ != null && peer === String(cfg.ownerQQ)) return 'owner'
    if (cfg.allowPrivate.map(String).includes(peer)) return 'allowlisted'
    return 'stranger'
  }

  function envelopeLabelFor(kind) {
    return kind === 'owner' ? '[QQ私聊·主人]' : '[QQ私聊]'
  }

  /**
   * A2/B1/B2 说话人信封（QQ 侧）：
   *   · 正文前加不可伪造的来源标签（owner/白名单），让模型不用靠猜；
   *   · 结构化字段放 meta.qq.envelope（渠道/会话/发送者/是否补课/时间），供后续工具与 bridge 使用；
   *   · 不伪造"被 focus/time 拦过"——那由 time 的重放前缀/积压摘要表达；补课由 gate 的 `[补课]` 表达。
   * 文字会随 time backlog 的 text 一起重放（envelope 不丢）；bridge 若要独立渲染来源需读 meta（见 docs/QQ.md §7.5）。
   */
  function applySenderEnvelope(signal, decision) {
    if (!cfg.senderEnvelope) return
    const scope = signal.meta?.qq?.scope === 'group' ? 'group' : 'private'
    if (scope === 'group') {
      const groupName = String(signal.meta?.qq?.groupName ?? decision.groupId ?? '')
      const groupLabel = groupName ? `[QQ群·${groupName}]` : '[QQ群]'
      signal.text = `${groupLabel} ${signal.text}`
      signal.meta.qq.envelope = {
        channel: 'qq',
        scope: 'group',
        groupId: String(decision.groupId ?? ''),
        groupName,
        senderId: decision.senderId == null ? null : String(decision.senderId),
        senderName: String(decision.senderName ?? ''),
        activity: signal.from.activity,
        backfilled: decision.backfilled === true,
        at: decision.messageAt ?? null,
        receivedAt: decision.receivedAt ?? null,
        messageId: decision.messageId == null ? null : String(decision.messageId),
      }
      return
    }
    const kind = senderKindOf(decision.peerId)
    signal.text = `${envelopeLabelFor(kind)} ${signal.text}`
    signal.meta.qq.envelope = {
      channel: 'qq',
      scope: 'private',
      senderKind: kind,
      peerId: String(decision.peerId),
      senderId: decision.senderId == null ? null : String(decision.senderId),
      senderName: String(decision.senderName ?? ''),
      activity: signal.from.activity,
      backfilled: decision.backfilled === true,
      at: decision.messageAt ?? null,
      receivedAt: decision.receivedAt ?? null,
      messageId: decision.messageId == null ? null : String(decision.messageId),
    }
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
    applySenderEnvelope(signal, decision)
    // 群聊 G1 没有 per-group wake 矩阵：群消息只走 focus ambient/pierce，不生成 nudge。
    if (signal.meta?.qq?.scope !== 'group') noteWakeInbound(signal.from.activity)
    const inboundMedia = event.__qqMedia
    if (inboundMedia) {
      if (inboundMedia.images?.length) signal.images = inboundMedia.images
      if (inboundMedia.mediaFiles?.length) signal.meta.qq.mediaFiles = inboundMedia.mediaFiles
      if (inboundMedia.errors?.length) signal.meta.qq.mediaErrors = inboundMedia.errors.slice(0, 5)
    }
    stats.accepted += 1
    stats.recent.lastAccepted = {
      at: decision.messageAt,
      receivedAt: decision.receivedAt,
      peerId: decision.peerId,
      senderName: decision.senderName,
      messageId: decision.messageId,
      text: String(decision.text ?? '').slice(0, 80),
      envelope: signal.meta.qq.envelope ?? null,
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
          text: signal.text,
          mention: Array.isArray(signal.tags) && signal.tags.includes('mention'),
          media: signal.meta.qq.mediaFiles ?? null,
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
      text: decision.text,
      messageAt: decision.messageAt,
      receivedAt: decision.receivedAt,
      peerId: decision.peerId,
      messageId: decision.messageId,
      backfilled: decision.backfilled === true,
      segments: signal.meta.qq.segments,
      envelope: signal.meta.qq.envelope ?? null,
    })
    // 发送中收到新消息：通知发送链在"当前气泡发完后"停下（finish-then-handle）。
    try { sendHandle?.noteInbound?.(signal.meta?.qq?.envelope?.peerId ?? null) } catch { /* 发送链未注册不阻塞入站 */ }
    // 显式 wait 正在等这个会话：消息交给 waiter，不再走正常 debounce/delivery，避免双投。
    if (takeWaiterSignal(signal)) return decision
    // debounce 关闭时也要有 busyness：安静群的普通消息直达，短时间刷屏才进 ambient backlog。
    if (signal.meta?.qq?.scope === 'group' && !cfg.inboundDebounce.enabled) {
      const key = String(signal.from.activity)
      const at = now()
      const list = (groupArrivals.get(key) ?? []).filter((t) => at - t < RATE_WINDOW_MS)
      list.push(at)
      groupArrivals.set(key, list)
      if (list.length > RATE_FAST && !signal.tags?.includes('at') && !signal.tags?.includes('mention')) {
        signal.tags = [...new Set([...(signal.tags ?? []), 'ambient'])]
        signal.meta.ambient = true
      }
    }
    // 入站防抖：同一个人连发时先攒成一批；关闭时 push 会同步走 offer，行为不变。
    if (inboundDebouncer) inboundDebouncer.push(signal)
    else offer(signal)
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
      const verdict = classifyOfferOutcome(out)
      if (verdict === 'delivered') { retry.splice(i, 1); stats.delivered += 1; markLedgerDelivered(item.signal); continue }
      if (verdict === 'queued') { retry.splice(i, 1); recordQueued(item.signal, out); continue }
      if (verdict === 'deduped') { retry.splice(i, 1); stats.dedupedAtSignals += 1; continue }
      if (verdict === 'blocked') {
        // 重试时才发现时间锁：交给 time 的 backlog，不继续重试
        retry.splice(i, 1)
        stats.blocked += 1
        bump(stats.blockedReasons, out.reason ?? 'gate')
        record({ kind: 'blocked', id: item.signal.id, reason: out.reason ?? 'gate' })
        markLedgerBlocked(item.signal, out.reason ?? 'gate')
        continue
      }
      if (verdict === 'expired') { retry.splice(i, 1); stats.expired += 1; continue }
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
    // 入站媒体统一目录：显式配置优先；给了 state 文件就跟它同级；否则 ICL_ROOT/inbox/qq。
    const anchor = cfg.ledgerFile || cfg.dedupeFile || cfg.recordFile || cfg.statusFile
    if (cfg.mediaInboxDir) mediaDir = resolvePath(cfg.mediaInboxDir)
    else if (anchor) mediaDir = path.join(path.dirname(resolvePath(anchor)), 'media/inbox/qq')
    else mediaDir = iclPaths().qqInboxDir
    ctx.log({
      msg: 'qq.media.ready',
      dir: mediaDir,
      enabled: cfg.mediaEnabled,
      maxImages: cfg.maxImages,
      maxImageBytes: cfg.maxImageBytes,
      maxVideoBytes: cfg.maxVideoBytes,
      maxFileBytes: cfg.maxFileBytes,
      retentionDays: cfg.mediaRetentionDays,
      softLimitBytes: cfg.mediaSoftLimitBytes,
    })
    stats.mediaBytes = dirBytes(mediaDir)
    if (stats.mediaBytes > cfg.mediaSoftLimitBytes && cfg.mediaSoftLimitBytes > 0) {
      stats.mediaSoftWarned = true
      ctx.log({ level: 'warn', msg: 'qq.media.over-soft-limit', bytes: stats.mediaBytes, limitBytes: cfg.mediaSoftLimitBytes, dir: mediaDir })
    }
    // 表情包本地库：显式配置优先；跟 state 文件走时沿用旧位置；否则 ICL_ROOT/media/stickers（不自动下载/不执行）。
    cfg.stickerDir = cfg.stickerDir
      ? resolvePath(cfg.stickerDir)
      : (anchor ? path.join(path.dirname(path.dirname(mediaDir)), 'stickers') : iclPaths().stickersDir)
    cfg.stickerLibraryFile = cfg.stickerLibraryFile ? resolvePath(cfg.stickerLibraryFile) : path.join(cfg.stickerDir, 'library.json')
    ctx.log({ msg: 'qq.stickers.ready', dir: cfg.stickerDir, libraryFile: cfg.stickerLibraryFile, maxBytes: cfg.maxStickerBytes, listLimit: cfg.stickerListLimit })
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
    if (cfg.wakeEnabled) {
      wakePlanner = createWakePlanner({
        now,
        config: {
          replyCheckEnabled: cfg.replyCheckEnabled,
          replyCheckDelayMs: cfg.replyCheckDelayMs,
          proactiveEnabled: cfg.proactiveEnabled,
          proactiveMinMs: cfg.proactiveMinMs,
          proactiveMaxMs: cfg.proactiveMaxMs,
          proactiveIdleMs: cfg.proactiveIdleMs,
          proactiveProbability: cfg.proactiveProbability,
          proactiveCooldownMs: cfg.proactiveCooldownMs,
          nudgeEnabled: cfg.nudgeEnabled,
          nudgeSoftMs: cfg.nudgeSoftMs,
          nudgeCooldownMs: cfg.nudgeCooldownMs,
          nudgeMaxPerHour: cfg.nudgeMaxPerHour,
          maxWakePerHour: cfg.maxWakePerHour,
        },
        unreadCount: (activity) => {
          try { return ledger?.unread(activity, { limit: 100 }).messages.length ?? 0 } catch { return 0 }
        },
      })
      wakeTimer = setInterval(pollWake, Math.max(250, Number(cfg.wakeTickMs) || 5000))
      if (typeof wakeTimer.unref === 'function') wakeTimer.unref()
      ctx.log({ msg: 'qq.wake.ready', tickMs: cfg.wakeTickMs, replyCheck: cfg.replyCheckEnabled, proactive: cfg.proactiveEnabled, nudge: cfg.nudgeEnabled, maxPerHour: cfg.wakeMaxPerHour })
    }
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
      allowGroups: [...cfg.allowGroups],
      groupPolicy: cfg.groupPolicy,
      gate: gate.counters(),
      gap: { ...gap, backfill: backfill?.status() ?? null, peers: peerList() },
      wake: wakePlanner?.status() ?? null,
      debounce: inboundDebouncer?.status() ?? null,
      ledger: ledger ? { ...ledger.stats(), watermarks: ledgerWatermarks(), deliveredVia: JSON.parse(JSON.stringify(stats.deliveredVia)) } : { mode: 'off', file: null, activities: 0, messages: 0, delivered: 0, watermarks: [], deliveredVia: {} },
      http: { ok: Boolean(http?.ok), endpointUrl: http?.ok ? sanitizeUrl(http.endpointUrl) : null },
      media: {
        enabled: cfg.mediaEnabled,
        dir: mediaDir || null,
        saved: stats.mediaSaved,
        failed: stats.mediaFailed,
        bytes: stats.mediaBytes,
        softLimitBytes: cfg.mediaSoftLimitBytes,
        overSoftLimit: cfg.mediaSoftLimitBytes > 0 && stats.mediaBytes > cfg.mediaSoftLimitBytes,
        maxImages: cfg.maxImages,
        maxImageBytes: cfg.maxImageBytes,
        maxVideoBytes: cfg.maxVideoBytes,
        maxFileBytes: cfg.maxFileBytes,
        retentionDays: cfg.mediaRetentionDays,
        // 归档是手动的：QQ 只落盘/给路径，不自动 album_import、不上传外部。
        autoAlbum: false,
        autoDelete: false,
      },
      stats: { ...stats, blockedReasons: { ...stats.blockedReasons }, queuedReasons: { ...stats.queuedReasons }, retryPending: retry.length, recent: { ...stats.recent } },
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
    const groupText = s.groupPolicy === 'allowlist'
      ? `只读白名单群 ${s.allowGroups.length ? s.allowGroups.join('、') : '（空，实际不收）'}`
      : '整类忽略'
    lines.push(`机器人账号：${s.selfId ?? '未知'}；可收私聊：${s.allowAllPrivate ? '全部（显式打开）' : (s.allowPrivate.length ? s.allowPrivate.join('、') : '无（白名单为空）')}；群消息：${groupText}`)
    if (s.enabled) {
      const gp = s.gap ?? {}
      const bk = gp.backfill ?? {}
      lines.push(`账本：${s.ledger?.mode ?? 'off'}（${s.ledger?.messages ?? 0} 条消息，已交付 ${s.ledger?.delivered ?? 0}）${s.ledger?.file ? `；文件：${s.ledger.file}` : '；内存模式（重启不保留）'}`)
      lines.push(`断线补课：重连 ${gp.reconnects ?? 0} 次${gp.lastDowntimeMs != null ? `（最近断开 ${Math.round(gp.lastDowntimeMs / 1000)}s）` : ''}；补课 ${gp.backfillRuns ?? 0} 次，补回 ${gp.filled ?? 0} 条，过期跳过 ${gp.dropped ?? 0}，失败 ${gp.failed ?? 0}${gp.unsupported ? `，无 HTTP 端点 ${gp.unsupported} 次` : ''}${s.http?.ok ? '' : '（补课不可用）'}${gp.lastError ? `；最近错误：${gp.lastError}` : ''}`)
      const lw = s.ledger?.watermarks ?? []
      if (lw.length) {
        const blocked = s.stats?.blockedReasons && Object.keys(s.stats.blockedReasons).length
          ? `；被拦原因：${Object.entries(s.stats.blockedReasons).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([reason, count]) => `${reason}×${count}`).join('，')}`
          : ''
        lines.push(`账本水位（delivered ≠ seen ≠ attended）：${lw.map((w) => `${w.peer} 最后#${w.lastSeq}/已交付#${w.deliveredSeq}/已读#${w.attendedSeq}${w.undelivered ? `（未交付 ${w.undelivered}，不会被 mark_read 跨过）` : ''}`).join('；')}${blocked}`)
        const via = s.ledger?.deliveredVia ?? {}
        const viaKeys = Object.keys(via)
        if (viaKeys.length) {
          lines.push(`重放回执（只补 delivered，不算已读）：${viaKeys.map((key) => `${key} 补推 ${via[key].accepted ?? 0} 条（忽略 ${via[key].skipped ?? 0}；调用 ${via[key].calls ?? 0} 次）`).join('；')}`)
        }
        if (s.stats?.queued) {
          const reasons = Object.entries(s.stats.queuedReasons ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([reason, count]) => `${reason}×${count}`).join('，')
          lines.push(`focus 积压（queued ≠ delivered）：本次 ${s.stats.queued} 条${reasons ? `（${reasons}）` : ''}；重放回执后才补 delivered，mark_read 不能跨过`)
        }
      }
      const media = s.media ?? {}
      if (media.enabled) {
        lines.push(`媒体：已存 ${media.saved ?? 0} 条 / ${formatBytes(media.bytes ?? 0)}（软上限 ${formatBytes(media.softLimitBytes ?? 0)}${media.overSoftLimit ? '，已超限只告警不删' : ''}）；失败 ${media.failed ?? 0}；目录：${media.dir}；保留：${media.retentionDays > 0 ? `${media.retentionDays} 天（未自动删）` : '全部保留/手清'}；不自动进 album`)
      const wake = s.wake
      if (wake?.config) {
        lines.push(`唤醒矩阵：回复检查 ${wake.config.replyCheckEnabled ? '开' : '关'}、主动机会 ${wake.config.proactiveEnabled ? '开' : '关'}、积压提醒 ${wake.config.nudgeEnabled ? '开' : '关'}；已发提醒 ${wake.emitted ?? 0}（本小时 ${wake.wakeLastHour ?? 0}/${wake.config.maxWakePerHour}，预算跳过 ${wake.skippedBudget ?? 0}）——都只生成 signal，由 time/focus 决定投递`)
      }
      }
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

  function skillIndexText() {
    return `可用的 QQ 策略条目：${SKILLS.map((s) => `${s.id}（${s.title}）`).join('；')}。用 {skill:"reply"} 读全文；第一次处理 QQ 私聊先读它。`
  }

  function helpText(skill) {
    const raw = String(skill ?? '').trim()
    if (!raw) return skillIndexText()
    const needle = raw.toLowerCase()
    const hit = SKILLS.find((s) => s.id === needle) ?? SKILLS.find((s) => s.title.toLowerCase().includes(needle))
      ?? SKILLS.find((s) => s.id.includes(needle))
    if (!hit) return `没有这个条目：${raw}。${skillIndexText()}`
    try {
      return fs.readFileSync(path.join(SKILL_DIR, hit.file), 'utf8')
    } catch (error) {
      return `读不到策略文档 ${hit.id}：${String(error?.message ?? error)}`
    }
  }

  ctx.tools.register({
    name: 'qq_status',
    summary: '查看 QQ 私聊的当前状态：最近一条消息、最近一次发送回执（ok/rejected/unknown）、断线补课与积压计数。只读，不发送。',
    when: ['回复前确认是否真的有人找你', '怀疑 QQ 消息丢了，或断线后想知道补课结果', '发送结果未知时核对回执'],
    avoid: ['把它当每轮必查的仪表盘（会占上下文）', '想看群消息（G1 用 qq_groups / qq_group_history）', '想发消息（用 qq_send）'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute() { return { text: statusText() } },
  })

  ctx.tools.register({
    name: 'qq_help',
    summary: '读 QQ 聊天策略（按需，不常驻）：何时该回/不回、私聊优先级、群聊 G1 只读边界、谁在说话（说话人信封）。不带参数列出条目。',
    when: ['不确定 QQ 消息该不该回、该怎么理解 [补课]/积压/信封', '第一次处理 QQ 私聊'],
    avoid: ['需要现状或回执（用 qq_status）', '要发消息（用 qq_send）'],
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { skill: { type: 'string', description: '策略 id（当前只有 reply）；不填列出可用条目。' } },
    },
    async execute({ skill } = {}) { return { text: helpText(skill) } },
  })

  function ledgerPeerOf(activity) {
    const match = /^qq:private:([1-9]\d{0,11})$/.exec(String(activity ?? ''))
    return match ? match[1] : null
  }

  function ledgerLatestActivity() {
    const rows = ledger?.activities() ?? []
    const hit = rows.find((row) => ledgerPeerOf(row.activity))
    return hit ? String(hit.activity) : null
  }

  function ledgerActivityFor(peer) {
    return activityIdForPrivate(String(peer))
  }

  function resolveLedgerPeer(peer) {
    const raw = peer == null ? '' : String(peer).trim()
    if (raw) return raw
    const latest = ledgerLatestActivity()
    return latest ? ledgerPeerOf(latest) : null
  }

  function formatLedgerTime(at) {
    const n = Number(at)
    if (!Number.isFinite(n) || n <= 0) return '时间未知'
    try { return new Date(n).toLocaleString('zh-CN', { hour12: false }) } catch { return '时间未知' }
  }

  function formatLedgerRow(row) {
    const sender = row.sender ? `[${row.sender}] ` : ''
    const flag = row.deliveredAt == null
      ? ` [未交付${row.blockedReason ? `·被拦：${row.blockedReason}` : ''}]`
      : ''
    return `#${row.seq} ${formatLedgerTime(row.at)} ${sender}${row.text || ''}${flag}`.trim()
  }

  ctx.tools.register({
    name: 'qq_unread',
    summary: '看 QQ 私聊未读（账本口径，三个数分开：lastSeq 最后一条 / deliveredSeq 连续已交付高水位 / attendedSeq 已读水位）。被 time/focus 拦下的消息算"未交付"，不会被 mark_read 跨过，也不会从 unread 里消失。',
    when: ['想知道有没有还没处理的 QQ 私聊', '想确认上次看到哪条（水位）', '怀疑有被睡眠/静音拦下的消息'],
    avoid: ['把 delivered 当成"模型看过"（delivered 只代表进了投递队列）', '用 qq_history 补看具体内容'],
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        peer: { type: 'string', description: '私聊 QQ 号；不填汇总所有有记录的私聊。' },
        afterSeq: { type: 'number', description: '只看这个 seq 之后的未读（默认用账本水位）。' },
        limit: { type: 'number', description: '最多返回几条（默认 20，上限 100）。' },
      },
    },
    async execute({ peer, afterSeq, limit } = {}) {
      if (!ledger) return { text: '账本未启用，无法查询未读。' }
      const targetPeer = peer == null ? null : String(peer).trim()
      if (!targetPeer) {
        const rows = (ledger.activities() ?? []).map((row) => ({ ...row, peer: ledgerPeerOf(row.activity) })).filter((row) => row.peer)
        if (!rows.length) return { text: '还没有任何 QQ 私聊记录。' }
        const lines = rows.map((row) => {
          const known = ledger.lastKnown(row.activity)
          const attended = known?.attendedSeq ?? row.attendedSeq ?? 0
          const delivered = known?.deliveredSeq ?? row.deliveredSeq ?? 0
          const last = known?.lastSeq ?? row.total ?? 0
          const undelivered = Math.max(0, last - delivered)
          return `- ${row.peer}：最后 #${last}，已交付 #${delivered}，水位 #${attended}，未读约 ${Math.max(0, last - attended)} 条${undelivered ? `（其中未交付 ${undelivered} 条，不会被 mark_read 跨过）` : ''}`
        })
        return { text: `QQ 私聊账本（delivered ≠ seen ≠ attended）：\n${lines.join('\n')}\n用 qq_unread {peer:"QQ号"} 看具体未读，或 qq_history 补看。` }
      }
      const activity = ledgerActivityFor(targetPeer)
      const out = ledger.unread(activity, { afterSeq: afterSeq == null ? null : Number(afterSeq), limit })
      const head = `私聊 ${targetPeer}：最后 #${out.watermark.lastSeq}，已交付 #${out.watermark.deliveredSeq}，水位 #${out.watermark.attendedSeq}`
      if (!out.messages.length) return { text: `${head}；没有水位之后的未读消息。` }
      const undelivered = out.messages.filter((row) => row.deliveredAt == null).length
      return {
        text: `${head}；未读 ${out.messages.length} 条${undelivered ? `（其中未交付 ${undelivered} 条：可能被 time/focus 拦下，详见行尾标记；mark_read 不能跨过）` : ''}：\n${out.messages.map(formatLedgerRow).join('\n')}`,
      }
    },
  })

  ctx.tools.register({
    name: 'qq_history',
    summary: '按私聊/seq 补看 QQ 账本里的历史消息（只读；补课消息正文自带 [补课]，来源信封带 [QQ私聊·主人] 等）。',
    when: ['想回看某条 QQ 私聊之前说了什么', 'qq_unread 显示有旧消息但当前上下文里没有'],
    avoid: ['以为这里能看群消息（群聊用 qq_groups / qq_group_history）', '把它当实时未读（用 qq_unread）'],
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        peer: { type: 'string', description: '私聊 QQ 号；不填用最近一个私聊。' },
        afterSeq: { type: 'number', description: '只看这个 seq 之后。' },
        beforeSeq: { type: 'number', description: '只看这个 seq 之前（补看更早的用）。' },
        limit: { type: 'number', description: '最多几条（默认 20，上限 200）。' },
      },
    },
    async execute({ peer, afterSeq, beforeSeq, limit } = {}) {
      if (!ledger) return { text: '账本未启用，无法查询历史。' }
      const targetPeer = resolveLedgerPeer(peer)
      if (!targetPeer) return { text: '没有可查询的 QQ 私聊记录。' }
      const activity = ledgerActivityFor(targetPeer)
      const rows = ledger.messages(activity, {
        afterSeq: afterSeq == null ? 0 : Number(afterSeq),
        beforeSeq: beforeSeq == null ? null : Number(beforeSeq),
        limit: limit == null ? 20 : Number(limit),
      })
      if (!rows.length) return { text: `私聊 ${targetPeer} 没有符合条件的记录（afterSeq/beforeSeq/limit）。` }
      return { text: `私聊 ${targetPeer} 的账本记录（${rows.length} 条）：\n${rows.map(formatLedgerRow).join('\n')}` }
    },
  })

  ctx.tools.register({
    name: 'qq_groups',
    summary: '列出只读白名单群及各自账本水位/未交付数（群聊 G1 只读，不发群消息）。',
    when: ['想看看哪些群有未处理消息', '准备 focus_enter 某个群之前'],
    avoid: ['以为这里能发群消息（G1 只读）', '把它当群消息正文（用 qq_group_history）'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute() {
      if (!ledger) return { text: '账本未启用，无法查询群。' }
      const ids = [...new Set([...(cfg.allowGroups ?? []).map(String), ...groupWatermarks().map((row) => row.groupId)])]
      if (!ids.length) return { text: cfg.groupPolicy === 'allowlist' ? '白名单群为空。' : '群消息当前整类忽略（groupPolicy=ignore）。' }
      const lines = ids.map((groupId) => {
        const activity = activityIdForGroup(groupId)
        const known = ledger.lastKnown(activity) ?? {}
        const unread = Math.max(0, Number(known.lastSeq ?? 0) - Number(known.deliveredSeq ?? 0))
        const last = (ledger.messages(activity, { limit: 1 }) ?? []).at(-1)
        const focusMark = String(ctx.focus?.current?.()?.label ?? '') === activity ? '（当前 focus）' : ''
        return `· ${groupId}${focusMark}：最后 #${known.lastSeq ?? 0}，未交付 ${unread} 条${last?.text ? `；最近：${String(last.text).slice(0, 80)}` : ''}`
      })
      return { text: `只读群（${ids.length}）：\n${lines.join('\n')}` }
    },
  })

  ctx.tools.register({
    name: 'qq_group_history',
    summary: '按群/seq 补看 QQ 群账本历史（只读；群聊 G1 不发群消息）。',
    when: ['想回看某个白名单群之前说了什么', 'focus_enter 群之后需要具体上下文'],
    avoid: ['把它当实时未读（用 qq_groups）', '想发群消息（G1 只读）'],
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        group: { type: 'string', description: '群号；不填用第一个白名单群/最近有记录的群。' },
        afterSeq: { type: 'number', description: '只看这个 seq 之后。' },
        beforeSeq: { type: 'number', description: '只看这个 seq 之前。' },
        limit: { type: 'number', description: '最多几条（默认 20，上限 200）。' },
      },
    },
    async execute({ group, afterSeq, beforeSeq, limit } = {}) {
      if (!ledger) return { text: '账本未启用，无法查询群历史。' }
      const allowed = new Set([...(cfg.allowGroups ?? []).map(String)])
      const raw = String(group ?? '').trim()
      const target = raw || [...allowed][0] || groupWatermarks()[0]?.groupId
      if (!target) return { text: '没有可查询的白名单群。' }
      if (!allowed.has(target)) return { text: `群 ${target} 不在 allowGroups 白名单里。` }
      const activity = activityIdForGroup(target)
      const rows = ledger.messages(activity, {
        afterSeq: afterSeq == null ? 0 : Number(afterSeq),
        beforeSeq: beforeSeq == null ? null : Number(beforeSeq),
        limit: limit == null ? 20 : Number(limit),
      })
      if (!rows.length) return { text: `群 ${target} 没有符合条件的记录。` }
      return { text: `群 ${target} 的账本记录（${rows.length} 条）：\n${rows.map(formatLedgerRow).join('\n')}` }
    },
  })

  ctx.tools.register({
    name: 'qq_replied',
    summary: '查某条 QQ 私聊是否已经回过（账本口径：成功发出 QQ 回复时，把发送前收到的消息标为已回；不伪造未发出的回复）。',
    when: ['想知道对方某条消息是否已经回过了', '避免重复回复同一条'],
    avoid: ['把它当发送回执（用 qq_status 看 send.recent）', '以为焦点/睡眠拦下的消息已经被回过'],
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        peer: { type: 'string', description: '私聊 QQ 号；不填用最近一个私聊。' },
        messageId: { type: 'string', description: '具体消息 messageId（与正文/信封里的 id 对应）。' },
      },
    },
    async execute({ peer, messageId } = {}) {
      if (!ledger) return { text: '账本未启用，无法查询。' }
      const targetPeer = resolveLedgerPeer(peer)
      if (!targetPeer) return { text: '没有可查询的 QQ 私聊记录。' }
      const activity = ledgerActivityFor(targetPeer)
      if (messageId != null && String(messageId).trim() !== '') {
        const state = ledger.replyState(activity, { messageId: String(messageId).trim() })
        if (!state.found) return { text: `私聊 ${targetPeer} 的账本里没有 messageId=${messageId} 这条消息。` }
        if (state.replied) return { text: `已经回过（#${state.seq}，回于 ${formatLedgerTime(state.repliedAt)}）。` }
        return { text: `还没回过（#${state.seq}，收到于 ${formatLedgerTime(state.at)}）。` }
      }
      const state = ledger.replyState(activity)
      return { text: `私聊 ${targetPeer}：最后 #${state.lastSeq}，已回到 #${state.lastRepliedSeq}${state.lastRepliedAt ? `（${formatLedgerTime(state.lastRepliedAt)}）` : ''}；未回 ${state.unreplied} 条。` }
    },
  })

  ctx.tools.register({
    name: 'qq_mark_read',
    summary: '手动推进 QQ 私聊账本的**已读水位**（只动本地水位；不发消息、不自动回复、不标记"已回"）。只能推进到"连续已交付"高水位：被 time/focus 拦下、从未交付的消息**不许被跨过**。',
    when: ['你已经看过/处理了这些私聊，想消除积压提醒', 'qq_unread 里还有你已经不想再看的旧消息'],
    avoid: ['以为它能跨过未交付消息（不能；那些行会一直是未交付）', '以为它会回复/标记已回', '群消息（群聊 G1 使用 qq_group_history，且不发群）'],
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        peer: { type: 'string', description: '私聊 QQ 号；不填用最近一个私聊。' },
        throughSeq: { type: 'number', description: '推进到这个 seq（不填=连续已交付高水位）；超过已交付部分会被夹住，不会跨过未交付消息。' },
      },
    },
    async execute({ peer, throughSeq } = {}) {
      if (!ledger) return { text: '账本未启用，无法标记。' }
      const targetPeer = resolveLedgerPeer(peer)
      if (!targetPeer) return { text: '没有可标记的 QQ 私聊记录。' }
      const activity = ledgerActivityFor(targetPeer)
      const before = ledger.lastKnown(activity)
      if (!before) return { text: `私聊 ${targetPeer} 还没有账本记录。` }
      const result = ledger.markRead(activity, { throughSeq: throughSeq == null ? null : Number(throughSeq), at: now() })
      const afterUnread = ledger.unread(activity, { limit: 100 }).messages.length
      const undelivered = Math.max(0, (result.lastSeq ?? 0) - (result.deliveredSeq ?? 0))
      const clamped = result.clampedToDelivered === true
      const tail = `最后 #${result.lastSeq}，已交付 #${result.deliveredSeq}，水位 #${result.attendedSeq}，剩余未读 ${afterUnread} 条${undelivered ? `；未交付 ${undelivered} 条（可能被 time/focus 拦下，不会被标掉，也不会从 unread 消失）` : ''}${clamped && !undelivered ? '；请求的 seq 超过已交付部分，已夹住' : ''}。只改了本地水位，没有发消息，也没有标记已回。`
      const text = result.advanced > 0
        ? `已把私聊 ${targetPeer} 的水位从 #${before.attendedSeq ?? 0} 推进到 #${result.attendedSeq}（+${result.advanced}）。${tail}`
        : `私聊 ${targetPeer} 的水位没有推进（已经是 #${result.attendedSeq}）。${tail}`
      return { text }
    },
  })

  ctx.tools.register({
    name: 'qq_wait_for_messages',
    summary: '留在当前私聊里等下一批新消息（显式等待；不是 sleep）。wait 返回的消息不会在下一轮再投一遍。',
    when: ['你刚回完一句，想等对方把话说完再决定下一步', '你想在同一个回合里观察到对方的补充/追问'],
    avoid: ['不要用它代替回复（等不到不会自动生成回复）', '不要和 qq_send 同时开多个 wait', '群聊不存在'],
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        peer: { type: 'string', description: '私聊 QQ 号；不填用 owner/唯一白名单。' },
        timeoutMs: { type: 'number', description: '最长等多久（毫秒，5000–600000，默认 45000）。' },
        quietMs: { type: 'number', description: '对方最后一条之后还要安静多久才算“说完了”（毫秒，1000–30000，默认 10000）。' },
      },
    },
    async execute({ peer, timeoutMs, quietMs } = {}) {
      const fallback = cfg.ownerQQ != null && String(cfg.ownerQQ).trim()
        ? String(cfg.ownerQQ).trim()
        : (cfg.allowPrivate.length === 1 ? String(cfg.allowPrivate[0]) : '')
      const targetPeer = String(peer ?? fallback).trim()
      if (!targetPeer) return { text: '没有可等待的私聊目标。', outcome: 'refused' }
      if (!cfg.allowPrivate.map(String).includes(targetPeer) && String(cfg.ownerQQ ?? '') !== targetPeer) {
        return { text: `目标 ${targetPeer} 不在私聊白名单里，不能等它的消息。`, outcome: 'refused' }
      }
      return waitForMessages({ peer: targetPeer, timeoutMs, quietMs })
    },
  })

  // 给 driver / 测试读的共享能力（不暴露给模型）
  let offWorld = null
  try {
    const world = ctx.services.get('world')
    if (world?.registerSource) {
      offWorld = world.registerSource({
        id: 'qq',
        owner: 'qq',
        title: 'QQ',
        order: 1,
        cap: 1,
        empty: () => '无未读',
        items: () => {
          const s = status()
          if (!s.enabled) return [{ key: 'disabled', brief: '未启用。' }]
          if (!s.connection.connected) return [{ key: 'offline', brief: '未连接。' }]
          const privateUnread = ledgerWatermarks().reduce((sum, row) => sum + Number(row.undelivered ?? 0), 0)
          const groups = groupWatermarks()
          const groupUnread = groups.reduce((sum, row) => sum + Number(row.undelivered ?? 0), 0)
          const parts = []
          if (privateUnread > 0) parts.push(`私聊 ${privateUnread} 条`)
          if (groupUnread > 0) parts.push(`${groups.length} 个群 ${groupUnread} 条`)
          if (!parts.length) return []
          return [{
            key: 'unread',
            brief: `消息未交付：${parts.join('，')}。`,
            detail: `私聊未交付 ${privateUnread} 条；群未交付 ${groupUnread} 条（${groups.length} 个群）。用 qq_unread / qq_groups 查看。`,
          }]
        },
      })
    }
  } catch (error) {
    ctx.log({ level: 'warn', msg: 'qq.world.register', error: String(error?.message ?? error) })
  }

  let offShared = null
  try {
    offShared = ctx.services.provide('qq', {
      status,
      statusText,
      // 跨模块：time/focus 在重放完自己的 backlog 后调用，补推 delivered（不推 attended）。
      // 返回 {ok, accepted, skipped, deliveredSeq, attendedSeq, lastSeq, via}；失败不 throw。
      noteDeliveredSeqs,
      gateCounters: () => gate.counters(),
      flushInbound: () => inboundDebouncer?.flushAll() ?? null,
      notifyPending: (reason = 'session-bind') => notifyPending(reason),
      unreadDigest: (maxChars = 700) => unreadDigest(maxChars),
      sendStatus: () => sendHandle?.status() ?? null,
      killSend: (reason = 'manual') => sendHandle?.killSwitch(reason) ?? { allowSend: liveConfig.allowSend },
      skills: () => SKILLS.map((s) => ({ ...s })),
      help: (skill) => helpText(skill),
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
        if (s.send?.registered) {
          const limit = Number(s.send.perTurn?.limit ?? 0)
          return `QQ 已连接：本轮收到 ${s.stats.delivered} 条私聊；可以调用 qq_send 回（只能回 owner/白名单私聊${limit > 0 ? `，每轮最多 ${limit} 条` : '，本轮不限条数'}）。`
        }
        return `QQ 只读影子：已连接，本轮收到 ${s.stats.delivered} 条私聊（不能回复）。`
      },
    })
  }
  // 每轮开始前把"还没交付的旧消息"带进上下文；不是主动检查，也不依赖心跳。
  try {
    ctx.prompt.onTurn(() => unreadDigest(800, { markDelivered: true }))
  } catch (error) {
    ctx.log({ level: 'warn', msg: 'qq.prompt.on-turn', error: String(error?.message ?? error) })
  }

  start()
  await startSend()

  ctx.onDispose(() => {
    try { disposeWaiters('dispose') } catch { /* 已清理 */ }
    try { inboundDebouncer?.dispose({ flushPending: true }) } catch (error) {
      ctx.log({ level: 'warn', msg: 'qq.debounce.dispose', error: String(error?.message ?? error) })
    }
    inboundDebouncer = null
    disposed = true
    if (retryTimer) { clearInterval(retryTimer); retryTimer = null }
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null }
    if (wakeTimer) { clearInterval(wakeTimer); wakeTimer = null }
    wakePlanner = null
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
    try { offWorld?.() } catch { /* 注销器已执行 */ }
    ctx.log({ msg: 'qq.disposed', delivered: stats.delivered, blocked: stats.blocked, dropped: gate.counters().byCode })
  })

  return { status, statusText, sendStatus: () => sendHandle?.status() ?? null, killSend: (reason) => sendHandle?.killSwitch(reason) ?? null }
}
