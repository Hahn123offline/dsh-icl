// 注意力日报：按天统计心跳/决策回合（只读 live state，不调模型）。
// 用法：node .state/lab/lead/attention-research/daily-report.mjs 2026-11-15
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const day = process.argv[2] ?? new Date().toISOString().slice(0, 10)
const stateDir = path.join(os.homedir(), '.dsh', 'icl', 'state')
const dayStart = new Date(`${day}T00:00:00+08:00`).getTime()
const dayEnd = dayStart + 86_400_000
const inDay = (at) => Number(at) >= dayStart && Number(at) < dayEnd

const readJsonl = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)

const timeEvents = readJsonl(path.join(stateDir, 'time-events.jsonl')).filter((row) => inDay(row.at))
const wakeEvents = timeEvents.filter((row) => row.type === 'heartbeat-fire' || row.type === 'heartbeat-skip-empty')
const session = readJsonl(path.join(stateDir, 'session-events.jsonl')).filter((row) => inDay(row.time))

const segments = []
let cur = null
for (const row of session) {
  if (row.type === 'user/message' && /^【心跳】/.test(String(row.text ?? ''))) {
    if (cur) segments.push(cur)
    cur = { at: row.time, text: String(row.text), tools: [], assistant: [] }
    continue
  }
  if (!cur) continue
  if (row.type === 'user/message') { segments.push(cur); cur = null; continue }
  if (row.type === 'tool/result') cur.tools.push(String(row.text ?? ''))
  if (row.type === 'assistant/message') cur.assistant.push(String(row.text ?? ''))
}
if (cur) segments.push(cur)

const turns = segments.map((seg) => {
  const tools = seg.tools
  const classify = (re) => tools.some((t) => re.test(t))
  return {
    at: new Date(seg.at).toISOString(),
    kind: /你已经安静了/.test(seg.text) ? 'long-silence' : (/心里惦记|等你：\n·/.test(seg.text) ? 'attend' : 'other'),
    toolCount: tools.length,
    checkedBacklog: classify(/未读|积压|已看 #/),
    acked: classify(/已把.*已看水位|只标记了"看过"/),
    replied: classify(/已发出去/),
    studied: classify(/完成了。|记下了/),
    assistant: seg.assistant.join(' ').replace(/\s+/g, ' ').trim().slice(0, 160),
  }
})

const report = {
  day,
  heartbeats: {
    fire: wakeEvents.filter((r) => r.type === 'heartbeat-fire').map((r) => ({ at: r.iso ?? new Date(r.at).toISOString(), kind: r.kind, pending: r.pending, idleSec: r.idleSec })),
    skips: wakeEvents.filter((r) => r.type === 'heartbeat-skip-empty').map((r) => ({ at: r.iso ?? new Date(r.at).toISOString(), mul: r.mul, skips: r.skips })),
  },
  turns,
  summary: {
    fire: wakeEvents.filter((r) => r.type === 'heartbeat-fire').length,
    skipEmpty: wakeEvents.filter((r) => r.type === 'heartbeat-skip-empty').length,
    attend: turns.filter((t) => t.kind === 'attend').length,
    longSilence: turns.filter((t) => t.kind === 'long-silence').length,
    noToolTurns: turns.filter((t) => t.toolCount === 0).length,
    checked: turns.filter((t) => t.checkedBacklog).length,
    acked: turns.filter((t) => t.acked).length,
    replied: turns.filter((t) => t.replied).length,
    studied: turns.filter((t) => t.studied).length,
  },
}
const outDir = path.join(process.cwd(), '.state', 'lab', 'attention-research')
fs.mkdirSync(outDir, { recursive: true })
const out = path.join(outDir, `daily-report-${day}.json`)
fs.writeFileSync(out, JSON.stringify(report, null, 2), 'utf8')
console.log(JSON.stringify(report, null, 2))
console.log(`wrote ${out}`)
