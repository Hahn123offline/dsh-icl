import test from 'node:test'
import assert from 'node:assert/strict'
import {
  clampMacroNumbers, collectBlockCandidates, directionVector, MACRO_KINDS, progressEvery, shouldReportProgress,
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
