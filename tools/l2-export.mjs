// L2 段末 checkpoint 导出：从 mc-night runDir 的 body ledger/events 过滤本次段窗口，写最小包（meta/scenario/tasks/events/expected）。
// 用法：node tools/l2-export.mjs --run l2-20261107-s1 --segment s0001 --expected .state/lab/l2-templates/shelter.json [--start ISO]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}
function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}
function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}

const runId = String(arg('--run', ''))
const segmentId = String(arg('--segment', 's0001'))
const expectedFile = arg('--expected')
if (!runId || !expectedFile) {
  console.error('用法：node tools/l2-export.mjs --run <runId> --segment s0001 --expected <expected-events.json> [--start ISO] [--out dir]')
  process.exit(2)
}
const runDir = path.join(REPO_ROOT, '.state', 'lab', runId)
const metaFile = path.join(runDir, 'lab.json')
if (!fs.existsSync(metaFile)) {
  console.error(`找不到 runDir/lab.json：${metaFile}`)
  process.exit(2)
}
const runMeta = readJson(metaFile, {})
const startIso = String(arg('--start', runMeta.startedAt ?? ''))
const startMs = Date.parse(startIso)
if (!Number.isFinite(startMs)) {
  console.error(`无法解析 --start：${startIso}`)
  process.exit(2)
}
const bodyDir = path.join(runDir, 'state', 'mc-body')
const events = readJsonl(path.join(bodyDir, 'body.jsonl')).filter((row) => Number(row.at) >= startMs)
const ledger = readJson(path.join(bodyDir, 'tasks.json'), { version: 3, tasks: [] })
const tasks = (ledger.tasks ?? []).filter((task) => Number(task.createdAt ?? 0) >= startMs || Number(task.finishedAt ?? 0) >= startMs)
const expected = readJson(path.resolve(expectedFile))
if (!expected) {
  console.error(`无法解析 expected：${expectedFile}`)
  process.exit(2)
}
const outDir = path.resolve(String(arg('--out', path.join(runDir, 'checkpoints', segmentId))))
fs.mkdirSync(outDir, { recursive: true })

const meta = {
  schemaVersion: 1,
  runId,
  segmentId,
  createdAt: new Date().toISOString(),
  phase: 'L2',
  source: 'recorded',
  commits: { body: runMeta.commit ?? null, mcLink: runMeta.commit ?? null, mcLab: runMeta.commit ?? null },
  versions: { node: process.versions.node.split('.')[0], minecraft: null, body: 'mc-body/v1' },
  model: runMeta.model ?? null,
  world: { levelName: null, seed: null, dimension: 'overworld', timeOfDay: null, weather: null, difficulty: null, snapshot: null, note: 'L2 段导出：world 未快照；L1 断言不依赖 world（见 E2-HARNESS §11.9）' },
  clock: { startAt: startMs, stopBeforeMs: null },
  scenarioIds: [segmentId],
  limits: { maxDeaths: 6, maxSteps: 2000, maxWallMs: 30 * 60_000 },
  freeze: { name: 'MC-FREEZE-2026-11-06', approvedBy: 'lead' },
  note: `L2 段导出：events/tasks 过滤为 run.startedAt(${startIso}) 之后；expected=${path.basename(expectedFile)}`,
}
const scenario = {
  schemaVersion: 1,
  id: segmentId,
  description: `L2 ${runId}/${segmentId} 录制段（任务卡见 report）`,
  setup: {
    position: events.find((row) => row.type === 'spawn' && row.data?.position)?.data?.position ?? null,
    health: null,
    food: null,
    inventory: {},
    inventoryPolicy: 'minimum',
    timeOfDay: null,
    weather: null,
    difficulty: null,
    note: 'L2 导出：setup 只做归档，不用于重放物理',
  },
  taskSequence: tasks.map((task) => ({ id: task.id, kind: task.kind, params: task.params ?? {} })),
  threats: [],
  stopRules: { maxDeaths: 2, maxRepeatToolCalls: 2, maxSayPerHour: 2, maxShelterFailStreak: 2, maxPathStuck: 5 },
}
const filteredLedger = { ...ledger, tasks }

fs.writeFileSync(path.join(outDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
fs.writeFileSync(path.join(outDir, 'scenario.json'), `${JSON.stringify(scenario, null, 2)}\n`)
fs.writeFileSync(path.join(outDir, 'tasks.json'), `${JSON.stringify(filteredLedger, null, 2)}\n`)
fs.writeFileSync(path.join(outDir, 'events.jsonl'), `${events.map((row) => JSON.stringify(row)).join('\n')}\n`)
fs.writeFileSync(path.join(outDir, 'expected-events.json'), `${JSON.stringify(expected, null, 2)}\n`)
console.log(JSON.stringify({ checkpoint: outDir, runId, segmentId, startAt: startIso, tasks: tasks.length, events: events.length, expected: path.basename(expectedFile) }, null, 2))
