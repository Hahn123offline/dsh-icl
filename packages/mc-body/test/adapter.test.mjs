import test from 'node:test'
import assert from 'node:assert/strict'
import { createMineflayerAdapter } from '../src/mineflayer.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(fn, timeout = 8000, label = 'condition') {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const value = fn()
    if (value) return value
    await sleep(20)
  }
  throw new Error(`wait timeout: ${label}`)
}

test('adapter：未连接时状态栏不假在线、危险/重连字段可用', () => {
  const adapter = createMineflayerAdapter({ host: '127.0.0.1', port: 1, username: 'ICL-test' })
  const status = adapter.status()
  assert.equal(status.connected, false)
  assert.equal(status.spawned, false)
  assert.ok(Array.isArray(status.danger.blocks))
  assert.equal(status.danger.inDanger, false)
  assert.equal(status.reconnect.max, 5)
  assert.equal(status.reconnect.exhausted, false)
  assert.deepEqual(status.pathStats, { resets: 0, recoveries: 0, stuck: 0, carves: 0 })
})

test('adapter：连不上时有界退避并最终 reconnect_exhausted（不无限重试）', async () => {
  const events = []
  const adapter = createMineflayerAdapter({
    host: '127.0.0.1', port: 1, username: 'ICL-test',
    onEvent: (type, data) => events.push({ type, data }),
    autoReconnect: true, maxReconnect: 1, reconnectBaseMs: 50, connectTimeoutMs: 2000,
  })
  await adapter.connect().catch(() => {})
  await waitFor(() => events.some((event) => event.type === 'reconnect_exhausted'), 8000, 'reconnect_exhausted')
  const exhausted = events.find((event) => event.type === 'reconnect_exhausted')
  assert.equal(exhausted.data.max, 1)
  assert.ok(events.some((event) => event.type === 'reconnecting'))
  assert.ok(events.some((event) => event.type === 'offline' || event.type === 'reconnected' || event.type === 'body_error'))
  await adapter.disconnect()
  assert.equal(adapter.status().connected, false)
})
