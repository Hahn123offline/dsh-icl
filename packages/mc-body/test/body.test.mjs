import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createBody } from '../src/body.mjs'
import { createHttpServer } from '../src/server.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(fn, timeout = 2000) {
  const start = Date.now()
  while (Date.now() - start < timeout) { const value = fn(); if (value) return value; await sleep(10) }
  throw new Error('wait timeout')
}

function fakeAdapter() {
  const state = { connected: false, chats: [] }
  return {
    state,
    connect: async () => { state.connected = true },
    disconnect: async () => { state.connected = false },
    status: () => ({ connected: state.connected, self: 'Fake' }),
    chat: async (text) => { state.chats.push(text) },
    inspect: async (kind) => ({ text: `fake:${kind}` }),
    async runTask(task, { signal, progress }) {
      if (task.kind === 'chat') { state.chats.push(task.params.text); return { sent: true } }
      if (task.params.hang) {
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
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
}

test('body：任务立即排队，完成发事件', async () => {
  const adapter = fakeAdapter()
  const body = createBody({ adapter })
  await body.start()
  const task = body.createTask({ kind: 'mine', params: { count: 3 } })
  assert.equal(task.state, 'queued')
  await waitFor(() => body.getTask(task.id)?.state === 'done')
  assert.deepEqual(body.getTask(task.id).result, { done: 3 })
  assert.ok(body.eventsSince(0).events.some((e) => e.type === 'task_done'))
})

test('body：idempotencyKey 不重复执行', async () => {
  const adapter = fakeAdapter()
  const body = createBody({ adapter })
  await body.start()
  const a = body.createTask({ idempotencyKey: 'k1', kind: 'mine', params: { count: 1 } })
  const b = body.createTask({ idempotencyKey: 'k1', kind: 'mine', params: { count: 99 } })
  assert.equal(a.id, b.id)
  await waitFor(() => body.getTask(a.id)?.state === 'done')
})

test('body：取消 running 任务', async () => {
  const adapter = fakeAdapter()
  const body = createBody({ adapter })
  await body.start()
  const task = body.createTask({ kind: 'mine', params: { hang: true } })
  await waitFor(() => body.getTask(task.id)?.state === 'running')
  body.cancelTask(task.id, 'user')
  await waitFor(() => body.getTask(task.id)?.state === 'cancelled')
})

test('body：deadline 超时', async () => {
  const adapter = fakeAdapter()
  const body = createBody({ adapter })
  await body.start()
  const task = body.createTask({ kind: 'mine', params: { hang: true }, deadlineMs: 1000 })
  await waitFor(() => body.getTask(task.id)?.state === 'failed', 2500)
  assert.equal(body.getTask(task.id).error, 'timeout')
})

test('body：低血 safety stop 中断任务', async () => {
  const adapter = fakeAdapter()
  const body = createBody({ adapter })
  await body.start()
  const task = body.createTask({ kind: 'mine', params: { hang: true } })
  await waitFor(() => body.getTask(task.id)?.state === 'running')
  const queued = body.createTask({ kind: 'mine', params: { count: 1 } })
  body.ingest('health', { health: 5 })
  await waitFor(() => body.getTask(task.id)?.state === 'interrupted')
  assert.equal(body.getTask(queued.id).state, 'interrupted')
  assert.equal(body.status().paused, true)
  assert.ok(body.eventsSince(0).events.some((e) => e.type === 'safety_stop'))
})

test('body：出生点危险直接安全暂停', async () => {
  const adapter = fakeAdapter()
  const body = createBody({ adapter })
  await body.start()
  body.ingest('spawn_unsafe', { feet: 'lava', head: 'air', below: 'stone' })
  assert.equal(body.status().paused, true)
  assert.equal(body.status().pausedReason, 'spawn-unsafe')
})

test('body：watchdog 低血自动安全暂停', async () => {
  const adapter = fakeAdapter()
  adapter.status = () => ({ connected: true, self: 'Fake', health: 5, food: 10 })
  const body = createBody({ adapter, watchdogMs: 10 })
  await body.start()
  await waitFor(() => body.status().paused, 1000)
  assert.equal(body.status().pausedReason, 'low-health')
  await body.stop()
})

test('body：暂停只通知，不再拒绝模型动作或 resume 门槛', async () => {
  const adapter = fakeAdapter()
  adapter.status = () => ({ connected: true, health: 5, food: 10 })
  const body = createBody({ adapter })
  await body.start()
  body.ingest('health', { health: 5, food: 10 })
  assert.equal(body.status().paused, true)
  assert.doesNotThrow(() => body.createTask({ kind: 'mine', params: { block: 'dirt', count: 1 } }))
  assert.equal(body.resume().paused, false)
  await body.stop()
})

test('body：routine 的 deadline 跟随 duration', async () => {
  const body = createBody({ adapter: fakeAdapter() })
  await body.start()
  const task = body.createTask({ kind: 'routine', params: { durationMs: 5000 } })
  assert.ok(task.deadlineAt >= task.createdAt + 30_000)
  await body.stop()
})

test('body：任务台账跨重启保留，running 变 interrupted', async () => {
  const adapter = fakeAdapter()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-body-ledger-'))
  const stateFile = path.join(root, 'tasks.json')
  const first = createBody({ adapter, stateFile })
  await first.start()
  const done = first.createTask({ idempotencyKey: 'ledger-1', kind: 'mine', params: { count: 1 } })
  await waitFor(() => first.getTask(done.id)?.state === 'done')
  await first.stop()

  const second = createBody({ adapter: fakeAdapter(), stateFile })
  await second.start()
  assert.equal(second.getTask(done.id)?.state, 'done')
  const queued = second.createTask({ kind: 'mine', params: { hang: true } })
  await waitFor(() => second.getTask(queued.id)?.state === 'running')

  const third = createBody({ adapter: fakeAdapter(), stateFile })
  await third.start()
  assert.equal(third.getTask(queued.id)?.state, 'interrupted')
  assert.equal(third.getTask(queued.id)?.error, 'body-restart')
  await third.stop()
  await second.stop()
})

test('body：do 的 task op 接受 params.kind', async () => {
  const body = createBody({ adapter: fakeAdapter() })
  await body.start()
  const out = await body.doPlan([{ op: 'task', params: { kind: 'mine', block: 'dirt' } }])
  assert.equal(out.task.kind, 'mine')
  assert.equal(out.task.params.block, 'dirt')
  await body.stop()
})

test('body：HTTP 契约', async () => {
  const adapter = fakeAdapter()
  const body = createBody({ adapter })
  await body.start()
  const http = createHttpServer(body, { port: 0 })
  const server = await http.listen()
  const port = server.address().port
  const status = await (await fetch(`http://127.0.0.1:${port}/v1/status`)).json()
  assert.equal(status.version, 'mc-body/v1')
  const created = await (await fetch(`http://127.0.0.1:${port}/v1/tasks`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'mine', params: { count: 1 } }),
  })).json()
  assert.equal(created.ok, true)
  await waitFor(() => body.getTask(created.task.id)?.state === 'done')
  const events = await (await fetch(`http://127.0.0.1:${port}/v1/events?since=0`)).json()
  assert.ok(events.events.length > 0)
  const inspect = await (await fetch(`http://127.0.0.1:${port}/v1/inspect`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'inventory' }),
  })).json()
  assert.equal(inspect.result.text, 'fake:inventory')
  const plan = await (await fetch(`http://127.0.0.1:${port}/v1/do`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ steps: [{ op: 'look' }] }),
  })).json()
  assert.equal(plan.results[0].result.text, 'fake:look')
  await http.close()
})
