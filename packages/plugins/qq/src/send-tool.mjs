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
  const minIntervalMs = num(cfg.sendMinIntervalMs, 5000)
  const maxPerMinute = num(cfg.sendMaxPerMinute, 10)
  const maxPerHour = num(cfg.sendMaxPerHour, 60)
  const sameTextWindowMs = num(cfg.sendSameTextWindowMs, 60_000)
  const burstEnabled = cfg.burstEnabled !== false
  const burstMaxMessages = Math.max(1, Math.floor(num(cfg.burstMaxMessages, BURST.maxMessages)))
  const maxMessageChars = Math.max(1, Math.floor(num(cfg.maxMessageChars, BURST.maxChars)))
  const gapMode = String(cfg.gapMode ?? 'auto')
  const targetCfg = { ...cfg, enabled: true, allowSend: true, sendApproval: SEND_APPROVAL_TOKEN }

  /** 把入参归一成"已清洗、已切好"的气泡列表；失败返回 { error, detail }。 */
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
    const at = now()
    if (maxPerTurn > 0 && state.turnSent >= maxPerTurn) {
      return refuse(`本轮最多 ${maxPerTurn} 条（等下一轮再发）`, { peerId: peer, chars: key.length, hash: hash(key) })
    }
    const ps = peerState(peer)
    ps.times = ps.times.filter((t) => at - t < 3600_000)
    const minute = ps.times.filter((t) => at - t < 60_000)
    if (ps.times.length && at - ps.times[ps.times.length - 1] < minIntervalMs) {
      return refuse(`限流：同一私聊至少 ${Math.round(minIntervalMs / 1000)} 秒一条`, { peerId: peer, chars: key.length, hash: hash(key) })
    }
    if (maxPerMinute > 0 && minute.length + bubbles.length > maxPerMinute) {
      return refuse(`限流：每分钟最多 ${maxPerMinute} 条（本次计划 ${bubbles.length} 条）`, { peerId: peer, chars: key.length, hash: hash(key) })
    }
    if (maxPerHour > 0 && ps.times.length + bubbles.length > maxPerHour) {
      return refuse(`限流：每小时最多 ${maxPerHour} 条（本次计划 ${bubbles.length} 条）`, { peerId: peer, chars: key.length, hash: hash(key) })
    }
    if (sameTextWindowMs > 0 && ps.lastText === key && at - ps.lastTextAt < sameTextWindowMs) {
      return refuse(`重复内容（${Math.round(sameTextWindowMs / 1000)} 秒内已发过同样的话）`, { peerId: peer, chars: key.length, hash: hash(key) })
    }

    // 真正开始：每轮只算一次调用；气泡逐条发，逐条守卫
    state.turnSent += 1
    ps.lastText = key
    ps.lastTextAt = at
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
    for (let i = 0; i < plan.length; i += 1) {
      const step = plan[i]
      if (i > 0) {
        if (!keysNow()) { failure = { outcome: 'refused', error: '出站已关闭（kill switch 或三把钥匙未齐）', index: i }; break }
        await sleepImpl(step.delayBeforeMs)
      }
      if (!keysNow()) { failure = { outcome: 'refused', error: '出站已关闭（kill switch 或三把钥匙未齐）', index: i }; break }
      const bubbleAt = now()
      ps.times.push(bubbleAt)
      const result = await outbound.sendPrivate(peer, step.text)
      const outcome = result.ok ? 'ok' : (result.outcome === 'rejected' ? 'rejected' : 'unknown')
      state.counts[outcome] += 1
      audit({
        kind: 'send', peerId: peer, chars: step.text.length, textHash: hash(step.text),
        outcome, messageId: result.messageId ?? null, ms: result.ms ?? null,
        batch: { index: i + 1, total: plan.length }, error: result.error ?? null,
      })
      if (!result.ok) { failure = { outcome, error: result.error, index: i }; break }
      sent.push({ messageId: result.messageId, chars: step.text.length, ms: result.ms })
    }

    const ms = now() - startedAt
    const outcome = !failure && sent.length === plan.length ? 'ok' : (failure?.outcome ?? 'unknown')
    state.recent = {
      at: now(),
      peerId: peer,
      outcome,
      messageId: sent[0]?.messageId ?? null,
      messageIds: sent.map((item) => item.messageId).filter(Boolean),
      sent: sent.length,
      total: plan.length,
      ms,
      chars: bubbles.reduce((sum, text) => sum + text.length, 0),
      error: failure?.error ?? null,
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

  ctx.tools.register({
    name: 'qq_send',
    summary: '发 QQ 私聊（唯一 QQ 发送工具）：一段话或 1–8 条短气泡，只能 owner/白名单私聊，群不存在。回复前先确认这是不是该回的那条（详见 qq_help 的 reply 策略）。',
    when: [
      '你刚看到一条 QQ 私聊、判断该回',
      '想把回复拆成几条短气泡，而不是一大段',
    ],
    avoid: [
      '群消息（群发送不存在）',
      '图片/语音/文件/表情/引用回复（这些能力不存在，别用文字假装）',
      '结果 unknown 时盲目重发（可能双发；用 qq_status 核对）',
      '对方只是发表情/图片且没问话时硬猜内容',
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
        pace: { type: 'string', description: 'gapMode=typing 时的打字节奏：thoughtful | normal | quick | blast。' },
        gapMode: { type: 'string', description: '气泡间隔：auto（默认，1–3s，偶尔 5–10s）| fixed | typing | byLength。' },
        gapMs: { type: 'number', description: 'gapMode=fixed 时的固定间隔（毫秒）。' },
      },
    },
    async execute(args) { return execute(args) },
  })

  const offTurnEnd = ctx.signals.on({ tags: ['turn-end'] }, () => { state.turnSent = 0 })

  ctx.log({ msg: 'qq.send.ready', owner: cfg.ownerQQ ?? null, allowPrivate: cfg.allowPrivate ?? [], perTurn: maxPerTurn, burst: { enabled: burstEnabled, max: burstMaxMessages, chars: maxMessageChars }, audit: cfg.auditFile || null })

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
        limits: { minIntervalMs, maxPerMinute, maxPerHour, sameTextWindowMs, burstMaxMessages, maxMessageChars, gapMode },
        burst: { enabled: burstEnabled, maxMessages: burstMaxMessages, maxChars: maxMessageChars },
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
