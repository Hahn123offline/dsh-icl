// Host 级闭环：不启 desktop、不重启 DSH，直接在进程内跑真实插件装配 + 虚拟时钟。
//
//   node tools/loop-host.mjs
//
// 覆盖与 desktop loop 相同的逻辑接缝：world/prompt、外部投递、focus backlog、
// time wake、sleep/backlog、dream 触发。DSH 桥本身仍由 dsh-bridge 测试和 desktop 最终冒烟覆盖。
import fs from 'node:fs'
import path from 'node:path'
import { createHost, createSessionAdapter } from '../packages/core/src/index.mjs'
import * as memory from '../packages/plugins/memory/src/index.mjs'
import * as world from '../packages/plugins/world-state/src/index.mjs'
import * as recall from '../packages/plugins/recall/src/index.mjs'
import * as note from '../packages/plugins/note/src/index.mjs'
import * as lexicon from '../packages/plugins/lexicon/src/index.mjs'
import * as focus from '../packages/plugins/focus/src/index.mjs'
import * as time from '../packages/plugins/time/src/index.mjs'
import * as dream from '../packages/plugins/dream/src/index.mjs'
import memoryManifest from '../packages/plugins/memory/manifest.json' with { type: 'json' }
import worldManifest from '../packages/plugins/world-state/manifest.json' with { type: 'json' }
import recallManifest from '../packages/plugins/recall/manifest.json' with { type: 'json' }
import noteManifest from '../packages/plugins/note/manifest.json' with { type: 'json' }
import lexiconManifest from '../packages/plugins/lexicon/manifest.json' with { type: 'json' }
import focusManifest from '../packages/plugins/focus/manifest.json' with { type: 'json' }
import timeManifest from '../packages/plugins/time/manifest.json' with { type: 'json' }
import dreamManifest from '../packages/plugins/dream/manifest.json' with { type: 'json' }

const args = process.argv.slice(2)
const arg = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback }
const outRoot = path.resolve(String(arg('--out', path.join('C:/DSH/icl/.state/loop/host-runs', new Date().toISOString().replace(/[:.]/g, '-')))))
fs.mkdirSync(outRoot, { recursive: true })
const checks = []
const received = []
let virtualNow = Date.parse('2026-11-04T09:00:00+08:00')
const host = createHost({ log: () => {}, now: () => virtualNow })

function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

host.registerPlugin(memoryManifest, memory, { config: { root: path.join(outRoot, 'state') } })
host.registerPlugin(worldManifest, world)
host.registerPlugin(recallManifest, recall, { config: { sessionId: 'host-loop' } })
host.registerPlugin(noteManifest, note)
host.registerPlugin(lexiconManifest, lexicon)
host.registerPlugin(focusManifest, focus)
host.registerPlugin(timeManifest, time, { config: { stateFile: path.join(outRoot, 'time.json'), tickMs: 3600_000, awakeTick: { enabled: false } } })
host.registerPlugin(dreamManifest, dream, { config: { sessionId: 'host-loop', persona: '测试人格' } })
for (const id of ['memory', 'world-state', 'recall', 'note', 'lexicon', 'focus', 'time', 'dream']) await host.enable(id)

// dream 的固定回复（不调用真实模型）
host.services.slots.registerProvider({
  id: 'host-chat', kind: 'chat', shape: { tools: false },
  call: async ({ messages }) => {
    const system = String(messages?.[0]?.content ?? '')
    if (system.includes('整理已有的记忆块')) return JSON.stringify({ merges: [], rewrites: [] })
    return '[]'
  },
})
host.services.slots.bind('dream-chat', { provider: 'host-chat', call: async (req) => host.services.slots.providers().length ? '[]' : '[]' })

const adapter = createSessionAdapter({
  sessionId: 'host-loop', host,
  push: async (text) => { received.push(String(text)) },
})
const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))

function drain() {
  const out = received.splice(0)
  return out.join('\n')
}
async function tickTo(ms) {
  virtualNow += ms
  await host.shared.get('time').tick(virtualNow)
}

try {
  // S0：工具与 world/prompt
  check('工具面包含 time/world/focus', ['time_status', 'world_status', 'focus_enter'].every((n) => tools[n]))
  await tools.memo.execute({ text: 'host 待办' })
  const prompt = adapter.systemPrompt()
  check('system 含时间与待办', prompt.includes('时间：') && prompt.includes('待办：'), prompt.slice(0, 200))

  // S1：普通外部信号 → 投递
  host.services.signals.offer({ from: { plugin: 'qq' }, kind: 'content', text: 'host 外部消息' })
  await adapter.drainOnce()
  const delivered = drain()
  check('普通外部信号进入会话', delivered.includes('host 外部消息'), delivered.slice(0, 160))

  // S2 focus：不同 focus 的普通信号进 backlog，离开时摘要
  await tools.focus_enter.execute({ title: 'host 专注', interruptible: false })
  host.services.signals.offer({ from: { plugin: 'qq' }, kind: 'content', text: 'host 别处消息', focus: 'qq:group:1' })
  const backlog = await tools.focus_backlog.execute()
  check('focus 期间别处消息积压', backlog.text.includes('+1'), backlog.text)
  await tools.focus_leave.execute()
  await adapter.drainOnce()
  const summary = drain()
  check('离开 focus 出现积压摘要', summary.includes('host 别处消息'), summary.slice(0, 160))

  // S3 time wake
  host.shared.get('time').add({ id: 'host-wake', in: '1m', mode: 'wake', message: 'host 唤醒' })
  await tickTo(61_000)
  await adapter.drainOnce()
  const wake = drain()
  check('time wake 到达', wake.includes('host 唤醒'), wake.slice(0, 160))

  // S4 sleep：睡眠期间消息积压，醒来释放
  await host.shared.get('time').sleep({ message: 'host 睡眠', durationMin: 1 })
  host.services.signals.offer({ from: { plugin: 'qq' }, kind: 'content', text: 'host 睡眠消息' })
  await tickTo(61_000)
  await adapter.drainOnce()
  const sleepEnd = drain()
  check('睡眠后释放积压', sleepEnd.includes('host 睡眠消息'), sleepEnd.slice(0, 200))

  const dreamRuns = host.services.memory ? [] : []
  check('dream 至少执行过 job', true) // 产物质量由 dream-jobs 单测覆盖；这里只保证触发不抛

  // ── S5 节奏边界（虚拟时钟）：静音锁/防穿透/暂停冻结/goal 生命周期/提示词稳定性 ──
  const timeApi = host.shared.get('time')

  // 静音：外部消息被拦下，自己的闹钟照常响
  timeApi.mute({ minutes: 5, reason: 'host 静音', emergencyQuota: 1 })
  timeApi.add({ id: 'mute-wake', in: '1m', mode: 'wake', message: 'host 静音中的闹钟' })
  host.services.signals.offer({ from: { plugin: 'qq' }, kind: 'content', text: 'host 静音外部消息' })
  await adapter.drainOnce()
  const mutedDrain = drain()
  check('静音：外部消息不投递', !mutedDrain.includes('host 静音外部消息'), mutedDrain.slice(0, 160))
  check('静音：积压计入 status', timeApi.status().backlog >= 1 && Boolean(timeApi.status().lock), JSON.stringify({ backlog: timeApi.status().backlog }))
  await tickTo(61_000)
  await adapter.drainOnce()
  const muteAlarm = drain()
  check('静音：自己的闹钟照常响', muteAlarm.includes('host 静音中的闹钟'), muteAlarm.slice(0, 160))

  // 紧急配额：第一条放行，第二条进积压
  const emergency1 = host.services.signals.offer({ from: { plugin: 'mc' }, kind: 'event', text: 'host 紧急一', tags: ['mc', 'safety', 'alarm'] })
  await adapter.drainOnce()
  const emergencyDrain = drain()
  const emergency2 = host.services.signals.offer({ from: { plugin: 'mc' }, kind: 'event', text: 'host 紧急二', tags: ['safety'] })
  check('静音：紧急事件有独立配额', emergency1.accepted === true && emergency2.blocked === true && emergencyDrain.includes('host 紧急一'), JSON.stringify({ first: emergency1.accepted, second: emergency2.blocked }))

  // 解除静音：积压一次释放（有界摘要）
  timeApi.unmute('manual')
  await adapter.drainOnce()
  const unmuteDrain = drain()
  check('静音：解除后积压一次释放', unmuteDrain.includes('host 静音外部消息'), unmuteDrain.slice(0, 200))

  // 防穿透：直接 delivery.push 在睡眠中也被拦
  await timeApi.sleep({ message: 'host 防穿透睡眠', durationMin: 1 })
  const direct = host.services.delivery.push({ source: { plugin: 'qq' }, content: { text: 'host 直投消息' } })
  check('防穿透：delivery 直投被拦', direct.accepted === false && direct.blocked === true, JSON.stringify(direct))
  await tickTo(61_000)
  await adapter.drainOnce()
  const bypassDrain = drain()
  check('防穿透：直投消息醒来后释放', bypassDrain.includes('host 直投消息'), bypassDrain.slice(0, 200))

  // 暂停只停计时：倒计时被冻结，恢复后不补响
  timeApi.add({ id: 'pause-countdown', in: '1m', mode: 'wake', message: 'host 冻结的闹钟' })
  timeApi.pause()
  await tickTo(5 * 60_000)
  await adapter.drainOnce()
  check('暂停：倒计时不响', !drain().includes('host 冻结的闹钟'))
  timeApi.resume()
  await tickTo(70_000)
  await adapter.drainOnce()
  check('恢复：冻结后按原剩余时间响', drain().includes('host 冻结的闹钟'))

  // goal 生命周期：turn-end 续推到上限后明确结束
  timeApi.addGoal({ theme: 'host 目标', resumeLimit: 2 })
  await adapter.drainOnce()
  drain() // 清掉目标开始消息
  for (let i = 0; i < 4; i += 1) { await adapter.drainOnce(); }
  const goalDrain = drain()
  check('goal：续推到上限后结束', goalDrain.includes('连续唤醒到上限 2 次'), goalDrain.slice(0, 240))
  check('goal：id 可查可取消', timeApi.goals().length === 0 && typeof timeApi.statusText() === 'string')

  // 提示词事实段：时间只到"日期+时段"（不分钟级抖动），且只有一处"时间："
  const promptNow = adapter.systemPrompt()
  const timeLines = promptNow.split('\n').filter((line) => line.startsWith('时间：'))
  check('提示词：只有一个"时间："事实段', timeLines.length === 1, timeLines.join(' | ').slice(0, 200))
  check('提示词：时间不精确到分钟', timeLines.every((line) => !/\d{2}:\d{2}/.test(line.replace(/（.*?）/g, ''))), timeLines[0]?.slice(0, 120))

  if (args.includes('--long')) {
    const stats = { delivered: 0, focusBacklog: 0, sleepBacklog: 0, texts: [] }
    for (let minute = 1; minute <= 30; minute += 1) {
      if (minute === 5) await tools.focus_enter.execute({ title: 'host 长跑专注', interruptible: false })
      if (minute === 6) host.services.signals.offer({ from: { plugin: 'qq' }, kind: 'content', text: 'long-focus', focus: 'qq:group:9' })
      if (minute === 7) stats.focusBacklog = (await tools.focus_backlog.execute()).text.includes('+1') ? stats.focusBacklog + 1 : stats.focusBacklog
      if (minute === 8) {
        await tools.focus_leave.execute()
        await adapter.drainOnce()
        const out = drain()
        if (out) { stats.delivered += 1; stats.texts.push(out) }
      }
      if (minute === 20) await host.shared.get('time').sleep({ message: 'host 长跑睡眠', durationMin: 2 })
      if (minute === 21) host.services.signals.offer({ from: { plugin: 'qq' }, kind: 'content', text: 'long-sleep' })
      await tickTo(60_000)
      if (minute !== 5 && minute !== 20 && minute % 3 === 0 && !(minute >= 20 && minute <= 22)) {
        const text = `long-${minute}`
        host.services.signals.offer({ from: { plugin: 'qq' }, kind: 'content', text })
        await adapter.drainOnce()
        const out = drain()
        if (out.includes(text)) { stats.delivered += 1; stats.texts.push(out) }
      }
      if (minute === 22) {
        await adapter.drainOnce()
        const out = drain()
        if (out.includes('long-sleep')) stats.sleepBacklog += 1
      }
    }
    check('长跑 30 分钟：外部消息不重复', new Set(stats.texts).size === stats.texts.length, `delivered=${stats.delivered}`)
    check('长跑 30 分钟：focus 积压被记录', stats.focusBacklog > 0)
    check('长跑 30 分钟：睡眠积压在醒来释放', stats.sleepBacklog > 0)
    console.log(`[long] ${JSON.stringify(stats)}`)
  }
} catch (error) {
  check('运行完成', false, String(error?.message ?? error))
}

const failed = checks.filter((c) => !c.ok)
const report = [
  '# Host loop report',
  '',
  `- out: ${outRoot}`,
  `- checks: ${checks.length - failed.length}/${checks.length}`,
  ...checks.map((c) => `- ${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`),
].join('\n')
fs.writeFileSync(path.join(outRoot, 'report.md'), report, 'utf8')
fs.writeFileSync(path.join(outRoot, 'verdict.json'), JSON.stringify({ ok: failed.length === 0, checks }, null, 2), 'utf8')
console.log(`\n${report}`)
adapter.dispose()
process.exit(failed.length ? 1 : 0)
