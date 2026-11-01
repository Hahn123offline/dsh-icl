// 非 QQ 身份走完整链路：remember → 做梦建档 → whois 查回。
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
import * as whois from '../../plugins/whois/src/index.mjs'
import memoryManifest from '../../plugins/memory/manifest.json' with { type: 'json' }
import recallManifest from '../../plugins/recall/manifest.json' with { type: 'json' }
import rhythmManifest from '../../plugins/rhythm/manifest.json' with { type: 'json' }
import dreamManifest from '../../plugins/dream/manifest.json' with { type: 'json' }
import whoisManifest from '../../plugins/whois/manifest.json' with { type: 'json' }

test('MC 身份：写入 → 建档 → 按 subject 查回', async () => {
  const host = createHost({ log: () => {} })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-mc-'))
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 's1' } })
  host.registerPlugin(rhythmManifest, rhythm, { config: { dreamAt: '23:59', stateFile: path.join(root, 'r.json') } })
  host.registerPlugin(dreamManifest, dream, { config: { sessionId: 's1', persona: 'p' } })
  host.registerPlugin(whoisManifest, whois, {})
  for (const id of ['memory', 'recall', 'rhythm', 'dream', 'whois']) await host.enable(id)
  host.services.slots.bind('dream-chat', { provider: 'fake', call: async ({ messages }) => {
    const sys = String(messages?.[0]?.content ?? '')
    if (sys.includes('人物档案')) return JSON.stringify({ profile: 'Steve 是一起玩 MC 的人。', ids: [{ kind: 'mc', value: 'Steve' }], evidence: [1] })
    return '[]'
  } })
  const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))
  await tools.remember.execute({ text: 'Steve 今天带我挖矿', kind: 'person', qq: 'Steve', subjectKind: 'mc' })
  const out = await host.shared.get('dream').run({ now: Date.now(), jobs: ['people'] })
  assert.equal(out.results[0].blocks, 1)
  const block = host.shared.get('memory').query({ namespace: 'person', kind: 'block' })[0]
  assert.equal(block.data.subject.kind, 'mc')
  const looked = await tools.whois.execute({ subjectKind: 'mc', value: 'Steve' })
  assert.match(looked.text, /一起玩 MC/)
})
