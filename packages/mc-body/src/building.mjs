// 小屋/结构生成与验收的纯逻辑（docs/MC-BUILDING.md）。
// 坐标约定：局部坐标 x/z ∈ [0,size-1]，y=0 是地面层（脚所在 y），屋顶在 y=height-1。
// 门开在 doorSide 的墙中间，门洞高 min(2, interiorHeight)。
// 不依赖 mineflayer：适配器传入 blockNameAt(lx,ly,lz) 即可验收。

const AIR = /^(air|cave_air|void_air)$/
const LIQUID = /(water|lava)/

export function isAirName(name) {
  return AIR.test(String(name ?? ''))
}

export function isSolidName(name) {
  const value = String(name ?? '')
  return Boolean(value) && !AIR.test(value) && !LIQUID.test(value) && value !== 'unknown'
}

/** 生成 3×3×N 小屋规格（size 必须奇数；height≥3 → 内部 height-1 格高）。 */
export function makeShelterSpec({ size = 3, height = 3, doorSide = 'south', material = 'dirt' } = {}) {
  let width = Math.max(3, Math.min(9, Math.round(Number(size) || 3)))
  if (width % 2 === 0) width += 1
  const totalHeight = Math.max(3, Math.min(6, Math.round(Number(height) || 3)))
  const interiorHeight = totalHeight - 1
  const side = ['north', 'south', 'east', 'west'].includes(String(doorSide)) ? String(doorSide) : 'south'
  const mid = Math.floor(width / 2)
  const walls = []
  const door = []
  const roof = []
  const interior = []
  const floor = []
  const isWallCell = (x, z) => x === 0 || x === width - 1 || z === 0 || z === width - 1
  const isDoorCell = (x, z, y) => {
    if (y >= Math.min(2, interiorHeight)) return false
    if (side === 'north') return z === 0 && x === mid
    if (side === 'south') return z === width - 1 && x === mid
    if (side === 'west') return x === 0 && z === mid
    return x === width - 1 && z === mid
  }
  for (let y = 0; y < interiorHeight; y += 1) {
    for (let z = 0; z < width; z += 1) {
      for (let x = 0; x < width; x += 1) {
        if (isDoorCell(x, z, y)) door.push({ x, y, z })
        else if (isWallCell(x, z)) walls.push({ x, y, z, face: wallFace(x, z, width) })
        else interior.push({ x, y, z })
      }
    }
  }
  for (let z = 0; z < width; z += 1) {
    for (let x = 0; x < width; x += 1) roof.push({ x, y: totalHeight - 1, z })
  }
  for (let z = 1; z < width - 1; z += 1) for (let x = 1; x < width - 1; x += 1) floor.push({ x, y: -1, z })
  const outside = side === 'north' ? { x: mid, y: 0, z: -2 }
    : side === 'south' ? { x: mid, y: 0, z: width + 1 }
      : side === 'west' ? { x: -2, y: 0, z: mid }
        : { x: width + 1, y: 0, z: mid }
  const doorCell = side === 'north' ? { x: mid, y: 0, z: 0 }
    : side === 'south' ? { x: mid, y: 0, z: width - 1 }
      : side === 'west' ? { x: 0, y: 0, z: mid }
        : { x: width - 1, y: 0, z: mid }
  return {
    version: 1,
    name: 'shelter',
    size: { x: width, y: totalHeight, z: width },
    width,
    height: totalHeight,
    interiorHeight,
    doorSide: side,
    material,
    walls,
    door,
    roof,
    interior,
    floor,
    doorCell,
    outside,
    inside: { x: mid, y: 0, z: mid },
    layers: renderLayers({ width, interiorHeight, totalHeight, isWallCell, isDoorCell }),
    palette: { W: material, R: material, '.': null },
  }
}

function wallFace(x, z, width) {
  if (z === 0) return 'north'
  if (z === width - 1) return 'south'
  if (x === 0) return 'west'
  return 'east'
}

function renderLayers({ width, interiorHeight, totalHeight, isWallCell, isDoorCell }) {
  const layers = []
  for (let y = 0; y < totalHeight; y += 1) {
    const rows = []
    for (let z = 0; z < width; z += 1) {
      let row = ''
      for (let x = 0; x < width; x += 1) {
        if (y === totalHeight - 1) row += 'R'
        else if (isDoorCell(x, z, y)) row += '.'
        else if (isWallCell(x, z)) row += 'W'
        else row += '.'
      }
      rows.push(row)
    }
    layers.push(rows)
  }
  return layers
}

/** 建造顺序：墙（下→上）→ 屋顶 → 临时中心柱（屋顶支撑）→ 拆临时柱。 */
export function shelterBuildOrder(spec) {
  const walls = [...spec.walls].sort((a, b) => a.y - b.y)
  const roof = [...spec.roof].sort((a, b) => a.y - b.y)
  const mid = Math.floor(spec.width / 2)
  const temporary = spec.width >= 3 && spec.interiorHeight >= 2
    ? [{ x: mid, y: spec.interiorHeight - 1, z: mid, role: 'roof-support' }]
    : []
  return {
    walls,
    temporary,
    roof: roof.filter(({ x, z }) => !(x === mid && z === mid)),
    roofCenter: roof.filter(({ x, z }) => x === mid && z === mid),
    door: spec.door,
    removeTemporary: temporary.map(({ x, y, z }) => ({ x, y, z })),
  }
}

/**
 * 结构验收：blockNameAt(lx,ly,lz) 返回局部坐标方块名（越界可返回 null）。
 * 返回缺失按面/屋顶/门/内部/地面/入口的明细。
 */
export function verifyShelter(spec, blockNameAt) {
  const at = (x, y, z) => blockNameAt(x, y, z)
  const faces = { north: { missing: [], total: 0 }, south: { missing: [], total: 0 }, east: { missing: [], total: 0 }, west: { missing: [], total: 0 } }
  let wallMissing = 0
  for (const cell of spec.walls) {
    faces[cell.face].total += 1
    if (!isSolidName(at(cell.x, cell.y, cell.z))) {
      faces[cell.face].missing.push({ x: cell.x, y: cell.y, z: cell.z })
      wallMissing += 1
    }
  }
  const roofMissing = spec.roof.filter((cell) => !isSolidName(at(cell.x, cell.y, cell.z)))
  const doorMissing = spec.door.filter((cell) => !isAirName(at(cell.x, cell.y, cell.z)))
  const interiorBlocked = spec.interior.filter((cell) => !isAirName(at(cell.x, cell.y, cell.z)))
  const floorMissing = spec.floor.filter((cell) => !isSolidName(at(cell.x, cell.y, cell.z)))
  const outsideAt = spec.outside
  const outsideClear = isAirName(at(outsideAt.x, outsideAt.y, outsideAt.z)) && isAirName(at(outsideAt.x, outsideAt.y + 1, outsideAt.z))
  const doorOutClear = isAirName(at(spec.doorCell.x, spec.doorCell.y, spec.doorCell.z))
  const insideClear = isAirName(at(spec.inside.x, spec.inside.y, spec.inside.z)) && isAirName(at(spec.inside.x, spec.inside.y + 1, spec.inside.z))
  const missingFaces = Object.entries(faces).filter(([, value]) => value.missing.length).map(([face, value]) => ({ face, missing: value.missing.length, total: value.total }))
  const ok = wallMissing === 0 && roofMissing.length === 0 && doorMissing.length === 0 && interiorBlocked.length === 0 && floorMissing.length === 0 && outsideClear && insideClear
  return {
    ok,
    walls: { ok: wallMissing === 0, missing: wallMissing, total: spec.walls.length, faces, missingFaces },
    roof: { ok: roofMissing.length === 0, missing: roofMissing.length, total: spec.roof.length, cells: roofMissing.slice(0, 12) },
    door: { ok: doorMissing.length === 0, openCells: spec.door.length, missing: doorMissing.length },
    interior: { ok: interiorBlocked.length === 0, blocked: interiorBlocked.length, cells: interiorBlocked.slice(0, 12) },
    floor: { ok: floorMissing.length === 0, missing: floorMissing.length },
    entry: { ok: outsideClear && insideClear && doorMissing.length === 0, outsideClear, doorOutClear, insideClear },
    summary: buildMissingSummary({ wallMissing, missingFaces, roofMissing, doorMissing, interiorBlocked, floorMissing, outsideClear, insideClear }),
  }
}

function buildMissingSummary({ wallMissing, missingFaces, roofMissing, doorMissing, interiorBlocked, floorMissing, outsideClear, insideClear }) {
  const parts = []
  if (wallMissing) parts.push(`墙缺 ${wallMissing} 块（${missingFaces.map((entry) => `${entry.face}:${entry.missing}`).join('、')}）`)
  if (roofMissing.length) parts.push(`屋顶缺 ${roofMissing.length} 块`)
  if (doorMissing.length) parts.push(`门洞被堵 ${doorMissing.length} 格`)
  if (interiorBlocked.length) parts.push(`室内被占 ${interiorBlocked.length} 格（至少要 2 格高可站）`)
  if (floorMissing.length) parts.push(`地面缺 ${floorMissing.length} 格支撑`)
  if (!outsideClear) parts.push('门外没有可站立空间')
  if (!insideClear) parts.push('门内没有可站立空间')
  return parts.length ? parts.join('；') : '结构完整：四面墙 + 屋顶 + 门洞 + 室内 2 格高 + 进出通路'
}

/** shelter 材料诊断：给“需要/现有/还差”、可用替代材料和可执行建议。 */
export function shelterMaterialReport({ material, need, counts = {}, width = 3, interiorHeight = 2 } = {}) {
  const have = Number(counts[material]) || 0
  const deficit = Math.max(0, Number(need) - have)
  const candidateNames = ['dirt', 'cobblestone', 'oak_planks', 'spruce_planks', 'birch_planks', 'stone', 'cobbled_deepslate', 'mud', 'sand', 'gravel']
  const available = {}
  for (const name of candidateNames) available[name] = Number(counts[name]) || 0
  for (const [name, count] of Object.entries(counts)) {
    if (!(name in available) && /(planks|log|cobblestone|stone|dirt|sand|gravel|mud|deepslate)/.test(name)) available[name] = Number(count) || 0
  }
  const alternatives = Object.entries(available)
    .filter(([name, count]) => count > 0 && name !== material)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([name, count]) => ({ material: name, have: count, enough: count >= Number(need) }))
  const usable = alternatives.find((entry) => entry.enough)
  const suggestion = usable
    ? `建 ${width}×${width} 小屋（内部 ${interiorHeight} 格高）需要 ${material}×${need}，现有 ${have}（还差 ${deficit}）；背包已有 ${usable.material}×${usable.have} 足够——请把 material 改成 "${usable.material}" 重试，不用再收集。`
    : `建 ${width}×${width} 小屋（内部 ${interiorHeight} 格高）需要 ${material}×${need}，现有 ${have}（还差 ${deficit}）；先 dig 脚边/地表补料：{"op":"dig","params":{"block":"dirt","count":${deficit}}}（或 stone/cobblestone），或改用现有最多的 ${alternatives[0]?.material ?? 'dirt'}（${alternatives[0]?.have ?? 0} 块）；不够就先 collect 再建，别原样重试。`
  return { material, needed: Number(need), need: Number(need), have, deficit, available, alternatives, enough: have >= Number(need), suggestion }
}
