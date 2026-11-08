// P1-10/P1-15（F1/F3）+ A2/B1/B2（QQ 部分）：
//   · qq_help 按需策略（不进静态 system 段）；
//   · 说话人信封：正文前缀 + meta.qq.envelope（owner / 白名单 / 补课）；
//   · qq_status/qq_send 的工具描述承载"何时该回/不发群"等关键约束（工具描述不是静态提示词）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../src/index.mjs'
import * as qqModule from '../../plugins/qq/src/index.mjs'
import manifest from '../../plugins/qq/manifest.json' with { type: 'json' }
import { createFakeOneBot } from '../../plugins/qq/tools/fake-onebot.mjs'

const TOKEN = 'envelope-token'
const OWNER = '10001'
const OTHER = '10002'
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

async function setup({ overrides = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-envelope-'))
  const fake = await createFakeOneBot({ port: 0, token: TOKEN })
  const host = createHost({ log: () => {} })
  host.registerPlugin(manifest, qqModule, {
    config: {
      enabled: true, url: `ws://127.0.0.1:${fake.port}/`, token: TOKEN, selfId: SELF,
      allowPrivate: [OWNER], ownerQQ: OWNER,
      ledgerFile: path.join(dir, 'ledger.db'),
      ...overrides,
    },
  })
  await host.enable('qq')
  const qq = host.shared.get('qq')
  await waitFor(() => qq.status().connection.connected === true)
  const tool = (name) => host.services.tools.list().find((t) => t.name === name)
  return {
    dir, fake, host, qq, tool,
    drain: () => host.services.delivery.drain('session').map((b) => b.text),
    cleanup: async () => {
      host.disable('qq')
      await fake.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('说话人信封：owner 私聊正文带 [QQ私聊·主人]，meta 有结构化来源', async () => {
  const env = await setup()
  try {
    env.fake.privateMessage({ from: OWNER, name: '主人', text: '在吗', messageId: 7001 })
    await waitFor(() => env.qq.status().ledger.messages >= 1)
    const texts = env.drain()
    assert.equal(texts.length, 1)
    assert.match(texts[0], /^\[QQ私聊·主人\] 主人：在吗/)
    const recent = env.qq.status().stats.recent.lastAccepted
    assert.equal(recent.envelope.channel, 'qq')
    assert.equal(recent.envelope.scope, 'private')
    assert.equal(recent.envelope.senderKind, 'owner')
    assert.equal(recent.envelope.peerId, OWNER)
    assert.equal(recent.envelope.senderName, '主人')
    assert.equal(recent.envelope.backfilled, false)
    assert.equal(recent.envelope.messageId, '7001')
  } finally { await env.cleanup() }
})

test('说话人信封：白名单非 owner 带 [QQ私聊]（不冒充主人）', async () => {
  const env = await setup({ overrides: { allowPrivate: [OWNER, OTHER] } })
  try {
    env.fake.privateMessage({ from: OTHER, name: '朋友', text: '嗨', messageId: 7002 })
    await waitFor(() => env.qq.status().ledger.messages >= 1)
    const texts = env.drain()
    assert.match(texts[0], /^\[QQ私聊\] 朋友：嗨/)
    assert.equal(env.qq.status().stats.recent.lastAccepted.envelope.senderKind, 'allowlisted')
  } finally { await env.cleanup() }
})

test('说话人信封可关闭（senderEnvelope:false 回到裸正文）', async () => {
  const env = await setup({ overrides: { senderEnvelope: false } })
  try {
    env.fake.privateMessage({ from: OWNER, name: '主人', text: '裸正文', messageId: 7003 })
    await waitFor(() => env.qq.status().ledger.messages >= 1)
    const texts = env.drain()
    assert.equal(texts[0], '主人：裸正文')
    assert.equal(env.qq.status().stats.recent.lastAccepted.envelope, null)
  } finally { await env.cleanup() }
})

test('qq_help：按需读策略（不进静态 system 段）；列表/全文/未知条目', async () => {
  const env = await setup()
  try {
    // 默认 promptLine=false：不注册任何 qq 静态提示词段（skill 只在工具里按需读）
    assert.equal(env.host.services.prompt.names().some((n) => String(n).startsWith('qq')), false)
    const help = env.tool('qq_help')
    assert.ok(help, 'qq_help 应该存在')
    const list = await help.execute({})
    assert.match(list.text, /reply/)
    assert.match(list.text, /何时回/)
    const full = await help.execute({ skill: 'reply' })
    assert.match(full.text, /什么时候该回/)
    assert.match(full.text, /群消息/)
    assert.match(full.text, /结果未知/)
    const missing = await help.execute({ skill: 'nope' })
    assert.match(missing.text, /没有这个条目/)
    const viaShared = await env.qq.help('reply')
    assert.match(viaShared, /QQ 聊天策略/)
    assert.deepEqual(env.qq.skills().map((s) => s.id), ['reply'])
  } finally { await env.cleanup() }
})

test('工具描述承载边界：qq_status/qq_send 写清"群能力/何时回/按需 help"', async () => {
  const env = await setup()
  try {
    const status = env.tool('qq_status')
    assert.match(status.summary ?? '', /QQ/)
    assert.match(status.summary ?? '', /群/)
    assert.match((status.avoid ?? []).join(' '), /群/)
    assert.match((status.avoid ?? []).join(' '), /qq_send/)
    // qq_send 只在三把钥匙打开时注册；这里至少验证 qq_help 的"何时用"指向它
    const help = env.tool('qq_help')
    assert.match((help.when ?? []).join(' '), /补课|积压|信封/)
    assert.match((help.avoid ?? []).join(' '), /qq_send|qq_status/)
  } finally { await env.cleanup() }
})
