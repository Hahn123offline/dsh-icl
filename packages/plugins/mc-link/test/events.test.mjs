// mc-link 事件闸门：分级/合并/限流/去重（纯函数，不连 body）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createEventGate, eventLine, taskEventText, OPS, TASK_KINDS } from '../src/events.mjs'

function collect(events, { status = { paused: true, pausedReason: 'health-drop', adapter: { health: 14, food: 18, inventoryCount: 3, position: { x: 1, y: 64, z: 2 } } }, at = 0 } = {}) {
  const clock = { t: at }
  const gate = createEventGate({ now: () => clock.t })
  const out = gate.take(events, { status })
  return { ...out, gate }
}

test('事件闸门：health/task_progress/connected 这类状态事件不投递', () => {
  const { signals, quiet } = collect([
    { seq: 1, type: 'health', data: { health: 20 } },
    { seq: 2, type: 'task_progress', data: { taskId: 't-1', progress: { done: 1 } } },
    { seq: 3, type: 'connected', data: {} },
    { seq: 4, type: 'task_queued', data: { task: { id: 't-2', kind: 'mine' } } },
    { seq: 5, type: 'task_started', data: { task: { id: 't-2', kind: 'mine' } } },
  ])
  assert.equal(signals.length, 0)
  assert.equal(quiet, 5)
})

test('事件闸门：掉血刷屏被合并成 1 条，并记录抑制数量', () => {
  const events = Array.from({ length: 20 }, (_, i) => ({ seq: i + 1, type: 'health_drop', data: { from: 20 - i, to: 19 - i } }))
  const { signals, suppressed } = collect(events)
  assert.equal(signals.length, 1)
  assert.match(signals[0].text, /掉血/)
  assert.ok(suppressed >= 19, `应抑制 19 条，实际 ${suppressed}`)
})

test('事件闸门：死亡在窗口内合并，3 次以上额外升级一次', () => {
  const gate = createEventGate({ now: () => clock.t })
  const clock = { t: 0 }
  const status = { paused: true, pausedReason: 'death', adapter: { health: 0, position: { x: 1, y: 2, z: 3 } } }
  const first = gate.take([{ seq: 1, type: 'death', data: {} }], { status })
  assert.equal(first.signals.length, 1)
  assert.match(first.signals[0].text, /死亡/)
  assert.ok(first.signals[0].tags.includes('alarm'))
  // 30 秒后再死一次：窗口内合并；第 3 次触发升级提醒。
  clock.t = 30_000
  const second = gate.take([{ seq: 2, type: 'death', data: {} }], { status })
  clock.t = 60_000
  const third = gate.take([{ seq: 3, type: 'death', data: {} }], { status })
  const texts = [...second.signals, ...third.signals].map((signal) => signal.text).join('\n')
  assert.match(texts, /分钟内死了 3 次以上/)
  assert.ok(second.signals.length + third.signals.length <= 3, '死亡不能每条都投递')
})

test('事件闸门：task_done 带 reason 翻译成"没达成"，正常挖到给数量', () => {
  const failed = taskEventText('task_done', { task: { id: 't-1', kind: 'mine', params: { block: 'oak_log', count: 4 }, result: { mined: 0, reason: 'no-target' } } })
  assert.match(failed, /没达成/)
  assert.match(failed, /no-target/)
  assert.match(failed, /radius/)
  const ok = taskEventText('task_done', { task: { id: 't-2', kind: 'mine', params: { block: 'oak_log', count: 4 }, result: { mined: 4 } } })
  assert.match(ok, /挖了 4/)
})

test('事件闸门：任务事件在窗口内不重复投递同一条', () => {
  const gate = createEventGate({ now: () => clock.t })
  const clock = { t: 0 }
  const event = { seq: 1, type: 'task_done', data: { task: { id: 't-9', kind: 'mine', result: { mined: 1 } } } }
  const first = gate.take([event], { status: null })
  const second = gate.take([{ ...event, seq: 2 }], { status: null })
  assert.equal(first.signals.length, 1)
  assert.equal(second.signals.length, 0)
})

test('事件闸门：安全停止标 alarm 且带恢复路径', () => {
  const { signals } = collect([{ seq: 1, type: 'safety_stop', data: { reason: 'low-health' } }])
  assert.equal(signals.length, 1)
  assert.ok(signals[0].tags.includes('alarm'))
  assert.match(signals[0].text, /血量过低/)
  assert.match(signals[0].text, /resume/)
  assert.match(signals[0].text, /mcb_leave/)
})

test('事件闸门：聊天按分钟限额合并，叫到名字带 mention', () => {
  const gate = createEventGate({ now: () => clock.t })
  const clock = { t: 0 }
  const one = gate.take([{ seq: 1, type: 'chat', data: { username: 'Hahn123_', message: 'ICL 在吗' } }], { status: null })
  assert.equal(one.signals.length, 1)
  assert.ok(one.signals[0].tags.includes('mention'))
  const many = Array.from({ length: 12 }, (_, i) => ({ seq: i + 2, type: 'chat', data: { username: 'Hahn123_', message: `刷屏 ${i}` } }))
  const flooded = gate.take(many, { status: null })
  assert.ok(flooded.signals.length <= 1, `聊天限流后不应逐条投递，实际 ${flooded.signals.length}`)
  assert.ok(flooded.suppressed > 0)
  assert.equal(one.signals[0].kind, 'content')
})

test('事件闸门：连接类事件分级（断开=普通、重连耗尽=alarm、重连中=合并）', () => {
  const gate = createEventGate({ now: () => clock.t })
  const clock = { t: 0 }
  const out = gate.take([
    { seq: 1, type: 'disconnected', data: { reason: 'socketClosed' } },
    { seq: 2, type: 'reconnecting', data: { attempt: 1, delayMs: 3000 } },
    { seq: 3, type: 'reconnecting', data: { attempt: 2, delayMs: 6000 } },
  ], { status: null })
  assert.equal(out.signals.length, 2)
  assert.ok(out.signals[1].text.includes('重连中'))
  const exhausted = gate.take([{ seq: 4, type: 'reconnect_exhausted', data: { attempts: 3 } }], { status: null })
  assert.equal(exhausted.signals.length, 1)
  assert.ok(exhausted.signals[0].tags.includes('alarm'))
  assert.match(exhausted.signals[0].text, /mcb_join/)
})

test('事件闸门：危险事件有独立配额，超限抑制但不静默（统计可见）', () => {
  // kicked 没有合并窗口，12 条全部想投递 → 配额 10 条挡下 2 条。
  const { signals, gate } = collect(Array.from({ length: 12 }, (_, i) => ({ seq: i + 1, type: 'kicked', data: { reason: `被踢 ${i}` } })))
  assert.equal(signals.length, 10)
  assert.ok(gate.stats().suppressed >= 2)
})

test('事件闸门：普通断线不带 alarm（不把专注里的她拽出来），真危险才带', () => {
  const quiet = collect([{ seq: 1, type: 'safety_stop', data: { reason: 'disconnect' } }])
  assert.ok(!quiet.signals[0].tags.includes('alarm'), 'disconnect 不应带 alarm')
  assert.match(quiet.signals[0].text, /断线/)
  const loud = collect([{ seq: 2, type: 'safety_stop', data: { reason: 'low-health' } }])
  assert.ok(loud.signals[0].tags.includes('alarm'), 'low-health 应带 alarm')
})

test('事件闸门：eventLine 把事件写成台账行（含 quiet 事件细节）', () => {
  const lines = [
    eventLine({ seq: 8, type: 'task_progress', data: { taskId: 't-1', progress: { done: 2, total: 4 } } }),
    eventLine({ seq: 9, type: 'chat', data: { username: 'Hahn123_', message: '在吗' } }),
    eventLine({ seq: 10, type: 'task_done', data: { task: { id: 't-1', kind: 'mine', result: { mined: 2 } } } }),
  ]
  assert.match(lines[0], /^#8 task_progress · t-1/)
  assert.match(lines[1], /Hahn123_：在吗/)
  assert.match(lines[2], /挖了 2/)
})

test('OP 与 task kind 列表是 mc-body 的公开集合（防止工具描述与 body 漂移）', () => {
  for (const op of ['task', 'tasks', 'events', 'cancel', 'resume', 'say', 'dig', 'goto', 'mine', 'craft', 'trade']) assert.ok(OPS.includes(op), op)
  for (const kind of ['mine', 'goto', 'patrol', 'explore', 'follow', 'routine', 'chat']) assert.ok(TASK_KINDS.includes(kind), kind)
})
