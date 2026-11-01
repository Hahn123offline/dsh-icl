// 记忆插件：SQLite 单文件 + 命名空间，是"模型上下文之外"的唯一真实源。
//
// 规矩（架构决定）：
//   · 只提供 put / query / search / remove 四个动作，不暴露任何"业务语义"
//   · 不同插件用**不同命名空间**，互不污染；会话可以有自己的命名空间
//   · 嵌入是可选的：声明 embed-text 插槽，由模型管理插件按形状接线；
//     没接线就退化成关键词检索，不能因此坏掉
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const name = 'memory'

const DEFAULT_DIM = 1024

export function apply(ctx) {
  const file = String(ctx.config.path ?? path.join(ctx.config.root ?? '.', 'state', 'memory.db'))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE IF NOT EXISTS mem_items (
      id INTEGER PRIMARY KEY,
      namespace TEXT NOT NULL,
      kind TEXT NOT NULL,
      key TEXT,
      text TEXT NOT NULL,
      data TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_mem_key ON mem_items(namespace, key) WHERE key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS ix_mem_ns ON mem_items(namespace, created_at);
    CREATE TABLE IF NOT EXISTS mem_vec (
      item_id INTEGER PRIMARY KEY,
      dim INTEGER NOT NULL,
      vec BLOB NOT NULL
    );
  `)

  const embedSlot = ctx.manifest.slots?.[0]?.id ?? 'embed-text'

  function rowToItem(row) {
    return {
      id: Number(row.id),
      namespace: row.namespace,
      kind: row.kind,
      key: row.key,
      text: row.text,
      data: row.data ? JSON.parse(row.data) : null,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }
  }

  function embedAvailable() {
    try { return Boolean(ctx.slots.resolve(embedSlot)) } catch { return false }
  }

  async function embed(text) {
    if (!embedAvailable()) return null
    try {
      const out = await ctx.slots.call(embedSlot, { input: String(text) })
      const vec = Array.isArray(out?.[0]) ? out[0] : out?.data?.[0]?.embedding ?? out?.vectors?.[0] ?? null
      return Array.isArray(vec) && vec.length ? vec : null
    } catch { return null }
  }

  function saveVec(id, vec) {
    if (!vec) return
    const f32 = Float32Array.from(vec)
    db.prepare('INSERT INTO mem_vec (item_id, dim, vec) VALUES (?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET dim = excluded.dim, vec = excluded.vec')
      .run(id, f32.length, new Uint8Array(f32.buffer))
  }

  function cosine(a, b) {
    let dot = 0, na = 0, nb = 0
    const n = Math.min(a.length, b.length)
    for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
    return na && nb ? dot / Math.sqrt(na * nb) : 0
  }

  const api = {
    put({ namespace, kind = 'note', key = null, text = '', data = null, now = ctx.now() } = {}) {
      const ns = String(namespace ?? '')
      if (!ns) throw new Error('memory.put 需要 namespace')
      const body = String(text ?? '')
      if (!body.trim() && data == null) throw new Error('memory.put 需要 text 或 data')
      const at = Number(now)
      if (key != null) {
        const existing = db.prepare('SELECT id FROM mem_items WHERE namespace = ? AND key = ?').get(ns, String(key))
        if (existing) {
          db.prepare('UPDATE mem_items SET kind = ?, text = ?, data = ?, updated_at = ? WHERE id = ?')
            .run(String(kind), body, data == null ? null : JSON.stringify(data), at, existing.id)
          return { id: Number(existing.id), updated: true }
        }
      }
      const info = db.prepare('INSERT INTO mem_items (namespace, kind, key, text, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(ns, String(kind), key == null ? null : String(key), body, data == null ? null : JSON.stringify(data), at, at)
      return { id: Number(info.lastInsertRowid), updated: false }
    },

    /** 按命名空间/种类/时间取原文（梦境与召回用）。 */
    query({ namespace, kind = null, limit = 50, since = null, until = null } = {}) {
      const ns = String(namespace ?? '')
      if (!ns) throw new Error('memory.query 需要 namespace')
      const where = ['namespace = ?']
      const args = [ns]
      if (kind != null) { where.push('kind = ?'); args.push(String(kind)) }
      if (since != null) { where.push('created_at >= ?'); args.push(Number(since)) }
      if (until != null) { where.push('created_at <= ?'); args.push(Number(until)) }
      args.push(Math.max(1, Math.min(500, Number(limit) || 50)))
      return db.prepare(`SELECT * FROM mem_items WHERE ${where.join(' AND ')} ORDER BY created_at ASC LIMIT ?`).all(...args).map(rowToItem)
    },

    /** 检索：有嵌入用余弦，没有就退化成关键词。 */
    async search({ namespace, query = '', limit = 8 } = {}) {
      const ns = String(namespace ?? '')
      if (!ns) throw new Error('memory.search 需要 namespace')
      const rows = db.prepare('SELECT * FROM mem_items WHERE namespace = ? ORDER BY created_at DESC LIMIT 500').all(ns)
      if (!rows.length) return []
      const vec = await embed(query)
      if (vec) {
        const scored = []
        for (const row of rows) {
          const hit = db.prepare('SELECT vec, dim FROM mem_vec WHERE item_id = ?').get(row.id)
          if (!hit) continue
          const f32 = new Float32Array(new Uint8Array(hit.vec).buffer)
          scored.push({ item: rowToItem(row), score: cosine(vec, f32) })
        }
        if (scored.length) return scored.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Number(limit) || 8))
      }
      const needle = String(query ?? '').toLowerCase()
      if (!needle) return rows.slice(0, limit).map((row) => ({ item: rowToItem(row), score: 0 }))
      return rows
        .filter((row) => String(row.text).toLowerCase().includes(needle))
        .slice(0, Math.max(1, Number(limit) || 8))
        .map((row) => ({ item: rowToItem(row), score: 1 }))
    },

    remove({ namespace, key = null, id = null } = {}) {
      const ns = String(namespace ?? '')
      if (!ns) throw new Error('memory.remove 需要 namespace')
      if (id != null) {
        const info = db.prepare('DELETE FROM mem_items WHERE namespace = ? AND id = ?').run(ns, Number(id))
        return { removed: Number(info.changes ?? 0) }
      }
      if (key == null) throw new Error('memory.remove 需要 key 或 id')
      const info = db.prepare('DELETE FROM mem_items WHERE namespace = ? AND key = ?').run(ns, String(key))
      return { removed: Number(info.changes ?? 0) }
    },

    namespaces() {
      return db.prepare('SELECT namespace, COUNT(*) AS count FROM mem_items GROUP BY namespace ORDER BY namespace').all()
        .map((r) => ({ namespace: r.namespace, count: Number(r.count) }))
    },

    stats() { return { items: Number(db.prepare('SELECT COUNT(*) AS c FROM mem_items').get().c), vectors: Number(db.prepare('SELECT COUNT(*) AS c FROM mem_vec').get().c), embedded: embedAvailable() } },

    /** 给梦境用：把一条记忆向量化（异步，失败不抛）。 */
    async index(id, text) {
      const vec = await embed(text)
      if (vec) saveVec(Number(id), vec)
      return Boolean(vec)
    },
  }

  ctx.services.provide('memory', api)
  ctx.log({ msg: 'memory.ready', file, embedded: embedAvailable() })
  ctx.onDispose(() => { try { db.close() } catch { /* 已关 */ } })
  return api
}
