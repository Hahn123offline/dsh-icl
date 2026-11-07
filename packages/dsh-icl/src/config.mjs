// 配置规范化：DSH preset 的 config 只写"和默认不同的部分"。
import fs from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, dshHome, iclPaths, resolveDataPath, resolvePath } from './paths.mjs'

/** 默认启用的插件。dsh-raw 默认关：DSH 桥直接喂实时 session 事件，文件扫描是旧路。
 *  compaction 默认关（2026-11-05 决策）：它只注入摘要、不替换历史（纯加法），且 DSH 自带
 *  checkpoint/压缩；留着会与 dream 的原文输入冲突。要实验时在 preset 里显式列出。 */
export const DEFAULT_PLUGINS = Object.freeze([
  'memory', 'world-state', 'recall', 'note', 'lexicon', 'whois', 'persona', 'focus',
  'eager-recall', 'model-manager', 'time', 'dream', 'editor', 'bili', 'video', 'mc-link', 'album', 'qq',
])

function readText(file, fallback = '') {
  try { return fs.readFileSync(file, 'utf8') } catch { return fallback }
}

/**
 * 工具白名单匹配（MC 场景收敛工具面用）：
 *   · 精确名：`mcb_status` / `time_status`
 *   · 前缀通配：`mcb_*`（只允许末尾一个 `*`）
 *   · 空/null = 不过滤（默认全量）
 * 只影响 bridge 向 DSH 注册哪些 ICL 工具；DSH 原生工具（tool-todo 等）不在此列。
 */
export function matchToolAllowlist(name, allowlist = []) {
  const tool = String(name ?? '')
  if (!Array.isArray(allowlist) || allowlist.length === 0) return true
  for (const raw of allowlist) {
    const pattern = String(raw ?? '').trim()
    if (!pattern) continue
    if (pattern === '*') return true
    if (pattern.endsWith('*')) {
      if (tool.startsWith(pattern.slice(0, -1))) return true
    } else if (tool === pattern) return true
  }
  return false
}

function readProviders(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(parsed?.providers) ? parsed.providers : []
  } catch { return [] }
}

/**
 * @param {object} [input] preset/headless 传来的 config
 * @param {{env?:NodeJS.ProcessEnv}} [options] env 可注入（测试用）
 */
export function normalizeConfig(input = {}, { env = process.env, dshHomeDir } = {}) {
  const raw = input && typeof input === 'object' ? input : {}
  // 一个根推全部可写目录：显式 config > env > 默认（<REPO_ROOT>/.state）。
  // 旧目录（$DSH_HOME/icl/state、旧 QQ 入站目录、旧相册根）在新目录缺席时继续可读。
  const paths = iclPaths({
    env,
    dshHomeDir,
    root: raw.iclRoot,
    stateDir: raw.stateDir,
    homeDir: raw.homeDir,
    mediaDir: raw.mediaDir,
    albumDir: raw.albumDir,
    qqInboxDir: raw.qqInboxDir,
    videoTmpDir: raw.videoTmpDir,
    stickersDir: raw.stickersDir,
    locksDir: raw.locksDir,
    sandboxWorkspaceRoot: raw.sandboxWorkspaceRoot,
  })
  const stateDir = paths.stateDir
  // 提示词分三层（用户 2026-11-05 批准的契约，见 docs/PROMPT-CONTRACT.md）：
  //   人格 prompts/persona.md —— 她是谁、怎么说话（全局常量，不出现工具名）
  //   仿真 prompts/sim.md     —— 她在这个环境里怎么生活、这些工具如何配合（全局，几乎不变）
  //   工具教学                —— 每个工具自己的 description + 按需 skills（不进全局提示词）
  const personaFile = resolvePath(raw.personaFile, path.join(REPO_ROOT, 'prompts', 'persona.md'))
  const simulationFile = resolvePath(raw.simulationFile, path.join(REPO_ROOT, 'prompts', 'sim.md'))
  // 只在特定 preset 加载的仿真补充（如 MC）：避免产品提示词里出现当前工具面不存在的
  // mcb_* 操作手册。base sim 永远是 sim.md，extra 追加在它后面。
  const simulationExtraFiles = (Array.isArray(raw.simulationExtraFiles) ? raw.simulationExtraFiles : [])
    .map((file) => resolvePath(file, path.join(REPO_ROOT, 'prompts', 'sim.md')))
  const dreamPersonaFile = resolvePath(raw.dreamPersonaFile, path.join(REPO_ROOT, 'prompts', 'dream.md'))
  const providersFile = resolvePath(raw.providersFile, path.join(REPO_ROOT, 'config', 'icl.local.json'))
  const providers = Array.isArray(raw.providers) ? raw.providers : readProviders(providersFile)
  return {
    // 根与派生目录：插件默认值只从这里取，不再各自拼 cwd/.state。
    iclRoot: paths.root,
    paths,
    homeDir: paths.homeDir,
    stateDir,
    mediaDir: paths.mediaDir,
    albumDir: paths.albumDir,
    qqInboxDir: paths.qqInboxDir,
    videoTmpDir: paths.videoTmpDir,
    stickersDir: paths.stickersDir,
    locksDir: paths.locksDir,
    sandboxWorkspaceRoot: paths.sandboxWorkspaceRoot,
    personaFile,
    simulationFile,
    simulationExtraFiles,
    dreamPersonaFile,
    providersFile,
    providers,
    presetId: raw.presetId == null ? null : String(raw.presetId),
    sessionId: raw.sessionId == null ? null : String(raw.sessionId),
    mcBaseUrl: raw.mcBaseUrl == null ? null : String(raw.mcBaseUrl),
    plugins: Array.isArray(raw.plugins) ? raw.plugins.map(String) : [...DEFAULT_PLUGINS],
    /**
     * MC 场景工具白名单（P1 复杂度收敛，用户/lead 批准）：只注册名单内的 ICL 工具。
     * 支持精确名与 `mcb_*` 前缀；空数组 = 全量（产品默认，不改产品）。
     * 只影响 DSH 注册面，不改变 host.surface/插件本身。
     */
    toolAllowlist: Array.isArray(raw.toolAllowlist) ? raw.toolAllowlist.map(String) : [],
    /**
     * 哪些插件投递的消息会触发 facts 快照 dirty（默认 time/focus：时间/focus 变化必须下一步可见）。
     * MC 环境事实按 CACHE-MODEL §7.7 豁免（允许整轮陈旧，以 mcb_status 为准）；
     * E2 实测每轮 2.5 条 runtime-context/91k 字符主要来自把每条 MC 事件都当 dirty——收窄后应回到 ≤1 条/轮。
     */
    factsDirtyPlugins: Array.isArray(raw.factsDirtyPlugins) ? raw.factsDirtyPlugins.map(String) : ['time', 'focus'],
    /**
     * renderTail（C，lab-only）：给 ICL 工具结果尾部追加一行状态；产品默认 {}（bridge 内 enabled:false）。
     * 只影响 tool/result 文本 append，不新增 system/facts/tools schema（cache 安全）。
     */
    renderTail: raw.renderTail && typeof raw.renderTail === 'object' ? { ...raw.renderTail } : {},
    /** 按插件 id 覆盖 configFor 的默认值（部署相关，不写进代码）。 */
    pluginConfig: raw.pluginConfig && typeof raw.pluginConfig === 'object' ? { ...raw.pluginConfig } : {},
    tickMs: Math.max(0, Number(raw.tickMs ?? 500)),
    timeTickMs: Math.max(1000, Number(raw.timeTickMs ?? 15_000)),
    dreamAt: String(raw.dreamAt ?? '23:00'),
    compactionTriggerChars: Math.max(1000, Number(raw.compactionTriggerChars ?? 12_000)),
    persona: readText(personaFile, ''),
    simulation: [readText(simulationFile, ''), ...simulationExtraFiles.map((file) => readText(file, ''))]
      .filter(Boolean).join('\n\n'),
    dreamPersona: readText(dreamPersonaFile, ''),
    /**
     * 第一屏净化（红队 P0-1）：用同名空段 shadow 掉 DSH 全局的工程脚手架段。
     * 默认空数组 = 不净化；只有显式配置的 preset（目前仅 lab）才开。
     * 段名目录与语义见 src/purify.mjs；产品 preset 要开需用户批准。
     */
    purifySections: Array.isArray(raw.purifySections) ? raw.purifySections.map(String) : [],
    rawFile: resolveDataPath(raw.rawFile, path.join(stateDir, 'session-events.jsonl'), { root: paths.root }),
    focusFile: resolveDataPath(raw.focusFile, path.join(stateDir, 'focus.json'), { root: paths.root }),
    // DSH 自己的会话目录不归 ICL 管，仍从 DSH_HOME 推；相对值也锚到 DSH_HOME。
    sessionsRoot: resolveDataPath(raw.sessionsRoot, path.join(dshHome(env), 'sessions'), { root: dshHome(env) }),
  }
}
