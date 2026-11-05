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

test('body：idle 与 danger 配额分开，suppressed 有统计且不静默', async () => {
  const adapter = fakeAdapter()
  const { body } = await startedBody({
    adapter, watchdogMs: 10, lowHealth: 10, dangerAlertPerMinute: 2, idleAlertPerMinute: 1, heartbeatMs: 10, alertWindowMs: 60_000,
  })
  adapter.state.health = 5
  await waitFor(() => {
    const stats = body.status().watchdog
    return stats.suppressed >= 3 && stats.suppressedBy['low-health'] >= 2 && stats.suppressedBy.heartbeat >= 1
  }, 3000, 'suppressed stats')
  const stats = body.status().watchdog
  assert.equal(stats.limits.danger, 2)
  assert.equal(stats.limits.idle, 1)
  assert.ok(stats.fired >= 1)
  assert.ok(body.eventsSince(0).events.some((e) => e.type === 'watchdog_suppressed'))
  // danger 配额耗尽没有把 idle 心跳全部压死
  assert.ok(body.eventsSince(0).events.some((e) => e.type === 'heartbeat'))
  await body.stop()
})

test('body：暂停时写动作被拒，感知/恢复仍可用', async () => {
  const { body } = await startedBody()
  body.ingest('health', { health: 5 })
  assert.equal(body.status().paused, true)
  assert.throws(() => body.createTask({ kind: 'mine', params: { count: 1 } }), /暂停/)
  await assert.doesNotReject(() => body.doPlan([{ op: 'look' }]))
  await assert.rejects(() => body.doPlan([{ op: 'move', x: 1, y: 64, z: 1 }]), /暂停/)
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
