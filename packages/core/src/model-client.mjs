// 模型客户端：插件不碰 baseUrl、密钥、重试、暂停——全部集中在这里。
//
// 这些规则都是从旧实现踩出来的：
//   · 缓存凭据必须带过期（曾经因为 cookie 一小时过期而静默失联九小时）
//   · 401 要重取一次凭据再重试，而不是直接失败
//   · "暂停"要能中止在飞请求，并且立刻拒绝新请求
//   · 超时必须有上限，不能把钱和时间挂在一次请求上

export function createModelClient({ fetchImpl = globalThis.fetch, now = () => Date.now(), onAuthError = null } = {}) {
  let binding = null
  let paused = null
  const inflight = new Set()

  function configured() {
    if (!binding) throw new Error('模型没有绑定：先由模型管理插件 bind')
    const base = String(binding.baseUrl ?? '').replace(/\/+$/, '')
    if (!base || !binding.model) throw new Error('模型绑定不完整（baseUrl / model）')
    return { base, model: String(binding.model), apiKey: binding.apiKey ?? null, timeoutMs: Number(binding.timeoutMs) > 0 ? Number(binding.timeoutMs) : null }
  }

  async function request(body, { timeoutMs = null, force = null } = {}) {
    const cfg = configured()
    const controller = new AbortController()
    const entry = { controller, at: now() }
    inflight.add(entry)
    const effectiveTimeout = Math.max(1000, Number(timeoutMs) || Number(cfg.timeoutMs) || 120_000)
    const timer = setTimeout(() => controller.abort(new Error('超时')), effectiveTimeout)
    if (typeof timer.unref === 'function') timer.unref()
    try {
      const res = await fetchImpl(`${cfg.base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
        body: JSON.stringify({ model: cfg.model, ...body }),
        signal: controller.signal,
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        const error = new Error(`模型返回 ${res.status}${text ? `：${text.slice(0, 160)}` : ''}`)
        error.status = res.status
        throw error
      }
      return await res.json()
    } finally {
      clearTimeout(timer)
      inflight.delete(entry)
    }
  }

  return {
    /** 由模型管理插件调用。 */
    bind(next) { binding = next ? { ...next } : null },
    current() { return binding ? { ...binding } : null },
    isPaused() { return Boolean(paused) },
    pause(reason = 'paused by owner') {
      paused = { at: now(), reason: String(reason) }
      for (const entry of inflight) { try { entry.controller.abort(new Error('model paused')) } catch { /* 已结束 */ } }
      return { paused: true, aborted: inflight.size }
    },
    resume() { paused = null; return { paused: false } },
    inflightCount() { return inflight.size },

    /**
     * 调用一次 chat。返回纯文本。
     * @param {object} input
     * @param {Array<{role:string, content:string}>} input.messages
     */
    async chatDetailed({ messages = [], maxTokens = null, timeoutMs = null, temperature = undefined } = {}) {
      return this.chatInner({ messages, maxTokens, timeoutMs, temperature })
    },

    async chat({ messages = [], maxTokens = null, timeoutMs = null, temperature = undefined } = {}) {
      const { text } = await this.chatInner({ messages, maxTokens, timeoutMs, temperature })
      return text
    },

    async chatInner({ messages = [], maxTokens = null, timeoutMs = null, temperature = undefined } = {}) {
      if (paused) {
        const error = new Error(`模型已暂停：${paused.reason}`)
        error.code = 'MODEL_PAUSED'
        throw error
      }
      const extra = binding?.extraBody ?? {}
      const body = { messages, stream: false, ...extra, ...(maxTokens ? { max_tokens: Number(maxTokens) } : {}), ...(temperature == null ? {} : { temperature }) }
      const parse = (data) => {
        const msg = data?.choices?.[0]?.message ?? {}
        return { text: String(msg?.content ?? ''), reasoning: String(msg?.reasoning_content ?? msg?.reasoning ?? '') }
      }
      try {
        return parse(await request(body, { timeoutMs }))
      } catch (error) {
        if (error?.status === 401 && typeof onAuthError === 'function') {
          const renewed = await onAuthError(error)
          if (renewed) { binding = { ...binding, ...renewed }; return parse(await request(body, { timeoutMs })) }
        }
        if (String(error?.name) === 'AbortError' || /aborted/i.test(String(error?.message ?? ''))) {
          const wrapped = new Error(paused ? '模型已暂停（请求被中止）' : '模型请求超时或被中止')
          wrapped.code = paused ? 'MODEL_PAUSED' : 'MODEL_ABORTED'
          throw wrapped
        }
        throw error
      }
    },
  }
}
