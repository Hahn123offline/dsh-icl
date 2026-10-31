// 五个服务：工具面、提示词段、focus、投递、模型插槽。
//
// 每个服务都只做一件事，并且**注册即返回注销器**——插件卸载就是按顺序调这些注销器。
// 这是"运行时动态工具面"的全部实现，不需要任何魔法。

import { resolvePierce } from './contracts.mjs'

/* ───────────────────────────── 工具面 ───────────────────────────── */

export function createToolRegistry({ onChange = () => {} } = {}) {
  const tools = new Map()
  let version = 0
  return {
    /** @returns {() => void} 注销器 */
    register(definition) {
      const name = String(definition?.name ?? '')
      if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`工具名不合法：${name || '(空)'}`)
      if (tools.has(name)) throw new Error(`工具已存在：${name}`)
      tools.set(name, definition)
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
  }
}

/* ───────────────────────────── 提示词 ───────────────────────────── */

export function createPromptService() {
  const sections = new Map()
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

export function createSlotRegistry() {
  const slots = new Map()
  const bindings = new Map()
  return {
    /** 插件声明需求（不绑定）。 */
    declare(slot) {
      const id = String(slot?.id ?? '')
      if (!id) throw new Error('插槽缺少 id')
      if (slots.has(id)) throw new Error(`插槽已存在：${id}`)
      const entry = { id, kind: String(slot.kind ?? 'chat'), needs: slot.needs ?? [], dim: slot.dim ?? null, owner: slot.owner ?? null }
      slots.set(id, entry)
      return () => { slots.delete(id); bindings.delete(id) }
    },
    /** 模型管理插件绑定。 */
    bind(id, binding) {
      if (!slots.has(id)) throw new Error(`没有这个插槽：${id}`)
      bindings.set(id, { ...binding, boundAt: Date.now() })
    },
    resolve(id) { return bindings.get(id) ?? null },
    require(id) {
      const bound = bindings.get(id)
      if (!bound) throw new Error(`插槽 ${id} 还没有绑定模型`)
      return bound
    },
    list() { return [...slots.values()].map((s) => ({ ...s, binding: bindings.get(s.id) ?? null })) },
  }
}
