// lab：后台、可控、可复跑的 ICL 受试会话（不碰 desktop）。
//
//   node tools/lab.mjs up [--preset icl-lab|icl-mc-lab] [--port 57101] [--model flash|local]
//   node tools/lab.mjs status [--json]
//   node tools/lab.mjs say "去 MC 里玩会儿吧" [--wait] [--timeout 300]
//   node tools/lab.mjs tail [--lines 80] [--events]
//   node tools/lab.mjs export [--run <id>]
//   node tools/lab.mjs script --file tools/scenarios/cache-10.json
//   node tools/lab.mjs down [--run <id>]
//
// 每个 run 的产物都在 `.state/lab/<runId>/`：
//   lab.patch.yml        本次实际喂给 dsh 的 --patch 覆盖层（占位符已物化）
//   lab.json             run 元数据（端口/preset/模型/session/pids）
//   events.jsonl         session/follow 原始事件（含 seq；observer 去重后落盘）
//   transcript.md        人可读逐轮记录（observer 增量维护，export 可全量重建）
//   context/             每轮 system 提示词快照（按 seq）
//   state/<preset>/      ICL 的 stateDir（time/focus/原文/memory）
//   dsh.out.log / dsh.err.log / observer.*.log
//
// 纪律：一条 lab 进程只绑一条 ICL 会话（dsh-icl 单会话锁）。换场景就 down 再 up，
// 不要并行建会话；绝不重启 desktop、不改 desktop profile、不 kill 用户进程。
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  DEFAULT_MC_PORT, DEFAULT_PORT, PRESETS, REPO_ROOT, STATE_ROOT, apiFor,
  clearCurrent, countTurnEnds, createLabSession, discoverDshBin, ensureDir,
  isPidAlive, killPidTree, loadCurrent, materializePatch, nowIso, portBusy,
  promptSession, readJson, readJsonl, readRunMeta, rebuildTranscript, runDirOf,
  saveCurrent, selectModel, sleep, spawnDsh, spawnObserver, textOfMessage, tsSlug,
  waitApiReady, writeJson, writeRunMeta,
} from './lab-lib.mjs'

const args = process.argv.slice(2)
const cmd = args[0]

/** 带值的 flag：位置参数解析时要跳过它们的值。 */
const VALUED_FLAGS = new Set([
  '--run', '--port', '--preset', '--model', '--mc-port', '--workspace', '--title',
  '--timeout', '--provider', '--lines', '--file', '--rounds', '--gap', '--text',
])
const arg = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback }
const flag = (name) => args.includes(name)

/** 只取真正的位置参数（跳过 flag 及其值）。 */
function positionals(from = 1) {
  const out = []
  for (let i = from; i < args.length; i += 1) {
    const token = args[i]
    if (token.startsWith('--')) {
      if (VALUED_FLAGS.has(token)) i += 1
      continue
    }
    out.push(token)
  }
  return out
}

const MODEL_ROUTES = {
  flash: { provider: 'deepseek-account', model: 'deepseek-flash', source: 'profile-default', label: '云端 deepseek-flash（web profile 的 agent-default-model）' },
  local: { provider: 'ninfer', model: 'coder390-27b-q3-df2-4x500', source: 'selectModel', label: '本地 coder390-27b-q3-df2-4x500（GPU 串行）' },
}

function fail(message, code = 1) {
  console.error(`[lab] ${message}`)
  process.exit(code)
}

function info(message) {
  console.log(`[lab] ${message}`)
}

function listRuns() {
  let entries = []
  try { entries = fs.readdirSync(STATE_ROOT, { withFileTypes: true }).filter((entry) => entry.isDirectory()) } catch { return [] }
  const rows = []
  for (const entry of entries) {
    const meta = readJson(path.join(STATE_ROOT, entry.name, 'lab.json'), null)
    if (!meta) continue
    rows.push({ ...meta, runId: entry.name })
  }
  return rows.sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')))
}

function resolveRun(runId = null) {
  const current = loadCurrent()
  const id = runId ?? arg('--run') ?? current?.runId ?? null
  if (!id) return null
  return { runId: id, runDir: runDirOf(id), meta: readRunMeta(id), current: current?.runId === id ? current : null }
}

/** 找到要操作的 run：显式 --run → current → 最近一个。 */
function requireRun() {
  const explicit = arg('--run')
  const run = resolveRun(explicit)
  if (run?.meta) return run
  if (explicit) fail(`没有 run「${explicit}」的 lab.json`)
  const latest = listRuns()[0]
  if (!latest) fail('还没有任何 lab run；先 `node tools/lab.mjs up`')
  return { runId: latest.runId, runDir: runDirOf(latest.runId), meta: latest, current: null }
}

function logTail(file, lines = 30) {
  try {
    const rows = fs.readFileSync(file, 'utf8').trimEnd().split(/\r?\n/)
    return rows.slice(-lines).join('\n')
  } catch { return '' }
}

function llamaLockPath() {
  return path.join(REPO_ROOT, '.state', 'locks', 'llama.lock')
}

function acquireLocalModelLock(runId) {
  const file = llamaLockPath()
  const existing = readJson(file, null)
  if (existing && existing.owner && existing.owner !== 'mc-lab' && isPidAlive(existing.pid)) {
    fail(`本地模型锁被占用（owner=${existing.owner} pid=${existing.pid} ${existing.purpose ?? ''}）；等它释放或找 lead 协调`)
  }
  writeJson(file, { owner: 'mc-lab', runId, purpose: 'lab --model local', pid: process.pid, at: nowIso() })
}

function releaseLocalModelLock(runId) {
  const file = llamaLockPath()
  const existing = readJson(file, null)
  if (existing?.owner === 'mc-lab' && (!runId || existing.runId === runId)) {
    try { fs.unlinkSync(file) } catch { /* 已删 */ }
  }
}

/* ── up ───────────────────────────────────────────────── */

async function up() {
  const preset = String(arg('--preset', 'icl-lab'))
  if (!PRESETS[preset]) fail(`未知 preset：${preset}（可选：${Object.keys(PRESETS).join(', ')}）`)
  const port = Number(arg('--port', DEFAULT_PORT))
  const mcPort = Number(arg('--mc-port', DEFAULT_MC_PORT))
  const runId = String(arg('--run', tsSlug()))
  const modelKey = String(arg('--model', 'flash'))
  const customRoute = arg('--provider') && arg('--model') ? { provider: String(arg('--provider')), model: String(arg('--model')), source: 'explicit' } : null
  const route = customRoute ?? MODEL_ROUTES[modelKey]
  if (!route) fail(`未知 --model：${modelKey}（可选：${Object.keys(MODEL_ROUTES).join(', ')}，或 --provider X --model Y）`)

  const existing = loadCurrent()
  if (existing?.alive) {
    if (!flag('--force')) fail(`已有 lab run ${existing.runId} 在 ${existing.port} 上运行；先 \`node tools/lab.mjs down\`（或 --force）`)
    info(`--force：先停掉旧 run ${existing.runId}`)
    await down({ quiet: true, runId: existing.runId })
  }
  if (isPidAlive(readRunMeta(runId)?.pids?.dsh)) fail(`run ${runId} 的 dsh 还活着；先 down --run ${runId}`)
  if (await portBusy(port)) fail(`端口 ${port} 已被占用（别的 lab run 或别的进程）；换 --port 或先确认`)

  const dshBin = discoverDshBin()
  if (!dshBin) fail('找不到 dsh 的 bin.js；用 DSH_BIN=<...>/lib/bin.js 指定')
  if (modelKey === 'local') acquireLocalModelLock(runId)

  const runDir = ensureDir(runDirOf(runId))
  ensureDir(path.join(runDir, 'state'))
  const patch = materializePatch({ runDir, mcPort })
  const workspace = path.resolve(String(arg('--workspace', path.join(runDir, 'workspace'))))
  const title = String(arg('--title', `ICL Lab ${runId}`))
  const meta = {
    runId,
    port,
    mcPort,
    preset,
    worktree: REPO_ROOT,
    dshBin,
    patch,
    workspace,
    title,
    startedAt: nowIso(),
    status: 'starting',
    pids: {},
    model: { provider: route.provider, model: route.model, source: route.source ?? 'explicit' },
  }
  writeRunMeta(runId, meta)
  saveCurrent({ runId, port, preset, runDir, startedAt: meta.startedAt, pids: {} })

  info(`启动 dsh：port=${port} preset=${preset} run=${runId}`)
  info(`patch=${patch}`)
  const dsh = spawnDsh({ bin: dshBin, patch, port, logDir: runDir })
  meta.pids.dsh = dsh.pid
  meta.status = 'booting'
  writeRunMeta(runId, meta)
  saveCurrent({ runId, port, preset, runDir, startedAt: meta.startedAt, pids: { dsh: dsh.pid } })

  const timeoutMs = Number(arg('--timeout', 180)) * 1000
  try {
    const api = apiFor(port)
    await waitApiReady(api, { timeoutMs, shouldAbort: () => !isPidAlive(dsh.pid) })
    info('DSH API 就绪，建会话…')
    const { workspaceId, sessionId } = await createLabSession(api, { preset, workspace, title })
    meta.workspaceId = workspaceId
    meta.sessionId = sessionId
    if (route.source === 'selectModel' || route.source === 'explicit') {
      await selectModel(api, sessionId, { provider: route.provider, model: route.model })
      info(`已 selectModel → ${route.provider}/${route.model}`)
    }
    meta.status = 'running'
    writeRunMeta(runId, meta)

    const observer = spawnObserver({ runDir, port, sessionId, logDir: runDir })
    meta.pids.observer = observer.pid
    writeRunMeta(runId, meta)
    saveCurrent({ runId, port, preset, runDir, startedAt: meta.startedAt, pids: { dsh: dsh.pid, observer: observer.pid } })
    // 等 observer 真正连上，避免紧接着的 say 没人记账
    const deadline = Date.now() + 25_000
    while (Date.now() < deadline) {
      const status = readJson(path.join(runDir, 'observer.status.json'), null)
      if (status?.connected) break
      if (!isPidAlive(observer.pid)) break
      await sleep(200)
    }
    rebuildTranscript(runDir)
    const observerStatus = readJson(path.join(runDir, 'observer.status.json'), null)
    info(`就绪：session=${sessionId} port=${port} observer=${observerStatus?.connected ? 'connected' : '未确认'}`)
    info(`证据目录：${runDir}`)
    info(`transcript：${path.join(runDir, 'transcript.md')}`)
    info('发话：node tools/lab.mjs say "你好" --wait')
    console.log(JSON.stringify({ ok: true, runId, port, preset, sessionId, workspaceId, runDir, model: meta.model }, null, 2))
  } catch (error) {
    meta.status = 'failed'
    meta.failedAt = nowIso()
    meta.failReason = String(error?.message ?? error)
    writeRunMeta(runId, meta)
    const tail = logTail(dsh.errFile, 25) || logTail(dsh.outFile, 25)
    const observerPid = readRunMeta(runId)?.pids?.observer
    if (observerPid) await killPidTree(observerPid)
    await killPidTree(dsh.pid)
    clearCurrent(runId)
    releaseLocalModelLock(runId)
    console.error(`[lab] up 失败：${meta.failReason}`)
    if (tail) console.error(`[lab] dsh 日志尾部：\n${tail}`)
    process.exit(1)
  }
}

/* ── down ─────────────────────────────────────────────── */

async function down({ quiet = false, runId: forcedRunId = null } = {}) {
  const run = resolveRun(forcedRunId)
  if (!run?.meta) {
    if (!quiet) info('没有可停的 lab run')
    return
  }
  const { runId, runDir, meta } = run
  const pids = { ...(meta.pids ?? {}) }
  if (!quiet) info(`停止 run ${runId}（dsh pid=${pids.dsh ?? '?'}，observer pid=${pids.observer ?? '?'}）`)
  if (pids.observer) await killPidTree(pids.observer)
  if (pids.dsh) await killPidTree(pids.dsh)
  const deadline = Date.now() + 8000
  while (Date.now() < deadline && (isPidAlive(pids.dsh) || isPidAlive(pids.observer))) await sleep(200)

  meta.status = 'down'
  meta.endedAt = nowIso()
  meta.pids = pids
  writeRunMeta(runId, meta)
  let transcript = null
  try { transcript = rebuildTranscript(runDir) } catch (error) { info(`重建 transcript 失败：${String(error?.message ?? error)}`) }
  clearCurrent(runId)
  releaseLocalModelLock(runId)
  if (!quiet) {
    info(`已停止；证据目录：${runDir}`)
    if (transcript) info(`transcript：${transcript.file}（${transcript.events} 事件）`)
    info(`本次 --patch 保留在 ${meta.patch}（可复盘实际启动配置）`)
    console.log(JSON.stringify({ ok: true, runId, status: 'down', runDir }, null, 2))
  }
}

/* ── status / tail / export / log / runs ──────────────── */

function status() {
  const current = loadCurrent()
  const run = resolveRun()
  if (!run?.meta) {
    const runs = listRuns()
    if (flag('--json')) console.log(JSON.stringify({ running: false, runs: runs.slice(0, 10) }, null, 2))
    else {
      info('没有进行中的 lab run')
      for (const row of runs.slice(0, 10)) console.log(`  ${row.runId}  ${row.status ?? '?'}  ${row.preset ?? ''}  :${row.port ?? ''}`)
    }
    return
  }
  const { runId, runDir, meta } = run
  const eventsFile = path.join(runDir, 'events.jsonl')
  const observer = readJson(path.join(runDir, 'observer.status.json'), null)
  const transcript = path.join(runDir, 'transcript.md')
  const view = {
    running: Boolean(current?.alive),
    runId,
    port: meta.port,
    preset: meta.preset,
    sessionId: meta.sessionId ?? null,
    model: meta.model ?? null,
    startedAt: meta.startedAt ?? null,
    pids: meta.pids ?? null,
    dshAlive: isPidAlive(meta.pids?.dsh),
    observerAlive: isPidAlive(meta.pids?.observer),
    observer: observer ? { connected: observer.connected, events: observer.events, turns: observer.turns, lastEventAt: observer.lastEventAt, lastError: observer.lastError } : null,
    events: readJsonl(eventsFile).length,
    turns: countTurnEnds(eventsFile),
    transcript: { file: transcript, exists: fs.existsSync(transcript), mtime: fs.existsSync(transcript) ? fs.statSync(transcript).mtime.toISOString() : null },
    runDir,
  }
  if (flag('--json')) { console.log(JSON.stringify(view, null, 2)); return }
  info(`${view.running ? '运行中' : '已退出'} · run=${runId} · preset=${meta.preset} · port=${meta.port} · session=${meta.sessionId ?? '?'}`)
  info(`模型：${meta.model?.provider ?? '?'} / ${meta.model?.model ?? '?'}（${meta.model?.source ?? '?'}）`)
  info(`进程：dsh ${view.dshAlive ? 'alive' : 'dead'}（pid ${meta.pids?.dsh ?? '?'}） · observer ${view.observerAlive ? 'alive' : 'dead'}（pid ${meta.pids?.observer ?? '?'}）`)
  if (view.observer) info(`observer：connected=${view.observer.connected} events=${view.observer.events} turns=${view.observer.turns}${view.observer.lastError ? ` lastError=${view.observer.lastError}` : ''}`)
  info(`事件：${view.events} · 回合：${view.turns}`)
  info(`transcript：${transcript}${view.transcript.exists ? '' : '（还没生成）'}`)
  info(`证据目录：${runDir}`)
}

function tail() {
  const run = requireRun()
  const lines = Number(arg('--lines', 80))
  const file = flag('--events') ? path.join(run.runDir, 'events.jsonl') : path.join(run.runDir, 'transcript.md')
  if (!fs.existsSync(file)) fail(`文件不存在：${file}`)
  const text = fs.readFileSync(file, 'utf8').trimEnd().split(/\r?\n/)
  console.log(text.slice(-lines).join('\n'))
}

function exportRun() {
  const run = requireRun()
  const out = rebuildTranscript(run.runDir)
  info(`transcript 已重建：${out.file}（${out.events} 事件）`)
  const stateDir = path.join(run.runDir, 'state', run.meta.preset)
  for (const file of [path.join(run.runDir, 'events.jsonl'), path.join(stateDir, 'session-events.jsonl'), path.join(run.runDir, 'lab.patch.yml')]) {
    if (fs.existsSync(file)) info(`  ${file}`)
  }
  console.log(JSON.stringify({ ok: true, runId: run.runId, transcript: out.file, events: out.events, runDir: run.runDir }, null, 2))
}

function logRun() {
  const run = requireRun()
  for (const name of ['dsh.err.log', 'dsh.out.log', 'observer.err.log', 'observer.out.log']) {
    const file = path.join(run.runDir, name)
    if (!fs.existsSync(file)) continue
    const text = logTail(file, Number(arg('--lines', 40)))
    if (!text) continue
    console.log(`===== ${name} =====`)
    console.log(text)
  }
}

/* ── 事件窗口（say/script 用）──────────────────────────── */

/** 从 events.jsonl 取有序事件（去重，按 seq）。 */
function orderedEvents(eventsFile) {
  const seen = new Set()
  const rows = []
  for (const envelope of readJsonl(eventsFile)) {
    const payload = envelope?.payload ?? envelope
    const push = (event) => {
      if (!event?.type) return
      if (event.seq != null) {
        if (seen.has(event.seq)) return
        seen.add(event.seq)
      }
      rows.push(event)
    }
    if (payload?.type === 'session/event') push(payload.event)
    else if (payload?.type === 'session/snapshot') for (const record of payload.snapshot?.records ?? []) if (record?.type === 'event') push(record.event)
  }
  return rows.sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0))
}

/** 最后一轮的窗口统计：不用 data.turn（user/message 上没有），而是从 turn/end 往前找 turn/start。 */
function lastTurnWindow(eventsFile) {
  const events = orderedEvents(eventsFile)
  let endIndex = -1
  for (let i = events.length - 1; i >= 0; i -= 1) if (events[i].type === 'turn/end') { endIndex = i; break }
  if (endIndex < 0) return null
  const end = events[endIndex]
  const turn = end.data?.turn
  let startIndex = -1
  for (let i = endIndex - 1; i >= 0; i -= 1) {
    if (events[i].type === 'turn/start' && events[i].data?.turn === turn) { startIndex = i; break }
  }
  const window = events.slice(Math.max(0, startIndex), endIndex + 1)
  const header = window.filter((event) => event.type === 'request/header').at(-1)?.data?.header ?? null
  const tools = Array.isArray(header?.tools) ? header.tools : null
  const systemChars = window.filter((event) => event.type === 'system/message')
    .reduce((n, event) => n + textOfMessage(event.data?.message).length, 0)
  const contextChars = window.filter((event) => event.type === 'user/message' && String(event.data?.source?.kind ?? 'user') === 'runtime-context')
    .reduce((n, event) => n + textOfMessage(event.data).length, 0)
  const iclContextChars = window.filter((event) => event.type === 'user/message' && String(event.data?.source?.kind ?? 'user') === 'runtime-context')
    .reduce((n, event) => n + (textOfMessage(event.data).trimStart().startsWith('<icl-context>') ? textOfMessage(event.data).length : 0), 0)
  let assistantText = ''
  for (const event of window) {
    if (event.type !== 'assistant/message') continue
    for (const block of event.data?.message?.content ?? []) if (block?.type === 'text') assistantText += block.text ?? ''
  }
  const calls = window.filter((event) => event.type === 'tool/call').map((event) => String(event.data?.name ?? ''))
  return {
    turn,
    start: window[0] ?? null,
    end,
    seqs: [window[0]?.seq ?? null, end.seq],
    tools: calls,
    assistant: assistantText,
    systemChars,
    contextChars,
    iclContextChars,
    request: header ? {
      provider: header.config?.provider,
      model: header.config?.model,
      tools: header.tools?.length ?? null,
      maxTokens: header.config?.maxTokens ?? null,
      toolsHash: tools ? createHash('sha1').update(JSON.stringify(tools)).digest('hex').slice(0, 12) : null,
      toolsChars: tools ? JSON.stringify(tools).length : null,
    } : null,
    events: window.length,
  }
}

/* ── say ──────────────────────────────────────────────── */

async function say() {
  const text = String(arg('--text', positionals().join(' '))).trim()
  if (!text) fail('用法：node tools/lab.mjs say "要说的话" [--wait]')
  const run = requireRun()
  if (!run.meta.sessionId) fail('run 没有 sessionId（up 没成功建会话）')
  const eventsFile = path.join(run.runDir, 'events.jsonl')
  const baseline = countTurnEnds(eventsFile)
  const api = apiFor(run.meta.port)
  await promptSession(api, run.meta.sessionId, text)
  info(`已投递 ${text.length} 字 → session ${run.meta.sessionId}`)
  if (!flag('--wait')) return
  const timeoutMs = Number(arg('--timeout', 300)) * 1000
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (countTurnEnds(eventsFile) > baseline) break
    if (!isPidAlive(run.meta.pids?.dsh)) fail('等待中 dsh 进程退出了；看 `node tools/lab.mjs log`')
    await sleep(300)
  }
  if (countTurnEnds(eventsFile) <= baseline) fail(`等 turn/end 超时（${timeoutMs / 1000}s）`)
  const window = lastTurnWindow(eventsFile)
  try { rebuildTranscript(run.runDir) } catch { /* observer 也会写 */ }
  const wall = ((Date.now() - started) / 1000).toFixed(1)
  info(`turn ${window?.turn} 结束（${wall}s，${window?.end?.data?.reason?.kind ?? '?'}）`)
  if (window?.tools?.length) info(`工具：${window.tools.join(', ')}`)
  info(`本轮体积：系统 ${window?.systemChars ?? 0} 字符 · 注入上下文 ${window?.contextChars ?? 0} 字符`)
  if (window?.assistant) console.log(`\n${window.assistant.trim()}\n`)
  console.log(JSON.stringify({ ok: true, turn: window?.turn, tools: window?.tools ?? [], turnEndSeq: window?.seqs?.[1] }, null, 2))
}

/* ── script（固定轮次，给 cache 做前缀测量用）──────────── */

async function script() {
  const run = requireRun()
  if (!run.meta.sessionId) fail('run 没有 sessionId')
  const file = arg('--file', null)
  let rounds = []
  if (file) {
    const data = readJson(path.resolve(String(file)), null)
    if (!data) fail(`读不到脚本文件：${file}`)
    rounds = Array.isArray(data) ? data : data.rounds ?? []
  }
  const count = Number(arg('--rounds', rounds.length || 10))
  if (!rounds.length) for (let i = 1; i <= count; i += 1) rounds.push({ id: `r${i}`, text: `第 ${i} 轮：简单聊一句你此刻在做什么。` })
  rounds = rounds.slice(0, count)
  const gapMs = Number(arg('--gap', '1')) * 1000
  const timeoutMs = Number(arg('--timeout', 300)) * 1000
  const eventsFile = path.join(run.runDir, 'events.jsonl')
  const roundsFile = path.join(run.runDir, 'rounds.jsonl')
  const api = apiFor(run.meta.port)
  info(`固定 ${rounds.length} 轮 → ${roundsFile}`)
  for (const round of rounds) {
    const baseline = countTurnEnds(eventsFile)
    const started = Date.now()
    await promptSession(api, run.meta.sessionId, String(round.text))
    while (Date.now() - started < timeoutMs) {
      if (countTurnEnds(eventsFile) > baseline) break
      if (!isPidAlive(run.meta.pids?.dsh)) fail('脚本等待中 dsh 进程退出')
      await sleep(300)
    }
    if (countTurnEnds(eventsFile) <= baseline) fail(`第 ${round.id ?? '?'} 轮等 turn/end 超时`)
    const window = lastTurnWindow(eventsFile)
    const row = {
      at: nowIso(),
      id: round.id ?? null,
      prompt: String(round.text),
      turn: window?.turn ?? null,
      turnMs: Date.now() - started,
      tools: window?.tools ?? [],
      systemChars: window?.systemChars ?? 0,
      contextChars: window?.contextChars ?? 0,
      iclContextChars: window?.iclContextChars ?? 0,
      request: window?.request ?? null,
      assistantChars: window?.assistant?.length ?? 0,
      turnEndSeq: window?.seqs?.[1] ?? null,
    }
    appendJsonl(roundsFile, row)
    console.log(`[lab] ${row.id} turn=${row.turn} ${row.turnMs}ms system=${row.systemChars} ctx=${row.contextChars} tools=[${row.tools.join(',')}] reply=${row.assistantChars}字`)
    if (gapMs) await sleep(gapMs)
  }
  try { rebuildTranscript(run.runDir) } catch { /* ignore */ }
  info(`完成；逐轮指标：${roundsFile}`)
  console.log(JSON.stringify({ ok: true, rounds: rounds.length, roundsFile }, null, 2))
}

function appendJsonl(file, row) {
  try { fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8') } catch { /* ignore */ }
}

/* ── dispatch ─────────────────────────────────────────── */

const commands = {
  up,
  down: () => down(),
  status,
  say,
  tail,
  export: exportRun,
  log: logRun,
  runs: () => {
    for (const row of listRuns()) console.log(`${row.runId}\t${row.status ?? '?'}\t${row.preset ?? ''}\t:${row.port ?? ''}\t${row.startedAt ?? ''}`)
  },
  script,
}

if (!cmd || !commands[cmd]) {
  console.error('用法：node tools/lab.mjs <up|down|status|say|tail|export|log|runs|script> [options]')
  process.exit(2)
}
await commands[cmd]()
