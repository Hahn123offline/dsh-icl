// DSH 会话日志只读工具：给前缀缓存分析用。
//
// DSH 把每个会话写成 ~/.dsh/sessions/<workspace-slug>/<session-id>/session.v4.jsonl.zstd。
// 事件流里什么都有：request/header（模型 + 工具声明快照）、system/message（系统提示词全文，
// 每次 replace/append 都是一条）、user/assistant/tool 消息、turn/step 边界。也就是说
// **模型每轮实际看到的请求可以从事件流重建**——不需要代理截包，也不要动用户的 DSH 实例。
//
//   node tools/cache-log.mjs sessions [--root <sessionsRoot>] [--preset icl]
//   node tools/cache-log.mjs show <sessionId> [--root ..] [--limit 20]
//   node tools/cache-log.mjs dump <sessionId> --out file.jsonl
//   node tools/cache-log.mjs requests <sessionId> [--out dir]   重建每步请求并输出前缀 diff
//
// 本文件只读：不写会话目录，不改 DSH。

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

export function defaultSessionsRoot() {
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
  return path.join(home, 'sessions')
}

function readSessionFile(dir) {
  const direct = path.join(dir, 'session.v4.jsonl.zstd')
  const file = fs.existsSync(direct) ? direct : dir
  const buf = fs.readFileSync(file)
  // v4 会话是 zstd；Node 22.15+ 有 zlib.zstdDecompressSync。低版本给出清晰报错。
  if (typeof zlib.zstdDecompressSync !== 'function') throw new Error('当前 Node 没有 zlib.zstdDecompressSync（需要 Node >= 22.15）')
  const text = zlib.zstdDecompressSync(buf).toString('utf8')
  const rows = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try { rows.push(JSON.parse(line)) } catch { /* 坏行跳过 */ }
  }
  return rows
}

function listSessionDirs(root) {
  const out = []
  if (!fs.existsSync(root)) return out
  for (const workspace of fs.readdirSync(root)) {
    const wsDir = path.join(root, workspace)
    if (!fs.statSync(wsDir).isDirectory()) continue
    for (const id of fs.readdirSync(wsDir)) {
      const dir = path.join(wsDir, id)
      const file = path.join(dir, 'session.v4.jsonl.zstd')
      if (!fs.existsSync(file)) continue
      const stat = fs.statSync(file)
      out.push({ workspace, id, dir, file, size: stat.size, mtime: stat.mtimeMs })
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

function headerOf(rows) {
  const header = rows.find((r) => r.type === 'session/header') ?? rows.find((r) => r.type === 'session') ?? {}
  const data = header.data ?? header
  // v4 的会话头在第一条 {type:'session'} 上：{id, createdAt, cwd, agentPreset, ...}
  return { ...header, ...data, id: data.id ?? header.id }
}

function textOfMessage(message) {
  const content = message?.content
  if (!content) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (typeof part === 'string' ? part : part?.text || ''))
    .filter(Boolean)
    .join('\n')
}

/** 事件流 → 每步请求的（系统提示词, 消息列表）。用 surface 语义：replace 覆盖同 seq 节点。 */
export function requestsFromEvents(rows) {
  const systemNodes = new Map() // seq -> text
  const surface = [] // { seq, type, text, message }
  const nodes = new Map() // seq -> surface entry
  const steps = []
  let current = null
  const header = headerOf(rows)
  for (const row of rows) {
    const type = row?.type
    const data = row?.data ?? {}
    if (type === 'step/start') {
      current = { turn: data.turn, step: data.step, system: '', messages: [] }
      continue
    }
    if (!current) continue
    if (type === 'system/message') {
      const text = textOfMessage(data.message)
      const op = row.surfaceOp
      if (op && typeof op === 'object' && op.op === 'replace') systemNodes.set(op.startSeq ?? op.seq ?? row.seq, text)
      else systemNodes.set(row.seq, text)
    } else if (type === 'user/message' || type === 'assistant/message' || type === 'tool/result') {
      // 只关心模型可见的 surface 追加；replace 会带 surfaceOp
      const op = row.surfaceOp
      const entry = { seq: row.seq, type, message: data.message ?? data, text: textOfMessage(data.message ?? data), op: op ?? 'append' }
      if (op && typeof op === 'object' && op.op === 'replace') {
        const start = op.startSeq ?? op.seq
        const end = op.endSeq ?? start
        for (const [seq, node] of nodes) if (seq >= start && seq <= end) nodes.delete(seq)
        surface.splice(0, surface.length, ...[...nodes.values()].sort((a, b) => a.seq - b.seq))
      } else {
        nodes.set(row.seq, entry)
        surface.push(entry)
      }
    } else if (type === 'session/event' && data.event) {
      // 有些版本把事件包一层
    }
    if (type === 'step/start') continue
    // step 边界：request/header 与 assistant/message 都出现在 step 内
    if (type === 'request/header') {
      current.requestHeader = data.header ?? data
    }
    if (type === 'assistant/message' || type === 'step/end') {
      // 收集当前步骤的请求快照（step/end 时 surface 已含本步消息）
      current.system = [...systemNodes.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t).filter(Boolean).join('\n\n@@SYSTEM-REPLACE@@\n\n')
      current.messages = surface.map((entry) => ({ seq: entry.seq, type: entry.type, role: entry.message?.role ?? entry.type, source: entry.message?.source?.kind ?? null, text: entry.text }))
      steps.push({ ...current })
      current = null
    }
  }
  return { header, steps }
}

function summarizeSession(rows) {
  const header = headerOf(rows)
  const counts = {}
  for (const row of rows) counts[row.type] = (counts[row.type] ?? 0) + 1
  return {
    id: header.id ?? header.sessionId ?? null,
    preset: header.agentPreset ?? null,
    title: header.title ?? null,
    cwd: header.cwd ?? null,
    model: header.model ?? header.defaultModel ?? null,
    events: rows.length,
    counts,
    firstTime: Number(rows[0]?.time ?? 0) || null,
    lastTime: Number(rows.at(-1)?.time ?? 0) || null,
  }
}

/* ── CLI ─────────────────────────────────────────────── */

function main() {
  const args = process.argv.slice(2)
  const cmd = args[0]
  const arg = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback }
  const root = path.resolve(String(arg('--root', defaultSessionsRoot())))
  if (cmd === 'sessions') {
    const presetFilter = arg('--preset', null)
    const rows = []
    for (const entry of listSessionDirs(root)) {
      try {
        const rows2 = readSessionFile(entry.dir)
        const summary = summarizeSession(rows2)
        if (presetFilter && summary.preset !== presetFilter) continue
        rows.push({ ...summary, workspace: entry.workspace, size: entry.size, mtime: new Date(entry.mtime).toISOString() })
      } catch (error) { rows.push({ workspace: entry.workspace, id: entry.id, error: String(error?.message ?? error) }) }
    }
    for (const row of rows.slice(0, Number(arg('--limit', '60')))) {
      if (row.error) { console.log(`${row.id}\tERR ${row.error}`); continue }
      console.log([row.mtime, row.preset ?? '-', row.id, `${row.events}ev`, `${row.size}B`, JSON.stringify(row.title ?? '').slice(0, 40)].join('\t'))
    }
    return
  }
  const sessionId = args[1]
  if (!sessionId) throw new Error('需要 sessionId')
  const hit = listSessionDirs(root).find((entry) => entry.id === sessionId)
  if (!hit) throw new Error(`找不到会话 ${sessionId}（root=${root}）`)
  const rows = readSessionFile(hit.dir)
  if (cmd === 'show') {
    const summary = summarizeSession(rows)
    console.log(JSON.stringify(summary, null, 1))
    const systems = rows.filter((row) => row.type === 'system/message')
    console.log(`system/message: ${systems.length} 次（前 2 次各 ${systems.slice(0, 2).map((row) => textOfMessage(row.data?.message).length).join('/')} 字符）`)
    const headers = rows.filter((row) => row.type === 'request/header')
    console.log(`request/header: ${headers.length} 次；工具数 ${headers[0]?.data?.header?.tools?.length ?? headers[0]?.data?.tools?.length ?? '?'}`)
    return
  }
  if (cmd === 'dump') {
    const out = arg('--out', null)
    const text = rows.map((row) => JSON.stringify(row)).join('\n')
    if (out) { fs.writeFileSync(out, text, 'utf8'); console.log(`wrote ${out} (${rows.length} events)`) } else console.log(text)
    return
  }
  if (cmd === 'requests') {
    const { steps } = requestsFromEvents(rows)
    console.log(`steps: ${steps.length}`)
    for (const [index, step] of steps.entries()) {
      const sysLen = step.system.length
      const msgChars = step.messages.reduce((sum, message) => sum + message.text.length, 0)
      console.log(`#${index + 1} t${step.turn}s${step.step} system=${sysLen}ch msgs=${step.messages.length} (${msgChars}ch) roles=${step.messages.map((m) => m.role[0]).join('')}`)
    }
    const out = arg('--out', null)
    if (out) { fs.mkdirSync(out, { recursive: true }); for (const [index, step] of steps.entries()) fs.writeFileSync(path.join(out, `step-${String(index + 1).padStart(3, '0')}.json`), JSON.stringify(step, null, 1), 'utf8'); console.log(`wrote ${steps.length} steps to ${out}`) }
    return
  }
  throw new Error(`未知命令 ${cmd}`)
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  try { main() } catch (error) { console.error('失败：', String(error?.message ?? error)); process.exit(1) }
}
