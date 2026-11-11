// retrieval runner：seed（gold 直灌 / formation 产物）→ 每个 probe 以 rowId 时刻为 now →
// 走真实插件路径（recall 工具 / eager-recall 的真实 onTurn / whois / overview）→ SPEC §7.2 指标。
//
// 没有嵌入插槽时 memory.search 走二元组退化路径（产品在无 embedding 时的既有行为），
// 报告里会标注 retrievalPath/no-embed，不假装是向量检索结果。
import { mean, percentile, retrievalProbeMetrics } from './metrics.mjs'
import { dayAtNoon } from './fixture.mjs'

const PROBE_TOP_K = 5

function toItemView(entry) {
  return {
    id: String(entry.id),
    itemId: entry.itemId ?? entry.id,
    kindKey: entry.kindKey ?? entry.namespace,
    namespace: entry.namespace,
    text: String(entry.text ?? ''),
    key: entry.key ?? null,
  }
}

/** --seed gold：把 gold.memories 直接写成 block（person → person 块，其余 → event 块）。 */
export async function seedGold({ hostBox, fixture, indexes, logs = [] }) {
  const memory = hostBox.shared.memory
  const probes = fixture.probes ?? []
  const probeTimes = probes.map((probe) => indexes.rowsById.get(String(probe.rowId))?.atMs).filter((value) => Number.isFinite(value))
  const seedNow = probeTimes.length ? Math.min(...probeTimes) : dayAtNoon(indexes.dayList[0] ?? '1970-01-01', indexes.timezone)
  const items = []
  const idByMemoryId = new Map()
  const entityById = indexes.entitiesById
  for (const gold of fixture.gold?.memories ?? []) {
    const personSubject = /^person:(.+)$/.exec(String(gold.subject ?? ''))
    const subjectEntityId = personSubject ? indexes.entityIdOfSubject?.(gold.subject) ?? null : null
    const entity = subjectEntityId ? entityById.get(String(subjectEntityId)) : null
    const evidence = (gold.evidence ?? [])
      .map((rowId) => indexes.rowsById.get(String(rowId)))
      .filter(Boolean)
      .map((row) => ({ type: 'day', rowId: row.id, line: String(row.text ?? '').slice(0, 160), at: row.atMs }))
    let namespace = 'event'
    let key = `gold:${gold.id}`
    let data = null
    if (String(gold.type) === 'person') {
      namespace = 'person'
      const identity = entity?.ids?.[0] ?? { kind: 'person', value: String(personSubject?.[1] ?? gold.id) }
      key = `person:${identity.value}`
      data = {
        subject: { kind: String(identity.kind ?? 'person'), value: String(identity.value) },
        qq: String(identity.kind) === 'qq' ? String(identity.value) : null,
        ids: entity?.ids ?? [identity],
        aliases: entity?.aliases ?? [],
        familiarity: 'unknown',
        profile: String(gold.text ?? ''),
        evidence,
        facts: [],
        claims: [],
        goldId: String(gold.id),
        goldType: String(gold.type),
        provisional: false,
      }
    } else {
      const day = gold.validFrom
        ?? (evidence.length ? indexes.rowsById.get(String(evidence[0].rowId))?.day : null)
        ?? indexes.dayList[0]
      data = {
        body: String(gold.text ?? ''),
        evidence,
        day,
        people: personSubject ? [String(personSubject[1])] : [],
        tags: [String(gold.type ?? 'fact')],
        goldId: String(gold.id),
        goldType: String(gold.type),
        provisional: false,
      }
    }
    const created = memory.put({ namespace, kind: 'block', key, text: String(gold.text ?? ''), data, now: seedNow })
    // 绑了 embed 插槽时把种子块也索引，否则向量检索没有可比的块向量。
    if (typeof memory.index === 'function') await memory.index(created.id, String(gold.text ?? ''))
    const view = toItemView({ id: created.id, namespace, kindKey: namespace, text: gold.text, key })
    items.push(view)
    idByMemoryId.set(String(gold.id), view.id)
  }
  logs.push({ plugin: 'memory-eval', msg: 'seed.gold', memories: items.length })
  return {
    kind: 'gold',
    seedNow,
    items,
    idByMemoryId,
    unresolvedExpected: 0,
    notes: 'gold.memories → event/person block（evidence 带 rowId；不经过模型）',
  }
}

/** --seed formation：沿用 formation 产物；gold ↔ extracted 用确定性匹配结果换算。 */
export function seedFormation(run) {
  const items = (run.extracted ?? []).map(toItemView)
  const idByMemoryId = new Map()
  for (const pair of run.match?.pairs ?? []) idByMemoryId.set(String(pair.goldId), String(pair.extractedId))
  return {
    kind: 'formation',
    seedNow: null,
    items,
    idByMemoryId,
    unresolvedExpected: (run.match?.unmatchedGold ?? []).length,
    notes: '沿用 formation 的临时库；expected 用确定性匹配的 gold→extracted 换算',
  }
}

/** 把一行渲染文本对回记忆条目：先精确前缀，再 eager 截断前缀；返回最佳 item id。 */
function matchLineToItem(body, items) {
  const text = String(body ?? '').trim()
  if (!text) return null
  const core = text.replace(/…$/, '')
  let best = null
  for (const item of items) {
    const itemText = item.text
    if (!itemText) continue
    let score = 0
    if (text === itemText) score = 1_000_000 + itemText.length
    else if (text.startsWith(itemText)) score = 100_000 + itemText.length
    else if (core.length >= 8 && itemText.startsWith(core)) score = 10_000 + core.length
    if (score > 0 && (!best || score > best.score)) best = { item, score }
  }
  return best?.item ?? null
}

const SKIP_LINE_PREFIXES = ['原文（', '原文：', '依据：', '逐句依据：', '最近提到', '记得的东西', '没找到', '这个范围', '这几条', '你可能记得', '· [人物]']

/**
 * person probe 的查询常常一句里问好几个人（"QQ x 的 A 和 QQ y 的 B 是什么关系？C 又是谁？"）。
 * 真实 agent 会分多次 whois；评测用同一条查询直接调一次会必然 miss，所以这里把查询拆成
 * QQ 号 + 引号里的名字，逐个调用再拼接结果（报告里标 path=whois-tool.multi）。
 */
function personLookupCandidates(query) {
  const text = String(query ?? '').trim()
  if (!text) return []
  const candidates = []
  for (const match of text.matchAll(/\d{5,12}/g)) candidates.push(match[0])
  for (const match of text.matchAll(/[「“"'']([^」”"'']{1,16})[」”"'']/g)) candidates.push(match[1].trim())
  const unique = [...new Set(candidates.filter(Boolean))]
  return unique.length ? unique : [text]
}

function stripTags(line) {
  return String(line).replace(/^(?:\[[^\]]*\]\s*)+/, '').trim()
}

/** overview 的标签不是方括号，而是 `事件 · 昨天 ` / `人物 · 3 天前 ` 前缀。 */
function stripLabel(line) {
  return String(line).replace(/^(?:事件|人物|梗|记忆) · (?:今天|昨天|\d+\s*天前)\s+/, '').trim()
}

/** 解析插件返回文本 → 有序 item id 列表（只认插槽真正返回的记忆行）。 */
export function parseRankedIds(text, items, probeKind = 'recall') {
  const body = String(text ?? '')
  if (!body.trim()) return []
  const ranked = []
  const seen = new Set()
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    if (SKIP_LINE_PREFIXES.some((prefix) => line.startsWith(prefix))) continue
    let candidate = null
    if (probeKind === 'eager') {
      if (!line.startsWith('·')) continue
      candidate = stripTags(line.slice(1).trim())
    } else if (probeKind === 'person') {
      if (!line.startsWith('·')) continue
      candidate = line.slice(1).trim()
      // whois 的第二段/依据行不是档案本身；只有能对上 person block 的才算。
      const personItems = items.filter((item) => item.kindKey === 'person' || item.namespace === 'person')
      const matched = matchLineToItem(candidate, personItems)
      if (!matched) continue
      if (!seen.has(matched.id)) { ranked.push(matched.id); seen.add(matched.id) }
      continue
    } else {
      candidate = stripLabel(stripTags(line))
    }
    if (!candidate) continue
    const matched = matchLineToItem(candidate, items)
    if (!matched) continue
    if (seen.has(matched.id)) continue
    seen.add(matched.id)
    ranked.push(matched.id)
  }
  return ranked
}

function relevantItemIds(probe, corpus) {
  const goldIds = [...(probe.expectedMemoryIds ?? []), ...(probe.expectedAny ?? [])]
  const ids = []
  const unresolved = []
  for (const goldId of goldIds) {
    const itemId = corpus.idByMemoryId.get(String(goldId))
    if (itemId == null) { unresolved.push(String(goldId)); continue }
    if (!ids.includes(String(itemId))) ids.push(String(itemId))
  }
  const mustNotRecallIds = (probe.mustNotRecall ?? [])
    .map((goldId) => corpus.idByMemoryId.get(String(goldId)))
    .filter((id) => id != null)
    .map(String)
  return { ids, unresolved, mustNotRecallIds }
}

async function executeProbe({ probe, hostBox, indexes, items }) {
  const row = indexes.rowsById.get(String(probe.rowId))
  if (!row) throw new Error(`probe ${probe.id} 的 rowId 不存在：${probe.rowId}`)
  const now = row.atMs
  const restoreClock = hostBox.host.services.clock.set(() => now)
  const resetCursor = () => { try { hostBox.shared.recall?.resetCursor?.() } catch { /* ignore */ } }
  const tools = hostBox.tools
  let path = ''
  let text = ''
  const started = Date.now()
  try {
    resetCursor()
    if (probe.kind === 'recall') {
      path = 'recall-tool'
      text = String((await tools.recall.execute({ query: String(probe.query ?? '') }))?.text ?? '')
    } else if (probe.kind === 'eager') {
      // 真实 onTurn：宿主 prompt.turnText 会调用 eager-recall 注册的 provider（不是模拟 memory.search）。
      path = 'eager-recall.onTurn'
      text = String(await hostBox.host.services.prompt.turnText({ message: String(probe.query ?? ''), now }) ?? '')
    } else if (probe.kind === 'person') {
      const query = String(probe.query ?? '').trim()
      const candidates = personLookupCandidates(query)
      path = 'whois-tool'
      const texts = []
      for (const candidate of candidates) {
        const args = /^\d{2,12}$/.test(candidate) ? { qq: candidate } : { name: candidate }
        const out = String((await tools.whois.execute(args))?.text ?? '')
        const miss = !out || out.startsWith('还没有') || out.includes('还没有这个人的档案')
        if (!miss) { texts.push(out); continue }
        const fallback = String((await tools.recall.execute({ kind: 'person', query: candidate }))?.text ?? '')
        if (fallback && !fallback.startsWith('这个范围') && !fallback.startsWith('没找到') && fallback !== out) texts.push(fallback)
      }
      if (candidates.length > 1) path = 'whois-tool.multi'
      text = texts.join('\n')
    } else if (probe.kind === 'overview') {
      path = 'recall-tool.overview'
      // 最近视图：days=30 是插件的上限；fixture 通常只有几天，足够覆盖播种时刻。
      text = String((await tools.recall.execute({ overview: true, days: 30 }))?.text ?? '')
    } else {
      throw new Error(`未知 probe.kind：${probe.kind}`)
    }
  } finally {
    restoreClock()
  }
  const latencyMs = Date.now() - started
  const rankedIds = parseRankedIds(text, items, probe.kind)
  // 调试辅助：记录同一 query 的 memory.search 原始 top-12 分数（不影响指标，放 eval.json 供定位）。
  let debugScores = null
  try {
    if (probe.kind === 'recall' || probe.kind === 'eager') {
      const query = String(probe.query ?? '')
      const hits = await hostBox.shared.memory.search({ query, limit: 12, now })
      debugScores = hits.map((hit) => ({
        id: String(hit.item.id),
        ns: hit.item.namespace,
        kind: hit.item.kind,
        sim: Number(Number(hit.sim).toFixed(3)),
        score: Number(Number(hit.score).toFixed(3)),
        text: String(hit.item.text ?? '').slice(0, 40),
      }))
    }
  } catch { /* 调试信息失败不影响指标 */ }
  return { text, path, latencyMs, rankedIds, debugScores }
}

function aggregate(results) {
  const summary = (group) => {
    const expected = group.filter((entry) => entry.metrics.expectedCount > 0)
    // 有 unresolved expected 的探针不是"应该没有记忆"：我们不知道期望条目是哪一个，
    // 不能把它返回的任何东西算成 false injection（否则会系统性高估误注入）。
    const empty = group.filter((entry) => entry.metrics.expectedCount === 0 && !(entry.unresolvedExpected ?? []).length)
    return {
      probes: group.length,
      withExpected: expected.length,
      recallAt1: mean(expected.map((entry) => entry.metrics.recallAt.recallAt1)),
      recallAt3: mean(expected.map((entry) => entry.metrics.recallAt.recallAt3)),
      recallAt5: mean(expected.map((entry) => entry.metrics.recallAt.recallAt5)),
      mrr: mean(expected.map((entry) => entry.metrics.mrr)),
      ndcgAt10: mean(expected.map((entry) => entry.metrics.ndcgAt10)),
      injectionPrecision: mean(group.map((entry) => entry.metrics.injectionPrecision)),
      missRate: expected.length ? mean(expected.map((entry) => (entry.metrics.miss === true ? 1 : 0))) : null,
      falseInjectionRate: empty.length ? mean(empty.map((entry) => (entry.metrics.falseInjection === true ? 1 : 0))) : null,
      latencyP50: percentile(group.map((entry) => entry.metrics.latencyMs), 50),
      latencyP95: percentile(group.map((entry) => entry.metrics.latencyMs), 95),
      avgReturnedChars: mean(group.map((entry) => entry.metrics.returnedChars)),
      avgInjectedTokensEst: mean(group.map((entry) => Math.ceil(Number(entry.metrics.returnedChars ?? 0) / 2))),
      mustNotRecallViolations: group.reduce((sum, entry) => sum + entry.metrics.mustNotRecallViolations.length, 0),
      unresolvedExpected: group.reduce((sum, entry) => sum + entry.unresolvedExpected.length, 0),
    }
  }
  const byKind = {}
  for (const kind of ['recall', 'eager', 'person', 'overview']) {
    const group = results.filter((entry) => entry.probe.kind === kind)
    if (group.length) byKind[kind] = summary(group)
  }
  return { ...summary(results), byKind }
}

/**
 * 跑 retrieval（宿主与 seed 由调用方准备）。
 * @param {object} options
 * @param {object} options.fixture
 * @param {object} options.indexes
 * @param {object} options.hostBox createEvalHost 的返回值
 * @param {object} options.corpus seedGold/seedFormation 的返回值
 * @param {string} [options.embedding] 嵌入路径说明
 */
export async function runRetrieval({ fixture, indexes, hostBox, corpus, embedding = 'none（未绑定 embed 插槽：memory.search 走二元组退化路径）' }) {
  const items = corpus.items ?? []
  const results = []
  for (const probe of fixture.probes ?? []) {
    const { ids: relevantIds, unresolved, mustNotRecallIds } = relevantItemIds(probe, corpus)
    let execution = null
    let error = null
    try {
      execution = await executeProbe({ probe, hostBox, indexes, items })
    } catch (caught) {
      error = String(caught?.message ?? caught)
    }
    const metrics = retrievalProbeMetrics(probe, execution?.rankedIds ?? [], relevantIds, {
      topK: PROBE_TOP_K,
      mustNotRecallIds,
      returnedChars: execution?.text?.length ?? 0,
      latencyMs: execution?.latencyMs ?? 0,
      path: execution?.path ?? 'error',
    })
    results.push({
      probe,
      metrics,
      error,
      unresolvedExpected: unresolved,
      rankedIds: execution?.rankedIds ?? [],
      returnedText: String(execution?.text ?? ''),
      debugScores: execution?.debugScores ?? null,
      path: execution?.path ?? 'error',
    })
  }
  const metrics = aggregate(results)
  return {
    seed: corpus.kind,
    seededItems: items.length,
    seedNotes: corpus.notes,
    embedding,
    metrics,
    probes: results,
    ledger: { unresolvedSeedExpected: corpus.unresolvedExpected ?? 0 },
  }
}

export { PROBE_TOP_K, aggregate }
