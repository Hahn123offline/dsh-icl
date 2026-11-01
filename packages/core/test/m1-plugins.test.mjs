// M1：记忆 + 轻量记忆 + 节律 + 梦境 + 模型管理。
//
// 这一组测试证明的是"形状接线"与"被动沉淀"这两条设计：
//   · 插件只声明插槽形状，管理器按形状绑（维度不对就不接）
//   · 轻记忆落在记忆插件的命名空间里（没有第二份存储）
//   · 梦境由节律触发，读当天笔记，写长期记忆

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../src/index.mjs'
import * as memory from '../../plugins/memory/src/index.mjs'
import * as rhythm from '../../plugins/rhythm/src/index.mjs'
import * as dream from '../../plugins/dream/src/index.mjs'
import * as recall from '../../plugins/recall/src/index.mjs'
import * as manager from '../../plugins/model-manager/src/index.mjs'
import memoryManifest from '../../plugins/memory/manifest.json' with { type: 'json' }
import rhythmManifest from '../../plugins/rhythm/manifest.json' with { type: 'json' }
import dreamManifest from '../../plugins/dream/manifest.json' with { type: 'json' }
import recallManifest from '../../plugins/recall/manifest.json' with { type: 'json' }
import managerManifest from '../../plugins/model-manager/manifest.json' with { type: 'json' }

function tmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-m1-'))
  return dir
}

async function setup({ providers = [] } = {}) {
  const host = createHost({ log: () => {} })
  const root = tmpRoot()
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 's1' } })
  host.registerPlugin(rhythmManifest, rhythm, { config: { dreamAt: '22:30' } })
  host.registerPlugin(dreamManifest, dream, { config: { sessionId: 's1' } })
  host.registerPlugin(managerManifest, manager, { config: { providers } })
  return { host, root }
}

test('记忆：命名空间隔离，互不相见', async () => {
  const { host } = await setup()
  await host.enable('memory')
  const mem = host.services.tools // 只是为了拿到 host 已启用；实际走服务
  void mem
  const memoryApi = host.shared.get('memory')
  memoryApi.registerNamespace({ id: 'a', label: 'A' })
  memoryApi.registerNamespace({ id: 'b', label: 'B' })
  memoryApi.put({ namespace: 'a', text: '甲的事' })
  memoryApi.put({ namespace: 'b', text: '乙的事' })
  assert.deepEqual(memoryApi.query({ namespace: 'a' }).map((r) => r.text), ['甲的事'])
  assert.deepEqual(memoryApi.query({ namespace: 'b' }).map((r) => r.text), ['乙的事'])
})

test('主动记忆：remember 落在事件命名空间，没有第二份库', async () => {
  const { host } = await setup()
  await host.enable('memory')
  await host.enable('recall')
  const tools = host.services.tools.list()
  const remember = tools.find((t) => t.name === 'remember')
  const recall = tools.find((t) => t.name === 'recall')
  assert.ok(remember && recall)
  await remember.execute({ text: '记得给他带伞' })
  const memoryApi = host.shared.get('memory')
  const rows = memoryApi.query({ namespace: 'event', kind: 'note' })
  assert.equal(rows.length, 1)
  assert.match(rows[0].text, /带伞/)
  const out = await recall.execute({})
  assert.match(out.text, /带伞/)
})

test('形状接线：维度不对的嵌入供应商不会被接上', async () => {
  const { host } = await setup({
    providers: [
      { id: 'embed-768', kind: 'embedding', shape: { dim: 768 }, baseUrl: 'http://127.0.0.1:1/v1', model: 'x' },
    ],
  })
  await host.enable('model-manager')
  await host.enable('memory')
  const slots = host.services.slots
  assert.equal(slots.unmatched().length, 1, '1024 的插槽不能接 768 的供应商')
  assert.equal(slots.resolve('embed-text'), null)
})

test('形状接线：维度对了就自动接上，不需要任何插件写死模型名', async () => {
  const { host } = await setup({
    providers: [{ id: 'embed-1024', kind: 'embedding', shape: { dim: 1024 }, baseUrl: 'http://127.0.0.1:1/v1', model: 'whatever' }],
  })
  await host.enable('model-manager')
  await host.enable('memory')
  const slots = host.services.slots
  assert.equal(slots.unmatched().length, 0)
  assert.equal(slots.resolve('embed-text').provider, 'embed-1024')
})

test('梦境：节律触发 → 读当天笔记 → 写进长期命名空间', async () => {
  const host = createHost({ log: () => {} })
  const root = tmpRoot()
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 's1' } })
  host.registerPlugin(rhythmManifest, rhythm, { config: { dreamAt: '22:30' } })
  host.registerPlugin(dreamManifest, dream, { config: { sessionId: 's1' } })
  host.registerPlugin(managerManifest, manager, {
    config: { providers: [{ id: 'fake-chat', kind: 'chat', shape: { tools: false } }] },
  })
  await host.enable('model-manager')
  await host.enable('memory')
  await host.enable('recall')
  await host.enable('rhythm')
  await host.enable('dream')

  const remember = host.services.tools.list().find((t) => t.name === 'remember')
  await remember.execute({ text: '今天他提到想去看海', kind: 'event' })
  // 把 chat 供应商换成假的，避免真的打网络
  host.services.slots.registerProvider({
    id: 'fake-chat-2', kind: 'chat', shape: { tools: false },
    call: async () => '他今天说想去看海，我记下了。',
  })
  host.services.slots.bind('dream-chat', { provider: 'fake-chat-2', call: async () => '他今天说想去看海，我记下了。' })

  const out = await host.shared.get('dream').run({ now: Date.now() })
  assert.equal(out.ok, true)
  assert.equal(out.notes, 1)
  const memoryApi = host.shared.get('memory')
  const dreams = memoryApi.query({ namespace: 'event', kind: 'block' })
  assert.equal(dreams.length, 1)
  assert.match(dreams[0].text, /看海/)
})

test('梦境：没有笔记就跳过，不产出空记忆', async () => {
  const { host } = await setup({ providers: [{ id: 'fake-chat', kind: 'chat', shape: { tools: false } }] })
  await host.enable('model-manager')
  await host.enable('memory')
  await host.enable('recall')
  await host.enable('rhythm')
  await host.enable('dream')
  const out = await host.shared.get('dream').run({ now: Date.now() })
  assert.equal(out.skipped, 'no-notes')
})

test('依赖顺序：recall 没先启用 memory 就拒绝启用', async () => {
  const host = createHost({ log: () => {} })
  host.registerPlugin(memoryManifest, memory, { config: { root: tmpRoot() } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 's1' } })
  await assert.rejects(() => host.enable('recall'), /需要先启用插件：memory/)
})

test('停用插件会收回它提供的能力（避免幽灵服务）', async () => {
  const { host } = await setup()
  await host.enable('memory')
  assert.ok(host.shared.get('memory'))
  host.disable('memory')
  assert.equal(host.shared.get('memory') ?? null, null)
})
