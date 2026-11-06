import test from 'node:test'
import assert from 'node:assert/strict'
import {
  chooseWeaponItem, isHostile, normalizeHostiles, pickTarget, shouldAbortCombat, threatAssessment,
} from '../src/combat.mjs'

test('combat：敌对识别/规范化/目标选择', () => {
  assert.equal(isHostile('zombie'), true)
  assert.equal(isHostile('Creeper'), true)
  assert.equal(isHostile('cow'), false)
  assert.equal(isHostile(''), false)
  const list = normalizeHostiles([
    { name: 'zombie', distance: 12 } || {},
    { name: 'skeleton', distance: 4 },
    { name: 'creeper', distance: 6 },
    { name: 'cow', distance: 1 },
    { name: '', distance: 2 },
    null,
  ])
  assert.deepEqual(list.map((entry) => entry.name), ['cow', 'skeleton', 'creeper', 'zombie']) // normalize 只排序，不筛 hostile
  assert.equal(pickTarget([{ name: 'zombie', distance: 9 }, { name: 'skeleton', distance: 3 }]).name, 'skeleton')
  assert.equal(pickTarget([{ name: 'zombie', distance: 9 }], 'zombie').name, 'zombie')
  assert.equal(pickTarget([{ name: 'zombie', distance: 9 }], 'spider'), null)
})

test('combat：威胁评估（苦力怕最高危 / 近身 / 多敌 / 低血）', () => {
  const safe = threatAssessment([{ name: 'zombie', distance: 20 }], { threatDistance: 6, creeperDistance: 6, health: 20, lowHealth: 10 })
  assert.equal(safe.dangerous, false)
  assert.equal(safe.level, 'safe')

  const near = threatAssessment([{ name: 'zombie', distance: 5 }], { threatDistance: 6, health: 20 })
  assert.equal(near.dangerous, true)
  assert.deepEqual(near.reasons, ['threat-near'])

  const creeper = threatAssessment([{ name: 'creeper', distance: 5 }], { threatDistance: 6, creeperDistance: 6, health: 20 })
  assert.equal(creeper.level, 'critical')
  assert.ok(creeper.reasons.includes('creeper-near'))

  const many = threatAssessment([
    { name: 'zombie', distance: 4 }, { name: 'skeleton', distance: 5 }, { name: 'spider', distance: 6 },
  ], { threatDistance: 6, maxHostiles: 3, health: 20 })
  assert.ok(many.reasons.includes('too-many'))

  const low = threatAssessment([], { health: 6, lowHealth: 10 })
  assert.ok(low.reasons.includes('low-health'))
  assert.equal(low.dangerous, true)
})

test('combat：战斗中断判据（低血 > 苦力怕 > 多敌）', () => {
  assert.equal(shouldAbortCombat({ health: 20, hostiles: [] }).abort, false)
  const low = shouldAbortCombat({ health: 6, hostiles: [], lowHealth: 10 })
  assert.equal(low.abort, true)
  assert.equal(low.reason, 'low-health')
  assert.equal(low.flee, true)
  const creeper = shouldAbortCombat({ health: 20, hostiles: [{ name: 'creeper', distance: 4 }], creeperDistance: 5 })
  assert.equal(creeper.reason, 'creeper-near')
  const many = shouldAbortCombat({ health: 20, hostiles: [{ name: 'zombie', distance: 3 }, { name: 'zombie', distance: 4 }, { name: 'zombie', distance: 5 }], maxHostiles: 3 })
  assert.equal(many.reason, 'too-many')
})

test('combat：武器选择优先剑、其次斧、空手 null', () => {
  assert.equal(chooseWeaponItem([{ name: 'dirt' }]), null)
  assert.equal(chooseWeaponItem([{ name: 'wooden_axe' }]).kind, 'axe')
  assert.equal(chooseWeaponItem([{ name: 'stone_axe' }, { name: 'iron_sword' }]).item.name, 'iron_sword')
  assert.equal(chooseWeaponItem([{ name: 'netherite_sword' }, { name: 'diamond_sword' }]).item.name, 'netherite_sword')
  assert.equal(chooseWeaponItem([{ name: 'golden_axe' }, { name: 'stone_axe' }]).item.name, 'stone_axe')
})

