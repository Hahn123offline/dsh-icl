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
    try { db.close() } catch { /* ignore */ }
    return { rows, namespaces, bytes: fs.statSync(memoryDb).size }
  } catch (error) { return { error: String(error?.message ?? error), rows: [], namespaces: [] } }
}

function snapshot() {
  const at = nowIso()
  const mem = memoryRows()
  const rows = mem.rows ?? []
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
  const blockRows = rows.filter((row) => row.namespace !== 'dream-run' && row.namespace !== 'compaction')
  const lengths = blockRows.map((row) => String(row.text ?? '').length)
  // dream-run 指标
  const dreamRows = rows.filter((row) => row.namespace === 'dream-run' && row.kind === 'run')
  const dream = { runs: dreamRows.length, jobs: {}, failures: 0, days: {} }
  for (const row of dreamRows) {
    let data = {}
    try { data = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data ?? {}) } catch { data = {} }
    const job = /:(\w+)$/.exec(String(row.key ?? ''))?.[1] ?? String(row.key ?? '')
    dream.jobs[job] = (dream.jobs[job] ?? 0) + 1
    dream.days[job] = data
    if (data?.error) dream.failures += 1
  }
  const dayLog = rows.filter((row) => row.namespace === 'day' && row.kind === 'log')
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
    mem: { items: rows.length, bytes: mem.bytes ?? null, error: mem.error ?? null, byNs, dupRows, dupRate: rows.length ? Math.round((dupRows / rows.length) * 1000) / 1000 : null, blockChars: { p50: percentile(lengths, 50), p95: percentile(lengths, 95), p99: percentile(lengths, 99) } },
    dream: { runs: dream.runs, jobs: dream.jobs, failures: dream.failures, days: dream.days, dayLogRows: dayLog.length },
    recall: { calls: recallCalls.length, empty: emptyRecall, emptyRate: recallEmptyRate, avgResultChars: recallCalls.length ? Math.round(recallChars / recallCalls.length) : null, noiseHits, remember: rememberCalls.length, forget: forgetCalls.length, samples: recallSamples },
    eager: { injections: eagerEvents.length, chars: eagerChars },
    latency: { samples: latencies.length, p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
    events: { total: events.length, bodyRows: bodyRows.length, memoryEventBlocks: rows.filter((row) => row.namespace === 'event').length, dupSeq },
    anomalies,
  }
}

function renderReport(snap) {
  const lines = [`# 记忆质量快照 — ${snap.runId}`, '', `- 时间：${snap.at} · mode=${snap.mode} · memory.db=${snap.mem.bytes ?? '?'}B · items=${snap.mem.items}`, '']
  lines.push('## 指标', '', '| 指标 | 值 |', '|---|---|')
  lines.push(`| recall 调用/空结果率 | ${snap.recall.calls} / ${snap.recall.emptyRate ?? 'n/a'} |`)
  lines.push(`| recall 平均字符 / 噪声命中 | ${snap.recall.avgResultChars ?? 'n/a'} / ${snap.recall.noiseHits} |`)
  lines.push(`| remember / forget | ${snap.recall.remember} / ${snap.recall.forget} |`)
  lines.push(`| eager-recall 注入 | ${snap.eager.injections} 次 / ${snap.eager.chars} 字符 |`)
  lines.push(`| dream run/jobs/failures | ${snap.dream.runs} / ${JSON.stringify(snap.dream.jobs)} / ${snap.dream.failures} |`)
  lines.push(`| 记忆重复率 | ${snap.mem.dupRate ?? 'n/a'}（${snap.mem.dupRows} 行） |`)
  lines.push(`| 块大小 p50/p95/p99 | ${snap.mem.blockChars.p50 ?? 'n/a'} / ${snap.mem.blockChars.p95 ?? 'n/a'} / ${snap.mem.blockChars.p99 ?? 'n/a'} |`)
  lines.push(`| 事件→记忆延迟 p50/p95 | ${snap.latency.p50 ?? 'n/a'}ms / ${snap.latency.p95 ?? 'n/a'}ms（样本 ${snap.latency.samples}） |`)
  lines.push(`| 事件 total/body/memoryEventBlocks/dupSeq | ${snap.events.total}/${snap.events.bodyRows}/${snap.events.memoryEventBlocks}/${snap.events.dupSeq} |`)
  lines.push('', '## 按 namespace/kind', '')
  for (const [key, value] of Object.entries(snap.mem.byNs)) lines.push(`- \`${key}\`：${value.rows} 行 / ${value.chars} 字符 / recall_count=${value.recallCount}`)
  lines.push('', '## dream-run 明细', '')
  for (const [job, data] of Object.entries(snap.dream.days)) lines.push(`- ${job}: ${JSON.stringify(data).slice(0, 300)}`)
  lines.push('', '## 告警', '')
  if (!snap.anomalies.length) lines.push('- 无')
  else for (const item of snap.anomalies) lines.push(`- **${item.type}**：${JSON.stringify(item.value)}（阈值 ${item.threshold}）`)
  lines.push('', '## recall 样例', '')
  for (const sample of snap.recall.samples) lines.push(`- ${sample.at} empty=${sample.empty} chars=${sample.resultChars} args=${sample.args}\n  - ${sample.text}`)
  lines.push('', '## 说明', '', '- 只读观测；发现记忆成块问题按模块（memory / dream / eager-recall / lexicon）定位后报 misc/lead，不在本工具改代码。')
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
