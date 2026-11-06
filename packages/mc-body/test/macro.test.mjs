import test from 'node:test'
import assert from 'node:assert/strict'
import {
  bridgePlan, checkBlueprintMaterials, clampMacroNumbers, parseBlueprint, shelterPlan, collectBlockCandidates, collectRadiusPlan, collectAttemptsAreNoTarget, directionVector, MACRO_KINDS, progressEvery, shouldReportProgress,
} from '../src/macro.mjs'

test('macro：方向解析（north=-Z, east=+X）', () => {
  assert.deepEqual(directionVector({ direction: 'north' }), { x: 0, z: -1, name: 'north' })
  assert.deepEqual(directionVector({ direction: 'east' }), { x: 1, z: 0, name: 'east' })
  assert.deepEqual(directionVector({ dx: -1, dz: 0 }), { x: -1, z: 0, name: 'west' })
  assert.deepEqual(directionVector({ dx: 0, dz: 1 }), { x: 0, z: 1, name: 'south' })
  assert.throws(() => directionVector({}), /direction/)
  assert.throws(() => directionVector({ dx: 1, dz: 1 }), /direction/)
})

test('macro：参数边界与默认值', () => {
  assert.deepEqual(clampMacroNumbers({ length: 999, height: 9, width: 99, torchEvery: 99 }), { length: 128, height: 4, width: 8, torchEvery: 32, stairs: false })
  assert.deepEqual(clampMacroNumbers({}), { length: 8, height: 2, width: 1, torchEvery: 6, stairs: false })
  assert.equal(clampMacroNumbers({ length: -3 }).length, 1)
})

test('macro：物品→方块候选（掉落物名映射）', () => {
  assert.deepEqual(collectBlockCandidates('oak_log'), ['oak_log'])
  assert.deepEqual(collectBlockCandidates('cobblestone'), ['stone'])
  assert.deepEqual(collectBlockCandidates('coal'), ['coal_ore', 'deepslate_coal_ore'])
  assert.deepEqual(collectBlockCandidates('raw_iron'), ['iron_ore', 'deepslate_iron_ore'])
  assert.deepEqual(collectBlockCandidates('diamond'), ['diamond_ore', 'deepslate_diamond_ore'])
  assert.deepEqual(collectBlockCandidates('oak_planks'), ['oak_log'])
  assert.deepEqual(collectBlockCandidates(''), [])
})

test('macro：已知宏种类 + 进度限频', () => {
  assert.deepEqual([...MACRO_KINDS].sort(), ['bridge', 'build', 'collect', 'farm', 'shelter', 'sort', 'tunnel'].sort())
  assert.equal(progressEvery(8), 1)
  assert.equal(progressEvery(50), 5)
  assert.equal(progressEvery(100), 10)
  assert.equal(progressEvery(0), 1)
  assert.equal(shouldReportProgress(1, null), true)
  assert.equal(shouldReportProgress(1, Date.now(), Date.now()), false)
  assert.equal(shouldReportProgress(1, 0, 20_000), true)
})

test('macro：bridge 桥面格子按方向+宽度展开', () => {
  const plan = bridgePlan({ direction: 'north', length: 3, width: 1 })
  assert.equal(plan.direction, 'north')
  assert.equal(plan.cells.length, 3)
  assert.deepEqual(plan.cells.map((cell) => [cell.x, cell.z]), [[0, -1], [0, -2], [0, -3]])
  const wide = bridgePlan({ direction: 'east', length: 2, width: 3 })
  assert.equal(wide.cells.length, 6)
  // 宽度沿垂直方向（east 的垂直是 ±z）：step1 offset -1/0/1
  const step1 = wide.cells.filter((cell) => cell.step === 1).map((cell) => [cell.x, cell.z])
  assert.deepEqual(step1.sort(), [[1, -1], [1, 0], [1, 1]])
})

test('macro：蓝图解析/材料校验/shelter 占位', () => {
  const blueprint = {
    size: { x: 3, y: 2, z: 3 },
    palette: { '#': 'oak_planks', '.': null },
    layers: [
      ['###', '###', '###'],
      ['#.#', '#.#', '#.#'],
    ],
  }
  const parsed = parseBlueprint(blueprint)
  assert.deepEqual(parsed.size, { x: 3, y: 2, z: 3 })
  assert.equal(parsed.materials.oak_planks, 9 + 6)
  assert.equal(parsed.placements.length, 15)
  assert.deepEqual(checkBlueprintMaterials(blueprint, { oak_planks: 15 }), { ok: true, missing: [], materials: { oak_planks: 15 } })
  const missing = checkBlueprintMaterials(blueprint, { oak_planks: 5 })
  assert.equal(missing.ok, false)
  assert.deepEqual(missing.missing, [{ name: 'oak_planks', need: 15, have: 5 }])
  assert.throws(() => parseBlueprint({ size: { x: 2, y: 1, z: 2 }, palette: {}, layers: [['##']] }), /需要 2 行/)
  assert.throws(() => parseBlueprint({ size: { x: 2, y: 2, z: 2 }, palette: {}, layers: [['##']] }), /层数/)

  const shelter = shelterPlan({ size: 3, height: 3 })
  assert.equal(shelter.size, 3)
  assert.ok(shelter.cells.length > 0)
  assert.ok(shelter.cells.every((cell) => cell.x >= 0 && cell.y >= 0 && cell.z >= 0))
  // 门在 z=0 中间、y0-1 被排除
  assert.ok(!shelter.cells.some((cell) => cell.x === 1 && cell.z === 0 && cell.y < 2))
})




test('macro：collect 资源枯竭 fallback（逐级扩大半径 / 判定 no-resources）', () => {
  assert.deepEqual(collectRadiusPlan(16), [16, 24, 48])
  assert.deepEqual(collectRadiusPlan(4), [4, 12, 48])
  assert.deepEqual(collectRadiusPlan(48), [48])
  assert.equal(collectAttemptsAreNoTarget([{ error: 'mine: no-target' }, { error: 'mine: no-target' }]), true)
  assert.equal(collectAttemptsAreNoTarget([{ error: 'mine: no-target' }, { error: 'mine: no-path' }]), false)
  assert.equal(collectAttemptsAreNoTarget([]), false)
})
