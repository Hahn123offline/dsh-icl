// S3d：答案可回答性 A/B。不看 block-id anyHit，看"返回的上下文是否能回答 expectAnswer"。
// 用于判断段分区是否真的损伤回忆质量，而不是被 day 形状的期望映射误判。
//
// 用法：
//   node tools/memory-answerability.mjs --fixture <fixture目录> --day <eval.json> --segment <eval.json>
//        [--out <目录>] [--model cloud|echo]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadFixture } from './memory-eval/fixture.mjs'
import { createModelAdapter } from './memory-eval/model.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argValue = (argv, name) => { const index = argv.indexOf(`--${name}`); return index >= 0 ? argv[index + 1] : null }
const argv = process.argv.slice(2)
const fixturePath = path.resolve(String(argValue(argv, 'fixture')))
const dayFile = path.resolve(String(argValue(argv, 'day')))
const segmentFile = path.resolve(String(argValue(argv, 'segment')))
const outDir = path.resolve(String(argValue(argv, 'out') ?? path.join(REPO_ROOT, '.state/lab/lead/answerability-ab')))
const modelKind = String(argValue(argv, 'model') ?? 'cloud')
const loaded = loadFixture(fixturePath)
if (!loaded.ok) { console.error('fixture 校验失败'); process.exit(2) }
const fixture = loaded.fixture
const expectById = new Map((fixture.probes ?? []).map((probe) => [String(probe.id), String(probe.expectAnswer ?? '').trim()]))
const model = await createModelAdapter({ kind: modelKind, outDir: path.join(REPO_ROOT, '.state/lab/lead/answerability-cache'), configFile: path.join(REPO_ROOT, 'config/icl.local.json') })

async function judge(probe, context) {
  const expected = expectById.get(String(probe.id))
  if (!expected) return null
  const prompt = [
    '你是记忆检索质量评审。只判断：给出的"检索上下文"是否足以回答用户问题并覆盖"期望答案"的关键事实。',
    '输出一个 JSON：{"score": 0|1|2, "reason": "一句话"}。',
    '0=完全无法回答；1=部分覆盖（只答对一半/缺关键事实）；2=足够回答。只输出 JSON。',
    '',
    `问题：${probe.query}`,
    `期望答案：${expected}`,
    `检索上下文：\n${String(context ?? '').slice(0, 4000)}`,
  ].join('\n')
  try {
    const raw = await model.call({ messages: [{ role: 'user', content: prompt }], maxTokens: 80, where: 'answerability' })
    const match = /\{[\s\S]*\}/.exec(String(raw ?? ''))
    const parsed = match ? JSON.parse(match[0]) : null
    const score = Number(parsed?.score)
    return Number.isFinite(score) ? Math.max(0, Math.min(2, Math.round(score))) : null
  } catch { return null }
}

const runSet = async (file) => {
  const evalJson = JSON.parse(fs.readFileSync(file, 'utf8'))
  const results = []
  for (const probe of evalJson.retrieval?.probes ?? []) {
    const expected = expectById.get(String(probe.id))
    if (!expected) continue
    const score = await judge(probe, probe.returnedText)
    results.push({ id: probe.id, query: probe.query, expected, score, anyHit: probe.metrics?.anyHitAt?.anyHitAt5 ?? null })
  }
  const judged = results.filter((row) => row.score != null)
  const answerable = judged.filter((row) => row.score >= 1).length
  const full = judged.filter((row) => row.score >= 2).length
  return {
    file,
    probes: results.length,
    judged: judged.length,
    answerable,
    answerableRate: judged.length ? answerable / judged.length : null,
    full,
    fullRate: judged.length ? full / judged.length : null,
    meanScore: judged.length ? judged.reduce((sum, row) => sum + row.score, 0) / judged.length : null,
    results,
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
fs.mkdirSync(outDir, { recursive: true })
const day = await runSet(dayFile)
const segment = await runSet(segmentFile)
const report = { at: new Date().toISOString(), fixture: fixturePath, day, segment }
fs.writeFileSync(path.join(outDir, `answerability-${stamp}.json`), JSON.stringify(report, null, 2), 'utf8')
const pct = (value) => (value == null ? '—' : `${(value * 100).toFixed(1)}%`)
console.log(`day    judged=${day.judged} answerable=${pct(day.answerableRate)} full=${pct(day.fullRate)} mean=${day.meanScore?.toFixed(2)}`)
console.log(`segment judged=${segment.judged} answerable=${pct(segment.answerableRate)} full=${pct(segment.fullRate)} mean=${segment.meanScore?.toFixed(2)}`)
console.log(`output=${path.join(outDir, `answerability-${stamp}.json`)}`)
