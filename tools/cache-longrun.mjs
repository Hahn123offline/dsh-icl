// 长跑缓存体检：从全局 NInfer 请求日志按时间窗切出一次 long run 的缓存指标，
// 并能顺带统计该 run 的 DSH 事件流（system 稳定性 / facts 快照 / turn 数）。
//
//   node tools/cache-longrun.mjs \
//     --start 2026-11-06T00:22:00+08:00 --end 2026-11-06T06:51:30+08:00 \
//     --events C:/DSH/icl-wt/mc-lab/.state/lab/night-1/events.jsonl \
//     --out .state/cache/night-1.json
//
// 输出：
//   engine.overall          窗口内全部 tool-bearing 请求的 prompt/prefill/hit/TTFT/全量失效
//   engine.buckets10min     10 分钟桶（看命中率随时间/上下文增长的变化）
//   engine.gaps             相邻请求间隔 >120s 的“无模型活动”窗口（睡眠/停摆）
//   engine.fullInvalidations 逐条全量失效（hit=0 && prefill>0）的时间/prompt/path
//   events                  system 段稳定性（append/replace/字节）、facts 快照条数与字符、turn/step 数
//
// 口径（与 docs/CACHE-MODEL.md §6.4 一致）：
//   · prompt/prefill/hit 全部来自引擎 request_done；
//   · 全量失效 = hit=0 && prefill>0（"整段冷启动"可另用 prefill>1000 过滤）；
//   · 窗口按本地时间字符串解析（含 +08:00）。只读，不占 GPU、不碰 lab 进程。

import fs from 'node:fs'
import path from 'node:path'

const ENGINE = process.env.NINFER_LOG || 'C:/DSH/moe_streaming/logs/ninfer-coder390-q3-df2-4x500.requests.jsonl'
const arg = (name, fallback = null) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback }

function fail(message) { console.error(`[cache-longrun] ${message}`); process.exit(1) }

const start = Date.parse(String(arg('--start', '')))
const end = Date.parse(String(arg('--end', '')))
if (!Number.isFinite(start) || !Number.isFinite(end)) fail('需要 --start 和 --end（ISO 时间，例如 2026-11-06T00:22:00+08:00）')

function stats(list) {
  const prompt = list.reduce((sum, row) => sum + row.prompt, 0)
  const prefill = list.reduce((sum, row) => sum + row.prefill, 0)
  const hit = list.reduce((sum, row) => sum + row.hit, 0)
  const ttfts = list.map((row) => row.ttft).filter((value) => value > 0).sort((a, b) => a - b)
  const quantile = (q) => (ttfts.length ? +ttfts[Math.min(ttfts.length - 1, Math.floor(q * ttfts.length))].toFixed(2) : null)
  return {
    requests: list.length,
    promptTokens: prompt,
    avgPromptTokens: list.length ? Math.round(prompt / list.length) : null,
    prefillTokens: prefill,
    avgPrefillTokens: list.length ? +(prefill / list.length).toFixed(0) : null,
    hitTokens: hit,
    hitPct: prompt ? +(hit / prompt * 100).toFixed(2) : null,
    fullInvalidations: list.filter((row) => row.hit === 0 && row.prefill > 0).length,
    coldInvalidations: list.filter((row) => row.hit === 0 && row.prefill > 1000).length,
    cancelled: list.filter((row) => row.finish === 'cancelled').length,
    ttftMeanSeconds: ttfts.length ? +(ttfts.reduce((a, b) => a + b, 0) / ttfts.length).toFixed(2) : null,
    ttftP50Seconds: quantile(0.5),
    ttftP95Seconds: quantile(0.95),
    ttftMaxSeconds: ttfts.length ? +ttfts.at(-1).toFixed(2) : null,
    prefillSeconds: +list.reduce((sum, row) => sum + row.prefillS, 0).toFixed(1),
  }
}

const requests = []
for (const line of fs.readFileSync(ENGINE, 'utf8').split('\n')) {
  if (!line.trim()) continue
  let entry
  try { entry = JSON.parse(line) } catch { continue }
  if (entry.event !== 'request_done') continue
  const at = Number(entry.timestamp_unix_ms)
  if (!(at >= start && at <= end)) continue
  const request = entry.request ?? {}
  const result = entry.result ?? {}
  const timings = entry.timings_seconds ?? {}
  if ((request.tool_count ?? 0) === 0) continue // 标题/辅助请求另计，不进缓存体检
  requests.push({
    at,
    local: new Date(at + 8 * 3600_000).toISOString().slice(11, 19),
    tools: request.tool_count ?? 0,
    messages: request.message_count ?? 0,
    prompt: result.prompt_tokens ?? 0,
    prefill: result.computed_prefill_tokens ?? 0,
    hit: result.prefix_cache_hit_tokens ?? 0,
    path: result.prefix_reuse_path ?? null,
    finish: result.finish_reason ?? null,
    ttft: timings.ttft ?? 0,
    prefillS: timings.prefill ?? 0,
  })
}
requests.sort((a, b) => a.at - b.at)
if (!requests.length) fail('窗口内没有 tool-bearing 请求')

const buckets = new Map()
for (const row of requests) {
  const date = new Date(row.at + 8 * 3600_000)
  const key = date.toISOString().slice(11, 13) + ':' + String(Math.floor(date.getUTCMinutes() / 10) * 10).padStart(2, '0')
  const bucket = buckets.get(key) ?? { key, list: [] }
  bucket.list.push(row)
  buckets.set(key, bucket)
}
const buckets10min = Object.fromEntries([...buckets.entries()].sort().map(([key, bucket]) => [key, stats(bucket.list)]))

const gaps = []
for (let i = 1; i < requests.length; i += 1) {
  const seconds = (requests[i].at - requests[i - 1].at) / 1000
  if (seconds > 120) gaps.push({ from: requests[i - 1].local, to: requests[i].local, seconds: Math.round(seconds) })
}

const engine = {
  window: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
  overall: stats(requests),
  buckets10min,
  gaps,
  fullInvalidations: requests.filter((row) => row.hit === 0 && row.prefill > 0).map(({ local, prompt, prefill, path }) => ({ local, prompt, prefill, path })),
  cancelled: requests.filter((row) => row.finish === 'cancelled').map(({ local, prompt, prefill, hit }) => ({ local, prompt, prefill, hit })),
}

// 可选：事件流体检（system 稳定性 / facts 快照 / turn 数）
let events = null
const eventsFile = arg('--events', null)
if (eventsFile) {
  const rows = fs.readFileSync(path.resolve(eventsFile), 'utf8').split('\n').filter(Boolean)
  let systemAppend = 0
  let systemReplace = 0
  const systemChars = new Set()
  let turns = 0
  let steps = 0
  let userMessages = 0
  let snapshots = 0
  let snapshotChars = 0
  let iclContextMessages = 0
  for (const line of rows) {
    let payload
    try { payload = JSON.parse(line) } catch { continue }
    payload = payload.payload ?? payload
    const event = payload.event ?? payload
    if (!event?.type) continue
    if (event.type === 'turn/start') turns += 1
    if (event.type === 'step/start') steps += 1
    if (event.type === 'system/message') {
      const text = (event.data?.message?.content ?? []).map((part) => part?.text ?? '').join('')
      systemChars.add(text.length)
      const op = event.surfaceOp
      if (op && typeof op === 'object' && op.op === 'replace') systemReplace += 1
      else systemAppend += 1
    }
    if (event.type === 'user/message') {
      const message = event.data?.message ?? event.data
      const text = (message?.content ?? []).map((part) => part?.text ?? '').join('')
      const kind = message?.source?.kind
      if (kind === 'runtime-context') { snapshots += 1; snapshotChars += text.length }
      else { userMessages += 1; if (kind === 'plugin:icl') iclContextMessages += 1 }
    }
  }
  events = {
    turns,
    steps,
    userMessages,
    iclContextMessages,
    systemAppend,
    systemReplace,
    distinctSystemChars: [...systemChars],
    factsSnapshots: snapshots,
    avgFactsSnapshotChars: snapshots ? Math.round(snapshotChars / snapshots) : null,
    snapshotsPerTurn: turns ? +(snapshots / turns).toFixed(2) : null,
  }
}

const out = { generatedAt: new Date().toISOString(), engine, events }
const outFile = arg('--out', null)
if (outFile) {
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true })
  fs.writeFileSync(path.resolve(outFile), JSON.stringify(out, null, 1), 'utf8')
}
console.log(JSON.stringify(out, null, 1))
if (outFile) console.error(`[cache-longrun] wrote ${outFile}`)
