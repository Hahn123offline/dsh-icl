// mineflayer 适配器：真实身体。任务语义在 body.mjs，这里只执行。
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { GoalNear } = goals
const Vec3 = require('vec3').Vec3

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function abortError(message = 'aborted') {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function checkAbort(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError()
}

export function createMineflayerAdapter({
  host, port, username, onEvent = () => {}, log = () => {},
  autoReconnect = true, maxReconnect = 3, reconnectBaseMs = 3000,
} = {}) {
  let bot = null
  let stopRequested = false
  let reconnectAttempts = 0
  let reconnectTimer = null
  let hasSpawned = false
  let safePoint = null

  function emit(type, data = {}) { try { onEvent(type, data) } catch { /* ignore */ } }

  function status() {
    return {
      connected: Boolean(bot?.player),
      host, port,
      self: bot?.username ?? username ?? null,
      position: bot?.entity?.position ?? null,
      health: bot?.health ?? null,
      food: bot?.food ?? null,
      oxygen: Number.isFinite(bot?.oxygenLevel) ? bot.oxygenLevel : null,
      submerged: bot?.entity?.isInWater === true,
      players: Object.keys(bot?.players ?? {}),
      dimension: bot?.game?.dimension ?? null,
      nearby: Object.values(bot?.entities ?? {}).reduce((acc, e) => {
        if (!e || e === bot?.entity || !e.position) return acc
        const key = String(e.name ?? e.username ?? e.type ?? 'entity')
        acc[key] = (acc[key] ?? 0) + 1
        return acc
      }, {}),
      inventoryCount: (bot?.inventory?.items?.() ?? []).reduce((n, item) => n + (Number(item.count) || 0), 0),
      dimension: bot?.game?.dimension ?? null,
      reconnecting: Boolean(reconnectTimer),
      safePoint,
    }
  }

  function scheduleReconnect(reason = 'disconnect') {
    if (!autoReconnect || stopRequested || reconnectTimer) return
    if (reconnectAttempts >= maxReconnect) {
      emit('reconnect_exhausted', { attempts: reconnectAttempts, reason })
      return
    }
    reconnectAttempts += 1
    const delay = reconnectBaseMs * 2 ** (reconnectAttempts - 1)
    emit('reconnecting', { attempt: reconnectAttempts, delayMs: delay, reason })
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (stopRequested) return
      connect().catch((error) => {
        emit('body_error', { message: `reconnect: ${error?.message ?? error}` })
        scheduleReconnect('reconnect-failed')
      })
    }, delay)
    if (typeof reconnectTimer.unref === 'function') reconnectTimer.unref()
  }

  function connect() {
    return new Promise((resolve, reject) => {
      stopRequested = false
      if (bot) { try { bot.quit('reconnect') } catch { /* ignore */ } }
      const b = mineflayer.createBot({ host, port, username, auth: 'offline', version: false })
      bot = b
      try { b.loadPlugin(pathfinder) } catch (error) { log(`pathfinder unavailable: ${error?.message ?? error}`) }
      const timer = setTimeout(() => { reject(new Error('connect timeout')); scheduleReconnect('connect-timeout') }, 15_000)
      b.once('spawn', () => {
        try { b.pathfinder?.setMovements(new Movements(b)) } catch (error) { log(`movements unavailable: ${error?.message ?? error}`) }
        const pos = b.entity?.position
        const nameAt = (dx, dy, dz) => {
          try { return b.blockAt(pos.offset(dx, dy, dz))?.name ?? null } catch { return null }
        }
        const feet = nameAt(0, 0, 0)
        const head = nameAt(0, 1, 0)
        const below = nameAt(0, -1, 0)
        const dangerous = (name) => /(lava|fire|cactus|magma_block|powder_snow|soul_fire|campfire)/.test(String(name ?? ''))
        if (dangerous(feet) || dangerous(head) || dangerous(below)) {
          safePoint = null
          emit('spawn_unsafe', { position: pos, feet, head, below })
        } else {
          safePoint = { x: pos.x, y: pos.y, z: pos.z }
          emit('spawn_safe', { position: pos, feet, head, below })
        }
        clearTimeout(timer)
        reconnectAttempts = 0
        emit('spawn', { position: pos })
        if (hasSpawned) emit('reconnected', { position: pos })
        hasSpawned = true
        resolve()
      })
      b.once('error', (error) => { clearTimeout(timer); emit('body_error', { message: String(error?.message ?? error) }); reject(error) })
      b.on('chat', (name, message) => { if (name !== b.username) emit('chat', { username: name, message }) })
      b.on('playerJoined', (player) => { if (player?.username !== b.username) emit('join', { username: player.username }) })
      b.on('playerLeft', (player) => emit('leave', { username: player?.username }))
      b.on('death', () => emit('death', {}))
      b.on('health', () => emit('health', { health: b.health, food: b.food }))
      b.on('kicked', (reason) => emit('kicked', { reason: String(reason) }))
      b.on('end', (reason) => {
        emit('disconnected', { reason: String(reason ?? '') })
        if (bot === b) bot = null
        if (stopRequested) return
        log('body ended')
        scheduleReconnect('end')
      })
    })
  }

  async function disconnect() {
    stopRequested = true
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
    try { bot?.quit('body shutdown') } catch { /* ignore */ }
    bot = null
  }

  async function chat(text) {
    if (!bot?.player) throw new Error('not connected')
    bot.chat(text)
  }

  async function goto(params, signal, progress) {
    const { x, y, z, range = 1.5, timeoutMs = 60_000 } = params ?? {}
    if (![x, y, z].every((n) => Number.isFinite(Number(n)))) throw new Error('goto 需要 x/y/z')
    if (!bot?.pathfinder) throw new Error('pathfinder-unavailable')
    const target = { x: Number(x), y: Number(y), z: Number(z) }
    checkAbort(signal)
    const goal = new GoalNear(target.x, target.y, target.z, Math.max(1, Number(range) || 1.5))
    let timer = null
    let stopWatch = null
    const progressTimer = setInterval(() => {
      const pos = bot?.entity?.position
      if (!pos) return
      progress?.({ distance: Math.round(Math.hypot(pos.x - target.x, pos.y - target.y, pos.z - target.z) * 10) / 10, target })
    }, 500)
    if (typeof progressTimer.unref === 'function') progressTimer.unref()
    const abort = new Promise((_, reject) => {
      if (!signal) return
      const onAbort = () => { try { bot?.pathfinder?.setGoal(null) } catch { /* ignore */ }; reject(signal.reason instanceof Error ? signal.reason : abortError()) }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
      stopWatch = () => signal.removeEventListener('abort', onAbort)
    })
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { try { bot?.pathfinder?.setGoal(null) } catch { /* ignore */ }; reject(new Error('timeout')) }, Math.max(1000, Number(timeoutMs) || 60_000))
      if (typeof timer.unref === 'function') timer.unref()
    })
    const walking = bot?.pathfinder?.goto(goal)
    if (!walking) throw new Error('pathfinder-unavailable')
    walking.catch(() => { /* raced; avoid unhandled */ })
    try {
      await Promise.race([walking, abort, timeout])
      const pos = bot.entity?.position
      const distance = pos ? Math.hypot(pos.x - target.x, pos.y - target.y, pos.z - target.z) : null
      return { arrived: true, distance }
    } catch (error) {
      try { bot?.pathfinder?.setGoal(null) } catch { /* ignore */ }
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError()
      if (String(error?.message ?? error) === 'timeout') throw new Error('timeout')
      throw error
    } finally {
      clearInterval(progressTimer)
      clearTimeout(timer)
      stopWatch?.()
      try { bot?.pathfinder?.setGoal(null) } catch { /* ignore */ }
    }
  }

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
      .filter((e) => e?.name === 'item' && e.position && e.position.distanceTo(pos) <= 10)
      .sort((a, b) => a.position.distanceTo(pos) - b.position.distanceTo(pos))
      .slice(0, 3)
    let picked = 0
    for (const drop of drops) {
      checkAbort(signal)
      try {
        await goto({ x: drop.position.x, y: drop.position.y, z: drop.position.z, range: 1, timeoutMs: 4000 }, signal, null)
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

  async function routine(params, signal, progress) {
    const durationMs = Math.max(10_000, Math.min(8 * 60 * 60_000, Number(params.durationMs) || 30 * 60_000))
    const targetCount = Math.max(1, Math.min(100_000, Number(params.targetCount) || 9999))
    const radius = Math.max(3, Math.min(32, Number(params.radius) || 12))
    const blocks = (Array.isArray(params.blocks) && params.blocks.length ? params.blocks : ['oak_log', 'spruce_log', 'birch_log', 'stone', 'dirt']).map(String)
    const deadline = Date.now() + durationMs
    const tripEvery = Math.max(4, Math.min(32, Number(params.tripEvery) || 8))
    let collected = 0
    let trips = 0
    let missed = 0
    let eaten = 0
    let lastTripAt = 0
    let reason = 'duration'
    while (Date.now() < deadline && collected < targetCount) {
      checkAbort(signal)
      if (await eatIfNeeded(signal, progress)) eaten += 1
      if (collected > 0 && collected % tripEvery === 0 && collected !== lastTripAt) {
        lastTripAt = collected
        const base = bot.entity?.position
        if (base) {
          const tx = base.x + (Math.random() * 2 - 1) * radius * 1.5
          const tz = base.z + (Math.random() * 2 - 1) * radius * 1.5
          trips += 1
          try {
            await goto({ x: tx, y: base.y, z: tz, range: 2, timeoutMs: 15_000 }, signal, (p) => progress?.({ collected, targetCount, trips, eaten, move: p }))
          } catch (error) {
            if (signal?.aborted) throw error
            progress?.({ collected, targetCount, trips, eaten, moveError: String(error?.message ?? error) })
            if (trips >= 12) { reason = 'stuck'; break }
          }
          await sleep(180)
          continue
        }
      }
      let block = null
      for (const name of blocks) {
        const def = bot.registry.blocksByName[name]
        if (!def) continue
        block = bot.findBlock({ matching: def.id, maxDistance: radius })
        if (block) break
      }
      if (block) {
        try {
          await bot.dig(block, true)
          await pickupNearby(signal, progress)
          collected += 1
          missed = 0
          progress?.({ collected, targetCount, trips, eaten, block: block.name })
        } catch (error) {
          missed += 1
          progress?.({ collected, targetCount, trips, eaten, mineError: String(error?.message ?? error) })
          if (missed >= 4) { reason = 'no-target'; break }
        }
      } else {
        const base = bot.entity?.position
        if (!base) { reason = 'no-position'; break }
        const tx = base.x + (Math.random() * 2 - 1) * radius
        const tz = base.z + (Math.random() * 2 - 1) * radius
        trips += 1
        try {
          await goto({ x: tx, y: base.y, z: tz, range: 2, timeoutMs: 15_000 }, signal, (p) => progress?.({ collected, targetCount, trips, eaten, move: p }))
        } catch (error) {
          if (signal?.aborted) throw error
          progress?.({ collected, targetCount, trips, eaten, moveError: String(error?.message ?? error) })
          if (trips >= 12) { reason = 'stuck'; break }
        }
      }
      await sleep(180)
    }
    if (collected >= targetCount) reason = 'target'
    return { collected, trips, eaten, reason, durationMs }
  }

  async function emergency(reason = 'safety') {
    if (!bot?.player) return { ok: false, reason: 'offline' }
    emit('emergency', { reason })
    const signal = new AbortController().signal
    try {
      if (Number(bot.food) <= 14) await eatIfNeeded(signal, null)
      const pos = bot.entity?.position
      const threats = pos ? Object.values(bot.entities ?? {})
        .filter((e) => e && e !== bot.entity && e.position && /^(zombie|skeleton|creeper|spider|witch|pillager|vindicator|enderman|drowned|husk|stray)$/.test(String(e.name ?? '')))
        .map((e) => ({ e, distance: e.position.distanceTo(pos) }))
        .sort((a, b) => a.distance - b.distance)
        : []
      if (pos && threats[0] && threats[0].distance < 12) {
        const threat = threats[0].e.position
        const dx = pos.x - threat.x
        const dz = pos.z - threat.z
        const len = Math.hypot(dx, dz) || 1
        const target = { x: pos.x + (dx / len) * 8, y: pos.y, z: pos.z + (dz / len) * 8, range: 2, timeoutMs: 2500 }
        try {
          await goto(target, signal, null)
          return { ok: true, reason, action: 'flee-threat', threat: threats[0].e.name, distance: Math.round(threats[0].distance) }
        } catch { /* 走不掉就后退 */ }
        bot.setControlState('sprint', true)
        bot.setControlState('back', true)
        bot.setControlState('jump', true)
        await sleep(900)
        bot.setControlState('sprint', false)
        bot.setControlState('back', false)
        bot.setControlState('jump', false)
        return { ok: true, reason, action: 'retreat-threat', threat: threats[0].e.name }
      }
      if (pos && safePoint) {
        const distance = Math.hypot(pos.x - safePoint.x, pos.y - safePoint.y, pos.z - safePoint.z)
        if (distance > 2) {
          try {
            await goto({ ...safePoint, range: 1.5, timeoutMs: 3500 }, signal, null)
            return { ok: true, reason, action: 'return-safe-point' }
          } catch { /* 回不去就后退 */ }
        }
      }
      if (bot.entity?.isInWater) {
        bot.setControlState('jump', true)
        await sleep(900)
        bot.setControlState('jump', false)
        return { ok: true, reason, action: 'surface' }
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
      while (mined < count) {
        checkAbort(signal)
        const block = bot.findBlock({ matching: def.id, maxDistance: radius })
        if (!block) return { mined, reason: 'no-target' }
        try {
          await goto({ x: block.position.x, y: block.position.y, z: block.position.z, range: Math.max(1, Math.min(4, Number(params.reach) || 2)), timeoutMs: 12_000 }, signal, progress)
        } catch (error) {
          if (signal?.aborted) throw error
          missed += 1
          if (missed >= 3) return { mined, reason: 'no-path', error: String(error?.message ?? error) }
          await sleep(300)
          continue
        }
        const before = bot.blockAt(block.position)
        const tool = await equipBestTool(block, signal)
        await faceBlock(block)
        try {
          await bot.dig(block, true)
        } catch (error) {
          if (signal?.aborted) throw error
          missed += 1
          if (missed >= 3) return { mined, reason: 'dig-failed', error: String(error?.message ?? error) }
          await sleep(250)
          continue
        }
        await sleep(200)
        const after = bot.blockAt(block.position)
        if (before && after && after.name === before.name) {
          missed += 1
          if (missed >= 3) return { mined, reason: 'no-effect' }
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
    if (task.kind === 'goto') return goto(params, signal, progress)
    if (task.kind === 'patrol') {
      const points = Array.isArray(params.points) ? params.points : []
      for (const point of points) { checkAbort(signal); await goto(point, signal, progress) }
      return { points: points.length }
    }
    if (task.kind === 'explore') {
      const radius = Math.max(4, Number(params.radius) || 16)
      const base = bot.entity.position
      const target = { x: base.x + (Math.random() * 2 - 1) * radius, y: base.y, z: base.z + (Math.random() * 2 - 1) * radius }
      return goto(target, signal, progress)
    }
    if (task.kind === 'follow') {
      const player = bot.players[String(params.player ?? '')]
      if (!player?.entity) throw new Error('player not found')
      const pos = player.entity.position
      return goto({ x: pos.x, y: pos.y, z: pos.z, range: Number(params.range) || 3 }, signal, progress)
    }
    if (task.kind === 'chat') { await chat(String(params.text ?? '')); return { sent: true } }
    if (task.kind === 'routine') return routine(params, signal, progress)
    throw new Error(`unsupported task: ${task.kind}`)
  }

  async function returnToSafe() {
    if (!bot?.player || !safePoint) return { ok: false, reason: 'no-safe-point' }
    const pos = bot.entity?.position
    if (pos && Math.hypot(pos.x - safePoint.x, pos.y - safePoint.y, pos.z - safePoint.z) <= 2) return { ok: true, already: true }
    try {
      await goto({ ...safePoint, range: 2, timeoutMs: 10_000 }, new AbortController().signal, null)
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
      .filter((e) => e && e !== bot.entity && e.position)
      .filter((e) => !wanted || String(e.name ?? e.username ?? e.type ?? '').toLowerCase() === wanted || String(e.name ?? '').toLowerCase().includes(wanted))
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
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true)
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
      return runTask({ kind, params: taskParams }, { signal: new AbortController().signal, progress: null })
    }
    if (op === 'wait') { await sleep(Math.max(0, Math.min(30_000, Number(params.ms) || 500))); return { waited: true } }
    if (op === 'eat') {
      const foods = bot.registry.foodsByName ?? {}
      const found = (bot.inventory?.items?.() ?? []).find((i) => foods[i.name])
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
      const before = bot.blockAt(block.position)
      const tool = await equipBestTool(block, new AbortController().signal)
      await faceBlock(block)
      await bot.dig(block, true)
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
      const ref = bot.blockAt(new Vec3(Number(pos.x), Number(pos.y) - 1, Number(pos.z)))
      if (!ref) throw new Error('place: 目标下方没有参考方块')
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
      const tableBlock = bot.findBlock({ matching: bot.registry.blocksByName.crafting_table?.id, maxDistance: Number(params.radius) || 4 })
      const recipes = bot.recipesFor(def.id, null, Math.max(1, Number(params.count) || 1), tableBlock)
      if (!recipes.length) throw new Error(`没有可用配方：${name}（可能缺工作台/材料）`)
      await bot.craft(recipes[0], Math.max(1, Number(params.count) || 1), tableBlock)
      return { crafted: name, count: Math.max(1, Number(params.count) || 1) }
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
        if (params.action === 'list') return { items: container.containerItems().map((i) => ({ name: i.name, count: i.count })) }
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
        if (params.action === 'list' || !params.action) return { trades: (win.trades ?? []).map((t, index) => ({ index, input: t.inputItem1?.name, output: t.outputItem?.name })) }
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
        text: items.length ? items.map((i) => `${i.name} ×${i.count}`).join('、') : '背包是空的。',
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
        .filter((e) => e !== bot.entity && e.position)
        .map((e) => ({ name: e.name ?? e.username ?? e.type, distance: Math.round(e.position.distanceTo(pos) * 10) / 10 }))
        .sort((a, b) => a.distance - b.distance).slice(0, 6)
      return {
        text: [
          `位置：${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)}；朝向 yaw=${Math.round(bot.entity.yaw * 180 / Math.PI)}°`,
          `生命/饥饿/氧气：${bot.health}/${bot.food}/${Number.isFinite(bot.oxygenLevel) ? bot.oxygenLevel : '?'}`,
          `手持：${bot.heldItem?.name ?? '空'}`,
          `视线方块：${block ? `${block.name} @ ${block.position.x},${block.position.y},${block.position.z}` : '没有'}`,
          `附近：${entities.length ? entities.map((e) => `${e.name}(${e.distance}m)`).join('、') : '无'}`,
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
      const rows = hits.map((p) => ({ x: p.x, y: p.y, z: p.z, distance: Math.round(pos.distanceTo(p) * 10) / 10 })).sort((a, b) => a.distance - b.distance)
      return { text: rows.length ? rows.map((r) => `${name} @ ${r.x},${r.y},${r.z}（${r.distance}m）`).join('\n') : `附近没有 ${name}。`, data: { name, rows } }
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
