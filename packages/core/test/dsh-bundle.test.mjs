// 可安装性契约：bundle 的清单、patch、显示资源必须自洽。
//
// 这些检查对应 DSH 的 bundle/Plugin Manager 读取方式：
//   package.json 的 dsh.bundle.patch 指向 preset patch；preset 里的插件行用包名解析；
//   locale 有 meta.title/description；icon 是包内的 SVG/PNG。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

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

// SANDBOX-PLAN §7 试点：lab 是唯一允许带 workspace-write 的实验夹具；desktop/产品默认值不在本测试范围。
const labRows = yaml.load(read('presets/lab.patch.yml'))
const labPreset = (id) => labRows
  .flatMap((row) => row.insert ?? [])
  .find((row) => row.id === id)

test('lab 试点：整个 lab 进程默认 workspace-write，workspaceRoot 由 lab 按 --workspace 物化', () => {
  const sandbox = labRows.find((row) => row.id === 'sandbox-policy')
  assert.equal(sandbox?.config?.mode, 'workspace-write')
  // 不写死盘符：模板里是占位符，tools/lab.mjs 用同一轮 --workspace 的绝对路径替换。
  assert.equal(sandbox?.config?.workspaceRoot, '__LAB_WORKSPACE__')
  const permission = labRows.find((row) => row.id === 'permission')
  assert.equal(permission?.config?.defaultPreset, 'workspace-write')
  // danger-full-access 必须保留为回滚路径。
  assert.ok(permission.config.presets['danger-full-access'])
})

test('lab 试点：icl-lab 用原生工具替换 editor，MC 预设不动', () => {
  const row = labPreset('preset-icl-lab')
  const ids = row.config.plugins.map((plugin) => plugin.id)
  for (const id of ['tool-fs', 'tool-fs-search', 'tool-pwsh']) {
    assert.ok(ids.includes(id), `icl-lab 缺少原生工具行 ${id}`)
  }
  const core = row.config.plugins.find((plugin) => plugin.id === 'icl-lab-core')
  assert.ok(!core.config.plugins.includes('editor'), 'icl-lab 不应再启用 editor')
  assert.ok(core.config.plugins.includes('bili'), '只移除 editor，其余 ICL 插件保持')

  const mc = labPreset('preset-icl-mc-lab')
  const mcCore = mc.config.plugins.find((plugin) => plugin.id === 'icl-mc-lab-core')
  assert.ok(mcCore.config.plugins.includes('editor'), '本轮试点不碰 MC 预设')
})

