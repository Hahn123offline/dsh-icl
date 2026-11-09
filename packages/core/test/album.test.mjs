// 相册（ALBUM）：入库/去重/列表/搜索/拼图/保留/体检。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { createHost } from '../src/index.mjs'
import * as album from '../../plugins/album/src/index.mjs'
import albumManifest from '../../plugins/album/manifest.json' with { type: 'json' }

// ── 最小 PNG 生成（测试用，不依赖 Pillow） ──
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function makePng(width, height, rgb) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x += 1) { row[1 + x * 3] = rgb[0]; row[2 + x * 3] = rgb[1]; row[3 + x * 3] = rgb[2] }
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const PY_CANDIDATES = [
  process.env.ALBUM_PYTHON,
  'C:\\Users\\ai_admin\\.dsh\\bili-duty\\.venv\\Scripts\\python.exe',
  'python', 'python3',
].filter(Boolean)
function findPillowPython() {
  for (const candidate of PY_CANDIDATES) {
    try {
      const out = spawnSync(candidate, ['-c', 'import PIL; print(PIL.__version__)'], { encoding: 'utf8', timeout: 15_000 })
      if (out.status === 0) return candidate
    } catch { /* try next */ }
  }
  return null
}
const PILLOW_PY = findPillowPython()

async function setup({ config = {}, provider = null, fetchImpl = null } = {}) {
  const host = createHost({ log: () => {}, ...(fetchImpl ? { fetchImpl } : {}) })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-album-'))
  host.registerPlugin(albumManifest, album, { config: { root, ...config } })
  await host.enable('album')
  if (provider) {
    host.services.slots.registerProvider(provider)
    host.services.slots.autoBind()
  }
  const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))
  return { host, root, tools, service: host.shared.get('album') }
}

const writePng = (dir, name, png) => { const file = path.join(dir, name); fs.writeFileSync(file, png); return file }

test('manifest 声明的工具与实际注册一致', async () => {
  const { tools } = await setup()
  assert.deepEqual(Object.keys(tools).sort(), [...albumManifest.tools].sort())
  assert.equal(albumManifest.tools.length, 10)
})

test('导入两张图：落盘、尺寸/大小/路径正确；同一内容重复导入去重', async () => {
  const { root, tools } = await setup()
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-album-src-'))
  const a = writePng(src, 'a.png', makePng(4, 3, [255, 0, 0]))
  const b = writePng(src, 'b.png', makePng(2, 2, [0, 255, 0]))
  const out = await tools.album_import.execute({ paths: [a, b], source: 'manual', caption: '红图和绿图', tags: ['测试', '颜色'] })
  assert.match(out.text, /#1/)
  assert.match(out.text, /#2/)
  const list = await tools.album_list.execute({})
  assert.match(list.text, /4x3/)
  assert.match(list.text, /2x2/)
  const files = fs.readdirSync(path.join(root, 'default')).flatMap((d) => fs.readdirSync(path.join(root, 'default', d)))
  assert.equal(files.length, 2, '两件应各落一份文件')
  const dup = await tools.album_import.execute({ paths: [a] })
  assert.match(dup.text, /去重命中/)
  const after = await tools.album_list.execute({})
  assert.equal((after.text.match(/^#\d+/gm) ?? []).length, 2, '去重后仍是两件')
})

test('列表筛选：按标签/来源/类型/时间窗', async () => {
  const { tools } = await setup()
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-album-src-'))
  const a = writePng(src, 'a.png', makePng(2, 2, [1, 2, 3]))
  const b = writePng(src, 'b.png', makePng(2, 2, [4, 5, 6]))
  await tools.album_import.execute({ paths: [a], source: 'bili', tags: ['海'] })
  await tools.album_import.execute({ paths: [b], source: 'qq', tags: ['山'] })
  assert.equal((await tools.album_list.execute({ tag: '海' })).text.match(/^#\d+/gm)?.length, 1)
  assert.equal((await tools.album_list.execute({ source: 'qq' })).text.match(/^#\d+/gm)?.length, 1)
  assert.match((await tools.album_list.execute({ kind: 'video' })).text, /没有符合|相册/)
  const future = Date.now() + 86_400_000
  assert.match((await tools.album_list.execute({ since: future })).text, /没有符合/)
})

test('搜索：按描述/标签命中；没有就说没有（不凑数）', async () => {
  const { tools } = await setup()
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-album-src-'))
  const a = writePng(src, 'a.png', makePng(3, 3, [7, 8, 9]))
  await tools.album_import.execute({ paths: [a], caption: '河边看到一只白鹭', tags: ['白鹭', '河边'] })
  const hit = await tools.album_search.execute({ query: '白鹭' })
  assert.match(hit.text, /#1/)
  assert.match(hit.text, /找到 1 件/)
  const miss = await tools.album_search.execute({ query: '量子力学' })
  assert.match(miss.text, /没有匹配/)
  assert.match(miss.text, /共 1 件/)
  assert.match(miss.text, /换个说法|album_list/)
})

test('album_show：给绝对路径；不存在的 id 明确说没有', async () => {
  const { tools } = await setup()
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-album-src-'))
  const a = writePng(src, 'a.png', makePng(2, 4, [10, 11, 12]))
  await tools.album_import.execute({ paths: [a], caption: '竖图' })
  const show = await tools.album_show.execute({ id: 1 })
  assert.match(show.text, /2x4/)
  assert.ok(fs.existsSync(show.imagePath), 'imagePath 应是真实存在的绝对路径')
  assert.match((await tools.album_show.execute({ id: 999 })).text, /没有 #999/)
})

test('不支持的类型 / 读不到的文件：逐条给可操作原因', async () => {
  const { tools } = await setup()
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-album-src-'))
  const txt = path.join(src, 'note.txt'); fs.writeFileSync(txt, 'not media')
  const out = await tools.album_import.execute({ paths: [txt, path.join(src, 'missing.png')] })
  assert.match(out.text, /不支持的媒体类型/)
  assert.match(out.text, /读不到这个文件/)
})

test('保留策略：dryRun 只报告不动手；真删删文件 + 软删行', async () => {
  const { root, tools, service } = await setup()
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-album-src-'))
  for (let i = 0; i < 3; i += 1) await tools.album_import.execute({ paths: [writePng(src, `m${i}.png`, makePng(2, 2, [i, i, i]))] })
  const preview = service.prune({ dryRun: true, limitBytes: 1 })
  assert.equal(preview.victims.length, 3)
  assert.equal((await tools.album_status.execute({})).text.includes('相册：3 件'), true)
  for (const victimId of preview.victims.map((v) => v.id)) {
    const row = await tools.album_show.execute({ id: victimId })
    assert.doesNotMatch(row.text, /没有 #/, 'dryRun 不应删')
  }
  const real = service.prune({ dryRun: false, limitBytes: 1 })
  assert.equal(real.victims.length, 3)
  assert.match((await tools.album_list.execute({})).text, /相册还是空的/)
  assert.match((await tools.album_status.execute({})).text, /0 件/)
})

test('planGrid：列数/行数/尺寸/留白', () => {
  const g = album.planGrid(3, 2, 320, 8)
  assert.deepEqual([g.cols, g.rows], [2, 2])
  assert.equal(g.width, 2 * 320 + 3 * 8)
  assert.equal(g.height, 2 * 320 + 3 * 8)
  assert.deepEqual([album.planGrid(0, 4).rows, album.planGrid(16, 4).rows], [0, 4])
  const clamped = album.planGrid(5, 99, 9999, 1)
  assert.deepEqual([clamped.cols, clamped.cell], [8, 1024])
})

test('readImageSize：PNG/JPEG/GIF 头部解析；乱数据返回 null', () => {
  const png = makePng(7, 5, [0, 0, 0])
  assert.deepEqual(album.readImageSize(png, '.png'), { width: 7, height: 5 })
  assert.equal(album.readImageSize(Buffer.from('garbage'), '.png'), null)
  assert.equal(album.readImageSize(png, '.unknown'), null)
  const gif = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(20)])
  gif.writeUInt16LE(13, 6); gif.writeUInt16LE(9, 8)
  assert.deepEqual(album.readImageSize(gif, '.gif'), { width: 13, height: 9 })
})

test('拼图：3 张 → 2x2 宫格 PNG（python/Pillow 缺失则 skip）', async (t) => {
  if (!PILLOW_PY) { t.skip('本机没有带 Pillow 的 python（ALBUM_PYTHON 可指定）'); return }
  const { tools } = await setup({ config: { python: PILLOW_PY } })
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-album-src-'))
  for (let i = 0; i < 3; i += 1) await tools.album_import.execute({ paths: [writePng(src, `g${i}.png`, makePng(8, 6, [i * 60, 100, 200]))] })
  const out = await tools.album_collage.execute({ ids: [1, 2, 3], cols: 2, cell: 160 })
  assert.ok(out.imagePath, `应返回 imagePath：${out.text}`)
  assert.ok(fs.existsSync(out.imagePath))
  const head = fs.readFileSync(out.imagePath)
  assert.equal(head.readUInt32BE(0), 0x89504e47, '输出应是 PNG')
  const size = album.readImageSize(head, '.png')
  assert.deepEqual(size, { width: 2 * 160 + 3 * 8, height: 2 * 160 + 3 * 8 })
  assert.match(out.text, /第 1\.\.N 格依次是 #1 #2 #3/)
})

test('拼图：没有图片时给下一步（不生成空文件）', async () => {
  const { tools } = await setup()
  const out = await tools.album_collage.execute({ ids: [1, 2] })
  assert.match(out.text, /没有可用的图片|没有可拼的图片/)
  assert.equal(out.imagePath, undefined)
})

test('隐私相册：默认列表/搜索/拼图都看不到；show 必须 allowPrivate 才给路径', async () => {
  const { root, tools } = await setup()
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-album-src-'))
  const normal = writePng(src, 'n.png', makePng(2, 2, [1, 1, 1]))
  const secret = writePng(src, 's.png', makePng(2, 2, [9, 9, 9]))
  await tools.album_import.execute({ paths: [normal], caption: '普通图' })
  const imp = await tools.album_import.execute({ paths: [secret], caption: '隐私图', private: true })
  assert.match(imp.text, /隐私相册/)
  // 物理分区：private/ 目录存在
  assert.ok(fs.existsSync(path.join(root, 'private')), '隐私文件应在 private/ 子目录')
  // 默认列表/搜索/拼图都看不到
  assert.doesNotMatch((await tools.album_list.execute({})).text, /隐私图/)
  assert.match((await tools.album_search.execute({ query: '隐私图' })).text, /没有匹配/)
  const collageAll = await tools.album_collage.execute({ cols: 2 })
  assert.doesNotMatch(collageAll.text, /#2/, '默认拼图不能包含隐私图')
  // 隐私双确认：只给 includePrivate 仍不可见
  const singleConfirm = await tools.album_list.execute({ includePrivate: true })
  assert.doesNotMatch(singleConfirm.text, /隐私图/, 'includePrivate 单确认不能列隐私')
  const withPrivate = await tools.album_list.execute({ includePrivate: true, allowPrivate: true })
  assert.match(withPrivate.text, /隐私相册/)
  // show 也是双确认
  const denied = await tools.album_show.execute({ id: 2 })
  assert.match(denied.text, /隐私相册/)
  assert.equal(denied.imagePath, undefined)
  const deniedSingle = await tools.album_show.execute({ id: 2, allowPrivate: true })
  assert.equal(deniedSingle.imagePath, undefined, 'show 只给 allowPrivate 不够')
  const allowed = await tools.album_show.execute({ id: 2, includePrivate: true, allowPrivate: true })
  assert.ok(allowed.imagePath && fs.existsSync(allowed.imagePath))
})

test('不自动清理：超过告警阈值仍保留全部，只在 status 提示（用户拍板）', async () => {
  const { root, tools } = await setup({ config: { warnBytes: 1024 * 1024 } })
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-album-src-'))
  // 1.5MiB 的"文件"（扩展名合法即可入库；尺寸解析失败也不影响）
  const big = path.join(src, 'big.png')
  fs.writeFileSync(big, Buffer.alloc(1.5 * 1024 * 1024, 7))
  await tools.album_import.execute({ paths: [big], caption: '大文件' })
  const small = writePng(src, 's.png', makePng(2, 2, [3, 3, 3]))
  await tools.album_import.execute({ paths: [small], caption: '小文件' })
  const list = await tools.album_list.execute({})
  assert.equal((list.text.match(/^#\d+/gm) ?? []).length, 2, '超过阈值也不能自动删')
  const status = await tools.album_status.execute({})
  assert.match(status.text, /⚠ 已超过告警阈值/, status.text)
  assert.match(status.text, /不会自动删/)
})

test('手清：prune 默认跳过隐私项，allowPrivate 才可能删到', async () => {
  const { tools, service } = await setup()
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-album-src-'))
  await tools.album_import.execute({ paths: [writePng(src, 'a.png', makePng(2, 2, [1, 2, 3]))] })
  await tools.album_import.execute({ paths: [writePng(src, 'b.png', makePng(2, 2, [4, 5, 6]))], private: true })
  const noPrivate = service.prune({ dryRun: true, limitBytes: 1, days: 0 })
  assert.deepEqual(noPrivate.victims.map((v) => v.id), [1], '默认只清普通相册')
  const withPrivate = service.prune({ dryRun: true, limitBytes: 1, days: 0, allowPrivate: true })
  assert.equal(withPrivate.victims.length, 2)
})

/* ── 二阶段：图片记忆/语义检索（fake embedding，不依赖 8088） ───────────── */

const vec512 = (a = 0, b = 0, c = 0) => { const out = new Array(512).fill(0); out[0] = a; out[1] = b; out[2] = c; return out }

function fakeClipProvider({ text = {}, image = {}, dim = null } = {}) {
  return {
    id: 'fake-clip', kind: 'embedding', shape: { dim: 512 },
    async call({ input } = {}) {
      const raw = String(input ?? '')
      if (raw.startsWith('data:')) {
        const decoded = Buffer.from(raw.split(',')[1] ?? '', 'base64').toString('latin1')
        for (const [marker, vector] of Object.entries(image)) if (decoded.includes(marker)) return [dim ? new Array(dim).fill(0) : vector]
        return [dim ? new Array(dim).fill(0) : vec512(0.5, 0.5)]
      }
      for (const [marker, vector] of Object.entries(text)) if (raw.includes(marker)) return [dim ? new Array(dim).fill(0) : vector]
      return [dim ? new Array(dim).fill(0) : vec512(0.5, 0.5)]
    },
  }
}

const pngWithMarker = (dir, name, rgb, marker) => {
  const png = makePng(2, 2, rgb)
  const file = path.join(dir, name)
  fs.writeFileSync(file, Buffer.concat([png, Buffer.from(String(marker), 'latin1')]))
  return file
}

test('语义检索：文字 query 用 CLIP 图文空间命中；图片 query 图-图相似', async () => {
  const provider = fakeClipProvider({
    text: { 猫: vec512(1, 0), cat: vec512(1, 0), 狗: vec512(0, 1), dog: vec512(0, 1) },
    image: { cat: vec512(1, 0), dog: vec512(0, 1) },
  })
  const { tools } = await setup({ provider })
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-album-src-'))
  await tools.album_import.execute({ paths: [pngWithMarker(src, 'cat.png', [255, 0, 0], 'cat'), pngWithMarker(src, 'dog.png', [0, 255, 0], 'dog')] })
  const byText = await tools.album_search.execute({ query: '猫' })
  assert.match(byText.text, /语义检索/)
  assert.match(byText.text, /#1/, byText.text)
  assert.ok(byText.text.indexOf('#1') < byText.text.indexOf('#2'), '猫应排在狗前面')
  assert.match(byText.text, /相似度 1\.000/)
  const byImage = await tools.album_search.execute({ image: path.join(src, 'cat.png') })
  assert.match(byImage.text, /语义检索/)
  assert.match(byImage.text, /#1/, byImage.text)
})

test('语义检索：隐私项默认不返回；includePrivate+allowPrivate 才可见', async () => {
  const provider = fakeClipProvider({ text: { 猫: vec512(1, 0) }, image: { pcat: vec512(1, 0) } })
  const { tools } = await setup({ provider })
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-album-src-'))
  await tools.album_import.execute({ paths: [pngWithMarker(src, 'pcat.png', [1, 1, 1], 'pcat')], private: true })
  const hidden = await tools.album_search.execute({ query: '猫' })
  assert.doesNotMatch(hidden.text, /#1/)
  const visible = await tools.album_search.execute({ query: '猫', includePrivate: true, allowPrivate: true })
  assert.match(visible.text, /#1/)
})

test('语义检索降级：没有嵌入服务/没有向量时退回文字标签，并说明原因', async () => {
  const { tools } = await setup()
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-album-src-'))
  await tools.album_import.execute({ paths: [writePng(src, 'a.png', makePng(2, 2, [1, 2, 3]))], caption: '河边白鹭' })
  const out = await tools.album_search.execute({ query: '白鹭' })
  assert.match(out.text, /语义检索未接入|没有向量/)
  assert.match(out.text, /#1/)
  const byImage = await tools.album_search.execute({ image: path.join(src, 'a.png') })
  assert.match(byImage.text, /嵌入服务|album_reindex/)
})

test('embedDefer + album_reindex：滞后建向量后语义检索生效；status 报覆盖率', async () => {
  const provider = fakeClipProvider({ text: { 猫: vec512(1, 0) }, image: { cat: vec512(1, 0) } })
  const { tools } = await setup({ provider, config: { embedDefer: true } })
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-album-src-'))
  const imp = await tools.album_import.execute({ paths: [pngWithMarker(src, 'cat.png', [9, 9, 9], 'cat')] })
  assert.doesNotMatch(imp.text, /向量✓/)
  const before = await tools.album_search.execute({ query: '猫' })
  assert.match(before.text, /没有图片向量|语义检索|album_reindex/)
  const re = await tools.album_reindex.execute({})
  assert.match(re.text, /已建\/刷新 1 条/)
  const status = await tools.album_status.execute({})
  assert.match(status.text, /向量：1\/1 张图片/)
  const after = await tools.album_search.execute({ query: '猫' })
  assert.match(after.text, /语义检索/)
  assert.match(after.text, /#1/)
})

test('维度断言：返回 1024d 时入库给可操作错误、不写坏向量', async () => {
  const provider = fakeClipProvider({ image: { cat: vec512(1, 0) }, dim: 1024 })
  const { tools } = await setup({ provider })
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-album-src-'))
  const imp = await tools.album_import.execute({ paths: [pngWithMarker(src, 'cat.png', [2, 2, 2], 'cat')] })
  assert.match(imp.text, /向量未建/)
  assert.match(imp.text, /维度不匹配/)
  const status = await tools.album_status.execute({})
  assert.match(status.text, /向量：0\/1 张图片/)
})

test('album_caption：手动/批量可选，不自动跑；vision 服务写入描述', async () => {
  let visionCalls = 0
  const fetchImpl = async (url, init) => {
    if (String(url).includes('/chat/completions')) {
      visionCalls += 1
      return { ok: true, async json() { return { choices: [{ message: { content: '一只橘猫趴在窗台上晒太阳' } }] } } }
    }
    return { ok: false, status: 404, async json() { return {} } }
  }
  const provider = fakeClipProvider({ image: { cat: vec512(1, 0) } })
  const { tools } = await setup({ provider, fetchImpl })
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-album-src-'))
  await tools.album_import.execute({ paths: [pngWithMarker(src, 'cat.png', [3, 3, 3], 'cat')] })
  assert.equal(visionCalls, 0, '导入不应自动caption')
  const cap = await tools.album_caption.execute({ ids: [1] })
  assert.equal(visionCalls, 1)
  assert.match(cap.text, /一只橘猫/)
  assert.match((await tools.album_list.execute({})).text, /一只橘猫/)
})

test('真实 8088 clip-zh 集成（ALBUM_CLIP_SMOKE=1 才跑，CPU，不占 GPU）', { skip: process.env.ALBUM_CLIP_SMOKE !== '1' }, async () => {
  const base = String(process.env.ALBUM_CLIP_BASE ?? 'http://127.0.0.1:8088/v1').replace(/\/+$/, '')
  const model = String(process.env.ALBUM_CLIP_MODEL ?? 'clip-zh')
  const res = await fetch(`${base}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, input: '一只猫在窗台上晒太阳' }),
    signal: AbortSignal.timeout(60_000),
  })
  assert.ok(res.ok, `clip 服务返回 ${res.status}（${base}/embeddings, model=${model}）`)
  const data = await res.json()
  const vec = data?.data?.[0]?.embedding
  assert.ok(Array.isArray(vec) && vec.length === 512, `期望 512d CLIP 向量，实际 ${vec?.length}`)
})

test('image-embed 槽是 optional：缺 CLIP provider 时进 optionalUnmatched，不把 health 标红', async () => {
  const { host } = await setup()
  const unmatched = host.services.slots.unmatched()
  const slot = unmatched.find((row) => row.id === 'image-embed')
  assert.ok(slot, '无 provider 时 image-embed 应在 unmatched')
  assert.equal(slot.optional, true, JSON.stringify(unmatched))
})

test('album_import 只读文件头：readFileHead 不会把大文件整个读进内存', async () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-album-head-'))
  const file = path.join(src, 'big.png')
  fs.writeFileSync(file, Buffer.alloc(200 * 1024, 7))
  const head = album.readFileHead(file, 64 * 1024)
  assert.equal(head.length, 64 * 1024)
  const small = path.join(src, 'small.png')
  fs.writeFileSync(small, Buffer.alloc(100, 1))
  assert.equal(album.readFileHead(small, 64 * 1024).length, 100)
  const empty = path.join(src, 'empty.png')
  fs.writeFileSync(empty, Buffer.alloc(0))
  assert.equal(album.readFileHead(empty, 64 * 1024).length, 0)
})

test('album_note：改备注/标签/来源/置顶；只改 metadata；album_show 能看到', async () => {
  const { tools, service } = await setup()
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'icl-album-src-'))
  const a = writePng(src, 'note.png', makePng(2, 2, [20, 30, 40]))
  const imported = await tools.album_import.execute({ paths: [a], caption: '旧描述', tags: ['旧标签'] })
  const id = Number(/^#(\d+)/m.exec(imported.text)?.[1])
  assert.ok(id > 0)
  const out = await tools.album_note.execute({ id, caption: '新的备注', addTags: ['表情', 'qq'], removeTags: ['旧标签'], source: 'qq', pinned: true })
  assert.match(out.text, /新的备注/)
  const shown = await tools.album_show.execute({ id })
  assert.match(shown.text, /新的备注/)
  assert.match(shown.text, /表情/)
  assert.match(shown.text, /qq/)
  assert.doesNotMatch(shown.text, /旧标签/)
  const listed = await tools.album_list.execute({ tag: '表情' })
  assert.match(listed.text, new RegExp(`#${id}`))
  const marked = service.markSent(id, Date.now())
  assert.equal(marked.ok, true)
  assert.match((await tools.album_show.execute({ id })).text, /已发过/)
})
