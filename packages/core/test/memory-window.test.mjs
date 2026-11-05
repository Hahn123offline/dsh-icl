// 记忆原语的窗口与权重：新行要能进窗口，boost 不能被普通重写打回。
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

async function setup() {
  const host = createHost({ log: () => {} })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-memwin-'))
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 's1' } })
  await host.enable('memory')
  await host.enable('recall')
  return { host, memory: host.shared.get('memory') }
}

test('query 默认最老，order=desc 取最新：新行不会被 500 行窗口挡在外面', async () => {
  const { memory } = await setup()
  for (let i = 1; i <= 600; i += 1) {
    memory.put({ namespace: 'event', kind: 'note', text: `第 ${i} 条`, now: 1000 + i })
  }
  const oldest = memory.query({ namespace: 'event', kind: 'note', limit: 5 })
  const newest = memory.query({ namespace: 'event', kind: 'note', limit: 5, order: 'desc' })
  assert.equal(oldest[0].text, '第 1 条')
  assert.equal(newest[0].text, '第 600 条')
  assert.equal(newest.length, 5)
})

test('检索窗口不只 500 条：最老的一条仍能被搜到', async () => {
  const { memory } = await setup()
  memory.put({ namespace: 'event', kind: 'block', text: '只出现一次的老记忆', now: 1000 })
  for (let i = 0; i < 600; i += 1) {
    memory.put({ namespace: 'event', kind: 'block', text: `填充记忆 ${i}`, now: 2000 + i })
  }
  const hits = await memory.search({ query: '老记忆', limit: 3 })
  assert.ok(hits.some((hit) => hit.item.text === '只出现一次的老记忆'))
})

test('普通重写保留 boost 后的权重；只有 reweight 才覆盖', async () => {
  const { memory } = await setup()
  const first = memory.put({ namespace: 'event', kind: 'note', key: 'k1', text: '原文', weight: 1.5, now: 1000 })
  memory.boost([first.id], { amount: 2, maxWeight: 5 })
  const boosted = memory.query({ namespace: 'event', kind: 'note', key: 'k1', limit: 1 })[0]
  assert.ok(boosted.weight > 1.5)
  memory.put({ namespace: 'event', kind: 'note', key: 'k1', text: '改写', weight: 1.5, now: 2000 })
  const kept = memory.query({ namespace: 'event', kind: 'note', key: 'k1', limit: 1 })[0]
  assert.equal(kept.weight, boosted.weight, '普通重写不应把权重打回 1.5')
  memory.put({ namespace: 'event', kind: 'note', key: 'k1', text: '再改', weight: 2, reweight: true, now: 3000 })
  const forced = memory.query({ namespace: 'event', kind: 'note', key: 'k1', limit: 1 })[0]
  assert.equal(forced.weight, 2)
})
