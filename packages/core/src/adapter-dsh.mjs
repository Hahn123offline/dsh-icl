// DSH 适配器：把 ICL 的工具面和提示词接到 DSH 的会话上。
//
// 这里只做"接线"，不做决策：
//   · 工具面来自 host.services.surface（已按预设过滤）
//   · 预设来自 host.services.presets（我们自己的，运行中可切）
//   · 提示词来自 host.services.prompt / context
//
// DSH 一侧的契约（最小集）：
//   dsh.tools.register({name, description, parameters, execute}) -> disposer
//   dsh.systemPrompt.section({name, order, text}) -> disposer
export function attachDshAdapter(host, dsh, { sessionId = null, order = 30 } = {}) {
  const surface = host.services.surface
  const registered = new Map()
  let disposed = false

  function sync() {
    if (disposed) return { added: [], removed: [] }
    const want = new Map(surface.list(sessionId ? { preset: host.services.presets.active() } : {}).map((t) => [t.name, t]))
    const added = []
    const removed = []
    for (const [name, off] of [...registered]) {
      if (want.has(name)) continue
      try { off() } catch { /* ignore */ }
      registered.delete(name)
      removed.push(name)
    }
    for (const [name, def] of want) {
      const prev = registered.get(name)
      if (prev) { try { prev() } catch { /* ignore */ } registered.delete(name) }
      const off = dsh.tools.register({
        name,
        description: def.description,
        parameters: def.parameters,
        execute: def.execute,
      })
      registered.set(name, typeof off === 'function' ? off : () => {})
      added.push(name)
    }
    return { added, removed }
  }

  const offChange = surface.onChange(() => { sync() })

  const sectionOff = dsh.systemPrompt?.section?.({
    name: 'icl:tools-and-memory',
    order,
    text: () => host.services.prompt.assemble({ sessionId }),
  })

  sync()

  return {
    sync,
    names: () => [...registered.keys()],
    async turn(message) {
      const [turnText, contextText] = await Promise.all([
        host.services.prompt.turnText({ sessionId, message }),
        host.services.context.assemble({ sessionId, message }),
      ])
      return [turnText, contextText].filter(Boolean).join('\n\n')
    },
    dispose() {
      disposed = true
      try { offChange() } catch { /* ignore */ }
      try { sectionOff?.() } catch { /* ignore */ }
      for (const off of registered.values()) { try { off() } catch { /* ignore */ } }
      registered.clear()
    },
  }
}
