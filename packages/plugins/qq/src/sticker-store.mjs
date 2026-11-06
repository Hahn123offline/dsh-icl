// 本地表情知识库（索引层）：只给 stickerDir 里的**本地文件**加 tags/描述/来源/使用次数；
// 不下载、不复制第三方图片、不上传任何东西。图像文件本身仍由用户放进 stickerDir。
//
// library.json 形状：{version:1, entries: { "<文件名>": {tags:[], description, source, useCount, lastUsedAt, createdAt, updatedAt} }}
// 读损坏/不存在：不存在→空库；损坏→空库 + error（调用方只读不写，避免一次坏文件把索引清空）。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const STICKER_DEFAULTS = Object.freeze({
  maxTags: 10,
  tagChars: 24,
  descriptionChars: 200,
  sources: ['manual', 'inbound', 'ai', 'unknown'],
})

function truncate(value, max) {
  const s = String(value ?? '')
  if (s.length <= max) return s
  let cut = max
  const code = s.charCodeAt(cut - 1)
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1
  return s.slice(0, Math.max(0, cut))
}

export function sanitizeStickerText(value, max = 200) {
  const limit = Math.max(1, Math.floor(Number(max) || 200))
  const cleaned = String(value ?? '')
    .replace(/[\s\u00a0\u3000]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, '')
    .trim()
  return truncate(cleaned, limit)
}

export function normalizeStickerNote(patch = {}) {
  const tags = Array.isArray(patch.tags)
    ? [...new Set(patch.tags.map((tag) => sanitizeStickerText(tag, STICKER_DEFAULTS.tagChars)).filter(Boolean))].slice(0, STICKER_DEFAULTS.maxTags)
    : []
  const rawSource = String(patch.source ?? '').trim()
  const source = STICKER_DEFAULTS.sources.includes(rawSource) ? rawSource : 'manual'
  return {
    tags,
    description: sanitizeStickerText(patch.description, STICKER_DEFAULTS.descriptionChars),
    source,
  }
}

export function loadStickerLibrary(file) {
  if (!file) return { version: 1, entries: {}, error: 'stickerLibraryFile 为空' }
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, entries: {} }
    return { version: 1, entries: {}, error: `表情库读取失败：${error?.message ?? error}` }
  }
  try {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    const data = JSON.parse(text)
    const entries = data && typeof data === 'object' && data.entries && typeof data.entries === 'object' ? data.entries : {}
    const cleaned = {}
    for (const [id, entry] of Object.entries(entries)) {
      if (!entry || typeof entry !== 'object') continue
      const note = normalizeStickerNote(entry)
      cleaned[String(id)] = {
        ...note,
        useCount: Math.max(0, Number(entry.useCount) || 0),
        lastUsedAt: Number(entry.lastUsedAt) || 0,
        createdAt: Number(entry.createdAt) || 0,
        updatedAt: Number(entry.updatedAt) || 0,
      }
    }
    return { version: 1, entries: cleaned }
  } catch (error) {
    return { version: 1, entries: {}, error: `表情库内容损坏（已拒绝按空库写回）：${error?.message ?? error}` }
  }
}

export function saveStickerLibrary(file, library) {
  const dir = path.dirname(String(file))
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: library?.entries ?? {} }, null, 1), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
    throw error
  }
}

/** 合并"磁盘上的文件"与"本地知识库"；source 默认 manual（本地文件）。 */
export function mergeStickerEntries(files = [], library = { entries: {} } = {}) {
  const entries = library?.entries ?? {}
  return (Array.isArray(files) ? files : []).map((file) => {
    const note = entries[file.id] ?? {}
    const source = note.source || 'manual'
    return {
      id: file.id,
      bytes: Number(file.bytes) || 0,
      tags: Array.isArray(note.tags) ? note.tags : [],
      description: note.description || '',
      source,
      useCount: Number(note.useCount) || 0,
      lastUsedAt: Number(note.lastUsedAt) || 0,
      updatedAt: Number(note.updatedAt) || 0,
      indexed: Boolean(entries[file.id]),
    }
  })
}

/** query 匹配 id/tags/description；sort: name | recent（最近使用/更新）| used（使用次数）。 */
export function queryStickerEntries(entries = [], { query = '', sort = 'name' } = {}) {
  const q = String(query ?? '').trim().toLowerCase()
  const list = (Array.isArray(entries) ? entries : []).filter((entry) => {
    if (!q) return true
    return [entry.id, entry.description, ...(entry.tags ?? [])].join(' ').toLowerCase().includes(q)
  })
  const mode = ['name', 'recent', 'used'].includes(String(sort)) ? String(sort) : 'name'
  return list.sort((a, b) => {
    if (mode === 'used') return (b.useCount - a.useCount) || a.id.localeCompare(b.id)
    if (mode === 'recent') return (Math.max(b.lastUsedAt, b.updatedAt) - Math.max(a.lastUsedAt, a.updatedAt)) || a.id.localeCompare(b.id)
    return a.id.localeCompare(b.id)
  })
}

export function noteSticker(library, id, patch = {}, { now = Date.now() } = {}) {
  const key = String(id ?? '').trim()
  if (!key) throw new Error('表情 id 不能为空')
  const entries = { ...(library?.entries ?? {}) }
  const previous = entries[key] ?? {}
  // 只更新显式传入的字段，避免"只改描述"把已有标签清空。
  const merged = {
    tags: patch.tags !== undefined ? patch.tags : previous.tags,
    description: patch.description !== undefined ? patch.description : previous.description,
    source: patch.source !== undefined ? patch.source : (previous.source || 'manual'),
  }
  const note = normalizeStickerNote(merged)
  entries[key] = {
    ...note,
    useCount: Math.max(0, Number(previous.useCount) || 0),
    lastUsedAt: Number(previous.lastUsedAt) || 0,
    createdAt: Number(previous.createdAt) || now,
    updatedAt: now,
  }
  return { version: 1, entries }
}

export function recordStickerUse(library, id, { at = Date.now(), context = '' } = {}) {
  const key = String(id ?? '').trim()
  if (!key) return library
  const entries = { ...(library?.entries ?? {}) }
  const previous = entries[key] ?? {}
  entries[key] = {
    tags: Array.isArray(previous.tags) ? previous.tags : [],
    description: previous.description || '',
    source: previous.source || 'manual',
    useCount: Math.max(0, Number(previous.useCount) || 0) + 1,
    lastUsedAt: at,
    createdAt: Number(previous.createdAt) || at,
    updatedAt: at,
  }
  if (context) entries[key].lastContext = sanitizeStickerText(context, 120)
  return { version: 1, entries }
}
