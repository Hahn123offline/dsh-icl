// mc-link 插件契约测试：假 mc-body HTTP 服务，不连真 MC。
// 覆盖：工具面/描述自足、提示词段（只事实、无教学段）、join/leave、事件→信号分级限流、
// mcb_do 的参数校验与错误可操作性、events 默认游标、超时、body 失去响应、seq 归零。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost, createSessionAdapter } from '../../../core/src/index.mjs'
import * as mcLink from '../src/index.mjs'
import manifest from '../manifest.json' with { type: 'json' }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function statusBody(state) {
  const extra = state.extra ?? {}
  return {
    ok: true,
    version: 'mc-body/v1',
    connected: state.connected,
    online: state.connected,
    paused: state.paused,
    pausedReason: state.pausedReason,
    pauseReason: state.pausedReason,
    playable: state.playable ?? { ok: state.connected && !state.paused, blockers: state.connected ? (state.paused ? [`paused:${state.pausedReason ?? 'safety'}`] : []) : ['offline'] },
    spawnLog: state.spawnLog ?? [{ at: Date.now(), position: { x: 358.4, y: -60, z: 113.6 }, dimension: 'overworld', source: 'initial', safe: true }],
    safety: {
      paused: state.paused, reason: state.pausedReason, offline: !state.connected, offlineReason: state.connected ? null : 'socketClosed', everOnline: true,
      note: state.paused ? 'paused = 停任务/停控制，但身体仍在世界（会掉落/受伤/被推）；安全反射开启' : null,
      reflex: state.paused ? { enabled: true, active: false, count: 0, maxPerMinute: 2, maxDurationMs: 10000 } : { enabled: true, active: false, count: 0, maxPerMinute: 2, maxDurationMs: 10000 },
      lastReflex: state.lastReflex ?? null,
      autoDefense: state.autoDefense ?? {
        enabled: true, active: false, count: 2, maxPerMinute: 4, cooldownMs: 8000, threatDistance: 6, creeperDistance: 5,
        lastAt: Date.now() - 30_000, lastReason: 'threat', lastAction: 'backoff', lastDurationMs: 220, lastTimedOut: false,
      },
      lastDefense: state.lastDefense ?? { at: Date.now() - 30_000, reason: 'threat', action: 'backoff', durationMs: 220, timedOut: false },
      recovery: state.recovery ?? {
        resumeGraceMs: 3000, lowHealthPauseCooldownMs: 8000, criticalHealth: 4,
        resumeGraceUntil: Date.now() + 2000, lowHealthPauseCooldownUntil: null, pausedRecoverable: true,
      },
    },
    task: state.task,
    home: state.home === undefined ? null : state.home,
    queue: [],
    pausedTasks: extra.pausedTasks,
    eventsSeq: state.seq,
    reconnect: state.reconnect ?? { attempts: 0, max: 3, exhausted: false, pending: false, lastError: null },
    watchdog: { ticks: 5, alerts: 1, suppressed: state.suppressed ?? 0, healthDropSuppressed: 0 },
    adapter: {
      connected: state.connected,
      host: '127.0.0.1',
      port: 54837,
      self: 'ICL-mclink-1',
      players: ['ICL-mclink-1', 'Hahn123_'],
      position: { x: 12.5, y: 64, z: -8.5 },
      health: state.health,
      food: 18,
      oxygen: state.oxygen === undefined ? null : state.oxygen,
      inventoryCount: state.inventoryCount ?? 4,
      inventory: { used: state.inventoryUsed ?? 2, full: false },
      nearby: { villager: 1 },
      nearbyHostiles: state.nearbyHostiles ?? [{ name: 'zombie', distance: 6.2, position: { x: 20.4, y: 64, z: -3.1 } }],
      dimension: 'overworld',
      environment: extra.environment,
      pathfinder: extra.pathfinder,
    },
  }
}

async function startFakeBody({ connected = true } = {}) {
  const state = {
    connected,
    paused: false,
    pausedReason: null,
    task: null,
    health: 20,
    seq: 0,
    events: [],
    requests: [],
    doDelay: 0,
    statusError: null,
    doError: null,
    eyesScreenshot: 'ok',
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    const read = (fn) => { let raw = ''; req.on('data', (chunk) => { raw += chunk }); req.on('end', () => fn(raw ? JSON.parse(raw) : {})) }
    if (url.pathname === '/v1/eyes/snapshot' && req.method === 'GET') {
      return send(200, {
        ok: true,
        captureMs: 3,
        snapshot: {
          version: 1, kind: 'structured', ts: new Date().toISOString(), radius: Number(url.searchParams.get('radius') ?? 8),
          position: { x: 12.5, y: 64, z: -8.5 }, dimension: 'overworld', health: 20, food: 18, oxygen: null,
          time: { label: 'day 3 06:00' }, sleeping: false,
          held: { name: 'stone_pickaxe', count: 1, toolFor: 'pickaxe' },
          hotbar: [{ slot: 1, name: 'stone_pickaxe', count: 1, selected: true }],
          inventory: { used: 2, emptySlots: 34, counts: { dirt: 12, oak_log: 3 } },
          lookingAt: null,
          map: '# # . .\n# # . .',
          nearbyBlocks: { stone: 8, dirt: 5 },
          entities: [{ name: 'zombie', distance: 12.5, position: { x: 1, y: 64, z: 2 } }],
          nearbyHostiles: [{ name: 'zombie', distance: 12.5 }],
          task: { id: 't-1', kind: 'mine', state: 'running' },
          queue: [],
          safety: { paused: false, reflex: { enabled: true, active: false }, alarms: { delivered: 1, suppressed: 0 } },
          playable: { ok: true, blockers: [] },
          recentEvents: [{ seq: 9, type: 'task_started', at: Date.now() }],
        },
      })
    }
    if (url.pathname === '/v1/eyes/screenshot' && req.method === 'POST') {
      state.eyesRequests = state.eyesRequests ?? []
      return read((input) => {
        state.eyesRequests.push(input)
        if (state.eyesScreenshot === '501') return send(501, { ok: false, error: 'body 未配置截图能力（需要 adapter viewer + Edge；见 docs/MC-EYES.md）' })
        if (state.eyesScreenshot === '429') return send(429, { ok: false, error: '截图限频：距上次 5s；至少 15s 一次（成本高）' })
        if (state.eyesScreenshot === '500') return send(500, { ok: false, error: '截图失败：Edge 没开 DevTools' })
        const file = path.join(os.tmpdir(), 'mc-eyes-test', '2026-11-06T04-00-00-000Z-manual.png')
        return send(200, {
          ok: true, outBase: file.replace(/\.png$/, ''), files: [{ file, bytes: 267000, at: new Date().toISOString() }],
          captureMs: 7100,
          meta: { viewport: { width: 1280, height: 720 }, position: { x: 12.5, y: 64, z: -8.5 }, task: { kind: 'mine', state: 'running' }, safety: { paused: false } },
        })
      })
    }
    if (url.pathname === '/v1/status') {
      if (state.statusError) return send(500, { ok: false, error: state.statusError })
      return send(200, statusBody(state))
    }
    if (url.pathname === '/v1/events') {
      const since = Number(url.searchParams.get('since') ?? 0)
      return send(200, { ok: true, seq: state.seq, events: state.events.filter((event) => event.seq > since) })
    }
    if (url.pathname === '/v1/inspect' && req.method === 'POST') {
      return read((input) => {
        if (input.kind === 'scan' && state.scanRows != null) {
          const name = input.params?.name ?? 'dirt'
          const text = state.scanRows > 0
            ? Array.from({ length: state.scanRows }, (_, i) => `${name} @ ${i},-60,0（${(i * 0.5 + 0.5).toFixed(1)}m）`).join('\n')
            : `附近没有 ${name}。`
          return send(200, { ok: true, result: { text } })
        }
        // 真 body 的 look/inventory 文本里有原始小数（health 17.8333…），用来验证 mc-link 的统一取整。
        if (input.kind === 'look') {
          return send(200, { ok: true, result: {
            text: ['位置：358.7, -60.2, 113.9；朝向 yaw=90°', '生命/饥饿/氧气：17.833332061767578/18/0', '手持：空'].join('\n'),
            data: { position: { x: 358.7, y: -60.2, z: 113.9 }, health: 17.833332061767578, food: 18 },
          } })
        }
        if (input.kind === 'inventory') return send(200, { ok: true, result: { text: '背包：dirt×12、oak_log×3' } })
        return send(200, { ok: true, result: { text: `inspect:${input.kind}` } })
      })
    }
    if (url.pathname === '/v1/do' && req.method === 'POST') {
      return read(async (input) => {
        state.requests.push(input)
        if (state.doDelay) await sleep(state.doDelay)
        if (state.doError) return send(409, { ok: false, error: state.doError })
        const results = []
        for (const step of input.steps ?? []) {
          if (state.doFailOnOp && step.op === state.doFailOnOp) return send(409, { ok: false, error: state.doFailError ?? '挖不动（测试）' })
          // 模拟真 body：task 之前的 steps 结果一并返回，然后立即返回 taskId。
          if (step.op === 'task') return send(200, { ok: true, results, task: { id: 't-1', kind: step.kind, state: 'queued' } })
          if (step.op === 'events') results.push({ index: results.length, op: 'events', result: { events: state.events, seq: state.seq } })
          else if (step.op === 'tasks') results.push({ index: results.length, op: 'tasks', result: [{ id: 't-1', kind: 'mine', state: 'done', result: { mined: 2 } }, { id: 't-2', kind: 'goto', state: 'failed', error: 'timeout' }, { id: 't-3', kind: 'hunt', state: 'running', progress: { target: 'zombie', distance: 4.2, attacks: 3, health: 14, hostiles: [{ name: 'zombie' }] } }] })
          else if (step.op === 'resume') {
            state.paused = false
            state.pausedReason = null
            // 真 body：带 taskId 走 resumeTask 返回被恢复的任务；不带则是安全暂停的解除。
            results.push({ index: results.length, op: 'resume', result: step.taskId ? { id: step.taskId, kind: 'mine', state: 'running' } : { paused: false } })
          }
          else if (step.op === 'say') results.push({ index: results.length, op: 'say', result: { ok: true } })
          else if (step.op === 'pickup') results.push({ index: results.length, op: 'pickup', result: state.pickupResult ?? { picked: 2, items: ['dirt', 'oak_log'], radius: 8, left: 1 } })
          else if (step.op === 'attack') results.push({ index: results.length, op: 'attack', result: state.attackResult ?? { attacked: 'chicken' } })
          else if (step.op === 'wait') results.push({ index: results.length, op: 'wait', result: { ok: true, ms: step.params?.ms } })
          else if (step.op === 'dig') results.push({ index: results.length, op: 'dig', result: { dug: 'dirt', pos: { x: 12.6, y: -59.6, z: 14.4 } } })
          else results.push({ index: results.length, op: step.op, result: { text: `did:${step.op}` } })
        }
        return send(200, { ok: true, results })
      })
    }
    if (url.pathname === '/v1/safety/stop' && req.method === 'POST') {
      state.paused = true
      state.pausedReason = 'user-stop'
      // 新版 body stopAll 的回执：任务/身体分开说 + reflex。
      const cancelled = state.task && state.task.state !== 'interrupted' ? [{ id: state.task.id, kind: state.task.kind, state: 'cancelled' }] : []
      return send(200, {
        ok: true,
        paused: true,
        pausedReason: 'user-stop',
        task: { cancelled, note: cancelled.length ? `任务已停（取消 ${cancelled.length} 个）` : '任务已停（没有在跑/排队的任务）' },
        body: { online: state.connected, position: { x: 12.5, y: 64, z: -8.5 }, health: state.health, food: 18, note: '身体仍在世界（会掉落/受伤/被推）；安全反射保持开启，resume 后再下任务' },
        reflex: { enabled: true, active: false, count: 0, maxPerMinute: 2, maxDurationMs: 10000 },
        safety: { reason: 'user-stop', alarm: true, priority: 'alarm', pierce: true },
      })
    }
    return send(404, { ok: false, error: 'not found' })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    server,
    port: server.address().port,
    state,
    push(event) { state.seq += 1; state.events.push({ seq: state.seq, at: Date.now(), ...event }); return state.seq },
    async close() { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)) },
  }
}

async function mountLink({ port, config = {}, timePhase = null, timeApi = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-mc-link-'))
  const host = createHost({ log: () => {} })
  // 模拟 time 插件 provide 的公开 api（phase/status）：睡眠守卫与睡眠边界展示要用。
  // 插件侧 ctx.services.get('time') 读的是 host 的 shared 注册表。
  const time = timeApi ?? (timePhase ? { phase: () => timePhase } : null)
  if (time) host.shared.set('time', time)
  host.registerPlugin(manifest, mcLink, {
    config: { baseUrl: `http://127.0.0.1:${port}`, pollMs: 60_000, logFile: path.join(root, 'events.jsonl'), ...config },
  })
  await host.enable('mc-link')
  const pushed = []
  const adapter = createSessionAdapter({ sessionId: `mc-link-${Math.random().toString(16).slice(2)}`, host, push: async (text) => { pushed.push(String(text)) } })
  const api = host.shared.get('mc-link')
  const tools = Object.fromEntries(host.services.tools.list().map((tool) => [tool.name, tool]))
  return {
    host, adapter, api, tools, pushed, root,
    async cleanup() { adapter.dispose(); host.disable('mc-link') },
  }
}

function openPort() {
  return new Promise((resolve) => {
    const server = http.createServer(() => {})
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

test('工具面：17 个 mcb_*，描述自足且不超预算；提示词只有事实段（无 mc:play/mc:interaction）', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    const names = Object.keys(link.tools).sort()
    assert.deepEqual(names, ['mcb_attack', 'mcb_combat', 'mcb_do', 'mcb_eyes', 'mcb_help', 'mcb_inventory', 'mcb_join', 'mcb_lan', 'mcb_leave', 'mcb_look', 'mcb_map', 'mcb_scan', 'mcb_servers', 'mcb_shelter', 'mcb_snapshot', 'mcb_status', 'mcb_stop'])
    let total = 0
    for (const tool of Object.values(link.tools)) {
      assert.ok(tool.description.length > 60, `${tool.name} 描述太短`)
      assert.ok(tool.description.length <= 900, `${tool.name} 描述超 900 预算：${tool.description.length}`)
      total += tool.description.length
    }
    // 17 个工具（眼睛 + 战斗 + 盖房）总量上调；每工具 900 预算不变（composeToolDescription 强制）
    assert.ok(total <= 6600, `工具描述总量 ${total} 超预算`)
    // 操作教学必须在工具描述里，而不是全局提示词段里。
    assert.match(link.tools.mcb_join.description, /server|host/)
    assert.match(link.tools.mcb_do.description, /tasks|op/)
    assert.match(link.tools.mcb_do.description, /resume/)
    const sections = link.host.services.prompt.names()
    assert.deepEqual(sections, ['mc:status', 'mc:skills'])
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('提示词段：连上后 mc:status 只有 1 行事实、≤120 字；mc:skills 只在命中时出现', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    await link.api.poll()
    const text = link.host.services.prompt.assemble({ sessionId: 'test' })
    const statusLine = text.split('\n').find((line) => line.startsWith('MC｜'))
    assert.ok(statusLine, `应有一行 MC 状态：${text}`)
    assert.ok(statusLine.length <= 120, `状态行过长：${statusLine.length}`)
    assert.match(statusLine, /在线/)
    assert.match(statusLine, /13,64,-8/)
    assert.doesNotMatch(statusLine, /mcb_|focus_enter|time_arrange/)
    assert.ok(!/你先|应该|记得/.test(statusLine), '事实段不许教导')
    assert.match(text, /MC 技能：.*mcb_help/)
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('mcb_status：body 不在时报未连接 + 下一步，不假装在线', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    await link.api.poll()
    await body.close()
    const out = await link.tools.mcb_status.execute({})
    assert.match(out.text, /未连接/)
    assert.match(out.text, /下一步/)
    assert.doesNotMatch(out.text, /已连接 127\.0\.0\.1:54837/)
  } finally {
    await link.cleanup()
  }
})

test('mcb_do：缺 kind / 未知 op / 未知 kind 都给出可用集合与下一步', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    await link.api.poll()
    await assert.rejects(() => link.tools.mcb_do.execute({ steps: [{ op: 'task' }] }), /缺少 kind.*mine/)
    await assert.rejects(() => link.tools.mcb_do.execute({ steps: [{ op: 'mineee' }] }), /你是不是要 mine/)
    await assert.rejects(() => link.tools.mcb_do.execute({ steps: [{ op: 'task', kind: 'fly' }] }), /未知任务 kind.*mine/)
    await assert.rejects(() => link.tools.mcb_do.execute({ steps: [] }), /至少 1 步/)
    await assert.rejects(() => link.tools.mcb_do.execute({ steps: [{ op: 'say' }] }), /say 需要 text/)
    await assert.rejects(() => link.tools.mcb_do.execute({ steps: [{ op: 'say', text: '/kill @a' }] }), /不允许以 \/ 开头/)
    await assert.rejects(() => link.tools.mcb_do.execute({ steps: [{ op: 'cancel' }] }), /需要 taskId/)
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('mcb_do：宏 kind（collect/tunnel/bridge/build/sort/shelter/farm）全部放行并透传', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    await link.api.poll()
    for (const kind of ['collect', 'tunnel', 'bridge', 'build', 'sort', 'deposit', 'shelter', 'farm']) {
      const out = await link.tools.mcb_do.execute({ steps: [{ op: 'task', kind, params: {} }] })
      assert.match(out.text, new RegExp(`任务 t-1（${kind}）已接受`))
      assert.equal(body.state.requests.at(-1).steps[0].kind, kind)
    }
    // 描述里要有宏教学与"别逐方块"的指引
    const desc = link.tools.mcb_do.description
    assert.match(desc, /宏/)
    assert.match(desc, /collect/)
    assert.match(desc, /别逐方块/)
    assert.match(desc, /needs-tool/)
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('mcb_do：task 的 kind/params 规整后交给 body（不再出现"未知任务：undefined"）', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    await link.api.poll()
    const out = await link.tools.mcb_do.execute({ steps: [{ op: 'task', params: { kind: 'mine', block: 'oak_log', count: 2 } }] })
    assert.match(out.text, /任务 t-1（mine）已接受/)
    const sent = body.state.requests.at(-1).steps[0]
    assert.equal(sent.op, 'task')
    assert.equal(sent.kind, 'mine')
    assert.deepEqual(sent.params, { kind: 'mine', block: 'oak_log', count: 2 })
    assert.ok(Number(sent.deadlineMs) > 0)
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('mcb_do：events 默认用轮询游标（不从头 dump），tasks 渲染结果与错误', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    await link.api.poll()
    body.push({ type: 'spawn', data: { position: { x: 1, y: 2, z: 3 } } })
    body.push({ type: 'health', data: { health: 20, food: 18 } })
    await link.api.poll()
    body.push({ type: 'task_done', data: { task: { id: 't-1', kind: 'mine', result: { mined: 2 } } } })
    const events = await link.tools.mcb_do.execute({ steps: [{ op: 'events' }] })
    const sent = body.state.requests.at(-1).steps[0]
    assert.equal(sent.op, 'events')
    assert.equal(typeof sent.since, 'number')
    assert.ok(sent.since >= 2, `默认 since 应跟上轮询游标，实际 ${sent.since}`)
    assert.match(events.text, /#\d+ task_done · .*挖了 2/)
    const tasks = await link.tools.mcb_do.execute({ steps: [{ op: 'tasks' }] })
    assert.match(tasks.text, /#t-1 mine done/)
    assert.match(tasks.text, /#t-2 goto failed error=timeout/)
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('mcb_do：长动作超时不抛裸错，告诉先查状态、不要原样重试', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port, config: { doTimeoutMs: 150 } })
  try {
    await link.api.poll()
    body.state.doDelay = 400
    const out = await link.tools.mcb_do.execute({ steps: [{ op: 'goto', params: { x: 1, y: 2, z: 3 } }] })
    assert.match(out.text, /没有返回/)
    assert.match(out.text, /不要原样重试/)
    assert.match(out.text, /mcb_status/)
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('mcb_do：body 报 409（单飞锁）时说"长动作用 task、别并发单步"', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    await link.api.poll()
    body.state.doError = '上一个 do 动作还在执行（单飞锁），长任务请用 task 形式'
    await assert.rejects(() => link.tools.mcb_do.execute({ steps: [{ op: 'mine', params: { name: 'dirt' } }] }), /长动作一律用|别并发单步/)
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('mcb_do：pickup 单步 op 可用，返回说人话（picked/items/left）', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    const out = await link.tools.mcb_do.execute({ steps: [{ op: 'pickup', params: { radius: 8, max: 4 } }] })
    assert.match(out.text, /\[pickup\] 捡到 2 个（dirt、oak_log）；附近还剩 1 个掉落/)
    const sent = body.state.requests.at(-1).steps[0]
    assert.equal(sent.op, 'pickup')
    assert.deepEqual(sent.params, { radius: 8, max: 4 })
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('口径统一：look/status/inventory 的位置、血量、背包同源同取整（不出现 17.8333 / 差几格）', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    await link.api.poll()
    // look：body 原文是 358.7/-60.2/113.9 与 17.8333…，统一后必须是 359,-60,114 与 18/18/0
    const look = await link.tools.mcb_look.execute({})
    assert.match(look.text, /位置：359,-60,114；朝向 yaw=90°/)
    assert.match(look.text, /生命\/饥饿\/氧气：18\/18\/0/)
    assert.doesNotMatch(look.text, /17\.83/)
    // status：同一位置、同一血量取整、背包区分"件/格"
    const status = await link.tools.mcb_status.execute({})
    assert.match(status.text, /位置：13,64,-8/, 'statusBody 的 12.5/-8.5 取整后与 join/look 同口径')
    assert.match(status.text, /生命\/饥饿\/氧气：20\/20，18\/20/)
    assert.match(status.text, /背包：4 件（占 2 格）/)
    // inventory：body 列表 + 统一汇总行（件=物品总数，格=占用格子）
    const inventory = await link.tools.mcb_inventory.execute({})
    assert.match(inventory.text, /背包：dirt×12、oak_log×3/)
    assert.match(inventory.text, /合计：4 件（占 2 格）（件=物品总数，格=占用背包格子）/)
    // dig 结果里的坐标（12.6/-59.5/14.4）也统一取整
    const dig = await link.tools.mcb_do.execute({ steps: [{ op: 'dig', params: { pos: { x: 12.6, y: -59.5, z: 14.4 } } }] })
    assert.match(dig.text, /\[dig\] \{"dug":"dirt","pos":\{"x":13,"y":-60,"z":14\}\}/)
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('mcb_do：攻击结果必须能判断命中（新字段命中/伤害/剩余血；旧 body 只回名字要显式说"无法确认"）', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    // 旧 body：只回 {attacked:"chicken"} → 不能当成功
    body.state.attackResult = { attacked: 'chicken' }
    const old = await link.tools.mcb_do.execute({ steps: [{ op: 'attack', params: { target: 'chicken' } }] })
    assert.match(old.text, /无法确认命中/)
    assert.doesNotMatch(old.text, /命中 chicken/)
    // 新 body：命中 + 伤害 + 目标剩余血
    body.state.attackResult = { attacked: 'chicken', hit: true, damage: 3, target: { name: 'chicken', health: 1 } }
    const hit = await link.tools.mcb_do.execute({ steps: [{ op: 'attack', params: { target: 'chicken' } }] })
    assert.match(hit.text, /\[attack\] 命中 chicken/)
    assert.match(hit.text, /造成 3 伤害/)
    assert.match(hit.text, /目标剩余 1 血/)
    // 明确未命中 → 可读原因
    body.state.attackResult = { attacked: 'chicken', hit: false, reason: '太远' }
    const miss = await link.tools.mcb_do.execute({ steps: [{ op: 'attack', params: { target: 'chicken' } }] })
    assert.match(miss.text, /没打中 chicken（太远）/)
    // 击杀 → 提示 pickup 捡掉落
    body.state.attackResult = { attacked: 'chicken', id: 7, hit: true, killed: true, damage: 2, healthBefore: 2, healthAfter: 0 }
    const killed = await link.tools.mcb_do.execute({ steps: [{ op: 'attack', params: { target: 'chicken' } }] })
    assert.match(killed.text, /打死 chicken/)
    assert.match(killed.text, /最后一击 2 伤害/)
    assert.match(killed.text, /pickup/)
    // 血量前后都带
    body.state.attackResult = { attacked: 'sheep', hit: true, killed: false, damage: 1.5, healthBefore: 6, healthAfter: 4.5 }
    const hp = await link.tools.mcb_do.execute({ steps: [{ op: 'attack', params: { target: 'sheep' } }] })
    assert.match(hp.text, /造成 1\.5 伤害（血 6→4\.5）/)
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('mcb_attack：单目标工具（target 必填，命中/击杀可读）；mcb_combat：战斗宏一条 task', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    await assert.rejects(() => link.tools.mcb_attack.execute({}), /需要 target/)
    body.state.attackResult = { attacked: 'zombie', hit: true, killed: true, damage: 5, healthBefore: 5, healthAfter: 0 }
    const hit = await link.tools.mcb_attack.execute({ target: 'zombie', range: 4 })
    assert.match(hit.text, /打死 zombie/)
    const sentAttack = body.state.requests.at(-1).steps[0]
    assert.equal(sentAttack.op, 'attack')
    assert.equal(sentAttack.params.target, 'zombie')
    assert.equal(sentAttack.params.range, 4)
    await assert.rejects(() => link.tools.mcb_combat.execute({ mode: 'fly' }), /mode 只能是 hunt\/defend\/flee\/guard/)
    const combat = await link.tools.mcb_combat.execute({ mode: 'hunt', target: 'zombie', lowHealth: 8 })
    assert.match(combat.text, /任务 t-1（hunt）已接受/)
    const sentCombat = body.state.requests.at(-1).steps[0]
    assert.equal(sentCombat.kind, 'hunt')
    assert.equal(sentCombat.params.target, 'zombie')
    assert.equal(sentCombat.params.lowHealth, 8)
    // 默认可用：不给 mode 也按 hunt 执行，并说明默认了
    const defaulted = await link.tools.mcb_combat.execute({})
    assert.match(defaulted.text, /任务 t-1（hunt）已接受/)
    assert.match(defaulted.text, /没指定 mode，默认按 hunt/)
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('发现性：mcb_do 第一行教"打架→combat/补刀→attack/采集建造→task 宏"；单步重复动作回执提示宏（节流）', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    const desc = link.tools.mcb_do.description
    assert.match(desc, /^.*想打架\/追怪→mcb_combat；补刀→mcb_attack；采集\/建造→/)
    assert.match(desc, /别逐方块/)
    // 单步重复动作（dig/mine/goto…）→ 回执提示可用宏
    const first = await link.tools.mcb_do.execute({ steps: [{ op: 'dig', params: { pos: { x: 1, y: 2, z: 3 } } }] })
    assert.match(first.text, /这类重复动作可用宏/)
    assert.match(first.text, /mcb_combat/)
    // 节流：紧接着再做单步，不再重复提示
    const second = await link.tools.mcb_do.execute({ steps: [{ op: 'dig', params: { pos: { x: 1, y: 2, z: 3 } } }] })
    assert.doesNotMatch(second.text, /这类重复动作可用宏/)
    // 下发宏 task 时不提示（已经在用宏）
    const macro = await link.tools.mcb_do.execute({ steps: [{ op: 'task', kind: 'collect', params: { item: 'oak_log', count: 2 } }] })
    assert.doesNotMatch(macro.text, /这类重复动作可用宏/)
    // play.md 开头有一行宏链示例
    const play = await link.tools.mcb_help.execute({ skill: 'play' })
    assert.match(play.text, /一行宏链/)
    assert.match(play.text, /采集→合成→装备/)
    // 附近有敌对时，mc:skills 提示直接指向战斗宏（提高发现性）
    await link.api.poll()
    const promptText = link.host.services.prompt.assemble({ sessionId: 'test' })
    assert.match(promptText, /combat/)
    assert.match(promptText, /mcb_combat/)
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('mcb_shelter：盖房 task 透传（size/height/material/door）', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    const out = await link.tools.mcb_shelter.execute({ size: 5, height: 4, material: 'oak_planks', door: true })
    assert.match(out.text, /任务 t-1（shelter）已接受/)
    const sent = body.state.requests.at(-1).steps[0]
    assert.equal(sent.kind, 'shelter')
    assert.deepEqual(sent.params, { size: 5, height: 4, material: 'oak_planks', door: true })
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('mcb_status：显示 home（家）与"还没设家"提示', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    const none = await link.tools.mcb_status.execute({})
    assert.match(none.text, /家：还没设（mcb_shelter 盖一间/)
    body.state.home = { center: { x: 40.2, y: 64, z: -12.7 }, size: 3, height: 3, doorSide: 'south', doorPlaced: 'oak_door', builtAt: Date.now() - 60_000 }
    const status = await link.tools.mcb_status.execute({})
    assert.match(status.text, /家：40,64,-13（3×3，高 3，门在 south，已装 oak_door/)
    assert.match(status.text, /夜里\/下雨\/被追回 home\.center 躲/)
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('事件：home_set 可读；战斗任务在 tasks 台账里带 progress（可 cancel/危机中断）', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    await link.api.poll()
    body.push({ type: 'home_set', data: { home: { center: { x: 40, y: 64, z: -13 }, size: 3, doorSide: 'south', doorPlaced: 'oak_door' } } })
    await link.api.poll()
    await link.adapter.drainOnce()
    assert.match(link.pushed.join('\n'), /家已设：40,64,-13（3×3，门在 south，已装门 oak_door）/)
    const tasks = await link.tools.mcb_do.execute({ steps: [{ op: 'tasks' }] })
    assert.match(tasks.text, /#t-3 hunt running target=zombie dist=4\.2 attacks=3 hp=14 hostiles=1/)
    assert.match(tasks.text, /可 cancel；低血\/苦力怕\/敌人多会先自动躲避再中断/)
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('mcb_help：shelter/build 可查（模糊名也行）', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    const list = await link.tools.mcb_help.execute({})
    assert.match(list.text, /shelter/)
    assert.match(list.text, /build/)
    const shelter = await link.tools.mcb_help.execute({ skill: 'shel' })
    assert.match(shelter.text, /盖房 \/ 回家 \/ 躲藏/)
    assert.match(shelter.text, /verify\.summary/)
    const build = await link.tools.mcb_help.execute({ skill: 'buil' })
    assert.match(build.text, /蓝图建造/)
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('mcb_status：附近敌对 / 自动防御 / 恢复宽限（低血恢复期）都单列', async () => {
  const body = await startFakeBody()
  body.state.paused = true
  body.state.pausedReason = 'low-health'
  const link = await mountLink({ port: body.port })
  try {
    const status = await link.tools.mcb_status.execute({})
    assert.match(status.text, /附近敌对：zombie\(6\.2m @ 20,64,-3\)/)
    assert.match(status.text, /自动防御：开启（已 2 次；冷却 8s；威胁距离 6m \/ 苦力怕 5m）/)
    assert.match(status.text, /最近一次：.*有威胁.*→ backoff（220ms）/)
    assert.match(status.text, /恢复规则：resume 宽限剩余 \d+s/)
    assert.match(status.text, /低血暂停冷却/)
    assert.match(status.text, /极低血 ≤4 才会立即再暂停/)
    assert.match(status.text, /当前暂停可恢复/)
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('事件：auto_defense / combat_abort / safety_stop(threat) 都有可读文案', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    await link.api.poll()
    body.push({ type: 'auto_defense', data: { reason: 'threat', action: 'backoff', durationMs: 220, timedOut: false } })
    await link.api.poll()
    await link.adapter.drainOnce()
    assert.match(link.pushed.join('\n'), /自动躲避：.*→ 已自动躲避（220ms）/)
    assert.doesNotMatch(link.pushed.join('\n'), /\[object Object\]/)
    body.push({ type: 'combat_abort', data: { mode: 'hunt', reason: 'low-health', hostiles: [{ name: 'zombie', distance: 3 }], health: 6 } })
    await link.api.poll()
    await link.adapter.drainOnce()
    assert.match(link.pushed.join('\n'), /战斗中断：low-health（zombie 3m）/)
    body.push({ type: 'safety_stop', data: { reason: 'threat' } })
    await link.api.poll()
    await link.adapter.drainOnce()
    assert.match(link.pushed.join('\n'), /安全停止：有威胁/)
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('pickup partial：超时未捡完要说清楚（不假装全捡到）', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    body.state.pickupResult = { picked: 1, items: ['dirt'], radius: 8, left: 3, partial: true, durationMs: 20000 }
    const out = await link.tools.mcb_do.execute({ steps: [{ op: 'pickup', params: { radius: 8 } }] })
    assert.match(out.text, /捡到 1 个（dirt）；附近还剩 3 个掉落（partial：20000ms 内没捡完/)
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('mcb_do：批处理一步失败也带回已执行步骤的结果（失败归因到第几步）', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    body.state.doFailOnOp = 'dig'
    await assert.rejects(
      () => link.tools.mcb_do.execute({ steps: [{ op: 'look' }, { op: 'dig', params: { pos: { x: 1, y: 2, z: 3 } } }, { op: 'say', text: '不该执行' }] }),
      /第 2 步（dig）失败[\s\S]*已完成的前序步骤[\s\S]*did:look/,
    )
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('mcb_do：wait 单次 ≤30s（超了截断并提示长任务别轮询）', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    const out = await link.tools.mcb_do.execute({ steps: [{ op: 'wait', params: { durationMs: 120_000 } }] })
    const sent = body.state.requests.at(-1).steps[0]
    assert.equal(sent.params.ms, 30_000, 'wait 必须截断到 30s')
    assert.match(out.text, /参数处理：.*wait 单次最多 30s.*长任务不要用 wait 轮询/)
    const short = await link.tools.mcb_do.execute({ steps: [{ op: 'wait', params: { ms: 2_000 } }] })
    assert.equal(body.state.requests.at(-1).steps[0].params.ms, 2_000)
    assert.doesNotMatch(short.text, /参数处理/)
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('mcb_do：任务提交回执明确"不要循环查"；暂停报错给可操作建议而不是只说先 resume', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    const task = await link.tools.mcb_do.execute({ steps: [{ op: 'task', kind: 'mine', params: { block: 'dirt', count: 2 } }] })
    assert.match(task.text, /已接受/)
    assert.match(task.text, /不要循环 mcb_status\/tasks 查/)
    body.state.doError = '身体已暂停（low-health）；先 /v1/safety/resume，或只用 look/inventory'
    await assert.rejects(() => link.tools.mcb_do.execute({ steps: [{ op: 'dig', params: { name: 'dirt' } }] }), /先吃|撤到安全点|再次暂停/)
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('mcb_do：body 报"已暂停"时补上恢复路径', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    await link.api.poll()
    body.state.doError = '身体已暂停（death）；先 resume，或只用 look/inventory'
    await assert.rejects(() => link.tools.mcb_do.execute({ steps: [{ op: 'dig', params: { name: 'dirt' } }] }), /复活|再次暂停|resume/)
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('mcb_join：失败给进程退出码 + body 日志（不是"没有连上"一句话）', async () => {
  const port = await openPort()
  const link = await mountLink({ port, config: { bodyEntry: path.join(os.tmpdir(), 'no-such-mc-body-entry.mjs'), startTimeoutMs: 5000 } })
  try {
    await assert.rejects(
      () => link.tools.mcb_join.execute({ host: '127.0.0.1', port: 54837 }),
      (error) => {
        assert.match(error.message, /进程在连上服务器前就退出|没能在/)
        assert.match(error.message, /退出码 1|Cannot find module|ERR_MODULE_NOT_FOUND/)
        return true
      },
    )
  } finally {
    await link.cleanup()
  }
})

test('mcb_leave：复用外部 body 时只安全停止，说清楚进程不归本会话；focus/goal 不被动', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    const joined = await link.tools.mcb_join.execute({ server: 'flat' })
    assert.match(joined.text, /已连接 127\.0\.0\.1:54837/)
    const left = await link.tools.mcb_leave.execute({})
    assert.match(left.text, /不是本会话启动的/)
    assert.match(left.text, /body 进程：本会话没有启动过/)
    assert.match(left.text, /外部 body 仍在线/)
    assert.equal(body.state.paused, true, 'leave 必须先安全停止')
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('mcb_join：服务器清单是单一定义（flat 54837 + survival 54838 都在）', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    const out = await link.tools.mcb_servers.execute({})
    assert.match(out.text, /flat\s+127\.0\.0\.1:54837/)
    assert.match(out.text, /survival\s+127\.0\.0\.1:54838/)
    await assert.rejects(() => link.tools.mcb_join.execute({ server: 'flat2' }), /没有这个服务器.*是不是要 flat/)
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('事件→信号：掉血/死亡刷屏合并限流，一轮不刷屏', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    await link.api.poll()
    for (let i = 0; i < 20; i += 1) body.push({ type: 'health_drop', data: { from: 20 - i, to: 19 - i } })
    for (let i = 0; i < 5; i += 1) body.push({ type: 'death', data: {} })
    await link.api.poll()
    await link.adapter.drainOnce()
    assert.ok(link.pushed.length <= 3, `刷屏事件应合并成少量消息，实际 ${link.pushed.length}：${link.pushed.slice(0, 3).join(' / ')}`)
    const text = link.pushed.join('\n')
    assert.match(text, /掉血/)
    assert.match(text, /死亡/)
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('事件→信号：task_failed 带原因码时消息给出失败原因与下一步', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    await link.api.poll()
    body.push({ type: 'task_failed', data: { task: { id: 't-3', kind: 'mine', params: { block: 'oak_log', count: 4 }, state: 'failed', error: 'mine: no-target', result: { mined: 0 } } } })
    await link.api.poll()
    await link.adapter.drainOnce()
    const text = link.pushed.join('\n')
    assert.match(text, /任务失败/)
    assert.match(text, /no-target/)
    assert.match(text, /radius/)
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('mcb_status：body 活着但没连上（重连中）时显示离线原因与重连次数，不假在线', async () => {
  const body = await startFakeBody({ connected: false })
  const link = await mountLink({ port: body.port })
  try {
    body.state.reconnect = { attempts: 2, max: 3, exhausted: false, pending: true, lastError: 'socketClosed' }
    const out = await link.tools.mcb_status.execute({})
    assert.match(out.text, /未连接/)
    assert.doesNotMatch(out.text, /MC 身体：已连接/)
    assert.match(out.text, /离线原因/)
    assert.match(out.text, /重连：第 2\/3 次/)
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('mcb_status：陆地上 body 的 oxygen=null 显示 ?（不是 0）', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    const dry = await link.tools.mcb_status.execute({})
    assert.match(dry.text, /生命\/饥饿\/氧气：20\/20，18\/20，\?/)
    body.state.oxygen = 7
    const wet = await link.tools.mcb_status.execute({})
    assert.match(wet.text, /生命\/饥饿\/氧气：20\/20，18\/20，7/)
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('mcb_do：sleep 在 OPS 白名单里，能传到 body', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    const out = await link.tools.mcb_do.execute({ steps: [{ op: 'sleep' }] })
    assert.match(out.text, /\[sleep\]/)
    assert.equal(body.state.requests.at(-1).steps[0].op, 'sleep')
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('mcb_do：resume 带 taskId 时显示被恢复的任务', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    body.state.doError = null
    const out = await link.tools.mcb_do.execute({ steps: [{ op: 'resume', taskId: 't-7' }] })
    assert.match(out.text, /\[resume\]/)
    const sent = body.state.requests.at(-1).steps[0]
    assert.equal(sent.taskId, 't-7')
    assert.equal(sent.op, 'resume')
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('事件→信号：body 失去响应时报告（不假在线），但单次 HTTP 失败不报警（外部干净关闭有亚秒空窗）', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    await link.api.poll()
    await body.close()
    // 第一次失败：可能只是 /v1/shutdown 的 HTTP 先断、exit 事件后到——不报警。
    await link.api.poll()
    await link.adapter.drainOnce()
    assert.doesNotMatch(link.pushed.join('\n'), /连不上 body/, '单次失败不报警')
    // 连续第二次失败才确认失联并报警。
    await link.api.poll()
    await link.adapter.drainOnce()
    assert.match(link.pushed.join('\n'), /连不上 body/)
    const before = link.pushed.length
    await link.api.poll()
    await link.adapter.drainOnce()
    assert.equal(link.pushed.length, before, '同一断线只报一次')
  } finally {
    await link.cleanup()
  }
})

test('事件流：body 编号归零（被杀后重启）时不重放旧事件，但会告知', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    await link.api.poll()
    body.push({ type: 'task_done', data: { task: { id: 't-1', kind: 'mine', result: { mined: 1 } } } })
    await link.api.poll()
    await link.adapter.drainOnce()
    link.pushed.length = 0
    // body 被杀后重建：seq 归零，旧事件没了
    body.state.seq = 0
    body.state.events = []
    await link.api.poll()
    await link.adapter.drainOnce()
    const text = link.pushed.join('\n')
    assert.match(text, /编号归零/)
    assert.match(text, /不重放旧事件/)
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('mcb_do：wait 的 durationMs 容错成 body 的 ms；cancel+task 两步都回结果', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    await link.api.poll()
    await link.tools.mcb_do.execute({ steps: [{ op: 'wait', params: { durationMs: 8000 } }] })
    const waited = body.state.requests.at(-1).steps[0]
    assert.equal(waited.op, 'wait')
    assert.equal(waited.params.ms, 8000)

    const combo = await link.tools.mcb_do.execute({ steps: [{ op: 'cancel', taskId: 't-9' }, { op: 'task', kind: 'mine', params: { block: 'dirt', count: 2 } }] })
    assert.match(combo.text, /\[cancel\]/)
    assert.match(combo.text, /任务 t-1（mine）已接受/)
    assert.ok(combo.text.indexOf('[cancel]') < combo.text.indexOf('已接受'), 'cancel 结果应在任务结果之前')
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('mcb_leave：默认只停 body 但报告还挂着什么；cleanup:true 释放 focus/goal 且幂等', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    const joined = await link.tools.mcb_join.execute({ server: 'flat' })
    assert.match(joined.text, /已连接 127\.0\.0\.1:54837/)
    // 模型自己建的 focus 租约（focus_enter 的 owner 就是 'focus'）+ 一条 MC 持续目标（time 不在测试里，用不上）。
    link.host.services.focus.enter({ label: 'mc', owner: 'focus', title: '在 MC 里玩' })
    const left = await link.tools.mcb_leave.execute({})
    assert.match(left.text, /安全停止：成功/)
    assert.match(left.text, /body 进程：本会话没有启动过|body 进程：已结束/)
    assert.match(left.text, /不是本会话启动的/)
    assert.match(left.text, /还挂着（全部）：.*MC 相关 1 个/)
    assert.match(left.text, /cleanup:true/)
    assert.equal(body.state.paused, true, 'leave 必须先安全停止')

    const cleaned = await link.tools.mcb_leave.execute({ cleanup: true })
    assert.match(cleaned.text, /收尾清理（MC 相关，按 activity\/标签\/服务器别名识别）：focus 释放 1 个/)
    assert.match(cleaned.text, /已完全收工/)
    assert.equal(link.host.services.focus.list().length, 0, 'cleanup 应释放模型 focus 租约')
    // 幂等：再调一次不报错、不重复清
    const again = await link.tools.mcb_leave.execute({ cleanup: true })
    assert.match(again.text, /没有启动过|无需停止/)
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('mcb_stop：停任务+安全反射但不离开世界；同步 time 暂停模式；resume/leave 退出暂停模式', async () => {
  const body = await startFakeBody()
  const calls = []
  let pausedMode = { active: false }
  const timeApi = {
    phase: () => (pausedMode.active ? 'paused' : 'awake'),
    setPausedMode: (input) => { calls.push(input); pausedMode = { active: Boolean(input.active), reason: input.reason ?? null, source: input.source ?? null }; return pausedMode },
    status: () => ({ pausedMode, lastPierce: null }),
    goals: () => [], removeGoal: () => ({ removed: false }), schedules: () => [], queue: () => [], lock: () => null,
  }
  const link = await mountLink({ port: body.port, timeApi })
  try {
    await link.api.poll()
    body.state.task = { id: 't-1', kind: 'mine', state: 'running' }
    const first = await link.tools.mcb_stop.execute({ reason: '去写代码了' })
    assert.match(first.text, /任务已停：任务已停（取消 1 个）/)
    assert.match(first.text, /本次取消 mine t-1/)
    assert.match(first.text, /身体仍在世界/)
    assert.match(first.text, /暂停原因：/)
    assert.match(first.text, /time 暂停模式：已开/)
    assert.match(first.text, /goal\/focus 都保留/)
    assert.match(first.text, /resume/)
    assert.match(first.text, /mcb_leave/)
    assert.equal(body.state.paused, true, 'mcb_stop 必须触发 body 安全反射（暂停）')
    assert.deepEqual(calls.at(-1), { active: true, reason: '去写代码了', source: 'mc-link' })
    body.state.task = { id: 't-2', kind: 'goto', state: 'interrupted' }
    const second = await link.tools.mcb_stop.execute({})
    assert.match(second.text, /任务已停/)
    assert.match(second.text, /身体仍在世界/)
    // mcb_status 显示暂停模式
    const status = await link.tools.mcb_status.execute({})
    assert.match(status.text, /暂停模式：time 已开/)
    // resume 退出暂停模式
    await link.tools.mcb_do.execute({ steps: [{ op: 'resume' }] })
    assert.equal(calls.at(-1)?.active, false, 'resume 应关闭 time 暂停模式')
    // leave 也退出暂停模式（幂等）
    await link.tools.mcb_leave.execute({ cleanup: true })
    assert.equal(calls.at(-1)?.active, false, 'leave 应清掉 time 暂停模式')
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('危险穿透：alarm 被 pause 闸门拦下时暂存、next delivery 补投；meta.priority/pierce 正确透传', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  let blocked = true
  const seen = []
  const off = link.host.services.signals.addGate((signal) => {
    if (signal.from?.plugin === 'mc') seen.push(signal)
    return blocked && signal.from?.plugin === 'mc' && String(signal.tags ?? []).includes('alarm') ? { accept: false, blocked: true, reason: 'transient' } : { accept: true }
  })
  try {
    await link.api.poll()
    // 低频死亡 alarm：gate 拦下 → 不应进会话，但要在 pending 里
    body.push({ type: 'death', data: { position: { x: 1, y: 64, z: 2 }, lastDeath: { position: { x: 1, y: 64, z: 2 } } } })
    await link.api.poll()
    await link.adapter.drainOnce()
    assert.equal(link.pushed.length, 0, '被 pause 拦下的危险不能直接进会话（等 gate 开）')
    // 危险信号必须带 meta.priority='alarm' + meta.pierce=true（time gate 认这两个字段）
    const deathSignal = seen.find((signal) => String(signal.tags ?? []).includes('alarm'))
    assert.ok(deathSignal, '死亡应作为 alarm 信号发出')
    assert.equal(deathSignal.meta?.priority, 'alarm')
    assert.equal(deathSignal.meta?.pierce, true)
    const status = await link.tools.mcb_status.execute({})
    assert.match(status.text, /危险补投：\d+ 条未进 time 的 alarm/)
    // gate 打开 → 下一次 poll 补投
    blocked = false
    await link.api.poll()
    await link.adapter.drainOnce()
    assert.match(link.pushed.join('\n'), /死亡|危险|\[MC\]/)
    const ledger = fs.readFileSync(path.join(link.root, 'events.jsonl'), 'utf8')
    assert.match(ledger, /alarm-blocked/)
    assert.match(ledger, /alarm-delivered-late/)
    assert.match(ledger, /"priority":"alarm"/)
    assert.match(ledger, /"pierce":true/)
  } finally {
    off?.()
    await link.cleanup()
    await body.close()
  }
})

test('危险穿透：time 已 enqueue 的 blocked（sleeping/muted/paused）不补投，只记 alarm-already-stored', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  const off = link.host.services.signals.addGate((signal) => (signal.from?.plugin === 'mc' && String(signal.tags ?? []).includes('alarm') ? { accept: false, blocked: true, reason: 'sleeping' } : { accept: true }))
  try {
    await link.api.poll()
    body.push({ type: 'death', data: { position: { x: 1, y: 64, z: 2 }, lastDeath: { position: { x: 1, y: 64, z: 2 } } } })
    await link.api.poll()
    await link.adapter.drainOnce()
    const ledger = fs.readFileSync(path.join(link.root, 'events.jsonl'), 'utf8')
    assert.match(ledger, /alarm-already-stored/, 'sleeping 被 time 存下的 alarm 不能进补投队列')
    assert.doesNotMatch(ledger, /alarm-blocked/, '不该再记 blocked（内容已在 time 积压里）')
    const status = await link.tools.mcb_status.execute({})
    assert.doesNotMatch(status.text, /危险补投/, '补投计数只算没进 time 的')
  } finally {
    off?.()
    await link.cleanup()
    await body.close()
  }
})

test('危险穿透：body 只带 pierce:true（无 alarm tag、类型本来 quiet）也强制 alarm 并透传 meta', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  const seen = []
  const off = link.host.services.signals.addGate((signal) => { if (signal.from?.plugin === 'mc') seen.push(signal); return { accept: true } })
  try {
    await link.api.poll()
    // watchdog 六类/reflex 风格：类型属于 quiet，但 data.pierce=true（priority 可能缺省）
    body.push({ type: 'watchdog', data: { pierce: true, reason: 'low-health', note: '危险反射' } })
    await link.api.poll()
    await link.adapter.drainOnce()
    const alarm = seen.find((signal) => String(signal.tags ?? []).includes('alarm'))
    assert.ok(alarm, 'pierce:true 的 quiet 事件也必须发 alarm')
    assert.match(alarm.text, /危险/)
    assert.equal(alarm.meta?.priority, 'alarm')
    assert.equal(alarm.meta?.pierce, true)
    // 普通任务事件不带 pierce：不能滥用 alarm
    seen.length = 0
    body.push({ type: 'task_done', data: { task: { id: 't-1', kind: 'mine', result: { mined: 2, net: 2 } } } })
    await link.api.poll()
    await link.adapter.drainOnce()
    const normal = seen.find((signal) => String(signal.text ?? '').includes('任务完成'))
    assert.ok(normal)
    assert.notEqual(normal.meta?.priority, 'alarm')
    assert.notEqual(normal.meta?.pierce, true)
  } finally {
    off?.()
    await link.cleanup()
    await body.close()
  }
})

test('mcb_status：暂停时显示安全反射与时间相位（暂停≠离开）', async () => {
  const body = await startFakeBody()
  body.state.paused = true
  body.state.pausedReason = 'low-health'
  const link = await mountLink({ port: body.port, timePhase: 'paused' })
  try {
    const status = await link.tools.mcb_status.execute({})
    assert.match(status.text, /安全反射：开启（≤10s\/次、≤2 次\/分）/)
    assert.match(status.text, /暂停：血量过低——先吃\/撤到安全点/)
    assert.match(status.text, /暂停语义：任务停\/不接活，但身体仍在世界/)
    assert.match(status.text, /不处理原因会被再次暂停/)
    assert.match(status.text, /可玩：否（暂停中（血量过低））/)
    assert.match(status.text, /最近 spawn：358,-60,114 · overworld · 来源 initial/)
    assert.match(status.text, /身体仍在世界/)
    assert.match(status.text, /时间：已暂停/)
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('参数归因：别名显式说明（name→block / kind 写在 params）、坐标格式错不冒充"世界里没有方块"', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    await link.api.poll()
    const alias = await link.tools.mcb_do.execute({ steps: [{ op: 'task', kind: 'mine', params: { name: 'oak_log', count: 2 } }] })
    assert.match(alias.text, /参数处理：.*name=.*已按 block 处理/)
    const sent = body.state.requests.at(-1).steps[0]
    assert.equal(sent.params.block, 'oak_log')
    const kindInParams = await link.tools.mcb_do.execute({ steps: [{ op: 'task', params: { kind: 'goto', x: 1, y: 2, z: 3 } }] })
    assert.match(kindInParams.text, /参数处理：.*kind 写在了 params\.kind/)
    await assert.rejects(() => link.tools.mcb_do.execute({ steps: [{ op: 'dig', params: { pos: 'not-a-pos' } }] }), /参数格式不对.*pos 需要 \{x,y,z\} 或 \[x,y,z\]/)
    // 数组写法仍然可用（不是错误）
    const arr = await link.tools.mcb_do.execute({ steps: [{ op: 'dig', params: { pos: [12, -60, 14] } }] })
    assert.match(arr.text, /\[dig\]/)
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('mcb_leave：MC 识别不限 focus 字符串（activity/title/theme/服务器别名），非 MC 的如实列出、不谎称"已完全收工"', async () => {
  const timeGoals = [
    { id: 'g-mc', focus: '游戏', theme: '在 flat 服挖矿' },
    { id: 'g-mc2', focus: 'mc:build', theme: '盖房子' },
    { id: 'g-other', focus: 'acme-work', theme: '写周报' },
  ]
  const removed = []
  const timeApi = {
    goals: () => timeGoals.slice(),
    removeGoal: (id) => { removed.push(id); const index = timeGoals.findIndex((goal) => goal.id === id); if (index >= 0) timeGoals.splice(index, 1); return { removed: index >= 0 } },
    schedules: () => [], queue: () => [], lock: () => null,
  }
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port, timeApi })
  try {
    await link.tools.mcb_join.execute({ server: 'flat' })
    link.host.services.focus.enter({ label: '游戏', owner: 'focus', title: '在 flat 玩' })
    link.host.services.focus.enter({ label: 'act:reading', owner: 'focus', title: '读文档' })
    // 默认 leave：不清理，但要把 MC 和非 MC 的都如实列出
    const left = await link.tools.mcb_leave.execute({})
    assert.match(left.text, /收工完成但没完全干净/)
    assert.match(left.text, /MC focus 1 个（游戏）/, 'focus label 写成"游戏"也要按 title/别名识别成 MC')
    assert.match(left.text, /MC 持续目标 2 个/, 'g-mc/g-mc2 应算 MC 目标')
    assert.match(left.text, /其它 focus 1 个（act:reading）/, '非 MC 的也要如实列出')
    assert.match(left.text, /其它持续目标 1 个/, 'g-other 也要列出')
    assert.doesNotMatch(left.text, /已完全收工/)
    // cleanup：只清 MC 相关的 focus/goal，非 MC 的不动，结论不能说"已完全收工"
    timeGoals.push(...[]) // 占位：保持数组引用
    const cleaned = await link.tools.mcb_leave.execute({ cleanup: true })
    assert.match(cleaned.text, /focus 释放 1 个、持续目标取消 2 个/)
    assert.deepEqual(removed.sort(), ['g-mc', 'g-mc2'])
    assert.equal(link.host.services.focus.list().filter((lease) => lease.owner === 'focus').length, 1, '非 MC focus 不释放')
    assert.match(cleaned.text, /还有非 MC 的专注\/目标在/)
    assert.match(cleaned.text, /act:reading|acme-work/)
    assert.doesNotMatch(cleaned.text, /已完全收工/)
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('mcb_scan：按 count 说明截断（到上限说"可能还有更多"），不再假装列表完整', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    body.state.scanRows = 20
    const out = await link.tools.mcb_scan.execute({ name: 'dirt', radius: 6, count: 5 })
    assert.match(out.text, /只列最近的 5 个（count=5）/)
    assert.match(out.text, /可能还有更多/)
    body.state.scanRows = 64
    const capped = await link.tools.mcb_scan.execute({ name: 'dirt', count: 200 })
    assert.match(capped.text, /已到 body 上限 64 个/)
    body.state.scanRows = 2
    const small = await link.tools.mcb_scan.execute({ name: 'dirt', count: 8 })
    assert.doesNotMatch(small.text, /可能还有更多/)
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('mcb_do：dig/place 的 pos 写成 [x,y,z] 也规整成 {x,y,z} 再交给 body', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    await link.api.poll()
    await link.tools.mcb_do.execute({ steps: [{ op: 'dig', params: { pos: [12, -60, 14] } }] })
    const sent = body.state.requests.at(-1).steps[0]
    assert.deepEqual(sent.params.pos, { x: 12, y: -60, z: 14 })
    const text = body.state.requests.at(-1).steps[0]
    assert.equal(text.op, 'dig')
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('门控：普通任务事件在 focus 里进积压，安全 alarm 能打断（mc-link 只标 tags，不自己做穿透）', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    await link.api.poll()
    // 模拟模型在一个不相干的专注里（label 不是 'mc'）。
    const lease = link.host.services.focus.enter({ label: 'act:reading', owner: 'focus', title: '在读东西' })
    body.push({ type: 'task_done', data: { task: { id: 't-1', kind: 'mine', result: { mined: 1 } } } })
    await link.api.poll()
    await link.adapter.drainOnce()
    assert.equal(link.pushed.length, 0, '普通任务事件不该打断别的专注')
    const backlog = link.host.services.focus.backlog()
    assert.ok(backlog.some((row) => row.focus === 'mc'), `应进 mc 积压：${JSON.stringify(backlog)}`)

    body.push({ type: 'safety_stop', data: { reason: 'low-health' } })
    await link.api.poll()
    await link.adapter.drainOnce()
    assert.match(link.pushed.join('\n'), /安全停止：血量过低/, '真危险事件要能进专注')
    lease.release()
    await link.adapter.drainOnce()
    assert.match(link.pushed.join('\n'), /积压/, '离开专注后应看到积压摘要')
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('mcb_snapshot：结构化快照渲染成可读文本 + JSON 尾巴（日常先 snapshot）', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    const out = await link.tools.mcb_snapshot.execute({ radius: 6 })
    assert.match(out.text, /场景快照（3ms；radius 6）/)
    assert.match(out.text, /13,64,-8/)
    assert.match(out.text, /生命\/饥饿\/氧气：20\/20，18\/20/)
    assert.match(out.text, /手持：stone_pickaxe×1/)
    assert.match(out.text, /脚下方块图：/)
    assert.match(out.text, /zombie/)
    assert.match(out.text, /可玩：是/)
    assert.match(out.text, /JSON（\d+ 字）：\{/)
    // mcb_eyes mode="snapshot" 复用同一渲染
    const again = await link.tools.mcb_eyes.execute({ mode: 'snapshot' })
    assert.match(again.text, /场景快照/)
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('mcb_eyes：截图成功返回 PNG 图片附件 + 路径/meta 摘要', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    const out = await link.tools.mcb_eyes.execute({ kind: 'milestone', frames: 1 })
    const expected = path.join(os.tmpdir(), 'mc-eyes-test', '2026-11-06T04-00-00-000Z-manual.png')
    assert.deepEqual(out.images, [expected], '首张 PNG 必须作为图片附件返回')
    assert.match(out.text, /截图完成（7100ms；视口 1280×720；1 张）/)
    assert.match(out.text, /mc-eyes-test/)
    assert.match(out.text, /首张图已作为图片附件/)
    const sent = body.state.eyesRequests.at(-1)
    assert.equal(sent.kind, 'milestone')
    assert.equal(sent.frames, 1)
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('mcb_eyes：501/429/500 给可读原因与替代路径（不是裸错误）', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    body.state.eyesScreenshot = '501'
    await assert.rejects(() => link.tools.mcb_eyes.execute({}), /没配置|viewer|Edge[\s\S]*mcb_snapshot/)
    body.state.eyesScreenshot = '429'
    await assert.rejects(() => link.tools.mcb_eyes.execute({}), /15s|限频[\s\S]*mcb_snapshot/)
    body.state.eyesScreenshot = '500'
    await assert.rejects(() => link.tools.mcb_eyes.execute({}), /重试|失败[\s\S]*mcb_snapshot/)
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('mcb_map：返回里注明"只显示脚下一层"，避免把单层地图当整个工地', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    await link.api.poll()
    const out = await link.tools.mcb_map.execute({ radius: 6 })
    assert.match(out.text, /inspect:map/)
    assert.match(out.text, /只显示脚下一层/)
    assert.match(out.text, /y≈/)
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('mcb_status：展示新 body 的 environment/pathfinder/pausedTasks（旧 body 没有就不显示）', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    body.state.extra = {
      pausedTasks: [{ id: 't-4', kind: 'mine', state: 'paused' }],
      environment: { summary: '附近原木 0 / 石 0 / 土 120；纯超平坦' },
      pathfinder: { available: true },
    }
    const out = await link.tools.mcb_status.execute({})
    assert.match(out.text, /断线挂起的任务：#t-4 mine/)
    assert.match(out.text, /环境：附近原木 0/)
    body.state.extra = { pathfinder: { available: false } }
    const out2 = await link.tools.mcb_status.execute({})
    assert.match(out2.text, /寻路：不可用/)
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('mcb_join：睡眠期（time.phase=sleeping）拒绝重连，force:true 才允许；醒来后正常', async () => {
  const body = await startFakeBody()
  const sleeping = await mountLink({ port: body.port, timePhase: 'sleeping' })
  try {
    await assert.rejects(() => sleeping.tools.mcb_join.execute({ server: 'flat' }), /在睡觉[\s\S]*不要用 mcb_join/)
    // force（用户明确要求现在玩）可以连
    const forced = await sleeping.tools.mcb_join.execute({ server: 'flat', force: true })
    assert.match(forced.text, /已连接/)
    const status = await sleeping.tools.mcb_status.execute({})
    assert.match(status.text, /已连接/)
    // body 被管理面收起（HTTP 也没了）→ status 报未连接并提示"在睡觉、不要 mcb_join"
    await body.close()
    const noBody = await sleeping.tools.mcb_status.execute({})
    assert.match(noBody.text, /未连接/)
    assert.match(noBody.text, /在睡觉/)
    assert.match(noBody.text, /不要 mcb_join/)
  } finally {
    await sleeping.cleanup()
  }
  // 醒来（awake）时加入不受影响
  const body2 = await startFakeBody()
  const awake = await mountLink({ port: body2.port, timePhase: 'awake' })
  try {
    const out = await awake.tools.mcb_join.execute({ server: 'flat' })
    assert.match(out.text, /已连接/)
  } finally {
    await awake.cleanup()
    await body2.close()
  }
})

test('mcb_status：只读展示 time 的睡眠边界事实（在飞 turn/grace 内结束/超 grace/lastSleepBoundary）', async () => {
  const cases = [
    [{ phase: () => 'sleeping', status: () => ({ sleepBoundary: { inFlight: true, turnAgeAtEntrySec: 12, turnEndedAfterSec: 8 } }) },
      /睡眠边界：入睡时在飞 turn（age 12s），grace 内 8s 结束/],
    [{ phase: () => 'sleeping', status: () => ({ sleepBoundary: { inFlight: true, turnAgeAtEntrySec: 100, overrun: true } }) },
      /睡眠边界：⚠ 超 grace.*driver 应 cancel/],
    [{ phase: () => 'awake', status: () => ({ lastSleepBoundary: { inFlight: true, turnAgeAtEntrySec: 12, turnEndedAfterSec: 8, endedAt: Date.now() } }) },
      /上次睡眠边界：入睡时在飞 turn（age 12s），grace 内 8s 结束/],
    [{ phase: () => 'sleeping', status: () => ({ sleepBoundary: { postSleepTurn: true } }) },
      /睡眠边界：⚠ 入睡后出现新 turn/],
    [{ phase: () => 'sleeping', status: () => ({ sleepBoundary: { inFlight: false } }) },
      /睡眠边界：入睡时无在飞 turn/],
  ]
  for (const [timeApi, pattern] of cases) {
    const body = await startFakeBody()
    const link = await mountLink({ port: body.port, timeApi })
    try {
      const out = await link.tools.mcb_status.execute({})
      assert.match(out.text, pattern)
    } finally {
      await link.cleanup()
      await body.close()
    }
  }
  // 旧版 time（没有 status/sleepBoundary）时静默，不报错
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port, timePhase: 'awake' })
  try {
    const out = await link.tools.mcb_status.execute({})
    assert.doesNotMatch(out.text, /睡眠边界/)
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('mcb_do：睡眠期只允许收尾 op（tasks/events/cancel/say），新任务/新动作被拒；醒来恢复', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port, timePhase: 'sleeping' })
  try {
    await assert.rejects(() => link.tools.mcb_do.execute({ steps: [{ op: 'task', kind: 'mine', params: { block: 'dirt', count: 1 } }] }), /在睡觉[\s\S]*只能收尾/)
    await assert.rejects(() => link.tools.mcb_do.execute({ steps: [{ op: 'dig', params: { pos: { x: 1, y: 2, z: 3 } } }] }), /在睡觉/)
    const tasks = await link.tools.mcb_do.execute({ steps: [{ op: 'tasks' }] })
    assert.match(tasks.text, /\[tasks\]/)
    const cancel = await link.tools.mcb_do.execute({ steps: [{ op: 'cancel', taskId: 't-1' }] })
    assert.match(cancel.text, /\[cancel\]/)
    const say = await link.tools.mcb_do.execute({ steps: [{ op: 'say', text: '我要睡了' }] })
    assert.match(say.text, /\[say\]/)
  } finally {
    await link.cleanup()
    await body.close()
  }
  const body2 = await startFakeBody()
  const awake = await mountLink({ port: body2.port, timePhase: 'awake' })
  try {
    const out = await awake.tools.mcb_do.execute({ steps: [{ op: 'task', kind: 'mine', params: { block: 'dirt', count: 1 } }] })
    assert.match(out.text, /已接受/)
  } finally {
    await awake.cleanup()
    await body2.close()
  }
})

test('mcb_join：成功时带 body preflight 环境摘要（新版 body 的"服务器小卡片"）', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    body.state.extra = { environment: { summary: '寻路可用；附近原木 6 / 矿石 2 / 石 40 / 土 120' } }
    const out = await link.tools.mcb_join.execute({ server: 'flat' })
    assert.match(out.text, /已连接 127\.0\.0\.1:54837/)
    assert.match(out.text, /环境：寻路可用；附近原木 6/)
    body.state.extra = {}
    const out2 = await link.tools.mcb_join.execute({ host: '127.0.0.1', port: 54837 })
    assert.doesNotMatch(out2.text, /环境：/)
  } finally {
    await link.cleanup()
    await body.close()
  }
})

test('mcb_help：play 是主入口；空参数列全部；模糊名能匹配', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    const list = await link.tools.mcb_help.execute({})
    assert.match(list.text, /play/)
    assert.match(list.text, /collect/)
    assert.match(list.text, /tunnel/)
    assert.match(list.text, /macro/)
    assert.match(list.text, /eyes/)
    assert.match(list.text, /combat/)
    const play = await link.tools.mcb_help.execute({ skill: 'play' })
    assert.match(play.text, /开一局/)
    assert.match(play.text, /mcb_leave/)
    const trad = await link.tools.mcb_help.execute({ skill: 'trad' })
    assert.match(trad.text, /村民交易/)
    const tun = await link.tools.mcb_help.execute({ skill: 'tun' })
    assert.match(tun.text, /挖隧道/)
    const col = await link.tools.mcb_help.execute({ skill: 'collect' })
    assert.match(col.text, /批量采集/)
    assert.match(col.text, /needs-tool/)
    const macro = await link.tools.mcb_help.execute({ skill: 'mac' })
    assert.match(macro.text, /宏操作总览/)
    assert.match(macro.text, /needs-tool/)
    const eyes = await link.tools.mcb_help.execute({ skill: 'eye' })
    assert.match(eyes.text, /MC 眼睛/)
    assert.match(eyes.text, /先.*snapshot.*后.*screenshot|日常看场景先用/)
    // live-world 截图已修：不再说"可能只截到天空"，改成"对结构仅作参考"
    assert.doesNotMatch(eyes.text, /可能只截到天空/)
    assert.match(eyes.text, /截图对结构仅作参考/)
    assert.match(eyes.text, /负 Y 世界.*渲染层整体 \+64|截图里的视觉 y 会比真实坐标高 64/)
    assert.match(eyes.text, /以 body 的 `verify`|验收.*verify|结构校验/)
    assert.match(eyes.text, /kind:"shelter".*镜头|对准家的 center/)
    // 实现细节：home 已写入才自动对准；+64 仅负 Y；meta.viewer.center 是真实坐标
    assert.match(eyes.text, /只在最近一次 shelter 成功、`status\.home` 已写入后生效/)
    assert.match(eyes.text, /没有家时回退默认镜头/)
    assert.match(eyes.text, /仅当当前中心 y<0.*视觉 y 比真实高 64/)
    assert.match(eyes.text, /y≥0 的普通世界不偏移/)
    assert.match(eyes.text, /meta\.viewer\.center.*真实坐标/)
    // 工具描述同样更新（旧警告移除、新措辞在）
    assert.doesNotMatch(link.tools.mcb_eyes.description, /可能只截到天空/)
    assert.match(link.tools.mcb_eyes.description, /截图对结构仅作参考/)
    assert.match(link.tools.mcb_eyes.description, /仅当前中心 y<0 时截图视觉 y 比真实高 64/)
    assert.match(link.tools.mcb_eyes.description, /status\.home 已写入后生效/)
    assert.match(link.tools.mcb_eyes.description, /meta\.viewer\.center 为真实坐标/)
    // shelter 技能也说明"没家时回退默认镜头"
    const shelter = await link.tools.mcb_help.execute({ skill: 'shelter' })
    assert.match(shelter.text, /镜头.*只在 home 已写入时生效/)
    assert.match(shelter.text, /没家就回退默认斜上方镜头/)
    const none = await link.tools.mcb_help.execute({ skill: 'nope-nope' })
    assert.match(none.text, /没有这个技能/)
  } finally {
    await link.cleanup()
    await body.close()
  }
})
