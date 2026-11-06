// 边界与接缝：编辑器不许跑出工作区；bili 接缝的工具面形状固定。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../src/index.mjs'
import * as editor from '../../plugins/editor/src/index.mjs'
import * as bili from '../../plugins/bili/src/index.mjs'
import editorManifest from '../../plugins/editor/manifest.json' with { type: 'json' }
import biliManifest from '../../plugins/bili/manifest.json' with { type: 'json' }

const tempRoots = []
function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}
process.on('exit', () => {
  for (const dir of tempRoots) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不影响测试结论 */ }
  }
})

function host_(root) {
  const host = createHost({ log: () => {} })
  host.registerPlugin(editorManifest, editor, { config: { root } })
  host.registerPlugin(biliManifest, bili, {})
  return host
}

test('编辑器拒绝写出工作区', async () => {
  const root = tmpDir('icl-editor-')
  const host = host_(root)
  await host.enable('editor')
  const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))

  const outside = path.join(root, '..', 'escape.txt')
  const result = await tools.write_file.execute({ path: '../escape.txt', text: 'x' })
  assert.match(String(result.text), /不在工作区/)
  assert.equal(fs.existsSync(outside), false, '不能真的写出工作区')

  await tools.write_file.execute({ path: 'notes/a.md', text: 'hi' })
  const read = await tools.read_file.execute({ path: 'notes/a.md' })
  assert.equal(String(read.text), 'hi')
})

test('bili 接缝注册了只读工具，且没有发评论的工具', async () => {
  const root = tmpDir('icl-bili-')
  const host = host_(root)
  await host.enable('bili')
  const names = host.services.tools.names().sort()
  assert.deepEqual(names, [
    'bili_comments', 'bili_feed', 'bili_frames', 'bili_login_poll', 'bili_login_start', 'bili_search', 'bili_watch',
  ])
  assert.ok(!host.services.tools.names().some((n) => /reply|comment_?post|send|upload|dynamic/i.test(n)), '不应有发言/上传类工具')
  const search = host.services.tools.list().find((t) => t.name === 'bili_search')
  assert.ok(search.description.includes('Search Bilibili'), '描述应说明这是搜索')
})
