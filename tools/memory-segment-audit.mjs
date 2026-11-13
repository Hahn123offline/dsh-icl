// S0 只读影子审计：按"dream 切点 + 未消费游标"模拟段分区，验证 live raw 的
// 覆盖 / 重叠 / 缺口 / 迟到行 / 排除行，不写任何记忆。
//
// 用法：node tools/memory-segment-audit.mjs [--raw <session-events.jsonl>] [--db <memory.db>] [--out <目录>]
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { inferRawSource, isFormationSource } from '../packages/core/src/raw-profile.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
function argValue(argv, name) {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : null
}
const argv = process.argv.slice(2)
const rawFile = path.resolve(String(argValue(argv, 'raw') ?? path.join(os.homedir(), '.dsh', 'icl', 'state', 'session-events.jsonl')))
const dbFile = path.resolve(String(argValue(argv, 'db') ?? path.join(os.homedir(), '.dsh', 'icl', 'state', 'state', 'memory.db')))
const outDir = path.resolve(String(argValue(argv, 'out') ?? path.join(REPO_ROOT, '.state/lab/lead/segment-audit')))
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const out = path.join(outDir, `s0-${stamp}`)
fs.mkdirSync(out, { recursive: true })

const raw = fs.readFileSync(rawFile, 'utf8').trim().split('\n').map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
  .map((row) => ({
    ...row,
    id: `${row.sessionId ?? ''}:${row.seq ?? ''}`,
    source: inferRawSource(row),
    at: Number(row.time ?? row.at ?? 0),
  }))
  .filter((row) => row.at > 0)
  .sort((a, b) => a.at - b.at || String(a.id).localeCompare(String(b.id)))

const db = new DatabaseSync(dbFile, { readOnly: true })
const dayRows = db.prepare("SELECT key, text, data, created_at FROM mem_items WHERE namespace='day' AND kind='log' ORDER BY key").all()
const dayLogs = dayRows.map((row) => {
  let data = {}
  try { data = JSON.parse(row.data ?? '{}') } catch {}
  return { key: row.key, day: String(data.day ?? ''), rowIds: Array.isArray(data.rowIds) ? data.rowIds.map(String) : [], sources: Array.isArray(data.sources) ? data.sources : [], lines: Number(data.lines ?? 0) }
})
const membership = new Map()
for (const log of dayLogs) for (const id of log.rowIds) {
  if (!membership.has(id)) membership.set(id, [])
  membership.get(id).push(log.day || log.key)
}
const dreamCuts = db.prepare("SELECT key, created_at, data FROM mem_items WHERE namespace='dream-run' AND key LIKE '%:episodes' ORDER BY created_at").all()
  .map((row) => {
    const day = String(row.key).split(':')[1] ?? ''
    return { day, at: Number(row.created_at), key: row.key }
  })
db.close()

const formationRows = raw.filter((row) => isFormationSource(row.source))
const excludedRows = raw.filter((row) => !isFormationSource(row.source))
const uncovered = formationRows.filter((row) => !membership.has(row.id))
const multiCovered = [...membership.entries()].filter(([, days]) => new Set(days).size > 1)
const extraIds = [...membership.keys()].filter((id) => !raw.some((row) => row.id === id))

// 模拟段：cut = 该次 dream episodes job 的 created_at；行归入第一个 cut >= row.at；其后为 pending。
const segments = []
let pending = []
for (const row of formationRows) {
  const cutIndex = dreamCuts.findIndex((cut) => row.at <= cut.at)
  if (cutIndex < 0) { pending.push(row); continue }
  const cut = dreamCuts[cutIndex]
  if (!segments[cutIndex]) segments[cutIndex] = { cutAt: cut.at, day: cut.day, rows: [], excluded: 0 }
  segments[cutIndex].rows.push(row)
}
// 排除行也按 cut 归组，便于统计"看过但不形成"的材料量。
for (const row of excludedRows) {
  const cutIndex = dreamCuts.findIndex((cut) => row.at <= cut.at)
  if (cutIndex >= 0 && segments[cutIndex]) segments[cutIndex].excluded += 1
}
const segmentReport = segments.filter(Boolean).map((segment, index) => {
  const ids = new Set(segment.rows.map((row) => row.id))
  const covered = [...ids].filter((id) => (membership.get(id) ?? []).includes(segment.day)).length
  return {
    index: index + 1,
    cutAt: new Date(segment.cutAt).toISOString(),
    day: segment.day,
    formationRows: segment.rows.length,
    excludedRows: segment.excluded,
    coveredByDayLogOfThatDay: covered,
    missingFromDayLog: segment.rows.length - covered,
    daysCoveredByRows: [...new Set(segment.rows.map((row) => new Date(row.at).toISOString().slice(0, 10)))],
    untestableNoDayIds: (dayLogs.find((log) => log.day === segment.day)?.rowIds.length ?? 0) === 0,
  }
})
const coveredIds = new Set(dayLogs.flatMap((log) => log.rowIds))
const activeFrom = formationRows.filter((row) => coveredIds.has(row.id)).reduce((min, row) => (min == null || row.at < min ? row.at : min), null)
const activeFormation = activeFrom == null ? [] : formationRows.filter((row) => row.at >= activeFrom)
const activeUncovered = activeFormation.filter((row) => !membership.has(row.id))
const activePending = pending.filter((row) => row.at >= activeFrom)
const report = {
  generatedAt: new Date().toISOString(),
  rawFile,
  dbFile,
  rawRows: raw.length,
  formationRows: formationRows.length,
  excludedRows: excludedRows.length,
  sessions: [...new Set(raw.map((row) => row.sessionId))].length,
  dayLogs: dayLogs.length,
  coverage: {
    covered: formationRows.length - uncovered.length,
    uncovered: uncovered.length,
    multiCovered: multiCovered.length,
    extraIds: extraIds.length,
    uncoveredByDay: Object.fromEntries(Object.entries(uncovered.reduce((map, row) => {
      const day = new Date(row.at).toISOString().slice(0, 10)
      map[day] = (map[day] ?? 0) + 1
      return map
    }, {})).sort()),
    uncoveredSamples: uncovered.slice(0, 10).map((row) => ({ at: new Date(row.at).toISOString(), source: row.source, role: row.role, text: String(row.text).slice(0, 80) })),
    multiCoveredSamples: multiCovered.slice(0, 5),
    extraIdSamples: extraIds.slice(0, 5),
  },
  dreamCuts: dreamCuts.map((cut) => ({ day: cut.day, at: new Date(cut.at).toISOString() })),
  segments: segmentReport,
  pending: { count: pending.length, samples: pending.slice(0, 5).map((row) => ({ at: new Date(row.at).toISOString(), source: row.source, role: row.role })) },
  activeWindow: activeFrom == null ? null : {
    from: new Date(activeFrom).toISOString(),
    formationRows: activeFormation.length,
    covered: activeFormation.length - activeUncovered.length,
    uncovered: activeUncovered.length,
    pending: activePending.length,
  },
  legacyDayLogsWithoutRowIds: dayLogs.filter((log) => !log.rowIds.length).map((log) => log.day || log.key),
}
fs.writeFileSync(path.join(out, 'segment-audit.json'), JSON.stringify(report, null, 2), 'utf8')
const pct = (value) => `${(value * 100).toFixed(1)}%`
console.log(`raw=${report.rawRows} formation=${report.formationRows} excluded=${report.excludedRows}`)
console.log(`coverage=${report.coverage.covered}/${report.formationRows} (${pct(report.coverage.covered / (report.formationRows || 1))}) uncovered=${report.coverage.uncovered} multi=${report.coverage.multiCovered} extraIds=${report.coverage.extraIds}`)
console.log(`pending=${report.pending.count} legacyDayLogsNoIds=${report.legacyDayLogsWithoutRowIds.length}`)
if (report.activeWindow) console.log(`activeWindow from=${report.activeWindow.from} formation=${report.activeWindow.formationRows} covered=${report.activeWindow.covered} uncovered=${report.activeWindow.uncovered} pending=${report.activeWindow.pending}`)
for (const segment of report.segments.slice(-8)) console.log(`seg#${segment.index} cut=${segment.cutAt} day=${segment.day} rows=${segment.formationRows} covered=${segment.coveredByDayLogOfThatDay} missing=${segment.missingFromDayLog} span=${segment.daysCoveredByRows.join('..')}`)
console.log(`output=${path.join(out, 'segment-audit.json')}`)


