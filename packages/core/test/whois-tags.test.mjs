// whois 是身份解析，不是 recall 的别名；tag 只缩小范围，不参与打分。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../src/index.mjs'
import * as memory from '../../plugins/memory/src/index.mjs'
import * as recall from '../../plugins/recall/src/index.mjs'
import * as whois from '../../plugins/whois/src/index.mjs'
import memoryManifest from '../../plugins/memory/manifest.json' with { type: 'json' }
import recallManifest from '../../plugins/recall/manifest.json' with { type: 'json' }
import whoisManifest from '../../plugins/whois/manifest.json' with { type: 'json' }

async function setup() {
  const host = createHost({ log: () => {} })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-whois-'))
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 's1' } })
  host.registerPlugin(whoisManifest, whois, {})
  await host.enable('memory')
  await host.enable('recall')
  await host.enable('whois')
  const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))
  return { host, tools, memory: host.shared.get('memory') }
}

function seedPerson(memory, { qq, profile, ids = [], familiarity = 'friend' }) {
  return memory.put({
    namespace: 'person', kind: 'block', key: `person:${qq}`, text: profile,
    data: { qq, profile, ids: [{ kind: 'qq', value: qq }, ...ids], familiarity, facts: [] },
  })
}

test('whois：按 QQ 精确命中，返回档案、账号与熟悉度', async () => {
  const { tools, memory } = await setup()
  seedPerson(memory, { qq: '3429502459', profile: '他是个怕水却想去看海的人。', ids: [{ kind: 'mc', value: 'DeepSeekBot' }], familiarity: 'friend' })
  const out = await tools.whois.execute({ qq: '3429502459' })
  assert.match(out.text, /怕水/)
  assert.match(out.text, /mc:DeepSeekBot/)
  assert.match(out.text, /friend/)
})

test('whois：按 MC 账号也能命中', async () => {
  const { tools, memory } = await setup()
  seedPerson(memory, { qq: '42', profile: '一起玩 MC 的人。', ids: [{ kind: 'mc', value: 'Steve' }] })
  const out = await tools.whois.execute({ idKind: 'mc', value: 'Steve' })
  assert.match(out.text, /一起玩 MC 的人/)
})

test('whois：按名字给候选，不硬猜', async () => {
  const { tools, memory } = await setup()
  seedPerson(memory, { qq: '1', profile: '曾嘉睿，舍友，喜欢熬夜。' })
  seedPerson(memory, { qq: '2', profile: '曾嘉睿的老师，偶尔群里说话。' })
  const out = await tools.whois.execute({ name: '曾嘉睿' })
  assert.match(out.text, /2 个可能的人/)
})

test('whois：带上最近提到 TA 的三条事件', async () => {
  const { tools, memory } = await setup()
  seedPerson(memory, { qq: '7', profile: '一个常来聊天的人。' })
  for (let i = 0; i < 4; i++) {
    memory.put({
      namespace: 'event', kind: 'block', key: `evt:${i}`,
      text: `第 ${i} 件事和他有关`,
      data: { people: ['7'], tags: ['测试'] },
    })
  }
  const out = await tools.whois.execute({ qq: '7' })
  assert.match(out.text, /最近提到 TA 的事/)
  const hits = out.text.split('\n').filter((l) => /第 \d 件事/.test(l))
  assert.equal(hits.length, 3, '只带三条')
})

test('whois：没有档案时明确说没有', async () => {
  const { tools } = await setup()
  const out = await tools.whois.execute({ qq: '404' })
  assert.match(out.text, /还没有/)
})

test('recall 的 tag 只缩小范围，不参与打分', async () => {
  const { tools, memory } = await setup()
  memory.put({ namespace: 'event', kind: 'block', key: 'e1', text: '去看海的约定', data: { tags: ['看海', '约定'] } })
  memory.put({ namespace: 'event', kind: 'block', key: 'e2', text: '工作上的烦心事', data: { tags: ['工作'] } })
  const byTag = await tools.recall.execute({ tag: '看海' })
  assert.match(byTag.text, /看海的约定/)
  assert.doesNotMatch(byTag.text, /工作上的烦心事/)
  const all = await tools.recall.execute({})
  assert.match(all.text, /工作上的烦心事/)
})

test('标签有上限：最多 5 个、小写、去重', async () => {
  const { memory } = await setup()
  const { normalizeTags } = await import('../../plugins/dream/src/index.mjs')
  assert.deepEqual(normalizeTags(['看海', '看海', 'A', 'b', 'c', 'd', 'e']), ['看海', 'a', 'b', 'c', 'd'])
  assert.deepEqual(normalizeTags(['这个标签实在是太长了一点']), [])
  assert.equal(memory.tags({ namespace: 'event' }).length >= 0, true)
})
