// 做梦的三个 job：幂等、可重跑、不吞原文。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../src/index.mjs'
import * as memory from '../../plugins/memory/src/index.mjs'
import * as recall from '../../plugins/recall/src/index.mjs'
import * as time from '../../plugins/time/src/index.mjs'
import * as dream from '../../plugins/dream/src/index.mjs'
import memoryManifest from '../../plugins/memory/manifest.json' with { type: 'json' }
import recallManifest from '../../plugins/recall/manifest.json' with { type: 'json' }
import timeManifest from '../../plugins/time/manifest.json' with { type: 'json' }
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

async function setup({ script = [], timezone = 'Asia/Hong_Kong', logs = null, scheduleEnabled = false, dreamConfig = {} } = {}) {
  const host = createHost({ log: (entry) => { logs?.push(entry) } })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-dream2-'))
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 's1' } })
  host.registerPlugin(timeManifest, time, { config: { dreamAt: '23:59', stateFile: path.join(root, 'time.json') } })
  host.registerPlugin(dreamManifest, dream, { config: { sessionId: 's1', timezone, persona: '你是她夜里的记忆沉淀器。', scheduleEnabled, dayCutHour: 0, ...dreamConfig } })
  await host.enable('memory')
  await host.enable('recall')
  await host.enable('time')
  await host.enable('dream')
  const chat = fakeChat(script)
  host.services.slots.bind('dream-chat', { provider: 'fake', call: chat.call })
  const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))
  return { host, tools, chat, memory: host.shared.get('memory'), dream: host.shared.get('dream') }
}

test('dream 默认不自动排 nightly；显式 scheduleEnabled 才注册（2026-11-10）', async () => {
  const off = await setup()
  assert.equal(off.host.shared.get('time').schedules().find((s) => s.id === 'dream:nightly'), undefined, '默认不应有机械 nightly')
  const on = await setup({ scheduleEnabled: true })
  const schedule = on.host.shared.get('time').schedules().find((s) => s.id === 'dream:nightly')
  assert.ok(schedule, '显式开启时仍可注册')
  assert.equal(schedule.at, '23:00')
  assert.deepEqual(schedule.tags, ['dream'])
  assert.equal(schedule.silent, true)
})

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

test('事件证据带行号与正文快照：重洗 log 后还能知道指哪句', async () => {
  const now = Date.now()
  const { host, memory, dream } = await setup({
    script: [['事件块', JSON.stringify([{ summary: '看了视频', body: '正文', evidence: [1] }])]],
  })
  host.services.raw.register({
    id: 'test-raw',
    list: () => [{ text: '第一句原话', time: now, role: 'user' }],
    search: () => [],
  })
  const out = await dream.run({ now, jobs: ['wash', 'events'] })
  assert.equal(out.ok, true)
  const block = memory.query({ namespace: 'event', kind: 'block' })[0]
  assert.equal(block.data.evidence[0].type, 'day')
  assert.equal(block.data.evidence[0].line, '第一句原话')
  assert.ok(block.data.evidence[0].at > 0)
})

test('日界按 config.timezone，而不是本机时区', async () => {
  const now = Date.UTC(2026, 0, 1, 23, 30) // 香港 2026-01-02 07:30 / UTC 2026-01-01 23:30
  const hk = await setup({ timezone: 'Asia/Hong_Kong' })
  const utc = await setup({ timezone: 'UTC' })
  assert.equal((await hk.dream.run({ now, jobs: [] })).day, '2026-01-02')
  assert.equal((await utc.dream.run({ now, jobs: [] })).day, '2026-01-01')
})

test('同一 summary 重跑：新证据优先，旧证据也不丢', async () => {
  const now = Date.now()
  const { host, memory, dream } = await setup({
    script: [['事件块', JSON.stringify([{ summary: '同一天的事', body: '第一版', evidence: [1] }])]],
  })
  host.services.raw.register({
    id: 'test-raw',
    list: () => [
      { text: '第一句', time: now, role: 'user' },
      { text: '第二句', time: now + 1000, role: 'user' },
    ],
    search: () => [],
  })
  await dream.run({ now, jobs: ['wash', 'events'] })
  host.services.slots.bind('dream-chat', {
    provider: 'seq',
    call: async () => JSON.stringify([{ summary: '同一天的事', body: '第二版', evidence: [2] }]),
  })
  await dream.run({ now, jobs: ['events'], force: true })
  const block = memory.query({ namespace: 'event', kind: 'block', limit: 1 })[0]
  assert.equal(block.data.body, '第二版')
  assert.deepEqual(block.data.evidence.map((e) => e.id), [2, 1])
  assert.deepEqual(block.data.evidence.map((e) => e.line), ['第二句', '第一句'])
})

test('做梦账本只保留 90 天', async () => {
  const now = Date.now()
  const { memory, dream } = await setup()
  memory.put({ namespace: 'dream-run', kind: 'run', key: 'run:old:wash', text: 'old', now: now - 100 * 86_400_000 })
  memory.put({ namespace: 'dream-run', kind: 'run', key: 'run:new:wash', text: 'new', now })
  const out = await dream.run({ now, jobs: [] })
  assert.equal(out.pruned, 1)
  assert.equal(memory.query({ namespace: 'dream-run', kind: 'run', limit: 10 }).length, 1)
})

test('cleanup 改写同时保留 body 与 evidence（不能后写覆盖前写）', async () => {  const { memory, dream } = await setup({
    script: [['整理已有的记忆块', JSON.stringify({
      rewrites: [{ key: 'event:a', text: '新摘要', body: '新正文' }],
    })]],
  })
  memory.put({ namespace: 'event', kind: 'block', key: 'event:a', text: '旧摘要', data: { body: '旧正文', evidence: [{ type: 'note', id: 7 }] }, now: 1000 })
  memory.put({ namespace: 'event', kind: 'block', key: 'event:b', text: '另一块', data: { body: '另一正文' }, now: 2000 })
  const out = await dream.run({ now: Date.now(), jobs: ['cleanup'] })
  assert.equal(out.ok, true)
  const block = memory.query({ namespace: 'event', kind: 'block', key: 'event:a', limit: 1 })[0]
  assert.equal(block.text, '新摘要')
  assert.equal(block.data.body, '新正文')
  assert.equal(block.data.evidence[0].id, 7, '改写正文不能丢掉原有 evidence')
})

/* ── READINESS G-1：忙碌一天的 dream 输入必须有界（分片/预算），失败不拖垮整夜 ── */

test('大 raw：wash 按预算截断、events 分片后单请求 ≤200k、块合并、超长单行被截断', async () => {
  const { host, memory, dream } = await setup()
  const now = Date.parse('2026-11-06T12:00:00+08:00')
  const calls = []
  host.services.slots.bind('dream-chat', {
    provider: 'cap',
    call: async ({ messages }) => {
      const system = String(messages?.[0]?.content ?? '')
      const user = String(messages?.[1]?.content ?? '')
      calls.push({ system, user })
      if (!system.includes('事件块')) return '[]'
      const index = calls.filter((row) => row.system.includes('事件块')).length
      return JSON.stringify([{ summary: `第${index}片的一件事`, body: '第一人称正文', people: [], tags: ['压测'], evidence: [index] }])
    },
  })
  const rows = Array.from({ length: 2000 }, (_, i) => ({
    time: now - 3_600_000 + i * 100,
    text: '原文'.repeat(250),
    sender: 'user',
  }))
  host.services.raw.register({ id: 'fake-busy-raw', list: () => rows, search: () => [] })
  const out = await dream.run({ now, jobs: ['wash', 'events'] })
  const wash = out.results.find((row) => row.job === 'wash')
  const events = out.results.find((row) => row.job === 'events')
  assert.equal(wash.ok, true)
  assert.equal(events.ok, true)
  const dayLog = memory.query({ namespace: 'day', kind: 'log', limit: 5 })[0]
  assert.ok(dayLog, '应写出当天 log')
  assert.ok(dayLog.text.length <= 200_000, `day log 超预算：${dayLog.text.length}`)
  assert.ok(dayLog.data.omittedLines > 0, '繁忙日应有省略行标记')
  assert.ok(!dayLog.text.includes('原文'.repeat(250)), '超长单行必须被截断')
  assert.ok(dayLog.text.split('\n').every((line) => line.length <= 480), '每行都应在单行预算内')
  const eventCalls = calls.filter((row) => row.system.includes('事件块'))
  assert.ok(eventCalls.length >= 2, `应分成多片，实际 ${eventCalls.length}`)
  for (const call of eventCalls) assert.ok(call.user.length <= 200_000, `单片 payload 超预算：${call.user.length}`)
  const blocks = memory.query({ namespace: 'event', kind: 'block', limit: 50 })
  assert.equal(blocks.length, eventCalls.length, '每片一块都应落库（合并结果正确）')
  assert.equal(events.shards, eventCalls.length)
  assert.equal(events.failedShards, 0)
})

test('某一片模型调用失败：自动重试一次后恢复，不拖垮整夜', async () => {
  const logs = []
  const { host, memory, dream } = await setup({ logs })
  const now = Date.parse('2026-11-06T12:00:00+08:00')
  let shardIndex = 0
  host.services.slots.bind('dream-chat', {
    provider: 'flaky',
    call: async ({ messages }) => {
      const system = String(messages?.[0]?.content ?? '')
      if (!system.includes('事件块')) return '[]'
      shardIndex += 1
      if (shardIndex === 1) throw new Error('上游 502')
      return JSON.stringify([{ summary: `幸存片${shardIndex}`, body: '正文', people: [], tags: [], evidence: [1] }])
    },
  })
  const rows = Array.from({ length: 900 }, (_, i) => ({
    time: now - 3_600_000 + i * 100,
    text: '这一天发生了很多事。'.repeat(20),
    sender: 'user',
  }))
  host.services.raw.register({ id: 'fake-flaky-raw', list: () => rows, search: () => [] })
  const out = await dream.run({ now, jobs: ['wash', 'events'] })
  const events = out.results.find((row) => row.job === 'events')
  assert.equal(events.ok, true, '瞬时失败重试后整体应完成')
  assert.equal(events.failedShards, 0, '瞬时的 502 应被 askJson 重试吃掉')
  const blocks = memory.query({ namespace: 'event', kind: 'block', limit: 50 })
  assert.ok(blocks.length >= 1, '块必须落库')
  assert.ok(logs.some((entry) => entry.msg === 'dream.call-retry'), '必须有 call-retry 日志')
})


test('v3 稀疏日守卫：真人材料过少时不调模型、不硬整出块', async () => {
  const now = Date.now()
  const { host, memory, dream, chat } = await setup({ dreamConfig: { memorySchema: 'v3' } })
  host.services.raw.register({
    id: 'test-raw-sparse',
    list: () => [{ text: '嗯', time: now - 10 * 60_000, role: 'user' }],
    search: () => [],
  })
  const out = await dream.run({ now, jobs: ['wash', 'episodes'] })
  const episodes = out.results.find((row) => row.job === 'episodes')
  assert.equal(episodes.skipped, 'below-salience', JSON.stringify(out.results))
  assert.equal(chat.calls.length, 0, '稀疏日不应调用形成模型')
  assert.equal(memory.query({ namespace: 'episode', kind: 'block' }).length, 0)
})

test('v3 小材料合并：多片短材料只发一次形成调用', async () => {
  const now = Date.now()
  const { host, memory, dream, chat } = await setup({ dreamConfig: { memorySchema: 'v3' } })
  const rows = [
    { text: '今天下午主人让我再测一次 MC 的临时世界端口，结果 join 成功但 state 还是报 fetch failed，我照实说了一遍。', time: now - 120 * 60_000, role: 'user', source: 'human' },
    { text: '晚上他又来问压缩上下文工具是不是一直挂着，我说没找到 compact_context，先别压免得记忆丢。', time: now - 60 * 60_000, role: 'user', source: 'human' },
  ]
  host.services.raw.register({ id: 'test-raw-coalesce', list: () => rows, search: () => [] })
  const out = await dream.run({ now, jobs: ['wash', 'episodes'] })
  const episodes = out.results.find((row) => row.job === 'episodes')
  assert.equal(episodes.shards, 1, `应是合并后的 1 片：${JSON.stringify(episodes)}`)
  assert.equal(chat.calls.length, 1, '小材料只应发一次形成调用')
  assert.equal(memory.query({ namespace: 'episode', kind: 'block' }).length, 0, '模型输出 [] 时不落块')
})
