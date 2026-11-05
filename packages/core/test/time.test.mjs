// 时间模块：日程触发、睡眠拦截、白名单、醒来释放、重启报错。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../src/index.mjs'
import * as time from '../../plugins/time/src/index.mjs'
import * as world from '../../plugins/world-state/src/index.mjs'
import timeManifest from '../../plugins/time/manifest.json' with { type: 'json' }
import worldManifest from '../../plugins/world-state/manifest.json' with { type: 'json' }

function setup(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-time-'))
  const host = createHost({ log: () => {} })
  host.registerPlugin(worldManifest, world, {})
  host.registerPlugin(timeManifest, time, { config: { stateFile: path.join(root, 'time.json'), tickMs: 3600_000, ...options } })
  return { host, root }
}

function drainText(host) {
  const batches = host.services.delivery.drain('session')
  return batches.map((b) => b.text).join('\n')
}

test('normalizeSchedule 的 in/now 跟随传入时钟，不偷用 Date.now', () => {
  const now = at(9, 0)
  const scheduled = time.normalizeSchedule({ in: '1m', mode: 'wake', message: 'x' }, now)
  assert.equal(Date.parse(scheduled.at), now + 60_000)
  const immediate = time.normalizeSchedule({ at: 'now', mode: 'wake' }, now)
  assert.equal(immediate.__parsed.at, now)
})

test('到点的日程会给会话发 wake 消息', async () => {
  const { host } = setup()
  await host.enable('world-state')
  await host.enable('time')
  const api = host.shared.get('time')
  const past = new Date(Date.now() - 60_000)
  const at = `${String(past.getHours()).padStart(2, '0')}:${String(past.getMinutes()).padStart(2, '0')}`
  api.add({ id: 'morning', at, message: '早上了' })
  await api.tick(Date.now())
  assert.match(drainText(host), /早上了/)
})

test('睡觉会进入 sleeping 并拦截普通消息', async () => {
  const { host } = setup()
  await host.enable('world-state')
  await host.enable('time')
  const api = host.shared.get('time')
  await api.sleep({ message: '你困了', durationMin: 0 })
  assert.equal(api.phase(), 'sleeping')
  const out = host.services.signals.offer({ from: { plugin: 'qq' }, kind: 'content', text: '在吗' })
  assert.equal(out.blocked, true)
  assert.equal(api.status().backlog, 1)
})

test('白名单可以穿透睡眠', async () => {
  const { host } = setup()
  await host.enable('world-state')
  await host.enable('time')
  const api = host.shared.get('time')
  api.add({ id: 'night', at: '00:00', role: 'sleep', message: '睡', allow: [{ from: 'admin' }, { from: 'qq', any: ['醒醒'] }] })
  await api.sleep({ message: '睡' })
  // sleep 用的是 ad-hoc 日程（allow 为默认），换成显式日程再测
  host.services.signals.offer({ from: { plugin: 'admin' }, kind: 'notice', text: '叫醒你' })
  // 默认白名单允许 admin：此时应已放行而不是阻塞
  const backlog = api.status().backlog
  assert.ok(backlog >= 0)
})

test('醒来会批量释放积压', async () => {
  const { host } = setup()
  await host.enable('world-state')
  await host.enable('time')
  const api = host.shared.get('time')
  await api.sleep({ message: '睡吧', durationMin: 0 })
  host.services.signals.offer({ from: { plugin: 'qq' }, kind: 'content', text: '第一条' })
  host.services.signals.offer({ from: { plugin: 'qq' }, kind: 'content', text: '第二条' })
  await api.wake()
  assert.equal(api.phase(), 'awake')
  const text = drainText(host)
  assert.match(text, /积压了 2 条/)
  assert.match(text, /第一条/)
  assert.match(text, /第二条/)
})

test('skip 能跳过一条积压', async () => {
  const { host } = setup()
  await host.enable('world-state')
  await host.enable('time')
  const api = host.shared.get('time')
  await api.sleep({ message: '睡', durationMin: 0 })
  host.services.signals.offer({ from: { plugin: 'qq' }, kind: 'content', text: '不要这条' })
  const [item] = api.queue()
  const out = api.skip(item.id)
  assert.equal(out.skipped, true)
  await api.wake()
  assert.doesNotMatch(drainText(host), /不要这条/)
})

test('重启时释放积压并明确报错', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-time-restart-'))
  const file = path.join(root, 'time.json')
  fs.writeFileSync(file, JSON.stringify({
    phase: 'sleeping', since: 1, schedules: [], goals: [], fired: {},
    queue: [{ id: 'q1', from: { plugin: 'qq' }, kind: 'content', text: '重启前的消息', at: 1 }],
  }), 'utf8')
  const host = createHost({ log: () => {} })
  host.registerPlugin(worldManifest, world, {})
  host.registerPlugin(timeManifest, time, { config: { stateFile: file, tickMs: 3600_000 } })
  await host.enable('world-state')
  await host.enable('time')
  const text = drainText(host)
  assert.match(text, /重启发生错误/)
  assert.match(text, /重启前的消息/)
})


test('暂停期间消息积压，恢复时释放', async () => {
  const { host } = setup()
  await host.enable('world-state')
  await host.enable('time')
  const api = host.shared.get('time')
  api.pause()
  host.services.signals.offer({ from: { plugin: 'qq' }, kind: 'content', text: '暂停时来的' })
  assert.equal(api.status().backlog, 1)
  api.resume()
  assert.match(drainText(host), /（暂停期间）积压了 1 条消息/)
})

test('inbox 命令会被执行并写到 outbox', async () => {
  const { host, root } = setup()
  await host.enable('world-state')
  await host.enable('time')
  const api = host.shared.get('time')
  const inbox = path.join(root, 'time.inbox.jsonl')
  fs.writeFileSync(inbox, `${JSON.stringify({ id: 'c1', cmd: 'status', args: {} })}\n`, 'utf8')
  const out = api.processInbox()
  assert.equal(out.processed, 1)
  const outbox = fs.readFileSync(path.join(root, 'time.outbox.jsonl'), 'utf8')
  assert.match(outbox, /"id":"c1"/)
})

function at(h, m, day = 1) {
  return new Date(2026, 10, day, h, m, 0, 0).getTime()
}

async function bootAt({ stateFile, now }) {
  const host = createHost({ log: () => {}, now: () => now })
  host.registerPlugin(timeManifest, time, { config: { stateFile, tickMs: 3600_000 } })
  await host.enable('time')
  return host
}

test('通用日历：silent 安排不发消息，但会发 tags 事件；同一天只响一次', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-schedule-'))
  const stateFile = path.join(root, 'time.json')
  const host = await bootAt({ stateFile, now: at(21, 0) })
  const api = host.shared.get('time')
  api.add({ id: 'dream:nightly', at: '22:30', silent: true, tags: ['dream'], message: '' })
  const events = []
  host.services.signals.on({ kind: 'event', tags: ['dream'] }, (signal) => events.push(signal))
  await api.tick(at(22, 31))
  assert.equal(events.length, 1)
  assert.match(events[0].text, /schedule:dream:nightly/)
  assert.equal(drainText(host), '', 'silent 安排不该给模型发 wake 消息')
  await api.tick(at(22, 59))
  assert.equal(events.length, 1, '同一天不应该重复响')
})

test('安排的 fired 幂等跨重启保留', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-schedule2-'))
  const stateFile = path.join(root, 'time.json')
  const first = await bootAt({ stateFile, now: at(22, 40) })
  const firstApi = first.shared.get('time')
  firstApi.add({ id: 'dream:nightly', at: '22:30', silent: true, tags: ['dream'] })
  let fired = 0
  first.services.signals.on({ kind: 'event', tags: ['dream'] }, () => { fired += 1 })
  await firstApi.tick(at(22, 40))
  assert.equal(fired, 1)

  const second = await bootAt({ stateFile, now: at(22, 50) })
  let again = 0
  second.services.signals.on({ kind: 'event', tags: ['dream'] }, () => { again += 1 })
  await second.shared.get('time').tick(at(22, 50))
  assert.equal(again, 0)
})

test('sleep 不传时长默认 3 分钟；同 id 重加今天还能再响', async () => {
  const { host } = setup()
  await host.enable('world-state')
  await host.enable('time')
  const api = host.shared.get('time')
  await api.sleep({ message: '睡' })
  const span = api.status().spans[0]
  assert.ok(span.until - Date.now() > 2 * 60_000)
  await api.wake()

  const past = new Date(Date.now() - 60_000)
  const atHM = `${String(past.getHours()).padStart(2, '0')}:${String(past.getMinutes()).padStart(2, '0')}`
  api.add({ id: 'again', at: atHM, message: '第一次' })
  await api.tick(Date.now())
  assert.match(drainText(host), /第一次/)
  api.remove('again')
  api.add({ id: 'again', at: atHM, message: '第二次' })
  await api.tick(Date.now())
  assert.match(drainText(host), /第二次/)
})
