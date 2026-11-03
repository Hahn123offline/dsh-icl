// 回归：审计发现、已修的行为。每条都对应一个曾经的真实缺陷。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost, attachDshAdapter, createDeliveryService } from '../src/index.mjs'
import { composeToolDescription } from '../src/services.mjs'
import * as memory from '../../plugins/memory/src/index.mjs'
import * as recall from '../../plugins/recall/src/index.mjs'
import * as world from '../../plugins/world-state/src/index.mjs'
import * as rhythm from '../../plugins/rhythm/src/index.mjs'
import memoryManifest from '../../plugins/memory/manifest.json' with { type: 'json' }
import recallManifest from '../../plugins/recall/manifest.json' with { type: 'json' }
import worldManifest from '../../plugins/world-state/manifest.json' with { type: 'json' }
import rhythmManifest from '../../plugins/rhythm/manifest.json' with { type: 'json' }

function fakeDsh() {
  const tools = new Map()
  return {
    tools: { register(def) { tools.set(def.name, def); return () => tools.delete(def.name) } },
    systemPrompt: { section() { return () => {} } },
    names: () => [...tools.keys()].sort(),
  }
}

function tempRoot(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `icl-${tag}-`))
}

test('适配器先挂上、之后启用插件，新工具也会推到 DSH', async () => {
  const host = createHost({ log: () => {} })
  host.registerPlugin(memoryManifest, memory, { config: { root: tempRoot('late') } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 's' } })
  const dsh = fakeDsh()
  attachDshAdapter(host, dsh, { sessionId: 's' })
  assert.deepEqual(dsh.names(), [])
  await host.enable('memory')
  await host.enable('recall')
  assert.ok(dsh.names().includes('remember'), `启用后应看到工具，实际：${dsh.names().join(',')}`)
})

test('会话的工具名与索引都按预设过滤', async () => {
  const host = createHost({ log: () => {} })
  const root = tempRoot('preset')
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 's' } })
  await host.enable('memory')
  await host.enable('recall')
  host.services.presets.define({ id: 'mem-only', allow: ['recall'] })
  host.services.presets.use('mem-only')
  const { createSessionAdapter } = await import('../src/session.mjs')
  const adapter = createSessionAdapter({ sessionId: 's', host, push: () => {} })
  const names = adapter.toolNames()
  assert.ok(names.includes('recall'), `应有 recall，实际：${names.join(',')}`)
  assert.ok(!names.includes('memo'), '预设外插件（note）的工具不应出现')
  assert.ok(!adapter.systemPrompt().includes('- memo:'), '预设外工具不应出现在索引里')
})

test('截断后的长度不超过预算', () => {
  assert.ok(composeToolDescription({ summary: 'S'.repeat(200) }, { maxChars: 30 }).length <= 30)
  assert.ok(composeToolDescription({ summary: 'S'.repeat(200) }, { maxChars: 1 }).length <= 1)
})

test('供应商注销会解除指向它的绑定', () => {
  const host = createHost({ log: () => {} })
  host.services.slots.declare({ id: 'chat', kind: 'chat', shape: {} })
  const off = host.services.slots.registerProvider({ id: 'p1', kind: 'chat', call: async () => 'ok' })
  host.services.slots.bind('chat', { provider: 'p1', call: async () => 'ok' })
  assert.ok(host.services.slots.resolve('chat'))
  off()
  assert.equal(host.services.slots.resolve('chat'), null)
})

test('投递重试耗尽后计入 droppedCount，不再无声消失', () => {
  let clock = 0
  const delivery = createDeliveryService({ now: () => clock, maxAttempts: 5 })
  delivery.push({ plugin: 'p', activity: 'a', text: 'x', seq: 1 })
  for (let i = 0; i < 10; i++) {
    const [batch] = delivery.drain('session')
    if (!batch) { clock += 60_000; continue }
    delivery.nack(batch.id, 'boom')
    clock += 60_000
  }
  assert.ok(delivery.droppedCount() >= 1, `应计入丢弃，实际 ${delivery.droppedCount()}`)
})

test('世界状态按注册者顺序拼装，句末不会出现「。；」', async () => {
  const host = createHost({ log: () => {} })
  const root = tempRoot('world')
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(worldManifest, world, {})
  host.registerPlugin(rhythmManifest, rhythm, { config: { dreamAt: '23:00', stateFile: path.join(root, 'r.json') } })
  for (const id of ['memory', 'world-state', 'rhythm']) await host.enable(id)
  const text = host.services.prompt.assemble({ sessionId: 's' })
  assert.ok(!text.includes('。；'), `不应出现「。；」，实际：${text}`)
  assert.ok(text.indexOf('时间：') < text.indexOf('作息：') || !text.includes('作息：'))
})


test('记忆库可以整份导出为 JSON 与 Markdown', async () => {
  const host = createHost({ log: () => {} })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-export-'))
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  await host.enable('memory')
  const mem = host.shared.get('memory')
  mem.registerNamespace({ id: 'event', label: '事件', recallable: true })
  mem.put({ namespace: 'event', kind: 'note', text: '导出测试', data: { tags: ['t'] } })
  const dump = mem.exportAll()
  assert.equal(dump.items.length, 1)
  const tool = host.services.tools.list().find((x) => x.name === 'memory_export')
  const jsonPath = path.join(root, 'dump.json')
  await tool.execute({ path: jsonPath, format: 'json' })
  const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
  assert.equal(parsed.items[0].text, '导出测试')
  const mdPath = path.join(root, 'dump.md')
  await tool.execute({ path: mdPath, format: 'md' })
  assert.match(fs.readFileSync(mdPath, 'utf8'), /导出测试/)
})
