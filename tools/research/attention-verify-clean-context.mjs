// 注意力 V1 的干净上下文验证（不调模型、不碰 live）：
//   1) 静态提示词（prompts/sim.md）已经写了 L1/L2/no-op 策略，不依赖聊天里恰好有口头指令；
//   2) 条件心跳有 pending 时发决策简报，没有 pending 时不叫醒；
//   3) 长静默封顶后仍醒一次并给自由活动清单。
// 用法：node .state/lab/lead/attention-research/verify-clean-context.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../../packages/core/src/index.mjs'
import * as memory from '../../packages/plugins/memory/src/index.mjs'
import * as world from '../../packages/plugins/world-state/src/index.mjs'
import * as note from '../../packages/plugins/note/src/index.mjs'
import * as focus from '../../packages/plugins/focus/src/index.mjs'
import * as time from '../../packages/plugins/time/src/index.mjs'
import memoryManifest from '../../packages/plugins/memory/manifest.json' with { type: 'json' }
import worldManifest from '../../packages/plugins/world-state/manifest.json' with { type: 'json' }
import noteManifest from '../../packages/plugins/note/manifest.json' with { type: 'json' }
import focusManifest from '../../packages/plugins/focus/manifest.json' with { type: 'json' }
import timeManifest from '../../packages/plugins/time/manifest.json' with { type: 'json' }

const checks = []
const check = (name, ok, detail = '') => { checks.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 600) }); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${String(detail).slice(0, 240)}` : ''}`) }

const repo = path.resolve(import.meta.dirname, '../..')
const sim = fs.readFileSync(path.join(repo, 'prompts/sim.md'), 'utf8')
check('静态 sim.md：L1 处理（有人等）', sim.includes('有人找你、有消息在等你'))
check('静态 sim.md：L2 自己的时间（不主动对外）', sim.includes('完全没人找你') && sim.includes('不主动找人'))
check('静态 sim.md：no-op 合法（不用回状态）', sim.includes('可以什么都不做') && sim.includes('不用回一句状态'))
check('静态 sim.md：focus 用法（多步先进入）', sim.includes('先 focus_enter') && sim.includes('做完/放弃就 focus_leave'))

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attention-clean-'))
let virtualNow = Date.parse('2026-11-15T10:00:00+08:00')
const host = createHost({ now: () => virtualNow })
host.registerPlugin(memoryManifest, memory, { config: { root } })
host.registerPlugin(worldManifest, world)
host.registerPlugin(noteManifest, note)
host.registerPlugin(focusManifest, focus)
host.registerPlugin(timeManifest, time, {
  config: {
    stateFile: path.join(root, 'time.json'), tickMs: 3_600_000,
    heartbeat: { baseMinSec: 60, baseMaxSec: 60, frequency: 1, longSilenceSec: 600, backoffFactor: 2, maxBackoffMul: 12 },
  },
})
for (const id of ['memory', 'world-state', 'note', 'focus', 'time']) await host.enable(id)
const timeApi = host.shared.get('time')
const turnEnd = () => host.services.signals.emit({ from: { plugin: 'dsh' }, kind: 'event', text: 'turn-end', tags: ['turn-end'] })
const drain = () => host.services.delivery.drain('session').map((batch) => String(batch.text ?? '')).join('\n')
const tickTo = async (ms) => { virtualNow += ms; await timeApi.tick(virtualNow) }

// 1) 没有 pending：turn-end 后到点不叫醒，退避增长。
turnEnd()
check('空状态：先排了心跳', Number(timeApi.status().heartbeat.globalDueAt) > virtualNow, JSON.stringify(timeApi.status().heartbeat.globalDueAt))
await tickTo(61_000)
const empty = drain()
check('空状态：到点不叫醒（无 turn）', empty.length === 0, empty)
check('空状态：记了 skip 并拉长间隔', timeApi.status().heartbeat.skips === 1 && timeApi.status().heartbeat.backoffMul > 1, JSON.stringify({ skips: timeApi.status().heartbeat.skips, mul: timeApi.status().heartbeat.backoffMul }))

// 2) 有 focus 积压：下一次到点发决策简报。
host.services.focus.enter({ label: 'act:read', title: '看群消息' })
host.services.signals.offer({ from: { plugin: 'qq' }, kind: 'content', text: '[QQ群·C4 412] 有人在刷屏测试', focus: 'qq:group:1057812765' })
check('积压已进入 focus', host.services.focus.backlog().reduce((n, row) => n + row.count, 0) === 1, JSON.stringify(host.services.focus.backlog()))
let brief = ''
for (let i = 0; i < 10 && !brief; i += 1) {
  const due = Number(timeApi.status().heartbeat.globalDueAt) || virtualNow + 60_000
  virtualNow = Math.max(virtualNow + 1_000, due)
  await timeApi.tick(virtualNow)
  brief += drain()
}
check('有积压：发决策简报', brief.includes('【心跳】') && brief.includes('等你：'), brief)
check('有积压：简报给群名与条数', brief.includes('C4 412群 +1'), brief)
check('有积压：简报允许 no-op', brief.includes('什么都不做') && brief.includes('不回也不失礼'), brief)
check('有积压：简报提示 focus 用法', brief.includes('focus_enter') && brief.includes('focus_leave'), brief)
check('有积压：简报声明只接在等的事', brief.includes('只接在等你的消息'), brief)

// 3) 长静默：清空积压后封顶仍醒一次，给自由活动清单。
host.services.focus.drainBacklog()
turnEnd()
let long = ''
for (let i = 0; i < 12 && !long.includes('你已经安静了'); i += 1) {
  const due = Number(timeApi.status().heartbeat.globalDueAt) || virtualNow + 60_000
  virtualNow = Math.max(virtualNow + 1_000, due)
  await timeApi.tick(virtualNow)
  long += drain()
}
check('长静默：封顶后醒一次', long.includes('你已经安静了'), long)
check('长静默：给自由活动清单', long.includes('翻记忆') && long.includes('什么都不做'), long)
check('长静默：lastKind=long-silence', timeApi.status().heartbeat.lastKind === 'long-silence', JSON.stringify(timeApi.status().heartbeat))

const failed = checks.filter((c) => !c.ok)
const report = { at: new Date().toISOString(), ok: failed.length === 0, checks }
const outDir = path.join(process.cwd(), '.state', 'lab', 'attention-research')
fs.mkdirSync(outDir, { recursive: true })
const out = path.join(outDir, 'clean-verify.json')
fs.writeFileSync(out, JSON.stringify(report, null, 2), 'utf8')
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed -> ${out}`)
host.services.delivery.clear?.()
process.exit(failed.length ? 1 : 0)
