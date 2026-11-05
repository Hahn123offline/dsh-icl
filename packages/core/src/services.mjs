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
  if (text.length > maxChars) text = maxChars <= 1 ? '…'.slice(0, maxChars) : text.slice(0, Math.max(0, maxChars - 1)).trimEnd() + '…'
  return text
}


/* ───────────────────────────── raw sources ───────────────────────────── */

/**
 * 原文层不是"再存一份"，而是"按需回原始日志里查"。
 * DSH 会话日志本身就是原文；插件只提供"按字面查一句话"的能力。
 */
export function createRawSourceRegistry({ onError = null } = {}) {
  const sources = new Map()
  const report = (where, error) => { try { onError?.(where, error) } catch { /* 上报者自己坏了 */ } }
  return {
    register({ id, search, list } = {}) {
      const key = String(id ?? '')
      if (!key) throw new Error('raw source 需要 id')
      if (typeof search !== 'function') throw new Error(`${key} 缺少 search`)
      sources.set(key, { id: key, search, list: typeof list === 'function' ? list : null })
      return () => { sources.delete(key) }
    },
    ids() { return [...sources.keys()] },
    /** 列出某个时间段的原文（供采集用）。 */
    async list({ since = null, until = null, limit = 500 } = {}) {
      const out = []
      for (const source of sources.values()) {
        if (!source.list) continue
        try {
          const rows = await source.list({ since, until, limit })
          for (const row of rows ?? []) out.push({ ...row, source: source.id })
        } catch (error) { report(`raw.list:${source.id}`, error) }
      }
      return out.slice(0, limit)
    },

    /** 按顺序问每个来源，返回命中的原文片段。 */
    async search({ query, limit = 2 } = {}) {
      const hits = []
      for (const source of sources.values()) {
        try {
          const rows = await source.search({ query, limit })
          for (const row of rows ?? []) hits.push({ ...row, source: source.id })
        } catch (error) { report(`raw.search:${source.id}`, error) }
      }
      return hits.slice(0, Math.max(1, Number(limit) || 2))
    },
  }
}


/* ───────────────────────────── context ───────────────────────────── */

/**
 * 上下文契约：让插件能"看到本轮历史"，并在装配前贡献/改写上下文。
 *
 * 三件事，别的都不做：
 *   1. history   —— 从适配器提供的来源读本轮历史
 *   2. onAssemble —— 注册一个装配前策略（压缩、摘要、守卫都在这里）
 *   3. onCompact  —— 适配器支持替换历史时，注册压缩实现（旧实现可直接接）
 */
export function createContextService({ onError = null } = {}) {
  let historySource = null
  const assemblers = new Map()
  const compactors = new Map()
  const report = (where, error) => { try { onError?.(where, error) } catch { /* ignore */ } }
  return {
    provideHistory(fn) {
      if (typeof fn !== 'function') throw new Error('history source \u9700\u8981\u4e00\u4e2a\u51fd\u6570')
      historySource = fn
      return () => { if (historySource === fn) historySource = null }
    },
    async history({ sessionId = null, limit = 50 } = {}) {
      if (!historySource) return []
      return (await historySource({ sessionId, limit })) ?? []
    },
    /** \u6ce8\u518c\u88c5\u914d\u524d\u7b56\u7565\uff1bapply \u8fd4\u56de\u8981\u6ce8\u5165\u7684\u6587\u5b57\u6216 null\u3002 */
    onAssemble({ name, order = 50, apply } = {}) {
      const key = String(name ?? '')
      if (!key || typeof apply !== 'function') throw new Error('onAssemble \u9700\u8981 name \u4e0e apply')
      assemblers.set(key, { name: key, order: Number(order) || 50, apply })
      return () => { assemblers.delete(key) }
    },
    async assemble({ sessionId = null, message = '', history = null, maxChars = 1200 } = {}) {
      const h = history ?? await this.history({ sessionId })
      const ordered = [...assemblers.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
      const pieces = []
      for (const a of ordered) {
        try {
          const value = await a.apply({ sessionId, message, history: h })
          const body = value == null ? '' : String(value).trim()
          if (body) pieces.push(body)
        } catch (error) { report(`context.assemble:${a.name}`, error) }
      }
      let text = pieces.join('\n')
      if (text.length > maxChars) text = maxChars <= 1 ? '\u2026'.slice(0, maxChars) : text.slice(0, Math.max(0, maxChars - 1)).trimEnd() + '\u2026'
      return text
    },
    /** \u6ce8\u518c\u538b\u7f29\u5b9e\u73b0\uff08\u7531\u9002\u914d\u5668\u63d0\u4f9b\u66ff\u6362\u5386\u53f2\u7684\u80fd\u529b\uff09\u3002 */
    onCompact({ id, compact } = {}) {
      const key = String(id ?? '')
      if (!key || typeof compact !== 'function') throw new Error('onCompact \u9700\u8981 id \u4e0e compact')
      compactors.set(key, { id: key, compact })
      return () => { compactors.delete(key) }
    },
    compactors() { return [...compactors.keys()] },
    async compact(input = {}) {
      const first = [...compactors.values()][0]
      if (!first) return { ok: false, error: 'no-compactor' }
      try { return await first.compact(input) } catch (error) {
        report(`context.compact:${first.id}`, error)
        return { ok: false, error: String(error?.message ?? error) }
      }
    },
  }
}


/* ───────────────────────────── tool surface ───────────────────────────── */

/**
 * 工具面：把"已启用插件声明的工具"整理成可注入的集合。
 * 它不注册工具（那是 tools 的事），只回答"现在应该给模型看哪些"。
 */
export function createToolSurface({ tools, plugins, presets = null, onError = null }) {
  const listeners = new Set()
  const notify = () => {
    for (const fn of listeners) {
      try { fn() } catch (error) { try { onError?.(`surface.listener`, error) } catch { /* ignore */ } }
    }
  }
  return {
    /** 工具 → 所属插件。 */
    owners() {
      const map = new Map()
      for (const p of plugins()) {
        for (const slug of p.manifest?.tools ?? []) map.set(slug, p.id)
      }
      return map
    },
    /** @returns {{name,description,parameters,plugin}[]} */
    list({ preset = null } = {}) {
      const owners = this.owners()
      const enabled = new Set(plugins().filter((p) => p.enabled).map((p) => p.id))
      // 预设来自我们自己的服务；null 表示"全部插件"
      const allowed = preset ?? (presets ? presets.active() : null)
      const presetDef = allowed && allowed !== 'default' ? presets?.list().find((x) => x.id === allowed) : null
      // 预设可用 allow 或 plugins 声明允许的插件；两者都为 null 表示"全部"
      const allowSpec = presetDef ? (presetDef.allow ?? presetDef.plugins ?? null) : null
      const allow = allowSpec == null ? null : new Set(allowSpec)
      return tools.list()
        .filter((def) => {
          const owner = owners.get(def.name)
          if (!owner || !enabled.has(owner)) return false
          if (!allow) return true
          return allow.has(owner)
        })
        .map((def) => ({ ...def, plugin: owners.get(def.name) }))
    },
    names(options = {}) { return this.list(options).map((t) => t.name) },
    /** 哪些插件贡献了工具（用于面板/调试）。 */
    summary() {
      return plugins()
        .filter((p) => p.enabled && (p.manifest?.tools ?? []).length)
        .map((p) => ({ plugin: p.id, preset: p.manifest?.preset ?? null, tools: p.manifest.tools }))
    },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    notify,
  }
}


/* ───────────────────────────── presets ───────────────────────────── */

/**
 * 我们自己的工具面预设。和 DSH 的 preset 无关——那个在会话创建时绑死，
 * 这里可以运行中切换，插件启停即可兑现。
 *
 * 规则：插件 manifest 没写 presets 的，属于所有预设（默认全量）。
 */
export function createPresetService({ plugins } = {}) {
  const presets = new Map()
  let activeId = 'default'
  presets.set('default', { id: 'default', label: '默认（全部插件）', allow: null })

  function pluginIds(presetId) {
    const preset = presets.get(String(presetId))
    if (!preset) return null
    if (preset.allow === null) return null // null = 全部
    const allow = new Set(preset.allow)
    return [...plugins()]
      .filter((p) => allow.has(p.id))
      .filter((p) => {
        const declared = p.manifest?.presets
        return !declared || declared.includes(presetId)
      })
      .map((p) => p.id)
  }

  return {
    list() { return [...presets.values()].map((p) => ({ ...p, plugins: pluginIds(p.id) })) },
    active() { return activeId },
    use(id) {
      if (!presets.has(String(id))) throw new Error(`没有这个预设：${id}`)
      activeId = String(id)
      return { active: activeId }
    },
    define({ id, label = null, allow = null } = {}) {
      const key = String(id ?? '')
      if (!key) throw new Error('预设需要 id')
      presets.set(key, { id: key, label: label ?? key, allow: allow == null ? null : allow.map(String) })
      return { id: key }
    },
    /** 当前预设允许的插件；null 表示全部。 */
    allowed() { return pluginIds(activeId) },
  }
}

export function createToolRegistry({ onChange = () => {}, stampTime = null } = {}) {
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
      // 每次回结果附一句当前时间（旧版本的轻量世界状态）
      const rawExecute = definition.execute
      const stamped = typeof rawExecute === 'function'
        ? async (input) => {
            const out = await rawExecute(input)
            if (out && typeof out === 'object' && typeof out.text === 'string' && stampTime) {
              out.text += `\n（现在 ${stampTime()} ）`
            }
            return out
          }
        : rawExecute
      const composed = {
        ...definition,
        name,
        execute: stamped,
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
    index({ maxChars = TOOL_TEXT_LIMITS.index, defs = null } = {}) {
      const rows = [...(defs ?? [...tools.values()])]
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

export function createPromptService({ onError = null } = {}) {
  const sections = new Map()
  const turnProviders = []
  const report = (where, error) => { try { onError?.(where, error) } catch { /* ignore */ } }
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
        } catch (error) { report('prompt.turnText', error) }
      }
      let text = pieces.join('\n')
      if (text.length > maxChars) text = maxChars <= 1 ? '…'.slice(0, maxChars) : text.slice(0, Math.max(0, maxChars - 1)).trimEnd() + '…'
      return text
    },
    /**
     * 装配：按 order 排序，跳过 when()===false 的段。
     *
     * `range` 是给前缀缓存用的**可选**切分：给 minOrder/maxOrder 就只取落在区间里的段。
     * 默认不传 = 全部段，旧调用完全不变。
     * 为什么要这个：本地模型引擎（NInfer/KVMem）按前缀保留会话，系统提示词只要有
     * 一个字节变化就整条重算；所以 DSH 桥要把"静态段"（人格/仿真，order < 800）和
     * "易变事实段"（时间/世界/focus/MC 状态，order ≥ 800）拆到两个通道去。
     */
    assemble(ctx = {}, range = null) {
      const minOrder = range?.minOrder ?? -Infinity
      const maxOrder = range?.maxOrder ?? Infinity
      const ordered = [...sections.values()]
        .filter((section) => section.order >= minOrder && section.order <= maxOrder)
        .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
      const out = []
      for (const section of ordered) {
        try {
          if (typeof section.when === 'function' && !section.when(ctx)) continue
          const value = typeof section.text === 'function' ? section.text(ctx) : section.text
          if (value == null) continue
          const body = String(value).trim()
          if (body) out.push(body)
        } catch (error) { report(`prompt.assemble:${section.name}`, error) }
      }
      return out.join('\n\n')
    },
  }
}

/* ───────────────────────────── focus ───────────────────────────── */

export function createFocusService({ now = () => Date.now() } = {}) {
  const leases = new Map()
  const backlog = new Map()
  const listeners = new Set()
  const backlogListeners = new Set()
  let seq = 0
  function alive(lease, at) { return lease && (lease.expiresAt == null || lease.expiresAt > at) }
  function changed() { for (const fn of listeners) { try { fn() } catch { /* 单个监听器坏了不影响焦点 */ } } }
  function backlogChanged() { for (const fn of backlogListeners) { try { fn() } catch { /* ignore */ } } }
  function withRelease(lease) {
    return {
      ...lease,
      release: () => {
        if (!leases.delete(lease.id)) return
        changed()
      },
    }
  }

  return {
    /**
     * 申请一个 focus。插件可以自己申请（进世界/进群），模型工具也能申请。
     * @returns {{id:string, label:string, release:() => void}}
     */
    enter({ label, owner = null, reason = '', ttlMs = null, pierce = null, visible = true, title = null, kind = 'task', interruptible = true, goal = null, exitCondition = null, expectedMinutes = null } = {}) {
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
        title: title == null ? key : String(title),
        kind: String(kind ?? 'task'),
        interruptible: interruptible !== false,
        goal: goal == null ? null : String(goal),
        exitCondition: exitCondition == null ? null : String(exitCondition),
        expectedMinutes: Number.isFinite(Number(expectedMinutes)) ? Number(expectedMinutes) : null,
      }
      leases.set(id, lease)
      changed()
      return withRelease(lease)
    },
    /** 当前 focus：最新且未过期的那个。 */
    current() {
      const at = now()
      let best = null
      for (const lease of leases.values()) {
        if (!alive(lease, at)) continue
        if (!best || lease.since >= best.since) best = lease
      }
      return best ? withRelease(best) : null
    },
    /** 用来判断"别处的事能不能打断她"。 */
    canPierce(fromLabel, opts = {}) {
      const cur = this.current()
      if (!cur) return { allowed: true, level: 'always', pattern: '(no-focus)' }
      return resolvePierce(cur.pierce, fromLabel, opts)
    },
    /**
     * 投递裁决：别处的事该不该现在进模型。
     * 闹钟（time）与 admin 永远放行；当前 focus 不可打断时其余一律进积压。
     */
    admit(signal = {}) {
      const cur = this.current()
      if (!cur) return { deliver: true, reason: 'no-focus' }
      const from = String(signal.from?.plugin ?? '')
      const tags = Array.isArray(signal.tags) ? signal.tags.map(String) : []
      const privileged = from === 'time' || tags.includes('admin') || tags.includes('alarm')
      if (privileged) return { deliver: true, reason: 'privileged', focus: cur.label }
      if (cur.interruptible === false) return { deliver: false, reason: 'focus-sacred', focus: cur.label }
      const label = signal.focus == null ? '' : String(signal.focus)
      if (label && label === cur.label) return { deliver: true, reason: 'same-focus', focus: cur.label }
      const verdict = resolvePierce(cur.pierce, label, { mention: tags.includes('mention') || tags.includes('at') })
      return verdict.allowed
        ? { deliver: true, reason: verdict.level, focus: cur.label, pattern: verdict.pattern }
        : { deliver: false, reason: 'focus-pierce', focus: cur.label, pattern: verdict.pattern }
    },
    /** 被 focus 拦下的信号进积压，按命名空间计数。 */
    defer(signal = {}) {
      const key = String(signal.focus ?? '(ambient)')
      const at = now()
      const row = backlog.get(key) ?? { focus: key, count: 0, oldestAt: at, lastAt: at, lastText: '', items: [] }
      row.count += 1
      row.lastAt = at
      row.lastText = String(signal.text ?? '').slice(0, 200)
      row.items.push({ plugin: String(signal.from?.plugin ?? ''), text: String(signal.text ?? '').slice(0, 200), at })
      if (row.items.length > 20) row.items.shift()
      backlog.set(key, row)
      backlogChanged()
      return { queued: true, focus: key, count: row.count }
    },
    /** 当前积压（按命名空间）。 */
    backlog() { return [...backlog.values()].map((row) => ({ ...row, items: row.items.map((item) => ({ ...item })) })) },
    /** 取走并清空积压；焦点释放时由宿主投递给模型。 */
    drainBacklog() {
      const rows = this.backlog()
      backlog.clear()
      return rows
    },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    /** 积压变化单独通知：宿主只关心"焦点变了"，持久化两边都要。 */
    onBacklog(fn) { backlogListeners.add(fn); return () => backlogListeners.delete(fn) },
    list() { const at = now(); return [...leases.values()].filter((l) => alive(l, at)).map(withRelease) },
    /** 可落盘的快照：租约（不含 release 函数）+ 积压。 */
    snapshot() {
      return {
        version: 1,
        leases: [...leases.values()].map(({ release, ...rest }) => ({ ...rest })),
        backlog: this.backlog(),
      }
    },
    /** 从快照恢复；过期租约丢弃。恢复本身会触发一次 onChange。 */
    restore(data = {}) {
      leases.clear()
      backlog.clear()
      for (const row of Array.isArray(data.leases) ? data.leases : []) {
        if (!row?.label || !alive(row, now())) continue
        const id = String(row.id ?? `focus-${++seq}`)
        const match = /^focus-(\d+)$/.exec(id)
        if (match) seq = Math.max(seq, Number(match[1]))
        leases.set(id, {
          id,
          label: String(row.label),
          owner: row.owner == null ? null : String(row.owner),
          reason: String(row.reason ?? ''),
          since: Number(row.since) || now(),
          expiresAt: row.expiresAt == null ? null : Number(row.expiresAt),
          pierce: row.pierce && typeof row.pierce === 'object' ? { ...row.pierce } : {},
          visible: row.visible !== false,
          title: row.title == null ? String(row.label) : String(row.title),
          kind: String(row.kind ?? 'task'),
          interruptible: row.interruptible !== false,
          goal: row.goal == null ? null : String(row.goal),
          exitCondition: row.exitCondition == null ? null : String(row.exitCondition),
          expectedMinutes: Number.isFinite(Number(row.expectedMinutes)) ? Number(row.expectedMinutes) : null,
        })
      }
      for (const row of Array.isArray(data.backlog) ? data.backlog : []) {
        if (!row?.focus) continue
        backlog.set(String(row.focus), {
          focus: String(row.focus),
          count: Math.max(0, Number(row.count) || 0),
          oldestAt: Number(row.oldestAt) || now(),
          lastAt: Number(row.lastAt) || now(),
          lastText: String(row.lastText ?? ''),
          items: Array.isArray(row.items) ? row.items.slice(-20).map((item) => ({ ...item })) : [],
        })
      }
      // 恢复是"加载"，不是"焦点变化"：不通知宿主，避免把刚恢复的积压立刻冲掉。
    },
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
  let droppedCount = 0

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
        if (item.attempts >= maxAttempts) { item.dropped = true; droppedCount += 1; continue }
        item.nextAt = at + backoff(item.attempts)
        queue.push(item)
      }
      return { ok: true }
    },

    /** 清空待投递与在飞条目（会话切换/归档时用，避免把旧会话的消息投给新会话）。 */
    clear() {
      const n = queue.length + inflight.size
      queue.length = 0
      inflight.clear()
      return n
    },

    watermarkOf(plugin, activity) { return watermark.get(`${plugin}|${activity}`) ?? 0 },
    pendingCount() { return queue.length },
    inflightCount() { return inflight.size },

    /** 重试用尽后被静默丢弃的条目数（可观测出口）。 */
    droppedCount() { return droppedCount },
  }
}

/* ───────────────────────────── 模型插槽 ───────────────────────────── */

/**
 * 模型插槽：插件只声明"我需要什么样的模型"，不写模型名、不写地址、不自己调服务。
 * 模型管理插件把符合形状的供应商接上（bind），调用一律走 slots.call。
 */
export function createSlotRegistry({ onError = null } = {}) {
  const slots = new Map()
  const bindings = new Map()
  const providers = new Map()
  const listeners = new Set()
  const changed = () => {
    for (const fn of listeners) {
      try { fn() } catch (error) { try { onError?.('slots.listener', error) } catch { /* ignore */ } }
    }
  }

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
      return () => {
        providers.delete(id)
        // 供应商注销后，指向它的绑定不能继续可用（否则 call 仍会执行已卸载的实现）
        for (const [slotId, binding] of [...bindings]) {
          if (binding?.provider === id) bindings.delete(slotId)
        }
        changed()
      }
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
