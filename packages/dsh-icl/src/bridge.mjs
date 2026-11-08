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
import { TEXT_OUTPUT_SCHEMA, toDshToolDefinition, toDshPromptSection, toDshUserMessage } from '../../core/src/dsh-contract.mjs'
import { matchToolAllowlist } from './config.mjs'

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

/** 图片扩展名 → attachment 接受的 mediaType（只认 DSH 支持的四类）。 */
function imageMediaType(file) {
  const ext = path.extname(String(file ?? '')).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  return null
}

/**
 * 拿宿主附件服务（可选）。没有它时工具结果退回"路径文本"，绝不假装图已在上下文里。
 * 不用 `inject` 强制依赖：headless/测试环境未必装了 attachment-local。
 * 注意：DSH Cordis 不允许未 inject 就读取 ctx.attachments（会抛 "cannot get property without inject"），
 * 因此所有 attachment 访问都必须走 `ctx.inject(['attachments'], …)` 后缓存的服务。
 */

/** 把本地图片文件提交成 attachment 引用；失败交给上层退回文本。 */
function makeSaveImage(attachments) {
  if (!attachments) return null
  return async (file) => {
    const mediaType = imageMediaType(file)
    if (!mediaType) throw new Error(`不支持的图片扩展名：${path.extname(file) || '(无)'}`)
    const data = fs.readFileSync(file)
    return attachments.saveImage({ data, mediaType, name: path.basename(file) })
  }
}

export function createDshBridge({ ctx, host, config = {}, log = () => {} }) {
  if (!ctx?.tools || typeof ctx.tools.register !== 'function') throw new Error('DSH 桥需要 ctx.tools.register')
  if (!host?.services) throw new Error('DSH 桥需要 ICL host')
  // 诊断：图片通道问题（attachment 服务是否可用/注册是否回退）写一条 JSONL，方便 lab 里取证。
  const diagFile = config.stateDir ? path.join(String(config.stateDir), 'icl-diag.jsonl') : null
  const diag = (event) => {
    if (!diagFile) return
    try {
      fs.mkdirSync(path.dirname(diagFile), { recursive: true })
      fs.appendFileSync(diagFile, `${JSON.stringify({ at: Date.now(), ...event })}\n`, 'utf8')
    } catch { /* 诊断失败不影响主流程 */ }
  }
  const saveImage = async (file) => {
    const store = attachmentsService()
    if (!store) throw new Error('当前会话没有 attachment 服务')
    const mediaType = imageMediaType(file)
    if (!mediaType) throw new Error(`不支持的图片扩展名：${path.extname(file) || '(无)'}`)
    const data = fs.readFileSync(file)
    return store.saveImage({ data, mediaType, name: path.basename(file) })
  }
  diag({ event: 'bridge.init', inject: typeof ctx?.inject === 'function' })

  const state = {
    session: null,
    agent: null,
    apiProxy: null,
    releaseClaim: null,
    tools: new Map(),          // name -> { off, def }
    // 兼容旧 DSH：0.2.0-rc.2 不接受 image output schema，会抛错并丢掉全部工具。
    // 一旦注册失败就整体切 text-only（图片以路径文本返回），并只告警一次。
    outputFallback: false,
    sectionOff: null,
    factsOff: null,
    offSurface: null,
    offRaw: null,
    offHistory: null,
    offFocus: null,
    offFocusBacklog: null,
    offFactsDirty: null,
    timer: null,
    raw: [],
    rawSeen: new SeqSet(),
    injected: new Set(),
    // facts 快照节流：同一 turn 内各 step 复用第一份事实文本，最多 1 条快照/轮。
    // 依据：DSH 的 runtime-context 快照只 append 不 replace，step-heavy 回合（MC 可到 39 步）
    // 会按步数线性累积（见 docs/CACHE-MODEL.md §7.7）。
    turn: null,
    factsCache: { turn: null, text: null },
    factsDirty: false,
    attachments: null,
    attachmentsInjected: false,
    ticking: false,
    // 通用重复动作保护：记录同一 session 最近一次工具调用签名与连续次数。
    // 触发条件：连续 N 次（默认 3）完全相同（name + 规范化 args）→ 通过 delivery 注入一条提示；
    // 同一 session 60s 内不重复提示（节流）。不写 system/facts，只是 append-only notice。
    repeat: { sig: null, count: 0, lastNoticeAt: 0 },
    // renderTail（C，lab-only）：当前 turn 内已追加的 tail 计数/上次文本；turn 切换时重置。
    renderTail: { turn: null, lastText: null, count: 0, chars: 0 },
    stats: { delivered: 0, failed: 0, skipped: 0, rawRows: 0, contextInjected: 0, turnEnds: 0, steered: 0, followupFallback: 0, factsInContext: false, factsRefreshes: 0, repeatGuards: 0, renderTailAppended: 0, renderTailChars: 0, renderTailSkipped: 0 },
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

  /* ── 工具结果尾部状态行（renderTail，C，lab-only） ───────── */

  // 默认关；lab preset 可开。ICL_RENDERTAIL=1/0 用于 A/B 覆盖（不改 preset）。
  const tailRaw = config.renderTail && typeof config.renderTail === 'object' ? config.renderTail : {}
  const tailEnv = process.env.ICL_RENDERTAIL
  const tailEnabled = tailEnv == null ? tailRaw.enabled === true : tailEnv === '1'
  const DEFAULT_TAIL_DENY = [
    'time_status', 'time_list', 'mcb_status', 'mcb_inventory', 'mcb_map', 'mcb_scan', 'mcb_help',
    'album_list', 'album_search', 'album_status', 'album_show',
    'world_status', 'focus_status', 'note_status', 'memos', 'memory_export', 'recall',
    'qq_unread', 'qq_history', 'todo_write',
  ]
  const tailCfg = {
    enabled: tailEnabled,
    maxPerTurn: Math.max(0, Number(tailRaw.maxPerTurn ?? 6)),
    maxCharsPerTurn: Math.max(0, Number(tailRaw.maxCharsPerTurn ?? 360)),
    maxResultChars: Math.max(200, Number(tailRaw.maxResultChars ?? 2000)),
    tools: Array.isArray(tailRaw.tools) ? tailRaw.tools.map(String) : [],
    deny: Array.isArray(tailRaw.deny) ? tailRaw.deny.map(String) : DEFAULT_TAIL_DENY,
    includeErrors: tailRaw.includeErrors === true,
  }

  function tailToolAllowed(name) {
    if (tailCfg.tools.length) return tailCfg.tools.includes(name)
    return !tailCfg.deny.includes(name)
  }

  function twoDigit(value) { return String(value).padStart(2, '0') }

  /** 30–45 字符状态行：时间/phase · 焦点 · 目标 · 积压 · MC；字段缺失就省略。 */
  function buildRenderTail() {
    const parts = []
    try {
      const timeApi = host.shared.get('time') ?? null
      const status = typeof timeApi?.status === 'function' ? timeApi.status() : null
      const at = Number(timeApi?.now?.()) || Date.now()
      const date = new Date(at)
      if (Number.isFinite(date.getTime())) parts.push(`${twoDigit(date.getHours())}:${twoDigit(date.getMinutes())}`)
      const phase = String(status?.phase ?? '')
      if (phase) parts.push(phase === 'awake' ? '醒着' : phase === 'sleeping' ? '睡' : phase === 'paused' ? '暂停' : phase)
      // 下一安排：让 tail 能替代频繁 time_list/time_status。
      // time 的 schedule.at 可能是 ISO 字符串（一次性）或 "HH:MM"（daily/weekly）；silent 的（如 dream:nightly）不算。
      const schedules = Array.isArray(status?.schedules) ? status.schedules.filter((row) => row?.silent !== true) : []
      const scheduleEpoch = (row) => {
        const raw = row?.at
        const numeric = Number(raw)
        if (Number.isFinite(numeric) && numeric > 0) return numeric
        if (typeof raw === 'string' && raw.includes('T')) {
          const parsed = Date.parse(raw)
          return Number.isFinite(parsed) ? parsed : null
        }
        if (typeof raw === 'string') {
          const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim())
          if (match) {
            const date = new Date(at)
            date.setHours(Number(match[1]), Number(match[2]), 0, 0)
            if (date.getTime() <= at) date.setDate(date.getDate() + 1)
            return date.getTime()
          }
        }
        return null
      }
      const nextAt = schedules.map(scheduleEpoch).filter((when) => Number.isFinite(when) && when > at).sort((x, y) => x - y)[0]
      if (Number.isFinite(nextAt)) { const nextDate = new Date(nextAt); if (Number.isFinite(nextDate.getTime())) parts.push(`下一${twoDigit(nextDate.getHours())}:${twoDigit(nextDate.getMinutes())}`) }
      let focus = null
      try { focus = host.services.focus.current() } catch { focus = null }
      if (focus) {
        const label = String(focus.label ?? focus.id ?? '').trim().slice(0, 18)
        if (label) parts.push(`焦点${label}`)
      }
      const goals = Array.isArray(status?.goals) ? status.goals : []
      if (goals.length) {
        const first = String(goals[0]?.id ?? goals[0]?.theme ?? '').trim().slice(0, 18)
        if (first) parts.push(`目标${first}${goals.length > 1 ? `+${goals.length - 1}` : ''}`)
      }
      const backlog = Number(status?.backlog ?? 0)
      if (backlog > 0) parts.push(`积压${backlog}`)
      const mc = host.shared.get('mc-link') ?? null
      const body = typeof mc?.status === 'function' ? mc.status() : null
      if (body) {
        const connected = body.connected !== false && body.alive !== false && body.online !== false
        if (!connected) parts.push('MC离线')
        else {
          const hp = body.health ?? body.hp ?? body.status?.health ?? null
          const food = body.food ?? body.satiety ?? body.status?.food ?? null
          const paused = body.paused ? '暂停' : ''
          if (hp != null || food != null || paused) parts.push(`MC${paused}${hp != null ? `${Math.round(Number(hp))}` : '?'}/${food != null ? `饱${Math.round(Number(food))}` : '?'}`)
        }
      }
    } catch { /* tail 不能影响工具结果 */ }
    if (!parts.length) return ''
    return `〔状态｜${parts.join(' · ')}〕`
  }

  /** 只 append 到 tool result 文本；错误/图片/超长/重复/超限都跳过。 */
  function appendRenderTail(name, out) {
    if (!tailCfg.enabled) return out
    if (!out || typeof out !== 'object') return out
    if (!tailToolAllowed(name)) return out
    if (Array.isArray(out.images) && out.images.length) { state.stats.renderTailSkipped += 1; return out }
    if (typeof out.imagePath === 'string' && out.imagePath) { state.stats.renderTailSkipped += 1; return out }
    if (out.ok === false) { state.stats.renderTailSkipped += 1; return out }
    const text = typeof out.text === 'string' ? out.text : String(out.text ?? '')
    if (!tailCfg.includeErrors && /^(Error:|失败[:：]|失败\(|无法|请先)/.test(text)) { state.stats.renderTailSkipped += 1; return out }
    if (text.length > tailCfg.maxResultChars) { state.stats.renderTailSkipped += 1; return out }
    if (text.includes('〔状态｜')) { state.stats.renderTailSkipped += 1; return out }
    if (state.renderTail.count >= tailCfg.maxPerTurn) { state.stats.renderTailSkipped += 1; return out }
    const line = buildRenderTail()
    if (!line) return out
    if (line === state.renderTail.lastText) { state.stats.renderTailSkipped += 1; return out }
    if (state.renderTail.chars + line.length > tailCfg.maxCharsPerTurn) { state.stats.renderTailSkipped += 1; return out }
    state.renderTail.lastText = line
    state.renderTail.count += 1
    state.renderTail.chars += line.length
    state.stats.renderTailAppended += 1
    state.stats.renderTailChars += line.length
    return { ...out, text: text ? `${text}\n${line}` : line }
  }

  /* ── 工具面 ───────────────────────────────────────────── */

  function syncTools() {
    const want = new Map(host.services.surface.list().map((def) => [def.name, def]))
    // MC 场景工具白名单（preset 配置）：只注册名单内的 ICL 工具；空数组=全量（产品默认）。
    if (Array.isArray(config.toolAllowlist) && config.toolAllowlist.length) {
      for (const name of [...want.keys()]) if (!matchToolAllowlist(name, config.toolAllowlist)) want.delete(name)
    }
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
      const build = (imageOutput) => toDshToolDefinition(def, {
        saveImage,
        imageOutput,
        // C renderTail：统一在 normalize 前给 tool result 文本 append 状态行。
        execute: async (args, exec) => appendRenderTail(def.name, await def.execute(args, exec)),
      })
      try {
        const off = ctx.tools.register(build(!state.outputFallback))
        state.tools.set(name, { off: typeof off === 'function' ? off : () => {}, def })
        added.push(name)
        if (!state.diagImageOk) { state.diagImageOk = true; diag({ event: 'tool.register.image-ok', name, imageOutput: !state.outputFallback }) }
      } catch (error) {
        diag({ event: 'tool.register.failed', name, imageOutput: !state.outputFallback, error: String(error?.message ?? error) })
        // 兼容回退：老宿主（DSH 0.2.0-rc.2）只认 text-only output schema。
        // 先整体切 text-only 重试一次；成功则后续工具直接走 text-only，并留一条可查的告警。
        if (!state.outputFallback) {
          state.outputFallback = true
          log({
            msg: 'icl.tool-output-fallback',
            level: 'warn',
            reason: String(error?.message ?? error),
            note: 'DSH 不接受 image output schema：全部工具改用 text-only output（图片仍以路径文本返回，不会假装已进上下文）',
          })
          try {
            const off = ctx.tools.register(build(false))
            state.tools.set(name, { off: typeof off === 'function' ? off : () => {}, def })
            added.push(name)
            continue
          } catch (retryError) {
            report(`tool.register:${name}:text-only-retry`, retryError)
            continue
          }
        }
        report(`tool.register:${name}`, error)
      }
    }
    if (added.length || removed.length) log({ msg: 'icl.tools', added, removed, total: state.tools.size })
    return { added, removed }
  }

  /* ── 提示词 ───────────────────────────────────────────── */

  // 静态段上界：ICL 内部 order < 800 的段（人格 20、仿真 25）是全场稳定的，进系统提示词；
  // order ≥ 800 的易变事实段（时间/世界 890、focus 875、mc:status 900…）每轮都可能变，
  // 一走系统提示词就等于让本地引擎整条前缀缓存作废（见 docs/CACHE-MODEL.md）。
  const FACTS_MIN_ORDER = 800

  function registerPrompt() {
    if (state.sectionOff) return
    // DSH 的 systemPrompt.context() 是"每步可变的当前上下文"官方通道：内容变化时
    // 它追加一条 runtime-context 消息（只追加、不替换），并自带
    // "This snapshot supersedes earlier runtime-context snapshots." 的语义。
    // 老宿主/假 ctx 没有这个 API 时退回旧的"单 section 全量"行为。
    const canUseContext = typeof ctx.systemPrompt?.context === 'function'
      && config.factsInRuntimeContext !== false
      && process.env.ICL_FACTS_IN_SYSTEM !== '1'
    const registerSection = (range) => {
      const section = toDshPromptSection({
        host,
        sessionId: () => state.session?.id ?? null,
        name: 'icl:core',
        order: 30,
        range,
        onError: (error) => report('prompt.section', error),
      })
      const off = ctx.systemPrompt?.section?.(section)
      return typeof off === 'function' ? off : null
    }
    try {
      state.sectionOff = registerSection(canUseContext ? { maxOrder: FACTS_MIN_ORDER - 1 } : null)
      if (!state.sectionOff) report('prompt.section', new Error('ctx.systemPrompt.section 缺失'))
    } catch (error) { report('prompt.section', error) }
    if (!canUseContext) {
      // 降级原因只记一次，便于线上区分"宿主不支持"还是"配置/实验开关"。
      log({ msg: 'icl.prompt-layout', layout: 'single-section', reason: typeof ctx.systemPrompt?.context !== 'function' ? 'no-systemPrompt.context' : 'disabled-by-config' })
      return
    }
    try {
      // facts 快照节流（Option 1，默认开）：同一 turn 内各 step 复用第一份事实文本，最多 1 条快照/轮。
      // 背景：DSH 的 runtime-context 快照只 append 不 replace，step-heavy 回合（MC 可到几十步）
      // 若事实每步都变，就会按步数线性累积（见 docs/CACHE-MODEL.md §7.7）。
      //
      // 新鲜度护栏（stale ≤ 1 步）：
      //   · focus enter/leave、time arrange/cancel/sleep/wake 这类**事件类事实**通过
      //     focus.onChange / delivery tick 标 dirty → 下一次 context 求值立即重算（下一步可见）；
      //   · **MC 环境事实（位置/血量/背包）允许整轮陈旧**（豁免，勿当 bug）：以模型显式
      //     mcb_status / mcb_inventory 为准，换来 MC 回合不再每步追加一条快照。
      const throttle = config.factsEveryStep !== true && process.env.ICL_FACTS_EVERY_STEP !== '1'
      const readFacts = () => {
        if (!throttle) {
          try {
            return host.services.prompt.assemble({ sessionId: state.session?.id ?? undefined }, { minOrder: FACTS_MIN_ORDER })
          } catch (error) {
            report('prompt.context', error)
            return ''
          }
        }
        if (state.factsDirty) { state.factsDirty = false; state.factsCache = { turn: null, text: null } }
        if (state.factsCache.turn === state.turn && state.factsCache.text != null) return state.factsCache.text
        let text = ''
        try {
          text = host.services.prompt.assemble({ sessionId: state.session?.id ?? undefined }, { minOrder: FACTS_MIN_ORDER })
        } catch (error) {
          report('prompt.context', error)
        }
        state.factsCache = { turn: state.turn, text }
        state.stats.factsRefreshes += 1
        return text
      }
      const off = ctx.systemPrompt.context({
        name: 'icl:facts',
        order: 850,
        text: readFacts,
      })
      state.factsOff = typeof off === 'function' ? off : () => {}
      state.stats.factsInContext = true
      // 事件类事实的 dirty 源（focus）：进入/离开/换焦点 → 下一步快照必须含新焦点。
      try {
        state.offFactsDirty = host.services.focus.onChange(() => { state.factsDirty = true })
      } catch (error) { report('prompt.facts-dirty', error) }
      log({ msg: 'icl.prompt-layout', layout: 'static+facts-context', staticMaxOrder: FACTS_MIN_ORDER - 1, factsOrder: 850, factsPerTurn: throttle })
    } catch (error) {
      report('prompt.context', error)
      // 注册失败不能让事实丢失：撤掉静态段，退回旧的全量单段（缓存差，但语义完整）。
      try { state.sectionOff?.() } catch { /* ignore */ }
      state.sectionOff = null
      try {
        state.sectionOff = registerSection(null)
        state.stats.factsInContext = false
      } catch (inner) { report('prompt.section', inner) }
    }
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
    const raw = String(query ?? '').trim().toLowerCase()
    if (!raw) return []
    const max = Math.max(1, Number(limit) || 2)
    // 纯子串匹配对"今天主人发过哪些图片和视频"这种问句几乎永远 0 命中；
    // 改成中文 bigram + 西文词打分：抽到"主人/图片/视频"就能从原文捞回细节。
    const compact = raw.replace(/[\s，。！？、,.!?;；:：'"“”‘’（）()\[\]【】]/g, '')
    const terms = new Set()
    for (const seg of (raw.match(/[\u4e00-\u9fff]{2,}/g) ?? [])) {
      for (let i = 0; i + 1 < seg.length; i += 1) terms.add(seg.slice(i, i + 2))
    }
    for (const word of (raw.match(/[a-z0-9_]{2,}/g) ?? [])) terms.add(word)
    const list = [...terms].slice(0, 24)
    if (!list.length) return []
    const scored = []
    for (let i = state.raw.length - 1; i >= 0; i -= 1) {
      const row = state.raw[i]
      const text = String(row.text ?? '')
      if (!text) continue
      const hay = text.toLowerCase().replace(/\s+/g, '')
      let hits = 0
      for (const term of list) if (hay.includes(term)) hits += 1
      const exact = compact.length > 3 && hay.includes(compact) ? 1 : 0
      if (!hits && !exact) continue
      scored.push({ row, score: hits / list.length + exact * 2 })
      if (scored.length >= 400) break
    }
    scored.sort((a, b) => b.score - a.score || Number(b.row.time ?? 0) - Number(a.row.time ?? 0))
    return scored.slice(0, max).map((entry) => entry.row)
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

  function pluginLabel(plugin) {
    return plugin === 'mc' ? 'MC' : plugin === 'time' ? '时间' : plugin === 'focus' ? '焦点' : plugin === 'qq' ? '外部消息' : plugin
  }

  function noticeMessage(batch, text) {
    const plugin = String(batch?.entries?.[0]?.source?.plugin ?? 'icl').replace(/[^a-z0-9:_-]/gi, '') || 'icl'
    const label = pluginLabel(plugin)
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

  /** 延迟取 DSH attachment 服务；没有就返回 null（调用方降级为文字提示）。 */
  function attachmentsService() {
    const ok = (store) => Boolean(store && (typeof store.saveImage === 'function' || typeof store.saveImages === 'function'))
    if (ok(state.attachments)) return state.attachments
    if (!state.attachmentsInjected && typeof ctx.inject === 'function') {
      state.attachmentsInjected = true
      try {
        ctx.inject(['attachments'], (sub) => {
          if (ok(sub?.attachments)) {
            state.attachments = sub.attachments
            diag({ event: 'attachments.injected', saveImages: typeof sub.attachments.saveImages === 'function', saveImage: typeof sub.attachments.saveImage === 'function' })
          } else if (sub?.attachments) {
            state.attachments = sub.attachments
            diag({ event: 'attachments.injected-no-api', keys: Object.keys(sub.attachments).slice(0, 8) })
          } else {
            diag({ event: 'attachments.inject-empty', keys: sub ? Object.keys(sub).slice(0, 8) : null })
          }
        })
      } catch (error) {
        report('attachments.inject', error)
      }
    }
    // inject 可能是同步回调：这里必须再取一次，不能无条件 null（否则启动后第一张图必被降级）。
    if (ok(state.attachments)) return state.attachments
    // 测试/非 Cordis 宿主：ctx 可能直接挂了 attachments。Cordis 未 inject 时读取会抛错，
    // 所以必须 try/catch，不能影响有 inject 的真实宿主。
    try {
      if (ok(ctx.attachments)) return ctx.attachments
    } catch { /* Cordis: cannot get property without inject */ }
    return null
  }

  /**
   * 图片通道（QQ 等入站附件）：
   *   · batch.images 里是插件给来的字节描述符（data/mediaType/name/path），
   *     这里换成 DSH ImageAttachmentRef → content 里的 image block；正文不写 URL/base64。
   *   · 先用 store.imageLimits 预检（张数/单张字节/合计字节/类型）；超限的跳过并提示，
   *     避免把"绕过 admission"的无限图片塞进上下文（DSH 的像素/尺寸最终由 saveImages 校验）。
   *   · attachment 不可用/保存失败：消息照常投递，正文追加一行降级提示（带本地媒体路径，可用 read_image），
   *     **不丢消息**，也绝不把字节塞进正文。
   */
  async function noticeMessageWithImages(batch, text) {
    const descriptors = (Array.isArray(batch?.images) ? batch.images : [])
      .filter((img) => img && img.data && img.mediaType)
    diag({ event: 'inbound.images', batchImages: Array.isArray(batch?.images) ? batch.images.length : 0, descriptors: descriptors.length, text: String(text ?? '').slice(0, 80) })
    const refs = []
    const fallback = []
    if (descriptors.length) {
      const store = attachmentsService()
      if (store) {
        let candidates = descriptors
        let skipped = 0
        const limits = store.imageLimits && typeof store.imageLimits === 'object' ? store.imageLimits : null
        if (limits) {
          const mediaTypes = Array.isArray(limits.mediaTypes) && limits.mediaTypes.length ? new Set(limits.mediaTypes.map(String)) : null
          const maxCount = Number(limits.maxImagesPerMessage) || Number.POSITIVE_INFINITY
          const maxBytes = Number(limits.maxImageBytes) || Number.POSITIVE_INFINITY
          const maxTotal = Number(limits.maxMessageImageBytes) || Number.POSITIVE_INFINITY
          let total = 0
          const kept = []
          for (const img of candidates) {
            const bytes = Number(img.data?.byteLength ?? img.data?.length ?? 0)
            if (kept.length >= maxCount || (mediaTypes && !mediaTypes.has(String(img.mediaType)))
              || bytes > maxBytes || total + bytes > maxTotal) {
              skipped += 1
              continue
            }
            total += bytes
            kept.push(img)
          }
          candidates = kept
        }
        if (skipped > 0) fallback.push(`（${skipped} 张图片超过附件上限，已跳过）`)
        try {
          const saved = candidates.length
            ? await store.saveImages(candidates.map((img) => ({
              data: img.data instanceof Uint8Array ? img.data : new Uint8Array(img.data),
              mediaType: String(img.mediaType),
              ...(img.name ? { name: String(img.name) } : {}),
            })))
            : []
          for (const ref of Array.isArray(saved) ? saved : []) {
            if (ref && typeof ref === 'object') refs.push(ref)
          }
        } catch (error) {
          const disk = descriptors.map((img) => img.path).filter(Boolean).slice(0, 2)
          fallback.push(`（${descriptors.length} 张图片未能显示：${String(error?.message ?? error).slice(0, 120)}${disk.length ? `；本地文件：${disk.join('、')}` : ''}）`)
          report('delivery.image-attach', error)
        }
      } else {
        const disk = descriptors.map((img) => img.path).filter(Boolean).slice(0, 2)
        fallback.push(`（${descriptors.length} 张图片未能显示：当前会话没有 attachment 服务${disk.length ? `；本地文件：${disk.join('、')}` : ''}）`)
      }
    }
    // 纯图片消息：正文不能为空（否则 summary/模型侧只有空 text + image）。
    let fullText = String(text ?? '')
    if (!fullText && (refs.length || descriptors.length)) fullText = '（图片）'
    if (fallback.length) fullText = fullText ? `${fullText}\n${fallback.join('\n')}` : fallback.join('\n')
    const plugin = String(batch?.entries?.[0]?.source?.plugin ?? 'icl').replace(/[^a-z0-9:_-]/gi, '') || 'icl'
    return toDshUserMessage(fullText, {
      id: `icl-notice-${batch.id}-${randomUUID()}`,
      source: {
        kind: `plugin:${plugin}`,
        form: 'notice',
        summary: `${pluginLabel(plugin)}：${fullText.replace(/\s+/g, ' ').slice(0, 100)}`.slice(0, 120),
      },
      images: refs,
    })
  }

  function lastSessionIdHint() {
    if (config.sessionId) return String(config.sessionId)
    const raw = Array.isArray(state.raw) ? state.raw : []
    for (let i = raw.length - 1; i >= 0; i -= 1) {
      const id = raw[i]?.sessionId
      if (id) return String(id)
    }
    return null
  }

  /**
   * 没有 live Agent 时的标准投递：用 DSH 官方 apiProxy.sessions.prompt 冷恢复目标会话。
   * 这条路径就是 old dsh-qq 的 ensureSession + sessions.prompt；不再依赖 Host 侧自己 resume。
   */
  async function promptWithoutAgent() {
    const api = state.apiProxy?.sessions
    const sessionId = state.session?.id ?? lastSessionIdHint()
    if (!api?.prompt || !sessionId) return 0
    if (state.ticking) return 0
    state.ticking = true
    const batches = host.services.delivery.drain('session')
    if (!batches.length) { state.ticking = false; return 0 }
    const text = batches.map((batch) => String(batch.text ?? '').trim()).filter(Boolean).join('\n\n')
    if (!text) {
      for (const batch of batches) host.services.delivery.ack(batch.id)
      state.ticking = false
      return 0
    }
    try {
      const out = await api.prompt({
        rpcId: randomUUID(),
        payload: {
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: text.slice(0, 12000) }],
        },
      })
      const ok = out?.result ? out.result.ok !== false : out?.ok !== false
      if (!ok) {
        for (const batch of batches) host.services.delivery.nack(batch.id, out?.result?.error?.message ?? 'session.prompt rejected')
        report('delivery.prompt-no-agent', out?.result?.error ?? out)
        return 0
      }
      for (const batch of batches) host.services.delivery.ack(batch.id)
      state.stats.delivered += batches.length
      return batches.length
    } catch (error) {
      for (const batch of batches) host.services.delivery.nack(batch.id, error?.message ?? error)
      report('delivery.prompt-no-agent', error)
      return 0
    } finally {
      state.ticking = false
    }
  }

  async function tick() {
    if (!state.agent) {
      if (host.services.delivery.pendingCount() > 0) {
        const sent = await promptWithoutAgent()
        if (sent > 0) return { sent }
      }
      return { sent: 0, skipped: 'no-agent' }
    }
    // 图片通道会让 tick 变 async；定时器可能重入，用 busy 标志避免同一批被 drain 两次。
    if (state.ticking) return { sent: 0, skipped: 'busy' }
    state.ticking = true
    let sent = 0
    try {
      for (const batch of host.services.delivery.drain('session')) {
        const text = String(batch.text ?? '').trim()
        const hasImages = Array.isArray(batch.images) && batch.images.length > 0
        if (!text && !hasImages) { host.services.delivery.ack(batch.id); continue }
        try {
          const message = hasImages ? await noticeMessageWithImages(batch, text) : noticeMessage(batch, text)
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
          // 只有"会改变 facts 文本"的事件源才标 dirty（默认 time/focus）。
          // MC 事件（掉血/走路/任务进度）不改变 facts 语义——MC 环境事实按 CACHE-MODEL §7.7 允许整轮陈旧，
          // 以 mcb_status 为准；E2 实测把每条 MC 事件都当 dirty 会每轮追加 2.5 条 ~700 字符的 runtime-context。
          const dirtyPlugins = Array.isArray(config.factsDirtyPlugins) && config.factsDirtyPlugins.length ? config.factsDirtyPlugins : ['time', 'focus']
          // drain 出来的 batch 没有顶层 source；来源在 entries[].source（同一 batch 按 plugin 分组）。
          const sourcePlugin = String(batch.source?.plugin ?? batch.entries?.[0]?.source?.plugin ?? batch.entries?.[0]?.source?.id ?? '')
          if (dirtyPlugins.includes('*') || dirtyPlugins.includes(sourcePlugin)) state.factsDirty = true
          sent += 1
        } catch (error) {
          host.services.delivery.nack(batch.id, error?.message ?? error)
          state.stats.failed += 1
          report('delivery.steer', error)
          break
        }
      }
    } finally {
      state.ticking = false
    }
    return { sent }
  }

  function startTimer() {
    if (state.timer) return
    const interval = Math.max(50, Number(config.tickMs) || 500)
    state.timer = setInterval(() => { tick().catch((error) => report('delivery.tick', error)) }, interval)
    if (typeof state.timer.unref === 'function') state.timer.unref()
  }

  /* ── 会话 / agent ─────────────────────────────────────── */

  /** 跨会话绑定保留：时间闹钟/睡醒 + QQ 对话消息 + 明确需要人看见的 poke/@/admin/alarm。 */
  function keepAcrossSessionBind(item) {
    const plugin = String(item?.source?.plugin ?? '')
    if (plugin === 'time') return true
    const tags = Array.isArray(item?.source?.tags) ? item.source.tags : []
    if (item?.source?.pierce === true) return true
    // QQ 私聊/群消息是外部对话本身：会话未绑定时已经 accepted 的消息不能在 bind 时被清掉。
    if (tags.includes('private') || tags.includes('group')) return true
    return tags.some((tag) => ['poke', 'mention', 'at', 'admin', 'alarm'].includes(String(tag)))
  }

  function bindSession(session) {
    if (!session?.id) return
    const id = String(session.id)
    if (state.session?.id === id) return
    if (state.releaseClaim) { try { state.releaseClaim() } catch { /* ignore */ } state.releaseClaim = null }
    state.session = session
    state.releaseClaim = host.claimSession ? host.claimSession(id) : null
    state.injected.clear()
    state.turn = null
    state.factsCache = { turn: null, text: null }
    state.repeat = { sig: null, count: 0, lastNoticeAt: 0 }
    // 新会话从空投递队列开始；旧会话/旧 run 留在 host 队列里的消息不能先于第一轮漏进来。
    // 例外：time 的闹钟/睡醒，以及 poke/@/admin/alarm 这类高优先级提醒不能因为当时没绑定而丢。
    try { host.services.delivery.clear({ preserve: keepAcrossSessionBind }) } catch { /* ignore */ }
    // 会话一绑定就告诉她还有哪些旧消息没交付，避免"她回来却不知道"。
    try { host.shared.get('qq')?.notifyPending?.('session-bind') } catch { /* qq 未启用 */ }
    diag({ event: 'session.bind', id, agent: Boolean(state.agent), pending: host.services.delivery.pendingCount() })
    log({ msg: 'icl.session', id })
  }

  function unbindSession(session = null) {
    if (session && state.session && String(session.id) !== String(state.session.id)) return
    if (state.releaseClaim) { try { state.releaseClaim() } catch { /* ignore */ } }
    state.releaseClaim = null
    state.session = null
    state.agent = null
    state.turn = null
    state.factsCache = { turn: null, text: null }
    state.repeat = { sig: null, count: 0, lastNoticeAt: 0 }
    state.injected.clear()
    // 旧会话的待投递不能漏给下一条会话；time 闹钟与 poke/@ 等提醒保留到下一次绑定。
    try { host.services.delivery.clear({ preserve: keepAcrossSessionBind }) } catch { /* ignore */ }
    diag({ event: 'session.unbind', id: session?.id ?? null, pending: host.services.delivery.pendingCount() })
  }

  function bindAgent(agent) {
    if (!agent) return
    if (!state.session && agent.session) bindSession(agent.session)
    if (!agent.session || String(agent.session.id) !== String(state.session?.id ?? '')) return
    state.agent = agent
    startTimer()
    diag({ event: 'agent.bind', id: agent.id ?? agent.session?.id ?? null, pending: host.services.delivery.pendingCount() })
    log({ msg: 'icl.agent', id: agent.id ?? agent.session?.id ?? null })
  }

  /* ── 事件 ─────────────────────────────────────────────── */

  /**
   * 会改 facts 文本的工具名白名单（工具结果出现即标 dirty，下一步刷新快照）。
   * 前缀式：`time_status`/`time_list`/`memos` 这类只读工具也会命中，代价只是多一次文本重算
   * （DSH 侧文本没变就不会 append 快照），不是 bug。
   * `mcb_*` 故意不在白名单：MC 环境事实按 §7.7 豁免（join/leave 等事件仍由 delivery dirty 兜底）。
   */
  function isFactsTool(rawName) {
    const name = String(rawName ?? '')
    return name.startsWith('time_') || name.startsWith('memo') || name.startsWith('lexicon_learn')
  }

  /* ── 通用重复动作保护（用户要求，local3: 87 次同一句 mcb_do say） ───────── */

  /** 规范化 args：对象键排序、数组保序、字符串 trim；用于"完全相同动作"判定。 */
  function stableNormalize(value, depth = 0) {
    if (depth > 8) return '[deep]'
    if (value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map((item) => stableNormalize(item, depth + 1))
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = stableNormalize(value[key], depth + 1)
    return out
  }

  function signatureOfToolCall(event) {
    const name = String(event?.data?.name ?? event?.data?.tool ?? event?.data?.toolName ?? '')
    if (!name) return null
    let args = event?.data?.arguments ?? event?.data?.args ?? event?.data?.input ?? null
    if (args == null) args = {}
    if (typeof args === 'string') {
      const trimmed = args.trim()
      try { args = JSON.parse(trimmed) } catch { args = trimmed }
    }
    let argsText = ''
    try { argsText = JSON.stringify(stableNormalize(args)) } catch { argsText = String(args) }
    if (argsText.length > 2000) argsText = argsText.slice(0, 2000)
    return `${name}|${argsText}`
  }

  function repeatNow() {
    try {
      const injected = Number(config.now?.())
      if (Number.isFinite(injected)) return injected
    } catch { /* fall through */ }
    return Date.now()
  }

  /**
   * 通用重复动作保护（不只 MC，对所有工具生效）：
   * 同一 session 连续 N 次完全相同（name + 规范化 args）→ 通过 delivery 注入一条 append-only notice；
   * 同一 session 60s 内不重复提示（节流）。不改 system/facts，不伪造 user。
   */
  function guardRepeatedToolCall(event) {
    if (config.repeatGuard === false) return
    const sig = signatureOfToolCall(event)
    if (!sig) return
    const after = Math.max(2, Number(config.repeatGuardAfter ?? 3))
    const throttleMs = Math.max(0, Number(config.repeatGuardThrottleMs ?? 60_000))
    const now = repeatNow()
    if (state.repeat.sig === sig) state.repeat.count += 1
    else state.repeat = { sig, count: 1, lastNoticeAt: state.repeat.lastNoticeAt }
    if (state.repeat.count < after) return
    if (state.repeat.lastNoticeAt && now - state.repeat.lastNoticeAt < throttleMs) return
    state.repeat.lastNoticeAt = now
    state.stats.repeatGuards += 1
    const name = sig.slice(0, sig.indexOf('|'))
    const text = `检测到你连续重复同一动作 ${state.repeat.count} 次（${name}）；如果没有进展，换策略/等待事件/检查目标，不要说同一句。`
    try {
      host.services.delivery.push({
        source: { plugin: 'icl', activity: 'repeat-guard' },
        content: { text },
        batchKey: 'icl:repeat-guard',
      })
    } catch (error) {
      report('repeat-guard.push', error)
    }
    log({ msg: 'icl.repeat-guard', tool: name, count: state.repeat.count })
  }

  function onEvent(session, event) {
    if (!state.session || String(session?.id) !== String(state.session.id)) return
    // 记当前 turn：facts 快照节流按 turn 刷新（turn/start 是 DSH 每轮第一件事）。
    // 缓存键是 turn 号：会话恢复/重放若复用同一 turn 号，bind/unbind 会清空缓存（够用）；
    // 若将来支持同一 session 内 rewind，需要额外的 generation 计数，别只靠 turn。
    if (event?.type === 'turn/start') state.turn = Number.isFinite(Number(event.data?.turn)) ? Number(event.data.turn) : state.turn
    if (event?.type === 'turn/start') state.renderTail = { turn: state.turn, lastText: null, count: 0, chars: 0 }
    // 模型在 turn 内自己改事实的工具（time_*/memo*/lexicon_learn）——它们出现在 facts 文本里
    // （下一个安排/静音到/待办计数/词汇），必须标 dirty，否则同一 turn 后面几十步仍是旧值。
    // 注：silent schedule（如 dream:nightly）走 signals.emit 不走 delivery，不在此列，
    // 允许陈旧到轮末（它通常不产生模型消息）；MC 环境事实按 §7.7 豁免。
    if (event?.type === 'tool/result' && isFactsTool(event.data?.name ?? event.data?.tool)) state.factsDirty = true
    appendRaw(session, event)
    // 通用重复动作保护：所有工具都过，连续 N 次同签名才提示（delivery, append-only）。
    if (event?.type === 'tool/call') guardRepeatedToolCall(event)
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
      // producer-owned 来源：**不能**再用 'runtime-context'。
      // DSH 的 RuntimeContextProjection 用 `source.kind === 'runtime-context'` 判断这是不是
      // 它自己的快照；ICL 每注入一次 <icl-context>，DSH 就以为"自己的快照被换了"，
      // 于是在下一个 step 额外 append 一份完整快照（≈+190 tok 上下文 / +140 prefill 每轮）。
      // 'plugin:<owner>' 是 v4 规范允许的 producer-owned kind（同 noticeMessage 的先例）。
      // 原文/历史/本轮扫描都按 kind!=='user' 过滤，改后仍不会把它当人话。
      source: {
        kind: 'plugin:icl',
        form: 'notice',
        summary: `上下文：${extra.replace(/\s+/g, ' ').slice(0, 100)}`.slice(0, 120),
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
    // 没有 live Agent 时，走 DSH 官方 apiProxy.sessions.prompt 冷恢复会话；
    // 这是 old dsh-qq/ensureSession 使用过的标准入口，不自己造 resume。
    try {
      if (typeof ctx.inject === 'function') {
        ctx.inject(['apiProxy'], (sub) => {
          state.apiProxy = sub.apiProxy
          diag({ event: 'bridge.apiproxy', ok: Boolean(state.apiProxy?.sessions?.prompt) })
        })
      }
    } catch (error) {
      diag({ event: 'bridge.apiproxy-fail', error: String(error?.message ?? error) })
      report('apiproxy.inject', error)
    }
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
      repeat: { count: state.repeat.count, tool: state.repeat.sig ? state.repeat.sig.slice(0, state.repeat.sig.indexOf('|')) : null, lastNoticeAt: state.repeat.lastNoticeAt || null },
      renderTail: { enabled: tailCfg.enabled, maxPerTurn: tailCfg.maxPerTurn, maxCharsPerTurn: tailCfg.maxCharsPerTurn, turnAppended: state.renderTail.count, lastText: state.renderTail.lastText },
      signals: host.services.signals.stats(),
      stats: { ...state.stats },
    }
  }

  function dispose() {
    if (state.timer) { clearInterval(state.timer); state.timer = null }
    try { state.offSurface?.() } catch { /* ignore */ }
    try { state.sectionOff?.() } catch { /* ignore */ }
    try { state.factsOff?.() } catch { /* ignore */ }
    try { state.offFactsDirty?.() } catch { /* ignore */ }
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
