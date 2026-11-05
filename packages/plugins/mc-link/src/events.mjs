// mc-body 事件 → 会话信号：分级、合并、限流。
//
// 这个文件只做"判断"，不碰 HTTP/进程，便于单测。事实源是 mc-body/v1 事件（seq 单调追加）。
//
// 设计来自一次真实生存局的证据（.state/mc-state/mc-link.jsonl，23 分钟）：
//   · health_drop 433 条、death 41 条 —— 每条都当"危险"唤醒她，把她从 20:00 拽到 20:25 只能回"（静默。）"
//   · task_done 只带 kind/id，结果里的 mined/reason 全丢 —— 她说"背包还是空的"，
//     而 body 的 mine 任务在 no-target/no-effect 时也会以 task_done 结束（result.reason）
// 所以这里的原则：
//   · 危险事件（safety/death/spawn_unsafe/reconnect_exhausted）可打断，但有独立配额
//   · 普通事件合并成一条、按窗口限流；同类只报"状态转移"，不逐 tick
//   · 聊天按分钟限额合并；叫到她的名字可以穿过默认 focus（tag: mention）
//   · 被抑制/合并的数量要留痕，不许静默吞掉
//
// 这里**不**决定能不能进模型：focus/time 的门控在 signals 里。我们只标 kind/tags/priority。

/** 记录但永不投递的事件类型：状态以 /v1/status 为准，事件流不重复报。 */
export const QUIET_EVENTS = Object.freeze([
  'health', 'task_progress', 'task_queued', 'task_started',
  'spawn', 'spawn_safe', 'connected', 'login', 'chat_sent', 'stopped',
  'safety_resume', 'emergency', 'respawn',
  // stuck 不单独报：body 紧接着会发 safety_stop('stuck')，两条会重复。
  'stuck',
  // 观测/记账类：body 自己的 watchdog 统计与心跳、寻路/隧道的中间过程，不叫她。
  'heartbeat', 'watchdog', 'watchdog_suppressed', 'task_idempotent_hit', 'ledger_loaded',
  'path_recovered', 'tunnel_clear', 'path_approximate',
])

/** 危险事件：tags 带 alarm，focus 里也放行（MC-CONTRACT §8）。 */
export const ALARM_EVENTS = Object.freeze([
  'safety_stop', 'death', 'spawn_unsafe', 'reconnect_exhausted', 'kicked', 'quarantine',
])

const DEFAULTS = Object.freeze({
  /** 同类普通事件的合并窗口（毫秒）：窗口内的后续事件只计数。 */
  mergeWindow: {
    chat: 0, join: 30_000, leave: 30_000, health_drop: 120_000, disconnected: 10_000,
    'connection-lost': 30_000, reconnecting: 60_000, reconnected: 60_000, body_error: 30_000,
    idle_disconnect: 60_000, resume_required: 120_000, quarantine: 300_000,
    path_stuck: 120_000, dig_error: 60_000, dig_refused: 60_000, dig_fallback: 60_000,
    stuck: 30_000, other: 120_000,
  },
  /** 危险事件的合并窗口：死亡/安全停止在窗口内合并计数，避免死亡循环刷屏。 */
  alarmWindow: { death: 60_000, safety_stop: 30_000, body_error: 30_000, reconnect_exhausted: 120_000 },
  /** 危险通知配额（滑动窗口）：超过就抑制并计数，等她问状态时看得到。 */
  alarmQuota: { max: 10, windowMs: 300_000 },
  /** 5 分钟内死亡 >= 3 次，额外发一次升级提醒（每 5 分钟最多一次）。 */
  deathEscalation: { deaths: 3, windowMs: 300_000, cooldownMs: 300_000 },
  /** 聊天限额：每 60 秒最多这么多条（合并后），超出计数抑制。 */
  chatPerMinute: 6,
  /** 判定"在叫她"的名字（大小写不敏感）。 */
  mentionNames: ['ICL'],
})

const REASON_TEXT = Object.freeze({
  death: '死亡',
  'health-drop': '掉血',
  'low-health': '血量过低',
  'low-oxygen': '缺氧',
  stuck: '卡住',
  'spawn-unsafe': '出生点危险',
  disconnect: '断线',
  quarantine: '连续死亡隔离',
  manual: '手动停止',
  cleanup: '收尾停止',
  timeout: '超时',
})

/** 哪些暂停原因真的紧急到可以带 alarm 标签（focus 的"勿扰"也会放行 alarm）。 */
const SERIOUS_REASONS = Object.freeze(['death', 'quarantine', 'low-health', 'low-oxygen', 'spawn-unsafe', 'health-drop'])

function seriousReason(reason) {
  return SERIOUS_REASONS.includes(String(reason ?? ''))
}

/** 任务结束但没达成时，body 在 error/result.reason 里给的原因，翻成下一步。 */
const TASK_REASON_TEXT = Object.freeze({
  'no-target': '附近没有目标方块（换 block 名或调大 radius）',
  'no-path': '走不过去（mcb_map 看地形，换目标点或先 goto 到开阔处）',
  'dig-failed': '挖不动（可能要更好的工具，或方块被挡住）',
  'no-effect': '挖了但方块没变化（太远或工具不对，换位置/工具）',
  stuck: '卡住了（先 mcb_map/mcb_look 看地形再脱困）',
  timeout: '超时（结果未知，先看背包/位置再决定）',
  'player not found': '找不到玩家（先 mcb_status 看在线玩家）',
  'pathfinder-unavailable': '寻路不可用（改用单点 goto/dig，别走复杂地形）',
  'not connected': '身体当时不在线（先 mcb_status，需要就 mcb_join）',
})

/** 从 error 字符串（如 "mine: no-target"）里认出原因与下一步。 */
function reasonHint(raw) {
  const text = String(raw ?? '')
  const key = Object.keys(TASK_REASON_TEXT).find((name) => text.toLowerCase().includes(name))
  if (!key) return null
  return { key, hint: TASK_REASON_TEXT[key] }
}


const OPS = Object.freeze(['look', 'inventory', 'scan', 'map', 'move', 'goto', 'patrol', 'explore', 'follow', 'mine', 'use', 'dig', 'place', 'equip', 'toss', 'attack', 'wait', 'eat', 'face', 'craft', 'furnace', 'chest', 'trade', 'task', 'cancel', 'resume', 'events', 'tasks', 'say'])
const TASK_KINDS = Object.freeze(['mine', 'goto', 'patrol', 'explore', 'follow', 'routine', 'chat'])

function cut(value, max = 80) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function num(value, fallback = '?') {
  return Number.isFinite(Number(value)) ? String(Math.round(Number(value))) : fallback
}

/** body 有时把 reason 塞成对象（mineflayer kicked 的 reason 是 {text:...}），别显示 "[object Object]"。 */
function valueText(value, fallback = '原因未知', max = 90) {
  if (value == null || value === '') return fallback
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return cut(value, max)
  try { return cut(JSON.stringify(value), max) } catch { return fallback }
}

/** 一行位置；status 里没有就返回 null。 */
export function positionText(status) {
  const p = status?.adapter?.position
  if (!p || !Number.isFinite(Number(p.x))) return null
  return `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`
}

function aliveText(status) {
  const a = status?.adapter ?? {}
  const bits = []
  if (Number.isFinite(Number(a.health))) bits.push(`血${num(a.health)}/20`)
  if (Number.isFinite(Number(a.food))) bits.push(`饱食${num(a.food)}/20`)
  if (Number.isFinite(Number(a.inventoryCount))) bits.push(`背包${num(a.inventoryCount)}件`)
  return bits.join(' · ')
}

function pausedHint(status) {
  if (!status?.paused) return ''
  const reason = REASON_TEXT[status.pausedReason] ?? status.pausedReason ?? '安全原因'
  return `身体已暂停（${reason}），任务已中断；要接着玩就 mcb_do resume，想收尾就 mcb_leave。`
}

function taskLabel(task) {
  if (!task) return '?'
  const id = task.id ?? '?'
  const kind = task.kind ?? '?'
  return `${kind} ${id}`
}

function taskParamsText(task, max = 60) {
  try {
    const params = task?.params ?? {}
    const text = Object.entries(params).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ')
    return cut(text, max)
  } catch { return '' }
}

/** 任务进度只保留人能看的几个字段，别把 body 的 result JSON 整段塞进一行信号。 */
function progressText(result, max = 70) {
  if (!result || typeof result !== 'object') return ''
  const keys = ['mined', 'collected', 'trips', 'eaten', 'done', 'total', 'arrived', 'distance', 'points', 'stuck', 'reason']
  const bits = []
  for (const key of keys) {
    const value = result[key]
    if (value == null) continue
    bits.push(`${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`)
  }
  return bits.length ? `，进度 ${cut(bits.join(' '), max)}` : ''
}

/** 任务事件文本：把 outcome/error/result 翻译成"发生了什么 + 下一步"。
 *
 * mc-body 的 outcome（e6fee4c 起）：
 *   done      真正达成（mine 背包净增达标 / routine reason=duration|target）
 *   failed    mine no-target|no-effect|no-path|dig-failed、routine stuck|no-target；task.error=原因，task.result 留进度
 *   paused    断线时 running 被挂起：不是失败；重连后仍 paused，必须显式 resume（task.resume 带 taskId）
 *   unknown   deadline 超时：结果未知，不能当失败也不能当成功，先复核
 *   cancelled / interrupted
 */
export function taskEventText(type, data = {}, status = null) {
  const task = data.task ?? {}
  const label = taskLabel(task)
  const params = taskParamsText(task)
  const bag = aliveText(status)
  const suffix = bag ? `（现在 ${bag}）` : ''
  const progress = progressText(task.result)
  if (type === 'task_done') {
    const result = task.result ?? {}
    const reason = result?.reason ?? null
    // 旧 body 曾用 task_done + result.reason 表示"没达成"；新 body 改发 task_failed，这里只做兼容。
    if (reason) {
      const why = reasonHint(reason)?.hint ?? valueText(reason, '原因未知', 60)
      return `[MC] 任务结束但没达成：${label}${params ? `（${params}）` : ''} — ${valueText(reason, '原因未知', 40)}：${why}${suffix}`
    }
    if (result?.mined != null) return `[MC] 任务完成：${label} 挖了 ${result.mined} 个${result.block ? ` ${result.block}` : ''}${suffix}`
    if (result?.arrived) return `[MC] 任务完成：${label} 到达目标${result.distance != null ? `（距目标 ${Math.round(result.distance * 10) / 10} 格）` : ''}${suffix}`
    const detail = result && Object.keys(result).length ? ` result=${cut(JSON.stringify(result), 80)}` : ''
    return `[MC] 任务完成：${label}${detail}${suffix}`
  }
  if (type === 'task_failed') {
    const error = valueText(task.error, '原因未知', 60)
    const why = reasonHint(error)?.hint
    return `[MC] 任务失败：${label}${params ? `（${params}）` : ''} — ${error}${why ? `：${why}` : ''}${progress}${suffix}`
  }
  if (type === 'task_unknown') {
    return `[MC] 任务超时，结果未知：${label}${progress} — 动作可能已经生效，不能当成失败。先 mcb_status / mcb_inventory 复核，再决定要不要重下同一个任务。${suffix}`
  }
  if (type === 'task_paused') {
    const why = valueText(data.reason ?? task.pausedReason, '断线', 40)
    return `[MC] 任务暂停（${why}，结果未定）：${label}${progress}；重连后身体仍暂停：先 {"op":"resume"} 解除暂停，再用 {"op":"resume","taskId":"${task.id ?? 't-?'}"} 继续这个任务（不会自动续跑）。`
  }
  if (type === 'task_resumed') return `[MC] 任务继续：${label} ${task.state ?? 'running'}${progress}${suffix}`
  if (type === 'task_interrupted') {
    const why = REASON_TEXT[task.error] ?? valueText(task.error, '安全原因', 60)
    return `[MC] 任务中断：${label} — ${cut(why, 60)}；${status?.paused ? pausedHint(status) : '任务已结束，要续做请重新下任务。'}${suffix}`
  }
  if (type === 'task_cancelled') return `[MC] 任务已取消：${label}${suffix}`
  return `[MC] ${type}：${label}${suffix}`
}

function taskKey(event) {
  return `${event.type}:${event.data?.task?.id ?? event.data?.taskId ?? '?'}`
}

/** 单条事件 → 信号描述；null 表示不投递（仍然会记日志）。 */
function describe(event, status, ctx) {
  const type = String(event?.type ?? '')
  const d = event?.data ?? {}
  const pos = positionText(status)
  switch (type) {
    case 'chat': {
      const who = d.username ?? '?'
      const called = mention(ctx, d)
      return {
        kind: 'content', tags: ['mc', 'chat', who].concat(called ? ['mention'] : []),
        priority: called ? 'mention' : 'content',
        text: `[MC] ${who}：${cut(d.message, 160)}`,
      }
    }
    case 'join':
      return { kind: 'event', tags: ['mc', 'join'], priority: 'notice', merge: 'join', text: `[MC] ${d.username ?? '有人'} 进入游戏` }
    case 'leave':
      return { kind: 'event', tags: ['mc', 'leave'], priority: 'notice', merge: 'leave', text: `[MC] ${d.username ?? '有人'} 离开游戏` }
    case 'death':
      return {
        kind: 'event', tags: ['mc', 'safety', 'alarm'], priority: 'alarm', merge: 'death', alarm: true,
        text: `[MC] 死亡${pos ? `（上次位置 ${pos}）` : ''}；${pausedHint(status) || 'body 会复活，但不会自己接着做任务。'}`,
      }
    case 'health_drop':
      return {
        kind: 'event', tags: ['mc', 'safety'], priority: 'notice', merge: 'health_drop',
        text: `[MC] 掉血：${num(d.from)} → ${num(d.to)}${aliveText(status) ? `（${aliveText(status)}）` : ''}`,
      }
    case 'safety_stop': {
      const why = REASON_TEXT[d.reason] ?? valueText(d.reason, '安全原因', 60)
      const serious = seriousReason(d.reason)
      return {
        kind: 'event',
        tags: ['mc', 'safety'].concat(serious ? ['alarm'] : []),
        priority: serious ? 'alarm' : 'notice',
        merge: 'safety_stop', alarm: serious,
        text: `[MC] 安全停止：${why}；${pausedHint(status)}`,
      }
    }
    case 'spawn_unsafe':
      return {
        kind: 'event', tags: ['mc', 'safety', 'alarm'], priority: 'alarm', alarm: true,
        text: `[MC] 出生点危险（脚下/头顶/下方是岩浆或火）${pos ? ` @ ${pos}` : ''}；身体已暂停，先 resume 前先换位置（mcb_do goto）。`,
      }
    case 'dig_fallback':
      return {
        kind: 'event', tags: ['mc', 'movement'], priority: 'notice', merge: 'dig_fallback',
        text: `[MC] 原目标走不过去，改成就地挖附近的 ${valueText(d.block ?? d.name ?? d.target, '同类方块', 40)}（${valueText(d.reason ?? d.detail, '预检没通过', 60)}）；任务会继续，别再原样重下同一个目标。`,
      }
    case 'path_stuck':
      return {
        kind: 'event', tags: ['mc', 'movement'], priority: 'notice', merge: 'path_stuck',
        text: `[MC] 走不过去${pos ? ` @ ${pos}` : ''}（寻路尝试：${d.attempts ?? '?'} 次，重置 ${d.pathResets ?? '?'}）：body 会尝试绕路/挖通；还不行就 mcb_map 看地形换目标。`,
      }
    case 'dig_refused':
      return {
        kind: 'event', tags: ['mc', 'movement'], priority: 'notice', merge: 'dig_refused',
        text: `[MC] 拒绝挖这个方块：${valueText(d.reason ?? d.block, '危险/禁止方块', 80)}（水/岩浆/基岩这类不挖；换目标）。`,
      }
    case 'dig_error':
      return {
        kind: 'event', tags: ['mc', 'movement'], priority: 'notice', merge: 'dig_error',
        text: `[MC] 挖掘出错：${valueText(d.message ?? d.error, '未知原因', 80)}；换位置或换工具再试。`,
      }
    case 'disconnected':
      return {
        kind: 'event', tags: ['mc', 'connection'], priority: 'notice', merge: 'connection-lost',
        text: `[MC] 连接断开（${valueText(d.reason, '原因未知', 60)}）；body 会自动重连，最多 3 次`,
      }
    case 'offline':
      return {
        kind: 'event', tags: ['mc', 'connection'], priority: 'notice', merge: 'connection-lost',
        text: `[MC] 身体离线：${valueText(d.reason, '原因未知', 80)}${d.willReconnect ? '（会自动重连）' : '（不会自动重连）'}；要接着玩看 mcb_status，然后 mcb_join 或 resume。`,
      }
    case 'reconnecting':
      return {
        kind: 'event', tags: ['mc', 'connection'], priority: 'notice', merge: 'reconnecting',
        text: `[MC] 断线，重连中（第 ${d.attempt ?? '?'} 次，${Math.round((Number(d.delayMs) || 0) / 1000)}s 后）`,
      }
    case 'reconnected':
      return {
        kind: 'event', tags: ['mc', 'connection'], priority: 'notice', merge: 'reconnected',
        text: `[MC] 已重连${pos ? ` @ ${pos}` : ''}；身体仍处于暂停，旧任务不会自动续跑，先 mcb_status 再决定。`,
      }
    case 'resume_required':
      return {
        kind: 'event', tags: ['mc', 'connection'], priority: 'notice', merge: 'resume_required',
        text: `[MC] 已重连但身体仍暂停（${valueText(d.reason, '断线', 40)}）：断线时在跑的任务是 paused，结果未定。先 {"op":"resume"} 解除暂停，再 {"op":"resume","taskId":"..."} 继续那个任务。`,
      }
    case 'reconnect_exhausted':
      return {
        kind: 'event', tags: ['mc', 'safety', 'alarm'], priority: 'alarm', alarm: true, merge: 'reconnect_exhausted',
        text: `[MC] 重连失败（试了 ${d.attempts ?? '?'} 次）：身体现在不在线。看 mcb_status 的进程/错误；服务器开了就 mcb_join 重连，不想玩就 mcb_leave 收尾。`,
      }
    case 'quarantine':
      return {
        kind: 'event', tags: ['mc', 'safety', 'alarm'], priority: 'alarm', alarm: true, merge: 'quarantine',
        text: `[MC] 连续死亡隔离：${Math.round((Number(d.windowMs) || 120_000) / 1000)}s 内死了 ${d.deaths ?? '?'} 次，身体已断开且不会自己恢复。环境致命：要再玩先 mcb_status，然后 mcb_join 换出生点/安全点；不想玩就 mcb_leave 收尾。`,
      }
    case 'body_error':
      return {
        kind: 'event', tags: ['mc', 'issue'], priority: 'notice', merge: 'body_error',
        text: `[MC] 身体报错：${valueText(d.message ?? d.error, '未知错误', 120)}`,
      }
    case 'kicked': {
      const reason = valueText(d.reason, '原因未知', 100)
      const sameName = /duplicate|already|same name|重名|同名/i.test(reason)
      return {
        kind: 'event', tags: ['mc', 'safety', 'alarm'], priority: 'alarm', alarm: true,
        text: sameName
          ? `[MC] 被服务器踢出：${reason}。这通常是同服已有同名 bot/玩家（一个服上同 owner 只留一个 bot，换 username 再 join）。`
          : `[MC] 被服务器踢出：${reason}；body 会尝试重连，别再自动重试同一个动作。`,
      }
    }
    case 'idle_disconnect':
      return {
        kind: 'event', tags: ['mc', 'connection'], priority: 'notice', merge: 'idle_disconnect',
        text: `[MC] 暂停太久，身体已自动断开（${REASON_TEXT[d.reason] ?? valueText(d.reason, '安全原因', 60)}）。要接着玩先 mcb_join，收尾就 mcb_leave。`,
      }
    case 'task_done':
    case 'task_failed':
    case 'task_unknown':
    case 'task_paused':
    case 'task_resumed':
    case 'task_interrupted':
    case 'task_cancelled':
      return { kind: 'event', tags: ['mc', 'task', type], priority: 'notice', text: taskEventText(type, d, status), key: taskKey(event) }
    default:
      return { kind: 'event', tags: ['mc', type || 'event'], priority: 'notice', merge: 'other', text: `[MC] ${type || '事件'}${d && Object.keys(d).length ? `：${cut(JSON.stringify(d), 100)}` : ''}` }
  }
}

function mention(ctx, data) {
  const message = String(data?.message ?? '')
  if (!message) return false
  const names = ctx?.mentionNames?.length ? ctx.mentionNames : DEFAULTS.mentionNames
  return names.some((name) => name && new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(name)}([^\\p{L}\\p{N}_]|$)`, 'iu').test(message))
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 创建事件闸门。一次 poll 的 events 按 seq 顺序喂进来。
 * @returns {{take:(events:any[],{status?:object}={})=>{signals:any[],suppressed:number,quiet:number}, stats:()=>object, reset:()=>void}}
 */
export function createEventGate({ now = () => Date.now(), config = {} } = {}) {
  const cfg = {
    mergeWindow: { ...DEFAULTS.mergeWindow, ...(config.mergeWindow ?? {}) },
    alarmWindow: { ...DEFAULTS.alarmWindow, ...(config.alarmWindow ?? {}) },
    alarmQuota: { ...DEFAULTS.alarmQuota, ...(config.alarmQuota ?? {}) },
    deathEscalation: { ...DEFAULTS.deathEscalation, ...(config.deathEscalation ?? {}) },
    chatPerMinute: Math.max(1, Number(config.chatPerMinute ?? DEFAULTS.chatPerMinute) || DEFAULTS.chatPerMinute),
    mentionNames: Array.isArray(config.mentionNames) ? config.mentionNames.map(String) : [...DEFAULTS.mentionNames],
  }
  const state = {
    merged: new Map(),       // type|key -> { at, count }
    alarmTimes: [],
    chatTimes: [],
    deaths: [],
    lastEscalationAt: null,
    suppressed: new Map(),   // 原因 -> 次数
    counters: { seen: 0, signals: 0, suppressed: 0, quiet: 0, alarm: 0 },
  }

  function bump(reason) {
    state.suppressed.set(reason, (state.suppressed.get(reason) ?? 0) + 1)
    state.counters.suppressed += 1
  }

  function alarmAllowed(at) {
    const { max, windowMs } = cfg.alarmQuota
    state.alarmTimes = state.alarmTimes.filter((t) => at - t < windowMs)
    if (state.alarmTimes.length >= max) return false
    state.alarmTimes.push(at)
    return true
  }

  function chatAllowed(at) {
    state.chatTimes = state.chatTimes.filter((t) => at - t < 60_000)
    if (state.chatTimes.length >= cfg.chatPerMinute) return false
    state.chatTimes.push(at)
    return true
  }

  /**
   * 合并窗口：同类事件在窗口内只保留第一条，后续只计数。
   * @returns {{accept:boolean, count:number}}
   */
  function mergeCheck(kind, key, at, windowMs) {
    const slot = `${kind}|${key}`
    const row = state.merged.get(slot)
    if (row && at - row.at < windowMs) {
      row.count += 1
      return { accept: false, count: row.count }
    }
    state.merged.set(slot, { at, count: 1 })
    return { accept: true, count: 1 }
  }

  function deathEscalation(at) {
    const { deaths, windowMs, cooldownMs } = cfg.deathEscalation
    state.deaths = state.deaths.filter((t) => at - t < windowMs)
    if (state.deaths.length < deaths) return false
    if (state.lastEscalationAt != null && at - state.lastEscalationAt < cooldownMs) return false
    state.lastEscalationAt = at
    return true
  }

  function take(events, { status = null } = {}) {
    const signals = []
    const chats = []
    const atNow = now()
    for (const event of Array.isArray(events) ? events : []) {
      const type = String(event?.type ?? '')
      state.counters.seen += 1
      if (QUIET_EVENTS.includes(type)) { state.counters.quiet += 1; continue }
      const d = describe(event, status, cfg)
      if (!d) { state.counters.quiet += 1; continue }

      // 聊天：一次 poll 的聊天合并成一条信号（一轮最多叫醒一次），并受分钟限额约束。
      if (type === 'chat') {
        if (!chatAllowed(atNow)) { bump('chat-limit'); continue }
        chats.push({ seq: event?.seq ?? null, text: d.text, mention: (d.tags ?? []).includes('mention') })
        continue
      }

      // 死亡：先做一次升级判断（真的在死循环时给一条"换个做法"的提醒）。
      if (type === 'death') {
        state.deaths.push(atNow)
        if (deathEscalation(atNow)) {
          signals.push({
            id: `mc:escalate:death:${atNow}`,
            kind: 'event', tags: ['mc', 'safety', 'alarm'], priority: 'alarm',
            text: `[MC] 危险：${Math.round(cfg.deathEscalation.windowMs / 60_000)} 分钟内死了 ${cfg.deathEscalation.deaths} 次以上。硬拼没意义：先 mcb_do resume，然后 goto 到安全点/挖掩体/等天亮；不想硬撑就 mcb_leave 收尾。`,
          })
        }
      }

      // 合并窗口：危险用 alarmWindow，普通用 mergeWindow。
      const isAlarm = Boolean(d.alarm)
      const windowMs = isAlarm ? (cfg.alarmWindow[d.merge ?? type] ?? 0) : (cfg.mergeWindow[d.merge ?? type] ?? 0)
      if (d.merge && windowMs > 0) {
        const verdict = mergeCheck(isAlarm ? 'alarm' : 'notice', d.key ?? d.merge, atNow, windowMs)
        if (!verdict.accept) { bump(`merge:${d.merge}`); continue }
      }
      if (d.key) {
        const dup = mergeCheck('task', d.key, atNow, 300_000)
        if (!dup.accept) { bump('duplicate-task'); continue }
      }

      if (isAlarm && !alarmAllowed(atNow)) { bump('alarm-quota'); continue }

      const suffix = suppressedSuffix()
      signals.push({
        id: `mc:e:${event?.seq ?? atNow}`,
        kind: d.kind ?? 'event',
        tags: d.tags ?? ['mc'],
        priority: d.priority ?? 'notice',
        text: suffix ? `${d.text}${suffix}` : d.text,
      })
      state.counters.signals += 1
      if (isAlarm) state.counters.alarm += 1
    }
    // 一次 poll 里的聊天合并成一条：一轮最多被叫醒一次，而不是每条一次。
    if (chats.length) {
      const mentionHit = chats.some((row) => row.mention)
      const suffix = chats.length > 1 ? `（这一批共 ${chats.length} 条）` : ''
      signals.push({
        id: `mc:chat:${chats[0].seq ?? atNow}`,
        kind: 'content',
        tags: ['mc', 'chat', 'players'].concat(mentionHit ? ['mention'] : []),
        priority: mentionHit ? 'mention' : 'content',
        text: `${chats.map((row) => row.text).join('\n')}${suffix}`,
      })
      state.counters.signals += 1
    }
    return { signals, suppressed: state.counters.suppressed, quiet: state.counters.quiet }
  }

  /** 被抑制的事件不静默消失：下一条信号末尾附一句，她问状态时也看得到。 */
  function suppressedSuffix() {
    let total = 0
    for (const n of state.suppressed.values()) total += n
    if (!total) return ''
    state.suppressed.clear()
    return `（另有 ${total} 条同类事件已合并/限流）`
  }

  return {
    take,
    reset() {
      state.merged.clear(); state.alarmTimes = []; state.chatTimes = []
      state.deaths = []; state.lastEscalationAt = null; state.suppressed.clear()
    },
    stats: () => ({
      ...state.counters,
      suppressedDetail: Object.fromEntries(state.suppressed),
      mergeSlots: state.merged.size,
    }),
  }
}

export { OPS, TASK_KINDS, REASON_TEXT, TASK_REASON_TEXT }

/** 简短描述一条 body 事件，用于 mcb_do 的 events 查询（台账视角，不省略 quiet 事件）。 */
export function eventLine(event, status = null) {
  const type = String(event?.type ?? '?')
  const d = event?.data ?? {}
  const head = `#${event?.seq ?? '?'} ${type}`
  const detail = (() => {
    switch (type) {
      case 'health': return `血 ${num(d.health)}/20 饱食 ${num(d.food)}/20`
      case 'task_progress': return `${d.taskId ?? '?'} ${cut(JSON.stringify(d.progress ?? {}), 70)}`
      case 'task_queued':
      case 'task_started':
      case 'task_done':
      case 'task_failed':
      case 'task_unknown':
      case 'task_paused':
      case 'task_resumed':
      case 'task_interrupted':
      case 'task_cancelled': return taskEventText(type, d, status).replace(/^\[MC\]\s*/, '')
      case 'spawn':
      case 'spawn_safe': return d.position ? `${Math.round(d.position.x)},${Math.round(d.position.y)},${Math.round(d.position.z)}` : ''
      case 'chat': return `${d.username ?? '?'}：${cut(d.message, 100)}`
      case 'join':
      case 'leave': return String(d.username ?? '')
      case 'chat_sent': return cut(d.text, 100)
      case 'connected':
      case 'stopped': return ''
      case 'safety_resume': return '已恢复'
      case 'emergency': return `保命动作：${d.reason ?? ''}`
      case 'safety_stop': return `暂停：${REASON_TEXT[d.reason] ?? valueText(d.reason, '安全原因', 60)}`
      default: {
        const described = describe(event, status, { mentionNames: DEFAULTS.mentionNames })
        return described ? described.text.replace(/^\[MC\]\s*/, '') : cut(JSON.stringify(d), 90)
      }
    }
  })()
  return detail ? `${head} · ${detail}` : head
}

