// delivery push-time gate：时间模块的睡眠/静音拦截要能堵住直接 ctx.delivery.push。
//
// 不变量：
//   · gate 拦下的 push 不进队列，返回 blocked（调用方可以决定保留/重试）
//   · gate 自己抛错 fail-open 并计数（坏 gate 不能静默所有投递）
//   · 插件卸载时 gate 恢复成安装前的那个（不是一律清空）
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHost } from '../src/index.mjs'

function fakeManifest(id, tools = []) {
  return { id, version: '0.0.0', entry: './index.mjs', tools, slots: [], focus: {}, requires: {} }
}

test('gate 拦下的 push 不进队列，返回 blocked/reason', () => {
  const host = createHost({ log: () => {} })
  const delivery = host.services.delivery
  delivery.setGate((entry) => (entry.source.plugin === 'qq' ? { accept: false, reason: 'muted' } : { accept: true }))
  const blocked = delivery.push({ source: { plugin: 'qq' }, content: { text: '外部消息' } })
  assert.equal(blocked.accepted, false)
  assert.equal(blocked.blocked, true)
  assert.equal(blocked.reason, 'muted')
  assert.equal(delivery.blockedCount(), 1)
  assert.equal(delivery.pendingCount(), 0)
  assert.deepEqual(delivery.drain('session'), [])
})

test('gate 放行的 push 正常进队列；gate 看得到 source/content/channel', () => {
  const host = createHost({ log: () => {} })
  const delivery = host.services.delivery
  const seen = []
  delivery.setGate((entry) => { seen.push(entry); return { accept: true } })
  const out = delivery.push({ source: { plugin: 'time', activity: 'schedule' }, content: { text: '闹钟' }, channel: 'signal' })
  assert.equal(out.accepted, true)
  const [batch] = delivery.drain('session')
  assert.equal(batch.text, '闹钟')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].source.plugin, 'time')
  assert.equal(seen[0].channel, 'signal')
})

test('gate 自己抛错时 fail-open，不让所有投递静默消失', () => {
  const host = createHost({ log: () => {} })
  const delivery = host.services.delivery
  delivery.setGate(() => { throw new Error('gate broke') })
  const out = delivery.push({ source: { plugin: 'qq' }, content: { text: '仍然要投' } })
  assert.equal(out.accepted, true)
  assert.equal(delivery.gateErrorCount(), 1)
  assert.equal(delivery.drain('session').length, 1)
})

test('卸载插件后 gate 恢复，普通 push 重新放行', async () => {
  const host = createHost({ log: () => {} })
  const gatePlugin = {
    apply(ctx) {
      ctx.delivery.setGate((entry) => (entry.source.plugin === 'blocked' ? { accept: false, reason: 'muted' } : { accept: true }))
      return {}
    },
  }
  host.registerPlugin(fakeManifest('gate-test'), gatePlugin)
  await host.enable('gate-test')
  assert.equal(host.services.delivery.push({ source: { plugin: 'blocked' }, content: { text: 'x' } }).blocked, true)
  host.disable('gate-test')
  assert.equal(host.services.delivery.push({ source: { plugin: 'blocked' }, content: { text: 'y' } }).accepted, true)
})
