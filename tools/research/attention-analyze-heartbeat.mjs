// 分析 live session-events：心跳唤醒之后到底发生了什么（只读）。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const file = path.join(os.homedir(), '.dsh', 'icl', 'state', 'session-events.jsonl')
const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
  try { return JSON.parse(line) } catch { return null }
}).filter(Boolean)

const segments = []
let cur = null
for (const row of rows) {
  const text = String(row.text ?? '')
  const isHeartbeat = row.type === 'user/message' && /^【心跳】/.test(text)
  const isAwake = row.type === 'user/message' && /^清醒节拍/.test(text)
  if (isHeartbeat || isAwake) {
    if (cur) segments.push(cur)
    cur = { kind: isHeartbeat ? 'heartbeat' : 'awake', at: row.time, userText: text, tools: [], assistant: [] }
    continue
  }
  if (!cur) continue
  if (row.type === 'user/message') { segments.push(cur); cur = null; continue }
  if (row.type === 'tool/result') cur.tools.push(String(row.text ?? ''))
  if (row.type === 'assistant/message') cur.assistant.push(String(row.text ?? ''))
}
if (cur) segments.push(cur)

function classify(seg) {
  const tools = seg.tools
  const toolCount = tools.length
  const sentQq = tools.some((t) => /^已发出去/.test(t))
  const acted = tools.some((t) => /^(进入了专注空间|安排好了|记下了|已|查到了)/.test(t)) || toolCount > 0
  const words = seg.assistant.join(' ').replace(/\s+/g, ' ').trim()
  return { toolCount, sentQq, acted, words, chars: words.length }
}

const stats = { heartbeat: 0, heartbeatNoTool: 0, heartbeatTool: 0, heartbeatSent: 0, awake: 0, awakeNoTool: 0 }
const samples = []
for (const seg of segments) {
  const c = classify(seg)
  if (seg.kind === 'heartbeat') {
    stats.heartbeat += 1
    if (c.toolCount === 0) stats.heartbeatNoTool += 1
    else stats.heartbeatTool += 1
    if (c.sentQq) stats.heartbeatSent += 1
  } else {
    stats.awake += 1
    if (c.toolCount === 0) stats.awakeNoTool += 1
  }
  samples.push({
    kind: seg.kind,
    time: new Date(seg.at).toISOString(),
    toolCount: c.toolCount,
    sentQq: c.sentQq,
    assistant: c.words.slice(0, 160),
    tools: seg.tools.slice(0, 3).map((t) => String(t).slice(0, 80)),
  })
}

console.log(JSON.stringify({ stats, segments: samples.length }, null, 2))
const outDir = path.join(process.cwd(), '.state', 'lab', 'attention-research')
fs.mkdirSync(outDir, { recursive: true })
const out = path.join(outDir, 'heartbeat-turns.json')
fs.writeFileSync(out, JSON.stringify(samples, null, 2), 'utf8')
console.log(`wrote ${out}`)
const noTool = samples.filter((s) => s.kind === 'heartbeat' && s.toolCount === 0)
console.log('\nheartbeat no-tool examples:')
for (const s of noTool.slice(-12)) console.log(`- ${s.time} | ${s.assistant}`)
const acted = samples.filter((s) => s.kind === 'heartbeat' && s.toolCount > 0)
console.log('\nheartbeat with-tool examples:')
for (const s of acted.slice(-12)) console.log(`- ${s.time} | tools=${s.toolCount} | ${s.assistant} | ${s.tools.join(' || ')}`)
