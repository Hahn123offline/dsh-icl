// 通用视频插件：工具面契约 + 本地样例视频端到端。
//
// 两类测试：
//   1. 本地样例（真 ffprobe + 假 CLI）：验证"图路径 + 可寻址清单 + 失败码"。
//   2. 真 ffmpeg：验证抽帧/拼帧；本机没有 ffmpeg 就 skip。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHost } from '../../../core/src/index.mjs'
import * as video from '../src/index.mjs'
import manifest from '../manifest.json' with { type: 'json' }

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const tempRoots = []
function tempRoot(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `icl-video-${tag}-`))
  tempRoots.push(dir)
  return dir
}
// 测试进程退出时清掉自己建的临时目录（同步；不依赖 after 钩子调度）。
process.on('exit', () => {
  for (const dir of tempRoots) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不影响测试结论 */ }
  }
})

function hasFfmpeg() {
  try {
    execFileSync(process.env.ICL_FFMPEG || 'ffmpeg', ['-version'], { stdio: 'ignore' })
    execFileSync(process.env.ICL_FFPROBE || 'ffprobe', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** 现场生成 2 秒样例片（testsrc + sine）。 */
function makeSample(root, name = 'sample.mp4') {
  const clip = path.join(root, name)
  fs.mkdirSync(path.dirname(clip), { recursive: true })
  execFileSync(process.env.ICL_FFMPEG || 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-shortest', '-pix_fmt', 'yuv420p', clip,
  ])
  return clip
}

/** 假 CLI：写一张 PNG + manifest，打印可解析的清单块（含一句台词）。 */
function writeFakeCli(dir) {
  const file = path.join(dir, 'fake-storyboard.mjs')
  fs.writeFileSync(file, `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
const out = args[args.indexOf('--out') + 1]
const man = args[args.indexOf('--manifest') + 1]
fs.writeFileSync(out, Buffer.from('${PNG_1X1}', 'base64'))
fs.writeFileSync(man, JSON.stringify({
  input: args[0], window: { from: 0, to: 2, duration: 2 },
  transcript: { source: 'subtitle', chars: 12 },
  sheets: [{ sheet: 1, cells: [{ i: 1, t_start: 0, t_end: 1, t_frame: 0.5 }, { i: 2, t_start: 1, t_end: 2, t_frame: 1.5 }] }],
}, null, 2))
console.log('[fake] ok')
console.log('<storyboard path="' + args[0] + '" duration="2.00" window="0.00-2.00" image="320x240" grid="2 cells x 1 image(s)" transcript="subtitle">')
console.log('cell 1 = 00:00.00-00:01.00')
console.log('    "第一句话在测试里"')
console.log('cell 2 = 00:01.00-00:02.00')
console.log('    "第二句话在这里"')
console.log('</storyboard>')
`, 'utf8')
  return file
}

function hostWith(config) {
  const host = createHost({ log: () => {} })
  host.registerPlugin(manifest, video, { config })
  return host
}

test('video：工具面 6 个，全部是本地视频入口（没有下载/上传）', async () => {
  const root = tempRoot('surface')
  const host = hostWith({ stateDir: root })
  await host.enable('video')
  const names = host.services.tools.names().sort()
  assert.deepEqual(names, ['video_frames', 'video_locate', 'video_open', 'video_probe', 'video_storyboard', 'video_zoom'])
  assert.ok(!names.some((n) => /download|upload|send/i.test(n)))
  await host.disable('video')
})

test('video_open：目录 → 列视频并给下一步；文件不存在/远程链接 → 稳定失败码', async () => {
  const root = tempRoot('open')
  const dir = path.join(root, 'clips')
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'a.mp4'), Buffer.from('not-a-real-video'))
  fs.writeFileSync(path.join(dir, '带 空格 的 视频.webm'), Buffer.from('EBML fake'))
  fs.writeFileSync(path.join(dir, 'b.txt'), 'ignore me')
  const host = hostWith({ stateDir: root })
  await host.enable('video')
  const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))

  const listed = await tools.video_open.execute({ path: dir, overview: false })
  assert.match(listed.text, /找到 2 个视频/)
  assert.match(listed.text, /a\.mp4/)
  assert.match(listed.text, /带 空格 的 视频\.webm/)

  const missing = await tools.video_open.execute({ path: path.join(root, 'nope.mp4') })
  assert.match(missing.text, /E_NOT_FOUND/)

  const remote = await tools.video_open.execute({ path: 'https://www.bilibili.com/video/BV1xx411c7mD' })
  assert.match(remote.text, /E_REMOTE_URL/)
  assert.match(remote.text, /bili_\*/)
  await host.disable('video')
})

test('假 CLI：video_storyboard / video_open / video_locate 的图 + 清单 + 定位', async (t) => {
  if (!hasFfmpeg()) {
    t.skip('本机没有 ffmpeg/ffprobe')
    return
  }
  const root = tempRoot('fake')
  const dir = path.join(root, 'media')
  fs.mkdirSync(dir)
  const clip = makeSample(dir)
  const host = hostWith({ stateDir: root, storyboardCli: writeFakeCli(dir) })
  await host.enable('video')
  const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))

  const story = await tools.video_storyboard.execute({ path: clip, from: 0, to: 2, cells: 2 })
  assert.match(story.text, /cell 1 = 00:00\.00-00:01\.00/)
  assert.match(story.text, /第一句话/)
  assert.equal(story.images.length, 1)
  assert.ok(fs.existsSync(story.images[0]))
  assert.ok(story.images[0].endsWith('.png'))

  const opened = await tools.video_open.execute({ path: clip, overview: true })
  assert.match(opened.text, /时长 2\.00s/)
  assert.equal(opened.images.length, 1)

  const located = await tools.video_locate.execute({ path: clip, query: '第一句话' })
  assert.match(located.text, /命中 1 处/)
  assert.match(located.text, /第 1 格/)

  const noTranscript = await tools.video_locate.execute({ path: clip, query: '不存在的话' })
  assert.ok(/没找到|没有可用台词/.test(noTranscript.text))
  await host.disable('video')
})

test('video_locate：无字幕轨且 ASR 关闭时直接短接（不碰远程默认 ASR、也不启动 CLI）', async (t) => {
  if (!hasFfmpeg()) {
    t.skip('本机没有 ffmpeg/ffprobe')
    return
  }
  const root = tempRoot('no-asr')
  const dir = path.join(root, 'media')
  fs.mkdirSync(dir)
  const clip = makeSample(dir) // testsrc + sine：有音轨、无字幕轨
  const marker = path.join(dir, 'cli-called.txt')
  const markerCli = path.join(dir, 'marker-cli.mjs')
  fs.writeFileSync(markerCli, `import fs from 'node:fs'\nfs.writeFileSync(${JSON.stringify(marker)}, '1')\n`, 'utf8')
  const host = hostWith({ stateDir: root, storyboardCli: markerCli, asr: false })
  await host.enable('video')
  const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))
  const out = await tools.video_locate.execute({ path: clip, query: 'hello' })
  assert.match(out.text, /没有字幕轨/)
  assert.match(out.text, /不会偷偷/)
  assert.match(out.text, /transcriptFile/)
  assert.equal(fs.existsSync(marker), false, '不该启动 storyboard CLI')
  await host.disable('video')
})

test('video_frames / video_probe：真实 ffmpeg 样例视频（缺依赖则 skip）', async (t) => {
  if (!hasFfmpeg()) {
    t.skip('本机没有 ffmpeg/ffprobe')
    return
  }
  const root = tempRoot('real')
  const clip = makeSample(root)
  const host = hostWith({ stateDir: root })
  await host.enable('video')
  const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))

  const probed = await tools.video_probe.execute({ path: clip })
  assert.match(probed.text, /时长 2\.0/)
  assert.match(probed.text, /320x240/)
  assert.match(probed.text, /音轨 有/)

  const one = await tools.video_frames.execute({ path: clip, at: 0.5 })
  assert.equal(one.images.length, 1)
  assert.ok(fs.existsSync(one.images[0]))

  const many = await tools.video_frames.execute({ path: clip, times: [0.2, 1.0, 1.8] })
  assert.equal(many.images.length, 1)
  assert.match(many.text, /#1=00:00\.20/)
  assert.match(many.text, /#3=00:01\.80/)
  await host.disable('video')
})

test('路径带空格/中文 + 刚 rename 完立刻调用（QQ 落盘场景，缺 ffmpeg 则 skip）', async (t) => {
  if (!hasFfmpeg()) {
    t.skip('本机没有 ffmpeg/ffprobe')
    return
  }
  const root = tempRoot('qq-path')
  const dir = path.join(root, '带 空格 的目录')
  fs.mkdirSync(dir, { recursive: true })
  // 模拟 QQ：先写 .part-*，再 rename 到最终路径；调用方不等任何索引。
  const part = makeSample(dir, '.part-abc123.mp4')
  const final = path.join(dir, '样例 视频.mp4')
  fs.renameSync(part, final)
  const host = hostWith({ stateDir: root })
  await host.enable('video')
  const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))

  const probed = await tools.video_probe.execute({ path: final })
  assert.match(probed.text, /时长 2\.0/)
  assert.ok(probed.text.includes('样例 视频.mp4'))
  const opened = await tools.video_open.execute({ path: final, overview: false })
  assert.match(opened.text, /时长 2\.0/)
  await host.disable('video')
})
