// 确定性 gold ↔ extracted 匹配（默认不调 LLM，SPEC §6.2）。
//
// 规则：
//   · person：ids/aliases 与 gold entity 有交集；文本相似只作 tie-break；
//   · event/fact/preference/commitment/relationship/concept：
//       证据行重叠 ≥1 且（规范化 bigram Jaccard ≥0.3 或 同 subject/同天）；
//       或 gold 的 evidence 被某条 extracted 完整覆盖；
//   · 一条 extracted 最多配一条 gold，贪心按证据重合度降序。
import { normalizeText, textSimilarity } from './metrics.mjs'

function declaredValuesOfEntity(entity) {
  const values = new Set()
  for (const id of entity?.ids ?? []) values.add(String(id.value))
  if (entity?.name) values.add(String(entity.name))
  for (const alias of entity?.aliases ?? []) values.add(String(alias))
  return values
}

function normalizedSetOf(values) {
  return new Set((values ?? []).map((value) => normalizeText(value)).filter(Boolean))
}

/** 建 person block → gold entity 的匹配器（供 formation 与 identity 指标共用）。 */
export function createEntityMatcher(fixture) {
  const entities = fixture.gold?.entities ?? []
  const prepared = entities.map((entity) => ({
    entity,
    pairs: new Set((entity.ids ?? []).map((id) => `${id.kind}:${id.value}`)),
    values: declaredValuesOfEntity(entity),
    normalized: normalizedSetOf([entity.name, ...(entity.aliases ?? [])]),
  }))

  /**
   * @returns {{entityId:string|null, score:number, textSim:number, reason:string, ambiguous:boolean}}
   */
  function matchPersonBlock(block) {
    const idPairs = new Set((block.ids ?? []).map((id) => `${id.kind}:${id.value}`))
    const idValues = new Set((block.ids ?? []).map((id) => String(id.value)))
    const subject = block.data?.subject
    if (subject?.value) idValues.add(String(subject.value))
    const blockAliases = normalizedSetOf([...(block.aliases ?? []), ...(block.data?.aliases ?? [])])
    const text = `${block.text ?? ''}\n${block.data?.profile ?? ''}`
    const candidates = []
    for (const entry of prepared) {
      let score = 0
      let reason = ''
      if ([...idPairs].some((pair) => entry.pairs.has(pair))) { score = 3; reason = 'exact-id' }
      else if ([...idValues].some((value) => entry.values.has(value))) { score = 2; reason = 'id-value' }
      else if ([...blockAliases].some((value) => entry.normalized.has(value))) { score = 2; reason = 'alias' }
      else {
        const sim = textSimilarity(text, entry.entity.name)
        if (sim >= 0.5) { score = 1; reason = 'text-similarity' }
        candidates.push({ entityId: entry.entity.id, score, reason, textSim: sim })
        continue
      }
      candidates.push({ entityId: entry.entity.id, score, reason, textSim: textSimilarity(text, `${entry.entity.name}${entry.entity.aliases?.join('') ?? ''}`) })
    }
    candidates.sort((a, b) => b.score - a.score || b.textSim - a.textSim || String(a.entityId).localeCompare(String(b.entityId)))
    const best = candidates[0]
    if (!best || best.score < 2) return { entityId: null, score: 0, textSim: best?.textSim ?? 0, reason: 'none', ambiguous: false }
    const ambiguous = candidates.length > 1 && candidates[1].score === best.score && candidates[1].entityId !== best.entityId
    return { ...best, ambiguous }
  }

  return { matchPersonBlock, entities: prepared.map((entry) => entry.entity) }
}

function daysOfEvidence(evidenceIds, indexes) {
  const days = new Set()
  for (const rowId of evidenceIds ?? []) {
    const row = indexes.rowsById.get(String(rowId))
    if (row) days.add(row.day)
  }
  return days
}

/** 非 person 类 gold 的候选评分（供贪心与失败诊断复用）。 */
function scoreEventCandidate(gold, block, indexes) {
  const goldEvidence = (gold.evidence ?? []).map(String)
  const blockRowIds = new Set((block.rowIds ?? []).map(String))
  const overlap = goldEvidence.filter((rowId) => blockRowIds.has(rowId))
  const coverage = goldEvidence.length ? overlap.length / goldEvidence.length : 0
  const fullCoverage = goldEvidence.length > 0 && overlap.length === goldEvidence.length
  const textSim = textSimilarity(gold.text, `${block.text ?? ''} ${block.body ?? ''}`)
  let sameSubject = false
  if (/^person:/.test(String(gold.subject ?? ''))) {
    const entityId = indexes.entityIdOfSubject?.(gold.subject) ?? null
    const entity = entityId ? indexes.entitiesById.get(String(entityId)) : null
    const values = new Set([
      /^person:(.+)$/.exec(String(gold.subject))?.[1],
      entityId,
      ...(entity?.ids ?? []).map((id) => String(id.value)),
    ].filter(Boolean).map(String))
    sameSubject = (block.people ?? []).map(String).some((value) => values.has(value))
      || values.has(String(block.data?.subject?.value ?? ''))
  }
  const sameDay = Boolean(block.day) && daysOfEvidence(goldEvidence, indexes).has(block.day)
  const eligible = fullCoverage || (overlap.length >= 1 && (textSim >= 0.3 || sameSubject || sameDay))
  return { overlap: overlap.length, coverage, textSim, sameSubject, sameDay, fullCoverage, eligible }
}

/**
 * 跑确定性匹配。
 * @param {object} options
 * @param {object} options.fixture
 * @param {object} options.indexes
 * @param {Array} options.extracted 每条 {id, kindKey, text, body, rowIds, day, ids, aliases, data}
 * @returns {{pairs:Array, matchedGold:Set, matchedExtracted:Set, unmatchedGold:Array, diagnostics:Map}}
 */
export function matchFormation({ fixture, indexes, extracted }) {
  const entityMatcher = createEntityMatcher(fixture)
  const goldMemories = fixture.gold?.memories ?? []
  const eventBlocks = (extracted ?? []).filter((item) => item.kindKey === 'event')
  const personBlocks = (extracted ?? []).filter((item) => item.kindKey === 'person')
  const candidates = []
  const diagnostics = new Map()

  for (const gold of goldMemories) {
    const isPerson = String(gold.type) === 'person'
    const pool = isPerson ? personBlocks : eventBlocks
    let best = null
    for (const block of pool) {
      let score = null
      if (isPerson) {
        const matched = entityMatcher.matchPersonBlock(block)
        // 期望 entity 必须就是 block 匹配到的那个（不同人不能被算成命中）。
        const subjectEntityId = indexes.entityIdOfSubject?.(gold.subject) ?? null
        const subjectOk = subjectEntityId != null
          ? String(matched.entityId) === String(subjectEntityId)
          : Boolean(matched.entityId)
        score = {
          tier: subjectOk ? matched.score : 0,
          coverage: 0,
          textSim: textSimilarity(gold.text, block.text),
          ambiguous: matched.ambiguous,
          reason: matched.reason,
          entityId: matched.entityId,
        }
      } else {
        const scored = scoreEventCandidate(gold, block, indexes)
        score = { tier: scored.eligible ? 1 : 0, ...scored, reason: scored.fullCoverage ? 'evidence-covered' : (scored.textSim >= 0.3 ? 'text' : (scored.sameSubject ? 'subject' : 'day')) }
      }
      const candidate = { gold, block, score }
      if (!best || compareCandidates(candidate, best) < 0) best = candidate
      if (score.tier > 0) candidates.push(candidate)
    }
    diagnostics.set(String(gold.id), best ? {
      extractedId: best.block.id,
      overlap: best.score.overlap ?? 0,
      coverage: best.score.coverage ?? 0,
      textSim: best.score.textSim ?? 0,
      reason: best.score.reason ?? 'none',
      eligible: (best.score.tier ?? 0) > 0,
    } : null)
  }

  // 贪心：证据覆盖度优先，再文本相似，再稳定 id；一条 extracted 只能配一条 gold。
  candidates.sort((a, b) => compareCandidates(a, b))
  const pairs = []
  const matchedGold = new Set()
  const matchedExtracted = new Set()
  for (const candidate of candidates) {
    const goldId = String(candidate.gold.id)
    const extractedId = String(candidate.block.id)
    if (matchedGold.has(goldId) || matchedExtracted.has(extractedId)) continue
    matchedGold.add(goldId)
    matchedExtracted.add(extractedId)
    pairs.push({
      goldId,
      goldType: candidate.gold.type,
      extractedId,
      kindKey: candidate.block.kindKey,
      coverage: candidate.score.coverage ?? 0,
      textSim: candidate.score.textSim ?? 0,
      reason: candidate.score.reason,
      entityId: candidate.score.entityId ?? null,
    })
  }
  const unmatchedGold = goldMemories.filter((gold) => !matchedGold.has(String(gold.id))).map((gold) => String(gold.id))
  return { pairs, matchedGold, matchedExtracted, unmatchedGold, diagnostics, entityMatcher }
}

function compareCandidates(a, b) {
  const tierDiff = (b.score.tier ?? 0) - (a.score.tier ?? 0)
  if (tierDiff) return tierDiff
  const coverageDiff = (b.score.coverage ?? 0) - (a.score.coverage ?? 0)
  if (coverageDiff) return coverageDiff
  const textDiff = (b.score.textSim ?? 0) - (a.score.textSim ?? 0)
  if (textDiff) return textDiff
  const goldDiff = String(a.gold.id).localeCompare(String(b.gold.id))
  if (goldDiff) return goldDiff
  return String(a.block.id).localeCompare(String(b.block.id))
}
