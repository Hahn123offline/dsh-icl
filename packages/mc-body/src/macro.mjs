// 宏操作（collect/tunnel/build…）的纯逻辑：方向解析、参数边界、物品→目标方块、进度限频。
// 契约见 docs/MC-MACRO.md；这里不依赖 mineflayer，便于单测。

export const MACRO_KINDS = Object.freeze(['collect', 'tunnel', 'bridge', 'build', 'sort', 'shelter', 'farm'])

const DIRECTIONS = Object.freeze({
  north: { x: 0, z: -1 },
  south: { x: 0, z: 1 },
  east: { x: 1, z: 0 },
  west: { x: -1, z: 0 },
})

/** 方向解析：支持 north/south/east/west 或 {dx,dz}（任选其一非零）。 */
export function directionVector(params = {}) {
  const raw = String(params.direction ?? '').toLowerCase()
  if (DIRECTIONS[raw]) return { ...DIRECTIONS[raw], name: raw }
  const dx = Math.sign(Number(params.dx) || 0)
  const dz = Math.sign(Number(params.dz) || 0)
  if ((dx === 0) === (dz === 0)) throw new Error('tunnel/bridge 需要 direction（north/south/east/west）或 dx/dz 中恰好一个非零')
  const name = dx === 1 ? 'east' : dx === -1 ? 'west' : dz === 1 ? 'south' : 'north'
  return { x: dx, z: dz, name }
}

/** 宏参数边界（越界抛错，400 由 body 层给）。 */
export function clampMacroNumbers(params = {}) {
  return {
    length: Math.max(1, Math.min(128, Number(params.length) || 8)),
    height: Math.max(1, Math.min(4, Number(params.height) || 2)),
    width: Math.max(1, Math.min(8, Number(params.width) || 1)),
    torchEvery: Math.max(0, Math.min(32, Number(params.torchEvery) || 6)),
    stairs: params.stairs === true,
  }
}

/**
 * 物品名 → 可挖的方块名候选（按顺序尝试）。
 * 支持方块名本身、常见掉落物名（cobblestone→stone、coal→coal_ore、raw_iron→iron_ore…）。
 */
export function collectBlockCandidates(item) {
  const name = String(item ?? '').trim().toLowerCase()
  if (!name) return []
  const map = {
    cobblestone: ['stone'],
    stone: ['stone'],
    coal: ['coal_ore', 'deepslate_coal_ore'],
    charcoal: ['coal_ore'],
    raw_iron: ['iron_ore', 'deepslate_iron_ore'],
    iron_ore: ['iron_ore', 'deepslate_iron_ore'],
    iron_ingot: ['iron_ore', 'deepslate_iron_ore'],
    raw_copper: ['copper_ore', 'deepslate_copper_ore'],
    copper_ore: ['copper_ore', 'deepslate_copper_ore'],
    raw_gold: ['gold_ore', 'deepslate_gold_ore'],
    gold_ore: ['gold_ore', 'deepslate_gold_ore'],
    diamond: ['diamond_ore', 'deepslate_diamond_ore'],
    redstone: ['redstone_ore', 'deepslate_redstone_ore'],
    lapis_lazuli: ['lapis_ore', 'deepslate_lapis_ore'],
    emerald: ['emerald_ore', 'deepslate_emerald_ore'],
    oak_planks: ['oak_log'],
    spruce_planks: ['spruce_log'],
    birch_planks: ['birch_log'],
    jungle_planks: ['jungle_log'],
    acacia_planks: ['acacia_log'],
    dark_oak_planks: ['dark_oak_log'],
    pale_oak_planks: ['pale_oak_log'],
    stick: ['oak_log'],
    dirt: ['dirt', 'grass_block'],
    sand: ['sand'],
    gravel: ['gravel'],
    clay_ball: ['clay'],
    wheat: ['wheat'],
    wheat_seeds: ['grass_block'],
  }
  if (map[name]) return map[name]
  // 原木/木材：任何 *_log
  return [name]
}

/** 进度限频：每 max(1, ceil(total/10)) 步或每 10s 报一次。 */
export function progressEvery(total) {
  const all = Math.max(1, Number(total) || 1)
  return Math.max(1, Math.ceil(all / 10))
}

export function shouldReportProgress(done, lastReportAt, now = Date.now(), intervalMs = 10_000) {
  return now - (lastReportAt ?? 0) >= intervalMs
}

/** 桥面每步要铺的格子（相对起点的 dx/dz 偏移，宽度沿方向垂直展开）。 */
export function bridgePlan(params = {}) {
  const dir = directionVector(params)
  const opts = clampMacroNumbers(params)
  const perp = { x: -dir.z, z: dir.x } // 方向的垂直方向（宽度展开）
  const cells = []
  for (let step = 1; step <= opts.length; step += 1) {
    for (let w = 0; w < opts.width; w += 1) {
      const offset = w - Math.floor((opts.width - 1) / 2)
      cells.push({
        step,
        offset,
        x: dir.x * step + perp.x * offset,
        z: dir.z * step + perp.z * offset,
        // 支撑方块放在“前进格脚下”（y-1），由调用方按世界坐标 y 换算
        yOffset: -1,
      })
    }
  }
  return { direction: dir.name, length: opts.length, width: opts.width, cells }
}

/**
 * 蓝图解析/校验（build 用）。layers[y][z][x]，palette char→方块名或 null。
 * 返回 { size, materials, placements }；placements 带相对坐标（origin 由调用方加）。
 */
export function parseBlueprint(blueprint) {
  if (!blueprint || typeof blueprint !== 'object') throw new Error('build 需要 blueprint 对象')
  const size = blueprint.size ?? {}
  const sx = Math.max(1, Number(size.x) || 0)
  const sy = Math.max(1, Number(size.y) || 0)
  const sz = Math.max(1, Number(size.z) || 0)
  if (!sx || !sy || !sz) throw new Error('blueprint.size 需要 x/y/z 正整数')
  if (!Array.isArray(blueprint.layers)) throw new Error('blueprint.layers 需要数组')
  if (blueprint.layers.length !== sy) throw new Error(`blueprint.layers 层数 ${blueprint.layers.length} 与 size.y ${sy} 不一致`)
  const palette = blueprint.palette ?? {}
  const materials = {}
  const placements = []
  for (let y = 0; y < sy; y += 1) {
    const layer = blueprint.layers[y]
    if (!Array.isArray(layer) || layer.length !== sz) throw new Error(`layers[${y}] 需要 ${sz} 行（z）`)
    for (let z = 0; z < sz; z += 1) {
      const row = String(layer[z] ?? '')
      if (row.length !== sx) throw new Error(`layers[${y}][${z}] 需要 ${sx} 列（x），实际 ${row.length}`)
      for (let x = 0; x < sx; x += 1) {
        const char = row[x]
        const block = palette[char]
        if (block == null || block === '' || block === ' ') continue
        materials[block] = (materials[block] ?? 0) + 1
        placements.push({ name: block, pos: { x, y, z } })
      }
    }
  }
  return { size: { x: sx, y: sy, z: sz }, materials, placements }
}

/** 检查蓝图材料是否够（counts: {block:count}）。返回 {ok, missing:[{name,need,have}]}。 */
export function checkBlueprintMaterials(blueprint, counts = {}) {
  const { materials } = parseBlueprint(blueprint)
  const missing = Object.entries(materials)
    .map(([name, need]) => ({ name, need, have: Number(counts[name]) || 0 }))
    .filter((entry) => entry.have < entry.need)
  return { ok: missing.length === 0, missing, materials }
}

/**
 * shelter 参数：size 边长最小 3，门开在朝向 origin 的一侧；返回 {size, height, cells}。
 * 仅给出“要放哪些格子”的占位契约，实际放置由明早实现处理。
 */
export function shelterPlan(params = {}) {
  const size = Math.max(3, Math.min(9, Number(params.size) || 3))
  const height = Math.max(2, Math.min(4, Number(params.height) || 3))
  const cells = []
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < size; x += 1) {
      for (let z = 0; z < size; z += 1) {
        const wall = x === 0 || x === size - 1 || z === 0 || z === size - 1
        const roof = y === height - 1
        const door = x === Math.floor(size / 2) && z === 0 && y < 2
        if ((wall || roof) && !door) cells.push({ x, y, z })
      }
    }
  }
  return { size, height, door: { x: Math.floor(size / 2), z: 0, y: [0, 1] }, cells }
}


/** collect 资源枯竭 fallback：候选方块跑完后逐级扩大搜索半径（最多 48）。 */
export function collectRadiusPlan(radius = 16) {
  const base = Math.max(2, Math.min(48, Number(radius) || 16))
  return [...new Set([base, Math.min(48, Math.max(base + 8, Math.round(base * 1.5))), 48].map((value) => Math.max(2, Math.min(48, value))))]
}

/** collect 的失败是否全部属于“附近没资源”（用于给 no-resources 而不是原始 no-target）。 */
export function collectAttemptsAreNoTarget(attempts = []) {
  return attempts.length > 0 && attempts.every((entry) => /no-target|no-resource|附近没有/.test(String(entry?.error ?? '')))
}
