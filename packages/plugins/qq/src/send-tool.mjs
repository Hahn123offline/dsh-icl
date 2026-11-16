// qq_send：phase 1「只回私聊」的唯一发放口。
//
// 这个文件被 index.mjs **动态** import（只在三把钥匙打开时）；它才 import 发送实现（outbound.mjs）。
// 于是：默认/影子模式下 index 里没有发送实现，也没有 qq_send 工具；打开时也只有一个工具、一条路径。
//
// 策略全部在这里做（传输层只负责发与三态回执）：
//   · 目标：只私聊、只 owner/白名单；群永远拒绝
//   · 内容：markdown→纯文本（可关）、非空、单条不超长、敏感信息拦截
//   · 人类化：一段话可以被拆成 1–8 条气泡，条间 1–3s / 20% 长停顿 5–10s / 按字数的 typing 模式
//   · 限速：同 peer 最小间隔、每分钟/每小时上限、同文窗口去重、每轮最多 N 次调用（turn-end 重置）
//   · 失败不冒充成功：三态文本明确写"没发出去：原因"；unknown 不自动重试；部分成功如实报 k/N
//   · 审计：JSONL 每条气泡一行，只存 hash/长度/结果，不存正文
//   · kill switch：每次调用和**每条气泡**前都重读 live config
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  SEND_APPROVAL_TOKEN,
  checkSendContent,
  checkGroupAdminTarget,
  checkSendTarget,
  createOutbound,
  resolveSendTarget,
  sendEnabled,
} from './outbound.mjs'
import { BURST, delay, mdToPlain, planBurst, splitLongText } from './humanize.mjs'
import { acceptImageBuffer } from './media.mjs'
import { loadStickerLibrary, mergeStickerEntries, noteSticker, queryStickerEntries, recordStickerUse, saveStickerLibrary } from './sticker-store.mjs'

function hash(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 16)
}

function defaultTarget(cfg = {}) {
  if (cfg.ownerQQ != null && String(cfg.ownerQQ).trim()) return String(cfg.ownerQQ).trim()
  const allow = Array.isArray(cfg.allowPrivate) ? cfg.allowPrivate.map(String) : []
  return allow.length === 1 ? allow[0] : null
}

function num(value, fallback, { min = 0, max = Number.POSITIVE_INFINITY } = {}) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv'])
const VOICE_EXT = new Set(['.mp3', '.wav', '.ogg', '.amr', '.silk', '.m4a', '.flac'])
const BLOCKED_FILE_EXT = new Set(['.exe', '.bat', '.cmd', '.ps1', '.dll', '.scr', '.msi', '.js', '.vbs', '.com', '.lnk', '.jar'])

/** 本地媒体发送前的文件校验：绝对/相对路径、普通文件、非符号链接、大小上限。 */
export function inspectMediaFile(filePath, { maxBytes = 0, requireExts = null } = {}) {
  const raw = String(filePath ?? '').trim()
  if (!raw) throw new Error('媒体路径为空')
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) throw new Error('只接受本地文件路径，不接受 URL')
  const abs = path.resolve(raw)
  const st = fs.lstatSync(abs)
  if (st.isSymbolicLink()) throw new Error('不接受符号链接')
  if (!st.isFile()) throw new Error('不是普通文件')
  if (!st.size) throw new Error('文件为空')
  if (maxBytes > 0 && st.size > maxBytes) throw new Error(`文件超限：${(st.size / 1048576).toFixed(1)}MB > ${(maxBytes / 1048576).toFixed(0)}MB`)
  const ext = path.extname(abs).toLowerCase()
  if (requireExts && !requireExts.has(ext)) throw new Error(`不接受这种文件类型：${ext || '(无扩展名)'}`)
  return { path: abs, name: path.basename(abs), bytes: st.size, ext }
}

export async function registerSendTool({
  ctx,
  cfg = {},
  liveConfig = {},
  endpoint = null,
  log = () => {},
  now = () => Date.now(),
  outboundFactory = createOutbound,
  validateReply = null,
  onSendStart = null,
  onSent = null,
} = {}) {
  if (!endpoint?.ok) throw new Error('qq_send 需要可用的 OneBot 端点')
  const outbound = outboundFactory({
    url: endpoint.url,
    token: endpoint.token,
    cfg,
    now,
    log,
    requestTimeoutMs: Number(cfg.sendTimeoutMs) || 15_000,
  })
  outbound.start()

  const state = {
    turnSent: 0,
    mediaTurnSent: 0,
    peers: new Map(), // peer -> { times: [], lastText: null, lastTextAt: 0 }
    recent: null,
    counts: { ok: 0, rejected: 0, unknown: 0, refused: 0, interrupted: 0 },
  }

  const live = liveConfig ?? {}
  const sleepImpl = typeof cfg.sleepImpl === 'function' ? cfg.sleepImpl : delay
  const randomImpl = typeof cfg.randomImpl === 'function' ? cfg.randomImpl : Math.random

  /** kill switch：每次都重读 live config（运行中改 allowSend 立即生效）。 */
  function keysNow() {
    return sendEnabled({ enabled: live.enabled, allowSend: live.allowSend, sendApproval: live.sendApproval })
  }
  // 仅供测试/运维：把 live config 显式关掉（不写文件，只改内存对象）
  function killSwitch(reason = 'manual') {
    live.allowSend = false
    outbox.length = 0
    if (outboxTimer) { try { clearTimeout(outboxTimer) } catch { /* 已触发 */ } outboxTimer = null }
    activePeers.clear()
    interruptedPeers.clear()
    idempotency.clear()
    log({ level: 'warn', msg: 'qq.send.kill-switch', reason })
    return { allowSend: live.allowSend }
  }

  function audit(row) {
    if (!cfg.auditFile) return
    try {
      fs.mkdirSync(path.dirname(cfg.auditFile), { recursive: true })
      fs.appendFileSync(cfg.auditFile, `${JSON.stringify({ at: now(), ...row })}\n`, 'utf8')
    } catch (error) {
      ctx.log({ level: 'warn', msg: 'qq.send.audit-fail', error: String(error?.message ?? error) })
    }
  }

  function peerState(peer) {
    let row = state.peers.get(peer)
    if (!row) { row = { times: [], lastText: null, lastTextAt: 0 }; state.peers.set(peer, row) }
    return row
  }

  function refuse(error, detail = {}) {
    state.counts.refused += 1
    audit({ kind: 'send', peerId: detail.peerId ?? null, chars: detail.chars ?? 0, textHash: detail.hash ?? null, outcome: 'refused', error })
    return { text: `没发出去：${error}`, refused: true, outcome: 'refused' }
  }

  // ── 表情包（本地库；不下载远程、不执行任何文件） ─────────────────────────
  const stickerDir = cfg.stickerDir ? path.resolve(cfg.stickerDir) : ''
  const stickerLibraryFile = cfg.stickerLibraryFile
    ? path.resolve(cfg.stickerLibraryFile)
    : (stickerDir ? path.join(stickerDir, 'library.json') : '')
  const maxStickerBytes = Math.max(1024, Math.min(20 * 1024 * 1024, Number(cfg.maxStickerBytes) || 10 * 1024 * 1024))
  const stickerListLimit = Math.max(1, Math.min(200, Number(cfg.stickerListLimit) || 100))
  const STICKER_EXT = /\.(png|jpe?g|gif|webp)$/i

  function loadLibrary() {
    return loadStickerLibrary(stickerLibraryFile)
  }

  function stickerFiles() {
    if (!stickerDir) return []
    let entries
    try { entries = fs.readdirSync(stickerDir, { withFileTypes: true }) } catch { return [] }
    const out = []
    for (const entry of entries) {
      if (!entry.isFile() || !STICKER_EXT.test(entry.name)) continue
      try {
        const st = fs.lstatSync(path.join(stickerDir, entry.name))
        if (!st.isFile() || st.isSymbolicLink()) continue
        out.push({ id: entry.name, bytes: st.size })
      } catch { /* 单个文件坏不影响列表 */ }
    }
    return out
  }

  function listStickers({ query = '', sort = 'name' } = {}) {
    if (!stickerDir) return []
    const library = loadLibrary()
    const merged = mergeStickerEntries(stickerFiles(), library.error ? { entries: {} } : library)
    return queryStickerEntries(merged, { query, sort }).slice(0, stickerListLimit)
  }

  /** 表情别名：album 里带 sticker 标签的媒体（新的唯一收藏入口在 album）。 */
  function albumStickerItems(query = '') {
    try {
      const album = ctx.services?.get?.('album')
      const rows = album?.list?.({ tag: 'sticker' }) ?? []
      const needle = String(query ?? '').trim().toLowerCase()
      return (Array.isArray(rows) ? rows : []).filter((row) => {
        if (!needle) return true
        return [row.caption, JSON.stringify(row.tags ?? []), row.source, row.path].some((v) => String(v ?? '').toLowerCase().includes(needle))
      })
    } catch { return [] }
  }

  /** 只接受"本地库里的单层文件名"；符号链接/目录/路径穿越一律拒绝。 */
  function readSticker(id) {
    const safe = String(id ?? '').trim()
    if (!safe || safe !== path.basename(safe) || safe.includes('..')) throw new Error('表情 id 必须是本地库里的文件名')
    if (!stickerDir) throw new Error('表情包库未配置（stickerDir 为空）')
    const file = path.join(stickerDir, safe)
    const rel = path.relative(stickerDir, file)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('表情路径不合法')
    const st = fs.lstatSync(file)
    if (!st.isFile() || st.isSymbolicLink()) throw new Error('表情必须是本地普通文件')
    if (st.size > maxStickerBytes) throw new Error(`表情超限：${(st.size / 1048576).toFixed(1)}MB > ${(maxStickerBytes / 1048576).toFixed(0)}MB`)
    const buffer = fs.readFileSync(file)
    const accepted = acceptImageBuffer(buffer, { maxBytes: maxStickerBytes, label: '表情' })
    return { id: safe, buffer: accepted.buffer, mimeType: accepted.mimeType, bytes: accepted.bytes }
  }

  function stickerRateError(peer) {
    const at = now()
    const ps = peerState(peer)
    ps.times = ps.times.filter((t) => at - t < 3600_000)
    const minute = ps.times.filter((t) => at - t < 60_000)
    if (maxPerTurn > 0 && state.turnSent >= maxPerTurn) return `本轮最多 ${maxPerTurn} 条（等下一轮再发）`
    if (ps.times.length && at - ps.times[ps.times.length - 1] < minIntervalMs) return `限流：同一私聊至少 ${Math.round(minIntervalMs / 1000)} 秒一条`
    if (maxPerMinute > 0 && minute.length + 1 > maxPerMinute) return `限流：每分钟最多 ${maxPerMinute} 条`
    if (maxPerHour > 0 && ps.times.length + 1 > maxPerHour) return `限流：每小时最多 ${maxPerHour} 条`
    return null
  }

  const maxPerTurn = Number.isFinite(Number(cfg.maxSendsPerTurn)) ? Math.max(0, Math.floor(Number(cfg.maxSendsPerTurn))) : 1
  const minIntervalMs = num(cfg.sendMinIntervalMs, 5000)
  const maxPerMinute = num(cfg.sendMaxPerMinute, 10)
  const maxPerHour = num(cfg.sendMaxPerHour, 60)
  const sameTextWindowMs = num(cfg.sendSameTextWindowMs, 60_000)
  const burstEnabled = cfg.burstEnabled !== false
  const burstMaxMessages = Math.max(1, Math.floor(num(cfg.burstMaxMessages, BURST.maxMessages)))
  const maxMessageChars = Math.max(1, Math.floor(num(cfg.maxMessageChars, BURST.maxChars)))
  const gapMode = String(cfg.gapMode ?? 'auto')
  const interruptGraceMs = Math.max(0, Math.min(5000, num(cfg.interruptGraceMs, 2000)))
  const targetConfig = () => ({ ...cfg, enabled: true, allowSend: true, sendApproval: SEND_APPROVAL_TOKEN })
  // Phase 2 短队列：默认关；产品 preset 开。关闭时保持原有"超限直接拒绝"语义。
  const outboxEnabled = cfg.outboxEnabled === true
  const outboxMaxPending = Math.max(1, Math.floor(num(cfg.outboxMaxPending, 20)))
  const outboxTtlMs = Math.max(10_000, num(cfg.outboxTtlMs, 5 * 60_000))
  const globalMaxPerMinute = num(cfg.globalSendMaxPerMinute, 0)
  const outbox = []
  const idempotency = new Map() // fingerprint -> { state, at, result }
  let outboxTimer = null
  let outboxBusy = false
  let globalTimes = []
  const activePeers = new Set()
  const interruptedPeers = new Set()
  state.outboxCounts = { queued: 0, sent: 0, dropped: 0, deduped: 0 }

  function pruneGlobal(at = now()) {
    globalTimes = globalTimes.filter((t) => at - t < 60_000)
  }

  /** 发送中收到同会话新消息：标记 finish-then-handle，并取消该会话尚未开始发的队列任务。 */
  function noteInbound(peerId) {
    const peer = String(peerId ?? '').trim()
    if (!peer || !activePeers.has(peer)) return false
    interruptedPeers.add(peer)
    cancelOutboxPeer(peer)
    return true
  }

  function cancelOutboxPeer(peer) {
    let removed = 0
    for (let i = outbox.length - 1; i >= 0; i -= 1) {
      if (outbox[i].peer !== peer) continue
      const [job] = outbox.splice(i, 1)
      removed += 1
      if (job.fingerprint) idempotency.delete(job.fingerprint)
      state.outboxCounts.dropped += 1
      audit({ kind: 'queue', peerId: peer, chars: job.key.length, textHash: hash(job.key), outcome: 'canceled', reason: 'interrupted' })
    }
    return removed
  }

  /** 统一限速判定；includeTurn=false 时供队列 worker 使用（每轮调用额度只在 execute 判）。 */
  function rateIssue(peer, count, { includeTurn = false } = {}) {
    const at = now()
    const ps = peerState(peer)
    ps.times = ps.times.filter((t) => at - t < 3600_000)
    const minute = ps.times.filter((t) => at - t < 60_000)
    if (includeTurn && maxPerTurn > 0 && state.turnSent >= maxPerTurn) return `本轮最多 ${maxPerTurn} 条（等下一轮再发）`
    if (ps.times.length && at - ps.times[ps.times.length - 1] < minIntervalMs) return `同一私聊至少 ${Math.round(minIntervalMs / 1000)} 秒一条`
    if (maxPerMinute > 0 && minute.length + count > maxPerMinute) return `每分钟最多 ${maxPerMinute} 条（本次计划 ${count} 条）`
    if (maxPerHour > 0 && ps.times.length + count > maxPerHour) return `每小时最多 ${maxPerHour} 条（本次计划 ${count} 条）`
    if (globalMaxPerMinute > 0) {
      pruneGlobal(at)
      if (globalTimes.length + count > globalMaxPerMinute) return `全局每分钟最多 ${globalMaxPerMinute} 条`
    }
    return null
  }

  function fingerprintOf(peer, bubbles, replyToMessageId = null) {
    return hash(`${peer}\u0000${bubbles.join('\u0001')}\u0000${replyToMessageId ?? ''}`)
  }

  function idempotencyHit(fingerprint) {
    if (!outboxEnabled || !fingerprint || sameTextWindowMs <= 0) return null
    const row = idempotency.get(fingerprint)
    if (!row || now() - Number(row.at) >= sameTextWindowMs) return null
    return row
  }

  function rememberIdempotency(fingerprint, row) {
    if (!outboxEnabled || !fingerprint) return
    idempotency.set(fingerprint, { at: now(), ...row })
    if (idempotency.size > 200) {
      const oldest = [...idempotency.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (oldest) idempotency.delete(oldest[0])
    }
  }

  function enqueueOutbox(job, reason = null) {
    if (outbox.length >= outboxMaxPending) {
      state.outboxCounts.dropped += 1
      audit({ kind: 'queue', peerId: job.peer, chars: job.key.length, textHash: hash(job.key), outcome: 'refused', error: 'queue-full', reason })
      return refuse(`发送队列已满（${outboxMaxPending} 条），这次没有排队`, { peerId: job.peer, chars: job.key.length, hash: hash(job.key) })
    }
    job.enqueuedAt = now()
    job.expiresAt = job.enqueuedAt + outboxTtlMs
    outbox.push(job)
    state.outboxCounts.queued += 1
    if (job.fingerprint) rememberIdempotency(job.fingerprint, { state: 'queued' })
    audit({ kind: 'queue', peerId: job.peer, chars: job.key.length, textHash: hash(job.key), outcome: 'queued', reason })
    scheduleOutbox(0)
    return {
      text: `已排队（${reason || '前一批还没发完/限流中'}），会按顺序发；不要重复调用。`,
      outcome: 'queued',
      queued: true,
      peerId: job.peer,
    }
  }

  function scheduleOutbox(delayMs = 0) {
    if (!outboxEnabled || outboxBusy || !outbox.length || outboxTimer) return
    outboxTimer = setTimeout(() => {
      outboxTimer = null
      void drainOutbox()
    }, Math.max(0, Number(delayMs) || 0))
    if (typeof outboxTimer.unref === 'function') outboxTimer.unref()
  }

  async function drainOutbox() {
    if (!outboxEnabled || outboxBusy || !outbox.length || !keysNow()) return
    const job = outbox[0]
    if (now() >= Number(job.expiresAt)) {
      outbox.shift()
      state.outboxCounts.dropped += 1
      if (job.fingerprint) idempotency.delete(job.fingerprint)
      audit({ kind: 'queue', peerId: job.peer, chars: job.key.length, textHash: hash(job.key), outcome: 'expired' })
      scheduleOutbox(0)
      return
    }
    const issue = rateIssue(job.peer, job.bubbles.length)
    if (issue) {
      scheduleOutbox(Math.min(1000, Math.max(100, minIntervalMs / 2)))
      return
    }
    outboxBusy = true
    outbox.shift()
    state.outboxCounts.sent += 1
    try {
      await performSend(job)
    } catch (error) {
      log({ level: 'warn', msg: 'qq.outbox.send-fail', peerId: job.peer, error: String(error?.message ?? error) })
    } finally {
      outboxBusy = false
      scheduleOutbox(50)
    }
  }

  /** 真正执行一批发送（execute 与队列 worker 共用）。 */
  async function performSend({ peer, targetId = peer, kind = 'private', bubbles, key, replyToMessageId = null, args = {}, fingerprint = null, fromQueue = false }) {
    const ps = peerState(peer)
    const at = now()
    ps.lastText = key
    ps.lastTextAt = at
    let throughSeq = null
    try { throughSeq = typeof onSendStart === 'function' ? await onSendStart({ peerId: targetId, kind, replyToMessageId, at }) : null } catch { throughSeq = null }
    const plan = planBurst(bubbles, {
      random: randomImpl,
      gapMode: args.gapMode ?? gapMode,
      gapMs: args.gapMs ?? null,
      gaps: Array.isArray(args.gaps) ? args.gaps : null,
      pace: args.pace ?? 'normal',
      maxMessages: burstMaxMessages,
      maxChars: maxMessageChars,
      minGapMs: num(cfg.burstIntervalMinMs, BURST.minGapMs),
      maxGapMs: num(cfg.burstIntervalMaxMs, BURST.maxGapMs),
      longGapChance: num(cfg.longGapProbability, BURST.longGapChance, { max: 1 }),
      longGapMinMs: num(cfg.longGapMinMs, BURST.longGapMinMs),
      longGapMaxMs: num(cfg.longGapMaxMs, BURST.longGapMaxMs),
    })
    const startedAt = now()
    const sent = []
    let failure = null
    activePeers.add(peer)
    interruptedPeers.delete(peer)
    try {
      for (let i = 0; i < plan.length; i += 1) {
        const step = plan[i]
        if (i > 0) {
          if (!keysNow()) { failure = { outcome: 'refused', error: '出站已关闭（kill switch 或三把钥匙未齐）', index: i }; break }
          await sleepImpl(step.delayBeforeMs)
          // finish-then-handle：等待下一气泡期间收到新消息，当前气泡已发完，剩余不发。
          if (interruptedPeers.delete(peer)) {
            failure = { outcome: 'interrupted', error: '收到新消息，停发剩余气泡（finish-then-handle）', index: i }
            break
          }
        }
        if (!keysNow()) { failure = { outcome: 'refused', error: '出站已关闭（kill switch 或三把钥匙未齐）', index: i }; break }
        const bubbleAt = now()
        ps.times.push(bubbleAt)
        pruneGlobal(bubbleAt)
        globalTimes.push(bubbleAt)
        const result = kind === 'group'
          ? await outbound.sendGroup(targetId, step.text, {
            replyToMessageId: i === 0 ? replyToMessageId : null,
            atAll: i === 0 && args.atAll === true,
            atUserIds: i === 0 && Array.isArray(args.mentionUserIds) ? args.mentionUserIds : [],
          })
          : await outbound.sendPrivate(targetId, step.text, { replyToMessageId: i === 0 ? replyToMessageId : null })
        const outcome = result.ok ? 'ok' : (result.outcome === 'rejected' ? 'rejected' : 'unknown')
        state.counts[outcome] += 1
        audit({
          kind: 'send', peerId: targetId, targetKind: kind, chars: step.text.length, textHash: hash(step.text),
          outcome, messageId: result.messageId ?? null, ms: result.ms ?? null,
          batch: { index: i + 1, total: plan.length }, replyTo: i === 0 ? replyToMessageId : null,
          queued: fromQueue || undefined,
          error: result.error ?? null,
        })
        if (!result.ok) { failure = { outcome, error: result.error, index: i }; break }
        sent.push({ messageId: result.messageId, chars: step.text.length, ms: result.ms })
        // finish-then-handle：当前气泡已发完；若期间收到新消息，停止剩余气泡，把新消息留给下一轮。
        if (i < plan.length - 1 && interruptedPeers.delete(peer)) {
          failure = { outcome: 'interrupted', error: '收到新消息，停发剩余气泡（finish-then-handle）', index: i + 1 }
          break
        }
      }
      // 给对方一点时间把插话说完/合并连续几条，再回到模型“接话”。
      if (failure?.outcome === 'interrupted' && interruptGraceMs > 0) await sleepImpl(interruptGraceMs)
    } finally {
      activePeers.delete(peer)
      interruptedPeers.delete(peer)
    }

    const ms = now() - startedAt
    const outcome = !failure && sent.length === plan.length ? 'ok' : (failure?.outcome ?? 'unknown')
    state.recent = {
      at: now(),
      peerId: targetId,
      targetKind: kind,
      outcome,
      replyToMessageId,
      messageId: sent[0]?.messageId ?? null,
      messageIds: sent.map((item) => item.messageId).filter(Boolean),
      sent: sent.length,
      total: plan.length,
      ms,
      chars: bubbles.reduce((sum, text) => sum + text.length, 0),
      error: failure?.error ?? null,
    }
    if (typeof onSent === 'function' && sent.length > 0) {
      try {
        await onSent({
          peerId: targetId, kind, replyToMessageId, sent: sent.length, total: plan.length,
          outcome, throughSeq, at: now(),
        })
      } catch (error) {
        ctx.log({ level: 'warn', msg: 'qq.send.on-sent', error: String(error?.message ?? error) })
      }
    }
    if (fingerprint) {
      if (outcome === 'ok') rememberIdempotency(fingerprint, { state: 'sent', result: { messageId: sent[0]?.messageId ?? null } })
      else if (outcome === 'rejected') idempotency.delete(fingerprint)
      else rememberIdempotency(fingerprint, { state: 'unknown' })
    }
    if (outcome === 'ok') {
      if (plan.length === 1) return { text: `已发出去（messageId=${sent[0]?.messageId}，${ms}ms）。`, outcome: 'ok', messageId: sent[0]?.messageId ?? null }
      return { text: `已发出去 ${plan.length} 条（共 ${ms}ms；messageIds=${sent.map((item) => item.messageId).join(',')}）。`, outcome: 'ok', messageIds: sent.map((item) => item.messageId) }
    }
    if (outcome === 'interrupted') {
      state.counts.interrupted += 1
      const remaining = plan.slice(sent.length).map((step) => step.text)
      state.recent.remaining = remaining
      audit({
        kind: 'send', peerId: targetId, targetKind: kind, outcome: 'interrupted',
        sent: sent.length, total: plan.length, remaining: remaining.length,
        chars: remaining.reduce((sum, text) => sum + text.length, 0),
        replyTo: replyToMessageId, queued: fromQueue || undefined,
      })
      return {
        text: `对面插嘴了：你发到 ${sent.length}/${plan.length} 条时收到新消息；已发 ${sent.length}/${plan.length} 条，剩余 ${remaining.length} 条没发。先接话；不会自动续发，要补发由你自己决定。`,
        outcome: 'interrupted',
        interrupted: true,
        sent: sent.length,
        total: plan.length,
        remaining,
        messageIds: sent.map((item) => item.messageId).filter(Boolean),
      }
    }
    const reason = failure?.error ?? '未知原因'
    const label = outcome === 'unknown' ? `结果未知（${reason}）` : reason
    return {
      text: `没发出去：${label}。已发 ${sent.length}/${plan.length} 条，其余 ${plan.length - sent.length} 条未发送（不自动重试）。`,
      outcome,
      error: reason,
      sent: sent.length,
      total: plan.length,
    }
  }

  function prepareBubbles(args = {}) {
    const rawList = args.messages != null
      ? (Array.isArray(args.messages) ? args.messages : [args.messages])
      : (args.text != null ? [args.text] : [])
    if (!rawList.length) return { error: '消息不能为空（传 text 或 messages[]）' }
    if (rawList.length > burstMaxMessages) {
      return { error: `一次最多 ${burstMaxMessages} 条消息（收到 ${rawList.length} 条）；请分轮发送` }
    }
    const prepared = []
    let rawChars = 0
    for (const raw of rawList) {
      const rawText = String(raw ?? '')
      rawChars += rawText.length
      const converted = cfg.markdownToPlain === false ? rawText : mdToPlain(rawText)
      const content = checkSendContent(cfg, converted)
      if (!content.ok) return { error: content.error, detail: { chars: rawText.length, hash: hash(rawText) } }
      if (content.text) prepared.push(content.text)
    }
    if (!prepared.length) return { error: '消息为空（markdown 清理后没有可发送内容）' }
    const bubbles = prepared.flatMap((text) => splitLongText(text, maxMessageChars)).filter(Boolean)
    if (!bubbles.length) return { error: '消息为空（切分后没有可发送内容）', detail: { chars: rawChars } }
    if (!burstEnabled && bubbles.length > 1) {
      return { error: `已禁用多条发送（内容会拆成 ${bubbles.length} 条），请合并/缩短`, detail: { chars: rawChars, hash: hash(prepared.join('')) } }
    }
    if (bubbles.length > burstMaxMessages) {
      return { error: `内容会拆成 ${bubbles.length} 条，超过单次上限 ${burstMaxMessages}；请合并或缩短`, detail: { chars: rawChars, hash: hash(prepared.join('')) } }
    }
    return { bubbles, key: bubbles.join('\n'), rawChars }
  }

  async function execute(args = {}) {
    if (!keysNow()) return refuse('出站已关闭（kill switch 或三把钥匙未齐）')
    const targetInput = args.to == null || args.to === '' ? defaultTarget(cfg) : String(args.to).trim()
    if (!targetInput) return refuse('没有可发送的目标（owner/白名单/allowGroups 为空）')
    const target = resolveSendTarget(targetConfig(), targetInput)
    if (!target.ok) return refuse(target.error, { peerId: targetInput })
    const kind = target.kind === 'group' ? 'group' : 'private'
    const targetId = String(target.peer ?? target.groupId ?? targetInput)
    const peer = kind === 'group' ? `group:${targetId}` : targetId
    const atAll = args.atAll === true
    const mentionUserIds = Array.isArray(args.mentionUserIds) ? args.mentionUserIds.map(String).filter((id) => /^\d+$/.test(id)) : []
    if (kind !== 'group' && (atAll || mentionUserIds.length)) return refuse('@ 只能用于群消息', { peerId: targetId })
    if (atAll && cfg.allowGroupAtAll !== true) return refuse('@all 未启用（allowGroupAtAll=false）', { peerId: targetId })
    const prepared = prepareBubbles(args)
    if (prepared.error) return refuse(prepared.error, { peerId: targetId, ...(prepared.detail ?? {}) })
    const { bubbles, key } = prepared
    const replyToMessageId = args.replyToMessageId == null || String(args.replyToMessageId).trim() === ''
      ? null
      : String(args.replyToMessageId).trim()
    if (replyToMessageId != null) {
      if (bubbles.length > 1) return refuse('引用回复只支持单条气泡（把内容合并成一条，或去掉 replyToMessageId）', { peerId: targetId, chars: key.length, hash: hash(key) })
      if (typeof validateReply === 'function') {
        let allowed = false
        try { allowed = validateReply({ peerId: targetId, kind, messageId: replyToMessageId }) } catch { allowed = false }
        if (!allowed) return refuse(`引用的消息不在这个${kind === 'group' ? '群' : '私聊'}的账本里（id=${replyToMessageId}），不伪造引用`, { peerId: targetId, chars: key.length, hash: hash(key) })
      }
    }
    const at = now()
    if (maxPerTurn > 0 && state.turnSent >= maxPerTurn) {
      return refuse(`本轮最多 ${maxPerTurn} 条（等下一轮再发）`, { peerId: targetId, chars: key.length, hash: hash(key) })
    }
    const fingerprint = fingerprintOf(peer, bubbles, replyToMessageId)
    if (outboxEnabled) {
      const duplicate = idempotencyHit(fingerprint)
      if (duplicate) {
        state.outboxCounts.deduped += 1
        if (duplicate.state === 'sent') return { text: '这批内容刚发过，没有重复发送。', outcome: 'ok', deduped: true }
        if (duplicate.state === 'queued') return { text: '这批内容已经在发送队列里了，没有重复排队。', outcome: 'queued', deduped: true, queued: true }
        return { text: '这批内容上次发送结果未知；不要重发，先用 qq_status 核对。', outcome: 'unknown', deduped: true }
      }
    } else if (sameTextWindowMs > 0 && peerState(peer).lastText === key && at - peerState(peer).lastTextAt < sameTextWindowMs) {
      return refuse(`重复内容（${Math.round(sameTextWindowMs / 1000)} 秒内已发过同样的话）`, { peerId: targetId, chars: key.length, hash: hash(key) })
    }

    const job = { peer, targetId, kind, bubbles, key, replyToMessageId, args, fingerprint, fromQueue: false }
    const issue = rateIssue(peer, bubbles.length)
    state.turnSent += 1
    if (outboxEnabled && (issue || outbox.length)) {
      return enqueueOutbox(job, issue)
    }
    if (issue) return refuse(`限流：${issue}`, { peerId: targetId, chars: key.length, hash: hash(key) })

    return performSend(job)
  }

  ctx.tools.register({
    name: 'qq_send',
    summary: '发 QQ 消息（唯一 QQ 发送工具）：一段话或 1–8 条短气泡；可发 owner/白名单私聊，或 allowGroupSend 打开的 allowGroups 群。群号和 QQ 号一样直接放 to。',
    when: [
      '你刚看到一条 QQ 私聊/群消息、判断该回',
      '想把回复拆成几条短气泡，而不是一大段',
      '要发到 allowGroups 白名单群，直接传 to: "群号"',
    ],
    avoid: [
      '未启用 allowGroupSend 时发群；不在 allowGroups 的群',
      '图片/视频/文件/语音（用 qq_send_media；表情用 qq_send_sticker）',
      '把媒体当文本发（qq_send 只发文本气泡）',
      '结果 unknown 时盲目重发（可能双发；用 qq_status 核对）',
      '看到“已排队”或“刚发过”后再次调用（队列/幂等会处理，重复调用没有意义）',
      '对方只是发表情/图片且没问话时硬猜内容',
      '引用回复时同时发多条气泡（引用只支持单条）',
    ],
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        text: { type: 'string', description: '单条纯文本回复（Markdown 会转纯文本）。要多气泡用 messages[]。' },
        messages: {
          type: 'array', items: { type: 'string' },
          description: '1–8 条短消息，逐条作为气泡发送；过长内容可能再拆，总气泡数受上限约束。',
        },
        to: { type: 'string', description: '目标 QQ 号（私聊）或群号（allowGroups + allowGroupSend）。省略则用配置的 owner / 唯一白名单私聊。' },
        atAll: { type: 'boolean', description: '群消息 @全体成员；默认关闭，需 allowGroupAtAll=true。' },
        mentionUserIds: { type: 'array', items: { type: 'string' }, description: '群消息 @ 指定成员 QQ 号（最多 10 个）。' },
        replyToMessageId: { type: 'string', description: '要引用的消息 messageId（必须是在这个私聊/群账本里收到的消息；只能配单条 text，不能配 messages[]）。' },
        pace: { type: 'string', description: 'gapMode=typing 时的打字节奏：thoughtful | normal | quick | blast。' },
        gapMode: { type: 'string', description: '气泡间隔：adaptive（产品默认，按下一句字数估打字时间）| auto（1–3s，偶尔 5–10s）| fixed | typing | byLength。' },
        gapMs: { type: 'number', description: 'gapMode=fixed 时的固定间隔（毫秒）。' },
      },
    },
    async execute(args) { return execute(args) },
  })

  async function sendMedia(args = {}) {
    if (!keysNow()) return refuse('出站已关闭（kill switch 或三把钥匙未齐）')
    if (cfg.allowMediaSend !== true) return refuse('媒体发送未启用（allowMediaSend=false）')
    const targetInput = args.to == null || args.to === '' ? defaultTarget(cfg) : String(args.to).trim()
    if (!targetInput) return refuse('没有可发送的目标（owner/白名单/allowGroups 为空）')
    const target = resolveSendTarget(targetConfig(), targetInput)
    if (!target.ok) return refuse(target.error, { peerId: targetInput })
    const kindTarget = target.kind === 'group' ? 'group' : 'private'
    const targetId = String(target.peer ?? target.groupId ?? targetInput)
    const peer = kindTarget === 'group' ? `group:${targetId}` : targetId
    const replyToMessageId = args.replyToMessageId == null || String(args.replyToMessageId).trim() === ''
      ? null
      : String(args.replyToMessageId).trim()
    if (replyToMessageId != null && typeof validateReply === 'function') {
      let allowed = false
      try { allowed = validateReply({ peerId: targetId, kind: kindTarget, messageId: replyToMessageId }) } catch { allowed = false }
      if (!allowed) return refuse(`引用的消息不在这个${kindTarget === 'group' ? '群' : '私聊'}的账本里（id=${replyToMessageId}），不伪造引用`, { peerId: targetId })
    }
    const maxImage = Math.max(1024, num(cfg.maxSendImageBytes, 10 * 1024 * 1024))
    const maxVideo = Math.max(1024, num(cfg.maxSendVideoBytes, 256 * 1024 * 1024))
    const maxFile = Math.max(1024, num(cfg.maxSendFileBytes, 512 * 1024 * 1024))
    const maxVoice = Math.max(1024, num(cfg.maxSendVoiceBytes, 16 * 1024 * 1024))
    const mediaTurnLimit = Math.max(0, Math.floor(num(cfg.maxMediaPerTurn, 3)))
    if (mediaTurnLimit > 0 && state.mediaTurnSent >= mediaTurnLimit) return refuse(`本轮最多发 ${mediaTurnLimit} 个媒体（等下一轮再发）`, { peerId: targetId })
    const mediaHourLimit = Math.max(0, Math.floor(num(cfg.maxMediaPerHour, 20)))
    const recent = peerState(peer).times.filter((t) => now() - t < 3600_000)
    if (mediaHourLimit > 0 && recent.length >= mediaHourLimit) return refuse(`媒体发送太频繁（每小时最多 ${mediaHourLimit} 个）`, { peerId: targetId })
    const issue = rateIssue(peer, 1)
    if (issue) return refuse(`限流：${issue}`, { peerId: targetId })

    let filePath = args.path == null ? '' : String(args.path).trim()
    if (!filePath && args.albumId != null) {
      try {
        const album = ctx.services?.get?.('album')
        const rows = album?.list ? album.list({}) : []
        const hit = (Array.isArray(rows) ? rows : []).find((row) => String(row.id) === String(args.albumId))
        if (!hit?.path) return refuse(`相册里找不到 id=${args.albumId}`, { peerId: targetId })
        filePath = hit.path
      } catch (error) {
        return refuse(`相册查询失败：${String(error?.message ?? error)}`, { peerId: targetId })
      }
    }
    if (!filePath) return refuse('媒体发送需要本地 path 或 albumId', { peerId: targetId })

    const requestedKind = String(args.kind ?? 'auto').toLowerCase()
    const knownKind = requestedKind === 'image' || requestedKind === 'video' || requestedKind === 'voice' || requestedKind === 'file'
      ? requestedKind
      : null
    let info
    try {
      const ext = path.extname(filePath).toLowerCase()
      const guessed = IMAGE_EXT.has(ext) ? 'image' : (VIDEO_EXT.has(ext) ? 'video' : (VOICE_EXT.has(ext) ? 'voice' : 'file'))
      const kind = knownKind ?? guessed
      info = inspectMediaFile(filePath, {
        maxBytes: kind === 'image' ? maxImage : (kind === 'video' ? maxVideo : (kind === 'voice' ? maxVoice : maxFile)),
        requireExts: kind === 'image' ? IMAGE_EXT : (kind === 'video' ? VIDEO_EXT : (kind === 'voice' ? VOICE_EXT : null)),
      })
      info.kind = kind
      if (kind === 'file' && BLOCKED_FILE_EXT.has(info.ext)) {
        return refuse(`不允许发送可执行/脚本文件：${info.ext}`, { peerId: targetId })
      }
      if (kind === 'image') {
        const accepted = acceptImageBuffer(fs.readFileSync(info.path), { maxBytes: maxImage, label: '图片' })
        info.buffer = accepted.buffer
        info.mimeType = accepted.mimeType
      }
    } catch (error) {
      return refuse(String(error?.message ?? error), { peerId: targetId })
    }

    const startedAt = now()
    let result
    if (info.kind === 'image') {
      const segment = { type: 'image', data: { file: `base64://${info.buffer.toString('base64')}`, name: info.name } }
      result = kindTarget === 'group'
        ? await outbound.sendGroupMedia(targetId, segment, { kind: 'image', replyToMessageId, timeoutMs: 60_000 })
        : await outbound.sendPrivateMedia(targetId, segment, { kind: 'image', replyToMessageId, timeoutMs: 60_000 })
    } else if (info.kind === 'file') {
      result = kindTarget === 'group'
        ? await outbound.sendGroupFile(targetId, { path: info.path, name: info.name, bytes: info.bytes })
        : await outbound.sendPrivateFile(targetId, { path: info.path, name: info.name })
    } else {
      const segment = { type: info.kind === 'voice' ? 'record' : 'video', data: { file: info.path } }
      result = kindTarget === 'group'
        ? await outbound.sendGroupMedia(targetId, segment, { kind: info.kind, replyToMessageId, timeoutMs: 120_000, label: info.name })
        : await outbound.sendPrivateMedia(targetId, segment, { kind: info.kind, replyToMessageId, timeoutMs: 120_000, label: info.name })
    }
    const outcome = result.ok ? 'ok' : (result.outcome === 'rejected' ? 'rejected' : 'unknown')
    state.counts[outcome] += 1
    state.mediaTurnSent += 1
    if (result.ok) {
      peerState(peer).times.push(now())
      globalTimes.push(now())
    }
    audit({
      kind: 'media', peerId: targetId, targetKind: kindTarget, mediaKind: info.kind, name: info.name,
      bytes: info.bytes, outcome, messageId: result.messageId ?? null, fileId: result.fileId ?? null,
      ms: result.ms ?? null, error: result.error ?? null,
    })
    const ms = now() - startedAt
    state.recent = {
      at: now(), peerId: targetId, targetKind: kindTarget, kind: 'media', mediaKind: info.kind,
      name: info.name, outcome, messageId: result.messageId ?? null, messageIds: result.messageId ? [result.messageId] : [],
      sent: result.ok ? 1 : 0, total: 1, ms, chars: 0, error: result.error ?? null,
    }
    if (result.ok) {
      if (args.albumId != null) {
        try { ctx.services?.get?.('album')?.markSent?.(Number(args.albumId), now()) } catch { /* 相册回写失败不影响已发送 */ }
      }
      return { text: `已发出去（${info.kind} ${info.name}，${info.bytes} 字节${result.messageId ? `，messageId=${result.messageId}` : ''}，${ms}ms）。`, outcome: 'ok', messageId: result.messageId ?? null }
    }
    const reason = result.error ?? '未知原因'
    const label = outcome === 'unknown' ? `结果未知（${reason}）` : reason
    return { text: `没发出去：${label}。媒体未发送（不自动重试）。`, outcome, error: reason }
  }

  ctx.tools.register({
    name: 'qq_send_media',
    summary: '发本地图片/视频/文件/语音到 QQ 私聊或 allowGroupSend 白名单群；图片可来自 albumId，文件只接受本地普通文件。',
    when: [
      '对方想看/需要一张本地图片、相册图片、视频、文件或语音',
      '你已经确认本地路径或相册 id，并知道该发给谁',
    ],
    avoid: [
      '未启用 allowMediaSend / allowGroupSend 时发群',
      '网络 URL 或不在本地的文件（只接受本地绝对路径/albumId）',
      '结果 unknown 时盲目重发（可能重复上传/发送）',
      '表情包（用 qq_send_sticker）',
      '把媒体当文本用 qq_send 发送（不会带附件）',
    ],
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        to: { type: 'string', description: '目标 QQ 号（私聊）或群号（allowGroups + allowGroupSend）。省略则用 owner / 唯一白名单私聊。' },
        path: { type: 'string', description: '本地文件路径（绝对路径优先）；与 albumId 二选一。' },
        albumId: { type: 'number', description: '相册图片/媒体的 id；与 path 二选一，发送前从 album 服务取路径。' },
        kind: { type: 'string', description: 'auto（默认，按扩展名）/ image / video / voice / file。' },
        replyToMessageId: { type: 'string', description: '引用回复的 messageId（必须在该私聊/群账本里，可选）。' },
      },
    },
    async execute(args) { return sendMedia(args) },
  })

  async function sendSticker(args = {}) {
    if (!keysNow()) return refuse('出站已关闭（kill switch 或三把钥匙未齐）')
    const targetInput = args.to == null || args.to === '' ? defaultTarget(cfg) : String(args.to).trim()
    if (!targetInput) return refuse('没有可发送的目标（owner/白名单/allowGroups 为空）')
    const target = resolveSendTarget(targetConfig(), targetInput)
    if (!target.ok) return refuse(target.error, { peerId: targetInput })
    const kind = target.kind === 'group' ? 'group' : 'private'
    const targetId = String(target.peer ?? target.groupId ?? targetInput)
    const peer = kind === 'group' ? `group:${targetId}` : targetId
    const albumMatch = /^#?(\d+)$/.exec(String(args.id ?? '').trim())
    if (albumMatch) {
      const row = albumStickerItems().find((item) => String(item.id) === albumMatch[1])
      if (row) return sendMedia({ to: targetInput, albumId: Number(row.id), kind: 'image' })
    }
    let sticker
    try { sticker = readSticker(args.id) } catch (error) { return refuse(String(error?.message ?? error), { peerId: targetId }) }
    const rateError = stickerRateError(peer)
    if (rateError) return refuse(rateError, { peerId: targetId })
    state.turnSent += 1
    const startedAt = now()
    const result = kind === 'group'
      ? await outbound.sendGroupImage(targetId, { data: sticker.buffer, mimeType: sticker.mimeType, name: sticker.id })
      : await outbound.sendPrivateImage(targetId, { data: sticker.buffer, mimeType: sticker.mimeType, name: sticker.id })
    const outcome = result.ok ? 'ok' : (result.outcome === 'rejected' ? 'rejected' : 'unknown')
    state.counts[outcome] += 1
    peerState(peer).times.push(now())
    audit({
      kind: 'sticker', peerId: targetId, targetKind: kind, sticker: sticker.id, bytes: sticker.bytes,
      outcome, messageId: result.messageId ?? null, ms: result.ms ?? null, error: result.error ?? null,
    })
    const ms = now() - startedAt
    state.recent = {
      at: now(), peerId: targetId, targetKind: kind, kind: 'sticker', sticker: sticker.id, outcome,
      messageId: result.messageId ?? null, messageIds: result.messageId ? [result.messageId] : [],
      sent: result.ok ? 1 : 0, total: 1, ms, chars: 0, error: result.error ?? null,
    }
    if (result.ok) {
      try {
        const library = loadLibrary()
        if (!library.error) saveStickerLibrary(stickerLibraryFile, recordStickerUse(library, sticker.id, { at: now(), context: `sent to ${peer}` }))
      } catch (error) {
        ctx.log({ level: 'warn', msg: 'qq.sticker.library-use', error: String(error?.message ?? error) })
      }
      return { text: `已发出去（表情 ${sticker.id}，messageId=${result.messageId}，${ms}ms）。`, outcome: 'ok', messageId: result.messageId ?? null }
    }
    const reason = result.error ?? '未知原因'
    const label = outcome === 'unknown' ? `结果未知（${reason}）` : reason
    return { text: `没发出去：${label}。表情未发送（不自动重试）。`, outcome, error: reason }
  }

  ctx.tools.register({
    name: 'qq_stickers',
    summary: '列出发送用表情：album 里带 sticker 标签的图片 + 旧本地 stickerDir；新收藏统一走 album_import。发送用 qq_send_sticker。',
    when: ['想挑一个表情发给对方', '按标签/描述查表情', '确认 album sticker / 本地表情库有哪些'],
    avoid: ['以为这里能收藏网络表情（用 album_import 导入本地图）', '把表情当普通图片路径发送（用 qq_send_sticker 或 albumId）'],
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        query: { type: 'string', description: '按文件名/标签/描述过滤（不填列全部）。' },
        sort: { type: 'string', description: '排序：name（默认）| recent（最近用过/改过）| used（使用次数）。' },
        limit: { type: 'number', description: '最多返回几个（默认 30，上限 100）。' },
      },
    },
    async execute({ query, sort, limit } = {}) {
      const cap = Math.max(1, Math.min(100, Number(limit) || 30))
      const library = loadLibrary()
      const legacy = stickerDir ? listStickers({ query, sort }).slice(0, cap) : []
      const album = albumStickerItems(query).slice(0, cap)
      if (!legacy.length && !album.length) {
        return { text: `没有可发的表情：album 里没有 sticker 标签，stickerDir ${stickerDir ? `也没有本地文件（${stickerDir}）` : '未配置'}。用 album_import 导入图片并加 tags:["sticker"]，或直接 qq_send_media。` }
      }
      const legacyLines = legacy.map((item) => {
        const meta = [
          item.description ? `描述：${item.description}` : null,
          item.tags?.length ? `标签：${item.tags.join('、')}` : null,
          `来源：${item.source}`, `用过 ${item.useCount} 次`,
        ].filter(Boolean).join('；')
        return `- ${item.id}（${(item.bytes / 1024).toFixed(1)}KB；${meta}）`
      })
      const albumLines = album.map((item) => {
        const tags = Array.isArray(item.tags) ? item.tags.join('、') : String(item.tags ?? '')
        return `- #${item.id}（album sticker；${item.bytes ?? '?'} 字节；${item.caption || '无备注'}${tags ? `；${tags}` : ''}）`
      })
      const sections = []
      if (albumLines.length) sections.push(`album sticker 标签（${albumLines.length} 个）：\n${albumLines.join('\n')}`)
      if (legacyLines.length) sections.push(`本地 stickerDir（${legacyLines.length} 个，来自 ${stickerDir}${library.error ? `；知识库读取失败：${library.error}（本次只读）` : ''}）：\n${legacyLines.join('\n')}`)
      return { text: `${sections.join('\n\n')}\n用 qq_send_sticker {id:"#albumId 或文件名"} 发送；album 表情用 album_note 补备注。` }
    },
  })

  ctx.tools.register({
    name: 'qq_sticker_note',
    summary: '给本地表情包补标签/描述/来源（只写本地 library.json；不下载、不上传、不改图片文件）。',
    when: ['你给某个本地表情想记一个含义/使用场景', '想按标签在 qq_stickers 里找到它'],
    avoid: ['给不存在的/库外文件写备注', '以为它会收藏网络表情（不会下载）'],
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'album sticker 的 #id，或旧本地表情文件名。' },
        tags: { type: 'array', items: { type: 'string' }, description: '短标签（最多 10 个，每个 ≤24 字）。' },
        description: { type: 'string', description: '一句话描述它表达什么/什么时候用（≤200 字）。' },
        source: { type: 'string', description: '来源标记：manual（默认）| inbound | ai | unknown。' },
      },
      required: ['id'],
    },
    async execute({ id, tags, description, source } = {}) {
      const safe = String(id ?? '').trim()
      const albumMatch = /^#?(\d+)$/.exec(safe)
      if (albumMatch) {
        try {
          const album = ctx.services?.get?.('album')
          const result = album?.note?.({ id: Number(albumMatch[1]), caption: description ?? null, tags: Array.isArray(tags) ? tags : null, source: source ?? null })
          if (result?.ok) return { text: `已更新 album #${albumMatch[1]} 的表情备注（caption/tags/source）。` }
          if (result?.error) return { text: result.error }
        } catch (error) { return { text: `更新 album 备注失败：${String(error?.message ?? error)}` } }
      }
      if (!stickerDir) return { text: 'album 里没有这个 #id，旧本地表情库也未配置（stickerDir 为空）。' }
      const exists = stickerFiles().some((file) => file.id === safe)
      if (!exists) return { text: `表情库里没有这个本地文件：${safe}（只接受 stickerDir 下的单层图片）。` }
      const library = loadLibrary()
      if (library.error) return { text: `表情知识库读取失败，拒绝写回以免覆盖：${library.error}` }
      try {
        const updated = noteSticker(library, safe, { tags, description, source }, { now: now() })
        saveStickerLibrary(stickerLibraryFile, updated)
        const entry = updated.entries[safe]
        return { text: `已记下表情 ${safe}：描述=${entry.description || '（空）'}；标签=${entry.tags.length ? entry.tags.join('、') : '（无）'}；来源=${entry.source}。只写本地 library.json。` }
      } catch (error) {
        return { text: `写表情知识库失败：${String(error?.message ?? error)}` }
      }
    },
  })

  ctx.tools.register({
    name: 'qq_send_sticker',
    summary: '发送一个表情：album 里带 sticker 标签的 #id，或旧本地 stickerDir 文件名；不下载远程。',
    when: ['对方语气适合用表情回应，且 qq_stickers 里有合适的', '你已经选好了 #albumId 或文件名'],
    avoid: ['未启用 allowGroupSend 时发群', '发网络图片/远程表情（先 album_import）', '结果 unknown 时重发'],
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'qq_stickers 列出的 #albumId 或旧本地文件名。' },
        to: { type: 'string', description: '目标 QQ 号（私聊）或群号（allowGroups + allowGroupSend）。省略则用 owner / 唯一白名单私聊。' },
      },
      required: ['id'],
    },
    async execute(args) { return sendSticker(args) },
  })

  async function poke(args = {}) {
    if (!keysNow()) return refuse('出站已关闭（kill switch 或三把钥匙未齐）')
    if (cfg.allowPoke !== true) return refuse('戳一戳未启用（allowPoke=false）')
    const input = args.to == null || args.to === '' ? defaultTarget(cfg) : String(args.to).trim()
    if (!input) return refuse('戳一戳需要目标 QQ 号或群号')
    const target = resolveSendTarget(targetConfig(), input)
    if (!target.ok) return refuse(target.error, { peerId: input })
    const kind = target.kind === 'group' ? 'group' : 'private'
    const targetId = String(target.peer ?? target.groupId ?? input)
    const userId = kind === 'group' ? String(args.userId ?? '').trim() : targetId
    if (kind === 'group' && !userId) return refuse('群戳一戳需要 userId（要戳的群成员）', { peerId: targetId })
    const result = await outbound.sendPoke({ userId, groupId: kind === 'group' ? targetId : null })
    const outcome = result.ok ? 'ok' : (result.outcome === 'rejected' ? 'rejected' : 'unknown')
    state.counts[outcome] += 1
    audit({ kind: 'poke', peerId: targetId, targetKind: kind, userId: userId || null, outcome, ms: result.ms ?? null, error: result.error ?? null })
    if (result.ok) return { text: `戳了戳 ${kind === 'group' ? `群 ${targetId} 的 ${userId}` : targetId}（${result.ms ?? 0}ms）。`, outcome: 'ok' }
    return { text: `没戳成：${result.error ?? '未知原因'}（不自动重试）。`, outcome, error: result.error ?? null }
  }

  async function recallMessage(args = {}) {
    if (!keysNow()) return refuse('出站已关闭（kill switch 或三把钥匙未齐）')
    if (cfg.allowRecall !== true) return refuse('撤回未启用（allowRecall=false）')
    const messageId = String(args.messageId ?? '').trim()
    if (!messageId) return refuse('撤回需要 messageId')
    if (args.to != null && String(args.to).trim() !== '') {
      const target = resolveSendTarget(targetConfig(), String(args.to).trim())
      if (!target.ok) return refuse(target.error, { peerId: String(args.to) })
    }
    const result = await outbound.recall(messageId)
    const outcome = result.ok ? 'ok' : (result.outcome === 'rejected' ? 'rejected' : 'unknown')
    state.counts[outcome] += 1
    audit({ kind: 'recall', messageId, outcome, ms: result.ms ?? null, error: result.error ?? null })
    if (result.ok) return { text: `已撤回消息 ${messageId}（${result.ms ?? 0}ms）。`, outcome: 'ok' }
    return { text: `没撤回：${result.error ?? '未知原因'}（不自动重试）。`, outcome, error: result.error ?? null }
  }

  async function groupAdmin(args = {}) {
    if (!keysNow()) return refuse('出站已关闭（kill switch 或三把钥匙未齐）')
    if (cfg.allowGroupAdmin !== true) return refuse('群管理未启用（allowGroupAdmin=false）')
    const target = checkGroupAdminTarget(targetConfig(), args.group)
    if (!target.ok) return refuse(target.error, { peerId: String(args.group ?? '') })
    const action = String(args.action ?? '').trim()
    if (!['ban', 'kick', 'card', 'whole-ban'].includes(action)) return refuse(`不支持的群管理动作：${action || '（空）'}`)
    if (action !== 'whole-ban' && (args.userId == null || String(args.userId).trim() === '')) return refuse(`${action} 需要 userId`)
    const result = await outbound.groupAdmin(action, {
      groupId: target.groupId,
      userId: args.userId,
      duration: args.duration,
      card: args.card,
      enable: args.enable,
    })
    const outcome = result.ok ? 'ok' : (result.outcome === 'rejected' ? 'rejected' : 'unknown')
    state.counts[outcome] += 1
    audit({ kind: 'group-admin', groupId: target.groupId, action, userId: args.userId ?? null, outcome, ms: result.ms ?? null, error: result.error ?? null })
    if (result.ok) return { text: `群管理已执行：${action}（群 ${target.groupId}${args.userId ? `，用户 ${args.userId}` : ''}，${result.ms ?? 0}ms）。`, outcome: 'ok' }
    return { text: `群管理失败：${result.error ?? '未知原因'}（不自动重试）。`, outcome, error: result.error ?? null }
  }

  ctx.tools.register({
    name: 'qq_poke',
    summary: '戳一戳（私聊或群成员）；和 qq_send 共用发送白名单。群戳需要群号 + userId。',
    when: ['想轻提醒对方一下', '对方戳了你，想戳回去'],
    avoid: ['没有明确对象/群成员时乱戳', '以为它等于发消息（它没有正文）'],
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        to: { type: 'string', description: 'QQ 号（私聊）或群号（群戳）' },
        userId: { type: 'string', description: '群戳时要戳的群成员 QQ 号；私聊时省略。' },
      },
      required: ['to'],
    },
    async execute(args) { return poke(args) },
  })

  ctx.tools.register({
    name: 'qq_recall',
    summary: '撤回一条已发出的 QQ 消息（需要 messageId；群/私聊都可用，受 allowRecall 控制）。',
    when: ['刚发错/发重复，需要撤回'],
    avoid: ['撤回别人的消息', '没有 messageId 时猜一个'],
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        messageId: { type: 'string', description: '要撤回的消息 messageId。' },
        to: { type: 'string', description: '可选：私聊 QQ 号或群号，用于校验目标白名单。' },
      },
      required: ['messageId'],
    },
    async execute(args) { return recallMessage(args) },
  })

  ctx.tools.register({
    name: 'qq_group_admin',
    summary: '群管理动作（默认关闭）：禁言/解禁、踢人、改群名片、全员禁言；需要 allowGroupAdmin=true。',
    when: ['明确需要执行群管理且已获授权'],
    avoid: ['日常聊天/普通群消息', '没有明确 userId/时长时操作', '未启用时尝试绕过'],
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        group: { type: 'string', description: '群号' },
        action: { type: 'string', description: 'ban | kick | card | whole-ban' },
        userId: { type: 'string', description: '目标成员 QQ 号（ban/kick/card 必填）' },
        duration: { type: 'number', description: 'ban 时长秒（默认 60）' },
        card: { type: 'string', description: 'card 的新群名片' },
        enable: { type: 'boolean', description: 'whole-ban：true 开启全员禁言，false 关闭' },
      },
      required: ['group', 'action'],
    },
    async execute(args) { return groupAdmin(args) },
  })

  const offTurnEnd = ctx.signals.on({ tags: ['turn-end'] }, () => { state.turnSent = 0; state.mediaTurnSent = 0 })

  ctx.log({ msg: 'qq.send.ready', owner: cfg.ownerQQ ?? null, allowPrivate: cfg.allowPrivate ?? [], perTurn: maxPerTurn, burst: { enabled: burstEnabled, max: burstMaxMessages, chars: maxMessageChars }, stickers: { dir: stickerDir || null, maxBytes: maxStickerBytes }, audit: cfg.auditFile || null })

  return {
    async execute(args) { return execute(args) },
    noteInbound,
    killSwitch,
    status() {
      const transport = outbound.status()
      return {
        registered: true,
        enabled: keysNow(),
        owner: cfg.ownerQQ ?? null,
        allowPrivate: [...(cfg.allowPrivate ?? [])],
        allowGroups: [...(cfg.allowGroups ?? [])],
        allowGroupSend: cfg.allowGroupSend === true,
        allowGroupAdmin: cfg.allowGroupAdmin === true,
        allowGroupAtAll: cfg.allowGroupAtAll === true,
        allowPoke: cfg.allowPoke === true,
        allowRecall: cfg.allowRecall === true,
        perTurn: { limit: maxPerTurn, sent: state.turnSent },
        limits: { minIntervalMs, maxPerMinute, maxPerHour, sameTextWindowMs, burstMaxMessages, maxMessageChars, gapMode, globalMaxPerMinute },
        outbox: { enabled: outboxEnabled, pending: outbox.length, maxPending: outboxMaxPending, ttlMs: outboxTtlMs, counts: { ...state.outboxCounts } },
        activePeers: [...activePeers],
        interruptedPeers: [...interruptedPeers],
        burst: { enabled: burstEnabled, maxMessages: burstMaxMessages, maxChars: maxMessageChars },
        stickers: { dir: stickerDir || null, libraryFile: stickerLibraryFile || null, maxBytes: maxStickerBytes, listLimit: stickerListLimit },
        counts: { ...state.counts },
        recent: state.recent ? { ...state.recent } : null,
        transport,
        auditFile: cfg.auditFile || null,
      }
    },
    dispose() {
      try { offTurnEnd() } catch { /* 已注销 */ }
      if (outboxTimer) { try { clearTimeout(outboxTimer) } catch { /* 已触发 */ } outboxTimer = null }
      outbox.length = 0
      try { outbound.stop() } catch (error) { log({ level: 'warn', msg: 'qq.send.stop', error: String(error?.message ?? error) }) }
    },
  }
}

export { hash, defaultTarget }
