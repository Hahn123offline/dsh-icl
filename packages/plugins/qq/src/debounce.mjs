// 入站防抖（Phase 1）：把同一个人短时间内连发的多条消息合成一次投递。
//
// 为什么需要：对方连发 3 条时，如果每条各自进模型，就会变成 3 次独立唤醒/回合，
// 容易回三遍、回一半、或者抢在对方还没打完时插话。
//
// 这里的"静默窗口"不是发送间隔：它只决定"什么时候算这一批说完了"。
// 时间从最后一条到达开始重新计，超过 maxHoldMs 即使还在连发也必须交出去，
// 否则模型会永远等下去。
//
// 纯逻辑 + 可注入 timer，便于测试；不做 IO、不碰发送。
import { RATE_FAST, RATE_WINDOW_MS, windowDelayMs } from './attention-window.mjs'

export const DEBOUNCE_DEFAULTS = Object.freeze({
  enabled: false,
  quietMs: 10_000,
  mentionQuietMs: 4_000,
  maxHoldMs: 30_000,
  maxBatchMessages: 20,
  // 群聊：安静小群可以更快进入；刷屏时用 5s-rate 自适应窗口往后压。
  groupQuietMs: 6_000,
  groupMentionQuietMs: 3_000,
  groupMaxHoldMs: 60_000,
})

const clamp = (value, min, max, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback
}

export function normalizeDebounceConfig(input = {}) {
  const raw = input && typeof input === 'object' ? input : {}
  return {
    enabled: raw.enabled === true,
    quietMs: clamp(raw.quietMs, 1_000, 60_000, DEBOUNCE_DEFAULTS.quietMs),
    mentionQuietMs: clamp(raw.mentionQuietMs, 500, 30_000, DEBOUNCE_DEFAULTS.mentionQuietMs),
    groupQuietMs: clamp(raw.groupQuietMs, 500, 30_000, DEBOUNCE_DEFAULTS.groupQuietMs),
    groupMentionQuietMs: clamp(raw.groupMentionQuietMs, 500, 30_000, DEBOUNCE_DEFAULTS.groupMentionQuietMs),
    groupMaxHoldMs: clamp(raw.groupMaxHoldMs, 2_000, 300_000, DEBOUNCE_DEFAULTS.groupMaxHoldMs),
    maxHoldMs: clamp(raw.maxHoldMs, 2_000, 300_000, DEBOUNCE_DEFAULTS.maxHoldMs),
    maxBatchMessages: clamp(raw.maxBatchMessages, 1, 100, DEBOUNCE_DEFAULTS.maxBatchMessages),
  }
}

/** 把同一 activity 的多条 signal 合并成一条（保留原顺序、图片/媒体/账本 seq）。 */
export function mergeSignals(signals) {
  const list = Array.isArray(signals) ? signals.filter(Boolean) : []
  if (!list.length) return null
  if (list.length === 1) return list[0]
  const first = list[0]
  const activity = first.from?.activity ?? null
  const envelope = first.meta?.qq?.envelope ?? null
  const prefix = /^(\[QQ[^\]]*\])\s*/.exec(String(first.text ?? ''))?.[1] ?? ''
  const samePrefix = prefix && list.every((signal) => String(signal.text ?? '').startsWith(prefix))
  const bodies = list.map((signal) => {
    const text = String(signal.text ?? '')
    return samePrefix ? text.slice(prefix.length).trimStart() : text
  })
  const text = samePrefix
    ? `${prefix}（连发 ${list.length} 条）\n${bodies.map((body) => `· ${body}`).join('\n')}`
    : bodies.join('\n')
  const seqs = list.map((signal) => signal.meta?.qq?.ledger?.seq).filter((seq) => Number(seq) > 0)
  const messageIds = list.map((signal) => signal.meta?.qq?.envelope?.messageId ?? signal.meta?.qq?.ledger?.qqId).filter(Boolean)
  const tags = [...new Set(list.flatMap((signal) => (Array.isArray(signal.tags) ? signal.tags : [])))]
  const images = list.flatMap((signal) => (Array.isArray(signal.images) ? signal.images : []))
  const mediaFiles = list.flatMap((signal) => (Array.isArray(signal.meta?.qq?.mediaFiles) ? signal.meta.qq.mediaFiles : []))
  const expiresAt = list.reduce((max, signal) => Math.max(max, Number(signal.expiresAt) || 0), 0) || null
  return {
    ...first,
    id: `qq:batch:${activity ?? 'unknown'}:${seqs[0] ?? list[0].id ?? 'x'}-${seqs[seqs.length - 1] ?? list.length}`,
    text,
    tags,
    images,
    expiresAt,
    meta: {
      ...(first.meta ?? {}),
      qq: {
        ...(first.meta?.qq ?? {}),
        envelope: envelope ? { ...envelope, at: list[list.length - 1].meta?.qq?.envelope?.at ?? envelope.at } : envelope,
        mediaFiles: mediaFiles.length ? mediaFiles : (first.meta?.qq?.mediaFiles ?? null),
        batch: {
          count: list.length,
          seqs,
          messageIds,
          firstAt: list[0].meta?.qq?.envelope?.at ?? null,
          lastAt: list[list.length - 1].meta?.qq?.envelope?.at ?? null,
        },
      },
      // 被 focus/time 拦下后重放时，回执要能补推整批的 delivered，而不是只补第一条。
      replayQq: seqs.map((seq) => ({ activity, seq })),
    },
  }
}

/**
 * 创建按 activity 分组的防抖器。
 * @param {object} options
 * @param {object} options.config normalize 后的配置
 * @param {Function} options.onFlush (signal) => void|Promise<void>
 * @param {Function} [options.now]
 * @param {Function} [options.setTimer]
 * @param {Function} [options.clearTimer]
 */
export function createInboundDebouncer({
  config = {},
  onFlush = () => {},
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (timer) => clearTimeout(timer),
  log = () => {},
} = {}) {
  const cfg = normalizeDebounceConfig(config)
  const buffers = new Map() // activity -> { items, firstAt, lastAt, quietTimer, hardTimer }
  const stats = { pushed: 0, batches: 0, flushedMessages: 0, maxBatch: 0, dropped: 0 }

  function activityOf(signal) {
    return String(signal?.from?.activity ?? signal?.meta?.qq?.envelope?.activity ?? 'unknown')
  }

  function clearTimers(entry) {
    if (entry?.quietTimer) { try { clearTimer(entry.quietTimer) } catch { /* 已触发 */ } entry.quietTimer = null }
    if (entry?.hardTimer) { try { clearTimer(entry.hardTimer) } catch { /* 已触发 */ } entry.hardTimer = null }
  }

  function flush(activity) {
    const key = String(activity)
    const entry = buffers.get(key)
    if (!entry) return null
    buffers.delete(key)
    clearTimers(entry)
    const signal = mergeSignals(entry.items)
    if (!signal) return null
    // 旧 busyness 规则：安静群的普通消息应当能叫醒；只有峰值速率超过 RATE_FAST
    // 才标 ambient，交给 focus 进 backlog。@ 永远不标 ambient。
    if (entry.isGroup) {
      const mention = Array.isArray(signal.tags) && (signal.tags.includes('mention') || signal.tags.includes('at'))
      if (!mention && Number(entry.peakRate ?? 0) > RATE_FAST) {
        signal.tags = [...new Set([...(signal.tags ?? []), 'ambient'])]
        signal.meta = { ...(signal.meta ?? {}), ambient: true }
      }
    }
    stats.batches += 1
    stats.flushedMessages += entry.items.length
    stats.maxBatch = Math.max(stats.maxBatch, entry.items.length)
    log({ msg: 'qq.debounce.flush', activity: key, count: entry.items.length, chars: String(signal.text ?? '').length })
    try {
      const out = onFlush(signal)
      if (out && typeof out.catch === 'function') out.catch((error) => log({ level: 'warn', msg: 'qq.debounce.flush-fail', error: String(error?.message ?? error) }))
    } catch (error) {
      log({ level: 'warn', msg: 'qq.debounce.flush-fail', error: String(error?.message ?? error) })
    }
    return signal
  }

  /** 等待/抢占路径：把尚未到 quiet 的条目取走，交给等待者消费，不再走正常投递。 */
  function take(activity) {
    const key = String(activity)
    const entry = buffers.get(key)
    if (!entry) return []
    buffers.delete(key)
    clearTimers(entry)
    return entry.items.slice()
  }

  function armQuiet(entry) {
    if (entry.quietTimer) { try { clearTimer(entry.quietTimer) } catch { /* 已触发 */ } }
    const last = entry.items[entry.items.length - 1]
    const tags = Array.isArray(last?.tags) ? last.tags : []
    const mentioned = Boolean(last?.meta?.qq?.envelope?.mentioned || last?.meta?.mentioned || tags.includes('mention') || tags.includes('at'))
    const isGroup = entry.isGroup === true
    const base = isGroup
      ? (mentioned ? cfg.groupMentionQuietMs : cfg.groupQuietMs)
      : (mentioned ? cfg.mentionQuietMs : cfg.quietMs)
    // 旧 focus-core 的繁忙度：只对群做 per-activity 5s 速率窗口。
    let quiet = base
    if (isGroup) {
      const at = now()
      entry.arrivals = (entry.arrivals ?? []).filter((t) => at - t < RATE_WINDOW_MS)
      const rate = entry.arrivals.length
      entry.peakRate = Math.max(Number(entry.peakRate ?? 0), rate)
      const adaptive = windowDelayMs(rate, mentioned ? 'pierce' : 'ambient')
      quiet = Math.max(base, adaptive)
    }
    entry.quietTimer = setTimer(() => flush(entry.activity), Math.max(1, quiet))
    if (typeof entry.quietTimer?.unref === 'function') entry.quietTimer.unref()
  }

  function push(signal) {
    if (!signal) return null
    if (!cfg.enabled) { onFlush(signal); return null }
    const activity = activityOf(signal)
    stats.pushed += 1
    let entry = buffers.get(activity)
    if (!entry) {
      const isGroup = activity.startsWith('qq:group:')
      entry = {
        activity,
        isGroup,
        items: [],
        arrivals: [],
        firstAt: now(),
        lastAt: now(),
        quietTimer: null,
        hardTimer: null,
      }
      buffers.set(activity, entry)
      const hold = isGroup ? cfg.groupMaxHoldMs : cfg.maxHoldMs
      entry.hardTimer = setTimer(() => flush(activity), Math.max(1, hold))
      if (typeof entry.hardTimer?.unref === 'function') entry.hardTimer.unref()
    }
    entry.items.push(signal)
    entry.arrivals.push(now())
    entry.lastAt = now()
    if (entry.items.length >= cfg.maxBatchMessages) {
      flush(activity)
      return null
    }
    armQuiet(entry)
    return { activity, count: entry.items.length, quietMs: entry.isGroup ? cfg.groupQuietMs : cfg.quietMs, maxHoldMs: entry.isGroup ? cfg.groupMaxHoldMs : cfg.maxHoldMs }
  }

  function flushAll() {
    for (const activity of [...buffers.keys()]) flush(activity)
  }

  function dispose({ flushPending = true } = {}) {
    if (flushPending) flushAll()
    for (const entry of buffers.values()) clearTimers(entry)
    buffers.clear()
  }

  function status() {
    return {
      enabled: cfg.enabled,
      config: { ...cfg },
      pendingActivities: buffers.size,
      pendingMessages: [...buffers.values()].reduce((sum, entry) => sum + entry.items.length, 0),
      pushed: stats.pushed,
      batches: stats.batches,
      flushedMessages: stats.flushedMessages,
      maxBatch: stats.maxBatch,
    }
  }

  return { push, flush, flushAll, take, dispose, status, config: () => ({ ...cfg }) }
}
