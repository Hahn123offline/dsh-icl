// compactWake A/B：同一 lab run 场景（time 唤醒/目标/清醒节拍）下跑 baseline vs compact。
//
// 用法：
//   node tools/compact-wake-ab.mjs run --run <runId> [--rounds 6] [--gap 40]
//   node tools/compact-wake-ab.mjs analyze --base <runId> --compact <runId> [--out docs/PROMPT-WAKE-RESULT.md]
//
// 只读 lab 产物（time-events/events/transcript），驱动只发普通用户回合 + 通过 time 控制后门
// 注入 schedule/goal（不碰 MC/body/desktop）。B 开关在 lab up 时用 `--compact-wake` 控制。
import fs from 'node:fs'
import path from 'node:path'
import {
  REPO_ROOT, apiFor, countTurnEnds, loadCurrent, nowIso, promptSession, readJson, readRunMeta,
  runDirOf, sleep,
} from './lab-lib.mjs'

const args = process.argv.slice(2)
const cmd = args[0] ?? 'run'
const arg = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback }

function resolveRun(runId = null) {
  const id = runId ?? arg('--run') ?? loadCurrent()?.runId ?? null
  if (!id) throw new Error('没有 run：先 `node tools/lab.mjs up ...` 或传 --run')
  const runDir = runDirOf(id)
  const meta = readRunMeta(id)
  if (!meta) throw new Error(`没有 run ${id} 的 lab.json`)
  return { id, runDir, meta }
}

function presetStateDir(run) {
  const preset = String(run.meta.preset ?? 'icl-lab')
  return path.join(run.runDir, 'state', preset)
}

function inboxLine(id, cmdName, payload) {
  return `${JSON.stringify({ id, at: Date.now(), cmd: cmdName, args: payload })}\n`
}

async function run() {
  const run = resolveRun()
  if (!run.meta.sessionId) throw new Error('run 没有 sessionId')
  const stateDir = presetStateDir(run)
  const inbox = path.join(stateDir, 'time.inbox.jsonl')
  fs.mkdirSync(stateDir, { recursive: true })
  const rounds = Number(arg('--rounds', 6))
  const gapMs = Number(arg('--gap', 40)) * 1000
  const api = apiFor(run.meta.port)
  const eventsFile = path.join(run.runDir, 'events.jsonl')

  // 1) 通过 time 控制后门注入：goal + 多组 schedule wake（唤醒类消息，不依赖模型自己调工具）。
  const lines = []
  lines.push(inboxLine('ab-goal', 'arrange', { mode: 'goal', theme: 'AB：把背包整理好', afterMin: 1, resumeLimit: 30 }))
  const wakeAt = [25, 85, 145, 205, 265, 325, 385]
  wakeAt.forEach((sec, i) => {
    lines.push(inboxLine(`ab-wake-${i + 1}`, 'arrange', {
      id: `ab-wake-${i + 1}`,
      mode: 'wake',
      in: `${sec}s`,
      message: `AB 唤醒 ${i + 1}：看一眼现在的时间、背包和目标；有新东西就继续处理。`,
    }))
  })
  fs.appendFileSync(inbox, lines.join(''), 'utf8')
  console.log(`[ab] 注入 ${lines.length} 条 time 控制命令 → ${inbox}`)

  // 2) 普通用户回合之间让出时间，让 schedule/goal/awake tick 真正投递。
  const prompts = [
    '用一句话说你现在在做什么。',
    '如果背包里东西太乱，你下一步会先整理哪一类？一句话。',
    '现在最想完成的一件小事是什么？',
    '说说你刚才有没有被打断，打断了在做什么。',
    '接下来十分钟你打算怎么安排？',
    '用一句话总结你现在的状态。',
  ]
  const started = Date.now()
  for (let i = 0; i < rounds; i += 1) {
    const text = prompts[i % prompts.length]
    const baseline = countTurnEnds(eventsFile)
    const t0 = Date.now()
    await promptSession(api, run.meta.sessionId, text)
    while (Date.now() - t0 < 180_000) {
      if (countTurnEnds(eventsFile) > baseline) break
      await sleep(300)
    }
    if (countTurnEnds(eventsFile) <= baseline) throw new Error(`第 ${i + 1} 轮等 turn/end 超时`)
    console.log(`[ab] 第 ${i + 1}/${rounds} 轮完成（${Math.round((Date.now() - t0) / 1000)}s）`)
    if (i < rounds - 1) await sleep(gapMs)
  }
  // 收尾：等最后的 wake 投递/回合
  await sleep(30_000)
  const elapsedMin = Math.round((Date.now() - started) / 60_000)
  console.log(`[ab] run=${run.id} 场景完成（约 ${elapsedMin} 分钟，${rounds} 轮）`)
}

/* ───────────────────────── analyze ───────────────────────── */

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  } catch { return [] }
}

function eventList(runDir) {
  const events = []
  for (const line of readJsonl(path.join(runDir, 'events.jsonl'))) {
    const payload = line.payload ?? line
    if (payload?.type !== 'session/event') continue
    const event = payload.event
    if (!event) continue
    const text = (event.data?.content ?? []).filter?.((part) => part?.type === 'text').map((part) => part.text).join('') ?? ''
    events.push({ seq: event.seq, type: event.type, at: Number(event.time) || 0, kind: event.data?.source?.kind ?? null, text })
  }
  return events.sort((a, b) => a.seq - b.seq)
}

function percentile(rows, p) {
  if (!rows.length) return null
  const sorted = [...rows].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]
}

function analyseRun(runId) {
  const runDir = runDirOf(runId)
  const meta = readRunMeta(runId)
  const preset = String(meta?.preset ?? 'icl-lab')
  const stateDir = path.join(runDir, 'state', preset)
  const timeEvents = readJsonl(path.join(stateDir, 'time-events.jsonl'))
  const wakeEvents = timeEvents.filter((event) => event.type === 'wake-class')
  const byProducer = {}
  for (const event of wakeEvents) {
    const row = byProducer[event.producer] ?? { count: 0, chars: 0, modes: {} }
    row.count += 1
    row.chars += Number(event.chars) || 0
    row.modes[event.mode ?? '?'] = (row.modes[event.mode ?? '?'] ?? 0) + 1
    byProducer[event.producer] = row
  }
  const events = eventList(runDir)
  const userMessages = events.filter((event) => event.type === 'user/message')
  const bySource = {}
  let totalChars = 0
  for (const event of userMessages) {
    const kind = String(event.kind ?? 'unknown')
    const row = bySource[kind] ?? { count: 0, chars: 0 }
    row.count += 1
    row.chars += event.text.length
    bySource[kind] = row
    totalChars += event.text.length
  }
  const qqWakes = userMessages.filter((event) => /^\[QQ(主动检查|主动提醒|积压提醒)\]/.test(event.text))
  const allWakes = wakeEvents
  // turn-gap：turn/end → 下一 turn/start
  const gaps = []
  const turnStarts = events.filter((event) => event.type === 'turn/start')
  const turnEnds = events.filter((event) => event.type === 'turn/end')
  for (const end of turnEnds) {
    const next = turnStarts.find((start) => start.seq > end.seq)
    if (next && next.at >= end.at) gaps.push(Math.round((next.at - end.at) / 1000))
  }
  // wake → 下一 turn/start 反应时延
  const wakeToStart = []
  for (const wake of wakeEvents) {
    const next = turnStarts.find((start) => start.at >= Number(wake.at))
    if (next) wakeToStart.push(Math.max(0, Math.round((next.at - Number(wake.at)) / 1000)))
  }
  // 当事人原话：transcript 里包含唤醒关键词的助手行
  let transcript = ''
  try { transcript = fs.readFileSync(path.join(runDir, 'transcript.md'), 'utf8') } catch { /* ignore */ }
  const quotes = []
  for (const line of transcript.split(/\r?\n/)) {
    const text = line.replace(/^[-*]\s*/, '').trim()
    if (text.length < 8) continue
    if (!/(背包|整理|时间|继续|打断|目标|提醒|刚才)/.test(text)) continue
    if (text.startsWith('#') || text.startsWith('>')) continue
    quotes.push(text.slice(0, 160))
    if (quotes.length >= 6) break
  }
  return {
    runId,
    preset,
    rounds: meta?.rounds ?? null,
    wakeClass: {
      count: allWakes.length,
      chars: allWakes.reduce((sum, event) => sum + (Number(event.chars) || 0), 0),
      byProducer,
      modes: allWakes.reduce((acc, event) => { acc[event.mode ?? '?'] = (acc[event.mode ?? '?'] ?? 0) + 1; return acc }, {}),
    },
    qqWake: { count: qqWakes.length, chars: qqWakes.reduce((sum, event) => sum + event.text.length, 0) },
    userMessages: { count: userMessages.length, chars: totalChars, bySource },
    turnGapSec: { count: gaps.length, p50: percentile(gaps, 0.5), p95: percentile(gaps, 0.95), max: gaps.length ? Math.max(...gaps) : null },
    wakeToStartSec: { count: wakeToStart.length, p50: percentile(wakeToStart, 0.5), p95: percentile(wakeToStart, 0.95), max: wakeToStart.length ? Math.max(...wakeToStart) : null },
    quotes,
  }
}

function analyze() {
  const baseId = arg('--base')
  const compactId = arg('--compact')
  if (!baseId || !compactId) throw new Error('用法：analyze --base <runId> --compact <runId> [--out docs/PROMPT-WAKE-RESULT.md]')
  const base = analyseRun(baseId)
  const compact = analyseRun(compactId)
  const drop = (a, b) => (a > 0 ? Math.round((1 - b / a) * 1000) / 10 : null)
  const summary = {
    at: nowIso(),
    base, compact,
    delta: {
      wakeClassCharsPct: drop(base.wakeClass.chars, compact.wakeClass.chars),
      totalDeliveredCharsPct: drop(base.userMessages.chars, compact.userMessages.chars),
      turnGapP95: [base.turnGapSec.p95, compact.turnGapSec.p95],
      wakeToStartP95: [base.wakeToStartSec.p95, compact.wakeToStartSec.p95],
    },
  }
  const outJson = path.join(runDirOf(baseId), '..', '..', 'compact-wake-ab.json')
  fs.writeFileSync(path.resolve(outJson), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  const outMd = arg('--out')
  if (outMd) fs.writeFileSync(path.resolve(outMd), renderResult(summary), 'utf8')
  console.log(JSON.stringify(summary, null, 2))
}

function renderResult(s) {
  const pct = (value) => value == null ? '—' : `${value}%`
  const rows = Object.entries(s.base.wakeClass.byProducer).map(([producer, base]) => {
    const compact = s.compact.wakeClass.byProducer[producer] ?? { count: 0, chars: 0 }
    return `| ${producer} | ${base.count} / ${base.chars} | ${compact.count} / ${compact.chars} | ${pct((base.chars > 0 ? Math.round((1 - compact.chars / base.chars) * 1000) / 10 : null))} |`
  }).join('\n')
  return `# compactWake A/B 结果（B）\n\n> 生成：${s.at}\n> baseline run：\`${s.base.runId}\` · compact run：\`${s.compact.runId}\`\n> 指标从 lab 的 \`time-events.jsonl\`（wake-class）、\`events.jsonl\`（投递字符/turn）、\`transcript.md\`（原话）离线计算；只改 time 唤醒提示，不动 system/sim/persona。\n\n## 1. 结论数字\n\n| 指标 | baseline | compact | 变化 |\n|---|---|---|---|\n| wakeClass 字符（time 唤醒类） | ${s.base.wakeClass.chars} | ${s.compact.wakeClass.chars} | ↓ ${pct(s.delta.wakeClassCharsPct)} |\n| wakeClass 条数 | ${s.base.wakeClass.count} | ${s.compact.wakeClass.count} | — |\n| 总投递字符（user/message） | ${s.base.userMessages.chars} | ${s.compact.userMessages.chars} | ↓ ${pct(s.delta.totalDeliveredCharsPct)} |\n| turn-gap p50 / p95 / max | ${s.base.turnGapSec.p50 ?? '—'} / ${s.base.turnGapSec.p95 ?? '—'} / ${s.base.turnGapSec.max ?? '—'} | ${s.compact.turnGapSec.p50 ?? '—'} / ${s.compact.turnGapSec.p95 ?? '—'} / ${s.compact.turnGapSec.max ?? '—'} | — |\n| wake→下一 turn-start p95 | ${s.base.wakeToStartSec.p95 ?? '—'} | ${s.compact.wakeToStartSec.p95 ?? '—'} | — |\n| QQ 唤醒条数 / 字符 | ${s.base.qqWake.count} / ${s.base.qqWake.chars} | ${s.compact.qqWake.count} / ${s.compact.qqWake.chars} | — |\n\n## 2. wakeClass 按 producer（条数 / 字符）\n\n| producer | baseline | compact | 字符下降 |\n|---|---|---|---|\n${rows || '| （无 wake-class） | 0 / 0 | 0 / 0 | — |'}\n\n## 3. 分桶（time-events）\n\n- baseline：${JSON.stringify(s.base.wakeClass.modes)}\n- compact：${JSON.stringify(s.compact.wakeClass.modes)}\n\n## 4. 当事人原话（transcript 截取，≥3 条）\n\n${(s.compact.quotes.length ? s.compact.quotes : s.base.quotes).map((quote) => `- ${quote}`).join('\n') || '- （本次 transcript 未截到命中关键词的原话）'}\n\n## 5. 判读\n\n- 门槛（设计 §6）：wakeClass 字符 ↓≥50%、总投递字符 ↓≥10%、turn-gap p95 不升、status 调用不升、无忘记目标/漏警报。\n- \`fullEvery=20\` 生效；payload（sleep brief/未读/积压/危险）未压。\n- 已知限制：time 看不到 assistant 原文，time 生产的 compact "上次"写"刚醒/刚连上"；QQ 唤醒若未接 compact 会在 QQ 行单独列出。\n`
}

if (cmd === 'run') run().catch((error) => { console.error(`[ab] ${error?.message ?? error}`); process.exit(1) })
else if (cmd === 'analyze') { try { analyze() } catch (error) { console.error(`[ab] ${error?.message ?? error}`); process.exit(1) } }
else { console.error('用法：node tools/compact-wake-ab.mjs <run|analyze> ...'); process.exit(1) }
