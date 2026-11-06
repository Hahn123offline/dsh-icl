#!/usr/bin/env node
// MC “看屏幕” PoC：prismarine-viewer 起 viewer 服务 → Edge headless (CDP) 截图。
//
// 只做验证，不接产品链路：
//   node packages/mc-body/tools/eyes-poc.mjs                       # offline：内存里造一个演示世界并截图
//   node packages/mc-body/tools/eyes-poc.mjs --frames 5 --interval-ms 1000   # 截 5 帧（给 album/video 用）
//   node packages/mc-body/tools/eyes-poc.mjs --mode bot --host 127.0.0.1 --mc-port 54838 --username ICL-eyes
//                                                                  # 另起观察 bot，连服务器后截它周围的画面（会多一个连接！）
//
// 依赖：
//   prismarine-viewer（不在 mc-body 依赖里；PoC 用独立目录安装）：
//     mkdir <repo>/.state/lab/mc-eyes-poc/viewer
//     cd  <repo>/.state/lab/mc-eyes-poc/viewer
//     npm init -y && npm i prismarine-viewer@1.33.0
//   然后 --viewer-root 指到该目录（或设 MC_EYES_VIEWER_ROOT）。
//   Edge（Windows 自带）：--edge-path 可覆盖。
//
// 说明：
//   - 渲染在浏览器里（WebGL）。headless + --disable-gpu 时走 SwiftShader 软件渲染，不占 GPU 跑模型的锁。
//   - 截图通过 CDP（Node 26 自带 WebSocket）完成，必须先等页面真实渲染几秒；Edge CLI 的 --screenshot 截图会太早（只剩天空）。
//   - 产物：PNG + 同名 .json（元数据），默认写到 <repo>/media/mc-eyes/。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '../../..')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next == null || next.startsWith('--')) out[key] = true
    else { out[key] = next; i += 1 }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const opt = (name, fallback = null) => (args[name] === undefined ? fallback : args[name])
const num = (name, fallback) => { const value = Number(opt(name, fallback)); return Number.isFinite(value) ? value : fallback }

function resolveViewerRoot() {
  const candidates = [
    opt('viewer-root'),
    process.env.MC_EYES_VIEWER_ROOT,
    path.join(REPO_ROOT, 'node_modules'),
    path.join(REPO_ROOT, '.state', 'lab', 'mc-eyes-poc', 'viewer'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    const root = path.resolve(String(candidate))
    if (fs.existsSync(path.join(root, 'node_modules', 'prismarine-viewer'))) return root
  }
  return null
}

function resolveEdgePath() {
  const candidates = [
    opt('edge-path'),
    process.env.MC_EYES_EDGE,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean)
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate
  return null
}

function buildOfflineWorld({ version, Vec3, World, Chunk, mcData }) {
  const st = (name) => {
    const block = mcData.blocksByName[name]
    if (!block) throw new Error(`版本 ${version} 没有方块 ${name}`)
    return block.defaultState
  }
  const ids = {
    grass: st('grass_block'), stone: st('stone'), planks: st('oak_planks'), log: st('oak_log'),
    leaves: st('oak_leaves'), glass: st('glass'), water: st('water'), iron: st('iron_ore'),
    diamond: st('diamond_ore'), cobble: st('cobblestone'), torch: st('torch'),
  }
  const inHouse = (x, z) => x >= 2 && x <= 8 && z >= 2 && z <= 8
  const inPool = (x, z) => x >= 13 && x <= 17 && z >= 2 && z <= 8
  function blockAt(x, y, z) {
    if (y === 0) {
      if (inPool(x, z)) return ids.water
      return inHouse(x, z) ? ids.planks : ids.grass
    }
    if (y >= 1 && y <= 2) {
      if (inPool(x, z)) return ids.water
      if (inHouse(x, z) && (x === 2 || x === 8 || z === 2 || z === 8)) {
        if (z === 2 && x === 5) return 0 // 门
        return ids.planks
      }
    }
    if (y === 3 && inHouse(x, z)) return ids.planks
    if ((x === 11 && z === 11) || (x === 11 && z === 13)) {
      if (y >= 1 && y <= 5) return ids.log
      if (y >= 5 && y <= 6 && Math.abs(x - 11) <= 2 && Math.abs(z - 12) <= 2) return ids.leaves
    }
    if (x >= 19 && x <= 21 && z >= 15 && z <= 17 && y >= 0 && y <= 7) {
      if (y === 3 && x === 19) return ids.iron
      if (y === 6 && z === 15) return ids.diamond
      if (y === 2 && z === 17) return ids.cobble
      return ids.stone
    }
    if (x === 12 && y === 1 && z === 4) return ids.torch
    return 0
  }
  const world = new World((chunkX, chunkZ) => {
    const chunk = new Chunk()
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 16; x += 1) {
        for (let z = 0; z < 16; z += 1) {
          chunk.setBlockStateId(new Vec3(x, y, z), blockAt(chunkX * 16 + x, y, chunkZ * 16 + z))
        }
      }
    }
    return chunk
  })
  return { world, center: new Vec3(8, 6, 8), blocks: 32 * 32 + 3 * 7 * 9 + 4 * 6 * 4 + 3 * 8 * 3 }
}

async function waitForDevtools(debugPort, timeoutMs = 15_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`)
      const list = await response.json()
      if (Array.isArray(list) && list.length) return list
    } catch { /* browser not ready */ }
    await sleep(150)
  }
  return null
}

async function captureScreenshots({ url, outBase, width, height, waitMs, frames, intervalMs, edgePath, debugPort, profileDir }) {
  fs.rmSync(outBase, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(outBase), { recursive: true })
  const edge = spawn(edgePath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--mute-audio', '--disable-background-networking', '--disable-extensions',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    `--window-size=${width},${height}`,
    'about:blank',
  ], { stdio: 'ignore' })
  const cleanup = () => {
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore' })
      else edge.kill('SIGKILL')
    } catch { /* ignore */ }
  }
  try {
    const targets = await waitForDevtools(debugPort)
    if (!targets) throw new Error(`Edge 在 ${debugPort} 没开 DevTools（检查 --edge-path / 端口占用）`)
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
    await sleep(waitMs)
    const sanity = await send('Runtime.evaluate', {
      expression: 'JSON.stringify({ready:document.readyState,canvas:!!document.querySelector("canvas"),w:(document.querySelector("canvas")||{}).width,h:(document.querySelector("canvas")||{}).height})',
      returnByValue: true,
    })
    const files = []
    const count = Math.max(1, Math.min(120, frames))
    for (let index = 0; index < count; index += 1) {
      const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
      if (!shot.result?.data) throw new Error('CDP 截图失败（页面/渲染没起来）')
      const suffix = count === 1 ? '' : `-f${String(index + 1).padStart(3, '0')}`
      const file = `${outBase}${suffix}.png`
      fs.writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
      files.push({ file, bytes: fs.statSync(file).size, at: new Date().toISOString() })
      if (index < count - 1) await sleep(Math.max(100, intervalMs))
    }
    const elapsedMs = Date.now() - started
    try { ws.close() } catch { /* ignore */ }
    return { files, elapsedMs, sanity: sanity.result?.result?.value ?? null }
  } finally {
    cleanup()
  }
}

async function main() {
  const mode = String(opt('mode', 'offline'))
  const version = String(opt('version', mode === 'bot' ? 'auto' : '1.16.4'))
  const width = Math.max(320, Math.min(2560, num('width', 1280)))
  const height = Math.max(200, Math.min(1440, num('height', 720)))
  const waitMs = Math.max(1000, Math.min(60_000, num('wait-ms', 7000)))
  const frames = Math.max(1, Math.min(120, num('frames', 1)))
  const intervalMs = Math.max(100, Math.min(60_000, num('interval-ms', 1000)))
  const viewerPort = Math.max(1024, Math.min(65_000, num('port', 3999)))
  const debugPort = Math.max(1024, Math.min(65_000, num('debug-port', 9333)))
  const outBase = path.resolve(String(opt('out', path.join(REPO_ROOT, 'media', 'mc-eyes', `mc-${mode}-${Date.now()}`))))
  const viewerRoot = resolveViewerRoot()
  if (!viewerRoot) {
    throw new Error('找不到 prismarine-viewer：请 --viewer-root <装好 prismarine-viewer 的目录>，或设 MC_EYES_VIEWER_ROOT。安装见文件头注释。')
  }
  const edgePath = resolveEdgePath()
  if (!edgePath) throw new Error('找不到 Edge：请 --edge-path 指定 msedge.exe，或设 MC_EYES_EDGE。')
  const requireViewer = createRequire(path.join(viewerRoot, 'noop.js'))
  const requireRepo = createRequire(path.join(REPO_ROOT, 'noop.js'))
  const standaloneViewer = requireViewer('prismarine-viewer/lib/standalone.js')
  const mcData = requireViewer('minecraft-data')(version === 'auto' ? '1.21.4' : version)
  const World = requireViewer('prismarine-world')(version === 'auto' ? '1.21.4' : version)
  const Chunk = requireViewer('prismarine-chunk')(version === 'auto' ? '1.21.4' : version)
  const { Vec3 } = requireViewer('vec3')

  const meta = {
    generatedAt: new Date().toISOString(),
    mode,
    viewer: { package: 'prismarine-viewer', version: tryReadViewerVersion(viewerRoot), root: viewerRoot, port: viewerPort },
    edge: { path: edgePath, width, height, debugPort, flags: 'headless=new,disable-gpu(SwiftShader),mute-audio' },
    capture: { waitMs, frames, intervalMs, outBase },
  }
  if (mode === 'offline') {
    const demo = buildOfflineWorld({ version, Vec3, World, Chunk, mcData })
    standaloneViewer({ version, world: demo.world, center: demo.center, viewDistance: 3, port: viewerPort })
    meta.world = { kind: 'in-memory-demo', version, center: demo.center, viewDistance: 3, approxBlocks: demo.blocks }
  } else if (mode === 'bot') {
    const host = String(opt('host', '127.0.0.1'))
    const mcPort = Math.max(1, Math.min(65_535, num('mc-port', 25565)))
    const username = String(opt('username', 'ICL-eyes'))
    const mineflayer = requireRepo('mineflayer')
    if (!mineflayer?.createBot) throw new Error('bot 模式需要仓库依赖 mineflayer（node_modules/mineflayer）')
    const bot = mineflayer.createBot({ host, port: mcPort, username, auth: 'offline', version: opt('mc-version', false) || false })
    try {
      await new Promise((resolve, reject) => {
        bot.once('spawn', resolve)
        bot.once('error', reject)
        setTimeout(() => reject(new Error('bot spawn 超时（服务器没起/端口不对/同名被踢？）')), 45_000)
      })
      if (typeof bot.waitForChunksToLoad === 'function') await Promise.race([bot.waitForChunksToLoad(), sleep(8000)]).catch(() => {})
      await sleep(800)
      const center = { x: Math.floor(bot.entity.position.x), y: Math.floor(bot.entity.position.y), z: Math.floor(bot.entity.position.z) }
      const botVersion = String(bot.version ?? version)
      meta.world = { kind: 'bot-nearby', botUsername: username, version: botVersion, center, dimension: bot.game?.dimension ?? null, health: bot.health, food: bot.food }
      standaloneViewer({ version: botVersion, world: bot.world, center, viewDistance: 3, port: viewerPort })
      const captured = await captureScreenshots({
        url: `http://127.0.0.1:${viewerPort}/`, outBase, width, height, waitMs, frames, intervalMs, edgePath, debugPort,
        profileDir: path.join(path.dirname(outBase), '.edge-profile'),
      })
      meta.captureResult = captured
      bot.quit('eyes-done')
    } finally {
      try { bot.quit('eyes-cleanup') } catch { /* ignore */ }
    }
  } else {
    throw new Error(`未知 --mode：${mode}（支持 offline / bot）`)
  }

  const captured = meta.captureResult ?? await captureScreenshots({
    url: `http://127.0.0.1:${viewerPort}/`, outBase, width, height, waitMs, frames, intervalMs, edgePath, debugPort,
    profileDir: path.join(path.dirname(outBase), '.edge-profile'),
  })
  meta.captureResult = captured
  meta.files = captured.files
  meta.nodeRssMb = Math.round(process.memoryUsage().rss / 1048576)
  fs.writeFileSync(`${outBase}.json`, JSON.stringify(meta, null, 2), 'utf8')
  console.log(`[mc-eyes] mode=${mode} files=${captured.files.length} png=${path.relative(REPO_ROOT, captured.files[0]?.file ?? '')} captureMs=${captured.elapsedMs} sanity=${captured.sanity}`)
  console.log(`[mc-eyes] meta=${path.relative(REPO_ROOT, `${outBase}.json`)}`)
  process.exit(0)
}

function tryReadViewerVersion(viewerRoot) {
  try { return JSON.parse(fs.readFileSync(path.join(viewerRoot, 'node_modules', 'prismarine-viewer', 'package.json'), 'utf8')).version } catch { return null }
}

main().catch((error) => {
  console.error(`[mc-eyes] failed: ${error?.message ?? error}`)
  process.exit(1)
})
