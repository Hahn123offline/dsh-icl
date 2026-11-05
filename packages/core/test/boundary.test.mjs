// 基础设施的边界：插件只能用核心给的东西。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.join(import.meta.dirname, '..', '..', 'plugins')
const ALLOWED_FETCH = new Set(['model-manager', 'mc-link']) // 接线器允许直接发 HTTP

function pluginSources() {
  const out = []
  for (const dir of fs.readdirSync(ROOT)) {
    const src = path.join(ROOT, dir, 'src')
    if (!fs.existsSync(src)) continue
    for (const file of fs.readdirSync(src)) {
      if (!file.endsWith('.mjs')) continue
      out.push({ plugin: dir, file, text: fs.readFileSync(path.join(src, file), 'utf8') })
    }
  }
  return out
}

test('插件不许直接依赖 DSH 工具包（工具只能走核心通道）', () => {
  for (const src of pluginSources()) {
    assert.doesNotMatch(src.text, /@deepseek-ai\/dsh-tools/, `${src.plugin}/${src.file} 绕过核心注册工具`)
  }
})

test('插件不许自己发 HTTP（除了接线器）', () => {
  for (const src of pluginSources()) {
    if (ALLOWED_FETCH.has(src.plugin)) continue
    assert.doesNotMatch(src.text, /globalThis\.fetch|\bfetch\(/, `${src.plugin}/${src.file} 自己发了请求`)
  }
})

test('插件不许出现模型地址或密钥（只放需求形状）', () => {
  for (const src of pluginSources()) {
    if (src.plugin === 'model-manager') continue
    assert.doesNotMatch(src.text, /baseUrl\s*:|apiKey\s*:/, `${src.plugin}/${src.file} 写死了模型配置`)
  }
})

test('插件声明插槽只写形状，不写模型名', () => {
  for (const dir of fs.readdirSync(ROOT)) {
    const manifestFile = path.join(ROOT, dir, 'manifest.json')
    if (!fs.existsSync(manifestFile)) continue
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
    for (const slot of manifest.slots ?? []) {
      assert.ok(slot.kind, `${dir} 的插槽缺 kind`)
      assert.ok(!('model' in slot), `${dir} 的插槽不许写 model`)
      assert.ok(!('baseUrl' in slot), `${dir} 的插槽不许写 baseUrl`)
    }
  }
})
