// 语义化内容完整性审计（2026-11-13 第 10 轮，用户认可的增强项 3）。
// 目的：现有 goldContentRate 用去空白 bigram 精确覆盖，会系统性低估改述/概括；
// 这里用本地 bge-m3 句向量算"gold 文本 vs 最好 episode 正文"的余弦覆盖，作为并列指标。
//
// 用法：
//   node tools/memory-semantic-audit.mjs --fixture <fixture目录> --db <重建库路径> [--out <目录>] [--embed]
//
// 只读 DB、只写 lab 输出；不调用云端 LLM。
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { loadFixture } from './memory-eval/fixture.mjs'
import { createEmbedAdapter } from './memory-eval/model.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
function argValue(argv, name) {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : null
}
const argv = process.argv.slice(2)
const fixturePath = path.resolve(String(argValue(argv, 'fixture')))
const dbFile = path.resolve(String(argValue(argv, 'db')))
const outDir = path.resolve(String(argValue(argv, 'out') ?? path.join(REPO_ROOT, '.state/lab/lead/semantic-audit', path.basename(path.dirname(path.dirname(path.dirname(dbFile)))))))
const goldThreshold = Number(argValue(argv, 'gold-threshold') ?? 0.68)
const lineThreshold = Number(argValue(argv, 'line-threshold') ?? 0.62)
if (!fixturePath || !dbFile) {
  console.error('用法：node tools/memory-semantic-audit.mjs --fixture <fixture目录> --db <memory.db> [--out <目录>] [--embed]')
  process.exit(2)
}
const loaded = loadFixture(fixturePath)
if (!loaded.ok) { console.error('fixture 校验失败：', loaded.errors?.slice(0, 5)); process.exit(2) }
const fixture = loaded.fixture
const embed = await createEmbedAdapter({
  configFile: path.join(REPO_ROOT, 'config', 'icl.local.json'),
  outDir: path.join(REPO_ROOT, '.state/lab/lead/semantic-audit-cache'),
})
const percentile = (values, q) => { const sorted = values.slice().sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : null }
const cosine = (a, b) => {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}
const db = new DatabaseSync(dbFile, { readOnly: true })
const rows = db.prepare("SELECT namespace, kind, text, data FROM mem_items WHERE namespace IN ('episode', 'episode-seg', 'person', 'day')").all()
const parseData = (value) => { try { return JSON.parse(value) } catch { return null } }
const episodes = []
const segments = []
const personBlocks = []
const dayLines = []
for (const row of rows) {
  const data = parseData(row.data) ?? {}
  if (row.namespace === 'person' && row.kind === 'block') {
    const profile = String(data.profile ?? '').trim()
    if (profile) personBlocks.push(`${row.text ?? ''} ${profile}`.trim())
  }
  if (row.namespace === 'episode' && row.kind === 'block') {
    if (data.superseded === true || Number(data.parts?.part) > 1) continue
    episodes.push({
      id: String(row.text ?? '').slice(0, 20),
      text: `${row.text ?? ''} ${String(data.body ?? '')} ${JSON.stringify(data.annotations ?? {})}`.trim(),
    })
  }
  if (row.namespace === 'episode-seg' && row.kind === 'segment') {
    const segText = String(row.text ?? '').trim()
    if (segText) segments.push(segText)
  }
  if (row.namespace === 'day' && row.kind === 'log') {
    const sources = Array.isArray(data.sources) ? data.sources : []
    const allowed = new Set(['human', 'agent_visible', 'qq_envelope', 'unknown'])
    for (const line of String(row.text ?? '').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed.length < 8) continue
      const idMatch = /^\[(\d+)\]/.exec(trimmed)
      const source = idMatch ? String(sources[Number(idMatch[1]) - 1] ?? 'unknown') : 'unknown'
      if (!allowed.has(source)) continue
      const body = trimmed.replace(/^\[\d+\]\s*(?:\d{1,2}:\d{2}\s*)?(?:[^：:]{0,14}[：:])?/, '').trim()
      // 只统计中文材料行：纯英文的自我推理/工具摘要不是该进记忆的真人内容，
      // 语义口径下会系统性拉低材料覆盖（2026-11-13 审计实测）。
      if (body.length >= 6 && /[\u4e00-\u9fff]/.test(body)) dayLines.push(body)
    }
  }
}
db.close()
const golds = fixture.gold?.memories ?? []
const embedAll = async (texts) => {
  const vectors = []
  for (const text of texts) vectors.push(await embed.embed(text))
  return vectors
}
const episodeVectors = await embedAll(episodes.map((item) => item.text))
const segmentVectors = await embedAll(segments)
const personVectors = await embedAll(personBlocks)
const splitClauses = (value) => String(value ?? '').split(/[。！？；\n]+/).map((part) => part.trim()).filter((part) => part.length >= 6)
const bestSimilarity = (vector) => {
  let best = { sim: 0, episodeId: null }
  for (let index = 0; index < segmentVectors.length; index += 1) {
    const sim = cosine(vector, segmentVectors[index])
    if (sim > best.sim) best = { sim, episodeId: `seg:${index}` }
  }
  for (let index = 0; index < episodeVectors.length; index += 1) {
    const sim = cosine(vector, episodeVectors[index])
    if (sim > best.sim) best = { sim, episodeId: episodes[index].id }
  }
  for (let index = 0; index < personVectors.length; index += 1) {
    const sim = cosine(vector, personVectors[index])
    if (sim > best.sim) best = { sim, episodeId: `person:${index}` }
  }
  return best
}
const goldChecks = []
for (const gold of golds) {
  const clauses = splitClauses(gold.text)
  const clauseSims = []
  for (const clause of clauses.length ? clauses : [String(gold.text ?? '')]) {
    const vector = await embed.embed(clause)
    clauseSims.push(bestSimilarity(vector).sim)
  }
  const completeness = clauseSims.length ? clauseSims.reduce((sum, value) => sum + value, 0) / clauseSims.length : 0
  const best = Math.max(0, ...clauseSims)
  goldChecks.push({
    goldId: String(gold.id), type: String(gold.type ?? '?'),
    sim: Math.round(completeness * 1000) / 1000, best: Math.round(best * 1000) / 1000,
    clauses: clauseSims.length, text: String(gold.text ?? '').slice(0, 100),
  })
}
const lineChecks = []
for (const line of dayLines) {
  const vector = await embed.embed(line)
  let bestSim = 0
  for (const segmentVector of segmentVectors) bestSim = Math.max(bestSim, cosine(vector, segmentVector))
  for (const episodeVector of episodeVectors) bestSim = Math.max(bestSim, cosine(vector, episodeVector))
  for (const personVector of personVectors) bestSim = Math.max(bestSim, cosine(vector, personVector))
  lineChecks.push({ line: line.slice(0, 90), sim: Math.round(bestSim * 1000) / 1000, covered: bestSim >= lineThreshold })
}
const goldCovered = goldChecks.filter((row) => row.sim >= goldThreshold).length
const lineCovered = lineChecks.filter((row) => row.covered).length
const result = {
  generatedAt: new Date().toISOString(),
  fixture: fixturePath,
  db: dbFile,
  thresholds: { gold: goldThreshold, line: lineThreshold },
  episodes: episodes.length,
  golds: goldChecks.length,
  goldSemanticCovered: goldCovered,
  goldSemanticRate: goldChecks.length ? goldCovered / goldChecks.length : null,
  goldSemanticP25: percentile(goldChecks.map((row) => row.sim), 0.25),
  goldSemanticP50: percentile(goldChecks.map((row) => row.sim), 0.5),
  goldSimAvg: goldChecks.length ? goldChecks.reduce((sum, row) => sum + row.sim, 0) / goldChecks.length : null,
  materialLines: lineChecks.length,
  materialSemanticCovered: lineCovered,
  materialSemanticRate: lineChecks.length ? lineCovered / lineChecks.length : null,
  materialSimAvg: lineChecks.length ? lineChecks.reduce((sum, row) => sum + row.sim, 0) / lineChecks.length : null,
  gaps: goldChecks.filter((row) => row.sim < goldThreshold),
  lineGaps: lineChecks.filter((row) => !row.covered).slice(0, 20),
  goldChecks,
}
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'semantic-audit.json'), JSON.stringify(result, null, 2), 'utf8')
const pct = (value) => (value == null ? '—' : `${(value * 100).toFixed(1)}%`)
console.log(`episodes=${result.episodes} golds=${result.golds} goldSemantic=${pct(result.goldSemanticRate)} avgSim=${result.goldSimAvg?.toFixed(3)}`)
console.log(`materialLines=${result.materialLines} materialSemantic=${pct(result.materialSemanticRate)} avgSim=${result.materialSimAvg?.toFixed(3)}`)
console.log(`output=${path.join(outDir, 'semantic-audit.json')}`)


