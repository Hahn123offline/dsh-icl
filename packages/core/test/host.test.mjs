// M0 硬标准：插件卸载后，模型在**下一轮**看不到它的工具。
//
// 这条如果不过，"动态工具面"就是口号。

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHost, createSessionAdapter } from '../src/index.mjs'
import * as persona from '../../plugins/persona/src/index.mjs'
import * as worldState from '../../plugins/world-state/src/index.mjs'
import personaManifest from '../../plugins/persona/manifest.json' with { type: 'json' }
import worldManifest from '../../plugins/world-state/manifest.json' with { type: 'json' }

function setup({ pushes = [] } = {}) {
  const host = createHost({ log: () => {} })
  const session = createSessionAdapter({
    sessionId: 'session-test',
    host,
    push: async (text) => { pushes.push(text) },
  })
  return { host, session, pushes }
}

test('启用插件后，工具出现在这一轮的工具面上', async () => {
  const { host, session } = setup()
  host.registerPlugin(worldManifest, worldState)
  assert.deepEqual(session.toolNames(), [], '启用前没有任何工具')
  await host.enable('world-state')
  assert.deepEqual(session.toolNames(), ['world_now'])
})

test('停用插件后，工具立刻从工具面消失（动态工具面）', async () => {
  const { host, session } = setup()
  host.registerPlugin(worldManifest, worldState)
  await host.enable('world-state')
  assert.ok(session.toolNames().includes('world_now'))
  host.disable('world-state')
  assert.deepEqual(session.toolNames(), [], '卸载后必须一个都不剩')
})

test('停用后提示词段也一起消失，重新启用又回来', async () => {
  const { host, session } = setup()
  host.registerPlugin(worldManifest, worldState)
  await host.enable('world-state')
  assert.match(session.systemPrompt(), /现在是 /)
  host.disable('world-state')
  assert.doesNotMatch(session.systemPrompt(), /现在是 /)
  await host.enable('world-state')
  assert.match(session.systemPrompt(), /现在是 /)
})

test('两个插件的段按 order 排：时间在前，人格在后', async () => {
  const { host, session } = setup()
  host.registerPlugin(personaManifest, persona, { config: { card: '我是大肥鱼' } })
  host.registerPlugin(worldManifest, worldState)
  await host.enable('persona')
  await host.enable('world-state')
  const text = session.systemPrompt()
  assert.ok(text.includes('我是大肥鱼'), '人格正文要在')
  assert.ok(text.indexOf('现在是 ') < text.indexOf('我是大肥鱼'), 'world(order 10) 在 persona(order 20) 前面')
  assert.doesNotMatch(text, /\n\n\n/, '段之间只留一个空行')
})

test('apply 中途抛错：已经注册的东西要收回去，不留半套', async () => {
  const { host, session } = setup()
  const broken = { apply(ctx) { ctx.tools.register({ name: 'half_tool', description: 'x', parameters: {} }); throw new Error('boom') } }
  host.registerPlugin({ id: 'broken', version: '0.1.0', entry: './x.mjs', tools: ['half_tool'] }, broken)
  await assert.rejects(() => host.enable('broken'), /boom/)
  assert.deepEqual(session.toolNames(), [], '失败的插件不能留下工具')
})

test('清单校验：非法 id / 缺字段直接拒绝', () => {
  const { host } = setup()
  assert.throws(() => host.registerPlugin({ id: 'Bad Id', version: '1', entry: './x' }, { apply() {} }), /不合法/)
  assert.throws(() => host.registerPlugin({ id: 'ok', entry: './x' }, { apply() {} }), /version/)
  assert.throws(() => host.registerPlugin({ id: 'ok', version: '1', entry: './x' }, {}), /apply/)
})
