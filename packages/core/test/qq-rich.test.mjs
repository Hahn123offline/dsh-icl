// P0-2 入站富内容纯函数层 + 插件接线；以及 QQ×focus 语义（私聊默认 ambient）。
//
// 覆盖：段→文本（图片/文件/转发/引用/表情/@）、媒体/文件/转发 id 提取、
// 引用慢取（get_msg 归属校验 + pending + 缓存）、转发展开（嵌套/上限）、
// 图片安全抓取（协议/内网/大小/类型）、插件集成（富消息进 delivery）、
// focus：普通私聊被拦进积压；显式 @ 才穿。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../src/index.mjs'
import * as qqModule from '../../plugins/qq/src/index.mjs'
import manifest from '../../plugins/qq/manifest.json' with { type: 'json' }
import { createFakeOneBot } from '../../plugins/qq/tools/fake-onebot.mjs'
import { segmentsToText, extractMedia, extractFiles, extractForwardIds, extractReplyId, hasAtSelf, sanitizeForwardId, fileInfoOf } from '../../plugins/qq/src/rich.mjs'
import { createReplyResolver, createSlowFetchCache, pendingReplyText, replyContextText } from '../../plugins/qq/src/reply-cache.mjs'
import { createInboundGate } from '../../plugins/qq/src/gate.mjs'
import { formatForwardNodes, expandForwardIds, normalizeForwardData } from '../../plugins/qq/src/forward.mjs'
import { assertSafeHttpUrl, safeFetchBuffer, acceptImageBuffer, sniffImageMime, fetchImageMedia, isSafeMediaFileRef, describeFile } from '../../plugins/qq/src/media.mjs'

const TOKEN = 'rich-token'
const OWNER = '10001'
const SELF = '2593621742'
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }
async function waitFor(predicate, { timeoutMs = 6000, stepMs = 20 } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await sleep(stepMs)
  }
  return predicate()
}

const richSegments = [
  { type: 'image', data: { url: 'https://example.com/a.png', file: 'abc.image', summary: '表情' } },
  { type: 'file', data: { name: '报告.pdf', file_size: 12_288, file_id: 'f-1', busid: 102 } },
  { type: 'reply', data: { id: '9001' } },
  { type: 'forward', data: { id: 'fwd-1' } },
  { type: 'text', data: { text: '看这个' } },
]

function message({ from = OWNER, segments = [{ type: 'text', data: { text: '在吗' } }], messageId = 1, time = Math.floor(Date.now() / 1000) } = {}) {
  return {
    post_type: 'message', message_type: 'private', sub_type: 'friend', time,
    self_id: SELF, user_id: Number(from), message_id: messageId,
    message: segments, raw_message: '',
    sender: { user_id: Number(from), nickname: '测试' },
  }
}

test('段→文本：图片/文件/引用/转发/表情/@/markdown 都有可读占位', () => {
  const text = segmentsToText([
    { type: 'image', data: { url: 'https://x/y.png' } },
    { type: 'file', data: { name: '报告.pdf', file_size: 12_288 } },
    { type: 'reply', data: { id: '1' } },
    { type: 'forward', data: { id: 'fwd:1' } },
    { type: 'face', data: { id: '14' } },
    { type: 'mface', data: { summary: '开心' } },
    { type: 'at', data: { qq: SELF } },
    { type: 'markdown', data: { content: '**粗**' } },
    { type: 'text', data: { text: '看这个' } },
  ])
  assert.match(text, /\[图片\]/)
  assert.match(text, /\[文件：报告\.pdf（12\.0KB）\]/)
  assert.match(text, /\[引用\]/)
  assert.match(text, /\[合并转发 id=fwd:1\]/)
  assert.match(text, /\[表情14\]/)
  assert.match(text, /\[表情:开心\]/)
  assert.match(text, new RegExp(`@${SELF}`))
  assert.match(text, /\*\*粗\*\*/)
  assert.match(text, /看这个$/)
})

test('提取：媒体/文件/转发 id/引用 id/@自己；转发 id 只留安全字符', () => {
  assert.equal(extractMedia(richSegments).length, 1)
  assert.equal(extractMedia(richSegments)[0].kind, 'image')
  const files = extractFiles(richSegments)
  assert.equal(files.length, 1)
  assert.equal(files[0].name, '报告.pdf')
  assert.equal(files[0].size, 12_288)
  assert.equal(files[0].busid, 102)
  assert.deepEqual(extractForwardIds(richSegments), ['fwd-1'])
  assert.equal(extractReplyId(richSegments), '9001')
  assert.equal(hasAtSelf([{ type: 'at', data: { qq: SELF } }], SELF), true)
  assert.equal(sanitizeForwardId('bad id!'), '')
  assert.equal(fileInfoOf({ type: 'file', data: { name: '../../x', file_size: 3 } }).name, '.._.._x')
})

test('闸门产出的 signal.meta.qq 带 media/files/forwardIds/replyId；text 是富占位', () => {
  const gate = createInboundGate({ selfId: SELF, allowPrivate: [OWNER] })
  const decision = gate.admit(message({ segments: richSegments }), { receivedAt: Date.now() })
  assert.equal(decision.accept, true)
  assert.match(decision.signal.text, /\[图片\]/)
  assert.match(decision.signal.text, /\[文件：报告\.pdf（12\.0KB）\]/)
  assert.match(decision.signal.text, /\[合并转发 id=fwd-1\]/)
  assert.equal(decision.signal.meta.qq.media.length, 1)
  assert.equal(decision.signal.meta.qq.files[0].name, '报告.pdf')
  assert.deepEqual(decision.signal.meta.qq.forwardIds, ['fwd-1'])
  assert.equal(decision.signal.meta.qq.replyId, '9001')
  assert.deepEqual(decision.signal.tags, ['qq', 'private'])
})

test('引用慢取：命中 get_msg 并校验归属；超时返回 pending，后台完成后可再取', async () => {
  const calls = []
  const raw = { message_id: 9001, sender: { user_id: Number(OWNER), nickname: '测试' }, message: [{ type: 'text', data: { text: '原话在这' } }] }
  const http = { ok: true, async call(action, params) { calls.push({ action, params }); return raw } }
  const resolver = createReplyResolver({ http })
  const info = await resolver.resolve('9001', { peerId: OWNER, selfId: SELF, waitMs: 100 })
  assert.equal(info.sender, '测试')
  assert.equal(info.text, '原话在这')
  assert.equal(calls.length, 1)
  await resolver.resolve('9001', { peerId: OWNER, selfId: SELF, waitMs: 100 })
  assert.equal(calls.length, 1, '第二次命中缓存')
  assert.equal(replyContextText(info), '[引用 测试：原话在这]')
  assert.match(pendingReplyText('9001'), /引用消息 id=9001/)

  // 归属不符：群消息 / 别人发的 → null
  const bad = createReplyResolver({ http: { ok: true, async call() { return { ...raw, group_id: 123 } } } })
  assert.equal(await bad.resolve('9001', { peerId: OWNER, waitMs: 100 }), null)
  const wrongSender = createReplyResolver({ http: { ok: true, async call() { return { ...raw, sender: { user_id: 999 } } } } })
  assert.equal(await wrongSender.resolve('9001', { peerId: OWNER, waitMs: 100 }), null)

  // pending：后台慢，等 10ms 先占位；之后缓存命中
  const slow = createReplyResolver({
    http: { ok: true, call: async () => { await sleep(80); return raw } },
  })
  const pending = await slow.resolve('9001', { peerId: OWNER, waitMs: 10 })
  assert.equal(pending.pending, true)
  await sleep(120)
  const later = await slow.resolve('9001', { peerId: OWNER, waitMs: 10 })
  assert.equal(later.text, '原话在这')
})

test('慢取缓存：并发去重，失败负缓存短 TTL', async () => {
  let calls = 0
  const cache = createSlowFetchCache({
    fetch: async (key) => { calls += 1; await sleep(20); return `v:${key}` },
    ttlMs: 1000, negativeTtlMs: 10,
  })
  const [a, b] = await Promise.all([cache.get('k', { waitMs: 100 }), cache.get('k', { waitMs: 100 })])
  assert.equal(a, 'v:k')
  assert.equal(b, 'v:k')
  assert.equal(calls, 1)
})

test('转发展开：节点形状兼容、嵌套限深、条数/字数上限', async () => {
  const data = {
    messages: [
      { sender: { card: '甲' }, time: 1_700_000_000, message: [{ type: 'text', data: { text: '第一句' } }] },
      { sender: { nickname: '乙' }, message: [{ type: 'text', data: { text: '第二句' } }, { type: 'forward', data: { id: 'nested-1' } }] },
    ],
  }
  const formatted = formatForwardNodes(data, { maxItems: 12, maxChars: 1200 })
  assert.equal(formatted.lines.length, 2)
  assert.match(formatted.lines[0], /甲/)
  assert.match(formatted.lines[0], /第一句/)
  assert.deepEqual(formatted.nestedIds, ['nested-1'])
  const capped = formatForwardNodes(data, { maxItems: 1 })
  assert.equal(capped.lines.length, 1)
  assert.equal(capped.truncated, true)
  assert.equal(normalizeForwardData([{ type: 'node', data: { message: [{ type: 'text', data: { text: 'x' } }] } }]).length, 1)

  const store = new Map([
    ['fwd-1', { messages: [{ sender: { card: '丙' }, message: [{ type: 'text', data: { text: '展开我' } }, { type: 'forward', data: { id: 'nested-1' } }] }] }],
    ['nested-1', { messages: [{ sender: { card: '丁' }, message: [{ type: 'text', data: { text: '嵌套内容' } }] }] }],
  ])
  const expanded = await expandForwardIds(['fwd-1'], { fetchForward: async (id) => store.get(id), maxDepth: 2 })
  assert.match(expanded, /【转发展开 fwd-1】/)
  assert.match(expanded, /展开我/)
  assert.match(expanded, /嵌套内容/)
})

test('图片安全抓取：协议/内网/大小/类型；get_image 兜底', async () => {
  assert.throws(() => assertSafeHttpUrl('file:///C:/x.png'), /协议/)
  assert.throws(() => assertSafeHttpUrl('http://127.0.0.1/x.png'), /内网/)
  assert.throws(() => assertSafeHttpUrl('http://localhost/x.png'), /内网/)
  assert.throws(() => assertSafeHttpUrl('http://192.168.1.2/x.png'), /内网/)
  assert.throws(() => assertSafeHttpUrl('http://u:p@example.com/x.png'), /账号密码/)
  assert.equal(assertSafeHttpUrl('https://example.com/a.png').hostname, 'example.com')

  assert.equal(sniffImageMime(TINY_PNG), 'image/png')
  assert.throws(() => acceptImageBuffer(Buffer.from('not an image')), /不是支持的图片/)
  assert.throws(() => acceptImageBuffer(TINY_PNG, { maxBytes: 10 }), /超限/)

  const okFetch = async () => ({ ok: true, status: 200, headers: { get: () => String(TINY_PNG.length) }, arrayBuffer: async () => TINY_PNG })
  const fetched = await safeFetchBuffer('https://example.com/a.png', { fetchImpl: okFetch })
  assert.equal(fetched.bytes, TINY_PNG.length)
  const bigFetch = async () => ({ ok: true, status: 200, headers: { get: () => '999999999' }, arrayBuffer: async () => TINY_PNG })
  await assert.rejects(() => safeFetchBuffer('https://example.com/a.png', { fetchImpl: bigFetch, maxBytes: 100 }), /超限/)
  await assert.rejects(() => safeFetchBuffer('https://example.com/a.png', { fetchImpl: async () => { throw new Error('boom') } }), /boom/)

  const viaGetImage = await fetchImageMedia({ file: 'abc.image', url: '' }, { getImage: async () => ({ base64: TINY_PNG.toString('base64') }) })
  assert.equal(viaGetImage.source, 'get_image')
  assert.equal(viaGetImage.mimeType, 'image/png')
  assert.equal(isSafeMediaFileRef('abc.image'), true)
  assert.equal(isSafeMediaFileRef('../x.png'), false)
  assert.equal(describeFile({ name: 'a.pdf', size: 2048 }), '[文件：a.pdf（2.0KB）]')
})

test('插件集成：富消息（图/文件/引用/转发）进 delivery，引用与转发展开可见', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-rich-'))
  const fake = await createFakeOneBot({ port: 0, token: TOKEN })
  const host = createHost({ log: () => {} })
  host.registerPlugin(manifest, qqModule, {
    config: {
      enabled: true, url: `ws://127.0.0.1:${fake.port}/`, token: TOKEN, selfId: SELF,
      allowPrivate: [OWNER], ownerQQ: OWNER,
      httpUrl: fake.httpUrl, ledgerFile: path.join(dir, 'ledger.db'),
      replyIngestWaitMs: 1000,
    },
  })
  await host.enable('qq')
  const qq = host.shared.get('qq')
  try {
    await waitFor(() => qq.status().connection.connected === true)
    // 被引用的原消息（进 messageStore，供 get_msg）
    fake.privateMessage({ from: OWNER, text: '原话在这', messageId: 9001 })
    await waitFor(() => qq.status().ledger.messages >= 1)
    host.services.delivery.drain('session').forEach((b) => host.services.delivery.ack(b.id))
    // 一份合并转发
    fake.addForward('fwd-1', { messages: [{ sender: { card: '甲' }, message: [{ type: 'text', data: { text: '转发内容' } }] }] })
    fake.privateRichMessage({
      from: OWNER, name: '测试', messageId: 9100,
      segments: [
        { type: 'image', data: { url: 'https://example.com/a.png', file: 'abc.image' } },
        { type: 'file', data: { name: '报告.pdf', file_size: 12_288, file_id: 'f-1' } },
        { type: 'reply', data: { id: '9001' } },
        { type: 'forward', data: { id: 'fwd-1' } },
        { type: 'text', data: { text: '你看下' } },
      ],
    })
    const ok = await waitFor(() => qq.status().ledger.messages >= 2 && qq.status().stats.delivered >= 2)
    assert.equal(ok, true, JSON.stringify({ ledger: qq.status().ledger, gap: qq.status().gap }))
    const text = host.services.delivery.drain('session').map((b) => b.text).join('\n')
    assert.match(text, /\[图片\]/)
    assert.match(text, /\[文件：报告\.pdf（12\.0KB）\]/)
    assert.match(text, /\[引用 测试：原话在这\]/)
    assert.match(text, /【转发展开 fwd-1】/)
    assert.match(text, /转发内容/)
    assert.match(text, /你看下/)
  } finally {
    host.disable('qq')
    await fake.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('私聊默认 ambient：不自动授予 mention/admin/alarm/safety；显式 @ 才加 at', async () => {
  // 纯函数：sender 即使是 owner，也不能靠"私聊"拿到穿透权
  const { buildPrivateSignal } = await import('../../plugins/qq/src/normalize.mjs')
  const base = {
    peerId: OWNER, senderId: OWNER, senderName: '测试', text: '普通一句',
    segments: [{ type: 'text', text: '普通一句' }], messageId: '1', sentAt: Date.now(), receivedAt: Date.now(),
  }
  const ambient = buildPrivateSignal(base)
  assert.deepEqual(ambient.tags, ['qq', 'private'])
  for (const tag of ['mention', 'admin', 'alarm', 'safety']) assert.equal(ambient.tags.includes(tag), false)
  const mentioned = buildPrivateSignal({ ...base, messageId: '2', rich: { atSelf: true } })
  assert.deepEqual(mentioned.tags, ['qq', 'private', 'at'])
  // 反向：普通私聊即使被重放/补课，也不会被自动加上 admin
  const backfilled = buildPrivateSignal({ ...base, messageId: '3', rich: { atSelf: false } })
  assert.equal(backfilled.tags.includes('admin'), false)
})

test('focus 契约：普通私聊被拦/@ 穿；admin/alarm 仍 privileged；sacred 全拦', () => {
  const host = createHost({ log: () => {} })
  const lease = host.services.focus.enter({ label: 'act:write', owner: 'test' })
  const offer = (id, tags) => host.services.signals.offer({
    id, from: { plugin: 'qq' }, kind: 'notice', text: id, focus: `qq:private:${OWNER}`, tags,
  })
  assert.equal(offer('plain', ['qq', 'private']).accepted, true)
  assert.deepEqual(host.services.delivery.drain('session'), [], '普通私聊不能穿')
  assert.equal(offer('at', ['qq', 'private', 'at']).accepted, true)
  assert.deepEqual(host.services.delivery.drain('session').map((b) => b.text), ['at'])
  assert.equal(offer('admin', ['qq', 'private', 'admin']).accepted, true)
  assert.deepEqual(host.services.delivery.drain('session').map((b) => b.text), ['admin'])
  assert.equal(offer('alarm', ['qq', 'private', 'alarm']).accepted, true)
  assert.deepEqual(host.services.delivery.drain('session').map((b) => b.text), ['alarm'])
  lease.release()

  const sacred = host.services.focus.enter({ label: 'act:deep', owner: 'test', interruptible: false })
  host.services.delivery.drain('session').forEach((b) => host.services.delivery.ack(b.id))
  assert.equal(offer('at-sacred', ['qq', 'private', 'at']).accepted, true)
  assert.deepEqual(host.services.delivery.drain('session'), [], 'sacred 不因 @ 放行')
  assert.equal(offer('admin-sacred', ['qq', 'private', 'admin']).accepted, true)
  assert.deepEqual(host.services.delivery.drain('session').map((b) => b.text), ['admin-sacred'])
  sacred.release()
})

test('QQ×focus：普通私聊默认 ambient 被拦进积压；显式 @ 自己才穿透', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-focus-'))
  const fake = await createFakeOneBot({ port: 0, token: TOKEN })
  const host = createHost({ log: () => {} })
  host.registerPlugin(manifest, qqModule, {
    config: {
      enabled: true, url: `ws://127.0.0.1:${fake.port}/`, token: TOKEN, selfId: SELF,
      allowPrivate: [OWNER], ownerQQ: OWNER, ledgerFile: path.join(dir, 'ledger.db'),
      richEnabled: false,
    },
  })
  await host.enable('qq')
  const qq = host.shared.get('qq')
  try {
    await waitFor(() => qq.status().connection.connected === true)
    const lease = host.services.focus.enter({ label: 'act:write', owner: 'test' })
    fake.privateMessage({ from: OWNER, text: '普通私聊', messageId: 9200 })
    await sleep(80)
    assert.deepEqual(host.services.delivery.drain('session'), [], '普通私聊不应穿透 focus')
    assert.equal(host.services.focus.backlog().reduce((n, row) => n + row.count, 0), 1)
    // 显式 @ 自己：tags 带 at，按默认 pierce(mention) 穿透
    fake.privateRichMessage({ from: OWNER, messageId: 9201, segments: [
      { type: 'at', data: { qq: SELF } },
      { type: 'text', data: { text: '叫你一下' } },
    ] })
    await waitFor(() => qq.status().ledger.messages >= 2)
    await sleep(50)
    const texts = host.services.delivery.drain('session').map((b) => b.text)
    assert.ok(texts.some((t) => t.includes('叫你一下')), `@ 应该穿透，实际=${JSON.stringify(texts)}`)
    lease.release()
  } finally {
    host.disable('qq')
    await fake.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
