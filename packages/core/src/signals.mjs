// 统一信号：所有跨边界的"消息"都走这里。
//
// 三条路由（见 docs/MESSAGE-MODEL.md）：
//   to:'model'  → 先过 gate（时间模块的纵向拦截），再交给 deliver（默认 delivery）
//   to:'plugin' → 事件总线，按 kind/from/tags 过滤，不排队、不持久化
//   to:'focus'  → 入座请求，由 gate 决定
//
// 设计约束：
//   · kind 是固定枚举，模型不能自己写
//   · from.plugin 必填，不允许匿名
//   · id 用于幂等；重复 id 丢弃并计数
//   · 不引入优先级；顺序由发送方与队列保证

export const SIGNAL_KINDS = Object.freeze(['wake', 'goal', 'notice', 'content', 'event'])
export const SIGNAL_ROUTES = Object.freeze(['model', 'plugin', 'focus'])
export const SIGNAL_TO = Object.freeze({ MODEL: 'model', PLUGIN: 'plugin', FOCUS: 'focus' })

function oneOf(value, list) {
  const values = Array.isArray(value) ? value : [value]
  return values.some((v) => list.includes(String(v)))
}

export function validateSignal(input) {
  if (!input || typeof input !== 'object') return { ok: false, error: '信号不是对象' }
  const fromPlugin = String(input.from?.plugin ?? '').trim()
  if (!fromPlugin) return { ok: false, error: '信号缺少 from.plugin' }
  if (!SIGNAL_KINDS.includes(String(input.kind))) {
    return { ok: false, error: `未知的 kind：${input.kind}（只允许 ${SIGNAL_KINDS.join('/')}）` }
  }
  if (!SIGNAL_ROUTES.includes(String(input.to ?? 'model'))) {
    return { ok: false, error: `未知的 to：${input.to}` }
  }
  const text = String(input.text ?? '')
  if (!text.trim() && !input.meta) return { ok: false, error: '信号既没有 text 也没有 meta' }
  return {
    ok: true,
    signal: {
      id: input.id == null ? null : String(input.id),
      from: { plugin: fromPlugin, activity: input.from?.activity == null ? null : String(input.from.activity) },
      kind: String(input.kind),
      to: String(input.to ?? 'model'),
      text,
      focus: input.focus == null ? null : String(input.focus),
      tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
      createdAt: Number(input.createdAt) > 0 ? Number(input.createdAt) : null,
      expiresAt: Number(input.expiresAt) > 0 ? Number(input.expiresAt) : null,
      meta: input.meta ?? null,
    },
  }
}

function matches(filter = {}, signal) {
  if (filter.kind != null && !oneOf(signal.kind, [].concat(filter.kind))) return false
  if (filter.from != null && !oneOf(signal.from.plugin, [].concat(filter.from))) return false
  if (filter.tags != null && !filter.tags.some((t) => signal.tags.includes(String(t)))) return false
  return true
}

export function createSignalService({ now = () => Date.now(), dedupeWindowMs = 86_400_000 } = {}) {
  const seen = new Map()
  const listeners = new Set()
  let gate = null
  let deliver = null
  let autoId = 0
  const counters = { accepted: 0, blocked: 0, deduped: 0, emitted: 0, failed: 0 }

  function prune(at) {
    for (const [id, stamp] of seen) {
      if (at - stamp > dedupeWindowMs) seen.delete(id)
    }
  }

  /** 事件总线：filter 支持 {kind, from, tags}，返回注销函数。 */
  function on(filter, handler) {
    if (typeof handler !== 'function') throw new Error('signals.on 需要 handler')
    const entry = { filter: filter ?? {}, handler }
    listeners.add(entry)
    return () => listeners.delete(entry)
  }

  function emit(signal) {
    let delivered = 0
    for (const entry of listeners) {
      if (!matches(entry.filter, signal)) continue
      try { entry.handler(signal); delivered += 1 } catch { /* 一个订阅者坏了不影响其他 */ }
    }
    counters.emitted += 1
    return delivered
  }

  function offer(input) {
    const checked = validateSignal(input)
    if (!checked.ok) { counters.failed += 1; return { accepted: false, error: checked.error } }
    const signal = { ...checked.signal, createdAt: checked.signal.createdAt ?? now() }
    if (signal.id == null) signal.id = `s-${++autoId}`
    prune(now())
    if (seen.has(signal.id)) { counters.deduped += 1; return { accepted: false, deduped: true, id: signal.id } }
    seen.set(signal.id, now())

    const decision = gate ? gate(signal) : { accept: true }
    if (!decision?.accept) {
      counters.blocked += 1
      return { accepted: false, blocked: true, id: signal.id, reason: decision?.reason ?? 'gate' }
    }
    if (signal.to === SIGNAL_TO.PLUGIN) {
      const delivered = emit(signal)
      counters.accepted += 1
      return { accepted: true, id: signal.id, delivered }
    }
    if (signal.to === SIGNAL_TO.MODEL && typeof deliver === 'function') {
      try { deliver(signal) } catch (error) {
        counters.failed += 1
        return { accepted: false, id: signal.id, error: String(error?.message ?? error) }
      }
    }
    counters.accepted += 1
    return { accepted: true, id: signal.id }
  }

  return {
    offer,
    emit: (input) => offer({ ...input, to: SIGNAL_TO.PLUGIN }),
    on,
    /** 时间模块接管纵向拦截；返回上一个 gate。 */
    setGate(fn) { const prev = gate; gate = typeof fn === 'function' ? fn : null; return prev },
    /** 默认投递器（host 里接 delivery）。 */
    setDeliver(fn) { const prev = deliver; deliver = typeof fn === 'function' ? fn : null; return prev },
    kinds: () => [...SIGNAL_KINDS],
    stats: () => ({ ...counters, listeners: listeners.size }),
    peekGate: () => gate,
  }
}
