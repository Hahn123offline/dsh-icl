// Phase 1 回归：并发单飞、显式 remember 不被吞、垃圾输出不当成功、跨人合并、凌晨 day 归属、rowId 证据。
// 对应 docs/MEMORY-CODE-AUDIT.md 的 P0 F1/F2/F3/F4 与 F7。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../src/index.mjs'
import * as memory from '../../plugins/memory/src/index.mjs'
import * as recall from '../../plugins/recall/src/index.mjs'
import * as dream from '../../plugins/dream/src/index.mjs'
import memoryManifest from '../../plugins/memory/manifest.json' with { type: 'json' }
import recallManifest from '../../plugins/recall/manifest.json' with { type: 'json' }
import dreamManifest from '../../plugins/dream/manifest.json' with { type: 'json' }

const NOON = Date.parse('2026-11-10T12:00:00+08:00')

async function setup({ call = null } = {}) {
  const host = createHost({ log: () => {} })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-mem-p0-'))
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 's1' } })
  host.registerPlugin(dreamManifest, dream, { config: { sessionId: 's1', timezone: 'Asia/Hong_Kong', persona: 'p' } })
  await host.enable('memory')
  await host.enable('recall')
  await host.enable('dream')
  host.services.slots.bind('dream-chat', {
    provider: 'fake',
    call: async (args) => (call ? call(args) : '[]'),
  })
  const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))
  return { host, root, memory: host.shared.get('memory'), dream: host.shared.get('dream'), tools }
}

const rawRows = (count = 3, now = NOON) => Array.from({ length: count }, (_, i) => ({
  id: `row-${i + 1}`,
  time: now - 3_600_000 + i * 60_000,
  text: `第 ${i + 1} 句原话：今天发生了一件小事。`,
  role: 'user',
  sourceKind: 'human',
}))

function bindRaw(host, rows) {
  host.services.raw.register({ id: 'fake-raw', list: () => rows, search: () => [] })
}

test('F1 并发：信号双触发只有一个 run 真正执行，第二个 skipped:in-flight', async () => {
  const { host, memory, dream } = await setup()
  bindRaw(host, rawRows(3))
  await dream.run({ now: NOON, jobs: ['wash'] })

  let release
  const gate = new Promise((resolve) => { release = resolve })
  host.services.slots.bind('dream-chat', {
    provider: 'slow',
    call: async () => {
      await gate
      return JSON.stringify([{ summary: '并发只写一次', body: '同时到达的两次触发只应落一块。', evidence: [1] }])
    },
  })
  const first = dream.run({ now: NOON, jobs: ['events'], trigger: 'signal' })
  const second = dream.run({ now: NOON + 15_000, jobs: ['events'], trigger: 'signal' })
  const secondResult = await second
  assert.equal(secondResult.skipped, 'in-flight')
  release()
  const firstResult = await first
  assert.equal(firstResult.ok, true)

  const blocks = memory.query({ namespace: 'event', kind: 'block', limit: 20 })
  assert.equal(blocks.length, 1, `并发不应写两块：${JSON.stringify(blocks.map((b) => b.text))}`)
  const ledger = memory.query({ namespace: 'dream-run', kind: 'run', key: 'run:2026-11-10:events', limit: 1 })[0]
  assert.equal(ledger?.data?.status, 'success')
  assert.equal(ledger?.data?.attempts?.length, 1, '只应有 1 次 attempt')
})

test('F2 显式 remember 不被 day log 吞：n<id> 证据可引用、未引用则保持待消化', async () => {
  const { host, memory, dream, tools } = await setup()
  bindRaw(host, rawRows(3))
  await dream.run({ now: NOON, jobs: ['wash'] })
  await tools.remember.execute({ text: '她主动记下：周末要去看海', kind: 'event' })
  const note = memory.query({ namespace: 'event', kind: 'note', limit: 5 })[0]
  assert.ok(note, 'remember 应写入 note')

  const payloads = []
  host.services.slots.bind('dream-chat', {
    provider: 'cite-note',
    call: async ({ messages }) => {
      const payload = String(messages?.[1]?.content ?? '')
      payloads.push(payload)
      // 只有拿到"她主动记下的笔记"那一片才成块；day 片返回 []（合法空）。
      if (!payload.includes(`n${note.id}｜`)) return '[]'
      return JSON.stringify([{ summary: '说好周末去看海', body: '他提到周末去看海，我记下了。', evidence: [`n${note.id}`] }])
    },
  })
  const out = await dream.run({ now: NOON, jobs: ['events'] })
  assert.equal(out.results[0].blocks, 1)
  const block = memory.query({ namespace: 'event', kind: 'block', limit: 5 })[0]
  const noteEvidence = (block.data?.evidence ?? []).filter((e) => e.type === 'note')
  assert.equal(noteEvidence.length, 1, 'note 证据应被保留为 note 类型')
  assert.equal(Number(noteEvidence[0].id), Number(note.id))
  assert.ok(payloads.some((text) => text.includes(`n${note.id}｜`)), '显式 note 应出现在事件材料里')
  const after = memory.query({ namespace: 'event', kind: 'note', id: note.id, limit: 1 })[0]
  assert.equal(after.data?.consolidated, true, '被引用的 note 应标已消化')
})

test('F2 未引用的 note 保持 unconsolidated（留给下一轮，不静默吞）', async () => {
  const { host, memory, dream, tools } = await setup()
  bindRaw(host, rawRows(3))
  await dream.run({ now: NOON, jobs: ['wash'] })
  await tools.remember.execute({ text: '一条模型没并进块的笔记', kind: 'event' })
  const note = memory.query({ namespace: 'event', kind: 'note', limit: 5 })[0]
  const out = await dream.run({ now: NOON, jobs: ['events'] })
  assert.equal(out.results[0].blocks, 0)
  assert.equal(out.results[0].deferred, 1)
  const after = memory.query({ namespace: 'event', kind: 'note', id: note.id, limit: 1 })[0]
  assert.equal(after.data?.consolidated, undefined)
})

test('F3 垃圾/空模型输出 = 失败可重试，不冒充成功、不标记 note', async () => {
  const { host, memory, dream, tools } = await setup()
  bindRaw(host, rawRows(3))
  await dream.run({ now: NOON, jobs: ['wash'] })
  await tools.remember.execute({ text: '不能被垃圾输出吞掉', kind: 'event' })
  const note = memory.query({ namespace: 'event', kind: 'note', limit: 5 })[0]
  host.services.slots.bind('dream-chat', { provider: 'garbage', call: async () => '抱歉，我无法完成。' })
  const failed = await dream.run({ now: NOON, jobs: ['events'] })
  assert.equal(failed.ok, false)
  assert.equal(failed.results[0].ok, false)
  const afterFailed = memory.query({ namespace: 'event', kind: 'note', id: note.id, limit: 1 })[0]
  assert.equal(afterFailed.data?.consolidated, undefined, '失败不能标记已消化')

  // 失败后同一天允许重试（租约不残留 running）
  let calls = 0
  host.services.slots.bind('dream-chat', {
    provider: 'ok',
    call: async () => {
      calls += 1
      return calls === 1 ? JSON.stringify([{ summary: '补上了', body: '这次成功。', evidence: [1] }]) : '[]'
    },
  })
  const retry = await dream.run({ now: NOON, jobs: ['events'] })
  assert.equal(retry.ok, true)
  assert.equal(retry.results[0].blocks, 1)
  const ledger = memory.query({ namespace: 'dream-run', kind: 'run', key: 'run:2026-11-10:events', limit: 1 })[0]
  assert.equal(ledger.data.status, 'success')
  assert.equal(ledger.data.attempts.length, 2, '两次 attempt 都要留痕')
  assert.equal(ledger.data.attempts[0].status, 'failed')
})

test('F4 不同人的 person 块不会被确定性去重合并', async () => {
  const { memory, dream } = await setup()
  const body = '目前知道的：他只在群里发过图。'
  memory.put({ namespace: 'person', kind: 'block', key: 'person:name:甲', text: body, data: { body, profile: body, ids: [{ kind: 'name', value: '甲' }] }, now: NOON })
  memory.put({ namespace: 'person', kind: 'block', key: 'person:name:乙', text: body, data: { body, profile: body, ids: [{ kind: 'name', value: '乙' }] }, now: NOON + 1000 })
  const out = await dream.run({ now: NOON, jobs: ['cleanup'] })
  assert.equal(out.results[0].ok, true)
  const blocks = memory.query({ namespace: 'person', kind: 'block', limit: 10 })
  assert.equal(blocks.length, 2)
  assert.ok(blocks.every((b) => b.data?.superseded !== true), '不同人不能互相 superseded')
})

test('F7 凌晨 02:09 触发的 dream 整理"刚结束的那天"，不是新的一天', async () => {
  const { host, memory, dream } = await setup()
  const early = Date.parse('2026-11-10T02:09:00+08:00')
  bindRaw(host, [
    { id: 'r1', time: Date.parse('2026-11-09T22:00:00+08:00'), text: '昨晚聊了看海', role: 'user', sourceKind: 'human' },
  ])
  const out = await dream.run({ now: early, jobs: ['wash'] })
  assert.equal(out.day, '2026-11-09', `凌晨应整理前一天，实际 ${out.day}`)
  const dayLog = memory.query({ namespace: 'day', kind: 'log', key: 'day:2026-11-09', limit: 1 })[0]
  assert.ok(dayLog, '应写入 11-09 的 day log')
  assert.ok(dayLog.text.includes('昨晚聊了看海'))
})

test('wash 把 raw 行 id 写进 day log（评测 provenance 用）', async () => {
  const { host, memory, dream } = await setup()
  bindRaw(host, rawRows(3))
  await dream.run({ now: NOON, jobs: ['wash'] })
  const dayLog = memory.query({ namespace: 'day', kind: 'log', key: 'day:2026-11-10', limit: 1 })[0]
  assert.deepEqual(dayLog.data.rowIds, ['row-1', 'row-2', 'row-3'])
  assert.deepEqual(dayLog.data.sources, ['human', 'human', 'human'])
})

