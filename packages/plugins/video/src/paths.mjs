// 通用视频浏览器（ICL 的"眼睛"）的路径/输入约定。
//
// 这一层不碰网络：本地文件、目录、QQ 落盘路径、MC 录屏都走同一条路。
// 网络链接（B 站等）不在这里处理 —— 那是 bili 插件或 DSH 原生 video_storyboard 的事。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 目录扫描时认的视频扩展名（单文件不靠扩展名拦，交给 ffprobe 判定）。 */
export const VIDEO_EXTS = Object.freeze(new Set([
  '.mp4', '.mkv', '.mov', '.webm', '.avi', '.flv', '.ts', '.m4v', '.wmv', '.mpg', '.mpeg', '.ogv', '.3gp', '.gif',
]))

export const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024 * 1024
export const MAX_FRAME_TIMES = 6

/** 结构化失败：code 是稳定的机器码，message 给人看，next 是可执行的下一步。 */
export function videoError(code, message, next = '') {
  return { code, message, next }
}

export function errorText(error) {
  const head = `视频打不开（${error.code}）：${error.message}`
  return error.next ? `${head}\n下一步：${error.next}` : head
}

/** 网络地址不是本插件的输入（避免让人以为"通用入口"能下载任意 URL）。 */
export function isRemoteInput(raw) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(String(raw ?? '').trim())
    || /^www\./i.test(String(raw ?? '').trim())
}

/**
 * 规范化一个本地输入：去引号、转绝对路径、确认存在。
 * @returns {{ok:true, path:string, stat:fs.Stats} | {ok:false, error:ReturnType<typeof videoError>}}
 */
export function resolveLocalPath(raw) {
  const trimmed = String(raw ?? '').trim().replace(/^["']|["']$/g, '')
  if (!trimmed) {
    return { ok: false, error: videoError('E_ARGS', 'path 是必填项：给我一个本地视频文件的绝对路径（或包含视频的目录）。', '例如 /home/me/Movies/clip.mp4；Windows 例 C:\\\\videos\\\\clip.mp4') }
  }
  if (isRemoteInput(trimmed)) {
    return {
      ok: false,
      error: videoError(
        'E_REMOTE_URL',
        '通用视频入口只认本地文件/目录；网络链接不会在这里下载。',
        'B 站视频用 bili_* 工具；其他网络视频（或 B 站切帧兜底）用 DSH 原生的 video_storyboard/video_zoom。',
      ),
    }
  }
  const abs = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(trimmed)
  let stat
  try {
    stat = fs.statSync(abs)
  } catch {
    return { ok: false, error: videoError('E_NOT_FOUND', `路径不存在：${abs}`, '确认路径；QQ 落盘的文件要先等下载完成再调用。') }
  }
  return { ok: true, path: abs, stat }
}

/** 列目录里的视频文件（按修改时间新→旧）。 */
export function listVideos(dir, { limit = 20 } = {}) {
  let names
  try {
    names = fs.readdirSync(dir)
  } catch (error) {
    return { ok: false, error: videoError('E_NOT_READABLE', `目录读不了：${dir}（${String(error?.message ?? error)}）`, '检查权限。') }
  }
  const rows = []
  for (const name of names) {
    const full = path.join(dir, name)
    try {
      const st = fs.statSync(full)
      if (!st.isFile()) continue
      if (!VIDEO_EXTS.has(path.extname(name).toLowerCase())) continue
      rows.push({ name, path: full, bytes: st.size, mtimeMs: st.mtimeMs })
    } catch { /* 单个文件坏了就跳过 */ }
  }
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return { ok: true, rows: rows.slice(0, Math.max(1, limit)), total: rows.length }
}

/** 建本次调用的临时工作目录（图片在工具返回后还要被 attachment 读取，所以不立刻删）。 */
export function makeWorkDir(stateDir, tag = 'video') {
  const root = path.join(stateDir || path.join(os.tmpdir(), 'icl-video'), 'work')
  try { fs.mkdirSync(root, { recursive: true }) } catch { /* 用不了就退回系统临时目录 */ }
  const base = (() => {
    try { return fs.mkdtempSync(path.join(root, `${tag}-`)) } catch { return fs.mkdtempSync(path.join(os.tmpdir(), `icl-${tag}-`)) }
  })()
  return base
}

/** 太旧的临时产物清掉（避免长测把磁盘塞满）。 */
export function pruneWorkDirs(stateDir, { maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
  const root = path.join(stateDir || '', 'work')
  let entries
  try { entries = fs.readdirSync(root) } catch { return 0 }
  const now = Date.now()
  let removed = 0
  for (const name of entries) {
    const full = path.join(root, name)
    try {
      const st = fs.statSync(full)
      if (st.isDirectory() && now - st.mtimeMs > maxAgeMs) {
        fs.rmSync(full, { recursive: true, force: true })
        removed += 1
      }
    } catch { /* 清不掉就下次再清 */ }
  }
  return removed
}

/** 人类可读的文件大小（文本摘要用，不进模型正文的字节）。 */
export function humanBytes(bytes) {
  const n = Number(bytes) || 0
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}
