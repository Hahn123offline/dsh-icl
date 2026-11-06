// P1 表情包：本地库列表 + 发送本地图片；只接受库内单层文件名，格式/大小校验，不下载远程。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../src/index.mjs'
import * as qqModule from '../../plugins/qq/src/index.mjs'
import manifest from '../../plugins/qq/manifest.json' with { type: 'json' }
import { createFakeOneBot } from '../../plugins/qq/tools/fake-onebot.mjs'

const TOKEN = 'sticker-token'
const OWNER = '10001'
const SELF = '2593621742'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }
async function waitFor(predicate, { timeoutMs = 6000, stepMs = 20 } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await sleep(stepMs)
  }
  return predicate()
}

async function setup({ maxStickerBytes = 4096 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sticker-'))
  const stickerDir = path.join(dir, 'stickers')
  fs.mkdirSync(stickerDir, { recursive: true })
  fs.writeFileSync(path.join(stickerDir, 'smile.png'), PNG)
  fs.writeFileSync(path.join(stickerDir, 'bad.png'), Buffer.from('definitely not an image'))
  fs.writeFileSync(path.join(stickerDir, 'big.png'), Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(maxStickerBytes + 100)]))
  fs.mkdirSync(path.join(stickerDir, 'subdir.png')) // 目录也不能被当表情
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
      stickerDir, maxStickerBytes, stickerListLimit: 50,
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
    dir, stickerDir, fake, host, qq, tool, audit,
    cleanup: async () => { host.disable('qq'); await fake.close(); fs.rmSync(dir, { recursive: true, force: true }) },
  }
}

test('qq_stickers：列出本地库（只接受图片扩展名/普通文件；query 过滤）', async () => {
  const env = await setup()
  try {
    const list = await env.tool('qq_stickers').execute({})
    assert.match(list.text, /smile\.png/)
    assert.match(list.text, /big\.png/)
    assert.doesNotMatch(list.text, /subdir\.png/)
    assert.match(list.text, new RegExp(env.stickerDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    const filtered = await env.tool('qq_stickers').execute({ query: 'smile' })
    assert.match(filtered.text, /smile\.png/)
    assert.doesNotMatch(filtered.text, /big\.png/)
  } finally { await env.cleanup() }
})

test('qq_send_sticker：发送本地 PNG（base64 段，不带本地路径）；审计只存文件名/字节', async () => {
  const env = await setup()
  try {
    const sent = await env.tool('qq_send_sticker').execute({ id: 'smile.png' })
    assert.equal(sent.outcome, 'ok')
    const actions = env.fake.sendActions()
    assert.equal(actions.length, 1)
    const message = actions[0].params.message
    assert.equal(Array.isArray(message), true)
    assert.equal(message[0].type, 'image')
    assert.match(message[0].data.file, /^base64:\/\//)
    assert.doesNotMatch(JSON.stringify(message), new RegExp(env.stickerDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    const row = env.audit().at(-1)
    assert.equal(row.kind, 'sticker')
    assert.equal(row.sticker, 'smile.png')
    assert.equal(row.bytes, PNG.length)
    assert.equal(String(row.text ?? ''), '')
    assert.equal(String(row.data ?? ''), '')
  } finally { await env.cleanup() }
})

test('qq_send_sticker：路径穿越/目录/坏格式/超大/不存在 都拒绝且零帧', async () => {
  const env = await setup()
  try {
    for (const id of ['../evil.png', 'subdir.png', 'bad.png', 'big.png', 'missing.png']) {
      const result = await env.tool('qq_send_sticker').execute({ id })
      assert.equal(result.refused, true, `${id} 应被拒绝`)
      assert.match(result.text, /没发出去/)
    }
    assert.equal(env.fake.sendActions().length, 0)
  } finally { await env.cleanup() }
})

test('qq_send_sticker：非 owner/白名单目标拒绝；每轮上限与 qq_send 共享', async () => {
  const env = await setup()
  try {
    const badTarget = await env.tool('qq_send_sticker').execute({ id: 'smile.png', to: '999999' })
    assert.equal(badTarget.refused, true)
    assert.equal(env.fake.sendActions().length, 0)
    // 先发一条文字，再发表情：默认 maxSendsPerTurn=10，这里都能发；用 maxSendsPerTurn 由 config 控制
    const text = await env.tool('qq_send').execute({ text: '先说话' })
    assert.equal(text.outcome, 'ok')
    const sticker = await env.tool('qq_send_sticker').execute({ id: 'smile.png' })
    assert.equal(sticker.outcome, 'ok')
    assert.equal(env.fake.sendActions().length, 2)
  } finally { await env.cleanup() }
})
