// 回归：审计发现、已修的行为。每条都对应一个曾经的真实缺陷。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost, attachDshAdapter, createDeliveryService } from '../src/index.mjs'
import { composeToolDescription } from '../src/services.mjs'
import * as memory from '../../plugins/memory/src/index.mjs'
import * as recall from '../../plugins/recall/src/index.mjs'
import * as world from '../../plugins/world-state/src/index.mjs'
import * as rhythm from '../../plugins/rhythm/src/index.mjs'
import * as focus from '../../plugins/focus/src/index.mjs'
import * as persona from '../../plugins/persona/src/index.mjs'
import * as dream from '../../plugins/dream/src/index.mjs'
import * as compaction from '../../plugins/compaction/src/index.mjs'
import * as editor from '../../plugins/editor/src/index.mjs'
import * as eager from '../../plugins/eager-recall/src/index.mjs'
import memoryManifest from '../../plugins/memory/manifest.json' with { type: 'json' }
import recallManifest from '../../plugins/recall/manifest.json' with { type: 'json' }
import worldManifest from '../../plugins/world-state/manifest.json' with { type: 'json' }
import rhythmManifest from '../../plugins/rhythm/manifest.json' with { type: 'json' }
import focusManifest from '../../plugins/focus/manifest.json' with { type: 'json' }
import personaManifest from '../../plugins/persona/manifest.json' with { type: 'json' }
import dreamManifest from '../../plugins/dream/manifest.json' with { type: 'json' }
import compactionManifest from '../../plugins/compaction/manifest.json' with { type: 'json' }
import editorManifest from '../../plugins/editor/manifest.json' with { type: 'json' }
import eagerManifest from '../../plugins/eager-recall/manifest.json' with { type: 'json' }
import biliManifest from '../../plugins/bili/manifest.json' with { type: 'json' }
import { toDshToolDefinition } from '../src/dsh-contract.mjs'

function fakeDsh() {
  const tools = new Map()
  return {
    tools: { register(def) { tools.set(def.name, def); return () => tools.delete(def.name) } },
    systemPrompt: { section() { return () => {} } },
    names: () => [...tools.keys()].sort(),
  }
}

function tempRoot(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `icl-${tag}-`))
}

test('适配器先挂上、之后启用插件，新工具也会推到 DSH', async () => {
  const host = createHost({ log: () => {} })
  host.registerPlugin(memoryManifest, memory, { config: { root: tempRoot('late') } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 's' } })
  const dsh = fakeDsh()
  attachDshAdapter(host, dsh, { sessionId: 's' })
  assert.deepEqual(dsh.names(), [])
  await host.enable('memory')
  await host.enable('recall')
  assert.ok(dsh.names().includes('remember'), `启用后应看到工具，实际：${dsh.names().join(',')}`)
})

test('会话的工具名与索引都按预设过滤', async () => {
  const host = createHost({ log: () => {} })
  const root = tempRoot('preset')
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 's' } })
  await host.enable('memory')
  await host.enable('recall')
  host.services.presets.define({ id: 'mem-only', allow: ['recall'] })
  host.services.presets.use('mem-only')
  const { createSessionAdapter } = await import('../src/session.mjs')
  const adapter = createSessionAdapter({ sessionId: 's', host, push: () => {} })
  const names = adapter.toolNames()
  assert.ok(names.includes('recall'), `应有 recall，实际：${names.join(',')}`)
  assert.ok(!names.includes('memo'), '预设外插件（note）的工具不应出现')
  assert.ok(!adapter.systemPrompt().includes('- memo:'), '预设外工具不应出现在索引里')
})

test('截断后的长度不超过预算', () => {
  assert.ok(composeToolDescription({ summary: 'S'.repeat(200) }, { maxChars: 30 }).length <= 30)
  assert.ok(composeToolDescription({ summary: 'S'.repeat(200) }, { maxChars: 1 }).length <= 1)
})

test('供应商注销会解除指向它的绑定', () => {
  const host = createHost({ log: () => {} })
  host.services.slots.declare({ id: 'chat', kind: 'chat', shape: {} })
  const off = host.services.slots.registerProvider({ id: 'p1', kind: 'chat', call: async () => 'ok' })
  host.services.slots.bind('chat', { provider: 'p1', call: async () => 'ok' })
  assert.ok(host.services.slots.resolve('chat'))
  off()
  assert.equal(host.services.slots.resolve('chat'), null)
})

test('投递重试耗尽后计入 droppedCount，不再无声消失', () => {
  let clock = 0
  const delivery = createDeliveryService({ now: () => clock, maxAttempts: 5 })
  delivery.push({ plugin: 'p', activity: 'a', text: 'x', seq: 1 })
  for (let i = 0; i < 10; i++) {
    const [batch] = delivery.drain('session')
    if (!batch) { clock += 60_000; continue }
    delivery.nack(batch.id, 'boom')
    clock += 60_000
  }
  assert.ok(delivery.droppedCount() >= 1, `应计入丢弃，实际 ${delivery.droppedCount()}`)
})

test('世界状态按注册者顺序拼装，句末不会出现「。；」', async () => {
  const host = createHost({ log: () => {} })
  const root = tempRoot('world')
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(worldManifest, world, {})
  host.registerPlugin(rhythmManifest, rhythm, { config: { dreamAt: '23:00', stateFile: path.join(root, 'r.json') } })
  for (const id of ['memory', 'world-state', 'rhythm']) await host.enable(id)
  const text = host.services.prompt.assemble({ sessionId: 's' })
  assert.ok(!text.includes('。；'), `不应出现「。；」，实际：${text}`)
  assert.ok(text.indexOf('时间：') < text.indexOf('作息：') || !text.includes('作息：'))
})


test('记忆库可以整份导出为 JSON 与 Markdown', async () => {
  const host = createHost({ log: () => {} })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-export-'))
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  await host.enable('memory')
  const mem = host.shared.get('memory')
  mem.registerNamespace({ id: 'event', label: '事件', recallable: true })
  mem.put({ namespace: 'event', kind: 'note', text: '导出测试', data: { tags: ['t'] } })
  const dump = mem.exportAll()
  assert.equal(dump.items.length, 1)
  const tool = host.services.tools.list().find((x) => x.name === 'memory_export')
  const jsonPath = path.join(root, 'dump.json')
  await tool.execute({ path: jsonPath, format: 'json' })
  const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
  assert.equal(parsed.items[0].text, '导出测试')
  const mdPath = path.join(root, 'dump.md')
  await tool.execute({ path: mdPath, format: 'md' })
  assert.match(fs.readFileSync(mdPath, 'utf8'), /导出测试/)
})

/* ── W5 审计回归（2026-11-05）：事实状态段 ≤1–2 行、顺序在人格之后；静默失败要留证据 ── */

test('focus 段排在人格之后，且分钟按 5 分钟取整（不再每分钟抖一次前缀）', async () => {
  let clock = Date.parse('2026-11-05T20:00:00+08:00')
  const host = createHost({ log: () => {}, now: () => clock })
  host.services.clock.set(() => clock)
  host.registerPlugin(personaManifest, persona, { config: { card: '人格正文' } })
  host.registerPlugin(focusManifest, focus, {})
  await host.enable('persona')
  await host.enable('focus')
  await host.services.tools.list().find((t) => t.name === 'focus_enter').execute({ title: '下矿', reason: '挖铁' })
  const t0 = host.services.prompt.assemble({})
  assert.ok(t0.indexOf('人格正文') < t0.indexOf('你现在在'), `人格应在前，实际：${t0}`)
  assert.doesNotMatch(t0, /已 \d+ 分钟/, '不足一档不说"已 0 分钟"')
  clock += 4 * 60_000
  assert.equal(host.services.prompt.assemble({}), t0, '4 分钟内段文本必须完全一致')
  clock += 2 * 60_000 // 累计 6 分钟
  assert.match(host.services.prompt.assemble({}), /已 5 分钟/)
})

test('world 段有长度上限：来源变多也不会无限长', async () => {
  const host = createHost({ log: () => {} })
  host.registerPlugin(worldManifest, world, { config: { maxChars: 80 } })
  await host.enable('world-state')
  const w = host.shared.get('world')
  for (let i = 0; i < 8; i++) {
    w.registerSource({ id: `s${i}`, owner: `o${i}`, title: `源${i}`, cap: 3, items: () => [{ key: 'a', brief: '很长的一条世界状态描述'.repeat(3) }] })
  }
  const text = host.services.prompt.assemble({})
  assert.ok(text.length <= 80, `应截断到 80 字以内，实际 ${text.length}：${text}`)
  assert.match(text, /…$/)
})

test('remember 的 origin / about 是可用对象参数，不是 additionalProperties:false 的空壳', async () => {
  const host = createHost({ log: () => {} })
  host.registerPlugin(memoryManifest, memory, { config: { root: tempRoot('schema') } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 's' } })
  await host.enable('memory')
  await host.enable('recall')
  const defs = new Map(host.services.tools.list().map((d) => [d.name, d]))
  const remember = toDshToolDefinition(defs.get('remember')).parameters
  assert.deepEqual(Object.keys(remember.properties.origin.properties).sort(), ['conv', 'messageId', 'platform', 'sender'])
  assert.deepEqual(Object.keys(remember.properties.about.properties).sort(), ['key', 'namespace'])
  const recallParams = toDshToolDefinition(defs.get('recall')).parameters
  assert.equal(recallParams.properties.about, undefined, 'recall 不处理 about（resolve 不可回忆），不该留死参数')
})

test('dream 由信号触发时把结果写进日志：模型插槽没绑也不静默', async () => {
  const logs = []
  const host = createHost({ log: (entry) => logs.push(entry) })
  host.registerPlugin(memoryManifest, memory, { config: { root: tempRoot('dream') } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 'live' } })
  host.registerPlugin(dreamManifest, dream, { config: { sessionId: 'live', persona: '人格', dreamAt: '23:00' } })
  for (const id of ['memory', 'recall', 'dream']) await host.enable(id)
  host.shared.get('memory').put({ namespace: 'event', kind: 'note', key: 'n1', text: '今天在河边看到白鹭。' })
  host.services.signals.emit({ id: 'e1', from: { plugin: 'time' }, kind: 'event', text: 'dream', tags: ['dream'] })
  await new Promise((resolve) => setTimeout(resolve, 50))
  const run = logs.filter((entry) => entry.msg === 'dream.run')
  assert.equal(run.length, 1, `应记录一次 dream.run，实际日志：${logs.map((x) => x.msg).join(',')}`)
  assert.equal(run[0].ok, false, '插槽没绑时 ok 必须是 false')
  assert.match(run[0].jobs, /fail/, `要写清哪个 job 失败：${run[0].jobs}`)
})

test('压缩失败要留日志（empty-summary 不是唯一信息）', async () => {
  const logs = []
  const host = createHost({ log: (entry) => logs.push(entry) })
  host.registerPlugin(memoryManifest, memory, { config: { root: tempRoot('compact-log') } })
  host.registerPlugin(compactionManifest, compaction, { config: { keepRecent: 2, triggerChars: 2000 } })
  await host.enable('memory')
  await host.enable('compaction')
  const out = await host.services.context.compact({ history: [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }, { role: 'user', text: 'c' }] })
  assert.equal(out.ok, false)
  assert.equal(out.error, 'empty-summary')
  const failed = logs.filter((entry) => entry.msg === 'compaction.summarize-fail')
  assert.equal(failed.length, 1, `应记录失败原因，实际日志：${logs.map((x) => x.msg).join(',')}`)
  assert.match(String(failed[0].error), /compact-chat|绑定|SLOT/i)
})

test('editor：读失败带原因，长文件截断有标记', async () => {
  const host = createHost({ log: () => {} })
  const root = tempRoot('editor')
  host.registerPlugin(editorManifest, editor, { config: { root } })
  await host.enable('editor')
  const tools = new Map(host.services.tools.list().map((d) => [d.name, d]))
  const missing = await tools.get('read_file').execute({ path: 'nope.txt' })
  assert.match(missing.text, /读不到这个文件：ENOENT/)
  fs.writeFileSync(path.join(root, 'big.txt'), 'x'.repeat(25000), 'utf8')
  const big = await tools.get('read_file').execute({ path: 'big.txt' })
  assert.match(big.text, /已截断/)
  assert.ok(big.text.length < 25000)
})

test('editor：写保护 ICL 自己的状态文件（记忆/日程/focus/原文），读仍然可以', async () => {
  const host = createHost({ log: () => {} })
  const root = tempRoot('editor-guard')
  fs.mkdirSync(path.join(root, 'state'), { recursive: true })
  fs.writeFileSync(path.join(root, 'state', 'memory.db'), 'FAKE-DB', 'utf8')
  host.registerPlugin(editorManifest, editor, { config: { root } })
  await host.enable('editor')
  const write = host.services.tools.list().find((d) => d.name === 'write_file')
  const read = host.services.tools.list().find((d) => d.name === 'read_file')
  // 注册表逐类覆盖：记忆/time/eager/focus/raw/mc/qq/bili/loop/album
  assert.ok(editor.PROTECTED_STATE_FILES.includes('memory.db'))
  assert.ok(editor.PROTECTED_STATE_FILES.includes('time-events.jsonl'))
  assert.ok(editor.PROTECTED_STATE_FILES.includes('eager-recall.jsonl'))
  assert.ok(editor.PROTECTED_STATE_FILES.includes('qq-ledger.db'))
  assert.ok(editor.PROTECTED_STATE_FILES.includes('bili/bili_credential.json'))
  assert.ok(editor.PROTECTED_STATE_FILES.includes('album/media.db'))
  for (const rel of editor.PROTECTED_STATE_FILES) {
    const out = await write.execute({ path: rel, text: '毁掉' })
    assert.match(out.text, /状态文件/, `${rel} 应被拒绝，实际：${out.text}`)
  }
  assert.equal(fs.readFileSync(path.join(root, 'state', 'memory.db'), 'utf8'), 'FAKE-DB', '原文件不能被改')
  const own = await write.execute({ path: 'notes/today.md', text: '我自己的笔记' })
  assert.match(own.text, /写好了/)
  assert.equal(fs.readFileSync(path.join(root, 'notes', 'today.md'), 'utf8'), '我自己的笔记')
  const peek = await read.execute({ path: 'state/memory.db' })
  assert.equal(peek.text, 'FAKE-DB', '读不受限')
})

test('bili：缺依赖时给可操作的错误；frames 的图现在是作为附件返回的', async () => {
  const saved = { BILI_PYTHON: process.env.BILI_PYTHON, BILI_RUNNER: process.env.BILI_RUNNER, BILI_DIR: process.env.BILI_DIR, STORYBOARD_CLI: process.env.STORYBOARD_CLI }
  process.env.BILI_PYTHON = path.join(tempRoot('nopy'), 'python.exe')
  process.env.BILI_RUNNER = path.join(tempRoot('norun'), 'bili-run.py')
  process.env.BILI_DIR = path.join(tempRoot('nodir'), 'bili-duty')
  process.env.STORYBOARD_CLI = path.join(tempRoot('noclis'), 'storyboard.mjs')
  try {
    const bili = await import(`../../plugins/bili/src/index.mjs?deps-missing=${Date.now()}`)
    const host = createHost({ log: () => {} })
    host.registerPlugin(biliManifest, bili, {})
    await host.enable('bili')
    const tools = new Map(host.services.tools.list().map((d) => [d.name, d]))
    const search = await tools.get('bili_search').execute({ keyword: '测试' })
    assert.match(search.text, /BILI_PYTHON/, `应指出去哪配 python：${search.text}`)
    assert.match(search.text, /不是视频\/网络的问题/)
    const frames = await tools.get('bili_frames').execute({ target: 'BV1xx411c7mD' })
    assert.match(frames.text, /STORYBOARD_CLI/, `应指出 storyboard CLI 缺：${frames.text}`)
    assert.match(tools.get('bili_frames').summary, /image is attached/)
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('eager-recall：没有嵌入时用退化阈值，相关记忆能被注入（且仍有长度上限）', async () => {
  const { host } = await (async () => {
    const h = createHost({ log: () => {}, now: () => Date.parse('2026-11-05T20:00:00+08:00') })
    h.registerPlugin(memoryManifest, memory, { config: { root: tempRoot('eager') } })
    h.registerPlugin(recallManifest, recall, { config: { sessionId: 's' } })
    h.registerPlugin(eagerManifest, eager, {})
    for (const id of ['memory', 'recall', 'eager-recall']) await h.enable(id)
    return { host: h }
  })()
  host.shared.get('memory').put({ namespace: 'event', kind: 'note', key: 'n1', text: '下午在河边看到一只白鹭，站了很久。', weight: 1.5 })
  const text = await host.services.prompt.turnText({ message: '今天在河边走了走，你在干嘛' })
  assert.ok(text.length > 0, 'bigram 退化路径下也应该命中（阈值 0.2，实测该句 0.25）')
  assert.match(text, /白鹭/)
  assert.ok(text.length <= 200, `不得超过 maxChars：${text.length}`)
})
