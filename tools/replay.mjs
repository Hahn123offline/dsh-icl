// 按天回放旧记录，重建记忆。两步走：
//   第一步：--source qq     读 dsh-qq 的原始聊天库（默认）
//   第二步：--source dsh    读一个 DSH 会话（coding 那种信息量大的）
//
//   node tools/replay.mjs --source qq --real
//   node tools/replay.mjs --source dsh --session <session-xxx> --real
//
// 只读原始消息：绝不读 summaries / 已总结段落。
// 每天：抽取"值得记的" → 写 note → 跑完整做梦 → 记一行账。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { createHost } from '../packages/core/src/index.mjs'
import * as memory from '../packages/plugins/memory/src/index.mjs'
import * as recall from '../packages/plugins/recall/src/index.mjs'
import * as rhythm from '../packages/plugins/rhythm/src/index.mjs'
import * as dream from '../packages/plugins/dream/src/index.mjs'
import * as note from '../packages/plugins/note/src/index.mjs'
import * as lexicon from '../packages/plugins/lexicon/src/index.mjs'
import memoryManifest from '../packages/plugins/memory/manifest.json' with { type: 'json' }
import recallManifest from '../packages/plugins/recall/manifest.json' with { type: 'json' }
import rhythmManifest from '../packages/plugins/rhythm/manifest.json' with { type: 'json' }
import dreamManifest from '../packages/plugins/dream/manifest.json' with { type: 'json' }
import noteManifest from '../packages/plugins/note/manifest.json' with { type: 'json' }
import lexiconManifest from '../packages/plugins/lexicon/manifest.json' with { type: 'json' }

const args = process.argv.slice(2)
const arg = (name, fallback = null) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const SOURCE = arg('--source', 'qq')
const REAL = args.includes('--real')
const SESSION = arg('--session', null)
const TZ = 'Asia/Hong_Kong'
const QQ_DB = 'C:/DSH/qwenstuff/dsh-qq/state/memory.db'
const SESS_ROOT = path.join(process.env.USERPROFILE, '.dsh', 'sessions')

const dayOf = (ts) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts))
const dayEnd = (day) => Date.parse(`${day}T23:59:59+08:00`)

/* ── 读原始消息 ─────────────────────────────────────────────── */

function loadQq() {
  const db = new DatabaseSync(QQ_DB, { readOnly: true })
  // 只读 messages（原文）；summaries 表一律不碰。
  const rows = db.prepare('SELECT conv_key, sender, sender_id, text, ts, is_self FROM messages ORDER BY ts ASC').all()
  db.close()
  return rows
    .filter((r) => String(r.text ?? '').trim())
    .map((r) => ({
      ts: Number(r.ts),
      sender: String(r.sender ?? (Number(r.is_self) ? '我' : '?')),
      conv: String(r.conv_key ?? ''),
      qq: String(r.sender_id ?? ''),
      text: String(r.text).replace(/\s+/g, ' ').trim().slice(0, 400),
      self: Number(r.is_self) === 1,
    }))
}

function loadDsh(sessionId) {
  const roots = fs.readdirSync(SESS_ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  const found = []
  for (const root of roots) {
    const dir = path.join(SESS_ROOT, root, sessionId)
    if (!fs.existsSync(dir)) continue
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.zstd')) continue
      const buf = fs.readFileSync(path.join(dir, file))
      let text
      try { text = zlib.zstdDecompressSync(buf).toString('utf8') } catch { continue }
      for (const line of text.split('\n').filter(Boolean)) {
        let obj
        try { obj = JSON.parse(line) } catch { continue }
        if (obj.type === 'user/message') {
          const body = (obj.data?.content ?? []).map((b) => b.text ?? '').join('\n')
          // 只要人说的话：运行时上下文、skill 目录、时间快照、源代码包装都不算对话。
          const clean = keepHumanText(body)
          if (clean) found.push({ ts: Number(obj.time), sender: '用户', qq: '', text: clean.slice(0, 600), self: false })
        } else if (obj.type === 'assistant/message') {
          const body = (obj.data?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n').trim()
          if (body && body.length > 20) found.push({ ts: Number(obj.time), sender: '我', qq: '', text: body.slice(0, 600), self: true })
        }
      }
    }
  }
  return found.sort((a, b) => a.ts - b.ts)
}


/** 从模型输出里取第一个完整的 JSON 数组（容忍后面跟解释）。 */
function parseJsonArray(raw) {
  const text = String(raw ?? '')
  const start = text.indexOf('[')
  if (start < 0) return []
  let depth = 0, inStr = false, esc = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '[') depth++
    else if (ch === ']') {
      depth--
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)) } catch { return [] }
      }
    }
  }
  return []
}

const NOISE_PREFIXES = [
  'Current runtime context.', '<system-reminder>', 'Time sampled',
  'This is an automatically generated checkpoint', '【当前时间】',
  'The following skills are available', 'Current DeepSeek Harness',
]

/** 只保留人真正说的话（会话日志里大量上下文注入要剔掉）。 */
function keepHumanText(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return ''
  if (NOISE_PREFIXES.some((p) => raw.startsWith(p))) return ''
  if (/^<\/?[a-z-]+>/.test(raw)) return ''
  return stripInjected(raw)
}

function stripInjected(text) {
  let s = String(text)
  s = s.replace(/【当前时间】[\s\S]*?(?=\n\n【|$)/g, '')
  s = s.replace(/Current runtime context\.[\s\S]*$/m, '')
  s = s.replace(/【会话令牌】[^\n]*/g, '')
  // qq 消息数组：尽量抽出 text 字段
  const texts = [...s.matchAll(/"text":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1])
  if (texts.length) return texts.join('\n').slice(0, 2000)
  return s.trim().slice(0, 2000)
}

/* ── 抽取 ──────────────────────────────────────────────────── */

const EXTRACT = `你在把一天的聊天记录里"值得长期记住"的部分挑出来。
只挑以后真的可能再用到的：发生过的事、人物的信息与变化、约定、新梗。
**分类要严格**：只要内容是关于某个具体人的（称呼、关系、住哪、喜好、约定、近况），就用 kind=person 并带上它的 qq，不要全塞进 event；kind=slang 只用于新词/梗/黑话；event 只放事件与约定。
不要挑寒暄、重复的话、纯表情、以及"今天聊了很多"这种概括。

输出 JSON 数组，每项：
{"kind":"event|person|slang","text":"一句话（第一人称可以，但不许编）","qq":"涉及人物的 QQ 号；只有 person 需要，必须从聊天记录行首的 [qq=...] 里原样拄过来"}
只输出 JSON。没有值得记的就输出 []。`


const EXTRACT_CODE = `你在把一段开发会话里"值得长期记住"的东西挑出来。
只挑以后真可能再用到的：做了什么决定、改了哪些文件、遇到什么坑与怎么解决、约定与约束、验证方式。
不要挑：寒暄、重复的推理、工具输出原文、"我开始工作"这种过程句。
每条一句话，带上具体名字（文件/函数/命令/错误）。

输出 JSON 数组，每项：{"kind":"event","text":"一句话"}
只输出 JSON。没有值得记的就输出 []。`

/* ── 主流程 ────────────────────────────────────────────────── */

const logs = []
const log = (...a) => { const line = a.join(' '); logs.push(line); console.log(line) }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-replay-'))
const host = createHost({ log: () => {} })
host.registerPlugin(memoryManifest, memory, { config: { root } })
host.registerPlugin(recallManifest, recall, { config: { sessionId: 'replay' } })
host.registerPlugin(rhythmManifest, rhythm, { config: { dreamAt: '23:59', stateFile: path.join(root, 'rhythm.json') } })
host.registerPlugin(dreamManifest, dream, { config: { sessionId: 'replay', debugLexicon: process.env.ICL_LEX_DEBUG === '1', personaFile: path.join(import.meta.dirname, '..', 'prompts', 'dream.md') } })
host.registerPlugin(noteManifest, note, {})
host.registerPlugin(lexiconManifest, lexicon, {})
await host.enable('memory')
await host.enable('recall')
await host.enable('rhythm')
await host.enable('dream')
await host.enable('note')
await host.enable('lexicon')

let chat
if (REAL) {
  const base = String(process.env.ICL_LLM_BASE ?? '').replace(/\/+$/, '')
  const model = String(process.env.ICL_LLM_MODEL ?? '')
  const key = String(process.env.DEEPSEEK_API_KEY ?? '')
  if (!base || !model) throw new Error('--real 需要 ICL_LLM_BASE / ICL_LLM_MODEL')
  const call = async ({ messages, maxTokens }) => {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens ?? 1500, stream: false }),
    })
    if (!res.ok) throw new Error(`模型 ${res.status}`)
    return String(((await res.json())?.choices?.[0]?.message?.content) ?? '')
  }
  chat = call
  host.services.slots.bind('dream-chat', { provider: 'replay-chat', call })
  const embedBase = String(process.env.ICL_EMBED_BASE ?? '').replace(/\/+$/, '')
  const embedModel = String(process.env.ICL_EMBED_MODEL ?? '')
  if (embedBase && embedModel) {
    host.services.slots.registerProvider({
      id: 'replay-embed', kind: 'embedding', shape: { dim: 1024 },
      call: async ({ input }) => {
        const res = await fetch(`${embedBase}/embeddings`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: embedModel, input }),
        })
        if (!res.ok) throw new Error(`embedding ${res.status}`)
        return ((await res.json())?.data ?? []).map((d) => d.embedding)
      },
    })
    host.services.slots.autoBind()
  }
} else {
  chat = async ({ messages }) => {
    const user = String(messages?.at(-1)?.content ?? '')
    const out = []
    if (user.includes('值得长期记住')) {
      for (const line of user.split('\n').slice(0, 3)) {
        if (line.includes(':')) out.push({ kind: 'event', text: line.slice(0, 60) })
      }
    }
    return JSON.stringify(out)
  }
  host.services.slots.bind('dream-chat', { provider: 'fake', call: async () => '[]' })
}

// 原文层：直接从原始日志按需查，不复制进记忆库
host.services.raw.register({
  id: 'qq-log',
  list: ({ since = null, until = null, limit = 500 }) => msgs
    .filter((m) => (since == null || m.ts >= since) && (until == null || m.ts < until))
    .slice(0, limit)
    .map((m) => ({ text: m.text, time: m.ts, sender: m.sender })),
  search: ({ query, limit = 2 }) => {
    const q = String(query ?? '').toLowerCase()
    const grams = []
    for (let i = 0; i < q.length - 1; i++) {
      const g = q.slice(i, i + 2)
      if (!/[?？。，、\s]/.test(g)) grams.push(g)
    }
    const scored = msgs.map((m) => {
      const text = String(m.text).toLowerCase()
      let hit = 0
      for (const g of grams) if (text.includes(g)) hit += 1
      return { m, hit }
    }).filter((x) => x.hit > 0)
    scored.sort((a, b) => b.hit - a.hit)
    return scored.slice(0, limit).map((x) => ({ text: x.m.text, time: x.m.ts, sender: x.m.sender }))
  },
})

const mem = host.shared.get('memory')
const msgs = SOURCE === 'qq' ? loadQq() : loadDsh(SESSION)
if (!msgs.length) { console.error('没有读到原始消息'); process.exit(2) }
const days = new Map()
for (const m of msgs) {
  const d = dayOf(m.ts)
  if (!days.has(d)) days.set(d, [])
  days.get(d).push(m)
}
log(`源：${SOURCE}  消息：${msgs.length}  天数：${days.size}  范围：${[...days.keys()].sort().join(' → ')}`)

const report = []
for (const day of [...days.keys()].sort()) {
  const list = days.get(day)
  const convCount = new Map()
  for (const m of list) if (m.conv) convCount.set(m.conv, (convCount.get(m.conv) ?? 0) + 1)
  const dayConv = [...convCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  const transcript = list.map((m) => `[qq=${m.qq || '-'}] ${m.sender}: ${m.text}`).join('\n').slice(0, 12000)
  let items = []
  try {
    const raw = await chat({
      messages: [
        { role: 'system', content: SOURCE === 'dsh' ? EXTRACT_CODE : EXTRACT },
        { role: 'user', content: transcript },
      ],
      maxTokens: 1500,
    })
    items = parseJsonArray(raw)
    if (!items.length && args.includes('--debug')) log('  raw:', String(raw).slice(0, 300))
  } catch (error) {
    log(`${day} 抽取失败：${error.message}`)
  }
  // 写入 note（与主会话 remember 同一条路）
  let wrote = 0
  let skippedPeople = 0
  // 人物笔记必须带 QQ：模型没给就从当天的发言人里匹配，匹不上就不写。
  const nameToQq = new Map()
  for (const m of list) if (m.qq && m.sender) nameToQq.set(m.sender, m.qq)
  for (const item of items) {
    const kind = ['event', 'person', 'slang'].includes(item?.kind) ? item.kind : 'event'
    const text = String(item?.text ?? '').trim()
    if (!text) continue
    let qq = kind === 'person' ? String(item?.qq ?? '').trim() : ''
    if (kind === 'person' && !qq) {
      for (const [sender, id] of nameToQq) if (sender && text.includes(sender)) { qq = id; break }
    }
    if (kind === 'person' && !qq) { skippedPeople += 1; continue }
    const data = { day, source: SOURCE, qq: qq || null, ...(dayConv ? { origin: { conv: dayConv } } : {}) }
    mem.put({ namespace: kind, kind: 'note', text, data, now: dayEnd(day) })
    wrote += 1
  }
  if (skippedPeople) log(`${day} 跳过无 QQ 的人物条目 ${skippedPeople} 条`)
  const out = await host.shared.get('dream').run({ now: dayEnd(day) })
  const jobs = Object.fromEntries(out.results.map((r) => [r.job, r.skipped ? r.skipped : (r.ok ? (r.blocks ?? r.learned ?? r.merged ?? r.indexed ?? 0) : 'fail')]))
  report.push({ day, messages: list.length, extracted: wrote, jobs, ok: out.ok })
  log(`${day} 消息 ${String(list.length).padStart(3)} → 抽取 ${String(wrote).padStart(2)} | ${JSON.stringify(jobs)}`)
}

const stats = mem.stats()
log(`\n库：items ${stats.items}  vectors ${stats.vectors}`)

/* ── 自动出题考它 ──────────────────────────────────────────── */

const blocks = ['event', 'person', 'slang'].flatMap((ns) => mem.query({ namespace: ns, kind: 'block', limit: 200 }))
if (REAL && blocks.length) {
  const material = blocks.map((b) => `- ${b.text}`).join('\n').slice(0, 4000)
  let probes = []
  try {
    const raw = await chat({
      messages: [
        { role: 'system', content: '根据这些记忆块，出 8 个"回忆型"问题，每题只问一件事。输出 JSON：[{"q":"问题","expect":"答案里必须出现的关键词"}]。只输出 JSON。' },
        { role: 'user', content: material },
      ],
      maxTokens: 800,
    })
    const start = raw.indexOf('[')
    if (start >= 0) probes = JSON.parse(raw.slice(start, raw.lastIndexOf(']') + 1))
  } catch (error) { log(`出题失败：${error.message}`) }
  const recallTool = host.services.tools.list().find((t) => t.name === 'recall')
  const recallSvc = host.shared.get('recall')
  let hit = 0
  for (const p of probes) {
    recallSvc?.resetCursor?.()
    const res = await recallTool.execute({ query: p.q, limit: 4 })
    const ok = String(res.text).includes(p.expect)
    if (ok) hit += 1
    log(` ${ok ? '✓' : '✗'} ${p.q} → 期望含「${p.expect}」`)
  }
  log(`\n召回命中：${hit}/${probes.length}`)
  report.push({ probes: probes.length, hit })
}

fs.writeFileSync(path.join(import.meta.dirname, '..', 'replay-report.json'), JSON.stringify({ source: SOURCE, report, logs }, null, 2))
log(`\n报告：replay-report.json`)
process.exit(report.every((r) => r.ok !== false) ? 0 : 1)
