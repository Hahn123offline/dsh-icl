// 记忆来源（哪个聊天）与自定义标签。
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-origin-'))
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 's1' } })
  await host.enable('memory')
  await host.enable('recall')
  const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))
  return { host, tools, mem: host.shared.get('memory') }
}

test('记住时带上来源，能按会话过滤', async () => {
  const { tools } = await setup()
  await tools.remember.execute({ text: '群里说要去爬山', kind: 'event', origin: { conv: 'group:1', sender: '周子涵' } })
  await tools.remember.execute({ text: '私聊说周末有空', kind: 'event', origin: { conv: 'private:2', sender: 'Hahn123' } })
  const inGroup = await tools.recall.execute({ query: '爬山', conv: 'group:1' })
  assert.match(inGroup.text, /爬山/)
  const wrong = await tools.recall.execute({ query: '爬山', conv: 'private:2' })
  assert.doesNotMatch(wrong.text, /爬山/)
})

test('任意命名空间都能带标签，并可按标签检索', async () => {
  const { tools, mem } = await setup()
  mem.put({ namespace: 'event', kind: 'block', key: 'e1', text: '去海边', data: { tags: ['看海', '约定'] } })
  mem.put({ namespace: 'event', kind: 'block', key: 'e2', text: '加班', data: { tags: ['工作'] } })
  mem.put({ namespace: 'person', kind: 'block', key: 'p1', text: '小林', data: { tags: ['同事'], profile: '小林' } })
  const byTag = await tools.recall.execute({ tag: '看海' })
  assert.match(byTag.text, /海边/)
  assert.doesNotMatch(byTag.text, /加班/)
  const counts = mem.tags({})
  assert.ok(counts.find((x) => x.tag === '同事'))
})
