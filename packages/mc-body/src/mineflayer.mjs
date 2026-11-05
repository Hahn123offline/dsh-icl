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
    spawnSafety = { ...safety, at: Date.now() }
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
        try { b.pathfinder?.setMovements(new Movements(b)) } catch (error) { log(`movements unavailable: ${error?.message ?? error}`) }
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
      b.on('kicked', (reason) => {
        lastError = `被踢: ${String(reason).slice(0, 300)}`
        emit('kicked', { reason: String(reason).slice(0, 300) })
      })
      b.on('end', (reason) => {
        const wasSpawned = spawned
        spawned = false
        if (bot === b) bot = null
        lastError = lastError ?? `连接结束: ${String(reason ?? '')}`
        const willReconnect = Boolean(autoReconnect && !stopRequested)
        emit('disconnected', { reason: String(reason ?? ''), willReconnect })
        if (stopRequested) return
        if (!willReconnect) return
        log(`body ended (${reason ?? 'end'})`)
        if (wasSpawned) scheduleReconnect('end')
        else if (!settled) {
          settle(reject, new Error(`connect ended: ${String(reason ?? '')}`))
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
  function walkOnce(goal, target, { signal, progress, stallMs, timeoutMs }) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortReason(signal))
      if (!bot?.pathfinder) return reject(new Error('pathfinder-unavailable'))
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
        const pos = currentPosition()
        if (!pos) return finish(reject, new Error('no-position'))
        const distance = distanceTo(pos, target)
        progress?.({ distance: round1(distance), target })
        if (distance <= Math.max(1.2, Number(goal.range) || 1.5)) return finish(resolve, { arrived: true, distance })
        const result = tracker.update(distance)
        if (result.stalled) return finish(resolve, { arrived: false, stalled: true, distance, best: result.best, sinceBestMs: result.sinceBestMs })
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
        signal, progress: null, stallMs: Math.max(1200, pathStallMs), timeoutMs: 4000,
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

  async function gotoWithRecovery(params = {}, signal, progress) {
    const { x, y, z, range = 1.5 } = params
    if (![x, y, z].every((n) => Number.isFinite(Number(n)))) throw new Error('goto 需要 x/y/z')
    if (!bot?.pathfinder) throw new Error('pathfinder-unavailable')
    const target = { x: Number(x), y: Number(y), z: Number(z) }
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
      const outcome = await walkOnce(makeGoal(target, range), target, {
        signal, progress, stallMs,
        timeoutMs: Math.min(remaining, Math.max(2500, stallMs * 2)),
      })
      if (outcome.arrived) {
        if (index > 0) {
          pathStats.recoveries += 1
          emit('path_recovered', { target, attempts, pathResets: pathStats.resets, distance: round1(outcome.distance) })
        }
        return { arrived: true, distance: round1(outcome.distance), attempts, pathResets: pathStats.resets }
      }
      lastDistance = round1(outcome.distance) ?? lastDistance
    }
    checkAbort(signal)
    pathStats.stuck += 1
    emit('path_stuck', {
      target,
      distance: lastDistance,
      pathResets: pathStats.resets,
      attempts,
    })
    const error = new Error(`path stuck: 无法靠近目标（最近 ${lastDistance ?? '?'} 格）；已尝试 repath/jump/backoff/carve`)
    error.name = 'PathStuckError'
    error.result = { arrived: false, distance: lastDistance, pathResets: pathStats.resets, attempts }
    throw error
  }

  // 任务级移动：卡住要报给 body（安全暂停），不是安静地失败。
  async function movementTask(params, signal, progress) {
    try {
      return await gotoWithRecovery(params, signal, progress)
    } catch (error) {
      if (error?.name === 'PathStuckError') emit('stuck', { target: { x: params.x, y: params.y, z: params.z }, distance: error.result?.distance, pathResets: error.result?.pathResets })
      throw error
    }
  }

  // 真实 dig 可能永远等不到 blockUpdate（断线/假死）：用 abort/timeout 抢跑，保证任务能退出。
  async function digBlock(block, signal, timeoutMs = 8000) {
    checkAbort(signal)
    let timer = null
    let onAbort = null
    try {
      await Promise.race([
        bot.dig(block, true),
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
    let missed = 0
    let eaten = 0
    let lastTripAt = 0
    let reason = 'duration'
    const skipped = new Set()
    while (Date.now() < deadline && collected < targetCount) {
      checkAbort(signal)
      if (await eatIfNeeded(signal, progress)) eaten += 1
      if (collected > 0 && collected % tripEvery === 0 && collected !== lastTripAt) {
        lastTripAt = collected
        const base = currentPosition()
        if (base) {
          const tx = base.x + (Math.random() * 2 - 1) * radius * 1.5
          const tz = base.z + (Math.random() * 2 - 1) * radius * 1.5
          trips += 1
          try {
            await gotoWithRecovery({ x: tx, y: base.y, z: tz, range: 2, timeoutMs: 12_000, stallMs: 2500 }, signal, (p) => progress?.({ collected, targetCount, trips, eaten, move: p }))
          } catch (error) {
            if (signal?.aborted) throw error
            progress?.({ collected, targetCount, trips, eaten, moveError: String(error?.message ?? error) })
            if (trips >= 12) { reason = 'stuck'; break }
          }
          await sleep(180)
          continue
        }
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
            if (missed >= 6) { reason = 'no-effect'; break }
            continue
          }
          await pickupNearby(signal, progress)
          collected += 1
          missed = 0
          progress?.({ collected, targetCount, trips, eaten, block: block.name })
        } catch (error) {
          if (signal?.aborted) throw error
          skipped.add(blockKey(block.position))
          missed += 1
          progress?.({ collected, targetCount, trips, eaten, mineError: String(error?.message ?? error) })
          if (missed >= 4) { reason = 'no-target'; break }
        }
      } else {
        const base = currentPosition()
        if (!base) { reason = 'no-position'; break }
        const tx = base.x + (Math.random() * 2 - 1) * radius
        const tz = base.z + (Math.random() * 2 - 1) * radius
        trips += 1
        try {
          await gotoWithRecovery({ x: tx, y: base.y, z: tz, range: 2, timeoutMs: 12_000, stallMs: 2500 }, signal, (p) => progress?.({ collected, targetCount, trips, eaten, move: p }))
        } catch (error) {
          if (signal?.aborted) throw error
          progress?.({ collected, targetCount, trips, eaten, moveError: String(error?.message ?? error) })
          if (trips >= 12) { reason = 'stuck'; break }
        }
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
      let mined = 0
      let missed = 0
      const skipped = new Set()
      while (mined < count) {
        checkAbort(signal)
        const block = findMineable([def], radius, skipped)
        if (!block) throw taskFailure('mine: no-target', { mined })
        try {
          await gotoWithRecovery({ x: block.position.x, y: block.position.y, z: block.position.z, range: Math.max(1, Math.min(4, Number(params.reach) || 2)), timeoutMs: 12_000, stallMs: 2500 }, signal, progress)
        } catch (error) {
          if (signal?.aborted) throw error
          skipped.add(blockKey(block.position))
          missed += 1
          if (missed >= 3) throw taskFailure('mine: no-path', { mined, detail: String(error?.message ?? error) })
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
        progress?.({ done: mined, total: count, block: blockName, tool })
        await sleep(150)
      }
      return { mined }
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

  async function runOp(op, params = {}) {
    if (!bot?.player) throw new Error('not connected')
    if (['move', 'goto', 'patrol', 'explore', 'follow', 'mine'].includes(op)) {
      let kind = op === 'move' ? 'goto' : op
      let taskParams = params
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
      const pos = params.pos ?? params
      if (pos?.x == null) throw new Error('place 需要 pos')
      const item = String(params.item ?? params.name ?? '')
      if (item) {
        const found = (bot.inventory?.items?.() ?? []).find((i) => i.name === item || i.name.includes(item))
        if (!found) throw new Error(`背包没有 ${item}`)
        await bot.equip(found, 'hand')
      }
      const targetPos = new Vec3(Number(pos.x), Number(pos.y), Number(pos.z))
      const current = bot.blockAt(targetPos)
      if (current && !/(air|water)/.test(current.name)) throw new Error(`place: 目标位置不是空气（${current.name}）`)
      // place 需要支撑：下方参考方块必须实心，否则会放空（踩坑档案 #15）。
      const ref = bot.blockAt(new Vec3(Number(pos.x), Number(pos.y) - 1, Number(pos.z)))
      if (!ref || /(air|water|lava)/.test(ref.name)) throw new Error('place: 目标下方没有实心参考方块（需要支撑）')
      await bot.placeBlock(ref, new Vec3(0, 1, 0))
      return { placed: item || 'held' }
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
      let table = bot.registry.blocksByName.crafting_table
        ? bot.findBlock({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: radius })
        : null
      // 合成要在工作台够得着的地方（踩坑档案 #200 / MC-LEARNED 实测）：太远就先走过去。
      if (table) {
        const distance = distanceTo(currentPosition(), table.position.offset(0.5, 0.5, 0.5))
        if (Number.isFinite(distance) && distance > 4) {
          await gotoWithRecovery({ x: table.position.x, y: table.position.y, z: table.position.z, range: 3, timeoutMs: 15_000, stallMs: 2500 }, new AbortController().signal, null)
          table = bot.findBlock({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: radius })
        }
      }
      const recipes = bot.recipesFor(def.id, null, count, table)
      if (!recipes.length) throw new Error(`没有可用配方：${name}（可能缺工作台/材料；需要工作台时先放一张或靠近它）`)
      await bot.craft(recipes[0], count, table)
      const made = (bot.inventory?.items?.() ?? []).filter((item) => item.name === name).reduce((sum, item) => sum + (Number(item.count) || 0), 0)
      return { crafted: name, count, inInventory: made }
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
