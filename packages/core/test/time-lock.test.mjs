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
  assert.match(api.statusText(), /静音到/)
  assert.match(api.statusText(), /状态：醒着；静音到/)
  assert.match(api.statusText(), /积压 1 条（qq 1）/)
  virtualNow += 61_000
  api.tick()
  const text = drainText(host)
  assert.match(text, /闹钟还是会响/, '静音不关自己的闹钟')
  assert.doesNotMatch(text, /外部消息一/, '外部消息仍被压着')
  assert.doesNotThrow(() => host.services.signals.offer({}), '无效信号不该炸掉 gate')
})

test('静音锁：显式 emergencyQuota 时危险可 opt-in 放行，超配额进积压', async () => {
  const { host, api } = await boot()
  api.mute({ minutes: 30, emergencyQuota: 1 })
  const first = host.services.signals.offer({ from: { plugin: 'mc' }, kind: 'event', text: '安全停止', tags: ['mc', 'safety', 'alarm'] })
  assert.equal(first.accepted, true, '显式配额内必须放行')
  host.services.signals.offer({ from: { plugin: 'mc' }, kind: 'event', text: '第二条紧急', tags: ['safety'] })
  const state = api.status()
  assert.equal(state.lock.emergency.used, 1)
  assert.equal(state.backlog, 1)
  assert.equal(api.queue()[0].reason, 'muted')
  assert.equal(api.queue()[0].priority, 'alarm')
  assert.match(drainText(host), /安全停止/)
})

test('静音默认连 alarm 也拦并记录（用户拍板：只有 mute/sleep 拦）', async () => {
  const { host, api } = await boot()
  api.mute({ minutes: 30 })
  const out = host.services.signals.offer({ from: { plugin: 'mc' }, kind: 'event', text: '危险：血量过低', tags: ['mc', 'safety', 'alarm'] })
  assert.equal(out.blocked, true)
  assert.equal(out.reason, 'muted')
  assert.equal(drainText(host), '', '静音中不叫醒')
  assert.equal(api.status().lastBlockedAlarm?.reason, 'muted')
  assert.equal(api.status().lastBlockedAlarm?.plugin, 'mc')
  assert.equal(api.queue()[0].priority, 'alarm')
  assert.ok(api.status().lock.emergency.used === 0)
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
  assert.match(list, /睡眠消息（sleeping，/)
  assert.match(list, /静音消息（muted，/)
  api.unmute('manual')
})

test('time 工具面：静音可查、可恢复', async () => {
  const { host } = await boot()
  const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))
  assert.ok(tools.time_mute && tools.time_unmute, '工具清单里有静音锁')
  const muted = await tools.time_mute.execute({ minutes: 5, reason: '看一下' })
  assert.match(muted.text, /静音了：到/)
  const status = await tools.time_status.execute()
  assert.match(status.text, /静音到/)
  const unmuted = await tools.time_unmute.execute()
  assert.match(unmuted.text, /解除静音/)
})

test('time_status 四态一行可读：醒着/睡着/计时暂停/静音/积压', async () => {
  const { host, api } = await boot()
  assert.match(api.statusText(), /状态：醒着。/)
  api.sleep({ message: '睡', durationMin: 30 })
  assert.match(api.statusText(), /状态：睡着；睡到 /)
  host.services.signals.offer({ from: { plugin: 'qq' }, kind: 'content', text: '睡眠里的一条' })
  assert.match(api.statusText(), /积压 1 条（qq 1）/)
  api.mute({ minutes: 10 })
  assert.match(api.statusText(), /静音到/)
  api.unmute('manual')
  api.pause()
  assert.match(api.statusText(), /状态：计时暂停；暂停自 /)
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

test('积压溢出优先丢 ambient，@/私聊消息保留', async () => {
  const { host, api } = await boot({ config: { maxQueue: 3 } })
  api.mute({ minutes: 30 })
  host.services.signals.offer({ from: { plugin: 'qq' }, kind: 'content', text: 'ambient-a' })
  host.services.signals.offer({ from: { plugin: 'qq' }, kind: 'content', text: '私聊一', tags: ['qq', 'private', 'mention'] })
  host.services.signals.offer({ from: { plugin: 'qq' }, kind: 'content', text: 'ambient-b' })
  host.services.signals.offer({ from: { plugin: 'qq' }, kind: 'content', text: '私聊二', tags: ['private', 'mention'] })
  const texts = api.queue().map((item) => item.text)
  assert.deepEqual(texts, ['私聊一', 'ambient-b', '私聊二'], '溢出时先丢 ambient（最旧的普通消息）')
  assert.equal(api.status().overflow, 1)
})

test('积压条目保留 signalId/from 归因，同一 blocked 信号不重复入队', async () => {
  const { host, api } = await boot()
  api.mute({ minutes: 30 })
  const signal = {
    id: 'qq:private:10001:42',
    from: { plugin: 'qq', activity: 'qq:private:10001' },
    kind: 'notice',
    text: '睡着时来的',
    tags: ['qq', 'private', 'mention'],
  }
  host.services.signals.offer(signal) // 第一次被拦
  host.services.signals.offer(signal) // QQ 侧不重试，但重复 offer 也不能重复入队
  const [item] = api.queue()
  assert.equal(api.status().backlog, 1)
  assert.equal(item.signalId, 'qq:private:10001:42')
  assert.equal(item.from.plugin, 'qq')
  assert.equal(item.from.activity, 'qq:private:10001')
  assert.match(api.listText(), /qq:private:10001/)
  assert.match(api.listText(), /sig=qq:private:10001:42/)
  api.unmute('manual')
  const text = host.services.delivery.drain('session').map((batch) => batch.text).join('\n')
  assert.match(text, /\[qq\/qq:private:10001\]/)
})

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

test('测试时钟：平移后仍随真实时间走、倒计时照常触发、跨时段提示词变化', async () => {
  let virtualNow = new Date(2026, 10, 2, 11, 30).getTime()
  const { host, api } = await boot({ now: () => virtualNow, config: { testClock: true } })
  assert.match(host.services.prompt.assemble(), /上午/)
  api.add({ id: 'clock-wake', in: '1m', message: '时钟平移后的闹钟' })
  const first = api.advanceClock({ advanceMinutes: 5 })
  assert.ok(first.now >= new Date(2026, 10, 2, 11, 35).getTime())
  virtualNow += 60_000
  assert.equal(api.now(), virtualNow + 5 * 60_000, '平移后仍要跟着真实时间走（不是冻结）')
  api.tick()
  assert.match(drainText(host), /时钟平移后的闹钟/, '平移 5 分钟仍在补发窗口内')
  api.advanceClock({ advanceMinutes: 60 }) // 12:36 → 下午
  assert.match(host.services.prompt.assemble(), /下午/, '跨时段后事实要变化')
  const viaCommand = api.runCommand({ cmd: 'clock', args: { advanceMs: 1_000 } })
  assert.equal(viaCommand.ok, true)
  const reset = api.runCommand({ cmd: 'clock', args: { reset: true } })
  assert.equal(reset.ok, true)
  assert.ok(api.now() >= virtualNow, 'reset 后回到真实时钟')
})

test('clock 命令默认不可用（产品配置不开放）', async () => {
  const { api } = await boot()
  const out = api.runCommand({ cmd: 'clock', args: { advanceMinutes: 5 } })
  assert.equal(out.ok, false)
  assert.match(out.error, /testClock/)
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
  const { host, api } = await boot({ withFocus: true, config: { goalResumeMinGapSec: 0 } })
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

test('goal 续推有最小间隔：连发 turn-end 被节流，tick 到点补发并标“第 N 次续推”', async () => {
  let virtualNow = MON_0900
  const { host, api } = await boot({ now: () => virtualNow, config: { awakeTick: { enabled: false }, goalResumeMinGapSec: 60 } })
  api.addGoal({ theme: '慢慢挖', resumeLimit: 10 })
  drainText(host)
  emitTurnEnd(host, 1)
  assert.match(drainText(host), /第 1 次续推/)
  virtualNow += 10_000
  emitTurnEnd(host, 2)
  assert.equal(drainText(host), '', '最小间隔内不续推')
  assert.ok(api.goals()[0].resumeDueAt != null, '被节流的续推要有 dueAt')
  virtualNow += 50_000
  api.tick()
  assert.match(drainText(host), /第 2 次续推/, '到 gap 后由 tick 补发')
})

test('goalResumeMinGapSec=0 时保持每回合续推（可配回旧行为）', async () => {
  let virtualNow = MON_0900
  const { host, api } = await boot({ now: () => virtualNow, config: { awakeTick: { enabled: false }, goalResumeMinGapSec: 0 } })
  api.addGoal({ theme: '快节奏', resumeLimit: 10 })
  drainText(host)
  emitTurnEnd(host, 1)
  emitTurnEnd(host, 2)
  const text = drainText(host)
  assert.match(text, /第 1 次续推/)
  assert.match(text, /第 2 次续推/)
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

/* ───────────────────────── 清醒节拍（awake heartbeat） ───────────────────────── */

function emitTurnEnd(host, seq = 1) {
  host.services.signals.emit({ from: { plugin: 'dsh' }, kind: 'event', text: 'turn-end', tags: ['turn-end'], meta: { seq } })
}

test('清醒节拍：无 goal 时 turn-end 后 idleSec 内自检，空闲不再静默等待', async () => {
  let virtualNow = MON_0900
  const { host, api } = await boot({ now: () => virtualNow, config: { awakeTick: { enabled: true, idleSec: 60, maxPerHour: 10 } } })
  emitTurnEnd(host)
  const heartbeat0 = api.heartbeat()
  assert.equal(heartbeat0.enabled, true)
  assert.equal(heartbeat0.state, 'awake')
  assert.ok(heartbeat0.nextTickAt >= virtualNow + 59_000, '应在 idleSec 后安排自检')
  virtualNow += 59_000
  api.tick()
  assert.doesNotMatch(drainText(host), /清醒节拍/, '不到 idleSec 不应自检')
  virtualNow += 2_000
  api.tick()
  const text = drainText(host)
  assert.match(text, /清醒节拍/)
  assert.match(text, /time_status/, '自检消息要告诉她下一步可以查什么')
  const heartbeat = api.heartbeat()
  assert.ok(heartbeat.idleSec >= 61)
  assert.equal(heartbeat.ticksLastHour, 1)
  assert.match(api.statusText(), /心跳：上次回合结束/)
})

test('清醒节拍不叠加在目标续推上（有 goal 时由 goal 唤醒）', async () => {
  let virtualNow = MON_0900
  const { host, api } = await boot({ now: () => virtualNow, config: { awakeTick: { enabled: true, idleSec: 60 } } })
  api.addGoal({ theme: '做点事' })
  drainText(host)
  emitTurnEnd(host)
  virtualNow += 61_000
  api.tick()
  const text = drainText(host)
  assert.match(text, /你在目标内/, 'goal 续推照旧')
  assert.doesNotMatch(text, /清醒节拍/, 'goal 已经在续推，不叠加')
  assert.equal(api.heartbeat().nextTickAt, null)
})

test('睡眠/静音期间不发清醒节拍，醒来/解除后恢复', async () => {
  let virtualNow = MON_0900
  const { host, api } = await boot({ now: () => virtualNow, config: { awakeTick: { enabled: true, idleSec: 30 } } })
  api.sleep({ message: '睡', durationMin: 10 })
  drainText(host) // 清掉入睡消息
  emitTurnEnd(host)
  virtualNow += 5 * 60_000
  api.tick()
  assert.doesNotMatch(drainText(host), /清醒节拍/, '睡眠中不发自检')
  api.wake()
  drainText(host)
  virtualNow += 31_000
  api.tick()
  assert.match(drainText(host), /清醒节拍/, '醒来后恢复自检')

  api.mute({ minutes: 5 })
  drainText(host)
  emitTurnEnd(host)
  virtualNow += 60_000
  api.tick()
  assert.doesNotMatch(drainText(host), /清醒节拍/, '静音中不发自检')
  api.unmute('manual')
  drainText(host)
  virtualNow += 31_000
  api.tick()
  assert.match(drainText(host), /清醒节拍/, '解除静音后恢复自检')
})

test('清醒节拍每小时有上限，超限可观测', async () => {
  let virtualNow = MON_0900
  const { host, api } = await boot({ now: () => virtualNow, config: { awakeTick: { enabled: true, idleSec: 30, maxPerHour: 2, cappedShortMax: 0 } } })
  emitTurnEnd(host)
  let ticks = 0
  for (let i = 0; i < 4; i += 1) {
    virtualNow += 31_000
    api.tick()
    if (/清醒节拍/.test(drainText(host))) ticks += 1
  }
  assert.equal(ticks, 2, '超过 maxPerHour 后不再发')
  const heartbeat = api.heartbeat()
  assert.equal(heartbeat.capped, true)
  assert.equal(heartbeat.ticksLastHour, 2)
})

test('awakeTick.enabled:false 时完全不自检（长跑/测试可关）', async () => {
  let virtualNow = MON_0900
  const { host, api } = await boot({ now: () => virtualNow, config: { awakeTick: { enabled: false } } })
  emitTurnEnd(host)
  virtualNow += 10 * 60_000
  api.tick()
  assert.doesNotMatch(drainText(host), /清醒节拍/)
  assert.equal(api.heartbeat().enabled, false)
})

/* ───────────────────────── 睡眠边界（in-flight turn） ───────────────────────── */

function emitTurnStart(host, seq = 1) {
  host.services.signals.emit({ from: { plugin: 'dsh' }, kind: 'event', text: 'turn-start', tags: ['turn-start'], meta: { seq } })
}

/** 读 time-events.jsonl（外部 supervisor/早报的文件通道）。 */
function readTimeEvents(root) {
  try {
    return fs.readFileSync(path.join(root, 'time-events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } catch { return [] }
}

test('睡眠边界：入睡时在飞回合被记录，grace 内结束算合法收尾', async () => {
  let virtualNow = MON_0900
  const { host, root, api } = await boot({ now: () => virtualNow, config: { awakeTick: { enabled: false }, sleepGraceSec: 120 } })
  emitTurnStart(host, 1)
  virtualNow += 10_000
  api.sleep({ message: '睡', durationMin: 30 })
  drainText(host)
  const entry = api.status().sleepBoundary
  assert.equal(entry.inFlight, true)
  assert.equal(entry.turnAgeAtEntrySec, 10)
  let events = readTimeEvents(root)
  assert.ok(events.some((event) => event.type === 'sleep-boundary-entry' && event.inFlight === true), 'time-events 要落 sleep-boundary-entry')
  assert.ok(events.some((event) => event.type === 'sleep-start'))
  virtualNow += 20_000
  emitTurnEnd(host, 2)
  const ended = api.status().sleepBoundary
  assert.ok(ended.turnEndedAt != null)
  assert.equal(ended.turnEndedAfterSec, 20)
  assert.equal(ended.overrun, false)
  events = readTimeEvents(root)
  assert.ok(events.some((event) => event.type === 'sleep-boundary-turn-end' && event.afterSec === 20))
  virtualNow += 30 * 60_000
  api.wake()
  drainText(host)
  assert.equal(api.status().sleepBoundary, null)
  const last = api.status().lastSleepBoundary
  assert.ok(last)
  assert.equal(last.inFlight, true)
  assert.equal(last.turnEndedAfterSec, 20)
  events = readTimeEvents(root)
  assert.ok(events.some((event) => event.type === 'sleep-end'), 'time-events 要落 sleep-end')
})

test('睡眠边界：在飞回合超过 grace → 发一次 sleep-boundary-overrun', async () => {
  let virtualNow = MON_0900
  const { host, root, api } = await boot({ now: () => virtualNow, config: { awakeTick: { enabled: false }, sleepGraceSec: 60 } })
  const events = []
  host.services.signals.on({ kind: 'event', tags: ['boundary'] }, (signal) => events.push(signal.text))
  emitTurnStart(host, 1)
  virtualNow += 5_000
  api.sleep({ message: '睡', durationMin: 30 })
  drainText(host)
  virtualNow += 61_000
  api.tick()
  assert.ok(events.includes('sleep-boundary-overrun'), '超过 grace 要发 overrun')
  assert.equal(api.status().sleepBoundary.overrun, true)
  const recorded = readTimeEvents(root).filter((event) => event.type === 'sleep-boundary-overrun')
  assert.equal(recorded.length, 1, 'time-events 里 overrun 只落一次')
  virtualNow += 10_000
  api.tick()
  assert.equal(events.filter((text) => text === 'sleep-boundary-overrun').length, 1, 'overrun 只发一次')
})

test('睡眠边界：入睡后出现新 turn（边界回合已结束）→ postSleepTurn + 事件', async () => {
  let virtualNow = MON_0900
  const { host, root, api } = await boot({ now: () => virtualNow, config: { awakeTick: { enabled: false } } })
  const events = []
  host.services.signals.on({ kind: 'event', tags: ['boundary'] }, (signal) => events.push(signal.text))
  emitTurnStart(host, 1)
  api.sleep({ message: '睡', durationMin: 30 })
  drainText(host)
  virtualNow += 5_000
  emitTurnEnd(host, 2) // 边界回合在 grace 内结束
  virtualNow += 5_000
  emitTurnStart(host, 3) // 睡眠中又起一轮 = 直投/注入嫌疑
  const boundary = api.status().sleepBoundary
  assert.equal(boundary.postSleepTurn, true)
  assert.ok(events.includes('sleep-boundary-new-turn'))
  assert.ok(readTimeEvents(root).some((event) => event.type === 'sleep-boundary-new-turn'), 'time-events 要落 new-turn')
  assert.match(api.statusText(), /睡眠边界：入睡后出现新回合/)
})

/* ───────────────────────── 醒来简报（红队 C4） ───────────────────────── */

test('醒来简报：睡眠时长/积压来源/dream/异常合并进醒来消息', async () => {
  let virtualNow = MON_0900
  const { host, api } = await boot({ now: () => virtualNow, config: { awakeTick: { enabled: false } } })
  api.sleep({ message: '睡', durationMin: 30 })
  drainText(host) // 清掉入睡消息
  host.services.signals.offer({ from: { plugin: 'qq' }, kind: 'content', text: 'QQ 一条' })
  host.services.signals.offer({ from: { plugin: 'mc' }, kind: 'event', text: 'MC 一条' })
  virtualNow += 30 * 60_000
  api.tick() // 醒来：结束 span + 释放积压
  const text = drainText(host)
  assert.match(text, /睡眠简报/)
  assert.match(text, /睡了 30 分钟/)
  assert.match(text, /积压 2 条（qq 1、mc 1）/)
  assert.match(text, /记忆整理：入睡时已触发/)
  assert.match(text, /无异常/)
  // 顺序：结束语在前，简报随后，积压摘要再后
  assert.ok(text.indexOf('整理完了') < text.indexOf('睡眠简报'), '结束语在前')
  assert.ok(text.indexOf('睡眠简报') < text.indexOf('积压了 2 条消息'), '简报在积压摘要前')
  const brief = api.status().lastSleepBrief
  assert.ok(brief)
  assert.equal(brief.backlog, 2)
  assert.deepEqual(brief.anomalies, [])
})

test('醒来简报：dream 回执（含 degraded/失败分片）与边界超时进入简报', async () => {
  let virtualNow = MON_0900
  const { host, api } = await boot({ now: () => virtualNow, config: { awakeTick: { enabled: false }, sleepGraceSec: 60 } })
  emitTurnStart(host, 1) // 入睡时的在飞回合
  api.sleep({ message: '睡', durationMin: 30 })
  drainText(host)
  virtualNow += 61_000
  api.tick() // 超过 grace → overrun
  // dream 插件（已实现：60d8abe）在睡眠中 emit 一条结果
  host.services.signals.emit({
    from: { plugin: 'dream' }, kind: 'event', tags: ['dream-result'],
    text: 'wash 1119 行 / events 3 块 / 分片降级（1 片失败）',
    meta: { ok: true, jobs: [{ job: 'wash', ok: true }, { job: 'events', ok: true }], degraded: 1, failedShards: 1, at: virtualNow },
  })
  virtualNow += 29 * 60_000
  api.tick() // 醒来
  const text = drainText(host)
  assert.match(text, /记忆整理：完成/)
  assert.match(text, /wash 1119 行/)
  assert.match(text, /分片降级（1 片失败）/)
  assert.match(text, /异常：边界回合超过 grace/)
  const result = api.status().lastDreamResult
  assert.equal(result?.ok, true)
  assert.equal(result?.failedShards, 1)
  assert.ok(api.status().lastSleepBrief?.anomalies.some((item) => item.includes('grace')))
})

test('醒着收到 dream 失败回执：发一条可读 notice，status 记录 ok=false', async () => {
  const { host, api } = await boot({ config: { awakeTick: { enabled: false } } })
  host.services.signals.emit({ from: { plugin: 'dream' }, kind: 'event', tags: ['dream-result'], text: 'wash 失败：raw 文件缺失', meta: { ok: false, jobs: [], degraded: 0, failedShards: 0 } })
  const text = drainText(host)
  assert.match(text, /记忆整理回执：失败/)
  assert.match(text, /raw 文件缺失/)
  assert.equal(api.status().lastDreamResult?.ok, false)
})

test('turn-start 记录模型活动开始时间，heartbeat.lastModelCallAt 用它', async () => {
  let virtualNow = MON_0900
  const { host, api } = await boot({ now: () => virtualNow, config: { awakeTick: { enabled: false } } })
  host.services.signals.emit({ from: { plugin: 'dsh' }, kind: 'event', text: 'turn-start', tags: ['turn-start'], meta: { seq: 7 } })
  virtualNow += 5_000
  const heartbeat = api.heartbeat()
  assert.equal(heartbeat.lastTurnStartAt, MON_0900)
  assert.equal(heartbeat.lastModelCallAt, MON_0900)
  emitTurnEnd(host, 8)
  assert.equal(api.heartbeat().lastTurnEndAt, virtualNow)
  assert.equal(api.heartbeat().lastModelCallAt, MON_0900, 'turn-start 仍是最新的模型活动开始')
})

test('清醒节拍 capped 后降频：短提示有上限、之后安静等窗口', async () => {
  let virtualNow = MON_0900
  const { host, api } = await boot({ now: () => virtualNow, config: { awakeTick: { enabled: true, idleSec: 30, maxPerHour: 1, cappedSec: 60, cappedShortWindowSec: 600, cappedShortMax: 1 } } })
  emitTurnEnd(host)
  virtualNow += 31_000
  api.tick()
  assert.match(drainText(host), /清醒节拍/, '第一条正常节拍')
  // 第 2 次到点就命中上限，之后每 cappedSec 检查一次、cappedShortMax 内只发一条短提示
  virtualNow += 31_000
  api.tick()
  virtualNow += 61_000
  api.tick()
  const short = drainText(host)
  assert.match(short, /清醒节拍/)
  assert.match(short, /醒着 \d+ 秒没有回合；手上没事的话/, 'capped 后发短提示')
  virtualNow += 61_000
  api.tick()
  assert.doesNotMatch(drainText(host), /清醒节拍/, '短提示达到上限后不再刷')
  assert.equal(api.heartbeat().capped, true)
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


/* ───────────────────── 暂停 / 危险穿透（用户 2026-11-06 拍板） ───────────────────── */

test('暂停不吞 alarm：phase=paused 时 alarm/safety 穿透并记录 lastPierce，普通消息进积压', async () => {
  const { host, api } = await boot({ config: { awakeTick: { enabled: false } } })
  api.pause('mcb_stop')
  const alarm = host.services.signals.offer({ from: { plugin: 'mc' }, kind: 'event', text: '危险：血量过低', tags: ['mc', 'safety', 'alarm'] })
  assert.equal(alarm.accepted, true, '暂停中危险必须穿透')
  assert.match(drainText(host), /危险：血量过低/)
  const normal = host.services.signals.offer({ from: { plugin: 'qq' }, kind: 'content', text: '普通消息' })
  assert.equal(normal.blocked, true)
  assert.equal(normal.reason, 'paused')
  const state = api.status()
  assert.equal(state.pausedMode.active, true)
  assert.equal(state.pausedMode.alarmsPierce, true)
  assert.equal(state.lastPierce?.plugin, 'mc')
  assert.match(api.statusText(), /暂停（time：mcb_stop）：任务停止、世界继续；危险（alarm\/safety）会穿透/)
  assert.match(api.statusText(), /最近穿透：mc/)
})

test('外部暂停模式（mcb_stop）：不冻结 time 计时，alarm 穿透，普通消息积压', async () => {
  let virtualNow = MON_0900
  const { host, api } = await boot({ now: () => virtualNow, config: { awakeTick: { enabled: false } } })
  const out = api.setPausedMode({ active: true, reason: 'mcb_stop', source: 'mc-link' })
  assert.equal(out.pausedMode.active, true)
  api.add({ id: 'paused-wake', in: '1m', message: '暂停中的闹钟' })
  virtualNow += 61_000
  api.tick()
  assert.match(drainText(host), /暂停中的闹钟/, '外部 pause 不冻结 time 计时（世界继续）')
  const alarm = host.services.signals.offer({ from: { plugin: 'mc' }, kind: 'event', text: '安全停止', tags: ['safety', 'alarm'] })
  assert.equal(alarm.accepted, true)
  host.services.signals.offer({ from: { plugin: 'qq' }, kind: 'content', text: '普通' })
  assert.equal(api.status().backlog, 1)
  const off = api.setPausedMode({ active: false })
  assert.equal(off.pausedMode.active, false)
})

test('睡眠中 alarm 不叫醒、进最高优先级积压，醒来简报第一条呈现', async () => {
  let virtualNow = MON_0900
  const { host, api } = await boot({ now: () => virtualNow, config: { awakeTick: { enabled: false } } })
  api.sleep({ message: '睡', durationMin: 30 })
  drainText(host) // 清掉入睡消息
  const out = host.services.signals.offer({ from: { plugin: 'mc' }, kind: 'event', text: '危险：血量过低', tags: ['mc', 'safety', 'alarm'] })
  assert.equal(out.blocked, true)
  assert.equal(out.reason, 'sleeping')
  assert.equal(drainText(host), '', '睡眠中 alarm 不叫醒')
  host.services.signals.offer({ from: { plugin: 'qq' }, kind: 'content', text: '普通消息' })
  assert.equal(api.queue().find((item) => item.priority === 'alarm')?.text, '危险：血量过低')
  assert.equal(api.status().lastBlockedAlarm?.reason, 'sleeping')
  virtualNow += 30 * 60_000
  api.tick()
  const text = drainText(host)
  assert.match(text, /⚠ 睡眠期间有 1 条危险\/紧急事件（mc）/)
  assert.ok(text.indexOf('⚠ 睡眠期间') < text.indexOf('积压了 2 条消息'), '危险摘要必须在积压摘要之前')
  assert.ok(text.indexOf('危险：血量过低') < text.indexOf('普通消息'), '危险条目排在积压最前')
  assert.equal(api.status().lastSleepBrief?.alarms?.count, 1)
})

test('暂停时保留目标/专注并给继续与离开选项（不静默清空）', async () => {
  const { host, api } = await boot({ withFocus: true, config: { awakeTick: { enabled: false }, goalResumeMinGapSec: 0 } })
  api.addGoal({ theme: '继续挖矿', focus: 'mc' })
  drainText(host)
  api.pause('mcb_stop')
  const text = api.statusText()
  assert.match(text, /保留：目标 g-/)
  assert.match(text, /继续用 time_resume/)
  assert.equal(api.goals().length, 1, '暂停不清空 goal')
  assert.ok(host.services.focus.list().some((lease) => lease.label === 'mc'), '暂停不清空 focus')
})
