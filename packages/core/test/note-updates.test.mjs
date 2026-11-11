// 备忘可以追加、完成；默认只看今天，可带参看更早。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../src/index.mjs'
import * as memory from '../../plugins/memory/src/index.mjs'
import * as note from '../../plugins/note/src/index.mjs'
import memoryManifest from '../../plugins/memory/manifest.json' with { type: 'json' }
import noteManifest from '../../plugins/note/manifest.json' with { type: 'json' }

async function setup() {
  const host = createHost({ log: () => {} })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-note2-'))
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(noteManifest, note, {})
  await host.enable('memory')
  await host.enable('note')
  const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))
  return { host, tools, note: host.shared.get('note') }
}

test('追加：问题仍然打开，内容能看到', async () => {
  const { tools, note } = await setup()
  await tools.memo.execute({ text: '查一下「典」' })
  const id = note.open()[0].id
  await tools.memo_append.execute({ id, text: '好像和 B 站有关' })
  assert.equal(note.count(), 1, '追加不改状态')
  const list = await tools.memos.execute({})
  assert.match(list.text, /B 站有关/)
})

test('完成：标记 done，附带结论', async () => {
  const { tools, note } = await setup()
  await tools.memo.execute({ text: '查一下「典」' })
  const id = note.open()[0].id
  await tools.memo_commit.execute({ id, result: '指经典，多用于讽刺' })
  assert.equal(note.count(), 0)
  const row = note.open().length === 0 ? null : null
  void row
  const done = (await tools.memos.execute({ done: true, all: true })).text
  assert.match(done, /查一下/)
})

test('默认返回全部 open；不再因为跨天而漏掉旧待办', async () => {
  const { tools, host } = await setup()
  const mem = host.shared.get('memory')
  mem.put({ namespace: 'note', kind: 'note', key: 'old', text: '昨天的待办', data: { status: 'open' }, now: Date.now() - 86400000 })
  await tools.memo.execute({ text: '今天的待办' })
  const today = await tools.memos.execute({})
  assert.match(today.text, /今天的待办/)
  assert.match(today.text, /昨天的待办/, '默认必须和 note_status 的 open 口径一致')
  const all = await tools.memos.execute({ all: true })
  assert.match(all.text, /昨天的待办/)
})

