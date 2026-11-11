#!/usr/bin/env node
// 记忆评测素材构建器：三源真实对话导入 + 构造式合成场景生成 + fixture 校验。
//
// 契约：docs/MEMORY-EVAL-SPEC.md §3/§4/§5。产出必须能被 tools/memory-eval.mjs 装载：
//   node tools/memory-eval.mjs --fixture <dir> --mode all --model echo
//
// 用法：
//   node tools/memory-corpus.mjs import-focus-core [--out .state/lab/memory-corpus/real-focuscore-2026-10] [--force]
//   node tools/memory-corpus.mjs import-old-qq     [--out .state/lab/memory-corpus/real-qq-2026-10] [--force]
//   node tools/memory-corpus.mjs import-live       [--out .state/lab/memory-corpus/real-live-2026-11] [--force]
//   node tools/memory-corpus.mjs synthetic         [--only alias-and-people] [--refresh]
//   node tools/memory-corpus.mjs validate --fixture <dir|fixture.json>
//
// 纪律：
// - 真实源一律只读（node:sqlite readOnly），真实聊天只写 .state/lab/（gitignored），不提交、不碰 live state；
// - 提交的合成 fixture 只用占位身份（假 QQ 9000000000 段），validate 会扫描真实 QQ/人名泄漏；
// - LLM 调用全部按 prompt 哈希缓存到 .state/lab/corpus-build/llm-cache/，缓存与日志不含密钥。
//
// 模型：--model reasoner（默认，deepseek-reasoner）| cloud（deepseek-chat）| local（llama-swap）。
// 抽取侧评测模型是 cloud deepseek-chat；gold 草拟/合成生成默认用 reasoner（不同模型，降低自洽偏差）。
// 本地 27b 档（coder390-27b-q3-df2）本机当前因显存不足起不来，qwen35-9b 在 CPU 上 prompt 处理 ~68ms/token，
// 因此 --model local 仅作备用；细节见 .state/lab/memory-corpus/README.md。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LAB_ROOT = path.join(REPO_ROOT, '.state', 'lab')
const BUILD_DIR = path.join(LAB_ROOT, 'corpus-build')
const CACHE_DIR = path.join(BUILD_DIR, 'llm-cache')
const CORPUS_ROOT = path.join(LAB_ROOT, 'memory-corpus')
const SYNTHETIC_ROOT = path.join(REPO_ROOT, 'tools', 'fixtures', 'memory')
const HK_OFFSET_MS = 8 * 3600_000

const FOCUS_DB_DEFAULT = 'C:/DSH/qwenstuff/focus-core/state/focus.db'
const OLD_QQ_DB_DEFAULT = 'C:/DSH/qwenstuff/dsh-qq/state/memory.db'
const LIVE_SRC_DEFAULT = path.join(LAB_ROOT, 'memory-fixture', 'latest')
const OWNER_QQ_DEFAULT = '3429502459'
const SELF_QQ_DEFAULT = '2593621742'

const ROLES = ['user', 'assistant', 'tool', 'env', 'memory']
const SOURCES = ['human', 'agent_visible', 'agent_internal', 'tool', 'env', 'memory']
const SPEAKER_KINDS = ['owner', 'self', 'person', 'system', 'unknown']
const GOLD_TYPES = ['fact', 'preference', 'event', 'commitment', 'relationship', 'concept', 'person']
const PROBE_KINDS = ['recall', 'eager', 'person', 'overview']

// 真实身份令牌：只用于 validate 的隐私扫描（真实 fixture 允许出现但只报 warning；提交物出现即 error）。
const PRIVACY_TOKENS = [
  OWNER_QQ_DEFAULT, SELF_QQ_DEFAULT, '2173783633', '3862352984', '1057812765', '601357169',
  '周子涵', '曾嘉睿', '郑皓元', 'Hahn123', '离线版', '大肥鱼',
]

/* ── 通用小工具 ─────────────────────────────────────────────── */

function fatal(message, code = 2) {
  const error = new Error(message)
  error.exitCode = code
  throw error
}

function argValue(argv, name, fallback = null) {
  const index = argv.indexOf(`--${name}`)
  if (index >= 0) return argv[index + 1] ?? fallback
  const prefix = `--${name}=`
  const hit = argv.find((item) => item.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : fallback
}

function hasFlag(argv, name) {
  return argv.includes(`--${name}`)
}

function flagValue(argv, name, fallback = true) {
  if (hasFlag(argv, `no-${name}`)) return false
  if (hasFlag(argv, name)) return true
  return fallback
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  ensureDir(path.dirname(file))
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return file
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex')
}

function sha256File(file) {
  return sha256(fs.readFileSync(file))
}

function statSafe(file) {
  try {
    const st = fs.statSync(file)
    return { file, exists: true, size: st.size, mtime: new Date(st.mtimeMs).toISOString() }
  } catch {
    return { file, exists: false }
  }
}

function pad(value, width) {
  return String(value).padStart(width, '0')
}

function normalizeText(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/** 稳定的 JSON 打印/哈希用键（对象字段顺序不影响 hash）。 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/* ── 时间（Asia/Hong_Kong 固定 UTC+8，无夏令时） ─────────────── */

function ymdOf(ms) {
  return new Date(Number(ms) + HK_OFFSET_MS).toISOString().slice(0, 10)
}

function isoOf(ms) {
  const iso = new Date(Number(ms) + HK_OFFSET_MS).toISOString()
  return `${iso.slice(0, 19)}+08:00`
}

function hmOf(ms) {
  return new Date(Number(ms) + HK_OFFSET_MS).toISOString().slice(11, 16)
}

function msOfDayHm(day, hhmm) {
  const value = Date.parse(`${day}T${String(hhmm).length === 5 ? hhmm : '00:00'}:00+08:00`)
  if (!Number.isFinite(value)) fatal(`非法日期/时间：${day} ${hhmm}`)
  return value
}

function addDays(day, count) {
  const [year, month, date] = String(day).split('-').map(Number)
  const base = Date.UTC(year, month - 1, date)
  const next = new Date(base + count * 86_400_000)
  return next.toISOString().slice(0, 10)
}

function sortedDays(days) {
  return [...days].sort((a, b) => String(a).localeCompare(String(b)))
}

/* ── 文本分类 ───────────────────────────────────────────────── */

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/
const PLAN_WORDS_RE = /\b(?:think|thinking|let me|let's|I should|I'll|I will|I need|I want|I'm going to|I can|the user|user wants|respond|reply|keep it|keep short|keep this|maybe|probably|first,|next,|check|look at|actually)\b/i
const ENV_INJECT_PREFIXES = [
  'Current runtime context.',
  'This is an automatically generated checkpoint',
  'The following skills are available',
  '【环境',
  '【闹钟】',
  '【你自己定的事',
  '【心跳】',
  '（调试指令',
  '（系统调试',
  '（系统自检',
  '（系统自检，',
  '（自检',
  '（通道自检',
  '（诊断）',
]

function isCjkText(text) {
  return CJK_RE.test(String(text ?? ''))
}

/** 英文计划式内部文本：无 CJK 且含计划动词/第一人称意图（SPEC §4.1 启发式）。 */
function looksLikeAgentPlan(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed || isCjkText(trimmed)) return false
  if (trimmed.length <= 16) return false
  return PLAN_WORDS_RE.test(trimmed)
}

/** 判定一条 user 角色消息是否是环境/系统注入（不是真人说话）。 */
function isEnvInjectedUserText(text) {
  const trimmed = String(text ?? '').trimStart()
  if (!trimmed) return false
  return ENV_INJECT_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
}

/** 从 QQ 信封文本里尽量解析会话与发送者（live raw 用）。 */
function parseQQEnvelope(text) {
  const source = String(text ?? '')
  const result = { isEnvelope: false, channel: null, speakers: [], rawSenders: [] }
  if (!/QQ 还有没看过的消息|\[QQ私聊·|\[QQ群/.test(source)) return result
  result.isEnvelope = true
  const privateMatch = /私聊 (\d{5,12})(?:（|\(|\s|$)/.exec(source)
  const groupMatch = /群 (\d{5,12})(?:（|\(|\s|$)/.exec(source)
  if (privateMatch && !groupMatch) result.channel = `qq:private:${privateMatch[1]}`
  else if (groupMatch && !privateMatch) result.channel = `qq:group:${groupMatch[1]}`
  else if (privateMatch) result.channel = `qq:private:${privateMatch[1]}`
  else if (groupMatch) result.channel = `qq:group:${groupMatch[1]}`
  const qqMatches = [...source.matchAll(/（QQ(\d{5,12})）/g)].map((match) => match[1])
  result.rawSenders = [...new Set(qqMatches)]
  const nameMatches = [...source.matchAll(/· #\d+ ([^（(：:\n]+?)（QQ\d{5,12}）/g)].map((match) => match[1].trim())
  result.speakers = [...new Set(nameMatches)]
  return result
}

/* ── LLM 适配（reasoner / cloud / local，全部按 prompt 哈希缓存） ── */

const LLM_PROVIDERS = {
  reasoner: { id: 'reasoner', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-reasoner', keyEnv: 'DEEPSEEK_API_KEY', disableThinking: false },
  cloud: { id: 'cloud', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', keyEnv: 'DEEPSEEK_API_KEY', disableThinking: false },
  local: { id: 'local', baseUrl: process.env.LOCAL_LLM_BASE || 'http://127.0.0.1:8088/v1', model: process.env.LOCAL_LLM_MODEL || 'qwen35-9b', keyEnv: null, disableThinking: true },
}

function resolveApiKey(envName) {
  if (!envName) return null
  if (process.env[envName]) return process.env[envName]
  // 从 Windows 用户环境变量兜底（不打印、不落盘）。
  try {
    const output = execSync(`reg query "HKCU\\Environment" /v ${envName}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 })
    const match = /REG_(?:SZ|EXPAND_SZ)\s+(.+)\s*$/m.exec(output)
    return match ? match[1].trim() : null
  } catch {
    return null
  }
}

function llmProvider(id) {
  const provider = LLM_PROVIDERS[id]
  if (!provider) fatal(`未知 --model：${id}（可选 ${Object.keys(LLM_PROVIDERS).join('|')}）`)
  return provider
}

function cacheFileFor(model, payloadHash) {
  return path.join(CACHE_DIR, `${model}-${payloadHash.slice(0, 24)}.json`)
}

/**
 * 调一次 chat completion，结果按 (model+messages+maxTokens) 哈希缓存。
 * @returns {{content:string, usage:object|null, cached:boolean, model:string}}
 */
async function llmChat(providerId, messages, options = {}) {
  const provider = llmProvider(providerId)
  const maxTokens = Math.max(64, Number(options.maxTokens ?? 3000))
  const cacheOnly = Boolean(options.cacheOnly)
  const refresh = Boolean(options.refresh)
  const key = sha256(canonicalJson({ model: provider.model, messages, maxTokens }))
  const cacheFile = cacheFileFor(provider.id, key)
  if (!refresh && fs.existsSync(cacheFile)) {
    try {
      const cached = readJson(cacheFile)
      if (cached?.content) return { content: cached.content, usage: cached.usage ?? null, cached: true, model: provider.model }
    } catch { /* 缓存损坏则重新请求 */ }
  }
  if (cacheOnly) fatal(`--cache-only 但缓存未命中：${provider.id} ${path.basename(cacheFile)}`)

  const apiKey = resolveApiKey(provider.keyEnv)
  if (provider.keyEnv && !apiKey) {
    fatal(`缺少 ${provider.keyEnv}（设成进程环境变量后再跑：$env:DEEPSEEK_API_KEY=[Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY','User')）`)
  }
  // reasoner 的思维链也占 max_tokens，预算不足会只回思维链、正文为空；默认给足。
  const body = { model: provider.model, messages, max_tokens: providerId === 'reasoner' ? Math.max(maxTokens, 4096) : maxTokens, stream: false }
  if (providerId !== 'reasoner') body.temperature = Number(options.temperature ?? 0)
  if (provider.disableThinking) body.chat_template_kwargs = { enable_thinking: false }
  const headers = { 'content-type': 'application/json' }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`

  let lastError = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), Number(options.timeoutMs ?? 180_000))
      let response
      try {
        response = await fetch(`${provider.baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal })
      } finally {
        clearTimeout(timer)
      }
      const text = await response.text()
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`)
      const parsed = JSON.parse(text)
      const choice = parsed.choices?.[0]
      let content = String(choice?.message?.content ?? '')
      if (!content.trim() && choice?.message?.reasoning_content) {
        // 正文为空通常是思维链吃满了 max_tokens：先尝试从思维链尾部抠答案，失败则放大预算重试。
        const guess = extractJson(String(choice.message.reasoning_content))
        if (guess != null) content = JSON.stringify(guess)
        else {
          body.max_tokens = Math.min(16384, Math.max(4096, Math.round(Number(body.max_tokens) * 2)))
          throw new Error(`reasoner 只返回了思维链（finish_reason=${choice?.finish_reason ?? '?'}），已放大 max_tokens 重试`)
        }
      }
      if (!content.trim()) throw new Error(`空响应（finish_reason=${choice?.finish_reason ?? '?'}）`)
      const record = {
        model: provider.model,
        promptSha256: key,
        maxTokens,
        createdAt: new Date().toISOString(),
        usage: parsed.usage ?? null,
        content,
      }
      ensureDir(CACHE_DIR)
      fs.writeFileSync(cacheFile, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
      return { content, usage: parsed.usage ?? null, cached: false, model: provider.model }
    } catch (error) {
      lastError = error
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1500 * attempt))
    }
  }
  fatal(`LLM 调用失败（${providerId}）：${String(lastError?.message ?? lastError)}`)
}

/** 从模型输出里抠出第一个合法 JSON 值（容忍 ```json 围栏、前后缀解释）。 */
function extractJson(text) {
  const source = String(text ?? '')
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(source)
  const candidates = []
  if (fenced) candidates.push(fenced[1])
  candidates.push(source)
  for (const candidate of candidates) {
    for (const opener of ['{', '[']) {
      const start = candidate.indexOf(opener)
      if (start < 0) continue
      const close = opener === '{' ? '}' : ']'
      let depth = 0
      let inString = false
      let escaped = false
      for (let index = start; index < candidate.length; index += 1) {
        const char = candidate[index]
        if (inString) {
          if (escaped) escaped = false
          else if (char === '\\') escaped = true
          else if (char === '"') inString = false
          continue
        }
        if (char === '"') { inString = true; continue }
        if (char === opener) depth += 1
        else if (char === close) {
          depth -= 1
          if (depth === 0) {
            const slice = candidate.slice(start, index + 1)
            try { return JSON.parse(slice) } catch { break }
          }
        }
      }
    }
  }
  return null
}

async function llmJson(providerId, messages, options = {}) {
  const result = await llmChat(providerId, messages, options)
  const parsed = extractJson(result.content)
  if (parsed == null) {
    const retryMessages = [
      ...messages,
      { role: 'assistant', content: result.content.slice(0, 2000) },
      { role: 'user', content: '上面的输出不是合法 JSON。请只输出合法 JSON（不要解释、不要 markdown 围栏），保持同样的字段结构。' },
    ]
    const retry = await llmChat(providerId, retryMessages, options)
    const reparsed = extractJson(retry.content)
    if (reparsed == null) fatal(`模型输出无法解析为 JSON：${result.content.slice(0, 400)}`)
    return { value: reparsed, usage: retry.usage, cached: result.cached && retry.cached, model: retry.model }
  }
  return { value: parsed, usage: result.usage, cached: result.cached, model: result.model }
}

/* ── fixture 构造与校验 ─────────────────────────────────────── */

function actorBlock(name, ids, aliases) {
  return { name: String(name), ids: ids.map((value) => ({ kind: 'qq', value: String(value) })), ...(aliases?.length ? { aliases: [...aliases] } : {}) }
}

function entityBlock({ id, kind, name, aliases = [], ids = [], importance = 3 }) {
  return {
    id: String(id),
    kind: String(kind),
    name: String(name),
    ...(aliases.length ? { aliases: [...new Set(aliases.map(String))] } : {}),
    ...(ids.length ? { ids: ids.map((value) => ({ kind: 'qq', value: String(value) })) } : {}),
    importance,
  }
}

function rowBlock({ id, at, role, channel, speaker, text, source, visible }) {
  return { id, at, role, channel, speaker, text: normalizeText(text), source, visible }
}

function makeFixture(fields) {
  const fixture = {
    schema: 1,
    id: fields.id,
    kind: fields.kind,
    description: fields.description,
    goldSource: fields.goldSource ?? (fields.kind === 'synthetic' ? 'constructed' : 'draft'),
    timezone: fields.timezone ?? 'Asia/Hong_Kong',
    persona: fields.persona,
    days: fields.days,
    gold: fields.gold,
    probes: fields.probes ?? [],
  }
  return fixture
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function isTimezone(value) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: String(value) }); return true } catch { return false }
}

/**
 * 内置校验：结构 + 引用完整性 + 隐私扫描，口径对齐 tools/memory-eval/fixture.mjs
 * 与 tools/fixtures/memory/schemas/fixture.schema.json。
 */
function validateFixtureObject(fixture, options = {}) {
  const errors = []
  const warnings = []
  const push = (list, where, message) => list.push({ path: where, message })
  if (!fixture || typeof fixture !== 'object') return { ok: false, errors: [{ path: '$', message: '不是对象' }], warnings, stats: null }

  if (fixture.schema !== 1) push(errors, '$.schema', '必须是 1')
  if (!ID_PATTERN.test(String(fixture.id ?? ''))) push(errors, '$.id', `id 不合规：${fixture.id}`)
  if (!['real', 'synthetic'].includes(fixture.kind)) push(errors, '$.kind', 'kind 必须是 real|synthetic')
  if (!isTimezone(fixture.timezone)) push(errors, '$.timezone', `非法时区：${fixture.timezone}`)
  if (!fixture.description) push(warnings, '$.description', '缺 description')
  for (const [role, actor] of [['self', fixture.persona?.self], ['owner', fixture.persona?.owner]]) {
    if (!actor) { push(errors, `$.persona.${role}`, '缺少 persona'); continue }
    if (!String(actor.name ?? '').trim()) push(errors, `$.persona.${role}.name`, 'name 为空')
    if (!Array.isArray(actor.ids) || !actor.ids.length) push(warnings, `$.persona.${role}.ids`, '没有 ids')
    for (const id of actor.ids ?? []) {
      if (!id?.kind || !String(id.value ?? '').trim()) push(errors, `$.persona.${role}.ids`, '身份需要 kind+value')
    }
  }

  const rowsById = new Map()
  const days = Array.isArray(fixture.days) ? fixture.days : []
  if (!days.length) push(errors, '$.days', '至少 1 天')
  const daySet = new Set()
  const sources = {}
  const roles = {}
  let rowCount = 0
  for (const day of days) {
    const dayKey = String(day?.day ?? '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) push(errors, `$.days[${dayKey}]`, 'day 必须是 YYYY-MM-DD')
    if (daySet.has(dayKey)) push(errors, `$.days[${dayKey}]`, '日期重复')
    daySet.add(dayKey)
    if (!Array.isArray(day?.rows) || !day.rows.length) { push(warnings, `$.days[${dayKey}]`, '这一天没有行'); continue }
    for (const row of day.rows) {
      rowCount += 1
      const where = `$.days[${dayKey}].rows[${row?.id}]`
      if (!String(row?.id ?? '').trim()) push(errors, where, 'row.id 为空')
      if (rowsById.has(String(row?.id))) push(errors, where, `row id 重复：${row.id}`)
      rowsById.set(String(row?.id), { row, day: dayKey })
      if (!ROLES.includes(row?.role)) push(errors, where, `role 非法：${row?.role}`)
      if (!SOURCES.includes(row?.source)) push(errors, where, `source 非法：${row?.source}`)
      if (!SPEAKER_KINDS.includes(row?.speaker?.kind)) push(errors, where, `speaker.kind 非法：${row?.speaker?.kind}`)
      if (typeof row?.speaker?.value !== 'string') push(errors, where, 'speaker.value 必须是字符串')
      if (typeof row?.text !== 'string' || !row.text.trim()) push(errors, where, 'text 为空')
      if (typeof row?.channel !== 'string' || !row.channel.trim()) push(errors, where, 'channel 为空')
      if (typeof row?.visible !== 'boolean') push(errors, where, 'visible 必须是 boolean')
      if (row?.role !== 'assistant' && row?.visible !== true) push(errors, where, '非 assistant 行必须 visible=true')
      const atMs = Date.parse(String(row?.at ?? ''))
      if (!Number.isFinite(atMs)) push(errors, where, `at 不是合法 ISO：${row?.at}`)
      else if (ymdOf(atMs) !== dayKey) push(errors, `${where}.at`, `at=${row.at} 属于 ${ymdOf(atMs)}，与 day=${dayKey} 不符`)
      sources[String(row?.source)] = (sources[String(row?.source)] ?? 0) + 1
      roles[String(row?.role)] = (roles[String(row?.role)] ?? 0) + 1
    }
  }

  const entities = Array.isArray(fixture.gold?.entities) ? fixture.gold.entities : []
  const memories = Array.isArray(fixture.gold?.memories) ? fixture.gold.memories : []
  const noise = Array.isArray(fixture.gold?.noise) ? fixture.gold.noise : []
  if (!Array.isArray(fixture.gold?.entities)) push(errors, '$.gold.entities', '必须是数组')
  if (!Array.isArray(fixture.gold?.memories)) push(errors, '$.gold.memories', '必须是数组')
  if (!Array.isArray(fixture.gold?.noise)) push(errors, '$.gold.noise', '必须是数组')

  const entityById = new Map()
  const entityIdBySubject = new Map()
  for (const entity of entities) {
    const where = `$.gold.entities[${entity?.id}]`
    if (!String(entity?.id ?? '').trim()) push(errors, where, 'entity.id 为空')
    if (entityById.has(String(entity?.id))) push(errors, where, 'entity id 重复')
    entityById.set(String(entity.id), entity)
    if (!String(entity?.kind ?? '').trim()) push(errors, where, 'entity.kind 为空')
    if (!String(entity?.name ?? '').trim()) push(errors, where, 'entity.name 为空')
    entityIdBySubject.set(String(entity.id), String(entity.id))
    for (const id of entity.ids ?? []) {
      if (!id?.kind || !String(id.value ?? '').trim()) push(errors, where, 'entity.ids 项需要 kind+value')
      else { entityIdBySubject.set(`person:${id.value}`, String(entity.id)); entityIdBySubject.set(String(id.value), String(entity.id)) }
    }
  }

  const memoryById = new Map()
  const memoryTypeCounts = {}
  for (const memory of memories) {
    const where = `$.gold.memories[${memory?.id}]`
    if (!String(memory?.id ?? '').trim()) push(errors, where, 'memory.id 为空')
    if (memoryById.has(String(memory?.id))) push(errors, where, 'memory id 重复')
    memoryById.set(String(memory.id), memory)
    if (!GOLD_TYPES.includes(memory?.type)) push(errors, where, `type 非法：${memory?.type}`)
    else memoryTypeCounts[memory.type] = (memoryTypeCounts[memory.type] ?? 0) + 1
    const subject = String(memory?.subject ?? '')
    if (!subject) push(errors, where, 'subject 为空')
    else if (subject.startsWith('person:') && !entityIdBySubject.has(subject)) push(errors, `${where}.subject`, `subject 指向不存在的 entity：${subject}`)
    else if (!subject.startsWith('person:') && !['self'].includes(subject) && !subject.startsWith('group:') && !subject.startsWith('topic:') && !entityIdBySubject.has(subject)) {
      push(warnings, `${where}.subject`, `subject 不在 entity 表里：${subject}`)
    }
    if (memory?.type === 'person' && !subject.startsWith('person:')) push(errors, `${where}.subject`, 'person 类型 subject 必须是 person:<entityId>')
    if (!String(memory?.text ?? '').trim()) push(errors, `${where}.text`, 'text 为空')
    const importance = Number(memory?.importance)
    if (!Number.isFinite(importance) || importance < 1 || importance > 5) push(warnings, `${where}.importance`, `importance 建议 1–5：${memory?.importance}`)
    const evidence = Array.isArray(memory?.evidence) ? memory.evidence : []
    if (!evidence.length) {
      if (fixture.kind !== 'synthetic') push(errors, `${where}.evidence`, '真实 fixture 的 gold 必须有证据行')
      else if (String(memory?.note ?? '') !== 'negative') push(warnings, `${where}.evidence`, '证据为空')
    }
    for (const rowId of evidence) {
      const hit = rowsById.get(String(rowId))
      if (!hit) push(errors, `${where}.evidence`, `证据行不存在：${rowId}`)
      else if (hit.day !== String(memory?.validFrom ?? hit.day) && memory?.validFrom) {
        // validFrom 允许是首条证据的日期；仅当明确不一致且早于证据时提示
        if (String(memory.validFrom) > hit.day) push(warnings, `${where}.validFrom`, `validFrom=${memory.validFrom} 晚于证据行日期 ${hit.day}`)
      }
    }
    if (memory?.invalidatedBy != null && !memoryById.has(String(memory.invalidatedBy))) {
      // 允许先引用后定义：最后统一检查
    }
  }
  for (const memory of memories) {
    if (memory?.invalidatedBy != null && !memoryById.has(String(memory.invalidatedBy))) {
      push(errors, `$.gold.memories[${memory.id}].invalidatedBy`, `引用了不存在的 memory：${memory.invalidatedBy}`)
    }
  }

  const goldEmpty = memories.length === 0
  if (goldEmpty) push(warnings, '$.gold.memories', 'goldEmpty:true（不参与 P/R）')

  for (const entry of noise) {
    const rowIds = Array.isArray(entry?.rowIds) ? entry.rowIds : []
    if (!rowIds.length) push(errors, `$.gold.noise[${entry?.reason}]`, 'rowIds 为空')
    if (!String(entry?.reason ?? '').trim()) push(errors, `$.gold.noise[${entry?.reason}]`, 'reason 为空')
    for (const rowId of rowIds) if (!rowsById.has(String(rowId))) push(errors, `$.gold.noise[${entry?.reason}]`, `noise 行不存在：${rowId}`)
  }

  const probes = Array.isArray(fixture.probes) ? fixture.probes : []
  if (!probes.length) push(errors, '$.probes', '至少需要 1 个 probe（schema 要求）')
  const probeIds = new Set()
  const probeKinds = {}
  for (const probe of probes) {
    const where = `$.probes[${probe?.id}]`
    if (!String(probe?.id ?? '').trim()) push(errors, where, 'probe.id 为空')
    if (probeIds.has(String(probe?.id))) push(errors, where, 'probe id 重复')
    probeIds.add(String(probe?.id))
    if (!PROBE_KINDS.includes(probe?.kind)) push(errors, where, `kind 非法：${probe?.kind}`)
    else probeKinds[probe.kind] = (probeKinds[probe.kind] ?? 0) + 1
    const hit = rowsById.get(String(probe?.rowId))
    if (!hit) push(errors, `${where}.rowId`, `探针行不存在：${probe?.rowId}`)
    for (const field of ['expectedMemoryIds', 'expectedAny', 'mustNotRecall']) {
      for (const memoryId of probe?.[field] ?? []) {
        const memory = memoryById.get(String(memoryId))
        if (!memory) { push(errors, `${where}.${field}`, `引用了不存在的 gold memory：${memoryId}`); continue }
        // mustNotRecall 是负向期望，不要求证据发生在探针之前。
        if (field !== 'mustNotRecall' && hit && Array.isArray(memory.evidence) && memory.evidence.length) {
          const maxEvidenceMs = Math.max(...memory.evidence.map((rowId) => Date.parse(rowsById.get(String(rowId))?.row?.at ?? '')).filter(Number.isFinite))
          const probeMs = Date.parse(String(hit.row?.at ?? ''))
          if (Number.isFinite(maxEvidenceMs) && Number.isFinite(probeMs) && probeMs < maxEvidenceMs) {
            push(warnings, where, `探针时刻早于期望记忆的证据时刻（${probe.id} / ${memoryId}）`)
          }
        }
      }
    }
    if (probe?.kind === 'person' && !String(probe?.query ?? '').trim()) push(errors, `${where}.query`, 'person 探针需要 query')
    const expectedCount = [...(probe?.expectedMemoryIds ?? []), ...(probe?.expectedAny ?? [])].length
    if (!expectedCount && probe?.kind !== 'overview' && !String(probe?.note ?? '').includes('empty-ok')) {
      push(warnings, where, '没有 expectedMemoryIds/expectedAny（falseInjectionRate 口径）')
    }
  }

  // 隐私扫描：真实 fixture 只提示；提交物（synthetic 或路径在 tools/ 下）出现真实身份即错误。
  const haystack = JSON.stringify(fixture)
  const leaked = PRIVACY_TOKENS.filter((token) => haystack.includes(token))
  if (leaked.length) {
    if (fixture.kind === 'synthetic' || options.committed) {
      push(errors, '$.privacy', `提交物含真实身份令牌：${leaked.join(', ')}`)
    } else {
      push(warnings, '$.privacy', `真实 fixture 含真实身份（预期内，仅 .state/lab）：${leaked.join(', ')}`)
    }
  }

  const stats = {
    id: fixture.id,
    kind: fixture.kind,
    days: days.length,
    dayList: sortedDays(daySet),
    rows: rowCount,
    sources,
    roles,
    entities: entities.length,
    goldMemories: memories.length,
    goldTypes: memoryTypeCounts,
    goldEmpty,
    noiseEntries: noise.length,
    noiseRows: noise.reduce((sum, entry) => sum + (entry?.rowIds?.length ?? 0), 0),
    probes: probes.length,
    probeKinds,
    privacyLeaked: leaked,
  }
  return { ok: errors.length === 0, errors, warnings, stats }
}

/** 优先用 eval-harness 的权威 loader（同一份 schema + 完整性检查）；不可用时退回内置校验。 */
async function validateFixtureFile(input, options = {}) {
  const target = path.resolve(input)
  const file = fs.existsSync(target) && fs.statSync(target).isDirectory() ? path.join(target, 'fixture.json') : target
  if (!fs.existsSync(file)) fatal(`fixture 不存在：${file}`)
  let fixture = null
  try { fixture = readJson(file) } catch (error) { fatal(`fixture 不是合法 JSON：${file}（${error.message}）`) }
  const committed = options.committed ?? (path.resolve(file).startsWith(REPO_ROOT) && !path.resolve(file).startsWith(LAB_ROOT))
  const local = validateFixtureObject(fixture, { committed })
  const report = { file, ok: local.ok, errors: [...local.errors], warnings: [...local.warnings], stats: local.stats, authoritative: null }
  try {
    const loaderPath = path.join(REPO_ROOT, 'tools', 'memory-eval', 'fixture.mjs')
    if (fs.existsSync(loaderPath)) {
      const module = await import(`file://${loaderPath.replace(/\\/g, '/')}`)
      const loaded = module.loadFixture(file)
      report.authoritative = { ok: loaded.ok, errors: loaded.errors ?? [], warnings: loaded.warnings ?? [] }
      if (!loaded.ok) {
        report.ok = false
        report.errors.push(...(loaded.errors ?? []).map((entry) => ({ path: `[eval-harness] ${entry.path}`, message: entry.message })))
      }
      for (const warning of loaded.warnings ?? []) report.warnings.push({ path: `[eval-harness] ${warning.path}`, message: warning.message })
    }
  } catch (error) {
    report.warnings.push({ path: '$', message: `eval-harness loader 不可用，仅内置校验：${String(error?.message ?? error)}` })
  }
  return report
}

/* ── 行分类（三源共用口径，SPEC §4/§5） ─────────────────────── */

function envRowReason(text) {
  const trimmed = String(text ?? '').trimStart()
  if (trimmed.startsWith('Current runtime context.')) return 'runtime-context'
  if (trimmed.startsWith('This is an automatically generated checkpoint')) return 'compaction-checkpoint'
  if (trimmed.startsWith('The following skills are available')) return 'skill-catalog'
  if (trimmed.startsWith('【心跳】')) return 'heartbeat'
  if (trimmed.startsWith('【环境')) return 'env-injection'
  if (trimmed.startsWith('【闹钟】')) return 'alarm'
  if (trimmed.startsWith('【你自己定的事')) return 'self-goal-reminder'
  if (/^（调试指令|^（系统调试|^（系统自检|^（自检|^（通道自检|^（诊断）/u.test(trimmed)) return 'injected-probe'
  return 'env'
}

/**
 * 把"数据源原始消息"规范成 fixture row（不含 row.id，id 统一在合并后分配）。
 * @returns {{row:object, meta:object}|null}
 */
function makeRowFromMessage({ text, role, channel, speaker, sourceOverride = null, visibleOverride = null }) {
  const cleanText = normalizeText(text)
  if (!cleanText.trim()) return null
  let source = sourceOverride
  let visible = visibleOverride
  if (!source) {
    if (role === 'user') source = isEnvInjectedUserText(cleanText) ? 'env' : 'human'
    else if (role === 'assistant') source = looksLikeAgentPlan(cleanText) ? 'agent_internal' : 'agent_visible'
    else if (role === 'tool') source = 'tool'
    else source = 'env'
  }
  if (visible == null) visible = role !== 'assistant' ? true : source === 'agent_visible'
  if (role !== 'assistant') visible = true
  const resolvedSpeaker = speaker ?? (role === 'assistant' ? { kind: 'self', value: '' } : { kind: 'system', value: 'system' })
  return { row: { at: null, role, channel, speaker: resolvedSpeaker, text: cleanText, source, visible }, meta: {} }
}

/** 合并多来源行：按时间排序、分配稳定 row id、按天分组。 */
function assembleDays(entries, { idPrefix = 'r' } = {}) {
  const sorted = [...entries].sort((a, b) => a.atMs - b.atMs || a.order - b.order)
  const days = []
  const dayMap = new Map()
  sorted.forEach((entry, index) => {
    const id = `${idPrefix}-${pad(index + 1, 4)}`
    entry.row.id = id
    entry.row.at = isoOf(entry.atMs)
    const day = ymdOf(entry.atMs)
    if (!dayMap.has(day)) {
      const block = { day, rows: [] }
      dayMap.set(day, block)
      days.push(block)
    }
    dayMap.get(day).rows.push(entry.row)
  })
  days.sort((a, b) => a.day.localeCompare(b.day))
  return { days, sortedIds: sorted.map((entry) => ({ rowId: entry.row.id, atMs: entry.atMs, row: entry.row, meta: entry.meta })) }
}

/* ── 真实源：focus-core ─────────────────────────────────────── */

function openReadOnlyDb(file) {
  if (!fs.existsSync(file)) fatal(`找不到数据库（只读源）：${file}`)
  return new DatabaseSync(file, { readOnly: true })
}

function resolveSpeaker({ raw, peopleByQq, peopleByName, aliasByQq, oldNameToQq, ownerQq, selfQq }) {
  const value = String(raw ?? '').trim()
  if (!value) return { kind: 'unknown', value: '' }
  let qq = null
  if (/^\d{5,12}$/.test(value)) {
    qq = value
    if (aliasByQq.has(qq)) qq = aliasByQq.get(qq)
  } else {
    qq = peopleByName.get(value) ?? oldNameToQq.get(value) ?? null
  }
  if (qq && qq === selfQq) return { kind: 'self', value: selfQq }
  if (qq && qq === ownerQq) return { kind: 'owner', value: ownerQq }
  if (qq) return { kind: 'person', value: qq }
  if (/^\d{5,12}$/.test(value)) {
    if (value === selfQq) return { kind: 'self', value: selfQq }
    if (value === ownerQq) return { kind: 'owner', value: ownerQq }
    return { kind: 'person', value }
  }
  return { kind: 'person', value }
}

function buildPeopleMaps({ db, ownerQq, selfQq }) {
  const people = db.prepare('SELECT * FROM people').all()
  const peopleByQq = new Map()
  const peopleByName = new Map()
  for (const person of people) {
    if (person.qq) peopleByQq.set(String(person.qq), { qq: String(person.qq), name: String(person.name ?? '') })
    if (person.name) peopleByName.set(String(person.name), String(person.qq ?? ''))
  }
  const aliasByQq = new Map()
  let aliases = []
  try { aliases = db.prepare('SELECT * FROM people_alias').all() } catch { aliases = [] }
  for (const alias of aliases) if (alias.qq && alias.alias_of) aliasByQq.set(String(alias.qq), String(alias.alias_of))
  // 旧 dsh-qq 库 persons 作为"显示名 → QQ"的跨源解析兜底（只读、只用于 speaker 映射）。
  const oldNameToQq = new Map()
  try {
    if (fs.existsSync(OLD_QQ_DB_DEFAULT)) {
      const oldDb = new DatabaseSync(OLD_QQ_DB_DEFAULT, { readOnly: true })
      try {
        for (const person of oldDb.prepare('SELECT qq, name FROM persons').all()) {
          if (person.name && person.qq) oldNameToQq.set(String(person.name), String(person.qq))
        }
      } finally { oldDb.close() }
    }
  } catch { /* 跨源兜底可选 */ }
  const principals = db.prepare('SELECT * FROM principals').all()
  const ownerPrincipal = principals.find((item) => item.kind === 'owner') ?? null
  const ownerName = String(ownerPrincipal?.display_name ?? '主人')
  return { peopleByQq, peopleByName, aliasByQq, oldNameToQq, ownerName, principals, ownerQq, selfQq }
}

/** 从 rows 里收集某真人 QQ 的别名证据（发消息时用的显示名）。 */
function collectAliasesForQq({ entries, qq }) {
  const aliases = new Set()
  for (const entry of entries) {
    if (entry.meta?.rawSenderName && entry.meta?.rawSenderQq === qq) aliases.add(String(entry.meta.rawSenderName))
    if (entry.row?.speaker?.kind === 'person' && entry.row.speaker.value === qq && entry.meta?.rawSenderName) aliases.add(String(entry.meta.rawSenderName))
  }
  return [...aliases]
}

function buildPersona(ownerQq, selfQq, ownerName, ownerAliases) {
  return {
    self: actorBlock('鱼鱼', [selfQq]),
    owner: actorBlock(ownerName || '主人', [ownerQq], ownerAliases),
  }
}

/** gold 为空/调试模式下的哨兵探针：只测 falseInjectionRate，保证 schema 的 probes≥1。 */
function sentinelProbe(days) {
  for (let dayIndex = days.length - 1; dayIndex >= 0; dayIndex -= 1) {
    const rows = days[dayIndex].rows
    for (let rowIndex = rows.length - 1; rowIndex >= 0; rowIndex -= 1) {
      if (rows[rowIndex].source === 'human') {
        return [{ id: 'p-01', rowId: rows[rowIndex].id, query: '你还记得最近发生过什么吗？', kind: 'recall', expectedMemoryIds: [], expectAnswer: '', note: 'empty-ok：gold 为空时的哨兵探针' }]
      }
    }
  }
  return []
}

/** 自动构造实体表：self + owner + 对话中出现的真人；aliases/ids 从 people/alias/旧库交叉。 */
function buildRealEntities({ ownerQq, selfQq, ownerName, ownerAliases, peopleByQq, aliasByQq, extraQqs = [], extraNames = new Map(), oldPersons = [] }) {
  const entities = []
  entities.push(entityBlock({ id: 'self', kind: 'self', name: '鱼鱼', ids: [selfQq], importance: 4 }))
  const ownerIds = new Set([ownerQq, ...[...aliasByQq.entries()].filter(([, target]) => target === ownerQq).map(([qq]) => qq)])
  entities.push(entityBlock({ id: `person:${ownerQq}`, kind: 'person', name: ownerName || '主人', ids: [...ownerIds], aliases: ownerAliases, importance: 5 }))
  const seen = new Set([ownerQq, selfQq])
  for (const qq of extraQqs) {
    if (!qq || seen.has(String(qq))) continue
    seen.add(String(qq))
    const person = peopleByQq.get(String(qq))
    const oldPerson = oldPersons.find((item) => String(item.qq) === String(qq)) ?? null
    const name = oldPerson?.name || person?.name || extraNames.get(String(qq)) || String(qq)
    const aliases = []
    for (const [aliasQq, target] of aliasByQq.entries()) if (String(target) === String(qq) && aliasQq !== String(qq)) aliases.push(aliasQq)
    if (oldPerson?.name && oldPerson.name !== name) aliases.push(oldPerson.name)
    entities.push(entityBlock({ id: `person:${qq}`, kind: 'person', name, ids: [qq], aliases, importance: person?.level === 'talked' ? 4 : 3 }))
  }
  // 旧库 persons 里出现但本对话没有发过言的，不建实体（避免无证据档案）。
  return entities
}

async function cmdImportFocusCore(argv) {
  const dbPath = path.resolve(argValue(argv, 'db', FOCUS_DB_DEFAULT))
  const outDir = path.resolve(argValue(argv, 'out', path.join(CORPUS_ROOT, 'real-focuscore-2026-10')))
  const ownerQq = String(argValue(argv, 'owner-qq', OWNER_QQ_DEFAULT))
  const selfQq = String(argValue(argv, 'self-qq', SELF_QQ_DEFAULT))
  const force = hasFlag(argv, 'force')
  const writeRaw = flagValue(argv, 'raw', true)
  const goldMode = String(argValue(argv, 'gold', 'draft')) // draft | none
  const goldModel = String(argValue(argv, 'model', 'reasoner'))
  const refresh = hasFlag(argv, 'refresh')
  const cacheOnly = hasFlag(argv, 'cache-only')
  const goldDays = argValue(argv, 'gold-days') ? String(argValue(argv, 'gold-days')).split(',').map((item) => item.trim()).filter(Boolean) : null
  if (fs.existsSync(path.join(outDir, 'fixture.json')) && !force) fatal(`输出已存在（加 --force 覆盖）：${outDir}`)

  const db = openReadOnlyDb(dbPath)
  const dbStat = statSafe(dbPath)
  const started = new Date().toISOString()
  try {
    const maps = buildPeopleMaps({ db, ownerQq, selfQq })
    const activities = new Map(db.prepare('SELECT id, title, kind, transport FROM activities').all().map((item) => [String(item.id), item]))
    const messageRows = db.prepare('SELECT * FROM messages ORDER BY ts ASC, id ASC').all()
    const qqRows = db.prepare('SELECT * FROM qq_messages ORDER BY at ASC, id ASC').all()
    const referenceMemories = db.prepare('SELECT * FROM memories ORDER BY id ASC').all()

    const entries = []
    let order = 0
    const envCounts = {}
    let envRows = 0
    for (const message of messageRows) {
      const activity = String(message.activity ?? '')
      const channel = activity.startsWith('qq:') ? activity : 'web'
      const role = String(message.role ?? 'user')
      let speaker
      if (role === 'assistant') speaker = { kind: 'self', value: selfQq }
      else if (role === 'user') speaker = { kind: 'owner', value: ownerQq }
      else speaker = { kind: 'system', value: 'system' }
      const built = makeRowFromMessage({ text: message.text, role, channel, speaker })
      if (!built) continue
      if (built.row.source === 'env') {
        built.row.speaker = { kind: 'system', value: 'system' }
        envRows += 1
        const reason = envRowReason(message.text)
        envCounts[reason] = (envCounts[reason] ?? 0) + 1
      }
      entries.push({ atMs: Number(message.ts), order: order += 1, row: built.row, meta: { origin: 'focus.messages', srcId: Number(message.id), activity, reason: built.row.source === 'env' ? envRowReason(message.text) : null } })
    }
    for (const qqMessage of qqRows) {
      const activity = String(qqMessage.activity ?? '')
      const channel = activity.startsWith('qq:') ? activity : 'web'
      const rawSender = String(qqMessage.sender ?? '')
      const speaker = resolveSpeaker({ raw: rawSender, ...maps })
      const isSelf = speaker.kind === 'self'
      const role = isSelf ? 'assistant' : 'user'
      const built = makeRowFromMessage({ text: qqMessage.text, role, channel, speaker, sourceOverride: isSelf ? 'agent_visible' : 'human', visibleOverride: true })
      if (!built) continue
      entries.push({
        atMs: Number(qqMessage.at),
        order: order += 1,
        row: built.row,
        meta: { origin: 'focus.qq_messages', srcId: Number(qqMessage.id), activity, rawSender, rawSenderName: maps.peopleByQq.get(speaker.value)?.name ?? rawSender, qqId: qqMessage.qq_id ?? null },
      })
    }

    const ownerAliases = new Set([maps.ownerName])
    for (const item of referenceMemories) {
      const text = String(item.text ?? '')
      for (const name of ['周子涵', 'Hahn123', '离线版']) if (text.includes(name)) ownerAliases.add(name)
    }
    for (const [qq, target] of maps.aliasByQq.entries()) if (String(target) === ownerQq) ownerAliases.add(String(qq))
    ownerAliases.delete('')
    const extraQqs = [...new Set(entries.map((entry) => entry.row.speaker?.kind === 'person' ? entry.row.speaker.value : null).filter((value) => /^\d{5,12}$/.test(String(value ?? ''))))]
    const entities = buildRealEntities({
      ownerQq, selfQq, ownerName: maps.ownerName, ownerAliases: [...ownerAliases], peopleByQq: maps.peopleByQq,
      aliasByQq: maps.aliasByQq, extraQqs,
    })
    const assembled = assembleDays(entries)
    const rowIndex = new Map(assembled.sortedIds.map((item) => [item.rowId, item]))

    // 参考记忆按天切片：供 gold 草拟交叉核对（旧系统 summary/person，不是真值）。
    const referenceByDay = new Map()
    for (const memory of referenceMemories) {
      const fromMs = Number(memory.from_ts ?? 0)
      const toMs = Number(memory.to_ts ?? 0)
      const text = String(memory.text ?? '')
      if (!text.trim()) continue
      const candidateDays = new Set()
      if (Number.isFinite(fromMs) && fromMs > 0) {
        const start = ymdOf(fromMs)
        const end = toMs > 0 ? ymdOf(toMs) : start
        let cursor = start
        let guard = 0
        while (cursor <= end && guard < 20) { candidateDays.add(cursor); cursor = addDays(cursor, 1); guard += 1 }
      }
      for (const day of candidateDays) {
        if (!referenceByDay.has(day)) referenceByDay.set(day, [])
        referenceByDay.get(day).push({ kind: String(memory.kind), text: text.slice(0, 400) })
      }
    }

    let gold = { entities: [], memories: [], noise: [] }
    let probes = []
    const warnings = []
    if (goldMode === 'draft') {
      const goldDraft = await draftRealGold({
        fixtureId: 'real-focuscore-2026-10',
        persona: buildPersona(ownerQq, selfQq, maps.ownerName, [...ownerAliases]),
        entities,
        days: assembled.days,
        referenceByDay,
        goldModel, refresh, cacheOnly,
        maxMemoriesPerDay: 8,
        dayList: goldDays ?? assembled.days.map((day) => day.day),
        warnings,
      })
      gold = goldDraft.gold
      const probeDraft = await draftRealProbes({ fixtureId: 'real-focuscore-2026-10', gold, days: assembled.days, entities, goldModel, refresh, cacheOnly, warnings })
      probes = probeDraft.probes
    } else {
      warnings.push('gold=none：fixture 无 gold/probes，仅用于结构调试')
      probes = sentinelProbe(assembled.days)
    }

    const fixture = makeFixture({
      id: 'real-focuscore-2026-10',
      kind: 'real',
      description: '旧 focus-core 真实对话（dsh 会话 + QQ 私聊/群），2026-10-27..2026-10-31；原始来源只读导入，gold 为 LLM 草拟待抽审。',
      goldSource: 'draft',
      persona: buildPersona(ownerQq, selfQq, maps.ownerName, [...ownerAliases]),
      days: assembled.days,
      gold,
      probes,
    })
    const validation = validateFixtureObject(fixture, { committed: false })
    if (!validation.ok) {
      for (const error of validation.errors) console.error(`  ❌ ${error.path}: ${error.message}`)
      fatal(`导入结果未通过内置校验（${validation.errors.length} 个错误）`)
    }
    ensureDir(outDir)
    writeJson(path.join(outDir, 'fixture.json'), fixture)
    if (writeRaw) {
      const rawDir = ensureDir(path.join(outDir, 'raw'))
      const byDay = new Map()
      for (const item of assembled.sortedIds) {
        const day = ymdOf(item.atMs)
        if (!byDay.has(day)) byDay.set(day, [])
        byDay.get(day).push({
          rowId: item.rowId,
          at: item.row.at,
          origin: item.meta.origin,
          srcId: item.meta.srcId,
          activity: item.meta.activity,
          rawSender: item.meta.rawSender ?? null,
          role: item.row.role,
          channel: item.row.channel,
          speaker: item.row.speaker,
          source: item.row.source,
          visible: item.row.visible,
          text: item.row.text,
        })
      }
      for (const [day, rows] of byDay.entries()) {
        fs.writeFileSync(path.join(rawDir, `${day}.jsonl`), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
      }
    }
    const build = {
      schema: 1,
      fixtureId: fixture.id,
      kind: 'real',
      generatedAt: new Date().toISOString(),
      startedAt: started,
      generator: 'tools/memory-corpus.mjs import-focus-core',
      source: { db: dbStat, ownerQq, selfQq },
      filters: {
        messages: 'role=user→human（runtime-context/checkpoint/环境注入/自检指令→env）；role=assistant→agent_visible（空文本或纯英文计划式→agent_internal,visible=false）',
        qqMessages: '按 activity 映射 channel；sender 经 people/people_alias/旧 persons 解析 speaker；self→assistant',
        envReasons: envCounts,
      },
      counts: {
        messages: messageRows.length,
        qqMessages: qqRows.length,
        importedRows: assembled.sortedIds.length,
        days: assembled.days.length,
        rowsBySource: validation.stats.sources,
        envRows,
        goldMemories: gold.memories.length,
        goldEntities: gold.entities.length,
        probes: probes.length,
        referenceMemories: referenceMemories.length,
      },
      referenceMemories: referenceMemories.map((item) => ({ id: Number(item.id), kind: item.kind, text: String(item.text ?? '').slice(0, 200) })),
      entityCatalog: entities,
      goldModel: goldMode === 'draft' ? goldModel : null,
      warnings,
      rowIdMap: assembled.sortedIds.map((item) => ({ rowId: item.rowId, origin: item.meta.origin, srcId: item.meta.srcId })),
    }
    writeJson(path.join(outDir, 'build.json'), build)
    console.log(`focus-core fixture：${path.join(outDir, 'fixture.json')}`)
    console.log(JSON.stringify({ counts: build.counts, warnings: warnings.length, validator: validation.errors.length }, null, 2))
  } finally {
    db.close()
  }
}

/* ── 真实 gold 草拟（focus-core / old-qq / live 共用） ───────── */

const GOLD_DRAFT_SYSTEM = `你是中文记忆评测的 gold 标注员，只输出合法 JSON。

任务：从某一天的对话原始行里，草拟"值得长期记住"的 gold 记忆（事实/偏好/事件/承诺/关系/人物档案）与噪声标注。
原则：
1. 只记人类会长期记住的内容：主人/朋友的事实、偏好、关系、共同经历、承诺、未结事项；不记寒暄、一次性玩笑、工具名、调试步骤、代码细节、系统状态。
2. 每条记忆必须给 evidence：只能引用下面给出的 row id，且这些行必须真的支持这条记忆。没有证据就不要写。
3. subject 只能从"允许的实体"里选（person:<entityId> / self / group:<gid> / topic:<英文slug>）。写人物档案时 type=person、subject 必须 person:<entityId>。
4. 不要编造输入里没有的私人信息；不确定的细节不要写。importance 1–5（5=最重要）。
5. 中文写 text，一句话说清"谁/什么/何时/多重要"，不要抄整段原文。
6. 输出 JSON：{"memories":[{...}]}，最多 {maxMemories} 条；宁缺毋滥。`

function goldRowLine(item) {
  const row = item.row
  const clipped = row.text.length > 260 ? `${row.text.slice(0, 140)}…${row.text.slice(-110)}` : row.text
  return `[${item.rowId}] ${row.at} ${row.role}/${row.source} speaker=${row.speaker.kind}:${row.speaker.value} · ${clipped.replace(/\n/g, ' / ')}`
}

function goldCandidateEntries(day, { maxVisible = 40 } = {}) {
  const candidates = []
  for (const row of day.rows) {
    if (row.source === 'human') candidates.push({ rowId: row.id, row })
  }
  let visibleCount = 0
  for (const row of day.rows) {
    if (row.source !== 'agent_visible') continue
    if (visibleCount >= maxVisible) break
    visibleCount += 1
    candidates.push({ rowId: row.id, row })
  }
  candidates.sort((a, b) => Date.parse(a.row.at) - Date.parse(b.row.at))
  return candidates
}

async function draftGoldDay({ fixtureId, day, persona, entities, reference, goldModel, refresh, cacheOnly, maxMemories }) {
  const candidateEntries = goldCandidateEntries(day)
  if (!candidateEntries.length) return []
  const entityLines = entities.map((entity) => {
    const ids = (entity.ids ?? []).map((id) => id.value).join(',')
    const aliases = (entity.aliases ?? []).join(',')
    return `- ${entity.id} | ${entity.kind} | name=${entity.name}${ids ? ` | qq=${ids}` : ''}${aliases ? ` | aliases=${aliases}` : ''}`
  }).join('\n')
  const referenceText = reference?.length
    ? reference.map((item, index) => `[R${index + 1}] (${item.kind}) ${item.text}`).join('\n')
    : '（无）'
  const rowsText = candidateEntries.map(goldRowLine).join('\n')
  const messages = [
    { role: 'system', content: GOLD_DRAFT_SYSTEM.replace('{maxMemories}', String(maxMemories)) },
    { role: 'user', content: `fixture: ${fixtureId}；日期：${day.day}
persona：self=${persona.self.name}（qq ${persona.self.ids[0]?.value ?? ''}）；owner=${persona.owner.name}（qq ${persona.owner.ids[0]?.value ?? ''}；aliases=${(persona.owner.aliases ?? []).join(',')}）
允许的实体（subject 只能用这些 id）：
${entityLines}

旧系统记忆参考（非真值，只用于核对人物/别名；不要照抄）：
${referenceText}

当天候选行（只允许引用这些 row id 作为 evidence）：
${rowsText}

请草拟当天的 gold memories（0–${maxMemories} 条）。输出 JSON：{"memories":[{"type":"fact|preference|event|commitment|relationship|person","subject":"...","text":"...","importance":1-5,"evidence":["r-0001"],"validFrom":"${day.day}","note":"草拟理由（短）"}]}` },
  ]
  const result = await llmJson(goldModel, messages, { maxTokens: 2400, refresh, cacheOnly })
  const memories = Array.isArray(result.value?.memories) ? result.value.memories : []
  const out = []
  for (const memory of memories) {
    const type = String(memory?.type ?? '')
    const subject = String(memory?.subject ?? '')
    const text = String(memory?.text ?? '').trim()
    const evidence = (Array.isArray(memory?.evidence) ? memory.evidence : []).map(String)
    if (!GOLD_TYPES.includes(type) || !subject || !text || !evidence.length) continue
    out.push({ type, subject, text, importance: Number(memory.importance), evidence, validFrom: String(memory.validFrom ?? day.day), note: String(memory.note ?? '') })
  }
  return out
}

function normalizeForDedup(text) {
  return String(text ?? '').toLowerCase().replace(/[\s，。！？,.!?、；;：:"'“”‘’（）()【】\[\]·—…-]/g, '')
}

function bigramSet(text) {
  const normalized = normalizeForDedup(text)
  const set = new Set()
  for (let index = 0; index + 1 < normalized.length; index += 1) set.add(normalized.slice(index, index + 2))
  return set
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0
  let intersection = 0
  for (const item of a) if (b.has(item)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

/**
 * 对逐日草拟结果做统一后处理：合法性、去重、稳定 id、validFrom、invalidatedBy、实体表合并。
 */
function finalizeDraftGold({ entities, perDayMemories, rowIndex, noise, fixtureKind }) {
  const warnings = []
  const accepted = []
  for (const [day, memories] of perDayMemories.entries()) {
    for (const memory of memories) {
      const evidence = memory.evidence.filter((rowId) => rowIndex.has(rowId))
      if (!evidence.length) { warnings.push(`丢弃无有效证据的记忆（${day}）：${memory.text.slice(0, 60)}`); continue }
      if (memory.subject.startsWith('person:')) {
        const subjectQq = memory.subject.slice('person:'.length)
        const matched = entities.find((entity) => entity.id === memory.subject || (entity.ids ?? []).some((id) => String(id.value) === subjectQq))
        if (!matched) { warnings.push(`丢弃未知 person subject 的记忆（${day}）：${memory.subject}`); continue }
      }
      accepted.push({ ...memory, day })
    }
  }
  // 去重：同 type+subject 且文本 bigram Jaccard ≥0.8 的保留更早/证据更多的。
  const deduped = []
  for (const memory of accepted) {
    const grams = bigramSet(memory.text)
    const duplicateIndex = deduped.findIndex((existing) => existing.type === memory.type && existing.subject === memory.subject && jaccard(bigramSet(existing.text), grams) >= 0.8)
    if (duplicateIndex >= 0) {
      if (memory.evidence.length > deduped[duplicateIndex].evidence.length) deduped[duplicateIndex] = memory
      continue
    }
    deduped.push(memory)
  }
  // 稳定排序：按天、证据行时间、文本。
  deduped.sort((a, b) => {
    const dayCompare = String(a.validFrom ?? a.day).localeCompare(String(b.validFrom ?? b.day))
    if (dayCompare) return dayCompare
    const aFirst = rowIndex.get(a.evidence[0])?.atMs ?? 0
    const bFirst = rowIndex.get(b.evidence[0])?.atMs ?? 0
    return aFirst - bFirst || a.text.localeCompare(b.text)
  })
  const memories = deduped.map((memory, index) => {
    const validFrom = /^\d{4}-\d{2}-\d{2}$/.test(String(memory.validFrom)) ? String(memory.validFrom) : memory.day
    const rowIds = memory.evidence.filter((rowId) => rowIndex.has(rowId))
    return {
      id: `m-${pad(index + 1, 4)}`,
      type: memory.type,
      subject: memory.subject,
      text: memory.text,
      importance: Number.isFinite(memory.importance) ? Math.min(5, Math.max(1, Math.round(memory.importance))) : 3,
      evidence: rowIds,
      validFrom,
      invalidatedBy: null,
      note: memory.note ? String(memory.note).slice(0, 160) : (fixtureKind === 'real' ? 'LLM 草拟，待 Lead 抽审' : '构造 gold'),
    }
  })
  return { memories, warnings }
}

/** 真实源 gold 草拟总控：逐天调 LLM → 校验/去重 → 人物档案补全。 */
async function draftRealGold({ fixtureId, persona, entities, days, referenceByDay, goldModel, refresh, cacheOnly, maxMemoriesPerDay = 8, dayList = null, warnings = [], daysWithRows = null }) {
  const rowIndex = new Map()
  for (const day of days) for (const row of day.rows) rowIndex.set(row.id, { atMs: Date.parse(row.at), at: row.at, row, day: day.day })
  const perDayMemories = new Map()
  const wantedDays = dayList ?? days.map((day) => day.day)
  for (const day of days) {
    if (!wantedDays.includes(day.day)) continue
    if (daysWithRows && !daysWithRows.includes(day.day)) continue
    const draft = await draftGoldDay({
      fixtureId, day, persona, entities, reference: referenceByDay.get(day.day) ?? [], goldModel, refresh, cacheOnly, maxMemories: maxMemoriesPerDay,
    })
    if (draft.length) perDayMemories.set(day.day, draft)
    console.log(`  gold 草拟 ${day.day}：${draft.length} 条`)
  }
  const noise = buildNoiseEntries(days)
  const finalized = finalizeDraftGold({ entities, perDayMemories, rowIndex, noise, fixtureKind: 'real' })
  warnings.push(...finalized.warnings)
  return { gold: { entities, memories: finalized.memories, noise }, rowIndex }
}

const NOISE_REASON_BY_SOURCE = { env: 'env', tool: 'tool-output', agent_internal: 'agent-plan', memory: 'memory-injected' }

function buildNoiseEntries(days) {
  const byReason = new Map()
  for (const day of days) {
    for (const row of day.rows) {
      const reason = NOISE_REASON_BY_SOURCE[row.source]
      if (!reason) continue
      if (!byReason.has(reason)) byReason.set(reason, [])
      byReason.get(reason).push(row.id)
    }
  }
  const noise = []
  for (const [reason, rowIds] of byReason.entries()) {
    for (let index = 0; index < rowIds.length; index += 200) {
      noise.push({ rowIds: rowIds.slice(index, index + 200), reason, note: '非人类主材料（env/tool/agent_internal），不应形成可回忆记忆' })
    }
  }
  return noise
}

/** 真实源 probes 草拟：从 gold 反推问题，探针时刻放在证据之后。 */
/**
 * probes 后处理：overview 不带 query；探针时刻必须晚于期望记忆的最后证据行，
 * 否则用"证据之后最早的人类消息行"替换（真实源探针由 LLM 草拟，时刻对齐是确定性的）。
 */
function finalizeRealProbes({ probes, gold, days, warnings }) {
  const rows = []
  for (const day of days) for (const row of day.rows) rows.push({ id: row.id, atMs: Date.parse(row.at), source: row.source, role: row.role })
  rows.sort((a, b) => a.atMs - b.atMs)
  const rowById = new Map(rows.map((row) => [row.id, row]))
  const humanRows = rows.filter((row) => row.source === 'human' && row.role === 'user')
  const memoryById = new Map(gold.memories.map((memory) => [memory.id, memory]))
  let adjusted = 0
  const out = probes.map((probe) => {
    const fixed = { ...probe }
    if (fixed.kind === 'overview') fixed.query = ''
    const evidenceTimes = []
    for (const memoryId of [...(fixed.expectedMemoryIds ?? []), ...(fixed.expectedAny ?? [])]) {
      const memory = memoryById.get(String(memoryId))
      for (const rowId of memory?.evidence ?? []) {
        const row = rowById.get(String(rowId))
        if (row) evidenceTimes.push(row.atMs)
      }
    }
    const current = rowById.get(String(fixed.rowId))
    if (current && evidenceTimes.length) {
      const maxEvidenceMs = Math.max(...evidenceTimes)
      if (current.atMs < maxEvidenceMs) {
        const candidate = humanRows.find((row) => row.atMs > maxEvidenceMs) ?? humanRows[humanRows.length - 1]
        if (candidate) { fixed.rowId = candidate.id; adjusted += 1 }
      }
    }
    return fixed
  })
  if (adjusted) warnings.push(`probes 时刻对齐：${adjusted} 个探针改到证据之后的人类消息行`)
  return out
}

async function draftRealProbes({ fixtureId, gold, days, entities, goldModel, refresh, cacheOnly, warnings = [] }) {
  const memories = gold.memories
  if (!memories.length) {
    const lastRow = days[days.length - 1]?.rows?.[days[days.length - 1].rows.length - 1]
    return {
      probes: lastRow ? [{ id: 'p-01', rowId: lastRow.id, query: '你还记得最近发生过什么吗？', kind: 'recall', expectedMemoryIds: [], expectAnswer: '', note: 'empty-ok：gold 为空时的哨兵探针' }] : [],
    }
  }
  const rowIndex = new Map()
  for (const day of days) for (const row of day.rows) rowIndex.set(row.id, { row, day: day.day })
  const memoryLines = memories.map((memory) => {
    const lastEvidence = memory.evidence[memory.evidence.length - 1]
    const last = rowIndex.get(lastEvidence)
    return `- ${memory.id} | ${memory.type} | ${memory.subject} | 证据最后时刻=${last?.day ?? '?'} | ${memory.text.slice(0, 130)}`
  }).join('\n')
  // 候选探针时刻：人类消息行（越晚越好），最多 80 个。
  const candidateRows = []
  for (const day of days) for (const row of day.rows) if (row.source === 'human' && row.role === 'user') candidateRows.push({ rowId: row.id, at: row.at, day: day.day, text: row.text.slice(0, 60) })
  const candidates = candidateRows.slice(-40)
  const messages = [
    { role: 'system', content: '你是记忆评测出题人，只输出合法 JSON。根据给定的 gold 记忆和候选探针时刻，写出 6–10 个检索探针。' },
    { role: 'user', content: `fixture: ${fixtureId}
gold memories（expectedMemoryIds 只能引用这些 id）：
${memoryLines}

候选探针时刻（rowId 必须是其中一个；探针会在该行之后施加，所问内容应已发生）：
${candidates.map((item) => `- ${item.rowId} | ${item.at} | ${item.text}`).join('\n')}

要求：
- 6–10 个 probe；kind=recall（直接问事实/偏好/事件）或 person（问某人是谁，query 写 QQ 号或名字）或 eager（间接提示）；至少 1 个 kind=person 或 1 个 overview；
- expectedMemoryIds 指向上面列出的 gold id（可多个）；expectAnswer 用中文给一句期望答案；mustNotRecall 可选（明显错误的旧值）；
- 至少 1 个 probe 的 expectedMemoryIds 为空且 note 写 "empty-ok"（测 falseInjectionRate）；
- 只输出 JSON：{"probes":[{"id":"p-01","rowId":"r-0001","query":"...","kind":"recall","expectedMemoryIds":["m-0001"],"expectAnswer":"...","mustNotRecall":[],"note":""}]}` },
  ]
  try {
    const result = await llmJson(goldModel, messages, { maxTokens: 8000, refresh, cacheOnly })
    const rawProbes = Array.isArray(result.value?.probes) ? result.value.probes : []
    const memoryIds = new Set(memories.map((memory) => memory.id))
    const probes = []
    for (const probe of rawProbes) {
      const rowId = String(probe?.rowId ?? '')
      if (!rowIndex.has(rowId)) continue
      const expected = (Array.isArray(probe?.expectedMemoryIds) ? probe.expectedMemoryIds : []).filter((id) => memoryIds.has(String(id)))
      const kind = PROBE_KINDS.includes(probe?.kind) ? probe.kind : 'recall'
      const query = String(probe?.query ?? '').trim()
      if (!query && kind !== 'overview') continue
      probes.push({
        id: `p-${pad(probes.length + 1, 2)}`,
        rowId,
        query,
        kind,
        expectedMemoryIds: expected,
        ...(probe?.expectedAny?.length ? { expectedAny: probe.expectedAny.filter((id) => memoryIds.has(String(id))) } : {}),
        ...(probe?.expectAnswer ? { expectAnswer: String(probe.expectAnswer) } : {}),
        ...(probe?.mustNotRecall?.length ? { mustNotRecall: probe.mustNotRecall.filter((id) => memoryIds.has(String(id))) } : {}),
        note: String(probe?.note ?? ''),
      })
    }
    // 兜底：模型没给出空期望探针时补一个。
    if (probes.length && !probes.some((probe) => !probe.expectedMemoryIds.length && !(probe.expectedAny ?? []).length)) {
      const last = days[days.length - 1]
      const row = [...last.rows].reverse().find((item) => item.source === 'human') ?? last.rows[last.rows.length - 1]
      probes.push({ id: `p-${pad(probes.length + 1, 2)}`, rowId: row.id, query: '鱼鱼最近在折腾什么项目？', kind: 'recall', expectedMemoryIds: [], expectAnswer: '', note: 'empty-ok：falseInjectionRate 哨兵' })
    }
    if (probes.length >= 3) return { probes: finalizeRealProbes({ probes, gold, days, warnings }) }
    warnings.push(`probes 草拟只得到 ${probes.length} 个，使用确定性兜底`)
  } catch (error) {
    warnings.push(`probes 草拟失败：${String(error?.message ?? error)}`)
  }
  // 兜底：按 gold 记忆逐条造 recall probe，探针时刻用最后一天的人类行。
  const lastDay = days[days.length - 1]
  const fallbackRow = [...lastDay.rows].reverse().find((row) => row.source === 'human') ?? lastDay.rows[lastDay.rows.length - 1]
  const probes = memories.slice(0, 8).map((memory, index) => ({
    id: `p-${pad(index + 1, 2)}`,
    rowId: fallbackRow?.id,
    query: `你还记得这件事吗：${memory.text.slice(0, 40)}`,
    kind: 'recall',
    expectedMemoryIds: [memory.id],
    expectAnswer: memory.text.slice(0, 60),
    note: '确定性兜底探针',
  }))
  return { probes: finalizeRealProbes({ probes, gold, days, warnings }) }
}

/* ── 真实源：old dsh-qq / live raw / 合成场景 ─────────────────── */

/* ── 真实源：old dsh-qq ──────────────────────────────────────── */

function convKeyToChannel(convKey) {
  const key = String(convKey ?? '')
  if (key.startsWith('group:')) return `qq:group:${key.slice('group:'.length)}`
  if (key.startsWith('private:')) return `qq:private:${key.slice('private:'.length)}`
  return 'web'
}

function overlapDays(fromMs, toMs) {
  const days = []
  if (!Number.isFinite(fromMs) || fromMs <= 0) return days
  const start = ymdOf(Math.min(fromMs, toMs > 0 ? toMs : fromMs))
  const end = ymdOf(Math.max(fromMs, toMs > 0 ? toMs : fromMs))
  let cursor = start
  let guard = 0
  while (cursor <= end && guard < 30) { days.push(cursor); cursor = addDays(cursor, 1); guard += 1 }
  return days
}

async function cmdImportOldQq(argv) {
  const dbPath = path.resolve(argValue(argv, 'db', OLD_QQ_DB_DEFAULT))
  const outDir = path.resolve(argValue(argv, 'out', path.join(CORPUS_ROOT, 'real-qq-2026-10')))
  const ownerQq = String(argValue(argv, 'owner-qq', OWNER_QQ_DEFAULT))
  const selfQq = String(argValue(argv, 'self-qq', SELF_QQ_DEFAULT))
  const force = hasFlag(argv, 'force')
  const writeRaw = flagValue(argv, 'raw', true)
  const goldMode = String(argValue(argv, 'gold', 'draft'))
  const goldModel = String(argValue(argv, 'model', 'reasoner'))
  const refresh = hasFlag(argv, 'refresh')
  const cacheOnly = hasFlag(argv, 'cache-only')
  const goldDays = argValue(argv, 'gold-days') ? String(argValue(argv, 'gold-days')).split(',').map((item) => item.trim()).filter(Boolean) : null
  if (fs.existsSync(path.join(outDir, 'fixture.json')) && !force) fatal(`输出已存在（加 --force 覆盖）：${outDir}`)

  const db = openReadOnlyDb(dbPath)
  const dbStat = statSafe(dbPath)
  try {
    const conversations = new Map(db.prepare('SELECT * FROM conversations').all().map((item) => [String(item.key), item]))
    const persons = db.prepare('SELECT * FROM persons').all()
    const summaries = db.prepare('SELECT * FROM summaries ORDER BY from_ts ASC').all()
    const personByQq = new Map()
    const personByName = new Map()
    for (const person of persons) {
      if (person.qq) personByQq.set(String(person.qq), { qq: String(person.qq), name: String(person.name ?? '') })
      if (person.name) personByName.set(String(person.name), String(person.qq ?? ''))
    }
    const rows = db.prepare('SELECT * FROM messages ORDER BY ts ASC, id ASC').all()
    const entries = []
    let order = 0
    const ownerAliases = new Set([...personByName.entries()].filter(([, qq]) => qq === ownerQq).map(([name]) => name))
    for (const message of rows) {
      const convKey = String(message.conv_key ?? '')
      const channel = convKeyToChannel(convKey)
      const isSelf = Number(message.is_self) === 1
      const role = isSelf ? 'assistant' : 'user'
      const rawSenderId = String(message.sender_id ?? '')
      const rawSenderName = String(message.sender ?? '')
      let speaker
      if (isSelf) speaker = { kind: 'self', value: selfQq }
      else speaker = resolveSpeaker({ raw: rawSenderId, peopleByQq: personByQq, peopleByName: personByName, aliasByQq: new Map(), oldNameToQq: new Map(), ownerQq, selfQq })
      if (!isSelf && (rawSenderId === ownerQq || /周子涵|Hahn123|离线版/.test(rawSenderName))) {
        speaker = { kind: 'owner', value: ownerQq }
        for (const name of rawSenderName.split(/[（(]/)[0].split(/\s+/)) if (name && name !== '私聊' && name !== '我') ownerAliases.add(name)
      }
      const built = makeRowFromMessage({ text: message.text, role, channel, speaker, sourceOverride: isSelf ? 'agent_visible' : 'human', visibleOverride: true })
      if (!built) continue
      entries.push({
        atMs: Number(message.ts), order: order += 1, row: built.row,
        meta: { origin: 'old-qq.messages', srcId: Number(message.id), convKey, rawSender: rawSenderId, rawSenderName },
      })
    }
    const extraQqs = [...new Set(entries.map((entry) => entry.row.speaker?.kind === 'person' ? entry.row.speaker.value : null).filter((value) => /^\d{5,12}$/.test(String(value ?? ''))))]
    const entities = buildRealEntities({
      ownerQq, selfQq, ownerName: '主人', ownerAliases: [...ownerAliases], peopleByQq: personByQq,
      aliasByQq: new Map(), extraQqs, oldPersons: persons,
    })
    const assembled = assembleDays(entries)
    const rowIndex = new Map(assembled.sortedIds.map((item) => [item.rowId, item]))

    const referenceByDay = new Map()
    for (const summary of summaries) {
      const days = overlapDays(Number(summary.from_ts), Number(summary.to_ts))
      for (const day of days) {
        if (!referenceByDay.has(day)) referenceByDay.set(day, [])
        referenceByDay.get(day).push({ kind: '旧系统摘要', text: String(summary.text ?? '').slice(0, 400) })
      }
    }
    for (const day of assembled.days) {
      if (!referenceByDay.has(day.day)) referenceByDay.set(day.day, [])
      for (const person of persons) {
        if (person.profile) referenceByDay.get(day.day).push({ kind: `旧人物档案 ${person.name ?? ''}`, text: String(person.profile).slice(0, 240) })
      }
    }

    let gold = { entities: [], memories: [], noise: [] }
    let probes = []
    const warnings = []
    const persona = buildPersona(ownerQq, selfQq, '主人', [...ownerAliases])
    if (goldMode === 'draft') {
      const draft = await draftRealGold({
        fixtureId: 'real-qq-2026-10', persona, entities, days: assembled.days, referenceByDay,
        goldModel, refresh, cacheOnly, maxMemoriesPerDay: 7,
        dayList: goldDays ?? assembled.days.map((day) => day.day), warnings,
      })
      gold = draft.gold
      const probeDraft = await draftRealProbes({ fixtureId: 'real-qq-2026-10', gold, days: assembled.days, entities, goldModel, refresh, cacheOnly, warnings })
      probes = probeDraft.probes
    } else {
      warnings.push('gold=none：fixture 无 gold/probes，仅用于结构调试')
      probes = sentinelProbe(assembled.days)
    }

    const fixture = makeFixture({
      id: 'real-qq-2026-10',
      kind: 'real',
      description: '旧 dsh-qq 真实 QQ 对话（群 C4 412 + 主人私聊），2026-10-22..2026-10-26；原始来源只读导入，gold 为 LLM 草拟待抽审。',
      goldSource: 'draft',
      persona,
      days: assembled.days,
      gold,
      probes,
    })
    const validation = validateFixtureObject(fixture, { committed: false })
    if (!validation.ok) {
      for (const error of validation.errors) console.error(`  ❌ ${error.path}: ${error.message}`)
      fatal(`导入结果未通过内置校验（${validation.errors.length} 个错误）`)
    }
    ensureDir(outDir)
    writeJson(path.join(outDir, 'fixture.json'), fixture)
    if (writeRaw) {
      const rawDir = ensureDir(path.join(outDir, 'raw'))
      const byDay = new Map()
      for (const item of assembled.sortedIds) {
        const day = ymdOf(item.atMs)
        if (!byDay.has(day)) byDay.set(day, [])
        byDay.get(day).push({
          rowId: item.rowId, at: item.row.at, origin: item.meta.origin, srcId: item.meta.srcId,
          convKey: item.meta.convKey, rawSender: item.meta.rawSender,
          role: item.row.role, channel: item.row.channel, speaker: item.row.speaker,
          source: item.row.source, visible: item.row.visible, text: item.row.text,
        })
      }
      for (const [day, dayRows] of byDay.entries()) fs.writeFileSync(path.join(rawDir, `${day}.jsonl`), `${dayRows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
    }
    const build = {
      schema: 1,
      fixtureId: fixture.id,
      kind: 'real',
      generatedAt: new Date().toISOString(),
      generator: 'tools/memory-corpus.mjs import-old-qq',
      source: { db: dbStat, ownerQq, selfQq },
      filters: {
        messages: 'is_self=1→assistant/agent_visible/self；否则 user/human；conv_key→channel；sender_id 经旧 persons + 已知 owner 解析 speaker',
      },
      counts: {
        messages: rows.length,
        importedRows: assembled.sortedIds.length,
        days: assembled.days.length,
        rowsBySource: validation.stats.sources,
        goldMemories: gold.memories.length,
        goldEntities: gold.entities.length,
        probes: probes.length,
        summaries: summaries.length,
        persons: persons.length,
      },
      referenceSummaries: summaries.map((item) => ({ id: Number(item.id), text: String(item.text ?? '').slice(0, 200) })),
      entityCatalog: entities,
      goldModel: goldMode === 'draft' ? goldModel : null,
      warnings,
      rowIdMap: assembled.sortedIds.map((item) => ({ rowId: item.rowId, origin: item.meta.origin, srcId: item.meta.srcId })),
    }
    writeJson(path.join(outDir, 'build.json'), build)
    console.log(`old-qq fixture：${path.join(outDir, 'fixture.json')}`)
    console.log(JSON.stringify({ counts: build.counts, warnings: warnings.length }, null, 2))
  } finally {
    db.close()
  }
}


/* ── 真实源：当前 live raw（.state/lab/memory-fixture/latest） ── */

const LIVE_ENV_PREFIXES = ['【心跳】', 'Current runtime context.', 'The following skills are available', '【环境', '【闹钟】', '[心跳]']

function classifyLiveRow(raw, maps) {
  const text = normalizeText(raw.text)
  const role = String(raw.role ?? 'user')
  const speakerSelf = { kind: 'self', value: maps.selfQq }
  const speakerOwner = { kind: 'owner', value: maps.ownerQq }
  const speakerSystem = { kind: 'system', value: 'system' }
  if (role === 'tool') {
    return { role: 'tool', source: 'tool', channel: 'web', speaker: speakerSystem, visible: true }
  }
  if (role === 'assistant') {
    const trimmed = text.trimStart()
    if (/^Alarm fired\b/i.test(trimmed) || trimmed.startsWith('【唤醒】')) {
      return { role: 'assistant', source: 'env', channel: 'web', speaker: speakerSystem, visible: false }
    }
    const plan = looksLikeAgentPlan(text)
    return { role: 'assistant', source: plan ? 'agent_internal' : 'agent_visible', channel: 'web', speaker: speakerSelf, visible: !plan }
  }
  // role=user
  const trimmed = text.trimStart()
  if (trimmed.startsWith('[QQ戳一戳]')) {
    const privateMatch = /私聊/.test(trimmed) ? ownerQqFromPoke(trimmed, maps) : null
    return { role: 'user', source: 'env', channel: privateMatch ? `qq:private:${privateMatch}` : 'web', speaker: speakerSystem, visible: true }
  }
  if (LIVE_ENV_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
    return { role: 'user', source: 'env', channel: 'web', speaker: speakerSystem, visible: true }
  }
  const envelope = parseQQEnvelope(text)
  if (envelope.isEnvelope) {
    const senderKinds = envelope.rawSenders.map((qq) => resolveSpeaker({ raw: qq, peopleByQq: maps.peopleByQq, peopleByName: maps.peopleByName, aliasByQq: new Map(), oldNameToQq: maps.nameToQq, ownerQq: maps.ownerQq, selfQq: maps.selfQq }))
    const unique = [...new Map(senderKinds.map((item) => [`${item.kind}:${item.value}`, item])).values()]
    if (unique.length === 1 && unique[0].kind === 'self') {
      return { role: 'assistant', source: 'agent_visible', channel: envelope.channel ?? 'web', speaker: speakerSelf, visible: true }
    }
    let speaker = { kind: 'unknown', value: 'qq-envelope' }
    const nonSelf = unique.filter((item) => item.kind !== 'self')
    if (nonSelf.length >= 1) speaker = nonSelf[0]
    else if (envelope.channel?.startsWith('qq:private:')) speaker = speakerOwner
    return { role: 'user', source: 'human', channel: envelope.channel ?? 'web', speaker, visible: true }
  }
  return { role: 'user', source: 'human', channel: 'web', speaker: speakerOwner, visible: true }
}

function ownerQqFromPoke(text, maps) {
  const match = /(\d{5,12})/.exec(text)
  return match ? match[1] : maps.ownerQq
}

async function cmdImportLive(argv) {
  const srcDir = path.resolve(argValue(argv, 'src', LIVE_SRC_DEFAULT))
  const outDir = path.resolve(argValue(argv, 'out', path.join(CORPUS_ROOT, 'real-live-2026-11')))
  const ownerQq = String(argValue(argv, 'owner-qq', OWNER_QQ_DEFAULT))
  const selfQq = String(argValue(argv, 'self-qq', SELF_QQ_DEFAULT))
  const force = hasFlag(argv, 'force')
  const writeRaw = flagValue(argv, 'raw', true)
  const goldMode = String(argValue(argv, 'gold', 'draft'))
  const goldModel = String(argValue(argv, 'model', 'reasoner'))
  const refresh = hasFlag(argv, 'refresh')
  const cacheOnly = hasFlag(argv, 'cache-only')
  const goldDays = argValue(argv, 'gold-days') ? String(argValue(argv, 'gold-days')).split(',').map((item) => item.trim()).filter(Boolean) : ['2026-11-10', '2026-11-11']
  const maxPerDay = Math.max(1, Number(argValue(argv, 'gold-max-per-day', 4)) || 4)
  if (fs.existsSync(path.join(outDir, 'fixture.json')) && !force) fatal(`输出已存在（加 --force 覆盖）：${outDir}`)
  const rawDir = path.join(srcDir, 'raw')
  if (!fs.existsSync(rawDir)) fatal(`找不到 live raw 目录：${rawDir}`)

  // 从 raw 文本里收集「名字（QQ号）」映射，供 envelope speaker 解析。
  const nameToQq = new Map()
  const peopleByQq = new Map()
  const files = fs.readdirSync(rawDir).filter((file) => file.endsWith('.jsonl')).sort()
  const rawFiles = []
  for (const file of files) {
    const day = file.replace(/\.jsonl$/, '')
    const rows = fs.readFileSync(path.join(rawDir, file), 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    rawFiles.push({ day, file, rows })
    const joined = rows.map((row) => row.text ?? '').join('\n')
    for (const match of joined.matchAll(/([^\s·（）()：:，,、]{1,24})（QQ(\d{5,12})）/g)) {
      const name = match[1].trim()
      const qq = match[2]
      if (name && !/^\d+$/.test(name)) nameToQq.set(name, qq)
      if (!peopleByQq.has(qq)) peopleByQq.set(qq, { qq, name })
    }
    for (const match of joined.matchAll(/· #\d+ ([^（(：:\n]{1,24})（QQ(\d{5,12})）/g)) {
      nameToQq.set(match[1].trim(), match[2])
      if (!peopleByQq.has(match[2])) peopleByQq.set(match[2], { qq: match[2], name: match[1].trim() })
    }
  }

  const maps = { ownerQq, selfQq, nameToQq, peopleByQq, peopleByName: new Map([...nameToQq.entries()]) }
  const entries = []
  let order = 0
  const dayFileMismatch = []
  for (const { day, rows } of rawFiles) {
    for (const raw of rows) {
      const built = makeRowFromMessage({ text: raw.text, role: raw.role, channel: 'web', speaker: { kind: 'system', value: 'system' } })
      if (!built) continue
      const classified = classifyLiveRow(raw, maps)
      const atMs = Number(raw.time)
      const actualDay = ymdOf(atMs)
      if (actualDay !== day) dayFileMismatch.push({ file: `${fileDayFor(day)}`, rawDay: day, actualDay, seq: raw.seq })
      entries.push({
        atMs,
        order: order += 1,
        row: {
          at: null,
          role: classified.role,
          channel: classified.channel,
          speaker: classified.source === 'human' ? classified.speaker : (classified.role === 'assistant' ? (classified.source === 'env' ? { kind: 'system', value: 'system' } : { kind: 'self', value: selfQq }) : classified.speaker),
          text: normalizeText(raw.text),
          source: classified.source,
          visible: classified.role === 'assistant' ? classified.visible : true,
        },
        meta: { origin: 'live.raw', srcFile: day, seq: raw.seq, sessionId: raw.sessionId, type: raw.type, name: raw.name ?? '' },
      })
    }
  }

  const extraQqs = [...new Set(entries.map((entry) => entry.row.speaker?.kind === 'person' ? entry.row.speaker.value : null).filter((value) => /^\d{5,12}$/.test(String(value ?? ''))))]
  const ownerNames = new Set(['Hahn123', '离线版', '周子涵2025302114061', '周子涵'])
  const entities = buildRealEntities({
    ownerQq, selfQq, ownerName: '主人', ownerAliases: [...ownerNames], peopleByQq, aliasByQq: new Map(),
    extraQqs, extraNames: new Map([...nameToQq.entries()].map(([name, qq]) => [qq, name])),
  })
  const assembled = assembleDays(entries)
  const rowIndex = new Map(assembled.sortedIds.map((item) => [item.rowId, item]))

  // 参考：current.json 里现存的 event/person 快照（非真值，只供草拟核对）。
  const referenceByDay = new Map()
  try {
    const currentPath = path.join(srcDir, 'current.json')
    if (fs.existsSync(currentPath)) {
      const current = readJson(currentPath)
      const referenceTexts = []
      for (const person of current.person ?? []) referenceTexts.push({ kind: '现有 person 块', text: String(person.text ?? '').slice(0, 240) })
      for (const event of (current.event ?? []).slice(-12)) referenceTexts.push({ kind: '现有 event 块', text: String(event.text ?? '').slice(0, 240) })
      for (const day of assembled.days) if (referenceTexts.length) referenceByDay.set(day.day, referenceTexts)
    }
  } catch { /* current.json 可选 */ }

  let gold = { entities: [], memories: [], noise: [] }
  let probes = []
  const warnings = []
  const persona = buildPersona(ownerQq, selfQq, '主人', [...ownerNames])
  if (goldMode === 'draft') {
    const draft = await draftRealGold({
      fixtureId: 'real-live-2026-11', persona, entities, days: assembled.days, referenceByDay,
      goldModel, refresh, cacheOnly, maxMemoriesPerDay: maxPerDay, dayList: goldDays, warnings,
    })
    gold = draft.gold
    const probeDraft = await draftRealProbes({ fixtureId: 'real-live-2026-11', gold, days: assembled.days, entities, goldModel, refresh, cacheOnly, warnings })
    probes = probeDraft.probes
    if (!gold.memories.length) warnings.push('live gold 为空（稀疏哨兵 fixture）')
  } else {
    warnings.push('gold=none：fixture 无 gold/probes，仅用于结构调试')
    probes = sentinelProbe(assembled.days)
  }

  const fixture = makeFixture({
    id: 'real-live-2026-11',
    kind: 'real',
    description: '当前 live session raw（8 天，2026-11-03..2026-11-11；开发/工具活动密集），按确定性 envelope 规则分类；gold 只稀疏标注 11-10/11-11，作回归哨兵。',
    goldSource: 'draft',
    persona,
    days: assembled.days,
    gold,
    probes,
  })
  const validation = validateFixtureObject(fixture, { committed: false })
  if (!validation.ok) {
    for (const error of validation.errors) console.error(`  ❌ ${error.path}: ${error.message}`)
    fatal(`导入结果未通过内置校验（${validation.errors.length} 个错误）`)
  }
  ensureDir(outDir)
  writeJson(path.join(outDir, 'fixture.json'), fixture)
  if (writeRaw) {
    const outRawDir = ensureDir(path.join(outDir, 'raw'))
    const byDay = new Map()
    for (const item of assembled.sortedIds) {
      const day = ymdOf(item.atMs)
      if (!byDay.has(day)) byDay.set(day, [])
      byDay.get(day).push({
        rowId: item.rowId, at: item.row.at, origin: item.meta.origin, srcFile: item.meta.srcFile,
        seq: item.meta.seq, role: item.row.role, channel: item.row.channel, speaker: item.row.speaker,
        source: item.row.source, visible: item.row.visible, text: item.row.text,
      })
    }
    for (const [day, dayRows] of byDay.entries()) fs.writeFileSync(path.join(outRawDir, `${day}.jsonl`), `${dayRows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
  }
  const build = {
    schema: 1,
    fixtureId: fixture.id,
    kind: 'real',
    generatedAt: new Date().toISOString(),
    generator: 'tools/memory-corpus.mjs import-live',
    source: { dir: srcDir, files: rawFiles.map((item) => ({ file: item.file, rows: item.rows.length })), ownerQq, selfQq },
    filters: {
      deterministic: '【心跳】/[QQ戳一戳]/Alarm fired/runtime-context→env；QQ 信封（QQ 还有没看过的消息 / [QQ私聊·/[QQ群）→human（尽量解 sender/channel，全为 self 时→agent_visible）；无 CJK 英文计划式 assistant→agent_internal；tool→tool',
      dayFileMismatch,
    },
    counts: {
      rawRows: rawFiles.reduce((sum, item) => sum + item.rows.length, 0),
      importedRows: assembled.sortedIds.length,
      days: assembled.days.length,
      rowsBySource: validation.stats.sources,
      goldMemories: gold.memories.length,
      goldEntities: gold.entities.length,
      probes: probes.length,
    },
    nameToQq: Object.fromEntries(nameToQq),
    entityCatalog: entities,
    goldModel: goldMode === 'draft' ? goldModel : null,
    warnings,
    rowIdMap: assembled.sortedIds.map((item) => ({ rowId: item.rowId, srcFile: item.meta.srcFile, seq: item.meta.seq })),
  }
  writeJson(path.join(outDir, 'build.json'), build)
  console.log(`live fixture：${path.join(outDir, 'fixture.json')}`)
  console.log(JSON.stringify({ counts: build.counts, warnings: warnings.length, dayFileMismatch: dayFileMismatch.length }, null, 2))
}

function fileDayFor(day) {
  return `${day}.jsonl`
}


/* ── 合成场景（提交物）：spec.json → LLM 生成 → 证据逐字校验 → fixture.json ── */

// spec.json 结构见 tools/fixtures/memory/synthetic-*/spec.json；核心约定：
// - anchors：必须逐字出现在某条生成消息里的"构造台词"（gold 证据、probe 时刻都引用它的 key）；
// - noiseRows：确定性注入的非主材料行（工具结果/环境心跳/内部计划/一次性视觉描述），用于 noise/selfSource 指标；
// - gold：由构造已知（entities/memories/noise），evidence 用 anchor/noise key，生成后映射成 row id；
// - probes：8–15 个，afterAnchor 指向某条 anchor（探针在该行之后施加）。

const SYNTH_DAY_COUNT_RANGE = [10, 40]

const NOISE_CATEGORY_SPEC = {
  tool: { role: 'tool', source: 'tool', speakerKind: 'system', visible: true },
  env: { role: 'user', source: 'env', speakerKind: 'system', visible: true },
  plan: { role: 'assistant', source: 'agent_internal', speakerKind: 'self', visible: false },
  visual: { role: 'assistant', source: 'agent_visible', speakerKind: 'self', visible: true },
}

/** 把 compact 的 noisePlan 展开成确定性 noiseRows（每天 1 tool + 1 env；偶数天 plan、奇数天 visual）。 */
function expandNoiseRows(spec) {
  if (Array.isArray(spec.noiseRows) && spec.noiseRows.length) return spec.noiseRows.map((row) => ({ ...row }))
  const plan = spec.noisePlan
  if (!plan) return []
  const rows = []
  for (let day = 1; day <= Number(spec.days); day += 1) {
    for (const [category, templates] of Object.entries(plan)) {
      if (!Array.isArray(templates) || !templates.length) continue
      const isEvenDay = day % 2 === 0
      if (category === 'plan' && !isEvenDay) continue
      if (category === 'visual' && isEvenDay) continue
      const template = NOISE_CATEGORY_SPEC[category]
      if (!template) continue
      rows.push({
        key: `n${day}-${category}`,
        day,
        role: template.role,
        source: template.source,
        speakerKind: template.speakerKind,
        visible: template.visible,
        text: String(templates[(day - 1) % templates.length]),
      })
    }
  }
  return rows
}

function withExpandedNoise(spec) {
  return { ...spec, noiseRows: expandNoiseRows(spec) }
}
function readSyntheticSpecs(root, only) {
  if (!fs.existsSync(root)) fatal(`合成场景目录不存在：${root}`)
  const dirs = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('synthetic-'))
    .map((entry) => path.join(root, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, 'spec.json')))
    .sort()
  return dirs.filter((dir) => !only || path.basename(dir) === (only.startsWith('synthetic-') ? only : `synthetic-${only}`))
}

function specActionLabel(spec, anchorOrNoise, rowIdMap, key) {
  const rowId = rowIdMap.get(key)
  return rowId ? `${rowId}` : `${anchorOrNoise?.sender ?? '?'}/${anchorOrNoise?.channel ?? '?'}`
}

/** 合成 spec 自检：不依赖 LLM，先确保构造 gold 自洽。 */
function validateSyntheticSpec(rawSpec, specFile) {
  const spec = withExpandedNoise(rawSpec)
  const errors = []
  const warnings = []
  const fail = (message) => errors.push({ path: specFile, message })
  if (spec.schema !== 1) fail('spec.schema 必须是 1')
  if (!ID_PATTERN.test(String(spec.id ?? ''))) fail(`spec.id 不合规：${spec.id}`)
  if (!['synthetic'].includes(String(spec.id ?? '')) && !String(spec.id ?? '').startsWith('synthetic-')) fail('spec.id 必须以 synthetic- 开头')
  const days = Number(spec.days)
  if (!(days >= 8 && days <= 15)) fail(`spec.days 必须是 8–15：${spec.days}`)
  if (!Array.isArray(spec.dayPlans) || spec.dayPlans.length !== days) fail(`dayPlans 必须正好 ${days} 天`)
  if (!spec.persona?.self?.qq || !spec.persona?.owner?.qq) fail('persona.self/owner 必须有占位 QQ')
  if (String(spec.persona?.self?.qq).startsWith('900') === false) warnings.push('persona.self.qq 建议用 9000000000 段占位号')
  const personKeys = new Map([['self', spec.persona.self], ['owner', spec.persona.owner]])
  for (const other of spec.persona.others ?? []) {
    if (!other.key || !other.qq) fail('persona.others 每项需要 key+qq')
    if (personKeys.has(other.key)) fail(`persona.others key 重复：${other.key}`)
    personKeys.set(other.key, other)
  }
  for (const alt of spec.persona.altAccounts ?? []) {
    if (!alt.key || !alt.qq) fail('persona.altAccounts 每项需要 key+qq')
    if (personKeys.has(alt.key)) fail(`persona.altAccounts key 重复：${alt.key}`)
    personKeys.set(alt.key, alt)
  }
  const group = (spec.groups ?? [])[0]
  if (!group?.id) fail('groups[0].id 必须给出占位群号')

  const anchorKeys = new Set()
  const noiseKeys = new Set()
  const allKeys = new Map()
  const startDate = String(spec.startDate ?? '')
  for (const [index, dayPlan] of (spec.dayPlans ?? []).entries()) {
    const expectedDate = addDays(startDate, index)
    if (dayPlan.date !== expectedDate) fail(`第 ${index + 1} 天 date 应为 ${expectedDate}：${dayPlan.date}`)
    if (!Array.isArray(dayPlan.anchors) || !dayPlan.anchors.length) fail(`第 ${index + 1} 天没有 anchors`)
    for (const anchor of dayPlan.anchors ?? []) {
      if (!anchor.key || anchorKeys.has(anchor.key)) fail(`anchor key 缺失/重复：${anchor.key}`)
      anchorKeys.add(anchor.key)
      allKeys.set(anchor.key, { type: 'anchor', day: index + 1, ...anchor })
      if (!personKeys.has(anchor.sender)) fail(`anchor ${anchor.key} sender 未知：${anchor.sender}`)
      if (!['private', 'group'].includes(anchor.channel)) fail(`anchor ${anchor.key} channel 非法：${anchor.channel}`)
      if (!String(anchor.text ?? '').trim()) fail(`anchor ${anchor.key} text 为空`)
      if (isCjkText(anchor.text) === false) warnings.push(`anchor ${anchor.key} 不是中文（合成场景要求中文对话）`)
    }
  }
  for (const noiseRow of spec.noiseRows ?? []) {
    if (!noiseRow.key || allKeys.has(noiseRow.key)) fail(`noiseRow key 缺失/重复：${noiseRow.key}`)
    noiseKeys.add(noiseRow.key)
    allKeys.set(noiseRow.key, { type: 'noise', ...noiseRow })
    if (!(noiseRow.day >= 1 && noiseRow.day <= days)) fail(`noiseRow ${noiseRow.key} day 越界`)
  }
  for (const entity of spec.gold?.entities ?? []) {
    if (!entity.id) fail('gold.entities 缺 id')
  }
  const memoryIds = new Set()
  for (const memory of spec.gold?.memories ?? []) {
    if (!memory.id || memoryIds.has(memory.id)) fail(`gold.memories id 缺失/重复：${memory.id}`)
    memoryIds.add(memory.id)
  }
  for (const memory of spec.gold?.memories ?? []) {
    if (!GOLD_TYPES.includes(memory.type)) fail(`gold.memories ${memory.id} type 非法`)
    if (!String(memory.text ?? '').trim()) fail(`gold.memories ${memory.id} text 为空`)
    for (const key of memory.evidence ?? []) if (!allKeys.has(key)) fail(`gold.memories ${memory.id} evidence key 不存在：${key}`)
    const expectedDay = allKeys.get(memory.evidence?.[0])?.day
    if (memory.validFrom && expectedDay && memory.validFrom !== addDays(startDate, expectedDay - 1)) {
      warnings.push(`gold.memories ${memory.id} validFrom=${memory.validFrom} 与首条证据日期 ${addDays(startDate, expectedDay - 1)} 不一致`)
    }
    if (memory.invalidatedBy && !memoryIds.has(memory.invalidatedBy) && !((spec.gold?.memories ?? []).some((item) => item.id === memory.invalidatedBy))) {
      fail(`gold.memories ${memory.id} invalidatedBy 不存在：${memory.invalidatedBy}`)
    }
  }
  for (const memory of spec.gold?.memories ?? []) {
    if (memory.invalidatedBy && !(spec.gold?.memories ?? []).some((item) => item.id === memory.invalidatedBy)) fail(`gold.memories ${memory.id} invalidatedBy 不存在：${memory.invalidatedBy}`)
  }
  for (const noise of spec.gold?.noise ?? []) {
    if (!Array.isArray(noise.rowKeys) || !noise.rowKeys.length) fail('gold.noise 每项需要 rowKeys')
    for (const key of noise.rowKeys ?? []) if (!allKeys.has(key)) fail(`gold.noise rowKey 不存在：${key}`)
  }
  const probes = spec.probes ?? []
  if (probes.length < 8 || probes.length > 15) fail(`probes 必须 8–15 个：${probes.length}`)
  const probeIds = new Set()
  for (const probe of probes) {
    if (!probe.id || probeIds.has(probe.id)) fail(`probe id 缺失/重复：${probe.id}`)
    probeIds.add(probe.id)
    if (!allKeys.has(probe.afterAnchor)) fail(`probe ${probe.id} afterAnchor 不存在：${probe.afterAnchor}`)
    if (!PROBE_KINDS.includes(probe.kind)) fail(`probe ${probe.id} kind 非法`)
    for (const memoryId of [...(probe.expectedMemoryIds ?? []), ...(probe.expectedAny ?? []), ...(probe.mustNotRecall ?? [])]) {
      if (!memoryIds.has(memoryId)) fail(`probe ${probe.id} 引用了不存在的 gold memory：${memoryId}`)
    }
  }
  return { ok: errors.length === 0, errors, warnings }
}

function mulberry32(seed) {
  let state = seed >>> 0
  return function random() {
    state = (state + 0x6D2B79F5) >>> 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function syntheticRouteMap(spec) {
  const map = new Map()
  const { self, owner } = spec.persona
  const group = (spec.groups ?? [])[0] ?? { id: '9000000101' }
  const routeOf = (sender, channel) => {
    if (channel === 'group') return { channel: `qq:group:${group.id}` }
    if (sender === 'self' || sender === 'owner') return { channel: `qq:private:${owner.qq}` }
    const other = (spec.persona.others ?? []).concat(spec.persona.altAccounts ?? []).find((item) => item.key === sender)
    if (!other) fatal(`未知 sender：${sender}`)
    return { channel: `qq:private:${other.qq}` }
  }
  map.self = { speaker: { kind: 'self', value: self.qq }, role: 'assistant', source: 'agent_visible', visible: true }
  map.owner = { speaker: { kind: 'owner', value: owner.qq }, role: 'user', source: 'human', visible: true }
  for (const other of spec.persona.others ?? []) map[other.key] = { speaker: { kind: 'person', value: other.qq }, role: 'user', source: 'human', visible: true }
  for (const alt of spec.persona.altAccounts ?? []) map[alt.key] = { speaker: { kind: 'person', value: alt.qq }, role: 'user', source: 'human', visible: true }
  map.routeOf = routeOf
  return map
}

function syntheticPrompt(spec, dayPlan, dayIndex, missingAnchors = null, previousMessages = [], attempt = 1) {
  const group = (spec.groups ?? [])[0] ?? { id: '9000000101', name: '群' }
  const currentDay = dayIndex + 1
  const allAnchors = spec.dayPlans.flatMap((plan, index) => (plan.anchors ?? []).map((anchor) => ({ ...anchor, day: index + 1 })))
  const firstDayOfSender = (key) => {
    const days = allAnchors.filter((anchor) => anchor.sender === key).map((anchor) => anchor.day)
    return days.length ? Math.min(...days) : Number.POSITIVE_INFINITY
  }
  const personaLine = (actor, extra = '', aliasesOverride = null) => {
    const aliases = (aliasesOverride ?? actor.aliases ?? []).join('、')
    return `- ${actor.name}（QQ ${actor.qq}${aliases ? `；别名：${aliases}` : ''}）${extra}`
  }
  const others = (spec.persona.others ?? []).map((other) => personaLine(other, other.desc ? `：${other.desc}` : '')).join('\n')
  // 小号等角色只在首次出现在 anchor 的当天及以后才介绍，避免提前剧透。
  const altAccounts = (spec.persona.altAccounts ?? [])
    .filter((alt) => firstDayOfSender(alt.key) <= currentDay)
    .map((alt) => `- ${alt.name}（QQ ${alt.qq}）是主人的小号（同一个人，别当成陌生人）`).join('\n')
  // owner 的别名同样按首次出现的 anchor 日期逐步放出。
  const visibleOwnerAliases = (spec.persona.owner.aliases ?? []).filter((alias) => {
    const days = allAnchors.filter((anchor) => anchor.sender === 'owner' && anchor.text.includes(alias)).map((anchor) => anchor.day)
    return days.length === 0 || Math.min(...days) <= currentDay
  })
  // 只喂"截至今天已经发生"的构造信息，避免模型把未来几天的剧情提前抖出来。
  const anchorDay = new Map()
  for (const [index, plan] of spec.dayPlans.entries()) for (const anchor of plan.anchors ?? []) anchorDay.set(anchor.key, index + 1)
  const goldLines = (spec.gold?.memories ?? [])
    .filter((memory) => {
      const evidenceDays = (memory.evidence ?? []).map((key) => anchorDay.get(key)).filter((value) => Number.isFinite(value))
      const firstDay = evidenceDays.length ? Math.min(...evidenceDays) : 1
      return firstDay <= currentDay
    })
    .map((memory) => `- [${memory.type}] ${memory.text}${memory.note ? `（${memory.note}）` : ''}`)
    .join('\n')
  const anchors = dayPlan.anchors.map((anchor, index) => {
    const route = personaKeyLabel(spec, anchor.sender)
    const where = anchor.channel === 'group' ? `群「${group.name}」` : '私聊'
    return `${index + 1}. 发送者 sender="${anchor.sender}"（${route}），channel="${anchor.channel}"（${where}）必须逐字出现：「${anchor.text}」`
  }).join('\n')
  const previous = previousMessages.length
    ? `\n前一天最后几条消息（保持人设/话题连续性，不要重复）：\n${previousMessages.map((item) => `- ${item.sender}: ${item.text}`).join('\n')}\n`
    : ''
  const retry = missingAnchors?.length
    ? `\n⚠️ 上一次生成遗漏了这些必须台词，这次必须逐字包含（一个字都不能改）：\n${missingAnchors.map((anchor) => `- 「${anchor.text}」`).join('\n')}\n`
    : ''
  const count = dayPlan.count ?? [12, 20]
  return [
    { role: 'system', content: '你是中文对话语料作者兼角色扮演者：为中文陪伴型 AI 的"记忆评测"构造虚构聊天语料。只输出合法 JSON，不输出解释、markdown 围栏或旁白。所有人物/QQ 号均为占位虚构（9000000000 段），禁止使用真实人名或真实 QQ。' },
    { role: 'user', content: `场景：${spec.title}
背景：${spec.premise ?? ''}
这是第 ${dayIndex + 1}/${spec.days} 天，日期 ${dayPlan.date}（第 ${attempt} 次生成）。

人物：
${personaLine(spec.persona.self, `：${spec.selfVoice ?? '住在电脑里的 AI 伙伴，中文口语、活泼、会自嘲，偶尔蹦英文词'}`)}
${personaLine(spec.persona.owner, '：主人（群里朋友会叫他老白/白哥）', visibleOwnerAliases)}
${others}
${altAccounts || '（今天还不认识主人的小号，不要提小号的事）'}
群「${group.name}」群号 ${group.id}，主人、鱼鱼和群友都在里面。

已由构造确定、截至今天已经发生的信息（可以自然回扣；日期、数字、名字、称呼不能改；不要照抄原文）：
${goldLines || '（暂无）'}

第 ${dayIndex + 1} 天重点：${dayPlan.focus ?? ''}
${dayPlan.guide ? `写作提示：${dayPlan.guide}` : ''}
${previous}${retry}
硬性要求（必须逐字出现在某一条消息里，不能改写、不能拆到两条消息）：
${anchors}

生成要求：
- 共 ${count[0]}–${count[1]} 条消息，像真实 QQ/微信聊天：短句为主、有来有回、中文为主，可夹少量英文/表情词；
- sender 只能是：self（鱼鱼）、owner（主人）、${Object.keys(syntheticRouteMap(spec)).filter((key) => !['self', 'owner', 'routeOf'].includes(key)).join('、')}；
- channel 只能是 private（鱼鱼与主人私聊）或 group（群聊）；其他人只在群里说话；
- time 用 "HH:MM"（07:00–23:30，按时间递增）；text 只写消息本身，不要写发送者前缀、时间戳、旁白或"（笑）"以外的动作描写；
- 不要提前透露后面几天才会发生的事（例如还没到那天就宣布出差/改期/换习惯/新承诺）；今天只推进第 ${dayIndex + 1} 天重点；
- 只使用上面明确给出的人物/称呼/已发生信息；不要自行补充或提前引入后面才出现的角色、账号、行程、承诺（比如今天没给的小号，就不要提）；
- 必须台词已计入条数。不要编造真实世界隐私信息。

只输出 JSON：{"messages":[{"sender":"owner","channel":"private","time":"08:12","text":"..."}]}` },
  ]
}

function personaKeyLabel(spec, sender) {
  if (sender === 'self') return `鱼鱼/self`
  if (sender === 'owner') return `主人/owner`
  const other = (spec.persona.others ?? []).concat(spec.persona.altAccounts ?? []).find((item) => item.key === sender)
  return other ? `${other.name}/${sender}` : sender
}

function validHm(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value ?? ''))
}

function parseSyntheticMessages(spec, value) {
  const raw = Array.isArray(value?.messages) ? value.messages : (Array.isArray(value) ? value : null)
  if (!raw) return { messages: [], errors: ['缺少 messages 数组'] }
  const routes = syntheticRouteMap(spec)
  const messages = []
  const errors = []
  for (const [index, item] of raw.entries()) {
    const sender = String(item?.sender ?? '')
    if (!routes[sender]) { errors.push(`第 ${index + 1} 条 sender 非法：${sender}`); continue }
    const channel = String(item?.channel ?? '')
    if (!['private', 'group'].includes(channel)) { errors.push(`第 ${index + 1} 条 channel 非法：${channel}`); continue }
    const text = String(item?.text ?? '').trim()
    if (!text) { errors.push(`第 ${index + 1} 条 text 为空`); continue }
    messages.push({ sender, channel, time: validHm(item?.time) ? String(item.time) : null, text })
  }
  return { messages, errors }
}

async function generateSyntheticDay(spec, dayPlan, dayIndex, previousMessages, options) {
  const { goldModel, refresh, cacheOnly, seed } = options
  let missing = null
  let lastResult = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const promptMessages = syntheticPrompt(spec, dayPlan, dayIndex, missing, previousMessages, attempt)
    // 同一 seed + 同一天 + 同一次尝试 = 同一缓存键；--refresh 才重新请求。
    const result = await llmJson(goldModel, promptMessages, { maxTokens: 8000, refresh, cacheOnly })
    const parsed = parseSyntheticMessages(spec, result.value)
    if (parsed.errors.length) { missing = missing ?? []; lastResult = { error: parsed.errors.slice(0, 5).join('；'), messages: [] }; continue }
    const messages = parsed.messages
    const missingAnchors = dayPlan.anchors.filter((anchor) => !messages.some((message) => message.text.includes(anchor.text)))
    const tooFew = messages.length < (dayPlan.count?.[0] ?? 12) - 2
    const tooMany = messages.length > (dayPlan.count?.[1] ?? 20) + 6
    if (!missingAnchors.length && !tooFew && !tooMany) {
      return { messages, attempts: attempt, cached: result.cached }
    }
    missing = missingAnchors
    lastResult = { error: `${tooFew ? `条数过少(${messages.length}) ` : ''}${tooMany ? `条数过多(${messages.length}) ` : ''}缺少台词：${missingAnchors.map((anchor) => anchor.text.slice(0, 24)).join(' / ')}`, messages }
    if (!missingAnchors.length) break
  }
  fatal(`合成场景 ${spec.id} 第 ${dayIndex + 1} 天生成失败：${lastResult?.error ?? 'unknown'}`)
}

function buildSyntheticEntries(spec, dayRowsByDay, noiseRowsByDay) {
  const entries = []
  let order = 0
  const routes = syntheticRouteMap(spec)
  const days = spec.dayPlans.map((dayPlan) => dayPlan.date)
  for (const [dayIndex, dayPlan] of spec.dayPlans.entries()) {
    const day = dayPlan.date
    const messages = dayRowsByDay.get(day) ?? []
    const random = mulberry32((Number(spec.seed) || 1) + dayIndex * 7919)
    let previousMs = msOfDayHm(day, '07:30')
    const dayEntries = []
    for (const message of messages) {
      const route = routes[message.sender]
      let atMs = message.time ? msOfDayHm(day, message.time) : previousMs + Math.round(4 + random() * 9) * 60_000
      if (!(atMs > previousMs)) atMs = previousMs + Math.round(3 + random() * 8) * 60_000
      previousMs = atMs
      const speaker = route.speaker
      const row = {
        at: null, role: route.role, channel: routes.routeOf(message.sender, message.channel).channel,
        speaker, text: message.text, source: route.source, visible: route.visible,
      }
      dayEntries.push({ atMs, order: order += 1, row, meta: { origin: 'synthetic.llm', sender: message.sender, channel: message.channel } })
    }
    for (const noiseRow of noiseRowsByDay.get(day) ?? []) {
      const role = String(noiseRow.role ?? 'tool')
      const source = String(noiseRow.source ?? (role === 'tool' ? 'tool' : 'env'))
      let atMs = noiseRow.time ? msOfDayHm(day, noiseRow.time) : previousMs + Math.round(5 + random() * 10) * 60_000
      if (!(atMs > previousMs)) atMs = previousMs + Math.round(3 + random() * 6) * 60_000
      previousMs = atMs
      const speakerKind = noiseRow.speakerKind ?? (role === 'assistant' ? 'self' : 'system')
      const speaker = speakerKind === 'self'
        ? { kind: 'self', value: spec.persona.self.qq }
        : speakerKind === 'owner' ? { kind: 'owner', value: spec.persona.owner.qq } : { kind: 'system', value: 'system' }
      const row = {
        at: null, role, channel: noiseRow.channel ?? 'web', speaker, text: String(noiseRow.text ?? ''),
        source, visible: role === 'assistant' ? Boolean(noiseRow.visible) : true,
      }
      if (!row.text.trim()) continue
      dayEntries.push({ atMs, order: order += 1, row, meta: { origin: 'synthetic.noise', noiseKey: noiseRow.key } })
    }
    dayEntries.sort((a, b) => a.atMs - b.atMs || a.order - b.order)
    entries.push(...dayEntries)
  }
  entries.sort((a, b) => a.atMs - b.atMs || (a.meta.origin === 'synthetic.noise' ? -1 : 1))
  return entries
}

function mapAnchorKeys(entries, spec) {
  const anchorRowId = new Map()
  for (const anchor of spec.dayPlans.flatMap((day) => day.anchors)) {
    const hit = entries.find((entry) => entry.row.text.includes(anchor.text))
    if (!hit) fatal(`内部错误：anchor 未映射到行：${anchor.key}`)
    anchorRowId.set(anchor.key, hit.row.id)
  }
  return anchorRowId
}

function mapNoiseKeys(entries) {
  const noiseRowId = new Map()
  for (const entry of entries) if (entry.meta.noiseKey) noiseRowId.set(entry.meta.noiseKey, entry.row.id)
  return noiseRowId
}

function buildSyntheticGold(spec, anchorRowId, noiseRowId) {
  const idMap = new Map([...anchorRowId.entries(), ...noiseRowId.entries()])
  const entities = (spec.gold?.entities ?? []).map((entity) => ({
    id: String(entity.id),
    kind: String(entity.kind ?? 'person'),
    name: String(entity.name),
    ...(entity.aliases?.length ? { aliases: entity.aliases.map(String) } : {}),
    ...(entity.ids?.length ? { ids: entity.ids.map((value) => ({ kind: 'qq', value: String(value) })) } : {}),
    importance: Number(entity.importance ?? 3),
  }))
  const memories = (spec.gold?.memories ?? []).map((memory) => ({
    id: String(memory.id),
    type: String(memory.type),
    subject: String(memory.subject),
    text: String(memory.text),
    importance: Number(memory.importance ?? 3),
    evidence: (memory.evidence ?? []).map((key) => {
      const rowId = idMap.get(key)
      if (!rowId) fatal(`gold.memories ${memory.id} 的 evidence key 未映射：${key}`)
      return rowId
    }),
    validFrom: String(memory.validFrom ?? spec.startDate),
    invalidatedBy: memory.invalidatedBy ?? null,
    note: String(memory.note ?? '构造 gold'),
  }))
  const noise = (spec.gold?.noise ?? []).map((entry) => ({
    rowIds: (entry.rowKeys ?? []).map((key) => {
      const rowId = idMap.get(key)
      if (!rowId) fatal(`gold.noise 的 rowKey 未映射：${key}`)
      return rowId
    }),
    reason: String(entry.reason ?? 'noise'),
    note: String(entry.note ?? ''),
  }))
  return { entities, memories, noise }
}

function buildSyntheticProbes(spec, anchorRowId, gold) {
  const memoryIds = new Set(gold.memories.map((memory) => memory.id))
  return (spec.probes ?? []).map((probe) => {
    const rowId = anchorRowId.get(probe.afterAnchor)
    if (!rowId) fatal(`probe ${probe.id} afterAnchor 未映射：${probe.afterAnchor}`)
    const expected = (probe.expectedMemoryIds ?? []).filter((id) => memoryIds.has(id))
    const expectedAny = (probe.expectedAny ?? []).filter((id) => memoryIds.has(id))
    const mustNotRecall = (probe.mustNotRecall ?? []).filter((id) => memoryIds.has(id))
    const kind = String(probe.kind ?? 'recall')
    return {
      id: String(probe.id),
      rowId,
      // overview 探针不使用 query（与 eval-harness 口径一致）。
      query: kind === 'overview' ? '' : String(probe.query ?? ''),
      kind,
      expectedMemoryIds: expected,
      ...(expectedAny.length ? { expectedAny } : {}),
      ...(probe.expectAnswer ? { expectAnswer: String(probe.expectAnswer) } : {}),
      ...(mustNotRecall.length ? { mustNotRecall } : {}),
      note: String(probe.note ?? ''),
    }
  })
}

async function generateSyntheticFixture(rawSpec, specFile, options) {
  const spec = withExpandedNoise(rawSpec)
  const { goldModel, refresh, cacheOnly } = options
  const specCheck = validateSyntheticSpec(spec, specFile)
  if (!specCheck.ok) {
    for (const error of specCheck.errors) console.error(`  ❌ ${error.message}`)
    fatal(`spec 校验失败：${specFile}`)
  }
  const dayRowsByDay = new Map()
  const noiseRowsByDay = new Map()
  for (const noiseRow of spec.noiseRows ?? []) {
    const day = spec.dayPlans[Number(noiseRow.day) - 1]?.date
    if (!day) continue
    if (!noiseRowsByDay.has(day)) noiseRowsByDay.set(day, [])
    noiseRowsByDay.get(day).push(noiseRow)
  }
  let previousMessages = []
  const dayReports = []
  for (const [dayIndex, dayPlan] of spec.dayPlans.entries()) {
    const result = await generateSyntheticDay(spec, dayPlan, dayIndex, previousMessages, { goldModel, refresh, cacheOnly, seed: spec.seed })
    const anchorMissing = dayPlan.anchors.filter((anchor) => !result.messages.some((message) => message.text.includes(anchor.text)))
    dayRowsByDay.set(dayPlan.date, result.messages)
    previousMessages = result.messages.slice(-4).map((message) => ({ sender: personaKeyLabel(spec, message.sender), text: message.text.slice(0, 80) }))
    dayReports.push({ day: dayPlan.date, messages: result.messages.length, attempts: result.attempts, cached: result.cached, anchors: dayPlan.anchors.length, anchorsVerified: dayPlan.anchors.length - anchorMissing.length })
    console.log(`  ${spec.id} ${dayPlan.date}：${result.messages.length} 条消息，anchor ${dayPlan.anchors.length - anchorMissing.length}/${dayPlan.anchors.length} 逐字命中${result.cached ? '（缓存）' : ''}`)
  }
  const entries = buildSyntheticEntries(spec, dayRowsByDay, noiseRowsByDay)
  const assembled = assembleDays(entries)
  const anchorRowId = mapAnchorKeys(assembled.sortedIds, spec)
  const noiseRowId = mapNoiseKeys(assembled.sortedIds)
  const gold = buildSyntheticGold(spec, anchorRowId, noiseRowId)
  const probes = buildSyntheticProbes(spec, anchorRowId, gold)
  const persona = {
    self: actorBlock(spec.persona.self.name, [spec.persona.self.qq]),
    owner: actorBlock(spec.persona.owner.name, [spec.persona.owner.qq], spec.persona.owner.aliases ?? []),
  }
  const fixture = makeFixture({
    id: spec.id,
    kind: 'synthetic',
    description: spec.description ?? `${spec.title}（构造式 gold，${spec.days} 天 ${spec.dayPlans[0]?.date}..${spec.dayPlans[spec.dayPlans.length - 1]?.date}）`,
    goldSource: 'constructed',
    persona,
    days: assembled.days,
    gold,
    probes,
  })
  const validation = validateFixtureObject(fixture, { committed: true })
  if (!validation.ok) {
    for (const error of validation.errors) console.error(`  ❌ ${error.path}: ${error.message}`)
    fatal(`合成 fixture 未通过校验：${spec.id}（${validation.errors.length} 个错误）`)
  }
  // 证据逐字校验报告：synthetic 必须 100% 命中。
  const allAnchorKeys = spec.dayPlans.flatMap((day) => day.anchors)
  const unmatched = allAnchorKeys.filter((anchor) => !anchorRowId.has(anchor.key))
  if (unmatched.length) fatal(`合成 fixture 有 anchor 未落成证据行：${unmatched.map((a) => a.key).join(',')}`)
  return {
    fixture,
    build: {
      schema: 1,
      fixtureId: spec.id,
      kind: 'synthetic',
      generatedAt: new Date().toISOString(),
      generator: 'tools/memory-corpus.mjs synthetic',
      spec: path.basename(specFile),
      seed: spec.seed,
      model: goldModel,
      days: dayReports,
      verification: {
        anchors: allAnchorKeys.length,
        anchorsVerbatim: allAnchorKeys.length - unmatched.length,
        probes: probes.length,
        goldMemories: gold.memories.length,
        noiseRows: gold.noise.reduce((sum, entry) => sum + entry.rowIds.length, 0),
      },
      counts: validation.stats,
    },
  }
}

async function cmdSynthetic(argv) {
  const root = path.resolve(argValue(argv, 'root', SYNTHETIC_ROOT))
  const only = argValue(argv, 'only')
  const force = hasFlag(argv, 'force')
  const checkOnly = hasFlag(argv, 'check')
  const specOnly = hasFlag(argv, 'spec-only')
  const refresh = hasFlag(argv, 'refresh')
  const cacheOnly = hasFlag(argv, 'cache-only')
  const goldModel = String(argValue(argv, 'model', 'reasoner'))
  const specs = readSyntheticSpecs(root, only)
  if (!specs.length) fatal(`没有找到合成场景 spec（${root}${only ? `，--only=${only}` : ''}）`)
  const results = []
  for (const specDir of specs) {
    const specFile = path.join(specDir, 'spec.json')
    const fixtureFile = path.join(specDir, 'fixture.json')
    const spec = readJson(specFile)
    if (specOnly) {
      const check = validateSyntheticSpec(spec, specFile)
      results.push({ id: spec.id, ok: check.ok, errors: check.errors, warnings: check.warnings, noiseRows: expandNoiseRows(withExpandedNoise(spec)).length, anchors: (spec.dayPlans ?? []).reduce((sum, day) => sum + (day.anchors?.length ?? 0), 0), probes: (spec.probes ?? []).length, goldMemories: (spec.gold?.memories ?? []).length })
      continue
    }
    if (checkOnly) {
      if (!fs.existsSync(fixtureFile)) fatal(`--check 但 fixture 不存在：${fixtureFile}`)
      const report = await validateFixtureFile(specDir, { committed: true })
      results.push({ id: spec.id, ok: report.ok, errors: report.errors.length, warnings: report.warnings.length, stats: report.stats })
      continue
    }
    if (fs.existsSync(fixtureFile) && !refresh && !force) {
      const report = await validateFixtureFile(specDir, { committed: true })
      console.log(`${spec.id}：已存在 fixture 且未 --refresh，跳过生成（校验 ${report.ok ? '✅' : '❌'}）`)
      results.push({ id: spec.id, skipped: true, ok: report.ok, stats: report.stats })
      continue
    }
    console.log(`生成 ${spec.id}（model=${goldModel}, seed=${spec.seed}）…`)
    const generated = await generateSyntheticFixture(spec, specFile, { goldModel, refresh, cacheOnly })
    writeJson(fixtureFile, generated.fixture)
    writeJson(path.join(specDir, 'build.json'), generated.build)
    const report = await validateFixtureFile(specDir, { committed: true })
    results.push({ id: spec.id, ok: report.ok, stats: report.stats, errors: report.errors.length, warnings: report.warnings.length, build: generated.build.verification })
    console.log(`${spec.id}：fixture 已写入 ${fixtureFile}（校验 ${report.ok ? '✅' : '❌'}）`)
  }
  console.log(JSON.stringify(results, null, 2))
}


/* ── CLI 入口 ───────────────────────────────────────────────── */

function printUsage(write = console.log) {
  write(`用法：
  node tools/memory-corpus.mjs import-focus-core [选项]
  node tools/memory-corpus.mjs import-old-qq [选项]
  node tools/memory-corpus.mjs import-live [选项]
  node tools/memory-corpus.mjs synthetic [选项]
  node tools/memory-corpus.mjs validate --fixture <dir|fixture.json> [--json]

通用选项：
  --out <dir>           输出目录（import-* 默认 .state/lab/memory-corpus/<id>）
  --force               覆盖已存在的输出
  --raw / --no-raw      是否写 raw/<day>.jsonl 原始行副本（默认写）
  --gold <draft|none>   gold 草拟开关（默认 draft；none 只做结构调试）
  --model <reasoner|cloud|local>  LLM 档（默认 reasoner；抽取侧是 cloud deepseek-chat）
  --refresh             绕过 LLM 缓存重新生成
  --cache-only          只允许命中缓存（复现校验用）
  --gold-days <csv>     只对指定天草拟 gold（import-* 用；import-live 默认 11-10/11-11）
  --gold-max-per-day <n> 每天最多草拟多少条 gold（import-live 默认 4）

import-focus-core：--db <focus.db> --owner-qq --self-qq
import-old-qq：   --db <memory.db> --owner-qq --self-qq
import-live：     --src <.state/lab/memory-fixture/latest> --gold-days
synthetic：       --only <name> | --check（只校验已生成）| --spec-only（只校验 spec）
                  --root tools/fixtures/memory --refresh（重新生成）
validate：        --fixture <path> --json

示例：
  node tools/memory-corpus.mjs import-focus-core --out .state/lab/memory-corpus/real-focuscore-2026-10
  node tools/memory-corpus.mjs import-old-qq --out .state/lab/memory-corpus/real-qq-2026-10
  node tools/memory-corpus.mjs import-live --out .state/lab/memory-corpus/real-live-2026-11
  node tools/memory-corpus.mjs synthetic --check
  node tools/memory-corpus.mjs synthetic --only alias-and-people --refresh
  node tools/memory-corpus.mjs validate --fixture tools/fixtures/memory/synthetic-alias-and-people`)
}

async function cmdValidate(argv) {
  const fixtureArg = argValue(argv, 'fixture') ?? argValue(argv, 'dir')
  if (!fixtureArg) fatal('validate 需要 --fixture <dir|fixture.json>')
  const reports = []
  const targets = []
  const resolved = path.resolve(fixtureArg)
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory() && !fs.existsSync(path.join(resolved, 'fixture.json'))) {
    for (const entry of fs.readdirSync(resolved)) if (entry.startsWith('synthetic-') || fs.existsSync(path.join(resolved, entry, 'fixture.json'))) targets.push(path.join(resolved, entry))
  } else {
    targets.push(resolved)
  }
  let ok = true
  for (const target of targets) {
    const report = await validateFixtureFile(target)
    reports.push(report)
    if (!report.ok) ok = false
    if (hasFlag(argv, 'json')) continue
    const stats = report.stats
    console.log(`\n== ${report.file}`)
    if (stats) {
      console.log(`   ${stats.kind} · ${stats.days} 天（${stats.dayList[0] ?? '?'}..${stats.dayList[stats.dayList.length - 1] ?? '?'}）· ${stats.rows} 行 · gold ${stats.goldMemories} 条 ${JSON.stringify(stats.goldTypes)} · noise ${stats.noiseRows} 行 · probes ${stats.probes} ${JSON.stringify(stats.probeKinds)}`)
      console.log(`   sources=${JSON.stringify(stats.sources)} entities=${stats.entities}`)
    }
    console.log(`   ${report.ok ? '✅ 通过' : '❌ 失败'}（errors=${report.errors.length} warnings=${report.warnings.length}${report.authoritative ? '；eval-harness loader 已交叉校验' : '；仅内置校验'}）`)
    for (const error of report.errors.slice(0, 20)) console.log(`   ❌ ${error.path}: ${error.message}`)
    for (const warning of report.warnings.slice(0, 12)) console.log(`   ⚠️  ${warning.path}: ${warning.message}`)
  }
  if (hasFlag(argv, 'json')) console.log(JSON.stringify({ ok, reports }, null, 2))
  return ok ? 0 : 2
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0]
  try {
    if (command === 'import-focus-core') return await cmdImportFocusCore(argv)
    if (command === 'import-old-qq') return await cmdImportOldQq(argv)
    if (command === 'import-live') return await cmdImportLive(argv)
    if (command === 'synthetic') return await cmdSynthetic(argv)
    if (command === 'validate') return await cmdValidate(argv)
    if (!command || command === 'help' || command === '--help' || command === '-h') { printUsage(); return 0 }
    printUsage((...args) => console.error(...args))
    fatal(`未知子命令：${command}`)
  } catch (error) {
    if (error?.exitCode && error.exitCode !== 0) {
      console.error(`memory-corpus 失败：${error.message}`)
      return error.exitCode
    }
    throw error
  }
}

main().then((code) => { process.exitCode = typeof code === 'number' ? code : 0 }).catch((error) => {
  console.error(`memory-corpus 崩溃：${error?.stack ?? error}`)
  process.exitCode = 2
})
