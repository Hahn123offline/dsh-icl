// 工具/装备的纯逻辑：方块需要什么工具、库存里最好的是哪把、缺工具时下一步做什么。
// 不依赖 mineflayer；mineflayer 适配器把 Item 对象喂进来，body/测试只关心名字与规则。
// 用户要求（2026-11-06）：模型要能看见、能自己选装备；脚本只在自动反应时兜底。

const PICKAXE_BLOCK = /(stone|_ore$|deepslate|cobblestone|cobbled_|blackstone|basalt|tuff|calcite|dripstone|andesite|diorite|granite|netherrack|quartz|prismarine|terracotta|obsidian|ancient_debris|iron_bars|rail|furnace|blast_furnace|concrete|brick|amethyst|copper_block|raw_iron_block|raw_copper_block|raw_gold_block|coal_block|iron_block|gold_block|diamond_block|emerald_block|lapis_block|redstone_block)/

const AXE_BLOCK = /(_log$|_wood$|planks|_fence|_door|_trapdoor|crafting_table|chest|trapped_chest|bookshelf|barrel|campfire|_sign$|ladder|beehive|bee_nest|mushroom_block|_stem$|_hyphae$)/

const SHOVEL_BLOCK = /(dirt|grass_block|coarse_dirt|rooted_dirt|podzol|mycelium|farmland|dirt_path|sand$|_sand$|gravel|clay|_snow$|snow_block|soul_soil|soul_sand|mud|muddy_mangrove_roots)/

const SHEARS_BLOCK = /(leaves|wool|vine|cobweb)/

export const TOOL_CLASSES = Object.freeze({
  pickaxe: /_pickaxe$/,
  axe: /_axe$/,
  shovel: /_shovel$/,
  hoe: /_hoe$/,
  sword: /_sword$/,
  shears: /^shears$/,
})

export const TIER_RANK = Object.freeze({ wooden: 1, golden: 1, stone: 2, iron: 3, diamond: 4, netherite: 5 })

export const TIER_NAME = Object.freeze({ 1: '木/金', 2: '石', 3: '铁', 4: '钻石', 5: '下界合金' })

/** 这个方块更偏好哪种工具（只用于“有就换上”，不代表必需）。 */
export function preferredToolClass(blockName) {
  const name = String(blockName ?? '')
  if (PICKAXE_BLOCK.test(name)) return 'pickaxe'
  if (AXE_BLOCK.test(name)) return 'axe'
  if (SHOVEL_BLOCK.test(name)) return 'shovel'
  if (SHEARS_BLOCK.test(name)) return 'shears'
  return null
}

/** 这个方块“必须用什么工具才能挖出东西”；null = 空手也能挖（慢）。 */
export function requiredToolClass(blockName) {
  const name = String(blockName ?? '')
  if (PICKAXE_BLOCK.test(name)) return 'pickaxe'
  return null
}

/** 挖这个方块至少需要的工具等级（1 木/金，2 石，3 铁，4 钻石）。空手方块返回 0。 */
export function requiredTierForBlock(blockName) {
  const name = String(blockName ?? '')
  if (!PICKAXE_BLOCK.test(name)) return 0
  if (/(obsidian|crying_obsidian|ancient_debris)/.test(name)) return 4
  if (/(diamond_ore|deepslate_diamond_ore|gold_ore|deepslate_gold_ore|redstone_ore|deepslate_redstone_ore|emerald_ore|deepslate_emerald_ore)/.test(name)) return 3
  if (/(iron_ore|deepslate_iron_ore|copper_ore|deepslate_copper_ore|lapis_ore|deepslate_lapis_ore)/.test(name)) return 2
  return 1
}

export function toolClassOfItem(itemName) {
  const name = String(itemName ?? '')
  for (const [className, pattern] of Object.entries(TOOL_CLASSES)) {
    if (pattern.test(name)) return className
  }
  return null
}

export function toolTier(itemName) {
  const name = String(itemName ?? '')
  const match = name.match(/^(wooden|golden|stone|iron|diamond|netherite)_/)
  return match ? (TIER_RANK[match[1]] ?? 0) : 0
}

/** 物品的工具信息：给 inventory 展示与“当前手持能不能用”判断。 */
export function describeItemTool(itemOrName) {
  const name = typeof itemOrName === 'string' ? itemOrName : itemOrName?.name
  const className = toolClassOfItem(name)
  if (!className) return { toolFor: null, tier: 0, tierName: null }
  const tier = toolTier(name)
  return { toolFor: className, tier, tierName: TIER_NAME[tier] ?? null }
}

/**
 * 从库存里挑最合适的工具。items: [{ name, count, slot? }]（任何带 name 的对象）。
 * 返回 { item, className, tier, adequate }；adequate=false 表示有该类工具但等级不够。
 */
export function pickBestTool(items, blockName) {
  const className = requiredToolClass(blockName) ?? preferredToolClass(blockName)
  if (!className) return null
  const requiredTier = requiredTierForBlock(blockName)
  const candidates = (Array.isArray(items) ? items : [])
    .filter((item) => toolClassOfItem(item?.name) === className)
    .map((item) => ({ item, tier: toolTier(item?.name) }))
    .sort((a, b) => b.tier - a.tier || String(a.item?.name).localeCompare(String(b.item?.name)))
  if (!candidates.length) return { item: null, className, tier: 0, adequate: false, requiredTier }
  const best = candidates[0]
  return { item: best.item, className, tier: best.tier, adequate: requiredTier === 0 || best.tier >= requiredTier, requiredTier }
}

export function requiredTierName(blockName) {
  const tier = requiredTierForBlock(blockName)
  return tier > 0 ? (TIER_NAME[tier] ?? String(tier)) : null
}

/** 工具类的中文名（给模型看的错误文案）。 */
export function toolClassNameCn(className) {
  return ({ pickaxe: '镐', axe: '斧', shovel: '锹', shears: '剪刀', hoe: '锄', sword: '剑' })[className] ?? '工具'
}

/**
 * 缺工具时给“下一步做什么”（可执行、别让她原地重试）。
 * counts: { oak_log: 8, cobblestone: 2, ... } 之类的库存计数（可选，用于判断能不能现做）。
 */
export function suggestToolCraft(className, requiredTier, counts = {}) {
  const tier = Math.max(1, Number(requiredTier) || 1)
  const tierPrefix = tier <= 1 ? 'wooden' : tier === 2 ? 'stone' : tier === 3 ? 'iron' : 'diamond'
  if (className === 'pickaxe') {
    if (tier === 1) {
      return {
        craft: 'wooden_pickaxe',
        steps: [
          '没有木板/木棍就先补：craft oak_planks（1 原木=4 木板）→ craft stick（2 木板=4 木棍）',
          'craft wooden_pickaxe（3 木板+2 木棍）',
          'mcb_do equip {"item":"wooden_pickaxe"} 换上镐再回来',
        ],
      }
    }
    if (tier === 2) {
      return {
        craft: 'stone_pickaxe',
        steps: [
          '先用木镐 mine stone 拿 cobblestone（3 个）',
          'craft stone_pickaxe（3 cobblestone+2 stick；没有木棍先 craft stick）',
          'mcb_do equip {"item":"stone_pickaxe"} 换上石镐',
        ],
      }
    }
    if (tier === 3) {
      return { craft: 'iron_pickaxe', steps: ['先 mine iron_ore（需要石镐）', 'furnace 烧 raw_iron + coal 成 iron_ingot', 'craft iron_pickaxe（3 iron_ingot+2 stick）'] }
    }
    return { craft: 'diamond_pickaxe', steps: ['需要钻石镐（钻石+木棍）或换目标方块'] }
  }
  if (className === 'axe') return { craft: `${tierPrefix}_axe`, steps: [`craft ${tierPrefix}_axe`, 'mcb_do equip 换上斧', '再回来挖木头'] }
  if (className === 'shovel') return { craft: `${tierPrefix}_shovel`, steps: [`craft ${tierPrefix}_shovel`, 'mcb_do equip 换上锹'] }
  if (className === 'shears') return { craft: 'shears', steps: ['craft shears（2 iron_ingot）或空手挖'] }
  return { craft: null, steps: [] }
}

