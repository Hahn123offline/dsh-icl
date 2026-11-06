// 记忆质量可观测修复（E2）：dream 失败/跳过落账、index 无嵌入明确 skip、boot 槽健康日志。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../src/index.mjs'
import { createIclPlugin } from '../../dsh-icl/src/plugin.mjs'
import * as memory from '../../plugins/memory/src/index.mjs'
import * as recall from '../../plugins/recall/src/index.mjs'
import * as dream from '../../plugins/dream/src/index.mjs'
import memoryManifest from '../../plugins/memory/manifest.json' with { type: 'json' }
import recallManifest from '../../plugins/recall/manifest.json' with { type: 'json' }
import dreamManifest from '../../plugins/dream/manifest.json' with { type: 'json' }

async function setup({ bindChat = false } = {}) {
  const host = createHost({ log: () => {} })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-dream-obs-'))
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 's1' } })
  host.registerPlugin(dreamManifest, dream, { config: { sessionId: 's1', timezone: 'Asia/Hong_Kong', persona: 'p' } })
  await host.enable('memory')
  await host.enable('recall')
  await host.enable('dream')
  if (bindChat) host.services.slots.bind('dream-chat', { provider: 'fake', call: async () => '[]' })
  return { host, root, memory: host.shared.get('memory'), dream: host.shared.get('dream') }
}

const dreamRows = (mem) => mem.query({ namespace: 'dream-run', kind: 'run', limit: 50 })

test('dream 失败：落 fail:<day>:<job> 行（ok:false + error），不再只在日志里', async () => {
  const { memory, dream } = await setup({ bindChat: false })
  memory.put({ namespace: 'event', kind: 'note', key: 'n1', text: '今天在河边看到白鹭。', data: { consolidated: false } })
  const out = await dream.run({ now: Date.now(), jobs: ['events'] })
  assert.equal(out.results[0].ok, false)
  const row = dreamRows(memory).find((r) => r.key.startsWith('fail:') && r.key.endsWith(':events'))
  assert.ok(row, `应写失败行，实际：${dreamRows(memory).map((r) => r.key).join(',')}`)
  assert.equal(row.data.ok, false)
  assert.match(String(row.data.error), /插槽 dream-chat/)
})

test('dream 成功不写 fail 行（成功仍只写 run: 行）', async () => {
  const { memory, dream } = await setup({ bindChat: true })
  memory.put({ namespace: 'event', kind: 'note', key: 'n1', text: '今天在河边看到白鹭。', data: { consolidated: false } })
  const out = await dream.run({ now: Date.now(), jobs: ['events'] })
  assert.equal(out.results[0].ok, true)
  assert.equal(dreamRows(memory).filter((r) => r.key.startsWith('fail:')).length, 0)
  assert.ok(dreamRows(memory).some((r) => r.key.startsWith('run:') && r.key.endsWith(':events')))
})

test('index 无嵌入：返回 skipped:no-embed（不再 ok:true/indexed:0），并落 skip 行', async () => {
  const { memory, dream } = await setup()
  memory.put({ namespace: 'event', kind: 'note', key: 'n1', text: '一条没向量的记忆。' })
  const out = await dream.run({ now: Date.now(), jobs: ['index'] })
  assert.equal(out.results[0].ok !== false, true)
  assert.equal(out.results[0].skipped, 'no-embed')
  assert.equal(out.results[0].missing, 1)
  const row = dreamRows(memory).find((r) => r.key.startsWith('skip:') && r.key.endsWith(':index'))
  assert.ok(row, `应写 skip 行，实际：${dreamRows(memory).map((r) => r.key).join(',')}`)
  assert.equal(row.data.skipped, 'no-embed')
  assert.equal(row.data.missing, 1)
})

test('boot：providers 为空时 icl.slots-unmatched 记为 error，icl.ready 带 slots.unmatched', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-slots-'))
  const logs = []
  const handlers = new Map()
  const ctx = {
    on: (event, fn) => { handlers.set(event, [...(handlers.get(event) ?? []), fn]); return () => {} },
    logger: () => ({ info: (text) => logs.push({ level: 'info', text }), warn: (text) => logs.push({ level: 'warn', text }), error: (text) => logs.push({ level: 'error', text }), debug: () => {} }),
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {}, context: () => () => {} },
  }
  const plugin = createIclPlugin({ ctx, config: { stateDir: dir, providers: [], plugins: ['memory', 'dream'] } })
  const fire = (event, ...args) => { for (const fn of handlers.get(event) ?? []) fn(...args) }
  const session = { id: 's1', header: { id: 's1', agentPreset: 'icl', cwd: 'C:/tmp' }, deriveMessages: () => [] }
  fire('session/created', session)
  const agent = { id: 'a1', session, ctx: { systemPrompt: { section: () => () => {} } } }
  await Promise.all((handlers.get('agent/created') ?? []).map((fn) => fn({ agent })))
  plugin.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
  const unmatched = logs.find((row) => row.level === 'error' && row.text.includes('icl.slots-unmatched'))
  assert.ok(unmatched, `应有 icl.slots-unmatched 错误日志，实际：${logs.map((row) => row.text.slice(0, 60)).join(' | ')}`)
  assert.match(unmatched.text, /dream-chat/)
  const ready = logs.find((row) => row.text.includes('icl.ready'))
  assert.ok(ready && /"slots":\{"unmatched":\[[^\]]*dream-chat/.test(ready.text), `icl.ready 应带 slots.unmatched：${ready?.text?.slice(0, 300)}`)
})
