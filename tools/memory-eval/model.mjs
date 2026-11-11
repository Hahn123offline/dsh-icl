// 模型适配：echo（离线 stub）/ cloud（config/icl.local.json 第一个 chat provider）/ local（llama-swap）。
//
// 约定：
//   · 所有 LLM 调用都走这里，按 prompt hash 缓存到 <out>/cache.json，重复跑不重复付费；
//   · cache.json 只存返回文本与模型名，绝不含密钥；
//   · echo 是确定性桩：按"这是哪个 job 的 prompt"返回结构化 JSON，供 CI/自测离线跑通形成链，
//     它不代表模型质量，只保证链路可执行、可复现。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const MODEL_KINDS = Object.freeze(['echo', 'cloud', 'local'])

/** prompt 的稳定哈希（不含时间/随机数，保证同 prompt 命中同一次缓存）。 */
export function promptHash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

/** 选嵌入 provider（--embed 时用；默认 config/icl.local.json 第一个 embedding）。 */
export function resolveEmbedProvider(configFile, providerId = null) {
  const config = readJson(configFile, null)
  if (!config) throw new Error(`读不到 provider 配置：${configFile}`)
  const embeddings = (config.providers ?? []).filter((provider) => String(provider.kind ?? '') === 'embedding')
  if (!embeddings.length) throw new Error(`provider 配置里没有 embedding provider：${configFile}`)
  if (providerId) {
    const hit = embeddings.find((provider) => String(provider.id) === String(providerId))
    if (!hit) throw new Error(`找不到 embedding provider：${providerId}（可选：${embeddings.map((p) => p.id).join(', ')}）`)
    return hit
  }
  return embeddings[0]
}

/**
 * 嵌入适配器（--embed 显式开关；默认关，离线 CI 不依赖本地 8088）。
 * 与 chat 适配器同一套思路：prompt-hash 缓存到 <out>/embed-cache.json，绝不存密钥。
 */
export async function createEmbedAdapter(options = {}) {
  const outDir = path.resolve(options.outDir ?? '.')
  fs.mkdirSync(outDir, { recursive: true })
  const cacheFile = path.join(outDir, 'embed-cache.json')
  const cache = readJson(cacheFile, {}) ?? {}
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const provider = resolveEmbedProvider(options.configFile, options.providerId)
  const model = String(options.modelId ?? provider.model ?? 'bge-m3')
  const baseUrl = String(provider.baseUrl ?? '').replace(/\/+$/, '')
  if (!baseUrl) throw new Error(`embedding provider ${provider.id} 缺少 baseUrl`)
  const envName = String(provider.apiKeyEnv ?? '')
  const apiKey = envName ? await userEnv(envName) : String(provider.apiKey ?? '')
  const stats = { kind: 'embedding', calls: 0, cacheHits: 0, dim: null, cached: 0 }
  let cacheDirty = false
  function persistCache() {
    if (!cacheDirty) return
    cacheDirty = false
    const tmp = `${cacheFile}.tmp-${process.pid}`
    fs.writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, cacheFile)
  }
  return {
    describe: () => ({ kind: 'embedding', provider: provider.id, model, baseUrl, cacheFile }),
    async embed(input) {
      const text = String(input ?? '')
      if (!text.trim()) return []
      const key = promptHash({ provider: provider.id, model, input: text })
      if (Array.isArray(cache[key]?.vec)) {
        stats.cacheHits += 1
        stats.dim = cache[key].vec.length
        return cache[key].vec
      }
      stats.calls += 1
      const response = await fetchImpl(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model, input: [text] }),
        signal: AbortSignal.timeout(Number(provider.timeoutMs ?? 60_000)),
      })
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error(`embedding ${response.status}：${String(body).slice(0, 200)}`)
      }
      const data = await response.json()
      const vec = data?.data?.[0]?.embedding
      if (!Array.isArray(vec) || !vec.length) throw new Error('embedding 返回空向量')
      cache[key] = { vec, model, provider: provider.id, at: Date.now() }
      cacheDirty = true
      stats.dim = vec.length
      stats.cached += 1
      persistCache()
      return vec
    },
    stats: () => ({ ...stats, cached: Object.keys(cache).length }),
    flush: persistCache,
  }
}

export function resolveProvider(configFile, kind = 'cloud', providerId = null) {
  const config = readJson(configFile, null)
  if (!config) throw new Error(`读不到 provider 配置：${configFile}`)
  const chats = (config.providers ?? []).filter((provider) => String(provider.kind ?? 'chat') === 'chat')
  if (!chats.length) throw new Error(`provider 配置里没有 chat provider：${configFile}`)
  if (providerId) {
    const hit = chats.find((provider) => String(provider.id) === String(providerId))
    if (!hit) throw new Error(`找不到 chat provider：${providerId}（可选：${chats.map((p) => p.id).join(', ')}）`)
    return hit
  }
  if (kind === 'local') {
    const hit = chats.find((provider) => String(provider.id) === 'llama-swap-chat') ?? chats[1] ?? chats[0]
    return hit
  }
  return chats[0]
}

// 用户级环境变量只读一次（Node 进程未必继承用户级变量；不落盘、不打印）。
let execFileSyncImpl = null
async function childProcessModule() {
  if (!execFileSyncImpl) {
    const mod = await import('node:child_process')
    execFileSyncImpl = mod.execFileSync
  }
  return execFileSyncImpl
}

async function userEnv(name) {
  if (process.env[name]) return String(process.env[name])
  if (process.platform !== 'win32') return ''
  try {
    const execFileSync = await childProcessModule()
    const out = execFileSync('powershell', ['-NoProfile', '-Command', `[Environment]::GetEnvironmentVariable('${String(name).replace(/'/g, "''")}','User')`], { timeout: 8000, encoding: 'utf8' })
    return String(out ?? '').trim()
  } catch { return '' }
}

/* ── echo：确定性离线桩 ─────────────────────────────────────────── */

function parseDayLogLines(payload) {
  const lines = []
  for (const raw of String(payload ?? '').split('\n')) {
    const match = /^\[(\d+)\]\s*(?:(\d{1,2}:\d{2})\s*)?(?:(.{1,24}?)：)?(.*)$/s.exec(raw)
    if (!match) continue
    const text = String(match[4] ?? '').trim()
    if (!text) continue
    lines.push({ id: Number(match[1]), sender: String(match[3] ?? '').trim(), text })
  }
  return lines
}

function clip(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max) : text
}

/**
 * echo 桩的确定性响应：看 system 里出现的是哪个 job 的指令，按载荷生成结构化 JSON。
 * 输出刻意保持"一条原话 = 一条证据"的结构，这样证据 → rowId 的映射在离线自测里可断言。
 */
export function echoRespond(messages, hints = {}) {
  const system = String(messages?.[0]?.content ?? '')
  const payload = String(messages?.find((m) => m.role === 'user')?.content ?? '')
  if (system.includes('你在整理已有的记忆块')) return '{}'
  if (system.includes('从当天原话里找出被提到的人')) {
    const skip = new Set([...(hints.selfNames ?? []), '用户', '我', '系统', '工具'])
    const out = []
    for (const line of parseDayLogLines(payload)) {
      if (!line.sender || skip.has(line.sender)) continue
      out.push({ who: line.sender, fact: clip(line.text, 60), source_id: line.id })
    }
    return JSON.stringify(out)
  }
  if (system.includes('事件块')) {
    const groups = new Map()
    for (const line of parseDayLogLines(payload)) {
      const key = line.sender || '这一天'
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(line)
    }
    const blocks = []
    for (const [sender, lines] of groups) {
      const texts = lines.map((line) => line.text)
      blocks.push({
        summary: clip(`${sender}：${texts[0]}`, 80),
        body: texts.join('。'),
        people: [],
        tags: [],
        evidence: lines.map((line) => line.id),
      })
    }
    return JSON.stringify(blocks)
  }
  if (system.includes('你在写一份人物档案')) {
    const who = /内部编号（不要写进档案）：(\S+)/.exec(payload)?.[1] ?? '这个人'
    const subject = /^(?:name|qq|person):(.+)$/.exec(who)?.[1] ?? who
    const factLine = String(payload).split('\n').map((line) => /^\[(\d+)\]\s*(.*)$/.exec(line)).find(Boolean)
    const evidence = factLine ? [Number(factLine[1])] : []
    const ids = /^\d{5,12}$/.test(subject) ? [{ kind: 'qq', value: subject }] : []
    return JSON.stringify({
      profile: `据材料认识的人：${subject}。${factLine ? clip(factLine[2], 40) : ''}`,
      facts: [],
      aliases: [],
      ids,
      familiarity: 'unknown',
      evidence,
      claims: [],
    })
  }
  if (system.includes('只输出 JSON：{"evidence"')) {
    const ids = [...String(payload).matchAll(/^\[(\d+)\]/gm)].map((match) => Number(match[1]))
    return JSON.stringify({ evidence: ids.slice(0, 2) })
  }
  if (system.includes('说法采集器') || system.includes('整理今天遇到的新梗')) return '[]'
  return '[]'
}

/* ── 适配器工厂 ─────────────────────────────────────────────────── */

/**
 * @param {object} options
 * @param {'echo'|'cloud'|'local'} options.kind
 * @param {string} options.outDir 缓存文件落在这里
 * @param {string} [options.configFile] provider 配置
 * @param {string|null} [options.providerId]
 * @param {string|null} [options.modelId]
 * @param {number} [options.maxCalls]
 * @param {boolean} [options.cacheOnly] 只允许命中缓存（可无密钥、无网络，供 CI 复用云端基线）
 * @param {Function} [options.fetchImpl] 注入 fetch（自测用；默认 globalThis.fetch）
 * @param {object} [options.echoHints] echo 桩用它区分"她自己的名字/主人的名字"
 */
export async function createModelAdapter(options = {}) {
  const kind = MODEL_KINDS.includes(options.kind) ? options.kind : 'echo'
  const outDir = path.resolve(options.outDir ?? '.')
  fs.mkdirSync(outDir, { recursive: true })
  const cacheFile = path.join(outDir, 'cache.json')
  const cache = readJson(cacheFile, {}) ?? {}
  const maxCalls = Math.max(1, Number(options.maxCalls ?? 500) || 500)
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const stats = { calls: 0, cacheHits: 0, promptChars: 0, outputChars: 0, promptTokens: 0, completionTokens: 0, wallMs: 0, maxCalls }

  if (kind === 'echo') {
    return {
      kind,
      describe: () => ({ kind, provider: 'echo', model: 'echo-stub', cacheFile: null }),
      async call({ messages = [], maxTokens = null, where = 'echo' } = {}) {
        const started = Date.now()
        const promptChars = messages.reduce((n, m) => n + String(m?.content ?? '').length, 0)
        const text = echoRespond(messages, options.echoHints)
        stats.calls += 1
        stats.promptChars += promptChars
        stats.outputChars += text.length
        stats.promptTokens += Math.ceil(promptChars / 2)
        stats.completionTokens += Math.ceil(text.length / 2)
        stats.wallMs += Date.now() - started
        return text
      },
      stats: () => ({ ...stats }),
    }
  }

  const provider = resolveProvider(options.configFile, kind, options.providerId)
  const model = String(options.modelId ?? provider.model ?? 'deepseek-chat')
  const baseUrl = String(provider.baseUrl ?? '').replace(/\/+$/, '')
  if (!baseUrl) throw new Error(`provider ${provider.id} 缺少 baseUrl`)
  const envName = String(provider.apiKeyEnv ?? '')
  // cache-only 只需要缓存文件（可无密钥离线复跑云端基线）；真要联网时才要凭据。
  const apiKey = options.cacheOnly ? '' : (envName ? await userEnv(envName) : String(provider.apiKey ?? ''))
  if (!options.cacheOnly && !apiKey) throw new Error(`provider ${provider.id} 缺少凭据（设置环境变量 ${envName || 'apiKey'} 后重试）`)

  let cacheDirty = false
  function persistCache() {
    if (!cacheDirty) return
    cacheDirty = false
    const tmp = `${cacheFile}.tmp-${process.pid}`
    fs.writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, cacheFile)
  }

  return {
    kind,
    describe: () => ({ kind, provider: provider.id, model, baseUrl, cacheFile }),
    async call({ messages = [], maxTokens = null, where = 'chat' } = {}) {
      const started = Date.now()
      const bodyMessages = messages.map((message) => ({
        role: message.role,
        content: typeof message.content === 'string'
          ? message.content
          : Array.isArray(message.content)
            ? message.content.map((block) => block.text ?? '').join('')
            : String(message.content ?? ''),
      }))
      const key = promptHash({ provider: provider.id, model, messages: bodyMessages, maxTokens })
      if (cache[key]?.text) {
        stats.cacheHits += 1
        stats.wallMs += Date.now() - started
        return cache[key].text
      }
      if (options.cacheOnly) throw new Error(`cache-only：缺少缓存 ${key.slice(0, 12)}（${where}）`)
      if (stats.calls >= maxCalls) throw new Error(`达到 max-calls=${maxCalls}（${where}）`)
      stats.calls += 1
      const body = {
        model,
        messages: bodyMessages,
        temperature: 0.2,
        ...(maxTokens ? { max_tokens: Number(maxTokens) } : {}),
      }
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Number(provider.timeoutMs ?? 180_000)),
      })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(`模型 ${response.status}（${where}）：${String(text).slice(0, 300)}`)
      }
      const data = await response.json()
      const text = String(data?.choices?.[0]?.message?.content ?? '')
      if (!text.trim()) throw new Error(`模型返回空内容（${where}）`)
      const usage = data?.usage ?? {}
      stats.promptTokens += Number(usage.prompt_tokens ?? 0) || 0
      stats.completionTokens += Number(usage.completion_tokens ?? 0) || 0
      stats.promptChars += bodyMessages.reduce((n, message) => n + message.content.length, 0)
      stats.outputChars += text.length
      stats.wallMs += Date.now() - started
      cache[key] = { text, model, provider: provider.id, at: Date.now() }
      cacheDirty = true
      persistCache()
      return text
    },
    stats: () => ({ ...stats }),
    flush: persistCache,
  }
}
