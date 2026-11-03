// 给一个测试会话预写时间安排：到点睡觉、睡多久、醒了自动做梦。
//
//   node tools/plan-test.mjs --workspace C:/DSH/qwenstuff/icl/state/test-a \
//     --in 2 --duration 3
//   node tools/plan-test.mjs --workspace ... --at 2026-11-03T21:00 --duration 480
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
const message = arg('--message', '你困了。接下来不会有人打扰你，睡一会儿吧。')

if (!inMin && !at) {
  console.error('用法：node tools/plan-test.mjs --workspace <dir> [--in 2 | --at ISO] [--duration 3]')
  process.exit(2)
}

const startAt = at ?? new Date(Date.now() + Number(inMin) * 60_000).toISOString()
const state = {
  phase: 'awake',
  since: Date.now(),
  schedules: [
    {
      id: 'test-sleep',
      mode: 'wake',
      kind: 'span',
      at: startAt,
      durationMin,
      message,
      sleep: true,
      allow: [{ from: 'admin' }, { from: 'qq', any: ['着火了', '醒醒'] }],
    },
  ],
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
console.log(JSON.stringify({ file, startAt, durationMin, message }, null, 1))
