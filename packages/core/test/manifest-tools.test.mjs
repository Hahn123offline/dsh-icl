// 工具面不变量：插件实际注册的工具必须都在 manifest.tools 里声明。
// 2026-11-07 审计发现 QQ 实际注册 10 个工具、manifest 只声明 2 个 → surface.list()
// 按 manifest 过滤，qq_help/qq_unread/qq_history/qq_replied/qq_mark_read/stickers 等
// 从模型工具面静默消失（73 条测试直接用 host.services.tools.list()，测不出来）。
//
// 这里用源码静态扫描覆盖仓库内全部插件：`ctx.tools.register({ name: 'xxx' ... })`
// 必须出现在该插件的 manifest.tools 中。比启动每个插件更轻，且能防同类漏声明。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const PLUGINS_DIR = path.join(ROOT, 'plugins')

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === 'vendor') continue
      walk(full, out)
    } else if (ent.isFile() && ent.name.endsWith('.mjs')) {
      out.push(full)
    }
  }
  return out
}

test('插件 manifest.tools 必须声明源码里实际注册的每个工具（防模型面静默丢失）', () => {
  const offenders = []
  for (const ent of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue
    const dir = path.join(PLUGINS_DIR, ent.name)
    const manifestFile = path.join(dir, 'manifest.json')
    if (!fs.existsSync(manifestFile)) continue
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
    const declared = new Set(Array.isArray(manifest.tools) ? manifest.tools : [])
    const registered = new Set()
    for (const file of walk(path.join(dir, 'src'))) {
      const text = fs.readFileSync(file, 'utf8')
      // 只认 `tools.register({ ... name: 'x' ... })` 这种对象字面量注册；
      // `tools.register(tool)` 从变量注册无法静态取名字（focus 就是这种），跳过，
      // 避免把后面的 prompt.section({name:'focus'}) 误判成工具。
      const re = /tools\.register\s*\(\s*\{[^}]{0,600}?name:\s*['"]([a-zA-Z0-9_-]+)['"]/g
      let m
      while ((m = re.exec(text))) registered.add(m[1])
    }
    for (const name of registered) {
      if (!declared.has(name)) offenders.push(`${ent.name}: ${name} 已注册但未在 manifest.tools 声明`)
    }
  }
  assert.deepEqual(offenders, [], `插件工具面漏声明（模型看不到这些工具）：\n${offenders.join('\n')}`)
})
