// 评测宿主：在临时 stateDir 里装配真实的产品插件（memory/recall/note/lexicon/dream/eager-recall/whois）。
//
// 只做装配与生命周期，不写任何指标逻辑：
//   · 绝不指向 live state：root 由调用方用 os.tmpdir() 建；
//   · dream-chat 插槽绑到模型适配器（echo/cloud/local 同一接口）；
//   · raw 源把 fixture 行喂给 wash（主材料已按 profile 过滤），search 用全部行做原文兜底。
import fs from 'node:fs'
import path from 'node:path'
import { createHost } from '../../packages/core/src/index.mjs'
import * as memory from '../../packages/plugins/memory/src/index.mjs'
import * as recall from '../../packages/plugins/recall/src/index.mjs'
import * as note from '../../packages/plugins/note/src/index.mjs'
import * as lexicon from '../../packages/plugins/lexicon/src/index.mjs'
import * as dream from '../../packages/plugins/dream/src/index.mjs'
import * as eagerRecall from '../../packages/plugins/eager-recall/src/index.mjs'
import * as whois from '../../packages/plugins/whois/src/index.mjs'
import memoryManifest from '../../packages/plugins/memory/manifest.json' with { type: 'json' }
import recallManifest from '../../packages/plugins/recall/manifest.json' with { type: 'json' }
import noteManifest from '../../packages/plugins/note/manifest.json' with { type: 'json' }
import lexiconManifest from '../../packages/plugins/lexicon/manifest.json' with { type: 'json' }
import dreamManifest from '../../packages/plugins/dream/manifest.json' with { type: 'json' }
import eagerRecallManifest from '../../packages/plugins/eager-recall/manifest.json' with { type: 'json' }
import whoisManifest from '../../packages/plugins/whois/manifest.json' with { type: 'json' }
import { REPO_ROOT } from './fixture.mjs'

export const FORMED_PLUGIN_ORDER = Object.freeze(['memory', 'recall', 'note', 'lexicon', 'dream', 'eager-recall', 'whois'])
export const FORMATION_JOBS = Object.freeze(['wash', 'events', 'people', 'lexicon', 'consume', 'cleanup', 'index'])

function readDreamPersona() {
  try {
    const text = fs.readFileSync(path.join(REPO_ROOT, 'prompts', 'dream.md'), 'utf8')
    return String(text).trim()
  } catch {
    return '你是她夜里的记忆沉淀器。'
  }
}

/**
 * 建评测宿主。
 * @param {object} options
 * @param {string} options.root 临时 stateDir（memory.db 落在这里）
 * @param {object} options.model createModelAdapter() 的返回值
 * @param {string} [options.timezone]
 * @param {string} [options.sessionId]
 * @param {Array} options.mainRows 进 wash 主材料的 raw 行
 * @param {Array} [options.contextRows] 只作原文兜底的 raw 行
 * @param {Array} [options.logs] 收集产品日志的数组
 */
export async function createEvalHost(options) {
  const root = path.resolve(String(options.root ?? ''))
  if (!root) throw new Error('createEvalHost 需要 root')
  fs.mkdirSync(root, { recursive: true })
  const logs = options.logs ?? []
  const host = createHost({ log: (entry) => { if (logs.length < 2000) logs.push(entry) } })
  const timezone = String(options.timezone ?? 'Asia/Hong_Kong')
  const sessionId = String(options.sessionId ?? 'memory-eval')
  // 身份链配置：产品据此把"主人/别名"归一到 ownerQQ，把 selfQQ 归到她自己。
  const identity = options.identity ?? {}
  const formationProfile = ['raw-all', 'raw-human', 'raw-main'].includes(String(options.formationProfile))
    ? String(options.formationProfile)
    : 'raw-main'
  const registrations = [
    [memoryManifest, memory, { config: { root } }],
    [recallManifest, recall, { config: { sessionId } }],
    [noteManifest, note, {}],
    [lexiconManifest, lexicon, {}],
    [dreamManifest, dream, {
      config: {
        sessionId,
        timezone,
        persona: readDreamPersona(),
        scheduleEnabled: false,
        formationProfile,
        selfQQ: String(identity.selfQQ ?? ''),
        ownerQQ: String(identity.ownerQQ ?? ''),
        ownerNames: Array.isArray(identity.ownerNames) ? identity.ownerNames : [],
        selfNames: Array.isArray(identity.selfNames) ? identity.selfNames : [],
      },
    }],
    [eagerRecallManifest, eagerRecall, { config: {} }],
    [whoisManifest, whois, {}],
  ]
  for (const [manifest, module, config] of registrations) host.registerPlugin(manifest, module, config)
  for (const id of FORMED_PLUGIN_ORDER) await host.enable(id)

  // 模型插槽：所有 LLM 调用走同一个可缓存适配器。
  host.services.slots.bind('dream-chat', {
    provider: String(options.model?.describe?.().provider ?? 'eval'),
    call: (request = {}) => options.model.call({ messages: request.messages ?? [], maxTokens: request.maxTokens ?? null, where: 'dream' }),
  })

  // 嵌入插槽（--embed 时才有）：memory.search 走向量+字面混合；不绑定时插件自动退化为二元组。
  if (options.embedAdapter) {
    host.services.slots.bind('embed-text', {
      provider: String(options.embedAdapter.describe?.().provider ?? 'eval-embed'),
      call: async (request = {}) => options.embedAdapter.embed(String(request.input ?? '')),
    })
  }

  // raw 源：id 稳定；主材料行 + 仅兜底行都保留，list 只回主材料（profile 过滤在这里生效）。
  const listedRows = Array.isArray(options.mainRows) ? options.mainRows : []
  const searchRows = [...listedRows, ...(Array.isArray(options.contextRows) ? options.contextRows : [])]
  host.services.raw.register({
    id: 'fixture',
    list: ({ since = null, until = null, limit = 2000 } = {}) => {
      const from = since == null ? -Infinity : Number(since)
      const to = until == null ? Infinity : Number(until)
      return listedRows
        .filter((row) => Number(row.time) >= from && Number(row.time) < to)
        .slice(0, Math.max(1, Number(limit) || 2000))
    },
    search: ({ query = '', limit = 2 } = {}) => {
      const needle = String(query ?? '').toLowerCase().replace(/\s+/g, '')
      if (!needle) return []
      const scored = []
      for (const row of searchRows) {
        const hay = String(row.text ?? '').toLowerCase().replace(/\s+/g, '')
        if (!hay) continue
        if (hay.includes(needle)) { scored.push({ row, score: 1 }); continue }
        const grams = new Set()
        for (let i = 0; i < needle.length - 1; i += 1) grams.add(needle.slice(i, i + 2))
        let hit = 0
        for (const gram of grams) if (hay.includes(gram)) hit += 1
        const score = grams.size ? hit / grams.size : 0
        if (score >= 0.3) scored.push({ row, score })
      }
      scored.sort((a, b) => b.score - a.score)
      return scored.slice(0, Math.max(1, Number(limit) || 2)).map(({ row }) => ({
        text: String(row.text ?? '').slice(0, 240),
        time: row.time,
        id: row.id,
      }))
    },
  })

  const tools = Object.fromEntries(host.services.tools.list().map((tool) => [tool.name, tool]))
  const shared = {
    memory: host.shared.get('memory'),
    recall: host.shared.get('recall'),
    dream: host.shared.get('dream'),
    lexicon: host.shared.get('lexicon'),
    note: host.shared.get('note'),
  }
  const hostLog = {
    entries: logs,
    warnings: () => logs.filter((entry) => entry?.level === 'warn' || entry?.level === 'error'),
    count: () => logs.length,
  }

  return {
    host,
    root,
    timezone,
    tools,
    shared,
    hostLog,
    mainRowCount: listedRows.length,
    contextRowCount: Math.max(0, searchRows.length - listedRows.length),
    async dispose() {
      for (const id of [...FORMED_PLUGIN_ORDER].reverse()) {
        try { host.disable(id) } catch { /* 注销失败不阻塞清理 */ }
      }
    },
  }
}
