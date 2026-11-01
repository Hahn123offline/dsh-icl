// 人格插件：只提供"一张卡"和"历史回滚"，不做任何主动行为。
//
// 存储策略：有 memory 插件就用它的命名空间（persona），没有就只在内存里。
// 这样既不会出现第二个数据库，也不把人格插件硬绑在记忆插件上。

export const name = 'persona'

function stamp(now) {
  const d = new Date(now)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

export function apply(ctx) {
  const memory = ctx.services.get('memory')
  const namespace = String(ctx.config.namespace ?? 'persona')
  const maxVersions = Math.max(1, Number(ctx.config.maxVersions) || 50)
  let current = String(ctx.config.card ?? '')
  let versionSeq = 0

  // 有持久化就恢复当前卡
  if (memory) {
    try {
      const saved = memory.query({ namespace, kind: 'persona-current', limit: 1 })
      if (saved.length) current = saved[0].text
    } catch { /* 读不到就从空开始 */ }
  }

  function versions(limit = 20) {
    if (!memory) return []
    const rows = memory.query({ namespace, kind: 'persona-version', limit: Math.max(1, Number(limit) || 20) })
    return rows.map((row) => ({ id: row.key, text: row.text, at: row.createdAt })).reverse()
  }

  function persist() {
    if (!memory) return
    memory.put({ namespace, kind: 'persona-current', key: 'current', text: current, now: ctx.now() })
    const all = memory.query({ namespace, kind: 'persona-version', limit: 500 })
    for (const old of all.slice(0, Math.max(0, all.length - maxVersions))) {
      memory.remove({ namespace, id: old.id })
    }
  }

  const api = {
    current() { return current },
    set(text, { by = 'owner' } = {}) {
      const next = String(text ?? '')
      if (!next.trim()) throw new Error('人格卡不能是空的')
      if (next === current) return { changed: false, chars: current.length }
      const at = ctx.now()
      if (memory && current) {
        memory.put({ namespace, kind: 'persona-version', key: `v:${stamp(at)}-${++versionSeq}`, text: current, data: { by }, now: at })
      }
      current = next
      persist()
      ctx.log({ msg: 'persona.set', by, chars: current.length })
      return { changed: true, chars: current.length }
    },
    /** 回滚到某一版（id 来自 versions()）或第 N 个旧版本（1 = 上一个）。 */
    rollback(target) {
      const list = versions(500)
      if (!list.length) throw new Error('没有可回滚的版本')
      let pick = null
      if (typeof target === 'string') pick = list.find((v) => v.id === target) ?? null
      else if (Number.isFinite(Number(target))) pick = list[Number(target) - 1] ?? null
      if (!pick) throw new Error('找不到这一版')
      const at = ctx.now()
      if (memory) memory.put({ namespace, kind: 'persona-version', key: `v:${stamp(at)}-${++versionSeq}`, text: current, data: { by: 'rollback' }, now: at })
      current = pick.text
      persist()
      ctx.log({ msg: 'persona.rollback', to: pick.id })
      return { rolledBackTo: pick.id, chars: current.length }
    },
    versions,
  }

  ctx.prompt.section({ name: 'persona', order: 20, text: () => current })
  ctx.services.provide('persona', api)
  ctx.log({ msg: 'persona.ready', persisted: Boolean(memory), chars: current.length })
  return api
}
