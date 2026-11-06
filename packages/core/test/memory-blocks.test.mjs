// 用户 2026-11-06 批准的记忆分块：day 分段 ≤40k、event block body ≤1200+parts、经历窗口切段、eager 计数。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../src/index.mjs'
import * as memory from '../../plugins/memory/src/index.mjs'
import * as recall from '../../plugins/recall/src/index.mjs'
import * as dream from '../../plugins/dream/src/index.mjs'
import * as eager from '../../plugins/eager-recall/src/index.mjs'
import memoryManifest from '../../plugins/memory/manifest.json' with { type: 'json' }
import recallManifest from '../../plugins/recall/manifest.json' with { type: 'json' }
import dreamManifest from '../../plugins/dream/manifest.json' with { type: 'json' }
import eagerManifest from '../../plugins/eager-recall/manifest.json' with { type: 'json' }

const NOON = Date.parse('2026-11-06T12:00:00+08:00')

async function dreamSetup({ dreamConfig = {}, calls = [] } = {}) {
  const host = createHost({ log: () => {} })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-memblocks-'))
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 's1' } })
  host.registerPlugin(dreamManifest, dream, { config: { sessionId: 's1', timezone: 'Asia/Hong_Kong', persona: 'p', ...dreamConfig } })
  await host.enable('memory')
  await host.enable('recall')
  await host.enable('dream')
  host.services.slots.bind('dream-chat', {
    provider: 'fake',
    call: async ({ messages }) => {
      const system = String(messages?.[0]?.content ?? '')
      calls.push(String(messages?.[1]?.content ?? ''))
      if (system.includes('事件块')) return JSON.stringify([{ summary: 'S'.repeat(150), body: 'B'.repeat(900), people: [], tags: [], evidence: [1] }])
      return '[]'
    },
  })
  return { host, root, memory: host.shared.get('memory'), dream: host.shared.get('dream'), calls }
}

const rawRows = (count, { start = NOON - 3_600_000, stepMs = 100, text = (i) => `第${i}行：` + '原话'.repeat(50) } = {}) =>
  Array.from({ length: count }, (_, i) => ({ time: start + i * stepMs, text: text(i), sender: 'user' }))

test('day log 分段：每段 ≤maxSegmentChars，行号仍连续、可拼回全文', async () => {
  const { host, memory, dream } = await dreamSetup({ dreamConfig: { maxSegmentChars: 3000 } })
  host.services.raw.register({ id: 'fake', list: () => rawRows(120), search: () => [] })
  const receipts = []
  host.services.signals.on({ tags: ['dream-result'] }, (signal) => receipts.push(signal))
  const out = await dream.run({ now: NOON, jobs: ['wash'] })
  assert.equal(out.results[0].ok, true)
  assert.ok(out.results[0].parts > 1, `应分成多段，实际 parts=${out.results[0].parts}`)
  // 用户拍板（首次 E2 实测后）：分段是正常设计，不算 degraded
  assert.equal(out.results[0].degraded, false, `分段不应标 degraded：${JSON.stringify(out.results[0])}`)
  assert.equal(out.results[0].segmented, out.results[0].parts)
  assert.equal(receipts.length, 1)
  assert.match(receipts[0].text, /分 \d+ 段/, `回执应写"分 N 段"：${receipts[0].text}`)
  assert.doesNotMatch(receipts[0].text, /分片降级/)
  const rows = memory.query({ namespace: 'day', kind: 'log', limit: 100 })
  assert.ok(rows.length > 1)
  for (const row of rows) assert.ok(String(row.text).length <= 3200, `单段超预算：${String(row.text).length}`)
  const joined = rows.sort((a, b) => String(a.key).localeCompare(String(b.key), 'en', { numeric: true })).map((r) => r.text).join('\n')
  for (const id of [1, 60, 120]) assert.ok(joined.includes(`[${id}]`), `缺行号 [${id}]`)
})

test('event block：摘要 ≤100、body ≤1200；超长 body 拆 parts 且 groupId 一致', async () => {
  const { host, memory, dream } = await dreamSetup({ dreamConfig: { maxBlockBody: 300, maxBlockSummary: 100, maxSegmentChars: 10_000 } })
  host.services.raw.register({ id: 'fake', list: () => rawRows(5), search: () => [] })
  await dream.run({ now: NOON, jobs: ['wash'] })
  const out = await dream.run({ now: NOON, jobs: ['events'] })
  assert.equal(out.results[0].ok, true)
  const blocks = memory.query({ namespace: 'event', kind: 'block', limit: 50 })
  assert.ok(blocks.length >= 3, `900 字应拆成多块，实际 ${blocks.length}`)
  const groups = new Set(blocks.map((b) => b.data?.parts?.groupId).filter(Boolean))
  assert.equal(groups.size, 1, '同一 summary 的 parts 应共享 groupId')
  const first = blocks.find((b) => !b.data?.parts)
  assert.ok(first, '应有一块不带 parts（首块）')
  assert.ok(String(first.text).length <= 100, `摘要超长：${String(first.text).length}`)
  for (const block of blocks) {
    assert.ok(String(block.data?.body ?? '').length <= 300, `body 超长：${String(block.data?.body).length}`)
    if (block.data?.parts) assert.match(String(block.text), /（\d+\/\d+）$/)
  }
  const total = blocks.filter((b) => b.data?.parts).length + 1
  assert.equal(blocks.find((b) => b.data?.parts)?.data.parts.total, total, 'parts.total 应等于实际块数')
})

test('经历窗口：相邻行时间间隔 >30min 会切成不同请求段', async () => {
  const calls = []
  const { host, dream } = await dreamSetup({ calls, dreamConfig: { segmentGapMin: 30, maxSegmentChars: 10_000 } })
  const rows = [
    { time: NOON - 3 * 3_600_000, text: '早上在河边看到白鹭。' + '细节'.repeat(30), sender: 'user' },
    { time: NOON - 3 * 3_600_000 + 60_000, text: '接着又看到一只。' + '细节'.repeat(30), sender: 'user' },
    { time: NOON - 2 * 3_600_000, text: '中午回家吃饭。' + '细节'.repeat(30), sender: 'user' },
    { time: NOON - 1 * 3_600_000, text: '下午去下矿了。' + '细节'.repeat(30), sender: 'user' },
  ]
  host.services.raw.register({ id: 'fake', list: () => rows, search: () => [] })
  await dream.run({ now: NOON, jobs: ['wash'] })
  await dream.run({ now: NOON, jobs: ['events'] })
  assert.ok(calls.length >= 3, `3 个经历段应至少 3 次请求，实际 ${calls.length}`)
})

test('eager-recall 计数：hits/injected/chars 写入 counterFile（含 0 注入）', async () => {
  const host = createHost({ log: () => {} })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-eager-count-'))
  const counterFile = path.join(root, 'eager-recall.jsonl')
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 's1' } })
  host.registerPlugin(eagerManifest, eager, { config: { minScore: 0.05, counterFile } })
  await host.enable('memory')
  await host.enable('recall')
  await host.enable('eager-recall')
  const mem = host.shared.get('memory')
  mem.put({ namespace: 'event', kind: 'block', key: 'evt:1', text: '他周末要去看海，但怕水', data: {} })
  await host.services.prompt.turnText({ message: '他说的看海是哪天来着' })
  await host.services.prompt.turnText({ message: '帮我算一下 1+1' })
  const lines = fs.readFileSync(counterFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  assert.ok(lines.length >= 2)
  const hit = lines.find((row) => row.injected > 0)
  assert.ok(hit && hit.hits >= 1 && hit.chars > 0, `命中行应带 counts：${JSON.stringify(lines)}`)
  const miss = lines.find((row) => row.injected === 0)
  assert.ok(miss && miss.hits >= 0, '未命中也要记一行（hits=0/injected=0）')
})


test('cleanup 近似重复合并：正文包含的两块并成一块（evidence 并集 + mergedFrom）', async () => {
  const { host, memory, dream } = await dreamSetup()
  const day = '2026-11-06'
  const ev = (id) => ({ type: 'day', id, at: NOON, line: `第 ${id} 行` })
  memory.put({ namespace: 'event', kind: 'block', key: 'evt:keep', text: '熔炉安置成功，工作台箱子和熔炉凑成小作坊', data: { day, body: '我收集了足够的石头，终于把熔炉造出来了，放在工作台和箱子旁边，算是个小作坊了。', evidence: [ev(1), ev(2)], from: NOON - 1000, to: NOON } })
  memory.put({ namespace: 'event', kind: 'block', key: 'evt:drop', text: '熔炉安置成功，凑成小作坊，但系统踢我下线', data: { day, body: '我收集了足够的石头，终于把熔炉造出来了，放在工作台和箱子旁边，算是个小作坊了。  另外今天被服务器踢了两次。', evidence: [ev(3)], from: NOON - 500, to: NOON + 500 } })
  memory.put({ namespace: 'event', kind: 'block', key: 'evt:other', text: '下矿挖到煤', data: { day, body: '我去矿洞挖煤，挖到了一些煤和铁矿。', evidence: [ev(4)] } })
  const out = await dream.run({ now: NOON, jobs: ['cleanup'] })
  assert.equal(out.results[0].ok, true)
  assert.equal(out.results[0].nearDuplicates, 1, JSON.stringify(out.results[0]))
  const blocks = memory.query({ namespace: 'event', kind: 'block', limit: 10 })
  const superseded = blocks.filter((row) => row.data?.superseded === true)
  const survivors = blocks.filter((row) => row.data?.superseded !== true)
  assert.equal(superseded.length, 1, `应只吞并一块：${JSON.stringify(blocks.map((b) => ({ key: b.key, sup: b.data?.superseded })))}`)
  const kept = survivors.find((row) => ['evt:keep', 'evt:drop'].includes(row.key))
  const dropped = superseded[0]
  assert.ok(kept && dropped, '存活的应是 keep/drop 之一')
  assert.equal(dropped.data?.supersededBy, kept.key)
  assert.ok((kept.data?.mergedFrom ?? []).includes(dropped.key))
  assert.ok((kept.data?.evidence ?? []).length >= 3, `evidence 应并集：${JSON.stringify(kept.data?.evidence)}`)
  assert.ok(survivors.some((row) => row.key === 'evt:other'), '无关块不能被合并')
})

test('evidence 去噪：重复"MC 身体：已连接"只留最近 1 条', async () => {
  const calls = []
  const { host, memory, dream } = await dreamSetup({ calls })
  const dayRows = [
    { time: NOON - 3 * 3_600_000, text: 'MC 身体：已连接 127.0.0.1:54838 玩家：A', sender: 'system' },
    { time: NOON - 3 * 3_600_000 + 1000, text: 'MC 身体：已连接 127.0.0.1:54838 玩家：B', sender: 'system' },
    { time: NOON - 3 * 3_600_000 + 2000, text: '你刚死了（第 1 次）', sender: 'system' },
    { time: NOON - 3 * 3_600_000 + 3000, text: 'MC 身体：已连接 127.0.0.1:54838 玩家：C', sender: 'system' },
  ]
  host.services.raw.register({ id: 'fake', list: () => dayRows, search: () => [] })
  await dream.run({ now: NOON, jobs: ['wash'] })
  // 覆盖 slot：返回一个引用全部 4 行的块
  host.services.slots.bind('dream-chat', { provider: 'fake2', call: async () => JSON.stringify([{ summary: '连接与死亡', body: '连接了几次，死了一次。', people: [], tags: [], evidence: [1, 2, 3, 4] }]) })
  await dream.run({ now: NOON, jobs: ['events'] })
  const block = memory.query({ namespace: 'event', kind: 'block', limit: 5 })[0]
  const lines = (block?.data?.evidence ?? []).map((entry) => String(entry.line ?? ''))
  assert.equal(lines.filter((line) => /已连接/.test(line)).length, 1, `连接行应只留 1 条：${JSON.stringify(lines)}`)
  assert.ok(lines.some((line) => /你刚死了/.test(line)), '死亡行应保留')
})

test('eager：同一记忆短时间不重复注入；截断在句子边界', async () => {
  const host = createHost({ log: () => {} })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-eager-cool-'))
  const counterFile = path.join(root, 'eager.jsonl')
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 's1' } })
  host.registerPlugin(eagerManifest, eager, { config: { minScore: 0.05, counterFile, cooldownMs: 60_000 } })
  await host.enable('memory')
  await host.enable('recall')
  await host.enable('eager-recall')
  const mem = host.shared.get('memory')
  mem.put({ namespace: 'event', kind: 'block', key: 'evt:long', text: '他周末要去看海，但怕水，所以说好只在岸边走，还要带上相机拍一些照片回来给我们看；另外他说如果天气好会叫上朋友一起，顺便在附近吃个饭再回来。', data: {} })
  const first = await host.services.prompt.turnText({ message: '他说的看海是哪天来着' })
  assert.match(first, /你可能记得/)
  for (const line of first.split('\n').slice(1)) {
    if (!line.trim()) continue
    assert.ok(line.length <= 82, `单条应 ≤82 字：${line}`)
    assert.match(line, /…$|[。！？；]$/, `截断应在句读/省略号上：${line}`)
  }
  const second = await host.services.prompt.turnText({ message: '他说的看海是哪天来着' })
  assert.equal(second, '', '冷却期内同一记忆不应重复注入')
  const rows = fs.readFileSync(counterFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  assert.ok(rows.some((row) => row.suppressed >= 1), `应有 suppressed 计数：${JSON.stringify(rows)}`)
})
