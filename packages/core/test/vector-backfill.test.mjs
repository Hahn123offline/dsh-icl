// 补索引：接上嵌入服务之前写下的块/碎片，要能补向量；并且是做梦的一个阶段。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../src/index.mjs'
import * as memory from '../../plugins/memory/src/index.mjs'
import * as recall from '../../plugins/recall/src/index.mjs'
import * as rhythm from '../../plugins/rhythm/src/index.mjs'
import * as dream from '../../plugins/dream/src/index.mjs'
import memoryManifest from '../../plugins/memory/manifest.json' with { type: 'json' }
import recallManifest from '../../plugins/recall/manifest.json' with { type: 'json' }
import rhythmManifest from '../../plugins/rhythm/manifest.json' with { type: 'json' }
import dreamManifest from '../../plugins/dream/manifest.json' with { type: 'json' }

async function setup({ withEmbed = false } = {}) {
  const host = createHost({ log: () => {} })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-index-'))
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 's1' } })
  host.registerPlugin(rhythmManifest, rhythm, { config: { dreamAt: '23:59', stateFile: path.join(root, 'r.json') } })
  host.registerPlugin(dreamManifest, dream, { config: { sessionId: 's1', persona: 'p' } })
  await host.enable('memory')
  await host.enable('recall')
  await host.enable('rhythm')
  await host.enable('dream')
  if (withEmbed) {
    host.services.slots.registerProvider({
      id: 'fake-embed', kind: 'embedding', shape: { dim: 1024 },
      call: async ({ input }) => [[String(input).length, 1, 2]],
    })
    host.services.slots.autoBind()
  }
  host.services.slots.bind('dream-chat', { provider: 'x', call: async () => '[]' })
  return { host, memory: host.shared.get('memory'), dream: host.shared.get('dream') }
}

test('没接嵌入时：缺向量列表包含所有带文字的条目', async () => {
  const { memory } = await setup()
  memory.put({ namespace: 'event', kind: 'block', key: 'evt:1', text: '一条旧块', data: {} })
  const missing = memory.missingVectors({ limit: 10 })
  assert.equal(missing.length, 1)
  assert.equal(missing[0].key ?? missing[0].text, '一条旧块')
})

test('补索引 job：把缺的向量都补上', async () => {
  const { memory, dream } = await setup({ withEmbed: true })
  memory.put({ namespace: 'event', kind: 'block', key: 'evt:1', text: '旧块一', data: {} })
  memory.put({ namespace: 'event', kind: 'note', key: 'note:1', text: '旧碎片一', data: {} })
  const out = await dream.run({ now: Date.now(), jobs: ['index'] })
  assert.equal(out.results[0].indexed, 2)
  assert.equal(memory.missingVectors({ limit: 10 }).length, 0, '补齐后不该再有缺的')
  assert.equal(memory.stats().vectors, 2)
})

test('补索引幂等：没有缺的就跳过', async () => {
  const { memory, dream } = await setup({ withEmbed: true })
  memory.put({ namespace: 'event', kind: 'block', key: 'evt:1', text: '已有', data: {} })
  await dream.run({ now: Date.now(), jobs: ['index'] })
  const second = await dream.run({ now: Date.now(), jobs: ['index'], force: true })
  assert.equal(second.results[0].skipped, 'nothing-missing')
})

test('手动接口：dream.run({jobs:[index]}) 可单独调用', async () => {
  const { memory, dream } = await setup({ withEmbed: true })
  memory.put({ namespace: 'event', kind: 'block', key: 'evt:1', text: '手动补', data: {} })
  const out = await dream.service?.run?.({ jobs: ['index'] }) ?? await dream.run({ now: Date.now(), jobs: ['index'] })
  assert.equal(out.results[0].indexed, 1)
})
