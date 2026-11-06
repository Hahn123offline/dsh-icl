// time.compactWake 接缝：QQ 唤醒模板 compact 时用短 preamble（快照不动）；只有真正进管道
// （accepted 且未 queued）才 wake.bump()；旧版 time 没有 wake 服务时安全降级为全量、不 bump。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../src/index.mjs'
import * as qqModule from '../../plugins/qq/src/index.mjs'
import manifest from '../../plugins/qq/manifest.json' with { type: 'json' }
import { createFakeOneBot } from '../../plugins/qq/tools/fake-onebot.mjs'

const TOKEN = 'compact-wake-token'
const OWNER = '10001'
const SELF = '2593621742'

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }
async function waitFor(predicate, { timeoutMs = 5000, stepMs = 15 } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await sleep(stepMs)
  }
  return predicate()
}

async function setup({ compact = true, withTime = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-compact-'))
  const fake = await createFakeOneBot({ port: 0, token: TOKEN })
  const host = createHost({ log: () => {} })
  host.registerPlugin(manifest, qqModule, {
    config: {
      enabled: true, url: `ws://127.0.0.1:${fake.port}/`, token: TOKEN, selfId: SELF,
      allowPrivate: [OWNER], ownerQQ: OWNER,
      ledgerFile: path.join(dir, 'ledger.db'), mediaInboxDir: path.join(dir, 'media'),
      nudgeSoftMs: 1000, nudgeCooldownMs: 1000, wakeTickMs: 250,
    },
  })
  await host.enable('qq')
  const qq = host.shared.get('qq')
  await waitFor(() => qq.status().connection.connected === true)
  let bumps = 0
  if (withTime) {
    host.shared.set('time', {
      wake: {
        count: () => bumps,
        enabled: () => true,
        shouldCompact: () => compact,
        mode: () => (compact ? 'compact' : 'full'),
        bump: () => { bumps += 1 },
        stats: () => ({ count: bumps }),
        config: () => ({}),
        reset: () => { bumps = 0 },
      },
    })
  }
  return {
    dir, fake, host, qq, bumps: () => bumps,
    drain: () => host.services.delivery.drain('session'),
    cleanup: async () => {
      host.disable('qq')
      await fake.close()
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch { /* Windows lock */ }
    },
  }
}

function collectNudge(env, timeoutMs = 5000) {
  let captured = ''
  return waitFor(() => {
    for (const batch of env.drain()) {
      if (batch.text.includes('[QQ积压提醒')) { captured = batch.text; return true }
    }
    return false
  }, { timeoutMs }).then((ok) => ({ ok, text: captured }))
}

test('compact：nudge 用短 preamble，快照/正文保留，bump 一次', async () => {
  const env = await setup({ compact: true })
  try {
    env.fake.privateMessage({ from: OWNER, name: '主人', text: '第一条', messageId: 9901 })
    env.fake.privateMessage({ from: OWNER, name: '主人', text: '第二条', messageId: 9902 })
    const { ok, text } = await collectNudge(env)
    assert.equal(ok, true)
    assert.match(text, /\[QQ积压提醒·紧凑\]/)
    assert.doesNotMatch(text, /\[QQ积压提醒\] 你离开这会儿/)
    assert.match(text, /醒来第一眼/)
    assert.match(text, /第一条/)
    assert.equal(env.bumps() >= 1, true, '真正投递后应 bump')
  } finally { await env.cleanup() }
})

test('full（compact=false）：保持原长 preamble；bump 一次', async () => {
  const env = await setup({ compact: false })
  try {
    env.fake.privateMessage({ from: OWNER, name: '主人', text: '安静的一条', messageId: 9903 })
    const { ok, text } = await collectNudge(env)
    assert.equal(ok, true)
    assert.match(text, /\[QQ积压提醒\] 你离开这会儿/)
    assert.doesNotMatch(text, /·紧凑/)
    assert.equal(env.bumps() >= 1, true)
  } finally { await env.cleanup() }
})

test('focus queued：不计 bump；旧版 time 无 wake：全量降级、不报错', async () => {
  const env = await setup({ compact: true })
  try {
    const lease = env.host.services.focus.enter({ label: 'qq:test', interruptible: false })
    try {
      env.fake.privateMessage({ from: OWNER, name: '主人', text: 'focus 里的', messageId: 9904 })
      await waitFor(() => (env.qq.status().wake?.emittedByKind?.nudge ?? 0) >= 1)
      await sleep(50)
      assert.equal(env.bumps(), 0, 'queued 的 wake 不该 bump')
    } finally { lease.release() }
  } finally { await env.cleanup() }

  const old = await setup({ withTime: false })
  try {
    old.fake.privateMessage({ from: OWNER, name: '主人', text: '没有 time wake', messageId: 9905 })
    const { ok, text } = await collectNudge(old)
    assert.equal(ok, true)
    assert.match(text, /\[QQ积压提醒\] 你离开这会儿/, '没有 wake 服务时用全量')
    assert.doesNotMatch(text, /·紧凑/)
  } finally { await old.cleanup() }
})
