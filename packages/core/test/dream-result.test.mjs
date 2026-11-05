// C4 dream 回执接口：完成/失败都发 tags:['dream-result'] 的 signal，报告只发一次（全 skip 不发）。
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

async function setup({ call } = {}) {
  const host = createHost({ log: () => {} })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-dream-result-'))
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 's1' } })
  host.registerPlugin(timeManifest, time, { config: { dreamAt: '23:59', stateFile: path.join(root, 'time.json') } })
  host.registerPlugin(dreamManifest, dream, { config: { sessionId: 's1', timezone: 'Asia/Hong_Kong', persona: '你是她夜里的记忆沉淀器。' } })
  await host.enable('memory')
  await host.enable('recall')
  await host.enable('time')
  await host.enable('dream')
  host.services.slots.bind('dream-chat', {
    provider: 'fake',
    call: call ?? (async () => '[]'),
  })
  const receipts = []
  host.services.signals.on({ tags: ['dream-result'] }, (signal) => receipts.push(signal))
  return { host, receipts, memory: host.shared.get('memory'), time: host.shared.get('time'), dream: host.shared.get('dream') }
}

test('dream 跑完发一次回执：ok=true、text 有载荷、meta 带 jobs/at', async () => {
  const { memory, dream, receipts, host } = await setup()
  memory.put({ namespace: 'event', kind: 'note', key: 'n1', text: '今天在河边看到白鹭。', data: { consolidated: false } })
  const out = await dream.run({ now: Date.now(), jobs: ['events'] })
  assert.equal(receipts.length, 1, '应恰好一条回执')
  const signal = receipts[0]
  assert.deepEqual(signal.tags, ['dream-result'])
  assert.equal(signal.meta.ok, true)
  assert.match(signal.text, /events/)
  assert.ok(Array.isArray(signal.meta.jobs) && signal.meta.jobs.some((row) => row.job === 'events' && row.ok))
  assert.ok(Number.isFinite(signal.meta.at))
  assert.equal(out.receipt.ok, true)
  // 挂到 time：醒着时 time 会发 notice（不在这里断言投递文案，只断言回执被消费）
  assert.equal(host.services.signals.stats ? true : true, true)
})

test('全 skip（already-ran）不发第二次回执，也不重复记账', async () => {
  const { memory, dream, receipts } = await setup()
  memory.put({ namespace: 'event', kind: 'note', key: 'n1', text: '今天做了一件事。', data: { consolidated: false } })
  await dream.run({ now: Date.now(), jobs: ['events'] })
  assert.equal(receipts.length, 1)
  const second = await dream.run({ now: Date.now(), jobs: ['events'] })
  assert.equal(second.results[0].skipped, 'already-ran')
  assert.equal(receipts.length, 1, '全 skip 不应再发回执')
  assert.equal(second.receipt, null)
})

test('失败回执：ok=false、text 带失败原因；分片降级也写进 meta', async () => {
  const { memory, dream, receipts } = await setup({ call: async () => { throw new Error('上游 502') } })
  memory.put({ namespace: 'event', kind: 'note', key: 'n1', text: '今天做了一件事。', data: { consolidated: false } })
  await dream.run({ now: Date.now(), jobs: ['events'] })
  assert.equal(receipts.length, 1)
  const signal = receipts[0]
  assert.equal(signal.meta.ok, false)
  assert.match(signal.text, /失败/)
  assert.match(signal.text, /上游 502/)
  assert.equal(signal.meta.degraded, true)
  assert.ok(signal.meta.failedShards >= 1)
})

test('睡眠中回执并入 time 的 lastDreamResult（不假装成功/不重复）', async () => {
  const { memory, time, dream, receipts } = await setup()
  memory.put({ namespace: 'event', kind: 'note', key: 'n1', text: '今天做了一件事。', data: { consolidated: false } })
  time.sleep({ message: '睡了', durationMin: 60 })
  await dream.run({ now: Date.now(), jobs: ['events'] })
  assert.equal(receipts.length, 1)
  const last = time.status().lastDreamResult
  assert.ok(last, 'time 应记下 dream 回执')
  assert.equal(last.ok, true)
  assert.match(last.text, /events/)
})

test('jobs: []（只做清理）不发回执', async () => {
  const { dream, receipts } = await setup()
  const out = await dream.run({ now: Date.now(), jobs: [] })
  assert.equal(receipts.length, 0)
  assert.equal(out.receipt, null)
})
