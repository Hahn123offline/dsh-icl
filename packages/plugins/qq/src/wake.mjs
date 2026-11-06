// QQ 唤醒矩阵（规划层）：只决定"何时值得发一个提醒信号"，不投递、不碰 delivery/time/focus。
//
// 三类提示严格区分（模型不能把它们当成新用户消息）：
//   · replyCheck：刚回过一条私聊后，隔一会儿检查是否有新回复；
//   · proactive：私聊安静很久后的主动机会（默认关闭）；
//   · nudge：账本里还有未处理消息的积压提醒（按批，不重复）。
//
// 去重/限额都在这里：同一 outbound 只安排一次 replyCheck；`noteInbound` 会取消未到的 check；
// nudge 只在未读数变化或冷却到期后再次提醒；proactive 有冷却与概率；总数受 maxWakePerHour 限制。
// 生成的是 signal 候选（{kind, activity, text, tags}），由 index 走 ctx.signals.offer，time 决定投递。

export const WAKE_DEFAULTS = Object.freeze({
  replyCheckEnabled: true,
  replyCheckDelayMs: 30_000,
  proactiveEnabled: false,
  proactiveMinMs: 30 * 60_000,
  proactiveMaxMs: 90 * 60_000,
  proactiveIdleMs: 15 * 60_000,
  proactiveProbability: 0.3,
  proactiveCooldownMs: 30 * 60_000,
  nudgeEnabled: true,
  nudgeSoftMs: 10 * 60_000,
  nudgeCooldownMs: 10 * 60_000,
  nudgeMaxPerHour: 6,
  maxWakePerHour: 12,
})

function num(value, fallback, { min = 0, max = Number.POSITIVE_INFINITY } = {}) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback
}

export function normalizeWakeConfig(raw = {}) {
  const cfg = { ...WAKE_DEFAULTS }
  for (const key of ['replyCheckDelayMs', 'proactiveMinMs', 'proactiveMaxMs', 'proactiveIdleMs', 'proactiveCooldownMs', 'nudgeSoftMs', 'nudgeCooldownMs']) {
    cfg[key] = num(raw[key], cfg[key], { min: 1000 })
  }
  for (const key of ['nudgeMaxPerHour', 'maxWakePerHour']) cfg[key] = Math.floor(num(raw[key], cfg[key], { max: 1000 }))
  cfg.proactiveProbability = num(raw.proactiveProbability, cfg.proactiveProbability, { max: 1 })
  for (const key of ['replyCheckEnabled', 'proactiveEnabled', 'nudgeEnabled']) {
    if (raw[key] !== undefined) cfg[key] = raw[key] === true
  }
  if (cfg.proactiveMaxMs < cfg.proactiveMinMs) cfg.proactiveMaxMs = cfg.proactiveMinMs
  return cfg
}

/** 创建规划器。unreadCount(activity) 返回账本里"水位之后"的条数（0 表示没有积压）。 */
export function createWakePlanner({ now = () => Date.now(), random = Math.random, config = {}, unreadCount = () => 0 } = {}) {
  const cfg = normalizeWakeConfig(config)
  const rows = new Map()
  const wakeTimes = []
  const nudgeTimes = []
  let seq = 0
  const state = { emitted: 0, skippedBudget: 0, emittedByKind: { replyCheck: 0, proactive: 0, nudge: 0 } }

  function row(activity) {
    const key = String(activity)
    let value = rows.get(key)
    if (!value) {
      value = {
        activity: key,
        lastInAt: 0,
        lastOutAt: 0,
        replyCheckDueAt: 0,
        replyCheckFor: 0,
        outSeq: 0,
        proactiveDueAt: 0,
        lastProactiveAt: 0,
        lastNudgeAt: 0,
        nudgeUnread: -1,
      }
      rows.set(key, value)
    }
    return value
  }

  function pruneBudget(at) {
    const cutoff = at - 3600_000
    while (wakeTimes.length && wakeTimes[0] < cutoff) wakeTimes.shift()
    while (nudgeTimes.length && nudgeTimes[0] < cutoff) nudgeTimes.shift()
  }

  function budgetLeft(at) {
    pruneBudget(at)
    return wakeTimes.length < Math.max(1, cfg.maxWakePerHour)
  }

  function pushWake(activity, kind, at, extra = {}) {
    if (!budgetLeft(at)) { state.skippedBudget += 1; return null }
    wakeTimes.push(at)
    state.emitted += 1
    state.emittedByKind[kind] = (state.emittedByKind[kind] ?? 0) + 1
    seq += 1
    return {
      id: `qq:wake:${kind}:${activity}:${seq}`,
      kind,
      activity,
      at,
      tags: ['qq', 'private', 'wake', kind],
      ...extra,
    }
  }

  function scheduleProactive(activityRow, at) {
    if (!cfg.proactiveEnabled) return 0
    const span = Math.max(0, cfg.proactiveMaxMs - cfg.proactiveMinMs)
    return at + Math.round(cfg.proactiveMinMs + span * (Number(random()) || 0))
  }

  function noteInbound(activity, { at = now() } = {}) {
    const r = row(activity)
    r.lastInAt = at
    // 新消息到达：还没发出的"回复检查"作废（避免检查提示和真实新消息重复叫醒）
    r.replyCheckDueAt = 0
    r.replyCheckFor = 0
    r.proactiveDueAt = scheduleProactive(r, at)
    return { activity: r.activity, replyCheckDueAt: r.replyCheckDueAt }
  }

  function noteOutbound(activity, { at = now(), replyToMessageId = null } = {}) {
    const r = row(activity)
    r.lastOutAt = at
    r.outSeq += 1
    if (cfg.replyCheckEnabled) {
      r.replyCheckFor = r.outSeq
      r.replyCheckDueAt = at + cfg.replyCheckDelayMs
    }
    r.proactiveDueAt = scheduleProactive(r, at)
    return { activity: r.activity, replyCheckDueAt: r.replyCheckDueAt, replyToMessageId }
  }

  function poll({ at = now() } = {}) {
    const out = []
    for (const r of rows.values()) {
      // 1) 回复检查：一次 outbound 最多一次；新 inbound 已在 noteInbound 里取消
      if (r.replyCheckDueAt > 0 && at >= r.replyCheckDueAt) {
        r.replyCheckDueAt = 0
        r.replyCheckFor = 0
        const emission = pushWake(r.activity, 'replyCheck', at, { reason: 'reply-check' })
        if (emission) out.push(emission)
      }
      // 2) 积压提醒：未读 >0、安静够久、未读变化或冷却到期才提醒
      if (cfg.nudgeEnabled) {
        let unread = 0
        try { unread = Math.max(0, Number(unreadCount(r.activity)) || 0) } catch { unread = 0 }
        if (unread <= 0) {
          r.nudgeUnread = 0
        } else if (at - r.lastInAt >= cfg.nudgeSoftMs) {
          const changed = r.nudgeUnread !== unread
          const cooled = r.lastNudgeAt === 0 || at - r.lastNudgeAt >= cfg.nudgeCooldownMs
          pruneBudget(at)
          const nudgeOk = nudgeTimes.length < cfg.nudgeMaxPerHour
          if ((changed || cooled) && nudgeOk) {
            const emission = pushWake(r.activity, 'nudge', at, { reason: 'nudge', unread })
            if (emission) { r.lastNudgeAt = at; r.nudgeUnread = unread; nudgeTimes.push(at); out.push(emission) }
          }
        }
      }
      // 3) 主动机会：默认关闭；概率+冷却+空闲门槛
      if (cfg.proactiveEnabled && r.proactiveDueAt > 0 && at >= r.proactiveDueAt) {
        const idle = at - Math.max(r.lastInAt, r.lastOutAt)
        const cooled = r.lastProactiveAt === 0 || at - r.lastProactiveAt >= cfg.proactiveCooldownMs
        const n = Number(random()) || 0
        if (idle >= cfg.proactiveIdleMs && cooled && n < cfg.proactiveProbability) {
          const emission = pushWake(r.activity, 'proactive', at, { reason: 'proactive', idleMs: idle })
          if (emission) { r.lastProactiveAt = at; out.push(emission) }
        }
        r.proactiveDueAt = scheduleProactive(r, at)
      }
    }
    return out
  }

  return {
    config: () => ({ ...cfg }),
    noteInbound,
    noteOutbound,
    poll,
    status() {
      return {
        config: { ...cfg },
        activities: rows.size,
        emitted: state.emitted,
        skippedBudget: state.skippedBudget,
        emittedByKind: { ...state.emittedByKind },
        wakeLastHour: (() => { const at = now(); pruneBudget(at); return wakeTimes.length })(),
      }
    },
    reset() { rows.clear(); wakeTimes.length = 0; nudgeTimes.length = 0; state.emitted = 0; state.skippedBudget = 0; state.emittedByKind = { replyCheck: 0, proactive: 0, nudge: 0 } },
  }
}
