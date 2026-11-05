// DSH 适配器（通用版）：把 ICL 的工具面与提示词接到 DSH 的会话上下文上。
//
// 真实契约（见 dsh-contract.mjs）：
//   ctx.tools.register({name, description, parameters, output, execute}) -> disposer
//   ctx.systemPrompt.section({name, order, text}) -> disposer
//
// 这里只做"接线"，不做决策；作用域由传入的 dsh 决定（preset ctx / agent.ctx）。
import { toDshToolDefinition, toDshPromptSection } from './dsh-contract.mjs'

function sameTool(prev, def) {
  return Boolean(prev)
    && prev.def?.execute === def.execute
    && prev.def?.description === def.description
    && JSON.stringify(prev.def?.parameters ?? {}) === JSON.stringify(def.parameters ?? {})
}

export function attachDshAdapter(host, dsh, { sessionId = null, order = 30, log = () => {}, preset = null } = {}) {
  if (!dsh?.tools || typeof dsh.tools.register !== 'function') {
    throw new Error('DSH 适配器需要 dsh.tools.register(def)')
  }
  const surface = host.services.surface
  const registered = new Map()
  let disposed = false

  function list() {
    return surface.list(preset ? { preset } : {})
  }

  function sync() {
    if (disposed) return { added: [], removed: [] }
    const want = new Map(list().map((t) => [t.name, t]))
    const added = []
    const removed = []
    for (const [name, entry] of [...registered]) {
      if (want.has(name)) continue
      try { entry.off() } catch (error) { log({ msg: 'dsh.tool-unregister-fail', name, error: String(error?.message ?? error) }) }
      registered.delete(name)
      removed.push(name)
    }
    for (const [name, def] of want) {
      const prev = registered.get(name)
      if (sameTool(prev, def)) continue
      if (prev) {
        try { prev.off() } catch (error) { log({ msg: 'dsh.tool-unregister-fail', name, error: String(error?.message ?? error) }) }
        registered.delete(name)
      }
      try {
        const off = dsh.tools.register(toDshToolDefinition(def))
        registered.set(name, { off: typeof off === 'function' ? off : () => {}, def })
        added.push(name)
      } catch (error) {
        log({ msg: 'dsh.tool-register-fail', name, error: String(error?.message ?? error) })
      }
    }
    return { added, removed }
  }

  const offChange = surface.onChange(() => { sync() })

  const section = toDshPromptSection({
    host, sessionId, order,
    onError: (error) => log({ msg: 'dsh.prompt-section-fail', error: String(error?.message ?? error) }),
  })
  const sectionOff = typeof dsh.systemPrompt?.section === 'function'
    ? dsh.systemPrompt.section(section)
    : null
  if (!sectionOff) log({ msg: 'dsh.prompt-section-missing' })

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
      for (const entry of registered.values()) { try { entry.off() } catch { /* ignore */ } }
      registered.clear()
    },
  }
}
