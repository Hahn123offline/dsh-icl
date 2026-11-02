// 做梦轮：从笔记里发现新说法，并让老词按时间老化。
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
import * as lexicon from '../../plugins/lexicon/src/index.mjs'
import memoryManifest from '../../plugins/memory/manifest.json' with { type: 'json' }
import recallManifest from '../../plugins/recall/manifest.json' with { type: 'json' }
import rhythmManifest from '../../plugins/rhythm/manifest.json' with { type: 'json' }
import dreamManifest from '../../plugins/dream/manifest.json' with { type: 'json' }
import noteManifest from '../../plugins/note/manifest.json' with { type: 'json' }
import lexiconManifest from '../../plugins/lexicon/manifest.json' with { type: 'json' }

test('做梦轮能从笔记里学到新词，并进待办', async () => {
  const host = createHost({ log: () => {} })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-lexd-'))
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 's1' } })
  host.registerPlugin(rhythmManifest, rhythm, { config: { dreamAt: '23:59', stateFile: path.join(root, 'r.json') } })
  host.registerPlugin(dreamManifest, dream, { config: { sessionId: 's1', persona: 'p' } })
  host.registerPlugin(noteManifest, note, {})
  host.registerPlugin(lexiconManifest, lexicon, {})
  for (const id of ['memory', 'recall', 'rhythm', 'dream', 'note', 'lexicon']) await host.enable(id)
  host.services.slots.bind('dream-chat', { provider: 'fake', call: async ({ messages }) => {
    const sys = String(messages?.[0]?.content ?? '')
    if (sys.includes('不认识或不确定')) return JSON.stringify([{ term: '典', meaning: '', conv: 'group:1' }])
    return '[]'
  } })
  const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))
  await tools.remember.execute({ text: '群里有人说太典了', kind: 'event' })
  const out = await host.shared.get('dream').run({ now: Date.now(), jobs: ['lexicon'] })
  assert.equal(out.results[0].learned, 1)
  assert.equal(host.shared.get('note').count(), 1, '不确定的词要进待办')
  const row = host.shared.get('memory').query({ namespace: 'lexicon', kind: 'term' })[0]
  assert.equal(row.data.term, '典')
  assert.equal(row.data.status, 'candidate')
})

test('老词按时间老化：usage 变 fading，权重下降', async () => {
  const host = createHost({ log: () => {} })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-lexa-'))
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 's1' } })
  host.registerPlugin(rhythmManifest, rhythm, { config: { dreamAt: '23:59', stateFile: path.join(root, 'r.json') } })
  host.registerPlugin(dreamManifest, dream, { config: { sessionId: 's1', persona: 'p' } })
  host.registerPlugin(lexiconManifest, lexicon, {})
  for (const id of ['memory', 'recall', 'rhythm', 'dream', 'lexicon']) await host.enable(id)
  host.services.slots.bind('dream-chat', { provider: 'fake', call: async () => '[]' })
  const mem = host.shared.get('memory')
  mem.registerNamespace({ id: 'lexicon', label: '语料', recallable: true })
  mem.put({ namespace: 'lexicon', kind: 'term', key: 'lexicon:group:1:老词', text: '老词', data: { term: '老词', decay: { weight: 1, lastSeen: Date.now() - 40 * 86400000 }, origins: [] } })
  const out = await host.shared.get('dream').run({ now: Date.now(), jobs: ['lexicon'] })
  assert.equal(out.results[0].faded, 1)
  const row = mem.query({ namespace: 'lexicon', kind: 'term' })[0]
  assert.equal(row.data.usageState, 'fading')
  assert.ok(row.data.decay.weight < 1)
})
