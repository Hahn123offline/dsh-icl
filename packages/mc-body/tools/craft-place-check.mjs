// 真服最小链路验收：scan 树 → mine logs → craft 木板/工作台/木棍/木镐 → mine 土 → place（有支撑/悬空）
// 只用于验收窗口（需要 normal 地形）：54840 用前先确认没有别的 bot 在跑场景。
// 用法：
//   node packages/mc-body/tools/craft-place-check.mjs --port 54840 --listen 54902 --name ICL-mcbody-1 \
//     --out <ICL_ROOT>/lab/mc-body-soak/craft-place-<run>
// 产物：report.md + metrics.json + events.jsonl + body.log + body-exit.json
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { iclPaths } from '../../core/src/icl-paths.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const bodyCli = path.resolve(here, '..', 'src', 'cli.mjs')
const args = process.argv.slice(2)
const arg = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback }
const host = String(arg('--host', '127.0.0.1'))
const port = Number(arg('--port', 54840))
const listen = Number(arg('--listen', 54902))
const name = String(arg('--name', 'ICL-mcbody-1')).slice(0, 16)
const out = path.resolve(String(arg('--out', path.join(iclPaths().root, 'lab', 'mc-body-soak', `craft-place-${new Date().toISOString().replace(/[:.]/g, '-')}`))))
fs.mkdirSync(out, { recursive: true })
const base = `http://127.0.0.1:${listen}`
const logStream = fs.createWriteStream(path.join(out, 'body.log'), { flags: 'a' })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function get(pathname) {
  const response = await fetch(`${base}${pathname}`, { signal: AbortSignal.timeout(4000) })
  return response.json()
}
async function post(pathname, body, timeoutMs = 120_000) {
  const response = await fetch(`${base}${pathname}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(timeoutMs),
  })
  return response.json()
}
async function waitFor(fn, timeoutMs, label) {
  const start = Date.now()
  let lastError = null
  while (Date.now() - start < timeoutMs) {
    try { const value = await fn(); if (value) return value } catch (error) { lastError = error }
    await sleep(400)
  }
  throw new Error(`wait timeout: ${label}${lastError ? ` (${lastError.message})` : ''}`)
}

const metrics = { at: new Date().toISOString(), out, server: `${host}:${port}`, bot: name, steps: [], inventory: {}, checks: {}, error: null }
const child = spawn(process.execPath, [
  bodyCli, '--host', host, '--port', String(port), '--listen', String(listen), '--name', name,
  '--allow-task', '--paused-disconnect-ms', '0',
  '--state', path.join(out, 'tasks.json'), '--log', path.join(out, 'events.jsonl'),
], { stdio: ['ignore', 'pipe', 'pipe'], cwd: path.resolve(here, '..', '..', '..') })
child.stdout.pipe(logStream)
child.stderr.pipe(logStream)

const inventoryCount = async (item) => {
  const data = await post('/v1/inspect', { kind: 'inventory' })
  const items = data?.result?.data?.items ?? []
  if (!item) return items.map((row) => `${row.name}x${row.count}`).join(',')
  return items.filter((row) => row.name === item).reduce((sum, row) => sum + row.count, 0)
}

// 验收脚本的韧性：如果身体因安全原因暂停（摔伤等），记录后显式 resume 再继续，避免一条链全 409。
// 正常路径不应触发；触发会记在 metrics.pauseEpisodes 里，仍算证据的一部分。
async function ensureUnpaused(label) {
  const status = await get('/v1/status').catch(() => null)
  if (!status?.paused) return false
  const episode = { label, reason: status.pausedReason, task: status.task?.id ?? null, at: Date.now() }
  metrics.pauseEpisodes = metrics.pauseEpisodes ?? []
  metrics.pauseEpisodes.push(episode)
  console.log(`[pause] ${label}: ${status.pausedReason} → resume`)
  await post('/v1/safety/resume', {}, 8000).catch(() => null)
  return true
}

async function step(label, fn) {
  const startedAt = Date.now()
  let result
  let error = null
  try {
    await ensureUnpaused(label)
    result = await fn()
  } catch (cause) { error = String(cause?.message ?? cause) }
  const row = { label, ms: Date.now() - startedAt, error, result }
  metrics.steps.push(row)
  console.log(`${error ? 'FAIL' : 'ok  '} ${label} ${error ?? JSON.stringify(result).slice(0, 300)}`)
  return row
}

try {
  await waitFor(async () => {
    const status = await get('/v1/status')
    return status?.connected && status?.adapter?.spawnSafety ? status : null
  }, 90_000, 'connect + spawn safety')
  const status0 = await get('/v1/status')
  metrics.initial = {
    position: status0.adapter?.position,
    health: status0.adapter?.health,
    spawnSafety: status0.adapter?.spawnSafety,
    environment: status0.adapter?.environment,
    pathfinder: status0.adapter?.pathfinder,
  }
  console.log('initial:', JSON.stringify(metrics.initial).slice(0, 600))

  // 1. scan 树 → 走到最近一棵
  const tree = await step('scan oak_log', async () => {
    const data = await post('/v1/inspect', { kind: 'scan', params: { name: 'oak_log', radius: 48, count: 3 } })
    const rows = data?.result?.data?.rows ?? []
    if (!rows.length) throw new Error('附近 48 格没有 oak_log（这服不是 normal 地形？）')
    return rows[0]
  })
  if (!tree.error) {
    await step('goto tree', async () => {
      const data = await post('/v1/do', { steps: [{ op: 'goto', params: { x: tree.result.x, y: tree.result.y, z: tree.result.z, range: 2 } }] }, 150_000)
      const row = data?.results?.[0]?.result
      if (data?.error) throw new Error(data.error)
      return row
    })
  }

  // 找“本格下方是实心”的候选落点（map 读脚下方块层），按距离排序返回最多 limit 个。
  async function findSupportedSpots(offset = 2, limit = 4) {
    const status = await get('/v1/status')
    const position = status.adapter?.position
    if (!position) return []
    const floor = { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) }
    const radius = Math.max(2, offset)
    const map = await post('/v1/inspect', { kind: 'map', params: { radius } })
    const rows = map?.result?.data?.rows ?? []
    const spots = []
    for (let dz = -radius; dz <= radius; dz += 1) {
      const row = rows[dz + radius]
      if (!row) continue
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (dx === 0 && dz === 0) continue
        if (row[dx + radius] !== '#') continue
        const distance = Math.hypot(dx, dz)
        if (distance > radius) continue
        spots.push({ x: floor.x + dx, y: floor.y, z: floor.z + dz, distance })
      }
    }
    spots.sort((a, b) => a.distance - b.distance)
    return spots.slice(0, limit).map(({ x, y, z }) => ({ x, y, z }))
  }

  // 2. 砍 4 个原木（木镐链要 12 木板 = 工作台 4 + 木棍 2 + 木镐 3 才够；不够时按实际材料自适应）
  await step('mine oak_log x4', async () => {
    const data = await post('/v1/do', { steps: [{ op: 'mine', params: { block: 'oak_log', count: 4, radius: 28 } }] }, 180_000)
    if (data?.error) throw new Error(data.error)
    if (data?.results?.[0]?.result?.error) throw new Error(data.results[0].result.error)
    const mined = Number(data?.results?.[0]?.result?.mined ?? data?.results?.[0]?.result?.result?.mined ?? 0)
    const logs = await inventoryCount('oak_log')
    if (logs < 1) throw new Error(`背包 oak_log 只有 ${logs}（至少 1 根才能继续）；mined=${mined}`)
    return { mined, logs, note: logs < 4 ? '原木不足 4，后续按实际材料自适应' : null }
  })

  // 3. 木板（一次产 4；按实际原木数合成，最多 12）
  await step('craft oak_planks (adaptive)', async () => {
    const logs = await inventoryCount('oak_log')
    const desired = Math.min(12, logs * 4)
    if (desired < 4) throw new Error(`原木 ${logs} 根不够合成木板`)
    const data = await post('/v1/do', { steps: [{ op: 'craft', params: { item: 'oak_planks', count: desired } }] })
    if (data?.error) throw new Error(data.error)
    if (data?.results?.[0]?.result?.error) throw new Error(data.results[0].result.error)
    const have = await inventoryCount('oak_planks')
    if (have < desired) throw new Error(`oak_planks 只有 ${have}（期望 ≥${desired}）`)
    return { ...data.results[0].result, inventory: have }
  })

  // 4. 工作台（4 木板）
  await step('craft crafting_table', async () => {
    const planks = await inventoryCount('oak_planks')
    if (planks < 4) throw new Error(`木板只有 ${planks}，不够工作台（需要 4）`)
    const data = await post('/v1/do', { steps: [{ op: 'craft', params: { item: 'crafting_table', count: 1 } }] })
    if (data?.error) throw new Error(data.error)
    if (data?.results?.[0]?.result?.error) throw new Error(data.results[0].result.error)
    const have = await inventoryCount('crafting_table')
    if (have < 1) throw new Error('背包没有 crafting_table')
    return { ...data.results[0].result, inventory: have }
  })

  // 5. 木棍（1 次产 4）
  await step('craft stick x4', async () => {
    if (await inventoryCount('oak_planks') < 2) throw new Error('木板不够木棍（需要 2）')
    const data = await post('/v1/do', { steps: [{ op: 'craft', params: { item: 'stick', count: 4 } }] })
    if (data?.error) throw new Error(data.error)
    if (data?.results?.[0]?.result?.error) throw new Error(data.results[0].result.error)
    const have = await inventoryCount('stick')
    if (have < 4) throw new Error(`stick 只有 ${have}（期望 ≥4）`)
    return { ...data.results[0].result, inventory: have }
  })

  // 6. 木镐（3 木板 + 2 木棍）：先在“有支撑的空格”放下工作台，再合成
  await step('craft wooden_pickaxe', async () => {
    let planks = await inventoryCount('oak_planks')
    let sticks = await inventoryCount('stick')
    if (planks < 3 || sticks < 2) {
      // 材料不够：再补砍 2 根原木，补 8 木板（尽量不因世界而失败）
      const extra = await post('/v1/do', { steps: [{ op: 'mine', params: { block: 'oak_log', count: 2, radius: 28 } }] }, 150_000)
      if (!extra?.results?.[0]?.result?.error) {
        const logsNow = await inventoryCount('oak_log')
        if (logsNow > 0) {
          const more = Math.min(8, logsNow * 4)
          await post('/v1/do', { steps: [{ op: 'craft', params: { item: 'oak_planks', count: more } }] }).catch(() => null)
          planks = await inventoryCount('oak_planks')
        }
      }
      if (sticks < 2 && planks >= 2) {
        await post('/v1/do', { steps: [{ op: 'craft', params: { item: 'stick', count: 4 } }] }).catch(() => null)
        sticks = await inventoryCount('stick')
      }
    }
    if (planks < 3 || sticks < 2) throw new Error(`材料不足：planks=${planks} sticks=${sticks}（世界资源不够，不是 craft 实现问题）`)
    const spots = await findSupportedSpots(3, 4)
    if (spots.length) {
      const placed = await post('/v1/do', { steps: [{ op: 'place', item: 'crafting_table', positions: spots, autoSupport: true }] }, 60_000)
      metrics.tablePlacement = { spots, result: placed?.results?.[0]?.result ?? { error: placed?.error } }
    } else {
      metrics.tablePlacement = { spot: null, note: '附近没有有支撑的空格，直接尝试合成（可能因为够不到工作台失败）' }
    }
    const data = await post('/v1/do', { steps: [{ op: 'craft', params: { item: 'wooden_pickaxe', count: 1 } }] })
    if (data?.error) throw new Error(data.error)
    if (data?.results?.[0]?.result?.error) throw new Error(data.results[0].result.error)
    const have = await inventoryCount('wooden_pickaxe')
    if (have < 1) throw new Error('背包没有 wooden_pickaxe')
    return { ...data.results[0].result, inventory: have, planks, sticks }
  })

  // 7. 挖 2 个土用于 place
  await step('mine dirt x2', async () => {
    const data = await post('/v1/do', { steps: [{ op: 'mine', params: { block: 'dirt', count: 2, radius: 8 } }] }, 120_000)
    if (data?.error) throw new Error(data.error)
    if (data?.results?.[0]?.result?.error) throw new Error(data.results[0].result.error)
    const have = await inventoryCount('dirt')
    if (have < 2) throw new Error(`dirt 只有 ${have}（期望 ≥2）`)
    return { ...data.results[0].result, inventory: have }
  })

  // 8. place：一格有支撑（应成功）+ 一格悬空（应 skipped 且给原因）
  await step('place dirt (supported + floating)', async () => {
    const spots = await findSupportedSpots(3, 3)
    if (!spots.length) throw new Error('附近找不到“本格下方实心”的落点（地形太悬空）')
    const supported = spots[0]
    const floating = { x: supported.x, y: supported.y + 3, z: supported.z }
    const data = await post('/v1/do', { steps: [{ op: 'place', item: 'dirt', positions: [floating, ...spots] }] }, 60_000)
    if (data?.error) throw new Error(data.error)
    const result = data.results?.[0]?.result ?? {}
    if (!result.placedCount) throw new Error(`一个都没放下：${JSON.stringify(result.skipped ?? [])}`)
    if (!result.skippedCount) throw new Error('悬空目标没有被跳过（place 的错误语义没生效）')
    if (!String(result.skipped?.[0]?.reason ?? '')) throw new Error('skipped 没有 reason')
    return { supported, placedCount: result.placedCount, skipped: result.skipped }
  })

  metrics.checks = {
    scannedTree: !tree.error,
    craftedPickaxe: metrics.steps.find((row) => row.label === 'craft wooden_pickaxe')?.error == null,
    placedWithSupport: metrics.steps.find((row) => row.label.startsWith('place dirt'))?.error == null,
    noCrash: child.exitCode == null,
  }
  metrics.inventory = { final: await inventoryCount() }
} catch (error) {
  metrics.error = String(error?.message ?? error)
} finally {
  try { await post('/v1/shutdown', { reason: 'craft-place-check-done' }, 5000) } catch { /* ignore */ }
  await sleep(1200)
  try { if (child.exitCode == null) child.kill('SIGTERM') } catch { /* ignore */ }
  await sleep(1200)
  try { if (child.exitCode == null) child.kill('SIGKILL') } catch { /* ignore */ }
  metrics.bodyExit = child.exitCode
  try { metrics.bodyExitRecord = JSON.parse(fs.readFileSync(path.join(out, 'body-exit.json'), 'utf8')) } catch { /* ignore */ }
  logStream.end()
}

const stepsOk = metrics.steps.filter((row) => row.error == null).length
const pass = !metrics.error && stepsOk === metrics.steps.length && Object.values(metrics.checks).every(Boolean)
const summary = [
  '# MC body 真服最小链路（scan → mine → craft → place）',
  '',
  `- run: ${out}`,
  `- server: ${metrics.server} · bot: ${metrics.bot} · body http: ${base}`,
  `- initial: ${JSON.stringify(metrics.initial)}`,
  '',
  '## steps',
  ...metrics.steps.map((row) => `- ${row.error ? '✗' : '✓'} ${row.label} (${row.ms}ms)${row.error ? ` — ${row.error}` : ` — ${JSON.stringify(row.result).slice(0, 400)}`}`),
  '',
  `- final inventory: ${metrics.inventory?.final ?? '?'}`,
  `- body exit: code=${metrics.bodyExit ?? 'null'}${metrics.bodyExitRecord ? ` reason=${metrics.bodyExitRecord.reason}` : ''}`,
  `- error: ${metrics.error ?? 'none'}`,
  `- checks: ${JSON.stringify(metrics.checks)}`,
  `- result: ${pass ? 'PASS' : 'FAIL'}`,
].join('\n')
fs.writeFileSync(path.join(out, 'report.md'), `${summary}\n`, 'utf8')
fs.writeFileSync(path.join(out, 'metrics.json'), JSON.stringify(metrics, null, 2), 'utf8')
console.log(summary)
process.exit(pass ? 0 : 1)
