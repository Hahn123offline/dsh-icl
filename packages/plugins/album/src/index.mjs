// 相册 / 本地多媒体管理（红队 P0 项目：图片记忆 + 本地相册）。
// 设计见 docs/ALBUM.md；本文件是最小可用实现：
//   入库（内容哈希去重）→ 列表 → 按描述/标签搜 → 多图拼宫格 → 保留策略 → 体检。
// 约束：媒体只落在相册根（默认 ICL_ROOT/album，见 packages/core/src/icl-paths.mjs）下；
//       图片只走文件路径/attachment（不进静态 system/facts）。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { iclPaths } from '../../../core/src/icl-paths.mjs'

export const name = 'album'

/** 只读文件头（默认 64KiB），不把 512MiB 文件整个读进内存。 */
export function readFileHead(file, maxBytes = 64 * 1024) {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const length = Math.max(0, Math.min(Number(maxBytes) || 0, size))
    const buf = Buffer.alloc(length)
    if (length) fs.readSync(fd, buf, 0, length, 0)
    return buf
  } finally {
    fs.closeSync(fd)
  }
}

const execFileAsync = promisify(execFile)

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v'])
const DEFAULT_LIBRARY = 'default'

/** 宫格布局（纯函数，供测试与 collage 共用）。 */
export function planGrid(count, cols = 4, cell = 320, gap = 8) {
  const n = Math.max(0, Number(count) || 0)
  const c = Math.min(8, Math.max(1, Number(cols) || 4))
  const size = Math.min(1024, Math.max(128, Number(cell) || 320))
  const g = Math.max(0, Number(gap) || 8)
  const rows = Math.ceil(n / c)
  return {
    count: n,
    cols: c,
    rows,
    cell: size,
    gap: g,
    width: c * size + (c + 1) * g,
    height: Math.max(0, rows * size + (rows + 1) * g),
  }
}

/** 只读文件头拿图片尺寸（PNG/JPEG/GIF/WebP/BMP）；拿不到返回 null，不抛。 */
export function readImageSize(buf, ext = '') {
  try {
    const e = String(ext).toLowerCase()
    if (e === '.png' && buf.length >= 24) {
      if (buf.readUInt32BE(0) !== 0x89504e47) return null
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
    }
    if ((e === '.gif') && buf.length >= 10) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
    }
    if (e === '.bmp' && buf.length >= 26) {
      return { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) }
    }
    if (e === '.webp' && buf.length >= 30) {
      const form = buf.toString('ascii', 0, 4)
      if (form !== 'RIFF') return null
      const chunk = buf.toString('ascii', 12, 16)
      if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
      if (chunk === 'VP8L') {
        const bits = buf.readUInt32LE(21)
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) }
      }
      if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
      return null
    }
    if ((e === '.jpg' || e === '.jpeg') && buf.length > 4) {
      if (buf[0] !== 0xff || buf[1] !== 0xd8) return null
      let at = 2
      while (at + 9 < buf.length) {
        if (buf[at] !== 0xff) { at += 1; continue }
        const marker = buf[at + 1]
        if (marker === 0xd8 || marker === 0xd9) { at += 2; continue }
        const len = buf.readUInt16BE(at + 2)
        if (len < 2) return null
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { width: buf.readUInt16BE(at + 7), height: buf.readUInt16BE(at + 5) }
        }
        at += 2 + len
      }
      return null
    }
  } catch { return null }
  return null
}

const PY_COLLAGE = String.raw`
import json, sys
from PIL import Image, ImageDraw

plan = json.load(open(sys.argv[1], encoding='utf-8'))
cols, rows, cell, gap = plan['cols'], plan['rows'], plan['cell'], plan['gap']
W = cols * cell + (cols + 1) * gap
H = max(1, rows * cell + (rows + 1) * gap)
canvas = Image.new('RGB', (W, H), (12, 12, 14))
draw = ImageDraw.Draw(canvas)
ok = 0
for c in plan['cells']:
    try:
        im = Image.open(c['path'])
        im = im.convert('RGB')
    except Exception:
        continue
    im.thumbnail((cell, cell))
    x = c['col'] * (cell + gap) + gap + (cell - im.width) // 2
    y = c['row'] * (cell + gap) + gap + (cell - im.height) // 2
    canvas.paste(im, (x, y))
    if c.get('label'):
        draw.text((x + 4, y + 4), str(c['label']), fill=(255, 255, 255))
    ok += 1
if ok == 0:
    print(json.dumps({'ok': False, 'error': 'no-readable-image'}))
    sys.exit(2)
canvas.save(plan['out'], 'PNG')
print(json.dumps({'ok': True, 'path': plan['out'], 'width': W, 'height': H, 'painted': ok}))
`

const fmtSize = (bytes) => {
  const n = Number(bytes) || 0
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`
  return `${n} B`
}
const stamp = (ms) => {
  const t = Number(ms) > 0 ? new Date(Number(ms)) : new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`
}
const dayKey = (ms) => {
  const t = new Date(Number(ms) || Date.now())
  const p = (n) => String(n).padStart(2, '0')
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}`
}
const tagList = (raw) => {
  // DB 里 tags 存 JSON 字符串；内存里可能是数组。两种都认。
  let value = raw
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try { value = JSON.parse(value) } catch { /* 当普通字符串处理 */ }
  }
  if (Array.isArray(value)) return [...new Set(value.map((x) => String(x).trim().toLowerCase()).filter(Boolean))].slice(0, 12)
  if (typeof value === 'string') return tagList(value.split(/[,，\s]+/))
  return []
}
const safeLibrary = (raw) => {
  const s = String(raw ?? DEFAULT_LIBRARY).trim()
  return /^[a-zA-Z0-9_-]{1,40}$/.test(s) ? s : DEFAULT_LIBRARY
}
const sha256File = (file) => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256')
  const stream = fs.createReadStream(file)
  stream.on('data', (chunk) => hash.update(chunk))
  stream.on('error', reject)
  stream.on('end', () => resolve(hash.digest('hex')))
})

export function apply(ctx) {
  // 相册根：显式 root > ICL_ALBUM_DIR > ICL_ROOT/album（旧 <stateDir>/media 可读兼容）。
  const root = path.resolve(String(ctx.config.root ?? iclPaths().albumDir))
  const dbFile = path.join(root, 'media.db')
  const collagesDir = path.join(root, 'collages')
  const tmpDir = path.join(root, 'tmp')
  // 用户拍板（2026-11-06）：不自动删除（默认 retentionDays=0 关闭）；单文件默认 512MiB；
  // 总量只做软告警（默认 >10GiB 提示），不做自动清理；清理只走手动 album_prune。
  const warnBytes = Math.max(1024 * 1024, Number(ctx.config.warnBytes ?? 10 * 1024 * 1024 * 1024))
  const maxFileBytes = Math.max(1024 * 1024, Number(ctx.config.maxFileBytes ?? 512 * 1024 * 1024))
  const retentionDays = Math.max(0, Number(ctx.config.retentionDays ?? 0))
  const collageMax = Math.min(24, Math.max(1, Number(ctx.config.collageMax ?? 16)))
  const maxImportPerCall = Math.min(32, Math.max(1, Number(ctx.config.maxImportPerCall ?? 32)))
  const python = String(ctx.config.python ?? process.env.ALBUM_PYTHON ?? 'python')
  // 二阶段：图片记忆（CLIP 512d，CPU；可由 config 关闭/延迟批处理）。不把向量写进 system/facts。
  const embedEnabled = ctx.config.embedEnabled !== false
  const embedDefer = ctx.config.embedDefer === true
  const embedSlotId = String(ctx.config.embedSlot ?? 'image-embed')
  const embedDim = Math.max(64, Number(ctx.config.embedDim ?? 512))
  const embedBatchMax = Math.min(32, Math.max(1, Number(ctx.config.embedBatchMax ?? 8)))
  const captionConfig = ctx.config.caption && typeof ctx.config.caption === 'object' ? { ...ctx.config.caption } : {}
  const captionPrompt = String(ctx.config.captionPrompt ?? '用一句中文描述这张图片的内容和氛围（30 字以内）。')
  const captionMax = Math.min(8, Math.max(1, Number(ctx.config.captionMax ?? 3)))

  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(collagesDir, { recursive: true })
  fs.mkdirSync(tmpDir, { recursive: true })

  const db = new DatabaseSync(dbFile)
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sha256 TEXT NOT NULL UNIQUE,
      library TEXT NOT NULL DEFAULT 'default',
      kind TEXT NOT NULL,
      path TEXT NOT NULL,
      ext TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      width INTEGER,
      height INTEGER,
      duration_ms INTEGER,
      source TEXT,
      origin TEXT,
      caption TEXT,
      tags TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      private INTEGER NOT NULL DEFAULT 0,
      sent_at INTEGER,
      created_at INTEGER,
      imported_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_items_library ON items(library, deleted_at, imported_at);
    CREATE INDEX IF NOT EXISTS idx_items_source ON items(source);
    CREATE TABLE IF NOT EXISTS item_vectors (
      item_id INTEGER PRIMARY KEY,
      model TEXT,
      dim INTEGER NOT NULL,
      vec BLOB NOT NULL,
      source TEXT,
      updated_at INTEGER NOT NULL
    );
  `)
  // 旧库迁移：items 没有 private 列时补上（默认 0=普通相册）
  try {
    const columns = db.prepare('PRAGMA table_info(items)').all().map((row) => row.name)
    if (!columns.includes('private')) db.exec('ALTER TABLE items ADD COLUMN private INTEGER NOT NULL DEFAULT 0')
  } catch { /* 迁移失败时新库直接按 CREATE TABLE 走 */ }
  const q = {
    bySha: db.prepare('SELECT * FROM items WHERE sha256 = ?'),
    byId: db.prepare('SELECT * FROM items WHERE id = ? AND deleted_at IS NULL'),
    insert: db.prepare(`INSERT INTO items (sha256, library, kind, path, ext, bytes, width, height, duration_ms, source, origin, caption, tags, pinned, created_at, imported_at, private)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    updateMeta: db.prepare('UPDATE items SET library = COALESCE(?, library), source = COALESCE(?, source), origin = COALESCE(?, origin), caption = COALESCE(?, caption), tags = COALESCE(?, tags) WHERE id = ?'),
    touchDeleted: db.prepare('UPDATE items SET deleted_at = ? WHERE id = ?'),
    total: db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM items WHERE deleted_at IS NULL'),
    all: db.prepare('SELECT * FROM items WHERE deleted_at IS NULL ORDER BY imported_at DESC, id DESC'),
    setCaption: db.prepare('UPDATE items SET caption = ? WHERE id = ?'),
    vecById: db.prepare('SELECT * FROM item_vectors WHERE item_id = ?'),
    vecPut: db.prepare('INSERT INTO item_vectors (item_id, model, dim, vec, source, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET model = excluded.model, dim = excluded.dim, vec = excluded.vec, source = excluded.source, updated_at = excluded.updated_at'),
    vecCount: db.prepare('SELECT COUNT(*) AS n FROM item_vectors'),
    vecDimCount: db.prepare('SELECT dim, COUNT(*) AS n FROM item_vectors GROUP BY dim'),
  }

  const absOf = (row) => path.resolve(root, String(row.path))
  const displayPath = (row) => path.join(root, String(row.path))
  const metaLine = (row) => {
    const tags = tagList(row.tags)
    return `#${row.id} ${stamp(row.imported_at)} ${row.kind}${row.width ? ` ${row.width}x${row.height}` : ''} ${fmtSize(row.bytes)}` +
      `${tags.length ? ` [${tags.join(',')}]` : ''}${row.source ? ` · ${row.source}` : ''}${row.caption ? ` · ${row.caption}` : ''} — ${displayPath(row)}` +
      `${Number(row.private) ? '（隐私相册）' : ''}${row.sent_at ? `（已发过 ${stamp(row.sent_at)}）` : ''}`
  }
  const kindOf = (ext) => (IMAGE_EXT.has(ext) ? 'image' : VIDEO_EXT.has(ext) ? 'video' : null)
  const describe = (query, row) => {
    const needle = String(query).toLowerCase()
    return [row.caption, row.tags, row.source, row.origin, row.path].some((v) => String(v ?? '').toLowerCase().includes(needle))
  }

  /* ── 图片记忆/语义检索（二阶段，CLIP 512d CPU） ─────────────── */

  const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' }
  const providerForEmbed = () => { try { return ctx.slots.resolve(embedSlotId) } catch { return null } }
  const embedAvailable = () => Boolean(providerForEmbed())

  function imageDataUrl(file, ext = '') {
    const mime = MIME[String(ext).toLowerCase()] ?? 'application/octet-stream'
    return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`
  }
  function toF32(vec) {
    const f32 = Float32Array.from(vec)
    return { dim: f32.length, buf: new Uint8Array(f32.buffer) }
  }
  function fromF32(blob) {
    const view = new Uint8Array(blob)
    return Float32Array.from(new Float32Array(view.buffer, view.byteOffset, Math.floor(view.byteLength / 4)))
  }
  function cosine(a, b) {
    let dot = 0; let na = 0; let nb = 0
    const n = Math.min(a.length, b.length)
    for (let i = 0; i < n; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
    if (!na || !nb) return 0
    return dot / Math.sqrt(na * nb)
  }

  /** 对 512d 图文空间做一次嵌入；维度断言，不一致直接报可操作错误。 */
  async function embedInput(input) {
    const provider = providerForEmbed()
    if (!provider) throw new Error('没有接入图文嵌入服务（8088 clip-zh，512d）；先配 clip-zh provider 或关 embedEnabled')
    const out = await ctx.slots.call(embedSlotId, { input: String(input) })
    const vec = Array.isArray(out?.[0]) ? out[0] : (out?.embedding ?? out?.vectors?.[0] ?? null)
    if (!Array.isArray(vec) || !vec.length) throw new Error('嵌入服务返回空向量')
    if (vec.length !== embedDim) throw new Error(`嵌入维度不匹配（期望 ${embedDim}，实际 ${vec.length}）；图片记忆只接受 512d CLIP 图文空间`)
    return { vec, model: String(provider.provider ?? provider.id ?? provider.model ?? 'clip') }
  }

  function saveVector(row, vec, model, source = 'image') {
    const { dim, buf } = toF32(vec)
    q.vecPut.run(row.id, model, dim, buf, source, ctx.now())
  }

  async function embedRow(row, { force = false, source = 'image' } = {}) {
    if (!embedEnabled || row.kind !== 'image') return false
    if (!force && q.vecById.get(row.id)) return true
    const { vec, model } = await embedInput(imageDataUrl(absOf(row), row.ext))
    saveVector(row, vec, model, source)
    return true
  }

  function vectorFor(row) {
    const rec = q.vecById.get(row.id)
    if (!rec) return null
    if (Number(rec.dim) !== embedDim) return null
    return fromF32(rec.vec)
  }

  function filterRows({ library = null, kind = null, tags = null, tag = null, source = null, since = null, until = null, includePrivate = false, allowPrivate = false } = {}) {
    let rows = q.all.all()
    const canSeePrivate = Boolean(includePrivate && allowPrivate)
    if (!canSeePrivate) rows = rows.filter((row) => !Number(row.private))
    if (library) rows = rows.filter((row) => row.library === safeLibrary(library))
    if (kind) rows = rows.filter((row) => row.kind === String(kind))
    if (source) rows = rows.filter((row) => String(row.source ?? '') === String(source))
    if (tag) rows = rows.filter((row) => tagList(row.tags).includes(String(tag).toLowerCase()))
    const wanted = (Array.isArray(tags) ? tags : []).flatMap((item) => tagList(item))
    if (wanted.length) rows = rows.filter((row) => wanted.every((want) => tagList(row.tags).includes(want)))
    if (since) rows = rows.filter((row) => Number(row.imported_at) >= Number(since))
    if (until) rows = rows.filter((row) => Number(row.imported_at) <= Number(until))
    return rows
  }

  async function semanticSearch({ query = '', image = null, rows, limit = 10 }) {
    let input
    let label
    if (image) {
      const file = path.resolve(String(image))
      if (!fs.existsSync(file)) throw new Error(`图片检索需要本地存在的文件：${file}`)
      input = imageDataUrl(file, path.extname(file).toLowerCase())
      label = '图片'
    } else if (query) {
      input = query
      label = '文字'
    } else {
      throw new Error('要搜什么？给 query 文字或 image 本地路径。')
    }
    if (!embedAvailable()) return { ok: false, reason: 'no-provider', label }
    const { vec } = await embedInput(input)
    const scored = []
    for (const row of rows) {
      const other = vectorFor(row)
      if (!other) continue
      scored.push({ row, score: cosine(vec, other) })
    }
    if (!scored.length) return { ok: false, reason: 'no-vectors', label }
    scored.sort((a, b) => b.score - a.score)
    return { ok: true, label, results: scored.slice(0, Math.min(200, Math.max(1, Number(limit) || 10))) }
  }

  /** 导入单个文件；内部做去重/落盘/元数据。 */
  async function importFile({ path: src, library = DEFAULT_LIBRARY, source = 'manual', caption = null, tags = null, origin = null, createdAt = null, pinned = false, private: isPrivate = false } = {}) {
    const file = path.resolve(String(src ?? ''))
    if (!file) throw new Error('缺少 path')
    let st
    try { st = fs.statSync(file) } catch (error) { return { ok: false, error: `读不到这个文件：${String(error?.code ?? error?.message ?? error)}` } }
    if (!st.isFile()) return { ok: false, error: `不是文件：${file}` }
    if (st.size > maxFileBytes) return { ok: false, error: `文件太大（${fmtSize(st.size)} > 上限 ${fmtSize(maxFileBytes)}）` }
    const ext = path.extname(file).toLowerCase()
    const kind = kindOf(ext)
    if (!kind) return { ok: false, error: `不支持的媒体类型（${ext || '无扩展名'}）：支持图片 ${[...IMAGE_EXT].join('/')}、视频 ${[...VIDEO_EXT].join('/')}` }
    const sha = await sha256File(file)
    const existing = q.bySha.get(sha)
    if (existing) {
      // 重复导入：复用同一件；允许补 caption/tags/source/origin。
      q.updateMeta.run(library ?? null, source ?? null, origin ? JSON.stringify(origin) : null, caption ?? null, tags ? JSON.stringify(tagList(tags)) : null, existing.id)
      const row = q.byId.get(existing.id)
      let embedding = false
      let embedError = null
      if (embedEnabled && !embedDefer && row.kind === 'image' && !q.vecById.get(row.id) && embedAvailable()) {
        try { embedding = await embedRow(row) } catch (error) { embedError = String(error?.message ?? error) }
      }
      return { ok: true, deduped: true, row, embedding, embedError }
    }
    const head = readFileHead(file, 64 * 1024)
    const size = kind === 'image' ? readImageSize(head, ext) : null
    const lib = safeLibrary(library)
    // 隐私分区：物理上放 private/<library>/<yyyy-mm>/，普通列表默认看不到。
    const bucket = isPrivate ? path.join('private', lib, dayKey(createdAt ?? Date.now())) : path.join(lib, dayKey(createdAt ?? Date.now()))
    const targetDir = path.join(root, bucket)
    fs.mkdirSync(targetDir, { recursive: true })
    const name = `${sha.slice(0, 16)}${ext}`
    const tmp = path.join(tmpDir, `${sha.slice(0, 16)}-${process.pid}-${Math.random().toString(36).slice(2, 6)}${ext}`)
    fs.copyFileSync(file, tmp)
    const rel = path.join(bucket, name)
    try { fs.renameSync(tmp, path.join(root, rel)) } catch { fs.copyFileSync(tmp, path.join(root, rel)); fs.unlinkSync(tmp) }
    const now = ctx.now()
    const info = q.insert.run(sha, lib, kind, rel, ext, st.size, size?.width ?? null, size?.height ?? null, null,
      String(source ?? 'manual'), origin ? JSON.stringify(origin) : null, caption ? String(caption).slice(0, 500) : null,
      tags ? JSON.stringify(tagList(tags)) : null, pinned ? 1 : 0, createdAt ? Number(createdAt) : null, now, isPrivate ? 1 : 0)
    const row = q.byId.get(Number(info.lastInsertRowid))
    // 二阶段：图片入库时生成 CLIP 512d 向量（可关/可延迟批处理；失败不影响入库）。
    let embedding = false
    let embedError = null
    if (embedEnabled && !embedDefer && row.kind === 'image' && embedAvailable()) {
      try { embedding = await embedRow(row) } catch (error) { embedError = String(error?.message ?? error) }
    }
    return { ok: true, deduped: false, row, embedding, embedError }
  }

  function queryRows({ library = null, kind = null, tag = null, source = null, since = null, until = null, limit = 20, includePrivate = false, allowPrivate = false, includeDeleted = false } = {}) {
    let rows = includeDeleted ? q.all.all() : q.all.all()
    // 隐私项默认完全不出现在列表/搜索/拼图里；显式 includePrivate 才可见（且标记）。
    if (!includePrivate) rows = rows.filter((row) => !Number(row.private))
    if (library) rows = rows.filter((row) => row.library === safeLibrary(library))
    if (kind) rows = rows.filter((row) => row.kind === String(kind))
    if (source) rows = rows.filter((row) => String(row.source ?? '') === String(source))
    if (tag) rows = rows.filter((row) => tagList(row.tags).includes(String(tag).toLowerCase()))
    if (since) rows = rows.filter((row) => Number(row.imported_at) >= Number(since))
    if (until) rows = rows.filter((row) => Number(row.imported_at) <= Number(until))
    return rows.slice(0, Math.min(200, Math.max(1, Number(limit) || 20)))
  }

  /** 体积上限：删最旧、未置顶的，删前允许 dryRun。 */
  function pruneNow({ dryRun = true, limitBytes = warnBytes, days = retentionDays, allowPrivate = false } = {}) {
    const now = ctx.now()
    const cutoff = days > 0 ? now - days * 86_400_000 : 0
    const rows = q.all.all()
    let total = rows.reduce((n, row) => n + Number(row.bytes || 0), 0)
    const victims = []
    // 先按保留天数（未置顶）标老件，再按体积上限从最旧开始标。
    for (const row of [...rows].reverse()) {
      if (row.pinned) continue
      if (Number(row.private) && !allowPrivate) continue
      const old = days > 0 && Number(row.imported_at) < cutoff
      const over = total > limitBytes
      if (!old && !over) continue
      victims.push({ row, reason: old ? 'expired' : 'size' })
      total -= Number(row.bytes || 0)
    }
    const freed = victims.reduce((n, v) => n + Number(v.row.bytes || 0), 0)
    if (!dryRun) {
      for (const { row } of victims) {
        try { fs.unlinkSync(absOf(row)) } catch { /* 文件可能已不在 */ }
        q.touchDeleted.run(now, row.id)
      }
    }
    return { dryRun, victims: victims.map((v) => ({ id: v.row.id, path: displayPath(v.row), bytes: v.row.bytes, reason: v.reason, private: Boolean(Number(v.row.private)) })), freed, limitBytes, days }
  }

  async function collage({ ids = null, library = null, tag = null, source = null, since = null, until = null, cols = 4, cell = 320, label = true, includePrivate = false, allowPrivate = false } = {}) {
    let picked = []
    if (Array.isArray(ids) && ids.length) {
      for (const raw of ids.slice(0, collageMax)) {
        const row = q.byId.get(Number(raw))
        if (!row || row.kind !== 'image') continue
        if (Number(row.private) && !(includePrivate && allowPrivate)) continue
        picked.push(row)
      }
    } else {
      picked = queryRows({ library, kind: 'image', tag, source, since, until, limit: collageMax, includePrivate: includePrivate && allowPrivate, allowPrivate })
    }
    picked = picked.slice(0, collageMax)
    if (!picked.length) {
      return { text: ids ? '这些 id 里没有可用的图片（可能不是图、或已删除）。用 album_list 看看有哪些。' : '相册里没有可拼的图片：先 album_import 导入，或用 album_list 确认筛选条件。' }
    }
    const plan = planGrid(picked.length, cols, cell)
    const outTmp = path.join(tmpDir, `grid-${Date.now()}-${process.pid}.png`)
    const outFinal = path.join(collagesDir, `grid-${new Date(ctx.now()).toISOString().replace(/[:.]/g, '-')}.png`)
    const planFile = path.join(tmpDir, `grid-${Date.now()}-${process.pid}.json`)
    const cells = picked.map((row, i) => {
      const target = { path: absOf(row), col: i % plan.cols, row: Math.floor(i / plan.cols), label: label ? `#${row.id}` : '' }
      return target
    })
    fs.writeFileSync(planFile, JSON.stringify({ ...plan, out: outTmp, cells }), 'utf8')
    try {
      const { stdout } = await execFileAsync(python, ['-c', PY_COLLAGE, planFile], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
      const data = JSON.parse(String(stdout).trim().split('\n').pop())
      if (!data.ok) return { text: `拼图失败：${data.error ?? '未知原因'}。` }
      fs.renameSync(outTmp, outFinal)
      const list = picked.map((row, i) => `#${row.id}`).join(' ')
      return {
        text: `拼好了：${picked.length} 张 → ${data.width}x${data.height}（${plan.cols} 列）。第 1..N 格依次是 ${list}。\n文件：${outFinal}\n（图片没有直接发给你；要看画面等 DSH attachment 通道，或把路径发给用户。）`,
        imagePath: outFinal,
      }
    } catch (error) {
      try { fs.unlinkSync(outTmp) } catch { /* ignore */ }
      const err = String(error?.stderr ?? error?.message ?? error)
      return { text: `拼图失败：${err.slice(0, 300)}\n检查：python/Pillow 是否可用（ALBUM_PYTHON 指向带 Pillow 的 python），图片是否损坏。` }
    } finally {
      try { fs.unlinkSync(planFile) } catch { /* ignore */ }
    }
  }

  ctx.tools.register({
    name: 'album_import',
    summary: 'Import local image/video files into your album (content-hash dedupe, metadata stored).',
    when: ['a picture or clip is worth keeping', 'you downloaded media from bili/QQ and want it in your own album'],
    avoid: ['files you have not actually received from a tool or the user'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['paths'],
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Local file paths (1-32).' },
        library: { type: 'string', description: 'Album library name (default "default").' },
        source: { type: 'string', description: 'Where it came from: bili / qq / manual / ...' },
        caption: { type: 'string', description: 'One-line description (searchable).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Short tags.' },
        private: { type: 'boolean', description: 'Put it in the private album (never listed/shown/sent unless explicitly allowed).' },
      },
    },
    async execute({ paths = [], library = DEFAULT_LIBRARY, source = 'manual', caption = null, tags = null, private: isPrivate = false } = {}) {
      const list = (Array.isArray(paths) ? paths : []).map(String).filter(Boolean).slice(0, maxImportPerCall)
      if (!list.length) return { text: '给我至少一个本地文件路径。' }
      const lines = []
      for (const file of list) {
        const out = await importFile({ path: file, library, source, caption, tags, private: Boolean(isPrivate) })
        const vectorNote = out.ok && out.embedding ? '（向量✓）' : (out.ok && out.embedError ? `（向量未建：${out.embedError.slice(0, 80)}）` : '')
        lines.push(out.ok
          ? `#${out.row.id} ${out.deduped ? '已在相册里（去重命中）' : '入库'} — ${metaLine(out.row)}${vectorNote}`
          : `失败（${file}）：${out.error}`)
      }
      return { text: lines.join('\n') }
    },
  })

  ctx.tools.register({
    name: 'album_list',
    summary: 'List items in your album by library / kind / tag / source / time.',
    when: ['you want to see what pictures or clips you have'],
    avoid: ['finding by description - use album_search'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        library: { type: 'string' },
        kind: { type: 'string', enum: ['image', 'video'] },
        tag: { type: 'string' },
        source: { type: 'string' },
        since: { type: 'number', description: 'Epoch ms lower bound (imported_at).' },
        until: { type: 'number' },
        limit: { type: 'number', description: 'Default 20, max 200.' },
        includePrivate: { type: 'boolean', description: 'Also list the private album (default false; needs allowPrivate:true).' },
        allowPrivate: { type: 'boolean', description: 'Explicitly allow touching the private album.' },
      },
    },
    execute({ library = null, kind = null, tag = null, source = null, since = null, until = null, limit = 20, includePrivate = false, allowPrivate = false } = {}) {
      // 隐私统一双确认：includePrivate + allowPrivate 同时为 true 才可见（与 search/show 一致）
      const canSeePrivate = Boolean(includePrivate && allowPrivate)
      const rows = queryRows({ library, kind, tag, source, since, until, limit, includePrivate: canSeePrivate })
      if (!rows.length) {
        const { n } = q.total.get()
        return { text: n === 0 ? '相册还是空的：还没有导入任何图片/视频。' : `没有符合这个条件的（相册共 ${n} 件；换个筛选条件试试）。` }
      }
      return { text: `相册（${rows.length} 件）：\n${rows.map(metaLine).join('\n')}` }
    },
  })

  ctx.tools.register({
    name: 'album_search',
    summary: 'Semantic/search your album by text or a local image (CLIP 512d), with tag/time/private filters.',
    when: ['someone mentions a picture/clip and you need to find it', 'you remember the content but not the file name'],
    avoid: ['exact ids - use album_show'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Text description (Chinese works: CLIP zh text space).' },
        image: { type: 'string', description: 'Local image path for image-to-image search (alternative to query).' },
        library: { type: 'string' },
        kind: { type: 'string', enum: ['image', 'video'] },
        tag: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' }, description: 'All of these tags.' },
        source: { type: 'string' },
        since: { type: 'number' },
        until: { type: 'number' },
        limit: { type: 'number', description: 'TopK, default 10, max 50.' },
        semantic: { type: 'boolean', description: 'Try CLIP semantic search first (default true; false = text/tags only).' },
        includePrivate: { type: 'boolean', description: 'Search the private album too (needs allowPrivate:true).' },
        allowPrivate: { type: 'boolean', description: 'Explicitly allow touching the private album.' },
      },
    },
    async execute({ query = '', image = null, library = null, kind = null, tag = null, tags = null, source = null, since = null, until = null, limit = 10, semantic = true, includePrivate = false, allowPrivate = false } = {}) {
      const needle = String(query ?? '').trim()
      const { n } = q.total.get()
      if (!needle && !image) return { text: n === 0 ? '相册还是空的。' : `要搜什么？给 query 文字或 image 本地路径（相册共 ${n} 件）。` }
      const rows = filterRows({ library, kind, tag, tags, source, since, until, includePrivate, allowPrivate })
      const topK = Math.min(50, Math.max(1, Number(limit) || 10))
      let semanticOut = null
      let semanticError = null
      if (semantic !== false) {
        try { semanticOut = await semanticSearch({ query: needle, image, rows, limit: topK }) } catch (error) { semanticError = String(error?.message ?? error) }
      }
      if (semanticOut?.ok && semanticOut.results.length) {
        const lines = semanticOut.results.map(({ row, score }) => `${metaLine(row)}（相似度 ${score.toFixed(3)}）`)
        return { text: `语义检索（${semanticOut.label}，top ${semanticOut.results.length}）：\n${lines.join('\n')}` }
      }
      const reason = semanticError
        ? `语义检索暂不可用：${semanticError.slice(0, 160)}；`
        : semanticOut?.reason === 'no-provider' ? '语义检索未接入（没有 clip-zh 图文嵌入，512d）；'
          : semanticOut?.reason === 'no-vectors' ? '还没有图片向量（先 album_reindex）；'
            : ''
      if (!needle) return { text: `${reason}图片检索需要嵌入服务或已有向量；可以先 album_reindex，或改用 query 文字。` }
      const lexical = rows.filter((row) => describe(needle, row)).slice(0, topK)
      if (!lexical.length) return { text: `${reason}相册里没有匹配的（共 ${n} 件，关键词「${needle.slice(0, 40)}」）。换个说法、去掉标签/来源限制，或者先 album_list 看看？` }
      return { text: `${reason}按文字/标签找到 ${lexical.length} 件：\n${lexical.map(metaLine).join('\n')}` }
    },
  })

  ctx.tools.register({
    name: 'album_collage',
    summary: 'Join N album images into one storyboard-style grid PNG.',
    when: ['several pictures belong together and you want one view'],
    avoid: ['more than 24 images - split into two calls'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ids: { type: 'array', items: { type: 'number' }, description: 'Explicit image ids (max 24).' },
        library: { type: 'string' },
        tag: { type: 'string' },
        source: { type: 'string' },
        since: { type: 'number' },
        until: { type: 'number' },
        cols: { type: 'number', description: 'Default 4, 1-8.' },
        cell: { type: 'number', description: 'Pixel size per cell (default 320, 128-1024).' },
        label: { type: 'boolean', description: 'Burn #id in each cell (default true).' },
        includePrivate: { type: 'boolean', description: 'Include private-album images (needs allowPrivate:true).' },
        allowPrivate: { type: 'boolean', description: 'Explicitly allow touching the private album.' },
      },
    },
    execute(args = {}) { return collage(args) },
  })

  ctx.tools.register({
    name: 'album_show',
    summary: 'Show one album item in detail (path, size, tags, source, sent state).',
    when: ['you need the local path of one picture/clip'],
    avoid: ['browsing - use album_list'],
    parameters: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'number' }, includePrivate: { type: 'boolean', description: 'Include the private album (needs allowPrivate:true).' }, allowPrivate: { type: 'boolean', description: 'Explicitly allow showing a private-album item.' } } },
    execute({ id, includePrivate = false, allowPrivate = false } = {}) {
      const row = q.byId.get(Number(id))
      if (!row) return { text: `相册里没有 #${id}（可能已删除）。` }
      if (Number(row.private) && !(includePrivate && allowPrivate)) {
        return { text: `#${id} 在隐私相册里：不能直接展示/发送。确认只有你自己看（或用户明确允许）后，用 album_show {id, includePrivate:true, allowPrivate:true}。` }
      }
      return { text: metaLine(row), imagePath: row.kind === 'image' ? absOf(row) : undefined }
    },
  })

  ctx.tools.register({
    name: 'album_prune',
    summary: 'Apply the album retention policy (default dry-run): report or delete old/unpinned items.',
    when: ['the album is getting big and you want to clean up', 'checking what a cleanup would remove'],
    avoid: ['deleting pinned items - pinned are never pruned'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dryRun: { type: 'boolean', description: 'Default true; false only when you really want to delete.' },
        allowPrivate: { type: 'boolean', description: 'Also allow pruning private-album items (default false).' },
      },
    },
    execute({ dryRun = true, allowPrivate = false } = {}) {
      const out = pruneNow({ dryRun: Boolean(dryRun), allowPrivate: Boolean(allowPrivate) })
      const head = out.dryRun ? `清理预览（没动手）：将删 ${out.victims.length} 件、释放 ${fmtSize(out.freed)}` : `已清理 ${out.victims.length} 件、释放 ${fmtSize(out.freed)}`
      const lines = out.victims.slice(0, 20).map((v) => `#${v.id} ${v.reason === 'expired' ? '超过保留天数' : '超出体积上限'} ${fmtSize(v.bytes)}${v.private ? '（隐私）' : ''} — ${v.path}`)
      return { text: [head, ...lines, out.victims.length > 20 ? `…还有 ${out.victims.length - 20} 件` : ''].filter(Boolean).join('\n') }
    },
  })

  ctx.tools.register({
    name: 'album_status',
    summary: 'Album health: item count, total size, libraries, sources, limits.',
    when: ['you want to know how big your album is'],
    avoid: [],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    execute() {
      const { n, b } = q.total.get()
      const warn = Number(b) > warnBytes ? `\n⚠ 已超过告警阈值（${fmtSize(warnBytes)}）：只提示，不会自动删；要清用 album_prune（默认 dryRun 预览）。` : ''
      const rows = q.all.all()
      const libs = [...new Set(rows.map((row) => row.library))]
      const sources = [...new Set(rows.map((row) => row.source).filter(Boolean))]
      const images = rows.filter((row) => row.kind === 'image').length
      const pinned = rows.filter((row) => row.pinned).length
      const vec = q.vecCount.get().n
      const dims = q.vecDimCount.all().map((row) => `${row.dim}d×${row.n}`).join(', ')
      const embedLine = embedEnabled
        ? (embedAvailable() ? `向量：${vec}/${images} 张图片（${dims || `${embedDim}d`}，clip-zh CPU，可关/延迟）` : `向量：未接入（需要 clip-zh 512d 嵌入服务；当前 ${vec}/${images} 张有向量）`)
        : '向量：已关闭（embedEnabled:false）'
      return {
        text: `相册：${n} 件（图片 ${images} / 视频 ${n - images}，置顶 ${pinned}），共 ${fmtSize(b)}；`
          + `告警阈值 ${fmtSize(warnBytes)}（只提示，不自动删；保留策略 ${retentionDays === 0 ? '关闭（全部保留，手清）' : `${retentionDays} 天`}）；库：${libs.join(', ') || '（空）'}；来源：${sources.join(', ') || '（空）'}；`
          + `${embedLine}；位置：${root}${warn}`,
      }
    },
  })

  ctx.tools.register({
    name: 'album_reindex',
    summary: 'Build/refresh image embeddings (CLIP 512d, CPU) for album images. Safe to rerun.',
    when: ['semantic image search says there are no vectors', 'you imported images with embedDefer or before the embedding provider was configured'],
    avoid: ['videos - only images get CLIP vectors'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ids: { type: 'array', items: { type: 'number' }, description: 'Only these item ids (default: all images).' },
        limit: { type: 'number', description: 'Batch size, default 8, max 32.' },
        force: { type: 'boolean', description: 'Re-embed even if a vector already exists.' },
        includePrivate: { type: 'boolean', description: 'Include private-album images (needs allowPrivate:true).' },
        allowPrivate: { type: 'boolean', description: 'Explicitly allow touching the private album.' },
      },
    },
    async execute({ ids = null, limit = embedBatchMax, force = false, includePrivate = false, allowPrivate = false } = {}) {
      if (!embedEnabled) return { text: '图片向量已关闭（embedEnabled:false）；需要时先打开配置。' }
      if (!embedAvailable()) return { text: '没有接入图文嵌入服务（8088 clip-zh，512d）；先配置 clip-zh provider，再 album_reindex。' }
      const wantIds = Array.isArray(ids) ? ids.map(Number).filter(Number.isFinite) : null
      let rows = wantIds
        ? wantIds.map((id) => q.byId.get(id)).filter(Boolean).filter((row) => row.kind === 'image')
        : filterRows({ kind: 'image', includePrivate, allowPrivate })
      rows = rows.slice(0, Math.min(32, Math.max(1, Number(limit) || embedBatchMax)))
      let built = 0
      const failures = []
      for (const row of rows) {
        if (Number(row.private) && !(includePrivate && allowPrivate)) continue
        try { await embedRow(row, { force: Boolean(force) }); built += 1 } catch (error) { failures.push(`#${row.id}:${String(error?.message ?? error).slice(0, 100)}`) }
      }
      const images = q.all.all().filter((row) => row.kind === 'image').length
      const vec = q.vecCount.get().n
      const lines = [`已建/刷新 ${built} 条（失败 ${failures.length}）；向量覆盖 ${vec}/${images} 张图片。`]
      if (failures.length) lines.push(...failures.slice(0, 8))
      return { text: lines.join('\n') }
    },
  })

  if (ctx.config?.captionEnabled !== false) {
  ctx.tools.register({
    name: 'album_caption',
    summary: 'Manually caption album images with the local vision model (one Chinese sentence); no auto-run.',
    when: ['you want a picture to be findable by description', 'the user asks what a picture looks like'],
    avoid: ['batch-captioning everything - it uses the local GPU serially'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ids: { type: 'array', items: { type: 'number' }, description: 'Specific image ids (default: images without caption).' },
        limit: { type: 'number', description: `Max images this call, default ${captionMax}, max 8.` },
        force: { type: 'boolean', description: 'Recaption even if a caption exists.' },
        includePrivate: { type: 'boolean' },
        allowPrivate: { type: 'boolean' },
      },
    },
    async execute({ ids = null, limit = captionMax, force = false, includePrivate = false, allowPrivate = false } = {}) {
      const vision = ctx.services.vision
      if (!vision?.describe) return { text: '没有可用的视觉模型服务；先用 caption/tags 手动写描述。' }
      const wantIds = Array.isArray(ids) ? ids.map(Number).filter(Number.isFinite) : null
      let rows = wantIds
        ? wantIds.map((id) => q.byId.get(id)).filter(Boolean).filter((row) => row.kind === 'image')
        : filterRows({ kind: 'image', includePrivate, allowPrivate })
      rows = rows.slice(0, Math.min(8, Math.max(1, Number(limit) || captionMax)))
      const lines = []
      for (const row of rows) {
        if (Number(row.private) && !(includePrivate && allowPrivate)) continue
        if (!force && row.caption) { lines.push(`#${row.id} 已有描述，跳过（force:true 可重写）`); continue }
        try {
          const caption = await vision.describe({ path: absOf(row), config: captionConfig, prompt: captionPrompt, maxTokens: 160, timeoutMs: Number(ctx.config.captionTimeoutMs ?? 120_000) })
          if (!caption) { lines.push(`#${row.id} 视觉模型没返回描述`); continue }
          q.setCaption.run(String(caption).slice(0, 500), row.id)
          lines.push(`#${row.id} 描述：${String(caption).slice(0, 200)}`)
        } catch (error) {
          lines.push(`#${row.id} 失败：${String(error?.message ?? error).slice(0, 140)}`)
        }
      }
      return { text: lines.length ? lines.join('\n') : '没有可处理的图片。' }
    },
  })
  }

  // 给 bili/qq/dream 用的进程内接口（不新增工具、不进提示词）。
  ctx.services.provide('album', {
    root,
    importFile,
    list: (opts = {}) => queryRows({ ...opts, includePrivate: Boolean(opts.includePrivate && opts.allowPrivate) }).map((row) => ({ id: row.id, path: displayPath(row), kind: row.kind, bytes: row.bytes, caption: row.caption, tags: tagList(row.tags), importedAt: row.imported_at })),
    search: (query, opts = {}) => q.all.all().filter((row) => (Boolean(opts.includePrivate && opts.allowPrivate) || !Number(row.private)) && describe(query, row)).slice(0, Math.min(50, Number(opts.limit) || 10)).map((row) => ({ id: row.id, path: displayPath(row), kind: row.kind, caption: row.caption })),
    semanticSearch: async (query, opts = {}) => {
      const rows = filterRows({ includePrivate: Boolean(opts.includePrivate), allowPrivate: Boolean(opts.allowPrivate) })
      const out = await semanticSearch({ query, image: opts.image ?? null, rows, limit: Number(opts.limit) || 10 })
      return out.ok ? out.results.map(({ row, score }) => ({ id: row.id, path: displayPath(row), caption: row.caption, score })) : { ok: false, reason: out.reason }
    },
    reindex: (opts = {}) => ({ images: q.all.all().filter((row) => row.kind === 'image').length, vectors: q.vecCount.get().n, dims: q.vecDimCount.all() }),
    vectors: () => ({ enabled: embedEnabled, available: embedAvailable(), count: q.vecCount.get().n, dims: q.vecDimCount.all() }),
    prune: (opts = {}) => pruneNow(opts),
    status: () => ({ count: Number(q.total.get().n), bytes: Number(q.total.get().b), root, dbFile }),
  })

  ctx.log({ msg: 'album.ready', root, python })
}
