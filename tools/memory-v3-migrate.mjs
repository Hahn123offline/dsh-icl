// v3 热迁移：把已验证的 staging v3 库里的 episode/段/实体/关系（以及缺失的 person 档案）
// 增量写入运行中的 live 记忆库。单事务、数秒完成；先 VACUUM INTO 热备份旧库。
//
// 用法：
//   node tools/memory-v3-migrate.mjs --staging <staging memory.db> \
//     [--state-dir ~/.dsh/icl/state] [--cutoff-day 2026-11-12] --yes-write-live
//
// 设计：
//  · 只写 v3 命名空间；v2 的 event/fact/preference/commitment 原样保留（切换后由 recall schema 过滤，不再召回）；
//  · episode 只导入 day < cutoff-day 的块（cutoff 当天交给下一次 dream 从完整 live raw 生成，避免半截日重复）；
//  · 段按 parentKey 关联，拷贝对应向量；实体/关系全量导入（幂等：同 key 已存在则跳过）；
//  · person 档案只补 live 里缺失的（不覆盖 live 现有档案）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
function argValue(argv, name) {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : null
}
const hasFlag = (argv, name) => argv.includes(`--${name}`)

const argv = process.argv.slice(2)
const stagingPath = path.resolve(String(argValue(argv, 'staging') ?? path.join(REPO_ROOT, '.state/lab/lead/rebuild/live-v3-2026-11-12/state/state/memory.db')))
const stateDir = path.resolve(String(argValue(argv, 'state-dir') ?? path.join(os.homedir(), '.dsh', 'icl', 'state')))
const liveDbFile = path.join(stateDir, 'state', 'memory.db')
const cutoffDay = String(argValue(argv, 'cutoff-day') ?? '2026-11-12')
if (!hasFlag(argv, 'yes-write-live')) {
  console.error('该工具会写入 live 记忆库；确认后加 --yes-write-live')
  process.exit(2)
}
if (!fs.existsSync(stagingPath) || !fs.existsSync(liveDbFile)) {
  console.error(`staging 或 live 库不存在：${stagingPath} / ${liveDbFile}`)
  process.exit(2)
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-')

// 1. 热备份（VACUUM INTO 得到一致快照；不阻塞运行中的 DSH 读取）。
const backupDir = path.join(stateDir, 'archive')
fs.mkdirSync(backupDir, { recursive: true })
const backupFile = path.join(backupDir, `memory-v2-${stamp}.db`)
{
  const backupDb = new DatabaseSync(liveDbFile)
  try {
    backupDb.exec('PRAGMA busy_timeout = 10000')
    backupDb.exec(`VACUUM INTO '${backupFile.replace(/'/g, "''")}'`)
  } finally { backupDb.close() }
}
console.log('热备份：', backupFile)

// 2. 读 staging。
const staging = new DatabaseSync(stagingPath, { readOnly: true })
const live = new DatabaseSync(liveDbFile)
live.exec('PRAGMA busy_timeout = 15000')
const stats = { episodes: 0, segments: 0, entities: 0, relations: 0, people: 0, vectors: 0, skipped: 0 }
const liveItemIds = new Map() // `${namespace}\0${key}` -> live id
const keyOf = (namespace, key) => `${namespace}\0${key}`
for (const row of live.prepare('SELECT id, namespace, key FROM mem_items').all()) {
  if (row.key) liveItemIds.set(keyOf(row.namespace, row.key), row.id)
}
const idMap = new Map() // staging item id -> live item id
const insertItem = live.prepare(`INSERT INTO mem_items (namespace, kind, key, text, data, weight, recall_count, last_recalled_at, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
const insertVec = live.prepare('INSERT OR REPLACE INTO mem_vec (item_id, dim, vec) VALUES (?, ?, ?)')
const readVec = staging.prepare('SELECT dim, vec FROM mem_vec WHERE item_id = ?')

function insertRow(row) {
  const existing = row.key ? liveItemIds.get(keyOf(row.namespace, row.key)) : null
  if (existing != null) { stats.skipped += 1; idMap.set(row.id, existing); return existing }
  const info = insertItem.run(
    row.namespace, row.kind, row.key, row.text, row.data, row.weight ?? 1, row.recall_count ?? 0,
    row.last_recalled_at ?? null, row.created_at ?? Date.now(), row.updated_at ?? Date.now(),
  )
  const liveId = Number(info.lastInsertRowid)
  if (row.key) liveItemIds.set(keyOf(row.namespace, row.key), liveId)
  idMap.set(row.id, liveId)
  const vec = readVec.get(row.id)
  if (vec) { insertVec.run(liveId, vec.dim, vec.vec); stats.vectors += 1 }
  return liveId
}

// 3. 注册缺失的命名空间（运行中的插件一般已注册；这里兜底）。
const stagingNs = staging.prepare('SELECT * FROM mem_ns WHERE id IN (?, ?, ?, ?)').all('episode', 'episode-seg', 'entity', 'relation')
const liveNsIds = new Set(live.prepare('SELECT id FROM mem_ns').all().map((row) => row.id))
const insertNs = live.prepare('INSERT OR IGNORE INTO mem_ns (id, label, recallable, half_life_days, retention, schema_version, owner, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
live.exec('BEGIN IMMEDIATE')
try {
  for (const row of stagingNs) {
    if (liveNsIds.has(row.id)) continue
    insertNs.run(row.id, row.label, row.recallable, row.half_life_days, row.retention, row.schema_version ?? 1, row.owner, row.created_at ?? Date.now())
  }
  // 4. episode（只导入 day < cutoff，避免把半截日固化）。
  const episodes = staging.prepare("SELECT * FROM mem_items WHERE namespace = 'episode' AND kind = 'block' ORDER BY id").all()
  const importedEpisodeKeys = new Set()
  for (const row of episodes) {
    let data = null
    try { data = row.data ? JSON.parse(row.data) : null } catch { data = null }
    if (data?.superseded === true) { stats.skipped += 1; continue }
    const day = String(data?.day ?? '')
    if (day && day >= cutoffDay) { stats.skipped += 1; continue }
    insertRow(row)
    if (row.key) importedEpisodeKeys.add(String(row.key))
    stats.episodes += 1
  }
  // 5. 段（父块必须已导入）。
  const segments = staging.prepare("SELECT * FROM mem_items WHERE namespace = 'episode-seg' AND kind = 'segment' ORDER BY id").all()
  for (const row of segments) {
    let data = null
    try { data = row.data ? JSON.parse(row.data) : null } catch { data = null }
    if (!data?.parentKey || !importedEpisodeKeys.has(String(data.parentKey))) { stats.skipped += 1; continue }
    insertRow(row)
    stats.segments += 1
  }
  // 6. 实体/关系全量（key 幂等）。
  for (const row of staging.prepare("SELECT * FROM mem_items WHERE namespace = 'entity' ORDER BY id").all()) {
    let data = null
    try { data = row.data ? JSON.parse(row.data) : null } catch { data = null }
    if (data?.superseded === true) { stats.skipped += 1; continue }
    insertRow(row)
    stats.entities += 1
  }
  for (const row of staging.prepare("SELECT * FROM mem_items WHERE namespace = 'relation' ORDER BY id").all()) {
    insertRow(row)
    stats.relations += 1
  }
  // 7. day log：补 live 缺失的日期（episode 证据/provenance 需要 day log 才能映射回原话）。
  stats.dayLogs = 0
  for (const row of staging.prepare("SELECT * FROM mem_items WHERE namespace = 'day' AND kind = 'log' ORDER BY id").all()) {
    if (row.key && liveItemIds.has(keyOf('day', row.key))) continue
    insertRow(row)
    stats.dayLogs += 1
  }
  // 8. person：只补 live 缺失的档案（不覆盖 live 现有档案）。
  for (const row of staging.prepare("SELECT * FROM mem_items WHERE namespace = 'person' AND kind = 'block' ORDER BY id").all()) {
    if (row.key && liveItemIds.has(keyOf('person', row.key))) continue
    insertRow(row)
    stats.people += 1
  }
  live.exec('COMMIT')
} catch (error) {
  try { live.exec('ROLLBACK') } catch { /* ignore */ }
  staging.close(); live.close()
  console.error('迁移失败，已回滚：', error?.message ?? error)
  process.exit(2)
}
const liveCounts = Object.fromEntries(live.prepare("SELECT namespace, COUNT(*) AS c FROM mem_items WHERE namespace IN ('episode','episode-seg','entity','relation','person') GROUP BY namespace").all().map((row) => [row.namespace, row.c]))
const vecCount = live.prepare('SELECT COUNT(*) AS c FROM mem_vec').get().c
staging.close(); live.close()

const outDir = path.join(REPO_ROOT, '.state/lab/lead/rebuild', `live-migrate-${stamp}`)
fs.mkdirSync(outDir, { recursive: true })
const manifest = {
  migratedAt: new Date().toISOString(), liveDbFile, stagingPath, backupFile, cutoffDay, stats, liveCounts, vecCount,
  note: 'v2 旧命名空间未删除、未改写；切换后由 recall schema=v3 隐藏。',
}
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
const hash = createHash('sha256').update(JSON.stringify({ stats, liveCounts })).digest('hex').slice(0, 16)
console.log('迁移完成：', JSON.stringify(stats))
console.log('live 计数：', JSON.stringify(liveCounts), 'vectors=', vecCount)
console.log('manifest：', path.join(outDir, 'manifest.json'), 'hash=', hash)

