#!/usr/bin/env node
// MC L1 checkpoint 回放器（离线）：读 meta/scenario/tasks/events/expected-events，
// 用 fake adapter（无 mineflayer、无服务器）按断言输出 PASS/FAIL + 差异。
// 设计依据：docs/MC-INSTRUMENTATION.md §3–4。
// 用法：node tools/mc-replay.mjs <checkpoint-dir> [--json] [--report <file>]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REQUIRED_FILES = ['meta.json', 'scenario.json', 'tasks.json', 'events.jsonl', 'expected-events.json']

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line, index) => {
    try { return JSON.parse(line) } catch (error) { throw new Error(`${file}:${index + 1} JSON 解析失败：${error.message}`) }
  })
}

/** 读 checkpoint 最小包；L1 不要求 world.json（断言基于录制的 tasks/events，不做物理重放）。 */
export function loadCheckpoint(dir) {
  const root = path.resolve(dir)
  if (!fs.existsSync(root)) throw new Error(`checkpoint 目录不存在：${root}`)
  const missing = REQUIRED_FILES.filter((name) => !fs.existsSync(path.join(root, name)))
  if (missing.length) throw new Error(`checkpoint 缺文件：${missing.join(', ')}（L1 最小包 ${REQUIRED_FILES.join(', ')}）`)
  const meta = readJson(path.join(root, 'meta.json'))
  const scenario = readJson(path.join(root, 'scenario.json'))
  const ledger = readJson(path.join(root, 'tasks.json'))
  const events = readJsonl(path.join(root, 'events.jsonl'))
  const expected = readJson(path.join(root, 'expected-events.json'))
  const world = fs.existsSync(path.join(root, 'world.json')) ? readJson(path.join(root, 'world.json')) : null
  return { root, meta, scenario, ledger, events, expected, world }
}

/** fake adapter：只读录制数据；world.json 可选（blockAt 用稀疏快照，缺省 air）。 */
export function createFakeAdapter(pkg) {
  const blocks = new Map()
  for (const block of pkg.world?.blocks ?? []) blocks.set(`${block.x},${block.y},${block.z}`, block.name)
  const tasks = Array.isArray(pkg.ledger?.tasks) ? pkg.ledger.tasks : []
  return {
    name: 'fake-adapter',
    taskById: (id) => tasks.find((task) => task?.id === id) ?? null,
    tasks: () => tasks,
    events: () => pkg.events,
    status: () => ({ position: pkg.scenario?.setup?.position ?? null, health: pkg.scenario?.setup?.health ?? null, food: pkg.scenario?.setup?.food ?? null, home: pkg.ledger?.home ?? null }),
    blockAt: (x, y, z) => blocks.get(`${x},${y},${z}`) ?? 'air',
  }
}

/** 取点分路径（'verify.walls.missing'），不存在返回 { found:false }。 */
export function getPath(object, dotted) {
  let cursor = object
  for (const part of String(dotted).split('.')) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object' || !(part in cursor)) return { found: false }
    cursor = cursor[part]
  }
  return { found: true, value: cursor }
}

function deepEqual(left, right) {
  if (left === right) return true
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key) => deepEqual(left[key], right[key]))
}

function eventTaskId(event) {
  return event?.data?.task?.id ?? event?.data?.taskId ?? null
}

/** 事件是否匹配 where 子集（点分路径 + 深比较）。 */
export function eventMatches(event, type, where = {}) {
  if (event?.type !== type) return false
  for (const [dotted, expectedValue] of Object.entries(where ?? {})) {
    const got = getPath(event?.data, dotted)
    if (!got.found || !deepEqual(got.value, expectedValue)) return false
  }
  return true
}

function describeEvent(event) {
  return `seq=${event?.seq ?? '?'} type=${event?.type ?? '?'}`
}

/**
 * L1 task-replay：断言 ledger.state/error/result + 必须事件；不执行真实物理/不启服。
 * 返回 { pass, taskAssertions, eventAssertions, forbidden, errors, notes }。
 */
export function replayCheckpoint(dir, { adapterFactory = createFakeAdapter } = {}) {
  const pkg = loadCheckpoint(dir)
  const adapter = adapterFactory(pkg)
  const expected = pkg.expected ?? {}
  const errors = []
  const notes = []
  if (!pkg.world) notes.push('未提供 world.json：L1 task-replay 只断言录制的 tasks/events，不做方块/物理重放（断言不依赖 world；若后续做结构重放再补）')
  if (pkg.meta?.phase === 'L3') notes.push('meta.phase=L3：本回放器做 L1 task-replay；L3 报告请叠加分段检查')

  const taskAssertions = []
  for (const assertion of expected.taskAssertions ?? []) {
    const diffs = []
    const byId = assertion.taskId ? adapter.taskById(assertion.taskId) : null
    const byKind = !byId && assertion.kind
      ? adapter.tasks().filter((candidate) => candidate.kind === assertion.kind).sort((left, right) => Number(right.createdAt ?? 0) - Number(left.createdAt ?? 0))
      : []
    const task = byId ?? byKind[0] ?? null
    const taskLabel = assertion.taskId ? `taskId=${assertion.taskId}` : `kind=${assertion.kind}`
    if (!task) {
      diffs.push(`找不到 ${taskLabel}（ledger 有 ${adapter.tasks().map((t) => t.id).join(',') || '空'}）`)
    } else {
      if (assertion.kind && task.kind !== assertion.kind) diffs.push(`kind 期望 ${assertion.kind}，实际 ${task.kind}`)
      if (assertion.terminal !== undefined) {
        const terminal = String(assertion.terminal)
        if (String(task.state) !== terminal) diffs.push(`terminal 期望 ${terminal}，实际 ${task.state}`)
      }
      if (assertion.error !== undefined) {
        const expectedError = assertion.error
        if (!deepEqual(task.error ?? null, expectedError ?? null)) diffs.push(`error 期望 ${JSON.stringify(expectedError)}，实际 ${JSON.stringify(task.error ?? null)}`)
      }
      const resultSpec = assertion.result ?? {}
      for (const required of resultSpec.require ?? []) {
        const got = getPath(task.result ?? {}, required)
        if (!got.found) diffs.push(`result.require 缺字段 ${required}`)
      }
      for (const [dotted, expectedValue] of Object.entries(resultSpec)) {
        if (dotted === 'require') continue
        const got = getPath(task.result ?? {}, dotted)
        if (!got.found) diffs.push(`result 缺字段 ${dotted}（期望 ${JSON.stringify(expectedValue)}）`)
        else if (!deepEqual(got.value, expectedValue)) diffs.push(`result.${dotted} 期望 ${JSON.stringify(expectedValue)}，实际 ${JSON.stringify(got.value)}`)
      }
      for (const type of assertion.events ?? []) {
        const expectedTaskId = task?.id ?? assertion.taskId ?? null
        const matched = pkg.events.some((event) => event?.type === type && (eventTaskId(event) === null || eventTaskId(event) === expectedTaskId))
        if (!matched) diffs.push(`任务事件缺 ${type}（taskId=${expectedTaskId ?? assertion.kind} 或全局）`)
      }
    }
    const resolvedTaskId = assertion.taskId ?? task?.id ?? null
    taskAssertions.push({ taskId: resolvedTaskId, kind: assertion.kind ?? null, pass: diffs.length === 0, diffs })
    errors.push(...diffs.map((diff) => `task ${resolvedTaskId ?? `kind:${assertion.kind}`}: ${diff}`))
  }

  const eventAssertions = []
  for (const assertion of expected.eventAssertions ?? []) {
    const min = assertion.min ?? 1
    const matched = pkg.events.filter((event) => eventMatches(event, assertion.type, assertion.where ?? {}))
    const diffs = []
    if (min > 0 && matched.length < min) diffs.push(`事件 ${assertion.type}${JSON.stringify(assertion.where ?? {})} 期望 ≥${min}，实际 ${matched.length}`)
    // 可选 max（扩展；MC-INSTRUMENTATION §3.6 只规定 min）
    if (assertion.max !== undefined && matched.length > assertion.max) diffs.push(`事件 ${assertion.type} 期望 ≤${assertion.max}，实际 ${matched.length}`)
    eventAssertions.push({ type: assertion.type, where: assertion.where ?? {}, min, matched: matched.length, pass: diffs.length === 0, diffs })
    errors.push(...diffs.map((diff) => `event ${assertion.type}: ${diff}`))
  }

  const forbidden = []
  for (const entry of expected.forbidden ?? []) {
    const spec = typeof entry === 'string' ? { type: entry } : entry
    if (spec.when) {
      // 拒绝静默：when 求值不在 L1 回放器范围（§3.6 明确拒绝通配/正则；when 语义未定义）
      forbidden.push({ spec, pass: false, diffs: ['forbidden.when 暂不支持（L1 回放器拒绝静默解释；请改用 where 或拆分断言）'] })
      errors.push(`forbidden ${spec.type}: when 暂不支持`)
      continue
    }
    const hits = pkg.events.filter((event) => eventMatches(event, spec.type, spec.where ?? {}))
    if (hits.length) {
      const first = hits[0]
      forbidden.push({ spec, pass: false, hits: hits.length, first: describeEvent(first), diffs: [`forbidden 命中：${describeEvent(first)}`] })
      errors.push(`forbidden ${spec.type}: 命中 ${hits.length} 条（首条 ${describeEvent(first)}）`)
    } else {
      forbidden.push({ spec, pass: true, hits: 0, diffs: [] })
    }
  }

  const pass = taskAssertions.every((item) => item.pass) && eventAssertions.every((item) => item.pass) && forbidden.every((item) => item.pass)
  return { checkpoint: pkg.root, pass, phase: pkg.meta?.phase ?? null, scenarioId: pkg.scenario?.id ?? null, taskAssertions, eventAssertions, forbidden, errors, notes, adapter: { name: adapter.name, tasks: adapter.tasks().length, events: pkg.events.length } }
}

function printHuman(report) {
  console.log(`# MC L1 replay ${report.pass ? 'PASS' : 'FAIL'} — ${report.checkpoint}`)
  console.log(`scenario=${report.scenarioId ?? '?'} phase=${report.phase ?? '?'} tasks=${report.adapter.tasks} events=${report.adapter.events}`)
  for (const item of report.taskAssertions) {
    console.log(`${item.pass ? '✓' : '✗'} task ${item.taskId}${item.diffs.length ? `：${item.diffs.join('；')}` : ''}`)
  }
  for (const item of report.eventAssertions) {
    console.log(`${item.pass ? '✓' : '✗'} event ${item.type}${JSON.stringify(item.where)} min=${item.min} matched=${item.matched}${item.diffs.length ? `：${item.diffs.join('；')}` : ''}`)
  }
  for (const item of report.forbidden) {
    const label = typeof item.spec === 'string' ? item.spec : item.spec.type
    console.log(`${item.pass ? '✓' : '✗'} forbidden ${label}${item.diffs.length ? `：${item.diffs.join('；')}` : ''}`)
  }
  for (const note of report.notes) console.log(`note: ${note}`)
  if (report.errors.length) {
    console.log(`\n差异（${report.errors.length}）：`)
    for (const error of report.errors) console.log(`  - ${error}`)
  }
}

function main() {
  const argv = process.argv.slice(2)
  const json = argv.includes('--json')
  const reportIndex = argv.indexOf('--report')
  const reportFile = reportIndex >= 0 ? argv[reportIndex + 1] : null
  const dirs = argv.filter((arg, index) => !arg.startsWith('--') && (index === 0 || argv[index - 1] !== '--report'))
  if (!dirs.length) {
    console.error('用法：node tools/mc-replay.mjs <checkpoint-dir> [<dir>...] [--json] [--report <file>]')
    process.exit(2)
  }
  let allPass = true
  const reports = []
  for (const dir of dirs) {
    try {
      const report = replayCheckpoint(dir)
      reports.push(report)
      allPass &&= report.pass
      if (!json) printHuman(report)
      if (reportFile) {
        fs.mkdirSync(path.dirname(path.resolve(reportFile)), { recursive: true })
        fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`)
      }
    } catch (error) {
      allPass = false
      console.error(`✗ ${dir}: ${error.message}`)
      if (json) reports.push({ checkpoint: dir, pass: false, errors: [error.message] })
    }
  }
  if (json) console.log(JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2))
  process.exit(allPass ? 0 : 1)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
