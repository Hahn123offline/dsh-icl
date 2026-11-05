// 统一信号：所有跨边界的"消息"都走这里。
//
// 两条路由：
//   to:'model'  → 先过 gate（时间模块的纵向拦截），再交给 deliver（host 里接 delivery）
//   to:'plugin' → 事件总线，按 kind/from/tags 过滤，不排队、不持久化
//
// focus 不是路由，是信号上的一个字段（这条消息属于哪个注意力空间）。
// 旧版的 to:'focus' 从未被实现，已删掉——留着一个不投递的枚举比没有更坏。
//
// 设计约束：
//   · kind 是固定枚举，模型不能自己写
//   · from.plugin 必填，不允许匿名
//   · id 用于幂等；重复 id 丢弃并计数
//   · gate 拦下的信号**不占用 id**，放行后可以原样重试
//   · 没有 deliver 时 to:'model' 报错，不假装 accepted
//   · 过期信号直接拒绝，不进入模型

export const SIGNAL_KINDS = Object.freeze(['wake', 'goal', 'notice', 'content', 'event'])
export const SIGNAL_ROUTES = Object.freeze(['model', 'plugin'])
export const SIGNAL_TO = Object.freeze({ MODEL: 'model', PLUGIN: 'plugin' })

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
    return { ok: false, error: `未知的 to：${input.to}（focus 是字段，不是路由）` }
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

function normalizeFilter(filter = {}) {
  return {
    kind: filter?.kind ?? null,
    from: filter?.from ?? null,
    tags: filter?.tags == null ? null : [].concat(filter.tags).map(String),
  }
}

function matches(filter, signal) {
  if (filter.kind != null && !oneOf(signal.kind, [].concat(filter.kind))) return false
  if (filter.from != null && !oneOf(signal.from.plugin, [].concat(filter.from))) return false
  if (filter.tags != null && !filter.tags.some((t) => signal.tags.includes(t))) return false
  return true
}

export function createSignalService({ now = () => Date.now(), dedupeWindowMs = 86_400_000, log = () => {} } = {}) {
  const seen = new Map()
  const listeners = new Set()
  let gate = null
  let deliver = null
  let autoId = 0
  const counters = {
    accepted: 0, blocked: 0, deduped: 0, emitted: 0, failed: 0,
    expired: 0, delivered: 0, listenerErrors: 0, gateErrors: 0,
  }

  function prune(at) {
    for (const [id, stamp] of seen) {
      if (at - stamp > dedupeWindowMs) seen.delete(id)
    }
  }

  function fail(where, error) {
    counters.failed += 1
    try { log({ msg: 'signals.error', where, error: String(error?.message ?? error) }) } catch { /* 日志坏了不影响信号 */ }
  }

  /** 事件总线：filter 支持 {kind, from, tags}，返回注销函数。 */
  function on(filter, handler) {
    if (typeof handler !== 'function') throw new Error('signals.on 需要 handler')
    const entry = { filter: normalizeFilter(filter), handler }
    listeners.add(entry)
    return () => listeners.delete(entry)
  }

  function emit(signal) {
    let delivered = 0
    for (const entry of listeners) {
      if (!matches(entry.filter, signal)) continue
      try { entry.handler(signal); delivered += 1 } catch (error) {
        counters.listenerErrors += 1
        try { log({ msg: 'signals.listener-fail', filter: entry.filter, error: String(error?.message ?? error) }) } catch { /* ignore */ }
      }
    }
    counters.emitted += 1
    return delivered
  }

  function offer(input) {
    const checked = validateSignal(input)
    if (!checked.ok) { counters.failed += 1; return { accepted: false, error: checked.error } }
    const at = now()
    const signal = { ...checked.signal, createdAt: checked.signal.createdAt ?? at }
    if (signal.id == null) signal.id = `s-${++autoId}`
    prune(at)
    if (signal.expiresAt != null && signal.expiresAt <= at) {
      counters.expired += 1
      return { accepted: false, expired: true, id: signal.id }
    }
    if (seen.has(signal.id)) { counters.deduped += 1; return { accepted: false, deduped: true, id: signal.id } }

    let decision = { accept: true }
    if (typeof gate === 'function') {
      try { decision = gate(signal) ?? { accept: true } } catch (error) {
        counters.gateErrors += 1
        try { log({ msg: 'signals.gate-fail', error: String(error?.message ?? error) }) } catch { /* ignore */ }
        // gate 坏了不能把所有消息一起静音：fail-open，并在 stats 里留痕
        decision = { accept: true, gateError: true }
      }
    }
    if (!decision?.accept) {
      counters.blocked += 1
      // 关键：blocked 不写 seen。时间模块把内容抄进自己的积压队列；
      // 其它 gate 放行后，同一条信号可以原样重试。
      return { accepted: false, blocked: true, id: signal.id, reason: decision?.reason ?? 'gate' }
    }

    if (signal.to === SIGNAL_TO.PLUGIN) {
      seen.set(signal.id, at)
      const delivered = emit(signal)
      counters.accepted += 1
      return { accepted: true, id: signal.id, delivered }
    }

    if (typeof deliver !== 'function') {
      counters.failed += 1
      return { accepted: false, error: '没有投递器：signals.setDeliver 未接' }
    }
    try {
      const outcome = deliver(signal)
      if (outcome && typeof outcome.then === 'function') {
        outcome.catch((error) => fail('deliver-async', error))
      }
    } catch (error) {
      // 瞬时失败（会话正忙/下游抛错）：不占用 id，调用方可以重试
      fail('deliver', error)
      return { accepted: false, id: signal.id, error: String(error?.message ?? error) }
    }
    seen.set(signal.id, at)
    counters.accepted += 1
    counters.delivered += 1
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
    routes: () => [...SIGNAL_ROUTES],
    stats: () => ({ ...counters, listeners: listeners.size }),
    peekGate: () => gate,
  }
}
