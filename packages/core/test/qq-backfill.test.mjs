// P0-1：账本/水位 + 断线补课（get_friend_msg_history 契约用 fake OneBot 定义）。
//
// 覆盖：SQLite 账本 seq/去重/水位/重启；HTTP 动作客户端；补课闸门（旧消息窗口/水位过滤/自己消息）；
// 插件集成：WS 断开 → 补课补回 → 不双投 → gap 可见；补课失败只记 gap 不影响实时入站。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../src/index.mjs'
import * as qqModule from '../../plugins/qq/src/index.mjs'
import manifest from '../../plugins/qq/manifest.json' with { type: 'json' }
import { createFakeOneBot } from '../../plugins/qq/tools/fake-onebot.mjs'
import { createLedger } from '../../plugins/qq/src/ledger.mjs'
import { createOneBotHttp } from '../../plugins/qq/src/onebot-http.mjs'
import { createBackfill } from '../../plugins/qq/src/backfill.mjs'
import { createInboundGate } from '../../plugins/qq/src/gate.mjs'

const TOKEN = 'backfill-token'
const OWNER = '10001'

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }
async function waitFor(predicate, { timeoutMs = 8000, stepMs = 30 } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await sleep(stepMs)
  }
  return predicate()
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'qq-backfill-')) }

function baseConfig(fake, dir, overrides = {}) {
  return {
    enabled: true,
    url: `ws://127.0.0.1:${fake.port}/`,
    token: TOKEN,
    selfId: '2593621742',
    allowPrivate: [OWNER],
    ownerQQ: OWNER,
    ledgerFile: path.join(dir, 'qq-ledger.db'),
    httpUrl: fake.httpUrl,
    httpToken: '',
    backfillEnabled: true,
    backfillCount: 20,
    maxBackfillAgeMs: 6 * 3600_000,
    retryTickMs: 20,
    statusIntervalMs: 1000,
    ...overrides,
  }
}

function message({ from = OWNER, text = '在吗', messageId = 1, time = Math.floor(Date.now() / 1000) } = {}) {
  return {
    post_type: 'message', message_type: 'private', sub_type: 'friend', time,
    self_id: '2593621742', user_id: Number(from), message_id: messageId,
    message: [{ type: 'text', data: { text } }], raw_message: text,
    sender: { user_id: Number(from), nickname: '测试' },
  }
}

test('账本：活动内 seq 单调、qq_id 去重、水位只进不退、重启可恢复', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'ledger.db')
  try {
    let ledger = createLedger({ file })
    assert.equal(ledger.mode, 'sqlite')
    const a1 = ledger.append({ activity: 'qq:private:1', qqId: 'm1', at: 1000, receivedAt: 1000, sender: 'A', text: '一' })
    const a2 = ledger.append({ activity: 'qq:private:1', qqId: 'm2', at: 2000, receivedAt: 2000, sender: 'A', text: '二' })
    const dup = ledger.append({ activity: 'qq:private:1', qqId: 'm2', at: 2000, receivedAt: 2001, sender: 'A', text: '二' })
    assert.equal(a1.seq, 1)
    assert.equal(a2.seq, 2)
    assert.equal(dup.duplicate, true)
    assert.equal(ledger.markDelivered('qq:private:1', 2), true)
    ledger.markDelivered('qq:private:1', 1)
    assert.equal(ledger.lastKnown('qq:private:1').deliveredSeq, 2, '交付高水位到 2')
    assert.equal(ledger.lastKnown('qq:private:1').attendedSeq, 0, '交付不等于已读（attended 由 mark_read 推进）')
    assert.equal(ledger.markDelivered('qq:private:1', 99), false, '不存在的 seq 不推进')
    assert.equal(ledger.lastKnown('qq:private:1').lastQqId, 'm2')
    ledger.close()

    ledger = createLedger({ file })
    assert.equal(ledger.stats().messages, 2)
    assert.equal(ledger.stats().delivered, 2)
    assert.equal(ledger.hasMessage('qq:private:1', 'm1'), true)
    assert.equal(ledger.lastKnown('qq:private:1').deliveredSeq, 2)
    ledger.close()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('闸门：补课消息在窗口内收、打 [补课] 标记；超窗拒绝且不回退成实时 stale', () => {
  const nowMs = 1_800_000_000_000
  const gate = createInboundGate({ selfId: '2593621742', allowPrivate: [OWNER], maxStaleMs: 600_000, now: () => nowMs })
  const recent = message({ messageId: 11, time: Math.floor((nowMs - 60_000) / 1000) })
  const ok = gate.admit(recent, { receivedAt: nowMs, backfilled: true, maxBackfillAgeMs: 6 * 3600_000 })
  assert.equal(ok.accept, true)
  assert.ok(ok.signal.tags.includes('backfill'))
  assert.equal(ok.signal.meta.qq.backfilled, true)
  assert.match(ok.signal.text, /^\[补课\] /)

  const old = message({ messageId: 12, time: Math.floor((nowMs - 48 * 3600_000) / 1000) })
  const dropped = gate.admit(old, { receivedAt: nowMs, backfilled: true, maxBackfillAgeMs: 6 * 3600_000 })
  assert.equal(dropped.accept, false)
  assert.equal(dropped.code, 'stale-backfill')

  // 实时消息仍然按 maxStaleMs 判（backfilled=false）
  const liveOld = message({ messageId: 13, time: Math.floor((nowMs - 20 * 60_000) / 1000) })
  const liveDrop = gate.admit(liveOld, { receivedAt: nowMs })
  assert.equal(liveDrop.code, 'stale')
})

test('补课器：只补未见过的消息；跳过自己发的与超窗的；fetch 失败记 failed', async () => {
  const seen = new Set()
  const ledger = {
    hasMessage: (_a, id) => seen.has(String(id)),
    lastKnown: () => ({ lastAt: 0, lastQqId: null, attendedSeq: 0 }),
  }
  const http = { ok: true, async call() { return { messages: [
    message({ messageId: 21, text: '补一', time: Math.floor(Date.now() / 1000) }),
    message({ messageId: 22, text: '补二', time: Math.floor(Date.now() / 1000) }),
  ] } } }
  const ingested = []
  const backfill = createBackfill({
    http, ledger, now: () => Date.now(), selfId: '2593621742',
    ingest: (event) => { ingested.push(event); return { accept: true } },
    peers: () => [OWNER],
  })
  const r = await backfill.run({ reason: 'test' })
  assert.equal(r.filled, 2)
  assert.equal(ingested.length, 2)

  // 失败不抛，只记 failed
  const failing = createBackfill({
    http: { ok: true, async call() { throw new Error('boom') } },
    ledger, ingest: () => ({ accept: true }), peers: () => [OWNER],
  })
  const rf = await failing.run({ reason: 'test' })
  assert.equal(rf.failed, 1)
  assert.match(failing.status().lastError, /boom/)
  assert.equal(failing.status().runs, 1)
})

test('插件集成：断线期间的消息在重连后补回，不双投；gap 可见；不调用 mark_msg_as_read', async () => {
  const dir = tmpDir()
  const fake = await createFakeOneBot({ port: 0, token: TOKEN })
  const config = baseConfig(fake, dir)
  const host = createHost({ log: () => {} })
  host.registerPlugin(manifest, qqModule, { config })
  await host.enable('qq')
  const qq = host.shared.get('qq')
  try {
    await waitFor(() => qq.status().connection.connected === true)
    // 先来一条实时消息（时间放在 5 分钟前，后面的补课消息要比它新才能过水位）
    fake.privateMessage({ from: OWNER, text: '断线前', messageId: 100, time: Math.floor(Date.now() / 1000) - 300 })
    await waitFor(() => qq.status().ledger.messages >= 1)
    assert.equal(qq.status().ledger.delivered, 1)
    assert.equal(qq.status().gap.backfillRuns >= 1, true, '首次连接会跑一次补课（空历史也无害）')

    // 断线；断线期间的两条消息只进历史，不推 WS
    fake.dropConnections()
    fake.pushHistory({ from: OWNER, text: '断线期间一', messageId: 101, time: Math.floor(Date.now() / 1000) - 120 })
    fake.pushHistory({ from: OWNER, text: '断线期间二', messageId: 102, time: Math.floor(Date.now() / 1000) - 60 })
    fake.pushSelfHistory({ to: OWNER, text: '我自己发的', messageId: 103, time: Math.floor(Date.now() / 1000) - 30 })

    const ok = await waitFor(() => qq.status().gap.filled >= 2 && qq.status().ledger.messages >= 3)
    assert.equal(ok, true, JSON.stringify(qq.status().gap))
    const status = qq.status()
    assert.equal(status.ledger.messages, 3, '只入账两条对方消息 + 一条断线前；自己的不入账')
    assert.equal(status.gap.reconnects >= 1, true)
    assert.equal(status.gap.backfillRuns >= 2, true)
    // 补回的消息带着 [补课] 进入 delivery
    const batches = host.services.delivery.drain('session')
    const text = batches.map((b) => b.text).join('\n')
    assert.match(text, /\[补课\] .*断线期间一/)
    assert.match(text, /\[补课\] .*断线期间二/)
    assert.match(text, /\[QQ私聊·主人\] \[补课\] .*断线期间一/, '补课消息也带说话人信封')
    assert.doesNotMatch(text, /我自己发的/)
    for (const batch of batches) host.services.delivery.ack(batch.id)
    // 已读动作不应被调用（P0 只补课，不替用户标已读）
    assert.equal(fake.actions().some((a) => /mark_.*as_read/.test(a.action)), false)

    // 再断一次、没有新历史：不会重复补
    const deliveredBefore = status.stats.delivered
    fake.dropConnections()
    await waitFor(() => qq.status().connection.connected === true)
    await sleep(400)
    assert.equal(qq.status().ledger.messages, 3)
    assert.ok(qq.status().stats.delivered >= deliveredBefore)
    assert.equal(qq.status().gap.filled >= 2, true)
  } finally {
    host.disable('qq')
    await fake.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('插件集成：超窗旧消息跳过并计数；HTTP 失败只记 gap.failed，不影响实时入站', async () => {
  const dir = tmpDir()
  const fake = await createFakeOneBot({ port: 0, token: TOKEN })
  const config = baseConfig(fake, dir, { maxBackfillAgeMs: 30_000 })
  const host = createHost({ log: () => {} })
  host.registerPlugin(manifest, qqModule, { config })
  await host.enable('qq')
  const qq = host.shared.get('qq')
  try {
    await waitFor(() => qq.status().connection.connected === true)
    fake.privateMessage({ from: OWNER, text: '实时', messageId: 200, time: Math.floor(Date.now() / 1000) - 300 })
    await waitFor(() => qq.status().ledger.messages >= 1)
    // 比水位新（在游标之后）但早于 maxBackfillAgeMs：应被跳过并计入 dropped
    fake.pushHistory({ from: OWNER, text: '一分钟前', messageId: 201, time: Math.floor(Date.now() / 1000) - 60 })
    fake.dropConnections()
    await waitFor(() => qq.status().gap.dropped >= 1)
    assert.equal(qq.status().gap.dropped >= 1, true)

    // 断线期间 HTTP 挂掉：重连仍成功，failed 记录，实时消息还能进来
    fake.setActionMode('reject')
    fake.dropConnections()
    fake.pushHistory({ from: OWNER, text: 'HTTP 挂时丢的', messageId: 202, time: Math.floor(Date.now() / 1000) - 5 })
    await waitFor(() => qq.status().gap.failed >= 1)
    assert.equal(qq.status().gap.failed >= 1, true)
    fake.setActionMode('ok')
    fake.privateMessage({ from: OWNER, text: '恢复后的实时', messageId: 203, time: Math.floor(Date.now() / 1000) })
    await waitFor(() => qq.status().gate.accepted >= 3 || qq.status().ledger.messages >= 2)
    assert.equal(qq.status().connection.connected, true)
  } finally {
    host.disable('qq')
    await fake.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('HTTP 客户端：成功解析 data；retcode 非 0 抛错', async () => {
  const fake = await createFakeOneBot({ port: 0, token: TOKEN })
  try {
    fake.pushHistory({ from: OWNER, text: '历史一条', messageId: 300 })
    const ok = createOneBotHttp({ endpointUrl: fake.httpUrl })
    const data = await ok.call('get_friend_msg_history', { user_id: Number(OWNER), count: 10 })
    assert.equal(data.messages.length, 1)
    assert.equal(data.messages[0].message_id, 300)
    fake.setActionMode('reject')
    await assert.rejects(() => ok.call('get_friend_msg_history', { user_id: Number(OWNER) }), /失败/)
  } finally { await fake.close() }
})

test('补课器群：群历史只走 allowlist 群，事件 message_type=group、activity 正确', async () => {
  const calls = []
  const http = {
    ok: true,
    async call(action, params) {
      calls.push({ action, params })
      return { messages: [{ message_id: 7001, time: Math.floor(Date.now() / 1000), user_id: 20002, sender: { user_id: 20002, nickname: '群友' }, message: [{ type: 'text', data: { text: '群补一条' } }] }] }
    },
  }
  const ingested = []
  const ledger = {
    hasMessage: () => false,
    lastKnown: () => ({ lastAt: 0, attendedSeq: 0 }),
  }
  const backfill = createBackfill({
    http, ledger, selfId: '2593621742',
    peers: () => [],
    groups: () => ['601357169'],
    ingest: (event) => { ingested.push(event); return { accept: true } },
  })
  const r = await backfill.run({ reason: 'test' })
  assert.equal(calls[0].action, 'get_group_msg_history')
  assert.equal(calls[0].params.group_id, 601357169)
  assert.equal(r.groups, 1)
  assert.equal(r.filled, 1)
  assert.equal(ingested[0].message_type, 'group')
  assert.equal(ingested[0].group_id, 601357169)
})

test('补课器：selfId 可为 getter，补课必须跳过机器人自己发的消息', async () => {
  const http = { ok: true, async call() { return { messages: [{ message_id: 7101, time: Math.floor(Date.now() / 1000), group_id: 601357169, user_id: 2593621742, sender: { user_id: 2593621742, nickname: '鱼鱼' }, message: [{ type: 'text', data: { text: '机器人自己' } }] }] } } }
  const ingested = []
  const backfill = createBackfill({
    http,
    ledger: { hasMessage: () => false, lastKnown: () => ({ lastAt: 0 }) },
    selfId: () => '2593621742',
    groups: () => ['601357169'],
    ingest: (event) => { ingested.push(event); return { accept: true } },
  })
  const r = await backfill.run({ reason: 'test' })
  assert.equal(r.filled, 0)
  assert.equal(ingested.length, 0)
})

test('gate：构造时 selfId 未知时，可用逐条 selfId 过滤自己的群/私聊消息', () => {
  const gate = createInboundGate({ selfId: null, allowPrivate: [OWNER], groupPolicy: 'allowlist', allowGroups: ['601357169'], now: () => Date.now() })
  const base = { post_type: 'message', self_id: '2593621742', message_id: 8001, time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text: '我自己' } }], raw_message: '我自己' }
  const group = { ...base, message_type: 'group', group_id: 601357169, user_id: 2593621742, sender: { user_id: 2593621742, nickname: '鱼鱼' } }
  assert.equal(gate.admit(group, { selfId: '2593621742' }).code, 'self')
  const priv = { ...base, message_type: 'private', sub_type: 'friend', user_id: 2593621742, sender: { user_id: 2593621742 } }
  assert.equal(gate.admit(priv, { selfId: '2593621742' }).code, 'self')
})
