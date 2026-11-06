import fs from 'node:fs'
import path from 'node:path'

const dir = '.state/lab/e2-20261106-local3'
function readJsonl(file) { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean) } catch { return [] } }
const events = readJsonl(path.join(dir, 'events.jsonl')).map((row) => row.payload?.event).filter(Boolean)
const bodyRows = readJsonl(path.join(dir, 'state', 'mc-body', 'body.jsonl'))
const prompts = readJsonl(path.join(dir, 'prompts.jsonl'))
const calls = events.filter((e) => e.type === 'tool/call')
const results = events.filter((e) => e.type === 'tool/result')
const assistants = events.filter((e) => e.type === 'assistant/message')
const userMsgs = events.filter((e) => e.type === 'user/message')
const textOf = (e) => String(e.data?.content?.[0]?.text ?? '')
const sayCalls = calls.filter((c) => /"op"\s*:\s*"say"/.test(String(c.data?.arguments ?? '')))
const sayTexts = sayCalls.map((c) => { const m = String(c.data?.arguments ?? '').match(/"text"\s*:\s*"([^"]*)"/); return m ? m[1] : '' })
const assistantTexts = assistants.map(textOf).filter(Boolean)
const freq = {}
for (const t of assistantTexts) freq[t] = (freq[t] ?? 0) + 1
const repeated = Object.entries(freq).filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 10)
const toolCounts = {}
for (const c of calls) toolCounts[String(c.data?.name ?? '')] = (toolCounts[String(c.data?.name ?? '')] ?? 0) + 1
const sayFreq = {}
for (const t of sayTexts) sayFreq[t] = (sayFreq[t] ?? 0) + 1
const bodyCounts = {}
for (const r of bodyRows) bodyCounts[r.type] = (bodyCounts[r.type] ?? 0) + 1
const taskStarts = bodyRows.filter((r) => r.type === 'task_started')
const taskFails = bodyRows.filter((r) => r.type === 'task_failed')
const shelterStarts = taskStarts.filter((r) => r.data?.task?.kind === 'shelter')
const shelterFails = taskFails.filter((r) => r.data?.task?.kind === 'shelter')
const failReasons = {}
for (const r of taskFails) { const reason = String(r.data?.task?.error ?? r.data?.task?.reason ?? '?'); failReasons[reason] = (failReasons[reason] ?? 0) + 1 }
const homeEvents = bodyRows.filter((r) => /home/.test(JSON.stringify(r.data ?? {})) && /home/.test(String(r.type)))
const verifyEvents = bodyRows.filter((r) => /verify|entryOk|entry_ok/i.test(JSON.stringify(r.data ?? {})))
const turns = events.filter((e) => e.type === 'turn/end')
const starts = events.filter((e) => e.type === 'turn/start')
const gaps = []
for (const end of turns) {
  const next = starts.find((s) => Number(s.time) > Number(end.time))
  if (next) gaps.push(Math.round((Number(next.time) - Number(end.time)) / 1000))
}
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] : null }
const stepToTool = []
for (const a of assistants) { const n = calls.find((c) => Number(c.time) > Number(a.time)); if (n) stepToTool.push(Number(n.time) - Number(a.time)) }
const toolToAssist = []
for (const r of results) { const n = assistants.find((a) => Number(a.time) > Number(r.time)); if (n) toolToAssist.push(Number(n.time) - Number(r.time)) }
const turnLens = turns.map((end, i) => { const nextStart = starts.find((s) => Number(s.time) > Number(end.time)); const prevStart = starts[i]; return prevStart && nextStart ? Math.round((Number(end.time) - Number(prevStart.time)) / 1000) : null }).filter((x) => x != null)
const out = {
  runId: 'e2-20261106-local3', events: events.length, turns: turns.length, assistants: assistants.length, userMessages: userMsgs.length,
  toolCounts, sayCalls: sayCalls.length, sayFreqTop: Object.entries(sayFreq).sort((a, b) => b[1] - a[1]).slice(0, 8),
  repeatedAssistantTexts: repeated,
  bodyCounts, pathStuck: bodyCounts.path_stuck ?? 0, taskStarts: taskStarts.length, taskFails: taskFails.length, failReasons,
  shelterStarts: shelterStarts.length, shelterFails: shelterFails.length,
  shelterParamSample: shelterStarts.slice(-3).map((r) => r.data?.task?.params),
  shelterFailSample: shelterFails.slice(-4).map((r) => ({ error: r.data?.task?.error, progress: r.data?.task?.progress })),
  homeEvents: homeEvents.length, verifyEvents: verifyEvents.length,
  turnGapSec: { p50: pct(gaps, 50), p95: pct(gaps, 95), max: gaps.length ? Math.max(...gaps) : null, over60: gaps.filter((g) => g > 60).length, samples: gaps.length },
  stepToToolMs: { p50: pct(stepToTool, 50), p95: pct(stepToTool, 95) },
  toolToAssistantMs: { p50: pct(toolToAssist, 50), p95: pct(toolToAssist, 95) },
  turnLenSec: { p50: pct(turnLens, 50), p95: pct(turnLens, 95), max: turnLens.length ? Math.max(...turnLens) : null },
  prompts: prompts.length,
}
fs.writeFileSync(path.join(dir, 'freeze-forensics.json'), JSON.stringify(out, null, 2))
console.log(JSON.stringify(out, null, 1).slice(0, 6000))
