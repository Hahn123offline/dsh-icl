// ICL 的统一路径根：所有可写目录都从 ICL_ROOT 推出来，代码里不写死盘符。
//
// 为什么要有它：记忆库、时间/聚焦状态、相册、QQ 入站媒体、视频临时产物、锁、
// 沙箱工作区如果各写各的默认值，换机/换盘就必须逐个改代码。现在只有一处知道
// "东西放哪儿"，其余地方只拿解析好的绝对路径。
//
// 优先级（每一类路径独立判断）：
//   显式 config  >  环境变量  >  默认（<ICL_ROOT>/<固定布局>）
// ICL_ROOT 本身：config.iclRoot > env ICL_ROOT > <REPO_ROOT>/.state。
// 相对路径一律相对 ICL_ROOT 解析（仓库内的只读资产仍走 dsh-icl 的 resolvePath）。
//
// 向后兼容：新默认根就是仓库根 .state，所以旧的 .state/lab、.state/locks、
// .state/mc-* 原地不动。更早的 dsh-icl 默认 stateDir（$DSH_HOME/icl/state）与
// 旧 QQ 入站目录（<root>/media/inbox/qq）在新目录还不存在、旧目录存在时继续解析
// 到旧目录（只读兼容）；确认无误后用 tools/icl-move.mjs 搬到新根。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** packages/ */
export const PACKAGES_ROOT = path.resolve(HERE, '..', '..')
/** 仓库根：packages/core/src → ../../.. */
export const REPO_ROOT = path.resolve(PACKAGES_ROOT, '..')

/**
 * 根目录下的固定布局。所有默认值只拼这里，测试也用它断言"没有写死盘符"。
 * 注意 media/inbox/qq 旧位置仍作为兼容候选（见 legacyQqInboxDirs）。
 */
export const ICL_LAYOUT = Object.freeze({
  home: 'home',
  state: 'state',
  media: 'media',
  album: 'album',
  qqInbox: path.join('inbox', 'qq'),
  videoTmp: 'video-tmp',
  stickers: path.join('media', 'stickers'),
  locks: 'locks',
})

/** 每类路径可用的环境变量名；显式 config 永远优先于它们。 */
export const ICL_ENV = Object.freeze({
  root: 'ICL_ROOT',
  stateDir: 'ICL_STATE_DIR',
  homeDir: 'ICL_HOME_DIR',
  mediaDir: 'ICL_MEDIA_DIR',
  albumDir: 'ICL_ALBUM_DIR',
  qqInboxDir: 'ICL_QQ_INBOX_DIR',
  videoTmpDir: 'ICL_VIDEO_TMP_DIR',
  stickersDir: 'ICL_STICKERS_DIR',
  locksDir: 'ICL_LOCKS_DIR',
  sandboxWorkspaceRoot: 'ICL_SANDBOX_WORKSPACE',
})

export function dshHome(env = process.env) {
  const fromEnv = clean(env?.DSH_HOME)
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), '.dsh')
}

function clean(value) {
  return value == null ? '' : String(value).trim()
}

/** 绝对路径原样归一化；相对路径锚到 base（默认 ICL_ROOT）。空值返回 ''。 */
export function resolveFrom(base, value) {
  const raw = clean(value)
  if (!raw) return ''
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(base, raw)
}

/** ICL_ROOT：显式 > env > <REPO_ROOT>/.state。相对值锚到 repoRoot。 */
export function iclRoot({ root, env = process.env, repoRoot = REPO_ROOT } = {}) {
  const explicit = clean(root)
  const fromEnv = clean(env?.[ICL_ENV.root])
  return resolveFrom(repoRoot, explicit || fromEnv || path.join(repoRoot, '.state'))
}

function isDir(target) {
  try { return fs.statSync(target).isDirectory() } catch { return false }
}

function unique(list) {
  const seen = new Set()
  const out = []
  for (const item of list) {
    const value = clean(item)
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

/**
 * 解析一整组 ICL 路径。返回的对象里每个值都是绝对路径。
 *
 * @param {object} [options]
 * @param {string} [options.root]                 ICL_ROOT 覆盖（config）
 * @param {object} [options.env]                  环境变量源（默认 process.env；测试可注入）
 * @param {string} [options.repoRoot]             仓库根（测试可注入）
 * @param {string} [options.dshHomeDir]           DSH 家目录（测试可注入）
 * @param {boolean} [options.legacy]              false = 只算纯默认，不看旧目录
 * @param {...string} [options.stateDir|albumDir|qqInboxDir|...] 每类显式 config
 * @returns {{root:string,homeDir:string,stateDir:string,mediaDir:string,albumDir:string,
 *   qqInboxDir:string,videoTmpDir:string,stickersDir:string,locksDir:string,
 *   sandboxWorkspaceRoot:string,layout:object,legacy:{enabled:boolean,used:string[],candidates:object}}}
 */
export function iclPaths(options = {}) {
  const {
    root,
    env = process.env,
    repoRoot = REPO_ROOT,
    dshHomeDir,
    legacy = true,
    legacyStateDirs,
    legacyAlbumDirs,
    legacyQqInboxDirs,
    stateDir,
    homeDir,
    mediaDir,
    albumDir,
    qqInboxDir,
    videoTmpDir,
    stickersDir,
    locksDir,
    sandboxWorkspaceRoot,
  } = options

  const resolvedRoot = iclRoot({ root, env, repoRoot })
  const dsh = dshHomeDir ? path.resolve(String(dshHomeDir)) : dshHome(env)
  const used = []
  const candidates = {}

  /**
   * 单类路径解析：显式 config > env > 默认；legacy=true 时在"默认还不存在"
   * 的情况下退到旧目录（只读兼容），并把类别名记进 used。
   */
  const pick = (name, explicit, envKey, fallback, legacyDirs = []) => {
    const fromConfig = resolveFrom(resolvedRoot, explicit)
    if (fromConfig) return fromConfig
    const fromEnv = resolveFrom(resolvedRoot, env?.[envKey])
    if (fromEnv) return fromEnv
    candidates[name] = unique([fallback, ...legacyDirs])
    if (legacy && !isDir(fallback)) {
      for (const candidate of legacyDirs) {
        const dir = resolveFrom(resolvedRoot, candidate)
        if (dir && dir !== fallback && isDir(dir)) {
          used.push(name)
          return dir
        }
      }
    }
    return fallback
  }

  // 旧 dsh-icl 默认 stateDir：$DSH_HOME/icl/state。显式传入的 legacyStateDirs 优先。
  const stateLegacy = legacyStateDirs ?? [path.join(dsh, 'icl', 'state')]
  // state 先解析：相册/QQ 的旧位置跟着"实际使用的 stateDir"走（旧配置可能把 state 指到别处）。
  const resolvedState = pick('stateDir', stateDir, ICL_ENV.stateDir, path.join(resolvedRoot, ICL_LAYOUT.state), stateLegacy)
  // 旧相册根：<旧 stateDir>/media（历史 bootstrap 传的是 stateDir/media）。
  const albumLegacy = legacyAlbumDirs ?? [
    path.join(resolvedState, 'media'),
    path.join(dsh, 'icl', 'state', 'media'),
  ]
  // 旧 QQ 入站根：<root>/media/inbox/qq（repo 根 .state 时期）或旧 stateDir 下同构目录。
  const qqLegacy = legacyQqInboxDirs ?? [
    path.join(resolvedRoot, 'media', 'inbox', 'qq'),
    path.join(resolvedState, 'media', 'inbox', 'qq'),
    path.join(repoRoot, '.state', 'media', 'inbox', 'qq'),
    path.join(dsh, 'icl', 'state', 'media', 'inbox', 'qq'),
  ]

  const resolvedHome = pick('homeDir', homeDir, ICL_ENV.homeDir, path.join(resolvedRoot, ICL_LAYOUT.home))
  const resolvedMedia = pick('mediaDir', mediaDir, ICL_ENV.mediaDir, path.join(resolvedRoot, ICL_LAYOUT.media))
  const paths = {
    root: resolvedRoot,
    homeDir: resolvedHome,
    stateDir: resolvedState,
    mediaDir: resolvedMedia,
    albumDir: pick('albumDir', albumDir, ICL_ENV.albumDir, path.join(resolvedRoot, ICL_LAYOUT.album), albumLegacy),
    qqInboxDir: pick('qqInboxDir', qqInboxDir, ICL_ENV.qqInboxDir, path.join(resolvedRoot, ICL_LAYOUT.qqInbox), qqLegacy),
    videoTmpDir: pick('videoTmpDir', videoTmpDir, ICL_ENV.videoTmpDir, path.join(resolvedRoot, ICL_LAYOUT.videoTmp)),
    // 表情包库跟着 media 走（旧默认是 <media>/stickers）。
    stickersDir: pick('stickersDir', stickersDir, ICL_ENV.stickersDir, path.join(resolvedMedia, 'stickers')),
    locksDir: pick('locksDir', locksDir, ICL_ENV.locksDir, path.join(resolvedRoot, ICL_LAYOUT.locks)),
    // 沙箱工作区默认就是"她的家"；lab 用 --workspace 覆盖，产品 preset 不启用。
    sandboxWorkspaceRoot: pick('sandboxWorkspaceRoot', sandboxWorkspaceRoot, ICL_ENV.sandboxWorkspaceRoot, resolvedHome),
  }
  paths.layout = ICL_LAYOUT
  paths.legacy = Object.freeze({ enabled: legacy === true, used: Object.freeze([...used]), candidates: Object.freeze(candidates) })
  return paths
}

/** 旧 dsh-icl stateDir 的候选（迁移/诊断用；不参与默认解析时也会列出来）。 */
export function legacyStateCandidates({ env = process.env, dshHomeDir } = {}) {
  const dsh = dshHomeDir ? path.resolve(String(dshHomeDir)) : dshHome(env)
  return [path.join(dsh, 'icl', 'state')]
}

/** 一眼看懂当前解析结果（日志/诊断用；不读磁盘）。 */
export function describePaths(paths) {
  const rows = ['root', 'homeDir', 'stateDir', 'mediaDir', 'albumDir', 'qqInboxDir', 'videoTmpDir', 'stickersDir', 'locksDir', 'sandboxWorkspaceRoot']
  return rows.map((key) => `${key}: ${paths[key]}`).join('\n')
}
