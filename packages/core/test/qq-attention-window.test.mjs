import test from 'node:test'
import assert from 'node:assert/strict'
import { LIMITS, RATE_FAST, shouldFlush, windowDelayMs } from '../../plugins/qq/src/attention-window.mjs'

test('自适应窗口：稀疏立即，密集按 5s 步长延迟，有上限', () => {
  assert.equal(windowDelayMs(0), 0)
  assert.equal(windowDelayMs(RATE_FAST), 0)
  assert.equal(windowDelayMs(RATE_FAST + 1), 5_000)
  assert.equal(windowDelayMs(RATE_FAST * 3), 10_000)
  assert.equal(windowDelayMs(1000, 'ambient'), LIMITS.ambient.maxWaitMs)
  assert.equal(windowDelayMs(1000, 'pierce'), LIMITS.pierce.maxWaitMs)
})

test('自适应窗口：条数/等待硬上限必须 flush，没有新信息不发空提醒', () => {
  const now = 1_000_000
  assert.equal(shouldFlush({ count: 0, now }), false)
  assert.equal(shouldFlush({ count: 1, rate: 1, firstAt: now, now }), true)
  assert.equal(shouldFlush({ count: LIMITS.ambient.maxCount, rate: 99, firstAt: now, now }), true)
  assert.equal(shouldFlush({ count: 1, rate: 99, firstAt: now, now: now + LIMITS.ambient.maxWaitMs }), true)
})
