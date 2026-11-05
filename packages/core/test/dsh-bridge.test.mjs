// DSH 接线契约：工具定义、投递、回合、原文、每轮上下文、单会话。
//
// 这些测试**不连真 DSH**，但假 ctx 的签名与安装包一致：
//   tools.register 要求 output；systemPrompt.section 的 text 是函数；事件是 (session, event)。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../src/index.mjs'
import {
  toDshToolDefinition, toDshUserMessage, normalizeParameters, textOfSessionEvent,
} from '../src/index.mjs'
import { createDshBridge } from '../../dsh-icl/src/bridge.mjs'
import { createIclPlugin } from '../../dsh-icl/src/plugin.mjs'
import { bootstrapHost } from '../../dsh-icl/src/bootstrap.mjs'
import { DEFAULT_PLUGINS, normalizeConfig } from '../../dsh-icl/src/config.mjs'
import * as memory from '../../plugins/memory/src/index.mjs'
import * as recall from '../../plugins/recall/src/index.mjs'
import * as note from '../../plugins/note/src/index.mjs'
import memoryManifest from '../../plugins/memory/manifest.json' with { type: 'json' }
import recallManifest from '../../plugins/recall/manifest.json' with { type: 'json' }
import noteManifest from '../../plugins/note/manifest.json' with { type: 'json' }

function fakeCtx({ withContext = true } = {}) {
  const tools = new Map()
  const sections = new Map()
  const contexts = new Map()
  const handlers = new Map()
  const logs = []
  const logger = {
    info: (line) => logs.push(['info', line]),
    warn: (line) => logs.push(['warn', line]),
    error: (line) => logs.push(['error', line]),
    debug: (line) => logs.push(['debug', line]),
  }
  const ctx = {
    tools: {
      register(def) {
        assert.equal(typeof def.name, 'string')
        assert.equal(typeof def.execute, 'function')
        assert.ok(def.output && typeof def.output.render === 'function', `${def.name} 必须有 output`)
        assert.equal(typeof def.parameters, 'object')
        assert.equal(def.parameters.type, 'object')
        assert.ok(Object.hasOwn(def.parameters, 'additionalProperties'), `${def.name} 参数必须是闭合对象`)
        tools.set(def.name, def)
        return () => tools.delete(def.name)
      },
    },
    systemPrompt: {
      section(sec) {
        assert.equal(typeof sec.text, 'function')
        sections.set(sec.name, sec)
        return () => sections.delete(sec.name)
      },
    },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(handler)
      return () => {
        const list = handlers.get(event) ?? []
        const index = list.indexOf(handler)
        if (index >= 0) list.splice(index, 1)
      }
    },
    logger: () => logger,
    fire(event, ...args) {
      for (const handler of handlers.get(event) ?? []) handler(...args)
    },
    async fireAsync(event, ...args) {
      for (const handler of handlers.get(event) ?? []) await handler(...args)
    },
    tools_: tools, sections_: sections, contexts_: contexts, handlers_: handlers, logs,
  }
  // 真 DSH 的 SystemPrompt 有 context()（运行时上下文快照通道）；旧宿主没有。
  // 两种都要覆盖：有 → 静/动拆开；没有 → 退回单 section 全量。
  if (withContext) {
    ctx.systemPrompt.context = (sec) => {
      assert.equal(typeof sec.text, 'function')
      contexts.set(sec.name, sec)
      return () => contexts.delete(sec.name)
    }
  }
  return ctx
}

function fakeSession(id, { preset = 'icl', events = [] } = {}) {
  return {
    id,
    header: { id, agentPreset: preset, cwd: 'C:/tmp/icl' },
    deriveMessages: () => events,
  }
}

function fakeAgent(session) {
  return {
    id: session.id,
    session,
    followups: [],
    followup(message) { this.followups.push(message) },
  }
}

function tempRoot(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `icl-dsh-${tag}-`))
}

async function hostWithMemory(root) {
  const host = createHost({ log: () => {} })
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 's1' } })
  host.registerPlugin(noteManifest, note, {})
  await host.enable('memory')
  await host.enable('recall')
  await host.enable('note')
  return host
}

/* ── 纯契约 ─────────────────────────────────────────────── */

test('toDshToolDefinition 补上 DSH 必填的 output，并闭合参数对象', () => {
  const def = toDshToolDefinition({
    name: 'demo_tool',
    description: 'demo',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        nested: { type: 'object', properties: { a: { type: 'string' } } },
      },
      required: ['text', 'missing'],
    },
    async execute() { return { text: 'ok' } },
  })
  assert.equal(def.name, 'demo_tool')
  assert.equal(typeof def.output.render, 'function')
  assert.equal(def.parameters.additionalProperties, false)
  assert.deepEqual(def.parameters.required, ['text'])
  assert.equal(def.parameters.properties.nested.additionalProperties, false)
})

test('工具结果统一成 {text}：字符串、对象、图片路径', async () => {
  const def = toDshToolDefinition({ name: 'x', description: '', parameters: { type: 'object', properties: {} }, async execute() { return 'plain' } })
  assert.deepEqual(await def.execute({}), { text: 'plain' })
  assert.deepEqual(def.output.render({}, { text: 'plain' }), [{ type: 'text', text: 'plain' }])

  const withImage = toDshToolDefinition({ name: 'y', description: '', parameters: { type: 'object', properties: {} }, async execute() { return { text: '帧', imagePath: 'C:/a.png' } } })
  assert.match((await withImage.execute({})).text, /C:\/a\.png/)
})

test('toDshUserMessage 与 createUserMessage 同形', () => {
  const message = toDshUserMessage('你好')
  assert.equal(message.role, 'user')
  assert.equal(typeof message.id, 'string')
  assert.deepEqual(message.content, [{ type: 'text', text: '你好' }])
  assert.deepEqual(message.source, { kind: 'user' })
})

test('原文事件能取到 tool/result 的文本', () => {
  assert.equal(textOfSessionEvent({ type: 'tool/result', data: { message: { content: [{ type: 'text', text: '视频标题' }] } } }), '视频标题')
  assert.equal(textOfSessionEvent({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '看完了' }] } } }), '看完了')
})

test('normalizeParameters 不会丢失闭合标记', () => {
  const out = normalizeParameters({ type: 'object', properties: {}, additionalProperties: true })
  assert.equal(out.additionalProperties, true)
})

/* ── 桥 ─────────────────────────────────────────────────── */

test('桥：工具面带 output，能真的执行', async () => {
  const root = tempRoot('tools')
  const host = await hostWithMemory(root)
  const ctx = fakeCtx()
  const bridge = createDshBridge({ ctx, host, config: { stateDir: root, rawFile: path.join(root, 'raw.jsonl') } })
  bridge.start()

  assert.ok(ctx.tools_.has('memo'))
  assert.ok(ctx.tools_.has('remember'))
  assert.equal(ctx.sections_.get('icl:core').name, 'icl:core')
  const out = await ctx.tools_.get('memo').execute({ text: '明天问她' })
  assert.deepEqual(out, { text: '记下了。' })
  bridge.dispose()
})

test('桥：系统段只含静态段，动态事实走 systemPrompt.context', async () => {
  const root = tempRoot('layout')
  const host = await hostWithMemory(root)
  const ctx = fakeCtx()
  let minute = '18:00'
  host.services.prompt.section({ name: 'probe-static', order: 20, text: () => '你是小千。' })
  host.services.prompt.section({ name: 'probe-facts', order: 880, text: () => `时间：${minute}` })
  const bridge = createDshBridge({ ctx, host, config: { stateDir: root, rawFile: path.join(root, 'raw.jsonl') } })
  bridge.start()

  const core = ctx.sections_.get('icl:core')
  const facts = ctx.contexts_.get('icl:facts')
  assert.ok(core, '静态段仍然注册成 systemPrompt.section')
  assert.ok(facts, '动态段注册成 systemPrompt.context（运行时上下文快照）')
  assert.equal(facts.order, 850)
  assert.equal(core.text({}), '你是小千。')
  assert.equal(facts.text({}), '时间：18:00')
  assert.equal(bridge.status().stats.factsInContext, true)

  // 时间变了：系统提示词必须一个字节都不变（前缀缓存靠这个）。
  minute = '18:01'
  assert.equal(core.text({}), '你是小千。', '动态事实不得回流进系统提示词')
  assert.equal(facts.text({}), '时间：18:01')
  bridge.dispose()
  assert.equal(ctx.contexts_.size, 0, 'dispose 要撤掉 facts context')
  assert.equal(ctx.sections_.size, 0)
})

test('桥：没有动态事实时 facts context 返回空（DSH 会跳过空段）', async () => {
  const root = tempRoot('layout-empty')
  const host = await hostWithMemory(root)
  const ctx = fakeCtx()
  host.services.prompt.section({ name: 'probe-static', order: 20, text: () => '你是小千。' })
  const bridge = createDshBridge({ ctx, host, config: { stateDir: root, rawFile: path.join(root, 'raw.jsonl') } })
  bridge.start()
  assert.equal(ctx.sections_.get('icl:core').text({}), '你是小千。')
  assert.equal(ctx.contexts_.get('icl:facts').text({}), '')
  bridge.dispose()
})

test('桥：宿主没有 systemPrompt.context 时退回单 section 全量（含动态事实）', async () => {
  const root = tempRoot('layout-fallback')
  const host = await hostWithMemory(root)
  const ctx = fakeCtx({ withContext: false })
  host.services.prompt.section({ name: 'probe-static', order: 20, text: () => '你是小千。' })
  host.services.prompt.section({ name: 'probe-facts', order: 880, text: () => '时间：18:00' })
  const logs = []
  const bridge = createDshBridge({ ctx, host, log: (entry) => logs.push(entry), config: { stateDir: root, rawFile: path.join(root, 'raw.jsonl') } })
  bridge.start()
  assert.equal(ctx.sections_.get('icl:core').text({}), '你是小千。\n\n时间：18:00', '降级路径不能丢事实')
  assert.equal(bridge.status().stats.factsInContext, false)
  assert.ok(logs.some((entry) => entry.msg === 'icl.prompt-layout' && entry.layout === 'single-section'), '降级要留日志')
  bridge.dispose()
})

test('prompt.assemble 支持 minOrder/maxOrder 过滤，默认全量不变', () => {
  const host = createHost({ log: () => {} })
  host.services.prompt.section({ name: 'static', order: 20, text: () => '静态' })
  host.services.prompt.section({ name: 'facts', order: 880, text: () => '动态' })
  assert.equal(host.services.prompt.assemble({}), '静态\n\n动态')
  assert.equal(host.services.prompt.assemble({}, { maxOrder: 799 }), '静态')
  assert.equal(host.services.prompt.assemble({}, { minOrder: 800 }), '动态')
  assert.equal(host.services.prompt.assemble({}, { minOrder: 100, maxOrder: 200 }), '')
})

test('桥：绑定新会话清空旧投递队列', async () => {
  const root = tempRoot('bind-clear')
  const host = await hostWithMemory(root)
  const ctx = fakeCtx()
  const bridge = createDshBridge({ ctx, host, config: { stateDir: root, rawFile: path.join(root, 'raw.jsonl') } })
  bridge.start()
  host.services.delivery.push({ source: { plugin: 'time' }, content: { text: '旧会话的消息' } })
  assert.equal(host.services.delivery.pendingCount(), 1)
  bridge.bindSession(fakeSession('s1'))
  assert.equal(host.services.delivery.pendingCount(), 0, '新会话不应继承旧队列')
  bridge.dispose()
})

test('桥：插件投递用 steer(plugin notice)，不是 user followup', async () => {
  const root = tempRoot('steer')
  const host = await hostWithMemory(root)
  const ctx = fakeCtx()
  const bridge = createDshBridge({ ctx, host, config: { stateDir: root, rawFile: path.join(root, 'raw.jsonl') } })
  bridge.start()
  const session = fakeSession('s1')
  const agent = fakeAgent(session)
  agent.steers = []
  agent.steer = (message) => { agent.steers.push(message) }
  bridge.bindSession(session)
  bridge.bindAgent(agent)
  host.services.delivery.push({ source: { plugin: 'time', activity: 'schedule' }, content: { text: '该起床了' } })
  assert.deepEqual(bridge.tick(), { sent: 1 })
  assert.equal(agent.followups.length, 0)
  assert.equal(agent.steers.length, 1)
  assert.equal(agent.steers[0].source.kind, 'plugin:time')
  assert.equal(agent.steers[0].source.form, 'notice')
  assert.match(agent.steers[0].source.summary, /时间/)
  bridge.dispose()
})

test('桥：delivery → agent.followup，并 ack', async () => {
  const root = tempRoot('deliver')
  const host = await hostWithMemory(root)
  const ctx = fakeCtx()
  const bridge = createDshBridge({ ctx, host, config: { stateDir: root, rawFile: path.join(root, 'raw.jsonl') } })
  bridge.start()
  const session = fakeSession('s1')
  const agent = fakeAgent(session)
  bridge.bindSession(session)
  bridge.bindAgent(agent)

  host.services.delivery.push({ source: { plugin: 'time', activity: 'schedule' }, content: { text: '该起床了' } })
  assert.equal(host.services.delivery.pendingCount(), 1)
  assert.deepEqual(bridge.tick(), { sent: 1 })
  assert.equal(agent.followups.length, 1)
  assert.equal(agent.followups[0].content[0].text, '该起床了')
  assert.equal(host.services.delivery.pendingCount(), 0)
  assert.equal(host.services.delivery.inflightCount(), 0)
  bridge.dispose()
})

test('桥：session/event 进原文层并发出 turn-end 信号', async () => {
  const root = tempRoot('events')
  const host = await hostWithMemory(root)
  const ctx = fakeCtx()
  const bridge = createDshBridge({ ctx, host, config: { stateDir: root, rawFile: path.join(root, 'raw.jsonl') } })
  bridge.start()
  const session = fakeSession('s1')
  bridge.bindSession(session)

  const got = []
  host.services.signals.on({ tags: ['turn-end'] }, (signal) => got.push(signal))
  bridge.onEvent(session, { type: 'user/message', seq: 1, time: Date.now(), data: { message: { content: [{ type: 'text', text: '在吗' }] } } })
  bridge.onEvent(session, { type: 'tool/result', seq: 2, time: Date.now(), data: { message: { content: [{ type: 'text', text: '视频标题' }] } } })
  // DSH 的 runtime-context 也是 user/message，但不是人说的话
  bridge.onEvent(session, { type: 'user/message', seq: 4, time: Date.now(), data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Current runtime context.' }] } })
  bridge.onEvent(session, { type: 'turn/end', seq: 3 })

  const rows = await host.services.raw.list({ limit: 10 })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].text, '在吗')
  assert.equal(rows[1].role, 'tool')
  assert.equal(got.length, 1)
  assert.equal(got[0].meta.seq, 3)
  // 同一个 turn-end 重放不会重复发（id 幂等）
  bridge.onEvent(session, { type: 'turn/end', seq: 3 })
  assert.equal(got.length, 1)
  bridge.dispose()
})

test('桥：历史来自 session.deriveMessages，不扫文件', async () => {
  const root = tempRoot('history')
  const host = await hostWithMemory(root)
  const ctx = fakeCtx()
  const bridge = createDshBridge({ ctx, host, config: { stateDir: root, rawFile: path.join(root, 'raw.jsonl') } })
  bridge.start()
  const session = fakeSession('s1', {
    events: [
      { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '早' }] },
      { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Current runtime context.' }] },
      { role: 'assistant', content: [{ type: 'text', text: '早呀' }] },
      { role: 'system', content: [{ type: 'text', text: 'ignored' }] },
    ],
  })
  bridge.bindSession(session)
  assert.deepEqual(bridge.history({ limit: 10 }), [
    { role: 'user', text: '早' },
    { role: 'assistant', text: '早呀' },
  ])
  bridge.dispose()
})

test('桥：agent/pre-step 把本轮上下文追加进这一批消息', async () => {
  const root = tempRoot('prestep')
  const host = await hostWithMemory(root)
  const ctx = fakeCtx()
  const bridge = createDshBridge({ ctx, host, config: { stateDir: root, rawFile: path.join(root, 'raw.jsonl') } })
  bridge.start()
  const session = fakeSession('s1')
  bridge.bindSession(session)
  bridge.bindAgent(fakeAgent(session))
  host.services.context.onAssemble({ name: 'recall', apply: () => '早前聊过那只猫。' })

  const user = toDshUserMessage('继续', { id: 'u-1' })
  const runtime = toDshUserMessage('Current runtime context.', {
    id: 'r-1',
    source: { kind: 'runtime-context', form: 'snapshot', sections: [] },
  })
  const decision = await bridge.preStep({ agent: { session } }, async () => ({ kind: 'enter', messages: [user, runtime], startsRequestSeries: true }))
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 3)
  assert.ok(decision.messages[2].id.startsWith('icl-ctx-'))
  assert.match(decision.messages[2].content[0].text, /早前聊过那只猫/)
  assert.equal(decision.messages[2].source.kind, 'runtime-context')
  assert.equal(decision.startsRequestSeries, true, '不能丢掉 waterfall 的其它字段')
  bridge.dispose()
})

test('桥：批次里只有 runtime-context 时不注入', async () => {
  const root = tempRoot('prestep-runtime')
  const host = await hostWithMemory(root)
  const ctx = fakeCtx()
  const bridge = createDshBridge({ ctx, host, config: { stateDir: root, rawFile: path.join(root, 'raw.jsonl') } })
  bridge.start()
  const session = fakeSession('s1')
  bridge.bindSession(session)
  bridge.bindAgent(fakeAgent(session))
  host.services.context.onAssemble({ name: 'recall', apply: () => '不该出现' })
  const runtime = toDshUserMessage('Current runtime context.', {
    source: { kind: 'runtime-context', form: 'snapshot', sections: [] },
  })
  const decision = await bridge.preStep({ agent: { session } }, async () => ({ kind: 'enter', messages: [runtime] }))
  assert.equal(decision.messages.length, 1)
  bridge.dispose()
})

test('桥：没有 agent 时不抽干队列', async () => {
  const root = tempRoot('noagent')
  const host = await hostWithMemory(root)
  const ctx = fakeCtx()
  const bridge = createDshBridge({ ctx, host, config: { stateDir: root, rawFile: path.join(root, 'raw.jsonl') } })
  bridge.start()
  host.services.delivery.push({ source: { plugin: 'time' }, content: { text: '别丢' } })
  assert.deepEqual(bridge.tick(), { sent: 0, skipped: 'no-agent' })
  assert.equal(host.services.delivery.pendingCount(), 1)
  bridge.dispose()
})

test('桥：focus 租约与积压落盘，重启后恢复', () => {
  const root = tempRoot('focus-persist')
  const focusFile = path.join(root, 'focus.json')
  const config = { stateDir: root, rawFile: path.join(root, 'raw.jsonl'), focusFile }

  const first = createHost({ log: () => {} })
  const bridge1 = createDshBridge({ ctx: fakeCtx(), host: first, config })
  bridge1.start()
  first.services.focus.enter({ label: 'act:write', title: '写记忆层', owner: 'focus', interruptible: false })
  first.services.focus.defer({ focus: 'qq:group:1', text: '别处的事', from: { plugin: 'qq' } })
  bridge1.dispose()

  const saved = JSON.parse(fs.readFileSync(focusFile, 'utf8'))
  assert.equal(saved.leases.length, 1)
  assert.equal(saved.backlog.length, 1)

  const second = createHost({ log: () => {} })
  const bridge2 = createDshBridge({ ctx: fakeCtx(), host: second, config })
  bridge2.start()
  assert.equal(second.services.focus.current().title, '写记忆层')
  assert.equal(second.services.focus.current().interruptible, false)
  assert.equal(second.services.focus.backlog()[0].count, 1)
  bridge2.dispose()
})

/* ── 插件 ───────────────────────────────────────────────── */

test('插件：单会话否决，第二会话同步抛错（DSH 会回滚）', async () => {
  const root = tempRoot('veto')
  const ctx = fakeCtx()
  const plugin = createIclPlugin({
    ctx,
    config: { stateDir: root, plugins: ['memory', 'note'], providers: [], rawFile: path.join(root, 'raw.jsonl') },
  })
  const first = fakeSession('s1')
  ctx.fire('session/created', first)
  await ctx.fireAsync('agent/created', { agent: fakeAgent(first) })

  assert.ok(ctx.tools_.has('memo'), 'agent 创建完成后工具应已注册')
  assert.throws(() => ctx.fire('session/created', fakeSession('s2')), /只允许一个会话/)
  plugin.dispose()
})

test('插件：agent 被 dispose（归档会话）后释放单会话锁', async () => {
  const root = tempRoot('agent-disposed')
  const ctx = fakeCtx()
  const plugin = createIclPlugin({ ctx, config: { stateDir: root, plugins: ['memory'], providers: [] } })
  const first = fakeSession('s1')
  ctx.fire('session/created', first)
  const agent = fakeAgent(first)
  await ctx.fireAsync('agent/created', { agent })
  ctx.fire('agent/disposed', { agent })
  assert.doesNotThrow(() => ctx.fire('session/created', fakeSession('s2')), '归档后新会话应能 claim')
  plugin.dispose()
})

test('插件：同一个会话 resume 放行', async () => {
  const root = tempRoot('resume')
  const ctx = fakeCtx()
  const plugin = createIclPlugin({ ctx, config: { stateDir: root, plugins: ['memory'], providers: [] } })
  const session = fakeSession('s1')
  ctx.fire('session/created', session)
  ctx.fire('session/disposed', session)
  assert.doesNotThrow(() => ctx.fire('session/created', fakeSession('s1')))
  plugin.dispose()
})

test('装配：默认插件清单全部启用，且工具面齐全', async () => {
  const root = tempRoot('bootstrap')
  const cfg = normalizeConfig({ stateDir: root, plugins: DEFAULT_PLUGINS, providers: [] })
  const host = createHost({ log: () => {} })
  const out = await bootstrapHost(host, cfg, { log: () => {} })
  assert.deepEqual(out.failed, [])
  assert.deepEqual(out.enabled, DEFAULT_PLUGINS)
  const names = host.services.tools.names()
  for (const name of ['remember', 'recall', 'memo', 'time_arrange', 'read_file', 'bili_search']) {
    assert.ok(names.includes(name), `缺少工具 ${name}`)
  }
  for (const id of [...out.enabled].reverse()) { try { host.disable(id) } catch { /* ignore */ } }
})
