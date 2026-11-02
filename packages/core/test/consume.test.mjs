// 回收：done 的备忘写回归属地，然后归档；没结论的不动。
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

async function setup() {
  const host = createHost({ log: () => {} })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-consume-'))
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 's1' } })
  host.registerPlugin(rhythmManifest, rhythm, { config: { dreamAt: '23:59', stateFile: path.join(root, 'r.json') } })
  host.registerPlugin(dreamManifest, dream, { config: { sessionId: 's1', persona: 'p' } })
  host.registerPlugin(noteManifest, note, {})
  host.registerPlugin(lexiconManifest, lexicon, {})
  for (const id of ['memory', 'recall', 'rhythm', 'dream', 'note', 'lexicon']) await host.enable(id)
  host.services.slots.bind('dream-chat', { provider: 'fake', call: async () => '[]' })
  const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))
  return { host, tools, note: host.shared.get('note'), mem: host.shared.get('memory') }
}

test('结束的词条问题被回收：词条更新、备忘归档', async () => {
  const { host, tools, note, mem } = await setup()
  await tools.lexicon_learn.execute({ term: '典', conv: 'group:1' })
  const id = note.open()[0].id
  await tools.memo_append.execute({ id, text: '好像和 B 站有关' })
  await tools.memo_commit.execute({ id, result: '指经典，多用于讽刺' })
  const out = await host.shared.get('dream').run({ now: Date.now(), jobs: ['consume'] }).then((r) => r.results[0])
  assert.equal(out.written, 1)
  const term = mem.query({ namespace: 'lexicon', kind: 'term' })[0]
  assert.equal(term.data.status, 'confirmed')
  const archived = mem.query({ namespace: 'note', kind: 'note' })[0]
  assert.equal(archived.data.status, 'archived')
})

test('没有结论的 done 不写回、也不归档', async () => {
  const { host, tools, note, mem } = await setup()
  await tools.memo.execute({ text: '随便一件没结论的事' })
  const id = note.open()[0].id
  await tools.memo_commit.execute({ id })
  const out = await host.shared.get('dream').run({ now: Date.now(), jobs: ['consume'] }).then((r) => r.results[0])
  assert.equal(out.written, 0)
  assert.equal(mem.query({ namespace: 'note', kind: 'note' })[0].data.status, 'done')
})

