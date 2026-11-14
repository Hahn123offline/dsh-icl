// 紧急回归：群普通消息必须 ambient（进 focus 积压），只有 @ 到自己才直达。
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildGroupSignal } from '../../plugins/qq/src/normalize.mjs'

test('群普通消息：ambient，不带 at/mention（不穿透）', () => {
  const signal = buildGroupSignal({ groupId: '123', senderId: '456', senderName: '某群友', text: '普通群消息', rich: {} })
  assert.ok(signal.tags.includes('ambient'), `应带 ambient：${signal.tags}`)
  assert.equal(signal.meta.ambient, true)
  assert.ok(!signal.tags.includes('at'))
  assert.ok(!signal.tags.includes('mention'))
})

test('群里 @ 自己：带 at/mention，不带 ambient（直达）', () => {
  const signal = buildGroupSignal({ groupId: '123', senderId: '456', senderName: '某群友', text: '@鱼鱼 在吗', rich: { atSelf: true } })
  assert.ok(signal.tags.includes('at'))
  assert.ok(signal.tags.includes('mention'))
  assert.ok(!signal.tags.includes('ambient'))
  assert.equal(signal.meta.ambient, false)
})
