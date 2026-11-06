#!/usr/bin/env node
// B 站 Python 环境的迁移/自检 —— 把解释器从旧插件家目录搬到 ICL stateDir。
//
// 背景：代码（repo vendor）、凭证（<stateDir>/bili/bili_credential.json）已经归 ICL；
// 只剩 Python 解释器默认还是旧插件的 `.venv`（`BILI_PYTHON` 可覆盖）。
// 这个脚本只碰 ICL 自己的目录，不写 B 站、不联网（--create 时才 pip install）。
//
// 用法：
//   node tools/bili-venv.mjs --check          # 看当前解析到哪、缺什么（默认）
//   node tools/bili-venv.mjs --create         # 在 <stateDir>/bili/.venv 建环境并装依赖
//   node tools/bili-venv.mjs --create --python C:\Python312\python.exe
//
// 说明：venv 不可重定位，所以是"新建 + 重装依赖"，不是 move。装完重启 ICL 会话即生效。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { iclPaths } from '../packages/core/src/icl-paths.mjs'
import { resolveConfig, venvPython } from '../packages/plugins/bili/src/runtime.mjs'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const opt = (name, fallback = null) => {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : fallback
}
const REPO = path.resolve(import.meta.dirname, '..')
const requirements = path.join(REPO, 'packages', 'plugins', 'bili', 'vendor', 'bilibili-mcp', 'requirements.txt')

const paths = iclPaths()
// 只用路径解析；不启动插件、不读写 B 站。
const cfg = resolveConfig({ config: { stateDir: paths.stateDir, legacyBiliDir: process.env.BILI_DIR } })

function line(label, value) {
  console.log(`${label.padEnd(18)} ${value}`)
}
function ok(file) {
  try { return fs.statSync(file).isFile() } catch { return false }
}

console.log('== ICL 路径 ==')
line('ICL_ROOT', paths.root)
line('stateDir', paths.stateDir)
line('bili 目录', cfg.biliDir)
line('凭证', cfg.credentialFile)
line('vendored MCP', path.join(cfg.vendorDir, 'mcp_server.py'))

console.log('\n== Python ==')
line('ICL venv', cfg.ownVenvDir)
line('ICL python', `${cfg.ownPython}${ok(cfg.ownPython) ? ' ✓' : ' ✗（还没建）'}`)
line('旧 venv（兼容）', `${cfg.legacyPython}${ok(cfg.legacyPython) ? ' ✓' : ' ✗'}`)
line('当前解析', `${cfg.pythonPath}（来源 ${cfg.pythonSource}）`)

const ready = cfg.pythonSource !== 'missing'
if (!ready) {
  console.log('\n结论：没有可用的 Python。下一步：')
  console.log(`  node tools/bili-venv.mjs --create --python <3.10+ 的 python 路径>`)
  console.log('  装完重启 ICL 会话；或临时用 BILI_PYTHON 指向任意装了 bilibili-api-python 的 python。')
} else if (cfg.pythonSource === 'legacy-compat') {
  console.log('\n结论：当前**回退**用旧插件 venv；建议迁移到 ICL 自己家：')
  console.log('  node tools/bili-venv.mjs --create')
  console.log('  迁移后默认解析会变成 <stateDir>/bili/.venv（旧 venv 保留，不删）。')
} else {
  console.log('\n结论：解释器已在 ICL 自己的目录（或显式指定），无需迁移。')
}

if (!flag('--create')) process.exit(ready ? 0 : 1)

// ── 新建 venv + 装依赖（会联网；仅写 ICL stateDir） ────────────────────────

/** venv 里是否已经有 4 个依赖（bilibili_api / mcp / qrcode；aiohttp 随 bilibili-api 装）。 */
function depsReady(venvDir) {
  const candidates = process.platform === 'win32'
    ? [path.join(venvDir, 'Lib', 'site-packages')]
    : [path.join(venvDir, 'lib', 'python3.12', 'site-packages'), path.join(venvDir, 'lib', 'python3.11', 'site-packages'), path.join(venvDir, 'lib', 'python3.10', 'site-packages')]
  const site = candidates.find((dir) => fs.existsSync(dir))
  if (!site) return false
  return ['bilibili_api', 'mcp', 'qrcode'].every((name) => fs.existsSync(path.join(site, name)))
}

/** 找 uv（旧插件家目录那份、PATH、UV_PATH 都可以）；没有就用 pip。 */
function findUv() {
  const candidates = [process.env.UV_PATH, path.join(os.homedir(), '.dsh', 'bili-duty', 'bin', 'uv.exe'), 'uv']
  for (const candidate of candidates.filter(Boolean)) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' })
    if (probe.status === 0) return candidate
  }
  return null
}

/**
 * pip/uv 在 Windows 上按 cp1252 读 requirements 会爆 UnicodeDecodeError：
 * 上游 requirements.txt 带中文注释（UTF-8）。这里先剥成纯 ASCII 临时文件。
 */
function asciiRequirements(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean)
  const target = path.join(os.tmpdir(), `bili-requirements-${process.pid}.txt`)
  fs.writeFileSync(target, `${lines.join('\n')}\n`, 'utf8')
  return target
}

if (!ok(cfg.ownPython)) {
  const basePython = String(opt('--python') || process.env.BILI_BASE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'))
  const version = spawnSync(basePython, ['--version'], { encoding: 'utf8' })
  if (version.status !== 0) {
    console.error(`\n找不到 base python：${basePython}（用 --python 指定一个 3.10+ 的解释器）`)
    process.exit(2)
  }
  console.log(`\n== 建 venv ==\nbase python：${basePython}（${String(version.stdout || version.stderr).trim()}）`)
  const create = spawnSync(basePython, ['-m', 'venv', cfg.ownVenvDir], { stdio: 'inherit' })
  if (create.status !== 0) {
    console.error('\n建 venv 失败（见上面输出）。')
    process.exit(create.status || 1)
  }
} else {
  console.log(`\n== venv 已存在 ==\n${cfg.ownVenvDir}`)
  if (flag('--force')) {
    fs.rmSync(cfg.ownVenvDir, { recursive: true, force: true })
    const basePython = String(opt('--python') || process.env.BILI_BASE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'))
    console.log(`已删除旧目录（--force），重建：${cfg.ownVenvDir}`)
    const create = spawnSync(basePython, ['-m', 'venv', cfg.ownVenvDir], { stdio: 'inherit' })
    if (create.status !== 0) process.exit(create.status || 1)
    } else if (depsReady(cfg.ownVenvDir)) {
    console.log('依赖已齐全，不需要再装。要重建用 --force。')
    process.exit(0)
  } else {
    console.log('依赖不全（上次可能失败过），继续装依赖。')
  }
}
const reqAscii = asciiRequirements(requirements)
const mirror = String(opt('--mirror') || 'https://pypi.tuna.tsinghua.edu.cn/simple')
const uv = findUv()
const attempts = []
if (uv) {
  attempts.push({ label: `uv + 清华镜像（${uv}）`, command: uv, args: ['pip', 'install', '--python', cfg.ownPython, '-i', mirror, '-r', reqAscii] })
}
attempts.push({ label: 'pip + 清华镜像', command: cfg.ownPython, args: ['-m', 'pip', 'install', '--disable-pip-version-check', '-i', mirror, '-r', reqAscii] })
attempts.push({ label: 'pip + 默认 PyPI', command: cfg.ownPython, args: ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', reqAscii] })

let installed = false
for (const attempt of attempts) {
  console.log(`\n== 装依赖：${attempt.label} ==`)
  const run = spawnSync(attempt.command, attempt.args, { stdio: 'inherit' })
  if (run.status === 0) { installed = true; break }
  console.log(`（${attempt.label} 失败，换下一条路）`)
}
try { fs.unlinkSync(reqAscii) } catch { /* 临时文件清不掉不影响 */ }

if (!installed || !depsReady(cfg.ownVenvDir)) {
  console.error('\n装依赖失败。venv 已建好，但依赖不齐；手动重试（任选）:')
  console.error(`  "${cfg.ownPython}" -m pip install -i ${mirror} -r "<仓库>/packages/plugins/bili/vendor/bilibili-mcp/requirements.txt"`)
  console.error(`  uv pip install --python "${cfg.ownPython}" -i ${mirror} -r "<仓库>/packages/plugins/bili/vendor/bilibili-mcp/requirements.txt"`)
  process.exit(1)
}

console.log(`\n完成：${cfg.ownPython}`)
const verify = spawnSync(cfg.ownPython, ['-c', 'import bilibili_api, mcp, aiohttp, qrcode; print("deps ok")'], { encoding: 'utf8' })
console.log(String(verify.stdout || verify.stderr || '').trim())
console.log('下一步：重启 ICL 会话；`node tools/bili-venv.mjs --check` 应显示来源 `icl`。')

