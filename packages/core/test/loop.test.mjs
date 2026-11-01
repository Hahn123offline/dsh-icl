// 闭环验收：疑问 → 主会话 resolve → 整理轮改写 → 疑问关闭。

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
import * as note from '../../plugins/note/src/index.mjs'
import memoryManifest from '../../plugins/memory/manifest.json' with { type: 'json' }
import recallManifest from '../../plugins/recall/manifest.json' with { type: 'json' }
import rhythmManifest from '../../plugins/rhythm/manifest.json' with { type: 'json' }
import dreamManifest from '../../plugins/dream/manifest.json' with { type: 'json' }
import noteManifest from '../../plugins/note/manifest.json' with { type: 'json' }

async function setup(plan) {
  const host = createHost({ log: () => {} })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-loop-'))
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 's1' } })
  host.registerPlugin(rhythmManifest, rhythm, { config: { dreamAt: '23:59', stateFile: path.join(root, 'r.json') } })
  host.registerPlugin(dreamManifest, dream, { config: { sessionId: 's1', persona: 'p' } })
  host.registerPlugin(noteManifest, note, {})
  for (const id of ['memory', 'recall', 'rhythm', 'dream', 'note']) await host.enable(id)
  host.services.slots.bind('dream-chat', {
    provider: 'fake',
    call: async ({ messages }) => {
      const system = String(messages?.[0]?.content ?? '')
      if (system.includes('整理已有的记忆块')) return JSON.stringify(plan)
      return '[]'
    },
  })
  const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))
  return { host, tools, memory: host.shared.get('memory'), note: host.shared.get('note') }
}

test('闭环：疑问被 resolve 回答后，档案改写且疑问关闭', async () => {
  const { tools, memory, note, host } = await setup({
    merges: [],
    rewrites: [{ key: 'person:42', text: '周子涵是管技术的人，男的。', body: '周子涵是管技术的人，男的。' }],
    consumed: ['note:resolve-1'],
  })
  memory.put({
    namespace: 'person', kind: 'block', key: 'person:42',
    text: '周子涵是管技术的人。',
    data: { qq: '42', profile: '周子涵是管技术的人。', provisional: true },
  })
  note.add({ text: '周子涵是男是女？', about: { namespace: 'person', key: 'person:42' }, raisedBy: 'people', kind: 'question' })
  assert.equal(note.count(), 1)

  // 主会话回答：走既有 resolve 通道，并指明针对谁
  await tools.remember.execute({
    kind: 'resolve',
    text: '周子涵是男的，不是女的',
    key: 'note:resolve-1',
    about: { namespace: 'person', key: 'person:42' },
  })

  const out = await host.shared.get('dream').run({ now: Date.now(), jobs: ['cleanup'] })
  assert.equal(out.results[0].ok, true)
  assert.equal(out.results[0].rewrites, 1)

  const block = memory.query({ namespace: 'person', kind: 'block' })[0]
  assert.match(block.text, /男的/, '档案要按纠正改写')

  assert.equal(note.count(), 0, '对应的疑问要关闭')
  const closed = memory.query({ namespace: 'note', kind: 'note' })[0]
  assert.equal(closed.data.status, 'resolved')
  assert.match(closed.data.answer, /男的/, '关闭时记下回答内容')
})

test('闭环：没有 about 的纠正不会误关无关疑问', async () => {
  const { tools, memory, note, host } = await setup({ merges: [], rewrites: [], consumed: [] })
  memory.put({ namespace: 'event', kind: 'block', key: 'evt:1', text: '某件事', data: {} })
  note.add({ text: '另一件不相干的疑问', about: { namespace: 'event', key: 'evt:9' }, raisedBy: 'events' })
  await tools.remember.execute({ kind: 'resolve', text: '随手纠正一句', key: 'note:resolve-2' })
  await host.shared.get('dream').run({ now: Date.now(), jobs: ['cleanup'] })
  assert.equal(note.count(), 1, '不相干的疑问要留着')
})
