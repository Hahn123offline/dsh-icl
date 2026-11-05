// 时间模块的第二层：静音锁、防穿透、积压可靠性、日程语义（虚拟时钟）。
//
// 与 time.test.mjs 的分工：那边是"基本行为"，这边是"生活节奏的边界条件"：
//   · 静音锁能不能真的拦住外部消息（signals + delivery 两条路），能不能查/恢复/自动到期
//   · 积压有界、释放失败不丢、过期/溢出有计数
//   · 一次性/daily/weekly/倒计时、pause 冻结、漏响计数
//   · silent span、嵌套睡眠、goal 续推上限、取消同 id 收尾
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../src/index.mjs'
import * as time from '../../plugins/time/src/index.mjs'
import * as focus from '../../plugins/focus/src/index.mjs'
import timeManifest from '../../plugins/time/manifest.json' with { type: 'json' }
import focusManifest from '../../plugins/focus/manifest.json' with { type: 'json' }

const MON_0900 = new Date(2026, 10, 2, 9, 0, 0).getTime() // 2026-11-02 周一 09:00（本地时区）

async function boot({ now = () => Date.now(), config = {}, withFocus = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-time-lock-'))
  const host = createHost({ log: () => {}, now })
  if (withFocus) host.registerPlugin(focusManifest, focus, {})
  host.registerPlugin(timeManifest, time, { config: { stateFile: path.join(root, 'time.json'), tickMs: 3_600_000, ...config } })
  if (withFocus) await host.enable('focus')
  await host.enable('time')
  return { host, root, api: host.shared.get('time') }
}

function drainText(host) {
  return host.services.delivery.drain('session').map((batch) => batch.text).join('\n')
}

function restoreSignalDeliver(host) {
  host.services.signals.setDeliver((signal) => {
    host.services.delivery.push({
      to: 'session', channel: 'signal',
      source: { plugin: signal.from.plugin, activity: signal.from.activity ?? 'signal', seq: null },
      content: { text: signal.text },
      batchKey: `signal:${signal.from.plugin}:${signal.focus ?? ''}`,
      exactlyOnce: false,
    })
    return { delivered: true }
  })
}

/* ───────────────────────── 静音锁 ───────────────────────── */

test('静音锁：外部消息进积压、time 自己的闹钟照常响、status 可查', async () => {
  let virtualNow = MON_0900
  const { host, api } = await boot({ now: () => virtualNow })
  api.add({ id: 'wake-during-mute', in: '1m', mode: 'wake', message: '闹钟还是会响' })
  api.mute({ minutes: 30, reason: '需要安静' })
  const blocked = host.services.signals.offer({ from: { plugin: 'qq' }, kind: 'content', text: '外部消息一' })
  assert.equal(blocked.blocked, true)
  assert.equal(blocked.reason, 'muted')
  assert.equal(api.status().backlog, 1)
  assert.ok(api.status().lock.muted)
  assert.match(api.statusText(), /静音：到/)
  virtualNow += 61_000
  api.tick()
  const text = drainText(host)
  assert.match(text, /闹钟还是会响/, '静音不关自己的闹钟')
  assert.doesNotMatch(text, /外部消息一/, '外部消息仍被压着')
  await host.services.signals.offer({}) // 无效信号不该炸
  assert.ok(fs.existsSync(path.join(path.dirname(api.status().schedules.length ? 'x' : 'x'), 'x')) === false)
})

test('静音锁：紧急标签有独立配额，超配额进积压', async () => {
  const { host, api } = await boot()
  api.mute({ minutes: 30, emergencyQuota: 1 })
  const first = host.services.signals.offer({ from: { plugin: 'mc' }, kind: 'event', text: '安全停止', tags: ['mc', 'safety', 'alarm'] })
  assert.equal(first.accepted, true, '紧急事件在配额内必须放行')
  host.services.signals.offer({ from: { plugin: 'mc' }, kind: 'event', text: '第二条紧急', tags: ['safety'] })
  const state = api.status()
  assert.equal(state.lock.emergency.used, 1)
  assert.equal(state.backlog, 1)
  assert.equal(api.queue()[0].reason, 'muted-quota')
  assert.match(drainText(host), /安全停止/)
})

test('静音锁：到期自动解除并释放有界摘要', async () => {
  let virtualNow = MON_0900
  const { host, api } = await boot({ now: () => virtualNow })
  api.mute({ minutes: 1 })
  host.services.signals.offer({ from: { plugin: 'qq' }, kind: 'content', text: '到点前的一条' })
  virtualNow += 61_000
  api.tick()
  assert.equal(api.status().lock, null, '到期必须自动解除，不能把系统卡死')
  const text = drainText(host)
  assert.match(text, /静音到点/)
  assert.match(text, /到点前的一条/)
  assert.equal(api.status().backlog, 0)
})

test('静音锁：手动解除立即释放并返回条数', async () => {
  const { host, api } = await boot()
  api.mute({ minutes: 30 })
  host.services.signals.offer({ from: { plugin: 'qq' }, kind: 'content', text: '手动解除测试' })
  const out = api.unmute('manual')
  assert.equal(out.released, 1)
  assert.equal(api.status().lock, null)
  assert.match(drainText(host), /手动解除测试/)
  assert.equal(api.unmute().muted, false, '二次解除要如实说没有静音')
})

test('静音与睡眠在状态/积压里可区分；静音优先', async () => {
  const { host, api } = await boot()
  api.sleep({ message: '睡了', durationMin: 30 })
  host.services.signals.offer({ from: { plugin: 'qq' }, kind: 'content', text: '睡眠消息' })
  assert.equal(api.status().phase, 'sleeping')
  assert.equal(api.queue()[0].reason, 'sleeping')

  api.mute({ minutes: 10, reason: '叠一层静音' })
  assert.equal(api.status().phase, 'sleeping')
  assert.ok(api.status().lock.muted)
  host.services.signals.offer({ from: { plugin: 'qq' }, kind: 'content', text: '静音消息' })
  assert.equal(api.queue()[1].reason, 'muted', '静音优先于睡眠白名单')
  const list = api.listText()
  assert.match(list, /睡眠消息（sleeping）/)
  assert.match(list, /静音消息（muted）/)
  api.unmute('manual')
})

test('time 工具面：静音可查、可恢复', async () => {
  const { host } = await boot()
  const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))
  assert.ok(tools.time_mute && tools.time_unmute, '工具清单里有静音锁')
  const muted = await tools.time_mute.execute({ minutes: 5, reason: '看一下' })
  assert.match(muted.text, /静音了：到/)
  const status = await tools.time_status.execute()
  assert.match(status.text, /静音：到/)
  const unmuted = await tools.time_unmute.execute()
  assert.match(unmuted.text, /解除静音/)
})

/* ───────────────────────── 防穿透 ───────────────────────── */

test('ctx.delivery.push 直投也被拦（delivery push-time gate）', async () => {
  const { host, api } = await boot()
  api.sleep({ message: '睡', durationMin: 60 })
  const direct = host.services.delivery.push({ source: { plugin: 'qq' }, content: { text: '绕过 signals 的直投' } })
  assert.equal(direct.accepted, false)
  assert.equal(direct.blocked, true)
  assert.equal(api.status().backlog, 1, '直投也要进静音积压，不能消失')
  assert.equal(api.queue()[0].text, '绕过 signals 的直投')
  assert.ok(host.services.delivery.blockedCount() >= 1)
  api.wake()
  assert.match(drainText(host), /绕过 signals 的直投/)
})

test('事件总线(to:plugin)不被人门拦、不进用户积压', async () => {
  const { host, api } = await boot()
  api.sleep({ message: '睡', durationMin: 60 })
  const events = []
  host.services.signals.on({ kind: 'event', tags: ['dream'] }, (signal) => events.push(signal.text))
  host.services.signals.emit({ from: { plugin: 'dream' }, kind: 'event', text: 'wash done', tags: ['dream'] })
  assert.deepEqual(events, ['wash done'])
  assert.equal(api.status().backlog, 0, 'to:plugin 事件不该被当成用户消息积压')
})

test('睡眠中释放 focus 租约不会把摘要直接塞进会话', async () => {
  const { host, api } = await boot({ withFocus: true })
  api.sleep({ message: '睡', durationMin: 60 })
  drainText(host) // 清掉"该睡了"的开始语
  const lease = host.services.focus.enter({ label: 'work', owner: 'focus' })
  host.services.focus.defer({ from: { plugin: 'qq' }, text: '别处来的消息', focus: 'qq:group:1' })
  lease.release() // focus.onChange 把摘要走 signals.offer：睡眠期间必须进 time 积压
  assert.equal(drainText(host), '', '睡眠中不能把 focus 摘要直接打给会话')
  assert.match(api.queue().map((item) => item.text).join('\n'), /别处积压/)
  api.wake()
  assert.match(drainText(host), /别处积压/, '醒来后摘要随积压一起释放')
})

/* ───────────────────────── 积压可靠性 ───────────────────────── */

test('积压溢出丢最旧并计数', async () => {
  const { host, api } = await boot({ config: { maxQueue: 3 } })
  api.mute({ minutes: 30 })
  for (const text of ['a', 'b', 'c', 'd', 'e']) host.services.signals.offer({ from: { plugin: 'qq' }, kind: 'content', text })
  const state = api.status()
  assert.equal(state.backlog, 3)
  assert.equal(state.dropped, 2)
  assert.deepEqual(api.queue().map((q) => q.text), ['c', 'd', 'e'])
})

test('释放失败不丢：投递失败时保留积压，恢复后再放', async () => {
  const { host, api } = await boot()
  api.sleep({ message: '睡', durationMin: 1 })
  host.services.signals.offer({ from: { plugin: 'qq' }, kind: 'content', text: '不能丢的第一条' })
  host.services.signals.offer({ from: { plugin: 'qq' }, kind: 'content', text: '不能丢的第二条' })
  host.services.signals.setDeliver(() => { throw new Error('session busy') })
  api.wake() // 结束语与积压释放都会失败；积压必须留在队列里
  assert.equal(api.status().phase, 'awake')
  assert.equal(api.status().backlog, 2, '释放失败时清空队列 = 丢消息')
  restoreSignalDeliver(host)
  const released = api.flush('重试')
  assert.equal(released, 2)
  assert.match(drainText(host), /不能丢的第一条/)
})

test('积压摘要最多 20 条 + 来源计数，不把 500 条倒给模型', async () => {
  const { host, api } = await boot({ config: { maxQueue: 60 } })
  api.mute({ minutes: 30 })
  for (let i = 1; i <= 25; i += 1) host.services.signals.offer({ from: { plugin: 'qq' }, kind: 'content', text: `消息${i}` })
  api.unmute('manual')
  const text = drainText(host)
  assert.match(text, /积压了 25 条消息/)
  assert.match(text, /…还有 5 条/)
  assert.match(text, /qq 25/)
  assert.doesNotMatch(text, /消息21/, '只展示前 20 条')
})

test('过期积压显式丢弃并计数', async () => {
  const { host, api } = await boot()
  api.mute({ minutes: 30 })
  host.services.signals.offer({ from: { plugin: 'qq' }, kind: 'content', text: '过期消息', expiresAt: Date.now() + 5 })
  await new Promise((resolve) => setTimeout(resolve, 12))
  api.unmute('manual')
  assert.equal(api.status().expired, 1)
  assert.equal(api.status().backlog, 0)
})

/* ───────────────────────── 日程语义（虚拟时钟） ───────────────────────── */

test('一次性安排响过即删；daily 建在已过时刻从下一次开始', async () => {
  let virtualNow = MON_0900
  const { host, api } = await boot({ now: () => virtualNow })
  api.add({ id: 'one-shot', in: '1m', message: '一次性' })
  virtualNow += 61_000
  api.tick()
  assert.match(drainText(host), /一次性/)
  assert.equal(api.schedules().find((s) => s.id === 'one-shot'), undefined, '一次性安排响过要删掉')

  // 09:01 建一条每天 07:30：今天已经过了，不能立刻响，要等明天
  const at = '07:30'
  api.add({ id: 'daily-morning', at, message: '早上好' })
  api.tick()
  assert.doesNotMatch(drainText(host), /早上好/, '已过的 daily 时刻不能立刻补响')
  const tomorrow = new Date(2026, 10, 3, 7, 31, 0).getTime()
  virtualNow = tomorrow
  api.tick()
  assert.match(drainText(host), /早上好/)
  api.tick()
  assert.doesNotMatch(drainText(host), /早上好/, '同一天只响一次')
})

test('每周安排只在指定星期触发', async () => {
  let virtualNow = MON_0900
  const { host, api } = await boot({ now: () => virtualNow })
  api.add({ id: 'weekly', at: '周一 07:30', message: '周会' })
  api.tick()
  assert.doesNotMatch(drainText(host), /周会/, '周一 09:00 建周一 07:30，今天已过，不立刻响')
  virtualNow = new Date(2026, 10, 3, 7, 31, 0).getTime() // 周二
  api.tick()
  assert.doesNotMatch(drainText(host), /周会/)
  virtualNow = new Date(2026, 10, 9, 7, 31, 0).getTime() // 下周一
  api.tick()
  assert.match(drainText(host), /周会/)
  assert.match(api.listText(), /每周一 07:30/)
})

test('倒计时语法支持 d/h/m 组合', () => {
  const now = MON_0900
  const day = time.normalizeSchedule({ mode: 'wake', in: '1d2h', message: 'x' }, now)
  assert.equal(Date.parse(day.at), now + 26 * 3_600_000)
  const compound = time.normalizeSchedule({ mode: 'wake', in: '1h30m', message: 'x' }, now)
  assert.equal(Date.parse(compound.at), now + 90 * 60_000)
  assert.equal(time.normalizeSchedule({ mode: 'wake', weekdays: [1, 3, 5], at: '07:30' }, now).weekdays.join(','), '1,3,5')
})

test('时区配置：daily 的 HH:mm 按指定时区解释', () => {
  const timeZone = 'Asia/Hong_Kong'
  const now = Date.parse('2026-11-05T20:00:00+08:00') // 当地 20:00，07:30 已过
  const schedule = time.normalizeSchedule({ mode: 'wake', at: '07:30', message: '时区测试' }, now, { timeZone })
  const next = time.nextOccurrence(schedule.__parsed, now, timeZone)
  assert.equal(next, Date.parse('2026-11-06T07:30:00+08:00'), '应等到第二天当地 07:30')
  const today = Date.parse('2026-11-05T01:00:00+08:00')
  const morning = time.normalizeSchedule({ mode: 'wake', at: '07:30', message: 'x' }, today, { timeZone })
  assert.equal(time.nextOccurrence(morning.__parsed, today, timeZone), Date.parse('2026-11-05T07:30:00+08:00'))
})

test('goal 的 afterMin 真正生效', async () => {
  const { api } = await boot()
  const goal = api.addGoal({ theme: '半小时目标', afterMin: 30 })
  assert.ok(goal.until >= Date.now() + 29 * 60_000, 'afterMin 要落成 until')
  const quick = api.addGoal({ theme: 'in 目标', in: '2h' })
  assert.ok(quick.until >= Date.now() + 119 * 60_000)
})

test('pause 冻结一次性时刻、目标期限与静音锁', async () => {
  let virtualNow = MON_0900
  const { host, api } = await boot({ now: () => virtualNow })
  api.add({ id: 'countdown', in: '10m', message: '冻结后的闹钟' })
  const goal = api.addGoal({ theme: '限时目标', afterMin: 10 })
  const goalUntilBefore = goal.until
  api.mute({ minutes: 10 })
  api.pause()

  virtualNow = MON_0900 + 30 * 60_000
  api.tick()
  assert.doesNotMatch(drainText(host), /冻结后的闹钟/)
  api.resume()
  assert.equal(api.goals()[0].until, goalUntilBefore + 30 * 60_000, '目标期限也要后移')
  api.tick()
  assert.doesNotMatch(drainText(host), /冻结后的闹钟/, '恢复瞬间不应补响')
  virtualNow += 11 * 60_000
  api.tick()
  assert.match(drainText(host), /冻结后的闹钟/)
})

test('daily 漏响进 missed 计数且不重复', async () => {
  let virtualNow = MON_0900
  const { host, api } = await boot({ now: () => virtualNow })
  api.add({ id: 'daily-10', at: '10:00', message: '十点' })
  virtualNow = MON_0900 + 2 * 3_600_000 // 11:00，晚了 1 小时
  api.tick()
  assert.equal(api.status().missed, 1)
  assert.doesNotMatch(drainText(host), /十点/)
  api.tick()
  assert.equal(api.status().missed, 1, '漏响只记一次')
})

/* ───────────────────────── 长日程 / 目标 ───────────────────────── */

test('silent span 不发开始/结束语，但仍释放积压', async () => {
  let virtualNow = MON_0900
  const { host, api } = await boot({ now: () => virtualNow })
  api.add({ id: 'quiet-span', at: 'now', kind: 'span', duration: '2m', silent: true, message: '静默开始' })
  api.tick()
  virtualNow += 10_000
  api.sleep({ message: '穿插一次睡眠', durationMin: 1 })
  virtualNow += 61_000
  api.tick() // 睡眠结束
  drainText(host)
  virtualNow += 61_000
  api.tick() // 静默长日程结束
  const text = drainText(host)
  assert.doesNotMatch(text, /静默开始/)
  assert.doesNotMatch(text, /结束了：quiet-span/)
  assert.doesNotMatch(text, /整理完了/)
  assert.equal(api.status().spans.length, 0)
})

test('嵌套睡眠不提前结束外层睡眠', async () => {
  let virtualNow = MON_0900
  const { host, api } = await boot({ now: () => virtualNow })
  api.sleep({ message: '第一层', durationMin: 30 })
  const first = api.status().spans[0]
  const second = api.sleep({ message: '第二层', durationMin: 5 })
  assert.equal(second.started, false)
  assert.equal(api.status().spans.length, 1)
  virtualNow += 6 * 60_000
  api.tick()
  assert.equal(api.status().phase, 'sleeping', '第二层不该在 5 分钟时把第一层叫醒')
  assert.equal(api.status().spans[0].id, first.id)
  virtualNow += 25 * 60_000
  api.tick()
  assert.equal(api.status().phase, 'awake')
})

test('goal 连续唤醒到上限后发明确结束消息并释放', async () => {
  const { host, api } = await boot({ withFocus: true })
  const goal = api.addGoal({ theme: '会跑飞的目标', resumeLimit: 2, focus: 'space-x' })
  drainText(host)
  assert.ok(host.services.focus.list().some((l) => l.label === 'space-x'))
  api.resumeGoals()
  api.resumeGoals()
  const third = api.resumeGoals()
  assert.equal(third, 0)
  const text = drainText(host)
  assert.match(text, /连续唤醒到上限 2 次/)
  assert.equal(api.goals().length, 0)
  assert.ok(!host.services.focus.list().some((l) => l.label === 'space-x'), '目标结束要释放 focus')
  assert.equal(goal.id.length > 0, true)
})

test('取消同 id 的安排与目标一次收尾，并释放 focus', async () => {
  const { host, api } = await boot({ withFocus: true })
  api.add({ id: 'same-id', in: '10m', mode: 'wake', message: '安排' })
  api.addGoal({ id: 'same-id', theme: '目标', focus: 'space-y' })
  assert.ok(host.services.focus.list().some((l) => l.label === 'space-y'))
  const out = api.cancel('same-id')
  assert.equal(out.cancelled, true)
  assert.match(out.parts.join('、'), /安排/)
  assert.match(out.parts.join('、'), /目标/)
  assert.equal(api.goals().length, 0)
  assert.equal(api.schedules().find((s) => s.id === 'same-id'), undefined)
  assert.ok(!host.services.focus.list().some((l) => l.label === 'space-y'))
})

test('目标列表/状态带 id 与剩余轮次，可读', async () => {
  const { api } = await boot()
  api.addGoal({ theme: '写测试', turnLimit: 3 })
  assert.match(api.listText(), /id=g-/)
  assert.match(api.listText(), /剩 3 轮/)
  assert.match(api.statusText(), /目标：g-/)
})

/* ───────────────────────── 静默失败 / 重启 ───────────────────────── */

test('坏状态文件先备份再回落，不静默覆盖', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-time-corrupt-'))
  const stateFile = path.join(root, 'time.json')
  fs.writeFileSync(stateFile, '{ 这不是 JSON', 'utf8')
  const host = createHost({ log: () => {} })
  host.registerPlugin(timeManifest, time, { config: { stateFile, tickMs: 3_600_000 } })
  await host.enable('time')
  const backups = fs.readdirSync(root).filter((name) => name.includes('.corrupt-'))
  assert.equal(backups.length, 1, '坏状态必须先留证据再回落')
  assert.equal(host.shared.get('time').schedules().length, 0)
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(stateFile, 'utf8')), '启动后要写出合法状态')
})

test('inbox 游标跨重启持久，不重放历史命令', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-time-inbox-'))
  const stateFile = path.join(root, 'time.json')
  const inbox = path.join(root, 'time.inbox.jsonl')
  const bootHost = async () => {
    const host = createHost({ log: () => {} })
    host.registerPlugin(timeManifest, time, { config: { stateFile, tickMs: 3_600_000 } })
    await host.enable('time')
    return host
  }
  fs.writeFileSync(inbox, `${JSON.stringify({ id: 'c1', cmd: 'status', args: {} })}\n`, 'utf8')
  const first = await bootHost()
  assert.equal(first.shared.get('time').processInbox().processed, 1)
  const second = await bootHost()
  assert.equal(second.shared.get('time').processInbox().processed, 0, '重启不能重放旧命令')
})

test('暂停中重启：pausedAt 持久化，resume 后仍然后移', async () => {
  let virtualNow = MON_0900
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-time-pauserestart-'))
  const stateFile = path.join(root, 'time.json')
  const bootHost = async () => {
    const host = createHost({ log: () => {}, now: () => virtualNow })
    host.registerPlugin(timeManifest, time, { config: { stateFile, tickMs: 3_600_000 } })
    await host.enable('time')
    return host
  }
  const first = await bootHost()
  const firstApi = first.shared.get('time')
  firstApi.add({ id: 'cd', in: '10m', message: '重启后的闹钟' })
  firstApi.pause()
  virtualNow += 20 * 60_000
  const second = await bootHost()
  const secondApi = second.shared.get('time')
  assert.equal(secondApi.phase(), 'paused')
  secondApi.resume()
  secondApi.tick()
  assert.doesNotMatch(drainText(second), /重启后的闹钟/, '暂停时长要后移，不能恢复瞬间补响')
  virtualNow += 11 * 60_000
  secondApi.tick()
  assert.match(drainText(second), /重启后的闹钟/)
})
