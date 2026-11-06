// mc-link 事件闸门：分级/合并/限流/去重（纯函数，不连 body）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createEventGate, eventLine, taskEventText, OPS, TASK_KINDS, MACRO_KINDS } from '../src/events.mjs'

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

test('事件闸门：task_failed 带 body 原因码时翻成下一步（no-target/no-path/…）', () => {
  const noTarget = taskEventText('task_failed', { task: { id: 't-1', kind: 'mine', params: { block: 'oak_log', count: 4 }, error: 'mine: no-target', result: { mined: 0 } } })
  assert.match(noTarget, /任务失败/)
  assert.match(noTarget, /no-target/)
  assert.match(noTarget, /radius/)
  assert.match(noTarget, /进度/)
  const noPath = taskEventText('task_failed', { task: { id: 't-2', kind: 'mine', error: 'mine: no-path' } })
  assert.match(noPath, /mcb_map/)
  const ok = taskEventText('task_done', { task: { id: 't-3', kind: 'mine', params: { block: 'oak_log', count: 4 }, result: { mined: 4 } } })
  assert.match(ok, /挖了 4/)
})

test('事件闸门：task_unknown 是"结果未知"而非失败；task_paused 是断线挂起，要显式 resume', () => {
  const unknown = taskEventText('task_unknown', { task: { id: 't-5', kind: 'mine', error: 'timeout', outcomeUnknown: true } })
  assert.match(unknown, /结果未知/)
  assert.match(unknown, /不能当成失败/)
  assert.match(unknown, /mcb_status/)
  const paused = taskEventText('task_paused', { task: { id: 't-6', kind: 'routine', state: 'paused', pausedReason: 'disconnect' }, reason: 'disconnect' })
  assert.match(paused, /任务暂停/)
  assert.match(paused, /resume/)
  assert.match(paused, /"taskId":"t-6"/)
  assert.match(paused, /不会自动续跑/)
  const resumed = taskEventText('task_resumed', { task: { id: 't-6', kind: 'routine', state: 'running' } })
  assert.match(resumed, /任务继续/)
})

test('事件闸门：离线/重连提示分级（offline 不重复，resume_required 讲清旧任务 paused）', () => {
  const gate = createEventGate({ now: () => clock.t })
  const clock = { t: 0 }
  const out = gate.take([
    { seq: 1, type: 'offline', data: { reason: 'socketClosed', willReconnect: true } },
    { seq: 2, type: 'disconnected', data: { reason: 'socketClosed' } },
  ], { status: null })
  assert.equal(out.signals.length, 1, 'offline 与 disconnected 是同一次断线，只报一条')
  assert.match(out.signals[0].text, /离线|断开/)
  const required = gate.take([{ seq: 3, type: 'resume_required', data: { reason: 'reconnect' } }], { status: null })
  assert.equal(required.signals.length, 1)
  assert.match(required.signals[0].text, /仍暂停/)
  assert.match(required.signals[0].text, /resume/)
  assert.match(required.signals[0].text, /paused/)
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

test('事件闸门：掉血用事件时刻的血量（不混实时状态），合并计数仍按事件条数', () => {
  // 事件说 20→17，但格式化时的实时血量已经是 18（合并/限流后的错位现场）
  const live = { adapter: { health: 18, food: 20, inventoryCount: 0 } }
  const first = collect([{ seq: 1, type: 'health_drop', data: { from: 20, to: 17, drop: 3 } }], { status: live })
  assert.equal(first.signals.length, 1)
  assert.match(first.signals[0].text, /掉血：20 → 17/)
  assert.match(first.signals[0].text, /事件时 17\/20/)
  assert.match(first.signals[0].text, /一次掉 3/)
  assert.doesNotMatch(first.signals[0].text, /18\/20/, '不能把实时血量 18 混进事件时刻的描述')
  assert.doesNotMatch(first.signals[0].text, /血18/)
  // 第二次掉血在合并窗口内：不投递；下一条 alarm 会带"另有 N 条"计数（不是实时状态）
  const clock = { t: 0 }
  const gate = createEventGate({ now: () => clock.t })
  gate.take([{ seq: 1, type: 'health_drop', data: { from: 20, to: 18, drop: 2 } }], { status: live })
  const merged = gate.take([{ seq: 2, type: 'health_drop', data: { from: 18, to: 15, drop: 3 } }], { status: live })
  assert.equal(merged.signals.length, 0)
  const after = gate.take([{ seq: 3, type: 'death', data: { position: { x: 1, y: 64, z: -3 }, lastDeath: { inventoryCount: 2 } } }], { status: live })
  assert.equal(after.signals.length, 1)
  assert.match(after.signals[0].text, /另有 1 条/)
  assert.ok([...after.signals[0].text].length <= 80, `报警行 ≤80 字：${after.signals[0].text}`)
})

test('事件闸门：死亡用事件时刻的位置/背包件数（不混实时状态）', () => {
  const live = { adapter: { health: 20, position: { x: 99, y: 99, z: 99 }, inventoryCount: 0 } }
  const { signals } = collect([{
    seq: 1,
    type: 'death',
    data: { position: { x: 1.2, y: 64, z: -3.6 }, lastDeath: { inventoryCount: 5 } },
  }], { status: live })
  assert.equal(signals.length, 1)
  assert.ok(signals[0].tags.includes('alarm'))
  assert.match(signals[0].text, /死亡 @ 1,64,-4/)
  assert.match(signals[0].text, /当时背包 5 件/)
  assert.doesNotMatch(signals[0].text, /99,99,99/, '不能用实时位置')
})

test('事件闸门：报警行长度 ≤80 字（含后缀），超长原因被截断', () => {
  const longReason = '一'.repeat(200)
  const gate = createEventGate({ now: () => clock.t })
  const clock = { t: 0 }
  const out = gate.take([
    { seq: 1, type: 'safety_stop', data: { reason: 'low-health', event: longReason } },
    { seq: 2, type: 'watchdog', data: { kind: 'danger-block', severity: 'danger', note: longReason } },
  ], { status: { adapter: { health: 5 } } })
  assert.ok(out.signals.length >= 1)
  for (const signal of out.signals) {
    if (!signal.tags.includes('alarm')) continue
    assert.ok([...signal.text].length <= 80, `报警行超 80 字（${[...signal.text].length}）：${signal.text}`)
  }
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
  for (const op of ['task', 'tasks', 'events', 'cancel', 'resume', 'say', 'dig', 'goto', 'mine', 'craft', 'trade', 'sleep']) assert.ok(OPS.includes(op), op)
  for (const kind of ['mine', 'goto', 'patrol', 'explore', 'follow', 'routine', 'chat']) assert.ok(TASK_KINDS.includes(kind), kind)
  for (const kind of ['collect', 'tunnel', 'bridge', 'build', 'sort', 'deposit', 'shelter', 'farm']) {
    assert.ok(TASK_KINDS.includes(kind), `宏 kind 缺失：${kind}`)
    assert.ok(MACRO_KINDS.includes(kind), `MACRO_KINDS 缺失：${kind}`)
  }
})

test('宏：collect/tunnel 的 task_done 说人话（收集 N 个 / 通道 N 格 + 火把 + stairs）', () => {
  const collected = taskEventText('task_done', { task: { id: 't-1', kind: 'collect', params: { item: 'oak_log', count: 8 }, result: { collected: 9, net: 8, item: 'oak_log', requested: 8 } } })
  assert.match(collected, /宏完成/)
  assert.match(collected, /收集到 8 个 oak_log/, '优先用 net（背包净增）')
  assert.match(collected, /目标 8/)
  const tunnel = taskEventText('task_done', { task: { id: 't-2', kind: 'tunnel', params: { direction: 'east', length: 8 }, result: { done: 8, total: 8, direction: 'east', height: 2, torches: 1 } } })
  assert.match(tunnel, /宏完成/)
  assert.match(tunnel, /往east挖了 8 格/)
  assert.match(tunnel, /放火把 1/)
  const stairs = taskEventText('task_done', { task: { id: 't-3', kind: 'tunnel', params: { direction: 'east', length: 8, stairs: true }, result: { done: 8, total: 8, direction: 'east', height: 2, torches: 0, stairs: true } } })
  assert.match(stairs, /向下阶梯/)
})

test('宏：bridge/build/shelter/sort/deposit/farm 的 task_done 各自说人话', () => {
  const bridge = taskEventText('task_done', { task: { id: 't-1', kind: 'bridge', params: { direction: 'north' }, result: { direction: 'north', done: 10, width: 1, materialsUsed: 10 } } })
  assert.match(bridge, /bridge.*往north铺了 10 格/s)
  const build = taskEventText('task_done', { task: { id: 't-2', kind: 'build', params: {}, result: { placed: 12, skipped: 1, layer: 3, totalLayers: 3 } } })
  assert.match(build, /build.*放了 12 块，跳过 1/)
  const shelter = taskEventText('task_done', { task: { id: 't-3', kind: 'shelter', params: {}, result: { walls: 16, roof: 9, door: 1 } } })
  assert.match(shelter, /shelter.*墙 16、顶 9、门 1/)
  const deposit = taskEventText('task_done', { task: { id: 't-4', kind: 'deposit', params: {}, result: { action: 'put', moved: 5, kept: 2 } } })
  assert.match(deposit, /deposit.*存入 5 件/)
  const farm = taskEventText('task_done', { task: { id: 't-5', kind: 'farm', params: { crop: 'wheat' }, result: { tilled: 4, planted: 4, crop: 'wheat' } } })
  assert.match(farm, /farm.*开垦 4、播种 4 格 wheat/)
})

test('宏：失败码都有可操作提示（needs-tool/inventory-full/needs-material/blocked/unsafe/partial）', () => {
  const cases = [
    ['collect: needs-tool', /工具不对|换对应工具/],
    ['collect: inventory-full', /背包满/],
    ['bridge: needs-material', /材料不够/],
    ['tunnel: blocked', /水\/岩浆\/基岩|绕开/],
    ['tunnel: unsafe', /安全护栏/],
    ['build: partial', /只完成了一部分/],
    ['farm: no-water', /没有水|引水/],
    ['farm: no-site', /可开垦/],
    ['tunnel: unsupported', /不支持这个参数组合/],
    ['unsupported task: bridge', /beta|未开放/],
  ]
  for (const [error, pattern] of cases) {
    const text = taskEventText('task_failed', { task: { id: 't-3', kind: error.split(':')[0], error } })
    assert.match(text, /任务失败/, error)
    assert.match(text, pattern, error)
  }
})

test('宏信息事件（macro_step/macro_blocked/macro_done/auto_tool/needs_tool）不叫醒', () => {
  const gate = createEventGate({ now: () => clock.t })
  const clock = { t: 0 }
  const out = gate.take([
    { seq: 1, type: 'macro_step', data: { kind: 'tunnel', step: 3 } },
    { seq: 2, type: 'macro_blocked', data: { kind: 'tunnel', block: 'water' } },
    { seq: 3, type: 'macro_done', data: { kind: 'collect' } },
    { seq: 4, type: 'auto_tool', data: { equipped: 'stone_pickaxe' } },
    { seq: 5, type: 'needs_tool', data: { reason: 'needs-tool' } },
  ], { status: null })
  assert.equal(out.signals.length, 0)
})

test('事件闸门：path_stuck 单次不投递，连续第 2 次才说；任务开始重置计数', () => {
  const gate = createEventGate({ now: () => clock.t })
  const clock = { t: 0 }
  const first = gate.take([{ seq: 1, type: 'path_stuck', data: { attempts: 1 } }], { status: null })
  assert.equal(first.signals.length, 0, '单次 path_stuck 只是重算路线，不叫醒')
  const second = gate.take([{ seq: 2, type: 'path_stuck', data: { attempts: 2 } }], { status: null })
  assert.equal(second.signals.length, 1)
  assert.match(second.signals[0].text, /连续 2 次走不过去/)
  gate.take([{ seq: 3, type: 'task_started', data: { task: { id: 't-9', kind: 'mine' } } }], { status: null })
  const again = gate.take([{ seq: 4, type: 'path_stuck', data: { attempts: 1 } }], { status: null })
  assert.equal(again.signals.length, 0)
})

test('事件闸门：task_done 的成功 reason 白名单（net-target/duration/target）不算"没达成"', () => {
  for (const reason of ['net-target', 'duration', 'target']) {
    const text = taskEventText('task_done', { task: { id: 't-1', kind: 'routine', result: { reason, net: 3, item: 'dirt' } } })
    assert.match(text, /任务完成/, reason)
    assert.doesNotMatch(text, /没达成/, reason)
  }
  const legacy = taskEventText('task_done', { task: { id: 't-2', kind: 'mine', result: { mined: 0, reason: 'no-target' } } })
  assert.match(legacy, /没达成/)
})

test('事件闸门：危险标记三层（顶层/data/data.meta 的 priority|pierce、severity:danger）都能把 quiet 事件升成 alarm', () => {
  const gate = createEventGate({ now: () => clock.t })
  const clock = { t: 0 }
  const out = gate.take([
    // 危险 watchdog：类型本来 quiet，但 data.meta 只有 pierce
    { seq: 1, type: 'watchdog', data: { kind: 'low-health', severity: 'danger', meta: { pierce: true } } },
    // reflex：顶层 priority/pierce
    { seq: 2, type: 'reflex', priority: 'alarm', pierce: true, data: { reason: 'low-health', action: 'retreat' } },
    // 普通 watchdog 没有危险标记：仍不叫醒
    { seq: 3, type: 'watchdog', data: { kind: 'periodic' } },
  ], { status: null })
  assert.equal(out.signals.length, 2)
  for (const signal of out.signals) {
    assert.ok(signal.tags.includes('alarm'), '危险标记必须带 alarm tag')
    assert.equal(signal.priority, 'alarm', '危险标记必须升到 alarm priority')
  }
  assert.match(out.signals[0].text, /watchdog|危险/)
  assert.match(out.signals[1].text, /危险|reflex/)
})

test('事件闸门：dig_fallback/path_approximate/心跳/auto_eat/craft_no_product 不叫醒（观测事件）', () => {
  const gate = createEventGate({ now: () => clock.t })
  const clock = { t: 0 }
  const out = gate.take([
    { seq: 1, type: 'dig_fallback', data: { block: 'oak_log', reason: 'no-path' } },
    { seq: 2, type: 'path_approximate', data: { target: { x: 1, y: 2, z: 3 } } },
    { seq: 3, type: 'heartbeat', data: {} },
    { seq: 4, type: 'auto_eat', data: { food: 18 } },
    { seq: 5, type: 'craft_no_product', data: { item: 'stick' } },
  ], { status: null })
  assert.equal(out.signals.length, 0)
})

test('事件闸门：kicked 的 reason 是对象时显示真实原因，同名/重复登录要指出来', () => {
  const plain = collect([{ seq: 1, type: 'kicked', data: { reason: { text: 'You are already logged in' } } }])
  assert.doesNotMatch(plain.signals[0].text, /\[object Object\]/)
  assert.match(plain.signals[0].text, /already logged in/)
  assert.match(plain.signals[0].text, /同名/)
  const normal = collect([{ seq: 2, type: 'kicked', data: { reason: 'banned' } }])
  assert.match(normal.signals[0].text, /banned/)
  assert.doesNotMatch(normal.signals[0].text, /同名/)
})

test('事件闸门：重连耗尽在窗口内只报一次（body 会连发两条）', () => {
  const gate = createEventGate({ now: () => clock.t })
  const clock = { t: 0 }
  const first = gate.take([{ seq: 1, type: 'reconnect_exhausted', data: { attempts: 3 } }], { status: null })
  const second = gate.take([{ seq: 2, type: 'reconnect_exhausted', data: { attempts: 3, reason: 'reconnect-failed' } }], { status: null })
  assert.equal(first.signals.length, 1)
  assert.equal(second.signals.length, 0)
})
