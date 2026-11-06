// E2 latency 分解：turn 结束→下一轮 turn/start 的 gap（来源分类）+ tool/call→result 耗时 + 最慢调用。
import fs from 'node:fs'
import path from 'node:path'

const dir = process.argv[2] ?? '.state/lab/e2-20261106-smoke'
const runId = path.basename(dir)
const evFile = path.join(dir, 'events.jsonl')
const events = fs.readFileSync(evFile, 'utf8').split('\n').filter(Boolean)
  .map((line) => { try { return JSON.parse(line) } catch { return null } })
  .filter(Boolean).map((row) => row.payload?.event).filter(Boolean)
  .sort((a, b) => Number(a.time) - Number(b.time))

const turnEnds = events.filter((e) => e.type === 'turn/end')
const turnStarts = events.filter((e) => e.type === 'turn/start')
const sourceKind = (event) => String(event?.data?.source?.kind ?? event?.data?.source?.plugin ?? event?.type)
const textOf = (event) => String(event?.data?.content?.[0]?.text ?? '')

const turnGaps = []
for (const end of turnEnds) {
  const next = turnStarts.find((start) => Number(start.time) > Number(end.time))
  if (!next) continue
  const gapSec = Math.round((Number(next.time) - Number(end.time)) / 1000)
  const between = events.filter((event) => Number(event.time) > Number(end.time) && Number(event.time) <= Number(next.time))
  const inbox = between.filter((event) => event.type === 'agent/inbox/spliced')
  const userMsgs = between.filter((event) => event.type === 'user/message')
  turnGaps.push({
    endAt: new Date(Number(end.time)).toISOString(),
    gapSec,
    inboxSplices: inbox.length,
    userMessages: userMsgs.map((event) => ({ src: sourceKind(event), text: textOf(event).replace(/\n/g, ' ').slice(0, 120) })),
  })
}

const calls = events.filter((e) => e.type === 'tool/call')
const results = events.filter((e) => e.type === 'tool/result')
const durations = []
for (const call of calls) {
  const result = results.find((row) => row.data?.toolCallId === call.data?.callId || row.data?.message?.toolCallId === call.data?.callId)
  if (!result) continue
  durations.push({ name: String(call.data?.name ?? ''), args: String(call.data?.arguments ?? '').slice(0, 120), ms: Number(result.time) - Number(call.time), at: new Date(Number(call.time)).toISOString(), result: String(result.data?.message?.content?.[0]?.text ?? '').slice(0, 160) })
}
const sorted = durations.map((row) => row.ms).sort((a, b) => a - b)
const pct = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] : null
const gapSorted = turnGaps.map((row) => row.gapSec).sort((a, b) => a - b)
const gapPct = (p) => gapSorted.length ? gapSorted[Math.min(gapSorted.length - 1, Math.max(0, Math.ceil((p / 100) * gapSorted.length) - 1))] : null
const slowTurnGaps = turnGaps.filter((row) => row.gapSec > 20)
const slowTools = durations.sort((a, b) => b.ms - a.ms).slice(0, 10)

const out = {
  runId,
  at: new Date().toISOString(),
  turns: turnEnds.length,
  turnGapSec: { p50: gapPct(50), p95: gapPct(95), max: gapSorted.at(-1) ?? null, over20: slowTurnGaps.length, samples: turnGaps },
  toolDurationMs: { count: durations.length, p50: pct(50), p95: pct(95), max: sorted.at(-1) ?? null, slow: slowTools },
}
fs.writeFileSync(path.join(dir, 'latency.json'), JSON.stringify(out, null, 2))
console.log(JSON.stringify({ turnGapSec: out.turnGapSec, toolDurationMs: out.toolDurationMs }, null, 1).slice(0, 4000))
