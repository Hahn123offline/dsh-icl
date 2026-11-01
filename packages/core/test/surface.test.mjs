// 工具面：按已启用插件整理工具，启停即变，可按预设过滤。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../src/index.mjs'
import * as memory from '../../plugins/memory/src/index.mjs'
import * as recall from '../../plugins/recall/src/index.mjs'
import * as note from '../../plugins/note/src/index.mjs'
import memoryManifest from '../../plugins/memory/manifest.json' with { type: 'json' }
import recallManifest from '../../plugins/recall/manifest.json' with { type: 'json' }
import noteManifest from '../../plugins/note/manifest.json' with { type: 'json' }

async function setup() {
  const host = createHost({ log: () => {} })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-surface-'))
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 's1' } })
  host.registerPlugin(noteManifest, note, {})
  return host
}

test('工具面只列已启用插件的工具，并标出归属', async () => {
  const host = await setup()
  await host.enable('memory')
  await host.enable('recall')
  const list = host.services.surface.list()
  const names = list.map((t) => t.name).sort()
  assert.deepEqual(names, ['forget', 'recall', 'remember'])
  assert.equal(list.find((t) => t.name === 'remember').plugin, 'recall')
})

test('启用 note 后工具面出现 memo/memos', async () => {
  const host = await setup()
  await host.enable('memory')
  await host.enable('recall')
  await host.enable('note')
  const names = host.services.surface.names()
  assert.ok(names.includes('memo'))
  assert.ok(names.includes('memos'))
})

test('停用插件后工具面立即收缩，并触发 onChange', async () => {
  const host = await setup()
  await host.enable('memory')
  await host.enable('recall')
  await host.enable('note')
  let fired = 0
  const off = host.services.surface.onChange(() => { fired += 1 })
  await host.disable('note')
  assert.ok(!host.services.surface.names().includes('memo'))
  assert.ok(fired > 0)
  off()
})

test('summary 能看到每个插件贡献了什么', async () => {
  const host = await setup()
  await host.enable('memory')
  await host.enable('recall')
  const s = host.services.surface.summary()
  const recallEntry = s.find((x) => x.plugin === 'recall')
  assert.deepEqual(recallEntry.tools.sort(), ['forget', 'recall', 'remember'])
})
