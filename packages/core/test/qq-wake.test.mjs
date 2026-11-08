// 唤醒矩阵：只生成 signal（不投递/不碰 delivery），replyCheck/proactive/nudge 区分类型、去重、限额。
// 单元用假时钟验证规划；集成用短间隔真实定时器验证 signal 进入 delivery 的路径。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../src/index.mjs'
import * as qqModule from '../../plugins/qq/src/index.mjs'
import manifest from '../../plugins/qq/manifest.json' with { type: 'json' }
import { createFakeOneBot } from '../../plugins/qq/tools/fake-onebot.mjs'
import { createWakePlanner, normalizeWakeConfig } from '../../plugins/qq/src/wake.mjs'
import { buildWakeSnapshot } from '../../plugins/qq/src/wake-snapshot.mjs'

const TOKEN = 'wake-token'
const OWNER = '10001'
const SELF = '2593621742'

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }
async function waitFor(predicate, { timeoutMs = 4000, stepMs = 10 } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await sleep(stepMs)
  }
  return predicate()
}

test('规划器：replyCheck 到点只发一次；新 inbound 取消未发的检查', () => {
  let at = 1000
  const planner = createWakePlanner({ now: () => at, config: { replyCheckDelayMs: 1000, maxWakePerHour: 10 } })
  planner.noteOutbound('qq:private:1', { at: 1000 })
  assert.deepEqual(planner.poll({ at: 1999 }), [])
  const first = planner.poll({ at: 2000 })
  assert.equal(first.length, 1)
  assert.equal(first[0].kind, 'replyCheck')
  assert.ok(first[0].tags.includes('replyCheck'))
  assert.deepEqual(planner.poll({ at: 2500 }), [], '同一 outbound 不重复检查')

  planner.noteOutbound('qq:private:1', { at: 3000 })
  planner.noteInbound('qq:private:1', { at: 3500 })
  assert.deepEqual(planner.poll({ at: 4100 }), [], '新消息取消回复检查')
})

test('规划器：proactive 需要空闲+概率+冷却；nudge 按未读变化/冷却提醒', () => {
  let at = 0
  let unread = 0
  const planner = createWakePlanner({
    now: () => at,
    random: () => 0,
    config: {
      replyCheckDelayMs: 100_000,
      proactiveEnabled: true,
      proactiveMinMs: 3000, proactiveMaxMs: 3000, proactiveIdleMs: 1000,
      proactiveProbability: 1, proactiveCooldownMs: 5000,
      nudgeEnabled: true, nudgeSoftMs: 1000, nudgeCooldownMs: 5000, nudgeMaxPerHour: 5, maxWakePerHour: 20,
    },
    unreadCount: () => unread,
  })
  at = 1000
  planner.noteInbound('qq:private:1', { at: 1000 })
  assert.deepEqual(planner.poll({ at: 1999 }), [], 'nudge 未到 soft、proactive 未到点')
  unread = 2
  const nudge1 = planner.poll({ at: 2000 })
  assert.equal(nudge1.length, 1)
  assert.equal(nudge1[0].kind, 'nudge')
  assert.equal(nudge1[0].unread, 2)
  assert.deepEqual(planner.poll({ at: 2500 }), [], '同一未读版本不重复 nudge')
  at = 4000
  const proactive = planner.poll({ at: 4000 })
  assert.equal(proactive.length, 1)
  assert.equal(proactive[0].kind, 'proactive')
  assert.deepEqual(planner.poll({ at: 4500 }), [], '没到冷却/新一轮不重复主动机会')
  unread = 0
  at = 8000
  assert.deepEqual(planner.poll({ at: 8000 }), [], '已读后不再 nudge')
})

test('规划器：小时预算限制，超了跳过并计数', () => {
  let at = 5000
  const planner = createWakePlanner({ now: () => at, config: { replyCheckDelayMs: 100, maxWakePerHour: 1 } })
  planner.noteOutbound('qq:private:1', { at })
  planner.noteOutbound('qq:private:2', { at })
  at = 6000
  const out = planner.poll({ at })
  assert.equal(out.length, 1)
  assert.equal(planner.status().skippedBudget >= 1, true)
})

test('快照：oldest-first、≤12 条/6000 字、超预算 partial + readThroughSeq、去信封前缀', () => {
  const rows = Array.from({ length: 15 }, (_, i) => ({
    seq: i + 1, sender: '主人', at: 1000 + i, text: `[QQ私聊·主人] 主人：第${i + 1}条`,
  }))
  const snap = buildWakeSnapshot(rows)
  assert.equal(snap.count, 15)
  assert.equal(snap.included, 12)
  assert.equal(snap.partial, true)
  assert.equal(snap.readThroughSeq, 12)
  assert.match(snap.text, /#1 主人：第1条/)
  assert.doesNotMatch(snap.text, /\[QQ私聊/)
  assert.match(snap.text, /#12/)
  assert.doesNotMatch(snap.text, /#13/)
  assert.equal(snap.text.split('\n').length, 12)
  assert.deepEqual(buildWakeSnapshot([]), { text: '', count: 0, included: 0, partial: false, readThroughSeq: null })
  const long = buildWakeSnapshot([{ seq: 1, sender: '主人', text: '啊'.repeat(7000) }], { maxItems: 3, maxChars: 6000 })
  assert.equal(long.partial, true)
  assert.equal(long.readThroughSeq, 1)
  assert.ok(long.text.length <= 6000)
})

test('集成：积压 nudge 正文带醒来第一眼快照（oldest-first）', async () => {
  const env = await setup({ nudgeSoftMs: 1000, nudgeCooldownMs: 1000, wakeTickMs: 250 })
  try {
    env.fake.privateMessage({ from: OWNER, name: '主人', text: '第一条', messageId: 9531 })
    env.fake.privateMessage({ from: OWNER, name: '主人', text: '第二条', messageId: 9532 })
    let captured = ''
    const ok = await waitFor(() => {
      for (const batch of env.drain()) {
        if (batch.text.includes('[QQ积压提醒]')) { captured = batch.text; return true }
      }
      return false
    }, { timeoutMs: 5000 })
    assert.equal(ok, true)
    assert.match(captured, /醒来第一眼/)
    assert.match(captured, /#1/)
    assert.ok(captured.indexOf('#1') < captured.indexOf('#2'), 'oldest-first')
    const wm = env.qq.status().ledger.watermarks.find((row) => String(row.peer) === String(OWNER))
    assert.equal(wm.attendedSeq, 2, '醒来第一眼快照投递后应自动标已读')
    assert.equal(wm.undelivered, 0)
  } finally { await env.cleanup() }
})

function makeConfig(fake, dir, overrides = {}) {
  return {
    enabled: true, url: `ws://127.0.0.1:${fake.port}/`, token: TOKEN, selfId: SELF,
    allowPrivate: [OWNER], ownerQQ: OWNER,
    allowSend: true, sendApproval: 'lead-approved',
    sendMinIntervalMs: 0, sendMaxPerMinute: 50, sendMaxPerHour: 200, maxSendsPerTurn: 10,
    sendSameTextWindowMs: 0, auditFile: path.join(dir, 'audit.jsonl'),
    ledgerFile: path.join(dir, 'ledger.db'), mediaInboxDir: path.join(dir, 'media'),
    wakeTickMs: 20,
    ...overrides,
  }
}

async function setup(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-wake-'))
  const fake = await createFakeOneBot({ port: 0, token: TOKEN })
  const host = createHost({ log: () => {} })
  host.registerPlugin(manifest, qqModule, { config: makeConfig(fake, dir, overrides) })
  await host.enable('qq')
  const qq = host.shared.get('qq')
  await waitFor(() => qq.status().send?.registered === true && qq.status().send?.transport?.connected === true)
  return {
    dir, fake, host, qq,
    drain: () => host.services.delivery.drain('session'),
    cleanup: async () => { host.disable('qq'); await fake.close(); fs.rmSync(dir, { recursive: true, force: true }) },
  }
}

test('集成：qq_send 后到点生成 [QQ主动检查] signal（不是用户消息）', async () => {
  const env = await setup({ replyCheckDelayMs: 30, replyCheckEnabled: true })
  try {
    env.fake.privateMessage({ from: OWNER, name: '主人', text: '在吗', messageId: 9501 })
    await waitFor(() => env.qq.status().ledger.messages >= 1)
    env.drain().forEach((b) => env.host.services.delivery.ack(b.id))
    await env.host.services.tools.list().find((t) => t.name === 'qq_send').execute({ text: '在的' })
    const ok = await waitFor(() => {
      const texts = env.drain().map((b) => b.text)
      return texts.some((t) => t.includes('[QQ主动检查]'))
    })
    assert.equal(ok, true)
    const wakeStatus = env.qq.status().wake
    assert.equal(wakeStatus.emittedByKind.replyCheck >= 1, true)
    // 再次检查：没有同一条的重复
    await sleep(80)
    const texts = env.drain().map((b) => b.text)
    assert.equal(texts.filter((t) => t.includes('[QQ主动检查]')).length, 0, '同一 outbound 不重复')
  } finally { await env.cleanup() }
})

test('集成：新 inbound 取消未发出的 [QQ主动检查]', async () => {
  const env = await setup({ replyCheckDelayMs: 80, replyCheckVisible: true })
  try {
    env.fake.privateMessage({ from: OWNER, text: '在吗', messageId: 9511 })
    await waitFor(() => env.qq.status().ledger.messages >= 1)
    env.drain().forEach((b) => env.host.services.delivery.ack(b.id))
    await env.host.services.tools.list().find((t) => t.name === 'qq_send').execute({ text: '在的' })
    env.fake.privateMessage({ from: OWNER, text: '新消息来了', messageId: 9512 })
    await waitFor(() => env.qq.status().ledger.messages >= 2)
    await sleep(120)
    const texts = env.drain().map((b) => b.text)
    assert.equal(texts.some((t) => t.includes('[QQ主动检查]')), false, '新消息到达后不再发检查')
  } finally { await env.cleanup() }
})

test('集成：proactive 默认关闭；打开后空闲到点生成 [QQ主动提醒]', async () => {
  const off = await setup({ proactiveEnabled: false })
  try {
    off.fake.privateMessage({ from: OWNER, text: '安静', messageId: 9521 })
    await sleep(80)
    assert.equal(off.drain().map((b) => b.text).some((t) => t.includes('[QQ主动提醒]')), false)
  } finally { await off.cleanup() }
  const on = await setup({
    proactiveEnabled: true, proactiveMinMs: 20, proactiveMaxMs: 20, proactiveIdleMs: 10,
    proactiveProbability: 1, proactiveCooldownMs: 1000,
  })
  try {
    on.fake.privateMessage({ from: OWNER, text: '安静', messageId: 9522 })
    const ok = await waitFor(() => {
      const texts = on.drain().map((b) => b.text)
      return texts.some((t) => t.includes('[QQ主动提醒]'))
    })
    assert.equal(ok, true)
  } finally { await on.cleanup() }
})
