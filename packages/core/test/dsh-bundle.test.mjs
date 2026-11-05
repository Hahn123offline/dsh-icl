// 可安装性契约：bundle 的清单、patch、显示资源必须自洽。
//
// 这些检查对应 DSH 的 bundle/Plugin Manager 读取方式：
//   package.json 的 dsh.bundle.patch 指向 preset patch；preset 里的插件行用包名解析；
//   locale 有 meta.title/description；icon 是包内的 SVG/PNG。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..', '..', 'dsh-icl')
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')
const pkg = JSON.parse(read('package.json'))

test('bundle 清单：名字、入口、patch 都存在', () => {
  assert.equal(pkg.name, 'dsh-icl')
  assert.equal(pkg.type, 'module')
  assert.ok(pkg.exports['.'])
  assert.equal(pkg.exports['./icon'], './icon.svg')
  const patches = [].concat(pkg.dsh?.bundle?.patch ?? [])
  assert.ok(patches.length > 0, '必须声明 dsh.bundle.patch')
  for (const patch of patches) {
    assert.ok(fs.existsSync(path.join(ROOT, patch)), `patch 不存在：${patch}`)
  }
  assert.equal(pkg.exports['./package.json'], './package.json')
})

test('preset patch：行 id、preset id、插件入口与包一致', () => {
  const patch = read('presets/icl.patch.yml')
  assert.match(patch, /id: preset-icl/)
  assert.match(patch, /id: icl/)
  assert.match(patch, /name: (dsh-icl|\.\.)\/index\.mjs/)
  assert.match(patch, /name: '@deepseek-ai\/dsh-agent-preset'/)
})

test('headless patch 用相对入口，不依赖已安装的包名', () => {
  const patch = read('cordis.patch.yml')
  assert.match(patch, /name: \.\/index\.mjs/)
  assert.match(patch, /stateDir:/)
})

test('显示资源：locale 有标题与描述，icon 在包内且大小合规', () => {
  for (const locale of ['en.json', 'zh.json']) {
    const data = JSON.parse(read(`locale/${locale}`))
    assert.equal(typeof data.meta?.title, 'string')
    assert.ok(data.meta.title.trim())
    assert.equal(typeof data.meta?.description, 'string')
    assert.ok(data.meta.description.trim())
  }
  const icon = fs.readFileSync(path.join(ROOT, 'icon.svg'))
  assert.ok(icon.length > 0 && icon.length <= 256 * 1024)
  assert.match(icon.toString('utf8', 0, 120), /^<svg/)
})

test('包内文件清单覆盖运行时会读到的文件', () => {
  const files = pkg.files ?? []
  for (const required of ['index.mjs', 'presets/*.patch.yml', 'locale/*.json', 'icon.svg']) {
    assert.ok(files.includes(required), `files 缺少 ${required}`)
  }
})
