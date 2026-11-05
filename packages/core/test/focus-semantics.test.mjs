// focus 行为：别处的事不是直接打断，而是先过闸门，进不去的进积压。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHost } from '../src/index.mjs'
import * as focusPlugin from '../../plugins/focus/src/index.mjs'
import focusManifest from '../../plugins/focus/manifest.json' with { type: 'json' }

function drainText(host) {
  return host.services.delivery.drain('session').map((batch) => batch.text)
}

test('没有 focus：谁来都能到', () => {
  const host = createHost({ log: () => {} })
  const out = host.services.signals.offer({ from: { plugin: 'qq' }, kind: 'content', text: '在吗', focus: 'qq:group:1' })
  assert.equal(out.accepted, true)
  assert.deepEqual(drainText(host), ['在吗'])
})

test('有 focus：别处的普通消息进积压，不投递', () => {
  const host = createHost({ log: () => {} })
  const lease = host.services.focus.enter({ label: 'act:write', title: '写记忆层', owner: 'focus' })
  const out = host.services.signals.offer({ from: { plugin: 'qq' }, kind: 'content', text: '群里有事', focus: 'qq:group:1' })
  assert.equal(out.accepted, true)
  assert.deepEqual(drainText(host), [])
  assert.equal(host.services.focus.backlog()[0].count, 1)
  assert.equal(host.services.focus.backlog()[0].focus, 'qq:group:1')
  lease.release()
})

test('mention 能穿透；同 focus 的消息直接进', () => {
  const host = createHost({ log: () => {} })
  host.services.focus.enter({ label: 'act:write', owner: 'focus', pierce: { 'qq:group:*': 'mention' } })
  host.services.signals.offer({ from: { plugin: 'qq' }, kind: 'content', text: '有人 @ 你', focus: 'qq:group:1', tags: ['mention'] })
  host.services.signals.offer({ from: { plugin: 'qq' }, kind: 'content', text: '同一件事', focus: 'act:write' })
  assert.deepEqual(drainText(host), ['有人 @ 你', '同一件事'])
})

test('interruptible=false：普通消息全进积压，闹钟仍放行', () => {
  const host = createHost({ log: () => {} })
  host.services.focus.enter({ label: 'act:deep', owner: 'focus', interruptible: false })
  host.services.signals.offer({ from: { plugin: 'qq' }, kind: 'content', text: '别处', focus: 'qq:group:1', tags: ['mention'] })
  host.services.signals.offer({ from: { plugin: 'time' }, kind: 'wake', text: '闹钟', focus: 'timer' })
  assert.deepEqual(drainText(host), ['闹钟'])
  assert.equal(host.services.focus.backlog().reduce((n, row) => n + row.count, 0), 1)
})

test('焦点释放：积压合成一条摘要投递', () => {
  const host = createHost({ log: () => {} })
  const lease = host.services.focus.enter({ label: 'act:write', owner: 'focus' })
  host.services.signals.offer({ from: { plugin: 'qq' }, kind: 'content', text: '第一条', focus: 'qq:group:1' })
  host.services.signals.offer({ from: { plugin: 'qq' }, kind: 'content', text: '第二条', focus: 'qq:group:2' })
  lease.release()
  const texts = drainText(host)
  assert.equal(texts.length, 1)
  assert.match(texts[0], /积压了 2 条/)
  assert.match(texts[0], /\[qq:group:1\] \+1/)
  assert.equal(host.services.focus.backlog().length, 0)
})

test('focus 快照恢复：租约与积压都能跨 host', () => {
  const a = createHost({ log: () => {} })
  a.services.focus.enter({ label: 'act:x', title: '写记忆层', owner: 'focus', interruptible: false })
  a.services.focus.defer({ focus: 'qq:group:1', text: '别处的事', from: { plugin: 'qq' } })
  const snapshot = a.services.focus.snapshot()
  const b = createHost({ log: () => {} })
  b.services.focus.restore(snapshot)
  assert.equal(b.services.focus.current().title, '写记忆层')
  assert.equal(b.services.focus.current().interruptible, false)
  assert.equal(b.services.focus.backlog()[0].count, 1)
})

test('focus 插件：工具能进入/查看/离开，提示词带焦点快照', async () => {
  const host = createHost({ log: () => {} })
  host.registerPlugin(focusManifest, focusPlugin)
  await host.enable('focus')
  const enter = host.services.tools.list().find((tool) => tool.name === 'focus_enter')
  const status = host.services.tools.list().find((tool) => tool.name === 'focus_status')
  const leave = host.services.tools.list().find((tool) => tool.name === 'focus_leave')
  assert.ok(enter && status && leave)

  await enter.execute({ title: '写记忆层', reason: '别打断', interruptible: false })
  assert.equal(host.services.focus.current().title, '写记忆层')
  assert.match(host.services.prompt.assemble({}), /你现在在：写记忆层/)
  assert.match((await status.execute({})).text, /勿扰/)
  await leave.execute({})
  assert.equal(host.services.focus.current(), null)
  host.disable('focus')
})

// ── 红队 C2：focus_enter 忘带 activity 时不能静默变成随机标签 ──

test('focus_enter 不带 activity：无 MC 时按标题推稳定标签，并明确提示"自动"', async () => {
  const host = createHost({ log: () => {} })
  host.registerPlugin(focusManifest, focusPlugin)
  await host.enable('focus')
  const enter = host.services.tools.list().find((tool) => tool.name === 'focus_enter')
  const status = host.services.tools.list().find((tool) => tool.name === 'focus_status')

  const out = await enter.execute({ title: '写记忆层' })
  assert.match(out.text, /auto:act:写记忆层/)
  assert.match(out.text, /activity 未指定/)
  assert.equal(host.services.focus.current().label, 'auto:act:写记忆层', '标签要按标题推，而不是随机 uuid')
  assert.match((await status.execute({})).text, /标签自动生成/)

  // 同标题再次进入得到同一标签（稳定，可被 pierce/对账）
  await enter.execute({ title: '写记忆层' })
  assert.equal(host.services.focus.current().label, 'auto:act:写记忆层')
  host.disable('focus')
})

test('focus_enter 不带 activity：检测到 MC 在线时自动用 mc 并说明原因', async () => {
  const host = createHost({ log: () => {} })
  host.shared.set('mc-link', { status: () => ({ connected: true, adapter: { connected: true } }) })
  host.registerPlugin(focusManifest, focusPlugin)
  await host.enable('focus')
  const enter = host.services.tools.list().find((tool) => tool.name === 'focus_enter')
  const out = await enter.execute({ title: '玩 MC' })
  assert.equal(host.services.focus.current().label, 'mc')
  assert.match(out.text, /自动设为 "mc"/)
  host.disable('focus')
})

test('focus_enter 显式 activity：标签原样、不出现自动提示', async () => {
  const host = createHost({ log: () => {} })
  host.registerPlugin(focusManifest, focusPlugin)
  await host.enable('focus')
  const enter = host.services.tools.list().find((tool) => tool.name === 'focus_enter')
  const out = await enter.execute({ title: '玩 MC', activity: 'mc' })
  assert.equal(host.services.focus.current().label, 'mc')
  assert.doesNotMatch(out.text, /自动/)
  host.disable('focus')
})
