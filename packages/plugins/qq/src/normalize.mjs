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

/** 群/私聊的活动 id：与 focus 的命名空间一致（transport:scope:id）。 */
export function activityIdForPrivate(peerId) {
  return `qq:private:${String(peerId)}`
}

export function activityIdForGroup(groupId) {
  return `qq:group:${String(groupId)}`
}

/** 非文本段的占位：让模型知道"这里有个东西"，但不把二进制塞进上下文。 */
const SEGMENT_PLACEHOLDER = Object.freeze({
  image: '[图片]',
  mface: '[表情]',
  face: '[表情]',
  record: '[语音]',
  video: '[视频]',
  file: '[文件]',
  json: '[卡片]',
  xml: '[卡片]',
  forward: '[合并转发]',
  node: '[合并转发]',
  markdown: '[卡片]',
  poke: '[戳一戳]',
})

function str(value) {
  return value == null ? '' : String(value)
}

/** OneBot 的 message 可能是 string 或 segment 数组；统一成 { segments, text }。 */
export function normalizeSegments(message, rawMessage = '') {
  if (typeof message === 'string') {
    const text = message.trim() ? message : str(rawMessage)
    return { segments: text ? [{ type: 'text', text }] : [], text: text.trim() ? text : '' }
  }
  if (!Array.isArray(message)) {
    const text = str(rawMessage).trim()
    return { segments: text ? [{ type: 'text', text }] : [], text }
  }
  const segments = []
  const parts = []
  for (const seg of message) {
    if (!seg || typeof seg !== 'object') continue
    const type = str(seg.type) || 'unknown'
    const data = seg.data && typeof seg.data === 'object' ? seg.data : {}
    if (type === 'text') {
      const text = str(data.text)
      if (!text) continue
      segments.push({ type: 'text', text })
      parts.push(text)
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
    // 媒体段只保留来源引用与占位，不下载、不展开
    const ref = str(data.url || data.file || data.path || '')
    segments.push({ type, ref: ref || null, name: data.name == null ? null : str(data.name) })
    const placeholder = SEGMENT_PLACEHOLDER[type] || `[${type}]`
    parts.push(placeholder)
  }
  return { segments, text: parts.join('').trim() }
}

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
  selfId = null, maxTextChars = 2000,
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
  return {
    id: signalIdFor({ scope: 'private', peerId: peer, messageId, at, text: body }),
    from: { plugin: 'qq', activity },
    kind: 'notice',
    to: 'model',
    // 私聊是"有人专门对她说"：文案带发言人，tags 带 mention 让 focus 按 pierce 处理。
    text: `${name}：${body}`,
    focus: activity,
    tags: ['qq', 'private', 'mention'],
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
      },
    },
  }
}
