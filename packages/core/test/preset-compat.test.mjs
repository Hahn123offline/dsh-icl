// 产品/lab preset 兼容性硬约束：内置 DSH（desktop app.asar）的 agent-loop 只注册
// prompt 变量 provider/model，不注册 cwd；任何 preset 的 tool-persona.suffix 若用
// {{cwd}}，desktop 上所有 ICL 会话会请求组装失败（2026-11-07 A1 live P0：
// unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix"）。
// 因此 preset 层禁止出现 {{cwd}}；工作目录上下文由 working-directory service 提供。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const PRESET_DIR = path.resolve(import.meta.dirname, '..', '..', 'dsh-icl', 'presets')
const FILES = fs.existsSync(PRESET_DIR)
  ? fs.readdirSync(PRESET_DIR).filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  : []

test('preset 不得依赖内置 DSH 未注册的 {{cwd}} 提示变量（desktop 兼容）', () => {
  assert.ok(FILES.length > 0, `没有找到 preset 文件：${PRESET_DIR}`)
  const offenders = []
  for (const name of FILES) {
    const file = path.join(PRESET_DIR, name)
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
    for (const [i, line] of lines.entries()) {
      if (line.includes('{{cwd}}')) offenders.push(`${name}:${i + 1}: ${line.trim()}`)
    }
  }
  assert.deepEqual(offenders, [], `preset 里出现 {{cwd}}（内置 DSH 不注册该变量，desktop ICL 会全灭）：\n${offenders.join('\n')}`)
})
