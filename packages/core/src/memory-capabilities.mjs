// 记忆能力契约（2026-11-13 组件审计后的统一事实源）。
//
// 背景：存储（v3 episode + annotations）、工具（recall 的 kind 枚举）、自知（memory_status 计数）
// 曾各自维护一套词表，导致 "状态说承诺 25 / kind=commitment 查不到" 这类契约错配。
// 这里给出一份按 schema 划分的能力表，供 recall / eager / whois / memory_status 共用：
//   · kinds：可被工具枚举、可默认检索的记忆类型（v3 只有 episode/person/lexicon）；
//   · legacyNamespaces：归档的 v2 namespace，v3 读取路径不得再读；
//   · internalNamespaces：内部索引/账本，不对外查询；
//   · annotations：v3 块内元数据字段（不是可独立查询的类型）。

const V2_KINDS = {
  event: { label: '事件' },
  person: { label: '人物' },
  slang: { label: '梗' },
  fact: { label: '事实' },
  preference: { label: '偏好' },
  commitment: { label: '承诺' },
  lexicon: { label: '语料' },
}

const V3_KINDS = {
  // v3 只有"经历"是事件/经历主单位；人物、语料仍是独立记忆类型。
  episode: { label: '经历' },
  person: { label: '人物' },
  lexicon: { label: '语料' },
}

const V2 = Object.freeze({
  schema: 'v2',
  kinds: V2_KINDS,
  // v2 没有归档 namespace；内部层仅 episode-seg（v2 无此层，保留空集合便于统一判断）。
  legacyNamespaces: [],
  internalNamespaces: ['resolve', 'note', 'persona', 'compaction', 'recall-cursor', 'day', 'dream-run', 'episode-seg', 'entity', 'relation'],
  annotations: null,
})

const V3 = Object.freeze({
  schema: 'v3',
  kinds: V3_KINDS,
  // 这些是 v2 时代的存储位置：只作为归档保留在库里，v3 的任何读取路径都不得再读。
  legacyNamespaces: ['event', 'fact', 'preference', 'commitment', 'slang'],
  internalNamespaces: ['episode-seg', 'entity', 'relation', 'day', 'dream-run', 'recall-cursor', 'note', 'persona', 'compaction', 'resolve'],
  annotations: {
    facts: { label: '事实' },
    preferences: { label: '偏好' },
    commitments: { label: '承诺' },
  },
})

export const MEMORY_SCHEMAS = Object.freeze(['v2', 'v3'])

/** 按 schema 取记忆能力表；未知 schema 回退 v2（与现有配置默认一致）。 */
export function memoryCapabilities(schema) {
  return String(schema ?? 'v2') === 'v3' ? V3 : V2
}

/** 工具/状态可用的记忆类型 id 列表（顺序即展示/枚举顺序）。 */
export function memoryKindIds(schema) {
  return Object.keys(memoryCapabilities(schema).kinds)
}

/** 某个 namespace 在当前 schema 下是否是"可对外查询的记忆类型"。 */
export function isQueryableNamespace(schema, namespace) {
  return Object.hasOwn(memoryCapabilities(schema).kinds, String(namespace ?? ''))
}

/** 某个 namespace 是否是归档的 v2 位置（v3 读取路径必须避开）。 */
export function isLegacyNamespace(schema, namespace) {
  return memoryCapabilities(schema).legacyNamespaces.includes(String(namespace ?? ''))
}
