// 整理轮：合并重复、处理纠正、软删除被合并的块。

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

async function setup(plan) {
  const host = createHost({ log: () => {} })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-clean-'))
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 's1' } })
  host.registerPlugin(rhythmManifest, rhythm, { config: { dreamAt: '23:59', stateFile: path.join(root, 'r.json') } })
  host.registerPlugin(dreamManifest, dream, { config: { sessionId: 's1', persona: '你是记忆沉淀器。' } })
  await host.enable('memory')
  await host.enable('recall')
  await host.enable('rhythm')
  await host.enable('dream')
  let calls = 0
  host.services.slots.bind('dream-chat', {
    provider: 'fake',
    call: async ({ messages }) => {
      calls += 1
      const system = String(messages?.[0]?.content ?? '')
      if (system.includes('整理已有的记忆块')) return JSON.stringify(typeof plan === 'function' ? plan(calls) : plan)
      return '[]'
    },
  })
  return { host, memory: host.shared.get('memory'), dream: host.shared.get('dream'), calls: () => calls }
}

test('整理：合并重复的块，被合并的块不再被 recall 召回', async () => {
  const { memory, dream } = await setup({
    merges: [{ keep: 'evt:1', drop: ['evt:2'], text: '他周末要去看海', body: '他周末要去看海，但他说自己怕水。', uncertain: false }],
    rewrites: [], consumed: [],
  })
  memory.put({ namespace: 'event', kind: 'block', key: 'evt:1', text: '他周末要去看海', data: { body: '他周末要去看海。' } })
  memory.put({ namespace: 'event', kind: 'block', key: 'evt:2', text: '他想去看海但怕水', data: { body: '他想去看海但怕水。' } })
  const out = await dream.run({ now: Date.now(), jobs: ['cleanup'] })
  assert.equal(out.results[0].merged, 1)
  const kept = memory.query({ namespace: 'event', kind: 'block', limit: 100 }).find((b) => b.key === 'evt:1')
  assert.match(kept.text, /看海/)
  assert.match(kept.data.body, /怕水/, '正文应包含合并后的信息')
  assert.equal(kept.data.mergedFrom.length, 1, '要记得合并了谁')
  const dropped = memory.query({ namespace: 'event', kind: 'block', limit: 100 }).find((b) => b.key === 'evt:2')
  assert.equal(dropped.data.superseded, true, '被合并的块是软删除，不是消失')
})

test('整理：矛盾且分不清对错时，标记 uncertain', async () => {
  const { memory, dream } = await setup({
    merges: [{ keep: 'evt:1', drop: ['evt:2'], text: '他是否怕水不确定', body: '一次说他怕水，一次说他爱游泳，记不清了。', uncertain: true }],
    rewrites: [], consumed: [],
  })
  memory.put({ namespace: 'event', kind: 'block', key: 'evt:1', text: '他说他怕水', data: {} })
  memory.put({ namespace: 'event', kind: 'block', key: 'evt:2', text: '他去游泳了', data: {} })
  await dream.run({ now: Date.now(), jobs: ['cleanup'] })
  const kept = memory.query({ namespace: 'event', kind: 'block', limit: 100 }).find((b) => b.key === 'evt:1')
  assert.equal(kept.data.uncertain, true)
})

test('整理：主会话的纠正会被处理，并按纠正改写人物档案', async () => {
  const { memory, dream } = await setup({
    merges: [],
    rewrites: [{ key: 'person:42', text: '他其实不怕水，是讨厌海边的风', body: '他并不怕水，只是讨厌海风。' }],
    consumed: ['note:resolve1'],
  })
  memory.put({ namespace: 'person', kind: 'block', key: 'person:42', text: '他怕水，想去看海', data: { qq: '42' } })
  memory.put({
    namespace: 'resolve', kind: 'note', key: 'note:resolve1',
    text: '他其实不怕水，是我记错了', data: { day: 'today' },
  })
  const out = await dream.run({ now: Date.now(), jobs: ['cleanup'] })
  assert.equal(out.results[0].rewrites, 1)
  assert.equal(out.results[0].consumed, 1)
  const person = memory.query({ namespace: 'person', kind: 'block' })[0]
  assert.match(person.text, /不怕水/)
  const note = memory.query({ namespace: 'resolve', kind: 'note' })[0]
  assert.equal(note.data.consumed, true, '纠正被消化后不再重复处理')
})

test('整理：幂等，同一天第二次直接跳过', async () => {
  const { memory, dream } = await setup({ merges: [], rewrites: [], consumed: [] })
  memory.put({ namespace: 'event', kind: 'block', key: 'evt:1', text: '一', data: {} })
  memory.put({ namespace: 'event', kind: 'block', key: 'evt:2', text: '二', data: {} })
  await dream.run({ now: Date.now(), jobs: ['cleanup'] })
  const second = await dream.run({ now: Date.now(), jobs: ['cleanup'] })
  assert.equal(second.results[0].skipped, 'already-ran')
})

test('整理：没东西可整就跳过', async () => {
  const { dream, memory } = await setup({ merges: [], rewrites: [], consumed: [] })
  memory.put({ namespace: 'event', kind: 'block', key: 'evt:1', text: '只有一块', data: {} })
  const out = await dream.run({ now: Date.now(), jobs: ['cleanup'] })
  assert.equal(out.results[0].skipped, 'nothing-to-do')
})
