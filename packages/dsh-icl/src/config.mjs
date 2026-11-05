// 配置规范化：DSH preset 的 config 只写"和默认不同的部分"。
import fs from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, defaultStateDir, dshHome, resolvePath } from './paths.mjs'

/** 默认启用的插件。dsh-raw 默认关：DSH 桥直接喂实时 session 事件，文件扫描是旧路。 */
export const DEFAULT_PLUGINS = Object.freeze([
  'memory', 'world-state', 'recall', 'note', 'lexicon', 'whois', 'persona', 'focus',
  'eager-recall', 'model-manager', 'time', 'dream', 'compaction', 'editor', 'bili', 'mc-link',
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
  const personaFile = resolvePath(input.personaFile, path.join(REPO_ROOT, 'prompts', 'live.md'))
  const dreamPersonaFile = resolvePath(input.dreamPersonaFile, path.join(REPO_ROOT, 'prompts', 'dream.md'))
  const providersFile = resolvePath(input.providersFile, path.join(REPO_ROOT, 'config', 'icl.local.json'))
  const providers = Array.isArray(input.providers) ? input.providers : readProviders(providersFile)
  return {
    stateDir,
    personaFile,
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
    dreamPersona: readText(dreamPersonaFile, ''),
    rawFile: resolvePath(input.rawFile, path.join(stateDir, 'session-events.jsonl')),
    focusFile: resolvePath(input.focusFile, path.join(stateDir, 'focus.json')),
    sessionsRoot: resolvePath(input.sessionsRoot, path.join(dshHome(), 'sessions')),
  }
}
