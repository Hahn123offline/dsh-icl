// formation runner：fixture → 临时库 → 逐天 dream → 导出 → 溯源 → 确定性匹配 → SPEC §7.1 指标。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEvalHost, FORMATION_JOBS } from './host.mjs'
import { dayAtHour, identityConfigOf, SELF_SOURCE_KINDS } from './fixture.mjs'
import { selectProfileRows } from './profile.mjs'
import { createProvenance } from './provenance.mjs'
import { matchFormation } from './matcher.mjs'
import {
  duplicateRate, identityMetrics, noiseRate, personBlockWrongIds, prf,
  provenanceRate, selfSourceRate, textSimilarity,
} from './metrics.mjs'

/** 从导出条目里挑出"落库的块"，并解析 evidence → fixture rowId。 */
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
export async function runFormation({ fixture, indexes, profile = 'raw-main', model, embedAdapter = null, keepTemp = false, jobs = FORMATION_JOBS, recallConfig = null, eagerConfig = null, logs = [] }) {
  const profileRows = selectProfileRows(fixture, indexes, profile)
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-memory-eval-'))
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
    logs,
  })
  const dayResults = []
  try {
    for (const day of fixture.days ?? []) {
      // replay 约定：当天记忆在 00:00 视为已整理完（同日任意探针可见，未来天不可见；host 关掉 dayCutHour）。
      const now = dayAtHour(day.day, 0, indexes.timezone)
      let result = null
      try {
        result = await hostBox.shared.dream.run({ now, jobs: [...jobs] })
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
    const { items: extracted, aux } = extractItems({
      indexes, exported, provenance,
      entityMatcher: probeMatch.entityMatcher,
      selfEntityValues,
    })
    const match = matchFormation({ fixture, indexes, extracted })
    const metrics = formationMetrics({ fixture, indexes, extracted, aux, match })
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
    const samples = failureSamples({ fixture, indexes, extracted, match })
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
    }
  } catch (error) {
    try { await hostBox.dispose() } catch { /* ignore */ }
    try { if (!keepTemp) fs.rmSync(tempRoot, { recursive: true, force: true }) } catch { /* ignore */ }
    throw error
  }
}

/** 释放 formation 宿主；keepTemp=false 时顺带删临时库。 */
export async function closeFormation(run) {
  try { await run.host?.dispose?.() } catch { /* ignore */ }
  if (run?.keepTemp !== true) {
    try { fs.rmSync(run.tempRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}


