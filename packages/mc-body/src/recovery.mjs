// 身体的可测试小零件：限流配额、进度判定、心跳、危险方块判定。
// 纯函数/状态机，不依赖 mineflayer；body.mjs 与 mineflayer.mjs 共用。
// 出处：docs/MC-LEARNED.md §2.1/2.3/2.5 的行为契约（不抄第三方代码）。

const DANGEROUS_BLOCK = /(lava|fire|cactus|magma_block|powder_snow|soul_fire|campfire|sweet_berry_bush)/

/** 这个方块名是否属于会持续伤害玩家的方块。 */
export function isDangerousBlock(name) {
  return DANGEROUS_BLOCK.test(String(name ?? ''))
}

/**
 * idle 与 danger **分开配额**的滑动窗口限流器（MC-LEARNED §2.1：最危险时最安静）。
 * - danger：保命类提醒（低血/掉氧/危险方块/卡住/掉线…）
 * - idle：空闲心跳/提示类
 * 被限流的事件不静默吞掉：计入 stats.suppressed 和 suppressedBy[kind]。
 */
export function createRateLimiter({ now = Date.now, windowMs = 60_000, perWindow = {} } = {}) {
  const limits = {
    danger: Math.max(1, Number(perWindow.danger) || 12),
    idle: Math.max(1, Number(perWindow.idle) || 3),
  }
  const buckets = { danger: [], idle: [] }
  const stats = { fired: 0, suppressed: 0, suppressedBy: {}, lastAt: null, lastSeverity: null }
  return {
    admit(severity = 'idle', kind = severity) {
      const bucket = buckets[severity] ?? buckets.idle
      const limit = limits[severity] ?? limits.idle
      const at = Number(now()) || 0
      while (bucket.length && at - bucket[0] >= windowMs) bucket.shift()
      if (bucket.length >= limit) {
        stats.suppressed += 1
        const key = String(kind)
        stats.suppressedBy[key] = (stats.suppressedBy[key] ?? 0) + 1
        return false
      }
      bucket.push(at)
      stats.fired += 1
      stats.lastAt = at
      stats.lastSeverity = severity
      return true
    },
    stats() {
      return {
        ...stats,
        suppressedBy: { ...stats.suppressedBy },
        limits: { ...limits },
        used: { danger: buckets.danger.length, idle: buckets.idle.length },
        windowMs: Number(windowMs) || 0,
      }
    },
    reset() {
      buckets.danger.length = 0
      buckets.idle.length = 0
      for (const key of Object.keys(stats.suppressedBy)) delete stats.suppressedBy[key]
      stats.fired = 0
      stats.suppressed = 0
    },
  }
}

/**
 * 寻路卡住判据：**看有没有更靠近目标**，不是看有没有动（MC-LEARNED §2.5）。
 * 只有距离在 epsilon 内不再刷新最好成绩，持续 stallMs 才算卡住。
 */
export function createProgressTracker({ now = Date.now, stallMs = 3500, epsilon = 0.5 } = {}) {
  let best = Infinity
  let bestAt = Number(now()) || 0
  let distance = null
  let updates = 0
  return {
    update(next, at = now()) {
      const value = Number(next)
      const t = Number(at) || 0
      if (!Number.isFinite(value)) return { distance: null, best, sinceBestMs: 0, improved: false, stalled: false }
      distance = value
      updates += 1
      const improved = !Number.isFinite(best) || value < best - epsilon
      if (improved) {
        best = value
        bestAt = t
      }
      const sinceBestMs = Math.max(0, t - bestAt)
      return { distance, best, sinceBestMs, improved, stalled: sinceBestMs >= stallMs, updates }
    },
    reset() {
      best = Infinity
      bestAt = Number(now()) || 0
      distance = null
      updates = 0
    },
    snapshot() {
      return { distance, best, bestAt, updates, stallMs }
    },
  }
}

/** 脱困阶梯：repath → jump → backoff → 近距离挖头/挖脚 → 放弃。 */
export const RECOVERY_LADDER = Object.freeze(['repath', 'jump', 'backoff', 'carve', 'giveup'])

/** 第 index 次重试该做什么（越界给 giveup）。 */
export function recoveryStep(index) {
  const i = Math.max(0, Math.trunc(Number(index) || 0))
  return RECOVERY_LADDER[Math.min(i, RECOVERY_LADDER.length - 1)]
}

/** 心跳：只有“安静太久”才推一下，避免刷屏。 */
export function createHeartbeat({ now = Date.now, intervalMs = 60_000 } = {}) {
  let lastAt = Number(now()) || 0
  const interval = Math.max(100, Number(intervalMs) || 60_000)
  return {
    due(at = now()) {
      const t = Number(at) || 0
      if (t - lastAt < interval) return false
      lastAt = t
      return true
    },
    touch(at = now()) { lastAt = Number(at) || 0 },
    stats() { return { intervalMs: interval, lastAt } },
  }
}
