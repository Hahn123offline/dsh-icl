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

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(HERE, '..')
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '..', '..', '..')

const DEFAULT_STORYBOARD_CLI = 'C:\\Users\\ai_admin\\.dsh\\profiles\\desktop\\node_modules\\dsh-video-storyboard\\bin\\storyboard.mjs'

/** 旧插件家目录：只在"迁移凭证"时读一次，之后不再依赖。 */
function legacyHome(config) {
  return String(config.legacyBiliDir ?? process.env.BILI_DIR ?? path.join(os.homedir(), '.dsh', 'bili-duty'))
}

export function resolveConfig(ctx) {
  const config = ctx?.config && typeof ctx.config === 'object' ? ctx.config : {}
  const stateDir = String(config.stateDir ?? path.join(os.tmpdir(), 'icl-bili'))
  const biliDir = path.join(stateDir, 'bili')
  const legacy = legacyHome(config)
  return {
    config,
    stateDir,
    biliDir,
    legacyHome: legacy,
    legacyCredential: path.join(legacy, 'bili_credential.json'),
    credentialFile: String(config.credentialFile ?? path.join(biliDir, 'bili_credential.json')),
    pythonPath: String(config.pythonPath ?? process.env.BILI_PYTHON ?? path.join(legacy, '.venv', 'Scripts', 'python.exe')),
    runnerPath: String(config.runnerPath ?? process.env.BILI_RUNNER ?? path.join(REPO_ROOT, 'tools', 'bili-run.py')),
    vendorDir: String(config.vendorDir ?? path.join(PLUGIN_ROOT, 'vendor', 'bilibili-mcp')),
    storyboardCli: String(config.storyboardCli ?? process.env.STORYBOARD_CLI ?? DEFAULT_STORYBOARD_CLI),
    maxChars: Math.max(500, Number(config.maxChars) || 6000),
    timeoutMs: Math.max(5_000, Number(config.timeoutMs) || 90_000),
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
  return notes
}

/** 可操作的前置检查；返回 null = 可用，否则返回给模型看的错误串。 */
export function preflight(cfg, kind = 'tools') {
  const missing = []
  // 绝对路径必须真的存在；裸命令（python/ffmpeg 之类）交给 PATH。
  const pythonLooksBare = !path.isAbsolute(cfg.pythonPath)
  if (!pythonLooksBare && !exists(cfg.pythonPath)) {
    missing.push(`Python 解释器（${cfg.pythonPath}）→ 用 BILI_PYTHON 指向装了 bilibili-api-python 的 python`)
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

/** 调 tools/bili-run.py 里的只读函数。 */
export function makeCaller(cfg, { log = () => {} } = {}) {
  return function callTool(fn, args = {}, { timeoutMs = cfg.timeoutMs } = {}) {
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
}

export function failText(result) {
  return `B 站用不了（${result.code}）：${result.error}\n下一步：${result.next ?? NEXT_STEP[result.code] ?? NEXT_STEP.E_TOOL}`
}

export { NEXT_STEP }
