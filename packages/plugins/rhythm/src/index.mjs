// 节律插件（M1）：只做一件事——到点触发"做梦"。
//
// 闹钟、计时器、日历以后都挂在这里；现在不要提前长出来。
export const name = 'rhythm'

export function apply(ctx) {
  const at = String(ctx.config.dreamAt ?? '22:30')
  const [hour, minute] = at.split(':').map((n) => Number(n))
  const listeners = new Set()
  let lastDay = null

  function fire(now = ctx.now()) {
    const d = new Date(now)
    const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
    if (lastDay === key) return { fired: false, reason: 'already-today' }
    lastDay = key
    for (const fn of listeners) { try { fn({ at: now }) } catch { /* 一个坏了不影响别的 */ } }
    ctx.log({ msg: 'rhythm.nightly', at: now })
    return { fired: true }
  }

  function tick() {
    const d = new Date(ctx.now())
    if (d.getHours() !== hour || d.getMinutes() !== minute) return
    fire()
  }

  const timer = setInterval(tick, 30_000)
  if (typeof timer.unref === 'function') timer.unref()
  ctx.onDispose(() => clearInterval(timer))

  ctx.services.provide('rhythm', {
    /** 订阅晚间触发。 */
    onNightly(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    /** 测试/手动触发。 */
    fire: (now) => fire(now ?? ctx.now()),
    at,
  })
  ctx.log({ msg: 'rhythm.ready', at })
}
