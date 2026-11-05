// 红队 D1/D2/D4：回忆要诚实（没有就说没有、不凑数、不 boost）、记忆要能改能删（key/id/确认语）。
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-recall-honesty-'))
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 's1', budgetTokens: 10_000 } })
  await host.enable('memory')
  await host.enable('recall')
  const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))
  return { host, tools, memory: host.shared.get('memory') }
}

const eventNotes = (mem) => mem.query({ namespace: 'event', kind: 'note', limit: 50, order: 'desc' })

test('remember 返回可用的 key；forget 用这个 key 能删掉，再删给出明确"没找到"', async () => {
  const { tools } = await setup()
  const wrote = await tools.remember.execute({ text: '下午在河边看到白鹭。', kind: 'event' })
  const key = /key=([^\s，。）]+)/.exec(wrote.text)?.[1]
  assert.ok(key, `remember 应返回 key：${wrote.text}`)
  assert.match(wrote.text, /记下了/)
  const removed = await tools.forget.execute({ key, kind: 'event' })
  assert.match(removed.text, /删掉了/)
  const again = await tools.forget.execute({ key, kind: 'event' })
  assert.match(again.text, /没找到要删的/)
  assert.match(again.text, /recall/, '找不到时要给下一步（先用 recall 找）')
})

test('remember 带 key = 改写，确认语是"改掉了"', async () => {
  const { tools } = await setup()
  const first = await tools.remember.execute({ text: '旧说法', kind: 'event', key: 'evt:custom' })
  assert.match(first.text, /记下了/)
  const second = await tools.remember.execute({ text: '新说法', kind: 'event', key: 'evt:custom' })
  assert.match(second.text, /改掉了/)
  assert.doesNotMatch(second.text, /记下了/)
})

test('forget 也接受 id（remember/recall 都有）', async () => {
  const { tools, memory } = await setup()
  await tools.remember.execute({ text: '一条待删的记忆', kind: 'event' })
  const id = eventNotes(memory)[0].id
  const out = await tools.forget.execute({ id, kind: 'event' })
  assert.match(out.text, /删掉了/)
  assert.equal(eventNotes(memory).length, 0)
})

test('forget 既没 key 也没 id 时给出可操作提示（不是静默失败）', async () => {
  const { tools } = await setup()
  const out = await tools.forget.execute({})
  assert.match(out.text, /key 或 id/)
})

test('无关 query 不凑数：不返回不相关笔记、不 boost（lastRecalledAt 不变）', async () => {
  const { tools, memory } = await setup()
  await tools.remember.execute({ text: '下午在河边看到白鹭。', kind: 'event' })
  const before = eventNotes(memory)[0]
  const out = await tools.recall.execute({ query: '量子力学 薛定谔' })
  assert.doesNotMatch(out.text, /白鹭/, `不应端出不相关记忆：${out.text}`)
  assert.match(out.text, /没找到相关记忆/)
  assert.match(out.text, /检索了 \d+ 条/, '要如实说检索了多少条')
  assert.match(out.text, /换个说法|cursor/, '要给下一步')
  const after = eventNotes(memory)[0]
  assert.equal(after.lastRecalledAt ?? null, before.lastRecalledAt ?? null, '空召回不能 boost')
})

test('未整理笔记不再"不管问什么都先塞一半配额"', async () => {
  const { tools } = await setup()
  await tools.remember.execute({ text: '他说周末可能去看海。', kind: 'event' })
  const out = await tools.recall.execute({ query: '量子力学' })
  assert.doesNotMatch(out.text, /看海/)
  assert.match(out.text, /没找到相关记忆/)
})

test('范围过滤后为空、但全局有记忆：不能说"也没记过"（全局假否定）', async () => {
  const { tools } = await setup()
  await tools.remember.execute({ text: '他怕水。', kind: 'event' })
  const out = await tools.recall.execute({ query: '怕水', tag: '根本不存在的标签' })
  assert.doesNotMatch(out.text, /也没记过/)
  assert.match(out.text, /范围里没有相关记忆/, `应说清是范围问题：${out.text}`)
  assert.match(out.text, /全局还有 1 条/, '要说清全局还有多少')
})

test('全局真的空：才说"一条记忆都没有过"', async () => {
  const { tools } = await setup()
  const out = await tools.recall.execute({ query: '河边 白鹭' })
  assert.match(out.text, /一条记忆都没有过/)
})

test('相关 query 仍能召回（回归）', async () => {
  const { tools } = await setup()
  await tools.remember.execute({ text: '下午在河边看到白鹭。', kind: 'event' })
  const out = await tools.recall.execute({ query: '河边 白鹭' })
  assert.match(out.text, /白鹭/)
})

test('cursor 继续想：第二次不重复，给"已经给过"而不是假装没找到', async () => {
  const { tools } = await setup()
  await tools.remember.execute({ text: '下午在河边看到白鹭。', kind: 'event' })
  const first = await tools.recall.execute({ query: '河边 白鹭' })
  assert.ok(first.cursor, '第一次应返回 cursor')
  const second = await tools.recall.execute({ query: '河边 白鹭', cursor: first.cursor })
  assert.match(second.text, /已经给过/)
  assert.doesNotMatch(second.text, /白鹭/)
})
