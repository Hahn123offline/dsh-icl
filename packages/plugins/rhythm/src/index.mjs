// 节律插件（M1）：一个稳定的时钟，只做一件事——每天到点触发"做梦"。
//
// 为什么要有状态文件：去重不能只放内存。进程如果在触发之后重启，内存里的
// "今天已经触发过"就没了，同一天会再触发一次。所以把"最后一次触发的日期"
// 写进 rhythm 自己的运行时状态（很小，不是记忆，也不进记忆库）。
//
// 补偿语义：启动时如果"今天的时间点已过、且今天还没触发过"，立刻补一次。
// 这样白天关着、晚上才开也不会漏掉当天的做梦。
import fs from 'node:fs'
import path from 'node:path'

export const name = 'rhythm'

function dayKey(now) {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function apply(ctx) {
  const at = String(ctx.config.dreamAt ?? '22:30')
  const m = /^(\d{1,2}):(\d{2})$/.exec(at)
  if (!m) throw new Error(`dreamAt 格式应为 HH:mm，收到 ${at}`)
  const hour = Number(m[1])
  const minute = Number(m[2])
  if (hour > 23 || minute > 59) throw new Error(`dreamAt 不合法：${at}`)

  const stateFile = ctx.config.stateFile
    ? String(ctx.config.stateFile)
    : path.join(String(ctx.config.root ?? '.'), 'state', 'rhythm.json')

  const listeners = new Set()
  let lastFiredDay = null

  // 读回"最后一次触发的日期"
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    if (saved?.lastFiredDay) lastFiredDay = String(saved.lastFiredDay)
  } catch { /* 没有状态文件就是第一次 */ }

  function save() {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true })
      fs.writeFileSync(stateFile, JSON.stringify({ lastFiredDay, at }), 'utf8')
    } catch (error) { ctx.log({ level: 'warn', msg: 'rhythm.save', error: String(error?.message ?? error) }) }
  }

  /** 今天的时间点（本地时区）。 */
  function todayPoint(now) {
    const d = new Date(now)
    d.setHours(hour, minute, 0, 0)
    return d.getTime()
  }

  function fire({ now = ctx.now(), force = false } = {}) {
    const day = dayKey(now)
    if (!force && lastFiredDay === day) return { fired: false, reason: 'already-today' }
    lastFiredDay = day
    save()
    for (const fn of listeners) { try { fn({ at: now, day }) } catch { /* 一个坏了不影响别的 */ } }
    ctx.log({ msg: 'rhythm.nightly', at: now, day })
    return { fired: true, day }
  }

  /** 时钟：每 20 秒看一次"今天到点了吗、还没触发过吗"。 */
  function tick() {
    const now = ctx.now()
    if (now >= todayPoint(now)) fire({ now })
  }

  // 启动时**不**直接补发：那会在别的插件还没订阅时就把事件丢掉。
  // 需要补发的消费者（如 dream）在自己启用时用 isDue() 自查。
  const timer = setInterval(tick, 20_000)
  if (typeof timer.unref === 'function') timer.unref()
  ctx.onDispose(() => clearInterval(timer))

  const api = {
    onNightly(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    /** 手动触发（测试/主人要求）。force 可绕过当天去重。 */
    fire: (now, { force = false } = {}) => fire({ now: now ?? ctx.now(), force }),
    at,
    nextAt(now = ctx.now()) {
      const today = todayPoint(now)
      return now < today ? today : today + 24 * 3600_000
    },
    lastFiredDay: () => lastFiredDay,
    /** 今天到点了吗、还没发过？（给晚启动的消费者自查用） */
    isDue(now = ctx.now()) { return now >= todayPoint(now) && lastFiredDay !== dayKey(now) },
  }
  // 把"下一次作梦"挂到世界状态：她随时知道离睡觉还有多久
  try {
    const world = ctx.services.get('world')
    if (world?.registerSource) {
      world.registerSource({
        id: 'rhythm', owner: 'clock', title: '作息', order: 20, cap: 1,
        items: () => {
          const next = api.nextAt()
          if (!next) return []
          const mins = Math.max(0, Math.round((next - ctx.now()) / 60000))
          const hh = Math.floor(mins / 60), mm = mins % 60
          return [{ key: 'next', brief: `下一次做梦：${new Date(next).toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5)}（还有 ${hh ? `${hh} 小时 ` : ''}${mm} 分）。` }]
        },
      })
    }
  } catch { /* 没有世界状态也没关系 */ }

  ctx.services.provide('rhythm', api)
  ctx.log({ msg: 'rhythm.ready', at, lastFiredDay, stateFile })
  return api
}
