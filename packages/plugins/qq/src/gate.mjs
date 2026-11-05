// 入站准入闸门：决定"这条 OneBot 事件该不该变成 signal"。
//
// 顺序刻意排成"先便宜、后昂贵；先去重、后限流"：
//   认事件 → 私聊/群 → 自发 → 白名单 → 内容 → 消息时间是否过旧 → 幂等去重 → 每分钟限流
//
// 关键约定（与 docs/QQ.md §4 对应）：
//   · **群消息整类拒绝**：本轮连只读都不接群；这里只计数，不解析内容。
//   · **去重按 signal id**（signalIdFor），跨重连/重启也认；id 也是 signals 层的幂等键。
//   · 被 rate/stale/allowlist 丢掉的**不占用 id**：将来允许重放时不会因此被当成重复。
//   · 闸门只做本地裁决；时间静音锁（time gate）、focus 门控在 signals/delivery 里，
//     这里不读、不复制它们的判断，避免两处状态不一致。
import fsModule from 'node:fs'
import pathModule from 'node:path'
import { buildPrivateSignal, messageIdOf, normalizeSegments, senderIdOf, senderNameOf, sentAtOf } from './normalize.mjs'

export const DROP_CODES = Object.freeze([
  'invalid', 'not-message', 'meta', 'group', 'unsupported-message-type',
  'self', 'not-allowlisted', 'empty', 'stale', 'duplicate', 'rate',
])

/** 有界去重表：id -> 首次见到的时间。可选落盘，重启后仍认旧消息。 */
export function createDedupeStore({ now = () => Date.now(), windowMs = 86_400_000, limit = 5000, file = null } = {}) {
  const seen = new Map()
  let dirty = false

  function prune(at) {
    for (const [id, stamp] of seen) {
      if (at - stamp > windowMs) { seen.delete(id); dirty = true }
    }
    while (seen.size > limit) {
      // Map 迭代顺序 = 插入顺序：删最老的
      const oldest = seen.keys().next().value
      seen.delete(oldest)
      dirty = true
    }
  }

  function load() {
    if (!file) return { loaded: 0 }
    try {
      const raw = fsModule.readFileSync(file, 'utf8')
      const data = JSON.parse(raw)
      const rows = data && typeof data === 'object' && data.seen && typeof data.seen === 'object' ? data.seen : {}
      for (const [id, stamp] of Object.entries(rows)) {
        const at = Number(stamp)
        if (Number.isFinite(at)) seen.set(String(id), at)
      }
      prune(now())
      return { loaded: seen.size }
    } catch (error) {
      // 文件不存在是第一次运行；坏文件按空表处理但要让调用方知道
      return { loaded: 0, error: String(error?.message ?? error) }
    }
  }

  function save() {
    if (!file) return { saved: false }
    try {
      fsModule.mkdirSync(pathModule.dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      fsModule.writeFileSync(tmp, JSON.stringify({ version: 1, seen: Object.fromEntries(seen) }), 'utf8')
      fsModule.renameSync(tmp, file)
      dirty = false
      return { saved: true }
    } catch (error) {
      return { saved: false, error: String(error?.message ?? error) }
    }
  }

  return {
    has(id) { return seen.has(String(id)) },
    add(id, at = now()) {
      seen.set(String(id), Number(at) || now())
      dirty = true
      prune(Number(at) || now())
    },
    size: () => seen.size,
    load,
    save,
    /** 只在有变化时落盘（dispose/tick 调用）。 */
    flush() { return dirty ? save() : { saved: false, skipped: true } },
    clear() { seen.clear(); dirty = true },
  }
}

/** 每分钟限流：按 peer 计数，窗口内超出直接丢弃并计数（不排队，避免无限缓冲）。 */
export function createRateLimiter({ now = () => Date.now(), maxPerMinute = 30 } = {}) {
  const buckets = new Map() // peerId -> [timestamps]
  return {
    take(peerId) {
      const key = String(peerId)
      const at = now()
      const list = (buckets.get(key) ?? []).filter((t) => at - t < 60_000)
      if (maxPerMinute > 0 && list.length >= maxPerMinute) {
        buckets.set(key, list)
        return false
      }
      list.push(at)
      buckets.set(key, list)
      return true
    },
    pending(peerId) {
      const list = (buckets.get(String(peerId)) ?? []).filter((t) => now() - t < 60_000)
      return list.length
    },
    reset() { buckets.clear() },
  }
}

/**
 * 创建入站准入闸门。
 * @param {object} options
 * @param {number[]|string[]} options.allowPrivate  允许的私聊 QQ 号；空数组 = 一律拒绝（默认安全）
 * @param {boolean} options.allowAllPrivate         显式"全部私聊都收"（仍需 enabled 总开关）
 * @param {string|null} options.selfId              机器人自己的 QQ 号，用于过滤自发
 * @param {number} options.maxStaleMs               消息时间超过多久算过旧（0/负数 = 不判）
 * @param {boolean} options.deliverBackfill         是否允许补课旧消息进模型
 * @param {number} options.maxPerMinute             每私聊每分钟上限（0 = 不限）
 */
export function createInboundGate({
  now = () => Date.now(),
  allowPrivate = [],
  allowAllPrivate = false,
  selfId = null,
  maxStaleMs = 600_000,
  deliverBackfill = false,
  maxPerMinute = 30,
  maxTextChars = 2000,
  dedupe = null,
} = {}) {
  const allow = new Set((Array.isArray(allowPrivate) ? allowPrivate : []).map(String))
  const limiter = createRateLimiter({ now, maxPerMinute })
  const store = dedupe ?? createDedupeStore({ now })
  const counters = {
    received: 0,
    accepted: 0,
    dropped: Object.fromEntries(DROP_CODES.map((code) => [code, 0])),
    byCode: Object.fromEntries(DROP_CODES.map((code) => [code, 0])),
  }
  const drop = (code) => {
    counters.dropped[code] = (counters.dropped[code] ?? 0) + 1
    counters.byCode[code] = (counters.byCode[code] ?? 0) + 1
    return { accept: false, code }
  }

  return {
    /** 判断一条原始 OneBot 事件。返回 {accept:true, signal, ...} 或 {accept:false, code}。 */
    admit(event, { receivedAt = now() } = {}) {
      counters.received += 1
      if (!event || typeof event !== 'object') return drop('invalid')

      // meta_event/heartbeat/lifecycle：连接健康信号，不是消息
      if (event.post_type === 'meta_event') return drop('meta')
      if (event.post_type !== 'message') return drop('not-message')

      const messageType = String(event.message_type ?? '')
      if (messageType === 'group') return drop('group')
      if (messageType !== 'private') return drop('unsupported-message-type')

      const senderId = senderIdOf(event)
      if (!senderId) return drop('invalid')
      if (selfId != null && String(selfId) === senderId) return drop('self')

      // 白名单：空 = 一个都不收。默认安全，必须显式打开。
      if (!(allowAllPrivate === true || allow.has(senderId))) return drop('not-allowlisted')

      const { segments, text } = normalizeSegments(event.message, event.raw_message)
      if (!text.trim()) return drop('empty')

      const sentAt = sentAtOf(event)
      // 消息自己的时间才算数：WS 实时消息 ≈ 现在；重连/补课之后才到的旧消息默认不进模型
      if (sentAt != null && !deliverBackfill && maxStaleMs > 0 && receivedAt - sentAt > maxStaleMs) {
        return { ...drop('stale'), ageMs: receivedAt - sentAt }
      }

      const messageId = messageIdOf(event)
      const peerId = senderId
      const senderName = senderNameOf(event, senderId)
      const signal = buildPrivateSignal({
        peerId,
        senderId,
        senderName,
        text,
        segments,
        messageId,
        sentAt,
        receivedAt,
        selfId,
        maxTextChars,
      })

      // 先查重（重复不计限流额度），再限流
      if (store.has(signal.id)) return drop('duplicate')
      if (!limiter.take(peerId)) return drop('rate')
      store.add(signal.id, receivedAt)
      counters.accepted += 1
      return {
        accept: true,
        code: 'ok',
        signal,
        peerId,
        senderId,
        senderName,
        messageId,
        messageAt: sentAt ?? receivedAt,
        receivedAt,
      }
    },

    counters: () => ({ ...counters, dropped: { ...counters.dropped }, byCode: { ...counters.byCode } }),
    dedupe: store,
    limiter,
    /** 落盘去重表（dispose / 定时调用）。 */
    flush() { return store.flush() },
    reset() {
      store.clear()
      limiter.reset()
      for (const code of DROP_CODES) { counters.dropped[code] = 0; counters.byCode[code] = 0 }
      counters.received = 0
      counters.accepted = 0
    },
  }
}
