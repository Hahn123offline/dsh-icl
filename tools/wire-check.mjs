// 接线自检：证明"模型管理 → 插槽 → 插件"这条路真的通。
//
//   node tools/wire-check.mjs            # 用 config/icl.local.json
//   node tools/wire-check.mjs path.json
//
// 它做四件事：
//   1. 按配置注册供应商（缺凭据的会被跳过并说明）
//   2. 打印插槽匹配结果（哪些接上了、哪些没接上）
//   3. 真调一次 chat（如果接了）+ 一次 embedding（如果接了）
//   4. 跑一遍做梦，证明沉淀链路可用（有 chat 时才是真模型）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../packages/core/src/index.mjs'
import * as memory from '../packages/plugins/memory/src/index.mjs'
import * as recall from '../packages/plugins/recall/src/index.mjs'
import * as rhythm from '../packages/plugins/rhythm/src/index.mjs'
import * as dream from '../packages/plugins/dream/src/index.mjs'
import * as manager from '../packages/plugins/model-manager/src/index.mjs'
import * as persona from '../packages/plugins/persona/src/index.mjs'
import memoryManifest from '../packages/plugins/memory/manifest.json' with { type: 'json' }
import recallManifest from '../packages/plugins/recall/manifest.json' with { type: 'json' }
import rhythmManifest from '../packages/plugins/rhythm/manifest.json' with { type: 'json' }
import dreamManifest from '../packages/plugins/dream/manifest.json' with { type: 'json' }
import managerManifest from '../packages/plugins/model-manager/manifest.json' with { type: 'json' }
import personaManifest from '../packages/plugins/persona/manifest.json' with { type: 'json' }

const configPath = process.argv[2] ?? path.join(import.meta.dirname, '..', 'config', 'icl.local.json')
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-wire-'))

const host = createHost({ log: (e) => { if (e.level === 'warn' || e.msg === 'slots.bound') console.log('  ·', e.msg, JSON.stringify(e).slice(0, 160)) } })
host.registerPlugin(memoryManifest, memory, { config: { root } })
host.registerPlugin(recallManifest, recall, { config: { sessionId: 'wire' } })
host.registerPlugin(rhythmManifest, rhythm, { config: { dreamAt: '23:59', stateFile: path.join(root, 'r.json') } })
host.registerPlugin(dreamManifest, dream, { config: { sessionId: 'wire', personaFile: path.join(import.meta.dirname, '..', 'prompts', 'dream.md') } })
host.registerPlugin(managerManifest, manager, { config: { providers: config.providers ?? [] } })
host.registerPlugin(personaManifest, persona, { config: { card: config.persona ? readOrEmpty(config.persona) : '' } })

for (const id of ['model-manager', 'memory', 'recall', 'rhythm', 'dream', 'persona']) {
  try { await host.enable(id) } catch (error) { console.log(`启用 ${id} 失败：${error?.message ?? error}`) }
}

const slots = host.services.slots
const mgr = host.shared.get('model-manager')
console.log('\n=== 供应商 ===')
for (const p of mgr?.providers() ?? []) console.log(`  ✓ ${p.id} (${p.kind}) shape=${JSON.stringify(p.shape)}`)
for (const s of mgr?.skipped() ?? []) console.log(`  ✗ ${s.id}：${s.reason}`)

console.log('\n=== 插槽 ===')
for (const slot of slots.list()) {
  const bound = slot.binding ? `→ ${slot.binding.provider}` : '（未绑定）'
  console.log(`  ${slot.id.padEnd(12)} kind=${slot.kind.padEnd(9)} requires=${JSON.stringify(slot.requires)} ${bound}`)
}

const personaSvc = host.shared.get('persona')
console.log('\n=== 人格 ===')
console.log(`  正文 ${personaSvc?.current()?.length ?? 0} 字（临时用旧版），源：${config.persona ?? '未配置'}`)

console.log('\n=== 真实调用 ===')
const bound = (id) => Boolean(slots.list().find((s) => s.id === id)?.binding)
let chatOk = false
if (bound('dream-chat')) {
  try {
    const t0 = Date.now()
    const text = await slots.call('dream-chat', { messages: [{ role: 'user', content: '只回两个字：通了' }], maxTokens: 20 })
    chatOk = true
    console.log(`  chat  ✓ ${((Date.now() - t0) / 1000).toFixed(1)}s → ${String(text).slice(0, 40)}`)
  } catch (error) { console.log(`  chat  ✗ ${error?.message ?? error}`) }
} else console.log('  chat  -（没有可用供应商）')

let embedOk = false
if (bound('embed-text')) {
  try {
    const t0 = Date.now()
    const out = await slots.call('embed-text', { input: '接线测试' })
    const vec = Array.isArray(out?.[0]) ? out[0] : out?.data?.[0]?.embedding
    embedOk = Array.isArray(vec) && vec.length > 0
    console.log(`  embed ✓ ${((Date.now() - t0) / 1000).toFixed(1)}s dim=${vec?.length ?? '?'}`)
  } catch (error) { console.log(`  embed ✗ ${error?.message ?? error}`) }
} else console.log('  embed -（没有可用供应商）')

console.log('\n=== 沉淀链路 ===')
const remember = host.services.tools.list().find((t) => t.name === 'remember')
await remember.execute({ text: '他说周末可能去看海，但他怕水', kind: 'event' })
await remember.execute({ text: '他舍友叫曾嘉睿', kind: 'person', qq: '42' })
if (chatOk) {
  const out = await host.shared.get('dream').run({ now: Date.now() })
  console.log('  dream:', JSON.stringify(out.results.map((r) => `${r.job}:${r.skipped ?? (r.ok ? `ok+${r.blocks}` : 'fail')}`)))
  const mem = host.shared.get('memory')
  const blocks = [...mem.query({ namespace: 'event', kind: 'block' }), ...mem.query({ namespace: 'person', kind: 'block' })]
  for (const b of blocks.slice(0, 4)) console.log(`   - [${b.namespace}] ${b.text}`)
} else {
  console.log('  dream: 跳过（没有 chat 供应商，先接上模型再说）')
}

console.log('\n结论：' + (chatOk && embedOk ? 'chat 与 embedding 都通' : `chat=${chatOk ? '通' : '未通'} embed=${embedOk ? '通' : '未通'}`))
process.exit(chatOk && embedOk ? 0 : 2)

function readOrEmpty(file) {
  try { return fs.readFileSync(file, 'utf8') } catch { return '' }
}
