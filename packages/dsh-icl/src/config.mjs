// 配置规范化：DSH preset 的 config 只写"和默认不同的部分"。
import fs from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, defaultStateDir, dshHome, resolvePath } from './paths.mjs'

/** 默认启用的插件。dsh-raw 默认关：DSH 桥直接喂实时 session 事件，文件扫描是旧路。
 *  compaction 默认关（2026-11-05 决策）：它只注入摘要、不替换历史（纯加法），且 DSH 自带
 *  checkpoint/压缩；留着会与 dream 的原文输入冲突。要实验时在 preset 里显式列出。 */
export const DEFAULT_PLUGINS = Object.freeze([
  'memory', 'world-state', 'recall', 'note', 'lexicon', 'whois', 'persona', 'focus',
  'eager-recall', 'model-manager', 'time', 'dream', 'editor', 'bili', 'mc-link',
])

function readText(file, fallback = '') {
  try { return fs.readFileSync(file, 'utf8') } catch { return fallback }
}

function readProviders(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(parsed?.providers) ? parsed.providers : []
  } catch { return [] }
}

export function normalizeConfig(input = {}) {
  const stateDir = resolvePath(input.stateDir, defaultStateDir())
  // 提示词分三层（用户 2026-11-05 批准的契约，见 docs/PROMPT-CONTRACT.md）：
  //   人格 prompts/persona.md —— 她是谁、怎么说话（全局常量，不出现工具名）
  //   仿真 prompts/sim.md     —— 她在这个环境里怎么生活、这些工具如何配合（全局，几乎不变）
  //   工具教学                —— 每个工具自己的 description + 按需 skills（不进全局提示词）
  const personaFile = resolvePath(input.personaFile, path.join(REPO_ROOT, 'prompts', 'persona.md'))
  const simulationFile = resolvePath(input.simulationFile, path.join(REPO_ROOT, 'prompts', 'sim.md'))
  const dreamPersonaFile = resolvePath(input.dreamPersonaFile, path.join(REPO_ROOT, 'prompts', 'dream.md'))
  const providersFile = resolvePath(input.providersFile, path.join(REPO_ROOT, 'config', 'icl.local.json'))
  const providers = Array.isArray(input.providers) ? input.providers : readProviders(providersFile)
  return {
    stateDir,
    personaFile,
    simulationFile,
    dreamPersonaFile,
    providersFile,
    providers,
    presetId: input.presetId == null ? null : String(input.presetId),
    sessionId: input.sessionId == null ? null : String(input.sessionId),
    mcBaseUrl: input.mcBaseUrl == null ? null : String(input.mcBaseUrl),
    plugins: Array.isArray(input.plugins) ? input.plugins.map(String) : [...DEFAULT_PLUGINS],
    /** 按插件 id 覆盖 configFor 的默认值（部署相关，不写进代码）。 */
    pluginConfig: input.pluginConfig && typeof input.pluginConfig === 'object' ? { ...input.pluginConfig } : {},
    tickMs: Math.max(0, Number(input.tickMs ?? 500)),
    timeTickMs: Math.max(1000, Number(input.timeTickMs ?? 15_000)),
    dreamAt: String(input.dreamAt ?? '23:00'),
    compactionTriggerChars: Math.max(1000, Number(input.compactionTriggerChars ?? 12_000)),
    persona: readText(personaFile, ''),
    simulation: readText(simulationFile, ''),
    dreamPersona: readText(dreamPersonaFile, ''),
    rawFile: resolvePath(input.rawFile, path.join(stateDir, 'session-events.jsonl')),
    focusFile: resolvePath(input.focusFile, path.join(stateDir, 'focus.json')),
    sessionsRoot: resolvePath(input.sessionsRoot, path.join(dshHome(), 'sessions')),
  }
}
