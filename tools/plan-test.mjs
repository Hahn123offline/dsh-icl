// 给一个测试会话预写时间安排：先勤催着干活（nudge），到点睡觉，睡醒自动整理。
//
//   node tools/plan-test.mjs --workspace <dir> --in 2 --duration 3
//   node tools/plan-test.mjs --workspace <dir> --in 30 --duration 480 --nudge-every 8
//
// 写的是 <workspace>/time.json，会话里的 time 插件启动时会读它。
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback }

const workspace = path.resolve(arg('--workspace', path.join(process.cwd(), 'state', 'test-a')))
const inMin = arg('--in', null)
const at = arg('--at', null)
const durationMin = Number(arg('--duration', '3'))
const message = arg('--message', '到整理时间了。把今天的经历放下，我要把它们沉淀成记忆；三分钟后回来。')
const nudgeEvery = Number(arg('--nudge-every', '0')) || 0
const goalTheme = arg('--goal-theme', null)
const goalMin = Number(arg('--goal-min', '0')) || 0

if (!inMin && !at) {
  console.error('用法：node tools/plan-test.mjs --workspace <dir> [--in 2 | --at ISO] [--duration 3] [--nudge-every 8]')
  process.exit(2)
}

const startMs = at ? Date.parse(at) : Date.now() + Number(inMin) * 60_000
const startAt = new Date(startMs).toISOString()

// 在"开始采集"和"整理时间"之间，每隔 nudgeEvery 分钟提醒一次继续，别提前收工
const schedules = []
if (goalTheme && goalMin > 0) {
  schedules.push({
    id: 'test-goal',
    mode: 'goal',
    kind: 'span',
    at: new Date().toISOString(),
    durationMin: goalMin,
    theme: goalTheme,
    turnLimit: null,
    allow: [{ from: 'admin' }],
  })
}
if (nudgeEvery > 0) {
  for (let t = Date.now() + nudgeEvery * 60_000; t < startMs; t += nudgeEvery * 60_000) {
    schedules.push({
      id: `test-nudge-${t}`,
      mode: 'wake',
      kind: 'single',
      at: new Date(t).toISOString(),
      message: '还没到整理时间。接着采集，别急着收工——再找一个你没见过的说法。',
      sleep: false,
      allow: [{ from: 'admin' }],
    })
  }
}
schedules.push({
  id: 'test-sleep',
  mode: 'wake',
  kind: 'span',
  at: startAt,
  durationMin,
  message,
  sleep: true,
  allow: [{ from: 'admin' }, { from: 'qq', any: ['着火了', '醒醒'] }],
})

const state = {
  phase: 'awake',
  since: Date.now(),
  schedules,
  queue: [],
  goals: [],
  spans: [],
  fired: {},
  sleepingId: null,
  sleepUntil: null,
}
fs.mkdirSync(workspace, { recursive: true })
const file = path.join(workspace, 'time.json')
fs.writeFileSync(file, JSON.stringify(state, null, 1), 'utf8')
console.log(JSON.stringify({ file, startAt, durationMin, nudges: schedules.length - 1, message }, null, 1))
