// P3：focus 积压是 queued ≠ delivered。focus 拦下时不能记 delivered；释放后 focus 重放回执
// 才补 delivered（noteDeliveredSeqs），attended 仍为 0；正常 delivered 路径不变。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../src/index.mjs'
import * as qqModule from '../../plugins/qq/src/index.mjs'
import manifest from '../../plugins/qq/manifest.json' with { type: 'json' }
import { createFakeOneBot } from '../../plugins/qq/tools/fake-onebot.mjs'

const TOKEN = 'focus-queued-token'
const OWNER = '10001'
const SELF = '2593621742'

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }
async function waitFor(predicate, { timeoutMs = 5000, stepMs = 20 } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await sleep(stepMs)
  }
  return predicate()
}

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-focus-'))
  const fake = await createFakeOneBot({ port: 0, token: TOKEN })
  const host = createHost({ log: () => {} })
  host.registerPlugin(manifest, qqModule, {
    config: {
      enabled: true, url: `ws://127.0.0.1:${fake.port}/`, token: TOKEN, selfId: SELF,
      allowPrivate: [OWNER], ownerQQ: OWNER,
      ledgerFile: path.join(dir, 'ledger.db'), mediaInboxDir: path.join(dir, 'media'),
      wakeEnabled: false,
    },
  })
  await host.enable('qq')
  const qq = host.shared.get('qq')
  await waitFor(() => qq.status().connection.connected === true)
  return {
    dir, fake, host, qq,
    tool: (name) => host.services.tools.list().find((t) => t.name === name),
    cleanup: async () => {
      host.disable('qq')
      await fake.close()
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch { /* Windows lock */ }
    },
  }
}

test('focus 拦下：queued ≠ delivered；显式 ack 可以收尾（跨过未交付），不假装已交付', async () => {
  const env = await setup()
  try {
    const lease = env.host.services.focus.enter({ label: 'qq:test', interruptible: false })
    try {
      env.fake.privateMessage({ from: OWNER, name: '主人', text: 'focus 拦下的消息', messageId: 9801 })
      await waitFor(() => env.qq.status().ledger.messages >= 1)
      await sleep(80)

      const status = env.qq.status()
      assert.ok((status.stats.queued ?? 0) >= 1, 'focus 积压应记 queued')
      assert.equal(status.stats.delivered, 0, 'queued 不能记 delivered')
      const wm = status.ledger.watermarks.find((w) => w.peer === OWNER)
      assert.equal(wm.deliveredSeq, 0)
      assert.equal(wm.attendedSeq, 0)
      assert.equal(wm.seenSeq, 0)
      const unread = await env.tool('qq_unread').execute({ peer: OWNER })
      assert.match(unread.text, /已看 #0，已交付 #0/)
      assert.match(unread.text, /\[未交付/)
      assert.equal(env.host.services.focus.backlog().reduce((n, row) => n + row.count, 0), 1)
      const read = await env.tool('qq_mark_read').execute({ peer: OWNER, throughSeq: 1 })
      assert.match(read.text, /已看 #1/)
      assert.match(read.text, /剩余未读 0 条/)
      const acked = env.qq.status().ledger.watermarks.find((w) => w.peer === OWNER)
      assert.equal(acked.seenSeq, 1, 'ack 推进"看过"水位')
      assert.equal(acked.deliveredSeq, 0, 'ack 不代表进过投递队列')
      assert.equal(env.host.services.focus.backlog().reduce((n, row) => n + row.count, 0), 0, 'ack 应清掉 focus backlog')
      assert.equal(env.host.services.delivery.drain('session').length, 0, 'ack 不发消息')
    } finally {
      lease.release()
    }
    // 已经 ack 过的消息不再需要重放回执；delivered 保持 0（省一次投递/打断）。
    await sleep(120)
    assert.equal(env.qq.status().ledger.watermarks.find((w) => w.peer === OWNER).deliveredSeq, 0)
  } finally { await env.cleanup() }
})

test('正常路径：offer delivered:true 仍立即记 delivered（不回归）', async () => {
  const env = await setup()
  try {
    env.fake.privateMessage({ from: OWNER, name: '主人', text: '正常投递', messageId: 9802 })
    const ok = await waitFor(() => {
      const wm = env.qq.status().ledger.watermarks.find((w) => w.peer === OWNER)
      return wm && wm.deliveredSeq === 1
    })
    assert.equal(ok, true)
    const status = env.qq.status()
    assert.equal(status.stats.delivered >= 1, true)
    assert.equal(status.stats.queued ?? 0, 0)
    assert.equal(status.ledger.watermarks.find((w) => w.peer === OWNER).attendedSeq, 0)
  } finally { await env.cleanup() }
})
