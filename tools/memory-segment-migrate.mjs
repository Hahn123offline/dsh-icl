// S2：把历史 day log 登记为 legacy segment，并为旧 episode 回填 segmentId。
// 默认 dry-run；--write 才写。写 live 库路径需要显式 --yes-write-live（S4 由用户确认后执行）。
//
// 用法：
//   node tools/memory-segment-migrate.mjs --db <memory.db> [--raw <session-events.jsonl>]
//        [--write] [--yes-write-live] [--out <目录>]
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
function argValue(argv, name) {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : null
}
const argv = process.argv.slice(2)
const dbFile = path.resolve(String(argValue(argv, 'db') ?? path.join(os.homedir(), '.dsh', 'icl', 'state', 'state', 'memory.db')))
const rawFile = argValue(argv, 'raw') ? path.resolve(String(argValue(argv, 'raw'))) : null
const write = argv.includes('--write')
const livePath = dbFile.includes(`${path.sep}.dsh${path.sep}icl${path.sep}state`)
if (write && livePath && !argv.includes('--yes-write-live')) {
  console.error('拒绝写入 live 记忆库：加 --yes-write-live（S4 用户确认后）或先复制到 lab。')
  process.exit(2)
}
const outDir = path.resolve(String(argValue(argv, 'out') ?? path.join(REPO_ROOT, '.state/lab/lead/segment-migrate')))
fs.mkdirSync(outDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const report = { at: new Date().toISOString(), dbFile, rawFile, write, legacySegments: 0, episodesBackfilled: 0, skipped: [], cursor: null }

const db = new DatabaseSync(dbFile)
db.exec('PRAGMA busy_timeout = 15000')
const parseData = (value) => { try { return JSON.parse(value ?? '{}') } catch { return {} } }
const now = Date.now()

// 1. 历史 day log → legacy segment（每个 day 一条）。
const dayRows = db.prepare("SELECT id, key, text, data, created_at FROM mem_items WHERE namespace='day' AND kind='log' ORDER BY key").all()
const byDay = new Map()
for (const row of dayRows) {
  const data = parseData(row.data)
  const day = String(data.day ?? '')
  if (!day) continue
  if (!byDay.has(day)) byDay.set(day, [])
  byDay.get(day).push({ row, data })
}
const existingKeys = new Set(db.prepare("SELECT key FROM mem_items WHERE namespace='dream-segment' AND kind='segment'").all().map((row) => row.key))
const insertNs = db.prepare('INSERT OR IGNORE INTO mem_ns (id, label, recallable, half_life_days, retention, schema_version, owner, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
const insertItem = db.prepare(`INSERT INTO mem_items (namespace, kind, key, text, data, weight, recall_count, last_recalled_at, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
const updateItem = db.prepare('UPDATE mem_items SET data = ?, updated_at = ? WHERE id = ?')
const legacySegmentKey = (day) => `seg:legacy:${day}`
const legacyByDay = new Map()
if (write) db.exec('BEGIN IMMEDIATE')
try {
  if (write) insertNs.run('dream-segment', '记忆分区段', 0, 30, null, 1, 'dream', now)
  if (write) insertNs.run('dream-cursor', '记忆分区游标', 0, 30, null, 1, 'dream', now)
  for (const [day, logs] of byDay) {
    const key = legacySegmentKey(day)
    if (existingKeys.has(key)) { report.skipped.push({ day, reason: 'exists' }); continue }
    const rowIds = []
    const times = []
    const sources = []
    let startAt = null
    let endAt = null
    for (const { data } of logs) {
      for (const [index, id] of (Array.isArray(data.rowIds) ? data.rowIds : []).entries()) {
        const time = Number(Array.isArray(data.times) ? data.times[index] : 0)
        if (!id || !time) continue
        if (startAt == null || time < startAt) startAt = time
        if (endAt == null || time > endAt) endAt = time
        rowIds.push(String(id)); times.push(time); sources.push(String((data.sources ?? [])[index] ?? 'unknown'))
      }
    }
    const segmentData = {
      legacy: true, cutAt: endAt ?? now, startAt: startAt ?? now, endAt: endAt ?? now,
      trigger: 'legacy-migration', status: 'done', referenceDay: day,
      rows: rowIds.map((id, index) => ({ id, time: times[index] })), rowIds, times, sources,
      jobs: { legacy: 'done' }, migratedAt: now,
    }
    if (write) {
      insertItem.run('dream-segment', 'segment', key, `${day} 段`, JSON.stringify(segmentData), 1, 0, null, now, now)
    }
    legacyByDay.set(day, key)
    report.legacySegments += 1
  }
  // 2. 旧 episode 回填 segmentId（仅在其 day 有 legacy segment 时）。
  const episodes = db.prepare("SELECT id, data FROM mem_items WHERE namespace='episode' AND kind='block'").all()
  for (const row of episodes) {
    const data = parseData(row.data)
    const day = String(data.day ?? '')
    const segmentId = legacyByDay.get(day)
    if (!segmentId || data.segmentId === segmentId) continue
    if (write) updateItem.run(JSON.stringify({ ...data, segmentId }), now, row.id)
    report.episodesBackfilled += 1
  }
  // 3. cursor：以"最后一次成功 episodes dream 的完成时间"为已消费边界。
  // 不能用当前 raw 最大 seq（会把上次 dream 之后尚未整理的新消息永久跳过）。
  if (rawFile && fs.existsSync(rawFile)) {
    const lastRun = db.prepare("SELECT key, created_at, data FROM mem_items WHERE namespace='dream-run' AND key LIKE '%:episodes' ORDER BY created_at DESC LIMIT 1").get()
    let lastData = {}
    try { lastData = JSON.parse(lastRun?.data ?? '{}') } catch { lastData = {} }
    const cursorCutAt = Number(lastData.finishedAt ?? lastRun?.created_at ?? 0)
    const perSession = {}
    for (const line of fs.readFileSync(rawFile, 'utf8').split('\n')) {
      if (!line.trim()) continue
      let row = null
      try { row = JSON.parse(line) } catch { continue }
      if (cursorCutAt > 0 && Number(row.time) > cursorCutAt) continue // 之后的行属于下一次 dream
      const sessionId = String(row.sessionId ?? '')
      const seq = Number(row.seq)
      if (sessionId && Number.isFinite(seq)) perSession[sessionId] = Math.max(perSession[sessionId] ?? 0, seq)
    }
    report.cursorCutAt = cursorCutAt ? new Date(cursorCutAt).toISOString() : null
    report.cursor = { perSession, sessions: Object.keys(perSession).length, cutAt: report.cursorCutAt }
    if (write) {
      const existing = db.prepare("SELECT id FROM mem_items WHERE namespace='dream-cursor' AND kind='cursor' AND key='cursor:main'").get()
      const cursorData = JSON.stringify({ perSession, updatedAt: now, cutAt: cursorCutAt || null })
      if (existing) updateItem.run(cursorData, now, existing.id)
      else insertItem.run('dream-cursor', 'cursor', 'cursor:main', `${Object.keys(perSession).length} sessions`, cursorData, 1, 0, null, now, now)
    }
  }
  if (write) db.exec('COMMIT')
} catch (error) {
  try { if (write) db.exec('ROLLBACK') } catch { /* ignore */ }
  db.close()
  console.error('迁移失败，已回滚：', error?.message ?? error)
  process.exit(2)
}
const counts = Object.fromEntries(db.prepare("SELECT namespace, COUNT(*) c FROM mem_items WHERE namespace IN ('dream-segment','dream-cursor') GROUP BY namespace").all().map((row) => [row.namespace, row.c]))
db.close()
const output = { ...report, counts, dayLogs: byDay.size }
fs.writeFileSync(path.join(outDir, `migrate-${stamp}.json`), JSON.stringify(output, null, 2), 'utf8')
console.log(`${write ? '已写入' : 'DRY-RUN'}：dayLogs=${byDay.size} legacySegments=${report.legacySegments} episodesBackfilled=${report.episodesBackfilled} cursorSessions=${report.cursor?.sessions ?? 0}`)
console.log(`输出：${path.join(outDir, `migrate-${stamp}.json`)}`)

