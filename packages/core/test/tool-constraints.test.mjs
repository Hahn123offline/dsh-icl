// 工具约束的装配：结构化字段 + 可选长描述 → 最终 description；外加工具索引。

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHost, createSessionAdapter } from '../src/index.mjs'
import { composeToolDescription, TOOL_TEXT_LIMITS } from '../src/services.mjs'
import * as world from '../../plugins/world-state/src/index.mjs'
import * as memory from '../../plugins/memory/src/index.mjs'
import * as recall from '../../plugins/recall/src/index.mjs'
import * as whois from '../../plugins/whois/src/index.mjs'
import worldManifest from '../../plugins/world-state/manifest.json' with { type: 'json' }
import memoryManifest from '../../plugins/memory/manifest.json' with { type: 'json' }
import recallManifest from '../../plugins/recall/manifest.json' with { type: 'json' }
import whoisManifest from '../../plugins/whois/manifest.json' with { type: 'json' }
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

test('结构化字段被拼进最终描述', () => {
  const text = composeToolDescription({
    summary: 'Look up a person.',
    when: ['someone mentions them', 'you need their account ids'],
    avoid: ['when you only want an event'],
    safety: [],
  })
  assert.match(text, /^Look up a person\./)
  assert.match(text, /Use when: someone mentions them; you need their account ids\./)
  assert.match(text, /Avoid when: when you only want an event\./)
  assert.doesNotMatch(text, /Safety/)
})

test('可选长描述优先于 summary，但仍受预算约束', () => {
  const long = 'This is a deliberately long hand-written description. '.repeat(40)
  const text = composeToolDescription({ description: long, summary: 'short', when: ['always'] }, { maxChars: 300 })
  assert.ok(text.length <= 300, `实际 ${text.length}`)
  assert.ok(text.startsWith('short This is a deliberately long'), '先用途，再细节')
})

test('超预算先砍要求行，再截正文，不出空串', () => {
  const text = composeToolDescription({
    summary: 'S'.repeat(200),
    when: ['W'.repeat(200)],
    avoid: ['A'.repeat(200)],
  }, { maxChars: 120 })
  assert.ok(text.length <= 120)
  assert.ok(text.length > 0)
})

test('工具索引只列启用中的工具，随卸载更新', async () => {
  const host = createHost({ log: () => {} })
  const session = createSessionAdapter({ sessionId: 's1', host, push: async () => {} })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-tools-'))
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 's1' } })
  host.registerPlugin(whoisManifest, whois, {})
  host.registerPlugin(worldManifest, world, {})
  await host.enable('memory')
  await host.enable('recall')
  await host.enable('whois')
  await host.enable('world-state')
  const prompt = session.systemPrompt()
  assert.match(prompt, /现在开着的工具/)
  for (const name of ['remember', 'recall', 'whois', 'world_status']) assert.match(prompt, new RegExp(`- ${name}:`))
  host.disable('world-state')
  assert.doesNotMatch(session.systemPrompt(), /- world_status:/)
  assert.match(session.systemPrompt(), /- whois:/, '别的工具还在')
})

test('索引有预算，工具很多时截断并说明', async () => {
  const host = createHost({ log: () => {} })
  const session = createSessionAdapter({ sessionId: 's1', host, push: async () => {} })
  for (let i = 0; i < 60; i++) {
    host.services.tools.register({ name: `tool_${i}`, summary: 'x'.repeat(40), parameters: {}, execute: async () => ({}) })
  }
  const index = session.toolDefinitions() && host.services.tools.index({ maxChars: 400 })
  assert.ok(index.length <= 500)
  assert.match(index, /还有 \d+ 个工具/)
})

test('whois 用结构化字段注册，最终描述同时含用途与边界', async () => {
  const host = createHost({ log: () => {} })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-whois2-'))
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(whoisManifest, whois, {})
  await host.enable('memory')
  await host.enable('whois')
  const def = host.services.tools.list().find((t) => t.name === 'whois')
  assert.match(def.description, /Look up a person/)
  assert.match(def.description, /Use when:/)
  assert.match(def.description, /Avoid when:/)
  assert.ok(def.description.length <= TOOL_TEXT_LIMITS.perTool)
})
