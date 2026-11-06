import test from 'node:test'
import assert from 'node:assert/strict'
import { buildStructuredSnapshot, findEdgePath, resolveViewerRoot } from '../src/eyes.mjs'

test('eyes：结构化快照聚合 status/adapter/地图，字段可读且精简', () => {
  const status = {
    connected: true,
    paused: true,
    pausedReason: 'user-stop',
    playable: { ok: false, blockers: ['paused:user-stop'] },
    task: { id: 't-1', kind: 'collect', state: 'running', progress: { done: 3, total: 8 } },
    queue: [{ id: 't-2', kind: 'goto', state: 'queued' }],
    safety: {
      bodyOnline: true,
      reflex: { enabled: true, lastAt: null },
      lastReflex: null,
      alarms: { delivered: 1, suppressed: 0, redelivered: 0, pending: 0 },
    },
    adapter: {
      position: { x: 17.2, y: 65, z: -59.4 },
      dimension: 'overworld',
      health: 19,
      food: 17,
      oxygen: null,
      time: { isNight: false, clock: '06:49' },
      nearbyHostiles: [{ name: 'zombie', distance: 12.7 }],
      spawnSafety: { unsafe: false },
      pathfinder: true,
    },
  }
  const adapterSnapshot = {
    position: { x: 17.2, y: 65, z: -59.4 },
    dimension: 'overworld',
    health: 19,
    food: 17,
    oxygen: 20,
    time: { isNight: false, clock: '06:49' },
    held: { name: 'stone_pickaxe', count: 1, toolFor: 'pickaxe', tier: 2 },
    inventory: {
      emptySlots: 30,
      items: [{ name: 'dirt', count: 6 }, { name: 'stone_pickaxe', count: 1 }],
      hotbar: [{ slot: 1, selected: true, name: 'dirt', count: 6, toolFor: null }],
    },
    entities: [{ name: 'zombie', distance: 12.7, position: { x: 5, y: 66, z: -50 } }],
    nearbyBlocks: { grass_block: 20, dirt: 3 },
  }
  const snapshot = buildStructuredSnapshot({
    status,
    adapterSnapshot,
    inspect: { map: { text: '...###...' } },
    events: [{ seq: 1, type: 'task_progress', at: 1 }],
    radius: 8,
  })
  assert.equal(snapshot.kind, 'structured')
  assert.deepEqual(snapshot.position, { x: 17.2, y: 65, z: -59.4 })
  assert.equal(snapshot.dimension, 'overworld')
  assert.equal(snapshot.health, 19)
  assert.equal(snapshot.food, 17)
  assert.equal(snapshot.held.name, 'stone_pickaxe')
  assert.equal(snapshot.held.toolFor, 'pickaxe')
  assert.equal(snapshot.inventory.counts.dirt, 6)
  assert.equal(snapshot.inventory.emptySlots, 30)
  assert.equal(snapshot.hotbar[0].selected, true)
  assert.equal(snapshot.map, '...###...')
  assert.equal(snapshot.entities[0].name, 'zombie')
  assert.equal(snapshot.task.kind, 'collect')
  assert.equal(snapshot.safety.paused, true)
  assert.equal(snapshot.safety.bodyOnline, true)
  assert.equal(snapshot.playable.ok, false)
  assert.deepEqual(snapshot.queue, [{ id: 't-2', kind: 'goto', state: 'queued' }])
  assert.equal(snapshot.recentEvents[0].type, 'task_progress')
  assert.ok(JSON.stringify(snapshot).length < 4000, '快照应保持几 KB 级')
})

test('eyes：无 adapter 快照时从 status/inspect 降级（离线也能出基础快照）', () => {
  const snapshot = buildStructuredSnapshot({
    status: { connected: false, paused: true, pausedReason: 'disconnect', adapter: { position: null } },
    inspect: {},
  })
  assert.equal(snapshot.kind, 'structured')
  assert.equal(snapshot.position, null)
  assert.equal(snapshot.safety.paused, true)
  assert.equal(snapshot.safety.pausedReason, 'disconnect')
  assert.deepEqual(snapshot.inventory.counts, {})
})

test('eyes：Edge / viewer 路径探测（缺依赖时返回 null 而不是抛错）', () => {
  assert.ok(findEdgePath('C:/definitely/not/edge.exe') === null || typeof findEdgePath() === 'string')
  assert.ok(resolveViewerRoot('C:/definitely/not/viewer') === null || typeof resolveViewerRoot() === 'string')
})
