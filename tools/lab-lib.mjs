// lab 基建的共享层：run 状态、patch 物化、dsh 进程、HTTP API、transcript 渲染。
//
// 只被 tools/lab.mjs 与 tools/lab-observer.mjs import；不做命令行解析。
// 设计约束（见 docs/TEAM-PLAN-2026-11-05.md §2/§3）：
//   · 不碰 desktop / 不改任何 profile：lab 是 `dsh --profile web --patch <物化 patch>` 的独立进程；
//   · 一条 lab 进程只绑一条 ICL 会话（dsh-icl 的单会话锁）；换场景 = `down` 后重新 `up`；
//   · 所有状态落在 `.state/lab/<runId>/`，`.state/lab/current.json` 只存指针。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { NodeApiClient, unwrap } from '../packages/adapters/dsh-client.mjs'

/** 仓库（worktree）根：tools/ 的上一级。 */
export const REPO_ROOT = path.resolve(import.meta.dirname, '..')
export const STATE_ROOT = path.join(REPO_ROOT, '.state', 'lab')
export const PATCH_TEMPLATE = path.join(REPO_ROOT, 'packages', 'dsh-icl', 'presets', 'lab.patch.yml')
export const DEFAULT_PORT = 57101
/** mc-lab 自己的 body HTTP 端口（TEAM-PLAN §3：54900 + 序号；用户客户端/其它 owner 不占）。 */
export const DEFAULT_MC_PORT = 54900

export const PRESETS = Object.freeze({
  'icl-lab': { mc: false, description: 'ICL 全套（不含 MC）' },
  'icl-mc-lab': { mc: true, description: 'ICL + mc-link（独立 body 端口）' },
  'icl-e2': { mc: true, description: 'E2 长测专用（awakeTick 30s、工具面收敛、文案精简）' },
})

/* ── 基础工具 ─────────────────────────────────────────── */

export function nowIso(date = new Date()) {
  return date.toISOString()
}

/** runId：本地时间、秒级、文件名安全。 */
export function tsSlug(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

export function writeJson(file, value) {
  ensureDir(path.dirname(file))
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return file
}

export function readJsonl(file, { limit = Infinity } = {}) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { return [] }
  const rows = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try { rows.push(JSON.parse(line)) } catch { /* 坏行（进程被杀时可能截断）跳过 */ }
  }
  return rows.length > limit ? rows.slice(-limit) : rows
}

export function appendJsonl(file, value) {
  ensureDir(path.dirname(file))
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8')
}

export function isPidAlive(pid) {
  const n = Number(pid)
  if (!Number.isFinite(n) || n <= 0) return false
  try { process.kill(n, 0); return true } catch { return false }
}

/** 只杀自己记录过的 pid 的进程树（Windows 用 taskkill /T；POSIX 回退 SIGKILL）。 */
export function killPidTree(pid, { timeoutMs = 5000 } = {}) {
  const n = Number(pid)
  if (!isPidAlive(n)) return Promise.resolve(false)
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      const child = spawn('taskkill', ['/PID', String(n), '/T', '/F'], { stdio: 'ignore' })
      const timer = setTimeout(() => { child.kill(); resolve(false) }, timeoutMs)
      child.on('exit', () => { clearTimeout(timer); resolve(true) })
      child.on('error', () => { clearTimeout(timer); resolve(false) })
    })
  }
  try { process.kill(n, 'SIGKILL') } catch { /* 已退出 */ }
  return Promise.resolve(true)
}

/* ── run 状态 ─────────────────────────────────────────── */

export function runDirOf(runId) {
  return path.join(STATE_ROOT, runId)
}

export function currentPath() {
  return path.join(STATE_ROOT, 'current.json')
}

/** 当前 run 的指针；`alive` 表示记录的 dsh 进程是否还活着。 */
export function loadCurrent() {
  const meta = readJson(currentPath(), null)
  if (!meta) return null
  return { ...meta, alive: isPidAlive(meta.pids?.dsh), observerAlive: isPidAlive(meta.pids?.observer) }
}

export function saveCurrent(meta) {
  writeJson(currentPath(), meta)
}

export function clearCurrent(runId = null) {
  const meta = loadCurrent()
  if (!meta) return
  if (runId && meta.runId !== runId) return
  try { fs.unlinkSync(currentPath()) } catch { /* 已不存在 */ }
}

export function readRunMeta(runId) {
  return readJson(path.join(runDirOf(runId), 'lab.json'), null)
}

export function writeRunMeta(runId, meta) {
  return writeJson(path.join(runDirOf(runId), 'lab.json'), meta)
}

/* ── patch 物化 ───────────────────────────────────────── */

/**
 * 把 presets/lab.patch.yml 的占位符替换成本次 run 的绝对路径，写到 runDir 下。
 * 不能用静态文件直接 --patch：preset 的 config.plugins 不做相对路径锚定（见文件头注释）。
 */
/** mc-lab 自己的正常地形验收服（fresh normal world，不进用户 survival，不碰 flat 54837）。 */
export const LAB_MC_SERVER_PORT = Number(process.env.ICL_LAB_MC_SERVER_PORT ?? 54840)
export const LAB_MC_SERVER_NAME = 'lab-normal'

/** 已知 lab 可连的服务器名 -> host/port（`--servers` 用名字挑选，不写死只给一个服）。 */
export const KNOWN_MC_SERVERS = Object.freeze({
  'lab-normal': { host: '127.0.0.1', port: LAB_MC_SERVER_PORT, note: 'lab 专用 normal 地形验收服（fresh world）' },
  survival: { host: '127.0.0.1', port: 54838, note: '正常地形生存服；夜间长测用，用户在玩时先问' },
  flat: { host: '127.0.0.1', port: 54837, note: 'flat 调试服（不要用于最终验收）' },
})

export function materializePatch({ runDir, mcPort = DEFAULT_MC_PORT, mcUser = 'ICL-mclab-1', servers = ['lab-normal', 'flat'], workspace, serverPort = null }) {
  ensureDir(runDir)
  const template = fs.readFileSync(PATCH_TEMPLATE, 'utf8')
  const fileUrl = (p) => pathToFileURL(p).href
  const posix = (p) => p.replace(/\\/g, '/')
  const stateRoot = path.join(runDir, 'state')
  // sandbox-policy.workspaceRoot 与会话 cwd 同源；未给 workspace 时退回 runDir/workspace。
  const workspaceRoot = path.resolve(String(workspace ?? path.join(runDir, 'workspace')))
  // lab 的服务器清单（mc-link 会把它和插件自带 servers.json 合并）；按 --servers 选实际要暴露的服。
  const listed = (Array.isArray(servers) ? servers : String(servers).split(','))
    .map((name) => String(name).trim())
    .filter(Boolean)
    .map((name) => {
      const known = KNOWN_MC_SERVERS[name]
      if (!known) throw new Error(`未知 MC 服务器名：${name}（可选：${Object.keys(KNOWN_MC_SERVERS).join(', ')}）`)
      return { name, host: known.host, port: Number(serverPort) > 0 ? Number(serverPort) : known.port, note: known.note }
    })
  const serversFile = path.join(runDir, 'mc-servers.json')
  fs.writeFileSync(serversFile, `${JSON.stringify(listed, null, 2)}\n`, 'utf8')
  const output = template
    .replaceAll('__LAB_ICL_HOST__', fileUrl(path.join(REPO_ROOT, 'packages', 'dsh-icl', 'host.mjs')))
    .replaceAll('__LAB_ICL_CORE__', fileUrl(path.join(REPO_ROOT, 'packages', 'dsh-icl', 'index.mjs')))
    .replaceAll('__LAB_STATE__', posix(stateRoot))
    .replaceAll('__LAB_WORKSPACE__', posix(workspaceRoot))
    .replaceAll('__LAB_MC_BASE__', `http://127.0.0.1:${mcPort}`)
    .replaceAll('__LAB_MC_PORT__', String(mcPort))
    .replaceAll('__LAB_MC_USERNAME__', String(mcUser))
    .replaceAll('__LAB_MC_SERVERS__', posix(serversFile))
  if (/__LAB_[A-Z_]+__/.test(output)) throw new Error('lab.patch.yml 还有未替换的占位符')
  const file = path.join(runDir, 'lab.patch.yml')
  fs.writeFileSync(file, output, 'utf8')
  return file
}

/** 当前 worktree 的 commit（lab.json / transcript 证据里要记，便于复现）。 */
export function gitCommit(short = true) {
  try {
    const out = execFileSync('git', ['rev-parse', ...(short ? ['--short'] : []), 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      windowsHide: true,
    }).trim()
    return out
  } catch {
    return null
  }
}

/* ── 残留 body 清理 ───────────────────────────────────── */

/** 一整张 Windows 进程表（Get-CimInstance）；失败返回 []，不抛。 */
export function listProcesses() {
  if (process.platform !== 'win32') {
    return new Promise((resolve) => {
      const child = spawn('ps', ['-eo', 'pid=,ppid=,args='], { windowsHide: true })
      let out = ''
      child.stdout.on('data', (chunk) => { out += chunk })
      child.on('close', () => {
        const rows = []
        for (const line of out.split('\n')) {
          const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
          if (match) rows.push({ ProcessId: Number(match[1]), ParentProcessId: Number(match[2]), CommandLine: match[3] })
        }
        resolve(rows)
      })
      child.on('error', () => resolve([]))
    })
  }
  return new Promise((resolve) => {
    const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('close', () => {
      try {
        const parsed = JSON.parse(out.trim() || '[]')
        resolve(Array.isArray(parsed) ? parsed : [parsed])
      } catch { resolve([]) }
    })
    child.on('error', () => resolve([]))
  })
}

/**
 * 找本 lab 用户名对应的 mc-body 进程（含被 kill 后 mc-link 自动重启的孤儿）。
 * 只匹配命令行里同时有 mc-body 路径和用户名 token 的进程，不碰 mc-link/mc-body 的 bot。
 */
export async function findLabBodyPids(username) {
  const rows = await listProcesses()
  const needle = String(username ?? '')
  return rows
    .filter((row) => /mc-?body|cli\.mjs/i.test(String(row.CommandLine ?? '')))
    .filter((row) => needle && String(row.CommandLine ?? '').includes(needle))
    .map((row) => Number(row.ProcessId))
    .filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== process.pid)
}

/** 清掉本 lab 上一轮留下的 body（up 前 / down 后各清一次，避免同服同名互踢）。 */
export async function cleanupStrayBodies({ username = 'ICL-mclab-1', timeoutMs = 3000 } = {}) {
  const killed = []
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const pids = await findLabBodyPids(username)
    if (!pids.length) break
    for (const pid of pids) {
      await killPidTree(pid)
      killed.push(pid)
    }
    await sleep(400)
  }
  return killed
}

/* ── dsh 进程 ─────────────────────────────────────────── */

/** 找 dsh 的 bin.js（用 node 直接跑，避免 Windows 上 spawn .cmd 的 shell 问题）。 */
export function discoverDshBin() {
  const fromEnv = process.env.DSH_BIN
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv
  const candidates = []
  const appData = process.env.APPDATA
  if (appData) candidates.push(path.join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  // 启动器目录里常见的全局安装位置（用户在 PATH 上跑 dsh 时同一份）
  const localAppData = process.env.LOCALAPPDATA
  if (localAppData) candidates.push(path.join(localAppData, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar', 'dsh', 'lib', 'bin.js'))
  for (const file of candidates) if (fs.existsSync(file)) return file
  return null
}

/** 后台启动 dsh（detached：lab CLI 退出后它继续活着）。 */
export function spawnDsh({ bin, patch, port, cwd = REPO_ROOT, logDir, extraEnv = {} }) {
  ensureDir(logDir)
  const outFile = path.join(logDir, 'dsh.out.log')
  const errFile = path.join(logDir, 'dsh.err.log')
  const outFd = fs.openSync(outFile, 'a')
  const errFd = fs.openSync(errFile, 'a')
  const args = [bin, '--profile', 'web', '--patch', patch, '--port', String(port), '--no-open']
  const child = spawn(process.execPath, args, {
    cwd,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', outFd, errFd],
    env: { ...process.env, ...extraEnv },
  })
  child.unref()
  fs.closeSync(outFd)
  fs.closeSync(errFd)
  return { pid: child.pid, outFile, errFile }
}

/** 后台启动 observer（同样 detached）。 */
export function spawnObserver({ runDir, port, sessionId, logDir }) {
  ensureDir(logDir)
  const outFile = path.join(logDir, 'observer.out.log')
  const errFile = path.join(logDir, 'observer.err.log')
  const outFd = fs.openSync(outFile, 'a')
  const errFd = fs.openSync(errFile, 'a')
  const script = path.join(REPO_ROOT, 'tools', 'lab-observer.mjs')
  const args = [script, '--run-dir', runDir, '--port', String(port), '--session', String(sessionId)]
  const child = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', outFd, errFd],
  })
  child.unref()
  fs.closeSync(outFd)
  fs.closeSync(errFd)
  return { pid: child.pid, outFile, errFile }
}

/* ── HTTP API ─────────────────────────────────────────── */

export function apiFor(port, { timeoutMs = 120_000 } = {}) {
  return new NodeApiClient(`http://127.0.0.1:${port}`, timeoutMs, {})
}

/** 端口是否已经被任何进程占用（有 HTTP 响应就算占用；连接被拒才算空闲）。 */
export async function portBusy(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1200) })
    await res.body?.cancel()
    return true
  } catch {
    return false
  }
}

/** 等 DSH 的 API 可用（鉴权也通过才算 ready）。 */
export async function waitApiReady(api, { timeoutMs = 120_000, shouldAbort = null } = {}) {
  const started = Date.now()
  let lastError = null
  while (Date.now() - started < timeoutMs) {
    if (shouldAbort?.()) throw new Error('dsh 进程在就绪前退出')
    try {
      const value = unwrap(await api.callUnary('session/list', {}, undefined), 'session/list')
      return value
    } catch (error) {
      lastError = error
      await sleep(400)
    }
  }
  throw new Error(`等 DSH API 就绪超时（${timeoutMs}ms）：${String(lastError?.message ?? lastError)}`)
}

export async function createLabSession(api, { preset, workspace, title }) {
  ensureDir(workspace)
  const ws = unwrap(await api.callUnary('workspace/create', { path: workspace }, undefined), 'workspace/create')
  const workspaceId = ws?.workspace?.workspaceId ?? ws?.workspaceId
  if (!workspaceId) throw new Error(`workspace/create 没有返回 workspaceId：${JSON.stringify(ws).slice(0, 300)}`)
  const created = unwrap(await api.callUnary('session/create', {
    workspaceId,
    agentPreset: preset,
    title,
  }, undefined, 'long'), 'session/create')
  const sessionId = created?.sessionId ?? created?.id
  if (!sessionId) throw new Error(`session/create 没有返回 sessionId：${JSON.stringify(created).slice(0, 300)}`)
  return { workspaceId, sessionId }
}

export async function selectModel(api, sessionId, { provider, model, reasoningEffort = null }) {
  // session/selectModel 的可选 reasoningEffort（DSH 0.2 请求 schema 支持；不传则用 profile/model 默认）。
  const request = { sessionId, provider, model, ...(reasoningEffort ? { reasoningEffort: String(reasoningEffort) } : {}) }
  const value = unwrap(await api.callUnary('session/selectModel', request, undefined, 'long'), 'session/selectModel')
  return value
}

export async function promptSession(api, sessionId, text) {
  const out = await api.callUnary('session/prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: String(text) }],
  }, undefined, 'long')
  const accepted = out?.result?.value?.accepted ?? out?.result?.accepted
  if (out?.result?.ok === false) throw new Error(`prompt 被拒：${JSON.stringify(out.result.error).slice(0, 400)}`)
  if (accepted === false) throw new Error(`prompt 未被接受：${JSON.stringify(out?.result).slice(0, 400)}`)
  return out
}

/* ── 事件与文本 ───────────────────────────────────────── */

export function textOfContent(content) {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (typeof part === 'string' ? part : part?.text ?? ''))
    .filter(Boolean)
    .join('\n')
}

export function textOfMessage(message) {
  return textOfContent(message?.content)
}

/** 一条 session/event 里模型/用户实际看到的文本。 */
export function eventText(event) {
  const data = event?.data ?? {}
  if (event?.type === 'user/message') return textOfMessage(data)
  return textOfMessage(data.message ?? data)
}

/**
 * 展开 events.jsonl：支持 session/snapshot（开场历史）与 session/event 两种信封，
 * 按 seq 去重并按 seq 排序（没有 seq 的事件保留到达顺序）。
 * @returns {{events: object[], envelopeCount: number, duplicates: number}}
 */
export function normalizeEvents(envelopes) {
  const seen = new Set()
  const rows = []
  let duplicates = 0
  const push = (event) => {
    if (!event || typeof event.type !== 'string') return
    const key = event.seq != null ? `s:${event.seq}` : `n:${event.type}:${event.time}:${rows.length}`
    if (seen.has(key)) { duplicates += 1; return }
    seen.add(key)
    rows.push(event)
  }
  for (const envelope of envelopes) {
    const payload = envelope?.payload ?? envelope
    if (!payload) continue
    if (payload.type === 'session/snapshot') {
      for (const record of payload.snapshot?.records ?? []) {
        if (record?.type === 'event') push(record.event)
      }
    } else if (payload.type === 'session/event') {
      push(payload.event)
    }
  }
  rows.sort((a, b) => {
    const sa = Number(a.seq)
    const sb = Number(b.seq)
    if (Number.isFinite(sa) && Number.isFinite(sb)) return sa - sb
    if (Number.isFinite(sa)) return -1
    if (Number.isFinite(sb)) return 1
    return 0
  })
  return { events: rows, envelopeCount: envelopes.length, duplicates }
}

export function countTurnEnds(eventsFile) {
  return readJsonl(eventsFile).reduce((n, envelope) => {
    const payload = envelope?.payload ?? envelope
    if (payload?.type === 'session/event' && payload.event?.type === 'turn/end') return n + 1
    if (payload?.type === 'session/snapshot') {
      const hit = (payload.snapshot?.records ?? []).filter((r) => r?.type === 'event' && r.event?.type === 'turn/end').length
      return n + hit
    }
    return n
  }, 0)
}

/* ── transcript ──────────────────────────────────────── */

const SOURCE_LABEL = {
  user: '用户',
  'runtime-context': '运行时上下文',
  tool: '工具',
  system: '系统',
}

function sourceKind(event) {
  if (event?.type === 'user/message') return String(event?.data?.source?.kind ?? 'user')
  return String(event?.data?.message?.source?.kind ?? event?.data?.source?.kind ?? '')
}

function sourceLabel(kind) {
  if (SOURCE_LABEL[kind]) return SOURCE_LABEL[kind]
  if (kind.startsWith('plugin:')) return `插件(${kind.slice(7)})`
  return kind || '未知'
}

function clip(text, max = 400) {
  const one = String(text ?? '').replace(/\r/g, '')
  if (one.length <= max) return one
  return `${one.slice(0, max)}… (+${one.length - max} 字)`
}

function indent(text, prefix = '  ') {
  return String(text ?? '')
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n')
}

function foldTurns(events) {
  const turns = []
  const preamble = []
  let current = null
  for (const event of events) {
    if (event.type === 'turn/start') {
      current = { turn: Number(event.data?.turn) || turns.length + 1, startEvent: event, events: [] }
      turns.push(current)
      continue
    }
    if (current) current.events.push(event)
    else preamble.push(event)
    if (event.type === 'turn/end') current = null
  }
  return { turns, preamble }
}

function summarizeTurn(turn) {
  const events = turn.events
  const startEvent = turn.startEvent ?? null
  const inputs = []
  const injected = []
  const notices = []
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const kind = sourceKind(event)
    const row = { event, kind, text: eventText(event) }
    if (kind === 'user') inputs.push(row)
    else if (kind === 'runtime-context') injected.push(row)
    else notices.push(row)
  }
  const systems = events.filter((event) => event.type === 'system/message').map((event) => ({ event, text: eventText(event) }))
  const headers = events.filter((event) => event.type === 'request/header')
  const calls = events.filter((event) => event.type === 'tool/call')
  const results = events.filter((event) => event.type === 'tool/result')
  const assistants = events.filter((event) => event.type === 'assistant/message')
  const end = events.find((event) => event.type === 'turn/end') ?? null

  const byCallId = new Map()
  for (const call of calls) byCallId.set(String(call.data?.callId ?? ''), call)
  const toolRows = calls.map((call) => {
    const callId = String(call.data?.callId ?? '')
    const result = results.find((row) => {
      const id = String(row.data?.toolCallId ?? row.data?.message?.toolCallId ?? '')
      if (id && callId) return id === callId
      const seqs = row.data?.sourceEventSeqs
      return Array.isArray(seqs) && seqs.includes(call.seq)
    }) ?? null
    return {
      name: String(call.data?.name ?? call.data?.tool ?? ''),
      arguments: typeof call.data?.arguments === 'string' ? call.data.arguments : JSON.stringify(call.data?.arguments ?? null),
      call,
      result,
      text: result ? eventText(result) : '',
      isError: Boolean(result?.data?.message?.isError ?? result?.data?.isError),
      ms: result && Number.isFinite(Number(call.time)) && Number.isFinite(Number(result.time))
        ? Number(result.time) - Number(call.time)
        : null,
    }
  })
  // 有 result 却找不到 call 的（旧快照截断）：也列出来，避免结果凭空消失
  const orphanResults = results.filter((row) => {
    const id = String(row.data?.toolCallId ?? row.data?.message?.toolCallId ?? '')
    if (id && byCallId.has(id)) return false
    const seqs = row.data?.sourceEventSeqs
    if (Array.isArray(seqs) && seqs.some((seq) => calls.some((call) => call.seq === seq))) return false
    return true
  })
  let assistantText = ''
  let reasoningChars = 0
  for (const message of assistants) {
    for (const block of message.data?.message?.content ?? []) {
      if (block?.type === 'text' && typeof block.text === 'string') assistantText += block.text
      if (block?.type === 'reasoning' && typeof block.text === 'string') reasoningChars += block.text.length
    }
  }
  let systemChars = 0
  for (const item of systems) systemChars += item.text.length
  let injectedChars = 0
  let iclContextChars = 0
  for (const item of injected) {
    injectedChars += item.text.length
    if (item.text.trimStart().startsWith('<icl-context>')) iclContextChars += item.text.length
  }
  const header = headers.length ? headers[headers.length - 1].data?.header ?? null : null
  const tools = Array.isArray(header?.tools) ? header.tools : null
  const toolsHash = tools ? createHash('sha1').update(JSON.stringify(tools)).digest('hex').slice(0, 12) : null
  const toolsChars = tools ? JSON.stringify(tools).length : null
  return {
    startEvent, inputs, injected, notices, systems, headers, calls, results, assistants, orphanResults,
    end, toolRows, assistantText, reasoningChars, systemChars, injectedChars, iclContextChars, header,
    toolsHash, toolsChars,
  }
}

function fmtTime(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return '—'
  const d = new Date(n)
  const pad = (x) => String(x).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * 把 events.jsonl + ICL 状态侧证渲染成人可读 transcript。
 * 这是**纯函数**（除读侧证文件外）：observer 增量重写与 `lab export` 全量重建共用同一实现。
 */
export function renderTranscript({ meta, envelopes, sidecars }) {
  const { events, envelopeCount, duplicates } = normalizeEvents(envelopes)
  const { turns, preamble } = foldTurns(events)
  const pre = summarizeTurn({ turn: 0, events: preamble })
  const lines = []
  const push = (line = '') => lines.push(line)

  push(`# ICL lab transcript — ${meta.runId}`)
  push()
  push(`- 端口：${meta.port} · preset：\`${meta.preset}\` · worktree commit：\`${meta.commit ?? '?'}\``)
  push(`- 目标模型：${meta.model?.provider ?? '?'} / ${meta.model?.model ?? '?'}（${meta.model?.source ?? '?'}）`)
  const actualHeader = events.filter((event) => event.type === 'request/header').at(-1)?.data?.header ?? null
  if (actualHeader) {
    const actual = `${actualHeader.config?.provider ?? '?'} / ${actualHeader.config?.model ?? '?'}`
    const target = `${meta.model?.provider ?? '?'} / ${meta.model?.model ?? '?'}`
    const drift = actual !== target
    push(`- 实际请求模型（最后一个 request/header）：${actual}${drift ? `⚠️ 与目标不一致（目标 ${target}）` : '（与目标一致）'}`)
  } else {
    push('- 实际请求模型：还没有 request/header（还没发过话）')
  }
  push(`- 会话：\`${meta.sessionId ?? '(未创建)'}\` · workspace：\`${meta.workspaceId ?? '?'}\``)
  push(`- 启动：${meta.startedAt ?? '?'}${meta.endedAt ? ` · 结束：${meta.endedAt}` : ' · 状态：运行中'}`)
  push(`- 目录：\`${meta.runDir ?? ''}\``)
  push(`- 事件：${events.length} 条（信封 ${envelopeCount}，重复 ${duplicates}） · 回合：${turns.length}`)
  const toolTotal = turns.reduce((n, turn) => n + turn.events.filter((event) => event.type === 'tool/call').length, 0)
  push(`- 工具调用：${toolTotal}`)
  push()
  push('> 证据口径：`events.jsonl` 的 `session/event` 是权威源；模型自述只作当事人反馈（docs/LOOP.md §9）。')
  push('>')
  push('> 体积口径：**系统** = `system/message` 的字符数（cache 方案 B 之后只剩静态人格+仿真段）；')
  push('> **运行时上下文快照** = `user/message` 且 source.kind=runtime-context（DSH 自带 + ICL 事实段）；**ICL 注入** = 其中 `<icl-context>` 那段。')
  push('> 每轮都带 `toolsHash`（工具定义 JSON 的 sha1 前 12 位）——它变了说明工具面发生字节变化，缓存会受影响。')
  push()

  const renderSummary = (summary, labelPrefix, seqHint) => {
    // 系统提示词
    if (summary.systems.length) {
      for (const item of summary.systems) {
        push(`- ${labelPrefix}**系统提示词** seq=${item.event.seq} · ${item.text.length} 字符 → \`context/system-${item.event.seq}.txt\``)
        const head = item.text.replace(/\s+/g, ' ').slice(0, 220)
        push(indent(`…${head}…`))
      }
    }
    if (summary.header) {
      const config = summary.header.config ?? {}
      const toolCount = summary.header.tools?.length
      push(`- ${labelPrefix}**请求头** provider=${config.provider ?? '?'} model=${config.model ?? '?'} maxTokens=${config.maxTokens ?? '?'} · tools=${toolCount ?? '?'}${summary.toolsHash ? ` toolsHash=${summary.toolsHash}` : ''}${summary.toolsChars ? ` toolsChars=${summary.toolsChars}` : ''}`)
    }
    for (const input of summary.inputs) {
      push(`- ${labelPrefix}**输入** seq=${input.event.seq} 来源=${sourceLabel(input.kind)}`)
      push(indent(clip(input.text, 1200)))
    }
    for (const item of summary.injected) {
      const isIcl = item.text.trimStart().startsWith('<icl-context>')
      const sections = Array.isArray(item.event.data?.source?.sections)
        ? item.event.data.source.sections.map((section) => section?.name).filter(Boolean)
        : []
      push(`- ${labelPrefix}**${isIcl ? 'ICL 注入上下文' : '运行时上下文快照'}** seq=${item.event.seq} · ${item.text.length} 字符${sections.length ? ` · 段=${sections.join(',')}` : ''}`)
      push(indent(clip(item.text, 600)))
    }
    for (const item of summary.notices) {
      push(`- ${labelPrefix}**插件消息** seq=${item.event.seq} 来源=${sourceLabel(item.kind)}`)
      push(indent(clip(item.text, 800)))
    }
    if (summary.toolRows.length || summary.orphanResults.length) {
      push(`- ${labelPrefix}**工具**（${summary.toolRows.length + summary.orphanResults.length}）`)
      for (const row of summary.toolRows) {
        const took = row.ms == null ? '' : ` · ${row.ms}ms`
        const status = row.result ? (row.isError ? '✗ error' : '✓') : '… 无结果'
        push(`  - \`${row.name}\` seq=${row.call.seq}${took} ${status} 参数 \`${clip(row.arguments, 240).replace(/\n/g, ' ')}\``)
        if (row.result) push(indent(`↳ ${clip(row.text, 600)}`, '    '))
      }
      for (const result of summary.orphanResults) {
        push(`  - (结果无对应调用) seq=${result.seq}`)
        push(indent(`↳ ${clip(eventText(result), 600)}`, '    '))
      }
    }
    if (summary.assistantText || summary.reasoningChars) {
      const seqs = summary.assistants.map((event) => event.seq).join(',')
      push(`- ${labelPrefix}**回复** seqs=[${seqs}]· reasoning ${summary.reasoningChars} 字符`)
      push(indent(clip(summary.assistantText || '(本轮无文本)', 2000)))
    }
    const end = summary.end
    if (end) {
      const reason = end.data?.reason?.kind ?? end.data?.reason ?? '?'
      const took = summary.startEvent && Number(end.time) && Number(summary.startEvent.time)
        ? Number(end.time) - Number(summary.startEvent.time)
        : null
      push(`- ${labelPrefix}**turn/end** seq=${end.seq} · ${fmtTime(end.time)} · reason=${reason}${took ? ` · ${(took / 1000).toFixed(1)}s` : ''}`)
    }
    const volume = [
      `系统 ${summary.systemChars} 字符`,
      `ICL 注入 ${summary.iclContextChars} 字符`,
      `DSH 运行时 ${summary.injectedChars - summary.iclContextChars} 字符`,
      `工具 ${summary.toolRows.length}`,
      summary.toolsHash ? `toolsHash=${summary.toolsHash}` : null,
    ].filter(Boolean).join(' · ')
    push(`- ${labelPrefix}**本轮体积**：${volume}${seqHint ?? ''}`)
  }

  if (pre.inputs.length || pre.systems.length || pre.toolRows.length) {
    push('## 会话建立前')
    push()
    renderSummary(pre, '')
    push()
  }

  for (const turn of turns) {
    const summary = summarizeTurn(turn)
    push(`## Turn ${turn.turn} — ${fmtTime(turn.startEvent?.time)} · seq ${turn.startEvent?.seq ?? '?'} → ${summary.end?.seq ?? '?(未结束)'}`)
    push()
    renderSummary(summary, '')
    push()
    if (!summary.inputs.length && !summary.toolRows.length && !summary.assistantText) {
      push('_(本回合没有用户输入/工具/文本；可能是唤醒或插件投递)_')
      push()
    }
  }

  if (!turns.length) {
    push('## 还没有回合')
    push()
    push('会话已建立但没有收到 turn。用 `node tools/lab.mjs say "..." ` 往会话里发一句话。')
    push()
  }

  // 状态侧证：ICL 自己写的事件 + time/focus/mc-link 状态
  push('## 状态侧证（ICL 内部，不当作模型自述的证据）')
  push()
  for (const item of sidecars ?? []) {
    push(`### ${item.label}`)
    push()
    if (item.missing) {
      push(`- 文件不存在或为空：\`${item.file}\``)
      push()
      continue
    }
    push(`- 文件：\`${item.file}\``)
    if (item.note) push(`- ${item.note}`)
    push('```')
    push(item.text)
    push('```')
    push()
  }
  return lines.join('\n')
}

/** 读 ICL 侧证（time/focus/mc-link/原文），给 transcript 用。 */
export function collectSidecars(meta) {
  const stateDir = path.join(meta.runDir ?? '', 'state', meta.preset)
  const out = []
  const rawFile = path.join(stateDir, 'session-events.jsonl')
  const raw = readJsonl(rawFile, { limit: 10 })
  const count = readJsonl(rawFile).length
  if (!raw.length) out.push({ label: 'ICL 原文 session-events.jsonl', file: rawFile, missing: true })
  else {
    out.push({
      label: `ICL 原文 session-events.jsonl（共 ${count} 条，最近 10 条）`,
      file: rawFile,
      text: raw.map((row) => `${fmtTime(row.time)} ${row.role}/${row.name || row.sender || '-'} seq=${row.seq} · ${clip(row.text, 160).replace(/\n/g, ' ')}`).join('\n'),
    })
  }
  for (const [name, label] of [['time.json', 'time 状态'], ['focus.json', 'focus 状态']]) {
    const file = path.join(stateDir, name)
    const data = readJson(file, null)
    out.push({ label, file, missing: data == null, text: data == null ? '' : JSON.stringify(data, null, 1) })
  }
  const mcFile = path.join(stateDir, 'mc-link.jsonl')
  const mcRows = readJsonl(mcFile, { limit: 12 })
  out.push({
    label: 'mc-link.jsonl（最近 12 条）',
    file: mcFile,
    missing: !mcRows.length,
    text: mcRows.map((row) => clip(JSON.stringify(row), 240)).join('\n'),
  })
  return out
}

/** 从 events.jsonl + 侧证重建 transcript.md（并落 context/*.txt 系统提示词快照）。 */
export function rebuildTranscript(runDir) {
  const meta = readRunMeta(path.basename(runDir)) ?? { runId: path.basename(runDir), runDir }
  const eventsFile = path.join(runDir, 'events.jsonl')
  const envelopes = readJsonl(eventsFile)
  const contextDir = ensureDir(path.join(runDir, 'context'))
  // 每轮的 system 提示词落盘，供 cache 做前缀 diff
  const { events } = normalizeEvents(envelopes)
  for (const event of events) {
    if (event.type !== 'system/message') continue
    try { fs.writeFileSync(path.join(contextDir, `system-${event.seq}.txt`), eventText(event), 'utf8') } catch { /* 单个快照写失败不影响 transcript */ }
  }
  const text = renderTranscript({ meta: { ...meta, runDir }, envelopes, sidecars: collectSidecars({ ...meta, runDir }) })
  const file = path.join(runDir, 'transcript.md')
  // 原子替换：observer 与 `lab export` 可能同时重建，不能让读方看到半截文件。
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, `${text}\n`, 'utf8')
  fs.renameSync(tmp, file)
  return { file, events: events.length }
}

/** 从 events.jsonl 取有序事件（按 seq 去重排序；snapshot 与增量都算）。 */
export function orderedEvents(eventsFile) {
  const seen = new Set()
  const rows = []
  for (const envelope of readJsonl(eventsFile)) {
    const payload = envelope?.payload ?? envelope
    const push = (event) => {
      if (!event?.type) return
      if (event.seq != null) {
        if (seen.has(event.seq)) return
        seen.add(event.seq)
      }
      rows.push(event)
    }
    if (payload?.type === 'session/event') push(payload.event)
    else if (payload?.type === 'session/snapshot') for (const record of payload.snapshot?.records ?? []) if (record?.type === 'event') push(record.event)
  }
  return rows.sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0))
}

/**
 * 最后一轮的事件窗口与体积统计。
 * 不用 `data.turn` 定位用户消息（user/message 上没有 turn），而是从最后一个 turn/end 往前找同 turn 的 turn/start。
 */
export function lastTurnWindow(eventsFile) {
  const events = orderedEvents(eventsFile)
  let endIndex = -1
  for (let i = events.length - 1; i >= 0; i -= 1) if (events[i].type === 'turn/end') { endIndex = i; break }
  if (endIndex < 0) return null
  const end = events[endIndex]
  const turn = end.data?.turn
  let startIndex = -1
  for (let i = endIndex - 1; i >= 0; i -= 1) {
    if (events[i].type === 'turn/start' && events[i].data?.turn === turn) { startIndex = i; break }
  }
  const window = events.slice(Math.max(0, startIndex), endIndex + 1)
  const header = window.filter((event) => event.type === 'request/header').at(-1)?.data?.header ?? null
  const tools = Array.isArray(header?.tools) ? header.tools : null
  const systemChars = window.filter((event) => event.type === 'system/message')
    .reduce((n, event) => n + textOfMessage(event.data?.message).length, 0)
  const runtimeContext = window.filter((event) => event.type === 'user/message' && String(event.data?.source?.kind ?? 'user') === 'runtime-context')
  const contextChars = runtimeContext.reduce((n, event) => n + textOfMessage(event.data).length, 0)
  const iclContextChars = runtimeContext.reduce((n, event) => n + (textOfMessage(event.data).trimStart().startsWith('<icl-context>') ? textOfMessage(event.data).length : 0), 0)
  let assistantText = ''
  for (const event of window) {
    if (event.type !== 'assistant/message') continue
    for (const block of event.data?.message?.content ?? []) if (block?.type === 'text') assistantText += block.text ?? ''
  }
  const calls = window.filter((event) => event.type === 'tool/call').map((event) => String(event.data?.name ?? ''))
  return {
    turn,
    start: window[0] ?? null,
    end,
    seqs: [window[0]?.seq ?? null, end.seq],
    tools: calls,
    assistant: assistantText,
    systemChars,
    contextChars,
    iclContextChars,
    request: header ? {
      provider: header.config?.provider,
      model: header.config?.model,
      tools: header.tools?.length ?? null,
      maxTokens: header.config?.maxTokens ?? null,
      toolsHash: tools ? createHash('sha1').update(JSON.stringify(tools)).digest('hex').slice(0, 12) : null,
      toolsChars: tools ? JSON.stringify(tools).length : null,
    } : null,
    events: window.length,
  }
}

export { unwrap }
