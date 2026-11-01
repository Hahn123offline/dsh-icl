// 回忆控制器：统一 recall、持久游标、token 预算去重、召回即回鲜。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../src/index.mjs'
import * as memory from '../../plugins/memory/src/index.mjs'
import * as recall from '../../plugins/recall/src/index.mjs'
import memoryManifest from '../../plugins/memory/manifest.json' with { type: 'json' }
import recallManifest from '../../plugins/recall/manifest.json' with { type: 'json' }

async function setup({ budgetTokens = 10_000 } = {}) {
  const host = createHost({ log: () => {} })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-recall-'))
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 's1', budgetTokens } })
  await host.enable('memory')
  await host.enable('recall')
  const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))
  return { host, tools, memory: host.shared.get('memory') }
}

test('remember 落进分类命名空间，recall 带 [今天] 标签', async () => {
  const { tools, memory } = await setup()
  await tools.remember.execute({ text: '他说周末可能去看海', kind: 'event' })
  const rows = memory.query({ namespace: 'event', kind: 'note' })
  assert.equal(rows.length, 1)
  const out = await tools.recall.execute({})
  assert.match(out.text, /\[今天\] 他说周末可能去看海/)
})

test('按 kind 只召回这一类', async () => {
  const { tools } = await setup()
  await tools.remember.execute({ text: '他怕水', kind: 'person', qq: '3429502459' })
  await tools.remember.execute({ text: '难绷这个梗最近很火', kind: 'slang' })
  const onlyPerson = await tools.recall.execute({ kind: 'person' })
  assert.match(onlyPerson.text, /他怕水/)
  assert.doesNotMatch(onlyPerson.text, /难绷/)
  const onlySlang = await tools.recall.execute({ kind: 'slang' })
  assert.match(onlySlang.text, /难绷/)
  assert.doesNotMatch(onlySlang.text, /他怕水/)
})

test('默认召回所有类别，且条目带标签', async () => {
  const { tools } = await setup()
  await tools.remember.execute({ text: '事件一句', kind: 'event' })
  await tools.remember.execute({ text: '人物一句', kind: 'person' })
  const out = await tools.recall.execute({})
  assert.match(out.text, /\[今天\] 事件一句/)
  assert.match(out.text, /\[今天\] 人物一句/)
})

test('游标：第二次 recall 不再重复同一批', async () => {
  const { tools } = await setup()
  for (let i = 0; i < 6; i++) await tools.remember.execute({ text: `第 ${i} 件事`, kind: 'event' })
  const first = await tools.recall.execute({ limit: 3 })
  const second = await tools.recall.execute({ limit: 3, cursor: first.cursor })
  const firstLines = first.text.split('\n').filter(Boolean)
  const secondLines = second.text.split('\n').filter(Boolean)
  for (const line of secondLines) assert.ok(!firstLines.includes(line), `不应重复：${line}`)
})

test('token 预算：新块挤进来时解锁最早的块（允许再次被召回）', async () => {
  // 预算很小，保证一两次召回就会溢出
  const { tools } = await setup({ budgetTokens: 500 })
  const long = '这是一段很长很长的记忆文本，用来快速吃掉预算。'.repeat(30)
  for (let i = 0; i < 4; i++) await tools.remember.execute({ text: `${long}（${i}）`, kind: 'event' })
  const first = await tools.recall.execute({ limit: 1 })
  const second = await tools.recall.execute({ limit: 1, cursor: first.cursor })
  assert.notEqual(first.text, second.text, '第二次应该是另一条')
  // 反复召回直到回到起点（最早的块被解锁）
  let cursor = second.cursor
  let seenAgain = false
  for (let i = 0; i < 6; i++) {
    const next = await tools.recall.execute({ limit: 1, cursor })
    if (next.text === first.text) { seenAgain = true; break }
    cursor = next.cursor
  }
  assert.equal(seenAgain, true, '预算滚动后最早的块应该能再次被召回')
})

test('召回成功会让记忆回到新鲜：权重上升、计时重置', async () => {
  const { tools, memory } = await setup()
  await tools.remember.execute({ text: '会被想起来的事', kind: 'event' })
  const row = memory.query({ namespace: 'event', kind: 'note' })[0]
  const before = row.weight
  await tools.recall.execute({})
  const after = memory.query({ namespace: 'event', kind: 'note' })[0]
  assert.ok(after.weight > before, '权重应上升')
  assert.ok(after.lastRecalledAt != null, '应记录召回时间')
})

test('昨天及更早的 note 不会被 recall 带回（只有块可以）', async () => {
  const { tools, memory } = await setup()
  // 手工塞一条"昨天的随手记"
  const yesterday = Date.now() - 30 * 3600_000
  memory.put({ namespace: 'event', kind: 'note', key: 'old:1', text: '昨天随手记的内容', now: yesterday })
  const out = await tools.recall.execute({})
  assert.doesNotMatch(out.text, /昨天随手记的内容/)
})

test('forget 只删自己那一条', async () => {
  const { tools, memory } = await setup()
  const out = await tools.remember.execute({ text: '要删的', kind: 'event', key: 'k1' })
  void out
  await tools.remember.execute({ text: '要留的', kind: 'event', key: 'k2' })
  await tools.forget.execute({ key: 'k1', kind: 'event' })
  const rows = memory.query({ namespace: 'event', kind: 'note' })
  assert.deepEqual(rows.map((r) => r.text), ['要留的'])
})
