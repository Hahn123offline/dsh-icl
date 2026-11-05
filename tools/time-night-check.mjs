// 夜间长测的 time 侧只读体检（不连 DSH、不占 GPU、不写任何状态）。
//
//   node tools/time-night-check.mjs                 # 自动找最新的 night-* lab run
//   node tools/time-night-check.mjs --run <dir>     # 指定 run 目录（或 stateDir）
//   node tools/time-night-check.mjs --json          # 机器可读，便于定时任务比对
//   node tools/time-night-check.mjs --night-only    # 只认名字带 night 的 run
//   node tools/time-night-check.mjs --loop --interval 300 --log .state/night-watch.jsonl --max-hours 9
//                                                   # 长测期间每 5 分钟写一行 JSONL（只读、不占 GPU）
//
// 检查：phase 切换是否合法、睡眠 span 与 sleepUntil 是否一致、fired 去重/重复唤醒、
// 积压是否按 reason 分类/是否有界、tick/inbox/persist 错误、transcript 里时间相关文本。
// 只读：仅 fs.readFileSync / stat，绝不写文件。
import fs from 'node:fs'
import path from 'node:path'

const CANDIDATE_ROOTS = [
  'C:/DSH/icl-wt/mc-lab/.state/lab',
  'C:/DSH/icl/.state/lab',
  'C:/DSH/icl-wt/time/.state/lab',
  'C:/DSH/icl-wt/mc-link/.state/lab',
]

const args = process.argv.slice(2)
const arg = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback }
const asJson = args.includes('--json')
const nightOnly = args.includes('--night-only')
const loopMode = args.includes('--loop')
const intervalSec = Math.max(30, Number(arg('--interval', '300')) || 300)
const logFile = arg('--log', null)
const maxHours = Math.max(0.1, Number(arg('--max-hours', '9')) || 9)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function statAge(file) {
  try { return Date.now() - fs.statSync(file).mtimeMs } catch { return null }
}

function newestRun({ onlyNight = false } = {}) {
  let best = null
  for (const root of CANDIDATE_ROOTS) {
    let entries = []
    try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = path.join(root, entry.name)
      if (!fs.existsSync(path.join(dir, 'lab.json'))) continue
      const isNight = /night/i.test(entry.name)
      if (onlyNight && !isNight) continue
      const fresh = statAge(dir) ?? Infinity
      // night-* 优先；否则取最新的带 time 状态的 run
      const score = (isNight ? 1e12 : 0) + (Date.now() - fresh)
      if (!best || score > best.score) best = { dir, name: entry.name, score, isNight }
    }
  }
  return best
}

function findState(runDir) {
  // 支持传 stateDir 本身
  const direct = path.join(runDir, 'time.json')
  if (fs.existsSync(direct)) {
    const meta = readJson(path.join(runDir, '..', '..', '..', 'lab.json'), null)
    return { stateFile: direct, stateDir: runDir, meta }
  }
  const meta = readJson(path.join(runDir, 'lab.json'), null)
  const stateRoot = path.join(runDir, 'state')
  // 优先用 lab.json 里的 preset 对应的 stateDir（同一个 run 可能同时有 icl-lab / icl-mc-lab 两个状态）
  if (meta?.preset) {
    const stateDir = path.join(stateRoot, String(meta.preset))
    const stateFile = path.join(stateDir, 'time.json')
    if (fs.existsSync(stateFile)) return { stateFile, stateDir, meta }
  }
  let entries = []
  try { entries = fs.readdirSync(stateRoot, { withFileTypes: true }) } catch { entries = [] }
  let best = null
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const stateDir = path.join(stateRoot, entry.name)
    const stateFile = path.join(stateDir, 'time.json')
    if (!fs.existsSync(stateFile)) continue
    const fresh = statAge(stateFile) ?? Infinity
    if (!best || fresh < best.fresh) best = { stateFile, stateDir, fresh }
  }
  return best ? { stateFile: best.stateFile, stateDir: best.stateDir, meta } : { stateFile: null, stateDir: null, meta }
}

function minutes(ms) { return Math.round(Number(ms) / 60_000) }

function analyse(runDir) {
  const { stateFile, stateDir, meta } = findState(runDir)
  const out = {
    run: path.basename(runDir),
    runDir,
    sessionId: meta?.sessionId ?? null,
    model: meta?.model ? `${meta.model.provider}/${meta.model.model}` : null,
    stateFile,
    stateDir,
    checks: [],
    time: null,
    transcript: null,
  }
  const flag = (level, name, detail = '') => out.checks.push({ level, name, detail })

  if (!stateFile) {
    flag('error', 'time.json 不存在', runDir)
    return out
  }
  const state = readJson(stateFile, null)
  const age = statAge(stateFile)
  if (!state) {
    flag('error', 'time.json 解析失败（可能正在写/损坏）', `age=${age}ms`)
    return out
  }
  const now = Date.now()
  const spans = Array.isArray(state.spans) ? state.spans : []
  const queue = Array.isArray(state.queue) ? state.queue : []
  const goals = Array.isArray(state.goals) ? state.goals : []
  const fired = state.fired && typeof state.fired === 'object' ? state.fired : {}
  const stats = state.stats ?? {}
  out.time = {
    phase: state.phase,
    since: state.since,
    sleepingId: state.sleepingId ?? null,
    sleepUntil: state.sleepUntil ?? null,
    pausedAt: state.pausedAt ?? null,
    lock: state.lock ? { until: state.lock.until, reason: state.lock.reason } : null,
    schedules: (Array.isArray(state.schedules) ? state.schedules : []).map((s) => ({
      id: s.id, mode: s.mode, kind: s.kind, at: s.at, sleep: Boolean(s.sleep), durationMin: s.durationMin ?? null,
      allow: Array.isArray(s.allow) ? s.allow : null,
    })),
    spans: spans.map((s) => ({ id: s.id, until: s.until, sleep: Boolean(s.sleep), silent: Boolean(s.silent) })),
    goals: goals.map((g) => ({ id: g.id, theme: g.theme, until: g.until, resumes: g.resumes })),
    queue: {
      total: queue.length,
      byReason: queue.reduce((acc, item) => { const key = item.reason ?? '?'; acc[key] = (acc[key] ?? 0) + 1; return acc }, {}),
      bySource: queue.reduce((acc, item) => { const key = item.from?.plugin ?? '?'; acc[key] = (acc[key] ?? 0) + 1; return acc }, {}),
      sample: queue.slice(0, 3).map((item) => ({ from: `${item.from?.plugin ?? '?'}/${item.from?.activity ?? ''}`, reason: item.reason, at: item.at })),
    },
    firedToday: Object.keys(fired).length,
    firedKeys: Object.keys(fired).slice(-12),
    stats,
    lastTickError: state.lastTickError ?? null,
    lastPersistError: state.lastPersistError ?? null,
    sleepBoundary: state.sleepBoundary && typeof state.sleepBoundary === 'object' ? state.sleepBoundary : null,
    lastSleepBoundary: state.lastSleepBoundary && typeof state.lastSleepBoundary === 'object' ? state.lastSleepBoundary : null,
    stateAgeMs: age,
  }

  flag('info', 'phase', state.phase)
  if (!['awake', 'sleeping', 'paused'].includes(state.phase)) flag('error', '非法 phase', String(state.phase))

  const sleepSpans = spans.filter((s) => s.sleep)
  if (state.phase === 'sleeping') {
    if (!state.sleepingId) flag('error', 'sleeping 但没有 sleepingId')
    const active = spans.find((s) => s.id === state.sleepingId && s.sleep)
    if (!active) flag('error', 'sleeping 但找不到对应 sleep span', String(state.sleepingId))
    else if (state.sleepUntil != null && Math.abs(Number(state.sleepUntil) - Number(active.until)) > 1000) {
      flag('warn', 'sleepUntil 与 span.until 不一致', `${state.sleepUntil} vs ${active.until}`)
    }
    if (state.sleepUntil != null && Number(state.sleepUntil) < now) flag('warn', '已过 sleepUntil 但仍 sleeping（可能 tick 没跑/暂停）', `过 ${minutes(now - state.sleepUntil)} 分钟`)
  } else {
    if (state.sleepingId) flag('warn', '非 sleeping 但 sleepingId 还在', String(state.sleepingId))
    if (sleepSpans.length) flag('warn', '非 sleeping 但还有 sleep span', sleepSpans.map((s) => s.id).join(','))
  }
  if (state.phase === 'paused' && !state.pausedAt) flag('warn', 'paused 但 pausedAt 丢失')
  if (state.pausedAt && state.phase !== 'paused') flag('warn', 'pausedAt 残留但 phase=' + state.phase)

  // 睡眠边界：入睡时有在飞回合是合法的"收尾"，但要能看到它结束得多晚/是否被注入打断。
  if (state.sleepBoundary) {
    const b = state.sleepBoundary
    if (b.overrun) flag('warn', '睡眠边界：在飞回合超过 grace', `${b.turnEndedAfterSec ?? '?'}s`)
    if (b.postSleepTurn) flag('warn', '睡眠边界：入睡后出现新回合（疑似直投注入，time 拦不到 session/prompt）', '')
    if (b.turnEndedAt == null && state.phase === 'sleeping') {
      const ageSec = Math.round((now - Number(b.at)) / 1000)
      if (ageSec > 120) flag('info', '睡眠边界：入睡时的在飞回合仍未结束', `${ageSec}s`)
    }
  }
  if (state.lastSleepBoundary?.postSleepTurn) flag('warn', '上次睡眠边界：入睡后出现新回合', '')

  // 安排本身：到点没响/没入睡要能在半夜被发现
  const schedules = Array.isArray(state.schedules) ? state.schedules : []
  if (!schedules.length) flag('warn', '没有任何安排（模型可能没排上作息）')
  for (const schedule of schedules) {
    if (schedule.sleep && !Array.isArray(schedule.allow)) {
      flag('info', 'sleep allow 未显式配置（默认只放 admin，MC 事件会积压）', schedule.id)
    }
    const atMs = Date.parse(String(schedule.at))
    if (!Number.isFinite(atMs) || atMs >= now) continue
    const keyPrefix = `${schedule.id}@`
    const hasFired = Object.keys(fired).some((key) => key.startsWith(keyPrefix))
    if (!hasFired) {
      flag('warn', '安排已到点但 fired 缺失（tick 可能没跑）', `${schedule.id} at=${schedule.at} 已过 ${minutes(now - atMs)} 分钟`)
    }
    if (schedule.sleep && state.phase !== 'sleeping' && !sleepSpans.length) {
      const late = minutes(now - atMs)
      if (late > 10) flag('warn', 'sleep 安排到点但没进入睡眠', `${schedule.id} 已过 ${late} 分钟`)
      else flag('info', 'sleep 安排刚到点（10 分钟内应入睡）', schedule.id)
    }
  }

  if (queue.length > 500) flag('error', '积压超过 maxQueue 默认上限', String(queue.length))
  for (const reason of Object.keys(out.time.queue.byReason)) {
    if (!['paused', 'sleeping', 'muted', 'muted-quota'].includes(reason)) flag('warn', '未知积压 reason', reason)
  }
  const repeatedFired = Object.keys(fired).filter((key) => {
    const match = /^(.*)@(\d{4}-\d{2}-\d{2})$/.exec(key)
    return match && Object.keys(fired).some((other) => other !== key && other.startsWith(`${match[1]}@`) && other.endsWith(match[2]))
  })
  if (repeatedFired.length) flag('warn', '同一天同安排出现多个 fired 键', repeatedFired.join(','))

  for (const side of ['tick-error.json', 'inbox-error.json']) {
    const file = path.join(stateDir, side)
    if (fs.existsSync(file)) flag('error', `${side} 存在`, `age=${minutes(statAge(file) ?? 0)} 分钟`)
  }
  const corrupt = (() => { try { return fs.readdirSync(stateDir).filter((n) => n.includes('.corrupt-')) } catch { return [] } })()
  if (corrupt.length) flag('warn', '存在坏状态备份（曾读到坏 time.json）', corrupt.join(','))
  if (state.lastTickError) flag('error', 'lastTickError 非空', JSON.stringify(state.lastTickError).slice(0, 200))
  if (state.lastPersistError) flag('error', 'lastPersistError 非空', JSON.stringify(state.lastPersistError).slice(0, 200))
  if (Number(stats.missed) > 0) flag('warn', '有漏响（missed）', String(stats.missed))
  if (Number(stats.dropped) > 0) flag('warn', '有丢弃（dropped/overflow）', JSON.stringify({ dropped: stats.dropped, overflow: stats.overflow, expired: stats.expired }))

  // transcript：只 grep 时间相关文本，拿数量/重复
  const transcriptFile = path.join(runDir, 'transcript.md')
  const transcript = { file: transcriptFile, exists: fs.existsSync(transcriptFile), counts: {}, duplicates: [], tail: [] }
  try {
    const text = fs.readFileSync(transcriptFile, 'utf8')
    const lines = text.split(/\r?\n/)
    const patterns = {
      wake: /该起床|醒了|到点了|整理完了|早上了|天亮了|去睡|晚安/,
      backlog: /积压了 \d+ 条消息|你睡觉时/,
      goalEnd: /目标结束/,
      mute: /静音/,
      error: /失败|错误|error/i,
    }
    for (const [name, re] of Object.entries(patterns)) transcript.counts[name] = lines.filter((line) => re.test(line)).length
    // 只把"time 发来的唤醒/节拍"当作重复唤醒的判据；模型自己说的话、MC 死亡提示不算。
    const userLines = lines.filter((line) => /\buser\/user\b/.test(line)).map((line) => line.trim())
    const wakeUserLines = userLines.filter((line) => patterns.wake.test(line) && !/你刚死了|身体|安全停止|死亡|血量/.test(line))
    const seen = new Map()
    for (const line of wakeUserLines) {
      const textPart = line.replace(/^\d{2}:\d{2}:\d{2}\s+user\/user\s+seq=\d+\s+·\s+/, '')
      seen.set(textPart, (seen.get(textPart) ?? 0) + 1)
    }
    transcript.duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([line, n]) => `${n}x ${line.slice(0, 120)}`)
    transcript.userMessages = userLines.length
    transcript.tail = wakeUserLines.slice(-6).map((line) => line.slice(0, 160))
    if (transcript.duplicates.length) flag('warn', 'transcript 里同一唤醒文本重复', transcript.duplicates.join(' | ').slice(0, 300))
    // 睡眠期直投 user 消息 = 绕过 signals/time gate 的外部注入（driver/supervisor），
    // 不算 time 的拦截失败，但会让"睡眠期静默"的验证结论失真，必须显式记下来。
    if (state.phase === 'sleeping' && Number(state.since) > 0) {
      const since = new Date(Number(state.since))
      const sinceHms = `${String(since.getHours()).padStart(2, '0')}:${String(since.getMinutes()).padStart(2, '0')}:${String(since.getSeconds()).padStart(2, '0')}`
      const injected = userLines.filter((line) => {
        const hms = /^(\d{2}:\d{2}:\d{2})/.exec(line)?.[1]
        return hms != null && hms >= sinceHms
      })
      if (injected.length) {
        flag('warn', '睡眠期出现直投 user 消息（绕过 signals gate，非 time 拦截失败）', `${injected.length} 条；首条：${injected[0].slice(0, 160)}`)
        transcript.sleepInjected = injected.slice(0, 5).map((line) => line.slice(0, 160))
      }
    }
  } catch { transcript.exists = false }
  out.transcript = transcript
  out.ageLabel = age == null ? 'unknown' : `${minutes(age)} 分钟前落盘`
  return out
}

function printHuman(result) {
  const t = result.time ?? {}
  console.log(`== time night check：${result.run} ==`)
  if (result.sessionId) console.log(`session: ${result.sessionId}${result.model ? `  model: ${result.model}` : ''}`)
  console.log(`state: ${result.stateFile ?? '(缺)'}  ${result.ageLabel ?? ''}`)
  if (!result.time) {
    for (const c of result.checks) console.log(`  [${c.level}] ${c.name} ${c.detail}`)
    return
  }
  console.log(`phase: ${t.phase}  sleepingId: ${t.sleepingId ?? '-'}  sleepUntil: ${t.sleepUntil ? new Date(t.sleepUntil).toISOString() : '-'}  pausedAt: ${t.pausedAt ?? '-'}`)
  if (t.schedules?.length) console.log(`schedules: ${t.schedules.map((s) => `${s.id}${s.sleep ? '(sleep)' : ''}${Number.isFinite(Date.parse(String(s.at))) ? `@${new Date(s.at).toISOString()}` : `@${s.at}`}`).join(' ')}`)
  if (t.lock) console.log(`lock: until=${new Date(t.lock.until).toISOString()} reason=${t.lock.reason ?? ''}`)
  console.log(`spans: ${t.spans.length ? t.spans.map((s) => `${s.id}${s.sleep ? '(sleep)' : ''}→${new Date(s.until).toISOString()}`).join(' ') : '-'}`)
  console.log(`goals: ${t.goals.length ? t.goals.map((g) => `${g.id}:${g.theme}(resumes=${g.resumes})`).join(' ') : '-'}`)
  console.log(`queue: ${t.queue.total} 条  reasons=${JSON.stringify(t.queue.byReason)} sources=${JSON.stringify(t.queue.bySource)}`)
  if (t.sleepBoundary) {
    const b = t.sleepBoundary
    console.log(`sleepBoundary: inFlight=${b.inFlight} turnAgeAtEntry=${b.turnAgeAtEntrySec ?? '-'}s turnEndedAfter=${b.turnEndedAfterSec ?? '-'}s postSleepTurn=${Boolean(b.postSleepTurn)} overrun=${Boolean(b.overrun)}`)
  }
  if (t.lastSleepBoundary) {
    const b = t.lastSleepBoundary
    console.log(`lastSleepBoundary: inFlight=${b.inFlight} turnEndedAfter=${b.turnEndedAfterSec ?? '-'}s postSleepTurn=${Boolean(b.postSleepTurn)} overrun=${Boolean(b.overrun)}`)
  }
  console.log(`stats: ${JSON.stringify(t.stats)}`)
  console.log(`firedKeys: ${t.firedKeys.length ? t.firedKeys.join(', ') : '-'}`)
  if (t.lastTickError) console.log(`lastTickError: ${JSON.stringify(t.lastTickError).slice(0, 300)}`)
  if (result.transcript) {
    console.log(`transcript: ${result.transcript.exists ? '有' : '缺'}  counts=${JSON.stringify(result.transcript.counts)}`)
    for (const line of result.transcript.tail ?? []) console.log(`  · ${line}`)
  }
  console.log('checks:')
  for (const c of result.checks) console.log(`  [${c.level}] ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
  const errors = result.checks.filter((c) => c.level === 'error').length
  console.log(`verdict: ${errors ? `FAIL（${errors} 个 error）` : 'OK'}`)
}

/** 巡检用的一行摘要（也写进 --log 的 JSONL）。 */
function compact(result) {
  const t = result.time ?? {}
  const errors = result.checks.filter((c) => c.level === 'error')
  const warns = result.checks.filter((c) => c.level === 'warn')
  return {
    at: new Date().toISOString(),
    run: result.run,
    phase: t.phase ?? null,
    sleepingId: t.sleepingId ?? null,
    schedules: t.schedules?.map((s) => s.id) ?? [],
    queue: t.queue?.total ?? null,
    queueReasons: t.queue?.byReason ?? null,
    spans: t.spans?.map((s) => s.id) ?? [],
    firedKeys: t.firedKeys ?? [],
    sleepBoundary: t.sleepBoundary ? {
      inFlight: Boolean(t.sleepBoundary.inFlight),
      turnEndedAfterSec: t.sleepBoundary.turnEndedAfterSec ?? null,
      postSleepTurn: Boolean(t.sleepBoundary.postSleepTurn),
      overrun: Boolean(t.sleepBoundary.overrun),
    } : null,
    lastSleepBoundary: t.lastSleepBoundary ? {
      inFlight: Boolean(t.lastSleepBoundary.inFlight),
      turnEndedAfterSec: t.lastSleepBoundary.turnEndedAfterSec ?? null,
      postSleepTurn: Boolean(t.lastSleepBoundary.postSleepTurn),
      overrun: Boolean(t.lastSleepBoundary.overrun),
    } : null,
    stats: t.stats ?? null,
    errors: errors.map((c) => `${c.name}${c.detail ? `:${String(c.detail).slice(0, 120)}` : ''}`),
    warns: warns.map((c) => `${c.name}${c.detail ? `:${String(c.detail).slice(0, 120)}` : ''}`),
    transcript: result.transcript ? { counts: result.transcript.counts, duplicates: result.transcript.duplicates } : null,
  }
}

function appendLog(line) {
  if (!logFile) return
  try {
    fs.mkdirSync(path.dirname(path.resolve(logFile)), { recursive: true })
    fs.appendFileSync(path.resolve(logFile), `${JSON.stringify(line)}\n`, 'utf8')
  } catch (error) { console.error(`[watch] 写日志失败：${String(error?.message ?? error)}`) }
}

const runArg = arg('--run', null)

if (loopMode) {
  const started = Date.now()
  let ticks = 0
  console.log(`[watch] start interval=${intervalSec}s maxHours=${maxHours} log=${logFile ?? '(stdout only)'} nightOnly=${nightOnly}`)
  while (Date.now() - started < maxHours * 3_600_000) {
    ticks += 1
    const run = runArg ? { dir: path.resolve(runArg) } : newestRun({ onlyNight: nightOnly })
    let line
    if (!run?.dir) {
      line = { at: new Date().toISOString(), waiting: true, nightOnly }
    } else {
      try { line = compact(analyse(run.dir)) } catch (error) { line = { at: new Date().toISOString(), run: path.basename(run.dir), error: String(error?.message ?? error) } }
    }
    console.log(JSON.stringify(line))
    appendLog(line)
    if (line.errors?.length) console.log(`[watch] ANOMALY ${line.run}: ${line.errors.join(' | ')}`)
    await sleep(intervalSec * 1000)
  }
  console.log(`[watch] done ticks=${ticks}`)
  process.exit(0)
}

const run = runArg ? { dir: path.resolve(runArg) } : newestRun({ onlyNight: nightOnly })
if (!run?.dir) {
  console.error('找不到 lab run：用 --run <runDir|stateDir> 指定（--night-only 需要名字带 night 的 run）')
  process.exit(2)
}
const result = analyse(run.dir)
if (asJson) console.log(JSON.stringify(result, null, 2))
else printHuman(result)
