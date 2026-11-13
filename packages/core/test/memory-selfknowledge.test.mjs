// v3 记忆自知 + 召回行为（2026-11-13 用户拍板）：world 状态行、memory_status 工具、低置信召回提示。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../src/index.mjs'
import * as memory from '../../plugins/memory/src/index.mjs'
import * as recall from '../../plugins/recall/src/index.mjs'
import * as eager from '../../plugins/eager-recall/src/index.mjs'
import * as worldState from '../../plugins/world-state/src/index.mjs'
import memoryManifest from '../../plugins/memory/manifest.json' with { type: 'json' }
import recallManifest from '../../plugins/recall/manifest.json' with { type: 'json' }
import eagerManifest from '../../plugins/eager-recall/manifest.json' with { type: 'json' }
import worldManifest from '../../plugins/world-state/manifest.json' with { type: 'json' }

async function setup() {
  const host = createHost({ log: () => {} })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-selfknow-'))
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(worldManifest, worldState, {})
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 's1', schema: 'v3' } })
  host.registerPlugin(eagerManifest, eager, { config: { schema: 'v3', minScore: 0.99, minScoreNoEmbed: 0.99, hintThreshold: 0.2, hintCooldownMs: 60_000 } })
  await host.enable('memory')
  await host.enable('world-state')
  await host.enable('recall')
  await host.enable('eager-recall')
  const tools = Object.fromEntries(host.services.tools.list().map((tool) => [tool.name, tool]))
  return { host, tools, memory: host.shared.get('memory') }
}

function seedEpisode(memory, { day, key, title, body, commitments = [] }) {
  return memory.put({
    namespace: 'episode', kind: 'block', key, text: title,
    data: { body, day, evidence: [{ type: 'day', id: 1, line: 'x' }], provisional: false, annotations: { commitments } },
  })
}

test('记忆自知：world 状态行 + memory_status 工具给出经历范围/未结承诺', async () => {
  const { host, tools, memory } = await setup()
  seedEpisode(memory, { day: '2026-11-10', key: 'epi:1', title: '修好了视频工具', body: '下午修好了视频工具，第一次抽帧看视频。', commitments: ['答应周末一起看直播'] })
  seedEpisode(memory, { day: '2026-11-11', key: 'epi:2', title: '测 MC 新端口', body: '晚上测试 MC 新端口，桥接还是报错。', commitments: ['答应修好桥接后叫我来测'] })
  const status = await tools.memory_status.execute({})
  assert.match(status.text, /记忆状态/)
  assert.match(status.text, /经历 2 段/)
  assert.match(status.text, /未结承诺/)
  assert.match(status.text, /答应周末一起看直播/)
  const world = host.shared.get('world')
  const owner = world.read({ owner: 'memory' })
  assert.equal(owner.items.length, 1)
  assert.match(owner.items[0].brief, /经历 2 段/)
  const expanded = world.read({ owner: 'memory', item: owner.items[0].key })
  assert.ok(String(expanded.detail ?? expanded.text).length > 20, 'world_status 展开应有细节')
})

test('低置信召回提示：有相关但低于注入阈值时，只提示可能有记忆、不注入内容', async () => {
  const { host, memory } = await setup()
  seedEpisode(memory, { day: '2026-11-11', key: 'epi:hint', title: '去海边看日落', body: '傍晚去海边看日落，风很大，但很好看。' })
  const text = String(await host.services.prompt.turnText({ message: '上次去海边看日落是什么感觉？', now: Date.now() }) ?? '')
  assert.match(text, /可能有相关记忆|有相关记忆/, `应给出低置信提示，实际：${text}`)
  assert.match(text, /recall/, '提示应引导使用 recall 查看')
  assert.ok(!/你可能记得（检索结果/.test(text), '低置信提示不应把内容当记忆注入')
})


test('意图路由：问承诺时，episode 的块内承诺会被加分并直接展示', async () => {
  const { tools, memory } = await setup()
  memory.put({
    namespace: 'episode', kind: 'block', key: 'epi:promise', text: '周末直播安排',
    data: {
      body: '晚上聊到周末的安排，说好了一起看直播。', day: '2026-11-11',
      evidence: [{ type: 'day', id: 1, line: 'x' }], provisional: false,
      annotations: { commitments: ['答应周末一起看直播', '答应下周三前把工具修好'] },
    },
  })
  const out = await tools.recall.execute({ query: '我答应过什么还没做的？' })
  assert.match(out.text, /块内承诺：/, `应展示块内承诺，实际：${out.text}`)
  assert.match(out.text, /答应周末一起看直播/)
})

test('意图路由：问"是谁"时，即使人物档案分数被经历块压过，也会补进结果', async () => {
  const { tools, memory } = await setup()
  memory.put({
    namespace: 'person', kind: 'block', key: 'person:42', text: '3429502459（主人）',
    data: {
      profile: '主人，QQ 3429502459，一直在帮我搭环境、调权限。',
      ids: [{ kind: 'qq', value: '3429502459' }],
      familiarity: '很熟',
    },
  })
  memory.put({
    namespace: 'episode', kind: 'block', key: 'epi:owner', text: '主人帮我修桥接',
    data: { body: '主人晚上帮我修了桥接，还调了权限。', day: '2026-11-11', evidence: [{ type: 'day', id: 1, line: 'x' }], provisional: false },
  })
  const out = await tools.recall.execute({ query: '3429502459 是谁？' })
  assert.match(out.text, /主人，QQ 3429502459/, `应包含人物档案，实际：${out.text}`)
})

test('人物短笔记不占人物档案配额：档案和短事实能同时出现', async () => {
  const { tools, memory } = await setup()
  memory.put({
    namespace: 'person', kind: 'block', key: 'person:3429502459', text: '主人（3429502459）',
    data: { profile: '主人最近在赶复习，下周考试，离散和计组之前没好好学，说主要还是自己菜。', ids: [{ kind: 'qq', value: '3429502459' }], familiarity: '很熟' },
  })
  memory.put({
    namespace: 'person', kind: 'note', key: 'note:review', text: '早，还在赶，复习中',
    data: { at: Date.now(), day: '2026-11-11' },
  })
  const out = await tools.recall.execute({ query: '复习中' })
  assert.match(out.text, /离散和计组/, `人物档案不应被人物短笔记挤掉：${out.text}`)
})

