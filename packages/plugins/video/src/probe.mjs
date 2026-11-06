// 只读容器头：ffprobe JSON → 摘要文本。不下载、不出图、不花图片 token。
import { runProcess } from './exec.mjs'
import { humanBytes } from './paths.mjs'

function parseRate(rate) {
  const text = String(rate ?? '')
  const [a, b] = text.split('/').map(Number)
  if (Number.isFinite(a) && Number.isFinite(b) && b > 0) return a / b
  const n = Number(text)
  return Number.isFinite(n) ? n : 0
}

/** @returns {Promise<{duration:number,width:number,height:number,fps:number,hasAudio:boolean,hasSubtitle:boolean,sizeBytes:number,codec:string}>} */
export async function probeVideo(file, { ffprobe = process.env.ICL_FFPROBE || 'ffprobe', timeoutMs = 45_000 } = {}) {
  const { stdout } = await runProcess(ffprobe, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ], { timeoutMs, code: 'E_PROBE', label: 'ffprobe' })
  let data
  try { data = JSON.parse(stdout) } catch {
    const error = new Error('ffprobe 返回的不是 JSON（文件可能不是视频）')
    error.code = 'E_NOT_VIDEO'
    throw error
  }
  const streams = Array.isArray(data.streams) ? data.streams : []
  const video = streams.find((s) => s.codec_type === 'video')
  if (!video) {
    const error = new Error('这个文件里没有视频流（可能只是音频/字幕/压缩包）')
    error.code = 'E_NOT_VIDEO'
    throw error
  }
  const format = data.format ?? {}
  return {
    duration: Number(format.duration ?? video.duration ?? 0) || 0,
    width: Number(video.width) || 0,
    height: Number(video.height) || 0,
    fps: parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate),
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
    hasSubtitle: streams.some((s) => s.codec_type === 'subtitle'),
    sizeBytes: Number(format.size) || 0,
    codec: String(video.codec_name ?? ''),
  }
}

export function formatProbe(info, { path = '', extra = [] } = {}) {
  const lines = [
    `视频：${path || '(无路径)'}`,
    `时长 ${info.duration.toFixed(2)}s · 画面 ${info.width}x${info.height} @ ${info.fps ? info.fps.toFixed(2) : '?'} fps · 编码 ${info.codec || '?'}`,
    `音轨 ${info.hasAudio ? '有' : '无'} · 字幕轨 ${info.hasSubtitle ? '有' : '无'} · 文件 ${humanBytes(info.sizeBytes)}`,
  ]
  for (const line of extra) if (line) lines.push(line)
  return lines.join('\n')
}
