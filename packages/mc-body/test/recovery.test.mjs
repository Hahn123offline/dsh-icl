import test from 'node:test'
import assert from 'node:assert/strict'
import {
  RECOVERY_LADDER, createHeartbeat, createProgressTracker, createRateLimiter, isDangerousBlock, recoveryStep,
} from '../src/recovery.mjs'

test('recovery：危险方块判定', () => {
  for (const name of ['lava', 'flowing_lava', 'fire', 'soul_fire', 'magma_block', 'powder_snow', 'cactus', 'campfire']) {
    assert.equal(isDangerousBlock(name), true, name)
  }
  for (const name of ['air', 'stone', 'dirt', 'water', 'grass_block', null, undefined]) {
    assert.equal(isDangerousBlock(name), false, String(name))
  }
})

test('recovery：idle 与 danger 配额分开，suppressed 有统计', () => {
  let t = 0
  const limiter = createRateLimiter({ now: () => t, windowMs: 1000, perWindow: { danger: 2, idle: 1 } })
  assert.equal(limiter.admit('danger', 'low-health'), true)
  assert.equal(limiter.admit('danger', 'health-drop'), true)
  assert.equal(limiter.admit('danger', 'low-health'), false)
  // danger 配额耗尽不影响 idle 配额
  assert.equal(limiter.admit('idle', 'heartbeat'), true)
  assert.equal(limiter.admit('idle', 'heartbeat'), false)
  const stats = limiter.stats()
  assert.equal(stats.suppressed, 2)
  assert.equal(stats.suppressedBy['low-health'], 1)
  assert.equal(stats.suppressedBy.heartbeat, 1)
  assert.equal(stats.fired, 3)
  // 窗口滑过后恢复
  t += 1000
  assert.equal(limiter.admit('danger', 'low-health'), true)
})

test('recovery：卡住判据看是否靠近目标，不是有没有动', () => {
  let t = 0
  const tracker = createProgressTracker({ now: () => t, stallMs: 100, epsilon: 0.5 })
  assert.equal(tracker.update(10, 0).improved, true)
  t = 40
  // 动了但没靠近：distance 没刷新最好成绩
  const moving = tracker.update(10.2, 40)
  assert.equal(moving.improved, false)
  assert.equal(moving.stalled, false)
  t = 99
  assert.equal(tracker.update(10.1, 99).stalled, false)
  t = 101
  assert.equal(tracker.update(10.3, 101).stalled, true)
  // 真正靠近目标会重置 stall
  t = 130
  const closer = tracker.update(7, 130)
  assert.equal(closer.improved, true)
  assert.equal(closer.stalled, false)
})

test('recovery：脱困阶梯 repath→jump→backoff→carve→giveup', () => {
  assert.deepEqual([...RECOVERY_LADDER], ['repath', 'jump', 'backoff', 'carve', 'giveup'])
  assert.equal(recoveryStep(0), 'repath')
  assert.equal(recoveryStep(1), 'jump')
  assert.equal(recoveryStep(2), 'backoff')
  assert.equal(recoveryStep(3), 'carve')
  assert.equal(recoveryStep(4), 'giveup')
  assert.equal(recoveryStep(99), 'giveup')
})

test('recovery：心跳只在安静够久时触发', () => {
  let t = 0
  const beat = createHeartbeat({ now: () => t, intervalMs: 100 })
  assert.equal(beat.due(50), false)
  assert.equal(beat.due(100), true)
  beat.touch(150)
  assert.equal(beat.due(200), false)
  assert.equal(beat.due(250), true)
})
