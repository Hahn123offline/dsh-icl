// 合并转发（合并聊天记录）的展开：把 `get_forward_msg` 的返回格式化成可读文本。
//
// 旧项目教训（dsh-qq forward.js）：节点形状不统一（SnowLuma 的 messages[]、node 段、
// content/message 字符串或数组），不做兼容会把整段转成 "[object Object]"；
// 另外必须有深度/条数/字数上限，否则一条嵌套转发就能把上下文撑爆。
//
// 纯格式化函数不访问网络；expandForwardIds 只调用注入的 fetchForward。
import { RICH_LIMITS, sanitizeForwardId, str, segmentsToText } from './rich.mjs'

export function nodeContent(node) {
  if (!node || typeof node !== 'object') return []
  const data = node.data && typeof node.data === 'object' ? node.data : {}
  const candidates = [node.message, node.content, data.message, data.content, data.text, node.text]
  for (const value of candidates) {
    if (Array.isArray(value)) return value
    if (typeof value === 'string' && value) return [{ type: 'text', data: { text: value } }]
    if (value && typeof value === 'object' && value.type) return [value]
  }
  return []
}

export function nodeText(node, { maxChars = 400 } = {}) {
  const segments = nodeContent(node)
  const text = segmentsToText(segments, {})
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
}

export function senderNameOfNode(node) {
  const data = node?.data && typeof node.data === 'object' ? node.data : {}
  const sender = node?.sender
  if (sender && typeof sender === 'object') return str(sender.card || sender.nickname || sender.user_id || '').slice(0, 60)
  if (typeof sender === 'string' && sender) return sender.slice(0, 60)
  return str(data.name || data.nickname || data.card || data.uin || data.user_id || node?.name || node?.nickname || '').slice(0, 60)
}

function nodeTime(node) {
  const raw = node?.time ?? node?.data?.time
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return ''
  const ms = n > 1e12 ? n : n * 1000
  try { return new Date(ms).toLocaleString('zh-CN', { hour12: false }) } catch { return '' }
}

/** 从 get_forward_msg 的任意常见返回形状里取出节点数组。 */
export function normalizeForwardData(data) {
  if (!data) return []
  if (Array.isArray(data)) return data
  if (Array.isArray(data.messages)) return data.messages
  if (Array.isArray(data.message)) {
    // 可能是 [{type:'node',data:{...}}] 或直接节点数组
    if (data.message.some((item) => item?.type === 'node')) return data.message.map((item) => item.data ?? item)
    return data.message
  }
  if (Array.isArray(data.content)) return data.content
  if (data.message && typeof data.message === 'object') return [data.message]
  return []
}

/**
 * 把一层转发展开成文本行（不含嵌套递归）。
 * @returns {{lines: string[], items: number, truncated: boolean, nestedIds: string[]}}
 */
export function formatForwardNodes(data, { maxItems = RICH_LIMITS.maxForwardItems, maxChars = RICH_LIMITS.maxForwardChars } = {}) {
  const nodes = normalizeForwardData(data)
  const lines = []
  const nestedIds = []
  let used = 0
  let truncated = nodes.length > maxItems
  for (let i = 0; i < nodes.length && i < maxItems; i += 1) {
    const node = nodes[i]
    const name = senderNameOfNode(node) || '某人'
    const time = nodeTime(node)
    const text = nodeText(node)
    if (!text) continue
    let line = `- ${name}${time ? `（${time}）` : ''}：${text}`
    if (used + line.length > maxChars) {
      const remain = Math.max(0, maxChars - used)
      if (remain > 20) lines.push(`${line.slice(0, remain)}…`)
      truncated = true
      break
    }
    lines.push(line)
    used += line.length + 1
    for (const seg of nodeContent(node)) {
      if (seg?.type === 'forward') {
        const id = sanitizeForwardId(seg?.data?.id ?? seg?.data?.res_id ?? seg?.data?.forward_id ?? '')
        if (id && !nestedIds.includes(id)) nestedIds.push(id)
      }
    }
  }
  return { lines, items: lines.length, truncated, nestedIds }
}

/**
 * 展开若干 forward id（最多 maxIds 条），嵌套转发按 maxDepth 递归（默认 2 层）。
 * fetchForward(id) → get_forward_msg 的 data。返回可直接拼进消息正文的文本。
 */
export async function expandForwardIds(ids, { fetchForward, maxIds = 2, maxDepth = RICH_LIMITS.maxForwardDepth, maxItems = RICH_LIMITS.maxForwardItems, maxChars = RICH_LIMITS.maxForwardChars } = {}) {
  if (typeof fetchForward !== 'function') return ''
  const list = (Array.isArray(ids) ? ids : []).map(sanitizeForwardId).filter(Boolean).slice(0, Math.max(1, maxIds))
  const out = []
  for (const id of list) {
    try {
      const data = await fetchForward(id)
      const formatted = formatForwardNodes(data, { maxItems, maxChars })
      if (formatted.lines.length) out.push(`【转发展开 ${id}】\n${formatted.lines.join('\n')}${formatted.truncated ? '\n…（已截断）' : ''}`)
      if (maxDepth > 1 && formatted.nestedIds.length) {
        const nested = await expandForwardIds(formatted.nestedIds, {
          fetchForward, maxIds: 1, maxDepth: maxDepth - 1, maxItems: Math.min(4, maxItems), maxChars: Math.min(500, maxChars),
        })
        if (nested) out.push(nested)
      }
    } catch (error) {
      out.push(`【转发 ${id} 展开失败：${String(error?.message ?? error).slice(0, 80)}】`)
    }
  }
  return out.join('\n')
}
