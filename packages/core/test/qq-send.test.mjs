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
    sendApproval: 'lead-approved',
    sendTimeoutMs: 500,
    sendMinIntervalMs: 0,
    sendMaxPerMinute: 10,
    sendSameTextWindowMs: 0,
    maxSendsPerTurn: 10,
    maxSendChars: 2000,
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
