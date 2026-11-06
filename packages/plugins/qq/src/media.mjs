// 图片/文件的安全抓取层：只做"取字节 + 限大小 + 验类型"，不决定给不给模型看
// （图片真正进模型要 DSH attachment/bridge 改动，P0-2 之后单独申请）。
//
// 安全边界（对应 docs/QQ-GAP.md R3）：
//   · 只允许 http/https；拒绝 localhost/私有 IP 字面量/带账号密码的 URL；
//   · 必须有 Content-Length 或流式累计上限（默认 8MB），超限立刻中止；
//   · 类型必须由字节头嗅探为 png/jpeg/gif/webp，不信任 Content-Type；
//   · QQ 网关的 file 引用只接受安全文件名（单层、无路径、无 ..），防任意路径/内网注入。
import fs from 'node:fs'
import path from 'node:path'
import { RICH_LIMITS, formatBytes, sanitizeFileName } from './rich.mjs'

export const MEDIA_DEFAULTS = Object.freeze({
  maxImageBytes: 8 * 1024 * 1024,
  maxImages: RICH_LIMITS.maxImages,
  timeoutMs: 15_000,
  // 用户日常没接触 >200MB 的 QQ 传输；单文件/视频保守放到 512MiB，超限拒绝并给原因。
  maxFileBytes: 512 * 1024 * 1024,
  maxVideoBytes: 512 * 1024 * 1024,
  maxVideos: 1,
  maxFiles: 2,
  // 0 = 不自动删除（用户拍板：全部保留、手清；prune 由手动/容量告警决定）。
  retentionDays: 0,
  // 总量只软告警（不拒绝、不删除）；超了日志/状态提示，由人决定清理。
  softLimitBytes: 2 * 1024 * 1024 * 1024,
})

const IMAGE_TYPES = Object.freeze({ 'image/png': true, 'image/jpeg': true, 'image/gif': true, 'image/webp': true })
const VIDEO_TYPES = Object.freeze({ 'video/mp4': true, 'video/webm': true })

export function sniffImageMime(buffer) {
  const b = buffer instanceof Uint8Array ? buffer : null
  if (!b || b.length < 12) return null
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif'
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  return null
}

/** 校验后的图片字节；不是图片/超限都抛错（调用方降级为占位文字）。 */
export function acceptImageBuffer(buffer, { maxBytes = MEDIA_DEFAULTS.maxImageBytes, label = '图片' } = {}) {
  const b = buffer instanceof Uint8Array ? buffer : null
  if (!b || !b.length) throw new Error(`${label}为空`)
  if (b.length > maxBytes) throw new Error(`${label}超限：${formatBytes(b.length)} > ${formatBytes(maxBytes)}`)
  const mimeType = sniffImageMime(b)
  if (!mimeType || !IMAGE_TYPES[mimeType]) throw new Error(`${label}不是支持的图片类型`)
  return { buffer: b, mimeType, bytes: b.length }
}

const PRIVATE_HOST_RE = /^(localhost|localhost\.local|.*\.local|0\.0\.0\.0|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2}|\[::1\]|\[?::1\]?|\[?fc00:[^\]]+\]?|\[?fe80:[^\]]+\]?)$/i

/** 只允许 http(s) 且不是本机/私网/带凭据的 URL；抛错。 */
export function assertSafeHttpUrl(rawUrl) {
  let url
  try { url = new URL(String(rawUrl)) } catch { throw new Error('URL 不合法') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`不允许的协议：${url.protocol}`)
  if (url.username || url.password) throw new Error('URL 不允许带账号密码')
  const host = url.hostname.toLowerCase()
  if (!host) throw new Error('URL 没有主机名')
  if (PRIVATE_HOST_RE.test(host)) throw new Error(`拒绝内网/本机地址：${host}`)
  return url
}

/** 从 URL 或 file 引用里给出的候选（去重、只留 http(s)）。 */
export function candidateImageUrls(media) {
  const out = []
  for (const raw of [media?.url, media?.file].map((v) => String(v ?? '').trim())) {
    if (/^https?:\/\//i.test(raw) && !out.includes(raw)) out.push(raw)
  }
  return out
}

/**
 * 安全抓取一个 URL 的字节（默认 8MB 上限）。
 * fetchImpl 可注入（测试用）；默认 globalThis.fetch。
 */
export async function safeFetchBuffer(rawUrl, {
  fetchImpl = globalThis.fetch,
  maxBytes = MEDIA_DEFAULTS.maxImageBytes,
  timeoutMs = MEDIA_DEFAULTS.timeoutMs,
  label = '媒体',
} = {}) {
  const url = assertSafeHttpUrl(rawUrl)
  if (typeof fetchImpl !== 'function') throw new Error('当前环境没有 fetch')
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || MEDIA_DEFAULTS.timeoutMs)) : null
  try {
    const res = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: { accept: 'image/*' },
      ...(controller ? { signal: controller.signal } : {}),
      redirect: 'follow',
    })
    if (!res || !res.ok) throw new Error(`HTTP ${res?.status ?? '失败'}`)
    const declared = Number(res.headers?.get?.('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`${label}超限：${formatBytes(declared)} > ${formatBytes(maxBytes)}`)
    const buffer = new Uint8Array(await res.arrayBuffer())
    if (buffer.length > maxBytes) throw new Error(`${label}超限：${formatBytes(buffer.length)} > ${formatBytes(maxBytes)}`)
    return { buffer, bytes: buffer.length, url: url.toString() }
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`${label}抓取超时`)
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** OneBot 的 file 引用是否安全（只允许单层缓存文件名；防任意路径）。 */
export function isSafeMediaFileRef(file) {
  const s = String(file ?? '').trim()
  if (!s || s.length > 180) return false
  if (s.startsWith('base64://')) return true
  return /^[A-Za-z0-9._-]+$/.test(s) && !s.includes('..')
}

/**
 * 取一张图片：先试 http(s) URL（安全抓取），再试网关 get_image（file）。
 * 成功返回 { buffer, mimeType, bytes, source }；全失败返回 { error, attempts }。
 */
export async function fetchImageMedia(media, {
  fetchImpl = globalThis.fetch,
  getImage = null,
  maxBytes = MEDIA_DEFAULTS.maxImageBytes,
  timeoutMs = MEDIA_DEFAULTS.timeoutMs,
} = {}) {
  const attempts = []
  for (const url of candidateImageUrls(media)) {
    try {
      const fetched = await safeFetchBuffer(url, { fetchImpl, maxBytes, timeoutMs, label: '图片' })
      const accepted = acceptImageBuffer(fetched.buffer, { maxBytes })
      return { ...accepted, source: 'url', url }
    } catch (error) {
      attempts.push(`url: ${String(error?.message ?? error)}`)
    }
  }
  if (getImage && isSafeMediaFileRef(media?.file)) {
    try {
      const info = await getImage(String(media.file))
      const obj = info && typeof info === 'object' ? info : {}
      const base64 = String(obj.base64 ?? obj.data ?? '')
      if (base64) {
        const buffer = new Uint8Array(Buffer.from(base64, 'base64'))
        const accepted = acceptImageBuffer(buffer, { maxBytes })
        return { ...accepted, source: 'get_image' }
      }
      if (obj.url) {
        const fetched = await safeFetchBuffer(String(obj.url), { fetchImpl, maxBytes, timeoutMs, label: '图片' })
        const accepted = acceptImageBuffer(fetched.buffer, { maxBytes })
        return { ...accepted, source: 'get_image-url', url: String(obj.url) }
      }
      attempts.push('get_image: 没有 base64/url')
    } catch (error) {
      attempts.push(`get_image: ${String(error?.message ?? error)}`)
    }
  }
  return { error: attempts.slice(0, 3).join(' | ') || '没有可用的图片地址', attempts }
}

/** 文件附件的展示名（不含路径）；不负责下载。 */
export function describeFile(fileInfo) {
  const name = sanitizeFileName(fileInfo?.name ?? '')
  const size = formatBytes(fileInfo?.size)
  return `[文件${name ? `：${name}` : ''}${size ? `（${size}）` : ''}]`
}

/** 视频魔数嗅探（不信任 Content-Type）；只接受 mp4/webm。 */
export function sniffVideoMime(buffer) {
  const b = buffer instanceof Uint8Array ? buffer : null
  if (!b || b.length < 12) return null
  // ISO BMFF(MP4/MOV)：第 4-7 字节是 'ftyp'
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'video/mp4'
  // EBML（WebM/MKV）
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm'
  return null
}

export function acceptVideoBuffer(buffer, { maxBytes = MEDIA_DEFAULTS.maxVideoBytes, label = '视频' } = {}) {
  const b = buffer instanceof Uint8Array ? buffer : null
  if (!b || !b.length) throw new Error(`${label}为空`)
  if (b.length > maxBytes) throw new Error(`${label}超限：${formatBytes(b.length)} > ${formatBytes(maxBytes)}`)
  const mimeType = sniffVideoMime(b)
  if (!mimeType || !VIDEO_TYPES[mimeType]) throw new Error(`${label}不是支持的视频类型`)
  return { buffer: b, mimeType, bytes: b.length }
}

export function extensionForMime(mimeType) {
  const map = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
    'video/mp4': 'mp4', 'video/webm': 'webm',
  }
  return map[String(mimeType ?? '')] || 'bin'
}

/** 生成本地媒体文件名：日期目录 + messageId/发送者/时间/序号；不信任对方文件名。 */
export function inboxMediaPath({ dir, at = Date.now(), messageId = null, sender = '', index = 1, mimeType = '', originalName = '' }) {
  const d = new Date(Number(at) || Date.now())
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const safeSender = sanitizeFileName(String(sender || 'unknown')).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 32) || 'unknown'
  const safeId = String(messageId == null ? 'noid' : messageId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 48)
  const stamp = d.toISOString().replace(/[:.]/g, '-')
  const ext = extensionForMime(mimeType)
  const originalExt = path.extname(sanitizeFileName(originalName || '')).replace(/^\./, '').toLowerCase()
  const finalExt = ext !== 'bin' ? ext : (/^[a-z0-9]{1,8}$/.test(originalExt) ? originalExt : 'bin')
  const file = path.join(String(dir), day, `${safeId}-${safeSender}-${stamp}-${index}.${finalExt}`)
  return { file, day }
}

/**
 * 保存入站媒体到统一目录，并往 `<dir>/index.jsonl` 追加一条记录。
 * 返回 { path:绝对路径, bytes, mime, kind, day }。
 */
export function saveInboxMedia({
  dir,
  kind,
  buffer,
  mimeType,
  at = Date.now(),
  messageId = null,
  peerId = null,
  sender = '',
  index = 1,
  originalName = '',
} = {}) {
  if (!dir) throw new Error('saveInboxMedia 需要 dir')
  const b = buffer instanceof Uint8Array ? buffer : null
  if (!b || !b.length) throw new Error('saveInboxMedia 需要非空字节')
  const { file, day } = inboxMediaPath({ dir, at, messageId, sender, index, mimeType, originalName })
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // 先写临时文件再 rename：视频浏览器可能并发 ffprobe，半截文件会被判成坏视频。
  const tmp = `${file}.part-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  try {
    fs.writeFileSync(tmp, Buffer.from(b))
    fs.renameSync(tmp, file)
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* 清理失败不掩盖原错误 */ }
    throw error
  }
  const record = {
    at: Number(at) || Date.now(),
    kind: String(kind ?? 'file'),
    path: path.resolve(file),
    bytes: b.length,
    mime: String(mimeType ?? ''),
    messageId: messageId == null ? null : String(messageId),
    peerId: peerId == null ? null : String(peerId),
    sender: String(sender ?? ''),
    originalName: sanitizeFileName(originalName || '') || null,
  }
  try {
    fs.appendFileSync(path.join(String(dir), 'index.jsonl'), `${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    // 索引写失败不能丢媒体文件；调用方会把错误写日志（这里不抛，避免把已保存文件回滚）
  }
  return { ...record, day }
}

export { formatBytes }
