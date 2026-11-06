// 产品 preset 兼容性硬约束：内置 DSH（desktop app.asar）的 agent-loop 只注册
// prompt 变量 provider/model，不注册 cwd；产品 preset 的 tool-persona.suffix 若用
// {{cwd}}，desktop 上所有 ICL 会话会请求组装失败（2026-11-07 A1 live P0：
// unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix"）。
// 因此产品 preset 禁止出现 {{cwd}}；工作目录上下文由 working-directory service 提供。
// lab preset 用 npm 版 dsh（其 agent-loop 注册了 cwd），保留该 suffix 以免 lab system
// 基线漂移；lab 不装到 desktop。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const PRESET_DIR = path.resolve(import.meta.dirname, '..', '..', 'dsh-icl', 'presets')
const PRODUCT_FILES = ['icl.patch.yml']

test('产品 preset 不得依赖内置 DSH 未注册的 {{cwd}} 提示变量（desktop 兼容）', () => {
  for (const name of PRODUCT_FILES) {
    const file = path.join(PRESET_DIR, name)
    assert.ok(fs.existsSync(file), `缺少产品 preset：${file}`)
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
    const offenders = []
    for (const [i, line] of lines.entries()) {
      const code = line.trim()
      if (!code || code.startsWith('#')) continue
      if (line.includes('{{cwd}}')) offenders.push(`${name}:${i + 1}: ${line.trim()}`)
    }
    assert.deepEqual(offenders, [], `产品 preset 里出现 {{cwd}}（内置 DSH 不注册该变量，desktop ICL 会全灭）：\n${offenders.join('\n')}`)
  }
})
