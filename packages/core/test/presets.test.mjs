// 我们自己的动态预设：默认全量，可在运行中切换工具面。
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-preset-'))
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 's1' } })
  host.registerPlugin(noteManifest, note, {})
  await host.enable('memory')
  await host.enable('recall')
  await host.enable('note')
  return host
}

test('默认预设包含全部插件', async () => {
  const host = await setup()
  assert.equal(host.services.presets.active(), 'default')
  const names = host.services.surface.names()
  assert.ok(names.includes('remember'))
  assert.ok(names.includes('memo'))
})

test('自定义预设可以在运行中切换工具面', async () => {
  const host = await setup()
  host.services.presets.define({ id: 'mem-only', allow: ['recall'] })
  host.services.presets.use('mem-only')
  const names = host.services.surface.names()
  assert.ok(names.includes('remember'))
  assert.ok(!names.includes('memo'), 'note 不在这个预设里')
  host.services.presets.use('default')
  assert.ok(host.services.surface.names().includes('memo'), '切回来就有了')
})

test('预设的成员关系可以查询', async () => {
  const host = await setup()
  host.services.presets.define({ id: 'qq', allow: ['note'] })
  const entry = host.services.presets.list().find((x) => x.id === 'qq')
  assert.deepEqual(entry.plugins, ['note'])
  host.services.presets.use('qq')
  assert.equal(host.services.presets.allowed().length, 1)
})
