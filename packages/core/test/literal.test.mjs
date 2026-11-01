// 精确串：路径、文件名、数字不该和普通短语抢语义分。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../src/index.mjs'
import * as memory from '../../plugins/memory/src/index.mjs'
import memoryManifest from '../../plugins/memory/manifest.json' with { type: 'json' }

async function setup() {
  const host = createHost({ log: () => {} })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-literal-'))
  host.registerPlugin(memoryManifest, memory, { config: { root } })
  await host.enable('memory')
  const mem = host.shared.get('memory')
  mem.registerNamespace({ id: 'event', label: '事件', recallable: true })
  return { host, mem }
}

test('路径命中：问到具体写法时，带路径的块排第一', async () => {
  const { mem } = await setup()
  mem.put({ namespace: 'event', kind: 'block', key: 'evt:path', text: '我往 C:\\DSH\\qwenstuff\\ 里写了一个测试文件', data: { body: '' } })
  mem.put({ namespace: 'event', kind: 'block', key: 'evt:other', text: '我在别的地方测写权限，反正写不进去', data: { body: '' } })
  const hits = await mem.search({ query: '往哪个目录 C:\\DSH\\qwenstuff\\ 里写测试文件', limit: 2 })
  assert.equal(hits[0].item.key, 'evt:path')
})

test('文件名命中：长文件名不被拆碎', async () => {
  const { mem } = await setup()
  mem.put({ namespace: 'event', kind: 'block', key: 'evt:file', text: '留下的测试文件叫 小千千千千问-搬家测试.txt', data: {} })
  mem.put({ namespace: 'event', kind: 'block', key: 'evt:noise', text: '搬家之后我看了一下目录，没什么特别的', data: {} })
  const hits = await mem.search({ query: '搬家测试的文件名是什么', limit: 2 })
  assert.equal(hits[0].item.key, 'evt:file')
})

test('数字命中：给了具体金额/时长时优先', async () => {
  const { mem } = await setup()
  mem.put({ namespace: 'event', kind: 'block', key: 'evt:money', text: '花了 7 块钱把环境搬进虚拟机', data: {} })
  mem.put({ namespace: 'event', kind: 'block', key: 'evt:vague', text: '搬家花了点钱，具体多少没说', data: {} })
  const hits = await mem.search({ query: '搬进虚拟机花了 7 块钱吗', limit: 2 })
  assert.equal(hits[0].item.key, 'evt:money')
})

test('普通问句不受影响：没有精确串时仍按语义/字面排序', async () => {
  const { mem } = await setup()
  mem.put({ namespace: 'event', kind: 'block', key: 'evt:sea', text: '他周末要去看海', data: {} })
  const hits = await mem.search({ query: '他周末去哪', limit: 2 })
  assert.equal(hits[0].item.key, 'evt:sea')
})
