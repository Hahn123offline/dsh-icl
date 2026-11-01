// 会话适配器：一个实例只指向**一个**被指定的 DSH 会话。
//
// 它不碰插件，只做三件事：
//   1. 把这轮的系统提示词装配出来（插件段 + 核心段）
//   2. 把投递队列里该发的批次 push 进去，成功 ack / 失败 nack
//   3. own 住这个会话的工具面（工具来自 host，卸载即消失）
//
// 真正的 DSH 绑定（ctx.tools / ctx.systemPrompt / session/prompt）由外层薄壳注入，
// 这样适配器本身可以脱离 DSH 跑测试。

export function createSessionAdapter({ sessionId, host, push, toolSink = null, now = () => Date.now(), log = () => {} } = {}) {
  if (!sessionId) throw new Error('sessionId 必填')
  if (typeof push !== 'function') throw new Error('push(text, opts) 必填')
  let timer = null
  let draining = false

  return {
    sessionId,

    /** 当前这轮应该看到的工具名（由 host 决定，适配器只读）。 */
    toolNames() { return host.services.tools.names() },

    /** 把工具接到真实的 DSH 工具面上（DSH: ctx.tools.register）。 */
    installTools() {
      if (!toolSink) return () => {}
      const disposers = host.services.tools.list().map((definition) => toolSink.register(definition))
      return () => { for (const dispose of disposers.reverse()) { try { dispose() } catch { /* 忽略 */ } } }
    },

    /** 系统提示词（DSH: ctx.systemPrompt.section 的 text 函数）。 */
    systemPrompt(ctx = {}) {
      const core = `你正在通过 ICL 运行。当前会话：${sessionId}。`
      const index = host.services.tools.index()
      const pluginText = host.services.prompt.assemble({ sessionId, ...ctx })
      return [core, index ? `现在开着的工具：\n${index}` : '', pluginText].filter(Boolean).join('\n\n')
    },

    /** 工具面的最终形态（DSH: ctx.tools.register 的入参）。 */
    toolDefinitions() { return host.services.tools.list() },

    /** 投递一轮：drain → push → ack/nack。返回这一轮的结果，便于测试。 */
    async drainOnce() {
      if (draining) return { skipped: 'busy', delivered: 0 }
      draining = true
      const results = []
      try {
        for (const batch of host.services.delivery.drain('session')) {
          try {
            await push(batch.text, { images: batch.images, channel: batch.channel, batch })
            host.services.delivery.ack(batch.id)
            results.push({ ok: true, id: batch.id, count: batch.entries.length })
          } catch (error) {
            host.services.delivery.nack(batch.id, error?.message ?? error)
            results.push({ ok: false, id: batch.id, error: String(error?.message ?? error) })
            log({ msg: 'delivery.failed', error: String(error?.message ?? error) })
          }
        }
      } finally { draining = false }
      return { delivered: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results }
    },

    /** 常驻投递（DSH 里由外层定时器驱动；测试里可不调）。 */
    start({ intervalMs = 1000 } = {}) {
      if (timer) return
      timer = setInterval(() => { void this.drainOnce() }, Math.max(200, Number(intervalMs) || 1000))
      if (typeof timer.unref === 'function') timer.unref()
    },
    stop() { if (timer) { clearInterval(timer); timer = null } },

    status() {
      const focus = host.services.focus.current()
      return {
        sessionId,
        now: now(),
        focus: focus ? { label: focus.label, owner: focus.owner, since: focus.since, expiresAt: focus.expiresAt } : null,
        tools: host.services.tools.names(),
        pending: host.services.delivery.pendingCount(),
        plugins: host.list(),
      }
    },
  }
}
