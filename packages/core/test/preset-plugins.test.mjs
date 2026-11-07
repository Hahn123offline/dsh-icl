// preset 的显式 plugins 列表必须真的把插件挂上：注册进 DEFAULT_PLUGINS 但 preset 没列 = 工具不可见。
// 背景：album 加进了 DEFAULT_PLUGINS，但 lab/产品 preset 的显式列表没列，实测只加载 34 工具（7 个 album_* 全丢）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_PLUGINS } from '../../dsh-icl/src/config.mjs'

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/** 抽出 YAML 里所有 `plugins:` 块下的列表项（只认 `- name` 形式，够用且不引 yaml 依赖）。 */
function pluginLists(text) {
  const lists = []
  let current = null
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    const trimmed = line.trim()
    if (trimmed === 'plugins:') { current = []; lists.push(current); continue }
    if (!current) continue
    const item = /^-\s+([a-z0-9][a-z0-9-]*)\s*$/.exec(trimmed)
    if (item) { current.push(item[1]); continue }
    // 退出当前列表：遇到非 `- name` 且缩进不深的行（新键）
    if (trimmed && !trimmed.startsWith('#')) current = null
  }
  return lists.filter((list) => list.length > 0)
}

test('DEFAULT_PLUGINS 包含 album（相册插件已注册）', () => {
  assert.ok(DEFAULT_PLUGINS.includes('album'))
})

test('lab preset 两个会话都显式挂载 album；两 lab 列表并集覆盖 DEFAULT_PLUGINS', () => {
  const lists = pluginLists(read('packages/dsh-icl/presets/lab.patch.yml'))
  assert.ok(lists.length >= 2, `lab preset 应至少有两个 plugins 列表，实际 ${lists.length}`)
  for (const list of lists) assert.ok(list.includes('album'), `每个 lab 会话都应挂 album：${list.join(',')}`)
  const union = new Set(lists.flat())
  const missing = DEFAULT_PLUGINS.filter((id) => !union.has(id))
  assert.deepEqual(missing, [], `lab preset 并集缺插件（注册了但没挂载）：${missing.join(',')}`)
})

test('产品 preset A1：显式 17 插件白名单（含 qq）（去 mc-link），不再是隐式全量', () => {
  const lists = pluginLists(read('packages/dsh-icl/presets/icl.patch.yml'))
  const product = lists[0]
  assert.ok(product, '产品 preset 应有显式 plugins 列表')
  assert.equal(product.length, 17, `产品 A1 白名单应为 17 个插件（含 qq），实际 ${product.length}：${product.join(',')}`)
  assert.ok(!product.includes('mc-link'), '产品 A1 不得包含 mc-link（MC 只走 icl-mc）')
  const missing = DEFAULT_PLUGINS.filter((id) => !product.includes(id)).sort()
  assert.deepEqual(missing, ['mc-link'], `产品 preset 相对 DEFAULT 只允许少 mc-link：${missing.join(',')}`)
  for (const id of product) assert.ok(DEFAULT_PLUGINS.includes(id), `产品白名单只能列已注册插件：${id}`)
  const albumDoc = read('docs/ALBUM.md')
  assert.match(albumDoc, /产品 preset/, 'ALBUM.md 要写清产品 preset 状态')
  const videoDoc = read('docs/VIDEO-EYES.md')
  assert.match(videoDoc, /产品 preset/, 'VIDEO-EYES.md 要写清产品 preset 状态')
})

test('MC lab preset 配了工具白名单（复杂度收敛），产品 preset 未配', () => {
  const lab = read('packages/dsh-icl/presets/lab.patch.yml')
  const prod = read('packages/dsh-icl/presets/icl.patch.yml')
  assert.match(lab, /toolAllowlist:/, 'icl-mc-lab 应有 toolAllowlist')
  assert.match(lab, /'mcb_\*'/, '白名单应含 mcb_*')
  assert.match(lab, /time_status/, '白名单应含 time_status')
  assert.match(lab, /remember/, '白名单应含 remember/recall')
  assert.doesNotMatch(prod, /toolAllowlist:/, '产品 preset 不得带 lab 专用白名单')
})
