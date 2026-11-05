// qq_send：phase 1「只回私聊」的唯一发放口。
//
// 这个文件被 index.mjs **动态** import（只在三把钥匙打开时）；它才 import 发送实现（outbound.mjs）。
// 于是：默认/影子模式下 index 里没有发送实现，也没有 qq_send 工具；打开时也只有一个工具、一条路径。
//
// 策略全部在这里做（传输层只负责发与三态回执）：
//   · 目标：只私聊、只 owner/白名单；群永远拒绝
//   · 内容：非空、不超长、敏感信息拦截
//   · 限速：同 peer 最小间隔、每分钟上限、同文窗口去重、每轮最多 N 条（turn-end 重置）
//   · 失败不冒充成功：三态文本明确写"没发出去：原因"；unknown 不自动重试
//   · 审计：JSONL 只存 hash/长度/结果，不存正文全文
//   · kill switch：每次调用都重读 live config 的 allowSend/enabled/sendApproval
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

function hash(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 16)
}

function defaultTarget(cfg = {}) {
  if (cfg.ownerQQ != null && String(cfg.ownerQQ).trim()) return String(cfg.ownerQQ).trim()
  const allow = Array.isArray(cfg.allowPrivate) ? cfg.allowPrivate.map(String) : []
  return allow.length === 1 ? allow[0] : null
}

export async function registerSendTool({
  ctx,
  cfg = {},
  liveConfig = {},
  endpoint = null,
  log = () => {},
  now = () => Date.now(),
  outboundFactory = createOutbound,
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
  /** kill switch：每次都重读 live config（运行中改 allowSend 立即生效）。 */
  function keysNow() {
    return sendEnabled({ enabled: live.enabled, allowSend: live.allowSend, sendApproval: live.sendApproval })
  }
  // 仅供测试/运维：把 live config 显式关掉（不写文件，只改内存对象）
  function killSwitch(reason = 'manual') {
    live.allowSend = false
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

  const maxPerTurn = Number.isFinite(Number(cfg.maxSendsPerTurn)) ? Math.max(0, Math.floor(Number(cfg.maxSendsPerTurn))) : 1
  const minIntervalMs = Number(cfg.sendMinIntervalMs) >= 0 ? Number(cfg.sendMinIntervalMs) : 5000
  const maxPerMinute = Number(cfg.sendMaxPerMinute) >= 0 ? Number(cfg.sendMaxPerMinute) : 10
  const sameTextWindowMs = Number(cfg.sendSameTextWindowMs) >= 0 ? Number(cfg.sendSameTextWindowMs) : 60_000
  const targetCfg = { ...cfg, enabled: true, allowSend: true, sendApproval: SEND_APPROVAL_TOKEN }

  async function execute(args = {}) {
    if (!keysNow()) return refuse('出站已关闭（kill switch 或三把钥匙未齐）')
    const peer = args.to == null || args.to === '' ? defaultTarget(cfg) : String(args.to).trim()
    if (!peer) return refuse('没有可发送的私聊目标（owner/白名单为空）')
    const target = checkSendTarget(targetCfg, peer)
    if (!target.ok) return refuse(target.error, { peerId: peer })
    const content = checkSendContent(cfg, args.text)
    if (!content.ok) {
      const raw = String(args.text ?? '')
      return refuse(content.error, { peerId: peer, chars: raw.length, hash: hash(raw) })
    }
    const at = now()
    if (maxPerTurn > 0 && state.turnSent >= maxPerTurn) {
      return refuse(`本轮最多 ${maxPerTurn} 条（等下一轮再发）`, { peerId: peer, chars: content.text.length, hash: hash(content.text) })
    }
    const ps = peerState(peer)
    ps.times = ps.times.filter((t) => at - t < 60_000)
    if (ps.times.length && at - ps.times[ps.times.length - 1] < minIntervalMs) {
      return refuse(`限流：同一私聊至少 ${Math.round(minIntervalMs / 1000)} 秒一条`, { peerId: peer, chars: content.text.length, hash: hash(content.text) })
    }
    if (maxPerMinute > 0 && ps.times.length >= maxPerMinute) {
      return refuse(`限流：每分钟最多 ${maxPerMinute} 条`, { peerId: peer, chars: content.text.length, hash: hash(content.text) })
    }
    if (sameTextWindowMs > 0 && ps.lastText === content.text && at - ps.lastTextAt < sameTextWindowMs) {
      return refuse(`重复内容（${Math.round(sameTextWindowMs / 1000)} 秒内已发过同样的话）`, { peerId: peer, chars: content.text.length, hash: hash(content.text) })
    }

    // 真正走传输：先记账（attempt），结果回填
    state.turnSent += 1
    ps.times.push(at)
    ps.lastText = content.text
    ps.lastTextAt = at
    const result = await outbound.sendPrivate(peer, content.text)
    const outcome = result.ok ? 'ok' : (result.outcome === 'rejected' ? 'rejected' : 'unknown')
    state.counts[outcome] += 1
    state.recent = {
      at: now(),
      peerId: peer,
      outcome,
      messageId: result.messageId ?? null,
      ms: result.ms ?? null,
      chars: content.text.length,
      error: result.error ?? null,
    }
    audit({
      kind: 'send', peerId: peer, chars: content.text.length, textHash: hash(content.text),
      outcome, messageId: result.messageId ?? null, ms: result.ms ?? null, error: result.error ?? null,
    })
    if (outcome === 'ok') return { text: `已发出去（messageId=${result.messageId}，${result.ms}ms）。`, outcome: 'ok', messageId: result.messageId }
    if (outcome === 'rejected') return { text: `没发出去：后端拒绝（${result.error}）。`, outcome: 'rejected', error: result.error }
    return { text: `没发出去：结果未知（${result.error}）。可能已送达也可能没有；不会自动重试。`, outcome: 'unknown', error: result.error }
  }

  ctx.tools.register({
    name: 'qq_send',
    summary: 'Reply with one short text message to a QQ private chat. Only the owner/allowlisted private chat is allowed; groups are never allowed. If the result is unknown, do not resend blindly.',
    when: ['you want to answer a private QQ message you just read'],
    avoid: ['groups', 'images/voice/files', 'broadcast to multiple people', 'sending the same text twice'],
    parameters: {
      type: 'object', additionalProperties: false, required: ['text'],
      properties: {
        text: { type: 'string', description: 'Plain text, one short message. Empty/too long/sensitive content is refused.' },
        to: { type: 'string', description: 'Target QQ number (private only). Omit to use the configured owner / single allowlisted peer.' },
      },
    },
    async execute(args) { return execute(args) },
  })

  const offTurnEnd = ctx.signals.on({ tags: ['turn-end'] }, () => { state.turnSent = 0 })

  ctx.log({ msg: 'qq.send.ready', owner: cfg.ownerQQ ?? null, allowPrivate: cfg.allowPrivate ?? [], perTurn: maxPerTurn, audit: cfg.auditFile || null })

  return {
    async execute(args) { return execute(args) },
    killSwitch,
    status() {
      const transport = outbound.status()
      return {
        registered: true,
        enabled: keysNow(),
        owner: cfg.ownerQQ ?? null,
        allowPrivate: [...(cfg.allowPrivate ?? [])],
        perTurn: { limit: maxPerTurn, sent: state.turnSent },
        limits: { minIntervalMs, maxPerMinute, sameTextWindowMs },
        counts: { ...state.counts },
        recent: state.recent ? { ...state.recent } : null,
        transport,
        auditFile: cfg.auditFile || null,
      }
    },
    dispose() {
      try { offTurnEnd() } catch { /* 已注销 */ }
      try { outbound.stop() } catch (error) { log({ level: 'warn', msg: 'qq.send.stop', error: String(error?.message ?? error) }) }
    },
  }
}

export { hash, defaultTarget }
