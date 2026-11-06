#!/usr/bin/env node
// MC “看屏幕” PoC / 本地验证工具：viewer（prismarine-viewer）→ Edge headless CDP 截图。
//
// 用法：
//   node packages/mc-body/tools/eyes-poc.mjs                  # offline：内存里造演示世界并截图
//   node .../eyes-poc.mjs --frames 3 --interval-ms 1000       # 帧序列（给 album/video）
//   node .../eyes-poc.mjs --mode bot --host 127.0.0.1 --mc-port 54840 --username ICL-eyes
//
// 依赖（PoC 独立安装，不进产品依赖）：
//   mkdir <repo>/.state/lab/mc-eyes-poc/viewer && cd $_
//   npm init -y && npm i prismarine-viewer@1.33.0
//   --viewer-root 指到该目录（或设 MC_EYES_VIEWER_ROOT）。
// 需要 Edge（Windows 自带），可用 --edge-path / MC_EYES_EDGE 覆盖。
//
// 实现：复用 packages/mc-body/src/eyes.mjs（与 body 的 /v1/eyes/screenshot 同一套代码）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { captureScreenshot, resolveViewerRoot, startViewerServer } from '../src/eyes.mjs'

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

function buildDemoWorld({ version, requireViewer }) {
  const mcData = requireViewer('minecraft-data')(version)
  const World = requireViewer('prismarine-world')(version)
  const Chunk = requireViewer('prismarine-chunk')(version)
  const { Vec3 } = requireViewer('vec3')
  const st = (name) => {
    const block = mcData.blocksByName[name]
    if (!block) throw new Error(`版本 ${version} 没有方块 ${name}`)
    return block.defaultState
  }
  const ids = {
    grass: st('grass_block'), stone: st('stone'), planks: st('oak_planks'), log: st('oak_log'),
    leaves: st('oak_leaves'), water: st('water'), iron: st('iron_ore'),
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
      if (inHouse(x, z) && (x === 2 || x === 8 || z === 2 || z === 8)) return z === 2 && x === 5 ? 0 : ids.planks
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
  return { world, center: new Vec3(8, 6, 8) }
}

async function main() {
  const mode = String(opt('mode', 'offline'))
  const version = String(opt('version', '1.16.4'))
  const width = Math.max(640, Math.min(1600, num('width', 1280)))
  const height = Math.max(360, Math.min(900, num('height', 720)))
  const waitMs = Math.max(3000, Math.min(10_000, num('wait-ms', 7000)))
  const frames = Math.max(1, Math.min(8, num('frames', 1)))
  const intervalMs = Math.max(1000, Math.min(5000, num('interval-ms', 1000)))
  const port = Math.max(1024, Math.min(65_000, num('port', 3999)))
  const debugPort = Math.max(1024, Math.min(65_000, num('debug-port', 9333)))
  const edgePath = opt('edge-path', null)
  const outBase = path.resolve(String(opt('out', path.join(REPO_ROOT, 'media', 'mc-eyes', `poc-${mode}-${Date.now()}`))))
  const viewerRoot = resolveViewerRoot(opt('viewer-root', null))
  if (!viewerRoot) throw new Error('找不到 prismarine-viewer：--viewer-root 或 MC_EYES_VIEWER_ROOT（安装见文件头）')
  const requireViewer = createRequire(path.join(viewerRoot, 'noop.js'))

  let bot = null
  let viewer = null
  const meta = { generatedAt: new Date().toISOString(), mode, viewerRoot, version, viewport: { width, height }, waitMs, frames, intervalMs }
  try {
    if (mode === 'offline') {
      const demo = buildDemoWorld({ version, requireViewer })
      viewer = await startViewerServer({ viewerRoot, world: demo.world, center: demo.center, version, port, viewDistance: 3 })
      meta.world = { kind: 'in-memory-demo', version, center: demo.center }
    } else if (mode === 'bot') {
      const mineflayer = requireViewer('mineflayer')
      const host = String(opt('host', '127.0.0.1'))
      const mcPort = Math.max(1, Math.min(65_535, num('mc-port', 25565)))
      const username = String(opt('username', 'ICL-eyes')).slice(0, 16)
      bot = mineflayer.createBot({ host, port: mcPort, username, auth: 'offline', version: opt('mc-version', false) || false })
      await new Promise((resolve, reject) => {
        bot.once('spawn', resolve)
        bot.once('error', reject)
        setTimeout(() => reject(new Error('bot spawn 超时（服务器没起/端口不对/同名被踢？）')), 45_000)
      })
      if (typeof bot.waitForChunksToLoad === 'function') await Promise.race([bot.waitForChunksToLoad(), sleep(8000)]).catch(() => {})
      await sleep(800)
      const center = { x: Math.floor(bot.entity.position.x), y: Math.floor(bot.entity.position.y), z: Math.floor(bot.entity.position.z) }
      meta.world = { kind: 'bot-nearby', botUsername: username, version: bot.version, center, dimension: bot.game?.dimension ?? null, health: bot.health, food: bot.food }
      viewer = await startViewerServer({ viewerRoot, world: bot.world, center, version: bot.version, port, viewDistance: 3 })
    } else {
      throw new Error(`未知 --mode：${mode}（支持 offline / bot）`)
    }
    const captured = await captureScreenshot({
      url: `http://127.0.0.1:${viewer.port}/`, outBase, width, height, waitMs, frames, intervalMs,
      edgePath, debugPort, profileDir: path.join(path.dirname(outBase), '.edge-profile'),
    })
    meta.capture = captured
    meta.files = captured.files
    meta.nodeRssMb = Math.round(process.memoryUsage().rss / 1048576)
    fs.writeFileSync(`${outBase}.json`, JSON.stringify(meta, null, 2), 'utf8')
    console.log(`[mc-eyes] mode=${mode} files=${captured.files.length} png=${captured.files[0]?.file} bytes=${captured.files[0]?.bytes} captureMs=${captured.elapsedMs} sanity=${captured.sanity}`)
    console.log(`[mc-eyes] meta=${outBase}.json`)
  } finally {
    if (viewer) { try { await viewer.close() } catch { /* ignore */ } }
    if (bot) { try { bot.quit('eyes-done') } catch { /* ignore */ } }
  }
  process.exit(0)
}

main().catch((error) => {
  console.error(`[mc-eyes] failed: ${error?.message ?? error}`)
  process.exit(1)
})
