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

async function setup({ withMemory = true, card = '' } = {}) {
  const host = createHost({ log: () => {} })
  const session = createSessionAdapter({ sessionId: 's1', host, push: async () => {} })
  if (withMemory) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-m1b-'))
    host.registerPlugin(memoryManifest, memory, { config: { root } })
    await host.enable('memory')
  }
  host.registerPlugin(personaManifest, persona, { config: { card } })
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

test('世界：默认只把 summary 层放进提示词', async () => {
  const { host, session } = await setup({ withMemory: false })
  await host.enable('world-state')
  const w = host.shared.get('world')
  w.registerSource({ id: 'qq', layer: 'summary', order: 30, text: () => 'QQ：3 条未读' })
  w.registerSource({ id: 'qq-detail', layer: 'detail', order: 40, text: () => '· 群 A 2 条\n· 私聊 B 1 条' })
  const prompt = session.systemPrompt()
  assert.match(prompt, /现在是 /)
  assert.match(prompt, /QQ：3 条未读/)
  assert.doesNotMatch(prompt, /私聊 B/, 'summary 层不能把正文塞进提示词')
})

test('世界：detail 层把两层都渲染出来，顺序按 order', async () => {
  const { host } = await setup({ withMemory: false })
  await host.enable('world-state')
  const w = host.shared.get('world')
  w.registerSource({ id: 'a', layer: 'summary', order: 30, text: () => 'A' })
  w.registerSource({ id: 'b', layer: 'detail', order: 20, text: () => 'B' })
  const detail = w.render('detail')
  assert.ok(detail.indexOf('B') >= 0 && detail.indexOf('A') > detail.indexOf('B'), 'order 20 在 30 前面')
})

test('世界：未注册来源的调用方拿到空字符串，不抛错', async () => {
  const { host } = await setup({ withMemory: false })
  await host.enable('world-state')
  assert.equal(host.shared.get('world').render('detail').includes('现在是'), true)
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
