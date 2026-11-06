// E2 S2 场景注入器：过去指代 recall、mcb_stop 复验、hunt/flee/attack 验证；不碰 supervisor/lab，只发 prompt + 读 events。
// 用法：node tools/e2-scenarios.mjs --run e2-20261106-soak --hours 24
import fs from 'node:fs'
import path from 'node:path'
import { apiFor, promptSession, readJson, readJsonl, readRunMeta, runDirOf, sleep, nowIso } from './lab-lib.mjs'

function arg(name, fallback = null) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback }
const runId = String(arg('--run', 'e2-20261106-soak'))
const hours = Number(arg('--hours', 24))
const runDir = runDirOf(runId)
const logFile = path.join(runDir, 'e2-scenarios.jsonl')
const summaryFile = path.join(runDir, 'e2-scenario-summary.json')
fs.mkdirSync(runDir, { recursive: true })
const startedAt = Date.now()
const deadline = startedAt + hours * 3600_000
const results = []

function log(message) { const line = `${new Date().toISOString()} ${message}`; console.log(line); try { fs.appendFileSync(logFile, `${JSON.stringify({ at: nowIso(), message })}\n`) } catch { /* ignore */ } }
function record(kind, status, detail = '') { const row = { at: nowIso(), kind, status, detail }; results.push(row); log(`${kind} ${status} ${detail}`); try { fs.appendFileSync(logFile, `${JSON.stringify(row)}\n`) } catch { /* ignore */ } fs.writeFileSync(summaryFile, JSON.stringify({ runId, startedAt: new Date(startedAt).toISOString(), finishedAt: nowIso(), results }, null, 2)) }

function events() {
  const file = path.join(runDir, 'events.jsonl')
  if (!fs.existsSync(file)) return []
  return readJsonl(file).map((envelope) => (envelope?.payload?.type === 'session/event' ? envelope.payload.event : null)).filter(Boolean)
}
function phase() {
  try { return String(readJson(path.join(runDir, 'state', 'icl-mc-lab', 'time.json'), null)?.phase ?? 'awake') } catch { return 'awake' }
}
async function say(text) {
  const meta = readRunMeta(runId)
  if (!meta?.sessionId) throw new Error('lab sessionId 还没有')
  await promptSession(apiFor(meta.port ?? 57101), meta.sessionId, text)
}

const schedule = [
  { atMin: 6, kind: 'mcb_stop', run: async () => {
    const since = Date.now()
    await say('做一次暂停语义验收：调用 mcb_stop（reason "E2 验收暂停"），把回执摘要贴出来；然后立刻 resume 恢复继续。只做这两个动作。')
    await sleep(90_000)
    const calls = events().filter((event) => event.type === 'tool/call' && Number(event.time) >= since)
    const stopCall = calls.find((call) => String(call.data?.name ?? '') === 'mcb_stop')
    const resumeCall = calls.find((call) => String(call.data?.name ?? '') === 'mcb_do' && /"op"\s*:\s*"resume"/.test(String(call.data?.arguments ?? '')))
    record('mcb_stop', stopCall ? 'PASS' : 'FAIL', stopCall ? `stop@${new Date(Number(stopCall.time)).toISOString()} resume=${Boolean(resumeCall)}` : 'no mcb_stop call')
  } },
  { atMin: 12, kind: 'combat', run: async () => {
    const since = Date.now()
    await say('如果附近有 hostile 怪（zombie/skeleton/creeper），用 mcb_combat {mode:"hunt", target:"nearest_hostile", radius:16} 打一只；没有怪就 mcb_combat {mode:"flee"} 演示一下逃跑并报告结果。只做一个动作。')
    await sleep(120_000)
    const calls = events().filter((event) => event.type === 'tool/call' && Number(event.time) >= since)
    const combatCall = calls.find((call) => String(call.data?.name ?? '') === 'mcb_combat')
    record('combat', combatCall ? 'PASS' : 'FAIL', combatCall ? String(combatCall.data?.arguments ?? '').slice(0, 160) : 'no mcb_combat call')
  } },
  { atMin: 30, kind: 'attack', run: async () => {
    const since = Date.now()
    await say('如果 5 格内有 hostile 怪，用 mcb_attack 打它一下并报告伤害/血量；如果没有怪就报告"附近无怪"。')
    await sleep(90_000)
    const calls = events().filter((event) => event.type === 'tool/call' && Number(event.time) >= since)
    const attackCall = calls.find((call) => String(call.data?.name ?? '') === 'mcb_attack')
    record('attack', attackCall ? 'PASS' : 'SKIP', attackCall ? String(attackCall.data?.arguments ?? '').slice(0, 160) : 'no mcb_attack call（可能附近无怪）')
  } },
]

const recallTexts = [
  '你还记得昨晚为什么死了那么多次吗？先回忆一下再回答（不确定就查记忆）。',
  '上次你说的小屋/安全点在哪？如果记得，说出位置和来历。',
  '你还记得我们之前砍树、做工作台那一段吗？说说当时发生了什么。',
]
let recallIndex = 0
const recallTimes = []
for (let minute = 120; minute <= hours * 60; minute += 120) recallTimes.push(minute)

async function main() {
  log(`scenarios started run=${runId} hours=${hours}`)
  const done = new Set()
  while (Date.now() < deadline) {
    const elapsedMin = (Date.now() - startedAt) / 60000
    try {
      if (phase() === 'sleeping') { await sleep(60_000); continue }
      for (const item of schedule) {
        if (elapsedMin >= item.atMin && !done.has(item.kind)) {
          done.add(item.kind)
          try { await item.run() } catch (error) { record(item.kind, 'FAIL', String(error?.message ?? error)) }
        }
      }
      const dueRecall = recallTimes.find((minute) => elapsedMin >= minute && !done.has(`recall-${minute}`))
      if (dueRecall) {
        done.add(`recall-${dueRecall}`)
        const text = recallTexts[recallIndex % recallTexts.length]
        recallIndex += 1
        const since = Date.now()
        try {
          await say(`${text}（只用记忆回答；想不起来就先 recall 查，再回答。）`)
          await sleep(90_000)
          const calls = events().filter((event) => event.type === 'tool/call' && Number(event.time) >= since)
          const recallCall = calls.find((call) => String(call.data?.name ?? '') === 'recall')
          record('recall', recallCall ? 'PASS' : 'MISS', `prompt="${text.slice(0, 30)}…" recallCall=${Boolean(recallCall)}`)
        } catch (error) { record('recall', 'FAIL', String(error?.message ?? error)) }
      }
    } catch (error) { log(`loop error: ${String(error?.message ?? error)}`) }
    await sleep(30_000)
  }
  log('scenarios finished')
}
main().catch((error) => { log(`fatal: ${String(error?.stack ?? error)}`); process.exit(1) })
