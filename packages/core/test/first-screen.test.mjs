// 第一屏净化（红队 P0-1）：同名空段 shadow 全局工程脚手架段。
// 设计约束：只影响显式配置的 preset（目前 lab）；产品 preset 不得默认打开。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createIclPlugin } from '../../dsh-icl/src/plugin.mjs'
import { PURIFY_CATALOG, resolvePurifySections, registerPurifyShadows } from '../../dsh-icl/src/purify.mjs'

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')

function fakeSectionCtx({ failFor = [] } = {}) {
  const sections = []
  const ctx = {
    systemPrompt: {
      section(sec) {
        if (failFor.includes(sec.name)) throw new Error(`prompt section "${sec.name}" is already registered`)
        sections.push(sec)
        return () => { const i = sections.indexOf(sec); if (i >= 0) sections.splice(i, 1) }
      },
      context: () => () => {},
    },
  }
  return { ctx, sections }
}

test('净化段目录：四个已知段、order 与 DSH SECTION_ORDERS 对齐', () => {
  assert.deepEqual(Object.keys(PURIFY_CATALOG).sort(), [
    'app:web-surface', 'harness:identity', 'harness:source', 'ui:deliverable-file-references',
  ])
  assert.equal(PURIFY_CATALOG['harness:identity'], -1000)
  assert.equal(PURIFY_CATALOG['ui:deliverable-file-references'], 9000)
  assert.equal(PURIFY_CATALOG['harness:source'], 10000)
  assert.equal(PURIFY_CATALOG['app:web-surface'], 10100)
})

test('resolvePurifySections：去重/去空/未知段给稳定 order 并标注', () => {
  const out = resolvePurifySections(['harness:identity', 'harness:identity', '  ', 'custom:thing'])
  assert.equal(out.length, 2)
  assert.equal(out[0].name, 'harness:identity')
  assert.equal(out[0].known, true)
  assert.equal(out[1].name, 'custom:thing')
  assert.equal(out[1].known, false)
  assert.equal(out[1].order, 9000)
})

test('registerPurifyShadows：注册同名空文本段，失败按段记录（不抛）', () => {
  const { ctx, sections } = fakeSectionCtx({ failFor: ['app:web-surface'] })
  const out = registerPurifyShadows(ctx, ['harness:identity', 'ui:deliverable-file-references', 'app:web-surface'])
  assert.deepEqual(out.applied, ['harness:identity', 'ui:deliverable-file-references'])
  assert.equal(out.failed.length, 1)
  assert.match(out.failed[0].error, /already registered/)
  assert.equal(sections.length, 2)
  for (const section of sections) {
    assert.equal(section.text, '', '影子段必须是空文本（不是 complete 替换）')
    assert.notEqual(section.complete, true, '禁止用 complete:true 整段替换')
  }
  for (const off of out.offs) off()
  assert.equal(sections.length, 0, '注销后影子消失')
})

test('registerPurifyShadows：宿主没有 systemPrompt.section 时全量记失败，不静默', () => {
  const out = registerPurifyShadows({}, ['harness:identity'])
  assert.equal(out.applied.length, 0)
  assert.equal(out.failed.length, 1)
})

test('产品边界：只有 lab preset 开净化，产品 preset 默认不开', () => {
  const lab = fs.readFileSync(path.join(ROOT, 'packages/dsh-icl/presets/lab.patch.yml'), 'utf8')
  const prod = fs.readFileSync(path.join(ROOT, 'packages/dsh-icl/presets/icl.patch.yml'), 'utf8')
  assert.match(lab, /purifySections:/, 'lab preset 应显式开净化')
  assert.match(lab, /'ui:deliverable-file-references'/)
  assert.doesNotMatch(prod, /purifySections:/, '产品 preset 不得默认开净化（产品化需用户批准）')
})

test('插件层：preset ctx 能注册影子；失败的段退到 agent.ctx 重试（stale 路径不静默）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-firstscreen-'))
  const handlers = new Map()
  const presetSections = []
  const agentSections = []
  const failPresetFor = new Set(['harness:source'])
  const ctx = {
    on: (event, fn) => { handlers.set(event, [...(handlers.get(event) ?? []), fn]) },
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
    tools: { register: () => () => {} },
    systemPrompt: {
      section(sec) {
        if (failPresetFor.has(sec.name)) throw new Error(`prompt section "${sec.name}" is already registered`)
        presetSections.push(sec)
        return () => {}
      },
      context: () => () => {},
    },
  }
  const plugin = createIclPlugin({
    ctx,
    config: {
      stateDir: dir,
      providers: [],
      plugins: [],
      purifySections: ['harness:identity', 'harness:source'],
    },
  })
  const fire = (event, ...args) => { for (const fn of handlers.get(event) ?? []) fn(...args) }
  const session = { id: 's1', header: { id: 's1', agentPreset: 'icl', cwd: 'C:/tmp' }, deriveMessages: () => [] }
  fire('session/created', session)
  const agent = {
    id: 'a1',
    session,
    ctx: {
      systemPrompt: {
        section(sec) { agentSections.push(sec); return () => {} },
      },
    },
  }
  await Promise.all((handlers.get('agent/created') ?? []).map((fn) => fn({ agent })))
  assert.ok(presetSections.some((s) => s.name === 'harness:identity'), 'preset ctx 应注册 identity 影子')
  assert.ok(agentSections.some((s) => s.name === 'harness:source'), 'preset 失败的段应在 agent.ctx 重试成功')
  // 只检查净化影子段（preset ctx 同时还有 ICL 自己的 icl:core 段，文本是函数不是空串）
  for (const section of [...presetSections, ...agentSections].filter((s) => s.name in PURIFY_CATALOG)) {
    assert.equal(section.text, '', `影子段 ${section.name} 必须是空文本`)
    assert.notEqual(section.complete, true)
  }
  plugin.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})
