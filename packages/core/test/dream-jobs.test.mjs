// 做梦的三个 job：幂等、可重跑、不吞原文。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../src/index.mjs'
import * as memory from '../../plugins/memory/src/index.mjs'
import * as recall from '../../plugins/recall/src/index.mjs'
import * as rhythm from '../../plugins/rhythm/src/index.mjs'
import * as dream from '../../plugins/dream/src/index.mjs'
import memoryManifest from '../../plugins/memory/manifest.json' with { type: 'json' }
import recallManifest from '../../plugins/recall/manifest.json' with { type: 'json' }
import rhythmManifest from '../../plugins/rhythm/manifest.json' with { type: 'json' }
import dreamManifest from '../../plugins/dream/manifest.json' with { type: 'json' }

function fakeChat(script) {
  const calls = []
  const call = async ({ messages }) => {
    calls.push(messages)
    const system = String(messages?.[0]?.content ?? '')
    for (const [needle, reply] of script) if (system.includes(needle)) return reply
    return '[]'
  }
  return { call, calls }
}

async function setup({ script = [] } = {}) {
  const host = createHost({ log: () => {} })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-dream2-'))
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 's1' } })
  host.registerPlugin(rhythmManifest, rhythm, { config: { dreamAt: '23:59', stateFile: path.join(root, 'r.json') } })
  host.registerPlugin(dreamManifest, dream, { config: { sessionId: 's1', persona: '你是她夜里的记忆沉淀器。' } })
  await host.enable('memory')
  await host.enable('recall')
  await host.enable('rhythm')
  await host.enable('dream')
  const chat = fakeChat(script)
  host.services.slots.bind('dream-chat', { provider: 'fake', call: chat.call })
  const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))
  return { host, tools, chat, memory: host.shared.get('memory'), dream: host.shared.get('dream') }
}

test('事件 job：按话题切块、写进 event、note 被标为已消化', async () => {
  const { tools, memory, dream } = await setup({
    script: [['事件块', JSON.stringify([
      { summary: '看了盲人导航视频', body: '下午他给我看了一个讲盲人导航的视频。', people: ['1'], tags: ['视频'], evidence: [1] },
      { summary: '他工作很烦', body: '他说工作很烦，我没拱火。', people: ['1'], tags: ['情绪'], evidence: [2] },
    ])]],
  })
  await tools.remember.execute({ text: '看了盲人导航视频', kind: 'event' })
  await tools.remember.execute({ text: '他说工作很烦', kind: 'event' })
  const out = await dream.run({ now: Date.now(), jobs: ['events'] })
  assert.equal(out.ok, true)
  assert.equal(out.results[0].blocks, 2)
  const blocks = memory.query({ namespace: 'event', kind: 'block' })
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].data.people[0], '1')
  assert.ok(blocks[0].data.sources.length >= 1, '块要记得自己来自哪些笔记')
  const notes = memory.query({ namespace: 'event', kind: 'note' })
  assert.ok(notes.every((n) => n.data?.consolidated === true), 'note 应被标记已消化')
})

test('幂等：同一天重跑不会重复写块', async () => {
  const { tools, memory, dream } = await setup({
    script: [['事件块', JSON.stringify([{ summary: '一件事', body: '正文' }])]],
  })
  await tools.remember.execute({ text: '一件事', kind: 'event' })
  await dream.run({ now: Date.now(), jobs: ['events'] })
  const before = memory.query({ namespace: 'event', kind: 'block' }).length
  const second = await dream.run({ now: Date.now(), jobs: ['events'] })
  assert.equal(second.results[0].skipped, 'already-ran')
  assert.equal(memory.query({ namespace: 'event', kind: 'block' }).length, before)
})

test('失败不吞原文：模型报错时 note 仍可重跑', async () => {
  const { tools, memory, dream, host } = await setup()
  host.services.slots.bind('dream-chat', { provider: 'boom', call: async () => { throw new Error('模型挂了') } })
  await tools.remember.execute({ text: '不能被吞掉', kind: 'event' })
  const out = await dream.run({ now: Date.now(), jobs: ['events'] })
  assert.equal(out.ok, false)
  const notes = memory.query({ namespace: 'event', kind: 'note' })
  assert.equal(notes[0].data?.consolidated, undefined, '失败时不能标已消化')
})

test('人物 job：按 QQ 分组、整块重写、保留旧档案做输入', async () => {
  const { tools, memory, dream, chat } = await setup({
    script: [['人物档案', JSON.stringify({ profile: '我认识的他：怕水，但一直叻记着海。', narrative: '他说怕水，可一直惦记着海。', facts: [{ text: '怕水', since: '2026-11-01' }] })]],
  })
  await tools.remember.execute({ text: '他怕水', kind: 'person', qq: '42' })
  await tools.remember.execute({ text: '他想去看海', kind: 'person', qq: '42' })
  const out = await dream.run({ now: Date.now(), jobs: ['people'] })
  assert.equal(out.results[0].people, 1)
  const block = memory.query({ namespace: 'person', kind: 'block' })[0]
  assert.equal(block.key, 'person:42')
  assert.match(block.data.profile, /怕水/)
  assert.ok(Array.isArray(block.data.ids) && block.data.ids.some((x) => x.kind === 'qq' && x.value === '42'), 'QQ 号要存在结构化字段里')
  assert.ok(typeof block.data.familiarity === 'string', '熟悉度要有字段')
  assert.ok(block.data.facts.length >= 1)
  // 第二次做梦时旧档案要出现在输入里
  const systems = chat.calls.map((m) => String(m?.[0]?.content ?? ''))
  assert.ok(systems.some((s) => /人物档案/.test(s)), '要有一次是写档案的请求')
})

test('人物：材料少也要写薄档案，标为 provisional', async () => {
  const { tools, memory, dream } = await setup({
    script: [['人物档案', JSON.stringify({ profile: '小林，我的同事，平时爱抽烟。', facts: [] })]],
  })
  await tools.remember.execute({ text: '小林是我同事', kind: 'person', qq: '77' })
  const out = await dream.run({ now: Date.now(), jobs: ['people'] })
  assert.equal(out.results[0].blocks, 1, '一条笔记也要建档')
  const block = memory.query({ namespace: 'person', kind: 'block' })[0]
  assert.equal(block.data.provisional, true)
  assert.match(block.data.profile, /小林/)
})

test('人物：模型给空时用笔记原文拼一份档案，不把人丢掉', async () => {
  const { tools, memory, dream } = await setup({
    script: [['人物档案', JSON.stringify({ profile: '' })]],
  })
  await tools.remember.execute({ text: '他叫陈九，修车的', kind: 'person', qq: '88' })
  const out = await dream.run({ now: Date.now(), jobs: ['people'] })
  assert.equal(out.results[0].blocks, 1)
  const block = memory.query({ namespace: 'person', kind: 'block' })[0]
  assert.match(block.data.profile, /陈九/)
  assert.equal(block.data.provisional, true)
})

test('梗 job：term 做 key，重复出现时更新而不是新增', async () => {
  const { tools, memory, dream } = await setup({
    script: [['新梗', JSON.stringify([{ term: '难绷', meaning: '绷不住了', usage: '看到离谱的事', examples: ['难绷'] }])]],
  })
  await tools.remember.execute({ text: '今天有人一直说难绷', kind: 'slang' })
  await dream.run({ now: Date.now(), jobs: ['slang'] })
  assert.equal(memory.query({ namespace: 'slang', kind: 'block' }).length, 1)
})

test('做梦的提示词带独立人格（不是主会话的卡）', async () => {
  const { tools, dream, chat } = await setup({ script: [['事件块', '[]']] })
  await tools.remember.execute({ text: '随便一件事', kind: 'event' })
  await dream.run({ now: Date.now(), jobs: ['events'] })
  const system = String(chat.calls.at(-1)?.[0]?.content ?? '')
  assert.match(system, /记忆沉淀器/, '应该注入 dream 自己的人格')
})

test('事件块可以只输出纯文本 JSON（带 ``` 包裹也能解析）', async () => {
  const { tools, memory, dream } = await setup({
    script: [['事件块', '```json\n[{"summary":"包裹也能解析","body":"正文"}]\n```']],
  })
  await tools.remember.execute({ text: '包裹测试', kind: 'event' })
  await dream.run({ now: Date.now(), jobs: ['events'] })
  assert.equal(memory.query({ namespace: 'event', kind: 'block' })[0].text, '包裹也能解析')
})
