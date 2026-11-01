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

function messagesFrom(text) {
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
    out.push({ time: t, text: body.replace(/\s+/g, ' ').trim().slice(0, 600), role: obj.type === 'user/message' ? 'user' : 'assistant' })
  }
  return out
}

export function apply(ctx) {
  const root = String(ctx.config.sessionsRoot ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'sessions'))
  const days = Math.max(1, Number(ctx.config.days ?? 30))
  const maxFiles = Math.max(1, Number(ctx.config.maxFiles ?? 400))
  let cache = null

  function load() {
    if (cache) return cache
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
      try { messages.push(...messagesFrom(decode(file))) } catch { /* ignore */ }
    }
    cache = messages
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
    return scored.slice(0, Math.max(1, Number(limit) || 2)).map((x) => ({ text: x.m.text, time: x.m.time, role: x.m.role }))
  }

  ctx.services.raw.register({ id: 'dsh-sessions', search })
  ctx.services.provide('dsh-raw', { search, size: () => load().length })
  ctx.log({ msg: 'dsh-raw.ready', root, days })
}
