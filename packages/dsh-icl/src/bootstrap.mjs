// 插件装配：仓库内唯一的 loader。
//
// 旧接线（仓库外的 icl-live 插件）手写 11 个插件，漏了 5 个，也没有失败台账。
// 这里从 packages/plugins/<id>/ 读 manifest + src，逐个启用；单个失败只记账，不拖垮其余。
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { REPO_ROOT } from './paths.mjs'

/** 每个插件的配置；只写和插件默认不同的部分。
 *  可写目录一律来自 cfg.paths（ICL_ROOT 解析结果），插件自己的默认值只在独立运行时兜底。 */
export function configFor(id, cfg) {
  switch (id) {
    case 'memory': return { root: cfg.stateDir }
    case 'recall': return { sessionId: cfg.sessionId ?? 'live' }
    case 'dsh-raw': return { sessionsRoot: cfg.sessionsRoot }
    case 'editor': return { root: cfg.stateDir }
    case 'persona': return { card: cfg.persona }
    case 'time': return { stateFile: path.join(cfg.stateDir, 'time.json'), tickMs: cfg.timeTickMs }
    case 'rhythm': return { stateFile: path.join(cfg.stateDir, 'rhythm.json'), dreamAt: cfg.dreamAt }
    case 'dream': return { sessionId: cfg.sessionId ?? 'live', persona: cfg.dreamPersona, dreamAt: cfg.dreamAt }
    case 'compaction': return { persona: cfg.persona, keepRecent: 16, triggerChars: cfg.compactionTriggerChars }
    case 'loop-probe': return { inboxFile: path.join(cfg.stateDir, 'loop.inbox.jsonl'), outboxFile: path.join(cfg.stateDir, 'loop.outbox.jsonl') }
    case 'mc-link': return { baseUrl: cfg.mcBaseUrl, logFile: path.join(cfg.stateDir, 'mc-link.jsonl') }
    case 'album': return { root: cfg.albumDir ?? path.join(cfg.stateDir, 'media') }
    // 用户批准（2026-11-06）：eager-recall 的 hits/injected/chars 计数落盘，供 E2 质量快照读取。
    case 'eager-recall': return { counterFile: path.join(cfg.stateDir, 'eager-recall.jsonl') }
    case 'qq': {
      const qqDir = path.join(cfg.stateDir, 'qq')
      return {
        mediaInboxDir: cfg.qqInboxDir,
        stickerDir: cfg.stickersDir,
        ledgerFile: path.join(qqDir, 'ledger.db'),
        recordFile: path.join(qqDir, 'record.jsonl'),
        statusFile: path.join(qqDir, 'status.json'),
        auditFile: path.join(qqDir, 'audit.jsonl'),
        dedupeFile: path.join(qqDir, 'dedupe.json'),
      }
    }
    case 'bili': return { stateDir: cfg.stateDir }
    case 'video': return { stateDir: cfg.videoTmpDir ?? cfg.stateDir }
    case 'model-manager': return { providers: cfg.providers ?? [] }
    default: return {}
  }
}

/** 读取一个插件的 manifest 与模块；不存在时抛清晰的错。 */
export async function loadPlugin(id, { root = REPO_ROOT } = {}) {
  const dir = path.join(root, 'packages', 'plugins', id)
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  const mod = await import(pathToFileURL(path.join(dir, 'src', 'index.mjs')).href)
  if (typeof mod.apply !== 'function') throw new Error(`${id} 缺少 apply(ctx)`)
  return { manifest, module: mod }
}

/**
 * 注册并启用配置里列出的插件。
 * @returns {{enabled:string[], failed:{id:string,error:string}[], skipped:string[]}}
 */
export async function bootstrapHost(host, cfg, { log = () => {}, root = REPO_ROOT, loadPlugin: loader = loadPlugin } = {}) {
  fs.mkdirSync(cfg.stateDir, { recursive: true })
  // 仿真纪律段：全局、几乎不变，排在人格段之后（order 25）。
  // 它不属于任何一个能力域，所以不挂在插件里；工具的具体用法仍归各工具 description。
  if (cfg.simulation) {
    try {
      host.services?.prompt?.section?.({ name: 'icl:simulation', order: 25, text: () => cfg.simulation })
    } catch (error) {
      log({ msg: 'icl.simulation-fail', error: String(error?.message ?? error) })
    }
  }
  const enabled = []
  const failed = []
  const skipped = []
  for (const id of cfg.plugins ?? []) {
    try {
      const { manifest, module } = await loader(id, { root })
      const overrides = cfg.pluginConfig?.[id]
      host.registerPlugin(manifest, module, {
        config: overrides && typeof overrides === 'object'
          ? { ...configFor(id, cfg), ...overrides }
          : configFor(id, cfg),
      })
      await host.enable(id)
      enabled.push(id)
    } catch (error) {
      failed.push({ id, error: String(error?.message ?? error) })
      log({ msg: 'icl.plugin-fail', id, error: String(error?.message ?? error) })
    }
  }
  log({ msg: 'icl.bootstrap', enabled, failed: failed.map((x) => x.id), skipped })
  return { enabled, failed, skipped }
}
