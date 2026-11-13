// formation runner：fixture → 临时库 → 逐天 dream → 导出 → 溯源 → 确定性匹配 → SPEC §7.1 指标。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEvalHost, FORMATION_JOBS, V3_JOBS } from './host.mjs'
import { dayAtHour, identityConfigOf, SELF_SOURCE_KINDS } from './fixture.mjs'
import { selectProfileRows } from './profile.mjs'
import { createProvenance } from './provenance.mjs'
import { matchFormation } from './matcher.mjs'
import {
  duplicateRate, identityMetrics, noiseRate, personBlockWrongIds, prf,
  provenanceRate, selfSourceRate, textSimilarity,
} from './metrics.mjs'

/** v3：从导出条目里取 episode（主单位）与 person 档案（人物 probe 用）。 */
export function extractV3Blocks({ indexes, exported, provenance, entityMatcher, selfEntityValues }) {
  const episodes = []
  const people = []
  for (const item of exported) {
    if (item.data?.superseded === true) continue
    const mapped = provenance.mapItem(item)
    const rowIds = mapped.rowIds.filter((rowId) => indexes.rowsById.has(String(rowId)))
    if (item.namespace === 'episode' && item.kind === 'block') {
      if (Number(item.data?.parts?.part) > 1) continue
      episodes.push({
        id: String(item.id), itemId: item.id, namespace: 'episode', kind: 'block', kindKey: 'episode',
        key: item.key, text: String(item.text ?? ''), body: String(item.data?.body ?? ''),
        data: item.data ?? {}, rowIds, unresolved: mapped.unresolved, day: item.data?.day ?? null,
        ids: [], aliases: [], people: (item.data?.people ?? []).map(String), tags: item.data?.tags ?? [],
        provisional: item.data?.provisional === true, evidenceCount: rowIds.length + (mapped.unresolved?.length ?? 0),
      })
      continue
    }
    if (item.namespace === 'person' && item.kind === 'block') {
      const block = {
        id: String(item.id), itemId: item.id, namespace: 'person', kind: 'block', kindKey: 'person',
        key: item.key, text: String(item.text ?? ''), body: String(item.data?.profile ?? item.data?.body ?? ''),
        data: item.data ?? {}, rowIds, unresolved: mapped.unresolved, day: item.data?.day ?? null,
        ids: Array.isArray(item.data?.ids) ? item.data.ids : [],
        aliases: Array.isArray(item.data?.aliases) ? item.data.aliases : [],
        people: [], tags: Array.isArray(item.data?.tags) ? item.data.tags : [],
        provisional: item.data?.provisional === true, evidenceCount: rowIds.length + (mapped.unresolved?.length ?? 0),
      }
      const matched = entityMatcher.matchPersonBlock(block)
      const selfEntity = matched.entityId != null && selfEntityValues.includes(String(matched.entityId))
      block.matchedEntityId = matched.entityId
      block.matchReason = matched.reason
      block.isSelfEntity = selfEntity
      people.push(block)
    }
  }
  return { episodes, people }
}

/** v3 匹配：gold → episode（证据行覆盖/文本/注释相似）或 person 档案（身份匹配）。 */
export function matchV3({ fixture, indexes, episodes, people, entityMatcher }) {
  const golds = fixture.gold?.memories ?? []
  const candidates = []
  const scoreEpisode = (gold, want, block) => {
    let overlap = 0
    for (const rowId of block.rowIds ?? []) if (want.has(String(rowId))) overlap += 1
    const coverage = want.size ? overlap / want.size : 0
    const textSim = textSimilarity(gold.text, `${block.text ?? ''}\n${block.body ?? ''}`)
    const annotations = block.data?.annotations ?? {}
    const annTexts = [...(annotations.facts ?? []), ...(annotations.preferences ?? []), ...(annotations.commitments ?? [])]
    let annotationSim = 0
    for (const text of annTexts) annotationSim = Math.max(annotationSim, textSimilarity(gold.text, String(text ?? '')))
    // 粗粒度 episode 的证据列表常是"引用了其中几行原话"，不一定逐行覆盖 gold 的全部证据；
    // 再用 gold 内容词在 episode 正文里的出现比例兜底（>=0.45 视为这块讲了这件事）。
    const normalize = (text) => String(text ?? '').toLowerCase().replace(/\s+/g, '')
    const goldText = normalize(gold.text)
    const haystack = normalize(`${block.text ?? ''} ${block.body ?? ''}`)
    const grams = []
    for (let i = 0; i + 1 < goldText.length; i += 1) {
      const gram = goldText.slice(i, i + 2)
      if (/^[\u4e00-\u9fff]{2}$/.test(gram)) grams.push(gram)
    }
    const containment = grams.length ? grams.filter((gram) => haystack.includes(gram)).length / grams.length : 0
    const eligible = want.size
      ? (coverage >= 0.6 || (overlap >= 1 && (textSim >= 0.3 || annotationSim >= 0.5)) || containment >= 0.4)
      : (textSim >= 0.5 || annotationSim >= 0.5 || containment >= 0.5)
    return eligible ? { tier: 1, coverage, textSim, annotationSim, overlap, containment } : null
  }
  for (const gold of golds) {
    const isPerson = String(gold.type) === 'person'
    const want = new Set((gold.evidence ?? []).map(String).filter((rowId) => indexes.rowsById.has(rowId)))
    // person gold 同时挂 person 档案（whois/person 探针）与覆盖它证据的 episode（recall 探针），
    // 两种读路径都能命中同一条 gold。
    const pool = isPerson ? [...people, ...episodes] : episodes
    for (const block of pool) {
      let score = null
      if (isPerson && block.kindKey === 'person') {
        const subjectEntityId = indexes.entityIdOfSubject?.(gold.subject) ?? null
        const ok = subjectEntityId != null
          ? String(block.matchedEntityId) === String(subjectEntityId)
          : Boolean(block.matchedEntityId)
        if (!ok) continue
        score = { tier: 1, coverage: 0, textSim: textSimilarity(gold.text, block.text), annotationSim: 0, overlap: 0 }
      } else {
        score = scoreEpisode(gold, want, block)
        // person gold 的 recall 路径：只要 episode 引用了 gold 的证据行，就把它列入期望目标——
        // 否则 person gold 只映射到 person 档案，recall 探针永远不可能命中（p-03 实测）。
        if (!score && isPerson && block.kindKey === 'episode' && want.size) {
          let overlap = 0
          for (const rowId of block.rowIds ?? []) if (want.has(String(rowId))) overlap += 1
          if (overlap >= 1) {
            score = { tier: 1, coverage: overlap / want.size, textSim: textSimilarity(gold.text, `${block.text ?? ''}\n${block.body ?? ''}`), annotationSim: 0, overlap, containment: 0 }
          }
        }
      }
      if (!score) continue
      candidates.push({ gold, block, score })
    }
  }
  candidates.sort((a, b) =>
    // v3：同一行证据可能被多个 episode 引用；优先选"正文真的讲了这条 gold"的那一块（文本/注释相似度高），
    // 证据覆盖只做次级判据，否则 gold 会被映射到只是引用了同一行的其它 episode。
    ((b.score.textSim + (b.score.annotationSim ?? 0)) - (a.score.textSim + (a.score.annotationSim ?? 0)))
    || ((b.score.containment ?? 0) - (a.score.containment ?? 0))
    || (b.score.coverage - a.score.coverage)
    || String(a.gold.id).localeCompare(String(b.gold.id))
    || String(a.block.id).localeCompare(String(b.block.id)))
  const pairs = []
  const matchedGold = new Set()
  // v3 是多对一、也是"一条 gold 可能被多块 episode 分别讲到"：期望目标最多 3 个 episode
  // （person gold 额外挂 1 条 person 档案），检索命中任一块都算这条 gold 被召回。
  const pairsByGold = new Map()
  for (const candidate of candidates) {
    const goldId = String(candidate.gold.id)
    const blockId = String(candidate.block.id)
    const state = pairsByGold.get(goldId) ?? { person: 0, episode: 0 }
    if (candidate.block.kindKey === 'person' && state.person >= 1) continue
    if (candidate.block.kindKey !== 'person' && state.episode >= 3) continue
    state[candidate.block.kindKey === 'person' ? 'person' : 'episode'] += 1
    pairsByGold.set(goldId, state)
    matchedGold.add(goldId)
    pairs.push({
      goldId, goldType: candidate.gold.type, extractedId: blockId, kindKey: candidate.block.kindKey,
      coverage: candidate.score.coverage, textSim: candidate.score.textSim, reason: 'v3-evidence',
    })
  }
  const unmatchedGold = golds.filter((gold) => !matchedGold.has(String(gold.id))).map((gold) => String(gold.id))
  return { pairs, matchedGold, matchedExtracted: new Set(pairs.map((pair) => pair.extractedId)), unmatchedGold, entityMatcher }
}

/** v3 formation 指标：块粒度/覆盖/注释，不报 v2 的 P/R。 */
export function v3Metrics({ fixture, episodes, match, exported = [] }) {
  const golds = fixture.gold?.memories ?? []
  const byType = {}
  for (const gold of golds) {
    const type = String(gold.type ?? '?')
    byType[type] ??= { total: 0, covered: 0 }
    byType[type].total += 1
    if (match.matchedGold?.has(String(gold.id))) byType[type].covered += 1
  }
  const bodyLens = episodes.map((item) => String(item.body ?? '').length).sort((a, b) => a - b)
  const p = (q) => bodyLens[Math.min(bodyLens.length - 1, Math.floor(bodyLens.length * q))] ?? 0
  const perDay = {}
  for (const item of episodes) { const day = String(item.day ?? '?'); perDay[day] = (perDay[day] ?? 0) + 1 }
  // 内容完整性：不依赖"证据映射是否命中"，直接看 gold 的内容词有多少出现在最好的一块 episode 正文里。
  // 这是防止"命中率靠期望映射筛掉难例"的幸存者偏差指标。
  const normalize = (text) => String(text ?? '').toLowerCase().replace(/\s+/g, '')
  const gramsOf = (text) => {
    const normalized = normalize(text)
    const grams = []
    for (let i = 0; i + 1 < normalized.length; i += 1) {
      const gram = normalized.slice(i, i + 2)
      if (/^[\u4e00-\u9fff]{2}$/.test(gram)) grams.push(gram)
    }
    return grams
  }
  const contentChecks = []
  for (const gold of golds) {
    const grams = gramsOf(gold.text)
    let best = { completeness: 0, episodeId: null }
    for (const item of episodes) {
      const haystack = normalize(`${item.text ?? ''} ${item.body ?? ''}`)
      const hit = grams.filter((gram) => haystack.includes(gram)).length
      const completeness = grams.length ? hit / grams.length : 0
      if (completeness > best.completeness) best = { completeness, episodeId: item.id }
    }
    contentChecks.push({
      goldId: String(gold.id), type: gold.type, completeness: Math.round(best.completeness * 1000) / 1000,
      episodeId: best.episodeId, text: String(gold.text ?? '').slice(0, 120),
    })
  }
  // 材料行覆盖（确定性）：day log 每行原话的内容词是否落在某块 episode 正文/注释里。
  // 只统计真正进入 formation 的材料行（raw-main：真人/她可见的回复/QQ 转述）；工具/推理行不算漏写。
  const episodeHaystack = episodes.map((item) => normalize(`${item.text ?? ''} ${item.body ?? ''} ${JSON.stringify(item.data?.annotations ?? {})} ${JSON.stringify(item.data?.relations ?? [])}`))
  const dayLogLines = []
  for (const item of exported) {
    if (item.namespace !== 'day' || item.kind !== 'log') continue
    const data = item.data ?? {}
    const sources = Array.isArray(data.sources) ? data.sources : []
    const allowedSources = new Set(['human', 'agent_visible', 'qq_envelope', 'unknown'])
    for (const line of String(item.text ?? '').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.length < 8) continue
      const idMatch = /^\[(\d+)\]/.exec(trimmed)
      const source = idMatch ? String(sources[Number(idMatch[1]) - 1] ?? 'unknown') : 'unknown'
      if (!allowedSources.has(source)) continue
      const body = trimmed.replace(/^\[\d+\]\s*(?:\d{1,2}:\d{2}\s*)?(?:[^：:]{0,14}[：:])?/, '').trim()
      if (body.length < 6) continue
      dayLogLines.push(body)
    }
  }
  const lineChecks = dayLogLines.map((line) => {
    const grams = gramsOf(line)
    if (!grams.length) return { line: line.slice(0, 80), coverage: 1, covered: true }
    let best = 0
    for (const haystack of episodeHaystack) {
      const hit = grams.filter((gram) => haystack.includes(gram)).length
      best = Math.max(best, hit / grams.length)
    }
    return { line: line.slice(0, 80), coverage: Math.round(best * 1000) / 1000, covered: best >= 0.45 }
  })
  const coveredLines = lineChecks.filter((row) => row.covered).length
  const materialCoverage = {
    lines: lineChecks.length,
    covered: coveredLines,
    rate: lineChecks.length ? coveredLines / lineChecks.length : null,
    gaps: lineChecks.filter((row) => !row.covered).slice(0, 10),
  }
  const contentCovered = contentChecks.filter((row) => row.completeness >= 0.45).length
  const contentGaps = contentChecks.filter((row) => row.completeness < 0.45).slice(0, 10)
  return {
    episodes: episodes.length,
    days: Object.keys(perDay).length,
    blocksPerDay: Object.values(perDay).length ? episodes.length / Object.values(perDay).length : 0,
    perDay,
    bodyLenAvg: bodyLens.length ? Math.round(bodyLens.reduce((a, b) => a + b, 0) / bodyLens.length) : 0,
    bodyLenP50: p(0.5),
    bodyLenP90: p(0.9),
    evidenceRowsAvg: episodes.length ? Math.round(episodes.reduce((n, item) => n + (item.rowIds?.length ?? 0), 0) / episodes.length) : 0,
    peopleRate: episodes.length ? episodes.filter((item) => (item.people ?? []).length).length / episodes.length : null,
    annotationRates: {
      facts: episodes.filter((item) => (item.data?.annotations?.facts ?? []).length).length,
      preferences: episodes.filter((item) => (item.data?.annotations?.preferences ?? []).length).length,
      commitments: episodes.filter((item) => (item.data?.annotations?.commitments ?? []).length).length,
      relations: episodes.filter((item) => (item.data?.relations ?? []).length).length,
    },
    goldTotal: golds.length,
    goldCovered: match.matchedGold?.size ?? 0,
    goldCoverage: golds.length ? (match.matchedGold?.size ?? 0) / golds.length : null,
    goldByType: byType,
    contentCompletenessAvg: contentChecks.length ? contentChecks.reduce((a, b) => a + b.completeness, 0) / contentChecks.length : null,
    goldContentCovered: contentCovered,
    goldContentRate: contentChecks.length ? contentCovered / contentChecks.length : null,
    contentGaps,
    materialCoverage,
  }
}

function extractItems({ indexes, exported, provenance, entityMatcher, selfEntityValues }) {
  const items = []
  const aux = { notes: 0, dayLogs: 0, dreamRuns: 0, continuationParts: 0, superseded: 0 }
  for (const item of exported) {
    if (item.data?.superseded === true) { aux.superseded += 1; continue }
    if (item.namespace === 'day' && item.kind === 'log') { aux.dayLogs += 1; continue }
    if (item.namespace === 'dream-run') { aux.dreamRuns += 1; continue }
    if (item.kind !== 'block' && item.kind !== 'term') { aux.notes += 1; continue }
    let kindKey = null
    if (item.namespace === 'event' && item.kind === 'block') kindKey = 'event'
    else if (item.namespace === 'person' && item.kind === 'block') kindKey = 'person'
    else if (item.namespace === 'lexicon' && item.kind === 'term') kindKey = 'lexicon'
    // typed memory v2 的 add 层（Phase 2）：事实/偏好/承诺是独立记录，单独计入 formation。
    else if (['fact', 'preference', 'commitment'].includes(item.namespace) && item.kind === 'block') kindKey = item.namespace
    else if (item.namespace === 'slang' && item.kind === 'block') kindKey = 'concept'
    if (!kindKey) continue
    // 长正文拆块（event parts）是同一块的延续，不重复计入 extracted；单独报数。
    if (Number(item.data?.parts?.part) > 1) { aux.continuationParts += 1; continue }
    const mapped = provenance.mapItem(item)
    const rowIds = mapped.rowIds.filter((rowId) => indexes.rowsById.has(String(rowId)))
    const day = item.data?.day ?? (rowIds.length ? indexes.rowsById.get(String(rowIds[0]))?.day : null)
    const block = {
      id: String(item.id),
      itemId: item.id,
      namespace: item.namespace,
      kind: item.kind,
      kindKey,
      key: item.key,
      text: String(item.text ?? ''),
      body: String(item.data?.body ?? item.data?.profile ?? item.data?.meaning ?? item.text ?? ''),
      data: item.data ?? {},
      rowIds,
      unresolved: mapped.unresolved,
      day,
      ids: Array.isArray(item.data?.ids) ? item.data.ids : [],
      aliases: Array.isArray(item.data?.aliases) ? item.data.aliases : [],
      people: Array.isArray(item.data?.people) ? item.data.people.map(String) : [],
      tags: Array.isArray(item.data?.tags) ? item.data.tags : [],
      provisional: item.data?.provisional === true,
      evidenceCount: rowIds.length + mapped.unresolved.length,
    }
    if (kindKey === 'person') {
      const matched = entityMatcher.matchPersonBlock(block)
      const wrongIds = personBlockWrongIds(block, {
        declaredIdPairs: indexes.declaredIdPairs,
        declaredIdValues: indexes.declaredIdValues,
        selfIds: indexes.selfIds,
        groupIds: indexes.groupIds,
        selfEntityValues,
      })
      const selfEntity = matched.entityId != null && selfEntityValues.includes(String(matched.entityId))
      if (selfEntity) {
        // 她自己的 id 出现在自己的档案里不算"错挂"。
        block.wrongIds = wrongIds.filter((wrong) => wrong.reason !== 'self-id-on-other-person')
        block.isSelfEntity = true
      } else {
        block.wrongIds = wrongIds
      }
      block.matchedEntityId = matched.entityId
      block.matchReason = matched.reason
    }
    items.push(block)
  }
  return { items, aux }
}

/**
 * 承诺/偏好更新（构造 gold 的 invalidatedBy 链）是否被正确失效。
 * 口径（不是 SPEC §7.1 必选指标，但 synthetic 场景需要）：
 *   · 旧值匹配到非 superseded 块 → staleOldSurvives=true（旧值还能被回忆，视为未失效）；
 *   · 新值是否形成：匹配到块 = newMatched；没匹配到时再看有没有近似正文的块（newValueInExtracted）；
 *   · superseded 的块不在 extracted 里，所以"旧块被合并/失效"表现为 oldMatched=false。
 */
export function invalidationMetrics({ fixture, extracted, match }) {
  const goldById = new Map((fixture.gold?.memories ?? []).map((memory) => [String(memory.id), memory]))
  const extractedById = new Map((extracted ?? []).map((item) => [String(item.id), item]))
  const extractedByGold = new Map((match?.pairs ?? []).map((pair) => [String(pair.goldId), extractedById.get(String(pair.extractedId))]))
  const cases = []
  for (const gold of fixture.gold?.memories ?? []) {
    const newId = gold.invalidatedBy == null ? null : String(gold.invalidatedBy)
    if (!newId) continue
    const newer = goldById.get(newId) ?? null
    const oldMatch = extractedByGold.get(String(gold.id)) ?? null
    const newMatch = extractedByGold.get(newId) ?? null
    // 新值没被确定性匹配到时，用正文相似度看它有没有以别的块形态落库。
    const similarToNew = newer
      ? (extracted ?? [])
        .map((item) => ({ id: item.id, text: item.text, sim: textSimilarity(newer.text, `${item.text} ${item.body ?? ''}`) }))
        .filter((entry) => entry.sim >= 0.35)
        .sort((a, b) => b.sim - a.sim)
        .slice(0, 2)
      : []
    // 口径修正（2026-11-11 第 5 轮）：旧值只在"同类型 typed 记录"仍存活时才算 stale。
    // 偏好/承诺/事实的旧值常常同时存在于历史事件块里（"那天他说必须喝美式"），
    // 那是真实发生过的历史，不该因为偏好变了就被删；它也不代表"当前认知没更新"。
    const oldType = String(gold.type ?? '')
    const isStateType = ['preference', 'commitment', 'fact'].includes(oldType)
    const oldKind = oldMatch?.kindKey ?? oldMatch?.kind ?? null
    const oldIsTyped = oldKind === oldType
    const oldHistoricalOnly = Boolean(oldMatch) && isStateType && !oldIsTyped
    const staleOldSurvives = Boolean(oldMatch) && (isStateType ? oldIsTyped : true)
    cases.push({
      oldGoldId: String(gold.id),
      oldType: gold.type,
      newGoldId: newId,
      oldMatched: Boolean(oldMatch),
      oldMatchedKind: oldKind,
      oldHistoricalOnly,
      newMatched: Boolean(newMatch),
      staleOldSurvives,
      newTextSeen: similarToNew.length > 0,
      oldExtractedId: oldMatch?.id ?? null,
      newExtractedId: newMatch?.id ?? null,
      newSimilarBlocks: similarToNew,
    })
  }
  const summary = {
    cases: cases.length,
    oldMatched: cases.filter((entry) => entry.oldMatched).length,
    oldHistoricalOnly: cases.filter((entry) => entry.oldHistoricalOnly).length,
    newMatched: cases.filter((entry) => entry.newMatched).length,
    staleOldSurvives: cases.filter((entry) => entry.staleOldSurvives).length,
    newValuePresentButUnmatched: cases.filter((entry) => !entry.newMatched && entry.newTextSeen).length,
    samples: cases,
  }
  return summary
}

function formationMetrics({ fixture, indexes, extracted, aux, match }) {
  const goldMemories = fixture.gold?.memories ?? []
  // SPEC §3：gold 为空时报告写 goldEmpty:true，不参与 P/R（分母为 0 不能伪装成 0 分）。
  const overall = indexes.goldEmpty
    ? { matched: 0, extracted: extracted.length, gold: 0, precision: null, recall: null, f1: null, skipped: 'gold-empty' }
    : prf({ matched: match.pairs.length, extracted: extracted.length, gold: goldMemories.length })
  const typeList = ['fact', 'preference', 'event', 'commitment', 'person', 'relationship', 'concept']
  const byType = {}
  for (const type of typeList) {
    if (indexes.goldEmpty) { byType[type] = { gold: 0, matched: 0, recall: null, extractedMatched: 0 }; continue }
    const goldRows = goldMemories.filter((memory) => String(memory.type) === type)
    const matched = match.pairs.filter((pair) => String(pair.goldType) === type).length
    byType[type] = {
      gold: goldRows.length,
      matched,
      recall: goldRows.length ? matched / goldRows.length : null,
      extractedMatched: matched,
    }
  }
  const kindCounts = extracted.reduce((acc, item) => {
    acc[item.kindKey] = (acc[item.kindKey] ?? 0) + 1
    return acc
  }, {})
  const provenance = provenanceRate(extracted)
  const identity = identityMetrics(extracted.filter((item) => item.kindKey === 'person'))
  // gold 用 entities 表达人物时（没有 person 类型 memory），person 分组按实体口径给数。
  const goldEntityCount = (fixture.gold?.entities ?? []).length
  if (!indexes.goldEmpty && !byType.person.gold && goldEntityCount > 0) {
    byType.person = {
      gold: goldEntityCount,
      matched: identity.matchedEntities,
      recall: goldEntityCount ? identity.matchedEntities / goldEntityCount : null,
      extractedMatched: identity.matchedEntities,
      note: 'gold 未声明 person 类型 memory，这里用 gold.entities 口径（matched=匹配到实体的 person block 数）',
    }
  }
  const selfSource = selfSourceRate(extracted, SELF_SOURCE_KINDS, (rowId) => indexes.rowsById.get(String(rowId))?.source)
  return {
    overall,
    byType,
    counts: { extracted: extracted.length, kinds: kindCounts, aux },
    dedup: duplicateRate(extracted),
    noise: noiseRate(extracted, indexes.noiseRowIds),
    selfSource,
    provenance,
    identity,
    invalidation: invalidationMetrics({ fixture, extracted, match }),
    goldEmpty: indexes.goldEmpty,
    unmatchedGold: match.unmatchedGold,
    matchedPairs: match.pairs,
  }
}

function failureSamples({ fixture, indexes, extracted, match, entityMatcher }) {
  const goldById = new Map((fixture.gold?.memories ?? []).map((memory) => [String(memory.id), memory]))
  const extractedById = new Map(extracted.map((item) => [String(item.id), item]))
  const unmatchedGold = match.unmatchedGold.slice(0, 10).map((goldId) => {
    const gold = goldById.get(String(goldId))
    const diag = match.diagnostics.get(String(goldId))
    return {
      goldId,
      type: gold?.type,
      subject: gold?.subject,
      text: gold?.text,
      evidence: gold?.evidence ?? [],
      nearest: diag ? {
        extractedId: diag.extractedId,
        kindKey: extractedById.get(String(diag.extractedId))?.kindKey,
        text: extractedById.get(String(diag.extractedId))?.text,
        overlap: diag.overlap,
        coverage: diag.coverage,
        textSim: diag.textSim,
        eligible: diag.eligible,
      } : null,
    }
  })
  const unmatchedExtracted = extracted
    .filter((item) => !match.matchedExtracted.has(String(item.id)))
    .slice(0, 10)
    .map((item) => ({
      id: item.id,
      kindKey: item.kindKey,
      text: item.text,
      provisional: item.provisional,
      rowIds: item.rowIds,
      unresolved: item.unresolved.length,
    }))
  const unresolved = []
  for (const item of extracted) {
    for (const entry of item.unresolved ?? []) {
      if (unresolved.length >= 10) break
      unresolved.push({
        extractedId: item.id,
        kindKey: item.kindKey,
        via: entry.via,
        evidence: { type: entry.entry?.type, id: entry.entry?.id, line: entry.entry?.line, at: entry.entry?.at },
        day: entry.day ?? null,
      })
    }
  }
  return { unmatchedGold, unmatchedExtracted, unresolvedEvidence: unresolved }
}

/**
 * 跑一次 formation（独立临时库）。
 * @returns {Promise<{tempRoot:string, host:object, exported:Array, extracted:Array, match:object, metrics:object, samples:object, dayResults:Array, aux:object}>}
 */
export async function runFormation({ fixture, indexes, profile = 'raw-main', model, embedAdapter = null, keepTemp = false, root = null, jobs = null, recallConfig = null, eagerConfig = null, dreamConfig = null, schema = 'v2', partition = 'day', logs = [] }) {
  const effectiveSchema = schema === 'v3' ? 'v3' : 'v2'
  const effectiveJobs = jobs ?? (effectiveSchema === 'v3' ? V3_JOBS : FORMATION_JOBS)
  const effectiveDreamConfig = { ...(dreamConfig ?? {}), ...(effectiveSchema === 'v3' ? { memorySchema: 'v3' } : {}), ...(partition === 'segment' ? { partition: 'segment', segmentCursorInit: 'zero' } : {}) }
  const profileRows = selectProfileRows(fixture, indexes, profile)
  // root 指定时用固定目录（重建/续跑用），否则每次新建临时库（评测用）。
  const tempRoot = root ? path.resolve(root) : fs.mkdtempSync(path.join(os.tmpdir(), 'icl-memory-eval-'))
  const persistentRoot = Boolean(root) || keepTemp
  const hostBox = await createEvalHost({
    root: tempRoot,
    model,
    embedAdapter,
    timezone: indexes.timezone,
    identity: identityConfigOf(fixture),
    formationProfile: profileRows.profile,
    mainRows: profileRows.main,
    contextRows: profileRows.context,
    ...(recallConfig ? { recallConfig } : {}),
    ...(eagerConfig ? { eagerConfig } : {}),
    ...(effectiveDreamConfig && Object.keys(effectiveDreamConfig).length ? { dreamConfig: effectiveDreamConfig } : {}),
    logs,
  })
  const dayResults = []
  try {
    for (const day of fixture.days ?? []) {
      // replay 约定：当天记忆在 00:00 视为已整理完（同日任意探针可见，未来天不可见；host 关掉 dayCutHour）。
      // day 模式：当天 00:00 视为已整理（评测约定）；segment 模式：dream 在当天结束时切段，才能包含全天材料。
      const now = partition === 'segment' ? dayAtHour(day.day, 23, indexes.timezone) + 59 * 60_000 + 999 : dayAtHour(day.day, 0, indexes.timezone)
      let result = null
      try {
        result = await hostBox.shared.dream.run({ now, jobs: [...effectiveJobs] })
      } catch (error) {
        result = { ok: false, day: day.day, results: [], error: String(error?.message ?? error) }
      }
      dayResults.push({
        day: day.day,
        ok: result?.ok !== false,
        dayKey: result?.day ?? null,
        results: (result?.results ?? []).map((row) => ({
          job: row.job,
          ok: row.ok !== false,
          skipped: row.skipped ?? null,
          blocks: row.blocks ?? null,
          failedShards: row.failedShards ?? null,
          degraded: row.degraded === true,
          error: row.error ?? null,
        })),
        ...(result?.error ? { error: result.error } : {}),
      })
      // --embed 时 dream 里有很多 `void memory.index(...)` 异步调用：每天收尾等一下，避免堆积/关库竞态。
      if (embedAdapter) await hostBox.drain()
    }
    const exported = hostBox.shared.memory.exportAll?.()?.items ?? []
    const provenance = createProvenance(fixture, indexes, exported)
    // 先把 entity matcher 建出来（extractItems 里要用它算 person 身份指标）。
    const probeMatch = matchFormation({ fixture, indexes, extracted: [] })
    const selfEntityValues = (fixture.gold?.entities ?? [])
      .filter((entity) => {
        const ids = (entity.ids ?? []).map((id) => String(id.value))
        const name = String(entity.name ?? '').toLowerCase()
        return ids.some((value) => indexes.selfIds.has(value)) || name === String(fixture.persona?.self?.name ?? '').toLowerCase()
      })
      .map((entity) => String(entity.id))
    // v3：episode 为主单位；gold→episode 用证据行覆盖/文本/注释相似匹配。
    let schemaExtras = null
    if (effectiveSchema === 'v3') {
      const { episodes, people } = extractV3Blocks({ indexes, exported, provenance, entityMatcher: probeMatch.entityMatcher, selfEntityValues })
      const v3Match = matchV3({ fixture, indexes, episodes, people, entityMatcher: probeMatch.entityMatcher })
      schemaExtras = { episodes, people, match: v3Match, metrics: v3Metrics({ fixture, episodes, match: v3Match, exported }) }
    }
    const { items: extractedV2, aux } = extractItems({
      indexes, exported, provenance,
      entityMatcher: probeMatch.entityMatcher,
      selfEntityValues,
    })
    const extracted = schemaExtras ? [...schemaExtras.episodes, ...schemaExtras.people] : extractedV2
    const match = schemaExtras
      ? schemaExtras.match
      : matchFormation({ fixture, indexes, extracted })
    const metrics = schemaExtras
      ? { ...formationMetrics({ fixture, indexes, extracted: [], aux, match: { pairs: [], matchedGold: new Set(), unmatchedGold: [] } }), schema: 'v3', v3: schemaExtras.metrics }
      : formationMetrics({ fixture, indexes, extracted, aux, match })
    // typed v2 entity 层指标（Phase 3）：只看覆盖率/悬空引用，不参与 P/R、不改召回。
    const entityRows = exported.filter((item) => item.namespace === 'entity' && item.kind === 'entity')
    const personBlockRows = exported.filter((item) => item.namespace === 'person' && item.kind === 'block' && item.data?.superseded !== true)
    const typedBlockRows = exported.filter((item) => ['fact', 'preference', 'commitment'].includes(item.namespace) && item.kind === 'block' && item.data?.superseded !== true)
    const eventBlockRows = exported.filter((item) => item.namespace === 'event' && item.kind === 'block' && item.data?.superseded !== true)
    const entityKeys = new Set(entityRows.map((item) => item.key))
    const referencedEntityKeys = [
      ...personBlockRows.map((item) => item.data?.entityId),
      ...typedBlockRows.map((item) => item.data?.subjectEntity),
      ...eventBlockRows.flatMap((item) => (Array.isArray(item.data?.entities) ? item.data.entities : [])),
    ].filter(Boolean)
    const relationRows = exported.filter((item) => item.namespace === 'relation' && item.kind === 'relation' && item.data?.superseded !== true)
    metrics.entity = {
      entities: entityRows.length,
      personCoverage: personBlockRows.length ? personBlockRows.filter((item) => item.data?.entityId).length / personBlockRows.length : null,
      typedCoverage: typedBlockRows.length ? typedBlockRows.filter((item) => item.data?.subjectEntity).length / typedBlockRows.length : null,
      eventCoverage: eventBlockRows.length ? eventBlockRows.filter((item) => Array.isArray(item.data?.entities) && item.data.entities.length).length / eventBlockRows.length : null,
      stubs: entityRows.filter((item) => item.data?.stub === true).length,
      danglingRefs: referencedEntityKeys.filter((key) => !entityKeys.has(key)).length,
      relations: relationRows.length,
      relationDangling: relationRows.filter((item) => !entityKeys.has(String(item.data?.from ?? '')) || !entityKeys.has(String(item.data?.to ?? ''))).length,
    }
    const goldByIdForSamples = new Map((fixture.gold?.memories ?? []).map((memory) => [String(memory.id), memory]))
    const samples = schemaExtras
      ? {
        unmatchedGold: (schemaExtras.match.unmatchedGold ?? []).slice(0, 10).map((goldId) => {
          const gold = goldByIdForSamples.get(String(goldId))
          return { goldId, type: gold?.type, subject: gold?.subject, text: gold?.text, evidence: gold?.evidence ?? [], nearest: null }
        }),
        unmatchedExtracted: [],
        unresolvedEvidence: [],
      }
      : failureSamples({ fixture, indexes, extracted, match })
    return {
      tempRoot,
      host: hostBox,
      exported,
      extracted,
      match,
      metrics,
      samples,
      dayResults,
      aux,
      profile: profileRows.profile,
      profilePath: profileRows.profilePath,
      profileNotes: profileRows.notes,
      profileCounts: profileRows.counts,
      rawMainCount: profileRows.main.length,
      rawContextCount: profileRows.context.length,
      modelStats: model.stats(),
      keepTemp,
      persistentRoot,
    }
  } catch (error) {
    try { await hostBox.dispose() } catch { /* ignore */ }
    try { if (!persistentRoot) fs.rmSync(tempRoot, { recursive: true, force: true }) } catch { /* ignore */ }
    throw error
  }
}

/** 释放 formation 宿主；keepTemp=false 时顺带删临时库。 */
export async function closeFormation(run) {
  try { await run.host?.dispose?.() } catch { /* ignore */ }
  if (run?.persistentRoot !== true) {
    try { fs.rmSync(run.tempRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}







