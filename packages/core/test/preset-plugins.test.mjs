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

test('产品 preset 允许暂缓的插件有明确白名单（album/video 等用户批准），且文档写明', () => {
  const lists = pluginLists(read('packages/dsh-icl/presets/icl.patch.yml'))
  const listed = new Set(lists.flat())
  const missing = DEFAULT_PLUGINS.filter((id) => !listed.has(id)).sort()
  // 产品 preset 可以比 DEFAULT 少，但必须逐项有据（目前 album/video：产品化等用户批准）。
  assert.deepEqual(missing, ['album', 'video'], `产品 preset 未挂载插件必须显式登记：${missing.join(',')}`)
  const albumDoc = read('docs/ALBUM.md')
  assert.match(albumDoc, /产品 preset/, 'ALBUM.md 要写清产品 preset 状态')
  assert.match(albumDoc, /待(用户)?批准/, 'ALBUM.md 要写清 album 产品化等批准')
  const videoDoc = read('docs/VIDEO-EYES.md')
  assert.match(videoDoc, /产品 preset/, 'VIDEO-EYES.md 要写清产品 preset 状态')
  assert.match(videoDoc, /待(用户)?批准/, 'VIDEO-EYES.md 要写清 video 产品化等批准')
})
