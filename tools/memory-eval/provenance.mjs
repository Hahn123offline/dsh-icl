// evidence → fixture rowId 的溯源映射。
//
// 产品 wash 会在 day log 上写 `data.rowIds`（与绝对行号 1:1），这是首选通道；
// 拿不到时退回三层确定性匹配（day + 正文快照 + 时间），仍匹配不到才记 unresolved。
// 绝不猜：歧义就记 unresolved，让 provenanceRate 如实下降。
import { ymdInTz } from './fixture.mjs'

function normText(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, '')
}

/** 从导出的记忆条目里收集每天的 rowIds/times（wash 写、dream 之后仍在库里）。 */
export function collectDayLogs(exportedItems) {
  const parts = new Map()
  for (const item of exportedItems ?? []) {
    if (item.namespace !== 'day' || item.kind !== 'log') continue
    const day = String(item.data?.day ?? '')
    if (!day) continue
    const match = /^day:(.+?)(?::p(\d+))?$/.exec(String(item.key ?? ''))
    const part = match?.[2] ? Number(match[2]) : 1
    if (!parts.has(day)) parts.set(day, [])
    parts.get(day).push({ part, item })
  }
  const dayLogs = new Map()
  for (const [day, list] of parts) {
    list.sort((a, b) => a.part - b.part)
    const first = list[0].item
    const rowIds = Array.isArray(first.data?.rowIds) ? first.data.rowIds.map((x) => (x == null ? null : String(x))) : []
    const times = Array.isArray(first.data?.times) ? first.data.times.map(Number) : []
    const sources = Array.isArray(first.data?.sources) ? first.data.sources.map(String) : []
    dayLogs.set(day, { rowIds, times, sources, parts: list.length, text: list.map((entry) => String(entry.item.text ?? '')).join('\n') })
  }
  return dayLogs
}

function indexItems(exportedItems) {
  const byId = new Map()
  for (const item of exportedItems ?? []) byId.set(Number(item.id), item)
  return byId
}

/**
 * 建一个可复用的溯源上下文。
 * @param {object} fixture 标准化 fixture
 * @param {object} indexes fixture 索引
 * @param {Array} exportedItems memory.exportAll().items
 */
export function createProvenance(ctxFixture, indexes, exportedItems) {
  const { fixture, timezone, rowsById, rowsByDay } = { fixture: ctxFixture, ...indexes }
  const dayLogs = collectDayLogs(exportedItems)
  const itemsById = indexItems(exportedItems)

  function rowsOfDay(day) {
    return rowsByDay.get(String(day ?? '')) ?? []
  }

  /** 用"正文快照 + 行号/时间"在当天 rows 里做唯一匹配。 */
  function resolveByText(day, entry) {
    const rows = rowsOfDay(day)
    if (!rows.length) return null
    const needle = normText(String(entry?.line ?? '').replace(/…$/, '')).slice(0, 120)
    const at = Number(entry?.at)
    let candidates = rows
    if (Number.isFinite(at) && at > 0) {
      const sameAt = candidates.filter((row) => row.atMs === at)
      if (sameAt.length) candidates = sameAt
    }
    if (needle) {
      const hits = candidates.filter((row) => {
        const hay = normText(row.text)
        return hay.includes(needle) || needle.includes(hay.slice(0, 80))
      })
      if (hits.length === 1) return hits[0]
      if (hits.length > 1 && Number.isFinite(at) && at > 0) {
        const sorted = hits.slice().sort((a, b) => Math.abs(a.atMs - at) - Math.abs(b.atMs - at))
        if (sorted.length === 1 || Math.abs(sorted[0].atMs - at) !== Math.abs(sorted[1].atMs - at)) return sorted[0]
      }
      if (hits.length > 1) return null
    }
    if (Number.isFinite(at) && at > 0) {
      const sameAt = rows.filter((row) => row.atMs === at)
      if (sameAt.length === 1) return sameAt[0]
    }
    return null
  }

  /**
   * 解析一条 evidence 到 fixture rowId。
   * @returns {{rowId:string|null, via:string, day:string|null, entry:object}}
   */
  function resolveEvidence(entry, fallbackDay = null) {
    if (!entry || typeof entry !== 'object') return { rowId: null, via: 'empty', day: fallbackDay, entry }
    // 0) 产品侧新 hook：evidence 直接带 rowId（wash 的 data.rowIds 透传到 evidence 时）。
    const direct = String(entry.rowId ?? '').trim()
    if (direct && rowsById.has(direct)) return { rowId: direct, via: 'evidence.rowId', day: rowsById.get(direct).day, entry }
    const type = String(entry.type ?? 'day')
    if (type === 'note') return { rowId: null, via: 'note', day: fallbackDay, entry }
    const day = fallbackDay ?? (Number.isFinite(Number(entry.at)) && Number(entry.at) > 0 ? ymdInTz(Number(entry.at), timezone) : null)
    const log = day ? dayLogs.get(day) : null
    // 1) wash 的 data.rowIds（绝对行号 1:1，最可靠）
    const lineId = Number(entry.id)
    if (log && Number.isFinite(lineId) && lineId > 0 && lineId <= log.rowIds.length) {
      const mapped = log.rowIds[lineId - 1]
      if (mapped && rowsById.has(mapped)) return { rowId: mapped, via: 'daylog.rowIds', day, entry }
    }
    // 2) 正文快照 + 时间（唯一匹配）
    if (day) {
      const row = resolveByText(day, entry)
      if (row) return { rowId: row.id, via: 'text.at', day, entry }
    }
    // 3) 只有 at：同一天唯一时刻
    const at = Number(entry.at)
    if (day && Number.isFinite(at) && at > 0) {
      const sameAt = rowsOfDay(day).filter((row) => row.atMs === at)
      if (sameAt.length === 1) return { rowId: sameAt[0].id, via: 'at', day, entry }
    }
    return { rowId: null, via: 'unresolved', day, entry }
  }

  /**
   * 把一个记忆块的 evidence 全解析成 fixture rowId（note 型递归一层）。
   * @returns {{rowIds:string[], entries:Array, unresolved:Array}}
   */
  function mapItem(item) {
    const list = Array.isArray(item?.data?.evidence) ? item.data.evidence : []
    const claims = Array.isArray(item?.data?.claims) ? item.data.claims : []
    const all = [...list]
    for (const claim of claims) for (const entry of claim?.evidence ?? []) all.push(entry)
    const rowIds = []
    const entries = []
    const unresolved = []
    const fallbackDay = item?.data?.day ? String(item.data.day) : null
    for (const entry of all) {
      const resolved = resolveEvidence(entry, fallbackDay)
      if (resolved.rowId) {
        entries.push({ ...resolved, entry })
        if (!rowIds.includes(resolved.rowId)) rowIds.push(resolved.rowId)
        continue
      }
      if (String(entry?.type) === 'note') {
        const note = itemsById.get(Number(entry.id))
        const noteEvidence = Array.isArray(note?.data?.evidence) ? note.data.evidence : []
        let hitAny = false
        for (const inner of noteEvidence) {
          const innerResolved = resolveEvidence(inner, note?.data?.day ?? fallbackDay)
          if (innerResolved.rowId) {
            hitAny = true
            entries.push({ ...innerResolved, entry: inner })
            if (!rowIds.includes(innerResolved.rowId)) rowIds.push(innerResolved.rowId)
          } else {
            unresolved.push({ ...innerResolved, entry: inner, via: 'note-evidence.unresolved' })
          }
        }
        if (!hitAny) unresolved.push({ ...resolved, entry })
        continue
      }
      unresolved.push(resolved)
    }
    return { rowIds, entries, unresolved }
  }

  return { dayLogs, itemsById, resolveEvidence, mapItem, rowsById }
}
