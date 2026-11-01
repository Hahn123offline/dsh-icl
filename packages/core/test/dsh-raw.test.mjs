// DSH 会话日志作为原文来源：不建库，按需扫。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../src/index.mjs'
import * as memory from '../../plugins/memory/src/index.mjs'
import * as recall from '../../plugins/recall/src/index.mjs'
import * as dshRaw from '../../plugins/dsh-raw/src/index.mjs'
import memoryManifest from '../../plugins/memory/manifest.json' with { type: 'json' }
import recallManifest from '../../plugins/recall/manifest.json' with { type: 'json' }
import dshRawManifest from '../../plugins/dsh-raw/manifest.json' with { type: 'json' }

function writeSession(root, lines) {
  const dir = path.join(root, '--C-DSH-test--', 'session-test')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'))
}

async function setup() {
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-dshsess-'))
  writeSession(sessions, [
    { type: 'user/message', time: Date.now() - 1000, data: { content: [{ type: 'text', text: '往 C:\\DSH\\qwenstuff\\ 里写个测试文件' }] } },
    { type: 'assistant/message', time: Date.now() - 900, data: { content: [{ type: 'text', text: '好，我写了一个测试文件放在那里' }] } },
    { type: 'user/message', time: Date.now() - 800, data: { content: [{ type: 'text', text: 'Current runtime context. 不该被当成对话' }] } },
  ])
  const host = createHost({ log: () => {} })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-dshmem-'))
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 's1' } })
  host.registerPlugin(dshRawManifest, dshRaw, { config: { sessionsRoot: sessions } })
  await host.enable('memory')
  await host.enable('recall')
  await host.enable('dsh-raw')
  const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))
  return { host, tools }
}

test('DSH 日志能被注册成原文来源，并过滤掉注入的上下文', async () => {
  const { host } = await setup()
  const hits = await host.services.raw.search({ query: 'C:\\DSH\\qwenstuff\\ 测试文件', limit: 2 })
  assert.ok(hits.length >= 1)
  assert.match(hits[0].text, /qwenstuff/)
  assert.doesNotMatch(hits.map((h) => h.text).join('\n'), /Current runtime context/)
})

test('recall 在块没有细节时，从 DSH 日志补一句原文', async () => {
  const { tools, host } = await setup()
  const mem = host.shared.get('memory')
  mem.registerNamespace({ id: 'event', label: '事件', recallable: true })
  mem.put({ namespace: 'event', kind: 'block', key: 'evt:1', text: '那天写了测试文件，位置记不清了', data: {} })
  const out = await tools.recall.execute({ query: '往哪个路径写的测试文件？' })
  assert.match(out.text, /原文/)
  assert.match(out.text, /qwenstuff/)
})
