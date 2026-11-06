// C renderTail A/B 只读审计：从一个 lab run 的 events.jsonl 算
//   状态类工具调用 / 100 工具、工具结果平均字符、turn-gap p50/p95、投递字符。
// 用法：node tools/render-tail-audit.mjs --run .state/lab/<runId>
import fs from 'node:fs'
import path from 'node:path'

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const runDir = path.resolve(String(arg('--run', '') || ''))
if (!runDir || !fs.existsSync(path.join(runDir, 'events.jsonl'))) {
  console.error('用法：node tools/render-tail-audit.mjs --run <runDir>（需 events.jsonl）')
  process.exit(2)
}

const events = []
for (const line of fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').split('\n')) {
  if (!line) continue
  try {
    const row = JSON.parse(line)
    const event = row?.payload?.event ?? row
    if (event?.type) events.push(event)
  } catch { /* skip bad line */ }
}

const textOf = (event) => {
  const content = event?.data?.message?.content ?? event?.data?.content ?? []
  if (typeof content === 'string') return content
  return (Array.isArray(content) ? content : []).map((block) => (typeof block === 'string' ? block : (block?.text ?? ''))).join('')
}

const STATUS_RE = /^(mcb_status|mcb_inventory|mcb_map|mcb_scan|time_status|time_list|album_status|album_list|album_search|world_status|focus_status|memo_status|note_status)$/
const calls = events.filter((event) => event.type === 'tool/call')
const results = events.filter((event) => event.type === 'tool/result')
const byName = {}
for (const call of calls) byName[String(call.data?.name ?? call.data?.tool ?? '?')] = (byName[String(call.data?.name ?? call.data?.tool ?? '?')] ?? 0) + 1
const totalTools = calls.length
const statusCalls = calls.filter((call) => STATUS_RE.test(String(call.data?.name ?? call.data?.tool ?? ''))).length
const resultChars = results.reduce((sum, event) => sum + textOf(event).length, 0)

const turns = events.filter((event) => event.type === 'turn/start').length
const starts = events.filter((event) => event.type === 'turn/start').map((event) => Number(event.time)).filter(Boolean)
const ends = events.filter((event) => event.type === 'turn/end').map((event) => Number(event.time)).filter(Boolean)
const turnGaps = []
for (let i = 0; i < ends.length; i += 1) {
  const next = starts.find((at) => at >= ends[i])
  if (next) turnGaps.push(next - ends[i])
}
const pct = (values, p) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}

const deliveredBySource = {}
let deliveredChars = 0
for (const event of events.filter((item) => item.type === 'user/message')) {
  const source = String(event.data?.source?.kind ?? '?')
  const chars = textOf(event).length
  deliveredBySource[source] = (deliveredBySource[source] ?? 0) + chars
  deliveredChars += chars
}

const assistant = events.filter((event) => event.type === 'assistant/message')
const assistantText = assistant.map((event) => ({ seq: event.seq, text: textOf(event) })).filter((item) => item.text.trim())

console.log(JSON.stringify({
  runDir,
  turns,
  tools: { total: totalTools, status: statusCalls, statusPer100: totalTools ? Number(((statusCalls / totalTools) * 100).toFixed(1)) : 0, byName },
  toolResults: { count: results.length, chars: resultChars, avg: results.length ? Number((resultChars / results.length).toFixed(1)) : 0 },
  turnGapMs: { count: turnGaps.length, p50: pct(turnGaps, 0.5), p95: pct(turnGaps, 0.95), max: turnGaps.length ? Math.max(...turnGaps) : null },
  delivered: { chars: deliveredChars, bySource: deliveredBySource },
  assistantMessages: assistantText.length,
  sampleAssistant: assistantText.slice(-3),
}, null, 2))
