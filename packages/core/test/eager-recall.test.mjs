// 自动召回：只交提示词段，不推消息；宁缺毋滥；可关。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../src/index.mjs'
import * as memory from '../../plugins/memory/src/index.mjs'
import * as recall from '../../plugins/recall/src/index.mjs'
import * as eager from '../../plugins/eager-recall/src/index.mjs'
import memoryManifest from '../../plugins/memory/manifest.json' with { type: 'json' }
import recallManifest from '../../plugins/recall/manifest.json' with { type: 'json' }
import eagerManifest from '../../plugins/eager-recall/manifest.json' with { type: 'json' }

async function setup(config = { minScore: 0.05 }) {
  const host = createHost({ log: () => {} })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-eager-'))
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 's1' } })
  host.registerPlugin(eagerManifest, eager, { config })
  await host.enable('memory')
  await host.enable('recall')
  await host.enable('eager-recall')
  return { host, memory: host.shared.get('memory') }
}

test('相关消息会带出一小段记忆，且标明是检索结果', async () => {
  const { host, memory } = await setup()
  memory.put({ namespace: 'event', kind: 'block', key: 'evt:1', text: '他周末要去看海，但怕水', data: {} })
  const text = await host.services.prompt.turnText({ message: '他说的看海是哪天来着' })
  assert.match(text, /你可能记得/)
  assert.match(text, /看海/)
  assert.match(text, /仅供参考/)
})

test('不相关就不注入（宁缺毋滥）', async () => {
  const { host, memory } = await setup({ minScore: 0.8 })
  memory.put({ namespace: 'event', kind: 'block', key: 'evt:1', text: '他周末要去看海', data: {} })
  const text = await host.services.prompt.turnText({ message: '帮我算一下 1+1' })
  assert.equal(text, '')
})

test('最多两条、有总字数预算', async () => {
  const { host, memory } = await setup({ minScore: 0.1, maxItems: 2, maxChars: 120 })
  for (let i = 0; i < 6; i++) memory.put({ namespace: 'event', kind: 'block', key: `evt:${i}`, text: `看海的第 ${i} 件事`, data: {} })
  const text = await host.services.prompt.turnText({ message: '看海' })
  assert.ok(text.split('\n').filter((l) => l.startsWith('·')).length <= 2)
  assert.ok(text.length <= 120)
})

test('停用插件后不再注入（走统一注册/注销）', async () => {
  const { host, memory } = await setup()
  memory.put({ namespace: 'event', kind: 'block', key: 'evt:1', text: '他周末要去看海', data: {} })
  assert.match(await host.services.prompt.turnText({ message: '看海' }), /看海/)
  host.disable('eager-recall')
  assert.equal(await host.services.prompt.turnText({ message: '看海' }), '')
})

test('自动召回不推消息：投递队列保持为空', async () => {
  const { host, memory } = await setup()
  memory.put({ namespace: 'event', kind: 'block', key: 'evt:1', text: '他周末要去看海', data: {} })
  await host.services.prompt.turnText({ message: '看海' })
  assert.equal(host.services.delivery.drain('session').length, 0, '只能注入提示词，不能自己发消息')
})
