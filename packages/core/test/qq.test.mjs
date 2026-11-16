// qq 只读入站影子：规范化 / 准入闸门 / 去重 / 不发送 / 与 signals+delivery 的接线。
//
// 三层证据：
//   1. 纯函数层：OneBot 事件 → signal 的形状与准入判断
//   2. 插件层：假 WebSocket 注入，断言消息进了 delivery、群/陌生人/重复被挡、客户端零出站帧
//   3. 回环层：真 WebSocket（Node 全局）+ 假 OneBot 服务，证明"连得上、收得到、不发"
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../src/index.mjs'
import * as qqModule from '../../plugins/qq/src/index.mjs'
import manifest from '../../plugins/qq/manifest.json' with { type: 'json' }
import * as timeModule from '../../plugins/time/src/index.mjs'
import timeManifest from '../../plugins/time/manifest.json' with { type: 'json' }
import * as focusModule from '../../plugins/focus/src/index.mjs'
import focusManifest from '../../plugins/focus/manifest.json' with { type: 'json' }
import { activityIdForPrivate, messageIdOf, normalizeSegments, buildPrivateSignal, sentAtOf } from '../../plugins/qq/src/normalize.mjs'
import { createDedupeStore, createInboundGate } from '../../plugins/qq/src/gate.mjs'
import { checkSendTarget, sendEnabled } from '../../plugins/qq/src/outbound.mjs'
import { discoverOneBotEndpoint } from '../../plugins/qq/src/connector.mjs'
import { createFakeOneBot } from '../../plugins/qq/tools/fake-onebot.mjs'

const NOW = 1_800_000_000_000

function privateEvent({
  from = 10001, name = '测试', text = '在吗', messageId = 5001,
  time = Math.floor(NOW / 1000), selfId = 2593621742, message = null,
} = {}) {
  return {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    time,
    self_id: selfId,
    user_id: from,
    message_id: messageId,
    message: message ?? [{ type: 'text', data: { text } }],
    raw_message: text,
    sender: { user_id: from, nickname: name },
  }
}

function groupEvent({ groupId = 601357169, text = '群里说话' } = {}) {
  return {
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    time: Math.floor(NOW / 1000),
    self_id: 2593621742,
    group_id: groupId,
    user_id: 10001,
    message_id: 7001,
    message: [{ type: 'text', data: { text } }],
    raw_message: text,
    sender: { user_id: 10001, nickname: '测试' },
  }
}

class FakeWebSocket {
  static instances = []
  static last() { return FakeWebSocket.instances[FakeWebSocket.instances.length - 1] ?? null }
  static reset() { FakeWebSocket.instances = [] }
  constructor(url) {
    this.url = String(url)
    this.listeners = new Map()
    this.sent = []
    this.closed = false
    FakeWebSocket.instances.push(this)
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(fn)
  }
  emit(type, event) {
    for (const fn of this.listeners.get(type) ?? []) fn(event)
  }
  send(data) { this.sent.push(data) }
  close() {
    if (this.closed) return
    this.closed = true
    this.emit('close', { code: 1000 })
  }
}

function eventFrame(event) {
  return { data: JSON.stringify(event) }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

async function waitFor(predicate, { timeoutMs = 3000, stepMs = 20 } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await sleep(stepMs)
  }
  return predicate()
}

function makePluginConfig(overrides = {}) {
  return {
    enabled: true,
    url: 'ws://127.0.0.1:3001/',
    token: 'test-token',
    selfId: '2593621742',
    allowPrivate: ['10001'],
    retryTickMs: 20,
    webSocketImpl: FakeWebSocket,
    ...overrides,
  }
}

/* ── 1. 纯函数层 ─────────────────────────────────────── */

test('规范化：私聊 → activity/text/tags/id，时间用消息自己的', () => {
  const ev = privateEvent({ text: '晚上开会吗', messageId: 4242 })
  const segments = normalizeSegments(ev.message, ev.raw_message)
  assert.equal(segments.text, '晚上开会吗')
  assert.equal(activityIdForPrivate('10001'), 'qq:private:10001')
  assert.equal(messageIdOf(ev), '4242')
  assert.equal(sentAtOf(ev), NOW)
  const signal = buildPrivateSignal({
    peerId: '10001', senderId: '10001', senderName: '测试',
    text: segments.text, segments: segments.segments, messageId: '4242', sentAt: NOW, receivedAt: NOW,
  })
  assert.equal(signal.id, 'qq:private:10001:4242')
  assert.equal(signal.from.plugin, 'qq')
  assert.equal(signal.from.activity, 'qq:private:10001')
  assert.equal(signal.focus, 'qq:private:10001')
  assert.equal(signal.text, '测试：晚上开会吗')
  assert.deepEqual(signal.tags, ['qq', 'private'])
  assert.equal(signal.createdAt, NOW)
  assert.equal(signal.meta.qq.messageId, '4242')
})

test('规范化：非文本段变占位，不塞二进制', () => {
  const ev = privateEvent({ message: [{ type: 'image', data: { url: 'https://x/y.png' } }, { type: 'text', data: { text: '看图' } }] })
  const { text, segments } = normalizeSegments(ev.message, ev.raw_message)
  assert.equal(text, '[图片]看图')
  assert.equal(segments[0].type, 'image')
  assert.equal(segments[0].ref, 'https://x/y.png')
})

test('准入：群消息整类拒绝，临时会话拒绝，自发拒绝', () => {
  const gate = createInboundGate({ now: () => NOW, allowPrivate: ['10001'], selfId: '2593621742' })
  assert.equal(gate.admit(groupEvent()).code, 'group')
  assert.equal(gate.admit({ ...privateEvent(), message_type: 'guild' }).code, 'unsupported-message-type')
  assert.equal(gate.admit(privateEvent({ from: 2593621742 })).code, 'self')
})

test('准入：friends 策略只放行 QQ 好友（加好友=白名单）', () => {
  const gate = createInboundGate({ now: () => NOW, allowPrivate: ['10001'], privatePolicy: 'friends', selfId: '2593621742' })
  gate.setFriends(['20002'])
  assert.equal(gate.admit(privateEvent({ from: 20002, messageId: 6001 })).accept, true)
  assert.equal(gate.admit(privateEvent({ from: 30003, messageId: 6002 })).code, 'not-allowlisted')
  assert.equal(gate.admit(privateEvent({ from: 10001, messageId: 6003 })).accept, true, 'allowPrivate 兜底仍有效')
  gate.setFriends([])
  assert.equal(gate.admit(privateEvent({ from: 20002, messageId: 6004 })).code, 'not-allowlisted')
})

test('准入：白名单为空 = 一个都不收（默认安全）', () => {
  const gate = createInboundGate({ now: () => NOW })
  const out = gate.admit(privateEvent())
  assert.equal(out.accept, false)
  assert.equal(out.code, 'not-allowlisted')
})

test('准入：blockedSenders 永不接收（好友/白名单也不行）', () => {
  const gate = createInboundGate({ now: () => NOW, allowPrivate: ['30003'], privatePolicy: 'friends', blockedSenders: ['30003'], allowGroups: ['601357169'], groupPolicy: 'allowlist' })
  gate.setFriends(['30003'])
  assert.equal(gate.admit(privateEvent({ from: 30003, messageId: 6101 })).code, 'blocked-sender')
  const group = { ...groupEvent(), group_id: 601357169, user_id: 30003, message_id: 6102, message: [{ type: 'text', data: { text: '群消息' } }], sender: { user_id: 30003, nickname: '设备' } }
  assert.equal(gate.admit(group).code, 'blocked-sender')
})

test('准入：同一条消息第二次 = duplicate，id 稳定', () => {
  const gate = createInboundGate({ now: () => NOW, allowPrivate: ['10001'] })
  const first = gate.admit(privateEvent())
  assert.equal(first.accept, true)
  const second = gate.admit(privateEvent())
  assert.equal(second.accept, false)
  assert.equal(second.code, 'duplicate')
  assert.equal(first.signal.id, second.signal?.id ?? 'qq:private:10001:5001')
})

test('准入：消息时间过旧默认丢弃；deliverBackfill=true 才放行', () => {
  const stale = privateEvent({ time: Math.floor((NOW - 3 * 3600_000) / 1000) })
  const gate = createInboundGate({ now: () => NOW, allowPrivate: ['10001'], maxStaleMs: 600_000 })
  assert.equal(gate.admit(stale).code, 'stale')
  const gate2 = createInboundGate({ now: () => NOW, allowPrivate: ['10001'], maxStaleMs: 600_000, deliverBackfill: true })
  assert.equal(gate2.admit(stale).accept, true)
})

test('准入：每分钟限流按 peer 计，超出丢弃', () => {
  const gate = createInboundGate({ now: () => NOW, allowPrivate: ['10001'], maxPerMinute: 2 })
  assert.equal(gate.admit(privateEvent({ messageId: 1 })).accept, true)
  assert.equal(gate.admit(privateEvent({ messageId: 2 })).accept, true)
  assert.equal(gate.admit(privateEvent({ messageId: 3 })).code, 'rate')
})

test('去重表：可选落盘，重启后仍认同一条', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-dedupe-'))
  const file = path.join(dir, 'dedupe.json')
  const store = createDedupeStore({ now: () => NOW, file })
  store.add('qq:private:10001:1')
  assert.equal(store.flush().saved, true)
  const loaded = createDedupeStore({ now: () => NOW, file })
  const result = loaded.load()
  assert.equal(result.loaded, 1)
  assert.equal(loaded.has('qq:private:10001:1'), true)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('端点发现：只读 SnowLuma 的 onebot_<uin>.json，不猜默认 token', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-snowluma-'))
  const configDir = path.join(dir, 'config')
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(path.join(configDir, 'onebot_2593621742.json'), JSON.stringify({
    networks: { wsServers: [{ host: '0.0.0.0', port: 3001, accessToken: 'from-file' }] },
  }))
  const found = discoverOneBotEndpoint(dir)
  assert.equal(found.ok, true)
  assert.equal(found.uin, '2593621742')
  assert.equal(found.wsUrl, 'ws://127.0.0.1:3001/')
  assert.equal(found.token, 'from-file')
  const missing = discoverOneBotEndpoint(path.join(dir, 'nope'))
  assert.equal(missing.ok, false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('出站：默认双钥匙关闭，任何目标都拒绝', () => {
  assert.equal(sendEnabled({}), false)
  assert.equal(sendEnabled({ enabled: true, allowSend: true }), false)
  assert.equal(sendEnabled({ enabled: true, allowSend: true, sendApproval: 'lead-approved' }), true)
  const refused = checkSendTarget({ enabled: true, allowPrivate: ['10001'] }, '10001')
  assert.equal(refused.ok, false)
  assert.match(refused.error, /出站未启用/)
  const wrongApproval = checkSendTarget({ enabled: true, allowSend: true, sendApproval: 'yes', allowPrivate: ['10001'] }, '10001')
  assert.equal(wrongApproval.ok, false)
})

/* ── 2. 插件层（假 WebSocket） ────────────────────────── */

test('插件默认不开：不建连接、状态可读', async () => {
  FakeWebSocket.reset()
  const host = createHost({ log: () => {} })
  host.registerPlugin(manifest, qqModule, { config: { webSocketImpl: FakeWebSocket } })
  await host.enable('qq')
  const shared = host.shared.get('qq')
  const status = shared.status()
  assert.equal(status.enabled, false)
  assert.equal(status.connection.state, 'disabled')
  assert.equal(FakeWebSocket.instances.length, 0)
  assert.equal(host.services.delivery.pendingCount(), 0)
  host.disable('qq')
})

test('只读入站：私聊进 signals/delivery；群、陌生人、重复被挡；客户端零出站帧', async () => {
  FakeWebSocket.reset()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-'))
  const recordFile = path.join(dir, 'inbound.jsonl')
  const host = createHost({ log: () => {} })
  host.registerPlugin(manifest, qqModule, { config: makePluginConfig({ recordFile }) })
  await host.enable('qq')
  const ws = FakeWebSocket.last()
  assert.ok(ws, '应创建一条 WebSocket 连接')
  ws.emit('open', {})
  const shared = host.shared.get('qq')
  assert.equal(shared.status().connection.connected, true)

  // 白名单内私聊
  ws.emit('message', eventFrame(privateEvent({ text: '晚上开会吗', messageId: 9001 })))
  const [batch] = host.services.delivery.drain('session')
  assert.ok(batch, '应进入 delivery')
  assert.equal(batch.text, '[QQ私聊] 测试：晚上开会吗')
  assert.equal(batch.entries[0].source.plugin, 'qq')
  host.services.delivery.ack(batch.id)

  // 同一条重复：不再投递
  ws.emit('message', eventFrame(privateEvent({ text: '晚上开会吗', messageId: 9001 })))
  assert.equal(host.services.delivery.pendingCount(), 0)

  // 群消息：整类忽略
  ws.emit('message', eventFrame(groupEvent()))
  assert.equal(host.services.delivery.pendingCount(), 0)

  // 白名单外私聊：丢弃
  ws.emit('message', eventFrame(privateEvent({ from: 999999, name: '陌生人', messageId: 9002 })))
  assert.equal(host.services.delivery.pendingCount(), 0)

  const status = shared.status()
  assert.equal(status.gate.byCode.duplicate, 1)
  assert.equal(status.gate.byCode.group, 1)
  assert.equal(status.gate.byCode['not-allowlisted'], 1)
  assert.equal(status.stats.recent.lastAccepted?.messageId, '9001')
  assert.equal(status.stats.recent.lastDropped?.code, 'not-allowlisted')
  assert.equal(status.readOnlyInvariant.framesSent, 0)
  assert.equal(ws.sent.length, 0, '插件绝不能往 OneBot 写任何帧')

  // 影子记录：accepted / duplicate / not-allowlisted（群不落文本）
  const rows = fs.readFileSync(recordFile, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line))
  assert.deepEqual(rows.map((row) => row.kind), ['accepted', 'dropped', 'dropped'])
  assert.equal(rows[0].text, '晚上开会吗')
  assert.equal(rows[1].code, 'duplicate')
  assert.equal(rows[2].code, 'not-allowlisted')
  assert.ok(!rows.some((row) => row.code === 'group'))

  host.disable('qq')
  assert.equal(ws.closed, true)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('入站防抖：连发两条先攒批，flush 后只投一条 batch，账本 watermark 推 2', async () => {
  FakeWebSocket.reset()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-debounce-'))
  const host = createHost({ log: () => {} })
  host.registerPlugin(manifest, qqModule, {
    config: makePluginConfig({
      ledgerFile: path.join(dir, 'ledger.db'),
      inboundDebounce: { enabled: true, quietMs: 1000, maxHoldMs: 5000, maxBatchMessages: 20 },
    }),
  })
  await host.enable('qq')
  const ws = FakeWebSocket.last()
  ws.emit('open', {})
  ws.emit('message', eventFrame(privateEvent({ text: '一', messageId: 9101 })))
  ws.emit('message', eventFrame(privateEvent({ text: '二', messageId: 9102 })))
  assert.equal(host.services.delivery.pendingCount(), 0, 'quiet 窗口内不投递')
  const shared = host.shared.get('qq')
  assert.equal(shared.status().debounce.pendingMessages, 2)
  shared.flushInbound()
  const [batch] = host.services.delivery.drain('session')
  assert.ok(batch, 'flush 后应投递一条 batch')
  assert.match(batch.text, /（连发 2 条）/)
  assert.match(batch.text, /· 测试：一/)
  assert.match(batch.text, /· 测试：二/)
  const watermarks = shared.status().ledger.watermarks
  assert.equal(watermarks[0].deliveredSeq, 2, 'batch 内两条都要记 delivered')
  host.services.delivery.ack(batch.id)
  host.disable('qq')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('被 time 静音锁拦下：计入 blocked、不重试（由 time 的 backlog 负责重放）', async () => {
  FakeWebSocket.reset()
  const host = createHost({ log: () => {} })
  host.registerPlugin(manifest, qqModule, { config: makePluginConfig() })
  await host.enable('qq')
  const ws = FakeWebSocket.last()
  ws.emit('open', {})
  host.services.signals.setGate(() => ({ accept: false, reason: 'sleeping' }))

  ws.emit('message', eventFrame(privateEvent({ messageId: 9101, text: '睡着时来的' })))
  const shared = host.shared.get('qq')
  let status = shared.status()
  assert.equal(status.stats.blocked, 1)
  assert.equal(status.stats.blockedReasons.sleeping, 1)
  assert.equal(status.stats.recent.lastBlocked?.reason, 'sleeping')
  assert.equal(status.stats.delivered, 0)
  assert.equal(host.services.delivery.pendingCount(), 0)

  // 不重试：等几个 tick，仍然没有投递，也没有重试积压
  await sleep(120)
  status = shared.status()
  assert.equal(status.stats.retryPending, 0)
  assert.equal(host.services.delivery.pendingCount(), 0)

  // 锁解除后，同一条不会自己再冒出来（本地已按 id 认过它；重放由 time 的队列负责）
  host.services.signals.setGate(null)
  ws.emit('message', eventFrame(privateEvent({ messageId: 9101, text: '睡着时来的' })))
  assert.equal(host.services.delivery.pendingCount(), 0)
  assert.equal(shared.status().gate.byCode.duplicate, 1)
  host.disable('qq')
})

test('deliver 瞬时失败：进有界重试队列，恢复后投出去', async () => {
  FakeWebSocket.reset()
  const host = createHost({ log: () => {} })
  host.registerPlugin(manifest, qqModule, { config: makePluginConfig() })
  await host.enable('qq')
  const ws = FakeWebSocket.last()
  ws.emit('open', {})

  const service = host.services.signals
  const original = service.offer.bind(service)
  let failOnce = true
  service.offer = (signal) => {
    if (failOnce) { failOnce = false; return { accepted: false, error: 'busy' } }
    return original(signal)
  }
  ws.emit('message', eventFrame(privateEvent({ messageId: 9201, text: '忙时来的' })))
  let status = host.shared.get('qq').status()
  assert.equal(status.stats.retryPending, 1)

  const ok = await waitFor(() => host.services.delivery.pendingCount() > 0 || host.shared.get('qq').status().stats.delivered > 0)
  assert.equal(ok, true, '重试应把消息投出去')
  const [batch] = host.services.delivery.drain('session')
  assert.ok(batch)
  host.services.delivery.ack(batch.id)
  status = host.shared.get('qq').status()
  assert.equal(status.stats.delivered, 1)
  host.disable('qq')
})

test('去重跨重启：dedupeFile 落盘后，新进程仍不重复投递', async () => {
  FakeWebSocket.reset()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-dedupe-restart-'))
  const dedupeFile = path.join(dir, 'dedupe.json')
  const cfg = makePluginConfig({ dedupeFile })

  const host1 = createHost({ log: () => {} })
  host1.registerPlugin(manifest, qqModule, { config: cfg })
  await host1.enable('qq')
  const ws1 = FakeWebSocket.last()
  ws1.emit('open', {})
  ws1.emit('message', eventFrame(privateEvent({ messageId: 9301, text: '重启前' })))
  assert.equal(host1.services.delivery.drain('session').length, 1)
  host1.disable('qq')

  const host2 = createHost({ log: () => {} })
  host2.registerPlugin(manifest, qqModule, { config: cfg })
  await host2.enable('qq')
  const ws2 = FakeWebSocket.last()
  ws2.emit('open', {})
  ws2.emit('message', eventFrame(privateEvent({ messageId: 9301, text: '重启前' })))
  assert.equal(host2.services.delivery.pendingCount(), 0)
  assert.equal(host2.shared.get('qq').status().gate.byCode.duplicate, 1)
  host2.disable('qq')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('qq_status 是可读的只读工具，明确说不能发', async () => {
  FakeWebSocket.reset()
  const host = createHost({ log: () => {} })
  host.registerPlugin(manifest, qqModule, { config: makePluginConfig() })
  await host.enable('qq')
  const ws = FakeWebSocket.last()
  ws.emit('open', {})
  ws.emit('message', eventFrame(privateEvent({ messageId: 9601, text: '最近一条' })))
  const tool = host.services.tools.list().find((t) => t.name === 'qq_status')
  assert.ok(tool)
  const result = await tool.execute()
  assert.match(result.text, /QQ 只读影子/)
  assert.match(result.text, /群消息：整类忽略/)
  assert.match(result.text, /出站：关闭/)
  assert.match(result.text, /只读不变量：入站连接客户端已发帧 0/)
  assert.match(result.text, /最近一条私聊：.*测试（10001） #9601：最近一条/)
  host.disable('qq')
})

test('影子状态文件：给 lab / runbook 的可观测出口（连接态 + 零出站）', async () => {
  FakeWebSocket.reset()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-status-'))
  const statusFile = path.join(dir, 'status.json')
  const host = createHost({ log: () => {} })
  host.registerPlugin(manifest, qqModule, { config: makePluginConfig({ statusFile, statusIntervalMs: 500 }) })
  await host.enable('qq')
  const ws = FakeWebSocket.last()
  ws.emit('open', {})
  ws.emit('message', eventFrame(privateEvent({ messageId: 9501, text: '状态文件' })))
  const ok = await waitFor(() => {
    try {
      const data = JSON.parse(fs.readFileSync(statusFile, 'utf8'))
      return data.connection?.connected === true && data.stats?.delivered >= 1
    } catch { return false }
  })
  assert.equal(ok, true, '状态文件应被原子写出并反映连接/投递')
  const data = JSON.parse(fs.readFileSync(statusFile, 'utf8'))
  assert.equal(data.readOnlyInvariant.framesSent, 0)
  assert.equal(data.groupPolicy, 'ignore')
  assert.equal(data.sendEnabled, false)
  host.disable('qq')
  fs.rmSync(dir, { recursive: true, force: true })
})

/* ── 3. 回环层：真 WebSocket + 假 OneBot 服务 ─────────── */

test('真 WebSocket 回环：收得到、进 delivery、客户端一个字节都不发', async () => {
  const fake = await createFakeOneBot({ port: 0, token: 'loop-token' })
  const host = createHost({ log: () => {} })
  host.registerPlugin(manifest, qqModule, {
    config: {
      enabled: true,
      url: `ws://127.0.0.1:${fake.port}/`,
      token: 'loop-token',
      selfId: '2593621742',
      allowPrivate: ['10001'],
      retryTickMs: 20,
    },
  })
  await host.enable('qq')
  const shared = host.shared.get('qq')
  try {
    const connected = await waitFor(() => shared.status().connection.connected)
    assert.equal(connected, true, '应连上假 OneBot')
    fake.lifecycle()
    fake.heartbeat()
    fake.privateMessage({ from: 10001, name: '回环', text: '真实 WebSocket', messageId: 9401 })
    const delivered = await waitFor(() => shared.status().stats.delivered > 0)
    assert.equal(delivered, true, '应投递到 signals/delivery')
    const [batch] = host.services.delivery.drain('session')
    assert.ok(batch)
    assert.equal(batch.text, '[QQ私聊] 回环：真实 WebSocket')
    host.services.delivery.ack(batch.id)
    // 只读不变量：连接期间客户端没有发出任何字节（close 帧在断言之后才可能发生）
    assert.equal(fake.clientDataChunks(), 0)
    assert.equal(shared.status().readOnlyInvariant.framesSent, 0)
  } finally {
    host.disable('qq')
    await fake.close()
  }
})

/* ── 4. 静态安全不变量：index 里没有发送实现，唯一入口在 send-tool ───────── */

test('静态安全：index 不 import 发送实现；qq_send 只在 send-tool；群发送动作不存在', () => {
  const srcDir = new URL('../../plugins/qq/src/', import.meta.url)
  const index = fs.readFileSync(new URL('index.mjs', srcDir), 'utf8')
  const outbound = fs.readFileSync(new URL('outbound.mjs', srcDir), 'utf8')
  const sendTool = fs.readFileSync(new URL('send-tool.mjs', srcDir), 'utf8')
  const connector = fs.readFileSync(new URL('connector.mjs', srcDir), 'utf8')
  // index 不得出现任何 OneBot 发送动作，也不得出现发送实现/发送函数
  assert.doesNotMatch(index, /send_(?:private|group)_msg/)
  assert.doesNotMatch(index, /createOutbound\s*\(/)
  assert.doesNotMatch(index, /\.sendPrivate\s*\(/)
  // index 只允许静态 import outbound 的纯判定（sendEnabled / SEND_APPROVAL_TOKEN）
  const importLine = index.split(/\r?\n/).find((line) => line.includes("from './outbound.mjs'")) ?? ''
  assert.doesNotMatch(importLine, /createOutbound/)
  // 发送入口：只有 send-tool 注册 qq_send；它才 import createOutbound
  assert.match(sendTool, /name: 'qq_send'/)
  assert.match(sendTool, /createOutbound/)
  assert.doesNotMatch(sendTool, /send_group_msg/)
  // 只读连接器里没有任何 ws.send（影子模式零出站）；发送动作只在 outbound
  assert.doesNotMatch(connector, /\.send\s*\(/)
  assert.match(outbound, /send_private_msg/)
  for (const file of ['index.mjs', 'connector.mjs', 'normalize.mjs', 'gate.mjs', 'send-tool.mjs']) {
    assert.doesNotMatch(fs.readFileSync(new URL(file, srcDir), 'utf8'), /send_group_msg/, `${file} 不得出现群发送动作`)
  }
  // index 只在三把钥匙打开时动态装配 send-tool（不是静态 import）
  assert.match(index, /await import\('\.\/send-tool\.mjs'\)/)
  assert.doesNotMatch(index, /^import .*from '\.\/send-tool\.mjs'/m)
})

/* ── Phase 3：显式等待 + finish-then-handle ── */

test('显式等待：等待期间到达的新消息由 waiter 消费，不再进 delivery；账本 delivered', async () => {
  FakeWebSocket.reset()
  const host = createHost({ log: () => {} })
  host.registerPlugin(manifest, qqModule, { config: makePluginConfig({ ledgerFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qq-wait-')), 'ledger.db') }) })
  await host.enable('qq')
  const ws = FakeWebSocket.last()
  ws.emit('open', {})
  try {
    const tool = host.services.tools.list().find((t) => t.name === 'qq_wait_for_messages')
    assert.ok(tool, '应注册 qq_wait_for_messages')
    const pending = tool.execute({ timeoutMs: 5000, quietMs: 1000 })
    await sleep(30)
    ws.emit('message', eventFrame(privateEvent({ text: '补充一句', messageId: 9201 })))
    const result = await pending
    assert.equal(result.outcome, 'messages')
    assert.match(result.text, /补充一句/)
    assert.equal(host.services.delivery.pendingCount(), 0, 'wait 消费的消息不能再次投递')
    assert.equal(host.shared.get('qq').status().ledger.watermarks[0].deliveredSeq, 1)
  } finally {
    host.disable('qq')
  }
})

test('睡眠拦截：戳一戳与普通消息一样进 time 积压，不产生投递', async () => {
  FakeWebSocket.reset()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-poke-sleep-'))
  const host = createHost({ log: () => {} })
  host.registerPlugin(timeManifest, timeModule, { config: { stateFile: path.join(dir, 'time.json'), tickMs: 3_600_000 } })
  host.registerPlugin(manifest, qqModule, { config: makePluginConfig() })
  await host.enable('time')
  const time = host.shared.get('time')
  time.sleep({ message: '睡了', durationMin: 30 })
  host.services.delivery.drain('session').forEach((batch) => host.services.delivery.ack(batch.id))
  await host.enable('qq')
  const ws = FakeWebSocket.last()
  ws.emit('open', {})
  ws.emit('message', eventFrame({
    post_type: 'notice', notice_type: 'poke', sub_type: 'poke',
    time: Math.floor(NOW / 1000), self_id: 2593621742,
    user_id: 10001, target_id: 2593621742,
    sender: { user_id: 10001, nickname: '测试' },
  }))
  assert.equal(host.services.delivery.pendingCount(), 0, '戳一戳不能叫醒睡眠')
  assert.equal(time.status().backlog, 1)
  assert.equal(time.queue()[0].reason, 'sleeping')
  assert.match(time.queue()[0].text, /戳了戳你/)
  assert.equal(ws.sent.length, 0)
  host.disable('qq')
  host.disable('time')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('睡眠中唤醒矩阵的主动提醒不塞进 time 积压（只保留原始消息）', async () => {
  FakeWebSocket.reset()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-wake-sleep-'))
  const host = createHost({ log: () => {} })
  host.registerPlugin(timeManifest, timeModule, { config: { stateFile: path.join(dir, 'time.json'), tickMs: 3_600_000 } })
  host.registerPlugin(manifest, qqModule, {
    config: makePluginConfig({ wakeTickMs: 20, nudgeSoftMs: 0, nudgeCooldownMs: 0, replyCheckEnabled: false }),
  })
  await host.enable('time')
  const time = host.shared.get('time')
  time.sleep({ message: '睡了', durationMin: 30 })
  host.services.delivery.drain('session').forEach((batch) => host.services.delivery.ack(batch.id))
  await host.enable('qq')
  const ws = FakeWebSocket.last()
  ws.emit('open', {})
  ws.emit('message', eventFrame(privateEvent({ text: '睡眠里的一条', messageId: 9501 })))
  assert.equal(time.status().backlog, 1)
  await sleep(1300)
  assert.equal(time.status().backlog, 1, '睡眠中不应再生成积压提醒')
  assert.ok((host.shared.get('qq').status().stats.wakeSuppressedNonAwake ?? 0) >= 1, '唤醒矩阵应在非 awake 时被拦下')
  host.disable('qq')
  host.disable('time')
  fs.rmSync(dir, { recursive: true, force: true })
})


function groupMessageEvent({ groupId = 601357169, groupName = '测试群', from = 10001, name = '群友', text = '群里说话', messageId = 8801, at = null } = {}) {
  const message = []
  if (at != null) message.push({ type: 'at', data: { qq: String(at) } })
  message.push({ type: 'text', data: { text } })
  return {
    post_type: 'message', message_type: 'group', sub_type: 'normal',
    time: Math.floor(NOW / 1000), self_id: 2593621742,
    group_id: groupId, group_name: groupName, user_id: from,
    message_id: messageId, message_seq: messageId,
    message,
    sender: { user_id: from, nickname: name, card: name },
  }
}

test('群聊 G1：普通消息一律 ambient 进 backlog，只有 @ 直达', async () => {
  FakeWebSocket.reset()
  const host = createHost({ log: () => {} })
  host.registerPlugin(focusManifest, focusModule, {})
  host.registerPlugin(manifest, qqModule, {
    config: makePluginConfig({ groupPolicy: 'allowlist', allowGroups: ['601357169', '1057812765'] }),
  })
  await host.enable('focus')
  await host.enable('qq')
  const ws = FakeWebSocket.last()
  ws.emit('open', {})
  const focus = host.services.focus

  ws.emit('message', eventFrame(groupMessageEvent({ text: '普通消息一', messageId: 8811 })))
  assert.equal(host.services.delivery.drain('session').length, 0, '普通群消息不能叫醒')
  assert.ok(focus.backlog().some((row) => row.focus === 'qq:group:601357169'), '普通群消息进该群 backlog')

  ws.emit('message', eventFrame(groupMessageEvent({ text: '@你 急事', messageId: 8812, at: 2593621742 })))
  const direct = host.services.delivery.drain('session').map((b) => b.text).join('\n')
  assert.match(direct, /@你 急事/)
  host.services.delivery.drain('session').forEach((b) => host.services.delivery.ack(b.id))

  const enter = host.services.tools.list().find((t) => t.name === 'focus_enter')
  await enter.execute({ title: '测试群', activity: 'qq:group:601357169' })
  host.services.delivery.drain('session').forEach((b) => host.services.delivery.ack(b.id))
  ws.emit('message', eventFrame(groupMessageEvent({ text: '本群普通消息', messageId: 8813 })))
  assert.equal(host.services.delivery.drain('session').length, 0, 'focus 该群时普通消息也不逐条穿透')
  assert.ok(focus.backlog().some((row) => row.focus === 'qq:group:601357169'))

  ws.emit('message', eventFrame(groupMessageEvent({ groupId: 1057812765, groupName: '另一个群', text: '别群消息', messageId: 8814 })))
  assert.equal(host.services.delivery.pendingCount(), 0, '别群普通消息进 backlog')
  assert.ok(focus.backlog().some((row) => row.focus === 'qq:group:1057812765'))

  host.disable('qq')
  host.disable('focus')
})

test('群聊 gate：默认忽略，allowlist 才收；普通消息 ambient、@ self 带 at/mention', () => {
  const off = createInboundGate({ groupPolicy: 'ignore', allowGroups: ['601357169'], selfId: '2593621742' })
  assert.equal(off.admit(groupMessageEvent({ text: '群' })).code, 'group')

  const gate = createInboundGate({ groupPolicy: 'allowlist', allowGroups: ['601357169'], selfId: '2593621742' })
  const plain = gate.admit(groupMessageEvent({ text: '普通', messageId: 8901 }))
  assert.equal(plain.accept, true)
  assert.equal(plain.scope, 'group')
  assert.equal(plain.signal.tags.includes('ambient'), true, '普通群消息必须是 ambient')
  assert.equal(plain.signal.meta.ambient, true)
  assert.ok(!plain.signal.tags.includes('mention'))
  assert.equal(plain.signal.from.activity, 'qq:group:601357169')

  const at = gate.admit(groupMessageEvent({ text: '@你', messageId: 8902, at: 2593621742 }))
  assert.equal(at.accept, true)
  assert.ok(at.signal.tags.includes('at'))
  assert.ok(at.signal.tags.includes('mention'))
  assert.equal(at.signal.tags.includes('ambient'), false)

  assert.equal(gate.admit(groupMessageEvent({ groupId: 999, messageId: 8903 })).code, 'not-allowlisted')
})


test('群聊只读工具：qq_groups 报未读，qq_group_history 能看群账本', async () => {
  FakeWebSocket.reset()
  const host = createHost({ log: () => {} })
  host.registerPlugin(focusManifest, focusModule, {})
  host.registerPlugin(manifest, qqModule, {
    config: makePluginConfig({ groupPolicy: 'allowlist', allowGroups: ['601357169'] }),
  })
  await host.enable('focus')
  await host.enable('qq')
  const ws = FakeWebSocket.last()
  ws.emit('open', {})
  host.services.focus.enter({ label: 'other', owner: 'focus', title: '别的活动' })
  ws.emit('message', eventFrame(groupMessageEvent({ text: '群历史一条', messageId: 8911 })))
  const tools = host.services.tools.list()
  const groups = await tools.find((t) => t.name === 'qq_groups').execute()
  assert.match(groups.text, /601357169/)
  assert.match(groups.text, /未读 1 条/)
  const history = await tools.find((t) => t.name === 'qq_group_history').execute({ group: '601357169' })
  assert.match(history.text, /群历史一条/)
  host.disable('qq')
  host.disable('focus')
})

test('戳一戳在醒着、无 focus 时单独叫醒（不是只在睡眠里入队）', async () => {
  FakeWebSocket.reset()
  const host = createHost({ log: () => {} })
  host.registerPlugin(manifest, qqModule, { config: makePluginConfig() })
  await host.enable('qq')
  const ws = FakeWebSocket.last()
  ws.emit('open', {})
  ws.emit('message', eventFrame({
    post_type: 'notice', notice_type: 'poke', sub_type: 'poke',
    time: Math.floor(NOW / 1000), self_id: 2593621742,
    user_id: 10001, target_id: 2593621742,
    sender: { user_id: 10001, nickname: '测试' },
  }))
  const text = host.services.delivery.drain('session').map((b) => b.text).join('\n')
  assert.match(text, /戳了戳你/)
  host.disable('qq')
})

test('未读摘要：旧消息在下一轮 turnText 里可见，不依赖主动检查', async () => {
  FakeWebSocket.reset()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-unread-digest-'))
  const host = createHost({ log: () => {} })
  host.registerPlugin(timeManifest, timeModule, { config: { stateFile: path.join(dir, 'time.json'), tickMs: 3_600_000 } })
  host.registerPlugin(manifest, qqModule, { config: makePluginConfig() })
  await host.enable('time')
  host.shared.get('time').sleep({ message: '睡了', durationMin: 30 })
  host.services.delivery.drain('session').forEach((b) => host.services.delivery.ack(b.id))
  await host.enable('qq')
  const ws = FakeWebSocket.last()
  ws.emit('open', {})
  ws.emit('message', eventFrame(privateEvent({ text: '睡前没看到的消息', messageId: 9701 })))
  const turnText = await host.services.prompt.turnText({})
  assert.match(turnText, /QQ 还有没看过的消息/)
  assert.match(turnText, /睡前没看到的消息/)
  host.disable('qq')
  host.disable('time')
  fs.rmSync(dir, { recursive: true, force: true })
})



test('群聊 busyness：普通消息进 ambient backlog；刷屏批量仍进 backlog', async () => {
  FakeWebSocket.reset()
  const host = createHost({ log: () => {} })
  host.registerPlugin(focusManifest, focusModule, {})
  host.registerPlugin(manifest, qqModule, {
    config: makePluginConfig({ groupPolicy: 'allowlist', allowGroups: ['601357169'] }),
  })
  await host.enable('focus')
  await host.enable('qq')
  const ws = FakeWebSocket.last()
  ws.emit('open', {})
  for (let i = 0; i < 7; i += 1) {
    ws.emit('message', eventFrame(groupMessageEvent({ text: `刷屏${i}`, messageId: 9000 + i })))
  }
  assert.equal(host.services.focus.backlog().length, 1, '高 rate 的群应进 backlog')
  assert.ok(host.services.focus.backlog()[0].count >= 2)
  host.disable('qq')
  host.disable('focus')
})


test('触发戳一戳只在目标是自己时生效：群里戳别人/私聊戳别人都丢弃', async () => {
  FakeWebSocket.reset()
  const host = createHost({ log: () => {} })
  host.registerPlugin(manifest, qqModule, { config: makePluginConfig({ groupPolicy: 'allowlist', allowGroups: ['601357169'] }) })
  await host.enable('qq')
  const ws = FakeWebSocket.last()
  ws.emit('open', {})
  const base = {
    post_type: 'notice', notice_type: 'notify', sub_type: 'poke',
    time: Math.floor(NOW / 1000), self_id: 2593621742,
    user_id: 10001, sender: { user_id: 10001, nickname: '测试' },
  }
  ws.emit('message', eventFrame({ ...base, group_id: 601357169, target_id: 20002 }))
  assert.equal(host.services.delivery.pendingCount(), 0, '群戳别人不能当成戳她')
  ws.emit('message', eventFrame({ ...base, target_id: 20002 }))
  assert.equal(host.services.delivery.pendingCount(), 0, '私聊戳别人不能当成戳她')
  ws.emit('message', eventFrame({ ...base, group_id: 601357169 }))
  assert.equal(host.services.delivery.pendingCount(), 0, '缺 target 不能猜')
  ws.emit('message', eventFrame({ ...base, group_id: 601357169, target_id: 2593621742 }))
  const text = host.services.delivery.drain('session').map((b) => b.text).join('\n')
  assert.match(text, /\[QQ群戳一戳\]/)
  host.disable('qq')
})

test('wait 同一工具支持私聊与群聊；群消息由 waiter 消费，不再重复投递', async () => {
  FakeWebSocket.reset()
  const host = createHost({ log: () => {} })
  host.registerPlugin(manifest, qqModule, { config: makePluginConfig({ groupPolicy: 'allowlist', allowGroups: ['601357169'] }) })
  await host.enable('qq')
  const ws = FakeWebSocket.last()
  ws.emit('open', {})
  const tool = host.services.tools.list().find((t) => t.name === 'qq_wait_for_messages')
  assert.ok(tool)
  const pending = tool.execute({ peer: '601357169', timeoutMs: 5000, quietMs: 1000 })
  await new Promise((resolve) => setTimeout(resolve, 30))
  ws.emit('message', eventFrame(groupMessageEvent({ text: '群等待消息', messageId: 9901 })))
  const result = await pending
  assert.equal(result.outcome, 'messages')
  assert.match(result.text, /群等待消息/)
  assert.equal(host.services.delivery.pendingCount(), 0, 'waiter 消费后不应再走正常投递')
  host.disable('qq')
})

test('群级静音：消息入账为未读并标 muted，但不投递；解除后恢复直达', async () => {
  FakeWebSocket.reset()
  const host = createHost({ log: () => {} })
  host.registerPlugin(manifest, qqModule, { config: makePluginConfig({ groupPolicy: 'allowlist', allowGroups: ['601357169'], allowGroupMute: true }) })
  await host.enable('qq')
  const ws = FakeWebSocket.last()
  ws.emit('open', {})
  const mute = host.services.tools.list().find((t) => t.name === 'qq_group_mute')
  assert.ok(mute)
  assert.match((await mute.execute({ group: '601357169', muted: true })).text, /已静音/)
  ws.emit('message', eventFrame(groupMessageEvent({ text: '静音时来的消息', messageId: 9921 })))
  assert.equal(host.services.delivery.pendingCount(), 0, '静音群消息不能叫醒/投递')
  const history = await host.services.tools.list().find((t) => t.name === 'qq_group_history').execute({ group: '601357169' })
  assert.match(history.text, /静音时来的消息/)
  assert.match(history.text, /muted/)
  await mute.execute({ group: '601357169', muted: false })
  ws.emit('message', eventFrame(groupMessageEvent({ text: '解除后消息', messageId: 9922 })))
  assert.equal(host.services.delivery.pendingCount(), 0, '解除静音后普通群消息仍不穿透，只进 backlog')
  assert.ok(host.services.focus.backlog().some((row) => row.focus === 'qq:group:601357169'))
  host.disable('qq')
})

test('读工具统一：qq_unread/history/mark_read/replied 接受群号', async () => {
  FakeWebSocket.reset()
  const host = createHost({ log: () => {} })
  host.registerPlugin(manifest, qqModule, { config: makePluginConfig({ groupPolicy: 'allowlist', allowGroups: ['601357169'] }) })
  await host.enable('qq')
  const ws = FakeWebSocket.last()
  ws.emit('open', {})
  ws.emit('message', eventFrame(groupMessageEvent({ text: '统一读群消息', messageId: 9931 })))
  const tools = host.services.tools.list()
  const unread = await tools.find((t) => t.name === 'qq_unread').execute({ peer: '601357169' })
  assert.match(unread.text, /群 601357169/)
  assert.match(unread.text, /统一读群消息/)
  const history = await tools.find((t) => t.name === 'qq_history').execute({ to: '601357169' })
  assert.match(history.text, /群 601357169/)
  const replied = await tools.find((t) => t.name === 'qq_replied').execute({ peer: '601357169' })
  assert.match(replied.text, /群 601357169/)
  const mark = await tools.find((t) => t.name === 'qq_mark_read').execute({ peer: '601357169' })
  assert.match(mark.text, /群 601357169/)
  host.disable('qq')
})


