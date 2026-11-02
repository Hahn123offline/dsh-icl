// DSH 适配器：工具面注入、预设切换、卸载回收。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost, attachDshAdapter } from '../src/index.mjs'
import * as memory from '../../plugins/memory/src/index.mjs'
import * as recall from '../../plugins/recall/src/index.mjs'
import * as note from '../../plugins/note/src/index.mjs'
import memoryManifest from '../../plugins/memory/manifest.json' with { type: 'json' }
import recallManifest from '../../plugins/recall/manifest.json' with { type: 'json' }
import noteManifest from '../../plugins/note/manifest.json' with { type: 'json' }

function fakeDsh() {
  const tools = new Map()
  return {
    tools: {
      register(def) {
        tools.set(def.name, def)
        return () => tools.delete(def.name)
      },
    },
    systemPrompt: { section() { return () => {} } },
    tools_() { return tools },
    names: () => [...tools.keys()].sort(),
  }
}

async function setup() {
  const host = createHost({ log: () => {} })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-adapter-'))
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 's1' } })
  host.registerPlugin(noteManifest, note, {})
  await host.enable('memory')
  await host.enable('recall')
  await host.enable('note')
  const dsh = fakeDsh()
  const adapter = attachDshAdapter(host, dsh, { sessionId: 's1' })
  return { host, dsh, adapter }
}

test('适配器把当前工具面注入 DSH', async () => {
  const { dsh } = await setup()
  assert.deepEqual(dsh.names(), ['forget', 'memo', 'memo_append', 'memo_commit', 'memos', 'note_status', 'recall', 'remember'])
})

test('切换预设后，DSH 的工具面跟着变', async () => {
  const { host, dsh } = await setup()
  host.services.presets.define({ id: 'mem-only', allow: ['recall'] })
  host.services.presets.use('mem-only')
  host.services.surface.notify()
  assert.deepEqual(dsh.names(), ['forget', 'recall', 'remember'])
  host.services.presets.use('default')
  host.services.surface.notify()
  assert.ok(dsh.names().includes('memo'))
})

test('卸载适配器会收回它注册的工具', async () => {
  const { dsh, adapter } = await setup()
  assert.ok(dsh.names().length > 0)
  adapter.dispose()
  assert.deepEqual(dsh.names(), [])
})

test('turn() 汇总自动召回与上下文策略', async () => {
  const { host, adapter } = await setup()
  host.services.context.onAssemble({ name: 'x', apply: () => '早前聊过记忆。' })
  const text = await adapter.turn('继续')
  assert.match(text, /早前聊过记忆/)
})
