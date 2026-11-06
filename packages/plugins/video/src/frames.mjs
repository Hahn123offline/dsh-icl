// 精确时间点的单帧/多帧查看。
//
// 与 video_storyboard 的分工：
//   storyboard = "这段时间大概发生了什么"（自动挑帧、拼宫格、给时间线）
//   frames     = "第 37.5 秒那一帧到底是什么"（精确 seek，最多 6 帧拼一张）
// 图仍然只写文件、由桥接层提交成 attachment；这一层不碰模型上下文。
import fs from 'node:fs'
import path from 'node:path'
import { runProcess } from './exec.mjs'
import { MAX_FRAME_TIMES } from './paths.mjs'

function cleanTimes(times) {
  const list = (Array.isArray(times) ? times : [times])
    .map((t) => Number(t))
    .filter((t) => Number.isFinite(t) && t >= 0)
  const unique = [...new Set(list.map((t) => Math.round(t * 1000) / 1000))]
  unique.sort((a, b) => a - b)
  return unique.slice(0, MAX_FRAME_TIMES)
}

/**
 * 抽帧；多帧拼成一张图（tile），避免 N 张图 × 384 token。
 * @returns {Promise<{frames:string[], sheet:string|null, times:number[]}>}
 */
export async function extractFrames({
  input,
  times,
  workDir,
  ffmpeg = process.env.ICL_FFMPEG || 'ffmpeg',
  timeoutMs = 120_000,
  ffprobeDuration = 0,
}) {
  const wanted = cleanTimes(times)
  if (!wanted.length) throw Object.assign(new Error('times 至少给一个秒数'), { code: 'E_ARGS' })
  const frames = []
  for (const [index, at] of wanted.entries()) {
    const target = path.join(workDir, `frame-${index + 1}.png`)
    await runProcess(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', String(at), '-i', input,
      '-frames:v', '1',
      '-vf', "scale='min(1280,iw)':-2",
      target,
    ], { timeoutMs, code: 'E_FFMPEG', label: 'ffmpeg 抽帧' })
    if (!fs.existsSync(target)) throw Object.assign(new Error(`第 ${at}s 没抽到帧（超出片长？）`), { code: 'E_FRAME' })
    frames.push(target)
  }
  if (frames.length === 1) return { frames, sheet: null, times: wanted }

  const cols = Math.min(3, frames.length)
  const rows = Math.ceil(frames.length / cols)
  const sheet = path.join(workDir, 'frames.png')
  await runProcess(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', path.join(workDir, 'frame-%d.png'),
    '-vf', `scale=-2:360,tile=${cols}x${rows}`,
    '-frames:v', '1',
    sheet,
  ], { timeoutMs, code: 'E_FFMPEG', label: 'ffmpeg 拼帧' })
  return { frames, sheet: fs.existsSync(sheet) ? sheet : frames[0], times: wanted }
}
