import fs from 'node:fs'
import path from 'node:path'

const dir = '.state/lab/e2-20261106-soak'
const files = [path.join(dir, 'events.jsonl')]
const genDir = path.join(dir, 'checkpoint')
if (fs.existsSync(genDir)) {
  for (const name of fs.readdirSync(genDir).filter((item) => item.startsWith('lab-gen-'))) {
    const file = path.join(genDir, name, 'events.jsonl')
    if (fs.existsSync(file)) files.push(file)
  }
}
const events = files.flatMap((file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  .map((line) => { try { return JSON.parse(line) } catch { return null } })
  .filter(Boolean).map((row) => row.payload?.event).filter(Boolean))
  .sort((a, b) => Number(a.time) - Number(b.time))
const calls = events.filter((event) => event.type === 'tool/call')
const counts = {}
for (const call of calls) counts[String(call.data?.name ?? '')] = (counts[String(call.data?.name ?? '')] ?? 0) + 1
const mcbDo = calls.filter((call) => String(call.data?.name ?? '') === 'mcb_do')
const ops = {}
const kinds = {}
for (const call of mcbDo) {
  const args = String(call.data?.arguments ?? '')
  for (const match of args.matchAll(/"op"\s*:\s*"([^"]+)"/g)) ops[match[1]] = (ops[match[1]] ?? 0) + 1
  for (const match of args.matchAll(/"kind"\s*:\s*"([^"]+)"/g)) kinds[match[1]] = (kinds[match[1]] ?? 0) + 1
}
const macroTaskCalls = Object.values(kinds).reduce((sum, count) => sum + count, 0)
const out = {
  runId: 'e2-20261106-soak',
  eventFiles: files.length,
  totalToolCalls: calls.length,
  topTools: Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 20),
  mcbDoCalls: mcbDo.length,
  mcbDoOps: ops,
  taskKinds: kinds,
  macroTaskCalls,
  macroShare: calls.length ? Math.round((macroTaskCalls / calls.length) * 1000) / 10 : 0,
  combatCalls: counts.mcb_combat ?? 0,
  attackCalls: counts.mcb_attack ?? 0,
  stopCalls: counts.mcb_stop ?? 0,
}
fs.writeFileSync(`${dir}/macro-usage.json`, JSON.stringify(out, null, 2))
console.log(JSON.stringify(out, null, 1).slice(0, 3500))
