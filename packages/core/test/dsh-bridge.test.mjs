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

function fakeCtx({ withContext = true, attachments = null } = {}) {
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
  if (attachments) ctx.attachments = attachments
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

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

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
  const bridge = createDshBridge({ ctx, host, config: { stateDir: root, rawFile: path.join(root, 'raw.jsonl'), factsEveryStep: true } })
  // 这条只测布局拆分；节流由下面两条测试单独覆盖。
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

test('桥：facts 快照按 turn 节流（同一 turn 内不重复追加）', async () => {
  const root = tempRoot('layout-throttle')
  const host = await hostWithMemory(root)
  const ctx = fakeCtx()
  let minute = '18:00'
  host.services.prompt.section({ name: 'probe-static', order: 20, text: () => '你是小千。' })
  host.services.prompt.section({ name: 'probe-facts', order: 880, text: () => `时间：${minute}` })
  const bridge = createDshBridge({ ctx, host, config: { stateDir: root, rawFile: path.join(root, 'raw.jsonl') } })
  bridge.start()
  const facts = ctx.contexts_.get('icl:facts')
  const session = fakeSession('s1')
  bridge.bindSession(session)
  bridge.bindAgent(fakeAgent(session))

  bridge.onEvent(session, { type: 'turn/start', seq: 1, data: { turn: 1 } })
  assert.equal(facts.text({}), '时间：18:00')
  minute = '18:01'
  assert.equal(facts.text({}), '时间：18:00', '同一 turn 内复用第一份快照（最多 1 条/轮）')
  bridge.onEvent(session, { type: 'tool/result', seq: 2, data: {} })
  assert.equal(facts.text({}), '时间：18:00', '轮内之后 step 仍复用')
  for (let i = 0; i < 5; i += 1) assert.equal(facts.text({}), '时间：18:00', '同 turn 多次求值复用')
  assert.equal(bridge.status().stats.factsRefreshes, 1, '同一 turn 只刷新一次快照')

  bridge.onEvent(session, { type: 'turn/start', seq: 3, data: { turn: 2 } })
  assert.equal(facts.text({}), '时间：18:01', '新 turn 刷新一次')
  assert.ok(bridge.status().stats.factsRefreshes >= 2)
  bridge.dispose()
})

test('桥：节流下 focus enter/leave 标 dirty，下一步快照含新焦点（stale≤1）', async () => {
  const root = tempRoot('layout-focus-dirty')
  const host = await hostWithMemory(root)
  const ctx = fakeCtx()
  host.services.prompt.section({
    name: 'probe-facts',
    order: 880,
    text: () => {
      const lease = host.services.focus.current()
      return lease ? `专注：${lease.label}` : '专注：无'
    },
  })
  const bridge = createDshBridge({ ctx, host, config: { stateDir: root, rawFile: path.join(root, 'raw.jsonl') } })
  bridge.start()
  const facts = ctx.contexts_.get('icl:facts')
  const session = fakeSession('s1')
  bridge.bindSession(session)
  bridge.bindAgent(fakeAgent(session))

  bridge.onEvent(session, { type: 'turn/start', seq: 1, data: { turn: 1 } })
  assert.equal(facts.text({}), '专注：无')

  // 轮内进入 focus：必须在下一次求值就看到（事件类事实 stale ≤ 1 步）
  const lease = host.services.focus.enter({ label: 'mc', title: '玩 MC' })
  assert.equal(facts.text({}), '专注：mc', 'focus enter 后下一步快照含新焦点')
  const refreshes = bridge.status().stats.factsRefreshes
  assert.equal(facts.text({}), '专注：mc')
  assert.equal(bridge.status().stats.factsRefreshes, refreshes, '同 turn 后续复用')

  lease.release()
  assert.equal(facts.text({}), '专注：无', 'focus leave 也标 dirty')
  bridge.dispose()
})

test('桥：turn 内改事实的工具（time_arrange 等）置 dirty，下一步快照含新安排', async () => {
  const root = tempRoot('layout-tool-dirty')
  const host = await hostWithMemory(root)
  const ctx = fakeCtx()
  const factsState = { next: 'dream:nightly' }
  host.services.prompt.section({ name: 'probe-facts', order: 880, text: () => `下一个安排：${factsState.next}` })
  const bridge = createDshBridge({ ctx, host, config: { stateDir: root, rawFile: path.join(root, 'raw.jsonl') } })
  bridge.start()
  const facts = ctx.contexts_.get('icl:facts')
  const session = fakeSession('s1')
  bridge.bindSession(session)
  bridge.bindAgent(fakeAgent(session))

  bridge.onEvent(session, { type: 'turn/start', seq: 1, data: { turn: 1 } })
  assert.equal(facts.text({}), '下一个安排：dream:nightly')
  const before = bridge.status().stats.factsRefreshes

  // 模型在同一 turn 里调用 time_arrange 改了"下一个安排"：工具结果一出现就必须标 dirty
  factsState.next = 'cache-r1（2026-11-05 20:00）'
  bridge.onEvent(session, { type: 'tool/result', seq: 2, data: { name: 'time_arrange' } })
  assert.equal(facts.text({}), '下一个安排：cache-r1（2026-11-05 20:00）', '工具改事实后下一步可见（stale≤1）')
  assert.equal(bridge.status().stats.factsRefreshes, before + 1)

  // 不在白名单的只读工具不触发刷新
  const afterTool = bridge.status().stats.factsRefreshes
  bridge.onEvent(session, { type: 'tool/result', seq: 3, data: { name: 'recall' } })
  assert.equal(facts.text({}), '下一个安排：cache-r1（2026-11-05 20:00）')
  assert.equal(bridge.status().stats.factsRefreshes, afterTool, '只读工具不应重置节流')
  bridge.dispose()
})

test('桥：delivery 通知（time sleep/wake 等）置 dirty，下一步重算 facts', async () => {
  const root = tempRoot('layout-delivery-dirty')
  const host = await hostWithMemory(root)
  const ctx = fakeCtx()
  const factsState = { phase: '醒着' }
  host.services.prompt.section({ name: 'probe-facts', order: 880, text: () => `阶段：${factsState.phase}` })
  const bridge = createDshBridge({ ctx, host, config: { stateDir: root, rawFile: path.join(root, 'raw.jsonl') } })
  bridge.start()
  const facts = ctx.contexts_.get('icl:facts')
  const session = fakeSession('s1')
  const agent = fakeAgent(session)
  agent.steers = []
  agent.steer = (message) => { agent.steers.push(message) }
  bridge.bindSession(session)
  bridge.bindAgent(agent)

  bridge.onEvent(session, { type: 'turn/start', seq: 1, data: { turn: 1 } })
  assert.equal(facts.text({}), '阶段：醒着')
  const before = bridge.status().stats.factsRefreshes

  factsState.phase = '睡着'
  host.services.delivery.push({ source: { plugin: 'time' }, content: { text: '该睡了' } })
  assert.deepEqual(await bridge.tick(), { sent: 1 })
  assert.equal(facts.text({}), '阶段：睡着', 'delivery 通知后 facts 重算')
  assert.equal(bridge.status().stats.factsRefreshes, before + 1)
  bridge.dispose()
})

test('桥：factsEveryStep=true 时退回每步求值（旧行为）', async () => {
  const root = tempRoot('layout-every-step')
  const host = await hostWithMemory(root)
  const ctx = fakeCtx()
  let minute = '18:00'
  host.services.prompt.section({ name: 'probe-facts', order: 880, text: () => `时间：${minute}` })
  const bridge = createDshBridge({ ctx, host, config: { stateDir: root, rawFile: path.join(root, 'raw.jsonl'), factsEveryStep: true } })
  bridge.start()
  const facts = ctx.contexts_.get('icl:facts')
  assert.equal(facts.text({}), '时间：18:00')
  minute = '18:01'
  assert.equal(facts.text({}), '时间：18:01', '关掉节流后每步都刷新')
  bridge.dispose()
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

test('桥：ctx.inject 同步注入 attachment → 第一张图也不降级（首图 bug 回归）', async () => {
  const root = tempRoot('image-first-inject')
  const host = await hostWithMemory(root)
  const saves = []
  const store = {
    async saveImages(images) {
      saves.push(...images)
      return images.map((img, i) => ({ attachmentId: `inject-${i}`, mediaType: img.mediaType, bytes: img.data.byteLength, width: 1, height: 1 }))
    },
  }
  const ctx = fakeCtx()
  ctx.inject = (deps, cb) => { if (deps.includes('attachments')) cb({ attachments: store }) }
  const bridge = createDshBridge({ ctx, host, config: { stateDir: root, rawFile: path.join(root, 'raw.jsonl') } })
  bridge.start()
  const session = fakeSession('s1')
  const agent = fakeAgent(session)
  agent.steers = []
  agent.steer = (message) => { agent.steers.push(message) }
  bridge.bindSession(session)
  bridge.bindAgent(agent)
  try {
    host.services.delivery.push({
      source: { plugin: 'qq' },
      content: { text: '第一张图', images: [{ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }] },
    })
    assert.deepEqual(await bridge.tick(), { sent: 1 })
    assert.equal(saves.length, 1, 'inject 同步成功时第一张图必须交给 attachment')
    assert.equal(agent.steers[0].content[1].type, 'image')
    assert.doesNotMatch(agent.steers[0].content[0].text, /未能显示/)
  } finally { bridge.dispose() }
})

test('桥：imageLimits 预检（张数/字节/类型）→ 超限跳过并提示，不塞给 saveImages', async () => {
  const root = tempRoot('image-limits')
  const host = await hostWithMemory(root)
  const saves = []
  const store = {
    imageLimits: { maxImageBytes: 10, maxImagesPerMessage: 1, maxMessageImageBytes: 15, mediaTypes: ['image/png'] },
    async saveImages(images) {
      saves.push(...images)
      return images.map((img, i) => ({ attachmentId: `lim-${i}`, mediaType: img.mediaType, bytes: img.data.byteLength, width: 1, height: 1 }))
    },
  }
  const ctx = fakeCtx({ attachments: store })
  const bridge = createDshBridge({ ctx, host, config: { stateDir: root, rawFile: path.join(root, 'raw.jsonl') } })
  bridge.start()
  const session = fakeSession('s1')
  const agent = fakeAgent(session)
  agent.steers = []
  agent.steer = (message) => { agent.steers.push(message) }
  bridge.bindSession(session)
  bridge.bindAgent(agent)
  try {
    host.services.delivery.push({
      source: { plugin: 'qq' },
      content: {
        text: '两张图',
        images: [
          { data: new Uint8Array(8), mediaType: 'image/png' },
          { data: new Uint8Array(8), mediaType: 'image/png' },
        ],
      },
    })
    assert.deepEqual(await bridge.tick(), { sent: 1 })
    assert.equal(saves.length, 1, '超过 maxImagesPerMessage 的图被预检跳过')
    assert.match(agent.steers[0].content[0].text, /超过附件上限/)
    assert.equal(agent.steers[0].content.filter((part) => part.type === 'image').length, 1)
  } finally { bridge.dispose() }
})

test('桥：纯图片消息正文占位（不出现空 text）', async () => {
  const root = tempRoot('image-only')
  const host = await hostWithMemory(root)
  const store = {
    async saveImages(images) { return images.map((img, i) => ({ attachmentId: `only-${i}`, mediaType: img.mediaType, bytes: img.data.byteLength, width: 1, height: 1 })) },
  }
  const ctx = fakeCtx({ attachments: store })
  const bridge = createDshBridge({ ctx, host, config: { stateDir: root, rawFile: path.join(root, 'raw.jsonl') } })
  bridge.start()
  const session = fakeSession('s1')
  const agent = fakeAgent(session)
  agent.steers = []
  agent.steer = (message) => { agent.steers.push(message) }
  bridge.bindSession(session)
  bridge.bindAgent(agent)
  try {
    host.services.delivery.push({
      source: { plugin: 'qq' },
      content: { text: '', images: [{ data: new Uint8Array([1]), mediaType: 'image/png' }] },
    })
    assert.deepEqual(await bridge.tick(), { sent: 1 })
    assert.equal(agent.steers[0].content[0].type, 'text')
    assert.equal(agent.steers[0].content[0].text, '（图片）')
    assert.match(agent.steers[0].source.summary, /图片/)
  } finally { bridge.dispose() }
})

test('桥：tick 不重叠，图片与文字按投递顺序 steer', async () => {
  const root = tempRoot('tick-order')
  const host = await hostWithMemory(root)
  let release = null
  const gate = new Promise((resolve) => { release = resolve })
  const store = {
    async saveImages(images) {
      await gate
      return images.map((img, i) => ({ attachmentId: `ord-${i}`, mediaType: img.mediaType, bytes: img.data.byteLength, width: 1, height: 1 }))
    },
  }
  const ctx = fakeCtx({ attachments: store })
  const bridge = createDshBridge({ ctx, host, config: { stateDir: root, rawFile: path.join(root, 'raw.jsonl') } })
  bridge.start()
  const session = fakeSession('s1')
  const agent = fakeAgent(session)
  agent.steers = []
  agent.steer = (message) => { agent.steers.push(message) }
  bridge.bindSession(session)
  bridge.bindAgent(agent)
  try {
    host.services.delivery.push({ source: { plugin: 'qq' }, content: { text: '图在前', images: [{ data: new Uint8Array([1]), mediaType: 'image/png' }] } })
    host.services.delivery.push({ source: { plugin: 'time' }, content: { text: '文字在后' } })
    const first = bridge.tick()
    await sleep(10)
    const second = await bridge.tick()
    assert.deepEqual(second, { sent: 0, skipped: 'busy' }, '上一批未完成时跳过本 tick')
    release()
    assert.deepEqual(await first, { sent: 2 })
    assert.deepEqual(agent.steers.map((m) => m.content[0].text), ['图在前', '文字在后'])
  } finally { bridge.dispose() }
})

test('桥：QQ 图片 → DSH attachment image block；正文无 URL/base64', async () => {
  const root = tempRoot('image-attach')
  const host = await hostWithMemory(root)
  const saves = []
  const attachments = {
    async saveImages(images) {
      saves.push(...images)
      return images.map((img, i) => ({
        attachmentId: `att-${i}`, mediaType: img.mediaType, bytes: img.data.byteLength, width: 1, height: 1, ...(img.name ? { name: img.name } : {}),
      }))
    },
  }
  const ctx = fakeCtx({ attachments })
  const bridge = createDshBridge({ ctx, host, config: { stateDir: root, rawFile: path.join(root, 'raw.jsonl') } })
  bridge.start()
  const session = fakeSession('s1')
  const agent = fakeAgent(session)
  agent.steers = []
  agent.steer = (message) => { agent.steers.push(message) }
  bridge.bindSession(session)
  bridge.bindAgent(agent)
  try {
    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
    host.services.delivery.push({
      source: { plugin: 'qq' },
      content: { text: '[QQ私聊·主人] 主人：看图', images: [{ data, mediaType: 'image/png', name: 'a.png', path: 'C:/media/inbox/a.png' }] },
    })
    assert.deepEqual(await bridge.tick(), { sent: 1 })
    assert.equal(saves.length, 1)
    assert.equal(saves[0].mediaType, 'image/png')
    assert.equal(saves[0].data.byteLength, data.byteLength)
    const message = agent.steers[0]
    assert.equal(message.content[0].type, 'text')
    assert.equal(message.content[0].text, '[QQ私聊·主人] 主人：看图')
    assert.equal(message.content[1].type, 'image')
    assert.equal(message.content[1].attachment.attachmentId, 'att-0')
    // 正文不能泄漏 URL/base64/字节
    assert.doesNotMatch(message.content[0].text, /https?:|base64|data:image|\/9j\//)
    assert.equal(message.source.kind, 'plugin:qq')
  } finally { bridge.dispose() }
})

test('桥：attachment 保存失败 → 文字降级，消息不丢', async () => {
  const root = tempRoot('image-fallback')
  const host = await hostWithMemory(root)
  const attachments = { async saveImages() { throw new Error('too many pixels') } }
  const ctx = fakeCtx({ attachments })
  const bridge = createDshBridge({ ctx, host, config: { stateDir: root, rawFile: path.join(root, 'raw.jsonl') } })
  bridge.start()
  const session = fakeSession('s1')
  const agent = fakeAgent(session)
  agent.steers = []
  agent.steer = (message) => { agent.steers.push(message) }
  bridge.bindSession(session)
  bridge.bindAgent(agent)
  try {
    host.services.delivery.push({
      source: { plugin: 'qq' },
      content: { text: '看图', images: [{ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png', name: 'a.png', path: 'C:/media/inbox/a.png' }] },
    })
    assert.deepEqual(await bridge.tick(), { sent: 1 })
    const message = agent.steers[0]
    assert.equal(message.content.length, 1, '失败时没有 image block')
    assert.match(message.content[0].text, /图片未能显示/)
    assert.match(message.content[0].text, /C:\/media\/inbox\/a\.png/)
    assert.doesNotMatch(message.content[0].text, /https?:|base64/)
  } finally { bridge.dispose() }
})

test('桥：没有 attachment 服务 → 文字降级，消息不丢', async () => {
  const root = tempRoot('image-no-service')
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
  try {
    host.services.delivery.push({
      source: { plugin: 'qq' },
      content: { text: '看图', images: [{ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png', name: 'a.png' }] },
    })
    assert.deepEqual(await bridge.tick(), { sent: 1 })
    const message = agent.steers[0]
    assert.equal(message.content.length, 1)
    assert.match(message.content[0].text, /没有 attachment 服务/)
  } finally { bridge.dispose() }
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
  assert.deepEqual(await bridge.tick(), { sent: 1 })
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
  assert.deepEqual(await bridge.tick(), { sent: 1 })
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

test('桥：turn/start 也发出 turn-start 信号（time 心跳用，只进插件总线）', async () => {
  const root = tempRoot('turn-start')
  const host = await hostWithMemory(root)
  const ctx = fakeCtx()
  const bridge = createDshBridge({ ctx, host, config: { stateDir: root, rawFile: path.join(root, 'raw.jsonl') } })
  bridge.start()
  const session = fakeSession('s1')
  bridge.bindSession(session)

  const starts = []
  const ends = []
  host.services.signals.on({ tags: ['turn-start'] }, (signal) => starts.push(signal))
  host.services.signals.on({ tags: ['turn-end'] }, (signal) => ends.push(signal))
  bridge.onEvent(session, { type: 'turn/start', seq: 5 })
  assert.equal(starts.length, 1)
  assert.equal(starts[0].from.plugin, 'dsh')
  assert.equal(starts[0].meta.seq, 5)
  assert.equal(ends.length, 0)
  // 同 seq 重放幂等；turn-start 不产生 turn-end
  bridge.onEvent(session, { type: 'turn/start', seq: 5 })
  assert.equal(starts.length, 1)
  assert.equal(ends.length, 0)
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
  assert.equal(decision.messages[2].source.kind, 'plugin:icl', '注入的 <icl-context> 必须是 producer-owned，不能冒充 DSH 的 runtime-context')
  assert.notEqual(decision.messages[2].source.kind, 'runtime-context', '撞 DSH 快照投影会导致每轮多 append 一份快照')
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
  assert.deepEqual(await bridge.tick(), { sent: 0, skipped: 'no-agent' })
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
