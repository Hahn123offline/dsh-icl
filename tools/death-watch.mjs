// 本地 24h P0 看护：死亡加速时（>=6）直接停危险任务 + 注入"先挖土再封洞/盖房"策略。
// 独立于 supervisor，长回合内也能生效（splice 进队列）；跑 24h。
import fs from 'node:fs'
import path from 'node:path'
import { apiFor, promptSession, readRunMeta } from '../tools/lab-lib.mjs'

const runId = String(process.argv[2] ?? 'e2-20261106-local2')
const hours = Number(process.argv[3] ?? 24)
const runDir = path.join(process.cwd(), '.state', 'lab', runId)
const startedAt = Date.now()
const deadline = startedAt + hours * 3600_000
let lastDeaths = -1
let lastIntervention = 0
let lastPrompt = 0
const results = []
function log(message) { const line = `${new Date().toISOString()} ${message}`; console.log(line); try { fs.appendFileSync(path.join(runDir, 'death-watch.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), message })}\n`) } catch { /* ignore */ } }
function bodyRows() {
  const file = path.join(runDir, 'state', 'mc-body', 'body.jsonl')
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
}
async function bodyStatus() {
  try { return await fetch('http://127.0.0.1:54902/v1/status', { signal: AbortSignal.timeout(3000) }).then((res) => res.json()) } catch { return null }
}
async function safetyStop(reason) {
  try { return await fetch('http://127.0.0.1:54902/v1/safety/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason }), signal: AbortSignal.timeout(6000) }).then((res) => res.json()) } catch { return null }
}
async function send(text) {
  const meta = readRunMeta(runId)
  if (!meta?.sessionId) return false
  await promptSession(apiFor(meta.port ?? 57101), meta.sessionId, text)
  return true
}
const promptText = [
  'P0 保命（死亡已加速）：',
  '1) 先停掉手上的探索/采集任务；',
  '2) 没有方块就先 mcb_do {"steps":[{"op":"dig","params":{"count":20}}]} 在脚下/身边挖 20 个土或石；',
  '3) 然后 mcb_shelter {size:3, material:"dirt"} 盖 3x3 并走进去；材料不够就挖坑封洞；',
  '4) 天亮前不跑远、不下水、不主动打怪；做完 mcb_status 报 home/血量/时间。',
].join('\n')
async function main() {
  log(`death-watch started run=${runId} hours=${hours}`)
  while (Date.now() < deadline) {
    const rows = bodyRows()
    const deaths = rows.filter((row) => row.type === 'death').length
    const now = Date.now()
    if (lastDeaths < 0) lastDeaths = deaths
    if (deaths > lastDeaths) {
      lastDeaths = deaths
      const status = await bodyStatus()
      const task = String(status?.task?.kind ?? status?.task ?? '')
      const risky = /collect|explore|mine|tunnel|dig|farm/i.test(task)
      if (deaths >= 6 && now - lastIntervention > 30_000) {
        lastIntervention = now
        const stop = risky ? await safetyStop(`death-watch: deaths=${deaths} task=${task}`) : null
        const sent = await send(promptText)
        results.push({ at: new Date().toISOString(), deaths, task, risky, stop: stop ? 'ok' : 'skip', prompt: sent })
        log(`intervene deaths=${deaths} task=${task} risky=${risky} stop=${Boolean(stop)} prompt=${sent}`)
        try { fs.writeFileSync(path.join(runDir, 'death-watch.json'), JSON.stringify({ runId, results }, null, 2)) } catch { /* ignore */ }
        lastPrompt = now
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000))
  }
  log('death-watch finished')
}
main().catch((error) => { log(`fatal ${String(error?.stack ?? error)}`); process.exit(1) })
