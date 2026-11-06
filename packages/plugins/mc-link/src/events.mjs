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
  'path_recovered', 'tunnel_clear', 'path_approximate', 'auto_eat', 'dig_fallback', 'craft_no_product',
  // 宏/战斗的中间信息事件：macro_step/macro_blocked/combat_done 等在 body 台账里可查，不逐条叫醒；
  // 真正的结果走 task_done/task_failed/task_progress（progress 已限频）。
  'macro_step', 'macro_blocked', 'macro_done', 'macro_tool_auto', 'auto_tool', 'needs_tool', 'combat_done',
  // 盖房的中间事件：结构不完整/盖完由 task_failed/task_done 统一说；home_set 单独通知（家是长期事实）。
  'shelter_incomplete', 'shelter_done',
])

/**
 * 危险事件：tags 带 alarm，focus 里也放行（MC-CONTRACT §8）。
 * 另外 body 任意事件带 `data.priority:'alarm'` 或 `data.pierce:true` 时（watchdog 六类/reflex/emergency），
 * take() 会强制标成 alarm 并透传 meta.priority='alarm' + meta.pierce=true —— 不因 pause/quiet 被吞。
 */
export const ALARM_EVENTS = Object.freeze([
  'safety_stop', 'death', 'spawn_unsafe', 'reconnect_exhausted', 'kicked', 'quarantine',
])

const DEFAULTS = Object.freeze({
  /** 同类普通事件的合并窗口（毫秒）：窗口内的后续事件只计数。 */
  mergeWindow: {
    chat: 0, join: 30_000, leave: 30_000, health_drop: 120_000, disconnected: 10_000,
    'connection-lost': 30_000, reconnecting: 60_000, reconnected: 60_000, body_error: 30_000,
    idle_disconnect: 60_000, resume_required: 120_000, quarantine: 300_000,
    path_stuck: 120_000, dig_error: 60_000, dig_refused: 60_000, auto_defense: 60_000, combat_abort: 30_000, home_set: 300_000,
    task_cancelled_for_defense: 60_000,
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
  'user-stop': '你让它停的（mcb_stop，可随时 resume）',
  emergency: '紧急规避',
  threat: '有威胁（自动躲避/防御触发）',
})

/** 哪些暂停原因真的紧急到可以带 alarm 标签（focus 的"勿扰"也会放行 alarm）。 */
const SERIOUS_REASONS = Object.freeze(['death', 'quarantine', 'low-health', 'low-oxygen', 'spawn-unsafe', 'health-drop'])

function seriousReason(reason) {
  return SERIOUS_REASONS.includes(String(reason ?? ''))
}

/** 任务结束但没达成时，body 在 error/result.reason 里给的原因，翻成下一步。 */
const TASK_REASON_TEXT = Object.freeze({
  'no-target': '附近没有目标方块/资源（换 block/item 名或调大 radius）',
  'collect: no-resources': '附近资源枯竭（扫过范围已没有目标）：先 explore 换个区域/换 item，别原地重试',
  'no-path': '走不过去（mcb_map 看地形，换目标点或先 goto 到开阔处）',
  'dig-failed': '挖不动（可能要更好的工具，或方块被挡住）',
  'no-effect': '挖了但方块没变化（太远或工具不对，换位置/工具）',
  stuck: '卡住了（先 mcb_map/mcb_look 看地形再脱困）',
  timeout: '超时（结果未知，先看背包/位置再决定）',
  'needs-tool': '工具不对/不够好（body 已停：先 mcb_inventory 看材料，做/换对应工具再下宏）',
  'inventory-full': '背包满了（先存箱子/丢点东西，再继续收集）',
  'needs-material': '材料不够（先补材料：砍树/挖石/合成，再下这个宏）',
  blocked: '前方是水/岩浆/基岩（换方向或绕开，别硬挖）',
  unsafe: '安全护栏拒绝（会造成危险：换位置/换做法）',
  partial: '只完成了一部分（有进展没达标：看 progress/背包再决定续做还是换目标）',
  'unsupported task': '这个宏还在 beta/未开放（先看 mcb_help play 或 mcb_help collect/tunnel；bridge/build/shelter/sort/deposit/farm 是 beta）',
  'farm: no-water': '附近没有水：找水边/引水（水离耕地 4 格内才能种）',
  'farm: no-site': '水边没有可开垦的土/草方块（要离水 4 格内、上方是空气）',
  'shelter: no-site': '这里放不下小屋（地形/空间不够）：先清平/换位置，或先挖平再重跑',
  'shelter: needs-material': '盖房材料不够：按回执缺数先补方块（缺多少见 message），别硬跑',
  'shelter: incomplete': '结构不完整：按 verify.summary 补缺的墙/屋顶/门洞，别直接重跑整间',
  'shelter: entry-blocked': '结构 OK 但进不去：先清零格门洞/垫平门外通路，或换 doorSide 重试',
  unsupported: 'body 不支持这个参数组合（例如 tunnel 的向上 stairs）：换方向/换做法',
  'player not found': '找不到玩家（先 mcb_status 看在线玩家）',
  'pathfinder-unavailable': '寻路不可用（改用单点 goto/dig，别走复杂地形）',
  'not connected': '身体当时不在线（先 mcb_status，需要就 mcb_join）',
  'combat: low-health': '战斗低血中断（已自动躲避）：先吃/躲/垫高，或改用 mcb_combat {mode:"flee"}；血回上去再打',
  'combat: creeper-near': '苦力怕近身（已自动躲避）：先跑/垫高，别贴脸打',
  'combat: too-many': '敌人太多（已自动躲避）：改用 flee 或 guard，别硬刚',
  'combat: no-threat': '附近没有威胁了：不用再打',
})

/** 从 error 字符串（如 "mine: no-target"）里认出原因与下一步；多个 key 命中时选最长的（更具体）。 */
function reasonHint(raw) {
  const text = String(raw ?? '').toLowerCase()
  const key = Object.keys(TASK_REASON_TEXT)
    .filter((name) => text.includes(name))
    .sort((a, b) => b.length - a.length)[0]
  if (!key) return null
  return { key, hint: TASK_REASON_TEXT[key] }
}


const OPS = Object.freeze(['look', 'inventory', 'scan', 'map', 'move', 'goto', 'patrol', 'explore', 'follow', 'mine', 'use', 'dig', 'place', 'equip', 'toss', 'pickup', 'attack', 'wait', 'eat', 'face', 'sleep', 'craft', 'furnace', 'chest', 'trade', 'task', 'cancel', 'resume', 'events', 'tasks', 'say'])
/** 任务类型：原语 kind + 宏 kind（body KINDS 的超集；宏契约见 docs/MC-MACRO.md）。 */
const TASK_KINDS = Object.freeze(['mine', 'goto', 'patrol', 'explore', 'follow', 'routine', 'chat', 'collect', 'tunnel', 'bridge', 'build', 'sort', 'deposit', 'shelter', 'farm', 'hunt', 'defend', 'flee', 'guard'])
/** 宏 kind（重复劳动下沉到 body 脚本，模型只下一条指令/查进度/打断）。 */
const MACRO_KINDS = Object.freeze(['collect', 'tunnel', 'bridge', 'build', 'sort', 'deposit', 'shelter', 'farm'])

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

/** 事件时刻的坐标（优先事件 data 里的 position/lastDeath.position），避免用格式化时的实时位置。 */
function eventPositionText(data, fallback = null) {
  const p = data?.position ?? data?.lastDeath?.position ?? data?.at
  if (!p || !Number.isFinite(Number(p.x)) || !Number.isFinite(Number(p.y)) || !Number.isFinite(Number(p.z))) return fallback
  return `${Math.round(Number(p.x))},${Math.round(Number(p.y))},${Math.round(Number(p.z))}`
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
  const keys = ['mined', 'collected', 'net', 'requested', 'trips', 'eaten', 'done', 'total', 'direction', 'torches', 'arrived', 'distance', 'points', 'layer', 'totalLayers', 'placed', 'skipped', 'moved', 'kept', 'tilled', 'planted', 'stuck', 'reason']
  const bits = []
  for (const key of keys) {
    const value = result[key]
    if (value == null) continue
    bits.push(`${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`)
  }
  return bits.length ? `，进度 ${cut(bits.join(' '), max)}` : ''
}

/**
 * shelter 材料诊断（needs-material）：needed/have/deficit + 可用替代 + body suggestion。
 * suggestion 是 body 直接写给模型的（有替代材料会让她改 material，否则 dig 补 N 块）。
 */
function shelterMaterialDetail(result) {
  if (!result || typeof result !== 'object') return ''
  const bits = []
  if (result.material) bits.push(`材料 ${result.material}`)
  if (result.needed != null) bits.push(`需要 ${result.needed}`)
  if (result.have != null) bits.push(`现有 ${result.have}`)
  if (result.deficit != null) bits.push(`缺 ${result.deficit}`)
  const alts = Array.isArray(result.alternatives) ? result.alternatives.filter((row) => row?.enough).slice(0, 3) : []
  if (alts.length) bits.push(`可用替代：${alts.map((row) => `${row.material}×${row.have}`).join('、')}`)
  if (result.suggestion) bits.push(String(result.suggestion).slice(0, 220))
  return bits.join('；')
}

/**
 * shelter 的结构验收摘要（给她看"缺哪面/几块"）：summary + walls.missingFaces + roof/door/interior 缺数。
 * body 的 failures[] 是建造过程调试明细，不在这里展示。
 */
function shelterVerifyDetail(verify) {
  if (!verify || typeof verify !== 'object') return ''
  const summary = String(verify.summary ?? '').slice(0, 120)
  const bits = []
  if (summary) bits.push(summary)
  const faces = Array.isArray(verify.walls?.missingFaces) ? verify.walls.missingFaces : []
  if (faces.length) bits.push(`缺墙面：${faces.slice(0, 4).map((face) => `${face.face ?? '?'} 缺 ${face.missing ?? '?'}${face.total != null ? `/${face.total}` : ''}`).join('、')}`)
  if (Number(verify.roof?.missing) > 0 && !/屋顶/.test(summary)) bits.push(`屋顶缺 ${verify.roof.missing} 块`)
  if (Number(verify.door?.missing) > 0 && !/门洞/.test(summary)) bits.push(`门洞缺 ${verify.door.missing}`)
  if (Number(verify.interior?.blocked) > 0 && !/室内/.test(summary)) bits.push(`室内被占 ${verify.interior.blocked} 格`)
  if (verify.entry && verify.entry.ok === false && !/进不去|入口/.test(summary)) bits.push('入口不通')
  return bits.filter(Boolean).join('；')
}

/** 宏成功的一句话：collect 说收集了多少、tunnel 说通道尺寸与火把，其余给关键进度。 */
function macroDoneText(task, result) {
  const label = taskLabel(task)
  if (task.kind === 'collect') {
    const item = result?.item ?? result?.block ?? '资源'
    const got = result?.net ?? result?.collected ?? result?.mined
    const want = result?.requested
    return `[MC] 宏完成：collect ${label} 收集到 ${got ?? '?'} 个 ${item}${want != null ? `（目标 ${want}）` : ''}`
  }
  if (task.kind === 'tunnel') {
    return `[MC] 宏完成：tunnel ${label} 往${result?.direction ?? '?'}挖了 ${result?.done ?? '?'} 格${result?.height ? `（高 ${result.height}）` : ''}${result?.stairs ? '（向下阶梯）' : ''}${result?.torches != null ? `，放火把 ${result.torches}` : ''}`
  }
  if (task.kind === 'bridge') {
    return `[MC] 宏完成：bridge ${label} 往${result?.direction ?? '?'}铺了 ${result?.done ?? result?.placed ?? '?'} 格${result?.width ? `（宽 ${result.width}）` : ''}${result?.materialsUsed != null ? `，用材料 ${result.materialsUsed}` : ''}`
  }
  if (task.kind === 'build') {
    return `[MC] 宏完成：build ${label} 放了 ${result?.placed ?? '?'} 块，跳过 ${result?.skipped ?? 0}${result?.totalLayers != null ? `（${result?.layer ?? '?'}/${result.totalLayers} 层）` : ''}`
  }
  if (task.kind === 'shelter') {
    const verify = result?.verify ?? null
    const home = result?.home ?? null
    if (verify) {
      return `[MC] 宏完成：shelter ${label} 结构完整（${verify.summary ?? '四面墙+屋顶+门洞+入口'}）${result?.entryOk ? '；门口能进出' : ''}${home?.center ? `；家在 ${positionText({ adapter: { position: home.center } })}（门在 ${home.doorSide ?? '?'}）` : ''}；夜里/下雨可回家躲`
    }
    return `[MC] 宏完成：shelter ${label} 墙 ${result?.walls ?? '?'}、顶 ${result?.roof ?? '?'}、门 ${result?.door ?? '?'}`
  }
  if (task.kind === 'sort' || task.kind === 'deposit') {
    const action = result?.action === 'take' ? '取出' : '存入'
    return `[MC] 宏完成：${task.kind} ${label} ${action} ${result?.moved ?? '?'} 件${result?.kept != null ? `，保留 ${result.kept}` : ''}`
  }
  if (task.kind === 'farm') {
    return `[MC] 宏完成：farm ${label} 开垦 ${result?.tilled ?? '?'}、播种 ${result?.planted ?? '?'} 格${result?.crop ? ` ${result.crop}` : ''}`
  }
  if (result && Object.keys(result).length) return `[MC] 宏完成：${label} ${cut(JSON.stringify(result), 90)}`
  return `[MC] 宏完成：${label}`
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
    // 宏（collect/tunnel/bridge/build/shelter/sort/deposit/farm）有各自的 result 形状，单独说人话。
    if (MACRO_KINDS.includes(String(task.kind))) return `${macroDoneText(task, result)}${suffix}`
    const reason = result?.reason ?? null
    // 新 body 用 reason 标记"怎么达成的"（net-target/duration/target），不是失败；
    // 旧 body 曾用 task_done + result.reason(no-target 等) 表示没达成，这里只对旧失败原因做兼容。
    // 契约（mc-body）：task_done.result.reason 只会出现 net-target|duration|target；失败原因只在 task_failed.task.error。
    const SUCCESS_REASONS = new Set(['net-target', 'duration', 'target', 'target-count', 'completed', 'done'])
    const successReason = reason == null || SUCCESS_REASONS.has(String(reason))
    if (!successReason) {
      const why = reasonHint(reason)?.hint ?? valueText(reason, '原因未知', 60)
      return `[MC] 任务结束但没达成：${label}${params ? `（${params}）` : ''} — ${valueText(reason, '原因未知', 40)}：${why}${suffix}`
    }
    const net = result?.net ?? result?.mined
    if (net != null) {
      const what = result.item ?? result.block
      // mine 用"挖了 N 个"（她/测试都习惯这个说法），其它任务用"净增 N"。
      if (task.kind === 'mine') return `[MC] 任务完成：${label} 挖了 ${net} 个${what ? ` ${what}` : ''}${result.requested != null && result.requested !== net ? `（目标 ${result.requested}）` : ''}${suffix}`
      return `[MC] 任务完成：${label} 净增 ${net}${what ? ` ${what}` : ''}${suffix}`
   }
    if (result?.arrived) return `[MC] 任务完成：${label} 到达目标${result.distance != null ? `（距目标 ${Math.round(result.distance * 10) / 10} 格）` : ''}${suffix}`
    const detail = result && Object.keys(result).length ? ` result=${cut(JSON.stringify(result), 80)}` : ''
    return `[MC] 任务完成：${label}${detail}${suffix}`
  }
  if (type === 'task_failed') {
    const error = valueText(task.error, '原因未知', 60)
    const why = reasonHint(error)?.hint
    // shelter 失败时把 body 的结构验收摘要/缺哪面直接给她（failures[] 是建造调试明细，不展示）。
    const verifyText = task.kind === 'shelter' || task.result?.verify ? shelterVerifyDetail(task.result?.verify) : ''
    // needs-material：带上 needed/have/deficit/可用替代 + body suggestion（有替代材料就让改 material）。
    const materialText = /needs-material/.test(error) || (task.kind === 'shelter' && task.result?.deficit != null)
      ? shelterMaterialDetail(task.result)
      : ''
    return `[MC] 任务失败：${label}${params ? `（${params}）` : ''} — ${error}${why ? `：${why}` : ''}${materialText ? `；材料诊断：${materialText}` : ''}${verifyText ? `；结构验收：${verifyText}` : ''}${progress}${suffix}`
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

/**
 * 报警行长度上限（≤80 字/条，含"另有 N 条已合并"这类后缀）：
 * 睡眠/醒来简报会整行展示，太长会挤掉真正重要的内容。
 */
const ALARM_LINE_MAX = 80
function alarmLine(text, suffix = '') {
  const chars = [...String(text ?? '')]
  const room = Math.max(30, ALARM_LINE_MAX - [...suffix].length)
  if (chars.length <= room) return `${text}${suffix}`
  return `${chars.slice(0, Math.max(1, room - 1)).join('')}…${suffix}`
}

/** 单条事件 → 信号描述；null 表示不投递（仍然会记日志）。 */function describe(event, status, ctx) {
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
    case 'death': {
      // 用死亡时刻的事实（位置/当时的背包件数），不要混入格式化时的实时状态。
      const dropped = d.lastDeath?.inventoryCount ?? d.inventoryCount
      const deathPos = eventPositionText(d, pos)
      return {
        kind: 'event', tags: ['mc', 'safety', 'alarm'], priority: 'alarm', merge: 'death', alarm: true,
        text: `[MC] 死亡${deathPos ? ` @ ${deathPos}` : ''}${dropped != null ? `（当时背包 ${num(dropped)} 件）` : ''}；body 会复活，但旧任务不会自己续跑，先 mcb_status 看位置。`,
      }
    }
    case 'health_drop': {
      // 事件时刻的血量：from/to 就是那一下的；括号里不再放"当前状态"（合并/限流后会不同步）。
      const hasValues = d.from != null || d.to != null
      const detail = [
        d.to != null ? `事件时 ${num(d.to)}/20` : null,
        d.drop != null ? `一次掉 ${num(d.drop)}` : null,
      ].filter(Boolean).join('，')
      return {
        kind: 'event', tags: ['mc', 'safety'], priority: 'notice', merge: 'health_drop',
        text: `[MC] 掉血：${hasValues ? `${num(d.from)} → ${num(d.to)}` : '血量下降'}${detail ? `（${detail}）` : '（事件数据没带前后血量）'}`,
      }
    }
    case 'safety_stop': {
      const why = REASON_TEXT[d.reason] ?? valueText(d.reason, '安全原因', 60)
      const serious = seriousReason(d.reason)
      const extra = d.event && d.event !== d.reason ? `（叠加：${REASON_TEXT[d.event] ?? valueText(d.event, '更严重事件', 30)}）` : ''
      return {
        kind: 'event',
        tags: ['mc', 'safety'].concat(serious ? ['alarm'] : []),
        priority: serious ? 'alarm' : 'notice',
        merge: 'safety_stop', alarm: serious,
        text: `[MC] 安全停止：${why}${extra}${d.repeated ? '（重复报警）' : ''}；任务已中断（停任务≠离开世界）；resume 继续，mcb_leave 离开。`,
      }
    }
    case 'home_set': {
      // 盖房成功：body 记住 home（持久化）。夜里/下雨/被追时回 home.center 躲。
      const home = d.home ?? {}
      return {
        kind: 'event', tags: ['mc', 'shelter'], priority: 'notice', merge: 'home_set',
        text: `[MC] 家已设：${home.center ? positionText({ adapter: { position: home.center } }) : '?'}（${home.size ?? '?'}×${home.size ?? '?'}${home.doorSide ? `，门在 ${home.doorSide}` : ''}${home.doorPlaced ? `，已装门 ${home.doorPlaced}` : ''}）；夜里/下雨/被追可回 home.center 躲，mcb_status 可看家。`,
      }
    }
    case 'auto_defense': {
      // body 自己在危险时做的有界保命动作（躲避/垫高/退开）：说清"做了什么、为什么"，别让她重复跑一遍。
      const action = d.action === 'error' ? '躲避失败' : d.action === 'offline' ? '身体离线没法躲' : d.action === 'no-op' ? '没有可执行的规避动作' : '已自动躲避'
      const why = REASON_TEXT[d.reason] ?? valueText(d.reason ?? d.assessment?.reason, '威胁', 40)
      // 自动躲避会取消当前非战斗任务（15s hold）：说清"是躲避打断的，不是任务自己失败"。
      const cancelled = d.taskCancelled
        ? `；已自动躲避并取消当前任务：${valueText(d.taskKind ?? d.taskId, '任务', 30)}（${valueText(d.taskCancelReason ?? 'auto-defense: threat', '威胁', 40)}）——这是自动掩护打断，不是任务自己失败；危险过去可重下`
        : ''
      return {
        kind: 'event', tags: ['mc', 'safety'], priority: 'notice', merge: 'auto_defense',
        text: `[MC] 自动躲避：${why} → ${action}（${Math.round(Number(d.durationMs) || 0)}ms${d.timedOut ? '，超时' : ''}${d.error ? `，错误：${valueText(d.error, '', 60)}` : ''}）${cancelled}；body 自己做的保命动作，不用重复跑。`,
      }
    }
    case 'task_cancelled_for_defense': {
      const threats = Array.isArray(d.threats) && d.threats.length ? `（${d.threats.slice(0, 3).join('、')}）` : ''
      return {
        kind: 'event', tags: ['mc', 'safety'], priority: 'notice', merge: 'task_cancelled_for_defense',
        text: `[MC] 任务被自动躲避取消：${valueText(d.kind ?? d.taskId, '任务', 30)}${d.taskId ? `（${d.taskId}）` : ''} — ${valueText(d.reason ?? 'auto-defense: threat', '威胁', 40)}${threats}；不是任务失败，危险过去后可重下。`,
      }
    }
    case 'combat_abort': {
      const why = valueText(d.reason ?? d.assessment?.reason, '未知', 40)
      const hostiles = Array.isArray(d.hostiles) && d.hostiles.length
        ? `（${d.hostiles.slice(0, 3).map((row) => `${row.name ?? '?'}${row.distance != null ? ` ${row.distance}m` : ''}`).join('、')}）`
        : ''
      return {
        kind: 'event', tags: ['mc', 'safety'], priority: 'notice', merge: 'combat_abort',
        text: `[MC] 战斗中断：${why}${hostiles}；已先自动躲避，任务随后会报失败——按提示先吃/躲/改用 flee。`,
      }
    }
    case 'spawn_unsafe':
      return {
        kind: 'event', tags: ['mc', 'safety', 'alarm'], priority: 'alarm', alarm: true,
        text: alarmLine(`[MC] 出生点危险${eventPositionText(d, pos) ? ` @ ${eventPositionText(d, pos)}` : ''}（脚下/头顶/下方是岩浆或火）；已暂停，换个位置再 resume。`),
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
    pathStuck: { count: 0, at: 0 },  // 连续 path_stuck 计数：单次不投递，≥2 才说
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
      // body 对危险事件做三层标记：事件顶层 priority/pierce、data.priority/pierce、data.meta.priority/pierce
      // （危险 watchdog 还带 severity:'danger'）。这类**不能**被 quiet/合并吞掉：即使类型不认识，
      // 也要用通用危险文案把它送到她面前，信号再透传 meta.priority='alarm'+meta.pierce=true 给 time。
      const dataAlarm = event?.priority === 'alarm' || event?.pierce === true
        || event?.data?.priority === 'alarm' || event?.data?.pierce === true
        || event?.data?.meta?.priority === 'alarm' || event?.data?.meta?.pierce === true
        || event?.severity === 'danger' || event?.data?.severity === 'danger'
      if (QUIET_EVENTS.includes(type) && !dataAlarm) { state.counters.quiet += 1; continue }
      const d = describe(event, status, cfg)
      if (!d && dataAlarm) {
        const detail = event?.data?.reason ?? event?.data?.note ?? event?.data?.detail ?? null
        signals.push({
          id: `mc:alarm:${event?.seq ?? atNow}`,
          kind: 'event', tags: ['mc', 'safety', 'alarm'], priority: 'alarm',
          text: alarmLine(`[MC] 危险：${type}${detail ? `（${valueText(detail, '', 60)}）` : ''}；按安全反射处理，先 mcb_status。`),
        })
        state.counters.signals += 1
        state.counters.alarm += 1
        continue
      }
      if (!d) { state.counters.quiet += 1; continue }
      if (dataAlarm) {
        d.tags = Array.from(new Set([...(d.tags ?? ['mc']), 'alarm']))
        d.priority = 'alarm'
        d.alarm = true
      }

      // path_stuck：单次只是"重算了路线"，任务常常随后就成功；连续 ≥2 次才值得说一句。
      // 任务终态/新任务开始都重置计数（body 事件本身仍留在 mc-link.jsonl 台账里）。
      if (type === 'task_started' || type === 'task_queued' || /^task_(done|failed|interrupted|cancelled|unknown)$/.test(type)) {
        state.pathStuck = { count: 0, at: 0 }
      }
      if (type === 'path_stuck') {
        state.pathStuck.count += 1
        state.pathStuck.at = atNow
        if (state.pathStuck.count < 2) { state.counters.quiet += 1; continue }
        d.text = d.text.replace('[MC] 走不过去', `[MC] 连续 ${state.pathStuck.count} 次走不过去`)
      }

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
            text: alarmLine(`[MC] 危险：${Math.round(cfg.deathEscalation.windowMs / 60_000)} 分钟内死了 ${cfg.deathEscalation.deaths} 次以上。别硬拼：先 resume，再 goto 安全点/挖掩体或 mcb_leave。`),
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
      const text = isAlarm ? alarmLine(d.text, suffix) : (suffix ? `${d.text}${suffix}` : d.text)
      signals.push({
        id: `mc:e:${event?.seq ?? atNow}`,
        kind: d.kind ?? 'event',
        tags: d.tags ?? ['mc'],
        priority: d.priority ?? 'notice',
        text,
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
      state.pathStuck = { count: 0, at: 0 }
    },
    stats: () => ({
      ...state.counters,
      suppressedDetail: Object.fromEntries(state.suppressed),
      mergeSlots: state.merged.size,
    }),
  }
}

export { OPS, TASK_KINDS, MACRO_KINDS, REASON_TEXT, TASK_REASON_TEXT }

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

