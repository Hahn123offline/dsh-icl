// 语料层：不确定的进待办，确认后带出处返回。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../src/index.mjs'
import * as memory from '../../plugins/memory/src/index.mjs'
import * as note from '../../plugins/note/src/index.mjs'
import * as lexicon from '../../plugins/lexicon/src/index.mjs'
import memoryManifest from '../../plugins/memory/manifest.json' with { type: 'json' }
import noteManifest from '../../plugins/note/manifest.json' with { type: 'json' }
import lexiconManifest from '../../plugins/lexicon/manifest.json' with { type: 'json' }

async function setup() {
  const host = createHost({ log: () => {} })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-lex-'))
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(noteManifest, note, {})
  host.registerPlugin(lexiconManifest, lexicon, {})
  for (const id of ['memory', 'note', 'lexicon']) await host.enable(id)
  const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))
  return { host, tools, note: host.shared.get('note') }
}

test('没有释义时：记成候选，并在 note 里留一条待办', async () => {
  const { tools, note } = await setup()
  const out = await tools.lexicon_learn.execute({ term: '难绷', conv: 'group:1' })
  assert.match(out.text, /待办|不确定/)
  assert.equal(note.count(), 1)
  const q = note.open()[0]
  assert.match(q.text, /难绷/)
  assert.equal(q.data.about.namespace, 'lexicon')
})

test('有释义后：转成已确认，不再重复提待办', async () => {
  const { tools, note } = await setup()
  await tools.lexicon_learn.execute({ term: '难绷', conv: 'group:1' })
  await tools.lexicon_learn.execute({ term: '难绷', conv: 'group:1', meaning: '绷不住了', usage: '看到离谱的事' })
  const rows = tools.lexicon ? null : null
  void rows
  assert.equal(note.count(), 1, '之前那条待办还在，但不会重复新增')
  const res = await tools.lexicon.execute({ term: '难绷' })
  assert.match(res.text, /已确认/)
  assert.match(res.text, /绷不住了/)
})

test('一个词多来源：按来源分行显示', async () => {
  const { tools } = await setup()
  await tools.lexicon_learn.execute({ term: '典', conv: 'group:1', meaning: '本群用来吐槽' })
  await tools.lexicon_learn.execute({ term: '典', platform: 'bili', url: 'https://b23.tv/x', meaning: 'B站指经典' })
  const res = await tools.lexicon.execute({ term: '典' })
  assert.match(res.text, /group:1/)
  assert.match(res.text, /bili/)
  assert.match(res.text, /B站指经典/)
})

test('按会话或平台查询：桶在同一个地方，两个索引都能用', async () => {
  const { tools } = await setup()
  await tools.lexicon_learn.execute({ term: '典', conv: 'group:1', meaning: '本群吐槽' })
  await tools.lexicon_learn.execute({ term: '典', platform: 'bili', meaning: '经典' })
  assert.match((await tools.lexicon.execute({ conv: 'group:1' })).text, /本群吐槽/)
  assert.match((await tools.lexicon.execute({ platform: 'bili' })).text, /经典/)
})
