// 时间模块验收：arm → wake → sleep → dream → wake → backlog 释放。
// 不连真实会话：用一个收集器代替 push，把每条消息记下来。
//
//   node tools/time-accept.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost, createSessionAdapter } from '../packages/core/src/index.mjs'
import * as time from '../packages/plugins/time/src/index.mjs'
import * as world from '../packages/plugins/world-state/src/index.mjs'
import timeManifest from '../packages/plugins/time/manifest.json' with { type: 'json' }
import worldManifest from '../packages/plugins/world-state/manifest.json' with { type: 'json' }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'time-accept-'))
const host = createHost({ log: () => {} })
host.registerPlugin(worldManifest, world, {})
host.registerPlugin(timeManifest, time, { config: { stateFile: path.join(root, 'time.json'), tickMs: 3600_000 } })
await host.enable('world-state')

// dream 用事件替身：真实 dream 插件订阅的就是 sleep-start
let dreamCalls = 0
host.services.signals.on({ kind: 'event', tags: ['sleep'] }, (signal) => {
  if (signal.text === 'sleep-start') dreamCalls += 1
})

await host.enable('time')
const api = host.shared.get('time')

const received = []
const adapter = createSessionAdapter({ sessionId: 'accept', host, push: async (text) => { received.push({ at: api.now(), text }) } })

const steps = []
const check = (name, ok, detail = '') => {
  steps.push({ name, ok, detail })
  console.log(ok ? `✓ ${name}` : `✗ ${name}${detail ? ` — ${detail}` : ''}`)
}

// 1. arm 一条 1 分钟后的唤醒（用当前时间前移让它立刻到点）
const past = new Date(Date.now() - 60_000).toISOString()
const armed = api.add({ id: 'arm-test', at: past, message: '时间到了，该动了' })
check('arm 创建日程', Boolean(armed?.id), JSON.stringify(armed))

// 2. 到点触发
api.setClock(() => Date.now())
await api.tick(Date.now())
await adapter.drainOnce()
check('到点收到 wake 消息', received.some((r) => r.text.includes('时间到了')), JSON.stringify(received.map((r) => r.text)))

// 3. 睡觉：并行触发 dream
recovered: {
  const before = dreamCalls
  await api.sleep({ message: '你困了，去睡吧', durationMin: 0 })
  await new Promise((r) => setTimeout(r, 10))
  check('睡觉进入 sleeping', api.phase() === 'sleeping', api.phase())
  check('睡觉并行触发 dream', dreamCalls > before, String(dreamCalls))
}

// 4. 睡眠期间普通消息被拦截
host.services.signals.offer({ from: { plugin: 'qq' }, kind: 'content', text: '有人在吗' })
check('睡眠期间消息被拦截', api.status().backlog === 1, String(api.status().backlog))

// 5. 醒来批释放
await api.wake()
await adapter.drainOnce()
check('醒来发出积压批次', received.some((r) => r.text.includes('积压') && r.text.includes('有人在吗')), '')

// 6. goal：创建 → resume
api.addGoal({ theme: '验收目标', afterMin: 5 })
await adapter.drainOnce()
const afterGoal = received.length
await adapter.drainOnce()
check('目标停下后会被 resume', received.length > afterGoal, `${afterGoal} → ${received.length}`)
api.removeGoal(api.goals()[0]?.id ?? '')
check('目标卸载', api.goals().length === 0, '')

// 7. 控制后门：inbox 命令
const inbox = path.join(root, 'time.inbox.jsonl')
fs.writeFileSync(inbox, `${JSON.stringify({ id: 'c1', cmd: 'status', args: {} })}\n`, 'utf8')
const out = api.processInbox()
const outbox = fs.readFileSync(path.join(root, 'time.outbox.jsonl'), 'utf8')
check('inbox 命令被执行并回写 outbox', out.processed === 1 && outbox.includes('"c1"'), String(out.processed))

adapter.dispose()
const failed = steps.filter((s) => !s.ok)
console.log(`\n${steps.length - failed.length}/${steps.length} 通过`)
process.exit(failed.length ? 1 : 0)
