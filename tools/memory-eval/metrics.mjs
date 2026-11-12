// 指标纯函数：P/R/F1、重复率、身份、溯源、检索 recall@k/MRR/NDCG、幂等。
//
// 这里不碰 fixture / 插件，只接收已算好的 extracted/gold 视图，方便单测手算核对。
// 口径见 docs/MEMORY-EVAL-SPEC.md §7；每个函数都显式写出 null 语义（0 分母不冒充 0 分）。

/* ── 文本 ─────────────────────────────────────────────────────── */

/** 规范化：小写、去掉空白与标点，只留字母/数字/汉字（比较用，不展示）。 */
export function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。！？、；：“”‘’"'`~!@#$%^&*()_+\-=[\]{}|\\<>/.,:;?]+/g, '')
}

export function bigramSet(value) {
  const text = normalizeText(value)
  const set = new Set()
  for (let i = 0; i < text.length - 1; i += 1) set.add(text.slice(i, i + 2))
  return set
}

/** 集合 Jaccard；两边都空算 1（同一"空文本"视为相同）。 */
export function jaccard(a, b) {
  const setA = a instanceof Set ? a : new Set(a ?? [])
  const setB = b instanceof Set ? b : new Set(b ?? [])
  if (!setA.size && !setB.size) return 1
  let inter = 0
  for (const value of setA) if (setB.has(value)) inter += 1
  const union = setA.size + setB.size - inter
  return union ? inter / union : 0
}

/** 规范化文本的 bigram Jaccard（SPEC §6.2 的相似度口径）。 */
export function textSimilarity(a, b) {
  return jaccard(bigramSet(a), bigramSet(b))
}

/* ── formation 指标（SPEC §7.1）──────────────────────────────── */

/** P/R/F1；分母为 0 时返回 null（"没有可算的"不能伪装成 0 分或满分）。 */
export function prf({ matched = 0, extracted = 0, gold = 0 } = {}) {
  const precision = extracted > 0 ? matched / extracted : null
  const recall = gold > 0 ? matched / gold : null
  const f1 = precision != null && recall != null && precision + recall > 0
    ? (2 * precision * recall) / (precision + recall)
    : null
  return { matched, extracted, gold, precision, recall, f1 }
}

const DUP_KINDS = new Set(['event', 'person', 'fact', 'commitment'])

/**
 * 重复率：extracted 里与另一条"近重复"的比例。
 * 近重复 = 同 kind 且（规范化正文 bigram Jaccard ≥ textThreshold 或 证据集合 Jaccard ≥ evidenceThreshold）。
 * 口径（2026-11-11 Lead 确认）：lexicon/concept 默认不参与（同名重复由 term 唯一键保证）；
 * 两边证据都为空不算"证据重合"；规范化短文本（<12 字）要求 textSim≥0.9，避免短词互撞。
 * @param {Array<{id:any, kindKey:string, text:string, rowIds:string[]}>} extracted
 */
export function duplicateRate(extracted, {
  textThreshold = 0.6,
  evidenceThreshold = 0.8,
  kinds = DUP_KINDS,
  shortTextLength = 12,
  shortTextThreshold = 0.9,
} = {}) {
  const list = extracted ?? []
  const kindSet = kinds instanceof Set ? kinds : new Set(kinds ?? [])
  const pairs = []
  const involved = new Set()
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i]
      const b = list[j]
      if (String(a.kindKey) !== String(b.kindKey)) continue
      if (!kindSet.has(String(a.kindKey))) continue
      const textA = normalizeText(a.text)
      const textB = normalizeText(b.text)
      if (!textA.length && !textB.length) continue
      const textSim = jaccard(bigramSet(a.text), bigramSet(b.text))
      const evidenceA = a.rowIds ?? []
      const evidenceB = b.rowIds ?? []
      // 两边都没有证据：不是"证据 100% 重合"，只是都没出处（交给 provenanceRate/noiseRate 计）。
      const evidenceSim = evidenceA.length || evidenceB.length ? jaccard(evidenceA, evidenceB) : 0
      const effectiveTextThreshold = Math.min(textA.length, textB.length) < shortTextLength
        ? shortTextThreshold
        : textThreshold
      // shared evidence alone 不能算重复：同一段对话里抽出的多条 typed 事实（fact/preference/…）
      // 天然共享 evidence；只有"证据重合且正文也相似"才是重复块。
      if (textSim >= effectiveTextThreshold || (evidenceSim >= evidenceThreshold && textSim >= 0.3)) {
        pairs.push({ a: a.id, b: b.id, textSim, evidenceSim })
        involved.add(a.id)
        involved.add(b.id)
      }
    }
  }
  return {
    rate: list.length ? involved.size / list.length : null,
    involved: involved.size,
    extracted: list.length,
    pairs: pairs.length,
    samples: pairs.slice(0, 10),
  }
}

/** 噪音率：证据全落在 gold.noise 行、或没解析出任何证据的比例。 */
export function noiseRate(extracted, noiseRowIds) {
  const list = extracted ?? []
  const noise = noiseRowIds instanceof Set ? noiseRowIds : new Set(noiseRowIds ?? [])
  const items = list.filter((item) => {
    const rowIds = item.rowIds ?? []
    return rowIds.length === 0 || rowIds.every((rowId) => noise.has(String(rowId)))
  })
  return { rate: list.length ? items.length / list.length : null, count: items.length, extracted: list.length }
}

/**
 * 自源率：证据全部来自她自己的输出/工具/环境（SPEC §7.1 的字面集合）。
 * @param {Array} extracted 每条带 rowIds
 * @param {Set<string>} selfSourceKinds 默认 {agent_visible, agent_internal, tool, env}
 * @param {(rowId:string)=>string} sourceOfRow
 */
export function selfSourceRate(extracted, selfSourceKinds, sourceOfRow) {
  const kinds = selfSourceKinds instanceof Set ? selfSourceKinds : new Set(selfSourceKinds ?? [])
  const list = extracted ?? []
  const items = list.filter((item) => {
    const rowIds = item.rowIds ?? []
    if (!rowIds.length) return false
    return rowIds.every((rowId) => kinds.has(String(sourceOfRow(rowId) ?? '')))
  })
  return { rate: list.length ? items.length / list.length : null, count: items.length, extracted: list.length }
}

/** 溯源率：至少 1 条证据解析到 fixture row 的比例。未解析条数单列，失败样本可定位。 */
export function provenanceRate(extracted) {
  const list = extracted ?? []
  const resolved = list.filter((item) => (item.rowIds ?? []).length > 0)
  const unresolvedEntries = list.reduce((n, item) => n + (item.unresolved?.length ?? 0), 0)
  const totalEntries = list.reduce((n, item) => n + (item.rowIds?.length ?? 0) + (item.unresolved?.length ?? 0), 0)
  return {
    rate: list.length ? resolved.length / list.length : null,
    resolved: resolved.length,
    extracted: list.length,
    unresolvedEntries,
    evidenceEntries: totalEntries,
  }
}

/**
 * person 身份证错误判定（SPEC §7.1 wrongIdRate 的三个口径）。
 * @returns {Array<{kind:string, value:string, reason:string}>}
 */
export function personBlockWrongIds(block, { declaredIdPairs, declaredIdValues, selfIds, groupIds, selfEntityValues = [] } = {}) {
  const wrong = []
  const pairs = declaredIdPairs instanceof Set ? declaredIdPairs : new Set(declaredIdPairs ?? [])
  const values = declaredIdValues instanceof Set ? declaredIdValues : new Set(declaredIdValues ?? [])
  const selfValues = selfIds instanceof Set ? selfIds : new Set(selfIds ?? [])
  const groups = groupIds instanceof Set ? groupIds : new Set(groupIds ?? [])
  for (const id of block?.ids ?? []) {
    const kind = String(id?.kind ?? '')
    const value = String(id?.value ?? '')
    if (!value) continue
    // 先判两个"会造成身份污染"的硬错误，再看是否声明过（她自己/主人 id 也可能被合法声明）。
    if (kind === 'qq' && groups.has(value)) { wrong.push({ kind, value, reason: 'group-id-as-qq' }); continue }
    if (selfValues.has(value) && !selfEntityValues.includes(value) && !block.isSelfEntity) {
      wrong.push({ kind, value, reason: 'self-id-on-other-person' })
      continue
    }
    if (pairs.has(`${kind}:${value}`) || values.has(value)) continue
    wrong.push({ kind, value, reason: 'undeclared-id' })
  }
  return wrong
}

/** 汇总 person 身份指标；personBlocks 里每块带 `wrongIds` / `matchedEntityId`。 */
export function identityMetrics(personBlocks) {
  const list = personBlocks ?? []
  const matched = list.filter((block) => block.matchedEntityId != null)
  const wrong = list.filter((block) => (block.wrongIds ?? []).length > 0)
  return {
    personBlocks: list.length,
    matchedEntities: matched.length,
    identity: list.length ? matched.length / list.length : null,
    wrongIdBlocks: wrong.length,
    wrongIdRate: list.length ? wrong.length / list.length : null,
    wrongIdSamples: wrong.slice(0, 10).map((block) => ({ id: block.id, key: block.key, text: block.text, wrongIds: block.wrongIds })),
  }
}

/* ── retrieval 指标（SPEC §7.2）──────────────────────────────── */

export function recallAtK(rankedIds, relevantIds, k) {
  const relevant = new Set((relevantIds ?? []).map(String))
  if (!relevant.size) return null
  const top = (rankedIds ?? []).slice(0, k).map(String)
  let hit = 0
  for (const id of new Set(top)) if (relevant.has(id)) hit += 1
  return hit / relevant.size
}

/** MRR：第一个相关结果的倒数排名；没有相关集返回 null。 */
export function mrr(rankedIds, relevantIds) {
  const relevant = new Set((relevantIds ?? []).map(String))
  if (!relevant.size) return null
  const rank = (rankedIds ?? []).findIndex((id) => relevant.has(String(id)))
  return rank >= 0 ? 1 / (rank + 1) : 0
}

/** NDCG@k（二元相关，对数折扣）。 */
export function ndcgAtK(rankedIds, relevantIds, k = 10) {
  const relevant = new Set((relevantIds ?? []).map(String))
  if (!relevant.size) return null
  let dcg = 0
  let idcg = 0
  const top = (rankedIds ?? []).slice(0, k)
  for (let i = 0; i < top.length; i += 1) {
    if (relevant.has(String(top[i]))) dcg += 1 / Math.log2(i + 2)
  }
  const ideal = Math.min(k, relevant.size)
  for (let i = 0; i < ideal; i += 1) idcg += 1 / Math.log2(i + 2)
  return idcg ? dcg / idcg : 0
}

/** 注入精度：返回的 top-k 里命中相关集的比例（没有返回物则 null）。 */
export function injectionPrecision(rankedIds, relevantIds, k = 5) {
  const top = (rankedIds ?? []).slice(0, k)
  if (!top.length) return null
  const relevant = new Set((relevantIds ?? []).map(String))
  const hit = top.filter((id) => relevant.has(String(id))).length
  return hit / top.length
}

export function mean(values) {
  const nums = (values ?? []).filter((value) => value != null && Number.isFinite(Number(value))).map(Number)
  if (!nums.length) return null
  return nums.reduce((sum, value) => sum + value, 0) / nums.length
}

/** 分位数（p=0.5/0.95），空数组返回 null。 */
export function percentile(values, p) {
  const nums = (values ?? []).filter((value) => Number.isFinite(Number(value))).map(Number).sort((a, b) => a - b)
  if (!nums.length) return null
  const index = Math.min(nums.length - 1, Math.max(0, Math.ceil((p / 100) * nums.length) - 1))
  return nums[index]
}

/**
 * 一次检索探针的指标。
 * @param {object} probe
 * @param {string[]} rankedIds 插件真实返回顺序
 * @param {string[]} relevantIds 期望命中的 item id
 * @param {object} options {k, topK, mustNotRecallIds, returnedChars, latencyMs}
 */
export function retrievalProbeMetrics(probe, rankedIds, relevantIds, options = {}) {
  const k = options.k ?? [1, 3, 5]
  const topK = Number(options.topK ?? 5)
  const ranked = rankedIds ?? []
  const relevant = relevantIds ?? []
  const hitTopK = ranked.slice(0, topK).filter((id) => relevant.map(String).includes(String(id)))
  const relevantSet = new Set(relevant.map(String))
  const anyHitAt = Object.fromEntries(k.map((n) => [`anyHitAt${n}`, ranked.slice(0, n).some((id) => relevantSet.has(String(id))) ? 1 : 0]))
  const mustNotRecall = options.mustNotRecallIds ?? []
  return {
    probeId: probe.id,
    kind: probe.kind,
    query: probe.query,
    expectedIds: relevant,
    returnedIds: ranked.slice(0, topK),
    returnedCount: ranked.length,
    expectedCount: relevant.length,
    hitTopK: hitTopK.length,
    recallAt: Object.fromEntries(k.map((n) => [`recallAt${n}`, recallAtK(ranked, relevant, n)])),
    anyHitAt,
    mrr: mrr(ranked, relevant),
    ndcgAt10: ndcgAtK(ranked, relevant, 10),
    injectionPrecision: injectionPrecision(ranked, relevant, topK),
    miss: relevant.length > 0 ? hitTopK.length === 0 : null,
    falseInjection: relevant.length === 0 ? ranked.length > 0 : null,
    mustNotRecallViolations: mustNotRecall.filter((id) => ranked.map(String).includes(String(id))),
    returnedChars: Number(options.returnedChars ?? 0),
    latencyMs: Number(options.latencyMs ?? 0),
    path: String(options.path ?? 'real'),
  }
}

/* ── 幂等（--repeat 2）───────────────────────────────────────── */

function fingerprint(item) {
  return `${item.kindKey}\u0000${normalizeText(item.text)}\u0000${(item.rowIds ?? []).slice().sort().join(',')}`
}

/** 两次 formation 产出的稳定性：新增/缺失/证据集合变化/重复对增量。 */
export function idempotency(extractedA, extractedB) {
  const a = new Map((extractedA ?? []).map((item) => [fingerprint(item), item]))
  const b = new Map((extractedB ?? []).map((item) => [fingerprint(item), item]))
  const newInSecond = [...b.keys()].filter((key) => !a.has(key))
  const missingInSecond = [...a.keys()].filter((key) => !b.has(key))
  // 同一正文、不同证据集合：说明重跑改了证据绑定（比"新增一条"更隐蔽的漂移）。
  const byTextA = new Map()
  for (const item of extractedA ?? []) byTextA.set(`${item.kindKey}\u0000${normalizeText(item.text)}`, (item.rowIds ?? []).slice().sort().join(','))
  let evidenceChanged = 0
  for (const item of extractedB ?? []) {
    const key = `${item.kindKey}\u0000${normalizeText(item.text)}`
    if (byTextA.has(key) && byTextA.get(key) !== (item.rowIds ?? []).slice().sort().join(',')) evidenceChanged += 1
  }
  const stable = [...a.keys()].filter((key) => b.has(key)).length
  const union = new Set([...a.keys(), ...b.keys()]).size
  return {
    first: (extractedA ?? []).length,
    second: (extractedB ?? []).length,
    stable,
    newInSecond: newInSecond.length,
    missingInSecond: missingInSecond.length,
    evidenceChanged,
    stableRate: union ? stable / union : null,
  }
}

