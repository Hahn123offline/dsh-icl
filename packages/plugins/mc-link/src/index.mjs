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
import { EXIT_REASON_TEXT, exitReasonText, sameReasonAdvice } from './exit.mjs'
import { createBodySupervisor, describeExit } from './lifecycle.mjs'
import { createEventGate, eventLine, OPS, TASK_KINDS, REASON_TEXT } from './events.mjs'
import { iclPaths } from '../../../core/src/icl-paths.mjs'

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
  { id: 'combat', title: '战斗/逃跑/自动躲避', when: (s) => Array.isArray(s?.adapter?.nearbyHostiles) && s.adapter.nearbyHostiles.length > 0, summary: '附近有敌对：mcb_combat（hunt/flee/guard），别逐次 attack' },
  { id: 'trade', title: '村民交易', when: (s) => Number(s?.adapter?.nearby?.villager ?? 0) > 0, summary: '附近有村民' },
  { id: 'furnace', title: '熔炼', when: (s) => Number(s?.adapter?.nearby?.furnace ?? 0) > 0, summary: '附近有熔炉' },
  { id: 'chest', title: '箱子', when: (s) => Number(s?.adapter?.nearby?.chest ?? 0) > 0, summary: '附近有箱子' },
  { id: 'craft', title: '合成', when: (s) => Number(s?.adapter?.inventoryCount ?? 0) > 0, summary: '背包有材料' },
  { id: 'macro', title: '宏操作总览', when: () => false, summary: '8 个宏、参数、失败码、别逐方块' },
  { id: 'collect', title: '批量采集（宏）', when: () => false, summary: '重复挖矿/砍树用宏，别逐方块' },
  { id: 'tunnel', title: '挖隧道（宏）', when: () => false, summary: '直线通道/下矿通道用宏' },
  { id: 'shelter', title: '盖房/回家/躲藏', when: () => false, summary: 'mcb_shelter 盖房+结构验收+home；夜里/下雨回家躲' },
  { id: 'build', title: '蓝图建造（beta）', when: () => false, summary: 'build 蓝图参数、材料、partial 处理' },
  { id: 'eyes', title: '眼睛：快照/截图', when: () => false, summary: '先 snapshot 后 screenshot；成本/quota/失败处理' },
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
  // bot 名：配置优先；lab 里用环境变量按 owner 区分（两个都叫 ICL 会被服务器互踢）。
  const botName = String(raw.username ?? process.env.ICL_MC_BOT_NAME ?? 'ICL').slice(0, 16)
  // body 的 tasks/事件/日志落盘目录：跟着 mc-link 自己的日志走（dsh-icl 给的是 run stateDir），
  // 不写仓库根的 .state/mc-live，避免多个 run/多个 owner 的证据混在一起。
  const stateDir = path.resolve(String(raw.stateDir ?? (raw.logFile ? path.dirname(String(raw.logFile)) : path.join(iclPaths().stateDir, 'mc-live'))))
  const bodyEntry = String(raw.bodyEntry ?? process.env.ICL_MC_BODY_ENTRY ?? path.join(PLUGIN_DIR, '..', '..', 'mc-body', 'src', 'cli.mjs'))
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
  let exitTimes = []
  /** 连续多少次 HTTP 状态失败：1 次不报警（外部干净关闭会先断 HTTP 再发 exit 事件）。 */
  let lostStrikes = 0
  /** 本会话的退出原因账本：同因第 2 次起要在通知里说清楚，别让她重复踩同一个坑。 */
  let exitReasons = []
  let lastLan = []
  let joinedServer = null

  const gate = createEventGate({
    config: {
      chatPerMinute: raw.chatPerMinute,
      mentionNames: [botName],
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

  /**
   * 危险 alarm 被时间闸门（pause/睡眠/静音）拦下时暂存，下一次 poll 再补投。
   * time 的 gate 对 to:'model' 的非 time 信号在 phase=paused 时会 enqueue 并 reject；
   * blocked 不占用 signal id，所以同一条可以原样重试（见 core/signals.mjs）。
   */
  const pendingAlarms = []
  function alarmPayload(payload) {
    return payload.meta?.priority === 'alarm' || (payload.tags ?? []).includes('alarm')
  }

  function sendSignal(signal, { activity = 'event' } = {}) {
    const priority = signal.priority ?? (Array.isArray(signal.tags) && signal.tags.includes('alarm') ? 'alarm' : 'notice')
    // body 的危险事件可能只带 pierce:true（不带 alarm tag）：透传给 time，让暂停/睡眠也能放行。
    const pierce = signal.pierce === true || priority === 'alarm'
    const payload = {
      id: signal.id ?? null,
      from: { plugin: 'mc', activity },
      kind: signal.kind ?? 'event',
      text: String(signal.text ?? ''),
      focus,
      tags: Array.isArray(signal.tags) ? signal.tags : ['mc'],
      meta: { priority, ...(pierce ? { pierce: true } : {}) },
    }
    let result = null
    try { result = ctx.signals.offer(payload) } catch (error) {
      record({ kind: 'signal-error', at: Date.now(), text: payload.text, error: String(error?.message ?? error) })
      return { accepted: false, error: String(error?.message ?? error) }
    }
    record({ kind: 'signal', at: Date.now(), type: payload.tags[1] ?? 'event', priority: payload.meta.priority, pierce: payload.meta.pierce === true, tags: payload.tags, text: payload.text, accepted: result?.accepted !== false, reason: result?.reason ?? null })
    // time gate 对 sleeping/muted/paused 的 blocked 信号：返回前已 enqueue()+persist()（醒来/恢复时 time 统一释放）。
    // 这类**不要补投**，否则会"积压一条 + 补投一条"两份危险消息；只对没进 time 的失败（offer 异常等）补投。
    const STORED_BY_TIME = new Set(['sleeping', 'muted', 'muted-quota', 'paused'])
    if (result?.accepted === false && result?.blocked && alarmPayload(payload)) {
      const reason = String(result.reason ?? 'gate')
      if (STORED_BY_TIME.has(reason)) {
        record({ kind: 'alarm-already-stored', at: Date.now(), reason, text: payload.text.slice(0, 120) })
      } else {
        const id = payload.id ?? `mc:alarm:${Date.now()}:${pendingAlarms.length}`
        if (!pendingAlarms.some((row) => row.payload.id === id)) {
          pendingAlarms.push({ payload: { ...payload, id }, firstAt: Date.now(), attempts: 1, reason })
          record({ kind: 'alarm-blocked', at: Date.now(), reason, text: payload.text.slice(0, 120) })
          if (pendingAlarms.length > 20) pendingAlarms.shift()
        }
      }
    }
    return result
  }

  /** 每次 poll 尝试补投被 pause/睡眠/静音拦下的危险通知；gate 一开就送。 */
  function flushPendingAlarms() {
    if (!pendingAlarms.length) return
    for (let index = pendingAlarms.length - 1; index >= 0; index -= 1) {
      const row = pendingAlarms[index]
      const waitedMs = Date.now() - row.firstAt
      if (waitedMs > 6 * 3600_000) {
        pendingAlarms.splice(index, 1)
        record({ kind: 'alarm-dropped', at: Date.now(), waitedMs, text: row.payload.text.slice(0, 120) })
        continue
      }
      let result = null
      try { result = ctx.signals.offer(row.payload) } catch { result = { accepted: false } }
      row.attempts += 1
      if (result?.accepted !== false) {
        pendingAlarms.splice(index, 1)
        record({ kind: 'alarm-delivered-late', at: Date.now(), waitedMs, attempts: row.attempts, text: row.payload.text.slice(0, 120) })
      }
    }
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
        const before = lastStatus
        lastExitAt = Date.now()
        lastStatus = null
        reachable = false
        if (event.expected) {
          // 正常结束（自己 leave/stop，或外部干净关闭）：不计入"第 N 次退出"，也不发崩溃通知。
          record({ kind: 'exit-expected', at: lastExitAt, source: event.exitClass?.source ?? 'self-stop', reason: event.exitInfo?.reason ?? null })
          return
        }
        exitTimes.push(lastExitAt)
        exitTimes = exitTimes.filter((at) => lastExitAt - at <= 600_000)
        const exitCount = exitTimes.length
        const reason = exitReasonText(event)
        const status = event.exitInfo?.status ?? null
        const reasonKey = event.exitInfo?.reason
          ? String(event.exitInfo.reason)
          : event.signal ? `signal:${event.signal}` : `code:${event.code ?? '?'}`
        // 同因 = 同一个 reason + 同一个任务上下文（mc-body 建议 reason + taskId/position）。
        const same = `${reasonKey}|${status?.taskId ?? ''}|${status?.pausedReason ?? ''}`
        const sameCount = exitReasons.filter((row) => row.same === same).length + 1
        exitReasons.push({ same, reason: reasonKey, at: lastExitAt, pid: event.pid ?? null })
        if (exitReasons.length > 20) exitReasons.shift()
        record({ kind: 'crash-detect', at: lastExitAt, exitAt: event.at ?? null, pid: event.pid ?? null, reason: reasonKey, sameCount, latencyMs: event.at ? lastExitAt - event.at : null })
        const task = status?.taskId
          ? `死时任务 ${status.taskId} ${status.taskState ?? status.task?.state ?? ''}`.trim()
          : before?.task
            ? `死时任务 ${before.task.kind} ${before.task.state}${before.task.progress ? `（${JSON.stringify(before.task.progress).slice(0, 60)}）` : ''}`
            : '死时没有任务在跑'
        const deadPos = before?.adapter?.position
          ? `，位置 ${Math.round(before.adapter.position.x)},${Math.round(before.adapter.position.y)},${Math.round(before.adapter.position.z)}`
          : ''
        const info = status?.lastError ? `；最后错误：${String(status.lastError).slice(0, 100)}` : ''
        // 崩溃栈只取首行，完整栈在 body-exit.json / 日志里；最后 1-2 条 recentEvents 帮她判断"死前在干嘛"。
        const stack = event.exitInfo?.detail ? String(event.exitInfo.detail).split('\n')[0].slice(0, 160) : ''
        const recent = (event.exitInfo?.recentEvents ?? []).slice(-2)
          .map((row) => `#${row.seq ?? '?'} ${row.type ?? '?'}`).join(' / ')
        const tail = (event.exitInfo?.stderrTail?.length ? event.exitInfo.stderrTail : event.stderrTail ?? [])
          .filter((line) => line && !/^\s*\[out\]\s*$/.test(line) && !/spawn_safe|spawn|connected as|path_stuck|path_recovered|heartbeat|http:\/\//i.test(line))
          .slice(-1)[0]
        const sameText = sameCount >= 2 ? `；本会话第 ${sameCount} 次同因退出（${reasonKey}）${sameReasonAdvice(reasonKey)}` : ''
        sendSignal({
          kind: 'event', tags: ['mc', 'safety', 'alarm'], priority: 'alarm',
          id: `mc:exit:${event.pid ?? '?'}:${event.at}`,
          text: `[MC] 身体进程意外退出了：${reason}（${describeExit(event.code, event.signal)}；**这次不是你 leave/stop 发起的**，是外部结束/崩溃（expected=false）；本会话第 ${exitCount} 次意外退出${exitCount > 1 ? `，近 10 分钟 ${exitCount} 次` : ''}）。${task}${deadPos}${info}${stack ? `；栈：${stack}` : ''}${recent ? `；死前事件：${recent}` : ''}${tail ? `；最后日志：${tail}` : ''}${sameText}。旧任务不会自动续跑；先 mcb_status 看背包/位置，再决定 mcb_join 重连还是 mcb_leave 收尾。`,
        })
      }
    },
  })

  async function refreshStatus() {
    try {
      const status = await call('/v1/status', { timeoutMs: 1500 })
      lastStatus = status
      sessionTouchedMc = true
      lostStrikes = 0
      if (!reachable) { reachable = true; lastLostReportAt = 0 }
      return status
    } catch (error) {
      lastStatus = null
      lostStrikes += 1
      // 单次 HTTP 失败先不下"身体可能崩了"的 alarm：外部 /v1/shutdown（睡眠期收身体）会有
      // 亚秒级的 HTTP 先断、exit 事件后到，若第一次失败就报警，会把她从睡眠里拽起来。
      // 连续 2 次失败（≥~2.4s）才报警；期间如果 body-exit 到了，exit 分支会自己说话（或 expected 沉默）。
      const quietSinceExit = lastExitAt && Date.now() - lastExitAt < 5000
      const cooled = Date.now() - lastLostReportAt > 30_000
      const knownExit = supervisor.state().exitCode != null
      if (reachable) reachable = false
      if (lostStrikes >= 2 && !quietSinceExit && cooled && !knownExit) {
        lastLostReportAt = Date.now()
        sendSignal({
          kind: 'event', tags: ['mc', 'safety', 'alarm'], priority: 'alarm',
          id: `mc:lost:${Date.now()}`,
          text: `[MC] 连不上 body 了（${base}/v1/status 无响应）：身体可能被杀掉/崩了。先 mcb_status 看进程；要重连就 mcb_join。`,
        })
      }
      return null
    }
  }

  async function poll() {
    if (ready) await ready.catch(() => {})
    const status = await refreshStatus()
    // 先补投被 pause/睡眠拦下的危险通知（gate 可能刚开），再做常规事件处理。
    flushPendingAlarms()
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
    return { host: targetHost, port: targetPort, username: botName }
  }

  /** time 的时间相位（awake/sleeping/paused）；没有 time 插件时 null。 */
  function timePhase() {
    try { return ctx.services?.get?.('time')?.phase?.() ?? null } catch { return null }
  }

  function timeApi() {
    try { return ctx.services?.get?.('time') ?? null } catch { return null }
  }

  /** 同步 time 的"暂停模式"（任务停、世界继续、计时不冻结；alarm 可穿透）。旧版 time 没有该接口时静默。 */
  function setTimePausedMode(active, reason = null) {
    try {
      const api = timeApi()
      if (typeof api?.setPausedMode !== 'function') return null
      return api.setPausedMode({ active: Boolean(active), ...(reason ? { reason: String(reason) } : {}), source: 'mc-link' }) ?? null
    } catch { return null }
  }

  function timePausedMode() {
    try { return timeApi()?.status?.()?.pausedMode ?? null } catch { return null }
  }

  function timeLastPierce() {
    try { return timeApi()?.status?.()?.lastPierce ?? null } catch { return null }
  }

  /**
   * time 的睡眠边界事实（status().sleepBoundary / lastSleepBoundary；下一版才有）。
   * 只读展示，供当事人/早报核对；cancel/overrun 由 supervisor（mc-lab driver）负责。
   */
  function timeSleepBoundary() {
    let current = null
    let last = null
    try {
      const st = ctx.services?.get?.('time')?.status?.() ?? null
      current = st?.sleepBoundary ?? null
      last = st?.lastSleepBoundary ?? null
    } catch { return null }
    const b = current ?? last
    if (!b || typeof b !== 'object') return null
    const isLast = !current && Boolean(last)
    const head = isLast ? '上次睡眠边界' : '睡眠边界'
    const age = b.turnAgeAtEntrySec != null ? `（age ${Math.round(Number(b.turnAgeAtEntrySec))}s）` : ''
    if (b.postSleepTurn) return { text: `${head}：⚠ 入睡后出现新 turn（直投/注入）` }
    if (b.overrun) return { text: `${head}：⚠ 超 grace${b.inFlight ? `，入睡时在飞 turn${age}还没结束` : ''}，driver 应 cancel` }
    if (b.inFlight) {
      const ended = b.turnEndedAfterSec != null
        ? `，grace 内 ${Math.round(Number(b.turnEndedAfterSec))}s 结束`
        : '，还在跑'
      return { text: `${head}：入睡时在飞 turn${age}${ended}` }
    }
    return { text: `${head}：入睡时无在飞 turn` }
  }

  async function join({ host = null, port = null, username = null, server = null, force = false } = {}) {
    const target = resolveTarget({ host, port, server })
    if (username) target.username = String(username).slice(0, 16)
    // 睡眠期管理面可能用 /v1/shutdown 把身体收起来保命（night-1 的 sleep-safe）。
    // 这时不要自动/顺手 mcb_join：否则"睡觉"期间身体又回夜间世界挨打。
    // force 只给"用户明确要求现在玩"的场合（工具描述里写清）。
    const phase = timePhase()
    if (phase === 'sleeping' && force !== true) {
      throw new Error('现在在睡觉（time 的睡眠安排生效中）：身体已经被管理面收起来了，不会自动重连。不要用 mcb_join；醒来后再连。除非用户明确要求现在玩，才用 mcb_join {force:true}。')
    }
    let out = await supervisor.ensure(target)
    joinedServer = { host: target.host, port: target.port }
    sessionTouchedMc = true
    lastStatus = out.status
    // body 的 environment 摘要由它的看门狗周期算，刚连上时可能还是 null；
    // 当事人反馈"连上两眼一抹黑，光找一棵树花两次调用"——这里短等它算出来，
    // 把"出生点 + 附近资源"一起放进 join 的返回（最多 1.2s，拿不到就算了）。
    if (!lastStatus?.adapter?.environment?.summary) {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 300))
        const fresh = await refreshStatus()
        if (fresh) { lastStatus = fresh; out = { ...out, status: fresh } }
        if (lastStatus?.adapter?.environment?.summary) break
      }
    }
    return { ...out, joined: { ...joinedServer } }
  }

  /** 模型自己（focus_enter）正在用的专注租约；别的插件/时间的租约不碰。 */
  function modelFocusLeases() {
    try { return (ctx.focus?.list?.() ?? []).filter((lease) => lease.owner === 'focus') } catch { return [] }
  }

  /** 所有 focus 租约（含时间/其它插件的）：回执要如实列出，不能只报 MC 相关的。 */
  function allFocusLeases() {
    try { return ctx.focus?.list?.() ?? [] } catch { return [] }
  }

  // MC 相关性的识别：不再只靠 focus==='mc' 字符串，也认 activity/title/goal/reason/服务器别名。
  const MC_TOKEN_RE = /(^|[^a-z0-9])mc([^a-z0-9]|$)|minecraft|我的世界/i
  function mcTokenMatch(value) {
    const text = String(value ?? '').trim()
    if (!text) return false
    if (MC_TOKEN_RE.test(text)) return true
    // 服务器别名（flat/survival…）：专注/目标里写"在 flat 服挖矿"也算 MC。
    try {
      return serverList().some((row) => row.name && new RegExp(`(^|[^a-z0-9])${String(row.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i').test(text))
    } catch { return false }
  }

  function focusIsMc(lease) {
    return [lease?.label, lease?.title, lease?.goal, lease?.reason, lease?.activity].some(mcTokenMatch)
  }

  function goalIsMc(goal) {
    const tag = String(goal?.focus ?? '')
    if (tag === focus || tag.startsWith(`${focus}:`)) return true
    return [goal?.focus, goal?.theme, goal?.title].some(mcTokenMatch)
  }

  /** MC 相关的模型 focus（cleanup 会释放）。 */
  function mcFocusLeases() {
    return modelFocusLeases().filter((lease) => focusIsMc(lease))
  }

  /** MC 相关的时间持续目标（cleanup 会 cancel）；focus 写成别的名字也能按 activity/theme/服务器识别。 */
  function mcTimeGoals() {
    try {
      const time = ctx.services?.get?.('time')
      if (!time?.goals) return []
      return time.goals().filter((goal) => goalIsMc(goal))
    } catch { return [] }
  }

  /** 所有时间持续目标（回执要如实列出，不只看 MC 的）。 */
  function allTimeGoals() {
    try {
      const time = ctx.services?.get?.('time')
      if (!time?.goals) return []
      return time.goals()
    } catch { return [] }
  }

  /** time 侧剩下的东西（schedules/lock/queue）——不碰，但要如实告诉她还有什么会叫醒她。 */
  function timeLeftover() {
    try {
      const time = ctx.services?.get?.('time')
      if (!time) return null
      const schedules = time.schedules?.() ?? []
      const queue = time.queue?.() ?? []
      const lock = time.lock?.() ?? null
      return { schedules: schedules.length, queue: queue.length, lock }
    } catch { return null }
  }

  async function leave({ cleanup = false } = {}) {
    const own = supervisor.state()
    const beforeTask = lastStatus?.task ?? null
    const externalConnected = isConnected(lastStatus) && !own.owns
    let safety = 'failed'
    try {
      await call('/v1/safety/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'leave' }), timeoutMs: 1200 })
      safety = 'ok'
    } catch { safety = 'unreachable' }
    // 新版 body 支持 POST /v1/shutdown：走干净退出（code 0 + body-exit.json 归因）。
    // 旧 body 没有这个端点 → 404，退回原来的 safety/stop + SIGTERM，不报错。
    // 只对"本会话 spawn 的"进程用：外部 body 只能安全停止，不能替别人关。
    let shutdown = own.owns ? 'unsupported' : 'external'
    if (own.owns) {
      try {
        await call('/v1/shutdown', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'leave' }), timeoutMs: 1500 })
        shutdown = 'ok'
      } catch { shutdown = 'unsupported' }
    }
    let cleanExit = false
    if (shutdown === 'ok') cleanExit = await supervisor.waitExit(2000)
    const killed = cleanExit ? { killed: false, clean: true, pid: own.pid ?? null } : await supervisor.stop({ reason: 'leave' })
    const exitInfo = supervisor.lastExit()
    lastStatus = null
    joinedServer = null
    primed = false
    lastSeq = 0

    const mcFocusBefore = mcFocusLeases()
    const mcGoalsBefore = mcTimeGoals()
    const details = []
    const processLine = () => {
      if (killed.clean) {
        const why = exitInfo?.exitInfo?.reason ? EXIT_REASON_TEXT[exitInfo.exitInfo.reason] ?? `退出原因 ${exitInfo.exitInfo.reason}` : '正常退出'
        return `body 进程：已正常退出（pid ${killed.pid ?? '?'}，${why}；code ${exitInfo?.code ?? 0}）`
      }
      if (killed.killed) return `body 进程：已结束（pid ${killed.pid ?? '?'}，${killed.forced ? 'SIGKILL 强杀' : 'SIGTERM 正常退出'}）`
      return 'body 进程：本会话没有启动过，无需停止'
    }
    if (externalConnected) details.push('body 还不是本会话启动的：只发了安全停止，进程由启动方负责（所以它还在线）')
    details.push(safety === 'ok'
      ? (beforeTask
        ? `安全停止：成功（任务 ${beforeTask.kind} ${beforeTask.id ?? ''} 已中断）`.replace('  ', ' ')
        : '安全停止：成功（当时没有任务在跑）')
      : safety === 'unreachable' ? '安全停止：body 已不在，请求跳过' : '安全停止：失败（body 没响应）')
    details.push(processLine())
    details.push('说明：mcb_leave 是离开世界（body 进程结束）；只想停任务、身体继续留在世界用 mcb_stop（暂停≠离开）。')
    // leave = 真正离开：同时退出 time 的暂停模式（如果之前 mcb_stop 开过），别把暂停状态留在 time 里。
    if (setTimePausedMode(false)) details.push('time 暂停模式：已关闭（离开世界后不再需要）。')
    if (shutdown === 'unsupported') details.push('（这个 body 不支持 /v1/shutdown，只能用 SIGTERM 结束）')

    if (cleanup) {
      const failed = []
      let released = 0
      for (const lease of mcFocusBefore) {
        try { lease.release(); released += 1 } catch { failed.push(`focus:${lease.label}`) }
      }
      let cancelled = 0
      try {
        const time = ctx.services?.get?.('time')
        for (const goal of mcGoalsBefore) {
          try { time.removeGoal(goal.id); cancelled += 1 } catch { failed.push(`goal:${goal.id}`) }
        }
      } catch { /* time 不存在：下面用剩余数量报告 */ }
      details.push(`收尾清理（MC 相关，按 activity/标签/服务器别名识别）：focus 释放 ${released} 个、持续目标取消 ${cancelled} 个${failed.length ? `；没清成功：${failed.join('、')}` : ''}`)
    }

    // 结论先行，但只对"真的空了"说干净：所有 focus/目标都算（MC 和非 MC 分开报），不再只看 MC 字符串。
    const leftFocusAll = allFocusLeases()
    const leftMcFocus = leftFocusAll.filter((lease) => focusIsMc(lease))
    const leftGoalsAll = allTimeGoals()
    const leftMcGoals = leftGoalsAll.filter((goal) => goalIsMc(goal))
    const leftOtherFocus = leftFocusAll.filter((lease) => !focusIsMc(lease))
    const leftOtherGoals = leftGoalsAll.filter((goal) => !goalIsMc(goal))
    const leftover = timeLeftover()
    const mcHanging = []
    if (externalConnected) mcHanging.push('外部 body 仍在线')
    if (leftMcFocus.length) mcHanging.push(`MC focus ${leftMcFocus.length} 个（${leftMcFocus.map((lease) => lease.label).slice(0, 3).join('、')}）`)
    if (leftMcGoals.length) mcHanging.push(`MC 持续目标 ${leftMcGoals.length} 个（${leftMcGoals.map((goal) => goal.theme ?? goal.id).slice(0, 2).join('、')}）`)
    const otherHanging = []
    if (leftOtherFocus.length) otherHanging.push(`其它 focus ${leftOtherFocus.length} 个（${leftOtherFocus.map((lease) => lease.label).slice(0, 3).join('、')}）`)
    if (leftOtherGoals.length) otherHanging.push(`其它持续目标 ${leftOtherGoals.length} 个（${leftOtherGoals.map((goal) => goal.theme ?? goal.id).slice(0, 2).join('、')}）`)
    let verdict
    if (mcHanging.length) {
      verdict = `收工完成但没完全干净：${mcHanging.join('；')}${otherHanging.length ? `；另外还有${otherHanging.join('、')}` : ''}${cleanup ? '——MC 相关已尽量清，剩下的需要手动 focus_leave / time_cancel 或再确认' : '——要一起清就 mcb_leave {cleanup:true}，或分开 focus_leave / time_cancel'}`
    } else if (otherHanging.length) {
      verdict = `body 已退出；但还有非 MC 的专注/目标在：${otherHanging.join('；')}——游戏事件不会叫醒你，这些要清用 focus_leave / time_cancel`
    } else {
      verdict = '已完全收工：body 已退出，focus 和持续目标都空着，不会被游戏事件叫醒'
    }
    if (!cleanup && (leftFocusAll.length || leftGoalsAll.length)) {
      const bits = []
      if (leftMcFocus.length || leftMcGoals.length) bits.push(`MC 相关 ${leftMcFocus.length + leftMcGoals.length} 个`)
      if (otherHanging.length) bits.push(otherHanging.join('、'))
      details.push(`还挂着（全部）：${bits.join('；')}`)
    }
    if (cleanup && (leftOtherFocus.length || leftOtherGoals.length)) details.push(`非 MC 的没动：${otherHanging.join('；')}（不归 MC 收尾管；要清用 focus_leave / time_cancel）`)
    if (leftover) {
      const bits = [`schedule ${leftover.schedules} 个（闹钟不会因 leave 消失）`, `积压 ${leftover.queue} 条`]
      if (leftover.lock) bits.push(`时间锁：${leftover.lock.reason ?? '有'}`)
      details.push(`time 侧没动：${bits.join('、')}`)
    }
    details.push('下一轮 mcb_status 应显示未连接（幂等：可以再调一次确认）')
    return [verdict, ...details].join('；')
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

  /** body 顶层 connected 是权威（断线事件先于 adapter 状态），不能只看 adapter.connected。 */
  function isConnected(status) {
    if (!status) return false
    if (status.connected != null) return Boolean(status.connected)
    return Boolean(status.adapter?.connected)
  }

  function statusLine() {
    const s = lastStatus
    const own = supervisor.state()
    const a = s?.adapter ?? {}
    if (isConnected(s)) {
      const p = a.position
      const pos = p ? fmtPosition(p) : '?'
      const paused = s.paused ? ` · 暂停(${REASON_TEXT[s.pausedReason] ?? s.pausedReason ?? '安全'})` : ''
      const bag = Number.isFinite(Number(a.inventoryCount)) ? ` · 背包${Number(a.inventoryCount)}件` : ''
      return clampLine(`MC｜在线 ${a.host}:${a.port} · ${pos} · ${taskInline(s.task)}${paused} · 血${fmtVital(a.health)}/20${bag}`)
    }
    if (s) {
      // body HTTP 活着但没连上：重连中/被踢/暂停太久。
      const reconnect = s.reconnect
      const why = s.safety?.offlineReason ?? s.pausedReason ?? null
      const state = reconnect?.exhausted ? '重连失败' : reconnect?.pending || reconnect?.attempts ? `重连中(${reconnect.attempts ?? '?'})` : '离线'
      return clampLine(`MC｜${state}${why ? `（${String(why).slice(0, 40)}）` : ''} · ${taskInline(s.task)}`)
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
    return { text: String(body.result?.text ?? ''), data: body.result?.data ?? null }
  }

  // 位置/血量统一口径：所有工具文本与提示词行都走同一取整（x,y,z 无空格），避免差 1-3 格/两种写法。
  function fmtPosition(pos) {
    if (!pos) return '未知'
    const x = Number(pos.x)
    const y = Number(pos.y)
    const z = Number(pos.z)
    if (![x, y, z].every((value) => Number.isFinite(value))) return '未知'
    return `${Math.round(x)},${Math.round(y)},${Math.round(z)}`
  }

  function fmtVital(value) {
    const number = Number(value)
    return Number.isFinite(number) ? String(Math.round(number)) : '?'
  }

  /** 结构化快照（/v1/eyes/snapshot）→ 紧凑可读文本 + JSON 尾巴。 */
  function renderSnapshotText(body = {}) {
    const snapshot = body?.snapshot ?? {}
    const inventory = snapshot.inventory ?? {}
    const counts = inventory.counts && typeof inventory.counts === 'object' ? inventory.counts : null
    const topItems = counts
      ? Object.entries(counts).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 8).map(([name, count]) => `${name}×${count}`).join('、')
      : null
    const held = snapshot.held ? `${snapshot.held.name ?? '?'}${snapshot.held.count != null ? `×${snapshot.held.count}` : ''}${snapshot.held.toolFor ? `（${snapshot.held.toolFor}）` : ''}` : '空'
    const hotbar = Array.isArray(snapshot.hotbar) ? snapshot.hotbar.filter((slot) => slot?.name).map((slot) => `${slot.slot}:${slot.name}${slot.selected ? '★' : ''}`).slice(0, 9).join(' ') : ''
    const entities = Array.isArray(snapshot.entities) ? snapshot.entities.slice(0, 8).map((row) => `${row.name ?? row.type ?? '?'}（${row.distance != null ? `${row.distance}m` : '?'}${row.position ? ` @ ${fmtPosition(row.position)}` : ''}）`).join('、') : ''
    const hostiles = Array.isArray(snapshot.nearbyHostiles) ? (snapshot.nearbyHostiles.length ? snapshot.nearbyHostiles.slice(0, 6).map((row) => `${row.name ?? row.type ?? '?'}${row.distance != null ? `(${row.distance}m)` : ''}`).join('、') : '无') : (snapshot.nearbyHostiles ? JSON.stringify(snapshot.nearbyHostiles) : '无')
    const time = snapshot.time && typeof snapshot.time === 'object' ? (snapshot.time.label ?? snapshot.time.clock ?? JSON.stringify(snapshot.time)) : (snapshot.time ?? '?')
    const map = snapshot.map ? String(snapshot.map).slice(0, 1200) : '（无脚下方块图）'
    const playable = snapshot.playable ? `可玩：${snapshot.playable.ok ? '是' : `否（${(snapshot.playable.blockers ?? []).join('、')}）`}` : null
    const safety = snapshot.safety ?? {}
    const safetyBits = [safety.paused ? `暂停中（${REASON_TEXT[safety.pausedReason] ?? safety.pausedReason ?? '安全'}）` : '未暂停']
    if (safety.reflex) safetyBits.push(`反射${safety.reflex.enabled ? '开' : '关'}${safety.reflex.active ? '/进行中' : ''}`)
    if (safety.alarms) safetyBits.push(`alarm 送达${safety.alarms.delivered ?? 0}/去重${safety.alarms.suppressed ?? 0}`)
    const queue = Array.isArray(snapshot.queue) && snapshot.queue.length ? `；队列 ${snapshot.queue.map((row) => `${row.kind ?? ''} ${row.state ?? ''}`.trim()).join('、')}` : ''
    const task = snapshot.task ? `任务：${snapshot.task.kind ?? ''} ${snapshot.task.state ?? ''}${queue}` : `任务：空闲${queue}`
    const events = Array.isArray(snapshot.recentEvents) && snapshot.recentEvents.length ? `最近事件：${snapshot.recentEvents.slice(-5).map((row) => `#${row.seq} ${row.type}`).join(' / ')}` : '最近事件：无'
    const lines = [
      `场景快照（${body?.captureMs ?? '?'}ms；radius ${snapshot.radius ?? '?'}）：${snapshot.position ? fmtPosition(snapshot.position) : '未知'} · ${snapshot.dimension ?? '?'} · 时间 ${time}`,
      `生命/饥饿/氧气：${fmtVital(snapshot.health)}/20，${fmtVital(snapshot.food)}/20，${snapshot.oxygen == null ? '?' : fmtVital(snapshot.oxygen)}${snapshot.sleeping ? '；正在睡' : ''}`,
      `手持：${held}${hotbar ? `；快捷栏 ${hotbar}` : ''}`,
      `背包：${inventory.used ?? '?'} 格${inventory.emptySlots != null ? `（空 ${inventory.emptySlots}）` : ''}${topItems ? `；${topItems}` : ''}`,
      `脚下方块图：\n${map}`,
      ...(snapshot.nearbyBlocks ? [`附近方块：${JSON.stringify(snapshot.nearbyBlocks).slice(0, 220)}`] : []),
      ...(entities ? [`实体：${entities}`] : []),
      `敌对：${hostiles}`,
      `${task}${playable ? `；${playable}` : ''}`,
      `安全：${safetyBits.join('；')}`,
      events,
    ]
    const json = JSON.stringify(snapshot)
    lines.push(`JSON（${json.length} 字）：${json.length > 3500 ? `${json.slice(0, 3500)}…（截断，完整在 body /v1/eyes/snapshot）` : json}`)
    return lines.join('\n')
  }

  /** body 的 look 文本里有原始小数（health 17.8333…）：用同一取整口径重写成"18/18/0"。 */
  function normalizeLookText(text, data = {}) {
    const lines = String(text ?? '').split('\n')
    const health = Number.isFinite(Number(data?.health)) ? Math.round(Number(data.health)) : null
    const food = Number.isFinite(Number(data?.food)) ? Math.round(Number(data.food)) : null
    return lines.map((line) => {
      if (line.startsWith('位置：') && data?.position) {
        const tail = line.includes('；') ? line.slice(line.indexOf('；')) : ''
        return `位置：${fmtPosition(data.position)}${tail}`
      }
      if (line.startsWith('生命/饥饿/氧气：')) {
        const match = line.match(/^生命\/饥饿\/氧气：([^/\n]+)\/([^/\n]+)\/(.+)$/)
        if (match) {
          const hp = health ?? fmtVital(match[1])
          const satiety = food ?? fmtVital(match[2])
          return `生命/饥饿/氧气：${hp}/${satiety}/${match[3]}`
        }
      }
      return line
    }).join('\n')
  }

  /** 背包口径：件 = 物品总数（body inventoryCount），格 = 占用格子（body inventory.used）。 */
  function backpackText(status = lastStatus) {
    const adapter = status?.adapter ?? {}
    const count = Number(adapter.inventoryCount)
    if (!Number.isFinite(count)) return null
    const used = Number(adapter.inventory?.used)
    const full = adapter.inventory?.full === true
    return `${count} 件${Number.isFinite(used) ? `（占 ${used} 格${full ? '，快满了' : ''}）` : ''}`
  }

  /** 把结果对象里的坐标（x/y/z）统一取整，避免 dig/place 的 JSON 里出现 12.70000001。 */
  function roundCoords(value, depth = 0) {
    if (Array.isArray(value)) return value.map((entry) => roundCoords(entry, depth + 1))
    if (!value || typeof value !== 'object' || depth > 3) return value
    const out = {}
    for (const [key, entry] of Object.entries(value)) {
      if ((key === 'x' || key === 'y' || key === 'z') && typeof entry === 'number' && Number.isFinite(entry)) out[key] = Math.round(entry)
      else out[key] = roundCoords(entry, depth + 1)
    }
    return out
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
    const COMBAT = new Set(['hunt', 'defend', 'flee', 'guard'])
    return rows.map((task) => {
      const bits = [`#${task.id}`, task.kind, task.state]
      if (task.state === 'paused' && task.pausedReason) bits.push(`paused=${task.pausedReason}`)
      if (task.outcomeUnknown) bits.push('outcome=unknown')
      if (task.error) bits.push(`error=${task.error}`)
      if (task.result) {
        const result = task.result
        if (result.reason) bits.push(`reason=${result.reason}`)
        else if (result.mined != null) bits.push(`mined=${result.mined}`)
        else if (result.collected != null) bits.push(`collected=${result.collected}`)
        else if (result.arrived) bits.push('arrived')
      }
      // 战斗任务：progress 里的目标/距离/攻击数/血量/敌人数直接摆出来，并说明可 cancel、危机会被中断。
      const progress = task.progress
      if (progress && COMBAT.has(String(task.kind))) {
        const parts = []
        if (progress.target != null) parts.push(`target=${progress.target}`)
        if (progress.distance != null) parts.push(`dist=${progress.distance}`)
        if (progress.attacks != null) parts.push(`attacks=${progress.attacks}`)
        if (progress.health != null) parts.push(`hp=${progress.health}`)
        if (progress.hostiles != null) parts.push(`hostiles=${Array.isArray(progress.hostiles) ? progress.hostiles.length : progress.hostiles}`)
        if (parts.length) bits.push(parts.join(' '))
        bits.push('（可 cancel；低血/苦力怕/敌人多会先自动躲避再中断）')
      }
      if (task.kind === 'shelter' && task.result?.verify) bits.push(`verify=${task.result.verify.ok ? 'ok' : 'incomplete'}${task.result.verify.summary ? `（${task.result.verify.summary}）` : ''}`)
      return bits.join(' ')
    }).join('\n')
  }

  function renderRow(row) {
    const op = String(row?.op ?? '?')
    const result = row?.result
    if (result?.text != null) return `[${op}] ${result.text}`
    if (op === 'tasks') return `[tasks]\n${renderTasks(result)}`
    if (op === 'events') return `[events]\n${renderEvents(result)}`
    if (op === 'resume') {
      // resume 带 taskId 时 body 返回被恢复的任务；不带时返回 {paused}（安全暂停的解除）。
      if (result && result.id && result.kind) return `[resume] 任务 ${result.id}（${result.kind}）${result.state ?? 'running'}：已继续`
      if (result?.paused === false) return '[resume] 已解除安全暂停；之前的任务已中断，要续做请重新下任务'
      if (result?.error) return `[resume] 没能恢复：${result.error}`
      return `[resume] ${lastStatus?.paused ? `仍暂停（${REASON_TEXT[lastStatus.pausedReason] ?? lastStatus.pausedReason}）` : '已恢复'}`
    }
    if (op === 'cancel') return `[cancel] ${result?.id ?? row?.taskId ?? '?'} ${result?.state ?? ''}`.trim()
    if (op === 'attack') {
      // body 新字段：attacked/id/hit/killed/damage/healthBefore/healthAfter；真实受伤才 hit:true。
      const target = result?.target && typeof result.target === 'object' ? result.target : null
      const name = target?.name ?? result?.targetName ?? result?.attacked ?? (typeof result?.target === 'string' ? result.target : '目标')
      const hit = result?.hit ?? result?.hitResult ?? result?.landed
      const killed = result?.killed === true
      const damage = result?.damage ?? result?.dealtDamage ?? result?.dealt
      const before = result?.healthBefore ?? null
      const after = result?.healthAfter ?? result?.targetHealth ?? result?.health ?? target?.health
      const hp = before != null && after != null ? `（血 ${before}→${after}）` : after != null ? `，目标剩余 ${after} 血` : ''
      if (hit === false || (result?.reason && damage == null && after == null)) {
        return `[attack] 没打中 ${name}（${result?.reason ?? '目标已死/太远/被挡住'}）；先靠近/换目标，别原样重试。`
      }
      if (killed) {
        return `[attack] 打死 ${name}${damage != null ? `（最后一击 ${damage} 伤害${before != null ? `，血 ${before}→0` : ''}）` : ''}；用 pickup 捡掉落。`
      }
      if (hit === true || damage != null || after != null) {
        return `[attack] 命中 ${name}${damage != null ? `，造成 ${damage} 伤害` : ''}${hp}`
      }
      return `[attack] 打了 ${name}，但 body 没返回命中/伤害/目标血量——**无法确认命中**（不要当成打赢）；先 mcb_look 看目标还在不在，或等 body 升级返回字段。`
    }
    if (op === 'pickup') {
      const picked = result?.picked ?? 0
      const names = Array.isArray(result?.items) ? result.items : []
      const left = result?.left
      const partial = result?.partial === true ? `（partial：${result?.durationMs != null ? `${Math.round(Number(result.durationMs))}ms 内` : '超时前'}没捡完，可再 pickup 或改用 task）` : ''
      return `[pickup] 捡到 ${picked} 个${names.length ? `（${names.slice(0, 6).join('、')}${names.length > 6 ? '…' : ''}）` : ''}${left != null ? `；附近还剩 ${left} 个掉落` : ''}${partial}`
    }
    if (op === 'craft') {
      const crafted = result?.crafted ?? result?.item ?? '?'
      const produced = result?.produced ?? result?.count ?? '?'
      const batches = result?.batches?.length != null ? `（${result.batches.length}/${result.craftTimes ?? '?'} 批）` : ''
      return `[craft] 做出 ${crafted}×${produced}${batches}${result?.partial ? '；partial：只完成部分，看背包再决定补做' : ''}（重的活走 task，别一次阻塞太久）`
    }
    if (op === 'say') return `[say] ${result?.ok === false ? '没发出去' : '已发送'}`
    if (result == null) return `[${op}] 已完成（没有返回内容）`
    return `[${op}] ${JSON.stringify(roundCoords(result)).slice(0, 400)}`
  }

  /** 坐标点：接受 {x,y,z} 或 [x,y,z]（模型两种写法都用过），统一成 body 认的对象。 */
  function posObject(value) {
    if (Array.isArray(value) && value.length >= 3) {
      const [x, y, z] = value.map(Number)
      if ([x, y, z].every(Number.isFinite)) return { x, y, z }
    }
    if (value && typeof value === 'object') {
      const { x, y, z } = value
      if ([x, y, z].every((n) => Number.isFinite(Number(n)))) return { x: Number(x), y: Number(y), z: Number(z) }
    }
    return null
  }

  function fixPositions(params) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) return params
    const next = { ...params }
    if (next.pos != null) next.pos = posObject(next.pos) ?? next.pos
    if (next.target != null) {
      const point = posObject(next.target)
      if (point) next.target = { pos: point }
      else if (typeof next.target === 'object' && next.target.pos != null) {
        next.target = { ...next.target, pos: posObject(next.target.pos) ?? next.target.pos }
      }
    }
    return next
  }

  /** 校验/规整 steps：错误必须能指导下一步，不能把 body 的 "未知任务：undefined" 原样丢给她。 */
  function normalizeSteps(steps) {
    if (!Array.isArray(steps) || !steps.length) {
      throw new Error('steps 需要至少 1 步。例：{"steps":[{"op":"task","kind":"mine","params":{"block":"oak_log","count":4}}]}')
    }
    const known = new Set(OPS)
    const notes = []
    const normalized = steps.map((raw, index) => {
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
        const kindFrom = raw.kind != null ? 'kind' : raw.params?.kind != null ? 'params.kind' : raw.params?.params?.kind != null ? 'params.params.kind' : null
        const kind = String(raw.kind ?? raw.params?.kind ?? raw.params?.params?.kind ?? '').trim()
        if (!kind) throw new Error(`${where} task 缺少 kind。可用 kind：${TASK_KINDS.join('、')}；例：{"op":"task","kind":"mine","params":{"block":"oak_log","count":4}}`)
        if (!TASK_KINDS.includes(kind)) {
          const near = closestIn(kind, TASK_KINDS)
          throw new Error(`${where}未知任务 kind：${kind}${near ? `；你是不是要 ${near}？` : ''}。可用：${TASK_KINDS.join('、')}`)
        }
        if (kindFrom !== 'kind') notes.push(`kind 写在了 ${kindFrom} 里，已按 kind:"${kind}" 处理（建议直接放顶层）`)
        step.kind = kind
        const params = raw.params?.params ?? raw.params
        step.params = params && typeof params === 'object' ? { ...params } : {}
        // 参数别名：mine/collect 的 block ↔ name；显式说"你写的什么、我按什么处理"，别静默纠正。
        if (step.params.block == null) {
          const alias = step.params.name ?? step.params.kind ?? step.params.target
          if (alias != null && (kind === 'mine' || kind === 'collect')) {
            step.params.block = alias
            notes.push(`${kind} 没写 block，用了 name=${JSON.stringify(alias)}，已按 block 处理（文档写法是 {block:"..."}）`)
          }
        }
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
      // wait 的 body 参数叫 ms；模型常写 durationMs，这里做一次容错，避免"等了 8 秒"实际只等 500ms。
      if (op === 'wait') {
        const params = raw.params && typeof raw.params === 'object' ? raw.params : {}
        const requested = Number(params.ms ?? params.durationMs ?? raw.ms ?? raw.durationMs)
        const ms = Number.isFinite(requested) ? Math.max(0, Math.min(30_000, requested)) : (params.ms ?? 500)
        step.params = { ...params, ms }
        if (Number.isFinite(requested) && requested > 30_000) {
          notes.push(`wait 单次最多 30s（你要了 ${Math.round(requested / 1000)}s，已截断）；长任务不要用 wait 轮询，完成/失败会作为事件回来`)
        }
      }
      if (op === 'events' && raw.since == null) step.since = lastSeq
      // 坐标容错：params.pos / params.target 或顶层 pos/target，可以写 [x,y,z] 也可以写 {x,y,z}。
      // 但"给了坐标却解析不了"必须报参数格式错——不能落到 body 的"找不到目标方块"上误导她。
      step.params = fixPositions(step.params)
      // params.pos 是最常见的写法；给了却解析不了必须报格式错（body 的错误会误导成"世界里没方块"）。
      if (step.params?.pos != null) {
        const point = posObject(step.params.pos)
        if (!point) throw new Error(`${where} 参数格式不对：params.pos 需要 {x,y,z} 或 [x,y,z]，收到 ${JSON.stringify(step.params.pos).slice(0, 60)}。这是参数写法问题，不是"世界里没有方块"。`)
        step.params = { ...step.params, pos: point }
      }
      if (step.pos != null) {
        const point = posObject(step.pos)
        if (!point) throw new Error(`${where} 参数格式不对：pos 需要 {x,y,z} 或 [x,y,z]，收到 ${JSON.stringify(step.pos).slice(0, 60)}。这是参数写法问题，不是"世界里没有方块"。`)
        step.pos = point
      }
      if (step.target != null) {
        const point = posObject(step.target)
        if (point) step.target = { pos: point }
        else if (['dig', 'place', 'use', 'chest', 'attack'].includes(op) && (step.params?.target != null) === false) {
          throw new Error(`${where} 参数格式不对：target 需要 {x,y,z}/[x,y,z] 或 {entity/name}，收到 ${JSON.stringify(step.target).slice(0, 60)}。`)
        }
      }
      return step
    })
    return { steps: normalized, notes }
  }

  function doTimeoutText(timeoutMs) {
    return `mcb_do 在 ${Math.round(timeoutMs / 1000)}s 内没有返回：steps 里的长动作（goto/mine/explore 这类单步 op）可能还在跑。先 mcb_status 看位置/任务，或 {"steps":[{"op":"tasks"}]} 查台账；不要原样重试。长任务请用 {"op":"task"} 提交，立即拿 taskId。`
  }

  /** 暂停原因 → 可操作建议（别只说"先 resume"：不处理原因会被再次暂停）。 */
  const PAUSE_ADVICE = {
    'low-health': '先吃/撤到安全点（eat 或 goto 掩体），血回上去再 resume；不处理会一直被暂停',
    'health-drop': '先撤到安全点/吃，血稳住再 resume；继续硬拼会反复被暂停',
    'low-oxygen': '先回水面/离开水下，氧气回来再 resume',
    'spawn-unsafe': '先 goto 到安全位置，再 resume',
    death: '复活后先 goto 安全点再 resume；旧任务不会续跑',
    quarantine: '连续死亡隔离：先离开危险区/等隔离结束，再 resume',
    disconnect: '等 body 重连；重连后身体仍是暂停态，要显式 resume',
    stuck: '先 mcb_map 看地形、goto 脱困，再 resume',
    'user-stop': '你让它停的：直接 {"op":"resume"} 继续，或 mcb_leave 离开；不会自动恢复',
    emergency: '紧急规避中：先 mcb_look 确认脱离危险，再 resume',
  }
  function pauseAdvice(reason) {
    return PAUSE_ADVICE[String(reason ?? '')] ?? '先看清原因/环境再 resume；只 resume 不处理原因会被再次暂停'
  }

  /** 单步重复动作的宏提示：不拒绝，只在节流窗口内提一次（每 2 分钟）。 */
  let lastMacroHintAt = 0
  const MACRO_HINT_OPS = new Set(['mine', 'dig', 'place', 'goto', 'move', 'attack'])
  const MACRO_HINT = '（提示：这类重复动作可用宏——采集 collect、挖通道 tunnel、建造 build/shelter、打架 mcb_combat、补刀 mcb_attack；单步适合少量/精确动作。此提示每 2 分钟最多一次，不用回复它。）'

  async function runDo(steps, safety = null) {
    const { steps: normalized, notes } = normalizeSteps(steps)
    const noteText = notes.length ? `（参数处理：${notes.join('；')}）` : ''
    const timeoutMs = Number(raw.doTimeoutMs) || 120_000
    // 逐步执行（而不是一次发整批）：一步失败也能把**已执行步骤的结果**带回来，
    // 失败归因到具体第几步；task 语义保持"提交后立即返回、后面的步骤不执行"。
    const parts = []
    let task = null
    let failed = null
    for (let index = 0; index < normalized.length; index += 1) {
      const step = normalized[index]
      try {
        const body = await call('/v1/do', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ steps: [step], safety }),
          timeoutMs,
        })
        lastStatus = await refreshStatus() ?? lastStatus
        for (const row of body.results ?? []) parts.push(renderRow({ ...row, index }))
        // resume 是"继续玩"：同步退出 time 的暂停模式（mcb_stop/危险暂停留下的）。
        if (step.op === 'resume' && setTimePausedMode(false)) parts.push('（已退出时间暂停模式：任务恢复受理；sleep/schedule 计时未受影响）')
        if (body.task) { task = body.task; break }
      } catch (error) {
        if (isTimeoutError(error) || error?.code === 'timeout') {
          return { text: [...parts, doTimeoutText(timeoutMs)].filter(Boolean).join('\n\n') }
        }
        failed = { index, op: step.op, error }
        break
      }
    }
    if (failed) {
      const message = String(failed.error?.message ?? failed.error)
      const pausedReason = (/暂停（([^）]+)）/.exec(message) ?? [])[1] ?? null
      const hint = /暂停/.test(message) ? `；${pauseAdvice(pausedReason)}。暂停期间仍可用 look/inventory/map/scan/move/eat/cancel/tasks/events/resume/stop`
        : /未允许|403/.test(message) ? '；body 启动参数没开这个能力（--allow-task/--allow-say），需要重起 body'
          : /offline|未连接|断线/.test(message) ? '；身体不在线：先 mcb_status，必要时 mcb_join；重连后身体仍暂停，要显式 resume'
            : /队列已满|429|409|上一个 do 动作还在执行/.test(message) ? '；先 {"steps":[{"op":"tasks"}]} 看有什么在跑；长动作一律用 {"op":"task"} 提交，别并发单步 op'
              : /已结束.*不能 resume|409/.test(message) ? '；这个任务已结束，需要就重新下任务'
                : ''
      const done = parts.length ? `\n\n已完成的前序步骤：\n${parts.join('\n\n')}` : '\n\n失败前没有已完成的步骤。'
      throw new Error(`第 ${failed.index + 1} 步（${failed.op}）失败：${message}${hint}${done}`)
    }
    if (noteText) parts.push(noteText)
    if (task) {
      const head = `任务 ${task.id}（${task.kind}）已接受，状态 ${task.state}。完成/失败/中断会作为事件通知回来，**不要循环 mcb_status/tasks 查**（需要时看一眼即可）。`
      return { text: parts.length ? `${parts.join('\n\n')}\n\n${head}` : head }
    }
    // 用单步做重复动作时提示宏（不拒绝、节流 2 分钟）：S2 实测 mcb_do 121 次、combat 5、attack 0，
    // 说明模型仍在用单步硬刷，需要在回执里把我们教的宏再提一次。
    if (normalized.some((step) => MACRO_HINT_OPS.has(step.op)) && Date.now() - lastMacroHintAt > 120_000) {
      lastMacroHintAt = Date.now()
      parts.push(MACRO_HINT)
    }
    return { text: parts.length ? parts.join('\n\n') : '没有返回结果。' }
  }

  const tools = [
    {
      name: 'mcb_servers',
      summary: '列出已知 MC 服务器（name / host:port），用于 mcb_join 选目标。',
      description: '清单来自 mc-link 自带 servers.json（flat 54837、survival 54838），配置会追加；最近 mcb_lan 结果也在。不探测在线——连不上由 mcb_join 报错。为空时直接 mcb_join {host,port}。',
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
      description: '参数：server（mcb_servers/mcb_lan 里的名字）或 host + port（默认 25565），username 可选（≤16 字符，同服唯一；默认 ICL）。成功返回服务器与连接状态，之后 mcb_status 复核。失败给可读原因（退出码/日志/端口/服务器/同名被踢）；可再 join。想认真投入：连上后 focus_enter 带 activity:"mc"，再 time_arrange {mode:"goal",focus:"mc"} 建持续目标；收尾 mcb_leave {cleanup:true}。',
      when: ['被叫去玩，或她自己想玩', 'mcb_status 显示未连接、服务器已经开着'],
      avoid: ['body 已经连在另一台服务器：先 mcb_leave', '只想随便玩一小会儿：连上直接玩，不必建 focus/goal'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          server: { type: 'string', description: 'mcb_servers/mcb_lan 返回的服务器名，如 flat、survival。优先用它，不用记端口。' },
          host: { type: 'string', description: '服务器地址；和 server 二选一。' },
          port: { type: 'number', description: '服务器端口；默认 25565。' },
          username: { type: 'string', description: '游戏内名字，≤16 字符，同服唯一；默认 ICL。两个 bot 同名会互相踢。' },
          force: { type: 'boolean', description: '睡眠期默认拒绝 join（身体已被管理面收起）。只有用户明确要求“现在就去玩”时才传 true。' },
        },
      },
      async execute(args = {}) {
        const out = await join(args)
        const a = out.status?.adapter ?? {}
        const pos = a.position ? fmtPosition(a.position) : '未知'
        const how = out.reused ? '复用了一个已经连着的 body' : 'body 已启动并连上'
        // 新版 body 的 preflight：这张图有什么资源（她问过"能不能给张服务器小卡片"）。
        const env = a.environment?.summary ? `；环境：${String(a.environment.summary).slice(0, 160)}` : ''
        // E6：join 之后直接说"现在能不能玩/为什么不能"，不让她自己拼状态。
        const playable = out.status?.playable
        const blockerText = { offline: '身体离线', 'spawn-unsafe': '出生点危险', reconnecting: '重连中', dead: '已死亡' }
        const playLine = playable && typeof playable.ok === 'boolean'
          ? `可玩：${playable.ok ? '是' : `否（${(playable.blockers ?? []).map((row) => String(row).startsWith('paused:') ? `暂停中（${REASON_TEXT[String(row).slice(7)] ?? String(row).slice(7)}）` : blockerText[row] ?? row).join('、')}）`}`
          : null
        return { text: `已连接 ${out.joined.host}:${out.joined.port}（${how}），位置 ${pos}${env}${playLine ? `；${playLine}` : ''}。下一步：mcb_status/mcb_look 看周围；要做事用 mcb_do 下任务。` }
      },
    },
    {
      name: 'mcb_leave',
      summary: '退出 MC：安全停止并结束本会话启动的 body；可选 cleanup 一并清 focus/goal。',
      description: '先安全停止（当前任务标 interrupted），再对"本会话自己 spawn 的"进程 SIGTERM→SIGKILL；外部 body 只安全停止、不杀进程（返回里说明）。返回报告：安全停止是否成功、进程怎么结束、还挂着什么 focus/goal。默认只停 body；不想被持续叫醒带 cleanup：释放模型 focus、取消 MC 相关 time 目标。幂等。离开世界=结束 body；只想停任务用 mcb_stop（暂停≠离开）。',
      when: ['不想玩了/要收尾', 'body 卡死、需要重起（先 leave 再 join）', '收工：想同时清掉 focus 和 MC 持续目标'],
      avoid: ['只离开游戏但想保留持续目标：默认 leave 就行，别带 cleanup'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cleanup: { type: 'boolean', description: '默认 false：只停 body 并报告还剩什么。true：同时释放 focus 租约、取消 focus="mc" 的 time 持续目标（不碰闹钟/积压）。' },
        },
      },
      async execute({ cleanup = false } = {}) { return { text: await leave({ cleanup: Boolean(cleanup) }) } },
    },
    {
      name: 'mcb_stop',
      summary: '暂停身体：停掉当前任务并触发安全反射；身体仍留在世界（会掉落/受伤），危险会穿透通知。',
      description: '暂停身体：停当前任务+触发安全反射，不要求先 resume，幂等。返回"任务已停/身体仍在世界/最近危险"。暂停≠离开：身体还在世界（会掉落/受伤），只是不接任务；继续 {"steps":[{"op":"resume"}]}，彻底退出 mcb_leave。暂停/睡眠期的危险（死亡/低血/安全反射/被踢/断线）仍会 alarm 穿透，被 pause 拦住会暂存补投。',
      when: ['想暂时不玩/去干别的，但不想退出世界', '任务失控或遇到危险，先停手观察', '被游戏事件打断、需要立刻停掉当前任务'],
      avoid: ['想彻底退出游戏、结束 body：用 mcb_leave', '只是想知道状态：用 mcb_status'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          reason: { type: 'string', description: '一句话原因（记进 body 台账），如"去写代码了"/"怪太多先撤"。' },
          taskId: { type: 'string', description: '可选：额外显式 cancel 的任务 id（通常 safety/stop 已经中断当前任务）。' },
        },
      },
      async execute({ reason = null, taskId = null } = {}) {
        const before = lastStatus
        const beforeTask = before?.task ?? null
        let stop = null
        try {
          stop = await call('/v1/safety/stop', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ reason: String(reason ?? 'stop') }), timeoutMs: 1500,
          })
        } catch (error) {
          throw new Error(`mcb_stop 没能让 body 停手：${String(error?.message ?? error)}；先 mcb_status 看进程，必要时 mcb_leave。暂停不等于离开，身体可能还在世界。`)
        }
        if (taskId) {
          try { await call(`/v1/tasks/${encodeURIComponent(String(taskId))}/cancel`, { method: 'POST', timeoutMs: 1500 }) } catch { /* safety/stop 通常已中断 */ }
        }
        // time 的暂停模式：任务停、世界继续、计时不冻结；goal/focus/schedules 都保留，alarm 可穿透。
        setTimePausedMode(true, reason ?? 'mcb_stop')
        lastStatus = await refreshStatus() ?? lastStatus
        const status = lastStatus
        const adapter = status?.adapter ?? {}
        const safety = status?.safety ?? {}
        const task = status?.task ?? beforeTask
        const reasonText = REASON_TEXT[safety.reason ?? status?.pausedReason] ?? safety.reason ?? status?.pausedReason ?? '安全'
        // body 会把暂停原因规范化成 user-stop，原始调用原因留在 requestedReason（例如 mcb_stop/自定义）。
        const requestedReason = safety.requestedReason ?? safety.reasonRequested ?? null
        const reasonSuffix = requestedReason && String(requestedReason) !== String(safety.reason ?? '') ? `（原始原因：${String(requestedReason).slice(0, 40)}）` : ''
        // 新版 body 的 stopAll 回执把"任务"和"身体"分开说（task.note / body.note / reflex）；旧版退回本地文案。
        const cancelled = Array.isArray(stop?.task?.cancelled) ? stop.task.cancelled : []
        const stopped = stop?.task?.note
          ?? (task ? `${task.kind} ${task.id ?? ''} 已中断`.replace('  ', ' ') : '当时没有任务在跑')
        const bodyNote = stop?.body?.note
          ?? '**身体仍在世界**（已暂停，不是离开——会掉落/受伤/被推，只是不接任务）'
        const bodyOnline = stop?.body?.online ?? (adapter.connected !== false)
        const reflex = stop?.reflex ?? safety.reflex ?? null
        const danger = status?.danger?.inDanger
          ? `脚边有危险方块：${(status.danger.blocks ?? []).map((row) => row.name).slice(0, 4).join('、')}`
          : status?.lastDeath?.at
            ? `最近一次死亡：${new Date(Number(status.lastDeath.at)).toLocaleTimeString('zh-CN', { hour12: false })} @ ${fmtPosition(status.lastDeath.position)}（掉落 ${status.lastDeath.inventoryCount ?? '?'} 件）`
            : '最近没有新的危险事件'
        const pausedMode = timePausedMode()
        const lastPierce = timeLastPierce()
        const timeLine = pausedMode
          ? `time 暂停模式：${pausedMode.active ? '已开（任务停、世界继续、计时不冻结；goal/focus 都保留）' : '未开'}${pausedMode.reason ? `，原因 ${pausedMode.reason}` : ''}${lastPierce ? `；最近穿透：${String(lastPierce.text ?? lastPierce.reason ?? '危险事件').slice(0, 60)}` : ''}`
          : 'time 暂停模式：这个版本没有该接口（仅 body 暂停）'
        const reflexLine = reflex
          ? `安全反射：${reflex.enabled ? '开启' : '关闭'}（≤${Math.round((reflex.maxDurationMs ?? 10000) / 1000)}s/次、≤${reflex.maxPerMinute ?? 2} 次/分）${reflex.active ? `；正在规避（${reflex.count ?? 0} 次）` : ''}`
          : null
        return {
          text: [
            `任务已停：${stopped}（暂停原因：${reasonText}${reasonSuffix}）。`,
            `身体：${bodyNote}${bodyOnline ? '' : '（当前不在世界上）'}${cancelled.length ? `；本次取消 ${cancelled.map((row) => `${row.kind ?? 'task'} ${row.id ?? ''}`).join('、')}` : ''}。`,
            `当前位置 ${fmtPosition(stop?.body?.position ?? adapter.position)}，生命 ${fmtVital(stop?.body?.health ?? adapter.health)}/20；${danger}。`,
            ...(reflexLine ? [reflexLine] : []),
            timeLine,
            '危险不会被吞：死亡/低血/安全反射/被踢/断线这类 alarm 会穿透唤醒你；如果被 pause/静音拦住会暂存，gate 打开后补投。',
            '不会静默清你的东西：继续用 time_resume 或 {"steps":[{"op":"resume"}]}（会同时退出 time 暂停模式）；离开世界用 mcb_leave / time_cancel。',
          ].join('\n'),
        }
      },
    },
    {
      name: 'mcb_shelter',
      summary: '盖一间带验收的小屋（四面墙+门洞+屋顶+入口），完成后记住 home；夜里/下雨回来躲。',
      description: '一条 task：按 size/height/material 建房，body 验收四面墙/屋顶/门洞/室内高度，并真的从门外走进门内(entryOk)，成功后写 home（status.home，持久化）。参数 size(3–9 奇数,默认3)、height(3–6,默认3)、material(默认 dirt；橡木屋用 oak_planks)、door(true=有门就装)。done 回执带 verify.summary + 家的坐标/门朝向；失败码：no-site（地形放不下）、needs-material（方块不够，回执带缺数）、incomplete（结构差哪面/几块）、entry-blocked（门洞/门外被挡）——按码补，不用重跑整间。结构验收 body 已做，不需要截图验收。',
      when: ['夜里/下雨前要有安全屋', '想固定一个家（home）以后回来躲/存东西', '被怪追要临时躲藏'],
      avoid: ['只想搭几块方块：mcb_do place', '要盖大建筑：build 蓝图（beta）'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          size: { type: 'number', description: '边长（3–9，奇数，默认 3）。' },
          height: { type: 'number', description: '总高（3–6，默认 3；室内高 = height-1）。' },
          material: { type: 'string', description: '方块材料：dirt（默认）、oak_planks 等；材料不够会 needs-material。' },
          door: { type: 'boolean', description: 'true = 背包有门就装上（不装门洞也能进出/验收）。' },
        },
      },
      async execute(args = {}) {
        const params = {}
        for (const key of ['size', 'height', 'material', 'door']) if (args[key] != null) params[key] = args[key]
        return runDo([{ op: 'task', kind: 'shelter', params }])
      },
    },
    {
      name: 'mcb_combat',
      summary: '战斗宏：hunt 猎杀 / defend 防御 / flee 逃跑 / guard 守卫（自动选武器/走位/低血中断）。',
      description: '一条 task 完成整场战斗，别逐次手动 attack。mode=hunt|defend|flee|guard（省略默认 hunt）；target 可省略（默认 nearest_hostile；hunt 可 "chicken"/"zombie"/"nearest:villager"；flee/guard 不需要）、radius(16)、attackRange(3)、lostTargetMs(10s)、maxDurationMs（guard120s/flee30s/其他60s）、lowHealth(10)、maxHostiles(3)、creeperDistance(5)、safeDistance(24)。立即返回 taskId；progress 有 mode/state/target/targetHealth/distance/attacks/health/hostiles；可 {"op":"cancel"}。危机（低血/苦力怕近身/敌人过多）会先自动躲避再 task_failed(combat: reason)——按提示先吃/躲或改 flee；打死目标后用 pickup 捡掉落。',
      when: ['要打怪/防守基地/从怪群逃跑/站岗', '多只敌人或持久战（单只补刀用 mcb_attack）'],
      avoid: ['只想打一下面前一只：mcb_attack 更直接', '没武器/护甲：先 craft 或跑，别硬刚'],
      parameters: {
        type: 'object',
        additionalProperties: true,
        properties: {
          mode: { type: 'string', description: 'hunt 猎杀 / defend 防御 / flee 逃跑 / guard 守卫。' },
          target: { type: 'string', description: '目标：chicken/zombie/nearest/nearest_hostile/nearest:villager 等；默认 nearest_hostile。' },
          radius: { type: 'number', description: '搜索半径（4–32，默认 16）。' },
          attackRange: { type: 'number', description: '攻击距离（2–4，默认 3）。' },
          lostTargetMs: { type: 'number', description: '目标丢失多久放弃（1–60s，默认 10s）。' },
          maxDurationMs: { type: 'number', description: '整场战斗上限（5–300s；guard 120s/flee 30s/其他 60s）。' },
          lowHealth: { type: 'number', description: '低血中断阈值（1–20，默认 10）。' },
          maxHostiles: { type: 'number', description: '敌人超过多少中断（1–12，默认 3）。' },
          creeperDistance: { type: 'number', description: '苦力怕多近算危险（2–12，默认 5）。' },
          safeDistance: { type: 'number', description: 'flee 跑到多远算安全（8–48，默认 24）。' },
        },
        required: [],
      },
      async execute(args = {}) {
        // 默认可用：不给 mode 时按 hunt（打附近敌对）执行，并在回执里说明；给错才报错并给示例。
        const defaulted = args.mode == null
        const mode = String(args.mode ?? 'hunt').trim()
        if (!['hunt', 'defend', 'flee', 'guard'].includes(mode)) {
          throw new Error(`mcb_combat 的 mode 只能是 hunt/defend/flee/guard（收到 ${mode || '(空)'}）。例：{"mode":"hunt","target":"nearest_hostile"}、{"mode":"flee"}、{"mode":"guard"}；单只补刀用 mcb_attack {target:"zombie"}。`)
        }
        const params = {}
        for (const key of ['target', 'radius', 'attackRange', 'lostTargetMs', 'maxDurationMs', 'lowHealth', 'maxHostiles', 'creeperDistance', 'safeDistance']) {
          if (args[key] != null) params[key] = args[key]
        }
        const out = await runDo([{ op: 'task', kind: mode, params }])
        if (defaulted) out.text = `${out.text}\n（没指定 mode，默认按 hunt 打附近敌对；想逃跑用 mode:"flee"，守卫用 mode:"guard"，指定目标用 target。）`
        return out
      },
    },
    {
      name: 'mcb_attack',
      summary: '攻击单个目标（自动判定命中/伤害/击杀）；多只或持久战用 mcb_combat。',
      description: 'target 支持 "chicken"/"zombie"/"nearest"/"nearest_hostile"/"nearest:villager"；range 默认 4.5（2–6）。返回 hit/damage/healthBefore→healthAfter/killed；真实受伤才 hit:true；太远/没打中会报错（先靠近，别原样重试）；killed:true 后用 pickup 捡掉落。只适合单只/补刀；多只、防守、逃跑用 mcb_combat {mode:"hunt|defend|flee|guard"}（自动选武器/走位/低血中断）。',
      when: ['补刀/打面前一只', '想确认这一下有没有打中'],
      avoid: ['多只敌人/持久战：用 mcb_combat，别手动循环 attack', '目标太远：先 goto 到 3-4 格内'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: { type: 'string', description: '目标：chicken/zombie/nearest/nearest_hostile/nearest:villager 等（掉落物/投射物会被 body 排除）。' },
          range: { type: 'number', description: '攻击距离（2–6，默认 4.5）；太远会报错。' },
        },
        required: ['target'],
      },
      async execute({ target = null, range = null } = {}) {
        if (!target) throw new Error('mcb_attack 需要 target（如 "chicken"/"nearest_hostile"）；多只敌人用 mcb_combat。')
        const params = { target: String(target) }
        if (range != null) params.range = Number(range)
        return runDo([{ op: 'attack', params }])
      },
    },
    {
      name: 'mcb_status',
      summary: '查看身体当前事实：连接/服务器/位置/生命/饥饿/背包/当前任务与队列/暂停原因/重连/body 进程状态。只读。',
      description: '返回多行事实。**只在需要时查一次，不要轮询**（任务进度会作为事件回来）。连接行以 body 顶层 connected 为准（不会假在线），离线附原因/重连。任务行 kind/state：paused=断线挂起（{"op":"resume","taskId":"t-x"} 继续）、unknown=超时未知（先看背包/位置）、failed 带 error。暂停行给原因 + 可操作建议（吃/撤/换位置/何时再 resume），暂停=停任务、身体仍在世界。危险补投行说明被 pause/睡眠拦下、等待补投的 alarm。',
      when: ['行动前确认位置/血量/任务', '任务事件之后核对真实结果', '怀疑掉线/卡死'],
      parameters: { type: 'object', properties: {} },
      async execute() {
        const status = await refreshStatus()
        const own = supervisor.state()
        if (!status) {
          const lines = ['MC 身体：未连接（/v1/status 无响应）']
          lines.push(`进程：${own.owns ? `已启动 pid ${own.pid ?? '?'}${own.alive ? '（运行中）' : `（已退出：${describeExit(own.exitCode, own.exitSignal)}）`}` : '本会话没有启动 body'}`)
          // 上次退出如果是外部/管理面干净关闭（例如睡眠期 /v1/shutdown），醒来第一眼就能看到，不会当成崩溃。
          const last = supervisor.lastExit()
          if (last) {
            const clean = last.exitClass?.expected && String(last.exitClass?.source ?? '').startsWith('clean:')
            const why = last.exitInfo?.reason
              ? EXIT_REASON_TEXT[last.exitInfo.reason] ?? `退出原因 ${last.exitInfo.reason}`
              : last.signal ? describeExit(last.code, last.signal) : last.code === 0 ? '正常退出' : '异常退出'
            lines.push(`上次退出：${why}${clean ? '（预期内，不是崩溃）' : ''}${last.code != null ? `；code ${last.code}` : ''}`)
          }
          if (own.stderrTail?.length) lines.push(`body 日志：${own.stderrTail.slice(-2).join(' / ')}`)
          const phase = timePhase()
          if (phase === 'sleeping') {
            lines.push('现在在睡觉（time 的睡眠安排生效中）：身体被管理面收起来了，不要 mcb_join；醒来后再连（除非用户明确要求现在玩）。')
          } else {
            lines.push('下一步：mcb_join 重连（会重新起进程）；不玩了用 mcb_leave 收尾。')
          }
          return { text: lines.join('\n') }
        }
        const a = status.adapter ?? {}
        const connected = isConnected(status)
        const offlineReason = status.safety?.offlineReason ?? null
        // 陆地上 body 的 oxygen 是 null（不是 0）——别显示"氧气 0"让她以为在憋气。
        const oxygen = a.oxygen == null || !Number.isFinite(Number(a.oxygen)) ? '?' : Math.round(Number(a.oxygen))
        const bag = backpackText(status)
        const lines = [
          `MC 身体：${connected ? '已连接' : '未连接'} ${a.host ?? ''}:${a.port ?? ''}${!connected && offlineReason ? `（离线原因：${String(offlineReason).slice(0, 120)}）` : ''}`,
          `玩家：${(a.players ?? []).join('、') || '无'}`,
          `位置：${fmtPosition(a.position)} · 维度 ${a.dimension ?? '?'}`,
          `生命/饥饿/氧气：${fmtVital(a.health)}/20，${fmtVital(a.food)}/20，${oxygen}`,
          `背包：${bag ?? '未知'}`,
          `任务：${status.task ? `${status.task.kind} ${status.task.state}${status.task.outcomeUnknown ? '（结果未知）' : ''}${status.task.state === 'paused' ? '（断线挂起，可 resume taskId 继续）' : ''}` : '空闲'}；队列 ${status.queue?.length ?? 0}`,
        ]
        const reconnect = status.reconnect
        if (reconnect && (reconnect.pending || reconnect.attempts || reconnect.exhausted)) {
          lines.push(`重连：第 ${reconnect.attempts ?? 0}/${reconnect.max ?? '?'} 次${reconnect.exhausted ? '（已放弃，需要 mcb_join）' : ''}${reconnect.lastError ? ` · ${String(reconnect.lastError).slice(0, 80)}` : ''}`)
        }
        if (Array.isArray(status.pausedTasks) && status.pausedTasks.length) {
          lines.push(`断线挂起的任务：${status.pausedTasks.map((task) => `#${task.id} ${task.kind}`).join('、')}（可 {"op":"resume","taskId":"…"} 继续）`)
        }
        if (status.adapter?.environment?.summary) lines.push(`环境：${String(status.adapter.environment.summary).slice(0, 160)}`)
        if (status.adapter?.pathfinder && status.adapter.pathfinder.available === false) lines.push('寻路：不可用（body 的 pathfinder 没加载；只能手挖/短距移动）')
        // time 的睡眠边界事实（下一版才有；旧版无字段就静默）：只读展示，不做 cancel。
        const boundary = timeSleepBoundary()
        if (boundary) lines.push(boundary.text)
        if (status.paused) lines.push(`暂停：${REASON_TEXT[status.pausedReason] ?? status.pausedReason}——${pauseAdvice(status.pausedReason)}`)
        // 暂停 ≠ 离开：把 body 的安全反射状态与时间相位都摆出来，并说明危险仍会穿透。
        const safetyState = status.safety ?? {}
        const reflex = safetyState.reflex ?? null
        if (reflex) {
          const last = safetyState.lastReflex
          const lastText = last?.at
            ? `；最近一次自动规避：${new Date(Number(last.at)).toLocaleTimeString('zh-CN', { hour12: false })}（${last.reason ?? '危险'}${last.action ? ` → ${last.action}` : ''}${last.timedOut ? '，超时未完成' : ''}）`
            : ''
          lines.push(`安全反射：${reflex.enabled ? '开启' : '关闭'}（≤${Math.round((reflex.maxDurationMs ?? 10000) / 1000)}s/次、≤${reflex.maxPerMinute ?? 2} 次/分）${reflex.active ? `；正在规避（${reflex.count ?? 0} 次）` : ''}${lastText}`)
        }
        if (safetyState.paused) {
          lines.push('暂停语义：任务停/不接活，但身体仍在世界（会掉落/受伤/被推）；不处理原因会被再次暂停；离开世界用 mcb_leave')
        }
        // 战斗/防御：附近敌对、自动躲避记录、恢复宽限（低血恢复期 3s 内不会被立刻按回去）。
        const hostiles = Array.isArray(status.adapter?.nearbyHostiles) ? status.adapter.nearbyHostiles : []
        lines.push(`附近敌对：${hostiles.length ? hostiles.slice(0, 6).map((row) => `${row.name ?? '?'}(${row.distance != null ? `${row.distance}m` : '?'}${row.position ? ` @ ${fmtPosition(row.position)}` : ''})`).join('、') : '无'}`)
        const defense = safetyState.autoDefense
        if (defense) {
          const lastDefense = safetyState.lastDefense
          const lastText = lastDefense?.at
            ? `；最近一次：${new Date(Number(lastDefense.at)).toLocaleTimeString('zh-CN', { hour12: false })} ${REASON_TEXT[lastDefense.reason] ?? lastDefense.reason ?? '威胁'} → ${lastDefense.action ?? '?'}（${Math.round(Number(lastDefense.durationMs) || 0)}ms${lastDefense.timedOut ? '，超时' : ''}）`
            : ''
          lines.push(`自动防御：${defense.enabled ? '开启' : '关闭'}（已 ${defense.count ?? 0} 次；冷却 ${Math.round((Number(defense.cooldownMs) || 0) / 1000)}s；威胁距离 ${defense.threatDistance ?? '?'}m / 苦力怕 ${defense.creeperDistance ?? '?'}m）${defense.active ? '；正在躲避' : ''}${lastText}`)
        }
        const recovery = safetyState.recovery
        if (recovery) {
          const graceUntil = Number(recovery.resumeGraceUntil)
          const cooldownUntil = Number(recovery.lowHealthPauseCooldownUntil)
          const graceText = Number.isFinite(graceUntil) && graceUntil > Date.now() ? `resume 宽限剩余 ${Math.ceil((graceUntil - Date.now()) / 1000)}s` : `resume 后 ${Math.round((Number(recovery.resumeGraceMs) || 3000) / 1000)}s 宽限`
          const cooldownText = Number.isFinite(cooldownUntil) && cooldownUntil > Date.now() ? `低血暂停冷却剩余 ${Math.ceil((cooldownUntil - Date.now()) / 1000)}s` : '低血暂停冷却已过'
          lines.push(`恢复规则：${graceText}（期内不会被立刻再暂停）；${cooldownText}；极低血 ≤${recovery.criticalHealth ?? '?'} 才会立即再暂停${recovery.pausedRecoverable ? '；当前暂停可恢复（先 eat/撤，再 resume）' : ''}`)
        }
        if (status.playable && typeof status.playable.ok === 'boolean') {
          const blockerText = {
            offline: '身体离线',
            'spawn-unsafe': '出生点危险',
            reconnecting: '重连中',
            dead: '已死亡',
          }
          const blockers = (status.playable.blockers ?? []).map((row) => String(row).startsWith('paused:') ? `暂停中（${REASON_TEXT[String(row).slice(7)] ?? String(row).slice(7)}）` : blockerText[row] ?? row)
          lines.push(`可玩：${status.playable.ok ? '是' : `否（${blockers.join('、')}）`}`)
        }
        if (Array.isArray(status.spawnLog) && status.spawnLog.length) {
          const lastSpawn = status.spawnLog[status.spawnLog.length - 1]
          lines.push(`最近 spawn：${fmtPosition(lastSpawn.position)} · ${lastSpawn.dimension ?? '?'}${lastSpawn.source ? ` · 来源 ${lastSpawn.source}` : ''}${lastSpawn.safe === false ? ' · ⚠不安全' : ''}`)
        }
        // 家（shelter 成功后 body 持久化）：夜里/下雨/被追时回 home.center 躲。
        if (status.home && typeof status.home === 'object') {
          const home = status.home
          const center = home.center ? fmtPosition(home.center) : (home.origin ? fmtPosition(home.origin) : '未知')
          lines.push(`家：${center}（${home.size ?? '?'}×${home.size ?? '?'}，高 ${home.height ?? '?'}，门在 ${home.doorSide ?? '?'}${home.doorPlaced ? `，已装 ${home.doorPlaced}` : '，未装门'}${home.builtAt ? `；建于 ${new Date(Number(home.builtAt)).toLocaleTimeString('zh-CN', { hour12: false })}` : ''}）——夜里/下雨/被追回 home.center 躲；mcb_shelter 可重盖`)
        } else {
          lines.push('家：还没设（mcb_shelter 盖一间；成功后 status.home 持久化）')
        }
        const phaseNow = timePhase()
        if (phaseNow === 'paused') lines.push('时间：已暂停（新消息进积压；MC 危险 alarm 会暂存、gate 打开后补投）')
        const pausedModeNow = timePausedMode()
        if (pausedModeNow?.active) {
          lines.push(`暂停模式：time 已开（世界继续/计时不冻结；goal/focus/schedules 保留；alarm 可穿透${pausedModeNow.reason ? `；原因 ${pausedModeNow.reason}` : ''}）——继续 time_resume 或 {"op":"resume"}，离开 mcb_leave`)
        }
        if (pendingAlarms.length) lines.push(`危险补投：${pendingAlarms.length} 条未进 time 的 alarm（如 offer 异常/进程重启丢失，下个 poll 补投）`)
        const alarmStats = status.safety?.alarms
        if (alarmStats) {
          lines.push(`body 告警账本：已送达 ${alarmStats.delivered ?? 0}、15s 去重 ${alarmStats.suppressed ?? 0}、补投 ${alarmStats.redelivered ?? 0}、待投 ${alarmStats.pending ?? 0}`)
        }
        const timeStatus = (() => { try { return timeApi()?.status?.() ?? null } catch { return null } })()
        if (timeStatus?.lastBlockedAlarm?.reason) {
          lines.push(`睡眠/静音期危险积压：${timeStatus.lastBlockedAlarm.count ?? 1} 条（${timeStatus.lastBlockedAlarm.reason}；醒来简报第一条会提示）`)
        }
        const ownState = supervisor.state()
        if (ownState.owns) lines.push(`进程：本会话启动 pid ${ownState.pid ?? '?'}${ownState.alive ? '（运行中）' : '（已退出）'}`)
        const suppressed = Number(status.watchdog?.suppressed ?? 0) + Number(status.watchdog?.healthDropSuppressed ?? 0)
        if (suppressed) lines.push(`body 抑制：watchdog 已合并 ${suppressed} 条重复告警（同类不再逐条叫）`)
        const stats = gate.stats()
        if (stats.suppressed) lines.push(`通知：最近抑制 ${stats.suppressed} 条重复事件`)
        return { text: lines.join('\n') }
      },
    },
    {
      name: 'mcb_look',
      summary: '看身体当前视角：位置/朝向/生命/手持/视线方块/附近实体（文本）。只读。',
      description: '附近实体给名字和距离——hostile（zombie/skeleton/creeper）在旁边先保命。视线方块判断朝向。找某类方块用 mcb_scan，看地形用 mcb_map。',
      when: ['刚进服/刚复活，先看周围', '要判断危险、朝向、附近有什么'],
      parameters: { type: 'object', properties: {} },
      async execute() {
    const out = await inspect('look')
    return { text: normalizeLookText(out.text, out.data) }
  },
    },
    {
      name: 'mcb_inventory',
      summary: '看背包和手持物品（名字+数量）。只读。',
      description: '空背包会说明。挖/合/捡后核对结果：task_done 只表示 body 判据达成（mine 是背包净增），物品可能还散在地上；task_failed/unknown 更要看背包确认到手没有。合成/熔炼/交易前先看材料够不够。',
      when: ['合成/熔炼/放置之前', '任务完成后核对产物'],
      parameters: { type: 'object', properties: {} },
      async execute() {
    const out = await inspect('inventory')
    const summary = backpackText()
    return { text: summary ? `${out.text}\n合计：${summary}（件=物品总数，格=占用背包格子）` : out.text }
  },
    },
    {
      name: 'mcb_scan',
      summary: '扫描附近某类方块的位置和距离（按距离升序）。只读。参数：name 必填，radius/count 可选。',
      description: 'name 用方块 id（snake_case）：oak_log、dirt、stone、iron_ore、coal_ore、crafting_table、furnace、chest。body 硬限制：radius 默认 16/最大 48；count 默认 8/最大 64。按距离升序只列 count 个，到上限附"可能还有更多"；"附近没有 X"表示范围内真没有——先调大 radius 或换块名。',
      when: ['下 mine 任务之前确认目标存在', '找工作台/熔炉/箱子/矿', '脱困时找方向'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: {
          name: { type: 'string', description: '方块 id，如 oak_log、stone、iron_ore。' },
          radius: { type: 'number', description: '搜索半径（格），默认 16，最大 48。' },
          count: { type: 'number', description: '最多列几个（按距离最近的），默认 8，最大 64。' },
        },
      },
      async execute({ name, radius, count } = {}) {
        const body = await inspect('scan', { name, radius, count })
        const text = String(body.text ?? '')
        const lines = text.split('\n').filter((line) => line.trim())
        const rowLines = lines.filter((line) => line.includes('@'))
        const others = lines.filter((line) => !line.includes('@'))
        if (!rowLines.length) return { text }
        // count 要真的生效：body 可能给多了（或被它的上限截断），这里按 count 只列最近的几行并说清楚。
        const wanted = Math.max(1, Math.min(64, Number(count) || 8))
        const kept = rowLines.slice(0, wanted)
        const note = rowLines.length >= 64
          ? '（已到 body 上限 64 个，可能还有更多：缩小 radius 或换更具体的方块名）'
          : rowLines.length >= wanted
            ? `（只列最近的 ${kept.length} 个（count=${wanted}），可能还有更多：调大 count（≤64）或缩小 radius）`
            : ''
        return { text: [...others, ...kept].join('\n') + (note ? `\n${note}` : '') }
      },
    },
    {
      name: 'mcb_map',
      summary: '看脚下方块层的字符小地图（#实心 .空 ~水 ≈岩浆 ?未加载）。只读。参数：radius 可选。',
      description: '判断地形：前面是墙/悬崖/水/岩浆。**只显示脚下一层（单层 y）**，不是立视图——挖出的坑/垒高的台阶要另看。radius 默认 4/最大 8，网格 (2r+1)²；←↑→↓ 是朝向。卡住或 goto 失败先看它；找远处方块用 mcb_scan。',
      when: ['goto/寻路失败', '判断悬崖、水域、洞窟'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { radius: { type: 'number', description: '地图半径（格），默认 4，最大 8。' } },
      },
      async execute({ radius } = {}) {
        const body = await inspect('map', { radius })
        const y = lastStatus?.adapter?.position?.y
        const layer = Number.isFinite(Number(y)) ? `（y≈${Math.round(Number(y)) - 1} 这一层）` : ''
        return { text: `${body.text}\n（只显示脚下一层${layer}：挖出来的坑/垒高的台阶要到那一层的地图上才看得到，不是整个工地的立视图）` }
      },
    },
    {
      name: 'mcb_snapshot',
      summary: '结构化场景快照：位置/血/背包/脚下方块图/实体/任务/安全（毫秒级，日常先看它）。',
      description: 'GET /v1/eyes/snapshot；参数 radius（3–16，默认 8），控制脚下方块图/附近统计范围。返回可读摘要 + 紧凑 JSON（含 captureMs）。毫秒级、零依赖，暂停/离线也能出基础快照；**日常看场景先用它，不要一上来截图**（截图贵且慢）。',
      when: ['要看清楚周围地形/实体/背包再决定下一步', '写 checkpoint、任务前后取证', '觉得自己"看不见"或位置可疑'],
      avoid: ['只是要位置/血/任务：mcb_status 更便宜', '想给用户看画面：mcb_eyes 截图（仅里程碑/告警时）'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { radius: { type: 'number', description: '快照半径（格），3–16，默认 8。' } },
      },
      async execute({ radius } = {}) {
        const query = radius == null ? '' : `?radius=${encodeURIComponent(String(radius))}`
        const body = await call(`/v1/eyes/snapshot${query}`, { timeoutMs: 6000 })
        sessionTouchedMc = true
        return { text: renderSnapshotText(body) }
      },
    },
    {
      name: 'mcb_eyes',
      summary: '按需截图（Edge headless，成本高）：返回 PNG 图片附件 + 落盘路径；可用 mode:"snapshot" 复用结构化快照。',
      description: 'POST /v1/eyes/screenshot；参数 mode（screenshot 默认/snapshot）、kind、frames(1–8)、width/height、waitMs(3–10s)。成本约 7–8s/张、Edge 峰值 ~1.3GB（CPU 软渲染，不占 GPU 锁）；quota：同时 1 个、间隔 ≥15s。仅里程碑/告警取证/用户明确要看画面时用，日常用 mcb_snapshot。返回 PNG 附件 + JSON meta；429 太频繁、501 未配置 viewer/Edge（改用 snapshot）、500 可重试一次。负 Y 世界渲染层整体 +64：截图视觉 y 比真实高 64（业务坐标/verify 不受影响）；kind:"shelter" 自动对准家门口。**截图对结构仅作参考，验收仍以 body verify 为准**。',
      when: ['里程碑/告警要留画面证据', '用户明确要求"看一眼/截个图"', '画面相关判断（建筑外观、地形大局）'],
      avoid: ['日常看场景/找方块：mcb_snapshot 更快更便宜', '需要精确坐标/数量：用结构化快照，别靠看图'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', description: 'screenshot（默认）或 snapshot（等同 mcb_snapshot）。' },
          kind: { type: 'string', description: '截图用途标签：milestone/alert/manual…（写进文件名/meta）。' },
          frames: { type: 'number', description: '帧数 1–8，默认 1；>1 返回 -f001.png…（给 album/video 用，默认不开）。' },
          width: { type: 'number', description: '视口宽 640–1600，默认 1280。' },
          height: { type: 'number', description: '视口高 360–900，默认 720。' },
          waitMs: { type: 'number', description: '渲染等待 3000–10000ms，默认 7000；太短会截到没加载完的画面。' },
        },
      },
      async execute({ mode = 'screenshot', kind = null, frames = null, width = null, height = null, waitMs = null } = {}) {
        if (mode === 'snapshot') {
          const body = await call('/v1/eyes/snapshot', { timeoutMs: 6000 })
          sessionTouchedMc = true
          return { text: renderSnapshotText(body) }
        }
        const payload = {}
        if (kind != null) payload.kind = String(kind)
        if (frames != null) payload.frames = Number(frames)
        if (width != null) payload.width = Number(width)
        if (height != null) payload.height = Number(height)
        if (waitMs != null) payload.waitMs = Number(waitMs)
        const timeoutMs = Math.max(30_000, Number(payload.waitMs ?? 7000) + 45_000)
        let body
        try {
          body = await call('/v1/eyes/screenshot', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), timeoutMs,
          })
        } catch (error) {
          const message = String(error?.message ?? error)
          const hint = /501|未配置|viewer|Edge/i.test(message) ? '；body 没配置截图能力（需要 viewer+Edge）——改用 mcb_snapshot 看场景'
            : /429|限频|进行中/.test(message) ? '；截图较贵：等 15s 后再试，或改用 mcb_snapshot'
              : '；本次截图失败，可重试一次；还不行就用 mcb_snapshot'
          throw new Error(`${message}${hint}`)
        }
        const files = Array.isArray(body?.files) ? body.files : []
        const images = files[0]?.file ? [files[0].file] : []
        const meta = body?.meta ?? {}
        const summary = [
          `截图完成（${body?.captureMs ?? meta.captureMs ?? '?'}ms；视口 ${meta.viewport?.width ?? '?'}×${meta.viewport?.height ?? '?'}；${files.length} 张）`,
          files.length ? `文件：${files.map((row) => `${row.file}（${Math.round((Number(row.bytes) || 0) / 1024)}KB）`).join('；')}` : '没有返回文件',
          `位置：${meta.position ? fmtPosition(meta.position) : (meta.viewer?.center ? fmtPosition(meta.viewer.center) : '未知')}${meta.task ? `；任务：${meta.task.kind ?? ''} ${meta.task.state ?? ''}`.trimEnd() : ''}${meta.safety?.paused ? '；身体暂停中' : ''}`,
          images.length ? '（首张图已作为图片附件给你看；其余帧在落盘路径，可给 album/video 用）' : '（旧宿主没有图片附件：按上面的路径手动查看）',
        ]
        return images.length ? { text: summary.join('\n'), images } : { text: summary.join('\n') }
      },
    },
    {
      name: 'mcb_do',
      summary: '执行 MC 动作：单步动作、长任务、任务台账、事件、发言都走这一个工具。',
      description: `想打架/追怪→mcb_combat；补刀→mcb_attack；采集/建造→本工具 task 宏（collect/tunnel/build/shelter/farm…）。
steps 按顺序执行，任一 op 失败即停（失败也带回已完成步骤）。
宏/长任务：{"op":"task","kind":"<kind>","params":{...}} 立即返回 taskId；progress 限频（5–10%/10s）；cancel taskId 断、resume [taskId] 续；别 wait 轮询；长动作一律用 task，别并发单步 op（409）。
宏（别逐方块刷）：collect/tunnel/bridge/build/shelter/sort/deposit/farm（参数见 mcb_help macro；build 用 blueprint）。原语 kind：mine|goto|patrol|explore|follow|routine|chat。
单步：dig|place|use|equip|toss|pickup|attack|eat|face|sleep|wait|craft|furnace|chest|trade|move|goto|patrol|explore|follow|mine（最长~120s；wait 单次≤30s，长任务别轮询；pickup 捡掉落 {radius,max} → picked/items/left；sleep 夜里+有床）。坐标 {x,y,z} 或 [x,y,z]；attack/use 先走到 3-4 格内；attack 看命中/伤害/血量，没带=无法确认。
失败码：no-target|no-path|dig-failed|needs-tool|inventory-full|needs-material|blocked|unsafe|partial（按码处理）；示例见 mcb_help。`,
      when: ['要动身体：原语动作或下宏任务', '查台账/事件、取消、解除暂停、说话'],
      avoid: ['只想知道状态用 mcb_status/mcb_look；参数不确定先 mcb_help play'],
      safety: ['同一件事别连发多个 task：先 tasks 看有没有在跑的'],
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
                kind: { type: 'string', description: 'task 的任务类型：原语 mine/goto/patrol/explore/follow/routine/chat；宏 collect/tunnel/bridge/build/sort/shelter/farm（重复劳动用宏）。' },
                params: { type: 'object', additionalProperties: true, description: '动作参数：task 的 mine 用 {block,count,radius}（block 也可以写成 name 或 kind，body 三选一都认）；goto 用 {x,y,z,range}；routine 用 {durationMs}；dig/place/use/equip/toss/craft 等用 {item/name/pos/target}。' },
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
      async execute({ steps, safety } = {}) {
        // 睡眠期只允许"收尾"：查台账/事件、取消任务、说一句晚安；新任务/新动作醒来再做。
        // （time 的睡眠语义：收到该睡了 → 收尾 → 停；管理面也可能在睡眠期把身体收起来。）
        if (timePhase() === 'sleeping') {
          const list = Array.isArray(steps) ? steps : []
          const SAFE = new Set(['tasks', 'events', 'cancel', 'say'])
          const blocked = list.find((step) => !SAFE.has(String(step?.op ?? '').trim()))
          if (blocked) {
            record({ kind: 'sleep-guard', at: Date.now(), op: String(blocked?.op ?? '') })
            throw new Error(`现在在睡觉（time 的睡眠安排生效中）：只能收尾——mcb_leave / mcb_status / {"op":"tasks"} / {"op":"events"} / {"op":"cancel"} / {"op":"say"}；新的任务或动作醒来再做。`)
          }
        }
        return runDo(steps, safety)
      },
    },
    {
      name: 'mcb_help',
      summary: '读 MC 的深层操作文档（按需，不常驻）。不带参数列出全部；参数 skill 指定一篇。',
      description: '文档很短：流程/参数示例/失败怎么办，不进每轮提示词。play=开一局与任务/事件/失败全流程；combat=打/跑/守/自动躲避/低血恢复；shelter=盖房验收/回家躲；build=蓝图建造；eyes=快照/截图与成本；macro=8 个宏总览；collect/tunnel=宏细节；escape=卡住；flee=低血逃生；craft/furnace/chest/trade=各系统；endgame=长期主线。名字可模糊匹配（trad→trade）。',
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
