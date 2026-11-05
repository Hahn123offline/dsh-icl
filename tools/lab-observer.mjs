// lab observer：常驻跟随一条 lab 会话，落原始事件并增量维护 transcript.md。
//
// 由 `tools/lab.mjs up` 以 detached 子进程启动；也可以手工跑：
//   node tools/lab-observer.mjs --run-dir .state/lab/<runId> --port 57101 --session <id>
//   node tools/lab-observer.mjs --run-dir .state/lab/<runId> --once   # 只重建 transcript
//
// 口径（docs/LOOP.md §3.2）：`session/follow` 的 snapshot + session/event 是权威源；
// 这里只落盘与渲染，不做断言，也不相信模型自述。
import fs from 'node:fs'
import path from 'node:path'
import {
  apiFor, appendJsonl, ensureDir, nowIso, readJson, readJsonl, readRunMeta,
  rebuildTranscript, sleep, writeJson,
} from './lab-lib.mjs'

const args = process.argv.slice(2)
const arg = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback }
const flag = (name) => args.includes(name)

const runDir = path.resolve(String(arg('--run-dir', '')))
if (!runDir) {
  console.error('用法：node tools/lab-observer.mjs --run-dir <dir> --port <port> --session <id> [--once]')
  process.exit(2)
}
const meta = readRunMeta(path.basename(runDir)) ?? {}
const port = Number(arg('--port', meta.port))
const sessionId = String(arg('--session', meta.sessionId ?? ''))
const eventsFile = path.join(runDir, 'events.jsonl')
const statusFile = path.join(runDir, 'observer.status.json')
const pidFile = path.join(runDir, 'observer.pid')
ensureDir(runDir)

if (flag('--once')) {
  const out = rebuildTranscript(runDir)
  console.log(JSON.stringify(out))
  process.exit(0)
}

fs.writeFileSync(pidFile, String(process.pid), 'utf8')

/** 已落盘的事件键：重启/重连后 snapshot 会重放历史，不重复追加。 */
const seen = new Set()
for (const envelope of readJsonl(eventsFile)) {
  const payload = envelope?.payload ?? envelope
  if (payload?.type === 'session/event' && payload.event?.seq != null) seen.add(String(payload.event.seq))
  if (payload?.type === 'session/snapshot') {
    for (const record of payload.snapshot?.records ?? []) {
      if (record?.type === 'event' && record.event?.seq != null) seen.add(String(record.event.seq))
    }
  }
}

const state = {
  pid: process.pid,
  sessionId,
  connected: false,
  startedAt: nowIso(),
  updatedAt: nowIso(),
  events: seen.size,
  turns: 0,
  lastEventAt: null,
  lastError: null,
  stopped: false,
}
function writeStatus(patch = {}) {
  Object.assign(state, patch, { updatedAt: nowIso(), events: seen.size })
  try { writeJson(statusFile, state) } catch { /* 状态文件写失败不该拖垮跟随 */ }
}

let lastRenderAt = 0
function render(force = false) {
  const now = Date.now()
  if (!force && now - lastRenderAt < 1500) return
  lastRenderAt = now
  try { rebuildTranscript(runDir) } catch (error) {
    state.lastError = `render: ${String(error?.message ?? error)}`
    writeStatus()
  }
}

function countTurns() {
  let turns = 0
  for (const envelope of readJsonl(eventsFile)) {
    const payload = envelope?.payload ?? envelope
    if (payload?.type === 'session/event' && payload.event?.type === 'turn/end') turns += 1
  }
  return turns
}

/** 把一帧写进事件账本；返回是否新增了事件。 */
function ingest(item) {
  const payload = item?.payload
  if (!payload) return false
  let fresh = false
  if (payload.type === 'session/snapshot') {
    for (const record of payload.snapshot?.records ?? []) {
      if (record?.type !== 'event') continue
      const event = record.event
      if (!event?.type) continue
      if (event.seq != null) {
        if (seen.has(String(event.seq))) continue
        seen.add(String(event.seq))
      }
      appendJsonl(eventsFile, { payload: { type: 'session/event', sessionId: payload.sessionId ?? sessionId, event } })
      fresh = true
    }
    if (fresh) appendJsonl(eventsFile, { payload: { type: 'session/snapshot-marker', sessionId: payload.sessionId, at: nowIso() } })
  } else if (payload.type === 'session/event') {
    const event = payload.event
    if (!event?.type) return false
    if (event.seq != null) {
      if (seen.has(String(event.seq))) return false
      seen.add(String(event.seq))
    }
    appendJsonl(eventsFile, item)
    fresh = true
  } else {
    return false
  }
  if (!fresh) return false
  state.lastEventAt = nowIso()
  if (payload.type === 'session/event' && payload.event?.type === 'turn/end') {
    state.turns = countTurns()
    render(true)
    writeStatus()
  } else {
    render(false)
    writeStatus()
  }
  return true
}

let stopping = false
let controller = null
process.on('SIGINT', () => stop('SIGINT'))
process.on('SIGTERM', () => stop('SIGTERM'))
function stop(reason) {
  if (stopping) return
  stopping = true
  state.stopped = true
  writeStatus({ stoppedAt: nowIso(), stopReason: reason })
  try { controller?.abort() } catch { /* ignore */ }
  render(true)
  process.exit(0)
}

function dshAlive() {
  const currentMeta = readJson(path.join(runDir, 'lab.json'), null)
  const pid = Number(currentMeta?.pids?.dsh)
  if (!Number.isFinite(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

async function follow() {
  const api = apiFor(port)
  let attempt = 0
  while (!stopping) {
    if (!dshAlive()) {
      writeStatus({ connected: false, lastError: 'dsh 进程已退出', endedAt: nowIso() })
      render(true)
      return
    }
    controller = new AbortController()
    try {
      const stream = api.events.mux(controller.signal)
      stream.follow(sessionId)
      state.connected = true
      state.phase = 'following'
      state.lastError = null
      attempt = 0
      writeStatus()
      for await (const item of stream) {
        if (stopping) break
        ingest(item)
      }
      state.connected = false
      if (stopping) break
      state.lastError = 'mux 流结束'
      writeStatus()
    } catch (error) {
      state.connected = false
      state.lastError = String(error?.message ?? error)
      writeStatus()
    }
    attempt += 1
    if (attempt > 60) {
      writeStatus({ lastError: `重连 ${attempt} 次仍失败`, endedAt: nowIso() })
      render(true)
      return
    }
    await sleep(Math.min(5000, 500 * attempt))
  }
}

writeStatus({ phase: 'starting' })
try {
  await follow()
} finally {
  writeStatus({ connected: false, endedAt: nowIso() })
  render(true)
  try { fs.unlinkSync(pidFile) } catch { /* 已删 */ }
}
