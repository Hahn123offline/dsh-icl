// 压缩：旧实现挂到新契约上（onCompact + onAssemble）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../src/index.mjs'
import * as memory from '../../plugins/memory/src/index.mjs'
import * as compaction from '../../plugins/compaction/src/index.mjs'
import memoryManifest from '../../plugins/memory/manifest.json' with { type: 'json' }
import compactionManifest from '../../plugins/compaction/manifest.json' with { type: 'json' }

async function setup() {
  const host = createHost({ log: () => {} })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-compact-'))
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(compactionManifest, compaction, { config: { keepRecent: 2, persona: '你是小千。', triggerChars: 2500 } })
  await host.enable('memory')
  await host.enable('compaction')
  host.services.slots.bind('compact-chat', { provider: 'fake', call: async ({ messages }) => '早前在讨论记忆系统，决定先做证据链。' })
  return { host, memory: host.shared.get('memory') }
}

test('压缩：只压较早的部分，摘要存下来并注入上下文', async () => {
  const { host } = await setup()
  const history = [
    { role: 'user', text: '我想做一个记忆系统' },
    { role: 'assistant', text: '先做证据链吧' },
    { role: 'user', text: '好' },
    { role: 'assistant', text: '那我开始' },
  ]
  const out = await host.services.context.compact({ history })
  assert.equal(out.ok, true)
  assert.equal(out.dropped, 2, '保留最近 2 条')
  const injected = await host.services.context.assemble({ message: '继续' })
  assert.match(injected, /压缩摘要/)
  assert.match(injected, /记忆系统/)
})

test('压缩：历史很短时不动', async () => {
  const { host } = await setup()
  const out = await host.services.context.compact({ history: [{ role: 'user', text: '一句' }] })
  assert.equal(out.ok, true)
  assert.equal(out.dropped, 0)
})

test('压缩：模型给空时不写摘要，明确失败', async () => {
  const { host } = await setup()
  host.services.slots.bind('compact-chat', { provider: 'empty', call: async () => '' })
  const out = await host.services.context.compact({ history: Array.from({ length: 6 }, (_, i) => ({ role: 'user', text: 'x' + i })) })
  assert.equal(out.ok, false)
  assert.equal(out.error, 'empty-summary')
})


test('压缩摘要用同一个人格写自己的回忆', async () => {
  const { host } = await setup()
  let system = ''
  host.services.slots.bind('compact-chat', {
    provider: 'capture',
    call: async ({ messages }) => { system = String(messages?.[0]?.content ?? ''); return '我后来把记忆系统做成了块。' },
  })
  await host.services.context.compact({ history: [
    { role: 'user', text: 'a' }, { role: 'assistant', text: 'b' },
    { role: 'user', text: 'c' }, { role: 'assistant', text: 'd' },
  ] })
  assert.match(system, /你是小千/)
  assert.match(system, /你自己的口吻/)
})

test('超过阈值才自动压缩', async () => {
  const { host } = await setup()
  const short = await host.shared.get('compaction').maybe({ history: [{ role: 'user', text: '短' }] })
  assert.equal(short.skipped, 'under-threshold')
  const long = await host.shared.get('compaction').maybe({ history: Array.from({ length: 6 }, (_, i) => ({ role: 'user', text: 'x'.repeat(600) + i })) })
  assert.equal(long.ok, true)
  assert.ok(long.dropped > 0)
})
