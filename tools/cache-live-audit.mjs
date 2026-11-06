// A1 live 复核工具（只读 DSH 会话日志，不需要 lab/desktop 操作）：
//
//   node tools/cache-live-audit.mjs --latest-icl          # 最近一个 agentPreset=icl 的会话
//   node tools/cache-live-audit.mjs --session <sessionId> # 指定会话
//   node tools/cache-live-audit.mjs --latest-icl --expected-icl .state/cache/product-surface-audit.json
//
// 输出（JSON + 人读汇总）：
//   · request/header：工具总数、ICL 面命中/缺失（对照产品离线审计的 51 个名字）、非 ICL 工具数、
//     mcb_* 数量、toolsChars 两种口径（数组 JSON / Σ 每工具）、toolsHash（数组口径）；
//   · system/message：最后一份字符/字节、firstDiff 是否恒定（append/replace 统计）、
//     四段净化 marker 是否消失、systemHasDynamicFacts；
//   · runtime-context：facts 快照条数/轮、sections、是否含 icl:facts；
//   · image/offload 与 image block 计数。
//
// 口径与 docs/CACHE-MODEL.md §6.4 / CACHE-NIGHT §9 一致；历史数字不回改。

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { createHash } from 'node:crypto'

const arg = (name, fallback = null) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback }
const flag = (name) => process.argv.includes(name)

function sessionsRoot() {
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
  return path.join(home, 'sessions')
}

function readSession(file) {
  const buf = fs.readFileSync(file)
  const text = typeof zlib.zstdDecompressSync === 'function'
    ? zlib.zstdDecompressSync(buf).toString('utf8')
    : (() => { throw new Error('当前 Node 没有 zstdDecompressSync（需 >=22.15）') })()
  return text.split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
}

function findSession(id = null) {
  const root = sessionsRoot()
  const found = []
  for (const workspace of fs.readdirSync(root)) {
    const wsDir = path.join(root, workspace)
    if (!fs.statSync(wsDir).isDirectory()) continue
    for (const name of fs.readdirSync(wsDir)) {
      const file = path.join(wsDir, name, 'session.v4.jsonl.zstd')
      if (!fs.existsSync(file)) continue
      found.push({ id: name, workspace, file, mtime: fs.statSync(file).mtimeMs })
    }
  }
  if (id) return found.find((entry) => entry.id === id) ?? null
  // 最近一个 icl 会话
  for (const entry of found.sort((a, b) => b.mtime - a.mtime)) {
    try {
      const rows = readSession(entry.file)
      const header = rows[0]?.type === 'session' ? rows[0] : {}
      if (header.agentPreset === 'icl') return entry
    } catch { /* 跳过坏文件 */ }
  }
  return null
}

function textOf(message) {
  const content = message?.content
  if (!content) return ''
  if (typeof content === 'string') return content
  return (Array.isArray(content) ? content : []).map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('')
}

if (!flag('--latest-icl') && !arg('--session')) {
  console.error('用法：node tools/cache-live-audit.mjs --latest-icl | --session <id> [--expected-icl file]')
  process.exit(2)
}

const session = findSession(arg('--session'))
if (!session) {
  console.log(JSON.stringify({ ok: false, reason: 'no-icl-session', message: '没有找到 agentPreset=icl 的会话（可能还没在 desktop 开过 ICL 会话）' }, null, 1))
  process.exit(1)
}
const rows = readSession(session.file)
const header = rows.find((row) => row.type === 'request/header')
const systemEvents = rows.filter((row) => row.type === 'system/message')
const factsSnapshots = []
let imageOffload = 0
let imageBlocks = 0
let turns = 0
for (const row of rows) {
  if (row.type === 'turn/start') turns += 1
  if (row.type === 'image/offload') imageOffload += 1
  if (row.type === 'user/message') {
    const message = row.data?.message ?? row.data
    if (message?.source?.kind !== 'runtime-context') continue
    const text = textOf(message)
    factsSnapshots.push({
      seq: row.seq,
      chars: text.length,
      hasFacts: /时间：|阶段：/.test(text),
      sections: (message.source.sections ?? []).map((section) => section.name),
    })
  }
  if (['user/message', 'assistant/message', 'tool/result'].includes(row.type)) {
    const content = (row.data?.message ?? row.data)?.content
    if (Array.isArray(content)) for (const part of content) if (part?.type === 'image') imageBlocks += 1
  }
}

const expectedFile = path.resolve(String(arg('--expected-icl', '.state/cache/product-surface-audit.json')))
let expectedIcl = []
let expectedNote = null
if (fs.existsSync(expectedFile)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(expectedFile, 'utf8'))
    // 兼容 {toolNames:[...]} 与 {a:{toolNames}} 两种
    expectedIcl = parsed.toolNames ?? parsed.a?.toolNames ?? []
    expectedNote = expectedFile
  } catch { /* ignore */ }
}

const tools = (header?.data?.header?.tools ?? header?.data?.tools ?? [])
const names = tools.map((tool) => tool.name)
const expectedSet = new Set(expectedIcl)
const iclPresent = names.filter((name) => expectedSet.has(name))
const iclMissing = expectedIcl.filter((name) => !names.includes(name))
const nonIcl = names.filter((name) => !expectedSet.has(name))
const mcb = names.filter((name) => name.startsWith('mcb_'))
const canonical = JSON.stringify(tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })).sort((a, b) => String(a.name).localeCompare(String(b.name))))
const iclTools = tools.filter((tool) => expectedSet.has(tool.name)).sort((a, b) => String(a.name).localeCompare(String(b.name)))
const iclCanonical = JSON.stringify(iclTools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })))
const sumPerTool = (list) => list.reduce((sum, tool) => sum + JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }).length, 0)

const systemText = systemEvents.length ? textOf(systemEvents.at(-1).data?.message ?? systemEvents.at(-1).data) : ''
const lastSystem = {
  chars: systemText.length,
  bytes: Buffer.byteLength(systemText, 'utf8'),
  appends: systemEvents.filter((row) => !(row.surfaceOp && typeof row.surfaceOp === 'object' && row.surfaceOp.op === 'replace')).length,
  replaces: systemEvents.filter((row) => row.surfaceOp && typeof row.surfaceOp === 'object' && row.surfaceOp.op === 'replace').length,
  firstLine: systemText.split('\n')[0]?.slice(0, 80) ?? '',
  markers: {
    harnessIdentity: /You are an AI agent powered by DeepSeek Harness/.test(systemText),
    harnessSource: /Harness implementation checkout|implementation checkout is at/i.test(systemText),
    deliverableReferences: /deliverable|Deliverable/i.test(systemText),
    webSurface: /Web GUI at|interacting with the user through/i.test(systemText),
  },
  hasDynamicFacts: /时间：|阶段：/.test(systemText),
}

const out = {
  ok: Boolean(header),
  session: { id: session.id, workspace: session.workspace, file: session.file, preset: rows[0]?.agentPreset ?? null, model: header?.data?.header?.config?.model ?? null, provider: header?.data?.header?.config?.provider ?? null },
  events: { total: rows.length, turns, headerAt: header?.time ? new Date(Number(header.time)).toISOString() : null },
  tools: {
    total: names.length,
    mcbCount: mcb.length,
    mcbNames: mcb,
    iclExpected: expectedIcl.length,
    iclPresent: iclPresent.length,
    iclMissing,
    nonIclCount: nonIcl.length,
    nonIclNames: nonIcl,
    toolsCharsArrayJSON: canonical.length,
    toolsCharsSumPerTool: sumPerTool(tools),
    toolsHash: createHash('sha1').update(canonical).digest('hex').slice(0, 12),
    iclCharsArrayJSON: iclCanonical.length,
    iclCharsSumPerTool: sumPerTool(iclTools),
  },
  system: lastSystem,
  facts: {
    snapshots: factsSnapshots.length,
    snapshotsPerTurn: turns ? +(factsSnapshots.length / turns).toFixed(2) : null,
    sections: [...new Set(factsSnapshots.flatMap((snap) => snap.sections))],
    allHaveFacts: factsSnapshots.every((snap) => snap.hasFacts),
    chars: factsSnapshots.map((snap) => snap.chars),
  },
  image: { offload: imageOffload, imageBlocks },
  expectedIclSource: expectedNote,
}

if (!header) {
  out.ok = false
  out.blocked = 'no request/header in session (turn 可能在请求前就失败)'
}
console.log(JSON.stringify(out, null, 1))
