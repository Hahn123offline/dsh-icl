#!/usr/bin/env node
// QQ shadow preflight：shadow 时间窗开始前的一条命令取证。
//
//   node packages/plugins/qq/tools/preflight.mjs                # 人类可读结论
//   node packages/plugins/qq/tools/preflight.mjs --json         # 机器可读
//   node packages/plugins/qq/tools/preflight.mjs --preflight    # 同默认（配合 lab-shadow 的写法）
//
// 只读：不连 QQ、不启动/停止任何进程、不写 SnowLuma 文件；只枚举进程/端口/配置/日志。
// 输出：`.state/qq-shadow/preflight/preflight-latest.{json,md}`（每次另存带时间戳的一份）。
// 退出码：0 = CLEAR/WARN（可以继续，按提示），1 = BLOCK（先处理），2 = 本机环境跑不了（缺 powershell 等）。
//
// 判定口径与 docs/QQ.md §2.3 / §10 一致：
//   BLOCK 级别：旧消费者在跑（focus-core app / dsh-qq 桥 / 接口平台）、SnowLuma 或 QQ 已经在跑、
//               3001 上已有 Established 连接、desktop profile 里还有启用的 snowluma 行、已有 shadow 在跑。
//   WARN 级别：启动文件夹里还有 dsh-icl.lnk（下次登录会拉起旧消费者）、发现不了 SnowLuma 端点、
//              日志里最近出现 send_*（历史信息，不代表现在）。
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { discoverOneBotEndpoint, sanitizeUrl } from '../src/connector.mjs'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..')
const DEFAULT_HOME = 'C:/Users/ai_admin/Downloads/SnowLuma-v2.1.1-win-x64-lite'
const PORTS = [3000, 3001, 3120, 3100, 3099, 5099]

/* ── 采集（全部只读；每一步失败降级为 unknown，不抛） ── */

function defaultExec(file, args, options = {}) {
  const out = spawnSync(file, args, { encoding: 'utf8', timeout: 20_000, windowsHide: true, ...options })
  if (out.error) throw out.error
  if (out.status !== 0) throw new Error(`${file} exit ${out.status}: ${String(out.stderr ?? '').slice(0, 200)}`)
  return String(out.stdout ?? '')
}

function psJson(exec, script) {
  const text = exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
  const trimmed = text.trim()
  if (!trimmed) return []
  const parsed = JSON.parse(trimmed)
  return Array.isArray(parsed) ? parsed : [parsed]
}
export function collectProcesses(exec = defaultExec) {
  try {
    const rows = psJson(exec, 'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress')
    return { ok: true, rows: rows.map((row) => ({ pid: Number(row.ProcessId), name: String(row.Name ?? ''), cmd: String(row.CommandLine ?? '') })) }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), rows: [] }
  }
}

export function collectScheduledTasks(exec = defaultExec) {
  try {
    const rows = psJson(exec, "Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -match 'snow|qq|icl|control' } | Select-Object TaskName,State | ConvertTo-Json -Compress")
    return { ok: true, rows: rows.map((row) => ({ name: String(row.TaskName ?? ''), state: String(row.State ?? '') })) }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), rows: [] }
  }
}

export function collectEstablishedTo3001(exec = defaultExec) {
  try {
    const script = "$r = @(Get-NetTCPConnection -RemotePort 3001 -State Established -ErrorAction SilentlyContinue); if ($r.Count -eq 0) { '[]' } else { $r | Select-Object OwningProcess,RemoteAddress,RemotePort | ConvertTo-Json -Compress }"
    const rows = psJson(exec, script)
    return { ok: true, rows: rows.map((row) => ({ pid: Number(row.OwningProcess), remote: `${row.RemoteAddress}:${row.RemotePort}` })) }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), rows: [] }
  }
}

export function probePort(port, { timeoutMs = 400 } = {}) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    let settled = false
    const done = (listening) => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch { /* 已关 */ }
      resolve(listening)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(timeoutMs, () => done(false))
  })
}

export async function collectPorts(ports = PORTS, probe = probePort) {
  const rows = []
  for (const port of ports) rows.push({ port, listening: await probe(port) })
  return rows
}

/** desktop profile 里是否还有**未注释**的 snowluma 行（2026-10-28 应已移除）。 */
export function desktopPatchHasSnowluma(home = os.homedir()) {
  const file = path.join(home, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')
  try {
    const text = fs.readFileSync(file, 'utf8')
    const lines = text.split(/\r?\n/).map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .filter((line) => /snowluma/i.test(line))
    return { ok: true, file, lines, enabled: lines.length > 0 }
  } catch (error) {
    return { ok: false, file, error: String(error?.message ?? error), lines: [], enabled: false }
  }
}

export function startupShortcut(home = os.homedir()) {
  const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
  const file = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'dsh-icl.lnk')
  return { file, exists: fs.existsSync(file) }
}

export function snowlumaInfo(homeDir = DEFAULT_HOME) {
  const endpoint = discoverOneBotEndpoint(homeDir)
  let lastLog = null
  let recentSends = 0
  try {
    const dir = path.join(String(homeDir), 'logs')
    const logs = fs.readdirSync(dir).filter((name) => /^snowluma-.*\.log$/i.test(name))
      .map((name) => ({ name, file: path.join(dir, name), mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    if (logs.length) {
      lastLog = { name: logs[0].name, mtime: logs[0].mtime }
      const tail = fs.readFileSync(logs[0].file, 'utf8').split(/\r?\n/).slice(-200).join('\n')
      recentSends = (tail.match(/send_(?:private|group)_msg/g) ?? []).length
    }
  } catch { /* 没有日志目录：只影响信息，不影响判定 */ }
  return { homeDir, endpoint, lastLog, recentSends }
}

export function findRunningShadows(root = REPO_ROOT, now = Date.now(), alive = null) {
  const out = []
  const dir = path.join(root, '.state', 'lab')
  const isAlive = typeof alive === 'function' ? alive : (pid) => {
    if (!pid) return false
    try { process.kill(pid, 0); return true } catch { return false }
  }
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const runDir = path.join(dir, entry.name)
    const file = path.join(runDir, 'qq-shadow', 'status.json')
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      const at = Number(data?.at) || 0
      if (!data?.enabled || !data?.connection?.connected) continue
      // 进程还活着才算"正在跑"；被 kill 的 lab 会留下 connected:true 的状态文件（没有 dispose）
      let meta = null
      try { meta = JSON.parse(fs.readFileSync(path.join(runDir, 'lab.json'), 'utf8')) } catch { meta = null }
      // 已正常/失败结束的 run 直接跳过（pid 可能被系统复用，不能只看 isAlive）
      if (meta?.endedAt || ['done', 'down', 'failed', 'stopped'].includes(String(meta?.status ?? ''))) continue
      const pid = meta?.pids?.dsh ?? null
      const running = pid != null ? isAlive(pid) : (now - at < 2 * 60_000)
      if (!running) continue
      out.push({ runId: entry.name, pid, at, url: data.connection.url ?? null })
    } catch { /* 没有影子状态文件 */ }
  }
  return out
}

/* ── 判定（纯函数：便于单测） ───────────────────────── */

const CONSUMER_PATTERNS = Object.freeze([
  { id: 'focus-core-old-app', re: /apps[\\/]+dsh-icl[\\/]+src[\\/]+main\.js/i, what: 'focus-core 旧应用', willConnect: true, willSend: true, block: true },
  { id: 'dsh-qq-bridge', re: /dsh-qq[\\/]+(?:src[\\/]+bridge|control-center|launcher)|control-center-hidden/i, what: 'dsh-qq 桥接/控制中心', willConnect: true, willSend: true, block: true },
  { id: 'interface-platform', re: /interface-platform/i, what: 'dsh-qq 接口平台（3120）', willConnect: true, willSend: true, block: true },
  { id: 'napcat', re: /\bNapCat/i, what: 'NapCat 后端', willConnect: true, willSend: true, block: true },
  // SnowLuma 后端：shadow 期不该在跑（会叫醒旧消费者）；phase 1 期是预期的。
  { id: 'snowluma-backend', re: /snowluma/i, what: 'SnowLuma 后端', willConnect: false, willSend: false, block: false },
  // QQ.exe 是用户自己的客户端 / SnowLuma 的底层客户端，不是 OneBot 消费者：shadow 期只提示，phase 1 期正常。
  { id: 'qq-client', re: /\bQQ\.exe\b/i, what: 'QQ 客户端（用户自己的）', willConnect: false, willSend: false, block: false },
  { id: 'running-shadow', re: /lab-shadow\.mjs\s+--real/i, what: '已有的真实 shadow 进程', willConnect: true, willSend: false, block: true },
])

export function classifyPreflight(data) {
  const checks = []
  const add = (id, level, title, detail, fix = null) => checks.push({ id, level, title, detail, fix })
  const mode = data.mode === 'phase1' ? 'phase1' : 'shadow'

  // 1) 进程消费者
  const processes = data.processes ?? { ok: false, rows: [] }
  if (!processes.ok) {
    add('processes', 'unknown', '进程枚举', `拿不到进程列表：${processes.error ?? '未知'}`, '用管理员 PowerShell 重跑；或人工核对 docs/QQ.md §2.3')
  } else {
    const blocking = []
    const snowBackend = []
    const qqClients = []
    for (const row of processes.rows) {
      if (row.pid === process.pid) continue
      const haystack = `${row.name} ${row.cmd}`
      if (/preflight\.mjs/i.test(haystack)) continue // 本工具自己的命令行（可能带 SnowLuma 路径参数）
      for (const pattern of CONSUMER_PATTERNS) {
        if (!pattern.re.test(haystack)) continue
        const item = { ...pattern, pid: row.pid, cmd: row.cmd.slice(0, 160) }
        if (pattern.id === 'qq-client') qqClients.push(item)
        else if (pattern.id === 'snowluma-backend') { if (mode === 'phase1') snowBackend.push(item); else blocking.push(item) }
        else blocking.push(item)
      }
    }
    if (blocking.length) {
      add('processes', 'block', '有会抢 QQ 连接的进程在跑', blocking.map((f) => `pid ${f.pid} ${f.what}（会连=${f.willConnect}，会发=${f.willSend}）`).join('；'), mode === 'phase1' ? 'phase 1 窗口前停掉这些旧消费者（不要静默 kill）' : '时间窗前由用户确认停掉（不要静默 kill）；见 §10 第 2 步')
    } else if (mode === 'phase1' && snowBackend.length) {
      add('processes', 'ok', 'SnowLuma 后端在跑（phase 1 预期）', snowBackend.map((f) => `pid ${f.pid}`).join('、'), '由用户手动启动；我们不启停它')
    } else {
      add('processes', 'ok', '没有会抢 QQ 连接的进程', '已核对 focus-core 旧应用 / dsh-qq 桥 / 接口平台 / NapCat / 已有 shadow')
    }
    if (qqClients.length) {
      add('qq-client', 'ok', `检测到 QQ 客户端（${qqClients.map((f) => `pid ${f.pid}`).join('、')}）`, mode === 'phase1' ? 'phase 1 需要用户用 QQ 发消息，正常' : '它不提供 OneBot 接口，不影响影子；只是说明用户 QQ 开着')
    }
  }

  // 2) QQ 端口
  const ports = data.ports ?? []
  const listening = ports.filter((row) => row.listening)
  const listeningPorts = new Set(listening.map((row) => Number(row.port)))
  if (mode === 'phase1') {
    const requiredUp = [3000, 3001]
    const missing = requiredUp.filter((port) => !listeningPorts.has(port))
    const unexpected = listening.filter((row) => ![3000, 3001, 5099].includes(Number(row.port)))
    if (missing.length) add('ports', 'block', 'SnowLuma 没在监听', `缺 ${missing.join('、')}`, '请用户先手动启动 SnowLuma（我们不代启动）')
    else if (unexpected.length) add('ports', 'block', '有额外的 QQ 相关端口在监听', unexpected.map((row) => row.port).join('、'), '确认没有旧桥接/接口平台在跑')
    else add('ports', 'ok', 'SnowLuma 已就绪（3000/3001 在听）', listening.map((row) => row.port).join('、') + (listeningPorts.has(5099) ? '' : '（5099 WebUI 未开，可忽略）'))
  } else if (listening.length) {
    add('ports', 'block', 'QQ 相关端口已在监听', listening.map((row) => row.port).join('、'), '说明 SnowLuma/旧桥接已经起来；先确认是谁在跑（shadow 前应全空）')
  } else {
    add('ports', 'ok', 'QQ 相关端口都空闲', ports.map((row) => row.port).join('/'))
  }

  // 3) 3001 上已有连接
  const established = data.established ?? { ok: false, rows: [] }
  if (!established.ok) add('established', 'unknown', '3001 连接枚举', `拿不到：${established.error ?? '未知'}`)
  else if (established.rows.length) add('established', 'block', '3001 上已有 Established 连接', established.rows.map((row) => `pid ${row.pid} → ${row.remote}`).join('；'), '有人已经在听；确认是不是旧消费者')
  else add('established', 'ok', '3001 上没有 Established 连接', '干净')

  // 4) desktop profile
  const desktop = data.desktop ?? { ok: false, enabled: false, lines: [] }
  if (!desktop.ok) add('desktop', 'unknown', 'desktop profile 检查', `读不到：${desktop.error ?? '未知'}`)
  else if (desktop.enabled) add('desktop', 'block', 'desktop profile 里还有启用的 snowluma 行', desktop.lines.slice(0, 3).join(' / '), '不要改 desktop profile；先查是不是 10-28 那次移除没生效')
  else add('desktop', 'ok', 'desktop profile 没有启用的 snowluma 行', '与 2026-10-28 的移除一致')

  // 5) 已有 shadow
  const shadows = data.shadows ?? []
  if (shadows.length) add('shadows', 'block', '已有真实 shadow 在跑', shadows.map((row) => `${row.runId}（${row.url ?? '?'}）`).join('；'), '先停旧的（tools/lab.mjs down --run <id>）')
  else add('shadows', 'ok', '没有正在运行的真实 shadow', '')

  // 6) 启动文件夹快捷方式（warn）
  if (data.startup?.exists) add('startup', 'warn', '启动文件夹里有 dsh-icl.lnk', '下次登录会自动拉起 focus-core 旧应用', '时间窗内别注销/重启；长期由用户决定是否移除')
  else add('startup', 'ok', '启动文件夹里没有 dsh-icl.lnk', '')

  // 7) 计划任务（warn/ok）
  const tasks = data.tasks ?? { ok: false, rows: [] }
  if (!tasks.ok) add('scheduled-tasks', 'unknown', '计划任务检查', `拿不到：${tasks.error ?? '未知'}`)
  else if (tasks.rows.length) add('scheduled-tasks', 'warn', '有名字像 QQ/ICL 的计划任务', tasks.rows.map((row) => `${row.name}(${row.state})`).join('、'), '确认它不会拉起旧消费者')
  else add('scheduled-tasks', 'ok', '没有相关计划任务', '')

  // 8) SnowLuma 端点发现（只读）
  const snow = data.snowluma ?? {}
  if (snow.endpoint?.ok) add('endpoint', 'ok', 'SnowLuma 端点可只读发现', `uin=${snow.endpoint.uin} ${sanitizeUrl(snow.endpoint.wsUrl)}（token ${snow.endpoint.token ? '存在' : '缺失'}）`)
  else add('endpoint', 'warn', '发现不了 SnowLuma 端点', snow.endpoint?.error ?? '未知', '确认 SnowLuma 安装目录/配置文件路径')

  // 9) 历史发送痕迹（信息）
  if (snow.lastLog) {
    const when = new Date(snow.lastLog.mtime).toISOString()
    if (snow.recentSends > 0) add('send-history', 'warn', '最近日志尾部出现 send_* 痕迹', `${snow.lastLog.name} 尾部 ${snow.recentSends} 次（历史，不代表现在）`, '时间窗前后对比该数字，用来判断是否有人在我们之外发消息')
    else add('send-history', 'ok', '最近日志尾部没有 send_* 痕迹', `${snow.lastLog.name} @ ${when}`)
  } else {
    add('send-history', 'unknown', '没有 SnowLuma 日志', '无法用日志做"是否有人发消息"的对照')
  }

  const blocks = checks.filter((c) => c.level === 'block')
  const warns = checks.filter((c) => c.level === 'warn')
  const unknowns = checks.filter((c) => c.level === 'unknown')
  // unknown 不算 block（可能只是拿不到进程列表），但也不能报 CLEAR —— 降级成 WARN 让人去看。
  const verdict = blocks.length ? 'BLOCK' : (warns.length || unknowns.length) ? 'WARN' : 'CLEAR'
  return { verdict, blocks: blocks.length, warns: warns.length, unknowns: unknowns.length, checks }
}

/* ── 组装报告 ─────────────────────────────────────── */

export async function runPreflight({ home = DEFAULT_HOME, homeDir = os.homedir(), root = REPO_ROOT, exec = defaultExec, probe = probePort, now = () => Date.now(), phaseOne = false } = {}) {
  const [ports] = await Promise.all([collectPorts(PORTS, probe)])
  const data = {
    at: now(),
    mode: phaseOne ? 'phase1' : 'shadow',
    home,
    processes: collectProcesses(exec),
    tasks: collectScheduledTasks(exec),
    established: collectEstablishedTo3001(exec),
    ports,
    desktop: desktopPatchHasSnowluma(homeDir),
    startup: startupShortcut(homeDir),
    snowluma: snowlumaInfo(home),
    shadows: findRunningShadows(root, now()),
  }
  return { ...classifyPreflight(data), data }
}

/** 给用户看的一页说明（申请时间窗时直接贴；由 preflight 的真实数据填写）。 */
export function renderUserBrief(report, { windowMinutes = 15 } = {}) {
  const { verdict, checks, data } = report
  const blocked = checks.filter((c) => c.level === 'block')
  const warns = checks.filter((c) => c.level === 'warn')
  const oldApps = (data.processes?.rows ?? []).filter((row) => /apps[\\/]+dsh-icl[\\/]+src[\\/]+main\.js/i.test(row.cmd))
  const lines = [
    '# 申请一次 QQ 只读影子（给用户看的一页说明）',
    '',
    `> 这是 ICL 的"只读影子"：${windowMinutes} 分钟窗口里，她**只收你的 QQ 私聊**，不发送任何 QQ 消息、不接群。`,
    `> 生成时间：${new Date(data.at).toISOString()}；\`preflight\` 结论：**${verdict}**。`,
    '',
    '## 这是什么、为什么值得做',
    '验证 ICL 能"接收到真实的你"，同时保证不打扰任何人：她能看到你发的一条私聊并进入她的上下文，但没有回复工具，群消息整类忽略。',
    '',
    '## 现在为什么不能直接开始',
  ]
  if (verdict === 'CLEAR') {
    lines.push('- preflight 全绿：没有会抢连接的进程、端口空闲、desktop 配置干净。可以按下面步骤开始。')
  } else {
    if (blocked.length) {
      lines.push('preflight 发现**会抢 QQ 连接的旧消费者**，必须先处理：')
      for (const check of blocked) lines.push(`- ⛔ ${check.title}：${check.detail}`)
    } else {
      lines.push('- 没有阻断项，但有需要确认的警告（见下）。')
    }
    if (oldApps.length) {
      lines.push('', '**其中 focus-core 旧应用（下面这些进程）具体会做什么：**')
      for (const app of oldApps) lines.push(`- pid ${app.pid}：\`${String(app.cmd).slice(0, 120)}\``)
      lines.push(
        '- 它一旦发现 SnowLuma 在跑，会**自动连上**，用**旧人格**处理消息，并且它的代码里存在主动给你发私聊的路径。',
        '- 也就是说：如果不先停它，这次窗口就不是"干净影子"——你可能会收到旧人格的意外消息，我们的观测也会被污染。',
      )
    }
    if (warns.length) {
      lines.push('', '其它需要你知道的：')
      for (const check of warns) lines.push(`- ⚠️ ${check.title}：${check.detail}`)
    }
  }
  lines.push(
    '',
    '## 需要你做的三件事',
    '1. **同意一次短窗口**（建议 15 分钟）——只在窗口内运行，结束立即停。',
    '2. **同意停掉上面的旧消费者**（不是我们静默 kill：停之前会再确认一次；不批准也能跑，但那就不是干净影子，见上）。',
    '3. **由你手动启动 SnowLuma**（我们不程序化启停它），然后在窗口内**给机器人发一条私聊**（随便一句即可）。',
    '',
    '## 窗口内会发生什么（以及不会发生什么）',
    '- 她**只收不发**：客户端零出站帧（连 `get_login_info` 这类动作都不发）；没有发送工具。',
    '- 群消息**整类忽略**：连只读都不接，不解析、不记录文本（只计一个数字）。',
    '- 她会看到你那一条私聊并进入她的上下文；可能"想回"，但没有能力回——这是设计，不是故障。',
    '- 如果她正在睡觉/静音：消息会进她自己的积压，醒来后作为摘要看到（不会丢）。',
    '',
    '## 出问题怎么办 / 怎么回滚（三步）',
    '1. 停掉只读影子实例（lab 自动停或 `lab.mjs down`）；2. 你手动关闭 SnowLuma；3. 需要的话重新启动旧消费者（启动文件夹里有快捷方式）。',
    '全程证据留在 `.state/lab/<runId>/`（报告、原始事件、私聊记录），可复盘。',
    '',
    '## 我们不会做的事',
    '- 不启动/停止 SnowLuma 进程，不写它的任何文件；不连接 3000/3120；不发任何 QQ 消息；不接群；不改 desktop profile。',
    '',
    '> 说明由 `node packages/plugins/qq/tools/preflight.mjs --brief` 生成；同一份结论的完整证据见 `preflight-latest.md`。',
    '',
  )
  return lines.join('\n')
}

function renderMarkdown(report) {
  const { verdict, checks, data } = report
  const icon = { ok: '✅', warn: '⚠️', block: '⛔', unknown: '❔' }
  return [
    '# QQ shadow preflight',
    '',
    `- 时间：${new Date(data.at).toISOString()}`,
    `- 模式：${data.mode === 'phase1' ? 'phase 1（SnowLuma 应在跑；只回 owner 私聊）' : 'shadow（SnowLuma 不应在跑）'}`,
    `- SnowLuma 目录：\`${data.home}\``,
    `- **结论：${verdict}**（block ${report.blocks} / warn ${report.warns}${report.unknowns ? ` / unknown ${report.unknowns}` : ''}）`,
    '',
    '| 检查 | 结果 | 说明 | 处理 |',
    '|---|---|---|---|',
    ...checks.map((c) => `| ${c.title} | ${icon[c.level] ?? '?'} ${c.level} | ${String(c.detail).replace(/\|/g, '\\|')} | ${String(c.fix ?? '').replace(/\|/g, '\\|')} |`),
    '',
    verdict === 'BLOCK' ? '> ⛔ 先把 block 项处理掉，再向用户申请时间窗（不要自行 kill/启动 QQ 相关进程）。' : '',
    verdict === 'WARN' ? '> ⚠️ 可以继续，但按"处理"列确认；真实 shadow 期间仍按 docs/QQ.md §10 的失败即停阈值盯。' : '',
    verdict === 'CLEAR' ? '> ✅ 干净；可以按 docs/QQ.md §10 申请时间窗并启动只读影子。' : '',
    '',
    '> 本命令只读：没有连接 QQ、没有启停任何进程、没有写 SnowLuma 文件。',
    '',
  ].join('\n')
}

export async function runPreflightMain(args = [], deps = {}) {
  const json = args.includes('--json')
  const brief = args.includes('--brief')
  const phaseOne = args.includes('--snowluma-up') || args.includes('--phase1')
  const home = (() => {
    const i = args.indexOf('--home')
    return i >= 0 && args[i + 1] ? args[i + 1] : (process.env.ICL_SNOWLUMA_HOME ?? DEFAULT_HOME)
  })()
  const root = deps.root ?? REPO_ROOT
  const report = await runPreflight({ home, root, phaseOne, ...deps })
  const outDir = path.join(root, '.state', 'qq-shadow', 'preflight')
  fs.mkdirSync(outDir, { recursive: true })
  const ts = new Date(report.data.at).toISOString().replace(/[:.]/g, '-')
  const jsonFile = path.join(outDir, `preflight-${ts}.json`)
  const mdFile = path.join(outDir, `preflight-${ts}.md`)
  const latestMd = path.join(outDir, 'preflight-latest.md')
  const latestJson = path.join(outDir, 'preflight-latest.json')
  const markdown = renderMarkdown(report)
  const userBrief = renderUserBrief(report)
  fs.writeFileSync(jsonFile, JSON.stringify(report, null, 1), 'utf8')
  fs.writeFileSync(mdFile, markdown, 'utf8')
  fs.writeFileSync(latestMd, markdown, 'utf8')
  fs.writeFileSync(latestJson, JSON.stringify(report, null, 1), 'utf8')
  fs.writeFileSync(path.join(outDir, 'user-brief-latest.md'), userBrief, 'utf8')

  if (json) {
    console.log(JSON.stringify({ verdict: report.verdict, blocks: report.blocks, warns: report.warns, checks: report.checks, report: { json: jsonFile, md: mdFile, brief: path.join(outDir, 'user-brief-latest.md') } }, null, 2))
  } else if (brief) {
    console.log(userBrief)
    console.log(`报告：${mdFile}`)
  } else {
    console.log(markdown)
    console.log(`报告：${mdFile}`)
    console.log(`机器可读：${jsonFile}`)
    console.log(`给用户的一页说明：--brief（或 .state/qq-shadow/preflight/user-brief-latest.md）`)
  }
  const unknown = report.checks.some((c) => c.level === 'unknown')
  return report.verdict === 'BLOCK' ? 1 : unknown ? 2 : 0
}

const isCli = Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (isCli) {
  runPreflightMain(process.argv.slice(2)).then((code) => { process.exitCode = code }).catch((error) => {
    console.error(`[qq-preflight] 失败：${String(error?.stack ?? error)}`)
    process.exitCode = 2
  })
}
