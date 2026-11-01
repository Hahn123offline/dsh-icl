// focus 与模型客户端：谁能打断她、以及"暂停"必须是真暂停。

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHost, createFocusService, createModelClient } from '../src/index.mjs'

test('没有 focus：谁来都能到', () => {
  const focus = createFocusService()
  assert.equal(focus.canPierce('qq:private:1').allowed, true)
})

test('focus 里的穿透规则：私聊总穿，群里只有 @ 才穿，别的群一律不穿', () => {
  const focus = createFocusService()
  focus.enter({
    label: 'qq:group:10',
    pierce: { 'qq:private:*': 'always', 'qq:group:11': 'mention', 'qq:group:*': 'never', timer: 'always' },
  })
  assert.equal(focus.canPierce('qq:private:9').allowed, true)
  assert.equal(focus.canPierce('qq:group:11').allowed, false)
  assert.equal(focus.canPierce('qq:group:11', { mention: true }).allowed, true)
  assert.equal(focus.canPierce('qq:group:12').allowed, false)
  assert.equal(focus.canPierce('timer').allowed, true)
})

test('focus 到期自动失效（软命名空间）', () => {
  let t = 1000
  const focus = createFocusService({ now: () => t })
  focus.enter({ label: 'writing', ttlMs: 5000 })
  assert.equal(focus.current()?.label, 'writing')
  t += 6000
  assert.equal(focus.current(), null, '过期就不算了')
})

test('release 之后 focus 立即消失', () => {
  const focus = createFocusService()
  const lease = focus.enter({ label: 'mc' })
  assert.equal(focus.current()?.label, 'mc')
  lease.release()
  assert.equal(focus.current(), null)
})

test('插槽只声明形状，管理器按形状接线', async () => {
  const host = createHost({ log: () => {} })
  const slots = host.services.slots
  slots.declare({ id: 'chat', kind: 'chat', requires: { tools: true } })
  assert.throws(() => slots.require('chat'), /还没有绑定/)
  // 形状不符的供应商不会被选中
  assert.deepEqual(slots.autoBind(), [])
  slots.registerProvider({ id: 'no-tools', kind: 'chat', shape: { tools: false }, call: async () => 'x' })
  assert.deepEqual(slots.autoBind(), [], '形状不符合就不能接')
  slots.registerProvider({ id: 'fake-chat', kind: 'chat', shape: { tools: true }, call: async () => 'ok' })
  assert.deepEqual(slots.autoBind(), [{ slot: 'chat', provider: 'fake-chat' }])
  assert.equal(await slots.call('chat', {}), 'ok')
})

test('嵌入插槽：维度不对就不接，维度对了自动接上', () => {
  const host = createHost({ log: () => {} })
  const slots = host.services.slots
  slots.declare({ id: 'embed-text', kind: 'embedding', requires: { dim: 1024 } })
  slots.registerProvider({ id: 'bge-768', kind: 'embedding', shape: { dim: 768 }, call: async () => [] })
  assert.deepEqual(slots.autoBind(), [], '768 不能接 1024 的插槽')
  assert.equal(slots.unmatched().length, 1)
  slots.registerProvider({ id: 'bge-m3', kind: 'embedding', shape: { dim: 1024 }, call: async () => [[0.1, 0.2]] })
  assert.deepEqual(slots.autoBind(), [{ slot: 'embed-text', provider: 'bge-m3' }])
  assert.equal(slots.unmatched().length, 0)
})

test('模型暂停：拒绝新请求，并中止在飞的', async () => {
  let aborted = 0
  const fetchImpl = async (url, init) => {
    // 永远不返回，直到 signal 被 abort
    return await new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => { aborted += 1; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) })
    })
  }
  const client = createModelClient({ fetchImpl })
  client.bind({ baseUrl: 'http://127.0.0.1:1/v1', model: 'm' })
  const pending = client.chat({ messages: [{ role: 'user', content: 'hi' }] })
  await new Promise((r) => setTimeout(r, 10))
  client.pause('整理一下')
  await assert.rejects(pending, /中止|暂停/)
  assert.ok(aborted >= 1)
  await assert.rejects(() => client.chat({ messages: [] }), (error) => error.code === 'MODEL_PAUSED')
  client.resume()
})

test('模型 401：重新取一次凭据再重试', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    if (calls === 1) return { ok: false, status: 401, text: async () => 'unauthorized' }
    return { ok: true, json: async () => ({ choices: [{ message: { content: '好了' } }] }) }
  }
  const client = createModelClient({ fetchImpl, onAuthError: () => ({ apiKey: 'new-key' }) })
  client.bind({ baseUrl: 'http://127.0.0.1:1/v1', model: 'm', apiKey: 'old-key' })
  const text = await client.chat({ messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(text, '好了')
  assert.equal(calls, 2, '应该重试一次')
})
