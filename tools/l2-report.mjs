// L2 段报告生成：从 runDir 过滤段窗口，按 TEST-PRINCIPLES 顺序输出（当事人原话→结论→metrics→证据）。
// 用法：node tools/l2-report.mjs --run l2-20261107-s1 --segment s0001 [--checkpoint .state/lab/.../checkpoints/s0001] [--replay replay.json]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
function arg(name, fallback = null) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : fallback }
function readJson(file, fallback = null) { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback } }
function readJsonl(file) { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean) } catch { return [] } }
function pct(values, p) { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] : null }
function textOf(event) {
  const direct = event?.data?.content?.[0]?.text
  if (direct) return String(direct)
  const blocks = event?.data?.message?.content
  if (Array.isArray(blocks)) return blocks.filter((block) => block?.type === 'text').map((block) => String(block.text ?? '')).join('\n')
  return ''
}
function sayText(call) { const match = String(call?.data?.arguments ?? '').match(/"text"\s*:\s*"([^"]*)"/); return match ? match[1] : '' }

const runId = String(arg('--run', ''))
const segmentId = String(arg('--segment', 's0001'))
if (!runId) { console.error('用法：node tools/l2-report.mjs --run <runId> --segment s0001 [--checkpoint dir] [--replay file]'); process.exit(2) }
const runDir = path.join(REPO_ROOT, '.state', 'lab', runId)
const runMeta = readJson(path.join(runDir, 'lab.json'), {})
const startMs = Date.parse(String(arg('--start', runMeta.startedAt ?? '')))
if (!Number.isFinite(startMs)) { console.error('无法解析 run start'); process.exit(2) }
const rawEvents = readJsonl(path.join(runDir, 'events.jsonl')).map((row) => row.payload?.event).filter(Boolean)
const events = rawEvents.filter((event) => Number(event.time) >= startMs)
const rawBody = readJsonl(path.join(runDir, 'state', 'mc-body', 'body.jsonl'))
const body = rawBody.filter((row) => Number(row.at) >= startMs)
const calls = events.filter((event) => event.type === 'tool/call')
const assistants = events.filter((event) => event.type === 'assistant/message')
const sayCalls = calls.filter((call) => /"op"\s*:\s*"say"/.test(String(call.data?.arguments ?? '')))
const sayTexts = sayCalls.map(sayText).filter(Boolean)
const assistantTexts = assistants.map(textOf).filter((text) => text.trim() && !text.startsWith('mcb_'))
const quoteFreq = {}
for (const text of [...sayTexts, ...assistantTexts]) quoteFreq[text] = (quoteFreq[text] ?? 0) + 1
const quoteSeq = new Map()
for (const event of [...sayCalls, ...assistants]) {
  const text = event.type === 'tool/call' ? sayText(event) : textOf(event)
  if (text && !quoteSeq.has(text)) quoteSeq.set(text, { seq: event.seq, type: event.type })
}
const quotes = Object.entries(quoteFreq).sort((left, right) => right[1] - left[1]).slice(0, 6).map(([text, count]) => ({ text, count, ...(quoteSeq.get(text) ?? { seq: '?', type: '?' }) })).filter((item) => item.text.trim())
const deaths = body.filter((row) => row.type === 'death').length
const taskStarted = body.filter((row) => row.type === 'task_started')
const taskDone = body.filter((row) => row.type === 'task_done')
const taskFailed = body.filter((row) => row.type === 'task_failed')
const taskCancelled = body.filter((row) => row.type === 'task_cancelled')
const shelterStarts = taskStarted.filter((row) => row.data?.task?.kind === 'shelter')
const shelterFails = taskFailed.filter((row) => row.data?.task?.kind === 'shelter')
const shelterIncomplete = body.filter((row) => row.type === 'shelter_incomplete')
const homeSet = body.filter((row) => row.type === 'home_set')
const pathStuck = body.filter((row) => row.type === 'path_stuck')
const autoDefense = body.filter((row) => row.type === 'auto_defense')
const cancelledForDefense = body.filter((row) => row.type === 'task_cancelled_for_defense')
// ── 证据完整性（lead 审计 P0：events 覆盖/seq 回绕/重启代数/commit）────────────
const eventSeqs = rawEvents.map((event) => Number(event.seq)).filter(Number.isFinite)
const sessionFirst = rawEvents[0] ?? null
const sessionLast = rawEvents.at(-1) ?? null
const bodySeqs = rawBody.map((row) => Number(row.seq)).filter(Number.isFinite)
const segmentBodySeqs = body.map((row) => Number(row.seq)).filter(Number.isFinite)
const countWraps = (seqs) => seqs.reduce((wraps, seq, index) => (index > 0 && seq < seqs[index - 1] ? wraps + 1 : wraps), 0)
const labMeta = readJson(path.join(runDir, 'lab.json'), {})
const statusData = readJson(path.join(runDir, 'status.json'), {})
const checkpointRoot = path.join(runDir, 'checkpoint')
const generations = fs.existsSync(checkpointRoot) ? fs.readdirSync(checkpointRoot).filter((name) => name.startsWith('lab-gen-')) : []
const generationCommits = generations.map((name) => readJson(path.join(checkpointRoot, name, 'lab.json'), {})?.commit).filter(Boolean)
const commitsSeen = [...new Set([labMeta.commit, ...generationCommits].filter(Boolean))]
const evidenceIssues = []
if (sessionFirst && Number(sessionFirst.time) > startMs + 120_000) evidenceIssues.push(`events 起始晚于段开始 ${Math.round((Number(sessionFirst.time) - startMs) / 1000)}s（可能截断）`)
if (!sessionFirst) evidenceIssues.push('events 为空（无证据）')
if (!segmentBodySeqs.length) evidenceIssues.push('body 事件窗口为空')
if (Number(statusData.labStarts ?? 0) > 1 || generations.length > 1) evidenceIssues.push(`段内 lab 重启：labStarts=${statusData.labStarts ?? '?'} generations=${generations.length}（不纯净）`)
if (commitsSeen.length > 1) evidenceIssues.push(`段内 commit 切换：${commitsSeen.join(' → ')}`)
const segmentWraps = countWraps(segmentBodySeqs)
const globalWraps = countWraps(bodySeqs)
const segmentBodyDistinct = new Set(segmentBodySeqs).size
const bodyDuplicates = segmentBodySeqs.length - segmentBodyDistinct
const bodySpawns = body.filter((row) => row.type === 'spawn').length
const bodyLedgerLoads = body.filter((row) => row.type === 'ledger_loaded').length
const bodyOffline = body.filter((row) => row.type === 'offline').length
if (bodyDuplicates > 0) evidenceIssues.push(`body seq 重复：rows=${segmentBodySeqs.length} distinct=${segmentBodyDistinct}（ledger 重放/重复落盘，引用需按 distinct）`)
if (bodyLedgerLoads > 1) evidenceIssues.push(`body ledger_loaded=${bodyLedgerLoads} 次（body 进程/ledger 重载，段不纯净）`)
// ── 任务尝试分桶（taskId + 来源；不沿用"91 次"的旧结论）─────────────────────
const ledger = readJson(path.join(runDir, 'state', 'mc-body', 'tasks.json'), { tasks: [] })
const segmentTasks = (ledger.tasks ?? []).filter((task) => Number(task.createdAt ?? 0) >= startMs || Number(task.finishedAt ?? 0) >= startMs)
const shelterTasks = segmentTasks.filter((task) => task.kind === 'shelter')
const shelterToolCalls = calls.filter((call) => String(call.data?.name ?? '') === 'mcb_shelter').length
const shelterViaDoCalls = calls.filter((call) => String(call.data?.name ?? '') === 'mcb_do' && /"kind"\s*:\s*"shelter"/.test(String(call.data?.arguments ?? ''))).length
const turnEnds = events.filter((event) => event.type === 'turn/end')
const turnStarts = events.filter((event) => event.type === 'turn/start')
const gaps = []
for (const end of turnEnds) { const next = turnStarts.find((start) => Number(start.time) > Number(end.time)); if (next) gaps.push(Math.round((Number(next.time) - Number(end.time)) / 1000)) }
const stepToTool = []
for (const assistant of assistants) { const next = calls.find((call) => Number(call.time) > Number(assistant.time)); if (next) stepToTool.push(Number(next.time) - Number(assistant.time)) }
const minutes = Math.max(1, (Date.now() - startMs) / 60_000)
const issues = []
if (deaths > 2) issues.push(`死亡 ${deaths} 次（>2/段）`)
if (sayTexts.length > 10) issues.push(`say ${sayTexts.length} 次（刷屏风险）`)
for (const quote of quotes.slice(0, 3)) if (quote.count >= 3) issues.push(`同句重复 ${quote.count} 次：seq ${quote.seq} "${quote.text.slice(0, 40)}"`)
if (shelterFails.length >= 2) issues.push(`shelter 连续失败 ${shelterFails.length} 次`)
if (shelterIncomplete.length && !homeSet.length) issues.push('shelter_incomplete 且无 home_set')
if (pathStuck.length > 5) issues.push(`path_stuck ${pathStuck.length} 次`)
if (autoDefense.length && !cancelledForDefense.length) issues.push('auto_defense 未取消任务')
for (const issue of evidenceIssues) issues.push(`证据完整性：${issue}`)

const checkpoint = arg('--checkpoint')
const replayFile = arg('--replay')
const replay = replayFile ? readJson(path.resolve(replayFile)) : null
const verdict = !issues.length && (!replay || replay.pass) ? 'PASS' : 'FAIL'
const lines = []
lines.push(`# L2 ${segmentId} 报告（${runId}）`)
lines.push('')
lines.push('## 1. 当事人原话（TEST-PRINCIPLES：先引原话）')
lines.push('')
if (!quotes.length) lines.push('- （本段未捕获第一人称文本；补 transcript/assistant 事件后再判定）')
for (const quote of quotes) lines.push(`- seq ${quote.seq} [${quote.type}]："${quote.text.replace(/\n/g, ' ').slice(0, 180)}"${quote.count > 1 ? `（重复 ${quote.count} 次）` : ''}`)
lines.push('')
lines.push('## 2. 结论')
lines.push('')
lines.push(`- verdict：**${verdict}**${issues.length ? `；问题：${issues.join('；')}` : ''}`)
lines.push(`- 段时长约 ${minutes.toFixed(0)}min；turns ${turnEnds.length}；say ${sayTexts.length}；death ${deaths}；shelter ${shelterStarts.length} 起/${shelterFails.length} 败；path_stuck ${pathStuck.length}`)
lines.push('')
lines.push('## 3. Metrics')
lines.push('')
lines.push('| 指标 | 值 |')
lines.push('|---|---|')
lines.push(`| turns | ${turnEnds.length} |`)
lines.push(`| tool calls | ${calls.length} |`)
lines.push(`| deaths | ${deaths} |`)
lines.push(`| say / 同句最多 | ${sayTexts.length} / ${quotes[0]?.count ?? 0} |`)
lines.push(`| task done/failed | ${taskDone.length} / ${taskFailed.length} |`)
lines.push(`| shelter start/fail | ${shelterStarts.length} / ${shelterFails.length} |`)
lines.push(`| shelter_incomplete / home_set | ${shelterIncomplete.length} / ${homeSet.length} |`)
lines.push(`| path_stuck | ${pathStuck.length} |`)
lines.push(`| auto_defense / cancelled_for_defense | ${autoDefense.length} / ${cancelledForDefense.length} |`)
lines.push(`| turn-gap p50/p95/max | ${pct(gaps, 50) ?? '-'} / ${pct(gaps, 95) ?? '-'} / ${gaps.length ? Math.max(...gaps) : '-'} s |`)
lines.push(`| assistant→tool p50/p95 | ${stepToTool.length ? pct(stepToTool, 50) : '-'} / ${stepToTool.length ? pct(stepToTool, 95) : '-'} ms |`)
lines.push(`| task 尝试（ledger，去重 taskId） | ${segmentTasks.length}（shelter ${shelterTasks.length}） |`)
lines.push(`| shelter 来源 | mcb_shelter=${shelterToolCalls} · mcb_do task=${shelterViaDoCalls} |`)
lines.push('')
lines.push('## 4. 证据完整性（gate：不过则本段不算 PASS）')
lines.push('')
lines.push('| 项 | 值 |')
lines.push('|---|---|')
lines.push(`| session events 覆盖 | ${sessionFirst ? `${new Date(Number(sessionFirst.time)).toISOString()}（seq ${sessionFirst.seq}）` : '-'} → ${sessionLast ? `${new Date(Number(sessionLast.time)).toISOString()}（seq ${sessionLast.seq}）` : '-'} |`)
lines.push(`| events 条数 / 段内 seq 范围 | ${rawEvents.length} / ${eventSeqs.length ? `${Math.min(...eventSeqs)}–${Math.max(...eventSeqs)}` : '-'} |`)
lines.push(`| body 事件（段内） | rows=${body.length} distinctSeq=${segmentBodyDistinct} duplicates=${bodyDuplicates} seqWraps=${segmentWraps} spawn=${bodySpawns} ledgerLoaded=${bodyLedgerLoads} offline=${bodyOffline} |`)
lines.push(`| body 全文件 seq | rows=${rawBody.length} distinctSeq=${new Set(bodySeqs).size} wraps=${globalWraps} |`)
lines.push(`| lab 启动 / generation / commit | labStarts=${statusData.labStarts ?? '?'} · gen=${generations.length} · commits=${commitsSeen.join(' → ') || '-'} |`)
lines.push(`| 证据问题 | ${evidenceIssues.length ? evidenceIssues.join('；') : '无'} |`)
lines.push('')
lines.push('## 5. Checkpoint / replay 证据')
lines.push('')
lines.push(`- checkpoint：${checkpoint ?? '（未导出）'}`)
lines.push(`- replay：${replayFile ? `${replayFile} → ${replay?.pass ? 'PASS' : 'FAIL'}` : '（未跑）'}`)
if (replay?.errors?.length) for (const error of replay.errors) lines.push(`  - ${error}`)
lines.push('')
lines.push('## 6. 不满意点（本段）')
lines.push('')
for (const issue of issues) lines.push(`- ${issue}`)
if (!issues.length) lines.push('- （本段未触发规则；人工看 transcript 补充）')
lines.push('')
lines.push('## 7. 未知点 / 下段注意')
lines.push('')
lines.push('- 本报告由脚本从事件派生；人工需复核原话上下文与 transcript。')
lines.push('')

const outFile = path.join(runDir, `l2-${segmentId}-report.md`)
fs.writeFileSync(outFile, `${lines.join('\n')}\n`)
console.log(outFile)
