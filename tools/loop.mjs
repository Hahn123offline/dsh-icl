// 闭环 driver：在真实 DSH 会话里跑 scenario，记录 session/follow 事件，产出可回放证据。
//
// 这是 docs/LOOP.md 的 MVP：只负责驱动/观测/断言，不替代单测。
//
//   node tools/loop.mjs --base http://127.0.0.1:<GUI 端口> --scenario tools/scenarios/loop-s0.json
//
// 依赖 profile 里已安装 `icl-loop` preset（见 packages/dsh-icl/presets/icl.patch.yml）。
import fs from 'node:fs'
import path from 'node:path'
import { NodeApiClient, unwrap } from '../packages/adapters/dsh-client.mjs'

const args = process.argv.slice(2)
const arg = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback }
const flag = (name) => args.includes(name)
const base = String(arg('--base', process.env.DSH_BASE_URL ?? 'http://127.0.0.1:54846')).replace(/\/+$/, '')
const preset = String(arg('--preset', 'icl-loop'))
const stateDir = String(arg('--state-dir', 'C:/DSH/icl/.state/loop-state'))
const loopWorkspace = path.resolve(String(arg('--workspace', 'C:/DSH/icl/.state/loop/workspace')))
const outRoot = path.resolve(String(arg('--out', path.join('C:/DSH/icl/.state/loop/runs', new Date().toISOString().replace(/[:.]/g, '-')))))
const scenarioFile = arg('--scenario', path.join(import.meta.dirname, 'scenarios', 'loop-s0.json'))
const keep = flag('--keep')
const fresh = flag('--fresh')
const archive = flag('--archive')
const reuseSession = arg('--session', null)

const scenario = JSON.parse(fs.readFileSync(scenarioFile, 'utf8'))
fs.mkdirSync(outRoot, { recursive: true })
const eventsFile = path.join(outRoot, 'events.jsonl')
const reportFile = path.join(outRoot, 'report.md')
const verdictFile = path.join(outRoot, 'verdict.json')
const contextDir = path.join(outRoot, 'context')
const stateOutDir = path.join(outRoot, 'state')
fs.mkdirSync(contextDir, { recursive: true })
fs.mkdirSync(stateOutDir, { recursive: true })
if (fresh) {
  // 只清测试 state；绝不碰 ~/.dsh/icl/state。
  // preset 插件在 app 启动时就可能已经打开 memory.db；默认不删，--fresh 只应在重启前用。
  try {
    fs.rmSync(stateDir, { recursive: true, force: true })
  } catch (error) {
    throw new Error(`--fresh 清不掉 ${stateDir}（${String(error?.message ?? error)}）；先重启 DSH 再跑，或去掉 --fresh`)
  }
  fs.mkdirSync(stateDir, { recursive: true })
}

const api = new NodeApiClient(base, 120_000, {})
const run = {
  startedAt: Date.now(),
  base,
  preset,
  stateDir,
  outRoot,
  scenario: path.basename(scenarioFile),
  sessionId: null,
  workspaceId: null,
  steps: [],
  assertions: [],
  tools: [],
  errors: [],
}
function writeRun() { fs.writeFileSync(path.join(outRoot, 'run.json'), JSON.stringify(run, null, 2), 'utf8') }
function log(line) { console.log(`[loop] ${line}`) }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

class Observer {
  constructor() {
    this.events = []
    this.seen = new Set()
    this.turns = 0
    this.activeTurn = false
    this.system = []
    this.ac = new AbortController()
    this.pump = null
    this.closed = false
  }

  async start(sessionId) {
    try {
      this.stream = api.events.mux(this.ac.signal)
      this.stream.follow(sessionId)
      this.pump = (async () => {
        try {
          for await (const item of this.stream) this.ingest(item)
        } catch (error) {
          if (!this.closed) run.errors.push({ where: 'observer', error: String(error?.message ?? error) })
        }
      })()
    } catch (error) {
      run.errors.push({ where: 'observer.start', error: String(error?.message ?? error) })
    }
  }

  ingest(item) {
    const payload = item?.payload
    if (!payload) return
    try { fs.appendFileSync(eventsFile, `${JSON.stringify(item)}\n`, 'utf8') } catch { /* ignore */ }
    if (payload.type === 'session/snapshot') {
      for (const record of payload.snapshot?.records ?? []) {
        if (record?.type === 'event') this.event(record.event)
      }
    } else if (payload.type === 'session/event') {
      this.event(payload.event)
    }
  }

  event(event) {
    if (!event || !event.type) return
    const key = `${event.seq ?? ''}:${event.type}`
    if (event.seq != null && this.seen.has(key)) return
    if (event.seq != null) this.seen.add(key)
    this.events.push(event)
    if (event.type === 'turn/start') this.activeTurn = true
    if (event.type === 'turn/end') { this.activeTurn = false; this.turns += 1 }
    if (event.type === 'system/message') {
      const text = textOfMessage(event.data?.message ?? event.data)
      if (text) {
        this.system.push({ seq: event.seq, time: event.time, text })
        try { fs.writeFileSync(path.join(contextDir, `turn-${event.seq ?? this.system.length}.txt`), text, 'utf8') } catch { /* ignore */ }
      }
    }
    if (event.type === 'tool/call') {
      run.tools.push({ kind: 'call', seq: event.seq, time: event.time, name: event.data?.name ?? event.data?.tool ?? '', args: event.data?.args ?? event.data?.input ?? null })
    }
    if (event.type === 'tool/result') {
      run.tools.push({ kind: 'result', seq: event.seq, time: event.time, name: event.data?.name ?? event.data?.tool ?? '', text: textOfMessage(event.data?.message ?? event.data).slice(0, 2000) })
    }
  }

  lastSystem() { return this.system.at(-1)?.text ?? '' }
  maxSeq() { return this.events.reduce((n, e) => Math.max(n, Number(e.seq) || 0), 0) }

  async waitFor(predicate, { timeoutMs = 120_000, label = 'event' } = {}) {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const hit = this.events.find(predicate)
      if (hit) return hit
      await sleep(100)
    }
    throw new Error(`等待 ${label} 超时（${timeoutMs}ms）`)
  }

  async waitTurnEnd(afterSeq, timeoutMs = 180_000) {
    const hit = await this.waitFor((event) => event.type === 'turn/end' && Number(event.seq) > afterSeq, { timeoutMs, label: 'turn/end' })
    return hit
  }

  stop() { this.closed = true; try { this.ac.abort() } catch { /* ignore */ } }
}

function textOfMessage(data) {
  const content = data?.content ?? data?.message?.content
  if (Array.isArray(content)) return content.map((part) => part?.text ?? '').join('')
  return typeof content === 'string' ? content : ''
}

async function createSession() {
  if (reuseSession) {
    run.sessionId = String(reuseSession)
    writeRun()
    return
  }
  // loop preset 可能恢复上一条会话并占着单会话锁；先让测试控制面释放。
  try {
    fs.writeFileSync(path.join(stateDir, 'control.json'), JSON.stringify({ cmd: 'release', at: Date.now() }), 'utf8')
    await sleep(600)
  } catch { /* ignore */ }
  const workspace = loopWorkspace
  fs.mkdirSync(workspace, { recursive: true })
  const ws = unwrap(await api.callUnary('workspace/create', { path: workspace }, undefined), 'workspace/create')
  run.workspaceId = ws?.workspace?.workspaceId ?? ws?.workspaceId
  const created = unwrap(await api.callUnary('session/create', { workspaceId: run.workspaceId, agentPreset: preset, title: `ICL Loop ${path.basename(outRoot)}` }, undefined, 'long'), 'session/create')
  run.sessionId = created?.sessionId ?? created?.id
  if (!run.sessionId) throw new Error('session/create 没有返回 sessionId')
  writeRun()
}

async function prompt(text, timeoutMs = 180_000) {
  const baseline = observer.maxSeq()
  const result = await api.callUnary('session/prompt', {
    sessionId: run.sessionId,
    mode: 'queue',
    content: [{ type: 'text', text }],
  }, undefined)
  const accepted = result?.result?.value?.accepted ?? result?.result?.accepted
  if (!accepted) throw new Error(`prompt 被拒：${JSON.stringify(result?.result).slice(0, 500)}`)
  const end = await observer.waitTurnEnd(baseline, timeoutMs)
  return end
}

async function waitIdle(timeoutMs = 60_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (!observer.activeTurn) return
    await sleep(100)
  }
}

function appendCommand(file, command) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${JSON.stringify(command)}\n`, 'utf8')
}

async function waitOutbox(file, id, timeoutMs = 30_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).reverse()
      for (const line of lines) {
        const entry = JSON.parse(line)
        if (entry.id !== id) continue
        return entry
      }
    } catch { /* file absent */ }
    await sleep(120)
  }
  throw new Error(`等不到 ${file} 的回执：${id}`)
}

async function timeCommand(cmd, payload = {}, timeoutMs = 30_000) {
  const id = `loop-${Date.now()}-${Math.floor(Math.random() * 1000)}`
  appendCommand(path.join(stateDir, 'time.inbox.jsonl'), { id, cmd, args: payload, at: Date.now() })
  const out = await waitOutbox(path.join(stateDir, 'time.outbox.jsonl'), id, timeoutMs)
  if (!out.ok) throw new Error(`time ${cmd} 失败：${out.error}`)
  return out.result
}

async function signal(payload = {}, timeoutMs = 15_000) {
  const id = `sig-${Date.now()}-${Math.floor(Math.random() * 1000)}`
  appendCommand(path.join(stateDir, 'loop.inbox.jsonl'), { ...payload, id })
  return waitOutbox(path.join(stateDir, 'loop.outbox.jsonl'), id, timeoutMs)
}

function assertStep(expect = {}) {
  const checks = []
  const system = observer.lastSystem()
  for (const needle of expect.systemContains ?? []) checks.push({ kind: 'systemContains', needle, ok: system.includes(needle) })
  for (const name of expect.toolCalled ?? []) checks.push({ kind: 'toolCalled', name, ok: run.tools.some((t) => t.kind === 'call' && t.name === name) })
  for (const needle of expect.toolResultContains ?? []) checks.push({ kind: 'toolResultContains', needle, ok: run.tools.some((t) => t.kind === 'result' && String(t.text).includes(needle)) })
  for (const needle of expect.userContains ?? []) {
    const ok = observer.events.some((e) => e.type === 'user/message' && textOfMessage(e.data?.message ?? e.data).includes(needle))
    checks.push({ kind: 'userContains', needle, ok })
  }
  for (const needle of expect.assistantContains ?? []) {
    const ok = observer.events.some((e) => e.type === 'assistant/message' && textOfMessage(e.data?.message ?? e.data).includes(needle))
    checks.push({ kind: 'assistantContains', needle, ok })
  }
  if (expect.signalBlocked) {
    const last = [...run.steps].reverse().find((s) => s.op === 'signal')
    const result = last?.result?.result
    checks.push({ kind: 'signalBlocked', ok: result?.accepted === false && result?.blocked === true })
  }
  if (expect.minTurns != null) checks.push({ kind: 'minTurns', expected: expect.minTurns, ok: observer.turns >= expect.minTurns })
  run.assertions.push(...checks.map((c) => ({ ...c, step: expect.id ?? null })))
  return checks.every((c) => c.ok)
}

async function snapshot() {
  const out = {}
  for (const name of ['time.json', 'focus.json']) {
    try { out[name] = JSON.parse(fs.readFileSync(path.join(stateDir, name), 'utf8')) } catch { out[name] = null }
  }
  fs.writeFileSync(path.join(stateOutDir, `snap-${Date.now()}.json`), JSON.stringify(out, null, 2), 'utf8')
  return out
}

async function main() {
  log(`base=${base} preset=${preset} out=${outRoot}`)
  await createSession()
  observer = new Observer()
  await observer.start(run.sessionId)
  await sleep(800)
  log(`session=${run.sessionId}`)
  // 闭环每轮从干净的 time/focus/delivery/memory 开始；否则旧 run 的消息会漏进新会话。
  try {
    run.reset = await signal({ op: 'reset' }, 15_000)
    // 清掉上一次 run 的原文，避免 dream wash 把旧会话当成今天。
    try { fs.writeFileSync(path.join(stateDir, 'session-events.jsonl'), '', 'utf8') } catch { /* ignore */ }
    log(`reset ${JSON.stringify(run.reset.result)}`)
  } catch (error) {
    run.errors.push({ where: 'reset', error: String(error?.message ?? error) })
  }
  try {
    for (const step of scenario) {
      const id = step.id ?? step.op
      log(`step ${id}`)
      const started = Date.now()
      try {
        if (step.op === 'prompt') {
          await waitIdle()
          await prompt(step.text, Number(step.timeoutSec ?? 180) * 1000)
        } else if (step.op === 'wait') {
          await sleep(Number(step.seconds ?? 1) * 1000)
        } else if (step.op === 'time') {
          const result = await timeCommand(step.cmd, step.args ?? {}, Number(step.timeoutSec ?? 30) * 1000)
          run.steps.push({ id, op: 'time', cmd: step.cmd, result, ms: Date.now() - started })
          continue
        } else if (step.op === 'signal') {
          const result = await signal(step, Number(step.timeoutSec ?? 15) * 1000)
          run.steps.push({ id, op: 'signal', result, ms: Date.now() - started })
          continue
        } else if (step.op === 'assert') {
          const ok = assertStep({ ...step, id })
          run.steps.push({ id, op: 'assert', ok, ms: Date.now() - started })
          if (!ok && step.required !== false) throw new Error(`断言失败：${id}`)
          continue
        } else if (step.op === 'snapshot') {
          const result = await snapshot()
          run.steps.push({ id, op: 'snapshot', result, ms: Date.now() - started })
          continue
        } else {
          throw new Error(`未知 op：${step.op}`)
        }
        run.steps.push({ id, op: step.op, ok: true, ms: Date.now() - started })
      } catch (error) {
        run.steps.push({ id, op: step.op, ok: false, error: String(error?.message ?? error), ms: Date.now() - started })
        run.errors.push({ step: id, error: String(error?.message ?? error) })
        if (step.required !== false) throw error
      }
    }
  } finally {
    observer.stop()
  }
}

let observer = null
try {
  await main()
} catch (error) {
  run.errors.push({ where: 'main', error: String(error?.message ?? error) })
  console.error(`[loop] FAILED: ${String(error?.message ?? error)}`)
} finally {
  run.finishedAt = Date.now()
  run.durationMs = run.finishedAt - run.startedAt
  run.turns = observer?.turns ?? 0
  const failed = run.assertions.filter((a) => !a.ok).length + (run.errors.length ? 1 : 0)
  const verdict = { ok: failed === 0, failed, turns: run.turns, tools: run.tools.length, assertions: run.assertions.length, errors: run.errors.length }
  fs.writeFileSync(verdictFile, JSON.stringify(verdict, null, 2), 'utf8')
  writeRun()
  const report = [
    '# ICL loop report',
    '',
    `- base: ${base}`,
    `- preset: ${preset}`,
    `- session: ${run.sessionId ?? '(none)'}`,
    `- scenario: ${run.scenario}`,
    `- duration: ${(run.durationMs / 1000).toFixed(1)}s`,
    `- turns: ${run.turns}`,
    `- assertions: ${run.assertions.filter((a) => a.ok).length}/${run.assertions.length} passed`,
    `- tool events: ${run.tools.length}`,
    `- errors: ${run.errors.length}`,
    '',
    '## assertions',
    ...run.assertions.map((a) => `- ${a.ok ? '✓' : '✗'} ${a.step ?? ''} ${a.kind} ${a.needle ?? a.name ?? a.expected ?? ''}`),
    '',
    '## errors',
    ...(run.errors.length ? run.errors.map((e) => `- ${JSON.stringify(e)}`) : ['- none']),
    '',
    '## tools',
    ...run.tools.map((t) => `- ${t.kind} ${t.name}${t.kind === 'result' ? ` → ${String(t.text).replace(/\n/g, ' ').slice(0, 120)}` : ''}`),
  ].join('\n')
  fs.writeFileSync(reportFile, report, 'utf8')
  console.log(`[loop] ${verdict.ok ? 'PASS' : 'FAIL'} turns=${run.turns} assertions=${verdict.assertions} errors=${verdict.errors}`)
  console.log(`[loop] ${reportFile}`)
  if (!verdict.ok) process.exitCode = 1
  try { if (archive && !keep) await api.callUnary('workspace/archiveSession', { sessionId: run.sessionId }, undefined) } catch { /* ignore */ }
  // remote.mux 的 WebSocket 会保持进程存活；artifact 已写完，直接退出。
  process.exit(verdict.ok ? 0 : 1)
}
