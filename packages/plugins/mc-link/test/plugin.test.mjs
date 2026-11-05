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
    safety: { paused: state.paused, reason: state.pausedReason, offline: !state.connected, offlineReason: state.connected ? null : 'socketClosed', everOnline: true },
    task: state.task,
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
      inventoryCount: 4,
      nearby: { villager: 1 },
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
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    const read = (fn) => { let raw = ''; req.on('data', (chunk) => { raw += chunk }); req.on('end', () => fn(raw ? JSON.parse(raw) : {})) }
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
          // 模拟真 body：task 之前的 steps 结果一并返回，然后立即返回 taskId。
          if (step.op === 'task') return send(200, { ok: true, results, task: { id: 't-1', kind: step.kind, state: 'queued' } })
          if (step.op === 'events') results.push({ index: results.length, op: 'events', result: { events: state.events, seq: state.seq } })
          else if (step.op === 'tasks') results.push({ index: results.length, op: 'tasks', result: [{ id: 't-1', kind: 'mine', state: 'done', result: { mined: 2 } }, { id: 't-2', kind: 'goto', state: 'failed', error: 'timeout' }] })
          else if (step.op === 'resume') {
            state.paused = false
            state.pausedReason = null
            // 真 body：带 taskId 走 resumeTask 返回被恢复的任务；不带则是安全暂停的解除。
            results.push({ index: results.length, op: 'resume', result: step.taskId ? { id: step.taskId, kind: 'mine', state: 'running' } : { paused: false } })
          }
          else if (step.op === 'say') results.push({ index: results.length, op: 'say', result: { ok: true } })
          else results.push({ index: results.length, op: step.op, result: { text: `did:${step.op}` } })
        }
        return send(200, { ok: true, results })
      })
    }
    if (url.pathname === '/v1/safety/stop' && req.method === 'POST') {
      state.paused = true
      return send(200, { ok: true, paused: true })
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

async function mountLink({ port, config = {}, timePhase = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-mc-link-'))
  const host = createHost({ log: () => {} })
  // 模拟 time 插件 provide 的公开 api（phase）：睡眠期 join 守卫要用。
  // 插件侧 ctx.services.get('time') 读的是 host 的 shared 注册表。
  if (timePhase) host.shared.set('time', { phase: () => timePhase })
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

test('工具面：11 个 mcb_*，描述自足且不超预算；提示词只有事实段（无 mc:play/mc:interaction）', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    const names = Object.keys(link.tools).sort()
    assert.deepEqual(names, ['mcb_do', 'mcb_help', 'mcb_inventory', 'mcb_join', 'mcb_lan', 'mcb_leave', 'mcb_look', 'mcb_map', 'mcb_scan', 'mcb_servers', 'mcb_status'])
    let total = 0
    for (const tool of Object.values(link.tools)) {
      assert.ok(tool.description.length > 60, `${tool.name} 描述太短`)
      assert.ok(tool.description.length <= 900, `${tool.name} 描述超 900 预算：${tool.description.length}`)
      total += tool.description.length
    }
    assert.ok(total <= 4000, `工具描述总量 ${total} 超预算`)
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
    for (const kind of ['collect', 'tunnel', 'bridge', 'build', 'sort', 'shelter', 'farm']) {
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

test('mcb_do：body 报"已暂停"时补上恢复路径', async () => {
  const body = await startFakeBody()
  const link = await mountLink({ port: body.port })
  try {
    await link.api.poll()
    body.state.doError = '身体已暂停（death）；先 resume，或只用 look/inventory'
    await assert.rejects(() => link.tools.mcb_do.execute({ steps: [{ op: 'dig', params: { name: 'dirt' } }] }), /恢复/)
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
    assert.match(left.text, /还挂着：.*focus 1 个/)
    assert.match(left.text, /cleanup:true/)
    assert.equal(body.state.paused, true, 'leave 必须先安全停止')

    const cleaned = await link.tools.mcb_leave.execute({ cleanup: true })
    assert.match(cleaned.text, /收尾清理：focus 释放 1 个/)
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
    const none = await link.tools.mcb_help.execute({ skill: 'nope-nope' })
    assert.match(none.text, /没有这个技能/)
  } finally {
    await link.cleanup()
    await body.close()
  }
})
