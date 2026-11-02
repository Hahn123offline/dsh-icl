// 记忆插件：SQLite 单文件 + 命名空间，是"模型上下文之外"的唯一真实源。
//
// 它只做存储原语，**不理解任何业务**：
//   · 命名空间由使用者注册（事件/人物/梗/回忆游标……），注册时声明标签、可否被回忆、半衰期
//   · 记录只有两种：note（主动记下）与 block（沉淀后的块），由 kind 字段区分
//   · 权重/遗忘在这里算（因为它是存储层的事实），但**怎么用**由调用方决定
//   · 嵌入可选：插槽接上就向量化，没接上就退化成关键词，不报错
import fs from 'node:fs'

// 精确串通道开关（评测 A/B 用）
const LITERAL_ON = process.env.ICL_NO_LITERAL !== '1'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const name = 'memory'

const DEFAULT_DIM = 1024

export function apply(ctx) {
  const file = String(ctx.config.path ?? path.join(ctx.config.root ?? '.', 'state', 'memory.db'))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE IF NOT EXISTS mem_ns (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      recallable INTEGER NOT NULL DEFAULT 1,
      half_life_days REAL NOT NULL DEFAULT 30,
      retention TEXT,
      schema_version INTEGER NOT NULL DEFAULT 1,
      owner TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mem_items (
      id INTEGER PRIMARY KEY,
      namespace TEXT NOT NULL,
      kind TEXT NOT NULL,
      key TEXT,
      text TEXT NOT NULL,
      data TEXT,
      weight REAL NOT NULL DEFAULT 1,
      recall_count INTEGER NOT NULL DEFAULT 0,
      last_recalled_at INTEGER,
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
      weight: Number(row.weight ?? 1),
      recallCount: Number(row.recall_count ?? 0),
      lastRecalledAt: row.last_recalled_at == null ? null : Number(row.last_recalled_at),
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

  function bigramOverlap(text, needle) {
    const a = bigrams(text)
    const b = bigrams(needle)
    if (!b.size) return 0
    let inter = 0
    for (const g of b) if (a.has(g)) inter++
    return inter / b.size
  }


  /**
   * 从查询里抽"精确串"：路径、文件名、数字、英文词。
   * 这些不该和普通短语抢语义分——它们命中就是命中。
   */
  function literalTerms(text) {
    const s = String(text ?? '')
    const out = new Set()
    for (const m of s.matchAll(/[A-Za-z]:\\[^\s，。；、）)]+/g)) out.add(m[0])
    for (const m of s.matchAll(/[\w\u4e00-\u9fa5-]+\.(?:txt|md|json|mjs|js|py|log|db|png|jpg)/gi)) out.add(m[0])
    for (const m of s.matchAll(/\d+(?:\.\d+)?\s*(?:元|块|次|天|秒|分钟|小时|%|GB|MB)/g)) out.add(m[0])
    for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9_-]{3,}/g)) out.add(m[0])
    return [...out].map((x) => x.toLowerCase()).filter(Boolean)
  }

  function literalHits(itemText, terms) {
    if (!terms.length) return 0
    const hay = String(itemText ?? '').toLowerCase()
    let hit = 0
    for (const term of terms) if (hay.includes(term)) hit += 1
    return hit
  }

  function bigrams(text) {
    const set = new Set()
    const s = String(text ?? '').toLowerCase().replace(/\s+/g, '')
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
    return set
  }

  function cosine(a, b) {
    let dot = 0, na = 0, nb = 0
    const n = Math.min(a.length, b.length)
    for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
    return na && nb ? dot / Math.sqrt(na * nb) : 0
  }

  const api = {
    /** 注册命名空间。只有注册过的命名空间才允许写入。 */
    registerNamespace({ id, label = null, recallable = true, halfLifeDays = 30, retention = null, schemaVersion = 1, owner = null } = {}) {
      const ns = String(id ?? '')
      if (!/^[a-z][a-z0-9:_-]*$/i.test(ns)) throw new Error(`命名空间名不合法：${ns}`)
      const existing = db.prepare('SELECT * FROM mem_ns WHERE id = ?').get(ns)
      if (existing) return { id: ns, already: true, label: existing.label, recallable: Boolean(existing.recallable) }
      db.prepare('INSERT INTO mem_ns (id, label, recallable, half_life_days, retention, schema_version, owner, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(ns, String(label ?? ns), recallable ? 1 : 0, Number(halfLifeDays) || 30, retention == null ? null : String(retention), Number(schemaVersion) || 1, owner == null ? null : String(owner), ctx.now())
      return { id: ns, already: false }
    },

    namespaces() {
      return db.prepare('SELECT * FROM mem_ns ORDER BY id').all().map((row) => ({
        id: row.id,
        label: row.label,
        recallable: Boolean(row.recallable),
        halfLifeDays: Number(row.half_life_days),
        retention: row.retention,
        schemaVersion: Number(row.schema_version),
        owner: row.owner,
        count: Number(db.prepare('SELECT COUNT(*) AS c FROM mem_items WHERE namespace = ?').get(row.id).c),
      }))
    },

    namespaceInfo(id) {
      const row = db.prepare('SELECT * FROM mem_ns WHERE id = ?').get(String(id))
      return row ? { id: row.id, label: row.label, recallable: Boolean(row.recallable), halfLifeDays: Number(row.half_life_days), retention: row.retention } : null
    },

    put({ namespace, kind = 'note', key = null, text = '', data = null, weight = 1, now = ctx.now() } = {}) {
      const ns = String(namespace ?? '')
      if (!ns) throw new Error('memory.put 需要 namespace')
      if (!db.prepare('SELECT 1 FROM mem_ns WHERE id = ?').get(ns)) throw new Error(`命名空间没有注册：${ns}`)
      const body = String(text ?? '')
      if (!body.trim() && data == null) throw new Error('memory.put 需要 text 或 data')
      const at = Number(now)
      if (key != null) {
        const hit = db.prepare('SELECT id FROM mem_items WHERE namespace = ? AND key = ?').get(ns, String(key))
        if (hit) {
          db.prepare('UPDATE mem_items SET kind = ?, text = ?, data = ?, weight = ?, updated_at = ? WHERE id = ?')
            .run(String(kind), body, data == null ? null : JSON.stringify(data), Number(weight) || 1, at, hit.id)
          return { id: Number(hit.id), updated: true }
        }
      }
      const info = db.prepare('INSERT INTO mem_items (namespace, kind, key, text, data, weight, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(ns, String(kind), key == null ? null : String(key), body, data == null ? null : JSON.stringify(data), Number(weight) || 1, at, at)
      return { id: Number(info.lastInsertRowid), updated: false }
    },


    /**
     * 原文层检索：只做字面命中，不走语义。
     * 用途：块没覆盖到细节时，回到当时的原话里找一句作为出处。
     */
    archiveSearch({ query = '', limit = 2, exclude = [] } = {}) {
      let terms = literalTerms(query)
      // 没有精确串时退回按二元组找：问"哪个路径"这类问题仍然能定位到原话
      if (!terms.length) {
        const q = String(query ?? '').replace(/\s+/g, '')
        const grams = new Set()
        for (let i = 0; i < q.length - 1; i++) grams.add(q.slice(i, i + 2))
        terms = [...grams].filter((g) => !/[?？。，、]/.test(g)).slice(0, 12)
      }
      if (!terms.length) return []
      const skip = new Set(exclude.map((x) => String(x ?? '').trim()))
      // 只查"可被回忆"的命名空间；备忘（note）、纠正（resolve）这些不是记忆。
      const rows = db.prepare(`
        SELECT i.* FROM mem_items i JOIN mem_ns n ON n.id = i.namespace
        WHERE n.recallable = 1 ORDER BY i.created_at DESC LIMIT 2000
      `).all().map(rowToItem)
      const scored = []
      for (const item of rows) {
        if (item.kind !== 'note') continue
        if (skip.has(String(item.text ?? '').trim())) continue
        let hit = 0
        for (const term of terms) if (String(item.text).toLowerCase().includes(term)) hit += 1
        if (hit) scored.push({ item, hit })
      }
      scored.sort((a, b) => b.hit - a.hit || Number(b.item.createdAt) - Number(a.item.createdAt))
      return scored.slice(0, Math.max(1, Number(limit) || 2)).map((s) => s.item)
    },

    /** 原始列表（不做排序/评分）。 */
    query({ namespace, kind = null, key = null, since = null, until = null, limit = 50 } = {}) {
      const ns = String(namespace ?? '')
      if (!ns) throw new Error('memory.query 需要 namespace')
      const where = ['namespace = ?']
      const args = [ns]
      if (kind != null) { where.push('kind = ?'); args.push(String(kind)) }
      if (key != null) { where.push('key = ?'); args.push(String(key)) }
      if (since != null) { where.push('created_at >= ?'); args.push(Number(since)) }
      if (until != null) { where.push('created_at <= ?'); args.push(Number(until)) }
      args.push(Math.max(1, Math.min(500, Number(limit) || 50)))
      return db.prepare(`SELECT * FROM mem_items WHERE ${where.join(' AND ')} ORDER BY created_at ASC LIMIT ?`).all(...args).map(rowToItem)
    },

    /**
     * 检索（带评分）：相似度 × 权重 × 时间衰减。
     * @returns {Promise<Array<{item:object, score:number}>>}
     */
    async search({ namespace = null, namespaces = null, query = '', limit = 8, includeArchive = false, now = ctx.now(), minScore = null, tags = null, tagMode = 'any', conv = null } = {}) {
      const list = namespaces ?? (namespace == null ? null : [namespace])
      let nsRows = list
        ? list.map((id) => api.namespaceInfo(id)).filter(Boolean)
        : db.prepare('SELECT * FROM mem_ns').all().map((row) => ({ id: row.id, recallable: Boolean(row.recallable), halfLifeDays: Number(row.half_life_days) }))
      if (!includeArchive) nsRows = nsRows.filter((row) => row.recallable !== false)
      const nsIds = nsRows.map((row) => row.id)
      if (!nsIds.length) return []
      const placeholders = nsIds.map(() => '?').join(',')
      let rows = db.prepare(`SELECT * FROM mem_items WHERE namespace IN (${placeholders}) ORDER BY created_at DESC LIMIT 500`).all(...nsIds)
      // 被整理轮合并掉的块不再被回忆（软删：行还在，可追溯）。
      rows = rows.filter((row) => {
        if (!row.data) return true
        try { return JSON.parse(row.data)?.superseded !== true } catch { return true }
      })
      if (!rows.length) return []
      // 标签只做"缩小范围"，不参与打分——否则调用方可以靠堆标签把相关度刷上去。
      const wantedTags = Array.isArray(tags) ? tags.map((x) => String(x).toLowerCase()).filter(Boolean) : null
      if (conv) {
        rows = rows.filter((row) => {
          if (!row.data) return false
          try { return JSON.parse(row.data)?.origin?.conv === String(conv) } catch { return false }
        })
        if (!rows.length) return []
      }
      if (wantedTags && wantedTags.length) {
        rows = rows.filter((row) => {
          let data = null
          try { data = row.data ? JSON.parse(row.data) : null } catch { data = null }
          const have = new Set((data?.tags ?? []).map((x) => String(x).toLowerCase()))
          return tagMode === 'all' ? wantedTags.every((x) => have.has(x)) : wantedTags.some((x) => have.has(x))
        })
        if (!rows.length) return []
      }

      const halfLife = new Map(nsRows.map((row) => [row.id, Number(row.halfLifeDays) || 30]))
      const qvec = await embed(query)
      const needle = String(query ?? '').toLowerCase()
      const scored = []
      for (const row of rows) {
        const item = rowToItem(row)
        let sim = 0
        if (qvec) {
          const hit = db.prepare('SELECT vec, dim FROM mem_vec WHERE item_id = ?').get(row.id)
          const cos = hit ? cosine(qvec, new Float32Array(new Uint8Array(hit.vec).buffer)) : 0
          // 混合：向量语义 + 字面命中。只靠向量时，"他怕什么"会输给
          // 其他看起来也很相似的块；字面命中能把真正写着那件事的块拉上来。
          const lex = needle ? bigramOverlap(item.text, needle) : 0
          sim = 0.7 * cos + 0.3 * lex
          // 精确串命中：路径/文件名/数字，加一个强权重（不靠语义猜）
          const terms = LITERAL_ON && needle ? literalTerms(query) : []
          const exact = literalHits(item.text, terms)
          if (exact) sim = Math.min(1, sim + 0.5 * (exact / terms.length))
        } else if (needle) {
          // 没有嵌入时的退化：字面命中之外，用二元组重叠度估一个相似度，
          // 否则「他怕什么」永远找不到「怕水」。
          const a = bigrams(item.text)
          const b = bigrams(needle)
          let inter = 0
          for (const g of b) if (a.has(g)) inter++
          sim = b.size ? inter / b.size : 0
        } else {
          sim = 1 // 无查询 = 按"新鲜度/权重"排
        }
        if (sim <= 0) continue
        const anchor = item.lastRecalledAt ?? item.createdAt
        const ageDays = Math.max(0, (Number(now) - anchor) / 86_400_000)
        const hl = halfLife.get(item.namespace) ?? 30
        const decay = Math.exp(-ageDays / Math.max(1, hl))
        const score = sim * item.weight * decay
        if (minScore != null && score < Number(minScore)) continue
        scored.push({ item, score })
      }
      return scored.sort((a, b) => b.score - a.score || b.item.createdAt - a.item.createdAt).slice(0, Math.max(1, Number(limit) || 8))
    },

    /** 召回成功：回到"新鲜"状态（权重回升、计时重置）。 */
    boost(ids, { now = ctx.now(), amount = 0.2, maxWeight = 5 } = {}) {
      const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter((n) => Number.isFinite(n))
      let n = 0
      const stmt = db.prepare('UPDATE mem_items SET weight = MIN(?, weight + ?), recall_count = recall_count + 1, last_recalled_at = ? WHERE id = ?')
      for (const id of list) n += Number(stmt.run(Number(maxWeight), Number(amount) || 0, Number(now), id).changes ?? 0)
      return { boosted: n }
    },

    /** 局部更新：只改 text 或 data，动不到权重与计时（沉淀标记、人物档案就用它）。 */
    patch(id, { text = null, data = null } = {}) {
      const row = db.prepare('SELECT * FROM mem_items WHERE id = ?').get(Number(id))
      if (!row) return { updated: false }
      const nextText = text == null ? row.text : String(text)
      const nextData = data == null ? row.data : JSON.stringify(data)
      db.prepare('UPDATE mem_items SET text = ?, data = ?, updated_at = ? WHERE id = ?').run(nextText, nextData, ctx.now(), Number(id))
      return { updated: true }
    },

    /** 标签频次（看看有没有爆炸）。 */
    tags({ namespace = null, limit = 100 } = {}) {
      const rows = namespace
        ? db.prepare('SELECT data FROM mem_items WHERE namespace = ?').all(String(namespace))
        : db.prepare('SELECT data FROM mem_items').all()
      const counts = new Map()
      for (const row of rows) {
        let data = null
        try { data = row.data ? JSON.parse(row.data) : null } catch { data = null }
        for (const tag of data?.tags ?? []) {
          const key = String(tag).toLowerCase()
          counts.set(key, (counts.get(key) ?? 0) + 1)
        }
      }
      return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count).slice(0, Math.max(1, Number(limit) || 100))
    },

    /**
     * 身份解析：先精确匹配账号，再按名字在档案正文里找候选。
     * 它不做"语义回忆"，只回答"这个人是谁"。
     */
    findPerson({ qq = null, idKind = null, value = null, name = null, subject = null, limit = 5 } = {}) {
      const blocks = db.prepare("SELECT * FROM mem_items WHERE namespace = 'person' AND kind = 'block'").all().map(rowToItem)
      const wanted = []
      if (qq != null) wanted.push({ kind: 'qq', value: String(qq) })
      if (subject?.kind && subject?.value) wanted.push({ kind: String(subject.kind), value: String(subject.value) })
      if (idKind != null && value != null) wanted.push({ kind: String(idKind), value: String(value) })
      if (wanted.length) {
        const exact = blocks.filter((b) => {
          const ids = b.data?.ids ?? []
          if (ids.some((id) => wanted.some((w) => String(id.kind) === w.kind && String(id.value) === w.value))) return true
          const subj = b.data?.subject
          if (subj && wanted.some((w) => String(subj.kind) === w.kind && String(subj.value) === w.value)) return true
          if (wanted.some((w) => w.kind === 'qq' && b.key === `person:${w.value}`)) return true
          if (wanted.some((w) => w.kind === 'qq' && String(b.data?.qq ?? '') === w.value)) return true
          return false
        })
        if (exact.length) return { exact: true, people: exact.slice(0, Math.max(1, Number(limit) || 5)) }
      }
      const needle = String(name ?? '').trim().toLowerCase()
      if (!needle) return { exact: false, people: [] }
      const hits = blocks.filter((b) => `${b.text}\n${b.data?.profile ?? ''}`.toLowerCase().includes(needle))
      return { exact: false, people: hits.slice(0, Math.max(1, Number(limit) || 5)) }
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

    stats() {
      return {
        items: Number(db.prepare('SELECT COUNT(*) AS c FROM mem_items').get().c),
        vectors: Number(db.prepare('SELECT COUNT(*) AS c FROM mem_vec').get().c),
        namespaces: Number(db.prepare('SELECT COUNT(*) AS c FROM mem_ns').get().c),
        embedded: embedAvailable(),
      }
    },

    /** 列出还没向量化的条目（整理轮/补建索引用）。 */
    missingVectors({ limit = 100 } = {}) {
      // 只给"可被回忆"的命名空间补向量：
      // 梦境的运行记录（dream-run）之类不参与检索，没必要占嵌入额度。
      const rows = db.prepare(`
        SELECT i.id, i.namespace, i.kind, i.text FROM mem_items i
        JOIN mem_ns n ON n.id = i.namespace
        LEFT JOIN mem_vec v ON v.item_id = i.id
        WHERE v.item_id IS NULL AND i.text <> '' AND n.recallable = 1
        ORDER BY i.created_at ASC LIMIT ?
      `).all(Math.max(1, Math.min(500, Number(limit) || 100)))
      return rows.map((r) => ({ id: Number(r.id), namespace: r.namespace, kind: r.kind, text: r.text }))
    },

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
