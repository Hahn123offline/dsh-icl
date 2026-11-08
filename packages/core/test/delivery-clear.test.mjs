import test from 'node:test'
import assert from 'node:assert/strict'
import { createDeliveryService } from '../src/services.mjs'

test('delivery.clear：默认清空；preserve 保留 time 闹钟/睡醒', () => {
  const d = createDeliveryService({ now: () => 1_000 })
  d.push({ source: { plugin: 'qq', activity: 'qq:private:1' }, content: { text: 'qq' }, batchKey: 'qq' })
  d.push({ source: { plugin: 'time', activity: 'schedule' }, content: { text: '闹钟' }, batchKey: 'time' })
  assert.equal(d.clear({ preserve: (item) => item.source.plugin === 'time' }), 1)
  assert.equal(d.pendingCount(), 1)
  const batches = d.drain('session')
  assert.equal(batches.length, 1)
  assert.equal(batches[0].text, '闹钟')
})
