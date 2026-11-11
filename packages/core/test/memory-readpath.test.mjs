// 读取链回归：recall 能搜 lexicon、无嵌入时精确串加成、alias 参与身份匹配、provisional 显性化。
// 对应 docs/MEMORY-CODE-AUDIT.md F5/F8/F9/F10。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../src/index.mjs'
import * as memory from '../../plugins/memory/src/index.mjs'
import * as recall from '../../plugins/recall/src/index.mjs'
import * as lexicon from '../../plugins/lexicon/src/index.mjs'
import memoryManifest from '../../plugins/memory/manifest.json' with { type: 'json' }
import recallManifest from '../../plugins/recall/manifest.json' with { type: 'json' }
import lexiconManifest from '../../plugins/lexicon/manifest.json' with { type: 'json' }

async function setup({ withLexicon = false } = {}) {
  const host = createHost({ log: () => {} })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-readpath-'))
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 's1' } })
  if (withLexicon) host.registerPlugin(lexiconManifest, lexicon, {})
  await host.enable('memory')
  await host.enable('recall')
  if (withLexicon) await host.enable('lexicon')
  const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))
  return { host, memory: host.shared.get('memory'), tools }
}

test('F8 recall 能召回 lexicon 词条（不再说"这个范围里没有"）', async () => {
  const { memory, tools } = await setup({ withLexicon: true })
  memory.put({
    namespace: 'lexicon', kind: 'term', key: 'lexicon:web:吃白饭',
    text: '吃白饭：本群特指 AI 光吃 token 不干活。',
    data: { term: '吃白饭', origins: [], tags: ['本群'], status: 'confirmed', usageState: 'active' },
  })
  const out = await tools.recall.execute({ query: '吃白饭 是什么意思' })
  assert.match(out.text, /吃白饭/, `应能回忆 lexicon：${out.text}`)
})

test('F9 无嵌入时精确串加成仍然生效', async () => {
  const { host, memory } = await setup()
  memory.put({ namespace: 'event', kind: 'block', key: 'evt:a', text: '装好了 C:\\DSH\\icl\\README.md 那个文件', data: { body: '装好了 C:\\DSH\\icl\\README.md 那个文件' } })
  memory.put({ namespace: 'event', kind: 'block', key: 'evt:b', text: '今天聊了文件安装和路径的问题，还说了 README 与 DSH 的关系', data: { body: '今天聊了文件安装和路径的问题，还说了 README 与 DSH 的关系' } })
  const hits = await host.shared.get('memory').search({ query: 'C:\\DSH\\icl\\README.md', limit: 2, namespaces: ['event'] })
  assert.ok(hits.length >= 1)
  assert.equal(hits[0].item.key, 'evt:a', `精确串命中应排第一：${JSON.stringify(hits.map((h) => [h.item.key, h.sim]))}`)
})

test('F5 findPerson 用 aliases 做精确命中（主人 = Hahn123 不再拆）', async () => {
  const { memory } = await setup()
  memory.put({
    namespace: 'person', kind: 'block', key: 'person:3429502459',
    text: '主人（Hahn123）：负责维护 dsh-icl。',
    data: {
      subject: { kind: 'qq', value: '3429502459' },
      qq: '3429502459',
      ids: [{ kind: 'qq', value: '3429502459' }],
      aliases: ['主人', 'Hahn123', '周子涵'],
      profile: '主人（Hahn123）：负责维护 dsh-icl。',
    },
  })
  const byOwner = memory.findPerson({ name: '主人' })
  assert.equal(byOwner.exact, true)
  assert.equal(byOwner.people.length, 1)
  const byAlias = memory.findPerson({ name: '周子涵' })
  assert.equal(byAlias.exact, true)
  const byQq = memory.findPerson({ qq: '3429502459' })
  assert.equal(byQq.exact, true)
})

test('F10 provisional 块在 recall 里显性标"存疑"', async () => {
  const { memory, tools } = await setup()
  memory.put({
    namespace: 'event', kind: 'block', key: 'evt:guess',
    text: '他好像说过周末要去看海，但没找到原话。',
    data: { body: '他好像说过周末要去看海，但没找到原话。', provisional: true },
  })
  const out = await tools.recall.execute({ query: '周末 看海', overview: false })
  assert.match(out.text, /存疑/, `无出处块应标存疑：${out.text}`)
})

test('时间旅行保护：召回不返回 created_at 在 now 之后的记忆', async () => {
  const { memory, tools } = await setup()
  const now = Date.now()
  memory.put({ namespace: 'event', kind: 'block', key: 'evt:past', text: '过去发生过的事：一起去看海', data: { body: '过去发生过的事：一起去看海' }, now: now - 3600_000 })
  memory.put({ namespace: 'event', kind: 'block', key: 'evt:future', text: '未来才会发生的事：搬去另一个城市', data: { body: '未来才会发生的事：搬去另一个城市' }, now: now + 3600_000 })
  const hits = await memory.search({ query: '未来 城市 搬家', now, namespaces: ['event'] })
  assert.ok(!hits.some((h) => h.item.key === 'evt:future'), '未来记忆不能被召回')
  const later = await memory.search({ query: '未来 城市 搬家', now: now + 2 * 3600_000, namespaces: ['event'] })
  assert.ok(later.some((h) => h.item.key === 'evt:future'), '时间到了之后应可召回')
  const recalled = await tools.recall.execute({ query: '未来 城市 搬家' })
  assert.doesNotMatch(recalled.text, /搬去另一个城市/, 'recall 工具同样不能翻出未来记忆')
})

