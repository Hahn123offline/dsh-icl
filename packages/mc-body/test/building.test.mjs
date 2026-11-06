import test from 'node:test'
import assert from 'node:assert/strict'
import { isAirName, isSolidName, makeShelterSpec, shelterBuildOrder, shelterMaterialReport, verifyShelter } from '../src/building.mjs'

function buildBlockMap(spec, { skip = [], extra = {} } = {}) {
  const map = new Map()
  const key = (x, y, z) => `${x},${y},${z}`
  for (const cell of spec.walls) map.set(key(cell.x, cell.y, cell.z), 'oak_planks')
  for (const cell of spec.roof) map.set(key(cell.x, cell.y, cell.z), 'oak_planks')
  for (const cell of spec.floor) map.set(key(cell.x, cell.y, cell.z), 'grass_block')
  for (const [k, v] of Object.entries(extra)) map.set(k, v)
  for (const cell of skip) map.delete(key(cell.x, cell.y, cell.z))
  return (x, y, z) => map.get(key(x, y, z)) ?? 'air'
}

test('building：3×3 小屋规格（墙/门洞/屋顶/室内 2 格高/地面/入口点）', () => {
  const spec = makeShelterSpec({ size: 3, height: 3, doorSide: 'south', material: 'dark_oak_planks' })
  assert.equal(spec.width, 3)
  assert.equal(spec.height, 3)
  assert.equal(spec.interiorHeight, 2)
  assert.equal(spec.doorSide, 'south')
  // 墙：3 层周长 8*3=24 - 门洞 2 = 22
  assert.equal(spec.walls.length, 16 - 2)
  assert.equal(spec.door.length, 2)
  assert.equal(spec.roof.length, 9)
  assert.equal(spec.interior.length, 2) // 3x3 内部 1x1，两层
  assert.equal(spec.floor.length, 1)
  assert.deepEqual(spec.doorCell, { x: 1, y: 0, z: 2 })
  assert.deepEqual(spec.inside, { x: 1, y: 0, z: 1 })
  assert.deepEqual(spec.outside, { x: 1, y: 0, z: 4 })
  // 偶数 size 向上取奇数
  assert.equal(makeShelterSpec({ size: 4 }).width, 5)
})

test('building：建造顺序（墙下→上、屋顶、临时中心柱、拆柱）', () => {
  const spec = makeShelterSpec({ size: 3, height: 3 })
  const order = shelterBuildOrder(spec)
  assert.ok(order.walls.length >= 12)
  assert.deepEqual(order.walls.map((cell) => cell.y), [...order.walls.map((cell) => cell.y)].sort((a, b) => a - b))
  assert.equal(order.temporary.length, 1)
  assert.deepEqual(order.temporary[0], { x: 1, y: 1, z: 1, role: 'roof-support' })
  assert.equal(order.roofCenter.length, 1)
  assert.equal(order.roof.length, spec.roof.length - 1)
  assert.deepEqual(order.removeTemporary, [{ x: 1, y: 1, z: 1 }])
})

test('building：结构验收（完整/缺墙/门堵/室内被占/门外无空间）', () => {
  const spec = makeShelterSpec({ size: 3, height: 3, material: 'oak_planks' })
  const good = verifyShelter(spec, buildBlockMap(spec))
  assert.equal(good.ok, true)
  assert.equal(good.walls.ok, true)
  assert.equal(good.roof.ok, true)
  assert.equal(good.door.ok, true)
  assert.equal(good.interior.ok, true)
  assert.equal(good.entry.ok, true)
  assert.ok(good.summary.includes('结构完整'))

  const missingNorth = spec.walls.find((cell) => cell.face === 'north')
  const broken = verifyShelter(spec, buildBlockMap(spec, { skip: [missingNorth] }))
  assert.equal(broken.ok, false)
  assert.equal(broken.walls.missing, 1)
  assert.equal(broken.walls.missingFaces[0].face, 'north')
  assert.ok(broken.summary.includes('北') || broken.summary.includes('north'))

  const doorBlocked = verifyShelter(spec, buildBlockMap(spec, { extra: { [`${spec.doorCell.x},${spec.doorCell.y},${spec.doorCell.z}`]: 'cobblestone' } }))
  assert.equal(doorBlocked.door.ok, false)
  assert.equal(doorBlocked.entry.ok, false)

  const insideBlocked = verifyShelter(spec, buildBlockMap(spec, { extra: { [`${spec.inside.x},${spec.inside.y + 1},${spec.inside.z}`]: 'dirt' } }))
  assert.equal(insideBlocked.interior.ok, false)
  assert.equal(insideBlocked.entry.ok, false)
  assert.ok(insideBlocked.summary.includes('室内'))

  const noOutside = verifyShelter(spec, buildBlockMap(spec, { extra: { [`${spec.outside.x},${spec.outside.y},${spec.outside.z}`]: 'stone' } }))
  assert.equal(noOutside.entry.outsideClear, false)
  assert.equal(noOutside.entry.ok, false)
})

test('building：方块名判定（air/liquid/solid）', () => {
  assert.equal(isAirName('air'), true)
  assert.equal(isAirName('cave_air'), true)
  assert.equal(isAirName('stone'), false)
  assert.equal(isSolidName('stone'), true)
  assert.equal(isSolidName('air'), false)
  assert.equal(isSolidName('water'), false)
  assert.equal(isSolidName(''), false)
})



test('building：shelter 材料诊断（needed/have/deficit/替代材料/可执行建议）', () => {
  const report = shelterMaterialReport({ material: 'dirt', need: 27, counts: { dirt: 5, cobblestone: 32 }, width: 3, interiorHeight: 2 })
  assert.equal(report.enough, false)
  assert.equal(report.needed, 27)
  assert.equal(report.have, 5)
  assert.equal(report.deficit, 22)
  assert.equal(report.available.dirt, 5)
  assert.ok(report.suggestion.includes('还差 22'))
  assert.ok(report.suggestion.includes('cobblestone'))
  assert.ok(report.suggestion.includes('material'))
  assert.equal(report.alternatives[0].material, 'cobblestone')
  assert.equal(report.alternatives[0].enough, true)
  const empty = shelterMaterialReport({ material: 'dirt', need: 27, counts: {}, width: 3, interiorHeight: 2 })
  assert.equal(empty.have, 0)
  assert.ok(empty.suggestion.includes('dig'))
  assert.ok(empty.suggestion.includes('dirt'))
  assert.equal(shelterMaterialReport({ material: 'dirt', need: 5, counts: { dirt: 10 } }).enough, true)
})

