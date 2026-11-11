#!/usr/bin/env node
// 导出记忆审计/回放 fixture：只读 live 文件，不修改状态。
//
// 产物：
//   <out>/manifest.json
//   <out>/days/<YYYY-MM-DD>.txt       dream wash 后的当天原话
//   <out>/raw/<YYYY-MM-DD>.jsonl      bridge 原文层（session-events 的分日副本）
//   <out>/current.json                当前记忆库的 event/person/note/lexicon 快照
//   <out>/gold.template.json          需要人工填写的 gold 样本模板
//
// 用法：
//   node tools/memory-fixture-export.mjs
//   node tools/memory-fixture-export.mjs --out .state/lab/memory-fixture/2026-11-11

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
const sessionFile = path.resolve(arg('sessionEvents', path.join(stateDir, 'session-events.jsonl')))
const eagerFile = path.resolve(arg('eager', path.join(stateDir, 'eager-recall.jsonl')))
const outDir = path.resolve(arg('out', path.join(process.cwd(), '.state', 'lab', 'memory-fixture', new Date().toISOString().slice(0, 10))))

const dayOf = (ms) => new Date(Number(ms)).toLocaleDateString('sv-SE', { timeZone: 'Asia/Hong_Kong' })
const fmt = (ms) => new Date(Number(ms)).toLocaleString('sv-SE', { timeZone: 'Asia/Hong_Kong' })
const readJsonLines = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean)
  } catch { return [] }
}

if (!fs.existsSync(dbPath)) {
  console.error(`找不到 memory.db：${dbPath}`)
  process.exit(2)
}
const db = new DatabaseSync(dbPath, { readOnly: true })
const all = db.prepare('SELECT * FROM mem_items ORDER BY id ASC').all().map((row) => {
  let data = null
  try { data = row.data ? JSON.parse(row.data) : null } catch { data = null }
  return {
    id: Number(row.id), namespace: row.namespace, kind: row.kind, key: row.key, text: row.text,
    data, weight: Number(row.weight), recallCount: Number(row.recall_count),
    lastRecalledAt: row.last_recalled_at == null ? null : Number(row.last_recalled_at),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  }
})

fs.mkdirSync(path.join(outDir, 'days'), { recursive: true })
fs.mkdirSync(path.join(outDir, 'raw'), { recursive: true })

const dayRows = all.filter((item) => item.namespace === 'day' && item.kind === 'log')
for (const item of dayRows) {
  const date = String(item.key ?? '').replace(/^day:/, '')
  fs.writeFileSync(path.join(outDir, 'days', `${date}.txt`), `${item.text ?? ''}\n`, 'utf8')
}

const sessionRows = readJsonLines(sessionFile)
const rawByDay = new Map()
for (const row of sessionRows) {
  const date = dayOf(row.time)
  if (!rawByDay.has(date)) rawByDay.set(date, [])
  rawByDay.get(date).push({
    sessionId: row.sessionId,
    seq: row.seq,
    time: row.time,
    role: row.role,
    type: row.type,
    name: row.name ?? '',
    text: row.text ?? '',
  })
}
for (const [date, rows] of rawByDay) {
  rows.sort((a, b) => Number(a.time) - Number(b.time) || Number(a.seq) - Number(b.seq))
  fs.writeFileSync(path.join(outDir, 'raw', `${date}.jsonl`), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
}

const current = {
  event: all.filter((item) => item.namespace === 'event' && item.kind === 'block'),
  person: all.filter((item) => item.namespace === 'person' && item.kind === 'block'),
  note: all.filter((item) => item.namespace === 'note'),
  lexicon: all.filter((item) => item.namespace === 'lexicon'),
  dreamRuns: all.filter((item) => item.namespace === 'dream-run'),
}
fs.writeFileSync(path.join(outDir, 'current.json'), `${JSON.stringify(current, null, 2)}\n`, 'utf8')

const days = [...new Set([...dayRows.map((item) => String(item.key).replace(/^day:/, '')), ...rawByDay.keys()])].sort()
const gold = {
  schema: 1,
  source: { db: dbPath, sessionEvents: sessionFile, eagerRecall: eagerFile },
  generatedAt: new Date().toISOString(),
  note: '人工填写：only 记值得留的事实/人物/未闭合问题；noise 记不该进记忆的项。每项尽量引用 raw 的 seq 或文本片段。',
  days: Object.fromEntries(days.map((day) => [day, {
    people: [],
    facts: [],
    events: [],
    unfinished: [],
    noise: [],
  }])),
}
fs.writeFileSync(path.join(outDir, 'gold.template.json'), `${JSON.stringify(gold, null, 2)}\n`, 'utf8')

const manifest = {
  generatedAt: new Date().toISOString(),
  source: { db: dbPath, sessionEvents: sessionFile, eagerRecall: eagerFile },
  counts: {
    all: all.length,
    days: dayRows.length,
    sessionRows: sessionRows.length,
    rawDays: rawByDay.size,
    eventBlocks: current.event.length,
    personBlocks: current.person.length,
    notes: current.note.length,
    lexicon: current.lexicon.length,
    dreamRuns: current.dreamRuns.length,
  },
  days,
  files: {
    days: 'days/<YYYY-MM-DD>.txt',
    raw: 'raw/<YYYY-MM-DD>.jsonl',
    current: 'current.json',
    gold: 'gold.template.json',
  },
  notes: [
    '本目录可整体拷走；不含 live DB 路径以外的依赖。',
    'current.json 是当前产出快照；gold.template.json 需要人工填写后才用于评分。',
    'raw 来自 bridge 原文层（session-events），包含 user/assistant/tool/result。',
  ],
}
fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
console.log(outDir)
console.log(JSON.stringify(manifest.counts, null, 2))
db.close()
