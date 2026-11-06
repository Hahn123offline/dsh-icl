#!/usr/bin/env node
// B 站接缝体检 —— **仅评估用**，不是产品代码，不被任何运行时路径 import。
//
// 它做三件事：
//   1. 检查 ICL 自持接缝的路径（python / 只读桥 / vendored MCP / storyboard CLI）；
//   2. 用真实的 `createHost()` 装一遍 `packages/plugins/bili`（临时 stateDir，会做一次凭证复制），
//      只调只读工具（search / feed / watch / comments / frames），不发布、不互动、不写 B 站数据；
//   3. 打印凭证到期时间（只解析 SESSDATA 内嵌时间戳，不打印任何 cookie/token 值）。
//
// 用法：
//   node tools/bili-eval.mjs                    # 路径 + 工具面 + 3 个只读接口（真网络）
//   node tools/bili-eval.mjs --offline          # 只检查路径/工具面，不联网
//   node tools/bili-eval.mjs --credential       # 额外验证登录态与到期时间
//   node tools/bili-eval.mjs --frames BV1dC4y117Rz --from 0 --to 10 --cells 4
//
// 退出码：0 = 全部通过；1 = 有失败项。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../packages/core/src/index.mjs'
import * as bili from '../packages/plugins/bili/src/index.mjs'
import biliManifest from '../packages/plugins/bili/manifest.json' with { type: 'json' }
import { credentialExpiry } from '../packages/plugins/bili/src/login.mjs'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const opt = (name, fallback = null) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}

const REPO = path.resolve(import.meta.dirname, '..')
const LEGACY = process.env.BILI_DIR ?? path.join(os.homedir(), '.dsh', 'bili-duty')
const PY = process.env.BILI_PYTHON ?? path.join(LEGACY, '.venv', 'Scripts', 'python.exe')
const RUNNER = process.env.BILI_RUNNER ?? path.join(REPO, 'tools', 'bili-run.py')
const VENDOR = process.env.BILI_VENDOR ?? path.join(REPO, 'packages', 'plugins', 'bili', 'vendor', 'bilibili-mcp')
const STORYBOARD_CLI = process.env.STORYBOARD_CLI ?? 'C:\\Users\\ai_admin\\.dsh\\profiles\\desktop\\node_modules\\dsh-video-storyboard\\bin\\storyboard.mjs'
const STATE = process.env.ICL_BILI_STATE ?? fs.mkdtempSync(path.join(os.tmpdir(), 'icl-bili-eval-'))

const checks = []
const record = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`)
}
const fileCheck = (name, file) => {
  let ok = false
  let detail = file
  try { const st = fs.statSync(file); ok = st.isFile(); detail = `${file} (${st.size} B)` } catch { /* 缺 */ }
  record(name, ok, detail)
  return ok
}

console.log('== 接缝路径（ICL 自持） ==')
const pathsOk = [
  fileCheck('python 解释器（BILI_PYTHON）', PY),
  fileCheck('只读桥（BILI_RUNNER → tools/bili-run.py）', RUNNER),
  fileCheck('vendored MCP（repo）', path.join(VENDOR, 'mcp_server.py')),
  fileCheck('storyboard CLI（STORYBOARD_CLI）', STORYBOARD_CLI),
].every(Boolean)
const legacyCred = path.join(LEGACY, 'bili_credential.json')
try {
  const st = fs.statSync(legacyCred)
  record('旧凭证可迁移（只检查存在，不读内容）', st.isFile() && st.size > 0, `${st.size} B`)
} catch {
  record('旧凭证可迁移（只检查存在，不读内容）', fs.existsSync(path.join(STATE, 'bili', 'bili_credential.json')), '旧家目录没有；如果 ICL stateDir 已有凭证则 OK')
}

const host = createHost({ log: () => {} })
host.registerPlugin(biliManifest, bili, {
  config: {
    stateDir: STATE, legacyBiliDir: LEGACY,
    pythonPath: PY, runnerPath: RUNNER, vendorDir: VENDOR, storyboardCli: STORYBOARD_CLI,
  },
})
await host.enable('bili')
const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))

console.log('\n== 工具面 ==')
const names = Object.keys(tools).sort()
record('注册的工具', true, names.join(', '))
record('只读（无 reply / send / upload / dynamic / favorite）', !names.some((n) => /reply|send|upload|dynamic|favorite/i.test(n)))
record('bili_feed 存在（热门/排行/每周/热词）', Boolean(tools.bili_feed))

// 凭证到期（只解析时间戳，不打印值）
try {
  const raw = JSON.parse(fs.readFileSync(path.join(STATE, 'bili', 'bili_credential.json'), 'utf8'))
  const expires = credentialExpiry(raw)
  if (expires) {
    const days = Math.round((expires - Date.now()) / 86_400_000)
    record('SESSDATA 到期时间可读', days > 0, `${new Date(expires).toISOString().slice(0, 10)}（${days} 天）`)
  } else {
    record('SESSDATA 到期时间可读', false, '解析不了（格式可能变了）')
  }
} catch (error) {
  record('SESSDATA 到期时间可读', false, String(error?.message ?? error))
}

if (flag('--offline')) {
  const failed = checks.filter((c) => !c.ok)
  console.log(`\n离线检查：${checks.length - failed.length}/${checks.length} 通过`)
  process.exit(failed.length ? 1 : 0)
}
if (!pathsOk) {
  console.log('\n路径不齐 —— 跳过联网测试（先补齐上面 ✗ 的项）')
  process.exit(1)
}

const call = async (name, args) => {
  const t0 = Date.now()
  const out = await tools[name].execute(args)
  const text = String(out?.text ?? '')
  return { text, images: out?.images ?? [], ms: Date.now() - t0 }
}
const first = (text) => text.split('\n')[0].slice(0, 120)

// ① 搜索
try {
  const r = await call('bili_search', { keyword: 'DeepSeek Harness', num: 3 })
  record('bili_search', r.text.includes('BV') && !/E_/.test(first(r.text)), `${r.ms}ms：${first(r.text)}`)
} catch (error) { record('bili_search', false, String(error?.message ?? error)) }

// ② feed（热门）
try {
  const r = await call('bili_feed', { kind: 'hot', num: 3 })
  record('bili_feed kind=hot', /热门|BV/.test(r.text), `${r.ms}ms：${first(r.text)}`)
} catch (error) { record('bili_feed', false, String(error?.message ?? error)) }

// ③/④ watch + comments（凭证有效才可能过；失败时打印可操作错误）
const BVID = 'BV1L7xm64EHP'
try {
  const r = await call('bili_watch', { target: BVID })
  record('bili_watch', /BV1L7xm64EHP/.test(r.text) && !/E_AUTH/.test(r.text), `${r.ms}ms：${first(r.text)}`)
} catch (error) { record('bili_watch', false, String(error?.message ?? error)) }
try {
  const r = await call('bili_comments', { target: BVID, num: 3 })
  record('bili_comments', r.text.length > 20 && !/E_AUTH/.test(r.text), `${r.ms}ms：${first(r.text)}`)
} catch (error) { record('bili_comments', false, String(error?.message ?? error)) }

// ⑤ 切帧（可选）
const framesTarget = opt('--frames')
if (framesTarget) {
  try {
    const r = await call('bili_frames', {
      target: framesTarget, from: Number(opt('--from', 0)), to: Number(opt('--to', 10)), cells: Number(opt('--cells', 4)),
    })
    const size = r.images[0] ? fs.statSync(r.images[0]).size : 0
    record('bili_frames', size > 0, `${r.ms}ms, sheet=${size} B`)
  } catch (error) { record('bili_frames', false, String(error?.message ?? error)) }
}

const failed = checks.filter((c) => !c.ok)
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过（stateDir=${STATE}）`)
if (failed.length) console.log(`失败：${failed.map((c) => c.name).join('；')}`)
process.exit(failed.length ? 1 : 0)
