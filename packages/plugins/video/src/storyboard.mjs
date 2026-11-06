// dsh-video-storyboard 的 CLI 包装。
//
// 为什么不重写：那套分镜/切点/取帧算法已经在它自己的仓库里被真实素材打过脸
// （见它对 HSV 切点、Laplacian 选帧、密度分格的说明）。ICL 这一层只做：
//   参数校验 → 调 CLI → 把「图 + 可寻址文本」变成工具结果。
// 依赖面：node >= 20、ffmpeg/ffprobe 在 PATH、storyboard CLI 可执行（默认取 desktop 安装）。
import fs from 'node:fs'
import path from 'node:path'
import { runProcess } from './exec.mjs'
import { dshHome } from '../../../core/src/icl-paths.mjs'

/** 默认 CLI 位置从 DSH_HOME 推（换机/换用户名不用改代码）；ICL_STORYBOARD_CLI 仍可覆盖。 */
export function defaultStoryboardCli(env = process.env) {
  return path.join(dshHome(env), 'profiles', 'desktop', 'node_modules', 'dsh-video-storyboard', 'bin', 'storyboard.mjs')
}

export function resolveStoryboardCli(value) {
  const cli = String(value || process.env.ICL_STORYBOARD_CLI || defaultStoryboardCli())
  try {
    if (fs.statSync(cli).isFile()) return cli
  } catch { /* 下面给出可操作错误 */ }
  return null
}

const TC = (t) => {
  const n = Math.max(0, Number(t) || 0)
  const m = Math.floor(n / 60)
  return `${String(m).padStart(2, '0')}:${(n % 60).toFixed(2).padStart(5, '0')}`
}

/** 从 CLI stdout 里取出 `--text` 打印的清单块（从 <storyboard 开始）。 */
export function extractTextBlock(stdout, { maxChars = 8000 } = {}) {
  const text = String(stdout ?? '')
  const at = text.indexOf('<storyboard')
  if (at < 0) return ''
  let block = text.slice(at).trim()
  if (block.length > maxChars) block = `${block.slice(0, maxChars - 80).trimEnd()}\n…（清单截断；需要后续格用 cellRange/textOnly 再读）`
  return block
}

/** 解析清单块里的 cell 行 → [{i, from, to, text}]。locate 与摘要共用。 */
export function parseCells(textBlock) {
  const lines = String(textBlock ?? '').split(/\r?\n/)
  const cells = []
  let current = null
  for (const line of lines) {
    const m = /^cell\s+(\d+)(?:\s+\(r\d+c\d+\))?\s*=\s*(\d{2}):(\d{2}\.\d{2})-(\d{2}):(\d{2}\.\d{2})/.exec(line)
    if (m) {
      current = {
        i: Number(m[1]),
        from: Number(m[2]) * 60 + Number(m[3]),
        to: Number(m[4]) * 60 + Number(m[5]),
        text: [],
      }
      cells.push(current)
      continue
    }
    if (!current) continue
    // 台词行在清单里是缩进的（不同版本可能是 4 空格 + 引号）；元数据行不缩进。
    const t = /^\s{2,}(.+)$/.exec(line)
    if (t) current.text.push(t[1].replace(/^["“]|["”]$/g, '').trim())
  }
  return cells.map((c) => ({ ...c, text: c.text.filter(Boolean).join(' ') }))
}

/**
 * 跑一次分镜。
 * @returns {Promise<{sheets:string[], textBlock:string, manifest:object|null, stderr:string}>}
 */
export async function runStoryboard({
  input,
  from = 0,
  to = 0,
  cells = 0,
  sheets = 0,
  detail = 'med',
  pick = 'sharp',
  minGap = 1.2,
  transcript = 'auto',
  transcriptFile = null,
  textOnly = false,
  adaptive = true,
  cli,
  workDir,
  timeoutMs = 15 * 60 * 1000,
  maxTextChars = 8000,
  ffmpeg = process.env.ICL_FFMPEG || undefined,
}) {
  const outPng = path.join(workDir, 'sheet.png')
  const manifestPath = path.join(workDir, 'manifest.json')
  const args = [
    cli, input,
    '--cells', String(Math.min(16, Math.max(0, Number(cells) || 0))),
    '--from', String(Math.max(0, Number(from) || 0)),
    '--to', String(Math.max(0, Number(to) || 0)),
    '--sheets', String(Math.min(4, Math.max(0, Number(sheets) || 0))),
    '--pick', String(pick || 'sharp'),
    '--burn', 'index',
    '--min-gap', String(Number.isFinite(Number(minGap)) ? Number(minGap) : 1.2),
    '--transcript', String(transcript || 'auto'),
    '--detail', String(detail || 'med'),
    '--out', outPng,
    '--manifest', manifestPath,
    '--text',
  ]
  if (textOnly) args.push('--text-only')
  if (adaptive === false) args.push('--no-adaptive')
  if (transcriptFile) args.push('--transcript-file', String(transcriptFile))
  const env = { ...process.env }
  if (ffmpeg) env.ICL_FFMPEG = ffmpeg

  const { stdout, stderr } = await runProcess(process.execPath, args, {
    timeoutMs, code: 'E_STORYBOARD', label: 'storyboard CLI', env, maxBuffer: 64 * 1024 * 1024,
  })
  const textBlock = extractTextBlock(stdout, { maxChars: maxTextChars })
  let manifest = null
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) } catch { /* 没 manifest 也能给文本 */ }
  const sheetsOut = []
  try {
    const names = fs.readdirSync(workDir).filter((n) => /\.png$/i.test(n) && n.startsWith('sheet')).sort()
    for (const name of names) sheetsOut.push(path.join(workDir, name))
  } catch { /* 空目录 */ }
  return { sheets: sheetsOut, textBlock, manifest, stderr }
}

/** 只读文本定位：不渲染图，仍然走同一条 CLI（复用已有转写缓存）。 */
export async function locateInTranscript({ input, query, from = 0, to = 0, max = 5, transcriptFile = null, cli, workDir, timeoutMs = 15 * 60 * 1000 }) {
  const { textBlock } = await runStoryboard({
    input, from, to, cells: 1, detail: 'high', transcriptFile, textOnly: true,
    cli, workDir, timeoutMs, maxTextChars: 60_000,
  })
  const q = String(query ?? '').trim()
  if (!q) return { ok: false, reason: 'E_ARGS', textBlock }
  const cells = parseCells(textBlock)
  const hasSpeech = /transcript="(?!asr-empty|subtitle-empty|none)[^"]+"/.test(textBlock)
  if (!hasSpeech || !cells.some((c) => c.text)) {
    return { ok: false, reason: 'E_NO_TRANSCRIPT', textBlock }
  }
  const needle = q.toLowerCase()
  const scored = []
  for (const cell of cells) {
    const hay = cell.text.toLowerCase()
    if (!hay) continue
    const at = hay.indexOf(needle)
    if (at < 0) continue
    const start = Math.max(0, at - 30)
    scored.push({
      i: cell.i,
      from: cell.from,
      to: cell.to,
      score: needle.length,
      quote: cell.text.slice(start, Math.min(cell.text.length, at + needle.length + 50)).trim(),
    })
  }
  scored.sort((a, b) => b.score - a.score || a.from - b.from)
  return { ok: true, matches: scored.slice(0, Math.max(1, Number(max) || 5)), total: scored.length, cells: cells.length }
}

export { TC }
