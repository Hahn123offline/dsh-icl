// 产品化 A1 预算：显式白名单（去 mc-link）+ 4 段首屏净化，产品工具面 66/44,316 → 49/31,824。
// 只读装配（createHost + bootstrapHost），不起 lab、不碰 desktop/profile。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'
import { createHost } from '../src/index.mjs'
import { bootstrapHost } from '../../dsh-icl/src/bootstrap.mjs'
import { normalizeConfig, DEFAULT_PLUGINS } from '../../dsh-icl/src/config.mjs'

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const preset = (() => {
  const doc = yaml.load(fs.readFileSync(path.join(ROOT, 'packages/dsh-icl/presets/icl.patch.yml'), 'utf8'))
  const inserted = doc.find((entry) => entry?.insert)?.insert ?? []
  const entry = inserted.find((item) => item?.id === 'preset-icl')
  assert.ok(entry, 'icl.patch.yml 应有 preset-icl')
  return entry.config.plugins.find((plugin) => plugin?.id === 'icl-core')?.config
})()

test('产品 A1：显式 17 插件白名单（含 qq）（去 mc-link），与 DEFAULT 只差 mc-link', () => {
  assert.equal(preset.presetId, 'icl')
  assert.equal(preset.plugins.length, 17)
  assert.ok(!preset.plugins.includes('mc-link'), '产品不得挂 mc-link')
  assert.deepEqual(DEFAULT_PLUGINS.filter((id) => !preset.plugins.includes(id)), ['mc-link'])
})

test('产品 A1：首屏净化 4 段，且不 shadow icl:facts / icl:core（facts 仍走 runtime-context）', () => {
  assert.deepEqual(preset.purifySections, [
    'harness:identity',
    'ui:deliverable-file-references',
    'harness:source',
    'app:web-surface',
  ])
  assert.ok(!preset.purifySections.includes('icl:facts'))
  assert.ok(!preset.purifySections.includes('icl:core'))
})

test('产品 A1 工具面预算：68 工具 / 45,725 字符（含 qq），无 mcb_*', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'product-a1-'))
  const host = createHost({ log: () => {} })
  try {
    await bootstrapHost(host, normalizeConfig({ stateDir, providers: [], presetId: 'icl', plugins: preset.plugins, purifySections: preset.purifySections, pluginConfig: preset.pluginConfig }), { log: () => {} })
    const tools = host.services.tools.list()
    const chars = tools.reduce((sum, tool) => sum + JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }).length, 0)
    assert.equal(tools.length, 68)
    assert.equal(chars, 45725)
    assert.ok(!tools.some((tool) => String(tool.name).startsWith('mcb_')), '产品面不得出现 mcb_*')
  } finally {
    try { fs.rmSync(stateDir, { recursive: true, force: true }) } catch { /* Windows 插件可能占用临时目录，忽略清理失败 */ }
  }
})
