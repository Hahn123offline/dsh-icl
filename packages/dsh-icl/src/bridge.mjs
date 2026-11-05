// DSH 桥：把 ICL host 接到一个真实的 DSH 会话/agent 上。
//
// 只做五件事，全部走 DSH 官方 API，不碰 HTTP：
//   1. 工具面   host.surface → ctx.tools.register（带 output）
//   2. 提示词   host.prompt  → ctx.systemPrompt.section（text 函数）
//   3. 投递     host.delivery → agent.followup
//   4. 回合     session/event  → signals（turn-end）+ 原文层
//   5. 每轮上下文 agent/pre-step → prompt.turnText + context.assemble
//
// 本文件不 import @deepseek-ai/*；ctx/agent 由调用方注入，测试用假实现。

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { toDshToolDefinition, toDshPromptSection, toDshUserMessage } from '../../core/src/dsh-contract.mjs'

const RAW_ID = 'dsh-session'
const CTX_PREFIX = 'icl-ctx-'

function textOfMessage(message) {
  const content = message?.content
  if (!content) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (typeof part === 'string' ? part : part?.text || ''))
    .filter(Boolean)
    .join('\n')
}

function textOfEvent(event) {
  const data = event?.data ?? {}
  if (event?.type === 'tool/result') {
    return textOfMessage(data.message ?? data)
  }
  if (event?.type === 'user/message' || event?.type === 'assistant/message') {
    return textOfMessage(data.message ?? data)
  }
  return ''
}

function sameTool(prev, def) {
  return Boolean(prev)
    && prev.def?.execute === def.execute
    && prev.def?.description === def.description
    && JSON.stringify(prev.def?.parameters ?? {}) === JSON.stringify(def.parameters ?? {})
}

export function createDshBridge({ ctx, host, config = {}, log = () => {} }) {
  if (!ctx?.tools || typeof ctx.tools.register !== 'function') throw new Error('DSH 桥需要 ctx.tools.register')
  if (!host?.services) throw new Error('DSH 桥需要 ICL host')

  const state = {
    session: null,
    agent: null,
    releaseClaim: null,
    tools: new Map(),          // name -> { off, def }
    sectionOff: null,
    offSurface: null,
    offRaw: null,
    offHistory: null,
    offFocus: null,
    offFocusBacklog: null,
    timer: null,
    raw: [],
    rawSeen: new SeqSet(),
    injected: new Set(),
    stats: { delivered: 0, failed: 0, skipped: 0, rawRows: 0, contextInjected: 0, turnEnds: 0, steered: 0, followupFallback: 0 },
  }

  function report(where, error) {
    log({ msg: 'icl.bridge-error', where, error: String(error?.message ?? error) })
  }

  /* ── focus 持久化 ─────────────────────────────────────── */

  function loadFocus() {
    if (!config.focusFile) return
    try {
      const data = JSON.parse(fs.readFileSync(config.focusFile, 'utf8'))
      host.services.focus.restore(data)
      log({ msg: 'icl.focus-restored', leases: data?.leases?.length ?? 0, backlog: data?.backlog?.length ?? 0 })
    } catch (error) {
      if (error?.code !== 'ENOENT') report('focus.load', error)
    }
  }

  function saveFocus() {
    if (!config.focusFile) return
    try {
      const data = host.services.focus.snapshot()
      fs.mkdirSync(path.dirname(config.focusFile), { recursive: true })
      const tmp = `${config.focusFile}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8')
      fs.renameSync(tmp, config.focusFile)
    } catch (error) { report('focus.save', error) }
  }

  /* ── 工具面 ───────────────────────────────────────────── */

  function syncTools() {
    const want = new Map(host.services.surface.list().map((def) => [def.name, def]))
    const added = []
    const removed = []
    for (const [name, entry] of [...state.tools]) {
      if (want.has(name)) continue
      try { entry.off() } catch (error) { report(`tool.off:${name}`, error) }
      state.tools.delete(name)
      removed.push(name)
    }
    for (const [name, def] of want) {
      const prev = state.tools.get(name)
      if (sameTool(prev, def)) continue
      if (prev) {
        try { prev.off() } catch (error) { report(`tool.off:${name}`, error) }
        state.tools.delete(name)
      }
      try {
        const off = ctx.tools.register(toDshToolDefinition(def))
        state.tools.set(name, { off: typeof off === 'function' ? off : () => {}, def })
        added.push(name)
      } catch (error) {
        report(`tool.register:${name}`, error)
      }
    }
    if (added.length || removed.length) log({ msg: 'icl.tools', added, removed, total: state.tools.size })
    return { added, removed }
  }

  /* ── 提示词 ───────────────────────────────────────────── */

  function registerPrompt() {
    if (state.sectionOff) return
    const section = toDshPromptSection({
      host,
      sessionId: () => state.session?.id ?? null,
      name: 'icl:core',
      order: 30,
      onError: (error) => report('prompt.section', error),
    })
    try {
      const off = ctx.systemPrompt?.section?.(section)
      state.sectionOff = typeof off === 'function' ? off : null
      if (!state.sectionOff) report('prompt.section', new Error('ctx.systemPrompt.section 缺失'))
    } catch (error) { report('prompt.section', error) }
  }

  /* ── 原文层：实时 session 事件，不扫文件 ───────────────── */

  function loadRaw() {
    if (!config.rawFile) return
    try {
      const text = fs.readFileSync(config.rawFile, 'utf8')
      const rows = []
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        try { rows.push(JSON.parse(line)) } catch { /* 坏行跳过 */ }
      }
      state.raw = rows.slice(-20000)
      for (const row of state.raw) state.rawSeen.add(`${row.sessionId}:${row.seq}`)
      state.stats.rawRows = state.raw.length
    } catch { /* 第一次运行 */ }
  }

  function appendRaw(session, event) {
    const type = event?.type
    if (!['user/message', 'assistant/message', 'tool/result'].includes(type)) return
    // DSH 的 user/message 里混着 runtime-context / skill-catalog 等"系统快照"。
    // 只有 source.kind === 'user' 才是真的有人在说话；旧事件没有 source 时按 user 兼容。
    if (type === 'user/message') {
      const kind = String(event?.data?.source?.kind ?? 'user')
      if (kind !== 'user') return
    }
    const key = `${session?.id ?? ''}:${event?.seq ?? ''}`
    if (event?.seq != null && state.rawSeen.has(key)) return
    state.rawSeen.add(key)
    const role = type === 'assistant/message' ? 'assistant' : type === 'tool/result' ? 'tool' : 'user'
    const row = {
      sessionId: String(session?.id ?? ''),
      seq: Number.isFinite(Number(event?.seq)) ? Number(event.seq) : null,
      time: Number(event?.time) > 0 ? Number(event.time) : Date.now(),
      role,
      type,
      name: String(event?.data?.name ?? event?.data?.tool ?? ''),
      sender: role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : (String(event?.data?.name ?? event?.data?.tool ?? '') || 'tool'),
      text: textOfEvent(event),
    }
    if (!row.text.trim()) return
    // 我们注入的每轮上下文不是用户说的话：不进原文层，免得做梦把它当成人话
    if (row.type === 'user/message' && row.text.trimStart().startsWith('<icl-context>')) return
    state.raw.push(row)
    if (state.raw.length > 20000) state.raw = state.raw.slice(-20000)
    state.stats.rawRows = state.raw.length
    if (config.rawFile) {
      try {
        fs.mkdirSync(path.dirname(config.rawFile), { recursive: true })
        fs.appendFileSync(config.rawFile, JSON.stringify(row) + '\n', 'utf8')
      } catch (error) { report('raw.persist', error) }
    }
  }

  function resetRaw() {
    state.raw = []
    state.rawSeen.clear()
    state.stats.rawRows = 0
    if (config.rawFile) {
      try { fs.writeFileSync(config.rawFile, '', 'utf8') } catch { /* ignore */ }
    }
    return true
  }

  function rawList({ since = null, until = null, limit = 500 } = {}) {
    const max = Math.max(1, Number(limit) || 500)
    return state.raw
      .filter((row) => (since == null || row.time >= since) && (until == null || row.time <= until))
      .slice(-max)
  }

  function rawSearch({ query = '', limit = 2 } = {}) {
    const needle = String(query ?? '').trim().toLowerCase()
    if (!needle) return []
    const max = Math.max(1, Number(limit) || 2)
    const hits = []
    for (let i = state.raw.length - 1; i >= 0 && hits.length < max; i -= 1) {
      const row = state.raw[i]
      if (String(row.text ?? '').toLowerCase().includes(needle)) hits.push(row)
    }
    return hits.reverse()
  }

  function registerRaw() {
    if (state.offRaw) return
    try {
      state.offRaw = host.services.raw.register({ id: RAW_ID, list: rawList, search: rawSearch })
    } catch (error) { report('raw.register', error) }
  }

  /* ── 历史 ─────────────────────────────────────────────── */

  function sessionHistory({ limit = 50 } = {}) {
    const session = state.session
    if (!session || typeof session.deriveMessages !== 'function') return []
    try {
      const messages = session.deriveMessages()
      return messages
        .filter((message) => message?.role === 'user' || message?.role === 'assistant')
        .filter((message) => {
          if (message.role !== 'user') return true
          const kind = String(message.source?.kind ?? 'user')
          return kind === 'user'
        })
        .map((message) => ({ role: message.role, text: textOfMessage(message), id: String(message.id ?? '') }))
        .filter((row) => row.text.trim() && !row.id.startsWith(CTX_PREFIX) && !row.text.trimStart().startsWith('<icl-context>'))
        .map(({ role, text }) => ({ role, text }))
        .slice(-Math.max(1, Number(limit) || 50))
    } catch (error) {
      report('history.derive', error)
      return []
    }
  }

  function registerHistory() {
    if (state.offHistory) return
    try { state.offHistory = host.services.context.provideHistory(sessionHistory) } catch (error) { report('history.register', error) }
  }

  /* ── 投递：delivery → agent.followup ──────────────────── */

  function noticeMessage(batch, text) {
    const plugin = String(batch?.entries?.[0]?.source?.plugin ?? 'icl').replace(/[^a-z0-9:_-]/gi, '') || 'icl'
    const label = plugin === 'mc' ? 'MC' : plugin === 'time' ? '时间' : plugin === 'focus' ? '焦点' : plugin === 'qq' ? '外部消息' : plugin
    return toDshUserMessage(text, {
      id: `icl-notice-${batch.id}-${randomUUID()}`,
      source: {
        // DSH v4 规范：kind 必须是 producer-owned，裸 'plugin' 会被会话格式拒绝。
        kind: `plugin:${plugin}`,
        form: 'notice',
        summary: `${label}：${text.replace(/\s+/g, ' ').slice(0, 100)}`.slice(0, 120),
      },
    })
  }

  function tick() {
    if (!state.agent) return { sent: 0, skipped: 'no-agent' }
    let sent = 0
    for (const batch of host.services.delivery.drain('session')) {
      const text = String(batch.text ?? '').trim()
      if (!text) { host.services.delivery.ack(batch.id); continue }
      try {
        const message = noticeMessage(batch, text)
        if (typeof state.agent.steer === 'function') {
          // 插件来源的 notice：空闲起一轮、运行中在下一个 step 边界注入，不是伪造 user。
          state.agent.steer(message)
          state.stats.steered += 1
        } else {
          // 老宿主没有 steer 才退；仍然是 plugin source，不写死 user。
          state.agent.followup(message)
          state.stats.followupFallback += 1
        }
        host.services.delivery.ack(batch.id)
        state.stats.delivered += 1
        sent += 1
      } catch (error) {
        host.services.delivery.nack(batch.id, error?.message ?? error)
        state.stats.failed += 1
        report('delivery.steer', error)
        break
      }
    }
    return { sent }
  }

  function startTimer() {
    if (state.timer) return
    const interval = Math.max(50, Number(config.tickMs) || 500)
    state.timer = setInterval(() => { tick() }, interval)
    if (typeof state.timer.unref === 'function') state.timer.unref()
  }

  /* ── 会话 / agent ─────────────────────────────────────── */

  function bindSession(session) {
    if (!session?.id) return
    const id = String(session.id)
    if (state.session?.id === id) return
    if (state.releaseClaim) { try { state.releaseClaim() } catch { /* ignore */ } state.releaseClaim = null }
    state.session = session
    state.releaseClaim = host.claimSession ? host.claimSession(id) : null
    state.injected.clear()
    // 新会话从空投递队列开始；旧会话/旧 run 留在 host 队列里的消息不能先于第一轮漏进来。
    try { host.services.delivery.clear() } catch { /* ignore */ }
    log({ msg: 'icl.session', id })
  }

  function unbindSession(session = null) {
    if (session && state.session && String(session.id) !== String(state.session.id)) return
    if (state.releaseClaim) { try { state.releaseClaim() } catch { /* ignore */ } }
    state.releaseClaim = null
    state.session = null
    state.agent = null
    state.injected.clear()
    // 旧会话的待投递不能漏给下一条会话。
    try { host.services.delivery.clear() } catch { /* ignore */ }
  }

  function bindAgent(agent) {
    if (!agent) return
    if (!state.session && agent.session) bindSession(agent.session)
    if (!agent.session || String(agent.session.id) !== String(state.session?.id ?? '')) return
    state.agent = agent
    startTimer()
    log({ msg: 'icl.agent', id: agent.id ?? agent.session?.id ?? null })
  }

  /* ── 事件 ─────────────────────────────────────────────── */

  function onEvent(session, event) {
    if (!state.session || String(session?.id) !== String(state.session.id)) return
    appendRaw(session, event)
    const type = event?.type
    if (type !== 'turn/end' && type !== 'turn/start') return
    const seq = Number(event.seq)
    if (type === 'turn/start') {
      // 一轮开始：给 time 心跳一个精确的"最后一次模型活动开始"时间。
      // 只是插件总线信号（to:'plugin'），不进 prompt/历史，不影响缓存。
      try {
        host.services.signals.emit({
          id: `turn-start:${session.id}:${Number.isFinite(seq) ? seq : randomUUID()}`,
          from: { plugin: 'dsh' },
          kind: 'event',
          text: 'turn-start',
          tags: ['turn-start'],
          meta: { sessionId: String(session.id), seq: Number.isFinite(seq) ? seq : null },
        })
      } catch (error) { report('turn-start.emit', error) }
      return
    }
    state.stats.turnEnds += 1
    // 一轮结束：上一轮的用户消息 id 不再需要，避免长会话里集合无限增长
    state.injected.clear()
    try {
      host.services.signals.emit({
        id: `turn-end:${session.id}:${Number.isFinite(seq) ? seq : randomUUID()}`,
        from: { plugin: 'dsh' },
        kind: 'event',
        text: 'turn-end',
        tags: ['turn-end'],
        meta: { sessionId: String(session.id), seq: Number.isFinite(seq) ? seq : null },
      })
    } catch (error) { report('turn-end.emit', error) }
  }

  async function composeTurnContext(message) {
    const [turnText, contextText] = await Promise.all([
      host.services.prompt.turnText({ sessionId: state.session?.id ?? null, message }),
      host.services.context.assemble({ sessionId: state.session?.id ?? null, message }),
    ])
    return [turnText, contextText].filter(Boolean).join('\n\n')
  }

  function debug(event) {
    if (!process.env.ICL_BRIDGE_DEBUG) return
    try { fs.appendFileSync(process.env.ICL_BRIDGE_DEBUG, JSON.stringify({ at: Date.now(), ...event }) + '\n', 'utf8') } catch { /* ignore */ }
  }

  async function preStep(payload, next) {
    const decision = await next()
    debug({
      where: 'pre-step',
      kind: decision?.kind,
      hasAgent: Boolean(state.agent),
      messages: Array.isArray(decision?.messages) ? decision.messages.length : null,
      list: Array.isArray(decision?.messages)
        ? decision.messages.map((m) => ({ role: m?.role, id: String(m?.id ?? '').slice(0, 8), kind: m?.source?.kind ?? null, text: textOfMessage(m).slice(0, 30) }))
        : null,
    })
    if (!state.agent || !decision || decision.kind !== 'enter') return decision
    const messages = Array.isArray(decision.messages) ? decision.messages : []
    // 找这一批里最后一条"真正的用户消息"，且不是我们自己注入的
    let message = null
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const candidate = messages[i]
      if (!candidate || candidate.role !== 'user') continue
      if (String(candidate.id ?? '').startsWith(CTX_PREFIX)) continue
      // 只把真正的人话当成本轮 query；runtime-context / skill-catalog 不是
      if (candidate.source?.kind && candidate.source.kind !== 'user') continue
      message = candidate
      break
    }
    if (!message) return decision
    const id = String(message.id ?? '')
    if (id && state.injected.has(id)) return decision
    const text = textOfMessage(message).trim()
    if (!text) return decision
    if (id) state.injected.add(id)
    let extra = ''
    try { extra = await composeTurnContext(text) } catch (error) {
      debug({ where: 'pre-step.error', error: String(error?.message ?? error) })
      report('pre-step.context', error)
      return decision
    }
    debug({ where: 'pre-step.extra', chars: extra.length, query: text.slice(0, 30) })
    debug({ where: 'pre-step.extra', chars: extra.length, query: text.slice(0, 30) })
    if (!extra.trim()) return decision
    debug({ where: 'pre-step.context', chars: extra.length })
    state.stats.contextInjected += 1
    const injected = toDshUserMessage(`<icl-context>\n${extra}\n</icl-context>`, {
      id: `${CTX_PREFIX}${randomUUID()}`,
      // 用 DSH 已知的 runtime-context 来源：GUI 当成上下文快照，不会显示成用户发言；
      // 原文/历史层按 kind 过滤，也不会把它记成人话。
      source: {
        kind: 'runtime-context',
        form: 'snapshot',
        sections: [{ name: 'icl:context', text: extra }],
      },
    })
    return { ...decision, messages: [...messages, injected] }
  }

  /* ── 生命周期 ─────────────────────────────────────────── */

  function start() {
    loadRaw()
    loadFocus()
    registerPrompt()
    registerRaw()
    registerHistory()
    syncTools()
    try { state.offSurface = host.services.surface.onChange(() => { syncTools() }) } catch (error) { report('surface.subscribe', error) }
    try { state.offFocus = host.services.focus.onChange(() => { saveFocus() }) } catch (error) { report('focus.subscribe', error) }
    try { state.offFocusBacklog = host.services.focus.onBacklog(() => { saveFocus() }) } catch (error) { report('focus.backlog-subscribe', error) }
    startTimer()
    return { tools: state.tools.size }
  }

  function status() {
    return {
      sessionId: state.session?.id ?? null,
      agentId: state.agent?.id ?? state.agent?.session?.id ?? null,
      tools: [...state.tools.keys()],
      pending: host.services.delivery.pendingCount(),
      inflight: host.services.delivery.inflightCount(),
      raw: state.raw.length,
      signals: host.services.signals.stats(),
      stats: { ...state.stats },
    }
  }

  function dispose() {
    if (state.timer) { clearInterval(state.timer); state.timer = null }
    try { state.offSurface?.() } catch { /* ignore */ }
    try { state.sectionOff?.() } catch { /* ignore */ }
    try { state.offRaw?.() } catch { /* ignore */ }
    try { state.offHistory?.() } catch { /* ignore */ }
    saveFocus()
    try { state.offFocus?.() } catch { /* ignore */ }
    try { state.offFocusBacklog?.() } catch { /* ignore */ }
    for (const entry of state.tools.values()) { try { entry.off() } catch { /* ignore */ } }
    state.tools.clear()
    unbindSession()
  }

  return {
    start, dispose, status,
    syncTools,
    bindSession, unbindSession, bindAgent,
    onEvent, preStep, tick,
    history: sessionHistory,
    get session() { return state.session },
    get agent() { return state.agent },
  }
}

/** 有界 key 集合：原文去重，不引第三方。 */
class SeqSet {
  constructor(limit = 50000) { this.limit = limit; this.set = new Set() }
  has(key) { return this.set.has(key) }
  add(key) {
    this.set.add(key)
    if (this.set.size > this.limit) {
      const drop = this.set.size - this.limit
      let i = 0
      for (const item of this.set) { this.set.delete(item); if (++i >= drop) break }
    }
  }
}
