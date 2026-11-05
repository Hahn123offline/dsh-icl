// 引用消息的"慢取"：读一条较早的消息在部分实现里要几十秒（NapCat 读旧合并转发实测 ~76s）。
// 这里沿用旧项目验证过的做法：
//   · 后台请求用长超时（默认 120s），同一 message_id 同时只发一个（并发去重 + 缓存）；
//   · 收消息时最多等一小会儿（默认 4s），等不到先放占位，不阻塞整条消息；
//   · 之后模型/工具再查可直接命中缓存。
//
// 只依赖注入的 OneBot HTTP 客户端；不自己发网络请求。
import { segmentsToText } from './rich.mjs'

export const SLOW_FETCH_TIMEOUT_MS = 120_000
export const REPLY_INGEST_WAIT_MS = 4_000
export const REPLY_INFO_TTL_MS = 30 * 60_000
export const REPLY_NEGATIVE_TTL_MS = 5_000

export class StillLoadingError extends Error {
  constructor(message = '还在加载') {
    super(message)
    this.code = 'still-loading'
  }
}

/** 最多等 waitMs；等不到抛 StillLoadingError（底层 promise 继续跑，由缓存接住）。 */
export function waitAtMost(promise, waitMs) {
  if (!(Number(waitMs) > 0)) return promise
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new StillLoadingError()), Number(waitMs)) }),
  ]).finally(() => clearTimeout(timer))
}

/**
 * 带缓存与并发去重的慢取器。
 * fetch 失败（含超时）只短暂负缓存，避免一次抖动长时间读不到；成功缓存 ttlMs。
 */
export function createSlowFetchCache({ fetch, ttlMs = REPLY_INFO_TTL_MS, negativeTtlMs = REPLY_NEGATIVE_TTL_MS, max = 300, now = Date.now } = {}) {
  if (typeof fetch !== 'function') throw new Error('createSlowFetchCache 需要 fetch')
  const cache = new Map()
  const inflight = new Map()
  function prune() {
    const at = now()
    for (const [key, row] of cache) {
      if (at - row.at > (row.ok ? ttlMs : negativeTtlMs)) cache.delete(key)
    }
    while (cache.size > max) cache.delete(cache.keys().next().value)
  }
  function start(key) {
    if (inflight.has(key)) return inflight.get(key)
    const promise = Promise.resolve()
      .then(() => fetch(key))
      .then((value) => { cache.set(key, { ok: true, value, at: now() }); return value },
        (error) => { cache.set(key, { ok: false, error, at: now() }); throw error })
      .finally(() => { inflight.delete(key); prune() })
    promise.catch(() => {})
    inflight.set(key, promise)
    return promise
  }
  return {
    async get(key, { waitMs = 0 } = {}) {
      const k = String(key)
      const hit = cache.get(k)
      if (hit && now() - hit.at <= (hit.ok ? ttlMs : negativeTtlMs)) {
        if (hit.ok) return hit.value
        throw hit.error
      }
      return waitAtMost(start(k), waitMs)
    },
    peek(key) {
      const hit = cache.get(String(key))
      return hit?.ok && now() - hit.at <= ttlMs ? hit.value : undefined
    },
    isLoading: (key) => inflight.has(String(key)),
    set(key, value) { cache.set(String(key), { ok: true, value, at: now() }); prune() },
    delete(key) { cache.delete(String(key)) },
    size: () => cache.size,
  }
}

/** 引用还在加载时给模型看的占位文字（带 message_id，之后可再查）。 */
export function pendingReplyText(messageId) {
  const id = String(messageId ?? '').replace(/[^\w-]/g, '').slice(0, 40)
  return `[引用消息${id ? ` id=${id}` : ''}（原消息加载较慢，稍后可用工具查看）]`
}

/** 引用解析后的展示文本：`[引用 发送者：原文]`。 */
export function replyContextText(info) {
  if (!info || info.pending) return pendingReplyText(info?.messageId)
  const parts = []
  if (info.sender) parts.push(String(info.sender).slice(0, 60))
  if (info.text) parts.push(String(info.text).slice(0, 200))
  return `[引用 ${parts.join('：') || '原消息'}]`
}

/**
 * 引用解析器：把 get_msg 的原始消息校验归属后转成 { sender, text, userId }。
 * 私聊归属：没有 group_id，且发送者是当前 peer 或自己；否则返回 null（防跨会话读取）。
 */
export function createReplyResolver({
  http = null,
  now = () => Date.now(),
  ttlMs = REPLY_INFO_TTL_MS,
  negativeTtlMs = REPLY_NEGATIVE_TTL_MS,
  max = 300,
  log = () => {},
} = {}) {
  const cache = createSlowFetchCache({
    ttlMs, negativeTtlMs, max, now,
    fetch: async (id) => {
      if (!http?.ok) throw new Error('没有 OneBot HTTP 端点，无法解析引用')
      const raw = await http.call('get_msg', { message_id: Number(id) })
      return raw && typeof raw === 'object' ? raw : null
    },
  })

  async function resolve(messageId, { peerId = null, selfId = null, waitMs = REPLY_INGEST_WAIT_MS } = {}) {
    const id = String(messageId ?? '').trim()
    if (!id || !/^\d+$/.test(id)) return null
    let raw
    try {
      raw = await cache.get(id, { waitMs })
    } catch (error) {
      if (error?.code === 'still-loading') return { pending: true, messageId: id }
      log({ level: 'info', msg: 'qq.reply.resolve-fail', id, error: String(error?.message ?? error) })
      return null
    }
    if (!raw) return null
    // 归属校验：私聊引用不能把别的群/别人的消息读回来。
    if (raw.group_id != null || raw.groupId != null) return null
    const senderId = String(raw.sender?.user_id ?? raw.user_id ?? '')
    if (peerId != null && senderId) {
      const allowed = new Set([String(peerId), ...(selfId == null ? [] : [String(selfId)])])
      if (!allowed.has(senderId)) return null
    }
    const text = segmentsToText(raw.message ?? [], {}).slice(0, 200)
    return {
      sender: String(raw.sender?.card || raw.sender?.nickname || senderId || '').slice(0, 60),
      text,
      userId: senderId || null,
      messageId: id,
    }
  }

  return { resolve, cache, invalidate: (id) => cache.delete(id), pendingReplyText, replyContextText }
}
