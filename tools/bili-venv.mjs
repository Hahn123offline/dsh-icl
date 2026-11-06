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
if (ok(cfg.ownPython) && !flag('--force')) {
  console.log(`\n已经存在：${cfg.ownPython}\n加 --force 可重建（会先删掉这个 venv 目录）。`)
  process.exit(0)
}
const basePython = String(opt('--python') || process.env.BILI_BASE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'))
const version = spawnSync(basePython, ['--version'], { encoding: 'utf8' })
if (version.status !== 0) {
  console.error(`\n找不到 base python：${basePython}（用 --python 指定一个 3.10+ 的解释器）`)
  process.exit(2)
}
console.log(`\n== 建 venv ==\nbase python：${basePython}（${String(version.stdout || version.stderr).trim()}）`)
if (flag('--force')) {
  fs.rmSync(cfg.ownVenvDir, { recursive: true, force: true })
  console.log(`已删除旧目录（--force）：${cfg.ownVenvDir}`)
}
const create = spawnSync(basePython, ['-m', 'venv', cfg.ownVenvDir], { stdio: 'inherit' })
if (create.status !== 0) {
  console.error('\n建 venv 失败（见上面输出）。')
  process.exit(create.status || 1)
}
const pip = spawnSync(cfg.ownPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', requirements], { stdio: 'inherit' })
if (pip.status !== 0) {
  console.error('\npip install 失败（网络/镜像问题）。venv 已建好，可稍后重跑：')
  console.error(`  "${cfg.ownPython}" -m pip install -r "${requirements}"`)
  process.exit(pip.status || 1)
}
console.log(`\n完成：${cfg.ownPython}`)
console.log('下一步：重启 ICL 会话；`node tools/bili-eval.mjs --offline` 里“Python 解释器”应指向 ICL stateDir。')
