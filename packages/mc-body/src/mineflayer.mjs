// mineflayer 适配器：真实身体。任务语义在 body.mjs，这里只执行。
// 职责：连接/有界重连、出生安全、看门狗数据、寻路脱困、1×2 通道挖头挖脚、下挖查水。
// 行为契约见 docs/MC-LEARNED.md §2.3/2.5；不 import 第三方 dsh-mc-agent 代码。
import { createRequire } from 'node:module'
import { createProgressTracker, isDangerousBlock, recoveryStep } from './recovery.mjs'

const require = createRequire(import.meta.url)
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { GoalNear } = goals
const Vec3 = require('vec3').Vec3

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 这些方块不该由任务/脱困去挖：挖了会灌水/灌岩浆/挖基岩，或者本来就是流体。
const FORBIDDEN_DIG = /(bedrock|barrier|command_block|structure_block|jigsaw|end_portal|water|lava|fire|soul_fire|campfire|powder_snow)/

function abortError(message = 'aborted') {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function abortReason(signal) {
  return signal?.reason instanceof Error ? signal.reason : abortError()
}

function checkAbort(signal) {
  if (signal?.aborted) throw abortReason(signal)
}

function distanceTo(a, b) {
  if (!a || !b) return null
  return Math.hypot(Number(a.x) - Number(b.x), Number(a.y) - Number(b.y), Number(a.z) - Number(b.z))
}

function round1(value) {
  return Number.isFinite(Number(value)) ? Math.round(Number(value) * 10) / 10 : null
}

function blockKey(position) {
  return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`
}

function isWaterOrLava(name) {
  return /(water|lava)/.test(String(name ?? ''))
}

// 连接类事件的 reason 可能是字符串、聊天组件对象或嵌套 translate 组件：归一成可读文本。
function reasonText(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value !== 'object') return String(value)
  const text = value.text ?? value.message ?? value.reason
  if (typeof text === 'string' && text) return text
  if (typeof value.translate === 'string') {
    const args = Array.isArray(value.with) ? value.with.map((entry) => reasonText(entry)).filter(Boolean) : []
    return args.length ? `${value.translate} ${args.join(',')}` : value.translate
  }
  try { return JSON.stringify(value).slice(0, 300) } catch { return String(value) }
}

// 任务“没达成”不是成功：用结构化失败让 body 发 task_failed（带 reason/result），
// 上层才能区分“做完了”和“跑完了但没达成”。
function taskFailure(reason, result = {}) {
  const error = new Error(reason)
  error.name = 'TaskFailedError'
  error.result = { ...result, reason }
  return error
}

export function createMineflayerAdapter({
  host, port, username, onEvent = () => {}, log = () => {},
  autoReconnect = true, maxReconnect = 5, reconnectBaseMs = 2000, reconnectMaxDelayMs = 30_000,
  connectTimeoutMs = 15_000,
  pathStallMs = 3500, pathTimeoutMs = 60_000,
} = {}) {
  let bot = null
  let stopRequested = false
  let spawned = false
  let hasSpawnedBefore = false
  let reconnectAttempts = 0
  let reconnectTimer = null
  let reconnectNextDelayMs = null
  let reconnectExhausted = false
  let lastError = null
  let lastPacketAt = 0
  let safePoint = null
  let spawnSafety = null
  let movements = null
  let environment = null
  const pathStats = { resets: 0, recoveries: 0, stuck: 0, carves: 0 }

  function emit(type, data = {}) { try { onEvent(type, data) } catch { /* 事件坏不能拖垮身体 */ } }

  function currentPosition() {
    const pos = bot?.entity?.position
    return pos ? { x: pos.x, y: pos.y, z: pos.z } : null
  }

  function blockNameAt(dx, dy, dz) {
    const pos = bot?.entity?.position
    if (!pos) return null
    try { return bot.blockAt(pos.offset(dx, dy, dz))?.name ?? null } catch { return null }
  }

  // 看门狗与出生安全共用：脚下/头顶/下方 + 周围一圈的危险方块。
  function inspectDanger() {
    if (!spawned || !bot?.entity?.position) return { blocks: [], inDanger: false }
    const blocks = []
    const seen = new Set()
    for (const dy of [0, 1, -1]) {
      for (const dx of [-1, 0, 1]) {
        for (const dz of [-1, 0, 1]) {
          const name = blockNameAt(dx, dy, dz)
          if (!isDangerousBlock(name)) continue
          const pos = bot.entity.position
          const at = { x: Math.floor(pos.x) + dx, y: Math.floor(pos.y) + dy, z: Math.floor(pos.z) + dz }
          const key = `${at.x},${at.y},${at.z}`
          if (seen.has(key)) continue
          seen.add(key)
          blocks.push({ name, at, offset: { dx, dy, dz } })
        }
      }
    }
    return { blocks, inDanger: blocks.length > 0 }
  }

  function nearbyThreats(radius = 8) {
    const pos = bot?.entity?.position
    if (!pos) return []
    return Object.values(bot.entities ?? {})
      .filter((entity) => entity && entity !== bot.entity && entity.position)
      .filter((entity) => /^(zombie|skeleton|creeper|spider|witch|pillager|vindicator|enderman|drowned|husk|stray|phantom|slime)$/.test(String(entity.name ?? '')))
      .map((entity) => ({ name: entity.name, distance: round1(entity.position.distanceTo(pos)), position: entity.position }))
      .filter((threat) => threat.distance <= radius)
      .sort((a, b) => a.distance - b.distance)
  }

  // 环境预检：进服/出生后告诉上层“这张图现在能干什么”（寻路可用性 + 附近资源分布）。
  function probeEnvironment(radius = 16) {
    const countBlocks = (name, max = 8) => {
      const def = bot?.registry?.blocksByName?.[name]
      if (!def) return 0
      try { return (bot.findBlocks({ matching: def.id, maxDistance: radius, count: max }) ?? []).length } catch { return 0 }
    }
    const resources = {}
    for (const name of ['oak_log', 'spruce_log', 'birch_log', 'stone', 'dirt', 'grass_block', 'iron_ore', 'coal_ore', 'water']) {
      resources[name] = countBlocks(name)
    }
    const logs = (resources.oak_log ?? 0) + (resources.spruce_log ?? 0) + (resources.birch_log ?? 0)
    const ores = (resources.iron_ore ?? 0) + (resources.coal_ore ?? 0)
    return {
      pathfinder: Boolean(bot?.pathfinder && movements),
      radius,
      resources,
      surface: blockNameAt(0, -1, 0),
      summary: bot?.pathfinder
        ? `寻路可用；附近原木 ${logs} / 矿石 ${ores} / 石 ${resources.stone ?? 0} / 土 ${resources.dirt ?? 0}`
        : '寻路不可用（只能原地挖/放）',
      at: Date.now(),
    }
  }

  function reconnectSummary() {
    if (!autoReconnect) return null
    return {
      attempts: reconnectAttempts,
      max: maxReconnect,
      nextDelayMs: reconnectNextDelayMs,
      pending: Boolean(reconnectTimer),
      exhausted: reconnectExhausted,
      lastError,
    }
  }

  function status() {
    const pos = currentPosition()
    return {
      connected: Boolean(spawned && bot?.player),
      spawned,
      host,
      port,
      self: bot?.username ?? username ?? null,
      position: pos,
      health: bot?.health ?? null,
      food: bot?.food ?? null,
      oxygen: Number.isFinite(bot?.oxygenLevel) ? bot.oxygenLevel : null,
      submerged: bot?.entity?.isInWater === true,
      players: Object.keys(bot?.players ?? {}),
      dimension: bot?.game?.dimension ?? null,
      nearby: Object.values(bot?.entities ?? {}).reduce((acc, entity) => {
        if (!entity || entity === bot?.entity || !entity.position) return acc
        const key = String(entity.name ?? entity.username ?? entity.type ?? 'entity')
        acc[key] = (acc[key] ?? 0) + 1
        return acc
      }, {}),
      nearbyHostiles: nearbyThreats(8),
      inventoryCount: (bot?.inventory?.items?.() ?? []).reduce((n, item) => n + (Number(item.count) || 0), 0),
      reconnecting: Boolean(reconnectTimer),
      reconnect: reconnectSummary(),
      lastError,
      danger: inspectDanger(),
      pathfinder: Boolean(bot?.pathfinder),
      environment,
      packetSilentMs: lastPacketAt ? Math.max(0, Date.now() - lastPacketAt) : null,
      safePoint,
      spawnSafety,
      pathStats: { ...pathStats },
    }
  }

  function clearReconnectTimer() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  }

  // 有界退避：只排一次，次数到了就 reconnect_exhausted（不无限重试、不静默）。
  function scheduleReconnect(reason = 'disconnect') {
    if (!autoReconnect || stopRequested || reconnectTimer) return
    if (reconnectAttempts >= maxReconnect) {
      reconnectExhausted = true
      reconnectNextDelayMs = null
      emit('reconnect_exhausted', {
        attempts: reconnectAttempts,
        max: maxReconnect,
        reason,
        hint: '自动重连已放弃；需要上层/人工显式重连，状态栏保持未连接',
      })
      return
    }
    reconnectAttempts += 1
    const delay = Math.min(reconnectBaseMs * 2 ** (reconnectAttempts - 1), reconnectMaxDelayMs)
    reconnectNextDelayMs = delay
    emit('reconnecting', { attempt: reconnectAttempts, max: maxReconnect, delayMs: delay, reason })
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      reconnectNextDelayMs = null
      if (stopRequested) return
      connect().catch((error) => {
        emit('body_error', { message: `reconnect failed: ${error?.message ?? error}` })
        scheduleReconnect('reconnect-failed')
      })
    }, delay)
    if (typeof reconnectTimer.unref === 'function') reconnectTimer.unref()
  }

  // 出生安全检查要等 chunk 加载完：spawn 事件比区块数据早，早读会读到 null 误判安全。
  async function finalizeSpawnSafety(b) {
    try {
      if (typeof b.waitForChunksToLoad === 'function') {
        await Promise.race([b.waitForChunksToLoad(), sleep(5000)])
      }
    } catch { /* 等不到就用现有数据判 */ }
    await sleep(200)
    if (bot !== b || !spawned) return
    const safety = evaluateSpawnSafety()
    environment = probeEnvironment()
    spawnSafety = { ...safety, environment, at: Date.now() }
    if (safety.unsafe) {
      safePoint = null
      emit('spawn_unsafe', safety)
    } else {
      const pos = currentPosition()
      safePoint = pos ? { ...pos } : null
      emit('spawn_safe', safety)
    }
  }

  function evaluateSpawnSafety() {
    const pos = currentPosition()
    const feet = blockNameAt(0, 0, 0)
    const head = blockNameAt(0, 1, 0)
    const below = blockNameAt(0, -1, 0)
    const danger = inspectDanger()
    const threats = nearbyThreats(6)
    const unsafe = danger.blocks.length > 0 || threats.length > 0
    return {
      unsafe,
      position: pos,
      feet,
      head,
      below,
      dangerBlocks: danger.blocks,
      threats,
      health: bot?.health ?? null,
      oxygen: Number.isFinite(bot?.oxygenLevel) ? bot.oxygenLevel : null,
    }
  }

  function connect() {
    return new Promise((resolve, reject) => {
      stopRequested = false
      clearReconnectTimer()
      const previous = bot
      if (previous) { try { previous.quit('reconnect') } catch { /* ignore */ } }
      bot = null
      spawned = false
      const b = mineflayer.createBot({ host, port, username, auth: 'offline', version: false })
      bot = b
      // pathfinder 必须显式挂上；挂了才有 goto/脱困。失败要留痕，不能变成“身体走不了路但没人知道”。
      try {
        b.loadPlugin(pathfinder)
      } catch (error) {
        lastError = `pathfinder unavailable: ${error?.message ?? error}`
        log(lastError)
        emit('body_error', { message: lastError })
      }
      let settled = false
      const timer = setTimeout(() => {
        lastError = 'connect timeout'
        try { b.end?.() } catch { /* ignore */ }
        settle(reject, new Error('connect timeout'))
      }, Math.max(3000, Number(connectTimeoutMs) || 15_000))
      const settle = (fn, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn(value)
      }
      b.once('spawn', () => {
        try {
          movements = new Movements(b)
          b.pathfinder?.setMovements(movements)
        } catch (error) { log(`movements unavailable: ${error?.message ?? error}`) }
        spawned = true
        lastPacketAt = Date.now()
        reconnectAttempts = 0
        reconnectExhausted = false
        reconnectNextDelayMs = null
        lastError = null
        emit('spawn', { position: currentPosition() })
        if (hasSpawnedBefore) emit('reconnected', { position: currentPosition() })
        hasSpawnedBefore = true
        settle(resolve, undefined)
        // 出生安全在 chunk 加载后再判，不拿 null 当安全。
        void finalizeSpawnSafety(b)
      })
      b.once('error', (error) => {
        lastError = String(error?.message ?? error)
        emit('body_error', { message: `connect: ${lastError}` })
        settle(reject, error)
        // 首次连接也可能失败（服务器还没起）：走同一套有界退避，不静默留下一个死身体。
        if (!hasSpawnedBefore) scheduleReconnect('connect-failed')
      })
      // 持久 error 监听：mineflayer/minecraft-protocol 在连接出问题时可能多次 emit 'error'。
      // 只剩 once 监听时，第二个 error 会变成 uncaught → 进程静默 exit 1（c3 三次同因崩溃的典型形态）。
      b.on('error', (error) => {
        const message = String(error?.message ?? error)
        lastError = lastError ?? message
        emit('body_error', { message: `bot-error: ${message}` })
      })
      b.on('kicked', (reason) => {
        const text = reasonText(reason)
        lastError = `被踢: ${text.slice(0, 300)}`
        emit('kicked', { reason: text.slice(0, 300) })
      })
      b.on('end', (reason) => {
        const wasSpawned = spawned
        spawned = false
        if (bot === b) bot = null
        // end 的 reason 也可能是对象/嵌套结构：归一成可读字符串再往上抛。
        const text = reasonText(reason)
        lastError = lastError ?? `连接结束: ${text}`
        const willReconnect = Boolean(autoReconnect && !stopRequested)
        emit('disconnected', { reason: text, willReconnect })
        if (stopRequested) return
        if (!willReconnect) return
        log(`body ended (${text || 'end'})`)
        if (wasSpawned) scheduleReconnect('end')
        else if (!settled) {
          settle(reject, new Error(`connect ended: ${text}`))
          scheduleReconnect('connect-ended')
        } else scheduleReconnect('end')
      })
      b.on('packet', () => { lastPacketAt = Date.now() })
      try { b._client?.on?.('packet', () => { lastPacketAt = Date.now() }) } catch { /* ignore */ }
      b.on('chat', (name, message) => { if (name !== b.username) emit('chat', { username: name, message }) })
      b.on('playerJoined', (player) => { if (player?.username !== b.username) emit('join', { username: player.username }) })
      b.on('playerLeft', (player) => emit('leave', { username: player?.username }))
      b.on('death', () => emit('death', { position: currentPosition() }))
      b.on('health', () => emit('health', { health: b.health, food: b.food }))
    })
  }

  async function disconnect() {
    stopRequested = true
    clearReconnectTimer()
    reconnectAttempts = 0
    reconnectExhausted = false
    reconnectNextDelayMs = null
    const b = bot
    bot = null
    spawned = false
    try { b?.quit('body shutdown') } catch { /* ignore */ }
  }

  async function chat(text) {
    if (!bot?.player) throw new Error('not connected')
    bot.chat(text)
  }

  // ---- 寻路：progress watcher + repath→jump→backoff→carve 阶梯 ------------------
  function stopPath() {
    try { bot?.pathfinder?.setGoal(null) } catch { /* ignore */ }
  }

  function makeGoal(target, range) {
    return new GoalNear(target.x, target.y, target.z, Math.max(1, Number(range) || 1.5))
  }

  // 单次尝试：盯“是否更靠近目标”，只有不再刷新最好距离超过 stallMs 才判卡（不是“有没有动”）。
  // arriveRange 显式传入（GoalNear 只有 rangeSq，没有 range，不能从 goal 上读）。
  function walkOnce(goal, target, { signal, progress, stallMs, timeoutMs, arriveRange = 1.5 }) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortReason(signal))
      if (!bot?.pathfinder) return reject(new Error('pathfinder-unavailable'))
      const arrivedWithin = Math.max(1.2, Number(arriveRange) || 1.5)
      const tracker = createProgressTracker({ stallMs: Math.max(500, Number(stallMs) || pathStallMs) })
      let settled = false
      let ticker = null
      let timer = null
      const onAbort = () => finish(reject, abortReason(signal))
      const cleanup = () => {
        if (ticker) clearInterval(ticker)
        if (timer) clearTimeout(timer)
        signal?.removeEventListener?.('abort', onAbort)
        stopPath()
      }
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        cleanup()
        fn(value)
      }
      signal?.addEventListener?.('abort', onAbort, { once: true })
      timer = setTimeout(() => finish(reject, new Error('timeout')), Math.max(1000, Number(timeoutMs) || pathTimeoutMs))
      if (typeof timer.unref === 'function') timer.unref()
      const tickMs = Math.max(100, Math.min(1000, Math.floor((Number(stallMs) || pathStallMs) / 3)))
      ticker = setInterval(() => {
        try {
          const pos = currentPosition()
          if (!pos) return finish(reject, new Error('no-position'))
          const distance = distanceTo(pos, target)
          progress?.({ distance: round1(distance), target })
          if (distance <= arrivedWithin) return finish(resolve, { arrived: true, distance })
          const result = tracker.update(distance)
          if (result.stalled) return finish(resolve, { arrived: false, stalled: true, distance, best: result.best, sinceBestMs: result.sinceBestMs })
        } catch (error) {
          // interval 回调里抛出的异常会变成 uncaught → 进程静默退出；这里必须自己收。
          finish(reject, error)
        }
      }, tickMs)
      if (typeof ticker.unref === 'function') ticker.unref()
      try { bot.pathfinder.setGoal(goal) } catch (error) { finish(reject, error) }
    })
  }

  async function jumpOnce(signal) {
    checkAbort(signal)
    try {
      bot.setControlState('jump', true)
      await sleep(350)
    } finally {
      try { bot.setControlState('jump', false) } catch { /* ignore */ }
    }
  }

  // 向目标的反方向退一小步，换掉“顶在墙角”的局部最优。
  async function backoff(target, signal) {
    checkAbort(signal)
    const pos = currentPosition()
    if (!pos) return false
    const away = { x: pos.x - (target.x - pos.x), y: pos.y, z: pos.z - (target.z - pos.z) }
    try {
      const outcome = await walkOnce(makeGoal({ x: away.x, y: away.y, z: away.z }, 2), away, {
        signal, progress: null, stallMs: Math.max(1200, pathStallMs), timeoutMs: 4000, arriveRange: 2,
      })
      return Boolean(outcome.arrived)
    } catch (error) {
      if (signal?.aborted) throw error
      return false
    }
  }

  // 挖掉挡在脚上/头顶的那一格；只用于离目标很近时（MC-LEARNED §2.5 / 踩坑档案 #163）。
  async function carveStepAhead(target, signal) {
    const pos = currentPosition()
    if (!pos) return 0
    const dx = target.x - pos.x
    const dz = target.z - pos.z
    const horizontal = Math.hypot(dx, dz)
    if (horizontal < 0.6 || horizontal > 4.5) return 0
    const stepX = Math.abs(dx) >= Math.abs(dz) ? Math.sign(dx) : 0
    const stepZ = stepX === 0 ? Math.sign(dz) : 0
    let cleared = 0
    for (let step = 1; step <= 2; step += 1) {
      const base = new Vec3(Math.floor(pos.x) + stepX * step, Math.floor(pos.y), Math.floor(pos.z) + stepZ * step)
      // 先挖头（y+1）再挖脚（y）：1×2 通道上台阶时挡住的是头。
      for (const dy of [1, 0]) {
        checkAbort(signal)
        const block = bot.blockAt(base.offset(0, dy, 0))
        if (await digSafely(block, signal)) cleared += 1
      }
    }
    if (cleared) {
      pathStats.carves += cleared
      emit('tunnel_clear', { cleared, target, position: currentPosition() })
    }
    return cleared
  }

  // 可达性预检（不动身体、只算路）：区分 ok / noPath / unknown。
  // 关键：A* 在 2s 内算不完（正常地形常见）返回的是 unknown——不能当成“不可达”直接 failed。
  function pathCheck(target, range = 1.5, timeoutMs = 5000) {
    if (!bot?.pathfinder || !movements) return { status: 'unknown', reason: 'pathfinder-unavailable' }
    try {
      const result = bot.pathfinder.getPathTo(movements, makeGoal(target, range), Math.max(1000, Number(timeoutMs) || 5000))
      const path = Array.isArray(result?.path) ? result.path : []
      if (path.length > 0) return { status: 'ok', nodes: path.length }
      if (result?.status === 'noPath') return { status: 'noPath', nodes: 0 }
      return { status: 'unknown', nodes: 0, astar: result?.status ?? null }
    } catch (error) {
      return { status: 'unknown', reason: String(error?.message ?? error) }
    }
  }

  function canReach(target, range = 1.5, timeoutMs = 2500) {
    // 只有 A* 明确说 noPath 才算不可达；unknown（超时/算不完）继续尝试。
    return pathCheck(target, range, timeoutMs).status !== 'noPath'
  }

  async function gotoWithRecovery(params = {}, signal, progress) {
    const { x, y, z, range = 1.5 } = params
    if (![x, y, z].every((n) => Number.isFinite(Number(n)))) throw new Error('goto 需要 x/y/z')
    if (!bot?.pathfinder) throw new Error('pathfinder-unavailable')
    const target = { x: Number(x), y: Number(y), z: Number(z) }
    // 预检：只有 A* 明确 noPath 才快速失败；unknown 继续走阶梯。
    if (params.precheck !== false) {
      const check = pathCheck(target, range, params.precheckTimeoutMs ?? 5000)
      if (check.status === 'noPath') {
        const distance = round1(distanceTo(currentPosition(), target))
        emit('path_precheck', { target, reachable: false, kind: params.__kind ?? 'goto', distance })
        const error = new Error(`no-path: 从当前位置走不到目标（直线距离 ${distance ?? '?'} 格，A* 明确无路）；换目标、走近点再试，或调 range`)
        error.name = 'NoPathError'
        error.result = { arrived: false, reason: 'no-path', precheck: true, target, distance }
        throw error
      }
    }
    const timeoutMs = Math.max(2000, Number(params.timeoutMs) || pathTimeoutMs)
    const stallMs = Math.max(1000, Number(params.stallMs) || pathStallMs)
    const startedAt = Date.now()
    let lastDistance = round1(distanceTo(currentPosition(), target))
    let attempts = 0
    for (let index = 0; ; index += 1) {
      checkAbort(signal)
      const action = recoveryStep(index)
      if (action === 'giveup') break
      const remaining = timeoutMs - (Date.now() - startedAt)
      if (remaining <= 800) break
      if (action === 'repath') {
        // 首次 setGoal 不算 reset；只有被判定卡住后的重算才计入 pathResets。
        if (index > 0) pathStats.resets += 1
        stopPath()
      } else if (action === 'jump') {
        await jumpOnce(signal)
      } else if (action === 'backoff') {
        await backoff(target, signal)
      } else if (action === 'carve') {
        const cleared = await carveStepAhead(target, signal)
        if (!cleared) {
          // 近距离也挖不开（可能不是 1×2 通道）：直接放弃，别无限重试。
          break
        }
      }
      checkAbort(signal)
      attempts += 1
      let outcome
      try {
        outcome = await walkOnce(makeGoal(target, range), target, {
          signal, progress, stallMs,
          timeoutMs: Math.min(remaining, Math.max(2500, stallMs * 2)),
          arriveRange: range,
        })
      } catch (error) {
        // 单次 walk 超时/异常不是任务失败：继续阶梯（repath→jump→backoff→carve），最后统一判 stuck。
        if (signal?.aborted) throw abortReason(signal)
        lastDistance = round1(distanceTo(currentPosition(), target)) ?? lastDistance
        continue
      }
      if (outcome.arrived) {
        if (index > 0) {
          pathStats.recoveries += 1
          emit('path_recovered', { target, attempts, pathResets: pathStats.resets, distance: round1(outcome.distance) })
        }
        return { arrived: true, distance: round1(outcome.distance), attempts, pathResets: pathStats.resets }
      }
      const currentDistance = round1(outcome.distance) ?? lastDistance
      // 目标点常被树/草/方块占住，精确踩到 1.5 格有时不可能；在 range+1（≥2.2）内算“到了”并标记 approximate，
      // 避免平原上把正常地形误判成卡住（当事人反馈：每走十几米就被判卡住）。
      const tolerance = Math.max(Number(range) + 1, 2.2)
      if (Number.isFinite(currentDistance) && currentDistance <= tolerance) {
        emit('path_approximate', { target, distance: currentDistance, range, tolerance: round1(tolerance), pathResets: pathStats.resets })
        return { arrived: true, approximate: true, distance: currentDistance, attempts, pathResets: pathStats.resets }
      }
      lastDistance = currentDistance
    }
    checkAbort(signal)
    pathStats.stuck += 1
    emit('path_stuck', {
      target,
      distance: lastDistance,
      pathResets: pathStats.resets,
      attempts,
    })
    const error = new Error(`no-path: 走不过去（最近 ${lastDistance ?? '?'} 格，尝试 ${attempts} 次）；换目标或调 range/radius`)
    error.name = 'PathStuckError'
    error.result = { arrived: false, distance: lastDistance, pathResets: pathStats.resets, attempts }
    throw error
  }

  // 任务级移动：走不过去就是任务失败（带可读原因），不要动 body 的安全暂停；
  // 真正“物理卡住”（位置长时间不变）由 body 看门狗的 movement stall 判据负责暂停。
  async function movementTask(params, signal, progress) {
    return gotoWithRecovery(params, signal, progress)
  }

  // 真实 dig 可能永远等不到 blockUpdate（断线/假死）：用 abort/timeout 抢跑，保证任务能退出。
  async function digBlock(block, signal, timeoutMs = 8000) {
    checkAbort(signal)
    let timer = null
    let onAbort = null
    // 输掉 race 的 dig promise 之后仍可能 reject（Digging aborted 等）：
    // 不接住就是 unhandledRejection → 进程静默 exit 1。整个文件里 bot.dig 只走这一处。
    const digPromise = Promise.resolve(bot.dig(block, true))
    digPromise.catch(() => {})
    try {
      await Promise.race([
        digPromise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('dig timeout')), Math.max(1000, Number(timeoutMs) || 8000))
          if (typeof timer.unref === 'function') timer.unref()
          onAbort = () => reject(abortReason(signal))
          signal?.addEventListener?.('abort', onAbort, { once: true })
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
      if (onAbort) signal?.removeEventListener?.('abort', onAbort)
    }
  }

  // ---- 挖方块安全 --------------------------------------------------------------
  async function digSafely(block, signal) {
    checkAbort(signal)
    if (!block) return false
    const name = String(block.name ?? '')
    if (!name || /(air|void)/.test(name)) return false
    if (FORBIDDEN_DIG.test(name)) {
      emit('dig_refused', { name, at: block.position, reason: 'forbidden-block' })
      return false
    }
    // 下挖查水：目标下方是水/岩浆，挖开就灌进来/烧到（踩坑档案 #113/#123）。
    const under = (() => { try { return bot.blockAt(block.position.offset(0, -1, 0)) } catch { return null } })()
    const pos = currentPosition()
    if (pos && block.position.y < Math.floor(pos.y)) {
      if (isWaterOrLava(under?.name)) {
        emit('dig_refused', { name, at: block.position, reason: 'water-below', below: under?.name })
        return false
      }
    }
    // 不挖自己脚下的支撑（踩坑档案 #163）。
    if (pos) {
      const support = (() => { try { return bot.blockAt(new Vec3(Math.floor(pos.x), Math.floor(pos.y) - 1, Math.floor(pos.z))) } catch { return null } })()
      if (support && support.position.equals(block.position)) {
        emit('dig_refused', { name, at: block.position, reason: 'own-support' })
        return false
      }
    }
    try {
      await equipBestTool(block, signal)
      await faceBlock(block)
      await digBlock(block, signal)
      await sleep(120)
      return true
    } catch (error) {
      if (signal?.aborted) throw error
      emit('dig_error', { name, at: block.position, message: String(error?.message ?? error) })
      return false
    }
  }

  function digSafetyError(block) {
    if (!block) return '目标方块不存在'
    const name = String(block.name ?? '')
    if (FORBIDDEN_DIG.test(name)) return `不挖 ${name}（禁忌方块/流体）`
    const pos = currentPosition()
    if (!pos) return '身体没有位置信息'
    const support = (() => { try { return bot.blockAt(new Vec3(Math.floor(pos.x), Math.floor(pos.y) - 1, Math.floor(pos.z))) } catch { return null } })()
    if (support && support.position.equals(block.position)) return '不挖自己脚下的支撑方块（会把自己挖下去）'
    if (block.position.y < Math.floor(pos.y)) {
      const under = (() => { try { return bot.blockAt(block.position.offset(0, -1, 0)) } catch { return null } })()
      if (isWaterOrLava(under?.name)) return `下方是 ${under?.name}：下挖查水/岩浆，挖开会灌进来`
      const above = (() => { try { return bot.blockAt(block.position.offset(0, 1, 0)) } catch { return null } })()
      if (isWaterOrLava(above?.name)) return `上方是 ${above?.name}：挖开会灌下来`
    }
    return null
  }

  // ---- 背包/吃饭/拾取 ----------------------------------------------------------
  function toolKindFor(block) {
    const name = String(block?.name ?? '')
    if (/log|wood|planks|fence|door|chest|crafting_table|bookshelf/.test(name)) return 'axe'
    if (/stone|ore|deepslate|cobble|brick|netherrack|obsidian|ancient_debris|amethyst/.test(name)) return 'pickaxe'
    if (/dirt|grass|sand|gravel|clay|snow|soul_soil|mud/.test(name)) return 'shovel'
    if (/leaves|wool|vine/.test(name)) return 'shears'
    return null
  }

  async function equipBestTool(block, signal) {
    const kind = toolKindFor(block)
    if (!kind) return null
    const rank = { netherite: 6, diamond: 5, iron: 4, stone: 3, golden: 2, wooden: 1 }
    const tools = (bot.inventory?.items?.() ?? [])
      .filter((item) => item.name.endsWith(`_${kind}`))
      .sort((a, b) => (rank[a.name.split('_')[0]] ?? 0) - (rank[b.name.split('_')[0]] ?? 0))
    const tool = tools.at(-1)
    if (!tool) return null
    checkAbort(signal)
    try { await bot.equip(tool, 'hand') } catch { return null }
    return tool.name
  }

  async function pickupNearby(signal, progress) {
    if (!bot?.player) return 0
    await sleep(250)
    const pos = bot.entity?.position
    if (!pos) return 0
    const drops = Object.values(bot.entities ?? {})
      .filter((entity) => entity?.name === 'item' && entity.position && entity.position.distanceTo(pos) <= 10)
      .sort((a, b) => a.position.distanceTo(pos) - b.position.distanceTo(pos))
      .slice(0, 3)
    let picked = 0
    for (const drop of drops) {
      checkAbort(signal)
      try {
        await gotoWithRecovery({ x: drop.position.x, y: drop.position.y, z: drop.position.z, range: 1, timeoutMs: 4000, stallMs: 2000 }, signal, null)
        picked += 1
        progress?.({ picked })
      } catch (error) {
        if (signal?.aborted) throw error
      }
    }
    return picked
  }

  async function eatIfNeeded(signal, progress) {
    if (!bot || Number(bot.food) > 14) return false
    const food = (bot.inventory?.items?.() ?? []).find((item) => /(bread|apple|cooked|beef|pork|mutton|chicken|carrot|potato|baked|stew|melon|berries)/i.test(item.name))
    if (!food) return false
    checkAbort(signal)
    try {
      await bot.equip(food, 'hand')
      await bot.consume()
      progress?.({ food: bot.food, ate: food.name })
      return true
    } catch (error) {
      progress?.({ food: bot.food, eatError: String(error?.message ?? error) })
      return false
    }
  }

  // 找可挖目标：跳过“挖了会害自己”的位置，避免任务在同一个危险方块上死循环。
  function findMineable(defs, radius, skipped = new Set()) {
    for (const def of defs) {
      if (!def) continue
      const candidates = bot.findBlocks({ matching: def.id, maxDistance: radius, count: 24 }) ?? []
      for (const candidate of candidates) {
        if (skipped.has(blockKey(candidate))) continue
        const block = bot.blockAt(candidate)
        if (!block) continue
        if (digSafetyError(block)) continue
        return block
      }
    }
    return null
  }

  async function routine(params, signal, progress) {
    const durationMs = Math.max(10_000, Math.min(8 * 60 * 60_000, Number(params.durationMs) || 30 * 60_000))
    const targetCount = Math.max(1, Math.min(100_000, Number(params.targetCount) || 9999))
    const radius = Math.max(3, Math.min(32, Number(params.radius) || 12))
    const blockNames = (Array.isArray(params.blocks) && params.blocks.length ? params.blocks : ['oak_log', 'spruce_log', 'birch_log', 'stone', 'dirt']).map(String)
    const deadline = Date.now() + durationMs
    const tripEvery = Math.max(4, Math.min(32, Number(params.tripEvery) || 8))
    const defs = blockNames.map((name) => bot.registry.blocksByName[name]).filter(Boolean)
    let collected = 0
    let trips = 0
    let moveFailures = 0
    let missed = 0
    let eaten = 0
    let lastTripAt = 0
    let reason = 'duration'
    const skipped = new Set()

    // 换点/找资源：目标高度优先用出生时的地表高度，避免在坑里朝坑壁要路。
    async function wander(spread, label) {
      const base = currentPosition()
      if (!base) return false
      const y = Number.isFinite(safePoint?.y) ? safePoint.y : base.y
      const tx = base.x + (Math.random() * 2 - 1) * spread
      const tz = base.z + (Math.random() * 2 - 1) * spread
      trips += 1
      try {
        await gotoWithRecovery({ x: tx, y, z: tz, range: 2, timeoutMs: 10_000, stallMs: 2000, precheckTimeoutMs: 1500 }, signal, (p) => progress?.({ collected, targetCount, trips, eaten, label, move: p }))
        moveFailures = 0
        return true
      } catch (error) {
        if (signal?.aborted) throw error
        moveFailures += 1
        progress?.({ collected, targetCount, trips, eaten, label, moveError: String(error?.message ?? error) })
        return false
      }
    }

    while (Date.now() < deadline && collected < targetCount) {
      checkAbort(signal)
      if (await eatIfNeeded(signal, progress)) eaten += 1
      if (collected > 0 && collected % tripEvery === 0 && collected !== lastTripAt) {
        lastTripAt = collected
        await wander(radius * 1.5, 'trip')
        // 只有“连续多次走不过去”才算卡住；单纯换点次数多不是失败。
        if (moveFailures >= 5) { reason = 'stuck'; break }
        await sleep(180)
        continue
      }
      const block = defs.length ? findMineable(defs, radius, skipped) : null
      if (block) {
        const before = bot.blockAt(block.position)
        try {
          await equipBestTool(block, signal)
          await faceBlock(block)
          await digBlock(block, signal)
          await sleep(150)
          const after = bot.blockAt(block.position)
          if (before && after && after.name === before.name) {
            skipped.add(blockKey(block.position))
            missed += 1
            progress?.({ collected, targetCount, trips, eaten, noEffect: block.name })
            if (missed >= 8) { reason = 'no-effect'; break }
            continue
          }
          await pickupNearby(signal, progress)
          collected += 1
          missed = 0
          moveFailures = 0
          progress?.({ collected, targetCount, trips, eaten, block: block.name })
        } catch (error) {
          if (signal?.aborted) throw error
          skipped.add(blockKey(block.position))
          missed += 1
          progress?.({ collected, targetCount, trips, eaten, mineError: String(error?.message ?? error) })
          if (missed >= 6) {
            // 目标都够不着/挖不动：换点再试，而不是立刻判死。
            missed = 0
            await wander(radius, 'no-target')
            if (moveFailures >= 5) { reason = 'no-target'; break }
          }
        }
      } else {
        await wander(radius, 'no-target')
        if (moveFailures >= 5) { reason = 'stuck'; break }
      }
      await sleep(180)
    }
    if (collected >= targetCount) reason = 'target'
    const result = { collected, trips, eaten, reason, durationMs }
    // routine 正常结束只有两种：时间到 / 达到目标数；stuck/no-target 等是失败（带进度）。
    if (reason !== 'duration' && reason !== 'target') throw taskFailure(`routine: ${reason}`, result)
    return result
  }

  // ---- 反射：有界保命（≤2s/动作，不追击、不生成目标） --------------------------
  async function emergency(reason = 'safety') {
    if (!bot?.player) return { ok: false, reason: 'offline' }
    emit('emergency', { reason })
    const signal = new AbortController().signal
    try {
      const danger = inspectDanger()
      if (danger.blocks.length) {
        // 站在岩浆/火/细雪里：先离开最近的危险格。
        const hostile = danger.blocks[0]
        const pos = currentPosition()
        if (pos && hostile) {
          const dx = Math.floor(pos.x) - hostile.at.x
          const dz = Math.floor(pos.z) - hostile.at.z
          const len = Math.hypot(dx, dz) || 1
          try {
            await gotoWithRecovery({
              x: pos.x + (dx / len) * 3, y: pos.y, z: pos.z + (dz / len) * 3, range: 1.5, timeoutMs: 2200, stallMs: 1200,
            }, signal, null)
            return { ok: true, reason, action: 'leave-danger-block', block: hostile.name }
          } catch { /* 走不掉就跳开 */ }
        }
        bot.setControlState('jump', true)
        await sleep(600)
        bot.setControlState('jump', false)
        return { ok: true, reason, action: 'jump-off-danger', block: hostile?.name ?? null }
      }
      if (Number(bot.food) <= 14) await eatIfNeeded(signal, null)
      if (bot.entity?.isInWater) {
        bot.setControlState('jump', true)
        await sleep(900)
        bot.setControlState('jump', false)
        return { ok: true, reason, action: 'surface' }
      }
      const threats = nearbyThreats(12)
      if (threats[0] && threats[0].distance < 12) {
        const pos = currentPosition()
        const threat = threats[0].position
        if (pos) {
          const dx = pos.x - threat.x
          const dz = pos.z - threat.z
          const len = Math.hypot(dx, dz) || 1
          try {
            await gotoWithRecovery({
              x: pos.x + (dx / len) * 8, y: pos.y, z: pos.z + (dz / len) * 8, range: 2, timeoutMs: 2500, stallMs: 1200,
            }, signal, null)
            return { ok: true, reason, action: 'flee-threat', threat: threats[0].name, distance: threats[0].distance }
          } catch { /* 走不掉就后退 */ }
        }
        bot.setControlState('sprint', true)
        bot.setControlState('back', true)
        bot.setControlState('jump', true)
        await sleep(900)
        bot.setControlState('sprint', false)
        bot.setControlState('back', false)
        bot.setControlState('jump', false)
        return { ok: true, reason, action: 'retreat-threat', threat: threats[0].name }
      }
      if (safePoint) {
        const distance = distanceTo(currentPosition(), safePoint)
        if (Number.isFinite(distance) && distance > 2) {
          try {
            await gotoWithRecovery({ ...safePoint, range: 1.5, timeoutMs: 3500, stallMs: 1500 }, signal, null)
            return { ok: true, reason, action: 'return-safe-point' }
          } catch { /* 回不去就后退 */ }
        }
      }
      bot.setControlState('back', true)
      bot.setControlState('jump', true)
      await sleep(700)
      bot.setControlState('back', false)
      bot.setControlState('jump', false)
      return { ok: true, reason, action: 'retreat' }
    } catch (error) {
      return { ok: false, reason, error: String(error?.message ?? error) }
    }
  }

  async function runTask(task, { signal, progress } = {}) {
    checkAbort(signal)
    if (!bot?.player) throw new Error('not connected')
    const params = task.params ?? {}
    if (task.kind === 'mine') {
      const blockName = String(params.block ?? 'oak_log')
      const def = bot.registry.blocksByName[blockName]
      if (!def) throw new Error(`未知方块：${blockName}`)
      const count = Math.max(1, Math.min(128, Number(params.count) || 1))
      const radius = Math.max(2, Math.min(48, Number(params.radius) || 8))
      const reach = Math.max(1.5, Math.min(4, Number(params.reach) || 3))
      const maxPathMs = Math.max(10_000, Math.min(90_000, Number(params.maxPathMs) || 30_000))
      const startedAt = Date.now()
      let mined = 0
      let missed = 0
      let attempts = 0
      const skipped = new Set()
      // 成功判据是“背包净增 >= count”（block 掉落物可能不是同名，如 stone→cobblestone）。
      const dropItemName = (() => {
        try {
          const drops = def.drops
          if (Array.isArray(drops) && drops.length) {
            const entry = drops[0]
            const id = typeof entry === 'number' ? entry : (entry?.drop?.id ?? entry?.id ?? entry?.drop)
            if (id != null && bot.registry.items?.[id]?.name) return bot.registry.items[id].name
          }
        } catch { /* 用 blockName 兜底 */ }
        return blockName
      })()
      const countItem = () => (bot.inventory?.items?.() ?? [])
        .filter((item) => item.name === dropItemName)
        .reduce((sum, item) => sum + (Number(item.count) || 0), 0)
      const baseline = countItem()
      const net = () => countItem() - baseline
      const completed = () => net() >= count

      // 任务开始的可达性预检（只做诊断，不因一次判定直接 failed —— 决策交给后面的实际行走）：
      // 找不到目标 → no-target；A* 明确无路也先降级尝试（可能只是算不完/树挡住落点）。
      const candidates = []
      for (const candidate of bot.findBlocks({ matching: def.id, maxDistance: radius, count: 24 }) ?? []) {
        const block = bot.blockAt(candidate)
        if (!block || digSafetyError(block)) continue
        candidates.push(block)
      }
      if (!candidates.length) throw taskFailure('mine: no-target', { mined, radius, block: blockName, suggestion: '这附近没有该方块；换方块/调 radius，或先走到有树的地方' })
      const checks = candidates.slice(0, 6).map((block) => ({ block, check: pathCheck(block.position, reach, 5000) }))
      const okCount = checks.filter((row) => row.check.status === 'ok').length
      const noPathCount = checks.filter((row) => row.check.status === 'noPath').length
      if (!okCount) {
        // 降级：先按“接近后原地挖”尝试最近候选，不直接 no-path。
        emit('path_precheck', {
          kind: 'mine', block: blockName, candidates: candidates.length, checked: checks.length, okCount, noPathCount,
          reachable: false, degraded: true,
        })
      }

      // 循环条件是“背包净增 < count”而不是“已挖 < count”：
      // 掉落物没进包时继续挖/再收，直到净增达标（有 attempts 上限防止无限追）。
      while (!completed()) {
        checkAbort(signal)
        if (completed()) return { mined: net(), net: net(), requested: count, item: dropItemName, reason: 'net-target' }
        // 已经挖够 count 个但掉落还没进包：等最多 3s 并再收一次（树叶/树上/坡地掉落会飘）。
        if (mined >= count) {
          for (let i = 0; i < 6 && !completed(); i += 1) {
            await sleep(500)
            if (i === 2) { try { await pickupNearby(signal, progress) } catch (error) { if (signal?.aborted) throw error } }
          }
          if (completed()) return { mined: net(), net: net(), requested: count, item: dropItemName, reason: 'net-target' }
        }
        if (attempts >= count * 4 + 4) {
          throw taskFailure('mine: drops-missing', {
            mined, net: net(), requested: count, item: dropItemName,
            detail: `已挖 ${mined} 个但背包净增只有 ${net()}（掉落物可能没捡到）`,
            suggestion: '先 mcb_inventory 看实际数量；掉落物在别处时靠近再收',
          })
        }
        attempts += 1
        if (mined === 0 && Date.now() - startedAt > maxPathMs) {
          throw taskFailure('mine: no-path', { mined, detail: `首个目标 ${Math.round(maxPathMs / 1000)}s 内没走到`, suggestion: '走近一点再下任务，或调 radius' })
        }
        const block = findMineable([def], radius, skipped)
        if (!block) throw taskFailure('mine: no-target', { mined })
        const approachDistance = round1(distanceTo(currentPosition(), block.position))
        try {
          // 预检已在任务开头做过；循环内不重复 A*，直接走，失败再降级到“原地挖”。
          await gotoWithRecovery({ x: block.position.x, y: block.position.y, z: block.position.z, range: reach, timeoutMs: 8000, stallMs: 2000, precheck: false }, signal, progress)
        } catch (error) {
          if (signal?.aborted) throw error
          const distance = round1(distanceTo(currentPosition(), block.position)) ?? approachDistance
          // 降级：已经在 4.5 格交互距离内，就原地挖（树/坡地把落脚点占住时常见）。
          if (Number.isFinite(distance) && distance <= 4.5) {
            const before = bot.blockAt(block.position)
            try {
              await equipBestTool(block, signal)
              await faceBlock(block)
              await digBlock(block, signal)
              await sleep(220)
              const after = bot.blockAt(block.position)
              if (before && after && after.name !== before.name) {
                emit('dig_fallback', { block: block.name, distance, reason: 'walk-failed-dig-in-place' })
                await pickupNearby(signal, progress)
                mined += 1
                missed = 0
                progress?.({ done: Math.min(count, Math.max(mined, net())), total: count, block: blockName, fallback: true, net: net() })
                if (completed()) return { mined: net(), net: net(), requested: count, item: dropItemName, reason: 'net-target' }
                await sleep(120)
                continue
              }
            } catch (digError) {
              if (signal?.aborted) throw digError
            }
          }
          skipped.add(blockKey(block.position))
          missed += 1
          if (missed >= 2) {
            throw taskFailure('mine: no-path', {
              mined,
              block: blockName,
              distance,
              detail: String(error?.message ?? error),
              suggestion: '走不到/挖不到这个目标；换目标、走近一点再下任务，或调 radius',
            })
          }
          await sleep(300)
          continue
        }
        const before = bot.blockAt(block.position)
        const tool = await equipBestTool(block, signal)
        await faceBlock(block)
        try {
          await digBlock(block, signal)
        } catch (error) {
          if (signal?.aborted) throw error
          skipped.add(blockKey(block.position))
          missed += 1
          if (missed >= 3) throw taskFailure('mine: dig-failed', { mined, detail: String(error?.message ?? error) })
          await sleep(250)
          continue
        }
        await sleep(200)
        const after = bot.blockAt(block.position)
        if (before && after && after.name === before.name) {
          skipped.add(blockKey(block.position))
          missed += 1
          if (missed >= 3) throw taskFailure('mine: no-effect', { mined })
          continue
        }
        await pickupNearby(signal, progress)
        mined += 1
        missed = 0
        progress?.({ done: Math.min(count, Math.max(mined, net())), total: count, block: blockName, tool, net: net() })
        if (completed()) return { mined: net(), net: net(), requested: count, item: dropItemName, reason: 'net-target' }
        await sleep(150)
      }
      // 循环内每个成功点都已提前 return；走到这里说明 mined 计数到了但背包净增没到（掉落没捡到）。
      if (!completed()) {
        throw taskFailure('mine: drops-missing', {
          mined, net: net(), requested: count, item: dropItemName,
          detail: `已挖 ${mined} 个但背包净增只有 ${net()}（期望 ${count}）`,
          suggestion: '先 mcb_inventory 看实际数量；掉落物可能散在别处，靠近再收',
        })
      }
      return { mined: net(), net: net(), requested: count, item: dropItemName, reason: 'net-target' }
    }
    if (task.kind === 'goto') return movementTask(params, signal, progress)
    if (task.kind === 'patrol') {
      const points = Array.isArray(params.points) ? params.points : []
      for (const point of points) { checkAbort(signal); await movementTask(point, signal, progress) }
      return { points: points.length }
    }
    if (task.kind === 'explore') {
      const radius = Math.max(4, Number(params.radius) || 16)
      const base = currentPosition()
      if (!base) throw new Error('no-position')
      const target = { x: base.x + (Math.random() * 2 - 1) * radius, y: base.y, z: base.z + (Math.random() * 2 - 1) * radius }
      return movementTask(target, signal, progress)
    }
    if (task.kind === 'follow') {
      const player = bot.players[String(params.player ?? '')]
      if (!player?.entity) throw new Error('player not found')
      const pos = player.entity.position
      return movementTask({ x: pos.x, y: pos.y, z: pos.z, range: Number(params.range) || 3 }, signal, progress)
    }
    if (task.kind === 'chat') { await chat(String(params.text ?? '')); return { sent: true } }
    if (task.kind === 'routine') return routine(params, signal, progress)
    throw new Error(`unsupported task: ${task.kind}`)
  }

  async function returnToSafe() {
    if (!bot?.player || !safePoint) return { ok: false, reason: 'no-safe-point' }
    const distance = distanceTo(currentPosition(), safePoint)
    if (Number.isFinite(distance) && distance <= 2) return { ok: true, already: true }
    try {
      await gotoWithRecovery({ ...safePoint, range: 2, timeoutMs: 10_000, stallMs: 2500 }, new AbortController().signal, null)
      return { ok: true, action: 'return-safe-point' }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  function resolveEntity(target = {}) {
    const key = String(target?.entity ?? target?.name ?? 'nearest').toLowerCase()
    const wanted = key.startsWith('nearest:') ? key.slice('nearest:'.length) : key === 'nearest' ? '' : key
    const pos = bot.entity?.position
    return Object.values(bot.entities ?? {})
      .filter((entity) => entity && entity !== bot.entity && entity.position)
      .filter((entity) => !wanted || String(entity.name ?? entity.username ?? entity.type ?? '').toLowerCase() === wanted || String(entity.name ?? '').toLowerCase().includes(wanted))
      .sort((a, b) => a.position.distanceTo(pos) - b.position.distanceTo(pos))[0] ?? null
  }

  function blockAtTarget(target = {}) {
    if (target?.pos) return bot.blockAt(new Vec3(Number(target.pos.x), Number(target.pos.y), Number(target.pos.z)))
    if (target?.x != null) return bot.blockAt(new Vec3(Number(target.x), Number(target.y), Number(target.z)))
    const byName = target?.name ?? target?.kind ?? target?.block
    if (byName) {
      const def = bot.registry.blocksByName[String(byName)]
      return def ? bot.findBlock({ matching: def.id, maxDistance: Number(target.radius) || 8 }) : null
    }
    return null
  }

  async function faceBlock(block) {
    if (!block?.position) return false
    try { await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true) } catch { return false }
    return true
  }

  const SOLID_FILLER = /^(dirt|grass_block|cobblestone|stone|sand|gravel|oak_planks|spruce_planks|birch_planks|cobbled_deepslate|netherrack|andesite|diorite|granite)$/

  // 放单块：给可操作原因（太远/被占/没支撑/悬空/没落下去），必要时先补一层支撑。
  async function placeOne(at, { wanted = '', autoSupport = false, findItem = () => null } = {}) {
    const playerPos = currentPosition()
    if (!playerPos) return { ok: false, reason: '身体没有位置信息' }
    const distance = distanceTo(playerPos, { x: at.x + 0.5, y: at.y + 0.5, z: at.z + 0.5 })
    if (Number.isFinite(distance) && distance > 4.5) return { ok: false, reason: `太远（${round1(distance)} 格 > 4.5）` }
    const current = bot.blockAt(new Vec3(at.x, at.y, at.z))
    if (current && !/air/.test(current.name)) return { ok: false, reason: `目标位置被 ${current.name} 占用` }
    const refPos = new Vec3(at.x, at.y - 1, at.z)
    let ref = bot.blockAt(refPos)
    let support = null
    if (!ref || /(air|water|lava)/.test(ref.name)) {
      const filler = (bot.inventory?.items?.() ?? []).find((item) => SOLID_FILLER.test(item.name))
      const belowRef = bot.blockAt(refPos.offset(0, -1, 0))
      if (autoSupport && filler && belowRef && !/(air|water|lava)/.test(belowRef.name)) {
        try {
          await bot.equip(filler, 'hand')
          await bot.placeBlock(belowRef, new Vec3(0, 1, 0))
          await sleep(150)
          ref = bot.blockAt(refPos)
          support = filler.name
        } catch { /* 补支撑失败就按没支撑报错 */ }
      }
      if (!ref || /(air|water|lava)/.test(ref.name)) {
        const refName = ref?.name ?? '未加载'
        return { ok: false, reason: `目标下方没有支撑（下方是 ${refName}）；先放一块垫底、传 autoSupport:true，或换位置` }
      }
    }
    let item = null
    if (wanted) {
      const found = findItem(wanted)
      if (!found) return { ok: false, reason: `背包没有 ${wanted}` }
      await bot.equip(found, 'hand')
      item = found.name
    } else {
      item = bot.heldItem?.name ?? null
    }
    await faceBlock(ref)
    try {
      await bot.placeBlock(ref, new Vec3(0, 1, 0))
    } catch (error) {
      const message = String(error?.message ?? error)
      if (/still air/i.test(message)) return { ok: false, reason: '放不上去：没有可附着的面（悬空/目标格被自己挡住）；先垫底或换位置' }
      if (/(not in reach|too far|out of range)/i.test(message)) return { ok: false, reason: '距离太远（需要站到 4.5 格内）' }
      return { ok: false, reason: `放置失败：${message.slice(0, 120)}` }
    }
    await sleep(150)
    const after = bot.blockAt(new Vec3(at.x, at.y, at.z))
    if (after && /air/.test(after.name)) return { ok: false, reason: '方块没落下去（可能被服务端拒绝/目标被占）' }
    return { ok: true, item, support }
  }

  async function runOp(op, params = {}) {
    if (!bot?.player) throw new Error('not connected')
    if (['move', 'goto', 'patrol', 'explore', 'follow', 'mine'].includes(op)) {
      let kind = op === 'move' ? 'goto' : op
      let taskParams = params
      if (op === 'mine') {
        // mcb_do 的 mine 参数常用 {name:'oak_log'}（t5/L1 就是这么传的）；body 任务参数叫 block。
        taskParams = {
          ...params,
          block: params.block ?? params.name ?? params.kind ?? 'oak_log',
          count: params.count,
          radius: params.radius,
          reach: params.reach,
        }
      }
      if (op === 'move') {
        const target = params.target ?? params
        if (target?.entity) {
          const entity = resolveEntity(target)
          if (!entity) throw new Error(`move: 找不到实体 ${target.entity}`)
          taskParams = { x: entity.position.x, y: entity.position.y, z: entity.position.z, range: params.range ?? 2 }
        } else if (target?.x != null) {
          taskParams = { x: target.x, y: target.y, z: target.z, range: params.range ?? 1.5 }
        }
      }
      if (['goto', 'explore', 'follow'].includes(kind)) {
        // 兼容 {pos:{x,y,z}} 写法
        if (taskParams?.x == null && taskParams?.pos?.x != null) taskParams = { ...taskParams, ...taskParams.pos }
      }
      return kind === 'mine'
        ? runTask({ kind, params: taskParams }, { signal: new AbortController().signal, progress: null })
        : movementTask(taskParams, new AbortController().signal, null)
    }
    if (op === 'wait') { await sleep(Math.max(0, Math.min(30_000, Number(params.ms) || 500))); return { waited: true } }
    if (op === 'eat') {
      const foods = bot.registry.foodsByName ?? {}
      const found = (bot.inventory?.items?.() ?? []).find((item) => foods[item.name])
      if (!found) throw new Error('背包里没有食物')
      await bot.equip(found, 'hand')
      await bot.consume()
      return { ate: found.name }
    }
    if (op === 'face') {
      const block = blockAtTarget(params.target ?? params)
      if (block) { await faceBlock(block); return { faced: block.name, position: block.position } }
      const entity = resolveEntity(params.target ?? params)
      if (!entity) throw new Error('face: 找不到目标')
      await bot.lookAt(entity.position.offset(0, 1.4, 0), true)
      return { faced: entity.name ?? entity.username ?? entity.type }
    }
    if (op === 'use') {
      const entity = params.entity || params.target?.entity ? resolveEntity(params.entity ? params : params.target) : null
      if (entity) { await bot.activateEntity(entity); return { used: 'entity', name: entity.name ?? entity.username ?? entity.type } }
      const block = blockAtTarget(params.target ?? params)
      if (block) { await bot.activateBlock(block); return { used: 'block', name: block.name } }
      await bot.activateItem(); return { used: 'item' }
    }
    if (op === 'dig') {
      const block = blockAtTarget(params)
      if (!block) throw new Error('dig: 找不到目标方块（给出 pos，或 name/kind + radius）')
      const unsafe = digSafetyError(block)
      if (unsafe) throw new Error(`dig: ${unsafe}`)
      const before = bot.blockAt(block.position)
      const tool = await equipBestTool(block, new AbortController().signal)
      await faceBlock(block)
      await digBlock(block, new AbortController().signal)
      await sleep(200)
      const after = bot.blockAt(block.position)
      if (before && after && after.name === before.name) throw new Error('dig: 方块没有变化（可能太远/工具不对）')
      await pickupNearby(new AbortController().signal, null)
      return { dug: block.name, position: block.position, tool }
    }
    if (op === 'place') {
      const raw = params.positions ?? params.pos ?? params
      const list = Array.isArray(raw) ? raw : [raw]
      const coords = list
        .map((entry) => (entry?.x != null
          ? { x: Math.floor(Number(entry.x)), y: Math.floor(Number(entry.y)), z: Math.floor(Number(entry.z)) }
          : null))
        .filter(Boolean)
      if (!coords.length) throw new Error('place 需要 pos 或 positions[]（x/y/z）；可传多坐标，会从下往上排')
      coords.sort((a, b) => a.y - b.y) // 从下往上：先垫底，再往上放
      const wanted = String(params.item ?? params.name ?? '')
      const findItem = (name) => (bot.inventory?.items?.() ?? []).find((i) => i.name === name || i.name.includes(name)) ?? null
      if (wanted && !findItem(wanted)) throw new Error(`背包没有 ${wanted}`)
      const placed = []
      const skipped = []
      for (const at of coords) {
        const outcome = await placeOne(at, { wanted, autoSupport: params.autoSupport === true, findItem })
        if (outcome.ok) placed.push({ ...at, item: outcome.item, support: outcome.support ?? null })
        else skipped.push({ ...at, reason: outcome.reason })
      }
      if (!placed.length) {
        const reasons = [...new Set(skipped.map((row) => row.reason))].join('；')
        throw new Error(`place: 一个都没放成（${reasons}）`)
      }
      return { placed, skipped, placedCount: placed.length, skippedCount: skipped.length }
    }
    if (op === 'equip') {
      const item = String(params.item ?? params.name ?? '')
      const found = (bot.inventory?.items?.() ?? []).find((i) => i.name === item || i.name.includes(item))
      if (!found) throw new Error(`背包没有 ${item}`)
      await bot.equip(found, params.destination ?? 'hand')
      return { equipped: found.name }
    }
    if (op === 'toss') {
      const item = String(params.item ?? params.name ?? '')
      const found = (bot.inventory?.items?.() ?? []).find((i) => i.name === item || i.name.includes(item))
      if (!found) throw new Error(`背包没有 ${item}`)
      await bot.toss(found.type, null, Math.max(1, Number(params.count) || 1))
      return { tossed: found.name }
    }
    if (op === 'attack') {
      const entity = resolveEntity(params.target ?? params)
      if (!entity) throw new Error('attack: 找不到目标')
      await bot.attack(entity)
      return { attacked: entity.name ?? entity.username ?? entity.type }
    }
    if (op === 'craft') {
      const name = String(params.item ?? params.name ?? '')
      const def = bot.registry.itemsByName[name]
      if (!def) throw new Error(`未知物品：${name}`)
      const count = Math.max(1, Number(params.count) || 1)
      const radius = Math.max(2, Number(params.radius) || 4)
      const countOf = (itemName) => (bot.inventory?.items?.() ?? [])
        .filter((item) => item.name === itemName)
        .reduce((sum, item) => sum + (Number(item.count) || 0), 0)
      let table = bot.registry.blocksByName.crafting_table
        ? bot.findBlock({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: radius })
        : null
      // 合成要在工作台够得着的地方（踩坑档案 #200 / MC-LEARNED 实测）：太远就先走过去。
      if (table) {
        const distance = distanceTo(currentPosition(), table.position.offset(0.5, 0.5, 0.5))
        if (Number.isFinite(distance) && distance > 4) {
          await gotoWithRecovery({ x: table.position.x, y: table.position.y, z: table.position.z, range: 2, timeoutMs: 15_000, stallMs: 2500 }, new AbortController().signal, null)
          table = bot.findBlock({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: radius })
        }
      }
      if (table) {
        const tableDistance = distanceTo(currentPosition(), table.position.offset(0.5, 0.5, 0.5))
        if (Number.isFinite(tableDistance) && tableDistance > 4) {
          throw new Error(`craft: 工作台不在可交互距离（${round1(tableDistance)} 格 > 4）；先走近工作台再合成`)
        }
      }
      const recipes = bot.recipesFor(def.id, null, count, table)
      if (!recipes.length) throw new Error(`没有可用配方：${name}（可能缺工作台/材料；需要工作台时先放一张或靠近它）`)
      const before = countOf(name)
      const recipe = recipes[0]
      // 语义对齐：count = “想要多少个成品”（不是 craft 次数）。
      // 木板/木棍等一次产 4 个：老代码把 count 直接当次数，要 5 个木板会真合成 5 次（吞 5 根木头）。
      const perCraft = Math.max(1, Number(recipe.result?.count) || 1)
      const craftTimes = Math.max(1, Math.ceil(count / perCraft))
      // 材料快照：合成窗口异常时，材料可能已经进窗口/被消耗，产物却没到背包（当事人反馈“吞材料”）。
      const inputs = [recipe.requires?.[0], recipe.requires?.[1], recipe.requires?.[2]].filter(Boolean)
        .map((entry) => ({ name: entry.name ?? null, count: Number(entry.count) || 1 }))
      const inputsBefore = inputs.map((entry) => ({ ...entry, have: entry.name ? countOf(entry.name) : null }))
      let craftError = null
      try {
        await bot.craft(recipe, craftTimes, table)
      } catch (error) {
        craftError = error
      }
      await sleep(120)
      // 产物进背包有网络延迟：轮询最多 ~2.5s 再判定，避免“物品其实到了”被误报成吞材料。
      let after = countOf(name)
      let produced = after - before
      const verifyDeadline = Date.now() + 2500
      while (produced < count && Date.now() < verifyDeadline) {
        await sleep(150)
        after = countOf(name)
        produced = after - before
      }
      if (produced < count) {
        const detail = {
          requested: count,
          craftTimes,
          perCraft,
          expectedAtLeast: count,
          produced,
          before,
          after,
          inputsBefore,
          inputsAfter: inputsBefore.map((entry) => ({ ...entry, have: entry.name ? countOf(entry.name) : null })),
          craftError: craftError ? String(craftError?.message ?? craftError) : null,
        }
        const error = new Error(`craft: 产物没进背包（想要 +${count}，实际 +${produced}，合成 ${craftTimes} 次×${perCraft}）；材料可能已消耗，先 mcb_inventory 复核，别直接重做`)
        error.name = 'TaskFailedError'
        error.result = detail
        emit('craft_no_product', detail)
        throw error
      }
      return { crafted: name, requested: count, craftTimes, perCraft, produced, inInventory: after }
    }
    if (op === 'furnace') {
      const block = blockAtTarget(params.target ?? { block: 'furnace', radius: 4 }) || bot.findBlock({ matching: bot.registry.blocksByName.furnace?.id, maxDistance: 4 })
      if (!block) throw new Error('附近没有熔炉')
      const furnace = await bot.openFurnace(block)
      try {
        if (params.input) await furnace.putInput(bot.registry.itemsByName[String(params.input)]?.id, null, Math.max(1, Number(params.count) || 1))
        if (params.fuel) await furnace.putFuel(bot.registry.itemsByName[String(params.fuel)]?.id, null, 1)
        await sleep(Math.max(1000, Number(params.waitMs) || 5000))
        const out = await furnace.takeOutput()
        return { output: out?.name ?? null }
      } finally { try { await furnace.close() } catch { /* ignore */ } }
    }
    if (op === 'chest') {
      const block = blockAtTarget(params.target ?? { block: 'chest', radius: 4 }) || bot.findBlock({ matching: bot.registry.blocksByName.chest?.id, maxDistance: 4 })
      if (!block) throw new Error('附近没有箱子')
      const container = await bot.openContainer(block)
      try {
        if (params.action === 'list') return { items: container.containerItems().map((item) => ({ name: item.name, count: item.count })) }
        for (const item of Array.isArray(params.items) ? params.items : []) {
          const def = bot.registry.itemsByName[String(item.name)]
          if (!def) continue
          if (params.action === 'put') await container.deposit(def.id, null, Number(item.count) || 1)
          if (params.action === 'take') await container.withdraw(def.id, null, Number(item.count) || 1)
        }
        return { action: params.action, done: true }
      } finally { try { await container.close() } catch { /* ignore */ } }
    }
    if (op === 'trade') {
      const villager = resolveEntity(params.target ?? { entity: 'nearest:villager' })
      if (!villager) throw new Error('附近没有村民')
      const win = await bot.openVillager(villager)
      try {
        if (params.action === 'list' || !params.action) return { trades: (win.trades ?? []).map((trade, index) => ({ index, input: trade.inputItem1?.name, output: trade.outputItem?.name })) }
        if (params.action === 'buy') { await win.trade(Number(params.index) || 0, Number(params.count) || 1); return { bought: Number(params.index) || 0 } }
        return { action: params.action }
      } finally { try { await win.close() } catch { /* ignore */ } }
    }
    throw new Error(`未知 op：${op}`)
  }

  async function inspect(kind, params = {}) {
    if (!bot?.player) throw new Error('not connected')
    const pos = bot.entity?.position
    if (kind === 'inventory') {
      const items = (bot.inventory?.items?.() ?? []).map((item) => ({ name: item.name, count: item.count, slot: item.slot }))
      const held = bot.heldItem ? { name: bot.heldItem.name, count: bot.heldItem.count } : null
      return {
        text: items.length ? items.map((item) => `${item.name} ×${item.count}`).join('、') : '背包是空的。',
        data: { items, held },
      }
    }
    if (kind === 'look') {
      let block = null
      try {
        const hit = bot.blockAtCursor(6)
        if (hit) block = { name: hit.name, position: { x: hit.position.x, y: hit.position.y, z: hit.position.z } }
      } catch { /* ignore */ }
      const entities = Object.values(bot.entities ?? {})
        .filter((entity) => entity !== bot.entity && entity.position)
        .map((entity) => ({ name: entity.name ?? entity.username ?? entity.type, distance: Math.round(entity.position.distanceTo(pos) * 10) / 10 }))
        .sort((a, b) => a.distance - b.distance).slice(0, 6)
      return {
        text: [
          `位置：${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)}；朝向 yaw=${Math.round(bot.entity.yaw * 180 / Math.PI)}°`,
          `生命/饥饿/氧气：${bot.health}/${bot.food}/${Number.isFinite(bot.oxygenLevel) ? bot.oxygenLevel : '?'}`,
          `手持：${bot.heldItem?.name ?? '空'}`,
          `视线方块：${block ? `${block.name} @ ${block.position.x},${block.position.y},${block.position.z}` : '没有'}`,
          `附近：${entities.length ? entities.map((entity) => `${entity.name}(${entity.distance}m)`).join('、') : '无'}`,
        ].join('\n'),
        data: { position: pos, block, entities, health: bot.health, food: bot.food },
      }
    }
    if (kind === 'scan') {
      const name = String(params.name ?? '').trim()
      const def = bot.registry.blocksByName[name]
      if (!name || !def) throw new Error(`未知方块：${name || '(空)'}`)
      const radius = Math.max(2, Math.min(48, Number(params.radius) || 16))
      const count = Math.max(1, Math.min(64, Number(params.count) || 8))
      const hits = bot.findBlocks({ matching: def.id, maxDistance: radius, count }) ?? []
      const rows = hits.map((position) => ({ x: position.x, y: position.y, z: position.z, distance: Math.round(pos.distanceTo(position) * 10) / 10 })).sort((a, b) => a.distance - b.distance)
      return { text: rows.length ? rows.map((row) => `${name} @ ${row.x},${row.y},${row.z}（${row.distance}m）`).join('\n') : `附近没有 ${name}。`, data: { name, rows } }
    }
    if (kind === 'map') {
      const radius = Math.max(2, Math.min(8, Number(params.radius) || 4))
      const y = Math.floor(pos.y) - 1
      const symbol = (block) => {
        if (!block) return '?'
        if (/water/.test(block.name)) return '~'
        if (/lava/.test(block.name)) return '≈'
        if (/air/.test(block.name)) return '.'
        return '#'
      }
      const rows = []
      for (let dz = -radius; dz <= radius; dz += 1) {
        let line = ''
        for (let dx = -radius; dx <= radius; dx += 1) {
          const block = bot.blockAt(new Vec3(Math.floor(pos.x) + dx, y, Math.floor(pos.z) + dz))
          line += symbol(block)
        }
        rows.push(line)
      }
      return { text: ['脚下方块层（#实心 .空 ~水 ≈岩浆 ?未加载）', ...rows].join('\n'), data: { y, rows } }
    }
    throw new Error(`unsupported inspect: ${kind}`)
  }

  return { connect, disconnect, status, chat, runTask, emergency, returnToSafe, inspect, runOp }
}
