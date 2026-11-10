// 结构化契约：工具/服务未就绪时，核心不发布契约段；注册失败由核心统一标记不可用。

import test from 'node:test'
import assert from 'node:assert/strict'
import { createToolRegistry, createPromptService, createContractRegistry } from '../src/services.mjs'
import { createHost } from '../src/host.mjs'

function setup() {
  const tools = createToolRegistry()
  const prompt = createPromptService()
  const services = new Set()
  const contracts = createContractRegistry({ tools, prompt, hasService: (name) => services.has(name) })
  return { tools, prompt, services, contracts }
}

test('contract：依赖工具已注册才发布；工具消失后契约段消失（2026-11-10）', () => {
  const { tools, prompt, contracts } = setup()
  const feature = contracts.registerFeature({
    id: 'demo',
    prompt: '这是 demo 契约。',
    requiresTools: ['demo_tool'],
  })
  assert.equal(prompt.assemble(), '', '工具未注册时不能出现契约')
  assert.equal(feature.status().active, false)
  assert.deepEqual(feature.status().missingTools, ['demo_tool'])

  const off = tools.register({ name: 'demo_tool', summary: 'demo', parameters: { type: 'object', additionalProperties: false, properties: {} }, async execute() { return { text: 'ok' } } })
  assert.match(prompt.assemble(), /这是 demo 契约/)
  assert.equal(feature.status().active, true)

  contracts.markToolUnavailable('demo_tool', 'DSH 注册失败')
  assert.equal(prompt.assemble(), '', 'DSH 注册失败后不能继续宣称工具可用')
  assert.equal(feature.status().missingTools.includes('demo_tool'), true)

  contracts.clearToolUnavailable('demo_tool')
  assert.match(prompt.assemble(), /这是 demo 契约/)
  off()
  assert.equal(prompt.assemble(), '', '工具注销后契约段也要消失')
  feature.dispose()
})

test('contract：依赖 service 未就绪时不发布，provide 后自动出现', () => {
  const { prompt, services, contracts } = setup()
  const feature = contracts.registerFeature({
    id: 'needs-service',
    prompt: '服务契约。',
    requiresServices: ['svc'],
  })
  assert.equal(prompt.assemble(), '')
  services.add('svc')
  assert.equal(prompt.assemble(), '服务契约。')
  assert.equal(feature.status().active, true)
})

test('contract：when 返回 false 时不发布，且 when 抛错不拖垮整个提示词', () => {
  const { tools, prompt, contracts } = setup()
  tools.register({ name: 'demo_tool', summary: 'demo', async execute() { return { text: 'ok' } } })
  const feature = contracts.registerFeature({ id: 'conditional', prompt: '条件契约。', requiresTools: ['demo_tool'], when: () => false })
  assert.equal(prompt.assemble(), '')
  feature.dispose()
  const broken = contracts.registerFeature({ id: 'broken', prompt: '坏契约。', when: () => { throw new Error('boom') } })
  assert.equal(prompt.assemble(), '', 'when 抛错只让该契约不出现')
  broken.dispose()
})

test('contract：非法 id/重复 id/非法 prompt/非法依赖会明确抛错', () => {
  const { contracts } = setup()
  assert.throws(() => contracts.registerFeature({ id: 'Bad Id', prompt: 'x' }), /契约 id/)
  assert.throws(() => contracts.registerFeature({ id: 'x', prompt: 42 }), /prompt/)
  assert.throws(() => contracts.registerFeature({ id: 'x', prompt: 'x', requiresTools: 'tool' }), /requires/)
  const first = contracts.registerFeature({ id: 'dup', prompt: 'x' })
  assert.throws(() => contracts.registerFeature({ id: 'dup', prompt: 'y' }), /契约已存在/)
  first.dispose()
})

test('host：插件启用时工具与契约一起注册，停用时一起撤回', async () => {
  const host = createHost({ log: () => {} })
  const manifest = {
    id: 'contract-demo', version: '1.0.0', entry: './x.mjs', tools: ['demo_tool'],
    slots: [], focus: {}, requires: {},
  }
  host.registerPlugin(manifest, {
    apply(ctx) {
      ctx.tools.register({ name: 'demo_tool', summary: 'demo', async execute() { return { text: 'ok' } } })
      ctx.contracts.registerFeature({ id: 'demo-feature', prompt: 'demo 功能契约。', requiresTools: ['demo_tool'] })
    },
  })
  await host.enable('contract-demo')
  assert.match(host.services.prompt.assemble(), /demo 功能契约/)
  assert.equal(host.services.contracts.status('demo-feature').active, true)
  host.disable('contract-demo')
  assert.equal(host.services.prompt.assemble(), '', '插件停用后契约和工具一起消失')
  assert.equal(host.services.contracts.status('demo-feature'), null)
})

test('tool.contract：本地契约元数据被校验并保存，不会自动注入提示词', () => {
  const { tools, prompt } = setup()
  const off = tools.register({
    name: 'demo_tool',
    summary: 'demo',
    contract: { feature: 'demo', requiresServices: ['svc'], fallback: '不可用', modelHint: '提示' },
    async execute() { return { text: 'ok' } },
  })
  const def = tools.list()[0]
  assert.equal(def.contract.feature, 'demo')
  assert.deepEqual(def.contract.requiresServices, ['svc'])
  assert.equal(prompt.assemble(), '', '工具契约不自动变成提示词段')
  off()
  assert.throws(() => tools.register({ name: 'bad', summary: 'x', contract: { feature: 'Bad Id' }, async execute() { return { text: 'x' } } }), /contract.feature/)
})
