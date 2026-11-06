// 时间模块的控制入口（维护后门）。
//
//   node tools/time.mjs status
//   node tools/time.mjs arrange '{"mode":"wake","in":"10m","message":"该出门了"}'
//   node tools/time.mjs arrange '{"mode":"wake","at":"周一 07:30","message":"周会"}'
//   node tools/time.mjs arrange '{"mode":"goal","theme":"玩我的世界","afterMin":120,"focus":"mc"}'
//   node tools/time.mjs edit '{"id":"s-xxx","in":"30m"}'
//   node tools/time.mjs cancel '{"id":"s-xxx"}'      # 长日程/安排/目标同 id 一起收尾
//   node tools/time.mjs pause
//   node tools/time.mjs resume
//   node tools/time.mjs pause_mode '{"active":true,"reason":"mcb_stop","source":"mc-link"}'
//   node tools/time.mjs mute '{"minutes":30,"reason":"安静一会儿"}'
//   node tools/time.mjs unmute
//   node tools/time.mjs lock
//   node tools/time.mjs sleep '{"durationMin":3,"message":"去睡吧"}'
//   node tools/time.mjs wake
//   node tools/time.mjs queue
//   node tools/time.mjs skip '{"id":"q-1-xxx"}'
//   node tools/time.mjs goal_add '{"theme":"玩我的世界","afterMin":120}'
//   node tools/time.mjs goal_remove '{"id":"g-xxx"}'
//   node tools/time.mjs goal_list
//   node tools/time.mjs reset
//
// 协议是文件邮箱：CLI 往 inbox 追加一行 JSON，时间模块在 tick 里读并执行，
// 结果写 outbox。默认路径可用 --state <time.json 路径> 指定。
// 契约（命令全集、状态机、验收场景）见 docs/TIME.md。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const cmd = args[0]
const arg = (name, fallback = null) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const stateFile = path.resolve(arg('--state', process.env.ICL_TIME_STATE ?? path.join(process.cwd(), 'state', 'time.json')))
const dir = path.dirname(stateFile)
const inbox = path.join(dir, 'time.inbox.jsonl')
const outbox = path.join(dir, 'time.outbox.jsonl')
const waitMs = Number(arg('--wait', '20000'))
const noWait = args.includes('--no-wait')

if (!cmd) {
  console.error('用法：node tools/time.mjs <命令> [JSON 参数] [--state <time.json>] [--no-wait]')
  process.exit(2)
}

let payload = {}
const rawArg = args.slice(1).find((a) => !a.startsWith('--') && a !== arg('--state') && a !== arg('--wait'))
if (rawArg) {
  try { payload = JSON.parse(rawArg) } catch { console.error('参数不是合法 JSON：', rawArg); process.exit(2) }
}

const id = `c-${Date.now()}-${Math.floor(Math.random() * 1000)}`
fs.mkdirSync(dir, { recursive: true })
fs.appendFileSync(inbox, `${JSON.stringify({ id, cmd, args: payload, at: Date.now() })}\n`, 'utf8')
if (noWait) { console.log('已投递：', id); process.exit(0) }

const started = Date.now()
while (Date.now() - started < waitMs) {
  try {
    const lines = fs.readFileSync(outbox, 'utf8').trim().split('\n').filter(Boolean)
    for (const line of lines.reverse()) {
      const entry = JSON.parse(line)
      if (entry.id !== id) continue
      if (entry.ok) console.log(JSON.stringify(entry.result, null, 2))
      else { console.error('命令失败：', entry.error); process.exit(1) }
      process.exit(0)
    }
  } catch { /* 还没写出来 */ }
  await new Promise((r) => setTimeout(r, 300))
}
console.error(`等不到结果（${waitMs}ms）。时间模块在跑吗？inbox：${inbox}`)
process.exit(1)
