// QQ 入站媒体：图片字节 → signal.images（bridge 换 DSH attachment）；视频/文件落本地媒体目录 + index.jsonl；
// 失败降级为文字、不丢消息；正文不得出现 URL/base64。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../src/index.mjs'
import * as qqModule from '../../plugins/qq/src/index.mjs'
import manifest from '../../plugins/qq/manifest.json' with { type: 'json' }
import * as albumModule from '../../plugins/album/src/index.mjs'
import albumManifest from '../../plugins/album/manifest.json' with { type: 'json' }
import { createFakeOneBot } from '../../plugins/qq/tools/fake-onebot.mjs'
import { MEDIA_DEFAULTS, acceptVideoBuffer, inboxMediaPath, saveInboxMedia, sniffVideoMime } from '../../plugins/qq/src/media.mjs'

const TOKEN = 'media-token'
const OWNER = '10001'
const SELF = '2593621742'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const MP4 = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftypmp42', 'ascii'), Buffer.from([0, 0, 0, 0])])
const FILE_BYTES = Buffer.from('hello pdf bytes')

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }
async function waitFor(predicate, { timeoutMs = 6000, stepMs = 20 } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await sleep(stepMs)
  }
  return predicate()
}

function fakeFetch(bytesFor) {
  return async (url) => {
    const bytes = bytesFor(String(url))
    if (!bytes) throw new Error('fake fetch: not found')
    return {
      ok: true,
      status: 200,
      headers: { get: () => String(bytes.length) },
      arrayBuffer: async () => bytes,
    }
  }
}

async function setup({ overrides = {}, bytesFor, logs = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-media-'))
  const fake = await createFakeOneBot({ port: 0, token: TOKEN })
  const host = createHost({ log: (entry) => { if (logs) logs.push(entry) } })
  const mediaDir = path.join(dir, 'media')
  host.registerPlugin(manifest, qqModule, {
    config: {
      enabled: true, url: `ws://127.0.0.1:${fake.port}/`, token: TOKEN, selfId: SELF,
      allowPrivate: [OWNER], ownerQQ: OWNER,
      ledgerFile: path.join(dir, 'ledger.db'),
      mediaInboxDir: mediaDir,
      mediaFetchImpl: fakeFetch(bytesFor ?? (() => PNG)),
      ...overrides,
    },
  })
  await host.enable('qq')
  const qq = host.shared.get('qq')
  await waitFor(() => qq.status().connection.connected === true)
  return {
    dir, fake, host, qq, mediaDir,
    drain: () => host.services.delivery.drain('session'),
    indexRows: () => {
      try { return fs.readFileSync(path.join(mediaDir, 'index.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] }
    },
    cleanup: async () => {
      host.disable('qq')
      await fake.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('媒体纯函数：视频魔数/文件名/index 记录；保留默认值有文档口径', () => {
  assert.equal(sniffVideoMime(MP4), 'video/mp4')
  assert.equal(sniffVideoMime(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0])), 'video/webm')
  assert.equal(sniffVideoMime(PNG), null)
  assert.throws(() => acceptVideoBuffer(PNG), /不是支持的视频类型/)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-media-unit-'))
  try {
    const { file } = inboxMediaPath({ dir, at: Date.UTC(2026, 10, 6, 10, 0, 0), messageId: 123, sender: '主人', index: 2, mimeType: 'image/png' })
    assert.match(file, /2026-11-06/)
    assert.match(file, /123-.*-2\.png$/)
    const saved = saveInboxMedia({ dir, kind: 'image', buffer: PNG, mimeType: 'image/png', at: Date.now(), messageId: 123, peerId: OWNER, sender: '主人', index: 1, originalName: 'a.png' })
    assert.equal(fs.existsSync(saved.path), true)
    assert.equal(fs.statSync(saved.path).size, PNG.length)
    const rows = fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l))
    assert.equal(rows[0].kind, 'image')
    assert.equal(rows[0].messageId, '123')
    assert.equal(rows[0].bytes, PNG.length)
    assert.ok(MEDIA_DEFAULTS.retentionDays === 0, '默认不自动删除')
    assert.ok(MEDIA_DEFAULTS.maxVideoBytes >= 512 * 1024 * 1024, '单视频默认 512MiB')
    assert.ok(MEDIA_DEFAULTS.maxFileBytes >= 512 * 1024 * 1024, '单文件默认 512MiB')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('图片：字节进 signal.images（给 bridge），正文无 URL/base64；本地也落一份', async () => {
  const env = await setup({ bytesFor: (url) => (url.includes('.png') ? PNG : null) })
  try {
    env.fake.privateRichMessage({
      from: OWNER, name: '主人', messageId: 8100,
      segments: [
        { type: 'image', data: { url: 'https://cdn.example/a.png', file: 'a.image' } },
        { type: 'text', data: { text: '看图' } },
      ],
    })
    await waitFor(() => env.qq.status().ledger.messages >= 1 && env.qq.status().stats.mediaSaved >= 1)
    const [batch] = env.drain()
    assert.ok(batch)
    assert.equal(batch.images.length, 1)
    assert.equal(batch.images[0].mediaType, 'image/png')
    assert.equal(batch.images[0].data.byteLength, PNG.length)
    assert.match(batch.text, /\[图片\]/)
    assert.doesNotMatch(batch.text, /https?:\/\/|base64|data:image/)
    const rows = env.indexRows()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].kind, 'image')
    assert.equal(fs.existsSync(rows[0].path), true)
  } finally { await env.cleanup() }
})

test('视频/文件：落本地媒体目录 + index.jsonl，正文给本地绝对路径；不泄漏 URL', async () => {
  const env = await setup({
    bytesFor: (url) => (url.includes('.mp4') ? MP4 : url.includes('.pdf') ? FILE_BYTES : null),
  })
  try {
    env.fake.privateRichMessage({
      from: OWNER, name: '主人', messageId: 8101,
      segments: [
        { type: 'video', data: { url: 'https://cdn.example/v.mp4' } },
        { type: 'file', data: { url: 'https://cdn.example/f.pdf', name: '报告.pdf', file_id: 'f-1' } },
      ],
    })
    await waitFor(() => env.qq.status().ledger.messages >= 1 && env.indexRows().length >= 2)
    const [batch] = env.drain()
    assert.ok(batch)
    assert.equal(Array.isArray(batch.images) ? batch.images.length : 0, 0, '视频/文件不进 image block')
    assert.match(batch.text, /\[视频已保存：.+\.mp4\]/)
    assert.match(batch.text, /\[文件已保存：.+\.pdf\]/)
    assert.doesNotMatch(batch.text, /https?:\/\//)
    const rows = env.indexRows()
    assert.equal(rows.length, 2)
    assert.deepEqual(rows.map((r) => r.kind).sort(), ['file', 'video'])
    for (const row of rows) assert.equal(fs.existsSync(row.path), true)
    assert.equal(rows.find((r) => r.kind === 'file').originalName, '报告.pdf')
  } finally { await env.cleanup() }
})

test('图片下载失败：消息不丢、正文降级为提示，不伪造 attachment', async () => {
  const env = await setup({ bytesFor: () => null })
  try {
    env.fake.privateRichMessage({
      from: OWNER, name: '主人', messageId: 8102,
      segments: [
        { type: 'image', data: { url: 'https://cdn.example/missing.png' } },
        { type: 'text', data: { text: '在吗' } },
      ],
    })
    await waitFor(() => env.qq.status().ledger.messages >= 1 && env.qq.status().stats.mediaFailed >= 1)
    const [batch] = env.drain()
    assert.ok(batch)
    assert.equal(Array.isArray(batch.images) ? batch.images.length : 0, 0)
    assert.match(batch.text, /\[图片\]/)
    assert.match(batch.text, /图片未能获取/)
    assert.doesNotMatch(batch.text, /https?:\/\/|base64/)
  } finally { await env.cleanup() }
})

test('离线契约：本地 PNG/MP4 样例文件读字节 → 落盘/index 完整，无 .part 残留', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-media-offline-'))
  const sampleDir = path.join(dir, 'samples')
  const mediaDir = path.join(dir, 'media')
  fs.mkdirSync(sampleDir, { recursive: true })
  try {
    const pngFile = path.join(sampleDir, '样例 图片.png')
    const mp4File = path.join(sampleDir, '样例 视频.mp4')
    fs.writeFileSync(pngFile, PNG)
    fs.writeFileSync(mp4File, MP4)
    const image = saveInboxMedia({
      dir: mediaDir, kind: 'image', buffer: fs.readFileSync(pngFile), mimeType: 'image/png',
      at: Date.now(), messageId: 9901, peerId: OWNER, sender: '主人', index: 1, originalName: '样例 图片.png',
    })
    const video = saveInboxMedia({
      dir: mediaDir, kind: 'video', buffer: fs.readFileSync(mp4File), mimeType: 'video/mp4',
      at: Date.now(), messageId: 9902, peerId: OWNER, sender: '主人', index: 1, originalName: '样例 视频.mp4',
    })
    for (const saved of [image, video]) {
      assert.equal(fs.existsSync(saved.path), true)
      assert.equal(fs.statSync(saved.path).size, saved.bytes)
      assert.match(saved.path, /990[12]-/)
    }
    const rows = fs.readFileSync(path.join(mediaDir, 'index.jsonl'), 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l))
    assert.equal(rows.length, 2)
    assert.deepEqual(rows.map((r) => r.kind).sort(), ['image', 'video'])
    const leftovers = []
    const walk = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const file = path.join(current, entry.name)
        if (entry.isDirectory()) walk(file)
        else if (entry.name.includes('.part-')) leftovers.push(file)
      }
    }
    walk(mediaDir)
    assert.deepEqual(leftovers, [])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('媒体策略默认：不自动删/不自动 album/单文件 512MiB/总量软告警', async () => {
  const logs = []
  const env = await setup({ logs })
  try {
    const media = env.qq.status().media
    assert.equal(media.retentionDays, 0, '默认不自动删除')
    assert.equal(media.autoDelete, false)
    assert.equal(media.autoAlbum, false, '归档必须手动（album_import），QQ 不自动进 album')
    assert.ok(media.maxVideoBytes >= 512 * 1024 * 1024)
    assert.ok(media.maxFileBytes >= 512 * 1024 * 1024)
    assert.ok(media.softLimitBytes > 0, '总量是软上限，只告警')
    env.fake.privateRichMessage({
      from: OWNER, messageId: 8200,
      segments: [{ type: 'image', data: { url: 'https://cdn.example/a.png' } }],
    })
    await waitFor(() => env.qq.status().media.saved >= 1)
    assert.ok(env.qq.status().media.bytes > 0)
  } finally { await env.cleanup() }
})

test('单视频超过 512MiB 配置上限：拒绝并给原因，不落盘', async () => {
  const env = await setup({
    overrides: { maxVideoBytes: 10 },
    bytesFor: (url) => (url.includes('.mp4') ? MP4 : null),
  })
  try {
    env.fake.privateRichMessage({
      from: OWNER, messageId: 8201,
      segments: [{ type: 'video', data: { url: 'https://cdn.example/v.mp4' } }],
    })
    await waitFor(() => env.qq.status().stats.mediaFailed >= 1)
    const [batch] = env.drain()
    assert.match(batch.text, /视频获取失败：.*超限/)
    assert.doesNotMatch(batch.text, /https?:\/\//)
    assert.equal(env.indexRows().length, 0)
  } finally { await env.cleanup() }
})

test('总量超过软上限：只告警（日志 + overSoftLimit），不拒绝、不删除', async () => {
  const logs = []
  const env = await setup({ overrides: { mediaSoftLimitBytes: 10 }, logs })
  try {
    env.fake.privateRichMessage({
      from: OWNER, messageId: 8202,
      segments: [{ type: 'image', data: { url: 'https://cdn.example/a.png' } }],
    })
    await waitFor(() => env.qq.status().media.saved >= 1)
    const media = env.qq.status().media
    assert.equal(media.overSoftLimit, true)
    assert.ok(logs.some((entry) => entry?.msg === 'qq.media.soft-limit'), '软告警要写日志')
    // 不拒绝、不删除：文件仍在
    assert.equal(env.indexRows().length, 1)
    assert.equal(fs.existsSync(env.indexRows()[0].path), true)
  } finally { await env.cleanup() }
})

test('视频类型不对：降级提示、不落盘、不影响消息', async () => {
  const env = await setup({ bytesFor: (url) => (url.includes('.mp4') ? PNG : null) })
  try {
    env.fake.privateRichMessage({
      from: OWNER, name: '主人', messageId: 8103,
      segments: [{ type: 'video', data: { url: 'https://cdn.example/not-video.mp4' } }],
    })
    await waitFor(() => env.qq.status().ledger.messages >= 1 && env.qq.status().stats.mediaFailed >= 1)
    const [batch] = env.drain()
    assert.match(batch.text, /视频获取失败/)
    assert.doesNotMatch(batch.text, /https?:\/\//)
    assert.equal(env.indexRows().length, 0)
  } finally { await env.cleanup() }
})

test('autoAlbum：owner 私聊图片自动进 album（source/tags/caption），群图默认不自动收', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-autoalbum-'))
  const fake = await createFakeOneBot({ port: 0, token: TOKEN })
  const host = createHost({ log: () => {} })
  const albumRoot = path.join(dir, 'album')
  host.registerPlugin(albumManifest, albumModule, { config: { root: albumRoot } })
  await host.enable('album')
  host.registerPlugin(manifest, qqModule, {
    config: {
      enabled: true, url: `ws://127.0.0.1:${fake.port}/`, token: TOKEN, selfId: SELF,
      allowPrivate: [OWNER], ownerQQ: OWNER,
      ledgerFile: path.join(dir, 'ledger.db'), mediaInboxDir: path.join(dir, 'media'),
      mediaFetchImpl: fakeFetch(() => PNG), autoAlbum: true, autoAlbumGroups: false,
      groupPolicy: 'allowlist', allowGroups: ['601357169'],
    },
  })
  await host.enable('qq')
  const qq = host.shared.get('qq')
  try {
    await waitFor(() => qq.status().connection.connected === true)
    fake.privateRichMessage({ from: OWNER, name: '主人', messageId: 8200, segments: [{ type: 'image', data: { url: 'https://cdn.example/a.png' } }, { type: 'text', data: { text: '主人发来的图' } }] })
    const album = host.shared.get('album')
    await waitFor(() => album.list({ source: 'qq' }).length >= 1)
    const row = album.list({ source: 'qq' })[0]
    assert.equal(row.source, 'qq')
    assert.ok(row.tags.includes('qq'))
    assert.match(row.caption ?? '', /主人发来的图/)

    fake.groupMessage({ groupId: 601357169, from: 10002, name: '群友', text: '群图', messageId: 8201 })
    await sleep(50)
    assert.equal(album.list({ source: 'qq' }).length, 1, '群图默认不自动进 album')
  } finally {
    try { host.disable('qq') } catch { /* 已停 */ }
    try { host.disable('album') } catch { /* 已停 */ }
    await fake.close()
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 偶发仍持有 sqlite 句柄，测试结束由系统清理 */ }
  }
})
