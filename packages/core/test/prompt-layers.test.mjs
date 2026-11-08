// 提示词分层回归：人格不出现工具名；仿真不加载当前工具面不存在的 MC 手册；
// MC 手册只由 MC preset 通过 simulationExtraFiles 追加。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'
import { normalizeConfig } from '../../dsh-icl/src/config.mjs'

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')

function presetConfig(presetId) {
  const doc = yaml.load(fs.readFileSync(path.join(ROOT, 'packages/dsh-icl/presets/icl.patch.yml'), 'utf8'))
  const insert = doc.find((item) => item?.insert)?.insert ?? []
  const preset = insert.find((item) => item?.id === presetId)
  assert.ok(preset, `缺少 preset ${presetId}`)
  const core = preset.config.plugins.find((plugin) => String(plugin?.id ?? '').endsWith('-core'))
  assert.ok(core, `${presetId} 缺少 core 插件`)
  return normalizeConfig({ ...core.config, stateDir: path.join(os.tmpdir(), `prompt-layers-${presetId}`), sessionId: 'prompt-layers' })
}

test('提示词分层：人格不出现工具名，仿真不抄工具参数表', () => {
  const cfg = presetConfig('preset-icl')
  assert.doesNotMatch(cfg.persona, /\b(?:time_|qq_|mcb_|focus_|bili_|album_|recall|remember|memo|world_status)\b/)
  assert.doesNotMatch(cfg.simulation, /\b(?:mcb_|## 玩 Minecraft)/)
  assert.doesNotMatch(cfg.simulation, /time_arrange\s*\{/)
  assert.match(cfg.simulation, /## 时间、安排与心跳/)
  assert.match(cfg.simulation, /安静/)
})

test('MC 暂停：产品 preset 不再包含 icl-mc，产品仿真不含 MC', () => {
  const product = presetConfig('preset-icl')
  const doc = yaml.load(fs.readFileSync(path.join(ROOT, 'packages/dsh-icl/presets/icl.patch.yml'), 'utf8'))
  const insert = doc.find((item) => item?.insert)?.insert ?? []
  assert.equal(insert.some((item) => item?.id === 'preset-icl-mc'), false, 'icl-mc 已移除')
  assert.doesNotMatch(product.simulation, /mcb_|## 玩 Minecraft/)
})
