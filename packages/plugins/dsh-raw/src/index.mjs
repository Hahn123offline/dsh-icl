// 把 DSH 的会话日志注册成"原文来源"：不复制，不索引，按需扫。
//
// DSH 自己就是原文的存放地（session.v4.jsonl.zstd），我们只在 recall
// 需要细节时按字面扫一遍，返回带时间的原话片段。
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

export const name = 'dsh-raw'

function decode(file) {
  const buf = fs.readFileSync(file)
  if (file.endsWith('.zstd')) {
    try { return zlib.zstdDecompressSync(buf).toString('utf8') } catch { return '' }
  }
  return buf.toString('utf8')
}

function messagesFrom(text, sessionId = null) {
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let obj
    try { obj = JSON.parse(line) } catch { continue }
    const t = Number(obj.time ?? 0)
    const content = obj.data?.content
    const body = Array.isArray(content)
      ? content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n')
      : (typeof content === 'string' ? content : '')
    if (!body) continue
    if (obj.type !== 'user/message' && obj.type !== 'assistant/message') continue
    // 跳过注入的运行上下文
    if (/^(Current runtime context|Time sampled|This is an automatically generated checkpoint|<system-reminder>)/.test(body.trim())) continue
    out.push({ time: t, text: body.replace(/\s+/g, ' ').trim().slice(0, 600), role: obj.type === 'user/message' ? 'user' : 'assistant', sessionId })
  }
  return out
}

export function apply(ctx) {
  const root = String(ctx.config.sessionsRoot ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'sessions'))
  const days = Math.max(1, Number(ctx.config.days ?? 30))
  const maxFiles = Math.max(1, Number(ctx.config.maxFiles ?? 400))
  const maxMessages = Math.max(100, Number(ctx.config.maxMessages ?? 20000))
  const cacheMs = Math.max(10_000, Number(ctx.config.cacheMs ?? 5 * 60_000))
  let cache = null
  let cachedAt = 0

  function load() {
    if (cache && Date.now() - cachedAt < cacheMs) return cache
    const since = Date.now() - days * 24 * 3600_000
    const files = []
    const walk = (dir) => {
      let entries = []
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) walk(full)
        else if (/\.jsonl(\.zstd)?$/.test(e.name)) {
          try { const st = fs.statSync(full); if (st.mtimeMs >= since) files.push(full) } catch { /* ignore */ }
        }
      }
    }
    walk(root)
    files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    const messages = []
    for (const file of files.slice(0, maxFiles)) {
      try {
        const sid = path.basename(file).replace(/\.jsonl(\.zstd)?$/, '')
        messages.push(...messagesFrom(decode(file), sid))
      } catch { /* ignore */ }
    }
    // 有上限：会话很多时不把整个日志读进内存
    cache = messages.length > maxMessages ? messages.slice(-maxMessages) : messages
    cachedAt = Date.now()
    return cache
  }

  const search = ({ query, limit = 2 } = {}) => {
    const q = String(query ?? '').toLowerCase()
    const grams = []
    for (let i = 0; i < q.length - 1; i++) {
      const g = q.slice(i, i + 2)
      if (!/[?？。，、\s]/.test(g)) grams.push(g)
    }
    if (!grams.length) return []
    const scored = []
    for (const m of load()) {
      const text = m.text.toLowerCase()
      let hit = 0
      for (const g of grams) if (text.includes(g)) hit += 1
      if (hit) scored.push({ m, hit })
    }
    scored.sort((a, b) => b.hit - a.hit || b.m.time - a.m.time)
    return scored.slice(0, Math.max(1, Number(limit) || 2)).map((x) => ({ text: x.m.text, time: x.m.time, role: x.m.role, sessionId: x.m.sessionId }))
  }

  const list = ({ since = null, until = null, limit = 500 } = {}) => load()
    .filter((m) => (since == null || m.time >= since) && (until == null || m.time < until))
    .slice(0, limit)
    .map((m) => ({ text: m.text, time: m.time, role: m.role, sessionId: m.sessionId }))

  ctx.services.raw.register({ id: 'dsh-sessions', search, list })
  ctx.tools.register({
    name: 'raw_export',
    summary: '把 DSH 会话原文导出成文本文件（可按 sessionId / 时间过滤）。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['path'], properties: {
        path: { type: 'string' }, sessionId: { type: 'string' },
        since: { type: 'string', description: 'ISO 时间' }, limit: { type: 'number' },
      },
    },
    async execute({ path: target, sessionId = null, since = null, limit = 1000 } = {}) {
      const sinceMs = since ? Date.parse(String(since)) : null
      const rows = list({ since: Number.isFinite(sinceMs) ? sinceMs : null, limit: Math.max(1, Number(limit) || 1000) })
        .filter((r) => !sessionId || r.sessionId === String(sessionId))
      const text = rows.map((r) => `${new Date(r.time).toLocaleString('zh-CN', { hour12: false })} ${r.role === 'user' ? '用户' : '我'}：${r.text}`).join('\n')
      try {
        fs.mkdirSync(path.dirname(String(target)), { recursive: true })
        fs.writeFileSync(String(target), text, 'utf8')
      } catch (error) { return { text: `写不进去：${String(error?.message ?? error)}` } }
      return { text: `导出了 ${rows.length} 条到 ${target}` }
    },
  })

  ctx.services.provide('dsh-raw', { search, list, size: () => load().length })
  ctx.log({ msg: 'dsh-raw.ready', root, days })
}
