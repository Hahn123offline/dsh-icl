import test from 'node:test'
import assert from 'node:assert/strict'
import {
  chooseRecipeVariant, describeItemTool, pickBestTool, preferredToolClass, requiredTierForBlock, requiredToolClass, suggestToolCraft, toolClassOfItem, toolTier,
} from '../src/tools.mjs'

test('tools：方块偏好的工具类', () => {
  assert.equal(preferredToolClass('stone'), 'pickaxe')
  assert.equal(preferredToolClass('iron_ore'), 'pickaxe')
  assert.equal(preferredToolClass('oak_log'), 'axe')
  assert.equal(preferredToolClass('dirt'), 'shovel')
  assert.equal(preferredToolClass('oak_leaves'), 'shears')
  assert.equal(preferredToolClass('crafting_table'), 'axe')
  assert.equal(preferredToolClass('torch'), null)
})

test('tools：必需工具（空手挖不出来）与所需等级', () => {
  assert.equal(requiredToolClass('stone'), 'pickaxe')
  assert.equal(requiredToolClass('iron_ore'), 'pickaxe')
  assert.equal(requiredToolClass('obsidian'), 'pickaxe')
  assert.equal(requiredToolClass('dirt'), null)
  assert.equal(requiredToolClass('oak_log'), null)
  assert.equal(requiredTierForBlock('stone'), 1)
  assert.equal(requiredTierForBlock('cobblestone'), 1)
  assert.equal(requiredTierForBlock('iron_ore'), 2)
  assert.equal(requiredTierForBlock('gold_ore'), 3)
  assert.equal(requiredTierForBlock('redstone_ore'), 3)
  assert.equal(requiredTierForBlock('obsidian'), 4)
  assert.equal(requiredTierForBlock('dirt'), 0)
})

test('tools：物品的工具类与等级', () => {
  assert.equal(toolClassOfItem('wooden_pickaxe'), 'pickaxe')
  assert.equal(toolClassOfItem('stone_shovel'), 'shovel')
  assert.equal(toolClassOfItem('diamond_axe'), 'axe')
  assert.equal(toolClassOfItem('shears'), 'shears')
  assert.equal(toolClassOfItem('dirt'), null)
  assert.equal(toolTier('wooden_pickaxe'), 1)
  assert.equal(toolTier('golden_pickaxe'), 1)
  assert.equal(toolTier('stone_pickaxe'), 2)
  assert.equal(toolTier('iron_pickaxe'), 3)
  assert.equal(toolTier('diamond_pickaxe'), 4)
  assert.deepEqual(describeItemTool('iron_axe'), { toolFor: 'axe', tier: 3, tierName: '铁' })
  assert.deepEqual(describeItemTool('dirt'), { toolFor: null, tier: 0, tierName: null })
})

test('tools：pickBestTool 选最合适的工具并按方块门槛判断够不够', () => {
  const inventory = [
    { name: 'dirt', count: 8 },
    { name: 'wooden_pickaxe', count: 1 },
    { name: 'stone_pickaxe', count: 1 },
    { name: 'stone_axe', count: 1 },
  ]
  const stone = pickBestTool(inventory, 'stone')
  assert.equal(stone.item.name, 'stone_pickaxe')
  assert.equal(stone.adequate, true)
  assert.equal(stone.requiredTier, 1)

  // 铁矿石需要石镐：只有木镐时 adequate=false（能挖但没掉落，必须换）
  const ironWithWood = pickBestTool([{ name: 'wooden_pickaxe' }], 'iron_ore')
  assert.equal(ironWithWood.item.name, 'wooden_pickaxe')
  assert.equal(ironWithWood.adequate, false)
  assert.equal(ironWithWood.requiredTier, 2)

  // 木/土：没有对应工具时 item=null 但 adequate=false 只表示“没有更好的”；不阻塞空手
  const dirt = pickBestTool([{ name: 'stone_shovel' }], 'dirt')
  assert.equal(dirt.item.name, 'stone_shovel')
  assert.equal(dirt.adequate, true)
  const wood = pickBestTool([{ name: 'stone_axe' }], 'oak_log')
  assert.equal(wood.item.name, 'stone_axe')
  assert.equal(wood.adequate, true)
  assert.equal(pickBestTool([{ name: 'dirt' }], 'stone').item, null)
  assert.equal(pickBestTool([{ name: 'dirt' }], 'stone').adequate, false)
})

test('tools：缺工具建议是可执行链条', () => {
  const woodPick = suggestToolCraft('pickaxe', 1)
  assert.equal(woodPick.craft, 'wooden_pickaxe')
  assert.ok(woodPick.steps.some((step) => step.includes('oak_planks')))
  const stonePick = suggestToolCraft('pickaxe', 2)
  assert.equal(stonePick.craft, 'stone_pickaxe')
  assert.ok(stonePick.steps.some((step) => step.includes('cobblestone')))
  const axe = suggestToolCraft('axe', 1)
  assert.equal(axe.craft, 'wooden_axe')
  assert.equal(suggestToolCraft(null, 0).craft, null)
})

test('tools：多配方变体选缺料最少（oak 工具不再误报 pale_oak_planks）', () => {
  const registryNames = { 1: 'oak_planks', 2: 'stick', 3: 'pale_oak_planks' }
  const variants = [
    { requiresTable: true, result: { count: 1 }, delta: [{ id: 3, count: -3 }, { id: 2, count: -2 }] }, // pale oak 变体
    { requiresTable: true, result: { count: 1 }, delta: [{ id: 1, count: -3 }, { id: 2, count: -2 }] }, // oak 变体
  ]
  const nameOf = (id) => registryNames[id]
  const counts = { oak_planks: 8, stick: 0, pale_oak_planks: 0 }
  const countOf = (name) => counts[name] ?? 0
  const best = chooseRecipeVariant(variants, { count: 1, nameOf, countOf })
  assert.ok(best)
  // oak 变体只缺 stick×2（short 2）；pale 变体缺 planks×3 + stick×2（short 5）→ 选 oak
  assert.deepEqual(best.missing.map((entry) => [entry.name, entry.short]), [['stick', 2]])
  assert.equal(best.short, 2)
  // 都齐 → short 0
  const complete = chooseRecipeVariant(variants, { count: 1, nameOf, countOf: (name) => (name === 'stick' ? 9 : counts[name] ?? 0) })
  assert.equal(complete.short, 0)
})

