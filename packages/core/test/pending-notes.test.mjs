// 不成块的碎片不能丢：可召回、可跨天重试、可被整理轮处理。

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

async function setup({ script } = {}) {
  const host = createHost({ log: () => {} })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-pending-'))
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 's1' } })
  host.registerPlugin(rhythmManifest, rhythm, { config: { dreamAt: '23:59', stateFile: path.join(root, 'r.json') } })
  host.registerPlugin(dreamManifest, dream, { config: { sessionId: 's1', persona: 'p' } })
  await host.enable('memory')
  await host.enable('recall')
  await host.enable('rhythm')
  await host.enable('dream')
  host.services.slots.bind('dream-chat', {
    provider: 'fake',
    call: async ({ messages }) => {
      const system = String(messages?.[0]?.content ?? '')
      return script?.(system) ?? '[]'
    },
  })
  const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))
  return { host, memory: host.shared.get('memory'), dream: host.shared.get('dream'), tools }
}

test('模型不肯成块时，原文仍在、可召回、不算已消化', async () => {
  const { tools, memory, dream } = await setup({ script: () => '[]' })
  await tools.remember.execute({ text: '他提到一个地名，就一句', kind: 'event' })
  const out = await dream.run({ now: Date.now(), jobs: ['events'] })
  assert.equal(out.results[0].blocks, 0)
  assert.equal(out.results[0].deferred, 1)
  const notes = memory.query({ namespace: 'event', kind: 'note' })
  assert.equal(notes[0].data?.consolidated, undefined, '不能标已消化')
  const recalled = await tools.recall.execute({ query: '地名' })
  assert.match(recalled.text, /他提到一个地名/, '碎片要能被回忆到')
})

test('碎片跨天也不丢：第二天仍然可召回，并继续参与做梦', async () => {
  const { tools, memory, dream } = await setup({ script: () => '[]' })
  const yesterday = Date.now() - 30 * 3600_000
  memory.put({ namespace: 'event', kind: 'note', key: 'note:old', text: '昨天只说了半句话', now: yesterday })
  const recalled = await tools.recall.execute({ query: '半句话' })
  assert.match(recalled.text, /昨天只说了半句话/)
  assert.match(recalled.text, /未整理/, '跨天碎片要标成未整理')
  // 第二天做梦仍会把它带上
  await dream.run({ now: Date.now(), jobs: ['events'] })
  const notes = memory.query({ namespace: 'event', kind: 'note' })
  assert.equal(notes[0].data?.consolidated, undefined)
})

test('人物材料不足时也要建档（薄档案），且笔记不丢', async () => {
  const { tools, memory, dream } = await setup({ script: (system) => (system.includes('人物档案') ? JSON.stringify({ profile: '' }) : '[]') })
  await tools.remember.execute({ text: '他好像叫什么来着', kind: 'person', qq: '99' })
  const out = await dream.run({ now: Date.now(), jobs: ['people'] })
  assert.equal(out.results[0].blocks, 1, '有材料就要建档')
  const block = memory.query({ namespace: 'person', kind: 'block' })[0]
  assert.match(block.data.profile, /好像叫什么/, '空档案要用笔记原文兜底')
  const recalled = await tools.recall.execute({ kind: 'person' })
  assert.match(recalled.text, /好像叫什么/)
})
