// 投递泵：把 delivery 队列里的批次真正送进 DSH 会话。
//
// 这是"时间模块的消息能到会话"的唯一通道。没有它，所有 wake/goal/notice
// 都只是死信。
//
// 设计：只依赖三个注入项，方便测试
//   delivery   有 drain/ack/nack 的服务
//   sessionId  当前会话 id（拿不到就跳过这一轮）
//   prompt     实际发送函数：({sessionId, text}) => Promise
export function createDeliveryPump({ delivery, sessionId, prompt, intervalMs = 1500, log = () => {} } = {}) {
  if (!delivery?.drain) throw new Error('delivery 必填')
  if (typeof prompt !== 'function') throw new Error('prompt 必填')
  let timer = null
  let busy = false
  let stopped = false
  const stats = { sent: 0, failed: 0, skipped: 0 }

  async function tick() {
    if (busy || stopped) return { sent: 0 }
    const id = typeof sessionId === 'function' ? sessionId() : sessionId
    if (!id) { stats.skipped += 1; return { sent: 0, skipped: 'no-session' } }
    busy = true
    let sent = 0
    try {
      for (const batch of delivery.drain('session')) {
        const text = String(batch.text ?? '').trim()
        if (!text) { delivery.ack(batch.id); continue }
        try {
          await prompt({ sessionId: id, text })
          delivery.ack(batch.id)
          stats.sent += 1
          sent += 1
        } catch (error) {
          delivery.nack(batch.id, error?.message ?? error)
          stats.failed += 1
          log({ msg: 'pump.prompt-fail', error: String(error?.message ?? error) })
          break
        }
      }
    } finally { busy = false }
    return { sent }
  }

  function start() {
    if (timer) return
    timer = setInterval(() => { void tick() }, Math.max(500, Number(intervalMs) || 1500))
    if (typeof timer.unref === 'function') timer.unref()
  }

  function stop() {
    stopped = true
    if (timer) { clearInterval(timer); timer = null }
  }

  return { tick, start, stop, stats: () => ({ ...stats }) }
}
