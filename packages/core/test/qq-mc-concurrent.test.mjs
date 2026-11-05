// QQ × MC 并发接缝：两条信号源共用同一个 host 的 gate/delivery，但不许互相吞并或合批。
//
// 这是 docs/QQ.md §9 的 T1–T3 的可执行版本（纯 fake：假 OneBot WS + 假 mc-body HTTP，
// 不连真 QQ、不连真 MC、不调模型）。T4–T6 留待真实 body/真实 QQ 之前再补。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../src/index.mjs'
import * as qqModule from '../../plugins/qq/src/index.mjs'
import * as mcLink from '../../plugins/mc-link/src/index.mjs'
import * as timeModule from '../../plugins/time/src/index.mjs'
import * as focusModule from '../../plugins/focus/src/index.mjs'
import qqManifest from '../../plugins/qq/manifest.json' with { type: 'json' }
import mcManifest from '../../plugins/mc-link/manifest.json' with { type: 'json' }
import timeManifest from '../../plugins/time/manifest.json' with { type: 'json' }
import focusManifest from '../../plugins/focus/manifest.json' with { type: 'json' }

const NOW = 1_800_000_000_000

class FakeWebSocket {
  static instances = []
  static last() { return FakeWebSocket.instances[FakeWebSocket.instances.length - 1] ?? null }
  constructor(url) { this.url = String(url); this.listeners = new Map(); this.sent = []; FakeWebSocket.instances.push(this) }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn) }
  emit(type, event) { for (const fn of this.listeners.get(type) ?? []) fn(event) }
  send(data) { this.sent.push(data) }
  close() { this.emit('close', { code: 1000 }) }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

function fakeBody() {
  let seq = 1
  const events = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/v1/status') {
      res.end(JSON.stringify({ ok: true, version: 'mc-body/v1', paused: false, task: null, queue: [], eventsSeq: seq, adapter: { connected: true, self: 'ICL-test' } }))
      return
    }
    if (url.pathname === '/v1/events') {
      const since = Number(url.searchParams.get('since') ?? 0)
      res.end(JSON.stringify({ ok: true, seq, events: events.filter((e) => e.seq > since) }))
      return
    }
    if (url.pathname === '/v1/do' && req.method === 'POST') {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => { res.end(JSON.stringify({ ok: true, steps: JSON.parse(raw).steps })) })
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server,
    port: server.address().port,
    push: (event) => { seq += 1; events.push({ seq, ...event }) },
    close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(done) }),
  })))
}

function qqEvent({ text = '在吗', messageId = 7001 } = {}) {
  return {
    post_type: 'message', message_type: 'private', sub_type: 'friend',
    time: Math.floor(NOW / 1000), self_id: 2593621742, user_id: 10001, message_id: messageId,
    message: [{ type: 'text', data: { text } }], raw_message: text,
    sender: { user_id: 10001, nickname: '主人' },
  }
}

async function buildHost() {
  FakeWebSocket.instances = []
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-mc-'))
  const body = await fakeBody()
  const host = createHost({ log: () => {} })
  host.registerPlugin(focusManifest, focusModule)
  host.registerPlugin(timeManifest, timeModule, { config: { stateFile: path.join(dir, 'time.json'), tickMs: 3_600_000 } })
  host.registerPlugin(qqManifest, qqModule, {
    config: {
      enabled: true, url: 'ws://127.0.0.1:3001/', token: 't', selfId: '2593621742',
      allowPrivate: ['10001'], retryTickMs: 20, webSocketImpl: FakeWebSocket,
      statusFile: path.join(dir, 'status.json'), statusIntervalMs: 500,
    },
  })
  host.registerPlugin(mcManifest, mcLink, { config: { baseUrl: `http://127.0.0.1:${body.port}`, pollMs: 3_600_000, logFile: path.join(dir, 'mc.jsonl') } })
  for (const id of ['focus', 'time', 'qq', 'mc-link']) await host.enable(id)
  const ws = FakeWebSocket.last()
  ws.emit('open', {})
  return { host, ws, body, dir, cleanup: async () => { for (const id of ['qq', 'mc-link', 'time', 'focus']) { try { host.disable(id) } catch { /* 已停 */ } } await body.close(); fs.rmSync(dir, { recursive: true, force: true }) } }
}

test('T1 双源同时到达：两个 batch、来源可区分、不丢不重', async () => {
  const { host, ws, body, cleanup } = await buildHost()
  try {
    const link = host.shared.get('mc-link')
    await link.poll() // 第一次只定游标
    body.push({ type: 'task_done', data: { task: { kind: 'mine', id: 't-1' } } })
    await link.poll() // 处理事件 → signals
    ws.emit('message', { data: JSON.stringify(qqEvent({ text: '并发时来的私聊' })) })
    await sleep(30)
    const batches = host.services.delivery.drain('session')
    assert.equal(batches.length, 2, `应有两条独立批次，实际 ${batches.length}`)
    const byPlugin = Object.fromEntries(batches.map((b) => [b.entries[0].source.plugin, b.text]))
    assert.equal(byPlugin.qq, '主人：并发时来的私聊')
    assert.match(byPlugin.mc, /\[MC\] 任务完成：mine t-1/)
    // 不混来源：每个 batch 内只有一个 plugin
    for (const batch of batches) assert.equal(new Set(batch.entries.map((e) => e.source.plugin)).size, 1)
    // 不重：再 drain 没有新批次
    assert.equal(host.services.delivery.drain('session').length, 0)
  } finally { await cleanup() }
})

test('T2 sacred focus：两条来源都被 core defer 到各自积压，不投递', async () => {
  const { host, ws, body, cleanup } = await buildHost()
  try {
    const link = host.shared.get('mc-link')
    await link.poll()
    host.services.focus.enter({ label: 'act:reading', title: '读东西', interruptible: false, owner: 'test' })
    body.push({ type: 'task_done', data: { task: { kind: 'mine', id: 't-2' } } })
    await link.poll()
    ws.emit('message', { data: JSON.stringify(qqEvent({ text: '专注时来的私聊', messageId: 7002 })) })
    await sleep(30)
    assert.equal(host.services.delivery.pendingCount(), 0, 'sacred focus 下不应有投递')
    // focus 层的拦截发生在 host.setDeliver 内部：signals.offer 仍返回 accepted（delivery 接住了并 defer），
    // 所以 QQ 插件的 blocked 计数**只反映 time gate**，不反映 focus。这里断言 core 的积压与投递结果。
    const qq = host.shared.get('qq').status()
    assert.equal(qq.stats.delivered, 1, 'QQ 信号被 signals 接受（随后被 focus defer）')
    const backlog = host.services.focus.backlog()
    const total = backlog.reduce((sum, row) => sum + row.count, 0)
    assert.equal(total >= 2, true, `focus 积压应包含两条来源，实际 ${JSON.stringify(backlog.map((r) => [r.focus, r.count]))}`)
    const namespaces = backlog.map((row) => row.focus)
    assert.equal(namespaces.some((name) => name.startsWith('qq:private:')), true, 'QQ 命名空间应在积压里')
  } finally { await cleanup() }
})

test('T3 time 睡眠：两条来源都进 time 积压，醒来一次重放且带各自来源前缀', async () => {
  const { host, ws, body, cleanup } = await buildHost()
  try {
    const link = host.shared.get('mc-link')
    const time = host.shared.get('time')
    await link.poll()
    await time.sleep({ durationMin: 3 })
    host.services.delivery.drain('session').forEach((b) => host.services.delivery.ack(b.id)) // 清掉睡眠通知
    body.push({ type: 'task_done', data: { task: { kind: 'mine', id: 't-3' } } })
    await link.poll()
    ws.emit('message', { data: JSON.stringify(qqEvent({ text: '睡着时来的私聊', messageId: 7003 })) })
    await sleep(30)
    assert.equal(host.services.delivery.pendingCount(), 0, '睡眠时两条来源都不应投递')
    assert.equal(time.queue().length >= 2, true, `time 积压应有两条，实际 ${time.queue().length}`)
    await time.wake()
    const batches = host.services.delivery.drain('session')
    assert.equal(batches.length, 1, '醒来应合成一条 time 通知')
    assert.match(batches[0].text, /\[qq\] 主人：睡着时来的私聊/)
    assert.match(batches[0].text, /\[mc\] \[MC\] 任务完成：mine t-3/)
    assert.equal(batches[0].entries[0].source.plugin, 'time')
  } finally { await cleanup() }
})
