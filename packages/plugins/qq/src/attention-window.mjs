// 旧 focus-core 的 per-activity 自适应窗口（见 docs/QQ-GROUP-DESIGN.md §3.1）。
// 纯函数：不读时间、不做 IO，只回答"这一批现在给，还是再攒一会儿"。
//
// 规则（旧实现 2026-10-28 定稿）：
//   · 5 秒窗口内该活动 ≤5 条 → 立即；
//   · 超过 → 延迟 5s × ceil((rate-5)/5)；
//   · hard limits：ambient 10 分钟/20 条，pierce 60 秒/5 条。
// 群聊只在活动足够安静时快速进入；消息刷屏时先攒批，不在每条消息上反复叫醒。

export const RATE_WINDOW_MS = 5_000
export const RATE_FAST = 5

export const LIMITS = Object.freeze({
  ambient: { maxWaitMs: 10 * 60_000, maxCount: 20 },
  pierce: { maxWaitMs: 60_000, maxCount: 5 },
})

export function windowDelayMs(rate, channel = 'ambient') {
  const r = Math.max(0, Math.floor(Number(rate) || 0))
  if (r <= RATE_FAST) return 0
  const limits = LIMITS[channel] ?? LIMITS.ambient
  const steps = Math.ceil((r - RATE_FAST) / RATE_FAST)
  return Math.min(limits.maxWaitMs, RATE_WINDOW_MS * steps)
}

export function shouldFlush({ count, rate = 0, firstAt = 0, now = Date.now(), channel = 'ambient', force = false } = {}) {
  if (!count || count <= 0) return false
  if (force) return true
  const limits = LIMITS[channel] ?? LIMITS.ambient
  if (count >= limits.maxCount) return true
  if (now - Number(firstAt) >= limits.maxWaitMs) return true
  const delay = windowDelayMs(rate, channel)
  if (delay === 0) return true
  return now - Number(firstAt) >= delay
}
