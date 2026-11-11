// 最小 JSON Schema 校验器（只支持 fixture.schema.json 用到的子集）。
//
// 为什么不用现成库：仓库不引新依赖，而 fixture 契约只需要一个可审阅的小子集：
// type / required / properties / additionalProperties / items / enum / const /
// minItems / maxItems / minLength / maxLength / pattern / minimum / maximum /
// allOf / anyOf / oneOf / $ref（只解本地 #/$defs/...）。
// 错误路径用 `$.days[0].rows[1].id` 形式，方便直接定位 fixture 里的字段。

/** 把 `#/$defs/name` 这样的本地引用解析成 schema 节点；解析不到返回 null。 */
function resolveRef(root, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null
  let node = root
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (node == null || typeof node !== 'object') return null
    node = node[key]
  }
  return node ?? null
}

function typeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (Number.isInteger(value)) return 'integer'
  return typeof value
}

function matchesType(value, type) {
  const actual = typeOf(value)
  if (type === 'number') return actual === 'number' || actual === 'integer'
  if (type === 'integer') return actual === 'integer'
  return actual === type
}

/**
 * 校验 value 是否符合 schema。
 * @returns {{ok: boolean, errors: Array<{path: string, message: string}>}}
 */
export function validateSchema(value, schema, { root = schema } = {}) {
  const errors = []
  const push = (path, message) => {
    if (errors.length < 200) errors.push({ path, message })
  }

  function check(node, current, path, depth = 0) {
    if (depth > 40) { push(path, 'schema 嵌套过深（可能有环）'); return }
    if (node == null || typeof node !== 'object') return

    if (node.$ref != null) {
      const target = resolveRef(root, node.$ref)
      if (!target) { push(path, `无法解析的 $ref：${node.$ref}`); return }
      check(target, current, path, depth + 1)
      return
    }

    if (node.const !== undefined && current !== node.const) {
      push(path, `应为常量 ${JSON.stringify(node.const)}，实际 ${JSON.stringify(current)}`)
    }
    if (Array.isArray(node.enum) && !node.enum.includes(current)) {
      push(path, `应是 ${node.enum.map((x) => JSON.stringify(x)).join(' / ')} 之一，实际 ${JSON.stringify(current)}`)
    }
    if (node.type != null) {
      const types = Array.isArray(node.type) ? node.type : [node.type]
      if (!types.some((type) => matchesType(current, type))) {
        push(path, `类型应为 ${types.join('|')}，实际 ${typeOf(current)}`)
        return // 类型都不对，后面的结构检查没有意义
      }
    }

    if (typeof current === 'string') {
      if (node.minLength != null && current.length < node.minLength) push(path, `长度至少 ${node.minLength}`)
      if (node.maxLength != null && current.length > node.maxLength) push(path, `长度至多 ${node.maxLength}`)
      if (node.pattern != null) {
        let re = null
        try { re = new RegExp(node.pattern) } catch { push(path, `schema pattern 非法：${node.pattern}`) }
        if (re && !re.test(current)) push(path, `不匹配 ${node.pattern}`)
      }
    }
    if (typeof current === 'number') {
      if (node.minimum != null && current < node.minimum) push(path, `应 ≥ ${node.minimum}`)
      if (node.maximum != null && current > node.maximum) push(path, `应 ≤ ${node.maximum}`)
    }
    if (Array.isArray(current)) {
      if (node.minItems != null && current.length < node.minItems) push(path, `至少 ${node.minItems} 项`)
      if (node.maxItems != null && current.length > node.maxItems) push(path, `至多 ${node.maxItems} 项`)
      if (node.items != null) current.forEach((item, index) => check(node.items, item, `${path}[${index}]`, depth + 1))
    } else if (current && typeof current === 'object') {
      for (const key of node.required ?? []) {
        if (current[key] === undefined) push(`${path}.${key}`, '缺少必填字段')
      }
      const props = node.properties ?? {}
      for (const [key, child] of Object.entries(props)) {
        if (current[key] !== undefined) check(child, current[key], `${path}.${key}`, depth + 1)
      }
      if (node.additionalProperties === false) {
        for (const key of Object.keys(current)) {
          if (!(key in props)) push(`${path}.${key}`, '未知字段（additionalProperties=false）')
        }
      } else if (node.additionalProperties && typeof node.additionalProperties === 'object') {
        for (const key of Object.keys(current)) {
          if (!(key in props)) check(node.additionalProperties, current[key], `${path}.${key}`, depth + 1)
        }
      }
    }

    for (const branch of node.allOf ?? []) check(branch, current, path, depth + 1)
    if (Array.isArray(node.anyOf)) {
      const before = errors.length
      const ok = node.anyOf.some((branch) => {
        const saved = errors.length
        check(branch, current, path, depth + 1)
        const passed = errors.length === saved
        errors.length = saved
        return passed
      })
      if (!ok) { errors.length = before; push(path, '不满足 anyOf 中任何一种结构') }
    }
    if (Array.isArray(node.oneOf)) {
      const hits = node.oneOf.filter((branch) => {
        const saved = errors.length
        check(branch, current, path, depth + 1)
        const passed = errors.length === saved
        errors.length = saved
        return passed
      }).length
      if (hits !== 1) push(path, `oneOf 应恰好命中一种结构，实际 ${hits} 种`)
    }
  }

  check(schema, value, '$')
  return { ok: errors.length === 0, errors }
}
