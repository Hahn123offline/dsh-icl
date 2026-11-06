// P1 账本工具（qq_unread / qq_history / qq_replied）+ 出站引用回复。
// 全部 fake OneBot；不连 SnowLuma。
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

const TOKEN = 'p1-token'
const OWNER = '10001'
const SELF = '2593621742'

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }
async function waitFor(predicate, { timeoutMs = 6000, stepMs = 20 } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await sleep(stepMs)
  }
  return predicate()
}

test('账本：messages/unread/markReplied/replyState（SQLite + 重启）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-p1-ledger-'))
  const file = path.join(dir, 'l.db')
  try {
    let ledger = createLedger({ file })
    ledger.append({ activity: 'qq:private:10001', qqId: 'm1', at: 1000, receivedAt: 1000, sender: '主人', text: '[QQ私聊·主人] 主人：一' })
    ledger.append({ activity: 'qq:private:10001', qqId: 'm2', at: 2000, receivedAt: 2000, sender: '主人', text: '[QQ私聊·主人] 主人：二' })
    assert.equal(ledger.messages('qq:private:10001').length, 2)
    assert.equal(ledger.messages('qq:private:10001', { afterSeq: 1 }).map((m) => m.qqId).join(','), 'm2')
    assert.equal(ledger.unread('qq:private:10001', { afterSeq: 0 }).messages.length, 2)
    assert.equal(ledger.replyState('qq:private:10001', { messageId: 'm1' }).replied, false)
    assert.equal(ledger.markReplied('qq:private:10001', { throughSeq: 1, at: 3000 }), 1)
    const s1 = ledger.replyState('qq:private:10001', { messageId: 'm1' })
    const s2 = ledger.replyState('qq:private:10001', { messageId: 'm2' })
    assert.equal(s1.replied, true)
    assert.equal(s2.replied, false)
    const agg = ledger.replyState('qq:private:10001')
    assert.equal(agg.lastSeq, 2)
    assert.equal(agg.lastRepliedSeq, 1)
    assert.equal(agg.unreplied, 1)
    assert.equal(ledger.lastKnown('qq:private:10001').lastSeq, 2)
    // delivered ≠ attended：未交付时 mark_read 不能推进；交付后只推进到连续已交付高水位。
    const beforeDelivery = ledger.markRead('qq:private:10001', { throughSeq: 99, at: 4000 })
    assert.equal(beforeDelivery.attendedSeq, 0, '未交付消息不能被标掉')
    assert.equal(beforeDelivery.deliveredSeq, 0)
    assert.equal(beforeDelivery.clampedToDelivered, true)
    assert.equal(ledger.unread('qq:private:10001').messages.length, 2)
    ledger.markDelivered('qq:private:10001', 1)
    const read1 = ledger.markRead('qq:private:10001', { throughSeq: 1, at: 5000 })
    assert.equal(read1.attendedSeq, 1)
    assert.equal(read1.advanced, 1)
    assert.equal(ledger.unread('qq:private:10001').messages.length, 1)
    ledger.markDelivered('qq:private:10001', 2)
    const read2 = ledger.markRead('qq:private:10001', { throughSeq: 99, at: 6000 })
    assert.equal(read2.attendedSeq, 2, '交付后夹到 deliveredSeq')
    assert.equal(ledger.replyState('qq:private:10001', { messageId: 'm2' }).replied, false, '已读不等于已回')
    ledger.close()

    ledger = createLedger({ file })
    assert.equal(ledger.replyState('qq:private:10001', { messageId: 'm1' }).replied, true, 'replied_at 跨重启保留')
    ledger.close()
  } finally { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch { /* Windows sqlite 句柄可能延迟释放；临时目录不阻塞测试 */ } }
})

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-p1-'))
  const fake = await createFakeOneBot({ port: 0, token: TOKEN })
  const host = createHost({ log: () => {} })
  host.registerPlugin(manifest, qqModule, {
    config: {
      enabled: true, url: `ws://127.0.0.1:${fake.port}/`, token: TOKEN, selfId: SELF,
      allowPrivate: [OWNER], ownerQQ: OWNER,
      allowSend: true, sendApproval: 'lead-approved',
      sendMinIntervalMs: 0, sendMaxPerMinute: 50, sendMaxPerHour: 200, maxSendsPerTurn: 10,
      sendSameTextWindowMs: 0, auditFile: path.join(dir, 'audit.jsonl'),
      ledgerFile: path.join(dir, 'ledger.db'), mediaInboxDir: path.join(dir, 'media'),
      stickerDir: path.join(dir, 'stickers'),
    },
  })
  await host.enable('qq')
  const qq = host.shared.get('qq')
  await waitFor(() => qq.status().send?.registered === true && qq.status().send?.transport?.connected === true)
  const tool = (name) => host.services.tools.list().find((t) => t.name === name)
  const audit = () => {
    try { return fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] }
  }
  return {
    dir, fake, host, qq, tool, audit,
    cleanup: async () => { host.disable('qq'); await fake.close(); fs.rmSync(dir, { recursive: true, force: true }) },
  }
}

test('账本：deliveredSeq 只认连续交付；markRead 不跨未交付空洞', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-p1-gap-'))
  const file = path.join(dir, 'gap.db')
  try {
    const ledger = createLedger({ file })
    const activity = 'qq:private:10002'
    ledger.append({ activity, qqId: 'g1', at: 1000 })
    ledger.append({ activity, qqId: 'g2', at: 2000 })
    ledger.append({ activity, qqId: 'g3', at: 3000 })
    ledger.append({ activity, qqId: 'g4', at: 4000 })
    ledger.append({ activity, qqId: 'g5', at: 5000 })
    ledger.markDelivered(activity, 1)
    ledger.markDelivered(activity, 3) // 2 被拦下：已交付 1、3，但连续高水位仍是 1
    assert.equal(ledger.watermarks(activity).deliveredSeq, 1)
    assert.equal(ledger.watermarks(activity).lastSeq, 5)
    // 批量补推（重放回执）：幂等、空洞不推进、不动 attended
    assert.deepEqual(ledger.markDeliveredSeqs(activity, [3]), { accepted: 0, skipped: 1 })
    assert.equal(ledger.watermarks(activity).deliveredSeq, 1)
    // 乱序回执：seq5 先到、seq3/4 还没到 → deliveredSeq 不前进也不回退；补齐后才连续前进
    assert.deepEqual(ledger.markDeliveredSeqs(activity, [5]), { accepted: 1, skipped: 0 })
    assert.equal(ledger.watermarks(activity).deliveredSeq, 1, 'seq5 先到不能把水位跨到 5')
    const read = ledger.markRead(activity, { throughSeq: 5 })
    assert.equal(read.attendedSeq, 1, '只能到连续已交付高水位')
    assert.equal(read.clampedToDelivered, true)
    assert.equal(ledger.unread(activity).messages.length, 4, '未交付的 #2/#4 等后续行仍可见')
    assert.equal(ledger.undelivered(activity).map((m) => m.qqId).join(','), 'g2,g4')
    ledger.markDelivered(activity, 2)
    assert.equal(ledger.watermarks(activity).deliveredSeq, 3, '补上 2 后连续到 3（4 还没交付）')
    ledger.markDelivered(activity, 4)
    assert.equal(ledger.watermarks(activity).deliveredSeq, 5)
    const read2 = ledger.markRead(activity)
    assert.equal(read2.attendedSeq, 5)
    assert.equal(ledger.unread(activity).messages.length, 0)
    ledger.close()
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* Windows sqlite 句柄延迟 */ } }
})

test('qq_unread / qq_history：水位、历史、补课标记保留', async () => {
  const env = await setup()
  try {
    env.fake.privateMessage({ from: OWNER, name: '主人', text: '第一条', messageId: 9001 })
    env.fake.privateMessage({ from: OWNER, name: '主人', text: '第二条', messageId: 9002 })
    await waitFor(() => env.qq.status().ledger.messages >= 2)
    const history = await env.tool('qq_history').execute({ peer: OWNER })
    assert.match(history.text, /第一条/)
    assert.match(history.text, /第二条/)
    assert.match(history.text, /#1/)
    assert.match(history.text, /#2/)
    assert.match(history.text, /\[QQ私聊·主人\]/)
    const unread = await env.tool('qq_unread').execute({ peer: OWNER })
    assert.match(unread.text, /已交付 #2，水位 #0/)
    assert.match(unread.text, /未读 2 条/)
    await env.tool('qq_mark_read').execute({ peer: OWNER, throughSeq: 2 })
    const afterRead = await env.tool('qq_unread').execute({ peer: OWNER })
    assert.match(afterRead.text, /没有水位之后的未读/)
    const all = await env.tool('qq_unread').execute({ peer: OWNER, afterSeq: 0 })
    assert.match(all.text, /未读 2 条/)
    const summary = await env.tool('qq_unread').execute({})
    assert.match(summary.text, /10001/)
    assert.match(summary.text, /水位 #2/)
  } finally { await env.cleanup() }
})

test('qq_replied + 出站引用：成功回复后标记已回；reply 段带 messageId；审计有 replyTo', async () => {
  const env = await setup()
  try {
    env.fake.privateMessage({ from: OWNER, name: '主人', text: '在吗', messageId: 9101 })
    await waitFor(() => env.qq.status().ledger.messages >= 1)
    const before = await env.tool('qq_replied').execute({ peer: OWNER, messageId: '9101' })
    assert.match(before.text, /还没回过/)
    const sent = await env.tool('qq_send').execute({ text: '在的', replyToMessageId: '9101' })
    assert.equal(sent.outcome, 'ok')
    const actions = env.fake.sendActions()
    assert.equal(actions.length, 1)
    assert.equal(Array.isArray(actions[0].params.message), true, '引用回复必须是 reply 段数组')
    assert.equal(actions[0].params.message[0].type, 'reply')
    assert.equal(actions[0].params.message[0].data.id, '9101')
    assert.equal(actions[0].params.message[1].type, 'text')
    assert.equal(actions[0].params.message[1].data.text, '在的')
    const auditRow = env.audit().at(-1)
    assert.equal(auditRow.replyTo, '9101')
    assert.equal(String(auditRow.text ?? ''), '')
    const after = await env.tool('qq_replied').execute({ peer: OWNER, messageId: '9101' })
    assert.match(after.text, /已经回过/)
    const agg = await env.tool('qq_replied').execute({ peer: OWNER })
    assert.match(agg.text, /已回到 #1/)
    const status = env.qq.status().send.recent
    assert.equal(status.replyToMessageId, '9101')
  } finally { await env.cleanup() }
})

test('引用边界：不在账本里的 id / 多气泡带引用 都拒绝且零帧', async () => {
  const env = await setup()
  try {
    env.fake.privateMessage({ from: OWNER, text: '原消息', messageId: 9201 })
    await waitFor(() => env.qq.status().ledger.messages >= 1)
    const bad = await env.tool('qq_send').execute({ text: '引用空气', replyToMessageId: '999999' })
    assert.equal(bad.refused, true)
    assert.match(bad.text, /不在这个私聊的账本/)
    const multi = await env.tool('qq_send').execute({ messages: ['一', '二'], replyToMessageId: '9201' })
    assert.equal(multi.refused, true)
    assert.match(multi.text, /引用回复只支持单条/)
    assert.equal(env.fake.sendActions().length, 0)
  } finally { await env.cleanup() }
})

test('qq_mark_read：只推进本地水位（无网络/不自动回/不改已回）', async () => {
  const env = await setup()
  try {
    env.fake.privateMessage({ from: OWNER, name: '主人', text: '未读之一', messageId: 9601 })
    await waitFor(() => env.qq.status().ledger.messages >= 1)
    const framesBefore = env.fake.sendActions().length
    const read = await env.tool('qq_mark_read').execute({ peer: OWNER, throughSeq: 1 })
    assert.match(read.text, /水位没有推进|已把私聊/)
    assert.equal(env.fake.sendActions().length, framesBefore, 'mark_read 不发任何 QQ 消息')
    const replied = await env.tool('qq_replied').execute({ peer: OWNER, messageId: '9601' })
    assert.match(replied.text, /还没回过/, '已读不等于已回')
    const unread = await env.tool('qq_unread').execute({ peer: OWNER })
    assert.match(unread.text, /没有水位之后的未读|水位 #1/)
  } finally { await env.cleanup() }
})

test('发送后新消息：未读从水位之后开始；qq_history 可分段补看', async () => {
  const env = await setup()
  try {
    env.fake.privateMessage({ from: OWNER, text: '先来的', messageId: 9301 })
    await waitFor(() => env.qq.status().ledger.messages >= 1)
    await env.tool('qq_mark_read').execute({ peer: OWNER, throughSeq: 1 })
    await env.tool('qq_send').execute({ text: '收到' })
    env.fake.privateMessage({ from: OWNER, text: '后来的', messageId: 9302 })
    await waitFor(() => env.qq.status().ledger.messages >= 2)
    const unread = await env.tool('qq_unread').execute({ peer: OWNER })
    assert.match(unread.text, /已交付 #2，水位 #1/)
    assert.match(unread.text, /后来的/)
    const after = await env.tool('qq_history').execute({ peer: OWNER, afterSeq: 1 })
    assert.match(after.text, /后来的/)
    assert.doesNotMatch(after.text, /先来的/)
    const replied = await env.tool('qq_replied').execute({ peer: OWNER, messageId: '9302' })
    assert.match(replied.text, /还没回过/)
  } finally { await env.cleanup() }
})
