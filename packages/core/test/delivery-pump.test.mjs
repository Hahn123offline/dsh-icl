// 投递泵：队列里的消息必须真的进入会话，否则时间模块全是死信。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHost } from '../src/index.mjs'
import { createDeliveryPump } from '../../adapters/delivery-pump.mjs'

function hostWithQueue(texts) {
  const host = createHost({ log: () => {} })
  for (const [i, text] of texts.entries()) host.services.delivery.push({ source: { plugin: 'time', activity: `s${i}` }, content: { text } })
  return host
}

test('投递泵把批次送进会话并 ack', async () => {
  const host = hostWithQueue(['你困了', '你醒了'])
  const sent = []
  const pump = createDeliveryPump({
    delivery: host.services.delivery,
    sessionId: 's-1',
    prompt: async ({ sessionId, text }) => { sent.push({ sessionId, text }) },
  })
  const out = await pump.tick()
  assert.equal(out.sent, 2)
  assert.deepEqual(sent.map((x) => x.text), ['你困了', '你醒了'])
  assert.equal(host.services.delivery.pendingCount(), 0)
})

test('发送失败会 nack，消息留在队列里', async () => {
  const host = hostWithQueue(['救命'])
  const pump = createDeliveryPump({
    delivery: host.services.delivery,
    sessionId: 's-1',
    prompt: async () => { throw new Error('busy') },
  })
  const out = await pump.tick()
  assert.equal(out.sent, 0)
  assert.ok(host.services.delivery.pendingCount() >= 1)
})

test('拿不到会话 id 时跳过，不丢消息', async () => {
  const host = hostWithQueue(['在吗'])
  const pump = createDeliveryPump({
    delivery: host.services.delivery,
    sessionId: () => null,
    prompt: async () => { throw new Error('不该被调用') },
  })
  const out = await pump.tick()
  assert.equal(out.skipped, 'no-session')
  assert.ok(host.services.delivery.pendingCount() >= 1)
})

test('空批次会被直接 ack，不会卡住队列', async () => {
  const host = hostWithQueue([''])
  const pump = createDeliveryPump({
    delivery: host.services.delivery,
    sessionId: 's-1',
    prompt: async () => { throw new Error('不该被调用') },
  })
  await pump.tick()
  assert.equal(host.services.delivery.pendingCount(), 0)
})
