#!/usr/bin/env node
// B 站接缝体检 —— **仅评估用**，不是产品代码，不被任何运行时路径 import。
//
// 它做两件事：
//   1. 检查本机接缝的 4 条绝对路径（python / bili-run.py / bili-duty 家目录 / storyboard CLI）；
//   2. 用真实的 `createHost()` 装一遍 `packages/plugins/bili`，**只调只读工具**（search / watch /
//      comments / frames），记录耗时与结果形状。不发布、不互动、不写任何 B 站数据。
//
// 用法：
//   node tools/bili-eval.mjs                          # 路径检查 + 3 个文字工具（真网络）
//   node tools/bili-eval.mjs --offline                # 只检查路径，不联网
//   node tools/bili-eval.mjs --credential             # 额外验证本地登录态（只打印脱敏结果）
//   node tools/bili-eval.mjs --frames BV1dC4y117Rz --from 0 --to 10 --cells 4
//       # 额外跑一次宫格图（会下载视频、调 ffmpeg；**耗时不低**，默认不跑）
//
// 退出码：0 = 所有检查通过；1 = 有失败项（失败项会写清楚是哪一条）。
import fs from 'node:fs'
import path from 'node:path'
import { createHost } from '../packages/core/src/index.mjs'
import * as bili from '../packages/plugins/bili/src/index.mjs'
import biliManifest from '../packages/plugins/bili/manifest.json' with { type: 'json' }

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const opt = (name, fallback = null) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}

const PY = process.env.BILI_PYTHON ?? 'C:\\Users\\ai_admin\\.dsh\\bili-duty\\.venv\\Scripts\\python.exe'
const ROOT = process.env.ICL_ROOT ?? 'C:/DSH/qwenstuff/icl'
const RUNNER = process.env.BILI_RUNNER ?? path.join(ROOT, 'tools', 'bili-run.py')
const BILI_DIR = process.env.BILI_DIR ?? 'C:\\Users\\ai_admin\\.dsh\\bili-duty'
const STORYBOARD_CLI = process.env.STORYBOARD_CLI
  ?? 'C:\\Users\\ai_admin\\.dsh\\profiles\\desktop\\node_modules\\dsh-video-storyboard\\bin\\storyboard.mjs'
const CRED = path.join(BILI_DIR, 'bili_credential.json')

const checks = []
const record = (name, ok, detail) => {
  checks.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`)
}

function fileCheck(name, file, kind = 'file') {
  let ok = false
  let detail = file
  try {
    const st = fs.statSync(file)
    ok = kind === 'dir' ? st.isDirectory() : st.isFile()
    detail = `${file}  (${st.size} B)`
  } catch { /* 缺就是缺 */ }
  record(name, ok, detail)
  return ok
}

function masked(value) {
  const s = String(value ?? '')
  return s.length <= 4 ? '***' : `***${s.slice(-4)}`
}

console.log('== 接缝路径 ==')
const depsReady = [
  fileCheck('python 解释器（BILI_PYTHON）', PY),
  fileCheck('桥接脚本（BILI_RUNNER）', RUNNER),
  fileCheck('bili-duty 家目录（BILI_DIR）', BILI_DIR, 'dir'),
  fileCheck('storyboard CLI（STORYBOARD_CLI）', STORYBOARD_CLI),
].every(Boolean)

// 登录态：只报存在与大小，绝不打印内容（cookie / token 不出现在任何输出里）。
let credOk = false
try {
  const st = fs.statSync(CRED)
  credOk = st.size > 0
  record('本地凭证文件存在（bili_credential.json）', credOk, `${st.size} B（内容不打印）`)
} catch {
  record('本地凭证文件存在（bili_credential.json）', false, '缺：MCP 会报「未登录」')
}

if (flag('--offline')) {
  const failed = checks.filter((c) => !c.ok)
  console.log(`\n离线检查：${checks.length - failed.length}/${checks.length} 通过`)
  process.exit(failed.length ? 1 : 0)
}

const host = createHost({ log: () => {} })
host.registerPlugin(biliManifest, bili, {})
await host.enable('bili')
const tools = new Map(host.services.tools.list().map((t) => [t.name, t]))

console.log('\n== 工具面 ==')
const names = [...tools.keys()].sort()
record('注册的工具', true, names.join(', '))
record('只有只读工具（无 reply / upload / send）', !names.some((n) => /reply|upload|send|dynamic/i.test(n)))

const call = async (name, args) => {
  const t0 = Date.now()
  const out = await tools.get(name).execute(args)
  return { text: String(out?.text ?? ''), imagePath: out?.imagePath ?? null, ms: Date.now() - t0 }
}

if (!depsReady) {
  console.log('\n路径不齐 —— 跳过联网测试（先用环境变量补齐上面 ✗ 的项）')
  process.exit(1)
}

// ① 搜索（只读）
let bvid = 'BV1L7xm64EHP'
try {
  const r = await call('bili_search', { keyword: 'DeepSeek Harness', num: 3 })
  let count = null
  try { count = JSON.parse(r.text).count } catch { /* 非 JSON 也接受 */ }
  record('bili_search 真网络', r.text.length > 20, `${r.ms}ms, ${r.text.length} 字, count=${count}`)
  try {
    const first = JSON.parse(r.text)?.videos?.find((v) => v?.bvid)
    if (first?.bvid) bvid = first.bvid
  } catch { /* 保持默认 */ }
} catch (error) {
  record('bili_search 真网络', false, String(error?.message ?? error))
}

// ② 看视频（信息 + 字幕，只读）
try {
  const r = await call('bili_watch', { target: bvid })
  record('bili_watch 真网络', r.text.length > 20 && !r.text.startsWith('打不开'), `${bvid}, ${r.ms}ms, ${r.text.length} 字`)
} catch (error) {
  record('bili_watch 真网络', false, String(error?.message ?? error))
}

// ③ 评论（只读）
try {
  const r = await call('bili_comments', { target: bvid, num: 3 })
  record('bili_comments 真网络', r.text.length > 20 && !r.text.startsWith('读不到'), `${bvid}, ${r.ms}ms, ${r.text.length} 字`)
} catch (error) {
  record('bili_comments 真网络', false, String(error?.message ?? error))
}

// ④ 登录态（只读接口；只打印脱敏后的结果）
if (flag('--credential')) {
  try {
    const { execFileSync } = await import('node:child_process')
    const raw = execFileSync(PY, [RUNNER, 'bili_check_credential', '{}'], {
      timeout: 60_000, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8', BILI_DIR },
    })
    const data = JSON.parse(String(raw).trim())
    record('B 站登录态（bili_check_credential）', Boolean(data?.logged_in),
      `logged_in=${Boolean(data?.logged_in)}, uid=${masked(data?.uid)}`)
  } catch (error) {
    record('B 站登录态（bili_check_credential）', false, String(error?.message ?? error).slice(0, 160))
  }
}

// ⑤ 宫格图（可选；会下载视频、调 ffmpeg，所以默认不跑）
const framesTarget = opt('--frames')
if (framesTarget) {
  try {
    const r = await call('bili_frames', {
      target: framesTarget,
      from: Number(opt('--from', 0)),
      to: Number(opt('--to', 10)),
      cells: Number(opt('--cells', 4)),
    })
    const size = r.imagePath && fs.existsSync(r.imagePath) ? fs.statSync(r.imagePath).size : 0
    record('bili_frames 端到端', size > 0, `${r.ms}ms, sheet=${size} B, ${r.imagePath ?? '(无路径)'}`)
    if (r.text) console.log(`  └ ${r.text.split('\n').slice(0, 3).join(' / ')}`)
  } catch (error) {
    record('bili_frames 端到端', false, String(error?.message ?? error))
  }
}

const failed = checks.filter((c) => !c.ok)
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`)
if (failed.length) console.log(`失败：${failed.map((c) => c.name).join('；')}`)
process.exit(failed.length ? 1 : 0)
