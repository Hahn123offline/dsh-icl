// 插件宿主：加载、启用、停用。
//
// "动态工具面"的全部答案就在这里：apply() 期间插件拿到的一切注册都会返回注销器，
// 宿主把这些注销器按逆序排好；disable 时依次调用，于是下一轮装配就看不到它的工具、
// 提示词段、focus 租约。没有第二套状态需要同步。

import { validateManifest } from './contracts.mjs'
import { createContextService, createPresetService, createRawSourceRegistry, createToolSurface, createToolRegistry, createPromptService, createFocusService, createDeliveryService, createSlotRegistry, createContractRegistry } from './services.mjs'
import { createModelClient } from './model-client.mjs'
import { createSignalService } from './signals.mjs'
import { createVisionService } from './vision.mjs'

export function createHost({ log = () => {}, now: systemNow = () => Date.now(), fetchImpl = globalThis.fetch } = {}) {
  let clockOverride = null
  const now = () => {
    const value = clockOverride ? clockOverride() : systemNow()
    return Number(value) || systemNow()
  }
  const report = (where, error) => {
    try { log({ msg: 'core.service-error', where, error: String(error?.message ?? error) }) } catch { /* 日志坏了不影响服务 */ }
  }
  const tools = createToolRegistry({
    stampTime: process.env.ICL_TOOL_TIME === '1' ? () => new Date().toLocaleTimeString('zh-CN', { hour12: false }) : null, onChange: (event) => log({ msg: 'tools.change', ...event }) })
  const prompt = createPromptService({ onError: report })
  const focus = createFocusService({ now })
  const delivery = createDeliveryService({ now })
  const raw = createRawSourceRegistry({ onError: report })
  const context = createContextService({ onError: report })
  const presets = createPresetService({ plugins: () => [...plugins.values()].map((r) => ({ id: r.manifest.id, manifest: r.manifest, enabled: r.enabled })) })
  const surface = createToolSurface({
    tools,
    plugins: () => [...plugins.values()].map((r) => ({ id: r.manifest.id, manifest: r.manifest, enabled: Boolean(r.enabled) })),
    presets,
    onError: report,
  })
  const signals = createSignalService({ now })
  const vision = createVisionService({ fetchImpl })
  const slots = createSlotRegistry()
  const model = createModelClient({ fetchImpl, now })
  signals.setDeliver((signal) => {
    // 注意力闸门：别处的事先问 focus，能不能现在进来。
    const decision = focusDecision(signal)
    if (!decision.deliver) {
      focus.defer(signal)
      return { queued: true, reason: decision.reason, focus: decision.focus }
    }
    // P3：signals 层不再有 time gate；时间裁决只在 delivery 层的 time gate 做一次。
    // 被 time 拦下时 delivery.push 返回 blocked（内容已进 time 队列），这里要如实报 queued，
    // 不能仍报 delivered:true。
    const pushed = delivery.push({
      to: 'session',
      channel: 'signal',
      source: {
        plugin: signal.from.plugin,
        activity: signal.from.activity ?? 'signal',
        seq: null,
        // P3：时间闸门已移到 delivery 层，这里必须把信号的"急迫度/空间/账本身份"
        // 一起带过去，否则 alarm/priority/seq 会在 delivery 层丢失。
        tags: Array.isArray(signal.tags) ? signal.tags : [],
        focus: signal.focus ?? null,
        priority: signal.meta?.priority ?? null,
        pierce: signal.meta?.pierce === true,
        meta: signal.meta ?? null,
        signalId: signal.id,
        createdAt: signal.createdAt,
        expiresAt: signal.expiresAt,
      },
      content: { text: signal.text, images: Array.isArray(signal.images) ? signal.images : [] },
      batchKey: `signal:${signal.from.plugin}:${signal.focus ?? ''}`,
      exactlyOnce: false,
    })
    if (pushed && pushed.blocked) return { queued: true, blocked: true, reason: pushed.reason ?? 'delivery-gate' }
    return { delivered: true, reason: decision.reason }
  })
  // 焦点释放/切换：把积压一次性交给她（不是逐条推送）。
  // 走 signals.offer 而不是 delivery.push：这样静音/睡眠 gate 与 focus.admit 都能裁决，
  // 睡眠中释放焦点不会把摘要直接塞进会话（会进积压，醒来再放）。
  focus.onChange(() => {
    const currentLabel = focus.current()?.label ?? null
    // 进入某个群焦点时只回放该群的 backlog；别的群继续留着，等切过去再回放。
    const rows = focus.drainBacklog(currentLabel && String(currentLabel).startsWith('qq:group:')
      ? (row) => row.focus === currentLabel
      : null)
    if (!rows.length) return
    const total = rows.reduce((sum, row) => sum + row.count, 0)
    const body = rows
      .map((row) => `· [${row.focus}] +${row.count}${row.lastText ? `：${row.lastText}` : ''}`)
      .join('\n')
    // 重放回执：每条被 focus 拦下的 QQ 信号都记了 (activity, seq)；摘要真正进管道后才推 delivered。
    const qqSeqs = rows.flatMap((row) => (Array.isArray(row.items) ? row.items : []).flatMap((item) => (Array.isArray(item.qqSeqs) && item.qqSeqs.length ? item.qqSeqs : (item.qq ? [item.qq] : []))).filter(Boolean))
    const outcome = signals.offer({
      from: { plugin: 'focus', activity: 'backlog' },
      kind: 'notice',
      text: `你离开焦点期间，别处积压了 ${total} 条：\n${body}`,
      focus: focus.current()?.label ?? null,
      tags: ['focus-backlog'],
      // 若被 time 拦下，摘要会带着这些 seq 进 time 队列，在真正释放时再补推 QQ。
      meta: qqSeqs.length ? { replayQq: qqSeqs.map((row) => ({ activity: row.activity, seq: row.seq })) } : null,
    })
    if (qqSeqs.length && (outcome?.accepted || outcome?.deduped) && outcome?.queued !== true) noteQqDelivered(qqSeqs, 'focus-backlog')
  })

  /** id -> { manifest, module, apply, dispose:Function[], enabled:boolean } */
  let claimedSession = null
  const plugins = new Map()
  /** 插件之间共享能力的注册表：provide/get */
  const shared = new Map()
  const contracts = createContractRegistry({
    tools,
    prompt,
    hasService: (name) => shared.has(String(name)),
    log,
  })

  /** QQ 重放回执：只在这些消息**确实重新进入投递管道**后调用；只推 delivered，不推 attended。 */
  function noteQqDelivered(seqs, via) {
    const qq = shared.get('qq')
    if (!qq || typeof qq.noteDeliveredSeqs !== 'function') return 0
    const byActivity = new Map()
    for (const row of (Array.isArray(seqs) ? seqs : [])) {
      if (!row || Number(row.seq) <= 0) continue
      const activity = String(row.activity ?? '')
      if (!activity) continue
      const set = byActivity.get(activity) ?? new Set()
      set.add(Number(row.seq))
      byActivity.set(activity, set)
    }
    let accepted = 0
    for (const [activity, list] of byActivity) {
      try {
        const out = qq.noteDeliveredSeqs({ activity, seqs: [...list], via, at: now() })
        accepted += Number(out?.accepted ?? 0)
      } catch (error) { report('qq.receipt', error) }
    }
    return accepted
  }

  /**
   * 空间裁决（含睡眠租约例外）：`sleep` 是 time 的时间锁标记（owner=time/kind=idle/label=sleep），
   * 不是"她正在做的事"；跳过它，让 delivery 层的 time gate 决定睡眠积压（否则正常消息会被
   * sacred 的睡眠租约收进 focus backlog，破坏 sleep backlog 语义）。
   */
  function focusDecision(signal) {
    const cur = focus.current()
    if (cur && cur.owner === 'time' && cur.label === 'sleep' && cur.kind === 'idle') return { deliver: true, reason: 'sleep-marker' }
    return focus.admit(signal)
  }

  // C6：直投 delivery 也要先过 focus（空间闸门）；time 的时间闸门在插件启用后追加，
  // 所以 gate 顺序是 focus → time。显式 bypass：from.plugin==='time'、tags admin/alarm、
  // 或 source.meta.bypassFocus===true（只有结构性用途，不改变真实消息路径）。
  delivery.addGate((entry = {}) => {
    if (entry.channel === 'signal') return { accept: true } // signals 路径已在 setDeliver 里过 admit
    const src = entry.source ?? {}
    const tags = Array.isArray(src.tags) ? src.tags : []
    const meta = src.meta && typeof src.meta === 'object' ? src.meta : null
    const bypass = String(src.plugin ?? '') === 'time' || tags.includes('admin') || tags.includes('alarm') || meta?.bypassFocus === true
    if (bypass) return { accept: true }
    const signal = {
      from: { plugin: String(src.plugin ?? ''), activity: src.activity ?? 'delivery' },
      kind: 'notice',
      text: String(entry.content?.text ?? ''),
      focus: src.focus ?? null,
      tags,
      meta,
    }
    const decision = focusDecision(signal)
    if (decision.deliver) return { accept: true }
    focus.defer(signal)
    return { accept: false, reason: decision.reason ?? 'focus' }
  })

  const clockBridge = {
    set(fn) { const prev = clockOverride; clockOverride = typeof fn === 'function' ? fn : null; return () => { clockOverride = prev } },
    reset() { clockOverride = null },
    owns: () => Boolean(clockOverride),
  }

  function makeContext(manifest, record) {
    const pluginId = manifest.id
    return {
      id: pluginId,
      manifest,
      log: (entry) => log({ plugin: pluginId, ...(typeof entry === 'string' ? { msg: entry } : entry) }),
      now,
      /** 记录一个注销器（宿主统一管理生命周期）。 */
      onDispose(fn) { if (typeof fn === 'function') record.dispose.push(fn) },
      tools: {
        register(definition) {
          const dispose = tools.register({ ...definition, plugin: pluginId })
          // 注册/注销都要让适配器看到：旧的实现只写日志，运行中新增的工具不会推给 DSH。
          const off = () => {
            try { dispose() } finally { surface.notify() }
          }
          record.dispose.push(off)
          surface.notify()
          return off
        },
      },
      prompt: {
        section(section) {
          const dispose = prompt.section(section)
          record.dispose.push(dispose)
          return dispose
        },
        onTurn(provider) {
          const dispose = prompt.onTurn(provider)
          record.dispose.push(dispose)
          return dispose
        },
      },
      contracts: {
        registerFeature(def) {
          const handle = contracts.registerFeature(def)
          record.dispose.push(handle.dispose)
          return handle
        },
        status: (id) => contracts.status(id),
        list: () => contracts.list(),
      },
      focus: {
        enter(options) {
          const lease = focus.enter({ owner: pluginId, ...options })
          record.dispose.push(lease.release)
          return lease
        },
        canPierce: (label, opts) => focus.canPierce(label, opts),
        current: () => focus.current(),
        list: () => focus.list(),
        clear: () => {
          for (const lease of focus.list()) { try { lease.release?.() } catch { /* ignore */ } }
          focus.drainBacklog()
        },
        admit: (signal) => focus.admit(signal),
        backlog: () => focus.backlog(),
        drainBacklog: (filter) => focus.drainBacklog(filter),
        defer: (signal) => focus.defer(signal),
        onChange: (fn) => { const off = focus.onChange(fn); record.dispose.push(off); return off },
      },
      delivery: {
        push: (input) => delivery.push({ ...input, source: { plugin: pluginId, ...(input?.source ?? {}) } }),
        clear: () => delivery.clear(),
        /**
         * 安装 push-time gate（时间模块的睡眠/静音拦截）。
         * 旧接口：替换全部 gate；卸载时恢复上一个，而不是一律置空。
         */
        setGate(fn) {
          const previous = delivery.setGate(fn)
          record.dispose.push(() => delivery.setGate(previous))
          return previous
        },
        /** 组合式 gate（推荐）：卸载时只摘掉自己那一层，不覆盖别人。 */
        addGate(fn) {
          const off = delivery.addGate(fn)
          record.dispose.push(off)
          return off
        },
        blockedCount: () => delivery.blockedCount(),
        gateCount: () => delivery.gateCount(),
      },
      slots: {
        declare(slot) {
          const dispose = slots.declare({ ...slot, owner: pluginId })
          record.dispose.push(dispose)
          return dispose
        },
        call: (id, request) => slots.call(id, request),
        resolve: (id) => slots.resolve(id),
        require: (id) => slots.require(id),
        onChange: (fn) => { const off = slots.onChange(fn); record.dispose.push(off); return off },
        registerProvider: (provider) => { const off = slots.registerProvider(provider); record.dispose.push(off); return off },
        autoBind: () => slots.autoBind(),
        unmatched: () => slots.unmatched(),
        providers: () => slots.providers(),
        list: () => slots.list(),
      },
      // 统一信号：插件只往这里发，谁放行由时间模块决定
      signals: {
        offer: (signal) => signals.offer(signal),
        emit: (signal) => signals.emit(signal),
        on: (filter, fn) => { const off = signals.on(filter, fn); record.dispose.push(off); return off },
        setGate: (fn) => signals.setGate(fn),
        /** 组合式 gate（推荐）：多个来源的拦截规则叠加，卸载时自动摘掉自己的那层。 */
        addGate: (fn) => { const off = signals.addGate(fn); record.dispose.push(off); return off },
        stats: () => signals.stats(),
      },
      services: {
        vision: { describe: (req) => vision.describe(req) },
        /** 时间模块接管系统时钟；其它插件只读。 */
        clock: {
          set: (fn) => clockBridge.set(fn),
          reset: () => clockBridge.reset(),
          owns: () => clockBridge.owns(),
        },
        raw: {
          register: (def) => { const off = raw.register(def); record.dispose.push(off); return off },
          search: (req) => raw.search(req),
          list: (req) => raw.list(req),
          ids: () => raw.ids(),
        },
        context: {
          history: (req) => context.history(req),
          onAssemble: (def) => { const off = context.onAssemble(def); record.dispose.push(off); return off },
          onCompact: (def) => { const off = context.onCompact(def); record.dispose.push(off); return off },
          assemble: (req) => context.assemble(req),
          compact: (req) => context.compact(req),
          provideHistory: (fn) => { const off = context.provideHistory(fn); record.dispose.push(off); return off },
        },
        provide(name, api) {
          const key = String(name)
          if (shared.has(key)) throw new Error(`能力重复：${key}`)
          shared.set(key, api)
          const dispose = () => { shared.delete(key) }
          record.dispose.push(dispose)
          return dispose
        },
        get(name) { return shared.get(String(name)) ?? null },
        require(name) {
          const api = shared.get(String(name))
          if (!api) throw new Error(`缺少依赖能力：${name}`)
          return api
        },
        list() { return [...shared.keys()] },
      },
      model: {
        chat: (input) => model.chat(input),
        bind: (binding) => model.bind(binding),
        pause: (reason) => model.pause(reason),
        resume: () => model.resume(),
        isPaused: () => model.isPaused(),
      },
      config: record.config ?? {},
      /** 统一的 HTTP 出口：插件不直接碰 globalThis.fetch，方便测试与代理 */
      fetch: (...args) => fetchImpl(...args),
    }
  }

  return {
    services: {
      tools, prompt, focus, delivery, slots, model, raw, context, surface, presets, signals, vision, contracts,
      /** 时间模块接管系统时钟：set 返回恢复函数。 */
      clock: {
        set: (fn) => clockBridge.set(fn),
        reset: () => clockBridge.reset(),
        owns: () => clockBridge.owns(),
      },
    },

    /** 单会话锁：核心只指向一个会话，第二个直接报错。 */
    claimSession(sessionId) {
      const id = String(sessionId ?? '').trim()
      if (!id) throw new Error('claimSession 需要 sessionId')
      if (claimedSession && claimedSession !== id) throw new Error(`已经指向会话 ${claimedSession}，不能再指向 ${id}`)
      claimedSession = id
      return () => { if (claimedSession === id) claimedSession = null }
    },

    /** 登记一个插件（不启用）。 */
    registerPlugin(manifestInput, module, { config = {} } = {}) {
      const checked = validateManifest(manifestInput)
      if (!checked.ok) throw new Error(`插件清单不合法：${checked.error}`)
      const manifest = checked.manifest
      const apply = module?.apply
      if (typeof apply !== 'function') throw new Error(`${manifest.id} 缺少导出的 apply(ctx)`)
      if (plugins.has(manifest.id)) throw new Error(`插件重复：${manifest.id}`)
      plugins.set(manifest.id, { manifest, module, apply, config, dispose: [], enabled: false })
      return manifest
    },

    /** 启用：调用 apply，记录它注册的一切。 */
    async enable(id) {
      const record = plugins.get(String(id))
      if (!record) throw new Error(`没有这个插件：${id}`)
      if (record.enabled) return { enabled: true, already: true }
      const requires = record.manifest.requires ?? {}
      for (const dep of requires.plugins ?? []) {
        const depRecord = plugins.get(String(dep))
        if (!depRecord?.enabled) throw new Error(`${record.manifest.id} 需要先启用插件：${dep}`)
      }
      record.dispose = []
      record.enabled = true
      const ctx = makeContext(record.manifest, record)
      // 清单里声明的插槽由宿主代为注册：插件只写"需要什么形状"，
      // 不自己去 declare，也就不可能写死模型名。
      for (const slot of record.manifest.slots ?? []) {
        try { record.dispose.push(slots.declare({ ...slot, owner: record.manifest.id })) } catch (error) {
          for (const dispose of record.dispose.reverse()) { try { dispose() } catch { /* 忽略 */ } }
          record.dispose = []
          record.enabled = false
          surface.notify()
          throw error
        }
      }
      try {
        const extra = await record.apply(ctx)
        if (typeof extra === 'function') record.dispose.push(extra)
      } catch (error) {
        record.enabled = false
        // apply 失败要把它已经注册的东西收回去，不能留半套；同时让适配器看到回滚后的工具面
        for (const dispose of record.dispose.reverse()) { try { dispose() } catch { /* 忽略 */ } }
        record.dispose = []
        surface.notify()
        throw error
      }
      surface.notify()
      log({ msg: 'plugin.enabled', id: record.manifest.id, disposers: record.dispose.length })
      return { enabled: true }
    },

    /** 停用：逆序注销。 */
    disable(id) {
      const record = plugins.get(String(id))
      if (!record) throw new Error(`没有这个插件：${id}`)
      if (!record.enabled) return { enabled: false, already: true }
      for (const dispose of record.dispose.reverse()) { try { dispose() } catch { /* 单个失败不阻塞其余 */ } }
      record.dispose = []
      record.enabled = false
      surface.notify()
      log({ msg: 'plugin.disabled', id: record.manifest.id })
      return { enabled: false }
    },

    list() {
      return [...plugins.values()].map((record) => ({
        id: record.manifest.id,
        version: record.manifest.version,
        enabled: record.enabled,
        tools: record.manifest.tools,
        slots: record.manifest.slots.map((s) => s.id),
      }))
    },
    has(id) { return plugins.has(String(id)) },
    manifestOf(id) { return plugins.get(String(id))?.manifest ?? null },
    /** 插件之间共享能力的只读视图（调试用）。 */
    shared,
  }
}
