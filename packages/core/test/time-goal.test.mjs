// goal 与时间联动：创建、卸载释放 focus、到期结束、模型停下即 resume、时钟接管、单会话锁。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost, createSessionAdapter } from '../src/index.mjs'
import * as time from '../../plugins/time/src/index.mjs'
import * as world from '../../plugins/world-state/src/index.mjs'
import timeManifest from '../../plugins/time/manifest.json' with { type: 'json' }
import worldManifest from '../../plugins/world-state/manifest.json' with { type: 'json' }

async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-goal-'))
  const host = createHost({ log: () => {} })
  host.registerPlugin(worldManifest, world, {})
  host.registerPlugin(timeManifest, time, { config: { stateFile: path.join(root, 'time.json'), tickMs: 3600_000 } })
  await host.enable('world-state')
  await host.enable('time')
  return { host, api: host.shared.get('time') }
}

function drainText(host) {
  return host.services.delivery.drain('session').map((b) => b.text).join('\n')
}

test('创建目标会发一条 goal 消息', async () => {
  const { host, api } = await setup()
  api.addGoal({ theme: '玩我的世界', afterMin: 30 })
  assert.match(drainText(host), /你在目标内：玩我的世界/)
  assert.equal(api.goals().length, 1)
})

test('卸载目标会释放它绑定的 focus', async () => {
  const { host, api } = await setup()
  const goal = api.addGoal({ theme: '写代码', afterMin: 30, focus: 'coding' })
  assert.ok(host.services.focus.list().some((l) => l.label === 'coding'), '应进入 coding 注意力空间')
  api.removeGoal(goal.id)
  assert.ok(!host.services.focus.list().some((l) => l.label === 'coding'), '卸载后应释放')
})

test('目标到期会发"目标结束"', async () => {
  const { host, api } = await setup()
  const deadline = Date.now() + 1_000
  const goal = api.addGoal({ theme: '限时任务', until: new Date(deadline).toISOString() })
  assert.ok(goal.until >= deadline)
  await api.tick(deadline + 1_000)
  assert.match(drainText(host), /目标结束：限时任务/)
  assert.equal(api.goals().length, 0)
})

test('会话停下会立即 resume 目标', async () => {
  const { host, api } = await setup()
  api.addGoal({ theme: '持续刷题', afterMin: 30 })
  drainText(host) // 清掉开始消息
  const adapter = createSessionAdapter({ sessionId: 's1', host, push: () => {} })
  await adapter.drainOnce()
  assert.match(drainText(host), /你在目标内：持续刷题/)
  adapter.dispose()
})

test('时钟可以被时间模块接管', async () => {
  const { host, api } = await setup()
  api.setClock(() => 1_800_000_000_000)
  assert.equal(host.services.clock.owns(), true)
  assert.equal(api.now(), 1_800_000_000_000, '时间模块读到的应是接管后的时钟')
})

test('单会话锁：第二个会话直接被拒绝', () => {
  const host = createHost({ log: () => {} })
  const release = host.claimSession('s1')
  assert.throws(() => host.claimSession('s2'), /已经指向会话/)
  release()
  assert.doesNotThrow(() => host.claimSession('s2'))
})


test('goal+single 用轮次上限，用完发"目标结束"', async () => {
  const { host, api } = await setup()
  drainText(host)
  api.addGoal({ theme: '一次任务', turnLimit: 1 })
  api.resumeGoals()
  assert.match(drainText(host), /你在目标内：一次任务（还剩 0 轮）/)
  api.resumeGoals()
  assert.match(drainText(host), /目标结束：一次任务/)
  assert.equal(api.goals().length, 0)
})

test('取消进行中的睡觉会结束睡眠', async () => {
  const { host, api } = await setup()
  await api.sleep({ message: '睡', durationMin: 30 })
  const span = api.status().spans[0]
  const tool = host.services.tools.list().find((t) => t.name === 'time_cancel')
  await tool.execute({ id: span.id })
  assert.equal(api.phase(), 'awake')
})
