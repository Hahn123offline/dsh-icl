// 投递契约：一条消息只能到她那儿一次，失败不丢，ack 才推进水位。

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHost, createSessionAdapter } from '../src/index.mjs'

function setup({ push } = {}) {
  const host = createHost({ log: () => {} })
  const sent = []
  const session = createSessionAdapter({
    sessionId: 's1',
    host,
    push: push ?? (async (text) => { sent.push(text) }),
  })
  return { host, session, sent, delivery: host.services.delivery }
}

test('同一条消息 push 两次，只投一次', async () => {
  const { session, sent, delivery } = setup()
  const source = { plugin: 'qq', activity: 'qq:group:1', seq: 7 }
  assert.equal(delivery.push({ source, content: { text: '第一句' } }).accepted, true)
  assert.deepEqual(delivery.push({ source, content: { text: '第一句' } }), { accepted: false, deduped: true })
  await session.drainOnce()
  assert.deepEqual(sent, ['第一句'])
})

test('ack 之后水位前进，再来更早的 seq 也不会重发', async () => {
  const { session, sent, delivery } = setup()
  delivery.push({ source: { plugin: 'qq', activity: 'qq:group:1', seq: 9 }, content: { text: '九' } })
  await session.drainOnce()
  assert.equal(delivery.watermarkOf('qq', 'qq:group:1'), 9)
  delivery.push({ source: { plugin: 'qq', activity: 'qq:group:1', seq: 9 }, content: { text: '九（重复）' } })
  await session.drainOnce()
  assert.deepEqual(sent, ['九'])
})

test('push 失败不丢：留在队列里，下一轮还能投', async () => {
  let fail = true
  const sent = []
  const { session, delivery } = setup({
    push: async (text) => { if (fail) throw new Error('session busy'); sent.push(text) },
  })
  delivery.push({ source: { plugin: 'qq', activity: 'qq:group:2', seq: 1 }, content: { text: '别丢了我' } })
  const first = await session.drainOnce()
  assert.equal(first.failed, 1)
  assert.equal(delivery.pendingCount(), 1, '失败的消息还在队列里')
  fail = false
  const second = await session.drainOnce()
  assert.equal(second.delivered, 1)
  assert.deepEqual(sent, ['别丢了我'])
  assert.equal(delivery.pendingCount(), 0)
})

test('同一个 batchKey 的多条合并成一次 push', async () => {
  const { session, sent, delivery } = setup()
  const batchKey = 'qq:group:3:conversation'
  delivery.push({ source: { plugin: 'qq', activity: 'qq:group:3', seq: 1 }, content: { text: '一句' }, batchKey })
  delivery.push({ source: { plugin: 'qq', activity: 'qq:group:3', seq: 2 }, content: { text: '两句' }, batchKey })
  await session.drainOnce()
  assert.equal(sent.length, 1, '只 push 一次')
  assert.match(sent[0], /一句[\s\S]*两句/)
})

test('不同的目标各自成批，互不吞并', async () => {
  const { session, sent, delivery } = setup()
  delivery.push({ to: 'session', source: { plugin: 'qq', activity: 'a', seq: 1 }, content: { text: 'A' }, batchKey: 'a' })
  delivery.push({ to: 'other', source: { plugin: 'qq', activity: 'b', seq: 1 }, content: { text: 'B' }, batchKey: 'b' })
  await session.drainOnce()
  assert.deepEqual(sent, ['A'], '别的目标不归这个会话投')
  assert.equal(delivery.pendingCount(), 1, '另一条还在排队')
})
