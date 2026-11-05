// 入站富内容的纯函数层：把 OneBot 消息段变成"可读文本 + 结构化媒体/转发/引用信息"。
//
// 只做格式化与提取，不下载、不发送、不连网。下载/展开分别由 media.mjs / forward.mjs /
// reply-cache.mjs 负责；这里的结果会进 signal.meta.qq，供后续工具（P0-2 之后）按需取图/文件。
//
// 参考（只读）：dsh-qq bridge.js segmentsToText/extractMedia、forward.js；focus-core qq.js textOfMessage。

export const RICH_LIMITS = Object.freeze({
  maxImages: 3,
  maxImageBytes: 8 * 1024 * 1024,
  maxFiles: 3,
  maxForwardIds: 3,
  maxForwardDepth: 2,
  maxForwardItems: 12,
  maxForwardChars: 1200,
  summaryChars: 60,
  fileNameChars: 120,
})

export function str(value) {
  return value == null ? '' : String(value)
}

/** 压掉换行/控制字符并限长：摘要会被拼进提示词，不能让它伪造新段落。 */
export function sanitizeSummary(value, max = RICH_LIMITS.summaryChars) {
  const s = str(value).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim()
  if (!s) return ''
  return s.length > max ? s.slice(0, max) : s
}

export function sanitizeFileName(value, max = RICH_LIMITS.fileNameChars) {
  let s = str(value).replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\/]+/g, '_').trim()
  if (s === '.' || s === '..') s = ''
  return s.length > max ? s.slice(0, max) : s
}

/** 合并转发 id 只接受安全字符（防它被当作任意参数传给 OneBot/日志）。 */
export function sanitizeForwardId(value) {
  const s = str(value).trim()
  if (!s || s.length > 256) return ''
  return /^[\w:.\-/=+@]+$/.test(s) ? s : ''
}

export function formatBytes(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

function segmentData(seg) {
  return seg?.data && typeof seg.data === 'object' ? seg.data : {}
}

/** 文件段：OneBot 的字段名不统一（file_id/file/busid/name/file_size），全收。 */
export function fileInfoOf(seg) {
  const data = segmentData(seg)
  const name = sanitizeFileName(data.name ?? data.file_name ?? data.fileName ?? '')
  const size = Number(data.file_size ?? data.size ?? data.fileSize)
  const fileId = str(data.file_id ?? data.fileId ?? data.file ?? data.id ?? '')
  const busid = Number.isFinite(Number(data.busid)) ? Number(data.busid) : null
  return {
    kind: 'file',
    name: name || null,
    size: Number.isFinite(size) && size >= 0 ? size : null,
    fileId: fileId || null,
    busid,
  }
}

/** 图片/表情/face 段的定位信息（不下载字节）。 */
export function extractMedia(segments) {
  const media = []
  for (const seg of Array.isArray(segments) ? segments : []) {
    if (!seg || typeof seg !== 'object') continue
    const data = segmentData(seg)
    const emoji = {
      emojiId: str(data.emoji_id ?? data.emojiId ?? ''),
      emojiPackageId: str(data.emoji_package_id ?? data.emojiPackageId ?? ''),
      emojiKey: str(data.key ?? ''),
    }
    if (seg.type === 'image') {
      media.push({
        kind: 'image',
        file: str(data.file ?? ''),
        url: str(data.url ?? ''),
        subType: data.sub_type != null ? str(data.sub_type) : (data.subType != null ? str(data.subType) : ''),
        summary: sanitizeSummary(data.summary),
        ...emoji,
      })
    } else if (seg.type === 'mface') {
      media.push({
        kind: 'sticker',
        file: str(data.file ?? ''),
        url: str(data.url ?? ''),
        subType: '1',
        summary: sanitizeSummary(data.summary),
        ...emoji,
      })
    } else if (seg.type === 'face') {
      media.push({ kind: 'face', faceId: str(data.id ?? ''), url: str(data.url ?? ''), summary: sanitizeSummary(data.summary) })
    }
  }
  return media.slice(0, RICH_LIMITS.maxImages)
}

export function extractFiles(segments) {
  const files = []
  for (const seg of Array.isArray(segments) ? segments : []) {
    if (!seg || seg.type !== 'file') continue
    files.push(fileInfoOf(seg))
  }
  return files.slice(0, RICH_LIMITS.maxFiles)
}

export function extractForwardIds(segments) {
  const out = []
  for (const seg of Array.isArray(segments) ? segments : []) {
    if (!seg || seg.type !== 'forward') continue
    const data = segmentData(seg)
    const id = sanitizeForwardId(data.id ?? data.res_id ?? data.forward_id ?? data.file_id ?? '')
    if (id && !out.includes(id)) out.push(id)
  }
  return out.slice(0, RICH_LIMITS.maxForwardIds)
}

export function extractReplyId(segments) {
  for (const seg of Array.isArray(segments) ? segments : []) {
    if (seg?.type !== 'reply') continue
    const id = str(segmentData(seg).id ?? '').trim()
    if (id) return id
  }
  return null
}

export function hasAtSelf(segments, selfId) {
  if (selfId == null) return false
  for (const seg of Array.isArray(segments) ? segments : []) {
    if (seg?.type !== 'at') continue
    if (str(segmentData(seg).qq) === String(selfId)) return true
  }
  return false
}

function atText(data, resolveAtName) {
  const qq = str(data.qq)
  if (qq === 'all') return '@全体成员'
  if (resolveAtName) {
    try {
      const name = resolveAtName(qq)
      if (name) return `@${name}`
    } catch { /* 解析不到就用号码 */ }
  }
  return `@${qq}`
}

/**
 * 消息段 → 可读文本。reply 默认是占位（`[引用]`），由 reply-cache 在进闸门前替换成
 * `[引用 某人：原文]`；forward 保留 id（`[合并转发 id=…]`），由 forward.mjs 展开后追加正文。
 */
export function segmentsToText(segments, { resolveAtName = null } = {}) {
  if (typeof segments === 'string') return segments.trim()
  if (!Array.isArray(segments)) return ''
  const parts = []
  for (const seg of segments) {
    if (!seg || typeof seg !== 'object') continue
    const data = segmentData(seg)
    switch (seg.type) {
      case 'text': parts.push(str(data.text)); break
      case 'at': parts.push(atText(data, resolveAtName)); break
      case 'face': parts.push(`[表情${str(data.id ?? '')}]`); break
      case 'mface': parts.push(`[表情${data.summary ? `:${sanitizeSummary(data.summary)}` : ''}]`); break
      case 'image': parts.push('[图片]'); break
      case 'record': parts.push('[语音]'); break
      case 'video': parts.push('[视频]'); break
      case 'file': {
        const info = fileInfoOf(seg)
        const size = formatBytes(info.size)
        parts.push(`[文件${info.name ? `：${info.name}` : ''}${size ? `（${size}）` : ''}]`)
        break
      }
      case 'reply': parts.push('[引用]'); break
      case 'forward': {
        const id = extractForwardIds([seg])[0]
        parts.push(id ? `[合并转发 id=${id}]` : '[合并转发]')
        break
      }
      case 'json': parts.push('[卡片]'); break
      case 'xml': parts.push('[卡片]'); break
      case 'markdown': parts.push(str(data.text ?? data.content ?? '[Markdown]')); break
      default: parts.push(`[${str(seg.type) || '未知'}]`); break
    }
  }
  return parts.join('').trim()
}

/** buildPrivateSignal 用的结构化摘要（进 meta.qq，不直接展示给模型）。 */
export function summarizeRich(segments) {
  return {
    media: extractMedia(segments),
    files: extractFiles(segments),
    forwardIds: extractForwardIds(segments),
    replyId: extractReplyId(segments),
    atSelf: false,
  }
}
