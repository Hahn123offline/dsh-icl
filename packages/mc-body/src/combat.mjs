// 战斗/威胁判断的纯逻辑：敌对识别、威胁评估、战斗中断判据、武器选择。
// 契约见 docs/MC-COMBAT.md；不依赖 mineflayer，便于单测。

export const HOSTILE_NAMES = Object.freeze([
  'zombie', 'husk', 'drowned', 'skeleton', 'stray', 'creeper', 'spider', 'cave_spider',
  'witch', 'pillager', 'vindicator', 'evoker', 'ravager', 'phantom', 'slime', 'magma_cube',
  'enderman', 'blaze', 'ghast', 'hoglin', 'piglin_brute', 'zoglin', 'silverfish', 'endermite',
])

const HOSTILE_SET = new Set(HOSTILE_NAMES)

export function isHostile(name) {
  return HOSTILE_SET.has(String(name ?? '').toLowerCase())
}

/** 规范化 status.nearbyHostiles / 实体列表 → [{name,distance,position?}]。 */
export function normalizeHostiles(list) {
  return (Array.isArray(list) ? list : [])
    .map((entry) => ({
      name: String(entry?.name ?? entry?.username ?? entry?.type ?? '').toLowerCase(),
      distance: Number(entry?.distance),
      position: entry?.position ?? null,
    }))
    .filter((entry) => entry.name && Number.isFinite(entry.distance))
    .sort((a, b) => a.distance - b.distance)
}

/**
 * 威胁评估（自动躲避/战斗危机共用）：
 * - creeper 在 creeperDistance 内 → 最高危（会炸）
 * - 任一敌对在 threatDistance 内 → threat-near
 * - threatDistance 内敌数 ≥ maxHostiles → too-many
 * - 血量 ≤ lowHealth → low-health
 * 返回 {dangerous, level, reasons[], nearest, creeper, count, health}
 */
export function threatAssessment(hostiles, {
  threatDistance = 6, creeperDistance = 6, maxHostiles = 3, health = null, lowHealth = 10,
} = {}) {
  const list = normalizeHostiles(hostiles).filter((entry) => isHostile(entry.name))
  const reasons = []
  const nearest = list[0] ?? null
  const creeper = list.find((entry) => entry.name === 'creeper' && entry.distance <= creeperDistance) ?? null
  const near = list.filter((entry) => entry.distance <= threatDistance)
  if (creeper) reasons.push('creeper-near')
  else if (nearest && nearest.distance <= threatDistance) reasons.push('threat-near')
  if (near.length >= maxHostiles) reasons.push('too-many')
  const hp = Number(health)
  if (Number.isFinite(hp) && hp > 0 && hp <= lowHealth) reasons.push('low-health')
  const level = creeper ? 'critical' : (near.length || reasons.length ? 'danger' : 'safe')
  return { dangerous: reasons.length > 0, level, reasons, nearest, creeper, count: near.length, health: Number.isFinite(hp) ? hp : null }
}

/** 战斗是否必须立刻中断（低血/多敌/苦力怕近身）。返回 {abort, reason, flee}。 */
export function shouldAbortCombat({ health = null, hostiles = [], lowHealth = 10, maxHostiles = 3, creeperDistance = 5 } = {}) {
  const assessment = threatAssessment(hostiles, { threatDistance: 8, creeperDistance, maxHostiles, health, lowHealth })
  if (assessment.reasons.includes('low-health')) return { abort: true, reason: 'low-health', flee: true, assessment }
  if (assessment.reasons.includes('creeper-near')) return { abort: true, reason: 'creeper-near', flee: true, assessment }
  if (assessment.reasons.includes('too-many')) return { abort: true, reason: 'too-many', flee: true, assessment }
  return { abort: false, reason: null, flee: false, assessment }
}

const TIER_RANK = { wooden: 1, golden: 1, stone: 2, iron: 3, diamond: 4, netherite: 5 }

/** 选武器：剑优先（按材质等级），没有剑用斧；空手返回 null。 */
export function chooseWeaponItem(items) {
  const list = (Array.isArray(items) ? items : []).filter((item) => item?.name)
  const rank = (name) => {
    const match = String(name).match(/^(wooden|golden|stone|iron|diamond|netherite)_(sword|axe)$/)
    return match ? (TIER_RANK[match[1]] ?? 0) : 0
  }
  const swords = list.filter((item) => /_sword$/.test(item.name)).sort((a, b) => rank(b.name) - rank(a.name))
  if (swords.length) return { item: swords[0], kind: 'sword', tier: rank(swords[0].name) }
  const axes = list.filter((item) => /_axe$/.test(item.name)).sort((a, b) => rank(b.name) - rank(a.name))
  if (axes.length) return { item: axes[0], kind: 'axe', tier: rank(axes[0].name) }
  return null
}

/** 找目标：nearest_hostile（默认）/ 指定实体名。返回 {entity|hostile|null}。 */
export function pickTarget(hostiles, target = 'nearest_hostile') {
  const list = normalizeHostiles(hostiles).filter((entry) => entry.name && isHostile(entry.name))
  const wanted = String(target ?? 'nearest_hostile').toLowerCase()
  if (wanted === 'nearest_hostile' || wanted === 'nearest' || wanted === 'hostile') return list[0] ?? null
  return list.find((entry) => entry.name === wanted) ?? null
}


/** 解析 target 参数：字符串（nearest/nearest_hostile/实体名/nearest:name）或对象 {entity|name}。 */
export function parseTargetSpec(target) {
  const raw = typeof target === 'string' ? target : (target?.entity ?? target?.name ?? 'nearest')
  const key = String(raw ?? '').trim().toLowerCase()
  if (!key || key === 'nearest') return { mode: 'nearest', name: '' }
  if (key.startsWith('nearest:')) return { mode: 'nearest', name: key.slice('nearest:'.length) }
  if (key === 'nearest_hostile' || key === 'hostile' || key === 'nearest-hostile') return { mode: 'nearest_hostile', name: '' }
  return { mode: 'name', name: key }
}
