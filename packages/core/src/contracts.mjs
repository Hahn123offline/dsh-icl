// 契约：插件清单的校验，以及 focus 穿透规则的匹配。
//
// 这里只放"核心与插件共同认可的形状"，不放任何业务。
// 规矩：插件清单不合格就拒绝加载（宁可起不来，也不要半残地跑）。

export const PIERCE_LEVELS = Object.freeze(['always', 'mention', 'never'])

/**
 * 校验插件清单。
 * @param {object} manifest
 * @returns {{ok:true, manifest:object} | {ok:false, error:string}}
 */
export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return { ok: false, error: '清单不是对象' }
  const id = String(manifest.id ?? '').trim()
  if (!/^[a-z][a-z0-9-]*$/.test(id)) return { ok: false, error: `插件 id 不合法：${id || '(空)'}` }
  if (!String(manifest.version ?? '').trim()) return { ok: false, error: `${id} 缺少 version` }
  if (!String(manifest.entry ?? '').trim()) return { ok: false, error: `${id} 缺少 entry` }

  const tools = manifest.tools ?? []
  if (!Array.isArray(tools) || tools.some((t) => typeof t !== 'string')) {
    return { ok: false, error: `${id} 的 tools 必须是字符串数组` }
  }
  const slots = manifest.slots ?? []
  if (!Array.isArray(slots)) return { ok: false, error: `${id} 的 slots 必须是数组` }
  for (const slot of slots) {
    if (!slot?.id || !slot?.kind) return { ok: false, error: `${id} 的插槽缺少 id 或 kind` }
  }
  const focus = manifest.focus ?? {}
  if (focus.claims != null && !Array.isArray(focus.claims)) {
    return { ok: false, error: `${id} 的 focus.claims 必须是数组` }
  }
  if (focus.pierce != null) {
    for (const [pattern, level] of Object.entries(focus.pierce)) {
      if (!PIERCE_LEVELS.includes(level)) {
        return { ok: false, error: `${id} 的穿透规则 ${pattern} 用了未知级别 ${level}` }
      }
    }
  }
  return {
    ok: true,
    manifest: {
      id,
      version: String(manifest.version),
      entry: String(manifest.entry),
      tools,
      slots,
      focus,
      requires: manifest.requires ?? {},
    },
  }
}

/** 把一个 focus 标签 glob（只支持结尾 * 或全 *）转成正则。 */
function globToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}

/**
 * 从穿透规则里取出来源标签对应的级别。
 * 优先级：完全相同的标签 > 更长的 glob > 更短的 > '*' > 默认。
 */
export function resolvePierce(rules = {}, fromLabel, { mention = false } = {}) {
  const label = String(fromLabel ?? '')
  const entries = Object.entries(rules ?? {})
  let best = null
  for (const [pattern, level] of entries) {
    if (pattern === label) { best = { pattern, level, weight: 1000 + pattern.length }; break }
    if (pattern === '*') { if (!best || best.weight < 1) best = { pattern, level, weight: 1 }; continue }
    if (!pattern.includes('*')) continue
    if (!globToRegExp(pattern).test(label)) continue
    const weight = 10 + pattern.replace(/\*/g, '').length
    if (!best || weight > best.weight) best = { pattern, level, weight }
  }
  const level = best?.level ?? 'mention'
  const allowed = level === 'always' || (level === 'mention' && mention)
  return { allowed, level, pattern: best?.pattern ?? '(default)' }
}
