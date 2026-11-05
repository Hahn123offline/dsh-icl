// loop-probe：只给闭环用的文件邮箱信号注入器。默认不启用。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../src/index.mjs'
import * as loopProbe from '../../plugins/loop-probe/src/index.mjs'
import probeManifest from '../../plugins/loop-probe/manifest.json' with { type: 'json' }

test('loop-probe 从文件邮箱注入信号并写回执', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-loop-probe-'))
  const inbox = path.join(root, 'loop.inbox.jsonl')
  const outbox = path.join(root, 'loop.outbox.jsonl')
  const host = createHost({ log: () => {} })
  host.registerPlugin(probeManifest, loopProbe, { config: { inboxFile: inbox, outboxFile: outbox, tickMs: 100 } })
  await host.enable('loop-probe')
  fs.writeFileSync(inbox, `${JSON.stringify({ id: 's1', from: 'qq', kind: 'content', text: '别处消息', focus: 'qq:group:1' })}\n`, 'utf8')
  const out = host.shared.get('loop-probe').readInbox()
  assert.equal(out, 1)
  const receipt = JSON.parse(fs.readFileSync(outbox, 'utf8').trim())
  assert.equal(receipt.id, 's1')
  assert.equal(receipt.ok, true)
  assert.equal(receipt.result.accepted, true)
})

test('loop-probe reset 清空 delivery', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-loop-reset-'))
  const inbox = path.join(root, 'loop.inbox.jsonl')
  const outbox = path.join(root, 'loop.outbox.jsonl')
  const host = createHost({ log: () => {} })
  host.registerPlugin(probeManifest, loopProbe, { config: { inboxFile: inbox, outboxFile: outbox, tickMs: 100 } })
  await host.enable('loop-probe')
  host.services.delivery.push({ source: { plugin: 'time' }, content: { text: '旧消息' } })
  fs.writeFileSync(inbox, `${JSON.stringify({ id: 'r1', op: 'reset' })}\n`, 'utf8')
  assert.equal(host.shared.get('loop-probe').readInbox(), 1)
  assert.equal(host.services.delivery.pendingCount(), 0)
})
