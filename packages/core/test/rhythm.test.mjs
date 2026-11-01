// 节律是时钟：同一分钟只触发一次，重启后同一天不会再触发，错过会补。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../src/index.mjs'
import * as rhythm from '../../plugins/rhythm/src/index.mjs'
import rhythmManifest from '../../plugins/rhythm/manifest.json' with { type: 'json' }

function at(h, m, day = 1) {
  return new Date(2026, 10, day, h, m, 0, 0).getTime()
}

async function boot({ now, stateFile }) {
  const host = createHost({ log: () => {}, now: () => now })
  let clock = now
  host.registerPlugin(rhythmManifest, rhythm, { config: { dreamAt: '22:30', stateFile } })
  await host.enable('rhythm')
  return { host, rhythm: host.services && host.shared.get('rhythm'), setNow: (t) => { clock = t } }
}

test('到点触发一次，同一天再触发不会重复', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-rhythm-'))
  const stateFile = path.join(dir, 'rhythm.json')
  const host = createHost({ log: () => {}, now: () => at(22, 30) })
  host.registerPlugin(rhythmManifest, rhythm, { config: { dreamAt: '22:30', stateFile } })
  await host.enable('rhythm')
  const api = host.shared.get('rhythm')
  let count = 0
  api.onNightly(() => { count += 1 })
  assert.equal(api.fire(at(22, 30)).fired, true)
  assert.equal(count, 1)
  assert.equal(api.fire(at(22, 31)).fired, false, '同一天第二次不触发')
  assert.equal(count, 1)
})

test('isDue：到点且没发过才是 due', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-rhythm-due-'))
  const host = createHost({ log: () => {}, now: () => at(21, 0) })
  host.registerPlugin(rhythmManifest, rhythm, { config: { dreamAt: '22:30', stateFile: path.join(dir, 'r.json') } })
  await host.enable('rhythm')
  const api = host.shared.get('rhythm')
  assert.equal(api.isDue(at(21, 0)), false, '还没到点')
  assert.equal(api.isDue(at(22, 31)), true)
  api.fire(at(22, 31))
  assert.equal(api.isDue(at(22, 59)), false, '已经发过')
})

test('重启后同一天不会重复触发（状态落盘）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-rhythm2-'))
  const stateFile = path.join(dir, 'rhythm.json')
  const h1 = createHost({ log: () => {}, now: () => at(22, 40) })
  h1.registerPlugin(rhythmManifest, rhythm, { config: { dreamAt: '22:30', stateFile } })
  await h1.enable('rhythm')
  h1.shared.get('rhythm').fire(at(22, 40))
  assert.equal(h1.shared.get('rhythm').lastFiredDay(), '2026-11-01')

  // 第二个进程/重启：同一时刻
  const h2 = createHost({ log: () => {}, now: () => at(22, 50) })
  h2.registerPlugin(rhythmManifest, rhythm, { config: { dreamAt: '22:30', stateFile } })
  await h2.enable('rhythm')
  let count = 0
  h2.shared.get('rhythm').onNightly(() => { count += 1 })
  assert.equal(count, 0, '同一天重启不应该再触发')
})

test('第二天到点会触发', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-rhythm3-'))
  const stateFile = path.join(dir, 'rhythm.json')
  const h1 = createHost({ log: () => {}, now: () => at(22, 40, 1) })
  h1.registerPlugin(rhythmManifest, rhythm, { config: { dreamAt: '22:30', stateFile } })
  await h1.enable('rhythm')
  h1.shared.get('rhythm').fire(at(22, 40, 1))
  const h2 = createHost({ log: () => {}, now: () => at(22, 31, 2) })
  h2.registerPlugin(rhythmManifest, rhythm, { config: { dreamAt: '22:30', stateFile } })
  await h2.enable('rhythm')
  assert.equal(h2.shared.get('rhythm').isDue(at(22, 31, 2)), true, '第二天到点了')
  h2.shared.get('rhythm').fire(at(22, 31, 2))
  assert.equal(h2.shared.get('rhythm').lastFiredDay(), '2026-11-02')
})

test('nextAt 指向下一个时间点', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-rhythm4-'))
  const host = createHost({ log: () => {}, now: () => at(20, 0) })
  host.registerPlugin(rhythmManifest, rhythm, { config: { dreamAt: '22:30', stateFile: path.join(dir, 'r.json') } })
  await host.enable('rhythm')
  assert.equal(host.shared.get('rhythm').nextAt(at(20, 0)), at(22, 30))
})
