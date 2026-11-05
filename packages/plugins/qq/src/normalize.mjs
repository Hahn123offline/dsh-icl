// OneBot v11 入站事件的规范化：**纯函数，不碰 IO、不连接、不发送**。
//
// 为什么单独一层：QQ 的形状（post_type / message_type / message 段 / message_seq）
// 不该漏进 ICL 的核心。这里只做三件事：
//   1. 认事件：只认私聊消息；群消息整类忽略（本轮连只读都不接群）
//   2. 把消息段变成可读文本 + 结构化 meta（图片/语音/文件只留占位与引用，不下载）
//   3. 生成 ICL signal 的形状（id / from / focus / tags / createdAt）
//
// 参考实现（只读，不复制）：focus-core 的 domain/qq-ws.js + qq-poller.js、
// dsh-qq/interface-platform 的 onebot-v11/mapping.mjs。
import { RICH_LIMITS, hasAtSelf, segmentsToText, summarizeRich } from './rich.mjs'

/** 群/私聊的活动 id：与 focus 的命名空间一致（transport:scope:id）。 */
export function activityIdForPrivate(peerId) {
  return `qq:private:${String(peerId)}`
}

export function activityIdForGroup(groupId) {
  return `qq:group:${String(groupId)}`
}

/** 非文本段的占位：让模型知道"这里有个东西"，但不把二进制塞进上下文。 */
function str(value) {
  return value == null ? '' : String(value)
}

/** OneBot 的 message 可能是 string 或 segment 数组；统一成 { segments, text, rich }。 */
export function normalizeSegments(message, rawMessage = '') {
  if (typeof message === 'string') {
    const text = message.trim() ? message : str(rawMessage)
    return { segments: text ? [{ type: 'text', text }] : [], text: text.trim() ? text : '', rich: emptyRich() }
  }
  if (!Array.isArray(message)) {
    const text = str(rawMessage).trim()
    return { segments: text ? [{ type: 'text', text }] : [], text, rich: emptyRich() }
  }
  const segments = []
  for (const seg of message) {
    if (!seg || typeof seg !== 'object') continue
    const type = str(seg.type) || 'unknown'
    const data = seg.data && typeof seg.data === 'object' ? seg.data : {}
    if (type === 'text') {
      const text = str(data.text)
      if (!text) continue
      segments.push({ type: 'text', text })
      continue
    }
    if (type === 'at') {
      // 私聊里的 at 没有群语义；保留成结构化段，让上层能看见"点了谁"
      const target = str(data.qq)
      segments.push({ type: 'mention', target })
      continue
    }
    if (type === 'reply') {
      segments.push({ type: 'reply', messageId: str(data.id) })
      continue
    }
    if (type === 'file') {
      const size = Number(data.file_size ?? data.size ?? data.fileSize)
      segments.push({
        type: 'file',
        ref: str(data.file_id ?? data.file ?? data.id ?? '') || null,
        name: data.name == null ? null : str(data.name),
        size: Number.isFinite(size) && size >= 0 ? size : null,
      })
      continue
    }
    // 媒体段只保留来源引用与占位，不下载、不展开
    const ref = str(data.url || data.file || data.path || '')
    segments.push({ type, ref: ref || null, name: data.name == null ? null : str(data.name) })
  }
  // 文本由 rich.mjs 统一格式化：文件带 name/size、转发带 id、表情带 summary，图片仍是占位。
  const text = segmentsToText(message).trim()
  return { segments, text, rich: summarizeRich(message) }
}

function emptyRich() {
  return { media: [], files: [], forwardIds: [], replyId: null, atSelf: false }
}

/** 给 buildPrivateSignal 用的富内容摘要（不含字节，只含定位信息）。 */
export function richSummaryOf(message, selfId = null) {
  const rich = Array.isArray(message) ? summarizeRich(message) : emptyRich()
  rich.atSelf = Array.isArray(message) ? hasAtSelf(message, selfId) : false
  return rich
}

export { RICH_LIMITS }

/** 消息自己的发生时间（毫秒）。OneBot 的 time 是秒；没有就返回 null，由调用方决定。 */
export function sentAtOf(event) {
  const sec = Number(event?.time)
  if (!Number.isFinite(sec) || sec <= 0) return null
  // 兼容"已经是毫秒"的实现：大于 1e12 视为毫秒
  return sec > 1e12 ? Math.round(sec) : Math.round(sec * 1000)
}

export function senderIdOf(event) {
  const id = event?.sender?.user_id ?? event?.user_id
  return id == null || String(id) === '' ? null : String(id)
}

export function senderNameOf(event, fallback = '') {
  const s = event?.sender ?? {}
  return str(s.card) || str(s.nickname) || str(s.user_id ?? event?.user_id) || str(fallback)
}

/** OneBot message_id 在各实现里可能是数字/字符串，甚至没有；统一成非空字符串或 null。 */
export function messageIdOf(event) {
  const id = event?.message_id
  if (id == null || String(id) === '') return null
  return String(id)
}

function hashText(text) {
  let h = 5381
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/** 稳定 id：同一条 QQ 消息重复到达时得到同一个 id，signals 层据此幂等。 */
export function signalIdFor({ scope = 'private', peerId, messageId = null, at = 0, text = '' }) {
  if (messageId != null) return `qq:${scope}:${peerId}:${messageId}`
  // 没有 message_id 的实现（少见）：用时间 + 文本哈希兜底，宁可保守去重也不能重复投递
  return `qq:${scope}:${peerId}:t:${Math.max(0, Math.floor(Number(at) || 0))}:${hashText(text)}`
}

/**
 * 把一条已通过准入的私聊消息变成 ICL signal 的形状。
 * 只产出数据，不投递；投递由 index.mjs 走 ctx.signals.offer。
 */
export function buildPrivateSignal({
  peerId, senderId = null, senderName = '', text, segments = [],
  messageId = null, sentAt = null, receivedAt = Date.now(),
  selfId = null, maxTextChars = 2000, rich = null,
}) {
  const peer = String(peerId)
  const sender = senderId == null ? peer : String(senderId)
  const name = str(senderName) || sender
  const clip = (s) => {
    const t = str(s)
    return t.length > maxTextChars ? `${t.slice(0, maxTextChars)}…` : t
  }
  const body = clip(text)
  const at = Number.isFinite(Number(sentAt)) ? Number(sentAt) : receivedAt
  const activity = activityIdForPrivate(peer)
  const richInfo = rich && typeof rich === 'object' ? rich : emptyRich()
  // 私聊默认是 ambient：**不自动带 mention/at**，否则普通 focus 永远挡不住她（红队指出的语义 bug）。
  // 只有显式 @ 到自己（rich.atSelf）才加 at；管理员/告警穿透必须由来源显式打 tags:['admin']/['alarm']。
  const tags = ['qq', 'private']
  if (richInfo.atSelf === true) tags.push('at')
  return {
    id: signalIdFor({ scope: 'private', peerId: peer, messageId, at, text: body }),
    from: { plugin: 'qq', activity },
    kind: 'notice',
    to: 'model',
    text: `${name}：${body}`,
    focus: activity,
    tags,
    createdAt: at,
    // expiresAt 由调用方按 TTL 设置（入站规范化只管形状）
    expiresAt: null,
    meta: {
      qq: {
        scope: 'private',
        peerId: peer,
        senderId: sender,
        senderName: name,
        messageId: messageId == null ? null : String(messageId),
        at,
        receivedAt,
        selfId: selfId == null ? null : String(selfId),
        segments,
        // P0-2 富内容：只存定位信息（图片/表情/文件/转发 id/引用 id），不存字节、不存 URL 给模型
        media: richInfo.media ?? [],
        files: richInfo.files ?? [],
        forwardIds: richInfo.forwardIds ?? [],
        replyId: richInfo.replyId ?? null,
        atSelf: richInfo.atSelf === true,
      },
    },
  }
}
