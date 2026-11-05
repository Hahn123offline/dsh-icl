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

test('同一个未知词重复学，只留一条待办', async () => {
  const { tools, note } = await setup()
  await tools.lexicon_learn.execute({ term: '重复词' })
  await tools.lexicon_learn.execute({ term: '重复词' })
  assert.equal(note.count(), 1)
})

test('conv=web 能查到默认 web 来源的词（存的是 null）', async () => {
  const { tools } = await setup()
  await tools.lexicon_learn.execute({ term: '网页词', meaning: '网页上的说法' })
  const out = await tools.lexicon.execute({ term: '网页词', conv: 'web' })
  assert.match(out.text, /网页词/)
})

test('老词在 500 条窗口之外时，重学不能丢掉旧 origins/tags/decay', async () => {
  const { host, tools } = await setup()
  const mem = host.shared.get('memory')
  mem.put({
    namespace: 'lexicon', kind: 'term', key: 'lexicon:web:老词', text: '老词：旧义',
    data: {
      term: '老词',
      origins: [{ conv: null, url: null, meaning: '旧义', status: 'confirmed' }],
      tags: ['旧标签'],
      usage: '旧用法',
      status: 'confirmed',
      decay: { weight: 2, lastSeen: Date.now() - 10_000 },
    },
    now: 1000,
  })
  for (let i = 0; i < 500; i += 1) {
    mem.put({ namespace: 'lexicon', kind: 'term', key: `lexicon:web:填充${i}`, text: `填充${i}`, now: 2000 + i })
  }
  await tools.lexicon_learn.execute({ term: '老词', url: 'http://example.com/x' })
  const row = mem.query({ namespace: 'lexicon', kind: 'term', key: 'lexicon:web:老词', limit: 1 })[0]
  assert.equal(row.data.origins[0].meaning, '旧义')
  assert.ok(row.data.tags.includes('旧标签'))
  assert.equal(row.data.decay.weight, 2)
  assert.ok(row.data.origins.some((o) => o.url === 'http://example.com/x'))
})

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
