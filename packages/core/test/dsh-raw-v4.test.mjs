// DSH v4 会话日志：消息在 data.message 里，sessionId 在目录名里。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../src/index.mjs'
import * as raw from '../../plugins/dsh-raw/src/index.mjs'
import manifest from '../../plugins/dsh-raw/manifest.json' with { type: 'json' }

test('v4 日志能解析出消息，sessionId 取目录名', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-raw-v4-'))
  const dir = path.join(root, '--C-test--', 'session-abc123')
  fs.mkdirSync(dir, { recursive: true })
  const lines = [
    { type: 'session', id: 'session-abc123' },
    { type: 'user/message', time: Date.now(), data: { message: { role: 'user', content: [{ type: 'text', text: '你好，今天试一下' }] } } },
    { type: 'assistant/message', time: Date.now(), data: { message: { role: 'assistant', content: [{ type: 'text', text: '好，开始' }] } } },
  ].map((x) => JSON.stringify(x)).join('\n')
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl'), lines, 'utf8')

  const host = createHost({ log: () => {} })
  host.registerPlugin(manifest, raw, { config: { sessionsRoot: root, cacheMs: 1, days: 3 } })
  await host.enable('dsh-raw')
  const rows = await host.services.raw.list({ limit: 10 })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].text, '你好，今天试一下')
  assert.equal(rows[0].role, 'user')
  assert.equal(rows[0].sessionId, 'session-abc123')
})
