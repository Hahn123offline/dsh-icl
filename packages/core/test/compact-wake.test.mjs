// B：compactWake（lab-only，默认关）。
// 只压唤醒提示的 orientation；payload（未读/积压/危险/sleep brief）原样保留。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../src/index.mjs'
import * as time from '../../plugins/time/src/index.mjs'
import timeManifest from '../../plugins/time/manifest.json' with { type: 'json' }

const T0 = new Date(2026, 10, 2, 9, 0, 0).getTime()

async function boot({ now = () => Date.now(), config = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-compact-wake-'))
  const host = createHost({ log: () => {}, now })
  host.registerPlugin(timeManifest, time, { config: { stateFile: path.join(root, 'time.json'), tickMs: 3_600_000, awakeTick: { enabled: false }, goalResumeMinGapSec: 0, ...config } })
  await host.enable('time')
  return { host, root, api: host.shared.get('time') }
}

function drainText(host) {
  return host.services.delivery.drain('session').map((batch) => batch.text).join('\n')
}

async function fireSchedule(host, api, virtualNow, id, message) {
  api.add({ id, in: '1m', message })
  virtualNow.value += 61_000
  api.tick()
  return drainText(host)
}

test('compactWake 默认关：wake 始终 full，wakeCount 仍计数', async () => {
  const virtualNow = { value: T0 }
  const { host, api } = await boot({ now: () => virtualNow.value })
  assert.equal(api.status().wake.enabled, false)
  assert.equal(api.wake.count(), 0)
  const first = await fireSchedule(host, api, virtualNow, 'w1', '第一次')
  assert.equal(first, '第一次')
  assert.equal(api.wake.count(), 1)
  const second = await fireSchedule(host, api, virtualNow, 'w2', '第二次')
  assert.equal(second, '第二次', '关掉时不做 compact')
  assert.equal(api.wake.count(), 2)
})

test('compactWake 开启：首次 full，之后 6 行 compact + payload 原样', async () => {
  const virtualNow = { value: T0 }
  const { host, api } = await boot({ now: () => virtualNow.value, config: { compactWake: { enabled: true, after: 1, maxChars: 400, fullEvery: 20 } } })
  const first = await fireSchedule(host, api, virtualNow, 'w1', '第一次全量内容')
  assert.equal(first, '第一次全量内容', 'wakeCount=0 首次 full')
  const second = await fireSchedule(host, api, virtualNow, 'w2', '第二次具体内容')
  assert.match(second, /^〔提醒〕你在 ICL（小千）。/)
  assert.match(second, /现在：2026-11-02 周一 上午，醒着。/)
  assert.match(second, /焦点：无；目标：无。/)
  assert.match(second, /积压：0 条（危险 0 条已置顶）。/)
  assert.match(second, /上次：/)
  assert.match(second, /继续；下面的新内容优先。/)
  assert.match(second, /\n---\n第二次具体内容$/, 'payload 原样保留')
  const orientation = second.split('\n---\n')[0]
  assert.ok(orientation.length <= 400, `orientation ≤400 字符（实际 ${orientation.length}）`)
  assert.equal(orientation.split('\n').length, 6)
  assert.equal(api.wake.count(), 2)
})

test('compactWake fullEvery=20：第 21 次唤醒重新 full', async () => {
  const virtualNow = { value: T0 }
  const { host, api } = await boot({ now: () => virtualNow.value, config: { compactWake: { enabled: true, after: 1, fullEvery: 20 } } })
  await fireSchedule(host, api, virtualNow, 'w1', 'W1') // full, count=1
  for (let i = 2; i <= 20; i += 1) {
    const text = await fireSchedule(host, api, virtualNow, `w${i}`, `W${i}`)
    assert.match(text, /〔提醒〕/, `第 ${i} 次应是 compact`)
  }
  assert.equal(api.wake.count(), 20)
  const text21 = await fireSchedule(host, api, virtualNow, 'w21', 'W21')
  assert.equal(text21, 'W21', 'count=20（%20==0）时插一次 full 防漂移')
  assert.equal(api.wake.count(), 21)
})

test('睡醒第一声 reset 为 full；之后恢复 compact', async () => {
  const virtualNow = { value: T0 }
  const { host, api } = await boot({ now: () => virtualNow.value, config: { compactWake: { enabled: true, after: 1, fullEvery: 20 } } })
  await fireSchedule(host, api, virtualNow, 'w1', 'W1')
  await fireSchedule(host, api, virtualNow, 'w2', 'W2') // compact, count=2
  assert.ok(api.wake.count() >= 2)
  api.sleep({ message: '睡', durationMin: 1 })
  drainText(host)
  virtualNow.value += 61_000
  api.tick()
  const wakeText = drainText(host)
  assert.match(wakeText, /整理完了/)
  assert.ok(!wakeText.includes('〔提醒〕'), '睡醒第一声必须是 full')
  assert.equal(api.wake.count(), 1, 'reset 后从 1 开始')
  const after = await fireSchedule(host, api, virtualNow, 'w3', 'W3')
  assert.match(after, /〔提醒〕/)
})

test('compact 的 goal resume 保留目标 payload', async () => {
  const virtualNow = { value: T0 }
  const { host, api } = await boot({ now: () => virtualNow.value, config: { compactWake: { enabled: true, after: 1 } } })
  api.wake.bump()
  api.wake.bump()
  const goal = api.addGoal({ theme: '把矿挖完', resumeLimit: 10 })
  drainText(host)
  api.resumeGoals()
  const text = drainText(host)
  assert.match(text, /^〔提醒〕/)
  assert.match(text, /\n---\n目标续推：id=g-/, 'goal payload 不被压缩')
  assert.match(text, /把矿挖完/)
  assert.ok(api.wake.count() >= 3)
})

test('compact 的 backlog 只压 preamble，条目/危险原样', async () => {
  const virtualNow = { value: T0 }
  const { host, api } = await boot({ now: () => virtualNow.value, config: { compactWake: { enabled: true, after: 1 } } })
  api.wake.bump()
  api.mute({ minutes: 5 })
  host.services.signals.offer({ from: { plugin: 'qq' }, kind: 'content', text: '普通消息甲', focus: 'qq:private:1' })
  host.services.signals.offer({ from: { plugin: 'mc' }, kind: 'event', text: '危险：掉血', tags: ['safety', 'alarm'] })
  api.unmute('manual')
  const text = drainText(host)
  assert.match(text, /积压 2 条（危险 1 条置顶）/, 'compact preamble')
  assert.match(text, /普通消息甲/, '每条积压原文保留')
  assert.match(text, /危险：掉血/)
  assert.match(text, /⚠ \[mc\/signal\] 危险：掉血/, '危险条目仍置顶带 ⚠')
})

test('api.wake.count/bump/reset 与 time-events wake-class 可观测', async () => {
  const virtualNow = { value: T0 }
  const { host, root, api } = await boot({ now: () => virtualNow.value, config: { compactWake: { enabled: true } } })
  assert.equal(api.wake.count(), 0)
  assert.equal(api.wake.bump(), 1)
  assert.equal(api.wake.bump(), 2)
  assert.equal(api.wake.count(), 2)
  assert.equal(api.wake.reset(), 0)
  await fireSchedule(host, api, virtualNow, 'w1', 'W1')
  const events = fs.readFileSync(path.join(root, 'time-events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.ok(events.some((event) => event.type === 'wake-class' && event.producer === 'schedule:w1' && event.mode === 'full'))
  assert.equal(api.wake.stats().sent >= 1, true)
})
