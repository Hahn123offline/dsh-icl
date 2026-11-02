// 原文层：块没覆盖到的细节，recall 默认附一句出处。

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

async function setup() {
  const host = createHost({ log: () => {} })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-archive-'))
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 's1' } })
  await host.enable('memory')
  host.services.raw.register({ id: 'test-raw', search: ({ query }) => {
    const q = String(query ?? '')
    if (/qwenstuff|路径|目录|写/.test(q)) return [{ text: '他让我往 C:\\DSH\\qwenstuff\\ 里随便写点东西试试', time: Date.now() }]
    return []
  } })
  await host.enable('recall')
  const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))
  return { tools, memory: host.shared.get('memory') }
}

test('块不覆盖细节时，recall 默认附上原文出处', async () => {
  const { tools, memory } = await setup()
  // 块是概括的，不含路径
  memory.put({
    namespace: 'event', kind: 'block', key: 'evt:1',
    text: '那天我测了写权限，结果不太好', data: { body: '那天我测了写权限，结果不太好。', evidence: [{ type: 'note', id: 1 }] },
  })
  // 原文细节在 note 里
  memory.put({ namespace: 'event', kind: 'note', key: 'note:1', text: '他让我往 C:\\DSH\\qwenstuff\\ 里随便写点东西试试', data: { consolidated: true }, now: Date.now() - 86400000 })

  const out = await tools.recall.execute({ query: 'C:\\DSH\\qwenstuff\\ 下面能写吗' })
  assert.match(out.text, /原文|出处|写权限/, '块没覆盖时要指向原文')
  assert.match(out.text, /10-31|原文|出处|写权限/)
  assert.match(out.text, /C:\\DSH\\qwenstuff|写权限/)
})

test('块已经覆盖细节时，不额外附出处', async () => {
  const { tools, memory } = await setup()
  memory.put({
    namespace: 'event', kind: 'block', key: 'evt:1',
    text: '他让我往 C:\\DSH\\qwenstuff\\ 里写测试文件', data: { body: '' },
  })
  const out = await tools.recall.execute({ query: '我往哪个路径写测试文件？' })
  assert.match(out.text, /C:\\DSH\\qwenstuff/)
  assert.doesNotMatch(out.text, /原文（/, '主结果已覆盖就不补原文')
})

test('没有精确串的普通问句，不触发原文层', async () => {
  const { tools, memory } = await setup()
  memory.put({ namespace: 'event', kind: 'block', key: 'evt:1', text: '他周末要去看海', data: {} })
  memory.put({ namespace: 'event', kind: 'note', key: 'note:1', text: '他周末要去看海，还说怕水', data: {} })
  const out = await tools.recall.execute({ query: '他周末去哪' })
  assert.doesNotMatch(out.text, /出处：/)
})
