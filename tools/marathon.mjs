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
// 每次都干净启动：清掉上一轮的库与文件
if (!args.includes('--keep')) fs.rmSync(root, { recursive: true, force: true })
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
host.registerPlugin(dreamManifest, dream, { config: { sessionId: 'marathon', persona: fs.readFileSync(path.join(import.meta.dirname, '..', 'prompts', 'dream.md'), 'utf8') } })
const enabledIds = Array.isArray(cfg.plugins) && cfg.plugins.length ? cfg.plugins : ['memory', 'recall', 'note', 'lexicon', 'editor', 'bili', 'world-state', 'rhythm', 'dream']
for (const id of enabledIds) {
  try { await host.enable(id) } catch (error) { console.log('enable fail', id, String(error?.message ?? error)) }
}

host.services.model.bind({
  baseUrl: cfg.model.baseUrl,
  model: cfg.model.model,
  apiKey: process.env.DASHSCOPE_API_KEY ?? '',
  timeoutMs: cfg.model.timeoutMs ?? 120000,
  extraBody: cfg.model.disableThinking ? { chat_template_kwargs: { enable_thinking: false } } : undefined,
})

// 会话自己就是原文来源：每一步都存进去，晚上做梦才有原料
const transcript = []
host.services.raw.register({
  id: 'marathon-log',
  search: ({ query, limit = 3 }) => transcript.filter((m) => String(m.text).includes(String(query))).slice(0, limit),
  list: ({ since = null, until = null, limit = 400 } = {}) => transcript
    .filter((m) => (since == null || m.time >= since) && (until == null || m.time < until))
    .slice(0, limit),
})

// 做梦用同一个本地模型
host.services.slots.registerProvider({
  id: 'local-chat', kind: 'chat', shape: { tools: false },
  call: async ({ messages, maxTokens }) => host.services.model.chat({ messages, maxTokens }),
})
host.services.slots.bind('dream-chat', {
  provider: 'local-chat',
  call: async ({ messages, maxTokens }) => host.services.model.chat({ messages, maxTokens }),
})

// 工具结果里的自然语言也要进原始层（去掉 JSON 结构）
function naturalize(name, out) {
  const text = String(out?.text ?? '')
  if (name !== 'bili_search' && name !== 'bili_watch' && name !== 'bili_comments') return text.slice(0, 1200)
  try {
    const data = JSON.parse(text)
    const parts = []
    if (data.videos) for (const v of data.videos) parts.push(`看到视频《${v.title}》（${v.author}，${v.play} 播放）`)
    if (data.title) parts.push(`看了《${data.title}》，${data.author}，${data.stat?.view ?? '?'} 播放。${String(data.description ?? '').slice(0, 200)}`)
    if (data.comments) for (const c of data.comments) parts.push(`评论区 ${c.user}：${String(c.content ?? '').slice(0, 160)}`)
    return parts.join('\n').slice(0, 1500)
  } catch { return text.slice(0, 800) }
}

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
    const detailed = await host.services.model.chatDetailed({ messages, maxTokens: 1200 })
    reply = String(detailed?.text ?? '').trim()
    if (String(detailed?.reasoning ?? '').trim()) {
      transcript.push({ text: String(detailed.reasoning).slice(0, 1200), time: Date.now(), conv: 'marathon', kind: 'think' })
    }
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
        // 原文只留自然语言：写进文件的那段话也算她说的
        if ((call.tool === 'write_file' || call.tool === 'remember') && typeof call.args?.text === 'string') {
          transcript.push({ text: call.args.text.slice(0, 800), time: Date.now(), conv: 'marathon', kind: 'note' })
        }
        const text = String(out?.text ?? JSON.stringify(out)).slice(0, 1200)
        fs.appendFileSync(logFile, `${JSON.stringify({ t: Date.now() - started, role: 'tool', name: call.tool, text })}\n`, 'utf8')
        const warn = repeats >= 2 ? '\n\n（同一个调用重复了。换一个，或者把刚才看到的东西记一句。）' : ''
        // 工具调用之外的那句话也是原文
        const prose = reply.replace(JSON.stringify(pick), '').replace(/```(json)?/g, '').trim()
        if (prose.length > 4) transcript.push({ text: prose.slice(0, 500), time: Date.now(), conv: 'marathon', kind: 'say' })
        const seen = naturalize(call.tool, out)
        if (seen) transcript.push({ text: seen, time: Date.now(), conv: 'marathon', kind: 'saw' })
        const imagePath = out?.imagePath && fs.existsSync(out.imagePath) ? out.imagePath : null
        if (imagePath) {
          const b64 = fs.readFileSync(imagePath).toString('base64')
          history.push({ role: 'assistant', content: reply })
          history.push({ role: 'user', content: [
            { type: 'text', text: `工具 ${call.tool} 返回：\n${text}${warn}` },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
          ] })
        } else {
          history.push({ role: 'assistant', content: reply })
          history.push({ role: 'user', content: `工具 ${call.tool} 返回：\n${text}${warn}` })
        }
        acted = true
      }
    } catch { /* 不是合法工具调用就当普通发言 */ }
  }
  if (!acted) {
    counts.say += 1
    transcript.push({ text: reply.slice(0, 800), time: Date.now(), conv: 'marathon', kind: 'say' })
    history.push({ role: 'assistant', content: reply })
    history.push({ role: 'user', content: '（继续。按你想做的来。）' })
  }
  if (Date.now() - started > seconds * 1000) { stopReason = 'duration'; break }
}

// 收尾：把这段会话当成"今天"跑一次做梦
let dreamRun = null
try {
  const out = await host.shared.get('dream').run({ now: Date.now() })
  dreamRun = out.results
} catch (error) { dreamRun = { error: String(error?.message ?? error) } }

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
  blocks: mem.query({ namespace: 'event', kind: 'block', limit: 200 }).length,
  dream: dreamRun,
  files,
  logFile,
}
function exportAll() {
  const dir = path.join(import.meta.dirname, '..', 'state', 'marathon-exports', new Date().toISOString().replace(/[:.]/g, '-'))
  fs.mkdirSync(dir, { recursive: true })
  const rows = (ns, kind) => mem.query({ namespace: ns, kind, limit: 500 })
  const fmt = (r) => {
    const d = r.data ?? {}
    const extra = {
      ...(d.profile ? { profile: d.profile } : {}),
      ...(d.body ? { body: d.body } : {}),
      ...(d.origins ? { origins: d.origins } : {}),
      ...(d.evidence ? { evidence: d.evidence } : {}),
      ...(d.term ? { term: d.term } : {}),
      ...(d.status ? { status: d.status } : {}),
    }
    return `- ${r.text}${Object.keys(extra).length ? `\n  \`${JSON.stringify(extra).slice(0, 600)}\`` : ''}`
  }
  const parts = ['# 记忆导出', '']
  for (const [ns, kind] of [['event', 'block'], ['person', 'block'], ['lexicon', 'term'], ['event', 'note'], ['note', 'note']]) {
    const list = rows(ns, kind)
    parts.push(`## ${ns}/${kind} (${list.length})`, '')
    parts.push(list.length ? list.map(fmt).join('\n') : '（空）')
    parts.push('')
  }
  fs.writeFileSync(path.join(dir, 'memory.md'), parts.join('\n'))
  const lines = []
  for (const line of fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean)) {
    try {
      const o = JSON.parse(line)
      lines.push(o.role === 'tool' ? `- [${o.name}] ${String(o.text).slice(0, 200)}` : `→ ${String(o.text).slice(0, 300)}`)
    } catch { /* ignore */ }
  }
  fs.writeFileSync(path.join(dir, 'transcript.md'), ['# 会话记录', '', ...lines].join('\n'))
  return dir
}
const exportDir = exportAll()
console.log('EXPORT ' + exportDir)
console.log(JSON.stringify(report, null, 2))
