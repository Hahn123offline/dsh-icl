// 模型管理插件：只做接线。
//
// 它从配置里读"我有哪些服务"（以后改成从 DSH 同步），把它们登记成按形状描述的供应商，
// 然后给所有声明了插槽的插件自动接线。它**不**决定插件是否启用，也不写死任何插件的模型。
export const name = 'model-manager'

function providerFrom(entry, fetchImpl) {
  const kind = String(entry.kind ?? 'chat')
  const shape = { ...(entry.shape ?? {}) }
  if (kind === 'chat') {
    const chatFn = entry._chat
    return {
      id: String(entry.id),
      kind,
      shape,
      async call(request) {
        const messages = request?.messages ?? []
        return chatFn({ messages, maxTokens: request?.maxTokens ?? null })
      },
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
        const res = await fetchImpl(`${base}/embeddings`, {
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
  const skipped = []
  let clientBound = false
  for (const entry of entries) {
    if (!entry?.id) continue
    // 凭据只能从环境变量来；缺就跳过这个供应商，让后面合法的接上。
    const keyEnv = entry.apiKeyEnv == null ? null : String(entry.apiKeyEnv)
    const apiKey = keyEnv ? (process.env[keyEnv] ?? '') : (entry.apiKey ?? '')
    if (keyEnv && !apiKey) {
      skipped.push({ id: String(entry.id), reason: `缺环境变量 ${keyEnv}` })
      ctx.log({ level: 'warn', msg: 'provider.skipped', id: entry.id, reason: `缺 ${keyEnv}` })
      continue
    }
    // chat 供应商还要把核心模型客户端接上去（超时/暂停/401 重试都在那里）。
    if (String(entry.kind ?? 'chat') === 'chat' && !clientBound) {
      const extraBody = entry.disableThinking
        ? { chat_template_kwargs: { enable_thinking: false } }
        : (entry.extraBody ?? {})
      ctx.model.bind({ baseUrl: entry.baseUrl, model: entry.model, apiKey, timeoutMs: entry.timeoutMs, extraBody })
      clientBound = true
    }
    const provider = providerFrom({ ...entry, apiKey, _chat: (req) => ctx.model.chat(req) }, ctx.fetch)
    ctx.slots.registerProvider(provider)
    registered.push({ id: provider.id, kind: provider.kind, shape: provider.shape })
  }
  const bind = () => ctx.slots.autoBind()
  const first = bind()
  // 之后有新插件声明插槽，也要自动接上
  const offSlots = ctx.slots.onChange(() => { const bound = bind(); if (bound.length) ctx.log({ msg: 'slots.bound', bound }) })
  ctx.onDispose(offSlots)
  ctx.services.provide('model-manager', {
    providers: () => registered,
    skipped: () => skipped,
    rebind: () => bind(),
    unmatched: () => ctx.slots.unmatched(),
  })
  ctx.log({ msg: 'model-manager.ready', providers: registered.length, skipped: skipped.length, bound: first })
}
