// 人物查询路由到档案，不走通用检索。
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

test('按 QQ 查人：直接返回档案，不混事件', async () => {
  const host = createHost({ log: () => {} })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-route-'))
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 's1' } })
  await host.enable('memory')
  await host.enable('recall')
  const mem = host.shared.get('memory')
  const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))
  mem.put({
    namespace: 'person', kind: 'block', key: 'person:42',
    text: '小林，我的同事，最近在准备考试。',
    data: { qq: '42', profile: '小林，我的同事，最近在准备考试。', claims: [{ text: '小林在准备考试', evidence: [] }] },
  })
  mem.put({ namespace: 'event', kind: 'block', key: 'evt:1', text: '今天开了一个很长的会', data: {} })

  const out = await tools.recall.execute({ query: '42' })
  assert.match(out.text, /\[人物\]/)
  assert.match(out.text, /小林/)
  assert.match(out.text, /依据/)
  assert.doesNotMatch(out.text, /很长的会/)
})
