import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'
import { createHost } from '../packages/core/src/index.mjs'
import { bootstrapHost } from '../packages/dsh-icl/src/bootstrap.mjs'
import { normalizeConfig } from '../packages/dsh-icl/src/config.mjs'

// 产品 A1 工具面：直接从产品 preset 读 plugins/purify/pluginConfig，避免手抄白名单漂移。
const ROOT = path.resolve(import.meta.dirname, '..')
const doc = yaml.load(fs.readFileSync(path.join(ROOT, 'packages/dsh-icl/presets/icl.patch.yml'), 'utf8'))
const entry = (doc.find((item) => item?.insert)?.insert ?? []).find((item) => item?.id === 'preset-icl')
if (!entry) throw new Error('icl.patch.yml 缺少 preset-icl')
const config = entry.config.plugins.find((plugin) => plugin?.id === 'icl-core')?.config
if (!config) throw new Error('preset-icl 缺少 icl-core')
const host = createHost({ log: () => {} })
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-'))
await bootstrapHost(host, normalizeConfig({
  stateDir,
  providers: [],
  presetId: config.presetId,
  plugins: config.plugins,
  purifySections: config.purifySections,
  pluginConfig: config.pluginConfig,
}), { log: () => {} })
const defs = host.services.tools.list()
const chars = defs.reduce((sum, tool) => sum + JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }).length, 0)
fs.mkdirSync(path.join(ROOT, '.state/cache'), { recursive: true })
const out = { tools: defs.length, chars, toolNames: defs.map((tool) => tool.name).sort() }
fs.writeFileSync(path.join(ROOT, '.state/cache/product-surface-audit.json'), JSON.stringify(out, null, 2))
console.log(JSON.stringify({ tools: out.tools, chars: out.chars, qq: out.toolNames.filter((name) => name.startsWith('qq_')) }))
process.exit(0)
