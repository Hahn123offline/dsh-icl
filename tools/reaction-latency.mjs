// 反应时延：body 事件（task_done/task_failed/task_cancelled/safety_stop/combat_abort/death）→ 下一条 assistant/tool 动作的延迟。
// 用法：node tools/reaction-latency.mjs --dir .state/lab/<run>
import fs from 'node:fs'
import path from 'node:path'

function arg(name, fallback = null) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback }
const dir = String(arg('--dir', '.state/lab/e2-fast-1414'))
const outFile = path.join(dir, 'reaction-latency.json')
function readJsonl(file) { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean) } catch { return [] } }
const files = [path.join(dir, 'events.jsonl')]
const genDir = path.join(dir, 'checkpoint')
if (fs.existsSync(genDir)) {
  for (const name of fs.readdirSync(genDir).filter((item) => item.startsWith('lab-gen-'))) {
    const file = path.join(genDir, name, 'events.jsonl')
    if (fs.existsSync(file)) files.push(file)
  }
}
const bodyRows = readJsonl(path.join(dir, 'state', 'mc-body', 'body.jsonl'))
const events = files.flatMap((file) => readJsonl(file).map((row) => row.payload?.event).filter(Boolean))
const actions = events.filter((event) => event.type === 'tool/call' || event.type === 'assistant/message').map((event) => ({ at: Number(event.time), type: event.type, name: String(event.data?.name ?? '') })).filter((action) => action.at > 0).sort((a, b) => a.at - b.at)
const triggers = bodyRows.filter((row) => /^(task_done|task_failed|task_cancelled|safety_stop|combat_abort|death)$/.test(String(row.type))).map((row) => ({ at: Number(row.at), type: String(row.type), data: row.data })).filter((row) => row.at > 0)
const results = []
for (const trigger of triggers) {
  const next = actions.find((action) => action.at > trigger.at)
  if (!next) continue
  results.push({ trigger: trigger.type, triggerAt: new Date(trigger.at).toISOString(), nextType: next.type, nextName: next.name, latencyMs: Math.round(next.at - trigger.at), detail: JSON.stringify(trigger.data ?? {}).slice(0, 160) })
}
const latencies = results.map((row) => row.latencyMs).sort((a, b) => a - b)
const pct = (p) => latencies.length ? latencies[Math.min(latencies.length - 1, Math.max(0, Math.ceil((p / 100) * latencies.length) - 1))] : null
const out = { dir, eventFiles: files.length, triggers: triggers.length, matched: results.length, latencyMs: { p50: pct(50), p95: pct(95), max: latencies.at(-1) ?? null }, samples: results.slice(-30) }
fs.writeFileSync(outFile, JSON.stringify(out, null, 2))
console.log(JSON.stringify({ triggers: out.triggers, matched: out.matched, latencyMs: out.latencyMs, samples: out.samples.slice(-6) }, null, 1).slice(0, 3000))
