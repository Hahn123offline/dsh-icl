// 记忆素材 profile：主材料选择现在由产品执行（dream.config.formationProfile），
// 分类器只有一份：packages/core/src/raw-profile.mjs。
//
// 评测侧只负责两件事：
//   1. 把 fixture 的全部行如实喂给 raw 源（source 透传，不再做 wire-source 模拟）；
//   2. 把 --profile 作为 `formationProfile` 传给 dream 插件，让产品自己的
//      formationLines / people / lexicon 选择器决定哪些行进主材料。
// raw-all / raw-main / raw-human 因此是真正的产品路径 A/B，而不是评测复刻口径。
import { inferRawSource } from '../../packages/core/src/index.mjs'

export const PROFILES = Object.freeze(['raw-all', 'raw-main', 'raw-human'])

/** fixture 行 → raw 源行（source 透传；raw 服务只补 sourceId，不覆盖 source）。 */
function toRawRow(row, fixture) {
  const speaker = row.speaker ?? {}
  const owner = fixture.persona?.owner
  const self = fixture.persona?.self
  let sender = ''
  if (row.role === 'assistant') sender = String(self?.name ?? '我')
  else if (speaker.kind === 'owner') sender = String(owner?.name ?? '主人')
  else if (speaker.kind === 'self') sender = String(self?.name ?? '我')
  else if (speaker.kind === 'person') sender = String(speaker.value ?? '某人')
  else if (speaker.kind === 'system') sender = '系统'
  else sender = String(row.role ?? '')
  return {
    // raw 源行字段：产品 wash 归入 rowId 的稳定 id、时间、文本、说话人、来源。
    id: String(row.id),
    rowId: String(row.id),
    time: Number.isFinite(row.atMs) ? row.atMs : Date.parse(String(row.at)),
    at: row.at,
    role: row.role,
    channel: row.channel,
    speaker,
    text: String(row.text ?? ''),
    source: inferRawSource(row),
    sender,
    visible: row.visible !== false,
    day: row.day,
  }
}

/**
 * 把 fixture 的全部行展开成 raw 行（全部交给 raw 源；profile 门控在产品侧）。
 * @returns {{rows:Array, main:Array, context:Array, counts:object, profile:string, profilePath:string, notes:string[]}}
 */
export function selectProfileRows(fixture, indexes, profile = 'raw-main') {
  const wanted = PROFILES.includes(profile) ? profile : 'raw-main'
  const rows = []
  for (const day of fixture.days ?? []) {
    for (const row of day.rows ?? []) rows.push(toRawRow(row, fixture))
  }
  return {
    rows,
    // 行的"主材料"集合由产品 formationProfile 决定；评测把全部行交给 raw 源（含原文兜底）。
    main: rows,
    context: [],
    counts: countBySource(rows),
    profile: wanted,
    profilePath: 'product-raw',
    notes: [`formationProfile=${wanted} 透传 dream 插件；主材料门控由产品选择器执行（raw-profile.mjs 同一分类器）`],
  }
}

export function countBySource(rows) {
  const counts = {}
  for (const row of rows) counts[row.source] = (counts[row.source] ?? 0) + 1
  return { total: rows.length, ...counts }
}

/** 人读的 profile 说明（报告开头用）。 */
export function profileDescription(profile) {
  if (profile === 'raw-all') return '全部来源进材料（旧无门控基线，仅对照）'
  if (profile === 'raw-human') return 'events/people/lexicon 都只用 human+qq_envelope+unknown'
  return 'events 用 human+qq_envelope+agent_visible+unknown；people/lexicon 只用 human+qq_envelope+unknown（产品目标口径）'
}
