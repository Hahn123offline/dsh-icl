// 信号层：校验、幂等、三条路由、事件总线、gate 放行。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHost } from '../src/index.mjs'
import { createSignalService, validateSignal, SIGNAL_KINDS } from '../src/signals.mjs'

function service(overrides = {}) {
  const delivered = []
  const signals = createSignalService({ now: () => 1000 })
  signals.setDeliver((sig) => delivered.push(sig))
  return { signals, delivered, ...overrides }
}

test('kind 只能是固定五种', () => {
  assert.deepEqual([...SIGNAL_KINDS], ['wake', 'goal', 'notice', 'content', 'event'])
  const bad = validateSignal({ from: { plugin: 'x' }, kind: 'shout', text: 'hi' })
  assert.equal(bad.ok, false)
})

test('没有 from.plugin 的信号被拒绝', () => {
  assert.equal(validateSignal({ kind: 'content', text: 'hi' }).ok, false)
  assert.equal(validateSignal({ from: {}, kind: 'content', text: 'hi' }).ok, false)
})

test('既没有 text 也没有 meta 的信号被拒绝', () => {
  assert.equal(validateSignal({ from: { plugin: 'x' }, kind: 'notice', text: '  ' }).ok, false)
})

test('重复 id 只送一次', () => {
  const { signals, delivered } = service()
  const sig = { id: 'a1', from: { plugin: 'qq' }, kind: 'content', text: 'hi' }
  assert.equal(signals.offer(sig).accepted, true)
  const second = signals.offer(sig)
  assert.equal(second.accepted, false)
  assert.equal(second.deduped, true)
  assert.equal(delivered.length, 1)
})

test('to:model 默认交给 deliver', () => {
  const { signals, delivered } = service()
  const out = signals.offer({ from: { plugin: 'qq', activity: 'g1' }, kind: 'content', text: '在吗' })
  assert.equal(out.accepted, true)
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].from.activity, 'g1')
})

test('gate 拦截后不进 deliver，并计数', () => {
  const { signals, delivered } = service()
  signals.setGate(() => ({ accept: false, reason: 'sleeping' }))
  const out = signals.offer({ from: { plugin: 'qq' }, kind: 'content', text: 'hi' })
  assert.equal(out.accepted, false)
  assert.equal(out.blocked, true)
  assert.equal(delivered.length, 0)
  assert.equal(signals.stats().blocked, 1)
})

test('gate 放行后恢复投递', () => {
  const { signals, delivered } = service()
  signals.setGate(() => ({ accept: true }))
  signals.offer({ from: { plugin: 'qq' }, kind: 'content', text: 'hi' })
  assert.equal(delivered.length, 1)
})

test('to:plugin 是事件总线，按 kind/from/tags 过滤', () => {
  const { signals } = service()
  const got = []
  const off = signals.on({ kind: 'event', from: 'dream' }, (s) => got.push(s.text))
  signals.emit({ from: { plugin: 'dream' }, kind: 'event', text: 'wash done' })
  signals.emit({ from: { plugin: 'note' }, kind: 'event', text: 'note done' })
  signals.emit({ from: { plugin: 'dream' }, kind: 'notice', text: 'not event' })
  assert.deepEqual(got, ['wash done'])
  off()
  signals.emit({ from: { plugin: 'dream' }, kind: 'event', text: 'after off' })
  assert.deepEqual(got, ['wash done'])
})

test('tags 过滤是任一匹配', () => {
  const { signals } = service()
  const got = []
  signals.on({ tags: ['direct'] }, (s) => got.push(s.text))
  signals.emit({ from: { plugin: 'qq' }, kind: 'event', text: 'a', tags: ['direct'] })
  signals.emit({ from: { plugin: 'qq' }, kind: 'event', text: 'b', tags: ['group'] })
  assert.deepEqual(got, ['a'])
})

test('host 把信号接到 delivery，会话能 drain 到文本', async () => {
  const host = createHost({ log: () => {} })
  host.services.signals.offer({ from: { plugin: 'qq', activity: 'g1' }, kind: 'content', text: '在吗' })
  const [batch] = host.services.delivery.drain('session')
  assert.ok(batch, '应有一批投递')
  assert.equal(batch.text, '在吗')
})
