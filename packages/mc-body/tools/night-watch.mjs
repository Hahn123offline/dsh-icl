// E1 夜间长测只读观察器：聚合最新 night-* run 的 events.jsonl（权威 tool/call+result）、
// status.json、transcript、state/mc-body 产物，输出紧凑摘要 + 报警位。
// 只读：不连服务器、不 spawn bot、不写 run 目录（可选 --history 追加到自己的文件）。
//
// 用法：
//   node packages/mc-body/tools/night-watch.mjs [--root C:/DSH/icl-wt/mc-lab/.state/lab]
//     [--run night-1] [--history out.jsonl] [--json]
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback }
const flag = (name) => args.includes(name)
const root = path.resolve(String(arg('--root', 'C:/DSH/icl-wt/mc-lab/.state/lab')))
const wantRun = arg('--run', null)
const history = arg('--history', null)
const asJson = flag('--json')
const ALERT = { sameCallRepeat: 10, sameErrorRepeat: 10, errorRate: 0.2, turnMin: 10, pausedMin: 3 }

function newestRun() {
  if (wantRun) {
    const direct = path.join(root, wantRun)
    return fs.existsSync(direct) ? direct : null
  }
  const dirs = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^night/.test(entry.name))
    .map((entry) => ({ name: entry.name, dir: path.join(root, entry.name), at: fs.statSync(path.join(root, entry.name)).mtimeMs }))
    .sort((a, b) => b.at - a.at)
  return dirs[0]?.dir ?? null
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function analyzeRun(dir) {
  const status = readJson(path.join(dir, 'status.json'), {})
  const night = readJson(path.join(dir, 'night.json'), {})
  const eventsFile = path.join(dir, 'events.jsonl')
  const calls = []
  const results = []
  const bodyEvents = {}
  const taskTerminal = []
  let deaths = 0
  const lastDeath = []
  if (fs.existsSync(eventsFile)) {
    for (const line of fs.readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean)) {
      let row
      try { row = JSON.parse(line) } catch { continue }
      const ev = row?.payload?.event
      if (!ev) continue
      if (ev.type === 'tool/call') calls.push({ at: ev.time, name: ev.data?.name, args: ev.data?.arguments, turn: ev.data?.turn, step: ev.data?.step })
      if (ev.type === 'tool/result') {
        const message = ev.data?.message ?? {}
        const text = (message.content ?? []).filter((part) => part?.type === 'text').map((part) => part.text).join(' ').slice(0, 500)
        results.push({ at: ev.time, error: message.isError === true, text, turn: ev.data?.turn, step: ev.data?.step })
      }
    }
  }
  const bodyFile = path.join(dir, 'state/mc-body/body.jsonl')
  if (fs.existsSync(bodyFile)) {
    for (const line of fs.readFileSync(bodyFile, 'utf8').split('\n').filter(Boolean)) {
      let event
      try { event = JSON.parse(line) } catch { continue }
      bodyEvents[event.type] = (bodyEvents[event.type] ?? 0) + 1
      if (event.type === 'death') {
        deaths += 1
        lastDeath.push({ at: event.at, position: event.data?.position ?? null })
      }
      if (['task_done', 'task_failed', 'task_cancelled', 'task_interrupted', 'task_unknown'].includes(event.type)) {
        taskTerminal.push({ at: event.at, type: event.type, kind: event.data?.task?.kind, error: event.data?.task?.error, result: event.data?.task?.result })
      }
    }
  }
  // tool+args 连续重复、同错误连续重复
  let sameCall = { key: null, count: 0, max: 0, sample: null }
  for (const call of calls) {
    const key = `${call.name}|${call.args}`
    if (key === sameCall.key) sameCall.count += 1
    else sameCall = { key, count: 1, max: sameCall.max, sample: null }
    if (sameCall.count > sameCall.max) { sameCall.max = sameCall.count; sameCall.sample = key }
  }
  let sameError = { text: null, count: 0, max: 0, sample: null }
  for (const result of results.filter((row) => row.error)) {
    const text = String(result.text).replace(/\s+/g, ' ').slice(0, 200)
    if (text === sameError.text) sameError.count += 1
    else sameError = { text, count: 1, max: sameError.max, sample: null }
    if (sameError.count > sameError.max) { sameError.max = sameError.count; sameError.sample = text }
  }
  const errorMsgs = new Map()
  for (const result of results.filter((row) => row.error)) {
    const text = String(result.text).replace(/\s+/g, ' ').slice(0, 180)
    errorMsgs.set(text, (errorMsgs.get(text) ?? 0) + 1)
  }
  const first = calls[0]?.at ?? Date.now()
  const last = calls.at(-1)?.at ?? first
  const buckets = new Map()
  for (let index = 0; index < results.length; index += 1) {
    const at = results[index].at
    const key = Math.floor((at - first) / 30_000) * 30
    const bucket = buckets.get(key) ?? { calls: 0, errors: 0 }
    bucket.errors += results[index].error ? 1 : 0
    buckets.set(key, bucket)
  }
  for (const call of calls) {
    const key = Math.floor((call.at - first) / 30_000) * 30
    const bucket = buckets.get(key) ?? { calls: 0, errors: 0 }
    bucket.calls += 1
    buckets.set(key, bucket)
  }
  const recentBuckets = [...buckets.entries()].sort((a, b) => a[0] - b[0]).slice(-8)
  const recentCalls = recentBuckets.reduce((sum, [, bucket]) => sum + bucket.calls, 0)
  const recentErrors = recentBuckets.reduce((sum, [, bucket]) => sum + bucket.errors, 0)
  const recentRate = recentCalls ? recentErrors / recentCalls : 0
  const now = Date.now()
  const lastEventAgeSec = status.lastSeenEventAt ? Math.round((now - Date.parse(status.lastSeenEventAt)) / 1000) : null
  const paused = status.body?.paused ?? null
  const alerts = []
  if (sameCall.max > ALERT.sameCallRepeat) alerts.push(`sameCallRepeat=${sameCall.max}`)
  if (sameError.max > ALERT.sameErrorRepeat) alerts.push(`sameErrorRepeat=${sameError.max}`)
  if (recentRate > ALERT.errorRate) alerts.push(`errorRate=${Math.round(recentRate * 100)}%`)
  if (Number(status.uptimeMin ?? 0) > 0 && status.inTurn === true && (status.lastTurnEnds ?? 0) === 0 && Number(status.uptimeMin) > ALERT.turnMin) alerts.push('turnTooLong')
  if (paused) alerts.push(`bodyPaused=${status.body?.pausedReason ?? paused}`)
  if (status.body && status.body.alive === false) alerts.push('bodyExited')
  if (lastEventAgeSec != null && lastEventAgeSec > 300) alerts.push(`noEvents=${lastEventAgeSec}s`)
  return {
    run: path.basename(dir),
    runDir: dir,
    phase: status.phase ?? null,
    smoke: status.smoke ?? null,
    uptimeMin: status.uptimeMin ?? null,
    server: night?.cfg ? `${night.cfg.serverName}:${night.cfg.serverPort}` : null,
    turns: status.turns ?? null,
    statusToolCalls: status.toolCalls ?? null,
    statusToolErrors: status.toolErrors ?? null,
    logRotated: Number(status.toolCalls ?? 0) > calls.length * 1.5,
    toolCalls: calls.length,
    toolErrors: results.filter((row) => row.error).length,
    errorRate: calls.length ? Math.round(results.filter((row) => row.error).length / calls.length * 100) : 0,
    recent30s: recentBuckets.map(([offset, bucket]) => `${offset}s:${bucket.calls}/${bucket.errors}`).join(' '),
    sameCallMax: sameCall.max,
    sameCallSample: sameCall.max > 1 ? String(sameCall.sample).slice(0, 220) : null,
    sameErrorMax: sameError.max,
    sameErrorSample: sameError.max > 1 ? String(sameError.sample).slice(0, 220) : null,
    topErrors: [...errorMsgs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([text, count]) => `${count}x ${text}`),
    body: status.body ?? null,
    bodyEvents,
    taskTerminal: taskTerminal.slice(-6),
    deaths,
    lastDeath: lastDeath.slice(-2),
    lastEventAgeSec,
    lastErrorInterruptAt: status.lastErrorInterruptAt ?? null,
    checkpoints: status.checkpoints ?? null,
    alerts,
  }
}

const dir = newestRun()
if (!dir) {
  console.log('no night-* run dir under', root)
  process.exit(0)
}
const summary = analyzeRun(dir)
if (history) {
  try { fs.appendFileSync(path.resolve(history), `${JSON.stringify({ at: new Date().toISOString(), ...summary })}\n`, 'utf8') } catch { /* ignore */ }
}
if (asJson) { console.log(JSON.stringify(summary, null, 2)); process.exit(0) }
console.log(`RUN ${summary.run} phase=${summary.phase} smoke=${summary.smoke} uptime=${summary.uptimeMin}min server=${summary.server}`)
console.log(`turns=${summary.turns} calls=${summary.toolCalls} errors=${summary.toolErrors} (${summary.errorRate}%) statusCounters=${summary.statusToolCalls}/${summary.statusToolErrors} rotated=${summary.logRotated} last30sBuckets=${summary.recent30s}`)
console.log(`sameCallMax=${summary.sameCallMax} sameErrorMax=${summary.sameErrorMax}`)
if (summary.sameCallSample) console.log(`sameCallSample: ${summary.sameCallSample}`)
if (summary.sameErrorSample) console.log(`sameErrorSample: ${summary.sameErrorSample}`)
for (const row of summary.topErrors) console.log(`  ${row}`)
console.log(`body: connected=${summary.body?.connected} pos=${summary.body?.position} hp=${summary.body?.health} food=${summary.body?.food} task=${JSON.stringify(summary.body?.task)} paused=${summary.body?.paused ?? '?'} alive=${summary.body?.alive}`)
console.log(`bodyEvents: ${JSON.stringify(summary.bodyEvents)}`)
console.log(`deaths=${summary.deaths} lastDeath=${JSON.stringify(summary.lastDeath)}`)
console.log(`taskTerminal: ${JSON.stringify(summary.taskTerminal)}`)
console.log(`lastEventAgeSec=${summary.lastEventAgeSec} lastErrorInterruptAt=${summary.lastErrorInterruptAt}`)
console.log(summary.alerts.length ? `ALERTS: ${summary.alerts.join(', ')}` : 'ALERTS: none')

