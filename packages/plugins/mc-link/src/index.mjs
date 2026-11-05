// MC 统一交互适配器：7 个常驻工具 + 技能文档按需读。
// 不 import mineflayer；所有动作走 mc-body/v1。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import dgram from 'node:dgram'
import { spawn } from 'node:child_process'

export const name = 'mc-link'

const DEFAULT_BASE = 'http://127.0.0.1:54836'
const MAX_TEXT = 200
const OPS = ['look', 'inventory', 'scan', 'map', 'move', 'goto', 'patrol', 'explore', 'follow', 'mine', 'use', 'dig', 'place', 'equip', 'toss', 'attack', 'wait', 'eat', 'face', 'craft', 'furnace', 'chest', 'trade', 'task', 'cancel', 'resume', 'events', 'tasks', 'say']
const SKILLS = [
  { id: 'trade', title: '村民交易', when: (s) => Number(s?.adapter?.nearby?.villager ?? 0) > 0, summary: '附近有村民' },
  { id: 'craft', title: '合成', when: (s) => Number(s?.adapter?.inventoryCount ?? 0) > 0, summary: '背包有材料' },
  { id: 'furnace', title: '熔炼', when: (s) => Number(s?.adapter?.nearby?.furnace ?? 0) > 0, summary: '附近有熔炉' },
  { id: 'chest', title: '箱子', when: (s) => Number(s?.adapter?.nearby?.chest ?? 0) > 0, summary: '附近有箱子' },
  { id: 'escape', title: '脱困', when: (s) => ['failed', 'interrupted'].includes(s?.task?.state) || ['stuck', 'health-drop'].includes(s?.pausedReason), summary: '任务卡住/中断' },
  { id: 'flee', title: '逃跑/战斗', when: (s) => Number(s?.adapter?.health ?? 20) <= 12, summary: '血量偏低' },
  { id: 'endgame', title: '通关参考', when: () => false, summary: '长期主线' },
]
const SKILL_DIR = path.join(import.meta.dirname, '..', 'skills')

function closest(value, list) {
  const needle = String(value ?? '').toLowerCase()
  if (!needle) return null
  const exact = list.find((x) => x.toLowerCase() === needle)
  if (exact) return exact
  const contains = list.filter((x) => x.toLowerCase().includes(needle) || needle.includes(x.toLowerCase()))
  if (contains.length === 1) return contains[0]
  let best = null
  let score = Infinity
  for (const item of list) {
    const a = item.toLowerCase()
    const d = Math.abs(a.length - needle.length)
    let diff = 0
    for (let i = 0; i < Math.min(a.length, needle.length); i += 1) if (a[i] !== needle[i]) diff += 1
    const s = diff + d
    if (s < score) { score = s; best = item }
  }
  return score <= 4 ? best : null
}

export function apply(ctx) {
  const base = String(ctx.config.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '')
  const pollMs = Math.max(500, Number(ctx.config.pollMs) || 1200)
  const focus = String(ctx.config.focus ?? 'mc')
  const bodyPort = Number(ctx.config.listenPort ?? new URL(base).port ?? 54836)
  const bodyEntry = String(ctx.config.bodyEntry ?? path.join(import.meta.dirname, '..', '..', '..', 'mc-body', 'src', 'cli.mjs'))
  let lastSeq = 0
  let primed = false
  let ready = null
  let timer = null
  let lastStatus = null
  let lastEvent = null
  let lastSayAt = 0
  let bodyProcess = null
  let ownsBody = false
  let joinedServer = null
  let lastLan = []
  const logFile = ctx.config.logFile ? String(ctx.config.logFile) : null

  async function call(pathname, options = {}) {
    const timeoutMs = Number(options.timeoutMs ?? ctx.config.timeoutMs) || 3000
    const response = await fetch(`${base}${pathname}`, { ...options, signal: AbortSignal.timeout(timeoutMs) })
    const body = await response.json().catch(() => ({}))
    if (!response.ok || body?.ok === false) throw new Error(body?.error ?? `mc-body HTTP ${response.status}`)
    return body
  }

  function record(row) {
    if (!logFile) return
    try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.appendFileSync(logFile, `${JSON.stringify(row)}\n`, 'utf8') } catch { /* ignore */ }
  }

  function offer(text, extra = {}) {
    ctx.signals.offer({
      from: { plugin: 'mc', activity: extra.activity ?? 'event' },
      kind: extra.kind ?? 'event', text, focus: extra.focus ?? focus,
      tags: extra.tags ?? ['mc'], meta: extra.meta ?? null,
    })
  }

  function eventText(e) {
    const d = e.data ?? {}
    if (e.type === 'chat') return `[MC] ${d.username}：${d.message}`
    if (e.type === 'join') return `[MC] ${d.username} 进入游戏`
    if (e.type === 'leave') return `[MC] ${d.username} 离开游戏`
    if (e.type === 'safety_stop') return `[MC] 安全停止：${d.reason ?? '安全原因'}`
    if (e.type === 'spawn_unsafe') return `[MC] 出生点危险，已暂停`
    if (e.type === 'task_done') return `[MC] 任务完成：${d.task?.kind ?? ''} ${d.task?.id ?? ''}`
    if (e.type === 'task_failed') return `[MC] 任务失败：${d.task?.kind ?? ''} ${d.task?.error ?? ''}`
    if (e.type === 'task_interrupted') return `[MC] 任务中断：${d.task?.error ?? ''}`
    if (e.type === 'health_drop') return `[MC] 掉血：${d.from} → ${d.to}`
    if (e.type === 'reconnecting') return `[MC] 断线，重连中（第 ${d.attempt ?? '?'} 次）`
    if (e.type === 'reconnected') return '[MC] 已重连'
    return `[MC] ${e.type}`
  }

  async function poll() {
    if (ready) await ready
    const data = await call(`/v1/events?since=${encodeURIComponent(String(lastSeq))}`)
    if (!Array.isArray(data.events)) return
    if (!primed) { lastSeq = Number(data.seq) || 0; primed = true; return }
    for (const event of data.events) {
      if (!Number.isFinite(Number(event.seq)) || Number(event.seq) <= lastSeq) continue
      lastSeq = Number(event.seq)
      if (['health', 'task_progress', 'spawn', 'login', 'connected', 'chat_sent', 'stopped', 'safety_resume'].includes(event.type)) continue
      lastEvent = event
      record(event)
      const urgent = event.type === 'safety_stop' || event.type === 'health_drop' || event.type === 'spawn_unsafe'
      offer(eventText(event), { kind: event.type === 'chat' ? 'content' : 'event', activity: event.type, tags: urgent ? ['mc', 'safety', 'alarm'] : ['mc', event.type], meta: { seq: event.seq } })
    }
    lastStatus = await call('/v1/status').catch(() => null)
  }

  function statusLine() {
    const s = lastStatus
    if (!s?.adapter?.connected) return 'MC｜未连接'
    const p = s.adapter.position
    const pos = p ? `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}` : '?'
    const task = s.task ? `${s.task.kind} ${s.task.state}${s.task.progress ? ` ${JSON.stringify(s.task.progress).slice(0, 60)}` : ''}` : '空闲'
    return `MC｜在线 · 位置 ${pos} · 任务 ${task} · 血${Math.round(s.adapter.health ?? 0)}/20 · 饱食${Math.round(s.adapter.food ?? 0)} · 背包${s.adapter.inventoryCount ?? '?'}`
  }

  function hintLine() {
    const hints = SKILLS.filter((sk) => { try { return sk.when(lastStatus, lastEvent) } catch { return false } }).slice(0, 2)
    if (!hints.length) return ''
    return `MC 技能：${hints.map((h) => `${h.title}（${h.summary}；mcb_help ${h.id}）`).join('｜')}`
  }

  async function prime() {
    const data = await call('/v1/events?since=0')
    lastSeq = Number(data.seq) || 0
    primed = true
    lastStatus = await call('/v1/status').catch(() => null)
  }

  async function help(skill) {
    const list = SKILLS.map((s) => s.id)
    if (!skill) return { text: `可用技能：${list.join('、')}。用 {skill:"trade"} 读全文。` }
    const id = closest(skill, list)
    if (!id) return { text: `没有这个技能：${skill ?? '(空)'}。可用：${list.join('、')}` }
    try {
      const text = fs.readFileSync(path.join(SKILL_DIR, `${id}.md`), 'utf8')
      return { text }
    } catch (error) {
      return { text: `技能 ${id} 的文档读不到：${error?.message ?? error}` }
    }
  }

  async function status() {
    return call('/v1/status')
  }

  async function waitBody(timeoutMs = 25_000) {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      try {
        const s = await status()
        if (s.adapter?.connected) return s
      } catch { /* 还没起 */ }
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error('mc-body 没有在限定时间内连上服务器')
  }

  async function stopBody() {
    try { await call('/v1/safety/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }) } catch { /* ignore */ }
    if (bodyProcess && ownsBody) {
      try { bodyProcess.kill('SIGTERM') } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 700))
      try { bodyProcess.kill('SIGKILL') } catch { /* ignore */ }
    }
    bodyProcess = null
    ownsBody = false
    lastStatus = null
    joinedServer = null
  }

  async function startBody(host, port, username) {
    const current = await status().catch(() => null)
    if (current?.adapter?.connected) {
      const a = current.adapter
      if (a.host === host && Number(a.port) === Number(port)) return current
      throw new Error(`body 已连接到 ${a.host}:${a.port}，先 mcb_leave`)
    }
    if (!bodyProcess) {
      const stateDir = path.resolve(String(ctx.config.stateDir ?? 'C:/DSH/icl/.state/mc-live'))
      fs.mkdirSync(stateDir, { recursive: true })
      bodyProcess = spawn(process.execPath, [
        bodyEntry,
        '--host', String(host),
        '--port', String(port),
        '--listen', String(bodyPort),
        '--name', String(username),
        '--allow-task', '--allow-say',
        '--paused-disconnect-ms', '0',
        '--state', path.join(stateDir, 'tasks.json'),
        '--log', path.join(stateDir, 'body.jsonl'),
      ], { stdio: 'ignore', windowsHide: true })
      ownsBody = true
    }
    return waitBody()
  }

  function serverList() {
    const configured = Array.isArray(ctx.config.servers) ? ctx.config.servers : []
    let fileServers = []
    try {
      const file = String(ctx.config.serversFile ?? 'C:/DSH/icl/config/mc-servers.json')
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (Array.isArray(parsed)) fileServers = parsed
    } catch { /* 可选配置 */ }
    const all = fileServers.concat(configured, lastLan).filter((s) => s?.host)
    const seen = new Set()
    return all.filter((s) => {
      const key = `${s.host}:${Number(s.port ?? 25565)}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  function lanDiscover(timeoutMs = 1800) {
    return new Promise((resolve) => {
      const found = []
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
      let done = false
      const finish = () => {
        if (done) return
        done = true
        try { sock.close() } catch { /* ignore */ }
        resolve(found)
      }
      sock.on('message', (msg, rinfo) => {
        const text = msg.toString('utf8')
        const port = Number((text.match(/\[AD\](\d+)\[\/AD\]/) ?? [])[1]) || 25565
        const motd = (text.match(/\[MOTD\](.*?)\[\/MOTD\]/s) ?? [])[1] ?? ''
        if (!found.some((s) => s.host === rinfo.address && s.port === port)) found.push({ name: motd || rinfo.address, host: rinfo.address, port })
      })
      try {
        sock.bind(4445, () => { try { sock.addMembership('224.0.2.60') } catch { /* ignore */ } })
      } catch { finish(); return }
      setTimeout(finish, timeoutMs)
    })
  }

  async function join({ host, port = null, username = 'ICL', server } = {}) {
    const configured = serverList().find((s) => server && (s.name === server || s.id === server))
    const targetHost = String(host ?? configured?.host ?? '').trim()
    const targetPort = Number(port ?? configured?.port ?? 25565)
    if (!targetHost) throw new Error('需要 host（或先 mcb_lan/mcb_servers 找服务器）')
    await startBody(targetHost, targetPort, String(username).slice(0, 16))
    joinedServer = { host: targetHost, port: targetPort }
    lastStatus = await status().catch(() => lastStatus)
    return joinedServer
  }

  async function leave() {
    await stopBody()
  }

  ctx.prompt.section({ name: 'mc:status', order: 900, text: () => statusLine() })
  ctx.prompt.section({ name: 'mc:skills', order: 901, text: () => hintLine() })
  ctx.prompt.section({ name: 'mc:interaction', order: 903, text: () => 'MC 交互：决定做一件大事（下矿/远行/合成一批/建家/战斗）前先用 mcb_do say 说一句；任务完成或失败也说一句；普通一步不必。' })
  ctx.prompt.section({ name: 'mc:play', order: 902, text: () => 'MC：想玩时用 mcb_servers / mcb_lan 找服务器，mcb_join 只负责连接；需要持续投入时再 focus_enter，并用 time_arrange {mode:"goal", focus:"mc"} 建持续目标；不需要被持续唤醒时用 time_cancel + focus_leave，mcb_leave 只停 body。' })

  ctx.tools.register({
    name: 'mcb_servers',
    description: '列出配置里已知的 MC 服务器（name/host/port），以及最近一次 mcb_lan 发现的结果。',
    parameters: {},
    async execute() {
      const rows = serverList().map((s) => `· ${s.name ?? s.id ?? s.host}  ${s.host}:${s.port ?? 25565}`)
      return { text: rows.length ? rows.join('\n') : '没有已知服务器；可以用 mcb_lan 或直接把 host/port 给 mcb_join。' }
    },
  })

  ctx.tools.register({
    name: 'mcb_lan',
    description: '监听 Minecraft 局域网公告 UDP 4445，返回发现的服务器 host/port/MOTD。',
    parameters: {},
    async execute() {
      lastLan = await lanDiscover()
      const rows = lastLan.map((s) => `· ${s.name}  ${s.host}:${s.port}`)
      return { text: rows.length ? rows.join('\n') : '没有发现局域网服务器。' }
    },
  })

  ctx.tools.register({
    name: 'mcb_join',
    description: '连接 MC 服务器并启动 body；只连接，不自动创建 goal/focus。参数：host/port/username 或 server（来自 mcb_servers/mcb_lan）。需要持续投入时再 focus_enter + time_arrange goal。',
    parameters: { type: 'object', properties: { host: { type: 'string' }, port: { type: 'number' }, username: { type: 'string' }, server: { type: 'string' } } },
    async execute(args = {}) {
      const out = await join(args)
      return { text: `已连接 ${out.host}:${out.port}，body 已启动。` }
    },
  })

  ctx.tools.register({
    name: 'mcb_leave',
    description: '退出 MC：只停止 body，不自动取消 goal/focus；如果不需要被持续唤醒，先 time_cancel 再 focus_leave。',
    parameters: {},
    async execute() {
      await leave()
      return { text: '已退出 MC，body 已停止；goal/focus 未动（不需要持续唤醒时请 time_cancel + focus_leave）。' }
    },
  })

  ctx.tools.register({
    name: 'mcb_status',
    description: '查看 MC 身体：连接、位置、生命/饥饿、当前任务、队列、台账摘要。只读。',
    parameters: {},
    async execute() {
      const s = await call('/v1/status'); lastStatus = s
      const a = s.adapter ?? {}
      return { text: [`MC 身体：${a.connected ? '已连接' : '未连接'} ${a.host ?? ''}:${a.port ?? ''}`, `玩家：${(a.players ?? []).join('、') || '无'}`, `位置：${a.position ? `${Math.round(a.position.x)}, ${Math.round(a.position.y)}, ${Math.round(a.position.z)}` : '未知'}`, `生命/饥饿：${Math.round(a.health ?? 0)}/20，${Math.round(a.food ?? 0)}/20`, `任务：${s.task ? `${s.task.kind} ${s.task.state}` : '空闲'}；队列 ${s.queue?.length ?? 0}`].join('\n') }
    },
  })

  ctx.tools.register({
    name: 'mcb_look',
    description: '看 MC 身体当前视角：位置/朝向/生命/手持/视线方块/附近实体。文本，不截图。',
    parameters: {},
    async execute() { return inspect('look') },
  })
  ctx.tools.register({
    name: 'mcb_inventory',
    description: '看 MC 身体的背包、手持物品。只读。',
    parameters: {},
    async execute() { return inspect('inventory') },
  })
  ctx.tools.register({
    name: 'mcb_scan',
    description: '扫描附近指定方块的位置和距离（name 必填，radius/count 可选）。只读。',
    parameters: { type: 'object', properties: { name: { type: 'string' }, radius: { type: 'number' }, count: { type: 'number' } }, required: ['name'] },
    async execute({ name, radius, count } = {}) { return inspect('scan', { name, radius, count }) },
  })
  ctx.tools.register({
    name: 'mcb_map',
    description: '看脚下方块层的小地图（#实心 .空 ~水 ≈岩浆 ?未加载）。只读。',
    parameters: { type: 'object', properties: { radius: { type: 'number' } } },
    async execute({ radius } = {}) { return inspect('map', { radius }) },
  })

  async function inspect(kind, params = {}) {
    const body = await call('/v1/inspect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, params }) })
    return { text: String(body.result?.text ?? '') }
  }

  ctx.tools.register({
    name: 'mcb_do',
    description: '统一交互：按 steps 顺序执行。常用 op：look/inventory/scan/map、move/goto/patrol/explore/follow、use/dig/place/equip/toss/attack/wait/eat/face、craft/furnace/chest/trade、task/cancel/resume/events/tasks/say。返回 taskId/结果；不确定时先 mcb_help。',
    parameters: {
      type: 'object',
      properties: {
        intent: { type: 'string' },
        steps: { type: 'array', items: { type: 'object', properties: { op: { type: 'string' }, kind: { type: 'string' }, params: { type: 'object' }, text: { type: 'string' }, taskId: { type: 'string' }, since: { type: 'number' }, state: { type: 'string' }, force: { type: 'boolean' } }, required: ['op'] } },
        safety: { type: 'object' },
      },
      required: ['steps'],
    },
    async execute({ steps, safety } = {}) {
      if (!Array.isArray(steps) || !steps.length) throw new Error('steps 不能为空')
      const known = new Set(OPS)
      for (const step of steps) if (!known.has(String(step?.op ?? ''))) {
        const near = closest(step?.op, OPS)
        throw new Error(`未知 op：${step?.op}${near ? `；你是不是要 ${near}？` : `；可用：${OPS.join('、')}`}`)
      }
      try {
        const body = await call('/v1/do', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ steps, safety }), timeoutMs: Number(ctx.config.doTimeoutMs) || 120_000 })
        lastStatus = await call('/v1/status').catch(() => lastStatus)
        if (body.task) return { text: `任务 ${body.task.id}（${body.task.kind}）已接受，状态 ${body.task.state}。` }
        const parts = (body.results ?? []).map((row) => {
          if (row.result?.text) return `[${row.op}] ${row.result.text}`
          if (row.op === 'tasks') return `[tasks] ${(row.result ?? []).slice(-10).map((t) => `#${t.id} ${t.kind} ${t.state}`).join('\n') || '没有任务'}`
          if (row.op === 'events') return `[events] ${(row.result?.events ?? []).map((e) => `#${e.seq} ${e.type}`).join('\n') || '没有事件'}`
          if (row.op === 'resume') return `[resume] ${row.result?.paused ? '仍暂停' : '已恢复'}`
          return `[${row.op}] ${JSON.stringify(row.result).slice(0, 500)}`
        })
        return { text: parts.length ? parts.join('\n\n') : '没有返回结果。' }
      } catch (error) {
        const msg = String(error?.message ?? error)
        const m = msg.match(/未知 op：([^\s；]+)/)
        const near = m ? closest(m[1], OPS) : null
        throw new Error(`${msg}${near ? `；你是不是要 ${near}？` : ''}`)
      }
    },
  })

  ctx.tools.register({
    name: 'mcb_help',
    description: '读技能说明：{skill:"trade"}；不带参数列出全部技能。文档按需读，不常驻。',
    parameters: { type: 'object', properties: { skill: { type: 'string' } } },
    async execute({ skill } = {}) { return help(skill) },
  })

  timer = setInterval(() => {
    void poll().catch((error) => ctx.log({ level: 'warn', msg: 'mc-link.poll', error: String(error?.message ?? error) }))
  }, pollMs)
  if (typeof timer.unref === 'function') timer.unref()
  ctx.onDispose(() => { if (timer) clearInterval(timer) })

  ready = prime().catch(() => { /* body 未起 */ })
  const api = { base, status: () => lastStatus, poll, skills: () => SKILLS.map((s) => s.id) }
  ctx.services.provide('mc-link', api)
  ctx.log({ msg: 'mc-link.ready', base, focus, tools: 7 })
  return api
}
