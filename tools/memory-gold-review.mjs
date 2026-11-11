#!/usr/bin/env node
// gold 抽审辅助：不调模型，列出"gold 草稿需要人工复核"的条目与 probe 引用问题。
//
// 用法：
//   node tools/memory-gold-review.mjs --fixture <fixture.json|dir> [--eval <eval.json>] [--out <dir>]
//
// 输出 gold-review.md：证据缺失、正文过短、近重复 gold、未被任何 probe 覆盖的 gold、
// probe 期望无法解析（eval.json 里 unresolvedExpected）等。只读 fixture/eval 文件，不碰 live。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildIndexes, loadFixture } from './memory-eval/fixture.mjs'
import { textSimilarity } from './memory-eval/metrics.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function argValue(argv, name, fallback = null) {
  const index = argv.indexOf(`--${name}`)
  if (index >= 0) return argv[index + 1] ?? fallback
  const prefix = `--${name}=`
  const hit = argv.find((item) => item.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : fallback
}

function assertNotLive(target) {
  const resolved = path.resolve(String(target))
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
  const liveRoot = path.resolve(home, 'icl')
  if (resolved.toLowerCase().startsWith(liveRoot.toLowerCase())) {
    throw new Error(`拒绝读取 live 路径：${resolved}`)
  }
}

/**
 * 分析 fixture 的 gold/probe 质量，返回结构化清单。
 * @param {object} options
 * @param {object} options.fixture loadFixture().fixture
 * @param {object} [options.indexes] buildIndexes() 结果（保留参数，供调用方复用）
 * @param {object} [options.evalJson] eval.json（可选，用于看 probe 期望解析失败）
 * @param {Set<string>} [options.rowIds] 已解析的 raw row id（缺省从 fixture.days 构建）
 */
export function reviewGold({ fixture, indexes = null, evalJson = null, rowIds = null }) {
  void indexes
  const list = fixture?.gold?.memories ?? []
  const probeList = fixture?.probes ?? []
  const knownRows = rowIds ?? new Set(((fixture?.days ?? []).flatMap((day) => (day.rows ?? []).map((row) => String(row.id)))))
  const goldIds = new Set(list.map((item) => String(item.id)))
  const review = {
    fixture: String(fixture?.id ?? ''),
    gold: list.length,
    probes: probeList.length,
    missingEvidence: [],
    invalidEvidence: [],
    shortText: [],
    duplicatePairs: [],
    unprobed: [],
    danglingInvalidatedBy: [],
    probeIssues: [],
  }
  for (const item of list) {
    const text = String(item.text ?? '')
    const evidence = Array.isArray(item.evidence) ? item.evidence.map(String) : []
    if (!evidence.length) review.missingEvidence.push({ id: item.id, type: item.type, text: text.slice(0, 80) })
    const invalid = evidence.filter((rowId) => !knownRows.has(rowId))
    if (invalid.length) review.invalidEvidence.push({ id: item.id, type: item.type, invalid, text: text.slice(0, 80) })
    if (text.trim().length < 12) review.shortText.push({ id: item.id, type: item.type, text })
    if (item.invalidatedBy != null && !goldIds.has(String(item.invalidatedBy))) {
      review.danglingInvalidatedBy.push({ id: item.id, invalidatedBy: String(item.invalidatedBy) })
    }
  }
  // 近重复 gold：同类型、正文相似 ≥0.75（会拉低 P/R 判定的稳定性）。
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i]
      const b = list[j]
      if (String(a.type) !== String(b.type)) continue
      const sim = textSimilarity(String(a.text ?? ''), String(b.text ?? ''))
      if (sim >= 0.75) review.duplicatePairs.push({ a: a.id, b: b.id, type: a.type, sim: Number(sim.toFixed(2)) })
    }
  }
  // probe 与 expected gold 的内容匹配：问句和 expected gold 正文一个内容 bigram 都不共享，
  // 说明这条 probe 的 gold↔extracted 映射或问法有问题（"expected 块和问句对不上"）。
  const contentGrams = (value) => {
    const text = String(value ?? '').toLowerCase().replace(/\s+/g, '')
    const STOP = new Set(['主人', '鱼鱼', '今天', '明天', '昨天', '什么', '怎么', '为什么', '一个', '时候', '还是', '这个', '那个', '自己', '可以', '已经'])
    const grams = new Set()
    for (let i = 0; i + 1 < text.length; i += 1) {
      const gram = text.slice(i, i + 2)
      if (!/[\u4e00-\u9fff]{2}/.test(gram) && !/[a-z0-9]{2}/.test(gram)) continue
      if (STOP.has(gram)) continue
      grams.add(gram)
    }
    return grams
  }
  const goldById = new Map(list.map((item) => [String(item.id), item]))
  for (const probe of probeList) {
    const expectedIds = [...(probe.expectedMemoryIds ?? []), ...(probe.expectedAny ?? [])].map(String)
    if (!expectedIds.length) continue
    const queryGrams = contentGrams(probe.query)
    let bestOverlap = 0
    for (const goldId of expectedIds) {
      const gold = goldById.get(goldId)
      if (!gold) continue
      const goldGrams = contentGrams(gold.text)
      let shared = 0
      for (const gram of queryGrams) if (goldGrams.has(gram)) shared += 1
      if (shared > bestOverlap) bestOverlap = shared
    }
    if (bestOverlap === 0) review.probeIssues.push({ probe: probe.id, kind: probe.kind, query: String(probe.query ?? '').slice(0, 70), expected: expectedIds, reason: 'query 与 expected gold 零内容词交集' })
  }
  // 未被任何 probe 引用的 gold：可以补 probe，或确认不必评测。
  const referenced = new Set()
  for (const probe of probeList) {
    for (const id of [...(probe.expectedMemoryIds ?? []), ...(probe.expectedAny ?? []), ...(probe.mustNotRecall ?? [])]) {
      referenced.add(String(id))
    }
  }
  for (const item of list) {
    if (!referenced.has(String(item.id))) review.unprobed.push({ id: item.id, type: item.type, text: String(item.text ?? '').slice(0, 80) })
  }
  // eval.json 的 probe 问题（seed=formation 时 expected 无法映射到 extracted）。
  if (evalJson?.retrieval?.probes) {
    for (const probe of evalJson.retrieval.probes) {
      if ((probe.unresolvedExpected ?? []).length) {
        review.probeIssues.push({
          probe: probe.id, kind: probe.kind,
          query: String(probe.query ?? '').slice(0, 60), unresolved: probe.unresolvedExpected,
        })
      }
    }
  }
  return review
}

export function renderGoldReview(review) {
  const lines = []
  lines.push(`# gold 抽审清单：${review.fixture}`)
  lines.push('')
  lines.push(`- gold ${review.gold} 条 · probes ${review.probes} 个`)
  lines.push('')
  lines.push('## 需要看一眼的 gold')
  lines.push('')
  lines.push(`- 无证据（provenance 不可验证）：**${review.missingEvidence.length}**`)
  for (const item of review.missingEvidence) lines.push(`  - ${item.id}（${item.type}）：${item.text}`)
  lines.push(`- 证据行引用非法：**${review.invalidEvidence.length}**`)
  for (const item of review.invalidEvidence.slice(0, 20)) lines.push(`  - ${item.id}：${item.invalid.join('、')}`)
  lines.push(`- 正文过短（<12 字）：**${review.shortText.length}**`)
  for (const item of review.shortText.slice(0, 20)) lines.push(`  - ${item.id}（${item.type}）：「${item.text}」`)
  lines.push(`- gold 近重复对（同类型、正文相似≥0.75）：**${review.duplicatePairs.length}**`)
  for (const pair of review.duplicatePairs) lines.push(`  - ${pair.a} ↔ ${pair.b}（${pair.type}，similarity ${pair.sim}）`)
  lines.push(`- 失效链指向不存在的 gold：**${review.danglingInvalidatedBy.length}**`)
  for (const item of review.danglingInvalidatedBy) lines.push(`  - ${item.id} → ${item.invalidatedBy}`)
  lines.push('')
  lines.push('## probe 覆盖')
  lines.push('')
  lines.push(`- 未被任何 probe 引用的 gold：**${review.unprobed.length}**`)
  for (const item of review.unprobed.slice(0, 40)) lines.push(`  - ${item.id}（${item.type}）：${item.text}`)
  lines.push(`- probe 期望解析/内容匹配问题：**${review.probeIssues.length}**`)
  for (const item of review.probeIssues) {
    if (item.reason) lines.push(`  - ${item.probe}（${item.kind}）${item.reason}｜${item.query}`)
    else lines.push(`  - ${item.probe}（${item.kind}）unresolved=${(item.unresolved ?? []).join('、')}｜${item.query}`)
  }
  lines.push('')
  return lines.join('\n')
}

function main(argv = process.argv) {
  const fixtureArg = argValue(argv, 'fixture')
  if (!fixtureArg) {
    console.error('用法：node tools/memory-gold-review.mjs --fixture <fixture.json|dir> [--eval <eval.json>] [--out <dir>]')
    process.exit(2)
  }
  assertNotLive(fixtureArg)
  const loaded = loadFixture(path.resolve(fixtureArg))
  if (!loaded.ok) {
    console.error(`fixture 校验失败：${loaded.path}`)
    for (const error of loaded.errors ?? []) console.error(`  - ${error.path}: ${error.message}`)
    process.exit(2)
  }
  const fixture = loaded.fixture
  const evalPath = argValue(argv, 'eval') ? path.resolve(argValue(argv, 'eval')) : null
  let evalJson = null
  if (evalPath && fs.existsSync(evalPath)) {
    assertNotLive(evalPath)
    evalJson = JSON.parse(fs.readFileSync(evalPath, 'utf8'))
  }
  const review = reviewGold({ fixture, evalJson })
  const outDir = path.resolve(argValue(argv, 'out', path.join(REPO_ROOT, '.state', 'lab', 'lead', 'gold-review')))
  fs.mkdirSync(outDir, { recursive: true })
  const slug = String(fixture.id ?? 'fixture').replace(/[^\w.-]+/g, '-')
  const markdownPath = path.join(outDir, `${slug}.md`)
  const jsonPath = path.join(outDir, `${slug}.json`)
  fs.writeFileSync(markdownPath, `${renderGoldReview(review)}\n`, 'utf8')
  fs.writeFileSync(jsonPath, `${JSON.stringify(review, null, 2)}\n`, 'utf8')
  console.log(markdownPath)
  console.log(jsonPath)
}

const isMain = path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)
if (isMain) main()
