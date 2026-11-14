// P0 消息不丢：被 time 拦下（静音/睡眠）的消息仍进账本；ack（qq_mark_read）可以标记"看过不回"，
// 只清提醒、不假装已交付；内容始终能用 afterSeq:0 回看。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../src/index.mjs'
import * as qqModule from '../../plugins/qq/src/index.mjs'
import * as timeModule from '../../plugins/time/src/index.mjs'
import manifest from '../../plugins/qq/manifest.json' with { type: 'json' }
import timeManifest from '../../plugins/time/manifest.json' with { type: 'json' }
import { createFakeOneBot } from '../../plugins/qq/tools/fake-onebot.mjs'

const TOKEN = 'watermark-token'
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

test('未交付消息：ack 可以标记看过不回（不假装已交付）；内容仍可回看；nudge 仍尝试提醒', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-watermark-'))
  const fake = await createFakeOneBot({ port: 0, token: TOKEN })
  const host = createHost({ log: () => {} })
  try {
    host.registerPlugin(timeManifest, timeModule, { config: { stateFile: path.join(dir, 'time.json') } })
    host.registerPlugin(manifest, qqModule, {
      config: {
        enabled: true, url: `ws://127.0.0.1:${fake.port}/`, token: TOKEN, selfId: SELF,
        allowPrivate: [OWNER], ownerQQ: OWNER,
        ledgerFile: path.join(dir, 'ledger.db'), mediaInboxDir: path.join(dir, 'media'),
        wakeTickMs: 250, nudgeSoftMs: 1000, nudgeCooldownMs: 1000, nudgeMaxPerHour: 5,
        // 收消息时静音：QQ 信号应被 time 拦成积压（未交付）
      },
    })
    await host.enable('time')
    await host.enable('qq')
    const qq = host.shared.get('qq')
    await waitFor(() => qq.status().connection.connected === true)
    const tool = (name) => host.services.tools.list().find((t) => t.name === name)
    await tool('time_mute').execute({ minutes: 5, reason: 'p0-watermark-test' })

    for (const [id, text] of [[9701, '静音里第一条'], [9702, '静音里第二条'], [9703, '静音里第三条']]) {
      fake.privateMessage({ from: OWNER, name: '主人', text, messageId: id })
    }
    await waitFor(() => qq.status().ledger.messages >= 3)
    await sleep(300)

    const wm = qq.status().ledger.watermarks.find((w) => w.peer === OWNER)
    assert.ok(wm, 'status 里有该私聊的水位')
    assert.equal(wm.lastSeq, 3)
    assert.equal(wm.deliveredSeq, 0, '静音拦下的都没交付')
    assert.equal(wm.attendedSeq, 0)
    assert.equal(wm.undelivered, 3)
    assert.ok(Object.keys(qq.status().stats.blockedReasons ?? {}).length > 0, 'status 给出被拦原因')

    const unread = await tool('qq_unread').execute({ peer: OWNER })
    assert.match(unread.text, /最后 #3，已看 #0，已交付 #0/)
    assert.match(unread.text, /未读 3 条/)
    assert.equal((unread.text.match(/未交付/g) ?? []).length >= 3, true)
    assert.match(unread.text, /静音里第一条/)

    // nudge 仍会提醒（虽然提醒 signal 也被 time 拦，但规划器确实发出尝试）
    await waitFor(() => (qq.status().wake?.emittedByKind?.nudge ?? 0) >= 1, { timeoutMs: 4000 })
    const wake = qq.status().wake
    assert.ok((wake.emittedByKind.nudge ?? 0) >= 1, 'nudge 仍尝试提醒未交付消息')
    assert.ok((wake.skippedBudget ?? 0) >= 0)

    const beforeFrames = fake.sendActions().length
    const read = await tool('qq_mark_read').execute({ peer: OWNER, throughSeq: 3 })
    assert.match(read.text, /已把私聊/)
    assert.match(read.text, /已看 #3/)
    assert.match(read.text, /剩余未读 0 条/)
    assert.equal(fake.sendActions().length, beforeFrames, 'mark_read 不发 QQ 消息')

    const after = await tool('qq_unread').execute({ peer: OWNER })
    assert.match(after.text, /最后 #3，已看 #3/)
    assert.match(after.text, /没有未读消息/)
    const afterAll = await tool('qq_unread').execute({ peer: OWNER, afterSeq: 0 })
    assert.match(afterAll.text, /静音里第三条/, 'ack 后消息仍在账本，可回看')

    // 跨模块：time/focus 重放完自己的 backlog 后调用 noteDeliveredSeqs。
    // 只补 delivered，不推 attended；幂等；空洞不推进；失败不抛。
    const service = host.shared.get('qq')
    const activity = `qq:private:${OWNER}`
    const receipt1 = service.noteDeliveredSeqs({ activity, seqs: [2], via: 'time-backlog' })
    assert.equal(receipt1.ok, true)
    assert.equal(receipt1.accepted, 1)
    assert.equal(receipt1.deliveredSeq, 0, 'seq1 还空着：连续交付水位仍是 0')
    assert.equal(receipt1.attendedSeq, 0)
    assert.equal(receipt1.seenSeq, 3, 'ack 的 seen 不受 delivered 空洞影响')
    const receipt2 = service.noteDeliveredSeqs({ activity, seqs: [1, 3, 3], via: 'time-backlog' })
    assert.equal(receipt2.accepted, 2)
    assert.equal(receipt2.skipped, 0)
    assert.equal(receipt2.deliveredSeq, 3)
    assert.equal(receipt2.attendedSeq, 0, '补 delivered 不能算已读')
    const receipt3 = service.noteDeliveredSeqs({ activity, seqs: [1, 3], via: 'time-backlog' })
    assert.equal(receipt3.accepted, 0, '幂等')
    assert.equal(receipt3.skipped, 2)
    const via = qq.status().ledger.deliveredVia['time-backlog']
    assert.equal(via.accepted, 3)
    assert.equal(via.skipped, 2)
    assert.equal(via.calls, 3)

    const afterReceipt = await tool('qq_unread').execute({ peer: OWNER })
    assert.match(afterReceipt.text, /已看 #3，已交付 #3/)
    assert.match(afterReceipt.text, /没有未读消息/)
    const afterReceiptAll = await tool('qq_unread').execute({ peer: OWNER, afterSeq: 0 })
    assert.doesNotMatch(afterReceiptAll.text, /\[未交付/, '补推后行上的未交付标记消失')
    assert.match(afterReceiptAll.text, /静音里第三条/)

    // 补齐 delivered 后 mark_read 不再推进（seen 已经是 3）；三条仍可回看
    const readAfterReceipt = await tool('qq_mark_read').execute({ peer: OWNER, throughSeq: 3 })
    assert.match(readAfterReceipt.text, /已看水位没有推进/)
    const finalUnread = await tool('qq_unread').execute({ peer: OWNER })
    assert.match(finalUnread.text, /已看 #3/)
    assert.match(finalUnread.text, /没有未读消息/)
    const finalAll = await tool('qq_unread').execute({ peer: OWNER, afterSeq: 0 })
    assert.match(finalAll.text, /静音里第三条/)

    // 参数别名/失败路径：不抛、不误伤
    const peerAlias = service.noteDeliveredSeqs({ peer: OWNER, seqs: [], via: 'focus-backlog' })
    assert.equal(peerAlias.ok, true)
    assert.equal(peerAlias.accepted, 0)
    assert.equal(qq.status().ledger.deliveredVia['focus-backlog'].calls, 1)
    const bad = service.noteDeliveredSeqs({ seqs: [1] })
    assert.equal(bad.ok, false)
    assert.match(bad.error, /activity-required/)
  } finally {
    try { host.disable('qq') } catch { /* ignore */ }
    try { host.disable('time') } catch { /* ignore */ }
    await fake.close()
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch { /* Windows lock */ }
  }
})
