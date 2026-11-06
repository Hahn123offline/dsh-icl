// 扫码登录 / 续期：只写 ICL 自己的凭证文件，不碰 B 站账号的写接口。
//
// 协议（2026-10 旧插件实测通过的同一套；这里按公开接口重写）：
//   ① GET  /x/passport-login/web/qrcode/generate?source=main-fe-header → data.url + data.qrcode_key
//   ② 手机扫 → 轮询 /x/passport-login/web/qrcode/poll?qrcode_key=…
//      code: 86101 未扫 / 86090 已扫待确认 / 0 成功 / 86038 过期
//   ③ 凭证在成功响应的 Set-Cookie 头里（不是 data.url）
//   ④ 写 MCP 认的四个字段：sessdata / bili_jct / buvid3 / dedeuserid
//
// 旧 B 站可能没有 buvid3；用 /x/frontend/finger/spi 补一张指纹（非致命）。
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const GEN = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header'
const SPI = 'https://api.bilibili.com/x/frontend/finger/spi'
const pollUrl = (key) => 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=' + encodeURIComponent(key) + '&source=main-fe-header'

export async function loginStart({ fetchImpl }) {
  const response = await fetchImpl(GEN, { headers: { 'User-Agent': UA } })
  const body = await response.json()
  const data = body?.data
  if (!data?.qrcode_key || !data?.url) {
    const error = new Error(`生成二维码失败：${body?.message || '返回里没有 qrcode_key'}`)
    error.code = 'E_LOGIN'
    throw error
  }
  return { key: data.qrcode_key, url: data.url }
}

export async function loginPoll(key, { fetchImpl }) {
  const response = await fetchImpl(pollUrl(key), { headers: { 'User-Agent': UA }, redirect: 'manual' })
  const setCookies = typeof response.headers?.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  let body = {}
  try { body = await response.json() } catch { /* poll 有时返回空体 */ }
  const code = body?.data?.code
  if (code === 0) {
    const jar = await ensureBuvid3(pickCookies(setCookies), fetchImpl)
    if (!jar.sessdata) {
      return { state: 'unknown', code, message: '登录成功但响应里没有 SESSDATA —— 记下这次结果再排查' }
    }
    return { state: 'ok', code, credential: jar }
  }
  const map = { 86101: 'waiting', 86090: 'scanned', 86038: 'expired' }
  return { state: map[code] ?? 'unknown', code, message: body?.message || '' }
}

function pickCookies(list) {
  const jar = {}
  const want = { SESSDATA: 'sessdata', bili_jct: 'bili_jct', DedeUserID: 'dedeuserid', buvid3: 'buvid3' }
  for (const raw of list ?? []) {
    const first = String(raw).split(';')[0] || ''
    const at = first.indexOf('=')
    if (at <= 0) continue
    const name = first.slice(0, at).trim()
    const value = first.slice(at + 1).trim()
    if (want[name]) jar[want[name]] = value
  }
  return jar
}

async function ensureBuvid3(jar, fetchImpl) {
  if (jar.buvid3) return jar
  try {
    const response = await fetchImpl(SPI, { headers: { 'User-Agent': UA } })
    const body = await response.json()
    const value = body?.data?.b_3
    if (value) jar.buvid3 = value
  } catch { /* 拿不到就算了 */ }
  return jar
}

/** 原子写：先写 .tmp 再 rename；绝不整段覆盖到一半。 */
export function saveCredential(file, credential) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const payload = JSON.stringify({
    sessdata: credential.sessdata ?? '',
    bili_jct: credential.bili_jct ?? '',
    buvid3: credential.buvid3 ?? '',
    dedeuserid: credential.dedeuserid ?? '',
  }, null, 2)
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, payload, 'utf8')
  fs.renameSync(tmp, file)
  return file
}

/** 画二维码 PNG（用执行环境的 python 的 qrcode）；没有就返回 null，工具仍给 URL。 */
export function renderQrPng({ pythonPath, url, outFile, timeoutMs = 20_000 }) {
  return new Promise((resolve) => {
    const code = 'import sys, qrcode; qrcode.make(sys.argv[1]).save(sys.argv[2])'
    let child
    try {
      child = spawn(pythonPath, ['-c', code, url, outFile], { windowsHide: true, stdio: 'ignore' })
    } catch {
      resolve(null)
      return
    }
    const timer = setTimeout(() => { try { child.kill() } catch { /* 已退出 */ } }, timeoutMs)
    child.on('error', () => { clearTimeout(timer); resolve(null) })
    child.on('exit', (exitCode) => {
      clearTimeout(timer)
      try { resolve(exitCode === 0 && fs.existsSync(outFile) ? outFile : null) } catch { resolve(null) }
    })
  })
}

/** 从 SESSDATA 里读到期时间（不打印值）；解析不了返回 null。 */
export function credentialExpiry(credential) {
  try {
    const decoded = decodeURIComponent(String(credential?.sessdata ?? ''))
    const parts = decoded.split(',')
    if (parts.length < 2 || !/^\d{9,11}$/.test(parts[1])) return null
    return Number(parts[1]) * 1000
  } catch {
    return null
  }
}

export { UA }
