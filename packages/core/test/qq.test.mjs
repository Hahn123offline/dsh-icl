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

test('准入：白名单为空 = 一个都不收（默认安全）', () => {
  const gate = createInboundGate({ now: () => NOW })
  const out = gate.admit(privateEvent())
  assert.equal(out.accept, false)
  assert.equal(out.code, 'not-allowlisted')
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
  assert.equal(batch.text, '测试：晚上开会吗')
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
  assert.equal(rows[0].text, '测试：晚上开会吗')
  assert.equal(rows[1].code, 'duplicate')
  assert.equal(rows[2].code, 'not-allowlisted')
  assert.ok(!rows.some((row) => row.code === 'group'))

  host.disable('qq')
  assert.equal(ws.closed, true)
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
  assert.match(result.text, /最近一条私聊：.*测试（10001） #9601：测试：最近一条/)
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
    assert.equal(batch.text, '回环：真实 WebSocket')
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
