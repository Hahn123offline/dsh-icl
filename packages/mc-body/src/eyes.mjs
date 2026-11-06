// MC “眼睛”的共享实现：
// - buildStructuredSnapshot：P0 结构化场景快照（纯函数，毫秒级，零依赖）
// - startViewerServer：可关闭的 prismarine-viewer 服务（express + socket.io，动态依赖 viewer 安装目录）
// - captureScreenshot：Edge headless + CDP 截图（启动、等待渲染、截图、kill 进程树）
// 契约见 docs/MC-EYES.md；产品无关，body / tools 均可复用。
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function findEdgePath(explicit = null) {
  const candidates = [
    explicit,
    process.env.MC_EYES_EDGE,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean)
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate
  return null
}

export function resolveViewerRoot(explicit = null) {
  const candidates = [
    explicit,
    process.env.MC_EYES_VIEWER_ROOT,
    path.resolve(import.meta.dirname, '..', '..', '..', '.state', 'lab', 'mc-eyes-poc', 'viewer'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    const root = path.resolve(String(candidate))
    if (fs.existsSync(path.join(root, 'node_modules', 'prismarine-viewer'))) return root
  }
  return null
}

function compactNumber(value, digits = 1) {
  return Number.isFinite(Number(value)) ? Math.round(Number(value) * 10 ** digits) / 10 ** digits : null
}

function itemCounts(items) {
  const counts = {}
  for (const item of Array.isArray(items) ? items : []) {
    const name = String(item?.name ?? '')
    if (!name) continue
    counts[name] = (counts[name] ?? 0) + (Number(item.count) || 1)
  }
  return counts
}

/**
 * P0：把 body status + 可选 adapter.snapshot + inspect 结果压成“模型能直接读”的几 KB 场景 JSON。
 * 不依赖浏览器；缺字段时降级（有 status 就能出基础快照）。
 */
export function buildStructuredSnapshot({ status = {}, adapterSnapshot = null, inspect = {}, task = null, events = [], radius = 8 } = {}) {
  const adapter = status?.adapter ?? {}
  const base = adapterSnapshot ?? {}
  const pos = base.position ?? adapter.position ?? status?.position ?? null
  const items = base.inventory?.items ?? (Array.isArray(inspect?.inventory?.data?.items) ? inspect.inventory.data.items : [])
  const hotbar = base.inventory?.hotbar ?? inspect?.inventory?.data?.hotbar ?? null
  const held = base.held ?? inspect?.inventory?.data?.held ?? adapter.equipment?.hand ?? null
  const entities = Array.isArray(base.entities) ? base.entities.slice(0, 24) : []
  const counts = itemCounts(items)
  return {
    version: 1,
    kind: 'structured',
    ts: new Date().toISOString(),
    position: pos ? { x: compactNumber(pos.x), y: compactNumber(pos.y), z: compactNumber(pos.z) } : null,
    dimension: base.dimension ?? adapter.dimension ?? null,
    health: compactNumber(base.health ?? adapter.health),
    food: compactNumber(base.food ?? adapter.food),
    oxygen: compactNumber(base.oxygen ?? adapter.oxygen),
    submerged: Boolean(base.submerged ?? adapter.submerged),
    time: base.time ?? adapter.time ?? null,
    sleeping: Boolean(base.sleeping ?? adapter.sleeping),
    held: held ? { name: held.name ?? held, count: held.count ?? null, toolFor: held.toolFor ?? null, tier: held.tier ?? null, durability: held.durability ?? null } : null,
    hotbar: Array.isArray(hotbar) ? hotbar.map((slot) => slot && ({ slot: slot.slot, name: slot.name ?? null, count: slot.count ?? null, selected: Boolean(slot.selected), toolFor: slot.toolFor ?? null })) : null,
    inventory: {
      used: items.length,
      emptySlots: base.inventory?.emptySlots ?? adapter.inventory?.emptySlots ?? null,
      counts,
    },
    equipment: base.equipment ?? adapter.equipment ?? null,
    lookingAt: base.lookingAt ?? null,
    map: inspect?.map?.text ?? base.map ?? null,
    nearbyBlocks: base.nearbyBlocks ?? null,
    entities,
    nearbyHostiles: base.nearbyHostiles ?? adapter.nearbyHostiles ?? null,
    spawnSafety: base.spawnSafety ?? adapter.spawnSafety ?? status?.adapter?.spawnSafety ?? null,
    pathfinder: base.pathfinder ?? adapter.pathfinder ?? null,
    lastDeath: base.lastDeath ?? adapter.lastDeath ?? null,
    task: task ?? status?.task ?? null,
    queue: Array.isArray(status?.queue) ? status.queue.map((entry) => ({ id: entry.id, kind: entry.kind, state: entry.state })) : [],
    safety: {
      paused: Boolean(status?.paused),
      pausedReason: status?.pausedReason ?? null,
      reflex: status?.safety?.reflex ?? null,
      lastReflex: status?.safety?.lastReflex ?? null,
      alarms: status?.safety?.alarms ?? null,
      bodyOnline: status?.safety?.bodyOnline ?? status?.connected ?? null,
      autoDefense: status?.safety?.autoDefense ?? null,
      lastDefense: status?.safety?.lastDefense ?? null,
    },
    playable: status?.playable ?? null,
    recentEvents: (Array.isArray(events) ? events : []).slice(-10).map((event) => ({ seq: event.seq, type: event.type, at: event.at })),
    radius,
  }
}

/**
 * 起一个可关闭的 viewer 服务（不依赖 prismarine-viewer 的 index / canvas）：
 * express 静态页 + socket.io，把 world 的区块按 standalone 协议发给浏览器。
 * viewerRoot：装好 prismarine-viewer 的目录（内含 express/socket.io/prismarine-viewer）。
 */
export async function startViewerServer({ viewerRoot, world, center, version, port = 3998, viewDistance = 3 }) {
  const root = resolveViewerRoot(viewerRoot)
  if (!root) throw new Error('viewer 不可用：未找到 prismarine-viewer（设 MC_EYES_VIEWER_ROOT 并安装，见 docs/MC-EYES.md）')
  if (!world || typeof world.getColumn !== 'function') throw new Error('viewer 需要 prismarine-world（body 未连接或 bot.world 不可用）')
  const requireViewer = createRequire(path.join(root, 'noop.js'))
  const express = requireViewer('express')
  const { setupRoutes } = requireViewer('prismarine-viewer/lib/common.js')
  const { Server } = requireViewer('socket.io')
  const http = requireViewer('http')
  const { Vec3 } = requireViewer('vec3')
  const app = express()
  setupRoutes(app, '')
  const server = http.createServer(app)
  const io = new Server(server)
  const fixedCenter = center instanceof Vec3 ? center : new Vec3(center.x, center.y, center.z)
  const sockets = new Set()
  async function sendChunks(socket) {
    const cx = Math.floor(fixedCenter.x / 16)
    const cz = Math.floor(fixedCenter.z / 16)
    for (let x = cx - viewDistance; x <= cx + viewDistance; x += 1) {
      for (let z = cz - viewDistance; z <= cz + viewDistance; z += 1) {
        try {
          const chunk = await world.getColumn(x, z)
          if (!chunk) continue
          socket.emit('loadChunk', { x: x * 16, z: z * 16, chunk: chunk.toJson() })
        } catch { /* 单列失败不阻塞 */ }
      }
    }
  }
  io.on('connection', (socket) => {
    socket.emit('version', version)
    sockets.add(socket)
    socket.emit('position', { pos: fixedCenter, addMesh: false })
    void sendChunks(socket)
    socket.on('disconnect', () => sockets.delete(socket))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  return {
    port,
    center: { x: fixedCenter.x, y: fixedCenter.y, z: fixedCenter.z },
    version,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) { try { socket.disconnect(true) } catch { /* ignore */ } }
      try { io.close() } catch { /* ignore */ }
      server.close(() => resolve())
    }),
  }
}

async function waitForDevtools(debugPort, timeoutMs = 15_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`)
      const list = await response.json()
      if (Array.isArray(list) && list.length) return list
    } catch { /* not ready */ }
    await sleep(150)
  }
  return null
}

/**
 * Edge headless（CDP）截 viewer 页面：
 * 启动 Edge → 导航 → 等 waitMs（区块/材质真实渲染）→ Page.captureScreenshot → 保存 → kill 进程树。
 * 返回 {files:[{file,bytes,at}], elapsedMs, sanity}。
 */
export async function captureScreenshot({
  url, outBase, width = 1280, height = 720, waitMs = 7000, frames = 1, intervalMs = 1000,
  edgePath = null, debugPort = 9333, profileDir = null,
} = {}) {
  const edge = findEdgePath(edgePath)
  if (!edge) throw new Error('找不到 Edge：设 MC_EYES_EDGE 或传 edgePath')
  if (!url) throw new Error('captureScreenshot 需要 url')
  const base = path.resolve(outBase)
  fs.mkdirSync(path.dirname(base), { recursive: true })
  fs.rmSync(base, { recursive: true, force: true })
  const child = spawn(edge, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--mute-audio', '--disable-background-networking', '--disable-extensions',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir ?? path.join(path.dirname(base), '.edge-profile')}`,
    `--window-size=${width},${height}`,
    'about:blank',
  ], { stdio: 'ignore' })
  const killTree = () => {
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      else child.kill('SIGKILL')
    } catch { /* ignore */ }
  }
  try {
    const targets = await waitForDevtools(debugPort)
    if (!targets) throw new Error(`Edge 在 ${debugPort} 没开 DevTools（--edge-path/端口占用？）`)
    const page = targets.find((target) => target.type === 'page') ?? targets[0]
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('CDP WebSocket 连不上')) })
    let nextId = 0
    const pending = new Map()
    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data)
        if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id) }
      } catch { /* ignore */ }
    }
    const send = (method, params = {}) => new Promise((resolve) => {
      const id = ++nextId
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })
    await send('Page.enable')
    await send('Runtime.enable')
    const started = Date.now()
    await send('Page.navigate', { url })
    await sleep(Math.max(500, waitMs))
    const sanity = await send('Runtime.evaluate', {
      expression: 'JSON.stringify({ready:document.readyState,canvas:!!document.querySelector("canvas"),w:(document.querySelector("canvas")||{}).width,h:(document.querySelector("canvas")||{}).height})',
      returnByValue: true,
    })
    const count = Math.max(1, Math.min(8, Number(frames) || 1))
    const files = []
    for (let index = 0; index < count; index += 1) {
      const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
      if (!shot.result?.data) throw new Error('CDP 截图失败（页面/渲染没起来）')
      const suffix = count === 1 ? '' : `-f${String(index + 1).padStart(3, '0')}`
      const file = `${base}${suffix}.png`
      fs.writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
      files.push({ file, bytes: fs.statSync(file).size, at: new Date().toISOString() })
      if (index < count - 1) await sleep(Math.max(1000, intervalMs))
    }
    try { ws.close() } catch { /* ignore */ }
    return { files, elapsedMs: Date.now() - started, sanity: sanity.result?.result?.value ?? null }
  } finally {
    killTree()
  }
}

