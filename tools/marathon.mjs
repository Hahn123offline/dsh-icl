// 马拉松会话：让一个真实模型自己刷 B 站、自己记，跑一段固定时间。
//
//   node tools/marathon.mjs                 # 用 config/marathon.json
//   node tools/marathon.mjs --seconds 300   # 覆盖时长
//
// 不是正式接入 DSH：这里是一个最小 agent 循环，用来在开测前量密度与质量。
// 工具协议是文本 JSON，避免依赖各家 function-calling 的差异。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../packages/core/src/index.mjs'
import * as memory from '../packages/plugins/memory/src/index.mjs'
import * as recall from '../packages/plugins/recall/src/index.mjs'
import * as note from '../packages/plugins/note/src/index.mjs'
import * as lexicon from '../packages/plugins/lexicon/src/index.mjs'
import * as editor from '../packages/plugins/editor/src/index.mjs'
import * as bili from '../packages/plugins/bili/src/index.mjs'
import * as world from '../packages/plugins/world-state/src/index.mjs'
import * as rhythm from '../packages/plugins/rhythm/src/index.mjs'
import * as dream from '../packages/plugins/dream/src/index.mjs'
import memoryManifest from '../packages/plugins/memory/manifest.json' with { type: 'json' }
import recallManifest from '../packages/plugins/recall/manifest.json' with { type: 'json' }
import noteManifest from '../packages/plugins/note/manifest.json' with { type: 'json' }
import lexiconManifest from '../packages/plugins/lexicon/manifest.json' with { type: 'json' }
import editorManifest from '../packages/plugins/editor/manifest.json' with { type: 'json' }
import biliManifest from '../packages/plugins/bili/manifest.json' with { type: 'json' }
import worldManifest from '../packages/plugins/world-state/manifest.json' with { type: 'json' }
import rhythmManifest from '../packages/plugins/rhythm/manifest.json' with { type: 'json' }
import dreamManifest from '../packages/plugins/dream/manifest.json' with { type: 'json' }

const args = process.argv.slice(2)
const arg = (n, d = null) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const cfg = JSON.parse(fs.readFileSync(arg('--config', path.join(import.meta.dirname, '..', 'config', 'marathon.json')), 'utf8'))
const seconds = Number(arg('--seconds', cfg.durationSec ?? 300))
const root = path.resolve(String(cfg.workspace ?? 'state/marathon-workspace'))
fs.mkdirSync(root, { recursive: true })
const persona = fs.readFileSync(path.join(import.meta.dirname, '..', String(cfg.personaFile)), 'utf8')

const host = createHost({ log: () => {} })
host.registerPlugin(memoryManifest, memory, { config: { root } })
host.registerPlugin(recallManifest, recall, { config: { sessionId: 'marathon' } })
host.registerPlugin(noteManifest, note, {})
host.registerPlugin(lexiconManifest, lexicon, {})
host.registerPlugin(editorManifest, editor, { config: { root } })
host.registerPlugin(biliManifest, bili, {})
host.registerPlugin(worldManifest, world, {})
host.registerPlugin(rhythmManifest, rhythm, { config: { dreamAt: '23:00', stateFile: path.join(root, 'rhythm.json') } })
host.registerPlugin(dreamManifest, dream, { config: { sessionId: 'marathon', persona: '你是记忆沉淀器。' } })
for (const id of ['memory', 'recall', 'note', 'lexicon', 'editor', 'bili', 'world-state', 'rhythm', 'dream']) {
  try { await host.enable(id) } catch (error) { console.log('enable fail', id, String(error?.message ?? error)) }
}

host.services.model.bind({
  baseUrl: cfg.model.baseUrl,
  model: cfg.model.model,
  apiKey: process.env.DASHSCOPE_API_KEY ?? '',
  timeoutMs: cfg.model.timeoutMs ?? 120000,
  extraBody: cfg.model.disableThinking ? { chat_template_kwargs: { enable_thinking: false } } : undefined,
})

const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))
const toolHelp = host.services.tools.list()
  .map((t) => `- ${t.name}: ${t.summary || t.description.slice(0, 80)}\n  args: ${JSON.stringify(t.parameters?.properties ?? {})}`)
  .join('\n')

const system = [
  persona,
  '',
  '你有一套工具。想用工具时，只输出一个 JSON 对象：',
  '```json',
  '{"tool":"工具名","args":{...}}',
  '```',
  '不想用工具、只想说一句或记一句时，直接输出文字（想记下来就用 write_file 或 remember）。',
  '',
  '可用工具：',
  toolHelp,
].join('\n')

const history = []
const recentCalls = []
const started = Date.now()
const logFile = path.join(import.meta.dirname, '..', 'state', `marathon-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`)
const counts = { steps: 0, toolCalls: 0, byTool: {}, say: 0 }
let stopReason = 'duration'

for (let step = 0; step < (cfg.maxSteps ?? 60); step++) {
  if (Date.now() - started > seconds * 1000) { stopReason = 'duration'; break }
  const brief = host.services.prompt.assemble({ sessionId: 'marathon' })
  const messages = [
    { role: 'system', content: `${system}\n\n${brief}` },
    { role: 'user', content: '开始你的浏览。' },
    ...history.slice(-12),
  ]
  let reply = ''
  try {
    reply = String(await host.services.model.chat({ messages, maxTokens: 900 }) ?? '').trim()
  } catch (error) {
    console.log('model error:', String(error?.message ?? error))
    break
  }
  counts.steps += 1
  fs.appendFileSync(logFile, `${JSON.stringify({ t: Date.now() - started, role: 'assistant', text: reply })}\n`, 'utf8')

  const pick = (() => {
    const trimmed = reply.trim()
    try { return JSON.parse(trimmed) } catch { /* 继续找 */ }
    const start = trimmed.indexOf('{')
    if (start < 0) return null
    let depth = 0, inStr = false, esc = false
    for (let i = start; i < trimmed.length; i++) {
      const c = trimmed[i]
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue }
      if (c === '"') inStr = true
      else if (c === '{') depth++
      else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(trimmed.slice(start, i + 1)) } catch { return null } } }
    }
    return null
  })()
  let acted = false
  if (pick && pick.tool) {
    try {
      const call = pick
      const tool = tools[call.tool]
      if (tool) {
        counts.toolCalls += 1
        counts.byTool[call.tool] = (counts.byTool[call.tool] ?? 0) + 1
        const sig = call.tool + JSON.stringify(call.args ?? {})
        recentCalls.push(sig)
        const repeats = recentCalls.filter((x) => x === sig).length
        const out = await tool.execute(call.args ?? {})
        const text = String(out?.text ?? JSON.stringify(out)).slice(0, 1200)
        fs.appendFileSync(logFile, `${JSON.stringify({ t: Date.now() - started, role: 'tool', name: call.tool, text })}\n`, 'utf8')
        history.push({ role: 'assistant', content: reply })
        const warn = repeats >= 2 ? '\n\n（同一个调用重复了。换一个，或者把刚才看到的东西记一句。）' : ''
        history.push({ role: 'user', content: `工具 ${call.tool} 返回：\n${text}${warn}` })
        acted = true
      }
    } catch { /* 不是合法工具调用就当普通发言 */ }
  }
  if (!acted) {
    counts.say += 1
    history.push({ role: 'assistant', content: reply })
    history.push({ role: 'user', content: '（继续。按你想做的来。）' })
  }
  if (Date.now() - started > seconds * 1000) { stopReason = 'duration'; break }
}

const mem = host.shared.get('memory')
const stat = mem.stats()
const notes = mem.query({ namespace: 'event', kind: 'note', limit: 500 })
const lex = mem.query({ namespace: 'lexicon', kind: 'term', limit: 500 })
const files = fs.readdirSync(root).filter((f) => !f.startsWith('.'))

const report = {
  seconds: Math.round((Date.now() - started) / 1000),
  stopReason,
  steps: counts.steps,
  toolCalls: counts.toolCalls,
  byTool: counts.byTool,
  say: counts.say,
  memory: stat,
  notes: notes.length,
  lexicon: lex.length,
  files,
  logFile,
}
console.log(JSON.stringify(report, null, 2))
