// mc-body 子进程生命周期：启动、健康检查、日志捕获、崩溃上报、退出清理。
//
// 旧实现的四个洞（都有真实证据）：
//   1. `spawn(..., {stdio:'ignore'})` —— 子进程为什么起不来（端口占用/connect refused）一个字都看不到；
//   2. 只 `if (!bodyProcess) spawn` —— 进程崩了句柄还是非空，之后永远不再重启；
//   3. 连接失败只抛"没有在限定时间内连上服务器"，没有原因、没有清理，端口被占着；
//   4. `mcb_leave` 无差别对待所有 body —— 必须只杀"本会话自己 spawn 的"，外部 body 只能安全停止。
//
// 这里把"进程"和"HTTP"分开看：
//   · HTTP 能答 /v1/status 但 adapter.connected=false → body 在但没连上（可能正在重连）
//   · 进程退出（exit/error）→ 立刻清句柄并回调，让会话看到可读原因
//   · 复用已连上的外部 body 允许，但绝不接管它的进程生命周期
//
// spawn/fetch 可注入，便于用假子进程做契约测试。

import fs from 'node:fs'
import path from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'

const STDERR_RING = 40
const LINE_MAX = 400

function isFunction(value) {
  return typeof value === 'function'
}

/** 进程怎么结束的，一句话给会话看（Windows 强杀会报 4294967295 这种无符号值）。 */
export function describeExit(code, signal) {
  if (signal) return `被信号 ${signal} 结束`
  const value = Number(code)
  if (!Number.isFinite(value)) return '退出码未知'
  if (value > 2147483647) return `退出码 ${value - 4294967296}，被强制结束（外部 kill 或崩溃）`
  if (value === 0) return '正常退出（code 0）'
  return `退出码 ${value}`
}

/** 把子进程输出写进状态目录，并留最后一小段在内存里用于报错。 */
function makeLogSink({ file = null, log = () => {} } = {}) {
  const ring = []
  const write = (line) => {
    const text = String(line ?? '').replace(/[\r\n]+$/, '')
    if (!text) return
    ring.push(text.length > LINE_MAX ? `${text.slice(0, LINE_MAX)}…` : text)
    while (ring.length > STDERR_RING) ring.shift()
    if (file) {
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, `${text}\n`, 'utf8') } catch (error) {
        log({ msg: 'mc-link.body-log-fail', file, error: String(error?.message ?? error) })
      }
    }
  }
  return { write, tail: (n = 5) => ring.slice(-n) }
}

export function createBodySupervisor({
  bodyPort,
  bodyEntry,
  stateDir,
  nodePath = process.execPath,
  spawnImpl = nodeSpawn,
  fetchStatus = async () => null,
  beforeKill = async () => {},
  log = () => {},
  onLifecycle = () => {},
  startTimeoutMs = 30_000,
  stopGraceMs = 1500,
  now = () => Date.now(),
  extraArgs = [],
} = {}) {
  if (!bodyEntry) throw new Error('mc-link 需要 bodyEntry（packages/mc-body/src/cli.mjs）')
  let handle = null

  function sink() {
    return makeLogSink({ file: handle?.stderrFile ?? path.join(String(stateDir ?? '.'), 'body.stderr.log'), log })
  }

  function state() {
    const h = handle
    if (!h) return { owns: false, alive: false, pid: null, host: null, port: null, username: null, exitCode: null, exitSignal: null, stderrTail: [], startedAt: null }
    const alive = h.alive
    return {
      owns: true,
      alive,
      pid: h.pid ?? null,
      host: h.host,
      port: h.port,
      username: h.username,
      listenPort: bodyPort,
      exitCode: h.exitCode ?? null,
      exitSignal: h.exitSignal ?? null,
      spawnError: h.spawnError ?? null,
      startedAt: h.startedAt,
      elapsedMs: h.startedAt ? Math.max(0, now() - h.startedAt) : null,
      stderrTail: h.sink.tail(5),
    }
  }

  function clear() {
    handle = null
  }

  /** 失败时把"可读原因"拼成一句话：进程/端口/stderr/body 事件各一句。 */
  function failureText(detail = {}) {
    const lines = []
    if (detail.spawnError) lines.push(`进程启动失败：${detail.spawnError}`)
    if (detail.exitCode != null || detail.exitSignal) lines.push(`进程${describeExit(detail.exitCode, detail.exitSignal)}`)
    const stderr = detail.stderrTail ?? []
    // node 打的多行错误对象会混进 "syscall: 'connect'," 这种碎片；body 的 JSON 日志也很长；
    // 崩溃报告里 "最后一行是 spawn_safe/path_stuck" 这种状态事件没有诊断价值，先剔掉。
    const NOISE = /spawn_safe|path_stuck|path_recovered|tunnel_clear|heartbeat|task_progress|^\[out\]\s*(join|leave)\b/i
    const meaningful = stderr
      .filter((line) => line && !/^\s*[{}\[\],]+\s*$/.test(line))
      .filter((line) => !/^\s*[a-z_]+:\s/.test(line))
      .filter((line) => !NOISE.test(line))
      .map((line) => (line.length > 240 ? `${line.slice(0, 237)}…` : line))
    const preferred = meaningful.filter((line) => /ECONNREFUSED|EADDRINUSE|ERR_MODULE_NOT_FOUND|Cannot find module|connect failed|kicked|exhausted|timeout|unavailable|denied/i.test(line))
    const picked = preferred.length ? preferred.slice(-2) : meaningful.slice(-1)
    if (picked.length) lines.push(`body 日志：${picked.join(' / ')}`)
    else if (stderr.length) lines.push(`body 日志最后一行：${stderr.slice(-1)[0]}`)
    if (!lines.length) lines.push('body 没有在限定时间内连上服务器（没有进程退出信息）')
    return lines.join('；')
  }

  function attach(child) {
    const h = {
      child,
      pid: child?.pid ?? null,
      alive: true,
      exitCode: null,
      exitSignal: null,
      spawnError: null,
      host: null,
      port: null,
      username: null,
      startedAt: now(),
      stopping: false,
      stderrFile: path.join(String(stateDir ?? '.'), 'body.stderr.log'),
      sink: null,
    }
    h.sink = makeLogSink({ file: h.stderrFile, log })
    const onLine = (stream) => (chunk) => {
      for (const line of String(chunk ?? '').split(/\r?\n/)) h.sink.write(stream === 'err' ? line : `[out] ${line}`)
    }
    try {
      child.stdout?.on?.('data', onLine('out'))
      child.stderr?.on?.('data', onLine('err'))
    } catch { /* 自定义 spawn 可能没有流 */ }
    const settle = (code, signal) => {
      if (!h.alive) return
      h.alive = false
      h.exitCode = code ?? null
      h.exitSignal = signal ?? null
      const stopping = h.stopping
      if (handle === h) clear()
      onLifecycle({
        type: 'body-exit',
        pid: h.pid,
        code: h.exitCode,
        signal: h.exitSignal,
        expected: stopping,
        stderrTail: h.sink.tail(3),
        at: now(),
      })
    }
    child?.once?.('exit', (code, signal) => settle(code, signal))
    child?.once?.('error', (error) => {
      h.spawnError = String(error?.message ?? error)
      h.sink.write(`spawn error: ${h.spawnError}`)
      settle(null, null)
    })
    handle = h
    return h
  }

  /**
   * 确保有一个连上 host:port 的 body。
   * @returns {Promise<{reused:boolean, status:object, state:object}>}
   */
  async function ensure({ host, port, username }) {
    const target = { host: String(host), port: Number(port), username: String(username).slice(0, 16) }
    const probe = await fetchStatus().catch(() => null)
    if (probe?.adapter?.connected) {
      const a = probe.adapter
      if (String(a.host) === target.host && Number(a.port) === target.port) {
        return { reused: true, status: probe, state: state() }
      }
      throw new Error(`body 已经连在 ${a.host}:${a.port} 上（本会话没在控制它的进程）。先 mcb_leave，再连 ${target.host}:${target.port}；或直接用 mcb_status 看那台服务器。`)
    }
    if (probe) {
      // HTTP 活着但没连上：可能是我们上一次失败留下的，也可能是外部的。
      if (handle) await stop({ reason: 'stale' })
      else {
        throw new Error(`端口 ${bodyPort} 上已有一个没连上的 body（不是本会话启动的，mc-link 不会去杀它）。先手动结束它，或用不同的 listenPort 配置后再 mcb_join。`)
      }
    }
    if (handle && handle.alive) {
      // 已经在启动中：等它，不重复 spawn。
      return { reused: false, status: await waitReady(target), state: state() }
    }
    if (handle && !handle.alive) clear()

    const stderrFile = path.join(String(stateDir ?? '.'), 'body.stderr.log')
    fs.mkdirSync(String(stateDir ?? '.'), { recursive: true })
    const args = [
      bodyEntry,
      '--host', target.host,
      '--port', String(target.port),
      '--listen', String(bodyPort),
      '--name', target.username,
      '--allow-task', '--allow-say',
      '--paused-disconnect-ms', '0',
      '--state', path.join(String(stateDir ?? '.'), 'tasks.json'),
      '--log', path.join(String(stateDir ?? '.'), 'body.jsonl'),
      ...extraArgs,
    ]
    let child
    try {
      child = spawnImpl(nodePath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: process.env })
    } catch (error) {
      throw new Error(`启动 mc-body 失败（${nodePath} ${bodyEntry}）：${error?.message ?? error}`)
    }
    const h = attach(child)
    h.host = target.host
    h.port = target.port
    h.username = target.username
    onLifecycle({ type: 'body-spawn', pid: h.pid, host: target.host, port: target.port, username: target.username, listenPort: bodyPort, stderrFile, at: now() })
    const status = await waitReady(target, h)
    return { reused: false, status, state: state() }
  }

  /** state() 的带句柄版本：进程退出后 handle 已清空，但等待方还要能读到退出原因。 */
  function describeHandle(h) {
    if (!h) return state()
    return {
      owns: true,
      alive: h.alive,
      pid: h.pid ?? null,
      host: h.host,
      port: h.port,
      username: h.username,
      listenPort: bodyPort,
      exitCode: h.exitCode ?? null,
      exitSignal: h.exitSignal ?? null,
      spawnError: h.spawnError ?? null,
      startedAt: h.startedAt,
      elapsedMs: h.startedAt ? Math.max(0, now() - h.startedAt) : null,
      stderrTail: h.sink.tail(5),
    }
  }

  /** 等到 adapter.connected 或进程退出/超时；超时必须给出原因并清理，不能留着半死进程。 */
  async function waitReady(target, h = handle) {
    const deadline = now() + Math.max(1000, Number(startTimeoutMs) || 30_000)
    let lastError = null
    while (now() < deadline) {
      if (h && !h.alive) {
        const detail = describeHandle(h)
        if (handle === h) clear()
        throw new Error(`mc-body 进程在连上服务器前就退出了（${target.host}:${target.port}）。${failureText(detail)}`)
      }
      let status = null
      try { status = await fetchStatus() } catch (error) { lastError = error }
      if (status?.adapter?.connected) return status
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    const detail = h && !h.alive ? describeHandle(h) : describeHandle(h ?? handle)
    await stop({ reason: 'start-timeout' }).catch(() => {})
    throw new Error(`mc-body 没能在 ${Math.round((startTimeoutMs ?? 30_000) / 1000)}s 内连上 ${target.host}:${target.port}（常见原因：服务器没开、端口写错、被服务器踢、同服已有同名 bot）。${failureText(detail)}${lastError ? `；HTTP：${lastError?.message ?? lastError}` : ''}`)
  }

  /** 只结束"本会话 spawn 的"进程；外部 body 交给调用方安全停止。 */
  async function stop({ reason = 'manual' } = {}) {
    const h = handle
    if (!h) return { killed: false, note: '本会话没有启动过 body' }
    h.stopping = true
    clear()
    try { if (isFunction(beforeKill)) await beforeKill(reason) } catch (error) {
      log({ msg: 'mc-link.stop-hook-fail', error: String(error?.message ?? error) })
    }
    const child = h.child
    let exited = false
    const waitExit = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), Math.max(200, Number(stopGraceMs) || 1500))
      if (typeof timer.unref === 'function') timer.unref()
      const onExit = () => { clearTimeout(timer); resolve(true) }
      try { child?.once?.('exit', onExit) } catch { resolve(false) }
      if (handle === null && h.alive === false) { clearTimeout(timer); resolve(true) }
    })
    try { child?.kill?.('SIGTERM') } catch (error) {
      log({ msg: 'mc-link.kill-fail', signal: 'SIGTERM', error: String(error?.message ?? error) })
    }
    exited = await waitExit
    if (!exited) {
      try { child?.kill?.('SIGKILL') } catch (error) {
        log({ msg: 'mc-link.kill-fail', signal: 'SIGKILL', error: String(error?.message ?? error) })
      }
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    h.alive = false
    onLifecycle({ type: 'body-stopped', pid: h.pid, reason, forced: !exited, at: now() })
    return { killed: true, pid: h.pid ?? null, forced: !exited, reason }
  }

  /** 插件卸载：不等待，但必须保证不把子进程留在后台。 */
  function dispose() {
    const h = handle
    if (!h) return
    h.stopping = true
    clear()
    try { h.child?.kill?.('SIGTERM') } catch { /* 尽力 */ }
    const timer = setTimeout(() => { try { h.child?.kill?.('SIGKILL') } catch { /* 尽力 */ } }, 1200)
    if (typeof timer.unref === 'function') timer.unref()
  }

  return {
    ensure,
    stop,
    dispose,
    state,
    waitReady,
    /** 探测当前 HTTP 状态（用于"外部 body 被 kill"的检测）。 */
    probe: () => fetchStatus(),
    owns: () => Boolean(handle && handle.alive),
  }
}
