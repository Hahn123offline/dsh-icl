import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createBody } from '../src/body.mjs'
import { createHttpServer } from '../src/server.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(fn, timeout = 2500, label = 'condition') {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const value = fn()
    if (value) return value
    await sleep(5)
  }
  throw new Error(`wait timeout: ${label}`)
}

// 假身体：只实现 body 依赖的 adapter 面；测试可以改 state 或覆盖方法。
function fakeAdapter() {
  const state = {
    connected: false,
    chats: [],
    emergencies: [],
    runTaskCalls: [],
    position: { x: 0, y: 64, z: 0 },
    health: 20,
    food: 20,
    oxygen: 20,
    submerged: false,
    danger: null,
    hostiles: [],
    packetSilentMs: 0,
  }
  const adapter = {
    state,
    connect: async () => { state.connected = true },
    disconnect: async () => { state.connected = false },
    status: () => ({
      connected: state.connected,
      self: 'Fake',
      position: state.position,
      health: state.health,
      food: state.food,
      oxygen: state.oxygen,
      submerged: state.submerged,
      danger: state.danger ?? { blocks: [] },
      packetSilentMs: state.packetSilentMs,
      inventoryCount: 0,
      nearby: {},
      nearbyHostiles: state.hostiles ?? [],
    }),
    chat: async (text) => { state.chats.push(text) },
    inspect: async (kind) => ({ text: `fake:${kind}` }),
    emergency: async (reason) => { state.emergencies.push(reason) },
    async runTask(task, { signal, progress }) {
      state.runTaskCalls.push({ id: task.id, kind: task.kind, params: task.params })
      if (task.params.hang) {
        await new Promise((_, reject) => {
          if (signal.aborted) return reject(signal.reason)
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }
      const count = Number(task.params.count) || 1
      for (let i = 1; i <= count; i += 1) {
        if (signal.aborted) throw signal.reason
        await sleep(5)
        progress?.({ done: i, total: count })
      }
      return { done: count }
    },
  }
  return adapter
}

async function startedBody(options = {}) {
  const adapter = options.adapter ?? fakeAdapter()
  const body = createBody({ adapter, ...options })
  await body.start()
  return { body, adapter }
}

test('body：任务立即排队，完成发事件', async () => {
  const { body } = await startedBody()
  const task = body.createTask({ kind: 'mine', params: { count: 3 } })
  assert.equal(task.state, 'queued')
  await waitFor(() => body.getTask(task.id)?.state === 'done', 2000, 'done')
  assert.deepEqual(body.getTask(task.id).result, { done: 3 })
  assert.equal(body.getTask(task.id).outcomeUnknown, false)
  assert.ok(body.eventsSince(0).events.some((e) => e.type === 'task_done'))
  await body.stop()
})

test('body：idempotencyKey 不重复执行（含完成后与跨重启）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-body-idem-'))
  const stateFile = path.join(root, 'tasks.json')
  const { body } = await startedBody({ stateFile })
  const a = body.createTask({ idempotencyKey: 'k1', kind: 'mine', params: { count: 1 } })
  const b = body.createTask({ idempotencyKey: 'k1', kind: 'mine', params: { count: 99 } })
  assert.equal(a.id, b.id)
  await waitFor(() => body.getTask(a.id)?.state === 'done', 2000, 'done')
  const c = body.createTask({ idempotencyKey: 'k1', kind: 'mine', params: { count: 1 } })
  assert.equal(c.id, a.id)
  assert.equal(body.listTasks().filter((t) => t.idempotencyKey === 'k1').length, 1)
  await body.stop()

  // 重启后同一个 key 仍返回原任务，不重跑
  const second = await startedBody({ stateFile })
  const d = second.body.createTask({ idempotencyKey: 'k1', kind: 'mine', params: { count: 1 } })
  assert.equal(d.id, a.id)
  assert.equal(d.state, 'done')
  await second.body.stop()
})

test('body：取消 running / queued / 已结束任务是边界安全的', async () => {
  const { body } = await startedBody()
  const running = body.createTask({ kind: 'mine', params: { hang: true } })
  await waitFor(() => body.getTask(running.id)?.state === 'running', 2000, 'running')
  const queued = body.createTask({ kind: 'mine', params: { count: 1 } })
  body.cancelTask(queued.id, 'user')
  assert.equal(body.getTask(queued.id).state, 'cancelled')
  body.cancelTask(running.id, 'user')
  await waitFor(() => body.getTask(running.id)?.state === 'cancelled', 2000, 'cancelled')
  // 已结束的再取消：原样返回，不产生第二个终态事件
  const before = body.getTask(running.id)
  const after = body.cancelTask(running.id, 'again')
  assert.equal(after.state, 'cancelled')
  assert.equal(after.error, before.error)
  const terminalEvents = body.eventsSince(0).events.filter((e) => e.type === 'task_cancelled').length
  assert.equal(terminalEvents, 2)
  await body.stop()
})

test('body：deadline 超时 = unknown（不是失败也不是成功）', async () => {
  const { body } = await startedBody()
  const task = body.createTask({ kind: 'mine', params: { hang: true }, deadlineMs: 1000 })
  await waitFor(() => body.getTask(task.id)?.state === 'unknown', 3000, 'unknown')
  const done = body.getTask(task.id)
  assert.equal(done.error, 'timeout')
  assert.equal(done.outcomeUnknown, true)
  assert.ok(!['done', 'failed'].includes(done.state))
  assert.ok(body.eventsSince(0).events.some((e) => e.type === 'task_unknown'))
  await body.stop()
})

test('body：断线暂停 running 任务，重连不自动续跑，必须显式 resume', async () => {
  const { body } = await startedBody()
  const running = body.createTask({ kind: 'mine', params: { hang: true } })
  await waitFor(() => body.getTask(running.id)?.state === 'running', 2000, 'running')
  const queued = body.createTask({ kind: 'mine', params: { count: 1 } })

  body.ingest('disconnected', { reason: 'socket closed', willReconnect: true })
  await waitFor(() => body.getTask(running.id)?.state === 'paused', 2000, 'paused')
  assert.equal(body.getTask(running.id).pausedReason, 'disconnect')
  assert.equal(body.status().paused, true)
  assert.equal(body.status().pausedReason, 'disconnect')
  assert.equal(body.status().pausedTasks.length, 1, '断线挂起的任务在 status.pausedTasks 里可查')
  assert.equal(body.status().pausedTasks[0].id, running.id)
  assert.equal(body.status().connected, false)
  // 断线时排队任务保持 queued（没跑过，不该被算成失败/中断）
  assert.equal(body.getTask(queued.id).state, 'queued')
  assert.throws(() => body.createTask({ kind: 'mine', params: { count: 1 } }), /暂停/)
  assert.throws(() => body.resume(), /未连接/)

  body.ingest('reconnected', {})
  await waitFor(() => body.status().connected === true, 2000, 'reconnected')
  assert.equal(body.status().paused, true, '重连后仍暂停')
  assert.equal(body.getTask(running.id).state, 'paused', '断线任务不自动续跑')
  assert.ok(body.eventsSince(0).events.some((e) => e.type === 'offline'))
  assert.ok(body.eventsSince(0).events.some((e) => e.type === 'reconnected'))
  assert.ok(body.eventsSince(0).events.some((e) => e.type === 'resume_required'))

  // 显式恢复身体 → 只有排队过的任务会跑；断线前 running 的任务要显式 resumeTask
  body.resume()
  await waitFor(() => body.getTask(queued.id)?.state === 'done', 2500, 'queued done')
  assert.equal(body.getTask(running.id).state, 'paused')
  await body.stop()
})

test('body：暂停任务的显式 resumeTask 重新入队', async () => {
  const { body } = await startedBody()
  const task = body.createTask({ kind: 'mine', params: { hang: true } })
  await waitFor(() => body.getTask(task.id)?.state === 'running', 2000, 'running')
  body.ingest('disconnected', { reason: 'socket' })
  await waitFor(() => body.getTask(task.id)?.state === 'paused', 2000, 'paused')
  body.ingest('reconnected', {})
  body.resume()
  // 改掉 hang 参数，resume 后能完成（模拟“复核后继续”）
  const paused = body.resumeTask(task.id)
  assert.equal(paused.state, 'queued')
  assert.ok(body.eventsSince(0).events.some((e) => e.type === 'task_resumed'))
  await body.stop()
})

test('body：重连耗尽 → 保持离线+暂停，不假在线', async () => {
  const { body } = await startedBody()
  body.ingest('disconnected', { reason: 'end' })
  body.ingest('reconnect_exhausted', { attempts: 3, reason: 'end' })
  const status = body.status()
  assert.equal(status.connected, false)
  assert.equal(status.safety.offline, true)
  assert.equal(status.paused, true)
  assert.equal(status.pausedReason, 'reconnect-exhausted')
  assert.ok(body.eventsSince(0).events.some((e) => e.type === 'reconnect_exhausted'))
  await body.stop()
})

test('body：出生点不安全 → 暂停 + 报警 + 不接任务', async () => {
  const { body } = await startedBody()
  body.ingest('spawn_unsafe', { feet: 'lava', head: 'air', below: 'stone', position: { x: 0, y: 64, z: 0 } })
  assert.equal(body.status().paused, true)
  assert.equal(body.status().pausedReason, 'spawn-unsafe')
  assert.ok(body.eventsSince(0).events.some((e) => e.type === 'safety_stop' && e.data.reason === 'spawn-unsafe'))
  assert.ok(body.eventsSince(0).events.some((e) => e.type === 'spawn_unsafe'))
  assert.throws(() => body.createTask({ kind: 'mine', params: { count: 1 } }), /暂停/)
  await body.stop()
})

test('body：看门狗低血/掉血自动暂停（走 status 轮询）', async () => {
  const adapter = fakeAdapter()
  const { body } = await startedBody({ adapter, watchdogMs: 10 })
  adapter.state.health = 5
  await waitFor(() => body.status().paused, 1000, 'paused')
  assert.equal(body.status().pausedReason, 'low-health')
  assert.ok(body.eventsSince(0).events.some((e) => e.type === 'watchdog' && e.data.kind === 'low-health'))
  await body.stop()
})

test('body：看门狗低氧与危险方块也会暂停', async () => {
  const adapter = fakeAdapter()
  const { body } = await startedBody({ adapter, watchdogMs: 10, lowHealth: 0 })
  adapter.state.oxygen = 4
  adapter.state.submerged = true
  await waitFor(() => body.status().paused, 1000, 'oxygen')
  assert.equal(body.status().pausedReason, 'low-oxygen')
  await body.stop()

  const adapter2 = fakeAdapter()
  const second = await startedBody({ adapter: adapter2, watchdogMs: 10, lowHealth: 0 })
  adapter2.state.danger = { blocks: [{ name: 'lava', at: { x: 0, y: 63, z: 0 }, distance: 1 }] }
  await waitFor(() => second.body.status().paused, 1000, 'danger')
  assert.equal(second.body.status().pausedReason, 'danger-block')
  await second.body.stop()
})

test('body：看门狗卡住判据看是否靠近目标', async () => {
  const adapter = fakeAdapter()
  const { body } = await startedBody({ adapter, watchdogMs: 10, movementStallMs: 80, lowHealth: 0 })
  const task = body.createTask({ kind: 'goto', params: { x: 100, y: 64, z: 0, hang: true } })
  await waitFor(() => body.getTask(task.id)?.state === 'running', 2000, 'running')
  await waitFor(() => body.status().paused, 1500, 'stuck pause')
  assert.equal(body.status().pausedReason, 'stuck')
  assert.ok(body.eventsSince(0).events.some((e) => e.type === 'watchdog' && e.data.kind === 'stuck'))
  const status = body.getTask(task.id)
  assert.equal(status.state, 'interrupted')
  await body.stop()
})

test('body：心跳在长时间无事件时触发', async () => {
  const { body } = await startedBody({ watchdogMs: 10, heartbeatMs: 100 })
  await waitFor(() => body.eventsSince(0).events.some((e) => e.type === 'heartbeat'), 2500, 'heartbeat')
  const stat = body.status().watchdog
  assert.ok(stat.heartbeat.intervalMs >= 100)
  assert.ok(stat.lastEventAt > 0)
  await body.stop()
})

test('body：danger 告警穿透配额（alarm+pierce），idle 心跳仍受限流但可统计', async () => {
  const adapter = fakeAdapter()
  const { body } = await startedBody({
    adapter, watchdogMs: 10, lowHealth: 10, dangerAlertPerMinute: 2, idleAlertPerMinute: 1, heartbeatMs: 10, alertWindowMs: 60_000,
  })
  adapter.state.health = 5
  // danger 告警不能因为 2 次/分配额被静默：第一条以 alarm/pierce 投递。
  await waitFor(() => body.eventsSince(0).events.some((e) => e.type === 'watchdog' && e.data?.kind === 'low-health'), 3000, 'danger alarm delivered')
  const alarm = body.eventsSince(0).events.find((e) => e.type === 'watchdog' && e.data?.kind === 'low-health')
  assert.equal(alarm.data.priority, 'alarm')
  assert.equal(alarm.data.pierce, true)
  assert.equal(alarm.priority, 'alarm', 'top-level priority')
  assert.equal(alarm.pierce, true, 'top-level pierce')
  assert.equal(alarm.data.meta?.pierce, true, 'meta pierce')
  // 15s 去重被拦要记账（alarm_suppressed）且之后可补投：暂停中再报两次更严重事件。
  body.ingest('spawn_unsafe', { position: { x: 1, y: 64, z: 1 } })
  body.ingest('spawn_unsafe', { position: { x: 1, y: 64, z: 1 } })
  assert.ok(body.eventsSince(0).events.some((e) => e.type === 'alarm_suppressed' && e.data?.type === 'safety_stop'))
  const stats = body.status().watchdog
  assert.equal(stats.limits.danger, 2)
  assert.equal(stats.limits.idle, 1)
  // idle 心跳仍受 idle 配额限制，但至少有 1 条（danger 告警不把 idle 全压死）
  const events = body.eventsSince(0).events
  const heartbeats = events.filter((e) => e.type === 'heartbeat').length
  assert.ok(heartbeats >= 1)
  await body.stop()
})

test('body：暂停时写动作被拒，感知/取消/恢复仍可用', async () => {
  const { body } = await startedBody()
  // 造一个“断线挂起”的任务：身体 paused、任务 paused，此时取消必须是安全动作。
  const pausedTask = body.createTask({ kind: 'mine', params: { hang: true } })
  await waitFor(() => body.getTask(pausedTask.id)?.state === 'running', 2000, 'running')
  body.ingest('disconnected', { reason: 'socket' })
  await waitFor(() => body.getTask(pausedTask.id)?.state === 'paused', 2000, 'paused')
  assert.equal(body.status().paused, true)
  assert.throws(() => body.createTask({ kind: 'mine', params: { count: 1 } }), /暂停/)
  await assert.doesNotReject(() => body.doPlan([{ op: 'look' }]))
  await assert.doesNotReject(() => body.doPlan([{ op: 'tasks' }]))
  // 取消是安全动作：暂停态也必须允许（当事人预期“取消任务像撤回消息”）。
  await assert.doesNotReject(() => body.doPlan([{ op: 'cancel', taskId: pausedTask.id }]))
  assert.equal(body.getTask(pausedTask.id)?.state, 'cancelled')
  await assert.rejects(() => body.doPlan([{ op: 'move', x: 1, y: 64, z: 1 }]), /暂停/)
  body.ingest('reconnected', {})
  assert.equal(body.resume().paused, false)
  assert.doesNotThrow(() => body.createTask({ kind: 'mine', params: { count: 1 } }))
  await body.stop()
})

test('body：routine 的 deadline 跟随 duration', async () => {
  const { body } = await startedBody()
  const task = body.createTask({ kind: 'routine', params: { durationMs: 5000 } })
  assert.ok(task.deadlineAt >= task.createdAt + 30_000)
  const quick = body.createTask({ kind: 'mine', params: { count: 1 }, deadlineMs: 1 })
  assert.ok(quick.deadlineAt >= quick.createdAt + 1000, 'deadline 至少 1s')
  await body.stop()
})

test('body：任务台账跨重启保留；running/paused → interrupted(body-restart)；unknown 保留', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-body-ledger-'))
  const stateFile = path.join(root, 'tasks.json')
  const first = await startedBody({ stateFile })
  const done = first.body.createTask({ idempotencyKey: 'ledger-1', kind: 'mine', params: { count: 1 } })
  await waitFor(() => first.body.getTask(done.id)?.state === 'done', 2000, 'done')
  const timedOut = first.body.createTask({ kind: 'mine', params: { hang: true }, deadlineMs: 1000 })
  await waitFor(() => first.body.getTask(timedOut.id)?.state === 'unknown', 3000, 'unknown')
  await first.body.stop()

  const second = await startedBody({ stateFile })
  assert.equal(second.body.getTask(done.id)?.state, 'done', 'done 跨重启保留')
  assert.equal(second.body.getTask(timedOut.id)?.state, 'unknown', 'unknown 跨重启保留（结果未知，不能改写）')
  const running = second.body.createTask({ kind: 'mine', params: { hang: true } })
  await waitFor(() => second.body.getTask(running.id)?.state === 'running', 2000, 'running 2')
  const queued = second.body.createTask({ kind: 'mine', params: { hang: true } })
  assert.equal(second.body.getTask(queued.id)?.state, 'queued')
  second.body.ingest('disconnected', { reason: 'socket' })
  await waitFor(() => second.body.getTask(running.id)?.state === 'paused', 2000, 'paused')
  // 没跑过的排队任务保持 queued（断线只暂停正在跑的任务）
  assert.equal(second.body.getTask(queued.id)?.state, 'queued')
  await second.body.stop()

  const third = await startedBody({ stateFile })
  assert.equal(third.body.getTask(running.id)?.state, 'interrupted')
  assert.equal(third.body.getTask(running.id)?.error, 'body-restart')
  assert.equal(third.body.getTask(queued.id)?.state, 'interrupted')
  assert.equal(third.body.getTask(queued.id)?.error, 'body-restart')
  await third.body.stop()
})

test('body：安全停止中断 running 与 queued', async () => {
  const { body } = await startedBody()
  const task = body.createTask({ kind: 'mine', params: { hang: true } })
  await waitFor(() => body.getTask(task.id)?.state === 'running', 2000, 'running')
  const queued = body.createTask({ kind: 'mine', params: { count: 1 } })
  body.ingest('health', { health: 5 })
  await waitFor(() => body.getTask(task.id)?.state === 'interrupted', 2000, 'interrupted')
  assert.equal(body.getTask(queued.id).state, 'interrupted')
  assert.equal(body.status().paused, true)
  assert.ok(body.eventsSince(0).events.some((e) => e.type === 'safety_stop'))
  assert.equal(body.status().safety.reason, 'low-health')
  await body.stop()
})

test('body：do 的 task op 接受 params.kind', async () => {
  const { body } = await startedBody()
  const out = await body.doPlan([{ op: 'task', params: { kind: 'mine', block: 'dirt' } }])
  assert.equal(out.task.kind, 'mine')
  assert.equal(out.task.params.block, 'dirt')
  await waitFor(() => body.getTask(out.task.id)?.state === 'done', 2000, 'done')
  await body.stop()
})

test('body：chat 限速且拒绝命令', async () => {
  const { body, adapter } = await startedBody({ allowSay: true, chatRateMs: 30 })
  await assert.rejects(() => body.chat('/kill @e'), /命令/)
  assert.equal((await body.chat('在')).ok, true)
  assert.equal(adapter.state.chats.at(-1), '在')
  await assert.rejects(() => body.chat('再来一条'), /太快/)
  await sleep(40)
  assert.equal((await body.chat('再来一条')).ok, true)
  await body.stop()
})

test('body：事件 seq 单调、since 游标只取新事件', async () => {
  const { body } = await startedBody()
  const task = body.createTask({ kind: 'mine', params: { count: 1 } })
  await waitFor(() => body.getTask(task.id)?.state === 'done', 2000, 'done')
  const all = body.eventsSince(0)
  assert.ok(all.events.length >= 4)
  let last = 0
  for (const event of all.events) {
    assert.ok(event.seq > last, 'seq 单调递增')
    last = event.seq
  }
  const cursor = all.seq - 1
  const tail = body.eventsSince(cursor)
  assert.ok(tail.events.length >= 1)
  assert.ok(tail.events.every((e) => e.seq > cursor))
  await body.stop()
})

test('body：adapter 结构化失败 → task_failed 且保留 result/reason', async () => {
  const adapter = fakeAdapter()
  adapter.runTask = async () => {
    const error = new Error('mine: no-target')
    error.name = 'TaskFailedError'
    error.result = { mined: 0, reason: 'mine: no-target' }
    throw error
  }
  const { body } = await startedBody({ adapter })
  const task = body.createTask({ kind: 'mine', params: { block: 'diamond_ore' } })
  await waitFor(() => body.getTask(task.id)?.state === 'failed', 2000, 'failed')
  const failed = body.getTask(task.id)
  assert.equal(failed.error, 'mine: no-target')
  assert.deepEqual(failed.result, { mined: 0, reason: 'mine: no-target' })
  assert.ok(body.eventsSince(0).events.some((e) => e.type === 'task_failed'))
  await body.stop()
})

test('body：暂停超时触发 idle_disconnect + 宿主退出钩子（退出归因）', async () => {
  const idle = []
  const adapter = fakeAdapter()
  const body = createBody({
    adapter, watchdogMs: 500, pausedDisconnectMs: 60,
    onIdleDisconnect: (info) => idle.push(info),
  })
  await body.start()
  body.ingest('stuck', {})
  assert.equal(body.status().paused, true)
  await waitFor(() => idle.length === 1, 2000, 'idle hook')
  assert.equal(idle[0].reason, 'stuck')
  assert.ok(body.eventsSince(0).events.some((e) => e.type === 'idle_disconnect'))
  await body.stop()
})

test('body：/v1/shutdown 请求交给宿主退出钩子（reason 归因）', async () => {
  let requested = null
  const adapter = fakeAdapter()
  const body = createBody({ adapter, onShutdownRequest: async (reason) => { requested = reason; return { ok: true, willExit: true } } })
  await body.start()
  const result = await body.shutdownRequest('lab-done')
  assert.equal(result.ok, true)
  assert.equal(requested, 'lab-done')
  assert.ok(body.eventsSince(0).events.some((e) => e.type === 'shutdown_requested' && e.data.reason === 'lab-done'))
  await body.stop()
})

test('body：小掉血只记录不暂停，单次掉>3 才接管', async () => {
  const adapter = fakeAdapter()
  const { body } = await startedBody({ adapter, watchdogMs: 10 })
  await waitFor(() => body.status().watchdog.ticks >= 1, 2000, 'watchdog baseline')
  adapter.state.health = 18 // 20 → 18：摔一下/挖树蹭伤，正常玩法
  await waitFor(() => body.eventsSince(0).events.some((e) => e.type === 'health_drop' && e.data.drop === 2), 2500, 'small drop event')
  assert.equal(body.status().paused, false, '小掉血不应暂停')
  adapter.state.health = 12 // 18 → 12：单次掉 6，接管
  await waitFor(() => body.status().paused, 2500, 'big drop pause')
  assert.equal(body.status().pausedReason, 'health-drop')
  await body.stop()
})

test('body：已暂停后不再刷 health_drop，只计 suppressed', async () => {
  const adapter = fakeAdapter()
  const { body } = await startedBody({ adapter, watchdogMs: 10 })
  // 先让看门狗跑过至少一拍，拿到 health 基线（否则第一次变化没有 previous）。
  await waitFor(() => body.status().watchdog.ticks >= 1, 2000, 'watchdog baseline')
  body.ingest('stuck', {}) // 先暂停，且原因不是 low-health
  assert.equal(body.status().paused, true)
  await waitFor(() => body.status().watchdog.ticks >= 2, 2000, 'watchdog tick 2')
  adapter.state.health = 18
  await waitFor(() => (body.status().watchdog.healthDropSuppressed ?? 0) >= 1, 2500, 'health drop suppressed 1')
  adapter.state.health = 16
  await waitFor(() => (body.status().watchdog.healthDropSuppressed ?? 0) >= 2, 2500, 'health drop suppressed 2')
  assert.equal(body.eventsSince(0).events.filter((e) => e.type === 'health_drop').length, 0)
  await body.stop()
})

test('body：HTTP 契约（status 不假在线、任务、事件、inspect、do、resume）', async () => {
  const { body } = await startedBody()
  const http = createHttpServer(body, { port: 0 })
  const server = await http.listen()
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`
  const getJson = async (pathname) => (await fetch(`${base}${pathname}`)).json()
  const postJson = async (pathname, payload) => (await fetch(`${base}${pathname}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload ?? {}),
  })).json()
  try {
  const status = await getJson('/v1/status')
  assert.equal(status.version, 'mc-body/v1')
  assert.equal(status.connected, true)
  assert.equal(status.paused, false)
  assert.ok(status.watchdog)

  const created = await postJson('/v1/tasks', { kind: 'mine', params: { count: 1 } })
  assert.equal(created.ok, true)
  await waitFor(() => body.getTask(created.task.id)?.state === 'done', 2000, 'done')
  const events = await getJson('/v1/events?since=0')
  assert.ok(events.events.length > 0)

  const inspect = await postJson('/v1/inspect', { kind: 'inventory' })
  assert.equal(inspect.result.text, 'fake:inventory')
  const plan = await postJson('/v1/do', { steps: [{ op: 'look' }] })
  assert.equal(plan.results[0].result.text, 'fake:look')

  // 断线：HTTP 状态栏立刻变成未连接 + 暂停
  body.ingest('disconnected', { reason: 'socket' })
  const offline = await getJson('/v1/status')
  assert.equal(offline.connected, false)
  assert.equal(offline.paused, true)
  const rejected = await postJson('/v1/tasks', { kind: 'mine', params: { count: 1 } })
  assert.equal(rejected.ok, false)

  body.ingest('reconnected', {})
  const resumed = await postJson('/v1/safety/resume')
  assert.equal(resumed.ok, true)
  const again = await postJson('/v1/tasks', { kind: 'mine', params: { hang: true } })
  assert.equal(again.ok, true)
  const pausedAgain = await postJson(`/v1/tasks/${again.task.id}/cancel`, {})
  assert.equal(pausedAgain.ok, true)
  } finally {
    await http.close().catch(() => {})
    await body.stop().catch(() => {})
  }
})

test('body：HTTP 暂停任务显式 resume 端点', async () => {
  const { body } = await startedBody()
  const http = createHttpServer(body, { port: 0 })
  const server = await http.listen()
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`
  const postJson = async (pathname, payload) => (await fetch(`${base}${pathname}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload ?? {}),
  })).json()
  try {
    const task = body.createTask({ kind: 'mine', params: { hang: true } })
    await waitFor(() => body.getTask(task.id)?.state === 'running', 2000, 'running')
    body.ingest('disconnected', { reason: 'socket' })
    await waitFor(() => body.getTask(task.id)?.state === 'paused', 2000, 'paused')
    body.ingest('reconnected', {})
    assert.equal((await postJson('/v1/safety/resume')).ok, true)
    const resumed = await postJson(`/v1/tasks/${task.id}/resume`)
    assert.equal(resumed.ok, true)
    assert.ok(['queued', 'running'].includes(resumed.task.state))
    const cancelled = await postJson(`/v1/tasks/${task.id}/cancel`, { reason: 'test done' })
    assert.equal(cancelled.ok, true)
    await waitFor(() => body.getTask(task.id)?.state === 'cancelled', 2000, 'cancelled')
  } finally {
    await http.close().catch(() => {})
    await body.stop().catch(() => {})
  }
})

test('do：长 op 单飞锁（并发第二个 409，查询类不受限）', async () => {
  const adapter = fakeAdapter()
  adapter.runOp = async (op) => { await sleep(60); return { op } }
  const body = createBody({ adapter })
  const first = body.doPlan([{ op: 'mine', params: { block: 'oak_log' } }])
  await sleep(5)
  await assert.rejects(() => body.doPlan([{ op: 'dig', params: { pos: { x: 0, y: 64, z: 0 } } }]), /上一个 do 动作还在执行/)
  // 查询类/任务提交不被锁挡（读操作安全）
  await assert.doesNotReject(() => body.doPlan([{ op: 'look' }]))
  await assert.doesNotReject(() => body.doPlan([{ op: 'tasks' }]))
  await first
  // 前一个结束后，新长 op 可以执行
  await assert.doesNotReject(() => body.doPlan([{ op: 'dig', params: { pos: { x: 0, y: 64, z: 0 } } }]))
})

test('body：暂停中安全反射继续（低血自动规避，有界 ≤2 次/分，不自动 resume）', async () => {
  const adapter = fakeAdapter()
  const calls = []
  adapter.emergency = async (reason) => { calls.push(reason); return { ok: true, action: 'flee-threat', reason } }
  let clock = 1_000_000
  const { body } = await startedBody({
    adapter, now: () => clock, watchdogMs: 60_000,
    lowHealth: 10, reflexMaxPerMinute: 2, reflexMaxDurationMs: 200, alarmDedupeMs: 1000,
  })
  body.safetyStop('manual')
  assert.equal(body.status().paused, true)
  adapter.state.health = 4
  body.watchdogTick(clock)
  await waitFor(() => body.eventsSince(0).events.filter((e) => e.type === 'reflex').length >= 1, 1500, 'first reflex event')
  clock += 1000
  body.watchdogTick(clock)
  await waitFor(() => body.eventsSince(0).events.filter((e) => e.type === 'reflex').length >= 2, 1500, 'second reflex event')
  clock += 1000
  body.watchdogTick(clock)
  await waitFor(() => body.eventsSince(0).events.some((e) => e.type === 'reflex_suppressed'), 1500, 'reflex rate limited')
  const state = body.status()
  assert.equal(state.safety.reflex.enabled, true)
  assert.ok(state.safety.reflex.count >= 1)
  assert.ok(state.safety.lastReflex && state.safety.lastReflex.reason === 'low-health')
  assert.equal(state.paused, true, '反射不应自动 resume')
  assert.ok(calls.length >= 2)
  await body.stop()
})

test('body：暂停中 alarm 穿透（death/spawn_unsafe/kicked 带 priority+pierce）', async () => {
  const { body } = await startedBody({ watchdogMs: 60_000 })
  body.safetyStop('manual')
  body.ingest('death', { position: { x: 0, y: 64, z: 0 } })
  body.ingest('spawn_unsafe', { position: { x: 0, y: 64, z: 0 }, threats: [] })
  body.ingest('kicked', { reason: 'test-kick' })
  const events = body.eventsSince(0).events
  for (const type of ['death', 'safety_stop', 'kicked', 'spawn_unsafe']) {
    const event = events.find((entry) => entry.type === type)
    assert.ok(event, `missing ${type}`)
    assert.equal(event.data.priority, 'alarm', `${type} priority`)
    assert.equal(event.data.pierce, true, `${type} pierce`)
    assert.equal(event.priority, 'alarm', `${type} top-level priority`)
    assert.equal(event.pierce, true, `${type} top-level pierce`)
    assert.equal(event.data.meta?.priority, 'alarm', `${type} meta priority`)
    assert.equal(event.data.meta?.pierce, true, `${type} meta pierce`)
  }
  await body.stop()
})

test('body：alarm 被去重后窗口到点补投（不静默）', async () => {
  let clock = 2_000_000
  const { body } = await startedBody({ watchdogMs: 60_000, now: () => clock, alarmDedupeMs: 1000 })
  body.safetyStop('manual')
  body.ingest('spawn_unsafe', { position: { x: 0, y: 64, z: 0 } })
  assert.ok(body.eventsSince(0).events.some((e) => e.type === 'alarm_suppressed'))
  clock += 2000
  body.watchdogTick(clock)
  await waitFor(() => body.eventsSince(0).events.some((e) => e.type === 'safety_stop' && e.data?.redelivered === true), 1500, 'alarm redelivered')
  assert.ok(body.status().safety.alarms.redelivered >= 1)
  await body.stop()
})

test('body：mcb_stop 暂停中可调用（任务/身体分开报告），resume 后可继续下任务', async () => {
  const adapter = fakeAdapter()
  const { body } = await startedBody({ adapter, watchdogMs: 60_000 })
  const hung = body.createTask({ kind: 'mine', params: { hang: true } })
  const queued = body.createTask({ kind: 'mine', params: { count: 1 } })
  await waitFor(() => body.getTask(hung.id)?.state === 'running', 2000, 'running')
  const out = await body.doPlan([{ op: 'stop' }])
  const report = out.results[0].result
  assert.equal(report.paused, true)
  assert.equal(report.pausedReason, 'user-stop')
  assert.ok(report.task.note.includes('任务已停'))
  assert.ok(Array.isArray(report.task.cancelled) && report.task.cancelled.length >= 1)
  assert.equal(report.body.online, true)
  assert.ok(report.body.note.includes('身体仍在世界'))
  assert.equal(report.reflex.enabled, true)
  await waitFor(() => body.getTask(queued.id)?.state === 'cancelled', 1000, 'queued cancelled by stop')
  // pausedReason 用规范值 user-stop（time pausedMode 对账），调用方原始原因保留在 requestedReason
  const stopAgain = await body.doPlan([{ op: 'stop', reason: 'mcb_stop' }])
  assert.equal(stopAgain.results[0].result.pausedReason, 'user-stop')
  assert.equal(stopAgain.results[0].result.requestedReason, 'mcb_stop')
  assert.equal(stopAgain.results[0].result.safety.requestedReason, 'mcb_stop')
  // 暂停中写动作仍拒；stop 之后 resume 能恢复干活
  await assert.rejects(() => body.doPlan([{ op: 'move', x: 1, y: 64, z: 1 }]), /暂停/)
  assert.throws(() => body.createTask({ kind: 'mine', params: { count: 1 } }), /暂停/)
  body.resume()
  const next = body.createTask({ kind: 'mine', params: { count: 1 } })
  await waitFor(() => body.getTask(next.id)?.state === 'done', 2000, 'task done after resume')
  await body.stop()
})

test('body：status 暴露 playable 布尔与 spawn 日志（E6/E7）', async () => {
  const { body } = await startedBody({ watchdogMs: 60_000 })
  const status = body.status()
  assert.ok(status.playable && typeof status.playable.ok === 'boolean')
  assert.ok(Array.isArray(status.playable.blockers))
  body.ingest('spawn', { position: { x: 1, y: 64, z: 2 }, dimension: 'overworld', source: 'connect' })
  body.ingest('spawn_safe', { position: { x: 1, y: 64, z: 2 }, feet: 'grass_block', head: 'air', below: 'dirt', threats: [] })
  const spawnLog = body.status().spawnLog
  assert.ok(spawnLog.length >= 1)
  const last = spawnLog.at(-1)
  assert.equal(last.position.x, 1)
  assert.equal(last.dimension, 'overworld')
  assert.equal(last.safe, true)
  await body.stop()
})




test('body：eyesSnapshot 结构化快照（零依赖；暂停/离线也能出）', async () => {
  const adapter = fakeAdapter()
  const { body } = await startedBody({ adapter, watchdogMs: 60_000 })
  const out = await body.eyesSnapshot({ radius: 4 })
  assert.equal(out.ok, true)
  assert.equal(out.snapshot.kind, 'structured')
  assert.ok(out.captureMs >= 0)
  assert.ok(out.snapshot.map, '应包含 inspect map 文本（fake adapter 返回 fake:map）')
  assert.ok(out.snapshot.playable && typeof out.snapshot.playable.ok === 'boolean')
  assert.ok(out.snapshot.safety && out.snapshot.safety.bodyOnline === true)
  assert.ok(out.snapshot.inventory && out.snapshot.inventory.counts)
  // 暂停时仍可出快照（只读）
  body.safetyStop('manual')
  const paused = await body.eyesSnapshot({})
  assert.equal(paused.snapshot.safety.paused, true)
  assert.equal(paused.snapshot.safety.pausedReason, 'manual')
  await body.stop()
})

test('body：eyesScreenshot 在无截图能力时给可读 501（不崩）', async () => {
  const { body } = await startedBody({ watchdogMs: 60_000 })
  await assert.rejects(() => body.eyesScreenshot({ kind: 'test' }), /未配置截图能力|501/)
  await body.stop()
})


test('body：未暂停时自动躲避（hostile 近身 → 有界 emergency，不打断任务，有冷却）', async () => {
  const adapter = fakeAdapter()
  let clock = 1_000_000
  const { body } = await startedBody({
    adapter, now: () => clock, watchdogMs: 60_000,
    autoDefense: true, defenseCooldownMs: 5000, defenseMaxPerMinute: 3, defenseThreatDistance: 6,
  })
  adapter.state.hostiles = [{ name: 'zombie', distance: 4, position: { x: 5, y: 64, z: 1 } }]
  body.watchdogTick(clock)
  await waitFor(() => adapter.state.emergencies.filter((entry) => entry === 'auto-defense').length >= 1, 1500, 'auto-defense emergency')
  const st = body.status()
  assert.equal(st.safety.autoDefense.enabled, true)
  assert.equal(st.safety.autoDefense.count, 1)
  assert.equal(st.safety.autoDefense.lastReason, 'threat-near')
  assert.ok(body.eventsSince(0).events.some((event) => event.type === 'auto_defense'))
  // 冷却内再来一次：不应重复 emergency
  adapter.state.hostiles = [{ name: 'zombie', distance: 3, position: { x: 5, y: 64, z: 1 } }]
  body.watchdogTick(clock + 1000)
  await sleep(100)
  assert.equal(adapter.state.emergencies.filter((entry) => entry === 'auto-defense').length, 1)
  // 冷却过后可再次规避
  body.watchdogTick(clock + 6000)
  await waitFor(() => adapter.state.emergencies.filter((entry) => entry === 'auto-defense').length >= 2, 1500, 'second auto-defense')
  assert.ok(body.status().safety.autoDefense.count >= 2)
  await body.stop()
})

test('body：贴脸苦力怕/残血时自动躲避升级为安全暂停（reflex 接管）', async () => {
  const adapter = fakeAdapter()
  const { body } = await startedBody({ adapter, watchdogMs: 60_000, lowHealth: 10 })
  adapter.state.hostiles = [{ name: 'creeper', distance: 3, position: { x: 2, y: 64, z: 1 } }]
  body.watchdogTick(1_000_000)
  assert.equal(body.status().paused, true)
  assert.equal(body.status().pausedReason, 'threat')
  adapter.state.hostiles = []
  adapter.state.health = 6
  const body2 = await startedBody({ adapter: fakeAdapter(), watchdogMs: 60_000, lowHealth: 10 })
  body2.adapter.state.hostiles = [{ name: 'zombie', distance: 5 }]
  body2.adapter.state.health = 6
  body2.body.watchdogTick(1_000_000)
  assert.equal(body2.body.status().paused, true)
  await body2.body.stop()
  await body.stop()
})

test('body：暂停时由 reflex 处理威胁（不重复跑 autoDefense），战斗任务运行时不抢自动躲避', async () => {
  const adapter = fakeAdapter()
  let clock = 2_000_000
  const { body } = await startedBody({ adapter, now: () => clock, watchdogMs: 60_000 })
  body.safetyStop('manual')
  adapter.state.hostiles = [{ name: 'zombie', distance: 5 }]
  body.watchdogTick(clock)
  await waitFor(() => body.status().safety.reflex.count >= 1, 1500, 'paused reflex threat')
  assert.equal(body.status().safety.lastReflex.reason, 'threat-near')
  assert.equal(body.status().safety.autoDefense.count, 0)
  await body.stop()

  const adapter2 = fakeAdapter()
  const second = await startedBody({ adapter: adapter2, watchdogMs: 60_000 })
  const task = second.body.createTask({ kind: 'hunt', params: { hang: true } })
  await waitFor(() => second.body.getTask(task.id)?.state === 'running', 2000, 'hunt running')
  adapter2.state.hostiles = [{ name: 'zombie', distance: 4 }]
  second.body.watchdogTick(3_000_000)
  await sleep(100)
  assert.equal(adapter2.state.emergencies.filter((entry) => entry === 'auto-defense').length, 0)
  await second.body.stop()
})

test('body：hunt 任务被接受（KINDS）并走 adapter runTask', async () => {
  const adapter = fakeAdapter()
  const { body } = await startedBody({ adapter, watchdogMs: 60_000 })
  const task = body.createTask({ kind: 'hunt', params: { target: 'nearest_hostile', maxDurationMs: 5000 } })
  assert.equal(task.kind, 'hunt')
  await waitFor(() => body.getTask(task.id)?.state === 'done', 2000, 'hunt done')
  assert.equal(adapter.state.runTaskCalls.at(-1).kind, 'hunt')
  await body.stop()
})

test('body：低血暂停/恢复死锁修复（resume 后 3s 宽限 + 8s 冷却；极低血例外）', async () => {
  const adapter = fakeAdapter()
  let clock = 5_000_000
  const { body } = await startedBody({ adapter, now: () => clock, watchdogMs: 60_000, lowHealth: 10, criticalHealth: 4, resumeGraceMs: 3000, lowHealthPauseCooldownMs: 8000 })
  adapter.state.health = 5
  body.watchdogTick(clock)
  await waitFor(() => body.status().paused && body.status().pausedReason === 'low-health', 1000, 'low-health pause')
  // resume 后宽限内：低血但还能动 → 不再立刻暂停，只记 recover_grace
  const res = body.resume()
  assert.ok(res.graceUntil >= clock + 3000)
  clock += 100
  body.watchdogTick(clock)
  assert.equal(body.status().paused, false, 'grace 内不应立刻再暂停')
  assert.ok(body.eventsSince(0).events.some((e) => e.type === 'recover_grace'))
  // 宽限过后但仍在低血暂停冷却内
  clock += 4000
  body.watchdogTick(clock)
  assert.equal(body.status().paused, false, '冷却内也不应立刻再暂停')
  // 冷却结束仍低血 → 再次暂停
  clock += 5000
  body.watchdogTick(clock)
  await waitFor(() => body.status().paused, 500, 'pause after cooldown')
  // 极低血无视宽限/冷却
  body.resume()
  adapter.state.health = 3
  clock += 100
  body.watchdogTick(clock)
  await waitFor(() => body.status().paused && body.status().pausedReason === 'low-health', 500, 'critical low-health pause')
  await body.stop()
})

test('body：暂停中允许 eat/stop（低血能自己爬出来）；写动作仍拒', async () => {
  const adapter = fakeAdapter()
  adapter.runOp = async (op) => ({ ok: true, op })
  const { body } = await startedBody({ adapter, watchdogMs: 60_000 })
  body.safetyStop('low-health')
  assert.equal(body.status().paused, true)
  await assert.doesNotReject(() => body.doPlan([{ op: 'eat' }]))
  await assert.doesNotReject(() => body.doPlan([{ op: 'stop' }]))
  await assert.rejects(() => body.doPlan([{ op: 'mine', params: { block: 'dirt', count: 1 } }]), /暂停/)
  const recovery = body.status().safety.recovery
  assert.equal(typeof recovery.criticalHealth, 'number')
  assert.equal(typeof recovery.lowHealthPauseCooldownMs, 'number')
  await body.stop()
})
