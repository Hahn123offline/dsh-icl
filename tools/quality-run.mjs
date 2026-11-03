// 固定素材跑做梦，产出可对比的快照。
//
//   node tools/quality-run.mjs                       # 默认用 llama-swap 的本地模型
//   node tools/quality-run.mjs --model deepseek-chat # 用 DeepSeek
//
// 输出：docs/quality/<时间戳>.md（块、人物、词汇的完整文本）
// 报告：块数、块长度分布、时间跨度覆盖、证据覆盖率
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../packages/core/src/index.mjs'
import * as memory from '../packages/plugins/memory/src/index.mjs'
import * as recall from '../packages/plugins/recall/src/index.mjs'
import * as dream from '../packages/plugins/dream/src/index.mjs'
import * as lexicon from '../packages/plugins/lexicon/src/index.mjs'
import * as note from '../packages/plugins/note/src/index.mjs'
import memoryManifest from '../packages/plugins/memory/manifest.json' with { type: 'json' }
import recallManifest from '../packages/plugins/recall/manifest.json' with { type: 'json' }
import dreamManifest from '../packages/plugins/dream/manifest.json' with { type: 'json' }
import lexiconManifest from '../packages/plugins/lexicon/manifest.json' with { type: 'json' }
import noteManifest from '../packages/plugins/note/manifest.json' with { type: 'json' }

const args = process.argv.slice(2)
const arg = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback }
const baseUrl = arg('--base', process.env.ICL_LLM_BASE ?? 'http://127.0.0.1:8088/v1').replace(/\/+$/, '')
const model = arg('--model', process.env.ICL_LLM_MODEL ?? 'coder390-27b-q3-df2-4x500')
const apiKey = process.env[arg('--key-env', 'DEEPSEEK_API_KEY')] ?? ''
const fixture = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'quality-day.json'), 'utf8'))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-quality-'))

const host = createHost({ log: () => {} })
host.registerPlugin(memoryManifest, memory, { config: { root } })
host.registerPlugin(recallManifest, recall, { config: { sessionId: 'quality' } })
host.registerPlugin(noteManifest, note, {})
host.registerPlugin(lexiconManifest, lexicon, {})
host.registerPlugin(dreamManifest, dream, { config: { sessionId: 'quality', persona: fs.readFileSync(path.join(import.meta.dirname, '..', 'prompts', 'dream.md'), 'utf8') } })
for (const id of ['memory', 'recall', 'note', 'lexicon', 'dream']) await host.enable(id)

host.services.model.bind({ baseUrl, model, apiKey, timeoutMs: 300_000, extraBody: { chat_template_kwargs: { enable_thinking: false } } })
const call = async ({ messages, maxTokens }) => host.services.model.chat({ messages, maxTokens })
host.services.slots.registerProvider({ id: 'quality-chat', kind: 'chat', call })
host.services.slots.bind('dream-chat', { provider: 'quality-chat', call })

const rows = fixture.messages.map((m, i) => ({
  id: i + 1,
  text: `${m.sender}：${m.text}`,
  time: Date.parse(m.time),
  conv: 'quality-day',
}))
host.services.raw.register({ id: 'fixture', search: () => [], list: ({ limit = 500 } = {}) => rows.slice(0, limit) })

const started = Date.now()
const out = await host.shared.get('dream').run({ now: Date.parse(fixture.messages[fixture.messages.length - 1].time) })
const seconds = Math.round((Date.now() - started) / 1000)

const mem = host.shared.get('memory')
const blocks = mem.query({ namespace: 'event', kind: 'block', limit: 200 })
const personNotes = mem.query({ namespace: 'person', kind: 'note', limit: 200 })
const personBlocks = mem.query({ namespace: 'person', kind: 'block', limit: 200 })
const terms = mem.query({ namespace: 'lexicon', kind: 'term', limit: 200 })

const hhmm = (at) => (at ? new Date(Number(at)).toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5) : '?')
const lengths = blocks.map((b) => String(b.data?.body ?? b.text ?? '').length)
const avg = lengths.length ? Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length) : 0

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const dir = path.join(import.meta.dirname, '..', 'docs', 'quality')
fs.mkdirSync(dir, { recursive: true })
const file = path.join(dir, `${stamp}.md`)
const lines = [
  `# 做梦质量快照 ${stamp}`,
  '',
  `- 模型：${model}（${baseUrl}）`,
  `- 素材：${fixture.messages.length} 条消息，${fixture.name}`,
  `- 耗时：${seconds}s`,
  `- 块：${blocks.length} 个，正文平均 ${avg} 字（min ${lengths.length ? Math.min(...lengths) : 0} / max ${lengths.length ? Math.max(...lengths) : 0}）`,
  `- 人物：${personBlocks.length} 块 / ${personNotes.length} 条笔记`,
  `- 词汇：${terms.length} 条`,
  '',
  '## 块',
  ...blocks.map((b) => `### ${b.text}\n\n- 时间：${hhmm(b.data?.from)}–${hhmm(b.data?.to)}\n- 证据：${(b.data?.evidence ?? []).length} 条\n\n${b.data?.body ?? ''}\n`),
  '## 人物笔记',
  ...personNotes.map((p) => `- ${p.text}`),
  '## 词汇',
  ...terms.map((t) => `- ${t.data?.term ?? t.text}：${(t.data?.origins ?? []).map((o) => o.meaning).filter(Boolean).join(' / ')}`),
  '',
  '## 期望',
  ...Object.entries(fixture.expect ?? {}).map(([k, v]) => `- ${k}：${v}`),
].join('\n')
fs.writeFileSync(file, lines, 'utf8')

const report = {
  model,
  seconds,
  jobs: out.results,
  blocks: blocks.length,
  avgBodyChars: avg,
  spans: blocks.map((b) => `${hhmm(b.data?.from)}–${hhmm(b.data?.to)}`),
  evidence: blocks.map((b) => (b.data?.evidence ?? []).length),
  personNotes: personNotes.length,
  personBlocks: personBlocks.length,
  terms: terms.map((t) => t.data?.term ?? t.text),
  snapshot: file,
}
console.log(JSON.stringify(report, null, 2))
