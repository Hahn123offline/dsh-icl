// 部分覆盖：只有被引用到的 note 才算消化，其余留着重试。
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

test('事件 job 只标被引用的 note，其余留待下次', async () => {
  const host = createHost({ log: () => {} })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-partial-'))
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 's1' } })
  host.registerPlugin(rhythmManifest, rhythm, { config: { dreamAt: '23:59', stateFile: path.join(root, 'r.json') } })
  host.registerPlugin(dreamManifest, dream, { config: { sessionId: 's1', persona: 'p' } })
  for (const id of ['memory', 'recall', 'rhythm', 'dream']) await host.enable(id)
  host.services.slots.bind('dream-chat', { provider: 'fake', call: async () => JSON.stringify([
    { summary: '只记了第一件事', body: '第一件事。', evidence: [1] },
  ]) })
  const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))
  await tools.remember.execute({ text: '第一件事', kind: 'event' })
  await tools.remember.execute({ text: '第二件事没被写进块', kind: 'event' })
  const out = await host.shared.get('dream').run({ now: Date.now(), jobs: ['events'] })
  const notes = host.shared.get('memory').query({ namespace: 'event', kind: 'note' })
  const covered = notes.find((n) => n.text.includes('第一件'))
  const pending = notes.find((n) => n.text.includes('第二件'))
  assert.equal(covered.data?.consolidated, true, '被引用的标记消化')
  assert.equal(pending.data?.consolidated, undefined, '没被引用的留待下次')
  assert.equal(out.results[0].deferred, 1)
})
