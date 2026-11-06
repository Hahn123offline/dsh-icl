// E2 记忆质量监控：观测"真实事件 → 记忆成块"的质量（只读，不改记忆代码）。
// 用法：
//   node tools/mc-quality.mjs --dir .state/lab/e2-<date> --once        # 离线复盘（写 quality.jsonl/quality-report.md）
//   node tools/mc-quality.mjs --run e2-<date> --interval 60             # 在线随跑（append quality.jsonl）
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { readJson, readJsonl, runDirOf, sleep, nowIso } from './lab-lib.mjs'

const require = createRequire(import.meta.url)

function arg(name, fallback = null) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback }
const once = process.argv.includes('--once')
const dirArg = arg('--dir')
const runId = arg('--run')
const intervalSec = Math.max(10, Number(arg('--interval', 60)))
const threshold = {
  recallMinCalls: Number(arg('--recall-min-calls', 5)),
  recallEmptyRate: Number(arg('--recall-empty-rate', 0.6)),
  dupRate: Number(arg('--dup-rate', 0.2)),
  growthPerHour: Number(arg('--growth-per-hour', 60)),
  latencyP95Ms: Number(arg('--latency-p95-ms', 300000)),
  blockCharsP50: Number(arg('--block-p50', 20)),
  blockCharsP95: Number(arg('--block-p95', 1200)),
}
const runDir = dirArg ? path.resolve(dirArg) : runDirOf(String(runId ?? 'e2'))
const preset = arg('--preset', 'icl-mc-lab')
const stateDir = path.join(runDir, 'state', preset)
const memoryDb = path.join(stateDir, 'state', 'memory.db')
const eventsFile = path.join(runDir, 'events.jsonl')
const bodyFile = path.join(runDir, 'state', 'mc-body', 'body.jsonl')
const qualityFile = path.join(runDir, 'quality.jsonl')
const summaryFile = path.join(runDir, 'quality-summary.json')
const reportFile = path.join(runDir, 'quality-report.md')

function percentile(values, p) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}
function sha1(text) {
  return require('node:crypto').createHash('sha1').update(String(text)).digest('hex').slice(0, 16)
}
function failsToSource(unmatched, modelJobRan) {
  if (unmatched.length) return 'inferred:dream-fail-rows'
  if (modelJobRan) return 'inferred:model-jobs-ran'
  return 'unknown'
}
function normalizeText(text) { return String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase() }
function readEvents() {
  if (!fs.existsSync(eventsFile)) return []
  return readJsonl(eventsFile).map((envelope) => (envelope?.payload?.type === 'session/event' ? envelope.payload.event : null)).filter(Boolean)
}
function memoryRows() {
  if (!fs.existsSync(memoryDb)) return { error: 'memory.db 不存在', rows: [], namespaces: [] }
  let DatabaseSync = null
  try { ({ DatabaseSync } = require('node:sqlite')) } catch { return { error: 'node:sqlite 不可用', rows: [], namespaces: [] } }
  try {
    const db = new DatabaseSync(memoryDb, { readOnly: true })
    const namespaces = db.prepare('select id,label,recallable,owner from mem_ns').all()
    const rows = db.prepare('select id,namespace,kind,key,text,data,weight,recall_count,last_recalled_at,created_at,updated_at from mem_items').all()
    let vectors = 0
    try { vectors = Number(db.prepare('select count(*) as c from mem_vec').get().c ?? 0) } catch { /* 旧库可能无 mem_vec */ }
    try { db.close() } catch { /* ignore */ }
    return { rows, namespaces, vectors, bytes: fs.statSync(memoryDb).size }
  } catch (error) { return { error: String(error?.message ?? error), rows: [], namespaces: [] } }
}

function snapshot() {
  const at = nowIso()
  const mem = memoryRows()
  const rows = mem.rows ?? []
  const recallableNs = new Set((mem.namespaces ?? []).filter((ns) => Number(ns.recallable) === 1).map((ns) => String(ns.id)))
  const byNs = {}
  for (const row of rows) {
    const key = `${row.namespace}/${row.kind}`
    byNs[key] = byNs[key] ?? { rows: 0, chars: 0, recallCount: 0 }
    byNs[key].rows += 1
    byNs[key].chars += String(row.text ?? '').length
    byNs[key].recallCount += Number(row.recall_count ?? 0)
  }
  const dupGroups = {}
  for (const row of rows) {
    const key = `${row.namespace}/${row.kind}/${sha1(normalizeText(row.text))}`
    dupGroups[key] = (dupGroups[key] ?? 0) + 1
  }
  const dupRows = Object.values(dupGroups).reduce((sum, count) => sum + Math.max(0, count - 1), 0)
  // 按 MEMORY-BLOCK-QUALITY §3.2/§4：
  //   可回忆块 = event/person/slang 的 kind='block'（blockChars 只统计这些）；
  //   day/* 是 wash 原料；dream-run/* 是运行记录；consume 走"备忘回收"，都不算块。
  const blockRows = rows.filter((row) => ['event', 'person', 'slang'].includes(String(row.namespace)) && String(row.kind) === 'block')
  const lengths = blockRows.map((row) => String(row.text ?? '').length)
  const rawRows = rows.filter((row) => String(row.namespace) === 'day')
  const noteRows = rows.filter((row) => String(row.namespace) === 'event' && String(row.kind) === 'note')
  // dream-run 指标（三态：run:/fail:/skip: 行；见 MEMORY-BLOCK-QUALITY §3.0/§4）
  const dreamRows = rows.filter((row) => row.namespace === 'dream-run' && row.kind === 'run')
  const dream = { runs: 0, jobs: {}, failures: 0, days: {}, failRows: [], skipRows: [] }
  for (const row of dreamRows) {
    const key = String(row.key ?? '')
    const job = /:(\w+)$/.exec(key)?.[1] ?? key
    let data = {}
    try { data = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data ?? {}) } catch { data = {} }
    const state = /^fail:/.test(key) ? 'failed' : /^skip:/.test(key) ? 'skipped' : 'ran'
    dream.jobs[job] = dream.jobs[job] ?? { ran: 0, skipped: 0, failed: 0, reasons: [], errors: [] }
    dream.jobs[job][state] += 1
    if (state === 'failed') { dream.failures += 1; dream.jobs[job].errors.push(String(data.error ?? 'unknown').slice(0, 160)); dream.failRows.push({ job, at: new Date(Number(row.created_at)).toISOString(), error: String(data.error ?? '') }) }
    if (state === 'skipped') { dream.jobs[job].reasons.push(String(data.skipped ?? 'unknown')); dream.skipRows.push({ job, at: new Date(Number(row.created_at)).toISOString(), skipped: String(data.skipped ?? '') }) }
    if (state === 'ran') { dream.runs += 1; dream.days[job] = data }
  }
  // consume 归"备忘回收"，不计入成块
  const consumeData = dream.days.consume ?? {}
  const memoRecycle = { written: Number(consumeData.written ?? 0), archived: Number(consumeData.archived ?? 0) }
  // 槽健康：优先从 dream fail 行推断 "插槽 X 还没有绑定模型"；有模型 job 成功行则视为已绑定。
  const unmatched = []
  for (const fail of dream.failRows) {
    const hit = /插槽\s*([^\s，。]+)\s*还没有绑定模型/.exec(fail.error)
    if (hit && !unmatched.includes(hit[1])) unmatched.push(hit[1])
  }
  const modelJobs = ['events', 'people', 'lexicon', 'cleanup']
  const modelJobRan = modelJobs.some((job) => (dream.jobs[job]?.ran ?? 0) > 0)
  const slots = { unmatched, embedded: null, source: failsToSource(unmatched, modelJobRan), modelJobRan }
  const indexRow = dream.days.index ?? null
  if (indexRow && indexRow.skipped === 'no-embed') slots.embedded = false
  else if (indexRow && Number(indexRow.indexed ?? 0) + Number(indexRow.missing ?? 0) > 0) slots.embedded = true
  else if (mem.vectors != null) slots.embedded = Number(mem.vectors) > 0
  const dayLog = rawRows.filter((row) => String(row.kind) === 'log')
  // events 侧 recall / remember / eager
  const events = readEvents()
  const calls = events.filter((event) => event.type === 'tool/call')
  const results = events.filter((event) => event.type === 'tool/result')
  const recallCalls = calls.filter((call) => String(call.data?.name ?? '') === 'recall')
  const rememberCalls = calls.filter((call) => String(call.data?.name ?? '') === 'remember')
  const forgetCalls = calls.filter((call) => String(call.data?.name ?? '') === 'forget')
  const resultOf = (call) => results.find((row) => row.data?.toolCallId === call.data?.callId || row.data?.message?.toolCallId === call.data?.callId)
  const recallSamples = []
  let emptyRecall = 0
  let recallChars = 0
  let noiseHits = 0
  for (const call of recallCalls) {
    const text = String(resultOf(call)?.data?.message?.content?.[0]?.text ?? '')
    const argsText = typeof call.data?.arguments === 'string' ? call.data.arguments : JSON.stringify(call.data?.arguments ?? {})
    const query = (/"(?:query|q|text)"\s*:\s*"([^"]+)"/.exec(argsText)?.[1] ?? '').toLowerCase()
    recallChars += text.length
    const isEmpty = text.trim().length <= 8 || /(没有|没找到|未找到|no .*found|empty)/i.test(text)
    if (isEmpty) emptyRecall += 1
    const lines = text.split('\n').filter((line) => line.trim())
    const noisy = lines.filter((line) => line.length > 12 && query && !line.toLowerCase().includes(query)).length
    if (noisy > 0) noiseHits += 1
    if (recallSamples.length < 5) recallSamples.push({ at: new Date(Number(call.time)).toISOString(), args: argsText.slice(0, 120), resultChars: text.length, empty: isEmpty, text: text.replace(/\n/g, ' ').slice(0, 200) })
  }
  const eagerEvents = events.filter((event) => JSON.stringify(event.data ?? {}).includes('<icl-context>'))
  const eagerChars = eagerEvents.reduce((sum, event) => sum + JSON.stringify(event.data ?? {}).length, 0)
  // latency：remember 调用 → 之后首个 memory 行 created_at（ms）；dream consume → 之后首个非 dream-run 行
  const latencies = []
  for (const call of rememberCalls) {
    const callAt = Number(call.time)
    const candidate = rows.filter((row) => Number(row.created_at) >= callAt).sort((a, b) => Number(a.created_at) - Number(b.created_at))[0]
    if (candidate) latencies.push(Number(candidate.created_at) - callAt)
  }
  const consumeRow = dreamRows.find((row) => /:consume$/.test(String(row.key ?? '')))
  if (consumeRow) {
    const consumeAt = Number(consumeRow.created_at)
    const block = rows.filter((row) => Number(row.created_at) > consumeAt && row.namespace !== 'dream-run').sort((a, b) => Number(a.created_at) - Number(b.created_at))[0]
    if (block) latencies.push(Number(block.created_at) - consumeAt)
  }
  const anomalies = []
  const recallEmptyRate = recallCalls.length ? emptyRecall / recallCalls.length : null
  if (recallCalls.length >= threshold.recallMinCalls && recallEmptyRate > threshold.recallEmptyRate) anomalies.push({ type: 'recall-empty-rate', value: recallEmptyRate, threshold: threshold.recallEmptyRate })
  if (rows.length && dupRows / rows.length > threshold.dupRate) anomalies.push({ type: 'memory-dup-rate', value: dupRows / rows.length, threshold: threshold.dupRate })
  if (blockRows.length >= 10 && percentile(lengths, 50) < threshold.blockCharsP50) anomalies.push({ type: 'memory-blocks-too-small', value: percentile(lengths, 50), threshold: threshold.blockCharsP50 })
  if (blockRows.length >= 10 && percentile(lengths, 95) > threshold.blockCharsP95) anomalies.push({ type: 'memory-block-too-large', value: percentile(lengths, 95), threshold: threshold.blockCharsP95 })
  if (latencies.length && percentile(latencies, 95) > threshold.latencyP95Ms) anomalies.push({ type: 'event-to-memory-latency', value: percentile(latencies, 95), threshold: threshold.latencyP95Ms })
  const bodyRows = fs.existsSync(bodyFile) ? readJsonl(bodyFile) : []
  const dupSeq = (() => {
    const seen = new Set()
    let dup = 0
    for (const event of events) { if (event.seq == null) continue; if (seen.has(event.seq)) dup += 1; else seen.add(event.seq) }
    return dup
  })()
  return {
    at,
    runId: runId ?? path.basename(runDir),
    mode: once ? 'offline' : 'live',
    mem: {
      items: rows.length,
      bytes: mem.bytes ?? null,
      error: mem.error ?? null,
      byNs,
      vectors: mem.vectors ?? null,
      dupRows,
      dupRate: rows.length ? Math.round((dupRows / rows.length) * 1000) / 1000 : null,
      /** 可回忆块（event/person/slang 的 block）；原料/运行记录/consume 不计入（MEMORY-BLOCK-QUALITY §3.2）。 */
      blockChars: { count: blockRows.length, p50: percentile(lengths, 50), p95: percentile(lengths, 95), p99: percentile(lengths, 99) },
      rawMaterial: { items: rawRows.length, chars: rawRows.reduce((sum, row) => sum + String(row.text ?? '').length, 0) },
      pendingNotes: noteRows.length,
    },
    dream: { runs: dream.runs, jobs: dream.jobs, failures: dream.failures, days: dream.days, dayLogRows: dayLog.length, failRows: dream.failRows, skipRows: dream.skipRows, memoRecycle },
    slots,
    recall: { calls: recallCalls.length, empty: emptyRecall, emptyRate: recallEmptyRate, avgResultChars: recallCalls.length ? Math.round(recallChars / recallCalls.length) : null, noiseHits, remember: rememberCalls.length, forget: forgetCalls.length, samples: recallSamples },
    eager: { injections: eagerEvents.length, chars: eagerChars },
    latency: { samples: latencies.length, p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
    events: { total: events.length, bodyRows: bodyRows.length, memoryEventBlocks: blockRows.filter((row) => String(row.namespace) === 'event').length, memoryEventNotes: noteRows.length, dupSeq },
    anomalies,
  }
}

function renderReport(snap) {
  const lines = [`# 记忆质量快照 — ${snap.runId}`, '', `- 时间：${snap.at} · mode=${snap.mode} · memory.db=${snap.mem.bytes ?? '?'}B · items=${snap.mem.items}（可回忆块 ${snap.mem.blockChars.count} / 原料 ${snap.mem.rawMaterial.items} / 待整理 note ${snap.mem.pendingNotes}）`, '']
  lines.push('## 指标', '', '| 指标 | 值 |', '|---|---|')
  lines.push(`| 可回忆块 p50/p95/p99（event/person/slang block） | ${snap.mem.blockChars.p50 ?? 'n/a'} / ${snap.mem.blockChars.p95 ?? 'n/a'} / ${snap.mem.blockChars.p99 ?? 'n/a'}（${snap.mem.blockChars.count} 块） |`)
  lines.push(`| 原料 day/log（不计入块大小） | ${snap.mem.rawMaterial.items} 条 / ${snap.mem.rawMaterial.chars} 字符 |`)
  lines.push(`| dream job 三态 ran/skipped/failed | ${JSON.stringify(snap.dream.jobs)} |`)
  lines.push(`| dream failures / fail 行 / skip 行 | ${snap.dream.failures} / ${snap.dream.failRows.length} / ${snap.dream.skipRows.length} |`)
  lines.push(`| 备忘回收 consume（不计块） | written=${snap.dream.memoRecycle.written} archived=${snap.dream.memoRecycle.archived} |`)
  lines.push(`| 槽健康 slots.unmatched / embedded | ${JSON.stringify(snap.slots.unmatched)} / ${snap.slots.embedded ?? 'n/a'}（${snap.slots.source}） |`)
  lines.push(`| recall 调用/空结果率 | ${snap.recall.calls} / ${snap.recall.emptyRate ?? 'n/a'} |`)
  lines.push(`| recall 平均字符 / 噪声命中 | ${snap.recall.avgResultChars ?? 'n/a'} / ${snap.recall.noiseHits} |`)
  lines.push(`| remember / forget | ${snap.recall.remember} / ${snap.recall.forget} |`)
  lines.push(`| eager-recall 注入 | ${snap.eager.injections} 次 / ${snap.eager.chars} 字符 |`)
  lines.push(`| 记忆重复率 | ${snap.mem.dupRate ?? 'n/a'}（${snap.mem.dupRows} 行） |`)
  lines.push(`| 事件→记忆延迟 p50/p95 | ${snap.latency.p50 ?? 'n/a'}ms / ${snap.latency.p95 ?? 'n/a'}ms（样本 ${snap.latency.samples}） |`)
  lines.push(`| 事件 total/body/event block/event note/dupSeq | ${snap.events.total}/${snap.events.bodyRows}/${snap.events.memoryEventBlocks}/${snap.events.memoryEventNotes}/${snap.events.dupSeq} |`)
  lines.push('', '## 按 namespace/kind', '')
  for (const [key, value] of Object.entries(snap.mem.byNs)) lines.push(`- \`${key}\`：${value.rows} 行 / ${value.chars} 字符 / recall_count=${value.recallCount}`)
  lines.push('', '## dream-run 明细', '')
  for (const [job, data] of Object.entries(snap.dream.days)) lines.push(`- ${job}: ${JSON.stringify(data).slice(0, 300)}`)
  if (snap.dream.failRows.length) { lines.push('', '### fail 行', ''); for (const row of snap.dream.failRows.slice(0, 12)) lines.push(`- ${row.at} ${row.job}: ${row.error}`) }
  if (snap.dream.skipRows.length) { lines.push('', '### skip 行', ''); for (const row of snap.dream.skipRows.slice(0, 12)) lines.push(`- ${row.at} ${row.job}: skipped=${row.skipped}`) }
  lines.push('', '## 告警', '')
  if (!snap.anomalies.length) lines.push('- 无')
  else for (const item of snap.anomalies) lines.push(`- **${item.type}**：${JSON.stringify(item.value)}（阈值 ${item.threshold}）`)
  lines.push('', '## recall 样例', '')
  for (const sample of snap.recall.samples) lines.push(`- ${sample.at} empty=${sample.empty} chars=${sample.resultChars} args=${sample.args}\n  - ${sample.text}`)
  lines.push('', '## 说明', '', '- 只读观测；块指标只统计**可回忆块**（event/person/slang 的 block），day/dream-run/consume 不计入（见 docs/MEMORY-BLOCK-QUALITY.md §3.2/§4）；槽健康由 dream fail 行与模型 job 成功行推断（优先读 icl.ready.slots.unmatched，日志不可得时标注 inferred）。发现记忆成块问题按模块（memory / dream / eager-recall / lexicon）定位后报 misc/lead，不在本工具改代码。')
  return `${lines.join('\n')}\n`
}

function sleepSync(ms) { const end = Date.now() + ms; while (Date.now() < end) { /* busy-ish for offline no-op */ } }

async function main() {
  fs.mkdirSync(runDir, { recursive: true })
  let last = null
  const loop = async () => {
    const snap = snapshot()
    fs.appendFileSync(qualityFile, `${JSON.stringify(snap)}\n`)
    fs.writeFileSync(summaryFile, JSON.stringify(snap, null, 2))
    fs.writeFileSync(reportFile, renderReport(snap))
    if (last) {
      const hours = Math.max(1 / 60, (Date.parse(snap.at) - Date.parse(last.at)) / 3600000)
      snap.mem.growthPerHour = Math.round(((snap.mem.items - last.mem.items) / hours) * 10) / 10
    }
    if (snap.anomalies.length) console.log(`[quality] ${snap.at} alarms=${snap.anomalies.map((item) => item.type).join(',')} items=${snap.mem.items} recall=${snap.recall.calls}`)
    else console.log(`[quality] ${snap.at} items=${snap.mem.items} dreamRuns=${snap.dream.runs} recall=${snap.recall.calls} eager=${snap.eager.injections}`)
    last = snap
    return snap
  }
  await loop()
  if (!once) {
    console.log(`[quality] 在线监控 ${runDir}，间隔 ${intervalSec}s（Ctrl-C 退出）`)
    for (;;) { await sleep(intervalSec * 1000); try { await loop() } catch (error) { console.log(`[quality] 快照失败：${String(error?.message ?? error)}`) } }
  }
}

main().catch((error) => { console.error(`[quality] 异常：${String(error?.stack ?? error)}`); process.exit(1) })
