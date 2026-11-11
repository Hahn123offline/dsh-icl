#!/usr/bin/env node
// 离线记忆回放：固定 fixture → 临时 memory.db → dream → 结构/质量快照。
//
// 不写 live 状态。使用云端 chat provider（默认读 config/icl.local.json 的第一个 chat provider），
// 结果按 prompt hash 缓存到 <out>/cache.json；可重复跑而不重复付费。
//
// 用法：
//   node tools/memory-replay.mjs --fixture .state/lab/memory-fixture/latest --days 2026-11-09
//   node tools/memory-replay.mjs --fixture ... --days all --out .state/lab/memory-replay/run-1
//   node tools/memory-replay.mjs --fixture ... --cache-only
//
// 注意：这是审计工具，不是产品工具；不改 live DB，不注册到模型工具面。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createHost } from '../packages/core/src/index.mjs'
import * as memory from '../packages/plugins/memory/src/index.mjs'
import * as recall from '../packages/plugins/recall/src/index.mjs'
import * as note from '../packages/plugins/note/src/index.mjs'
import * as lexicon from '../packages/plugins/lexicon/src/index.mjs'
import * as dream from '../packages/plugins/dream/src/index.mjs'
import memoryManifest from '../packages/plugins/memory/manifest.json' with { type: 'json' }
import recallManifest from '../packages/plugins/recall/manifest.json' with { type: 'json' }
import noteManifest from '../packages/plugins/note/manifest.json' with { type: 'json' }
import lexiconManifest from '../packages/plugins/lexicon/manifest.json' with { type: 'json' }
import dreamManifest from '../packages/plugins/dream/manifest.json' with { type: 'json' }

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0) return process.argv[index + 1] ?? fallback
  const prefix = `--${name}=`
  const hit = process.argv.find((item) => item.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : fallback
}
const hasFlag = (name) => process.argv.includes(`--${name}`)

const fixtureDir = path.resolve(arg('fixture', path.join(REPO, '.state', 'lab', 'memory-fixture', 'latest')))
const outDir = path.resolve(arg('out', path.join(REPO, '.state', 'lab', 'memory-replay', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19))))
const onlyDays = String(arg('days', 'all')).split(',').map((x) => x.trim()).filter(Boolean)
const cacheOnly = hasFlag('cache-only')
const maxCalls = Math.max(1, Number(arg('max-calls', 80)) || 80)
const providerConfigFile = path.resolve(arg('providers', path.join(REPO, 'config', 'icl.local.json')))

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}
function readJsonLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean)
  } catch { return [] }
}
function dateAtNoonHK(date) {
  return Date.parse(`${date}T12:00:00+08:00`)
}
function dayOf(ms) { return new Date(Number(ms)).toLocaleDateString('sv-SE', { timeZone: 'Asia/Hong_Kong' }) }
function hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex') }
function truncate(value, max = 120) { const text = String(value ?? ''); return text.length > max ? `${text.slice(0, max - 1)}…` : text }

const manifest = readJson(path.join(fixtureDir, 'manifest.json'))
if (!manifest) {
  console.error(`fixture 缺少 manifest.json：${fixtureDir}`)
  process.exit(2)
}
const availableDays = Array.isArray(manifest.days) ? manifest.days : []
const days = onlyDays.includes('all') ? availableDays : availableDays.filter((day) => onlyDays.includes(day))
if (!days.length) {
  console.error(`没有匹配的日期：${onlyDays.join(',')}；fixture 有 ${availableDays.join(', ')}`)
  process.exit(2)
}

const providers = readJson(providerConfigFile)?.providers ?? []
const chat = providers.find((item) => String(item.kind ?? 'chat') === 'chat')
if (!chat) {
  console.error(`provider 文件里没有 chat provider：${providerConfigFile}`)
  process.exit(2)
}
const apiKey = chat.apiKeyEnv ? (process.env[chat.apiKeyEnv] ?? '') : (chat.apiKey ?? '')
if (!apiKey) {
  console.error(`chat provider ${chat.id} 缺少凭据（${chat.apiKeyEnv || 'apiKey'}）`)
  process.exit(2)
}
const baseUrl = String(chat.baseUrl ?? '').replace(/\/+$/, '')
const model = String(chat.model ?? 'deepseek-chat')

fs.mkdirSync(outDir, { recursive: true })
const cacheFile = path.join(outDir, 'cache.json')
const cache = readJson(cacheFile, {}) ?? {}
let calls = 0
let cacheHits = 0
const callLog = []

async function cloudCall({ messages, maxTokens = null }) {
  const prompt = JSON.stringify({ model, messages, maxTokens })
  const key = hash(prompt)
  if (cache[key]?.text) {
    cacheHits += 1
    return cache[key].text
  }
  if (cacheOnly) throw new Error(`cache-only：缺缓存 ${key.slice(0, 12)}`)
  if (calls >= maxCalls) throw new Error(`达到 max-calls=${maxCalls}`)
  calls += 1
  const body = {
    model,
    messages: (messages ?? []).map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.map((block) => block.text ?? '').join('') : String(m.content ?? '')),
    })),
    temperature: 0.2,
    ...(maxTokens ? { max_tokens: Number(maxTokens) } : {}),
  }
  callLog.push({ at: Date.now(), model, messages: body.messages.length, maxTokens })
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`云端 ${res.status}：${truncate(text, 300)}`)
  }
  const data = await res.json()
  const text = String(data?.choices?.[0]?.message?.content ?? '')
  if (!text.trim()) throw new Error('云端返回空内容')
  cache[key] = { text, model, at: Date.now() }
  fs.writeFileSync(cacheFile, `${JSON.stringify(cache, null, 2)}\n`, 'utf8')
  return text
}

function rawRows() {
  const out = []
  for (const day of days) {
    const file = path.join(fixtureDir, 'raw', `${day}.jsonl`)
    for (const row of readJsonLines(file)) {
      out.push({
        ...row,
        sender: String(row.role === 'user' ? '用户' : row.role === 'assistant' ? '我' : row.name || '工具'),
      })
    }
  }
  return out.sort((a, b) => Number(a.time) - Number(b.time) || Number(a.seq) - Number(b.seq))
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-memory-replay-'))
  const host = createHost({ log: () => {} })
  host.registerPlugin(memoryManifest, memory, { config: { root: tempRoot } })
  host.registerPlugin(recallManifest, recall, { config: { sessionId: 'replay' } })
  host.registerPlugin(noteManifest, note, {})
  host.registerPlugin(lexiconManifest, lexicon, {})
  host.registerPlugin(dreamManifest, dream, { config: { sessionId: 'replay', timezone: 'Asia/Hong_Kong', persona: fs.readFileSync(path.join(REPO, 'prompts', 'dream.md'), 'utf8') } })
  for (const id of ['memory', 'recall', 'note', 'lexicon', 'dream']) await host.enable(id)
  host.services.slots.bind('dream-chat', { provider: 'cloud', call: cloudCall })

  const rows = rawRows()
  host.services.raw.register({
    id: 'fixture',
    list: ({ since = 0, until = Infinity, limit = 2000 } = {}) => rows
      .filter((row) => Number(row.time) >= Number(since) && Number(row.time) < Number(until))
      .slice(0, Math.max(1, Number(limit) || 2000)),
    search: () => [],
  })

  const results = []
  for (const day of days) {
    const dayResult = await host.shared.get('dream').run({ now: dateAtNoonHK(day), jobs: ['wash', 'events', 'people', 'lexicon', 'consume', 'cleanup', 'index'] })
    results.push({ day, result: dayResult })
    fs.writeFileSync(path.join(outDir, 'replay.partial.json'), `${JSON.stringify({ days, results, calls, cacheHits }, null, 2)}\n`, 'utf8')
  }

  const mem = host.shared.get('memory')
  const exported = mem.exportAll?.() ?? { items: [] }
  const all = exported.items ?? []
  const snapshot = {
    generatedAt: new Date().toISOString(),
    fixture: fixtureDir,
    provider: { id: chat.id, model, baseUrl },
    days,
    calls,
    cacheHits,
    tempRoot,
    counts: all.reduce((acc, item) => {
      const key = `${item.namespace}/${item.kind}`
      acc[key] = (acc[key] ?? 0) + 1
      return acc
    }, {}),
    event: all.filter((item) => item.namespace === 'event' && item.kind === 'block').map((item) => ({ id: item.id, key: item.key, text: item.text, data: item.data, createdAt: item.createdAt })),
    person: all.filter((item) => item.namespace === 'person' && item.kind === 'block').map((item) => ({ id: item.id, key: item.key, text: item.text, data: item.data, createdAt: item.createdAt })),
    note: all.filter((item) => item.namespace === 'note').map((item) => ({ id: item.id, text: item.text, data: item.data, createdAt: item.createdAt })),
    lexicon: all.filter((item) => item.namespace === 'lexicon').map((item) => ({ id: item.id, key: item.key, text: item.text, data: item.data, createdAt: item.createdAt })),
    dreamRuns: all.filter((item) => item.namespace === 'dream-run').map((item) => ({ id: item.id, key: item.key, text: item.text, data: item.data, createdAt: item.createdAt })),
    results,
    callLog,
  }
  fs.writeFileSync(path.join(outDir, 'replay.json'), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  fs.writeFileSync(cacheFile, `${JSON.stringify(cache, null, 2)}\n`, 'utf8')
  console.log(outDir)
  console.log(JSON.stringify({ days, calls, cacheHits, counts: snapshot.counts }, null, 2))
  host.dispose?.()
}

main().catch((error) => {
  console.error(`replay 失败：${error instanceof Error ? error.stack ?? error.message : error}`)
  process.exit(1)
})
