// 整理轮也要管人物：提到某人的事件块，要能并进 TA 的档案。

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

async function setup(plan, capture = {}) {
  const host = createHost({ log: () => {} })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-clean-person-'))
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
      capture.system = system
      capture.user = String(messages?.[1]?.content ?? '')
      if (system.includes('整理已有的记忆块')) return JSON.stringify(plan)
      return '[]'
    },
  })
  return { host, memory: host.shared.get('memory') }
}

test('整理轮：事件块里提到的信息能并进人物档案，并带上证据', async () => {
  const capture = {}
  const { host, memory } = await setup({
    merges: [],
    rewrites: [{
      key: 'person:42',
      text: '小林是同事，最近在准备考试，还说过想养猫。',
      body: '小林是同事，最近在准备考试，还说过想养猫。',
      evidence: [1],
    }],
    consumed: [],
  }, capture)
  memory.put({ namespace: 'person', kind: 'block', key: 'person:42', text: '小林是同事。', data: { qq: '42', profile: '小林是同事。' } })
  memory.put({ namespace: 'event', kind: 'block', key: 'evt:cat', text: '小林说想养猫', data: { people: ['42'], evidence: [{ type: 'note', id: 1 }] } })

  const out = await host.shared.get('dream').run({ now: Date.now(), jobs: ['cleanup'] })
  assert.equal(out.results[0].rewrites, 1)

  // 提示词里要能看到这个人绑定的事件，模型才有办法并进去
  assert.match(capture.user, /people=42/, '块列表要标出事件提到的人')
  assert.match(capture.system, /人物块可以用/, '指令要允许人物块吸收事件')

  const block = memory.query({ namespace: 'person', kind: 'block' })[0]
  assert.match(block.text, /养猫/)
  assert.ok((block.data.evidence ?? []).some((e) => e.type === 'block'), '改写要带证据')
})

test('整理轮：人物块和历史事件一起出现在候选里', async () => {
  const capture = {}
  const { host, memory } = await setup({ merges: [], rewrites: [], consumed: [] }, capture)
  memory.put({ namespace: 'person', kind: 'block', key: 'person:7', text: '小周。', data: { qq: '7' } })
  memory.put({ namespace: 'event', kind: 'block', key: 'evt:1', text: '小周昨天加班', data: { people: ['7'] } })
  await host.shared.get('dream').run({ now: Date.now(), jobs: ['cleanup'] })
  assert.match(capture.user, /person:7/)
  assert.match(capture.user, /evt:1/)
})
