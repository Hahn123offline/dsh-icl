// 召回压力测试：按不同粒度出题，量"事实还原"到底丢在哪一层。
//
//   node tools/recall-bench.mjs                 # 用最近一次 replay 的库
//   node tools/recall-bench.mjs --db <dir>
//   node tools/recall-bench.mjs --n 4           # 每个粒度出几题
//
// 四个粒度：
//   detail  数字、路径、专有名词（最容易丢）
//   event   某天发生了什么
//   person  某个人是谁、什么关系
//   overall 跨天的整体印象
//
// 每题都从原始消息出，标好答案关键词与出处。然后分开看两个指标：
//   coverage  这个事实有没有被抽取进块（抽取问题）
//   recalled  块存在时，recall 前 k 条里能不能找到（检索问题）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHost } from '../packages/core/src/index.mjs'
import * as memory from '../packages/plugins/memory/src/index.mjs'
import * as recall from '../packages/plugins/recall/src/index.mjs'
import * as whois from '../packages/plugins/whois/src/index.mjs'
import memoryManifest from '../packages/plugins/memory/manifest.json' with { type: 'json' }
import recallManifest from '../packages/plugins/recall/manifest.json' with { type: 'json' }
import whoisManifest from '../packages/plugins/whois/manifest.json' with { type: 'json' }

const args = process.argv.slice(2)
const arg = (n, d = null) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const PER_LEVEL = Number(arg('--n', 3))
const K = Number(arg('--k', 4))
const REFRESH_PERSON = args.includes('--refresh-person')
const QQ_DB = 'C:/DSH/qwenstuff/dsh-qq/state/memory.db'

function latestReplayDb() {
  const dirs = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('icl-replay-')).map((d) => path.join(os.tmpdir(), d))
  dirs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  return dirs[0] ? path.join(dirs[0], 'state', 'memory.db') : null
}

const dbPath = arg('--db', null) ?? latestReplayDb()
if (!dbPath || !fs.existsSync(dbPath)) { console.error('找不到 replay 库，先跑一次 tools/replay.mjs'); process.exit(2) }

// 原始消息作为出题的"真相源"
const raw = (() => {
  const db = new DatabaseSync(QQ_DB, { readOnly: true })
  const rows = db.prepare('SELECT sender, text, ts FROM messages ORDER BY ts ASC').all()
  db.close()
  return rows.filter((r) => String(r.text ?? '').trim()).map((r, i) => ({ id: i + 1, sender: r.sender, text: String(r.text).replace(/\s+/g, ' ').trim() }))
})()
const transcript = raw.map((m) => `[${m.id}] ${m.sender}: ${m.text.slice(0, 300)}`).join('\n').slice(0, 24000)

const chat = async ({ messages, maxTokens = 1500 }) => {
  const base = String(process.env.ICL_LLM_BASE ?? '').replace(/\/+$/, '')
  const model = String(process.env.ICL_LLM_MODEL ?? '')
  const key = String(process.env.DEEPSEEK_API_KEY ?? '')
  if (!base || !model) throw new Error('需要 ICL_LLM_BASE / ICL_LLM_MODEL')
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, stream: false }),
  })
  if (!res.ok) throw new Error(`模型 ${res.status}`)
  return String(((await res.json())?.choices?.[0]?.message?.content) ?? '')
}

const parseArray = (text) => {
  const s = String(text ?? '')
  const start = s.indexOf('[')
  if (start < 0) return []
  let depth = 0, inStr = false, esc = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue }
    if (c === '"') inStr = true
    else if (c === '[') depth++
    else if (c === ']') { depth--; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)) } catch { return [] } } }
  }
  return []
}

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'bench-qq.json')
const LEVELS = [
  { id: 'detail', hint: '数字、路径、文件名、专有名词这类细节' },
  { id: 'event', hint: '某一天发生的一件具体的事' },
  { id: 'person', hint: '某个人是谁、和我的关系、TA 的特点' },
  { id: 'overall', hint: '跨几天的整体印象或长期变化' },
]

const questions = fs.existsSync(FIXTURE) ? JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) : []
if (questions.length) console.log('用冻结题库：', FIXTURE, questions.length, '题')
for (const level of questions.length ? [] : LEVELS) {
  try {
    const rawOut = await chat({
      messages: [
        {
          role: 'system',
          content: [
            '你在根据聊天原文出"回忆题"，用来测试一个记忆系统。',
            `请出 ${PER_LEVEL} 道【${level.id}】粒度的问题，主题是：${level.hint}。`,
            '每题必须能在原文里找到明确答案，不要出需要推理或主观判断的题。',
            '输出 JSON 数组：[{"q":"问题","expect":"一个短而独特的原文片段（专名/数字/路径/文件名/称呼），逐字复制，不超过 15 字；不要改写、不要综合","evidence":[原文编号]}]',
            '只输出 JSON。',
          ].join('\n'),
        },
        { role: 'user', content: transcript },
      ],
      maxTokens: 1200,
    })
    for (const item of parseArray(rawOut)) {
      if (!item?.q || !item?.expect) continue
      questions.push({ level: level.id, q: String(item.q), expect: String(item.expect), evidence: item.evidence ?? [] })
    }
  } catch (error) { console.error(level.id, '出题失败:', error.message) }
}

if (!fs.existsSync(FIXTURE)) { fs.mkdirSync(path.dirname(FIXTURE), { recursive: true }); fs.writeFileSync(FIXTURE, JSON.stringify(questions, null, 2)); console.log('题库已冻结：', FIXTURE) }

// 打开 replay 出来的库
const host = createHost({ log: () => {} })
host.registerPlugin(memoryManifest, memory, { config: { root: path.dirname(path.dirname(dbPath)) } })
host.registerPlugin(recallManifest, recall, { config: { sessionId: 'bench' } })
host.registerPlugin(whoisManifest, whois, {})
host.services.raw.register({
  id: 'bench-raw',
  search: ({ query, limit = 2 }) => {
    const q = String(query ?? '').toLowerCase()
    const grams = []
    for (let i = 0; i < q.length - 1; i++) { const g = q.slice(i, i + 2); if (!/[?？。，、\s]/.test(g)) grams.push(g) }
    const scored = raw.map((m) => {
      const text = String(m.text).toLowerCase()
      let hit = 0
      for (const g of grams) if (text.includes(g)) hit += 1
      return { m, hit }
    }).filter((x) => x.hit > 0).sort((a, b) => b.hit - a.hit)
    return scored.slice(0, limit).map((x) => ({ text: x.m.text, time: x.m.ts ?? x.m.time, sender: x.m.sender }))
  },
})
await host.enable('memory')
await host.enable('recall')
await host.enable('whois')
const mem = host.shared.get('memory')
const recallTool = host.services.tools.list().find((t) => t.name === 'recall')
const recallSvc = host.shared.get('recall')

const norm = (s) => String(s ?? '').toLowerCase().replace(/\\/g, '/').replace(/\/+$/g, '').replace(/\s+/g, '')
const has = (haystack, needle) => norm(haystack).includes(norm(needle))

// 人物题要从当前档案里现出：题和答案同源，否则测的是"题库是否过时"
if (REFRESH_PERSON) {
  const personBlocks = mem.query({ namespace: 'person', kind: 'block', limit: 50 })
  const claims = personBlocks.flatMap((b) => (b.data?.claims ?? []).map((c) => String(c.text)))
  if (claims.length) {
    const out2 = await chat({
      messages: [
        { role: 'system', content: '根据这些人物档案陈述，出 5 道回忆题。每题输出 {"q":"问题","expect":"逐字取自某条陈述的短片段（不超过15字）"}。只输出 JSON 数组。' },
        { role: 'user', content: claims.map((c) => '- ' + c).join('\n') },
      ],
      maxTokens: 800,
    })
    const fresh = parseArray(out2).map((x) => ({ level: 'person', q: String(x.q), expect: String(x.expect), evidence: [] })).filter((x) => x.q && x.expect)
    if (fresh.length) {
      const others = questions.filter((q) => q.level !== 'person')
      questions.length = 0
      questions.push(...others, ...fresh)
      const refreshed = path.join(path.dirname(FIXTURE), 'bench-qq.refreshed.json')
      fs.writeFileSync(refreshed, JSON.stringify(questions, null, 2))
      console.log('人物题已按当前档案重出：', fresh.length, '（写到', refreshed, '，不覆盖冻结题库）')
    }
  }
}

const allText = ['event', 'person', 'slang']
  .flatMap((ns) => mem.query({ namespace: ns, kind: 'block', limit: 500 }))
  .map((b) => `${b.text}\n${b.data?.body ?? b.data?.profile ?? ''}`)
  .join('\n')

const rows = []
for (const item of questions) {
  const coverage = has(allText, item.expect)
  recallSvc?.resetCursor?.()
  let out
  if (item.level === 'person') {
    // 人物题走 whois：逐个档案查，任一命中即算恢复
    const whoisTool = host.services.tools.list().find((t) => t.name === 'whois')
    const people = mem.query({ namespace: 'person', kind: 'block', limit: 50 })
    let best = ''
    for (const p of people) {
      const qq = String(p.data?.qq ?? '').trim()
      if (!qq) continue
      const res = await whoisTool.execute({ qq })
      if (has(res.text, item.expect)) { best = res.text; break }
    }
    out = { text: best }
  } else {
    out = await recallTool.execute({ query: item.q, limit: K })
  }
  const recalled = has(out.text, item.expect)
  rows.push({ ...item, coverage, recalled })
}

const byLevel = new Map()
for (const row of rows) {
  const bucket = byLevel.get(row.level) ?? { level: row.level, n: 0, coverage: 0, recalled: 0 }
  bucket.n += 1
  if (row.coverage) bucket.coverage += 1
  if (row.recalled) bucket.recalled += 1
  byLevel.set(row.level, bucket)
}

const pct = (a, b) => `${Math.round((a / Math.max(1, b)) * 100)}%`
console.log(`\n=== 召回压力测试（${rows.length} 题，recall@${K}）===`)
console.log('粒度      题数  抽取覆盖  召回命中')
for (const b of byLevel.values()) {
  console.log(`${b.level.padEnd(8)} ${String(b.n).padStart(4)}  ${pct(b.coverage, b.n).padStart(7)}  ${pct(b.recalled, b.n).padStart(7)}`)
}
const total = { n: rows.length, c: rows.filter((r) => r.coverage).length, r: rows.filter((r) => r.recalled).length }
console.log(`合计     ${String(total.n).padStart(4)}  ${pct(total.c, total.n).padStart(7)}  ${pct(total.r, total.n).padStart(7)}`)

console.log('\n错题：')
for (const row of rows.filter((r) => !r.recalled)) {
  console.log(`  [${row.level}] ${row.q}\n      期望「${row.expect}」 覆盖=${row.coverage ? '有' : '无'} 出处=${JSON.stringify(row.evidence)}`)
}

const report = { dbPath, k: K, total, levels: [...byLevel.values()], rows }
fs.writeFileSync(path.join(import.meta.dirname, '..', 'recall-bench.json'), JSON.stringify(report, null, 2))
console.log('\n报告：recall-bench.json')
