// 模型管理插件：只做接线。
//
// 它从配置里读"我有哪些服务"（以后改成从 DSH 同步），把它们登记成按形状描述的供应商，
// 然后给所有声明了插槽的插件自动接线。它**不**决定插件是否启用，也不写死任何插件的模型。
export const name = 'model-manager'

function providerFrom(entry) {
  const kind = String(entry.kind ?? 'chat')
  const shape = { ...(entry.shape ?? {}) }
  if (kind === 'chat') {
    return {
      id: String(entry.id),
      kind,
      shape,
      async call(request) {
        const messages = request?.messages ?? []
        const text = await this._chat({ messages, maxTokens: request?.maxTokens ?? null })
        return text
      },
      _chat: entry._chat,
    }
  }
  if (kind === 'embedding') {
    return {
      id: String(entry.id),
      kind,
      shape,
      async call(request) {
        const base = String(entry.baseUrl ?? '').replace(/\/+$/, '')
        if (!base) throw new Error(`嵌入服务 ${entry.id} 缺少 baseUrl`)
        const res = await globalThis.fetch(`${base}/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(entry.apiKey ? { authorization: `Bearer ${entry.apiKey}` } : {}) },
          body: JSON.stringify({ model: entry.model, input: request?.input ?? '' }),
          signal: AbortSignal.timeout(Number(entry.timeoutMs) || 20_000),
        })
        if (!res.ok) throw new Error(`嵌入服务返回 ${res.status}`)
        const data = await res.json()
        return (data?.data ?? []).map((d) => d.embedding)
      },
    }
  }
  throw new Error(`未知的供应商类型：${kind}`)
}

export function apply(ctx) {
  const entries = Array.isArray(ctx.config.providers) ? ctx.config.providers : []
  const registered = []
  for (const entry of entries) {
    if (!entry?.id) continue
    const provider = providerFrom({ ...entry, _chat: (req) => ctx.model.chat(req) })
    ctx.slots.registerProvider(provider)
    registered.push({ id: provider.id, kind: provider.kind, shape: provider.shape })
  }
  const bind = () => ctx.slots.autoBind()
  const first = bind()
  // 之后有新插件声明插槽，也要自动接上
  ctx.slots.onChange(() => { const bound = bind(); if (bound.length) ctx.log({ msg: 'slots.bound', bound }) })
  ctx.services.provide('model-manager', {
    providers: () => registered,
    rebind: () => bind(),
    unmatched: () => ctx.slots.unmatched(),
  })
  ctx.log({ msg: 'model-manager.ready', providers: registered.length, bound: first })
}
