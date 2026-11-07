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
  checkSendTarget,
  createOutbound,
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
    peers: new Map(), // peer -> { times: [], lastText: null, lastTextAt: 0 }
    recent: null,
    counts: { ok: 0, rejected: 0, unknown: 0, refused: 0 },
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
  const targetCfg = { ...cfg, enabled: true, allowSend: true, sendApproval: SEND_APPROVAL_TOKEN }
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

  /** 发送中收到新消息：只影响正在发送的 peer（finish-then-handle）。 */
  function noteInbound(peerId) {
    const peer = String(peerId ?? '').trim()
    if (!peer || !activePeers.has(peer)) return false
    interruptedPeers.add(peer)
    return true
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
  async function performSend({ peer, bubbles, key, replyToMessageId = null, args = {}, fingerprint = null, fromQueue = false }) {
    const ps = peerState(peer)
    const at = now()
    ps.lastText = key
    ps.lastTextAt = at
    let throughSeq = null
    try { throughSeq = typeof onSendStart === 'function' ? await onSendStart({ peerId: peer, replyToMessageId, at }) : null } catch { throughSeq = null }
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
        const result = await outbound.sendPrivate(peer, step.text, { replyToMessageId: i === 0 ? replyToMessageId : null })
        const outcome = result.ok ? 'ok' : (result.outcome === 'rejected' ? 'rejected' : 'unknown')
        state.counts[outcome] += 1
        audit({
          kind: 'send', peerId: peer, chars: step.text.length, textHash: hash(step.text),
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
    } finally {
      activePeers.delete(peer)
      interruptedPeers.delete(peer)
    }

    const ms = now() - startedAt
    const outcome = !failure && sent.length === plan.length ? 'ok' : (failure?.outcome ?? 'unknown')
    state.recent = {
      at: now(),
      peerId: peer,
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
          peerId: peer, replyToMessageId, sent: sent.length, total: plan.length,
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
    const peer = args.to == null || args.to === '' ? defaultTarget(cfg) : String(args.to).trim()
    if (!peer) return refuse('没有可发送的私聊目标（owner/白名单为空）')
    const target = checkSendTarget(targetCfg, peer)
    if (!target.ok) return refuse(target.error, { peerId: peer })
    const prepared = prepareBubbles(args)
    if (prepared.error) return refuse(prepared.error, { peerId: peer, ...(prepared.detail ?? {}) })
    const { bubbles, key } = prepared
    const replyToMessageId = args.replyToMessageId == null || String(args.replyToMessageId).trim() === ''
      ? null
      : String(args.replyToMessageId).trim()
    if (replyToMessageId != null) {
      if (bubbles.length > 1) return refuse('引用回复只支持单条气泡（把内容合并成一条，或去掉 replyToMessageId）', { peerId: peer, chars: key.length, hash: hash(key) })
      if (typeof validateReply === 'function') {
        let allowed = false
        try { allowed = validateReply({ peerId: peer, messageId: replyToMessageId }) } catch { allowed = false }
        if (!allowed) return refuse(`引用的消息不在这个私聊的账本里（id=${replyToMessageId}），不伪造引用`, { peerId: peer, chars: key.length, hash: hash(key) })
      }
    }
    const at = now()
    if (maxPerTurn > 0 && state.turnSent >= maxPerTurn) {
      return refuse(`本轮最多 ${maxPerTurn} 条（等下一轮再发）`, { peerId: peer, chars: key.length, hash: hash(key) })
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
      return refuse(`重复内容（${Math.round(sameTextWindowMs / 1000)} 秒内已发过同样的话）`, { peerId: peer, chars: key.length, hash: hash(key) })
    }

    const job = { peer, bubbles, key, replyToMessageId, args, fingerprint, fromQueue: false }
    const issue = rateIssue(peer, bubbles.length)
    state.turnSent += 1
    if (outboxEnabled && (issue || outbox.length)) {
      return enqueueOutbox(job, issue)
    }
    if (issue) return refuse(`限流：${issue}`, { peerId: peer, chars: key.length, hash: hash(key) })

    return performSend(job)
  }

  ctx.tools.register({
    name: 'qq_send',
    summary: '发 QQ 私聊（唯一 QQ 发送工具）：一段话或 1–8 条短气泡，只能 owner/白名单私聊，群不存在。限流时可能返回“已排队”，不要重复调用。',
    when: [
      '你刚看到一条 QQ 私聊、判断该回',
      '想把回复拆成几条短气泡，而不是一大段',
    ],
    avoid: [
      '群消息（群发送不存在）',
      '图片/语音/文件（这些能力不存在，别用文字假装；表情用 qq_send_sticker）',
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
        to: { type: 'string', description: '目标 QQ 号（只能私聊）。省略则用配置的 owner / 唯一白名单私聊。' },
        replyToMessageId: { type: 'string', description: '要引用的消息 messageId（必须是这个私聊账本里收到的消息；只能配单条 text，不能配 messages[]）。' },
        pace: { type: 'string', description: 'gapMode=typing 时的打字节奏：thoughtful | normal | quick | blast。' },
        gapMode: { type: 'string', description: '气泡间隔：auto（默认，1–3s，偶尔 5–10s）| fixed | typing | byLength。' },
        gapMs: { type: 'number', description: 'gapMode=fixed 时的固定间隔（毫秒）。' },
      },
    },
    async execute(args) { return execute(args) },
  })

  async function sendSticker(args = {}) {
    if (!keysNow()) return refuse('出站已关闭（kill switch 或三把钥匙未齐）')
    const peer = args.to == null || args.to === '' ? defaultTarget(cfg) : String(args.to).trim()
    if (!peer) return refuse('没有可发送的私聊目标（owner/白名单为空）')
    const target = checkSendTarget(targetCfg, peer)
    if (!target.ok) return refuse(target.error, { peerId: peer })
    let sticker
    try { sticker = readSticker(args.id) } catch (error) { return refuse(String(error?.message ?? error), { peerId: peer }) }
    const rateError = stickerRateError(peer)
    if (rateError) return refuse(rateError, { peerId: peer })
    state.turnSent += 1
    const startedAt = now()
    const result = await outbound.sendPrivateImage(peer, { data: sticker.buffer, mimeType: sticker.mimeType, name: sticker.id })
    const outcome = result.ok ? 'ok' : (result.outcome === 'rejected' ? 'rejected' : 'unknown')
    state.counts[outcome] += 1
    peerState(peer).times.push(now())
    audit({
      kind: 'sticker', peerId: peer, sticker: sticker.id, bytes: sticker.bytes,
      outcome, messageId: result.messageId ?? null, ms: result.ms ?? null, error: result.error ?? null,
    })
    const ms = now() - startedAt
    state.recent = {
      at: now(), peerId: peer, kind: 'sticker', sticker: sticker.id, outcome,
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
    summary: '列出本地 QQ 表情包库（只读）：本地文件 + 知识库标签/描述/来源/使用次数；不下载远程、不执行文件。发送用 qq_send_sticker，备注用 qq_sticker_note。',
    when: ['想挑一个本地表情发给对方', '按标签/描述查本地表情', '确认本地表情库里有哪些文件'],
    avoid: ['以为这里能收藏网络表情（只支持本地库）', '把表情当图片消息发送（用 qq_send_sticker）'],
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        query: { type: 'string', description: '按文件名/标签/描述过滤（不填列全部）。' },
        sort: { type: 'string', description: '排序：name（默认）| recent（最近用过/改过）| used（使用次数）。' },
        limit: { type: 'number', description: '最多返回几个（默认 30，上限 100）。' },
      },
    },
    async execute({ query, sort, limit } = {}) {
      if (!stickerDir) return { text: '表情包库未配置（stickerDir 为空）；把 png/jpeg/gif/webp 放进目录后再用。' }
      const library = loadLibrary()
      const list = listStickers({ query, sort }).slice(0, Math.max(1, Math.min(100, Number(limit) || 30)))
      if (!list.length) return { text: `表情包库是空的：${stickerDir}（只接受 png/jpeg/gif/webp 普通文件）。` }
      const lines = list.map((item) => {
        const meta = [
          item.description ? `描述：${item.description}` : null,
          item.tags?.length ? `标签：${item.tags.join('、')}` : null,
          `来源：${item.source}`, `用过 ${item.useCount} 次`,
        ].filter(Boolean).join('；')
        return `- ${item.id}（${(item.bytes / 1024).toFixed(1)}KB；${meta}）`
      })
      return {
        text: `本地表情包（${list.length} 个，来自 ${stickerDir}${library.error ? `；知识库读取失败：${library.error}（本次只读）` : ''}）：\n${lines.join('\n')}\n用 qq_send_sticker {id:"文件名"} 发送；qq_sticker_note 可补标签/描述。`,
      }
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
        id: { type: 'string', description: '表情文件名（单层，必须在 stickerDir 里存在）。' },
        tags: { type: 'array', items: { type: 'string' }, description: '短标签（最多 10 个，每个 ≤24 字）。' },
        description: { type: 'string', description: '一句话描述它表达什么/什么时候用（≤200 字）。' },
        source: { type: 'string', description: '来源标记：manual（默认）| inbound | ai | unknown。' },
      },
      required: ['id'],
    },
    async execute({ id, tags, description, source } = {}) {
      if (!stickerDir) return { text: '表情包库未配置（stickerDir 为空）。' }
      const safe = String(id ?? '').trim()
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
    summary: '把本地表情包库里的一个图片发给 QQ 私聊（owner/白名单，同 qq_send 的限速/审计）。只接受本地库文件，不下载远程。',
    when: ['对方语气适合用表情回应，且本地库里有合适的', '你已经用 qq_stickers 选好了 id'],
    avoid: ['群里发（群不存在）', '发送任意路径/网络图片（只接受 stickerDir 下的单层文件名）', '结果 unknown 时重发'],
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'qq_stickers 列出的文件名（单层，不能带路径）。' },
        to: { type: 'string', description: '目标 QQ 号（只能私聊）。省略则用 owner / 唯一白名单私聊。' },
      },
      required: ['id'],
    },
    async execute(args) { return sendSticker(args) },
  })

  const offTurnEnd = ctx.signals.on({ tags: ['turn-end'] }, () => { state.turnSent = 0 })

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
