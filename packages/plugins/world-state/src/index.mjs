// 世界状态插件：动态拼装 + 分层，本身不产生任何"主动行为"。
//
// 契约（别的插件往这里挂东西）：
//   ctx.services.get('world').registerSource({ id, layer, order, text })
//   layer: 'summary'（默认只进提示词）| 'detail'（只在工具里展开）
//
// 它只负责"按层渲染"，不负责采集。QQ/MC 以后各自注册来源，
// 但只能注册计数与摘要，不能把正文塞进 summary。
export const name = 'world-state'

const LAYERS = Object.freeze(['summary', 'detail'])

function stamp(now) {
  const d = new Date(now)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function apply(ctx) {
  const sources = new Map()
  let seq = 0

  function registerSource(source) {
    const id = String(source?.id ?? '').trim()
    if (!id) throw new Error('world source 需要 id')
    const layer = String(source.layer ?? 'summary')
    if (!LAYERS.includes(layer)) throw new Error(`未知层级：${layer}`)
    if (sources.has(id)) throw new Error(`world source 重复：${id}`)
    const entry = { id, layer, order: Number(source.order) || 50, text: source.text }
    sources.set(id, entry)
    return () => { sources.delete(id) }
  }

  /** 渲染：summary 只出 summary 层；detail 出两层。 */
  function render(layer = 'summary') {
    const want = layer === 'detail' ? ['summary', 'detail'] : ['summary']
    const lines = [...sources.values()]
      .filter((s) => want.includes(s.layer))
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
      .map((s) => {
        try { return typeof s.text === 'function' ? s.text({ now: ctx.now() }) : s.text } catch { return null }
      })
      .filter((line) => line != null && String(line).trim())
      .map((line) => String(line).trim())
    return lines.join('\n')
  }

  // 默认来源：时间。以后环境、精力等也是来源，不是硬编码。
  registerSource({ id: 'time', layer: 'summary', order: 10, text: () => `现在是 ${stamp(ctx.now())}。` })

  const world = {
    registerSource,
    render,
    /** 给管理插件/调试看：有哪些来源、各在哪一层。 */
    sources: () => [...sources.values()].map((s) => ({ id: s.id, layer: s.layer, order: s.order })),
    seq: () => ++seq,
  }

  ctx.services.provide('world', world)

  ctx.prompt.section({
    name: 'world',
    order: 10,
    text: () => render('summary'),
  })

  ctx.tools.register({
    name: 'world_status',
    description: 'Read the assembled world state. layer="summary" (default) gives the compact view; layer="detail" expands every registered source.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        layer: { type: 'string', enum: ['summary', 'detail'], description: 'Which layer to render (default summary).' },
      },
    },
    async execute({ layer = 'summary' } = {}) {
      return { text: render(layer === 'detail' ? 'detail' : 'summary') }
    },
  })

  ctx.log({ msg: 'world-state.ready', sources: sources.size })
}
