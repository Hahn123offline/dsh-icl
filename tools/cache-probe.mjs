// 前缀缓存探针：把"本地模型每轮到底被重算了多少 token"变成可复跑的数字。
//
// 仪器（都是只读的，不需要重启 llama-swap / 不改 desktop）：
//   · NInfer 引擎的请求日志（--request-log-jsonl，见 /v1/models 的 args）：
//     每条 request_done 带 prompt_tokens / computed_prefill_tokens /
//     prefix_cache_hit_tokens / prefix_reuse_path / timings_seconds。
//     —— 这就是"前缀缓存命中/全量失效"的引擎侧事实，不用代理截包。
//   · 引擎 /metrics（llamacpp:*）：prompt_tokens_total 已排除复用前缀。
//   · 引擎 /slots：每条 lane 的 n_prompt_tokens / n_prompt_tokens_cache。
//   · DSH 会话事件日志（lab run 的 events.jsonl 或 ~/.dsh/sessions）：
//     system/message 全量文本 + 每步消息序列 —— 用来算"第一个差异字节在哪、
//     作废多少后缀"。
//
// 子命令：
//   node tools/cache-probe.mjs slots
//   node tools/cache-probe.mjs log [--tail 40] [--offset <bytes>] [--jsonl <out>]
//   node tools/cache-probe.mjs diff --run <runId>|--events <file>
//   node tools/cache-probe.mjs run --scenario tools/scenarios/cache-10.json --port 57104
//                               [--run cache-<name>] [--model local|flash] [--gap 1]
//                               [--no-down]
//   node tools/cache-probe.mjs report --run <runId>
//
// 关键口径：
//   · "全量失效" = 一条 request_done 里 prefix_cache_hit_tokens === 0 且
//     computed_prefill_tokens > 0（整段 prompt 重新 prefill）。
//   · "作废后缀" = 相邻两次系统提示词的首个差异字节之后的所有字节（system 段内）。
//   · prompt_tokens 是请求总 token（system+tools+messages 渲染后），工具面稳定时
//     它的增量就是新消息的 token。

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const STATE_ROOT = path.join(REPO_ROOT, '.state', 'lab')
const ENGINE_LOG = process.env.NINFER_LOG
  || 'C:/DSH/moe_streaming/logs/ninfer-coder390-q3-df2-4x500.requests.jsonl'
const ENGINE_BASE = process.env.NINFER_BASE || 'http://127.0.0.1:18122'
const LLAMA_BASE = process.env.LLAMA_SWAP_BASE || 'http://127.0.0.1:8088'

const arg = (name, fallback = null) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback }
const flag = (name) => process.argv.includes(name)

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir }

/* ── 引擎请求日志 ─────────────────────────────────────────── */

function logSize(file = ENGINE_LOG) {
  try { return fs.statSync(file).size } catch { return 0 }
}

/** 从字节偏移处读新增行（可给 end 限定字节范围；偏移落在行中间时丢掉残行）。 */
function readLogFrom(offset, file = ENGINE_LOG, end = null) {
  let fd
  try { fd = fs.openSync(file, 'r') } catch { return [] }
  try {
    const size = fs.fstatSync(fd).size
    const stop = end == null ? size : Math.min(size, end)
    if (offset >= stop) return []
    const length = stop - offset
    const buf = Buffer.allocUnsafe(length)
    fs.readSync(fd, buf, 0, length, offset)
    const rows = []
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.trim()) continue
      try { rows.push(JSON.parse(line)) } catch { /* 半行 */ }
    }
    return rows
  } finally { fs.closeSync(fd) }
}

function compactRequest(entry) {
  const request = entry.request ?? {}
  const result = entry.result ?? {}
  const timings = entry.timings_seconds ?? {}
  const materialization = entry.materialization ?? {}
  return {
    at: Number(entry.timestamp_unix_ms ?? 0) || null,
    atIso: entry.timestamp_unix_ms ? new Date(Number(entry.timestamp_unix_ms)).toISOString() : null,
    requestId: request.request_id ?? null,
    model: request.model ?? null,
    messageCount: request.message_count ?? null,
    toolCount: request.tool_count ?? null,
    protocol: request.protocol ?? null,
    stream: request.stream ?? null,
    promptTokens: result.prompt_tokens ?? null,
    prefillTokens: result.computed_prefill_tokens ?? null,
    cacheHitTokens: result.prefix_cache_hit_tokens ?? null,
    reusePath: result.prefix_reuse_path ?? null,
    completionTokens: result.completion_tokens ?? null,
    finishReason: result.finish_reason ?? null,
    prefillSeconds: timings.prefill ?? null,
    ttftSeconds: timings.ttft ?? null,
    decodeSeconds: timings.decode ?? null,
    totalSeconds: timings.total ?? null,
    // materialization 是 NInfer 的 KVMem 决策面：cached_prefix_tokens / best_reuse_prompt_tokens
    materializedReuse: materialization.best_reuse_prompt_tokens ?? null,
    materializedCached: materialization.cached_prefix_tokens ?? null,
    stopReason: materialization.stop_reason ?? null,
  }
}

function doneRecords(entries) {
  return entries.filter((entry) => entry?.event === 'request_done').map(compactRequest)
}

function isFullInvalidation(row) {
  return Number(row.prefillTokens) > 0 && Number(row.cacheHitTokens) === 0
}

function summarize(rows) {
  const usable = rows.filter((row) => Number(row.promptTokens) > 0)
  const invalidated = usable.filter(isFullInvalidation)
  const prompt = usable.reduce((sum, row) => sum + Number(row.promptTokens ?? 0), 0)
  const prefilled = usable.reduce((sum, row) => sum + Number(row.prefillTokens ?? 0), 0)
  const hit = usable.reduce((sum, row) => sum + Number(row.cacheHitTokens ?? 0), 0)
  const ttfts = usable.map((row) => Number(row.ttftSeconds ?? 0)).filter((x) => x > 0)
  return {
    requests: usable.length,
    fullInvalidations: invalidated.length,
    fullInvalidationShare: usable.length ? +(invalidated.length / usable.length).toFixed(3) : 0,
    promptTokens: prompt,
    prefilledTokens: prefilled,
    cacheHitTokens: hit,
    hitShare: prompt ? +(hit / prompt).toFixed(3) : 0,
    prefillSeconds: +usable.reduce((sum, row) => sum + Number(row.prefillSeconds ?? 0), 0).toFixed(2),
    avgTtftSeconds: ttfts.length ? +(ttfts.reduce((a, b) => a + b, 0) / ttfts.length).toFixed(2) : null,
    maxTtftSeconds: ttfts.length ? +Math.max(...ttfts).toFixed(2) : null,
  }
}

function printLogTable(rows, { limit = 80 } = {}) {
  console.log(['#', 'time', 'msg', 'tools', 'prompt', 'prefill', 'hit', 'hit%', 'ttft_s', 'pref_s', 'path', 'finish'].join('\t'))
  for (const [index, row] of rows.slice(-limit).entries()) {
    console.log([
      index + 1,
      String(row.atIso ?? '').slice(11, 19),
      row.messageCount ?? '?',
      row.toolCount ?? '?',
      row.promptTokens ?? '?',
      row.prefillTokens ?? '?',
      row.cacheHitTokens ?? '?',
      Number(row.promptTokens) ? `${Math.round((Number(row.cacheHitTokens ?? 0) / Number(row.promptTokens)) * 100)}%` : '?',
      row.ttftSeconds == null ? '?' : Number(row.ttftSeconds).toFixed(2),
      row.prefillSeconds == null ? '?' : Number(row.prefillSeconds).toFixed(2),
      row.reusePath ?? '?',
      row.finishReason ?? '',
    ].join('\t'))
  }
  console.log('\n' + JSON.stringify(summarize(rows), null, 1))
}

/* ── DSH 事件 → 每步系统提示词/消息序列 ───────────────────── */

function* readEventFile(file) {
  const text = fs.readFileSync(file, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    // lab 的 events.jsonl 包了一层 {payload:{type:'session/event', event}}；
    // 直接拷出来的会话文件是裸事件。
    const payload = row?.payload ?? row
    if (payload?.type === 'session/event' && payload.event) yield payload.event
    else if (payload?.type) yield payload
  }
}

function messageText(message) {
  const content = message?.content
  if (!content) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => (typeof part === 'string' ? part : part?.text || '')).filter(Boolean).join('\n')
}

/**
 * 从事件流重建每步的模型可见输入：
 *   system —— 当前生效的系统提示词（多个 system 节点按 seq 拼；replace 会改写对应节点）
 *   messages —— surface 顺序的消息（user/assistant/tool）
 * 同时记录本步 system 事件是 append 还是 replace，以及是本步第几次 system 更新。
 */
function reconstructSteps(events) {
  const systemNodes = new Map()
  const surface = new Map()
  const steps = []
  let current = null
  for (const event of events) {
    const type = event?.type
    if (type === 'step/start') {
      current = { turn: event.data?.turn ?? null, step: event.data?.step ?? null, systemUpdates: [], messages: [] }
      continue
    }
    if (!current) continue
    if (type === 'system/message') {
      const message = event.data?.message ?? event.data
      const text = messageText(message)
      const op = event.surfaceOp
      const replaceTarget = op && typeof op === 'object' && op.op === 'replace' ? (op.startSeq ?? op.seq ?? event.seq) : null
      if (replaceTarget != null) {
        // DSH 的 replace 把**那个 surface 节点**换成新 event：节点身份 = 最新 event seq。
        // 所以先删旧 key，再以本 event.seq 存新文本（否则后续 replace 链会堆成多份 system）。
        systemNodes.delete(replaceTarget)
        systemNodes.set(event.seq, text)
        current.systemUpdates.push({ seq: event.seq, mode: 'replace', target: replaceTarget, chars: text.length })
      } else {
        systemNodes.set(event.seq, text)
        current.systemUpdates.push({ seq: event.seq, mode: 'append', target: event.seq, chars: text.length })
      }
    } else if (type === 'user/message' || type === 'assistant/message' || type === 'tool/result') {
      const data = event.data ?? {}
      const message = data.message ?? data
      const op = event.surfaceOp
      const entry = {
        seq: event.seq,
        type,
        role: message?.role ?? (type === 'tool/result' ? 'tool' : type === 'user/message' ? 'user' : 'assistant'),
        source: message?.source?.kind ?? null,
        chars: messageText(message).length,
        text: messageText(message),
      }
      if (op && typeof op === 'object' && op.op === 'replace') {
        const start = op.startSeq ?? op.seq
        const end = op.endSeq ?? start
        for (const seq of [...surface.keys()]) if (seq >= start && seq <= end) surface.delete(seq)
        surface.set(event.seq, entry)
      } else {
        surface.set(event.seq, entry)
      }
    } else if (type === 'step/end') {
      current.system = [...systemNodes.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text).filter(Boolean).join('\n\n')
      current.messages = [...surface.values()].sort((a, b) => a.seq - b.seq).map(({ seq, role, source, chars }) => ({ seq, role, source, chars }))
      current.messageChars = [...surface.values()].reduce((sum, entry) => sum + entry.chars, 0)
      steps.push(current)
      current = null
    }
  }
  return steps
}

function byteLength(text) { return Buffer.byteLength(String(text ?? ''), 'utf8') }

function firstDiff(a, b) {
  const limit = Math.min(a.length, b.length)
  for (let i = 0; i < limit; i += 1) if (a[i] !== b[i]) return i
  return a.length === b.length ? -1 : limit
}

/** 已知的 ICL 段起点，用来把差异定位到"谁的段"（不依赖行号）。 */
const SECTION_MARKERS = [
  ['persona', '你是小千。'],
  ['sim', '这份说明讲的是'],
  ['time', '时间：现在是'],
  ['world', '世界状态'],
  ['focus', '专注'],
  ['mc', 'MC'],
]

function markerAt(system, charIndex) {
  let best = null
  for (const [name, marker] of SECTION_MARKERS) {
    const at = system.indexOf(marker)
    if (at >= 0 && at <= charIndex && (!best || at > best.at)) best = { name, at }
  }
  return best?.name ?? null
}

/* ── lab run 集成 ─────────────────────────────────────────── */

function runDirOf(runId) { return path.join(STATE_ROOT, runId) }
function labCurrent() {
  try { return JSON.parse(fs.readFileSync(path.join(STATE_ROOT, 'current.json'), 'utf8')) } catch { return null }
}
function listRuns() {
  try {
    return fs.readdirSync(STATE_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(STATE_ROOT, entry.name, 'lab.json')))
      .map((entry) => ({ runId: entry.name, ...JSON.parse(fs.readFileSync(path.join(STATE_ROOT, entry.name, 'lab.json'), 'utf8')) }))
      .sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')))
  } catch { return [] }
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}

function eventsPath(runId) { return path.join(runDirOf(runId), 'events.jsonl') }

/** 每个 lab run 的每步 system 文本/消息数；相邻 step 的前缀 diff。 */
function diffRun(runId) {
  const steps = reconstructSteps([...readEventFile(eventsPath(runId))])
  const rows = []
  let prev = null
  for (const [index, step] of steps.entries()) {
    const system = step.system ?? ''
    const systemBytes = byteLength(system)
    let row = {
      index: index + 1,
      turn: step.turn,
      step: step.step,
      systemChars: system.length,
      systemBytes,
      messageCount: step.messages.length,
      messageChars: step.messageChars,
      systemUpdates: step.systemUpdates,
    }
    if (prev) {
      const at = firstDiff(prev.system, system)
      row.prevSystemChars = prev.system.length
      row.firstDiffChar = at
      row.firstDiffByte = at < 0 ? -1 : byteLength(system.slice(0, at))
      row.invalidatedSuffixBytes = at < 0 ? 0 : byteLength(system.slice(at))
      row.diffMarker = at < 0 ? null : markerAt(system, at)
      // 消息序列：追加才是缓存友好的；改写/删除会破坏前缀
      row.messagePrefix = commonMessagePrefix(prev.messages, step.messages)
      row.messagesAdded = step.messages.length - row.messagePrefix
    } else {
      row.prevSystemChars = null
      row.firstDiffChar = null
      row.firstDiffByte = null
      row.invalidatedSuffixBytes = systemBytes
      row.diffMarker = null
      row.messagePrefix = 0
      row.messagesAdded = step.messages.length
    }
    row.systemHash = createHash('sha1').update(system).digest('hex').slice(0, 12)
    rows.push(row)
    prev = { system, messages: step.messages }
  }
  return rows
}

function commonMessagePrefix(prev, next) {
  let i = 0
  while (i < prev.length && i < next.length && prev[i].seq === next[i].seq) i += 1
  return i
}

/** 把引擎请求按时间窗切给每轮（lab rounds.jsonl 的 [at, at+turnMs]）。 */
function joinRounds(runId, engineRows) {
  const rounds = readJsonl(path.join(runDirOf(runId), 'rounds.jsonl'))
  const steps = reconstructSteps([...readEventFile(eventsPath(runId))])
  return rounds.map((round) => {
    // rounds.jsonl 的 `at` 是**这一轮结束后**落盘的时间，所以窗口是 [at-turnMs, at]。
    const end = Date.parse(round.at) + 500
    const start = end - Number(round.turnMs ?? 0) - 1000
    const window = engineRows.filter((row) => row.at != null && row.at >= start && row.at <= end)
    const promptRows = window.filter((row) => Number(row.toolCount ?? 0) > 0)
    const titleRows = window.filter((row) => Number(row.toolCount ?? 0) === 0)
    const step = steps.find((s) => s.turn === round.turn) ?? null
    return {
      id: round.id,
      turn: round.turn,
      turnMs: round.turnMs,
      systemChars: round.systemChars,
      systemBytes: step ? byteLength(step.system ?? '') : null,
      systemUpdates: step?.systemUpdates ?? [],
      contextChars: round.contextChars ?? 0,
      iclContextChars: round.iclContextChars ?? 0,
      promptTokens: promptRows.reduce((sum, row) => sum + Number(row.promptTokens ?? 0), 0),
      prefillTokens: promptRows.reduce((sum, row) => sum + Number(row.prefillTokens ?? 0), 0),
      cacheHitTokens: promptRows.reduce((sum, row) => sum + Number(row.cacheHitTokens ?? 0), 0),
      ttftSeconds: promptRows.length ? Math.max(...promptRows.map((row) => Number(row.ttftSeconds ?? 0))) : null,
      prefillSeconds: promptRows.reduce((sum, row) => sum + Number(row.prefillSeconds ?? 0), 0),
      engineRequests: promptRows.length,
      fullInvalidation: promptRows.some(isFullInvalidation),
      titleCalls: titleRows.length,
      messageCount: step?.messages.length ?? null,
      tools: round.tools ?? [],
    }
  })
}

/** 第一次 request/header 里的工具面指纹：工具名+描述+参数规范化后哈希。 */
function toolsFingerprint(runId) {
  for (const event of readEventFile(eventsPath(runId))) {
    if (event?.type !== 'request/header') continue
    const header = event.data?.header ?? event.data ?? {}
    const tools = header.tools ?? []
    if (!Array.isArray(tools) || !tools.length) continue
    const canonical = tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    const json = JSON.stringify(canonical)
    return {
      count: tools.length,
      chars: json.length,
      hash: createHash('sha1').update(json).digest('hex').slice(0, 12),
      names: tools.map((tool) => tool.name).sort(),
    }
  }
  return null
}

function printRoundTable(rows) {
  console.log(['round', 'turn', 'turnMs', 'sysB', 'sysUpdates', 'ctxCh', 'prompt', 'prefill', 'hit', 'hit%', 'ttft_s', 'fullInv', 'engineReq'].join('\t'))
  for (const row of rows) {
    console.log([
      row.id ?? '?',
      row.turn ?? '?',
      row.turnMs ?? '?',
      row.systemBytes ?? '?',
      (row.systemUpdates ?? []).map((update) => `${update.mode}:${update.chars}`).join(',') || '-',
      row.contextChars ?? '?',
      row.promptTokens,
      row.prefillTokens,
      row.cacheHitTokens,
      row.promptTokens ? `${Math.round((row.cacheHitTokens / row.promptTokens) * 100)}%` : '?',
      row.ttftSeconds == null ? '?' : Number(row.ttftSeconds).toFixed(2),
      row.fullInvalidation ? 'YES' : '-',
      row.engineRequests,
    ].join('\t'))
  }
  const agg = {
    rounds: rows.length,
    fullInvalidationRounds: rows.filter((row) => row.fullInvalidation).length,
    promptTokens: rows.reduce((sum, row) => sum + row.promptTokens, 0),
    prefilledTokens: rows.reduce((sum, row) => sum + row.prefillTokens, 0),
    cacheHitTokens: rows.reduce((sum, row) => sum + row.cacheHitTokens, 0),
    prefillSeconds: +rows.reduce((sum, row) => sum + row.prefillSeconds, 0).toFixed(2),
  }
  agg.hitShare = agg.promptTokens ? +(agg.cacheHitTokens / agg.promptTokens).toFixed(3) : 0
  console.log('\n' + JSON.stringify(agg, null, 1))
  return agg
}

/* ── 子命令 ───────────────────────────────────────────────── */

async function httpJson(url, { method = 'GET', body = null, timeoutMs = 15000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await response.text()
    try { return { ok: response.ok, status: response.status, json: JSON.parse(text) } } catch { return { ok: response.ok, status: response.status, text } }
  } finally { clearTimeout(timer) }
}

async function cmdSlots() {
  const slots = await httpJson(`${ENGINE_BASE}/slots`)
  const metrics = await httpJson(`${ENGINE_BASE}/metrics`)
  console.log(JSON.stringify(slots.json, null, 1))
  if (typeof metrics.text === 'string') {
    const keep = metrics.text.split('\n').filter((line) => /llamacpp:(prompt_tokens_total|prompt_seconds_total|predicted_tokens_seconds|kv_cache_usage_ratio|n_decode_total)/.test(line))
    console.log(keep.join('\n'))
  } else if (metrics.json) {
    console.log(JSON.stringify(metrics.json).slice(0, 1200))
  }
}

function cmdLog() {
  const tail = Number(arg('--tail', '40'))
  const offset = arg('--offset', null)
  let rows
  if (offset != null) {
    rows = doneRecords(readLogFrom(Number(offset)))
  } else {
    const size = logSize()
    const sliceBytes = Number(arg('--bytes', String(4 * 1024 * 1024)))
    rows = doneRecords(readLogFrom(Math.max(0, size - sliceBytes))).slice(-tail)
  }
  const jsonl = arg('--jsonl', null)
  if (jsonl) {
    ensureDir(path.dirname(path.resolve(jsonl)))
    fs.writeFileSync(path.resolve(jsonl), rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
    console.log(`wrote ${rows.length} rows → ${jsonl}`)
  }
  printLogTable(rows, { limit: rows.length })
}

function resolveRunId() {
  return arg('--run', null) ?? labCurrent()?.runId ?? listRuns()[0]?.runId ?? null
}

async function cmdDiff() {
  const runId = resolveRunId()
  if (!runId) throw new Error('没有 lab run；先 node tools/lab.mjs up')
  const rows = diffRun(runId)
  const jsonl = arg('--jsonl', path.join(runDirOf(runId), 'cache-diff.jsonl'))
  fs.writeFileSync(jsonl, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
  console.log(['#', 'turn', 'step', 'sysCh', 'sysB', 'msgs', 'msgCh', 'firstDiff', 'invalSuffixB', 'marker', 'msgPrefix', 'updates'].join('\t'))
  for (const row of rows) {
    console.log([
      row.index, row.turn, row.step, row.systemChars, row.systemBytes, row.messageCount, row.messageChars,
      row.firstDiffChar == null ? '?' : row.firstDiffChar,
      row.invalidatedSuffixBytes == null ? '?' : row.invalidatedSuffixBytes,
      row.diffMarker ?? '-',
      row.messagePrefix,
      row.systemUpdates.map((update) => `${update.mode}:${update.chars}`).join(','),
    ].join('\t'))
  }
  console.log(`\nwrote ${rows.length} steps → ${jsonl}`)
}

async function cmdRun() {
  const { spawnSync } = await import('node:child_process')
  const scenario = arg('--scenario', 'tools/scenarios/cache-10.json')
  const port = Number(arg('--port', '57104'))
  const model = String(arg('--model', 'local'))
  const gap = String(arg('--gap', '1'))
  const roundsArg = arg('--rounds', null)
  const runId = String(arg('--run', `cache-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`))
  const runDir = runDirOf(runId)
  const offsetBefore = logSize()
  const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout?.trim() ?? null
  const record = {
    runId,
    port,
    model,
    scenario,
    commit,
    factsInSystem: process.env.ICL_FACTS_IN_SYSTEM === '1',
    factsEveryStep: process.env.ICL_FACTS_EVERY_STEP === '1',
    startedAt: new Date().toISOString(),
    offsetBefore,
    engineLog: ENGINE_LOG,
    steps: [],
  }
  const run = (args) => {
    const result = spawnSync('node', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'inherit' })
    if (result.status !== 0) throw new Error(`命令失败（${result.status}）：node ${args.join(' ')}`)
  }
  try {
    run(['tools/lab.mjs', 'up', '--preset', 'icl-lab', '--port', String(port), '--run', runId, '--model', model])
    run(['tools/lab.mjs', 'script', '--file', scenario, '--gap', gap, ...(roundsArg ? ['--rounds', roundsArg] : []), '--port', String(port)])
    run(['tools/lab.mjs', 'export', '--port', String(port)])
  } finally {
    if (!flag('--no-down')) {
      try { run(['tools/lab.mjs', 'down', '--port', String(port)]) } catch { /* 停不掉也要把已有证据落盘 */ }
    }
  }
  record.offsetAfter = logSize()
  record.engineRows = doneRecords(readLogFrom(offsetBefore))
  record.tools = toolsFingerprint(runId)
  record.rounds = joinRounds(runId, record.engineRows)
  record.steps = diffRun(runId)
  record.summary = summarize(record.engineRows.filter((row) => Number(row.toolCount ?? 0) > 0))
  record.roundSummary = printRoundTable(record.rounds)
  ensureDir(runDir)
  fs.writeFileSync(path.join(runDir, 'cache-probe.json'), JSON.stringify(record, null, 1), 'utf8')
  fs.writeFileSync(path.join(runDir, 'cache-probe-engine.jsonl'), record.engineRows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
  console.log(`\ncommit=${record.commit} factsInSystem=${record.factsInSystem} tools=${record.tools?.count ?? '?'} hash=${record.tools?.hash ?? '?'}`)
  console.log(`证据：${path.join(runDir, 'cache-probe.json')}`)
}

async function cmdReport() {
  const runId = resolveRunId()
  const file = path.join(runDirOf(runId), 'cache-probe.json')
  if (!fs.existsSync(file)) throw new Error(`没有 ${file}；先跑 node tools/cache-probe.mjs run`)
  const record = JSON.parse(fs.readFileSync(file, 'utf8'))
  console.log(`# run ${record.runId} model=${record.model}`)
  console.log(`## 引擎侧请求（tool-bearing only）`)
  printLogTable(record.engineRows.filter((row) => Number(row.toolCount ?? 0) > 0))
  console.log(`## 每轮`)
  printRoundTable(record.rounds)
  console.log(`## 系统提示词 diff（首个差异 / 作废后缀）`)
  for (const step of record.steps) {
    console.log([step.index, `t${step.turn}s${step.step}`, `${step.systemBytes}B`, `firstDiff=${step.firstDiffChar ?? '?'}`, `suffix=${step.invalidatedSuffixBytes ?? '?'}B`, step.diffMarker ?? '-', `msgPrefix=${step.messagePrefix}/${step.messageCount}`].join('\t'))
  }
}

/** 从一次 lab run 里取"真实 payload"：第一步的系统提示词全文 + 第一次 request/header 的工具面。 */
function realPayload(runId) {
  const events = [...readEventFile(eventsPath(runId))]
  const steps = reconstructSteps(events)
  const system = steps[0]?.system ?? ''
  let tools = null
  for (const event of events) {
    if (event?.type !== 'request/header') continue
    const header = event.data?.header ?? event.data ?? {}
    if (Array.isArray(header.tools) && header.tools.length) { tools = header.tools; break }
  }
  return {
    system,
    tools: tools ? tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    })) : null,
    toolCount: tools?.length ?? 0,
    systemChars: system.length,
    systemBytes: byteLength(system),
  }
}

async function cmdApi() {
  // 裸 API 对照：不经过 DSH，直接构造"每轮末尾追加一条用户消息"的多轮前缀。
  // 三种变体：
  //   stable     —— 系统提示词完全不变（理论最优）
  //   tailclock  —— 系统提示词尾部带每轮变化的事实（ICL 旧布局）
  //   headclock  —— 事实放在系统提示词开头（模拟 focus order 15 的旧 bug）
  //   facts-tail —— 优化 B：系统完全静态，事实作为尾部 runtime-context 消息
  // 用 --from-run <labRunId> 可以拿某次 lab 的真实 system 文本与工具 schema 做（更接近线上）。
  const turns = Number(arg('--turns', '5'))
  const filler = String(arg('--filler', 'x')).repeat(Number(arg('--filler-chars', '4000')))
  const maxTokens = Number(arg('--max-tokens', '8'))
  const fromRun = arg('--from-run', null)
  const real = fromRun ? realPayload(fromRun) : null
  const includeTools = !flag('--no-tools')
  const tools = includeTools
    ? (real?.tools ?? Array.from({ length: 6 }, (_, index) => ({
      type: 'function',
      function: {
        name: `probe_tool_${index}`,
        description: 'probe tool for prefix-cache measurement; stable schema across turns',
        parameters: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false },
      },
    })))
    : undefined
  // 每轮都真的变：只用时钟分钟会在 <1 分钟的短测试里假阴性（第一版踩过）。
  const dynamicChars = Number(arg('--dynamic-chars', '0'))
  const clock = (turn) => `2026-11-05 18:${String(20 + turn).padStart(2, '0')}:${String((turn * 17) % 60).padStart(2, '0')}`
  const dynamicBlock = (turn) => {
    const head = `时间：${clock(turn)}；阶段：醒着；下一个安排：dream:nightly（wake/single，2026-11-05 23:00）；进行中的目标：无；积压：0 条。`
    if (dynamicChars <= 0) return head
    return head + ' ' + `第${turn}轮状态`.padEnd(dynamicChars, '·')
  }
  // tailclock = ICL 现状（动态事实在系统提示词尾部）；headclock = 旧 focus order 15；
  // facts-tail = 优化 B（动态事实完全移出系统提示词，只作为尾部消息）。
  const variants = {
    stable: () => ({ system: real ? real.system : `You are a stable prefix probe. filler:${filler}\nsession-fixed.` }),
    tailclock: (turn) => ({ system: `${real ? real.system : `You are a stable prefix probe. filler:${filler}`}\n${dynamicBlock(turn)}` }),
    headclock: (turn) => ({ system: `${dynamicBlock(turn)}\n${real ? real.system : `You are a stable prefix probe. filler:${filler}`}` }),
    // 优化 B：系统提示词整场静态；动态事实作为"运行时上下文"消息追加在本轮用户消息之后。
    'facts-tail': (turn) => ({
      system: real ? real.system : `You are a stable prefix probe. filler:${filler}\nsession-fixed.`,
      after: [`<runtime-context>\n${dynamicBlock(turn)}\n</runtime-context>`],
    }),
  }
  const messages = [{ role: 'user', content: '开始。' }, { role: 'assistant', content: '好。' }]
  if (real) console.log(`# real payload from ${fromRun}: systemChars=${real.systemChars} systemBytes=${real.systemBytes} tools=${real.toolCount}`)
  console.log(['variant', 'turn', 'prompt', 'prefill', 'hit', 'hit%', 'ttft_s', 'prefill_s'].join('\t'))
  for (const [name, planOf] of Object.entries(variants)) {
    const history = [...messages]
    let prev = null
    for (let turn = 1; turn <= turns; turn += 1) {
      const plan = planOf(turn)
      history.push({ role: 'user', content: `第 ${turn} 轮：只回复 ok。` })
      for (const extra of plan.after ?? []) history.push({ role: 'user', content: extra })
      const offset = logSize()
      const response = await httpJson(`${LLAMA_BASE}/v1/chat/completions`, {
        method: 'POST',
        timeoutMs: 180000,
        body: {
          model: process.env.NINFER_MODEL || 'coder390-27b-q3-df2-4x500',
          messages: [{ role: 'system', content: plan.system }, ...history],
          ...(tools ? { tools } : {}),
          max_tokens: maxTokens,
          temperature: 0,
          stream: false,
        },
      })
      if (!response.ok) throw new Error(`API 失败 ${response.status}: ${JSON.stringify(response.json ?? response.text).slice(0, 300)}`)
      const text = response.json?.choices?.[0]?.message?.content ?? ''
      history.push({ role: 'assistant', content: String(text) })
      await new Promise((resolve) => setTimeout(resolve, 300))
      const rows = doneRecords(readLogFrom(offset)).filter((row) => Number(row.toolCount ?? 0) === (tools ? tools.length : 0))
      const row = rows.at(-1) ?? {}
      console.log([name, turn, row.promptTokens ?? '?', row.prefillTokens ?? '?', row.cacheHitTokens ?? '?',
        Number(row.promptTokens) ? `${Math.round((Number(row.cacheHitTokens ?? 0) / Number(row.promptTokens)) * 100)}%` : '?',
        row.ttftSeconds == null ? '?' : Number(row.ttftSeconds).toFixed(2),
        row.prefillSeconds == null ? '?' : Number(row.prefillSeconds).toFixed(2)].join('\t'))
      prev = row
    }
    if (!prev) console.log(`${name}\t(no requests)`)
  }
}

/** 不跑 GPU，重算一次已有 run 的指标（改了解析逻辑/时间窗之后用）。 */
async function cmdRebuild() {
  const runId = resolveRunId()
  const file = path.join(runDirOf(runId), 'cache-probe.json')
  if (!fs.existsSync(file)) throw new Error(`没有 ${file}；先跑 node tools/cache-probe.mjs run`)
  const record = JSON.parse(fs.readFileSync(file, 'utf8'))
  record.engineRows = doneRecords(readLogFrom(record.offsetBefore, ENGINE_LOG, record.offsetAfter ?? null))
  record.tools = toolsFingerprint(runId)
  record.rounds = joinRounds(runId, record.engineRows)
  record.steps = diffRun(runId)
  record.summary = summarize(record.engineRows.filter((row) => Number(row.toolCount ?? 0) > 0))
  record.roundSummary = printRoundTable(record.rounds)
  console.log(`## 系统提示词 diff`)
  for (const step of record.steps) {
    console.log([`t${step.turn}s${step.step}`, `${step.systemBytes}B`, `firstDiff=${step.firstDiffChar ?? '?'}`, `suffix=${step.invalidatedSuffixBytes ?? '?'}B`, step.diffMarker ?? '-', `msgPrefix=${step.messagePrefix}/${step.messageCount}`, step.systemUpdates.map((u) => `${u.mode}:${u.chars}`).join(',') || '-'].join('\t'))
  }
  fs.writeFileSync(file, JSON.stringify(record, null, 1), 'utf8')
  fs.writeFileSync(path.join(runDirOf(runId), 'cache-probe-engine.jsonl'), record.engineRows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
  console.log(`\n重建：${file}`)
}

/** facts 快照统计（DSH 层）：快照条数/字符，以及 system 更新方式。 */
function factsSnapshotStats(runId) {
  const events = [...readEventFile(eventsPath(runId))]
  let snapshots = 0
  let snapshotChars = 0
  let systemAppends = 0
  let systemReplaces = 0
  let systemChars = 0
  for (const event of events) {
    if (event?.type === 'system/message') {
      const text = messageText(event.data?.message ?? event.data)
      systemChars = text.length
      const op = event.surfaceOp
      if (op && typeof op === 'object' && op.op === 'replace') systemReplaces += 1
      else systemAppends += 1
    }
    if (event?.type === 'user/message') {
      const message = event.data?.message ?? event.data
      if (message?.source?.kind !== 'runtime-context') continue
      const text = messageText(message)
      snapshots += 1
      snapshotChars += text.length
    }
  }
  return { snapshots, snapshotChars, systemAppends, systemReplaces, systemChars }
}

function engineStats(record) {
  const rows = (record.engineRows ?? []).filter((row) => Number(row.toolCount ?? 0) > 0)
  const full = rows.filter((row) => Number(row.prefillTokens) > 0 && Number(row.cacheHitTokens) === 0)
  const prompt = rows.reduce((sum, row) => sum + Number(row.promptTokens ?? 0), 0)
  const prefill = rows.reduce((sum, row) => sum + Number(row.prefillTokens ?? 0), 0)
  const hit = rows.reduce((sum, row) => sum + Number(row.cacheHitTokens ?? 0), 0)
  const ttfts = rows.map((row) => Number(row.ttftSeconds ?? 0)).filter((x) => x > 0)
  return {
    requests: rows.length,
    fullInvalidations: full.length,
    promptTokens: prompt,
    prefilledTokens: prefill,
    cacheHitTokens: hit,
    hitShare: prompt ? +(hit / prompt).toFixed(3) : null,
    avgTtftSeconds: ttfts.length ? +(ttfts.reduce((a, b) => a + b, 0) / ttfts.length).toFixed(2) : null,
    maxTtftSeconds: ttfts.length ? +Math.max(...ttfts).toFixed(2) : null,
    prefillSeconds: +rows.reduce((sum, row) => sum + Number(row.prefillSeconds ?? 0), 0).toFixed(2),
  }
}

async function cmdCompare() {
  const ids = [arg('--a', null), arg('--b', null)]
  if (!ids[0] || !ids[1]) throw new Error('compare 需要 --a <runId> --b <runId>')
  const runs = ids.map((id) => {
    const file = path.join(runDirOf(id), 'cache-probe.json')
    if (!fs.existsSync(file)) throw new Error('没有 ' + file + '；先跑 cache-probe run')
    const record = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { id, record, engine: engineStats(record), snap: factsSnapshotStats(id) }
  })
  const [a, b] = runs
  const row = (label, va, vb) => console.log([label, va, vb].join('\t'))
  console.log(['指标', a.id, b.id].join('\t'))
  row('commit', a.record.commit ?? '?', b.record.commit ?? '?')
  row('factsEveryStep', String(Boolean(a.record.factsEveryStep)), String(Boolean(b.record.factsEveryStep)))
  row('tools / hash', (a.record.tools?.count ?? '?') + ' / ' + (a.record.tools?.hash ?? '?'), (b.record.tools?.count ?? '?') + ' / ' + (b.record.tools?.hash ?? '?'))
  row('system append / replace', a.snap.systemAppends + ' / ' + a.snap.systemReplaces, b.snap.systemAppends + ' / ' + b.snap.systemReplaces)
  row('system chars（最后一份）', a.snap.systemChars, b.snap.systemChars)
  row('facts 快照条数', a.snap.snapshots, b.snap.snapshots)
  row('facts 快照字符合计', a.snap.snapshotChars, b.snap.snapshotChars)
  row('engine 请求数', a.engine.requests, b.engine.requests)
  row('全量失效请求数', a.engine.fullInvalidations, b.engine.fullInvalidations)
  row('prompt tokens 合计', a.engine.promptTokens, b.engine.promptTokens)
  row('prefill tokens 合计', a.engine.prefilledTokens, b.engine.prefilledTokens)
  row('cache hit tokens 合计', a.engine.cacheHitTokens, b.engine.cacheHitTokens)
  row('hit%', a.engine.hitShare == null ? '?' : (a.engine.hitShare * 100).toFixed(1) + '%', b.engine.hitShare == null ? '?' : (b.engine.hitShare * 100).toFixed(1) + '%')
  row('prefill 秒合计', a.engine.prefillSeconds + 's', b.engine.prefillSeconds + 's')
  row('TTFT 均值/最大', a.engine.avgTtftSeconds + ' / ' + a.engine.maxTtftSeconds, b.engine.avgTtftSeconds + ' / ' + b.engine.maxTtftSeconds)
  const out = arg('--out', null)
  if (out) {
    fs.writeFileSync(path.resolve(out), JSON.stringify({ generatedAt: new Date().toISOString(), runs }, null, 1), 'utf8')
    console.log('wrote ' + out)
  }
}

const commands = { slots: cmdSlots, log: cmdLog, diff: cmdDiff, run: cmdRun, rebuild: cmdRebuild, report: cmdReport, api: cmdApi, compare: cmdCompare }

async function main() {
  const command = process.argv[2]
  if (command === '--help' || command === '-h' || command === 'help') {
    console.log('用法：node tools/cache-probe.mjs <slots|log|diff|run|rebuild|report|api|compare> [options]')
    console.log('  slots   引擎 /slots + 关键 /metrics 指标')
    console.log('  log     引擎请求日志（--tail / --offset / --jsonl）')
    console.log('  diff    从 DSH 事件流重建每步 system diff（--run）')
    console.log('  run     一键跑 lab A/B（--scenario / --model / --gap / --rounds / --run）')
    console.log('  rebuild 不跑 GPU 重算已有 run 的指标')
    console.log('  report  打印已有 run 的报告')
    console.log('  api     裸 API 前缀实验（--from-run 用真实 payload）')
    console.log('  compare 两个 run 的节流/布局 A/B 对表（--a / --b）')
    return
  }
  if (!commands[command]) {
    console.error('用法：node tools/cache-probe.mjs <slots|log|diff|run|report|api|compare> [options]')
    process.exit(2)
  }
  await commands[command]()
}

main().catch((error) => { console.error('失败：', String(error?.stack ?? error)); process.exit(1) })
