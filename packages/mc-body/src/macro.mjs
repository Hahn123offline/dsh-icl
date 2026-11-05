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
