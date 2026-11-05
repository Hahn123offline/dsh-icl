// note：被动备忘录；有计数进世界状态；不推消息。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../src/index.mjs'
import * as memory from '../../plugins/memory/src/index.mjs'
import * as note from '../../plugins/note/src/index.mjs'
import * as world from '../../plugins/world-state/src/index.mjs'
import memoryManifest from '../../plugins/memory/manifest.json' with { type: 'json' }
import noteManifest from '../../plugins/note/manifest.json' with { type: 'json' }
import worldManifest from '../../plugins/world-state/manifest.json' with { type: 'json' }

async function setup({ withWorld = true } = {}) {
  const host = createHost({ log: () => {} })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-note-'))
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(noteManifest, note, {})
  if (withWorld) host.registerPlugin(worldManifest, world, {})
  await host.enable('memory')
  if (withWorld) await host.enable('world-state')
  await host.enable('note')
  const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))
  return { host, tools, memory: host.shared.get('memory'), note: host.shared.get('note') }
}

test('备忘：写一条、看得到、可结掉', async () => {
  const { tools, note } = await setup()
  await tools.memo.execute({ text: '记得问他到底男的女的' })
  assert.equal(note.count(), 1)
  const list = await tools.memos.execute()
  assert.match(list.text, /男的女的/)
  assert.match(list.text, /#\d+/, 'memos 必须露出 id，memo_commit/append 才能用')
  const id = note.open()[0].id
  note.resolve(id, { answer: '男的' })
  assert.equal(note.count(), 0)
  assert.match((await tools.memos.execute()).text, /没有待办/)
})

test('备忘进世界状态：有未结事项就有一条简短提醒', async () => {
  const { tools, host } = await setup()
  assert.doesNotMatch(host.services.prompt.assemble(), /件事/)
  await tools.memo.execute({ text: '回头问一句' })
  const brief = host.services.prompt.assemble()
  assert.match(brief, /还有 1 件事没了结/)
})

test('备忘不是记忆：recall 搜不到它', async () => {
  const host = createHost({ log: () => {} })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-note2-'))
  const recall = await import('../../plugins/recall/src/index.mjs')
  const recallManifest = (await import('../../plugins/recall/manifest.json', { with: { type: 'json' } })).default
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 's1' } })
  host.registerPlugin(noteManifest, note, {})
  await host.enable('memory')
  await host.enable('recall')
  await host.enable('note')
  const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))
  await tools.memo.execute({ text: '别忘了他是不是男的' })
  const out = await tools.recall.execute({ query: '男的女的' })
  assert.doesNotMatch(out.text, /别忘了他是不是男的/)
})

test('没有世界状态时也能用', async () => {
  const { tools, note } = await setup({ withWorld: false })
  await tools.memo.execute({ text: '独立运行' })
  assert.equal(note.count(), 1)
})

test('note_status 的计数不受 500 行读取窗口限制', async () => {
  const { tools, note } = await setup({ withWorld: false })
  for (let i = 0; i < 501; i += 1) note.add({ text: `待办 ${i}` })
  const done = note.add({ text: '已完成的' })
  note.commit(done.id, { result: '做完了' })
  const out = await tools.note_status.execute()
  assert.match(out.text, /待办 501 条/)
  assert.match(out.text, /已完成待回收 1 条/)
})
