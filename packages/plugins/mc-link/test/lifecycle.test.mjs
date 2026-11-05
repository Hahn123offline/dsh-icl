// mc-link body 生命周期：用假子进程 + 假 HTTP 验证启动/健康检查/崩溃上报/只杀自己的。
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createBodySupervisor, classifyExit } from '../src/lifecycle.mjs'

class FakeChild extends EventEmitter {
  constructor(pid = 4242) {
    super()
    this.pid = pid
    this.stdout = new EventEmitter()
    this.stderr = new EventEmitter()
    this.signals = []
  }

  kill(signal) {
    this.signals.push(signal)
    if (signal === 'SIGTERM' || signal === 'SIGKILL') setTimeout(() => this.emit('exit', 0, signal), 5)
    return true
  }
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'icl-mc-lifecycle-'))
}

function statusOf(connected, overrides = {}) {
  return {
    ok: true,
    paused: false,
    adapter: { connected, host: '127.0.0.1', port: 54837, position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, inventoryCount: 0 },
    ...overrides,
  }
}

test('lifecycle：spawn 参数正确，连上后 owns=true，stop 只杀自己的进程', async () => {
  const dir = tmpDir()
  const calls = []
  const lifecycle = []
  let probes = 0
  const supervisor = createBodySupervisor({
    bodyPort: 54901,
    bodyEntry: 'C:/x/mc-body/src/cli.mjs',
    stateDir: dir,
    startTimeoutMs: 3000,
    spawnImpl: (cmd, args) => { calls.push({ cmd, args }); return new FakeChild(9001) },
    fetchStatus: async () => { probes += 1; return probes > 1 ? statusOf(true) : null },
    onLifecycle: (event) => lifecycle.push(event),
  })
  const out = await supervisor.ensure({ host: '127.0.0.1', port: 54837, username: 'ICL-mclink-1' })
  assert.equal(out.reused, false)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].cmd, process.execPath)
  const args = calls[0].args
  assert.equal(args[0], 'C:/x/mc-body/src/cli.mjs')
  assert.equal(args[args.indexOf('--listen') + 1], '54901')
  assert.equal(args[args.indexOf('--host') + 1], '127.0.0.1')
  assert.equal(args[args.indexOf('--port') + 1], '54837')
  assert.equal(args[args.indexOf('--name') + 1], 'ICL-mclink-1')
  assert.ok(args.includes('--allow-task') && args.includes('--allow-say'))
  assert.equal(args[args.indexOf('--state') + 1], path.join(dir, 'tasks.json'))
  assert.equal(args[args.indexOf('--log') + 1], path.join(dir, 'body.jsonl'))
  assert.equal(supervisor.owns(), true)
  assert.equal(lifecycle.filter((event) => event.type === 'body-spawn').length, 1)

  const stopped = await supervisor.stop({ reason: 'leave' })
  assert.equal(stopped.killed, true)
  assert.equal(supervisor.owns(), false)
  assert.ok(lifecycle.some((event) => event.type === 'body-stopped' && event.reason === 'leave'))
})

test('lifecycle：已连上的同目标 body 直接复用，不重复 spawn', async () => {
  let spawned = 0
  const supervisor = createBodySupervisor({
    bodyPort: 54901,
    bodyEntry: 'cli.mjs',
    stateDir: tmpDir(),
    spawnImpl: () => { spawned += 1; return new FakeChild() },
    fetchStatus: async () => statusOf(true),
  })
  const out = await supervisor.ensure({ host: '127.0.0.1', port: 54837, username: 'ICL-mclink-1' })
  assert.equal(out.reused, true)
  assert.equal(spawned, 0)
  assert.equal(supervisor.owns(), false)
})

test('lifecycle：body 连在别的服务器时拒绝并让人先 leave', async () => {
  const supervisor = createBodySupervisor({
    bodyPort: 54901,
    bodyEntry: 'cli.mjs',
    stateDir: tmpDir(),
    spawnImpl: () => new FakeChild(),
    fetchStatus: async () => statusOf(true, { adapter: { connected: true, host: '127.0.0.1', port: 54838 } }),
  })
  await assert.rejects(
    () => supervisor.ensure({ host: '127.0.0.1', port: 54837, username: 'ICL-mclink-1' }),
    /先 mcb_leave/,
  )
})

test('lifecycle：进程连不上就退出时给出退出码 + body 日志，不留句柄', async () => {
  const supervisor = createBodySupervisor({
    bodyPort: 54901,
    bodyEntry: 'cli.mjs',
    stateDir: tmpDir(),
    startTimeoutMs: 3000,
    spawnImpl: () => {
      const child = new FakeChild(9002)
      setTimeout(() => {
        child.stderr.emit('data', 'connect ECONNREFUSED 127.0.0.1:54837\n')
        child.emit('exit', 1, null)
      }, 30)
      return child
    },
    fetchStatus: async () => null,
    onLifecycle: () => {},
  })
  await assert.rejects(
    () => supervisor.ensure({ host: '127.0.0.1', port: 54837, username: 'ICL-mclink-1' }),
    (error) => {
      assert.match(error.message, /进程在连上服务器前就退出/)
      assert.match(error.message, /退出码 1/)
      assert.match(error.message, /ECONNREFUSED/)
      return true
    },
  )
  assert.equal(supervisor.state().owns, false)
})

test('lifecycle：启动超时会清理半死进程并报原因', async () => {
  const dir = tmpDir()
  const child = new FakeChild(9003)
  const supervisor = createBodySupervisor({
    bodyPort: 54901,
    bodyEntry: 'cli.mjs',
    stateDir: dir,
    startTimeoutMs: 400,
    spawnImpl: () => child,
    fetchStatus: async () => null,
  })
  await assert.rejects(
    () => supervisor.ensure({ host: '127.0.0.1', port: 54837, username: 'ICL-mclink-1' }),
    /没能在/,
  )
  assert.ok(child.signals.includes('SIGTERM'), '超时后必须结束进程')
  assert.equal(supervisor.state().owns, false)
})

test('lifecycle：spawn 自己抛错时给出直接原因', async () => {
  const supervisor = createBodySupervisor({
    bodyPort: 54901,
    bodyEntry: 'cli.mjs',
    stateDir: tmpDir(),
    spawnImpl: () => { throw new Error('ENOENT spawn') },
    fetchStatus: async () => null,
  })
  await assert.rejects(
    () => supervisor.ensure({ host: '127.0.0.1', port: 54837, username: 'ICL' }),
    /启动 mc-body 失败.*ENOENT/,
  )
})

test('lifecycle：自己起的进程崩溃会回调 body-exit（expected=false）', async () => {
  const events = []
  let probes = 0
  let child = null
  const supervisor = createBodySupervisor({
    bodyPort: 54901,
    bodyEntry: 'cli.mjs',
    stateDir: tmpDir(),
    startTimeoutMs: 3000,
    spawnImpl: () => { child = new FakeChild(9004); return child },
    fetchStatus: async () => { probes += 1; return probes > 1 ? statusOf(true) : null },
    onLifecycle: (event) => events.push(event),
  })
  await supervisor.ensure({ host: '127.0.0.1', port: 54837, username: 'ICL' })
  child.emit('exit', 137, null)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const exit = events.find((event) => event.type === 'body-exit')
  assert.ok(exit)
  assert.equal(exit.expected, false)
  assert.equal(exit.code, 137)
  assert.equal(supervisor.owns(), false)
})

test('lifecycle：dispose 会发 SIGTERM，不把子进程留在后台', async () => {
  let probes = 0
  let child = null
  const supervisor = createBodySupervisor({
    bodyPort: 54901,
    bodyEntry: 'cli.mjs',
    stateDir: tmpDir(),
    startTimeoutMs: 3000,
    spawnImpl: () => { child = new FakeChild(9005); return child },
    fetchStatus: async () => { probes += 1; return probes > 1 ? statusOf(true) : null },
  })
  await supervisor.ensure({ host: '127.0.0.1', port: 54837, username: 'ICL' })
  supervisor.dispose()
  assert.ok(child.signals.includes('SIGTERM'))
  assert.equal(supervisor.owns(), false)
})

test('lifecycle：退出归因从 stderr 的 exit reason= 或 body-exit.json 读出来，lastExit 可查', async () => {
  const dir = tmpDir()
  let child = null
  let probes = 0
  const supervisor = createBodySupervisor({
    bodyPort: 54901,
    bodyEntry: 'cli.mjs',
    stateDir: dir,
    startTimeoutMs: 3000,
    spawnImpl: () => { child = new FakeChild(9006); return child },
    fetchStatus: async () => { probes += 1; return probes > 1 ? statusOf(true) : null },
  })
  await supervisor.ensure({ host: '127.0.0.1', port: 54837, username: 'ICL' })
  child.stderr.emit('data', '[mc-body] exit reason=idle-timeout code=0\n')
  child.emit('exit', 0, null)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const last = supervisor.lastExit()
  assert.ok(last)
  assert.equal(last.exitInfo?.reason, 'idle-timeout')
  assert.equal(last.code, 0)
  assert.equal(supervisor.owns(), false)
})

test('lifecycle：body-exit.json 优先（带 status 快照），waitExit 能等到进程自己退出', async () => {
  const dir = tmpDir()
  let child = null
  let probes = 0
  const supervisor = createBodySupervisor({
    bodyPort: 54901,
    bodyEntry: 'cli.mjs',
    stateDir: dir,
    startTimeoutMs: 3000,
    spawnImpl: () => { child = new FakeChild(9007); return child },
    fetchStatus: async () => { probes += 1; return probes > 1 ? statusOf(true) : null },
  })
  await supervisor.ensure({ host: '127.0.0.1', port: 54837, username: 'ICL' })
  fs.writeFileSync(path.join(dir, 'body-exit.json'), JSON.stringify({ reason: 'api-shutdown', exitCode: 0, detail: 'Error: boom\n    at x', at: Date.now(), status: { connected: true, paused: false, taskId: 't-9', lastError: 'boom' }, recentEvents: [{ seq: 7, type: 'task_started' }, { seq: 8, type: 'health' }], stderrTail: ['[mc-body] x'] }), 'utf8')
  setTimeout(() => child.emit('exit', 0, null), 30)
  const exited = await supervisor.waitExit(1500)
  assert.equal(exited, true)
  const last = supervisor.lastExit()
  assert.equal(last.exitInfo?.source, 'body-exit.json')
  assert.equal(last.exitInfo?.reason, 'api-shutdown')
  assert.equal(last.exitInfo?.status?.taskId, 't-9')
  assert.equal(last.exitInfo?.exitCode, 0)
  assert.match(last.exitInfo?.detail ?? '', /boom/)
  assert.equal(last.exitInfo?.recentEvents?.length, 2)
  assert.deepEqual(last.exitInfo?.stderrTail, ['[mc-body] x'])
})

test('lifecycle：classifyExit——外部 /v1/shutdown 且 code 0 算 expected；崩溃/外部 SIGTERM 算 unexpected', () => {
  assert.deepEqual(classifyExit({ stopping: false, code: 0, exitInfo: { reason: 'api-shutdown', exitCode: 0 } }), { expected: true, source: 'clean:api-shutdown' })
  assert.deepEqual(classifyExit({ stopping: false, code: 0, exitInfo: { reason: 'clean-exit', exitCode: 0 } }), { expected: true, source: 'clean:clean-exit' })
  assert.deepEqual(classifyExit({ stopping: false, code: 0 }), { expected: true, source: 'clean:code0' })
  assert.deepEqual(classifyExit({ stopping: true, code: 0 }), { expected: true, source: 'self-stop' })
  assert.equal(classifyExit({ stopping: false, code: 1, exitInfo: { reason: 'uncaught-exception', exitCode: 1 } }).expected, false)
  assert.equal(classifyExit({ stopping: false, code: 0, exitInfo: { reason: 'sigterm', exitCode: 0 } }).expected, false, '外部 SIGTERM 不是 expected')
  assert.equal(classifyExit({ stopping: false, signal: 'SIGKILL' }).expected, false)
  assert.equal(classifyExit({ stopping: false, code: 0, exitInfo: { reason: 'api-shutdown', exitCode: 1 } }).expected, false, 'reason 对但 code 非 0 不算干净')
})

test('lifecycle：外部 POST /v1/shutdown（未自己 stop）→ body-exit 记为 expected，不触发崩溃路径', async () => {
  const dir = tmpDir()
  let child = null
  let probes = 0
  const events = []
  const supervisor = createBodySupervisor({
    bodyPort: 54901,
    bodyEntry: 'cli.mjs',
    stateDir: dir,
    startTimeoutMs: 3000,
    spawnImpl: () => { child = new FakeChild(9008); return child },
    fetchStatus: async () => { probes += 1; return probes > 1 ? statusOf(true) : null },
    onLifecycle: (event) => events.push(event),
  })
  await supervisor.ensure({ host: '127.0.0.1', port: 54837, username: 'ICL' })
  // 模拟外部管理面：写 body-exit.json 然后进程自己退出，supervisor 没有 stopping 标记。
  fs.writeFileSync(path.join(dir, 'body-exit.json'), JSON.stringify({ reason: 'api-shutdown', exitCode: 0, at: Date.now(), status: { connected: true, paused: false, taskId: null, lastError: null } }), 'utf8')
  child.emit('exit', 0, null)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const exit = events.find((event) => event.type === 'body-exit')
  assert.ok(exit)
  assert.equal(exit.expected, true, '外部干净关闭必须算 expected（睡眠期 leave 保命）')
  assert.equal(exit.exitClass?.source, 'clean:api-shutdown')
  assert.equal(supervisor.owns(), false)
  const last = supervisor.lastExit()
  assert.equal(last.expected, true)
  assert.equal(last.exitClass?.source, 'clean:api-shutdown')
})
