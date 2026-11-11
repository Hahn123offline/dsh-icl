#!/usr/bin/env node
// 只读记忆审计：不写 live memory.db，只输出可复核的统计和可疑项。
//
// 用法：
//   node tools/memory-audit.mjs
//   node tools/memory-audit.mjs --db <memory.db> --out .state/lab/memory-audit
//   node tools/memory-audit.mjs --json
//
// 默认读 $DSH_HOME/icl/state/state/memory.db；可用 ICL_STATE_DIR 覆盖。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0) return process.argv[index + 1] ?? fallback
  const prefix = `--${name}=`
  const hit = process.argv.find((item) => item.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : fallback
}

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const stateDir = process.env.ICL_STATE_DIR || path.join(home, 'icl', 'state')
const dbPath = path.resolve(arg('db', path.join(stateDir, 'state', 'memory.db')))
const outDir = arg('out', null)
const jsonOnly = process.argv.includes('--json')

const fmt = (ms) => {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return null
  return new Date(n).toLocaleString('sv-SE', { timeZone: 'Asia/Hong_Kong' })
}
const dayOf = (ms) => {
  const n = Number(ms)
  if (!Number.isFinite(n)) return '?'
  return new Date(n).toLocaleDateString('sv-SE', { timeZone: 'Asia/Hong_Kong' })
}
const readJsonLines = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean)
  } catch { return [] }
}
const normalize = (text) => String(text ?? '').toLowerCase().replace(/[\s，。！？、,.!?;；:：'"“”‘’（）()\[\]【】]/g, '')
const bigrams = (value) => {
  const out = new Set()
  const text = normalize(value)
  for (let i = 0; i < text.length - 1; i += 1) out.add(text.slice(i, i + 2))
  return out
}
const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const item of a) if (b.has(item)) inter += 1
  return inter / (a.size + b.size - inter)
}
const evidenceKeys = (item) => {
  const out = new Set()
  for (const entry of Array.isArray(item?.data?.evidence) ? item.data.evidence : []) {
    if (entry?.type && entry?.id != null) out.add(`${entry.type}:${entry.id}`)
    else if (entry?.at != null) out.add(`at:${entry.at}`)
  }
  return out
}

if (!fs.existsSync(dbPath)) {
  console.error(`找不到 memory.db：${dbPath}`)
  process.exit(2)
}
const db = new DatabaseSync(dbPath, { readOnly: true })
const rows = (sql, ...params) => db.prepare(sql).all(...params)
const one = (sql, ...params) => db.prepare(sql).get(...params)
const parseData = (raw) => {
  try { return raw ? JSON.parse(raw) : null } catch { return null }
}

const namespaces = rows('SELECT * FROM mem_ns ORDER BY id')
const tokens = {
  total: Number(one('SELECT COUNT(*) AS c FROM mem_items')?.c ?? 0),
  byNamespace: rows('SELECT namespace, kind, COUNT(*) AS c FROM mem_items GROUP BY namespace, kind ORDER BY namespace, kind'),
  byDay: rows("SELECT json_extract(data,'$.day') AS day, COUNT(*) AS c FROM mem_items WHERE namespace='event' AND kind='block' GROUP BY day ORDER BY day"),
}

const eventBlocks = rows("SELECT * FROM mem_items WHERE namespace='event' AND kind='block' ORDER BY created_at ASC").map((row) => ({ ...row, data: parseData(row.data) }))
const eventDupes = []
for (let i = 0; i < eventBlocks.length; i += 1) {
  for (let j = i + 1; j < eventBlocks.length; j += 1) {
    const a = eventBlocks[i]
    const b = eventBlocks[j]
    if (a.data?.day !== b.data?.day) continue
    const textScore = jaccard(bigrams(a.text), bigrams(b.text))
    const evidenceScore = jaccard(evidenceKeys(a), evidenceKeys(b))
    // 文本可能被不同轮改写；同一天的 evidence 大量重合，同样说明是重复块。
    if (textScore < 0.82 && !(evidenceScore >= 0.5 && textScore >= 0.35)) continue
    eventDupes.push({
      day: a.data?.day ?? dayOf(a.created_at),
      a: { id: Number(a.id), text: a.text },
      b: { id: Number(b.id), text: b.text },
      similarity: Math.round(textScore * 100) / 100,
      evidenceSimilarity: Math.round(evidenceScore * 100) / 100,
    })
  }
}

const personBlocks = rows("SELECT * FROM mem_items WHERE namespace='person' AND kind='block' ORDER BY created_at ASC").map((row) => ({
  id: Number(row.id), key: row.key, text: row.text, data: parseData(row.data), createdAt: fmt(row.created_at),
}))
const personKeys = personBlocks.map((row) => String(row.key ?? ''))
const personAliases = []
for (let i = 0; i < personBlocks.length; i += 1) {
  for (let j = i + 1; j < personBlocks.length; j += 1) {
    const score = jaccard(bigrams(personBlocks[i].text), bigrams(personBlocks[j].text))
    if (score >= 0.25) personAliases.push({ a: personBlocks[i].key, b: personBlocks[j].key, similarity: Math.round(score * 100) / 100 })
  }
}

const allItems = rows('SELECT * FROM mem_items ORDER BY id ASC').map((row) => ({
  id: Number(row.id), namespace: row.namespace, kind: row.kind, key: row.key, text: row.text,
  data: parseData(row.data), weight: Number(row.weight), recallCount: Number(row.recall_count),
  lastRecalledAt: row.last_recalled_at == null ? null : Number(row.last_recalled_at), createdAt: Number(row.created_at),
}))
const recall = {
  itemsWithRecall: allItems.filter((item) => item.recallCount > 0).map((item) => ({ id: item.id, namespace: item.namespace, text: item.text, recallCount: item.recallCount, lastRecalledAt: fmt(item.lastRecalledAt) })),
  maxRecallCount: Math.max(0, ...allItems.map((item) => item.recallCount)),
  boostedWeights: allItems.filter((item) => item.weight > 1).map((item) => ({ id: item.id, namespace: item.namespace, text: item.text, weight: item.weight })),
}

const noteRows = allItems.filter((item) => item.namespace === 'note')
const noteStats = {
  total: noteRows.length,
  byStatus: Object.fromEntries(['open', 'done', 'archived', 'resolved'].map((status) => [status, noteRows.filter((item) => (item.data?.status ?? 'open') === status).length])),
  byRaisedBy: Object.fromEntries([...new Set(noteRows.map((item) => item.data?.raisedBy ?? '?'))].map((key) => [key, noteRows.filter((item) => (item.data?.raisedBy ?? '?') === key).length])),
  byKind: Object.fromEntries([...new Set(noteRows.map((item) => item.data?.kind ?? '?'))].map((key) => [key, noteRows.filter((item) => (item.data?.kind ?? '?') === key).length])),
  autoQuestionNotes: noteRows.filter((item) => item.data?.raisedBy === 'lexicon' || item.data?.kind === 'question').map((item) => ({ id: item.id, status: item.data?.status ?? 'open', text: item.text, createdAt: fmt(item.createdAt) })),
}

const lexiconRows = allItems.filter((item) => item.namespace === 'lexicon')
const toolish = /(^|[:_-])(icl|mcb|time|qq|album|dream|compact|finish|body|slot|dsh|clip|status|context|token)([:_-]|$)|^(ICL|time_status|mcb_|body|finish|clip|阶段|积压|入库|去重|水位|睡段|睡眠边界)/i
const lexiconStats = {
  total: lexiconRows.length,
  candidates: lexiconRows.filter((item) => item.data?.status === 'candidate' || item.data?.pending === true).length,
  confirmed: lexiconRows.filter((item) => item.data?.status === 'confirmed').length,
  toolish: lexiconRows.filter((item) => toolish.test(String(item.data?.term ?? item.text))).map((item) => ({ id: item.id, term: item.data?.term ?? item.text })),
  terms: lexiconRows.map((item) => ({ id: item.id, term: item.data?.term ?? item.text, status: item.data?.status ?? null, tags: item.data?.tags ?? [], createdAt: fmt(item.createdAt) })),
}

const dreamRows = allItems.filter((item) => item.namespace === 'dream-run')
const runKey = (item) => {
  const key = String(item.key ?? '')
  if (key.startsWith('run:')) return key
  if (key.startsWith('skip:')) return key.replace(/^skip:/, 'run:').replace(/:skip$/, '')
  if (key.startsWith('fail:')) return key.replace(/^fail:/, 'run:').replace(/:fail$/, '')
  return key
}
const dreamGroups = new Map()
for (const item of dreamRows) {
  const key = runKey(item)
  if (!dreamGroups.has(key)) dreamGroups.set(key, [])
  dreamGroups.get(key).push(item)
}
const dreamDuplicateRuns = [...dreamGroups.entries()]
  .filter(([, list]) => list.filter((item) => String(item.key ?? '').startsWith('run:')).length > 1)
  .map(([key, list]) => ({
    key,
    entries: list.map((item) => ({ id: item.id, key: item.key, text: item.text, data: item.data, createdAt: fmt(item.createdAt) })),
  }))
const dreamSkipPairs = [...dreamGroups.entries()]
  .filter(([, list]) => list.some((item) => String(item.key ?? '').startsWith('run:')) && list.some((item) => String(item.key ?? '').startsWith('skip:')))
  .map(([key, list]) => ({ key, entries: list.map((item) => ({ id: item.id, key: item.key, createdAt: fmt(item.createdAt) })) }))
const dayRows = allItems.filter((item) => item.namespace === 'day')
const dayCoverage = {
  logs: dayRows.map((item) => ({ key: item.key, chars: String(item.text ?? '').length, createdAt: fmt(item.createdAt) })),
  dates: [...new Set(dayRows.map((item) => String(item.key ?? '').replace(/^day:/, '')))].sort(),
}

const eagerFile = path.resolve(arg('eager', path.join(stateDir, 'eager-recall.jsonl')))
const eagerRows = readJsonLines(eagerFile)
const eagerStats = {
  file: eagerFile,
  events: eagerRows.length,
  hits: eagerRows.reduce((sum, row) => sum + (Number(row.hits) || 0), 0),
  injected: eagerRows.reduce((sum, row) => sum + (Number(row.injected) || 0), 0),
  chars: eagerRows.reduce((sum, row) => sum + (Number(row.chars) || 0), 0),
  suppressed: eagerRows.reduce((sum, row) => sum + (Number(row.suppressed) || 0), 0),
}

const sessionEventsFile = path.resolve(arg('sessionEvents', path.join(stateDir, 'session-events.jsonl')))
const sessionRows = readJsonLines(sessionEventsFile)
const toolCalls = Object.fromEntries([...new Set(sessionRows.filter((row) => row.type === 'tool/call').map((row) => row.name ?? '?'))]
  .map((name) => [name, sessionRows.filter((row) => row.type === 'tool/call' && (row.name ?? '?') === name).length]))
const memoryToolCalls = Object.fromEntries(Object.entries(toolCalls).filter(([name]) => /^(recall|remember|forget|memo|memos|memo_|note_status|memory)/.test(name)))

const report = {
  generatedAt: new Date().toISOString(),
  source: { db: dbPath, eager: eagerFile, sessionEvents: sessionEventsFile },
  namespaces: namespaces.map((row) => ({ id: row.id, label: row.label, recallable: Boolean(row.recallable), halfLifeDays: Number(row.half_life_days), owner: row.owner })),
  tokens,
  event: { blocks: eventBlocks.length, duplicatePairs: eventDupes, byDay: tokens.byDay },
  person: { blocks: personBlocks, aliasCandidates: personAliases },
  recall,
  note: noteStats,
  lexicon: lexiconStats,
  dream: { runs: dreamRows.length, duplicateGroups: dreamDuplicateRuns, skipPairs: dreamSkipPairs, dayCoverage },
  eager: eagerStats,
  memoryToolCalls,
}

const lines = []
lines.push('# 记忆只读审计')
lines.push('')
lines.push(`- 生成：${report.generatedAt}`)
lines.push(`- 数据库：\`${dbPath}\``)
lines.push(`- 总条目：**${tokens.total}**`)
lines.push('')
lines.push('## 结构')
lines.push('')
lines.push('| namespace / kind | 数量 |')
lines.push('|---|---:|')
for (const row of tokens.byNamespace) lines.push(`| ${row.namespace} / ${row.kind} | ${row.c} |`)
lines.push('')
lines.push('## 关键信号')
lines.push('')
lines.push(`- event block：**${eventBlocks.length}**；近重复对：**${eventDupes.length}**`)
lines.push(`- person block：**${personBlocks.length}**；可疑 alias：**${personAliases.length}**`)
lines.push(`- lexicon：**${lexiconStats.total}**；工具/框架味：**${lexiconStats.toolish.length}**；候选：**${lexiconStats.candidates}**`)
lines.push(`- note：**${noteRows.length}**；自动查词 note：**${noteStats.autoQuestionNotes.length}**`)
lines.push(`- 有 recall 记录的记忆：**${recall.itemsWithRecall.length}**；最高 recall_count：**${recall.maxRecallCount}**`)
lines.push(`- eager：**${eagerStats.events}** 次，注入 **${eagerStats.injected}** 条，命中 **${eagerStats.hits}** 条`)
lines.push(`- dream 重复 run 组：**${dreamDuplicateRuns.length}**；run+skip 的旧账：**${dreamSkipPairs.length}**`)
lines.push('')
if (eventDupes.length) {
  lines.push('## 近重复 event block')
  lines.push('')
  for (const item of eventDupes.slice(0, 20)) lines.push(`- ${item.day}：#${item.a.id} ↔ #${item.b.id}（文本 ${item.similarity}，证据 ${item.evidenceSimilarity}）`)
  lines.push('')
}
if (personBlocks.length) {
  lines.push('## person block')
  lines.push('')
  for (const item of personBlocks) lines.push(`- #${item.id} ${item.key}：${String(item.text ?? '').slice(0, 160)}`)
  lines.push('')
}
if (personAliases.length) {
  lines.push('## 可疑 person alias')
  lines.push('')
  for (const item of personAliases) lines.push(`- ${item.a} ↔ ${item.b}（相似度 ${item.similarity}）`)
  lines.push('')
}
if (lexiconStats.toolish.length) {
  lines.push('## 工具/框架味 lexicon')
  lines.push('')
  for (const item of lexiconStats.toolish.slice(0, 40)) lines.push(`- #${item.id} ${item.term}`)
  lines.push('')
}
if (dreamDuplicateRuns.length) {
  lines.push('## dream 重复 run')
  lines.push('')
  for (const item of dreamDuplicateRuns.slice(0, 20)) lines.push(`- ${item.key}：${item.entries.map((entry) => `#${entry.id} ${entry.key}`).join(' / ')}`)
  lines.push('')
}
if (dreamSkipPairs.length) {
  lines.push('## dream run + skip（旧账/幂等痕迹）')
  lines.push('')
  for (const item of dreamSkipPairs.slice(0, 20)) lines.push(`- ${item.key}：${item.entries.map((entry) => `#${entry.id} ${entry.key}`).join(' / ')}`)
  lines.push('')
}
lines.push('## 说明')
lines.push('')
lines.push('- 这是只读审计；没有修改 memory.db。')
lines.push('- “近重复/工具味/alias”是启发式标记，不是最终判定；用于决定下一步抽 gold 样本。')
lines.push('- eager 的 hit 不等于有用；后续 replay 要按固定 query 集看命中质量。')

const md = lines.join('\n')
if (jsonOnly) {
  console.log(JSON.stringify(report, null, 2))
} else if (outDir) {
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'audit.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  fs.writeFileSync(path.join(outDir, 'audit.md'), `${md}\n`, 'utf8')
  console.log(path.join(outDir, 'audit.md'))
  console.log(path.join(outDir, 'audit.json'))
} else {
  console.log(md)
}
db.close()
