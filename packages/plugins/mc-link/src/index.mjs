// MC 统一交互适配器：11 个常驻工具 + 按需技能文档。
//
// 分工（MC-CONTRACT §1）：这里是"头脑侧的接缝"，只懂 mc-body/v1 HTTP，不 import mineflayer。
// 三个文件：
//   index.mjs     —— 工具面、提示词段、轮询/状态、signals 投递
//   lifecycle.mjs —— body 子进程生命周期（启动/健康检查/崩溃上报/退出清理）
//   events.mjs    —— body 事件 → 会话信号的分级、合并、限流
//
// 提示词分层（docs/PROMPT-CONTRACT.md）：人格/仿真在全局；这里只留**事实状态**（mc:status、
// mc:skills），操作教学在工具 description 与 skills/*.md（mcb_help 按需读）。
import fs from 'node:fs'
import path from 'node:path'
import dgram from 'node:dgram'
import { closest as closestIn } from './closest.mjs'
import { createBodySupervisor, describeExit } from './lifecycle.mjs'
import { createEventGate, eventLine, OPS, TASK_KINDS, REASON_TEXT } from './events.mjs'

export const name = 'mc-link'

const DEFAULT_BASE = 'http://127.0.0.1:54836'
const PLUGIN_DIR = path.join(import.meta.dirname, '..')
const SKILL_DIR = path.join(PLUGIN_DIR, 'skills')
const DEFAULT_SERVERS_FILE = path.join(PLUGIN_DIR, 'servers.json')
const STATUS_LINE_MAX = 120

/** 条件技能提示：只陈述"有什么、为什么现在可用、去哪读"，最多 2 条。 */
const SKILLS = [
  { id: 'escape', title: '脱困', when: (s) => ['failed', 'interrupted'].includes(s?.task?.state) || s?.paused || ['stuck', 'health-drop', 'low-health'].includes(s?.pausedReason), summary: '任务卡住/中断' },
  { id: 'flee', title: '逃跑/战斗', when: (s) => Number(s?.adapter?.health ?? 20) <= 12, summary: '血量偏低' },
  { id: 'trade', title: '村民交易', when: (s) => Number(s?.adapter?.nearby?.villager ?? 0) > 0, summary: '附近有村民' },
  { id: 'furnace', title: '熔炼', when: (s) => Number(s?.adapter?.nearby?.furnace ?? 0) > 0, summary: '附近有熔炉' },
  { id: 'chest', title: '箱子', when: (s) => Number(s?.adapter?.nearby?.chest ?? 0) > 0, summary: '附近有箱子' },
  { id: 'craft', title: '合成', when: (s) => Number(s?.adapter?.inventoryCount ?? 0) > 0, summary: '背包有材料' },
  { id: 'play', title: '开一局/操作手册', when: () => false, summary: '连接、任务、事件、失败处理' },
  { id: 'endgame', title: '通关参考', when: () => false, summary: '长期主线' },
]

function clampLine(text, max = STATUS_LINE_MAX) {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

function isTimeoutError(error) {
  const name = String(error?.name ?? '')
  const message = String(error?.message ?? error)
  return name === 'TimeoutError' || name === 'AbortError' || /aborted|timeout/i.test(message)
}

function readServersFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    const list = Array.isArray(parsed) ? parsed : parsed?.servers
    return Array.isArray(list) ? list : []
  } catch { return [] }
}

export function apply(ctx) {
  const raw = ctx.config ?? {}
  const base = String(raw.baseUrl ?? raw.mcBaseUrl ?? DEFAULT_BASE).replace(/\/+$/, '')
  const pollMs = Math.max(500, Number(raw.pollMs) || 1200)
  const focus = String(raw.focus ?? 'mc')
  const bodyPort = Number(raw.listenPort ?? new URL(base).port ?? 54836)
  const stateDir = path.resolve(String(raw.stateDir ?? 'C:/DSH/icl/.state/mc-live'))
  const bodyEntry = String(raw.bodyEntry ?? path.join(PLUGIN_DIR, '..', '..', 'mc-body', 'src', 'cli.mjs'))
  const logFile = raw.logFile ? String(raw.logFile) : null
  const fetchImpl = typeof ctx.fetch === 'function' ? ctx.fetch : (...args) => fetch(...args)

  let lastSeq = 0
  let primed = false
  let ready = null
  let timer = null
  let lastStatus = null
  let bodyInstance = 0
  let pendingRestart = false
  let sessionTouchedMc = false
  let reachable = false
  let lastExitAt = 0
  let lastLostReportAt = 0
  let lastLan = []
  let joinedServer = null

  const gate = createEventGate({
    config: {
      chatPerMinute: raw.chatPerMinute,
      mentionNames: [String(raw.username ?? 'ICL')],
      ...(raw.signalWindows ?? {}),
    },
  })

  function record(row) {
    if (!logFile) return
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true })
      fs.appendFileSync(logFile, `${JSON.stringify(row)}\n`, 'utf8')
    } catch { /* 日志失败不影响游戏 */ }
  }

  async function call(pathname, options = {}) {
    const timeoutMs = Number(options.timeoutMs ?? raw.timeoutMs) || 3000
    let response
    try {
      response = await fetchImpl(`${base}${pathname}`, { ...options, signal: AbortSignal.timeout(timeoutMs) })
    } catch (error) {
      if (isTimeoutError(error)) {
        throw Object.assign(new Error(`mc-body 在 ${timeoutMs}ms 内没响应（${pathname}）；body 可能卡住或没起。先 mcb_status 看进程，必要时 mcb_leave 后重新 mcb_join。`), { code: 'timeout' })
      }
      throw Object.assign(new Error(`连不上 mc-body（${base}）：${error?.message ?? error}。body 进程没起 → mcb_join 会让它起来。`), { code: 'unreachable' })
    }
    const body = await response.json().catch(() => ({}))
    if (!response.ok || body?.ok === false) {
      const detail = String(body?.error ?? `mc-body HTTP ${response.status}`)
      throw Object.assign(new Error(detail), { code: 'body', status: response.status })
    }
    return body
  }

  function sendSignal(signal, { activity = 'event' } = {}) {
    const payload = {
      id: signal.id ?? null,
      from: { plugin: 'mc', activity },
      kind: signal.kind ?? 'event',
      text: String(signal.text ?? ''),
      focus,
      tags: Array.isArray(signal.tags) ? signal.tags : ['mc'],
      meta: { priority: signal.priority ?? 'notice' },
    }
    let result = null
    try { result = ctx.signals.offer(payload) } catch (error) {
      record({ kind: 'signal-error', text: payload.text, error: String(error?.message ?? error) })
      return { accepted: false, error: String(error?.message ?? error) }
    }
    record({ kind: 'signal', type: payload.tags[1] ?? 'event', priority: payload.meta.priority, text: payload.text, accepted: result?.accepted !== false, reason: result?.reason ?? null })
    return result
  }

  // ── body 进程 ────────────────────────────────────────────────────────────
  const supervisor = createBodySupervisor({
    bodyPort,
    bodyEntry,
    stateDir,
    log: (entry) => ctx.log(entry),
    fetchStatus: () => call('/v1/status', { timeoutMs: 1200 }),
    beforeKill: async () => {
      try { await call('/v1/safety/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'leave' }), timeoutMs: 1200 }) } catch { /* body 可能已经不在了 */ }
    },
    onLifecycle: (event) => {
      record({ kind: 'lifecycle', ...event })
      if (event.type === 'body-spawn') { pendingRestart = true; return }
      if (event.type === 'body-exit') {
        lastExitAt = Date.now()
        lastStatus = null
        reachable = false
        if (event.expected) return
        const tail = Array.isArray(event.stderrTail) ? event.stderrTail.filter(Boolean).slice(-2).join(' / ') : ''
        sendSignal({
          kind: 'event', tags: ['mc', 'safety', 'alarm'], priority: 'alarm',
          id: `mc:exit:${event.pid ?? '?'}:${event.at}`,
          text: `[MC] 身体进程退出了（${describeExit(event.code, event.signal)}）${tail ? `；日志：${tail}` : ''}。要重连就 mcb_join（会重新起进程），不玩了就 mcb_leave 收尾。`,
        })
      }
    },
  })

  async function refreshStatus() {
    try {
      const status = await call('/v1/status', { timeoutMs: 1500 })
      lastStatus = status
      sessionTouchedMc = true
      if (!reachable) { reachable = true; lastLostReportAt = 0 }
      return status
    } catch (error) {
      lastStatus = null
      if (reachable) {
        reachable = false
        const quietSinceExit = lastExitAt && Date.now() - lastExitAt < 5000
        const cooled = Date.now() - lastLostReportAt > 30_000
        if (!quietSinceExit && cooled) {
          lastLostReportAt = Date.now()
          sendSignal({
            kind: 'event', tags: ['mc', 'safety', 'alarm'], priority: 'alarm',
            id: `mc:lost:${Date.now()}`,
            text: `[MC] 连不上 body 了（${base}/v1/status 无响应）：身体可能被杀掉/崩了。先 mcb_status 看进程；要重连就 mcb_join。`,
          })
        }
      }
      return null
    }
  }

  async function poll() {
    if (ready) await ready.catch(() => {})
    const status = await refreshStatus()
    if (!status) return
    let data
    try {
      data = await call(`/v1/events?since=${encodeURIComponent(String(lastSeq))}`, { timeoutMs: 3000 })
    } catch (error) {
      ctx.log({ level: 'warn', msg: 'mc-link.events-fail', error: String(error?.message ?? error) })
      return
    }
    if (!Array.isArray(data.events)) return
    const seq = Number(data.seq) || 0
    if (pendingRestart) {
      // 新起的 body 事件编号从 1 开始：不重放，也不把她叫醒。
      pendingRestart = false
      bodyInstance += 1
      primed = true
      lastSeq = seq
      return
    }
    if (!primed) { lastSeq = seq; primed = true; return }
    if (seq < lastSeq) {
      // 不是本会话起的 body 也可能被重启（外部 kill + 手动重启）：编号归零，不重放。
      bodyInstance += 1
      lastSeq = seq
      sendSignal({
        kind: 'event', tags: ['mc', 'body', 'restart'], priority: 'notice',
        id: `mc:restart:${bodyInstance}`,
        text: '[MC] body 事件编号归零（进程被重建过）：不重放旧事件，任务/位置以 mcb_status 为准。',
      })
      return
    }
    const fresh = data.events.filter((event) => Number(event?.seq) > lastSeq)
    if (!fresh.length) return
    lastSeq = fresh.reduce((max, event) => Math.max(max, Number(event.seq) || 0), lastSeq)
    const { signals, suppressed } = gate.take(fresh, { status })
    for (const event of fresh) record({ kind: 'body-event', type: event.type, seq: event.seq, at: event.at, data: event.data })
    for (const signal of signals) {
      sendSignal({ ...signal, id: `${signal.id}@${bodyInstance}` })
    }
    if (suppressed) record({ kind: 'suppressed', suppressed })
  }

  // ── 服务器清单：单一事实源是插件自带的 servers.json ──────────────────────
  function serverList() {
    const rows = []
    const push = (server) => {
      if (!server?.host) return
      const key = `${server.host}:${Number(server.port ?? 25565)}`
      if (rows.some((row) => `${row.host}:${Number(row.port ?? 25565)}` === key)) return
      rows.push({
        name: String(server.name ?? server.id ?? key),
        host: String(server.host),
        port: Number(server.port ?? 25565),
        note: server.note == null ? null : String(server.note),
      })
    }
    for (const server of readServersFile(DEFAULT_SERVERS_FILE)) push(server)
    // 只有显式配置了 serversFile 才读第二份；不隐式读仓库根 config/，避免两处定义。
    if (raw.serversFile) for (const server of readServersFile(String(raw.serversFile))) push(server)
    for (const server of Array.isArray(raw.servers) ? raw.servers : []) push(server)
    for (const server of lastLan) push(server)
    return rows
  }

  function resolveTarget({ host = null, port = null, server = null } = {}) {
    const list = serverList()
    const configured = list.find((row) => server && (row.name === server || row.name.toLowerCase() === String(server).toLowerCase()))
    if (server && !configured) {
      const near = closestIn(server, list.map((row) => row.name))
      throw new Error(`没有这个服务器：${server}${near ? `；你是不是要 ${near}？` : ''}。已知：${list.map((row) => row.name).join('、') || '（空）'}；也可以用 host+port 直接连。`)
    }
    const targetHost = String(host ?? configured?.host ?? '').trim()
    if (!targetHost) throw new Error(`mcb_join 需要 host（或 server 名）。已知服务器：${list.map((row) => `${row.name} ${row.host}:${row.port}`).join('、') || '（空）'}；先 mcb_servers / mcb_lan。`)
    const targetPort = Number(port ?? configured?.port ?? 25565)
    if (!Number.isFinite(targetPort) || targetPort <= 0) throw new Error(`端口不合法：${port}。用 1–65535 的数字。`)
    return { host: targetHost, port: targetPort, username: String(raw.username ?? 'ICL').slice(0, 16) }
  }

  async function join({ host = null, port = null, username = null, server = null } = {}) {
    const target = resolveTarget({ host, port, server })
    if (username) target.username = String(username).slice(0, 16)
    const out = await supervisor.ensure(target)
    joinedServer = { host: target.host, port: target.port }
    sessionTouchedMc = true
    lastStatus = out.status
    return { ...out, joined: { ...joinedServer } }
  }

  async function leave() {
    const own = supervisor.state()
    const externalConnected = Boolean(lastStatus?.adapter?.connected) && !own.owns
    let safety = 'ok'
    try {
      await call('/v1/safety/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'leave' }), timeoutMs: 1200 })
    } catch { safety = 'skipped' }
    const killed = await supervisor.stop({ reason: 'leave' })
    lastStatus = null
    joinedServer = null
    primed = false
    lastSeq = 0
    const lines = []
    if (killed.killed) lines.push(`已停止本会话启动的 body（pid ${killed.pid ?? '?'}${killed.forced ? '，SIGKILL' : ''}）`)
    else lines.push('本会话没有启动 body，没有进程要停')
    if (externalConnected) lines.push('注意：连着的 body 不是本会话启动的，我只发了安全停止，没有杀它（进程由启动方负责）')
    if (safety === 'skipped') lines.push('body 已经不在，安全停止请求跳过')
    lines.push('focus/goal 没有动：不需要持续唤醒时，自己 time_cancel + focus_leave')
    return lines.join('；')
  }

  // ── 状态与提示词（只陈述事实，不教导）────────────────────────────────────
  function taskInline(task) {
    if (!task) return '空闲'
    const progress = task.progress
    const extra = progress && typeof progress === 'object'
      ? (progress.done != null && progress.total != null ? ` ${progress.done}/${progress.total}` : progress.distance != null ? ` 距${Math.round(progress.distance)}格` : '')
      : ''
    return `${task.kind} ${task.state}${extra}`
  }

  function statusLine() {
    const s = lastStatus
    const own = supervisor.state()
    if (s?.adapter?.connected) {
      const a = s.adapter
      const p = a.position
      const pos = p ? `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}` : '?'
      const paused = s.paused ? ` · 暂停(${REASON_TEXT[s.pausedReason] ?? s.pausedReason ?? '安全'})` : ''
      const bag = Number.isFinite(Number(a.inventoryCount)) ? ` · 背包${Number(a.inventoryCount)}` : ''
      return clampLine(`MC｜在线 ${a.host}:${a.port} · ${pos} · ${taskInline(s.task)}${paused} · 血${Math.round(Number(a.health ?? 0))}/20${bag}`)
    }
    if (own.owns && own.alive) return clampLine(`MC｜body 在启动（pid ${own.pid ?? '?'}），还没连上 ${own.host}:${own.port}`)
    if (own.owns && own.exitCode != null) return clampLine(`MC｜身体进程已退出（${describeExit(own.exitCode, own.exitSignal)}）；要重连 mcb_join`)
    if (own.spawnError) return clampLine(`MC｜body 启动失败：${own.spawnError}；见 mcb_status`)
    return 'MC｜未连接'
  }

  function skillHints() {
    const hits = []
    for (const skill of SKILLS) {
      let ok = false
      try { ok = Boolean(skill.when(lastStatus)) } catch { ok = false }
      if (ok) hits.push(skill)
      if (hits.length >= 2) break
    }
    return hits
  }

  function hintLine() {
    const hits = skillHints()
    if (!hits.length) return ''
    return clampLine(`MC 技能：${hits.map((hit) => `${hit.title}（${hit.summary}；mcb_help ${hit.id}）`).join('｜')}`)
  }

  ctx.prompt.section({
    name: 'mc:status',
    order: 900,
    when: () => sessionTouchedMc || supervisor.owns(),
    text: () => statusLine(),
  })
  ctx.prompt.section({
    name: 'mc:skills',
    order: 901,
    when: () => hintLine() !== '',
    text: () => hintLine(),
  })

  // ── 工具 ────────────────────────────────────────────────────────────────
  async function inspect(kind, params = {}) {
    const body = await call('/v1/inspect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, params }) })
    return { text: String(body.result?.text ?? '') }
  }

  function eventLineFor(event, status = null) {
    return eventLine(event, status)
  }

  function renderEvents(result, { limit = 20 } = {}) {
    const events = Array.isArray(result?.events) ? result.events : []
    if (!events.length) return '（没有新事件）'
    const rows = events.slice(-Math.max(1, Number(limit) || 20))
    const head = events.length > rows.length ? `共 ${events.length} 条，列最后 ${rows.length} 条：` : ''
    return head + rows.map((event) => eventLineFor(event, lastStatus)).join('\n')
  }

  function renderTasks(result, { limit = 10 } = {}) {
    const tasks = Array.isArray(result) ? result : []
    if (!tasks.length) return '（台账里没有任务）'
    const rows = tasks.slice(-Math.max(1, Number(limit) || 10))
    return rows.map((task) => {
      const bits = [`#${task.id}`, task.kind, task.state]
      if (task.error) bits.push(`error=${task.error}`)
      if (task.result) {
        const result = task.result
        if (result.reason) bits.push(`reason=${result.reason}`)
        else if (result.mined != null) bits.push(`mined=${result.mined}`)
        else if (result.arrived) bits.push('arrived')
      }
      return bits.join(' ')
    }).join('\n')
  }

  function renderRow(row) {
    const op = String(row?.op ?? '?')
    const result = row?.result
    if (result?.text != null) return `[${op}] ${result.text}`
    if (op === 'tasks') return `[tasks]\n${renderTasks(result)}`
    if (op === 'events') return `[events]\n${renderEvents(result)}`
    if (op === 'resume') return `[resume] ${lastStatus?.paused ? `仍暂停（${REASON_TEXT[lastStatus.pausedReason] ?? lastStatus.pausedReason}）` : '已恢复；旧的 running 任务已中断，要续做请重新下任务'}`
    if (op === 'cancel') return `[cancel] ${result?.id ?? row?.taskId ?? '?'} ${result?.state ?? ''}`.trim()
    if (op === 'say') return `[say] ${result?.ok === false ? '没发出去' : '已发送'}`
    if (result == null) return `[${op}] 已完成（没有返回内容）`
    return `[${op}] ${JSON.stringify(result).slice(0, 400)}`
  }

  /** 校验/规整 steps：错误必须能指导下一步，不能把 body 的 "未知任务：undefined" 原样丢给她。 */
  function normalizeSteps(steps) {
    if (!Array.isArray(steps) || !steps.length) {
      throw new Error('steps 需要至少 1 步。例：{"steps":[{"op":"task","kind":"mine","params":{"block":"oak_log","count":4}}]}')
    }
    const known = new Set(OPS)
    return steps.map((raw, index) => {
      const where = `第 ${index + 1} 步`
      if (!raw || typeof raw !== 'object') throw new Error(`${where}不是对象：${JSON.stringify(raw)}`)
      const op = String(raw.op ?? '').trim()
      if (!op) throw new Error(`${where}缺少 op。可用 op：${OPS.join('、')}；长任务用 {"op":"task","kind":"mine"}，单步动作用 {"op":"dig"}。`)
      if (!known.has(op)) {
        const near = closestIn(op, OPS)
        throw new Error(`${where}未知 op：${op}${near ? `；你是不是要 ${near}？` : ''}。可用：${OPS.join('、')}`)
      }
      const step = { ...raw, op }
      if (op === 'task') {
        const kind = String(raw.kind ?? raw.params?.kind ?? raw.params?.params?.kind ?? '').trim()
        if (!kind) throw new Error(`${where} task 缺少 kind。可用 kind：${TASK_KINDS.join('、')}；例：{"op":"task","kind":"mine","params":{"block":"oak_log","count":4}}`)
        if (!TASK_KINDS.includes(kind)) {
          const near = closestIn(kind, TASK_KINDS)
          throw new Error(`${where}未知任务 kind：${kind}${near ? `；你是不是要 ${near}？` : ''}。可用：${TASK_KINDS.join('、')}`)
        }
        step.kind = kind
        const params = raw.params?.params ?? raw.params
        step.params = params && typeof params === 'object' ? params : {}
        if (step.deadlineMs == null) step.deadlineMs = kind === 'routine' ? Math.max(60_000, Number(step.params.durationMs) || 0) + 30_000 : 600_000
      }
      if (op === 'say') {
        const text = String(raw.text ?? raw.params?.text ?? '')
        if (!text.trim()) throw new Error(`${where} say 需要 text（≤200 字，不能以 / 开头）。`)
        if (text.length > 200) throw new Error(`${where} say 的 text 太长（${text.length} 字，上限 200）。`)
        if (text.trim().startsWith('/')) throw new Error(`${where} say 不允许以 / 开头的命令。`)
        step.text = text
      }
      if (op === 'cancel' && !raw.taskId) throw new Error(`${where} cancel 需要 taskId；先 {"op":"tasks"} 看任务台账。`)
      if (op === 'events' && raw.since == null) step.since = lastSeq
      return step
    })
  }

  function doTimeoutText(timeoutMs) {
    return `mcb_do 在 ${Math.round(timeoutMs / 1000)}s 内没有返回：steps 里的长动作（goto/mine/explore 这类单步 op）可能还在跑。先 mcb_status 看位置/任务，或 {"steps":[{"op":"tasks"}]} 查台账；不要原样重试。长任务请用 {"op":"task"} 提交，立即拿 taskId。`
  }

  async function runDo(steps, safety = null) {
    const normalized = normalizeSteps(steps)
    const timeoutMs = Number(raw.doTimeoutMs) || 120_000
    try {
      const body = await call('/v1/do', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ steps: normalized, safety }),
        timeoutMs,
      })
      lastStatus = await refreshStatus() ?? lastStatus
      if (body.task) return { text: `任务 ${body.task.id}（${body.task.kind}）已接受，状态 ${body.task.state}。用 mcb_status 看进度；完成/失败/中断会作为事件通知回来。` }
      const parts = (body.results ?? []).map(renderRow)
      return { text: parts.length ? parts.join('\n\n') : '没有返回结果。' }
    } catch (error) {
      if (isTimeoutError(error) || error?.code === 'timeout') return { text: doTimeoutText(timeoutMs) }
      const message = String(error?.message ?? error)
      // body 的错误本身通常可操作（"身体已暂停（death）；先 resume"）；补一句"下一步"。
      const hint = /暂停/.test(message) ? '；恢复：{"steps":[{"op":"resume"}]}，或 mcb_leave 收尾'
        : /未允许|403/.test(message) ? '；body 启动参数没开这个能力（--allow-task/--allow-say），需要重起 body'
          : /not connected|未连接/.test(message) ? '；先 mcb_join'
            : ''
      throw new Error(`${message}${hint}`)
    }
  }

  const tools = [
    {
      name: 'mcb_servers',
      summary: '列出已知 MC 服务器（name / host:port），用于 mcb_join 选目标。',
      description: '清单来自 mc-link 自带的 servers.json（flat 测试服 54837、survival 54838），配置里的 servers 会追加；最近一次 mcb_lan 的结果也在里面。不探测在线状态——连不连得上由 mcb_join 的报错告诉你。列表为空时可以直接 mcb_join {host, port}。',
      when: ['想去 MC 但不知道连哪台', 'mcb_join 报"没有这个服务器"之后'],
      parameters: { type: 'object', properties: {} },
      async execute() {
        const rows = serverList()
        if (!rows.length) return { text: '没有已知服务器；用 mcb_lan 扫描，或 mcb_join {host, port} 直接连。' }
        return { text: rows.map((row) => `· ${row.name}  ${row.host}:${row.port}${row.note ? `（${row.note}）` : ''}`).join('\n') }
      },
    },
    {
      name: 'mcb_lan',
      summary: '监听 Minecraft 局域网公告（UDP 4445）约 2 秒，返回发现的 host/port/MOTD。',
      description: '只有对方在游戏里"对局域网开放"时才扫得到（个人客户端常见）。扫不到不等于没服务器——已知服务器用 mcb_servers，自己起测试服直接把 host/port 给 mcb_join。返回空列表是正常结果，不是错误。每次调用最多等约 2 秒。',
      parameters: { type: 'object', properties: {} },
      async execute() {
        lastLan = await lanDiscover()
        const rows = lastLan.map((row) => `· ${row.name}  ${row.host}:${row.port}`)
        return { text: rows.length ? rows.join('\n') : '没有发现局域网服务器（约 2 秒内没有公告）。' }
      },
    },
    {
      name: 'mcb_join',
      summary: '连接 MC 服务器：必要时启动 mc-body 进程，并等到真正连上；只负责连接，不建 focus/goal。',
      description: '参数：server（mcb_servers/mcb_lan 里的名字）或 host + port（默认 25565），username 可选（≤16 字符）。成功返回服务器与连接状态，之后用 mcb_status 复核。失败会给可读原因：进程退出码 + body 日志最后几行、端口被占/被别的 body 占着、服务器没开或端口错（reconnect_exhausted）。失败时不留下半死进程，修好原因后可以直接再 join。',
      when: ['被叫去玩，或她自己想玩', 'mcb_status 显示未连接、服务器已经开着'],
      avoid: ['body 已经连在另一台服务器：先 mcb_leave', '只想随便玩一小会儿：连上直接玩，不必建 focus/goal'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          server: { type: 'string', description: 'mcb_servers/mcb_lan 返回的服务器名，如 flat、survival。优先用它，不用记端口。' },
          host: { type: 'string', description: '服务器地址；和 server 二选一。' },
          port: { type: 'number', description: '服务器端口；默认 25565。' },
          username: { type: 'string', description: '游戏内名字，≤16 字符；默认 ICL。' },
        },
      },
      async execute(args = {}) {
        const out = await join(args)
        const a = out.status?.adapter ?? {}
        const pos = a.position ? `${Math.round(a.position.x)},${Math.round(a.position.y)},${Math.round(a.position.z)}` : '未知'
        const how = out.reused ? '复用了一个已经连着的 body' : 'body 已启动并连上'
        return { text: `已连接 ${out.joined.host}:${out.joined.port}（${how}），位置 ${pos}。下一步：mcb_status/mcb_look 看周围；要做事用 mcb_do 下任务。` }
      },
    },
    {
      name: 'mcb_leave',
      summary: '退出 MC：安全停止并结束本会话启动的 body 进程；不取消 focus/goal。',
      description: '先 POST /v1/safety/stop，再对"本会话自己 spawn 的"进程 SIGTERM→SIGKILL；外部启动的 body 只安全停止、不杀进程（返回值里会说明）。之后 mcb_status 应显示未连接。不想被持续唤醒时，自己先 time_cancel（取消 goal）再 focus_leave；mcb_leave 不会替你做这两件事。',
      when: ['不想玩了/要收尾', 'body 卡死、需要重起（先 leave 再 join）'],
      avoid: ['只离开游戏但想保留持续目标：focus/time 不用动，直接 leave'],
      parameters: { type: 'object', properties: {} },
      async execute() { return { text: await leave() } },
    },
    {
      name: 'mcb_status',
      summary: '查看身体当前事实：连接/服务器/位置/生命/饥饿/背包/当前任务与队列/暂停原因/body 进程状态。只读。',
      description: '返回多行事实。未连接时看进程行：有退出码说明进程崩了（mcb_join 重试会重新起进程并带上原因），有 pid 但没连上说明还在启动/重连。暂停行给 pausedReason（death/health-drop/low-health/low-oxygen/stuck/disconnect），恢复用 mcb_do 的 resume op。任务行给 kind/state/进度；队列是还没跑的任务。任务历史用 {"steps":[{"op":"tasks"}]}。',
      when: ['行动前确认位置/血量/任务', '任务事件之后核对真实结果', '怀疑掉线/卡死'],
      parameters: { type: 'object', properties: {} },
      async execute() {
        const status = await refreshStatus()
        const own = supervisor.state()
        if (!status) {
          const lines = ['MC 身体：未连接（/v1/status 无响应）']
          lines.push(`进程：${own.owns ? `已启动 pid ${own.pid ?? '?'}${own.alive ? '（运行中）' : `（已退出：${describeExit(own.exitCode, own.exitSignal)}）`}` : '本会话没有启动 body'}`)
          if (own.stderrTail?.length) lines.push(`body 日志：${own.stderrTail.slice(-2).join(' / ')}`)
          lines.push('下一步：mcb_join 重连（会重新起进程）；不玩了用 mcb_leave 收尾。')
          return { text: lines.join('\n') }
        }
        const a = status.adapter ?? {}
        const lines = [
          `MC 身体：${a.connected ? '已连接' : '未连接'} ${a.host ?? ''}:${a.port ?? ''}`,
          `玩家：${(a.players ?? []).join('、') || '无'}`,
          `位置：${a.position ? `${Math.round(a.position.x)}, ${Math.round(a.position.y)}, ${Math.round(a.position.z)}` : '未知'} · 维度 ${a.dimension ?? '?'}`,
          `生命/饥饿/氧气：${Math.round(Number(a.health ?? 0))}/20，${Math.round(Number(a.food ?? 0))}/20，${Number.isFinite(Number(a.oxygen)) ? Math.round(Number(a.oxygen)) : '?'}`,
          `背包：${Number.isFinite(Number(a.inventoryCount)) ? `${Number(a.inventoryCount)} 件` : '未知'}`,
          `任务：${status.task ? `${status.task.kind} ${status.task.state}` : '空闲'}；队列 ${status.queue?.length ?? 0}`,
        ]
        if (status.paused) lines.push(`暂停：${REASON_TEXT[status.pausedReason] ?? status.pausedReason}（任务已中断；resume 前先看环境）`)
        const ownState = supervisor.state()
        if (ownState.owns) lines.push(`进程：本会话启动 pid ${ownState.pid ?? '?'}${ownState.alive ? '（运行中）' : '（已退出）'}`)
        const stats = gate.stats()
        if (stats.suppressed) lines.push(`通知：最近抑制 ${stats.suppressed} 条重复事件`)
        return { text: lines.join('\n') }
      },
    },
    {
      name: 'mcb_look',
      summary: '看身体当前视角：位置/朝向/生命/手持/视线方块/附近实体（文本）。只读。',
      description: '附近实体会列出名字和距离——hostile（zombie/skeleton/creeper）就在旁边时先保命。视线方块给出她正对着什么，用来判断朝向。想知道某类方块在哪用 mcb_scan，想看地形用 mcb_map。',
      when: ['刚进服/刚复活，先看周围', '要判断危险、朝向、附近有什么'],
      parameters: { type: 'object', properties: {} },
      async execute() { return inspect('look') },
    },
    {
      name: 'mcb_inventory',
      summary: '看背包和手持物品（名字+数量）。只读。',
      description: '空背包会明确说"背包是空的"。挖/合/捡之后用它核对结果：body 的任务完成事件不代表掉落一定进了背包（mine 可能 reason=no-effect）。合成/熔炼/交易前先看材料够不够。',
      when: ['合成/熔炼/放置之前', '任务完成后核对产物'],
      parameters: { type: 'object', properties: {} },
      async execute() { return inspect('inventory') },
    },
    {
      name: 'mcb_scan',
      summary: '扫描附近某类方块的位置和距离。只读。参数：name 必填，radius/count 可选。',
      description: 'name 用 Minecraft 方块 id（snake_case）：oak_log、dirt、stone、iron_ore、coal_ore、crafting_table、furnace、chest、water、lava。radius 默认 8（方块格），count 默认 8，结果按距离排序。返回空表示这个范围内没有——把 radius 调大或换块名，不要换任务重试同一件事。',
      when: ['下 mine 任务之前确认目标存在', '找工作台/熔炉/箱子/矿', '脱困时找方向'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: {
          name: { type: 'string', description: '方块 id，如 oak_log、stone、iron_ore。' },
          radius: { type: 'number', description: '搜索半径（格），默认 8。' },
          count: { type: 'number', description: '最多返回几个，默认 8。' },
        },
      },
      async execute({ name, radius, count } = {}) { return inspect('scan', { name, radius, count }) },
    },
    {
      name: 'mcb_map',
      summary: '看脚下方块层的字符小地图（#实心 .空 ~水 ≈岩浆 ?未加载）。只读。参数：radius 可选。',
      description: '用来判断地形：前面是墙/悬崖/水/岩浆。radius 默认 8（格）。←↑→↓ 是朝向。卡住或 goto 走不过去时先看它，再决定绕路还是换目标。',
      when: ['goto/寻路失败', '判断悬崖、水域、洞窟'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { radius: { type: 'number', description: '地图半径（格），默认 8。' } },
      },
      async execute({ radius } = {}) { return inspect('map', { radius }) },
    },
    {
      name: 'mcb_do',
      summary: '执行 MC 动作：单步动作、长任务、任务台账、事件、发言都走这一个工具。',
      description: `steps 按顺序执行，任一 op 失败即停。长任务用 {"op":"task","kind":"mine|goto|patrol|explore|follow|routine|chat"} + params（立即返回 taskId，进度/完成以事件回来）；单步动作用 {"op":"dig|place|use|equip|toss|attack|eat|face|wait|craft|furnace|chest|trade|move|goto|patrol|explore|follow|mine"} + params（会阻塞到完成，最长约 120s，超时会提示先查状态、不要原样重试）。查询/控制：{"op":"tasks"}（台账含 result/error）、{"op":"events"}（默认只列上次之后的新事件，可加 since）、{"op":"cancel","taskId":"t-1"}、{"op":"resume"}（解除暂停；队列已清空，要续做重新下任务）、{"op":"say","text":"..."}（≤200 字，不能以 / 开头）。决定做大事/任务完成或失败时用 say 说一句。`,
      when: ['要动身体：挖、走、放、用、打、吃、合成、交易', '查任务台账/事件、取消任务、解除暂停', '游戏里说一句话'],
      avoid: ['只想知道状态：用 mcb_status/mcb_look/mcb_inventory 更便宜', 'op 不确定时先 mcb_help play 看操作手册，别猜参数'],
      safety: ['同一件事不要连发多个 task：先 tasks 看有没有在跑的', '暂停（paused）时只有 resume/look/inventory/scan/map/tasks/events/say/wait 等安全 op 可用'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          intent: { type: 'string', description: '一句话：这次要干什么（便于回看/审计）。' },
          steps: {
            type: 'array',
            description: '按顺序执行的动作列表，至少 1 步。',
            items: {
              type: 'object',
              additionalProperties: true,
              required: ['op'],
              properties: {
                op: { type: 'string', description: '动作名；task=下长任务，events/tasks/cancel/resume/say=查询与控制，其余是单步动作。' },
                kind: { type: 'string', description: 'task 的任务类型：mine/goto/patrol/explore/follow/routine/chat。' },
                params: { type: 'object', additionalProperties: true, description: '动作参数：task 的 mine 用 {block,count,radius}；goto 用 {x,y,z,range}；routine 用 {durationMs}；dig/place/use/equip/toss/craft 等用 {item/name/pos/target}。' },
                text: { type: 'string', description: 'say 的内容（≤200 字，不能以 / 开头）。' },
                taskId: { type: 'string', description: 'cancel 的任务 id，如 t-1。' },
                since: { type: 'number', description: 'events 的起始 seq；不填=上次轮询之后的新事件，填 0=从头（很长）。' },
                state: { type: 'string', description: 'tasks 的状态过滤：running/done/failed/interrupted/queued。' },
              },
            },
          },
          safety: { type: 'object', additionalProperties: true, description: '可选的 body 安全参数（通常不用填）。' },
        },
        required: ['steps'],
      },
      async execute({ steps, safety } = {}) { return runDo(steps, safety) },
    },
    {
      name: 'mcb_help',
      summary: '读 MC 的深层操作文档（按需，不常驻）。不带参数列出全部；参数 skill 指定一篇。',
      description: '文档很短，讲流程/参数示例/失败怎么办，不放进每轮提示词。play=开一局与任务/事件/失败处理全流程；escape=卡住/中断；flee=低血逃生；craft/furnace/chest/trade=各系统操作；endgame=长期主线。名字可以模糊匹配（trad→trade）。',
      when: ['准备做一整件事（合成、熔炼、交易、脱困、长期发展）', 'mcb_do 报了不懂的错'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { skill: { type: 'string', description: '技能 id 或模糊名（play/escape/flee/craft/furnace/chest/trade/endgame）；不填列出全部。' } },
      },
      async execute({ skill } = {}) { return help(skill) },
    },
  ]
  for (const tool of tools) ctx.tools.register(tool)

  // ── LAN 发现 ────────────────────────────────────────────────────────────
  function lanDiscover(timeoutMs = 1800) {
    return new Promise((resolve) => {
      const found = []
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
      let done = false
      const finish = () => {
        if (done) return
        done = true
        try { sock.close() } catch { /* 已关 */ }
        resolve(found)
      }
      sock.on('message', (msg, rinfo) => {
        const text = msg.toString('utf8')
        const port = Number((text.match(/\[AD\](\d+)\[\/AD\]/) ?? [])[1]) || 25565
        const motd = (text.match(/\[MOTD\](.*?)\[\/MOTD\]/s) ?? [])[1] ?? ''
        if (!found.some((row) => row.host === rinfo.address && row.port === port)) found.push({ name: motd || rinfo.address, host: rinfo.address, port })
      })
      sock.on('error', () => finish())
      try {
        sock.bind(4445, () => { try { sock.addMembership('224.0.2.60') } catch { /* 没有组播就退化成监听 */ } })
      } catch { finish(); return }
      const timer = setTimeout(finish, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
    })
  }

  // ── 技能文档 ────────────────────────────────────────────────────────────
  function help(skill) {
    const ids = SKILLS.map((row) => row.id)
    if (!skill || !String(skill).trim()) return { text: `可用技能：${ids.join('、')}。用 {skill:"trade"} 读全文；第一次玩先读 play。` }
    const id = closestIn(skill, ids)
    if (!id) return { text: `没有这个技能：${skill}。可用：${ids.join('、')}` }
    try { return { text: fs.readFileSync(path.join(SKILL_DIR, `${id}.md`), 'utf8') } } catch (error) {
      return { text: `技能 ${id} 的文档读不到：${error?.message ?? error}` }
    }
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────
  ready = refreshStatus().catch(() => null).then(() => { primed = false })
  timer = setInterval(() => {
    void poll().catch((error) => ctx.log({ level: 'warn', msg: 'mc-link.poll', error: String(error?.message ?? error) }))
  }, pollMs)
  if (typeof timer.unref === 'function') timer.unref()
  ctx.onDispose(() => {
    if (timer) clearInterval(timer)
    timer = null
    supervisor.dispose()
  })

  const api = {
    base,
    status: () => lastStatus,
    poll,
    join,
    leave,
    skills: () => SKILLS.map((row) => row.id),
    servers: () => serverList(),
    supervisor: () => supervisor.state(),
    gate: () => gate.stats(),
    sendSignal,
  }
  try { ctx.services.provide('mc-link', api) } catch (error) {
    ctx.log({ level: 'warn', msg: 'mc-link.provide', error: String(error?.message ?? error) })
  }
  ctx.log({ msg: 'mc-link.ready', base, bodyPort, focus, tools: tools.length, stateDir })
  return api
}
