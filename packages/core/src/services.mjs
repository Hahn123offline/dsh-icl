// 五个服务：工具面、提示词段、focus、投递、模型插槽。
//
// 每个服务都只做一件事，并且**注册即返回注销器**——插件卸载就是按顺序调这些注销器。
// 这是"运行时动态工具面"的全部实现，不需要任何魔法。

import { resolvePierce } from './contracts.mjs'

/* ───────────────────────────── 工具面 ───────────────────────────── */

/**
 * 把插件交上来的工具定义拼成最终描述。
 *
 * 为什么要拼：描述是直接进 DSH 提示词的，不能让每个插件各写各的；
 * 结构化字段只是"拼装所需的最小辅助"，详细说明仍然可以是一段人写的长文字。
 * 预算守卫：不能又长回旧项目那种每个工具几千字。
 */
export const TOOL_TEXT_LIMITS = Object.freeze({ perTool: 900, index: 1200 })

export function composeToolDescription(definition, { maxChars = TOOL_TEXT_LIMITS.perTool } = {}) {
  // summary 是一句话用途，description 是可选的详细补充；
  // 两者都有时先用途、再细节，不能把用途丢了。
  const head = [definition?.summary, definition?.description]
    .map((x) => (x == null ? '' : String(x).trim()))
    .filter(Boolean)
    .join(' ')
  const bullets = []
  for (const [label, items] of [['Use when', definition?.when], ['Avoid when', definition?.avoid], ['Safety', definition?.safety]]) {
    const list = (Array.isArray(items) ? items : items ? [items] : []).map((x) => String(x).trim()).filter(Boolean)
    if (list.length) bullets.push(`${label}: ${list.join('; ')}.`)
  }
  let text = [head, ...bullets].filter(Boolean).join(' ')
  if (text.length <= maxChars) return text

  // 超预算：先砍结尾的要求行，再截正文；不会把它变成空字符串。
  while (bullets.length && (head + ' ' + bullets.join(' ')).length > maxChars) bullets.pop()
  text = [head, ...bullets].filter(Boolean).join(' ')
  if (text.length > maxChars) text = text.slice(0, Math.max(40, maxChars - 1)).trimEnd() + '…'
  return text
}

export function createToolRegistry({ onChange = () => {} } = {}) {
  const tools = new Map()
  let version = 0
  return {
    /** @returns {() => void} 注销器 */
    register(definition) {
      const name = String(definition?.name ?? '')
      if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`工具名不合法：${name || '(空)'}`)
      if (tools.has(name)) throw new Error(`工具已存在：${name}`)
      if (typeof definition.execute !== 'function') throw new Error(`${name} 缺少 execute`)
      const summary = String(definition.summary ?? definition.description ?? '').trim().split(/(?<=[.!?])\s/)[0] ?? ''
      const composed = {
        ...definition,
        name,
        summary: summary.slice(0, 160),
        description: composeToolDescription(definition),
      }
      tools.set(name, composed)
      version += 1
      onChange({ type: 'registered', name })
      return () => {
        if (!tools.delete(name)) return
        version += 1
        onChange({ type: 'unregistered', name })
      }
    },
    list() { return [...tools.values()] },
    names() { return [...tools.keys()] },
    has(name) { return tools.has(String(name)) },
    version() { return version },
    /** 给模型看的工具索引：只有启用中的工具，一行一个。 */
    index({ maxChars = TOOL_TEXT_LIMITS.index } = {}) {
      const rows = [...tools.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((t) => `- ${t.name}: ${t.summary}`)
      let text = rows.join('\n')
      if (text.length > maxChars) {
        const lines = []
        let used = 0
        for (const row of rows) {
          if (used + row.length + 1 > maxChars) break
          lines.push(row)
          used += row.length + 1
        }
        text = lines.join('\n') + `\n…（还有 ${rows.length - lines.length} 个工具）`
      }
      return text
    },
  }
}

/* ───────────────────────────── 提示词 ───────────────────────────── */

export function createPromptService() {
  const sections = new Map()
  const turnProviders = []
  return {
    /**
     * 注册一个注入段。text 可以是字符串或函数（每次装配求值）。
     * @returns {() => void} 注销器
     */
    section({ name, order = 50, text, when = null } = {}) {
      const key = String(name ?? '')
      if (!/^[a-z][a-z0-9:_-]*$/i.test(key)) throw new Error(`提示词段名不合法：${key || '(空)'}`)
      if (sections.has(key)) throw new Error(`提示词段已存在：${key}`)
      if (typeof text !== 'string' && typeof text !== 'function') throw new Error(`${key} 的 text 必须是字符串或函数`)
      sections.set(key, { name: key, order: Number(order) || 50, text, when })
      return () => { sections.delete(key) }
    },
    names() { return [...sections.keys()] },

    /**
     * 每轮临时上下文：用户消息进来时让插件贡献一小段，
     * 由核心统一装配、统一限长、统一注入——插件不得自己往对话里塞东西。
     */
    onTurn(provider) {
      if (typeof provider !== 'function') throw new Error('onTurn 需要一个函数')
      turnProviders.push(provider)
      return () => {
        const i = turnProviders.indexOf(provider)
        if (i >= 0) turnProviders.splice(i, 1)
      }
    },

    /** 装配本轮上下文（带总预算）。 */
    async turnText({ sessionId = null, message = '', now = Date.now(), maxChars = 800 } = {}) {
      const pieces = []
      for (const provider of turnProviders) {
        try {
          const value = await provider({ sessionId, message, now })
          if (value == null) continue
          const body = String(value).trim()
          if (body) pieces.push(body)
        } catch { /* 单个提供者坏了不影响对话 */ }
      }
      let text = pieces.join('\n')
      if (text.length > maxChars) text = text.slice(0, Math.max(20, maxChars - 1)).trimEnd() + '…'
      return text
    },
    /** 装配：按 order 排序，跳过 when()===false 的段。 */
    assemble(ctx = {}) {
      const ordered = [...sections.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
      const out = []
      for (const section of ordered) {
        try {
          if (typeof section.when === 'function' && !section.when(ctx)) continue
          const value = typeof section.text === 'function' ? section.text(ctx) : section.text
          if (value == null) continue
          const body = String(value).trim()
          if (body) out.push(body)
        } catch { /* 单个段坏了不影响整体 */ }
      }
      return out.join('\n\n')
    },
  }
}

/* ───────────────────────────── focus ───────────────────────────── */

export function createFocusService({ now = () => Date.now() } = {}) {
  const leases = new Map()
  let seq = 0
  function alive(lease, at) { return lease && (lease.expiresAt == null || lease.expiresAt > at) }
  return {
    /**
     * 申请一个 focus。插件可以自己申请（进世界/进群），模型工具也能申请。
     * @returns {{id:string, label:string, release:() => void}}
     */
    enter({ label, owner = null, reason = '', ttlMs = null, pierce = null, visible = true } = {}) {
      const key = String(label ?? '').trim()
      if (!key) throw new Error('focus.label 必填')
      const at = now()
      const id = `focus-${++seq}`
      const lease = {
        id,
        label: key,
        owner: owner == null ? null : String(owner),
        reason: String(reason ?? ''),
        since: at,
        expiresAt: ttlMs == null ? null : at + Math.max(1000, Number(ttlMs) || 0),
        pierce: pierce && typeof pierce === 'object' ? { ...pierce } : {},
        visible: visible !== false,
      }
      leases.set(id, lease)
      return { ...lease, release: () => { leases.delete(id) } }
    },
    /** 当前 focus：最新且未过期的那个。 */
    current() {
      const at = now()
      let best = null
      for (const lease of leases.values()) {
        if (!alive(lease, at)) continue
        if (!best || lease.since >= best.since) best = lease
      }
      return best
    },
    /** 用来判断"别处的事能不能打断她"。 */
    canPierce(fromLabel, opts = {}) {
      const cur = this.current()
      if (!cur) return { allowed: true, level: 'always', pattern: '(no-focus)' }
      return resolvePierce(cur.pierce, fromLabel, opts)
    },
    list() { const at = now(); return [...leases.values()].filter((l) => alive(l, at)) },
  }
}

/* ───────────────────────────── 投递 ───────────────────────────── */

/**
 * 统一投递：插件**只能**往这里 push，绝不直接对会话说话。
 *
 * 保证：
 *   · exactlyOnce 的条目按 (plugin, activity, seq) 去重，重复 push 返回 deduped
 *   · 只有 ack 之后才算送达并推进水位；nack 留在队列里退避重试
 *   · 同一个 batchKey 的条目在 drain 时合并成一批
 */
export function createDeliveryService({ now = () => Date.now(), maxAttempts = 5 } = {}) {
  const watermark = new Map()      // `${plugin}|${activity}` -> seq
  const queue = []                 // 待投递条目
  const inflight = new Map()       // batchId -> 条目
  let seq = 0

  const keyOf = (source) => `${source?.plugin ?? ''}|${source?.activity ?? ''}`
  // 第一次失败立即重试（往往是会话正忙），之后才退避。
  const backoff = (attempts) => (attempts <= 1 ? 0 : Math.min(60_000, 500 * 2 ** (attempts - 2)))

  return {
    push({ to = 'session', channel = 'conversation', source = {}, content = {}, batchKey = null, exactlyOnce = true } = {}) {
      const seqNo = Number(source.seq)
      if (exactlyOnce && Number.isFinite(seqNo) && seqNo > 0) {
        const k = keyOf(source)
        const done = watermark.get(k) ?? 0
        if (seqNo <= done) return { accepted: false, deduped: true }
        // 还在队列里/送达中的同一条也要去重，否则两次 push 会变两段。
        const dup = [...queue, ...[...inflight.values()].flat()].some((it) => it.exactlyOnce && keyOf(it.source) === k && it.source.seq === seqNo)
        if (dup) return { accepted: false, deduped: true }
      }
      const item = {
        id: `d-${++seq}`,
        to: String(to),
        channel: String(channel),
        source: { plugin: String(source.plugin ?? ''), activity: String(source.activity ?? ''), seq: Number.isFinite(seqNo) ? seqNo : null },
        content: { text: String(content.text ?? ''), images: content.images ?? [] },
        batchKey: batchKey == null ? `${source.plugin ?? ''}:${source.activity ?? ''}:${channel}` : String(batchKey),
        exactlyOnce: exactlyOnce !== false,
        attempts: 0,
        nextAt: now(),
      }
      queue.push(item)
      return { accepted: true, id: item.id }
    },

    /** 取出可以投递的批次（不改状态，ack/nack 才改）。 */
    drain(to = null) {
      const at = now()
      const ready = queue.filter((item) => item.nextAt <= at && (to == null || item.to === String(to)))
      const groups = new Map()
      for (const item of ready) {
        const key = `${item.to}|${item.batchKey}`
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(item)
      }
      const batches = []
      for (const [key, items] of groups) {
        const batchId = `b-${++seq}`
        inflight.set(batchId, items)
        for (const item of items) { const i = queue.indexOf(item); if (i >= 0) queue.splice(i, 1) }
        batches.push({
          id: batchId,
          key,
          to: items[0].to,
          channel: items[0].channel,
          entries: items.map((item) => ({ source: item.source, content: item.content })),
          text: items.map((item) => item.content.text).filter(Boolean).join('\n'),
          images: items.flatMap((item) => item.content.images ?? []),
        })
      }
      return batches
    },

    /** 送达：推进水位、移除批次。 */
    ack(batchId) {
      const items = inflight.get(batchId)
      if (!items) return { ok: false, reason: 'unknown-batch' }
      for (const item of items) {
        if (!item.exactlyOnce || !Number.isFinite(item.source.seq)) continue
        const key = keyOf(item.source)
        const cur = watermark.get(key) ?? 0
        if (item.source.seq > cur) watermark.set(key, item.source.seq)
      }
      inflight.delete(batchId)
      return { ok: true, count: items.length }
    },

    /** 失败：留在队列里，退避重试。 */
    nack(batchId, error = null) {
      const items = inflight.get(batchId)
      if (!items) return { ok: false, reason: 'unknown-batch' }
      inflight.delete(batchId)
      const at = now()
      for (const item of items) {
        item.attempts += 1
        item.lastError = error == null ? null : String(error)
        if (item.attempts >= maxAttempts) { item.dropped = true; continue }
        item.nextAt = at + backoff(item.attempts)
        queue.push(item)
      }
      return { ok: true }
    },

    watermarkOf(plugin, activity) { return watermark.get(`${plugin}|${activity}`) ?? 0 },
    pendingCount() { return queue.length },
    inflightCount() { return inflight.size },
  }
}

/* ───────────────────────────── 模型插槽 ───────────────────────────── */

/**
 * 模型插槽：插件只声明"我需要什么样的模型"，不写模型名、不写地址、不自己调服务。
 * 模型管理插件把符合形状的供应商接上（bind），调用一律走 slots.call。
 */
export function createSlotRegistry() {
  const slots = new Map()
  const bindings = new Map()
  const providers = new Map()
  const listeners = new Set()
  const changed = () => { for (const fn of listeners) { try { fn() } catch { /* 忽略 */ } } }

  function shapeSatisfies(requires = {}, shape = {}) {
    for (const [key, value] of Object.entries(requires ?? {})) {
      if (value == null) continue
      if (shape?.[key] !== value) return false
    }
    return true
  }

  function match(slot) {
    for (const provider of providers.values()) {
      if (provider.kind !== slot.kind) continue
      if (!shapeSatisfies(slot.requires, provider.shape)) continue
      return provider
    }
    return null
  }

  return {
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn) },

    declare(slot) {
      const id = String(slot?.id ?? '')
      if (!id) throw new Error('插槽缺少 id')
      if (slots.has(id)) throw new Error(`插槽已存在：${id}`)
      const entry = {
        id,
        kind: String(slot.kind ?? 'chat'),
        requires: { ...(slot.requires ?? {}) },
        meta: { ...(slot.meta ?? {}) },
        owner: slot.owner ?? null,
      }
      slots.set(id, entry)
      changed()
      return () => { slots.delete(id); bindings.delete(id); changed() }
    },

    /** 模型管理插件用它登记"我能提供什么形状的模型"。 */
    registerProvider(provider) {
      const id = String(provider?.id ?? '')
      if (!id) throw new Error('provider 缺少 id')
      if (typeof provider.call !== 'function') throw new Error(`provider ${id} 缺少 call`)
      if (providers.has(id)) throw new Error(`provider 已存在：${id}`)
      providers.set(id, {
        id,
        kind: String(provider.kind ?? 'chat'),
        shape: { ...(provider.shape ?? {}) },
        call: provider.call,
        meta: { ...(provider.meta ?? {}) },
      })
      return () => { providers.delete(id); changed() }
    },

    /** 给每个未绑定的插槽找第一个形状匹配的供应商。返回绑定了哪些。 */
    autoBind() {
      const bound = []
      for (const slot of slots.values()) {
        if (bindings.has(slot.id)) continue
        const provider = match(slot)
        if (!provider) continue
        bindings.set(slot.id, { provider: provider.id, call: provider.call, kind: slot.kind })
        bound.push({ slot: slot.id, provider: provider.id })
      }
      if (bound.length) changed()
      return bound
    },

    bind(id, binding) {
      if (!slots.has(id)) throw new Error(`没有这个插槽：${id}`)
      if (typeof binding?.call !== 'function') throw new Error(`绑定 ${id} 需要 call`)
      bindings.set(id, { ...binding, boundAt: Date.now() })
      changed()
    },

    resolve(id) { return bindings.get(id) ?? null },
    require(id) {
      const bound = bindings.get(id)
      if (!bound) throw new Error(`插槽 ${id} 还没有绑定模型`)
      return bound
    },
    /** 统一调用：插件只认插槽，不认服务。 */
    async call(id, request) {
      const bound = bindings.get(id)
      if (!bound) {
        const error = new Error(`插槽 ${id} 还没有绑定模型`)
        error.code = 'SLOT_UNBOUND'
        throw error
      }
      return bound.call(request)
    },
    unmatched() {
      return [...slots.values()].filter((s) => !bindings.has(s.id)).map((s) => ({ id: s.id, kind: s.kind, requires: s.requires }))
    },
    providers() { return [...providers.values()].map((p) => ({ id: p.id, kind: p.kind, shape: p.shape })) },
    list() { return [...slots.values()].map((s) => ({ ...s, binding: bindings.get(s.id) ?? null })) },
  }
}
