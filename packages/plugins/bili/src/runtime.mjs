// B 站接入的运行面：路径解析、只读桥调用、错误归一化。
//
// 约定（C 路线，2026-11-06 用户批准）：
//   · 代码/凭证/状态都归 ICL：vendor 在 packages/plugins/bili/vendor/，
//     凭证在 <stateDir>/bili/bili_credential.json；
//   · 只读：tools/bili-run.py 有一份独立白名单，写函数进不来；
//   · 错误统一成 {ok:false, code, error, next}，工具层再翻成模型能行动的话。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { dshHome, iclPaths } from '../../../core/src/icl-paths.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(HERE, '..')
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '..', '..', '..')

/** desktop profile 里的 storyboard CLI；从 DSH_HOME 推，不写死用户名/盘符。 */
function defaultStoryboardCli(env = process.env) {
  return path.join(dshHome(env), 'profiles', 'desktop', 'node_modules', 'dsh-video-storyboard', 'bin', 'storyboard.mjs')
}

const IS_WIN = process.platform === 'win32'

/** venv 里的 python 路径（Windows / POSIX 布局不同）。 */
export function venvPython(venvDir) {
  return IS_WIN ? path.join(venvDir, 'Scripts', 'python.exe') : path.join(venvDir, 'bin', 'python')
}

/** 旧插件家目录：只在"迁移凭证"与旧 venv 兼容回退时读一次。 */
function legacyHome(config) {
  return String(config.legacyBiliDir ?? process.env.BILI_DIR ?? path.join(os.homedir(), '.dsh', 'bili-duty'))
}

/** 默认的 storyboard 画质配置路径（`~/.dsh/video.json` 或 $DSH_HOME/video.json）。 */
export function defaultVideoConfigPath(env = process.env) {
  return path.join(dshHome(env), 'video.json')
}

export function resolveConfig(ctx) {
  const config = ctx?.config && typeof ctx.config === 'object' ? ctx.config : {}
  // 凭证/状态归 ICL：显式 stateDir > ICL_ROOT/state；不再落到系统 temp。
  const stateDir = String(config.stateDir ?? iclPaths().stateDir)
  const biliDir = path.join(stateDir, 'bili')
  const legacy = legacyHome(config)
  const ownVenv = path.join(biliDir, '.venv')
  const legacyVenv = path.join(legacy, '.venv')
  const ownPython = venvPython(ownVenv)
  const legacyPython = venvPython(legacyVenv)

  // 解释器优先级：显式 config/env > ICL 自己的 venv > 旧插件 venv（兼容回退）> ICL 路径（缺，preflight 报）
  const explicitPython = String(config.pythonPath ?? process.env.BILI_PYTHON ?? '')
  let pythonPath
  let pythonSource
  if (explicitPython) {
    pythonPath = explicitPython
    pythonSource = 'explicit'
  } else if (exists(ownPython)) {
    pythonPath = ownPython
    pythonSource = 'icl'
  } else if (exists(legacyPython)) {
    pythonPath = legacyPython
    pythonSource = 'legacy-compat'
  } else {
    pythonPath = ownPython
    pythonSource = 'missing'
  }

  return {
    config,
    stateDir,
    biliDir,
    legacyHome: legacy,
    legacyCredential: path.join(legacy, 'bili_credential.json'),
    credentialFile: String(config.credentialFile ?? path.join(biliDir, 'bili_credential.json')),
    pythonPath,
    pythonSource,
    ownVenvDir: ownVenv,
    ownPython,
    legacyVenvDir: legacyVenv,
    legacyPython,
    runnerPath: String(config.runnerPath ?? process.env.BILI_RUNNER ?? path.join(REPO_ROOT, 'tools', 'bili-run.py')),
    vendorDir: String(config.vendorDir ?? path.join(PLUGIN_ROOT, 'vendor', 'bilibili-mcp')),
    storyboardCli: String(config.storyboardCli ?? process.env.STORYBOARD_CLI ?? defaultStoryboardCli()),
    videoConfigPath: String(config.videoConfigPath ?? defaultVideoConfigPath()),
    videoCookies: String(config.videoCookies ?? process.env.DSH_VIDEO_COOKIES ?? ''),
    maxChars: Math.max(500, Number(config.maxChars) || 6000),
    timeoutMs: Math.max(5_000, Number(config.timeoutMs) || 90_000),
    // 限速/退避（只读接口；保守默认值，避免夜间连刷被风控）
    minIntervalMs: Math.max(0, Number(config.minIntervalMs ?? 1200)),
    maxRetries: Math.max(0, Math.min(5, Number(config.maxRetries ?? 2))),
    retryBaseMs: Math.max(200, Number(config.retryBaseMs ?? 1500)),
    retryMaxMs: Math.max(500, Number(config.retryMaxMs ?? 8000)),
    callTimeoutMs: Math.max(2_000, Number(config.callTimeoutMs ?? 45_000)),
    // 插件不直接发请求：走 ICL host 的统一 HTTP 出口（ctx.fetch）。
    fetchImpl: typeof config.fetchImpl === 'function'
      ? config.fetchImpl
      : (typeof ctx?.fetch === 'function' ? ctx.fetch : null),
  }
}

function exists(file) {
  try { return fs.statSync(file).isFile() } catch { return false }
}

function existsDir(dir) {
  try { return fs.statSync(dir).isDirectory() } catch { return false }
}

/**
 * 准备 ICL 自己的 B 站目录 + 一次性凭证迁移。
 * 只做文件级复制（不读内容、不打印内容）；旧文件是只读来源，不修改。
 */
export function ensureRuntime(cfg) {
  const notes = []
  try { fs.mkdirSync(cfg.biliDir, { recursive: true }) } catch (error) {
    notes.push(`状态目录建不了：${String(error?.message ?? error)}`)
  }
  if (!exists(cfg.credentialFile) && exists(cfg.legacyCredential)) {
    try {
      fs.copyFileSync(cfg.legacyCredential, cfg.credentialFile)
      notes.push('已把旧插件的 bili_credential.json 复制到 ICL 的 stateDir（一次性迁移，未读取内容）')
    } catch (error) {
      notes.push(`凭证迁移失败：${String(error?.message ?? error)}`)
    }
  }
  if (cfg.pythonSource === 'legacy-compat') {
    notes.push(`解释器仍用旧 venv（${cfg.pythonPath}）；迁移：node tools/bili-venv.mjs --create（见 docs/VIDEO-EYES.md §10）`)
  } else if (cfg.pythonSource === 'missing') {
    notes.push(`还没有 ICL 自己的 venv（${cfg.ownVenvDir}）；先跑 node tools/bili-venv.mjs --create`)
  }
  return notes
}

/** 可操作的前置检查；返回 null = 可用，否则返回给模型看的错误串。 */
export function preflight(cfg, kind = 'tools') {
  const missing = []
  // 绝对路径必须真的存在；裸命令（python/ffmpeg 之类）交给 PATH。
  const pythonLooksBare = !path.isAbsolute(cfg.pythonPath)
  if (!pythonLooksBare && !exists(cfg.pythonPath)) {
    missing.push(`Python 解释器（${cfg.pythonPath}）→ 先跑 node tools/bili-venv.mjs --create（建到 ICL stateDir），或用 BILI_PYTHON 指一个装了 bilibili-api-python 的 python`)
  }
  if (!exists(cfg.runnerPath)) missing.push(`只读桥（${cfg.runnerPath}）→ 用 BILI_RUNNER 指向 tools/bili-run.py`)
  if (!exists(path.join(cfg.vendorDir, 'mcp_server.py'))) {
    missing.push(`vendored MCP（${cfg.vendorDir}）→ 确认仓库完整，或用 BILI_VENDOR 指过去`)
  }
  if (kind === 'frames' && !exists(cfg.storyboardCli)) {
    missing.push(`storyboard CLI（${cfg.storyboardCli}）→ 安装 dsh-video-storyboard，或用 STORYBOARD_CLI 指 bin/storyboard.mjs`)
  }
  if (!missing.length) return null
  return `B 站接口用不了：缺 ${missing.join('；')}。这是本机接缝（不是视频/网络的问题）；补齐后重试。`
}

/** 把 Python 侧/网络侧的失败翻成稳定 code（测试直接调它）。 */
export function classifyFailure(text, { code = '' } = {}) {
  const raw = String(text ?? '')
  const low = raw.toLowerCase()
  if (code === 'E_AUTH' || code === 'E_RATE_LIMIT' || code === 'E_NETWORK' || code === 'E_TIMEOUT') {
    return { ok: false, code, error: raw }
  }
  if (raw.includes('未登录') || low.includes('credential') || low.includes('sessdata') || raw.includes('-101')) {
    return { ok: false, code: 'E_AUTH', error: 'B 站凭证缺失或已失效。' }
  }
  if (raw.includes('-412') || raw.includes('-509') || raw.includes('请求过于频繁') || raw.includes('风控')) {
    return { ok: false, code: 'E_RATE_LIMIT', error: '被 B 站限流/风控了。' }
  }
  if (low.includes('timeout') || low.includes('timed out')) {
    return { ok: false, code: 'E_TIMEOUT', error: 'B 站接口超时。' }
  }
  if (['aiohttp', 'connector', 'connection', 'ssl', 'getaddrinfo', 'network'].some((x) => low.includes(x))) {
    return { ok: false, code: 'E_NETWORK', error: '网络到 B 站不通。' }
  }
  return { ok: false, code: 'E_TOOL', error: raw || 'B 站接口调用失败（没有错误原文）。' }
}

const NEXT_STEP = {
  E_AUTH: '用 bili_login_start 扫码续期（凭证会写到 ICL 自己的 stateDir）；续期前 search/热门仍可用，watch/comments 不可用。',
  E_RATE_LIMIT: '等 30–60 秒再试；不要连续重试同一调用，也不要一轮里连着刷几十条。',
  E_TIMEOUT: '稍后重试一次；连续失败就先停下，别把整轮预算烧在重试上。',
  E_NETWORK: '检查网络/代理；恢复后重试一次。',
  E_TOOL: '把这条错误原文和调用参数一起报给维护者。',
  E_EMPTY: 'B 站返回了空结果；换一个关键词/BV 或稍后再试。',
}

const RETRYABLE = new Set(['E_RATE_LIMIT', 'E_TIMEOUT', 'E_NETWORK'])

/**
 * 调 tools/bili-run.py 里的只读函数。
 *
 * 只读接口也要有礼貌：所有调用串行、每次至少间隔 `minIntervalMs`，
 * 风控/超时/网络失败按指数退避重试（默认 2 次，1.5s → 3s），
 * 但**永不重试** E_AUTH / E_PREFLIGHT / E_READ_ONLY / E_NOT_ALLOWED 这类"重试也没用"的错。
 *
 * @param {object} cfg resolveConfig() 的结果
 * @param {{log?:Function, sleep?:(ms:number)=>Promise<void>, now?:()=>number}} [hooks] 测试注入
 */
export function makeCaller(cfg, { log = () => {}, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = () => Date.now() } = {}) {
  const minIntervalMs = Math.max(0, Number(cfg.minIntervalMs) || 0)
  const maxRetries = Math.max(0, Math.min(5, Number(cfg.maxRetries) || 0))
  const retryBaseMs = Math.max(100, Number(cfg.retryBaseMs) || 1500)
  const retryMaxMs = Math.max(retryBaseMs, Number(cfg.retryMaxMs) || 8000)
  const callTimeoutMs = Math.max(1_000, Number(cfg.callTimeoutMs) || 45_000)

  let chain = Promise.resolve()
  let lastStartedAt = 0

  async function throttle() {
    if (minIntervalMs <= 0) return
    const waitMs = lastStartedAt === 0 ? 0 : Math.max(0, lastStartedAt + minIntervalMs - now())
    if (waitMs > 0) await sleep(waitMs)
    lastStartedAt = now()
  }

  function executeOnce(fn, args, timeoutMs) {
    const blocked = preflight(cfg, 'tools')
    if (blocked) return Promise.resolve({ ok: false, code: 'E_PREFLIGHT', error: blocked, next: '补齐缺失项后重试。' })
    const env = {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      BILI_CREDENTIAL: cfg.credentialFile,
      BILI_VENDOR: cfg.vendorDir,
      BILI_HOME: cfg.biliDir,
    }
    return new Promise((resolve) => {
      execFile(cfg.pythonPath, [cfg.runnerPath, fn, JSON.stringify(args)], {
        timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env, windowsHide: true,
      }, (error, stdout, stderr) => {
        const out = String(stdout ?? '').trim()
        let parsed = null
        try { parsed = JSON.parse(out) } catch { /* 非 JSON 输出（例如空） */ }
        if (parsed && parsed.ok === false) {
          const code = String(parsed.code ?? 'E_TOOL')
          resolve({ ok: false, code, error: String(parsed.error ?? 'B 站接口调用失败'), next: parsed.next ?? NEXT_STEP[code] ?? NEXT_STEP.E_TOOL })
          return
        }
        if (error) {
          const failed = classifyFailure(`${out}\n${String(stderr ?? '')}\n${error?.message ?? ''}`)
          resolve({ ...failed, next: NEXT_STEP[failed.code] ?? NEXT_STEP.E_TOOL })
          return
        }
        if (parsed === null) {
          if (!out) {
            resolve({ ok: false, code: 'E_EMPTY', error: 'B 站返回空结果。', next: NEXT_STEP.E_EMPTY })
            return
          }
          resolve({ ok: true, data: out })
          return
        }
        if (parsed && parsed.ok === true && parsed.result !== undefined) {
          resolve({ ok: true, data: parsed.result })
          return
        }
        resolve({ ok: true, data: parsed })
      })
    })
  }

  async function attemptLoop(fn, args, timeoutMs) {
    for (let attempt = 0; ; attempt += 1) {
      await throttle()
      const result = await executeOnce(fn, args, timeoutMs)
      if (result.ok || !RETRYABLE.has(result.code) || attempt >= maxRetries) return result
      // 抖动 0.8–1.2：多来源/多会话撞车时不要把重试排成整齐的拍子。
      const base = Math.min(retryMaxMs, retryBaseMs * 2 ** attempt)
      const waitMs = Math.max(100, Math.round(base * (0.8 + Math.random() * 0.4)))
      log({ msg: 'bili.retry', fn, code: result.code, attempt: attempt + 1, waitMs })
      await sleep(waitMs)
    }
  }

  return function callTool(fn, args = {}, { timeoutMs = callTimeoutMs } = {}) {
    // 串行化：同一个插件实例的调用一条链，保证最小间隔对"每 host"成立。
    const run = () => attemptLoop(fn, args, timeoutMs)
    const next = chain.then(run, run)
    chain = next.then(() => {}, () => {})
    return next
  }
}

export function failText(result) {
  return `B 站用不了（${result.code}）：${result.error}\n下一步：${result.next ?? NEXT_STEP[result.code] ?? NEXT_STEP.E_TOOL}`
}

const AUTH_COOKIE_NAMES = new Set(['SESSDATA', 'bili_jct', 'buvid3', 'DedeUserID'])
const RUNBOOK = 'docs/VIDEO-EYES.md §11「storyboard cookies 续期」'

/**
 * storyboard（yt-dlp）的登录态：只读 `video.json` 与 cookies 文件的**到期列**，
 * 绝不打印任何 cookie 值。返回状态给 `bili_frames` 做"别再悄悄变糊"的显式提示。
 *
 * @returns {{status:'ok'|'missing'|'unconfigured', cookiesPath:string,
 *   expiresAt:number|null, daysLeft:number|null, warning:string|null}}
 */
export function readStoryboardAuth({ env = process.env, videoConfigPath = null, videoCookies = '', now = Date.now() } = {}) {
  const configPath = String(videoConfigPath || defaultVideoConfigPath(env))
  let fromFile = ''
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    fromFile = typeof parsed?.cookies === 'string' ? parsed.cookies : ''
  } catch { /* 没有 video.json 是常态 */ }
  const cookiesPath = String(videoCookies || env.DSH_VIDEO_COOKIES || fromFile || '')

  if (!cookiesPath) {
    return {
      status: 'unconfigured', cookiesPath, expiresAt: null, daysLeft: null,
      warning: `⚠️ 画面来源：storyboard 没有配置 cookies（匿名最高 480P，图可能糊）。续期方法见 ${RUNBOOK}。`,
    }
  }
  if (!exists(cookiesPath)) {
    return {
      status: 'missing', cookiesPath, expiresAt: null, daysLeft: null,
      warning: `⚠️ cookies 文件不存在（${cookiesPath}）：本次只能匿名拉流（≤480P，图可能糊）。按 ${RUNBOOK} 重新导出。`,
    }
  }

  let minExpiry = null
  try {
    for (const line of fs.readFileSync(cookiesPath, 'utf8').split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue
      const cols = line.split('\t')
      if (cols.length < 7) continue
      const name = cols[5]
      const expiry = Number(cols[4])
      if (!AUTH_COOKIE_NAMES.has(name) || !Number.isFinite(expiry) || expiry <= 0) continue
      minExpiry = minExpiry == null ? expiry : Math.min(minExpiry, expiry)
    }
  } catch { /* 读不了就按"未知"处理，不给假警告 */ }

  const expiresAt = minExpiry == null ? null : minExpiry * 1000
  const daysLeft = expiresAt == null ? null : Math.floor((expiresAt - now) / 86_400_000)
  let warning = null
  if (expiresAt != null && expiresAt <= now) {
    warning = `⚠️ storyboard cookies 已过期（${new Date(expiresAt).toISOString().slice(0, 10)}）：本次按匿名拉流（≤480P，图可能糊）。续期见 ${RUNBOOK}。`
  } else if (daysLeft != null && daysLeft <= 7) {
    warning = `⚠️ storyboard cookies ${daysLeft} 天后到期（${new Date(expiresAt).toISOString().slice(0, 10)}）：到期后切帧会降到匿名 480P、无报错。提前按 ${RUNBOOK} 续期。`
  }
  return { status: 'ok', cookiesPath, expiresAt, daysLeft, warning }
}

export { NEXT_STEP }
