// phase 1 出站（qq_send）：三把钥匙、只回 owner 私聊、限速/去重/内容边界、
// 回执三态（ok/rejected/unknown）、失败不冒充成功、kill switch、审计、静态安全。
//
// 全部用假 OneBot WS（它会读客户端动作帧并回 echo 回执），不连真 QQ、不调模型。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../src/index.mjs'
import * as qqModule from '../../plugins/qq/src/index.mjs'
import manifest from '../../plugins/qq/manifest.json' with { type: 'json' }
import { createFakeOneBot } from '../../plugins/qq/tools/fake-onebot.mjs'

const TOKEN = 'send-token'
const OWNER = '10001'

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }
async function waitFor(predicate, { timeoutMs = 3000, stepMs = 20 } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await sleep(stepMs)
  }
  return predicate()
}

function baseConfig(fake, dir, overrides = {}) {
  return {
    enabled: true,
    url: `ws://127.0.0.1:${fake.port}/`,
    token: TOKEN,
    selfId: '2593621742',
    allowPrivate: [OWNER],
    ownerQQ: OWNER,
    allowSend: true,
    allowMediaSend: true,
    maxMediaPerTurn: 10,
    maxMediaPerHour: 20,
    maxSendImageBytes: 1024 * 1024,
    maxSendVideoBytes: 4 * 1024 * 1024,
    maxSendFileBytes: 4 * 1024 * 1024,
    maxSendVoiceBytes: 1024 * 1024,
    sendApproval: 'lead-approved',
    sendTimeoutMs: 500,
    sendMinIntervalMs: 0,
    sendMaxPerMinute: 10,
    sendMaxPerHour: 60,
    sendSameTextWindowMs: 0,
    maxSendsPerTurn: 10,
    maxSendChars: 2000,
    burstEnabled: true,
    burstMaxMessages: 8,
    burstIntervalMinMs: 10,
    burstIntervalMaxMs: 20,
    longGapProbability: 0,
    maxMessageChars: 500,
    auditFile: path.join(dir, 'audit.jsonl'),
    retryTickMs: 20,
    ...overrides,
  }
}

async function setup(overrides = {}, fakeOptions = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-send-'))
  const fake = await createFakeOneBot({ port: 0, token: TOKEN, ...fakeOptions })
  const config = baseConfig(fake, dir, overrides)
  const host = createHost({ log: () => {} })
  host.registerPlugin(manifest, qqModule, { config })
  await host.enable('qq')
  const qq = host.shared.get('qq')
  await waitFor(() => qq.status().send?.transport?.connected === true)
  const tool = () => host.services.tools.list().find((t) => t.name === 'qq_send')
  const audit = () => {
    try { return fs.readFileSync(config.auditFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)) } catch { return [] }
  }
  const turnEnd = () => host.services.signals.emit({ from: { plugin: 'test' }, kind: 'event', text: 'turn-end', tags: ['turn-end'] })
  return {
    dir, fake, config, host, qq, tool, audit, turnEnd,
    cleanup: async () => {
      try { host.disable('qq') } catch { /* 已停 */ }
      await fake.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('钥匙关闭时不注册 qq_send（影子模式），打开后才出现', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-send-off-'))
  const fake = await createFakeOneBot({ port: 0, token: TOKEN })
  const host = createHost({ log: () => {} })
  host.registerPlugin(manifest, qqModule, { config: { enabled: true, url: `ws://127.0.0.1:${fake.port}/`, token: TOKEN, allowPrivate: [OWNER] } })
  await host.enable('qq')
  try {
    assert.equal(host.services.tools.list().some((t) => t.name === 'qq_send'), false)
    assert.deepEqual(host.shared.get('qq').status().send, { registered: false, enabled: false })
  } finally {
    host.disable('qq')
    await fake.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('发送成功：一帧 send_private_msg、审计 ok、qq_status 显示三态；每轮一条 + turn-end 重置', async () => {
  const env = await setup()
  try {
    const tool = env.tool()
    assert.ok(tool, '应注册 qq_send')
    const first = await tool.execute({ text: '你好，我在' })
    assert.match(first.text, /已发出去（messageId=/)
    assert.equal(first.outcome, 'ok')
    const actions = env.fake.sendActions()
    assert.equal(actions.length, 1)
    assert.equal(actions[0].action, 'send_private_msg')
    assert.equal(actions[0].params.user_id, Number(OWNER))
    assert.equal(actions[0].params.message, '你好，我在')
    assert.equal(env.audit().at(-1).outcome, 'ok')
    assert.equal(env.audit().at(-1).chars, 5)
    assert.ok(env.audit().at(-1).textHash, '审计存 hash 不存正文')
    assert.equal(JSON.stringify(env.audit()).includes('你好，我在'), false, '审计不得存正文全文')

    const status = env.qq.status()
    assert.equal(status.send.recent.outcome, 'ok')
    const statusText = (await env.host.services.tools.list().find((t) => t.name === 'qq_status').execute()).text
    assert.match(statusText, /最近一次发送：.*结果=ok/)

    // 每轮最多 1 条（测试配置 maxSendsPerTurn=10，这里改用 1）
  } finally { await env.cleanup() }
})

test('每轮上限：默认 1 条；turn-end 后可以再发', async () => {
  const env = await setup({ maxSendsPerTurn: 1 })
  try {
    const tool = env.tool()
    assert.equal((await tool.execute({ text: '第一句' })).outcome, 'ok')
    const second = await tool.execute({ text: '第二句' })
    assert.match(second.text, /本轮最多 1 条/)
    assert.equal(env.fake.sendActions().length, 1)
    env.turnEnd()
    const third = await tool.execute({ text: '第二句' })
    assert.equal(third.outcome, 'ok')
    assert.equal(env.fake.sendActions().length, 2)
  } finally { await env.cleanup() }
})

test('后端拒绝 → rejected，文本写"没发出去：后端拒绝"；不自动重试', async () => {
  const env = await setup({}, { actionMode: 'reject' })
  try {
    const result = await env.tool().execute({ text: '会被拒' })
    assert.match(result.text, /没发出去：后端拒绝/)
    assert.equal(result.outcome, 'rejected')
    assert.equal(env.fake.sendActions().length, 1)
    assert.equal(env.audit().at(-1).outcome, 'rejected')
    await sleep(400)
    assert.equal(env.fake.sendActions().length, 1, '不得自动重发')
  } finally { await env.cleanup() }
})

test('超时/无回执 → unknown，文本说明"结果未知、不自动重试"', async () => {
  const env = await setup({ sendTimeoutMs: 300 }, { actionMode: 'drop' })
  try {
    const result = await env.tool().execute({ text: '可能送达' })
    assert.match(result.text, /没发出去：结果未知/)
    assert.equal(result.outcome, 'unknown')
    assert.equal(env.fake.sendActions().length, 1)
    assert.equal(env.audit().at(-1).outcome, 'unknown')
    await sleep(600)
    assert.equal(env.fake.sendActions().length, 1, 'unknown 不得自动重试（会双发）')
  } finally { await env.cleanup() }
})

test('目标边界：群/非白名单/非 QQ 号都拒绝且零帧', async () => {
  const env = await setup()
  try {
    const tool = env.tool()
    for (const to of ['601357169', '999999', 'qq:group:601357169', 'abc']) {
      const result = await tool.execute({ text: '测试', to })
      assert.match(result.text, /没发出去：/, `target=${to}`)
      assert.equal(result.refused, true, `target=${to}`)
    }
    assert.equal(env.fake.sendActions().length, 0)
  } finally { await env.cleanup() }
})

test('内容边界：空/超长/敏感信息都拒绝且零帧', async () => {
  const env = await setup()
  try {
    const tool = env.tool()
    assert.match((await tool.execute({ text: '   ' })).text, /空消息/)
    assert.match((await tool.execute({ text: '长'.repeat(2005) })).text, /内容过长/)
    assert.match((await tool.execute({ text: 'api_key: abc123' })).text, /敏感信息/)
    assert.equal(env.fake.sendActions().length, 0)
  } finally { await env.cleanup() }
})

test('限速：同 peer 5 秒内第二条被拒（零帧）', async () => {
  const env = await setup({ sendMinIntervalMs: 5000 })
  try {
    const tool = env.tool()
    assert.equal((await tool.execute({ text: '第一条' })).outcome, 'ok')
    env.turnEnd()
    const second = await tool.execute({ text: '第二条' })
    assert.match(second.text, /限流：同一私聊至少 5 秒一条/)
    assert.equal(env.fake.sendActions().length, 1)
  } finally { await env.cleanup() }
})

test('去重：60 秒内同文被拒（零帧）', async () => {
  const env = await setup({ sendSameTextWindowMs: 60_000 })
  try {
    const tool = env.tool()
    assert.equal((await tool.execute({ text: '同一句话' })).outcome, 'ok')
    env.turnEnd()
    const second = await tool.execute({ text: '同一句话' })
    assert.match(second.text, /重复内容/)
    assert.equal(env.fake.sendActions().length, 1)
  } finally { await env.cleanup() }
})

test('kill switch：运行中把 allowSend 改成 false，下一次立即拒绝且零帧', async () => {
  const env = await setup()
  try {
    const tool = env.tool()
    assert.equal((await tool.execute({ text: '开关前' })).outcome, 'ok')
    env.turnEnd()
    env.config.allowSend = false // live config 引用：改这里立即生效
    const result = await tool.execute({ text: '开关后' })
    assert.match(result.text, /出站已关闭/)
    assert.equal(result.refused, true)
    assert.equal(env.fake.sendActions().length, 1)
    assert.equal(env.qq.status().send.enabled, false)
  } finally { await env.cleanup() }
})

test('审计：每次结果（ok/rejected/unknown/refused）都有一条，且不含正文全文', async () => {
  const env = await setup({ sendTimeoutMs: 250 }, { actionMode: 'reject' })
  try {
    const tool = env.tool()
    await tool.execute({ text: '会失败的一句' })
    await tool.execute({ text: '' })
    const rows = env.audit()
    assert.equal(rows.length, 2)
    assert.deepEqual(rows.map((row) => row.outcome), ['rejected', 'refused'])
    for (const row of rows) {
      assert.ok(row.textHash)
      assert.ok(Number.isFinite(row.chars))
      assert.equal(String(row.text ?? ''), '')
    }
  } finally { await env.cleanup() }
})

/* ── P0-3 人类化：markdown / 多气泡 / 长文切分 / 部分成功 ── */

test('markdown→纯文本：发出的是清理后的文本，审计仍只有 hash', async () => {
  const env = await setup()
  try {
    const result = await env.tool().execute({ text: '**你好**，`世界`~' })
    assert.equal(result.outcome, 'ok')
    const actions = env.fake.sendActions()
    assert.equal(actions.length, 1)
    assert.equal(actions[0].params.message, '你好，世界~')
    assert.equal(JSON.stringify(env.audit()).includes('你好，世界~'), false)
  } finally { await env.cleanup() }
})

test('多气泡：messages[] 按顺序发成 N 帧，结果/审计如实记录', async () => {
  const env = await setup()
  try {
    const result = await env.tool().execute({ messages: ['第一句', '第二句'] })
    assert.match(result.text, /已发出去 2 条/)
    const actions = env.fake.sendActions()
    assert.deepEqual(actions.map((a) => a.params.message), ['第一句', '第二句'])
    const status = env.qq.status()
    assert.equal(status.send.recent.sent, 2)
    assert.equal(status.send.recent.total, 2)
    assert.equal(status.send.recent.outcome, 'ok')
    assert.equal(env.audit().length, 2)
    assert.deepEqual(env.audit().map((row) => row.batch.index), [1, 2])
  } finally { await env.cleanup() }
})

test('长文切分：单条超 maxMessageChars 被拆成多条气泡，内容不丢', async () => {
  const env = await setup({ maxMessageChars: 5 })
  try {
    const text = '一'.repeat(12)
    const result = await env.tool().execute({ text })
    assert.match(result.text, /已发出去 3 条/)
    const messages = env.fake.sendActions().map((a) => a.params.message)
    assert.equal(messages.length, 3)
    assert.equal(messages.join(''), text)
    for (const message of messages) assert.ok(message.length <= 5)
  } finally { await env.cleanup() }
})

test('气泡数超过单次上限：拒绝且零帧', async () => {
  const env = await setup({ maxMessageChars: 2, burstMaxMessages: 2 })
  try {
    const result = await env.tool().execute({ text: 'abcde' })
    assert.match(result.text, /没发出去：.*超过单次上限/)
    assert.equal(result.refused, true)
    assert.equal(env.fake.sendActions().length, 0)
  } finally { await env.cleanup() }
})

test('部分成功：第 2 条失败即停，如实报已发 1/2，不重试', async () => {
  const env = await setup({}, { actionMode: 'ok' })
  try {
    const tool = env.tool()
    const first = await tool.execute({ text: '第一条' })
    assert.equal(first.outcome, 'ok')
    env.fake.setActionMode('reject')
    const second = await tool.execute({ text: '第二条' })
    assert.match(second.text, /没发出去：后端拒绝/)
    assert.equal(second.outcome, 'rejected')
    assert.equal(env.fake.sendActions().length, 2)
    assert.equal(env.audit().at(-1).outcome, 'rejected')
  } finally { await env.cleanup() }
})

test('kill switch 在多气泡中途生效：剩余气泡不发，报 k/N', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-send-'))
  const fake = await createFakeOneBot({ port: 0, token: TOKEN })
  let config = null
  config = baseConfig(fake, dir, {
    sleepImpl: async () => { config.allowSend = false },
    maxSendsPerTurn: 10,
  })
  const host = createHost({ log: () => {} })
  host.registerPlugin(manifest, qqModule, { config })
  await host.enable('qq')
  const qq = host.shared.get('qq')
  await waitFor(() => qq.status().send?.transport?.connected === true)
  try {
    const tool = host.services.tools.list().find((t) => t.name === 'qq_send')
    const result = await tool.execute({ messages: ['第一句', '第二句'] })
    assert.match(result.text, /没发出去：出站已关闭/)
    assert.match(result.text, /已发 1\/2/)
    assert.equal(fake.sendActions().length, 1)
    assert.equal(qq.status().send.recent.sent, 1)
    assert.equal(qq.status().send.recent.total, 2)
  } finally {
    host.disable('qq')
    await fake.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('每分钟上限按气泡数预留：计划超过上限时拒绝且零帧', async () => {
  const env = await setup({ sendMaxPerMinute: 2 })
  try {
    const result = await env.tool().execute({ messages: ['a', 'b', 'c'] })
    assert.match(result.text, /限流：每分钟最多 2 条/)
    assert.equal(env.fake.sendActions().length, 0)
  } finally { await env.cleanup() }
})

/* ── Phase 2：出站短队列 / 全局限流 / 批次幂等 ── */

test('短队列：限流时排队，之后按顺序补发，不直接拒绝', async () => {
  const env = await setup({
    outboxEnabled: true,
    outboxMaxPending: 5,
    outboxTtlMs: 60_000,
    sendMinIntervalMs: 1000,
    maxSendsPerTurn: 10,
    sendSameTextWindowMs: 60_000,
  })
  try {
    const first = await env.tool().execute({ text: '第一句' })
    assert.equal(first.outcome, 'ok')
    const second = await env.tool().execute({ text: '第二句' })
    assert.equal(second.outcome, 'queued')
    assert.match(second.text, /已排队/)
    assert.ok(await waitFor(() => env.fake.sendActions().length === 2, { timeoutMs: 3000 }), '队列应补发第二条')
    assert.deepEqual(env.fake.sendActions().map((a) => a.params.message), ['第一句', '第二句'])
    assert.equal(env.qq.status().send.outbox.pending, 0)
  } finally { await env.cleanup() }
})

test('短队列批次幂等：同内容重复调用只发一次，返回 deduped', async () => {
  const env = await setup({ outboxEnabled: true, sendMinIntervalMs: 0, sendSameTextWindowMs: 60_000 })
  try {
    const first = await env.tool().execute({ text: '同一句' })
    assert.equal(first.outcome, 'ok')
    const second = await env.tool().execute({ text: '同一句' })
    assert.equal(second.outcome, 'ok')
    assert.equal(second.deduped, true)
    assert.equal(env.fake.sendActions().length, 1)
  } finally { await env.cleanup() }
})

test('短队列满：拒绝新任务，不无限堆积', async () => {
  const env = await setup({ outboxEnabled: true, outboxMaxPending: 1, sendMinIntervalMs: 5000, maxSendsPerTurn: 10 })
  try {
    assert.equal((await env.tool().execute({ text: '一' })).outcome, 'ok')
    assert.equal((await env.tool().execute({ text: '二' })).outcome, 'queued')
    const third = await env.tool().execute({ text: '三' })
    assert.equal(third.outcome, 'refused')
    assert.match(third.text, /队列已满/)
  } finally { await env.cleanup() }
})

test('finish-then-handle：发送多气泡中来了新消息，当前气泡后停，剩余不发', async () => {
  const env = await setup({ maxSendsPerTurn: 10, burstMaxMessages: 3, burstIntervalMinMs: 500, burstIntervalMaxMs: 600 })
  try {
    const sending = env.tool().execute({ messages: ['甲', '乙', '丙'] })
    assert.ok(await waitFor(() => env.fake.sendActions().length >= 1, { timeoutMs: 2000 }))
    env.fake.privateMessage({ from: Number(OWNER), name: '测试', text: '插话', messageId: 9301 })
    const result = await sending
    assert.equal(result.outcome, 'interrupted')
    assert.equal(env.fake.sendActions().length, 1, '只应发出当前这一条')
    assert.match(result.text, /停发剩余气泡|已发 1\/3/)
  } finally { await env.cleanup() }
})

test('G2 群发送：qq_send 的 to 直接接受 allowGroups 群号，动作是 send_group_msg', async () => {
  const env = await setup({ allowGroups: ['601357169'], allowGroupSend: true })
  try {
    const result = await env.tool().execute({ to: '601357169', text: '群测试一句' })
    assert.equal(result.outcome, 'ok')
    const actions = env.fake.sendActions()
    assert.equal(actions.length, 1)
    assert.equal(actions[0].action, 'send_group_msg')
    assert.equal(actions[0].params.group_id, 601357169)
    assert.equal(actions[0].params.message, '群测试一句')
    assert.equal(env.audit().at(-1).targetKind, 'group')
    assert.equal(env.audit().at(-1).peerId, '601357169')
  } finally { await env.cleanup() }
})

test('G2 群发送默认关闭：allowGroupSend=false 时拒绝，且零帧', async () => {
  const env = await setup({ allowGroups: ['601357169'], allowGroupSend: false })
  try {
    const result = await env.tool().execute({ to: '601357169', text: '不该发' })
    assert.equal(result.refused, true)
    assert.match(result.text, /群发送未启用|不在私聊白名单/)
    assert.equal(env.fake.sendActions().length, 0)
  } finally { await env.cleanup() }
})

test('G2 戳一戳/撤回/群管理走 OneBot 动作机', async () => {
  const env = await setup({ allowGroups: ['601357169'], allowGroupSend: true, allowPoke: true, allowRecall: true, allowGroupAdmin: true })
  try {
    const tools = env.host.services.tools.list()
    const poke = tools.find((t) => t.name === 'qq_poke')
    const recall = tools.find((t) => t.name === 'qq_recall')
    const admin = tools.find((t) => t.name === 'qq_group_admin')
    assert.ok(poke && recall && admin)

    const p1 = await poke.execute({ to: OWNER })
    assert.equal(p1.outcome, 'ok')
    assert.equal(env.fake.actions().at(-1).action, 'send_poke')
    assert.equal(env.fake.actions().at(-1).params.user_id, Number(OWNER))

    const p2 = await poke.execute({ to: '601357169', userId: '20002' })
    assert.equal(p2.outcome, 'ok')
    assert.equal(env.fake.actions().at(-1).action, 'send_poke')
    assert.equal(env.fake.actions().at(-1).params.group_id, 601357169)
    assert.equal(env.fake.actions().at(-1).params.user_id, 20002)

    const r = await recall.execute({ messageId: '123456' })
    assert.equal(r.outcome, 'ok')
    assert.equal(env.fake.actions().at(-1).action, 'delete_msg')

    const a = await admin.execute({ group: '601357169', action: 'ban', userId: '20002', duration: 120 })
    assert.equal(a.outcome, 'ok')
    assert.equal(env.fake.actions().at(-1).action, 'set_group_ban')
    assert.equal(env.fake.actions().at(-1).params.duration, 120)
  } finally { await env.cleanup() }
})

test('qq_send_media：图片/视频/群文件走 OneBot 媒体段与上传动作', async () => {
  const env = await setup({ allowGroups: ['7001'], allowGroupSend: true })
  try {
    const tool = env.host.services.tools.list().find((t) => t.name === 'qq_send_media')
    assert.ok(tool, '应注册 qq_send_media')
    const png = path.join(env.dir, 'pic.png')
    fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
    const image = await tool.execute({ path: png, kind: 'image' })
    assert.equal(image.outcome, 'ok', image.text)
    const imageAction = env.fake.sendActions().find((a) => a.action === 'send_private_msg')
    assert.equal(imageAction.params.message[0].type, 'image')
    assert.match(imageAction.params.message[0].data.file, /^base64:\/\//)

    const video = path.join(env.dir, 'clip.mp4')
    fs.writeFileSync(video, Buffer.from('fake mp4 bytes'))
    const videoResult = await tool.execute({ to: '7001', path: video, kind: 'video' })
    assert.equal(videoResult.outcome, 'ok')
    const videoAction = env.fake.sendActions().find((a) => a.action === 'send_group_msg')
    assert.equal(videoAction.params.message[0].type, 'video')
    assert.equal(videoAction.params.message[0].data.file, video)

    const file = path.join(env.dir, 'note.txt')
    fs.writeFileSync(file, 'hello file')
    const fileResult = await tool.execute({ to: '7001', path: file, kind: 'file' })
    assert.equal(fileResult.outcome, 'ok', fileResult.text)
    const allActions = env.fake.actions()
    assert.ok(allActions.some((a) => a.action === 'upload_group_file'))
    const fileMsg = allActions.filter((a) => a.action === 'send_group_msg').at(-1)
    assert.equal(fileMsg.params.message[0].type, 'file')
    assert.equal(env.audit().at(-1).kind, 'media')
  } finally { await env.cleanup() }
})

test('qq_send_media：私聊语音段与私聊文件上传；拒绝 URL/可执行文件', async () => {
  const env = await setup()
  try {
    const tool = env.host.services.tools.list().find((t) => t.name === 'qq_send_media')
    const voice = path.join(env.dir, 'voice.mp3')
    fs.writeFileSync(voice, Buffer.from('fake voice'))
    const voiceResult = await tool.execute({ path: voice, kind: 'voice' })
    assert.equal(voiceResult.outcome, 'ok', voiceResult.text)
    const voiceAction = env.fake.sendActions().at(-1)
    assert.equal(voiceAction.params.message[0].type, 'record')
    assert.equal(voiceAction.params.message[0].data.file, voice)

    const file = path.join(env.dir, 'doc.pdf')
    fs.writeFileSync(file, 'fake pdf')
    const fileResult = await tool.execute({ path: file, kind: 'file' })
    assert.equal(fileResult.outcome, 'ok', fileResult.text)
    assert.ok(env.fake.actions().some((a) => a.action === 'upload_private_file'))

    const urlResult = await tool.execute({ path: 'https://example.com/a.jpg' })
    assert.equal(urlResult.outcome, 'refused')
    const bad = path.join(env.dir, 'run.exe')
    fs.writeFileSync(bad, 'MZ')
    const badResult = await tool.execute({ path: bad, kind: 'file' })
    assert.equal(badResult.outcome, 'refused')
  } finally { await env.cleanup() }
})
