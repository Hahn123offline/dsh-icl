// M1 收尾：人格回滚 + 世界状态分层，并守住"基础设施"这条线。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost, createSessionAdapter } from '../src/index.mjs'
import * as memory from '../../plugins/memory/src/index.mjs'
import * as persona from '../../plugins/persona/src/index.mjs'
import * as world from '../../plugins/world-state/src/index.mjs'
import memoryManifest from '../../plugins/memory/manifest.json' with { type: 'json' }
import personaManifest from '../../plugins/persona/manifest.json' with { type: 'json' }
import worldManifest from '../../plugins/world-state/manifest.json' with { type: 'json' }

async function setup({ withMemory = true, card = '', personaConfig = {} } = {}) {
  const host = createHost({ log: () => {} })
  const session = createSessionAdapter({ sessionId: 's1', host, push: async () => {} })
  if (withMemory) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-m1b-'))
    host.registerPlugin(memoryManifest, memory, { config: { root } })
    await host.enable('memory')
  }
  host.registerPlugin(personaManifest, persona, { config: { card, ...personaConfig } })
  host.registerPlugin(worldManifest, world)
  return { host, session }
}

test('人格：设置后立即进入系统提示词（段是函数求值）', async () => {
  const { host, session } = await setup({ withMemory: false })
  await host.enable('persona')
  host.shared.get('persona').set('我是大肥鱼')
  assert.match(session.systemPrompt(), /我是大肥鱼/)
})

test('人格：回滚到上一版，且当前值也跟着变', async () => {
  const { host, session } = await setup({ card: '第一版' })
  await host.enable('persona')
  const api = host.shared.get('persona')
  api.set('第二版')
  api.set('第三版')
  assert.match(session.systemPrompt(), /第三版/)
  const list = api.versions()
  assert.equal(list.length, 2, '两次修改留下两版历史')
  api.rollback(1) // 上一版 = 第二版
  assert.match(session.systemPrompt(), /第二版/)
})

test('人格：版本只保留最新 maxVersions，rollback(1) 是上一个版本', async () => {
  const { host } = await setup({ card: 'v1', personaConfig: { maxVersions: 2 } })
  await host.enable('persona')
  const api = host.shared.get('persona')
  api.set('v2')
  api.set('v3')
  api.set('v4')
  const list = api.versions()
  assert.deepEqual(list.map((v) => v.text), ['v3', 'v2'])
  api.rollback(1)
  assert.equal(api.current(), 'v3')
})

test('人格：没有 memory 时也能用，只是没有历史（不假装持久化）', async () => {
  const { host } = await setup({ withMemory: false })
  await host.enable('persona')
  const api = host.shared.get('persona')
  api.set('临时卡')
  assert.equal(api.current(), '临时卡')
  assert.deepEqual(api.versions(), [])
})

test('人格：持久化在 memory 的 persona 命名空间，不是第二个库', async () => {
  const { host } = await setup()
  await host.enable('persona')
  host.shared.get('persona').set('落盘的卡')
  const rows = host.shared.get('memory').query({ namespace: 'persona', kind: 'persona-current' })
  assert.equal(rows.length, 1)
  assert.match(rows[0].text, /落盘的卡/)
})

test('世界：time 在时不重复默认 clock 行；同一 owner 按 source order 取 title/cap', async () => {
  const { host } = await setup({ withMemory: false })
  await host.enable('world-state')
  const w = host.shared.get('world')
  w.registerSource({
    id: 'time', owner: 'time', title: '时间', order: 5, cap: 2,
    items: () => [{ key: 'now', brief: '现在是 2026-11-04 00:47' }, { key: 'phase', brief: '阶段：醒着' }],
  })
  w.registerSource({ id: 'z', owner: 'x', title: '后', order: 30, cap: 1, items: () => [{ key: 'a', brief: '后出现的' }] })
  w.registerSource({ id: 'a', owner: 'x', title: '先', order: 10, cap: 2, items: () => [{ key: 'b', brief: '先出现的' }, { key: 'c', brief: '第二条' }] })
  const brief = w.renderBrief()
  assert.equal((brief.match(/时间：/g) ?? []).length, 1, '不应同时有 clock 和 time 两行时间')
  assert.match(brief, /先：先出现的；第二条/)
  assert.doesNotMatch(brief, /后：后出现的/)
})

test('世界：默认只露 brief，且每个注册者受 cap 限制', async () => {
  const { host, session } = await setup({ withMemory: false })
  await host.enable('world-state')
  const w = host.shared.get('world')
  w.registerSource({
    id: 'qq', owner: 'qq', title: 'QQ', cap: 2,
    items: () => [
      { key: 'unread', brief: '3 条未读' },
      { key: 'friend', brief: '1 个好友申请' },
      { key: 'third', brief: '不应该出现在一眼里' },
    ],
  })
  const prompt = session.systemPrompt()
  assert.match(prompt, /QQ：3 条未读；1 个好友申请（还有 1 项）/)
  assert.doesNotMatch(prompt, /不应该出现在一眼里/, 'cap 之外的不进提示词')
})

test('世界：按注册者查，再展开某一项', async () => {
  const { host } = await setup({ withMemory: false })
  await host.enable('world-state')
  const w = host.shared.get('world')
  w.registerSource({
    id: 'qq', owner: 'qq', title: 'QQ',
    items: () => [
      { key: 'unread', brief: '3 条未读', detail: '群 A 2 条；私聊 B 1 条' },
      { key: 'friend', brief: '1 个好友申请', detail: '来自 12345' },
    ],
  })
  const byOwner = w.read({ owner: 'qq' })
  assert.equal(byOwner.items.length, 2)
  assert.match(byOwner.text, /好友申请/)
  const one = w.read({ owner: 'qq', item: 'unread' })
  assert.match(one.text, /私聊 B 1 条/)
  const miss = w.read({ owner: 'qq', item: 'nope' })
  assert.match(miss.text, /没有这一项/)
})

test('世界：注册者撤回后仍报“无”；只有显式 empty:false 才彻底消失', async () => {
  const { host } = await setup({ withMemory: false })
  await host.enable('world-state')
  const w = host.shared.get('world')
  let alive = true
  w.registerSource({ id: 'mc', owner: 'mc', title: 'MC', items: () => (alive ? [{ key: 'server', brief: '当前活跃：127.0.0.1:63930' }] : []) })
  assert.match(w.renderBrief(), /127\.0\.0\.1:63930/)
  alive = false
  assert.doesNotMatch(w.renderBrief(), /127\.0\.0\.1:63930/)
  assert.match(w.renderBrief(), /MC：无/, '没内容时仍要告诉模型“这里现在没有”')
  assert.equal(w.read({ owner: 'mc' }).items.length, 1)
  assert.match(w.read({ owner: 'mc' }).text, /无/)

  w.registerSource({ id: 'quiet', owner: 'quiet', title: '静默源', empty: false, items: () => [] })
  assert.doesNotMatch(w.renderBrief(), /静默源/, 'empty:false 的源允许完全消失')
})

test('工具统一通道：所有插件的工具都只出现在核心的工具面里', async () => {
  const { host } = await setup({ withMemory: false })
  await host.enable('world-state')
  const names = host.services.tools.names()
  assert.deepEqual(names.sort(), ['world_status'])
  // 插件拿不到 dsh-tools：宿主是唯一注册通道
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'plugins', 'world-state', 'src', 'index.mjs'), 'utf8')
  assert.doesNotMatch(source, /@deepseek-ai\/dsh-tools/, '插件不许直接依赖 DSH 工具包')
})
