import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../packages/core/src/index.mjs'
import { bootstrapHost } from '../packages/dsh-icl/src/bootstrap.mjs'
import { normalizeConfig } from '../packages/dsh-icl/src/config.mjs'

const DEFAULT_MINUS_MCLINK = ['memory', 'world-state', 'recall', 'note', 'lexicon', 'whois', 'persona', 'focus', 'eager-recall', 'model-manager', 'time', 'dream', 'editor', 'bili', 'video', 'album']
const host = createHost({ log: () => {} })
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-'))
await bootstrapHost(host, normalizeConfig({ stateDir, providers: [], presetId: 'icl', plugins: DEFAULT_MINUS_MCLINK }), { log: () => {} })
const defs = host.services.tools.list()
const chars = defs.reduce((sum, tool) => sum + JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }).length, 0)
console.log(JSON.stringify({ tools: defs.length, chars, names: defs.map((t) => t.name) }, null, 0).slice(0, 1200))
fs.rmSync(stateDir, { recursive: true, force: true })
