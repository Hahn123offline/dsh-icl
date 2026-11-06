// 路径契约：一个 ICL_ROOT 推所有可写目录；config > env > 默认；旧路径可读。
//
// 这些测试同时是"不写死盘符"的守门员：任何运行时代码里再出现 C:/DSH、C:\Users\...
// 会让最后一条用例失败（历史审计文档不在扫描范围）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ICL_LAYOUT, REPO_ROOT, iclPaths, iclRoot } from '../src/icl-paths.mjs'
import { normalizeConfig } from '../../dsh-icl/src/config.mjs'
import { configFor } from '../../dsh-icl/src/bootstrap.mjs'

const sep = path.sep

function tmp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `icl-paths-${tag}-`))
}

function touch(file, text = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, 'utf8')
  return file
}

function listFiles(root) {
  const out = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) out.push(full)
    }
  }
  walk(root)
  return out
}

test('默认根是 <仓库根>/.state，所有目录都从它推出来', () => {
  const home = tmp('home-default')
  const paths = iclPaths({ env: {}, repoRoot: REPO_ROOT, dshHomeDir: home, legacy: false })
  assert.equal(paths.root, path.join(REPO_ROOT, '.state'))
  assert.equal(paths.stateDir, path.join(paths.root, ICL_LAYOUT.state))
  assert.equal(paths.homeDir, path.join(paths.root, ICL_LAYOUT.home))
  assert.equal(paths.mediaDir, path.join(paths.root, ICL_LAYOUT.media))
  assert.equal(paths.albumDir, path.join(paths.root, ICL_LAYOUT.album))
  assert.equal(paths.qqInboxDir, path.join(paths.root, 'inbox', 'qq'))
  assert.equal(paths.videoTmpDir, path.join(paths.root, 'video-tmp'))
  assert.equal(paths.stickersDir, path.join(paths.root, 'media', 'stickers'))
  assert.equal(paths.locksDir, path.join(paths.root, 'locks'))
  assert.equal(paths.sandboxWorkspaceRoot, paths.homeDir)
  // 每个默认目录都在根里面（不是散落的绝对路径）。
  for (const key of ['stateDir', 'homeDir', 'mediaDir', 'albumDir', 'qqInboxDir', 'videoTmpDir', 'stickersDir', 'locksDir', 'sandboxWorkspaceRoot']) {
    assert.ok(paths[key].startsWith(`${paths.root}${sep}`), `${key} 应该在根内：${paths[key]}`)
  }
  assert.deepEqual(paths.legacy.used, [])
})

test('优先级：显式 config > env > 默认', () => {
  const repo = tmp('repo-priority')
  const cfgRoot = path.join(tmp('cfg-priority'), 'icl')
  const envRoot = path.join(tmp('env-priority'), 'icl')

  assert.equal(iclRoot({ root: cfgRoot, env: { ICL_ROOT: envRoot }, repoRoot: repo }), path.resolve(cfgRoot))
  assert.equal(iclRoot({ env: { ICL_ROOT: envRoot }, repoRoot: repo }), path.resolve(envRoot))
  assert.equal(iclRoot({ env: {}, repoRoot: repo }), path.join(repo, '.state'))

  const explicit = iclPaths({ root: cfgRoot, env: { ICL_ROOT: envRoot }, repoRoot: repo, dshHomeDir: tmp('h1'), legacy: false })
  assert.equal(explicit.root, path.resolve(cfgRoot))
  assert.equal(explicit.stateDir, path.join(path.resolve(cfgRoot), 'state'))

  const fromEnv = iclPaths({ env: { ICL_ROOT: envRoot }, repoRoot: repo, dshHomeDir: tmp('h2'), legacy: false })
  assert.equal(fromEnv.root, path.resolve(envRoot))
})

test('每类路径也能单独覆盖：config > 该类的 env > 根下的默认', () => {
  const root = tmp('per-kind-root')
  const envRoot = tmp('per-kind-env')
  const home = tmp('per-kind-home')
  const paths = iclPaths({
    root,
    env: {
      ICL_ROOT: envRoot,
      ICL_STATE_DIR: path.join(envRoot, 'env-state'),
      ICL_ALBUM_DIR: path.join(envRoot, 'env-album'),
      ICL_QQ_INBOX_DIR: path.join(envRoot, 'env-inbox'),
    },
    repoRoot: tmp('per-kind-repo'),
    dshHomeDir: home,
    legacy: false,
    // 显式 config 只覆盖前两类，后一类让 env 生效。
    stateDir: path.join(root, 'explicit-state'),
    albumDir: 'relative-album',
  })
  assert.equal(paths.stateDir, path.join(root, 'explicit-state'))
  // 相对路径锚到 ICL_ROOT，而不是仓库根或 cwd。
  assert.equal(paths.albumDir, path.join(root, 'relative-album'))
  assert.equal(paths.qqInboxDir, path.join(envRoot, 'env-inbox'))
  assert.equal(paths.videoTmpDir, path.join(root, 'video-tmp'))
})

test('旧路径兼容：新目录不存在时读旧 state/相册/QQ 入站目录；新目录出现后切回新根', () => {
  const repo = tmp('legacy-repo')
  const home = tmp('legacy-home')
  const oldState = path.join(home, 'icl', 'state')
  touch(path.join(oldState, 'memory.db'))
  touch(path.join(oldState, 'media', 'media.db'))

  const before = iclPaths({ repoRoot: repo, dshHomeDir: home, env: {} })
  assert.equal(before.stateDir, oldState, '新根 state 还不存在 → 继续读旧 stateDir')
  assert.equal(before.albumDir, path.join(oldState, 'media'), '旧相册根也继续可读')
  assert.ok(before.legacy.used.includes('stateDir'))
  assert.ok(before.legacy.used.includes('albumDir'))

  // 新根创建出 state/ 与 album/ 后，默认切到新根，不再被旧目录劫持。
  fs.mkdirSync(path.join(repo, '.state', 'state'), { recursive: true })
  fs.mkdirSync(path.join(repo, '.state', 'album'), { recursive: true })
  const after = iclPaths({ repoRoot: repo, dshHomeDir: home, env: {} })
  assert.equal(after.stateDir, path.join(repo, '.state', 'state'))
  assert.equal(after.albumDir, path.join(repo, '.state', 'album'))
  assert.deepEqual(after.legacy.used, [])
})

test('旧 QQ 入站目录 <root>/media/inbox/qq 仍可读，新 inbox/qq 出现后优先新路径', () => {
  const repo = tmp('qq-legacy-repo')
  const home = tmp('qq-legacy-home')
  touch(path.join(repo, '.state', 'media', 'inbox', 'qq', 'a.png'))
  const legacy = iclPaths({ repoRoot: repo, dshHomeDir: home, env: {} })
  assert.equal(legacy.qqInboxDir, path.join(repo, '.state', 'media', 'inbox', 'qq'))
  assert.ok(legacy.legacy.used.includes('qqInboxDir'))

  fs.mkdirSync(path.join(repo, '.state', 'inbox', 'qq'), { recursive: true })
  const current = iclPaths({ repoRoot: repo, dshHomeDir: home, env: {} })
  assert.equal(current.qqInboxDir, path.join(repo, '.state', 'inbox', 'qq'))
})

test('normalizeConfig：state/album/qq/video 全部来自同一个根，config 覆盖 env', () => {
  const envRoot = path.join(tmp('cfg-env'), 'root')
  const home = tmp('cfg-home')
  const env = { ICL_ROOT: envRoot, DSH_HOME: home }

  const fromEnv = normalizeConfig({}, { env })
  assert.equal(fromEnv.iclRoot, path.resolve(envRoot))
  assert.equal(fromEnv.stateDir, path.join(path.resolve(envRoot), 'state'))
  assert.equal(fromEnv.albumDir, path.join(path.resolve(envRoot), 'album'))
  assert.equal(fromEnv.qqInboxDir, path.join(path.resolve(envRoot), 'inbox', 'qq'))
  assert.equal(fromEnv.videoTmpDir, path.join(path.resolve(envRoot), 'video-tmp'))

  const explicit = tmp('cfg-explicit')
  const overridden = normalizeConfig({ iclRoot: envRoot, stateDir: explicit }, { env })
  assert.equal(overridden.stateDir, path.resolve(explicit), '显式 stateDir 优先于 env ICL_ROOT')

  // 插件的默认值只认解析结果，不再自己拼 cwd 或 .state。
  assert.equal(configFor('album', fromEnv).root, fromEnv.albumDir)
  assert.equal(configFor('video', fromEnv).stateDir, fromEnv.videoTmpDir)
  assert.equal(configFor('qq', fromEnv).mediaInboxDir, fromEnv.qqInboxDir)
  assert.equal(configFor('mc-link', fromEnv).logFile, path.join(fromEnv.stateDir, 'mc-link.jsonl'))
})

test('默认配置不把绝对路径写进代码：运行时源码/预设里没有 C:/DSH、C:\\Users\\...', () => {
  const runtimeRoots = [
    path.join(REPO_ROOT, 'packages', 'core', 'src'),
    path.join(REPO_ROOT, 'packages', 'dsh-icl', 'src'),
    path.join(REPO_ROOT, 'packages', 'dsh-icl', 'presets'),
    path.join(REPO_ROOT, 'packages', 'mc-body', 'src'),
    path.join(REPO_ROOT, 'packages', 'mc-body', 'tools'),
  ]
  const pluginDir = path.join(REPO_ROOT, 'packages', 'plugins')
  for (const entry of fs.readdirSync(pluginDir, { withFileTypes: true })) {
    if (entry.isDirectory()) runtimeRoots.push(path.join(pluginDir, entry.name, 'src'))
  }
  const files = []
  for (const root of runtimeRoots) {
    if (fs.statSync(root).isFile()) files.push(root)
    else files.push(...listFiles(root))
  }
  const pattern = /\b[A-Za-z]:[\\/]{1,2}(?:DSH|Users)[\\/]{1,2}/i
  const offenders = []
  for (const file of files) {
    if (!/\.(mjs|yml|yaml|json)$/i.test(file)) continue
    const text = fs.readFileSync(file, 'utf8')
    const match = pattern.exec(text)
    if (match) offenders.push(`${path.relative(REPO_ROOT, file)}: ${match[0]}`)
  }
  assert.deepEqual(offenders, [], `运行时代码里仍有写死的绝对路径：\n${offenders.join('\n')}`)
})

test('lab 预设的 workspaceRoot 是占位符，由 lab 工具按 --workspace 物化', () => {
  const template = fs.readFileSync(path.join(REPO_ROOT, 'packages', 'dsh-icl', 'presets', 'lab.patch.yml'), 'utf8')
  assert.match(template, /workspaceRoot: '__LAB_WORKSPACE__'/)
  assert.doesNotMatch(template, /C:[/\\]DSH/i)

  const product = fs.readFileSync(path.join(REPO_ROOT, 'packages', 'dsh-icl', 'presets', 'icl.patch.yml'), 'utf8')
  assert.doesNotMatch(product, /stateDir:\s*[A-Za-z]:[/\\]/, 'preset 的 stateDir 必须是相对 ICL_ROOT 的数据路径')
})
