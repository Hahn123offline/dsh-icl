// v3 记忆重建 runner（lab/生产同构；只操作 --out 指定目录，不碰 live 除非显式指定）。
//
// 用法：
//   node tools/memory-rebuild.mjs --fixture <fixture目录> --out <重建目录> [--schema v3]
//        [--model cloud|echo] [--embed] [--archive] [--max-calls N]
//
// 特性：
//   · 逐天 replay（dream 的 attempts 账本保证已完成的 day/job 会 skip）；
//   · 可中断：同一 --out 再跑一次会从账本续跑；
//   · 幂等校验：manifest 带 exportHash（episode/entity/relation/seg 文本哈希），续跑应保持不变；
//   · 旧库归档：--archive 时把已有 memory.db 复制到 <out>/archive-<时间>.db 后再重建（不删旧库）；
//   · 不修改 live：out 目录由参数显式给出。
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadFixture } from './memory-eval/fixture.mjs'
import { runFormation, closeFormation } from './memory-eval/formation.mjs'
import { createModelAdapter, createEmbedAdapter } from './memory-eval/model.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function argValue(argv, name) {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : null
}
function hasFlag(argv, name) { return argv.includes(`--${name}`) }

const fixturePath = argValue(process.argv, 'fixture')
const outDir = argValue(process.argv, 'out')
if (!fixturePath || !outDir) {
  console.error('用法：node tools/memory-rebuild.mjs --fixture <fixture目录> --out <重建目录> [--archive] [--embed] [--schema v3]')
  process.exit(2)
}
const schema = String(argValue(process.argv, 'schema') ?? 'v3')
if (!['v2', 'v3'].includes(schema)) { console.error('--schema 只能是 v2|v3'); process.exit(2) }
const modelKind = String(argValue(process.argv, 'model') ?? 'cloud')
const maxCalls = Math.max(1, Number(argValue(process.argv, 'max-calls') ?? 600) || 600)
const useEmbed = hasFlag(process.argv, 'embed')
const archiveOld = hasFlag(process.argv, 'archive')
const out = path.resolve(outDir)
const stateRoot = path.join(out, 'state')
const cacheDir = path.join(out, 'cache')
fs.mkdirSync(stateRoot, { recursive: true })
fs.mkdirSync(cacheDir, { recursive: true })

const dbFile = path.join(stateRoot, 'state', 'memory.db')
let archived = null
if (archiveOld && fs.existsSync(dbFile)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  archived = path.join(out, `archive-${stamp}.db`)
  fs.copyFileSync(dbFile, archived)
  console.log(`旧库已归档：${archived}`)
}

const loaded = loadFixture(path.resolve(fixturePath))
if (!loaded.ok) {
  console.error('fixture 校验失败：', loaded.errors?.slice(0, 5))
  process.exit(2)
}
const fixture = loaded.fixture
const indexes = loaded.indexes
const model = await createModelAdapter({
  kind: modelKind,
  outDir: cacheDir,
  configFile: path.join(REPO_ROOT, 'config', 'icl.local.json'),
  maxCalls,
})
const embedAdapter = useEmbed
  ? await createEmbedAdapter({ configFile: path.join(REPO_ROOT, 'config', 'icl.local.json'), outDir: cacheDir })
  : null

console.log(`重建：${fixturePath} → ${out}（schema=${schema} model=${modelKind} embed=${useEmbed} days=${(fixture.days ?? []).length}）`)
const run = await runFormation({
  fixture, indexes, profile: 'raw-main', model, embedAdapter,
  root: stateRoot, schema, keepTemp: true, logs: [],
})
const exported = run.exported ?? []
const live = (namespace, kind) => exported.filter((item) => item.namespace === namespace && item.kind === kind && item.data?.superseded !== true)
const counts = {
  days: (fixture.days ?? []).length,
  episodes: live('episode', 'block').filter((item) => !(Number(item.data?.parts?.part) > 1)).length,
  episodeParts: live('episode', 'block').filter((item) => Number(item.data?.parts?.part) > 1).length,
  entities: live('entity', 'entity').length,
  relations: live('relation', 'relation').length,
  segments: live('episode-seg', 'segment').length,
  personBlocks: live('person', 'block').length,
  notes: exported.filter((item) => item.kind === 'note').length,
}
const hash = createHash('sha256')
for (const item of [...exported].sort((a, b) => String(a.key).localeCompare(String(b.key)))) {
  if (item.data?.superseded === true) continue
  hash.update(`${item.namespace}/${item.kind}/${item.key}/${item.text ?? ''}\n`)
}
// 语义哈希：只覆盖记忆内容（episode/段/实体/关系/人物/typed），不包含 dream 账本与 day log 的运行时行。
// 续跑/幂等应保持不变；第二次跑会补记 skip 账本行，但语义状态不应变化。
const SEMANTIC_NAMESPACES = new Set(['episode', 'episode-seg', 'entity', 'relation', 'person', 'fact', 'preference', 'commitment', 'lexicon', 'slang'])
const semanticHash = createHash('sha256')
for (const item of [...exported].sort((a, b) => String(a.key).localeCompare(String(b.key)))) {
  if (item.data?.superseded === true) continue
  if (!SEMANTIC_NAMESPACES.has(item.namespace)) continue
  semanticHash.update(`${item.namespace}/${item.kind}/${item.key}/${item.text ?? ''}\n`)
}
let gitCommit = null
try { gitCommit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim() } catch { /* ignore */ }
const manifest = {
  builtAt: new Date().toISOString(),
  fixture: loaded.path,
  fixtureId: fixture.id ?? null,
  schema,
  model: model.describe?.() ?? { kind: modelKind },
  embedding: embedAdapter?.describe?.() ?? null,
  gitCommit,
  counts,
  dbPath: dbFile,
  exportHash: hash.digest('hex'),
  semanticHash: semanticHash.digest('hex'),
  dayResults: run.dayResults,
  archived,
}
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
console.log('重建完成：', JSON.stringify(counts))
console.log('exportHash：', manifest.exportHash)
console.log('semanticHash：', manifest.semanticHash)
console.log('db：', dbFile)
console.log('manifest：', path.join(out, 'manifest.json'))
await closeFormation(run)



