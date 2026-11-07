// 世界状态：一个**只读的信息总线**，深度 2 的树（注册者 → 信息项）。
//
// 形状（运行时拼装，任何时候都可以变化）：
//   owner（注册者）
//     └─ item（信息项）: { key, brief, detail? }
//
// 语义：
//   · 默认（无参数）：每个注册者只露出最多 cap 条 brief，用来做"全局一瞥"
//   · 指定 owner：列出这个注册者登记的全部项（受 limit 约束）
//   · 指定 owner + item：展开这一项的全量内容
//   · items() 每次调用都重新求值 → 注册者可以动态撤回/新增；空 items() 默认出一行“无”，
//     只有显式 `empty:false` 的 source 才整段消失（全局快照，不是有才出现的通知流）
//
// 提示词里**永远只放 brief 层**；detail 只在工具/服务里展开。
export const name = 'world-state'

const DEFAULT_CAP = 3

function stamp(now) {
  const d = new Date(now)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 统一把 items() 的返回值规整成 { key, brief, detail }。 */
function normalizeItems(raw) {
  const list = Array.isArray(raw) ? raw : (raw == null ? [] : [raw])
  return list
    .map((item, index) => {
      if (item == null) return null
      if (typeof item === 'string') return { key: `i${index}`, brief: item, detail: null }
      const brief = String(item.brief ?? item.text ?? '').trim()
      if (!brief) return null
      return { key: String(item.key ?? `i${index}`), brief, detail: item.detail == null ? null : String(item.detail) }
    })
    .filter(Boolean)
}

export function apply(ctx) {
  const sources = new Map() // id -> { id, owner, title, order, cap, items }
  let seq = 0

  function registerSource(source) {
    const id = String(source?.id ?? '').trim()
    if (!id) throw new Error('world source 需要 id')
    if (sources.has(id)) throw new Error(`world source 重复：${id}`)
    if (typeof source.items !== 'function') throw new Error(`world source ${id} 需要 items()`)
    const entry = {
      id,
      owner: String(source.owner ?? id),
      title: String(source.title ?? source.owner ?? id),
      order: Number(source.order) || 50,
      cap: Math.max(0, Number.isFinite(Number(source.cap)) ? Number(source.cap) : DEFAULT_CAP),
      items: source.items,
      // 默认"没内容也要报无"：world status 是全局快照，不是"有才出现"的通知流。
      // source 显式 empty:false 才允许完全消失（如 clock 在 time 存在时）。
      empty: source.empty === false ? false : (source.empty ?? '无'),
    }
    sources.set(id, entry)
    return () => { sources.delete(id) }
  }

  /** 取某个注册者的**已规整**信息项（每次重新求值）。 */
  function itemsOf(owner) {
    const out = []
    for (const source of sources.values()) {
      if (owner != null && source.owner !== String(owner)) continue
      let raw = []
      try { raw = source.items() } catch { raw = [] }
      const items = normalizeItems(raw)
      if (!items.length && source.empty !== false) {
        const text = typeof source.empty === 'function' ? source.empty() : source.empty
        const brief = String(text ?? '').trim()
        if (brief) items.push({ key: '__empty__', brief, detail: null, placeholder: true })
      }
      for (const item of items) out.push({ ...item, source: source.id, owner: source.owner, title: source.title })
    }
    return out.sort((a, b) => {
      const orderOf = (id) => sources.get(id)?.order ?? 50
      return orderOf(a.source) - orderOf(b.source) || a.source.localeCompare(b.source)
    })
  }

  /** 注册者分组（只保留还有内容的）。 */
  function owners() {
    const map = new Map()
    for (const item of itemsOf(null)) {
      if (!map.has(item.owner)) map.set(item.owner, { owner: item.owner, title: item.title, items: [] })
      map.get(item.owner).items.push(item)
    }
    return [...map.values()]
  }

  /** brief 层：全局一瞥（每个注册者最多 cap 条）。 */
  function renderBrief({ owner = null } = {}) {
    const sourceOf = (name) => [...sources.values()].filter((s) => s.owner === name).sort((a, b) => a.order - b.order)[0]
    const groups = owners()
      .filter((g) => owner == null || g.owner === String(owner))
      .sort((a, b) => (sourceOf(a.owner)?.order ?? 50) - (sourceOf(b.owner)?.order ?? 50) || a.owner.localeCompare(b.owner))
    const lines = []
    for (const group of groups) {
      const source = sourceOf(group.owner)
      const cap = source?.cap ?? DEFAULT_CAP
      const shown = group.items.slice(0, cap)
      const more = group.items.length - shown.length
      // 同一 owner 的多条 brief 用分号连接；先去掉句末的句号，免得出现 "。；"
      const body = shown.map((item) => String(item.brief).replace(/[。；;]\s*$/, '')).join('；')
      lines.push(`${group.title}：${body}${more > 0 ? `（还有 ${more} 项）` : ''}。`)
    }
    return lines.join('\n')
  }

  /**
   * 读接口（工具与其它插件共用）：
   *   read()                → { owners: [...], text }
   *   read({ owner })       → { owner, items: [...], text }
   *   read({ owner, item }) → { owner, item, detail, text }
   */
  function read({ owner = null, item = null, limit = 20 } = {}) {
    if (owner == null) {
      const groups = owners()
      return { owners: groups.map((g) => ({ owner: g.owner, title: g.title, count: g.items.length })), text: renderBrief() }
    }
    const list = itemsOf(owner)
    if (!list.length) return { owner: String(owner), items: [], text: `没有来自「${owner}」的信息。` }
    if (item != null) {
      const hit = list.find((x) => x.key === String(item))
      if (!hit) return { owner: String(owner), items: list.map((x) => x.key), text: `「${owner}」没有这一项：${item}` }
      return { owner: String(owner), item: hit.key, detail: hit.detail, brief: hit.brief, text: hit.detail ?? hit.brief }
    }
    const shown = list.slice(0, Math.max(1, Number(limit) || 20))
    return {
      owner: String(owner),
      items: shown.map((x) => ({ key: x.key, brief: x.brief, hasDetail: x.detail != null })),
      text: shown.map((x) => `· ${x.brief}`).join('\n'),
    }
  }

  // 默认来源：没有 time 插件时兜底显示系统时间；time 在时不再重复一行。
  registerSource({
    id: 'clock', owner: 'clock', title: '时间', order: 10, empty: false,
    items: () => ([...sources.values()].some((s) => s.owner === 'time')
      ? []
      : [{ key: 'now', brief: `现在是 ${stamp(ctx.now())}。` }]),
  })

  const world = { registerSource, read, renderBrief, owners, itemsOf, sources: () => [...sources.values()].map((s) => ({ id: s.id, owner: s.owner, title: s.title, order: s.order, cap: s.cap })) }
  ctx.services.provide('world', world)

  // 事实状态段：order 890（在人格/仿真之后）。契约要求每段 ≤1–2 行且实现里必须截断，
  // 来源会随插件增长（时间/待办/MC…），所以这里给一个硬上限。
  const sectionMaxChars = Math.max(80, Number(ctx.config.maxChars ?? 240))
  ctx.prompt.section({
    name: 'world',
    order: 890,
    text: () => {
      const text = renderBrief()
      return text.length > sectionMaxChars ? `${text.slice(0, sectionMaxChars - 1)}…` : text
    },
  })

  ctx.tools.register({
    name: 'world_status',
    summary: 'Read the world state bus: one line per feed, or expand one owner or item.',
    when: ['you want to know what is going on around you', 'before acting somewhere'],
    avoid: ['when nothing changed since you last looked'],
    description: 'No arguments: the global glance (one line per owner/feed). owner: list that owner\'s items. owner + item: expand one item\'s full detail. Feeds report "无" when they have nothing right now; a feed only disappears if its source explicitly opts out with empty:false.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        owner: { type: 'string', description: 'Who registered it, e.g. "qq".' },
        item: { type: 'string', description: 'An item key within that owner.' },
        limit: { type: 'number', description: 'Max items when listing an owner (default 20).' },
      },
    },
    async execute({ owner = null, item = null, limit = 20 } = {}) {
      const out = read({ owner, item, limit })
      return { text: out.text || '（世界状态是空的）' }
    },
  })

  ctx.log({ msg: 'world-state.ready', sources: sources.size })
}
