// B 站接入（C 路线）：工具面、只读白名单、错误归一化、凭证迁移、扫码登录。
//
// 不联网：runner / storyboard / fetch 全部可替换。
// 唯一的真子进程是本地 Python 的 `--list` / 写函数拒绝（不 import bilibili-api，几十毫秒）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHost } from '../../../core/src/index.mjs'
import * as bili from '../src/index.mjs'
import manifest from '../manifest.json' with { type: 'json' }
import { credentialExpiry } from '../src/login.mjs'
import { resolveConfig, venvPython, readStoryboardAuth, makeCaller } from '../src/runtime.mjs'

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function tempRoot(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `icl-bili-${tag}-`))
}

function baseConfig(root, extra = {}) {
  return {
    stateDir: root,
    pythonPath: process.execPath,
    legacyBiliDir: path.join(root, 'legacy-empty'),
    // 测试里不睡：限速/退避的默认值（1200ms/2 次）由专门的用例注入假 sleep 验证。
    minIntervalMs: 0,
    maxRetries: 0,
    callTimeoutMs: 5_000,
    // 不读用户真实的 ~/.dsh/video.json（避免测试依赖机器状态）。
    videoConfigPath: path.join(root, 'video.json'),
    ...extra,
  }
}

/** 假 runner：按 FAKE_MODE 返回固定 JSON。 */
function writeFakeRunner(dir) {
  const file = path.join(dir, 'fake-runner.mjs')
  fs.writeFileSync(file, `#!/usr/bin/env node
const fn = process.argv[2]
const mode = process.env.FAKE_MODE || 'ok'
if (mode === 'auth') { console.log(JSON.stringify({ ok: false, code: 'E_AUTH', error: 'B 站凭证缺失或已失效。', next: '用 bili_login_start 扫码续期' })); process.exit(1) }
if (mode === 'rate') { console.log(JSON.stringify({ ok: false, code: 'E_RATE_LIMIT', error: '被限流', next: '等一会' })); process.exit(1) }
const out = {
  bili_search: { keyword: 'x', count: 2, videos: [
    { bvid: 'BV1L7xm64EHP', title: '有 BV 的教程', author: 'UP1', play: 208543, duration: '25:37', description: 'd' },
    { bvid: '', title: '空卡片的广告位', author: 'ad', play: 1, duration: '' } ] },
  bili_video_info: { bvid: 'BV1L7xm64EHP', title: '有 BV 的教程', author: 'UP1', duration: 1537, description: '简介', stat: { view: 208543, danmaku: 322, reply: 3068, favorite: 25185 } },
  bili_subtitle: { bvid: 'BV1L7xm64EHP', title: '有 BV 的教程', language: '中文', segments: 2, text: '第一句字幕\\n第二句字幕' },
  bili_comments: { bvid: 'BV1L7xm64EHP', count: 1, comments: [{ rpid: 1, user: '观众', content: '好看', like: 5, reply_count: 2, top_replies: [{ user: '楼主', content: '谢谢' }] }] },
  bili_hot_videos: { page: 1, count: 2, videos: [
    { bvid: 'BV1EWxd6sExz', title: '热门 A', author: 'a', play: 492260, duration: 155 },
    { bvid: 'BV1Ph4b6fEa4', title: '热门 B', author: 'b', play: 193946, duration: 159 } ] },
  bili_rank: { category: 'all', count: 2, videos: [
    { bvid: 'BV1i24P6rEmt', title: '排行 A', author: 'c', play: 3895424, duration: 100 },
    { bvid: 'BV18wxY63Erp', title: '排行 B', author: 'd', play: 3727455, duration: 120 } ] },
  bili_weekly_hot: { periods: [{ number: 100, subject: '第100期' }] },
  bili_hot_buzzwords: { buzzwords: [{ name: '热词一' }, { name: '热词二' }] },
}[fn]
console.log(JSON.stringify(out ?? { ok: true, result: { fn } }))
`, 'utf8')
  return file
}

/** 假 storyboard CLI：写 PNG + 清单；FAKE_STORYBOARD_AUTH=anonymous 时模拟"匿名降级"。 */
function writeFakeStoryboard(dir) {
  const file = path.join(dir, 'fake-storyboard.mjs')
  fs.writeFileSync(file, `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
const out = args[args.indexOf('--out') + 1]
fs.writeFileSync(out, Buffer.from('${PNG_1X1}', 'base64'))
if (process.env.FAKE_STORYBOARD_AUTH === 'anonymous') console.error('[fetch] downloaded 0.9MB → 360p (source max 480p, auth=anonymous)')
console.log('<storyboard path="' + args[0] + '" duration="60.00" window="0.00-10.00" image="320x240" grid="2 cells x 1 image(s)">')
console.log('cell 1 = 00:00.00-00:05.00')
console.log('cell 2 = 00:05.00-00:10.00')
console.log('</storyboard>')
`, 'utf8')
  return file
}

function hostWith(config) {
  const host = createHost({ log: () => {} })
  host.registerPlugin(manifest, bili, { config })
  return host
}

test('bili：工具面只有只读 7 个，没有评论/私信/上传/收藏类工具', async () => {
  const root = tempRoot('surface')
  const host = hostWith(baseConfig(root, { runnerPath: writeFakeRunner(root) }))
  await host.enable('bili')
  const names = host.services.tools.names().sort()
  assert.deepEqual(names, [
    'bili_comments', 'bili_feed', 'bili_frames', 'bili_login_poll', 'bili_login_start', 'bili_search', 'bili_watch',
  ])
  assert.ok(!names.some((n) => /reply|send|upload|dynamic|favorite/i.test(n)))
  await host.disable('bili')
})

test('bili_search：清洗空 bvid；返回可读清单与 URL', async () => {
  const root = tempRoot('search')
  const host = hostWith(baseConfig(root, { runnerPath: writeFakeRunner(root) }))
  await host.enable('bili')
  const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))
  const out = await tools.bili_search.execute({ keyword: 'DSH', num: 5 })
  assert.match(out.text, /搜到 1 条/)
  assert.match(out.text, /有 BV 的教程/)
  assert.match(out.text, /BV1L7xm64EHP/)
  assert.doesNotMatch(out.text, /空卡片的广告位/)
  await host.disable('bili')
})

test('bili_watch / bili_comments：字幕与评论进可读文本；空 target 给可操作错误', async () => {
  const root = tempRoot('watch')
  const host = hostWith(baseConfig(root, { runnerPath: writeFakeRunner(root) }))
  await host.enable('bili')
  const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))

  const watch = await tools.bili_watch.execute({ target: 'https://www.bilibili.com/video/BV1L7xm64EHP' })
  assert.match(watch.text, /有 BV 的教程/)
  assert.match(watch.text, /第一句字幕/)

  const comments = await tools.bili_comments.execute({ target: 'BV1L7xm64EHP' })
  assert.match(comments.text, /好看/)
  assert.match(comments.text, /↳ 楼主/)

  const noTarget = await tools.bili_watch.execute({ target: '随便一个词' })
  assert.match(noTarget.text, /认不出 BV 号/)
  await host.disable('bili')
})

test('bili_feed：hot / rank / buzz 的归一化与条数', async () => {
  const root = tempRoot('feed')
  const host = hostWith(baseConfig(root, { runnerPath: writeFakeRunner(root) }))
  await host.enable('bili')
  const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))

  const hot = await tools.bili_feed.execute({ kind: 'hot', num: 1 })
  assert.match(hot.text, /B 站热门/)
  assert.match(hot.text, /热门 A/)
  // rank 会按 num 截断
  const rank = await tools.bili_feed.execute({ kind: 'rank', num: 1 })
  assert.match(rank.text, /B 站排行榜（1 条）/)
  const buzz = await tools.bili_feed.execute({ kind: 'buzz' })
  assert.match(buzz.text, /热词一/)
  await host.disable('bili')
})

test('错误归一化：runner 的 E_AUTH / E_RATE_LIMIT 原样变成可操作文本', async () => {
  const root = tempRoot('errors')
  const runner = writeFakeRunner(root)
  const host = hostWith(baseConfig(root, { runnerPath: runner }))
  await host.enable('bili')
  const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))
  process.env.FAKE_MODE = 'auth'
  try {
    const out = await tools.bili_search.execute({ keyword: 'x' })
    assert.match(out.text, /E_AUTH/)
    assert.match(out.text, /bili_login_start/)
  } finally {
    delete process.env.FAKE_MODE
  }
  process.env.FAKE_MODE = 'rate'
  try {
    const out = await tools.bili_watch.execute({ target: 'BV1L7xm64EHP' })
    assert.match(out.text, /E_RATE_LIMIT/)
  } finally {
    delete process.env.FAKE_MODE
  }
  await host.disable('bili')
})

test('缺依赖：preflight 逐条给可操作错误（不假装是视频/网络问题）', async () => {
  const root = tempRoot('preflight')
  const host = hostWith({
    stateDir: root,
    pythonPath: path.join(root, 'no-python.exe'),
    runnerPath: path.join(root, 'no-runner.py'),
    vendorDir: path.join(root, 'no-vendor'),
    legacyBiliDir: path.join(root, 'legacy-empty'),
  })
  await host.enable('bili')
  const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))
  const out = await tools.bili_search.execute({ keyword: 'x' })
  assert.match(out.text, /BILI_PYTHON|BILI_RUNNER|BILI_VENDOR/)
  assert.match(out.text, /不是视频\/网络的问题/)
  await host.disable('bili')
})

test('凭证迁移：旧家目录的文件只复制一次，写进 ICL stateDir（内容不打印）', async () => {
  const root = tempRoot('migrate')
  const legacy = path.join(root, 'legacy')
  fs.mkdirSync(legacy, { recursive: true })
  fs.writeFileSync(path.join(legacy, 'bili_credential.json'), '{"sessdata":"fake","bili_jct":"x","buvid3":"y","dedeuserid":"1"}')
  const host = hostWith(baseConfig(root, { legacyBiliDir: legacy, runnerPath: writeFakeRunner(root) }))
  await host.enable('bili')
  const target = path.join(root, 'bili', 'bili_credential.json')
  assert.ok(fs.existsSync(target), '凭证应复制到 ICL stateDir')
  assert.equal(fs.readFileSync(target, 'utf8'), fs.readFileSync(path.join(legacy, 'bili_credential.json'), 'utf8'))
  await host.disable('bili')
})

test('扫码登录：假 fetch → 拿到 key；poll 成功 → 原子写凭证；到期时间可解析', async () => {
  const root = tempRoot('login')
  const qr = { data: { qrcode_key: 'k-123', url: 'https://passport.example/qr' } }
  const okPoll = {
    headers: { getSetCookie: () => [
      'SESSDATA=abc%2C1808222266%2Cdef; Path=/; Domain=.bilibili.com',
      'bili_jct=ct; Path=/',
      'DedeUserID=42; Path=/',
      'buvid3=bv; Path=/',
    ] },
    json: async () => ({ data: { code: 0 } }),
  }
  let calls = 0
  const fetchImpl = async (url) => {
    calls += 1
    if (url.includes('qrcode/generate')) return { json: async () => qr }
    if (url.includes('qrcode/poll')) return okPoll
    if (url.includes('finger/spi')) return { json: async () => ({ data: { b_3: 'fp' } }) }
    throw new Error(`unexpected url ${url}`)
  }
  // renderQrPng 用不到 python（这里是 node），失败会降级成只给 URL。
  const host = hostWith(baseConfig(root, { fetchImpl, pythonPath: path.join(root, 'no-python'), runnerPath: writeFakeRunner(root) }))
  await host.enable('bili')
  const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))

  const started = await tools.bili_login_start.execute({})
  assert.match(started.text, /k-123/)
  assert.equal(started.images.length, 0, '没有 python 时不应假装有二维码 PNG')

  const polled = await tools.bili_login_poll.execute({ key: 'k-123' })
  assert.match(polled.text, /登录成功/)
  assert.match(polled.text, /SESSDATA 到期/)
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'bili', 'bili_credential.json'), 'utf8'))
  assert.equal(saved.sessdata, 'abc%2C1808222266%2Cdef')
  assert.equal(saved.dedeuserid, '42')
  assert.ok(calls >= 2)
  const expire = credentialExpiry({ sessdata: 'abc%2C1808222266%2Cdef' })
  assert.equal(expire, 1808222266 * 1000)
  await host.disable('bili')
})

test('bili_frames：假 storyboard CLI → 图路径 + 清单（图由桥接层提交成 attachment）', async () => {
  const root = tempRoot('frames')
  const fake = writeFakeStoryboard(root)
  const host = hostWith(baseConfig(root, { runnerPath: writeFakeRunner(root), storyboardCli: fake }))
  await host.enable('bili')
  const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))
  const out = await tools.bili_frames.execute({ target: 'BV1L7xm64EHP', from: 0, to: 10, cells: 2 })
  assert.match(out.text, /cell 1 = 00:00\.00-00:05\.00/)
  assert.equal(out.images.length, 1)
  assert.ok(out.images[0].endsWith('.png'))
  await host.disable('bili')
})

test('真 runner 的只读白名单：--list 正常，写函数被拒（不 import bilibili-api）', (t) => {
  const python = process.env.BILI_PYTHON || 'C:\\Users\\ai_admin\\.dsh\\bili-duty\\.venv\\Scripts\\python.exe'
  const probe = spawnSync(python, ['-c', 'print(1)'], { encoding: 'utf8' })
  if (probe.status !== 0) {
    t.skip('本机没有可用的 python')
    return
  }
  const runner = path.resolve(import.meta.dirname, '../../../../tools/bili-run.py')
  const listed = JSON.parse(spawnSync(python, [runner, '--list'], { encoding: 'utf8' }).stdout)
  assert.ok(listed.allowed.includes('bili_search'))
  assert.ok(!listed.allowed.includes('bili_reply'))
  const denied = JSON.parse(spawnSync(python, [runner, 'bili_reply', '{}'], { encoding: 'utf8' }).stdout)
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'E_READ_ONLY')
})

/* ── venv 迁移 / cookies 到期 / 限速退避（2026-11-06 收尾） ───────────── */

test('venv 解析：显式 > ICL stateDir venv > 旧 venv 兼容回退 > missing', () => {
  const root = tempRoot('venv')
  const legacy = path.join(root, 'legacy')
  const legacyPython = venvPython(path.join(legacy, '.venv'))
  fs.mkdirSync(path.dirname(legacyPython), { recursive: true })
  fs.writeFileSync(legacyPython, '')

  const base = { stateDir: root, legacyBiliDir: legacy }
  const fallback = resolveConfig({ config: base })
  assert.equal(fallback.pythonSource, 'legacy-compat')
  assert.equal(fallback.pythonPath, legacyPython)

  const ownPython = venvPython(path.join(root, 'bili', '.venv'))
  fs.mkdirSync(path.dirname(ownPython), { recursive: true })
  fs.writeFileSync(ownPython, '')
  const own = resolveConfig({ config: base })
  assert.equal(own.pythonSource, 'icl')
  assert.equal(own.pythonPath, ownPython)

  const explicit = resolveConfig({ config: { ...base, pythonPath: 'C:/custom/python.exe' } })
  assert.equal(explicit.pythonSource, 'explicit')
  assert.equal(explicit.pythonPath, 'C:/custom/python.exe')

  const missing = resolveConfig({ config: { stateDir: path.join(root, 'empty'), legacyBiliDir: path.join(root, 'empty-legacy') } })
  assert.equal(missing.pythonSource, 'missing')
  assert.equal(missing.pythonPath, venvPython(path.join(root, 'empty', 'bili', '.venv')))
})

test('storyboard cookies：只读到到期列，给出"还会不会变糊"的可操作警告', () => {
  const root = tempRoot('cookies')
  const videoJson = path.join(root, 'video.json')
  const day = 86_400_000
  const now = Date.parse('2026-11-06T00:00:00Z')

  const unconfigured = readStoryboardAuth({ videoConfigPath: videoJson, now })
  assert.equal(unconfigured.status, 'unconfigured')
  assert.match(unconfigured.warning, /没有配置 cookies/)
  assert.match(unconfigured.warning, /VIDEO-EYES\.md §11/)

  const missingPath = path.join(root, 'nope.txt')
  fs.writeFileSync(videoJson, JSON.stringify({ cookies: missingPath }))
  const missing = readStoryboardAuth({ videoConfigPath: videoJson, now })
  assert.equal(missing.status, 'missing')
  assert.match(missing.warning, /文件不存在/)

  const cookies = (expirySec) => [
    '# Netscape HTTP Cookie File',
    `.bilibili.com\tTRUE\t/\tFALSE\t${expirySec}\tSESSDATA\tFAKE-SECRET-VALUE`,
    `.bilibili.com\tTRUE\t/\tFALSE\t${expirySec}\tDedeUserID\tFAKE-ID`,
  ].join('\n')
  const file = path.join(root, 'cookies.txt')
  fs.writeFileSync(file, cookies(Math.floor((now + 30 * day) / 1000)))
  fs.writeFileSync(videoJson, JSON.stringify({ cookies: file }))
  const okState = readStoryboardAuth({ videoConfigPath: videoJson, now })
  assert.equal(okState.status, 'ok')
  assert.equal(okState.warning, null)
  assert.ok(okState.expiresAt > now)

  fs.writeFileSync(file, cookies(Math.floor((now + 3 * day) / 1000)))
  const soon = readStoryboardAuth({ videoConfigPath: videoJson, now })
  assert.match(soon.warning, /天后到期/)
  assert.doesNotMatch(soon.warning, /FAKE-SECRET-VALUE/)

  fs.writeFileSync(file, cookies(Math.floor((now - day) / 1000)))
  const expired = readStoryboardAuth({ videoConfigPath: videoJson, now })
  assert.match(expired.warning, /已过期/)
  assert.match(expired.warning, /480P/)
})

/** 假 runner：前 N 次失败（FAKE_CODE），之后成功；计数器落在 FAKE_COUNTER 文件。 */
function writeFlakyRunner(dir) {
  const file = path.join(dir, 'flaky-runner.mjs')
  fs.writeFileSync(file, `#!/usr/bin/env node
import fs from 'node:fs'
const counter = process.env.FAKE_COUNTER
let n = 0
try { n = Number(fs.readFileSync(counter, 'utf8')) || 0 } catch { n = 0 }
n += 1
fs.writeFileSync(counter, String(n))
const fails = Number(process.env.FAKE_FAILS || 0)
const code = process.env.FAKE_CODE || 'E_RATE_LIMIT'
if (n <= fails) {
  console.log(JSON.stringify({ ok: false, code, error: 'retry me', next: 'wait' }))
  process.exit(1)
}
console.log(JSON.stringify({ ok: true, result: { bvid: 'BV1L7xm64EHP' } }))
`, 'utf8')
  return file
}

function callerCfg(root, runner, extra = {}) {
  return resolveConfig({
    config: {
      stateDir: root,
      pythonPath: process.execPath,
      runnerPath: runner,
      legacyBiliDir: path.join(root, 'legacy-empty'),
      videoConfigPath: path.join(root, 'video.json'),
      callTimeoutMs: 5_000,
      ...extra,
    },
  })
}

test('限速/退避：风控/超时按指数退避重试，E_AUTH 不重试', async () => {
  const root = tempRoot('retry')
  const runner = writeFlakyRunner(root)
  const counter = path.join(root, 'calls.txt')
  const calls = () => { try { return Number(fs.readFileSync(counter, 'utf8')) || 0 } catch { return 0 } }

  process.env.FAKE_COUNTER = counter
  process.env.FAKE_FAILS = '2'
  process.env.FAKE_CODE = 'E_RATE_LIMIT'
  try {
    const sleeps = []
    const caller = makeCaller(callerCfg(root, runner, { maxRetries: 2, retryBaseMs: 100, retryMaxMs: 500, minIntervalMs: 0 }), {
      sleep: async (ms) => { sleeps.push(ms) },
      now: () => 0,
    })
    const result = await caller('bili_search', { keyword: 'x' })
    assert.equal(result.ok, true)
    assert.equal(calls(), 3, '2 次失败 + 1 次成功')
    assert.equal(sleeps.length, 2)
    assert.ok(sleeps[1] > sleeps[0], `退避应递增：${sleeps.join(',')}`)
  } finally {
    delete process.env.FAKE_COUNTER
    delete process.env.FAKE_FAILS
    delete process.env.FAKE_CODE
  }

  fs.writeFileSync(counter, '0')
  process.env.FAKE_COUNTER = counter
  process.env.FAKE_FAILS = '9'
  process.env.FAKE_CODE = 'E_AUTH'
  try {
    const caller = makeCaller(callerCfg(root, runner, { maxRetries: 3, retryBaseMs: 100, minIntervalMs: 0 }), {
      sleep: async () => {},
      now: () => 0,
    })
    const result = await caller('bili_search', { keyword: 'x' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'E_AUTH')
    assert.equal(calls(), 1, 'E_AUTH 重试也没用，不应重试')
  } finally {
    delete process.env.FAKE_COUNTER
    delete process.env.FAKE_FAILS
    delete process.env.FAKE_CODE
  }
})

test('限速：同一插件实例的调用串行且至少间隔 minIntervalMs', async () => {
  const root = tempRoot('interval')
  const runner = writeFlakyRunner(root)
  const counter = path.join(root, 'calls.txt')
  process.env.FAKE_COUNTER = counter
  process.env.FAKE_FAILS = '0'
  try {
    let clock = 1000
    const sleeps = []
    const caller = makeCaller(callerCfg(root, runner, { minIntervalMs: 1000, maxRetries: 0 }), {
      sleep: async (ms) => { sleeps.push(ms); clock += ms },
      now: () => clock,
    })
    await caller('bili_search', { keyword: 'a' })
    await caller('bili_search', { keyword: 'b' })
    assert.ok(sleeps.some((ms) => ms >= 1000), `第二次调用前应等待 ≥1000ms，实际：${sleeps.join(',')}`)
  } finally {
    delete process.env.FAKE_COUNTER
    delete process.env.FAKE_FAILS
  }
})

test('bili_frames：cookies 缺失 + CLI 匿名降级 → 文本明确说"会糊"并给 runbook', async () => {
  const root = tempRoot('frames-warn')
  const fake = writeFakeStoryboard(root)
  const host = hostWith(baseConfig(root, { runnerPath: writeFakeRunner(root), storyboardCli: fake }))
  await host.enable('bili')
  const tools = Object.fromEntries(host.services.tools.list().map((t) => [t.name, t]))
  process.env.FAKE_STORYBOARD_AUTH = 'anonymous'
  try {
    const out = await tools.bili_frames.execute({ target: 'BV1L7xm64EHP', from: 0, to: 10, cells: 2 })
    assert.match(out.text, /没有配置 cookies/)
    assert.match(out.text, /匿名/)
    assert.match(out.text, /VIDEO-EYES\.md §11/)
    assert.equal(out.images.length, 1)
  } finally {
    delete process.env.FAKE_STORYBOARD_AUTH
    await host.disable('bili')
  }
})
